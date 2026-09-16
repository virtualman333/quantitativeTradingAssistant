/**
 * riskbrief.test.ts —— 每轮「风控体检」的回归测试
 *
 * 为什么需要这份测试
 * ------------------
 * 这份体检表有两个消费者，两边都不能出错：
 *   1. 归档 payload 的 risk_brief 字段 —— 复盘时靠它看「这轮用了多少风险预算」；
 *   2. L2 人工确认告警 —— 靠 needsApproval 决定要不要发邮件提醒。
 *
 * 最需要盯死的是**口径漂移**：隐含杠杆的公式在 guard.ts（硬校验）和
 * riskbrief.ts（体检展示）都会用到。两边一旦各写一份，结果就是
 * 「体检说 4.8x 没问题，guard 却按 6x 拦了」这种对不上的账 ——
 * 所以本文件最后专门有一组断言，遍历参数空间验证两者的判定完全同步。
 *
 * 运行
 * ----
 *     node --test "tests/**\/*.test.ts"
 *     pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { impliedLeverage, MAX_LEVERAGE, MAX_RISK_PCT } from "../src/guard.ts";
import { buildRiskBrief, checkIntent, isTradable, summarizeRiskBrief } from "../src/riskbrief.ts";
import type { AccountSnapshot, Position, TradeIntent } from "../src/types.ts";

// ── 构造工具 ──────────────────────────────────────────────────────────────

const snap = (positions: Position[] = []): AccountSnapshot => ({
  equityUsdt: 10_000,
  availableUsdt: 10_000,
  positions,
  algoOrders: [],
} as AccountSnapshot);

const intent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  inst: "BTC-USDT-SWAP",
  action: "long",
  riskPct: 0.01,
  slDist: 200,
  reason: "测试用理由",
  ...over,
});

/** 默认合法快照的价格函数：BTC 60000 */
const priceOf = (inst: string) => (inst === "BTC-USDT-SWAP" ? 60_000 : 0);

// ── 逐笔体检 ──────────────────────────────────────────────────────────────

describe("riskbrief · checkIntent 逐笔体检", () => {
  it("正常开仓：给出风险比例与隐含杠杆", () => {
    const c = checkIntent(intent(), snap(), 60_000);
    assert.equal(c.ok, true);
    assert.equal(c.riskPct, 0.01);
    // 0.01 / (200 / 60000) = 3.0x
    assert.equal(c.impliedLeverage, 3);
    assert.equal(c.violations.length, 0);
    assert.equal(c.needsApproval, false);
  });

  it("hold 不参与体检（不动仓位、不需要止损）", () => {
    assert.equal(isTradable(intent({ action: "hold", slDist: undefined, riskPct: undefined })), false);
    assert.equal(isTradable(intent({ action: "long" })), true);
  });

  it("close 不需要风险比例与止损：两项指标都记 null，但不违规", () => {
    const c = checkIntent(intent({ action: "close", riskPct: undefined, slDist: undefined }), snap([{
      inst: "BTC-USDT-SWAP", side: "long", sizeContracts: 1, entry: 60_000, mark: 60_000, leverage: 3, upl: 0,
    }] as Position[]), 60_000);
    assert.equal(c.ok, true);
    assert.equal(c.riskPct, null);
    assert.equal(c.impliedLeverage, null);
    assert.equal(c.riskUsagePct, null);
    assert.equal(c.leverageUsagePct, null);
  });

  it("开仓缺止损：体检表直接带上 L1-4 违规，杠杆无数据可算", () => {
    const c = checkIntent(intent({ slDist: undefined }), snap(), 60_000);
    assert.equal(c.ok, false);
    assert.ok(c.violations.some((v) => v.includes("L1-4")));
    assert.equal(c.impliedLeverage, null);
  });

  it("现价未知（refPrice=0）：不猜杠杆，也不误判超限", () => {
    const c = checkIntent(intent({ riskPct: 0.025 }), snap(), 0);
    assert.equal(c.impliedLeverage, null);
    assert.equal(c.leverageUsagePct, null);
    assert.equal(c.ok, true);
  });

  it("单笔风险超 2%：列为需人工确认（L2），但不阻断", () => {
    // 传 refPrice=0 是为了隔离：0.022 + slDist=200 + 现价 60000 会同时把隐含杠杆
    // 推到 6.6x，踩到 L1-2 被拦，那就测不出「只提示不阻断」这条了。
    const c = checkIntent(intent({ riskPct: 0.022 }), snap(), 0);
    assert.equal(c.ok, true);
    assert.equal(c.needsApproval, true);
    assert.equal(c.warnings.length, 1);
  });
});

// ── 预算占比 ──────────────────────────────────────────────────────────────

describe("riskbrief · 预算用量占比", () => {
  it("风险恰好用满硬顶：占比 100%", () => {
    const c = checkIntent(intent({ riskPct: MAX_RISK_PCT }), snap(), 60_000);
    assert.equal(c.riskUsagePct, 100);
  });

  it("风险 2%：占硬顶 80%", () => {
    const c = checkIntent(intent({ riskPct: 0.02 }), snap(), 60_000);
    assert.equal(c.riskUsagePct, 80);
  });

  it("隐含杠杆恰好到顶：占比 100%", () => {
    // slDist/refPrice = 0.005 → lever = riskPct / 0.005；取 riskPct = 0.025 得 5x
    const c = checkIntent(intent({ riskPct: 0.025, slDist: 300 }), snap(), 60_000);
    assert.equal(c.impliedLeverage, MAX_LEVERAGE);
    assert.equal(c.leverageUsagePct, 100);
    assert.equal(c.ok, true, "恰好 5x 不算超（口径为「不得大于」）");
  });
});

