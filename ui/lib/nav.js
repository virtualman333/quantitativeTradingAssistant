/**
 * nav.js —— 页签共享状态 + 独立窗口
 *
 * 独立窗口：主进程 win:open 新开一个 Electron 窗口，加载同一套 UI，
 * 靠 URL hash 路由（#/win/kline?instId=BTC-USDT-SWAP）告诉它渲染什么。
 * 好处是窗口内 api（行情 / 报告）都能直接用，不必把数据传过去。
 * 没有主进程桥接时（浏览器里跑 Vite dev）自动回退成页内全屏弹窗。
 */
import { ref, computed } from "vue";
import { api, hasBridge } from "./api.js";

export const tab = ref("dash");

/** 跳到某个页签（key 与 App.vue 的 tabs 对应） */
export function goTab(k) {
  tab.value = k;
}

/** 解析 #/win/<kind>?<params> → { kind, params }；不是窗口路由返回 null */
function parseRoute(hash) {
  const m = /^#\/win\/([a-z]+)\??(.*)$/i.exec(hash || "");
  if (!m) return null;
  const params = {};
  for (const [k, v] of new URLSearchParams(m[2])) params[k] = v;
  return { kind: m[1].toLowerCase(), params };
}

const route = ref(parseRoute(location.hash));
/** 当前窗口要渲染的独立窗口路由（null = 主界面） */
export const winRoute = computed(() => route.value);
// 主进程复用窗口时只改 hash（同文档导航），这里跟着更新路由
window.addEventListener("hashchange", () => {
  route.value = parseRoute(location.hash);
});

/** 无主进程桥接 / 开窗失败时的回退：在页内弹窗里渲染同一个窗口组件 */
export const fallbackWin = ref(null);
export function closeFallbackWin() {
  fallbackWin.value = null;
}

/**
 * 开独立窗口。
 * @param {{kind:string, params?:object, title?:string, width?:number, height?:number, key?:string}} spec
 *        key 决定复用：同一个 key 已开窗口会被聚焦并切到新内容（默认 kind+参数）。
 */
export async function openWin(spec) {
  const params = spec.params || {};
  const qs = new URLSearchParams(params).toString();
  const hash = `#/win/${spec.kind}${qs ? "?" + qs : ""}`;
  const full = { ...spec, params, hash };
  if (!hasBridge) {
    fallbackWin.value = full; // 浏览器里没有 Electron，退化为页内弹窗
    return { ok: true, fallback: true };
  }
  try {
    const r = await api.winOpen({
      kind: spec.kind,
      hash,
      title: spec.title || "OKX 交易 Agent",
      width: spec.width,
      height: spec.height,
      key: spec.key || `${spec.kind}:${qs}`,
    });
    if (!r?.ok) fallbackWin.value = full; // 开窗失败也要能看到内容
    return r;
  } catch (e) {
    fallbackWin.value = full;
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 关掉当前独立窗口（子窗口 / 页内弹窗都走这里） */
export function closeWin() {
  if (winRoute.value && hasBridge) return api.winClose();
  closeFallbackWin();
}

/** K 线独立窗口（按标的复用：同标的再点一次会聚焦已开的那个） */
export function openKlineWin(instId, bar = "15m") {
  return openWin({
    kind: "kline",
    params: { instId, bar },
    title: `K 线 · ${instId}`,
    width: 1180,
    height: 820,
    key: `kline:${instId}`,
  });
}

/** 报告 / 文档独立窗口（按文件路径复用） */
export function openDocWin(path, label = "") {
  return openWin({
    kind: "doc",
    params: { path },
    title: label || "报告",
    width: 1040,
    height: 860,
    key: `doc:${path}`,
  });
}
