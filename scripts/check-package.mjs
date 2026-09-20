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
 * 没有 `scripts/`、没有 `AGENT_TRADING_RULES.md`**。
 *
 * 于是安装版打开就是：技能页「暂无 Skill」、8 个专家全空、所有 Python 能力（行情/新闻/回测）
 * 找不到脚本、章程读不到。全部**不报错**，因为 `SKILLS` 的设计是「扫描不到就为空」。
 *
 * 本脚本做两层判断，任一层失败即退出码非 0：
 *   A. 静态层：`package.json` 的 `build.files` 规则必须**覆盖每一个运行期只读资源**
 *      （现算：磁盘上有哪些 skill / expert / script / 章程，就要求它们都在规则里）
 *   B. 实证层：若存在已打好的 asar，直接读它的头部，断言这些资源**真的在包里**
 *
 * ── 三条边界（都踩过，写在这里免得下次又改回去）──────────────────
 *
 * ① **清点必须递归**。上一版只扫「被监视目录的下一层」，于是
 *    `experts/<id>/knowledge/*.md`（实测 11 个）**一个都没进校验面**，
 *    而文件头的注释却写着「experts 的 knowledge 也在内」—— 注释比代码诚实，
 *    或者说代码在替注释吹牛。资源的层级不是契约的一部分，漏扫一层就等于该资源免检。
 *
 * ② **「没有包可校验」不等于「校验通过」**。上一版在 `release/` 下找不到 app.asar 时
 *    只追加一条 note，然后照样打印「打包内容校验通过：75 个运行期资源都被 build.files 覆盖」
 *    —— 本机就有一个中断的打包残留 `release/win-unpacked.tmp`（367MB，没有 app.asar），
 *    于是人看到的那句话是**假的**：实证层根本没跑。现在成功信息按实际跑过的层缩口径。
 *
 * ③ **命令行点了名的包，不在就必须失败**。`check-package.mjs some/path.asar` 里
 *    路径不存在时静默降级成「跳过实证层」，等于把「我要检查这个包」偷换成「我不检查了」。
 *
 * 已知缺口（本脚本只提示、不判失败）：`state/ data/ logs/ reports/` 是运行期要**写**的目录，
 * 而 asar 是只读的 —— 安装版还需要一个「可写根」（dev 模式不受影响）。
 * 见台账「候选」区，动手前先用本脚本的实证层确认包的形状。
 *
 * 用法：
 *   node scripts/check-package.mjs                 # 自动在 release/ 下找包
 *   node scripts/check-package.mjs <asarPath>      # 检查指定的包（不存在即失败）
 *   node scripts/check-package.mjs --list          # 只打印现算出的运行期资源清单（JSON）
 * 环境变量 `QTA_RELEASE_DIR` 可以改掉「去哪儿找包」，测试靠它造确定性场景。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = process.env.QTA_RELEASE_DIR
  ? path.resolve(process.env.QTA_RELEASE_DIR)
  : path.join(ROOT, "release");
const fails = [];
const notes = [];

/** 递归深度上限：实测最深是 experts/<id>/knowledge/<file>（3 层），留一倍余量 */
const MAX_DEPTH = 6;
/** 这些子目录里的东西不是运行期资源 */
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git"]);

/**
 * 运行期**只读**资源：按 AGENT_ROOT（= 包根）解析，必须进 asar。
 *
 * 按「被监视目录 + 扩展名」现算，**递归**扫整棵子树 —— 层级不入契约，
 * 多一层（`experts/<id>/knowledge/x.md`）和少一层（`skills/<id>/skill.json`）同等对待。
 */
const WATCHED = [
  { dir: "skills", ext: [".json"], why: "技能注册表的全部输入" },
  { dir: "experts", ext: [".json", ".md"], why: "专家定义 + 知识库（knowledge/ 在第二层）" },
  { dir: "scripts", ext: [".py"], why: "全部 Python 能力（行情/新闻/回测/归档/发信）" },
  { dir: "strategies", ext: [".json", ".md", ".py"], why: "自定义策略模板" },
];

function requiredResources() {
  const out = [];
  const scan = (relDir, ext, depth) => {
    const abs = path.join(ROOT, relDir);
    if (!fs.existsSync(abs) || depth > MAX_DEPTH) return 0;
    let n = 0;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) n += scan(rel, ext, depth + 1);
      else if (ext.some((x) => e.name.endsWith(x))) {
        out.push(rel);
        n += 1;
      }
    }
    return n;
  };
  for (const w of WATCHED) {
    const n = scan(w.dir, w.ext, 1);
    // 自证：每个被监视目录都得真的扫出东西，否则「覆盖」是在空集上恒真
    if (n === 0) fails.push(`被监视目录 ${w.dir}/ 一个运行期资源都没扫到（${w.why}）—— 扫描面塌了`);
  }
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
/**
 * `build.files` 允许被 `QTA_BUILD_FILES` 覆盖（JSON 数组）。用途只有一个：
 * 让测试能验证「覆盖面判据不是恒真」——把覆盖面清空，86 项必须**全部**被报出来。
 * 不这么开个口子，测试就只能自己再实现一遍 glob 语义，那是又一处「同一事实写两遍」。
 */
