<script setup>
/**
 * ChatView.vue —— 与模型对话（可调用工具）
 *
 * 交互链路：
 *   输入 → api.chatSend → 主进程 runChat → 流式 delta / 工具事件回推 → 这里渲染
 *   危险工具（write_file / bash / run_round）会先弹确认，用户点了「允许」才执行。
 */
import { ref, computed, onMounted, onBeforeUnmount, onActivated, nextTick } from "vue";
import { store } from "../store/index.js";
import { api, hasBridge } from "../lib/api.js";
import { toastErr, toastWarn, ask } from "../lib/feedback.js";
import { uid, nowTs, renderText, briefArgs } from "../lib/format.js";

const msgs = ref([]);
const input = ref("");
const streaming = ref(false);
const curText = ref("");
const curCalls = ref([]);
const curReasoning = ref("");
const lastError = ref("");
const bodyEl = ref(null);
const disabled = ref(new Set());
const modelId = ref("");

let offEvent = null;

/** 空态引导：点一下直接填进输入框，省得手打 */
const SUGGESTS = [
  { t: "读一下 agent/src/graph.ts，说明图的编排", d: "读取文件并解释" },
  { t: "搜一下代码里在哪里生成 clOrdId", d: "在项目中全文搜索" },
  { t: "查一下当前账户状态与最近一轮决策", d: "调用 get_status / list_rounds" },
  { t: "列出项目根目录结构", d: "列目录" },
];
function useSuggest(text) {
  input.value = text;
}

const enabledTools = computed(() => store.tools.map((t) => t.name).filter((n) => !disabled.value.has(n)));
const canSend = computed(() => !streaming.value && !!input.value.trim() && hasBridge);

