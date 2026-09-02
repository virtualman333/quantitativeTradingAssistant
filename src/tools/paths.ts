/**
 * tools/paths.ts —— 路径安全
 *
 * 工具能读写文件、能跑 bash，必须有边界：
 *   · 一切文件操作限制在仓库根目录内（PROJECT_ROOT，即 agent 的上一级）
 *   · 禁止触碰 .git 内部与密钥类文件
 * 越界一律拒绝，不静默放行。
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * agent/ 目录。
 * 不能用固定的 `../..`：源码在 src/tools/ 而产物在 dist/src/tools/，层级不同，
 * 写死会让所有文件工具在编译后集体失效。统一按 package.json + src 向上探测。
 */
export const AGENT_ROOT = (() => {
  let d = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(d, "package.json")) && fs.existsSync(path.join(d, "src"))) return d;
    d = path.dirname(d);
  }
  return path.resolve(__dirname, "..", "..");
})();
/** 仓库根（scripts/、AGENT_TRADING_RULES.md 所在） */
export const PROJECT_ROOT = path.resolve(AGENT_ROOT, "..");

const DENY_DIRS = [".git", "node_modules", ".venv", "__pycache__", "release", "dist"];
const DENY_FILES = [".env", ".npmrc", ".pypirc", "id_rsa", "id_ed25519", ".htpasswd"];

/** 解析为绝对路径并确认落在仓库内；越界抛错 */
export function resolveSafe(input: string, opts: { mustExist?: boolean; allowDir?: boolean } = {}): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("路径为空");
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(PROJECT_ROOT, raw);
  const root = PROJECT_ROOT.toLowerCase();
  const target = abs.toLowerCase();
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`越界：只允许操作 ${PROJECT_ROOT} 内的路径（收到 ${abs}）`);
  }
  const rel = path.relative(PROJECT_ROOT, abs);
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.some((p) => DENY_DIRS.includes(p))) {
    throw new Error(`受保护目录不可访问：${rel}`);
  }
  const base = path.basename(abs).toLowerCase();
  if (DENY_FILES.some((f) => base === f || base.startsWith(f + "."))) {
    throw new Error(`敏感文件不可访问：${path.basename(abs)}`);
  }
  if (opts.mustExist && !fs.existsSync(abs)) throw new Error(`路径不存在：${rel || abs}`);
  if (!opts.allowDir && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    throw new Error(`这是目录不是文件：${rel}`);
  }
  return abs;
}

/** 转成相对仓库根的可读路径（日志/回显用） */
export function relOf(abs: string): string {
  const rel = path.relative(PROJECT_ROOT, abs);
  return rel.startsWith("..") ? abs : rel.split(path.sep).join("/");
}

export const IS_WIN = process.platform === "win32";
