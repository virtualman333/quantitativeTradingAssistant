/**
 * strategies.ts — 超短线自定义策略管理（多策略 + LLM 生成 + 校验）
 *
 * 策略存储：agent/strategies/<id>/
 *   meta.json    {id,name,desc,createdAt,updatedAt,model?}
 *   strategy.py  策略代码（实现 signal(ctx)，接口见 scripts/strategy_loader.py）
 *
 * 引擎接入（同一定义源，可回测也可实盘应用）：
 *   回测  scalper_backtest.py --strategy <id 目录>
 *   实盘  scalper.py          --strategy <id 目录>（src/scalper.ts fetchSignal 自动带上）
 *
 * LLM 生成「内置规则」在 generateSystemPrompt()：约定接口 + 可用数据 + 安全红线 +
 * 与内置策略完全一致的参考模板，保证生成的代码能过 strategy_check.py 并直接被引擎加载。
 */
import fs from "node:fs";
import path from "node:path";
import { AGENT_ROOT, resolveModel, updateScalperConfig, getScalperConfig } from "./store.js";
import { createProvider } from "./llm.js";
import { runPy } from "./okx.js";

export const STRATEGIES_DIR = path.join(AGENT_ROOT, "strategies");

export interface StrategyMeta {
  id: string;
  name: string;
  desc: string;
  createdAt: string;
  updatedAt: string;
  /** 最近一次生效的回测/实盘信号来源标记，仅展示用 */
  model?: string;
}

export interface StrategyWithCode extends StrategyMeta {
  code: string;
}

function safeId(name: string): string {
  const n = (name || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return n || `s${Date.now().toString(36)}`;
}

export function strategyDir(id: string): string {
  return path.join(STRATEGIES_DIR, id);
}

function ensureIdExists(id: string): string {
  // 重复 id：追加序号，避免覆盖
  let out = id;
  let k = 1;
  while (fs.existsSync(path.join(STRATEGIES_DIR, out))) {
    k++;
    out = `${id}-${k}`;
  }
  return out;
}

function readMeta(dir: string): StrategyMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as StrategyMeta;
    return { ...m, id: path.basename(dir) };
  } catch {
    return null;
  }
}

/** 列出全部自定义策略（不含内置），按更新时间倒序 */
export function listStrategies(): { strategies: StrategyMeta[] } {
  const out: StrategyMeta[] = [];
  if (!fs.existsSync(STRATEGIES_DIR)) return { strategies: [] };
  for (const name of fs.readdirSync(STRATEGIES_DIR)) {
    const full = path.join(STRATEGIES_DIR, name);
    if (!fs.statSync(full).isDirectory()) continue;
    if (!fs.existsSync(path.join(full, "strategy.py"))) continue;
    const meta = readMeta(full);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return { strategies: out };
}

export function readStrategy(id: string): StrategyWithCode {
  const dir = strategyDir(id);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`策略不存在: ${id}`);
  let code = "";
  try {
    code = fs.readFileSync(path.join(dir, "strategy.py"), "utf8");
  } catch {
    /* ignore */
  }
  return { ...meta, code };
}

/** 保存/新增策略（策略 id 由前端传或按名称生成）。返回 {ok, meta} */
export function saveStrategy(p: {
  id?: string;
  name: string;
  desc?: string;
  code: string;
}): { ok: boolean; meta: StrategyMeta } {
  const name = String(p?.name ?? "").trim();
  const code = String(p?.code ?? "");
  if (!name) throw new Error("策略名不能为空");
  if (!code.trim()) throw new Error("策略代码不能为空");
  const base = p?.id && /^[a-zA-Z0-9\u4e00-\u9fa5-]+$/.test(p.id) ? p.id : safeId(name);
  fs.mkdirSync(STRATEGIES_DIR, { recursive: true });
  const id = fs.existsSync(path.join(STRATEGIES_DIR, base)) ? base : ensureIdExists(base);
  const dir = strategyDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const prev = readMeta(dir);
  const meta: StrategyMeta = {
    id,
    name,
    desc: String(p?.desc ?? "").trim(),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    model: prev?.model,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "strategy.py"), code, "utf8");
  return { ok: true, meta };
}

