/**
 * store.ts —— 本地持久化层
 *
 * 存什么：多模型配置、多角色（专家）定义、Skill 开关、MCP server 配置、
 *        运行参数、轮次历史索引。
 *
 * 为什么用 JSON 而不是 SQLite：
 *   本规模（几十条配置 + 历史索引）JSON 完全够用，且**零 native 编译风险**
 *   （better-sqlite3 在 Windows 需 build tools，失败成本高）。
 *   真正的逐笔成交/归档仍走项目既有的 logs/rounds.jsonl（只追加，L1-7）。
 *
 * 文件位置：agent/data/store.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_ROOT = (() => {
  let d = __dirname;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(d, "package.json")) && fs.existsSync(path.join(d, "src"))) return d;
    d = path.dirname(d);
  }
  return path.resolve(__dirname, "..", "..");
})();

const DATA_DIR = path.join(AGENT_ROOT, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

// ── 类型 ────────────────────────────────────────────────────
export interface ModelConfig {
  id: string;
  name: string;
  /** openai 兼容协议即可（DeepSeek/OpenAI/通义/本地 vLLM/Ollama 中转 等） */
  provider: "openai-compatible" | "anthropic" | "mock";
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 备注（如"便宜，用于专家；贵，用于主Agent"） */
  note?: string;
  enabled: boolean;
  createdAt: string;
}

export interface RoleConfig {
  id: string;
  name: string;
  duty: string;
  systemPrompt: string;
  /** 可调用的 skill id 列表 */
  skills: string[];
  /** 可使用的 MCP server id 列表 */
  mcpServers: string[];
  /** 是否参与编排（false = 保留但不召唤） */
  enabled: boolean;
  /** 该角色用的模型 id；空 = 用全局默认模型 */
  modelId?: string;
  createdAt: string;
}

/** MCP 业务类型：exchange=交易所（提供账户/持仓/下单）；data=数据源（新闻/链上/行情）；tool=通用工具；other=其他 */
export type McpKind = "exchange" | "data" | "tool" | "other";

export interface McpServerCfg {
  id: string;
  name: string;
  /** 业务类型，见 McpKind。缺省视为 exchange（兼容旧配置） */
  kind?: McpKind;
  /** stdio 型 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP 型（Streamable HTTP），有 url 优先 */
  url?: string;
  headers?: Record<string, string>;
  windowsCmdWrap?: boolean;
  enabled: boolean;
  createdAt: string;
}

/** 对话里的一次工具调用记录（界面展示用） */
export interface ChatCallRecord {
  name: string;
  args: unknown;
  ok: boolean;
  output: string;
  error?: string;
}

/** 持久化的一轮对话（system 不存，每次运行重新生成） */
export interface ChatTurn {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  calls?: ChatCallRecord[];
  ts?: string;
}

export interface AppSettings {
  /** 默认模型（主 Agent 与各角色未单独指定时用） */
  defaultModelId: string;
  /** 对话页专用模型，空=用默认模型 */
  chatModelId?: string;
  /** 危险工具（写文件/执行命令）是否必须弹窗确认，默认 true */
  requireToolConfirm?: boolean;
  /** 主 Agent 拍板专用模型，空=用 defaultModelId */
  mainAgentModelId?: string;
  intervalMin: number;
  autoStart: boolean;
  dryRun: boolean;
  /** 角色选择策略：llm=主Agent自决；fixed=固定用下列角色 */
  roleStrategy: "llm" | "fixed";
  fixedRoles: string[];
  /** Skill 启用表：skillId -> enabled */
  skillEnabled: Record<string, boolean>;
}

export interface StoreData {
  version: number;
  models: ModelConfig[];
  roles: RoleConfig[];
  mcpServers: McpServerCfg[];
  settings: AppSettings;
  /** 最近轮次索引（详情仍存 logs/rounds.jsonl） */
  recentRounds: { roundId: string; time: string; decision: string; equity?: number }[];
  /** 对话历史（界面「对话」页） */
  chat: { history: ChatTurn[] };
}

