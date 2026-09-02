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

export interface McpServerCfg {
  id: string;
  name: string;
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

export interface AppSettings {
  /** 默认模型（主 Agent 与各角色未单独指定时用） */
  defaultModelId: string;
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
    roles: [
      {
        id: "trading",
        name: "交易系统专家",
        duty: "负责持仓管理、开平仓判断、仓位与止损参数。",
        systemPrompt: `你是【交易系统专家】。\n基于账户状态、持仓与其他专家观点，给出具体交易执行建议。\n\n输出（advice 字段）：\n{"actions":[{"inst":"BTC-USDT-SWAP","action":"hold|long|short|close","riskPct":0.012,"slDist":712.3,"tpRR":2.0,"reason":"理由（必填）"}]}\n\n纪律：\n- 「不交易」合法但需理由。\n- 已有持仓时优先判断持有/平仓/移动止损，而非默认加仓。\n- riskPct 建议 0.5%~2.5%；超 2% 在 flags 标注需人工确认。\n- 开仓必须给 slDist。只交易 BTC-USDT-SWAP 与 ETH-USDT-SWAP。`,
        skills: ["order_id", "read_charter"],
        mcpServers: ["okx-trade-mcp"],
        enabled: true,
        createdAt: NOW(),
      },
      {
        id: "news",
        name: "新闻资讯专家",
        duty: "负责消息面：事件闸门、方向否决、关键数字交叉验证。",
        systemPrompt: `你是【新闻资讯专家】。\n评估消息面对 BTC/ETH 的影响。消息面是否决权与仓位调节器，不提供开仓信号。\n\n建议流程：1) news_fetch 采集 2) 对 high/A 级条目用 news_verify 双源验证 3) 输出结论\n\n输出（advice）：\n{"gateOpen":true,"blockingEvents":["..."],"keyNews":[{"title":"...","direction":"bullish|bearish|neutral|mixed","impact":"high|mid|low","credibility":"A|B|C","verified":true,"note":"..."}],"reactionNote":"..."}\n\n规则：\n- 关键数字须 ≥2 独立信源才标 A/verified=true；单源只能 B，无否决权，须在 flags 注明。\n- 宏观预期数据超 48 小时须重验。\n- 加息定价环境下反应函数反转：就业强=鹰派=利空加密；就业弱=利多加密。\n- 只评估美国宏观事件；加拿大/澳洲等非美事件一般不阻塞。`,
        skills: ["news_fetch", "news_verify", "news_log", "read_charter"],
        mcpServers: [],
        enabled: true,
        createdAt: NOW(),
      },
      {
        id: "factor",
        name: "因子评分专家",
        duty: "负责多周期技术因子评分与共振判断。",
        systemPrompt: `你是【因子评分专家】。\n对 BTC-USDT-SWAP / ETH-USDT-SWAP 做多周期（4H/1H/15m）技术因子评分。\n先调 market_scan 拿行情再评分。\n\n输出（advice）：\n{"scores":{"BTC-USDT-SWAP":{"total":-35.2,"perBar":{"4H":-8,"1H":-72,"15m":-48},"trend":"down|up|range","volRatio":1.255,"rangePosPct":11.2,"rr":2.0,"funding":0.0001}},"thresholdCheck":{"BTC-USDT-SWAP":{"scoreOk":true,"trendOk":true,"volOk":true,"rangeOk":true,"rrOk":true,"fundingOk":true}}}\n\n基准：|共振分|≥28 才算信号；4H50%/1H30%/15m20% 加权；4H/1H 趋势不冲突；vol_ratio≥0.8；4H 区间分位避开 38%~62%；盈亏比≥1.6；|资金费率|≤0.05%。\n只给评分与达标判断，不给买卖指令。`,
        skills: ["market_scan", "read_charter"],
        mcpServers: [],
        enabled: true,
        createdAt: NOW(),
      },
      {
        id: "risk",
        name: "风控专家",
        duty: "负责回撤、熔断、敞口与相关性风险。",
        systemPrompt: `你是【风控专家】。\n从「活下来」的角度评估当前状态，给出风险约束建议。\n\n输出（advice）：\n{"drawdown":{"day":0.0,"month":0.0},"exposureX":1.12,"circuitBreaker":false,"suggestions":["..."]}\n\n关注：当日/月度回撤、总敞口倍数、BTC/ETH 同向持仓的相关性、连亏笔数、熔断阈值。优先保证「有下一笔」。`,
        skills: ["read_charter"],
        mcpServers: ["okx-trade-mcp"],
        enabled: true,
        createdAt: NOW(),
      },
    ],
    mcpServers: [
      {
        id: "okx-trade-mcp",
        name: "OKX 交易 MCP",
        command: "okx-trade-mcp",
        args: ["--modules", "all"],
        enabled: true,
        createdAt: NOW(),
      },
    ],
    settings: {
      defaultModelId: mockId,
      intervalMin: 5,
      autoStart: true,
      dryRun: true,
      roleStrategy: "llm",
      fixedRoles: ["trading", "factor"],
      skillEnabled: {
        market_scan: true,
        news_fetch: true,
        news_verify: true,
        news_log: true,
        order_id: true,
        read_charter: true,
      },
    },
    recentRounds: [],
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
  // 原子写：先写临时文件再重命名，防写入中断导致配置损坏
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
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

/** 记录一轮到索引（详情在 logs/rounds.jsonl） */
export function pushRound(r: { roundId: string; time: string; decision: string; equity?: number }): void {
  const s = loadStore();
  s.recentRounds.unshift(r);
  s.recentRounds = s.recentRounds.slice(0, 200);
  saveStore(s);
}
