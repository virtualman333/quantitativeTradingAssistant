/**
 * graph.ts —— LangGraph 多专家编排图
 *
 * 拓扑（用户 2026-09-02 指定）：
 *
 *        ┌─────────┐
 *        │ collect │  取数（账户 + 行情）
 *        └────┬────┘
 *        ┌────▼────┐
 *        │  plan   │  主 Agent 决定召唤哪些专家
 *        └────┬────┘
 *    ┌────────┼────────┬─────────┐      ← Send 动态并行扇出
 * ┌──▼──┐ ┌──▼──┐ ┌───▼──┐ ┌───▼──┐
 * │trade│ │news │ │factor│ │ risk │      ← 专家节点（互不依赖）
 * └─┬───┘ └─┬───┘ └───┬──┘ └───┬──┘
 *   └────────┼────────┴─────────┘
 *        ┌───▼────┐
 *        │adjudge │  主 Agent 汇总冲突、拍板
 *        └───┬────┘
 *        ┌───▼────┐
 *        │ execute│  执行（dry-run 时跳过写操作）
 *        └───┬────┘
 *        ┌───▼────┐
 *        │ archive│  归档（只追加）
 *        └────────┘
 *
 * 为什么用 LangGraph 而非手写编排：
 *   · Send 原生支持「运行时决定扇出几个专家」（手写要自己管 Promise 与聚合）
 *   · Annotation.Reducer 天然处理「多节点并发写同一状态字段」
 *   · 内置 checkpoint，可断点续跑、可回放某一轮
 */
import { Annotation, Send, StateGraph, START, END } from "@langchain/langgraph";
import { allExperts, getExpert, type ExpertOpinion } from "./experts.js";
import { connectMcp, type McpTool } from "./mcp.js";
import { createProvider, type DecideOpts } from "./llm.js";
import { trace, traceReasoning, traceRound } from "./trace.js";
import { getModel, getSettings, listRoles, resolveModel, type ModelConfig } from "./store.js";
import type { Decision, TradeIntent } from "./types.js";

// ── 状态定义 ──────────────────────────────────────────────
export const AgentState = Annotation.Root({
  roundId: Annotation<string>,
  sharedContext: Annotation<string>,
  /** 计划召唤的专家 id 列表 */
  expertPlan: Annotation<string[]>,
  /** 各专家观点 —— 用 Reducer 汇总，专家节点并发写入 */
  opinions: Annotation<ExpertOpinion[]>({
    reducer: (cur, next) => [...cur, ...next],
    default: () => [],
  }),
  /** 主 Agent 识别的冲突 */
  conflicts: Annotation<string[]>,
  /** 最终决策 */
  decision: Annotation<Decision | null>,
  /** 执行结果 */
  execResults: Annotation<string[]>({
    reducer: (cur, next) => [...cur, ...next],
    default: () => [],
  }),
  /** 日志行 */
  logs: Annotation<string[]>({
    reducer: (cur, next) => [...cur, ...next],
    default: () => [],
  }),
  dryRun: Annotation<boolean>,
});

export type State = typeof AgentState.State;

/** @deprecated 已由 makeStoreLlmProvider 取代（多模型配置来自 store） */

/** 专家需要的极简 provider 接口（与 llm.ts 的 LlmProvider 形状一致） */
export interface LlmProviderLike {
  decide(systemPrompt: string, userPrompt: string, opts?: DecideOpts): Promise<string>;
  /** 模型显示名（观测页展示用，mock 兜底无） */
  model?: string;
}

/**
 * 基于 store 的模型配置创建 provider。
 * modelId 为空时：主 Agent 用 settings.mainAgentModelId，其余用 defaultModelId。
 */
