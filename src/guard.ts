/**
 * guard.ts —— L1 硬约束守卫（不可裁量，代码层强制）
 *
 * 为什么单独一层而不是写进 prompt：
 *   LLM 可能幻觉、可能误读数据、可能给出离谱参数。
 *   把红线放进 prompt 是「请求它遵守」，放这里是「它没得选」。
 *   凡 L1 违反，一律拒绝执行 —— 无论 LLM 给出什么理由。
 *
 * 对应 AGENT_TRADING_RULES.md §1 的 L1 清单。
 */
import type { AccountSnapshot, Decision, GuardResult, TradeIntent } from "./types.js";

/** 合规标的（L1-1）：只允许 BTC/ETH 永续 */
export const ALLOWED_INSTS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP"] as const;

/** L1-2 杠杆硬顶 */
export const MAX_LEVERAGE = 5;
/** L1-5 单笔风险硬顶（占权益比例） */
export const MAX_RISK_PCT = 0.025;
/** 触发人工确认的风险阈值（用户设定：单笔 >2% 需确认） */
export const APPROVAL_RISK_PCT = 0.02;
/** 敞口软约束（L2，仅告警） */
export const SOFT_MAX_TOTAL_NOTIONAL_X = 5.0;

export interface GuardContext {
  account: AccountSnapshot;
  /** 当日已止损次数（用于熔断判断） */
  daySlCount: number;
  /** 月度回撤百分比（L1-6，≥12% 强制停开新仓） */
  monthDdPct: number;
  /** 当日回撤百分比（≥5% 触发） */
  dayDdPct: number;
}

/**
 * 校验一轮决策是否可执行。
 * 返回 violations 非空 → 整轮拒绝（不只是拒绝单笔）。
 */
