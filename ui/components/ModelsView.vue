<script setup>
/**
 * 模型管理：自定义接口、一个提供商下挂多个模型、切换默认/主Agent模型、测试连接
 *
 * 「一个提供商多个模型」的做法：同一 类型+BaseURL 视为同一提供商，
 * 表格按提供商分组展示；点「同商加模型」复制一份配置，只改名称与模型名即可。
 * 数据仍是每条模型一条记录（与 agent 侧一致），只是展示与新增方式更顺手。
 */
import { ref, computed } from "vue";
import { store, reload } from "../store/index.js";
import { api } from "../lib/api.js";
import { toastOk, toastErr, ask } from "../lib/feedback.js";
import { uid } from "../lib/format.js";

const editing = ref(null);
const editingId = ref(null);
const testing = ref("");
const saving = ref(false);
const fieldErr = ref("");

const blank = () => ({
  id: uid("model"), name: "", provider: "openai-compatible",
  baseURL: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat",
  temperature: 0.2, note: "", enabled: true,
});

const fields = [
  { k: "name", label: "名称", ph: "如：DeepSeek 主力" },
  {
    k: "provider", label: "类型", type: "select", options: [
      { v: "openai-compatible", t: "OpenAI 兼容（推荐）" },
      { v: "anthropic", t: "Anthropic 原生" },
      { v: "mock", t: "mock（联调）" },
    ],
  },
  { k: "baseURL", label: "Base URL", ph: "https://api.deepseek.com" },
  { k: "model", label: "模型名", ph: "deepseek-chat" },
  { k: "apiKey", label: "API Key", type: "password", ph: "sk-..." },
  { k: "temperature", label: "温度", type: "number" },
  { k: "note", label: "备注", ph: "如：便宜，用于专家" },
  { k: "enabled", label: "启用", type: "checkbox" },
];

/** 同一「提供商」= 协议类型 + Base URL 相同 */
const provKey = (m) => `${m.provider}|${m.baseURL || ""}`;

const groups = computed(() => {
  const map = new Map();
  for (const m of store.models) {
    const k = provKey(m);
    if (!map.has(k)) map.set(k, { key: k, provider: m.provider, baseURL: m.baseURL, models: [] });
    map.get(k).models.push(m);
  }
  return [...map.values()];
});

function openNew() {
  fieldErr.value = "";
  editingId.value = null;
  editing.value = blank();
}
function openEdit(m) {
  fieldErr.value = "";
  editingId.value = m.id;
  editing.value = { ...m };
}
/** 在同一提供商下再建一个模型：复用类型 / Base URL / 密钥，只填名称与模型名 */
function cloneOf(m) {
  fieldErr.value = "";
  editingId.value = null;
  editing.value = { ...m, id: uid("model"), name: "", model: "", temperature: m.temperature ?? 0.2 };
}

async function doSave() {
  const m = editing.value;
  if (!m) return;
  fieldErr.value = "";
  const name = String(m.name || "").trim();
  if (!name) return void (fieldErr.value = "请填写模型名称");
  if (m.provider !== "mock" && !String(m.model || "").trim()) {
    return void (fieldErr.value = "请填写模型名（如 deepseek-chat）");
  }
  if (m.provider !== "mock" && !String(m.baseURL || "").trim()) {
    return void (fieldErr.value = "请填写 Base URL");
  }
  const temp = Number(m.temperature);
  if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
    return void (fieldErr.value = "温度需在 0–2 之间");
  }

  saving.value = true;
  try {
    await api.modelsUpsert({
      ...m,
      name,
      temperature: temp,
      createdAt: m.createdAt || new Date().toISOString(),
    });
    await reload();
    editing.value = null;
    toastOk("已保存");
  } catch (e) {
    toastErr(e, "保存失败");
  } finally {
    saving.value = false;
  }
}

async function remove(m) {
  if (!(await ask(`确定删除模型「${m.name}」？`, { title: "删除确认", confirmText: "删除", danger: true }))) return;
  try {
    await api.modelsDelete(m.id);
    await reload();
    toastOk("已删除");
  } catch (e) {
    toastErr(e, "删除失败");
  }
}

