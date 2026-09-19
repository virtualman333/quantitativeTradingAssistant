/**
 * guard.ts —— L1 硬约束运行时校验（风控硬拦截，非提示词）
 *
 * 背景：types.ts 早已声明 GuardResult（「LLM 意图必须过 Guard，不合规直接拒绝」），
 * 但此前一直没实现，执行链直接信任 LLM 输出就下单。本模块把 L1 中可代码化的
 * 约束固化成硬校验：
 *   L1-1 仅 USDT 永续（交易所支持的任意标的，不再限 BTC/ETH）
 *   L1-2 杠杆 ≤5x
 *   L1-4 止损必挂（另半句「挂不上就重试、重试无效立即市价平仓」在 `stopprotect.ts`
 *        与 `scalper.ensureStopProtection()` —— 它不是「意图校验」，是执行侧动作）
 *   L1-5 单笔风险 ≤2.5%
 *   L1-6 月度回撤 ≥12% 熔断（停止开新仓）
 *   L1-7 偏离留痕五项齐全
 *   L1-9 禁双向
 *   L1-10 禁亏损加仓
 * 其余 L1 在别处兜底：L1-3（live 只读）在 okx.ts，L1-8（clOrdId 幂等）在 genClOrdId。
 *
 * 两条下单路径都要过闸门：
 *   - 主 Agent 路径：main.ts → riskbrief.checkIntent() → guardIntent()（按订单意图校验）
 *                      + guardMonthlyDrawdown()（按运行态熔断）
 *   - 超短线路径：scalper.ts → guardScalperConfig()（按用户配置的参数校验，无订单意图）
 *                      + guardMonthlyDrawdown()（同一份运行态熔断）
 */
import type { AccountSnapshot, GuardResult, TradeIntent } from "./types.js";

/**
 * L1-1 标的须为 USDT 计价（任意币种）。
 * 不写死交易所命名格式（OKX=XXX-USDT-SWAP，币安/Bybit=XXXUSDT）——
 * 「是否本所真实存在的 USDT 永续」由 knownInsts 白名单（本轮行情/合约规格）兜底，
 * 格式语义的归一化属于模型职责，不硬编码进脚本。
 */
const USDT_RE = /USDT/i;
export const MAX_RISK_PCT = 0.025;      // L1-5 单笔风险 ≤2.5%
export const APPROVAL_RISK_PCT = 0.02;  // 超过 2% 需人工确认（L2 基准）
export const MAX_LEVERAGE = 5;          // L1-2 杠杆 ≤5x
/** L1-6 月度回撤熔断线（%）。负数=回撤；达到或低于即熔断。 */
export const MAX_MONTH_DD_PCT = -12;

/**
 * 由「风险比例 + 止损距离 + 现价」反推隐含杠杆（口径即 L1-2）：
 *   名义仓位占权益 = 风险比例 ÷ (止损距离 ÷ 现价)
 * 三个参数任一非正时返回 null —— 缺数据就不要猜。
 *
 * 单独抽出来是为了让每轮体检摘要（riskbrief.ts）与硬校验共用同一份口径：
 * 同一个公式写两遍，早晚会漂。
 */
export function impliedLeverage(riskPct: number, slDist: number, refPrice: number): number | null {
  if (!(refPrice > 0) || !(slDist > 0) || !(riskPct > 0)) return null;
  return riskPct / (slDist / refPrice);
}
/**
 * 超短线（scalper）路径的 L1 参数闸门。
 *
 * 为什么需要一个独立的函数：`guardIntent()` 校验的是**订单意图** —— 风险比例、止损距离、
 * 由三者反推的隐含杠杆；而超短线下单参数是**用户在界面上直接配置**的
 * （`ScalperConfig.leverage` / `riskPct`），没有 LLM 意图可校验。
 * 这条路径此前一个 L1 检查都没有：界面提供 10x 选项（提示语自己都写着「>5x 超过章程 L1-2 上限」），
 * `riskPct` 允许填到 10%（L1-5 硬顶是 2.5%），而 `scalper.ts` 只把杠杆 clamp 到 20。
 * 结果就是章程「触碰 L1 → 一律不执行」在**第二条会下真单的路径**上等于不存在。
 *
 * 上限一律取自本模块的 `MAX_LEVERAGE` / `MAX_RISK_PCT` —— 与 `guardIntent` 共用同一份常量，
 * 不在这里重新写 5 / 2.5%。
 */
