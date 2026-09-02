/**
 * portfolio.ts —— 持仓汇总引擎（LLM 调 MCP 只读工具 → 统一 schema + 文字解读）
 *
 * 这是「支持仓位信息查看」的多交易所解法：不为每个交易所写死 UI/字段映射，
 * 而是让 LLM 通过 MCP 调各交易所的只读工具，归并成 src/types.ts 里的
 * 统一 schema（PortfolioSnapshot），并附一段中文解读/风险提示。
 *
 * 与对话页（chat.ts）隔离：本文件自带精简 ReAct 循环，避免把 MCP 工具混入
 * 全局对话工具集（防止写工具意外暴露）。工具循环复用 llm.ts 的 streamChat。
 */
import { resolveModel, type ModelConfig } from "./store.js";
import { streamChat, type ChatMessage, type ToolCall, type ToolSpec } from "./llm.js";
import { loadMcpReadTools } from "./tools/mcpBridge.js";
import type { ToolResult } from "./tools/types.js";
import type { PortfolioSnapshot } from "./types.js";

export type PortfolioEvent =
  | { type: "exchanges"; list: string[]; errors: string[] }
  | { type: "delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; name: string; ok: boolean; output: string; error?: string }
  | { type: "done"; schema?: PortfolioSnapshot; notes?: string }
  | { type: "error"; message: string }
  | { type: "round"; n: number; model: string; msgs: number }
  | { type: "reasoning"; text: string };

/** 统一 schema 的人/LLM 可读描述（塞进 system prompt） */
const SCHEMA_SPEC = `统一 schema（LLM 输出必须贴合）：
- accounts[]: { exchange, equityUsd, availableUsd, marginUsedUsd, totalUplUsd }
    equityUsd=账户总权益(美元); availableUsd=可用; marginUsedUsd=已用保证金; totalUplUsd=未实现盈亏合计
- positions[]: { exchange, instId, market, side, size, entryPrice, markPrice, notionalUsd, upl, uplRatio, leverage, liqPrice, marginMode }
    market: "swap"|"spot"|"other"; side: "long"|"short"|"net"; uplRatio 是 0~1 的小数(如 0.012 表示 1.2%)
- orders[]: { exchange, instId, ordType, side, size, slTrigger, tpTrigger, state }
    ordType=订单类型(如 oco/limit); side: "buy"|"sell"|"long"|"short"|""; slTrigger/tpTrigger=止损/止盈触发价
- exchanges: 所有已连接交易所的 server id 列表
- generatedAt: 当前 ISO 时间字符串`;

const SYSTEM_PROMPT = `你是多交易所持仓汇总助手，运行在用户本机。
已连接以下交易所（每个是一个 MCP server），并挂载了它们的只读工具：
{TOOLS}

任务：依次调用各交易所的「持仓 / 账户 / 挂单」只读工具，把数据归并成统一的 portfolio schema。
注意：不同交易所工具名与返回字段不同，由你负责读懂并把它们映射到统一 schema；无法获取的数值填 null，不要编造。

统一 schema 如下：
{SCHEMA}

输出要求（务必遵守）：
1. 用如下 JSON 代码块给出结构化结果：
\`\`\`json
{ "schema": { "exchanges":[...], "accounts":[...], "positions":[...], "orders":[...], "generatedAt":"ISO时间" }, "notes":"中文解读与风险提示" }
\`\`\`
2. JSON 代码块之外，不要再写多余内容（notes 字段已承载文字解读）。
3. 没有持仓/挂单的交易所也要出现在 accounts（权益可为 null）。
4. exchange 一律用 MCP server 的 id（如 okx-trade-mcp）。
5. 工具返回为空就如实写空数组；绝不以自己猜测填充数字。`;

const MAX_ROUNDS = 6;
const TRUNCATE = 12_000;

function toSpecs(tools: { name: string; description: string; parameters: Record<string, unknown> }[]): ToolSpec[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * 从 LLM 输出里解析 {schema, notes}。
 * LLM 应把 JSON 放在 ```json 块；兼容性：找不到块时退而在全文找最外层 {...}。
 */
function parseResult(text: string): { schema?: PortfolioSnapshot; notes?: string } {
  let schema: PortfolioSnapshot | undefined;
  let notes: string | undefined;

  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = m ? m[1] : text;
  const s = candidate.indexOf("{");
  const e = candidate.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      const obj = JSON.parse(candidate.slice(s, e + 1)) as { schema?: PortfolioSnapshot; notes?: string };
      schema = obj.schema;
      notes = obj.notes;
    } catch {
      /* 解析失败则交给兜底 */
    }
  }

  if (!notes) {
    const outside = text.replace(/```(?:json)?[\s\S]*?```/g, "").trim();
    notes = outside || undefined;
  }
  return { schema, notes };
}

export interface SummarizeOptions {
  modelId?: string;
  signal?: AbortSignal;
  onEvent: (e: PortfolioEvent) => void;
}

/**
 * 驱动一次持仓汇总。过程通过 onEvent 流式回传，最后以 done 给出结构化 schema。
 * 不抛异常：所有错误都以 error 事件回传，调用方永远拿得到反馈。
 */
export async function summarizePortfolio(opts: SummarizeOptions): Promise<void> {
  const { modelId, signal, onEvent } = opts;
  const cfg: ModelConfig | undefined = modelId ? resolveModel(modelId) : resolveModel();
  if (!cfg) {
    onEvent({ type: "error", message: "没有可用模型。请到「模型」页添加模型并设为默认。" });
    return;
  }

  const set = await loadMcpReadTools();
  onEvent({ type: "exchanges", list: set.exchanges, errors: set.errors });

  if (!set.tools.length) {
    const msg = set.errors.length
      ? `无可用只读工具：${set.errors.join("；")}`
      : "未连接任何交易所 MCP。请到「MCP」页添加（如 okx-trade-mcp），并确认已启用。";
    onEvent({ type: "error", message: msg });
    await set.close();
    return;
  }

  const specs = toSpecs(set.tools);
  const sysText = SYSTEM_PROMPT.replace(
    "{TOOLS}",
    set.tools.map((t) => `· ${t.name} — ${t.description}`).join("\n")
  ).replace("{SCHEMA}", SCHEMA_SPEC);

  const msgs: ChatMessage[] = [
    { role: "system", content: sysText },
    { role: "user", content: "请汇总我所有已连接交易所的持仓、账户与挂单，按统一 schema 输出。" },
  ];

  try {
    let round = 0;
    while (round < MAX_ROUNDS) {
      if (signal?.aborted) break;
      round++;
      onEvent({ type: "round", n: round, model: cfg.id, msgs: msgs.length });

      let text = "";
      let calls: ToolCall[] = [];
      let errMsg = "";

      for await (const ch of streamChat(cfg, msgs, specs, signal)) {
        if (ch.type === "delta") {
          text += ch.text;
          onEvent({ type: "delta", text: ch.text });
        } else if (ch.type === "reasoning") {
          onEvent({ type: "reasoning", text: ch.text });
        } else if (ch.type === "tool_calls") {
          calls = ch.calls;
        } else if (ch.type === "error") {
          errMsg = ch.message;
        }
      }

      if (errMsg) {
        onEvent({ type: "error", message: errMsg });
        return;
      }
      if (signal?.aborted) break;

      if (calls.length) {
        msgs.push({ role: "assistant", content: text || "", tool_calls: calls });
        for (const c of calls) {
          if (signal?.aborted) break;
          const name = c.function?.name || "";
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(c.function?.arguments || "{}");
          } catch {
            args = {};
          }
          onEvent({ type: "tool_start", callId: c.id, name, args });

          const tool = set.tools.find((t) => t.name === name);
          const r: ToolResult = tool
            ? await tool.run(args, { signal })
            : { ok: false, output: "", error: `未知工具「${name}」` };

          const out = r.output ? String(r.output).slice(0, TRUNCATE) : "";
          onEvent({
            type: "tool_result",
            callId: c.id,
            name,
            ok: !!r.ok,
            output: out || "（无输出）",
            error: r.error,
          });
          msgs.push({
            role: "tool",
            tool_call_id: c.id,
            name,
            content: r.ok ? out || "（无输出）" : `工具执行失败：${r.error || "未知错误"}`,
          });
        }
        continue;
      }

      // 没有工具调用 → 视为最终回答
      msgs.push({ role: "assistant", content: text });
      const parsed = parseResult(text);
      onEvent({ type: "done", schema: parsed.schema, notes: parsed.notes });
      return;
    }

    if (signal?.aborted) {
      onEvent({ type: "done" });
    } else {
      onEvent({ type: "error", message: "超出最大轮次仍未给出结构化结果，请重试或检查 MCP 工具。" });
    }
  } finally {
    await set.close();
  }
}
