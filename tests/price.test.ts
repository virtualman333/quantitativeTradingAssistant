/**
 * price.test.ts —— 下单价格格式化（tickSz 网格）的回归测试
 *
 * 为什么需要这份测试
 * ------------------
 * OCO 的触发价必须是 tickSz 的整数倍，否则 OKX 直接拒单；拒单 = 止损失效 =
 * 触碰章程 L1-4「每笔持仓必须存在止损」。而这条逻辑此前在 `main.ts` 与
 * `scalper.ts` 里各写了一份、逐字相同，并且**两份都是错的**：
 *
 *   const decimals = Math.max(0, Math.min(8, Math.round(-Math.log10(tickSz))));
 *
 * 小数位被硬夹到 8 位，而 OKX 全部 468 个 USDT 永续里 tickSz 最小到 1e-12。
 * 用真实行情跑出来的后果（本轮复现，入口价取接口现价、止损距离 0.5%）：
 *
 *   PEPE-USDT-SWAP  tickSz=0.000000001    entry=0.000003363 → 触发价被截成 8 位，不在网格上
 *   BONK-USDT-SWAP  tickSz=0.000000001    entry=0.000002539 → 同上
 *   SHIB-USDT-SWAP  tickSz=0.000000001    entry=0.000004862 → 同上
 *   SATS-USDT-SWAP  tickSz=0.000000000001 entry=9.949e-9     → SL=TP=0.00000001，
 *                                                              **双双跑到入场价上方**，
 *                                                              SL < entry < TP 语义被彻底破坏
 *
 * 所以这里锁两件事：① 小数位必须从 tickSz 自身取，不能夹；② 止损必须严格落在
 * 入场价的亏损侧（距离不足半个 tick 时最近取整会把止损吸回入场价）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { fmtTick, roundToTick, snappedSlTp, tickDecimals, toPlainDecimal } from "../src/price.ts";

/** 断言一个价格字符串确实落在 tickSz 网格上（用整数字符串比较，不用浮点取模）。 */
function onGrid(priceText: string, tickSz: string): boolean {
  const decimals = (tickSz.split(".")[1] ?? "").length;
  const [intPart, fracPart = ""] = priceText.split(".");
  if (fracPart.length > decimals) return false;
  const value = BigInt(`${intPart}${fracPart.padEnd(decimals, "0")}`);
  const tick = BigInt(tickSz.replace(".", ""));
  return value % tick === 0n;
}

// OKX 全部 468 个 USDT 永续的 tickSz 去重后只有这 11 种小数位
// （0 位 3 个 / 1 位 8 个 / 2 位 176 个 / 3 位 41 个 / 4 位 74 个 / 5 位 113 个 /
//  6 位 39 个 / 7 位 8 个 / 8 位 2 个 / 9 位 3 个 / 12 位 1 个）
const REAL_TICKS = ["1", "0.1", "0.01", "0.001", "0.0001", "0.00001", "0.000001", "0.0000001", "0.00000001", "0.000000001", "0.000000000001"];

describe("tickDecimals：小数位只能从 tickSz 自己取", () => {
  it("覆盖 OKX 全部 11 种真实 tick 小数位", () => {
    const expected = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12];
    REAL_TICKS.forEach((tick, i) => {
      assert.equal(tickDecimals(tick), expected[i], `tickSz=${tick}`);
    });
  });

  it("1e-12 不会退化成 8 位（旧实现就是在这里塌掉的）", () => {
    assert.equal(tickDecimals("0.000000000001"), 12);
    assert.equal(tickDecimals(1e-12), 12);
  });

  it("非 10 的整数次幂的步长也数得对（log10 反推会算出 0 位）", () => {
    assert.equal(tickDecimals(0.5), 1);
    assert.equal(tickDecimals(0.25), 2);
    assert.equal(tickDecimals(2.5), 1);
    assert.equal(tickDecimals(0.05), 2);
  });

  it("非法步长返回 0 而不是抛异常", () => {
    assert.equal(tickDecimals(0), 0);
    assert.equal(tickDecimals(-1), 0);
    assert.equal(tickDecimals(Number.NaN), 0);
    assert.equal(tickDecimals(Number.POSITIVE_INFINITY), 0);
  });
});

