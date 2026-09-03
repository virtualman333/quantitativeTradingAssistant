<script setup>
/** 总览：权益卡片 + 热门行情 + 持仓 + 最近决策 + 专家观点 */
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated } from "vue";
import { status } from "../store/index.js";
import { api } from "../lib/api.js";
import { goTab, klineInst } from "../lib/nav.js";
import { fmtNum, signCls, STANCE_TEXT } from "../lib/format.js";

const rd = computed(() => status.latestRound || {});
const positions = computed(() => rd.value.positions || []);
const totalUpl = computed(() => positions.value.reduce((a, p) => a + (Number(p.upl) || 0), 0));
const experts = computed(() => rd.value.experts || []);
const decisionType = computed(() => rd.value.decision_type || "");
const riskTier = computed(() => rd.value.risk_tier || "");
const conflicts = computed(() => rd.value.conflicts || []);
const actions = computed(() => rd.value.actions || []);
const execResults = computed(() => rd.value.exec_results || []);
const DECISION_TEXT = { OPEN: "开仓", HOLD: "持有", CLOSE: "平仓", STANDBY: "观望" };
const RISK_TEXT = { BASE: "基准", AGG: "激进", DEF: "防守" };
const syncedAt = computed(() => {
  if (!status.lastRefreshAt) return "—";
  const d = new Date(status.lastRefreshAt);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
});
// 上一轮归档时间（round_input 里的 time_cst："YYYY-MM-DD HH:MM:SS"）
const roundTime = computed(() => {
  const t = rd.value.time_cst || "";
  if (!t) return "—";
  const m = String(t).match(/^\d{4}-(\d{2}-\d{2}) (\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : String(t);
});

// ── 热门行情：首页只放市值前 5，完整列表在「行情」页 ──
const tickers = ref([]);
const tickersErr = ref("");
const tickersAt = ref("");
const top5 = computed(() =>
  tickers.value
    .slice()
    .sort((a, b) => a.rank - b.rank || b.volUsd - a.volUsd) // 市值梯队优先，梯队内按成交额
    .slice(0, 5)
);
function fmtPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
/** 点交易对 → 跳行情页并自动展开该标的 K 线 */
function openKlineOf(t) {
  klineInst.value = t.instId;
  goTab("mkt");
}
let tickTimer = null;
let ticking = false;

async function loadTickers() {
  if (ticking) return;
  ticking = true;
  try {
    const r = await api.marketTickers(15);
    if (r?.ok) {
      tickers.value = r.tickers || [];
      tickersErr.value = "";
      tickersAt.value = new Date(r.ts).toTimeString().slice(0, 8);
    } else {
      tickersErr.value = (r && r.error) || "行情获取失败";
    }
  } catch (e) {
    tickersErr.value = String((e && e.message) || e);
  } finally {
    ticking = false;
  }
}
function startTick() {
  if (tickTimer) return;
  loadTickers();
  tickTimer = setInterval(loadTickers, 15_000);
}
function stopTick() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
onMounted(startTick);
onActivated(startTick); // KeepAlive 切回本页签时恢复轮询
onDeactivated(stopTick);
onUnmounted(stopTick);
</script>

<template>
  <div class="cards">
    <div class="card"><div class="k">权益</div><div class="v">{{ fmtNum(rd.equity_usdt) }}</div></div>
    <div class="card"><div class="k">可用</div><div class="v">{{ fmtNum(rd.available_usdt) }}</div></div>
    <div class="card">
      <div class="k">浮盈</div>
      <div :class="['v', signCls(totalUpl)]">{{ totalUpl >= 0 ? "+" : "" }}{{ fmtNum(totalUpl) }}</div>
    </div>
    <div class="card"><div class="k">持仓数</div><div class="v">{{ positions.length }}</div></div>
    <div class="card">
      <div class="k">最近轮次</div>
      <div class="v">{{ rd.round_id || status.runtime?.last_round_id || "—" }}</div>
    </div>
    <div class="card">
      <div class="k">上一轮时间</div>
      <div class="v">{{ roundTime }}</div>
    </div>
    <div class="card"><div class="k">本日止损</div><div class="v">{{ status.runtime?.day_sl_count || 0 }}</div></div>
  </div>
  <div class="hint" style="margin:-6px 0 14px">每 8 秒自动刷新 · 上次同步 {{ syncedAt }}</div>

  <div class="panel">
    <h2>
      热门行情（市值前 5）
      <span class="hint" style="font-weight:400">每 15 秒刷新 · {{ tickersAt || "—" }}</span>
      <button class="sm" style="float:right" @click="goTab('mkt')">查看更多 →</button>
    </h2>
    <div class="body">
      <div v-if="tickersErr" class="alert err" style="margin:0 0 8px">行情获取失败：{{ tickersErr }}</div>
      <table v-if="top5.length">
        <thead>
          <tr><th>交易对</th><th>最新价</th><th>24h 涨跌</th><th>24h 最高</th><th>24h 最低</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in top5" :key="t.instId" class="row-click" @click="openKlineOf(t)">
            <td><b>{{ t.instId }}</b></td>
            <td>{{ fmtPrice(t.last) }}</td>
            <td :class="signCls(t.changePct)">
              {{ t.changePct >= 0 ? "+" : "" }}{{ t.changePct.toFixed(2) }}%
            </td>
            <td>{{ fmtPrice(t.high24h) }}</td>
            <td>{{ fmtPrice(t.low24h) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="!tickersErr" class="empty">加载中…</div>
      <div class="hint" style="margin-top:8px">点击交易对查看 K 线 · 市值梯队为内置静态排名（OKX 公共行情不返回市值）</div>
    </div>
  </div>

  <div class="panel">
    <h2>持仓</h2>
    <div class="body">
      <table v-if="positions.length">
        <thead>
          <tr><th>标的</th><th>方向</th><th>张数</th><th>开仓</th><th>标记</th><th>杠杆</th><th>浮盈</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in positions" :key="p.instrument">
            <td><b>{{ p.instrument }}</b></td>
            <td>
              <span :class="['tag', p.side === 'long' ? 't-buy' : 't-sell']">{{ p.side === "long" ? "多" : "空" }}</span>
            </td>
            <td>{{ p.size_contracts }}</td>
            <td>{{ fmtNum(p.entry) }}</td>
            <td>{{ fmtNum(p.mark) }}</td>
            <td>{{ p.leverage }}x</td>
            <td :class="signCls(p.upl)">{{ p.upl >= 0 ? "+" : "" }}{{ fmtNum(p.upl) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无持仓</div>
    </div>
  </div>

  <div class="panel">
    <h2>最近决策 · 因果链</h2>
    <div class="body">
      <div v-if="rd.decision" class="chain">
        <div class="step">
          <div class="step-lbl">拍板</div>
          <div class="step-body">
            <span class="tag t-info">{{ DECISION_TEXT[decisionType] || decisionType || "决策" }}</span>
            <span v-if="riskTier" class="tag t-hold">{{ RISK_TEXT[riskTier] || riskTier }}</span>
            <div class="pre">{{ rd.decision }}</div>
          </div>
        </div>
        <div v-if="conflicts.length" class="step">
          <div class="step-lbl warn">冲突</div>
          <div class="step-body">
            <div v-for="(c, i) in conflicts" :key="i" class="line warn">{{ c }}</div>
          </div>
        </div>
        <div v-if="actions.length" class="step">
          <div class="step-lbl">动作</div>
          <div class="step-body">
            <div v-for="(a, i) in actions" :key="i" class="line">{{ a }}</div>
          </div>
        </div>
        <div v-if="execResults.length" class="step">
          <div class="step-lbl">执行</div>
          <div class="step-body">
            <div v-for="(r, i) in execResults" :key="i" class="line mono">{{ r }}</div>
          </div>
        </div>
      </div>
      <div v-else class="empty">暂无决策记录（跑一轮后产生）</div>
    </div>
  </div>

  <div class="panel">
    <h2>专家观点</h2>
    <div class="body">
      <table v-if="experts.length">
        <thead>
          <tr><th>角色</th><th>立场</th><th>结论</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in experts" :key="e.expert">
            <td class="nowrap"><b>{{ e.expert }}</b></td>
            <td class="nowrap">
              <span :class="['tag', e.stance === 'bullish' ? 't-buy' : e.stance === 'bearish' ? 't-sell' : 't-hold']">
                {{ STANCE_TEXT[e.stance] || e.stance }}
              </span>
            </td>
            <td>{{ (e.summary || "").slice(0, 220) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无（需配置真实模型后产生）</div>
    </div>
  </div>
</template>

<style scoped>
.chain { display: flex; flex-direction: column; gap: 12px; }
.step { display: flex; gap: 12px; align-items: flex-start; }
.step-lbl {
  flex: 0 0 46px; text-align: center; font-size: 11px; padding: 3px 0;
  border-radius: var(--r-xs); background: var(--hover-2); color: var(--dim);
}
.step-lbl.warn { color: var(--yellow); }
.step-body { flex: 1; min-width: 0; }
.line { font-size: 12px; line-height: 1.75; color: var(--text-2); word-break: break-word; }
.line.warn { color: var(--yellow); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.row-click { cursor: pointer; }
.row-click:hover { background: var(--hover-2); }
</style>
