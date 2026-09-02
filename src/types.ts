/**
 * 类型定义 —— 决策契约
 *
 * 设计原则：LLM 只能输出「结构化意图」，不能输出「可执行动作」。
 * 所有意图都要过 Guard（L1 硬约束）校验，不合规直接拒绝，
 * 而不是指望 LLM 自觉遵守章程。
 */

export type Direction = "long" | "short" | "hold" | "close";
export type RiskTier = "BASE" | "AGG" | "DEF";

/** LLM 输出的单标的决策意图 */
export interface TradeIntent {
  inst: string;              // BTC-USDT-SWAP / ETH-USDT-SWAP
  action: Direction;         // hold=不动, close=平仓, long/short=开仓
  riskPct?: number;          // 本笔风险占权益比例（如 0.012 = 1.2%）
  slDist?: number;           // 止损距离（价格单位）
  tpRR?: number;             // 止盈盈亏比（如 2.0 = 2R）
  reason: string;            // 必须给理由，不许空
  deviations?: Deviation[];  // §0.3 裁量偏离留痕
}

/** §0.3 裁量偏离记录（五项必填） */
export interface Deviation {
  baseline: string;    // 偏离了哪条基准
  actual: string;      // 实测值
  rationale: string;   // 为什么本轮仍值得如此决策
  falsifier: string;   // 可证伪预判（最关键）
  riskDelta: string;   // 多承担/放弃多少风险
}

/** 一轮完整决策输出 */
export interface Decision {
  roundId: string;
  decision: "OPEN" | "HOLD" | "CLOSE" | "STANDBY";
  intents: TradeIntent[];
  summary: string;          // 人读决策摘要
  riskTier: RiskTier;
  needsApproval: boolean;   // 大额/异常 → 需人工确认
  approvalReason?: string;
  rawText?: string;         // LLM 原始输出（审计用）
}

/** 账户快照 */
export interface AccountSnapshot {
  equityUsdt: number;
  availableUsdt: number;
  positions: Position[];
  algoOrders: AlgoOrder[];
}

export interface Position {
  inst: string;
  side: "long" | "short";
  sizeContracts: number;
  entry: number;
  mark: number;
  leverage: number;
  upl: number;
  tp?: string | null;
  sl?: string | null;
}

export interface AlgoOrder {
  inst: string;
  algoId: string;
  tpTrigger?: string | null;
  slTrigger?: string | null;
  state?: string;
}

/** 行情数据（由 market_scan.py 产出） */
export interface MarketData {
  scanTimeCst: string;
  instruments: Record<string, InstrumentSnapshot>;
  raw?: unknown;
}

export interface InstrumentSnapshot {
  confluence?: { score: number; perBar: Record<string, number> };
  bars?: Record<string, BarData>;
  funding?: { rate: number; nextTime: string };
}

export interface BarData {
  close: number;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  rsi14?: number;
  atr14?: number;
  volRatio?: number;
  trend?: string;
  macd?: { hist: number; cross?: string };
}

/** Guard 校验结果 */
export interface GuardResult {
  ok: boolean;
  violations: string[];   // 违反的 L1 条目
  warnings: string[];     // L2 软约束提示（不阻断）
  needsApproval: boolean;
  approvalReason?: string;
}
