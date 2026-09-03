<script setup>
/**
 * DocWindow —— 独立窗口里的文档预览
 * HTML 报告用 iframe 原样渲染（LLM 生成的报告自带样式），Markdown 走纯文本。
 */
import { ref, computed, onMounted, watch } from "vue";
import { api } from "../../lib/api.js";

const props = defineProps({ params: { type: Object, default: () => ({}) } });

const path = computed(() => String(props.params.path || ""));
const isMd = computed(() => /\.md$/i.test(path.value));

const html = ref("");
const text = ref("");
const busy = ref(false);
const err = ref("");

async function load() {
  if (!path.value) return;
  busy.value = true;
  err.value = "";
  html.value = "";
  text.value = "";
  try {
    const r = isMd.value ? await api.reportsRead(path.value) : await api.reportsHtml(path.value);
    if (r?.ok) {
      if (isMd.value) text.value = r.text || "";
      else html.value = r.html || "";
    } else {
      err.value = (r && r.error) || "读取失败";
    }
  } catch (e) {
    err.value = String((e && e.message) || e);
  } finally {
    busy.value = false;
  }
}

const name = computed(() => path.value.split(/[\\/]/).pop() || "");

watch(() => props.params, load);
onMounted(load);
</script>

<template>
  <div class="docw">
    <div class="head-row">
      <b>{{ name }}</b>
      <span class="hint">{{ path }}</span>
      <span class="spacer"></span>
      <button @click="load" :disabled="busy">刷新</button>
    </div>
    <div v-if="err" class="alert err">{{ err }}</div>
    <div v-if="busy" class="empty">加载中…</div>
    <iframe v-else-if="html" :srcdoc="html" title="报告"></iframe>
    <pre v-else-if="text" class="md-pre">{{ text }}</pre>
    <div v-else-if="!busy && !err" class="empty">没有内容</div>
  </div>
</template>

<style scoped>
.docw { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; }
iframe {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
}
.md-pre {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12.5px;
  line-height: 1.7;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
</style>
