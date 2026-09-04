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
let offBt = null;
onMounted(() => {
  loadOverview();
  refreshLoopStatus();
  loadStrategies();
});
onActivated(loadOverview);
onMounted(() => {
  timer = setInterval(() => {
    if (document.visibilityState === "visible") loadOverview();
  }, 8000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  if (offBt) offBt();
});

function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── 自定义策略库（多策略 / LLM 生成 / 校验 / 应用实盘） ──
const strategies = ref([]); // StrategyMeta[]
const currentStrategyId = computed(() => store.scalper?.strategyId || "");

const editModal = ref(null); // {mode:'new'|'edit', id, name, desc, idea, code}
const genLoading = ref(false);
const saveLoading = ref(false);
const modalNote = ref("");
const modalErr = ref("");
const validateNote = ref(null);
const lastBtSummary = ref(""); // 最近一次回测摘要（供 LLM 优化策略）

async function loadStrategies() {
  try {
    const r = await api.strategyList();
    if (r?.ok) strategies.value = r.strategies || [];
  } catch {
    /* ignore */
  }
  // 回测默认跟随当前实盘使用的策略
  if (btForm.value && !btForm.value.strategyId) {
    btForm.value.strategyId = currentStrategyId.value || "";
  }
}

function openNewStrategy() {
  modalNote.value = "";
  modalErr.value = "";
  validateNote.value = null;
  editModal.value = { mode: "new", id: "", name: "", desc: "", idea: "", code: "" };
}
async function openEditStrategy(id) {
  try {
    const r = await api.strategyRead(id);
    if (!r?.ok || !r.strategy) throw new Error(r?.error || "读取失败");
    modalNote.value = "";
    modalErr.value = "";
    validateNote.value = null;
    editModal.value = {
      mode: "edit",
      id: r.strategy.id,
      name: r.strategy.name,
      desc: r.strategy.desc || "",
      idea: "",
      code: r.strategy.code || "",
    };
  } catch (e) {
    toastErr(e, "读取策略失败");
  }
}

/** LLM 生成 / 改写策略（内置规则在 system prompt：signal(ctx) 接口 + 安全红线 + 参考模板） */
async function llmGen() {
  const m = editModal.value;
  if (!m) return;
  if (!m.name.trim()) {
    modalErr.value = "请先填写策略名称";
    return;
  }
  if (!m.idea.trim()) {
    modalErr.value = m.code?.trim() ? "请描述本轮改进方向" : "请用一两句话描述你想要的策略思路";
    return;
  }
  genLoading.value = true;
  modalErr.value = "";
  modalNote.value = "";
  validateNote.value = null;
  try {
    const r = await api.strategyGen({
      name: m.name.trim(),
      idea: m.idea.trim(),
      existingCode: m.code?.trim() || undefined,
      lastSummary: lastBtSummary.value || undefined,
    });
    if (!r?.ok) {
      modalErr.value = r?.error || "生成失败，请稍后重试";
      return;
    }
    m.code = r.code || m.code;
    modalNote.value = `已由模型${r.modelId ? `（${r.modelId}）` : ""}生成代码。可在上方直接修改，然后点「保存并校验」。`;
  } catch (e) {
    modalErr.value = errText(e);
  } finally {
    genLoading.value = false;
  }
}

/** 保存策略 → 自动跑内置规则校验 */
async function doSaveStrategy() {
  const m = editModal.value;
  if (!m) return;
  if (!m.name.trim()) {
    modalErr.value = "策略名称不能为空";
    return;
  }
  if (!m.code?.trim()) {
    modalErr.value = "代码为空：先用「用 LLM 生成」，或直接手写 signal(ctx)";
    return;
  }
  saveLoading.value = true;
  modalErr.value = "";
  try {
    const r = await api.strategySave({
      id: m.id || undefined,
      name: m.name.trim(),
      desc: m.desc?.trim() || "",
      code: m.code,
    });
    if (!r?.ok) throw new Error(r?.error || "保存失败");
    const meta = r.meta || {};
    m.id = meta.id;
    // 校验（语法 + 红线 + 冒烟）。校验失败仍保留文件，方便修正，不直接关窗
    let v = null;
    try {
      v = await api.strategyValidate(meta.id);
    } catch {
      /* ignore */
    }
    validateNote.value = v || null;
    if (v?.ok) {
      toastOk(`策略 ${meta.id} 已保存并通过内置规则校验`);
      editModal.value = null;
    } else {
      const errs = v?.errors || ["校验失败"];
      modalErr.value = `已保存，但校验未通过：${errs.join("；")}`;
    }
    await loadStrategies();
    if (m.id === currentStrategyId.value) {
      await reload(); // 正在实盘生效的策略被更新 → 同步 store
    }
  } catch (e) {
    modalErr.value = errText(e);
  } finally {
    saveLoading.value = false;
  }
}

async function deleteStrategyRow(s) {
  if (
    !(await ask(`删除策略「${s.name}」（${s.id}）？策略文件将一并删除。`, {
      title: "删除策略",
      confirmText: "删除",
      danger: true,
    }))
  )
    return;
  try {
    const r = await api.strategyDelete(s.id);
    if (r?.ok) toastOk(r.msg || "已删除");
    else throw new Error(r?.error || "删除失败");
    await loadStrategies();
    await reload();
  } catch (e) {
    toastErr(e, "删除失败");
  }
}

async function applyStrat(id) {
  try {
    const r = await api.strategyApply(id);
    if (!r?.ok) throw new Error(r?.error || "应用失败");
    await reload();
    toastOk(id ? "已应用该策略：循环下一次 tick 生效" : "已恢复内置趋势策略");
  } catch (e) {
    toastErr(e, "应用失败");
  }
}

/** 直接回测某策略（切到回测面板并立即跑） */
async function btForStrategy(id) {
  btForm.value.strategyId = id;
  document.getElementById("scalper_bt")?.scrollIntoView({ behavior: "smooth", block: "start" });
  await runBacktest();
}

function buildBtSummary(r) {
  if (!r?.summary) return "";
  const s = r.summary;
  return `区间 ${r.start || ""} ~ ${r.end || ""}｜笔数 ${s.trades}，胜率 ${s.winRate ?? "-"}%，总净盈亏 $${fmtNum(s.totalNetPnlUsdt ?? 0, 2)}（${s.totalNetPnlPct ?? 0}%），盈亏比 ${fmtNum(s.profitFactor ?? 0, 2)}，最大回撤 ${s.maxDrawdownPct ?? 0}%，手续费 $${fmtNum(s.totalFeeUsdt ?? 0, 2)}，夏普 ${s.sharpe ?? "-"}`;
}

// ── 超短线回测（后台 job + 实时进度） ──
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
  strategyId: "",
});
const btRunning = ref(false);
const btResult = ref(null);
const btError = ref("");
const btProgress = ref(null); // {p, stage, msg}
let btJobId = "";
let btWatchdog = null;

