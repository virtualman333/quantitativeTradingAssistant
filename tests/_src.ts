/**
 * tests/_src.ts —— 测试共用工具（不是测试文件，`tests/**\/*.test.ts` 的 glob 不会执行它）
 *
 * 存在的理由：读源码做结构断言这件事在多个 .test.ts 里都要用，而
 * `stripComments()` 这种辅助一旦各写一份，就会出现「一处修好、另一处还按旧语义判」
 * —— 那正是本仓反复踩的「同一件事两遍」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 读仓库内文件（相对仓库根） */
export const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * 「剥注释这个辅助真的在剥」的两向自证。
 *
 * 只判「剥过之后找不到那段注释」是**恒真**的：那段注释被删掉（或者当初就抄错了字）时，
 * 断言照样绿 —— 而这条自证存在的唯一意义，就是证明后面的源码形态断言不是在一片
 * 未剥的原文里做的。实测本仓两处自证都退化成这样：
 *
 *   - `monthguard.test.ts` 用的标记 `"无人值守的独立循环，此前这条路径上连一次判断都没有"`
 *     在 `src/scalper.ts` 里出现 **0 次**（原文那里隔着一个换行，抄的时候就并成了一行）；
 *   - `scalperguard.test.ts` 的标记确实在原文里，但断言只看了一半。
 *
 * 所以两向都要判：**原文里有**（对照面存在）+ **剥过之后没有**（真在剥）。
 */
export function assertCommentStripped(raw: string, stripped: string, marker: string, where: string): void {
  assert.ok(
    raw.includes(marker),
    `${where}：原文里没有那段注释可作为对照面（${marker.slice(0, 20)}…）—— 这条自证已退化成恒真`
  );
  assert.ok(
    !stripped.includes(marker),
    `${where}：注释没被剥掉 —— 后面的源码形态断言是在未剥的原文上做的，会失真`
  );
}

/**
 * 剥掉注释后再做源码断言。
 * 教训（连续多轮踩到）：在被测文件里写「旧实现长这样」的注释，会让
 * `source.includes("旧代码片段")` 这类断言命中注释而不是真代码 —— 该红的红不了、
 * 不该红的红。所以凡是对源码形态的断言，先剥注释。
 *
 * 注意：不剥字符串字面量内容（那需要 AST），所以断言不要锚在「只可能出现在字符串里」的片段上。
 *
 * ── 为什么从「认引号 + 认 // 和 /*」升级成真的状态机 ────────────────────────
 * 旧实现只认「代码 / 引号 / 反引号」三种状态，遇到**正则字面量**会失步：
 * 本仓的真例子 `src/tools/web.ts` 里 `[...html.matchAll(/<a[^>]+href="(\/\/du…/)]`
 * —— 正则里的那个 `"` 被当成字符串开头，于是后面直到下一个 `"` 之间的代码全被
 * 当成「字符串内容」照抄、而**行注释漏成了代码**；等它再撞上第二个引号时状态已经
 * 错位，后半段代码被整段吃掉。
 *
 * 这不是「锁松一点」，而是**锁对着一段缺斤少两的源码判绿**：`includes` 式的断言
 * 在被吃掉的那一段里永远不成立（反向断言则永远成立）。实测拿 TypeScript 官方解析器
 * 逐字符对账，78 个文件里 47 个不一致、其中 7 个是真失步（不是行尾 `\r` 那种）。
 *
 * 所以现在按六种状态扫描：代码 / 单引号 / 双引号 / 模板串 / 正则 / 注释。
 * 模板串的 `${…}` 按代码扫描（花括号计深度，嵌套模板因此天然对得上）。
 *
 * 另一条被对账逼出来的：**行注释不能连行尾的 `\r` 一起吃掉**。旧实现只认 `\n` 收尾，
 * 于是每个 LF→CRLF 文件里每条行注释都少一个 `\r`，剥完的文本与源码不再逐字节对应
 * —— 而「逐字节对应」正是能拿官方解析器当尺子的前提。这一条实测影响 40 个文件。
 *
 * 真值由 `tsStripProblems()` 对账（`tests/sourcelock.test.ts` 全仓跑），不再由这份
 * 启发式自己说了算。
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let mode: "code" | "squote" | "dquote" | "template" = "code";
  /* 模板串里每个还开着的 `${` 中已经攒了几层 `{}`。模板正文与 `${…}` 里的代码
     共用这一个栈：进 `${` 压一个 0，退到 0 就回到模板正文。 */
  const braces: number[] = [];

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (mode === "template") {
      if (c === "\\") {
        out += c + (d ?? "");
        i += 2;
        continue;
      }
      if (c === "`") {
        out += c;
        i += 1;
        mode = "code";
        continue;
      }
      if (c === "$" && d === "{") {
        braces.push(0);
        out += "${";
        i += 2;
        mode = "code";
        continue;
      }
      out += c;
      i += 1;
      continue;
    }

    if (mode === "squote" || mode === "dquote") {
      if (c === "\\") {
        out += c + (d ?? "");
        i += 2;
        continue;
      }
      out += c;
      i += 1;
      if (c === (mode === "squote" ? "'" : '"')) mode = "code";
      continue;
    }

    // ---------------------------------- code ----------------------------------

    /* 块注释：整段丢弃（`*/` 里的换行也丢，行数会变 —— 断言不要依赖行号）。
       顺序要紧：`//`、`/*` 必须在正则之前判 —— `//` 永远不是正则（空正则非法）。 */
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    /* 行注释：丢到行尾，**保留行尾符**（`\r` 也是）。
       只认 `\n` 的写法会把 CRLF 里的 `\r` 一起吃掉，见函数头那段。 */
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i += 1;
      continue;
    }

    // 正则字面量：整段照抄（内部的反引号 / 引号不是字符串定界符）
    if (c === "/" && regexAllowed(out)) {
      const end = regexEnd(src, i);
      if (end !== -1) {
        out += src.slice(i, end);
        i = end;
        continue;
      }
      // 本行内没有闭合的 `/` —— 它不可能是正则（是除号），落到下面按普通字符处理
    }

    if (c === '"' || c === "'" || c === "`") {
      mode = c === '"' ? "dquote" : c === "'" ? "squote" : "template";
      out += c;
      i += 1;
      continue;
    }

    // 模板里的 `${…}` 按**代码**扫描，不是「字符串里的普通字符」
    if (braces.length) {
      if (c === "{") braces[braces.length - 1] += 1;
      else if (c === "}") {
        if (braces[braces.length - 1] === 0) {
          braces.pop();
          out += c;
          i += 1;
          mode = "template";
          continue;
        }
        braces[braces.length - 1] -= 1;
      }
    }

    out += c;
    i += 1;
  }

  return out;
}

