/**
 * toolsguard.test.ts —— 通用写工具（`write_file`）的工具层边界
 *
 * 为什么需要这份测试
 * ------------------
 * README 写着「`state/month_state.json` 是 **L1-6 的分母**（`month_peak_equity` 只增不减，
 * **抬高一次不可逆**）：**只有 `scripts/archive_round.py` 会写它**」。
 *
 * 这句话在**代码路径**上成立 —— 扛它的是 `tests/monthguard.test.ts` 里那几条源码断言
 * （「全仓唯一调用 `update_month_state()` 的地方」「展示路径不得写月度状态」）。
 * 但它们看的是**仓库源码**，看不见另一条路：**模型手里的通用写工具**。
 *
 * `src/tools/paths.ts` 的 `DENY_DIRS` 原本是
 * `[".git","node_modules",".venv","__pycache__","release","dist"]` ——
 * **没有 `state/`、也没有 `ledger/`**。于是 `write_file` 可以把
 * `state/month_state.json` 覆盖成任意内容：抬高 `month_peak_equity` = 回撤虚高 → 误熔断，
 * 清零 = 回撤虚低 → **该熔断不熔断**（两条都不可逆，且都不报错）；
 * 同理 `ledger/trades.csv`（交易流水）与 `state/order_idem_<轮次>.json`（章程 §6.1 幂等登记）。
 * 唯一的拦阻是「危险工具要用户点一次确认」，而对话框里给出的正是这条路径与内容预览 ——
 * **一条靠人肉确认扛着的风控边界不是边界**。
 *
 * ⚠ 本文件的用例会**真的尝试写 `state/` 与 `ledger/` 下的真实文件** ——
 * 因为「被拒绝了」与「拒绝了但顺手把原文件动了」是两件事，后者才是本仓反复踩的坑
 * （见 `tests/statewriters.test.ts`）。所有写入尝试都走 `expectAllRefused()`，
 * 它进门前逐字节备份、`finally` 里无条件还原（并删掉守卫坏掉时新建的探针文件）。
 *
 * 第一版没做这件事，代价当场就付了：某个用例先把 `state/month_state.json` 写成 `{}`，
 * 后面那个「自我还原」的用例备份到的已经是脏内容，于是「还原」把脏内容当成了原样。
 * **保护逻辑必须是共用的，不能靠每个用例各自记得。**
 *
 * 本文件锁四件事（真调工具函数，不看源码形状）：
 *   A. 写禁区（`DENY_WRITE_DIRS`）的写入被**拒绝**（覆盖与 append 都算），错误里给出该走哪个入口；
 *   B. 拒绝之后**磁盘逐字节没变**、也没有凭空多出文件；
 *   C. 其它路径照常可写（覆盖 + 追加）—— **守卫不许把功能堵死**；
 *   D. 判据本身：`forWrite` 与只读的分野、大小写变体、`..` 穿行、仓库外、以及「别误伤子串同名的路径」。
 *
 * 禁区**有哪些目录**不在这里判 —— 那由 `tests/pathguard.test.ts` 现算核对
 * （磁盘上有状态文件的目录 ∪ 源码引用过的目录）。本文件只判「禁区拦不拦得住」，
 * 覆盖面对不对是另一条锁的事。两份分工写在两个文件头里，别互相抄。
 *
 * 运行：pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./_src.ts";
import { resolveSafe, PROJECT_ROOT, relOf, DENY_WRITE_DIRS } from "../src/tools/paths.ts";
import { writeFileTool } from "../src/tools/fs.ts";

/** 允许写入的确认通道：把「用户点了确认」这一步固定为真，剩下的全靠路径守卫 */
const OK_CONFIRM = { confirm: async () => true };
const HACK = '{"hacked":true}';

/** 真实存在的判据 / 账本文件（`missing` 的先跳过，新 clone 上可能没有） */
const REAL_TARGETS = [
  "state/month_state.json",
  "state/runtime.json",
  "ledger/trades.csv",
];

/**
 * 探针路径：**全部不存在**。守卫正常时它们一个都不会被创建；
 * 守卫坏掉时它们会被建出来 —— `expectAllRefused()` 的 `finally` 负责清掉。
 *
 * ⚠ `logs/`、`data/`、`news/` 这三组是**本轮补的**：写禁区原先只有手抄的
 * `["state","ledger"]`，而这三处同样是「只追加、不可改写」的账本
 * （`logs/rounds.jsonl` 章程 L1-7、`data/scalper_*.jsonl` 战绩与监测记录、
 * `news/news.jsonl` 审计流水），当时 `write_file` 能直接覆盖它们。
 * 它们的**真实文件**只用 `resolveSafe()` 做纯判据（见 tests/pathguard.test.ts），
 * 不在这里真去写 —— 拿用户的真实账本做写测试，进程被杀就还原不回去。
 */
