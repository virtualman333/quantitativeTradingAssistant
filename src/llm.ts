/**
 * llm.ts —— 可插拔 LLM 适配器
 *
 * 用户选择：「先写框架，key 后续配」。
 * 因此这里定义统一接口 + 三个 provider 实现，key 全部从环境变量读取。
 * 配好 key 后无需改代码，设置 LLM_PROVIDER 即可切换。
 *
 * 环境变量：
 *   LLM_PROVIDER=deepseek|anthropic|openai|mock   （默认 mock）
 *   DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY
 *   LLM_MODEL=<可选，覆盖默认模型>
 *
 * mock 模式：不联网，用于联调流程（取数→决策→Guard→执行）而不消耗 token。
 *            mock 会输出一个保守的 HOLD 决策，便于验证链路。
 */
import type { Decision } from "./types.js";

export interface LlmProvider {
  readonly name: string;
  decide(systemPrompt: string, userPrompt: string): Promise<string>;
}

/** 决策系统提示词骨架（章程要点由上层注入） */
export const SYSTEM_PROMPT_SKELETON = `你是 OKX 永续合约自主交易系统的决策引擎。

【唯一目标】账户长期稳定盈利。不交易是一种合法决策，但"不交易"同样需要理由。

【输出格式】只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{
  "decision": "OPEN" | "HOLD" | "CLOSE" | "STANDBY",
  "riskTier": "BASE" | "AGG" | "DEF",
  "summary": "人读摘要（100-300字）",
  "intents": [
    {
      "inst": "BTC-USDT-SWAP",
      "action": "hold" | "long" | "short" | "close",
      "riskPct": 0.012,
      "slDist": 712.3,
      "tpRR": 2.0,
      "reason": "决策理由（必填，不少于5字）",
      "deviations": [
        {"baseline":"...","actual":"...","rationale":"...","falsifier":"...","riskDelta":"..."}
      ]
    }
  ]
}

【硬性要求】
- riskPct 不得超过 0.025（2.5%），超过会被系统拒绝。
- 开仓必须给出 slDist（止损距离，价格单位），否则被拒绝。
- 偏离章程基准时，deviations 五项必须齐全，尤其 falsifier（可证伪预判）。
- 只能交易 BTC-USDT-SWAP 与 ETH-USDT-SWAP。
`;

function extractJson(text: string): string {
  // 容错：LLM 有时会包 ```json 代码块
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = m ? m[1] : text;
  const s = body.indexOf("{");
  const e = body.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("LLM 输出中未找到 JSON");
  return body.slice(s, e + 1);
}

abstract class BaseProvider implements LlmProvider {
  abstract readonly name: string;
  protected abstract call(sys: string, user: string): Promise<string>;
  async decide(systemPrompt: string, userPrompt: string): Promise<string> {
    const raw = await this.call(systemPrompt, userPrompt);
    return extractJson(raw);
  }
}

/** DeepSeek（OpenAI 兼容协议） */
class DeepSeekProvider extends BaseProvider {
  readonly name = "deepseek";
  private get key() {
    return process.env.DEEPSEEK_API_KEY ?? "";
  }
  private get model() {
    return process.env.LLM_MODEL ?? "deepseek-chat";
  }
  async call(sys: string, user: string): Promise<string> {
    if (!this.key) throw new Error("DEEPSEEK_API_KEY 未设置");
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) throw new Error(`DeepSeek HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  }
}

/** Anthropic Claude */
class AnthropicProvider extends BaseProvider {
  readonly name = "anthropic";
  private get key() {
    return process.env.ANTHROPIC_API_KEY ?? "";
  }
  private get model() {
    return process.env.LLM_MODEL ?? "claude-sonnet-4-20250514";
  }
  async call(sys: string, user: string): Promise<string> {
    if (!this.key) throw new Error("ANTHROPIC_API_KEY 未设置");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2000,
        system: sys,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = (await r.json()) as { content?: { text?: string }[] };
    return j.content?.[0]?.text ?? "";
  }
}

/** OpenAI 兼容（含各类中转） */
class OpenAIProvider extends BaseProvider {
  readonly name = "openai";
  private get key() {
    return process.env.OPENAI_API_KEY ?? "";
  }
  private get model() {
    return process.env.LLM_MODEL ?? "gpt-4o-mini";
  }
  private get base() {
    return process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  }
  async call(sys: string, user: string): Promise<string> {
    if (!this.key) throw new Error("OPENAI_API_KEY 未设置");
    const r = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  }
}

/** Mock：不联网，用于联调流程 */
class MockProvider implements LlmProvider {
  readonly name = "mock";
  async decide(): Promise<string> {
    return JSON.stringify({
      decision: "HOLD",
      riskTier: "BASE",
      summary: "[mock] 未配置 LLM key，保守观望。配置 key 后本模块将输出真实决策。",
      intents: [
        {
          inst: "BTC-USDT-SWAP",
          action: "hold",
          reason: "[mock] 无 LLM key，默认观望",
        },
        {
          inst: "ETH-USDT-SWAP",
          action: "hold",
          reason: "[mock] 无 LLM key，默认观望",
        },
      ],
    });
  }
}

export function createLlmProvider(): LlmProvider {
  const which = (process.env.LLM_PROVIDER ?? "mock").toLowerCase();
  switch (which) {
    case "deepseek":
      return new DeepSeekProvider();
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "mock":
    default:
      return new MockProvider();
  }
}

/** 解析 LLM 输出为 Decision，失败返回 null */
export function parseDecision(jsonText: string, roundId: string): Decision | null {
  try {
    const j = JSON.parse(jsonText) as Partial<Decision>;
    if (!j.decision || !Array.isArray(j.intents)) return null;
    return {
      roundId,
      decision: j.decision,
      intents: j.intents,
      summary: j.summary ?? "",
      riskTier: j.riskTier ?? "BASE",
      needsApproval: false,
      rawText: jsonText,
    };
  } catch {
    return null;
  }
}

export { SYSTEM_PROMPT_SKELETON as SYSTEM_PROMPT };
