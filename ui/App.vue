<script setup>
/**
 * App.vue —— 根组件：页签 + 全局提示 + 各业务视图
 * 视图用 KeepAlive 缓存，切换页签不丢状态（对话、滚动位置、未提交的编辑）。
 *
 * 两种形态（由 URL hash 决定）：
 *   - 主界面：header + 页签 + 视图
 *   - 独立窗口（#/win/kline?instId=xxx）：只渲染一个 WinFrame，K 线 / 报告等
 */
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import {
  store, status, globalError, currentModel, isMockModel,
  initApp, dispose, startAgent, stopAgent, runOnce,
} from "./store/index.js";
import { toasts } from "./lib/feedback.js";
import { confirmBox, answerConfirm } from "./lib/feedback.js";

import DashboardView from "./components/DashboardView.vue";
import ChatView from "./components/ChatView.vue";
import ModelsView from "./components/ModelsView.vue";
import RolesView from "./components/RolesView.vue";
import McpView from "./components/McpView.vue";
import SkillsView from "./components/SkillsView.vue";
import LogView from "./components/LogView.vue";
import SettingsView from "./components/SettingsView.vue";
import PositionsView from "./components/PositionsView.vue";
import ScalperView from "./components/ScalperView.vue";
import TraceView from "./components/TraceView.vue";
import ReportsView from "./components/ReportsView.vue";
import MarketView from "./components/MarketView.vue";
import WinFrame from "./components/WinFrame.vue";
import { tab, winRoute, fallbackWin, closeFallbackWin, closeWin } from "./lib/nav.js";

/** 页签图标：内联 SVG，随 currentColor 走主题色，不依赖任何图标字体 */
const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  dash: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  models: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>'),
  roles: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
  mcp: svg('<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>'),
  skills: svg('<polygon points="13 2 3 14 11 14 10 22 21 10 13 10 13 2"/>'),
  log: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
  obs: svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
  cfg: svg('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  pos: svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.3"/><circle cx="3.5" cy="12" r="1.3"/><circle cx="3.5" cy="18" r="1.3"/>'),
  rep: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'),
  mkt: svg('<line x1="3" y1="3" x2="3" y2="21"/><line x1="3" y1="21" x2="21" y2="21"/><polyline points="6 15 10 10 14 13 20 6"/>'),
  scalp: svg('<circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 15"/><line x1="9" y1="2" x2="15" y2="2"/>'),
};

const tabs = [
  { k: "dash", t: "总览" },
  { k: "mkt", t: "行情" },
  { k: "chat", t: "对话" },
  { k: "obs", t: "观测" },
  { k: "models", t: "模型" },
  { k: "roles", t: "角色" },
  { k: "mcp", t: "MCP" },
  { k: "skills", t: "Skill" },
  { k: "log", t: "日志" },
  { k: "rep", t: "报告" },
  { k: "cfg", t: "设置" },
  { k: "pos", t: "持仓" },
  { k: "scalp", t: "超短线" },
];
const views = {
  dash: DashboardView, chat: ChatView, obs: TraceView, models: ModelsView, roles: RolesView,
  mcp: McpView, skills: SkillsView, log: LogView, rep: ReportsView, cfg: SettingsView, pos: PositionsView,
  mkt: MarketView,
  scalp: ScalperView,
};
const currentView = computed(() => views[tab.value] || DashboardView);

// ── 主题：默认浅色，可切深色，localStorage 持久化 ──
const theme = ref("light");
const ICON_MOON = svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>');
const ICON_SUN = svg('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>');
function applyTheme(t) {
  theme.value = t;
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("okx-agent-theme", t); } catch { /* ignore */ }
}
function toggleTheme() {
  applyTheme(theme.value === "light" ? "dark" : "light");
}

/** Esc：页内弹窗直接关，独立窗口交给主进程关掉自己 */
function onKey(e) {
  if (e.key !== "Escape") return;
  if (fallbackWin.value) closeFallbackWin();
  else if (winRoute.value) closeWin();
}

