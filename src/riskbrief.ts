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
 *   - exposure：**当前持仓连起来看**的敞口体检（章程 §5 的三条 L2 软上限）
 *
 * 口径单一来源：隐含杠杆、两道硬顶、以及三条 L2 敞口软上限的常量都从
 * guard.ts 取，不在这里重写公式、也不在这里重写限值。
 */
import { guardIntent, impliedLeverage, MAX_LEVERAGE, MAX_RISK_PCT,
         SOFT_MAX_NOTIONAL_X, SOFT_MAX_TOTAL_X, MAX_CONCURRENT_INSTS } from "./guard.js";
import type { AccountSnapshot, Position, TradeIntent } from "./types.js";

/** 合约规格里本模块只需要「每张面值」（主 Agent 的 InstSpec 是它的超集） */
export interface CtValSource {
  ctVal: number;
}

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
  /** 当前持仓的敞口体检（L2 软约束，见 checkExposure） */
  exposure: ExposureCheck;
  summary: string;
}

const showPct = (v: number): string => `${(v * 100).toFixed(2)}%`;

// ── 敞口体检（章程 §5「敞口上限」表的三条 L2 建议）────────────────────────
//
// 为什么单列一块：逐笔体检回答的是「这一笔会不会越线」，而 L2 敞口约束问的是
// **连起来看会不会越线** —— 单笔各自合规、三笔同向叠加起来照样能到 6× 权益。
// 这三条此前只在 `scripts/trade_round.py` 里躺着（`SOFT_MAX_*`），没有任何读取方，
// 那句注释「L2 软约束，仅告警」里的告警从来不存在；界面（DashboardView）却把
// 「敞口上限 单标的 ≤3.0× 权益，总敞口 ≤5.0× 权益」当生效规则展示给用户看。
//
// 口径：名义敞口 = |张数| × 每张面值(ctVal) × 标记价。ctVal 由 market_scan.py
// 每轮从交易所动态取得，**任何一环缺失就报「算不出」，绝不折成 0** ——
// 敞口算成 0 与「完全没有持仓」长得一模一样，那才是真正会让人亏钱的静默。

/** 单标的敞口 */
export interface InstExposure {
  inst: string;
  /** 名义敞口（USDT）；缺规格/缺标记价时为 null */
  notionalUsdt: number | null;
  /** 名义敞口 ÷ 权益 */
  x: number | null;
  /** 占单标的软上限的百分比（>100 即超） */
  usagePct: number | null;
}

/** 当前持仓的敞口体检 */
export interface ExposureCheck {
  equityUsdt: number | null;
  /** 持仓标的数（去重） */
  insts: number;
  /** 名义值算不出来的标的（缺 ctVal 或标记价）—— 必须点名，不许静默当成 0 */
  unpriced: string[];
  perInst: InstExposure[];
  /** 已定价部分的名义合计；存在 unpriced 时是**下界**（partial=true） */
  totalUsdt: number | null;
  totalX: number | null;
  /** 占「总敞口 ≤5× 权益」软上限的百分比 */
  totalUsagePct: number | null;
  /** 占「同时持仓 ≤5 个标的」软上限的百分比 */
  instUsagePct: number | null;
  /** totalX 只覆盖了部分持仓（有 unpriced） */
  partial: boolean;
  overInsts: string[];
  overTotal: boolean;
  overCount: boolean;
  warnings: string[];
}