export function deleteStrategy(id: string): { ok: boolean; msg: string } {
  if (!/^[a-zA-Z0-9\u4e00-\u9fa5-]+$/.test(id)) throw new Error("非法策略 id");
  const dir = strategyDir(id);
  if (!fs.existsSync(dir)) throw new Error(`策略不存在: ${id}`);
  fs.rmSync(dir, { recursive: true, force: true });
  // 若被删除的是当前应用策略 → 重置回内置
  try {
    if (getScalperConfig().strategyId === id) {
      updateScalperConfig({ strategyId: "" });
    }
  } catch {
    /* ignore */
  }
  return { ok: true, msg: `已删除 ${id}` };
}

/** 把策略应用到超短线循环：store.scalper.strategyId = id（空=内置趋势策略） */
export function applyStrategy(id: string): { ok: boolean; strategyId: string } {
  if (id) {
    const dir = strategyDir(id);
    if (!fs.existsSync(path.join(dir, "strategy.py"))) throw new Error(`策略不存在: ${id}`);
  }
  updateScalperConfig({ strategyId: id || "" });
  return { ok: true, strategyId: id || "" };
}

/** 语法 + 红线 + 冒烟校验（保存后的 gate），返回 strategy_check.py 的 JSON */
export async function validateStrategy(id: string): Promise<{
  ok: boolean;
  errors: string[];
  warnings: string[];
  functions: string[];
  sample?: Record<string, unknown> | null;
  error?: string;
}> {
  const dir = strategyDir(id);
  if (!fs.existsSync(path.join(dir, "strategy.py"))) throw new Error(`策略不存在: ${id}`);
  try {
    const out = await runPy("strategy_check.py", ["--dir", dir], 60_000);
    return JSON.parse(out);
  } catch (e: any) {
    // 校验失败（退出码 1）也会在 stdout 输出 JSON；execFile reject 时错误对象带 stdout
    const body = String(e?.stdout || e?.message || e);
    try {
      return JSON.parse(body.trim().split("\n").pop() ?? "{}");
    } catch {
      return { ok: false, errors: [`校验进程失败: ${body.slice(0, 300)}`], warnings: [], functions: [] };
    }
  }
}

// ── LLM 生成策略 ─────────────────────────────────────────────

/** 策略参考模板：与内置策略（默认）行为完全一致，LLM 可在此之上改 */
const REFERENCE_TEMPLATE = `# 参考模板（平台内置趋势策略的等价实现，可在此基础上改）
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 6:
        return {"direction": "flat", "reason": "样本不足，观望"}
    wins = closes[n - 5:n]                 # 最近 5 根 1m 收盘价
    price = closes[n - 1] or 1e-9
    slope = (wins[-1] - wins[0]) / 4 / price   # 平均每根相对斜率
    if slope >= 0.0002:
        return {"direction": "long", "reason": f"5根斜率{slope * 1e4:.1e}/根，强势上行"}
    if slope <= -0.0002:
        return {"direction": "short", "reason": f"5根斜率{slope * 1e4:.1e}/根，强势下行"}
    return {"direction": "long" if slope >= 0 else "short", "reason": "弱趋势，顺势方向"}`
;