const filesOverride = process.env.QTA_BUILD_FILES;
const files = filesOverride ? JSON.parse(filesOverride) : (pkg.build && pkg.build.files) || [];
const extra = (pkg.build && pkg.build.extraResources) || [];
if (!files.length) fails.push("package.json 里没有 build.files —— electron-builder 会用默认规则，运行期资源必掉");

const required = requiredResources();

if (process.argv.includes("--list")) {
  // 只输出清单就退出：测试靠它拿到**同一份**现算结果去造合成包，
  // 避免测试里再抄一份「运行期资源有哪些」——那就又成了「同一事实写两遍」。
  process.stdout.write(JSON.stringify(required, null, 2) + "\n");
  process.exit(fails.length ? 1 : 0);
}

if (required.length < 70) {
  // 解析面下限：本仓实测 86 项，低于 70 说明扫描面塌了
  fails.push(`只现算出 ${required.length} 个运行期资源（下限 70）—— 扫描面塌了，下面的判断会变成恒真`);
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
/**
 * 找包。返回 { asar, why, fatal, leftovers }。
 *
 * - 命令行点名了路径 → 只在它在的时候可校验，不在就是**失败**（不是跳过）。
 * - 只在 `RELEASE_DIR` 下自动找；找不到不判失败，但**成功信息必须缩口径**。
 */
function locateAsar() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (arg) {
    if (fs.existsSync(arg)) return { asar: arg, why: `命令行指定：${arg}` };
    return { asar: null, why: `命令行指定的 asar 不存在：${arg}`, fatal: true };
  }
  if (!fs.existsSync(RELEASE_DIR)) {
    return { asar: null, why: `${path.relative(ROOT, RELEASE_DIR) || RELEASE_DIR}/ 不存在（本机没打过包）` };
  }
  const dirs = fs
    .readdirSync(RELEASE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const d of dirs) {
    const p = path.join(RELEASE_DIR, d, "resources", "app.asar");
    if (fs.existsSync(p)) return { asar: p, why: `${d}/resources/app.asar`, found: [d] };
  }
  const leftovers = dirs;
  const interrupted = dirs.filter((d) => d.endsWith(".tmp"));
  return {
    asar: null,
    leftovers,
    interrupted,
    why:
      leftovers.length === 0
        ? `${path.relative(ROOT, RELEASE_DIR) || RELEASE_DIR}/ 是空的`
        : `${path.relative(ROOT, RELEASE_DIR) || RELEASE_DIR}/ 下有 ${leftovers.join("、")}，` +
          `但没有任何 resources/app.asar` +
          (interrupted.length ? `（${interrupted.join("、")} 是**中断的打包残留** —— electron-builder 只在成功时才把 .tmp 改名）` : ""),
  };
}

function listAsar(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const size = head.readUInt32LE(12);
    if (size <= 0 || 16 + size > fs.statSync(asarPath).size) {
      throw new Error(`asar 头部长度字段不可信（size=${size}）—— 文件被截断或不是 asar`);
    }
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 16);
    const json = JSON.parse(buf.toString("utf-8").replace(/\0+$/, ""));
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

const found = locateAsar();
let evidenceRan = false;
if (found.asar) {
  evidenceRan = true;
  try {
    const { top, files: packed } = listAsar(found.asar);
    // 自证：头部解析出来是空的，说明读到的东西不可信，不能拿它下「都在包里」的结论
    if (packed.length === 0) {
      fails.push(`${found.why} 的 asar 头部里一个文件都没解析出来 —— 解析不可信，实证层的结论作废`);
    } else {
      const packedSet = new Set(packed);
      const missing = required.filter((rel) => !packedSet.has("/" + rel));
      if (missing.length) {
        fails.push(
          `${found.why} 里缺 ${missing.length} 个运行期资源：` +
            `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}\n` +
            `    包内顶层 = ${top.join(", ")}`
        );
      } else {
        notes.push(`实证层通过：${required.length} 个运行期资源都在 ${found.why} 里（顶层 ${top.join(", ")}）`);
      }
    }
  } catch (e) {
    fails.push(`读不了 ${found.why}：${e && e.message ? e.message : e}`);
  }
} else {
  if (found.fatal) {
    fails.push(found.why);
  } else {
    notes.push(`实证层**未运行**：${found.why}`);
    notes.push("  → 静态层只回答「下一次打包会不会漏」，不能替代对某个具体包的检查；要实证请跑 npx electron-builder --win dir");
  }
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
// 成功信息按**实际跑过的层**缩口径：实证层没跑就不许说「打包内容校验通过」
console.log(
  evidenceRan
    ? `\n打包内容校验通过：${required.length} 个运行期资源都被 build.files 覆盖，且都在包里`
    : `\n静态层校验通过：${required.length} 个运行期资源都被 build.files 覆盖（实证层未运行，没有可校验的包）`
);
