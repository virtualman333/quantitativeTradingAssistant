/**
 * statewriters.test.ts —— 两个「读 → 改 → 写」的账本：幂等登记表与复盘账本
 *
 * 为什么需要这份测试
 * ------------------
 * `scripts/jsonstore.py` 的模块头写着 `state/` 下的 JSON **不是缓存，是安全判据的载体**，
 * 而它点名的两个文件（`month_state.json` / `runtime.json`）之外，还有两本账同样是
 * 「读 → 改 → 写」：
 *
 *   - `state/order_idem_<轮次>.json` —— 本轮哪几笔单已经发过（章程 §6.1 幂等，L1-8 clOrdId）
 *   - `state/reviewed_trades.json`    —— 哪几笔交易已经复盘过、哪条归因已提过案
 *
 * 这两处此前都是「就地 `open(..., "w") + json.dump` 写」+「`except: 当作空的` 读」。
 * 两个毛病**必须成对看**：写不原子会造出半截文件，而读方把半截文件当成「一张空表」，
 * 紧接着在空表上追加再写回去 —— 净效果是**一次写到一半就丢掉整本账**，且全过程不报错：
 *
 *   - 登记表清空 → `--seq 1` 又生成一个新 clOrdId（事后按 clOrdId 对账找不到那笔），
 *     或反过来把已发过的单当成没发过；
 *   - 复盘账本清空 → `--prepare` 把已复盘的交易重新列成「待复盘」（那句
 *     「未全部完成前，不得开新仓」于是永远成立）、`--commit` 的重复提交判据失效、
 *     `--stats` 打印「暂无复盘记录」而提案阈值永远不触发。
 *
 * 本文件锁三件事（**全部用真跑 CLI 的行为断言**，不是读源码猜）：
 *   A. 半截账本 → **拒绝本次写**、退出码非 0、**原文件一个字节都不许动**；
 *   B. 「文件不存在」（本机第一次跑）**必须照常工作** —— 否则守卫会把功能堵死；
 *      「文件完好」也必须照常追加（回归护栏）；
 *   C. 结构锁：`state/` 下 JSON 的写一律走 jsonstore，且文件清单从 glob 现算。
 *
 * 为什么要复制到临时树里跑：`order_id.py` / `review_trade.py` 的路径常量是**模块级**的
 * （`ROOT = dirname(dirname(__file__))`），直接跑会写到真仓库的 `state/`。
 * 复制一份到临时目录，`ROOT` 自然落在临时树上 —— 真跑真脚本，不碰真账本。
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

const COPIED = ["jsonstore.py", "order_id.py", "review_trade.py"];

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qta-statewriters-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  for (const f of COPIED) {
    fs.copyFileSync(path.join(ROOT, "scripts", f), path.join(dir, "scripts", f));
  }
  const stateFile = (name: string) => path.join(dir, "state", name);
  return {
    dir,
    stateFile,
    run(script: string, args: string[]) {
      return spawnSync(PYTHON, [path.join(dir, "scripts", script), ...args], {
        encoding: "utf8",
        cwd: dir,
      });
    },
    writeRaw(name: string, text: string) {
      // newline="" —— 免掉 Windows 的 \n → \r\n 转换，「逐字节不变」才比得准
      fs.writeFileSync(stateFile(name), text, { encoding: "utf8", flag: "w" });
    },
    bytes(name: string) {
      return fs.readFileSync(stateFile(name));
    },
    exists(name: string) {
      return fs.existsSync(stateFile(name));
    },
  };
}

/** 半截 JSON —— 这正是「写得不够原子」在现场留下的形状 */
const HALF = '{"clOrdId": "okxr16n1t12345", "round_id": "R0000';

const REVIEW_PAYLOAD = JSON.stringify({
  reviews: [
    {
      key: "2026-09-17 09:00:00|ETH-USDT-SWAP|平仓",
      round_id: "R000016",
      pnl_usdt: -12.5,
      cause: "timing",
      cause_detail: "追高进场",
      market_context: "区间上沿",
      counterfactual: "等回踩",
      lesson: "不在 15m 上影线处进场",
    },
  ],
});

/** 每个用例自带一份干净沙箱，避免用例间互相影响 */
const skipIfNoPython = (t: { skip: (m?: string) => void }) => {
  if (HAS_PYTHON) return false;
  t.skip(`本机没有可用的 ${PYTHON} —— 这条锁没生效，CI 上必须能跑`);
  return true;
};

