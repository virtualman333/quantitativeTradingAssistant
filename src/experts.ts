/**
 * experts.ts —— 专家 Agent 注册表（支持 Skill + MCP）
 *
 * 架构（用户 2026-09-02 指定）：
 *   主循环(5min) → 主 Agent → 按情况召唤专家 → 汇总 → 拍板
 *
 *   ┌─────────────┐
 *   │  主 Agent    │  编排：决定召唤谁、汇总冲突、最终拍板
 *   └──────┬──────┘
 *          ├─► trading   交易系统专家   （持仓/开平仓/仓位/止损）
 *          ├─► news      新闻资讯专家   （消息面/事件闸门/交叉验证）
 *          ├─► factor    因子评分专家   （多周期共振/技术因子打分）
 *          └─► risk      风控专家       （回撤/熔断/敞口）
 *
 * 两层能力供给：
 *   · Skill（skills.ts）—— 本项目沉淀的确定性能力，踩坑经验已固化
 *   · MCP（mcp.ts）    —— 外部 server 工具（okx-trade-mcp 等），动态发现
 *
 * 执行模型（ReAct 简化版）：
 *   专家可先调工具 → 拿到结果 → 再输出结论。最多 MAX_TOOL_CALLS 次，防失控。
 */
import fs from "node:fs";
import path from "node:path";
import type { LlmProvider } from "./llm.js";
import { SKILLS, getSkill, skillCatalog } from "./skills.js";
import type { McpTool } from "./mcp.js";
import { AGENT_ROOT, listRoles, isSkillEnabled, type RoleConfig } from "./store.js";
import { trace, traceReasoning, traceRound } from "./trace.js";

export interface ExpertOpinion {
  expert: string;
  stance: "bullish" | "bearish" | "neutral" | "abstain";
  confidence: number;
  summary: string;
  advice: Record<string, unknown>;
  flags?: string[];
  /** 本专家实际调用过的工具（审计用） */
  toolCalls?: string[];
  rawText?: string;
}

export interface ExpertContext {
  sharedContext: string;
  focus?: string;
  /** 该专家可用的 MCP 工具（由主流程按 mcpTools 字段过滤后注入） */
  mcpTools?: McpTool[];
}

export interface Expert {
  id: string;
  name: string;
  duty: string;
  systemPrompt: string;
  /** 可使用的 Skill id */
  skills: string[];
  /** 可使用的 MCP server id（空 = 不用 MCP） */
  mcpServers: string[];
  /** 每轮必召（如消息面事件闸门），不交给调度模块裁量 */
  alwaysInvoke?: boolean;
  run(llm: LlmProvider, ctx: ExpertContext): Promise<ExpertOpinion>;
}

/** 专家声明式定义（来自 experts/*.json，不含 run 逻辑，run 统一由 invoke 提供） */
export interface ExpertDef {
  id: string;
  name: string;
  duty: string;
  systemPrompt: string;
  skills: string[];
  mcpServers: string[];
  enabled: boolean;
  alwaysInvoke?: boolean;
}

const MAX_TOOL_CALLS = 4;

function extractJson(text: string): Record<string, unknown> {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = m ? m[1] : text;
  const s = body.indexOf("{");
  const e = body.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("未找到 JSON");
  return JSON.parse(body.slice(s, e + 1)) as Record<string, unknown>;
}

/** 从 LLM 输出里解析工具调用请求：{"tool":"news_verify","args":{...}} */
function parseToolCall(text: string): { tool: string; args: Record<string, unknown> } | null {
  try {
    const j = extractJson(text);
    if (j.tool && typeof j.tool === "string") {
      return { tool: j.tool, args: (j.args as Record<string, unknown>) ?? {} };
    }
  } catch {
    /* 非工具调用，正常 */
  }
  return null;
}

const OUTPUT_CONTRACT = `
[Output format]
If you need to call a tool first, output: {"tool":"<tool_name>","args":{...}}   (at most ${MAX_TOOL_CALLS} calls this round)
If you already have enough information, output the final conclusion:
{"stance":"bullish|bearish|neutral|abstain","confidence":0.0~1.0,"summary":"conclusion (80-200 chars)",
 "advice":{...},"flags":["risks to note"]}
Output JSON only; no explanation text, no markdown code block.`;

