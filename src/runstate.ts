/**
 * runstate.ts — 运行态（`state/runtime.json`）的唯一读取处
 *
 * 这个文件由 `scripts/archive_round.py` 每轮覆盖写入（唯一写入者），
 * 内容是「跨轮次累积的状态」：当日止损计数、当日盈亏、**月度回撤**、轮次号。
 *
 * 为什么要单独成模块：
 * 主 Agent 路径（main.ts）与超短线路径（scalper.ts）都要读它 ——
 * 前者判 L1-6 熔断，后者现在也要判同一件事。读同一份状态、走同一个字段名，
 * 才不会出现「一边读 `month_dd_pct`、一边读 `monthDdPct`」这种静默失效
 * （本仓踩过一次：archive_round.py 写 `round_count`，main.ts 读 `round_no`，
 * 导致 round_id 永远停在 R000001，而两侧都不报错）。
 *
 * 约定：**字段缺失一律返回 null，不要用 `?? 0` 兜底**。
 * `month_dd_pct` 缺失的意思是「不知道回撤多少」，不是「没有回撤」——
 * 曾经的 `?? 0` 正是 L1-6 熔断从未触发的直接原因。
 *
 * 三条读数路径，**一个判据**（`normalizeRuntime()`）
 * ------------------------------------------------
 * 同一份运行态有三处读者：主 Agent 路径（`main.ts`）、超短线路径（`scalper.ts`，经本文件）、
 * 桌面端总览页（`electron/main.ts` 的 `getStatus()` → `ui/lib/riskbrief.js`）。
 * 早先它们各自决定「读不出来算怎么回事」：
 *
 *   - 本文件的 `loadRunState()` —— `catch { return def }`，而 `def` 里
 *     `dayCountersCompromised: false`、`daySlCount: 0`；
 *   - `electron/main.ts` 的 `readJsonSafe()` —— 返回 `null`，界面于是显示「本日止损 0」；
 *   - `scripts/archive_round.py` —— 这一处是**对的**（留档 + 写 `day_counters_compromised`
 *     + `circuit_breaker: null`），但它在**本轮结尾**才跑。
 *
 * 于是「文件存在但读不出来」这件事，在整轮交易期间对所有读者都表现为
 * 「今天一次止损都没触发过 / 回撤 0.00% 正常」—— 与第 13/14 轮修掉的那条
 * `jsonstore` 缺陷（`except: 当作首次初始化`）是同一个形状，只是这次在 TS 侧：
 * **Python 侧一个字都没漏，TS 侧一个字都没改。**
 *
 * 所以「这份读数可不可信」收进 `normalizeRuntime()` 一处：遇到坏文件就写出与
 * `archive_round.py` **同一组标记键**（`day_counters_compromised` / `month_dd_error`），
 * 下游（闸门、提示词、界面）不需要各自再判一次。
 */
import fs from "node:fs";
import path from "node:path";

import { AGENT_ROOT } from "./store.js";

export interface RunState {
  /** 当日止损触发次数（缺失视为 0 —— 「没发生过」）。
   *  ⚠ `dayCountersCompromised` 为真时这个 0 是**重置出来的**，不是「今天没止损过」。 */
  daySlCount: number;
  /** 当日盈亏（%，缺失视为 0）。同样受 `dayCountersCompromised` 影响。 */
  dayPnlPct: number;
  /** 月度回撤（%，负数）；**缺失为 null**，调用方须自行决定如何对待「未知」 */
  monthDdPct: number | null;
  /** 月度收益率（%，缺失为 null） */
  monthPnlPct: number | null;
  /** 轮次序号（archive_round.py 写的是 round_count） */
  roundNo: number;
  /**
   * 本日累计计数是否**已经不可信** —— `state/runtime.json` 曾被写坏、坏文件已留档、
   * 计数从 0 重新开始。三态同源：`null` = 不知道熔没熔断，`false` = 未熔断。
   * 这是本文件里唯一「写 null 而不是 false」的字段，别用 `?? false` 把它洗成「一切正常」。
   */
  circuitBreaker: boolean | null;
  /** 本日止损计数 / 当日盈亏是否因为状态文件损坏被重置过（重置后的 0 ≠ 今天没止损） */
  dayCountersCompromised: boolean;
  /**
   * 文件**存在但读不出来**的原因（空文件 / 半截 JSON / 顶层不是对象）；读得出来、
   * 或文件压根不存在时为 `null`。
   *
   * 为什么要单独一个字段：`dayCountersCompromised` 说的是「计数被重置过」，
   * 而这一条说的是「**我们连文件都没读到**」—— 两者都会让那几个 0 不可信，
   * 但后者得有人去修（留档、查磁盘），所以要在日志与提示词里点名，不能并进前者。
   */
  unreadable: string | null;
}

