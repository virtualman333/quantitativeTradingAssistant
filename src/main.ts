/**
 * main.ts —— OKX 自主交易 Agent 主入口（常驻进程，5 分钟自驱）
 *
 * 与之前方案的决定性区别：
 *   旧方案：调度进程取数 → 打印 sentinel → 【依赖聊天会话里的 AI 主动去读】→ 决策
 *   本方案：进程内闭环 —— 取数 → 自己调 LLM 决策 → Guard 校验 → 执行 → 归档
 *          不依赖任何聊天会话，真正无人值守。
 *
 * 安全设计（三层，缺一不可）：
 *   1. prompt 层：把章程要点交给 LLM 做「判断」
 *   2. guard 层：L1 硬约束在代码里强制，LLM 违规一律拒绝（不靠它自觉）
 *   3. 执行层：mcp_call.py 的 demo 限制 + live 写操作拒绝
 *
 * 大额人工确认：单笔风险 >2%（或熔断/异常）时，不执行，写 PENDING_APPROVAL 并告警。
 *
 * 用法：
 *   pnpm install && pnpm run dev        # 常驻，5 分钟一轮
 *   pnpm run once                        # 只跑一轮
 *   pnpm run dry                         # dry-run：只读取数 + 决策，不执行任何写操作
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, fetchAccount, fetchMarket, genClOrdId, placeOco, placeOrder, confirmAlgo, setLeverage, closePosition, runPy } from "./okx.js";
import { SYSTEM_PROMPT, createLlmProvider, parseDecision } from "./llm.js";
import { guardClOrdId, guardDecision, guardLeverage, ALLOWED_INSTS } from "./guard.js";
import type { AccountSnapshot, Decision, Position, TradeIntent } from "./types.js";

const INTERVAL_MS = Number(process.env.ROUND_INTERVAL_MS ?? 5 * 60 * 1000);
const DRY_RUN = process.argv.includes("--dry-run");
const ONCE = process.argv.includes("--once");

const STATE = path.join(ROOT, "state");
const LOG_DIR = path.join(ROOT, "logs", "agent");

function ts() {
  return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}
function log(...a: unknown[]) {
  const line = `[${ts()}] ${a.join(" ")}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`),
      line + "\n",
      "utf8"
    );
  } catch {
    /* 日志失败不影响交易 */
  }
}

/** 读取章程关键章节作为 LLM 上下文（只取要点，避免 prompt 过长） */
function loadCharter(): string {
  const p = path.join(ROOT, "AGENT_TRADING_RULES.md");
  if (!fs.existsSync(p)) return "（章程文件缺失）";
  const txt = fs.readFileSync(p, "utf8");
  // 取前 ~6000 字（含 §0 目标、§0.2 效力分层、§1 L1 清单、§2 环境）
  return txt.slice(0, 6000);
}

function buildSnapshot(raw: Awaited<ReturnType<typeof fetchAccount>>): AccountSnapshot {
  const positions: Position[] = raw.positions.map((p) => {
    const pos = Number(p.pos ?? 0);
    return {
      inst: String(p.instId ?? ""),
      side: pos < 0 ? "short" : "long",
      sizeContracts: Math.abs(pos),
      entry: Number(p.avgPx ?? 0),
      mark: Number(p.markPx ?? 0),
      leverage: Number(p.lever ?? 0),
      upl: Number(p.upl ?? 0),
    };
  });
  return {
    equityUsdt: raw.equityUsdt ?? 0,
    availableUsdt: raw.availableUsdt ?? 0,
    positions,
    algoOrders: raw.algoOrders.map((a) => ({
      inst: String(a.instId ?? ""),
      algoId: String(a.algoId ?? ""),
      tpTrigger: (a.tpTriggerPx as string) ?? null,
      slTrigger: (a.slTriggerPx as string) ?? null,
      state: (a.state as string) ?? undefined,
    })),
  };
}

/** 读取运行态（当日止损数、回撤等，用于熔断） */
function loadRuntime(): { daySlCount: number; dayDdPct: number; monthDdPct: number; roundNo: number } {
  const p = path.join(STATE, "runtime.json");
  const def = { daySlCount: 0, dayDdPct: 0, monthDdPct: 0, roundNo: 0 };
  if (!fs.existsSync(p)) return def;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, number>;
    return {
      daySlCount: j.day_sl_count ?? 0,
      dayDdPct: j.day_pnl_pct != null ? -j.day_pnl_pct : 0,
      monthDdPct: j.month_dd_pct ?? 0,
      roundNo: j.round_no ?? 0,
    };
  } catch {
    return def;
  }
}

async function nextRoundId(): Promise<string> {
  const n = loadRuntime().roundNo + 1;
  return `R${String(n).padStart(6, "0")}`;
}

