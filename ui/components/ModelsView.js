/** 模型管理：自定义接口、多模型、切换默认/主Agent模型、测试连接 */
import { inject, ref, computed } from "../vendor/vue.esm-browser.prod.js";
import { uid } from "./composables.js";

export default {
  name: "ModelsView",
  setup() {
    const store = inject("store");
    const api = inject("api");
    const reload = inject("reload");
    const editing = ref(null);
    const testing = ref(null);

    const blank = () => ({
      id: uid("model"), name: "", provider: "openai-compatible",
      baseURL: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat",
      temperature: 0.2, note: "", enabled: true,
    });

    const fields = computed(() => [
      { k: "name", label: "名称", ph: "如：DeepSeek 主力" },
      { k: "provider", label: "类型", type: "select", options: [
        { v: "openai-compatible", t: "OpenAI 兼容（推荐）" },
        { v: "anthropic", t: "Anthropic 原生" },
        { v: "mock", t: "mock（联调）" }] },
      { k: "baseURL", label: "Base URL", ph: "https://api.deepseek.com" },
      { k: "model", label: "模型名", ph: "deepseek-chat" },
      { k: "apiKey", label: "API Key", type: "password", ph: "sk-..." },
      { k: "temperature", label: "温度", type: "number" },
      { k: "note", label: "备注", ph: "如：便宜，用于专家" },
      { k: "enabled", label: "启用", type: "checkbox" },
    ]);

    async function save(m) {
      await api.modelsUpsert({ ...m, createdAt: m.createdAt || new Date().toISOString() });
      await reload();
    }
    async function remove(m) {
      if (confirm(`确定删除模型「${m.name}」？`)) { await api.modelsDelete(m.id); await reload(); }
    }
    async function test(m) {
      testing.value = m.id;
      try {
        const r = await api.modelsTest(m);
        alert(r.ok ? `✅ 连接成功（${r.latencyMs}ms）\n${r.reply || ""}` : `❌ 失败\n${r.error}`);
      } finally { testing.value = null; }
    }
    async function setDefault(m) { await api.settingsUpdate({ defaultModelId: m.id }); await reload(); }
    async function setMain(m) { await api.settingsUpdate({ mainAgentModelId: m.id }); await reload(); }

    return { store, editing, fields, save, remove, test, setDefault, setMain, testing };
  },
  template: `
  <div class="panel">
    <h2>模型配置<span class="spacer"></span>
      <button class="primary sm" @click="editing = blank()">+ 新增模型</button></h2>
    <div class="body">
      <table v-if="store.models.length">
        <tr><th>名称</th><th>类型</th><th>模型</th><th>Base URL</th><th>状态</th><th>操作</th></tr>
        <tr v-for="m in store.models" :key="m.id">
          <td>
            {{ m.name }}
            <span v-if="m.id===store.settings?.defaultModelId" class="tag t-on">默认</span>
            <span v-if="m.id===store.settings?.mainAgentModelId" class="tag t-on">主Agent</span>
          </td>
          <td>{{ m.provider }}</td>
          <td>{{ m.model }}</td>
          <td class="wrap">{{ m.baseURL || '—' }}</td>
          <td><span :class="['tag', m.enabled?'t-on':'t-off']">{{ m.enabled?'启用':'停用' }}</span></td>
          <td class="nowrap">
            <button class="sm" @click="setDefault(m)">设默认</button>
            <button class="sm" @click="setMain(m)">设主Agent</button>
            <button class="sm" :disabled="testing===m.id" @click="test(m)">
              {{ testing===m.id?'测试中':'测试' }}</button>
            <button class="sm" @click="editing = {...m}">编辑</button>
            <button class="sm danger" @click="remove(m)">删</button>
          </td>
        </tr>
      </table>
      <div v-else class="empty">暂无模型</div>
      <div class="hint" style="margin-top:9px">
        支持任意 OpenAI 兼容接口（DeepSeek / OpenAI / 通义 / Kimi / 本地 vLLM / Ollama 中转等）与 Anthropic 原生。
      </div>
    </div>
  </div>

  <div v-if="editing" class="modal show" @click.self="editing=null">
    <div class="box">
      <h3>{{ store.models.some(m=>m.id===editing.id) ? '编辑模型' : '新增模型' }}</h3>
      <div class="body">
        <div class="row" v-for="f in fields" :key="f.k">
          <label>{{ f.label }}</label>
          <select v-if="f.type==='select'" v-model="editing[f.k]">
            <option v-for="o in f.options" :key="o.v" :value="o.v">{{ o.t }}</option>
          </select>
          <input v-else-if="f.type==='checkbox'" type="checkbox" v-model="editing[f.k]" />
          <input v-else :type="f.type||'text'" v-model="editing[f.k]" :placeholder="f.ph" />
        </div>
      </div>
      <div class="foot">
        <button @click="editing=null">取消</button>
        <button class="primary" @click="save(editing); editing=null">保存</button>
      </div>
    </div>
  </div>`,
};
