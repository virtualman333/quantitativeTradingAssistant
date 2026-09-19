/**
 * stopprotect.ts —— 章程 L1-4「每笔持仓必须存在止损」的兜底决策（纯逻辑，零副作用）
 *
 * 章程 L1-4 原文有两句，缺一不可：
 *
 *   ① 开仓成交后须在**同一轮内**完成止损挂单并回查 `swap_get_algo_orders(status=pending)` 确认；
 *   ② **挂单失败且重试无效 → 立即市价平仓。**
 *
 * 本仓此前只实现了①的一半。`scalpOnce()` 挂完 OCO 把 `oco.ok && confirmed` 拼进一句日志，
 * 失败时**既不重试也不平仓**；而下一轮巡检看到「已有持仓 + 方向一致」就 `skipped`，
 * 理由还写着「等止盈/止损触发」—— 那句话在裸仓上**是假的**：交易所侧根本没有止损。
 * 于是这条无人值守的 60 秒循环能留下一个**永久裸仓**，而本地台账照记 sl/tp、
 * 界面照显示「持仓中」，没有任何一处会说出「这笔没有止损」。
 *
 * 这个模块只回答一个问题：**此刻该做什么**。三种答案：
 *
 *   - `none`   —— 该标的已有 pending 的止损/止盈委托，按章程无需动作；
 *   - `rehang` —— 没有 → 先补挂（章程的「重试」）；
 *   - `close`  —— 补挂走不通（已经试过一次仍失败，或这轮压根挂不出去）→ 立即市价平仓。
 *
 * 判据只有一份：**该标的的 pending 算法单条数**。它与 `okx.confirmAlgo()` 用的是同一个
 * 口径（章程点名的就是这条回查），所以 `confirmAlgo` 也改成调这里的 `pendingStopsFor()` ——
 * 否则「止损存在性」很快会变成两处判据（本仓已经栽过六次的那类坑）。
 */

/** 决策输入。字段都来自调用方已经拿在手上的现场，不额外打接口。 */
export interface StopContext {
  /** 该标的此刻 pending 的算法单（止损/止盈）条数，来自账户快照 `algoOrders` */
  pendingStops: number;
  /**
   * 这一轮里是否**已经补挂过一次**并失败。
   * 章程的「重试」只给一次机会 —— 第二次失败就不是「还没试」，而是「试过了不行」，
   * 那一步的处置是平仓而不是继续挂。
   */
  rehangTried: boolean;
  /**
   * 这轮「挂得出去吗」：既要有按 tickSz 取整好的止损/止盈价，也要有合规的 `clOrdId`
   * （L1-8 要求 clOrdId 必须由 `order_id.py` 生成）。缺任一项就没有「补挂」这条路 ——
   * 裸仓不许留，只能平仓。
   */
  canRehang: boolean;
}

export type StopAction = "none" | "rehang" | "close";

export interface StopDecision {
  action: StopAction;
  /** 中文说明，直接进 tick / 台账 / 界面 —— 用户要能读懂发生了什么 */
  why: string;
}

/**
 * 止损存在性判据：账户快照里该标的有几条 pending 算法单。
 *
 * ⚠ 必须传**数组**（`fetchAccount().algoOrders` 或 `unwrap(...)` 后的结果）。
 * MCP 返回是三层洋葱 `result.data.data`，少剥一层就是个空数组 —— 空数组会让
 * 「没有止损」这条判据**在止损明明挂着的时候也成立**，于是每轮都去补挂一份。
 * 所以这里对非数组输入返回 0 之外，调用方还要自己保证剥对了（见 okx.unwrap）。
 */
export function pendingStopsFor(algoOrders: unknown, inst: string): number {
  if (!Array.isArray(algoOrders)) return 0;
  if (!inst) return 0;
  return algoOrders.filter((a) => String((a as Record<string, unknown>)?.instId ?? "") === inst)
    .length;
}

/**
 * L1-4 的兜底决策。
 *
 * 顺序是有意的：**先看有没有止损，再看能不能补挂，最后才谈平仓**。
 * 平仓是不可逆动作，只有「确实没有止损」且「补挂这条路已经走不通」时才用。
 */
export function decideStopProtection(ctx: StopContext): StopDecision {
  const raw = Number(ctx?.pendingStops);
  const pending = Number.isFinite(raw) ? raw : 0;

  if (pending > 0) {
    return { action: "none", why: `已有 ${pending} 条 pending 止损/止盈委托` };
  }
  if (!ctx?.canRehang) {
    return {
      action: "close",
      why: "该标的没有 pending 止损委托，且这轮挂不出去（缺取整好的触发价或合规 clOrdId）—— 按 L1-4 立即市价平仓（裸仓不许留）",
    };
  }
  if (ctx?.rehangTried) {
    return {
      action: "close",
      why: "补挂止损已重试一次仍未确认 —— 按 L1-4「挂单失败且重试无效 → 立即市价平仓」",
    };
  }
  return {
    action: "rehang",
    why: "该标的没有 pending 止损委托 —— 补挂一次（就是章程说的那次「重试」）",
  };
}
