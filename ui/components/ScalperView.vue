<script setup>
/** 超短线（超高频）独立板块：配置 + 开单 + 开仓记录/持仓/收益展示 + LLM 介入 */
import { ref, computed, watch, onMounted, onActivated, onBeforeUnmount } from "vue";
import { store, reload } from "../store/index.js";
import { api, errText } from "../lib/api.js";
import { toastOk, toastErr, ask } from "../lib/feedback.js";
import { fmtNum } from "../lib/format.js";

const form = ref({});
const saving = ref(false);
const running = ref(false);
const lastResult = ref(null);
const overview = ref(null);
const fieldErr = ref("");

watch(
  () => store.scalper,
  (s) => {
    if (s) form.value = JSON.parse(JSON.stringify(s));
  },
  { immediate: true }
);

const LEVERAGES = [1, 2, 3, 5, 10];

const totalPnl = computed(() => {
  if (!overview.value) return null;
  return (overview.value.realizedPnl || 0) + (overview.value.unrealizedPnl || 0);
});

async function save() {
  fieldErr.value = "";
  const lev = Number(form.value.leverage);
  if (!Number.isFinite(lev) || lev < 1 || lev > 20) {
    fieldErr.value = "杠杆需在 1–20 之间";
    return;
  }
  const riskPct = Number(form.value.riskPct);
  if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 0.1) {
    fieldErr.value = "单笔金额比例需在 0–10% 之间";
    return;
  }
  saving.value = true;
  try {
    await api.scalperUpdate({
      inst: String(form.value.inst || "").trim().toUpperCase() || "BTC-USDT-SWAP",
      leverage: Math.round(lev),
      riskPct,
      atrMult: Number(form.value.atrMult) || 2.5,
      feeRate: Number(form.value.feeRate) || 0.0005,
      enabled: !!form.value.enabled,
      intervalSec: Math.max(5, Number(form.value.intervalSec) || 60),
      useLlm: !!form.value.useLlm,
    });
    await reload();
    toastOk("已保存");
  } catch (e) {
    toastErr(e, "保存失败");
  } finally {
    saving.value = false;
  }
}

async function runOnce() {
  if (
    !(await ask("将按当前配置立即开一单（市价 + OCO 止损止盈同挂）。确认？", {
      title: "超短线开单",
      confirmText: "开单",
      danger: true,
    }))
  )
    return;
  running.value = true;
  try {
    const r = await api.scalperOnce();
    lastResult.value = r;
    if (r?.ok) toastOk("已开单并同挂止损止盈");
    else toastErr(new Error(r?.error || r?.msg || "开单失败"), "开单失败");
    await loadOverview();
  } catch (e) {
    toastErr(e, "开单失败");
  } finally {
    running.value = false;
  }
}

async function loadOverview() {
  try {
    const r = await api.scalperOverview();
    if (r?.ok) overview.value = r;
  } catch {
    /* ignore */
  }
}

