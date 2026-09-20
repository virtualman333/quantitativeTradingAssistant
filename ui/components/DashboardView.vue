<script setup>
/** 总览：权益卡片 + 热门行情 + 持仓 + 最近决策 + 专家观点 */
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated } from "vue";
import { status } from "../store/index.js";
import { api } from "../lib/api.js";
import { goTab, openKlineWin } from "../lib/nav.js";
import { fmtNum, fmtPrice, signCls, STANCE_TEXT } from "../lib/format.js";
import {
  ACTION_TEXT,
  LEVEL_TEXT,
  STATE_TEXT,
  barWidth,
  capOf,
  dayCountersView,
  exposureCapText,
  exposureLevel,
  exposureNote,
  instCountText,
  leverageText,
  maxUsage,
  monthRiskView,
  pctText,
  riskBudgetText,
  rowState,
  usageLevel,
  usageText,
} from "../lib/riskbrief.js";

const rd = computed(() => status.latestRound || {});
const positions = computed(() => rd.value.positions || []);
const totalUpl = computed(() => positions.value.reduce((a, p) => a + (Number(p.upl) || 0), 0));
const experts = computed(() => rd.value.experts || []);
const decisionType = computed(() => rd.value.decision_type || "");
const riskTier = computed(() => rd.value.risk_tier || "");
const conflicts = computed(() => rd.value.conflicts || []);
const actions = computed(() => rd.value.actions || []);
const execResults = computed(() => rd.value.exec_results || []);

// ── 本轮风控体检（risk_brief）──────────────────────────────
// src/riskbrief.ts 每轮都会算一遍隐含杠杆与风险预算用量并写进归档 payload，
// 但界面此前从不读它 —— 「这轮离 5x / 2.5% 两道硬顶还有多远」一直只活在 JSON 里。
// 这里把它变成两条用量条 + 逐笔明细：超限红、接近上限黄、充裕绿。
// 注意：上限值一律从 payload 的「占上限百分比」反推（capOf），界面不复制
// guard 的 5x / 2.5% 常量 —— 否则改章程时必有一处漏改。
const brief = computed(() => rd.value.risk_brief || null);
const briefIntents = computed(() => brief.value?.intents || []);
const hasBrief = computed(() => !!brief.value && Number(brief.value.total) > 0);
const maxLeverUsage = computed(() => maxUsage(briefIntents.value, "leverageUsagePct"));
const maxRiskUsage = computed(() => maxUsage(briefIntents.value, "riskUsagePct"));
const levCap = computed(() => capOf(brief.value?.maxImpliedLeverage, maxLeverUsage.value));
const riskCap = computed(() => capOf(brief.value?.maxRiskPct, maxRiskUsage.value));
// 归档里没有 risk_brief = 旧版本 agent 归档的轮次，要说清「为什么看不到」而不是空白
const briefHint = computed(() =>
  rd.value.round_id
    ? "本轮归档不含体检数据（该字段由新版本 agent 在归档时写入，重跑一轮即可看到）"
    : "暂无轮次记录（跑一轮后产生）"
);
const capLeverText = computed(() => (levCap.value === null ? "—" : `${levCap.value.toFixed(1)}x`));
const capRiskText = computed(() => (riskCap.value === null ? "—" : pctText(riskCap.value, 2)));
const leverLevel = computed(() => usageLevel(maxLeverUsage.value));
const riskLevel = computed(() => usageLevel(maxRiskUsage.value));
const approvalReasons = computed(() => brief.value?.approval_reasons || brief.value?.approvalReasons || []);

// ── 敞口（章程 §5「敞口上限」表的三条 L2 建议）─────────────────
// 逐笔那两条条回答「这一笔会不会越线」，这一条回答「连起来看会不会越线」：
// 单笔各自合规、三笔同向叠起来照样能到 6× 权益。三条软上限此前只躺在
// scripts/trade_round.py 的常量里、没有任何读取方 —— 而这块表格的「当前生效规则」
// 却把「总敞口 ≤5.0× 权益」当生效规则印给用户看。现在它真的会被算出来。
// 上限一律由 capOf 反推（界面不抄 3.0× / 5.0× 常量）。
const exposure = computed(() => brief.value?.exposure || null);
const hasExposure = computed(() => !!exposure.value);
const expLevel = computed(() => exposureLevel(exposure.value));
const exposureWarnings = computed(() => exposure.value?.warnings || []);
const exposureNoteText = computed(() => (hasExposure.value ? exposureNote(exposure.value) : ""));
const exposureTotalText = computed(() => {
  const e = exposure.value;
  if (!e || e.totalX === null || e.totalX === undefined) return "—";
  return `${Number(e.totalX).toFixed(2)}×`;
});

