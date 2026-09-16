/**
 * riskbrief.js —— 风控体检的展示层小工具
 *
 * src/riskbrief.ts 已经把「这轮用了多少风险预算」算好并写进归档 payload 的
 * risk_brief 字段，但界面此前从不读它 —— 数字躺在 JSON 里没人看，等于没算。
 *
 * 这里只做三件事，且**刻意不重算任何风控公式**（口径必须唯一，见 guard.ts）：
 *   1. 把归一化比例写成百分比文本；
 *   2. 把「占上限百分比」分成 充裕 / 接近上限 / 超限 三档；
 *   3. 从「值 + 占上限百分比」反推上限值 —— 界面不抄 guard 的 5x / 2.5% 常量，
 *      否则章程改一次就得改两个地方（这个仓库已经栽过「同一事实两处写法必然漂移」）。
 *
 * 纯函数、零依赖，可直接单测。
 */

/** 动作中文名（与 DashboardView 的 DECISION_TEXT 同一套说法） */
export const ACTION_TEXT = { long: "开多", short: "开空", close: "平仓", hold: "持有" };

/** 预算占用达到这个百分比就值得提醒（尚未超限） */
export const NEAR_PCT = 80;

export const LEVEL_TEXT = { ok: "充裕", near: "接近上限", over: "超限", none: "—" };

/**
 * 统一的数值口径：null / undefined / 空串 / 非有限数 → null，其余转 number。
 *
 * 必须显式挡空串：`Number("")` 是 0，会被当成「用了 0% 预算」——
 * 于是「没算出来」在界面上显示成绿色的「充裕」。这正是这块最不该出的错。
 * 所有取值都必须走这里，避免各函数各判一套。
 */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 归一化比例 → 百分比文本（0.0185 → "1.85%"）；无数据返回 "—" */
export function pctText(v, d = 2) {
  const n = num(v);
  return n === null ? "—" : `${(n * 100).toFixed(d)}%`;
}

/**
 * 用量分级。阈值只此一处：>100% 才是超限（此时 guard 会直接拦截或告警），
 * 80%~100% 是「快到头了」——这两个档位对应完全不同的动作，不能混为一谈。
 */
export function usageLevel(usagePct) {
  const n = num(usagePct);
  if (n === null) return "none";
  if (n > 100) return "over";
  if (n >= NEAR_PCT) return "near";
  return "ok";
}

/** 用量文本：84% 上限 / 超限 112% */
export function usageText(usagePct, d = 0) {
  const n = num(usagePct);
  if (n === null) return "—";
  const abs = `${Math.abs(n).toFixed(d)}%`;
  return usageLevel(n) === "over" ? `超限 ${abs}` : `${abs} 上限`;
}

/**
 * 由「值 + 占上限百分比」反推上限：cap = value / (usagePct / 100)。
 * 两者出自同一次计算，反推是精确的；**返回值与 value 同单位**
 * （杠杆传 4x 得 5x；风险传 0.0185 得 0.025），调用方各自决定怎么格式化。
 * usagePct 为 0（值必然也是 0）时无从反推，返回 null。
 */
export function capOf(value, usagePct) {
  const p = num(usagePct);
  const v = num(value);
  if (p === null || v === null || p === 0) return null;
  const cap = v / (p / 100);
  return Number.isFinite(cap) ? cap : null;
}

/** 进度条填充宽度：视觉上封顶 100%，超限由颜色与文案表达 */
export function barWidth(usagePct) {
  const n = num(usagePct);
  if (n === null || n <= 0) return 0;
  return Math.min(100, n);
}

/** 逐笔取某个用量字段的最大值（用于顶部两条汇总条）；无有效值时返回 null */
export function maxUsage(intents, field) {
  const vals = (intents || []).map((c) => num(c && c[field])).filter((n) => n !== null);
  return vals.length ? Math.max(...vals) : null;
}

/** 逐笔状态：拦截 > 提示 > 通过（决定行内标签与颜色） */
export function rowState(c) {
  if (!c) return "none";
  if (!c.ok) return "blocked";
  if ((c.warnings || []).length) return "warned";
  return "passed";
}

