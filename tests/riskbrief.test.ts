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

import { impliedLeverage, MAX_LEVERAGE, MAX_RISK_PCT,
         SOFT_MAX_NOTIONAL_X, SOFT_MAX_TOTAL_X, MAX_CONCURRENT_INSTS } from "../src/guard.ts";
import { buildRiskBrief, checkExposure, checkIntent, exposureLine, isTradable,
         summarizeRiskBrief } from "../src/riskbrief.ts";
import type { AccountSnapshot, Position, TradeIntent } from "../src/types.ts";
import { read, stripComments, stripPythonCode, walk } from "./_src.ts";

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

    // 与手工组合的结果逐字段对齐（敞口那半块同样要由 buildRiskBrief 自己算出来：
    // 它从 snap.positions 取持仓，若忘了传 specOf 就会静默退化成「全算不出」）
    const manual = summarizeRiskBrief(
      intents.filter(isTradable).map((it) => checkIntent(it, snap(), priceOf(it.inst))),
      checkExposure(snap().positions, snap().equityUsdt)
    );
    assert.deepEqual(brief, manual);
  });

  it("持仓会被真的传进敞口体检（不会被静默丢掉）", () => {
    const s = snap([pos({ inst: "BTC-USDT-SWAP", sizeContracts: 4 })]);
    const b = buildRiskBrief([intent()], s, priceOf, undefined, specOf());
    assert.equal(b.exposure.insts, 1);
    assert.equal(b.exposure.totalX, 4, "持仓没进敞口体检 —— 4 张 × 10000 = 4.0× 权益");
    assert.deepEqual(b.exposure.overInsts, ["BTC-USDT-SWAP"]);
  });

  it("intents 缺失时给出空体检而不是抛错", () => {
    const b = buildRiskBrief(undefined, snap(), priceOf);
    assert.equal(b.total, 0);
    assert.match(b.summary, /无仓位动作/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 敞口体检（章程 §5「敞口上限」表的三条 L2 建议）
//
// 这一块此前**完全不存在**，而它并不是「少个功能」那么轻：
//   - `scripts/trade_round.py` 里躺着 `SOFT_MAX_NOTIONAL_X = 3.0` /
//     `SOFT_MAX_TOTAL_X = 5.0`，注释写着「L2 软约束，仅告警」——
//     **全仓没有一个读取方**，那句告警从来没有响过；
//   - 与之成对的 `ALLOWED_INSTS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]`（注释写着
//     「合规标的（L1-1）」）同样没人读，而且章程 v2.1 已把 L1-1 改成「任意 USDT 永续」；
//   - 与此同时 `scripts/dashboard.py` 的「当前生效规则速查」把
//     「单标的 ≤3.0× 权益，总敞口 ≤5.0× 权益」当**生效规则**印给用户看。
//
// 净效果是：用户读到「有这条约束」，代码里从来没有一处算过它。单笔各自合规、
// 三笔同向叠起来照样能到 6× 权益 —— 而那一刻没有任何东西会说话。
//
// 所以下面第一组断言不看公式，只看它**真的会被算出来**，以及**算不出来时不装成 0**。
// ══════════════════════════════════════════════════════════════════════════

const EQ = 10_000;
/** ctVal=1、标记价 10000 → 「张数」就等于「名义敞口的万分之一」，便于把期望写成人能核对的样子 */
const SPEC: Record<string, number> = {
  "BTC-USDT-SWAP": 1,
  "ETH-USDT-SWAP": 1,
  "SOL-USDT-SWAP": 1,
};
const specOf = (map: Record<string, number> = SPEC) => (inst: string) =>
  map[inst] ? { ctVal: map[inst] } : null;

const pos = (over: Partial<Position> = {}): Position => ({
  inst: "BTC-USDT-SWAP",
  side: "long",
  sizeContracts: 1,
  entry: 10_000,
  mark: 10_000,
  leverage: 1,
  upl: 0,
  ...over,
} as Position);

describe("敞口 · 三条 L2 软上限真的会被算出来", () => {
  it("无持仓时是空结果，摘要说「无持仓」而不是留白", () => {
    const e = checkExposure([], EQ, specOf());
    assert.equal(e.insts, 0);
    assert.deepEqual(e.perInst, []);
    assert.equal(e.totalUsdt, null);
    assert.equal(e.warnings.length, 0);
    assert.match(exposureLine(e), /无持仓/);
    // 空体检的摘要里也要带上敞口那半句（否则用户看到的是「无仓位动作」而不知道敞口
    // 到底算没算 —— 旧版摘要就是只字不提）
    assert.match(summarizeRiskBrief([], e).summary, /无持仓/);
  });

  it("单标的恰好 3.0× 不超限（章程写的是「≤ 3.0」），4× 才超", () => {
    // 3 张 × ctVal1 × 10000 = 30000 = 3.0 × 权益 —— 边界上恰好合规
    const ok = checkExposure([pos({ sizeContracts: 3 })], EQ, specOf());
    assert.equal(ok.perInst[0].x, 3);
    assert.equal(ok.overInsts.length, 0, "恰好等于软上限不该被判超限");
    assert.equal(ok.warnings.length, 0);
    assert.equal(ok.overTotal, false, "单标的 3.0× 时总敞口也是 3.0×，不该红");

    const bad = checkExposure([pos({ sizeContracts: 4 })], EQ, specOf());
    assert.deepEqual(bad.overInsts, ["BTC-USDT-SWAP"]);
    assert.ok(bad.warnings.some((w) => w.includes("敞口超限(L2)") && w.includes("BTC-USDT-SWAP")));
    assert.equal(bad.overTotal, false, "4× 只破单标的线，没破总敞口线");
  });

  it("总敞口恰好 5.0× 不超限，5.1× 超限且说清数字", () => {
    // 两个标的各 2.5× → 合计 5.0×（边界合规）
    const ok = checkExposure(
      [pos({ inst: "BTC-USDT-SWAP", sizeContracts: 2.5 }), pos({ inst: "ETH-USDT-SWAP", sizeContracts: 2.5 })],
      EQ,
      specOf()
    );
    assert.equal(ok.totalX, 5);
    assert.equal(ok.overTotal, false, "恰好等于总敞口软上限不该被判超限");
    assert.equal(ok.overInsts.length, 0);

    // 2.6 + 2.5 = 5.1× → 破总敞口线
    const bad = checkExposure(
      [pos({ inst: "BTC-USDT-SWAP", sizeContracts: 2.6 }), pos({ inst: "ETH-USDT-SWAP", sizeContracts: 2.5 })],
      EQ,
      specOf()
    );
    assert.equal(bad.overTotal, true);
    assert.ok(bad.warnings.some((w) => w.includes("总名义敞口") && w.includes("5.1")));
  });

  it("同时持仓 6 个标的超限，5 个不超（章程：≤5）", () => {
    const six = ["A", "B", "C", "D", "E", "F"].map((k) => pos({ inst: `${k}-USDT-SWAP`, sizeContracts: 0.1 }));
    const e6 = checkExposure(six, EQ, specOf(Object.fromEntries(six.map((p) => [p.inst, 1]))));
    assert.equal(e6.insts, 6);
    assert.equal(e6.overCount, true);
    assert.ok(e6.warnings.some((w) => w.includes("同时持仓")));

    const five = six.slice(0, 5);
    const e5 = checkExposure(five, EQ, specOf(Object.fromEntries(five.map((p) => [p.inst, 1]))));
    assert.equal(e5.overCount, false);
    assert.equal(e5.warnings.length, 0);
  });

  it("算不出敞口时**不折成 0**：进 unpriced、总量声明为下界、并点名是哪几个标的", () => {
    // 缺 ctVal（specOf 返回 null）：这是最危险的一条路 —— 折成 0 的话
    // 界面会显示绿色的「充裕」，而真相是这笔持仓压根没被算进去。
    const e = checkExposure(
      [pos({ inst: "BTC-USDT-SWAP", sizeContracts: 2 }), pos({ inst: "SOL-USDT-SWAP", sizeContracts: 9 })],
      EQ,
      specOf({ "BTC-USDT-SWAP": 1 }) // SOL 没有规格
    );
    assert.deepEqual(e.unpriced, ["SOL-USDT-SWAP"]);
    assert.equal(e.partial, true);
    assert.equal(e.perInst.find((p) => p.inst === "SOL-USDT-SWAP")!.notionalUsdt, null);
    assert.equal(e.perInst.find((p) => p.inst === "SOL-USDT-SWAP")!.x, null);
    // 总量只覆盖已定价部分（20000 = 2.0×），但必须声明这是下界
    assert.equal(e.totalUsdt, 20_000);
    assert.ok(e.warnings.some((w) => w.includes("敞口无法计算") && w.includes("SOL-USDT-SWAP")));
    assert.ok(e.warnings.some((w) => w.includes("不要当成「没有敞口」")));

    // 缺标记价同样算不出（mark 是 0/空串/非数时不许当 0）
    for (const mark of [0, "", null, undefined, NaN]) {
      const bad = checkExposure([pos({ mark: mark as number })], EQ, specOf());
      assert.deepEqual(bad.unpriced, ["BTC-USDT-SWAP"], `mark=${String(mark)} 被折成 0 了`);
      assert.equal(bad.totalUsdt, null);
    }
  });

  it("张数为 0 的持仓是「算出来的 0」，不进 unpriced", () => {
    const e = checkExposure([pos({ sizeContracts: 0 })], EQ, specOf());
    assert.deepEqual(e.unpriced, []);
    assert.equal(e.perInst[0].notionalUsdt, 0);
    assert.equal(e.partial, false);
    assert.equal(e.warnings.length, 0);
  });

  it("敞口超限**不**触发 needsApproval —— 两条 L2 是两回事", () => {
    // needsApproval 只属于「单笔风险 >2% 需人工确认」那条基准。敞口超限是「建议」，
    // 只留痕（日志 + 归档 + 界面）。混在一起会让敞口超限也去敲人工确认，
    // 而这条从没有过闸门，一次重构顺手加上就成了未经决定的行为变更。
    const exp = checkExposure([pos({ sizeContracts: 40 })], EQ, specOf()); // 40× 权益
    assert.equal(exp.overTotal, true);
    assert.ok(exp.warnings.length > 0);
    const brief = summarizeRiskBrief([], exp);
    assert.equal(brief.needsApproval, false, "敞口超限不该伪装成人工确认闸门");
    assert.deepEqual(brief.approvalReasons, []);
    assert.match(brief.summary, /总名义敞口 40\.00× 权益/);
  });

  it("同一标的的多空分仓只算一次（net 模式不该出现，出现也不重复计敞口）", () => {
    const e = checkExposure(
      [pos({ sizeContracts: 2 }), pos({ side: "short", sizeContracts: 2 })],
      EQ,
      specOf()
    );
    assert.equal(e.insts, 1);
    assert.equal(e.totalX, 2, "两笔同标的被重复累加成 4.0× 了");
  });
});

// ── A′. 章程即规格（与 monthguard.test.ts 同一套做法）─────────────────────

describe("章程即规格 · 三条敞口软上限必须等于章程 §5「敞口上限」表的原文数字", () => {
  const charter = read("AGENT_TRADING_RULES.md");
  const rowOf = (key: string) =>
    charter.split("\n").find((l) => l.startsWith("|") && l.includes(key));

  it("单标的 / 总敞口 / 标的数三条都对得上章程原文", () => {
    const per = rowOf("单标的名义敞口");
    const tot = rowOf("全账户总名义敞口");
    const cnt = rowOf("同时持仓标的数");
    assert.ok(per && tot && cnt, "章程里找不到敞口上限那三行 —— 章程结构变了，请同步本测试的解析");

    const numOf = (row: string, what: string) => {
      const m = /×\s*([\d.]+)|≤\s*([\d.]+)/.exec(row);
      assert.ok(m, `${what} 行里解析不出数字：${row}`);
      return Number(m![1] ?? m![2]);
    };
    assert.equal(SOFT_MAX_NOTIONAL_X, numOf(per!, "单标的名义敞口"), "单标的软上限与章程不一致");
    assert.equal(SOFT_MAX_TOTAL_X, numOf(tot!, "全账户总名义敞口"), "总敞口软上限与章程不一致");
    assert.equal(MAX_CONCURRENT_INSTS, numOf(cnt!, "同时持仓标的数"), "持仓标的数上限与章程不一致");
  });

  it("三条上限只在 guard.ts 定义一次，别处不许出现第二份", () => {
    const names = ["SOFT_MAX_NOTIONAL_X", "SOFT_MAX_TOTAL_X", "MAX_CONCURRENT_INSTS"];
    const defRe = new RegExp(`(export\\s+)?const\\s+(${names.join("|")})\\s*=`);
    const files = [...walk("src"), ...walk("scripts", ".mjs"), ...walk("tests")];
    const defs = files.filter((f) => defRe.test(stripComments(read(f))));
    assert.deepEqual(defs, ["src/guard.ts"], `上限被定义了不止一处：${defs.join(", ")}`);

    // trade_round.py 曾经各写一份（SOFT_MAX_*）——「代码里」不许再有，
    // 注释里保留说明是可以的，所以这里剥掉 Python 的注释与字符串再判。
    const py = stripPythonCode(read("scripts/trade_round.py"));
    const lone = names.filter((n) => new RegExp(`^\\s*${n}\\s*=`, "m").test(py));
    assert.deepEqual(lone, [], `trade_round.py 里又出现了敞口常量：${lone.join(", ")}`);
    // 与之成对的过期白名单（章程 v2.1 已放开标的池）也必须绝迹
    assert.ok(
      !/^\s*ALLOWED_INSTS\s*=/m.test(py),
      "trade_round.py 里又出现了 ALLOWED_INSTS —— 章程 v2.1 已改为「任意 USDT 永续」"
    );
  });

  it("dashboard 的「标的范围」那一行是**摘自章程**，不是手抄的旧事实", () => {
    // 手抄的那份曾经写着「BTC-USDT-SWAP / ETH-USDT-SWAP 永续」，而章程 v2.1
    // 早已改成任意 USDT 永续 —— 用户是拿这块表当事实看的，它不该有第二个真值来源。
    // 字符串要留着（那一行本身就是字符串字面量），但 docstring 必须剥掉 ——
    // 这个函数的 docstring 里正写着「此前手抄成 BTC-USDT-SWAP / ETH-USDT-SWAP」，
    // 不剥的话下面那条「别处不许再出现」的断言会被散文满足。
    const db = stripPythonCode(read("scripts/dashboard.py"), { dropStrings: false, dropDocstrings: true });
    const row = db.split("\n").find((l) => l.includes("标的范围"));
    assert.ok(row, "dashboard.py 里的「标的范围」那一行没了 —— 请同步本测试");
    assert.ok(
      /charter_l1_rule\(\s*"L1-1"\s*\)/.test(row!),
      `「标的范围」必须由 charter_l1_rule("L1-1") 摘自章程，当前是：${row!.trim()}`
    );
    assert.ok(
      !/BTC-USDT-SWAP \/ ETH-USDT-SWAP/.test(db),
      "dashboard.py 里又出现了写死的标的范围（章程 v2.1 已放开）"
    );
    // 解析的是 L1 表的「规则」列：章程里确实有这一行
    assert.ok(/^\s*\|\s*\*\*L1-1\*\*/m.test(charter), "章程 L1-1 行不见了");
  });
});
