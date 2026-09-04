/**
 * strategies.ts — 超短线自定义策略管理（多策略 + LLM 生成 + 校验）
 *
 * 策略存储：agent/strategies/<id>/
 *   meta.json    {id,name,desc,category,idea?,builtin?,createdAt,updatedAt,model?}
 *   strategy.py  策略代码（实现 signal(ctx)，接口见 scripts/strategy_loader.py）
 *
 * 内置策略：BUILTIN_STRATEGIES 为唯一事实源，ensureBuiltins() 启动时核对磁盘镜像，
 * 内置目录不可删除、不可被覆盖保存（只能「复制为自定义」另存），保证策略库兜底可用。
 *
 * 引擎接入（同一定义源，可回测也可实盘应用）：
 *   回测  scalper_backtest.py --strategy <id 目录>
 *   实盘  scalper.py          --strategy <id 目录>（src/scalper.ts fetchSignal 自动带上）
 *
 * LLM 生成「内置规则」在 generateSystemPrompt()：资深量化研究员角色定位 + 「以用户思路为唯一
 * 需求、不许偷换成经典套路」的自查要求 + 平台接口/安全红线 + 仅演示 ctx 字段与返回结构的
 * 接口骨架（刻意不放可抄的完整策略示例，避免生成物千篇一律），保证代码能过 strategy_check.py。
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
  /** 策略分类：趋势跟踪 / 均值回归 / 突破通道 / 自定义 */
  category: string;
  /** 策略思路 / 最近改进方向（用于「改进模式」上下文，可在代码回填后自动写入） */
  idea?: string;
  /** 内置策略（平台模板）标记：不可删除、不可覆盖，只能复制为自定义 */
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
  /** 最近一次生效的回测/实盘信号来源标记，仅展示用 */
  model?: string;
}

export interface StrategyWithCode extends StrategyMeta {
  code: string;
}

/** 平台分类（顺序即 UI 展示顺序） */
export const STRATEGY_CATEGORIES = ["趋势跟踪", "均值回归", "突破通道", "自定义"] as const;

function isCategory(v: unknown): v is string {
  return typeof v === "string" && (STRATEGY_CATEGORIES as readonly string[]).includes(v);
}

/** 内置策略模板（唯一事实源，ensureBuiltins 会按此还原磁盘镜像） */
interface BuiltinDef {
  id: string;
  name: string;
  category: string;
  desc: string;
  idea: string;
  code: string;
}

