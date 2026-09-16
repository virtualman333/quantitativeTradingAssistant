<script setup>
/** 超短线（超高频）板块：配置 + 开单 + 开仓记录/持仓/收益展示。策略库与回测已拆到「策略回测」独立 tab。 */
import { ref, computed, watch, onMounted, onActivated, onBeforeUnmount } from "vue";
import { store, reload } from "../store/index.js";
import { api, errText } from "../lib/api.js";
import { toastOk, toastErr, ask } from "../lib/feedback.js";
import { fmtNum } from "../lib/format.js";
import { goTab } from "../lib/nav.js";
import { sparkline } from "../lib/sparkline.js";

const form = ref({});
const saving = ref(false);
const running = ref(false);
const loopRunning = ref(false);
const lastResult = ref(null);
const overview = ref(null);
const fieldErr = ref("");
const closing = ref(false);

watch(
  () => store.scalper,
  (s) => {
    if (s) form.value = JSON.parse(JSON.stringify(s));
  },
  { immediate: true }
);

const LEVERAGES = [1, 2, 3, 5, 10];

const dateFrom = ref("");
const dateTo = ref("");

// 总净收益 = 已实现净盈亏 + 未实现收益
const totalNetPnl = computed(() => {
  if (!overview.value) return null;
  return (overview.value.realizedNetPnl || 0) + (overview.value.unrealizedPnl || 0);
});

// ── 日期区间（筛选的是「哪一段时间」） ─────────────────────
// 判定与统计**都在主进程**（`src/scalperstats.ts` 是区间口径的唯一来源）。
// 这里以前有一份本地过滤，只作用于下方成交明细表，而战绩面板始终是全量：
// 同一个「日期筛选」在同一个页面上有两种含义，用户看不出差别，只会觉得
// 战绩数字与表里的笔数对不上。现在表与统计共用主进程下发的同一份结果。
const hasRange = computed(() => !!(dateFrom.value || dateTo.value));
const rangeText = computed(() => `${dateFrom.value || "最早"} ~ ${dateTo.value || "最新"}`);
const rangeData = ref(null);
const rangeLoading = ref(false);
const rangeErr = ref("");
/** 连改日期时先发的请求可能后到 —— 只认最后一次，否则数字会跳回上一段区间 */
let rangeSeq = 0;

async function loadRange() {
  const seq = ++rangeSeq;
  rangeLoading.value = true;
  try {
    const r = await api.scalperRange(dateFrom.value, dateTo.value);
    if (seq !== rangeSeq) return;
    if (r?.ok) {
      rangeData.value = r;
      rangeErr.value = "";
    } else {
      rangeData.value = null;
      rangeErr.value = String(r?.error || "未知错误");
    }
  } catch (e) {
    if (seq !== rangeSeq) return;
    rangeData.value = null;
    rangeErr.value = errText(e);
  } finally {
    if (seq === rangeSeq) rangeLoading.value = false;
  }
}

watch([dateFrom, dateTo], () => {
  if (hasRange.value) loadRange();
  // 清空筛选 → 回到全量 overview，不必再取一次（同一份台账、同一套口径）
  else rangeData.value = null;
});

/** 成交明细表：区间生效时用主进程筛好的那份，否则用全量 */
const filteredTrades = computed(
  () => (hasRange.value ? rangeData.value?.trades : overview.value?.trades) || []
);