describe("toPlainDecimal：不出现科学计数法", () => {
  it("展开小到 1e-12 的数", () => {
    assert.equal(toPlainDecimal(1e-12), "0.000000000001");
    assert.equal(toPlainDecimal(9.949e-9), "0.000000009949");
  });

  it("普通数字原样返回", () => {
    assert.equal(toPlainDecimal(6.55), "6.55");
    assert.equal(toPlainDecimal(-1.5), "-1.5");
  });
});

describe("fmtTick：真实 tick 下的取值", () => {
  it("PEPE 触发价保留完整的 9 位小数（旧实现截成 8 位 → 网格外 → 拒单）", () => {
    assert.equal(fmtTick(3.363e-6, 1e-9), "0.000003363");
  });

  it("SATS 触发价保留完整的 12 位小数（旧实现 clamp 到 8 位 → 变成 0.00000001）", () => {
    const text = fmtTick(9.949e-9, 1e-12);
    assert.equal(text, "0.000000009949");
    assert.notEqual(text, "0.00000001");
  });

  it("整数步长不带小数点", () => {
    assert.equal(fmtTick(6.4, 1), "6");
    assert.equal(fmtTick(6.6, 1), "7");
  });

  it("非 10 的整数次幂步长不会被抹掉小数位", () => {
    // 旧实现：-log10(0.5) 四舍五入是 0 → toFixed(0) → 6.5 变成 "7"
    assert.equal(fmtTick(6.5, 0.5), "6.5");
    assert.equal(fmtTick(6.55, 0.05), "6.55");
  });

  it("任何真实 tick 下输出都落在网格上", () => {
    const entries = [0.000003363, 9.949e-9, 0.0839, 1.31, 56.26, 1234.5, 78000.5];
    for (const tick of REAL_TICKS) {
      for (const entry of entries) {
        const text = fmtTick(entry, tick);
        assert.ok(!/e/i.test(text), `出现了科学计数法：${text}`);
        assert.ok(onGrid(text, tick), `不在 tick 网格上：${text} / tick=${tick}（entry=${entry}）`);
      }
    }
  });
});

describe("roundToTick：容差与方向", () => {
  it("浮点误差造成的整格漂移被容忍", () => {
    // 3.363e-6 / 1e-9 = 3362.9999999999995，不加容差会被 floor 成 3362 那一格，
    // 格式化出来是 "0.000003362"。
    assert.equal(fmtTick(3.363e-6, 1e-9), "0.000003363");
    assert.ok(Math.abs(roundToTick(3.363e-6, 1e-9, "down") - 3.363e-6) < 1e-15);
  });

  it("down / up 各朝一个方向（取的都是「离得远的那一格」，否则挡不住方向退化）", () => {
    // 1.234 距下界只 0.4 格，floor 与 round 结果相同 —— 只用它的话，
    // 把 down 改成 round 这条断言照样是绿的，等于没锁住方向。
    assert.equal(roundToTick(1.236, 0.01, "down"), 1.23);
    assert.equal(roundToTick(1.234, 0.01, "up"), 1.24);
    assert.equal(roundToTick(1.234, 0.01, "down"), 1.23);
    assert.equal(roundToTick(1.231, 0.01, "up"), 1.24);
    assert.equal(roundToTick(1.234, 0.01, "nearest"), 1.23);
  });

  it("非法步长时原样返回，不产生 NaN", () => {
    assert.equal(roundToTick(1.23, 0), 1.23);
    assert.equal(roundToTick(1.23, Number.NaN), 1.23);
  });
});

