/**
 * vite.config.ts —— 前端（Vue 3 SFC）构建配置
 *
 * 为什么换成构建模式（Vite + SFC）：
 *   · 之前是浏览器内运行时编译（vue.esm-browser + 字符串 template），
 *     没有类型检查、没有 SFC 作用域样式、不能用 TS/JSX，改起来全靠人肉对齐。
 *   · 构建模式后：单文件组件、可拆分模块、热更新、可加 lint/单测，扩展与维护成本大幅下降。
 *
 * 产物：dist/ui/index.html（Electron 用 file:// 加载，故 base 必须是相对路径 './'）
 */
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [vue()],
  root: r("./ui"),
  // Electron 走 file://，绝对 /assets/... 会找不到，必须相对路径
  base: "./",
  build: {
    outDir: r("./dist/ui"),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    // 端口由 dev-ui.mjs 探测后经 UI_DEV_PORT 传入（8088 被占用会自动换），
    // strictPort 保持 true，避免 Vite 自己静默换端口导致 Electron 指向错误。
    // host 固定 127.0.0.1：默认 localhost 在 Windows 会解析到 IPv6 ::1，
    // 而 dev-ui.mjs 用 127.0.0.1 探测端口就绪，两者地址族不一致会永远等不到。
    host: "127.0.0.1",
    port: Number(process.env.UI_DEV_PORT) || 8088,
    strictPort: true,
  },
});
