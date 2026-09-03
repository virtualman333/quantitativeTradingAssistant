<script setup>
/** MCP Server 管理：stdio / HTTP 两种类型，可测试连接 */
import { ref, onMounted } from "vue";
import { store, reload } from "../store/index.js";
import { api, errText } from "../lib/api.js";
import { toastOk, toastErr, ask } from "../lib/feedback.js";
import { uid } from "../lib/format.js";

const editing = ref(null);
const editingId = ref(null); // 打开时的原始 id，用于判断是新增还是编辑
const testing = ref("");
const saving = ref(false);
const fieldErr = ref("");

const blank = () => ({ id: uid("mcp"), name: "", kind: "exchange", command: "", args: [], url: "", headers: null, enabled: true });

// 业务类型标签（区分「交易所」与「其他 MCP」）
const KIND = {
  exchange: { t: "交易所", cls: "t-buy" },
  data: { t: "数据源", cls: "t-info" },
  tool: { t: "工具", cls: "t-hold" },
  other: { t: "其他", cls: "t-hold" },
};
const kindOf = (k) => KIND[k] || { t: "交易所", cls: "t-hold" };

// 表单里 args/headers 用字符串编辑，保存时再解析
function toForm(m) {
  return {
    ...m,
    kind: m.kind || "exchange",
    argsStr: (m.args || []).join(" "),
    headersStr: m.headers ? JSON.stringify(m.headers) : "",
  };
}
function openNew() {
  fieldErr.value = "";
  editingId.value = null;
  editing.value = toForm(blank());
}
function openEdit(m) {
  fieldErr.value = "";
  editingId.value = m.id;
  editing.value = toForm(m);
}

