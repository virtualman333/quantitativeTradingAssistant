/**
 * runtimecorrupt.test.ts —— `state/runtime.json` 被写坏时，谁在说谎
 *
 * 为什么需要这份测试
 * ------------------
 * `scripts/jsonstore.py` 的模块头把话说得很清楚：`state/` 下的 JSON 不是缓存，是
 * **安全判据的载体**，其中点名了两个文件 —— `month_state.json`（L1-6 的分母）与
 * **`runtime.json`（熔断与月度回撤的读数）**。第 13 轮把「文件不存在」与「文件读不出来」
 * 分开这件事做在了 `month_state.json` 上，**`runtime.json` 那条路没有跟着做**：
 *
 *     st = {}
 *     if os.path.exists(RUNTIME):
 *         try:
 *             st = json.load(...)
 *         except Exception:
 *             st = {}          # ← 「坏了」与「新机器首次运行」在这里长得一模一样
 *
 * 而紧接着的逻辑是「新的一天/首次 → 计数清零、基准取当前权益」，然后**原子写回去**。
 * 实跑（本文件第一组用例的基线）：
 *
 *     坏之前： day_sl_count=2  circuit_breaker=True   round_count=3  inception_equity=10000
 *     坏之后： day_sl_count=0  circuit_breaker=False  round_count=1  inception_equity=9700
 *     留档：   无。坏文件被紧随其后的原子写**覆盖销毁** —— 唯一的排查线索没了
 *
 * 净效果：`scripts/dashboard.py` 与 `scripts/mail_report.py` 的两个
 * `if runtime.get("circuit_breaker")` 同时静默——**看板与邮件会一起告诉用户「今日未熔断」**，
 * 而当天可能已经止损两次、早已触发熔断。
 *
 * 本文件锁四件事：
 *   A. 坏文件必须**原样留档**（逐字节），且留档不覆盖前一份证据；
 *   B. 重置出来的 0 不许冒充「今天没止损过」：写 `day_counters_compromised`，
 *      且 `circuit_breaker` 写 `null`（未知）而不是 `false`（未熔断）；跨日自动清除；
 *   C. TS 侧的读数（`loadRunState`）如实带出这两个字段；
 *   D. 源码形态：读盘只走 `jsonstore.read_json_state`，两个消费方都认得那个标记键。
 *
 * 运行：pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { loadRunState, normalizeRuntime, readRuntimeFile, runStateFrom } from "../src/runstate.ts";
import { dayCountersView, monthRiskView } from "../ui/lib/riskbrief.js";
import { ROOT, read, stripComments, stripPythonStrings } from "./_src.ts";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "qta-rtcorrupt-"));
const tmpFile = (name: string) => path.join(tmpDir(), name);

const PYTHON = process.env.PYTHON || "python";
const HAS_PYTHON = spawnSync(PYTHON, ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

/**
 * 判「**代码里**有没有这段东西」时用的文本。
 *
 * 原先只是按行剔掉 `#` 开头的行。实测那样不够：`archive_round.py` 的模块 docstring 里
 * 写着「**读**走 `jsonstore.read_json_state()`」、`month_risk.py` 的
 * `_quarantine_broken_state` docstring 里带着 `jsonstore.quarantine_broken()` ——
 * docstring 不是 `#` 开头的行，于是**散文把断言满足了**：把真调用改掉，锁照样绿。
 *
 * 现在连字符串字面量（含 docstring）一起剥（`stripPythonStrings`）。下面三条结构锁
 * 因此在构造上只能由真正的代码满足，且各自都有一条反向对照钉着（见文件末尾那组）。
 */
const codeOnly = (src: string) => stripPythonStrings(src);