// ── 月度风控（章程 L1-6）───────────────────────────────────
// 本月还能不能开新仓，是全部硬约束里后果最重的一条（不是这笔亏了，是没有下一笔了）。
// 它的判据在运行态里（runtime.json 由 archive_round.py 每轮写），而界面此前
// 只用运行态显示过「本日止损」—— 这条 L1 修好之后一年多来第一次真会触发，
// 却仍然只活在日志与邮件里。这里把它摆到用户面前。
// 展示层不重算判据，只读 l1_6_tripped（口径见 ui/lib/riskbrief.js 的 monthRiskView）。
const month = computed(() => monthRiskView(status.runtime));
// 本日止损 / 当日盈亏是否因为 `state/runtime.json` 曾损坏被重置过。
// 置真时卡片显示「—」而不是 0：重置出来的 0 与「今天没止损过」长得一模一样，
// 而它恰好是判断「本日是否已熔断」的分子（月度回撤那条教训的同一个形状）。
// 决定「显示什么」的是纯函数（可在测试里直接断言行为），组件只负责摆放。
const counters = computed(() => dayCountersView(status.runtime));
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
// 价格格式化统一走 lib/format.js 的 fmtPrice（本文件与行情页/K线图此前各有一份逐字相同的副本）
/** 点交易对 → 独立窗口看 K 线（不打断当前页） */
function openKlineOf(t) {
  openKlineWin(t.instId);
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
    <div class="card">
      <div class="k">本日止损</div>
      <div class="v">{{ counters.slText }}</div>
    </div>
  </div>
  <div v-if="counters.compromised" class="alert err" style="margin:-6px 0 14px">{{ counters.note }}</div>
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
      <div class="hint" style="margin-top:8px">点击交易对在独立窗口查看 K 线 · 市值梯队为内置静态排名（OKX 公共行情不返回市值）</div>
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
            <td>{{ fmtPrice(p.entry) }}</td>
            <td>{{ fmtPrice(p.mark) }}</td>
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
    <h2>
      月度风控 · 章程 L1-6
      <span class="hint" style="font-weight:400">月度回撤 ≥ {{ month.capText }} → 强制停止开新仓</span>
      <span class="spacer"></span>
      <span :class="['tag', month.tagCls]">{{ month.tagText }}</span>
    </h2>
    <div class="body">
      <div class="rb-bars">
        <div class="rb-item">
          <div class="rb-k">当前月度回撤</div>
          <div class="rb-v">
            <b :class="month.barCls">{{ month.ddText }}</b>
            <span class="rb-sub">/ 熔断线 {{ month.capText }}</span>
          </div>
          <div class="rb-track">
            <i :class="['rb-fill', month.barCls]" :style="{ width: month.barPct + '%' }"></i>
          </div>
          <div :class="['rb-tip', month.barCls]">{{ month.ddTip }}</div>
        </div>
        <div class="rb-item">
          <div class="rb-k">月度收益 / 目标</div>
          <div class="rb-v">
            <b>{{ month.pnlText }}</b>
            <span class="rb-sub">/ 目标 {{ month.targetText }}</span>
          </div>
          <div class="rb-track">
            <i :class="['rb-fill', 'lv-ok']" :style="{ width: month.progressBarPct + '%' }"></i>
          </div>
          <div class="rb-tip">{{ month.progressTip }}</div>
        </div>
      </div>
      <div class="rb-sum">{{ month.summary }}</div>
    </div>
  </div>

  <div class="panel">
    <h2>
      本轮风控体检
      <span class="hint" style="font-weight:400">L1 硬顶：杠杆 ≤ {{ capLeverText }} · 单笔风险 ≤ {{ capRiskText }}</span>
      <span class="spacer"></span>
      <span v-if="brief && brief.needsApproval" class="tag t-warn">需人工确认（L2）</span>
    </h2>
    <div class="body">
      <template v-if="hasBrief">
        <div class="rb-bars">
          <div class="rb-item">
            <div class="rb-k">最大隐含杠杆</div>
            <div class="rb-v">
              <b>{{ fmtNum(brief.maxImpliedLeverage, 1) }}x</b>
              <span class="rb-sub">/ 硬顶 {{ capLeverText }}</span>
            </div>
            <div class="rb-track">
              <i :class="['rb-fill', 'lv-' + leverLevel]" :style="{ width: barWidth(maxLeverUsage) + '%' }"></i>
            </div>
            <div :class="['rb-tip', 'lv-' + leverLevel]">
              {{ usageText(maxLeverUsage) }} · {{ LEVEL_TEXT[leverLevel] }}
            </div>
          </div>
          <div class="rb-item">
            <div class="rb-k">单笔最大风险</div>
            <div class="rb-v">
              <b>{{ pctText(brief.maxRiskPct) }}</b>
              <span class="rb-sub">/ 硬顶 {{ capRiskText }}</span>
            </div>
            <div class="rb-track">
              <i :class="['rb-fill', 'lv-' + riskLevel]" :style="{ width: barWidth(maxRiskUsage) + '%' }"></i>
            </div>
            <div :class="['rb-tip', 'lv-' + riskLevel]">
              {{ usageText(maxRiskUsage) }} · {{ LEVEL_TEXT[riskLevel] }}
            </div>
          </div>
          <div v-if="hasExposure" class="rb-item">
            <div class="rb-k">总名义敞口</div>
            <div class="rb-v">
              <b>{{ exposureTotalText }}</b>
              <span class="rb-sub">/ 软上限 {{ exposureCapText(exposure) }}</span>
            </div>
            <div class="rb-track">
              <i :class="['rb-fill', 'lv-' + expLevel]" :style="{ width: barWidth(exposure.totalUsagePct) + '%' }"></i>
            </div>
            <div :class="['rb-tip', 'lv-' + expLevel]">
              {{ usageText(exposure.totalUsagePct) }} · {{ LEVEL_TEXT[expLevel] }} ·
              持仓 {{ instCountText(exposure) }} 标的
            </div>
          </div>
        </div>

        <div class="rb-sum">{{ brief.summary }}</div>

        <div v-if="exposureWarnings.length" class="alert" style="margin:10px 0 0">
          <div>
            <b>章程 §5 · L2 敞口软约束（建议，非闸门）</b>
            <div v-for="(r, i) in exposureWarnings" :key="i">{{ r }}</div>
            <div class="hint">超限只留痕提示，不阻断执行；是否改成真闸门属策略层决定。</div>
          </div>
        </div>
        <div v-else-if="exposureNoteText" class="hint" style="margin-top:6px">{{ exposureNoteText }}</div>
        <div v-else class="hint" style="margin-top:6px">
          本轮归档不含敞口体检（该字段由新版本 agent 在归档时写入，重跑一轮即可看到）
        </div>

        <div v-if="brief.needsApproval && approvalReasons.length" class="alert" style="margin:10px 0 0">
          <div>
            <b>章程 L2 · 单笔风险超过 2% 需人工确认</b>
            <div v-for="(r, i) in approvalReasons" :key="i">{{ r }}</div>
            <div class="hint">本轮按原计划执行，此处仅留痕提示（是否改成真闸门属策略层决定）。</div>
          </div>
        </div>

        <table v-if="briefIntents.length" style="margin-top:12px">
          <thead>
            <tr>
              <th>标的</th><th>动作</th><th>单笔风险</th><th>隐含杠杆</th>
              <th>风险占用</th><th>杠杆占用</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in briefIntents" :key="i">
              <td><b>{{ c.inst }}</b></td>
              <td class="nowrap">{{ ACTION_TEXT[c.action] || c.action }}</td>
              <td class="nowrap">{{ riskBudgetText(c) }}</td>
              <td class="nowrap">{{ leverageText(c) }}</td>
              <td class="nowrap" :class="'lv-' + usageLevel(c.riskUsagePct)">{{ usageText(c.riskUsagePct) }}</td>
              <td class="nowrap" :class="'lv-' + usageLevel(c.leverageUsagePct)">{{ usageText(c.leverageUsagePct) }}</td>
              <td class="nowrap">
                <span
                  :class="['tag', rowState(c) === 'blocked' ? 't-sell' : rowState(c) === 'warned' ? 't-warn' : 't-on']"
                  :title="[...(c.violations || []), ...(c.warnings || [])].join('\n') || '无告警'"
                >{{ STATE_TEXT[rowState(c)] }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="hint" style="margin-top:10px">{{ brief.summary }}</div>
      </template>
      <div v-else class="empty">{{ briefHint }}</div>
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

/* 风控体检：两条预算用量条。色阶只表「离硬顶还有多远」，与涨跌色无关 */
.rb-bars { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px }
.rb-item { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 10px 12px }
.rb-k { color: var(--dim); font-size: 11px; letter-spacing: .3px }
.rb-v { margin-top: 2px; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums }
.rb-sub { font-size: 11px; font-weight: 400; color: var(--dim); margin-left: 4px }
.rb-track { margin-top: 8px; height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden }
.rb-fill { display: block; height: 100%; border-radius: 3px; transition: width var(--ease), background var(--ease) }
.rb-tip { margin-top: 6px; font-size: 11px; color: var(--dim); font-variant-numeric: tabular-nums }
.rb-sum { margin-top: 12px; font-size: 12px; line-height: 1.7; color: var(--text-2) }
.lv-ok { color: var(--green) }
.lv-ok.rb-fill { background: var(--green) }
.lv-near { color: var(--yellow) }
.lv-near.rb-fill { background: var(--yellow) }
.lv-over { color: var(--red); font-weight: 600 }
.lv-over.rb-fill { background: var(--red) }
.lv-none { color: var(--dim) }
.lv-none.rb-fill { background: var(--border-strong) }
</style>