/** 通用调用：带工具循环 */
async function invoke(
  llm: LlmProvider,
  expert: Omit<Expert, "run">,
  ctx: ExpertContext
): Promise<ExpertOpinion> {
  // 组装本专家可用能力（尊重 store 里的 Skill 开关）
  const mySkills = expert.skills
    .map((id) => getSkill(id))
    .filter((s) => s && isSkillEnabled(s.id));
  const skillList = mySkills.length
    ? mySkills.map((s) => `- ${s!.id} (${s!.name}): ${s!.description}\n  args: ${s!.args}`).join("\n")
    : "(none)";
  const mcpList =
    ctx.mcpTools && ctx.mcpTools.length
      ? ctx.mcpTools.map((t) => `- ${t.name}: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 90)}`).join("\n")
      : "(none)";

  // 知识库注入：本专家目录下的经验库（过往轮次沉淀 + 领域最佳实践）
  const kb = loadKnowledge(expert.id);
  const sys = `${expert.systemPrompt}

[Skills you can call]
${skillList}

[MCP tools you can call]
${mcpList}
${kb ? `\n[Your experience library (expert-specific knowledge, for reference only; you may override it with this round's actual data)]\n${kb}\n` : ""}
${OUTPUT_CONTRACT}`;

  let user = ctx.sharedContext + (ctx.focus ? `\n[Focus from Main Agent] ${ctx.focus}` : "");
  const toolCalls: string[] = [];
  const modelName = (llm as { model?: string })?.model;

  for (let i = 0; i <= MAX_TOOL_CALLS; i++) {
    traceRound(`${expert.name}·第 ${i + 1} 次调用`, modelName);
    const raw = await llm.decide(sys, user + `\n${OUTPUT_CONTRACT}`, { onReasoning: traceReasoning });
    const call = parseToolCall(raw);

    if (call && i < MAX_TOOL_CALLS) {
      let result: string;
      let failed = false;
      const skill = mySkills.find((s) => s!.id === call.tool);
      const mcp = ctx.mcpTools?.find((t) => t.name === call.tool);

      trace({ source: "agent", kind: "tool_call", name: call.tool, args: call.args });
      if (skill) {
        const r = await skill.run(call.args);
        result = r.ok ? r.output.slice(0, 6000) : `失败: ${r.error}`;
        failed = !r.ok;
        toolCalls.push(`skill:${call.tool}`);
      } else if (mcp) {
        try {
          const r = await mcp.invoke(call.args);
          result = JSON.stringify(r).slice(0, 6000);
          toolCalls.push(`mcp:${call.tool}`);
        } catch (e) {
          result = `MCP 调用失败: ${String(e).slice(0, 300)}`;
          failed = true;
        }
      } else {
        result = `Unknown tool "${call.tool}". Available: ${mySkills.map((s) => s!.id).join(", ")}${
          ctx.mcpTools?.length ? ", " + ctx.mcpTools.map((t) => t.name).join(", ") : ""
        }`;
        failed = true;
      }
      trace({ source: "agent", kind: "tool_result", name: call.tool, ok: !failed, output: result.slice(0, 2000) });
      user += `\n\n[Tool ${call.tool} returned]\n${result}\n(tool calls used: ${toolCalls.length}/${MAX_TOOL_CALLS})`;
      continue;
    }

    // 非工具调用 → 视为最终结论
    try {
      const j = extractJson(raw);
      return {
        expert: expert.id,
        stance: (j.stance as ExpertOpinion["stance"]) ?? "abstain",
        confidence: Number(j.confidence ?? 0),
        summary: String(j.summary ?? ""),
        advice: (j.advice as Record<string, unknown>) ?? {},
        flags: Array.isArray(j.flags) ? (j.flags as string[]) : [],
        toolCalls,
        rawText: raw,
      };
    } catch {
      return {
        expert: expert.id,
        stance: "abstain",
        confidence: 0,
        summary: `输出解析失败: ${raw.slice(0, 200)}`,
        advice: {},
        flags: ["输出非 JSON"],
        toolCalls,
        rawText: raw,
      };
    }
  }

  return {
    expert: expert.id,
    stance: "abstain",
    confidence: 0,
    summary: `工具调用次数达上限(${MAX_TOOL_CALLS})仍未给出结论`,
    advice: {},
    flags: ["工具调用超限"],
    toolCalls,
  };
}

// ────────────────────────────────────────────────────────────
// 1. 交易系统专家
// ────────────────────────────────────────────────────────────
const tradingBase: Omit<Expert, "run"> = {
  id: "trading",
  name: "Trading System Expert",
  duty: "Manages positions, open/close decisions, position sizing and stop-loss parameters. Not responsible for news or technical scoring (handled by other experts).",
  systemPrompt: `You are the [Trading System Expert].

Duty: based on account state, positions, and other expert opinions relayed by the Main Agent, give concrete trade execution suggestions.

Output (advice field):
{
  "actions": [
    {"inst":"BTC-USDT-SWAP","action":"hold|long|short|close",
     "riskPct":0.012,"slDist":712.3,"tpRR":2.0,"reason":"required reason"}
  ]
}

Discipline:
- "No trade" is legal but needs a reason; "no trade" and "open" carry equal burden of proof.
- When already holding, first decide: hold / close / move stop-loss — not default to adding.
- riskPct suggested 0.5%~2.5%; above 2% flag it as needing manual approval.
- Opening a position must include slDist, otherwise invalid.
- Instruments: you may trade any USDT perpetual in [Candidate instruments & market digest]; long and short are equal, both allowed (net mode = single direction).
- Prefer liquid, well-specified instruments; avoid very low price / very small tickSz.
- You may use read-only MCP tools to check position/equity details; do NOT place orders yourself (execution belongs to the Main Agent).`,
  skills: ["order_id", "read_charter"],
  mcpServers: ["okx-trade-mcp"],
};

// ────────────────────────────────────────────────────────────
// 2. 新闻资讯专家
// ────────────────────────────────────────────────────────────
const newsBase: Omit<Expert, "run"> = {
  id: "news",
  name: "News & Information Expert",
  duty: "Handles the news/event side: event gate, directional veto, and cross-verification of key numbers. Produces no opening signal.",
  systemPrompt: `You are the [News & Information Expert].

Duty: assess the impact of news/events on crypto markets (mainly BTC/ETH, also other instruments in the candidate pool). News is a veto power and position modulator, NOT an opening signal.

Suggested flow:
1. First call news_fetch to collect news (skip if sharedContext already has it)
2. For key items with impact=high or credibility=A, call news_verify for dual-source verification
3. Then output the conclusion

Output (advice field):
{
  "gateOpen": true/false,
  "blockingEvents": ["event name (time)"],
  "keyNews": [{"title":"...","direction":"bullish|bearish|neutral|mixed",
               "impact":"high|mid|low","credibility":"A|B|C","verified":true/false,"note":"..."}],
  "reactionNote": "this round's reaction-function judgment"
}

Key rules:
- Key numbers (macro data, rate-hike probability, flows) need ≥2 independent sources to be credibility=A, verified=true.
  Single source is only B, has NO veto power, and must be flagged.
- Macro expectation data older than 48h must be re-verified.
- Current environment prices in rate hikes; Fed chair is Kevin Warsh (not Powell); reaction function is inverted:
  strong jobs = hawkish = bearish crypto; weak jobs = less hike pressure = bullish crypto.
- Only assess US macro events on crypto; Canada/Australia/Vietnam etc. generally do not block.`,
  skills: ["news_fetch", "news_verify", "news_log", "read_charter"],
  mcpServers: [],
  alwaysInvoke: true, // 消息面是事件闸门，空仓也要看
};

// ────────────────────────────────────────────────────────────
// 3. 因子评分专家
// ────────────────────────────────────────────────────────────
const factorBase: Omit<Expert, "run"> = {
  id: "factor",
  name: "Factor Scoring Expert",
  duty: "Multi-timeframe technical factor scoring and confluence judgment. Not responsible for execution or news.",
  systemPrompt: `You are the [Factor Scoring Expert].

Duty: score any USDT perpetual in [Candidate instruments & market digest] on multi-timeframe (4H/1H/15m) technical factors.
The candidate-pool digest is already in sharedContext (confluence score/trend/RSI/volume ratio/ATR%/range position/funding); score directly from it;
call market_scan only if you need detailed bars for a specific instrument.

Output (advice field):
{
  "scores": {
    "BTC-USDT-SWAP": {"total":-35.2,"perBar":{"4H":-8,"1H":-72,"15m":-48},
      "trend":"down|up|range","volRatio":1.255,"rangePosPct":11.2,"rr":2.0,"funding":0.0001},
    "SOL-USDT-SWAP": { ... }
  },
  "thresholdCheck": {
    "BTC-USDT-SWAP": {"scoreOk":true,"trendOk":true,"volOk":true,
                      "rangeOk":true,"rrOk":true,"fundingOk":true}
  }
}

Scoring baseline (§4):
- |confluence score| ≥28 counts as a signal; weighted 4H 50% / 1H 30% / 15m 20%.
- 4H/1H trends must not conflict; when 4H=range, 1H leads (discretion — note it in flags).
- vol_ratio ≥0.8; 4H range position must avoid the 38%~62% middle zone.
- RR ≥1.6 (suggest 2.0); |funding rate| ≤0.05%.

Only give scores and threshold checks, no buy/sell instructions.`,
  skills: ["market_scan", "read_charter"],
  mcpServers: [],
};

// ────────────────────────────────────────────────────────────
// 4. 风控专家
// ────────────────────────────────────────────────────────────
const riskBase: Omit<Expert, "run"> = {
  id: "risk",
  name: "Risk Control Expert",
  duty: "Drawdown, circuit-breaker, exposure and correlation risk. Usually invoked when holding or losing.",
  systemPrompt: `You are the [Risk Control Expert].

Duty: assess the current state from a "stay alive" perspective and give risk-constraint suggestions.

Output (advice field):
{
  "drawdown": {"day":0.0,"month":0.0},
  "exposureX": 1.12,
  "circuitBreaker": false,
  "suggestions": ["suggestions..."]
}

Watch: daily/monthly drawdown, total exposure multiple, correlation across instruments (when same-sector / same-beta instruments align, multiple positions are really one bet),
      losing-streak count, whether circuit-breaker thresholds are hit. Prioritize "having a next trade" over chasing this trade's profit.`,
  skills: ["read_charter"],
  mcpServers: ["okx-trade-mcp"],
};

export const EXPERTS: Expert[] = [
  { ...tradingBase, run: (llm, ctx) => invoke(llm, tradingBase, ctx) },
  { ...newsBase, run: (llm, ctx) => invoke(llm, newsBase, ctx) },
  { ...factorBase, run: (llm, ctx) => invoke(llm, factorBase, ctx) },
  { ...riskBase, run: (llm, ctx) => invoke(llm, riskBase, ctx) },
];

// ── 可插拔专家：定义文件在 experts/*.json，程序启动时扫描加载 ────
/**
 * 专家定义的三层来源：
 *   1. experts/*.json —— 内置声明式定义（项目目录下，可版本控制，是「源」）
 *   2. store.roles    —— 运行时覆盖层（界面编辑过的 prompt/skills/mcp/enabled 优先）
 *   3. EXPERTS        —— 兜底（experts/ 目录缺失或为空时用，保证程序不崩）
 *
 * 可插拔：新增专家 = 在 experts/ 放一个 JSON；删除专家 = 删掉对应 JSON。
 * 无需改任何 TS 代码，重启即生效。
 */
/**
 * 专家目录根。默认 `<AGENT_ROOT>/experts`；环境变量 `QTA_EXPERTS_DIR` 可覆盖 ——
 * 只给自测用（知识库那套自测要在临时目录里真写文件，不能往仓库的 experts/ 里丢垃圾）。
 */
export function expertsRootDir(): string {
  const o = process.env.QTA_EXPERTS_DIR;
  return o ? path.resolve(o) : path.join(AGENT_ROOT, "experts");
}

export function loadExpertDefs(): ExpertDef[] {
  const EXPERTS_DIR = expertsRootDir();
  if (!fs.existsSync(EXPERTS_DIR)) return [];
  const out: ExpertDef[] = [];
  for (const entry of fs.readdirSync(EXPERTS_DIR).sort()) {
    const full = path.join(EXPERTS_DIR, entry);
    // 新结构：experts/<id>/expert.json（每个专家一个目录，可带 knowledge/）
    if (fs.statSync(full).isDirectory()) {
      const defFile = path.join(full, "expert.json");
      if (!fs.existsSync(defFile)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(defFile, "utf8")) as ExpertDef;
        if (j && typeof j.id === "string" && j.id) out.push(j);
      } catch {
        trace({ source: "agent", kind: "error", message: `专家定义解析失败: ${entry}` });
      }
      continue;
    }
    // 兼容旧扁平结构：experts/*.json
    if (entry.endsWith(".json")) {
      try {
        const j = JSON.parse(fs.readFileSync(full, "utf8")) as ExpertDef;
        if (j && typeof j.id === "string" && j.id) out.push(j);
      } catch {
        trace({ source: "agent", kind: "error", message: `专家定义解析失败: ${entry}` });
      }
    }
  }
  return out;
}

// ── 专家知识库（可插拔 + 自动进化） ─────────────────────────
/**
 * 每个专家有一个独立知识库目录 `experts/<id>/knowledge/`，里面放若干 .md：
 *   · 00-*.md 等 —— 领域最佳实践（预置，来自公开资料/踩坑经验）
 *   · lessons.md —— 自动进化沉淀（reflectExperts 每轮追加）
 * 运行时把整个知识库注入该专家的 systemPrompt，作为「专家专属经验」。
 *
 * 这里补上的三件事，原先都是**静默**的：
 *   ① **写哪儿不校验**：`evolveExpert(id)` 直接 `mkdir -p experts/<id>/knowledge`，
 *      而 id 来自 LLM 的 JSON 输出 —— `../../x` 这种值能把文件写到仓库外面去。
 *      现在 id 过白名单，且解析后必须仍在 experts 根之内。
 *   ② **归属兜底没人接**：提示词让模型「无法归属时用 main」，而 `main` 不是任何专家 ——
 *      那些教训被写进 `experts/main/knowledge/lessons.md`，**没有任何专家会读它**，
 *      等于永久静默丢失。现在统一落进共享桶 `_shared`，且 `loadKnowledge` 会注入给所有专家。
 *   ③ **裁剪不留痕**：超上限时裁掉最旧一半，文件里没有任何记录（文件头却写着「只增不删」）。
 *      现在裁剪会在 lessons.md 顶部留一条记录，并由 `evolveExpert` 的返回值报给调用方。
 */

/** 共享教训桶：无法归属到具体专家的教训落在这里，**所有专家都会读到** */
export const SHARED_KNOWLEDGE_ID = "_shared";
/** lessons.md 体积上限：超出裁掉最旧一半（裁剪会在文件里留痕） */
export const MAX_LESSONS_BYTES = 60 * 1024;
/** 注入 systemPrompt 的知识库字节上限 */
export const MAX_KNOWLEDGE_INJECT_BYTES = 12000;
/** 单个知识库文件允许写入的字节上限（防在界面上误粘一个大文件） */
export const MAX_KNOWLEDGE_FILE_BYTES = 512 * 1024;
/** 知识库文件名字数上限（Windows 路径长度留余量） */
const MAX_KNOWLEDGE_NAME_LEN = 120;

/** bucket id 白名单：只允许字母、数字与 `_` `-`。杜绝 `..`、`/`、`\`、盘符、空串。 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
/** 知识库文件名：必须以 .md 结尾，且不含控制字符与 Windows 保留字符 */
const SAFE_KNOWLEDGE_FILE_RE = /^[^\u0000-\u001f\\/:*?"<>|]+\.md$/;

function assertSafeBucketId(id: unknown): string {
  const s = String(id ?? "").trim();
  if (!SAFE_ID_RE.test(s)) {
    throw new Error(`非法的知识库 id「${String(id)}」：只允许字母、数字与 _ -`);
  }
  return s;
}

/**
 * 某个 bucket 的知识库目录。
 * id 必须过白名单，且**解析后仍要落在 experts 根之内**才放行 ——
 * `evolveExpert` 的 id 直接来自 LLM 的 JSON 输出，`../../x` 这类值原先会被
 * `path.join` 老老实实拼出去、再由 `mkdirSync` 在仓库外面建目录。
 */
export function knowledgeDir(id: string): string {
  const root = path.resolve(expertsRootDir());
  const full = path.resolve(root, assertSafeBucketId(id), "knowledge");
  if (path.dirname(path.dirname(full)) !== root) {
    throw new Error(`知识库目录越界：${String(id)}`);
  }
  return full;
}

/** 知识库文件的安全绝对路径（文件名不准带路径，解析后必须就在该 bucket 目录里） */
export function knowledgeFilePath(id: string, name: string): string {
  const dir = knowledgeDir(id);
  const base = String(name ?? "").trim();
  if (
    !SAFE_KNOWLEDGE_FILE_RE.test(base) ||
    base.startsWith(".") ||
    base.length > MAX_KNOWLEDGE_NAME_LEN
  ) {
    throw new Error(`非法的知识库文件名「${String(name)}」：必须以 .md 结尾且不含路径分隔符`);
  }
  const full = path.resolve(dir, base);
  if (path.dirname(full) !== path.resolve(dir)) {
    throw new Error(`知识库文件路径越界：${String(name)}`);
  }
  return full;
}

export interface KnowledgeFile {
  name: string;
  bytes: number;
  mtime: string;
  /** 自动进化沉淀（reflectExperts 每轮追加），受 MAX_LESSONS_BYTES 约束 */
  auto: boolean;
  /** true = 在目录里但**不会被任何专家读到**（不是 .md / 文件名非法）—— 要显式报出来 */
  ignored: boolean;
}

/** 列出某个 bucket 知识库目录里的全部普通文件（含「不会被读到」的那些，供界面告警） */
export function listKnowledgeFiles(id: string): KnowledgeFile[] {
  const dir = knowledgeDir(id);
  if (!fs.existsSync(dir)) return [];
  const out: KnowledgeFile[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const ok = SAFE_KNOWLEDGE_FILE_RE.test(name) && !name.startsWith(".");
    out.push({
      name,
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      auto: name === "lessons.md",
      ignored: !ok,
    });
  }
  return out;
}

/** 读一个知识库文件的全文 */
export function readKnowledgeFile(id: string, name: string): string {
  return fs.readFileSync(knowledgeFilePath(id, name), "utf8");
}

/** 写一个知识库文件（新建或覆盖），返回写入字节数 */
export function writeKnowledgeFile(id: string, name: string, text: string): number {
  const p = knowledgeFilePath(id, name);
  const body = String(text ?? "");
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new Error(`内容 ${bytes} 字节，超过单文件上限 ${MAX_KNOWLEDGE_FILE_BYTES} 字节`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
  return bytes;
}

/** 删一个知识库文件（不存在的文件报错，不静默成功） */
export function deleteKnowledgeFile(id: string, name: string): void {
  const p = knowledgeFilePath(id, name);
  if (!fs.existsSync(p)) throw new Error(`文件不存在：${name}`);
  fs.unlinkSync(p);
}

/** 全部可注入知识库的 bucket：已注册专家 + 共享桶 + 磁盘上留着但已无主人的目录 */
export interface KnowledgeBucket {
  id: string;
  name: string;
  /** 共享桶（_shared）—— 所有专家都会读到 */
  shared: boolean;
  /** true = 目录存在但**没有对应专家**：写进去的教训没人读 */
  orphan: boolean;
  /** 启用状态（仅在能对上角色时给出） */
  enabled: boolean | null;
  files: KnowledgeFile[];
}

/** 已注册的专家 id（`experts/<id>/expert.json`）+ 内置兜底专家 */
export function knownExpertIds(): Set<string> {
  const ids = new Set<string>();
  for (const d of loadExpertDefs()) if (d?.id) ids.add(d.id);
  for (const e of EXPERTS) ids.add(e.id);
  return ids;
}

/**
 * 把任意来源的 id 归一成一个**真实可读**的 bucket。
 * 无法归属时一律进共享桶 —— 原先提示词让模型「无法归属时用 main」，而 `main`
 * 不是任何专家，那些教训被写进 `experts/main/knowledge/lessons.md` 后**没有任何专家会读**。
 */
export function resolveKnowledgeBucket(id: unknown): { target: string; reassigned: boolean } {
  const raw = String(id ?? "").trim();
  if (raw === SHARED_KNOWLEDGE_ID) return { target: SHARED_KNOWLEDGE_ID, reassigned: false };
  if (!SAFE_ID_RE.test(raw)) return { target: SHARED_KNOWLEDGE_ID, reassigned: true };
  return knownExpertIds().has(raw)
    ? { target: raw, reassigned: false }
    : { target: SHARED_KNOWLEDGE_ID, reassigned: true };
}

/** 知识库 bucket 清单（界面「经验库」页的数据源） */
export function listKnowledgeBuckets(): KnowledgeBucket[] {
  let roles: RoleConfig[] = [];
  try {
    roles = listRoles();
  } catch {
    roles = [];
  }
  const defs = loadExpertDefs();
  const out: KnowledgeBucket[] = [];
  const seen = new Set<string>();

  for (const d of defs) {
    const ov = roles.find((r) => r.id === d.id);
    seen.add(d.id);
    out.push({
      id: d.id,
      name: ov?.name ?? d.name,
      shared: false,
      orphan: false,
      enabled: ov?.enabled ?? (d.enabled !== false),
      files: listKnowledgeFiles(d.id),
    });
  }
  // 磁盘上还有目录、但已经找不到对应专家定义（例如历史遗留的 main/）：教训写了没人读，必须报出来
  const root = expertsRootDir();
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root).sort()) {
      if (seen.has(entry) || entry === SHARED_KNOWLEDGE_ID) continue;
      let isDir = false;
      try {
        isDir = fs.statSync(path.join(root, entry)).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir || !SAFE_ID_RE.test(entry)) continue;
      const files = listKnowledgeFiles(entry);
      if (!files.length) continue; // 空目录不列，避免噪声
      out.push({ id: entry, name: entry, shared: false, orphan: true, enabled: null, files });
    }
  }

  out.push({
    id: SHARED_KNOWLEDGE_ID,
    name: "共享教训（所有专家都会读到）",
    shared: true,
    orphan: false,
    enabled: null,
    files: listKnowledgeFiles(SHARED_KNOWLEDGE_ID),
  });
  return out;
}

