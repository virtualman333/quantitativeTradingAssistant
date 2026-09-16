/**
 * scalperstats.ts —— 超短线战绩统计
 *
 * 为什么需要这个模块
 * ------------------
 * 界面此前只显示五个**绝对值**：总净收益 / 已实现 / 未实现 / 手续费 / 笔数。
 * 高频小额策略真正要看的是**分布**：胜率多少、赢的时候赢多少、输的时候输多少
 * （盈亏比）、每笔期望值、累计曲线的最大回撤。只看绝对值，用户无法判断这套
 * 参数该继续跑还是该关掉；更无法回答「开了 LLM 介入到底有没有用」——
 * `judge` 字段一直记着每单是规则还是 LLM 判的，却从没被统计过。
 *
 * 本模块是纯函数：输入台账记录，输出统计。不读文件、不碰网络、不依赖 Electron，
 * 因此可以直接单测（`tests/scalperstats.test.ts`）。
 *
 * ★ 硬规则：**「未同步」不等于「0 盈亏」**
 * ----------------------------------------
 * `syncTrades()` 在取不到平仓价时会把单子标成 `closed` 但**不写 pnl**。
 * 旧汇总代码用 `Number(t.pnl ?? 0)` 兜底，于是这些真实存在的单子被静默按
 * 「0 盈亏」计入总收益——不报错、不提示，只是把结果算错；更糟的是它们还会
 * 被算进样本数，把胜率一起稀释。
 *
 * 所以这里把已平仓单分成两类，**任何统计都只用第一类**：
 *   settled   —— 净盈亏已知，进统计
 *   unsettled —— 已平仓但净盈亏未知，单独计数、不进任何统计
 * 界面必须把 unsettled 的数量显式显示出来，否则「胜率 60%」是在一个不完整的
 * 样本上算出来的，而用户看不出来。（与 `ui/lib/riskbrief.js` 里「『没算』必须
 * 区别于『充裕』」是同一条原则。）
 *
 * 净盈亏口径**唯一来源**是下面的 `netPnlOf()`：`netPnl` 优先，缺失时退回
 * `pnl - fee`——与 `getScalperOverview()` 原有的兜底公式逐字一致，本次改造
 * 只是把「两者都没有」从「当作 0」改成「返回 null」，因此对既有台账的总和
 * 数值**没有影响**（缺结果的单原本贡献的就是 0）。
 */

/** 台账里的一笔超短线开单记录（只声明本模块用到的字段） */
export interface StatTrade {
  ts: string;
  inst?: string;
  direction?: string;
  judge?: string;
  status?: string;
  pnl?: number;
  fee?: number;
  netPnl?: number;
}

/** 台账里的一次循环监测记录 */
export interface StatTick {
  ts: string;
  result?: string;
  reason?: string;
  judge?: string;
}

/** 分判断来源（规则 / LLM）的战绩 */
export interface JudgeStats {
  judge: string;
  samples: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnl: number;
  /** 该来源下已平仓但未同步结果的笔数（不进上面的统计，但必须让用户看见） */
  unsettled: number;
}

/** 跳过/失败原因的分布，每一条都是「循环为什么没开单」的答案 */
export interface ReasonStat {
  key: string;
  label: string;
  count: number;
}

export interface ScalperStats {
  /** 统计样本 = 已平仓且净盈亏已同步的笔数（所有比例的分母） */
  samples: number;
  wins: number;
  losses: number;
  /** 净盈亏恰好为 0 的单（既不算赢也不算输） */
  flats: number;
  /** 已平仓但未同步到平仓价 → 净盈亏未知，**未计入以上任何统计** */
  unsettled: number;
  /** 仍持仓中 */
  openCount: number;

  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  /** 胜率 = 盈利笔数 / 样本数；无样本为 null（不是 0） */
  winRate: number | null;
  /** 盈亏比 = 盈利合计 / |亏损合计|；样本内无亏损时为 null（不是 Infinity） */
  profitFactor: number | null;
  /** 每笔期望收益；无样本为 null */
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** 累计净收益曲线的最大峰谷差（≥0，从初始 0 起算） */
  maxDrawdown: number;

  /** 累计净收益曲线（按时间升序），供界面直接画 */
  equity: { ts: string; cum: number }[];
  byJudge: JudgeStats[];

  /** 监测轮次分布：合计恒等于 ticks.length */
  tickTotal: number;
  tickOpened: number;
  reasonStats: ReasonStat[];
}

