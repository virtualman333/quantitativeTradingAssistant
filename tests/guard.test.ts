/**
 * guard.test.ts —— L1 硬约束风控层的回归测试
 *
 * 为什么需要这份测试
 * ------------------
 * guard.ts 是「LLM 意图 → 能否下单」之间唯一的硬闸门，它把章程 §1 的 L1 条款
 * 固化成代码。此前它没有任何测试：任何一次重构/改阈值，都可能静默地把 5x 杠杆
 * 上限、止损必挂、禁双向这些约束弄失效——而这类失效的代价不是"这笔亏了"，
 * 而是"没有下一笔了"（见章程 §1 各条理由）。
 *
 * 因此本文件逐条对着章程 L1-1/2/4/5/7/9/10 写断言，任何一条被改坏都会红灯。
 *
 * 运行
 * ----
 *     node --test tests/          # 零额外依赖：Node 22 原生跑 TS + 内置 test runner
 *     pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { guardDecision, guardIntent } from "../src/guard.ts";
import type { Deviation, GuardResult, Position, TradeIntent } from "../src/types.ts";

// ── 构造工具 ──────────────────────────────────────────────────────────────

const snap = (positions: Position[] = []) => ({
  equityUsdt: 10_000,
  availableUsdt: 10_000,
  positions,
  algoOrders: [],
});

/** 造一个「默认合法」的开仓意图，测试只覆盖关心的字段。 */
const intent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  inst: "BTC-USDT-SWAP",
  action: "long",
  riskPct: 0.01,
  slDist: 200,
  reason: "测试用理由",
  ...over,
});

const pos = (over: Partial<Position> = {}): Position => ({
  inst: "BTC-USDT-SWAP",
  side: "long",
  sizeContracts: 1,
  entry: 60_000,
  mark: 60_000,
  leverage: 3,
  upl: 0,
  ...over,
});

/** 违规列表里是否含某条 L1 编号（如 "L1-4"）。 */
const hit = (r: GuardResult, tag: string) => r.violations.some((v) => v.includes(tag));

/** 全五项齐全的合规偏离记录。 */
const deviation = (over: Partial<Deviation> = {}): Deviation => ({
  baseline: "§4.1 路径 A 共振门槛",
  actual: "共振分 3/5",
  rationale: "资金费率极值 + 消息面共振，判定为低延迟机会",
  falsifier: "4 小时内若未创 24h 新高，则本条裁量证伪并回归基准",
  riskDelta: "较基准多承担 0.4% 权益风险",
  ...over,
});

// ── 基线 ─────────────────────────────────────────────────────────────────

describe("guard · 基线", () => {
  it("合规开仓应无违规、无告警", () => {
    const r = guardIntent(intent(), snap(), 60_000);
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.ok, true);
    assert.equal(r.needsApproval, false);
  });

  it("空快照下的合法开仓同样通过", () => {
    const r = guardIntent(intent({ inst: "SOL-USDT-SWAP" }), snap(), 150);
    assert.equal(r.ok, true);
  });
});

// ── L1-1 仅 USDT 计价永续 ─────────────────────────────────────────────────

