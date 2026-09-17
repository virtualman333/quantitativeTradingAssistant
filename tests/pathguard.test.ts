/**
 * pathguard.test.ts —— 「写禁区覆盖了仓库里所有承载状态文件的目录」这件事的落点
 *
 * 为什么需要它
 * ------------
 * `src/tools/paths.ts` 的 `DENY_WRITE_DIRS` 声称「写操作禁止进入**风控判据与账本的
 * 载体**」。在那之前它是**手抄的两个名字**：`["state", "ledger"]`。
 *
 * 实测（本轮取证，改之前跑的）：`write_file` 能直接覆盖
 *
 *   logs/rounds.jsonl          文档原话：「只追加归档，历史行永不改写」（章程 L1-7）
 *   news/news.jsonl            文档原话：「只追加审计流水（L1-7，不可改写）」
 *   data/scalper_trades.jsonl  超短线开单记录（战绩面板的唯一来源）
 *   data/scalper_ticks.jsonl   监测记录（「执行出错」桶的唯一来源）
 *   data/store.json            配置与轮次历史索引
 *
 * —— 它们和 `state/`、`ledger/` 是同一类东西，只因为**没被抄进那两个名字**就没人管。
 * 「文档里那句覆盖面承诺只对了一半」比没有那句话更坏：它让人以为账本已经有人守了。
 *
 * 所以这里把覆盖面变成**现算**的，两套口径互相对账：
 *
 *   ① 磁盘口径：一级目录里（任意深度）有 `*.json|jsonl|csv` 的
 *   ② 源码口径：源码字面量里以 `<目录>/x.json|jsonl|csv` 被引用过的一级目录
 *
 * 判据：**清点出来的每一个目录，要么在 `DENY_WRITE_DIRS` 里，要么进 `WRITE_EXEMPT`
 * 并写明理由**；反向也查（例外表里不许有清点不到的僵尸条目）。少一个就红。
 *
 * 两套口径都要，是因为它们各自看不见一半：
 *   · 只看磁盘：`ledger/`、`logs/`、`news/` 现在**在本机根本不存在**（新 clone 也没有），
 *     于是「写禁区里有三个不存在的目录」看起来像死条目 —— 而它们是运行期才出现的账本；
 *   · 只看源码：`data/` 在源码里是 `path.join(AGENT_ROOT, "data", "…")` 拼出来的，
 *     字面量并不长成 `data/x.jsonl`，只有注释里提过。
 *
 * 扫描面本身也现算：源码目录取自仓库实际存在的一级目录（见 `SOURCE_DIRS` 的注释），
 * 不走手抄清单 —— 与 `tests/toolsguard.test.ts` 的行为锁合起来，
 * 一条管「覆盖面对不对」，一条管「拦得住拦不住」。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./_src.ts";
import { DENY_WRITE_DIRS, DENY_WRITE_HINT, resolveSafe, relOf } from "../src/tools/paths.ts";

/** 安装 / 构建产物：不参与清点（定义性排除，不是「覆盖率清单」） */
const ARTIFACT_DIRS = new Set(["node_modules", "dist", "dist-electron", "release", ".git", ".venv", "__pycache__"]);

/** 「状态文件」的判据：这三类后缀就是判据与账本的载体形态 */
const STATE_FILE_RE = /\.(json|jsonl|csv)$/i;

/** 会被扫的源码后缀（含 `.mjs`：`scripts/` 下的构建脚本也在里面） */
const SRC_EXT_RE = /\.(py|ts|mjs|js|vue)$/;

/**
 * 源码口径的扫描面：只扫**仓库里真实存在**的源码一级目录。
 *
 * 刻意**不扫 `tests/`**：那里的路径字符串是**被断言的对象**（本文件里就有
 * `"state/month_state.json"` 这种字面量），把它们算进「谁在引用状态文件」会让
 * 清点结果自己喂自己。这是刻意写下来的，不是漏了。
 */
const SOURCE_DIRS = ["scripts", "src", "ui", "electron"].filter((d) => fs.existsSync(path.join(ROOT, d)));

/**
 * 被清点出来、但**刻意不进**写禁区的目录 —— 声明式例外，每条都要有理由。
 *
 * 判据：它承载的是**可以人工编辑的配置 / 定义 / 凭证路径**，而不是「风控判据」或
 * 「账本」。改错只影响那个策略/专家/技能自己，不会让任何 L1 判据失去依据、
 * 也不会让任何一本账对不上。**理由必须写在数据里**，否则下一个人只能重新推一遍。
 */
