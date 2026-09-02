/**
 * tools/project.ts —— 本项目专属能力
 * 把已沉淀的 Skill 与运行状态包成工具，让对话里也能直接用交易侧能力。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Tool } from "./types.js";
import { PROJECT_ROOT, AGENT_ROOT, relOf } from "./paths.js";
import { isSkillEnabled } from "../store.js";

/** 调用项目 Skill（行情扫描 / 消息采集 / 双源验证 / clOrdId / 查章程） */
export const runSkillTool: Tool = {
  name: "run_skill",
  description:
    "调用本项目已沉淀的 Skill：market_scan(行情扫描)、news_fetch(消息采集)、news_verify(双源验证)、news_log(消息入库)、order_id(生成合规clOrdId)、read_charter(查交易章程)。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Skill id" },
      args: { type: "object", description: "Skill 参数对象" },
    },
    required: ["id"],
  },
  run: async (a, ctx) => {
    const id = String(a.id ?? "");
    if (!id) return { ok: false, output: "", error: "缺少 skill id" };
    if (!isSkillEnabled(id))
      return { ok: false, output: "", error: `Skill「${id}」已被界面关闭，拒绝调用。` };
    try {
      const mod: any = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "skills.js").replace(/\\/g, "/"));
      const skill = (mod.SKILLS || []).find((s: any) => s.id === id);
      if (!skill) return { ok: false, output: "", error: `未知 skill：${id}` };
      ctx.log?.(`[skill] ${id}`);
      const r = await skill.run(a.args || {});
      return {
        ok: !!r.ok,
        output: String(r.output || "").slice(0, 12_000),
        error: r.error ? String(r.error).slice(0, 800) : undefined,
      };
    } catch (e) {
      return { ok: false, output: "", error: String(e) };
    }
  },
};

/** 读账户与最近一轮决策 */
export const getStatusTool: Tool = {
  name: "get_status",
  description: "读取账户权益、持仓、最近一轮决策摘要与待人工确认项。",
  parameters: { type: "object", properties: {}, required: [] },
  run: async () => {
    const stateDir = path.join(PROJECT_ROOT, "state");
    const readJson = (p: string) => {
      try {
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
      } catch {
        return null;
      }
    };
    const runtime = readJson(path.join(stateDir, "runtime.json"));
    let latest: any = null;
    try {
      const files = fs
        .readdirSync(stateDir)
        .filter((f) => /^round_input_?R?\d*\.json$/.test(f))
        .sort();
      if (files.length) latest = readJson(path.join(stateDir, files[files.length - 1]));
    } catch {
      /* ignore */
    }
    let pending: string[] = [];
    try {
      pending = fs.readdirSync(stateDir).filter((f) => f.startsWith("PENDING_APPROVAL_"));
    } catch {
      /* ignore */
    }
    const brief = {
      equity: runtime?.equity_usdt ?? latest?.equity_usdt ?? null,
      available: runtime?.available_usdt ?? latest?.available_usdt ?? null,
      dayPnlPct: runtime?.day_pnl_pct ?? null,
      positions: (latest?.positions || []).map((p: any) => ({
        inst: p.instrument, side: p.side, size: p.size_contracts, entry: p.entry, upl: p.upl,
      })),
      lastRoundId: latest?.round_id || runtime?.last_round_id || null,
      decision: latest?.decision ? String(latest.decision).slice(0, 1500) : null,
      pendingApprovals: pending,
    };
    return { ok: true, output: JSON.stringify(brief, null, 2) };
  },
};

/** 触发一轮自主决策（默认演练，绝不直接真下单） */
export const runRoundTool: Tool = {
  name: "run_round",
  description: "触发一轮完整决策流程（collect→专家→裁决→执行→归档）。默认演练模式；真下单需显式 dryRun=false 并二次确认。",
  danger: true,
  parameters: {
    type: "object",
    properties: {
      dryRun: { type: "boolean", description: "true=演练（默认），false=真实下单" },
    },
    required: [],
  },
  run: async (a, ctx) => {
    const dry = a.dryRun !== false;
    const ok = (await ctx.confirm?.({
      id: `round:${dry}`,
      title: dry ? "跑一轮（演练）" : "⚠ 跑一轮（真实下单）",
      message: dry
        ? "将以演练模式跑一轮，不会下真实单。"
        : "将真实下单！确认账户、杠杆与风控设置无误。",
    })) ?? false;
    if (!ok) return { ok: false, output: "", error: "用户取消" };

    const isWin = process.platform === "win32";
    const tsxBin = path.join(AGENT_ROOT, "node_modules", ".bin", isWin ? "tsx.cmd" : "tsx");
    const useBin = fs.existsSync(tsxBin);
    const cmd = useBin ? tsxBin : isWin ? "npx.cmd" : "npx";
    const args = useBin
      ? [path.join("src", "main.ts"), "--once", ...(dry ? ["--dry-run"] : [])]
      : ["tsx", path.join("src", "main.ts"), "--once", ...(dry ? ["--dry-run"] : [])];

    ctx.log?.(`[round] ${dry ? "--dry-run" : "LIVE"}`);
    return new Promise((resolve) => {
      const p = spawn(cmd, args, {
        cwd: AGENT_ROOT,
        env: { ...(process.env as Record<string, string>), PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
        shell: isWin,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      p.stdout?.on("data", (d: Buffer) => {
        const s = d.toString();
        out += s;
        s.split(/\r?\n/).filter(Boolean).forEach((l) => ctx.log?.(l));
      });
      p.stderr?.on("data", (d: Buffer) => {
        out += d.toString();
      });
      const timer = setTimeout(() => {
        try {
          p.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve({ ok: false, output: out.slice(-4000), error: "执行超时（10 分钟）" });
      }, 600_000);
      p.on("exit", (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0,
          output: out.slice(-6000) || "（无输出）",
          error: code === 0 ? undefined : `退出码 ${code}`,
        });
      });
      p.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, output: "", error: e.message });
      });
    });
  },
};

/** 列出最近轮次文件，便于复盘 */
export const listRoundsTool: Tool = {
  name: "list_rounds",
  description: "列出 state/ 下最近若干轮输入文件与归档日志尾部。",
  parameters: {
    type: "object",
    properties: { limit: { type: "number", description: "条数，默认 10" } },
    required: [],
  },
  run: async (a) => {
    const limit = Math.min(50, Math.max(1, Number(a.limit) || 10));
    const stateDir = path.join(PROJECT_ROOT, "state");
    try {
      const files = fs
        .readdirSync(stateDir)
        .filter((f) => /^round_input_?R?\d*\.json$/.test(f))
        .sort()
        .slice(-limit);
      if (!files.length) return { ok: true, output: "暂无轮次文件" };
      return {
        ok: true,
        output: files.map((f) => `${relOf(path.join(stateDir, f))}  ${fs.statSync(path.join(stateDir, f)).size}B`).join("\n"),
      };
    } catch (e) {
      return { ok: false, output: "", error: String(e) };
    }
  },
};

export const projectTools: Tool[] = [getStatusTool, listRoundsTool, runSkillTool, runRoundTool];