/** 执行一个开仓意图（含 L1 全流程） */
async function executeOpen(
  it: TradeIntent,
  snap: AccountSnapshot,
  roundId: string,
  seq: number
): Promise<{ ok: boolean; msg: string }> {
  const mark = snap.positions.find((p) => p.inst === it.inst)?.mark ?? 0;
  const inst = it.inst;
  // 若已持仓则取持仓 mark，否则用行情价（此处简化：用持仓或最近 mark）
  const refPx = mark > 0 ? mark : 0;
  if (refPx <= 0) return { ok: false, msg: `${inst}: 无有效参考价，跳过` };
  if (!it.slDist || !it.riskPct) return { ok: false, msg: `${inst}: 缺 slDist/riskPct，跳过` };

  // 仓位：名义 = 权益×riskPct ÷ (slDist/refPx)
  const notional = (snap.equityUsdt * it.riskPct) / (it.slDist / refPx);
  const ctVal = inst.startsWith("BTC") ? 0.01 : 0.1;
  const size = Number((notional / (refPx * ctVal)).toFixed(4));
  if (!(size > 0)) return { ok: false, msg: `${inst}: 计算张数为 0，跳过` };

  const lever = Number((notional / snap.equityUsdt).toFixed(2));
  const gl = guardLeverage(lever);
  if (!gl.ok) return { ok: false, msg: `${inst}: ${gl.violations.join("; ")}` };

  const side = it.action === "long" ? "buy" : "sell";
  const slPx = it.action === "long" ? refPx - it.slDist : refPx + it.slDist;
  const tpPx =
    it.action === "long"
      ? refPx + it.slDist * (it.tpRR ?? 2)
      : refPx - it.slDist * (it.tpRR ?? 2);

  // L1-8 clOrdId
  const cl = await genClOrdId(roundId, seq, { instId: inst, sz: size });
  if (!cl) return { ok: false, msg: `${inst}: clOrdId 生成失败，取消` };
  const gc = guardClOrdId(cl);
  if (!gc.ok) return { ok: false, msg: `${inst}: ${gc.violations.join("; ")}` };

  if (DRY_RUN) {
    return {
      ok: true,
      msg: `[DRY] ${inst} ${side} 张数=${size} 名义≈${notional.toFixed(0)} 杠杆≈${lever}x SL=${slPx.toFixed(2)} TP=${tpPx.toFixed(2)} clOrdId=${cl}`,
    };
  }

  await setLeverage(inst, Math.min(lever, 5));
  const placed = await placeOrder({ inst, side, size, clOrdId: cl });
  if (!placed.ok) return { ok: false, msg: `${inst}: 下单失败 ${placed.raw.slice(0, 200)}` };

  // L1-4 同轮挂止损
  const oco = await placeOco({
    inst,
    side: it.action === "long" ? "sell" : "buy",
    size,
    slPx,
    tpPx,
    clOrdId: cl + "oc",
  });
  const confirmed = await confirmAlgo(inst);
  return {
    ok: oco.ok && confirmed,
    msg: `${inst} ${side} ${size}张 成交; OCO ${oco.ok ? "已挂" : "失败"}; 回查确认=${confirmed}`,
  };
}

async function executeClose(it: TradeIntent, snap: AccountSnapshot): Promise<{ ok: boolean; msg: string }> {
  const p = snap.positions.find((x) => x.inst === it.inst);
  if (!p) return { ok: false, msg: `${it.inst}: 无持仓，忽略` };
  if (DRY_RUN) return { ok: true, msg: `[DRY] 平仓 ${it.inst} ${p.sizeContracts} 张` };
  const r = await closePosition({
    inst: it.inst,
    side: p.side === "short" ? "buy" : "sell",
    size: p.sizeContracts,
  });
  return { ok: r.ok, msg: `${it.inst} 平仓 ${r.ok ? "成功" : "失败"}` };
}

