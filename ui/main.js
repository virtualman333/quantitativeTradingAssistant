/**
 * main.js —— 前端入口（Vite）
 * 构建产物由 Electron 以 file:// 加载，故所有资源路径必须相对（见 vite.config.ts 的 base）。
 */
import { createApp } from "vue";
import App from "./App.vue";
import "./styles/main.css";

const app = createApp(App);
app.config.errorHandler = (err, _vm, info) => {
  console.error("[Vue error]", info, err);
};
app.mount("#app");