/** 有限数守卫：null / undefined / 空串 / 非有限数 → null（`Number("")` 是 0，必须显式挡） */
function fin(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 敞口体检：把当前持仓按 L2 三条软上限过一遍。
 *
 * `specOf(inst)` 缺省时返回 null → 该标的进 unpriced（算不出来就报算不出来）。
 */
export function checkExposure(
  positions: Position[] | undefined,
  equityUsdt: unknown,
  specOf?: (inst: string) => CtValSource | null
): ExposureCheck {
  const list = (positions ?? []).filter((p) => !!p && typeof p.inst === "string" && p.inst);
  const equity = fin(equityUsdt);
  const seen = new Set<string>();
  const perInst: InstExposure[] = [];
  const unpriced: string[] = [];
  let total = 0;
  let anyPriced = false;

  for (const p of list) {
    if (seen.has(p.inst)) continue; // 同一标的的多空分仓（net 模式不该出现，出现也只算一次）
    seen.add(p.inst);
    const size = Math.abs(fin(p.sizeContracts) ?? 0);
    const spec = specOf ? specOf(p.inst) : null;
    const ctVal = fin(spec?.ctVal);
    const mark = fin(p.mark);
    if (size === 0) {
      // 张数为 0 的持仓不占敞口，但它是**算出来的 0**，不是「算不出来」
      perInst.push({ inst: p.inst, notionalUsdt: 0, x: equity && equity > 0 ? 0 : null, usagePct: 0 });
      continue;
    }
    if (!(ctVal && ctVal > 0) || !(mark && mark > 0)) {
      unpriced.push(p.inst);
      perInst.push({ inst: p.inst, notionalUsdt: null, x: null, usagePct: null });
      continue;
    }
    const notional = size * ctVal * mark;
    const x = equity && equity > 0 ? notional / equity : null;
    perInst.push({
      inst: p.inst,
      notionalUsdt: notional,
      x,
      usagePct: x === null ? null : (x / SOFT_MAX_NOTIONAL_X) * 100,
    });
    total += notional;
    anyPriced = true;
  }

  const insts = seen.size;
  const totalUsdt = anyPriced ? total : null;
  const totalX = totalUsdt !== null && equity && equity > 0 ? totalUsdt / equity : null;
  const overInsts = perInst.filter((e) => e.x !== null && e.x > SOFT_MAX_NOTIONAL_X).map((e) => e.inst);

  const warnings: string[] = [];
  for (const e of perInst) {
    if (e.x !== null && e.x > SOFT_MAX_NOTIONAL_X) {
      warnings.push(
        `敞口超限(L2)：${e.inst} 名义敞口 ${e.x.toFixed(2)}× 权益 > 单标的软上限 ${SOFT_MAX_NOTIONAL_X}×`
      );
    }
  }
  if (totalX !== null && totalX > SOFT_MAX_TOTAL_X) {
    warnings.push(
      `敞口超限(L2)：总名义敞口 ${totalX.toFixed(2)}× 权益 > 总敞口软上限 ${SOFT_MAX_TOTAL_X}×` +
        (unpriced.length ? `（另有 ${unpriced.length} 个标的未计入，实际更高）` : "")
    );
  }
  if (insts > MAX_CONCURRENT_INSTS) {
    warnings.push(`敞口超限(L2)：同时持仓 ${insts} 个标的 > 软上限 ${MAX_CONCURRENT_INSTS} 个`);
  }
  if (unpriced.length) {
    warnings.push(
      `敞口无法计算：${unpriced.join(" / ")} 缺合约规格(ctVal)或标记价 —— ` +
        `这几个标的的敞口未计入，上表显示的是已定价部分的下界，不要当成「没有敞口」`
    );
  }

  return {
    equityUsdt: equity,
    insts,
    unpriced,
    perInst,
    totalUsdt,
    totalX,
    totalUsagePct: totalX === null ? null : (totalX / SOFT_MAX_TOTAL_X) * 100,
    instUsagePct: insts === 0 ? 0 : (insts / MAX_CONCURRENT_INSTS) * 100,
    partial: unpriced.length > 0,
    overInsts,
    overTotal: totalX !== null && totalX > SOFT_MAX_TOTAL_X,
    overCount: insts > MAX_CONCURRENT_INSTS,
    warnings,
  };
}

/** 敞口那半句摘要（空持仓也说清是「无持仓」而不是留白） */
export function exposureLine(e: ExposureCheck | null | undefined): string {
  if (!e || !e.perInst.length) return "无持仓（敞口 0）";
  const bits: string[] = [];
  bits.push(
    e.totalX === null
      ? "总名义敞口 算不出"
      : `总名义敞口 ${e.totalX.toFixed(2)}× 权益 / 软上限 ${SOFT_MAX_TOTAL_X}×`
  );
  bits.push(`持仓 ${e.insts} 个标的 / 软上限 ${MAX_CONCURRENT_INSTS} 个`);
  if (e.partial) bits.push(`其中 ${e.unpriced.length} 个算不出（未计入）`);
  return bits.join("，");
}

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
export function summarizeRiskBrief(
  checks: IntentCheck[],
  exposure?: ExposureCheck | null
): RiskBrief {
  const list = checks ?? [];
  const blocked = list.filter((c) => !c.ok).length;
  const warned = list.filter((c) => c.ok && c.warnings.length > 0).length;
  const passed = list.length - blocked - warned;

  const levers = list.map((c) => c.impliedLeverage).filter((v): v is number => v !== null);
  const risks = list.map((c) => c.riskPct).filter((v): v is number => v !== null);
  const maxImpliedLeverage = levers.length ? Math.max(...levers) : null;
  const maxRiskPct = risks.length ? Math.max(...risks) : null;
  const approvalReasons = list.flatMap((c) => c.warnings);
  const exp = exposure ?? emptyExposure();

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
    exposure: exp,
    summary: briefSummary(list.length, passed, warned, blocked, maxImpliedLeverage, maxRiskPct, exp),
  };
}

