/**
 * skills.ts —— 技能系统（Skill）
 *
 * 与专家（experts）同构的可插拔结构：
 *   · 声明式元数据（name/description/args/readOnly）在 `skills/<id>/skill.json`，
 *     程序启动扫描加载，增删改无需改 TS（可版本控制、可界面编辑）。
 *   · 执行逻辑（run）保留在下方 RUNNERS 映射：参数处理各异（固定参数/条件分支/
 *     JSON 序列化/读文件截取），不适合 JSON 化。
 *   · 若 skills/ 目录缺失或为空，SKILLS 为空（兜底不内置，避免两份定义漂移）——
 *     但**不静默**：这种「加载不到」会作为 skillRegistryIssues() 里的 registry-missing /
 *     registry-empty 报出来（安装版被打包漏掉时，这是唯一的信号）。
 *
 * 新增 Skill 两步：① 加 `skills/<id>/skill.json` ② 在 RUNNERS 注册同名 run 函数。
 * 这两步**必须成对**：只做一步不会报错，只会让这个技能静默消失（见 skillRegistryIssues）。
 * `tests/skillregistry.test.ts` 会现算核对（登记 ⇄ 实现两向对账），扫描期发现的问题
 * 由 `skillRegistryIssues()` 报出、在界面「Skill」页顶部显示。
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { AGENT_ROOT } from "./store.js";

const execFileAsync = promisify(execFile);

/**
 * ROOT = agent/ 目录（自包含）：Python 脚本在 agent/scripts/ 下，
 * 数据与章程（state/ news/ ledger/ logs/ AGENT_TRADING_RULES.md）也在 agent/ 下。
 * 用 store.js 的 AGENT_ROOT（向上探测 package.json+src），编译前后均正确。
 */
export const ROOT = AGENT_ROOT;

/** python 解释器探测（Windows 上 process.execPath 是 node，不能用，实测踩过） */
let _py: string | null = null;
function py(): string {
  if (_py) return _py;
  for (const c of ["python", "py", "python3"]) {
    try {
      execFileSync(c, ["-c", "import sys;sys.stdout.write('ok')"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      });
      _py = c;
      return c;
    } catch {
      /* 试下一个 */
    }
  }
  _py = "python";
  return _py;
}

export interface SkillResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** 声明式定义（skills/<id>/skill.json） */
export interface SkillDef {
  id: string;
  name: string;
  description: string;
  args: string;
  readOnly: boolean;
}

/** 完整 Skill = 元数据 + 执行逻辑 */
export interface Skill extends SkillDef {
  run(args: Record<string, unknown>): Promise<SkillResult>;
}

type SkillRunner = (args: Record<string, unknown>) => Promise<SkillResult>;

