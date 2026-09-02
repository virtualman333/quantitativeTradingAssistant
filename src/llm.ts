/**
 * llm.ts —— 多模型适配层
 *
 * 支持（用户需求 1、2）：
 *   1. 自定义 LLM 接口：任意 OpenAI 兼容端点（DeepSeek/OpenAI/通义/ moonshot/
 *      本地 vLLM / Ollama 中转 / 各类网关）+ Anthropic 原生 + mock
 *   2. 多模型配置并存，可在界面增删改
 *   3. 模型切换：全局默认模型、主 Agent 专用模型、每个角色单独指定模型
 *
 * 统一的 provider 接口只有 decide(system, user) => string，
 * 上层（专家/主 Agent）不关心底层是哪个厂。
 */
import type { ModelConfig } from "./store.js";

export interface LlmProvider {
  readonly name: string;
  readonly modelId: string;
  decide(systemPrompt: string, userPrompt: string): Promise<string>;
}

function extractJson(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = m ? m[1] : text;
  const s = body.indexOf("{");
  const e = body.lastIndexOf("}");
  return s === -1 || e === -1 ? body : body.slice(s, e + 1);
}

// ── OpenAI 兼容（覆盖 DeepSeek / OpenAI / 各类中转 / 本地 vLLM） ──
class OpenAICompatProvider implements LlmProvider {
  readonly name = "openai-compatible";
  constructor(private cfg: ModelConfig) {}
  get modelId() {
    return this.cfg.id;
  }
  async decide(sys: string, user: string): Promise<string> {
    const base = (this.cfg.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: this.cfg.temperature ?? 0.2,
        max_tokens: this.cfg.maxTokens ?? 2000,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`${this.cfg.name} HTTP ${r.status}: ${t.slice(0, 300)}`);
    }
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const c = j.choices?.[0]?.message?.content ?? "";
    return extractJson(c);
  }
}

// ── Anthropic 原生 ──
class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  constructor(private cfg: ModelConfig) {}
  get modelId() {
    return this.cfg.id;
  }
  async decide(sys: string, user: string): Promise<string> {
    const base = (this.cfg.baseURL || "https://api.anthropic.com").replace(/\/+$/, "");
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: this.cfg.maxTokens ?? 2000,
        temperature: this.cfg.temperature ?? 0.2,
        system: sys,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`${this.cfg.name} HTTP ${r.status}: ${t.slice(0, 300)}`);
    }
    const j = (await r.json()) as { content?: { text?: string }[] };
    return extractJson(j.content?.[0]?.text ?? "");
  }
}

// ── mock（联调，不联网） ──
class MockProvider implements LlmProvider {
  readonly name = "mock";
  constructor(private cfg: ModelConfig) {}
  get modelId() {
    return this.cfg.id;
  }
  async decide(sys: string): Promise<string> {
    if (sys.includes("调度模块")) {
      return JSON.stringify({ experts: ["trading", "factor"] });
    }
    if (sys.includes("主 Agent")) {
      return JSON.stringify({
        decision: "HOLD",
        riskTier: "BASE",
        summary: "[mock] 未配置真实模型。请在「设置-模型」添加 API Key 后切换，即可真实决策。",
        conflicts: [],
        intents: [
          { inst: "BTC-USDT-SWAP", action: "hold", reason: "[mock] 无真实模型" },
          { inst: "ETH-USDT-SWAP", action: "hold", reason: "[mock] 无真实模型" },
        ],
        needsApproval: false,
      });
    }
    return JSON.stringify({
      stance: "abstain",
      confidence: 0,
      summary: "[mock] 未配置真实模型，专家弃权",
      advice: {},
      flags: ["mock 模式"],
    });
  }
}

/** 按模型配置创建 provider */
export function createProvider(cfg: ModelConfig): LlmProvider {
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicProvider(cfg);
    case "mock":
      return new MockProvider(cfg);
    case "openai-compatible":
    default:
      return new OpenAICompatProvider(cfg);
  }
}

/**
 * 测试某个模型配置是否可用（界面「测试连接」按钮用）。
 * 返回 {ok, latencyMs, reply?, error?}
 */
export async function testModel(cfg: ModelConfig): Promise<{
  ok: boolean;
  latencyMs: number;
  reply?: string;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    const p = createProvider(cfg);
    const r = await p.decide("You reply with a short JSON only.", 'Reply exactly: {"ok":true}');
    return { ok: true, latencyMs: Date.now() - t0, reply: r.slice(0, 200) };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(e).slice(0, 300) };
  }
}
