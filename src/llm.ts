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
// ── 对话（流式 + 工具调用）──────────────────────────────────
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export type ChatChunk =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "done"; finishReason: string | null; usage?: unknown }
  | { type: "error"; message: string };

/** 把 SSE 字节流按行切出 data: 段 */
async function* sseLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

async function* openaiChat(
  cfg: ModelConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal
): AsyncGenerator<ChatChunk> {
  const base = (cfg.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.3,
    max_tokens: cfg.maxTokens ?? 3000,
    stream: true,
  };
  if (tools.length) body.tools = tools;

  let r: Response;
  try {
    r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", message: `网络错误：${String(e)}` };
    return;
  }
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => "");
    yield { type: "error", message: `${cfg.name} HTTP ${r.status}: ${t.slice(0, 400)}` };
    return;
  }

  // 工具调用是按 index 分片的，需累积
  const calls: Record<number, { id: string; name: string; args: string }> = {};
  let finishReason: string | null = null;

  for await (const data of sseLines(r.body, signal)) {
    if (data === "[DONE]") break;
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = j?.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (typeof d.content === "string" && d.content) yield { type: "delta", text: d.content };
    for (const tc of d.tool_calls || []) {
      const idx = tc.index ?? 0;
      const cur = calls[idx] ?? (calls[idx] = { id: "", name: "", args: "" });
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const list = Object.values(calls).filter((c) => c.name);
  if (list.length) {
    yield {
      type: "tool_calls",
      calls: list.map((c, i) => ({
        id: c.id || `call_${i}_${Date.now()}`,
        type: "function" as const,
        function: { name: c.name, arguments: c.args || "{}" },
      })),
    };
  }
  yield { type: "done", finishReason };
}

/** Anthropic 的 messages 需要 content block 形式，这里做一次转换 */
function toAnthropicMessages(messages: ChatMessage[]): { system: string; msgs: any[] } {
  let system = "";
  const msgs: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + m.content;
      continue;
    }
    if (m.role === "tool") {
      msgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      msgs.push({ role: "assistant", content: blocks });
      continue;
    }
    msgs.push({ role: m.role, content: m.content });
  }
  return { system, msgs };
}

async function* anthropicChat(
  cfg: ModelConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal
): AsyncGenerator<ChatChunk> {
  const base = (cfg.baseURL || "https://api.anthropic.com").replace(/\/+$/, "");
  const { system, msgs } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: cfg.maxTokens ?? 3000,
    temperature: cfg.temperature ?? 0.3,
    system,
    messages: msgs,
    stream: true,
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  let r: Response;
  try {
    r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", message: `网络错误：${String(e)}` };
    return;
  }
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => "");
    yield { type: "error", message: `${cfg.name} HTTP ${r.status}: ${t.slice(0, 400)}` };
    return;
  }

  const blocks: Record<number, { type: string; id?: string; name?: string; text: string; json: string }> = {};
  let finishReason: string | null = null;

  for await (const data of sseLines(r.body, signal)) {
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    switch (j.type) {
      case "content_block_start": {
        const b = j.content_block || {};
        blocks[j.index] = { type: b.type, id: b.id, name: b.name, text: b.text || "", json: "" };
        break;
      }
      case "content_block_delta": {
        const b = blocks[j.index] ?? (blocks[j.index] = { type: "text", text: "", json: "" });
        if (j.delta?.type === "text_delta") {
          b.text += j.delta.text || "";
          yield { type: "delta", text: j.delta.text || "" };
        } else if (j.delta?.type === "input_json_delta") {
          b.json += j.delta.partial_json || "";
        }
        break;
      }
      case "message_delta":
        if (j.delta?.stop_reason) finishReason = j.delta.stop_reason;
        break;
      case "error":
        yield { type: "error", message: String(j.error?.message || "Anthropic 流错误") };
        break;
      default:
        break;
    }
  }

  const list = Object.values(blocks).filter((b) => b.type === "tool_use" && b.name);
  if (list.length) {
    yield {
      type: "tool_calls",
      calls: list.map((b, i) => ({
        id: b.id || `toolu_${i}_${Date.now()}`,
        type: "function" as const,
        // Anthropic 的 input 是对象，转回 OpenAI 风格的字符串参数
        function: { name: b.name as string, arguments: b.json || "{}" },
      })),
    };
  }
  yield { type: "done", finishReason };
}

async function* mockChat(messages: ChatMessage[], tools: ToolSpec[]): AsyncGenerator<ChatChunk> {
  const last = [...messages].reverse().find((m) => m.role === "user");
  const hasTools = tools.length > 0;
  const text = [
    "（mock 模型，不会真实调用）",
    "",
    `收到：${String(last?.content ?? "").slice(0, 200)}`,
    "",
    hasTools
      ? `当前已挂载 ${tools.length} 个工具：${tools.map((t) => t.function.name).join("、")}。\n切换到真实模型（模型页添加 API Key 并设为默认）后，我就能真正调用它们。`
      : "当前没有可用工具。",
  ].join("\n");
  for (const part of text.match(/[\s\S]{1,12}/g) || []) {
    yield { type: "delta", text: part };
  }
  yield { type: "done", finishReason: "stop" };
}

/**
 * 统一对话入口：流式产出文本增量，需要工具时产出 tool_calls。
 * 不抛异常：错误以 chunk 形式返回，调用方决定如何展示。
 */
export async function* streamChat(
  cfg: ModelConfig,
  messages: ChatMessage[],
  tools: ToolSpec[] = [],
  signal?: AbortSignal
): AsyncGenerator<ChatChunk> {
  if (cfg.provider === "mock") {
    yield* mockChat(messages, tools);
    return;
  }
  if (cfg.provider === "anthropic") {
    yield* anthropicChat(cfg, messages, tools, signal);
    return;
  }
  yield* openaiChat(cfg, messages, tools, signal);
}

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
