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

export function loadRunState(file: string = RUNTIME_FILE): RunState {
  const def: RunState = {
    daySlCount: 0,
    dayPnlPct: 0,
    monthDdPct: null,
    monthPnlPct: null,
    roundNo: 0,
    circuitBreaker: null,
    dayCountersCompromised: false,
  };
  if (!fs.existsSync(file)) return def;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      daySlCount: num(j.day_sl_count) ?? 0,
      dayPnlPct: num(j.day_pnl_pct) ?? 0,
      monthDdPct: num(j.month_dd_pct),
      monthPnlPct: num(j.month_pnl_pct),
      // 注意：archive_round.py 写的字段是 round_count（不是 round_no），
      // 之前读错字段导致 round_id 永远停在 R000001（实测踩过，rounds.jsonl 里重复了 11 次 R000001）。
      roundNo: num(j.round_no) ?? num(j.round_count) ?? 0,
      circuitBreaker: triBool(j.circuit_breaker),
      // 文件读不出来时 `false` 也是假的 —— 但那条路已经在 archive_round 侧挡下了：
      // 它写盘前必先把坏文件留档并置上本标记，所以这里读到的一定是它写下来的结论。
      dayCountersCompromised: j.day_counters_compromised === true,
    };
  } catch {
    return def;
  }
}
