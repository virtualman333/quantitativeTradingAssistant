<script setup>
/** Skill 管理：查看项目沉淀的技能，可逐个启停 */
import { ref } from "vue";
import { store, reload } from "../store/index.js";
import { api } from "../lib/api.js";
import { toastErr } from "../lib/feedback.js";

const busy = ref("");

async function toggle(s, on) {
  if (busy.value) return;
  busy.value = s.id;
  try {
    await api.skillsSetEnabled(s.id, on);
    await reload();
  } catch (e) {
    // 失败要把开关视觉上拨回去（reload 会重新拉取真实状态）
    toastErr(e, "切换失败");
    await reload();
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <div class="panel">
    <h2>技能（Skill）</h2>
    <div class="body">
      <table v-if="store.skills.length">
        <tr><th>名称</th><th>参数</th><th>说明</th><th>权限</th><th>启用</th></tr>
        <tr v-for="s in store.skills" :key="s.id">
          <td>{{ s.name }}<br><span class="hint">{{ s.id }}</span></td>
          <td class="wrap hint">{{ s.args }}</td>
          <td class="wrap">{{ s.description }}</td>
          <td><span :class="['tag', s.readOnly ? 't-on' : 't-off']">{{ s.readOnly ? "只读" : "写" }}</span></td>
          <td>
            <input
              type="checkbox"
              :checked="s.enabled"
              :disabled="busy === s.id"
              @change="toggle(s, $event.target.checked)"
            />
          </td>
        </tr>
      </table>
      <div v-else class="empty">暂无 Skill</div>
      <div class="hint" style="margin-top:9px">
        Skill 是项目沉淀的确定性能力（踩坑经验已固化）；停用的 Skill 不会出现在任何角色的可用列表里，
        也不会作为工具提供给对话。
      </div>
    </div>
  </div>
</template>