export const BUILTIN_STRATEGIES: BuiltinDef[] = [
  {
    id: "sample-trend",
    name: "斜率顺势",
    category: "趋势跟踪",
    desc: "平台内置趋势策略的等价实现（最近 5 根 1m 收盘斜率判向），官方示例",
    idea: "看最近 5 根 1 分钟收盘价相对斜率：斜率为正且足够强就顺势做多，反之做空；斜率很弱时也顺着微弱方向持仓，止损止盈由引擎统一按 ATR 计算。",
    code: `# 平台内置趋势策略的等价实现（最近 5 根 1m 收盘斜率判向）
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 6:
        return {"direction": "flat", "reason": "样本不足，观望"}
    wins = closes[n - 5:n]                       # 最近 5 根 1m 收盘价
    price = closes[n - 1] or 1e-9
    slope = (wins[-1] - wins[0]) / 4 / price     # 每根平均相对斜率
    if slope >= 0.0002:
        return {"direction": "long", "reason": "5 根斜率上行，强势做多"}
    if slope <= -0.0002:
        return {"direction": "short", "reason": "5 根斜率下行，强势做空"}
    return {"direction": "long" if slope >= 0 else "short", "reason": "弱趋势，顺势方向"}
`,
  },
  {
    id: "builtin-ma-cross",
    name: "双均线趋势跟随",
    category: "趋势跟踪",
    desc: "MA8 上穿 MA21 金叉做多、下穿死叉做空，未交叉观望——经典双均线趋势跟踪",
    idea: "快线 MA8 与慢线 MA21 刻画短期/中期趋势：金叉说明短趋势转强做多，死叉转弱做空；两根均线纠缠（未交叉）时不开仓，减少来回被打。参数可按行情手感调整。",
    code: `# 双均线趋势跟随：MA8 上穿 MA21 金叉做多、下穿死叉做空；未交叉观望
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 22:
        return {"direction": "flat", "reason": "样本不足，观望"}
    fast = sum(closes[n - 8:n]) / 8              # 当前 MA8
    slow = sum(closes[n - 21:n]) / 21            # 当前 MA21
    prev_fast = sum(closes[n - 9:n - 1]) / 8     # 上一根 MA8
    prev_slow = sum(closes[n - 22:n - 1]) / 21   # 上一根 MA21
    if prev_fast <= prev_slow and fast > slow:
        return {"direction": "long", "reason": "MA8 金叉上穿 MA21，趋势转多"}
    if prev_fast >= prev_slow and fast < slow:
        return {"direction": "short", "reason": "MA8 死叉下穿 MA21，趋势转空"}
    return {"direction": "flat", "reason": "双均线未交叉，观望"}
`,
  },
  {
    id: "builtin-macd-trend",
    name: "MACD 趋势跟随",
    category: "趋势跟踪",
    desc: "DIF 上穿 DEA 且站上零轴做多、下穿且跌破零轴做空，其余观望",
    idea: "用 EMA12/EMA26 差离 DIF 与其均线 DEA 判断动能：只在其方向一致且位于零轴同侧时顺势持仓（多头动能区只做多、空头动能区只做空），动能不足/穿越零轴前后一律观望，过滤震荡。",
    code: `# MACD 趋势跟随：只做动能同侧——DIF>DEA 且 DIF>0 做多，DIF<DEA 且 DIF<0 做空
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 35:
        return {"direction": "flat", "reason": "样本不足，观望"}
    base = closes[-60:] if n >= 60 else closes   # 只算最近 60 根，避免长历史逐根重复 EMA
    def ema(span):
        k = 2.0 / (span + 1)
        e = base[0]
        out = [e]
        for c in base[1:]:
            e = e + (c - e) * k
            out.append(e)
        return out
    e12 = ema(12)
    e26 = ema(26)
    dif = [a - b for a, b in zip(e12, e26)]
    dea = [dif[0]]
    for i in range(1, len(dif)):
        dea.append(dea[-1] + (dif[i] - dea[-1]) * 0.2)
    d, s = dif[-1], dea[-1]
    if d > s and d > 0:
        return {"direction": "long", "reason": "DIF 在零轴上方金叉，动能向上"}
    if d < s and d < 0:
        return {"direction": "short", "reason": "DIF 在零轴下方死叉，动能向下"}
    return {"direction": "flat", "reason": "DIF/DEA 动能不足或过零轴，观望"}
`,
  },
  {
    id: "builtin-boll-revert",
    name: "布林带均值回归",
    category: "均值回归",
    desc: "收盘突破布林上轨做空、跌破下轨做多，回到带内观望（博回归）",
    idea: "价格短期易向 20 周期均值回归：突破 ±2σ 轨道属于短期超买/超卖，反向开仓赌回归；价格回到带内说明回归已完成，转为观望避免死扛趋势行情。",
    code: `# 布林带均值回归：MA20 ± 2σ 上下轨外反向开仓，回到带内观望
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 21:
        return {"direction": "flat", "reason": "样本不足，观望"}
    win = closes[n - 20:n]
    price = closes[n - 1]
    m = sum(win) / 20.0
    v = sum((x - m) ** 2 for x in win) / 20.0
    sd = v ** 0.5
    up = m + 2 * sd
    lo = m - 2 * sd
    if price >= up:
        return {"direction": "short", "reason": "突破布林上轨，博弈回归"}
    if price <= lo:
        return {"direction": "long", "reason": "跌破布林下轨，博弈回归"}
    return {"direction": "flat", "reason": "价格在布林带内，观望"}
`,
  },
  {
    id: "builtin-rsi-revert",
    name: "RSI 超买超卖反转",
    category: "均值回归",
    desc: "RSI(14)≤25 超卖做多、≥75 超买做空；中间区一律观望",
    idea: "RSI14 度量最近 14 根的涨跌动量：跌过头（≤25）时博反弹做多，涨过头（≥75）时博回落做空；指标落在 25~75 的正常区说明多空均衡，不开仓。",
    code: `# RSI 超买超卖反转：极端区反向开仓，中间区观望
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 16:
        return {"direction": "flat", "reason": "样本不足，观望"}
    win = closes[n - 15:n]
    g = 0.0
    l = 0.0
    for i in range(1, len(win)):
        d = win[i] - win[i - 1]
        if d >= 0:
            g += d
        else:
            l -= d
    if g + l <= 1e-12:
        return {"direction": "flat", "reason": "近 14 根近乎无波动，观望"}
    rs = g / l if l > 1e-12 else 99.0
    rsi = 100.0 - 100.0 / (1.0 + rs)
    if rsi <= 25:
        return {"direction": "long", "reason": f"RSI={rsi:.0f} 超卖，博反弹"}
    if rsi >= 75:
        return {"direction": "short", "reason": f"RSI={rsi:.0f} 超买，博回落"}
    return {"direction": "flat", "reason": "RSI 处于中间区，观望"}
`,
  },
  {
    id: "builtin-donchian-break",
    name: "唐奇安通道突破",
    category: "突破通道",
    desc: "收盘突破近 20 根最高价做多、跌破最低价做空，通道内观望",
    idea: "唐奇安通道把「创 N 周期新高/新低」当成趋势启动信号：价格真实突破前 20 根高点跟进做多，跌破低点跟进做空；仍在通道内说明没有方向，观望等待。",
    code: `# 唐奇安通道突破：突破近 20 根高低点跟进，通道内观望
def signal(ctx):
    closes = ctx["closes"]
    highs = ctx["highs"]
    lows = ctx["lows"]
    n = ctx["n"]
    if n < 21:
        return {"direction": "flat", "reason": "样本不足，观望"}
    price = closes[n - 1]
    hi = max(highs[n - 21:n - 1])   # 近 20 根最高（不含当前根）
    lo = min(lows[n - 21:n - 1])    # 近 20 根最低
    if price > hi:
        return {"direction": "long", "reason": "收盘突破 20 根高点，跟进做多"}
    if price < lo:
        return {"direction": "short", "reason": "收盘跌破 20 根低点，跟进做空"}
    return {"direction": "flat", "reason": "仍在通道内，等待突破"}
`,
  },
  {
    id: "builtin-vol-break",
    name: "放量突破",
    category: "突破通道",
    desc: "放量 1.5 倍以上突破近 20 根高低点才跟进，避免无量假突破",
    idea: "在唐奇安突破基础上加量能确认：价格突破的同时当前量能要≥近 20 根均量的 1.5 倍，代表是真突破而非无量诱多/诱空；量能不足一律观望，过滤假突破。",
    code: `# 放量突破：突破近 20 根高低点 + 量能 1.5 倍确认，否则观望
def signal(ctx):
    closes = ctx["closes"]
    highs = ctx["highs"]
    lows = ctx["lows"]
    vols = ctx["vols"]
    n = ctx["n"]
    if n < 21:
        return {"direction": "flat", "reason": "样本不足，观望"}
    price = closes[n - 1]
    prev_vols = vols[n - 21:n - 1]
    avg_vol = sum(prev_vols) / len(prev_vols) if prev_vols else 1e-12
    vol = vols[n - 1]
    ratio = vol / avg_vol
    if price > max(highs[n - 21:n - 1]) and ratio >= 1.5:
        return {"direction": "long", "reason": f"放量{ratio:.1f}倍突破 20 根高点，做多"}
    if price < min(lows[n - 21:n - 1]) and ratio >= 1.5:
        return {"direction": "short", "reason": f"放量{ratio:.1f}倍跌破 20 根低点，做空"}
    return {"direction": "flat", "reason": "未现放量突破，观望"}
`,
  },
];

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
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as StrategyMeta;
    return {
      ...raw,
      id: path.basename(dir),
      // 旧数据无分类：内置归趋势跟踪，其余一律自定义（读侧兜底，不改文件）
      category: raw.category || (raw.builtin ? "趋势跟踪" : "自定义"),
    };
  } catch {
    return null;
  }
}

