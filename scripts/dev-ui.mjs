/**
 * dev-ui.mjs —— 开发态一键起界面
 * 先起 Vite dev server（热更新），等端口就绪后再拉起 Electron 指向它。
 * 端口 8088 被占用时自动向后探测可用端口，避免反复报「Port is already in use」。
 * 用法：npm run ui:dev
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const BASE_PORT = 8088;

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

/**
 * 从 start 起找第一个可监听端口；被占用则 +1 继续，最多试 100 个。
 * 用 127.0.0.1 探测即可覆盖 0.0.0.0 绑定（0.0.0.0 也会占用 127.0.0.1）。
 */
function findFreePort(start) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port) => {
      if (++attempt > 100) return reject(new Error(`未找到可用端口（${start}~${start + 100} 均被占用）`));
      const srv = net.createServer();
      srv.unref();
      srv.once("error", () => tryPort(port + 1));
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, "127.0.0.1");
    };
    tryPort(start);
  });
}

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

let vite = null;
let shuttingDown = false;

// Windows 下 shell:true 的 spawn 拿到的 pid 是 cmd.exe，直接 kill 杀不掉 vite 子进程，
// 必须 taskkill /T /F 杀整棵进程树，否则退出后 vite 残留占用端口。
function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(vite?.pid);
  process.exit(code ?? 0);
}

async function main() {
  compileOnce();

  const PORT = await findFreePort(BASE_PORT);
  if (PORT !== BASE_PORT) {
    console.log(`[dev-ui] 端口 ${BASE_PORT} 已被占用，改用 ${PORT}`);
  }

  const npm = isWin ? "npm.cmd" : "npm";
  vite = spawn(npm, ["run", "ui:vite"], {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
    env: { ...process.env, UI_DEV_PORT: String(PORT) },
  });

  try {
    await waitPort(PORT);
    console.log(`[dev-ui] Vite 就绪 http://localhost:${PORT}，启动 Electron…`);
    // 用 npm 同款方式拉起 electron：把 node_modules/.bin 塞进 PATH，用裸命令名
    // electron.cmd（无空格、无绝对路径）交给 shell 解析，彻底避开「路径含空格」
    // 导致 cmd 把命令按空格拆断的问题。
    const binDir = path.join(root, "node_modules", ".bin");
    const env = {
      ...process.env,
      UI_DEV: "1",
      UI_DEV_PORT: String(PORT),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const electronCmd = isWin ? "electron.cmd" : "electron";
    const el = spawn(electronCmd, ["."], {
      cwd: root,
      stdio: "inherit",
      shell: isWin,
      env,
    });
    el.on("exit", (c) => shutdown(c ?? 0));
  } catch (e) {
    console.error("[dev-ui]", e.message);
    shutdown(1);
  }
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

main().catch((e) => {
  console.error("[dev-ui]", e.message);
  shutdown(1);
});
