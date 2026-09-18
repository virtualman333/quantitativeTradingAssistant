/**
 * stateshapes.test.ts —— `state/` 下每本账的**顶层形状**：只声明一次，且必须有人登记
 *
 * 为什么需要这份测试
 * ------------------
 * `read_json_state()` 拿顶层类型当白名单。早先这件事靠调用方各传一份 `expect=`：
 * `state/order_idem_<轮次>.json` 顶层是列表，所以那一处传了 `expect=list`，其余走默认
 * `dict`。问题是**形状是文件自己的属性、不是调用方的属性**，而漏传的后果不是报错：
 *
 *   `read_json_state` 返回 `(None, "顶层不是对象…")` → `month_risk` / `archive_round`
 *   那条路会顺手把它 `quarantine_broken()` 搬成 `.corrupt-*` → 一份**完好的**账被当成
 *   「数据没了」，峰值 / 幂等登记表随之静默重置。整条路上没有一个字提到「其实是形状判错了」。
 *
 * 相关 docstring 一直写着「判据要与文件的实际形状一致，而不是与绝大多数文件一致」——
 * 但没有任何东西扛着这句话，也没人提醒下一个调用方该传什么。本文件是那句话的落点：
 *
 *   A. 行为：形状对了就读得出来，**调用方不参与**；形状不符要报出来（不是静默给默认值）；
 *   B. 未知路径**不猜** —— 抛 `UnregisteredState`（猜成 dict 就是上面那条静默损坏）；
 *   C. 形状只在 `STATE_SHAPES` 里一处 —— 调用方再传 `expect=` 当场抛 `ValueError`；
 *   D. 对账：源码里 `state/` 下的每个 `.json` 名字，要么在注册表里，要么在**声明式例外表**
 *      里写明理由；反向也要 —— 注册表里每一项都得真被源码用到（表会腐烂）。
 *
 * 运行：pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROOT, read, walk } from "./_src.ts";

const PYTHON = process.env.PYTHON || "python";
const HAS_PYTHON = spawnSync(PYTHON, ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

const skipIfNoPython = (t: { skip: (m?: string) => void }) => {
  if (HAS_PYTHON) return false;
  t.skip(`本机没有可用的 ${PYTHON} —— 这条锁没生效，CI 上必须能跑`);
  return true;
};

/**
 * 在临时目录里真跑 `jsonstore` 的读入口。
 * `jsonstore` 没有模块级路径常量（不像 order_id / review_trade），所以可以直接 import，
 * 不必复制整棵树。
 */
function probe(files: Record<string, string>, body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qta-shapes-"));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text, "utf8");
  }
  const script = path.join(dir, "_probe.py");
  const scriptsDir = path.join(ROOT, "scripts").replace(/\\/g, "/");
  fs.writeFileSync(
    script,
    [
      "import json, os, sys",
      `sys.path.insert(0, "${scriptsDir}")`,
      "import jsonstore",
      `D = r"${dir}"`,
      body,
    ].join("\n"),
    "utf8"
  );
  const r = spawnSync(PYTHON, [script], { encoding: "utf8", cwd: dir });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

/** 把探针的 stdout 解成对象（探针一律只 print 一行 JSON） */
const probeJson = (r: { status: number | null; stdout: string; stderr: string }) => {
  assert.equal(r.status, 0, `探针自身失败：${r.stderr}`);
  return JSON.parse(r.stdout.split("\n").pop() as string);
};

// ── A. 形状对了就读得出来；形状不符要报出来 ─────────────────────────────

