/**
 * packagecheck.test.ts —— 「打包内容校验」自己值不值得信
 *
 * 为什么需要这份测试
 * ------------------
 * `scripts/check-package.mjs` 是安装版资源缺失的**唯一**检测手段，而它此前有两处
 * 「说得比做得多」，两处都不会报错：
 *
 *   ① **清点只扫一层**：`experts/<id>/knowledge/*.md`（实测 11 个）根本没进校验面，
 *      而脚本里的注释写着「experts/<id>/expert.json + experts/<id>/knowledge/*」。
 *      于是「86 个资源都被覆盖」这句话里的 86 是假的 —— 真实情况是 75 + 11 个免检。
 *   ② **没有包可校验时照样报「打包内容校验通过」**：本机有一个中断的打包残留
 *      `release/win-unpacked.tmp`，脚本读不到 app.asar 就只追加一条 note，
 *      然后打印「打包内容校验通过：75 个运行期资源都被 build.files 覆盖」——
 *      实证层一次都没跑。人读到那句话，会以为包已经验过了。
 *
 * 这两条的共性还是那句话：**某一层拿到的东西，在它这里被静默丢掉了**。
 *
 * 本文件锁四件事：
 *   A. 清点必须递归，且 knowledge 目录下的文件**一个都不少**（数量与磁盘对账，不手抄）；
 *   B. 没有可校验的包时，成功信息里**不许出现**「打包内容校验通过」；
 *   C. 命令行点名了一个不存在的包 → 退出码必须非 0（不是静默跳过）；
 *   D. 实证层真的会读包、真的会报缺（用**合成 asar** 造正反两个场景）。
 *
 * 关于 D：以前实证层从没被跑过 —— 因为本机一直没有可校验的 asar，
 * 「读不读得懂 asar 头部」这件事**从来没有被验证过**。所以这里自己拼一个最小 asar
 * （chromium pickle 头 + JSON 目录），让正例（全都在包里）和反例（缺几个）都能确定地复现。
 *
 * 清单不手抄：测试通过 `--list` 问脚本「你现算出了哪些资源」，再拿它去造包 ——
 * 手抄一份资源名单，等于又制造一处「同一事实写两遍」。
 *
 * 运行：pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROOT } from "./_src.ts";

const SCRIPT = "scripts/check-package.mjs";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qta-pack-"));

function runCheck(args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

/** 现算的资源清单（脚本自己的枚举口径，唯一来源） */
function requiredList(): string[] {
  const r = runCheck(["--list"]);
  assert.equal(r.code, 0, `--list 应当成功，实际 ${r.code}：\n${r.out}`);
  const list = JSON.parse(r.out) as string[];
  assert.ok(Array.isArray(list) && list.length > 0, "--list 必须输出非空 JSON 数组");
  return list;
}

/**
 * 拼一个最小可读的 asar：16 字节 pickle 头 + 目录 JSON。
 * 只需要满足 `listAsar()` 的读法：偏移 12 是 JSON 字节数，偏移 16 起是 JSON。
 */
function makeAsar(fileList: string[]): string {
  const tree: Record<string, unknown> = {};
  for (const f of fileList) {
    const parts = f.split("/");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (!node[key]) node[key] = { files: {} };
      node = (node[key] as { files: Record<string, unknown> }).files;
    }
    node[parts[parts.length - 1]] = { size: 1, offset: "0" };
  }
  const json = Buffer.from(JSON.stringify({ files: tree }), "utf8");
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(json.length + 8, 4);
  head.writeUInt32LE(json.length, 8);
  head.writeUInt32LE(json.length, 12);
  const p = path.join(tmp(), "app.asar");
  fs.writeFileSync(p, Buffer.concat([head, json, Buffer.from([1])]));
  return p;
}

/** 造一个「release 目录」：里面放 dirs，每个 dir 可选带 resources/app.asar */
function makeRelease(dirs: Record<string, string | null>): string {
  const root = tmp();
  for (const [name, asar] of Object.entries(dirs)) {
    const d = path.join(root, name, "resources");
    fs.mkdirSync(d, { recursive: true });
    if (asar) fs.copyFileSync(asar, path.join(d, "app.asar"));
  }
  return root;
}

