<script setup>
/** MCP Server 管理：stdio / HTTP 两种类型，可测试连接 */
import { ref } from "vue";
import { store, reload } from "../store/index.js";
import { api } from "../lib/api.js";
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
</script>

<template>
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
</template>
