/**
 * scalperstats.test.ts —— 超短线战绩统计的口径测试
 *
 * 为什么需要这份测试
 * ------------------
 * 这套统计直接产出用户据以决策的数字（胜率 / 盈亏比 / 期望 / 最大回撤 /
 * 「该不该继续开 LLM 介入」），而它读的是 `data/scalper_trades.jsonl` 与
 * `data/scalper_ticks.jsonl` —— 两个**只会追加、从不校验**的文本账本。
 *
 * 最容易出的错是「把『没算出来』当成 0」：账本里确有几笔已平仓但取不到
 * 平仓价的单（`syncTrades()` 只能记下 `closePrice: undefined`）。旧汇总用
 * `Number(t.pnl ?? 0)` 兜底，于是这些单被静默按「0 盈亏」计入总收益，还被
 * 算进样本数把胜率一起稀释。本文件的核心断言就是锁死这一点：
 * **未同步的单既不入金额，也不入样本，只单独计数。**
 *
 * 运行
 * ----
 *     pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyTick,
  computeStats,
  equityCurve,
  maxDrawdown,
  netPnlOf,
  reasonStats,
  splitTrades,
  type StatTrade,
  type StatTick,
} from "../src/scalperstats.ts";
import { sparkline } from "../ui/lib/sparkline.js";
import { settleTrade, type ScalperTrade } from "../src/scalper.ts";

/** 造一笔已平仓单；ts 用递增序号保证顺序确定 */
function closed(
  n: number,
  judge: "rule" | "llm",
  netPnl: number | undefined,
  extra: Partial<StatTrade> = {}
): StatTrade {
  return {
    ts: `2026-09-16T00:0${n}:00.000Z`,
    inst: "BTC-USDT-SWAP",
    judge,
    status: "closed",
    netPnl,
    ...extra,
  };
}

describe("netPnlOf —— 净盈亏口径唯一来源", () => {
  it("优先取 netPnl", () => {
    assert.equal(netPnlOf({ ts: "", netPnl: 1.23, pnl: 99, fee: 1 }), 1.23);
  });

  it("无 netPnl 时退回 pnl - fee", () => {
    assert.equal(netPnlOf({ ts: "", pnl: 10, fee: 0.77 }), 9.23);
  });

  it("有 pnl 但无 fee 时按 fee=0 退回", () => {
    assert.equal(netPnlOf({ ts: "", pnl: 2.5 }), 2.5);
  });

  it("★ 平仓结果未同步时返回 null，绝不冒充 0", () => {
    assert.equal(netPnlOf({ ts: "", fee: 0.77 }), null);
    assert.equal(netPnlOf({ ts: "" }), null);
    assert.notEqual(netPnlOf({ ts: "" }), 0);
  });

  it("空串不算 0（Number('') 是 0，必须显式挡住）", () => {
    assert.equal(netPnlOf({ ts: "", pnl: "" as unknown as number }), null);
    assert.equal(netPnlOf({ ts: "", pnl: 5, fee: "" as unknown as number }), 5);
  });

  it("净盈亏恰好为 0 是有效值（不能与「未同步」混为一谈）", () => {
    assert.equal(netPnlOf({ ts: "", netPnl: 0 }), 0);
  });
});

describe("settleTrade —— 取不到平仓价必须留痕", () => {
  const base: StatTrade & Record<string, unknown> = {
    ts: "2026-09-16T00:00:00.000Z",
    inst: "BTC-USDT-SWAP",
    direction: "long",
    status: "open",
    entry: 100,
    size: 10,
    ctVal: 0.1,
    fee: 1,
  };

  it("取到平仓价：算出 pnl / netPnl 并标 pnlSynced=true", () => {
    const t: ScalperTrade = { ...(base as ScalperTrade) };
    settleTrade(t, 110);
    assert.equal(t.status, "closed");
    assert.equal(t.closePrice, 110);
    assert.equal(t.pnl, 10); // (110-100)*10*0.1*1
    assert.equal(t.netPnl, 9); // 10 - 1
    assert.equal(t.pnlSynced, true);
  });

  it("★ 取不到平仓价：标 pnlSynced=false，且不写 pnl（否则与「打平」无法区分）", () => {
    const t: ScalperTrade = { ...(base as ScalperTrade) };
    settleTrade(t, null);
    assert.equal(t.status, "closed");
    assert.equal(t.closePrice, undefined);
    assert.equal(t.pnl, undefined);
    assert.equal(t.pnlSynced, false);
  });

  it("空头方向符号相反", () => {
    const t: ScalperTrade = { ...(base as ScalperTrade), direction: "short" };
    settleTrade(t, 110);
    assert.equal(t.pnl, -10);
  });
});

