<script setup>
/** 日志：agent 服务实时输出 */
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { logs } from "../store/index.js";

const box = ref(null);
const shown = computed(() => logs.value.join("\n"));

function scrollToEnd() {
  nextTick(() => {
    const el = box.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => logs.value.length, scrollToEnd);
// 修复：以前只有新日志进来才滚动，首次切进来停在顶部
onMounted(scrollToEnd);

function clear() {
  logs.value = [];
}
</script>

<template>
  <div class="row">
    <button @click="clear">清空</button>
    <span class="hint">agent 服务实时输出（仅界面显示，不影响日志文件）</span>
  </div>
  <div id="log" ref="box">{{ shown }}</div>
</template>
