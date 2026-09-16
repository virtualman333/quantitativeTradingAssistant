/**
 * monthguard.test.ts —— L1-6「月度回撤熔断」的判据、两条路径的一致性、以及**判据数据从哪来**
 *
 * 为什么需要这份测试
 * ------------------
 * 章程 §1 L1-6：**月度回撤 ≥ 12% → 强制停止开新仓**（不可裁量）。加固之前，这条 L1 有
 * 两个各自独立、都足以让它永久失效的缺口：
 *
 *   1. **判据字段从来没人写**。`src/main.ts` 读 `state/runtime.json` 的 `month_dd_pct`
 *      并用 `?? 0` 兜底；而唯一的 runtime.json 写入者 `archive_round.py` 只写
 *      day_sl_count / day_pnl_pct / circuit_breaker / round_count。
 *      于是 `rt.monthDdPct ?? 0` 恒为 0，`0 <= -12` 永假 —— 熔断从未触发过，
 *      而且**不报错、不留痕**。月度回撤这个数只在 mail_report.py 与 dashboard.py
 *      里各算一遍（供邮件档位与看板显示），从未回流到执行链。
 *   2. **超短线路径连一次判断都没有**。`scalpOnce()` 只过 `guardScalperConfig()`
 *      （L1-2 杠杆 / L1-5 单笔风险），而它是个无人值守的独立循环：主 Agent 那边
 *      已经因熔断观望，它还在每 60 秒开新单。
 *
 * 本文件锁四件事：
 *   A. 判据本身的分界（就是 MAX_MONTH_DD_PCT，且等于章程原文的 12%）；
 *   B. 「拿不到数」不等于「没有回撤」—— 未知要被点名，不能静默当 0；
 *   C. **写入方与读取方的契约**：真跑一遍 `archive_round.update_runtime()`（隔离到临时
 *      目录），断言它写出的 `month_dd_pct` 就是 TS 侧读的那个字段、且数值与回撤口径一致；
 *   D. 源码形态：两条下单路径都必须过这道闸门，且不得自造第二个上限。
 *
 * 运行：pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { MAX_MONTH_DD_PCT, guardMonthlyDrawdown } from "../src/guard.ts";
import { loadRunState } from "../src/runstate.ts";
import { monthRiskView } from "../ui/lib/riskbrief.js";
import { ROOT, read, stripComments } from "./_src.ts";

const tmpFile = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qta-month-")), name);

// ── A. 判据分界 ───────────────────────────────────────────────────────────

describe("L1-6 · 熔断分界", () => {
  it("恰好等于熔断线即触发（章程写的是「≥」，不是「>」）", () => {
    const r = guardMonthlyDrawdown(MAX_MONTH_DD_PCT);
    assert.equal(r.ok, false, "恰好 -12% 时没有熔断");
    assert.ok(r.violations.some((v) => v.includes("L1-6")), r.violations.join("；"));
  });

  it("差一丝就放行 —— 分界就是 MAX_MONTH_DD_PCT，不是另写的一个数", () => {
    const r = guardMonthlyDrawdown(MAX_MONTH_DD_PCT + 0.01);
    assert.equal(r.ok, true, r.violations.join("；"));
    assert.deepEqual(r.violations, []);
  });

  it("深度回撤同样熔断，且把实际数字报出来", () => {
    const r = guardMonthlyDrawdown(-37.5);
    assert.equal(r.ok, false);
    assert.ok(r.violations[0].includes("-37.50"), r.violations[0]);
  });

  it("没有回撤（0 / 正数）一律放行 —— 熔断判的是回撤，不是「本月没赚钱」", () => {
    for (const v of [0, 0.5, 3.2, 25]) {
      assert.equal(guardMonthlyDrawdown(v).ok, true, `回撤 ${v}% 被误拦`);
    }
  });

  it("能识别负数（回撤是负数，符号写反就等于永不熔断）", () => {
    // 若哪天有人把「回撤」改成以正数表达，这条会红 —— 那正是要有人看一眼的地方。
    const r = guardMonthlyDrawdown(-12.5);
    assert.equal(r.ok, false, "负号被吞掉会导致熔断永不触发");
  });
});

// ── B. 未知 vs 无回撤 ─────────────────────────────────────────────────────

describe("L1-6 · 拿不到数时必须点名，不能静默当 0", () => {
  it("null / undefined / 空串 / 非数字：放行但必须带 L1-6 告警", () => {
    for (const bad of [null, undefined, "", "abc", Number.NaN, {} as never]) {
      const r = guardMonthlyDrawdown(bad);
      assert.equal(r.ok, true, `${JSON.stringify(bad)} 被当成回撤拦下了（这会让交易全停）`);
      assert.ok(
        r.warnings.some((w) => w.includes("L1-6")),
        `${JSON.stringify(bad)} 被静默当作「没有回撤」—— 这正是熔断从未触发的成因`
      );
    }
  });

  it("数值字符串按数字处理（runtime.json 被手改过也能读）", () => {
    assert.equal(guardMonthlyDrawdown("-13").ok, false);
    assert.equal(guardMonthlyDrawdown("0").ok, true);
  });
});

// ── A′. 章程即规格 ────────────────────────────────────────────────────────

describe("章程即规格 · 熔断线必须等于章程 §1 L1-6 的原文数字", () => {
  it("MAX_MONTH_DD_PCT = 章程 L1-6 行里的百分比（带负号）", () => {
    const row = read("AGENT_TRADING_RULES.md").split("\n").find((l) => l.includes("**L1-6**"));
    assert.ok(row, "章程里找不到 L1-6 行 —— 章程结构变了，请同步本测试的解析");
    const m = /([\d.]+)\s*%/.exec(row!);
    assert.ok(m, `L1-6 行里解析不出百分比：${row}`);
    assert.equal(MAX_MONTH_DD_PCT, -Number(m![1]), "代码里的熔断线与章程 §L1-6 不一致");
  });

  it("L1-6 只允许在 guard.ts 定义一次", () => {
    const defines = walkSrc().filter((f) =>
      /(export\s+)?const\s+MAX_MONTH_DD_PCT\s*=/.test(stripComments(read(f)))
    );
    assert.deepEqual(defines, ["src/guard.ts"], `熔断线出现了第二处定义：${defines.join(", ")}`);
  });
});

function walkSrc(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".ts")) out.push(rel);
    }
  };
  walk("src");
  return out;
}

// ── C. 写入方 ↔ 读取方契约（跨语言，真跑） ────────────────────────────────

describe("runtime.json 的 month_dd_pct：写入方真的在写、读取方读的是同一字段", () => {
  /**
   * 这一条是本轮缺陷的正面回归锁。
   * 原缺陷形态是「TS 读一个谁都没写过的字段」+「`?? 0` 把缺失洗成 0」，
   * 纯 TS 单测抓不到（读一个空文件也能过）。所以这里把 Python 侧真跑一遍：
   *   隔离 MONTH_STATE 与 RUNTIME 到临时目录 → 连续几轮不同权益 → 看写出来的数。
   */
  const driver = `
import json, os, sys, tempfile
sys.path.insert(0, sys.argv[1])
import month_risk, archive_round

tmp = tempfile.mkdtemp(prefix="qta_month_driver_")
month_risk.MONTH_STATE = os.path.join(tmp, "month_state.json")
archive_round.RUNTIME = os.path.join(tmp, "runtime.json")

def run(equity):
    return archive_round.update_runtime({
        "time_cst": "2026-09-17 10:00:00",
        "round_id": "R000001",
        "equity_usdt": equity,
        "sl_triggered": 0,
        "trades": [],
        "positions": [],
    })

seq = [10000.0, 11000.0, 9700.0, 8500.0, 10000.0, 11000.0]
steps = []
snapshots = []
for eq in seq:
    st = run(eq)
    steps.append({
        "equity": eq,
        "month_dd_pct": st.get("month_dd_pct"),
        "month_pnl_pct": st.get("month_pnl_pct"),
        "month_dd_cap_pct": st.get("month_dd_cap_pct"),
        "monthly_target_pct": st.get("monthly_target_pct"),
        "l1_6_tripped": st.get("l1_6_tripped"),
    })
    snapshots.append(st)
print(json.dumps({
    "steps": steps,
    "snapshots": snapshots,
    "runtime_keys": sorted(json.load(open(archive_round.RUNTIME, encoding="utf-8")).keys()),
}, ensure_ascii=False))
`;

  const py = process.env.PYTHON || "python";
  const probe = spawnSync(py, ["-c", "print(1)"], { encoding: "utf8" });
  const hasPython = probe.status === 0;

  it("archive_round 每轮把月度回撤写进 runtime.json（隔离临时目录实跑）", (t) => {
    if (!hasPython) {
      t.skip(`本机没有可用的 ${py} —— 这条锁没生效，CI 上必须能跑`);
      return;
    }
    const f = tmpFile("driver.py");
    fs.writeFileSync(f, driver, "utf8");
    const r = spawnSync(py, [f, path.join(ROOT, "scripts")], { encoding: "utf8" });
    assert.equal(r.status, 0, `Python 驱动失败：${r.stderr?.slice(0, 400)}`);

    const out = JSON.parse(r.stdout.trim()) as {
      steps: {
        equity: number;
        month_dd_pct: number | null;
        month_pnl_pct: number | null;
        month_dd_cap_pct: number | null;
        monthly_target_pct: number | null;
        l1_6_tripped: boolean;
      }[];
      snapshots: Record<string, unknown>[];
      runtime_keys: string[];
    };

    // ① 字段真的存在（曾经全仓没有任何脚本写过它）
    assert.ok(
      out.runtime_keys.includes("month_dd_pct"),
      `runtime.json 里没有 month_dd_pct —— src/main.ts 读的就是这个字段：${out.runtime_keys.join(", ")}`
    );

    // ② 回撤口径：相对当月峰值，不是「相对月初」
    //    10000 → 11000（峰值）→ 9700：月度收益率 -3%，但回撤是 -11.8%
    const [, , at9700, at8500, at10000, back11000] = out.steps;
    assert.ok(Math.abs((at9700.month_dd_pct ?? 0) - -11.8181) < 0.01, `峰值回撤算错：${at9700.month_dd_pct}`);
    assert.ok(Math.abs((at9700.month_pnl_pct ?? 0) - -3.0) < 0.01, `月度收益率算错：${at9700.month_pnl_pct}`);

    // ③ 写出 11.8% 回撤时**不该**熔断，写出 15% 时**必须**熔断
    assert.equal(at9700.l1_6_tripped, false, "-11.8% 被误判为熔断");
    assert.equal(at8500.l1_6_tripped, true, "-15% 没有被判为熔断");

    // ④ 回撤对的是**峰值**不是月初：权益回到月初的 10000 仍有 -9.09% 回撤；
    //    只有回到峰值 11000 才归零。写成「对月初」的话这里会得到 0（假的「已恢复」）。
    assert.ok(Math.abs((at10000.month_dd_pct ?? 0) - -9.0909) < 0.01, `回撤被算成了对月初：${at10000.month_dd_pct}`);
    assert.ok(Math.abs(back11000.month_dd_pct ?? 99) < 1e-9, `回到峰值后回撤应为 0：${back11000.month_dd_pct}`);
    assert.equal(guardMonthlyDrawdown(back11000.month_dd_pct).ok, true, "回到峰值后仍判熔断");

    // ⑤ **跨语言同结论**：Python 写出的数直接喂 TS 闸门，结论必须一致
    assert.equal(guardMonthlyDrawdown(at9700.month_dd_pct).ok, true);
    assert.equal(guardMonthlyDrawdown(at8500.month_dd_pct).ok, false);

    // ⑥ 阈值也随判据一起落盘：界面要显示「回撤 -3.5% / 熔断线 -12%」，
    //    但它不许自己抄一份章程常量。写出去的必须就是 guard 的那一个数。
    for (const s of out.steps) {
      assert.equal(
        s.month_dd_cap_pct,
        MAX_MONTH_DD_PCT,
        `runtime.json 的 month_dd_cap_pct（${s.month_dd_cap_pct}）与 guard 的熔断线（${MAX_MONTH_DD_PCT}）不一致 —— 界面会照着它显示一个假阈值`
      );
    }
    assert.equal(back11000.monthly_target_pct, 10.0, "月度目标没落盘");

    // ⑦ **拿归档脚本真跑出来的 runtime.json 直接喂界面展示层**。
    //    上面那些断言用的是我手写的字段名；万一 Python 侧改名（比如
    //    `month_dd_cap_pct` → `month_cap_pct`），手写字段名的界面测试会照常全绿，
    //    而用户看到的是「月度回撤 — / 未知」。这条把两边的字段名真正钉在一起。
    const views = out.snapshots.map((s) => monthRiskView(s));
    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      assert.notEqual(v.level, "unknown", `第 ${i} 轮界面判不出来 —— 两边的字段名对不上了：${JSON.stringify(out.snapshots[i])}`);
      assert.equal(v.level === "tripped", out.steps[i].l1_6_tripped, `第 ${i} 轮档位与判据不一致`);
      assert.notEqual(v.ddText, "—", `第 ${i} 轮界面读不到月度回撤`);
      assert.notEqual(v.capText, "—", `第 ${i} 轮界面读不到熔断线`);
      assert.ok(!v.summary.includes("NaN"), `第 ${i} 轮摘要出现 NaN：${v.summary}`);
    }
    // 权益从峰值 11000 砸到 8500（-22.7%）那一轮：界面必须明说已熔断
    assert.equal(views[3].level, "tripped");
    assert.ok(views[3].summary.includes("已触发章程 L1-6"), views[3].summary);
    // 回到峰值那一轮：回撤归零，界面不再报警
    assert.equal(views[5].level, "ok");
    assert.equal(views[5].ddText, "0.00%");
  });
});

