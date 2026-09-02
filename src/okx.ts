/**
 * okx.ts —— 取数与执行层
 *
 * 设计取舍：不重新实现 OKX 签名与 REST 调用，而是复用项目里
 * 已经实机验证过的 python 脚本（mcp_call.py / order_id.py / market_scan.py）。
 * 理由：这些脚本踩过的坑（Windows .cmd 垫片、返回结构 result.data.data、
 *       OCO 必填 ordType、clOrdId 禁下划线）都已固化，重写等于重踩一遍。
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根目录（agent/ 的上一级） */
export const ROOT = path.resolve(__dirname, "..", "..");

/**
 * 注意：不能用 process.execPath —— 在 tsx 下它是 node.exe，拿去跑 .py 会
 * 报 "SyntaxError: Invalid or unexpected token"（实测踩过）。
 * 必须用真正的 python 解释器；Windows 上依次尝试 python / py / python3。
 */
let _pyCmd: string | null = null;
function pyCommand(): string {
  if (_pyCmd) return _pyCmd;
  for (const c of ["python", "py", "python3"]) {
    try {
      execFileSync(c, ["-c", "import sys;sys.stdout.write('ok')"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      });
      _pyCmd = c;
      return c;
    } catch {
      /* 试下一个 */
    }
  }
  _pyCmd = "python";
  return _pyCmd;
}