async function doSave() {
  const f = editing.value;
  if (!f) return;
  fieldErr.value = "";
  const id = String(f.id || "").trim();
  const name = String(f.name || "").trim();
  if (!name) return void (fieldErr.value = "请填写名称");
  if (!id) return void (fieldErr.value = "请填写 ID");
  if (!editingId.value && store.mcps.some((m) => m.id === id)) {
    return void (fieldErr.value = `ID「${id}」已存在`);
  }

  let headers;
  if (f.headersStr && f.headersStr.trim()) {
    try {
      headers = JSON.parse(f.headersStr);
    } catch {
      return void (fieldErr.value = "Headers 不是合法 JSON");
    }
    if (typeof headers !== "object" || Array.isArray(headers) || headers === null) {
      return void (fieldErr.value = "Headers 必须是 JSON 对象");
    }
  }

  saving.value = true;
  try {
    await api.mcpUpsert({
      id,
      name,
      kind: f.kind || "exchange",
      command: f.command || "",
      args: String(f.argsStr || "").split(/\s+/).filter(Boolean),
      url: f.url || undefined,
      headers,
      enabled: !!f.enabled,
      createdAt: f.createdAt || new Date().toISOString(),
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
  if (!(await ask(`确定删除 MCP「${m.name}」？`, { title: "删除确认", confirmText: "删除", danger: true }))) return;
  try {
    await api.mcpDelete(m.id);
    await reload();
    toastOk("已删除");
  } catch (e) {
    toastErr(e, "删除失败");
  }
}

async function test(m) {
  testing.value = m.id;
  try {
    const r = await api.mcpTest(m.id);
    if (r?.ok) toastOk(`连接成功，${r.tools ?? 0} 个工具`);
    else toastErr(new Error((r?.errors || []).join("\n") || r?.error || "连接失败"), "连接失败");
  } catch (e) {
    toastErr(e, "测试失败");
  } finally {
    testing.value = "";
  }
}

// ── 一键安装内置交易所 MCP ─────────────────────────────
const presets = ref([]);
const installingPreset = ref(null); // 正在安装的预设
const installEnv = ref({}); // { 环境变量名: 用户输入 }
const installing = ref(false);
const installErr = ref("");
const installLog = ref("");

async function loadPresets() {
  try {
    presets.value = (await api.mcpPresets()) || [];
  } catch {
    presets.value = [];
  }
}

function openInstall(p) {
  installErr.value = "";
  installLog.value = "";
  installingPreset.value = p;
  installEnv.value = {};
  for (const v of p.envVars || []) installEnv.value[v.key] = "";
}

function envInputType(key) {
  const k = String(key || "").toLowerCase();
  return k.includes("secret") || k.includes("key") || k.includes("passphrase") ? "password" : "text";
}

async function doInstall() {
  const p = installingPreset.value;
  if (!p) return;
  installErr.value = "";
  const env = {};
  const missing = [];
  for (const v of p.envVars || []) {
    const val = String(installEnv.value[v.key] || "").trim();
    if (val) env[v.key] = val;
    else if (v.required) missing.push(v.label);
  }
  if (missing.length) return void (installErr.value = `请填写必填项：${missing.join("、")}`);

  installing.value = true;
  try {
    const r = await api.mcpInstall({ presetId: p.id, env });
    if (r?.ok) {
      installLog.value = r.output || "";
      toastOk("已安装并配置，可在下方列表测试连接");
      installingPreset.value = null;
      await reload();
      await loadPresets();
    } else {
      installErr.value = r?.error || "安装失败";
    }
  } catch (e) {
    installErr.value = errText(e);
  } finally {
    installing.value = false;
  }
}

onMounted(loadPresets);
</script>

<template>
  <div class="panel">
    <h2>一键安装交易所 MCP<span class="spacer"></span>
      <span class="hint">只读桥接，写操作仍走受控通道</span>
    </h2>
    <div class="body">
      <div v-if="presets.length" class="preset-grid">
        <div v-for="p in presets" :key="p.id" class="preset-card">
          <div class="px">
            <span class="px-logo">{{ p.exchange.slice(0, 1) }}</span>
            <div class="px-main">
              <div class="px-name">{{ p.name }}</div>
              <span :class="['tag', p.installed ? 't-on' : 't-hold']">{{ p.installed ? "已安装" : "未安装" }}</span>
            </div>
          </div>
          <div class="desc">{{ p.description }}</div>
          <div class="foot">
            <code class="cmd">{{ p.command === "npx" ? "npx " + p.args.join(" ") : p.command }}</code>
            <button class="sm primary" @click="openInstall(p)">{{ p.installed ? "重新配置" : "安装" }}</button>
          </div>
        </div>
      </div>
      <div v-else class="empty">未连接到主进程，无法读取预设目录</div>
    </div>
  </div>

  <div class="panel">
    <h2>MCP Server<span class="spacer"></span>
      <button class="primary sm" @click="openNew">+ 新增</button>
    </h2>
    <div class="body">
      <table v-if="store.mcps.length">
        <thead>
          <tr><th>名称</th><th>分类</th><th>协议</th><th>命令 / URL</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in store.mcps" :key="m.id">
            <td><b>{{ m.name }}</b></td>
            <td><span :class="['tag', kindOf(m.kind).cls]">{{ kindOf(m.kind).t }}</span></td>
            <td><span :class="['tag', m.url ? 't-info' : 't-hold']">{{ m.url ? "HTTP" : "stdio" }}</span></td>
            <td class="wrap"><code>{{ m.url || ((m.command || "") + " " + (m.args || []).join(" ")) }}</code></td>
            <td><span :class="['tag', m.enabled ? 't-on' : 't-off']">{{ m.enabled ? "启用" : "停用" }}</span></td>
            <td class="nowrap">
              <div class="btn-group">
                <button class="sm" :disabled="testing === m.id" @click="test(m)">
                  {{ testing === m.id ? "测试中" : "测试" }}
                </button>
                <button class="sm" @click="openEdit(m)">编辑</button>
                <button class="sm danger" @click="remove(m)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无 MCP Server</div>
    </div>
  </div>

  <div v-if="editing" class="modal" @click.self="editing = null">
    <div class="box">
      <h3>{{ editingId ? "编辑 MCP" : "新增 MCP" }}</h3>
      <div class="body">
        <div class="row"><label>名称</label><input v-model="editing.name" placeholder="如：OKX 交易 MCP" /></div>
        <div class="row">
          <label>分类</label>
          <select v-model="editing.kind">
            <option value="exchange">交易所（账户/持仓/下单）</option>
            <option value="data">数据源（新闻/链上/行情）</option>
            <option value="tool">工具（文件/搜索等）</option>
            <option value="other">其他</option>
          </select>
        </div>
        <div class="row">
          <label>ID</label><input v-model="editing.id" :readonly="!!editingId" />
        </div>
        <div class="row"><label>命令</label><input v-model="editing.command" placeholder="okx-trade-mcp" /></div>
        <div class="row"><label>参数</label><input v-model="editing.argsStr" placeholder="--modules all" /></div>
        <div class="row"><label>URL</label><input v-model="editing.url" placeholder="HTTP 型填此项，留空为 stdio" /></div>
        <div class="row">
          <label>Headers</label>
          <input v-model="editing.headersStr" placeholder='{"Authorization":"Bearer xxx"}' />
        </div>
        <div class="row">
          <label></label>
          <span><input id="mcp_en" type="checkbox" v-model="editing.enabled" /><label for="mcp_en">启用</label></span>
        </div>
        <div v-if="fieldErr" class="field-err">{{ fieldErr }}</div>
        <div class="hint">
          编辑已存在记录时 ID 不可修改；Windows 下 npm 全局命令（.ps1/.cmd 垫片）会自动用 cmd /c 包装。
        </div>
      </div>
      <div class="foot">
        <button @click="editing = null">取消</button>
        <button class="primary" :disabled="saving" @click="doSave">{{ saving ? "保存中…" : "保存" }}</button>
      </div>
    </div>
  </div>

  <div v-if="installingPreset" class="modal" @click.self="installingPreset = null">
    <div class="box">
      <h3>安装 {{ installingPreset.name }}</h3>
      <div class="body">
        <div v-if="installingPreset.note" class="alert info">{{ installingPreset.note }}</div>
        <template v-if="installingPreset.envVars && installingPreset.envVars.length">
          <div v-for="v in installingPreset.envVars" :key="v.key" class="row">
            <label>{{ v.label }}<span v-if="v.required" class="req">*</span></label>
            <input v-model="installEnv[v.key]" :type="envInputType(v.key)" :placeholder="v.placeholder || ''" />
          </div>
        </template>
        <div v-else class="hint">该 server 无需 API 凭证即可使用。</div>
        <div v-if="installErr" class="field-err">{{ installErr }}</div>
        <div v-if="installLog" class="install-log"><code>{{ installLog }}</code></div>
        <div class="hint">
          安装 = 执行
          <code>{{ installingPreset.installPackages && installingPreset.installPackages.length ? "npm install -g " + installingPreset.installPackages.join(" ") : "npx（首次连接自动下载）" }}</code>
          并写入配置。凭证仅保存在本地 <code>data/store.json</code>，建议仅授予读取权限。
        </div>
      </div>
      <div class="foot">
        <button @click="installingPreset = null" :disabled="installing">取消</button>
        <button class="primary" :disabled="installing" @click="doInstall">{{ installing ? "安装中…" : "安装并配置" }}</button>
      </div>
    </div>
  </div>
</template>
