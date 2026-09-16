/**
 * scalperguard.test.ts —— 超短线路径的 L1 硬约束闸门
 *
 * 为什么需要这份测试
 * ------------------
 * `guardIntent()` 校验的是「LLM 订单意图」；而超短线下单参数是**用户在界面上直接配置**的
 * （`ScalperConfig.leverage` / `riskPct`），走不到 guardIntent。此前这条路径上一个 L1 检查
 * 都没有：界面能存下 10x（自己都写着「>5x 超过章程 L1-2 上限」）与 10% 单笔风险
 * （L1-5 硬顶是 2.5%），而 `scalper.ts` 只把杠杆 clamp 到 20 就照单执行。
 * 章程说「触碰 L1 → 一律不执行」，在那条同样会下真单的路径上等于不存在。
 *
 * 本文件锁三件事：
 *   1. `guardScalperConfig()` 的分界**就是** MAX_LEVERAGE / MAX_RISK_PCT 这两个常量
 *      （不是另写的 5 / 2.5%，所以断言里也不写死这两个数）；
 *   2. 两条下单路径对**同一个数值**给出同样的结论（防日后各改各的）；
 *   3. 源码形态：闸门必须还在调用点、且没有第二份自造的上限（这类回归断言不看行为，
 *      因为被删掉的闸门不会让任何行为断言变红）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVAL_RISK_PCT,
  MAX_LEVERAGE,
  MAX_RISK_PCT,
  guardIntent,
  guardScalperConfig,
  impliedLeverage,
} from "../src/guard.ts";
import { DEFAULT_SCALPER } from "../src/store.ts";
import type { TradeIntent } from "../src/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * 剥掉注释后再做源码断言。
 * 教训（已连续两轮踩到）：在被测文件里写「旧实现长这样」的注释，会让
 * `source.includes("旧代码片段")` 这类断言命中注释而不是真代码 —— 该红的红不了、
 * 不该红的红。所以凡是对源码形态的断言，先剥注释。
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += c + (n ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const SCALPER_SRC = stripComments(read("src/scalper.ts"));

/** 造一个开仓意图；refPrice 默认 0 = 显式跳过 L1-2 反推，隔离不相关维度。 */
const intent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  inst: "BTC-USDT-SWAP",
  action: "long",
  riskPct: 0.01,
  slDist: 200,
  reason: "测试用理由",
  ...over,
});

const snap = () => ({ equityUsdt: 10_000, availableUsdt: 10_000, positions: [], algoOrders: [] });
const hit = (v: string[], tag: string) => v.some((x) => x.includes(tag));

// ── 基线 ─────────────────────────────────────────────────────────────────

describe("guardScalperConfig · 基线", () => {
  it("仓库默认配置应放行", () => {
    const r = guardScalperConfig(DEFAULT_SCALPER);
    assert.equal(r.ok, true, `默认配置被误拦：${r.violations.join("；")}`);
    assert.deepEqual(r.violations, []);
  });

  it("缺字段 / 非数字一律不放行（宁可拦住，不要静默按默认值下单）", () => {
    for (const bad of [undefined, {}, null, { leverage: 5 }, { riskPct: 0.01 }]) {
      const r = guardScalperConfig(bad as never);
      assert.equal(r.ok, false, `空配置被放行：${JSON.stringify(bad)}`);
      assert.ok(r.violations.length > 0);
    }
  });
});

// ── L1-2 杠杆 ────────────────────────────────────────────────────────────

describe("guardScalperConfig · L1-2 杠杆 ≤ 章程上限", () => {
  it("恰好等于上限应放行", () => {
    const r = guardScalperConfig({ leverage: MAX_LEVERAGE, riskPct: 0.01 });
    assert.equal(r.ok, true, r.violations.join("；"));
  });

  it("超过上限一丝就拒绝，且点名 L1-2", () => {
    const r = guardScalperConfig({ leverage: MAX_LEVERAGE + 1, riskPct: 0.01 });
    assert.equal(r.ok, false);
    assert.ok(hit(r.violations, "L1-2"), r.violations.join("；"));
  });

  it("成倍超限同样拒绝", () => {
    const r = guardScalperConfig({ leverage: MAX_LEVERAGE * 4, riskPct: 0.01 });
    assert.equal(r.ok, false);
    assert.ok(hit(r.violations, "L1-2"));
  });

  it("无效杠杆（0 / 负数 / 非数字）一律拒绝", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "abc", null]) {
      const r = guardScalperConfig({ leverage: bad, riskPct: 0.01 });
      assert.equal(r.ok, false, `杠杆 ${String(bad)} 被放行`);
      assert.ok(hit(r.violations, "L1-2"));
    }
  });

  it("存量历史值（旧界面可存下的 10x）必须被拒 —— 绊线：若哪天章程上限真的上调，这条要跟着改", () => {
    const r = guardScalperConfig({ leverage: 10, riskPct: 0.01 });
    assert.equal(r.ok, false);
    assert.ok(hit(r.violations, "L1-2"));
  });
});

