#!/usr/bin/env node
/**
 * scripts/check-package.mjs —— 打包内容校验：运行期资源到底有没有进包
 *
 * 为什么需要它
 * ------------
 * `npm run dist` 打出来的安装版**运行期资源大面积缺失，且全程没有任何东西会响**：
 * 实测（2026-09-20）`npx electron-builder --win dir` 产出的
 * `release/win-unpacked/resources/app.asar` 顶层只有
 * `node_modules / dist / package.json / src / ui` —— **没有 `skills/`、没有 `experts/`、
 * 没有 `scripts/`、没有 `AGENT_TRADING_RULES.md`**（`extraResources` 只把 scripts 与章程
 * 放到了 `resources/` 下，而运行期是按 `AGENT_ROOT`（= app.asar 根）找它们的）。
 *
 * 于是安装版打开就是：技能页「暂无 Skill」、8 个专家全空、所有 Python 能力（行情/新闻/回测）
 * 找不到脚本、章程读不到。全部**不报错**，因为 `SKILLS` 的设计是「扫描不到就为空」。
 *
 * 本脚本做两层判断，任一层失败即退出码非 0：
 *   A. 静态层：`package.json` 的 `build.files` 规则必须**覆盖每一个运行期只读资源**
 *      （现算：磁盘上有哪些 skill / expert / script / 章程，就要求它们都在规则里）
 *   B. 实证层：若存在已打好的 asar，直接读它的头部，断言这些资源**真的在包里**
 *
 * 已知缺口（本脚本只提示、不判失败）：`state/ data/ logs/ reports/` 是运行期要**写**的目录，
 * 而 asar 是只读的 —— 安装版还需要一个「可写根」（dev 模式不受影响）。
 * 见台账「候选」区，动手前先用本脚本的实证层确认包的形状。
 *
 * 用法：`node scripts/check-package.mjs [asarPath]`（不给路径就自动在 release/ 下找）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const notes = [];

/** 运行期**只读**资源：按 AGENT_ROOT（= 包根）解析，必须进 asar */
function requiredResources() {
  const out = [];
  const pushDir = (dir, pick) => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        for (const f of fs.readdirSync(path.join(abs, e.name))) {
          if (pick(e.name, f)) out.push(`${dir}/${e.name}/${f}`);
        }
      } else if (pick("", e.name)) {
        out.push(`${dir}/${e.name}`);
      }
    }
  };
  // skills/<id>/skill.json —— 技能注册表的全部输入
  pushDir("skills", (_d, f) => f.endsWith(".json"));
  // experts/<id>/expert.json + experts/<id>/knowledge/*
  pushDir("experts", (_d, f) => f.endsWith(".json") || f.endsWith(".md"));
  // scripts/*.py —— 所有 Python 能力（行情/新闻/回测/归档/发信）
  pushDir("scripts", (_d, f) => f.endsWith(".py"));
  // strategies/* —— 自定义策略模板（src/strategies.ts 读 AGENT_ROOT/strategies）
  pushDir("strategies", (_d, f) => f.endsWith(".json") || f.endsWith(".md") || f.endsWith(".py"));
  // 章程（专家 read_charter 与主 Agent 读的都是它）
  if (fs.existsSync(path.join(ROOT, "AGENT_TRADING_RULES.md"))) out.push("AGENT_TRADING_RULES.md");
  return out.sort();
}

/**
 * 极简 glob（兜底）：只支持 `dir/**\/*`（整棵子树）与段内 `*`
 *
 * 首选 `minimatch` —— electron-builder 内部用的就是它，语义才是权威的；
 * 但这个脚本偶尔要在没装依赖的目录下跑，所以留一条不依赖 node_modules 的兜底。
 */
let mm = null;
try {
  mm = (await import("minimatch")).minimatch;
} catch {
  mm = null;
}

