/**
 * sparkline.js —— 累计净收益曲线的 SVG 几何（展示层纯函数）
 *
 * 与 ui/lib/riskbrief.js 的 `barWidth()` 同一类：只做「数值 → 视觉坐标」的
 * 换算，不参与任何交易口径。统计本身（胜率 / 盈亏比 / 回撤 …）由主进程的
 * `src/scalperstats.ts` 算好随 overview 一起下发，界面**不重算**——净盈亏的
 * 口径（netPnl 优先、缺失退回 pnl - fee、两者皆无 = 未同步）只能有一份。
 *
 * 两条硬规则：
 *  1. 值域**强制包含 0**，零轴永远在画面里 —— 一眼能看出这轮是赚是亏；
 *  2. 数值全等时**不能除零**（除零会把线画到画布外，且 SVG 会静默不报错）。
 */

function fin(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Array<{cum:number}>} curve 按时间升序的累计净收益
 * @returns {{points:string, area:string, zeroY:number|null, min:number|null, max:number|null}}
 *          points / area 为 SVG 坐标串；空曲线返回空串（调用方据此显示占位）
 */
export function sparkline(curve, w = 600, h = 120, pad = 8) {
  const vals = (curve ?? []).map((p) => fin(p?.cum) ?? 0);
  if (!vals.length) return { points: "", area: "", zeroY: null, min: null, max: null };

  const min = Math.min(...vals, 0);
  let max = Math.max(...vals, 0);
  const flat = max - min < 1e-9;
  if (flat) max = min + 1; // 全平：给一个非零跨度，避免除零

  const innerW = Math.max(1, w - pad * 2);
  const innerH = Math.max(1, h - pad * 2);
  const x = (i) => pad + (vals.length === 1 ? innerW / 2 : (i / (vals.length - 1)) * innerW);
  const y = (v) => pad + innerH - ((v - min) / (max - min)) * innerH;

  const points = vals.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const area = `${pad},${(h - pad).toFixed(2)} ${points} ${(w - pad).toFixed(2)},${(h - pad).toFixed(2)}`;
  return { points, area, zeroY: Number(y(0).toFixed(2)), min, max };
}
