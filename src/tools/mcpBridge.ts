/**
 * mcpBridge.ts —— 把已连接的交易所 MCP server 暴露为「只读」LLM 工具
 *
 * 背景：持仓查看交给 LLM 调 MCP。但 MCP server 通常同时暴露写工具
 * （下单/撤单/调杠杆…），不能让 LLM 在「只看持仓」场景碰到写操作
 * （也违背章程 L1-3 只读）。因此这里**默认只桥接只读工具**：按工具名/描述
 * 启发式过滤写操作，写操作一律走 okx.ts 的受控通道，不走 MCP。
 *
 * 每个交易所就是 store 里的一个 MCP server（如 okx-trade-mcp / binance-mcp），
 * 它们的字段映射由各自 server 负责，本层不关心，只负责「连上 + 过滤只读 + 交给 LLM」。
 */
import { connectMcp, type McpTool } from "../mcp.js";
import type { Tool, ToolResult } from "./types.js";

/**
 * 明确的写动词前缀（命中即排除，绝不暴露给 LLM）。
 * 不设 open/close/trade：避免误杀 open_orders / trade_history 这类读工具。
 */
const WRITE_VERBS =
  /^(place|create|submit|cancel|amend|modify|edit|update|set|transfer|withdraw|deposit|convert|borrow|repay|post|put|delete|new)/i;

/** 读操作白名单关键字（命中才放行） */
const READ_HINTS =
  /(get|query|list|fetch|read|balance|account|position|portfolio|order|hold|history|funding|instrument|ticker|market|kline|price|trade|earning|asset|wallet|grid|status|info|detail|risk)/i;

/** 判断一个 MCP 工具是否为只读（仅只读才桥接给 LLM） */
export function isReadOnlyMcpTool(name: string, desc = ""): boolean {
  // 去掉 serverId 前缀（形如 okx-trade-mcp__swap_get_positions）
  const base = name.split("__").pop() ?? name;
  if (WRITE_VERBS.test(base)) return false;
  return READ_HINTS.test(base) || READ_HINTS.test(desc);
}

export interface McpReadToolSet {
  /** 包装成对话工具（名字仍为 serverId__toolName，LLM 可见） */
  tools: Tool[];
  /** 连接失败等错误 */
  errors: string[];
  /** 实际提供只读工具的交易所（server id 列表） */
  exchanges: string[];
  /** 用完必须调用以释放 MCP 连接 */
  close: () => Promise<void>;
}

/**
 * 连上所有已配置 MCP server，过滤出只读工具并包成 Tool[]。
 * 注意：不在此处关闭连接——invoke 闭包依赖仍活着的 client，
 * 调用方（portfolio 引擎）用完后负责 close。
 */
export async function loadMcpReadTools(): Promise<McpReadToolSet> {
  const conn = await connectMcp();
  const tools: Tool[] = [];
  const seen = new Set<string>();

  for (const t of conn.tools as McpTool[]) {
    if (!isReadOnlyMcpTool(t.name, t.description ?? "")) continue;
    seen.add(t.serverId);
    tools.push({
      name: t.name,
      description: `[${t.serverId}] ${t.description ?? ""}`.slice(0, 400),
      parameters: (t.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
      run: async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const out = await t.invoke(args || {});
          return {
            ok: true,
            output: typeof out === "string" ? out : JSON.stringify(out, null, 2),
          };
        } catch (e) {
          return { ok: false, output: "", error: String((e as Error)?.message ?? e) };
        }
      },
    });
  }

  return { tools, errors: conn.errors, exchanges: [...seen], close: conn.close };
}
