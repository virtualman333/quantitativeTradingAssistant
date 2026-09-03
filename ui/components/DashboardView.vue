<script setup>
/** 总览：权益卡片 + 持仓 + 最近决策 + 专家观点 */
import { computed } from "vue";
import { status } from "../store/index.js";
import { fmtNum, signCls, STANCE_TEXT } from "../lib/format.js";

const rd = computed(() => status.latestRound || {});
const positions = computed(() => rd.value.positions || []);
const totalUpl = computed(() => positions.value.reduce((a, p) => a + (Number(p.upl) || 0), 0));
const experts = computed(() => rd.value.experts || []);
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
    <h2>最近决策</h2>
    <div class="body">
      <div v-if="rd.decision" class="pre">{{ rd.decision }}</div>
      <div v-else class="empty">暂无决策记录</div>
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
