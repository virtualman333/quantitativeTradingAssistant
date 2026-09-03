/**
 * api.js —— 主进程桥接（preload 注入的 window.api）
 *
 * 关键点：没有桥接时不能让界面静默失败。
 * 以前 window.api 为 undefined 时，任何操作都变成「点了没反应」，
 * 这里显式抛错，由上层统一提示。
 *
 * ⚠ IPC 克隆坑（在渲染进程侧修，preload 的 safeInvoke 修不到）：
 * contextBridge 把参数从渲染进程(main world) 传到 preload(isolated world) 时就用
 * structuredClone，Vue reactive/ref 的 Proxy 会抛 "An object could not be cloned"，
 * 且这个错误发生在参数进入 preload 之前 —— preload 里的 safeInvoke 拍平根本来不及。
 * 所以必须在渲染进程侧（调用 window.api 之前）把参数 JSON 拍成纯对象。
 */
const MISSING_MSG = "未连接到主进程（window.api 缺失）。请执行 npm run build 后用 npm run ui 启动界面。";

const missing = new Proxy(
  {},
  {
    get: () => () => Promise.reject(new Error(MISSING_MSG)),
  }
);

export const hasBridge = typeof window !== "undefined" && !!window.api;

/** 参数拍平：undefined/函数原样返回；对象 JSON 往返成纯对象（失败则原样） */
function flatten(a) {
  if (a === undefined || typeof a === "function") return a;
  try {
    return JSON.parse(JSON.stringify(a));
  } catch {
    return a;
  }
}

/**
 * 统一包装：所有 api 方法在渲染进程侧先拍平参数，再交给 contextBridge。
 *
 * ⚠ 不能用 Proxy 直接包 window.api：contextBridge 暴露的对象是冻结的
 * （每个方法都是只读、不可配置的数据属性）。Proxy 的 get 若返回一个
 * 不同于原始值的新函数，会违反 JS Proxy 不变量，V8 抛
 * `'get' on proxy: property 'xxx' is a read-only and non-configurable data property`。
 * 所以这里显式枚举方法名，把包装后的方法挂到一个**全新的普通对象**上
 * （不是冻结对象的 Proxy），从根本上避开不变量检查。
 */
function buildApi(source) {
  const out = {};
  for (const key of Object.getOwnPropertyNames(source)) {
    const v = source[key];
    out[key] = typeof v === "function" ? (...args) => v(...args.map(flatten)) : v;
  }
  return out;
}

export const api = hasBridge ? buildApi(window.api) : missing;

/** 统一取错误信息 */
export function errText(e) {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  return String(e.message || e);
}
