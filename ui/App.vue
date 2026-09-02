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

const tab = ref("dash");
const tabs = [
  { k: "dash", t: "总览" },
  { k: "chat", t: "对话" },
  { k: "models", t: "模型" },
  { k: "roles", t: "角色" },
  { k: "mcp", t: "MCP" },
  { k: "skills", t: "Skill" },
  { k: "log", t: "日志" },
  { k: "cfg", t: "设置" },
];
const views = {
  dash: DashboardView, chat: ChatView, models: ModelsView, roles: RolesView,
  mcp: McpView, skills: SkillsView, log: LogView, cfg: SettingsView,
};
const currentView = computed(() => views[tab.value] || DashboardView);

onMounted(async () => {
  await initApp();
});
onBeforeUnmount(dispose);
</script>

<template>
  <header class="hd">
    <h1>OKX 交易 Agent</h1>
    <span :class="['badge', status.agentRunning ? 'run' : 'stop']">
      {{ status.agentRunning ? '运行中' : '未运行' }}
    </span>
    <span class="hint" v-if="currentModel">模型：{{ currentModel.name }}</span>
    <span class="spacer"></span>
    <button :disabled="status.busy" @click="runOnce">
      {{ status.busy ? '运行中…' : '跑一轮' }}
    </button>
    <button class="primary" :disabled="status.agentRunning" @click="startAgent">启动服务</button>
    <button class="danger" :disabled="!status.agentRunning" @click="stopAgent">停止</button>
  </header>

  <nav class="tabs">
    <div v-for="t in tabs" :key="t.k"
         :class="['tab', tab === t.k && 'active']"
         @click="tab = t.k">{{ t.t }}</div>
  </nav>

  <main>
    <div v-if="globalError" class="alert err">
      ⚠ {{ globalError }}
      <button class="sm" style="margin-left:8px" @click="initApp()">重试</button>
    </div>
    <div v-if="isMockModel" class="alert">
      当前默认模型为 <b>mock</b>，不会真实调用。到「模型」页添加 API Key 并设为默认。
    </div>
    <div v-if="status.pending.length" class="alert">
      ⏸ {{ status.pending.length }} 笔决策等待人工确认：{{ status.pending.join('、') }}
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
