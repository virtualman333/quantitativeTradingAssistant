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
import { OBF_PREAMBLE, obfuscate, deobfuscate } from "./obfuscate.js";

export interface DecideOpts {
  /** 流式思考链回调：推理模型每吐一段 reasoning_content 就推一次（观测页实时用） */
  onReasoning?: (text: string) => void;
}

export interface LlmProvider {
  readonly name: string;
  readonly modelId: string;
  decide(systemPrompt: string, userPrompt: string, opts?: DecideOpts): Promise<string>;
}

/** 统一注入中文：推理模型默认可能用英文思考，加一句约束尽量让思考与回答都走中文 */
const LANG_HINT = "\n\n【语言】请全程使用简体中文进行思考与回答。";

function extractJson(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = m ? m[1] : text;
  const s = body.indexOf("{");
  const e = body.lastIndexOf("}");
  return s === -1 || e === -1 ? body : body.slice(s, e + 1);
}

/**
 * 默认 token 预算。
 * 推理模型（Hy3 等）会把预算大量消耗在思考链上：实测同一条风控 prompt，
 * max_tokens=2000 时思考链占满、正文为 0。所以默认值给得足够宽，
 * 界面里仍可按模型单独覆盖。
 */
export const DEFAULT_MAX_TOKENS = 16000;

/**
 * 只支持流式协议的网关（如 copilot.tencent.com 会返回
 * 400 / 11101 "Non-stream chat request is currently not supported"）：
 * 首次探测到后记下模型 id，后续该模型直接走流式，不再浪费一次失败请求。
 */
const streamOnlyModels = new Set<string>();

/** 判断响应是否属于「网关拒绝非流式请求」 */
function isNonStreamRejected(status: number, body: string): boolean {
  return status === 400 && /non-?stream|11101|only\s+stream|只支持流式|仅支持流式/i.test(body);
}

// ── OpenAI 兼容（覆盖 DeepSeek / OpenAI / 各类中转 / 本地 vLLM） ──
class OpenAICompatProvider implements LlmProvider {
  readonly name = "openai-compatible";
  constructor(private cfg: ModelConfig) {}
  get modelId() {
    return this.cfg.id;
  }
  /** 发一次请求，把正文、思考链、结束原因统一取回来（流式/非流式同一出口） */
  private async callOnce(
    msgs: ChatMessage[],
    maxTokens: number,
    stream: boolean,
    onReasoning?: (text: string) => void
  ): Promise<{
    ok: boolean;
    status: number;
    raw: string;
    content: string;
    reasoning: string;
    finish: string;
  }> {
    const base = (this.cfg.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      temperature: this.cfg.temperature ?? 0.2,
      max_tokens: maxTokens,
      messages: msgs,
    };
    if (stream) body.stream = true;

    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
    });

    // ── 非流式：直接解 JSON ──
    if (!stream) {
      const raw = await r.text().catch(() => "");
      if (!r.ok) return { ok: false, status: r.status, raw, content: "", reasoning: "", finish: "" };
      let content = "";
      let reasoning = "";
      let finish = "";
      try {
        const j = JSON.parse(raw) as {
          choices?: {
            message?: { content?: string; reasoning_content?: string };
            finish_reason?: string | null;
          }[];
        };
        const c = j.choices?.[0];
        content = c?.message?.content ?? "";
        reasoning = c?.message?.reasoning_content ?? "";
        if (reasoning) onReasoning?.(reasoning);
        finish = c?.finish_reason ?? "";
      } catch {
        /* 非 JSON 响应按空正文处理，交给上层报错 */
      }
      return { ok: true, status: r.status, raw, content, reasoning, finish };
    }

    // ── 流式：消费 SSE ──
    if (!r.ok || !r.body) {
      const raw = await r.text().catch(() => "");
      return { ok: false, status: r.status, raw, content: "", reasoning: "", finish: "" };
    }
    let content = "";
    let reasoning = "";
    let finish = "";
    for await (const data of sseLines(r.body)) {
      if (data === "[DONE]") break;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const ch = j?.choices?.[0];
      const d = ch?.delta || {};
      if (typeof d.content === "string") content += d.content;
      if (typeof d.reasoning_content === "string") {
        reasoning += d.reasoning_content;
        onReasoning?.(d.reasoning_content);
      }
      if (ch?.finish_reason) finish = ch.finish_reason;
    }
    return { ok: true, status: r.status, raw: "", content, reasoning, finish };
  }

  /**
   * 取一次完整结果。上层（专家/调度/主 Agent/测试连接）无需关心协议细节，
   * 这里兜住两类网关差异：
   *   1. 只吃流式的网关：非流式 400 / 11101 → 自动改走流式；
   *   2. 推理模型：思考链占用 max_tokens，正文被截断 → 自动翻倍预算重试。
   */
  async decide(sys: string, user: string, opts?: DecideOpts): Promise<string> {
    const msgs: ChatMessage[] = [
      { role: "system", content: sys + LANG_HINT },
      { role: "user", content: user },
    ];
    const budget = this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
    const onReasoning = opts?.onReasoning;

    // ① 非流式优先（更快更省）；已知只吃流式的网关直接跳过
    if (!streamOnlyModels.has(this.cfg.id)) {
      const r = await this.callOnce(msgs, budget, false, onReasoning);
      if (r.ok) {
        // 正文非空即交付；空正文只有「被预算截断」才需要重试，其余照常返回
        if (r.content || r.finish !== "length") return extractJson(r.content);
      } else if (!isNonStreamRejected(r.status, r.raw)) {
        // 非「拒绝非流式」的错误原样抛出，避免掩盖鉴权/参数等真实问题
        throw new Error(`${this.cfg.name} HTTP ${r.status}: ${r.raw.slice(0, 300)}`);
      } else {
        streamOnlyModels.add(this.cfg.id);
      }
    }

    // ② 流式；正文若仍被预算截断，翻倍再试一次
    let tokens = budget;
    let last: { reasoning: string; finish: string } = { reasoning: "", finish: "" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.callOnce(msgs, tokens, true, onReasoning);
      if (!r.ok) throw new Error(`${this.cfg.name} HTTP ${r.status}: ${r.raw.slice(0, 300)}`);
      last = r;
      if (r.content) return extractJson(r.content);
      if (r.finish !== "length") {
        throw new Error(`${this.cfg.name} 返回空正文（finish=${r.finish || "未知"}）`);
      }
      tokens *= 2;
    }
    throw new Error(
      `${this.cfg.name} 正文被 token 预算截断：max_tokens=${budget}→${tokens} 仍只产出思考过程（${last.reasoning.length} 字）。` +
        `请在「设置-模型」把该模型的 maxTokens 调大`
    );
  }
}