describe("guard · L1-1 标的须为 USDT 计价", () => {
  it("非 USDT 计价（USDC）被拒", () => {
    const r = guardIntent(intent({ inst: "BTC-USDC-SWAP" }), snap(), 60_000);
    assert.equal(r.ok, false);
    assert.ok(hit(r, "L1-1"));
  });

  it("USD 计价（币本位）被拒", () => {
    const r = guardIntent(intent({ inst: "BTC-USD-SWAP" }), snap(), 60_000);
    assert.equal(hit(r, "L1-1"), true);
  });

  it("空标的被拒", () => {
    const r = guardIntent(intent({ inst: "   " }), snap(), 60_000);
    assert.ok(hit(r, "L1-1"));
  });

  it("传了 knownInsts 时，池外标的被拒（USDT 格式正确也不放行）", () => {
    const pool = new Set(["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
    const r = guardIntent(intent({ inst: "DOGE-USDT-SWAP" }), snap(), 1, pool);
    assert.ok(hit(r, "L1-1"));
  });

  it("传了 knownInsts 时，池内标的放行", () => {
    const pool = new Set(["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
    const r = guardIntent(intent({ inst: "ETH-USDT-SWAP" }), snap(), 3_000, pool);
    assert.equal(r.ok, true);
  });

  it("knownInsts 为空集合时不启用白名单（避免误拦全部）", () => {
    const r = guardIntent(intent(), snap(), 60_000, new Set());
    assert.equal(r.ok, true);
  });
});

// ── 理由必填 ─────────────────────────────────────────────────────────────

describe("guard · 决策理由必填", () => {
  it("理由为空被拒", () => {
    const r = guardIntent(intent({ reason: "  " }), snap(), 60_000);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.includes("缺少决策理由")));
  });
});

// ── L1-4 止损必挂 ────────────────────────────────────────────────────────

describe("guard · L1-4 开仓必须带止损", () => {
  it("slDist 缺失被拒", () => {
    const r = guardIntent(intent({ slDist: undefined }), snap(), 60_000);
    assert.ok(hit(r, "L1-4"));
  });

  it("slDist = 0 被拒", () => {
    const r = guardIntent(intent({ slDist: 0 }), snap(), 60_000);
    assert.ok(hit(r, "L1-4"));
  });

  it("slDist 为负被拒", () => {
    const r = guardIntent(intent({ slDist: -50 }), snap(), 60_000);
    assert.ok(hit(r, "L1-4"));
  });

  it("平仓意图不要求止损", () => {
    const r = guardIntent(intent({ action: "close", slDist: undefined, riskPct: undefined }),
      snap([pos()]), 60_000);
    assert.equal(hit(r, "L1-4"), false);
    assert.equal(r.ok, true);
  });

  it("观望意图不要求止损与风险比例", () => {
    const r = guardIntent(intent({ action: "hold", slDist: undefined, riskPct: undefined }),
      snap([pos()]), 60_000);
    assert.equal(r.ok, true);
  });
});

// ── L1-5 单笔风险 ≤ 2.5% ────────────────────────────────────────────────

describe("guard · L1-5 单笔风险硬顶 2.5%", () => {
  // 本组只验「单笔风险比例」边界，故一律传 refPrice=0 关闭 L1-2 杠杆反推——
  // 否则 2%~2.5% 的风险配 200 点止损会反推出 6~7.5x 杠杆，把两个约束缠在一起。
  it("riskPct 缺失被拒", () => {
    const r = guardIntent(intent({ riskPct: undefined }), snap(), 0);
    assert.ok(hit(r, "L1-5"));
  });

  it("riskPct = 0 被拒（等同未声明风险）", () => {
    const r = guardIntent(intent({ riskPct: 0 }), snap(), 0);
    assert.ok(hit(r, "L1-5"));
  });

  it("3% 超硬顶被拒", () => {
    const r = guardIntent(intent({ riskPct: 0.03 }), snap(), 0);
    assert.equal(r.ok, false);
    assert.ok(hit(r, "L1-5"));
  });

  it("恰好 2.5% 不违规（边界取「不得超过」）", () => {
    const r = guardIntent(intent({ riskPct: 0.025 }), snap(), 0);
    assert.equal(hit(r, "L1-5"), false);
    assert.equal(r.ok, true);
    assert.equal(r.needsApproval, true, "2.5% 仍应触发人工确认告警");
  });

  it("2.2% 不违规但需人工确认（L2 基准 2%）", () => {
    const r = guardIntent(intent({ riskPct: 0.022 }), snap(), 0);
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.needsApproval, true);
    assert.ok(r.approvalReason);
  });

  it("恰好 2% 不告警（边界取「超过 2%」）", () => {
    const r = guardIntent(intent({ riskPct: 0.02 }), snap(), 0);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.needsApproval, false);
  });
});

// ── L1-2 隐含杠杆 ≤ 5x ──────────────────────────────────────────────────

describe("guard · L1-2 隐含杠杆 ≤ 5x", () => {
  it("反推杠杆 6x 被拒", () => {
    // riskPct/(slDist/refPrice) = 0.02 / (200/60000) = 6
    const r = guardIntent(intent({ riskPct: 0.02, slDist: 200 }), snap(), 60_000);
    assert.ok(hit(r, "L1-2"));
  });

  it("反推杠杆 3x 放行", () => {
    // 0.01 / (200/60000) = 3
    const r = guardIntent(intent({ riskPct: 0.01, slDist: 200 }), snap(), 60_000);
    assert.equal(hit(r, "L1-2"), false);
    assert.equal(r.ok, true);
  });

  it("refPrice 未知（0）时跳过杠杆校验，不误报", () => {
    const r = guardIntent(intent({ riskPct: 0.02, slDist: 200 }), snap(), 0);
    assert.equal(hit(r, "L1-2"), false);
    assert.equal(r.ok, true);
  });

  it("窄止损（高杠杆）在 2.5% 风险内也会被拦", () => {
    // 0.02 / (60/60000) = 20x —— 风险比例合法但杠杆超限
    const r = guardIntent(intent({ riskPct: 0.02, slDist: 60 }), snap(), 60_000);
    assert.ok(hit(r, "L1-2"));
  });
});

