/**
 * price.ts —— 下单价格格式化（tickSz 网格）的唯一实现
 *
 * 为什么必须收敛到一处
 * --------------------
 * 同样的逻辑此前在 `src/main.ts` 与 `src/scalper.ts` 里各写了一份、逐字相同。
 * 而这条逻辑管的是**钱**：OCO 的触发价必须是 tickSz 的整数倍，否则 OKX 直接拒单
 * —— 拒单意味着「止损失效」，触碰章程 L1-4「每笔持仓必须存在止损」。
 *
 * 两处旧实现（`Math.max(0, Math.min(8, Math.round(-Math.log10(tickSz))))`）有两个缺陷：
 *
 * 1. **小数位被硬夹到 8 位**，而 OKX 全部 468 个 USDT 永续里 tickSz 最小到 1e-12：
 *    - `1e-9`（PEPE / BONK / SHIB）会被截掉最后一位 → 触发价不在网格上 → 拒单；
 *    - `1e-12`（SATS）更糟：`toFixed(8)` 把价格写成 `0.00000001`，于是
 *      `SL == TP == 0.00000001` 而入场价是 `9.949e-9` —— 止损止盈双双跑到入场价**上方**，
 *      `SL < entry < TP` 这个基本语义被彻底破坏。
 *    小数位只能从 tickSz 的十进制表示里取，**不能用 log10 反推再去夹**。
 *
 * 2. **最近取整会把止损吸回入场价**：当 `slDist` 小于半个 tick 时，
 *    `Math.round(sl / tickSz) * tickSz` 可能落回入场价上 —— 那等于「挂了止损但其实没有止损」。
 *    止损必须严格在入场价的**亏损侧**，宁可多推一个 tick。
 */

/** 把数值展开成不含科学计数法的十进制字符串（1e-12 → "0.000000000001"）。 */
export function toPlainDecimal(value: number): string {
  const s = String(value);
  if (!/e/i.test(s)) return s;
  const [mantissa, expPart] = s.split(/e/i);
  const exp = Number(expPart);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const intLen = (mantissa.replace("-", "").split(".")[0] ?? "").length;
  const pointAt = intLen + exp;
  const body =
    pointAt <= 0
      ? `0.${"0".repeat(-pointAt)}${digits}`
      : pointAt >= digits.length
        ? `${digits}${"0".repeat(pointAt - digits.length)}`
        : `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
  return negative ? `-${body}` : body;
}

/**
 * tickSz 的小数位数。
 *
 * 判据是 **tickSz 十进制写法里小数点后的位数**，既不是 `-log10(tickSz)`
 * （对 `0.5` 这种非 10 的整数次幂的步长会算出 0 位，把 6.5 写成 `7`），
 * 也不是「乘以 10^d 之后是否近似整数」—— 后者对 `1e-12` 这种极小步长会在
 * d=0 就被判成整数（`|1e-12 - 0| < 容差`），直接返回 0 位。
 */
export function tickDecimals(tickSz: number | string): number {
  const step = typeof tickSz === "string" ? Number(tickSz) : tickSz;
  if (!Number.isFinite(step) || step <= 0) return 0;
  const plain = toPlainDecimal(step);
  const frac = plain.split(".")[1] ?? "";
  return frac.length;
}

/**
 * 把价格吸附到 tickSz 网格上。
 *
 * `mode` 决定方向：`down` 朝下、`up` 朝上、`nearest` 就近。
 * 商上加了一个 1e-9 的容差，抵消 `1.234e-9 / 1e-12 = 1234.0000000000002` 这类浮点误差
 * 造成的整格跳变。
 */
export function roundToTick(
  px: number,
  tickSz: number | string,
  mode: "nearest" | "down" | "up" = "nearest"
): number {
  const step = typeof tickSz === "string" ? Number(tickSz) : tickSz;
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(px)) return px;
  const quotient = px / step;
  const n =
    mode === "down"
      ? Math.floor(quotient + 1e-9)
      : mode === "up"
        ? Math.ceil(quotient - 1e-9)
        : Math.round(quotient);
  return n * step;
}

/** 价格按 tickSz 取整并转成字符串（OKX 下单价格必须是 tickSz 的整数倍）。 */
export function fmtTick(px: number, tickSz: number | string): string {
  return roundToTick(px, tickSz).toFixed(tickDecimals(tickSz));
}

/**
 * 生成 OCO 的止损/止盈触发价字符串，并**保证止损在亏损侧、止盈在盈利侧**。
 *
 * `ref` 是入场参考价。最接近的取整若把止损吸到入场价或跑到了盈利侧，
 * 就朝亏损侧多推一个 tick —— 宁可止损远一格，也不能挂出一个「等于入场价」的止损。
 *
 * 返回 `null` 表示这条路走不通（步长非法、止损被推到 0 以下、或 `sl`/`tp` 与 `ref` 重合），
 * 调用方应当**拒绝下单**而不是退回一个兜底价。
 */
export function snappedSlTp(
  ref: number,
  sl: number,
  tp: number,
  tickSz: number | string
): { slStr: string; tpStr: string } | null {
  const step = typeof tickSz === "string" ? Number(tickSz) : tickSz;
  if (!Number.isFinite(step) || step <= 0) return null;
  if (!Number.isFinite(ref) || ref <= 0) return null;
  if (!Number.isFinite(sl) || !Number.isFinite(tp)) return null;
  if (sl === ref || tp === ref) return null;

  let slSnap = roundToTick(sl, step);
  let tpSnap = roundToTick(tp, step);

  // 止损：必须严格在亏损侧
  if (sl < ref) {
    if (slSnap >= ref) slSnap = roundToTick(ref, step, "down") - step;
  } else if (slSnap <= ref) {
    slSnap = roundToTick(ref, step, "up") + step;
  }

  // 止盈：必须严格在盈利侧
  if (tp > ref) {
    if (tpSnap <= ref) tpSnap = roundToTick(ref, step, "up") + step;
  } else if (tpSnap >= ref) {
    tpSnap = roundToTick(ref, step, "down") - step;
  }

  if (!(slSnap > 0) || !(tpSnap > 0)) return null;

  const decimals = tickDecimals(step);
  return { slStr: slSnap.toFixed(decimals), tpStr: tpSnap.toFixed(decimals) };
}
