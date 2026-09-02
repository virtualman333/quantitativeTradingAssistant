<script setup>
/**
 * App.vue —— 根组件：页签 + 全局提示 + 各业务视图
 * 视图用 KeepAlive 缓存，切换页签不丢状态（对话、滚动位置、未提交的编辑）。
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
import TraceView from "./components/TraceView.vue";

const tab = ref("dash");

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
};

const tabs = [
  { k: "dash", t: "总览" },
  { k: "chat", t: "对话" },
  { k: "obs", t: "观测" },
  { k: "models", t: "模型" },
  { k: "roles", t: "角色" },
  { k: "mcp", t: "MCP" },
  { k: "skills", t: "Skill" },
  { k: "log", t: "日志" },
  { k: "cfg", t: "设置" },
  { k: "pos", t: "持仓" },
];
const views = {
  dash: DashboardView, chat: ChatView, obs: TraceView, models: ModelsView, roles: RolesView,
  mcp: McpView, skills: SkillsView, log: LogView, cfg: SettingsView, pos: PositionsView,
};
const currentView = computed(() => views[tab.value] || DashboardView);

onMounted(async () => {
  await initApp();
});
onBeforeUnmount(dispose);
</script>

<template>
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
