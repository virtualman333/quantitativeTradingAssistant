/** format.js —— 展示层小工具 */
import MarkdownIt from "markdown-it";

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function nowTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtNum(v, d = 2) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 价格展示至少保留的有效数字位数（见 fmtPrice 的说明） */
export const PRICE_MIN_SIG = 4;
/** 价格展示的小数位上限，同时用来探测前导零个数 */
export const PRICE_MAX_DECIMALS = 18;

/**
 * fmtPrice —— **界面里所有价格的唯一格式化入口**（金额/张数仍用 `fmtNum`）。
 *
 * 为什么不能复用 `fmtNum(v, 2)`
 * ----------------------------
 * 固定 2 位小数只对 USDT 金额合适。同一个界面里价格能差 12 个数量级
 * （实测 OKX 483 个 USDT 永续：BTC 75815，SATS 9.949e-9），固定位数必然出错：
 *   - `fmtNum(v, 2)`：**价格 < 0.005 的标的一律显示成 `0.00`** —— 实测 30 个标的，
 *     持仓页/总览页的「开仓价 / 标记价 / 强平价 / 止损触发价」全变成 0.00；
 *   - 固定 8 位（前一版规则）：SATS 的 9.949e-9 被压成 `0.00000001`，
 *     只剩 1 位有效数字，同一页面里买入价与标记价会显示成同一个数。
 *
 * 本函数按**有效数字**推小数位：整数部分 ≥ 1000 给 2 位，≥ 1 给 4 位，
 * < 1 时「前导零个数 + 4」且不少于 5 位，最多 18 位。因此：
 *   - 任何**非零**价格都不会被显示成 `0.00`（最后一道兜底用原始数值，宁丑不假）；
 *   - 不会出现科学计数法（`9.949e-9`）—— 直接打印原始 number 才会有这个问题；
 *   - 极端小的价格（< 5e-19）退化成原始字符串，而不是 0。
 *
 * 与 `src/price.ts` 的分工：那边管**下单价按 tickSz 网格取整**（写成字符串发给交易所，
 * 错了会被拒单），这边只管**给人看**。两者都不可硬夹位数，但判据不同，不要互相复用。
 */
export function fmtPrice(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0.00";

  const a = Math.abs(n);
  let d;
  if (a >= 1000) d = 2;
  else if (a >= 1) d = 4;
  else {
    // 前导零个数：0.02683 → 1（小数点是 0 之后、2 之前），9.949e-9 → 8。
    // 用 toFixed 展开而不是 String()，后者对 < 1e-6 会给出科学计数法。
    const frac = a.toFixed(PRICE_MAX_DECIMALS).split(".")[1] ?? "";
    const zeros = (frac.match(/^0*/) ?? [""])[0].length;
    d = Math.min(PRICE_MAX_DECIMALS, Math.max(5, zeros + PRICE_MIN_SIG));
  }

  const s = n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  // 兜底：比 toFixed 上限还小的价格会被四舍五入成 0.00。宁可直接打印原始值，也不显示 0。
  if (Number(s.replace(/,/g, "")) === 0) return String(n);
  return s;
}

export const signCls = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "");

export const STANCE_TEXT = { bullish: "看多", bearish: "看空", neutral: "中性" };

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Markdown 渲染（对话等富文本输出）。
 * html:false —— 模型输出里的裸 HTML 一律转义成文本，不会被当成标签执行；
 * breaks:true —— 单个换行也断行（聊天习惯）。
 * 渲染失败时回退为转义文本 + <br>，绝不让界面白屏。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function renderText(s) {
  const raw = String(s ?? "");
  try {
    return md.render(raw);
  } catch {
    return escapeHtml(raw).replace(/\r?\n/g, "<br>");
  }
}

export function briefArgs(args, max = 90) {
  let s = "";
  try {
    s = typeof args === "string" ? args : JSON.stringify(args ?? {});
  } catch {
    s = String(args);
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
}
