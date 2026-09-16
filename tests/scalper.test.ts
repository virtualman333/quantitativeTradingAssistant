/**
 * scalper.test.ts —— 回测 CLI 参数契约测试（backtestArgv）
 *
 * 为什么需要这份测试
 * ------------------
 * 用户看到的每一个回测数字，都来自这条 argv → `scripts/scalper_backtest.py` 的链路。
 * 参数拼错/漏拼**不会报错**，只会让回测悄悄按默认值跑：用户以为自己在测「RR=3、
 * 滑点 5bp、最多持仓 30 根」，看到的其实是「RR 默认、零滑点、不限持仓」的结果，
 * 并据此调策略——错得很安静。
 *
 * 此前这里的问题正是如此：argv 有**两份手写实现**（同步版 `runScalperBacktest`
 * 与 job 版 `backtestArgv`），同步版漏掉了 `--rr` / `--slippage-bps` /
 * `--max-hold` / `--job-id`。现已收敛为 `backtestArgv` 单一来源，本文件把
 * 「哪些参数必须传、什么值必须不传」锁死，防止再次漂移。
 *
 * 运行
 * ----
 *     pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { backtestArgv } from "../src/scalper.ts";
import { strategyDir } from "../src/strategies.ts";

// ── 构造工具 ──────────────────────────────────────────────────────────────

/** 只给必填项的基准调用。 */
const base = { inst: "BTC-USDT-SWAP", start: "2026-09-01 00:00" };

/** 取 flag 后面跟的值；不存在返回 undefined。 */
const val = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
};

/** argv 里每个 `--flag` 的出现次数（用于「不得重复」断言）。 */
const count = (argv: string[], flag: string): number =>
  argv.filter((a) => a === flag).length;

describe("backtestArgv 基础形态", () => {
  it("只给必填项时不夹带任何可选参数", () => {
    assert.deepEqual(backtestArgv(base), [
      "--inst",
      "BTC-USDT-SWAP",
      "--start",
      "2026-09-01 00:00",
    ]);
  });

  it("bar 缺省与显式 1m 都不传 --bar（1m 是脚本默认，传了只是噪音）", () => {
    assert.equal(val(backtestArgv(base), "--bar"), undefined);
    assert.equal(val(backtestArgv({ ...base, bar: "1m" }), "--bar"), undefined);
  });

  it("bar 非 1m 时按原值传入", () => {
    assert.equal(val(backtestArgv({ ...base, bar: "15m" }), "--bar"), "15m");
  });

  it("所有带值的 flag 都成对出现，且同一 flag 不重复", () => {
    const argv = backtestArgv({
      ...base,
      bar: "5m",
      end: "2026-09-10 00:00",
      atrMult: 2.5,
      feeRate: 0.0005,
      notional: 500,
      rr: 2.4,
      slippageBps: 5,
      maxHold: 30,
      jobId: "bt123",
      strategyId: "breakout",
      closeOnReversal: true,
    });
    for (let i = 0; i < argv.length; i++) {
      if (!argv[i]!.startsWith("--")) continue;
      // 布尔开关后面不跟值，跳过；其余 flag 后面必须是值
      if (argv[i] === "--close-on-reversal") continue;
      assert.ok(argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--"),
        `flag ${argv[i]} 后面缺值`);
    }
    for (const f of ["--inst", "--start", "--end", "--bar", "--atr-mult", "--fee-rate",
      "--notional", "--rr", "--slippage-bps", "--max-hold", "--job-id", "--strategy"]) {
      assert.equal(count(argv, f), 1, `${f} 应恰好出现 1 次`);
    }
  });
});

describe("backtestArgv 数值参数", () => {
  it("rr / slippageBps / maxHold 为 0 或缺省时不传（0 = 用脚本默认，不是「设成 0」）", () => {
    const argv = backtestArgv({ ...base, rr: 0, slippageBps: 0, maxHold: 0 });
    assert.equal(val(argv, "--rr"), undefined);
    assert.equal(val(argv, "--slippage-bps"), undefined);
    assert.equal(val(argv, "--max-hold"), undefined);
  });

  it("rr / slippageBps / maxHold 显式给值时必须传到（本轮修复的漏传项）", () => {
    const argv = backtestArgv({ ...base, rr: 2.4, slippageBps: 5, maxHold: 30 });
    assert.equal(val(argv, "--rr"), "2.4");
    assert.equal(val(argv, "--slippage-bps"), "5");
    assert.equal(val(argv, "--max-hold"), "30");
  });

  it("atrMult / feeRate / notional 数字一律按字符串传入", () => {
    const argv = backtestArgv({ ...base, atrMult: 2.5, feeRate: 0.0005, notional: 500 });
    assert.equal(val(argv, "--atr-mult"), "2.5");
    assert.equal(val(argv, "--fee-rate"), "0.0005");
    assert.equal(val(argv, "--notional"), "500");
    // 必须是字符串：脚本侧 argparse 收的是字符串，传 number 会让 spawn 参数类型不一
    for (const f of ["--atr-mult", "--fee-rate", "--notional"]) {
      assert.equal(typeof val(argv, f), "string");
    }
  });

  it("atrMult / feeRate / notional 用 != null 判定，0 会照传（与 rr 组不同，属既有契约）", () => {
    // 记录既有行为，避免无意改变；注意 atr-mult=0 会让止损距离为 0，调用方不应传 0
    const argv = backtestArgv({ ...base, atrMult: 0, feeRate: 0, notional: 0 });
    assert.equal(val(argv, "--atr-mult"), "0");
    assert.equal(val(argv, "--fee-rate"), "0");
    assert.equal(val(argv, "--notional"), "0");
  });
});