function generateSystemPrompt(needImprove: boolean): string {
  const improve = needImprove
    ? `当前已有策略代码。结合用户给的改进方向与最近一次回测摘要，重写 signal() 使逻辑更稳健。
   只输出最终完整 strategy.py 的代码，不要解释。`
    : `按用户的策略思路编写 signal()，只输出完整 strategy.py 代码，不要解释。`;
  return `你是加密货币超短线（1 分钟 K 线，USDT 永续）策略工程师。请用 Python 编写一个策略文件。

## 平台约定（必须严格遵守，违反会被直接拒绝）
1. 文件只能定义辅助函数与一个 \`signal(ctx)\`，不允许顶层执行代码（除常量定义）。
2. signal(ctx) 的 ctx 字段（全部为已收盘历史，禁止假设未来数据）：
   ts(list[int]) closes(list[float]) highs(list[float]) lows(list[float]) vols(list[float])，
   n(int，已收盘根数 = len(closes))，atr(float，1m ATR14)，price(float，最新收盘)。
   只看最近 k 根就取 closes[n-k:n]，不要把整个数组都用上。
3. 返回值必须是 dict：
   {"direction": "long"|"short"|"flat", "reason": "≤40字中文依据",
    "atr_mult": 可选 覆盖默认止损系数 2.5, "rr": 可选 覆盖默认止盈/止损盈亏比(1.2~5.0),
    "sl": 可选 自定义止损价, "tp": 可选 自定义止盈价}
   flat = 观望不开仓；direction 只允许这三个值。
   想完全自控进出点位：同时返回 "sl" 与 "tp"（以 ctx.price 为参照的绝对价格），引擎直接采用。
4. 禁止：import os/sys/json/subprocess/socket/requests/urllib/pathlib/open()/eval/exec；
   只能 import math/statistics/collections/itertools/functools/operator/random/bisect 等纯计算库。
5. 策略必须对 n 很小的早期数据安全（例如 n<5 返回 flat），并处理除零。

## 止盈止损（默认引擎统一算，也可由策略直接给点位）
引擎默认用 ATR×atr_mult 定止损、止损距离×rr 定止盈，策略核心任务是判方向。
需要精确控制点位时：在返回里同时给 "sl"/"tp"（以 ctx.price 为参照的绝对价，例如
{"direction": "long", "sl": price*0.99, "tp": price*1.03, "reason": "..."}），
引擎会直接采用并在回测/实盘一致生效。注意方向约束：多单须 sl < price < tp，空单反之；
若不满足会被回退成默认 ATR 距离，所以给点位时务必同时考虑 price 当前值。

## 设计建议
- 组合 2~3 个互不冗余的条件（趋势 + 波动率滤网 + 动量确认），宁可 flat 也不硬开；
- 阈值用相对值（与价格/ATR 比），不要写死绝对价格；
- 不要太复杂：避免超过 80 行，避免对 120 根以内的窗口做长周期指标（周期 > 30 会失真）。

${improve}

${REFERENCE_TEMPLATE}`;
}

/** 从 LLM 完整输出里提取 ```python 代码块（失败则原样返回） */
function extractPyCode(raw: string): string {
  const fence = raw.match(/```(?:python|py)?\s*\n?([\s\S]*?)```/);
  if (fence && fence[1]?.trim()) return fence[1].trim();
  // 无围栏：去首尾空行整体当代码
  return raw.trim();
}

/**
 * LLM 生成策略。idea 为用户思路；existingCode 存在时 = 改进模式
 * （同时把最近回测摘要 summary 作为优化上下文）。
 * 返回 {ok, code, raw, modelId, error?}
 */
export async function generateStrategy(p: {
  name: string;
  idea: string;
  existingCode?: string;
  lastSummary?: string;
}): Promise<{ ok: boolean; code: string; raw?: string; modelId?: string; error?: string }> {
  const cfg = resolveModel();
  if (!cfg || cfg.provider === "mock") {
    return { ok: false, code: "", error: "未配置真实 LLM 模型。请先到「设置-模型」添加并设为默认模型。" };
  }
  const idea = String(p?.idea ?? "").trim();
  if (!idea) return { ok: false, code: "", error: "请先描述策略思路（一两句话即可）" };

  const improve = !!(p?.existingCode?.trim());
  const sys = generateSystemPrompt(improve);
  let user = "";
  if (improve) {
    user = `【策略名】${p.name}
【本轮改进方向/思路】${idea}
${p?.lastSummary ? `【最近一次回测摘要，请针对性优化】\n${p.lastSummary}` : ""}
【现有策略代码】
\`\`\`python
${p.existingCode}
\`\`\`
请按改进方向重写。只输出代码块。`;
  } else {
    user = `【策略名】${p.name}
【用户想要的策略思路】${idea}
请把思路落地成 signal(ctx)。只输出代码块。`;
  }

  const llm = createProvider(cfg);
  const raw = await llm.complete(sys, user);
  const code = extractPyCode(raw);
  if (!code) return { ok: false, code: "", raw, error: "模型未返回代码，请重试" };
  return { ok: true, code, raw, modelId: cfg.id };
}
