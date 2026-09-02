/**
 * postbuild.mjs —— 编译后处理
 *
 * 为什么必须有这一步：
 *   Electron 的 preload 在渲染进程沙箱里按 CommonJS 加载，不支持 ESM 语法。
 *   但项目 package.json 是 "type": "module"，若不额外声明，dist/preload/*.js
 *   会被当成 ESM，preload 加载失败 → 界面拿不到 window.api，所有操作静默失效
 *   （表现就是「点了没反应 / 保存没反应」）。
 *
 *   反过来主进程（dist/electron/main.js）必须是 ESM：它用 `await import("file://...")`
 *   动态加载 dist/src 里的模块，而 CJS 的 require 解析不了 file:// URL。
 *   所以只给 preload 目录加 commonjs 标记，主进程沿用根包的 type:module。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// preload -> CommonJS
const pre = path.join(root, "dist", "preload");
fs.mkdirSync(pre, { recursive: true });
fs.writeFileSync(
  path.join(pre, "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`
);
console.log("[postbuild] dist/preload/package.json -> commonjs");

// 清理历史遗留：早期版本把 dist/electron 标成 commonjs，会让主进程退化成 CJS
const legacy = path.join(root, "dist", "electron", "package.json");
if (fs.existsSync(legacy)) {
  const txt = fs.readFileSync(legacy, "utf8");
  if (txt.includes("commonjs")) {
    fs.rmSync(legacy, { force: true });
    console.log("[postbuild] removed legacy dist/electron/package.json (commonjs)");
  }
}
