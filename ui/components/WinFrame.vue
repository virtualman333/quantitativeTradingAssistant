<script setup>
/**
 * WinFrame —— 独立窗口外壳（标题栏 + 内容）
 * 既用在 Electron 子窗口里，也用在无桥接时的页内全屏弹窗里，
 * 所以尺寸用 absolute + inset:0 撑满父容器，两种场景都能用。
 */
import { computed } from "vue";
import { closeWin } from "../lib/nav.js";
import KlineWindow from "./win/KlineWindow.vue";
import DocWindow from "./win/DocWindow.vue";

const props = defineProps({
  route: { type: Object, required: true },
});

const VIEWS = { kline: KlineWindow, doc: DocWindow };
const TITLES = { kline: "K 线", doc: "报告" };

const view = computed(() => VIEWS[props.route.kind] || null);
const title = computed(() => TITLES[props.route.kind] || props.route.kind);
</script>

<template>
  <div class="win-root">
    <div class="win-bar">
      <span class="win-badge">{{ title }}</span>
      <span class="spacer"></span>
      <button class="sm" title="关闭（Esc）" @click="closeWin()">✕ 关闭</button>
    </div>
    <div class="win-body">
      <component :is="view" v-if="view" :params="route.params" />
      <div v-else class="empty">未知窗口类型：{{ route.kind }}</div>
    </div>
  </div>
</template>

<style scoped>
.win-root {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  min-height: 0;
}
.win-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.win-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--dim);
  letter-spacing: 0.5px;
}
.win-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}
</style>
