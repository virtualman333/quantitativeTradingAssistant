/**
 * knowledge.test.ts —— 专家知识库（`experts/<id>/knowledge/`）的三条边界
 *
 * 为什么需要这份测试
 * ------------------
 * 「专家知识库 + 自动进化」是项目的招牌能力：每轮结束后 `reflectExperts` 用 LLM 把
 * 本轮判断提炼成教训，追加进对应专家的 `knowledge/lessons.md`，下一轮整体注入该专家
 * 的 systemPrompt。但这条链上有三处**静默**，出事时一句日志都不会有：
 *
 *   ① **写哪儿不校验**：`evolveExpert(id)` 直接 `mkdir -p experts/<id>/knowledge`，
 *      而 id 来自 LLM 的 JSON 输出 —— `../../x` 能写到仓库外面去。
 *   ② **归属兜底没人接**：提示词让模型「无法归属时用 main」，而 `main` 不是任何专家。
 *      那些教训被写进 `experts/main/knowledge/lessons.md`，**没有任何专家会读它** ——
 *      自动进化的产出直接蒸发，而复盘那边只会说「提炼了 N 条教训」。
 *   ③ **裁剪与截断都不留痕**：lessons.md 超上限裁掉最旧一半（文件头却写着「只增不删」）；
 *      注入超上限时把正文从中间砍断（最后一句话被切成半句）。
 *
 * 本文件逐条钉住，并为每一条配了**反向对照**（正常路径必须照常工作 ——
 * 「全都抛错」也能让负向断言变绿，那不是锁）。
 *
 * ⚠ 测试通过 `QTA_EXPERTS_DIR` 把 experts 根指到临时目录：这些用例要真写文件，
 *   绝不能往仓库的 `experts/` 里丢垃圾。环境变量在**首次调用**时才被读取
 *   （`expertsRootDir()` 是函数而非模块级常量），所以静态 import 也安全。
 *
 * 运行：pnpm test
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  deleteKnowledgeFile,
  evolveExpert,
  knowledgeDir,
  knowledgeFilePath,
  listKnowledgeBuckets,
  listKnowledgeFiles,
  loadKnowledge,
  readKnowledgeFile,
  resolveKnowledgeBucket,
  writeKnowledgeFile,
  MAX_KNOWLEDGE_INJECT_BYTES,
  MAX_LESSONS_BYTES,
  SHARED_KNOWLEDGE_ID,
} from "../src/experts.ts";

// ── 沙箱：把 experts 根指到临时目录 ─────────────────────────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "qta-knowledge-"));
process.env.QTA_EXPERTS_DIR = SANDBOX;

function mkExpert(id: string, name = id) {
  fs.mkdirSync(path.join(SANDBOX, id, "knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(SANDBOX, id, "expert.json"),
    JSON.stringify({ id, name, duty: "", systemPrompt: "", skills: [], mcpServers: [], enabled: true }),
    "utf8"
  );
}
mkExpert("trading", "交易系统专家");
mkExpert("risk", "风控专家");

const kbFile = (id: string, name: string) => path.join(SANDBOX, id, "knowledge", name);
const ENTRY = (text: string) => ({ roundId: "R000001", time: "2026-09-18 05:00:00", text });

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe("知识库路径边界", () => {
  it("正向对照：合法的 bucket / 文件名解析后确实落在 experts 根之内", () => {
    // 没有这条，「全部抛错」的实现也能让下面所有负向断言变绿
    const dir = knowledgeDir("trading");
    assert.equal(dir, path.resolve(SANDBOX, "trading", "knowledge"));
    const f = knowledgeFilePath("trading", "01-仓位经验.md");
    assert.equal(path.dirname(f), dir);
    // 中文名、连字符、下划线都要放过（真实文件就叫 `00-领域经验.md`）
    assert.doesNotThrow(() => knowledgeFilePath("trading", "00-领域经验.md"));
    assert.doesNotThrow(() => knowledgeFilePath(SHARED_KNOWLEDGE_ID, "lessons.md"));
  });

  it("越界的 bucket id 一律拒绝", () => {
    for (const bad of ["../evil", "..", "a/b", "a\\b", "", "  ", "C:", "con:x"]) {
      assert.throws(() => knowledgeDir(bad), /非法|越界/, `应拒绝 id=${JSON.stringify(bad)}`);
    }
  });

  it("越界的文件名一律拒绝", () => {
    for (const bad of ["../a.md", "..", "sub/a.md", "sub\\a.md", "a.txt", "a.md/../b.md", ".hidden.md"]) {
      assert.throws(() => knowledgeFilePath("trading", bad), /非法|越界/, `应拒绝 name=${JSON.stringify(bad)}`);
    }
    // 反向对照：正常名字不能被误伤
    assert.doesNotThrow(() => knowledgeFilePath("trading", "02-新经验.md"));
  });
});

describe("教训归属：不许写进没人读的目录", () => {
  it("未知 id（含提示词里曾推荐的 main）落进共享桶，且共享桶会被每个专家读到", () => {
    assert.deepEqual(resolveKnowledgeBucket("main"), { target: SHARED_KNOWLEDGE_ID, reassigned: true });
    assert.deepEqual(resolveKnowledgeBucket("trading"), { target: "trading", reassigned: false });
    assert.deepEqual(resolveKnowledgeBucket(SHARED_KNOWLEDGE_ID), {
      target: SHARED_KNOWLEDGE_ID,
      reassigned: false,
    });

    const marker = "共享教训标记-MARKER-A";
    const r = evolveExpert("main", ENTRY(marker));
    assert.equal(r.ok, true);
    assert.equal(r.target, SHARED_KNOWLEDGE_ID);
    assert.equal(r.reassigned, true);
    // 核心回归：lesson 必须真的能被某个专家读到（旧实现写进 experts/main/，谁都不读）
    assert.match(loadKnowledge("trading"), new RegExp(marker));
    assert.match(loadKnowledge("risk"), new RegExp(marker));
    // 也不再凭空造一个假的专家目录
    assert.equal(fs.existsSync(path.join(SANDBOX, "main")), false);
  });

  it("已注册的 id 照常写进自己的目录（反向对照）", () => {
    const marker = "交易教训标记-MARKER-B";
    const r = evolveExpert("trading", ENTRY(marker));
    assert.equal(r.ok, true);
    assert.equal(r.target, "trading");
    assert.equal(r.reassigned, false);
    assert.ok(fs.existsSync(kbFile("trading", "lessons.md")));
    assert.match(fs.readFileSync(kbFile("trading", "lessons.md"), "utf8"), new RegExp(marker));
  });

  it("路径穿越的 id 被归一，不会在 experts 根之外留下任何目录", () => {
    const before = fs.readdirSync(SANDBOX).sort();
    const r = evolveExpert("../../evil", ENTRY("穿越尝试-MARKER-C"));
    assert.equal(r.ok, true);
    assert.equal(r.target, SHARED_KNOWLEDGE_ID);
    assert.equal(r.reassigned, true);
    assert.equal(fs.existsSync(path.resolve(SANDBOX, "..", "evil")), false);
    assert.deepEqual(fs.readdirSync(SANDBOX).sort(), before, "experts 根下的目录集合不应变化");
  });
});

describe("体积上限：裁剪与注入都要留痕", () => {
  it("lessons.md 超上限时裁剪，并在文件里留下记录（且新教训保住）", () => {
    const big =
      "# 教训与进化记录（复盘提炼）\n\n" +
      "- 2026-09-01 00:00:00 [R000000] 旧教训填充行 BLAH BLAH BLAH\n\n".repeat(2000);
    const p = knowledgeFilePath("trading", "lessons.md");
    fs.writeFileSync(p, big, "utf8");
    const before = fs.statSync(p).size;
    assert.ok(before > MAX_LESSONS_BYTES, "前置条件：文件确实已超上限");

    const marker = "裁剪后新写的教训-MARKER-D";
    const r = evolveExpert("trading", ENTRY(marker));
    assert.equal(r.trimmed, true);
    const after = fs.readFileSync(p, "utf8");
    assert.ok(fs.statSync(p).size < before, "裁剪必须真的让文件变小");
    assert.match(after, /已超过/, "裁剪必须在文件里留痕");
    assert.match(after, /裁掉最旧一半/);
    assert.match(after, new RegExp(marker), "最新的教训不能被裁掉");
  });

  it("没超上限时不裁剪（反向对照，防「永远报 trimmed」）", () => {
    const r = evolveExpert("risk", ENTRY("小文件教训-MARKER-E"));
    assert.equal(r.trimmed, false);
    assert.equal(r.ok, true);
  });

  it("注入超上限时按文件跳过并点名，不做半句截断", () => {
    const keep = "KEEP-MARKER-F" + "x".repeat(6000);
    const drop = "DROP-MARKER-G" + "y".repeat(6000);
    writeKnowledgeFile("risk", "0-first.md", keep);
    writeKnowledgeFile("risk", "9-second.md", drop);

    const text = loadKnowledge("risk");
    assert.match(text, /KEEP-MARKER-F/);
    assert.match(text, /KEEP-MARKER-F[\s\S]*x{6000}/, "第一份文件必须是完整的，不能被从中间砍断");
    assert.match(text, /未注入/);
    assert.match(text, /9-second\.md/, "被跳过的文件必须点名");
    assert.ok(
      Buffer.byteLength(text, "utf8") <= MAX_KNOWLEDGE_INJECT_BYTES + 500,
      "提示句只应额外占很小一段，不能整体超限"
    );
  });
});

describe("文件读写与「不会被人读到」的文件", () => {
  it("只收 .md；非 .md 文件会出现在列表里并被显式标记为 ignored", () => {
    assert.throws(() => writeKnowledgeFile("risk", "notes.txt", "hi"), /非法/);

    // 手工放一个非 .md（模拟用户拷进来）
    fs.writeFileSync(kbFile("risk", "readme.txt"), "不该被注入的内容 README-MARKER-H", "utf8");
    const files = listKnowledgeFiles("risk");
    const txt = files.find((f) => f.name === "readme.txt");
    assert.ok(txt, "目录里的非 .md 文件也要出现在列表里（否则它被忽略这件事没人知道）");
    assert.equal(txt!.ignored, true);
    assert.equal(files.find((f) => f.name === "lessons.md")?.ignored, false);
    // 不静默：内容不得进注入面
    assert.doesNotMatch(loadKnowledge("risk"), /README-MARKER-H/);
  });

  it("读 / 写 / 删 走同一套校验（删除不存在的文件要报错，不静默成功）", () => {
    const name = "03-自测.md";
    const bytes = writeKnowledgeFile("risk", name, "# 自测\n正文\n");
    assert.equal(readKnowledgeFile("risk", name), "# 自测\n正文\n");
    assert.equal(bytes, Buffer.byteLength("# 自测\n正文\n", "utf8"));
    deleteKnowledgeFile("risk", name);
    assert.equal(fs.existsSync(kbFile("risk", name)), false);
    assert.throws(() => deleteKnowledgeFile("risk", name), /不存在/);
  });
});

describe("bucket 清单（界面「经验库」页的数据源）", () => {
  it("列出已注册专家 + 共享桶，并把「没有对应专家的遗留目录」标成 orphan", () => {
    // 模拟历史遗留：目录在、expert.json 不在（例如旧实现写出来的 main/）
    fs.mkdirSync(path.join(SANDBOX, "ghost", "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(SANDBOX, "ghost", "knowledge", "lessons.md"), "- 孤儿教训\n", "utf8");

    const buckets = listKnowledgeBuckets();
    const byId = new Map(buckets.map((b) => [b.id, b]));

    assert.equal(byId.get("trading")?.orphan, false);
    assert.equal(byId.get(SHARED_KNOWLEDGE_ID)?.shared, true);
    assert.equal(byId.get("ghost")?.orphan, true, "没有 expert.json 的目录必须报成 orphan");
    assert.equal(byId.get("ghost")?.shared, false);
    // 空目录不该进列表（纯噪声）
    fs.mkdirSync(path.join(SANDBOX, "empty1", "knowledge"), { recursive: true });
    assert.equal(
      listKnowledgeBuckets().some((b) => b.id === "empty1"),
      false
    );
  });
});