function onBtEvent(ev) {
  if (!ev || !btJobId || ev.jobId !== btJobId) return;
  if (ev.type === "progress" || ev.type === "start") {
    btProgress.value = { p: ev.p ?? 0, stage: ev.stage || "", msg: ev.msg || "" };
  } else if (ev.type === "done") {
    btRunning.value = false;
    btProgress.value = null;
    btResult.value = ev.result || null;
    if (btResult.value) lastBtSummary.value = buildBtSummary(btResult.value);
    if (btWatchdog) clearInterval(btWatchdog);
  } else if (ev.type === "error") {
    btRunning.value = false;
    btProgress.value = null;
    btError.value = ev.error || "回测失败";
    if (btWatchdog) clearInterval(btWatchdog);
  }
}

function openInWindow() {
  try {
    api.openScalperWindow();
  } catch (e) {
    btError.value = errText(e);
  }
}

async function runBacktest() {
  if (btRunning.value) return;
  btRunning.value = true;
  btResult.value = null;
  btError.value = "";
  btProgress.value = { p: 1, stage: "启动", msg: "正在拉起回测进程…" };
  try {
    const start = btForm.value.start ? btForm.value.start.replace("T", " ") + ":00" : "";
    const end = btForm.value.end ? btForm.value.end.replace("T", " ") + ":00" : "";
    const r = await api.scalperBtStart({
      inst: String(btForm.value.inst || "BTC-USDT-SWAP").trim().toUpperCase(),
      start,
      end,
      atrMult: Number(btForm.value.atrMult) || 2.5,
      feeRate: Number(btForm.value.feeRate) || 0.0005,
      notional: Number(btForm.value.notional) || 10000,
      closeOnReversal: !!btForm.value.closeOnReversal,
      strategyId: btForm.value.strategyId || "",
    });
    if (!r?.ok) throw new Error(r?.error || "启动失败");
    btJobId = r.jobId;
    if (!offBt) offBt = api.onScalperBtEvent(onBtEvent);
    btWatchdog = setInterval(() => {
      // 兜底：事件丢失时轮询一次
      if (!btJobId || !btRunning.value) return;
      api.scalperBtGet(btJobId).then((rr) => {
        if (rr && rr.jobId === btJobId && rr.state !== "running") {
          onBtEvent({
            type: rr.state === "done" ? "done" : "error",
            jobId: rr.jobId,
            result: rr.result,
            error: rr.error || rr.msg,
            p: rr.p,
            stage: rr.stage,
            msg: rr.msg,
          });
        }
      });
    }, 3000);
  } catch (e) {
    btRunning.value = false;
    btProgress.value = null;
    btError.value = errText(e);
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

  <!-- ── 策略库：多策略 / LLM 生成 / 应用实盘 ── -->
  <div class="panel">
    <h2>策略库<span class="spacer"></span>
      <button class="primary" @click="openNewStrategy">＋ 新建策略（LLM 生成）</button>
    </h2>
    <div class="body">
      <table v-if="strategies.length">
        <thead>
          <tr><th>策略</th><th>说明</th><th>更新时间</th><th>实盘循环</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><b>内置趋势策略</b><span class="hint">（默认）</span></td>
            <td>最近 5 根 1m 斜率判向 + ATR 止损 + 凯利 RR 止盈</td>
            <td class="nowrap">—</td>
            <td><span v-if="!currentStrategyId" class="tag t-on">当前</span><span v-else class="hint">—</span></td>
            <td class="nowrap">
              <button class="sm" @click="btForStrategy('')">回测</button>
              <button v-if="currentStrategyId" class="sm" @click="applyStrat('')">恢复应用</button>
            </td>
          </tr>
          <tr v-for="s in strategies" :key="s.id">
            <td><b>{{ s.name }}</b><span class="hint">{{ s.id }}</span></td>
            <td class="wrap">{{ s.desc || "—" }}</td>
            <td class="nowrap">{{ fmtTs(s.updatedAt) }}</td>
            <td><span v-if="currentStrategyId === s.id" class="tag t-on">当前</span><span v-else class="hint">—</span></td>
            <td class="nowrap">
              <button class="sm" @click="btForStrategy(s.id)">回测</button>
              <button class="sm" :disabled="currentStrategyId === s.id" @click="applyStrat(s.id)">应用到循环</button>
              <button class="sm" @click="openEditStrategy(s.id)">编辑</button>
              <button class="sm danger" @click="deleteStrategyRow(s)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">
        还没有自定义策略。
        <a href="javascript:void(0)" @click="openNewStrategy">点此新建</a>：描述策略思路，让 LLM 按内置规则帮你写好 signal()，
        然后就能一键回测 / 应用到超短线循环。
      </div>
      <div class="hint" style="margin-top:8px">
        内置规则：策略只实现 <code>signal(ctx)</code> 判向（long/short/flat + 一句理由），可覆盖 ATR 止损系数 / 盈亏比；
        禁止危险 import、禁止未来数据。策略在引擎内逐根执行——同一份代码既回测也实盘。
      </div>
    </div>
  </div>

  <div class="panel">
    <h2 id="scalper_bt">超短线回测<span class="spacer"></span>
      <button class="sm" @click="openInWindow">新窗口打开</button>
    </h2>
    <div class="body">
      <div class="row">
        <label>标的</label>
        <input v-model="btForm.inst" placeholder="BTC-USDT-SWAP" style="max-width:200px" />
      </div>
      <div class="row">
        <label>回测策略</label>
        <select v-model="btForm.strategyId" style="max-width:260px">
          <option value="">内置趋势策略（默认）</option>
          <option v-for="s in strategies" :key="s.id" :value="s.id">{{ s.name }}（{{ s.id }}）</option>
        </select>
        <span class="hint">下拉即回测该策略；内置为原超短线规则</span>
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
        <button class="primary" :disabled="btRunning" @click="runBacktest">
          {{ btRunning ? "回测中 " + (btProgress?.p ?? 0) + "%…" : "开始回测" }}
        </button>
        <span class="hint">
          {{ btForm.strategyId ? "回测自定义策略（逐根调用 signal，支持 flat 观望）" : "回放内置超短线规则（5 根 1m 斜率 + ATR 止损 + 凯利 RR 止盈）" }}
        </span>
      </div>
      <div v-if="btRunning" class="row" style="margin-top:6px">
        <label>进度</label>
        <div class="sg-pbar"><div class="sg-pfill" :style="{ width: (btProgress?.p || 1) + '%' }"></div></div>
        <span class="hint">{{ btProgress?.p || 1 }}% · {{ btProgress?.stage || "" }} {{ btProgress?.msg || "" }}</span>
      </div>
      <div v-if="btError" class="alert err" style="margin-top:6px">{{ btError }}</div>
    </div>
  </div>

  <template v-if="btResult && btResult.summary">
    <div class="hint" style="margin:8px 2px 0">
      <span v-if="btForm.strategyId" :class="['tag','t-info']">策略：{{ strategies.find((s) => s.id === btForm.strategyId)?.name || btForm.strategyId }}</span>
      <span v-else :class="['tag','t-hold']">内置趋势策略</span>
      结果摘要已记录——在「编辑策略」弹窗里点「LLM 改写优化」会自动带上本次回测做针对性改进。
    </div>
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

  <!-- 新建 / 编辑策略弹窗（LLM 生成 + 手改 + 保存校验） -->
  <div v-if="editModal" class="modal" @click.self="editModal = null">
    <div class="box" style="width:820px;max-width:94vw">
      <h3>{{ editModal.id ? "编辑策略 " + editModal.id : "新建策略（用 LLM 生成）" }}</h3>
      <div class="body">
        <div class="row">
          <label>名称</label>
          <input v-model="editModal.name" placeholder="如：波动突破三滤网" style="max-width:280px" />
          <span class="hint">策略列表与回测下拉里显示</span>
        </div>
        <div class="row">
          <label>描述</label>
          <input v-model="editModal.desc" placeholder="一句话说明策略风格（可选）" style="min-width:320px" />
        </div>
        <div class="row">
          <label>思路</label>
          <textarea
            v-model="editModal.idea"
            :placeholder="editModal.code?.trim() ? '本轮改进方向，如：减少假突破开仓、加 flat 观望滤网…' : '用大白话描述你想要的策略，如：1分钟突破前5分钟高点就做多，跌破就做空，但ATR波动太大时不开单…'"
            rows="2"
            class="sg-ta"
            style="min-width:520px"
          ></textarea>
        </div>
        <div class="row">
          <label></label>
          <button class="primary" :disabled="genLoading || saveLoading" @click="llmGen">
            {{ genLoading ? "模型生成中…（约 1~3 分钟）" : editModal.code?.trim() ? "用 LLM 改写优化（带上次回测摘要）" : "用 LLM 生成代码" }}
          </button>
          <span class="hint">内置规则已注入：只写 signal(ctx)、禁危险 import、止损止盈由引擎统一算</span>
        </div>
        <div v-if="modalNote" class="alert info" style="margin-top:6px">{{ modalNote }}</div>
        <div style="margin-top:8px"><b>strategy.py 代码</b> <span class="hint">（生成后仍可直接修改）</span></div>
        <textarea
          v-model="editModal.code"
          class="sg-code"
          spellcheck="false"
          placeholder="# 点上方按钮让 LLM 生成，或直接手写：&#10;def signal(ctx):&#10;    # ctx: closes/highs/lows/vols/ts(1m,升序)/n/atr/price&#10;    # 返回 {&quot;direction&quot;: &quot;long&quot;|&quot;short&quot;|&quot;flat&quot;, &quot;reason&quot;: &quot;中文依据&quot;}&#10;    return {&quot;direction&quot;: &quot;flat&quot;, &quot;reason&quot;: &quot;观望&quot;}"
        ></textarea>
        <div v-if="modalErr" class="alert err" style="margin-top:6px">{{ modalErr }}</div>
        <div v-if="validateNote && !validateNote.ok" class="alert err" style="margin-top:6px">
          内置规则校验未通过：<span v-for="(er, i) in validateNote.errors || []" :key="i"><br />· {{ er }}</span>
          <div v-if="(validateNote.warnings || []).length" class="hint">提示：{{ validateNote.warnings.join("；") }}</div>
        </div>
      </div>
      <div class="foot">
        <button @click="editModal = null">取消</button>
        <button class="primary" :disabled="genLoading || saveLoading" @click="doSaveStrategy">
          {{ saveLoading ? "保存校验中…" : "保存并校验" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sg-pbar {
  flex: 1;
  min-width: 180px;
  max-width: 320px;
  height: 8px;
  border-radius: 5px;
  background: var(--bg, rgba(255, 255, 255, 0.08));
  overflow: hidden;
}
.sg-pfill {
  height: 100%;
  border-radius: 5px;
  background: linear-gradient(90deg, #37d67a, #7a5cff);
  transition: width 0.4s ease;
}
.sg-ta,
.sg-code {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg, rgba(0, 0, 0, 0.35));
  color: var(--fg, #e8e8ec);
  border: 1px solid var(--line, rgba(255, 255, 255, 0.14));
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  resize: vertical;
}
.sg-ta {
  font-family: inherit;
}
.sg-code {
  min-height: 260px;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace;
  font-size: 12px;
  line-height: 1.5;
  margin-top: 4px;
  tab-size: 4;
}
</style>
