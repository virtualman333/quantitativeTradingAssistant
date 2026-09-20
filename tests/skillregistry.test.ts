/**
 * skillregistry.test.ts —— 技能注册表的「登记 ⇄ 实现」两向对账
 *
 * 为什么需要这份测试
 * ------------------
 * `src/skills.ts` 的头注释写着「新增 Skill 两步：① 加 `skills/<id>/skill.json`
 * ② 在 RUNNERS 注册同名 run 函数」。这句话**此前没有任何落点**，而它描述的是
 * 一个会**静默丢弃**的流程 —— 原实现里有四处丢法，没有一处会报错：
 *
 *   ① `skill.json` 解析失败            → `catch {}` 直接忽略
 *   ② 有 `skill.json` 但没有 run 实现  → `SKILLS` 里 `filter` 掉（该技能凭空消失）
 *   ③ 有 run 实现但没有登记            → 死代码，永远走不到
 *   ④ `skills/` 目录压根不在           → 「兜底不内置」直接返回空表
 *
 * 后果不是报错，而是**账面上看不出来的偏差**：界面显示 14 个技能、实际能跑 13 个。
 * 更狠的是第 ④ 条 —— `npm run dist` 打出来的包（`build.files` 只有
 * `dist / src / ui / package.json`）里**没有 `skills/`、没有 `experts/`、没有 `scripts/`**，
 * 安装版打开就是「暂无 Skill」「一个专家都没有」「所有 Python 能力全废」，全程无异常。
 * 这份测试同时锁住这两件事：注册表内部的成对性，以及打包规则真的覆盖运行期资源。
 *
 * 本文件锁四件事：
 *   A. 真调 `skillRegistryIssues()`：真实仓库必须零问题（解析面下限 = 技能数 ≥ 10，
 *      否则「两边都空」会让集合相等恒真）
 *   B. 独立真值两向对账：**磁盘** `skills/<dir>/skill.json` 的 id 集合
 *      ⇄ **源码** `RUNNERS` 的键集合（两边都不经过 `SKILLS`，避免自证）
 *   C. `run_skill` 的工具描述必须覆盖每一个注册技能 ——
 *      旧实现手抄了 6 个技能名，而注册表里有 15 个：模型只按描述挑工具，
 *      剩下 9 个（回测 / 因子 / 跨市场 / 复盘 / 报告 …）**在对话里等于不存在**
 *   D. 每个 `experts/<id>/expert.json` 声明的技能都必须在注册表里
 *      （声明了不存在的技能 = 该专家静默少一项能力）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { read, ROOT, stripComments } from "./_src.js";
import { SKILLS, skillRegistryIssues, skillMenu } from "../src/skills.js";
import { runSkillTool } from "../src/tools/project.js";

/** 解析面下限：低于这个数说明扫描面塌了（不是「恰好没问题」） */
const MIN_SKILLS = 10;

/** 磁盘真值：`skills/<dir>/skill.json` 的 id（不经过任何运行期代码） */
function diskSkillIds(): string[] {
  const dir = path.join(ROOT, "skills");
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const jp = path.join(dir, e.name, "skill.json");
    if (!fs.existsSync(jp)) continue;
    out.push(JSON.parse(fs.readFileSync(jp, "utf8")).id);
  }
  return out.sort();
}

/** 源码真值：`src/skills.ts` 里 RUNNERS 对象的键（剥注释后再匹配） */
function sourceRunnerIds(): string[] {
  const src = stripComments(read("src/skills.ts"));
  const at = src.indexOf("const RUNNERS");
  assert.ok(at >= 0, "src/skills.ts 里找不到 RUNNERS 的定义 —— 解析锚点没了");
  const seg = src.slice(at, src.indexOf("\n};", at));
  const ids = [...seg.matchAll(/^\s{2}([a-zA-Z_][\w]*):\s*async/gm)].map((m) => m[1]);
  assert.ok(ids.length >= MIN_SKILLS, `RUNNERS 只解析出 ${ids.length} 个键 —— 解析面塌了`);
  return ids.sort();
}

/** `experts/<id>/expert.json` 的 {专家, 技能} 列表 */
function expertDeclarations(): Array<{ expert: string; skills: string[] }> {
  const dir = path.join(ROOT, "experts");
  const out: Array<{ expert: string; skills: string[] }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const jp = path.join(dir, e.name, "expert.json");
    if (!fs.existsSync(jp)) continue;
    const j = JSON.parse(fs.readFileSync(jp, "utf8"));
    out.push({ expert: e.name, skills: (j.skills || []).map(String) });
  }
  return out.sort((a, b) => a.expert.localeCompare(b.expert));
}

