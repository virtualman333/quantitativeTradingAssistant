/**
 * guard.ts —— L1 硬约束运行时校验（风控硬拦截，非提示词）
 *
 * 背景：types.ts 早已声明 GuardResult（「LLM 意图必须过 Guard，不合规直接拒绝」），
 * 但此前一直没实现，执行链直接信任 LLM 输出就下单。本模块把 L1 中可代码化的
 * 约束固化成硬校验：
 *   L1-1 仅 BTC/ETH 永续
 *   L1-2 杠杆 ≤5x
 *   L1-4 止损必挂
 *   L1-5 单笔风险 ≤2.5%
 *   L1-7 偏离留痕五项齐全
 *   L1-9 禁双向
 *   L1-10 禁亏损加仓
 * 其余 L1 在别处兜底：L1-3（live 只读）在 okx.ts，L1-8（clOrdId 幂等）在 genClOrdId，
 * L1-6（月度回撤熔断）在 main.ts 执行前。
 */
import type { AccountSnapshot, GuardResult, TradeIntent } from "./types.js";

const ALLOWED_INSTS = new Set(["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
const MAX_RISK_PCT = 0.025;      // L1-5 单笔风险 ≤2.5%
const APPROVAL_RISK_PCT = 0.02;  // 超过 2% 需人工确认（L2 基准）
const MAX_LEVERAGE = 5;          // L1-2 杠杆 ≤5x
const DEVIATION_FIELDS = ["baseline", "actual", "rationale", "falsifier", "riskDelta"] as const;

/**
 * 校验单个交易意图。
 * @param refPrice 当前参考价（现价），用于反推隐含杠杆；0 表示未知则跳过杠杆校验。
 */
export function guardIntent(it: TradeIntent, snap: AccountSnapshot, refPrice = 0): GuardResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  // L1-1 仅 BTC/ETH 永续
  if (!ALLOWED_INSTS.has(it.inst)) {
    violations.push(`L1-1 标的「${it.inst}」不在白名单（仅 BTC-USDT-SWAP / ETH-USDT-SWAP）`);
  }

  // 理由必填
  if (!it.reason || !String(it.reason).trim()) {
    violations.push(`${it.inst} 缺少决策理由`);
  }

  const opening = it.action === "long" || it.action === "short";
  const pos = snap.positions.find((p) => p.inst === it.inst);

  if (opening) {
    // L1-4 止损必挂
    if (!it.slDist || it.slDist <= 0) {
      violations.push(`L1-4 ${it.inst} 开仓未提供有效止损距离 slDist`);
    }

    // L1-5 单笔风险 ≤2.5%
    const rp = Number(it.riskPct ?? 0);
    if (!(rp > 0)) {
      violations.push(`L1-5 ${it.inst} 开仓缺少 riskPct`);
    } else if (rp > MAX_RISK_PCT) {
      violations.push(`L1-5 ${it.inst} 单笔风险 ${(rp * 100).toFixed(2)}% 超过 2.5%`);
    } else if (rp > APPROVAL_RISK_PCT) {
      warnings.push(`${it.inst} 风险 ${(rp * 100).toFixed(2)}% > 2%，需人工确认`);
    }

    // L1-2 杠杆 ≤5（有现价时反推：lever = riskPct / (slDist / refPrice)）
    if (refPrice > 0 && it.slDist && it.slDist > 0 && rp > 0) {
      const lever = rp / (it.slDist / refPrice);
      if (lever > MAX_LEVERAGE) {
        violations.push(`L1-2 ${it.inst} 隐含杠杆 ${lever.toFixed(1)}x 超过 5x`);
      }
    }

    // L1-9 禁双向、L1-10 禁亏损加仓
    if (pos) {
      const sameDir =
        (it.action === "long" && pos.side === "long") ||
        (it.action === "short" && pos.side === "short");
      if (!sameDir) {
        violations.push(`L1-9 ${it.inst} 已有 ${pos.side} 持仓，禁止反向开仓`);
      } else if ((pos.upl ?? 0) < 0) {
        violations.push(`L1-10 ${it.inst} 持仓浮亏 ${Number(pos.upl).toFixed(2)}，禁止同向加仓`);
      }
    }
  }

  // L1-7 偏离留痕：有 deviations 就必须五项齐全
  if (Array.isArray(it.deviations) && it.deviations.length) {
    for (const d of it.deviations) {
      const missing = DEVIATION_FIELDS.filter((k) => !d[k] || !String(d[k]).trim());
      if (missing.length) {
        violations.push(`L1-7 ${it.inst} 偏离记录缺字段：${missing.join("、")}`);
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    needsApproval: warnings.length > 0,
    approvalReason: warnings.length ? warnings.join("；") : undefined,
  };
}

/** 批量校验整个决策的所有意图（保持顺序） */
export function guardDecision(
  intents: TradeIntent[],
  snap: AccountSnapshot,
  refPriceOf: (inst: string) => number
): GuardResult[] {
  return (intents ?? []).map((it) => guardIntent(it, snap, refPriceOf(it.inst)));
}
