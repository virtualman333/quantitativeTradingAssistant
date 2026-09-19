/**
 * atomicwrite.test.ts —— `state/` 下的写：**原子**这两个字到底管住了什么
 *
 * 为什么需要这份测试
 * ------------------
 * `fs.writeFileSync(file, json)` 是先截断再写。进程被杀、磁盘写满、或者刚好在那一刻
 * 有别的进程在读（`archive_round.py` 就是被 `src/main.ts` 紧接着叫起来的），
 * 留下的就是一份半截 JSON —— 现场看过它的形状（`{"clOrdId": "okxr16n1t12345", "round_id": "R0000`）。
 *
 * 而这条约定此前**只有 `scripts/**.py` 有人管**（`statewriters.test.ts` 扫 Python 的裸
 * `json.dump(`）。TS 侧五处 `fs.writeFileSync` 一个都不在对账面里，其中 `src/main.ts`
 * 那两处正是最要紧的（`round_input_*` 喂归档、`PENDING_APPROVAL_*` 等人确认）。
 *
 * 本文件只钉 `writeJsonAtomic()` 自己的契约：
 *   A. 成功：自动建目录、内容是格式化 JSON、**不留 `.tmp`**；
 *   B. 覆盖：旧内容被换掉，同样不留 `.tmp`；
 *   C. 失败：目标不可替换时**抛错、原物不受损、且不留 `.tmp` 残渣**；
 *   D. 反向对照：同一个失败场景下，改之前那种「裸写 + rename」会留下残渣 ——
 *      证明 C 那条断言真的在管一件事，不是恒真；
 *   E. 写盘是**替换**而不是**覆写**：目标 inode 必须换掉。把 `renameSync` 换成
 *      `copyFileSync`（照样经过 tmp、照样不留残渣）时**只有这一条会红** ——
 *      A/B/C/D 全绿，实测过。
 *
 * 运行：pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { tmpPathFor, writeJsonAtomic } from "../src/atomicwrite.ts";

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "qta-atomic-"));
const tmpsIn = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("临时文件与目标同目录", () => {
  it("tmpPathFor 与目标同目录（跨分区 rename 就不是原子的了）", () => {
    const file = path.join("E:", "some", "where", "runtime.json");
    assert.equal(path.dirname(tmpPathFor(file)), path.dirname(file));
    assert.equal(path.basename(tmpPathFor(file)), "runtime.json.tmp");
  });
});

describe("A/B：写得进去，且不留残渣", () => {
  it("目录不存在时自动建，内容是格式化 JSON，读完不留 .tmp", () => {
    const dir = sandbox();
    const file = path.join(dir, "state", "round_input_R000001.json");

    writeJsonAtomic(file, { round_id: "R000001", equity: 1234.5 });

    assert.ok(fs.existsSync(file), "文件没落盘");
    const text = fs.readFileSync(file, "utf8");
    assert.deepEqual(JSON.parse(text), { round_id: "R000001", equity: 1234.5 });
    assert.equal(text, JSON.stringify({ round_id: "R000001", equity: 1234.5 }, null, 2));
    assert.deepEqual(tmpsIn(path.dirname(file)), [], "原子写留下了临时文件");
  });

  it("覆盖已存在的文件：旧内容换新内容，同样不留 .tmp", () => {
    const dir = sandbox();
    const file = path.join(dir, "runtime.json");
    fs.writeFileSync(file, JSON.stringify({ day_sl_count: 3 }), "utf8");

    writeJsonAtomic(file, { day_sl_count: 4, circuit_breaker: null });

    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      day_sl_count: 4,
      circuit_breaker: null,
    });
    assert.deepEqual(tmpsIn(dir), [], "覆盖之后留下了临时文件");
  });

  /**
   * 「写盘真的经过 tmp」这条**必须单独钉**：把 `renameSync` 换成直接写目标，
   * 上面所有断言照样全绿（没有 tmp 就不会留 tmp），而原子性已经没了。
   * 哨兵法能把它抓出来 —— 预置在 tmp 路径上的那个文件必须被吞掉。
   */
  it("写盘确实经过 tmp：预置在 tmp 路径上的哨兵会被吞掉（否则就不是原子写）", () => {
    const dir = sandbox();
    const file = path.join(dir, "runtime.json");
    fs.writeFileSync(tmpPathFor(file), "SENTINEL", "utf8");

    writeJsonAtomic(file, { day_sl_count: 1 });

    assert.ok(
      !fs.existsSync(tmpPathFor(file)),
      "tmp 路径上的哨兵还在 —— 这次写**根本没经过临时文件**（直接覆盖目标就是非原子的）"
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { day_sl_count: 1 });
  });

  /**
   * 「经过 tmp」还不够 —— `writeFileSync(tmp)` + `copyFileSync(tmp, file)` 同样经过 tmp，
   * 同样不留残渣，但它是**原地覆写**：目标被截断再逐块写入，这中间任何读者拿到的
   * 都是半截文件。原子性的本体是 **rename 把整个 inode 换过去**。
   *
   * 这台机器上试过三条判据，只有这条能分开两种实现：
   *   - 「握着的 fd 读到旧内容」—— 两个实现读到**都是新内容**，分不开（Windows）；
   *   - 硬链接仍指向旧内容 —— 能用，但 FAT/exFAT 不支持 `linkSync`；
   *   - **目标 inode 变了** —— rename 变、copy 不变，跨平台，用它。
   *
   * 顺带说明这条是**必要条件**不是充分条件：`unlink` 之后再重建也会换 inode
   * （那不是原子替换，中间有一段文件根本不存在的窗口）。它在这里的职责很具体：
   * 钉住「不许退回原地覆写」。
   */
  it("写盘是替换不是覆写：目标 inode 必须换掉（原地覆写会让此刻的读者拿到半截）", () => {
    const dir = sandbox();
    const file = path.join(dir, "runtime.json");
    fs.writeFileSync(file, JSON.stringify({ day_sl_count: 3 }), "utf8");
    const before = fs.statSync(file).ino;

    writeJsonAtomic(file, { day_sl_count: 4 });

    const after = fs.statSync(file).ino;
    if (before === 0 || after === 0) {
      // 不报 inode 的文件系统（FAT/exFAT/某些网络盘）上这条判据不成立。
      // 显式报错而不是静默放行 —— 静默放行等于这条锁根本不在。
      assert.fail("本机文件系统不报 inode（0），原子性判据没生效，请换到 NTFS/ext4/APFS 上跑");
    }
    assert.notEqual(
      after,
      before,
      "写盘把目标原地覆写了 —— 不是原子替换：被截断到重新写满这段时间里，任何读者都会拿到半截文件"
    );
  });
});

