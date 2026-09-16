/**
 * scalperrange.test.ts —— 「按日期区间看战绩」的区间口径测试
 *
 * 为什么需要这份测试
 * ------------------
 * 战绩面板原本只统计**全部**已平仓样本，而上方的日期筛选只作用于成交明细表。
 * 于是同一个「日期筛选」在同一个页面上有两种含义：表里只剩 3 笔，战绩却还是
 * 全量的胜率 —— 用户看不出差别，只会觉得数字对不上。
 *
 * 修复的关键不是「再加一次过滤」，而是**把区间判定收敛成唯一来源**：主进程的
 * `rangeBounds()` / `filterByRange()` 同时服务成交表与统计，界面不再自己筛。
 * 因此本文件的断言分三类：
 *
 *  1. 边界：闭区间含首尾整天（`23:59:59.999` 那单必须算进来，`00:00:00` 之前
 *     那单必须排除）—— `T23:59:59` 少写一个 `.999` 就会静默漏单；
 *  2. 同一区间：表里的笔数 == 统计的分母 + 未同步 + 持仓中，且**统计用的边界
 *     与筛表用的边界是同一份**（`computeStats` 内部调的就是 `filterByRange`）；
 *  3. 不设区间时**不能改变任何数字**（等于旧的全量口径），否则「清空筛选」会
 *     让数字悄悄变一次。
 *
 * ⚠ 时间一律用**不带 Z 的本地时间**书写：区间按本地时区判定，测试若用 UTC
 * 表达，换一个时区跑就会飘。
 *
 * 运行
 * ----
 *     pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeStats,
  filterByRange,
  inRange,
  rangeBounds,
  splitTrades,
  type RangeBounds,
  type StatTick,
  type StatTrade,
} from "../src/scalperstats.ts";
import { getScalperRange } from "../src/scalper.ts";

const D10 = "2026-09-10";
const D09 = "2026-09-09";
const D11 = "2026-09-11";

/** 已平仓且已同步到净盈亏 */
function settled(ts: string, v: number): StatTrade {
  return { ts, status: "closed", netPnl: v, judge: "rule" };
}
/** 已平仓但取不到平仓价 → 净盈亏未知 */
function unsettled(ts: string): StatTrade {
  return { ts, status: "closed", judge: "rule" };
}
function held(ts: string): StatTrade {
  return { ts, status: "open", judge: "rule" };
}
function tick(ts: string, result: string, reason = ""): StatTick {
  return { ts, result, reason };
}

/**
 * 一组刻意踩满边界的台账：
 *   A 区间首日 00:00:00.000   （含，必须算）
 *   B 区间末日 23:59:59.999   （含，必须算）
 *   C 首日前一日的 23:59:59.999 （不含）
 *   D 末日次日 00:00:00.000   （不含）
 *   E 区间内、已平仓但未同步   （计数、不进统计）
 *   F 区间内、持仓中           （计数、不进统计）
 */
const TRADES: StatTrade[] = [
  settled(`${D09}T23:59:59.999`, 100), // C
  settled(`${D10}T00:00:00.000`, 10), // A
  unsettled(`${D10}T12:00:00.000`), // E
  held(`${D10}T13:00:00.000`), // F
  settled(`${D10}T23:59:59.999`, -4), // B
  settled(`${D11}T00:00:00.000`, 1000), // D
];

const TICKS: StatTick[] = [
  tick(`${D09}T10:00:00.000`, "skip", "观望"),
  tick(`${D10}T10:00:00.000`, "opened"),
  tick(`${D10}T11:00:00.000`, "skip", "已有持仓，等待"),
  tick(`${D10}T12:00:00.000`, "error"),
  tick(`${D11}T10:00:00.000`, "skip", "观望"),
];

const ONE_DAY: RangeBounds = rangeBounds(D10, D10);

