/**
 * orchestrator.ts —— 主 Agent（编排者）
 *
 * 主 Agent 不自己做具体分析，它做三件事：
 *   1. 【召唤】根据本轮情况决定召唤哪些专家（省 token，也避免无关噪声）
 *   2. 【汇总】收集各专家观点，识别相互冲突之处
 *   3. 【拍板】综合冲突与仓位纪律，产出最终可执行决策
 *
 * 为什么主 Agent 也要一次 LLM 调用：
 *   专家各说各话（新闻说利多、因子说看空），需要一个具备全局视角的角色
 *   权衡谁更有说服力，而不是机械投票。这就是 LLM 作为核心的价值。
 */
import type { LlmProvider } from "./llm.js";
import { EXPERTS, getExpert, type ExpertOpinion } from "./experts.js";
import type { Decision, TradeIntent } from "./types.js";

export interface OrchestratorInput {
  roundId: string;
  /** 共享上下文（账户/行情/运行态），传给每个专家 */
  sharedContext: string;
  /** 强制召唤的专家 id（如 --experts trading,news），为空则由主 Agent 自决 */
  forceExperts?: string[];
}

export interface OrchestratorResult {
  /** 本轮召唤了哪些专家 */
  called: string[];
  opinions: ExpertOpinion[];
  decision: Decision | null;
  /** 主 Agent 识别出的专家间冲突 */
  conflicts: string[];
}

/** 第一步：让主 Agent 决定召唤哪些专家 */
async function planExperts(llm: LlmProvider, ctx: string): Promise<string[]> {
  const sys = `你是主 Agent 的调度模块。根据本轮情况，决定召唤哪些专家。

可选专家：
${EXPERTS.map((e) => `- ${e.id}（${e.name}）：${e.duty}`).join("\n")}

规则：
- 只要有持仓或有开仓可能，通常召唤 trading + factor。
- 临近重大事件、或上一轮消息面有影响时召唤 news。
- 持仓亏损、回撤扩大、或敞口较高时召唤 risk。
- 没必要时不要召唤全部（省成本、降噪声）。

【输出】只输出 JSON：{"experts": ["trading","factor"]}`;

  const raw = await llm.decide(sys, ctx);
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw) as { experts?: string[] };
    const ids = (j.experts ?? []).filter((x) => !!getExpert(x));
    return ids.length ? ids : ["trading"];
  } catch {
    return ["trading"];
  }
}

/** 第二步：主 Agent 综合各专家意见拍板 */
async function adjudicate(
  llm: LlmProvider,
  ctx: string,
  opinions: ExpertOpinion[]
): Promise<Decision | null> {
  const sys = `你是主 Agent（最终决策者）。各专家已给出观点，你要综合权衡后拍板。

【你的权力与责任】
- 专家观点只是输入，你可以不采纳任何一个，但必须在 summary 里说明理由。
- 冲突时（如新闻利多 vs 因子看空），判断谁更可信：
  通常「已双源验证(A级)的消息」>「技术因子」>「单源(B级)消息」。
- 已有持仓时，默认倾向「持有并让 OCO 执行」，除非有充分理由平仓。
- 「不交易」合法，但需理由。

【必须输出】只输出 JSON，不要解释文字、不要 markdown：
{
  "decision": "OPEN" | "HOLD" | "CLOSE" | "STANDBY",
  "riskTier": "BASE" | "AGG" | "DEF",
  "summary": "决策摘要与理由（100-300字，说明如何处理专家分歧）",
  "conflicts": ["专家之间的冲突点"],
  "intents": [
    {"inst":"BTC-USDT-SWAP","action":"hold|long|short|close",
     "riskPct":0.012,"slDist":712.3,"tpRR":2.0,"reason":"...",
     "deviations":[{"baseline":"","actual":"","rationale":"","falsifier":"","riskDelta":""}]}
  ],
  "needsApproval": false,
  "approvalReason": ""
}

【约束】
- riskPct 不超过 0.025；单笔 >0.02 时把 needsApproval 设为 true 并写 approvalReason。
- 开仓必须给 slDist。
- 偏离章程基准时 deviations 五项必填（尤其 falsifier 可证伪预判）。
- 可交易【候选标的与行情摘要】中的任意 USDT 永续；做多(action=long)与做空(action=short)平等、均可开仓（net 模式单一方向）。
- 优先流动性好、规格清晰的标的，避开价格极低/价格步长极小的标的。`;

  const user = [
    ctx,
    ``,
    `【各专家观点】`,
    ...opinions.map(
      (o) =>
        `── ${o.expert}（${o.stance}, 置信${o.confidence}）\n${o.summary}\nadvice: ${JSON.stringify(o.advice).slice(0, 1500)}${o.flags?.length ? `\nflags: ${o.flags.join("; ")}` : ""}`
    ),
  ].join("\n");

  const raw = await llm.decide(sys, user);
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw) as Record<string, unknown>;
    if (!j.decision) return null;
    return {
      roundId: "",
      decision: j.decision as Decision["decision"],
      intents: (j.intents as TradeIntent[]) ?? [],
      summary: String(j.summary ?? ""),
      riskTier: (j.riskTier as Decision["riskTier"]) ?? "BASE",
      needsApproval: Boolean(j.needsApproval),
      approvalReason: j.approvalReason ? String(j.approvalReason) : undefined,
      rawText: raw,
    };
  } catch {
    return null;
  }
}

export async function orchestrate(
  llm: LlmProvider,
  input: OrchestratorInput
): Promise<OrchestratorResult> {
  // 1) 决定召唤谁
  const planned = input.forceExperts?.length
    ? input.forceExperts.filter((x) => !!getExpert(x))
    : await planExperts(llm, input.sharedContext);

  // 2) 并行召唤（专家之间无依赖）
  const exps = planned.map((id) => getExpert(id)!);
  const settled = await Promise.allSettled(exps.map((e) => e.run(llm, { sharedContext: input.sharedContext })));
  const opinions: ExpertOpinion[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      opinions.push(r.value);
    } else {
      opinions.push({
        expert: exps[i].id,
        stance: "abstain",
        confidence: 0,
        summary: `调用失败: ${String(r.reason).slice(0, 150)}`,
        advice: {},
        flags: ["专家调用失败"],
      });
    }
  });

  // 3) 主 Agent 拍板
  const decision = await adjudicate(llm, input.sharedContext, opinions);
  if (decision) decision.roundId = input.roundId;

  const conflicts = extractConflicts(opinions);

  return { called: planned, opinions, decision, conflicts };
}

/** 机械识别立场冲突（供主 Agent 与日志参考） */
export function extractConflicts(ops: ExpertOpinion[]): string[] {
  const out: string[] = [];
  const active = ops.filter((o) => o.stance === "bullish" || o.stance === "bearish");
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (active[i].stance !== active[j].stance) {
        out.push(`${active[i].expert}(${active[i].stance}) vs ${active[j].expert}(${active[j].stance})`);
      }
    }
  }
  return out;
}
