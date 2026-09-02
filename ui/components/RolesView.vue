<script setup>
/** 角色（专家）管理：增删改、指定模型、分配 Skill 与 MCP 权限 */
import { ref, computed } from "vue";
import { store, reload } from "../store/index.js";
import { api } from "../lib/api.js";
import { toastOk, toastErr, ask } from "../lib/feedback.js";
import { uid } from "../lib/format.js";

const editing = ref(null);
const editingId = ref(null);
const saving = ref(false);
const fieldErr = ref("");

const blank = () => ({
  id: uid("role"), name: "", duty: "", systemPrompt: "",
  skills: [], mcpServers: [], enabled: true, modelId: "",
});

const modelOptions = computed(() => [
  { v: "", t: "（用默认模型）" },
  ...store.models.map((m) => ({ v: m.id, t: m.name })),
]);
const modelName = (id) => store.models.find((m) => m.id === id)?.name || "默认";

function openNew() {
  fieldErr.value = "";
  editingId.value = null;
  editing.value = blank();
}
function openEdit(r) {
  fieldErr.value = "";
  editingId.value = r.id;
  // 深拷贝，避免取消编辑后把列表数据也改了
  editing.value = { ...r, skills: [...(r.skills || [])], mcpServers: [...(r.mcpServers || [])] };
}

async function doSave() {
  const r = editing.value;
  if (!r) return;
  fieldErr.value = "";
  const id = String(r.id || "").trim();
  const name = String(r.name || "").trim();
  if (!name) return void (fieldErr.value = "请填写角色名称");
  if (!id) return void (fieldErr.value = "请填写 ID");
  if (!editingId.value && store.roles.some((x) => x.id === id)) {
    return void (fieldErr.value = `ID「${id}」已存在`);
  }

  saving.value = true;
  try {
    await api.rolesUpsert({
      ...r,
      id,
      name,
      skills: r.skills || [],
      mcpServers: r.mcpServers || [],
      createdAt: r.createdAt || new Date().toISOString(),
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

async function remove(r) {
  if (!(await ask(`确定删除角色「${r.name}」？`, { title: "删除确认", confirmText: "删除", danger: true }))) return;
  try {
    await api.rolesDelete(r.id);
    await reload();
    toastOk("已删除");
  } catch (e) {
    toastErr(e, "删除失败");
  }
}

function toggleIn(list, id) {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
}
</script>

<template>
  <div class="panel">
    <h2>角色（专家）<span class="spacer"></span>
      <button class="primary sm" @click="openNew">+ 新增角色</button>
    </h2>
    <div class="body">
      <table v-if="store.roles.length">
        <tr><th>名称</th><th>ID</th><th>专用模型</th><th>Skill</th><th>MCP</th><th>状态</th><th>操作</th></tr>
        <tr v-for="r in store.roles" :key="r.id">
          <td>{{ r.name }}</td>
          <td class="hint">{{ r.id }}</td>
          <td>{{ modelName(r.modelId) }}</td>
          <td class="wrap">{{ (r.skills || []).join(", ") || "—" }}</td>
          <td class="wrap">{{ (r.mcpServers || []).join(", ") || "—" }}</td>
          <td><span :class="['tag', r.enabled ? 't-on' : 't-off']">{{ r.enabled ? "启用" : "停用" }}</span></td>
          <td class="nowrap">
            <button class="sm" @click="openEdit(r)">编辑</button>
            <button class="sm danger" @click="remove(r)">删</button>
          </td>
        </tr>
      </table>
      <div v-else class="empty">暂无角色</div>
      <div class="hint" style="margin-top:9px">
        每个角色可单独指定模型、Skill 与 MCP 权限（最小权限）。改动下一轮生效。
      </div>
    </div>
  </div>

  <div v-if="editing" class="modal" @click.self="editing = null">
    <div class="box wide">
      <h3>{{ editingId ? "编辑角色" : "新增角色" }}</h3>
      <div class="body">
        <div class="row"><label>名称</label><input v-model="editing.name" placeholder="如：交易系统专家" /></div>
        <div class="row"><label>ID</label><input v-model="editing.id" :readonly="!!editingId" /></div>
        <div class="row"><label>职责</label><input v-model="editing.duty" placeholder="一句话说明负责什么" /></div>
        <div class="row">
          <label>专用模型</label>
          <select v-model="editing.modelId">
            <option v-for="o in modelOptions" :key="o.v" :value="o.v">{{ o.t }}</option>
          </select>
        </div>
        <div class="row">
          <label>Skill</label>
          <div class="chk">
            <template v-if="store.skills.length">
              <span v-for="s in store.skills" :key="s.id">
                <input
                  :id="'rs_' + s.id"
                  type="checkbox"
                  :value="s.id"
                  :checked="(editing.skills || []).includes(s.id)"
                  @change="toggleIn(editing.skills, s.id)"
                />
                <label :for="'rs_' + s.id">{{ s.id }}</label>
              </span>
            </template>
            <span v-else class="hint">无可用 Skill</span>
          </div>
        </div>
        <div class="row">
          <label>MCP</label>
          <div class="chk">
            <template v-if="store.mcps.length">
              <span v-for="m in store.mcps" :key="m.id">
                <input
                  :id="'rm_' + m.id"
                  type="checkbox"
                  :value="m.id"
                  :checked="(editing.mcpServers || []).includes(m.id)"
                  @change="toggleIn(editing.mcpServers, m.id)"
                />
                <label :for="'rm_' + m.id">{{ m.name }}</label>
              </span>
            </template>
            <span v-else class="hint">无可用 MCP</span>
          </div>
        </div>
        <div class="row"><label>System Prompt</label></div>
        <textarea v-model="editing.systemPrompt" placeholder="该角色的系统提示词"></textarea>
        <div class="row">
          <label></label>
          <span>
            <input id="role_en" type="checkbox" v-model="editing.enabled" />
            <label for="role_en">启用该角色</label>
          </span>
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