describe("rangeBounds —— 日期边界的唯一来源", () => {
  it("闭区间：起点取当日 00:00:00.000、终点取当日 23:59:59.999", () => {
    const b = rangeBounds(D10, D10);
    const from = new Date(b.fromMs as number);
    const to = new Date(b.toMs as number);
    assert.equal(from.getFullYear(), 2026);
    assert.equal(from.getMonth(), 8); // 9 月
    assert.equal(from.getDate(), 10);
    assert.equal(from.getHours(), 0);
    assert.equal(from.getMinutes(), 0);
    assert.equal(from.getSeconds(), 0);
    assert.equal(from.getMilliseconds(), 0);
    assert.equal(to.getDate(), 10);
    assert.equal(to.getHours(), 23);
    assert.equal(to.getMinutes(), 59);
    assert.equal(to.getSeconds(), 59);
    assert.equal(to.getMilliseconds(), 999);
  });

  it("只给一端时另一端不设限", () => {
    assert.equal(rangeBounds(D10, "").toMs, null);
    assert.equal(rangeBounds("", D10).fromMs, null);
    assert.equal(rangeBounds(undefined, undefined).fromMs, null);
    assert.equal(rangeBounds(null, null).toMs, null);
    assert.ok(typeof rangeBounds(D10, "").fromMs === "number");
  });

  it("★ 无法解析的日期当作「没设」而不是「设成 0」", () => {
    // 设成 0 会把所有记录都判到区间外，统计直接归零；「没设」才是旧界面行为（NaN 比较恒 false）
    assert.equal(rangeBounds("2026-13-45", "").fromMs, null);
    assert.equal(rangeBounds("abc", "").fromMs, null);
    assert.equal(rangeBounds("", "not-a-date").toMs, null);
  });

  it("只接受 YYYY-MM-DD：带时分秒的串无法解析 → 不设限", () => {
    // 若哪天想改成按小时筛选，必须显式改这里，而不是让它悄悄变成「不筛选」
    assert.equal(rangeBounds(`${D10}T12:00`, "").fromMs, null);
  });
});

describe("filterByRange —— 成交与统计共用同一条区间判定", () => {
  it("闭区间含首尾整天，边界外一律排除", () => {
    const got = filterByRange(TRADES, ONE_DAY).map((t) => t.ts);
    assert.deepEqual(got, [
      `${D10}T00:00:00.000`,
      `${D10}T12:00:00.000`,
      `${D10}T13:00:00.000`,
      `${D10}T23:59:59.999`,
    ]);
  });

  it("★ 单写 23:59:59 漏掉 .999 就会丢单（这条断言就是为它写的）", () => {
    const loose = { fromMs: new Date(`${D10}T00:00:00`).getTime(), toMs: new Date(`${D10}T23:59:59`).getTime() };
    assert.equal(filterByRange(TRADES, ONE_DAY).length, 4);
    assert.equal(filterByRange(TRADES, loose).length, 3); // 少一单
  });

  it("只设一端", () => {
    assert.deepEqual(
      filterByRange(TRADES, rangeBounds(D11, "")).map((t) => t.ts),
      [`${D11}T00:00:00.000`]
    );
    assert.deepEqual(
      filterByRange(TRADES, rangeBounds("", D09)).map((t) => t.ts),
      [`${D09}T23:59:59.999`]
    );
  });

  it("不设区间 = 原样返回（每一条都在）", () => {
    assert.equal(filterByRange(TRADES, rangeBounds("", "")).length, TRADES.length);
    assert.equal(filterByRange(TRADES, null).length, TRADES.length);
    assert.equal(filterByRange(TRADES, undefined).length, TRADES.length);
  });

  it("空 / null 入参不炸", () => {
    assert.deepEqual(filterByRange([], ONE_DAY), []);
    assert.deepEqual(filterByRange(null, ONE_DAY), []);
    assert.deepEqual(filterByRange(undefined, ONE_DAY), []);
  });

  it("★ 区间生效时，时间读不出来的记录不进区间（放不回时间轴就别声称它在区间里）", () => {
    const broken: StatTrade[] = [settled("", 50), settled("not-a-date", 50)];
    assert.equal(filterByRange(broken, ONE_DAY).length, 0);
    // 不设区间时不能顺手把数据吃掉 —— 否则全量口径会被这行代码改掉
    assert.equal(filterByRange(broken, rangeBounds("", "")).length, 2);
  });

  it("inRange 的直连语义：无边界恒为真", () => {
    assert.equal(inRange("完全不是时间", null), true);
    assert.equal(inRange(undefined, rangeBounds("", "")), true);
    assert.equal(inRange(undefined, ONE_DAY), false);
  });
});