function scroll() {
  nextTick(() => {
    const el = bodyEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

async function loadHistory() {
  try {
    const list = (await api.chatHistory()) || [];
    msgs.value = list.map((m) => ({ id: uid(), ...m }));
    scroll();
  } catch (e) {
    toastErr(e, "读取对话历史失败");
  }
}

function finish(aborted) {
  if (!streaming.value) return;
  streaming.value = false;
  if (curText.value.trim() || curCalls.value.length || curReasoning.value.trim()) {
    msgs.value.push({
      id: uid(),
      role: "assistant",
      content: curText.value,
      calls: curCalls.value.map((c) => ({ ...c })),
      reasoning: curReasoning.value,
      ts: nowTs(),
    });
  }
  curText.value = "";
  curCalls.value = [];
  curReasoning.value = "";
  scroll();
}

async function handleConfirm(ev) {
  const ok = await ask(ev.message || "", {
    title: ev.title || "工具需要确认",
    confirmText: "允许执行",
    danger: true,
  });
  try {
    await api.chatConfirm(ev.id, ok);
  } catch (e) {
    toastErr(e, "确认失败");
  }
  if (!ok) toastWarn("已拒绝，模型会收到「用户取消」");
}

function onEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case "delta":
      curText.value += ev.text || "";
      scroll();
      break;
    case "reasoning":
      curReasoning.value += ev.text || "";
      scroll();
      break;
    case "tool_start":
      curCalls.value.push({ callId: ev.callId, name: ev.name, args: ev.args, status: "running", output: "" });
      scroll();
      break;
    case "tool_result": {
      const c = curCalls.value.find((x) => x.callId === ev.callId) || curCalls.value[curCalls.value.length - 1];
      if (c) {
        c.status = ev.ok ? "ok" : "err";
        c.output = ev.output || "";
        c.error = ev.error;
      }
      scroll();
      break;
    }
    case "confirm":
      handleConfirm(ev);
      break;
    case "error":
      lastError.value = ev.message || "对话出错";
      toastErr(ev.message || "对话出错", "对话失败");
      finish();
      break;
    case "done":
      finish(!!ev.aborted);
      break;
    default:
      break;
  }
}

async function send() {
  const text = input.value.trim();
  if (!text || streaming.value) return;
  input.value = "";
  lastError.value = "";
  msgs.value.push({ id: uid(), role: "user", content: text, ts: nowTs() });
  streaming.value = true;
  curText.value = "";
  curCalls.value = [];
  scroll();
  try {
    const r = await api.chatSend({ text, modelId: modelId.value || undefined, enabledTools: enabledTools.value });
    if (r && r.ok === false) {
      lastError.value = r.error || "发送失败";
      toastErr(r.error || "发送失败", "对话失败");
    }
  } catch (e) {
    lastError.value = String(e?.message || e);
    toastErr(e, "发送失败");
  } finally {
    finish();
  }
}

async function abort() {
  try {
    await api.chatAbort();
  } catch {
    /* ignore */
  }
}

async function clearAll() {
  if (!(await ask("清空全部对话历史？", { title: "清空对话", confirmText: "清空", danger: true }))) return;
  try {
    await api.chatClear();
    msgs.value = [];
  } catch (e) {
    toastErr(e, "清空失败");
  }
}

function toggleTool(name) {
  const s = new Set(disabled.value);
  if (s.has(name)) s.delete(name);
  else s.add(name);
  disabled.value = s;
}

/** on=true 全启用；on=false 只留一个都不启用 */
function allTools(on) {
  disabled.value = on ? new Set() : new Set(store.tools.map((t) => t.name));
}

function onKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

onMounted(async () => {
  if (hasBridge) offEvent = api.onChatEvent(onEvent);
  await loadHistory();
});
// KeepAlive 缓存：切回对话页时重新滚到底部（否则停在切走前的位置，看不到最新消息）
onActivated(() => {
  scroll();
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
  <div class="chat">
    <div class="chat-head">
      <b>对话</b>
      <span class="hint">可让我读代码、查文件、搜资料、跑命令；写文件与执行命令会先确认</span>
      <span class="spacer"></span>
      <select v-model="modelId" style="max-width:210px;flex:none">
        <option value="">跟随默认模型</option>
        <option v-for="m in store.models" :key="m.id" :value="m.id">{{ m.name }}</option>
      </select>
      <button class="sm" :disabled="streaming" @click="clearAll">清空</button>
    </div>

    <div class="chat-body" ref="bodyEl">
      <div v-if="!msgs.length && !streaming" class="empty">
        <div style="font-size:13px;color:var(--text-2);margin-bottom:2px">还没有对话</div>
        <div class="hint">下面这些可以直接点，我会自动填入输入框</div>
        <div class="suggest">
          <div v-for="s in SUGGESTS" :key="s.t" class="suggest-item" @click="useSuggest(s.t)">
            <div class="t">{{ s.t }}</div>
            <div class="d">{{ s.d }}</div>
          </div>
        </div>
      </div>

      <div v-for="m in msgs" :key="m.id" :class="['msg', m.role]">
        <div class="avatar">{{ m.role === "user" ? "我" : "AI" }}</div>
        <div class="bubble">
          <div class="who">{{ m.role === "user" ? "我" : "助手" }}<span v-if="m.ts"> · {{ m.ts }}</span></div>
          <div class="text" v-html="renderText(m.content)"></div>
          <details v-if="m.reasoning" class="reason">
            <summary>思考过程（{{ m.reasoning.length }} 字）</summary>
            <div class="reason-text">{{ m.reasoning }}</div>
          </details>
          <div class="calls" v-if="m.calls && m.calls.length">
            <details v-for="(c, i) in m.calls" :key="i" :class="['call', c.status]">
              <summary>
                <span class="arrow">▶</span>
                <span class="dot"></span>
                <b class="name">{{ c.name }}</b>
                <span class="args">{{ briefArgs(c.args) }}</span>
              </summary>
              <div class="io">{{ c.output || c.error || "（无输出）" }}</div>
            </details>
          </div>
        </div>
      </div>

      <div v-if="streaming" class="msg assistant">
        <div class="avatar">AI</div>
        <div class="bubble">
          <div class="who">助手</div>
          <details v-if="curReasoning" class="reason">
            <summary>思考过程（{{ curReasoning.length }} 字）</summary>
            <div class="reason-text">{{ curReasoning }}</div>
          </details>
          <div v-if="curText" class="text" v-html="renderText(curText)"></div>
          <div v-else class="thinking">思考中<span class="cursor"></span></div>
          <div class="calls" v-if="curCalls.length">
            <details v-for="(c, i) in curCalls" :key="i" :class="['call', c.status]" open>
              <summary>
                <span class="arrow">▶</span>
                <span class="dot"></span>
                <b class="name">{{ c.name }}</b>
                <span class="args">{{ briefArgs(c.args) }}</span>
              </summary>
              <div class="io">{{ c.output || c.error || "（执行中…）" }}</div>
            </details>
          </div>
        </div>
      </div>

      <div v-if="lastError" class="alert err" style="margin-top:12px">⚠ {{ lastError }}</div>
    </div>

    <div class="chat-foot">
      <div class="toolbar">
        <span class="hint">工具</span>
        <span
          v-for="t in store.tools"
          :key="t.name"
          :class="['chip', !disabled.has(t.name) && 'on', t.danger && 'danger']"
          :title="t.description + (t.danger ? '（危险，执行前需确认）' : '')"
          @click="toggleTool(t.name)"
        >{{ t.name }}</span>
        <span v-if="!store.tools.length" class="hint">（未加载到工具，请先 npm run build）</span>
        <span class="spacer"></span>
        <button class="sm" @click="allTools(true)">全选</button>
        <button class="sm" @click="allTools(false)">全不选</button>
      </div>
      <div class="composer">
        <textarea
          v-model="input"
          :disabled="!hasBridge"
          @keydown="onKeydown"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        ></textarea>
        <button v-if="!streaming" class="primary" :disabled="!canSend" @click="send">发送</button>
        <button v-else class="danger" @click="abort">停止</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reason { margin: 6px 0; border-left: 2px solid var(--c-border); padding-left: 8px; }
.reason summary { cursor: pointer; font-size: 12px; color: var(--c-text-dim); }
.reason-text { margin-top: 4px; white-space: pre-wrap; font-size: 12.5px; color: var(--c-text-dim); line-height: 1.6; }

/* Markdown 正文（v-html 内容需 :deep 穿透） */
.text { line-height: 1.65; }
.text :deep(p) { margin: 4px 0; }
.text :deep(h1), .text :deep(h2), .text :deep(h3), .text :deep(h4) { margin: 10px 0 4px; line-height: 1.4; }
.text :deep(h1) { font-size: 17px; }
.text :deep(h2) { font-size: 15.5px; }
.text :deep(h3), .text :deep(h4) { font-size: 14px; }
.text :deep(h1:first-child), .text :deep(h2:first-child), .text :deep(h3:first-child) { margin-top: 0; }
.text :deep(ul), .text :deep(ol) { margin: 4px 0; padding-left: 20px; }
.text :deep(li) { margin: 2px 0; }
.text :deep(code) { background: var(--c-bg-soft); border: 1px solid var(--c-border-soft); border-radius: 4px; padding: 1px 5px; font-family: Consolas, "Courier New", monospace; font-size: 12px; }
.text :deep(pre) { background: var(--c-bg-soft); border: 1px solid var(--c-border-soft); border-radius: 6px; padding: 8px 10px; margin: 6px 0; overflow: auto; max-height: 420px; }
.text :deep(pre code) { background: none; border: none; padding: 0; font-size: 12px; white-space: pre; }
.text :deep(blockquote) { margin: 6px 0; padding: 2px 10px; border-left: 3px solid var(--c-border); color: var(--c-text-dim); }
.text :deep(blockquote p) { margin: 2px 0; }
.text :deep(table) { border-collapse: collapse; margin: 6px 0; font-size: 12.5px; display: block; overflow-x: auto; max-width: 100%; }
.text :deep(th), .text :deep(td) { border: 1px solid var(--c-border); padding: 4px 10px; text-align: left; }
.text :deep(th) { background: var(--c-bg-soft); font-weight: 600; }
.text :deep(a) { color: var(--c-accent); text-decoration: none; }
.text :deep(a:hover) { text-decoration: underline; }
.text :deep(hr) { border: none; border-top: 1px solid var(--c-border); margin: 8px 0; }
.text :deep(img) { max-width: 100%; }
</style>