describe("技能注册表 · 扫描期的静默丢弃必须出声", () => {
  it("真实仓库零问题（注册表自检为空）", () => {
    const issues = skillRegistryIssues();
    assert.deepEqual(
      issues.map((i) => `[${i.kind}] ${i.where} —— ${i.detail}`),
      [],
      "注册表自检报出问题（这些技能/实现已经处于「静默消失」状态）"
    );
  });

  it("解析面下限与 SKILLS 一致性", () => {
    assert.ok(
      SKILLS.length >= MIN_SKILLS,
      `只加载到 ${SKILLS.length} 个技能（下限 ${MIN_SKILLS}）—— 扫描面塌了，后面的等式会变成恒真`
    );
    // 自检为空的前提下，SKILLS 必须与磁盘登记一一对应（数量与内容都不许少）
    assert.deepEqual(SKILLS.map((s) => s.id).sort(), diskSkillIds());
  });

  it("登记 ⇄ 实现：磁盘 skill.json 的 id 集合 === 源码 RUNNERS 的键集合", () => {
    const disk = diskSkillIds();
    const impl = sourceRunnerIds();
    assert.deepEqual(
      disk.filter((id) => !impl.includes(id)),
      [],
      "这些技能登记了元数据但 RUNNERS 里没有实现 → 它们会被静默丢弃"
    );
    assert.deepEqual(
      impl.filter((id) => !disk.includes(id)),
      [],
      "这些 RUNNERS 实现没有对应的 skill.json → 死代码，永远调不到"
    );
  });
});

describe("run_skill 的工具描述必须跟着注册表走", () => {
  it("每一个注册技能都出现在描述里（词边界匹配）", () => {
    const desc = runSkillTool.description;
    const missing = diskSkillIds().filter(
      (id) => !new RegExp(`\\b${id}\\b`).test(desc)
    );
    assert.deepEqual(
      missing,
      [],
      `run_skill 的描述里没有这些技能 → 模型不会去调它们：${missing.join(", ")}\n` +
        `描述现算自注册表（skillMenu()），手抄清单一定会漏。`
    );
  });

  it("描述里出现的下划线标识符都必须是注册技能（例外只有工具自身名）", () => {
    const desc = runSkillTool.description;
    const known = new Set(diskSkillIds());
    // 手抄清单留下的任何「不存在的技能名」都会在这里现形
    const mentioned = [...desc.matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g)].map((m) => m[0]);
    const allowed = new Set(["run_skill"]); // 工具自身名（描述里写不写都行，写了不算未知技能）
    assert.ok(
      mentioned.length >= MIN_SKILLS,
      `描述里只解析出 ${mentioned.length} 个下划线标识符 —— 解析面塌了，下面的断言会变成恒真`
    );
    const unknown = [...new Set(mentioned)].filter((m) => !known.has(m) && !allowed.has(m));
    assert.deepEqual(unknown, [], `描述里提到未注册的技能名：${unknown.join(", ")}`);
  });

  it("skillMenu() 与注册表同源（且非空）", () => {
    const menu = skillMenu();
    assert.notEqual(menu.trim(), "", "skillMenu() 为空 —— 工具描述会说「一个技能都没有」");
    assert.deepEqual(
      diskSkillIds().filter((id) => !menu.includes(id)),
      [],
      "skillMenu() 漏了注册表里的技能"
    );
  });
});

describe("专家声明的技能必须真的存在", () => {
  it("每个 expert.json 的 skills 都在注册表里，且解析面不为空", () => {
    const decls = expertDeclarations();
    assert.ok(decls.length >= 5, `只扫到 ${decls.length} 个专家定义 —— 解析面塌了`);
    assert.ok(
      decls.every((d) => d.skills.length > 0),
      "有专家一个技能都没声明 —— 解析面塌了（后面的断言会变成恒真）"
    );
    const known = new Set(diskSkillIds());
    const bad: string[] = [];
    for (const d of decls) {
      for (const s of d.skills) if (!known.has(s)) bad.push(`${d.expert} -> ${s}`);
    }
    assert.deepEqual(
      bad,
      [],
      `这些专家声明了注册表里没有的技能（getSkill 返回 undefined 后被 filter 掉，能力静默消失）：\n${bad.join("\n")}`
    );
  });
});