describe("snappedSlTp：止损必须严格在亏损侧", () => {
  it("多头：正常距离下止损在下、止盈在上，且都在网格上", () => {
    const r = snappedSlTp(0.0839, 0.08348, 0.08475, "0.00001");
    assert.ok(r);
    assert.ok(Number(r.slStr) < 0.0839 && Number(r.tpStr) > 0.0839);
    assert.ok(onGrid(r.slStr, "0.00001") && onGrid(r.tpStr, "0.00001"));
  });

  it("止损距离不足半个 tick 时，止损被推到入场价下方整整一个 tick（真实 GPRO 场景）", () => {
    // 真实数据：GPRO-USDT-SWAP entry=1.31 tickSz=0.01，止损距离 0.2% = 0.00262
    // 最近取整会把 1.30738 吸回 1.31 —— 等于挂了一个跟入场价一样的止损。
    const r = snappedSlTp(1.31, 1.31 - 0.00262, 1.31 + 0.00262 * 3, "0.01");
    assert.ok(r);
    assert.equal(r.slStr, "1.30");
    assert.equal(r.tpStr, "1.32");
    assert.ok(Number(r.slStr) < 1.31 && Number(r.tpStr) > 1.31);
  });

  it("空头：止损在上、止盈在下", () => {
    const r = snappedSlTp(1.31, 1.31 + 0.00262, 1.31 - 0.00262 * 3, "0.01");
    assert.ok(r);
    assert.ok(Number(r.slStr) > 1.31, `sl=${r.slStr}`);
    assert.ok(Number(r.tpStr) < 1.31, `tp=${r.tpStr}`);
  });

  it("SATS：1e-12 步长下三档止损距离都保住 SL < entry < TP", () => {
    for (const pct of [0.005, 0.002, 0.01]) {
      const entry = 9.949e-9;
      const d = entry * pct;
      const r = snappedSlTp(entry, entry - d, entry + d * 3, "0.000000000001");
      assert.ok(r, `pct=${pct} 返回 null`);
      assert.ok(Number(r.slStr) < entry, `pct=${pct} sl=${r.slStr} 不在入场价下方`);
      assert.ok(Number(r.tpStr) > entry, `pct=${pct} tp=${r.tpStr} 不在入场价上方`);
      assert.ok(onGrid(r.slStr, "0.000000000001") && onGrid(r.tpStr, "0.000000000001"));
    }
  });

  it("止损被推到 0 以下时拒绝（返回 null），不退一个兜底价", () => {
    // 入场价 0.0155、止损 0.0152，步长 0.01：最近取整把止损吸到 0.02（跑到盈利侧），
    // 于是要往下推一整格 —— 0.01 - 0.01 = 0，挂不出有效止损，必须拒绝。
    assert.equal(snappedSlTp(0.0155, 0.0152, 0.03, "0.01"), null);
    // 入场价本身不足一个 tick，止损取整后是 0
    assert.equal(snappedSlTp(0.005, 0.004, 0.02, "0.01"), null);
  });

  it("止损或止盈与入场价重合时拒绝", () => {
    assert.equal(snappedSlTp(1.31, 1.31, 1.4, "0.01"), null);
    assert.equal(snappedSlTp(1.31, 1.2, 1.31, "0.01"), null);
  });

  it("步长或入场价非法时拒绝", () => {
    assert.equal(snappedSlTp(0, 1, 2, "0.01"), null);
    assert.equal(snappedSlTp(1.31, 1.2, 1.4, 0), null);
    assert.equal(snappedSlTp(1.31, Number.NaN, 1.4, "0.01"), null);
  });
});

describe("结构锁：这条逻辑只允许有一个实现", () => {
  const repo = path.resolve(import.meta.dirname, "..");
  const callers = ["src/main.ts", "src/scalper.ts"];

  it("两个下单入口都从 price.ts 取（不许各自再写一份）", () => {
    for (const rel of callers) {
      const text = fs.readFileSync(path.join(repo, rel), "utf8");
      assert.match(text, /from "\.\/price\.js"/, `${rel} 没有引用共享的 price 模块`);
      assert.ok(!/function\s+fmtTick/.test(text), `${rel} 里又出现了一份本地 fmtTick`);
      assert.ok(!/Math\.min\(8,\s*Math\.round\(-Math\.log10/.test(text), `${rel} 里又出现了「小数位夹到 8 位」的写法`);
    }
  });

  it("触发价只能经 snappedSlTp 产出（不许绕过它直接 fmtTick）", () => {
    for (const rel of callers) {
      const text = fs.readFileSync(path.join(repo, rel), "utf8");
      assert.ok(/snappedSlTp\(/.test(text), `${rel} 没有走 snappedSlTp`);
      assert.ok(!/fmtTick\(/.test(text), `${rel} 仍在使用裸 fmtTick，绕过「止损必须在亏损侧」的保证`);
    }
  });
});
