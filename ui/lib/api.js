/**
 * api.js —— 主进程桥接（preload 注入的 window.api）
 *
 * 关键点：没有桥接时不能让界面静默失败。
 * 以前 window.api 为 undefined 时，任何操作都变成「点了没反应」，
 * 这里显式抛错，由上层统一提示。
 */
const MISSING_MSG = "未连接到主进程（window.api 缺失）。请执行 npm run build 后用 npm run ui 启动界面。";

const missing = new Proxy(
  {},
  {
    get: () => () => Promise.reject(new Error(MISSING_MSG)),
  }
);

export const hasBridge = typeof window !== "undefined" && !!window.api;
export const api = hasBridge ? window.api : missing;

/** 统一取错误信息 */
export function errText(e) {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  return String(e.message || e);
}