export function runPy(script: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return execFileAsync(pyCommand(), [path.join("scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  }).then((r) => r.stdout);
}

/** 经 mcp_call.py 调用 OKX 工具。写操作必须显式 allowWrite（且仅 demo）。 */
export async function mcpCall<T = unknown>(
  profile: "demo" | "live",
  tool: string,
  args: Record<string, unknown> = {},
  allowWrite = false,
  timeoutMs = 60_000
): Promise<{ ok: boolean; data: T | null; raw: string }> {
  // L1-3: live 写操作一律拒绝（与 mcp_call.py 的双保险）
  if (allowWrite && profile !== "demo") {
    return { ok: false, data: null, raw: "REFUSED: live 账户只读（L1-3）" };
  }
  const cli = ["--profile", profile, "--tool", tool, "--args", JSON.stringify(args)];
  if (allowWrite) cli.push("--allow-write");
  try {
    const out = await runPy("mcp_call.py", cli, timeoutMs);
    const j = JSON.parse(out) as { ok?: boolean; result?: unknown };
    return { ok: !!j.ok, data: (j.result ?? null) as T | null, raw: out };
  } catch (e) {
    return { ok: false, data: null, raw: String(e) };
  }
}

/** 剥 mcp_call 的洋葱结构 → data 数组 */
export function unwrap(result: unknown): Record<string, unknown>[] {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return [];
  const data = r.data;
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const inner = (data as Record<string, unknown>).data;
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
  }
  return [];
}

/** 生成合规 clOrdId（L1-8，必须用 order_id.py，禁止手写） */
export async function genClOrdId(
  roundId: string,
  seq: number,
  params: Record<string, unknown> = {}
): Promise<string | null> {
  try {
    const out = await runPy("order_id.py", [
      "--round",
      roundId,
      "--seq",
      String(seq),
      "--params",
      JSON.stringify(params),
    ]);
    // order_id.py 输出 JSON（含 clOrdId）或裸字符串
    try {
      const j = JSON.parse(out) as { clOrdId?: string };
      if (j.clOrdId) return j.clOrdId;
    } catch {
      /* 非 JSON，按裸字符串处理 */
    }
    const s = out.trim().split(/\r?\n/).pop()?.trim();
    return /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(s ?? "") ? (s as string) : null;
  } catch {
    return null;
  }
}

/** 运行 market_scan.py，返回解析后的行情 JSON */
export async function fetchMarket(): Promise<{ ok: boolean; data: unknown }> {
  try {
    // market_scan.py 默认直接把 JSON 打到 stdout（实测 --save 参数不符，会失败）
    const out = await runPy("market_scan.py", [], 180_000);
    try {
      return { ok: true, data: JSON.parse(out) };
    } catch {
      return { ok: false, data: `market_scan 输出非 JSON: ${out.slice(0, 200)}` };
    }
  } catch (e) {
    return { ok: false, data: String(e) };
  }
}

export interface RawAccount {
  equityUsdt: number | null;
  availableUsdt: number | null;
  positions: Record<string, unknown>[];
  algoOrders: Record<string, unknown>[];
}

/** 读取账户（默认 demo；传 "live" 为只读监控，符合 L1-3）。权益取 USDT details[].eq */
export async function fetchAccount(profile: "demo" | "live" = "demo"): Promise<RawAccount> {
  const out: RawAccount = { equityUsdt: null, availableUsdt: null, positions: [], algoOrders: [] };

  // mcpCall 返回的 data 其实是 j.result，结构：{tool,ok,data:{endpoint,requestTime,data:[...]}}
  // 所以真正数组在 result.data.data —— 三层，别再数错（实测踩过）
  const rowsOf = (r: { data: unknown }): Record<string, unknown>[] => {
    let cur = r.data as Record<string, unknown> | unknown[] | null;
    for (let i = 0; i < 3; i++) {
      if (Array.isArray(cur)) return cur as Record<string, unknown>[];
      if (!cur || typeof cur !== "object") return [];
      cur = (cur as Record<string, unknown>).data as Record<string, unknown> | unknown[] | null;
    }
    return [];
  };

  const bal = await mcpCall(profile, "account_get_balance", { ccy: "USDT" });
  for (const row of rowsOf(bal)) {
    const details = row.details;
    if (!Array.isArray(details)) continue;
    for (const d of details as Record<string, unknown>[]) {
      if (d.ccy !== "USDT") continue;
      const eq = d.eq ?? d.availEq;
      const av = d.availEq ?? d.availBal;
      if (eq != null && eq !== "") out.equityUsdt = Number(eq);
      if (av != null && av !== "") out.availableUsdt = Number(av);
    }
  }

  const pos = await mcpCall(profile, "swap_get_positions", {});
  out.positions = rowsOf(pos);

  const algo = await mcpCall(profile, "swap_get_algo_orders", { status: "pending" });
  out.algoOrders = rowsOf(algo);

  return out;
}

/** 下单（仅 demo）。返回 OKX 原始响应。 */
export async function placeOrder(args: {
  inst: string;
  side: "buy" | "sell";
  size: number;
  clOrdId: string;
}): Promise<{ ok: boolean; raw: string }> {
  const r = await mcpCall(
    "demo",
    "swap_place_order",
    {
      instId: args.inst,
      tdMode: "cross",
      side: args.side,
      posSide: "net",
      ordType: "market",
      sz: String(args.size),
      clOrdId: args.clOrdId,
    },
    true
  );
  return { ok: r.ok, raw: r.raw };
}

/**
 * 挂 OCO 止损/止盈（L1-4）。
 * ⚠ 实测要点：必须 ordType=oco（不是 algoOrdType）；触发价用 mark 防插针。
 */
export async function placeOco(args: {
  inst: string;
  side: "buy" | "sell";
  size: number;
  slPx: number;
  tpPx: number;
  clOrdId: string;
}): Promise<{ ok: boolean; raw: string }> {
  const r = await mcpCall(
    "demo",
    "swap_place_algo_order",
    {
      instId: args.inst,
      ordType: "oco",
      tdMode: "cross",
      side: args.side,
      posSide: "net",
      sz: String(args.size),
      slTriggerPx: args.slPx.toFixed(2),
      slOrdPx: "-1",
      slTriggerPxType: "mark",
      tpTriggerPx: args.tpPx.toFixed(2),
      tpOrdPx: "-1",
      tpTriggerPxType: "mark",
      clOrdId: args.clOrdId,
    },
    true
  );
  return { ok: r.ok, raw: r.raw };
}

/** 设杠杆（L1-2 ≤5x 由 guard 先校验） */
export async function setLeverage(inst: string, lever: number): Promise<boolean> {
  const r = await mcpCall(
    "demo",
    "swap_set_leverage",
    { instId: inst, lever: String(lever), mgnMode: "cross" },
    true
  );
  return r.ok;
}

/** 回查 pending algo，确认某标的止损已挂（L1-4 同轮回查） */
export async function confirmAlgo(
  inst: string,
  timeoutMs = 20_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await mcpCall("demo", "swap_get_algo_orders", { status: "pending" });
    const d = r.data as Record<string, unknown> | null;
    const arr = Array.isArray(d?.data) ? (d!.data as Record<string, unknown>[]) : [];
    for (const a of arr) {
      if (a.instId === inst) return true;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

/** 市价平仓（reduceOnly） */
export async function closePosition(args: {
  inst: string;
  side: "buy" | "sell";
  size: number;
}): Promise<{ ok: boolean; raw: string }> {
  const r = await mcpCall(
    "demo",
    "swap_close_position",
    {
      instId: args.inst,
      mgnMode: "cross",
      posSide: "net",
      // 平仓方向：平空=buy，平多=sell
      side: args.side,
      sz: String(args.size),
    },
    true
  );
  return { ok: r.ok, raw: r.raw };
}
