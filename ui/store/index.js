/**
 * store/index.js —— 全局状态（模块级单例，组件直接 import，不再层层 provide/inject）
 *
 * 约定：所有写操作都必须能被上层感知成败，这里只负责取数与状态，
 * 提示统一交给 lib/feedback.js。
 */
import { reactive, ref, computed } from "vue";
import { api, hasBridge, errText } from "../lib/api.js";
import { toastErr } from "../lib/feedback.js";

// ── 配置数据 ────────────────────────────────────────────────
export const store = reactive({
  models: [],
  roles: [],
  mcps: [],
  skills: [],
  settings: null,
  tools: [],
});

// ── 运行状态 ────────────────────────────────────────────────
export const status = reactive({
  runtime: null,
  latestRound: null,
  pending: [],
  agentRunning: false,
  busy: false,
  lastRefreshAt: 0,
});

export const logs = ref([]);
export const globalError = ref(hasBridge ? "" : "未连接到主进程（window.api 缺失），界面只能浏览，所有操作不可用。");

export const currentModel = computed(() => {
  const id = store.settings?.defaultModelId;
  return store.models.find((m) => m.id === id) || null;
});
export const isMockModel = computed(() => currentModel.value?.provider === "mock");

// ── 取数 ────────────────────────────────────────────────────
export async function loadAll() {
  try {
    const [models, roles, mcps, skills, settings] = await Promise.all([
      api.modelsList().catch(() => []),
      api.rolesList().catch(() => []),
      api.mcpList().catch(() => []),
      api.skillsList().catch(() => []),
      api.settingsGet(),
    ]);
    store.models = models || [];
    store.roles = roles || [];
    store.mcps = mcps || [];
    store.skills = skills || [];
    store.settings = settings || null;
    globalError.value = hasBridge ? "" : globalError.value;
    return true;
  } catch (e) {
    globalError.value = errText(e);
    console.error("[store] loadAll", e);
    return false;
  }
}

export async function loadTools() {
  try {
    store.tools = (await api.toolsList()) || [];
  } catch {
    store.tools = [];
  }
}

export async function refreshStatus() {
  try {
    const s = await api.getStatus();
    if (!s) return;
    status.runtime = s.runtime ?? null;
    status.latestRound = s.latestRound ?? null;
    status.pending = s.pending || [];
    status.agentRunning = !!s.agentRunning;
    status.lastRefreshAt = Date.now();
  } catch {
    /* 轮询失败不打断界面 */
  }
}

export function pushLog(line) {
  logs.value.push(line);
  if (logs.value.length > 2000) logs.value = logs.value.slice(-2000);
}

// ── agent 控制 ──────────────────────────────────────────────
export async function startAgent() {
  try {
    const r = await api.startAgent();
    if (r && r.ok === false) return toastErr(new Error(r.msg || "启动失败"), "启动失败");
    await refreshStatus();
  } catch (e) {
    toastErr(e, "启动失败");
    await refreshStatus();
  }
}

export async function stopAgent() {
  try {
    const r = await api.stopAgent();
    if (r && r.ok === false) return toastErr(new Error(r.msg || "停止失败"), "停止失败");
    await refreshStatus();
  } catch (e) {
    toastErr(e, "停止失败");
  }
}

export async function runOnce() {
  if (status.busy) return;
  status.busy = true;
  try {
    const r = await api.runOnce();
    if (r && r.ok === false) toastErr(new Error(`退出码 ${r.code ?? "?"}`), "跑一轮失败");
    await loadAll();
    await refreshStatus();
  } catch (e) {
    toastErr(e, "跑一轮失败");
  } finally {
    status.busy = false;
  }
}

// ── 初始化 / 清理 ───────────────────────────────────────────
let timer = null;
const cleanups = [];

export async function initApp() {
  if (!hasBridge) return () => {};
  // 幂等：先解绑再重新注册。否则「重试」按钮会叠加监听器，
  // 表现为日志重复刷、状态轮询加倍。
  dispose();

  const ok = await loadAll();
  if (!ok) {
    // 数据没拿到也要继续：日志与状态仍可用，界面顶部会显示错误
    console.warn("[store] loadAll 失败");
  }
  await loadTools();
  try {
    const init = (await api.getLogs()) || [];
    init.forEach(pushLog);
  } catch {
    /* ignore */
  }

  const offLog = api.onLog(pushLog);
  const offStatus = api.onStatus(() => refreshStatus());
  if (typeof offLog === "function") cleanups.push(offLog);
  if (typeof offStatus === "function") cleanups.push(offStatus);

  await refreshStatus();
  timer = setInterval(() => {
    // 页面不可见时不轮询，省资源
    if (document.visibilityState === "visible") refreshStatus();
  }, 8000);

  return dispose;
}

export function dispose() {
  if (timer) clearInterval(timer);
  timer = null;
  while (cleanups.length) {
    try {
      cleanups.pop()();
    } catch {
      /* ignore */
    }
  }
}

/** 供子组件在数据变更后调用 */
export async function reload() {
  await loadAll();
}
