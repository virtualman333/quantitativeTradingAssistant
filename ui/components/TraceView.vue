<script setup>
/**
 * TraceView.vue —— 全局 LLM 调用观测（拒绝黑盒）
 *
 * 订阅主进程广播的 llm:trace：对话与持仓里「每一次 LLM 调用 / 思考链 / 工具调用 / 结果」
 * 都在这里按时间顺序呈现，可过滤（对话/持仓）、可清空、可自动滚到底。
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import { api, hasBridge } from "../lib/api.js";

const entries = ref([]);
const filter = ref("all"); // all | chat | portfolio | agent
const autoScroll = ref(true);
const bodyEl = ref(null);
const cap = 3000;

let offEvent = null;

const KIND = {
  round: "调用",
  reasoning: "思考",
  tool_call: "工具调用",
  tool_result: "工具结果",
  confirm: "确认",
  done: "结束",
  error: "错误",
  info: "信息",
};
const SRC = { chat: "对话", portfolio: "持仓", agent: "轮次" };

const shown = computed(() =>
  filter.value === "all" ? entries.value : entries.value.filter((e) => e.source === filter.value)
);

function pretty(v) {
  if (v == null) return "";
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function scroll() {
  if (!autoScroll.value) return;
  nextTick(() => {
    const el = bodyEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function onEvent(ev) {
  const e = ev || {};
  // 流式思考链：同源连续 reasoning 合并到同一行实时增长，避免几百条增量刷屏
  if (e.kind === "reasoning" && entries.value.length) {
    const last = entries.value[entries.value.length - 1];
    if (last.kind === "reasoning" && last.source === e.source) {
      last.text = (last.text || "") + (e.text || "");
      scroll();
      return;
    }
  }
  entries.value.push(e);
  if (entries.value.length > cap) entries.value.splice(0, entries.value.length - cap);
  scroll();
}

function clearAll() {
  entries.value = [];
}

onMounted(() => {
  if (hasBridge) offEvent = api.onLlmTrace(onEvent);
});
onBeforeUnmount(() => {
  try {
    offEvent?.();
  } catch {
    /* ignore */
  }
});
</script>

<template>
  <div class="trace">
    <div class="trace-head">
      <b>LLM 调用观测</b>
      <span class="hint">对话与持仓的每一次 LLM 调用、思考链、工具调用与结果都会在这里留痕</span>
      <span class="spacer"></span>
      <div class="seg">
        <button :class="['seg-btn', filter === 'all' && 'on']" @click="filter = 'all'">全部</button>
        <button :class="['seg-btn', filter === 'chat' && 'on']" @click="filter = 'chat'">对话</button>
        <button :class="['seg-btn', filter === 'portfolio' && 'on']" @click="filter = 'portfolio'">持仓</button>
        <button :class="['seg-btn', filter === 'agent' && 'on']" @click="filter = 'agent'">轮次</button>
      </div>
      <label class="chk"><input type="checkbox" v-model="autoScroll" /> 自动滚底</label>
      <button class="sm" @click="clearAll">清空</button>
    </div>

    <div class="trace-body" ref="bodyEl">
      <div v-if="!shown.length" class="empty">
        暂无记录。「跑一轮」/常驻轮次的调度·专家·拍板、对话与持仓的 LLM 调用轨迹都会在这里实时出现。
      </div>

      <div v-for="(e, i) in shown" :key="i" :class="['row', e.kind]">
        <span class="ts">{{ e.ts }}</span>
        <span :class="['src', e.source]">{{ SRC[e.source] || e.source }}</span>
        <span :class="['k', e.kind]">{{ KIND[e.kind] || e.kind }}</span>

        <span class="main">
          <!-- 轮次：LLM 被调用 -->
          <template v-if="e.kind === 'round'">
            <b>{{ e.label || `第 ${e.round} 轮` }}</b> · 模型 <b>{{ e.model }}</b><span v-if="e.msgCount"> · 发送消息 {{ e.msgCount }} 条</span>
          </template>
          <template v-else-if="e.kind === 'tool_call'">
            调用 <b class="name">{{ e.name }}</b>
            <pre v-if="e.args != null" class="args">{{ pretty(e.args) }}</pre>
          </template>
          <template v-else-if="e.kind === 'tool_result'">
            <b class="name">{{ e.name }}</b>
            <span :class="['badge', e.ok ? 'ok' : 'bad']">{{ e.ok ? "成功" : "失败" }}</span>
            <pre class="out" v-if="(e.output || e.error)">{{ e.error || pretty(e.output) }}</pre>
          </template>
          <template v-else-if="e.kind === 'reasoning'">
            <details class="reason">
              <summary>思考过程（{{ (e.text || "").length }} 字）</summary>
              <pre>{{ e.text }}</pre>
            </details>
          </template>
          <template v-else-if="e.kind === 'confirm'">
            等待确认：<b>{{ e.name }}</b>
          </template>
          <template v-else-if="e.kind === 'done'">
            结束<span v-if="e.rounds">（共 {{ e.rounds }} 轮）</span><span v-if="e.aborted"> · 已中止</span>
          </template>
          <template v-else-if="e.kind === 'error'">
            {{ e.message }}
          </template>
          <template v-else-if="e.kind === 'info'">
            {{ e.message }}
          </template>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trace { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.trace-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--c-border); flex-wrap: wrap; }
