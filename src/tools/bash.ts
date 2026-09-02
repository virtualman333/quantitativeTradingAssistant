/**
 * tools/bash.ts —— 命令执行
 *
 * 这是最危险的工具，三层约束：
 *   1. 危险命令黑名单（删盘/格式化/关机/管道执行远程脚本等）直接拒绝
 *   2. 工作目录强制限制在仓库根内
 *   3. 执行前必须经用户确认（ctx.confirm），超时 60s，输出截断
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./types.js";
import { resolveSafe, relOf, PROJECT_ROOT, IS_WIN } from "./paths.js";

const execAsync = promisify(exec);

const DENY: { re: RegExp; why: string }[] = [
  { re: /rm\s+-rf\s+(\/|~|\*|\.|\.\.)(\s|$)/i, why: "禁止递归删除根目录/家目录" },
  { re: /rmdir\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i, why: "禁止递归删除盘符根目录" },
  { re: /del\s+\/f\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i, why: "禁止强制删除盘符根目录" },
  { re: /mkfs|diskpart|format\s+[a-z]:/i, why: "禁止磁盘格式化" },
  { re: /shutdown|restart-computer|stop-computer/i, why: "禁止关机重启" },
  { re: /:\(\)\s*\{/i, why: "禁止 fork 炸弹" },
  { re: /(curl|wget|iwr)\b[^\n]*\|\s*(ba)?sh|Invoke-Expression/i, why: "禁止下载即执行" },
  { re: /reg\s+delete/i, why: "禁止删除注册表" },
  { re: />\s*\/dev\/sda/i, why: "禁止写块设备" },
  { re: /git\s+push\s+(-f|--force)/i, why: "禁止强制推送" },
  { re: /git\s+clean\s+-[fdx]{1,3}/i, why: "git clean 会删未跟踪文件，请在终端自行执行" },
];

function denyReason(cmd: string): string | null {
  for (const d of DENY) if (d.re.test(cmd)) return d.why;
  return null;
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "在仓库根目录内执行命令（git/node/pnpm/python/查看文件等）。危险命令被禁用，执行前需用户确认。",
  danger: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      cwd: { type: "string", description: "工作目录，默认仓库根" },
      timeoutMs: { type: "number", description: "超时毫秒，默认 60000，上限 300000" },
    },
    required: ["command"],
  },
  run: async (a, ctx) => {
    const command = String(a.command ?? "").trim();
    if (!command) return { ok: false, output: "", error: "命令为空" };

    const denied = denyReason(command);
    if (denied) return { ok: false, output: "", error: `已阻止：${denied}` };

    const cwd = a.cwd ? resolveSafe(a.cwd, { allowDir: true, mustExist: true }) : PROJECT_ROOT;
    const timeoutMs = Math.min(300_000, Math.max(1000, Number(a.timeoutMs) || 60_000));

    const ok = (await ctx.confirm?.({
      id: `bash:${command}`,
      title: "执行命令",
      message: `目录：${relOf(cwd)}\n命令：${command}`,
    })) ?? false;
    if (!ok) return { ok: false, output: "", error: "用户取消执行" };

    const shell = IS_WIN ? process.env.COMSPEC || "cmd.exe" : "/bin/bash";
    const line = IS_WIN ? `"${shell}" /d /s /c ${command}` : `${shell} -lc ${JSON.stringify(command)}`;
    ctx.log?.(`[bash] ${relOf(cwd)} $ ${command}`);

    try {
      const r = await execAsync(line, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      const out = `${r.stdout || ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim();
      const shown = out.length > 20_000 ? out.slice(0, 20_000) + "\n…（输出已截断）" : out;
      return { ok: true, output: shown || "（无输出）" };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      const body = `${err.stdout || ""}${err.stderr ? `\n[stderr]\n${err.stderr}` : ""}`.trim();
      const msg = err.killed ? `超时（${timeoutMs}ms）` : err.message || "执行失败";
      const shown = body.length > 20_000 ? body.slice(0, 20_000) + "\n…（输出已截断）" : body;
      return { ok: false, output: shown, error: `${msg}` };
    }
  },
};

export const bashTools: Tool[] = [bashTool];