// ── E. 失败路径：陈旧的回撤比没有回撤更危险 ──────────────────────────────

describe("月度状态算不出来时：不许把上一轮的数值当成这一轮的", () => {
  /**
   * `update_runtime()` 是「读旧文件 → 覆盖字段 → 写回」。月度那段 try/except 若在
   * 失败时只写一个 `month_dd_error` 而**不清掉**上一轮的 month_dd_pct / l1_6_tripped，
   * 那么从高点摔下来那一轮恰好算不出数时，界面与闸门拿到的都是旧的小回撤 ——
   * 显示「正常」，然后继续开新仓。反过来，算成功时若不清 `month_dd_error`，
   * 一次失败会让界面永久显示「数据缺失」。
   * 这两种都不会报错，所以只能靠真跑一遍把它钉住。
   */
  const driver = `
import json, os, sys, tempfile
sys.path.insert(0, sys.argv[1])
import month_risk, archive_round

tmp = tempfile.mkdtemp(prefix="qta_month_fail_")
month_risk.MONTH_STATE = os.path.join(tmp, "month_state.json")
archive_round.RUNTIME = os.path.join(tmp, "runtime.json")

def run(equity):
    return archive_round.update_runtime({
        "time_cst": "2026-09-17 10:00:00",
        "round_id": "R000001",
        "equity_usdt": equity,
        "sl_triggered": 0,
        "trades": [],
        "positions": [],
    })

ok1 = run(10000.0)          # 正常一轮：有月度数值
orig = month_risk.month_metrics
def boom(*a, **k):
    raise RuntimeError("boom")
month_risk.month_metrics = boom
bad = run(9000.0)           # 这一轮算不出来
month_risk.month_metrics = orig
ok2 = run(9200.0)           # 恢复

def pick(st):
    return {k: st.get(k) for k in ("month_dd_pct", "l1_6_tripped", "month_dd_cap_pct", "month_dd_error")}

print(json.dumps({"ok1": pick(ok1), "bad": pick(bad), "ok2": pick(ok2)}, ensure_ascii=False))
`;

  const py = process.env.PYTHON || "python";
  const hasPython = spawnSync(py, ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

  it("失败轮清掉月度数值、恢复轮清掉错误标记（隔离临时目录实跑）", (t) => {
    if (!hasPython) {
      t.skip(`本机没有可用的 ${py} —— 这条锁没生效，CI 上必须能跑`);
      return;
    }
    const f = tmpFile("driver_fail.py");
    fs.writeFileSync(f, driver, "utf8");
    const r = spawnSync(py, [f, path.join(ROOT, "scripts")], { encoding: "utf8" });
    assert.equal(r.status, 0, `Python 驱动失败：${r.stderr?.slice(0, 400)}`);

    const out = JSON.parse(r.stdout.trim()) as Record<
      "ok1" | "bad" | "ok2",
      { month_dd_pct: number | null; l1_6_tripped: boolean | null; month_dd_cap_pct: number | null; month_dd_error: string | null }
    >;

    assert.equal(out.ok1.month_dd_pct, 0.0, "首轮没有回撤，该写 0");
    assert.equal(out.ok1.l1_6_tripped, false);
    assert.equal(out.ok1.month_dd_error, null, "首轮不该有错误标记");

    // 失败轮：数值必须变成「未知」，不能留着上一轮的 0 和 false
    assert.equal(out.bad.month_dd_pct, null, "失败轮沿用了上一轮的回撤 —— 界面会把旧值当成当前值");
    assert.equal(out.bad.l1_6_tripped, null, "失败轮沿用了上一轮的熔断判据");
    assert.equal(out.bad.month_dd_cap_pct, null);
    assert.ok(out.bad.month_dd_error?.includes("boom"), `失败原因没落盘：${out.bad.month_dd_error}`);

    // 恢复轮：错误标记必须被清掉，否则界面会一直说「数据缺失」
    assert.equal(out.ok2.month_dd_error, null, "一次失败后错误标记永久残留 —— 界面会一直显示「数据缺失」");
    assert.equal(out.ok2.month_dd_pct, -8.0, `恢复轮回撤算错：${out.ok2.month_dd_pct}`);
    assert.equal(out.ok2.l1_6_tripped, false);
  });
});

describe("loadRunState · 缺失字段不许被洗成 0", () => {
  it("month_dd_pct 缺失时返回 null（不是 0），由闸门负责点名", () => {
    const f = tmpFile("runtime.json");
    fs.writeFileSync(f, JSON.stringify({ day_sl_count: 1, day_pnl_pct: -2.5, round_count: 7 }), "utf8");
    const st = loadRunState(f);
    assert.equal(st.monthDdPct, null, "缺失的月度回撤被当成了 0 —— 熔断会因此永不触发");
    assert.equal(st.monthPnlPct, null);
    assert.equal(st.daySlCount, 1);
    assert.equal(st.roundNo, 7, "round_count 回退失效（曾导致 round_id 永远 R000001）");
  });

  it("字段存在时如实读出", () => {
    const f = tmpFile("runtime.json");
    fs.writeFileSync(f, JSON.stringify({ month_dd_pct: -13.2, month_pnl_pct: -14.1, round_no: 9 }), "utf8");
    const st = loadRunState(f);
    assert.equal(st.monthDdPct, -13.2);
    assert.equal(st.monthPnlPct, -14.1);
    assert.equal(st.roundNo, 9, "round_no 优先于 round_count");
  });

  it("无文件 / 坏 JSON 一律返回「未知」而不是抛异常", () => {
    assert.equal(loadRunState(path.join(os.tmpdir(), "qta-not-exist-9f2.json")).monthDdPct, null);
    const f = tmpFile("runtime.json");
    fs.writeFileSync(f, "{ not json", "utf8");
    const st = loadRunState(f);
    assert.equal(st.monthDdPct, null);
    assert.equal(st.daySlCount, 0);
  });
});

// ── D. 两条下单路径都必须过闸门 ───────────────────────────────────────────

describe("源码形态 · 两条下单路径都过 L1-6，且只有一份读数实现", () => {
  const MAIN_SRC = stripComments(read("src/main.ts"));
  const SCALPER_SRC = stripComments(read("src/scalper.ts"));

  it("stripComments 可用（失败路径要先走过一次）", () => {
    assert.ok(!SCALPER_SRC.includes("无人值守的独立循环，此前这条路径上连一次判断都没有"));
  });

  it("主 Agent 路径调用闸门（闸门被删掉不会让任何行为断言变红）", () => {
    assert.ok(MAIN_SRC.includes("guardMonthlyDrawdown("), "main.ts 不再判 L1-6 熔断");
  });

  it("超短线路径也调用同一个闸门（本轮之前它一个 L1-6 检查都没有）", () => {
    assert.ok(SCALPER_SRC.includes("guardMonthlyDrawdown("), "超短线路径不再判 L1-6 熔断 —— 无人值守的循环会照常开单");
    assert.ok(SCALPER_SRC.includes("loadRunState("), "超短线没读运行态，闸门拿不到判据");
  });

  it("运行态只有一份读数实现：main.ts / scalper.ts 都不许自己解析 runtime.json", () => {
    for (const [name, src] of [["src/main.ts", MAIN_SRC], ["src/scalper.ts", SCALPER_SRC]] as const) {
      assert.ok(!src.includes("runtime.json"), `${name} 里又出现了一份 runtime.json 解析`);
    }
    assert.ok(stripComments(read("src/runstate.ts")).includes("runtime.json"), "运行态读数实现不见了");
  });

  it("main.ts 不得再写死熔断线数字", () => {
    assert.ok(!/<=?\s*-?12\b/.test(MAIN_SRC.replace(/MAX_MONTH_DD_PCT/g, "")), "main.ts 里又出现写死的熔断线");
  });

  it("Python 侧也只有一份月度回撤口径（mail_report / dashboard 不再各算一遍）", () => {
    for (const f of ["scripts/mail_report.py", "scripts/dashboard.py"]) {
      const src = read(f);
      // 真正的漂移形态：再出现「(equity - peak) / peak」这种就地算式
      assert.ok(!/\(\s*demo_eq\s*-\s*peak\s*\)|\(\s*equity\s*-\s*peak\s*\)/.test(src), `${f} 里又自己算了一遍回撤`);
      assert.ok(src.includes("month_risk"), `${f} 没有走 month_risk 的唯一口径`);
    }
  });
});