// ── 战绩统计 ───────────────────────────────────────────────
// 数字全部来自主进程算好的 `overview.stats` / 区间值（口径唯一来源
// `src/scalperstats.ts`），界面只负责格式化与画曲线。若成交表与统计表各算
// 一套净盈亏，两边必然漂移。
const stats = computed(
  () => (hasRange.value ? rangeData.value?.stats : overview.value?.stats) || null
);
const spark = computed(() => sparkline(stats.value?.equity || []));
// 只列出真正出现过的来源；某来源若全是「未同步」的单也要列出（否则用户以为没开过）
const judgeRows = computed(() =>
  (stats.value?.byJudge || []).filter((r) => r.samples > 0 || r.unsettled > 0)
);
const skipRows = computed(() => (stats.value?.reasonStats || []).filter((r) => r.count > 0));
const skipMax = computed(() => skipRows.value.reduce((m, r) => Math.max(m, r.count), 1));
// 曲线颜色跟「这轮赚没赚」走（零轴以上绿、以下红）
const eqCls = computed(() => ((stats.value?.netPnl ?? 0) >= 0 ? "up" : "down"));
/** null = 算不出来（样本不足 / 无亏损样本），必须显示「—」而不是 0 */
const pct1 = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const JUDGE_TEXT = { rule: "规则", llm: "LLM" };
const judgeText = (j) => JUDGE_TEXT[j] || String(j ?? "未标注");

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
      intervalSec: Math.max(5, Number(form.value.intervalSec) || 60),
      useLlm: !!form.value.useLlm,
      closeOnReversal: !!form.value.closeOnReversal,
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
  // 区间生效时一并刷新：区间统计是从本地台账现算的（不联网），会随开单/平仓变
  if (hasRange.value) await loadRange();
}

async function refreshLoopStatus() {
  try {
    const s = await api.scalperStatus();
    loopRunning.value = !!s?.running;
  } catch {
    /* ignore */
  }
}

async function startLoop() {
  try {
    const r = await api.scalperStart();
    if (r?.ok) toastOk("超短线循环已启动");
    else toastErr(new Error(r?.msg || "启动失败"), "启动失败");
  } catch (e) {
    toastErr(e, "启动失败");
  }
  await refreshLoopStatus();
}

async function stopLoop() {
  try {
    const r = await api.scalperStop();
    if (r?.ok) toastOk("超短线循环已停止");
    else toastErr(new Error(r?.msg || "停止失败"), "停止失败");
  } catch (e) {
    toastErr(e, "停止失败");
  }
  await refreshLoopStatus();
}

async function closeAll() {
  if (
    !(await ask("将一键平掉超短线当前全部持仓（先撤止损止盈再市价平仓）。确认？", {
      title: "一键平仓",
      confirmText: "平仓",
      danger: true,
    }))
  )
    return;
  closing.value = true;
  try {
    const r = await api.scalperCloseAll();
    if (r?.ok) toastOk(r?.msg || "已平仓");
    else toastErr(new Error(r?.msg || "平仓失败"), "平仓失败");
    await loadOverview();
  } catch (e) {
    toastErr(e, "平仓失败");
  } finally {
    closing.value = false;
  }
}

// ── 当前实盘循环策略（名称展示；策略库 / 回测在独立 tab） ──
const stratList = ref([]);
async function loadStratNames() {
  try {
    const r = await api.strategyList();
    if (r?.ok) stratList.value = r.strategies || [];
  } catch {
    /* ignore */
  }
}
const currentStratName = computed(() => {
  const id = store.scalper?.strategyId || "";
  if (!id) return "内置趋势策略";
  const s = stratList.value.find((x) => x.id === id);
  return s ? `${s.name}（${id}）` : id;
});
watch(
  () => store.scalper?.strategyId,
  () => {
    if (store.scalper?.strategyId) loadStratNames();
  }
);

