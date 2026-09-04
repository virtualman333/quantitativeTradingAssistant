/**
 * alert.ts —— 运行异常告警（稳定运行的「报警器」）
 *
 * 检测到高危事件时：① 写告警记录（state/alerts.jsonl 只追加，审计）
 * ② 经 mail_send.py 发邮件（SMTP 直连，收件人默认用户邮箱）。
 *
 * 告警记录（state/alerts.jsonl）每轮都追加，保证审计完整；
 * 邮件则去重：同一 subject 24 小时内只发一次（持久化到 state/mail_sent.json，
 * 重启仍有效），避免常驻模式每 5 分钟一轮重复刷邮件（如「裸仓」在持仓期间每轮命中）。
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, runPy } from "./okx.js";

const ALERT_LOG = path.join(ROOT, "state", "alerts.jsonl");
const MAIL_SENT = path.join(ROOT, "state", "mail_sent.json");
/** 邮件去重窗口：同 subject 24 小时内只发一次 */
const MAIL_DEDUP_MS = 24 * 60 * 60 * 1000;

function loadMailSent(): Record<string, number> {
  try {
    if (fs.existsSync(MAIL_SENT)) return JSON.parse(fs.readFileSync(MAIL_SENT, "utf8"));
  } catch {
    /* 损坏则视为无记录 */
  }
  return {};
}

export async function alert(subject: string, body: string): Promise<void> {
  // ① 写告警记录（每轮都记，完整审计；与是否发邮件解耦）
  try {
    fs.mkdirSync(path.dirname(ALERT_LOG), { recursive: true });
    fs.appendFileSync(ALERT_LOG, JSON.stringify({ ts: new Date().toISOString(), subject, body }) + "\n", "utf8");
  } catch {
    /* 记录失败不影响告警主流程 */
  }

  // ② 发邮件（去重：同 subject 24 小时内只发一次；失败不记 sent，下次重试）
  const now = Date.now();
  const sent = loadMailSent();
  if (sent[subject] && now - sent[subject] < MAIL_DEDUP_MS) return;
  try {
    const outPath = path.join(ROOT, "state", "mail_alert.json");
    fs.writeFileSync(outPath, JSON.stringify({ subject, body }), "utf8");
    const r = await runPy("mail_send.py", ["--in", "state/mail_alert.json"], 60_000);
    console.log(`[alert] ${subject}: ${r.trim()}`);
    sent[subject] = now;
    fs.writeFileSync(MAIL_SENT, JSON.stringify(sent), "utf8");
  } catch (e) {
    console.log(`[alert] 邮件发送失败（不影响交易）: ${String(e).slice(0, 160)}`);
  }
}