export const STATE_TEXT = { passed: "通过", warned: "提示", blocked: "拦截", none: "—" };

/** 逐笔风险预算文本：1.85% / 2.50% */
export function riskBudgetText(c) {
  const src = c || {};
  const cap = capOf(src.riskPct, src.riskUsagePct);
  return cap === null ? pctText(src.riskPct) : `${pctText(src.riskPct)} / ${pctText(cap)}`;
}

/** 逐笔杠杆文本：4.0x / 5.0x；无数据返回 "—"（平仓单本来就没有隐含杠杆） */
export function leverageText(c) {
  const src = c || {};
  const v = num(src.impliedLeverage);
  if (v === null) return "—";
  const cap = capOf(v, src.leverageUsagePct);
  return cap === null ? `${v.toFixed(1)}x` : `${v.toFixed(1)}x / ${cap.toFixed(1)}x`;
}

// ── 月度风控（章程 L1-6：月度回撤 ≥12% → 强制停止开新仓）──────────────────
//
// 这条 L1 在加固之前**从未触发过**（判据字段全仓没人写）；现在它真的会拦下开新仓，
// 但状态只落在日志与邮件里 —— 界面上「今天还能不能开新仓」依旧看不见。
// 而它恰恰是全部硬约束里后果最重的一条（不是这笔亏了，是没有下一笔了）。
//
// 判据只有一个来源：`state/runtime.json` 的 `l1_6_tripped`（archive_round.py 调
// month_risk.py 的同一口径算出来的）。**界面不重算熔断判据**，与上面「不抄 guard 常量」
// 同一条理由 —— 判据的第二个实现迟早会跟第一个不一致，而且不会报错。
// 界面只做两件事：判断「这个字段在不在」，以及算一个纯展示用的「离熔断线还有多远」。

export const MONTH_LEVEL_TEXT = {
  tripped: "已熔断 · 停止开新仓",
  inconsistent: "数据不一致",
  near: "接近熔断线",
  ok: "正常",
  unknown: "未知",
};

/** 档位 → 标签配色类（与全站 tag 体系一致：红=拦截级、黄=提醒级） */
export const MONTH_TAG_CLS = {
  tripped: "t-sell",
  inconsistent: "t-warn",
  near: "t-warn",
  ok: "t-on",
  unknown: "t-hold",
};

/**
 * 回撤用量：|当前回撤| / |熔断线| × 100（都是负数，取绝对值再比）。
 * 纯展示比例，**不参与任何熔断判断**；缺任一数即 null（不猜、不当 0）。
 */
export function ddUsage(monthDdPct, capPct) {
  const dd = num(monthDdPct);
  const cap = num(capPct);
  if (dd === null || cap === null || cap === 0) return null;
  return (Math.abs(dd) / Math.abs(cap)) * 100;
}

/**
 * 月度风控视图模型。输入就是 `status.runtime`（runtime.json 原样）。
 *
 * level 的取法：
 *   - `month_dd_error` 有值  → unknown（本轮月度状态算不出来）
 *   - `l1_6_tripped` 不是布尔 → unknown（旧版本归档写的运行态，没有判据）
 *   - 为 true                → tripped
 *   - 为 false 但回撤已过线  → inconsistent（判据与数值互相矛盾，如实报出来，
 *                              不替其中一方下结论 —— 静默选一个才是真正的坑）
 *   - 为 false               → 按回撤用量分 near（≥80% 熔断线）/ ok
 *
 * ⚠ 这里刻意**不接受**「有回撤数值就自己判熔断」这条路：边界（≥12%）必须只有一个
 * 实现，否则把 -11.9% 判成熔断（或反过来）都不会报错。
 */