async function test(m) {
  testing.value = m.id;
  try {
    const r = await api.modelsTest(m);
    if (r?.ok) toastOk(`连接成功（${r.latencyMs}ms） ${r.reply || ""}`);
    else toastErr(new Error(r?.error || "连接失败"), "连接失败");
  } catch (e) {
    toastErr(e, "测试失败");
  } finally {
    testing.value = "";
  }
}

async function setDefault(m) {
  try {
    await api.settingsUpdate({ defaultModelId: m.id });
    await reload();
    toastOk(`默认模型已设为「${m.name}」`);
  } catch (e) {
    toastErr(e, "设置失败");
  }
}

async function setMain(m) {
  try {
    await api.settingsUpdate({ mainAgentModelId: m.id });
    await reload();
    toastOk(`主Agent模型已设为「${m.name}」`);
  } catch (e) {
    toastErr(e, "设置失败");
  }
}
</script>

<template>
  <div class="panel">
    <h2>模型配置<span class="spacer"></span>
      <button class="primary sm" @click="openNew">+ 新增模型</button>
    </h2>
    <div class="body">
      <table v-if="store.models.length">
        <thead>
          <tr><th>名称</th><th>类型</th><th>模型</th><th>Base URL</th><th>状态</th><th>操作</th></tr>
        </thead>
        <template v-for="g in groups" :key="g.key">
          <tbody>
            <tr v-for="(m, i) in g.models" :key="m.id">
              <td>
                <b>{{ m.name }}</b>
                <span v-if="m.id === store.settings?.defaultModelId" class="tag t-info">默认</span>
                <span v-if="m.id === store.settings?.mainAgentModelId" class="tag t-on">主Agent</span>
              </td>
              <td class="hint">{{ i === 0 ? g.provider : "" }}</td>
              <td><code>{{ m.model }}</code></td>
              <td class="wrap hint">{{ i === 0 ? g.baseURL || "—" : "同上" }}</td>
              <td><span :class="['tag', m.enabled ? 't-on' : 't-off']">{{ m.enabled ? "启用" : "停用" }}</span></td>
              <td class="nowrap">
                <div class="btn-group">
                  <button class="sm" @click="setDefault(m)">设默认</button>
                  <button class="sm" @click="setMain(m)">设主Agent</button>
                  <button class="sm" :disabled="testing === m.id" @click="test(m)">
                    {{ testing === m.id ? "测试中" : "测试" }}
                  </button>
                  <button
                    class="sm"
                    title="同一提供商下再加一个模型：复用类型 / Base URL / 密钥，只需填名称与模型名"
                    @click="cloneOf(m)"
                  >同商加模型</button>
                  <button class="sm" @click="openEdit(m)">编辑</button>
                  <button class="sm danger" @click="remove(m)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </template>
      </table>
      <div v-else class="empty">暂无模型</div>
      <div class="hint" style="margin-top:9px">
        支持任意 OpenAI 兼容接口（DeepSeek / OpenAI / 通义 / Kimi / 本地 vLLM / Ollama 中转等）与 Anthropic 原生。<br />
        一个提供商（类型 + Base URL 相同）下可以挂多个模型：点「同商加模型」复制一份配置，只改名称与模型名即可；
        每个模型可单独设默认 / 主Agent / 停用。
      </div>
    </div>
  </div>

  <div v-if="editing" class="modal" @click.self="editing = null">
    <div class="box">
      <h3>{{ editingId ? "编辑模型" : "新增模型" }}</h3>
      <div class="body">
        <div v-for="f in fields" :key="f.k" class="row">
          <label>{{ f.label }}</label>
          <select v-if="f.type === 'select'" v-model="editing[f.k]">
            <option v-for="o in f.options" :key="o.v" :value="o.v">{{ o.t }}</option>
          </select>
          <input v-else-if="f.type === 'checkbox'" :id="'mf_' + f.k" v-model="editing[f.k]" type="checkbox" />
          <input v-else v-model="editing[f.k]" :type="f.type || 'text'" :placeholder="f.ph" />
        </div>
        <div v-if="fieldErr" class="field-err">{{ fieldErr }}</div>
      </div>
      <div class="foot">
        <button @click="editing = null">取消</button>
        <button class="primary" :disabled="saving" @click="doSave">{{ saving ? "保存中…" : "保存" }}</button>
      </div>
    </div>
  </div>
</template>