async function runRound() {
  const roundId = await nextRoundId();
  log(`===== 轮次 ${roundId} 开始 =====`);

  // ① 取数
  const [acctRaw, mkt] = await Promise.all([fetchAccount(), fetchMarket()]);
  const snap = buildSnapshot(acctRaw);
  log(`权益=${snap.equityUsdt} 持仓=${snap.positions.length} 行情ok=${mkt.ok}`);

  if (snap.equityUsdt <= 0) {
    log("无法获取权益，本轮终止");
    return;
  }

  // ② 裸仓告警（L1-4）
  const algoInsts = new Set(snap.algoOrders.map((a) => a.inst));
  for (const p of snap.positions) {
    if (!algoInsts.has(p.inst)) log(`⚠ 裸仓告警 ${p.inst} 无止损挂单（L1-4）`);
  }

  // ③ LLM 决策
  const llm = createLlmProvider();
  const rt = loadRuntime();
  const userPrompt = [
    `轮次 ${roundId}，时间 ${ts()}，环境 demo（模拟盘）`,
    ``,
    `【账户】权益 ${snap.equityUsdt} USDT，可用 ${snap.availableUsdt}`,
    `【持仓】${snap.positions.length ? JSON.stringify(snap.positions) : "无持仓"}`,
    `【挂单】${snap.algoOrders.length ? JSON.stringify(snap.algoOrders) : "无"}`,
    `【运行态】当日止损 ${rt.daySlCount} 次，当日盈亏 ${rt.dayDdPct}%，月度回撤 ${rt.monthDdPct}%`,
    ``,
    `【行情】${JSON.stringify(mkt.data).slice(0, 6000)}`,
    ``,
    `请按格式输出决策 JSON。`,
  ].join("\n");

  let decision: Decision | null = null;
  try {
    const raw = await llm.decide(SYSTEM_PROMPT + "\n\n" + loadCharter(), userPrompt);
    decision = parseDecision(raw, roundId);
  } catch (e) {
    log(`LLM 调用失败: ${String(e).slice(0, 200)}`);
  }
  if (!decision) {
    log("未获得有效决策，本轮观望");
    return;
  }
  log(`决策=${decision.decision} 摘要=${decision.summary.slice(0, 120)}`);

  // ④ Guard 校验（L1 硬约束，不可绕过）
  const g = guardDecision(decision, {
    account: snap,
    daySlCount: rt.daySlCount,
    monthDdPct: rt.monthDdPct,
    dayDdPct: rt.dayDdPct,
  });
  if (g.warnings.length) log(`警告: ${g.warnings.join(" | ")}`);
  if (!g.ok) {
    log(`❌ Guard 拒绝，本轮不执行:\n  - ${g.violations.join("\n  - ")}`);
    fs.writeFileSync(
      path.join(STATE, `guard_reject_${roundId}.json`),
      JSON.stringify({ roundId, violations: g.violations, decision }, null, 2),
      "utf8"
    );
    return;
  }

  // ⑤ 大额人工确认（用户设定）
  if (g.needsApproval) {
    const msg = `⏸ 需人工确认: ${g.approvalReason}`;
    log(msg);
    fs.writeFileSync(
      path.join(STATE, `PENDING_APPROVAL_${roundId}.json`),
      JSON.stringify({ roundId, reason: g.approvalReason, decision }, null, 2),
      "utf8"
    );
    return; // 不执行，等人工
  }

  // ⑥ 执行
  let seq = 0;
  for (const it of decision.intents) {
    if (!ALLOWED_INSTS.includes(it.inst as (typeof ALLOWED_INSTS)[number])) {
      log(`跳过非合规标的 ${it.inst}`);
      continue;
    }
    if (it.action === "hold") continue;
    seq++;
    const r =
      it.action === "close"
        ? await executeClose(it, snap)
        : await executeOpen(it, snap, roundId, seq);
    log(`执行 ${it.inst}/${it.action}: ${r.ok ? "✅" : "❌"} ${r.msg}`);
  }

  // ⑦ 归档（经 python archive_round.py，只追加）
  try {
    const payload = {
      round_id: roundId,
      time_cst: ts(),
      interval: "5 分钟",
      env: "demo",
      equity_usdt: snap.equityUsdt,
      available_usdt: snap.availableUsdt,
      positions: snap.positions.map((p) => ({
        instrument: p.inst,
        side: p.side,
        size_contracts: p.sizeContracts,
        entry: p.entry,
        mark: p.mark,
        leverage: p.leverage,
        upl: p.upl,
      })),
      live_watch: [],
      actions: decision.intents.map((i) => `${i.inst}:${i.action} — ${i.reason}`),
      decision: decision.summary,
      market_summary: JSON.stringify(mkt.data).slice(0, 4000),
      deviations: decision.intents.flatMap((i) => i.deviations ?? []),
    };
    fs.writeFileSync(
      path.join(STATE, `round_input_${roundId}.json`),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
    await runPy("archive_round.py", ["--in", path.join("state", `round_input_${roundId}.json`)]);
    log(`归档完成 ${roundId}`);
  } catch (e) {
    log(`归档失败（不回滚）: ${String(e).slice(0, 200)}`);
  }

  log(`===== 轮次 ${roundId} 结束 =====`);
}

async function main() {
  log(`OKX Agent 启动 interval=${INTERVAL_MS}ms dry=${DRY_RUN} once=${ONCE} llm=${createLlmProvider().name}`);
  if (ONCE || DRY_RUN) {
    await runRound();
    return;
  }
  // 常驻循环：单轮异常不退出
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runRound();
    } catch (e) {
      log(`本轮异常: ${String(e).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  log(`FATAL: ${String(e)}`);
  process.exit(1);
});