// ── 汇总 ──────────────────────────────────────────────────────────────────

describe("riskbrief · summarize 汇总", () => {
  it("没有仓位动作时不编造数字", () => {
    const b = summarizeRiskBrief([]);
    assert.equal(b.total, 0);
    assert.equal(b.maxImpliedLeverage, null);
    assert.equal(b.maxRiskPct, null);
    assert.equal(b.needsApproval, false);
    assert.match(b.summary, /无仓位动作/);
  });

  it("通过 / 提示 / 拦截 三类分别计数", () => {
    const pass = checkIntent(intent({ riskPct: 0.01 }), snap(), 60_000);
    // 同上：隔离 L1-2，只留 L2 提示（refPrice=0 时杠杆无从反推）
    const warn = checkIntent(intent({ riskPct: 0.022 }), snap(), 0);
    const block = checkIntent(intent({ slDist: undefined }), snap(), 60_000);
    const b = summarizeRiskBrief([pass, warn, block]);
    assert.equal(b.total, 3);
    assert.equal(b.passed, 1);
    assert.equal(b.warned, 1);
    assert.equal(b.blocked, 1);
    assert.equal(b.needsApproval, true);
    assert.equal(b.approvalReasons.length, 1);
  });

  it("被拦截的一笔也要计入最大杠杆（拦截不等于没算过）", () => {
    // 6.25x → 触发 L1-2 拦截，但体检表仍应报出 6.25x
    const block = checkIntent(intent({ riskPct: 0.025, slDist: 200 }), snap(), 50_000);
    assert.equal(block.ok, false);
    assert.equal(block.impliedLeverage, 6.25);
    const b = summarizeRiskBrief([block]);
    assert.equal(b.maxImpliedLeverage, 6.25);
  });

  it("摘要里带上最大杠杆与单笔最大风险，便于一眼读", () => {
    const b = summarizeRiskBrief([
      checkIntent(intent({ riskPct: 0.01 }), snap(), 60_000),
      checkIntent(intent({ riskPct: 0.02, slDist: 300 }), snap(), 60_000),
    ]);
    assert.match(b.summary, /最大隐含杠杆 4\.0x/);
    assert.match(b.summary, /单笔最大风险 2\.00%/);
    assert.match(b.summary, /2 笔/);
  });
});

// ── 口径一致性（防漂移） ───────────────────────────────────────────────────

describe("riskbrief · 体检口径与 guard 硬校验完全一致", () => {
  it("隐含杠杆公式：抽出的 impliedLeverage 与常量口径自洽", () => {
    assert.equal(impliedLeverage(0.01, 200, 60_000), 3);
    assert.equal(impliedLeverage(0, 200, 60_000), null, "无风险比例不猜");
    assert.equal(impliedLeverage(0.01, 0, 60_000), null, "无止损距离不猜");
    assert.equal(impliedLeverage(0.01, 200, 0), null, "无现价不猜");
  });

  it("遍历参数空间：体检显示的超限 当且仅当 guard 判 L1-2 违规", () => {
    const riskPcts = [0.005, 0.01, 0.01666, 0.02, 0.025];
    const slDists = [50, 100, 200, 300, 500];
    const prices = [0, 30_000, 60_000, 100_000];
    let cases = 0;

    for (const riskPct of riskPcts) {
      for (const slDist of slDists) {
        for (const refPrice of prices) {
          const c = checkIntent(intent({ riskPct, slDist }), snap(), refPrice);
          const guardSaysOver = c.violations.some((v) => v.includes("L1-2"));
          const briefSaysOver = c.impliedLeverage !== null && c.impliedLeverage > MAX_LEVERAGE;
          assert.equal(
            briefSaysOver,
            guardSaysOver,
            `口径对不上：riskPct=${riskPct} slDist=${slDist} price=${refPrice} ` +
              `体检杠杆=${c.impliedLeverage} 但 guard 判定=${guardSaysOver}`
          );
          cases += 1;
        }
      }
    }
    assert.ok(cases >= 100, `参数空间太小（只跑了 ${cases} 组），防不住漂移`);
  });
});

// ── 便捷入口 ──────────────────────────────────────────────────────────────

describe("riskbrief · buildRiskBrief 便捷入口", () => {
  it("自动跳过 hold，且与逐笔 + 汇总的组合结果一致", () => {
    const intents = [
      intent({ riskPct: 0.01 }),
      intent({ inst: "ETH-USDT-SWAP", action: "hold", riskPct: undefined, slDist: undefined }),
      intent({ inst: "SOL-USDT-SWAP", riskPct: 0.022 }),
    ];
    const brief = buildRiskBrief(intents, snap(), priceOf);

    assert.equal(brief.total, 2, "hold 不计入体检");
    assert.equal(brief.intents.length, 2);
    assert.equal(brief.warned, 1);
    assert.equal(brief.needsApproval, true);

    // 与手工组合的结果逐字段对齐
    const manual = summarizeRiskBrief(
      intents.filter(isTradable).map((it) => checkIntent(it, snap(), priceOf(it.inst)))
    );
    assert.deepEqual(brief, manual);
  });

  it("intents 缺失时给出空体检而不是抛错", () => {
    const b = buildRiskBrief(undefined, snap(), priceOf);
    assert.equal(b.total, 0);
    assert.match(b.summary, /无仓位动作/);
  });
});