onMounted(async () => {
  // #hash 直达页签（超短线回测独立窗口用 #scalp 打开）
  const h = (location.hash || "").replace(/^#/, "");
  if (h && tabs.some((t) => t.k === h)) tab.value = h;
  // 主题初始化放最前，避免首屏闪色
  let saved = "light";
  try { saved = localStorage.getItem("okx-agent-theme") || "light"; } catch { /* ignore */ }
  applyTheme(saved === "dark" ? "dark" : "light");
  window.addEventListener("keydown", onKey);
  await initApp();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  dispose();
});
</script>

<template>
  <!-- 独立窗口形态：没有 header/页签，只渲染一个窗口组件 -->
  <div v-if="winRoute" class="win-shell">
    <WinFrame :route="winRoute" />
  </div>

  <template v-else>
    <header class="hd">
      <div class="brand">
        <div class="logo">OK</div>
        <h1>OKX 交易 Agent</h1>
      </div>
      <span :class="['badge', status.agentRunning ? 'run' : 'stop']">
        {{ status.agentRunning ? '运行中' : '未运行' }}
      </span>
      <span v-if="currentModel" class="model-chip" :title="currentModel.name">
        <span class="hint">模型</span>{{ currentModel.name }}
      </span>
      <span class="spacer"></span>
      <button class="theme-btn" :title="theme === 'light' ? '切换到深色' : '切换到浅色'" @click="toggleTheme">
        <span class="theme-ico" v-html="theme === 'light' ? ICON_MOON : ICON_SUN"></span>
      </button>
      <button :disabled="status.busy" @click="runOnce">
        {{ status.busy ? '运行中…' : '跑一轮' }}
      </button>
      <div class="btn-group">
        <button class="primary" :disabled="status.agentRunning" @click="startAgent">启动服务</button>
        <button class="danger" :disabled="!status.agentRunning" @click="stopAgent">停止</button>
      </div>
    </header>

    <nav class="tabs">
      <div v-for="t in tabs" :key="t.k"
           :class="['tab', tab === t.k && 'active']"
           @click="tab = t.k">
        <span class="tab-ico" v-html="ICONS[t.k]"></span>{{ t.t }}
      </div>
    </nav>

    <main>
      <div v-if="globalError" class="alert err">
        <span class="spacer">⚠ {{ globalError }}</span>
        <button class="sm" @click="initApp()">重试</button>
      </div>
      <div v-if="isMockModel" class="alert info">
        <span class="spacer">当前默认模型为 <b>mock</b>，不会真实调用。到「模型」页添加 API Key 并设为默认。</span>
        <button class="sm" @click="tab = 'models'">去配置</button>
      </div>
      <div v-if="status.pending.length" class="alert">
        <span class="spacer">
          <span class="tag t-warn">{{ status.pending.length }}</span>
          笔决策等待人工确认：{{ status.pending.join('、') }}
        </span>
      </div>

      <KeepAlive>
        <component :is="currentView" />
      </KeepAlive>
    </main>

    <!-- 全局确认框 -->
    <div v-if="confirmBox.open" class="modal" @click.self="answerConfirm(false)">
      <div class="box" style="width:420px">
        <h3>{{ confirmBox.title }}</h3>
        <div class="body" style="white-space:pre-wrap">{{ confirmBox.message }}</div>
        <div class="foot">
          <button @click="answerConfirm(false)">取消</button>
          <button :class="confirmBox.danger ? 'danger' : 'primary'" @click="answerConfirm(true)">
            {{ confirmBox.confirmText }}
          </button>
        </div>
      </div>
    </div>

    <!-- 全局提示 -->
    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" :class="['toast', t.type]">{{ t.msg }}</div>
    </div>
  </template>

  <!-- 没有主进程桥接（浏览器 dev）时的独立窗口回退：页内全屏弹窗 -->
  <div v-if="fallbackWin" class="modal win-modal" @click.self="closeFallbackWin()">
    <div class="win-modal-box">
      <WinFrame :route="fallbackWin" />
    </div>
  </div>
</template>

<style scoped>
.win-shell { position: fixed; inset: 0; }
.win-modal { z-index: 60; }
.win-modal-box {
  position: relative;
  width: 92vw;
  height: 90vh;
  background: var(--bg);
  border-radius: var(--r);
  overflow: hidden;
  box-shadow: var(--sh-3);
}
</style>
