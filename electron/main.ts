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
import { app, BrowserWindow, ipcMain, shell, dialog, Menu, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn, exec, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

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
/** 项目根即 agent/ 自身（自包含：state/logs 等运行时数据也在 agent 下，不再依赖父目录） */
const PROJECT_ROOT = AGENT_ROOT;

/** 应用名：菜单首项（macOS）与「关于」都用它，需早于 app ready 设置 */
const APP_NAME = "OKX 交易 Agent";
app.name = APP_NAME;

// 关闭 Chromium 后台联网（组件更新 / Safe Browsing / 遥测等 Google 服务）。
// 这些在访问不到 Google 的网络环境下会反复 SSL 握手失败刷日志（net_error -107），
// 与本项目业务无关（LLM / MCP / 下单全走 Node 侧），关掉减少噪声。
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-features", "OptimizationHints,Translate,MediaRouter");

// 动态导入 store（编译后路径为 dist/src/store.js）
const storePath = path.join(AGENT_ROOT, "dist", "src", "store.js");
const srcStorePath = path.join(AGENT_ROOT, "src", "store.ts");

let win: BrowserWindow | null = null;
let agentProc: ChildProcess | null = null;
let logBuffer: string[] = [];

// ── 进程自愈：常驻 agent 崩溃后自动重启（退避 + 上限，避免崩溃循环） ──
let manualStop = false;
let restartCount = 0;
let restartTimer: NodeJS.Timeout | null = null;
const MAX_RESTART = 5;
const RESTART_BASE_DELAY_MS = 3000;

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
  // 路径含空格（本仓库位于 "OKX Trader" 下）时，绝对路径 .cmd + shell:true 会被 cmd
  // 按空格拆断，报「'C:\...\OKX' 不是内部或外部命令」。改为把 node_modules/.bin 塞进
  // PATH，用裸命令名 tsx.cmd / npx.cmd 交给 shell 解析，彻底规避（同 dev-ui.mjs）。
  const binDir = path.join(AGENT_ROOT, "node_modules", ".bin");
  const useBin = fs.existsSync(path.join(binDir, isWin ? "tsx.cmd" : "tsx"));
  const cmd = useBin ? (isWin ? "tsx.cmd" : "tsx") : isWin ? "npx.cmd" : "npx";
  const args = useBin
    ? [path.join("src", "main.ts"), ...extraArgs]
    : ["tsx", path.join("src", "main.ts"), ...extraArgs];

  pushLog(`启动: ${cmd} ${args.join(" ")}`);
  return spawn(cmd, args, {
    cwd: AGENT_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AGENT_UI: "1",
      PYTHONIOENCODING: "utf-8",
    },
    windowsHide: true,
    shell: isWin, // Windows .cmd 垫片必须 shell:true，否则 EINVAL（实测踩过）
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * 子进程 stdout 行缓冲解析：
 *   `__TRACE__{json}` 行 → 广播 llm:trace 到「观测」页签（agent 轮次的 LLM/工具调用轨迹）
 *   其余行 → 日志（agent:log）
 * 行缓冲是因为 data 事件可能把一条 JSON 行劈成两半，直接按 chunk split 会解析失败。
 */
function pipeAgentStdout(p: ChildProcess, onPlain?: (line: string) => void) {
  let buf = "";
  p.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      if (line.startsWith("__TRACE__")) {
        try {
          const ev = JSON.parse(line.slice("__TRACE__".length));
          emitTrace({ ts: traceTs(), ...(ev as Record<string, unknown>) });
        } catch {
          /* 坏行忽略 */
        }
      } else {
        (onPlain ?? pushLog)(line);
      }
    }
  });
  p.stderr?.on("data", (d: Buffer) =>
    d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => pushLog(`[stderr] ${l}`))
  );
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
  manualStop = false;
  const st = loadSettingsSync();
  // 演练模式必须作为 --dry-run 传给子进程，否则只是打印一行日志、实际仍会下单
  const dry = st?.dryRun === true;
  if (dry) pushLog("演练模式开启：不会下真实单");

  agentProc = spawnAgent(dry ? ["--dry-run"] : []);
  pipeAgentStdout(agentProc);
  agentProc.on("exit", (code) => {
    pushLog(`服务退出 code=${code}`);
    agentProc = null;
    // 非手动停止且异常退出（code 非 0）→ 自动重启；否则仅更新状态
    if (!manualStop && code !== 0) {
      scheduleRestart();
    } else {
      restartCount = 0;
      win?.webContents.send("agent:status", { running: false });
    }
  });
  agentProc.on("error", (e) => {
    pushLog(`服务启动失败: ${e.message}`);
    agentProc = null;
    if (!manualStop) scheduleRestart();
  });
  win?.webContents.send("agent:status", { running: true });
  return { ok: true, msg: "已启动" };
}