/** 没有持仓数据时的空敞口结果（界面与摘要都按「无持仓」说，不留白） */
export function emptyExposure(): ExposureCheck {
  return {
    equityUsdt: null,
    insts: 0,
    unpriced: [],
    perInst: [],
    totalUsdt: null,
    totalX: null,
    totalUsagePct: null,
    instUsagePct: 0,
    partial: false,
    overInsts: [],
    overTotal: false,
    overCount: false,
    warnings: [],
  };
}

/** 一行摘要：够短能进告警标题，够全能把预算用量说清 */
function briefSummary(
  total: number,
  passed: number,
  warned: number,
  blocked: number,
  maxLever: number | null,
  maxRisk: number | null,
  exposure?: ExposureCheck | null
): string {
  const exp = exposureLine(exposure);
  if (!total) return `风控体检：本轮无仓位动作（${exp}）`;
  const head = [`${total} 笔`, `通过 ${passed}`];
  if (warned) head.push(`提示 ${warned}`);
  if (blocked) head.push(`拦截 ${blocked}`);
  const budget: string[] = [];
  if (maxLever !== null) budget.push(`最大隐含杠杆 ${maxLever.toFixed(1)}x / 上限 ${MAX_LEVERAGE}x`);
  if (maxRisk !== null) budget.push(`单笔最大风险 ${showPct(maxRisk)} / 硬顶 ${showPct(MAX_RISK_PCT)}`);
  if (exp) budget.push(exp);
  return `风控体检：${head.join(" · ")}${budget.length ? `（${budget.join("，")}）` : ""}`;
}

/** 便捷入口：一次性把整轮算完（不需要逐笔结果时用它） */
export function buildRiskBrief(
  intents: TradeIntent[] | undefined,
  snap: AccountSnapshot,
  refPriceOf: (inst: string) => number,
  knownInsts?: Set<string>,
  specOf?: (inst: string) => CtValSource | null
): RiskBrief {
  const checks = (intents ?? [])
    .filter(isTradable)
    .map((it) => checkIntent(it, snap, refPriceOf(it.inst), knownInsts));
  return summarizeRiskBrief(checks, checkExposure(snap?.positions, snap?.equityUsdt, specOf));
}
