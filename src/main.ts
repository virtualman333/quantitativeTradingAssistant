/**
 * main.ts —— OKX 自主交易 Agent 主入口（LangGraph 多专家版）
 *
 * 拓扑：collect → plan →(Send 并行)→ 专家们 → adjudge → execute → archive
 *
 * 分工：
 *   graph.ts   只做编排（取 LLM 观点、汇总、拍板）
 *   main.ts    负责副作用（取数、执行下单、归档）
 *   理由：副作用留在图外，图才可以被独立测试与回放（checkpoint 才能落地）。
 *
 * 用法：
 *   LLM_PROVIDER=mock      pnpm run once   # 联调，不联网不耗 token
 *   LLM_PROVIDER=deepseek  pnpm run once   # 真实决策（需 DEEPSEEK_API_KEY）
 *   LLM_PROVIDER=deepseek  pnpm run dev    # 常驻，5 分钟一轮
 *   pnpm run dry                            # 只读取数+决策，不执行写操作
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, fetchAccount, fetchMarket, genClOrdId, placeOco, placeOrder, confirmAlgo, setLeverage, closePosition, runPy } from "./okx.js";
import { AgentState, buildGraphWithMcp, makeStoreLlmProvider } from "./graph.js";
import { reflectExperts } from "./experts.js";
import { reloadStore } from "./store.js";
import { guardIntent } from "./guard.js";
import { alert } from "./alert.js";
import { generateRoundReport, generateAllReports } from "./report.js";
import type { AccountSnapshot, Position, TradeIntent } from "./types.js";

// 间隔优先级：环境变量（界面/命令行指定）> store 设置 > 默认 5 分钟
const INTERVAL_MS = (() => {
  const env = Number(process.env.ROUND_INTERVAL_MS);
  if (Number.isFinite(env) && env > 0) return env;
  try {
    const p = path.join(ROOT, "data", "store.json");
    if (fs.existsSync(p)) {
      const m = Number(JSON.parse(fs.readFileSync(p, "utf8"))?.settings?.intervalMin);
      if (Number.isFinite(m) && m > 0) return m * 60 * 1000;
    }
  } catch {
    /* 回退默认 */
  }
  return 5 * 60 * 1000;
})();
const DRY_RUN = process.argv.includes("--dry-run");
const ONCE = process.argv.includes("--once");
const STATE = path.join(ROOT, "state");
const LOG_DIR = path.join(ROOT, "logs", "agent");

/**
 * 时间格式必须是 YYYY-MM-DD HH:MM:SS（CST）。
 * archive_round.py 用 datetime.strptime(..., "%Y-%m-%d %H:%M:%S") 严格解析，
 * toLocaleString 会给出 "2026/9/2 21:45:50" 导致 ValueError（实测踩过）。
 */
function ts(d: Date = new Date()): string {
  const cst = new Date(d.getTime() + 8 * 3600 * 1000); // UTC+8
  const p = (n: number) => String(n).padStart(2, "0");
  return `${cst.getUTCFullYear()}-${p(cst.getUTCMonth() + 1)}-${p(cst.getUTCDate())} ${p(
    cst.getUTCHours()
  )}:${p(cst.getUTCMinutes())}:${p(cst.getUTCSeconds())}`;
}
function log(...a: unknown[]) {
  const line = `[${ts()}] ${a.join(" ")}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`), line + "\n", "utf8");
  } catch {
    /* 日志失败不影响交易 */
  }
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

