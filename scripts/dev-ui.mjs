/**
 * dev-ui.mjs —— 开发态一键起界面
 * 先起 Vite dev server（热更新），等端口就绪后再拉起 Electron 指向它。
 * 用法：npm run ui:dev
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const PORT = 5173;

/**
 * Electron 的 package.json main = dist/electron/main.js，主进程/preload/src 全是
 * tsc 编译产物在跑。若改过 src/、electron/ 的 .ts 而不编译，界面会静默加载旧
 * preload → window.api 缺新函数（表现如「api.xxx is not a function」）。
 * 故 dev 启动前先编译三套 tsc + postbuild，保证产物与源码一致。
 */
function compileOnce() {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  console.log("[dev-ui] 编译 src / electron / preload …");
  for (const cfg of ["tsconfig.json", "tsconfig.electron.json", "tsconfig.preload.json"]) {
    const r = spawnSync(process.execPath, [tsc, "-p", cfg], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  const pb = spawnSync(process.execPath, [path.join(root, "scripts", "postbuild.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (pb.status !== 0) process.exit(pb.status ?? 1);
}
compileOnce();

function waitPort(port, timeoutMs = 90_000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net
        .connect(port, "127.0.0.1")
        .on("connect", () => {
          s.destroy();
          resolve();
        })
        .on("error", () => {
          s.destroy();
          if (Date.now() - t0 > timeoutMs) reject(new Error("Vite dev server 启动超时"));
          else setTimeout(tryOnce, 400);
        });
    };
    tryOnce();
  });
}

const npm = isWin ? "npm.cmd" : "npm";
const vite = spawn(npm, ["run", "ui:vite"], { cwd: root, stdio: "inherit", shell: isWin });

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    vite.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  process.exit(code ?? 0);
}

try {
  await waitPort(PORT);
  console.log(`[dev-ui] Vite 就绪 http://localhost:${PORT}，启动 Electron…`);
  const electronBin = path.join(root, "node_modules", ".bin", isWin ? "electron.cmd" : "electron");
  const el = spawn(electronBin, ["."], {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    env: { ...process.env, UI_DEV: "1" },
  });
  el.on("exit", (c) => shutdown(c ?? 0));
} catch (e) {
  console.error("[dev-ui]", e.message);
  shutdown(1);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