describe("backtestArgv 开关与路径", () => {
  it("closeOnReversal 是布尔开关，只出现一次且不带值", () => {
    const off = backtestArgv(base);
    assert.equal(count(off, "--close-on-reversal"), 0);
    const on = backtestArgv({ ...base, closeOnReversal: true });
    assert.equal(count(on, "--close-on-reversal"), 1);
    // 开关必须落在末尾组，不能把后面的参数顶成它的「值」
    assert.ok(!on[on.indexOf("--close-on-reversal") + 1]?.startsWith("2026"));
  });

  it("strategyId 转成策略目录绝对路径，而不是原样透传 id", () => {
    const argv = backtestArgv({ ...base, strategyId: "breakout" });
    const p = val(argv, "--strategy");
    assert.equal(p, strategyDir("breakout"));
    assert.ok(p!.includes("breakout"));
    assert.notEqual(p, "breakout");
  });

  it("strategyId 缺省时不传 --strategy（用 scalper.py 内置规则判向）", () => {
    assert.equal(val(backtestArgv(base), "--strategy"), undefined);
    assert.equal(val(backtestArgv({ ...base, strategyId: "" }), "--strategy"), undefined);
  });

  it("jobId 只在 job 版传入；缺省时不得伪造一个", () => {
    assert.equal(val(backtestArgv(base), "--job-id"), undefined);
    assert.equal(val(backtestArgv({ ...base, jobId: "btabc1" }), "--job-id"), "btabc1");
  });
});

describe("防漂移：回测 argv 只能有一份实现", () => {
  it("src/scalper.ts 中除 backtestArgv 外不得再出现 argv 拼装（防止再拆出第二份实现）", () => {
    // 这条是「反重复」锁，不是行为断言：`backtestArgv` 本身永远带着这几个 flag，
    // 所以只测它的输出**抓不到**「另起一份实现」这种回归。真正会漂移的是
    // 「多一个入口自己拼 argv」，因此直接盯住源码里那份唯一的拼装逻辑。
    const src = readFileSync(new URL("../src/scalper.ts", import.meta.url), "utf8");
    const from = src.indexOf("export async function runScalperBacktest");
    const to = src.indexOf("export function backtestArgv");
    assert.ok(from > 0 && to > from, "定位 runScalperBacktest / backtestArgv 失败");
    const body = src.slice(from, to);

    assert.ok(/backtestArgv\(/.test(body), "runScalperBacktest 应复用 backtestArgv");
    assert.ok(!/argv\.push/.test(body), "runScalperBacktest 不应再自己拼 argv");
    assert.ok(!/["']--rr["']/.test(body), "参数 flag 不应在第二处出现");
  });

  it("同步版入口的参数面覆盖 job 版会传的全部 flag（曾漏 rr/slippage/max-hold/job-id）", () => {
    // 同步版签名必须能接收这四项，否则 UI/调用方传进来会被静默丢弃。
    const src = readFileSync(new URL("../src/scalper.ts", import.meta.url), "utf8");
    const from = src.indexOf("export async function runScalperBacktest");
    const sig = src.slice(from, src.indexOf("): Promise<Record<string, unknown>>", from));
    for (const f of ["jobId", "rr", "slippageBps", "maxHold"]) {
      assert.ok(sig.includes(`${f}?:`), `同步版签名缺可选参数 ${f}`);
    }
  });

  it("同样的入参两次调用结果完全一致（纯函数，无隐藏状态）", () => {
    const args = { ...base, rr: 2, slippageBps: 3, maxHold: 20, bar: "5m" };
    assert.deepEqual(backtestArgv(args), backtestArgv(args));
  });
});