/**
 * `/` 只可能出现在这些**标点**之后才是正则开头（跟在标识符、数字、`)`、`]`、`"` 之后的一律是除号）。
 *
 * ⚠ 这是一张手工表，所以它**必须自带证据**，否则就是一条谁也验不了的白名单：
 *   - 表里每个字符在 `tests/sourcelock.test.ts` 都有一条活样例（在那个字符后面放一个含 `"`
 *     的正则，输出里那句 `CODE` 必须还在 —— 删掉这一条字符就会红）；
 *   - 反过来「表里多了一条没用的」也会红：同一个循环会断言那个字符**确实**要留在表里。
 */
export const REGEX_AFTER_PUNCT = "(,=:[!&|?{};+-*%^~<>";

/** 这些关键字之后可以紧跟正则：`return /re/`、`typeof /re/`。表内的每一条都要有活样例。 */
export const REGEX_AFTER_WORD: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "case",
  "throw",
]);

/**
 * 已经吐出的内容末尾（跳过空白）看着像不像「正则该出现的地方」。
 *
 * 判错的方向很重要：这里返回 `true` 而实际是除号时，`regexEnd` 多半返回 -1
 * （除号那一行里没有第二个裸 `/`），于是按普通字符处理；反过来返回 `false` 而实际是正则时，
 * 正则里的引号会再次引起失步。两头都不至于像失步那样吞掉整段代码。
 *
 * 关键字前面紧邻 `.` 时它是**属性名**（`obj.of / 2`），后面跟的 `/` 只能是除号 ——
 * 成员表达式本身就能结束一个表达式，正则不可能跟在它后面。
 */
function regexAllowed(out: string): boolean {
  for (let k = out.length - 1; k >= 0; k--) {
    const ch = out[k];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    if (REGEX_AFTER_PUNCT.includes(ch)) return true;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let s = k;
      while (s > 0 && /[A-Za-z0-9_$]/.test(out[s - 1])) s--;
      if (s > 0 && out[s - 1] === ".") return false;
      return REGEX_AFTER_WORD.has(out.slice(s, k + 1));
    }
    return false;
  }
  return true; // 文件开头也是合法位置
}

/**
 * `src[start]` 是 `/`。返回闭合斜杠**之后**的下标（含 flags），不像正则则返回 -1。
 *
 * 三条边界：`[...]` 字符类里的 `/` 不结束正则；`\` 转义跳过两个字符；
 * **换行即判负** —— 正则不可能跨行。最后这条是安全阀：判错最多影响一行，
 * 绝不会像失步那样把文件后半段整段吃掉。
 */
