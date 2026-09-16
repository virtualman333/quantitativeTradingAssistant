/**
 * priceformat.test.ts —— 界面价格展示口径的契约测试（`ui/lib/format.js::fmtPrice`）
 *
 * 为什么需要这份测试
 * ------------------
 * 界面上「价格」和「金额」是两种东西，却长期共用 `fmtNum(v, 2)`：
 *   · 金额（权益 / 浮盈 / 手续费）固定 2 位是对的；
 *   · 价格不行 —— 同一个界面里价格能差 12 个数量级。实测 OKX 当日 483 个 USDT 永续：
 *     BTC 75815，SATS 9.949e-9。固定 2 位小数会让**价格 < 0.005 的 30 个标的**
 *     在持仓页/总览页的「开仓价 / 标记价 / 强平价」全部显示成 `0.00`。
 * 前一版局部实现的 `d = a >= 0.01 ? 5 : 8` 也有同类缺陷：SATS 被写成 `0.00000001`，
 * 只剩 1 位有效数字 —— 同一页面里入场价与标记价会显示成同一个数。
 *
 * 而且这段逻辑曾在 **4 个组件里各写一份**（DashboardView / MarketView / KlineChart /
 * KlineWindow），只改一处必然漂移。本文件锁两件事：
 *   1. **行为**：非零价格不得显示成 0.00、不得出现科学计数法、有效数字 ≥ 4；
 *   2. **结构**：`fmtPrice` 的定义只允许有一处，且在 `ui/lib/format.js`。
 *
 * 反向验证（本文件的设计要求）：把 `fmtPrice` 改回旧规则（`d = … : 8`），
 * 「有效数字 ≥ 4」与「SATS 不出现在旧字符串里」两条必须变红；把某个组件里的
 * 本地副本加回去，结构锁必须变红。
 *
 * 运行
 * ----
 *     pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { fmtNum, fmtPrice, PRICE_MIN_SIG } from "../ui/lib/format.js";

/** 2026-09-16 OKX 全量 USDT 永续的真实 last 快照（按价格升序，取两端的代表值） */
const REAL_PRICES: [string, number][] = [
  ["SATS-USDT-SWAP", 9.949e-9],
  ["BONK-USDT-SWAP", 2.539e-6],
  ["PEPE-USDT-SWAP", 3.363e-6],
  ["SHIB-USDT-SWAP", 4.862e-6],
  ["FLOKI-USDT-SWAP", 2.32e-5],
  ["HMSTR-USDT-SWAP", 0.0001556],
  ["MEW-USDT-SWAP", 0.0003806],
  ["STABLE-USDT-SWAP", 0.02683],
  ["PNUT-USDT-SWAP", 0.044],
  ["DOGE-USDT-SWAP", 0.2134],
  ["ETH-USDT-SWAP", 2524.86],
  ["BTC-USDT-SWAP", 75815],
];

/** 有效数字位数（小数位里的尾随零也算，因为它标明了精度） */
function sigFigs(formatted: string): number {
  const frac = formatted.replace(/,/g, "").split(".")[1] ?? "";
  return frac.replace(/^0+/, "").length;
}

/** 前一版局部实现的规则（四个组件里逐字相同的那份），仅用于反向对照 */
function legacyFmtPrice(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 递归收集 ui/ 下的源码文件 */
function uiSources(): string[] {
  const root = path.resolve(import.meta.dirname, "..", "ui");
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.(vue|js|ts)$/.test(p))
    .map((p) => path.join(root, p));
}

describe("fmtPrice · 非零价格不得被显示成 0", () => {
  it("真实行情里的极小数一个都不能变成 0.00（旧规则下 30 个标的会）", () => {
    for (const [inst, px] of REAL_PRICES) {
      const s = fmtPrice(px);
      assert.notEqual(s, "0.00", `${inst} ${px} 被显示成了 0.00`);
      assert.notEqual(Number(s.replace(/,/g, "")), 0, `${inst} ${px} 显示值为 0`);
    }
  });

  it("旧实现（fmtNum(v, 2)）确实会把它们显示成 0.00 —— 证明这条锁指向真实缺陷", () => {
    // 样本里 price < 0.005 的有 7 个（SATS/BONK/PEPE/SHIB/FLOKI/HMSTR/MEW）
    const broken = REAL_PRICES.filter(([, px]) => fmtNum(px, 2) === "0.00");
    assert.ok(broken.length >= 7, `只有 ${broken.length} 个样本能体现缺陷，样本选得太温和`);
  });

  it("绝不出现科学计数法（直接打印原始 number 才会有）", () => {
    for (const [, px] of REAL_PRICES) {
      const s = fmtPrice(px);
      assert.ok(!/e/i.test(s), `${px} 输出成了科学计数法：${s}`);
    }
  });

  it(`有效数字不少于 ${PRICE_MIN_SIG} 位（价格 < 1000 时）`, () => {
    for (const [inst, px] of REAL_PRICES) {
      if (px >= 1000) continue;
      const s = fmtPrice(px);
      assert.ok(
        sigFigs(s) >= PRICE_MIN_SIG,
        `${inst} ${px} → ${s} 只有 ${sigFigs(s)} 位有效数字`
      );
    }
  });

  it("SATS（1e-9 量级）不再被压成前一版的 0.00000001", () => {
    const sat = 9.949e-9;
    assert.equal(legacyFmtPrice(sat), "0.00000001", "旧规则的行为变了，反向对照失效");
    assert.equal(fmtPrice(sat), "0.000000009949");
    assert.notEqual(fmtPrice(sat), legacyFmtPrice(sat));
    assert.ok(sigFigs(fmtPrice(sat)) > sigFigs(legacyFmtPrice(sat)));
  });
});