function runDriver(t: { skip: (m?: string) => void }, name: string, driver: string): Record<string, unknown> | null {
  if (!HAS_PYTHON) {
    t.skip(`本机没有可用的 ${PYTHON} —— 这条锁没生效，CI 上必须能跑`);
    return null;
  }
  const f = tmpFile(`${name}.py`);
  fs.writeFileSync(f, driver, "utf8");
  const r = spawnSync(PYTHON, [f, path.join(ROOT, "scripts")], { encoding: "utf8" });
  assert.equal(r.status, 0, `Python 驱动失败：${r.stderr?.slice(0, 600)}`);
  // 取最后一行 JSON：被真跑的脚本自己会 print（如 dashboard 的「DASHBOARD.md 已更新」），
  // 不能让它们的输出把驱动的结果顶掉。
  const lines = (r.stdout || "").trim().split(/\r?\n/).filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

// 所有驱动共用的前半段（隔离两个状态文件到临时目录）
const PRELUDE = `
import glob, json, os, sys, tempfile
sys.path.insert(0, sys.argv[1])
import archive_round, jsonstore, month_risk

tmp = tempfile.mkdtemp(prefix="qta_rtcorrupt_")
month_risk.MONTH_STATE = os.path.join(tmp, "month_state.json")
archive_round.RUNTIME = os.path.join(tmp, "runtime.json")


def run(equity, sl=0, day="2026-09-17"):
    return archive_round.update_runtime({
        "time_cst": day + " 10:00:00", "round_id": "R000001",
        "equity_usdt": equity, "sl_triggered": sl, "trades": [], "positions": [],
    })


def write_raw(p, text):
    # newline="" —— 免掉 Windows 的 \\n → \\r\\n 转换，留档比对才是逐字节的
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def read_text(p):
    with open(p, "rb") as f:
        return f.read().decode("utf-8")


def archives():
    return sorted(glob.glob(archive_round.RUNTIME + jsonstore.CORRUPT_SUFFIX + "*"))


def disk():
    return json.loads(read_text(archive_round.RUNTIME))
`;

describe("runtime.json 被写坏：该留的证据要留，该说的话要说", () => {
  /**
   * 这一组的第一个断言刻意先跑一遍**修之前那条路**会得到的结论（day_sl_count=2 /
   * circuit_breaker=True），作为「这几个数字本来是真的」的基线 —— 否则后面
   * 「重置成 0 是撒谎」这句话没有对照物。
   */
  const driver =
    PRELUDE +
    `
BROKEN = '{"current_day": "2026-09-17", "day_sl_count": 2, "round_cou'

run(10000.0, sl=1)
run(9900.0, sl=1)
before = run(9800.0)                      # 基线：本日已止损 2 次 → 熔断

write_raw(archive_round.RUNTIME, BROKEN)  # 文件被写坏（半截 —— 真实成因就是 json.dump 写到一半被杀）
after = run(9700.0)                       # 交易主循环这一轮

arcs = archives()
next_day = run(9700.0, day="2026-09-18")  # 跨日

# 同一秒内第二次损坏：留档不许覆盖前一份
write_raw(archive_round.RUNTIME, "又是坏的")
run(9600.0)

print(json.dumps({
    "before": {k: before.get(k) for k in ("day_sl_count", "circuit_breaker", "round_count", "inception_equity")},
    "after": {k: after.get(k) for k in ("day_sl_count", "circuit_breaker", "round_count",
                                        "day_counters_compromised", "day_counters_compromised_at",
                                        "day_counters_compromised_error", "recovered_from", "recovered_error")},
    "archive_count": len(arcs),
    "archive_text": read_text(arcs[0]) if arcs else None,
    "archive_name": os.path.basename(arcs[0]) if arcs else None,
    "archive_still_broken": BROKEN,
    "next_day": {k: next_day.get(k) for k in ("day_counters_compromised", "circuit_breaker",
                                              "day_sl_count", "recovered_from", "current_day")},
    "disk_after_second": disk(),
    "archives_all": [os.path.basename(p) for p in archives()],
    "archives_all_text": [read_text(p) for p in archives()],
    "tmp_leftovers": sorted(os.path.basename(p) for p in glob.glob(os.path.join(tmp, "*.tmp"))),
    "compromised_key": archive_round.COMPROMISED_KEY,
}, ensure_ascii=False))
`;

  it("坏文件原样留档、计数不再冒充「今天没止损过」、跨日自动清除标记", (t) => {
    const out = runDriver(t, "driver_corrupt", driver);
    if (!out) return;

    const before = out.before as Record<string, unknown>;
    const after = out.after as Record<string, unknown>;
    const nextDay = out.next_day as Record<string, unknown>;

    // 基线：这几个数本来是真的（修之前它们会被静默清零）
    assert.equal(before.day_sl_count, 2);
    assert.equal(before.circuit_breaker, true, "基线就不成立 —— 后面「被清零」的说法没有对照物");
    assert.equal(before.round_count, 3);

    // ① 坏文件必须被原样留档（逐字节），而不是被紧随其后的原子写覆盖掉
    assert.equal(out.archive_count, 1, `坏文件没有被留档 —— 唯一的排查线索被覆盖销毁了`);
    assert.equal(
      out.archive_text,
      out.archive_still_broken,
      "留档内容与坏文件不一致 —— 留档必须是逐字节的原件（新一轮读取才能还原现场）"
    );
    assert.ok((out.archive_name as string).includes(".corrupt-"), `留档名看不出是坏文件：${out.archive_name}`);
    assert.deepEqual(out.tmp_leftovers, [], "留档过程留下了临时文件");

    // ② 计数确实丢了 —— 但状态里必须写明「这个 0 是重置出来的」
    assert.equal(after.day_sl_count, 0, "重置后计数应如实为 0（我们**不**伪造原值）");
    assert.equal(
      after.day_counters_compromised,
      true,
      "重置出来的 0 没有标记 —— 看板与邮件会一起得出「今日未熔断」（实际已熔断两次）"
    );
    assert.ok(
      String(after.day_counters_compromised_error ?? "").length > 0,
      "没把损坏原因记下来 —— 用户只能看到「—」，看不到为什么"
    );
    assert.equal(after.day_counters_compromised_at, "2026-09-17 10:00:00");
    assert.equal(
      after.recovered_from,
      out.archive_name,
      "状态里没指向留档文件 —— 下次有人看到一份干净的 runtime.json 会以为从没出过事"
    );

    // ③ 「不知道熔没熔断」必须与「没熔断」可分辨
    assert.equal(
      after.circuit_breaker,
      null,
      "计数不可信时把 circuit_breaker 写成了 false —— falsy 值会被消费方读成「一切正常」"
    );
    assert.equal(before.circuit_breaker, true, "对照：正常路径仍然写布尔值");

    // ④ 跨日：新的一天本来就要清零，昨天的损坏不再影响本日可信度
    assert.equal(nextDay.current_day, "2026-09-18");
    assert.equal(nextDay.day_counters_compromised, null, "跨日后本日计数标记没被清掉 —— 界面会永久显示「不可信」");
    assert.equal(nextDay.circuit_breaker, false, "跨日清零后应恢复成布尔值");
    assert.equal(nextDay.recovered_from, out.archive_name, "留档线索被跨日清掉了 —— 证据不该跟标记一起消失");

    // ⑤ 同一秒内第二次损坏不覆盖前一份证据
    const all = out.archives_all as string[];
    const texts = out.archives_all_text as string[];
    assert.equal(all.length, 2, `第二次损坏挤掉了前一份留档：${all.join(", ")}`);
    assert.ok(texts.includes(out.archive_still_broken as string), "第一份留档的内容被覆盖了");
    assert.ok(texts.includes("又是坏的"), "第二份留档没落地");
    assert.notEqual(all[0], all[1], "两份留档重名（第二份把第一份覆盖了）");
  });

  it("顶层不是对象（合法 JSON）也走同一条路 ——「结构不对」同样是数据丢了", (t) => {
    const driver2 =
      PRELUDE +
      `
run(10000.0, sl=1)
write_raw(archive_round.RUNTIME, "[1, 2, 3]")   # 能被 json 解析，但不是本模块写出来的形状
st = run(9700.0)
print(json.dumps({
    "count": len(archives()),
    "compromised": st.get("day_counters_compromised"),
    "circuit_breaker": st.get("circuit_breaker"),
    "error": st.get("recovered_error"),
}, ensure_ascii=False))
`;
    const out = runDriver(t, "driver_nondict", driver2);
    if (!out) return;
    assert.equal(out.count, 1, "顶层不是对象的文件没有被留档");
    assert.equal(out.compromised, true);
    assert.equal(out.circuit_breaker, null);
    assert.ok(String(out.error ?? "").includes("顶层不是对象"), `原因没说清：${out.error}`);
  });

  it("首次运行（没有文件）不产生留档、也不打标记 —— 别把「新机器」当成「出过事」", (t) => {
    const driver3 =
      PRELUDE +
      `
st = run(10000.0, sl=0)
print(json.dumps({
    "archives": len(archives()),
    "compromised": st.get("day_counters_compromised"),
    "circuit_breaker": st.get("circuit_breaker"),
    "day_sl_count": st.get("day_sl_count"),
    "round_count": st.get("round_count"),
}, ensure_ascii=False))
`;
    const out = runDriver(t, "driver_fresh", driver3);
    if (!out) return;
    assert.equal(out.archives, 0, "首次运行被当成了「文件坏了」");
    assert.equal(out.compromised, null, "首次运行打了「计数不可信」标记 —— 界面上会一直挂着一条假告警");
    assert.equal(out.circuit_breaker, false);
    assert.equal(out.day_sl_count, 0);
    assert.equal(out.round_count, 1);
  });

  it("坏文件挪不动时（留档失败）宁可整轮报错，也不覆盖证据", (t) => {
    const driver4 =
      PRELUDE +
      `
write_raw(archive_round.RUNTIME, "坏的")
# 模拟留档失败：Monkeypatch 掉 os.replace（挪动只有这一条路）
real = os.replace
def boom(*a, **k):
    raise OSError("设备忙")
os.replace = boom
raised = None
try:
    run(9700.0)
except Exception as e:  # noqa: BLE001
    raised = type(e).__name__
os.replace = real
print(json.dumps({
    "raised": raised,
    "file_intact": read_text(archive_round.RUNTIME) == "坏的",
}, ensure_ascii=False))
`;
    const out = runDriver(t, "driver_quarantine_fail", driver4);
    if (!out) return;
    assert.equal(out.raised, "RuntimeStateCorrupt", `留档失败时抛的是 ${out.raised} —— 需要一条能辨认的异常`);
    assert.equal(out.file_intact, true, "留档失败却把坏文件覆盖掉了 —— 证据没了，下一轮也无从发现");
  });
});

// ── C. TS 侧读数 ──────────────────────────────────────────────────────────

describe("loadRunState · 带出「本日计数不可信」与三态熔断", () => {
  it("compromised 与 circuit_breaker=null 都如实读出（不许被 ??false 洗白）", () => {
    const f = tmpFile("runtime.json");
    fs.writeFileSync(
      f,
      JSON.stringify({
        day_sl_count: 0,
        day_pnl_pct: 0,
        round_count: 12,
        circuit_breaker: null,
        day_counters_compromised: true,
      }),
      "utf8"
    );
    const st = loadRunState(f);
    assert.equal(st.dayCountersCompromised, true, "本日计数已被重置却读成可信 —— 界面会显示一个假的「本日止损 0」");
    assert.equal(
      st.circuitBreaker,
      null,
      "circuit_breaker 的 null 被洗成了 false —— 「不知道」与「没熔断」从此不可分辨"
    );
  });

  it("正常文件：compromised=false、熔断如实为布尔", () => {
    const f = tmpFile("runtime.json");
    fs.writeFileSync(f, JSON.stringify({ day_sl_count: 2, circuit_breaker: true, round_count: 5 }), "utf8");
    const st = loadRunState(f);
    assert.equal(st.dayCountersCompromised, false);
    assert.equal(st.circuitBreaker, true);
  });

  it("字段缺失 / 非布尔：熔断一律为 null（未知），不许默认 false", () => {
    for (const bad of [{}, { circuit_breaker: "no" }, { circuit_breaker: 0 }]) {
      const f = tmpFile("runtime.json");
      fs.writeFileSync(f, JSON.stringify(bad), "utf8");
      assert.equal(loadRunState(f).circuitBreaker, null, `${JSON.stringify(bad)} 被当成了「未熔断」`);
    }
  });
});

// ── C″. TS 侧自己遇到坏文件（本次新增，见下） ─────────────────────────────

/**
 * 为什么单独一组：上面 C 组喂的文件**已经带着标记键**（`day_counters_compromised` 等），
 * 它证明的只是「标记键读得出来」。真正的缺口在另一条路上 —— `state/runtime.json` 坏掉之后、
 * 本轮结尾 `archive_round.py` 重写之前（或它压根不会跑时），由 **TS 自己**读到那个文件。
 *
 * 旧实现 `catch { return def }` 把「文件坏了」与「文件不存在」返回成同一份默认值，
 * 其中 `dayCountersCompromised: false`、`daySlCount: 0` —— 也就是
 * **「今天一次止损都没触发过」**。这与第 13/14 轮在 `jsonstore` 上修掉的
 * `except: 当作首次初始化` 是同一个形状，只是这次在 TS 侧：
 * Python 侧一个字都没漏，TS 侧一个字都没改。
 */
describe("TS 自己读到坏文件：不许把「数据丢了」说成「今天没止损过」", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["空文件（写了一半就没了）", "", /空/],
    ["半截 JSON", '{"day_sl_count": 2, "circuit_br', /JSON/],
    ["顶层是数组", "[1, 2, 3]", /顶层不是对象/],
    ["顶层是标量", "12345", /顶层不是对象/],
    ["顶层是 null", "null", /顶层不是对象/],
  ];

  for (const [name, text, why] of cases) {
    it(`${name} → 计数标成不可信、熔断为 null（未知），并带出原因`, () => {
      const f = tmpFile("runtime.json");
      fs.writeFileSync(f, text, "utf8");
      const rc = readRuntimeFile(f);
      assert.equal(rc.absent, false, "文件明明在，却被判成「不存在」—— 两条路又并成一条了");
      assert.ok(rc.error, `${name}：读不出来却没给出原因`);
      assert.match(String(rc.error), why, `原因说得不清（${rc.error}）`);

      const st = runStateFrom(rc);
      assert.equal(st.dayCountersCompromised, true, `${name} 被当成了「今天没止损过」`);
      assert.equal(st.circuitBreaker, null, `${name} 被当成了「未熔断」`);
      assert.equal(st.monthDdPct, null);
      assert.ok(st.unreadable, "读数不可信却没在 RunState 上点名");
    });
  }

  it("文件不存在 ≠ 文件读不出来：前者是首次运行，后者是数据丢了", () => {
    const rcA = readRuntimeFile(path.join(os.tmpdir(), "qta-rt-absent-77.json"));
    assert.deepEqual(rcA, { raw: null, error: null, absent: true });
    assert.equal(runStateFrom(rcA).dayCountersCompromised, false, "首次运行不该被标成「计数不可信」");

    const f = tmpFile("runtime.json");
    fs.writeFileSync(f, "", "utf8");
    assert.equal(readRuntimeFile(f).absent, false, "空文件被判成了「不存在」—— 静默初始化就是这么来的");
  });

  it("读得出来的文件：一个标记都不许叠上去", () => {
    const f = tmpFile("runtime.json");
    fs.writeFileSync(f, JSON.stringify({ day_sl_count: 3, circuit_breaker: false, round_count: 8 }), "utf8");
    const rc = readRuntimeFile(f);
    assert.equal(rc.error, null);
    assert.deepEqual(normalizeRuntime(rc), rc.raw, "健康数据被改写了 —— 下游会看到一个不存在的损坏");
    const st = runStateFrom(rc);
    assert.equal(st.dayCountersCompromised, false);
    assert.equal(st.daySlCount, 3);
    assert.equal(st.circuitBreaker, false);
    assert.equal(st.unreadable, null);
  });
});