// ── Anthropic 原生 ──
class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  constructor(private cfg: ModelConfig) {}
  get modelId() {
    return this.cfg.id;
  }
  async decide(sys: string, user: string, _opts?: DecideOpts): Promise<string> {
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
        max_tokens: this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: this.cfg.temperature ?? 0.2,
        system: sys + LANG_HINT,
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
  async decide(sys: string, _user?: string, _opts?: DecideOpts): Promise<string> {
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

/** 按模型配置创建 provider。obfuscated=false 用于「测试连接」等无需混淆的场景。 */
export function createProvider(cfg: ModelConfig, obfuscated = true): LlmProvider {
  let p: LlmProvider;
  switch (cfg.provider) {
    case "anthropic":
      p = new AnthropicProvider(cfg);
      break;
    case "mock":
      p = new MockProvider(cfg);
      break;
    case "openai-compatible":
    default:
      p = new OpenAICompatProvider(cfg);
  }
  // mock 不发网络、无需混淆；真实 provider 统一做「发送前混淆 + 返回后还原」。
  if (!obfuscated || cfg.provider === "mock") return p;
  const inner = p.decide.bind(p);
  return {
    name: p.name,
    modelId: p.modelId,
    async decide(sys: string, user: string, opts?: DecideOpts): Promise<string> {
      // 在 system 最前面注入代号约定，并对正文做敏感标识混淆
      const raw = await inner(OBF_PREAMBLE + "\n\n" + obfuscate(sys), obfuscate(user), opts);
      return deobfuscate(raw);
    },
  };
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
  /** 推理模型（如 Hy3）的思考链：与正文分开，避免污染输出，仅用于诊断 */
  | { type: "reasoning"; text: string }
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
  signal?: AbortSignal,
  maxTokens?: number
): AsyncGenerator<ChatChunk> {
  const base = (cfg.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.3,
    max_tokens: maxTokens ?? cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
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
    // 推理模型的思考链单独成流，正文与思考不会被混在一起
    if (typeof d.reasoning_content === "string" && d.reasoning_content) {
      yield { type: "reasoning", text: d.reasoning_content };
    }
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
  signal?: AbortSignal,
  maxTokens?: number
): AsyncGenerator<ChatChunk> {
  const base = (cfg.baseURL || "https://api.anthropic.com").replace(/\/+$/, "");
  const { system, msgs } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: maxTokens ?? cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
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
  signal?: AbortSignal,
  maxTokens?: number
): AsyncGenerator<ChatChunk> {
  // 统一注入中文要求（推理模型默认可能英文思考）
  const msgs = messages.map((m) =>
    m.role === "system" ? { ...m, content: m.content + LANG_HINT } : m
  );
  if (cfg.provider === "mock") {
    yield* mockChat(msgs, tools);
    return;
  }
  if (cfg.provider === "anthropic") {
    yield* anthropicChat(cfg, msgs, tools, signal, maxTokens);
    return;
  }
  yield* openaiChat(cfg, msgs, tools, signal, maxTokens);
}

export async function testModel(cfg: ModelConfig): Promise<{
  ok: boolean;
  latencyMs: number;
  reply?: string;
  error?: string;
}> {
  const t0 = Date.now();
  try {
    const p = createProvider(cfg, false);
    const r = await p.decide("You reply with a short JSON only.", 'Reply exactly: {"ok":true}');
    return { ok: true, latencyMs: Date.now() - t0, reply: r.slice(0, 200) };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(e).slice(0, 300) };
  }
}
