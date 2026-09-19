/**
 * scalper.ts — 超短线（超高频）交易引擎（独立于主轮次）
 *
 * 与主轮次（5 分钟 LangGraph 多专家决策）完全解耦：本模块只负责「开单」——
 * 拉 1m 线信号（scalper.py 用最近 5 根 1m 收盘价斜率判趋势 + 凯利公式推止盈止损 + 手续费），
 * 市价开单后**同轮挂 OCO 止损止盈**（L1-4：每单必挂止损止盈）。
 *
 * ⚠ L1-4 的后半句也在本模块：**挂不上就补挂一次，仍不确认就立即市价平仓**；
 * 巡检时发现已有持仓却没有止损（裸仓）同样先补挂、挂不上再平仓。
 * 这条链只有一份实现（`ensureStopProtection()`），决策在 `stopprotect.ts`。
 *
 * 可选 LLM 介入（cfg.useLlm）：趋势方向交给 LLM 判断（喂最近 60 根 1m 收盘价，
 * 提示词明确要求用最近 5 根 1m 收盘价的斜率判趋势），
 * 止盈止损仍由凯利公式 + ATR 计算。false 时用规则（5 根 1m 斜率）判向。
 *
 * 独立循环由 main.ts 里单独的定时器驱动；开单记录追加到 data/scalper_trades.jsonl。
 *
 * ⚠ L1 闸门：本路径的开单参数来自用户界面（不是 LLM 意图），因此不经过 guardIntent()，
 * 而是每轮先过 guardScalperConfig()（见 guard.ts）—— 两条路径用的是同一份上限常量。
 */
import fs from "node:fs";
import path from "node:path";
import { runPy, fetchAccount, placeOrder, placeOco, genClOrdId, setLeverage, confirmAlgo, mcpCall, closePosition, cancelAlgoOrders, unwrap } from "./okx.js";
import { guardScalperConfig, guardMonthlyDrawdown } from "./guard.js";
import { decideStopProtection, pendingStopsFor } from "./stopprotect.js";
import { loadRunState } from "./runstate.js";
import { snappedSlTp } from "./price.js";
import { DEFAULT_SCALPER, resolveModel, AGENT_ROOT, type ScalperConfig } from "./store.js";
import { createProvider } from "./llm.js";
import { strategyDir } from "./strategies.js";
import { computeStats, netPnlOf, rangeBounds, filterByRange, type RangeBounds, type ScalperStats } from "./scalperstats.js";

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
  /**
   * 平仓结果是否已同步（是否真的算出了 pnl）。
   * 取不到平仓价时必须显式写 `false` —— 否则这条记录与「刚好打平」在 JSON 里
   * 长得一模一样，汇总处一律按 0 兜底就把结果算错了（见 scalperstats.ts）。
   */
  pnlSynced?: boolean;
  /**
   * 这条记录上发生的、用户需要知道而数字答不出来的事（目前只有一类：L1-4 止损保护）。
   * 例如「止损挂不上，已按 L1-4 市价平仓」—— 不写下来，战绩表上只会看到一笔小亏，
   * 没人能知道那是保护性动作而不是策略失误。
   */
  note?: string;
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
  /** 已平仓但未同步到平仓价的笔数（净盈亏未知，**未计入以上任何金额**） */
  unsettledCount: number;
  /** 战绩统计（胜率 / 盈亏比 / 期望 / 回撤 / 规则-LLM 对比 / 跳过原因） */
  stats: ScalperStats;
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
/**
 * 结算一笔平仓记录：定平仓价 + 算净盈亏。
 *
 * 【为什么必须显式写 pnlSynced】取不到平仓价时这里只能留下 `closePrice: undefined`。
 * 若不加标记，这条记录在 JSON 里与「刚好打平」无法区分，汇总处一律 `?? 0` 兜底
 * 就会把真实结果算错（不报错、不提示）。标 `false` 后，统计层与界面能把它剔出
 * 样本并如实告知用户。
 *
 * 本函数是「单笔结算」（syncTrades）与「开新单前平旧仓」（closeOpenRecords）
 * 的**唯一实现** —— 此前两处各写了一遍同样的算式，是典型的「同一事实两处写法
 * 必然漂移」陷阱。
 *
 * （导出仅供测试直接验证「取不到平仓价时必须留痕」这一行为。）
 */
