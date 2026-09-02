/**
 * tools/fs.ts —— 文件读写与检索
 * 全部经 resolveSafe 限制在仓库根内（见 paths.ts）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Tool } from "./types.js";
import { resolveSafe, relOf, PROJECT_ROOT } from "./paths.js";

const MAX_READ_BYTES = 200_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "release", ".venv", "__pycache__", "data", "logs", "state"]);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|py|md|json|yml|yaml|toml|ini|txt|csv|sh|ps1|bat|env\.sample)$/i;

export const readFileTool: Tool = {
  name: "read_file",
  description: "读取仓库内文本文件，返回带行号内容（可用 offset/limit 读片段）。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对仓库根的路径，如 agent/src/main.ts" },
      offset: { type: "number", description: "起始行（1 基，可空）" },
      limit: { type: "number", description: "读取行数（可空）" },
    },
    required: ["path"],
  },
  run: async (a) => {
    const abs = resolveSafe(a.path, { mustExist: true });
    const txt = fs.readFileSync(abs, "utf8").slice(0, MAX_READ_BYTES);
    const lines = txt.split(/\r?\n/);
    const start = Math.max(1, Number(a.offset) || 1);
    const end = a.limit ? Math.min(lines.length, start - 1 + Number(a.limit)) : lines.length;
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(5)}| ${l}`)
      .join("\n");
    return { ok: true, output: `${relOf(abs)}（${start}-${end} / 共 ${lines.length} 行）\n${body}` };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "写入文本文件（默认覆盖，append=true 追加）。目录不存在会自动创建。",
  danger: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对仓库根的路径" },
      content: { type: "string", description: "文件内容" },
      append: { type: "boolean", description: "true=追加，默认覆盖" },
    },
    required: ["path", "content"],
  },
  run: async (a, ctx) => {
    const abs = resolveSafe(a.path);
    const content = String(a.content ?? "");
    const preview = content.length > 300 ? content.slice(0, 300) + "\n…（截断显示）" : content;
    const ok = (await ctx.confirm?.({
      id: `write:${abs}`,
      title: "写入文件",
      message: `即将${a.append ? "追加到" : "覆盖"} ${relOf(abs)}\n\n${preview}`,
    })) ?? false;
    if (!ok) return { ok: false, output: "", error: "用户取消写入" };

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (a.append) fs.appendFileSync(abs, content, "utf8");
    else fs.writeFileSync(abs, content, "utf8");
    return { ok: true, output: `已${a.append ? "追加" : "写入"} ${relOf(abs)}（${content.length} 字符）` };
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description: "列出目录内容（类型与大小），用于定位文件。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对仓库根的目录，默认仓库根" },
      recursive: { type: "boolean", description: "是否递归（默认 false，深度上限 3）" },
    },
    required: [],
  },
  run: async (a) => {
    const abs = resolveSafe(a.path || PROJECT_ROOT, { allowDir: true, mustExist: true });
    const recursive = !!a.recursive;
    const out: string[] = [];

    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries = entries
        .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
        .sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1));
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = relOf(full);
        if (e.isDirectory()) {
          out.push(`${rel}/`);
          if (recursive) walk(full, depth + 1);
        } else {
          let size = 0;
          try {
            size = fs.statSync(full).size;
          } catch {
            /* ignore */
          }
          out.push(`${rel}  ${size}B`);
        }
        if (out.length > 400) return;
      }
    };
    walk(abs, 1);
    return { ok: true, output: out.slice(0, 400).join("\n") || "（空目录）" };
  },
};

export const searchFilesTool: Tool = {
  name: "search_files",
  description: "在仓库内按内容搜索（正则或纯文本），返回命中文件、行号与上下文。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "搜索内容，支持正则" },
      path: { type: "string", description: "起始目录，默认 agent/ 源码区" },
      ext: { type: "string", description: "限定扩展名，逗号分隔，如 ts,vue,py" },
      maxResults: { type: "number", description: "最多命中条数，默认 40" },
    },
    required: ["pattern"],
  },
  run: async (a) => {
    const pattern = String(a.pattern ?? "");
    if (!pattern) return { ok: false, output: "", error: "pattern 为空" };
    let re: RegExp;
    try {
      re = new RegExp(pattern, "gi");
    } catch (e) {
      return { ok: false, output: "", error: `正则非法：${String(e)}` };
    }
    const root = resolveSafe(a.path || path.join("agent", "src"), { allowDir: true, mustExist: true });
    const exts = String(a.ext || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const max = Math.min(200, Math.max(1, Number(a.maxResults) || 40));

    const hits: string[] = [];
    let scanned = 0;

    const walk = (dir: string, depth: number) => {
      if (hits.length >= max || depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= max) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
          continue;
        }
        if (exts.length ? !exts.includes(path.extname(e.name).slice(1).toLowerCase()) : !TEXT_EXT.test(e.name)) continue;
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        if (size > 1_000_000) continue;
        scanned++;
        let txt = "";
        try {
          txt = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const lines = txt.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < max; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) hits.push(`${relOf(full)}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
        }
      }
    };
    walk(root, 1);
    return {
      ok: true,
      output: hits.length
        ? `命中 ${hits.length} 条（扫描 ${scanned} 个文件）\n${hits.join("\n")}`
        : `无命中（扫描 ${scanned} 个文件）`,
    };
  },
};

export const fsTools: Tool[] = [readFileTool, writeFileTool, listDirTool, searchFilesTool];