describe("fmtPrice · 常规价格的形状（不因修小数而被改坏）", () => {
  it("大价格仍按 2 位小数、带千分位", () => {
    assert.equal(fmtPrice(75815), "75,815.00");
    assert.equal(fmtPrice(2524.86), "2,524.86");
  });

  it("≥1 的中间价给 4 位小数", () => {
    assert.equal(fmtPrice(1.5), "1.5000");
    assert.equal(fmtPrice(12.34567), "12.3457");
  });

  it("<1 的价格按有效数字给位，且不少于 5 位小数", () => {
    assert.equal(fmtPrice(0.02683), "0.02683"); // 前导零 1 个 → 5 位小数
    assert.equal(fmtPrice(0.044), "0.04400"); // 5 位小数下限：4 位有效数字
    assert.equal(fmtPrice(0.0005054), "0.0005054"); // 前导零 3 个 → 7 位小数，仍是 4 位有效数字
  });

  it("0 / 空值 / 非有限数的约定", () => {
    assert.equal(fmtPrice(0), "0.00");
    assert.equal(fmtPrice(null), "—");
    assert.equal(fmtPrice(undefined), "—");
    assert.equal(fmtPrice(""), "—");
    assert.equal(fmtPrice(Number.NaN), "—");
    assert.equal(fmtPrice(Number.POSITIVE_INFINITY), "—");
  });

  it("数字字符串（交易所回传的触发价就是字符串）照常处理", () => {
    assert.equal(fmtPrice("0.000000009949"), "0.000000009949");
    assert.equal(fmtPrice("2524.86"), "2,524.86");
  });

  it("极度小于 toFixed 上限时退回原始数值，而不是 0.00", () => {
    const s = fmtPrice(1e-20);
    assert.notEqual(s, "0.00", "兜底失效：小于 toFixed 上限的价格被四舍五入成 0");
    assert.notEqual(Number(s), 0);
  });
});

describe("fmtPrice · 结构锁（防再抄一份）", () => {
  it("全 ui/ 里 fmtPrice 的定义只有一处，且在 lib/format.js", () => {
    const defs: string[] = [];
    for (const f of uiSources()) {
      const src = fs.readFileSync(f, "utf8");
      // 定义形态：function fmtPrice / const fmtPrice = / let fmtPrice =
      if (/(?:function\s+fmtPrice\s*\(|(?:const|let|var)\s+fmtPrice\s*=)/.test(src)) {
        defs.push(path.relative(path.resolve(import.meta.dirname, ".."), f).replace(/\\/g, "/"));
      }
    }
    assert.deepEqual(defs, ["ui/lib/format.js"], `价格格式化又出现多份实现：${defs.join(", ")}`);
  });

  it("每个价格字段的渲染都走 fmtPrice（金额用 fmtNum 不算）", () => {
    // 价格字段白名单：出现即必须套 fmtPrice。改名/新增价格列时把它加进来。
    // **要求带点号前缀**：真实渲染一律是 `x.entry` / `x.mark` 这种形态，
    // 这样 `fmtVol(last.v)`（last 在这里是个蜡烛对象，不是价格）不会被误判；
    // `\b` 也让 `entryTs` / `liqDist` 这类同前缀字段天然不命中。
    const PRICE_FIELD =
      /\.(?:entry|entryPrice|entry_ref|exit|mark|markPx|markPrice|avgPx|liq|liqPrice|sl|tp|slTrigger|tpTrigger|last|high24h|low24h)\b/;

    const offenders: string[] = [];
    for (const f of uiSources()) {
      if (f.endsWith("lib\\format.js") || f.endsWith("lib/format.js")) continue;
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/\{\{([^}]*)\}\}/g)) {
        const expr = m[1].replace(/\s+/g, " ").trim();
        if (!PRICE_FIELD.test(expr)) continue;
        if (expr.includes("fmtPrice(")) continue;
        offenders.push(`${path.basename(f)}: {{ ${expr} }}`);
      }
    }
    assert.deepEqual(offenders, [], `这些价格没有走 fmtPrice：\n${offenders.join("\n")}`);
  });
});
