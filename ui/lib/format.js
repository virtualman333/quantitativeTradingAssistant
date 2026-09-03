/** format.js —— 展示层小工具 */
import MarkdownIt from "markdown-it";

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function nowTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtNum(v, d = 2) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export const signCls = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "");

export const STANCE_TEXT = { bullish: "看多", bearish: "看空", neutral: "中性" };

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Markdown 渲染（对话等富文本输出）。
 * html:false —— 模型输出里的裸 HTML 一律转义成文本，不会被当成标签执行；
 * breaks:true —— 单个换行也断行（聊天习惯）。
 * 渲染失败时回退为转义文本 + <br>，绝不让界面白屏。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function renderText(s) {
  const raw = String(s ?? "");
  try {
    return md.render(raw);
  } catch {
    return escapeHtml(raw).replace(/\r?\n/g, "<br>");
  }
}

export function briefArgs(args, max = 90) {
  let s = "";
  try {
    s = typeof args === "string" ? args : JSON.stringify(args ?? {});
  } catch {
    s = String(args);
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
}