let timer = null;
onMounted(loadOverview);
onActivated(loadOverview);
onMounted(() => {
  timer = setInterval(() => {
    if (document.visibilityState === "visible") loadOverview();
  }, 8000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
</script>

<template>
  <div class="panel">
    <h2>超短线（超高频）<span class="spacer"></span>
      <span :class="['tag', form.enabled ? 't-on' : 't-off']">{{ form.enabled ? "已启用" : "已停用" }}</span>
    </h2>
    <div class="body">
      <div class="row">
        <label></label>
        <div class="chk">
          <span>
            <input id="scalp_en" v-model="form.enabled" type="checkbox" />
            <label for="scalp_en">启用超短线循环</label>
          </span>
          <span>
            <input id="scalp_llm" v-model="form.useLlm" type="checkbox" />
            <label for="scalp_llm">LLM 介入（趋势判断交给 LLM）</label>
          </span>
        </div>
      </div>
      <div class="row">
        <label>标的</label>
        <input v-model="form.inst" placeholder="BTC-USDT-SWAP" style="max-width:220px" />
        <span class="hint">USDT 永续合约</span>
      </div>
      <div class="row">
        <label>杠杆倍数</label>
        <select v-model.number="form.leverage" style="max-width:120px">
          <option v-for="l in LEVERAGES" :key="l" :value="l">{{ l }}x</option>
        </select>
        <span class="hint">>5x 超过章程 L1-2 上限，高风险</span>
      </div>
      <div class="row">
        <label>单笔金额比例</label>
        <input v-model.number="form.riskPct" type="number" step="0.001" min="0.001" max="0.1" style="max-width:120px" />
        <span class="hint">总仓位的比例（默认 0.01 = 1%）</span>
      </div>
      <div class="row">
        <label>ATR 系数</label>
        <input v-model.number="form.atrMult" type="number" step="0.1" min="0.5" style="max-width:120px" />
        <span class="hint">止损距离 = 1 分钟 ATR × 系数</span>
      </div>
      <div class="row">
        <label>手续费率</label>
        <input v-model.number="form.feeRate" type="number" step="0.0001" min="0" style="max-width:120px" />
        <span class="hint">单边 taker（默认 0.0005，止盈止损已扣手续费）</span>
      </div>
      <div class="row">
        <label>轮询间隔</label>
        <input v-model.number="form.intervalSec" type="number" min="5" style="max-width:120px" />
        <span class="hint">秒（默认 60）</span>
      </div>
      <div v-if="fieldErr" class="alert err" style="margin-top:6px">{{ fieldErr }}</div>
      <div class="row" style="margin:8px 0 0">
        <button class="primary" :disabled="running" @click="runOnce">
          {{ running ? "开单中…" : "立即开一单" }}
        </button>
        <button :disabled="saving" @click="save">{{ saving ? "保存中…" : "保存配置" }}</button>
        <button @click="loadOverview">刷新</button>
      </div>
      <div class="hint" style="margin-top:10px">
        拉 1 分钟线识别趋势（或 LLM 判向）→ 凯利公式推止盈止损 → 市价开单并同挂 OCO 止损止盈。
        已有持仓时自动跳过，等止盈/止损触发后再开新单。只做合约，每单必挂止损止盈。
      </div>
    </div>
  </div>

  <div class="cards">
    <div class="card">
      <div class="k">总收益（USDT）</div>
      <div :class="['v', totalPnl == null ? '' : totalPnl >= 0 ? 'up' : 'down']">{{ totalPnl == null ? "—" : fmtNum(totalPnl, 4) }}</div>
    </div>
    <div class="card">
      <div class="k">已实现收益</div>
      <div :class="['v', (overview?.realizedPnl ?? 0) >= 0 ? 'up' : 'down']">{{ fmtNum(overview?.realizedPnl ?? 0, 4) }}</div>
    </div>
    <div class="card">
      <div class="k">未实现收益</div>
      <div :class="['v', (overview?.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down']">{{ fmtNum(overview?.unrealizedPnl ?? 0, 4) }}</div>
    </div>
    <div class="card">
      <div class="k">开单笔数</div>
      <div class="v">{{ overview?.trades?.length ?? 0 }}</div>
    </div>
  </div>

  <div class="panel">
    <h2>当前持仓</h2>
    <div class="body">
      <table v-if="overview?.positions?.length">
        <thead>
          <tr><th>标的</th><th>方向</th><th>张数</th><th>开仓价</th><th>标记价</th><th>杠杆</th><th>浮盈</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in overview.positions" :key="p.instId">
            <td><b>{{ p.instId }}</b></td>
            <td><span :class="['tag', p.posSide === 'short' ? 't-sell' : 't-buy']">{{ p.posSide === "short" ? "空" : "多" }}</span></td>
            <td>{{ p.pos }}</td>
            <td>{{ p.avgPx }}</td>
            <td>{{ p.markPx }}</td>
            <td>{{ p.lever }}x</td>
            <td :class="Number(p.upl) >= 0 ? 'up' : 'down'">{{ fmtNum(p.upl, 4) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无超短线持仓</div>
    </div>
  </div>

  <div class="panel">
    <h2>开仓记录</h2>
    <div class="body">
      <table v-if="overview?.trades?.length">
        <thead>
          <tr><th>时间</th><th>标的</th><th>方向</th><th>判断</th><th>开仓价</th><th>止损</th><th>止盈</th><th>张数</th><th>杠杆</th><th>状态</th><th>平仓价</th><th>盈亏</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in [...overview.trades].reverse()" :key="t.ts + t.entry">
            <td class="nowrap">{{ fmtTs(t.ts) }}</td>
            <td><b>{{ t.inst }}</b></td>
            <td><span :class="['tag', t.direction === 'short' ? 't-sell' : 't-buy']">{{ t.direction === "short" ? "空" : "多" }}</span></td>
            <td><span :class="['tag', t.judge === 'llm' ? 't-info' : 't-hold']">{{ t.judge === "llm" ? "LLM" : "规则" }}</span></td>
            <td>{{ t.entry }}</td>
            <td>{{ t.sl }}</td>
            <td>{{ t.tp }}</td>
            <td>{{ t.size }}</td>
            <td>{{ t.leverage }}x</td>
            <td><span :class="['tag', t.status === 'open' ? 't-on' : 't-off']">{{ t.status === "open" ? "持仓中" : "已平仓" }}</span></td>
            <td>{{ t.closePrice ?? "—" }}</td>
            <td :class="t.pnl == null ? '' : t.pnl >= 0 ? 'up' : 'down'">{{ t.pnl == null ? "—" : fmtNum(t.pnl, 4) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无开仓记录</div>
    </div>
  </div>
</template>
