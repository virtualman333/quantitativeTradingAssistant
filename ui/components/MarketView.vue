<script setup>
/**
 * MarketView —— 行情：全量 USDT 永续列表，支持搜索 / 涨跌筛选 / 三种排序 / 加载更多，
 * 点击任意交易对在下方展示 K 线（自绘 SVG，见 KlineChart.vue）。
 */
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated } from "vue";
import { api } from "../lib/api.js";
import { klineInst } from "../lib/nav.js";
import { fmtNum, signCls } from "../lib/format.js";
import KlineChart from "./KlineChart.vue";

const all = ref([]);
const err = ref("");
const ts = ref("");
const source = ref("");

const q = ref("");
const dir = ref("all"); // all | up | down
const sortKey = ref("rank"); // rank | volUsd | changePct
const shown = ref(50);

const BARS = ["15m", "1H", "4H", "1D"];
const kInst = ref("");
const kBar = ref("15m");
const kCandles = ref([]);
const kErr = ref("");
const kBusy = ref(false);

let timer = null;
let loading = false;

async function load() {
  if (loading) return;
  loading = true;
  try {
    const r = await api.marketTickers();
    if (r?.ok) {
      all.value = r.tickers || [];
      err.value = "";
      source.value = r.source || "";
      ts.value = new Date(r.ts).toTimeString().slice(0, 8);
    } else {
      err.value = (r && r.error) || "行情获取失败";
    }
  } catch (e) {
    err.value = String((e && e.message) || e);
  } finally {
    loading = false;
  }
}

const list = computed(() => {
  const kw = q.value.trim().toUpperCase();
  let rows = all.value.filter((t) => (kw ? t.instId.includes(kw) : true));
  if (dir.value === "up") rows = rows.filter((t) => t.changePct > 0);
  if (dir.value === "down") rows = rows.filter((t) => t.changePct < 0);
  const k = sortKey.value;
  rows = rows.slice().sort((a, b) => {
    if (k === "rank") return a.rank - b.rank || b.volUsd - a.volUsd;
    if (k === "changePct") return b.changePct - a.changePct;
    return b.volUsd - a.volUsd;
  });
  return rows;
});
const visible = computed(() => list.value.slice(0, shown.value));
const hasMore = computed(() => list.value.length > visible.value.length);

function fmtVol(v) {
  const n = Number(v) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}
function fmtPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function rankText(r) {
  return r >= 9999 ? "—" : `#${r}`;
}

async function openKline(row) {
  kInst.value = row.instId;
  await fetchKline();
}
async function fetchKline() {
  if (!kInst.value) return;
  kBusy.value = true;
  kErr.value = "";
  try {
    const r = await api.marketKline(kInst.value, kBar.value, 120);
    if (r?.ok) {
      kCandles.value = r.candles || [];
    } else {
      kErr.value = (r && r.error) || "K 线获取失败";
      kCandles.value = [];
    }
  } catch (e) {
    kErr.value = String((e && e.message) || e);
    kCandles.value = [];
  } finally {
    kBusy.value = false;
  }
}
async function setBar(b) {
  kBar.value = b;
  await fetchKline();
}

/** 从总览点某个交易对跳过来时，自动展开它的 K 线（消费后置空） */
function consumePendingKline() {
  if (!klineInst.value) return;
  const inst = klineInst.value;
  klineInst.value = "";
  const row = all.value.find((t) => t.instId === inst) || { instId: inst };
  openKline(row);
}

function start() {
  if (timer) return;
  load().then(consumePendingKline);
  timer = setInterval(load, 15_000);
}
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
onMounted(start);
onActivated(start);
onDeactivated(stop);
onUnmounted(stop);
</script>

<template>
  <div class="head-row">
    <input v-model="q" class="inp" placeholder="搜索交易对，如 BTC / SOL" style="max-width:240px" />
    <select v-model="dir" class="sel">
      <option value="all">全部涨跌</option>
      <option value="up">仅上涨</option>
      <option value="down">仅下跌</option>
    </select>
    <select v-model="sortKey" class="sel">
      <option value="rank">按市值排序</option>
      <option value="volUsd">按 24h 成交额</option>
      <option value="changePct">按 24h 涨幅</option>
    </select>
    <button @click="load">刷新</button>
    <span class="spacer"></span>
    <span class="hint">
      {{ visible.length }}/{{ list.length }} 个 · 每 15 秒刷新 · {{ ts || "—" }}
      <span v-if="source" class="tag">{{ source === "mcp" ? "MCP" : "REST" }}</span>
    </span>
  </div>

  <div v-if="err" class="alert err" style="margin:0 0 10px">行情获取失败：{{ err }}</div>

  <div class="panel">
    <div class="body">
      <table v-if="visible.length">
        <thead>
          <tr>
            <th>市值序</th><th>交易对</th><th>最新价</th><th>24h 涨跌</th>
            <th>24h 最高</th><th>24h 最低</th><th>24h 成交额</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="t in visible"
            :key="t.instId"
            class="row-click"
            :class="kInst === t.instId && 'cur'"
            @click="openKline(t)"
          >
            <td class="dim">{{ rankText(t.rank) }}</td>
            <td><b>{{ t.instId }}</b></td>
            <td>{{ fmtPrice(t.last) }}</td>
            <td :class="signCls(t.changePct)">
              {{ t.changePct >= 0 ? "+" : "" }}{{ t.changePct.toFixed(2) }}%
            </td>
            <td>{{ fmtPrice(t.high24h) }}</td>
            <td>{{ fmtPrice(t.low24h) }}</td>
            <td>{{ fmtVol(t.volUsd) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="!err" class="empty">加载中…</div>
      <div v-else class="empty">暂无数据</div>

      <div v-if="hasMore" style="margin-top:10px;text-align:center">
        <button @click="shown += 50">加载更多（还有 {{ list.length - visible.length }} 个）</button>
        <button class="sm" style="margin-left:8px" @click="shown = list.length">全部展开</button>
      </div>
    </div>
  </div>

  <div v-if="kInst" class="panel" style="margin-top:12px">
    <h2>
      K 线：{{ kInst }}
      <span class="hint" style="font-weight:400">{{ kBar }}</span>
      <span class="spacer"></span>
      <button class="sm" @click="kInst = ''">收起</button>
    </h2>
    <div class="body">
      <div class="head-row" style="margin-bottom:6px">
        <div class="btn-group">
          <button
            v-for="b in BARS"
            :key="b"
            :class="kBar === b && 'primary'"
            :disabled="kBusy"
            @click="setBar(b)"
          >{{ b }}</button>
        </div>
        <span class="spacer"></span>
        <span v-if="kBusy" class="hint">加载中…</span>
      </div>
      <div v-if="kErr" class="alert err" style="margin:0">K 线获取失败：{{ kErr }}</div>
      <KlineChart v-else :candles="kCandles" />
    </div>
  </div>
</template>

<style scoped>
.inp, .sel {
  padding: 6px 10px; border: 1px solid var(--border);
  border-radius: var(--r-sm); background: var(--surface); color: inherit; font-size: 13px;
}
.row-click { cursor: pointer; }
.row-click:hover { background: var(--hover-2); }
tr.cur { background: var(--surface-3); }
.dim { color: var(--dim-2); }
</style>