export function settleTrade(t: ScalperTrade, close: number | null): void {
  t.status = "closed";
  t.closePrice = close ?? undefined;
  if (close == null) {
    t.pnlSynced = false;
    return;
  }
  const dir = t.direction === "long" ? 1 : -1;
  t.pnl = Number(((close - t.entry) * t.size * t.ctVal * dir).toFixed(4));
  t.netPnl = Number(((t.pnl ?? 0) - (t.fee ?? 0)).toFixed(4));
  t.pnlSynced = true;
}

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
    settleTrade(t, await fetchLastPrice(t.inst));
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
  for (const t of open) settleTrade(t, close);
  writeTrades(trades);
}

/** 台账里该标的还开着的记录（裸仓补挂要拿它记着的 sl/tp —— 那才是这笔仓原本的计划止损位） */
function openTradeOf(inst: string): ScalperTrade | undefined {
  return readTrades()
    .filter((t) => t.status === "open" && t.inst === inst)
    .pop();
}

/**
 * L1-4 的执行口：确认这笔持仓在交易所侧**真的有**止损；没有就补挂一次，
 * 补挂仍不确认（或者这轮压根挂不出去）就立即市价平仓。
 *
 * 为什么必须是一个共用函数：这条链上有两个调用点 ——
 * ① 开单成交后（章程 L1-4 第一句）；② 巡检发现已有持仓却是裸仓。
 * 两处各写一遍「挂 OCO → 回查 → 失败平仓」，就是本仓反复踩的
 * 「同一件事写两遍，其中一份必然没跟上」。
 *
 * @param pendingStops 调用方账快照里该标的当前 pending 算法单条数（同一次取数，不再打接口）
 * @param clOrdId 传了就复用（开单那条链上要沿用主单的 ID，L1-8 的幂等约定）；
 *                不传则现生成一个 —— 生成失败即视为「挂不出去」，走平仓。
 */