// ── C‴. 归一化后的读数喂给界面：显示「—」而不是「0」 ──────────────────────

describe("坏文件 → 总览页（同一份归一化输出，界面不必知道是 TS 还是 Python 发现的）", () => {
  /** electron 的 getStatus() 交给界面的就是这一份（`normalizeRuntime(readRuntimeFile(...))`） */
  const uiRuntime = (text: string) => {
    const f = tmpFile("runtime.json");
    fs.writeFileSync(f, text, "utf8");
    return normalizeRuntime(readRuntimeFile(f));
  };

  it("本日止损显示「—」并说明原因，不再是一个干净的 0", () => {
    const v = dayCountersView(uiRuntime("{ not json at all"));
    assert.equal(v.compromised, true, "坏文件在总览页上没被标出来");
    assert.equal(v.slText, "—", `坏文件显示成了「${v.slText}」—— 用户会以为今天一次都没止损`);
    assert.match(String(v.note), /读不出来/, "说明文案没说清是「读不出来」");
  });

  it("月度风控说「读不出来」，而不是「暂无运行态（跑一轮后产生）」", () => {
    const mv = monthRiskView(uiRuntime(""));
    assert.equal(mv.level, "unknown");
    assert.match(String(mv.reason), /读不出来/, `给用户的理由不对：${mv.reason}`);
  });
});