/**
 * 读取专家知识库全部 .md（按文件名排序），拼成一段注入 systemPrompt 的文本。
 *
 * 两点与旧实现的区别，都是「不再静默」：
 *   · 归属兜底的教训落在共享桶，这里一并注入 —— 否则那些教训永远没人读；
 *   · 超上限时按**文件**为单位跳过并列出文件名，而不是把正文从中间砍断
 *     （旧实现 `text.slice(0, maxBytes)` 会把最后一句话切成半句，且不说少了什么）。
 */
export function loadKnowledge(id: string, maxBytes = MAX_KNOWLEDGE_INJECT_BYTES): string {
  const buckets =
    String(id).trim() === SHARED_KNOWLEDGE_ID ? [SHARED_KNOWLEDGE_ID] : [String(id).trim(), SHARED_KNOWLEDGE_ID];
  const chunks: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const b of buckets) {
    let files: KnowledgeFile[] = [];
    try {
      files = listKnowledgeFiles(b);
    } catch {
      continue; // 非法 id：当作没有知识库，不要让专家调用整个失败
    }
    for (const f of files) {
      if (f.ignored) continue;
      let body: string;
      try {
        body = fs.readFileSync(knowledgeFilePath(b, f.name), "utf8");
      } catch {
        continue;
      }
      const chunk = `${b === SHARED_KNOWLEDGE_ID ? "## 共享教训/" : "## "}${f.name}\n${body}`;
      const size = Buffer.byteLength(chunk, "utf8");
      if (used + size > maxBytes) {
        skipped.push(`${b === SHARED_KNOWLEDGE_ID ? `${SHARED_KNOWLEDGE_ID}/` : ""}${f.name}`);
        continue;
      }
      used += size;
      chunks.push(chunk);
    }
  }
  let text = chunks.join("\n\n");
  if (skipped.length) {
    text += `\n\n> ⚠ 知识库超出本轮注入上限 ${maxBytes} 字节，以下文件本轮未注入：${skipped.join("、")}`;
  }
  return text;
}

