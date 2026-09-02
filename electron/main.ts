/**
 * electron/main.ts —— 主进程
 *
 * 最傻瓜化：双击图标 → 自动拉起 agent 服务 → 界面直接可用。
 *
 * 职责：
 *   1. 启动/停止 agent 子进程，转发日志
 *   2. 暴露 store（模型/角色/MCP/Skill/设置）的完整增删改查给界面
 *   3. 读取账户与最近决策供展示
 */
import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

// 本文件编译为 ESM（preload 才需要 CJS），因此没有内置 __dirname，自行推导。
// ESM 是关键：主进程要用 `await import("file://...")` 加载 dist/src 下的模块，
// CJS 的 require 解析不了 file:// URL（会报 Cannot find module）。
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 定位项目根：向上找含 package.json + src 的目录（兼容开发与编译两种位置） */
function findAgentRoot(): string {
  let d = HERE;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(d, "package.json")) && fs.existsSync(path.join(d, "src"))) return d;
    d = path.dirname(d);
  }
  return path.resolve(HERE, "..", "..");
}
const AGENT_ROOT = findAgentRoot();
const PROJECT_ROOT = path.resolve(AGENT_ROOT, "..");

// 动态导入 store（编译后路径为 dist/src/store.js）
const storePath = path.join(AGENT_ROOT, "dist", "src", "store.js");
const srcStorePath = path.join(AGENT_ROOT, "src", "store.ts");

let win: BrowserWindow | null = null;
let agentProc: ChildProcess | null = null;
let logBuffer: string[] = [];

// ── store 桥接（优先用编译产物，其次 tsx 运行时） ──────────────
async function withStore<T>(fn: (s: any) => T): Promise<T> {
  if (fs.existsSync(storePath)) {
    const mod = await import("file://" + storePath.replace(/\\/g, "/"));
    return fn(mod);
  }
  // 开发态：用 tsx 执行一次性脚本读写（避免主进程直接 import TS）
  throw new Error("请先执行 npm run build 生成 dist/src/store.js");
}

// ── 日志 ────────────────────────────────────────────────────
function pushLog(line: string) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const full = `[${ts}] ${line}`;
  logBuffer.push(full);
  if (logBuffer.length > 2000) logBuffer = logBuffer.slice(-2000);
  win?.webContents.send("agent:log", full);
  console.log(full);
}