describe("顶层形状由文件自己决定，不由调用方传", () => {
  it("列表形状的幂等登记表：不传任何形状也读得出来（旧实现靠调用点记得传 list）", (t) => {
    if (skipIfNoPython(t)) return;
    const r = probe(
      { "order_idem_R000016.json": '[{"clOrdId": "okxr16n1t12345"}]' },
      [
        'data, err = jsonstore.read_json_state(os.path.join(D, "order_idem_R000016.json"))',
        'print(json.dumps({"type": type(data).__name__, "err": err, "n": len(data)}))',
      ].join("\n")
    );
    const out = probeJson(r);
    assert.equal(out.err, null, `一份完好的登记表被读成问题：${out.err}`);
    assert.equal(out.type, "list");
    assert.equal(out.n, 1, "条目数不对 —— 形状判对但内容没读出来");
  });

  it("对象形状的账同样不必传（默认形状不再是「猜」，而是查表）", (t) => {
    if (skipIfNoPython(t)) return;
    const r = probe(
      { "month_state.json": '{"month_peak_equity": 12345.6}' },
      [
        'data, err = jsonstore.read_json_state(os.path.join(D, "month_state.json"))',
        'print(json.dumps({"type": type(data).__name__, "err": err}))',
      ].join("\n")
    );
    const out = probeJson(r);
    assert.equal(out.err, null);
    assert.equal(out.type, "dict");
  });

  it("顶层形状不符 → 报出来（不是静默返回默认值），且原因里点名是哪种形状", (t) => {
    if (skipIfNoPython(t)) return;
    const r = probe(
      { "order_idem_R000016.json": '{"clOrdId": "x"}' },
      [
        'data, err = jsonstore.read_json_state(os.path.join(D, "order_idem_R000016.json"))',
        'print(json.dumps({"data": data, "err": err}))',
      ].join("\n")
    );
    const out = probeJson(r);
    assert.equal(out.data, null, "形状不符却拿到了数据");
    assert.match(String(out.err), /顶层不是列表/, `没说清是形状问题：${out.err}`);
  });
});

// ── B. 未知路径不猜 ─────────────────────────────────────────────────────

describe("没登记的账不猜形状", () => {
  it("state/ 下冒出一本新账 → 抛 UnregisteredState 并点名文件，而不是按 dict 判", (t) => {
    if (skipIfNoPython(t)) return;
    const r = probe(
      { "positions.json": '[{"instId": "ETH-USDT-SWAP"}]' },
      [
        "try:",
        '    jsonstore.read_json_state(os.path.join(D, "positions.json"))',
        '    print(json.dumps({"raised": None}))',
        "except Exception as e:",
        '    print(json.dumps({"raised": type(e).__name__, "msg": str(e)}))',
      ].join("\n")
    );
    const out = probeJson(r);
    assert.equal(out.raised, "UnregisteredState", `未登记的账被静默按默认形状判了：${r.stdout}`);
    assert.match(String(out.msg), /positions\.json/, "报错没点名是哪个文件");
    assert.match(String(out.msg), /STATE_SHAPES/, "没说清该去哪里登记");
  });

  it("expected_shape() 是查表本身，且认通配（轮次文件名带轮次号）", (t) => {
    if (skipIfNoPython(t)) return;
    const r = probe(
      {},
      [
        "shapes = {}",
        'for n in ["month_state.json", "runtime.json", "reviewed_trades.json", "order_idem_R000004.json"]:',
        "    shapes[n] = jsonstore.expected_shape(n).__name__",
        'print(json.dumps({"shapes": shapes, "n": len(jsonstore.STATE_SHAPES)}))',
      ].join("\n")
    );
    const out = probeJson(r);
    assert.equal(out.shapes["order_idem_R000004.json"], "list", "通配没生效");
    assert.equal(out.shapes["month_state.json"], "dict");
    assert.ok(out.n >= 4, `注册表只剩 ${out.n} 条 —— 形状来源被削平了`);
  });
});

// ── C. 形状只有一处：调用方不许再传 ─────────────────────────────────────

