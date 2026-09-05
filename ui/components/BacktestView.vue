<script setup>
/**
 * BacktestView.vue —— 策略回测（独立板块）
 * 策略库（内置 + 自定义 / LLM 生成 / 校验 / 应用到实盘循环）+ 逐根回放回测（后台 job + 实时进度）
 * 原为 ScalperView 内嵌面板，因页面过载独立成 tab。策略仍作用于超短线实盘循环。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { store, reload } from "../store/index.js";
import { api, errText } from "../lib/api.js";
import { toastOk, toastErr, ask } from "../lib/feedback.js";
import { fmtNum } from "../lib/format.js";

// ── 自定义策略库（多策略 / LLM 生成 / 校验 / 应用实盘） ──
const strategies = ref([]); // StrategyMeta[]
const currentStrategyId = computed(() => store.scalper?.strategyId || "");
const filterCat = ref(""); // 分类筛选：''=全部
const CATEGORY_ORDER = ["趋势跟踪", "均值回归", "突破通道", "自定义"];
/** 引擎内置默认（无文件的引擎规则）：并入「趋势跟踪」分组 */
const ENGINE_ENTRY = {
  id: "",
  name: "内置趋势策略",
  desc: "最近 5 根 1m 收盘斜率判向 + ATR 止损 + 凯利 RR 止盈（引擎内置规则）",
  builtin: true,
  engine: true,
  category: "趋势跟踪",
  updatedAt: "",
};
const catOptions = computed(() => {
  const set = new Set((strategies.value || []).map((s) => s.category || "自定义"));
  return ["", ...CATEGORY_ORDER.filter((c) => set.has(c))];
});
const catCounts = computed(() => {
  const m = {};
  (strategies.value || []).forEach((s) => {
    const c = s.category || "自定义";
    m[c] = (m[c] || 0) + 1;
  });
  return m;
});
const builtinCount = computed(() => (strategies.value || []).filter((s) => s.builtin).length);
const customCount = computed(() => (strategies.value || []).filter((s) => !s.builtin).length);
/** 分组展示：按分类分组；引擎内置默认在趋势跟踪组顶部，各分类组可独立回测/应用 */
const groups = computed(() => {
  const src = filterCat.value
    ? (strategies.value || []).filter((s) => (s.category || "自定义") === filterCat.value)
    : strategies.value || [];
  const gs = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: src.filter((s) => (s.category || "自定义") === cat),
  })).filter((g) => g.items.length);
  if (!filterCat.value || filterCat.value === "趋势跟踪") {
    const tg = gs.find((g) => g.cat === "趋势跟踪");
    const en = { ...ENGINE_ENTRY };
    if (tg) tg.items.unshift(en);
    else gs.unshift({ cat: "趋势跟踪", items: [en] });
  }
  return gs;
});

// ── 批量回测：勾选 → 串行队列依次回测，结果回填到每行「最近回测」 ──
/** 勾选集合（key = 策略 id；引擎默认行 key = "__engine"） */
const selKeys = ref([]);
const RES_KEY = "btBatchResV1";
function loadRowRes() {
  try {
    return JSON.parse(sessionStorage.getItem(RES_KEY) || "null") || {};
  } catch {
    return {};
  }
}
/** key -> { at, ok, summary?, error? }：该策略最近一次回测摘要（本会话保留） */
const rowRes = ref(loadRowRes());
function saveRowRes() {
  try {
    sessionStorage.setItem(RES_KEY, JSON.stringify(rowRes.value));
  } catch {
    /* ignore */
  }
}
const keyOf = (s) => (s && s.engine ? "__engine" : (s && s.id) || "__engine");
/** 当前筛选下出现的全部策略行（含引擎默认基准行） */
const allRows = computed(() => groups.value.flatMap((g) => g.items));
const isSel = (k) => selKeys.value.includes(k);
const allSel = computed(() => allRows.value.length > 0 && allRows.value.every((s) => isSel(keyOf(s))));
function toggleSel(k) {
  const i = selKeys.value.indexOf(k);
  if (i >= 0) selKeys.value.splice(i, 1);
  else selKeys.value.push(k);
}
function toggleAllSel() {
  selKeys.value = allSel.value ? [] : allRows.value.map((s) => keyOf(s));
}
function clearSel() {
  selKeys.value = [];
}
function selNames() {
  const m = new Map(allRows.value.map((s) => [keyOf(s), s.name]));
  return selKeys.value.map((k) => m.get(k) || k).join("、");
}
function rowSummary(k) {
  const r = rowRes.value[k];
  return r && r.ok && r.summary ? r.summary : null;
}
function rowFailMsg(k) {
  const r = rowRes.value[k];
  return r && !r.ok ? String(r.error || "回测失败").slice(0, 120) : "";
}
function rowResAt(k) {
  return rowRes.value[k]?.at || "";
}
/** 把一次回测结果写进行内记录（单跑 / 批量共用；无摘要的成功结果不算成功） */
function noteRowRes(k, ok, payload) {
  if (ok) {
    const sum = payload && payload.summary;
    if (!sum) return;
    rowRes.value[k] = { at: new Date().toISOString(), ok: true, summary: sum };
  } else {
    rowRes.value[k] = { at: new Date().toISOString(), ok: false, error: String(payload || "回测失败").slice(0, 300) };
  }
  saveRowRes();
}
/** hero 统计 */
const btOkCount = computed(() => Object.values(rowRes.value).filter((v) => v && v.ok).length);
const btAllResCount = computed(() => Object.values(rowRes.value).filter((v) => v).length);

// ── 批量队列状态 ──
const batch = ref({ running: false, list: [], cancel: false, ok: 0, fail: 0, startedAt: 0 });
const live = ref({}); // key -> { st: 'wait'|'run', p, stage, msg }
const batchStopped = ref(false);
const btBusy = computed(() => batch.value.running || btRunning.value);

const editModal = ref(null); // {mode:'new'|'edit', id, name, desc, idea, code}
const genLoading = ref(false);
const saveLoading = ref(false);
const backfillLoading = ref(false);
/** 代码回填勾选：分别控制是否由 LLM 反推出 名称/描述/思路 覆盖到对应输入框 */
const bfWant = ref(["name", "desc", "idea"]);
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
  // 回测默认跟随当前实盘使用的策略；自动保存的旧策略已不存在时也回退跟随
  if (btForm.value && btForm.value.strategyId) {
    const known = (strategies.value || []).some((s) => s.id === btForm.value.strategyId);
    if (!known) btForm.value.strategyId = currentStrategyId.value || "";
  } else if (btForm.value) {
    btForm.value.strategyId = currentStrategyId.value || "";
  }
}

