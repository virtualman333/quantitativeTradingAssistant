/**
 * riskbrief-ui.test.ts —— 界面侧风控体检展示层（ui/lib/riskbrief.js）的契约测试
 *
 * 为什么需要这份测试
 * ------------------
 * `src/riskbrief.ts` 算出的 risk_brief 是**唯一**说明「这轮用了多少风险预算」的地方，
 * 而用户能看到的只有界面。展示层一旦判错档位，后果不是难看好不好看，而是
 * **把超限显示成充裕**：章程 L1 的 5x / 2.5% 硬顶是「没有下一笔了」级别的约束，
 * 界面上绿色的小条会让人放心地加大仓位。
 *
 * 两处最容易错且不报错的地方，本文件各锁一条：
 *   1. **档位阈值**：>100% 才是超限，80%~100% 只是「接近上限」。两者相差一个动作
 *      （前者 guard 已拦截/告警，后者只是提醒），混档等于丢掉区分度。
 *   2. **上限反推**：界面上一律显示「值 / 上限」，而上限是从 payload 的
 *      占上限百分比反推的 —— 不允许在界面里再抄一份 5x / 2.5% 常量（改章程时
 *      必然漂移）。反推写错会让显示的上限失真，且**不会报错**。
 *
 * 运行
 * ----
 *     pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_TEXT,
  LEVEL_TEXT,
  MONTH_LEVEL_TEXT,
  NEAR_PCT,
  STATE_TEXT,
  barWidth,
  capOf,
  ddUsage,
  leverageText,
  maxUsage,
  monthRiskView,
  pctText,
  riskBudgetText,
  rowState,
  usageLevel,
  usageText,
} from "../ui/lib/riskbrief.js";
import { read, stripComments } from "./_src.ts";

// ── 档位 ──────────────────────────────────────────────────────────────────

describe("riskbrief-ui · 用量档位", () => {
  it("恰好 100% 不算超限（guard 的判据是「超过」）", () => {
    assert.equal(usageLevel(100), "near");
    assert.equal(usageLevel(100.0001), "over");
  });

  it("阈值边界 80% 进入接近上限", () => {
    assert.equal(NEAR_PCT, 80);
    assert.equal(usageLevel(79.99), "ok");
    assert.equal(usageLevel(80), "near");
  });

  it("无数据是 none，不是 ok —— 「没算」与「充裕」不能混为一谈", () => {
    assert.equal(usageLevel(null), "none");
    assert.equal(usageLevel(undefined), "none");
    assert.equal(usageLevel(""), "none");
    assert.equal(usageLevel(Number.NaN), "none");
    // 0 是有效数据：确实用了 0% 预算
    assert.equal(usageLevel(0), "ok");
  });

  it("档位文案齐备", () => {
    assert.deepEqual(Object.keys(LEVEL_TEXT).sort(), ["near", "none", "ok", "over"]);
    assert.equal(LEVEL_TEXT.over, "超限");
  });
});

// ── 文本 ──────────────────────────────────────────────────────────────────

describe("riskbrief-ui · 文本", () => {
  it("比例转百分比", () => {
    assert.equal(pctText(0.02), "2.00%");
    assert.equal(pctText(0.0185), "1.85%");
    assert.equal(pctText(0), "0.00%");
  });

  it("无数据一律 ——", () => {
    assert.equal(pctText(null), "—");
    assert.equal(pctText(undefined), "—");
    assert.equal(pctText("abc"), "—");
  });

  it("超限要说「超限」，不能只说数字", () => {
    assert.equal(usageText(84), "84% 上限");
    assert.equal(usageText(112), "超限 112%");
    assert.equal(usageText(null), "—");
  });

  it("动作有三类中文名（hold 不参与体检，但表里可能出现）", () => {
    assert.equal(ACTION_TEXT.long, "开多");
    assert.equal(ACTION_TEXT.short, "开空");
    assert.equal(ACTION_TEXT.close, "平仓");
    assert.equal(ACTION_TEXT.hold, "持有");
  });
});

// ── 上限反推 ──────────────────────────────────────────────────────────────

describe("riskbrief-ui · 上限反推（界面不抄常量）", () => {
  it("4.0x 占了 80% → 上限 5x", () => {
    assert.equal(capOf(4, 80), 5);
  });

  it("1.75% 占了 70% → 上限 2.5%（归一化比例口径）", () => {
    const cap = capOf(0.0175, 70);
    assert.ok(cap !== null && Math.abs(cap - 0.025) < 1e-12);
  });

  it("超限时反推仍然成立（112% → 上限不变）", () => {
    assert.ok(Math.abs((capOf(5.6, 112) as number) - 5) < 1e-12);
  });

  it("占用为 0 时不反推（无法从 0 推断上限，返回 null 而不是 Infinity/NaN）", () => {
    assert.equal(capOf(0, 0), null);
    assert.equal(capOf(1, null), null);
  });

  it("逐笔文本同时给出「值」与「上限」", () => {
    assert.equal(riskBudgetText({ riskPct: 0.0185, riskUsagePct: 74 }), "1.85% / 2.50%");
    assert.equal(leverageText({ impliedLeverage: 4, leverageUsagePct: 80 }), "4.0x / 5.0x");
  });

  it("平仓单没有隐含杠杆 → —（不是 0x）", () => {
    assert.equal(leverageText({ impliedLeverage: null, leverageUsagePct: null }), "—");
    assert.equal(leverageText(undefined), "—");
  });
});

// ── 进度条 ────────────────────────────────────────────────────────────────

describe("riskbrief-ui · 进度条", () => {
  it("填充封顶 100%，但超限由颜色/文案表达", () => {
    assert.equal(barWidth(84), 84);
    assert.equal(barWidth(112), 100);
  });

  it("负数与无数据不产出 NaN 宽度（NaN 会让 width 失效并渲染成满格）", () => {
    assert.equal(barWidth(-5), 0);
    assert.equal(barWidth(null), 0);
    assert.equal(barWidth("x"), 0);
  });
});

// ── 汇总与逐笔状态 ────────────────────────────────────────────────────────

describe("riskbrief-ui · 汇总与逐笔状态", () => {
  it("取最大用量，忽略无数据项", () => {
    assert.equal(maxUsage([{ leverageUsagePct: 40 }, { leverageUsagePct: 96 }, {}], "leverageUsagePct"), 96);
    assert.equal(maxUsage([], "leverageUsagePct"), null);
    assert.equal(maxUsage(undefined, "riskUsagePct"), null);
  });

  it("0 也是有效用量，不会被当成无数据丢掉", () => {
    assert.equal(maxUsage([{ riskUsagePct: 0 }], "riskUsagePct"), 0);
  });

  it("状态优先级：拦截 > 提示 > 通过", () => {
    assert.equal(rowState({ ok: false, warnings: ["x"] }), "blocked");
    assert.equal(rowState({ ok: true, warnings: ["x"] }), "warned");
    assert.equal(rowState({ ok: true, warnings: [] }), "passed");
    assert.equal(rowState(null), "none");
    assert.equal(STATE_TEXT.blocked, "拦截");
  });
});

// ── 数据流：src 算出来的 payload，界面层必须能全部读出来 ──────────────────

describe("riskbrief-ui · 与 src/riskbrief.ts 的数据流口径", () => {
  // 这是本文件里最重要的一条：界面读的是 payload.risk_brief.intents[].xxx，
  // 字段名一旦被改（如 leverageUsagePct → leverUsagePct），界面**不会报错**，
  // 只会静默显示「—」或 NaN —— 用户看到一个空白的体检面板，还以为本轮没动作。
  // 所以这里不查源码字面量（`src.includes("xxx")` 那种断言永远为真、挡不住回归），
  // 而是用真的 src 模块造一份 brief，再让界面层全量格式化一遍。
  const snap = { equityUsdt: 10_000, availableUsdt: 10_000, positions: [], algoOrders: [] } as never;
  const mk = (over: Record<string, unknown>) => ({
    inst: "BTC-USDT-SWAP",
    action: "long",
    riskPct: 0.01,
    slDist: 200,
    reason: "测试用理由",
    ...over,
  }) as never;

  it("真实 brief → 界面层零 NaN，且各状态各行都有内容", async () => {
    const { buildRiskBrief } = await import("../src/riskbrief.ts");
    // 三笔，各自只踩一个维度（前几轮反复栽在「边界用例顺带触发别的校验」上）：
    //   ① 正常开仓           → 通过，四项字段都有数据
    //   ② 风险 2.2% 且止损拉远 → 只触发 L2 提示（隐含杠杆 2.2x，刻意不碰 5x）
    //   ③ 缺止损             → 只触发 L1-4 拦截，且杠杆无从计算（设计如此，显示「—」）
    const brief = buildRiskBrief(
      [
        mk({}),
        mk({ riskPct: 0.022, slDist: 600 }),
        mk({ inst: "ETH-USDT-SWAP", slDist: undefined }),
      ],
      snap,
      (inst: string) => (inst === "BTC-USDT-SWAP" ? 60_000 : 3_000)
    );

    assert.equal(brief.total, 3);
    assert.equal(brief.intents.length, 3, "界面逐笔表依赖 intents 数组");

    const cells = (c: (typeof brief.intents)[number]) =>
      [riskBudgetText(c), leverageText(c), usageText(c.riskUsagePct), usageText(c.leverageUsagePct)].join(" | ");

    // 任何一笔出现 NaN，就说明界面读的字段名跟 src 写的不一致了
    for (const c of brief.intents) {
      assert.ok(!cells(c).includes("NaN"), `界面单元格出现 NaN：${cells(c)}`);
      assert.ok(ACTION_TEXT[c.action], `动作缺中文名：${c.action}`);
      assert.ok(STATE_TEXT[rowState(c)], "状态缺文案");
    }

    // ①②：数据齐全的开仓单，四种展示都不能是「—」
    for (const c of brief.intents.slice(0, 2)) {
      assert.ok(!cells(c).includes("—"), `数据齐全的开仓单不该缺字段：${cells(c)}`);
    }
    assert.equal(rowState(brief.intents[0]), "passed");
    assert.equal(rowState(brief.intents[1]), "warned", "②只该是 L2 提示，不该被拦");
    assert.equal(leverageText(brief.intents[1]), "2.2x / 5.0x");
    assert.equal(usageText(brief.intents[1].riskUsagePct), "88% 上限");

    // ③：缺止损 → 被拦；杠杆算不出来，按设计显示「—」而不是 0x
    assert.equal(rowState(brief.intents[2]), "blocked");
    assert.equal(leverageText(brief.intents[2]), "—");
  });

  it("汇总字段能被界面层读出上限（capOf 反推 == guard 的硬顶）", async () => {
    const { buildRiskBrief } = await import("../src/riskbrief.ts");
    const { MAX_LEVERAGE, MAX_RISK_PCT } = await import("../src/guard.ts");
    const brief = buildRiskBrief([mk({ riskPct: 0.02, slDist: 300 })], snap, () => 60_000);

    const leverUsage = maxUsage(brief.intents, "leverageUsagePct");
    const riskUsage = maxUsage(brief.intents, "riskUsagePct");

    // 界面不抄常量，全靠反推 —— 反推结果必须等于 guard 的真实硬顶，
    // 否则界面上显示的「/ 硬顶 5.0x」会是个假数字。
    assert.ok(Math.abs((capOf(brief.maxImpliedLeverage, leverUsage) as number) - MAX_LEVERAGE) < 1e-9);
    assert.ok(Math.abs((capOf(brief.maxRiskPct, riskUsage) as number) - MAX_RISK_PCT) < 1e-12);
  });
});

// ── 月度风控（章程 L1-6）───────────────────────────────────────────────────
//
// 这一块守的是「今天还能不能开新仓」—— 全部硬约束里后果最重的一条
// （不是这笔亏了，是没有下一笔了）。它此前只活在日志与邮件里，现在界面会显示它，
// 而**显示错了不会报错**：一个误判成「正常」的月度回撤，会让人放心地继续下单。
describe("riskbrief-ui · 月度风控（L1-6）", () => {
  /** 真实运行态的样子（archive_round.py 落盘的字段名，snake_case） */
  const rt = (o: Record<string, unknown> = {}) => ({
    round_count: 12,
    equity_usdt: 9700,
    month_dd_pct: -3.5,
    month_pnl_pct: 2.1,
    month_start_equity: 10000,
    month_peak_equity: 10050,
    month_dd_cap_pct: -12.0,
    monthly_target_pct: 10.0,
    l1_6_tripped: false,
    ...o,
  });

  it("熔断判据只认 l1_6_tripped —— 界面不自己拿回撤去比熔断线", () => {
    assert.equal(monthRiskView(rt()).level, "ok");
    assert.equal(monthRiskView(rt({ l1_6_tripped: true })).level, "tripped");
    // 判据说熔断就该显示熔断（哪怕回撤数字看着还没到线）——边界只有一个实现
    assert.equal(monthRiskView(rt({ l1_6_tripped: true, month_dd_pct: -2.0 })).tripped, true);
  });

  it("回撤与判据互相矛盾时如实报「数据不一致」，不替其中一方下结论", () => {
    const v = monthRiskView(rt({ month_dd_pct: -13.4, l1_6_tripped: false }));
    assert.equal(v.level, "inconsistent");
    assert.ok(v.summary.includes("矛盾"), v.summary);
    assert.equal(v.barCls, "lv-over");
  });

  it("80% 熔断线起是提醒；恰好到线（100%）仍只是提醒，越线才是异常", () => {
    assert.equal(ddUsage(-9.6, -12), 80);
    assert.equal(monthRiskView(rt({ month_dd_pct: -9.59 })).level, "ok");
    assert.equal(monthRiskView(rt({ month_dd_pct: -9.6 })).level, "near");
    assert.equal(monthRiskView(rt({ month_dd_pct: -12 })).level, "near");
  });

  it("「没有回撤数据」不许显示成 0.00% —— 那会被读成「安全」", () => {
    const noDd = monthRiskView(rt({ month_dd_pct: undefined }));
    assert.equal(noDd.ddText, "—");
    assert.equal(noDd.usagePct, null);
    assert.equal(noDd.barPct, 0);

    // 0 是有效数据：确实没有回撤
    const zero = monthRiskView(rt({ month_dd_pct: 0 }));
    assert.equal(zero.ddText, "0.00%");
    assert.equal(zero.usagePct, 0);
    assert.equal(zero.level, "ok");
  });

  it("旧运行态没有 l1_6_tripped → unknown，并说清「重跑一轮就能看到」", () => {
    const v = monthRiskView(rt({ l1_6_tripped: undefined }));
    assert.equal(v.level, "unknown");
    assert.equal(v.tagText, MONTH_LEVEL_TEXT.unknown);
    assert.ok(v.summary.includes("重跑一轮"), v.summary);
    // 空串 / 字符串 "false" 都不算布尔判据（宁可说未知，不要猜）
    assert.equal(monthRiskView(rt({ l1_6_tripped: "" })).level, "unknown");
    assert.equal(monthRiskView(rt({ l1_6_tripped: "false" })).level, "unknown");
  });

  it("本轮月度状态算不出来（month_dd_error）→ unknown 且带出原因", () => {
    const v = monthRiskView(
      rt({ month_dd_error: "ValueError: bad equity", month_dd_pct: undefined, l1_6_tripped: undefined })
    );
    assert.equal(v.level, "unknown");
    assert.ok(v.summary.includes("ValueError: bad equity"), v.summary);
  });

  it("没有任何运行态时是 unknown，不是「正常」", () => {
    assert.equal(monthRiskView(null).level, "unknown");
    assert.equal(monthRiskView({}).level, "unknown");
    assert.equal(monthRiskView(undefined).tagText, MONTH_LEVEL_TEXT.unknown);
  });

  it("回撤基准写清楚是「当月峰值」，否则用户拿月初权益对不上账", () => {
    const v = monthRiskView(rt({ month_start_equity: 10000, month_peak_equity: 11000 }));
    assert.ok(v.summary.includes("峰值 11000.00"), v.summary);
    assert.ok(v.summary.includes("月初 10000.00"), v.summary);
  });

  it("零 NaN / 零 undefined：任何输入形态下展示字段都要有内容", () => {
    const inputs = [
      rt(),
      rt({ l1_6_tripped: true }),
      rt({ month_dd_pct: undefined }),
      rt({ month_dd_cap_pct: undefined }),
      rt({ monthly_target_pct: 0 }),
      {},
      { month_dd_pct: "abc", l1_6_tripped: false },
      { month_dd_pct: -3, month_dd_cap_pct: null, l1_6_tripped: false },
    ];
    const fields = [
      "tagText",
      "tagCls",
      "barCls",
      "ddText",
      "capText",
      "pnlText",
      "targetText",
      "progressTip",
      "ddTip",
      "summary",
    ] as const;
    for (const input of inputs) {
      const v = monthRiskView(input as never);
      for (const k of fields) {
        assert.ok(typeof v[k] === "string" && v[k].length > 0, `${k} 缺失（输入 ${JSON.stringify(input)}）`);
        assert.ok(!v[k].includes("NaN"), `${k} 出现 NaN：${v[k]}`);
        assert.ok(!v[k].includes("undefined"), `${k} 出现 undefined：${v[k]}`);
      }
      for (const k of ["barPct", "progressBarPct"] as const) {
        assert.ok(Number.isFinite(v[k]) && v[k] >= 0 && v[k] <= 100, `${k} 越界：${v[k]}`);
      }
    }
  });

  it("界面侧不许再抄一份章程熔断线（阈值只能来自运行态的 month_dd_cap_pct）", () => {
    const src = stripComments(read("ui/lib/riskbrief.js"));
    assert.ok(
      !/-12(\.0+)?\b/.test(src),
      "ui/lib/riskbrief.js 里出现了章程熔断线的字面量 —— 改章程时必然会漂移"
    );
  });

  it("总览页真的把它渲染出来了（不是算完放那儿没人看）", () => {
    const vue = stripComments(read("ui/components/DashboardView.vue"));
    assert.ok(vue.includes("monthRiskView"), "总览页没接月度风控视图");
    assert.ok(vue.includes("month.ddText"), "回撤数值没渲染");
    assert.ok(vue.includes("month.capText"), "熔断线没渲染");
    assert.ok(vue.includes("month.tagText"), "熔断状态标签没渲染");
  });
});
