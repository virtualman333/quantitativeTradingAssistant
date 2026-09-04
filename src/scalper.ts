/**
 * scalper.ts — 超短线（超高频）交易引擎（独立于主轮次）
 *
 * 与主轮次（5 分钟 LangGraph 多专家决策）完全解耦：本模块只负责「开单」——
 * 拉 1m 线信号（scalper.py 做趋势识别 + 凯利公式推止盈止损 + 手续费），
 * 市价开单后**同轮挂 OCO 止损止盈**（L1-4：每单必挂止损止盈）。
 *
 * 可选 LLM 介入（cfg.useLlm）：趋势方向交给 LLM 判断（喂最近 60 根 1m 收盘价），
 * 止盈止损仍由凯利公式 + ATR 计算。false 时用规则（EMA9/21 + 动量）判向。
 *
 * 独立循环由 main.ts 里单独的定时器驱动；开单记录追加到 data/scalper_trades.jsonl。
 */
import fs from "node:fs";
import path from "node:path";
import { runPy, fetchAccount, placeOrder, placeOco, genClOrdId, setLeverage, confirmAlgo, mcpCall } from "./okx.js";
import { DEFAULT_SCALPER, resolveModel, AGENT_ROOT, type ScalperConfig } from "./store.js";
import { createProvider } from "./llm.js";

export interface ScalperSignal {
  inst: string;
  direction: "long" | "short";
  strength: string;
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
}

export interface ScalperOverview {
  trades: ScalperTrade[];
  positions: Record<string, unknown>[];
  realizedPnl: number;
  unrealizedPnl: number;
}

const SCALPER_LOG = path.join(AGENT_ROOT, "data", "scalper_trades.jsonl");

/** 调 scalper.py 拿 1m 线信号（不开单） */
export async function fetchSignal(cfg: ScalperConfig): Promise<ScalperSignal> {
  const out = await runPy(
    "scalper.py",
    ["--inst", cfg.inst, "--atr-mult", String(cfg.atrMult), "--fee-rate", String(cfg.feeRate)],
    60_000
  );
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

/** LLM 判向：喂最近 60 根 1m 收盘价，返回 long/short，失败返回 null（回退规则方向） */
async function llmDirection(closes: number[]): Promise<"long" | "short" | null> {
  try {
    const cfg = resolveModel();
    if (!cfg || cfg.provider === "mock") return null;
    const llm = createProvider(cfg);
    const sys =
      `You are a short-term trend judge for crypto perpetual scalping. Given recent 1-minute closing prices, ` +
      `judge the immediate trend direction by considering momentum, the sequence of higher/lower closes and recent acceleration. ` +
      `Output JSON only: {"direction":"long"|"short","reason":"one short sentence"}`;
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
    const d = r.data as Record<string, unknown> | null;
    const arr = Array.isArray(d?.data) ? (d!.data as Record<string, unknown>[]) : [];
    const n = Number(arr[0]?.last ?? d?.last ?? d?.data);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 平仓检测：open 记录对应标的已无持仓 → 用当前价近似平仓价，算 pnl */
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
  const posInst = new Set(acct.positions.map((p) => String(p.instId ?? "")));
  let changed = false;
  for (const t of trades) {
    if (t.status !== "open" || posInst.has(t.inst)) continue;
    t.status = "closed";
    const close = await fetchLastPrice(t.inst);
    t.closePrice = close ?? undefined;
    if (close != null) {
      const dir = t.direction === "long" ? 1 : -1;
      t.pnl = Number(((close - t.entry) * t.size * t.ctVal * dir).toFixed(4));
    }
    changed = true;
  }
  if (changed) writeTrades(trades);
  return trades;
}

/**
 * 跑一次超短线：信号 → 方向（规则 or LLM）→ 止盈止损 → 开单 + OCO 同挂。
 * 已有该标的持仓时不重复开单（等止盈/止损触发后再开）。
 */
export async function scalpOnce(cfg: ScalperConfig): Promise<ScalpResult> {
  // 演练模式（--dry-run）与主轮次一致：不下单
  if (process.argv.includes("--dry-run")) {
    return { ok: false, msg: "[演练模式] 超短线不下单（--dry-run）" };
  }
  const sig = await fetchSignal(cfg);
  if (sig.error) return { ok: false, msg: sig.error };

  const acct = await fetchAccount();
  const equity = acct.equityUsdt ?? 0;
  if (equity <= 0) return { ok: false, msg: "无法获取账户权益" };

  // 已有该标的持仓则跳过，避免高频重复开单堆积仓位
  const hasPos = acct.positions.some((p) => String(p.instId ?? "") === cfg.inst);
  if (hasPos) return { ok: false, msg: `已有 ${cfg.inst} 持仓，等止盈/止损触发后再开新单`, signal: sig };

  // 方向：LLM 介入则交给 LLM，否则用规则方向
  let direction = sig.direction;
  let judge: "rule" | "llm" = "rule";
  if (cfg.useLlm && Array.isArray(sig.closes) && sig.closes.length >= 30) {
    const d = await llmDirection(sig.closes);
    if (d) {
      direction = d;
      judge = "llm";
    }
  }

  const spec = sig.spec ?? { ctVal: 0, lotSz: 0, minSz: 0, tickSz: 0 };
  if (!(spec.ctVal > 0) || !(spec.tickSz > 0)) {
    return { ok: false, msg: "缺合约规格（ctVal/tickSz），无法下单", signal: sig };
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
  if (!(size > 0)) return { ok: false, msg: `张数为 0（raw=${rawSize.toFixed(6)}）`, signal: sig };

  const lever = Math.min(Math.max(1, cfg.leverage), 20);
  const side = direction === "long" ? "buy" : "sell";
  const slPx = fmtTick(sl, spec.tickSz);
  const tpPx = fmtTick(tp, spec.tickSz);

  const roundId = `S${Date.now()}`;
  const g = await genClOrdId(roundId, 1, { instId: cfg.inst, sz: size });
  if (!g.clOrdId) return { ok: false, msg: `clOrdId 生成失败（${g.error ?? "未知"}）`, signal: sig };
  const cl = g.clOrdId;

  await setLeverage(cfg.inst, lever);
  const placed = await placeOrder({ inst: cfg.inst, side, size, clOrdId: cl });
  if (!placed.ok) return { ok: false, msg: `开单失败 ${placed.raw.slice(0, 180)}`, signal: sig };

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
  // 记录开单
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
  });

  const msg =
    `[超短线] ${cfg.inst} ${direction}(${judge}) ${side} ${size}张 @${price} ` +
    `杠杆${lever}x SL=${slPx} TP=${tpPx} RR=${sig.rr} 费${sig.fee_pct}% ` +
    `OCO=${oco.ok} 回查=${confirmed}`;
  return { ok, msg, signal: sig };
}

/** 汇总：开单记录 + 当前持仓 + 已实现/未实现收益（供界面展示） */
export async function getScalperOverview(): Promise<ScalperOverview> {
  const trades = await syncTrades();
  let positions: Record<string, unknown>[] = [];
  let realizedPnl = 0;
  let unrealizedPnl = 0;
  try {
    const acct = await fetchAccount();
    positions = acct.positions;
    unrealizedPnl = positions.reduce((s, p) => s + Number(p.upl ?? 0), 0);
  } catch {
    /* ignore */
  }
  realizedPnl = trades.filter((t) => t.status === "closed").reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  return { trades, positions, realizedPnl, unrealizedPnl };
}

export { DEFAULT_SCALPER };