describe("形状只有一处判据", () => {
  it("调用方再传 expect= → 当场 ValueError（与注册表一致也不行）", (t) => {
    if (skipIfNoPython(t)) return;
    const r = probe(
      { "month_state.json": '{"a": 1}' },
      [
        "res = {}",
        "for name, exp in [('month_state.json', dict), ('month_state.json', list), ('order_idem_R000016.json', list)]:",
        "    try:",
        '        jsonstore.read_json_state(os.path.join(D, name), expect=exp)',
        '        res[name + ":" + exp.__name__] = "no-error"',
        "    except Exception as e:",
        '        res[name + ":" + exp.__name__] = type(e).__name__',
        "print(json.dumps(res))",
      ].join("\n")
    );
    const out = probeJson(r);
    for (const k of Object.keys(out)) {
      assert.equal(out[k], "ValueError", `${k} 传了 expect 却没报错`);
    }
  });

  it("结构锁：scripts/ 下没有任何调用点自己传 expect=（jsonstore 内部的转发除外）", () => {
    const offenders: string[] = [];
    for (const f of walk("scripts", ".py")) {
      if (f === "scripts/jsonstore.py") continue; // 严格入口转发给 read_json_state，是内部实现
      // Python 行注释里提到 `expect=` 不算（本文档就在解释这件事）
      const code = read(f)
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");
      if (/read_json_state(?:_strict)?\([^)]*expect\s*=/.test(code)) offenders.push(f);
    }
    assert.deepEqual(
      offenders,
      [],
      "顶层形状只能在 jsonstore.STATE_SHAPES 里声明一次 —— 调用点又传了 expect="
    );
  });
});

// ── D. 对账：源码里读过的每本账都必须有交代（双向） ─────────────────────

