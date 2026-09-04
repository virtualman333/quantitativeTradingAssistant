<script setup>
/**
 * KlineWindow —— 独立窗口里的 K 线（大图 + 周期切换 + 自动刷新 + 明细表）
 * 数据自己取（api.marketKline），不依赖主窗口传参，所以窗口可以独立存在。
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { api } from "../../lib/api.js";
import KlineChart from "../KlineChart.vue";

const props = defineProps({ params: { type: Object, default: () => ({}) } });

/** K 线周期（图的间隔）：1m / 5m 等短周期到 1D */
const BARS = ["1m", "5m", "15m", "1H", "4H", "1D"];
/** 自动刷新固定秒级（行情要实时，不用分钟级长间隔） */
const RELOAD_MS = 10_000;

/** 输入容错：BTC / btc-usdt / BTC-USDT 都能补成 BTC-USDT-SWAP */
function normInst(s) {
  let v = String(s || "").trim().toUpperCase();
  if (!v) return "BTC-USDT-SWAP";
  if (!/-SWAP$/.test(v)) v = v.replace(/-USDT$/, "") + "-USDT-SWAP";
  return v;
}

const inst = ref(normInst(props.params.instId));
const bar = ref(BARS.includes(props.params.bar) ? props.params.bar : "15m");
const candles = ref([]);
const err = ref("");
const busy = ref(false);
const auto = ref(true); // 默认开启自动刷新（秒级）
const updated = ref("");
let timer = null;

async function load() {
  busy.value = true;
  err.value = "";
  try {
    const r = await api.marketKline(inst.value, bar.value, 220);
    if (r?.ok) {
      candles.value = r.candles || [];
      updated.value = new Date().toTimeString().slice(0, 8);
    } else {
      err.value = (r && r.error) || "K 线获取失败";
      candles.value = [];
    }
  } catch (e) {
    err.value = String((e && e.message) || e);
    candles.value = [];
  } finally {
    busy.value = false;
  }
}

function setBar(b) {
  if (b === bar.value) return;
  bar.value = b;
  load();
}
function submit() {
  inst.value = normInst(inst.value);
  load();
}
function stopAuto() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
function startAuto() {
  stopAuto();
  if (auto.value) timer = setInterval(load, RELOAD_MS);
}
function toggleAuto() {
  auto.value = !auto.value;
  startAuto();
}

const last = computed(() => (candles.value.length ? candles.value[candles.value.length - 1] : null));
const changePct = computed(() => {
  if (candles.value.length < 2) return null;
  const o = candles.value[0].o;
  const c = last.value.c;
  return o ? ((c - o) / o) * 100 : null;
});
/** 明细表：最新在前，只取最近 25 根，用来填满窗口下半部分 */
const rows = computed(() => candles.value.slice(-25).reverse());

function fmtPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtVol(v) {
  const n = Number(v) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}
function fmtTime(t) {
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 主进程复用窗口时只改 hash：换标的就重新取数
watch(
  () => props.params,
  (p) => {
    const next = normInst(p?.instId);
    if (p?.instId && next !== inst.value) {
      inst.value = next;
      load();
    }
  }
);
onMounted(() => {
  load();
  startAuto(); // 默认自动刷新
});
onUnmounted(stopAuto);
</script>

<template>
  <div class="klw">
    <div class="head-row">
      <input
        v-model="inst"
        class="inp"
        placeholder="交易对，如 BTC / SOL-USDT"
        @keyup.enter="submit"
      />
      <button class="primary" @click="submit">查看</button>
      <div class="btn-group">
        <button v-for="b in BARS" :key="b" :class="bar === b && 'primary'" :disabled="busy" @click="setBar(b)">
          {{ b }}
        </button>
      </div>
      <button @click="load" :disabled="busy">刷新</button>
      <label class="auto">
        <input type="checkbox" :checked="auto" @change="toggleAuto" />
        自动刷新（10 秒）
      </label>
      <span class="spacer"></span>
      <span v-if="busy" class="hint">加载中…</span>
      <span v-else-if="updated" class="hint">{{ updated }} · {{ candles.length }} 根</span>
    </div>

    <div v-if="err" class="alert err">K 线获取失败：{{ err }}</div>

    <div class="sum" v-if="last">
      <b>{{ inst }}</b>
      <span class="hint">{{ bar }}</span>
      <span class="px">{{ fmtPrice(last.c) }}</span>
      <span v-if="changePct != null" :class="changePct >= 0 ? 'up' : 'down'">
        {{ changePct >= 0 ? "+" : "" }}{{ changePct.toFixed(2) }}%
      </span>
      <span class="hint">区间 {{ candles.length }} 根 · 量 {{ fmtVol(last.v) }}</span>
    </div>

    <KlineChart :candles="candles" />

    <div class="panel" style="margin-top:12px">
      <h2>最近成交明细</h2>
      <div class="body">
        <table v-if="rows.length">
          <thead>
            <tr><th>时间</th><th>开</th><th>高</th><th>低</th><th>收</th><th>量</th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="r.t + '-' + i">
              <td class="nowrap">{{ fmtTime(r.t) }}</td>
              <td>{{ fmtPrice(r.o) }}</td>
              <td>{{ fmtPrice(r.h) }}</td>
              <td>{{ fmtPrice(r.l) }}</td>
              <td :class="r.c >= r.o ? 'up' : 'down'">{{ fmtPrice(r.c) }}</td>
              <td class="dim">{{ fmtVol(r.v) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">暂无数据</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.klw { display: flex; flex-direction: column; gap: 8px; }
.inp {
  padding: 6px 10px; border: 1px solid var(--border);
  border-radius: var(--r-sm); background: var(--surface); color: inherit;
  font-size: 13px; width: 220px;
}
.auto { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--dim); cursor: pointer; }
.sum { display: flex; align-items: baseline; gap: 10px; font-size: 13px; }
.px { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.up { color: var(--green); }
.down { color: var(--red); }
.dim { color: var(--dim-2); }
.nowrap { white-space: nowrap; }
</style>