// ── L1-5 单笔风险 ────────────────────────────────────────────────────────

describe("guardScalperConfig · L1-5 单笔风险 ≤ 章程硬顶", () => {
  it("恰好等于硬顶应放行（但会触发 L2 提示）", () => {
    const r = guardScalperConfig({ leverage: 1, riskPct: MAX_RISK_PCT });
    assert.equal(r.ok, true, r.violations.join("；"));
  });

  it("超过硬顶一丝就拒绝 —— 分界就是 MAX_RISK_PCT，不是另写的数字", () => {
    const r = guardScalperConfig({ leverage: 1, riskPct: MAX_RISK_PCT + 1e-9 });
    assert.equal(r.ok, false);
    assert.ok(hit(r.violations, "L1-5"), r.violations.join("；"));
  });

  it("超过人工确认线（2%）但不超硬顶：只提示不阻断 —— 与 guardIntent 的 L2 语义一致", () => {
    const r = guardScalperConfig({ leverage: 1, riskPct: APPROVAL_RISK_PCT + 1e-9 });
    assert.equal(r.ok, true, r.violations.join("；"));
    assert.equal(r.warnings.length, 1);
    assert.equal(r.needsApproval, true);
    assert.ok(r.approvalReason);
  });

  it("无效风险比例（0 / 负数 / 非数字）一律拒绝", () => {
    for (const bad of [0, -0.01, Number.NaN, "abc", null, undefined]) {
      const r = guardScalperConfig({ leverage: 1, riskPct: bad });
      assert.equal(r.ok, false, `风险比例 ${String(bad)} 被放行`);
      assert.ok(hit(r.violations, "L1-5"));
    }
  });

  it("存量历史值（旧界面可存下的 10%）必须被拒 —— 同上，绊线", () => {
    const r = guardScalperConfig({ leverage: 1, riskPct: 0.1 });
    assert.equal(r.ok, false);
    assert.ok(hit(r.violations, "L1-5"));
  });
});

// ── 两条下单路径口径一致 ─────────────────────────────────────────────────

describe("两条下单路径（主 Agent / 超短线）必须给出同一结论", () => {
  it("L1-5 分界在两条路径上完全相同", () => {
    const samples = [0.005, 0.01, APPROVAL_RISK_PCT, APPROVAL_RISK_PCT + 1e-9, MAX_RISK_PCT, MAX_RISK_PCT + 1e-9, 0.05, 0.1];
    for (const rp of samples) {
      // refPrice = 0：显式隔离 L1-2 反推，本用例只比 L1-5
      const agent = guardIntent(intent({ riskPct: rp }), snap(), 0);
      const scalper = guardScalperConfig({ leverage: 1, riskPct: rp });
      assert.equal(
        hit(agent.violations, "L1-5"),
        hit(scalper.violations, "L1-5"),
        `riskPct=${rp} 两条路径结论不一致：agent=${agent.violations.join("；") || "放行"} / scalper=${scalper.violations.join("；") || "放行"}`
      );
    }
  });

  it("L1-2 的分界就是 MAX_LEVERAGE（用反向反推口径校验）", () => {
    const refPrice = 60_000;
    const slDist = 600; // 1% 止损距离
    // 令隐含杠杆恰好 = MAX_LEVERAGE
    const atCap = impliedLeverage(MAX_LEVERAGE * (slDist / refPrice), slDist, refPrice);
    assert.ok(atCap !== null);
    assert.ok(Math.abs(atCap - MAX_LEVERAGE) < 1e-9, `反推口径漂了：${atCap}`);

    const rpAtCap = MAX_LEVERAGE * (slDist / refPrice);
    const rpOverCap = rpAtCap * 1.05;
    assert.equal(hit(guardIntent(intent({ riskPct: rpAtCap, slDist }), snap(), refPrice).violations, "L1-2"), false);
    assert.equal(hit(guardIntent(intent({ riskPct: rpOverCap, slDist }), snap(), refPrice).violations, "L1-2"), true);
  });
});

