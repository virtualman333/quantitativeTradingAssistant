/** 总览：权益卡片 + 持仓 + 最近决策 + 专家观点 */
import { inject, computed } from "../vendor/vue.esm-browser.prod.js";
import { fmtNum, signCls, escapeHtml, STANCE_TEXT } from "./composables.js";

export default {
  name: "Dashboard",
  setup() {
    const status = inject("status");
    const rd = computed(() => status.latestRound || {});
    const positions = computed(() => rd.value.positions || []);
    const totalUpl = computed(() => positions.value.reduce((a, p) => a + (Number(p.upl) || 0), 0));
    const experts = computed(() => rd.value.experts || []);
    return { status, rd, positions, totalUpl, experts, fmtNum, signCls, escapeHtml, STANCE_TEXT };
  },
  template: `
  <div class="cards">
    <div class="card"><div class="k">权益</div><div class="v">{{ fmtNum(rd.equity_usdt) }}</div></div>
    <div class="card"><div class="k">可用</div><div class="v">{{ fmtNum(rd.available_usdt) }}</div></div>
    <div class="card"><div class="k">浮盈</div>
      <div :class="['v', signCls(totalUpl)]">{{ totalUpl>=0?'+':'' }}{{ fmtNum(totalUpl) }}</div></div>
    <div class="card"><div class="k">持仓数</div><div class="v">{{ positions.length }}</div></div>
    <div class="card"><div class="k">最近轮次</div>
      <div class="v">{{ rd.round_id || status.runtime?.last_round_id || '—' }}</div></div>
    <div class="card"><div class="k">本日止损</div>
      <div class="v">{{ status.runtime?.day_sl_count || 0 }}</div></div>
  </div>

  <div class="panel">
    <h2>持仓</h2>
    <div class="body">
      <table v-if="positions.length">
        <tr><th>标的</th><th>方向</th><th>张数</th><th>开仓</th><th>标记</th><th>杠杆</th><th>浮盈</th></tr>
        <tr v-for="p in positions" :key="p.instrument">
          <td>{{ p.instrument }}</td>
          <td><span :class="['tag', p.side==='long'?'t-buy':'t-sell']">{{ p.side==='long'?'多':'空' }}</span></td>
          <td>{{ p.size_contracts }}</td>
          <td>{{ fmtNum(p.entry) }}</td>
          <td>{{ fmtNum(p.mark) }}</td>
          <td>{{ p.leverage }}x</td>
          <td :class="signCls(p.upl)">{{ p.upl>=0?'+':'' }}{{ fmtNum(p.upl) }}</td>
        </tr>
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
        <tr><th>角色</th><th>立场</th><th>结论</th></tr>
        <tr v-for="e in experts" :key="e.expert">
          <td>{{ e.expert }}</td>
          <td><span :class="['tag', e.stance==='bullish'?'t-buy':e.stance==='bearish'?'t-sell':'t-hold']">
            {{ STANCE_TEXT[e.stance] || e.stance }}</span></td>
          <td>{{ (e.summary||'').slice(0,220) }}</td>
        </tr>
      </table>
      <div v-else class="empty">暂无（需配置真实模型后产生）</div>
    </div>
  </div>`,
};