export function monthRiskView(rt) {
  const r = rt || {};
  const dd = num(r.month_dd_pct);
  const cap = num(r.month_dd_cap_pct);
  const pnl = num(r.month_pnl_pct);
  const target = num(r.monthly_target_pct);
  const usage = ddUsage(dd, cap);
  const flag = r.l1_6_tripped;
  const err = r.month_dd_error ? String(r.month_dd_error) : "";

  let level = "unknown";
  let reason = "";
  if (err) {
    reason = `本轮月度状态没算出来（${err}）—— 熔断判据因此不可用，执行链会放行并点名告警`;
  } else if (flag !== true && flag !== false) {
    reason = r.round_count
      ? "本轮运行态里没有 L1-6 判据（旧版本归档写入的运行态，重跑一轮即可看到）"
      : "暂无运行态（跑一轮后产生）";
  } else if (flag === true) {
    level = "tripped";
  } else if (usage !== null && usage > 100) {
    level = "inconsistent";
    reason = "回撤已越过熔断线，但运行态的 L1-6 判据说未熔断 —— 两者矛盾，请重跑一轮归档并核对章程常量";
  } else {
    level = usage !== null && usage >= NEAR_PCT ? "near" : "ok";
  }

  // 回撤进度条：用量本身是正数（占熔断线的百分比），宽度沿用 barWidth 的封顶规则
  const ddText = dd === null ? "—" : `${dd.toFixed(2)}%`;
  const capText = cap === null ? "—" : `${cap.toFixed(2)}%`;
  const pnlText = pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
  const targetText = target === null ? "—" : `+${target.toFixed(1)}%`;
  const progressPct = pnl === null || target === null || target === 0 ? null : (pnl / target) * 100;
  const progressText = progressPct === null ? "—" : `${progressPct.toFixed(0)}%`;

  const bits = [];
  if (dd !== null && cap !== null) bits.push(`月度回撤 ${ddText}（熔断线 ${capText}）`);
  else if (dd !== null) bits.push(`月度回撤 ${ddText}`);
  else bits.push("月度回撤 —");
  if (pnl !== null) bits.push(`月度收益 ${pnlText} / 目标 ${targetText}`);

  // 进度条色阶沿用风控体检那套（充裕 / 接近 / 超限），因为语义完全一样：
  // 都是「离某条不可逾越的线还有多远」。熔断判据本身不在这里，色阶只表距离。
  const barCls = {
    tripped: "lv-over",
    inconsistent: "lv-over",
    near: "lv-near",
    ok: "lv-ok",
    unknown: "lv-none",
  }[level];
  const ddTip =
    usage === null
      ? "回撤或熔断线数据缺失 —— 无法判断离熔断线还有多远"
      : `${usage.toFixed(0)}% 熔断线 · ${MONTH_LEVEL_TEXT[level]}`;
  const progressTip =
    progressPct === null
      ? "无月度收益数据"
      : progressPct >= 100
        ? `已达标（目标 ${targetText}）`
        : `距月度目标还差 ${targetText} 的 ${(100 - progressPct).toFixed(0)}%`;

  const startEq = num(r.month_start_equity);
  const peakEq = num(r.month_peak_equity);
  // 回撤的基准是**当月峰值**而不是月初 —— 不说清的话，用户会拿月初权益去对不上账
  if (startEq !== null && peakEq !== null) {
    bits.push(`基准（月初 ${startEq.toFixed(2)} / 峰值 ${peakEq.toFixed(2)} USDT）`);
  }

  let summary = "";
  if (level === "tripped") {
    summary = `已触发章程 L1-6：${bits.join(" · ")}。本轮起强制停止开新仓，直到回撤回到熔断线内。`;
  } else if (level === "ok" || level === "near") {
    summary = `${bits.join(" · ")}。${level === "near" ? "已用掉熔断线的大部分，注意别在回落里继续加仓。" : ""}`;
  } else {
    // unknown / inconsistent：把「为什么看不出来」写在数字旁边，
    // 否则用户只会看到一个没有底色的「—」而不知道该去找什么
    summary = `${bits.join(" · ")}。${reason}`;
  }

  return {
    level,
    tagText: MONTH_LEVEL_TEXT[level],
    tagCls: MONTH_TAG_CLS[level],
    barCls,
    ddTip,
    progressTip,
    tripped: level === "tripped",
    unknown: level === "unknown",
    reason,
    ddText,
    capText,
    pnlText,
    targetText,
    progressText,
    usagePct: usage,
    barPct: barWidth(usage),
    progressBarPct: barWidth(progressPct),
    summary,
  };
}
