/**
 * electron/main.ts —— 主进程
 *
 * 最傻瓜化的关键就在这里：
 *   双击图标 → 本文件自动把 agent 服务拉起来 → 界面直接可用。
 *   用户不需要敲任何命令，也不需要提前配环境。
 *
 * 职责：
 *   1. 启动 agent 子进程（tsx src/main.ts），管理其生命周期
 *   2. 把子进程 stdout 实时转发给界面（日志流）
 *   3. 读取账户/持仓/最近决策，供界面展示
 *   4. 提供配置读写（LLM key、间隔、专家选择）
 */
import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * 两种运行位置都要正确定位项目根：
 *   · 开发： electron/main.ts        → __dirname = agent/electron → 上一级 = agent/
 *   · 编译： dist/electron/main.js   → __dirname = agent/dist/electron → 上两级 = agent/
 * 判断依据：目录名是否为 "dist" 的下一层（实测踩过，路径差一级会导致找不到 src/main.ts）
 */
function findAgentRoot(): string {
  let d = __dirname;
  // 向上找含 package.json 且含 src 目录的那层
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(d, "package.json")) && fs.existsSync(path.join(d, "src"))) {
      return d;
    }
    d = path.dirname(d);
  }
  return path.resolve(__dirname, "..", "..");
}
export const AGENT_ROOT = findAgentRoot();
export const PROJECT_ROOT = path.resolve(AGENT_ROOT, "..");        // okx_trader_agent/

let win: BrowserWindow | null = null;
let agentProc: ChildProcess | null = null;
let logBuffer: string[] = [];

// ── 配置（存在 agent/electron/config.json，界面可改） ──────────
interface AppConfig {
  llmProvider: "mock" | "deepseek" | "anthropic" | "openai";
  apiKey: string;
  model?: string;
  intervalMin: number;
  autoStart: boolean;
  experts: string[];
  dryRun: boolean;
}

const CONFIG_PATH = path.join(__dirname, "config.json");
const DEFAULT_CONFIG: AppConfig = {
  llmProvider: "mock",
  apiKey: "",
  intervalMin: 5,
  autoStart: true,
  experts: ["trading", "factor"],
  dryRun: true,
};

function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    }
  } catch {
    /* 读失败用默认 */
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(c: AppConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf8");
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

// ── 启动 agent 服务 ──────────────────────────────────────────
function startAgent(cfg: AppConfig) {
  if (agentProc) {
    pushLog("⚠ 服务已在运行");
    return { ok: false, msg: "已在运行" };
  }

  // 用 npx tsx 直接跑 TS 源码，无需先 build（最省事）
  const isWin = process.platform === "win32";
  const tsxBin = path.join(AGENT_ROOT, "node_modules", ".bin", isWin ? "tsx.cmd" : "tsx");
  const useBin = fs.existsSync(tsxBin);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    LLM_PROVIDER: cfg.llmProvider,
    PYTHONIOENCODING: "utf-8",
    ROUND_INTERVAL_MS: String(Math.max(1, cfg.intervalMin) * 60 * 1000),
  };
  if (cfg.apiKey) {
    if (cfg.llmProvider === "deepseek") env.DEEPSEEK_API_KEY = cfg.apiKey;
    else if (cfg.llmProvider === "anthropic") env.ANTHROPIC_API_KEY = cfg.apiKey;
    else env.OPENAI_API_KEY = cfg.apiKey;
  }
  if (cfg.model) env.LLM_MODEL = cfg.model;

  const args = useBin
    ? [path.join("src", "main.ts")]
    : ["tsx", path.join("src", "main.ts")];
  if (cfg.dryRun) args.push("--dry-run");

  const cmd = useBin ? tsxBin : (isWin ? "npx.cmd" : "npx");
  pushLog(`启动服务: ${cmd} ${args.join(" ")}`);

  agentProc = spawn(cmd, args, {
    cwd: AGENT_ROOT,
    env,
    windowsHide: true,
    // Windows 上 .cmd/.bat 垫片必须 shell:true，否则 spawn 报 EINVAL（实测踩过）
    shell: isWin,
    stdio: ["ignore", "pipe", "pipe"],
  });

  agentProc.stdout?.on("data", (d: Buffer) => {
    d.toString().split(/\r?\n/).filter(Boolean).forEach(pushLog);
  });
  agentProc.stderr?.on("data", (d: Buffer) => {
    d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => pushLog(`[stderr] ${l}`));
  });
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
  const pid = agentProc.pid;
  agentProc.kill("SIGTERM");
  agentProc = null;
  pushLog(`已停止服务 pid=${pid}`);
  win?.webContents.send("agent:status", { running: false });
  return { ok: true, msg: "已停止" };
}

// ── 读取状态（账户/持仓/最近决策） ─────────────────────────────
function readJsonSafe(p: string): unknown {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* 忽略 */
  }
  return null;
}