/** 内置模板 meta（与磁盘内置文件保持一致，供 ensureBuiltins 镜像用） */
function builtinMeta(def: BuiltinDef): StrategyMeta {
  return {
    id: def.id,
    name: def.name,
    desc: def.desc,
    category: def.category,
    idea: def.idea,
    builtin: true,
    createdAt: def.id === "sample-trend" ? "2026-09-04T00:00:00.000Z" : "2026-09-05T00:00:00.000Z",
    updatedAt: def.id === "sample-trend" ? "2026-09-04T00:00:00.000Z" : "2026-09-05T00:00:00.000Z",
  };
}

/**
 * 内置策略磁盘镜像：以 BUILTIN_STRATEGIES 为事实源，缺文件/被改动时还原。
 * 启动/每次加载时调用（幂等），保证内置策略库始终兜底可用。
 */
export function ensureBuiltins(): void {
  fs.mkdirSync(STRATEGIES_DIR, { recursive: true });
  for (const def of BUILTIN_STRATEGIES) {
    try {
      const dir = strategyDir(def.id);
      fs.mkdirSync(dir, { recursive: true });
      const py = path.join(dir, "strategy.py");
      if (fs.readFileSync(py, "utf8").trimEnd() !== def.code.trimEnd()) {
        fs.writeFileSync(py, def.code, "utf8");
      }
      const cur = readMeta(dir);
      const want = builtinMeta(def);
      if (!cur || cur.name !== want.name || cur.desc !== want.desc || cur.idea !== want.idea || cur.category !== want.category || !cur.builtin) {
        fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(want, null, 2), "utf8");
      }
    } catch {
      /* 内置策略不应让进程因磁盘异常而崩，失败则跳过 */
    }
  }
}

