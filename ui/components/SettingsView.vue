<script setup>
/** 设置：默认/主Agent/对话模型、间隔、角色策略、安全开关、数据文件 */
import { ref, computed, watch } from "vue";
import { store, reload } from "../store/index.js";
import { api } from "../lib/api.js";
import { toastOk, toastErr, ask } from "../lib/feedback.js";

const form = ref({});
const saving = ref(false);
const fieldErr = ref("");

// settings 可能晚于组件挂载才到，watch 兜住；深拷贝避免改动即生效
watch(
  () => store.settings,
  (s) => {
    if (s) form.value = JSON.parse(JSON.stringify(s));
  },
  { immediate: true, deep: false }
);

const isFixed = computed(() => form.value.roleStrategy === "fixed");

async function save() {
  fieldErr.value = "";
  const interval = Number(form.value.intervalMin);
  if (!Number.isFinite(interval) || interval < 1 || interval > 120) {
    fieldErr.value = "轮次间隔需在 1–120 分钟之间";
    return;
  }
  if (!form.value.defaultModelId) {
    fieldErr.value = "请选择默认模型";
    return;
  }
  saving.value = true;
  try {
    await api.settingsUpdate({
      defaultModelId: form.value.defaultModelId,
      mainAgentModelId: form.value.mainAgentModelId || undefined,
      chatModelId: form.value.chatModelId || undefined,
      requireToolConfirm: form.value.requireToolConfirm !== false,
      intervalMin: Math.round(interval),
      roleStrategy: form.value.roleStrategy,
      fixedRoles: form.value.fixedRoles || [],
      autoStart: !!form.value.autoStart,
      dryRun: !!form.value.dryRun,
    });
    await reload();
    toastOk("已保存");
  } catch (e) {
    toastErr(e, "保存失败");
  } finally {
    saving.value = false;
  }
}

async function reset() {
  if (!(await ask("恢复所有配置为默认？模型 / 角色 / MCP 都会重置。", {
    title: "恢复默认",
    confirmText: "恢复默认",
    danger: true,
  }))) return;
  try {
    await api.storeReset();
    await reload();
    toastOk("已恢复默认");
  } catch (e) {
    toastErr(e, "恢复失败");
  }
}

function toggleRole(id) {
  const list = form.value.fixedRoles || (form.value.fixedRoles = []);
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
}
</script>

<template>
  <div class="panel">
    <h2>运行参数</h2>
    <div class="body">
      <div class="row">
        <label>默认模型</label>
        <select v-model="form.defaultModelId">
          <option v-for="m in store.models" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
      </div>
      <div class="row">
        <label>主Agent模型</label>
        <select v-model="form.mainAgentModelId">
          <option value="">（用默认模型）</option>
          <option v-for="m in store.models" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
      </div>
      <div class="row">
        <label>对话模型</label>
        <select v-model="form.chatModelId">
          <option value="">（用默认模型）</option>
          <option v-for="m in store.models" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
        <span class="hint">「对话」页与工具调用使用</span>
      </div>
      <div class="row">
        <label>轮次间隔</label>
        <input v-model.number="form.intervalMin" type="number" min="1" max="120" style="max-width:120px" />
        <span class="hint">分钟</span>
      </div>
      <div class="row">
        <label>角色策略</label>
        <select v-model="form.roleStrategy">
          <option value="llm">主Agent自决（推荐）</option>
          <option value="fixed">固定角色</option>
        </select>
      </div>
      <div v-if="isFixed" class="row">
        <label>固定角色</label>
        <div class="chk">
          <span v-for="r in store.roles" :key="r.id">
            <input
              :id="'fr_' + r.id"
              type="checkbox"
              :checked="(form.fixedRoles || []).includes(r.id)"
              @change="toggleRole(r.id)"
            />
            <label :for="'fr_' + r.id">{{ r.name }}</label>
          </span>
          <span v-if="!store.roles.length" class="hint">暂无角色</span>
        </div>
      </div>
      <div class="row">
        <label></label>
        <div class="chk">
          <span>
            <input id="s_auto" v-model="form.autoStart" type="checkbox" />
            <label for="s_auto">启动自动运行服务</label>
          </span>
          <span>
            <input id="s_dry" v-model="form.dryRun" type="checkbox" />
            <label for="s_dry">演练模式（不下真实单）</label>
          </span>
          <span>
            <input id="s_confirm" v-model="form.requireToolConfirm" type="checkbox" />
            <label for="s_confirm">对话里写文件/执行命令前先确认</label>
          </span>
        </div>
      </div>
      <div v-if="fieldErr" class="alert err" style="margin-top:6px">{{ fieldErr }}</div>
    </div>
  </div>

  <div class="row">
    <button class="primary" :disabled="saving" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
    <button @click="api.openStore()">打开数据文件</button>
    <button @click="api.openFolder('state')">state 目录</button>
    <button @click="api.openFolder('logs')">日志目录</button>
    <button class="danger" @click="reset">恢复默认</button>
  </div>
  <div class="hint" style="margin-top:8px">
    所有配置保存在 agent/data/store.json（本机，不上传）。关闭「执行前确认」后，
    对话中的写文件与 bash 命令将不再弹窗，请自行承担风险。
  </div>
</template>