let timer = null;
onMounted(() => {
  loadOverview();
  refreshLoopStatus();
  loadStratNames();
  timer = setInterval(() => {
    if (document.visibilityState === "visible") loadOverview();
  }, 8000);
});
onActivated(() => {
  loadOverview();
  loadStratNames();
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
        <label>实盘策略</label>
        <span class="tag t-info">{{ currentStratName }}</span>
        <button class="sm" @click="goTab('bt')">去策略库 · 回测</button>
      </div>
      <div class="row">
        <label>循环</label>
        <span :class="['tag', loopRunning ? 't-on' : 't-off']">{{ loopRunning ? "运行中" : "已停止" }}</span>
        <button class="primary" :disabled="loopRunning" @click="startLoop">启动循环</button>
        <button class="danger" :disabled="!loopRunning" @click="stopLoop">停止循环</button>
      </div>
      <div class="row">
        <label></label>
        <div class="chk">
          <span>
            <input id="scalp_llm" v-model="form.useLlm" type="checkbox" />
            <label for="scalp_llm">LLM 介入（趋势判断交给 LLM）</label>
          </span>
          <span>
            <input id="scalp_rev" v-model="form.closeOnReversal" type="checkbox" />
            <label for="scalp_rev">趋势反转平仓（方向相反先平掉再开）</label>
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
      <div class="k">总净收益（USDT）</div>
      <div :class="['v', totalNetPnl == null ? '' : totalNetPnl >= 0 ? 'up' : 'down']">{{ totalNetPnl == null ? "—" : fmtNum(totalNetPnl, 4) }}</div>
    </div>
    <div class="card">
      <div class="k">已实现净盈亏</div>
      <div :class="['v', (overview?.realizedNetPnl ?? 0) >= 0 ? 'up' : 'down']">{{ fmtNum(overview?.realizedNetPnl ?? 0, 4) }}</div>
    </div>
    <div class="card">
      <div class="k">未实现收益</div>
      <div :class="['v', (overview?.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down']">{{ fmtNum(overview?.unrealizedPnl ?? 0, 4) }}</div>
    </div>
    <div class="card">
      <div class="k">总手续费</div>
      <div class="v down">{{ fmtNum(overview?.totalFee ?? 0, 4) }}</div>
    </div>
    <div class="card">
      <div class="k">开单笔数</div>
      <div class="v">{{ filteredTrades.length }}<span class="hint"> / {{ overview?.trades?.length ?? 0 }}</span></div>
    </div>
  </div>

  <div class="panel">
    <h2>超短线战绩<span class="spacer"></span>
      <span class="hint" style="font-weight:400">
        <template v-if="hasRange">区间内（{{ rangeText }}）已平仓 {{ stats?.samples ?? 0 }} 笔 · 按开单时间判定，与下方开仓记录同一区间</template>
        <template v-else>样本 = 全部已平仓 {{ stats?.samples ?? 0 }} 笔 · 在下方填入日期可按区间查看</template>
      </span>
    </h2>
    <div class="body">
      <template v-if="!stats">
        <div v-if="hasRange && rangeLoading" class="empty">正在统计 {{ rangeText }} 的战绩…</div>
        <div v-else-if="hasRange && rangeErr" class="empty">区间统计加载失败：{{ rangeErr }}</div>
        <div v-else class="empty">统计数据不可用。请执行 npm run build 重新构建后用 npm run ui 启动界面。</div>
      </template>
      <template v-else>
        <div v-if="stats.samples" class="st-tiles">
          <div class="st-tile">
            <div class="st-k">胜率</div>
            <div class="st-v">{{ pct1(stats.winRate) }}</div>
            <div class="st-s">赢 {{ stats.wins }} · 亏 {{ stats.losses }}<template v-if="stats.flats"> · 平 {{ stats.flats }}</template></div>
          </div>
          <div class="st-tile">
            <div class="st-k">盈亏比（盈利合计 ÷ 亏损合计）</div>
            <div class="st-v">{{ stats.profitFactor == null ? "—" : fmtNum(stats.profitFactor, 2) }}</div>
            <div class="st-s">盈合计 {{ fmtNum(stats.grossProfit, 4) }} · 亏合计 {{ fmtNum(stats.grossLoss, 4) }}</div>
          </div>
          <div class="st-tile">
            <div class="st-k">每笔期望（USDT）</div>
            <div :class="['st-v', (stats.expectancy ?? 0) >= 0 ? 'up' : 'down']">{{ fmtNum(stats.expectancy, 4) }}</div>
            <div class="st-s">均盈 {{ fmtNum(stats.avgWin, 4) }} · 均亏 {{ fmtNum(stats.avgLoss, 4) }}</div>
          </div>
          <div class="st-tile">
            <div class="st-k">最大回撤（USDT）</div>
            <div class="st-v">{{ fmtNum(stats.maxDrawdown, 4) }}</div>
            <div class="st-s">累计曲线自高点回落的最大幅度（起点按 0 计）</div>
          </div>
        </div>
        <div v-else class="empty">暂无可统计的已平仓样本{{ hasRange ? "（当前区间内）" : "" }}</div>

        <div v-if="stats.samples" class="st-eq">
          <svg viewBox="0 0 600 120" preserveAspectRatio="none" :class="eqCls">
            <polygon v-if="spark.points" :points="spark.area" class="eq-area" />
            <line v-if="spark.zeroY != null" x1="8" :y1="spark.zeroY" x2="592" :y2="spark.zeroY" class="eq-zero" />
            <polyline v-if="spark.points" :points="spark.points" class="eq-line" vector-effect="non-scaling-stroke" />
          </svg>
          <div class="hint">累计净收益曲线（只含已同步的平仓单）· 虚线为零轴 · 当前合计 {{ fmtNum(stats.netPnl, 4) }} USDT</div>
        </div>

        <div v-if="stats.unsettled" class="alert" style="margin-top:12px">
          另有 <b>{{ stats.unsettled }}</b> 笔已平仓但未取到平仓价，净盈亏未知 —— <b>未计入以上任何统计</b>。
          这几笔被排除而非按 0 计入：若按 0 算，它们会同时把总收益算歪、把胜率稀释。
        </div>

        <div class="st-cols">
          <div>
            <div class="st-h">判断来源对比</div>
            <table v-if="judgeRows.length">
              <thead><tr><th>来源</th><th>已同步</th><th>胜率</th><th>净盈亏</th></tr></thead>
              <tbody>
                <tr v-for="r in judgeRows" :key="r.judge">
                  <td><span :class="['tag', r.judge === 'llm' ? 't-info' : 't-hold']">{{ judgeText(r.judge) }}</span></td>
                  <td>
                    {{ r.samples }}
                    <span v-if="r.unsettled" class="hint" style="font-weight:400">（另有 {{ r.unsettled }} 笔未同步）</span>
                  </td>
                  <td>{{ pct1(r.winRate) }}</td>
                  <td :class="r.netPnl >= 0 ? 'up' : 'down'">{{ r.samples ? fmtNum(r.netPnl, 4) : "—" }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="empty">暂无样本</div>
            <div class="hint" style="margin-top:6px">「LLM 介入」值不值得开，就看这两行的胜率与净盈亏差</div>
          </div>
          <div>
            <div class="st-h">循环为什么没开单（{{ hasRange ? "区间内" : "近" }} {{ stats.tickTotal }} 轮）</div>
            <div v-for="r in skipRows" :key="r.key" class="st-bar">
              <span class="st-bar-k" :title="r.label">{{ r.label }}</span>
              <span class="st-track"><i :style="{ width: (r.count / skipMax) * 100 + '%' }"></i></span>
              <span class="st-bar-v">{{ r.count }}</span>
            </div>
            <div v-if="!skipRows.length" class="empty">暂无循环监测记录</div>
            <div class="hint" style="margin-top:6px">其中成功开单 {{ stats.tickOpened }} 轮</div>
          </div>
        </div>
      </template>
    </div>
  </div>

  <div class="panel">
    <h2>当前持仓<span class="spacer"></span>
      <button class="danger" :disabled="closing || !overview?.positions?.length" @click="closeAll">
        {{ closing ? "平仓中…" : "一键平仓" }}
      </button>
    </h2>
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
      <div class="row" style="margin-bottom:8px">
        <label>日期筛选</label>
        <input v-model="dateFrom" type="date" style="max-width:150px" />
        <span class="hint">至</span>
        <input v-model="dateTo" type="date" style="max-width:150px" />
        <button @click="dateFrom = ''; dateTo = ''">清除</button>
      </div>
      <table v-if="filteredTrades.length">
        <thead>
          <tr>
            <th>时间</th><th>标的</th><th>方向</th><th>判断</th>
            <th>开仓价</th><th>止损</th><th>止盈</th>
            <th>张数</th><th>杠杆</th><th>名义金额</th><th>保证金</th>
            <th>费率</th><th>手续费</th>
            <th>状态</th><th>平仓价</th><th>盈亏</th><th>净盈亏</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in [...filteredTrades].reverse()" :key="t.ts + t.entry">
            <td class="nowrap">{{ fmtTs(t.ts) }}</td>
            <td><b>{{ t.inst }}</b></td>
            <td><span :class="['tag', t.direction === 'short' ? 't-sell' : 't-buy']">{{ t.direction === "short" ? "空" : "多" }}</span></td>
            <td><span :class="['tag', t.judge === 'llm' ? 't-info' : 't-hold']">{{ t.judge === "llm" ? "LLM" : "规则" }}</span></td>
            <td>{{ t.entry }}</td>
            <td>{{ t.sl }}</td>
            <td>{{ t.tp }}</td>
            <td>{{ t.size }}</td>
            <td>{{ t.leverage }}x</td>
            <td>{{ fmtNum(t.notional, 2) }}</td>
            <td>{{ fmtNum(t.margin, 2) }}</td>
            <td>{{ ((t.feeRate ?? 0) * 100).toFixed(3) }}%</td>
            <td>{{ fmtNum(t.fee ?? 0, 4) }}</td>
            <td><span :class="['tag', t.status === 'open' ? 't-on' : 't-off']">{{ t.status === "open" ? "持仓中" : "已平仓" }}</span></td>
            <td>{{ t.closePrice ?? "—" }}</td>
            <td :class="t.pnl == null ? '' : t.pnl >= 0 ? 'up' : 'down'">{{ t.pnl == null ? "—" : fmtNum(t.pnl, 4) }}</td>
            <td :class="t.netPnl == null ? '' : t.netPnl >= 0 ? 'up' : 'down'">{{ t.netPnl == null ? "—" : fmtNum(t.netPnl, 4) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无开仓记录{{ dateFrom || dateTo ? "（当前筛选范围）" : "" }}</div>
    </div>
  </div>

  <div class="panel">
    <h2>循环监测记录</h2>
    <div class="body">
      <table v-if="overview?.ticks?.length">
        <thead>
          <tr><th>时间</th><th>方向</th><th>趋势</th><th>参考价</th><th>判断</th><th>结果</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in [...overview.ticks].reverse()" :key="t.ts + t.reason">
            <td class="nowrap">{{ fmtTs(t.ts) }}</td>
            <td>
              <span v-if="t.direction" :class="['tag', t.direction === 'short' ? 't-sell' : 't-buy']">{{ t.direction === "short" ? "空" : "多" }}</span>
              <span v-else>—</span>
            </td>
            <td>{{ t.strength || "—" }}</td>
            <td>{{ t.entry_ref ?? "—" }}</td>
            <td>
              <span v-if="t.judge" :class="['tag', t.judge === 'llm' ? 't-info' : 't-hold']">{{ t.judge === "llm" ? "LLM" : "规则" }}</span>
              <span v-else>—</span>
            </td>
            <td>
              <span :class="['tag', t.result === 'opened' ? 't-on' : t.result === 'skipped' ? 't-hold' : 't-sell']">
                {{ t.result === "opened" ? "已开单" : t.result === "skipped" ? "跳过" : "错误" }}
              </span>
            </td>
            <td class="wrap">{{ t.reason }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无循环监测记录（循环尚未运行或未产生记录）</div>
    </div>
  </div>
</template>

<style scoped>
/* 战绩面板：四个指标块 + 累计曲线 + 两张并排小表 */
.st-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px }
.st-tile { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 10px 12px }
.st-k { color: var(--dim); font-size: 11px; letter-spacing: .3px }
.st-v { margin-top: 2px; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums }
.st-s { margin-top: 4px; font-size: 11px; color: var(--dim); font-variant-numeric: tabular-nums }

/* 曲线：preserveAspectRatio=none 让宽度自适应，stroke 用 non-scaling-stroke 保住线宽 */
.st-eq { margin-top: 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 8px 10px 4px }
.st-eq svg { display: block; width: 100%; height: 120px }
.eq-line { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round }
.eq-area { fill: currentColor; opacity: .12; stroke: none }
.eq-zero { stroke: var(--border-strong); stroke-width: 1; stroke-dasharray: 4 4; vector-effect: non-scaling-stroke }

.st-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 16px }
.st-h { font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 8px }
.st-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11.5px }
.st-bar-k { flex: 0 0 44%; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.st-track { flex: 1; height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden }
.st-track i { display: block; height: 100%; border-radius: 3px; background: var(--blue); transition: width var(--ease) }
.st-bar-v { flex: 0 0 34px; text-align: right; font-variant-numeric: tabular-nums; color: var(--dim) }
</style>
