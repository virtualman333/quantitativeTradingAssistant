<script setup>
/**
 * 持仓：实时查看 OKX 账户仓位（不依赖 agent 跑轮）。
 * 读操作：默认 demo 模拟盘；可切 live 只读监控（符合 L1-3）。
 */
import { ref, computed, onMounted } from "vue";
import { api } from "../lib/api.js";
import { toastErr } from "../lib/feedback.js";
import { fmtNum, signCls } from "../lib/format.js";

const profile = ref("demo");
const loading = ref(false);
const lastSync = ref("");
const account = ref(null); // { equityUsdt, availableUsdt, positions[], algoOrders[] }
const errMsg = ref("");

function mapPos(p) {
  const pos = Number(p.pos ?? 0);
  return {
    instId: String(p.instId ?? ""),
    side: pos < 0 ? "short" : "long",
    size: Math.abs(pos),
    avgPx: p.avgPx,
    markPx: p.markPx,
    lever: p.lever,
    upl: p.upl,
    uplRatio: p.uplRatio,
    margin: p.margin ?? p.imr,
    liqPx: p.liqPx,
    ccy: p.ccy ?? "USDT",
  };
}
function mapAlgo(a) {
  return {
    instId: String(a.instId ?? ""),
    algoId: String(a.algoId ?? ""),
    ordType: String(a.ordType ?? ""),
    sl: a.slTriggerPx ?? null,
    tp: a.tpTriggerPx ?? null,
    sz: a.sz,
    side: a.side ?? "",
    state: String(a.state ?? ""),
  };
}

const positions = computed(() => (account.value?.positions || []).map(mapPos));
const algos = computed(() => (account.value?.algoOrders || []).map(mapAlgo));
const totalUpl = computed(() =>
  positions.value.reduce((s, p) => s + (Number(p.upl) || 0), 0)
);

async function refresh() {
  loading.value = true;
  errMsg.value = "";
  try {
    const r = await api.accountGet(profile.value);
    if (!r || !r.ok) {
      errMsg.value = (r && r.error) || "读取失败";
      account.value = null;
      return;
    }
    account.value = r.data;
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    lastSync.value = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch (e) {
    errMsg.value = String((e && e.message) || e);
  } finally {
    loading.value = false;
  }
}

async function switchProfile(pf) {
  if (profile.value === pf) return;
  profile.value = pf;
  await refresh();
}

onMounted(refresh);
</script>

<template>
  <div class="head-row">
    <div class="btn-group">
      <button :class="profile === 'demo' ? 'primary' : ''" @click="switchProfile('demo')">模拟盘 demo</button>
      <button :class="profile === 'live' ? 'primary' : ''" @click="switchProfile('live')">真实盘 live（只读）</button>
    </div>
    <span class="spacer"></span>
    <span v-if="lastSync" class="hint">上次同步 {{ lastSync }}</span>
    <button :disabled="loading" @click="refresh">{{ loading ? "刷新中…" : "刷新" }}</button>
  </div>

  <div v-if="errMsg" class="alert err" style="margin:0 0 12px">{{ errMsg }}</div>

  <div class="cards">
    <div class="card">
      <div class="k">权益</div>
      <div class="v">{{ fmtNum(account?.equityUsdt) }}</div>
    </div>
    <div class="card">
      <div class="k">可用</div>
      <div class="v">{{ fmtNum(account?.availableUsdt) }}</div>
    </div>
    <div class="card">
      <div class="k">持仓浮盈</div>
      <div :class="['v', signCls(totalUpl)]">{{ totalUpl >= 0 ? "+" : "" }}{{ fmtNum(totalUpl) }}</div>
    </div>
    <div class="card">
      <div class="k">持仓数</div>
      <div class="v">{{ positions.length }}</div>
    </div>
    <div class="card">
      <div class="k">挂单数</div>
      <div class="v">{{ algos.length }}</div>
    </div>
  </div>

  <div class="panel">
    <h2>当前持仓</h2>
    <div class="body">
      <table v-if="positions.length">
        <thead>
          <tr>
            <th>标的</th><th>方向</th><th>张数</th><th>开仓均价</th><th>标记价</th>
            <th>杠杆</th><th>浮盈</th><th>浮盈%</th><th>保证金</th><th>强平价</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in positions" :key="p.instId + p.side">
            <td><b>{{ p.instId }}</b></td>
            <td>
              <span :class="['tag', p.side === 'long' ? 't-buy' : 't-sell']">
                {{ p.side === "long" ? "多" : "空" }}
              </span>
            </td>
            <td>{{ fmtNum(p.size) }}</td>
            <td>{{ fmtNum(p.avgPx) }}</td>
            <td>{{ fmtNum(p.markPx) }}</td>
            <td>{{ p.lever }}x</td>
            <td :class="signCls(p.upl)">{{ Number(p.upl) >= 0 ? "+" : "" }}{{ fmtNum(p.upl) }}</td>
            <td :class="signCls(p.uplRatio)">{{ p.uplRatio ? (Number(p.uplRatio) * 100).toFixed(2) + "%" : "—" }}</td>
            <td>{{ fmtNum(p.margin) }}</td>
            <td>{{ fmtNum(p.liqPx) || "—" }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无持仓</div>
    </div>
  </div>

  <div class="panel">
    <h2>挂单（止损/止盈）</h2>
    <div class="body">
      <table v-if="algos.length">
        <thead>
          <tr><th>标的</th><th>类型</th><th>方向</th><th>数量</th><th>止损触发</th><th>止盈触发</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="a in algos" :key="a.algoId">
            <td><b>{{ a.instId }}</b></td>
            <td>{{ a.ordType }}</td>
            <td>{{ a.side }}</td>
            <td>{{ fmtNum(a.sz) }}</td>
            <td>{{ fmtNum(a.sl) || "—" }}</td>
            <td>{{ fmtNum(a.tp) || "—" }}</td>
            <td>
              <span :class="['tag', a.state === 'pending' ? 't-warn' : a.state === 'effective' ? 't-buy' : 't-hold']">
                {{ a.state }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无挂单</div>
    </div>
  </div>
</template>