/** 自动进化：一条已提炼的教训（复盘产出，非流水账） */
export interface EvolutionEntry {
  roundId: string;
  time: string;
  /** 教训文本（精炼、可证伪：当 X 时应 Y，因为 Z） */
  text: string;
  /** 关联决策摘要（可选，供追溯） */
  decision?: string;
}

/** lessons.md 的文件头（「只增不删」与「超限裁剪」两件事都写在这里，别只写一半） */
const LESSONS_HEADER =
  "# 教训与进化记录（复盘提炼）\n\n" +
  `> 由 reflectExperts 每轮自动追加。只追加、不手工删；超过 ${MAX_LESSONS_BYTES} 字节时裁掉最旧一半，裁剪会在这里留下记录。\n\n`;

/** 一条裁剪记录（写进 lessons.md 顶部，用户看得见「东西被丢过」） */
function trimNotice(): string {
  return `> ⚠ ${new Date().toISOString().slice(0, 19).replace("T", " ")} 已超过 ${MAX_LESSONS_BYTES} 字节上限，裁掉最旧一半。\n\n`;
}

export interface EvolveResult {
  ok: boolean;
  /** 实际落盘的 bucket（无法归属时是 _shared） */
  target: string;
  /** 本次是否发生了归属兜底（原 id 不是已注册专家） */
  reassigned: boolean;
  /** 本次是否触发了体积裁剪 */
  trimmed: boolean;
  bytes: number;
  error?: string;
}

