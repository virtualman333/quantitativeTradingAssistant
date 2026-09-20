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
 * 判据只有一份：**该标的带止损触发价的 pending 算法单条数**。它与 `okx.confirmAlgo()`
 * 用的是同一个口径（章程点名的就是这条回查），所以 `confirmAlgo` 也改成调这里的
 * `pendingStopsFor()` —— 否则「止损存在性」很快会变成两处判据（本仓已经栽过六次的那类坑）。
 *
 * 判据的第二层：**「有挂单」不等于「有止损」**。
 *
 * 这条判据早先只数「该标的的 pending 算法单条数」，**不看到底有没有止损触发价**。于是
 * 一条只有止盈的算法单（或任何 `slTriggerPx` 为空的委托）就让「这笔有没有止损」的答案
 * 变成「有」：`confirmAlgo` 回查通过、`scalper` 的巡检把 `skipped` 的理由写成「止损在挂」、
 * `main.ts` 的裸仓告警一声不响 —— 而交易所侧根本没有止损。这正是文件开头描述的那个静默，
 * 只是换了一层皮：**判据比它要回答的问题窄，缩掉的那一格恰好是最要命的那一格。**
 * 现在只认带止损触发价的委托，两种拼写都认（见 `stopTriggerPxOf`）。
 *
 * 判据的第三层：**`main.ts` 里还藏着一份手写的**。
 *
 * 它把算法单先 `.map()` 成标的名再 `Set.has()` —— 与 `a.instId === inst` 是同一件事，
 * 只是形状不同，而 `tests/stopprotect.test.ts` 的反面扫描当时只认后者，**这条锁因此
 * 漏了它**（锁看着在管这件事，其实那一格走不到）。现在 `main.ts` 改调
 * `findNakedPositions()`，反面扫描也补上了这一族形状。
 */

/**
 * 从一条算法单里取「止损触发价」。
 *
 * 两种拼写都要认，这不是兼容性洁癖 —— **同一个事实在仓里本来就有两种拼写**：交易所
 * 原始返回是 `slTriggerPx`，而账户快照 `main.buildSnapshot()` 会把它重命名成 `slTrigger`
 * （见 `types.AlgoOrder`）。只认一个的话，另一种形态喂进来会**恒返回「没有止损」**，
 * 而「没有止损」是这条链上唯一会触发补挂/平仓的答案 —— 认错一个键，要么凭空多出一个
 * 裸仓去平仓，要么把真裸仓看漏。同理标的键也要认 `instId` 与 `inst` 两种。
 *
 * 只读**触发价**，不读执行价：OCO 的执行价写作 `slOrdPx=-1`（市价执行），那是
 * 「怎么执行」，不是「有没有止损」。
 *
 * 取不到 / 非正数 / 非数字一律 null —— 包括 `""`（`Number("")` 是 0，必须显式挡）。
 */
function stopTriggerPxOf(order: unknown): number | null {
  const o = order as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== "object") return null;
  const raw = o.slTriggerPx ?? o.slTrigger;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 一条算法单是不是「挂在 inst 上的止损单」 */
function isStopOrderFor(order: unknown, inst: string): boolean {
  const o = order as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== "object") return false;
  return String(o.instId ?? o.inst ?? "") === inst && stopTriggerPxOf(o) !== null;
}

/** 标的键的两种拼写（见 `stopTriggerPxOf` 的说明） */
function instOfOrder(order: unknown): string {
  const o = order as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== "object") return "";
  return String(o.instId ?? o.inst ?? "");
}

