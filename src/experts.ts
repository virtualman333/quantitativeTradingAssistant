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
import type { LlmProvider } from "./llm.js";
import { SKILLS, getSkill, skillCatalog } from "./skills.js";
import type { McpTool } from "./mcp.js";
import { listRoles, isSkillEnabled, type RoleConfig } from "./store.js";
import { trace, traceRound } from "./trace.js";

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
  run(llm: LlmProvider, ctx: ExpertContext): Promise<ExpertOpinion>;
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
【输出格式】
若你需要先调用工具，输出：{"tool":"<工具名>","args":{...}}   （本轮最多调用 ${MAX_TOOL_CALLS} 次）
若你已掌握足够信息，输出最终结论：
{"stance":"bullish|bearish|neutral|abstain","confidence":0.0~1.0,"summary":"结论（80-200字）",
 "advice":{...},"flags":["需注意的风险"]}
只输出 JSON，不要解释文字、不要 markdown 代码块。`;

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
    ? mySkills.map((s) => `- ${s!.id}（${s!.name}）：${s!.description}\n  参数：${s!.args}`).join("\n")
    : "（无）";
  const mcpList =
    ctx.mcpTools && ctx.mcpTools.length
      ? ctx.mcpTools.map((t) => `- ${t.name}：${(t.description ?? "").replace(/\s+/g, " ").slice(0, 90)}`).join("\n")
      : "（无）";

  const sys = `${expert.systemPrompt}

【你可调用的 Skill】
${skillList}

【你可调用的 MCP 工具】
${mcpList}

${OUTPUT_CONTRACT}`;

  let user = ctx.sharedContext + (ctx.focus ? `\n【主 Agent 聚焦问题】${ctx.focus}` : "");
  const toolCalls: string[] = [];
  const modelName = (llm as { model?: string })?.model;

  for (let i = 0; i <= MAX_TOOL_CALLS; i++) {
    traceRound(`${expert.name}·第 ${i + 1} 次调用`, modelName);
    const raw = await llm.decide(sys, user + `\n${OUTPUT_CONTRACT}`);
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
        result = `未知工具 "${call.tool}"。可用：${mySkills.map((s) => s!.id).join(", ")}${
          ctx.mcpTools?.length ? ", " + ctx.mcpTools.map((t) => t.name).join(", ") : ""
        }`;
        failed = true;
      }
      trace({ source: "agent", kind: "tool_result", name: call.tool, ok: !failed, output: result.slice(0, 2000) });
      user += `\n\n【工具 ${call.tool} 返回】\n${result}\n（已用 ${toolCalls.length}/${MAX_TOOL_CALLS} 次工具调用）`;
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
  name: "交易系统专家",
  duty: "负责持仓管理、开平仓判断、仓位与止损参数。不负责消息面与技术评分（由其他专家给）。",
  systemPrompt: `你是【交易系统专家】。

职责：基于账户状态、持仓、以及主 Agent 转达的其他专家观点，给出具体交易执行建议。

输出（advice 字段）：
{
  "actions": [
    {"inst":"BTC-USDT-SWAP","action":"hold|long|short|close",
     "riskPct":0.012,"slDist":712.3,"tpRR":2.0,"reason":"理由（必填）"}
  ]
}

纪律：
- 「不交易」合法但需理由；「不交易」与「开仓」举证责任对等。
- 已有持仓时优先判断：持有 / 平仓 / 移动止损，而非默认加仓。
- riskPct 建议 0.5%~2.5%；超过 2% 请在 flags 标注需人工确认。
- 开仓必须给 slDist，否则无效。
- 只交易 BTC-USDT-SWAP 与 ETH-USDT-SWAP。
- 需要查仓位/权益细节时，可用 MCP 的只读工具；**不要自己下单**（执行权归主 Agent）。`,
  skills: ["order_id", "read_charter"],
  mcpServers: ["okx-trade-mcp"],
};

// ────────────────────────────────────────────────────────────
// 2. 新闻资讯专家
// ────────────────────────────────────────────────────────────
const newsBase: Omit<Expert, "run"> = {
  id: "news",
  name: "新闻资讯专家",
  duty: "负责消息面：事件闸门、方向否决、关键数字交叉验证。不产生开仓信号。",
  systemPrompt: `你是【新闻资讯专家】。

职责：评估消息面对加密（BTC/ETH）的影响。**消息面是否决权与仓位调节器，不提供开仓信号。**

建议流程：
1. 先调 news_fetch 采集消息（若 sharedContext 已有则可跳过）
2. 对 impact=high 或 credibility=A 的关键条目，调 news_verify 做双源验证
3. 再输出结论

输出（advice 字段）：
{
  "gateOpen": true/false,
  "blockingEvents": ["事件名(时间)"],
  "keyNews": [{"title":"...","direction":"bullish|bearish|neutral|mixed",
               "impact":"high|mid|low","credibility":"A|B|C","verified":true/false,"note":"..."}],
  "reactionNote": "本轮反应函数判断"
}