export function guardDecision(d: Decision, ctx: GuardContext): GuardResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  let needsApproval = d.needsApproval;
  let approvalReason = d.approvalReason;

  const equity = ctx.account.equityUsdt;
  if (!Number.isFinite(equity) || equity <= 0) {
    violations.push("L1: 无法获取有效权益，拒绝一切交易");
    return { ok: false, violations, warnings, needsApproval, approvalReason };
  }

  // ---- L1-6 回撤熔断（不可裁量）----
  if (ctx.monthDdPct >= 12) {
    violations.push(`L1-6: 月度回撤 ${ctx.monthDdPct.toFixed(2)}% ≥12%，禁止开新仓`);
  }
  if (ctx.dayDdPct >= 5) {
    violations.push(`L1-6: 当日回撤 ${ctx.dayDdPct.toFixed(2)}% ≥5%，触发熔断`);
  }
  if (ctx.daySlCount >= 3) {
    violations.push(`L1-6: 当日止损已达 ${ctx.daySlCount} 次，禁止开新仓`);
  }

  // ---- 逐笔校验 ----
  let totalNotional = 0;
  for (const it of d.intents) {
    // L1-1 标的白名单
    if (!ALLOWED_INSTS.includes(it.inst as (typeof ALLOWED_INSTS)[number])) {
      violations.push(`L1-1: 非合规标的 ${it.inst}`);
      continue;
    }

    if (it.action === "hold") continue;

    // 平仓：总是允许（风控优先，平仓不需要理由门槛）
    if (it.action === "close") {
      const has = ctx.account.positions.some((p) => p.inst === it.inst);
      if (!has) warnings.push(`${it.inst}: 无持仓，close 指令忽略`);
      continue;
    }

    // ---- 开仓校验 ----
    // L1-9 禁双向持仓
    const dup = ctx.account.positions.find((p) => p.inst === it.inst);
    if (dup) {
      violations.push(`L1-9: ${it.inst} 已有持仓（${dup.side}），禁止同标的再开仓`);
      continue;
    }

    // L1-5 单笔风险硬顶
    const riskPct = it.riskPct ?? 0;
    if (!Number.isFinite(riskPct) || riskPct <= 0) {
      violations.push(`L1-5: ${it.inst} 未给出有效 riskPct`);
      continue;
    }
    if (riskPct > MAX_RISK_PCT) {
      violations.push(
        `L1-5: ${it.inst} 单笔风险 ${(riskPct * 100).toFixed(2)}% > 硬顶 ${(MAX_RISK_PCT * 100).toFixed(1)}%`
      );
      continue;
    }

    // 止损必须有（L1-4：每笔必带止损）
    if (!it.slDist || it.slDist <= 0) {
      violations.push(`L1-4: ${it.inst} 未提供止损距离 slDist，禁止开仓`);
      continue;
    }
    // 止损距离上限：≤2.5×ATR 由上层校验（需行情），此处仅防 0/负值
    // 盈亏比下限（L2，仅告警）
    if (it.tpRR !== undefined && it.tpRR < 1.6) {
      warnings.push(`${it.inst}: 盈亏比 ${it.tpRR} < 1.6（L2 基准，非硬约束）`);
    }

    // 计算名义敞口，累计用于总敞口检查
    const mark = ctx.account.positions.find((p) => p.inst === it.inst)?.mark ?? 0;
    if (mark > 0 && it.slDist > 0) {
      const notional = (equity * riskPct) / (it.slDist / mark);
      totalNotional += notional;
    }

    // 大额人工确认（用户设定：单笔 >2%）
    if (riskPct > APPROVAL_RISK_PCT) {
      needsApproval = true;
      approvalReason = `${it.inst} 单笔风险 ${(riskPct * 100).toFixed(2)}% > ${(APPROVAL_RISK_PCT * 100).toFixed(0)}%，需人工确认`;
    }

    // 理由与偏离留痕（§0.3：偏离必须五项齐全）
    if (!it.reason || it.reason.trim().length < 5) {
      violations.push(`${it.inst}: 未提供决策理由，拒绝`);
    }
    for (const dev of it.deviations ?? []) {
      const missing = ["baseline", "actual", "rationale", "falsifier", "riskDelta"].filter(
        (k) => !String((dev as Record<string, unknown>)[k] ?? "").trim()
      );
      if (missing.length) {
        violations.push(`§0.3: ${it.inst} 偏离记录缺字段 ${missing.join(",")}`);
      }
    }
  }

  // 总敞口（L2 软约束，仅告警）
  if (totalNotional > equity * SOFT_MAX_TOTAL_NOTIONAL_X) {
    warnings.push(
      `总名义敞口 ${totalNotional.toFixed(0)} USDT = ${(totalNotional / equity).toFixed(2)}x 权益，超过 ${SOFT_MAX_TOTAL_NOTIONAL_X}x 软约束`
    );
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    needsApproval,
    approvalReason,
  };
}

/**
 * 校验杠杆（L1-2）。在设杠杆前调用。
 */
export function guardLeverage(lever: number): GuardResult {
  const violations: string[] = [];
  if (!Number.isFinite(lever) || lever <= 0) {
    violations.push(`L1-2: 杠杆值无效 ${lever}`);
  } else if (lever > MAX_LEVERAGE) {
    violations.push(`L1-2: 杠杆 ${lever}x > 硬顶 ${MAX_LEVERAGE}x`);
  }
  return { ok: violations.length === 0, violations, warnings: [], needsApproval: false };
}

/**
 * 校验 clOrdId 格式（L1-8）。
 * OKX 规范：^[A-Za-z][A-Za-z0-9]{0,31}$，禁下划线与连字符。
 */
export function guardClOrdId(id: string): GuardResult {
  const violations: string[] = [];
  const ok = /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(id);
  if (!ok) {
    violations.push(
      `L1-8: clOrdId "${id}" 不合规范（须字母开头、仅字母数字、≤32 位、禁 _ 与 -）`
    );
  }
  return { ok, violations, warnings: [], needsApproval: false };
}
