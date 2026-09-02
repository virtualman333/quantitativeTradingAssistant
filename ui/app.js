/**
 * app.js —— Vue 3 应用入口
 *
 * 用 Vue 3 的 ESM 浏览器版 + importmap，无需打包即可用组件化开发。
 * Vue 文件在 ui/vendor/vue.esm-browser.prod.js（随项目携带，离线可用）。
 */
import { createApp } from "./vendor/vue.esm-browser.prod.js";
import App from "./components/App.js";

const app = createApp(App);
app.config.errorHandler = (err, _vm, info) => {
  console.error("[Vue error]", info, err);
};
app.mount("#app");