const WRITE_EXEMPT: Record<string, string> = {
  experts: "专家（角色）定义，用户手工编辑的配置；读它的是 src/experts.ts，不参与 L1 判据",
  skills: "技能清单，同上（src/skills.ts）；改错只影响该技能自己",
  strategies: "策略定义，用户/agent 迭代的对象（scripts/strategy_check.py 是它的校验入口）；不是判据也不是账本",
  scripts: "命中来自 scripts/.smtp_local.json —— 那是**凭证**文件（属 DENY_FILES 那一类），不是状态载体；scripts/ 本身是源码目录，通用写工具要能改它",
};

/** ① 磁盘口径：一级目录里（任意深度）有状态文件的 */
function diskInventory(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || ARTIFACT_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const hits: string[] = [];
    (function walk(dir: string) {
      for (const c of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ARTIFACT_DIRS.has(c.name)) continue;
        const full = path.join(dir, c.name);
        if (c.isDirectory()) walk(full);
        else if (STATE_FILE_RE.test(c.name)) hits.push(path.relative(ROOT, full).replace(/\\/g, "/"));
      }
    })(path.join(ROOT, e.name));
    if (hits.length) out.set(e.name.toLowerCase(), hits.sort());
  }
  return out;
}

/**
 * ② 源码口径：源码字面量里以 `<目录>/x.json|jsonl|csv` 出现过的目录。
 *
 * 正则前面那个 `(^|[^/\w.-])` 是**片段边界**：目录名前面不能是 `/` ——
 * 否则 `experts/factor/expert.json` 会把尾段 `factor` 当成一级目录、
 * `~/.workbuddy/connectors/default/mcp.json` 会把 `default` 当成仓库里的目录。
 * 少了这个边界，例外表里会多出三条假条目（本轮实测）。
 */
const STATE_REF_RE = /(^|[^/\w.-])([A-Za-z][\w-]*)\/[\w.%*-]*\.(?:json|jsonl|csv)\b/g;

function sourceInventory(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const files: string[] = [];
  for (const dir of SOURCE_DIRS) {
    (function walk(d: string) {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        if (ARTIFACT_DIRS.has(e.name)) continue;
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (SRC_EXT_RE.test(e.name)) files.push(rel);
      }
    })(dir);
  }
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    let m: RegExpExecArray | null;
    STATE_REF_RE.lastIndex = 0;
    while ((m = STATE_REF_RE.exec(text)) !== null) {
      const dir = m[2].toLowerCase();
      const hit = `${rel}: ${m[0].trim()}`;
      if (!out.has(dir)) out.set(dir, []);
      if (!out.get(dir)!.includes(hit)) out.get(dir)!.push(hit);
    }
  }
  for (const v of out.values()) v.sort();
  return out;
}

const DISK = diskInventory();
const SRC = sourceInventory();
const CANDIDATES = [...new Set([...DISK.keys(), ...SRC.keys()])].sort();

describe("A. 清点面自证：两套口径都要真的解出东西，锚点必须在", () => {
  it("两套口径都不为空（否则「全覆盖」是一句因为什么都没扫而成立的空话）", () => {
    assert.ok(DISK.size > 0, "磁盘口径一个目录都没扫到 —— 路径层级变了？");
    assert.ok(SRC.size > 0, "源码口径一个引用都没扫到 —— 探测正则失效了？");
    assert.ok(SOURCE_DIRS.length >= 3, `源码扫描面只剩 ${SOURCE_DIRS.length} 个目录（${SOURCE_DIRS.join(", ")}）`);
  });

  it("已实测存在的那几个账本载体必须被清点出来（扫描器坏掉时先在这里红）", () => {
    // 这几条是**定点探测**：它们各自代表一种形态 ——
    // 磁盘命中（data）/ 只被源码引用（ledger、logs、news）/ 两者都有（state）
    for (const dir of ["state", "ledger", "logs", "data", "news"]) {
      assert.ok(
        CANDIDATES.includes(dir),
        `清点结果里没有 ${dir}/ —— 探测正则或扫描面坏了（当前清点：${CANDIDATES.join(", ")}）`
      );
    }
  });
});