export function makeStoreLlmProvider(modelId?: string, mainAgent = false): LlmProviderLike {
  let cfg: ModelConfig | undefined;
  try {
    cfg = modelId ? getModel(modelId) : resolveModel(undefined, mainAgent);
  } catch {
    cfg = undefined;
  }
  if (!cfg) {
    // store 不可用时的兜底（不应发生）
    return { decide: async () => JSON.stringify({ stance: "abstain", confidence: 0, summary: "无可用模型", advice: {} }) };
  }
  const p = createProvider(cfg);
  return {
    model: cfg.name,
    decide: async (sys, user, opts) => {
      try {
        return await p.decide(sys, user, opts);
      } catch (e) {
        trace({ source: "agent", kind: "error", message: `模型 ${cfg!.name} 调用失败: ${String(e).slice(0, 180)}` });
        return JSON.stringify({
          stance: "abstain",
          confidence: 0,
          summary: `模型调用失败(${cfg!.name}): ${String(e).slice(0, 200)}`,
          advice: {},
          flags: ["模型调用失败"],
        });
      }
    },
  };
}

function mockReply(sys: string): string {
  const isPlan = sys.includes("dispatcher");
  if (isPlan) return JSON.stringify({ experts: allExperts().map((e) => e.id) });
  if (sys.includes("Main Agent")) {
    return JSON.stringify({
      decision: "HOLD",
      riskTier: "BASE",
      summary: "[mock] 未配置 LLM key，主 Agent 保守观望。",
      conflicts: [],
      intents: [
        { inst: "BTC-USDT-SWAP", action: "hold", reason: "[mock] 无 key，观望" },
        { inst: "ETH-USDT-SWAP", action: "hold", reason: "[mock] 无 key，观望" },
      ],
      needsApproval: false,
    });
  }
  return JSON.stringify({
    stance: "abstain",
    confidence: 0,
    summary: "[mock] 无 LLM key，专家弃权",
    advice: {},
    flags: ["mock 模式"],
  });
}

function outJson(text: string): Record<string, unknown> {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = m ? m[1] : text;
  const s = body.indexOf("{");
  const e = body.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("未找到 JSON");
  return JSON.parse(body.slice(s, e + 1)) as Record<string, unknown>;
}

// ── 节点：主 Agent 决定召唤谁 ─────────────────────────────
/**
 * 专家选择策略（来自 store.settings.roleStrategy）：
 *   · "fixed"：用界面勾选的 fixedRoles（为空则视为「全部已启用专家」）
 *   · "llm"  ：由主 Agent 自行决定召唤哪些专家
 * 两种模式下，兜底都是「全部已启用专家」，避免出现 0 或 1 个专家的情况。
 */
async function planNode(s: State): Promise<Partial<State>> {
  const enabled = allExperts(); // 已启用的专家
  const enabledIds = enabled.map((e) => e.id);
  const settings = getSettings();

  // 必召集合：由专家定义的 alwaysInvoke 字段决定（如 news 消息面事件闸门，空仓也要看）
  const mandatory = enabled.filter((e) => e.alwaysInvoke).map((e) => e.id);

  let ids: string[] = [];
  if (settings.roleStrategy === "fixed") {
    const picked = (settings.fixedRoles ?? []).filter((id) => enabledIds.includes(id));
    // 固定模式同样保证必召专家在列（空仓也要看消息面）
    ids = [...new Set([...picked, ...mandatory])];
    if (!ids.length) ids = enabledIds;
  } else {
    // LLM 只决定「交易类」专家；消息面必召，不交给 LLM 拍脑袋
    const optional = enabled.filter((e) => !mandatory.includes(e.id));
    const llm = makeStoreLlmProvider(undefined, true);
    const sys = `You are the dispatcher module of the Main Agent. Decide which "trading" experts to invoke this round.
Mandatory experts (not your call, enforced by code): ${mandatory.join(", ") || "(none)"} — news is the event gate / veto power; it must run even when flat, to watch for upcoming events.
Optional trading experts: ${optional.map((e) => `${e.id} (${e.name}): ${e.duty}`).join(" | ") || "(none)"}
Rule: holding or likely to open → trading + factor; losing position / drawdown / high exposure → risk. Do not over-invoke.
Output JSON only: {"experts":["trading","factor"]}`;
    try {
      traceRound("调度·决定召唤专家", llm.model);
      const raw = await llm.decide(sys, s.sharedContext, { onReasoning: traceReasoning });
      const picked = ((outJson(raw).experts as string[]) ?? []).filter((x) =>
        optional.some((o) => o.id === x)
      );
      ids = [...new Set([...mandatory, ...picked])];
    } catch {
      trace({ source: "agent", kind: "error", message: "调度输出解析失败，回退全部专家" });
      ids = [];
    }
  }
  if (!ids.length) ids = enabledIds; // 兜底：全部已启用专家
  return { expertPlan: ids, logs: [`召唤专家(${settings.roleStrategy}): ${ids.join(", ")}`] };
}