describe("打包内容校验 · 清点面", () => {
  it("知识库文件必须进校验面（此前 11 个全在面外）", () => {
    const list = requiredList();
    const onDisk: string[] = [];
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (!e.name.startsWith(".") && e.name !== "__pycache__") walk(r);
        } else if (e.name.endsWith(".md")) onDisk.push(r);
      }
    };
    walk("experts");
    const knowledgeOnDisk = onDisk.filter((p) => p.includes("/knowledge/"));
    assert.ok(
      knowledgeOnDisk.length >= 5,
      `磁盘上 experts/*/knowledge/*.md 只有 ${knowledgeOnDisk.length} 个 —— 这条对账失去了意义`
    );
    const missed = knowledgeOnDisk.filter((p) => !list.includes(p));
    assert.deepEqual(missed, [], `这些知识库文件没进校验面：${missed.join(", ")}`);

    const inList = list.filter((p) => p.includes("/knowledge/"));
    assert.equal(
      inList.length,
      knowledgeOnDisk.length,
      `清单里的知识库文件数（${inList.length}）与磁盘（${knowledgeOnDisk.length}）不一致`
    );
  });

  it("清点数量下限 + 四类资源都非空（扫描面塌了必须响）", () => {
    const list = requiredList();
    assert.ok(list.length >= 70, `只现算出 ${list.length} 个运行期资源，扫描面可能塌了`);
    for (const [dirName, floor] of [
      ["skills/", 5],
      ["experts/", 5],
      ["scripts/", 5],
      ["strategies/", 5],
    ] as const) {
      const n = list.filter((p) => p.startsWith(dirName)).length;
      assert.ok(n >= floor, `${dirName} 只清出 ${n} 项（下限 ${floor}）`);
    }
    assert.ok(list.includes("AGENT_TRADING_RULES.md"), "章程不在清单里");
  });

  it("清单本身不许是「什么都收」—— 非运行期文件不能被算进去", () => {
    const list = requiredList();
    // 反向对照：扫得太宽也是坏判据（ext 判错就变成恒真覆盖）
    for (const bad of ["package.json", "scripts/check-package.mjs", "tsconfig.json"]) {
      assert.ok(!list.includes(bad), `不该进清单的进了：${bad}`);
    }
  });
});

describe("打包内容校验 · 成功信息不许吹牛", () => {
  it("没有可校验的包时，不许出现「打包内容校验通过」", () => {
    const r = runCheck([], { QTA_RELEASE_DIR: makeRelease({}) });
    assert.equal(r.code, 0, `没有 release 目录时静态层应当通过：\n${r.out}`);
    assert.ok(!r.out.includes("打包内容校验通过"), `没有验证过包，却说校验通过：\n${r.out}`);
    assert.ok(r.out.includes("实证层**未运行**"), `应当说明实证层没跑：\n${r.out}`);
  });

  it("本机那个中断的打包残留（win-unpacked.tmp）必须被点名，而不是被当成不存在", () => {
    const rel = makeRelease({ "win-unpacked.tmp": null });
    const r = runCheck([], { QTA_RELEASE_DIR: rel });
    assert.equal(r.code, 0, `残留目录不该让静态层失败：\n${r.out}`);
    assert.ok(!r.out.includes("打包内容校验通过"), `仍然在谎报校验通过：\n${r.out}`);
    assert.ok(r.out.includes("win-unpacked.tmp"), `没有点名那个残留目录：\n${r.out}`);
    assert.ok(r.out.includes("中断的打包残留"), `没有说清它是中断的：\n${r.out}`);
  });

  it("命令行点名了不存在的包 → 必须失败（不是静默跳过）", () => {
    const missing = path.join(tmp(), "not-there.asar");
    const r = runCheck([missing]);
    assert.notEqual(r.code, 0, `点名了一个不存在的包却成功了：\n${r.out}`);
    assert.ok(r.out.includes("不存在"), `失败原因没说清：\n${r.out}`);
  });
});