/**
 * 把一条提炼过的教训追加到 knowledge/lessons.md。
 * 写入的 bucket 一定是一个**真实可读**的位置（已注册专家或共享桶），
 * 且 id 与文件名都过白名单 —— 不再有「写到仓库外面」和「写了没人读」两种静默。
 */
export function evolveExpert(id: string, entry: EvolutionEntry): EvolveResult {
  let target = SHARED_KNOWLEDGE_ID;
  let reassigned = false;
  try {
    const r = resolveKnowledgeBucket(id);
    target = r.target;
    reassigned = r.reassigned;
    const dir = knowledgeDir(target);
    fs.mkdirSync(dir, { recursive: true });
    const f = knowledgeFilePath(target, "lessons.md");
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f, LESSONS_HEADER, "utf8");
    }
    let trimmed = false;
    if (fs.statSync(f).size > MAX_LESSONS_BYTES) {
      trimmed = true;
      const tail = fs.readFileSync(f, "utf8").slice(-(MAX_LESSONS_BYTES >> 1));
      const nl = tail.indexOf("\n");
      const body = nl >= 0 ? tail.slice(nl + 1) : tail; // 丢掉被切半的首行
      fs.writeFileSync(f, LESSONS_HEADER + trimNotice() + body, "utf8");
      trace({
        source: "agent",
        kind: "error",
        message: `专家知识库 ${target}/lessons.md 超过 ${MAX_LESSONS_BYTES} 字节，已裁掉最旧一半`,
      });
    }
    const line = `- ${entry.time} [${entry.roundId}] ${entry.text}`;
    fs.appendFileSync(f, line + "\n\n", "utf8");
    if (reassigned) {
      trace({
        source: "agent",
        kind: "error",
        message: `教训归属兜底：专家「${String(id)}」不存在，已写入共享桶 ${SHARED_KNOWLEDGE_ID}`,
      });
    }
    return { ok: true, target, reassigned, trimmed, bytes: fs.statSync(f).size };
  } catch (e) {
    trace({ source: "agent", kind: "error", message: `专家进化写入失败 ${target}: ${String(e).slice(0, 120)}` });
    return { ok: false, target, reassigned, trimmed: false, bytes: 0, error: String(e).slice(0, 200) };
  }
}

