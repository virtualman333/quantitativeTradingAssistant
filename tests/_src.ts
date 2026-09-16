/**
 * tests/_src.ts —— 测试共用工具（不是测试文件，`tests/**\/*.test.ts` 的 glob 不会执行它）
 *
 * 存在的理由：读源码做结构断言这件事在多个 .test.ts 里都要用，而
 * `stripComments()` 这种辅助一旦各写一份，就会出现「一处修好、另一处还按旧语义判」
 * —— 那正是本仓反复踩的「同一件事两遍」。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 读仓库内文件（相对仓库根） */
export const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

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