// ── C′. 看板展示层 ────────────────────────────────────────────────────────

describe("dayCountersView · 「本日止损」在计数被重置后必须显示「—」", () => {
  it("正常状态：照实显示计数，不带告警", () => {
    const v = dayCountersView({ day_sl_count: 2, day_counters_compromised: false });
    assert.equal(v.slText, "2");
    assert.equal(v.compromised, false);
    assert.equal(v.note, "");
  });

  it("计数为 0 但没出过事：显示 0（0 是合法值，不是「未知」）", () => {
    assert.equal(dayCountersView({ day_sl_count: 0 }).slText, "0");
    assert.equal(dayCountersView({}).slText, "0", "字段缺失时界面空着比显示 0 更糟");
  });

  it("计数被重置过：显示「—」并说明原因，不再冒充「今天没止损过」", () => {
    const v = dayCountersView({
      day_sl_count: 0,
      day_counters_compromised: true,
      day_counters_compromised_at: "2026-09-17 10:00:00",
      day_counters_compromised_error: "JSONDecodeError: boom",
    });
    assert.equal(v.slText, "—", "重置出来的 0 被当成真实计数显示了");
    assert.equal(v.compromised, true);
    assert.ok(v.note.includes("本日计数不可信"), v.note);
    assert.ok(v.note.includes("2026-09-17 10:00:00"), "没说是哪一轮出的事");
    assert.ok(v.note.includes("JSONDecodeError"), "没把损坏原因带给用户");
    assert.ok(v.note.includes("人工核对"), "没告诉用户接下来该做什么");
  });

  it("只有布尔 true 才算数（字符串 \"true\" 之类不算——宁可少报一次真，不可多报一次假）", () => {
    for (const bad of ["true", 1, "yes", {}]) {
      assert.equal(dayCountersView({ day_sl_count: 3, day_counters_compromised: bad }).compromised, false);
    }
  });
});