/** 从 market_scan 输出里取现价（优先 ticker.last，回退 1H/15m/4H 的 live_close/close） */
function refPriceOf(mkt: unknown, inst: string): number {
  try {
    const data = mkt as { instruments?: Record<string, any> };
    const instData = data?.instruments?.[inst];
    if (!instData) return 0;
    const last = instData?.context?.ticker?.last;
    if (typeof last === "number" && last > 0) return last;
    const bars = instData?.bars ?? {};
    for (const b of ["1H", "15m", "4H"]) {
      const bar = bars[b];
      const v = bar?.live_close ?? bar?.close;
      if (typeof v === "number" && v > 0) return v;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

/** 合约规格（由 market_scan.py 从 OKX instruments 动态获取，替代硬编码 BTC/ETH 面值） */
interface InstSpec {
  ctVal: number;   // 每张面值（如 BTC=0.01, ETH=0.1, SATS=10000000）
  lotSz: number;   // 下单数量步长（张）
  minSz: number;   // 最小下单量（张）
  tickSz: number;  // 价格步长
}

function specOf(mkt: unknown, inst: string): InstSpec | null {
  try {
    const d = mkt as { instruments?: Record<string, any> };
    const s = d?.instruments?.[inst]?.spec;
    if (!s) return null;
    const ctVal = Number(s.ctVal);
    if (!(ctVal > 0)) return null;
    const lotSz = Number(s.lotSz);
    const minSz = Number(s.minSz);
    const tickSz = Number(s.tickSz);
    return {
      ctVal,
      lotSz: lotSz > 0 ? lotSz : 0.01,
      minSz: minSz > 0 ? minSz : 0.01,
      tickSz: tickSz > 0 ? tickSz : 0.01,
    };
  } catch {
    return null;
  }
}

/** 本轮行情中确认存在且 state=live 的标的集合（供 Guard L1-1 校验） */
function knownInstsOf(mkt: unknown): Set<string> {
  const out = new Set<string>();
  try {
    const d = mkt as { instruments?: Record<string, any> };
    for (const [inst, v] of Object.entries(d?.instruments ?? {})) {
      if (v && v.spec && String(v.spec.state) === "live") out.add(inst);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** 把行情压缩成一行一标的的精简摘要（market_scan.py 已生成 digest，回退用全文） */
function buildMarketDigest(mkt: unknown): string {
  try {
    const d = mkt as { digest?: string[]; instruments?: Record<string, unknown> };
    if (Array.isArray(d.digest) && d.digest.length) {
      return d.digest.join("\n");
    }
    return JSON.stringify(d.instruments ?? {}).slice(0, 6000);
  } catch {
    return "行情不可用";
  }
}

/** 价格按 tickSz 取整并转字符串（避免科学计数法，OKX 下单价格须为 tickSz 整数倍） */
function fmtTick(px: number, tickSz: number): string {
  const decimals = Math.max(0, Math.min(8, Math.round(-Math.log10(tickSz))));
  const snapped = Math.round(px / tickSz) * tickSz;
  return snapped.toFixed(decimals);
}

function loadRuntime() {
  const p = path.join(STATE, "runtime.json");
  const def = { daySlCount: 0, dayPnlPct: 0, monthDdPct: 0, roundNo: 0 };
  if (!fs.existsSync(p)) return def;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, number>;
    return {
      daySlCount: j.day_sl_count ?? 0,
      dayPnlPct: j.day_pnl_pct ?? 0,
      monthDdPct: j.month_dd_pct ?? 0,
      // 注意：archive_round.py 写的字段是 round_count（不是 round_no），
      // 之前读错字段导致 round_id 永远停在 R000001（实测踩过，rounds.jsonl 里重复了 11 次 R000001）。
      roundNo: j.round_no ?? j.round_count ?? 0,
    };
  } catch {
    return def;
  }
}

// ── 副作用：执行与归档（图外） ─────────────────────────────
async function executeOpen(
  it: TradeIntent,
  snap: AccountSnapshot,
  roundId: string,
  seq: number,
  refPrice: number,
  spec: InstSpec | null
) {
  const inst = it.inst;
  const refPx = refPrice;
  if (refPx <= 0) return { ok: false, msg: `${inst}: 无参考价（行情缺失）` };
  if (!it.slDist || !it.riskPct) return { ok: false, msg: `${inst}: 缺 slDist/riskPct` };
  if (!spec || !(spec.ctVal > 0)) return { ok: false, msg: `${inst}: 缺合约规格（无法计算张数）` };

  const notional = (snap.equityUsdt * it.riskPct) / (it.slDist / refPx);
  // 张数 = 名义 / (每张面值 × 现价)，按 lotSz 步长向下取整，且不小于 minSz
  const rawSize = notional / (refPx * spec.ctVal);
  const size = Number(
    (Math.max(spec.minSz, Math.floor(rawSize / spec.lotSz) * spec.lotSz)).toFixed(10)
  );
  if (!(size > 0)) return { ok: false, msg: `${inst}: 张数为 0（raw=${rawSize.toFixed(6)}）` };

  const lever = Number((notional / snap.equityUsdt).toFixed(2));
  const side = it.action === "long" ? "buy" : "sell";
  const slPx = it.action === "long" ? refPx - it.slDist : refPx + it.slDist;
  const tpPx = it.action === "long" ? refPx + it.slDist * (it.tpRR ?? 2) : refPx - it.slDist * (it.tpRR ?? 2);
  const slPxStr = fmtTick(slPx, spec.tickSz);
  const tpPxStr = fmtTick(tpPx, spec.tickSz);

  const g = await genClOrdId(roundId, seq, { instId: inst, sz: size });
  if (!g.clOrdId) {
    log(`clOrdId 生成失败 ${inst}: ${g.error ?? "未知原因"}`);
    return { ok: false, msg: `${inst}: clOrdId 生成失败（${g.error ?? "未知原因"}）` };
  }
  const cl = g.clOrdId;

  if (DRY_RUN) {
    return { ok: true, msg: `[DRY] ${inst} ${side} ${size}张 名义≈${notional.toFixed(0)} 杠杆≈${lever}x SL=${slPxStr} TP=${tpPxStr} id=${cl}` };
  }

  await setLeverage(inst, Math.min(Math.max(lever, 1), 5));
  const placed = await placeOrder({ inst, side, size, clOrdId: cl });
  if (!placed.ok) return { ok: false, msg: `${inst}: 下单失败 ${placed.raw.slice(0, 180)}` };

  const oco = await placeOco({ inst, side: side === "buy" ? "sell" : "buy", size, slPx: slPxStr, tpPx: tpPxStr, clOrdId: cl + "oc" });
  const confirmed = await confirmAlgo(inst);
  return { ok: oco.ok && confirmed, msg: `${inst} ${side} ${size}张; OCO=${oco.ok}; 回查=${confirmed}` };
}

async function executeClose(it: TradeIntent, snap: AccountSnapshot) {
  const p = snap.positions.find((x) => x.inst === it.inst);
  if (!p) return { ok: false, msg: `${it.inst}: 无持仓` };
  if (DRY_RUN) return { ok: true, msg: `[DRY] 平仓 ${it.inst} ${p.sizeContracts}张` };
  const r = await closePosition({ inst: it.inst, side: p.side === "short" ? "buy" : "sell", size: p.sizeContracts });
  return { ok: r.ok, msg: `${it.inst} 平仓 ${r.ok ? "成功" : "失败"}` };
}

// ── 主流程 ────────────────────────────────────────────────
async function runRound() {
  // 每轮重读配置（界面改模型/角色/MCP 即时生效，无需重启 agent）
  reloadStore();
  const rt = loadRuntime();
  const roundId = `R${String(rt.roundNo + 1).padStart(6, "0")}`;
  log(`===== 轮次 ${roundId} 开始 =====`);

  // ① 取数
  const [acctRaw, mkt] = await Promise.all([fetchAccount(), fetchMarket()]);
  const snap = buildSnapshot(acctRaw);
  log(`权益=${snap.equityUsdt} 持仓=${snap.positions.length} 行情ok=${mkt.ok}`);
  if (snap.equityUsdt <= 0) {
    log("无法获取权益，本轮终止");
    await alert("OKX Agent：无法获取账户权益", "fetchAccount 返回权益 ≤0，本轮已终止。请检查 MCP 连接与账户状态。");
    return;
  }

  const algoInsts = new Set(snap.algoOrders.map((a) => a.inst));
  for (const p of snap.positions) {
    if (!algoInsts.has(p.inst)) {
      log(`⚠ 裸仓 ${p.inst} 无止损挂单`);
      await alert(`裸仓告警：${p.inst}`, `持仓 ${p.inst}（${p.side} ${p.sizeContracts} 张）无止损挂单，违反 L1-4。请立即补挂止损。`);
    }
  }

  const marketDigest = buildMarketDigest(mkt.data);
  const knownInsts = knownInstsOf(mkt.data);
  const sharedContext = [
    `轮次 ${roundId}，时间 ${ts()}，环境 demo（模拟盘）`,
    ``,
    `【账户】权益 ${snap.equityUsdt} USDT，可用 ${snap.availableUsdt}`,
    `【持仓】${snap.positions.length ? JSON.stringify(snap.positions) : "无持仓"}`,
    `【挂单】${snap.algoOrders.length ? JSON.stringify(snap.algoOrders) : "无"}`,
    `【运行态】当日止损 ${rt.daySlCount} 次，当日盈亏 ${rt.dayPnlPct}%，月度回撤 ${rt.monthDdPct}%`,
    ``,
    `【候选标的与行情摘要】可交易其中任意 USDT 永续，做多/做空均可；优先流动性好、规格清晰的标的`,
    marketDigest,
  ].join("\n");

  // ② 连接 MCP（给专家供工具），跑图（编排 + LLM 决策）
  const conn = await buildGraphWithMcp();
  for (const e of conn.errors) log(`MCP 警告: ${e}`);
  if (conn.tools.length) log(`MCP 已连接 ${conn.tools.length} 个工具`);
  const graph = conn.graph;
  let final: any;
  try {
    final = await graph.invoke({
      roundId,
      sharedContext,
      dryRun: DRY_RUN,
    } as Partial<typeof AgentState.State>);
  } finally {
    // 无论图是否抛异常，都关闭 MCP 连接，避免 stdio 子进程每轮泄漏累积导致卡死
    await conn.close();
  }

  for (const l of final.logs ?? []) log(l);
  if (final.conflicts?.length) log(`⚠ 专家冲突: ${final.conflicts.join(" | ")}`);

  const decision = final.decision;
  if (!decision) {
    log("未获得有效决策，本轮观望");
    await alert("拍板失败告警", "主 Agent 未产出有效决策（decision 为 null），本轮观望。请检查模型配置与日志。");
    return;
  }

  // ③ 大额人工确认 → 挂起
  if (decision.needsApproval) {
    const file = path.join(STATE, `PENDING_APPROVAL_${roundId}.json`);
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ roundId, reason: decision.approvalReason, decision, opinions: final.opinions }, null, 2),
      "utf8"
    );
    log(`⏸ 需人工确认，已写入 ${file}`);
    return;
  }

  // ④ L1-6 月度回撤熔断（-12%）：整轮观望，不执行任何动作
  if ((rt.monthDdPct ?? 0) <= -12) {
    log(`⛔ L1-6 月度回撤 ${rt.monthDdPct}% 触及 -12% 熔断，本轮全部观望`);
    await alert("月度回撤熔断告警", `月度回撤 ${rt.monthDdPct}% 触及 -12% 熔断线，已暂停交易。请人工评估策略是否继续。`);
    decision.decision = "STANDBY";
    decision.intents = [];
    decision.summary = `月度回撤熔断(${rt.monthDdPct}%)`;
  }

  // ⑤ 执行（副作用在图外）——先过 Guard（L1 硬约束），违规则硬拦截
  const execResults: string[] = [];
  let seq = 0;
  for (const it of decision.intents ?? []) {
    if (it.action === "hold") {
      execResults.push(`持有 ${it.inst}: ${it.reason}`);
      continue;
    }
    const g = guardIntent(it, snap, refPriceOf(mkt.data, it.inst), knownInsts);
    if (!g.ok) {
      const msg = `⛔ 风控拦截 ${it.inst}/${it.action}: ${g.violations.join("；")}`;
      execResults.push(msg);
      log(msg);
      await alert("风控拦截告警", `本轮决策被 Guard 拦截：\n${g.violations.join("\n")}\n说明 LLM 输出了违规意图，请关注模型决策质量。`);
      continue;
    }
    seq++;
    const r = it.action === "close"
      ? await executeClose(it, snap)
      : await executeOpen(it, snap, roundId, seq, refPriceOf(mkt.data, it.inst), specOf(mkt.data, it.inst));
    execResults.push(`${it.inst}/${it.action}: ${r.ok ? "✅" : "❌"} ${r.msg}`);
  }
  for (const r of execResults) log(`执行 ${r}`);

  // ⑤ 归档（只追加）
  try {
    const payload = {
      round_id: roundId,
      time_cst: ts(),
      interval: "5 分钟",
      env: "demo",
      equity_usdt: snap.equityUsdt,
      available_usdt: snap.availableUsdt,
      positions: snap.positions.map((p) => ({
        instrument: p.inst, side: p.side, size_contracts: p.sizeContracts,
        entry: p.entry, mark: p.mark, leverage: p.leverage, upl: p.upl,
      })),
      live_watch: [],
      actions: (decision.intents ?? []).map((i: TradeIntent) => `${i.inst}:${i.action} — ${i.reason}`),
      decision: decision.summary,
      decision_type: decision.decision,
      risk_tier: decision.riskTier,
      market_summary: JSON.stringify(mkt.data).slice(0, 4000),
      deviations: (decision.intents ?? []).flatMap((i: TradeIntent) => i.deviations ?? []),
      experts: (final.opinions ?? []).map((o: { expert: string; stance: string; summary: string }) => ({ expert: o.expert, stance: o.stance, summary: o.summary })),
      conflicts: final.conflicts ?? [],
      exec_results: execResults,
    };
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(path.join(STATE, `round_input_${roundId}.json`), JSON.stringify(payload, null, 2), "utf8");
    await runPy("archive_round.py", ["--in", `state/round_input_${roundId}.json`]);
    log(`归档完成 ${roundId}`);

    // ⑥ 生成 HTML 报告（LLM 出 HTML，落盘 reports/；失败只记日志，绝不阻断交易）
    try {
      await generateRoundReport(payload);
      log(`报告已生成 ${roundId}`);
    } catch (e) {
      log(`报告生成失败: ${String(e).slice(0, 150)}`);
    }
  } catch (e) {
    log(`归档失败（不回滚）: ${String(e).slice(0, 200)}`);
  }

  // ⑥ 复盘式进化：用 LLM 把本轮观点/决策/结果提炼成可证伪的教训，沉淀到相关专家知识库
  try {
    const decisionText = decision ? `${decision.decision}: ${decision.summary.slice(0, 100)}` : "无决策";
    const outcome = execResults.join(" | ").slice(0, 200);
    const n = await reflectExperts({
      llm: makeStoreLlmProvider(undefined, true) as never,
      roundId,
      time: ts(),
      opinions: final.opinions ?? [],
      decision: decisionText,
      outcome: outcome || "无执行动作",
    });
    if (n > 0) log(`专家知识库已进化（提炼 ${n} 条教训）`);
  } catch (e) {
    log(`专家进化失败: ${String(e).slice(0, 150)}`);
  }

  log(`===== 轮次 ${roundId} 结束 =====`);
}

async function main() {
  // 显示实际使用的模型（来自 store，而非环境变量 —— 界面改模型要立刻生效）
  let modelName = "未知";
  try {
    const { resolveModel } = await import("./store.js");
    modelName = resolveModel(undefined, true)?.name ?? "未知";
  } catch {
    modelName = process.env.LLM_PROVIDER ?? "mock";
  }
  log(`OKX Agent(LangGraph) 启动 interval=${INTERVAL_MS}ms dry=${DRY_RUN} once=${ONCE} 模型=${modelName}`);
  // 补生成历史轮次的 HTML 详情（纯数据兜底、不耗 token），让记录表每条都能点开
  try {
    const n = await generateAllReports(false);
    if (n > 0) log(`历史轮次报告已补齐（共 ${n} 轮）`);
  } catch (e) {
    log(`历史报告补齐失败: ${String(e).slice(0, 150)}`);
  }
  // dry-run 是「模式」不是「单轮」：只影响是否真的下单，不影响是否常驻。
  // 只有 --once 才跑一轮就退出（实测踩过：把 dry 也当单轮，导致常驻模式下服务跑完即退）
  if (ONCE) {
    await runRound();
    return;
  }
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