// ── L1-9 禁双向 / L1-10 禁亏损加仓 ──────────────────────────────────────

describe("guard · L1-9 同一标的禁双向", () => {
  it("已有多仓时做空被拒", () => {
    const r = guardIntent(intent({ action: "short" }), snap([pos({ side: "long" })]), 60_000);
    assert.ok(hit(r, "L1-9"));
  });

  it("已有空仓时做多被拒", () => {
    const r = guardIntent(intent({ action: "long" }),
      snap([pos({ side: "short", upl: 10 })]), 60_000);
    assert.ok(hit(r, "L1-9"));
  });

  it("已有多仓时同向加仓不触发 L1-9", () => {
    const r = guardIntent(intent({ action: "long" }),
      snap([pos({ side: "long", upl: 50 })]), 60_000);
    assert.equal(hit(r, "L1-9"), false);
  });
});

describe("guard · L1-10 亏损仓位禁加仓摊薄", () => {
  it("浮亏仓位同向加仓被拒", () => {
    const r = guardIntent(intent({ action: "long" }),
      snap([pos({ side: "long", upl: -30 })]), 60_000);
    assert.ok(hit(r, "L1-10"));
  });

  it("盈利仓位允许金字塔加仓（属 L2 裁量）", () => {
    const r = guardIntent(intent({ action: "long" }),
      snap([pos({ side: "long", upl: 120 })]), 60_000);
    assert.equal(r.ok, true);
  });

  it("浮亏为 0（平价）不算亏损仓，不拦", () => {
    const r = guardIntent(intent({ action: "long" }),
      snap([pos({ side: "long", upl: 0 })]), 60_000);
    assert.equal(r.ok, true);
  });

  it("持仓在别的标的上时不影响本标的开仓", () => {
    const r = guardIntent(intent({ inst: "ETH-USDT-SWAP" }),
      snap([pos({ inst: "BTC-USDT-SWAP", upl: -500 })]), 3_000);
    assert.equal(r.ok, true);
  });
});

// ── L1-7 偏离留痕五项齐全 ────────────────────────────────────────────────

describe("guard · L1-7 裁量偏离留痕五项齐全", () => {
  it("五项齐全的偏离放行", () => {
    const r = guardIntent(intent({ deviations: [deviation()] }), snap(), 60_000);
    assert.equal(r.ok, true);
  });

  it("缺 falsifier（可证伪预判）被拒，且报出缺失字段名", () => {
    const r = guardIntent(intent({ deviations: [deviation({ falsifier: "" })] }), snap(), 60_000);
    assert.equal(r.ok, false);
    assert.ok(hit(r, "L1-7"));
    assert.ok(r.violations.some((v) => v.includes("falsifier")));
  });

  it("多条偏离逐条校验，报出缺失并集", () => {
    const r = guardIntent(
      intent({
        deviations: [
          deviation({ baseline: "" }),
          deviation({ riskDelta: "   " }),
        ],
      }),
      snap(),
      60_000
    );
    assert.equal(r.violations.filter((v) => v.includes("L1-7")).length, 2);
  });

  it("空 deviations 数组不触发 L1-7", () => {
    const r = guardIntent(intent({ deviations: [] }), snap(), 60_000);
    assert.equal(r.ok, true);
  });
});

// ── guardDecision 批量 ───────────────────────────────────────────────────

describe("guard · guardDecision 批量校验", () => {
  it("保持入参顺序，且逐条独立判定", () => {
    const intents: TradeIntent[] = [
      intent({ inst: "BTC-USDT-SWAP" }),
      intent({ inst: "ETH-USDT-SWAP", slDist: 0 }),      // L1-4
      intent({ inst: "SOL-USDT-SWAP" }),
    ];
    const prices: Record<string, number> = {
      "BTC-USDT-SWAP": 60_000,
      "ETH-USDT-SWAP": 3_000,
      "SOL-USDT-SWAP": 150,
    };
    const rs = guardDecision(intents, snap(), (inst) => prices[inst] ?? 0);
    assert.equal(rs.length, 3);
    assert.deepEqual(rs.map((r) => r.ok), [true, false, true]);
    assert.ok(hit(rs[1], "L1-4"));
  });

  it("空意图列表返回空结果，不抛异常", () => {
    assert.deepEqual(guardDecision([], snap(), () => 0), []);
  });

  it("列表为 undefined 时返回空数组（防御 LLM 输出缺字段）", () => {
    assert.deepEqual(
      guardDecision(undefined as unknown as TradeIntent[], snap(), () => 0),
      []
    );
  });
});