export function guardScalperConfig(cfg: { leverage?: unknown; riskPct?: unknown }): GuardResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  // L1-2 杠杆设定 ≤5x（章程原文：`swap_set_leverage` 设定值不得 > 5）
  const lev = Number(cfg?.leverage);
  if (!Number.isFinite(lev) || lev < 1) {
    violations.push(`L1-2 杠杆设定「${String(cfg?.leverage ?? "")}」无效（须为 ≥1 的数）`);
  } else if (lev > MAX_LEVERAGE) {
    violations.push(`L1-2 杠杆设定 ${lev}x 超过 ${MAX_LEVERAGE}x 上限`);
  }

  // L1-5 单笔风险硬顶 ≤2.5%
  const rp = Number(cfg?.riskPct);
  if (!Number.isFinite(rp) || rp <= 0) {
    violations.push(`L1-5 单笔风险比例「${String(cfg?.riskPct ?? "")}」无效（须为 >0 的数）`);
  } else if (rp > MAX_RISK_PCT) {
    violations.push(`L1-5 单笔风险 ${(rp * 100).toFixed(2)}% 超过 ${MAX_RISK_PCT * 100}% 硬顶`);
  } else if (rp > APPROVAL_RISK_PCT) {
    warnings.push(`单笔风险 ${(rp * 100).toFixed(2)}% > ${APPROVAL_RISK_PCT * 100}%，需人工确认（L2）`);
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    needsApproval: warnings.length > 0,
    approvalReason: warnings.length ? warnings.join("；") : undefined,
  };
}

const DEVIATION_FIELDS = ["baseline", "actual", "rationale", "falsifier", "riskDelta"] as const;

/**
 * 章程 L1-6：月度回撤达到熔断线 → 「强制停止开新仓」（仅允许管理既有持仓）。
 *
 * 为什么放在这里、而不是各条路径各判一次：
 * 这条此前**主路径写了、超短线路径一条都没有**，而且主路径读的判据字段
 * （`state/runtime.json` 的 `month_dd_pct`）**全仓没有任何脚本写过** ——
 * `j.month_dd_pct ?? 0` 恒为 0，`0 <= -12` 永假，于是这条 L1 自建立起从未触发。
 * 现在：month_risk.py 算 → archive_round.py 每轮落盘 → 两条路径都调本函数。
 *
 * 判据是**回撤本身**（相对当月权益峰值），与「本月是否盈利」无关。
 *
 * @param monthDdPct 月度回撤（%，负数），来自 runtime.json；缺字段时传 null/undefined。
 */
export function guardMonthlyDrawdown(monthDdPct: unknown): GuardResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  const raw = monthDdPct === null || monthDdPct === undefined || monthDdPct === "" ? Number.NaN : Number(monthDdPct);
  if (!Number.isFinite(raw)) {
    // 拿不到数不等于「没有回撤」，但也不该凭一个缺失字段停掉交易（L1-4 止损、L1-5 硬顶
    // 仍各自独立生效）。处理方式是**点名**而不是静默当 0 —— 每轮日志与风控体检都会看到。
    warnings.push(
      `L1-6 月度回撤未知（state/runtime.json 无 month_dd_pct），本轮无法确认熔断状态`
    );
  } else if (raw <= MAX_MONTH_DD_PCT) {
    violations.push(`L1-6 月度回撤 ${raw.toFixed(2)}% 达到 ${MAX_MONTH_DD_PCT}% 熔断线，强制停止开新仓`);
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    needsApproval: false,
  };
}

/**
 * 校验单个交易意图。
 * @param refPrice 当前参考价（现价），用于反推隐含杠杆；0 表示未知则跳过杠杆校验。
 * @param knownInsts 本轮行情/合约规格中确认存在且 state=live 的标的集合；传入则额外校验标的在集合内。
 */
export function guardIntent(
  it: TradeIntent,
  snap: AccountSnapshot,
  refPrice = 0,
  knownInsts?: Set<string>
): GuardResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  // L1-1 仅 USDT 计价（任意标的，不再限 BTC/ETH）。
  // 本质约束 = USDT 计价；「是否本所真实标的」交给 knownInsts 白名单（本轮行情/合约规格）。
  // 脚本不替模型判定交易所命名格式。
  const instStr = String(it.inst ?? "").trim();
  if (!instStr) {
    violations.push(`L1-1 标的为空`);
  } else if (!USDT_RE.test(instStr)) {
    violations.push(`L1-1 标的「${it.inst}」非 USDT 计价`);
  }
  if (instStr && knownInsts && knownInsts.size && !knownInsts.has(instStr)) {
    violations.push(`L1-1 标的「${it.inst}」不在本轮行情候选池/合约规格中`);
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

    // L1-2 杠杆 ≤5（有现价时反推，口径见 impliedLeverage）
    const lever = impliedLeverage(rp, Number(it.slDist), refPrice);
    if (lever !== null && lever > MAX_LEVERAGE) {
      violations.push(`L1-2 ${it.inst} 隐含杠杆 ${lever.toFixed(1)}x 超过 5x`);
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
  refPriceOf: (inst: string) => number,
  knownInsts?: Set<string>
): GuardResult[] {
  return (intents ?? []).map((it) => guardIntent(it, snap, refPriceOf(it.inst), knownInsts));
}