describe("B. 双向对齐：清点出来的目录都得有归处，例外表里不许有僵尸", () => {
  it("每个承载状态文件的一级目录，要么在写禁区里，要么在例外表里写明理由", () => {
    const unhandled = CANDIDATES.filter((d) => !DENY_WRITE_DIRS.includes(d) && !(d in WRITE_EXEMPT));
    assert.deepEqual(
      unhandled,
      [],
      "这些目录里有 json/jsonl/csv，却既不在写的禁区、也没在例外表里说明「它为什么不是判据/账本」：\n  " +
        unhandled
          .map((d) => `${d}/  { 磁盘 ${(DISK.get(d) ?? []).length} 个状态文件，源码引用 ${(SRC.get(d) ?? []).length} 处 }`)
          .join("\n  ") +
        "\n→ 是判据/账本载体就加进 src/tools/paths.ts 的 DENY_WRITE_DIRS；不是就在本文件的 WRITE_EXEMPT 里写明理由。"
    );
  });

  it("例外表里没有僵尸条目（清点不到的条目要删掉，别留着当装饰）", () => {
    const zombies = Object.keys(WRITE_EXEMPT).filter((d) => !CANDIDATES.includes(d));
    assert.deepEqual(zombies, [], `例外表里这些目录已经清点不到了：${zombies.join(", ")} —— 清单腐烂`);
  });

  it("写禁区里没有死条目（清点不出来的目录要能解释：它是运行期才出现的账本）", () => {
    // `ledger/`、`logs/`、`news/` 在本机不存在（新 clone 也没有），它们是运行期才出现的
    // —— 所以判据不是「磁盘上必须有」，而是「至少源码里有引用」，否则就是凭空的禁区。
    const unsupported = DENY_WRITE_DIRS.filter((d) => !CANDIDATES.includes(d));
    assert.deepEqual(
      unsupported,
      [],
      `写禁区里这些目录既没在磁盘上、也没被源码引用过：${unsupported.join(", ")} —— ` +
        "要么删掉，要么它确实该有引用（那说明源码被改坏了）"
    );
  });

  it("每个禁区的报错都要点名「该走哪个入口」（否则模型会反复重试同一个被拒的写入）", () => {
    const missing = DENY_WRITE_DIRS.filter((d) => !DENY_WRITE_HINT[d]);
    assert.deepEqual(missing, [], `这些禁区目录没有写明该走哪个入口：${missing.join(", ")}`);
  });

  it("有例外也要有禁区：禁区和例外不许同时为空（否则守卫退化成一个恒真的空集）", () => {
    assert.ok(DENY_WRITE_DIRS.length > 0, "写禁区是空的");
    assert.ok(Object.keys(WRITE_EXEMPT).length > 0, "例外表是空的 —— 那说明「例外」这件事没被想过");
  });
});

describe("C. 行为：每个禁区目录都真的写不进去，但读得了", () => {
  it("禁区里的探针路径一律被拒（覆盖写与追加都一样）", () => {
    for (const dir of DENY_WRITE_DIRS) {
      const probe = `${dir}/pathguard_probe.json`;
      assert.throws(
        () => resolveSafe(probe, { forWrite: true }),
        new RegExp(dir, "i"),
        `${probe} 没有被拒绝 —— 通用写工具可以直接改写它`
      );
      // 追加也只是另一种改写：同一个 forWrite 通道
      assert.throws(() => resolveSafe(`${dir}/sub/deep_probe.jsonl`, { forWrite: true }), /风控判据与账本|载体/);
      // 大小写变体（Windows 上 State/ 与 state/ 是同一个目录）
      assert.throws(() => resolveSafe(`${dir.toUpperCase()}/probe.json`, { forWrite: true }));
      // 只读侧不受影响 —— 边界是「不许改写」，不是「不许看」
      assert.equal(relOf(resolveSafe(probe)), probe, `${probe} 连读都不让了`);
    }
  });

  it("反向对照：例外表里的目录（以及别的普通目录）照常可写 —— 守卫不许把功能堵死", () => {
    for (const dir of Object.keys(WRITE_EXEMPT)) {
      assert.ok(
        resolveSafe(`${dir}/pathguard_probe.json`, { forWrite: true }).length > 0,
        `${dir}/ 被挡住了 —— 例外表说了它不该在禁区里`
      );
    }
    assert.ok(resolveSafe("reports/probe.txt", { forWrite: true }).length > 0, "普通目录被堵死了");
    assert.ok(resolveSafe("src/tools/paths.ts", { forWrite: true }).length > 0, "源码写被堵死了");
  });

  it("磁盘上**真实存在**的每个禁区状态文件，写解析都必须被拒（不落盘，纯判据）", () => {
    // 上一条用的是「探针路径」（不存在，真去写会被守卫拦住，有落盘风险）；
    // 这一条走纯解析：把磁盘上**真实的账本**逐个喂给 resolveSafe，
    // 零 I/O 风险 —— 拿真账本做写测试是有代价的（进程被杀就还原不回去）。
    let checked = 0;
    for (const dir of DENY_WRITE_DIRS) {
      for (const rel of DISK.get(dir) ?? []) {
        assert.throws(
          () => resolveSafe(rel, { forWrite: true }),
          new RegExp(dir, "i"),
          `${rel} 可以被通用写工具覆盖 —— 它是账本/判据`
        );
        assert.ok(resolveSafe(rel).length > 0, `${rel} 连读都不让了`);
        checked++;
      }
    }
    assert.ok(checked > 0, "磁盘上一个真实的状态文件都没验到 —— 这条用例是空跑的");
  });
});
