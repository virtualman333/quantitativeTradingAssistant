/**
 * trace.ts —— 子进程 → 主进程 的 LLM 观测通道
 *
 * 仅当由 Electron 拉起（AGENT_UI=1）时，把观测事件以 `__TRACE__` 前缀 JSON 行写到 stdout；
 * electron/main.ts 解析该前缀并广播 llm:trace 到「观测」页签。独立跑（CLI/脚本）时静默，
 * stdout 仍只有纯日志，管道消费方不受污染。
 */
const PREFIX = "__TRACE__";

export function trace(e: Record<string, unknown>): void {
  if (process.env.AGENT_UI !== "1") return;
  try {
    process.stdout.write(PREFIX + JSON.stringify(e) + "\n");
  } catch {
    /* 观测失败不影响交易 */
  }
}

/** 一次 LLM 调用（来源：agent 轮次） */
export function traceRound(label: string, model?: string): void {
  trace({ source: "agent", kind: "round", label, ...(model ? { model } : {}) });
}
