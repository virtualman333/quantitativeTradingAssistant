/**
 * mcp.ts —— MCP（Model Context Protocol）客户端
 *
 * 作用：让专家能真正「动手」，而不只是输出观点。
 *
 * Windows 关键坑（实测）：
 *   npm 全局安装的 okx-trade-mcp 实际是 PowerShell 垫片（.ps1），
 *   直接 spawn 会报 "%1 is not a valid Win32 application"。
 *   必须用 cmd /c 包装。StdioClientTransport 内部直接 spawn，
 *   所以这里用 command="cmd"、args=["/c", "<原命令>", ...原参数]。
 *
 * 配置来源：项目根 .mcp.json（与 Claude Code / DSH 共用同一份配置）
 */
import fs from "node:fs";
import path from "node:path";
import { listMcpServers, AGENT_ROOT } from "./store.js";

export const ROOT = AGENT_ROOT;

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Windows 下是否用 cmd /c 包装（npm 全局 .ps1/.cmd 垫片必须） */
  windowsCmdWrap?: boolean;
  /** HTTP 型 MCP（Streamable HTTP，如金十）。有 url 则优先用 HTTP transport */
  url?: string;
  /** HTTP 鉴权头，如 {"Authorization": "Bearer xxx"} */
  headers?: Record<string, string>;
}

/**
 * 读取 MCP 配置。
 * 优先级：store（界面可管理，持久化）> 项目根 .mcp.json（兼容既有配置）
 */
export function loadMcpConfig(): Record<string, McpServerConfig> {
  // 1) store（界面管理的）
  try {
    const list = listMcpServers().filter((s) => s.enabled);
    if (list.length) {
      const out: Record<string, McpServerConfig> = {};
      for (const s of list) {
        out[s.id] = {
          command: s.command ?? "",
          args: s.args,
          env: s.env,
          url: s.url,
          headers: s.headers,
          windowsCmdWrap: s.windowsCmdWrap,
        };
      }
      return out;
    }
  } catch {
    /* store 不可用则回退 */
  }

  // 2) 项目根 .mcp.json
  const p = path.join(ROOT, ".mcp.json");
  if (!fs.existsSync(p)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
    return j.mcpServers ?? {};
  } catch {
    return {};
  }
}

/**
 * 把配置转成 StdioClientTransport 参数。
 * Windows 垫片处理：command 是 .ps1/.cmd 或不在 PATH 的可执行文件时，用 cmd /c 包装。
 */
export function toTransportParams(cfg: McpServerConfig) {
  const isWin = process.platform === "win32";
  // 显式指定时以显式为准；否则在 Windows 上自动识别 .ps1/.cmd/.bat 垫片
  let needWrap: boolean;
  if (cfg.windowsCmdWrap === true) needWrap = true;
  else if (cfg.windowsCmdWrap === false) needWrap = false;
  else
    needWrap =
      isWin &&
      (/\.ps1$|\.cmd$|\.bat$/i.test(cfg.command) ||
        cfg.command === "okx-trade-mcp" ||
        /^npx(\.cmd)?$/i.test(cfg.command));

  if (needWrap) {
    return {
      command: "cmd",
      args: ["/c", cfg.command, ...(cfg.args ?? [])],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
    };
  }
  return {
    command: cfg.command,
    args: cfg.args ?? [],
    env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
  };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** 调用该工具 */
  invoke(args: Record<string, unknown>): Promise<unknown>;
  serverId: string;
}

/**
 * 连接所有已配置的 MCP server，拉取工具列表。
 *
 * 设计取舍：**只读工具才真正连 server 并调用；写操作一律走 okx.ts 的受控通道**
 * （mcp_call.py + --allow-write + demo）。
 * 理由：写操作必须过确定的审计与降级路径，不能让 LLM 直接碰到。
 */
export async function connectMcp(
  serverIds?: string[]
): Promise<{ tools: McpTool[]; errors: string[]; close: () => Promise<void> }> {
  const cfg = loadMcpConfig();
  const ids = serverIds?.length ? serverIds : Object.keys(cfg);
  const tools: McpTool[] = [];
  const errors: string[] = [];
  const clients: { close: () => Promise<void> }[] = [];

  // 动态 import，避免未安装依赖时整体崩溃
  let Client: any, StdioClientTransport: any, StreamableHTTPClientTransport: any;
  try {
    const m: any = await import("@modelcontextprotocol/sdk/client/index.js");
    const t: any = await import("@modelcontextprotocol/sdk/client/stdio.js");
    let h: any = null;
    try {
      h = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    } catch {
      /* SDK 版本可能没有 HTTP transport */
    }
    Client = m.Client;
    StdioClientTransport = t.StdioClientTransport;
    StreamableHTTPClientTransport = h?.StreamableHTTPClientTransport;
  } catch (e) {
    errors.push(`MCP SDK 未安装: ${String(e).slice(0, 150)}（执行 pnpm add @modelcontextprotocol/sdk）`);
    return { tools, errors, close: async () => {} };
  }

  for (const id of ids) {
    const c = cfg[id];
    if (!c) {
      errors.push(`未配置 server: ${id}`);
      continue;
    }
    try {
      const client = new Client({ name: "okx-trader-agent", version: "0.1.0" }, { capabilities: {} });

      if (c.url) {
        // HTTP 型（Streamable HTTP，如金十）
        if (!StreamableHTTPClientTransport) {
          errors.push(`${id}: SDK 不支持 StreamableHTTP transport`);
          continue;
        }
        const transport = new StreamableHTTPClientTransport(new URL(c.url), {
          requestInit: { headers: { ...(c.headers ?? {}) } },
        });
        await client.connect(transport);
      } else {
        // stdio 型（如 okx-trade-mcp）
        const params = toTransportParams(c);
        const transport = new StdioClientTransport(params);
        await client.connect(transport);
      }
      const list = await client.listTools();
      for (const t of list.tools ?? []) {
        const name = t.name;
        tools.push({
          name: `${id}__${name}`,
          serverId: id,
          description: t.description,
          inputSchema: t.inputSchema,
          invoke: (a: Record<string, unknown>) =>
            client.callTool({ name, arguments: a }) as Promise<unknown>,
        });
      }
      clients.push({ close: () => client.close() });
    } catch (e) {
      errors.push(`连接 ${id} 失败: ${String(e).slice(0, 200)}`);
    }
  }

  return {
    tools,
    errors,
    close: async () => {
      for (const c of clients) {
        try {
          await c.close();
        } catch {
          /* 忽略关闭失败 */
        }
      }
    },
  };
}

/** 给专家 prompt 用的 MCP 工具清单（按 server 分组，截断防 prompt 爆炸） */
export function mcpCatalog(tools: McpTool[], max = 60): string {
  if (!tools.length) return "（无可用 MCP 工具）";
  const byServer = new Map<string, string[]>();
  for (const t of tools) {
    if (!byServer.has(t.serverId)) byServer.set(t.serverId, []);
    const d = (t.description ?? "").replace(/\s+/g, " ").slice(0, 80);
    byServer.get(t.serverId)!.push(`  · ${t.name} — ${d}`);
  }
  const lines: string[] = [];
  for (const [sid, ts] of byServer) {
    lines.push(`【${sid}】`);
    lines.push(...ts.slice(0, max));
  }
  return lines.join("\n");
}