describe("splitTrades —— 三堆互斥且穷尽", () => {
  it("按「已同步 / 未同步 / 持仓中」分组，数量守恒", () => {
    const trades: StatTrade[] = [
      closed(1, "rule", 2),
      closed(2, "rule", undefined),
      { ts: "2026-09-16T00:03:00.000Z", status: "open" },
      closed(4, "llm", -1),
    ];
    const { settled, unsettled, open } = splitTrades(trades);
    assert.equal(settled.length, 2);
    assert.equal(unsettled.length, 1);
    assert.equal(open.length, 1);
    assert.equal(settled.length + unsettled.length + open.length, trades.length);
  });

  it("空 / null 输入不抛", () => {
    assert.equal(splitTrades(null).settled.length, 0);
    assert.equal(splitTrades(undefined).unsettled.length, 0);
  });
});

describe("computeStats —— 战绩口径", () => {
  /** 4 笔已同步（+2 / -1 / -0.5 / +1）+ 1 笔未同步 + 1 笔持仓中 */
  const trades: StatTrade[] = [
    closed(1, "rule", 2),
    closed(2, "rule", -1),
    closed(3, "rule", -0.5),
    closed(4, "llm", 1),
    closed(5, "rule", undefined),
    { ts: "2026-09-16T00:06:00.000Z", status: "open" },
  ];
  const s = computeStats(trades, []);

  it("样本只含已同步的单（未同步的单不稀释胜率）", () => {
    assert.equal(s.samples, 4);
    assert.equal(s.unsettled, 1);
    assert.equal(s.openCount, 1);
  });

  it("赢 / 亏 / 平三分类", () => {
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 2);
    assert.equal(s.flats, 0);
    assert.equal(s.winRate, 0.5);
  });

  it("盈亏比 = 盈利合计 / |亏损合计|", () => {
    assert.equal(s.grossProfit, 3);
    assert.equal(s.grossLoss, -1.5);
    assert.equal(s.profitFactor, 2);
  });

  it("期望值 = 净盈亏 / 样本数；平均盈亏各自成组", () => {
    assert.equal(s.netPnl, 1.5);
    assert.equal(s.expectancy, 0.375);
    assert.equal(s.avgWin, 1.5);
    assert.equal(s.avgLoss, -0.75);
  });

  it("最大回撤按累计曲线的峰谷差（起点按 0 计）", () => {
    // cum: 2 → 1 → 0.5 → 1.5，峰值 2，最低 0.5 → 回撤 1.5
    assert.deepEqual(
      s.equity.map((e) => e.cum),
      [2, 1, 0.5, 1.5]
    );
    assert.equal(s.maxDrawdown, 1.5);
  });

  it("曲线末点等于净盈亏合计", () => {
    assert.equal(s.equity[s.equity.length - 1].cum, s.netPnl);
  });

  it("分判断来源（规则 / LLM）各成一组成绩", () => {
    const rule = s.byJudge.find((b) => b.judge === "rule");
    const llm = s.byJudge.find((b) => b.judge === "llm");
    assert.deepEqual(rule, {
      judge: "rule",
      samples: 3,
      wins: 1,
      losses: 2,
      winRate: 1 / 3,
      netPnl: 0.5,
      unsettled: 1,
    });
    assert.deepEqual(llm, { judge: "llm", samples: 1, wins: 1, losses: 0, winRate: 1, netPnl: 1, unsettled: 0 });
  });

  it("守恒：各组样本数合计 = 总样本数，各组未同步数合计 = 未同步总数", () => {
    assert.equal(
      s.byJudge.reduce((a, b) => a + b.samples, 0),
      s.samples
    );
    assert.equal(
      s.byJudge.reduce((a, b) => a + b.unsettled, 0),
      s.unsettled
    );
  });

  it("★ 某来源全是未同步的单时仍要出现该行（否则用户以为没开过这个来源）", () => {
    const only = computeStats(
      [closed(1, "rule", 1), closed(2, "llm", undefined), closed(3, "llm", undefined)],
      []
    );
    const llm = only.byJudge.find((b) => b.judge === "llm");
    assert.ok(llm, "LLM 行不应消失");
    assert.equal(llm.samples, 0);
    assert.equal(llm.unsettled, 2);
    assert.equal(llm.winRate, null);
  });

  it("★ 全是未同步的单 → 样本 0、胜率 null（而不是「3 笔全打平」）", () => {
    const only = computeStats(
      [closed(1, "rule", undefined), closed(2, "rule", undefined), closed(3, "rule", undefined)],
      []
    );
    assert.equal(only.samples, 0);
    assert.equal(only.unsettled, 3);
    assert.equal(only.netPnl, 0);
    assert.equal(only.winRate, null);
    assert.equal(only.expectancy, null);
  });

  it("无样本时所有比例都是 null，不是 0", () => {
    const empty = computeStats([], []);
    assert.equal(empty.samples, 0);
    assert.equal(empty.winRate, null);
    assert.equal(empty.profitFactor, null);
    assert.equal(empty.expectancy, null);
    assert.equal(empty.avgWin, null);
    assert.equal(empty.avgLoss, null);
    assert.equal(empty.maxDrawdown, 0);
    assert.deepEqual(empty.equity, []);
  });

  it("样本内没有亏损时盈亏比是 null（∞ 不是结论）", () => {
    const winOnly = computeStats([closed(1, "rule", 1), closed(2, "rule", 2)], []);
    assert.equal(winOnly.profitFactor, null);
    assert.equal(winOnly.winRate, 1);
    assert.equal(winOnly.avgLoss, null);
  });

  it("净盈亏为 0 的单算「平」，既不进赢也不进亏", () => {
    const flat = computeStats([closed(1, "rule", 0), closed(2, "rule", 1)], []);
    assert.equal(flat.wins, 1);
    assert.equal(flat.losses, 0);
    assert.equal(flat.flats, 1);
    assert.equal(flat.winRate, 0.5);
  });

  it("★ 界面读取的字段必须全部存在（字段一改名，界面不报错、只会静默显示「—」）", () => {
    const need = [
      "samples", "wins", "losses", "flats", "unsettled", "openCount",
      "netPnl", "grossProfit", "grossLoss", "winRate", "profitFactor",
      "expectancy", "avgWin", "avgLoss", "maxDrawdown",
      "equity", "byJudge", "tickTotal", "tickOpened", "reasonStats",
    ];
    for (const k of need) assert.ok(k in s, `stats 缺字段 ${k}`);
    for (const k of ["judge", "samples", "wins", "losses", "winRate", "netPnl", "unsettled"]) {
      assert.ok(k in s.byJudge[0], `byJudge 缺字段 ${k}`);
    }
    for (const k of ["key", "label", "count"]) {
      assert.ok(k in s.reasonStats[0], `reasonStats 缺字段 ${k}`);
    }
    assert.ok("ts" in s.equity[0] && "cum" in s.equity[0], "equity 缺字段");
    // 数值字段不得是 NaN（fmtNum 会把它渲染成字符串 "NaN" 直接显示给用户）
    const nums = [
      s.samples, s.wins, s.losses, s.flats, s.unsettled, s.netPnl, s.grossProfit,
      s.grossLoss, s.maxDrawdown, s.tickTotal, s.tickOpened,
      ...s.equity.map((e) => e.cum),
      ...s.byJudge.map((b) => b.netPnl),
      ...s.reasonStats.map((r) => r.count),
    ];
    for (const v of nums) assert.ok(Number.isFinite(v), `出现非有限数：${v}`);
  });
});