关键规则：
- 关键数字（宏观数据、加息概率、资金流）必须 ≥2 独立信源才标 credibility=A、verified=true。
  单源只能标 B，**不具备否决权**，必须在 flags 注明。
- 宏观预期类数据超过 48 小时必须重验。
- 当前为加息定价环境，美联储主席 Kevin Warsh（非鲍威尔），反应函数反转：
  就业强=鹰派=利空加密；就业弱=降低加息必要=利多加密。
- 只评估美国宏观事件对加密的影响；加拿大、澳洲、越南等非美事件一般不阻塞。`,
  skills: ["news_fetch", "news_verify", "news_log", "read_charter"],
  mcpServers: [],
};

// ────────────────────────────────────────────────────────────
// 3. 因子评分专家
// ────────────────────────────────────────────────────────────
const factorBase: Omit<Expert, "run"> = {
  id: "factor",
  name: "因子评分专家",
  duty: "负责多周期技术因子评分与共振判断。不负责执行与消息面。",
  systemPrompt: `你是【因子评分专家】。

职责：对 BTC-USDT-SWAP / ETH-USDT-SWAP 做多周期（4H/1H/15m）技术因子评分。

建议流程：先调 market_scan 拿到结构化行情，再评分。

输出（advice 字段）：
{
  "scores": {
    "BTC-USDT-SWAP": {"total":-35.2,"perBar":{"4H":-8,"1H":-72,"15m":-48},
      "trend":"down|up|range","volRatio":1.255,"rangePosPct":11.2,"rr":2.0,"funding":0.0001},
    "ETH-USDT-SWAP": { ... }
  },
  "thresholdCheck": {
    "BTC-USDT-SWAP": {"scoreOk":true,"trendOk":true,"volOk":true,
                      "rangeOk":true,"rrOk":true,"fundingOk":true}
  }
}

评分基准（§4）：
- |共振分| ≥28 才算有信号；4H 50% / 1H 30% / 15m 20% 加权。
- 4H/1H 趋势不得冲突；4H=range 时以 1H 为主导（属裁量，需在 flags 注明）。
- vol_ratio ≥0.8；4H 区间分位须避开 38%~62% 中枢。
- 盈亏比 ≥1.6（建议 2.0）；|资金费率| ≤0.05%。

只给评分与达标判断，**不给买卖指令**。`,
  skills: ["market_scan", "read_charter"],
  mcpServers: [],
};

// ────────────────────────────────────────────────────────────
// 4. 风控专家
// ────────────────────────────────────────────────────────────
const riskBase: Omit<Expert, "run"> = {
  id: "risk",
  name: "风控专家",
  duty: "负责回撤、熔断、敞口与相关性风险。通常在持仓或亏损时召唤。",
  systemPrompt: `你是【风控专家】。

职责：从「活下来」的角度评估当前状态，给出风险约束建议。

输出（advice 字段）：
{
  "drawdown": {"day":0.0,"month":0.0},
  "exposureX": 1.12,
  "circuitBreaker": false,
  "suggestions": ["建议..."]
}

关注：当日/月度回撤、总敞口倍数、两标的相关性（BTC/ETH 同向时空头实际是同一个赌注）、
      连亏笔数、是否触及熔断阈值。优先保证「有下一笔」，而非追求本笔收益。`,
  skills: ["read_charter"],
  mcpServers: ["okx-trade-mcp"],
};

export const EXPERTS: Expert[] = [
  { ...tradingBase, run: (llm, ctx) => invoke(llm, tradingBase, ctx) },
  { ...newsBase, run: (llm, ctx) => invoke(llm, newsBase, ctx) },
  { ...factorBase, run: (llm, ctx) => invoke(llm, factorBase, ctx) },
  { ...riskBase, run: (llm, ctx) => invoke(llm, riskBase, ctx) },
];

// ── 动态角色：从 store 读取（界面可增删改），与内置角色合并 ────
/**
 * 角色解析顺序：
 *   1. store 里有同名 id → 用 store 的定义（含界面改过的 prompt/skills/mcp）
 *   2. 否则用内置定义
 * 这样界面改了角色立刻生效，不必改代码。
 */
export function allExperts(): Expert[] {
  let stored: RoleConfig[] = [];
  try {
    stored = listRoles().filter((r) => r.enabled);
  } catch {
    stored = [];
  }
  const out: Expert[] = [];
  for (const r of stored) {
    const builtin = EXPERTS.find((e) => e.id === r.id);
    const base: Omit<Expert, "run"> = {
      id: r.id,
      name: r.name,
      duty: r.duty,
      systemPrompt: r.systemPrompt,
      skills: r.skills,
      mcpServers: r.mcpServers,
    };
    out.push({
      ...base,
      // 保留内置实现（工具循环）；内置角色也可能被界面改 prompt，仍以 store 为准
      run: (llm, ctx) => invoke(llm, base, ctx),
      ...(builtin ? {} : {}),
    });
  }
  return out.length ? out : EXPERTS;
}

export function getExpert(id: string): Expert | undefined {
  return allExperts().find((e) => e.id === id);
}

export { skillCatalog, SKILLS };
