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

// 开仓记录按时间日期筛选
const filteredTrades = computed(() => {
  const list = overview.value?.trades ?? [];
  const from = dateFrom.value ? new Date(`${dateFrom.value}T00:00:00`).getTime() : null;
  const to = dateTo.value ? new Date(`${dateTo.value}T23:59:59.999`).getTime() : null;
  if (from == null && to == null) return list;
  return list.filter((t) => {
    const ts = new Date(t.ts).getTime();
    if (from != null && ts < from) return false;
    if (to != null && ts > to) return false;
    return true;
  });
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

let timer = null;
onMounted(() => {
  loadOverview();
  refreshLoopStatus();
});
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

// ── 超短线回测 ──
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const _now = new Date();
const btForm = ref({
  inst: "BTC-USDT-SWAP",
  start: toLocalInput(new Date(_now.getTime() - 7 * 24 * 3600 * 1000)),
  end: toLocalInput(_now),
  atrMult: 2.5,
  feeRate: 0.0005,
  notional: 10000,
  closeOnReversal: false,
});
const btRunning = ref(false);
const btResult = ref(null);
const btError = ref("");

function openInWindow() {
  try {
    api.openScalperWindow();
  } catch (e) {
    btError.value = errText(e);
  }
}

async function runBacktest() {
  btRunning.value = true;
  btResult.value = null;
  btError.value = "";
  try {
    const start = btForm.value.start ? btForm.value.start.replace("T", " ") + ":00" : "";
    const end = btForm.value.end ? btForm.value.end.replace("T", " ") + ":00" : "";
    const r = await api.scalperBacktest({
      inst: String(btForm.value.inst || "BTC-USDT-SWAP").trim().toUpperCase(),
      start,
      end,
      atrMult: Number(btForm.value.atrMult) || 2.5,
      feeRate: Number(btForm.value.feeRate) || 0.0005,
      notional: Number(btForm.value.notional) || 10000,
      closeOnReversal: !!btForm.value.closeOnReversal,
    });
    if (r?.error) btError.value = r.error;
    else btResult.value = r;
  } catch (e) {
    btError.value = errText(e);
  } finally {
    btRunning.value = false;
  }
}
</script>

<template>
  <div class="panel">
    <h2>超短线（超高频）<span class="spacer"></span>
      <span :class="['tag', form.enabled ? 't-on' : 't-off']">{{ form.enabled ? "已启用" : "已停用" }}</span>
    </h2>
    <div class="body">
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

  <div class="panel">
    <h2>超短线回测<span class="spacer"></span>
      <button class="sm" @click="openInWindow">新窗口打开</button>
    </h2>
    <div class="body">
      <div class="row">
        <label>标的</label>
        <input v-model="btForm.inst" placeholder="BTC-USDT-SWAP" style="max-width:200px" />
      </div>
      <div class="row">
        <label>时间区间</label>
        <input v-model="btForm.start" type="datetime-local" style="max-width:210px" />
        <span class="hint">至</span>
        <input v-model="btForm.end" type="datetime-local" style="max-width:210px" />
      </div>
      <div class="row">
        <label>参数</label>
        <input v-model.number="btForm.atrMult" type="number" step="0.1" style="max-width:96px" title="ATR 系数" />
        <span class="hint">ATR×</span>
        <input v-model.number="btForm.feeRate" type="number" step="0.0001" style="max-width:104px" title="单边费率" />
        <span class="hint">费率</span>
        <input v-model.number="btForm.notional" type="number" step="100" style="max-width:110px" title="每笔名义金额" />
        <span class="hint">名义USDT</span>
        <span class="chk" style="display:inline-flex;gap:6px;align-items:center">
          <input id="bt_rev" v-model="btForm.closeOnReversal" type="checkbox" />
          <label for="bt_rev">趋势反转平仓</label>
        </span>
      </div>
      <div class="row" style="margin-top:6px">
        <button class="primary" :disabled="btRunning" @click="runBacktest">{{ btRunning ? "回测中…" : "开始回测" }}</button>
        <span class="hint">拉取区间 1 分钟数据，回放超短线策略（5 根 1m 斜率 + ATR 止损 + 凯利 RR 止盈）</span>
      </div>
      <div v-if="btError" class="alert err" style="margin-top:6px">{{ btError }}</div>
    </div>
  </div>

  <template v-if="btResult && btResult.summary">
    <div class="cards">
      <div class="card"><div class="k">回测笔数</div><div class="v">{{ btResult.summary.trades }}</div></div>
      <div class="card"><div class="k">胜率</div><div class="v">{{ btResult.summary.winRate == null ? "—" : btResult.summary.winRate + "%" }}</div></div>
      <div class="card"><div class="k">总净盈亏(USDT)</div><div :class="['v', btResult.summary.totalNetPnlUsdt >= 0 ? 'up' : 'down']">{{ fmtNum(btResult.summary.totalNetPnlUsdt, 2) }}</div></div>
      <div class="card"><div class="k">总净盈亏(%)</div><div :class="['v', btResult.summary.totalNetPnlPct >= 0 ? 'up' : 'down']">{{ fmtNum(btResult.summary.totalNetPnlPct, 3) }}%</div></div>
      <div class="card"><div class="k">盈亏比</div><div class="v">{{ btResult.summary.profitFactor == null ? "—" : fmtNum(btResult.summary.profitFactor, 2) }}</div></div>
      <div class="card"><div class="k">最大回撤</div><div class="v down">{{ fmtNum(btResult.summary.maxDrawdownPct, 2) }}%</div></div>
      <div class="card"><div class="k">总手续费</div><div class="v">{{ fmtNum(btResult.summary.totalFeeUsdt, 2) }}</div></div>
      <div class="card"><div class="k">夏普</div><div class="v">{{ btResult.summary.sharpe == null ? "—" : fmtNum(btResult.summary.sharpe, 2) }}</div></div>
    </div>
    <div v-if="btResult.cache" class="hint" style="margin-top:6px">
      数据缓存：库内命中 {{ btResult.cache.fromDb || 0 }} 根，本次新拉 {{ btResult.cache.fetched || 0 }} 根（SQLite：agent/data/scalper_candles.db）
    </div>

    <div class="panel">
      <h2>回测明细（{{ btResult.trades?.length || 0 }} 笔）</h2>
      <div class="body">
        <table v-if="btResult.trades?.length">
          <thead>
            <tr>
              <th>#</th><th>方向</th><th>开仓时间</th><th>平仓时间</th>
              <th>开仓价</th><th>平仓价</th><th>止损</th><th>止盈</th>
              <th>持仓(分)</th><th>原因</th><th>盈亏(USDT)</th><th>手续费</th><th>净盈亏(USDT)</th><th>净盈亏(%)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in btResult.trades" :key="t.n">
              <td>{{ t.n }}</td>
              <td><span :class="['tag', t.side === 'short' ? 't-sell' : 't-buy']">{{ t.side === "short" ? "空" : "多" }}</span></td>
              <td class="nowrap">{{ t.entryTs }}</td>
              <td class="nowrap">{{ t.exitTs }}</td>
              <td>{{ t.entry }}</td>
              <td>{{ t.exit }}</td>
              <td>{{ t.sl }}</td>
              <td>{{ t.tp }}</td>
              <td>{{ t.bars }}</td>
              <td>{{ t.reason }}</td>
              <td :class="t.pnlUsdt >= 0 ? 'up' : 'down'">{{ fmtNum(t.pnlUsdt, 2) }}</td>
              <td>{{ fmtNum(t.feeUsdt, 2) }}</td>
              <td :class="t.netPnlUsdt >= 0 ? 'up' : 'down'">{{ fmtNum(t.netPnlUsdt, 2) }}</td>
              <td :class="t.netPnlPct >= 0 ? 'up' : 'down'">{{ fmtNum(t.netPnlPct, 4) }}%</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">该区间未产生交易</div>
      </div>
    </div>
  </template>
</template>
