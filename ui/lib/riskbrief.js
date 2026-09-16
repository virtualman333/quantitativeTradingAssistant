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