describe("源码里 state/ 下的 .json 与注册表双向对账", () => {
  /**
   * 宽扫面：**行里提到 `state` 的 `.json` 字面量**。
   *
   * 为什么按「行」扫而不是按 AST：这些路径有三种写法（`os.path.join(STATE, "x.json")`、
   * `os.path.join(ROOT, "state", "x.json")`、`--out` 的 `default="state/x.json"`，
   * 还有 `f"round_input_{round_id}.json"`），按调用形态逐个枚举就是本仓反复踩的
   * 「判据按已知形态枚举」（新形态不会有东西提醒）。行扫描一视同仁，代价是略宽 ——
   * 宽的那部分正是靠下面的**声明式例外表**收口。
   *
   * 扫两面：`scripts/**.py` 与 `src/**.ts`。README 那句「`state/` 下的 JSON 读写一律走
   * `scripts/jsonstore.py`」原先只被 Python 那一面扛着，而 `src/alert.ts` 直接读写
   * `state/mail_sent.json` / `state/mail_alert.json`、`src/runstate.ts` 与 `src/tools/project.ts`
   * 直接读 `state/runtime.json` —— **一个都不在对账面里**。把面扩到 `src/` 当场就红，
   * 这才是「那句话的落点」。（TS 侧不该走 Python 的 `jsonstore`：跨进程读一个小 JSON 不值得，
   * 但**名字必须有人交代**，形状/去向要写清楚。）
   */
  const isCommentLine = (line: string) => {
    const s = line.trim();
    return s.startsWith("#") || s.startsWith("//") || s.startsWith("/*") || s.startsWith("*");
  };

  const jsonLiteralsOnStateLines = () => {
    const found = new Map<string, string[]>();
    for (const f of [...walk("scripts", ".py"), ...walk("src", ".ts")]) {
      const lines = read(f).split(/\r?\n/);
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return; // 注释里的路径不是代码
        if (!/state/i.test(line)) return;
        for (const m of line.matchAll(/["']([^"']*\.json)["']/g)) {
          // 归一成 basename：同一本账有两种写法（`os.path.join(STATE, "x.json")` 与
          // `default="state/x.json"`），不归一就会把同一本账数成两个名字。
          const name = m[1].split(/[\\/]/).pop() as string;
          const list = found.get(name) ?? [];
          list.push(`${f}:${i + 1}`);
          found.set(name, list);
        }
      });
    }
    return found;
  };

  /**
   * 例外表：**不是判据载体**的 state 产物。判据与 `statewriters.test.ts` 的
   * `JSON_WRITE_EXEMPT` 一致 —— 这类文件要么每次全量重算、要么是外部注入的输入，
   * 读坏了只丢一份输出，**不会让下一次读拿到一个假数字**。
   * 「登记了却用不到」也会被下面的反向对账报出来（表会腐烂）。
   */
  const NOT_JUDGEMENT: Record<string, string> = {
    "account_snapshot.json":
      "外部注入的账户快照（用户 / Agent 手写，不是本仓维护的账）；看板读不到时明说「未提供」",
    "review_template.json": "复盘模板，给人 / AI 填的输入，每次重算",
    "round_input.json": "当轮输入，由上一轮全量重算，无读回",
    "round_input_{round_id}.json": "轮次输入，一写即交给 archive_round 归档，无读回",
    "news_gate.json": "抓取闸门，每次全量重算的产物，无读回",
    "news_input.json": "候选消息，每次全量重算的产物，无读回",
    "news_verify.json": "验证结果，对同一批文本重算的产物，无读回",
    // ── 以下两项由 TS 侧（`src/alert.ts`）读写，方向与上面那些正好相反：
    //    坏了只会**多发一封告警邮件**（fail-open），不会让某条判据拿到一个假数字，
    //    所以不进 `STATE_SHAPES`（那张表管的是「读出来的形状」，Python 从不读这两个文件）。
    "mail_sent.json":
      "告警邮件去重窗口（subject → 上次发送时刻，24h 后自然过期），由 src/alert.ts 读写；" +
      "读坏了只是去重失效、多收一封告警邮件，方向是 fail-open",
    "mail_alert.json": "告警邮件的一次性投递载荷（写完即交给 mail_send.py），无读回",
  };

  it("每个 state 下的 .json 要么在注册表里、要么在例外表里写明理由", () => {
    const scanned = jsonLiteralsOnStateLines();
    // 解析面不许为空 —— 否则「两边都空」会让后面的对账恒真
    assert.ok(
      scanned.size >= 8,
      `只扫到 ${scanned.size} 个 state 下的 .json（${[...scanned.keys()].join(", ")}）—— 扫描面塌了，对账等于没做`
    );
    // 两面都要有 —— 只扫 Python 时这条会红，而「只扫一半」正是这次扩面的原因。
    assert.ok(
      [...scanned.values()].flat().some((w) => w.startsWith("src/")),
      "扫描面里一个 src/ 的文件都没有 —— TS 侧又掉出对账面了"
    );
    assert.ok(
      [...scanned.values()].flat().some((w) => w.startsWith("scripts/")),
      "扫描面里一个 scripts/ 的文件都没有 —— Python 侧掉出对账面了"
    );

    const shapes = read("scripts/jsonstore.py");
    const registryPatterns = [...shapes.matchAll(/^\s*\("([^"]+)",\s*(?:dict|list)\),\s*$/gm)].map(
      (m) => m[1]
    );
    assert.ok(registryPatterns.length >= 4, "注册表没解析出条目（解析面不许为空）");

    const matched = (name: string) => registryPatterns.some((p) => globMatch(name, p));

    const unexplained: string[] = [];
    for (const [name, where] of scanned) {
      if (matched(name) || name in NOT_JUDGEMENT) continue;
      unexplained.push(`${name}（出现在 ${where.slice(0, 3).join("、")}）`);
    }
    assert.deepEqual(
      unexplained,
      [],
      "state/ 下出现了没人交代的账 —— 要么在 jsonstore.STATE_SHAPES 登记顶层形状，" +
        "要么在 NOT_JUDGEMENT 里写明它不是判据载体"
    );
  });

  it("反向：注册表与例外表里都不许有源码已不再用的条目（表会腐烂）", () => {
    const scanned = jsonLiteralsOnStateLines();
    const shapes = read("scripts/jsonstore.py");
    const registryPatterns = [...shapes.matchAll(/^\s*\("([^"]+)",\s*(?:dict|list)\),\s*$/gm)].map(
      (m) => m[1]
    );

    const deadRegistry = registryPatterns.filter(
      (p) => ![...scanned.keys()].some((n) => globMatch(n, p))
    );
    assert.deepEqual(deadRegistry, [], "注册表里有源码已经不用的形状条目");

    const deadExempt = Object.keys(NOT_JUDGEMENT).filter((n) => !scanned.has(n));
    assert.deepEqual(deadExempt, [], "例外表里有已经不在源码里的文件名（请收紧这张表）");
  });
});

/** 只支持 `*` 的单段通配（注册表就用到这一种），刻意不引任何依赖 */
function globMatch(name: string, pattern: string): boolean {
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$"
  );
  return re.test(name);
}
