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
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += c + (n ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
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
 * 字符串内容一律换成 `""`，但**保留字面量内部的换行**，免得把行号挤在一起
 * （本仓有几处按行切片的断言）。前缀字母（`r` / `b` / `f` / `u` 及其组合）跟着一起去掉。
 */
export function stripPythonStrings(src: string): string {
  //: Python 字符串前缀字母（`r""` / `rb''` / `f""` …）
  const PREFIX = /[rRbBuUfF]/;
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.slice(i, i + 3) === c.repeat(3);
      const width = triple ? 3 : 1;
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
    out += c;
    i++;
  }
  return out;
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