/**
 * 复盘式进化：用 LLM 把本轮「专家观点 + 主 Agent 决策 + 执行结果」提炼成
 * 可证伪的教训，归属到相关专家后写入各自 lessons.md。
 * 与旧的机械追加不同：只记「可执行的教训」，观望/无实质判断时宁缺毋滥，避免污染上下文。
 */
/** 一轮复盘的写入结果（让「有几条没归属」「有没有文件被裁」在日志里看得见） */
export interface ReflectResult {
  written: number;
  /** 归属兜底到共享桶的条数（原 id 不是已注册专家） */
  reassigned: number;
  /** 触发体积裁剪的文件数 */
  trimmed: number;
}

export async function reflectExperts(opts: {
  llm: LlmProvider;
  roundId: string;
  time: string;
  opinions: ExpertOpinion[];
  decision: string;
  outcome: string;
}): Promise<ReflectResult> {
  const { llm, roundId, time, opinions, decision, outcome } = opts;
  const none: ReflectResult = { written: 0, reassigned: 0, trimmed: 0 };
  if (!opinions.length) return none;

  // 专家 id 清单**现算**（别在提示词里手抄一份：目录里增删专家时它不会跟着变）。
  // 兜底去处是共享桶 `_shared` —— 不是 `main`：`main` 不是任何专家，写进去没人读。
  const ids = [...knownExpertIds()].sort().join("/");
  const sys = `You are a trade review assistant. Review this round's decision and distill lessons worth persisting into the expert knowledge base.

Strict rules:
- Only distill "actionable, falsifiable" lessons (e.g. "when 4H and 1H trends conflict, trust 4H"); never write a play-by-play log or repeat common knowledge.
- Tag each lesson with the expert id it mainly targets. Known ids: ${ids}. If none of them fits, use "${SHARED_KNOWLEDGE_ID}" (the shared bucket, injected into every expert). Do not invent other ids — an unknown id is dropped into the shared bucket anyway.
- If this round was just stand-by, had no substantive judgment, or nothing worth recording, output an empty array (better to under-record).
- At most 3 lessons.

Output JSON only: {"lessons":[{"expert":"trading","text":"when ..., do ..., because ..."}]}`;

  const user = [
    `Round ${roundId}`,
    `Main Agent decision: ${decision}`,
    `Execution result: ${outcome}`,
    `Expert opinions:`,
    ...opinions.map((o) => `- ${o.expert}(${o.stance}, confidence ${o.confidence}): ${o.summary.slice(0, 160)}`),
  ].join("\n");

  let lessons: { expert: string; text: string }[] = [];
  try {
    const raw = await llm.decide(sys, user);
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw) as { lessons?: { expert?: string; text?: string }[] };
    lessons = (j.lessons ?? [])
      .filter((l) => l?.expert && l?.text && String(l.text).trim())
      .map((l) => ({ expert: String(l.expert), text: String(l.text).trim() }));
  } catch {
    return none; // 复盘失败静默，不阻塞交易
  }

  const results = lessons.map((l) =>
    evolveExpert(l.expert, { roundId, time, text: l.text, decision })
  );
  return {
    written: results.filter((r) => r.ok).length,
    reassigned: results.filter((r) => r.reassigned).length,
    trimmed: results.filter((r) => r.trimmed).length,
  };
}