/** 条件边：按 plan 动态扇出 */
function fanout(s: State) {
  return (s.expertPlan ?? []).map((id) => new Send(id, s));
}

// ── 专家节点（工厂函数，每个专家一个） ────────────────────
function makeExpertNode(id: string, allMcpTools: McpTool[] = [], llm?: LlmProviderLike) {
  return async (s: State): Promise<Partial<State>> => {
    const ex = getExpert(id)!;
    // 最小权限：只给该专家声明过的 server 的工具
    const myTools = allMcpTools.filter((t) => ex.mcpServers.includes(t.serverId));
    try {
      const op = await ex.run(
        (llm ?? makeStoreLlmProvider()) as never,
        { sharedContext: s.sharedContext, mcpTools: myTools }
      );
      const tc = op.toolCalls?.length ? ` [工具:${op.toolCalls.join(",")}]` : "";
      return {
        opinions: [op],
        logs: [` · ${op.expert}[${op.stance} ${op.confidence}]${tc} ${op.summary.slice(0, 110)}`],
      };
    } catch (e) {
      const op: ExpertOpinion = {
        expert: ex.id,
        stance: "abstain",
        confidence: 0,
        summary: `调用失败: ${String(e).slice(0, 120)}`,
        advice: {},
        flags: ["调用失败"],
      };
      return { opinions: [op], logs: [` · ${ex.id} 调用失败`] };
    }
  };
}

// ── 节点：主 Agent 拍板 ───────────────────────────────────
async function adjudgeNode(s: State): Promise<Partial<State>> {
  const llm = makeStoreLlmProvider(undefined, true); // 主 Agent 用专用模型
  const sys = `You are the Main Agent (final decision-maker). Synthesize all expert opinions and make the final call.
You may reject any expert, but must explain in summary how you resolved disagreements.
On conflicts, weight: dual-source-verified A-grade news > technical factors > single-source B-grade news.
Default for existing positions is "hold and let the OCO execute" unless there is strong reason to close. "No trade" is legal but needs a reason.

Output JSON only:
{"decision":"OPEN|HOLD|CLOSE|STANDBY","riskTier":"BASE|AGG|DEF",
 "summary":"100-300 chars, explain how expert disagreements were resolved","conflicts":["..."],
 "intents":[{"inst":"BTC-USDT-SWAP","action":"hold|long|short|close","riskPct":0.012,
   "slDist":712.3,"tpRR":2.0,"reason":"...",
   "deviations":[{"baseline":"","actual":"","rationale":"","falsifier":"","riskDelta":""}]}],
 "needsApproval":false,"approvalReason":""}

Constraints: riskPct ≤ 0.025; if > 0.02 set needsApproval=true and write the reason; opening a position must include slDist;
deviating from a baseline requires all five deviation fields;
instruments & direction: you may trade any USDT perpetual listed in [Candidate instruments & market digest]; long (action=long) and short (action=short) are equal, both allowed (net mode = single direction, never both);
prefer liquid, well-specified instruments; avoid very low price / very small tickSz where contract-count math is error-prone.`;

  const user = [
    s.sharedContext,
    "",
    "[Expert opinions]",
    ...s.opinions.map(
      (o) =>
        `── ${o.expert}(${o.stance}, confidence ${o.confidence})\n${o.summary}\nadvice: ${JSON.stringify(o.advice).slice(0, 1500)}${o.flags?.length ? `\nflags: ${o.flags.join("; ")}` : ""}`
    ),
  ].join("\n");

  // 机械冲突识别（与 LLM 判断互补，日志可审计）
  const active = s.opinions.filter((o) => o.stance === "bullish" || o.stance === "bearish");
  const conflicts: string[] = [];
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++)
      if (active[i].stance !== active[j].stance)
        conflicts.push(`${active[i].expert}(${active[i].stance}) vs ${active[j].expert}(${active[j].stance})`);

  try {
    traceRound("主Agent·拍板", llm.model);
    const raw = await llm.decide(sys, user, { onReasoning: traceReasoning });
    const j = outJson(raw);
    const d: Decision = {
      roundId: s.roundId,
      decision: (j.decision as Decision["decision"]) ?? "STANDBY",
      intents: (j.intents as TradeIntent[]) ?? [],
      summary: String(j.summary ?? ""),
      riskTier: (j.riskTier as Decision["riskTier"]) ?? "BASE",
      needsApproval: Boolean(j.needsApproval),
      approvalReason: j.approvalReason ? String(j.approvalReason) : undefined,
      rawText: raw,
    };
    const llmConf = Array.isArray(j.conflicts) ? (j.conflicts as string[]) : [];
    return {
      decision: d,
      conflicts: [...new Set([...conflicts, ...llmConf])],
      logs: [`主Agent=${d.decision} ${d.summary.slice(0, 140)}`],
    };
  } catch (e) {
    trace({ source: "agent", kind: "error", message: `拍板失败: ${String(e).slice(0, 150)}` });
    return {
      decision: null,
      conflicts,
      logs: [`拍板失败: ${String(e).slice(0, 150)}`],
    };
  }
}