describe("computeStats 带区间 —— 表与统计必须是同一个区间", () => {
  it("区间内的样本 / 未同步 / 持仓与筛表结果完全对齐（守恒）", () => {
    const inRangeTrades = filterByRange(TRADES, ONE_DAY);
    const s = computeStats(TRADES, TICKS, ONE_DAY);
    const split = splitTrades(inRangeTrades);

    assert.equal(s.samples, split.settled.length);
    assert.equal(s.unsettled, split.unsettled.length);
    assert.equal(s.openCount, split.open.length);
    // 「表里的笔数 == 统计的分母 + 未同步 + 持仓中」—— 面板上两个数字对不上就是这里坏了
    assert.equal(s.samples + s.unsettled + s.openCount, inRangeTrades.length);
  });

  it("区间内的净盈亏只算区间内的单（边界外的 100 / 1000 不能混进来）", () => {
    const s = computeStats(TRADES, TICKS, ONE_DAY);
    assert.equal(s.samples, 2);
    assert.equal(s.netPnl, 6); // 10 + (-4)
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 1);
    assert.equal(s.winRate, 0.5);
    // 未同步那笔既不进金额也不进样本，只单独计数
    assert.equal(s.unsettled, 1);
    assert.equal(s.openCount, 1);
  });

  it("分来源对比也按区间切（LLM 只在那一段有单时才出现）", () => {
    const trades: StatTrade[] = [
      { ts: `${D09}T10:00:00.000`, status: "closed", netPnl: 5, judge: "llm" },
      { ts: `${D10}T10:00:00.000`, status: "closed", netPnl: 7, judge: "rule" },
    ];
    const s = computeStats(trades, [], ONE_DAY);
    assert.deepEqual(
      s.byJudge.map((r) => [r.judge, r.samples, r.netPnl]),
      [["rule", 1, 7]]
    );
  });

  it("监测轮次同样按区间筛（否则「区间内 N 轮」是假的）", () => {
    const s = computeStats(TRADES, TICKS, ONE_DAY);
    assert.equal(s.tickTotal, 3);
    assert.equal(s.tickOpened, 1);
    const err = s.reasonStats.find((r) => r.key === "error");
    assert.equal(err?.count, 1);
    const watch = s.reasonStats.find((r) => r.key === "watch");
    assert.equal(watch?.count, 0); // 09-09、09-11 的「观望」不该算进来
  });

  it("★ 不设区间时的数字与不带参数逐字相同（清空筛选不能改变结果）", () => {
    assert.deepEqual(computeStats(TRADES, TICKS, rangeBounds("", "")), computeStats(TRADES, TICKS));
    assert.deepEqual(computeStats(TRADES, TICKS, null), computeStats(TRADES, TICKS));
    assert.equal(computeStats(TRADES, TICKS).samples, 4);
    assert.equal(computeStats(TRADES, TICKS).unsettled, 1);
    assert.equal(computeStats(TRADES, TICKS).openCount, 1);
  });

  it("★ 相邻区间守恒：三段互不重叠的日区间，样本与净盈亏之和 = 全量", () => {
    const days = [D09, D10, D11];
    const parts = days.map((d) => computeStats(TRADES, TICKS, rangeBounds(d, d)));
    const all = computeStats(TRADES, TICKS);
    assert.equal(
      parts.reduce((s, p) => s + p.samples, 0),
      all.samples
    );
    assert.equal(Number(parts.reduce((s, p) => s + p.netPnl, 0).toFixed(4)), all.netPnl);
    assert.equal(
      parts.reduce((s, p) => s + p.unsettled, 0),
      all.unsettled
    );
    // 边界上的单只被算一次：03-10 的 A / B 分给 09-10，C 归 09-09、D 归 09-11
    assert.deepEqual(parts.map((p) => p.samples), [1, 2, 1]);
  });

  it("区间内无单时全部指标为「算不出来」而不是 0", () => {
    const s = computeStats(TRADES, TICKS, rangeBounds("2026-10-01", "2026-10-02"));
    assert.equal(s.samples, 0);
    assert.equal(s.netPnl, 0);
    assert.equal(s.winRate, null);
    assert.equal(s.profitFactor, null);
    assert.equal(s.expectancy, null);
    assert.equal(s.equity.length, 0);
    assert.equal(s.tickTotal, 0);
    assert.deepEqual(s.byJudge, []);
  });

  it("区间内的累计曲线只含区间内的单，末值等于区间净盈亏", () => {
    const s = computeStats(TRADES, TICKS, ONE_DAY);
    assert.equal(s.equity.length, s.samples);
    assert.equal(s.equity.at(-1)?.cum, s.netPnl);
    assert.equal(s.maxDrawdown, 4); // 10 → 6
  });
});