const PROBE_TARGETS = [
  "state/toolsguard_probe.json",
  "state/sub/dir/toolsguard_probe.json",
  "state/whatever_new.json",
  "ledger/toolsguard_probe.csv",
  "logs/toolsguard_probe.jsonl",
  "data/toolsguard_probe.jsonl",
  "news/toolsguard_probe.jsonl",
  "State/TOOLSGUARD_PROBE.JSON",
  "STATE/toolsguard_probe2.json",
  "Ledger/toolsguard_probe2.csv",
  "Data/toolsguard_probe2.jsonl",
  "scripts/../state/toolsguard_probe3.json",
  "state/../state/toolsguard_probe4.json",
];

const abs = (rel: string) => path.join(ROOT, rel.replace(/\//g, path.sep));

/**
 * 在 `paths` 上尝试写入（期望**全部被拒**），并保证真实文件不被损坏。
 *
 * - 进门前：逐字节备份每个目标（不存在则记为 null），并记下当时存在的父目录；
 * - 无论断言成功与否：`finally` 里还原内容、删掉「本来不存在、现在出现了」的文件，
 *   再删掉这次新建出来的空目录；
 * - 还原**之前**先断言「本来存在的文件没被动过」—— 这条断言正是
 *   「拒绝 ≠ 顺手改了原文件」的锁，也只有真去写才会红。
 */
async function expectAllRefused(
  paths: string[],
  opts: { msg?: RegExp; label?: string; append?: boolean } = {}
): Promise<void> {
  assert.ok(paths.length > 0, "路径清单是空的 —— 这条锁什么都没验");
  const targets = [...new Set(paths.map((p) => p.replace(/\\/g, "/")))];
  const backups = targets.map((rel) => ({
    rel,
    file: abs(rel),
    before: fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel)) : null,
  }));
  const preDirs = new Set(
    targets.map((rel) => path.dirname(abs(rel))).filter((d) => fs.existsSync(d))
  );

  try {
    for (const rel of targets) {
      await assert.rejects(
        () => writeFileTool.run({ path: rel, content: HACK, append: !!opts.append }, OK_CONFIRM),
        (e: Error) => {
          const m = String(e.message);
          // 「哪个目录」按写禁区的**现算清单**核对，不抄一份字面量 ——
          // 抄一份的话，新加一个禁区目录时这条断言会跟着一起漂。
          assert.match(
            m,
            new RegExp(DENY_WRITE_DIRS.join("|"), "i"),
            `${rel}：被拒了但没说清是哪个目录（${m}）`
          );
          if (opts.msg) {
            assert.match(
              m,
              opts.msg,
              `${rel}：错误里没给出「该走哪个入口」—— 只说「不行」的话模型会反复重试（${m}）`
            );
          }
          return true;
        },
        `${opts.label ?? ""}${rel} 没有被拒绝：模型可以直接覆盖风控判据`
      );
    }

    for (const b of backups) {
      if (b.before === null) {
        assert.equal(fs.existsSync(b.file), false, `${b.rel} 被凭空创建了`);
      } else {
        assert.deepEqual(
          fs.readFileSync(b.file),
          b.before,
          `${b.rel} 在「被拒绝」的同时被动了 —— 风控判据 / 账本被覆盖`
        );
      }
    }
  } finally {
    for (const b of backups) {
      try {
        if (b.before === null) {
          if (fs.existsSync(b.file)) fs.rmSync(b.file, { force: true });
        } else if (!fs.readFileSync(b.file).equals(b.before)) {
          // 注意：状态文件在 Windows 上是 CRLF（jsonstore 用文本模式写），
          // 所以只能原字节写回，不能拿字符串重新拼一份。
          fs.writeFileSync(b.file, b.before);
        }
      } catch {
        /* 还原失败不掩盖原始断言错误 */
      }
    }
    // 删掉这次新建出来的空目录（守卫坏掉时 `state/sub/dir/` 这种会被建出来）
    for (const b of backups) {
      let d = path.dirname(b.file);
      while (d.startsWith(ROOT) && d !== ROOT) {
        if (preDirs.has(d)) break;
        try {
          if (fs.readdirSync(d).length > 0) break;
          fs.rmdirSync(d);
        } catch {
          break;
        }
        d = path.dirname(d);
      }
    }
  }
}