function regexEnd(src: string, start: number): number {
  const n = src.length;
  let j = start + 1;
  if (j >= n) return -1;
  let inClass = false;
  while (j < n) {
    const ch = src[j];
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      j += 1;
      while (j < n && /[a-z]/i.test(src[j])) j++; // flags
      return j;
    }
    j += 1;
  }
  return -1;
}

/**
 * 注释区间 —— 用 **TypeScript 官方解析器**扫一遍（真值，不是第二份启发式）。
 *
 * 建 AST（`setParentNodes: true`，`getChildren` 依赖它），逐节点收集
 * `getLeadingCommentRanges` / `getTrailingCommentRanges`（按起点去重 —— 同一段注释会
 * 同时是上一个节点的尾注释与下一个节点的头注释），**并用 `node.getChildren(sf)` 一路
 * 走到词法记号**：空块里的注释（catch 块里那条「忽略」）与对象字面量同行的尾注释都不挂在
 * 任何语义节点上，只走 `forEachChild` 会漏掉它们。最后补一次文件末尾（尾随注释可能不挂节点）。
 */
export function commentSpansByTs(src: string): Array<[number, number]> {
  const sf = ts.createSourceFile("surface.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const byPos = new Map<number, [number, number]>();
  const add = (list: readonly ts.CommentRange[] | undefined): void => {
    for (const r of list ?? []) byPos.set(r.pos, [r.pos, r.end]);
  };
  const visit = (node: ts.Node): void => {
    add(ts.getLeadingCommentRanges(src, node.getFullStart()));
    add(ts.getTrailingCommentRanges(src, node.getEnd()));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  add(ts.getLeadingCommentRanges(src, src.length));
  return [...byPos.values()].sort((a, b) => a[0] - b[0]);
}

/** 参考实现：删掉 TS 认出来的注释区间，其余**一字不动** */
export function referenceStrip(src: string): string {
  let out = "";
  let at = 0;
  for (const [s, e] of commentSpansByTs(src)) {
    out += src.slice(at, s);
    at = e;
  }
  return out + src.slice(at);
}

/**
 * `stripComments()` 与官方解析器逐字符对账，返回人类可读的差异（空数组 = 一致）。
 *
 * 为什么要逐**字符**而不是「看着差不多」：两个实现删的是同一批区间，除此之外一个字符
 * 都不该变。行尾 `\r` 那种 1 字节的偏差就是这么被抓出来的（实测 40 个文件）。
 */
export function tsStripProblems(src: string): string[] {
  const mine = stripComments(src);
  const ref = referenceStrip(src);
  if (mine === ref) return [];
  let k = 0;
  while (k < mine.length && k < ref.length && mine[k] === ref[k]) k += 1;
  const line = src.slice(0, k).split("\n").length;
  return [
    `首个差异在第 ${line} 行（offset ${k}）：`,
    `  源码 ${JSON.stringify(src.slice(Math.max(0, k - 40), k + 50))}`,
    `  实现 ${JSON.stringify(mine.slice(Math.max(0, k - 20), k + 45))}`,
    `  真值 ${JSON.stringify(ref.slice(Math.max(0, k - 20), k + 45))}`,
    `  长度：实现 ${mine.length} / 真值 ${ref.length}（${
      mine.length < ref.length ? "代码被吃掉" : "注释没剥净或多了东西"
    }）`,
  ];
}

/**
 * 剥掉 Python 的注释**与字符串字面量**（含 docstring）后再做源码断言。
 *
 * 为什么不能只用 `stripComments()`
 * --------------------------------
 * `stripComments()` 只认 `//` 与 `/* *\/`。把它用在 `.py` 上时，Python 的 `#` 注释**不剥**、
 * docstring **不剥** —— 而 docstring 里为了说明「以前是这么写的」几乎必然会写出那段旧代码。
 * 实测三处结构锁就是这样变成恒真的：
 *
 *   - `archive_round.py` 的模块 docstring 里写着「**读**走 `jsonstore.read_json_state()`」，
 *     于是断言 `src.includes("jsonstore.read_json_state(")` 由**散文**满足；
 *   - `month_risk.py` 的 `_quarantine_broken_state` docstring 里带着
 *     `jsonstore.quarantine_broken()`（还带括号），同样满足；
 *   - 于是把真正的调用改回 `json.loads(open(...).read())`，两条断言照样绿。
 *
 * 这不是「注释里恰好写了」，而是**必然会写**：这三条锁的判据本来就该在代码里，
 * 说明文字天然要引用它。所以判据必须是「**代码里**有」，不是「文件里有」。
 *
 * 默认（即 `stripPythonStrings()`）把字符串内容一律换成 `""`，但**保留字面量内部的换行**，
 * 免得把行号挤在一起（本仓有几处按行切片的断言）。前缀字母（`r` / `b` / `f` / `u` 及其组合）
 * 跟着一起去掉。**要看「字符串字面量本身」的锁（如工具名对账）必须传
 * `stripPythonCode(src, { dropStrings: false })`** —— 用默认档会把判据的两个操作数一起吃掉。
 */
export interface PyStripOpts {
  /** 普通字符串（`"…"` / `'…'`）的内容是否抹成 `""`。默认 `true`。 */
  dropStrings?: boolean;
  /** 三引号块（本仓一律当 docstring / 散文用）是否抹掉。默认 `true`。 */
  dropDocstrings?: boolean;
}

/**
 * 剥掉 Python 的注释与字符串后再做源码断言 —— **只有这一份实现**。
 *
 * `dropStrings` / `dropDocstrings` 两个开关是给两种真实诉求准备的，缺一不可：
 *
 *   - 默认（两个都 true，即 `stripPythonStrings()`）：只留下标识符与调用形态。
 *     用来钉「真调用还在不在」—— docstring 里引用的旧实现必须被剥掉。
 *   - `{ dropStrings: false }`：**保留字符串字面量**。`mcplive.test.ts` 的工具名对账
 *     靠的正是 `["--tool", "name"]` 这种字符串对；把字符串抹成 `""` 之后那条正则
 *     再也匹配不到任何东西 —— 一条永远抓不到东西的锁。实测两种剥法在
 *     `scripts/news_fetch.py` 上抓到的工具名是 `[news_get_latest]` 与 `[]`。
 *
 * `#` 注释与三引号块**永远**剥（它们不可能是判据载体）。
 */
export function stripPythonCode(src: string, opts: PyStripOpts = {}): string {
  const dropStrings = opts.dropStrings ?? true;
  const dropDocstrings = opts.dropDocstrings ?? true;
  //: Python 字符串前缀字母（`r""` / `rb''` / `f""` …）
  const PREFIX = /[rRbBuUfF]/;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "#") {
      /* 丢到行尾但**保留行尾符** —— 与 `stripComments()` 同一条约定。
         `\r` 也一起吃掉的写法会让剥完的文本与源码不再逐字节对应（本仓 .py 大量是 CRLF），
         而「逐字节对应」正是能拿 CPython `tokenize` 当尺子的前提。 */
      while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.slice(i, i + 3) === c.repeat(3);
      const width = triple ? 3 : 1;
      // 三引号块在本仓一律是 docstring / 散文；普通字符串按调用方要求
      const blank = triple ? dropDocstrings || dropStrings : dropStrings;
      if (blank) {
        // 前缀字母属于这个字面量，一起抹掉（前面的字符不是标识符字符时才可能是前缀）
        let cut = out.length;
        while (cut > 0 && PREFIX.test(out[cut - 1])) cut--;
        if (cut < out.length && (cut === 0 || !/[A-Za-z0-9_]/.test(out[cut - 1]))) {
          out = out.slice(0, cut);
        }
        i += width;
        while (i < src.length) {
          const d = src[i];
          if (d === "\\") {
            i += 2;
            continue;
          }
          if (d === "\n") {
            out += "\n"; // 保留行结构，别把行号挤在一起
            i++;
            continue;
          }
          if (triple ? src.slice(i, i + 3) === c.repeat(3) : d === c) {
            i += width;
            break;
          }
          i++;
        }
        out += '""';
        continue;
      }
      // 保留态：整段照抄（含定界符与内容）
      const start = i;
      i += width;
      while (i < src.length) {
        const d = src[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (triple ? src.slice(i, i + 3) === c.repeat(3) : d === c) {
          i += width;
          break;
        }
        i++;
      }
      out += src.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 旧入口：剥掉全部字符串内容（含 docstring）。名字保留，免得既有的调用点一起改。 */
export function stripPythonStrings(src: string): string {
  return stripPythonCode(src);
}

/** 递归收集目录下所有匹配后缀的文件（相对路径，正斜杠） */
export function walk(dir: string, ext = ".ts"): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        rec(rel);
      } else if (e.name.endsWith(ext)) {
        out.push(rel);
      }
    }
  };
  rec(dir);
  return out;
}
