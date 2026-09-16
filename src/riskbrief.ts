/**
 * riskbrief.ts —— 每轮「风控体检」
 *
 * guard.ts 管的是「这一笔能不能下单」，在放行的那一刻只说一个「行」。
 * 但复盘时真正想看的是整轮体检：几笔动作、各自隐含杠杆多少、单笔风险
 * 占了多少预算、离 5x 与 2.5% 两道硬顶还有多远、有没有踩到 L2 那条
 * 「单笔风险超过 2% 需人工确认」的门槛。
 *
 * 这些数字 guard 其实都算过（warnings / violations），只是 main.ts 此前
 * 只判了 `g.ok`，warnings 被直接丢掉 —— 章程 L2 写着「>2% 需人工确认」，
 * 代码里却没有任何一处接住这个信号，那条约束等于没落地。
 *
 * 本模块把一轮的意图过一遍 guard，汇总成结构化体检：
 *   - summary：一行人类可读摘要（进日志、进告警）
 *   - intents：逐笔明细（进归档 payload，报告与界面可直接读）
 *
 * 口径单一来源：隐含杠杆与两道硬顶的常量都从 guard.ts 取，不在这里重写公式。
 */
import { guardIntent, impliedLeverage, MAX_LEVERAGE, MAX_RISK_PCT } from "./guard.js";
import type { AccountSnapshot, TradeIntent } from "./types.js";

/** 单笔意图的体检结果 */
export interface IntentCheck {
  inst: string;
  action: string;
  ok: boolean;
  /** 归一化后的单笔风险比例；无数据时为 null */
  riskPct: number | null;
  /** 由风险比例与止损距离反推的隐含杠杆；无数据时为 null */
  impliedLeverage: number | null;
  /** 隐含杠杆占 5x 上限的百分比（>100 即超限） */
  leverageUsagePct: number | null;
  /** 单笔风险占 2.5% 硬顶的百分比（>100 即超限） */
  riskUsagePct: number | null;
  violations: string[];
  warnings: string[];
  needsApproval: boolean;
}

/** 一轮的体检汇总 */
export interface RiskBrief {
  /** 参与体检的意图数（hold 不动仓位，不计入） */
  total: number;
  passed: number;
  warned: number;
  blocked: number;
  maxImpliedLeverage: number | null;
  maxRiskPct: number | null;
  /** 本轮是否存在需要人工确认的意图（L2 基准） */
  needsApproval: boolean;
  approvalReasons: string[];
  intents: IntentCheck[];
  summary: string;
}

const showPct = (v: number): string => `${(v * 100).toFixed(2)}%`;

/** hold 不动仓位，不参与体检（它不需要止损、也不占风险预算） */
export function isTradable(it: TradeIntent): boolean {
  return !!it && it.action !== "hold";
}

/**
 * 单笔体检：结论直接来自 guardIntent，这里只额外把「用了多少预算」算出来，
 * 因为那才是复盘时看得懂的那一半。
 */
export function checkIntent(
  it: TradeIntent,
  snap: AccountSnapshot,
  refPrice: number,
  knownInsts?: Set<string>
): IntentCheck {
  const g = guardIntent(it, snap, refPrice, knownInsts);
  const opening = it.action === "long" || it.action === "short";
  const rawRisk = Number(it.riskPct);
  const riskPct = opening && rawRisk > 0 ? rawRisk : null;
  const lever = opening ? impliedLeverage(rawRisk, Number(it.slDist), refPrice) : null;

  return {
    inst: it.inst,
    action: it.action,
    ok: g.ok,
    riskPct,
    impliedLeverage: lever,
    leverageUsagePct: lever === null ? null : (lever / MAX_LEVERAGE) * 100,
    riskUsagePct: riskPct === null ? null : (riskPct / MAX_RISK_PCT) * 100,
    violations: g.violations,
    warnings: g.warnings,
    needsApproval: g.needsApproval,
  };
}

/** 把逐笔体检汇总成整轮体检（纯汇总，不再调用 guard） */
export function summarizeRiskBrief(checks: IntentCheck[]): RiskBrief {
  const list = checks ?? [];
  const blocked = list.filter((c) => !c.ok).length;
  const warned = list.filter((c) => c.ok && c.warnings.length > 0).length;
  const passed = list.length - blocked - warned;

  const levers = list.map((c) => c.impliedLeverage).filter((v): v is number => v !== null);
  const risks = list.map((c) => c.riskPct).filter((v): v is number => v !== null);
  const maxImpliedLeverage = levers.length ? Math.max(...levers) : null;
  const maxRiskPct = risks.length ? Math.max(...risks) : null;
  const approvalReasons = list.flatMap((c) => c.warnings);

  return {
    total: list.length,
    passed,
    warned,
    blocked,
    maxImpliedLeverage,
    maxRiskPct,
    needsApproval: approvalReasons.length > 0,
    approvalReasons,
    intents: list,
    summary: briefSummary(list.length, passed, warned, blocked, maxImpliedLeverage, maxRiskPct),
  };
}

/** 一行摘要：够短能进告警标题，够全能把预算用量说清 */
function briefSummary(
  total: number,
  passed: number,
  warned: number,
  blocked: number,
  maxLever: number | null,
  maxRisk: number | null
): string {
  if (!total) return "风控体检：本轮无仓位动作";
  const head = [`${total} 笔`, `通过 ${passed}`];
  if (warned) head.push(`提示 ${warned}`);
  if (blocked) head.push(`拦截 ${blocked}`);
  const budget: string[] = [];
  if (maxLever !== null) budget.push(`最大隐含杠杆 ${maxLever.toFixed(1)}x / 上限 ${MAX_LEVERAGE}x`);
  if (maxRisk !== null) budget.push(`单笔最大风险 ${showPct(maxRisk)} / 硬顶 ${showPct(MAX_RISK_PCT)}`);
  return `风控体检：${head.join(" · ")}${budget.length ? `（${budget.join("，")}）` : ""}`;
}

/** 便捷入口：一次性把整轮算完（不需要逐笔结果时用它） */
export function buildRiskBrief(
  intents: TradeIntent[] | undefined,
  snap: AccountSnapshot,
  refPriceOf: (inst: string) => number,
  knownInsts?: Set<string>
): RiskBrief {
  const checks = (intents ?? [])
    .filter(isTradable)
    .map((it) => checkIntent(it, snap, refPriceOf(it.inst), knownInsts));
  return summarizeRiskBrief(checks);
}