function openNewStrategy() {
  modalNote.value = "";
  modalErr.value = "";
  validateNote.value = null;
  editModal.value = { mode: "new", id: "", name: "", desc: "", idea: "", category: "自定义", code: "" };
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
      idea: r.strategy.idea || "",
      category: r.strategy.category || "自定义",
      code: r.strategy.code || "",
    };
  } catch (e) {
    toastErr(e, "读取策略失败");
  }
}
/** 复制内置（或已有）策略为自定义：载入代码进入「新建」态，保存即另存，原策略不变 */
async function openCopyStrategy(s) {
  try {
    const r = await api.strategyRead(s.id);
    if (!r?.ok || !r.strategy) throw new Error(r?.error || "读取失败");
    modalNote.value = `已载入「${r.strategy.name}」的代码作为起点：改好后点「保存并校验」会另存为新策略（原${
      s.builtin ? "内置" : "策略"
    }保持不变）。`;
    modalErr.value = "";
    validateNote.value = null;
    editModal.value = {
      mode: "copy",
      id: "",
      name: `${r.strategy.name}（副本）`,
      desc: r.strategy.desc || "",
      idea: r.strategy.idea || "",
      category: r.strategy.category || "自定义",
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

/** 按代码回填元信息：LLM 读懂 signal() 后反推 名称/描述/思路（各自可勾选，勾中的才覆盖） */
async function doBackfill() {
  const m = editModal.value;
  if (!m) return;
  if (!m.code?.trim()) {
    modalErr.value = "请先贴入或生成 strategy.py 代码";
    return;
  }
  const want = bfWant.value;
  if (!want.length) {
    modalErr.value = "请至少勾选一个要回填的字段（名称 / 描述 / 思路）";
    return;
  }
  backfillLoading.value = true;
  modalErr.value = "";
  modalNote.value = "";
  try {
    const r = await api.strategyBackfill({
      code: m.code,
      wantName: want.includes("name"),
      wantDesc: want.includes("desc"),
      wantIdea: want.includes("idea"),
      nameHint: m.name?.trim() || "",
    });
    if (!r?.ok) {
      modalErr.value = r?.error || "分析失败，请重试";
      return;
    }
    const filled = [];
    if (want.includes("name") && r.name) {
      m.name = r.name;
      filled.push("名称");
    }
    if (want.includes("desc") && r.desc) {
      m.desc = r.desc;
      filled.push("描述");
    }
    if (want.includes("idea") && r.idea) {
      m.idea = r.idea;
      filled.push("思路");
    }
    modalNote.value = filled.length
      ? `已由模型${r.modelId ? `（${r.modelId}）` : ""}按代码回填：${filled.join("、")}。可在上方修改后点「保存并校验」。`
      : "模型未返回有效内容，请重试";
  } catch (e) {
    modalErr.value = errText(e);
  } finally {
    backfillLoading.value = false;
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
      idea: m.idea?.trim() || "",
      category: m.category || "自定义",
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
  if (s.builtin) {
    toastErr(new Error("内置策略不可删除：可「复制为自定义」后修改"), "操作受限");
    return;
  }
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

/** 直接回测某策略（设置策略并立即跑） */
async function btForStrategy(id) {
  btForm.value.strategyId = id;
  document.getElementById("scalper_bt")?.scrollIntoView({ behavior: "smooth", block: "start" });
  await runBacktest();
}

function buildBtSummary(r) {
  if (!r?.summary) return "";
  const s = r.summary;
  const pa = r.params || {};
  let extra = "";
  if (pa.bar && pa.bar !== "1m") extra += `｜K线 ${barT(pa.bar)}`;
  if (pa.atrMult != null) extra += `｜ATR×${pa.atrMult}`;
  if (pa.rr != null) extra += ` RR ${(pa.rr ?? 0) > 0 ? `${pa.rr}×` : "自动"}`;
  if (pa.slippageBps) extra += ` 滑点${pa.slippageBps}bps`;
  if (pa.maxHold) extra += ` 超时${pa.maxHold}分`;
  return `区间 ${r.start || ""} ~ ${r.end || ""}${extra}｜笔数 ${s.trades}，胜率 ${s.winRate ?? "-"}%，总净盈亏 $${fmtNum(s.totalNetPnlUsdt ?? 0, 2)}（${s.totalNetPnlPct ?? 0}%），盈亏比 ${fmtNum(s.profitFactor ?? 0, 2)}，最大回撤 ${s.maxDrawdownPct ?? 0}%，手续费 $${fmtNum(s.totalFeeUsdt ?? 0, 2)}，夏普 ${s.sharpe ?? "-"}`;
}

// ── 超短线回测（后台 job + 实时进度） ──
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const INST_SUGGEST = [
  "BTC-USDT-SWAP",
  "ETH-USDT-SWAP",
  "SOL-USDT-SWAP",
  "DOGE-USDT-SWAP",
  "XRP-USDT-SWAP",
  "BNB-USDT-SWAP",
];
const QUICK_RANGES = [
  { d: 1, t: "近 1 天" },
  { d: 3, t: "近 3 天" },
  { d: 7, t: "近 7 天" },
  { d: 14, t: "近 14 天" },
  { d: 30, t: "近 1 月" },
];
/** 可选 K 线周期（批量回测多选时笛卡尔展开；非 1m 由 1m 本地聚合，数据只拉一次） */
const BT_BARS = [
  { v: "1m", t: "1m" },
  { v: "5m", t: "5m" },
  { v: "15m", t: "15m" },
  { v: "30m", t: "30m" },
  { v: "1H", t: "1h" },
  { v: "4H", t: "4h" },
];
/** 批量回测并行路数（多进程同时跑，数据缓存同段只拉一次） */
const BT_CONC = [
  { v: 1, t: "1", h: "逐格串行（最省资源，与旧版一致）" },
  { v: 2, t: "2", h: "同时跑 2 个回测进程" },
  { v: 3, t: "3", h: "默认：同时跑 3 个回测进程" },
  { v: 4, t: "4", h: "大网格快速跑完（行情只拉一次，同段写缓存由 SQLite 协调）" },
];
/** 区间拆分：不拆分 / 按天 / 按周 / 按月（批量时每段各回测一次，验证跨时段稳健性） */
const BT_SPLITS = [
  { v: "whole", t: "不拆分", h: "整个起止区间回测一次" },
  { v: "day", t: "按天", h: "区间按自然天拆成多段，逐段独立回测" },
  { v: "week", t: "按周", h: "区间按 7 天拆成多段，逐段独立回测" },
  { v: "month", t: "按月", h: "区间按自然月拆成多段，逐段独立回测" },
];
function btFormDefaults() {
  const now = new Date();
  return {
    inst: "BTC-USDT-SWAP",
    start: toLocalInput(new Date(now.getTime() - 7 * 24 * 3600 * 1000)),
    end: toLocalInput(now),
    bars: ["1m"], // 批量回测的 K 线周期集合（至少保留一个；单跑用第一个）
    split: "whole", // 批量回测的区间拆分方式
    concurrency: 3, // 批量回测并行路数（多进程同时跑）
    atrMult: 2.5,
    feeRate: 0.0005,
    notional: 10000,
    closeOnReversal: false,
    rrOverride: 0, // 固定止盈 RR：0=自动（内置凯利 / 策略显式返回优先）
    slippageBps: 0, // 单边滑点 bps（1 bps = 0.01%）
    maxHoldBars: 0, // 持仓最长分钟数：0 = 不限
    strategyId: "",
  };
}
const BT_PARAM_KEY = "btParamsV1";
/** 读取上次填写的回测参数（localStorage，跨重启保留；字段缺失时用默认值兜底） */
function loadBtParams() {
  try {
    const s = JSON.parse(localStorage.getItem(BT_PARAM_KEY) || "null");
    if (s && s.v === 1 && s.f && typeof s.f === "object") return { ...btFormDefaults(), ...s.f };
  } catch {
    /* ignore */
  }
  return btFormDefaults();
}
const btForm = ref(loadBtParams());
let saveBtTimer = null;
function saveBtParams(immediate = false) {
  if (saveBtTimer) {
    clearTimeout(saveBtTimer);
    saveBtTimer = null;
  }
  const doIt = () => {
    try {
      localStorage.setItem(BT_PARAM_KEY, JSON.stringify({ v: 1, f: btForm.value, savedAt: Date.now() }));
    } catch {
      /* ignore */
    }
  };
  if (immediate) doIt();
  else saveBtTimer = setTimeout(doIt, 350);
}
watch(btForm, () => saveBtParams(), { deep: true });
function resetBtParams() {
  Object.assign(btForm.value, btFormDefaults());
  saveBtParams(true);
  toastOk("已恢复默认回测参数（后续改动仍会自动保存）");
}
/** 快捷时间区间：结束设为当前，起始 = 当前往前 days 天 */
function quickRange(days) {
  const now = new Date();
  btForm.value.end = toLocalInput(now);
  btForm.value.start = toLocalInput(new Date(now.getTime() - days * 24 * 3600 * 1000));
}
const btRunning = ref(false);
const btResult = ref(null);
const btError = ref("");
const btProgress = ref(null); // {p, stage, msg}
let btJobId = "";
let btWatchdog = null;
let offBt = null;

function onBtEvent(ev) {
  if (!ev || !btJobId || ev.jobId !== btJobId) return;
  if (ev.type === "progress" || ev.type === "start") {
    btProgress.value = { p: ev.p ?? 0, stage: ev.stage || "", msg: ev.msg || "" };
  } else if (ev.type === "done") {
    btRunning.value = false;
    btProgress.value = null;
    btResult.value = ev.result || null;
    if (btResult.value) {
      lastBtSummary.value = buildBtSummary(btResult.value);
      const sid = btForm.value.strategyId || "";
      noteRowRes(sid ? sid : "__engine", !!btResult.value.summary, ev.result);
    }
    if (btWatchdog) clearInterval(btWatchdog);
  } else if (ev.type === "error") {
    btRunning.value = false;
    btProgress.value = null;
    btError.value = ev.error || "回测失败";
    const sid = btForm.value.strategyId || "";
    noteRowRes(sid ? sid : "__engine", false, ev.error || "回测失败");
    if (btWatchdog) clearInterval(btWatchdog);
  }
}

/** 组装一次回测的 job 参数（批量每格可覆盖周期 / 起止时间，其余共用控制台配置） */
function btParamsFor(o = {}) {
  const f = btForm.value;
  const startRaw = o.start ?? f.start;
  const endRaw = o.end ?? f.end;
  return {
    inst: String(f.inst || "BTC-USDT-SWAP").trim().toUpperCase(),
    start: startRaw ? String(startRaw).replace("T", " ") + ":00" : "",
    end: endRaw ? String(endRaw).replace("T", " ") + ":00" : "",
    bar: o.bar || (Array.isArray(f.bars) && f.bars.length ? f.bars[0] : "1m"),
    atrMult: Number(f.atrMult) || 2.5,
    feeRate: Number(f.feeRate) || 0.0005,
    notional: Number(f.notional) || 10000,
    rr: Math.max(0, Number(f.rrOverride) || 0),
    slippageBps: Math.max(0, Number(f.slippageBps) || 0),
    maxHold: Math.max(0, Math.round(Number(f.maxHoldBars) || 0)),
    closeOnReversal: !!f.closeOnReversal,
  };
}
/** 当前表单（首个周期 + 全区间）的默认参数，单跑 / 兼容旧调用用 */
function btParams() {
  return btParamsFor({});
}
const barT = (b) => (b === "1H" ? "1h" : b);
/** 当前区间按 split 拆成的子窗口 [{start,end,label}]；不拆分时为单个全区间 */
function winSegs() {
  const f = btForm.value;
  const s = f.start;
  const e = f.end;
  const whole = [{ start: s, end: e, label: "全区间" }];
  if (!s || !e) return whole;
  const mode = f.split || "whole";
  if (mode === "whole") return whole;
  const st = new Date(s);
  const en = new Date(e);
  if (en.getTime() <= st.getTime()) return whole;
  const p = (n) => String(n).padStart(2, "0");
  const fmt = (d) =>
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  const tag = { day: "D", week: "W", month: "M" }[mode] || "S";
  const out = [];
  let cur = new Date(st.getTime());
  let guard = 0;
  while (cur.getTime() < en.getTime() && guard++ < 500) {
    let nxt;
    if (mode === "month") nxt = new Date(cur.getFullYear(), cur.getMonth() + 1, 1, cur.getHours(), cur.getMinutes());
    else nxt = new Date(cur.getTime() + (mode === "week" ? 604800000 : 86400000));
    if (nxt.getTime() > en.getTime()) nxt = new Date(en.getTime());
    const a = fmt(cur);
    const b = fmt(nxt);
    const sh = (x) => x.slice(5).replace("-", "/").slice(0, 5); // MM/DD
    out.push({ start: a, end: b, label: `${tag}${String(out.length + 1).padStart(2, "0")} ${sh(a)}~${sh(b)}` });
    cur = nxt;
  }
  return out.length ? out : whole;
}
/** 是否处于「展开批量」：多周期或区间拆分 → 网格回测；否则等价于旧版单格批量 */
const expandDim = computed(() => {
  const bars = btForm.value?.bars || ["1m"];
  return bars.length > 1 || winSegs().length > 1;
});
const btBarOn = (v) => (btForm.value.bars || []).includes(v);
function toggleBtBar(v) {
  const b = btForm.value.bars || (btForm.value.bars = []);
  const i = b.indexOf(v);
  if (i >= 0) {
    if (b.length === 1) return; // 至少保留一个周期
    b.splice(i, 1);
  } else {
    b.push(v);
  }
}
function toggleBtSplit(v) {
  btForm.value.split = v;
}
/** 批量并行路数：取表单值 ∩ [1,4]，再按实际格子数封顶 */
function btConcurrency() {
  const n = Number(btForm.value?.concurrency) || 3;
  return Math.max(1, Math.min(4, n));
}
/** 策略集合 × 周期 × 时段 → 批量队列行（展开态每格独立 key，整段单周期保持策略 key） */
function expandRows(strats) {
  const bars = btForm.value?.bars?.length ? btForm.value.bars : ["1m"];
  const wins = winSegs();
  const expanded = bars.length > 1 || wins.length > 1;
  const rows = [];
  for (const st of strats) {
    for (const bar of bars) {
      for (const w of wins) {
        const grid = expanded;
        const key = grid ? `${st.key}|${bar}|${w.start}` : st.key;
        const sub = [];
        if (grid) sub.push(barT(bar));
        if (grid && w.label !== "全区间") sub.push(w.label);
        rows.push({
          key,
          strategyId: st.strategyId || "",
          name: st.name,
          bar,
          win: w.label,
          full: sub.length ? `${st.name} · ${sub.join(" · ")}` : st.name,
          start: w.start,
          end: w.end,
          grid,
        });
      }
    }
  }
  return rows;
}

/** 当前表单选中的回测范围描述（用于按钮 / 确认框） */
function btDimText() {
  const bars = btForm.value?.bars?.length ? btForm.value.bars : ["1m"];
  const wins = winSegs();
  return `${bars.length} 个周期(${bars.map(barT).join("/")}) × ${wins.length} 段${wins[0]?.label === "全区间" ? "" : `（${BT_SPLITS.find((x) => x.v === btForm.value.split)?.t || ""}拆分）`}`;
}
/** 批量确认框文案 */
function batchConfirmMsg(stN, rows) {
  const dims = rows.some((r) => r.grid)
    ? `${stN} 个策略 × ${btDimText()} = ${rows.length} 格`
    : `${stN} 个策略`;
  return `将以 ${btConcurrency()} 路并行回测 ${dims}，共用下方「回测控制台」的参数（标的/止损/止盈/成本…）。数据层按段按周期只拉一次行情、落 SQLite 缓存，已跑过的段重复回测秒开不重复请求。确认？`;
}

async function runBacktest() {
  if (batch.value.running) return; // 批量运行中不接受单跑/网格
  const sid = btForm.value.strategyId || "";
  const st0 = allRows.value.find((x) => x.id === sid);
  const rows = expandRows([
    { key: sid ? sid : "__engine", strategyId: sid, name: sid ? st0?.name || sid : "内置趋势策略" },
  ]);
  if (rows.length > 1) {
    // 多周期 / 时段拆分 → 展开成网格批量（每格独立一份结果）
    if (rows.length > 6 && !(await ask(batchConfirmMsg(1, rows), { title: "网格批量回测", confirmText: "开始批量回测" }))) return;
    await runBatch(rows);
    return;
  }
  // 单格（单周期 + 不拆分）：保留原实时进度 + 结果明细详情
  if (btRunning.value) return;
  btRunning.value = true;
  btResult.value = null;
  btError.value = "";
  btProgress.value = { p: 1, stage: "启动", msg: "正在拉起回测进程…" };
  try {
    const r = await api.scalperBtStart({ ...btParams(), strategyId: btForm.value.strategyId || "" });
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

/** 等一个回测 job 收尾：期间把实时进度写进 live[key]（轮询兜底，后端 240s 自毙会广播 error） */
function waitBtJob(jobId, key) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(r);
    };
    const poll = setInterval(async () => {
      try {
        const rr = await api.scalperBtGet(jobId);
        if (!rr || rr.jobId !== jobId) return;
        const lv = live.value[key];
        if (rr.state === "running" && lv) {
          lv.st = "run";
          if (typeof rr.p === "number") lv.p = rr.p;
          lv.stage = rr.stage || "";
          lv.msg = rr.msg || "";
        } else if (rr.state === "done") {
          finish({ ok: true, result: rr.result || null });
        } else if (rr.state === "error") {
          finish({ ok: false, error: rr.error || rr.msg || "回测失败" });
        }
      } catch {
        /* 下一轮再试 */
      }
    }, 2200);
    const timer = setTimeout(() => finish({ ok: false, error: "等待回测结果超时" }), 616_000);
  });
}

/** 策略 × 周期 × 时段的网格结果矩阵（展开批量时展示，滚动不丢，直到下一次批量） */
const lastGrid = ref(null); // { at, dim, rows: [{key, name, bar, win, status, at, sum, err}] }
function gridPatch(key, patch) {
  const g = lastGrid.value;
  if (!g) return;
  const it = g.rows.find((r) => r.key === key);
  if (it) Object.assign(it, patch);
}
function gridShort(r) {
  const s = r?.sum;
  if (!s) return "";
  return `${s.trades ?? 0} 笔 · 胜率 ${s.winRate ?? "-"}% · 净 ${fmtNum(s.totalNetPnlUsdt ?? 0, 1)} USDT（${fmtNum(s.totalNetPnlPct ?? 0, 3)}%）· PF ${fmtNum(s.profitFactor ?? 0, 2)} · 回撤 ${fmtNum(s.maxDrawdownPct ?? 0, 2)}%`;
}
const gridStateC = computed(() => ({
  ok: lastGrid.value ? lastGrid.value.rows.filter((r) => r.status === "ok").length : 0,
  err: lastGrid.value ? lastGrid.value.rows.filter((r) => r.status === "err").length : 0,
}));

/** 批量串行回测队列：rows 来自 expandRows（策略 key 或 策略×周期×时段 网格 key） */
async function runBatch(list) {
  if (btRunning.value) {
    toastErr(new Error("当前有单次回测在进行，请等它结束后再启动批量回测"), "无法批量回测");
    return;
  }
  if (batch.value.running) return;
  const rows = list.slice();
  if (!rows.length) {
    toastErr(new Error("没有可回测的策略"), "批量回测");
    return;
  }
  // 网格批量：重置上次详情展示，准备矩阵面板
  const isGrid = rows.some((r) => r.grid);
  if (isGrid) {
    btResult.value = null;
    btError.value = "";
    lastGrid.value = {
      at: new Date().toISOString(),
      dim: btDimText(),
      rows: rows.map((r) => ({ ...r, status: "wait", at: "", sum: null, err: "" })),
    };
  }
  const t0 = Date.now();
  const conc = btConcurrency();
  batch.value = { running: true, list: rows, cancel: false, ok: 0, fail: 0, startedAt: t0 };
  batchStopped.value = false;
  const lv = {};
  rows.forEach((r) => (lv[r.key] = { st: "wait", p: 0, stage: "", msg: "", name: r.grid ? r.full : r.name }));
  live.value = lv;
  /** 跑一个格子 → 更新矩阵/行内标记与成败计数（并发 worker 共用同一批 live/grid 状态） */
  const runCell = async (row) => {
    const cur = live.value[row.key];
    if (cur) {
      cur.st = "run";
      cur.p = 1;
      cur.stage = "启动";
      cur.msg = "";
    }
    if (isGrid) gridPatch(row.key, { status: "run" });
    try {
      // 每格覆盖 周期/起止时间，其余共用控制台参数（A/ATR/费率/滑点/止盈…）
      const params = btParamsFor({ bar: row.bar, start: row.start, end: row.end });
      const r = await api.scalperBtStart({ ...params, strategyId: row.strategyId || "" });
      if (!r?.ok) throw new Error(r?.error || "启动失败");
      const w = await waitBtJob(r.jobId, row.key);
      if (w.ok) {
        const rs = w.result?.summary;
        if (row.grid) {
          if (rs) gridPatch(row.key, { status: "ok", at: new Date().toISOString(), sum: rs });
          else gridPatch(row.key, { status: "err", err: "结果无摘要", at: new Date().toISOString() });
        } else noteRowRes(row.key, true, w.result);
        batch.value.ok += 1;
      } else {
        if (row.grid) gridPatch(row.key, { status: "err", err: String(w.error || "回测失败").slice(0, 300), at: new Date().toISOString() });
        else noteRowRes(row.key, false, w.error);
        batch.value.fail += 1;
      }
    } catch (e) {
      if (row.grid) gridPatch(row.key, { status: "err", err: errText(e).slice(0, 300), at: new Date().toISOString() });
      else noteRowRes(row.key, false, errText(e));
      batch.value.fail += 1;
    } finally {
      delete live.value[row.key];
    }
  };
  // 并行 worker 池：每路 worker 顺序领取下一格；点击「停止后续」后不再领新格（正在跑的格跑完自然结束）
  let next = 0;
  const worker = async () => {
    while (!batch.value.cancel) {
      const i = next++;
      if (i >= rows.length) break;
      await runCell(rows[i]);
    }
  };
  const nWorkers = Math.max(1, Math.min(conc, rows.length));
  await Promise.all(Array.from({ length: nWorkers }, () => worker()));
  const stopped = batch.value.cancel;
  const okN = batch.value.ok;
  const failN = batch.value.fail;
  const dur = Math.round((Date.now() - t0) / 1000);
  batch.value.running = false;
  batchStopped.value = stopped;
  if (isGrid) {
    toastOk(`批量网格回测${stopped ? "已停止" : "完成"}：成功 ${okN}${failN ? `，失败 ${failN}` : ""}，用时 ${dur}s —— 每格结果见上方「批量回测矩阵」`);
  } else {
    toastOk(
      `批量回测${stopped ? "已停止" : "完成"}：成功 ${okN}${failN ? `，失败 ${failN}` : ""}，用时 ${dur}s —— 结果已标记到各策略行`
    );
  }
}

function stopBatch() {
  if (!batch.value.running || batch.value.cancel) return;
  batch.value.cancel = true;
  toastOk("当前策略结束后将停止批量回测（已完成的行内标记会保留）");
}

/** 把策略条目列表按当前「周期 × 时段拆分」展开成批量队列行 */
function strategyBatchRows(strs) {
  return expandRows(strs.map((s) => ({ key: keyOf(s), strategyId: s.id || "", name: s.name })));
}

async function runSelBatch() {
  if (batch.value.running || btRunning.value) return;
  if (!selKeys.value.length) return;
  const m = new Map(allRows.value.map((s) => [keyOf(s), s]));
  const strs = selKeys.value.map((k) => m.get(k)).filter(Boolean);
  if (!strs.length) return;
  const rows = strategyBatchRows(strs);
  if ((rows.length > 3 || rows.some((r) => r.grid)) && !(await ask(batchConfirmMsg(strs.length, rows), { title: "批量回测", confirmText: "开始批量回测" }))) return;
  await runBatch(rows);
}

async function runAllBatch() {
  if (batch.value.running || btRunning.value) return;
  const strs = allRows.value;
  if (!strs.length) return;
  const rows = strategyBatchRows(strs);
  if (!(await ask(batchConfirmMsg(strs.length, rows), { title: "全部回测", confirmText: "开始" }))) return;
  await runBatch(rows);
}

/** 当前正在运行的格子 key（live map 中 st==='run'；并行批量时可能有多个） */
const btActiveKeys = computed(() =>
  Object.keys(live.value).filter((k) => live.value[k] && live.value[k].st === "run")
);
function batchPct() {
  const b = batch.value;
  if (!b.running || !b.list.length) return 0;
  const total = b.list.length;
  let p = (b.ok + b.fail) / total; // 已收尾的格
  for (const k of btActiveKeys.value) {
    const x = live.value[k];
    const pp = x && typeof x.p === "number" ? x.p : 1;
    p += Math.max(0, Math.min(100, pp)) / 100 / total; // 进行中的格按各自进度计入
  }
  return Math.round(Math.max(0.5, Math.min(100, p * 100)) * 10) / 10;
}

function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

onMounted(() => {
  loadStrategies();
});
onBeforeUnmount(() => {
  if (saveBtTimer) clearTimeout(saveBtTimer);
  if (btWatchdog) clearInterval(btWatchdog);
  if (offBt) offBt();
});
</script>

<template>
  <div class="bt-hero">
    <div class="bt-hero-ic">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h3l2-7 4 14 3-10 2 5h6" /></svg>
    </div>
    <div class="bt-hero-m">
      <div class="bt-hero-t">策略实验室</div>
      <div class="bt-hero-d">同一标的与回测参数下横向对比策略：勾选若干后「批量回测选中」或一键「全部回测」；支持一次选多个 K 线周期（1m/5m/15m/…）并「按天/周/月」拆分长区间——例如选近 1 个月按天拆分，每天独立回测一份结果，验证策略是否稳定复现。行情只拉一次落 SQLite，跑过的段秒开。胜出的策略「应用到循环」投入超短线实盘。</div>
    </div>
    <div class="bt-hero-stats">
      <div class="st"><b class="hl">{{ allRows.length }}</b><span>策略</span></div>
      <div class="st"><b>{{ builtinCount }}</b><span>内置</span></div>
      <div class="st"><b>{{ customCount }}</b><span>我的</span></div>
      <div class="st"><b :class="{ up: btOkCount > 0 }">{{ btOkCount }}<template v-if="btAllResCount">/{{ btAllResCount }}</template></b><span>已回测</span></div>
    </div>
  </div>

  <!-- ── 策略库：多策略 / 批量回测 / LLM 生成 / 应用实盘 ── -->
  <div class="panel">
    <h2>策略库<span class="spacer"></span>
      <span v-if="currentStrategyId" class="tag t-info">实盘循环：{{ currentStrategyId }}</span>
      <span v-else class="tag t-hold">实盘循环：内置趋势策略</span>
      <button class="primary" @click="openNewStrategy">＋ 新建策略（LLM 生成）</button>
    </h2>
    <div class="body">
      <div class="cat-bar">
        <button
          v-for="c in catOptions"
          :key="c || '__all'"
          :class="['chip', filterCat === c && 'on']"
          @click="filterCat = c"
        >
          {{ c || "全部" }}<span v-if="c" class="cnt">{{ catCounts[c] || 0 }}</span>
        </button>
        <span class="hint" style="margin-left:auto">全部 {{ allRows.length }} · 内置 {{ builtinCount }} / 自定义 {{ customCount }}</span>
      </div>

      <div class="bt-bar">
        <label class="bt-sel">
          <input type="checkbox" :checked="allSel" @change="toggleAllSel" />
          <span>{{ filterCat ? "全选本分类" : "全选" }}</span>
        </label>
        <span class="hint">已选 <b>{{ selKeys.length }}</b></span>
        <button class="primary sm" :disabled="btBusy || !selKeys.length" @click="runSelBatch">批量回测选中</button>
        <button class="sm" :disabled="btBusy" @click="runAllBatch">回测全部</button>
        <button v-if="selKeys.length" class="sm" @click="clearSel">清空勾选</button>
        <span v-if="selKeys.length" class="sel-tip hint" :title="selNames()">{{ selNames() }}</span>
        <span class="spacer"></span>
        <span class="hint">标的/区间/参数共用下方「回测控制台」；勾选多个周期或按天/周/月拆分会展开为「策略 × 周期 × 时段」网格，每格独立回测</span>
      </div>

      <div v-if="batch.running" class="bt-strip">
        <div class="bt-strip-h">
          <span class="tag t-info">批量回测 {{ batch.ok + batch.fail }}/{{ batch.list.length }}</span>
          <b>{{ btActiveKeys.length ? btActiveKeys.length + " 路并行中" : "收尾中…" }}</b>
          <span class="hint">成功 {{ batch.ok }} · 失败 {{ batch.fail }}</span>
          <span class="spacer"></span>
          <button class="sm" :disabled="batch.cancel" @click="stopBatch">停止后续</button>
        </div>
        <div class="bt-track"><div class="bt-fill" :style="{ width: batchPct() + '%' }"></div></div>
        <div v-if="btActiveKeys.length" class="hint" style="margin-top:3px;line-height:1.7">
          <span v-for="(k, ix) in btActiveKeys" :key="k" class="nowrap" style="margin-right:12px">
            {{ live[k]?.name }}：<b class="pmin">{{ live[k]?.p || 1 }}%</b><template v-if="live[k]?.stage"> · {{ live[k].stage }}</template>
          </span>
        </div>
      </div>
      <div v-else-if="batchStopped" class="hint" style="margin:-2px 0 8px">
        上次批量已手动停止，行内保留已完成的结果标记；可重新勾选未完成的策略继续。
      </div>

      <table v-if="groups.length">
        <thead>
          <tr>
            <th class="ck"><input type="checkbox" :checked="allSel" @change="toggleAllSel" title="全选" /></th>
            <th>策略</th><th>说明</th><th>最近回测</th><th>实盘循环</th><th>操作</th>
          </tr>
        </thead>
        <tbody v-for="g in groups" :key="g.cat">
            <tr class="cat-row">
              <td colspan="6">
                <span class="tag t-hold">{{ g.cat }}</span>
                <span class="hint">{{ g.items.length }} 个策略</span>
                <span v-if="g.items.some((s) => s.engine)" class="hint" style="margin-left:6px">含引擎默认趋势规则</span>
              </td>
            </tr>
            <tr v-for="s in g.items" :key="s.id || 'engine'" :class="{ sel: isSel(keyOf(s)) }">
              <td class="ck">
                <input type="checkbox" :checked="isSel(keyOf(s))" :title="'选择 ' + s.name" @change="toggleSel(keyOf(s))" />
              </td>
              <td>
                <div class="s-name">
                  <b>{{ s.name }}</b>
                  <span v-if="s.engine" class="tag t-hold">引擎内置</span>
                  <span v-else-if="s.builtin" class="tag t-info">内置</span>
                  <span v-else class="tag t-buy">我的</span>
                </div>
                <div class="hint">{{ s.engine ? "engine-default" : s.id }}<template v-if="s.updatedAt"> · {{ fmtTs(s.updatedAt) }} 更新</template></div>
              </td>
              <td class="wrap">{{ s.desc || "—" }}</td>
              <td class="bt-cell">
                <template v-if="live[keyOf(s)]">
                  <div :class="['bt-live', live[keyOf(s)].st === 'run' ? 'on' : 'wait']">
                    <span class="bt-dot"></span>
                    <template v-if="live[keyOf(s)].st === 'run'">
                      <b class="pmin">{{ live[keyOf(s)].p || 1 }}%</b>
                      <span class="hint">{{ live[keyOf(s)].stage || "回测中" }}</span>
                    </template>
                    <template v-else>排队中…</template>
                  </div>
                </template>
                <template v-else-if="rowSummary(keyOf(s))">
                  <div class="bt-metrics">
                    <span :class="['m-net', (rowSummary(keyOf(s)).totalNetPnlPct ?? 0) >= 0 ? 'up' : 'down']">
                      {{ fmtNum(rowSummary(keyOf(s)).totalNetPnlPct ?? 0, 3) }}%
                    </span>
                    <span class="hint">
                      {{ rowSummary(keyOf(s)).trades ?? 0 }} 笔 · 胜率 {{ rowSummary(keyOf(s)).winRate ?? "-" }}% · PF {{ fmtNum(rowSummary(keyOf(s)).profitFactor ?? 0, 2) }} · 回撤 {{ fmtNum(rowSummary(keyOf(s)).maxDrawdownPct ?? 0, 2) }}%
                    </span>
                  </div>
                  <div class="hint bt-at">净 {{ fmtNum(rowSummary(keyOf(s)).totalNetPnlUsdt ?? 0, 1) }} USDT · {{ fmtTs(rowResAt(keyOf(s))) }}</div>
                </template>
                <template v-else-if="rowFailMsg(keyOf(s))">
                  <span class="tag t-sell">失败</span>
                  <span class="hint bt-at">{{ rowFailMsg(keyOf(s)) }}</span>
                </template>
                <span v-else class="hint">—</span>
              </td>
              <td class="nowrap"><span v-if="currentStrategyId === s.id" class="tag t-on">当前</span><span v-else class="hint">—</span></td>
              <td class="nowrap">
                <button class="sm" :disabled="btBusy" @click="btForStrategy(s.id)">回测</button>
                <button v-if="s.engine" class="sm" :disabled="!currentStrategyId" @click="applyStrat('')">
                  恢复引擎默认
                </button>
                <button v-else class="sm" :disabled="currentStrategyId === s.id" @click="applyStrat(s.id)">
                  应用到循环
                </button>
                <button v-if="s.builtin && !s.engine" class="sm" @click="openCopyStrategy(s)">复制为自定义</button>
                <template v-if="!s.builtin && !s.engine">
                  <button class="sm" @click="openEditStrategy(s.id)">编辑</button>
                  <button class="sm danger" @click="deleteStrategyRow(s)">删除</button>
                </template>
              </td>
            </tr>
          </tbody>
      </table>
      <div v-else class="empty">
        当前分类下没有策略。
        <a href="javascript:void(0)" @click="openNewStrategy">点此新建</a>，或切换上方分类。
      </div>
      <div class="hint" style="margin-top:8px">
        内置策略为平台模板：不可删除、不可覆盖保存（可一键「复制为自定义」再自由修改）。策略只实现
        <code>signal(ctx)</code> 判向（long/short/flat + 一句理由），可覆盖 ATR 止损系数 / 盈亏比；也可返回
        <code>sl</code>/<code>tp</code> 止盈止损点位；禁止危险 import、禁止未来数据——同一份代码既回测也实盘。
      </div>
    </div>
  </div>

  <!-- ── 批量回测矩阵：策略 × 周期 × 时段 展开批量时的每格结果 ── -->
  <div v-if="lastGrid && lastGrid.rows.length" class="panel">
    <h2>
      批量回测矩阵<span class="spacer"></span>
      <span class="tag t-info">{{ lastGrid.dim }}</span>
      <span class="hint">{{ lastGrid.rows.length }} 格 · 完成 {{ gridStateC.ok }} · 失败 {{ gridStateC.err }}</span>
    </h2>
    <div class="body">
      <div class="hint" style="margin-bottom:6px">
        {{ fmtTs(lastGrid.at) }} 启动。每格独立回测一份结果；行情只向 OKX 拉一次并缓存到 SQLite，跨格/跨次不重复请求。非 1m 周期由本地 1m 聚合生成。
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th><th>状态</th><th>策略</th><th>周期</th><th>时段</th><th>结果</th><th>完成</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, ix) in lastGrid.rows" :key="r.key">
            <td>{{ ix + 1 }}</td>
            <td class="nowrap">
              <template v-if="r.status === 'run'">
                <span class="tag t-on">运行中 {{ live[r.key]?.p || 1 }}%</span>
                <span class="hint">{{ live[r.key]?.stage || "" }}</span>
              </template>
              <span v-else-if="r.status === 'wait'" class="tag t-hold">排队</span>
              <span v-else-if="r.status === 'ok'" class="tag t-buy">完成</span>
              <span v-else class="tag t-sell">失败</span>
            </td>
            <td class="nowrap">{{ r.name }}</td>
            <td class="nowrap">{{ barT(r.bar) }}</td>
            <td class="nowrap">{{ r.win }}</td>
            <td class="wrap">
              <template v-if="r.sum">
                <span :class="['m-net', (r.sum.totalNetPnlPct ?? 0) >= 0 ? 'up' : 'down']">
                  {{ fmtNum(r.sum.totalNetPnlPct ?? 0, 3) }}%
                </span>
                <span class="hint">{{ gridShort(r) }}</span>
              </template>
              <span v-if="r.err" class="hint" style="color:var(--c-danger)">{{ r.err }}</span>
            </td>
            <td class="nowrap hint">{{ fmtTs(r.at) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- ── 回测控制台 ── -->
  <div class="panel">
    <h2 id="scalper_bt">超短线回测<span class="spacer"></span><span class="hint">参数改动自动保存 —— 下次打开默认沿用上次填写</span></h2>
    <div class="body">
      <div class="cfg-head">
        <span class="cfg-ic"></span><b>标的与策略</b>
        <span class="spacer"></span>
        <button class="sm" @click="resetBtParams">恢复默认参数</button>
      </div>
      <div class="row">
        <label>标的</label>
        <input v-model="btForm.inst" list="bt_insts" placeholder="BTC-USDT-SWAP" style="max-width:200px" />
        <datalist id="bt_insts">
          <option v-for="i in INST_SUGGEST" :key="i" :value="i" />
        </datalist>
        <span class="hint">USDT 永续。建议优先 BTC/ETH/SOL 等深度好的标的，滑点假设才贴近现实</span>
      </div>
      <div class="row">
        <label>回测策略</label>
        <select v-model="btForm.strategyId" style="max-width:280px">
          <option value="">内置趋势策略（默认）</option>
          <option v-for="s in strategies" :key="s.id" :value="s.id">{{ s.name }}（{{ s.id }}）</option>
        </select>
        <span class="hint">下拉即回测该策略；也用于「批量回测」的横向对比</span>
      </div>

      <div class="cfg-head">
        <span class="cfg-ic"></span><b>K 线周期</b>
        <span class="spacer"></span>
        <span class="hint">多选 → 批量时每个周期各回测一遍（单跑/策略行「回测」用第一个）；非 1m 由本地 1m 聚合，数据只拉一次</span>
      </div>
      <div class="row">
        <label>周期</label>
        <span style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <button v-for="c in BT_BARS" :key="c.v" :class="['chip', btBarOn(c.v) && 'on']" @click="toggleBtBar(c.v)">{{ c.t }}</button>
        </span>
        <span class="hint" v-if="btForm.bars?.length">已选 {{ btForm.bars.length }} 个：{{ btForm.bars.map(barT).join(" / ") }}</span>
      </div>

      <div class="cfg-head">
        <span class="cfg-ic"></span><b>时间区间</b>
        <span class="spacer"></span>
        <span class="bt-quick">
          <span v-for="q in QUICK_RANGES" :key="q.d" class="chip" @click="quickRange(q.d)">{{ q.t }}</span>
        </span>
      </div>
      <div class="row">
        <label>起止时间</label>
        <input v-model="btForm.start" type="datetime-local" style="max-width:200px" />
        <span class="hint">至</span>
        <input v-model="btForm.end" type="datetime-local" style="max-width:200px" />
        <span class="hint">本地时间。行情自动缓存落库，同段重复回测秒开；建议大区间配合下方「时段拆分」切段跑</span>
      </div>
      <div class="row">
        <label>时段拆分</label>
        <span style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <button v-for="c in BT_SPLITS" :key="c.v" :class="['chip', (btForm.split || 'whole') === c.v && 'on']" :title="c.h" @click="toggleBtSplit(c.v)">{{ c.t }}</button>
        </span>
        <span class="hint">
          <template v-if="(btForm.split || 'whole') === 'whole'">整个区间一次回测</template>
          <template v-else>大区间（如近 1 个月）按「{{ (btForm.split === 'day' && '天') || (btForm.split === 'week' && '周') || '月' }}」切成 {{ winSegs().length }} 段，每段独立一份结果；与策略库「批量回测选中/全部」组合 = 策略×周期×时段网格</template>
        </span>
      </div>

      <div class="cfg-head">
        <span class="cfg-ic"></span><b>并行度</b>
        <span class="spacer"></span>
        <span class="hint">批量时同时启动的 Python 回测进程数；每格独立 job，互不干扰</span>
      </div>
      <div class="row">
        <label>并行路数</label>
        <span style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <button v-for="c in BT_CONC" :key="c.v" :class="['chip', (btForm.concurrency || 3) === c.v && 'on']" :title="c.h" @click="btForm.concurrency = c.v">{{ c.t }} 路</button>
        </span>
        <span class="hint">并行 job 各跑各的，行情同段只拉一次；并发写缓存由 SQLite 短事务协调</span>
      </div>

      <div class="cfg-head">
        <span class="cfg-ic"></span><b>进出场与成本</b>
        <span class="spacer"></span>
        <span class="hint">策略直接返回 sl/tp 点位时，以点位为准</span>
      </div>
      <div class="row">
        <label>止损</label>
        <input v-model.number="btForm.atrMult" type="number" min="0.5" max="10" step="0.1" style="max-width:88px" title="止损 = ATR × 系数" />
        <span class="hint">止损距离 = ATR(1m,14) × <b>{{ btForm.atrMult }}</b></span>
        <span style="flex:1"></span>
        <label>止盈</label>
        <input v-model.number="btForm.rrOverride" type="number" min="0" max="10" step="0.5" style="max-width:88px" title="固定盈亏比 RR（0=自动）" />
        <span class="hint">RR：0 = 自动（强趋势凯利 / 弱趋势 0.6 胜率）；&gt;0 如 2，则止盈 = 止损 × 2</span>
      </div>
      <div class="row">
        <label>持仓超时</label>
        <input v-model.number="btForm.maxHoldBars" type="number" min="0" max="300" step="5" style="max-width:88px" title="最长持仓分钟数" />
        <span class="hint">超过该分钟数以当前价强制平仓（0 = 不限），避免小波动长套</span>
        <span style="flex:1"></span>
        <label>名义金额</label>
        <input v-model.number="btForm.notional" type="number" min="100" step="100" style="max-width:100px" title="每笔名义 USDT" />
        <span class="hint">仅用于折算盈亏金额，不影响开平仓方向与时机</span>
      </div>
      <div class="row">
        <label>成本</label>
        <input v-model.number="btForm.feeRate" type="number" min="0" max="0.005" step="0.0001" style="max-width:92px" title="单边 taker 费率" />
        <span class="hint">单边 taker 费率（开、平各收一次）</span>
        <span class="hint" style="opacity:.45">｜</span>
        <input v-model.number="btForm.slippageBps" type="number" min="0" max="50" step="0.5" style="max-width:80px" title="单边滑点 bps" />
        <span class="hint">滑点 bps（0.01%），开平均按不利方向计入成交价</span>
        <span style="flex:1"></span>
        <span class="chk" style="display:inline-flex;gap:6px;align-items:center">
          <input id="bt_rev" v-model="btForm.closeOnReversal" type="checkbox" />
          <label for="bt_rev">趋势反转平仓</label>
        </span>
      </div>
      <div class="row" style="margin-top:6px">
        <label></label>
        <button class="primary" :disabled="btBusy" @click="runBacktest">
          {{ batch.running ? "批量回测进行中…" : btRunning ? "回测中 " + (btProgress?.p ?? 0) + "%…" : expandDim ? "批量回测当前策略（" + (btForm.bars?.length || 1) + "周期 × " + winSegs().length + "段）" : "开始回测" }}
        </button>
        <span class="hint">
          {{ batch.running ? "批量进行中，结束后再发起新任务。" : expandDim ? "已开启多周期 / 时段拆分：把当前所选策略按上方配置展开成网格逐格回测（要横向对比多个策略，用策略库的「批量回测选中 / 回测全部」）。" : btForm.strategyId ? "回测自定义策略（逐根调用 signal，支持 flat 观望）" : "回放内置超短线规则（5 根收盘斜率 + ATR 止损 + RR 止盈）" }}
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
      <span v-if="btResult.bar && btResult.bar !== '1m'" class="tag t-info">K线 {{ barT(btResult.bar) }}</span>
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
              <th>持仓(根)</th><th>原因</th><th>盈亏(USDT)</th><th>手续费</th><th>净盈亏(USDT)</th><th>净盈亏(%)</th>
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
      <h3>
        {{
          editModal.mode === "copy"
            ? "复制为自定义（保存后另存为新策略）"
            : editModal.id
              ? "编辑策略 " + editModal.id
              : "新建策略（用 LLM 生成）"
        }}
      </h3>
      <div class="body">
        <div class="row">
          <label>名称</label>
          <input v-model="editModal.name" placeholder="如：波动突破三滤网" style="max-width:280px" />
          <span class="hint">策略列表与回测下拉里显示</span>
        </div>
        <div class="row">
          <label>分类</label>
          <select v-model="editModal.category" style="max-width:200px">
            <option v-for="c in CATEGORY_ORDER" :key="c" :value="c">{{ c }}</option>
          </select>
          <span class="hint">策略库按分类分组展示，随时可改</span>
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
          <span class="hint">内置规则已注入：只写 signal(ctx)、禁危险 import、止损止盈默认由引擎统一算（也可返回 sl/tp 点位）</span>
        </div>
        <div v-if="modalNote" class="alert info" style="margin-top:6px">{{ modalNote }}</div>
        <div style="margin-top:8px"><b>strategy.py 代码</b> <span class="hint">（生成后仍可直接修改）</span></div>
        <textarea
          v-model="editModal.code"
          class="sg-code"
          spellcheck="false"
          placeholder="# 点上方按钮让 LLM 生成，或直接手写：&#10;def signal(ctx):&#10;    # ctx: closes/highs/lows/vols/ts(1m,升序)/n/atr/price&#10;    # 返回 {&quot;direction&quot;: &quot;long&quot;|&quot;short&quot;|&quot;flat&quot;, &quot;reason&quot;: &quot;中文依据&quot;}&#10;    return {&quot;direction&quot;: &quot;flat&quot;, &quot;reason&quot;: &quot;观望&quot;}"
        ></textarea>
        <div class="row" style="margin-top:2px">
          <label></label>
          <div style="flex:1">
            <div class="bf-chks">
              <span class="hint">把这段代码交给 LLM 反推元信息——勾选哪项就覆盖哪项，未勾选保持原样：</span>
              <label class="bf-chk"><input type="checkbox" v-model="bfWant" value="name" /> 名称</label>
              <label class="bf-chk"><input type="checkbox" v-model="bfWant" value="desc" /> 描述</label>
              <label class="bf-chk"><input type="checkbox" v-model="bfWant" value="idea" /> 思路</label>
              <button
                class="primary sm"
                :disabled="backfillLoading || genLoading || saveLoading || !editModal.code?.trim()"
                @click="doBackfill"
              >
                {{ backfillLoading ? "分析回填中…（约 1 分钟）" : "LLM 按代码回填选中字段" }}
              </button>
            </div>
          </div>
        </div>
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
.cat-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.chip {
  border: 1px solid var(--line, rgba(255, 255, 255, 0.14));
  background: transparent;
  border-radius: 12px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--fg-dim, rgba(232, 232, 236, 0.75));
  line-height: 1.6;
}
.chip:hover {
  border-color: var(--accent, #7a5cff);
  color: var(--fg, #e8e8ec);
}
.chip.on {
  background: var(--accent, #7a5cff);
  border-color: var(--accent, #7a5cff);
  color: #fff;
}
.chip .cnt {
  margin-left: 3px;
  opacity: 0.65;
  font-size: 11px;
}
tr.cat-row td {
  background: var(--bg2, rgba(255, 255, 255, 0.05));
  padding: 4px 10px !important;
}
.s-name {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bf-chks {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12px;
}
.bf-chk {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  color: var(--fg, #e8e8ec);
}

/* ── 批量回测 + 科技感装饰（仅本板块） ── */
.bt-hero {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 14px;
  padding: 13px 16px;
  border: 1px solid rgba(76, 141, 255, 0.28);
  border-radius: var(--r);
  background:
    radial-gradient(560px 130px at 6% -40%, rgba(76, 141, 255, 0.2), transparent 60%),
    radial-gradient(460px 130px at 97% -30%, rgba(163, 113, 247, 0.16), transparent 60%),
    linear-gradient(120deg, rgba(76, 141, 255, 0.1), rgba(163, 113, 247, 0.06) 55%, transparent);
  box-shadow: var(--sh-1);
}
.bt-hero-ic {
  flex: none;
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--blue), var(--purple));
  color: #fff;
  box-shadow: 0 4px 14px rgba(76, 141, 255, 0.35);
}
.bt-hero-ic svg {
  width: 22px;
  height: 22px;
  display: block;
}
.bt-hero-m {
  flex: 1;
  min-width: 0;
}
.bt-hero-t {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--text);
}
.bt-hero-d {
  color: var(--dim);
  font-size: 12px;
  line-height: 1.7;
  margin-top: 2px;
  max-width: 760px;
}
.bt-hero-stats {
  display: flex;
  gap: 8px;
  flex: none;
}
.bt-hero-stats .st {
  min-width: 60px;
  text-align: center;
  padding: 7px 9px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.bt-hero-stats b {
  display: block;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--text);
}
.bt-hero-stats b.hl {
  color: var(--blue);
}
.bt-hero-stats .st span {
  color: var(--dim);
  font-size: 10.5px;
}

.bt-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--hover-2);
}
.bt-sel {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
  user-select: none;
}
.bt-sel input {
  width: 14px;
  height: 14px;
  min-width: 14px;
}
.bt-bar .sel-tip {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bt-strip {
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(76, 141, 255, 0.3);
  border-radius: var(--r-sm);
  background: linear-gradient(90deg, rgba(76, 141, 255, 0.1), transparent);
}
.bt-strip-h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.bt-strip-h b {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.bt-track {
  height: 6px;
  border-radius: 4px;
  background: var(--surface-3);
  overflow: hidden;
}
.bt-fill {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--blue), var(--purple), var(--blue));
  background-size: 200% 100%;
  animation: btFlow 1.6s linear infinite;
  transition: width 0.5s ease;
}
@keyframes btFlow {
  to {
    background-position: -200% 0;
  }
}

tbody tr.sel td {
  background: rgba(76, 141, 255, 0.07);
}
tbody tr.sel td:first-child {
  box-shadow: inset 2px 0 0 var(--blue);
}
th.ck {
  width: 32px;
  text-align: center;
}
td.ck {
  text-align: center;
  width: 32px;
  padding: 0 2px !important;
}
td.ck input {
  vertical-align: middle;
}
td.bt-cell {
  max-width: 260px;
}
.bt-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-2);
}
.bt-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dim);
}
.bt-live.on .bt-dot {
  background: var(--blue);
  box-shadow: 0 0 0 3px rgba(76, 141, 255, 0.18);
  animation: btPulse 1.2s infinite;
}
.bt-live.wait .bt-dot {
  background: var(--yellow);
}
.bt-live .pmin {
  min-width: 44px;
  color: var(--text);
}
.bt-metrics {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.bt-metrics .m-net {
  font-weight: 700;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.bt-at {
  font-size: 10.5px;
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 250px;
}
@keyframes btPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

/* ── 回测控制台：分区标题 + 快捷时间区间 ── */
.cfg-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 0 4px;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--border);
  font-size: 12px;
  color: var(--dim);
}
.cfg-head:first-child {
  margin-top: 0;
}
.cfg-head b {
  font-weight: 600;
  color: var(--text);
}
.cfg-ic {
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--blue), var(--purple));
  box-shadow: 0 0 6px rgba(76, 141, 255, 0.55);
}
.bt-quick {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  flex-wrap: wrap;
}
.bt-quick .chip {
  cursor: pointer;
}
.bt-quick .chip:hover {
  border-color: var(--blue);
  color: var(--blue);
}
</style>