// ── 默认值 ──────────────────────────────────────────────────
const NOW = () => new Date().toISOString();

function defaults(): StoreData {
  const mockId = "model_mock";
  return {
    version: 1,
    models: [
      {
        id: mockId,
        name: "mock（联调，不联网）",
        provider: "mock",
        baseURL: "",
        apiKey: "",
        model: "mock",
        enabled: true,
        note: "本地模拟，用于验证链路，不消耗 token",
        createdAt: NOW(),
      },
    ],
    // 专家定义已外置到 experts/*.json（可插拔），roles 仅作运行时覆盖层（界面编辑），默认空
    roles: [],
    mcpServers: [
      {
        id: "okx-trade-mcp",
        name: "OKX 交易 MCP",
        kind: "exchange",
        command: "okx-trade-mcp",
        args: ["--modules", "all"],
        enabled: true,
        createdAt: NOW(),
      },
    ],
    settings: {
      defaultModelId: mockId,
      chatModelId: undefined,
      requireToolConfirm: true,
      intervalMin: 5,
      autoStart: true,
      dryRun: false,
      roleStrategy: "llm",
      fixedRoles: ["trading", "news", "factor", "risk", "funding", "onchain", "sentiment", "execution"],
      skillEnabled: {
        market_scan: true,
        news_fetch: true,
        news_verify: true,
        news_log: true,
        polymarket_sentiment: true,
        order_id: true,
        read_charter: true,
      },
    },
    recentRounds: [],
    chat: { history: [] },
  };
}

// ── 读写 ────────────────────────────────────────────────────
let cache: StoreData | null = null;

export function loadStore(): StoreData {
  if (cache) return cache;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as StoreData;
      // 与默认值合并，防止旧版本缺字段
      const d = defaults();
      cache = {
        ...d,
        ...raw,
        settings: { ...d.settings, ...(raw.settings ?? {}) },
        models: raw.models?.length ? raw.models : d.models,
        roles: raw.roles?.length ? raw.roles : d.roles,
        mcpServers: raw.mcpServers?.length ? raw.mcpServers : d.mcpServers,
        chat: { history: Array.isArray(raw.chat?.history) ? raw.chat.history.slice(-200) : [] },
      };
      return cache;
    }
  } catch {
    /* 损坏则用默认 */
  }
  cache = defaults();
  saveStore(cache);
  return cache;
}

export function saveStore(data?: StoreData): void {
  const d = data ?? cache ?? defaults();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const json = JSON.stringify(d, null, 2);
  // 原子写：先写临时文件再重命名，防写入中断导致配置损坏。
  // 但 Windows 下 rename 覆盖已存在文件时，若目标文件正被其他进程打开（哪怕只读），
  // 会报 EPERM（实测复现）；此时退回直接写，writeFileSync 覆盖只读打开的文件没问题。
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, json, "utf8");
  try {
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EEXIST" || code === "EBUSY" || code === "EACCES") {
      fs.writeFileSync(STORE_PATH, json, "utf8");
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    } else {
      throw e;
    }
  }
  cache = d;
}

export function resetStore(): StoreData {
  cache = defaults();
  saveStore(cache);
  return cache;
}

// ── 便捷读写 ────────────────────────────────────────────────
export function getSettings(): AppSettings {
  return loadStore().settings;
}
export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const s = loadStore();
  s.settings = { ...s.settings, ...patch };
  saveStore(s);
  return s.settings;
}

