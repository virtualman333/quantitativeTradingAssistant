/**
 * scalper.ts — 超短线（超高频）交易引擎（独立于主轮次）
 *
 * 与主轮次（5 分钟 LangGraph 多专家决策）完全解耦：本模块只负责「开单」——
 * 拉 1m 线信号（scalper.py 用最近 5 根 1m 收盘价斜率判趋势 + 凯利公式推止盈止损 + 手续费），
 * 市价开单后**同轮挂 OCO 止损止盈**（L1-4：每单必挂止损止盈）。
 *
 * 可选 LLM 介入（cfg.useLlm）：趋势方向交给 LLM 判断（喂最近 60 根 1m 收盘价，
 * 提示词明确要求用最近 5 根 1m 收盘价的斜率判趋势），
 * 止盈止损仍由凯利公式 + ATR 计算。false 时用规则（5 根 1m 斜率）判向。
 *
 * 独立循环由 main.ts 里单独的定时器驱动；开单记录追加到 data/scalper_trades.jsonl。
 */
import fs from "node:fs";
import path from "node:path";
import { runPy, fetchAccount, placeOrder, placeOco, genClOrdId, setLeverage, confirmAlgo, mcpCall, closePosition, cancelAlgoOrders, unwrap } from "./okx.js";
import { DEFAULT_SCALPER, resolveModel, AGENT_ROOT, type ScalperConfig } from "./store.js";
import { createProvider } from "./llm.js";
import { strategyDir } from "./strategies.js";

export interface ScalperSignal {
  inst: string;
  direction: "long" | "short" | "flat";
  strength: string;
  reason?: string;
  strategy?: string;
  entry_ref: number;
  sl: number;
  tp: number;
  atr: number;
  atr_pct: number;
  rr: number;
  win_rate: number;
  kelly_f: number;
  fee_rate: number;
  fee_pct: number;
  sl_dist_pct: number;
  tp_dist_pct: number;
  net_tp_pct: number;
  net_sl_pct: number;
  spec: { ctVal: number; lotSz: number; minSz: number; tickSz: number };
  closes?: number[];
  sl_dist?: number;
  tp_dist?: number;
  bars: number;
  ts: string;
  /** 策略直接给 sl/tp 点位但被回退时（方向/间距不合法）的中文说明 */
  stop_note?: string;
  error?: string;
}

export interface ScalpResult {
  ok: boolean;
  msg: string;
  signal?: ScalperSignal;
}

export interface ScalperTrade {
  ts: string;
  inst: string;
  direction: string;
  entry: number;
  sl: number;
  tp: number;
  size: number;
  leverage: number;
  rr: number;
  ctVal: number;
  judge: "rule" | "llm";
  status: "open" | "closed";
  closePrice?: number;
  pnl?: number;
  feeRate: number;   // 单边 taker 费率
  notional: number;  // 名义金额（USDT）
  margin: number;    // 保证金（USDT）
  fee: number;       // 预估双边手续费（USDT）
  netPnl?: number;   // 净盈亏（已扣手续费）
}

export interface ScalperTick {
  ts: string;
  inst: string;
  direction?: string;
  strength?: string;
  entry_ref?: number;
  judge?: "rule" | "llm";
  strategy?: string;
  result: "opened" | "skipped" | "error";
  reason: string;
}

export interface ScalperOverview {
  trades: ScalperTrade[];
  ticks: ScalperTick[];
  positions: Record<string, unknown>[];
  realizedPnl: number;
  realizedNetPnl: number;
  totalFee: number;
  unrealizedPnl: number;
}

const SCALPER_LOG = path.join(AGENT_ROOT, "data", "scalper_trades.jsonl");
const SCALPER_TICK_LOG = path.join(AGENT_ROOT, "data", "scalper_ticks.jsonl");