// ── 源码形态锁（行为断言抓不到的回归） ───────────────────────────────────

describe("章程即规格 · 代码里的硬约束数字必须等于章程里的数字", () => {
  /**
   * 上面那些边界用例刻意用常量写（`MAX_LEVERAGE + 1`），好处是口径变了测试自动跟随；
   * 代价是**常量本身被人偷偷改大也全绿**。这条把常量钉回章程原文：
   * 该改的是章程（用户手写，不在自动迭代范围内），代码只能跟着章程走。
   */
  const charter = read("AGENT_TRADING_RULES.md");

  it("L1-2 杠杆上限 = 章程写的倍数", () => {
    const row = charter.split("\n").find((l) => l.includes("**L1-2**"));
    assert.ok(row, "章程里找不到 L1-2 行 —— 章程结构变了，请同步本测试的解析");
    const m = /≤\s*([\d.]+)\s*倍/.exec(row!);
    assert.ok(m, `L1-2 行里解析不出「≤ N 倍」：${row}`);
    assert.equal(MAX_LEVERAGE, Number(m![1]), "代码里的杠杆上限与章程 §L1-2 不一致");
  });

  it("L1-5 单笔风险硬顶 = 章程写的百分比", () => {
    const row = charter.split("\n").find((l) => l.includes("**L1-5**"));
    assert.ok(row, "章程里找不到 L1-5 行 —— 章程结构变了，请同步本测试的解析");
    const m = /([\d.]+)\s*%/.exec(row!);
    assert.ok(m, `L1-5 行里解析不出百分比：${row}`);
    assert.equal(MAX_RISK_PCT, Number(m![1]) / 100, "代码里的风险硬顶与章程 §L1-5 不一致");
  });
});

describe("源码形态 · 闸门在调用点、上限只有一份", () => {
  it("剥注释的辅助函数本身可用（失败路径要先走过一次）", () => {
    assert.ok(SCALPER_SRC.includes("export async function scalpOnce"));
    assert.ok(!SCALPER_SRC.includes("那个 20 是章程外的数"), "注释没被剥掉，后面的断言会失真");
  });

  it("scalper.ts 的开单入口必须过 guardScalperConfig（闸门被删掉不会让任何行为断言变红）", () => {
    assert.ok(
      SCALPER_SRC.includes("guardScalperConfig(cfg)"),
      "超短线开单入口不再调用 L1 闸门 —— 章程 L1 在这条路径上又变成不存在了"
    );
  });

  it("scalper.ts 不得自造杠杆上限（章程外的 clamp）", () => {
    assert.ok(!SCALPER_SRC.includes("Math.min(Math.max(1, cfg.leverage)"), "杠杆又被本地 clamp 了");
    assert.ok(!/cfg\.leverage\s*\)\s*,\s*\d+/.test(SCALPER_SRC), "又出现了一个写死的杠杆上限");
  });

  it("MAX_LEVERAGE / MAX_RISK_PCT 只允许在 guard.ts 定义一次", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".ts")) files.push(rel);
      }
    };
    walk("src");
    const defines: string[] = [];
    for (const f of files) {
      const s = stripComments(read(f));
      if (/(export\s+)?const\s+MAX_(LEVERAGE|RISK_PCT)\s*=/.test(s)) defines.push(f);
    }
    assert.deepEqual(defines, ["src/guard.ts"], `上限常量出现了第二处定义：${defines.join(", ")}`);
  });

  it("界面不得再写死杠杆选项表与上限数字，必须走主进程的裁决", () => {
    const ui = read("ui/components/ScalperView.vue");
    assert.ok(!/LEVERAGES\s*=\s*\[/.test(ui), "界面又手写了一份杠杆选项表");
    assert.ok(ui.includes("scalperCheck"), "界面保存前不再问主进程的 L1 裁决");
  });

  it("主进程的校验端点必须复用 guard.ts，而不是自己算一遍", () => {
    const em = stripComments(read("electron/main.ts"));
    assert.ok(em.includes('"scalper:check"'));
    assert.ok(em.includes('loadDist<any>("guard.js")') && em.includes("guardScalperConfig("), "scalper:check 没有复用 guard.ts");
  });

  it("启动无人值守循环前也要过同一份裁决（否则循环只会每轮报错）", () => {
    const em = stripComments(read("electron/main.ts"));
    const at = em.indexOf('"scalper:start"');
    assert.ok(at > -1);
    assert.ok(em.slice(at).includes("checkScalperConfigSafe("), "scalper:start 不再校验配置");
  });
});
