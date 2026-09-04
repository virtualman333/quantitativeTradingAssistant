/**
 * chat.ts —— 对话引擎（模型 ↔ 工具 的 ReAct 循环）
 *
 * 设计要点：
 *   1. 流式：文本增量即时推给界面，不等待整段生成完
 *   2. 工具循环：模型要调工具就执行，把结果塞回消息再问，最多 maxRounds 轮
 *   3. 危险工具：执行前通过 confirm 回调向用户要确认，拒绝则把「用户取消」当作工具结果回喂
 *   4. 可中止：signal 触发后立即停止，不再继续调模型或工具
 *   5. 不抛异常：所有错误都以事件形式回传，界面永远拿得到反馈
 */
import { resolveModel, type ModelConfig } from "./store.js";
import { streamChat, DEFAULT_MAX_TOKENS, type ChatMessage, type ToolCall, type ToolSpec } from "./llm.js";
import { specsOf, runTool } from "./tools/index.js";
import type { ToolContext } from "./tools/types.js";
import { PROJECT_ROOT } from "./tools/paths.js";

export interface ChatConfirmRequest {
  id: string;
  title: string;
  message: string;
}

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; name: string; ok: boolean; output: string; error?: string }
  | ({ type: "confirm" } & ChatConfirmRequest)
  | { type: "done"; aborted?: boolean; rounds?: number }
  | { type: "error"; message: string }
  | { type: "info"; message: string }
  | { type: "round"; n: number; model: string; msgs: number }
  | { type: "reasoning"; text: string };

export interface ChatOptions {
  /** 历史消息（最后一条应为 user） */
  history: ChatMessage[];
  /** 指定模型 id，空则用默认模型 */
  modelId?: string;
  /** 启用的工具名；空数组表示全部启用 */
  enabledTools?: string[];
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent: (e: ChatEvent) => void;
  confirm: (req: ChatConfirmRequest) => Promise<boolean>;
}

function systemPrompt(toolNames: string[]): string {
  return [
    "You are a local assistant for the OKX autonomous trading project, running on the user's machine; you can call tools to complete tasks.",
    "",
    `Working root: ${PROJECT_ROOT} (all file-tool paths are relative to this; out-of-bounds is rejected)`,
    `Current time: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
    "Available tools: " + (toolNames.length ? toolNames.join(", ") : "(none)"),
    "",
    "Behavior rules:",
    "1. When you need to know code/config, verify with search_files / read_file first; do not answer from memory.",
    "2. Use web_search / web_fetch for external info; for market/account prefer get_status / run_skill.",
    "3. Writing files (write_file) and running commands (bash) are dangerous and will prompt the user; if refused, switch approach, do not retry repeatedly.",
    "4. Long command outputs get truncated; read in ranges when needed.",
    "5. If unsure, say so; never fabricate file paths, command output or trading data.",
    "6. Answer in Chinese, concise and direct; when giving commands, state which directory to run in.",
  ].join("\n");
}

function parseArgs(raw: string): Record<string, any> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export interface ChatRunResult {
  messages: ChatMessage[];
  aborted: boolean;
  error?: string;
}

export async function runChat(opts: ChatOptions): Promise<ChatRunResult> {
  const {
    history, modelId, enabledTools = [], maxRounds = 8,
    signal, onEvent, confirm,
  } = opts;

  // 指定模型时若该模型被停用，resolveModel 会自动回退到默认模型
  const cfg: ModelConfig | undefined = modelId ? resolveModel(modelId) : resolveModel();
  if (!cfg) {
    onEvent({ type: "error", message: "没有可用模型。请到「模型」页添加模型并设为默认。" });
    return { messages: history, aborted: false, error: "无可用模型" };
  }

  const specs: ToolSpec[] = specsOf();
  const active = enabledTools.length
    ? specs.filter((s) => enabledTools.includes(s.function.name))
    : specs;

  const msgs: ChatMessage[] = [...history];
  if (msgs[0]?.role !== "system") msgs.unshift({ role: "system", content: systemPrompt(active.map((s) => s.function.name)) });

  const ctx: ToolContext = {
    signal,
    confirm,
    log: (line) => onEvent({ type: "info", message: line }),
  };

  let round = 0;
  while (round < maxRounds) {
    if (signal?.aborted) break;
    round++;
    onEvent({ type: "round", n: round, model: cfg.id, msgs: msgs.length });

    let text = "";
    let calls: ToolCall[] = [];
    let errMsg = "";

    // 推理模型（如 Hy3）思考链会吃满 max_tokens，把正文截断成空（finish_reason=length）。
    // 首轮用模型默认预算；若「正文为空 + 无工具调用 + 被预算截断」则翻倍预算重试，
    // 与 llm.decide() 的兜底一致，最多翻倍两次（封顶 128k）。
    let budget: number | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) break;
      text = "";
      calls = [];
      let finishReason = "";
      for await (const chunk of streamChat(cfg, msgs, active, signal, budget)) {
        if (chunk.type === "delta") {
          text += chunk.text;
          onEvent({ type: "delta", text: chunk.text });
        } else if (chunk.type === "reasoning") {
          onEvent({ type: "reasoning", text: chunk.text });
        } else if (chunk.type === "tool_calls") {
          calls = chunk.calls;
        } else if (chunk.type === "error") {
          errMsg = chunk.message;
        } else if (chunk.type === "done") {
          finishReason = chunk.finishReason ?? "";
        }
      }
      if (errMsg || signal?.aborted) break;
      // 有正文 / 有工具调用 / 并非被预算截断 → 本轮有效，直接交付
      if (text.trim() || calls.length || finishReason !== "length") break;
      budget = Math.min((budget ?? (cfg.maxTokens ?? DEFAULT_MAX_TOKENS)) * 2, 128000);
    }

    if (errMsg) {
      onEvent({ type: "error", message: errMsg });
      return { messages: msgs, aborted: !!signal?.aborted, error: errMsg };
    }
    if (signal?.aborted) break;

    // 翻倍重试后仍无正文且无工具调用：推理模型把预算全花在思考链上，正文被截断
    if (!text.trim() && !calls.length) {
      const msg =
        `模型只产出了思考过程、没有正文（max_tokens 可能被思考链吃满，已尝试翻倍到 ${budget}）。` +
        `请在「模型」页把该模型的 maxTokens 调大后重试。`;
      onEvent({ type: "error", message: msg });
      return { messages: msgs, aborted: false, error: msg };
    }

    if (calls.length) {
      msgs.push({ role: "assistant", content: text || "", tool_calls: calls });
      for (const c of calls) {
        if (signal?.aborted) break;
        const name = c.function?.name || "";
        const args = parseArgs(c.function?.arguments);
        onEvent({ type: "tool_start", callId: c.id, name, args });
        const r = await runTool(name, args, ctx);
        onEvent({
          type: "tool_result",
          callId: c.id,
          name,
          ok: r.ok,
          output: r.output || "",
          error: r.error,
        });
        msgs.push({
          role: "tool",
          tool_call_id: c.id,
          name,
          content: r.ok ? r.output || "（无输出）" : `工具执行失败：${r.error || "未知错误"}`,
        });
      }
      continue;
    }

    msgs.push({ role: "assistant", content: text });
    onEvent({ type: "done", aborted: false, rounds: round });
    return { messages: msgs, aborted: false };
  }

  onEvent({ type: "done", aborted: !!signal?.aborted, rounds: round });
  return { messages: msgs, aborted: !!signal?.aborted };
}


