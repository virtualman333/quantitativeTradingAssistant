/**
 * feedback.js —— 全局提示与确认
 *
 * 为什么不用原生 alert/confirm：
 *   · Electron 里原生弹窗会阻塞窗口，且样式与界面割裂；
 *   · 原生 alert 无法承载多行错误（IPC 报错常常是长文本）；
 *   · 以前大量操作失败后「静默」，用户只看到「点了没反应」，这里统一收口。
 */
import { reactive } from "vue";
import { errText } from "./api.js";

export const toasts = reactive([]);
let seq = 0;

export function toast(msg, type = "info", ms = 4200) {
  const id = ++seq;
  toasts.push({ id, msg: String(msg ?? ""), type });
  if (toasts.length > 6) toasts.splice(0, toasts.length - 6);
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, ms);
  return id;
}

export const toastOk = (msg) => toast(msg, "ok");
export const toastWarn = (msg) => toast(msg, "warn", 6000);
export const toastErr = (e, prefix = "操作失败") => toast(`${prefix}：${errText(e)}`, "err", 9000);

/** 统一的「做事并提示」包装：失败不再静默 */
export async function runOp(fn, { ok, fail = "操作失败", silent = false } = {}) {
  try {
    const r = await fn();
    if (ok && !silent) toastOk(ok);
    return r;
  } catch (e) {
    console.error("[runOp]", e);
    toastErr(e, fail);
    return undefined;
  }
}

// ── 确认框（自定义模态，非原生 confirm） ──────────────────
export const confirmBox = reactive({
  open: false,
  title: "确认",
  message: "",
  confirmText: "确定",
  danger: false,
  _resolve: null,
});

export function ask(message, { title = "确认", confirmText = "确定", danger = false } = {}) {
  return new Promise((resolve) => {
    // 同时只允许一个确认框，后到的直接驳回避免状态错乱
    if (confirmBox._resolve) confirmBox._resolve(false);
    confirmBox.title = title;
    confirmBox.message = message;
    confirmBox.confirmText = confirmText;
    confirmBox.danger = danger;
    confirmBox.open = true;
    confirmBox._resolve = resolve;
  });
}

export function answerConfirm(v) {
  const r = confirmBox._resolve;
  confirmBox.open = false;
  confirmBox._resolve = null;
  r?.(v);
}
