/**
 * tools/types.ts —— 工具（Tool）抽象
 *
 * 对话里的「工具」= 模型可以主动调用的一个确定性能力。
 * 与 Skill / MCP 的分工：
 *   · Tool  ：对话场景用，通用能力（读写文件、搜索、bash、抓网页）
 *   · Skill ：交易流程沉淀的确定性能力（行情扫描、消息双源验证…），也被包成 Tool 供对话调用
 *   · MCP   ：外部 server 暴露的能力，动态发现
 */
export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface ConfirmRequest {
  id: string;
  title: string;
  message: string;
}

export interface ToolContext {
  /** 中止信号（用户点「停止生成」） */
  signal?: AbortSignal;
  /** 危险操作前请求确认；无此能力时按「可执行」处理（由调用方决定是否放行） */
  confirm?(req: ConfirmRequest): Promise<boolean>;
  /** 过程日志 */
  log?(line: string): void;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema（object） */
  parameters: Record<string, unknown>;
  /** 危险工具：执行前必须经用户确认 */
  danger?: boolean;
  run(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

/** OpenAI function calling 规格（Anthropic 调用时做一次映射） */
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function toSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
