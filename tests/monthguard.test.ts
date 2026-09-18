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
import { ROOT, assertCommentStripped, read, stripComments } from "./_src.ts";

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
    // ⚠ 这里曾经只断言 `daySlCount === 0` —— 那正是缺陷本身：坏文件返回的是「今天没止损过」
    // 这条干净的假话。现在要求它同时被标成「不可信」，并点名读不出来的原因。
    assert.equal(st.daySlCount, 0, "计数从 0 重新开始是事实，但它必须带着「不可信」的标记");
    assert.equal(st.dayCountersCompromised, true, "坏文件被读成了「今天一次止损都没有」");
    assert.match(String(st.unreadable), /JSON/, "读不出来的原因没被带出来，日志里就只能说「未知」说不出为什么");
  });
});

// ── D. 两条下单路径都必须过闸门 ───────────────────────────────────────────

describe("源码形态 · 两条下单路径都过 L1-6，且只有一份读数实现", () => {
  const MAIN_SRC = stripComments(read("src/main.ts"));
  const RAW_SCALPER_SRC = read("src/scalper.ts");
  const SCALPER_SRC = stripComments(RAW_SCALPER_SRC);

  it("stripComments 可用（失败路径要先走过一次）", () => {
    // ★ 两向自证：原文里有这段注释（对照面在）+ 剥过之后没有（真在剥）。
    //   只判后一半是恒真的 —— 原先用的那句标记在 src/scalper.ts 里出现 **0 次**
    //   （原文那里隔着一个换行），于是这条自证从来没证明过任何东西。
    assertCommentStripped(
      RAW_SCALPER_SRC,
      SCALPER_SRC,
      "MCP 返回是三层洋葱 result.data.data",
      "monthguard · stripComments 自证"
    );
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

// ── F. 月度状态是「L1-6 的分母」：读路径不许写盘，写入口只有一个 ─────────────

describe("月度状态读写分离 · 展示路径绝不许改动 L1-6 的分母", () => {
  /**
   * 这一条锁的是一个**不可逆**的危害。
   *
   * `state/month_state.json` 不是普通缓存，它是 L1-6「月度回撤 ≥12% → 强制停止开新仓」的分母：
   * `month_peak_equity` 只增不减（除跨月重置），**每次被抬高都让真实回撤看起来更大**。
   * 而原来的 `ensure_month_state()`（名字看不出会写盘）被两条**纯展示**路径调用：
   *   - `dashboard.py`：权益来自 AI 手填的 `--account` 快照 JSON，可能过期；
   *   - `mail_report.py`：报表。
   * 于是「打开一次看板」就能把当月的峰值永久抬到一个手填的数字上，此后真实权益一直被算成
   * 深度回撤 → `guard.ts` 误判熔断 → **停止一切开新仓**；跨月首日打开看板还会把整月的
   * `month_start_equity` 冻结成那份快照里的数。
   * 全程不报错、不留痕，纯 TS 单测也抓不到（它读一个不存在的文件同样能过），所以这里真跑。
   */
  const driver = `
import hashlib, json, os, sys, tempfile, tokenize
from datetime import datetime, timezone, timedelta

sys.path.insert(0, sys.argv[1])
import month_risk

CST = timezone(timedelta(hours=8))
tmp = tempfile.mkdtemp(prefix="qta_month_rw_")
month_risk.MONTH_STATE = os.path.join(tmp, "month_state.json")


def exists():
    return os.path.exists(month_risk.MONTH_STATE)


def digest():
    if not exists():
        return None
    with open(month_risk.MONTH_STATE, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def peak():
    with open(month_risk.MONTH_STATE, encoding="utf-8") as f:
        return json.load(f)["month_peak_equity"]


def trip(pct):
    return month_risk.month_dd_circuit_tripped(pct)

# ① 空目录下的只读调用：连文件都不该被创建
tmp_fresh = tempfile.mkdtemp(prefix="qta_month_fresh_")
month_risk.MONTH_STATE = os.path.join(tmp_fresh, "month_state.json")
fresh_metrics = month_risk.month_metrics(5000.0)
fresh_created = exists()

# ② 交易主循环（唯一写入口）跑两轮：基准 10000，峰值抬到 11000
month_risk.MONTH_STATE = os.path.join(tmp, "month_state.json")
month_risk.update_month_state(10000.0)
month_risk.update_month_state(11000.0)
peak_after_loop = peak()
digest_after_loop = digest()

# ③ 展示路径 A：看板拿一份「手填的、比当月峰值更高的」过期快照
board = month_risk.month_metrics(15000.0)
digest_after_board = digest()

# ④ 展示路径 B：跨月首日打开看板（now 注入到下月 1 日）
next_month = datetime(2026, 10, 1, 9, 0, 0, tzinfo=CST)
cross = month_risk.read_month_state(15000.0, now=next_month)
digest_after_cross = digest()

# ⑤ 之后交易主循环按**真实权益**跑一轮：回撤只能相对真实峰值 11000
real = month_risk.month_metrics(10200.0)

# ⑥ 反向对照：只有写入口才该抬高峰值（证明上面那几条断言真的抓得住写盘）
month_risk.update_month_state(15000.0)
peak_after_forced_write = peak()
real_forced = month_risk.month_metrics(10200.0)

# ⑦ 全仓谁在调 update_month_state —— 用 tokenize 去掉注释与字符串后再按文件判定
#    （注释里写「旧实现会写盘」不能算数，这正是本仓踩过的假锁形态）
calls = {}
for name in sorted(os.listdir(sys.argv[1])):
    if not name.endswith(".py"):
        continue
    try:
        with open(os.path.join(sys.argv[1], name), "rb") as f:
            toks = list(tokenize.tokenize(f.readline))
    except Exception:
        continue
    code = "".join(
        t.string + (" " if t.type in (tokenize.NEWLINE, tokenize.NL) else "")
        for t in toks
        if t.type not in (tokenize.COMMENT, tokenize.STRING, tokenize.ENCODING, tokenize.ENDMARKER)
    )
    if "update_month_state" in code:
        calls[name] = code.count("update_month_state")

print(json.dumps({
    "fresh_created": fresh_created,
    "fresh_dd": fresh_metrics["month_dd_pct"],
    "peak_after_loop": peak_after_loop,
    "digest_after_loop": digest_after_loop,
    "digest_after_board": digest_after_board,
    "digest_after_cross": digest_after_cross,
    "board_dd": board["month_dd_pct"],
    "cross_month": cross.get("month"),
    "cross_start": cross.get("month_start_equity"),
    "cross_note": cross.get("reset_note"),
    "real_dd": real["month_dd_pct"],
    "real_tripped": trip(real["month_dd_pct"]),
    "peak_after_forced_write": peak_after_forced_write,
    "real_dd_after_forced_write": real_forced["month_dd_pct"],
    "real_tripped_after_forced_write": trip(real_forced["month_dd_pct"]),
    "writer_files": calls,
}, ensure_ascii=False))
`;

  const py = process.env.PYTHON || "python";
  const hasPython = spawnSync(py, ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

  type Out = {
    fresh_created: boolean;
    fresh_dd: number;
    peak_after_loop: number;
    digest_after_loop: string;
    digest_after_board: string;
    digest_after_cross: string;
    board_dd: number;
    cross_month: string;
    cross_start: number;
    cross_note: string;
    real_dd: number;
    real_tripped: boolean;
    peak_after_forced_write: number;
    real_dd_after_forced_write: number;
    real_tripped_after_forced_write: boolean;
    writer_files: Record<string, number>;
  };

  function runDriver(name: string, t: { skip: (m: string) => void }): Out | null {
    if (!hasPython) {
      t.skip(`本机没有可用的 ${py} —— 这条锁没生效，CI 上必须能跑`);
      return null;
    }
    const f = tmpFile(name);
    fs.writeFileSync(f, driver, "utf8");
    const r = spawnSync(py, [f, path.join(ROOT, "scripts")], { encoding: "utf8" });
    assert.equal(r.status, 0, `Python 驱动失败：${r.stderr?.slice(0, 400)}`);
    return JSON.parse(r.stdout.trim()) as Out;
  }

  it("只读口径不写盘：看板/邮件跑过之后状态文件逐字节不变（含跨月只读）", (t) => {
    const out = runDriver("driver_rw.py", t);
    if (!out) return;

    // 空目录下只读调用连文件都不该创建
    assert.equal(out.fresh_created, false, "只读调用创建了 month_state.json —— 展示路径不该有写副作用");
    assert.equal(out.fresh_dd, 0, "无基准时回撤应为 0（当前权益即峰值）");

    assert.equal(out.peak_after_loop, 11000, "写入口没有把峰值抬到 11000");
    assert.equal(
      out.digest_after_board,
      out.digest_after_loop,
      "看板口径改动了 month_state.json —— 一份手填的账户快照就能永久抬高 L1-6 的峰值（不可逆）"
    );
    assert.equal(
      out.digest_after_cross,
      out.digest_after_loop,
      "跨月只读改动了 month_state.json —— 月初打开一次看板就会把整月基准冻结成快照里的数字"
    );

    // 跨月只读给出的是「虚拟重置」的当月状态，而不是上个月那份
    assert.equal(out.cross_month, "2026-10", `跨月只读返回了 ${out.cross_month} 的状态`);
    assert.equal(out.cross_start, 15000, "跨月虚拟重置应以当次权益为月初基准");
    assert.ok(out.cross_note.includes("未落盘"), `虚拟重置要写明未落盘：${out.cross_note}`);

    // 看板自己看到的结果（临时视图）不影响真实口径
    assert.ok(Math.abs(out.board_dd) < 1e-9, `拿高于峰值的快照看板应显示无回撤：${out.board_dd}`);
  });

  it("真实口径仍按真实峰值：10200 / 峰值 11000 = -7.27%，不熔断", (t) => {
    const out = runDriver("driver_rw2.py", t);
    if (!out) return;
    assert.ok(Math.abs(out.real_dd - -7.2727) < 0.01, `真实回撤算错：${out.real_dd}`);
    assert.equal(out.real_tripped, false, "-7.27% 被误判为熔断");
  });

  it("反向对照：走写入口就一定会被上面的断言抓住", (t) => {
    const out = runDriver("driver_rw3.py", t);
    if (!out) return;
    // 这条对照存在的意义：证明「只读不写盘」那几条断言真的会红，而不是恒真。
    assert.equal(out.peak_after_forced_write, 15000, "写入口没抬高峰值 —— 上面的只读断言就失去了对照");
    assert.ok(
      Math.abs(out.real_dd_after_forced_write - -32.0) < 0.01,
      `峰值被抬到 15000 后真实回撤应变 -32%：${out.real_dd_after_forced_write}`
    );
    assert.equal(out.real_tripped_after_forced_write, true, "峰值被污染后应误判熔断 —— 这正是要防的后果");
  });

  it("写入口全仓只有一个：archive_round.py 调一次（定义处不算）", (t) => {
    const out = runDriver("driver_writer.py", t);
    if (!out) return;
    assert.deepEqual(
      Object.keys(out.writer_files).sort(),
      ["archive_round.py", "month_risk.py"],
      `update_month_state 出现在意外的地方：${JSON.stringify(out.writer_files)} —— 展示路径不得写月度状态`
    );
    assert.equal(out.writer_files["archive_round.py"], 1, "archive_round.py 里写入口的调用次数不是 1");
  });
});

// ── G. 分母的第三条死法：根本不用写，读坏就行 ─────────────────────────────

describe("月度状态文件损坏时 · 不许当成「首次初始化」，更要留证", () => {
  /**
   * 上一节挡的是「不该写的人写」。这一节挡的是**根本不用写**的那条路：
   *
   * `_load_state()` 原来是 `except Exception: return {}` —— 文件读不出来就当首次初始化。
   * 而写入口的语义是「跨月 / 首次 → 基准与峰值都取当前权益」，于是只要
   * `state/month_state.json` 变成半截（`open(w)` + `json.dump` 写到一半被杀 / 断电 /
   * 磁盘满都行），下一轮就会把 `month_peak_equity` **重新初始化成当前权益**：
   * 真实回撤立刻归零 → L1-6 熔断在当月剩余时间里再也触发不了 → 而这一切**不留痕迹**，
   * 用户看到的是一份干净的 month_state.json 和一条「回撤 0.00%，正常」。
   * 峰值是「只增不减、抬高一次不可逆」的：丢了就是丢了，所以必须当场可见、必须留证。
   *
   * 顺带把「写」也堵上：非原子写正是造出半截文件的成因，`state/*.json` 一律走 jsonstore。
   */
  const driver = `
import glob, json, os, sys, tempfile
sys.path.insert(0, sys.argv[1])
import archive_round, jsonstore, month_risk

tmp = tempfile.mkdtemp(prefix="qta_month_corrupt_")
month_risk.MONTH_STATE = os.path.join(tmp, "month_state.json")
archive_round.RUNTIME = os.path.join(tmp, "runtime.json")

BROKEN = '{"month": "2026-09", "month_start_equity": 10000.0, "month_peak_eq'


def run(equity):
    return archive_round.update_runtime({
        "time_cst": "2026-09-17 10:00:00",
        "round_id": "R000001",
        "equity_usdt": equity,
        "sl_triggered": 0,
        "trades": [],
        "positions": [],
    })


def read_bytes(p):
    with open(p, "rb") as f:
        return f.read()


def write_raw(p, text):
    # newline="" —— 免掉 Windows 的 \\\\n → \\\\r\\\\n 转换，留档比对才是逐字节的
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(text)


# ① 正常两轮：基准 10000，峰值抬到 11000
run(10000.0)
run(11000.0)
peak_ok = json.loads(read_bytes(month_risk.MONTH_STATE).decode("utf-8"))["month_peak_equity"]

# ② 文件被写坏（半截 —— 真实成因就是 json.dump 写到一半进程被杀）
write_raw(month_risk.MONTH_STATE, BROKEN)

# ③ 交易主循环这一轮
bad = run(9000.0)

# ④ 坏文件应被原样留档
archives = sorted(glob.glob(month_risk.MONTH_STATE + ".corrupt-*"))
archive_text = read_bytes(archives[0]).decode("utf-8") if archives else None
new_state = json.loads(read_bytes(month_risk.MONTH_STATE).decode("utf-8"))
stray_tmp = sorted(glob.glob(os.path.join(tmp, "*.tmp")))
runtime_keys = sorted(json.loads(read_bytes(archive_round.RUNTIME).decode("utf-8")).keys())

# ⑤ 下一轮应完全恢复正常：基准与峰值都重建为本轮权益，之后由真实权益接管
recovered = run(9200.0)
peak_rebuilt = json.loads(read_bytes(month_risk.MONTH_STATE).decode("utf-8"))["month_peak_equity"]
after_recovery = run(8800.0)

# ⑥ 只读视图遇到坏文件：不抛异常、带标记、且绝不改动文件
write_raw(month_risk.MONTH_STATE, "这根本不是 JSON")
before_view = read_bytes(month_risk.MONTH_STATE)
view = month_risk.read_month_state(9000.0)
metrics = month_risk.month_metrics(9000.0)
after_view = read_bytes(month_risk.MONTH_STATE)

# ⑦ 原子写失败：不留半截文件、不动原文件
atomic_path = os.path.join(tmp, "atomic.json")
jsonstore.atomic_write_json(atomic_path, {"keep": 1})
before_atomic = read_bytes(atomic_path)
atomic_err = None
try:
    jsonstore.atomic_write_json(atomic_path, {"bad": object()})
except Exception as e:
    atomic_err = type(e).__name__
after_atomic = read_bytes(atomic_path)

print(json.dumps({
    "peak_ok": peak_ok,
    "bad_dd": bad.get("month_dd_pct"),
    "bad_error": bad.get("month_dd_error"),
    "runtime_keys": runtime_keys,
    "archives": [os.path.basename(a) for a in archives],
    "archive_text": archive_text,
    "broken_text": BROKEN,
    "new_peak": new_state.get("month_peak_equity"),
    "recovered_from": new_state.get("recovered_from"),
    "recovered_error": new_state.get("recovered_error"),
    "reset_note": new_state.get("reset_note"),
    "stray_tmp": stray_tmp,
    "recovered_dd": recovered.get("month_dd_pct"),
    "recovered_error_flag": recovered.get("month_dd_error"),
    "peak_rebuilt": peak_rebuilt,
    "after_recovery_dd": after_recovery.get("month_dd_pct"),
    "after_recovery_error": after_recovery.get("month_dd_error"),
    "view_corrupt": view.get("state_corrupt"),
    "view_error": view.get("corrupt_error"),
    "view_dd": view.get("month_dd_pct"),
    "view_touched": before_view != after_view,
    "metrics_corrupt": metrics.get("month_state_corrupt"),
    "metrics_error": metrics.get("corrupt_error"),
    "atomic_err": atomic_err,
    "atomic_kept": before_atomic == after_atomic,
    "atomic_tmp": sorted(glob.glob(os.path.join(tmp, ".atomic*"))),
}, ensure_ascii=False))
`;

  const py = process.env.PYTHON || "python";
  const hasPython = spawnSync(py, ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

  function runCorruptDriver(t: { skip: (m: string) => void }) {
    if (!hasPython) {
      t.skip(`本机没有可用的 ${py} —— 这条锁没生效，CI 上必须能跑`);
      return null;
    }
    const f = tmpFile("driver_corrupt.py");
    fs.writeFileSync(f, driver, "utf8");
    const r = spawnSync(py, [f, path.join(ROOT, "scripts")], { encoding: "utf8" });
    assert.equal(r.status, 0, `Python 驱动失败：${r.stderr?.slice(0, 500)}`);
    return JSON.parse(r.stdout.trim()) as Record<string, never> & {
      peak_ok: number;
      bad_dd: number | null;
      bad_error: string | null;
      runtime_keys: string[];
      archives: string[];
      archive_text: string | null;
      broken_text: string;
      new_peak: number;
      recovered_from: string | null;
      recovered_error: string | null;
      reset_note: string;
      stray_tmp: string[];
      recovered_dd: number | null;
      recovered_error_flag: string | null;
      peak_rebuilt: number;
      after_recovery_dd: number | null;
      after_recovery_error: string | null;
      view_corrupt: boolean | null;
      view_error: string | null;
      view_dd: number;
      view_touched: boolean;
      metrics_corrupt: boolean;
      metrics_error: string | null;
      atomic_err: string | null;
      atomic_kept: boolean;
      atomic_tmp: string[];
    };
  }

  it("坏文件 → 该轮必须报错（回撤「未知」），而不是拿重置出来的 0 去放行", (t) => {
    const out = runCorruptDriver(t);
    if (!out) return;

    assert.equal(out.peak_ok, 11000, "前置条件不成立：正常两轮没能把峰值抬到 11000");
    // 关键：这一轮的回撤必须是「未知」，而不是重置后的 0.00%
    assert.equal(out.bad_dd, null, "坏文件那一轮仍然给出了回撤数字 —— 重置出来的 0% 不是「这个月没有回撤」");
    assert.ok(
      out.runtime_keys.includes("month_dd_error"),
      `坏文件没被记录成错误：${out.runtime_keys.join(", ")} —— guard.ts 会拿 0 去放行 L1-6`
    );
    assert.ok(
      (out.bad_error ?? "").includes("MonthStateCorrupt"),
      `错误类型没带上：${out.bad_error} —— 三种成因（坏了 / 算错 / 读不动）要分得开`
    );

    // 坏文件必须原样留档（那是唯一的排查线索，不许覆盖）
    assert.equal(out.archives.length, 1, `坏文件没有留档，或留了多份：${out.archives.join(", ")}`);
    assert.ok(out.archives[0].includes(".corrupt-"), `留档命名看不出是坏文件：${out.archives[0]}`);
    assert.equal(out.archive_text, out.broken_text, "留档内容与坏文件不一致 —— 必须逐字节原样保存");

    // 新基准按真实权益重建，并且**把这件事写进状态本身**
    assert.equal(out.new_peak, 9000, `重建后的峰值不是本轮真实权益：${out.new_peak}`);
    assert.equal(out.recovered_from, out.archives[0], "状态里没记住坏文件叫什么 —— 下次看到干净文件会以为从没出过事");
    assert.ok((out.recovered_error ?? "").length > 0, "状态里没记下损坏原因");
    assert.ok(out.reset_note.includes("损坏"), `reset_note 没说明成因：${out.reset_note}`);

    // 不留垃圾临时文件（半截 .tmp 也是「下次读不到」的成因）
    assert.deepEqual(out.stray_tmp, [], `留下了临时文件：${out.stray_tmp.join(", ")}`);
  });

  it("下一轮完全恢复正常（错误标记要被擦掉，新基准要真的在管事）", (t) => {
    const out = runCorruptDriver(t);
    if (!out) return;
    assert.equal(out.recovered_error_flag, null, "一次损坏之后错误标记永久残留 —— 界面会一直显示「数据缺失」");
    // 重建那一轮：基准与峰值都取自本轮权益，所以回撤就是 0（这是「重置」的语义，不是「没回撤」——
    // 它之所以成立，是因为上一轮的真相（峰值丢了）已经以 MonthStateCorrupt 的形式报出去了）
    assert.equal(out.recovered_dd, 0, `重建基准那一轮的回撤应为 0：${out.recovered_dd}`);
    assert.equal(out.peak_rebuilt, 9200, `重建后的峰值没跟着真实权益走：${out.peak_rebuilt}`);
    // 关键：重建之后回撤必须重新从**新基准**算起，而不是继续拿 9000/11000 这两个旧数（也没有旧数了）
    assert.ok(
      Math.abs((out.after_recovery_dd ?? 0) - -4.3478) < 0.01,
      `重建后的回撤口径不对（8800 / 峰值 9200 应约 -4.35%）：${out.after_recovery_dd}`
    );
    assert.equal(out.after_recovery_error, null, "恢复之后又出现错误标记");
  });

  it("只读视图不抛异常，但必须把「损坏」标记带出去（界面才有机会显示「—」）", (t) => {
    const out = runCorruptDriver(t);
    if (!out) return;
    assert.equal(out.view_corrupt, true, "只读视图把坏文件当成了「首次初始化」—— 界面会显示一个假的 0.00% 回撤");
    assert.ok((out.view_error ?? "").length > 0, "只读视图没带出损坏原因");
    assert.equal(out.view_touched, false, "只读视图改动了坏文件 —— 排查线索被覆盖");
    assert.equal(out.metrics_corrupt, true, "month_metrics 没把损坏标记传出去 —— 展示层无从判断该不该显示「—」");
    assert.ok((out.metrics_error ?? "").length > 0, "month_metrics 没带出损坏原因");
  });

  it("原子写失败不留半截文件、不动原文件", (t) => {
    const out = runCorruptDriver(t);
    if (!out) return;
    assert.equal(out.atomic_err, "TypeError", `序列化失败应原样抛出：${out.atomic_err}`);
    assert.equal(out.atomic_kept, true, "写失败时动了原文件 —— 原文件至少还是上一次的完整内容，不该被破坏");
    assert.deepEqual(out.atomic_tmp, [], `写失败留下临时文件：${out.atomic_tmp.join(", ")}`);
  });

  it("结构锁：state/*.json 的写一律走 jsonstore（就地 json.dump 正是半截文件的成因）", () => {
    // Python 的行注释是 `#`（_src.ts 的 stripComments 只认 C 风格），先按行剔掉再判，
    // 否则注释里提一句 `json.dump` 就会误红 —— 「结构锁读源码前必须先剥注释」本仓已栽过三次。
    const codeOnly = (src: string) =>
      src
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");
    // ⚠ 第 16 轮改：这条锁原来**写死两个文件名**（`month_risk.py` / `archive_round.py`），
    // 标题却说「state/*.json 的写一律走 jsonstore」—— 一条覆盖全仓的规矩、一个只认两个名字的守卫。
    // 后果是 `order_id.py`（幂等登记表）与 `review_trade.py`（复盘账本）两处「读 → 改 → 写」
    // 一直用就地 `json.dump`，而它们恰是最要命的两处。
    // 现在「哪些文件可以有裸写」由 `tests/statewriters.test.ts` 从 glob 现算 + 棘轮表管，
    // 这里只留 jsonstore 自身与 L1-6 读方的落点断言（不是覆盖率清单）。
    const store = codeOnly(read("scripts/jsonstore.py"));
    assert.ok(store.includes("os.replace("), "jsonstore 的原子替换不见了");
    assert.ok(store.includes("os.fsync("), "jsonstore 少了 fsync —— 换名是原子的，内容有没有落盘是另一件事");
    // 「读不出来就当首次初始化」正是峰值被静默清零的那一步。锁它的**落点**而不是某段字面量
    // （断言一段固定写法在改坏之后照样能通过，等于没锁）：读状态必须经由
    // `jsonstore.read_json_state` 这个「没有文件 / 文件坏了」分得开的入口。
    assert.ok(
      codeOnly(read("scripts/month_risk.py")).includes("jsonstore.read_json_state("),
      "month_risk 又自己 open+json.load 读状态了 —— 那条路分不出「首次运行」与「数据丢了」"
    );
    // L1-6 的分母与熔断读数这两条最贵的数据，必须走原子写（覆盖率由 statewriters 的 glob 现算）
    for (const f of ["scripts/month_risk.py", "scripts/archive_round.py"]) {
      assert.ok(
        codeOnly(read(f)).includes("jsonstore.atomic_write_json("),
        `${f} 的写没走原子写`
      );
    }
  });
});