export const RUNTIME_FILE = path.join(AGENT_ROOT, "state", "runtime.json");

/** 读一条数值字段：缺失/非法一律返回 null，不替调用方补 0 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 读一个「可能是 null 的三态布尔」：只有明确的 true / false 才算数，其它一律 null（未知） */
function triBool(v: unknown): boolean | null {
  return v === true ? true : v === false ? false : null;
}

/**
 * 一次读盘的三态结论。**「没有文件」与「文件读不出来」必须是两个东西**：
 * 前者是新机器首次运行（正常，可以初始化），后者是**数据丢了**（要有人知道）。
 */
export interface RawRuntime {
  /** 解析出来的原始对象；读不出来时为 `null` */
  raw: Record<string, unknown> | null;
  /** 文件存在但读不出来的原因；不存在或读得出来时为 `null` */
  error: string | null;
  /** 文件压根不存在 */
  absent: boolean;
}

export function readRuntimeFile(file: string = RUNTIME_FILE): RawRuntime {
  if (!fs.existsSync(file)) return { raw: null, error: null, absent: true };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { raw: null, error: `读盘失败（${String(e).slice(0, 120)}）`, absent: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // 空文件单独说一句：它比「JSON 语法错」更像「写了一半就没了」，
    // 而 `JSON.parse("")` 的报错文本（"Unexpected end of JSON input"）看不出这一点。
    const why = text.trim() === "" ? "文件是空的（0 字节）" : `JSON 解析失败（${String(e).slice(0, 120)}）`;
    return { raw: null, error: why, absent: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed) ? "数组" : parsed === null ? "null" : typeof parsed;
    return { raw: null, error: `顶层不是对象（是${kind}）`, absent: false };
  }
  return { raw: parsed as Record<string, unknown>, error: null, absent: false };
}

/**
 * 把「一份运行态原文 + 它的读盘结论」归一化成下游都认得的那几个字段。
 *
 * **这是「这份读数可不可信」的唯一一处判据。** 三个读者（agent 主路径 / 超短线 / 桌面端）
 * 都从这里拿结论，谁也不许自己再判一次 —— 各判一次的代价是「三种说法，其中两种是谎」，
 * 本仓已经在这件事上栽过（先例见文件头）。
 *
 * 遇到坏文件时写出的键**与 `scripts/archive_round.py` 发现损坏时写的完全同一组**：
 * `day_counters_compromised`（计数不可信）、`month_dd_error`（月度状态算不出来）。
 * 这样 `ui/lib/riskbrief.js` 里已有的两条「不可信」分支不必再改一个字。
 */
export function normalizeRuntime(rc: RawRuntime): Record<string, unknown> {
  // 读得出来（含「没有文件」这一路）：原样交出去，不要在健康数据上叠任何标记。
  if (!rc.error) return rc.raw ?? {};
  const why = `state/runtime.json 存在但读不出来（${rc.error}）`;
  return {
    day_counters_compromised: true,
    day_counters_compromised_at: "本地读数",
    day_counters_compromised_error: why,
    month_dd_error: why,
  };
}

/** 把归一化后的原文投影成闸门要的那几个字段（字段缺失一律 null / 0，见文件头约定） */
export function runStateFrom(rc: RawRuntime): RunState {
  const j = normalizeRuntime(rc);
  return {
    daySlCount: num(j.day_sl_count) ?? 0,
    dayPnlPct: num(j.day_pnl_pct) ?? 0,
    monthDdPct: num(j.month_dd_pct),
    monthPnlPct: num(j.month_pnl_pct),
    // 注意：archive_round.py 写的字段是 round_count（不是 round_no），
    // 之前读错字段导致 round_id 永远停在 R000001（实测踩过，rounds.jsonl 里重复了 11 次 R000001）。
    roundNo: num(j.round_no) ?? num(j.round_count) ?? 0,
    circuitBreaker: triBool(j.circuit_breaker),
    // 读数不可信时这里必须是 true —— 早期版本把「文件坏了」与「没有文件」都返回默认值
    // （compromised=false、day_sl_count=0），等于告诉模型与用户「今天一次止损都没触发过」。
    dayCountersCompromised: j.day_counters_compromised === true,
    unreadable: rc.error,
  };
}

export function loadRunState(file: string = RUNTIME_FILE): RunState {
  return runStateFrom(readRuntimeFile(file));
}