describe("口径兼容 —— 本次改造不得改动既有金额", () => {
  it("新口径（netPnlOf ?? 0）与旧兜底（netPnl ?? pnl - fee）在混合台账上总和相等", () => {
    const trades: StatTrade[] = [
      closed(1, "rule", 2),
      closed(2, "rule", undefined, { pnl: 5, fee: 0.77 }), // 有毛盈亏无净盈亏 → 走退回分支
      closed(3, "rule", undefined), // 完全未同步
      { ts: "2026-09-16T00:04:00.000Z", status: "open", pnl: 999 }, // 持仓中不计
      closed(5, "llm", -0.3),
    ];
    const legacy = trades
      .filter((t) => t.status === "closed")
      .reduce((s, t) => s + Number(t.netPnl ?? (Number(t.pnl ?? 0) - Number(t.fee ?? 0))), 0);
    const now = trades
      .filter((t) => t.status === "closed")
      .reduce((s, t) => s + (netPnlOf(t) ?? 0), 0);
    assert.equal(now, legacy);
    // 2 + (5 - 0.77) + 0 + (-0.3)；持仓中那笔的 pnl=999 必须没被算进来
    assert.ok(Math.abs(now - 5.93) < 1e-9, `实际 ${now}`);
  });
});

describe("循环监测记录 —— 「为什么没开单」", () => {
  it("按真实文案归类", () => {
    assert.equal(classifyTick({ ts: "", result: "skipped", reason: "策略观望（flat）：趋势动量不匹配观望" }), "watch");
    assert.equal(classifyTick({ ts: "", result: "skipped", reason: "策略观望（flat）：ER=0.38边界模糊观望" }), "watch");
    assert.equal(
      classifyTick({ ts: "", result: "skipped", reason: "已有 ETH-USDT-SWAP long 持仓，方向与趋势一致，等止盈/止损触发" }),
      "holding"
    );
    assert.equal(classifyTick({ ts: "", result: "opened", reason: "[超短线] 已开单" }), "opened");
    assert.equal(classifyTick({ ts: "", result: "error", reason: "[超短线] buy 失败" }), "error");
    assert.equal(classifyTick({ ts: "", result: "skipped", reason: "某种新原因" }), "other");
    assert.equal(classifyTick(null), "other");
  });

  it("★ 守恒：各桶计数 + 已开单 = 记录总数（不能有记录掉进桶外）", () => {
    const ticks: StatTick[] = [
      { ts: "", result: "skipped", reason: "策略观望（flat）：趋势动量不匹配观望" },
      { ts: "", result: "skipped", reason: "已有 BTC-USDT-SWAP long 持仓，方向与趋势一致，等止盈/止损触发" },
      { ts: "", result: "skipped", reason: "从未见过的新原因" },
      { ts: "", result: "error", reason: "下单失败" },
      { ts: "", result: "opened", reason: "已开单" },
    ];
    const rs = reasonStats(ticks);
    assert.equal(rs.total, 5);
    assert.equal(rs.opened, 1);
    assert.equal(
      rs.list.reduce((a, b) => a + b.count, 0) + rs.opened,
      ticks.length
    );
    assert.equal(rs.list.find((r) => r.key === "watch").count, 1);
    assert.equal(rs.list.find((r) => r.key === "holding").count, 1);
    assert.equal(rs.list.find((r) => r.key === "other").count, 1);
    assert.equal(rs.list.find((r) => r.key === "error").count, 1);
  });
});

