<script setup>
/**
 * 持仓：多交易所统一视图（LLM 调各交易所 MCP 只读工具 → 统一 schema + 文字解读）。
 * 不再为单一交易所写死字段；新增交易所只需在 MCP 页加一个 server，LLM 自行归并。
 */
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api } from "../lib/api.js";
import { toastErr } from "../lib/feedback.js";
import { fmtNum, signCls } from "../lib/format.js";

const streaming = ref(false);
const lastSync = ref("");
const exchanges = ref([]); // 已连接且提供只读工具的交易所 server id
const mcpErrors = ref([]); // MCP 连接错误
const errMsg = ref("");
const notes = ref(""); // LLM 文字解读/风险
const schema = ref(null); // PortfolioSnapshot
const toolLog = ref([]); // 工具调用过程 [{name, ok, output}]
const streamText = ref(""); // 流式正文（含 JSON 块）

let offEvent = null;

const accounts = computed(() => schema.value?.accounts || []);
const positions = computed(() => schema.value?.positions || []);
const orders = computed(() => schema.value?.orders || []);

function fmt(x) {
  return x == null ? "—" : fmtNum(x);
}
const pct = (x) => (x == null ? "—" : (Number(x) * 100).toFixed(2) + "%");

// ── 全局概览（顶部汇总卡）──
const totalEquity = computed(() =>
  accounts.value.reduce((s, a) => s + (Number(a.equityUsd) || 0), 0)
);
const totalUpl = computed(() =>
  positions.value.reduce((s, p) => s + (Number(p.upl) || 0), 0)
);
// 浮盈率 = 浮盈 / 本金（权益已含浮盈，减掉浮盈即本金）
const totalUplRatio = computed(() => {
  const base = totalEquity.value - totalUpl.value;
  return base > 0 ? totalUpl.value / base : null;
});

// 距强平距离（0~1，越小越危险）：long 用 mark-liq，short 用 liq-mark
function liqDist(p) {
  const mark = Number(p.markPrice);
  const liq = Number(p.liqPrice);
  if (!mark || liq == null) return null;
  return p.side === "short" ? (liq - mark) / mark : (mark - liq) / mark;
}
// 距强平风险配色：<5% 危险(红)，<10% 警告(黄)
function liqCls(d) {
  if (d == null) return "";
  if (d < 0.05) return "down";
  if (d < 0.1) return "warn";
  return "";
}

// 持仓排序：风险优先（距强平近的在前），其次保持不变
const sortedPositions = computed(() =>
  [...positions.value].sort((a, b) => {
    const da = liqDist(a);
    const db = liqDist(b);
    if (da == null && db == null) return 0;
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db;
  })
);

// 最近强平距离（最危险一笔）
const worstLiq = computed(() => {
  let w = null;
  for (const p of positions.value) {
    const d = liqDist(p);
    if (d != null && (w == null || d < w)) w = d;
  }
  return w;
});

// 仓位占比 = 名义价值 / 总权益（0~1）
function weightPct(p) {
  if (p.notionalUsd == null || !totalEquity.value) return null;
  return Number(p.notionalUsd) / totalEquity.value;
}

function sideTag(s) {
  if (s === "long") return { t: "多", cls: "t-buy" };
  if (s === "short") return { t: "空", cls: "t-sell" };
  if (s === "net") return { t: "净", cls: "t-hold" };
  return { t: String(s || "—"), cls: "t-hold" };
}
function stateTag(st) {
  if (st === "pending" || st === "live") return "t-warn";
  if (st === "effective") return "t-buy";
  return "t-hold";
}