// ── D. 源码形态 ───────────────────────────────────────────────────────────

describe("结构锁 · 读盘只有一条路，两个消费方都认得那个标记键", () => {
  it("archive_round.py 读运行态走 jsonstore.read_json_state（分得开「没有」与「坏了」）", () => {
    const src = codeOnly(read("scripts/archive_round.py"));
    assert.ok(
      src.includes("jsonstore.read_json_state("),
      "archive_round 又自己 open + json.load 读运行态了 —— 那条路会把「坏了」当成「首次运行」"
    );
    assert.ok(
      !src.includes("json.load("),
      "archive_round 里出现了就地 json.load —— 读状态只能经由 read_json_state"
    );
    assert.ok(
      src.includes("jsonstore.quarantine_broken("),
      "坏文件没有被留档 —— 它会被紧接着的原子写覆盖销毁"
    );
  });

  it("留档规则只有一份实现（month_risk 与 archive_round 共用 jsonstore）", () => {
    const store = codeOnly(read("scripts/jsonstore.py"));
    assert.ok(store.includes("def quarantine_broken("), "jsonstore 里没有共用的留档函数");
    assert.ok(store.includes("os.replace("), "留档没用原子替换 —— 「复制 + 删除」中途被杀会留下半份副本");
    const mr = codeOnly(read("scripts/month_risk.py"));
    assert.ok(
      mr.includes("jsonstore.quarantine_broken("),
      "month_risk 又自己写了一份留档 —— 两条路径的留档规则（含「不覆盖前一份」）必须同源"
    );
  });

  it("看板真的会在这种情况下开口 —— 真跑 dashboard.build() 读它生成的 DASHBOARD.md", (t) => {
    // 不用「源码里出现过某个键名」这种锁：键名在同一个分支体里还有第二处出现，
    // 把整个分支改成 `if False:` 它照样绿（本轮负向验证实测过）。这里改成真跑一遍。
    const driver =
      `
import argparse, contextlib, io, json, os, sys, tempfile
sys.path.insert(0, sys.argv[1])
import dashboard

tmp = tempfile.mkdtemp(prefix="qta_dash_")
dashboard.DASH = os.path.join(tmp, "DASHBOARD.md")     # 别覆盖仓库里的 DASHBOARD.md
dashboard.RUNTIME = os.path.join(tmp, "runtime.json")
ARGS = argparse.Namespace(account="", next_round="")


def gen(payload=None, raw=None):
    with open(dashboard.RUNTIME, "w", encoding="utf-8", newline="") as f:
        f.write(raw if raw is not None else json.dumps(payload))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):               # build() 自己会 print，别污染结果
        dashboard.build(ARGS)
    with open(dashboard.DASH, encoding="utf-8") as f:
        return f.read()


print(json.dumps({
    "normal": gen({"round_count": 5, "day_sl_count": 0, "circuit_breaker": False}),
    "tripped": gen({"round_count": 5, "day_sl_count": 2, "day_pnl_pct": -3.2, "circuit_breaker": True}),
    "broken": gen(raw="{ 这不是 JSON"),
    "compromised": gen({"round_count": 6, "day_sl_count": 0, "circuit_breaker": None,
                        "day_counters_compromised": True,
                        "day_counters_compromised_at": "2026-09-17 10:00:00",
                        "day_counters_compromised_error": "JSONDecodeError: boom"}),
}, ensure_ascii=False))
`;
    const out = runDriver(t, "driver_dash", driver);
    if (!out) return;
    const at = (k: string) => String(out[k] ?? "");

    // 对照组：正常且未熔断时什么都不说（否则下面的断言只是「总会说点什么」）
    assert.ok(!at("normal").includes("熔断中"), "正常状态下看板就在报熔断");
    assert.ok(!at("normal").includes("不可信"), "正常状态下看板就在报「计数不可信」");

    // 真熔断了：照旧要说
    assert.ok(at("tripped").includes("熔断中"), "真的熔断时看板没有报出来");

    // 文件读不出来：看板必须说「损坏」，而不是当成空的运行态默默过去
    assert.ok(
      at("broken").includes("运行态文件损坏"),
      "运行态文件坏了，看板一个字都没说 —— 用户读到的是「今日未熔断」"
    );

    // 计数被重置过：必须明说不可信，且**不能**反过来谎报熔断
    assert.ok(at("compromised").includes("本日计数不可信"), "计数被重置过，看板仍然当作真实数据展示");
    assert.ok(
      !at("compromised").includes("熔断中"),
      "把「未知」当成了「熔断中」—— 两个方向都是假话，别修一个造一个"
    );
  });

  it("邮件报表同样会开口 —— 真跑 mail_report.render() 读它产出的 alerts", (t) => {
    const driver =
      `
import json, sys
sys.path.insert(0, sys.argv[1])
import mail_report

rnd = {"round_id": "R000009", "time_cst": "2026-09-17 10:00:00",
       "equity_usdt": 10000.0, "available_usdt": 9000.0,
       "trades": [], "actions": [], "decision": "观望", "positions": []}
mp = {"month": "2026-09", "month_start_equity": 10000.0, "equity": 10000.0,
      "month_pnl_pct": -1.0, "month_dd_pct": -1.0,
      "realized_pnl": 0.0, "realized_n": 0, "fee": 0.0,
      "day": 17, "days_in_month": 30, "time_progress": 0.57,
      "achieved_pct_of_target": -10.0, "month_state_corrupt": False, "corrupt_error": None}


def alerts_for(runtime, err):
    # 风险档位用仓库自己的表，不在这里手抄一份（同一事实两处写法必然漂移）
    tier_key, tier = mail_report.pick_risk_tier(mp["month_pnl_pct"], mp["time_progress"], mp["month_dd_pct"])
    return mail_report.render(rnd, runtime, {}, tier_key, tier, mp, err)[2]


print(json.dumps({
    "normal": alerts_for({"round_count": 5, "day_sl_count": 0, "circuit_breaker": False}, None),
    "tripped": alerts_for({"round_count": 5, "day_sl_count": 2, "circuit_breaker": True}, None),
    "broken": alerts_for({}, "JSONDecodeError: boom"),
    "compromised": alerts_for({"round_count": 6, "day_sl_count": 0, "circuit_breaker": None,
                               "day_counters_compromised": True,
                               "day_counters_compromised_at": "2026-09-17 10:00:00",
                               "day_counters_compromised_error": "JSONDecodeError: boom"}, None),
}, ensure_ascii=False))
`;
    const out = runDriver(t, "driver_mail", driver);
    if (!out) return;
    const at = (k: string) => (out[k] as string[]).join("\n");

    assert.ok(!at("normal").includes("熔断"), "正常状态下邮件就在报熔断");
    assert.ok(at("tripped").includes("熔断中"), "真的熔断时邮件没有报出来");
    assert.ok(at("broken").includes("运行态文件损坏"), "运行态读不出来，邮件一个字都没说");
    assert.ok(at("compromised").includes("本日计数不可信"), "计数被重置过，邮件仍然当作真实数据展示");
    assert.ok(!at("compromised").includes("熔断中"), "把「未知」当成了「熔断中」");
  });

  it("看板卡片不再无条件显示 day_sl_count（重置后的 0 与「今天没止损过」长得一样）", () => {
    // 决定「显示什么」的是纯函数 `dayCountersView`（下面有行为断言），
    // 这里只锁「模板确实用了它」这个落点 —— 断言的是调用，不是字面量形状。
    const src = stripComments(read("ui/components/DashboardView.vue"));
    assert.ok(
      src.includes("dayCountersView("),
      "看板模板不再经由 dayCountersView 决定「本日止损」显示什么 —— 它会把重置出来的 0 当成「今天没止损过」"
    );
    assert.ok(
      !/day_sl_count/.test(src),
      "看板又自己去读 day_sl_count 了 —— 判定必须留在 dayCountersView 里（否则它读不到损坏标记）"
    );
  });
});