describe("A/B. 写禁区不接受通用写工具改写，且拒绝时磁盘零副作用", () => {
  it("探针路径（全部不存在）：覆盖写被拒，错误里点出该走的写入口", async () => {
    // 「点了入口」的判据用 `请走` 这个共性词，不写死 `jsonstore|archive_round` ——
    // 禁区扩到 `logs/data/news` 之后，各自的入口名并不相同（这正是我们想要的：
    // 每个目录都有自己的写入口）。逐个目录的入口文案由 tests/pathguard.test.ts 兜住。
    await expectAllRefused(PROBE_TARGETS, { msg: /请走/, label: "[探针] " });
  });

  it("真实判据文件（存在）：被拒，且逐字节没被动过", async () => {
    const present = REAL_TARGETS.filter((p) => fs.existsSync(abs(p)));
    assert.ok(present.length > 0, "三个真实目标一个都不在，用例前提不成立");
    await expectAllRefused(present, { label: "[真实] " });
  });

  it("append 同样被拒（追加到账本也是改写账本）", async () => {
    // 走同一个保护通道：如果哪次改动放松了守卫，这里也要能安全地红（而不是把真账本追加坏）
    const present = [...PROBE_TARGETS, ...REAL_TARGETS.filter((p) => fs.existsSync(abs(p)))];
    await expectAllRefused(present, { append: true, label: "[append] " });
  });

  it("只读侧不受影响：state/ 下的文件仍然读得了（LLM 要看本轮运行态）", () => {
    // 读走的是不带 forWrite 的同一套解析 —— 边界是「不许改写」，不是「不许看」
    assert.equal(
      relOf(resolveSafe("state/month_state.json")),
      "state/month_state.json",
      "读也被挡住了 —— 守卫越界了，模型看不到本轮运行态"
    );
  });
});

describe("C. 守卫不许把功能堵死：其它路径照常可写", () => {
  /** 运行时产物目录（已 gitignore），用例自己清理 */
  const probeRel = "reports/.toolsguard-probe.txt";
  const probeAbs = abs(probeRel);

  it("覆盖写与追加写都照常工作，内容能读回", async () => {
    const hadDir = fs.existsSync(path.dirname(probeAbs));
    try {
      const w = await writeFileTool.run({ path: probeRel, content: "hello-guard" }, OK_CONFIRM);
      assert.equal(w.ok, true, `正常写入被挡住了：${w.error}`);
      assert.equal(fs.readFileSync(probeAbs, "utf8"), "hello-guard");

      const a = await writeFileTool.run({ path: probeRel, content: "!", append: true }, OK_CONFIRM);
      assert.equal(a.ok, true, `追加写被挡住了：${a.error}`);
      assert.equal(fs.readFileSync(probeAbs, "utf8"), "hello-guard!");

      // 源码目录也照常（模型改代码是这个工具的本职）
      assert.equal(relOf(resolveSafe("src/tools/paths.ts", { forWrite: true })), "src/tools/paths.ts");
    } finally {
      fs.rmSync(probeAbs, { force: true });
      try {
        if (!hadDir && fs.existsSync(path.dirname(probeAbs))) fs.rmdirSync(path.dirname(probeAbs));
      } catch {
        /* 目录非空或不存在：不动 */
      }
    }
  });
});

describe("D. 判据细节：forWrite 的分野、大小写与越界", () => {
  it("同一路径：读放行、写拒绝（分野是刻意的）", () => {
    assert.ok(resolveSafe("state/runtime.json").startsWith(PROJECT_ROOT));
    assert.throws(() => resolveSafe("state/runtime.json", { forWrite: true }), /state/);
  });

  it("大小写变体挡得住（Windows 上 State/ 与 state/ 是同一个目录）", () => {
    assert.throws(() => resolveSafe("State/x.json", { forWrite: true }), /state/i);
    assert.throws(() => resolveSafe("LEDGER/trades.csv", { forWrite: true }), /ledger/i);
    // 只读侧的受保护目录同样按小写比：`.GIT/config` 不该因为大小写混进去
    assert.throws(() => resolveSafe(".GIT/config"), /受保护目录/);
  });

  it("仓库外仍然一律拒绝（工具层边界没被这次改动放松）", () => {
    assert.throws(() => resolveSafe("../../etc/passwd", { forWrite: true }), /越界/);
    assert.throws(() => resolveSafe("C:/Windows/system32/x.txt", { forWrite: true }), /越界|受保护|敏感/);
  });

  it("判据是「路径片段」不是「子串」：别把守卫做成一刀切", () => {
    // 命中要求**某个路径段恰好等于** state / ledger；`x/state/y.json` 那一段确实叫 state，
    // 所以也拒（本仓没有这样的目录，宽一点比漏一条写路径安全）。
    assert.throws(() => resolveSafe("x/state/y.json", { forWrite: true }), /state/);
    // 但名字里**含** state 的文件/目录不该被误伤 —— 子串匹配会把它们一起挡掉，
    // 那是「守卫把功能堵死」的另一种长相。
    assert.ok(resolveSafe("experts/state_layout.md", { forWrite: true }).length > 0);
    assert.ok(resolveSafe("docs/x_state.json", { forWrite: true }).length > 0);
    assert.ok(resolveSafe("src/runstate.ts", { forWrite: true }).length > 0);
  });
});