function subscribe() {
  if (offEvent) offEvent();
  offEvent = api.onPortfolioEvent((ev) => {
    const e = ev || {};
    switch (e.type) {
      case "exchanges":
        exchanges.value = e.list || [];
        mcpErrors.value = e.errors || [];
        break;
      case "delta":
        streamText.value += e.text || "";
        break;
      case "tool_start":
        toolLog.value.push({ name: e.name, ok: null, output: "调用中…" });
        break;
      case "tool_result": {
        const rec = toolLog.value.find((r) => r.name === e.name && r.ok === null);
        if (rec) {
          rec.ok = !!e.ok;
          rec.output = (e.output || "").slice(0, 300) + (e.error ? `（失败：${e.error}）` : "");
        }
        break;
      }
      case "done":
        schema.value = e.schema || null;
        if (e.notes != null) notes.value = e.notes;
        else notes.value = streamText.value.replace(/```json[\s\S]*?```/g, "").trim();
        streaming.value = false;
        toolLog.value = [];
        streamText.value = "";
        stamp();
        break;
      case "error":
        errMsg.value = e.message || "汇总失败";
        streaming.value = false;
        break;
    }
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  lastSync.value = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function summarize() {
  if (streaming.value) return;
  streaming.value = true;
  errMsg.value = "";
  notes.value = "";
  schema.value = null;
  toolLog.value = [];
  streamText.value = "";
  try {
    const r = await api.portfolioSummarize({});
    if (!r || !r.ok) {
      errMsg.value = (r && r.error) || "启动汇总失败";
      streaming.value = false; // 启动失败也要复位，否则按钮永远卡在「停止」
    }
  } catch (e) {
    errMsg.value = String((e && e.message) || e);
    streaming.value = false;
  }
}

function stop() {
  if (!streaming.value) return;
  api.portfolioAbort();
  streaming.value = false;
}

onMounted(() => {
  subscribe();
  summarize();
});
onUnmounted(() => {
  if (offEvent) offEvent();
});
</script>

<template>
  <div class="head-row">
    <div class="btn-group">
      <button v-if="!streaming" class="primary" @click="summarize">汇总持仓</button>
      <button v-else @click="stop"><span class="spin"></span>汇总中…（点此停止）</button>
    </div>
    <span class="spacer"></span>
    <span v-if="streaming" class="hint">正在调用各交易所只读工具归并数据…</span>
    <span v-if="lastSync" class="hint">上次汇总 {{ lastSync }}</span>
  </div>

  <div v-if="errMsg" class="alert err" style="margin:0 0 12px">{{ errMsg }}</div>

  <!-- 已连接交易所 -->
  <div class="exch-row">
    <span class="hint">已连接交易所：</span>
    <span v-for="ex in exchanges" :key="ex" class="tag t-buy">{{ ex }}</span>
    <span v-if="!exchanges.length" class="hint">（无，请到「MCP」页添加交易所 server）</span>
    <span v-for="er in mcpErrors" :key="er" class="tag t-sell" :title="er">连失败</span>
  </div>

  <!-- 工具调用过程 -->
  <div v-if="toolLog.length" class="panel" style="margin-top:12px">
    <h2>数据拉取过程</h2>
    <div class="body tool-log">
      <div v-for="(t, i) in toolLog" :key="i" :class="['tool-line', t.ok === false ? 'bad' : '']">
        <span :class="['dot', t.ok === null ? 'run' : t.ok ? 'ok' : 'bad']"></span>
        <code>{{ t.name }}</code>
        <span class="out">{{ t.output }}</span>
      </div>
    </div>
  </div>

  <!-- LLM 文字解读 / 风险 -->
  <div v-if="notes || streamText" class="panel" style="margin-top:12px">
    <h2>解读与风险提示</h2>
    <div class="body notes">{{ notes || streamText }}</div>
  </div>

  <!-- 全局概览 -->
  <div v-if="totalEquity || positions.length" class="cards" style="margin-top:12px">
    <div class="card">
      <div class="k">总权益（USD）</div>
      <div class="v">{{ fmt(totalEquity) }}</div>
    </div>
    <div class="card">
      <div class="k">总浮盈</div>
      <div class="v" :class="signCls(totalUpl)">{{ totalUpl >= 0 ? "+" : "" }}{{ fmt(totalUpl) }}</div>
    </div>
    <div class="card">
      <div class="k">浮盈率</div>
      <div class="v" :class="signCls(totalUplRatio)">
        {{ totalUplRatio == null ? "—" : (totalUplRatio >= 0 ? "+" : "") + (totalUplRatio * 100).toFixed(2) + "%" }}
      </div>
    </div>
    <div class="card">
      <div class="k">持仓笔数</div>
      <div class="v">{{ positions.length }}</div>
    </div>
    <div class="card">
      <div class="k">最近强平距离</div>
      <div class="v" :class="liqCls(worstLiq)">
        {{ worstLiq == null ? "—" : (worstLiq * 100).toFixed(1) + "%" }}
      </div>
    </div>
  </div>

  <!-- 账户卡片 -->
  <div v-if="accounts.length" class="cards" style="margin-top:12px">
    <div v-for="a in accounts" :key="a.exchange" class="card exch-card">
      <div class="exch-name">{{ a.exchange }}</div>
      <div class="mini"><span>权益</span><b>{{ fmt(a.equityUsd) }}</b></div>
      <div class="mini"><span>可用</span><b>{{ fmt(a.availableUsd) }}</b></div>
      <div class="mini"><span>已用保证金</span><b>{{ fmt(a.marginUsedUsd) }}</b></div>
      <div class="mini">
        <span>浮盈</span>
        <b :class="signCls(a.totalUplUsd)">{{ a.totalUplUsd >= 0 ? "+" : "" }}{{ fmt(a.totalUplUsd) }}</b>
      </div>
    </div>
  </div>

  <!-- 持仓表 -->
  <div v-if="positions.length" class="panel" style="margin-top:12px">
    <h2>当前持仓（{{ positions.length }}）<span class="spacer"></span><span class="hint">按距强平风险排序</span></h2>
    <div class="body">
      <div class="scroll-x">
        <table>
          <thead>
            <tr>
              <th>交易所</th><th>标的</th><th>市场</th><th>方向</th><th>数量</th>
              <th>开仓价</th><th>标记价</th><th>名义价值</th><th>仓位占比</th>
              <th>浮盈</th><th>浮盈%</th><th>杠杆</th><th>强平价</th><th>距强平</th><th>保证金模式</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(p, i) in sortedPositions" :key="p.exchange + p.instId + i">
              <td><span class="tag t-hold">{{ p.exchange }}</span></td>
              <td><b>{{ p.instId }}</b></td>
              <td>{{ p.market }}</td>
              <td><span :class="['tag', sideTag(p.side).cls]">{{ sideTag(p.side).t }}</span></td>
              <td>{{ fmt(p.size) }}</td>
              <td>{{ fmt(p.entryPrice) }}</td>
              <td>{{ fmt(p.markPrice) }}</td>
              <td>{{ fmt(p.notionalUsd) }}</td>
              <td>
                <div class="weight">
                  <div class="bar"><i :style="{ width: (weightPct(p) == null ? 0 : weightPct(p) * 100) + '%' }"></i></div>
                  <span>{{ weightPct(p) == null ? "—" : (weightPct(p) * 100).toFixed(1) + "%" }}</span>
                </div>
              </td>
              <td :class="signCls(p.upl)">{{ p.upl >= 0 ? "+" : "" }}{{ fmt(p.upl) }}</td>
              <td :class="signCls(p.uplRatio)">{{ pct(p.uplRatio) }}</td>
              <td>{{ p.leverage == null ? "—" : p.leverage + "x" }}</td>
              <td>{{ fmt(p.liqPrice) }}</td>
              <td :class="liqCls(liqDist(p))">{{ liqDist(p) == null ? "—" : (liqDist(p) * 100).toFixed(1) + "%" }}</td>
              <td>{{ p.marginMode || "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- 挂单表 -->
  <div v-if="orders.length" class="panel" style="margin-top:12px">
    <h2>挂单（{{ orders.length }}）</h2>
    <div class="body">
      <table>
        <thead>
          <tr><th>交易所</th><th>标的</th><th>类型</th><th>方向</th><th>数量</th><th>止损触发</th><th>止盈触发</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="(o, i) in orders" :key="o.exchange + o.instId + o.algoId + i">
            <td><span class="tag t-hold">{{ o.exchange }}</span></td>
            <td><b>{{ o.instId }}</b></td>
            <td>{{ o.ordType }}</td>
            <td>{{ o.side }}</td>
            <td>{{ fmt(o.size) }}</td>
            <td>{{ fmt(o.slTrigger) }}</td>
            <td>{{ fmt(o.tpTrigger) }}</td>
            <td><span :class="['tag', stateTag(o.state)]">{{ o.state }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div v-if="!streaming && !errMsg && !accounts.length && !positions.length && !notes" class="empty" style="margin-top:12px">
    暂无数据，点「汇总持仓」开始（需先在 MCP 页连接交易所）
  </div>
</template>

<style scoped>
.exch-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.exch-card { min-width: 160px; }
.exch-name { font-size: 12px; color: var(--c-text-dim); margin-bottom: 6px; }
.exch-card .mini { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
.exch-card .mini span { color: var(--c-text-dim); }
.notes { white-space: pre-wrap; line-height: 1.6; font-size: 13px; }
.tool-log { font-size: 12px; }
.tool-line { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; border-bottom: 1px dashed var(--c-border); }
.tool-line .out { color: var(--c-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-line.bad .out { color: var(--c-danger); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--c-text-dim); }
.dot.run { background: var(--c-warn); }
.dot.ok { background: var(--c-buy); }
.dot.bad { background: var(--c-danger); }
.scroll-x { overflow-x: auto; }
.spin {
  width: 12px; height: 12px; border-radius: 50%; flex: none; display: inline-block;
  border: 2px solid var(--border-strong); border-top-color: var(--blue);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg) } }
.weight { display: flex; align-items: center; gap: 7px; min-width: 112px; }
.weight .bar { flex: 1; height: 5px; border-radius: 3px; background: var(--border); overflow: hidden; }
.weight .bar i {
  display: block; height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, var(--blue), var(--purple));
  transition: width var(--ease);
}
.weight span { font-size: 11px; color: var(--text-2); min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }
</style>
