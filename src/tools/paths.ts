/**
 * tools/paths.ts —— 路径安全
 *
 * 工具能读写文件、能跑 bash，必须有边界：
 *   · 一切文件操作限制在仓库根目录内（PROJECT_ROOT，即 agent 的上一级）
 *   · 禁止触碰 .git 内部与密钥类文件
 *   · **写操作**另外禁止进入「风控判据与账本的载体」目录（各有带风控语义的写入口，
 *     见 `DENY_WRITE_DIRS`；禁区与仓库实际的载体目录是否对得上，由
 *     `tests/pathguard.test.ts` **现算**核对，不靠这张表自己说了算）
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
 * **写操作**额外禁入的目录 —— 「风控判据与账本的载体」。
 *
 * 为什么只挡写、不挡读：这些目录是**判据与账本的载体**，读它没有代价（LLM 要看本轮
 * 运行态、要复盘历史），改它有。
 *
 * - `state/`（L1-6 的分母 `month_state.json`：`month_peak_equity` 只增不减、抬高一次
 *   不可逆；`runtime.json` 的当日计数与 `l1_6_tripped`；`order_idem_<轮次>.json` 的
 *   幂等登记（章程 §6.1）；`reviewed_trades.json` 的复盘账本）；
 * - `ledger/`（`trades.csv` 逐笔台账，只追加）；
 * - `logs/`（`rounds.jsonl` 轮次结构化归档，**只追加、历史行永不改写**，章程 L1-7）；
 * - `data/`（`scalper_trades.jsonl` 开单记录、`scalper_ticks.jsonl` 监测记录 ——
 *   超短线战绩面板与「执行出错」桶的唯一来源；`store.json` 配置与轮次历史索引）；
 * - `news/`（`news.jsonl` 只追加审计流水，**不可改写**，章程 L1-7）。
 *
 * ⚠ 这张表**不是**「我说了算」的清单：`tests/pathguard.test.ts` 会现算两遍
 * ——「磁盘上哪些一级目录里有 json/jsonl/csv」与「源码里以 `<目录>/x.json|jsonl|csv`
 * 引用过哪些一级目录」—— 然后要求**每一个都被这张表覆盖**，或者进那张**声明式例外表**
 * 并写明理由。少一个就红。
 *
 * 这一条是补出来的：原先表里只有 `state` 与 `ledger`（手抄的两个名字），而
 * `logs/rounds.jsonl`、`data/scalper_trades.jsonl`、`news/news.jsonl` 同样是
 * 「只追加、不可改写」的账本，**通用写工具当时可以直接覆盖它们**（实测复现过）。
 * 文档里那句「写操作禁止进入风控判据与账本的载体」当时只对了一半 —— 而这半句假话
 * 比没有这句话更坏：它让人以为账本已经有人管了。
 *
 * 残余缺口（刻意保留、已写进 README）：`bash` 工具无法从命令文本上封死
 * （`echo > state/...`、`python -c ...` 都在它能力范围内）—— 它同样是危险工具、
 * 逐次人工确认，属于用户明确授权后的最后手段，不在这里假装堵上。
 */
export const DENY_WRITE_DIRS = ["state", "ledger", "logs", "data", "news"];

/**
 * 写禁区里每个目录的「该走哪个入口」—— 报错里必须点名。
 * 只说「不行」的话模型会反复重试同一个被拒的写入（这条是本仓库踩出来的）。
 * `tests/pathguard.test.ts` 会核对这张表覆盖了 `DENY_WRITE_DIRS` 的每一项。
 */
export const DENY_WRITE_HINT: Record<string, string> = {
  state: "state/ 下的 JSON 请走 scripts/jsonstore.py 的原子写（读用 read_json_state）",
  ledger: "ledger/ 的逐笔台账请走 scripts/archive_round.py 的只追加入口",
  logs: "logs/rounds.jsonl 是只追加归档，请走 scripts/archive_round.py 的只追加入口",
  data: "data/ 下的流水请走写它们的脚本（src/scalper.ts 的只追加 / store.ts 的配置写入）",
  news: "news/news.jsonl 是只追加审计流水，请走 scripts/news_db.py 的只追加入口",
};

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
          `${DENY_WRITE_HINT[wd] ?? ""}；确实要改请用户手工改，不要用本工具覆盖。`
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