/** 列出全部策略（内置优先、其余按更新时间倒序），列表带分类 */
export function listStrategies(): { strategies: StrategyMeta[] } {
  ensureBuiltins();
  const out: StrategyMeta[] = [];
  if (!fs.existsSync(STRATEGIES_DIR)) return { strategies: [] };
  for (const name of fs.readdirSync(STRATEGIES_DIR)) {
    const full = path.join(STRATEGIES_DIR, name);
    if (!fs.statSync(full).isDirectory()) continue;
    if (!fs.existsSync(path.join(full, "strategy.py"))) continue;
    const meta = readMeta(full);
    if (meta) out.push(meta);
  }
  const builtinIdx = new Map(BUILTIN_STRATEGIES.map((b, i) => [b.id, i]));
  out.sort((a, b) => {
    const ai = a.builtin ? builtinIdx.get(a.id) ?? 99 : 999;
    const bi = b.builtin ? builtinIdx.get(b.id) ?? 99 : 999;
    if (ai !== bi) return ai - bi;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
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

/** 保存/新增策略（策略 id 由前端传或按名称生成）。返回 {ok, meta}。
 *  内置策略（meta.builtin）不可覆盖：传内置 id 时强制按名称另存为自定义新策略。 */
export function saveStrategy(p: {
  id?: string;
  name: string;
  desc?: string;
  idea?: string;
  category?: string;
  code: string;
}): { ok: boolean; meta: StrategyMeta } {
  const name = String(p?.name ?? "").trim();
  const code = String(p?.code ?? "");
  if (!name) throw new Error("策略名不能为空");
  if (!code.trim()) throw new Error("策略代码不能为空");
  fs.mkdirSync(STRATEGIES_DIR, { recursive: true });
  const base = p?.id && /^[a-zA-Z0-9\u4e00-\u9fa5-]+$/.test(p.id) ? p.id : safeId(name);
  const baseMeta = fs.existsSync(strategyDir(base)) ? readMeta(strategyDir(base)) : null;
  // 内置不可覆盖：另存为自定义（新 id 保证不与内置冲突）
  const isBuiltin = !!baseMeta?.builtin;
  const id = baseMeta && !isBuiltin ? base : ensureIdExists(base);
  const dir = strategyDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const prev = baseMeta && !isBuiltin ? baseMeta : readMeta(dir);
  const meta: StrategyMeta = {
    id,
    name,
    desc: String(p?.desc ?? "").trim(),
    idea: String(p?.idea ?? "").trim(),
    category: isCategory(p?.category) ? p.category : prev?.category || "自定义",
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
  const meta = readMeta(dir);
  if (meta?.builtin) throw new Error("内置策略不可删除：可「复制为自定义」后修改");
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

/** 接口骨架：只演示 ctx 字段怎么读 / 返回值怎么写，刻意不含任何方向判断——
 *  不放"完整可抄的策略示例"，防止 LLM 照抄示例逻辑导致生成物千篇一律。 */
const INTERFACE_SKELETON = `# ⚠️ 以下是"接口骨架"而非策略示例：只为演示 ctx 怎么读、结果怎么写。
# 它没有任何可抄的算法——你写的 signal() 必须严格按【用户思路】设计条件，
# 禁止沿用骨架/任何经典策略的判断逻辑、注释与中文提示语（如"顺势""样本不足"这类泛化理由请按思路重写）。
def signal(ctx):
    closes = ctx["closes"]      # 已收盘序列，旧→新
    highs = ctx["highs"]
    lows = ctx["lows"]
    vols = ctx["vols"]
    n = ctx["n"]                # 已收盘根数，n == len(closes)
    atr = ctx["atr"]            # 1m ATR14
    price = ctx["price"]        # 最新收盘价

    # 只在有足够历史后再计算指标，样本不足一律 flat：
    if n < 20:
        return {"direction": "flat", "reason": "样本不足，观望"}

    # ……把用户的策略思路拆成条件写在这里：决定 long / short / flat……
    #
    # 想收紧/放大风险：return {"direction": "long", "reason": "...", "atr_mult": 2.0, "rr": 2.0}
    # 想精确给进出点位：return {"direction": "short", "reason": "...", "sl": price * 1.01, "tp": price * 0.99}`;

function generateSystemPrompt(needImprove: boolean): string {
  const job = needImprove
    ? `## 本次任务：按改进方向优化现有策略（改进模式）
- 以【用户思路】+【现有策略代码】为基线，先理解原代码每个判断在抓什么行情，再围绕改进方向做针对性增强；
  保留原有识别出的核心行情特征与有效滤网。
- 只在改进方向明确要求时才改变持仓逻辑；若方向模糊，宁可做稳健性微调（补滤网/改阈值/加防抖），
  也不要推翻重写成另一套陌生风格。
- 只输出最终完整 strategy.py 的代码，不要解释。`
    : `## 本次任务：把用户思路实现成策略（新建模式）
- 用户的策略思路是你唯一的需求来源，必须逐条完整落地：
  思路里提到的每一个开多/开空/观望条件，都要能在代码里找到对应实现。
- 严禁偷换成通用经典套路（均线金叉、布林、RSI、MACD、通道突破、趋势斜率等），除非用户思路里明确提到。
- 只输出完整 strategy.py 代码，不要解释。`;
  return `你是资深加密货币量化研究员，擅长把交易员的实战想法翻译成严谨、可回测、可实盘的
1 分钟超短线（USDT 永续）策略。你从不套模板：先精确复刻用户的判断逻辑，再用规范、
防御性的 Python 实现落地；输出前会自查是否忠实还原了用户的每个条件。

${job}

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
5. 策略必须对 n 很小的早期数据安全（例如样本不足时返回 flat），并处理除零
   （除以可能为 0 的均值/价差前先判 0，或加 1e-12）。

## 写码前自查（心里过一遍再输出）
- 用户思路总共提到几个条件？代码里是否每个都在？丢掉任何一个条件 = 不合格；
- reason 里写出真实触发依据（如 "RSI=23 超卖"、动量比 1.8），拒绝空泛套话；
- 阈值优先用相对量（ATR 倍数、近 N 根均值/波动率比、价格比例），别拍脑袋写绝对价；
- 检查是否在不经意间用到了"下一根/未来"的数据。

## 止盈止损（默认引擎统一算，也可由策略直接给点位）
引擎默认用 ATR×atr_mult 定止损、止损距离×rr 定止盈，策略核心任务是判方向。
需要精确控制点位时：在返回里同时给 "sl"/"tp"（以 ctx.price 为参照的绝对价，例如
{"direction": "long", "sl": price*0.99, "tp": price*1.03, "reason": "..."}），
引擎会直接采用并在回测/实盘一致生效。注意方向约束：多单须 sl < price < tp，空单反之；
若不满足会被回退成默认 ATR 距离，所以给点位时务必同时考虑 price 当前值。

## 设计建议
- 组合 2~3 个互不冗余的条件（主信号 + 滤网 + 确认），宁可 flat 也不硬开；
- 别写超过 80 行；长周期指标在窗口不足时会失真，周期别超过 30，且窗口不足时先 flat。

${INTERFACE_SKELETON}`;
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
【用户想要改进的方向】${idea}
${p?.lastSummary ? `【最近一次回测摘要，请针对其中的薄弱点优化】\n${p.lastSummary}` : ""}
【现有策略代码】
\`\`\`python
${p.existingCode}
\`\`\`
请围绕改进方向重写 signal(ctx)：先弄清原代码每个条件想抓什么，再做针对性增强；
除非改进方向明确要求，否则不要引入与用户思路无关的新条件、不要改写成另一套经典策略风格。
只输出代码块。`;
  } else {
    user = `【策略名】${p.name}
【用户想要的策略思路】
${idea}

要求：
1. 上面的思路是你唯一的需求来源，请逐条落地为代码条件——不许自行换成均线金叉/布林/RSI/MACD/通道突破/斜率顺势等思路里没提到的经典套路；
2. 思路没给参数的环节，选一套与你逻辑自洽的参数并在注释里说明选择理由；
3. 写完自查：思路里的每个条件是否都有对应实现，方向依据是否都写进了 reason。
只输出代码块。`;
  }

  const llm = createProvider(cfg);
  const raw = await llm.complete(sys, user);
  const code = extractPyCode(raw);
  if (!code) return { ok: false, code: "", raw, error: "模型未返回代码，请重试" };
  return { ok: true, code, raw, modelId: cfg.id };
}

// ── LLM 按代码回填元信息（名称 / 描述 / 思路，可分别选择） ──────

/** 从 LLM 原始输出里提取 JSON 对象体（优先 ```json 围栏，其次首尾花括号） */
function extractJsonish(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence && fence[1]?.trim()) return fence[1].trim();
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) return raw.slice(s, e + 1);
  return raw.trim();
}

function backfillSystemPrompt(want: { name: boolean; desc: boolean; idea: boolean }): string {
  const rules = [
    want.name ? `"name": 不超过 14 字的简洁中文策略名，点出核心逻辑（不要用「策略/系统」这类泛词结尾）` : null,
    want.desc ? `"desc": ≤40 字的一句话说明（策略风格 / 适用行情 / 主要滤网）` : null,
    want.idea
      ? `"idea": 2~4 句白话策略思路：拆解代码里开多/开空/flat 的判定条件与滤网，解释关键参数含义及它想捕捉的行情特征（禁止贴代码片段）`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `你是加密货币超短线（1 分钟 K 线，USDT 永续）策略分析师。用户会发来一段完整的策略代码（signal(ctx) 实现）。
你的任务：只凭代码逻辑反推它的元信息，供用户人工复核。只输出一个 JSON 对象，不要 Markdown、不要解释。

JSON 字段要求：
${rules}

严格依据代码推断；代码里没有实现的逻辑不要脑补。`;
}

/**
 * LLM 根据已有策略代码回填元信息。wantName / wantDesc / wantIdea 分别控制是否生成，
 * 前端「可分别勾选」。返回 {ok, name?, desc?, idea?, modelId?, error?}
 */
export async function backfillMetaFromCode(p: {
  code: string;
  wantName?: boolean;
  wantDesc?: boolean;
  wantIdea?: boolean;
  nameHint?: string;
}): Promise<{ ok: boolean; name?: string; desc?: string; idea?: string; modelId?: string; error?: string }> {
  const cfg = resolveModel();
  if (!cfg || cfg.provider === "mock") {
    return { ok: false, error: "未配置真实 LLM 模型。请先到「设置-模型」添加并设为默认模型。" };
  }
  const code = String(p?.code ?? "").trim();
  if (!code) return { ok: false, error: "没有可分析的代码：请先贴入或生成 strategy.py" };
  const want = {
    name: !!p?.wantName,
    desc: !!p?.wantDesc,
    idea: !!p?.wantIdea,
  };
  if (!want.name && !want.desc && !want.idea) {
    return { ok: false, error: "请至少勾选一个要回填的字段（名称 / 描述 / 思路）" };
  }
  const nameHint = String(p?.nameHint ?? "").trim();

  const sys = backfillSystemPrompt(want);
  const wantKeys = [want.name && "name", want.desc && "desc", want.idea && "idea"].filter(Boolean).join("、");
  const user = `${nameHint ? `【现有名称（可参考但不必沿用，应更贴近代码）】${nameHint}\n\n` : ""}【策略代码】
\`\`\`python
${code}
\`\`\`
请只输出 JSON，包含这些字段：${wantKeys}。`;
  const llm = createProvider(cfg);
  const raw = await llm.complete(sys, user);
  let data: any = null;
  try {
    data = JSON.parse(extractJsonish(raw));
  } catch {
    try {
      data = JSON.parse(extractJsonish(raw).replace(/```/g, "").trim());
    } catch {
      return { ok: false, error: `模型返回无法解析，请重试。原文：${raw.slice(0, 140)}…` };
    }
  }
  const clean = (s: unknown) => (typeof s === "string" ? s.trim() : "");
  const out: { ok: boolean; modelId?: string; name?: string; desc?: string; idea?: string } = { ok: true, modelId: cfg.id };
  if (want.name && clean(data.name)) out.name = clean(data.name).slice(0, 30);
  if (want.desc && clean(data.desc)) out.desc = clean(data.desc).slice(0, 80);
  if (want.idea && clean(data.idea)) out.idea = clean(data.idea);
  if (out.name === undefined && out.desc === undefined && out.idea === undefined) {
    return { ok: false, error: `模型没有返回有效字段，请重试。原文：${raw.slice(0, 140)}…` };
  }
  return out;
}