// ── E. 第三个写者：trade_round.py（每轮取数时就跑，而且跑在归档**之前**） ────────

describe("trade_round · 抢在归档之前碰同一个文件的那个写者", () => {
  /**
   * 为什么单列一组：`state/runtime.json` 有三个碰它的地方 ——
   * `archive_round.py`（收尾归档，已修）、`dashboard.py` / `mail_report.py`（只读），
   * 以及 **`trade_round.py`**（每轮取数时 `bump_runtime()` 写一次）。第三处当时没跟着修，
   * 而它**跑在归档之前**：一旦它先把读不出来的文件覆盖成一份「只有三个字段的合法 JSON」，
   * 归档那边就再也看不出出过事 —— 上面整组保护（留档 / `day_counters_compromised` /
   * `circuit_breaker=null`）会被从旁边架空，看板与邮件照旧说「今日未熔断」。
   * 同一份文件、同一个「读坏了当成首次运行」的毛病，两处写法就是两颗雷。
   *
   * 这一组刻意只用**行为**断言，不写「源码里出现过 jsonstore.read_json_state」这类结构锁：
   * Python 的 docstring 是字符串字面量，`stripComments()` 剥不掉（它只剥注释），
   * 那种断言会被函数自己的 docstring 满足 —— 那正是本仓连续多轮踩到的假锁。
   */
  const driver =
    `
import glob, json, os, sys, tempfile
sys.path.insert(0, sys.argv[1])
import archive_round, jsonstore, trade_round

tmp = tempfile.mkdtemp(prefix="qta_trcorrupt_")
trade_round.STATE = tmp
trade_round.RUNTIME = os.path.join(tmp, "runtime.json")
trade_round.LOGS = os.path.join(tmp, "logs")
archive_round.RUNTIME = trade_round.RUNTIME          # 真实布局：两个脚本写的是同一个文件
os.makedirs(trade_round.LOGS, exist_ok=True)

HEALTHY = {
    "round_no": 3, "current_day": "2026-09-17", "day_sl_count": 2,
    "day_start_equity": 10000.0, "day_trade_count": 5, "circuit_breaker": True,
    "month_dd_pct": 4.5, "inception_equity": 10000.0, "inception_date": "2026-09-01",
}


def write_raw(p, text):
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def read_text(p):
    with open(p, "rb") as f:
        return f.read().decode("utf-8")


def disk():
    return json.loads(read_text(trade_round.RUNTIME))


def archives():
    return sorted(glob.glob(trade_round.RUNTIME + jsonstore.CORRUPT_SUFFIX + "*"))


# ① 对照组：健康文件下 bump_runtime 只补轮次号，安全判据一个都不许丢
write_raw(trade_round.RUNTIME, json.dumps(HEALTHY))
healthy_ret = trade_round.bump_runtime("R000004")
healthy_disk = disk()

# ①′ 写回必须经由 jsonstore 的原子写（假协作者：换掉它，看那条路还走不走）
aw_calls = []
_real_aw = jsonstore.atomic_write_json


def _spy(path, data, **kw):
    aw_calls.append(path)
    return _real_aw(path, data, **kw)


jsonstore.atomic_write_json = _spy
write_raw(trade_round.RUNTIME, json.dumps(HEALTHY))
trade_round.bump_runtime("R000004")
jsonstore.atomic_write_json = _real_aw

# ② 归档日志里有 7 轮 —— 运行态读不出来时的兜底来源
with open(os.path.join(trade_round.LOGS, "rounds.jsonl"), "w", encoding="utf-8", newline="") as f:
    for i in range(1, 8):
        f.write(json.dumps({"round_id": "R%06d" % i}) + "\\n")

# ③ 文件被写坏（真实成因：json.dump 写到一半被杀）
BROKEN = '{"current_day": "2026-09-17", "day_sl_count": 2, "round_cou'
write_raw(trade_round.RUNTIME, BROKEN)
round_id_after_corrupt = trade_round.next_round_id()
bump_ret = trade_round.bump_runtime("R000008")
still_broken = read_text(trade_round.RUNTIME) == BROKEN
archives_before_archive = [os.path.basename(p) for p in archives()]

# ④ 收尾归档接手（这才是负责安全判据的那一步）
st = archive_round.update_runtime({
    "time_cst": "2026-09-17 10:00:00", "round_id": "R000008",
    "equity_usdt": 9700.0, "sl_triggered": 0, "trades": [], "positions": [],
})
arcs = archives()
print(json.dumps({
    "healthy_disk": healthy_disk,
    "atomic_write_calls": aw_calls,
    "atomic_write_target": os.path.basename(aw_calls[0]) if aw_calls else None,
    "round_id_after_corrupt": round_id_after_corrupt,
    "bump_ret": bump_ret,
    "still_broken": still_broken,
    "archives_before_archive": archives_before_archive,
    "archive_count": len(arcs),
    "archive_text": read_text(arcs[0]) if arcs else None,
    "broken_text": BROKEN,
    "archive_name": os.path.basename(arcs[0]) if arcs else None,
    "after_archive": {k: st.get(k) for k in ("day_sl_count", "circuit_breaker",
                                             "day_counters_compromised", "recovered_from")},
    "tmp_leftovers": sorted(os.path.basename(p) for p in glob.glob(os.path.join(tmp, "*.tmp"))),
}, ensure_ascii=False))
`;

  it("坏文件下它一个字都不写：证据留给归档，轮次号不退回 1", (t) => {
    const out = runDriver(t, "driver_trade_round", driver);
    if (!out) return;

    // ① 对照组：健康文件下行为不变（否则「不写」可能只是「什么都不做」的副作用）
    const healthyDisk = out.healthy_disk as Record<string, unknown>;
    assert.equal(healthyDisk.round_no, 4, "健康文件下轮次号没写进去");
    assert.equal(healthyDisk.day_sl_count, 2, "健康文件下 bump_runtime 把本日止损计数弄丢了");
    assert.equal(healthyDisk.circuit_breaker, true, "健康文件下熔断读数被改坏了");
    assert.equal(healthyDisk.month_dd_pct, 4.5, "健康文件下月度回撤被弄丢了");
    assert.equal(healthyDisk.inception_equity, 10000, "健康文件下基准权益被弄丢了");
    assert.equal(healthyDisk.current_day, "2026-09-17", "健康文件下 current_day 被弄丢了");

    // ①′ 写回走的是 jsonstore 的原子写（换掉它就不写 —— 断言的是调用真的发生，不是源码里出现过某个名字）
    assert.equal(
      (out.atomic_write_calls as unknown[]).length,
      1,
      "bump_runtime 不再经由 jsonstore.atomic_write_json 写运行态（回落成裸 open(w) 会留下半截文件）"
    );
    assert.equal(out.atomic_write_target, "runtime.json", "原子写写到了别的地方");

    // ② 轮次号不许退回 1：它是 clOrdId 的组成部分（L1-8 唯一性），退回 1 就是与历史轮次重号
    assert.equal(
      out.round_id_after_corrupt,
      "R000008",
      `运行态读不出来时轮次号退回了 ${out.round_id_after_corrupt} —— 「不知道」被伪装成了「从头开始」（该由只追加的归档日志兜底）`
    );

    // ③ 读不出来就别写：一个字都不许落到磁盘上
    assert.equal(out.bump_ret, null, "读不出来的运行态被 bump_runtime 写回去了");
    assert.equal(out.still_broken, true, "坏文件被改动/覆盖了 —— 证据必须在归档接手前保持原样");
    assert.deepEqual(
      out.archives_before_archive,
      [],
      "bump_runtime 抢在归档之前留了档 —— 留档与「计数不可信」的判定是同一件事，只能有一个地方做"
    );

    // ④ 归档接手后，上一轮那套保护必须**照样生效**（这才是本组真正的对照物）
    assert.equal(out.archive_count, 1, "归档没有留档坏文件 —— 说明它看到的是一份「干净的」运行态（被上一个写者洗白了）");
    assert.equal(out.archive_text, out.broken_text, "留档不是逐字节原件");
    const after = out.after_archive as Record<string, unknown>;
    assert.equal(
      after.day_counters_compromised,
      true,
      "计数被重置却没有标记 —— 看板与邮件会一起说「今日未熔断」"
    );
    assert.equal(after.circuit_breaker, null, "计数不可信时熔断读数是 false 而不是 null（未知）");
    assert.equal(after.recovered_from, out.archive_name, "状态里没指向留档文件");
    assert.deepEqual(out.tmp_leftovers, [], "留下了临时文件");
  });
});