/**
 * 完整角色列表（供 UI「角色」页与 allExperts 共用）：
 *   · 文件专家（experts/*.json）= 源，含 enabled 默认值
 *   · store.roles 同 id = 覆盖层（界面改过 prompt/skills/enabled/modelId 优先）
 *   · store.roles 里文件没有的 = 用户在界面「新增」的自定义角色
 * 每项都带 enabled，供 UI 展示与启停。
 */
export function listExpertRoles(): RoleConfig[] {
  const defs = loadExpertDefs();
  let overrides: RoleConfig[] = [];
  try {
    overrides = listRoles();
  } catch {
    overrides = [];
  }
  const out: RoleConfig[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    const ov = overrides.find((r) => r.id === d.id);
    seen.add(d.id);
    out.push({
      id: d.id,
      name: ov?.name ?? d.name,
      duty: ov?.duty ?? d.duty,
      systemPrompt: ov?.systemPrompt ?? d.systemPrompt,
      skills: ov?.skills ?? d.skills,
      mcpServers: ov?.mcpServers ?? d.mcpServers,
      enabled: ov?.enabled ?? d.enabled,
      modelId: ov?.modelId,
      createdAt: ov?.createdAt ?? "",
    });
  }
  // 界面新增的自定义角色（文件里没有）
  for (const r of overrides) {
    if (!seen.has(r.id)) out.push(r);
  }
  return out;
}

export function allExperts(): Expert[] {
  const roles = listExpertRoles();
  if (!roles.length) {
    // 兜底：experts/ 目录与 store 都为空时用内置 EXPERTS（4 个原始专家）
    return EXPERTS;
  }
  const defs = loadExpertDefs();
  const alwaysById = new Map(defs.map((d) => [d.id, d.alwaysInvoke === true]));
  return roles
    .filter((r) => r.enabled)
    .map((r) => {
      const base: Omit<Expert, "run"> = {
        id: r.id,
        name: r.name,
        duty: r.duty,
        systemPrompt: r.systemPrompt,
        skills: r.skills,
        mcpServers: r.mcpServers,
        alwaysInvoke: alwaysById.get(r.id),
      };
      return { ...base, run: (llm, ctx) => invoke(llm, base, ctx) };
    });
}

export function getExpert(id: string): Expert | undefined {
  return allExperts().find((e) => e.id === id);
}

export { skillCatalog, SKILLS };