/** 调 scalper.py 拿 1m 线信号（不开单）。cfg.strategyId 非空时走自定义策略判向。 */
export async function fetchSignal(cfg: ScalperConfig): Promise<ScalperSignal> {
  const argv = ["--inst", cfg.inst, "--atr-mult", String(cfg.atrMult), "--fee-rate", String(cfg.feeRate)];
  if (cfg.strategyId) argv.push("--strategy", strategyDir(cfg.strategyId));
  const out = await runPy("scalper.py", argv, 60_000);
  try {
    return JSON.parse(out) as ScalperSignal;
  } catch {
    return { error: `scalper.py 输出非 JSON: ${out.slice(0, 200)}` } as ScalperSignal;
  }
}

/** 价格按 tickSz 取整（避免科学计数法） */
function fmtTick(px: number, tickSz: number): string {
  const decimals = Math.max(0, Math.min(8, Math.round(-Math.log10(tickSz))));
  const snapped = Math.round(px / tickSz) * tickSz;
  return snapped.toFixed(decimals);
}

/** 持仓方向：兼容 posSide=long/short 与 net 模式（pos 正负） */
function positionSide(p: Record<string, unknown>): "long" | "short" | null {
  const ps = String(p.posSide ?? "");
  if (ps === "long") return "long";
  if (ps === "short") return "short";
  const pos = Number(p.pos ?? 0);
  if (pos > 0) return "long";
  if (pos < 0) return "short";
  return null;
}

/** LLM 判向：喂最近 60 根 1m 收盘价，返回 long/short，失败返回 null（回退规则方向） */
async function llmDirection(closes: number[]): Promise<"long" | "short" | null> {
  try {
    const cfg = resolveModel();
    if (!cfg || cfg.provider === "mock") return null;
    const llm = createProvider(cfg);
    const sys =
      `You are a short-term trend judge for crypto perpetual scalping. You are given recent 1-minute (1m) closing prices. ` +
      `Judge the trend direction by the SLOPE of the last 5 one-minute closes (rising line → long, falling line → short). ` +
      `Do not use fewer than 5 candles. Output JSON only: {"direction":"long"|"short","reason":"one short sentence"}`;
    const user = `Recent 1m closes (oldest → newest): [${closes.join(", ")}]`;
    const raw = await llm.decide(sys, user);
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw) as { direction?: string };
    return j.direction === "short" ? "short" : j.direction === "long" ? "long" : null;
  } catch {
    return null;
  }
}

// ── 开单记录（只追加 data/scalper_trades.jsonl） ─────────────
function appendTrade(t: ScalperTrade): void {
  try {
    fs.mkdirSync(path.dirname(SCALPER_LOG), { recursive: true });
    fs.appendFileSync(SCALPER_LOG, JSON.stringify(t) + "\n", "utf8");
  } catch {
    /* 记录失败不影响开单 */
  }
}

/** 循环监测记录（每次 tick 一条，含跳过/失败原因） */
function appendTick(t: ScalperTick): void {
  try {
    fs.mkdirSync(path.dirname(SCALPER_TICK_LOG), { recursive: true });
    fs.appendFileSync(SCALPER_TICK_LOG, JSON.stringify(t) + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

function readTicks(limit = 200): ScalperTick[] {
  try {
    if (!fs.existsSync(SCALPER_TICK_LOG)) return [];
    const all = fs
      .readFileSync(SCALPER_TICK_LOG, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ScalperTick;
        } catch {
          return null;
        }
      })
      .filter((x): x is ScalperTick => !!x);
    return all.slice(-limit);
  } catch {
    return [];
  }
}

function readTrades(): ScalperTrade[] {
  try {
    if (!fs.existsSync(SCALPER_LOG)) return [];
    return fs
      .readFileSync(SCALPER_LOG, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ScalperTrade;
        } catch {
          return null;
        }
      })
      .filter((x): x is ScalperTrade => !!x);
  } catch {
    return [];
  }
}