/** 条件边：是否需要人工确认 */
function needApproval(s: State) {
  if (!s.decision) return END;
  return s.decision.needsApproval ? "pendingApproval" : "execute";
}

// ── 节点：挂起等人工确认 ───────────────────────────────────
async function pendingNode(s: State): Promise<Partial<State>> {
  return { logs: [`⏸ 需人工确认: ${s.decision?.approvalReason ?? "未注明"}`] };
}

// ── 节点：执行 ────────────────────────────────────────────
async function executeNode(s: State): Promise<Partial<State>> {
  // 执行逻辑放在 main.ts 注入的回调里（graph 只编排，不直接碰 OKX）
  return { logs: ["[execute] 由外部 executor 处理"] };
}

// ── 节点：归档 ────────────────────────────────────────────
async function archiveNode(s: State): Promise<Partial<State>> {
  return { logs: ["[archive] 由外部 archiver 处理"] };
}

// ── 组装图 ────────────────────────────────────────────────
/**
 * @param mcpTools 已连接的 MCP 工具（由 main.ts 连好后传入）。
 *                 每个专家只能看到自己 mcpServers 声明的工具 —— 最小权限原则。
 *
 * 模型分派（用户需求 2、3）：
 *   · 每个角色可用自己的模型（role.modelId），未指定则用全局默认
 *   · 主 Agent 拍板可用专用模型（settings.mainAgentModelId）
 */
export function buildGraph(mcpTools: McpTool[] = [], llm?: LlmProviderLike) {
  const roles = allExperts();
  const g = new StateGraph(AgentState)
    .addNode("plan", planNode)
    .addNode("adjudge", adjudgeNode)
    .addNode("pendingApproval", pendingNode)
    .addNode("execute", executeNode)
    .addNode("archive", archiveNode);

  // 专家节点：动态角色，加/改角色不用改图结构
  for (const ex of roles) {
    // 每个角色独立模型：优先 store 里该角色指定的模型
    let roleModelId: string | undefined;
    try {
      roleModelId = listRoles().find((r) => r.id === ex.id)?.modelId;
    } catch {
      /* ignore */
    }
    const provider = roleModelId ? makeStoreLlmProvider(roleModelId) : (llm ?? makeStoreLlmProvider(undefined, false));
    g.addNode(ex.id, makeExpertNode(ex.id, mcpTools, provider));
    g.addEdge(ex.id as "plan", "adjudge");
  }

  g.addEdge(START, "plan")
    .addConditionalEdges("plan", fanout)
    .addConditionalEdges("adjudge", needApproval)
    .addEdge("execute", "archive")
    .addEdge("archive", END)
    .addEdge("pendingApproval", END);

  return g.compile();
}

/**
 * 便捷入口：连接 MCP 并构建图。
 * 调用方负责在结束后 close()，否则 stdio 子进程不会退出。
 */
export async function buildGraphWithMcp(serverIds?: string[]) {
  const conn = await connectMcp(serverIds);
  const graph = buildGraph(conn.tools);
  return { graph, ...conn };
}

