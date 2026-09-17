/**
 * tools/paths.ts —— 路径安全
 *
 * 工具能读写文件、能跑 bash，必须有边界：
 *   · 一切文件操作限制在仓库根目录内（PROJECT_ROOT，即 agent 的上一级）
 *   · 禁止触碰 .git 内部与密钥类文件
 *   · **写操作**另外禁止进入 `state/` 与 `ledger/`（风控判据与账本的载体，
 *     各有带风控语义的写入口，见 `DENY_WRITE_DIRS`）
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
/** 项目根（自包含：scripts/、state/、AGENT_TRADING_RULES.md 都在 agent/ 内） */
export const PROJECT_ROOT = AGENT_ROOT;

const DENY_DIRS = [".git", "node_modules", ".venv", "__pycache__", "release", "dist"];
const DENY_FILES = [".env", ".npmrc", ".pypirc", "id_rsa", "id_ed25519", ".htpasswd"];

/**
 * **写操作**额外禁入的目录：`state/` 与 `ledger/`。
 *
 * 为什么只挡写、不挡读：这两处是**风控判据与账本的载体**，读它没有代价（LLM 要看本轮
 * 运行态），改它有。
 *
 * - `state/month_state.json` 的 `month_peak_equity` 只增不减、抬高一次不可逆
 *   （抬高峰值 = 回撤虚高 → 误熔断；清零 = 回撤虚低 → 该熔断不熔断），而它是章程 L1-6 的**分母**；
 * - `state/runtime.json` 的当日计数与 `l1_6_tripped`、`state/order_idem_<轮次>.json` 的幂等登记
 *   （章程 §6.1）、`state/reviewed_trades.json` 的复盘账本；
 * - `ledger/trades.csv` 是交易流水，只追加。
 *
 * README 的原话是「`state/month_state.json` … **只有 `scripts/archive_round.py` 会写它**」。
 * 这句话在**代码路径**上成立（扛它的是 `tests/monthguard.test.ts` 的源码调用点断言），
 * 但它看不见另一条路：LLM 手里的通用写工具。`DENY_DIRS` 里原本没有这两项，于是
 * `write_file`（以及任何拿到确认的写工具）可以直接把那几个文件覆盖成任意内容 ——
 * 唯一的拦阻是「危险工具要用户点一次确认」，而对话框里给的正是这条路径的预览。
 * **一条靠人肉确认扛着的风控边界不是边界**，所以边界划在工具层：
 * 要改这些文件，请走它们各自的写入口（`scripts/jsonstore.py` 的原子写 /
 * `scripts/archive_round.py` 的只追加），而不是让模型手写。
 *
 * 残余缺口（刻意保留、已写进 README）：`bash` 工具无法从命令文本上封死
 * （`echo > state/...`、`python -c ...` 都在它能力范围内）—— 它同样是危险工具、
 * 逐次人工确认，属于用户明确授权后的最后手段，不在这里假装堵上。
 */
const DENY_WRITE_DIRS = ["state", "ledger"];

/** 解析为绝对路径并确认落在仓库内；越界抛错 */
export function resolveSafe(
  input: string,
  opts: { mustExist?: boolean; allowDir?: boolean; forWrite?: boolean } = {}
): string {
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
  // 目录名一律按小写比：Windows 的文件名大小写不敏感，`State/x.json` 落到的是同一个
  // `state/x.json`，而 `DENY_DIRS.includes(p)` 是大小写敏感的 —— 只比原样等于给守卫留了
  // 一个 `State/` 的后门（POSIX 上这两者本来就不是同一个目录，挡掉无副作用）。
  const lowParts = parts.map((p) => p.toLowerCase());
  const deniedDir = DENY_DIRS.find((d) => lowParts.includes(d));
  if (deniedDir) {
    throw new Error(`受保护目录不可访问：${rel}`);
  }
  if (opts.forWrite) {
    const wd = DENY_WRITE_DIRS.find((d) => lowParts.includes(d));
    if (wd) {
      throw new Error(
        `${wd}/ 是风控判据与账本的载体，不接受通用写工具改写（${rel}）。` +
          `state/ 下的 JSON 请走 scripts/jsonstore.py 的原子写、轮次账本请走 ` +
          `scripts/archive_round.py 的只追加入口；确实要改请用户手工改，不要用本工具覆盖。`
      );
    }
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