describe("equityCurve / maxDrawdown", () => {
  it("按时间排序后再累计（账本被手工调过顺序也不会画错）", () => {
    const curve = equityCurve([
      { t: { ts: "2026-09-16T00:02:00.000Z" }, v: -1 },
      { t: { ts: "2026-09-16T00:01:00.000Z" }, v: 2 },
    ]);
    assert.deepEqual(curve.map((c) => c.cum), [2, 1]);
  });

  it("全程亏损时回撤 = 亏损额本身（起点按 0 计）", () => {
    assert.equal(maxDrawdown([{ cum: -1 }, { cum: -3 }]), 3);
  });

  it("单调上涨时回撤为 0", () => {
    assert.equal(maxDrawdown([{ cum: 1 }, { cum: 5 }]), 0);
  });
});

describe("sparkline（展示层 ui/lib/sparkline.js）—— 曲线几何", () => {
  it("空曲线返回空路径，不抛", () => {
    assert.equal(sparkline([]).points, "");
    assert.equal(sparkline(null).zeroY, null);
  });

  it("单点也有合法坐标", () => {
    const s = sparkline([{ cum: 3 }]);
    assert.match(s.points, /^\d+\.\d{2},\d+\.\d{2}$/);
  });

  it("值域恒包含 0（这样零轴一定在画面里）", () => {
    const s = sparkline([{ cum: 5 }, { cum: 9 }]);
    assert.ok(s.min <= 0 && s.max >= 0);
  });

  it("★ 全 0 曲线不会除零（值域含 0 → min=max=0，是最容易炸的一种）", () => {
    const s = sparkline([{ cum: 0 }, { cum: 0 }, { cum: 0 }], 600, 120, 8);
    assert.ok(!s.points.includes("NaN"), `路径里出现 NaN：${s.points}`);
    for (const pair of s.points.split(" ")) {
      const [x, y] = pair.split(",").map(Number);
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      assert.ok(y >= 0 && y <= 120, `y=${y} 越界`);
    }
  });

  it("全等但非 0 的曲线也落在画布内", () => {
    const s = sparkline([{ cum: 2 }, { cum: 2 }, { cum: 2 }], 600, 120, 8);
    for (const pair of s.points.split(" ")) {
      const [x, y] = pair.split(",").map(Number);
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      assert.ok(y >= 0 && y <= 120, `y=${y} 越界`);
    }
  });
});
