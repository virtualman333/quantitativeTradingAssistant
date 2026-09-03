/**
 * alert.ts —— 运行异常告警（稳定运行的「报警器」）
 *
 * 检测到高危事件时：① 写告警记录（state/alerts.jsonl 只追加，审计）
 * ② 经 mail_send.py 发邮件（SMTP 直连，收件人默认用户邮箱）。
 *
 * 去重：同一 subject 在 30 分钟内只发一次，避免常驻模式每 5 分钟一轮
 * 重复刷邮件（如「裸仓」在持仓期间每轮都会命中）。
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, runPy } from "./okx.js";

const ALERT_LOG = path.join(ROOT, "state", "alerts.jsonl");
const DEDUP_MS = 30 * 60 * 1000;
const recent = new Map<string, number>();

export async function alert(subject: string, body: string): Promise<void> {
  // 去重：30 分钟内同 subject 不重复发
  const now = Date.now();
  const last = recent.get(subject);
  if (last && now - last < DEDUP_MS) return;
  recent.set(subject, now);

  // ① 写告警记录（只追加）
  try {
    fs.mkdirSync(path.dirname(ALERT_LOG), { recursive: true });
    fs.appendFileSync(ALERT_LOG, JSON.stringify({ ts: new Date().toISOString(), subject, body }) + "\n", "utf8");
  } catch {
    /* 记录失败不影响告警主流程 */
  }

  // ② 发邮件（失败只记日志，绝不因告警中断交易）
  try {
    const outPath = path.join(ROOT, "state", "mail_alert.json");
    fs.writeFileSync(outPath, JSON.stringify({ subject, body }), "utf8");
    const r = await runPy("mail_send.py", ["--in", "state/mail_alert.json"], 60_000);
    console.log(`[alert] ${subject}: ${r.trim()}`);
  } catch (e) {
    console.log(`[alert] 邮件发送失败（不影响交易）: ${String(e).slice(0, 160)}`);
  }
}