async function ensureStopProtection(p: {
  inst: string;
  /** 持仓方向；平仓方向与它相反 */
  direction: "long" | "short";
  size: number;
  slPx?: string;
  tpPx?: string;
  clOrdId?: string;
  pendingStops: number;
}): Promise<{ protected: boolean; closed: boolean; note: string }> {
  if (!(p.size > 0)) {
    return { protected: false, closed: false, note: "张数为 0，无法补挂止损（不改动持仓）" };
  }

  let clOrdId = p.clOrdId;
  // 「能挂」= 有取整好的价位 + 合规 clOrdId（L1-8）。缺哪个都补挂不出去。
  if (!clOrdId && p.slPx && p.tpPx) {
    const g = await genClOrdId(`H${Date.now()}`, 1, { instId: p.inst, sz: p.size });
    clOrdId = g.clOrdId ? `${g.clOrdId}oc` : undefined;
  }
  const canRehang = !!(p.slPx && p.tpPx && clOrdId);

  let decision = decideStopProtection({
    pendingStops: p.pendingStops,
    rehangTried: false,
    canRehang,
  });
  if (decision.action === "none") {
    return { protected: true, closed: false, note: decision.why };
  }

  if (decision.action === "rehang") {
    const oco = await placeOco({
      inst: p.inst,
      side: p.direction === "long" ? "sell" : "buy",
      size: p.size,
      slPx: p.slPx as string,
      tpPx: p.tpPx as string,
      clOrdId: clOrdId as string,
    });
    if (oco.ok && (await confirmAlgo(p.inst))) {
      return {
        protected: true,
        closed: false,
        note: `已补挂 OCO 并回查确认（SL=${p.slPx} TP=${p.tpPx}）`,
      };
    }
    // 补挂 + 回查都没成功 —— 这就是章程说的「重试无效」，下一步是平仓
    decision = decideStopProtection({ pendingStops: 0, rehangTried: true, canRehang: true });
  }

  if (decision.action !== "close") {
    // 理论上到不了这里（none 已在上面返回，rehang 也已处理）。留一条明确的话，
    // 免得将来加了分支却没人改这里 —— 返回 protected:false 会被当成「没保护住」处理。
    return { protected: false, closed: false, note: `止损保护未完成（${decision.action}）：${decision.why}` };
  }

  const cp = await closePosition({
    inst: p.inst,
    side: p.direction === "long" ? "sell" : "buy",
    size: p.size,
  });
  return {
    protected: false,
    closed: cp.ok,
    note: cp.ok
      ? `${decision.why} —— 已市价平仓`
      : `${decision.why} —— 市价平仓也失败了，裸仓仍在，需人工介入：${cp.raw.slice(0, 160)}`,
  };
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

  // L1 硬闸门。超短线是「用户直接配置下单参数」的路径，与主 Agent 路径一样会下真单，
  // 此前这条路径上一个 L1 检查都没有（界面可以配出 10x / 10% 并被直接执行）。
  // 放在最前、连 --dry-run 之前：配置违规不是「这一轮不做」，而是配置本身不合法 ——
  // 演练也照常报出来，免得用户以为一切正常。
  const cfgGuard = guardScalperConfig(cfg);
  if (!cfgGuard.ok) {
    return finish("error", `触碰 L1 硬约束，拒绝开单：${cfgGuard.violations.join("；")}`);
  }

  // L1-6 月度回撤熔断。这是**运行态**约束，不是配置错误：章程写的是「月度回撤 ≥12%
  // → 强制停止开新仓（仅允许管理既有持仓至月末或回撤修复）」。超短线是一个无人值守的
  // 独立循环，此前这条路径上连一次判断都没有 —— 熔断期间它会照常每 60 秒开新单，
  // 而主 Agent 那边（main.ts 第 ④ 步）已经停了。两条路径必须同一结论。
  // 已有持仓不动：它的止损止盈在 OCO 里，本来就由交易所管。
  const ddGuard = guardMonthlyDrawdown(loadRunState().monthDdPct);
  if (!ddGuard.ok) {
    return finish("skipped", `L1-6 熔断，本轮不开新仓：${ddGuard.violations.join("；")}`);
  }

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
      // 方向一致，不重复开单 —— 但「不重复开单」不等于「可以不管」。
      // 这笔持仓到底有没有止损，此前这一支从来没判过：挂 OCO 失败留下的裸仓会在
      // 这里被无限期 skipped 掉，理由还写着「等止盈/止损触发」（**在裸仓上是假的**）。
      const pending = pendingStopsFor(acct.algoOrders, cfg.inst);
      if (pending > 0) {
        return finish("skipped", `已有 ${cfg.inst} ${ps ?? "?"} 持仓，方向与趋势一致，止损在挂（${pending} 条），等触发`, sig, judge);
      }

      // 裸仓：按 L1-4「裸仓必须立即补挂或平仓」先补挂。止损位优先取台账里这笔仓
      // 原本记着的 sl/tp（那是开仓时的计划），取不到才退回「持仓均价 ± 本轮信号距离」。
      const openTrade = openTradeOf(cfg.inst);
      const avgPx = Number(pos.avgPx ?? 0);
      const stopDist = Number(sig.sl_dist ?? 0) || Math.abs(Number(sig.sl ?? 0) - Number(sig.entry_ref ?? 0));
      const tpDist = Number(sig.tp_dist ?? 0) || Math.abs(Number(sig.tp ?? 0) - Number(sig.entry_ref ?? 0));
      const basePx = openTrade?.entry ?? (avgPx > 0 ? avgPx : Number(sig.entry_ref ?? 0));
      const planSl = openTrade?.sl ?? (ps === "short" ? basePx + stopDist : basePx - stopDist);
      const planTp = openTrade?.tp ?? (ps === "short" ? basePx - tpDist : basePx + tpDist);
      const hedge = snappedSlTp(basePx, planSl, planTp, Number(sig.spec?.tickSz ?? 0));

      const protect = await ensureStopProtection({
        inst: cfg.inst,
        direction: ps ?? "long",
        size: sizeContracts,
        slPx: hedge?.slStr,
        tpPx: hedge?.tpStr,
        pendingStops: 0,
      });

      if (protect.protected) {
        return finish("skipped", `已有 ${cfg.inst} ${ps ?? "?"} 持仓但无止损（裸仓）→ ${protect.note}，本轮不开新仓`, sig, judge);
      }
      return finish(
        "error",
        `已有 ${cfg.inst} ${ps ?? "?"} 持仓且无止损（裸仓）→ ${protect.note}${protect.closed ? "" : "（⚠ 请人工检查持仓）"}`,
        sig,
        judge
      );
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

  // 杠杆直接取配置值：合法性（1 ≤ lever ≤ MAX_LEVERAGE）已由上面的 guardScalperConfig 保证。
  // 这里此前是 `Math.min(Math.max(1, cfg.leverage), 20)` —— 那个 20 是章程外的数，
  // 等于在代码里又开了一个「可以到 20x」的口子。
  const lever = Number(cfg.leverage);
  const side = direction === "long" ? "buy" : "sell";
  const ticks = snappedSlTp(price, sl, tp, spec.tickSz);
  if (!ticks) {
    // L1-4：每单必挂止损止盈。挂不出「严格在入场价亏损侧」的止损就不开这一单，
    // 宁可错过一次机会，也不留下一个等于入场价的止损。
    return finish("error", `止损/止盈无法落在 tick 网格上（ref=${price} tickSz=${spec.tickSz}）`, sig, judge);
  }
  const slPx = ticks.slStr;
  const tpPx = ticks.tpStr;

  const roundId = `S${Date.now()}`;
  const g = await genClOrdId(roundId, 1, { instId: cfg.inst, sz: size });
  if (!g.clOrdId) return finish("error", `clOrdId 生成失败（${g.error ?? "未知"}）`, sig, judge);
  const cl = g.clOrdId;

  await setLeverage(cfg.inst, lever);
  const placed = await placeOrder({ inst: cfg.inst, side, size, clOrdId: cl });
  if (!placed.ok) return finish("error", `开单失败 ${placed.raw.slice(0, 180)}`, sig, judge);

  // 止损止盈同挂（OCO，L1-4：每单必挂）+ **同一轮回查**；挂不上就补挂一次，
  // 补挂仍不确认 → 立即市价平仓。
  // 此前这里只有「挂一次 + 回查一次」，失败时既没重试也没平仓，只把
  // `OCO=false 回查=false` 拼进日志 —— 结果是这条无人值守循环能留下永久裸仓
  // （下一轮看到已有持仓就直接 skipped，止损永远不会再被挂上）。见 stopprotect.ts。
  const protect = await ensureStopProtection({
    inst: cfg.inst,
    direction,
    size,
    slPx,
    tpPx,
    clOrdId: `${cl}oc`,
    pendingStops: 0, // 刚成交，交易所侧还不存在属于这一笔的止损委托
  });

  // 开新单前：关闭该标的此前的 open 记录（旧仓已平，避免堆积一直显示「持仓中」）
  await closeOpenRecords(cfg.inst);
  // 记录开单（补齐名义金额/保证金/手续费字段）
  const notionalUsdt = size * spec.ctVal * price;
  const marginUsdt = notionalUsdt / lever;
  const feeUsdt = notionalUsdt * (sig.fee_rate ?? cfg.feeRate) * 2;
  const trade: ScalperTrade = {
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
  };
  if (!protect.protected) {
    // 止损没保住 —— 把「发生过什么」写进台账。只记一笔亏损的话，用户在战绩表上
    // 分不出这是策略失误还是保护性动作。
    trade.note = protect.note;
    if (protect.closed) {
      // 保护性平仓之后这笔仓已经不存在了，不许再记成「持仓中」（否则界面会显示
      // 一笔永远不动的持仓，而台账里只有开仓那一行）。
      settleTrade(trade, await fetchLastPrice(cfg.inst));
    }
  }
  appendTrade(trade);

  // L2 提示（如「单笔风险 > 2% 需人工确认」）不阻断开单，但必须跟着这一轮的结论一起可见 ——
  // 超短线是无人值守的循环，写进日志/战绩上一轮记录是唯一能让用户看到它的地方。
  const warn = cfgGuard.warnings.length ? ` ⚠${cfgGuard.warnings.join("；")}` : "";
  const msg =
    `[超短线] ${cfg.inst} ${direction}(${judge}) ${side} ${size}张 @${price} ` +
    `杠杆${lever}x SL=${slPx} TP=${tpPx} RR=${sig.rr} 费${sig.fee_pct}% ` +
    `${protect.protected ? "OCO=已确认 回查=已确认" : `止损保护未完成：${protect.note}`}${warn}`;
  return finish(protect.protected ? "opened" : "error", msg, sig, judge);
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
  // 净盈亏口径唯一来源 = netPnlOf()。未同步到平仓价的单返回 null：既不计入金额，
  // 也不冒充 0，只单独计数 —— 这样界面才能如实说「有几个数没算进来」。
  // （对既有台账而言总和数值不变：缺结果的单原本贡献的就是 0。）
  const realizedNetPnl = closed.reduce((s, t) => s + (netPnlOf(t) ?? 0), 0);
  const unsettledCount = closed.filter((t) => netPnlOf(t) === null).length;
  // 毛盈亏与手续费沿用台账原值：手续费在开单时就估好了，不是结算产物
  const realizedPnl = closed.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const totalFee = closed.reduce((s, t) => s + Number(t.fee ?? 0), 0);
  const stats = computeStats(trades, ticks);
  return {
    trades,
    ticks,
    positions,
    realizedPnl,
    realizedNetPnl,
    totalFee,
    unrealizedPnl,
    unsettledCount,
    stats,
  };
}