describe("C：写不成的时候，原物一个字节都不许动", () => {
  it("目标是目录（换名必然失败）→ 抛错、目录还在、**不留 .tmp 残渣**", () => {
    const dir = sandbox();
    const target = path.join(dir, "runtime.json");
    fs.mkdirSync(target); // 目标被占成一个目录 —— 模拟「替换不掉」
    const keep = path.join(target, "keep.txt");
    fs.writeFileSync(keep, "原有内容", "utf8");

    assert.throws(
      () => writeJsonAtomic(target, { day_sl_count: 9 }),
      /.*/,
      "目标不可替换却没抛错 —— 调用方会以为写成功了"
    );

    assert.ok(fs.statSync(target).isDirectory(), "目标目录被动了");
    assert.equal(fs.readFileSync(keep, "utf8"), "原有内容", "目录里的东西被改了");
    assert.deepEqual(
      tmpsIn(dir),
      [],
      "失败之后留下了 .tmp —— 那正是「半截文件」本身，下次谁读到它谁就拿到假数据"
    );
  });

  it("反向对照：改之前那种「裸写 + rename」在同一个场景下会留下残渣", () => {
    const dir = sandbox();
    const target = path.join(dir, "runtime.json");
    fs.mkdirSync(target);

    // 这就是修复前的形状：先写 tmp，再 rename，失败就算了（没有清理）
    const tmp = tmpPathFor(target);
    fs.writeFileSync(tmp, JSON.stringify({ day_sl_count: 9 }), "utf8");
    try {
      fs.renameSync(tmp, target);
    } catch {
      /* 失败不管 —— 残渣留在磁盘上 */
    }

    assert.deepEqual(
      tmpsIn(dir),
      ["runtime.json.tmp"],
      "反向对照没复现出残渣 —— 那 C 里那条「不留 .tmp」的断言就是恒真的，管不住任何事"
    );
  });
});