async function runPyScript(script: string, args: string[], timeoutMs = 180_000): Promise<SkillResult> {
  try {
    const r = await execFileAsync(py(), [path.join("scripts", script), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    return { ok: true, output: r.stdout };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, output: "", error: (err.stderr || err.message || "").slice(0, 800) };
  }
}

// ── 执行逻辑：id -> run 函数（参数处理保留在代码，不 JSON 化） ──
const RUNNERS: Record<string, SkillRunner> = {
  market_scan: async () => {
    const r = await runPyScript("market_scan.py", []);
    if (!r.ok) return r;
    return { ok: true, output: r.output.slice(0, 12000) };
  },
  news_query: async (a) => {
    const args = ["--query"];
    if (a.hours) args.push("--hours", String(a.hours));
    if (a.minCred) args.push("--min-cred", String(a.minCred));
    if (a.limit) args.push("--limit", String(a.limit));
    return runPyScript("news_db.py", args, 60_000);
  },
  news_fetch: async (a) => {
    const args = ["--out", "state/news_input.json"];
    if (a.hours) args.push("--hours", String(a.hours));
    if (a.limit) args.push("--limit", String(a.limit));
    return runPyScript("news_fetch.py", args, 240_000);
  },
  news_verify: async (a) => {
    if (a.fromInput) {
      return runPyScript(
        "news_verify.py",
        ["--from-input", String(a.fromInput), "--out", "state/news_verify.json"],
        300_000
      );
    }
    if (!a.text) return { ok: false, output: "", error: "缺少 text 参数" };
    const nums = Array.isArray(a.numbers) ? (a.numbers as string[]) : [];
    const args = ["--text", String(a.text)];
    if (nums.length) args.push("--numbers", ...nums.map(String));
    return runPyScript("news_verify.py", args, 300_000);
  },
  polymarket_sentiment: async (a) => {
    const args = [];
    if (a.limit) args.push("--limit", String(a.limit));
    return runPyScript("polymarket_sentiment.py", args, 120_000);
  },
  backtest: async (a) => {
    const args = [];
    if (a.inst) args.push("--inst", String(a.inst));
    if (a.hours) args.push("--hours", String(a.hours));
    return runPyScript("backtest.py", args, 300_000);
  },
  news_log: async (a) => {
    const args = ["--input", "state/news_input.json"];
    if (a.dryRun) args.push("--dry-run");
    if (a.roundId) args.push("--round-id", String(a.roundId));
    return runPyScript("news_log.py", args);
  },
  order_id: async (a) => {
    const args = ["--round", String(a.roundId ?? "R000000"), "--seq", String(a.seq ?? 1)];
    if (a.params) args.push("--params", JSON.stringify(a.params));
    return runPyScript("order_id.py", args, 60_000);
  },
  cross_market: async (a) => {
    const args = [];
    if (a.hours) args.push("--hours", String(a.hours));
    return runPyScript("cross_market.py", args, 300_000);
  },
  deviation_stats: async (a) => {
    const args = [];
    if (a.list) args.push("--list");
    if (a.round) args.push("--round", String(a.round));
    if (a.json) args.push("--json");
    return runPyScript("deviation_stats.py", args, 60_000);
  },
  factor_analysis: async (a) => {
    const args = [];
    if (a.hours) args.push("--hours", String(a.hours));
    return runPyScript("factor_analysis.py", args, 300_000);
  },
  funding_backtest: async (a) => {
    const args = [];
    if (a.inst) args.push("--inst", String(a.inst));
    if (a.hours) args.push("--hours", String(a.hours));
    return runPyScript("funding_backtest.py", args, 300_000);
  },
  report: async (a) => {
    const args = [];
    if (a.daily) args.push("--daily", String(a.daily));
    if (a.weeklyEnd) args.push("--weekly-end", String(a.weeklyEnd));
    if (a.json) args.push("--json");
    return runPyScript("report.py", args, 60_000);
  },
  review_trade: async (a) => {
    const args = [];
    if (a.commit) {
      if (!a.input) return { ok: false, output: "", error: "commit 复盘需要 input 参数" };
      args.push("--commit", "--input", String(a.input));
    } else if (a.stats) {
      args.push("--stats");
    } else {
      args.push("--prepare");
    }
    return runPyScript("review_trade.py", args, 60_000);
  },
  read_charter: async (a) => {
    const p = path.join(ROOT, "AGENT_TRADING_RULES.md");
    if (!fs.existsSync(p)) return { ok: false, output: "", error: "章程文件不存在" };
    const txt = fs.readFileSync(p, "utf8");
    const max = Number(a.maxChars ?? 6000);
    const sec = a.section ? String(a.section) : "";
    if (!sec) return { ok: true, output: txt.slice(0, max) };
    const idx = txt.indexOf(sec);
    if (idx === -1) return { ok: false, output: "", error: `未找到章节 ${sec}` };
    const rest = txt.slice(idx + sec.length);
    const nextH = rest.search(/\n#{1,3} /);
    return { ok: true, output: rest.slice(0, nextH > 0 ? Math.min(nextH, max) : max) };
  },
};

// ── 扫描加载（同 experts.loadExpertDefs 的结构） ──
const SKILLS_DIR = path.join(AGENT_ROOT, "skills");

/**
 * 注册表自检项。**扫描期的每一次「静默丢弃」都要在这里留下一条。**
 *
 * 原实现有三处静默，任何一处都不会报错、不会打日志、界面也不会显示异常：
 *   ① `skill.json` 解析失败 → `catch {}` 直接忽略；
 *   ② 有 `skill.json` 但没有同名 `RUNNERS` → 该技能从 `SKILLS` 里**凭空消失**，
 *      专家 prompt、界面清单、`run_skill` 全都看不到它（只因少写了一个 run 函数）；
 *   ③ `RUNNERS` 里有实现、`skills/` 下没有对应登记 → 死代码，永远调不到。
 * 后果是「界面显示 14 个、实际能跑 13 个」这种账面上看不出来的偏差。
 */
export type SkillIssueKind =
  | "registry-missing"
  | "registry-empty"
  | "broken-json"
  | "id-mismatch"
  | "missing-runner"
  | "orphan-runner";

export interface SkillIssue {
  kind: SkillIssueKind;
  /** 出问题的位置（目录名 / 文件路径 / runner id） */
  where: string;
  detail: string;
}

const ISSUES: SkillIssue[] = [];

function scanSkillDefs(): SkillDef[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    ISSUES.push({
      kind: "registry-missing",
      where: SKILLS_DIR,
      detail: "skills/ 目录不存在 —— 技能注册表会是空的（安装版被打包漏掉时就是这个样子）",
    });
    return [];
  }
  const out: SkillDef[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR).sort()) {
    const full = path.join(SKILLS_DIR, entry);
    if (fs.statSync(full).isDirectory()) {
      const jp = path.join(full, "skill.json");
      if (!fs.existsSync(jp)) {
        ISSUES.push({
          kind: "broken-json",
          where: `skills/${entry}`,
          detail: "目录下没有 skill.json —— 该技能不会被加载",
        });
        continue;
      }
      try {
        const def = JSON.parse(fs.readFileSync(jp, "utf8")) as SkillDef;
        if (def.id !== entry) {
          ISSUES.push({
            kind: "id-mismatch",
            where: `skills/${entry}/skill.json`,
            detail: `id="${def.id}" 与目录名 "${entry}" 不一致（按目录名找它的人会找不到）`,
          });
        }
        out.push(def);
      } catch (e) {
        ISSUES.push({
          kind: "broken-json",
          where: `skills/${entry}/skill.json`,
          detail: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
      continue;
    }
    if (entry.endsWith(".json")) {
      try {
        out.push(JSON.parse(fs.readFileSync(full, "utf8")) as SkillDef);
      } catch (e) {
        ISSUES.push({
          kind: "broken-json",
          where: `skills/${entry}`,
          detail: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }
  if (!out.length) {
    ISSUES.push({
      kind: "registry-empty",
      where: SKILLS_DIR,
      detail: "skills/ 下没扫到任何一个可用定义 —— 技能与依赖技能的专家能力会全部为空",
    });
  }
  return out;
}

const SCANNED: SkillDef[] = scanSkillDefs();

/** 组装：元数据来自 JSON，执行逻辑来自 RUNNERS（id 匹配） */
export const SKILLS: Skill[] = SCANNED.map((d) => {
  const runner = RUNNERS[d.id];
  if (!runner) {
    ISSUES.push({
      kind: "missing-runner",
      where: `skills/${d.id}`,
      detail: `${d.id} 登记了元数据但 RUNNERS 里没有同名实现 → 该技能被静默丢弃`,
    });
    return null;
  }
  return { ...d, run: runner } as Skill;
}).filter((s): s is Skill => s !== null);

// RUNNERS 里没有任何 skill.json 指向的实现 = 死代码（写完了但没人调得到）
for (const id of Object.keys(RUNNERS)) {
  if (!SCANNED.some((d) => d.id === id)) {
    ISSUES.push({
      kind: "orphan-runner",
      where: `RUNNERS.${id}`,
      detail: "有实现但 skills/ 下没有对应登记 → 该实现永远走不到",
    });
  }
}

/** 注册表自检结果（空数组 = 干净）。界面与启动自检都读它。 */
export function skillRegistryIssues(): SkillIssue[] {
  return ISSUES.map((i) => ({ ...i }));
}

/** 自检结果的一行式描述（给人看 / 打日志用） */
export function skillRegistryReport(): string[] {
  return ISSUES.map((i) => `[skill:${i.kind}] ${i.where} —— ${i.detail}`);
}

export function getSkill(id: string): Skill | undefined {
  return SKILLS.find((s) => s.id === id);
}

/** 生成给专家 prompt 用的能力清单 */
export function skillCatalog(): string {
  return SKILLS.map(
    (s) =>
      `- ${s.id}（${s.name}${s.readOnly ? "" : "，⚠写操作"}）：${s.description}\n  参数：${s.args}`
  ).join("\n");
}

/**
 * 一行式技能清单（给工具描述用）。
 *
 * 存在的理由：`run_skill` 的工具描述曾经是**手抄**的 6 个技能名，而注册表里有 15 个 ——
 * 模型只会调描述里提到的那几个，剩下 9 个（回测 / 复盘 / 报告 / 因子 / 跨市场 …）
 * 在对话里等于不存在。手抄的清单不会响，现算的才会。
 */
export function skillMenu(): string {
  if (!SKILLS.length) {
    const why = ISSUES.length ? `（注册表异常：${ISSUES[0].detail}）` : "（注册表为空）";
    return `none ${why}`;
  }
  return SKILLS.map((s) => `${s.id}(${s.name})`).join(", ");
}
