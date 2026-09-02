/**
 * App.js —— 根组件
 * 管理页签、全局数据（模型/角色/MCP/Skill/设置/状态），分发给各子组件。
 */
import { ref, reactive, onMounted, computed, provide } from "../vendor/vue.esm-browser.prod.js";
import Dashboard from "./Dashboard.js";
import ModelsView from "./ModelsView.js";
import RolesView from "./RolesView.js";
import McpView from "./McpView.js";
import SkillsView from "./SkillsView.js";
import LogView from "./LogView.js";
import SettingsView from "./SettingsView.js";

export default {
  name: "App",
  components: { Dashboard, ModelsView, RolesView, McpView, SkillsView, LogView, SettingsView },
  setup() {
    const api = window.api;
    const tab = ref("dash");
    const store = reactive({
      models: [], roles: [], mcps: [], skills: [], settings: null,
    });
    const status = reactive({ runtime: null, latestRound: null, pending: [], agentRunning: false });
    const logs = ref([]);
    const tabs = [
      { k: "dash", t: "总览" }, { k: "models", t: "模型" }, { k: "roles", t: "角色" },
      { k: "mcp", t: "MCP" }, { k: "skills", t: "Skill" }, { k: "log", t: "日志" },
      { k: "cfg", t: "设置" },
    ];

    const currentModel = computed(() => {
      const id = store.settings?.defaultModelId;
      return store.models.find((m) => m.id === id) || null;
    });
    const showMockWarn = computed(() => currentModel.value?.provider === "mock");

    async function loadAll() {
      try {
        store.models = (await api.modelsList()) || [];
        store.roles = (await api.rolesList()) || [];
        store.mcps = (await api.mcpList()) || [];
        store.skills = (await api.skillsList()) || [];
        store.settings = await api.settingsGet();
      } catch (e) {
        console.error("loadAll", e);
      }
    }

    async function refreshStatus() {
      try {
        const s = await api.getStatus();
        status.runtime = s.runtime;
        status.latestRound = s.latestRound;
        status.pending = s.pending || [];
        status.agentRunning = s.agentRunning;
      } catch (e) {
        console.error("refreshStatus", e);
      }
    }

    function pushLog(line) {
      logs.value.push(line);
      if (logs.value.length > 2000) logs.value = logs.value.slice(-2000);
    }

    async function startAgent() { await api.startAgent(); setTimeout(refreshStatus, 600); }
    async function stopAgent() { await api.stopAgent(); setTimeout(refreshStatus, 400); }
    async function runOnce() {
      status.busy = true;
      try { await api.runOnce(); } finally { status.busy = false; await loadAll(); refreshStatus(); }
    }

    onMounted(async () => {
      await loadAll();
      const init = (await api.getLogs()) || [];
      init.forEach(pushLog);
      api.onLog(pushLog);
      api.onStatus(() => refreshStatus());
      await refreshStatus();
      setInterval(refreshStatus, 8000);
    });

    // 子组件通过 inject 拿到 reload 能力
    provide("store", store);
    provide("status", status);
    provide("logs", logs);
    provide("reload", loadAll);
    provide("api", api);

    return {
      tab, tabs, store, status, logs, currentModel, showMockWarn,
      startAgent, stopAgent, runOnce,
      refreshStatus, loadAll,
    };
  },
  template: `
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
    <div v-if="showMockWarn" class="alert">
      当前默认模型为 <b>mock</b>，不会真实调用。到「模型」页添加 API Key 并设为默认。
    </div>
    <div v-if="status.pending.length" class="alert">
      ⏸ {{ status.pending.length }} 笔决策等待人工确认：{{ status.pending.join('、') }}
    </div>

    <Dashboard  v-if="tab==='dash'" />
    <ModelsView v-else-if="tab==='models'" />
    <RolesView  v-else-if="tab==='roles'" />
    <McpView    v-else-if="tab==='mcp'" />
    <SkillsView v-else-if="tab==='skills'" />
    <LogView    v-else-if="tab==='log'" />
    <SettingsView v-else-if="tab==='cfg'" />
  </main>
  `,
};