export function listModels(): ModelConfig[] {
  return loadStore().models;
}
export function getModel(id: string): ModelConfig | undefined {
  return loadStore().models.find((m) => m.id === id);
}
/** 取实际使用模型：优先角色/主Agent指定，否则默认 */
export function resolveModel(roleModelId?: string, mainAgent = false): ModelConfig {
  const s = loadStore();
  const pick = mainAgent ? s.settings.mainAgentModelId : roleModelId;
  return s.models.find((m) => m.id === pick && m.enabled) ??
    s.models.find((m) => m.id === s.settings.defaultModelId) ??
    s.models[0];
}
export function upsertModel(m: ModelConfig): ModelConfig {
  const s = loadStore();
  const i = s.models.findIndex((x) => x.id === m.id);
  if (i >= 0) s.models[i] = { ...s.models[i], ...m };
  else s.models.push(m);
  saveStore(s);
  return m;
}
export function deleteModel(id: string): boolean {
  const s = loadStore();
  const before = s.models.length;
  s.models = s.models.filter((m) => m.id !== id);
  // 若删的是默认模型，回退到第一个
  if (s.settings.defaultModelId === id) s.settings.defaultModelId = s.models[0]?.id ?? "";
  if (s.settings.mainAgentModelId === id) s.settings.mainAgentModelId = undefined;
  s.roles.forEach((r) => { if (r.modelId === id) r.modelId = undefined; });
  saveStore(s);
  return s.models.length < before;
}

export function listRoles(): RoleConfig[] {
  return loadStore().roles;
}
export function getRole(id: string): RoleConfig | undefined {
  return loadStore().roles.find((r) => r.id === id);
}
export function upsertRole(r: RoleConfig): RoleConfig {
  const s = loadStore();
  const i = s.roles.findIndex((x) => x.id === r.id);
  if (i >= 0) s.roles[i] = { ...s.roles[i], ...r };
  else s.roles.push(r);
  saveStore(s);
  return r;
}
export function deleteRole(id: string): boolean {
  const s = loadStore();
  const before = s.roles.length;
  s.roles = s.roles.filter((r) => r.id !== id);
  s.settings.fixedRoles = s.settings.fixedRoles.filter((x) => x !== id);
  saveStore(s);
  return s.roles.length < before;
}

export function listMcpServers(): McpServerCfg[] {
  return loadStore().mcpServers;
}
export function upsertMcpServer(c: McpServerCfg): McpServerCfg {
  const s = loadStore();
  const i = s.mcpServers.findIndex((x) => x.id === c.id);
  if (i >= 0) s.mcpServers[i] = { ...s.mcpServers[i], ...c };
  else s.mcpServers.push(c);
  saveStore(s);
  return c;
}
export function deleteMcpServer(id: string): boolean {
  const s = loadStore();
  const before = s.mcpServers.length;
  s.mcpServers = s.mcpServers.filter((m) => m.id !== id);
  s.roles.forEach((r) => { r.mcpServers = r.mcpServers.filter((x) => x !== id); });
  saveStore(s);
  return s.mcpServers.length < before;
}

export function setSkillEnabled(skillId: string, enabled: boolean): void {
  const s = loadStore();
  s.settings.skillEnabled[skillId] = enabled;
  saveStore(s);
}

/** Skill 是否启用：未在表中或显式为 true 均视为启用（默认开） */
export function isSkillEnabled(skillId: string): boolean {
  const map = loadStore().settings.skillEnabled ?? {};
  return map[skillId] !== false;
}

// ── 对话历史 ────────────────────────────────────────────────
const CHAT_KEEP = 200;

export function getChatHistory(): ChatTurn[] {
  return loadStore().chat?.history ?? [];
}

/** 保存对话历史（只留最近 CHAT_KEEP 条，丢弃 system 以便每次重算系统提示） */
export function saveChatHistory(list: ChatTurn[]): void {
  const s = loadStore();
  s.chat = { history: (list || []).filter((m) => m.role !== "system").slice(-CHAT_KEEP) };
  saveStore(s);
}

export function clearChatHistory(): void {
  const s = loadStore();
  s.chat = { history: [] };
  saveStore(s);
}

/** 记录一轮到索引（详情在 logs/rounds.jsonl） */
export function pushRound(r: { roundId: string; time: string; decision: string; equity?: number }): void {
  const s = loadStore();
  s.recentRounds.unshift(r);
  s.recentRounds = s.recentRounds.slice(0, 200);
  saveStore(s);
}