describe("幂等登记表：读不出来就不许生成新 ID", () => {
  it("半截登记表 → 拒绝生成、退出码 3、原文件逐字节不变", (t) => {
    if (skipIfNoPython(t)) return;
    const s = sandbox();
    s.writeRaw("order_idem_R000016.json", HALF);
    const before = s.bytes("order_idem_R000016.json");

    const r = s.run("order_id.py", ["--round", "R000016", "--seq", "1"]);

    assert.equal(r.status, 3, `应拒绝（退出码 3），实际 ${r.status}：${r.stdout}`);
    assert.match(r.stdout, /读不出来/, "没说清是登记表读不出来");
    assert.match(r.stdout, /order_idem_R000016\.json/, "没给出出问题的文件路径");
    assert.ok(r.stdout.includes('"ok": false'), "还可以从 ok 字段看出失败");
    // 关键：原文件是唯一的对账线索，不许被默认值覆盖，也不许被搬走
    assert.deepEqual(
      s.bytes("order_idem_R000016.json"),
      before,
      "拒绝的同时动了原文件 —— 现场被覆盖了"
    );
    assert.equal(
      fs.readdirSync(path.join(s.dir, "state")).length,
      1,
      "state/ 下多出了别的文件（留档 / 临时文件都不该在这里出现）"
    );
  });

  it("半截登记表 → `--list` 不许报「本轮 0 条」", (t) => {
    if (skipIfNoPython(t)) return;
    const s = sandbox();
    s.writeRaw("order_idem_R000016.json", HALF);

    const r = s.run("order_id.py", ["--round", "R000016", "--list"]);

    assert.notEqual(r.status, 0, "对着一张读不出来的表列了个 0 条出来");
    assert.ok(
      !/"count":\s*0/.test(r.stdout),
      `把「不知道」说成了「本轮没有已登记的 ID」：${r.stdout}`
    );
    // 只断言「没出现 count:0」是不够的：把 ok 改成 true 一样能过（D3 注入实测过）。
    // 这条命令对外的契约是 ok 字段，所以它也得一起钉住。
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.ok, false, "--list 对着读不出来的表回了 ok:true");
    assert.ok(!("count" in payload), "还在报 count —— 那个数字此刻只能是「不知道」");
    assert.match(r.stdout, /读不出来/, "没说清原因");
  });

  it("正常路径不许被守卫堵死：没有文件 → 照常登记；有文件 → 照常追加", (t) => {
    if (skipIfNoPython(t)) return;
    const s = sandbox();

    // ① 本机第一次跑：state/ 里还没有这张表
    const a = s.run("order_id.py", ["--round", "R000016", "--seq", "1"]);
    assert.equal(a.status, 0, `首次登记失败：${a.stdout}${a.stderr}`);
    const first = JSON.parse(a.stdout).clOrdId as string;
    assert.ok(first.startsWith("okxr16n1"), `clOrdId 不含轮次与序号：${first}`);

    // ② 追加第二笔，第一笔必须还在（此前「读坏了当空的」也长这样，但那是碰巧）
    const b = s.run("order_id.py", ["--round", "R000016", "--seq", "2"]);
    assert.equal(b.status, 0, `第二笔登记失败：${b.stdout}${b.stderr}`);

    // ③ 同一 seq 重复登记仍要被拦住（幂等判据没被改坏）
    const dup = s.run("order_id.py", ["--round", "R000016", "--seq", "1"]);
    assert.equal(dup.status, 2, "同 seq 重复生成新 ID —— 幂等判据失效了");
    assert.match(dup.stdout, /已登记过/, "重复时没说清原因");

    const list = s.run("order_id.py", ["--round", "R000016", "--list"]);
    assert.equal(list.status, 0);
    assert.equal(JSON.parse(list.stdout).count, 2, "登记表没攒下两笔");

    // ④ 写必须是原子的：不许留下临时文件
    assert.deepEqual(
      fs.readdirSync(path.join(s.dir, "state")).filter((f) => f.endsWith(".tmp")),
      [],
      "原子写留下了临时文件"
    );
  });
});

