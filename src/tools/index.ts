/**
 * tools/index.ts —— 工具注册表与执行护栏
 *
 * 护栏职责：
 *   · 未知工具 → 明确报错（不静默忽略，否则模型会反复瞎调）
 *   · 危险工具 → 必须经 ctx.confirm；没有确认通道时一律拒绝执行
 *   · 统一超时与输出截断，避免一次工具输出把上下文撑爆
 */
import type { Tool, ToolContext, ToolResult, ToolSpec } from "./types.js";
import { fsTools } from "./fs.js";
import { bashTools } from "./bash.js";
import { webTools } from "./web.js";
import { projectTools } from "./project.js";

/** 默认启用给对话的全部工具（顺序即提示词里的展示顺序） */
export const TOOLS: Tool[] = [
  ...fsTools,      // read_file / write_file / list_dir / search_files
  ...webTools,     // web_search / web_fetch
  ...projectTools, // get_status / list_rounds / run_skill / run_round
  ...bashTools,    // bash
];

export function getTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** 给界面展示的清单 */
export function toolCatalog() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    danger: !!t.danger,
    params: Object.keys(((t.parameters as any)?.properties) || {}),
  }));
}

export function specsOf(tools: Tool[] = TOOLS): ToolSpec[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

const MAX_OUTPUT = 12_000;

export async function runTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext,
  timeoutMs = 180_000
): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) {
    return { ok: false, output: "", error: `未知工具「${name}」。可用：${TOOLS.map((t) => t.name).join(", ")}` };
  }
  if (tool.danger && !ctx.confirm) {
    return { ok: false, output: "", error: `「${name}」是危险操作，当前会话没有确认通道，已拒绝执行。` };
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`工具执行超时（${timeoutMs / 1000}s）`)), timeoutMs);
    });
    const r = await Promise.race([tool.run(args || {}, ctx), guard]);
    const output = String(r.output ?? "");
    return {
      ok: !!r.ok,
      output: output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n…（输出已截断）" : output,
      error: r.error ? String(r.error).slice(0, 800) : undefined,
    };
  } catch (e) {
    if (ctx.signal?.aborted) return { ok: false, output: "", error: "已中止" };
    return { ok: false, output: "", error: String((e as Error)?.message || e).slice(0, 800) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { Tool, ToolContext, ToolResult, ToolSpec };