/** 崩溃后带退避地自动重启；连续失败达上限则放弃，避免崩溃循环 */
function scheduleRestart() {
  if (restartCount >= MAX_RESTART) {
    pushLog(`⛔ 自动重启达上限(${MAX_RESTART})，停止重试，请人工排查`);
    restartCount = 0;
    win?.webContents.send("agent:status", { running: false });
    return;
  }
  restartCount++;
  const delay = RESTART_BASE_DELAY_MS * restartCount; // 3s/6s/9s... 线性退避
  pushLog(`将在 ${delay / 1000}s 后自动重启（第 ${restartCount}/${MAX_RESTART} 次）`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    pushLog("自动重启中…");
    startAgent();
  }, delay);
}

function stopAgent() {
  if (!agentProc) return { ok: false, msg: "未运行" };
  manualStop = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  restartCount = 0;
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
 * preload 只认 CJS：正规产物是 dist/preload/preload.js（tsconfig.preload.json 编译，
 * postbuild 打上 {"type":"commonjs"} 标记）。
 * 必须优先选它：dist/electron 下曾遗留过旧版 preload（旧配置编译的，缺新 API），
 * 优先选同目录文件会导致「portfolioSummarize is not a function」这类缺方法报错。
 */
function resolvePreload(): string {
  const canonical = path.join(AGENT_ROOT, "dist", "preload", "preload.js");
  const legacy = path.join(HERE, "preload.js");
  if (fs.existsSync(canonical)) return canonical;
  return fs.existsSync(legacy) ? legacy : canonical;
}

/** 独立窗口（K 线 / 报告等）：key -> BrowserWindow，同 key 复用并聚焦，避免开一堆重复窗口 */
const subWins = new Map<string, BrowserWindow>();

/**
 * 加载界面：dev server（npm run ui:dev）> 构建产物（dist/ui）。
 * hash 用于独立窗口路由（#/win/kline?instId=xxx），主窗口传空。
 */
function loadUi(w: BrowserWindow, hash = ""): boolean {
  const devPort = process.env.UI_DEV_PORT || "8088";
  const devUrl = process.env.UI_DEV === "1" ? `http://127.0.0.1:${devPort}` : "";
  const distUi = path.join(AGENT_ROOT, "dist", "ui", "index.html");
  // hash 传进来可能带 #（如 "#/win/kline?instId=xxx"），统一先去 #，各加载方式再自行加 #
  // （实测踩过：dev 分支原来 `"#" + hash` 会在 hash 已带 # 时拼成 "##/win/..."，
  //  导致 location.hash 解析失败 → winRoute=null → 独立窗口退化成渲染首页）
  const h = hash.replace(/^#/, "");
  if (devUrl) {
    w.loadURL(devUrl + (h ? "#" + h : ""));
    return true;
  }
  if (fs.existsSync(distUi)) {
    w.loadFile(distUi, h ? { hash: h } : {});
    return true;
  }
  return false;
}

/** 外链一律走系统浏览器：对话 Markdown 渲染出的 <a> 点击时不允许把应用窗口导航走 */
function attachNavigationGuard(w: BrowserWindow) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (/^https?:/i.test(url) && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
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

  attachNavigationGuard(win);

  // 界面来源：dev server（npm run ui:dev）> 构建产物（dist/ui）> 报错
  if (!loadUi(win)) {
    pushLog(`❌ 找不到界面产物: ${path.join(AGENT_ROOT, "dist", "ui", "index.html")}（请先 npm run build，或用 npm run ui:dev）`);
  } else if (process.env.UI_DEV === "1") {
    pushLog("开发模式：加载 Vite dev server");
  }

  attachContextMenu(win);

  // 渲染进程的报错与未捕获异常回流到日志，避免界面白屏却无从查起
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) pushLog(`[UI:${level === 3 ? "error" : "warn"}] ${message} @${sourceId}:${line}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    pushLog(`❌ 界面加载失败(${code}) ${desc} ${url}`);
  });

  // 主窗口关了就一起关掉所有独立窗口，否则进程会被残留的子窗口吊住
  win.on("closed", () => {
    win = null;
    for (const w of subWins.values()) {
      if (!w.isDestroyed()) w.close();
    }
    subWins.clear();
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

// 角色（专家）：列表 = 文件专家(experts/*.json) + store 覆盖 + 自定义角色
ipcMain.handle("roles:list", async () => {
  const mod: any = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "experts.js").replace(/\\/g, "/"));
  return mod.listExpertRoles();
});
ipcMain.handle("roles:upsert", (_e, r) => withStore((s) => s.upsertRole(r)));
ipcMain.handle("roles:delete", async (_e, id) => {
  // 内置专家（源在 experts/*.json）不可真正删除，删除=写「禁用」覆盖层；
  // 自定义角色（store 里文件没有的）则真正从 store.roles 删除。
  const mod: any = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "experts.js").replace(/\\/g, "/"));
  const defs: any[] = mod.loadExpertDefs();
  const builtin = defs.find((d) => d.id === id);
  if (builtin) {
    return withStore((s) =>
      s.upsertRole({
        id: builtin.id,
        name: builtin.name,
        duty: builtin.duty,
        systemPrompt: builtin.systemPrompt,
        skills: builtin.skills,
        mcpServers: builtin.mcpServers,
        enabled: false,
        createdAt: new Date().toISOString(),
      })
    );
  }
  return withStore((s) => s.deleteRole(id));
});

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

// ── MCP 一键安装（内置交易所预设目录） ─────────────────────
/** npm 全局安装（直接二进制启动的预设，如 okx-trade-mcp） */
function runNpmInstall(pkgs: string[]): Promise<{ ok: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const cmd = `npm install -g ${pkgs.join(" ")} --no-fund --no-audit --loglevel=error`;
    pushLog(`一键安装 MCP: ${cmd}`);
    exec(
      cmd,
      { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const output = `${stdout || ""}${stderr || ""}`.trim().slice(-2000);
        if (err) {
          const detail = (stderr || stdout || err.message || "").slice(0, 300);
          resolve({ ok: false, output, error: `npm 安装失败(${err.code ?? "?"})：${detail}` });
        } else {
          resolve({ ok: true, output });
        }
      }
    );
  });
}

/** 内置交易所 MCP 预设列表（附带「是否已安装」状态） */
ipcMain.handle("mcp:presets", async () => {
  const mod: any = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "mcpPresets.js").replace(/\\/g, "/"));
  const presets: any[] = mod.listMcpPresets();
  const installedIds = new Set(((withStoreSync()?.mcpServers ?? []) as any[]).map((m) => m.id));
  return presets.map((p) => ({ ...p, installed: installedIds.has(p.id) }));
});

/** 一键安装 + 写入配置：先按需 npm 全局安装，再把 server 落进 store */
ipcMain.handle("mcp:install", async (_e, payload: { presetId?: string; env?: Record<string, string> }) => {
  const presetId = String(payload?.presetId ?? "");
  if (!presetId) return { ok: false, error: "缺少 presetId" };
  const mod: any = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "mcpPresets.js").replace(/\\/g, "/"));
  const preset = mod.getMcpPreset(presetId);
  if (!preset) return { ok: false, error: `未知预设: ${presetId}` };

  let installOutput = "";
  if (preset.installPackages?.length) {
    const r = await runNpmInstall(preset.installPackages);
    installOutput = r.output;
    if (!r.ok) return { ok: false, error: r.error, output: installOutput };
  }

  // 过滤掉空凭证，避免把空字符串写进 env
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload?.env ?? {})) {
    if (String(v ?? "").trim()) env[k] = String(v).trim();
  }

  await withStore((s) =>
    s.upsertMcpServer({
      id: preset.id,
      name: preset.name,
      kind: preset.kind ?? "exchange",
      command: preset.command || undefined,
      args: preset.args?.length ? preset.args : undefined,
      url: preset.url,
      headers: preset.headers,
      env: Object.keys(env).length ? env : undefined,
      windowsCmdWrap: preset.windowsCmdWrap,
      enabled: true,
      createdAt: new Date().toISOString(),
    })
  );

  pushLog(`MCP「${preset.name}」已安装并写入配置`);
  return { ok: true, installed: true, output: installOutput, id: preset.id };
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

// 超短线（独立板块）
ipcMain.handle("scalper:get", () => withStore((s) => s.getScalperConfig()));
ipcMain.handle("scalper:update", (_e, patch) => withStore((s) => s.updateScalperConfig(patch)));
ipcMain.handle("scalper:once", async () => {
  try {
    const cfg = await withStore((s) => s.getScalperConfig());
    const mod = await loadDist<any>("scalper.js");
    const r = await mod.scalpOnce(cfg);
    return { ok: r.ok, msg: r.msg, signal: r.signal };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
});
ipcMain.handle("scalper:overview", async () => {
  try {
    const mod = await loadDist<any>("scalper.js");
    const r = await mod.getScalperOverview();
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
});

// agent 控制
ipcMain.handle("agent:start", () => startAgent());
ipcMain.handle("agent:stop", () => stopAgent());
/** 跑一轮（--once）：界面按钮与顶层菜单共用同一实现 */
function runOnceAgent(): Promise<{ ok: boolean; code?: number | null; out?: string; error?: string }> {
  const st = loadSettingsSync();
  // 只有显式开启演练才加 --dry-run（默认真实，由设置 dryRun 显式控制）
  const args = ["--once", ...(st?.dryRun === true ? ["--dry-run"] : [])];
  return new Promise((resolve) => {
    const p = spawnAgent(args);
    let out = "";
    pipeAgentStdout(p, (line) => {
      out += line + "\n";
      pushLog(line);
    });
    p.on("exit", (code) => resolve({ ok: code === 0, code, out: out.slice(-3000) }));
    p.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}
ipcMain.handle("agent:runOnce", () => runOnceAgent());
ipcMain.handle("status:get", () => getStatus());
// 实时账户/持仓查看（读操作：demo 或 live 只读，符合 L1-3）
ipcMain.handle("account:get", async (_e, profile = "demo") => {
  try {
    const mod: any = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "okx.js").replace(/\\/g, "/"));
    const data = await mod.fetchAccount(profile === "live" ? "live" : "demo");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
});
ipcMain.handle("logs:get", () => logBuffer.slice(-500));

// ── 观测历史（SQLite 持久化读取 / 清空） ─────────────────────
ipcMain.handle("obs:history", (_e, limit?: number) => {
  try {
    const db = obsDbInit();
    if (!db) return [];
    const n = Math.min(5000, Math.max(1, Number(limit) || 500));
    const rows = db.prepare(`SELECT payload FROM observations ORDER BY id DESC LIMIT ?`).all(n) as { payload: string }[];
    return rows.map((r) => { try { return JSON.parse(r.payload); } catch { return null; } }).filter(Boolean).reverse();
  } catch {
    return [];
  }
});
ipcMain.handle("obs:clear", () => {
  try {
    obsDbInit()?.exec(`DELETE FROM observations`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ── 独立窗口（K 线 / 报告等）──────────────────────────────────
// 内容还是同一套 UI，靠 URL hash 路由（#/win/kline?instId=xxx）决定渲染什么，
// 好处是窗口内所有 api（行情、报告）都能直接用，不用再传数据过去。
ipcMain.handle("win:open", (_e, o: any = {}) => {
  const key = String(o?.key || o?.kind || "win");
  const hash = String(o?.hash || "");
  const title = String(o?.title || "OKX 交易 Agent");
  const existing = subWins.get(key);
  if (existing && !existing.isDestroyed()) {
    // 同一个 key 已经开过：改 hash 让窗口内路由切换（同文档导航，不整页重载）
    existing.webContents
      .executeJavaScript(`location.hash = ${JSON.stringify(hash)}`)
      .catch(() => {});
    existing.focus();
    return { ok: true, reused: true };
  }
  const w = new BrowserWindow({
    width: Number(o?.width) || 1120,
    height: Number(o?.height) || 780,
    minWidth: 680,
    minHeight: 480,
    title,
    parent: win || undefined,
    autoHideMenuBar: true, // 子窗口不占菜单栏，标题栏由界面自己画
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  subWins.set(key, w);
  attachNavigationGuard(w);
  attachContextMenu(w);
  if (!loadUi(w, hash)) {
    pushLog("❌ 独立窗口：找不到界面产物（请先 npm run build）");
  }
  w.on("closed", () => subWins.delete(key));
  return { ok: true };
});

/** 子窗口自己的关闭按钮（Esc / ✕）；主窗口调用不生效，避免误关主界面 */
ipcMain.handle("win:close", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && w !== win) w.close();
  return { ok: true };
});

// ── 报告入口（日报/周报 Markdown，位于 reports/daily|weekly） ──
const REPORTS_DIR = path.join(AGENT_ROOT, "reports");

function listReports() {
  const scan = (sub: string) => {
    const dir = path.join(REPORTS_DIR, sub);
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse() // 新的在前
        .map((f) => {
          const full = path.join(dir, f);
          const st = fs.statSync(full);
          return { name: f, sub, path: full, size: st.size, mtime: st.mtime.toISOString() };
        });
    } catch {
      return [];
    }
  };
  return { daily: scan("daily"), weekly: scan("weekly") };
}

ipcMain.handle("reports:list", () => listReports());

/** 读报告内容（应用内预览），只允许 reports 目录内的文件 */
ipcMain.handle("reports:read", (_e, p: string) => {
  const full = path.resolve(p);
  if (!full.startsWith(path.resolve(REPORTS_DIR))) return { ok: false, error: "路径越界" };
  try {
    return { ok: true, text: fs.readFileSync(full, "utf8").slice(0, 30_000) };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
});

/** 用系统默认程序打开（Typora/VSCode 等） */
ipcMain.handle("reports:open", (_e, p: string) => {
  const full = path.resolve(p);
  if (!full.startsWith(path.resolve(REPORTS_DIR))) return { ok: false, error: "路径越界" };
  shell.openPath(full);
  return { ok: true };
});

ipcMain.handle("reports:dir", () => {
  shell.openPath(REPORTS_DIR);
  return { ok: true };
});

/** 轮次 HTML 报告列表（reports/<round_id>/summary.html + <expert>.html）；
 *  顺带为「归档里有、还没 HTML」的历史轮次补纯数据兜底页，保证每轮都能点开。 */
ipcMain.handle("reports:rounds", async () => {
  try {
    const mod: any = await import(
      "file://" + path.join(AGENT_ROOT, "dist", "src", "report.js").replace(/\\/g, "/")
    );
    const added = Number((await mod.ensureRoundReports()) ?? 0);
    return {
      ok: true,
      added,
      rounds: mod.listRoundReports() ?? [],
      indexPath: typeof mod.indexPath === "function" ? mod.indexPath() : "",
    };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 500), rounds: [] };
  }
});

/** 用 LLM 重新生成某轮报告（界面「重新生成」，覆盖 reports/<round_id>/*.html） */
ipcMain.handle("reports:regen", async (_e, roundId: string) => {
  try {
    const mod: any = await import(
      "file://" + path.join(AGENT_ROOT, "dist", "src", "report.js").replace(/\\/g, "/")
    );
    const ok = await mod.regenerateRound(String(roundId ?? ""));
    return ok
      ? { ok: true, rounds: mod.listRoundReports() ?? [] }
      : { ok: false, error: "归档中找不到该轮次" };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) };
  }
});

/** 读一份 HTML 报告全文（界面用 iframe srcdoc 渲染），只允许 reports 目录内的文件 */
ipcMain.handle("reports:html", (_e, p: string) => {
  const full = path.resolve(p);
  if (!full.startsWith(path.resolve(REPORTS_DIR))) return { ok: false, error: "路径越界" };
  try {
    return { ok: true, html: fs.readFileSync(full, "utf8") };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
});

/** 生成日报/周报（复用 scripts/report.py 的确定性统计） */
ipcMain.handle("reports:gen", async (_e, kind: string) => {
  try {
    const mod: any = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "okx.js").replace(/\\/g, "/"));
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // CST 今天
    const args = kind === "weekly" ? ["--weekly-end", day] : ["--daily", day];
    const out = await mod.runPy("report.py", args, 60_000);
    return { ok: true, out: out.slice(0, 1200), reports: listReports() };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) };
  }
});

// ── 热门行情（优先 okx-trade-mcp；失败回退直连 REST；10s 缓存） ──
let tickersCache: { at: number; rows: unknown[]; src: string } | null = null;
let mktMcp: { tools: any[]; close: () => Promise<void> } | null = null;

/** 行情专用 MCP 长连接：惰性建立、复用；调用失败置空待重连 */
async function getMktMcp() {
  if (mktMcp) return mktMcp;
  try {
    const mod: any = await import("file://" + path.join(AGENT_ROOT, "dist", "src", "mcp.js").replace(/\\/g, "/"));
    const conn = await mod.connectMcp(["okx-trade-mcp"]);
    if (conn.tools.length) {
      mktMcp = conn;
      return mktMcp;
    }
    await conn.close();
  } catch {
    /* 无 MCP 环境则静默，走 REST 回退 */
  }
  return null;
}

async function tickersViaMcp(): Promise<any[]> {
  const conn = await getMktMcp();
  if (!conn) throw new Error("MCP 未连接");
  const t = conn.tools.find((x: any) => String(x.name).endsWith("__market_get_tickers"));
  if (!t) throw new Error("MCP 缺少 market_get_tickers 工具");
  let out: any;
  try {
    out = await t.invoke({ instType: "SWAP" });
  } catch (e) {
    mktMcp = null; // 连接可能已断，下次重连
    throw e;
  }
  // callTool 结果形如 {content:[{type:"text",text:"{\"tool\":...,\"ok\":true,\"data\":{\"data\":[...]}}"}]}
  let j: any = out;
  if (out?.content && Array.isArray(out.content)) {
    const text = out.content.map((c: any) => c.text ?? "").join("");
    j = JSON.parse(text);
  }
  const arr = j?.data?.data ?? j?.data;
  if (!Array.isArray(arr)) throw new Error("MCP 返回结构异常");
  return arr;
}

async function tickersViaRest(): Promise<any[]> {
  const bases = process.env.OKX_PUBLIC_BASE
    ? [process.env.OKX_PUBLIC_BASE.replace(/\/+$/, "")]
    : ["https://www.okx.com", "https://aws.okx.com", "https://okx.com"];
  let lastErr = "";
  for (const base of bases) {
    try {
      const r = await fetch(`${base}/api/v5/market/tickers?instType=SWAP`, {
        signal: AbortSignal.timeout(10_000),
      });
      const j: any = await r.json();
      if (j.code !== "0") {
        lastErr = `code=${j.code} ${j.msg ?? ""}`;
        continue;
      }
      return j.data;
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e);
    }
  }
  throw new Error(lastErr || "直连 REST 失败");
}

/**
 * 市值分层：OKX 公共行情不返回市值，这里用主流币市值梯队做静态排名（1 最大）。
 * 未收录的币 rank=9999，在市值排序里排在末尾，梯队内部再按 24h 成交额排。
 * 用途：首页 Top5 与行情页「按市值排序」——够用且零依赖（无额外 API、不受网络影响）。
 */
const MCAP_RANK: Record<string, number> = {
  BTC: 1, ETH: 2, SOL: 3, BNB: 4, XRP: 5, DOGE: 6, ADA: 7, TRX: 8, AVAX: 9, LINK: 10,
  TON: 11, DOT: 12, SUI: 13, LTC: 14, BCH: 15, HBAR: 16, SHIB: 17, UNI: 18, PEPE: 19, APT: 20,
  NEAR: 21, ICP: 22, AAVE: 23, ETC: 24, POL: 25, ATOM: 26, FIL: 27, ARB: 28, OP: 29, INJ: 30,
  TIA: 31, SEI: 32, RUNE: 33, IMX: 34, GRT: 35, AXL: 36, ALGO: 37, EGLD: 38, SAND: 39, MANA: 40,
};

function toTickerRows(data: any[]) {
  return (data as any[])
    .filter((t) => String(t.instId).endsWith("-USDT-SWAP"))
    .sort((a, b) => Number(b.volCcy24h) - Number(a.volCcy24h)) // 先按 24h 成交额排热门
    .map((t) => {
      const last = Number(t.last);
      const open = Number(t.open24h);
      const sym = String(t.instId).split("-")[0];
      return {
        rank: MCAP_RANK[sym] ?? 9999,
        symbol: sym,
        instId: String(t.instId),
        last,
        changePct: open ? ((last - open) / open) * 100 : 0,
        volUsd: Number(t.volCcy24h),
        high24h: Number(t.high24h),
        low24h: Number(t.low24h),
      };
    });
}

/**
 * 全量行情（渲染进程侧做搜索/筛选/排序/截断，避免每次改条件都回主进程）。
 * 约 470 个 USDT 永续，JSON 很小，一次传完最省心。
 */
ipcMain.handle("market:tickers", async () => {
  if (tickersCache && Date.now() - tickersCache.at < 10_000) {
    return { ok: true, tickers: tickersCache.rows, ts: tickersCache.at, source: tickersCache.src };
  }
  let data: any[] | null = null;
  let source = "";
  let lastErr = "";
  try {
    data = await tickersViaMcp();
    source = "mcp";
  } catch (e) {
    lastErr = `MCP: ${String((e as Error)?.message ?? e).slice(0, 140)}`;
  }
  if (!data) {
    try {
      data = await tickersViaRest();
      source = "rest";
    } catch (e) {
      lastErr += ` | REST: ${String((e as Error)?.message ?? e).slice(0, 150)}`;
    }
  }
  if (!data) return { ok: false, error: lastErr.slice(0, 300) };
  const rows = toTickerRows(data);
  tickersCache = { at: Date.now(), rows, src: source };
  return { ok: true, tickers: rows, ts: Date.now(), source };
});

/**
 * K 线（优先 MCP market_get_candles，回退直连 REST）。
 * OKX 返回倒序 [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]，这里统一转成正序对象。
 */
ipcMain.handle(
  "market:kline",
  async (_e, instId: string, bar = "15m", limit = 120) => {
    const inst = String(instId ?? "");
    const b = ["1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D", "1W"].includes(String(bar))
      ? String(bar)
      : "15m";
    const n = Math.min(Math.max(Number(limit) || 120, 20), 300);
    const toCandles = (rows: any[]) =>
      rows
        .map((r) => ({
          t: Number(r[0]),
          o: Number(r[1]),
          h: Number(r[2]),
          l: Number(r[3]),
          c: Number(r[4]),
          v: Number(r[5]),
        }))
        .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.c))
        .sort((a, b2) => a.t - b2.t); // 正序（旧→新）

    try {
      const conn = await getMktMcp();
      if (!conn) throw new Error("MCP 未连接");
      const tool = conn.tools.find((x: any) => String(x.name).endsWith("__market_get_candles"));
      if (!tool) throw new Error("MCP 缺少 market_get_candles 工具");
      let out: any;
      try {
        out = await tool.invoke({ instId: inst, bar: b, limit: n });
      } catch (e) {
        mktMcp = null; // 连接可能已断，下次重连
        throw e;
      }
      let j: any = out;
      if (out?.content && Array.isArray(out.content)) {
        j = JSON.parse(out.content.map((c: any) => c.text ?? "").join(""));
      }
      const arr = j?.data?.data ?? j?.data;
      if (!Array.isArray(arr)) throw new Error("MCP 返回结构异常");
      return { ok: true, instId: inst, bar: b, candles: toCandles(arr), source: "mcp" };
    } catch (e) {
      const mcpErr = String((e as Error)?.message ?? e).slice(0, 120);
      // 回退直连
      const bases = process.env.OKX_PUBLIC_BASE
        ? [process.env.OKX_PUBLIC_BASE.replace(/\/+$/, "")]
        : ["https://www.okx.com", "https://aws.okx.com", "https://okx.com"];
      let restErr = "";
      for (const base of bases) {
        try {
          const r = await fetch(
            `${base}/api/v5/market/candles?instId=${encodeURIComponent(inst)}&bar=${b}&limit=${n}`,
            { signal: AbortSignal.timeout(10_000) }
          );
          const j: any = await r.json();
          if (j.code !== "0") {
            restErr = `code=${j.code} ${j.msg ?? ""}`;
            continue;
          }
          return { ok: true, instId: inst, bar: b, candles: toCandles(j.data), source: "rest" };
        } catch (err) {
          restErr = String((err as Error)?.message ?? err);
        }
      }
      return { ok: false, error: `MCP: ${mcpErr} | REST: ${restErr}`.slice(0, 300) };
    }
  }
);
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
let portfolioAbort: AbortController | null = null;
const pendingConfirms = new Map<string, (v: boolean) => void>();

// ── 全局 LLM 调用观测（拒绝黑盒）：对话/持仓的 LLM 行为统一广播到「观测」页签 ──
// ── 观测持久化（SQLite）：内存广播之外，把观测事件追加落盘，重启不丢 ──
let obsDb: DatabaseSync | null = null;
let obsDbFailed = false;
function obsDbInit(): DatabaseSync | null {
  if (obsDb) return obsDb;
  if (obsDbFailed) return null;
  try {
    const file = path.join(AGENT_ROOT, "data", "observations.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_id ON observations(id)`);
    obsDb = db;
    return db;
  } catch (e) {
    obsDbFailed = true;
    pushLog(`观测 SQLite 初始化失败（观测降级为仅内存）: ${String(e).slice(0, 160)}`);
    return null;
  }
}
function persistObservation(e: unknown) {
  try {
    const db = obsDbInit();
    if (!db) return;
    const o = (e ?? {}) as Record<string, unknown>;
    db.prepare(
      `INSERT INTO observations (ts, source, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(String(o.ts ?? ""), String(o.source ?? ""), String(o.kind ?? ""), JSON.stringify(o), new Date().toISOString());
  } catch {
    /* 持久化失败不影响观测展示 */
  }
}

function emitTrace(e: unknown) {
  win?.webContents.send("llm:trace", e);
  persistObservation(e);
}
function traceTs(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
/** 业务事件同时转发到全局观测流；原 send 照常（对话/持仓页签继续渲染） */
function wrapTrace(source: string, send: (ev: unknown) => void) {
  return (ev: any) => {
    send(ev);
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case "round":
        emitTrace({ ts: traceTs(), source, kind: "round", model: ev.model, round: ev.n, msgCount: ev.msgs });
        break;
      case "reasoning":
        // 流式直发：思考链每一段增量实时进观测，前端把同源连续段合并到同一行
        emitTrace({ ts: traceTs(), source, kind: "reasoning", text: ev.text || "" });
        break;
      case "tool_start":
        emitTrace({ ts: traceTs(), source, kind: "tool_call", name: ev.name, args: ev.args });
        break;
      case "tool_result":
        emitTrace({ ts: traceTs(), source, kind: "tool_result", name: ev.name, ok: !!ev.ok, output: (ev.output || "").slice(0, 2000), error: ev.error });
        break;
      case "confirm":
        emitTrace({ ts: traceTs(), source, kind: "confirm", name: ev.title });
        break;
      case "done":
        emitTrace({ ts: traceTs(), source, kind: "done", aborted: !!ev.aborted, rounds: ev.rounds });
        break;
      case "error":
        emitTrace({ ts: traceTs(), source, kind: "error", message: ev.message });
        break;
      case "info":
        emitTrace({ ts: traceTs(), source, kind: "info", message: ev.message });
        break;
    }
  };
}

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

// ── 持仓汇总（LLM 调 MCP 只读工具 → 统一 schema，流式回传） ──
ipcMain.handle("portfolio:abort", () => {
  portfolioAbort?.abort();
  portfolioAbort = null;
  return { ok: true };
});

ipcMain.handle("portfolio:summarize", async (_e, p: { modelId?: string }) => {
  if (portfolioAbort) return { ok: false, error: "已有持仓汇总在进行中，请先停止" };
  try {
    const mod = await loadDist<any>("portfolio.js");
    const ac = new AbortController();
    portfolioAbort = ac;
    const send = (ev: unknown) => win?.webContents.send("portfolio:event", ev);
    await mod.summarizePortfolio({ modelId: p?.modelId, signal: ac.signal, onEvent: wrapTrace("portfolio", send) });
    return { ok: true };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    win?.webContents.send("portfolio:event", { type: "error", message: msg });
    return { ok: false, error: msg };
  } finally {
    portfolioAbort = null;
  }
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
        onEvent: wrapTrace("chat", (ev: any) => {
          if (ev?.type === "delta") answer += ev.text ?? "";
          else if (ev?.type === "tool_start") callMap.set(ev.callId, { name: ev.name, args: ev.args });
          else if (ev?.type === "tool_result") {
            const c: CallRec = callMap.get(ev.callId) || { name: ev.name };
            c.ok = !!ev.ok;
            c.output = ev.output ?? "";
            c.error = ev.error;
            callMap.set(ev.callId, c);
          }
        }),
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

// ── 顶层菜单（中文） ────────────────────────────────────────
/**
 * Electron 不设菜单时是默认英文（File / Edit / View …），这里整套换中文。
 * 注意：role 只负责行为，label 必须自己写，否则仍是英文。
 */
function showAbout() {
  return dialog.showMessageBox({
    type: "info",
    title: `关于 ${APP_NAME}`,
    message: APP_NAME,
    detail: [
      `版本 ${app.getVersion()}`,
      `Electron ${process.versions.electron} · Node ${process.versions.node}`,
      "",
      `数据目录：${path.join(AGENT_ROOT, "data")}`,
      `项目根目录：${PROJECT_ROOT}`,
    ].join("\n"),
    buttons: ["确定"],
    defaultId: 0,
  });
}

function buildMenu(): Menu {
  const isMac = process.platform === "darwin";

  // macOS 首个菜单是应用名（关于 / 服务 / 隐藏 / 退出），其余平台合并进「文件」
  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: APP_NAME,
          submenu: [
            { label: `关于 ${APP_NAME}`, click: () => showAbout() },
            { type: "separator" },
            { label: "服务", role: "services" },
            { type: "separator" },
            { label: `隐藏 ${APP_NAME}`, role: "hide" },
            { label: "隐藏其他", role: "hideOthers" },
            { label: "显示全部", role: "unhide" },
            { type: "separator" },
            { label: `退出 ${APP_NAME}`, role: "quit" },
          ],
        },
      ]
    : [];

  const fileMenu: MenuItemConstructorOptions = {
    label: "文件",
    submenu: [
      {
        label: "启动服务",
        accelerator: "CmdOrCtrl+Shift+S",
        click: () => pushLog(`菜单 → 启动服务：${startAgent().msg}`),
      },
      {
        label: "停止服务",
        accelerator: "CmdOrCtrl+Shift+X",
        click: () => pushLog(`菜单 → 停止服务：${stopAgent().msg}`),
      },
      {
        label: "跑一轮决策",
        accelerator: "CmdOrCtrl+Shift+O",
        click: async () => {
          pushLog("菜单 → 跑一轮决策开始");
          const r = await runOnceAgent();
          pushLog(`菜单 → 跑一轮结束 ok=${r.ok} code=${r.code ?? "-"}`);
        },
      },
      { type: "separator" },
      {
        label: "打开数据文件",
        accelerator: "CmdOrCtrl+Shift+D",
        click: () => shell.showItemInFolder(path.join(AGENT_ROOT, "data", "store.json")),
      },
      { label: "打开运行状态目录", click: () => shell.openPath(path.join(PROJECT_ROOT, "state")) },
      { label: "打开日志目录", click: () => shell.openPath(path.join(PROJECT_ROOT, "logs")) },
      { label: "打开轮次报告", click: () => shell.openPath(path.join(AGENT_ROOT, "reports", "index.html")) },
      ...(isMac ? [] : [{ type: "separator" } as MenuItemConstructorOptions, { label: "退出", role: "quit" } as MenuItemConstructorOptions]),
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "编辑",
    submenu: [
      { label: "撤销", role: "undo" },
      { label: "重做", role: "redo" },
      { type: "separator" },
      { label: "剪切", role: "cut" },
      { label: "复制", role: "copy" },
      { label: "粘贴", role: "paste" },
      { label: "删除", role: "delete" },
      { type: "separator" },
      { label: "全选", role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "视图",
    submenu: [
      { label: "重新加载", role: "reload" },
      { label: "强制重新加载", role: "forceReload" },
      { label: "开发者工具", role: "toggleDevTools" },
      { type: "separator" },
      { label: "实际大小", role: "resetZoom" },
      { label: "放大", role: "zoomIn" },
      { label: "缩小", role: "zoomOut" },
      { type: "separator" },
      { label: "切换全屏", role: "togglefullscreen" },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "窗口",
    submenu: [
      { label: "最小化", role: "minimize" },
      { label: isMac ? "缩放" : "最大化", role: "zoom" },
      ...(isMac ? [{ label: "前置全部窗口", role: "front" } as MenuItemConstructorOptions] : []),
      { type: "separator" },
      { label: "关闭", role: "close" },
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: "帮助",
    submenu: [
      { label: "查看运行日志目录", click: () => shell.openPath(path.join(PROJECT_ROOT, "logs")) },
      { label: "打开数据文件", click: () => shell.showItemInFolder(path.join(AGENT_ROOT, "data", "store.json")) },
      { type: "separator" },
      { label: `关于 ${APP_NAME}`, click: () => showAbout() },
    ],
  };

  return Menu.buildFromTemplate([...appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu]);
}

/** 界面右键菜单也换成中文（默认是英文的 Cut / Copy / Inspect） */
function attachContextMenu(w: BrowserWindow) {
  w.webContents.on("context-menu", (_e, params) => {
    Menu.buildFromTemplate([
      { label: "剪切", role: "cut", enabled: params.editFlags.canCut },
      { label: "复制", role: "copy", enabled: params.editFlags.canCopy },
      { label: "粘贴", role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { label: "全选", role: "selectAll" },
      { type: "separator" },
      { label: "检查元素", click: () => w.webContents.inspectElement(params.x, params.y) },
    ]).popup({ window: w });
  });
}

// ── 生命周期 ────────────────────────────────────────────────
app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  pushLog("界面就绪");
  const st = loadSettingsSync();
  const auto = autoStartEnabled();
  const dry = st?.dryRun === true;
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
app.on("before-quit", () => {
  if (mktMcp) {
    mktMcp.close().catch(() => {});
    mktMcp = null;
  }
  stopAgent();
});