describe("复盘账本：读不出来就不许写 EVOLUTION / PLAYBOOK", () => {
  it("半截账本 → `--stats` 不许说「暂无复盘记录」", (t) => {
    if (skipIfNoPython(t)) return;
    const s = sandbox();
    s.writeRaw("reviewed_trades.json", HALF);

    const r = s.run("review_trade.py", ["--stats"]);

    assert.notEqual(r.status, 0, "对着一本读不出来的账报了「暂无复盘记录」");
    assert.ok(
      !r.stdout.includes("暂无复盘记录"),
      `把「不知道」说成了「一笔都没复盘过」：${r.stdout}`
    );
    assert.match(r.stdout, /读不出来/, "没说清原因");
    assert.match(r.stdout, /reviewed_trades\.json/, "没给出出问题的文件路径");
  });

  it("半截账本 → `--commit` 拒绝，且不许写 EVOLUTION.md", (t) => {
    if (skipIfNoPython(t)) return;
    const s = sandbox();
    s.writeRaw("reviewed_trades.json", HALF);
    fs.writeFileSync(path.join(s.dir, "in.json"), REVIEW_PAYLOAD, "utf8");
    const before = s.bytes("reviewed_trades.json");

    const r = s.run("review_trade.py", ["--commit", "--input", "in.json"]);

    assert.equal(r.status, 3, `应拒绝提交（退出码 3），实际 ${r.status}：${r.stdout}`);
    assert.deepEqual(s.bytes("reviewed_trades.json"), before, "拒绝的同时动了账本");
    assert.equal(
      fs.existsSync(path.join(s.dir, "EVOLUTION.md")),
      false,
      "账本读不出来却已经往 EVOLUTION.md 写了 —— 复盘记录会重复"
    );
  });

  it("正常路径不许被守卫堵死：没有文件 → 能提交并落盘；账本 → 能读回", (t) => {
    if (skipIfNoPython(t)) return;
    const s = sandbox();
    fs.writeFileSync(path.join(s.dir, "in.json"), REVIEW_PAYLOAD, "utf8");

    const r = s.run("review_trade.py", ["--commit", "--input", "in.json"]);
    assert.equal(r.status, 0, `首次提交失败：${r.stdout}${r.stderr}`);
    assert.ok(s.exists("reviewed_trades.json"), "账本没有落盘");

    const stats = s.run("review_trade.py", ["--stats"]);
    assert.equal(stats.status, 0, `提交后读不回来：${stats.stdout}`);
    assert.match(stats.stdout, /累计复盘 1 笔/, `账本里的条目数不对：${stats.stdout}`);

    // 同一笔重复提交要被拦住（重复提交判据没被改坏）
    fs.writeFileSync(path.join(s.dir, "in2.json"), REVIEW_PAYLOAD, "utf8");
    const dup = s.run("review_trade.py", ["--commit", "--input", "in2.json"]);
    assert.notEqual(dup.status, 0, "同一笔交易被重复写进了 EVOLUTION.md");
    assert.match(dup.stdout, /重复提交/, "重复提交时没说清原因");
  });
});