describe("getScalperRange —— 界面读的字段契约", () => {
  it("返回 { trades, stats, bounds }，字段名一改界面只会显示空表（不会报错）", () => {
    const r = getScalperRange();
    assert.ok(Array.isArray(r.trades), "trades 必须是数组（成交明细表直接渲染它）");
    assert.ok(r.stats && typeof r.stats === "object", "stats 必须是对象");
    // 战绩面板逐字段读下面这些名字；少一个就少显示一块，且不会有任何报错
    for (const k of [
      "samples", "wins", "losses", "flats", "unsettled", "openCount",
      "netPnl", "grossProfit", "grossLoss", "winRate", "profitFactor",
      "expectancy", "avgWin", "avgLoss", "maxDrawdown",
      "equity", "byJudge", "tickTotal", "tickOpened", "reasonStats",
    ]) {
      assert.ok(k in r.stats, `stats 缺字段 ${k}`);
    }
    assert.ok("fromMs" in r.bounds && "toMs" in r.bounds, "bounds 结构漂了");
  });

  it("★ 真实台账守恒：每天单独取一次，样本合计 = 全量（不依赖具体数值）", () => {
    const all = getScalperRange();
    const days = [...new Set(all.trades.map((t) => String(t.ts).slice(0, 10)))].sort();
    for (const d of days) {
      const r = getScalperRange(d, d);
      // 同一天的明细与统计必须自洽：分母 + 未同步 + 持仓 = 表里的笔数
      assert.equal(
        r.stats.samples + r.stats.unsettled + r.stats.openCount,
        r.trades.length,
        `${d} 的明细与统计对不上`
      );
    }
    assert.equal(
      days.reduce((n, d) => n + getScalperRange(d, d).stats.samples, 0),
      all.stats.samples,
      "逐日样本之和 != 全量样本 —— 区间边界有漏单或重复"
    );
    assert.equal(
      Number(
        days.reduce((n, d) => n + getScalperRange(d, d).stats.netPnl, 0).toFixed(4)
      ),
      all.stats.netPnl,
      "逐日净盈亏之和 != 全量 —— 区间边界有漏单或重复"
    );
    // 覆盖全部日期的区间 = 全量区间
    if (days.length) {
      const whole = getScalperRange(days[0], days[days.length - 1]);
      assert.equal(whole.stats.samples, all.stats.samples);
    }
  });
});