function writeTrades(trades: ScalperTrade[]): void {
  try {
    fs.mkdirSync(path.dirname(SCALPER_LOG), { recursive: true });
    fs.writeFileSync(SCALPER_LOG, trades.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

/** 拉最新成交价（best-effort，失败返回 null） */
async function fetchLastPrice(inst: string): Promise<number | null> {
  try {
    const r = await mcpCall("demo", "market_get_ticker", { instId: inst });
    // MCP 返回是三层洋葱 result.data.data，用 unwrap 正确剥到数组（一层剥会永远空）
    const arr = unwrap(r.data);
    const n = Number(arr[0]?.last);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 平仓检测：同一标的只保留「最新且方向匹配当前持仓」的 open 记录，其余用当前价近似平仓 */
async function syncTrades(): Promise<ScalperTrade[]> {
  const trades = readTrades();
  const open = trades.filter((t) => t.status === "open");
  if (!open.length) return trades;
  let acct: Awaited<ReturnType<typeof fetchAccount>>;
  try {
    acct = await fetchAccount();
  } catch {
    return trades;
  }

  // 当前各标的持仓方向（net 模式由 pos 正负判断，long/short 由 posSide）
  const posSideByInst = new Map<string, "long" | "short">();
  for (const p of acct.positions) {
    const inst = String(p.instId ?? "");
    const ps = positionSide(p);
    if (inst && ps) posSideByInst.set(inst, ps);
  }

  // 按标的分组 open 记录，ts 升序；只有「最新一条 + 方向匹配当前持仓」保持 open
  const openByInst = new Map<string, ScalperTrade[]>();
  for (const t of trades) {
    if (t.status !== "open") continue;
    const arr = openByInst.get(t.inst) ?? [];
    arr.push(t);
    openByInst.set(t.inst, arr);
  }

  let changed = false;
  const closeRecord = async (t: ScalperTrade): Promise<void> => {
    t.status = "closed";
    const close = await fetchLastPrice(t.inst);
    t.closePrice = close ?? undefined;
    if (close != null) {
      const dir = t.direction === "long" ? 1 : -1;
      t.pnl = Number(((close - t.entry) * t.size * t.ctVal * dir).toFixed(4));
      t.netPnl = Number(((t.pnl ?? 0) - (t.fee ?? 0)).toFixed(4));
    }
    changed = true;
  };

  for (const [inst, list] of openByInst) {
    const curSide = posSideByInst.get(inst);
    list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (let k = 0; k < list.length; k++) {
      const t = list[k];
      const isLatest = k === list.length - 1;
      const matchCur = curSide != null && t.direction === curSide;
      if (isLatest && matchCur) continue; // 保持 open
      await closeRecord(t);
    }
  }

  if (changed) writeTrades(trades);
  return trades;
}

/** 关闭某标的全部 open 记录（开新单前调用，用当前价近似旧仓平仓价） */
async function closeOpenRecords(inst: string): Promise<void> {
  const trades = readTrades();
  const open = trades.filter((t) => t.status === "open" && t.inst === inst);
  if (!open.length) return;
  const close = await fetchLastPrice(inst);
  for (const t of open) {
    t.status = "closed";
    t.closePrice = close ?? undefined;
    if (close != null) {
      const dir = t.direction === "long" ? 1 : -1;
      t.pnl = Number(((close - t.entry) * t.size * t.ctVal * dir).toFixed(4));
      t.netPnl = Number(((t.pnl ?? 0) - (t.fee ?? 0)).toFixed(4));
    }
  }
  writeTrades(trades);
}

/**
 * 跑一次超短线：信号 → 方向（规则 or LLM）→ 止盈止损 → 开单 + OCO 同挂。
 * 已有该标的持仓时不重复开单（等止盈/止损触发后再开）。
 */
export async function scalpOnce(cfg: ScalperConfig): Promise<ScalpResult> {
  // 统一收口：每次循环监测都落一条 tick 记录（含跳过/失败原因）
  const finish = (
    result: "opened" | "skipped" | "error",
    reason: string,
    signal?: ScalperSignal,
    judge?: "rule" | "llm"
  ): ScalpResult => {
    appendTick({
      ts: new Date().toISOString(),
      inst: cfg.inst,
      direction: signal?.direction,
      strength: signal?.strength,
      entry_ref: signal?.entry_ref,
      judge,
      strategy: signal?.strategy,
      result,
      reason,
    });
    return { ok: result === "opened", msg: reason, signal };
  };

  // 演练模式（--dry-run）与主轮次一致：不下单
  if (process.argv.includes("--dry-run")) {
    return finish("skipped", "[演练模式] 超短线不下单（--dry-run）");
  }
  const sig = await fetchSignal(cfg);
  if (sig.error) return finish("error", sig.error);

  // 自定义策略观望（flat）：不开仓；已有持仓也保持，由 OCO 止盈止损管理
  if (sig.direction === "flat") {
    return finish("skipped", `策略观望（flat）：${sig.reason || "不满足开仓条件"}`.trim(), sig, "rule");
  }

  const acct = await fetchAccount();
  const equity = acct.equityUsdt ?? 0;
  if (equity <= 0) return finish("error", "无法获取账户权益", sig);

  // 方向：LLM 介入则交给 LLM，否则用规则方向（先判方向，才能判断是否反转）
  let direction = sig.direction;
  let judge: "rule" | "llm" = "rule";
  if (cfg.useLlm && Array.isArray(sig.closes) && sig.closes.length >= 30) {
    const d = await llmDirection(sig.closes);
    if (d) {
      direction = d;
      judge = "llm";
    }
  }

  // 持仓处理：趋势反转 + 勾选「趋势反转平仓」→ 先平掉再开新方向单
  const pos = acct.positions.find((p) => String(p.instId ?? "") === cfg.inst);
  if (pos) {
    const ps = positionSide(pos);
    const sizeContracts = Math.abs(Number(pos.pos ?? 0));
    if (ps && ps !== direction) {
      // 现有持仓方向与当前趋势相反
      if (cfg.closeOnReversal) {
        // 先撤掉旧仓配套的 OCO 止损止盈，再平仓（否则残留止损单会反向触发）
        const cancel = await cancelAlgoOrders(cfg.inst);
        if (!cancel.ok) return finish("error", `趋势反转平仓前撤止损止盈失败 ${cancel.raw.slice(0, 180)}`, sig, judge);
        const closeSide = ps === "long" ? "sell" : "buy";
        const r = await closePosition({ inst: cfg.inst, side: closeSide, size: sizeContracts });
        if (!r.ok) return finish("error", `趋势反转平仓失败 ${r.raw.slice(0, 180)}`, sig, judge);
        // 平仓成功，继续开新方向单
      } else {
        return finish("skipped", `已有 ${cfg.inst} ${ps} 持仓，与趋势 ${direction} 相反（未勾选趋势反转平仓），跳过`, sig, judge);
      }
    } else {
      // 方向一致，不重复开单
      return finish("skipped", `已有 ${cfg.inst} ${ps ?? "?"} 持仓，方向与趋势一致，等止盈/止损触发`, sig, judge);
    }
  }

  const spec = sig.spec ?? { ctVal: 0, lotSz: 0, minSz: 0, tickSz: 0 };
  if (!(spec.ctVal > 0) || !(spec.tickSz > 0)) {
    return finish("error", "缺合约规格（ctVal/tickSz），无法下单", sig, judge);
  }

  const price = sig.entry_ref;
  // 按最终方向重算止损/止盈价（距离来自凯利+ATR，方向可能被 LLM 翻转）
  const slDist = sig.sl_dist ?? Math.abs(sig.sl - price);
  const tpDist = sig.tp_dist ?? Math.abs(sig.tp - price);
  const sl = direction === "long" ? price - slDist : price + slDist;
  const tp = direction === "long" ? price + tpDist : price - tpDist;

  // 单笔名义金额 = 总权益 × riskPct；张数 = 名义 / (每张面值 × 现价)，按 lotSz 向下取整
  const notional = equity * cfg.riskPct;
  const rawSize = notional / (price * spec.ctVal);
  const size = Number((Math.max(spec.minSz, Math.floor(rawSize / spec.lotSz) * spec.lotSz)).toFixed(10));
  if (!(size > 0)) return finish("error", `张数为 0（raw=${rawSize.toFixed(6)}）`, sig, judge);

  const lever = Math.min(Math.max(1, cfg.leverage), 20);
  const side = direction === "long" ? "buy" : "sell";
  const slPx = fmtTick(sl, spec.tickSz);
  const tpPx = fmtTick(tp, spec.tickSz);

  const roundId = `S${Date.now()}`;
  const g = await genClOrdId(roundId, 1, { instId: cfg.inst, sz: size });
  if (!g.clOrdId) return finish("error", `clOrdId 生成失败（${g.error ?? "未知"}）`, sig, judge);
  const cl = g.clOrdId;

  await setLeverage(cfg.inst, lever);
  const placed = await placeOrder({ inst: cfg.inst, side, size, clOrdId: cl });
  if (!placed.ok) return finish("error", `开单失败 ${placed.raw.slice(0, 180)}`, sig, judge);

  // 止损止盈同挂（OCO，L1-4：每单必挂）
  const oco = await placeOco({
    inst: cfg.inst,
    side: side === "buy" ? "sell" : "buy",
    size,
    slPx,
    tpPx,
    clOrdId: cl + "oc",
  });
  const confirmed = await confirmAlgo(cfg.inst);

  const ok = oco.ok && confirmed;
  // 开新单前：关闭该标的此前的 open 记录（旧仓已平，避免堆积一直显示「持仓中」）
  await closeOpenRecords(cfg.inst);
  // 记录开单（补齐名义金额/保证金/手续费字段）
  const notionalUsdt = size * spec.ctVal * price;
  const marginUsdt = notionalUsdt / lever;
  const feeUsdt = notionalUsdt * (sig.fee_rate ?? cfg.feeRate) * 2;
  appendTrade({
    ts: new Date().toISOString(),
    inst: cfg.inst,
    direction,
    entry: price,
    sl,
    tp,
    size,
    leverage: lever,
    rr: sig.rr,
    ctVal: spec.ctVal,
    judge,
    status: "open",
    feeRate: sig.fee_rate ?? cfg.feeRate,
    notional: notionalUsdt,
    margin: marginUsdt,
    fee: feeUsdt,
  });

  const msg =
    `[超短线] ${cfg.inst} ${direction}(${judge}) ${side} ${size}张 @${price} ` +
    `杠杆${lever}x SL=${slPx} TP=${tpPx} RR=${sig.rr} 费${sig.fee_pct}% ` +
    `OCO=${oco.ok} 回查=${confirmed}`;
  return finish(ok ? "opened" : "error", msg, sig, judge);
}

/** 汇总：开单记录 + 当前持仓 + 已实现/未实现收益（供界面展示） */
export async function getScalperOverview(): Promise<ScalperOverview> {
  const trades = await syncTrades();
  const ticks = readTicks(200);
  let positions: Record<string, unknown>[] = [];
  let unrealizedPnl = 0;
  try {
    const acct = await fetchAccount();
    positions = acct.positions;
    unrealizedPnl = positions.reduce((s, p) => s + Number(p.upl ?? 0), 0);
  } catch {
    /* ignore */
  }
  const closed = trades.filter((t) => t.status === "closed");
  const realizedPnl = closed.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const totalFee = closed.reduce((s, t) => s + Number(t.fee ?? 0), 0);
  const realizedNetPnl = closed.reduce(
    (s, t) => s + Number(t.netPnl ?? (Number(t.pnl ?? 0) - Number(t.fee ?? 0))),
    0
  );
  return { trades, ticks, positions, realizedPnl, realizedNetPnl, totalFee, unrealizedPnl };
}

/** 超短线历史回测（同步版，供兼容）：拉 1m 数据回放策略，返回汇总 + 每笔记录 */
export async function runScalperBacktest(args: {
  inst: string;
  start: string;
  end?: string;
  atrMult?: number;
  feeRate?: number;
  notional?: number;
  closeOnReversal?: boolean;
  strategyId?: string;
  bar?: string;
}): Promise<Record<string, unknown>> {
  const argv = ["--inst", args.inst, "--start", args.start];
  if (args.end) argv.push("--end", args.end);
  if (args.bar && args.bar !== "1m") argv.push("--bar", args.bar);
  if (args.atrMult != null) argv.push("--atr-mult", String(args.atrMult));
  if (args.feeRate != null) argv.push("--fee-rate", String(args.feeRate));
  if (args.notional != null) argv.push("--notional", String(args.notional));
  if (args.closeOnReversal) argv.push("--close-on-reversal");
  if (args.strategyId) argv.push("--strategy", strategyDir(args.strategyId));
  const out = await runPy("scalper_backtest.py", argv, 180_000);
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return { error: `回测脚本输出非 JSON: ${out.slice(0, 300)}` };
  }
}

/** 同步版回测的 CLI 参数组装（供 main.ts 的 job 版 spawn 复用） */
export function backtestArgv(args: {
  inst: string;
  start: string;
  end?: string;
  atrMult?: number;
  feeRate?: number;
  notional?: number;
  closeOnReversal?: boolean;
  strategyId?: string;
  jobId?: string;
  rr?: number;
  slippageBps?: number;
  maxHold?: number;
  bar?: string;
}): string[] {
  const argv = ["--inst", args.inst, "--start", args.start];
  if (args.end) argv.push("--end", args.end);
  if (args.bar && args.bar !== "1m") argv.push("--bar", args.bar);
  if (args.atrMult != null) argv.push("--atr-mult", String(args.atrMult));
  if (args.feeRate != null) argv.push("--fee-rate", String(args.feeRate));
  if (args.notional != null) argv.push("--notional", String(args.notional));
  if ((args.rr ?? 0) > 0) argv.push("--rr", String(args.rr));
  if ((args.slippageBps ?? 0) > 0) argv.push("--slippage-bps", String(args.slippageBps));
  if ((args.maxHold ?? 0) > 0) argv.push("--max-hold", String(args.maxHold));
  if (args.closeOnReversal) argv.push("--close-on-reversal");
  if (args.strategyId) argv.push("--strategy", strategyDir(args.strategyId));
  if (args.jobId) argv.push("--job-id", args.jobId);
  return argv;
}

/**
 * 一键平仓：平掉超短线所有在持标的的持仓。
 *
 * 范围 = 开仓记录里 status=open 的标的 ∪ 当前配置标的（兜底），
 * 避免误平主轮次开的、与超短线无关的仓位。
 * 顺序沿用趋势反转平仓的既有套路：先撤 OCO 止损止盈 → 再市价平仓，
 * 否则残留止损单会在平仓后反向触发。
 */
export async function closeScalperPositions(
  inst?: string
): Promise<{ ok: boolean; msg: string; closed: number }> {
  const openInsts = new Set(readTrades().filter((t) => t.status === "open").map((t) => t.inst));
  if (inst) openInsts.add(inst);

  let acct: Awaited<ReturnType<typeof fetchAccount>>;
  try {
    acct = await fetchAccount();
  } catch (e) {
    return { ok: false, msg: `获取账户失败：${String(e).slice(0, 120)}`, closed: 0 };
  }

  const targets = acct.positions.filter((p) => {
    const ps = positionSide(p);
    return openInsts.has(String(p.instId ?? "")) && ps && Math.abs(Number(p.pos ?? 0)) > 0;
  });
  if (!targets.length) return { ok: false, msg: "超短线当前无持仓可平", closed: 0 };

  let closed = 0;
  const errs: string[] = [];
  const closedInsts: string[] = [];
  for (const p of targets) {
    const instId = String(p.instId ?? "");
    const ps = positionSide(p)!;
    const size = Math.abs(Number(p.pos ?? 0));
    const side = ps === "long" ? "sell" : "buy";

    const cancel = await cancelAlgoOrders(instId);
    if (!cancel.ok) {
      errs.push(`${instId}: 撤止损止盈失败 ${cancel.raw.slice(0, 80)}`);
      continue;
    }
    const r = await closePosition({ inst: instId, side, size });
    if (r.ok) {
      closed++;
      closedInsts.push(instId);
    } else {
      errs.push(`${instId}: ${r.raw.slice(0, 120)}`);
    }
  }

  // 同步交易记录：open → closed，并用最新价近似平仓价算盈亏
  await syncTrades();

  if (errs.length) {
    return {
      ok: closed > 0,
      msg: `平仓 ${closed}/${targets.length} 笔成功，失败：${errs.join("；")}`,
      closed,
    };
  }
  return { ok: true, msg: `已平仓 ${closed} 笔（${[...new Set(closedInsts)].join(", ")}）`, closed };
}

export { DEFAULT_SCALPER };