describe("结构锁：state/ 下 JSON 的写一律走 jsonstore（清单从 glob 现算）", () => {
  /** Python 行注释是 `#`（_src.ts 的 stripComments 只认 C 风格），先按行剔掉再判。 */
  const codeOnly = (src: string) =>
    src
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");

  const bareDumpCount = (src: string) => (codeOnly(src).match(/json\.dump\(/g) ?? []).length;

  /**
   * 允许出现裸 `json.dump(` 的文件。判据是「这处写**没有对应的读回**」：
   * 要么每次全量重算（写一份给 AI / 给人看的结果），要么只新建不覆盖（文件名带时间戳）。
   * 这两类坏了只丢一份输出，不会让下一次读拿到一个假数字 —— 与 order_id / review_trade
   * 那种「读了再改再写」根本不同。
   *
   * `count` 是**棘轮**：新加一处裸写要显式来改数字，改小了也要显式来改
   * （与 vui 的主题棘轮同一手法：只减不增，且必须动一次手）。
   */
  const JSON_WRITE_EXEMPT: Record<string, { count: number; why: string }> = {
    "scripts/trade_round.py": {
      count: 2,
      why: "写 state/round_input*.json：每轮由上一轮输入全新重算，无读回；轮次文件一写即交给 archive_round 归档",
    },
    "scripts/news_fetch.py": {
      count: 3,
      why: "写 state/news_gate.json 与 news_input.json：每次全量重算的产物，无读回",
    },
    "scripts/news_verify.py": {
      count: 1,
      why: "写 --out（默认 state/news_verify.json）：每次对同一批文本重算的产物，无读回",
    },
    "scripts/market_scan.py": {
      count: 1,
      why: "写行情快照 market_<时间戳>.json：文件名带时间戳、只新建不覆盖，无读回",
    },
    "scripts/mail_report.py": {
      count: 1,
      why: "写 --out 指定的邮件负载（默认 logs/），调用方给路径，无读回",
    },
  };

  /**
   * 不参与扫描的文件：`jsonstore.py` **就是底座本身**，它的 `json.dump` 正是那个被允许的
   * 唯一实现（写在临时文件+fsync+`os.replace` 里）。这不是覆盖率清单，
   * 是「豁免表不该包含底座自己」的定义性排除。
   */
  const SCAN_EXCLUDE = new Set(["scripts/jsonstore.py"]);

  it("凡出现裸 json.dump 的脚本都在豁免表里，且条数与棘轮一致（漏登记 / 多登记都要报错）", () => {
    const offenders: string[] = [];
    for (const f of walk("scripts", ".py")) {
      if (SCAN_EXCLUDE.has(f)) continue;
      const n = bareDumpCount(read(f));
      const exempt = JSON_WRITE_EXEMPT[f];
      if (n > 0 && !exempt) {
        offenders.push(`${f}（${n} 处裸 json.dump）`);
      } else if (exempt && n !== exempt.count) {
        offenders.push(
          `${f} 的棘轮是 ${exempt.count}，实际 ${n} —— ${
            n > exempt.count ? "又加了一处裸写" : "少了一处，请把数字收紧"
          }`
        );
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "state/ 下 JSON 的写必须走 jsonstore.atomic_write_json（就地 json.dump 正是半截文件的成因）"
    );
  });

  it("豁免表里没有已不存在的文件（清单腐烂要报错）", () => {
    const present = walk("scripts", ".py");
    for (const f of Object.keys(JSON_WRITE_EXEMPT)) {
      assert.ok(present.includes(f), `豁免表里的 ${f} 已经不在仓库里了`);
    }
  });

  it("两本「读改写」的账：读取经 jsonstore 的严格入口，写经原子写", () => {
    /** 取一个 Python 函数体的文本（从 `def name(` 到下一个顶层 `def` / 文件尾）。 */
    const funcBody = (src: string, name: string) => {
      const i = src.indexOf(`def ${name}(`);
      assert.ok(i >= 0, `找不到函数 ${name}`);
      const rest = src.slice(i + 1);
      const j = rest.indexOf("\ndef ");
      return j >= 0 ? rest.slice(0, j) : rest;
    };

    for (const f of ["scripts/order_id.py", "scripts/review_trade.py"]) {
      const src = codeOnly(read(f));
      assert.equal(bareDumpCount(read(f)), 0, `${f} 又有裸 json.dump 了`);
      assert.ok(src.includes("jsonstore.atomic_write_json("), `${f} 的写没走原子写`);
      assert.ok(
        src.includes("jsonstore.read_json_state_strict("),
        `${f} 的读没走严格入口 —— 「读不出来就当空的」这条路又能走了`
      );
    }
    // 读入口本身不许自己 open+json.load（那条路分不出「首次运行」与「数据丢了」）。
    // 只查这两个函数体：它们之外还有读**人类填好的输入文件**的地方（`--commit --input`、
    // `--params`），那不是状态文件，按状态文件的规矩判会误伤。
    for (const [f, fn] of [
      ["scripts/order_id.py", "load_rows"],
      ["scripts/review_trade.py", "load_reviewed"],
    ] as const) {
      const body = funcBody(codeOnly(read(f)), fn);
      assert.ok(
        !body.includes("json.load("),
        `${f} 的 ${fn}() 又自己 open+json.load 读状态了`
      );
      assert.ok(
        body.includes("read_json_state_strict("),
        `${f} 的 ${fn}() 没有走严格入口`
      );
    }
  });

  it("jsonstore 的严格入口是唯一的读实现，不是第二份（不许拿 (data, err) 再包一层）", () => {
    const store = codeOnly(read("scripts/jsonstore.py"));
    assert.ok(store.includes("def read_json_state_strict("), "严格入口不见了");
    assert.ok(
      /read_json_state\(path,\s*expect=expect\)/.test(store),
      "严格入口没有复用 read_json_state —— 一份判据变两份必然漂移"
    );
    assert.ok(store.includes("class StateUnreadable("), "StateUnreadable 不见了");
  });
});