async function getStatus() {
  const stateDir = path.join(PROJECT_ROOT, "state");
  const runtime = readJsonSafe(path.join(stateDir, "runtime.json")) as Record<string, unknown> | null;

  // 最近决策：找最新一个 round_input_*.json（或 round_input.json）
  let latestRound: Record<string, unknown> | null = null;
  try {
    const files = fs
      .readdirSync(stateDir)
      .filter((f) => /^round_input_?R?\d*\.json$/.test(f))
      .sort();
    if (files.length) latestRound = readJsonSafe(path.join(stateDir, files[files.length - 1])) as Record<string, unknown>;
  } catch {
    /* 忽略 */
  }

  // 待人工确认
  let pending: string[] = [];
  try {
    pending = fs
      .readdirSync(stateDir)
      .filter((f) => f.startsWith("PENDING_APPROVAL_"))
      .sort();
  } catch {
    /* 忽略 */
  }

  return { runtime, latestRound, pending, agentRunning: !!agentProc };
}

// ── 窗口 ────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "OKX 交易 Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 两种运行方式都要能找到 ui：
  //   编译后 __dirname = agent/dist/electron  → ../ui 是 agent/dist/ui（不存在）
  //   所以直接按项目根定位：agent/ui
  const uiCandidates = [
    path.join(AGENT_ROOT, "ui", "index.html"),                 // agent/ui
    path.join(__dirname, "..", "..", "ui", "index.html"),      // dist/electron → agent/ui
    path.join(__dirname, "..", "ui", "index.html"),
  ];
  const uiFile = uiCandidates.find((p) => fs.existsSync(p));
  if (uiFile) {
    win.loadFile(uiFile);
  } else {
    pushLog(`❌ 找不到界面文件，已尝试: ${uiCandidates.join(" | ")}`);
  }
  win.on("closed", () => {
    win = null;
  });
}

// ── IPC ─────────────────────────────────────────────────────
ipcMain.handle("config:get", () => loadConfig());
ipcMain.handle("config:set", (_e, cfg: AppConfig) => {
  saveConfig(cfg);
  return { ok: true };
});
ipcMain.handle("agent:start", () => startAgent(loadConfig()));
ipcMain.handle("agent:stop", () => stopAgent());
ipcMain.handle("agent:runOnce", async () => {
  // 单轮：直接跑一次，不经常驻进程
  const cfg = loadConfig();
  const isWin = process.platform === "win32";
  const tsxBin = path.join(AGENT_ROOT, "node_modules", ".bin", isWin ? "tsx.cmd" : "tsx");
  const useBin = fs.existsSync(tsxBin);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    LLM_PROVIDER: cfg.llmProvider,
    PYTHONIOENCODING: "utf-8",
  };
  if (cfg.apiKey) {
    if (cfg.llmProvider === "deepseek") env.DEEPSEEK_API_KEY = cfg.apiKey;
    else if (cfg.llmProvider === "anthropic") env.ANTHROPIC_API_KEY = cfg.apiKey;
    else env.OPENAI_API_KEY = cfg.apiKey;
  }
  const args = useBin ? [path.join("src", "main.ts"), "--once"] : ["tsx", path.join("src", "main.ts"), "--once"];
  if (cfg.dryRun) args.push("--dry-run");

  return new Promise((resolve) => {
    const p = spawn(useBin ? tsxBin : isWin ? "npx.cmd" : "npx", args, {
      cwd: AGENT_ROOT,
      env,
      windowsHide: true,
      shell: isWin,
    });
    let out = "";
    p.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      out += s;
      s.split(/\r?\n/).filter(Boolean).forEach(pushLog);
    });
    p.stderr?.on("data", (d: Buffer) => {
      d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => pushLog(`[stderr] ${l}`));
    });
    p.on("exit", (code) => resolve({ ok: code === 0, code, out: out.slice(-3000) }));
    p.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
});
ipcMain.handle("status:get", () => getStatus());
ipcMain.handle("logs:get", () => logBuffer.slice(-500));
ipcMain.handle("open:folder", (_e, which: string) => {
  const target =
    which === "logs" ? path.join(PROJECT_ROOT, "logs") : path.join(PROJECT_ROOT, "state");
  shell.openPath(target);
  return { ok: true };
});
ipcMain.handle("dialog:error", (_e, msg: string) => {
  dialog.showErrorBox("错误", msg);
  return { ok: true };
});

// ── 生命周期：这里实现「自动启动」 ───────────────────────────────
app.whenReady().then(() => {
  createWindow();
  const cfg = loadConfig();
  pushLog("界面就绪");
  if (cfg.autoStart) {
    pushLog("自动启动服务中…");
    startAgent(cfg);
  } else {
    pushLog("已关闭自动启动，点「启动服务」手动开始");
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
  stopAgent();
});