describe("打包内容校验 · 实证层真的在读包", () => {
  it("正例：包里资源齐全 → 通过，且明确说实证层跑过了", () => {
    const list = requiredList();
    const asar = makeAsar(list);
    const r = runCheck([asar]);
    assert.equal(r.code, 0, `齐全的包应当通过：\n${r.out}`);
    assert.ok(r.out.includes("实证层通过"), `没说实证层跑过：\n${r.out}`);
    assert.ok(r.out.includes("打包内容校验通过"), `齐全的包应当给出完整结论：\n${r.out}`);
  });

  it("反例：包缺 3 个资源 → 必须失败，且把这 3 个名字点出来", () => {
    const list = requiredList();
    const dropped = list.filter((p) => p.includes("/knowledge/")).slice(0, 2).concat(["AGENT_TRADING_RULES.md"]);
    const asar = makeAsar(list.filter((p) => !dropped.includes(p)));
    const r = runCheck([asar]);
    assert.notEqual(r.code, 0, `缺资源的包却通过了：\n${r.out}`);
    for (const d of dropped) {
      assert.ok(r.out.includes(d), `缺失的 ${d} 没被点名：\n${r.out}`);
    }
  });

  it("反例：asar 头部解析不出文件 → 不拿它下结论（解析不可信要响）", () => {
    const p = path.join(tmp(), "app.asar");
    const head = Buffer.alloc(16);
    head.writeUInt32LE(4, 0);
    head.writeUInt32LE(8, 4);
    head.writeUInt32LE(0, 8);
    head.writeUInt32LE(0, 12);
    fs.writeFileSync(p, Buffer.concat([head, Buffer.from([0])]));
    const r = runCheck([p]);
    assert.notEqual(r.code, 0, `空头部的 asar 不该通过：\n${r.out}`);
  });

  it("反例：asar 被截断（头部声明的长度超出文件）→ 报「读不了」", () => {
    const good = makeAsar(requiredList());
    const raw = fs.readFileSync(good);
    const p = path.join(tmp(), "app.asar");
    fs.writeFileSync(p, raw.subarray(0, 24)); // 只留头部，JSON 全丢
    const r = runCheck([p]);
    assert.notEqual(r.code, 0, `截断的 asar 不该通过：\n${r.out}`);
    assert.ok(r.out.includes("读不了"), `没报「读不了」：\n${r.out}`);
  });
});

describe("打包内容校验 · 静态层判据不是恒真", () => {
  it("反例：把 build.files 清空 → 清单里每一项都必须被报成「不会进包」", () => {
    const list = requiredList();
    const r = runCheck([], { QTA_BUILD_FILES: "[]" });
    assert.notEqual(r.code, 0, `覆盖面清空了却通过了：\n${r.out}`);
    const reported = r.out
      .split("\n")
      .filter((l) => l.startsWith("✗ 运行期资源不在 build.files 里")).length;
    assert.equal(
      reported,
      list.length,
      `覆盖面清空后应报 ${list.length} 项，实际报了 ${reported} 项 —— 判据漏了东西`
    );
  });

  it("正例：仓库自己的 build.files 必须覆盖全部清单项", () => {
    const list = requiredList();
    const r = runCheck([], { QTA_RELEASE_DIR: makeRelease({}) });
    assert.equal(r.code, 0, `静态层应当通过：\n${r.out}`);
    const uncovered = r.out.split("\n").filter((l) => l.startsWith("✗ 运行期资源不在 build.files 里"));
    assert.deepEqual(uncovered, [], `这些资源不会被收进包：\n${uncovered.slice(0, 5).join("\n")}`);
    // 报告里的数字必须就是现算出来的数字（同一来源，不许两处各写一个）
    assert.ok(
      r.out.includes(`${list.length} 个运行期资源`),
      `成功信息里的数量与 --list 的 ${list.length} 对不上：\n${r.out}`
    );
  });

  it("覆盖面判据不许恒真：一个明显不存在的路径必须判成「没覆盖」", () => {
    // 用 override 只放一条通配，那个不存在的东西必须仍然被判「没覆盖」
    const r = runCheck([], { QTA_BUILD_FILES: '["skills/**/*"]' });
    assert.notEqual(r.code, 0, `只覆盖 skills 却通过了：\n${r.out}`);
    assert.ok(
      r.out.includes("AGENT_TRADING_RULES.md"),
      `章程明明不在覆盖面里却没被点出来：\n${r.out}`
    );
  });
});