function matchGlob(pattern, rel) {
  if (mm) return mm(rel, pattern, { dot: true });
  const sub = pattern.match(/^(.*)\/\*\*(\/\*)?$/);
  if (sub) return rel === sub[1] || rel.startsWith(sub[1] + "/");
  if (!pattern.includes("*")) return rel === pattern;
  const rx = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${rx}$`).test(rel);
}

/** 该相对路径是否会被 build.files 收进包 */
function coveredByFiles(rel, patterns) {
  return patterns.some((p) => matchGlob(p, rel));
}

// ── A. 静态层 ─────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const files = (pkg.build && pkg.build.files) || [];
const extra = (pkg.build && pkg.build.extraResources) || [];
if (!files.length) fails.push("package.json 里没有 build.files —— electron-builder 会用默认规则，运行期资源必掉");

const required = requiredResources();
if (required.length < 30) {
  // 解析面下限：本仓实测约 70+ 项，低于 30 说明扫描面塌了
  fails.push(`只现算出 ${required.length} 个运行期资源（下限 30）—— 扫描面塌了，下面的判断会变成恒真`);
}
for (const rel of required) {
  const inFiles = coveredByFiles(rel, files);
  const inExtra = extra.some((e) => rel === e.from || rel.startsWith(String(e.from).replace(/\/$/, "") + "/"));
  if (!inFiles) {
    fails.push(
      `运行期资源不在 build.files 里 → 不会进 app.asar：${rel}` +
        (inExtra ? `（它只被 extraResources 放到了 resources/ 下，而运行期按 AGENT_ROOT 找它）` : "")
    );
  }
}

// ── B. 实证层（若已有打好的包）─────────────────────────────
function findAsar() {
  const arg = process.argv[2];
  if (arg) return fs.existsSync(arg) ? arg : null;
  const rel = path.join(ROOT, "release");
  if (!fs.existsSync(rel)) return null;
  for (const d of fs.readdirSync(rel)) {
    const p = path.join(rel, d, "resources", "app.asar");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function listAsar(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const size = head.readUInt32LE(12);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 16);
    const json = JSON.parse(buf.toString("utf-8"));
    const out = [];
    (function walk(node, prefix) {
      for (const k of Object.keys(node.files || {})) {
        const child = node.files[k];
        const p = prefix + "/" + k;
        if (child.files) walk(child, p);
        else out.push(p);
      }
    })(json, "");
    return { top: Object.keys(json.files || {}), files: out };
  } finally {
    fs.closeSync(fd);
  }
}

const asarPath = findAsar();
if (asarPath) {
  const { top, files: packed } = listAsar(asarPath);
  const packedSet = new Set(packed);
  const missing = required.filter((rel) => !packedSet.has("/" + rel));
  if (missing.length) {
    fails.push(
      `${path.basename(path.dirname(path.dirname(asarPath)))} 的 app.asar 里缺 ${missing.length} 个运行期资源：` +
        `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}\n` +
        `    包内顶层 = ${top.join(", ")}`
    );
  } else {
    notes.push(`实证层通过：${required.length} 个运行期资源都在 app.asar 里（顶层 ${top.join(", ")}）`);
  }
} else {
  notes.push("没有找到已打好的 app.asar，跳过实证层（静态层已生效）；要出包请跑 npx electron-builder --win dir");
}

// ── 已知缺口（不算失败，但必须让人看见）─────────────────────
const WRITABLE = ["state", "data", "logs", "reports", "news", "ledger"];
notes.push(
  `已知缺口：${WRITABLE.join(" / ")} 是运行期**要写**的目录，而 asar 只读 —— ` +
    `安装版还需要一个「可写根」（dev 模式下这些目录就在仓库里，所以本地怎么跑都正常）`
);

// ── 输出 ──────────────────────────────────────────────────
for (const n of notes) console.log(`· ${n}`);
if (fails.length) {
  console.log("");
  for (const f of fails) console.log(`✗ ${f}`);
  console.log(`\n打包内容校验失败：${fails.length} 项`);
  process.exit(1);
}
console.log(`\n打包内容校验通过：${required.length} 个运行期资源都被 build.files 覆盖`);