/**
 * 按日期区间看战绩（**不联网**，只读本地台账）。
 *
 * 为什么不复用 `getScalperOverview()`：那个每次都要 `syncTrades()` 并拉一次账户
 * （联网、几百毫秒起），而界面上动一次日期就要重取一次 —— 不能为看个统计再打
 * 一次交易所。台账是只追加的本地文件，读它足够回答「这段时间战绩如何」。
 *
 * 区间判定与统计口径全部来自 `scalperstats.ts`（本函数只负责读文件），
 * 因此界面成交表里的笔数与统计表的分母必然是同一个区间。
 *
 * ⚠ 区间模式下监测轮次读**全量**：默认只取最近 200 条，日期若选到上周，
 * 那 200 条可能全是今天的，界面就会拿「今天的轮次」冒充「上周的轮次」。
 */
export function getScalperRange(from?: string, to?: string): {
  trades: ScalperTrade[];
  stats: ScalperStats;
  bounds: RangeBounds;
} {
  const bounds = rangeBounds(from, to);
  const trades = readTrades();
  const ticks = readTicks(Number.MAX_SAFE_INTEGER);
  return {
    trades: filterByRange(trades, bounds),
    stats: computeStats(trades, ticks, bounds),
    bounds,
  };
}

/**
 * 超短线历史回测（同步版，供兼容）：拉 1m 数据回放策略，返回汇总 + 每笔记录。
 *
 * 【为什么参数走 backtestArgv 而不是自己拼】此前这里手写了一份 argv 拼装，
 * 与 job 版（`backtestArgv`）各写一遍，很快就漂移了：这条路径漏掉了 `--rr` /
 * `--slippage-bps` / `--max-hold` / `--job-id`，同一个 UI 表单换条通道进来，
 * 参数会被静默吞掉、回测结果对不上，而且不报错。收敛为单一来源后不会再漂。
 */
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
  jobId?: string;
  rr?: number;
  slippageBps?: number;
  maxHold?: number;
}): Promise<Record<string, unknown>> {
  const argv = backtestArgv(args);
  const out = await runPy("scalper_backtest.py", argv, 180_000);
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return { error: `回测脚本输出非 JSON: ${out.slice(0, 300)}` };
  }
}

