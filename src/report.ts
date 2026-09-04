/**
 * report.ts — 轮次报告（LLM 生成 HTML）
 *
 * 每轮归档后，让 LLM 根据本轮数据「智能生成」HTML 报告：
 *   reports/<round_id>/summary.html  汇总：全部信息 + 决策要点
 *   reports/<round_id>/<expert>.html 每个角色独立 HTML
 *   reports/index.html               每轮记录表（确定性聚合，TS 生成）
 *
 * 职责边界（用户定）：HTML 的语义/排版/解读交给 LLM，不写死模板；
 * 落盘与 index 聚合是确定性的，留在 TS。
 */
import fs from "node:fs";
import path from "node:path";
import { AGENT_ROOT, resolveModel } from "./store.js";
import { createProvider, type LlmProvider } from "./llm.js";

const REPORTS_DIR = path.join(AGENT_ROOT, "reports");
const ROUNDS_JSONL = path.join(AGENT_ROOT, "logs", "rounds.jsonl");

/** 与 main.ts 归档 payload 对齐的轮次数据结构 */
export interface RoundReportPayload {
  round_id: string;
  time_cst: string;
  interval?: string;
  env?: string;
  equity_usdt?: number;
  available_usdt?: number;
  positions?: Record<string, unknown>[];
  live_watch?: unknown[];
  actions?: string[];
  decision?: string;
  decision_type?: string;
  risk_tier?: string;
  market_summary?: string;
  deviations?: unknown[];
  experts?: { expert: string; stance: string; summary: string }[];
  conflicts?: string[];
  exec_results?: string[];
}

const SYS = `You are a professional quantitative-trading review report generator. Your task is to organize the given "this round's trading data" into a well-structured, visually polished HTML report.

[Output format — must follow strictly]
Output multiple HTML blocks, each separated by one "section marker" line:

<!-- REPORT:summary -->
<!doctype html>...summary page full HTML...</html>

<!-- REPORT:expert trading -->
<!doctype html>...trading role page full HTML...</html>

<!-- REPORT:expert news -->
...

Rules:
1. Each block must be a complete, standalone HTML document (with <!doctype html>, inline <style> in <head>, and <body>).
2. The section marker is on its own line, strictly in the form <!-- REPORT:summary --> or <!-- REPORT:expert <role-id> -->.
3. The number and order of role blocks must exactly match the experts array in the input, using the role id verbatim.
4. Besides the HTML blocks and section markers, output nothing else (no explanation, no code fences, no extra blank lines).

[Visual spec]
- Dark trading-terminal style: background #0f1420, card #161c2a, border #262f42, body #d8e0ee, secondary #8892a6.
- Accent colors: up/bullish/open/baseline=#2ecc71, down/bearish/close/defensive=#ff5f56, neutral/stand-by=#8892a6, blue=#4da3ff, yellow/aggressive=#ffb454.
- Card sections, grid layout for metrics, tables for positions & deviations, colored rounded tags for decision type / risk tier / stance. Inline styles only, no external resources.

[Summary page must contain, in order]
1. Header: round, time, environment.
2. Account state: total equity, available margin.
3. Position details: table (instrument / direction / size / entry / mark / leverage / uPnL); write "no positions" if none.
4. This round's actions: list actions; write "stand-by" if none.
5. Decision highlights: decision type and risk tier as colored tags, then the full decision text.
6. Expert conflicts (conflicts): if any.
7. Execution results (exec_results): if any.
8. Each role's opinion: one line per role (stance tag + summary), linking to <role-id>.html.
9. Discretionary deviations (deviations): if any, as a table (baseline / actual / rationale / falsifier / risk delta).
10. Market snapshot (market_summary): collapsible.

[Role page expert <id> must contain]
1. Header: round, time, role name.
2. Stance: the role's stance as a colored tag.
3. Full opinion: the role's full summary.
4. A link back to summary.html.

[Language] All user-facing text (titles, body, tags, legends, buttons) must be in Simplified Chinese; keep data identifiers (instruments, field names) as-is.

[Data safety] The input text may contain characters like < > & ; escape them when embedding into HTML to avoid breaking structure.`;

function escHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 把 LLM 输出按分节标记拆成 summary + 各角色 HTML */
function splitBlocks(raw: string): { summary?: string; experts: Record<string, string> } {
  const out: { summary?: string; experts: Record<string, string> } = { experts: {} };
  const re = /<!--\s*REPORT:(summary|expert)\s*([\w-]*)\s*-->/g;
  const marks: { kind: string; id: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    marks.push({ kind: m[1], id: m[2] || "", start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const contentStart = marks[i].end;
    const contentEnd = i + 1 < marks.length ? marks[i + 1].start : raw.length;
    const html = raw.slice(contentStart, contentEnd).trim();
    if (!html) continue;
    if (marks[i].kind === "summary") out.summary = html;
    else if (marks[i].id) out.experts[marks[i].id] = html;
  }
  return out;
}

/** 写文件（确保目录存在） */
function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function wrapHtml(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escHtml(
    title
  )}</title><style>
body{margin:0;background:#0f1420;color:#d8e0ee;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.6;padding:32px 20px}
.card{background:#161c2a;border:1px solid #262f42;border-radius:10px;padding:16px 18px;margin-bottom:14px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px;color:#d8e0ee}
.sub{color:#8892a6;font-size:13px}.muted{color:#8892a6}
a{color:#4da3ff;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body><h1>${escHtml(title)}</h1><div class="card">${bodyHtml}</div></body></html>`;
}

interface RoundRow {
  round_id: string;
  time_cst: string;
  env: string;
  equity: string;
  dt: string;
  rt: string;
  decision: string;
  nExp: number;
}

/** 从 rounds.jsonl 读全部轮次（精简字段） */
function readRounds(): RoundRow[] {
  if (!fs.existsSync(ROUNDS_JSONL)) return [];
  const rows: RoundRow[] = [];
  const lines = fs.readFileSync(ROUNDS_JSONL, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      rows.push({
        round_id: String(r.round_id ?? ""),
        time_cst: String(r.time_cst ?? ""),
        // 旧体系 env 字段曾塞入整段降级说明（含 — 与换行），这里只留环境名
        env: String(r.env ?? "demo").replace(/\s+/g, " ").replace(/\s*—.*$/, "").trim().slice(0, 24),
        equity: r.equity_usdt != null ? Number(r.equity_usdt).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—",
        dt: r.decision_type ? String(r.decision_type) : "",
        rt: r.risk_tier ? String(r.risk_tier) : "",
        decision: String(r.decision ?? "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").slice(0, 60),
        nExp: Array.isArray(r.experts) ? r.experts.length : 0,
      });
    } catch {
      /* 跳过坏行 */
    }
  }
  return rows;
}

/** 生成记录表 index.html（确定性聚合，非 LLM） */
function renderIndex(): void {
  const rows = readRounds();
  const DT: Record<string, string> = { OPEN: "开仓", HOLD: "持有", CLOSE: "平仓", STANDBY: "观望" };
  const RT: Record<string, string> = { BASE: "基准", AGG: "进攻", DEF: "防守" };
  const body = rows
    .slice()
    .reverse()
    .map((r) => {
      const tags =
        (r.dt ? `<span class="t">${escHtml(DT[r.dt] || r.dt)}</span>` : "") +
        (r.rt ? `<span class="t ${r.rt === "DEF" ? "def" : r.rt === "AGG" ? "agg" : ""}">${escHtml(RT[r.rt] || r.rt)}</span>` : "");
      return (
        `<tr><td class="mono">${escHtml(r.round_id)}</td>` +
        `<td class="mono">${escHtml(r.time_cst)}</td>` +
        `<td>${escHtml(r.env)}</td><td>${escHtml(r.equity)}</td>` +
        `<td>${tags}</td><td class="muted">${escHtml(r.decision)}</td>` +
        `<td><a href="${escHtml(r.round_id)}/summary.html">汇总</a>` +
        (r.nExp ? ` · <span class="muted">${r.nExp} 角色</span>` : "") +
        `</td></tr>`
      );
    })
    .join("");
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>轮次记录表</title><style>
body{margin:0;background:#0f1420;color:#d8e0ee;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6}
.wrap{max-width:1100px;margin:0 auto;padding:24px 20px 60px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#8892a6;font-size:13px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:13px;background:#161c2a;border:1px solid #262f42;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #262f42;vertical-align:top}
th{color:#8892a6;font-size:12px;white-space:nowrap}
tr:hover td{background:#1c2333}
a{color:#4da3ff;text-decoration:none}a:hover{text-decoration:underline}
.mono{font-family:Consolas,monospace}.muted{color:#8892a6}
.t{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;background:rgba(136,146,166,.15);color:#8892a6;margin-right:4px}
.t.agg{background:rgba(255,180,84,.15);color:#ffb454}.t.def{background:rgba(255,95,86,.15);color:#ff5f56}
</style></head><body><div class="wrap">
<h1>轮次记录表</h1><div class="sub">共 ${rows.length} 轮</div>
<table><thead><tr><th>轮次</th><th>时间</th><th>环境</th><th>权益(USDT)</th><th>决策</th><th>决策要点</th><th>详情</th></tr></thead>
<tbody>${body}</tbody></table></div></body></html>`;
  write(path.join(REPORTS_DIR, "index.html"), html);
}

/** 读 rounds.jsonl 的完整数据（供批量补生成用） */
function readRoundsRaw(): RoundReportPayload[] {
  if (!fs.existsSync(ROUNDS_JSONL)) return [];
  const rows: RoundReportPayload[] = [];
  for (const line of fs.readFileSync(ROUNDS_JSONL, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      rows.push(JSON.parse(line) as RoundReportPayload);
    } catch {
      /* 跳过坏行 */
    }
  }
  return rows;
}

/** 生成单轮报告：LLM 出 HTML，TS 落盘并刷新 index。useLlm=false 时跳过 LLM 走纯数据兜底页 */
export async function generateRoundReport(payload: RoundReportPayload, useLlm = true, refreshIndex = true): Promise<void> {
  // 兜底：无专家/无模型时也产出最小汇总页，保证「每轮都有详情」
  const experts = payload.experts ?? [];
  let summaryHtml = "";
  const expertHtmls: Record<string, string> = {};

  if (useLlm) {
    try {
      const llm: LlmProvider | null = (() => {
        try {
          return createProvider(resolveModel(undefined, true));
        } catch {
          return null;
        }
      })();

      if (llm) {
        const user = JSON.stringify(payload, null, 2);
        const raw = await llm.complete(SYS, `Please generate a report for the following round data:\n\n${user}`);
        const blocks = splitBlocks(raw);
        if (blocks.summary) summaryHtml = blocks.summary;
        Object.assign(expertHtmls, blocks.experts);
      }
    } catch (e) {
      // 生成失败不阻塞交易；落一个纯数据兜底页
      summaryHtml = "";
      console.log(`[report] 生成失败（回退纯数据页）: ${String(e).slice(0, 180)}`);
    }
  }

  const rid = payload.round_id || "ROUND";
  const dir = path.join(REPORTS_DIR, rid);

  // 汇总页：优先 LLM 结果，否则用纯数据兜底
  if (!summaryHtml) {
    const pos = (payload.positions ?? [])
      .map((p) => `<li>${escHtml((p as any).instrument)} ${escHtml((p as any).side)} ${escHtml((p as any).size_contracts)} 张</li>`)
      .join("") || "<li>无持仓</li>";
    const acts = (payload.actions ?? []).map((a) => `<li>${escHtml(a)}</li>`).join("") || "<li>观望</li>";
    summaryHtml = wrapHtml(
      `汇总 · ${rid}`,
      `<div class="sub">${escHtml(payload.time_cst)}</div>` +
        `<h2>账户状态</h2><p>总权益 ${escHtml(payload.equity_usdt)} USDT ｜ 可用 ${escHtml(payload.available_usdt)} USDT</p>` +
        `<h2>持仓明细</h2><ul>${pos}</ul>` +
        `<h2>本轮操作</h2><ul>${acts}</ul>` +
        `<h2>决策要点</h2><p>${escHtml(payload.decision)}</p>`
    );
  }
  write(path.join(dir, "summary.html"), summaryHtml);

  // 各角色页：优先 LLM 结果，否则纯数据兜底
  for (const e of experts) {
    const id = String(e.expert || "").trim();
    if (!id) continue;
    const html = expertHtmls[id] ?? wrapHtml(
      `角色 ${id} · ${rid}`,
      `<div class="sub">${escHtml(payload.time_cst)}</div>` +
        `<h2>立场</h2><p>${escHtml(e.stance)}</p>` +
        `<h2>完整观点</h2><p>${escHtml(e.summary)}</p>` +
        `<a href="summary.html">← 返回汇总</a>`
    );
    write(path.join(dir, `${id}.html`), html);
  }

  if (refreshIndex) renderIndex();
}

/** 界面可查看的一份 HTML 文档（汇总页 / 某个角色页） */
export interface RoundDoc {
  key: string; // summary 或角色 id
  label: string; // 汇总 / 角色 id
  path: string;
  size: number;
  mtime: string; // ISO
}

/** 界面轮次列表的一行 */
export interface RoundReportItem {
  round_id: string;
  time_cst: string;
  env: string;
  equity_usdt: number | null;
  decision_type: string;
  risk_tier: string;
  decision: string;
  n_positions: number;
  docs: RoundDoc[];
}

/** 记录表 index.html 的绝对路径（界面「总记录表」用） */
export function indexPath(): string {
  return path.join(REPORTS_DIR, "index.html");
}

/** docs 排序：汇总在最前，其余按角色名 */
function sortDocs(files: string[]): string[] {
  return files.slice().sort((a, b) => {
    const an = a.toLowerCase().replace(/\.html$/, "");
    const bn = b.toLowerCase().replace(/\.html$/, "");
    if (an === "summary") return -1;
    if (bn === "summary") return 1;
    return an.localeCompare(bn);
  });
}

/** 扫描 reports/<round_id>/ 下的全部 HTML，返回可直接在界面里查看的轮次列表 */
export function listRoundReports(): RoundReportItem[] {
  const meta = new Map<string, RoundReportPayload>();
  for (const r of readRoundsRaw()) {
    const id = String(r.round_id ?? "").trim();
    if (id) meta.set(id, r);
  }

  const items: RoundReportItem[] = [];
  if (!fs.existsSync(REPORTS_DIR)) return items;

  for (const name of fs.readdirSync(REPORTS_DIR)) {
    // 只认轮次目录（daily/weekly 是 report.py 的 Markdown 报表，不算轮次报告）
    if (!/^R\d+$/i.test(name)) continue;
    const dir = path.join(REPORTS_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".html"))
      .filter((f) => fs.statSync(path.join(dir, f)).isFile());
    if (!files.length) continue;

    const docs: RoundDoc[] = sortDocs(files).map((f) => {
      const st = fs.statSync(path.join(dir, f));
      const key = f.replace(/\.html$/i, "");
      return {
        key,
        label: key.toLowerCase() === "summary" ? "汇总" : key,
        path: path.join(dir, f),
        size: st.size,
        mtime: st.mtime.toISOString(),
      };
    });

    const m = meta.get(name);
    items.push({
      round_id: name,
      time_cst: String(m?.time_cst ?? ""),
      env: String(m?.env ?? "demo").replace(/\s+/g, " ").trim().slice(0, 24),
      equity_usdt: m?.equity_usdt != null ? Number(m.equity_usdt) : null,
      decision_type: String(m?.decision_type ?? ""),
      risk_tier: String(m?.risk_tier ?? ""),
      decision: String(m?.decision ?? "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").slice(0, 120),
      n_positions: (m?.positions ?? []).length,
      docs,
    });
  }

  // 新轮次在前
  items.sort((a, b) => (b.time_cst || b.round_id).localeCompare(a.time_cst || a.round_id));
  return items;
}

/** 用 LLM 重新生成指定轮次的 HTML 报告（覆盖现有文件），成功返回 true */
export async function regenerateRound(roundId: string): Promise<boolean> {
  const rid = String(roundId ?? "").trim();
  if (!rid) return false;
  const row = readRoundsRaw().find((r) => String(r.round_id ?? "").trim() === rid);
  if (!row) return false;
  await generateRoundReport(row, true);
  return true;
}

/** 为「归档里有、但还没有 HTML」的历史轮次补纯数据兜底页（不耗 token），返回补生成数量 */
export async function ensureRoundReports(): Promise<number> {
  let n = 0;
  for (const r of readRoundsRaw()) {
    const rid = String(r.round_id ?? "").trim();
    if (!rid) continue;
    if (fs.existsSync(path.join(REPORTS_DIR, rid, "summary.html"))) continue;
    await generateRoundReport(r, false, false);
    n++;
  }
  renderIndex();
  return n;
}

/**
 * 批量补生成所有历史轮次的详情页（默认 useLlm=false，纯数据兜底、不耗 token），
 * 让 index 里每条记录都能点开详情；已存在的轮次跳过。启动时调用一次即可。
 */
export async function generateAllReports(useLlm = false): Promise<number> {
  const rows = readRoundsRaw();
  for (const r of rows) {
    const rid = String(r.round_id || "ROUND");
    if (fs.existsSync(path.join(REPORTS_DIR, rid, "summary.html"))) continue;
    await generateRoundReport(r, useLlm);
  }
  renderIndex();
  return rows.length;
}
