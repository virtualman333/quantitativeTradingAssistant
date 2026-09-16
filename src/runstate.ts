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
  /** 当日止损触发次数（缺失视为 0 —— 「没发生过」） */
  daySlCount: number;
  /** 当日盈亏（%，缺失视为 0） */
  dayPnlPct: number;
  /** 月度回撤（%，负数）；**缺失为 null**，调用方须自行决定如何对待「未知」 */
  monthDdPct: number | null;
  /** 月度收益率（%，缺失为 null） */
  monthPnlPct: number | null;
  /** 轮次序号（archive_round.py 写的是 round_count） */
  roundNo: number;
}

export const RUNTIME_FILE = path.join(AGENT_ROOT, "state", "runtime.json");

/** 读一条数值字段：缺失/非法一律返回 null，不替调用方补 0 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function loadRunState(file: string = RUNTIME_FILE): RunState {
  const def: RunState = { daySlCount: 0, dayPnlPct: 0, monthDdPct: null, monthPnlPct: null, roundNo: 0 };
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
    };
  } catch {
    return def;
  }
}