/** 统一的数值口径：null / undefined / 空串 / 非有限数 → null */
function fin(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 单笔净盈亏（已扣手续费）。**口径唯一来源**，别在别处重写这条公式。
 *
 * 平仓结果未同步时返回 `null` 而不是 0 —— 这是本模块存在的首要理由。
 */
export function netPnlOf(t: StatTrade | null | undefined): number | null {
  const net = fin(t?.netPnl);
  if (net !== null) return net;
  const pnl = fin(t?.pnl);
  if (pnl === null) return null; // 平仓价取不到 → 结果未知，绝不冒充 0
  return pnl - (fin(t?.fee) ?? 0);
}

/** 把台账分成「已同步 / 未同步 / 持仓中」三堆 */
export function splitTrades(trades: StatTrade[] | null | undefined): {
  settled: { t: StatTrade; v: number }[];
  unsettled: StatTrade[];
  open: StatTrade[];
} {
  const settled: { t: StatTrade; v: number }[] = [];
  const unsettled: StatTrade[] = [];
  const open: StatTrade[] = [];
  for (const t of trades ?? []) {
    if (!t) continue;
    if (t.status !== "closed") {
      open.push(t);
      continue;
    }
    const v = netPnlOf(t);
    if (v === null) unsettled.push(t);
    else settled.push({ t, v });
  }
  return { settled, unsettled, open };
}

/** 累计净收益曲线（账本是只追加的，这里仍按 ts 排一次，防手工改过顺序） */
export function equityCurve(settled: { t: StatTrade; v: number }[]): { ts: string; cum: number }[] {
  const list = [...(settled ?? [])].sort((a, b) => (a.t.ts < b.t.ts ? -1 : a.t.ts > b.t.ts ? 1 : 0));
  let cum = 0;
  return list.map(({ t, v }) => {
    cum += v;
    return { ts: t.ts, cum: Number(cum.toFixed(4)) };
  });
}

/**
 * 最大回撤：累计曲线从**历史最高点**回落的最大幅度。
 * 起点按 0 计（还没赚钱就一路亏，回撤就是亏损额本身），这对小额高频策略才诚实。
 */
export function maxDrawdown(curve: { cum: number }[] | null | undefined): number {
  let peak = 0;
  let dd = 0;
  for (const p of curve ?? []) {
    const v = fin(p?.cum);
    if (v === null) continue;
    if (v > peak) peak = v;
    const d = peak - v;
    if (d > dd) dd = d;
  }
  return Number(dd.toFixed(4));
}

/** 跳过原因分桶（桶必须互斥且穷尽，否则「循环为什么没开单」会被漏答） */
export const REASON_LABELS: Record<string, string> = {
  watch: "策略观望（趋势/震荡不达条件）",
  holding: "已有持仓，等止盈/止损触发",
  other: "其它跳过",
  error: "执行出错",
  opened: "已开单",
};

export function classifyTick(t: StatTick | null | undefined): string {
  if (!t) return "other";
  if (t.result === "opened") return "opened";
  if (t.result === "error") return "error";
  const r = String(t.reason ?? "");
  if (r.includes("观望")) return "watch";
  if (r.includes("已有") && r.includes("持仓")) return "holding";
  return "other";
}

/** 汇总一条循环监测记录的分布；各类计数合计恒等于 ticks.length */
export function reasonStats(ticks: StatTick[] | null | undefined): {
  total: number;
  opened: number;
  list: ReasonStat[];
} {
  const all = ticks ?? [];
  const order = ["watch", "holding", "other", "error", "opened"];
  const hit = new Map<string, number>();
  for (const t of all) {
    const k = classifyTick(t);
    hit.set(k, (hit.get(k) ?? 0) + 1);
  }
  const list = order
    .filter((k) => k !== "opened")
    .map((k) => ({ key: k, label: REASON_LABELS[k] ?? k, count: hit.get(k) ?? 0 }));
  return { total: all.length, opened: hit.get("opened") ?? 0, list };
}

/** 汇总整轮战绩 */
export function computeStats(
  trades: StatTrade[] | null | undefined,
  ticks: StatTick[] | null | undefined
): ScalperStats {
  const { settled, unsettled, open } = splitTrades(trades);
  const vals = settled.map((s) => s.v);
  const samples = vals.length;

  const profits = vals.filter((v) => v > 0);
  const losses = vals.filter((v) => v < 0);
  const grossProfit = profits.reduce((s, v) => s + v, 0);
  const grossLoss = losses.reduce((s, v) => s + v, 0);
  const netPnl = vals.reduce((s, v) => s + v, 0);
  const equity = equityCurve(settled);

  // 分判断来源。**按全部已平仓单列出**（不只是已同步的）—— 否则「唯一那笔 LLM
  // 单恰好没同步到结果」时 LLM 整行会消失，用户会以为自己从没让它介入过。
  // 顺序固定：规则在前，LLM 在后，其余追加。
  const judges = ["rule", "llm"];
  const closedAll = [...settled.map((s) => s.t), ...unsettled];
  const seen = new Set(closedAll.map((t) => String(t.judge ?? "未标注")));
  for (const j of seen) if (!judges.includes(j)) judges.push(j);
  const byJudge: JudgeStats[] = judges
    .filter((j) => seen.has(j))
    .map((judge) => {
      const sub = settled.filter((s) => String(s.t.judge ?? "未标注") === judge).map((s) => s.v);
      const w = sub.filter((v) => v > 0).length;
      const l = sub.filter((v) => v < 0).length;
      return {
        judge,
        samples: sub.length,
        wins: w,
        losses: l,
        winRate: sub.length ? w / sub.length : null,
        netPnl: Number(sub.reduce((s, v) => s + v, 0).toFixed(4)),
        unsettled: unsettled.filter((t) => String(t.judge ?? "未标注") === judge).length,
      };
    });

  const rs = reasonStats(ticks);

  return {
    samples,
    wins: profits.length,
    losses: losses.length,
    flats: vals.length - profits.length - losses.length,
    unsettled: unsettled.length,
    openCount: open.length,

    netPnl: Number(netPnl.toFixed(4)),
    grossProfit: Number(grossProfit.toFixed(4)),
    grossLoss: Number(grossLoss.toFixed(4)),
    winRate: samples ? profits.length / samples : null,
    // 没有亏损样本时盈亏比无意义（∞ 不是结论），返回 null 由界面显示「—」
    profitFactor: losses.length ? Number((grossProfit / Math.abs(grossLoss)).toFixed(4)) : null,
    expectancy: samples ? Number((netPnl / samples).toFixed(4)) : null,
    avgWin: profits.length ? Number((grossProfit / profits.length).toFixed(4)) : null,
    avgLoss: losses.length ? Number((grossLoss / losses.length).toFixed(4)) : null,
    maxDrawdown: maxDrawdown(equity),

    equity,
    byJudge,

    tickTotal: rs.total,
    tickOpened: rs.opened,
    reasonStats: rs.list,
  };
}
