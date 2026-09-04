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
  const sys = `You are the dispatcher module of the Main Agent. Decide which experts to invoke this round.

Available experts:
${EXPERTS.map((e) => `- ${e.id} (${e.name}): ${e.duty}`).join("\n")}

Rules:
- When holding or likely to open, usually invoke trading + factor.
- When near a major event or last round's news had impact, invoke news.
- When holding at a loss, drawdown widening, or high exposure, invoke risk.
- Do not invoke all unless necessary (save cost, reduce noise).

[Output] Output JSON only: {"experts": ["trading","factor"]}`;

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
  const sys = `You are the Main Agent (final decision-maker). The experts have given opinions; synthesize and make the final call.

[Your powers & duties]
- Expert opinions are only input; you may reject any, but must explain in summary.
- On conflicts (e.g. bullish news vs bearish factor), judge who is more credible:
  usually "dual-source-verified (A-grade) news" > "technical factor" > "single-source (B-grade) news".
- When already holding, default to "hold and let OCO execute" unless there is strong reason to close.
- "No trade" is legal but needs a reason.

[Must output] Output JSON only, no explanation text, no markdown:
{
  "decision": "OPEN" | "HOLD" | "CLOSE" | "STANDBY",
  "riskTier": "BASE" | "AGG" | "DEF",
  "summary": "decision summary & rationale (100-300 chars, explain how expert disagreements were resolved)",
  "conflicts": ["conflict points between experts"],
  "intents": [
    {"inst":"BTC-USDT-SWAP","action":"hold|long|short|close",
     "riskPct":0.012,"slDist":712.3,"tpRR":2.0,"reason":"...",
     "deviations":[{"baseline":"","actual":"","rationale":"","falsifier":"","riskDelta":""}]}
  ],
  "needsApproval": false,
  "approvalReason": ""
}

[Constraints]
- riskPct no more than 0.025; single trade >0.02 → set needsApproval=true and write approvalReason.
- Opening a position must include slDist.
- Deviating from a charter baseline requires all five deviation fields (especially the falsifiable falsifier).
- You may trade any USDT perpetual in [Candidate instruments & market digest]; long (action=long) and short (action=short) are equal, both allowed (net mode = single direction).
- Prefer liquid, well-specified instruments; avoid very low price / very small tickSz.`;

  const user = [
    ctx,
    ``,
    `[Expert opinions]`,
    ...opinions.map(
      (o) =>
        `── ${o.expert}(${o.stance}, confidence ${o.confidence})\n${o.summary}\nadvice: ${JSON.stringify(o.advice).slice(0, 1500)}${o.flags?.length ? `\nflags: ${o.flags.join("; ")}` : ""}`
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
        summary: `call failed: ${String(r.reason).slice(0, 150)}`,
        advice: {},
        flags: ["expert call failed"],
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
