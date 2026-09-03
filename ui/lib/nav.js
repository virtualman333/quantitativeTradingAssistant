/**
 * nav.js —— 页签共享状态
 * 用途：跨视图跳转（例如总览「查看更多」跳到行情页），无需事件总线。
 */
import { ref } from "vue";

export const tab = ref("dash");

/** 跳到某个页签（key 与 App.vue 的 tabs 对应） */
export function goTab(k) {
  tab.value = k;
}

/**
 * 待打开的 K 线标的：总览点某个交易对 → 跳到行情页并自动展开它的 K 线。
 * 行情页消费后置空，避免切回来又被重复打开。
 */
export const klineInst = ref("");
