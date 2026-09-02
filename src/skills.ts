/**
 * skills.ts —— 技能系统（Skill）
 *
 * Skill = 一段可复用的确定性能力（脚本/查询/计算），供专家按需调用。
 * 与 MCP 工具的区别：
 *   · MCP 工具：外部 server 暴露的能力（okx-trade-mcp、jin10 等），动态发现
 *   · Skill   ：本项目自己沉淀的能力（已踩过坑、参数已固化），确定性更高
 *
 * 为什么要单独一层：
 *   有些能力（如「双源交叉验证」）流程固定且已经踩过坑，
 *   交给 LLM 临场发挥容易跑偏（忘了等 JS 渲染、忘了归一化数字）。
 *   固化为 Skill 后，专家只需说「调用 news_verify」即可。
 *
 * 新增 Skill：往 SKILLS 里加一项即可，专家 prompt 会自动带上能力清单。
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");

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

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** 参数说明，写进专家 prompt */
  args: string;
  /** 只读技能（不产生任何写操作） */
  readOnly: boolean;
  run(args: Record<string, unknown>): Promise<SkillResult>;
}

async function runPyScript(
  script: string,
  args: string[],
  timeoutMs = 180_000
): Promise<SkillResult> {
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

export const SKILLS: Skill[] = [
  {
    id: "market_scan",
    name: "行情扫描",
    description:
      "拉取 BTC/ETH 永续的多周期（4H/1H/15m）K线、EMA、RSI、ATR、量比、区间分位、资金费率，输出结构化 JSON。",
    args: "无参数",
    readOnly: true,
    run: async () => {
      const r = await runPyScript("market_scan.py", []);
      if (!r.ok) return r;
      // 输出可能很长，截断以省 token
      return { ok: true, output: r.output.slice(0, 12000) };
    },
  },
  {
    id: "news_fetch",
    name: "消息采集",
    description:
      "从金十数据抓取新闻/快讯/财经日历，自动分级（impact/credibility/direction）并标记需交叉验证的条目。",
    args: "{hours?:数字(默认24), limit?:数字(默认20)}",
    readOnly: true,
    run: async (a) => {
      const args = ["--out", "state/news_input.json"];
      if (a.hours) args.push("--hours", String(a.hours));
      if (a.limit) args.push("--limit", String(a.limit));
      return runPyScript("news_fetch.py", args, 240_000);
    },
  },
  {
    id: "news_verify",
    name: "消息双源交叉验证",
    description:
      "对消息中的关键数字做第二信源验证（经 playwright 抓搜索引擎）。命中则升 A 级（具备否决权），否则维持 B 级。用于满足章程 §10.3。",
    args: '{text:"消息文本", numbers?:["3.8","62.2"]}  或  {fromInput:"state/news_input.json"}',
    readOnly: true,
    run: async (a) => {
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
  },
  {
    id: "news_log",
    name: "消息入库",
    description: "把采集到的消息写入 news/news.jsonl（只追加）并生成当日投影与当轮简报。",
    args: '{dryRun?:布尔, roundId?:"R000001"}',
    readOnly: false,
    run: async (a) => {
      const args = ["--input", "state/news_input.json"];
      if (a.dryRun) args.push("--dry-run");
      if (a.roundId) args.push("--round-id", String(a.roundId));
      return runPyScript("news_log.py", args);
    },
  },
  {
    id: "order_id",
    name: "生成合规 clOrdId",
    description:
      "生成符合 OKX 规范的客户端订单 ID（字母开头、仅字母数字、≤32 位、禁 _ 与 -）。开仓前必须调用，禁止手写。",
    args: '{roundId:"R000001", seq:1, params?:{instId:"BTC-USDT-SWAP", sz:13.48}}',
    readOnly: true,
    run: async (a) => {
      const args = ["--round", String(a.roundId ?? "R000000"), "--seq", String(a.seq ?? 1)];
      if (a.params) args.push("--params", JSON.stringify(a.params));
      return runPyScript("order_id.py", args, 60_000);
    },
  },
  {
    id: "read_charter",
    name: "查阅交易章程",
    description:
      "读取 AGENT_TRADING_RULES.md 的指定章节（如 §4 开仓基准、§10 消息面、§9 风控）。专家对规则有疑问时调用。",
    args: '{section?:"§10"（不传则返回前 6000 字）, maxChars?:数字}',
    readOnly: true,
    run: async (a) => {
      const p = path.join(ROOT, "AGENT_TRADING_RULES.md");
      if (!fs.existsSync(p)) return { ok: false, output: "", error: "章程文件不存在" };
      const txt = fs.readFileSync(p, "utf8");
      const max = Number(a.maxChars ?? 6000);
      const sec = a.section ? String(a.section) : "";
      if (!sec) return { ok: true, output: txt.slice(0, max) };
      // 定位章节标题，取到下一个同级标题为止
      const idx = txt.indexOf(sec);
      if (idx === -1) return { ok: false, output: "", error: `未找到章节 ${sec}` };
      const rest = txt.slice(idx + sec.length);
      const nextH = rest.search(/\n#{1,3} /);
      return { ok: true, output: rest.slice(0, nextH > 0 ? Math.min(nextH, max) : max) };
    },
  },
];

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