.trace-head .hint { font-size: 12px; color: var(--c-text-dim); }
.seg { display: inline-flex; border: 1px solid var(--c-border); border-radius: 6px; overflow: hidden; }
.seg-btn { background: transparent; border: none; padding: 4px 12px; cursor: pointer; color: var(--c-text-dim); }
.seg-btn.on { background: var(--c-accent); color: #fff; }
.chk { font-size: 12px; color: var(--c-text-dim); display: inline-flex; align-items: center; gap: 4px; }
.trace-body { flex: 1; min-height: 0; overflow: auto; padding: 8px 14px; font-size: 12.5px; }
.row { display: grid; grid-template-columns: 92px 48px 64px 1fr; gap: 8px; align-items: start; padding: 6px 0; border-bottom: 1px dashed var(--c-border-soft); }
.ts { color: var(--c-text-dim); font-variant-numeric: tabular-nums; }
.src { font-size: 11px; padding: 1px 6px; border-radius: 4px; text-align: center; }
.src.chat { background: rgba(52, 152, 219, 0.15); color: #4aa3e0; }
.src.portfolio { background: rgba(155, 89, 182, 0.15); color: #b07dd0; }
.src.agent { background: rgba(46, 204, 113, 0.15); color: #3fbf72; }
.k { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--c-bg-soft); color: var(--c-text-dim); text-align: center; }
.k.round { background: rgba(46, 204, 113, 0.15); color: #3fbf72; }
.k.tool_call { background: rgba(241, 196, 15, 0.15); color: #d9a90a; }
.k.tool_result { background: rgba(52, 152, 219, 0.12); color: #4aa3e0; }
.k.reasoning { background: rgba(149, 165, 166, 0.15); color: #95a5a6; }
.k.error { background: rgba(231, 76, 60, 0.15); color: #e74c3c; }
.k.confirm { background: rgba(230, 126, 34, 0.15); color: #e67e22; }
.main { min-width: 0; }
.name { color: var(--c-text); }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
.badge.ok { background: rgba(46, 204, 113, 0.18); color: #3fbf72; }
.badge.bad { background: rgba(231, 76, 60, 0.18); color: #e74c3c; }
pre.args, pre.out { margin: 4px 0 0; padding: 6px 8px; background: var(--c-bg-soft); border-radius: 6px; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--c-text-dim); }
details.reason { margin-top: 2px; }
details.reason summary { cursor: pointer; color: var(--c-text-dim); }
details.reason pre { margin: 4px 0 0; padding: 6px 8px; background: var(--c-bg-soft); border-radius: 6px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--c-text-dim); }
.row.error .main { color: #e74c3c; }
</style>