/**
 * 止损存在性判据：账户快照里该标的有几条**带止损触发价**的 pending 算法单。
 *
 * ⚠ 必须传**数组**（`fetchAccount().algoOrders` 或 `unwrap(...)` 后的结果）。
 * MCP 返回是三层洋葱 `result.data.data`，少剥一层就是个空数组 —— 空数组会让
 * 「没有止损」这条判据**在止损明明挂着的时候也成立**，于是每轮都去补挂一份。
 * 所以这里对非数组输入返回 0 之外，调用方还要自己保证剥对了（见 okx.unwrap）。
 *
 * ⚠ 调用方负责只喂 `status=pending` 的单（`okx.fetchAccount` 与 `confirmAlgo` 都是这么
 * 取的）。这里**刻意不看 `state` 字段**：自己凭想象多一道过滤，就多一种「止损明明挂着
 * 却判成没有」的路径，而这条链判错的代价是平仓 —— 需要它时应当先有实测证据。
 */
export function pendingStopsFor(algoOrders: unknown, inst: string): number {
  if (!Array.isArray(algoOrders)) return 0;
  if (!inst) return 0;
  return algoOrders.filter((a) => isStopOrderFor(a, inst)).length;
}

/**
 * 该标的 pending 算法单**总**条数（不分类型）。
 *
 * 与 `pendingStopsFor` 的差额就是「挂了单，但没有一条带止损触发价」。单看一个 0
 * 说不清是「一条都没挂」还是「挂了止盈忘了止损」，而这两种现场要人做的事不一样。
 */
export function pendingAlgoFor(algoOrders: unknown, inst: string): number {
  if (!Array.isArray(algoOrders)) return 0;
  if (!inst) return 0;
  return algoOrders.filter((a) => instOfOrder(a) === inst).length;
}

/** 一个裸仓的现场（字段都是调用方已经拿在手上的，不额外打接口） */
export interface NakedPosition {
  inst: string;
  side: string;
  sizeContracts: number;
  /** 该标的的 pending 算法单总条数 */
  algoOrders: number;
  /** 其中带止损触发价的条数（恒为 0 —— 否则它不会出现在这张表里） */
  stopOrders: number;
  /** 中文说明，直接进日志/告警 —— 用户要能读懂「凭什么说它没有止损」 */
  reason: string;
}

/**
 * 全仓裸仓巡检（纯函数）：找出「有持仓、但没有一条带止损触发价的挂单」的标的。
 *
 * 章程 L1-4 的判据是「**每笔持仓**必须存在止损」，所以这条巡检必须**逐持仓**做，
 * 不能只看「账户里有没有算法单」这个全局面：A 标的挂了止盈、B 标的连单都没有，
 * 按全局面看是「有单」，按持仓面看是两笔裸仓。
 *
 * 张数为 0 的持仓不算裸仓 —— 那是「没有持仓」，不是「有持仓没止损」。
 *
 * 持仓侧同时认 `inst`/`instId` 与 `sizeContracts`/`pos`（账户快照给前者，
 * `fetchAccount` 的原始行给后者），理由与 `stopTriggerPxOf` 里写的一样。
 */
export function findNakedPositions(positions: unknown, algoOrders: unknown): NakedPosition[] {
  if (!Array.isArray(positions)) return [];
  const out: NakedPosition[] = [];
  for (const raw of positions) {
    const p = raw as Record<string, unknown> | null | undefined;
    if (!p || typeof p !== "object") continue;
    const inst = String(p.inst ?? p.instId ?? "");
    if (!inst) continue;
    const size = Math.abs(Number(p.sizeContracts ?? p.pos ?? 0));
    if (!Number.isFinite(size) || size === 0) continue;
    const stops = pendingStopsFor(algoOrders, inst);
    if (stops > 0) continue;
    const algo = pendingAlgoFor(algoOrders, inst);
    out.push({
      inst,
      side: String(p.side ?? ""),
      sizeContracts: size,
      algoOrders: algo,
      stopOrders: stops,
      reason: algo
        ? `该标的挂着 ${algo} 条 pending 算法单，但没有一条带止损触发价（例如只挂了止盈）`
        : "该标的没有任何 pending 算法单",
    });
  }
  return out;
}

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