// ── agent 子进程 ────────────────────────────────────────────
function spawnAgent(extraArgs: string[], onExit?: (code: number | null) => void) {
  const isWin = process.platform === "win32";
  const tsxBin = path.join(AGENT_ROOT, "node_modules", ".bin", isWin ? "tsx.cmd" : "tsx");
  const useBin = fs.existsSync(tsxBin);
  const cmd = useBin ? tsxBin : isWin ? "npx.cmd" : "npx";
  const args = useBin
    ? [path.join("src", "main.ts"), ...extraArgs]
    : ["tsx", path.join("src", "main.ts"), ...extraArgs];

  pushLog(`启动: ${path.basename(cmd)} ${args.join(" ")}`);
  return spawn(cmd, args, {
    cwd: AGENT_ROOT,
    env: { ...(process.env as Record<string, string>), PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
    shell: isWin, // Windows .cmd 垫片必须 shell:true，否则 EINVAL（实测踩过）
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 调试用：OKX_AUTOSTART=0 时即使设置里开着也不自动拉起 agent（避免排查界面时触发真实轮次） */
function autoStartEnabled(): boolean {
  if (process.env.OKX_AUTOSTART === "0") return false;
  try {
    return !!loadSettingsSync()?.autoStart;
  } catch {
    return false;
  }
}

function startAgent() {
  if (agentProc) return { ok: false, msg: "已在运行" };
  const st = loadSettingsSync();
  // 演练模式必须作为 --dry-run 传给子进程，否则只是打印一行日志、实际仍会下单
  const dry = st?.dryRun !== false;
  if (dry) pushLog("演练模式开启：不会下真实单");

  agentProc = spawnAgent(dry ? ["--dry-run"] : []);
  agentProc.stdout?.on("data", (d: Buffer) =>
    d.toString().split(/\r?\n/).filter(Boolean).forEach(pushLog)
  );
  agentProc.stderr?.on("data", (d: Buffer) =>
    d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => pushLog(`[stderr] ${l}`))
  );
  agentProc.on("exit", (code) => {
    pushLog(`服务退出 code=${code}`);
    agentProc = null;
    win?.webContents.send("agent:status", { running: false });
  });
  agentProc.on("error", (e) => {
    pushLog(`服务启动失败: ${e.message}`);
    agentProc = null;
    win?.webContents.send("agent:status", { running: false });
  });
  win?.webContents.send("agent:status", { running: true });
  return { ok: true, msg: "已启动" };
}

function stopAgent() {
  if (!agentProc) return { ok: false, msg: "未运行" };
  agentProc.kill("SIGTERM");
  agentProc = null;
  pushLog("已停止服务");
  win?.webContents.send("agent:status", { running: false });
  return { ok: true, msg: "已停止" };
}

/** 同步读设置（用于启动前判断 dryRun 等，避免异步竞态） */
function loadSettingsSync(): { dryRun: boolean; intervalMin: number; autoStart: boolean } | null {
  try {
    const p = path.join(AGENT_ROOT, "data", "store.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      return j.settings ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ── 状态读取 ────────────────────────────────────────────────
function readJsonSafe(p: string): any {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* ignore */
  }
  return null;
}

async function getStatus() {
  const stateDir = path.join(PROJECT_ROOT, "state");
  const runtime = readJsonSafe(path.join(stateDir, "runtime.json"));

  let latestRound: any = null;
  try {
    const files = fs.readdirSync(stateDir).filter((f) => /^round_input_?R?\d*\.json$/.test(f)).sort();
    if (files.length) latestRound = readJsonSafe(path.join(stateDir, files[files.length - 1]));
  } catch {
    /* ignore */
  }

  let pending: string[] = [];
  try {
    pending = fs.readdirSync(stateDir).filter((f) => f.startsWith("PENDING_APPROVAL_")).sort();
  } catch {
    /* ignore */
  }

  return { runtime, latestRound, pending, agentRunning: !!agentProc };
}

// ── 窗口 ────────────────────────────────────────────────────
/**
 * preload 只认 .js：
 *  - `electron .` 时 __dirname=dist/electron，旁边就有 preload.js
 *  - `tsx electron/main.ts` 时 __dirname=electron（只有 preload.ts），
 *    此时回退到 dist/electron/preload.js，否则界面拿不到 window.api，
 *    所有操作都会静默失败（表现为「保存没反应」）。
 */
function resolvePreload(): string {
  const cands = [
    path.join(HERE, "preload.js"),
    path.join(AGENT_ROOT, "dist", "preload", "preload.js"),
  ];
  return cands.find((p) => fs.existsSync(p)) ?? path.join(AGENT_ROOT, "dist", "preload", "preload.js");
}

function createWindow() {
  const preload = resolvePreload();
  if (!fs.existsSync(preload)) {
    pushLog(`❌ 找不到 preload: ${preload}（请先 npm run build）`);
  }
  win = new BrowserWindow({
    width: 1340,
    height: 900,
    title: "OKX 交易 Agent",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 界面来源：dev server（npm run ui:dev）> 构建产物（dist/ui）> 报错
  const devUrl = process.env.UI_DEV === "1" ? "http://localhost:5173" : "";
  const distUi = path.join(AGENT_ROOT, "dist", "ui", "index.html");
  if (devUrl) {
    win.loadURL(devUrl);
    pushLog("开发模式：加载 Vite dev server");
  } else if (fs.existsSync(distUi)) {
    win.loadFile(distUi);
  } else {
    pushLog(`❌ 找不到界面产物: ${distUi}（请先 npm run build，或用 npm run ui:dev）`);
  }

  // 渲染进程的报错与未捕获异常回流到日志，避免界面白屏却无从查起
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) pushLog(`[UI:${level === 3 ? "error" : "warn"}] ${message} @${sourceId}:${line}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    pushLog(`❌ 界面加载失败(${code}) ${desc} ${url}`);
  });

  win.on("closed", () => {
    win = null;
  });
}

// ── IPC：store 完整管理 ──────────────────────────────────────
// 模型
ipcMain.handle("models:list", () => withStore((s) => s.listModels()));
ipcMain.handle("models:upsert", (_e, m) => withStore((s) => s.upsertModel(m)));
ipcMain.handle("models:delete", (_e, id) => withStore((s) => s.deleteModel(id)));
ipcMain.handle("models:test", async (_e, m) =>
  withStore(async (s) => {
    const { testModel } = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "llm.js").replace(/\\/g, "/"));
    return testModel(m);
  })
);

// 角色
ipcMain.handle("roles:list", () => withStore((s) => s.listRoles()));
ipcMain.handle("roles:upsert", (_e, r) => withStore((s) => s.upsertRole(r)));
ipcMain.handle("roles:delete", (_e, id) => withStore((s) => s.deleteRole(id)));

// MCP
ipcMain.handle("mcp:list", () => withStore((s) => s.listMcpServers()));
ipcMain.handle("mcp:upsert", (_e, c) => withStore((s) => s.upsertMcpServer(c)));
ipcMain.handle("mcp:delete", (_e, id) => withStore((s) => s.deleteMcpServer(id)));
ipcMain.handle("mcp:test", async (_e, id) => {
  // 试连某个 MCP server，返回工具数与错误
  try {
    const mod: any = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "mcp.js").replace(/\\/g, "/"));
    const conn = await mod.connectMcp([id]);
    const n = conn.tools.length;
    await conn.close();
    return { ok: n > 0, tools: n, errors: conn.errors };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
});

// Skill
ipcMain.handle("skills:list", async () => {
  const mod: any = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "skills.js").replace(/\\/g, "/"));
  const enabled = withStoreSync()?.settings?.skillEnabled ?? {};
  return mod.SKILLS.map((s: any) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    args: s.args,
    readOnly: s.readOnly,
    enabled: enabled[s.id] !== false,
  }));
});
ipcMain.handle("skills:setEnabled", (_e, id: string, on: boolean) =>
  withStore((s) => s.setSkillEnabled(id, on))
);

function withStoreSync(): any {
  try {
    const p = path.join(AGENT_ROOT, "data", "store.json");
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } catch {
    return null;
  }
}

// 设置
ipcMain.handle("settings:get", () => withStore((s) => s.getSettings()));
ipcMain.handle("settings:update", (_e, patch) => withStore((s) => s.updateSettings(patch)));
ipcMain.handle("store:reset", () => withStore((s) => s.resetStore()));
ipcMain.handle("store:path", () => path.join(AGENT_ROOT, "data", "store.json"));

// agent 控制
ipcMain.handle("agent:start", () => startAgent());
ipcMain.handle("agent:stop", () => stopAgent());
ipcMain.handle("agent:runOnce", () => {
  const st = loadSettingsSync();
  const args = ["--once", ...(st?.dryRun ? ["--dry-run"] : [])];
  return new Promise((resolve) => {
    const p = spawnAgent(args);
    let out = "";
    p.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      out += s;
      s.split(/\r?\n/).filter(Boolean).forEach(pushLog);
    });
    p.stderr?.on("data", (d: Buffer) =>
      d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => pushLog(`[stderr] ${l}`))
    );
    p.on("exit", (code) => resolve({ ok: code === 0, code, out: out.slice(-3000) }));
    p.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
});
ipcMain.handle("status:get", () => getStatus());
ipcMain.handle("logs:get", () => logBuffer.slice(-500));
ipcMain.handle("open:folder", (_e, which: string) => {
  shell.openPath(which === "logs" ? path.join(PROJECT_ROOT, "logs") : path.join(PROJECT_ROOT, "state"));
  return { ok: true };
});
ipcMain.handle("open:store", () => {
  shell.showItemInFolder(path.join(AGENT_ROOT, "data", "store.json"));
  return { ok: true };
});
ipcMain.handle("dialog:error", (_e, msg: string) => {
  dialog.showErrorBox("错误", msg);
  return { ok: true };
});

// ── IPC：工具与对话 ────────────────────────────────────────
async function loadDist<T = any>(rel: string): Promise<T> {
  const p = path.join(AGENT_ROOT, "dist", "src", rel);
  if (!fs.existsSync(p)) throw new Error(`缺少编译产物 dist/src/${rel}，请先执行 npm run build`);
  return (await import("file://" + p.replace(/\\/g, "/"))) as T;
}

ipcMain.handle("tools:list", async () => {
  try {
    const mod = await loadDist<any>("tools/index.js");
    return mod.toolCatalog();
  } catch {
    return [];
  }
});

ipcMain.handle("chat:history", () => withStore((s) => s.getChatHistory()));
ipcMain.handle("chat:clear", () => withStore((s) => s.clearChatHistory()));

let chatAbort: AbortController | null = null;
const pendingConfirms = new Map<string, (v: boolean) => void>();

ipcMain.handle("chat:confirm", (_e, id: string, ok: boolean) => {
  const r = pendingConfirms.get(id);
  if (r) {
    pendingConfirms.delete(id);
    r(!!ok);
  }
  return { ok: !!r };
});

ipcMain.handle("chat:abort", () => {
  chatAbort?.abort();
  chatAbort = null;
  return { ok: true };
});

ipcMain.handle(
  "chat:send",
  async (_e, p: { text?: string; modelId?: string; enabledTools?: string[] }) => {
    const text = String(p?.text ?? "").trim();
    if (!text) return { ok: false, error: "消息为空" };
    if (chatAbort) return { ok: false, error: "已有对话在进行中，请先停止" };

    try {
      const mod = await loadDist<any>("chat.js");
      const settings = await withStore((s) => s.getSettings());
      const history: any[] = await withStore((s) => s.getChatHistory());

      const ac = new AbortController();
      chatAbort = ac;
      const send = (ev: unknown) => win?.webContents.send("chat:event", ev);

      type CallRec = { name: string; args?: unknown; ok?: boolean; output?: string; error?: string };
      let answer = "";
      const callMap = new Map<string, CallRec>();

      const confirm = async (req: { id: string; title: string; message: string }) => {
        // 设置里关掉确认则自动放行（用户自担风险）
        if (settings?.requireToolConfirm === false) return true;
        send({ type: "confirm", ...req });
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            if (pendingConfirms.has(req.id)) {
              pendingConfirms.delete(req.id);
              resolve(false);
            }
          }, 180_000);
          pendingConfirms.set(req.id, (v) => {
            clearTimeout(timer);
            resolve(v);
          });
        });
      };

      const res = await mod.runChat({
        history: [
          ...history.map((m) => ({
            role: m.role,
            content: m.content ?? "",
            ...(m.name ? { name: m.name } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          })),
          { role: "user", content: text },
        ],
        modelId: p?.modelId,
        enabledTools: p?.enabledTools ?? [],
        signal: ac.signal,
        onEvent: (ev: any) => {
          send(ev);
          if (ev?.type === "delta") answer += ev.text ?? "";
          else if (ev?.type === "tool_start") callMap.set(ev.callId, { name: ev.name, args: ev.args });
          else if (ev?.type === "tool_result") {
            const c: CallRec = callMap.get(ev.callId) || { name: ev.name };
            c.ok = !!ev.ok;
            c.output = ev.output ?? "";
            c.error = ev.error;
            callMap.set(ev.callId, c);
          }
        },
        confirm,
      });

      // 只把 user / assistant 落盘（system 每次重算，tool 中间消息不存）
      const calls = [...callMap.values()].filter((c) => c.name);
      const now = new Date().toISOString();
      await withStore((s) =>
        s.saveChatHistory([
          ...history,
          { role: "user", content: text, ts: now },
          ...(answer || calls.length ? [{ role: "assistant", content: answer, calls, ts: now }] : []),
        ])
      );

      return { ok: true, aborted: !!res?.aborted, error: res?.error };
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      win?.webContents.send("chat:event", { type: "error", message: msg });
      return { ok: false, error: msg };
    } finally {
      chatAbort = null;
    }
  }
);

// ── 生命周期 ────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  pushLog("界面就绪");
  const st = loadSettingsSync();
  const auto = autoStartEnabled();
  const dry = st?.dryRun !== false;
  if (auto) {
    pushLog("自动启动服务中…");
    if (dry) pushLog("（演练模式：不下真实单）");
    startAgent();
  } else {
    pushLog("自动启动已关闭，点「启动服务」开始");
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopAgent();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => stopAgent());