/**
 * 回测 CLI 参数组装的**唯一来源**：同步版 `runScalperBacktest` 与
 * job 版 spawn（electron/main.ts）都走这里，两侧参数因此永远一致。
 */
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
 * LLM 分析一次回测结果：返回中文 Markdown 分析报告（不落盘，供界面展示）。
 * 回测结果无敏感标识，无需混淆（obfuscated=false）；走 complete 拿纯文本，避免 decide 的 extractJson。
 */
export async function analyzeBacktest(
  result: Record<string, unknown>,
  strategyName = ""
): Promise<{ ok: boolean; text: string; modelId?: string; error?: string }> {
  const cfg = resolveModel();
  if (!cfg || cfg.provider === "mock") {
    return {
      ok: false,
      text: "",
      error: "未配置真实模型，无法分析。请在「设置-模型」添加 API Key 并设为默认。",
    };
  }
  const llm = createProvider(cfg, false);
  const summary = (result.summary || {}) as Record<string, unknown>;
  const params = (result.params || {}) as Record<string, unknown>;
  const trades = Array.isArray(result.trades) ? (result.trades as Record<string, unknown>[]) : [];
  // 交易明细只取最近 60 笔 + 关键字段，避免超长撑爆上下文
  const slim = trades.slice(-60).map((t) => ({
    n: t.n,
    side: t.side,
    entry: t.entry,
    exit: t.exit,
    bars: t.bars,
    reason: t.reason,
    pnlPct: t.pnlPct,
    netPnlPct: t.netPnlPct,
    netPnlUsdt: t.netPnlUsdt,
  }));

  const sys = `你是加密货币永续合约超短线策略的量化研究员。请基于给定的一次回测结果，输出一份简洁、可执行的中文分析报告（Markdown）。要求：
1. 先给结论：该区间策略表现如何，是否值得实盘或继续优化。
2. 分点解读关键指标：笔数、胜率、盈亏比(PF)、最大回撤、夏普、总净盈亏，并指出数值是否健康。
3. 结合每笔交易（方向、持仓根数、平仓原因、盈亏）指出主要问题，例如：假突破频繁、止损过近、盈利拿不住、手续费侵蚀、方向判断反了等。
4. 给出 2~3 条具体可落地的改进建议，最好能对应到 signal(ctx) 的写法。
不要复述原始数据，要给出判断和洞察；总字数控制在 400 字以内。`;

  const user = `策略：${strategyName || (params.strategy as string) || "内置趋势策略"}
标的：${result.inst || ""}  周期：${result.bar || "1m"}
区间：${result.start || ""} ~ ${result.end || ""}
参数：${JSON.stringify(params)}
汇总：${JSON.stringify(summary)}
最近 ${slim.length} 笔交易明细：${JSON.stringify(slim)}`;

  try {
    const text = await llm.complete(sys, user);
    return { ok: true, text, modelId: cfg.id };
  } catch (e) {
    return { ok: false, text: "", error: String(e).slice(0, 300) };
  }
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
