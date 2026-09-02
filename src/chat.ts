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
import { streamChat, type ChatMessage, type ToolCall, type ToolSpec } from "./llm.js";
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
  | { type: "info"; message: string };

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
    "你是 OKX 自主交易项目的本地助手，运行在用户的机器上，可以调用工具来完成任务。",
    "",
    `工作根目录：${PROJECT_ROOT}（所有文件工具的路径都以此为准，越界会被拒绝）`,
    `当前时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
    "可用工具：" + (toolNames.length ? toolNames.join("、") : "（无）"),
    "",
    "行为准则：",
    "1. 需要了解代码/配置时先用 search_files、read_file 查证，不要凭印象回答。",
    "2. 需要外部信息时用 web_search / web_fetch；涉及行情与账户优先用 get_status / run_skill。",
    "3. 写文件（write_file）与执行命令（bash）属于危险操作，会弹窗让用户确认；被拒绝就改用其他方案，不要反复重试。",
    "4. 命令执行结果很长时会被截断，必要时分多次、带范围地读取。",
    "5. 不确定就说不确定，绝不编造文件路径、命令输出或交易数据。",
    "6. 回答用中文，简洁直接；给命令时写清楚在哪个目录执行。",
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

    let text = "";
    let calls: ToolCall[] = [];
    let errMsg = "";

    for await (const chunk of streamChat(cfg, msgs, active, signal)) {
      if (chunk.type === "delta") {
        text += chunk.text;
        onEvent({ type: "delta", text: chunk.text });
      } else if (chunk.type === "tool_calls") {
        calls = chunk.calls;
      } else if (chunk.type === "error") {
        errMsg = chunk.message;
      }
    }

    if (errMsg) {
      onEvent({ type: "error", message: errMsg });
      return { messages: msgs, aborted: !!signal?.aborted, error: errMsg };
    }
    if (signal?.aborted) break;

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


