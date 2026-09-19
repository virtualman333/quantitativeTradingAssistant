/**
 * atomicwrite.ts —— 「写一个 JSON 文件」这件事的唯一实现
 *
 * 为什么需要它
 * ------------
 * `state/` 下的 JSON **不是缓存**：`runtime.json` 是 L1-6 熔断与当日止损计数的读数，
 * `round_input_*.json` 一写即交给 `archive_round.py` 归档，`mail_alert.json` 一写即交给
 * `mail_send.py` 投递。`fs.writeFileSync(file, json)` 是**先截断再写**：进程被杀、
 * 磁盘写满、或者刚好在那一刻有别的进程在读，留下的就是一份半截 JSON。
 *
 * 而这条「写一律走原子写」的约定，此前**只有 `scripts/**.py` 有人管**
 * （`tests/statewriters.test.ts` 扫的是 Python 的裸 `json.dump(`），
 * TS 侧五处 `fs.writeFileSync` 全在对账面之外 —— 其中两处（`src/main.ts` 的
 * `round_input_*` / `PENDING_APPROVAL_*`）正是最要紧的那两本。
 *
 * 第二份实现也是这里收掉的：`src/store.ts` 的 `saveStore()` 里本来就有一段
 * 「tmp + rename + Windows EPERM 退回」的原子写，但它长在函数体里，谁也复用不了 ——
 * 于是需要原子写的地方就各自再写一份（本仓「同一件事写两遍」的老毛病）。
 *
 * 用法：`writeJsonAtomic(file, data)`。它不做 schema 校验、不做字段投影，
 * 只保证「**目标文件要么是上一版内容，要么是新版内容，不存在半截这一态**」。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 临时文件路径。**必须与目标同目录**：`fs.renameSync` 只在同一个文件系统上才是原子的，
 * 写到系统临时目录再 rename，跨分区时会退化成「复制 + 删除」，中途失败照样留半截。
 * 单独抽出来是为了让「同目录」这条能被**行为断言**（而不是靠读源码找字符串）。
 */
export function tmpPathFor(file: string): string {
  return `${file}.tmp`;
}

export function writeJsonAtomic(file: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpPathFor(file);
  try {
    fs.writeFileSync(tmp, json, "utf8");
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      // Windows 下 rename 覆盖一个**正被其他进程打开**的文件会报 EPERM（本仓实测复现）。
      // 此时退回直接写：`writeFileSync` 覆盖一个只读打开的文件是没问题的。
      // 这一段原先只长在 store.ts 的 saveStore() 里，别处需要原子的地方都不知道它。
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EEXIST" || code === "EBUSY" || code === "EACCES") {
        fs.writeFileSync(file, json, "utf8");
      } else {
        throw e;
      }
    }
  } finally {
    // 失败路径不留残渣：tmp 要么已经被 rename 走了（这时 unlink 会抛，忽略），
    // 要么就是写了半截 —— 那个才是不许留下来的东西。
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 已经不在了 */
    }
  }
}
