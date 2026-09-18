/**
 * mcplive.test.ts —— L1-3「实盘账户绝对只读」的代码级闸门
 *
 * 为什么需要这份测试
 * ------------------
 * 章程 §1 的十条 L1 里，**只有 L1-3 直接管着用户的真钱**：
 *
 *   > **L1-3 实盘账户绝对只读** | 严禁调用任何实盘下单/平仓/改单接口。
 *   > `scripts/mcp_call.py --profile live` 为代码级拒写（返回 `REFUSED`、exit 2、
 *   > **不产生网络请求**），不得以任何方式绕过
 *
 * 而在本轮之前，这句话**一条断言都没有**（`tests/` 里对 `mcp_call` / `REFUSED` 的
 * 引用数 = 0）。实测暴露三处对不上：
 *
 *   ① `READ_TOOLS` 定义之后**从来没有被引用过** —— 注释写着「用于 --read-only 之外的
 *      二次校验」，而那道二次校验根本不存在，只剩服务端 `--read-only` 一层；
 *   ② `WRITE_TOOLS` 里写的是 `swap_cancel_algo_order`（单数），而真实调用点
 *      （`src/okx.ts` 的 `cancelAlgoOrders()`）用的是 `swap_cancel_algo_orders`（复数）
 *      —— 手抄的黑名单漂了，那个写工具在只读模式下**一路放行**；
 *   ③ 写工具的拒绝判在 `open_session()` **之后** —— 被拒的请求仍会先起一个 MCP 服务端
 *      并完成 initialize 握手，章程里「不产生网络请求」那半句因此是假的。
 *
 * 修法：准入改成**正向白名单**（不在名单里 = 拒绝，新工具默认安全），并加
 * `precheck()` 把全部拒绝前置到起子进程之前。
 *
 * 本文件锁四件事（**都是真跑子进程的行为断言**，不是读源码猜）：
 *   A. 五条拒绝路径：exit 2 + stdout 是 `{"ok":false,"error":"REFUSED..."}`
 *      + **一个哨兵字节都不许产生**（服务端根本没被起过）；
 *   B. 正向对照：白名单内的只读工具**必须真的起进程** —— 否则「没被起进程」这条
 *      断言在「脚本压根跑不起来」的实现下也会全绿（第 5 轮复盘的恒真坑）；
 *   C. 两张工具表的不变量：都不得为空、必须互斥（空集合会让判据恒真）；
 *   D. 结构锁：① 拒绝判据必须早于 `open_session()`（源码顺序断言）；
 *      ② **源码里真正调用过的每个工具名都必须在两张表之一** —— 这条现算对账就是
 *      为「手抄清单漂移」准备的，单数/复数那处漂移正是它会红的场景。
 *
 * 怎么证明「不产生网络请求」：把 PATH 最前面放一个**假 `okx-trade-mcp` 垫片**，
 * 它唯一的行为是往哨兵文件里追加一行。垫片被起过 = 真脚本会去连交易所。
 * 全程不碰真 `okx-trade-mcp`、不发任何请求。
 *
 * 运行：pnpm test
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROOT, read, walk, stripComments } from "./_src.ts";

const PYTHON = process.env.PYTHON || "python";
const HAS_PYTHON = spawnSync(PYTHON, ["-c", "print(1)"], { encoding: "utf8" }).status === 0;
const SCRIPT = path.join(ROOT, "scripts", "mcp_call.py");

// PATH 环境变量的键名在 Windows 上可能是 `Path` —— 必须原地覆盖，不能新增一个 `PATH`
const PATH_KEY =
  Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";

let shimDir = "";
let sentinel = "";

before(() => {
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "qta-mcplive-"));
  sentinel = path.join(shimDir, "sentinel.txt");
  // Windows：okx-trade-mcp.cmd（resolve_server() 会 shutil.which 到它）
  fs.writeFileSync(
    path.join(shimDir, "okx-trade-mcp.cmd"),
    `@echo off\r\necho spawned >> "${sentinel}"\r\n`,
    "utf8"
  );
  // POSIX：同名无扩展名的可执行脚本
  const posix = path.join(shimDir, "okx-trade-mcp");
  fs.writeFileSync(posix, `#!/bin/sh\necho spawned >> "${sentinel}"\n`, "utf8");
  try {
    fs.chmodSync(posix, 0o755);
  } catch {
    /* Windows 上可能不支持，忽略 */
  }
});

after(() => {
  try {
    fs.rmSync(shimDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
});

/** 用假垫片跑一次 mcp_call.py；返回退出码、merged 输出、以及垫片是否被起过 */
function run(args: string[]) {
  fs.rmSync(sentinel, { force: true });
  const base = process.env[PATH_KEY] ?? "";
  const env = { ...process.env, [PATH_KEY]: `${shimDir}${path.delimiter}${base}` };
  const r = spawnSync(PYTHON, [SCRIPT, ...args], { encoding: "utf8", cwd: ROOT, env });
  return {
    code: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    spawned: fs.existsSync(sentinel),
  };
}

/** 断言一次「已被代码级拒绝」，且服务端从未被起过 */
function assertRefused(args: string[], tag: string) {
  const r = run(args);
  assert.equal(r.code, 2, `${tag}: 拒绝必须以 exit 2 表达，实际 ${r.code}\n${r.stderr}`);
  const payload = JSON.parse(r.stdout.trim()) as { ok?: boolean; error?: string };
  assert.equal(payload.ok, false, `${tag}: stdout 必须是 {"ok":false,...}`);
  assert.match(
    String(payload.error),
    /^REFUSED:/,
    `${tag}: 拒绝理由必须以 REFUSED 开头，实际 ${JSON.stringify(payload.error)}`
  );
  assert.equal(
    r.spawned,
    false,
    `${tag}: 被拒的调用仍然起了 MCP 服务端 —— 「不产生网络请求」不成立`
  );
  return payload;
}

describe("L1-3 · live 账户只读", { skip: !HAS_PYTHON }, () => {
  it("live + --allow-write：无论什么工具都拒绝", () => {
    const p = assertRefused(
      ["--profile", "live", "--allow-write", "--tool", "swap_place_order"],
      "live+allow-write"
    );
    assert.match(String(p.error), /live/, "理由里要点名 live");
  });

  it("live + 写工具（未加 --allow-write）：拒绝", () => {
    assertRefused(
      ["--profile", "live", "--tool", "swap_place_order"],
      "live+写工具"
    );
  });

  it("live + 未登记的工具：默认按写操作处理（fail-closed）", () => {
    assertRefused(
      ["--profile", "live", "--tool", "brand_new_write_tool"],
      "live+未登记"
    );
  });
});

describe("L1-3 · 只读模式的正向白名单（demo 同样生效）", { skip: !HAS_PYTHON }, () => {
  it("复数形式的真实写工具 swap_cancel_algo_orders 必须被拦下", () => {
    // 这就是本轮实测抓到的漂移：黑名单里只有单数 `swap_cancel_algo_order`，
    // 而这个名字（`src/okx.ts::cancelAlgoOrders()` 真正用的那个）曾一路放行。
    const p = assertRefused(
      ["--profile", "demo", "--tool", "swap_cancel_algo_orders"],
      "demo+swap_cancel_algo_orders"
    );
    // ⚠ 断言必须锚在**两种拒绝文案的区别**上，不能只写 /写操作/：
    // 白名单那条文案里也有「未登记的工具默认按写操作处理」，松一点就
    // 「黑名单漂回单数」时这条锁照样绿（本轮实测）。
    assert.match(
      String(p.error),
      /是写操作，需显式 --allow-write/,
      "应识别为写操作（而不是笼统的「不在白名单」），理由要能指导用户加 --allow-write"
    );
    assert.equal(
      /白名单/.test(String(p.error)),
      false,
      "走到了「不在白名单」那条分支 —— 说明它没被 WRITE_TOOLS 认出来，黑名单又漂了"
    );
  });

  it("其余写工具同样被拦", () => {
    for (const t of ["swap_close_position", "swap_place_algo_order", "swap_set_leverage"]) {
      assertRefused(["--profile", "demo", "--tool", t], `demo+${t}`);
    }
  });

  it("未登记的工具被拒（新增写工具默认安全）", () => {
    const p = assertRefused(
      ["--profile", "demo", "--tool", "swap_amend_order"],
      "demo+未登记"
    );
    assert.match(
      String(p.error),
      /白名单/,
      "未登记的工具应提示「不在只读白名单内」并指出登记位置"
    );
  });

  it("反向对照：白名单内的只读工具必须真的起进程（证明「没起进程」不是恒真）", () => {
    const r = run(["--profile", "demo", "--tool", "account_get_balance"]);
    assert.equal(
      r.spawned,
      true,
      "只读工具本该去连服务端，却连垫片都没被起过 —— 说明前面的「零起进程」断言在恒真"
    );
  });
});

describe("L1-3 · 两张工具表的不变量", { skip: !HAS_PYTHON }, () => {
  function tables(): { read: string[]; write: string[] } {
    const code = [
      "import json, sys, importlib.util",
      `spec = importlib.util.spec_from_file_location('mc', r'${SCRIPT}')`,
      "m = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(m)",
      "print(json.dumps({'read': sorted(m.READ_TOOLS), 'write': sorted(m.WRITE_TOOLS)}))",
    ].join("\n");
    const r = spawnSync(PYTHON, ["-c", code], { encoding: "utf8" });
    assert.equal(r.status, 0, `导入 mcp_call.py 失败：${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  it("两张表都非空且互斥", () => {
    const t = tables();
    assert.ok(t.read.length > 0, "READ_TOOLS 不得为空（空集合会让准入判据恒假）");
    assert.ok(t.write.length > 0, "WRITE_TOOLS 不得为空");
    const both = t.read.filter((n) => t.write.includes(n));
    assert.deepEqual(both, [], `同一工具同时登记在两张表里：${both.join(", ")}`);
  });

  it("表自校验函数对空表 / 重叠表会抛错，而不是静默通过", () => {
    const code = [
      "import importlib.util",
      `spec = importlib.util.spec_from_file_location('mc', r'${SCRIPT}')`,
      "m = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(m)",
      "m.assert_tool_tables(); print('ok')",
      "m.READ_TOOLS.clear();",
      "try:",
      "    m.assert_tool_tables(); print('NO-RAISE')",
      "except RuntimeError: print('raised')",
    ].join("\n");
    const r = spawnSync(PYTHON, ["-c", code], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok/, "正常情况下自校验不该抛错");
    assert.match(r.stdout, /raised/, "清空 READ_TOOLS 后自校验必须抛错（否则是假锁）");
  });

  it("§D② 源码里真正调用过的每个工具名都已被登记（现算对账）", () => {
    const found = new Set<string>();

    // TS 侧：mcpCall(<profile>, "<tool>")，profile 既可以是字面量也可以是变量。
    // ⚠ 不能用「可选组 + 裸 \w+」来吃 profile：`(?:\w+\s*,\s*)?` 匹配不上 `"demo",`
    //（带引号不是 `\w+`），于是正则退化成直接捕获第一个字符串字面量、把 profile
    // 名当成工具名塞进来 —— 实测抓到的假阳性。profile 只可能是这两种写法之一。
    for (const f of walk("src", ".ts")) {
      const src = stripComments(read(f));
      for (const m of src.matchAll(
        /mcpCall\(\s*(?:"(?:demo|live)"\s*,\s*|\w+\s*,\s*)"([a-z][a-z0-9_]*)"/g
      )) {
        found.add(m[1]);
      }
    }
    // Python 侧：["--tool", "<tool>"] 或 "--tool", "<tool>"
    for (const f of walk("scripts", ".py")) {
      const src = stripComments(read(f));
      for (const m of src.matchAll(/["']--tool["']\s*,\s*["']([a-z][a-z0-9_]*)["']/g)) {
        found.add(m[1]);
      }
    }

    // 解析面不许为空：解析器一旦失灵，「全部都登记了」会变成恒真
    assert.ok(
      found.size >= 6,
      `只解析出 ${found.size} 个工具名（应 ≥6）—— 解析器失灵，这条断言等于没写`
    );
    // 解析器自校验：profile 名绝不该出现在工具名集合里（本轮就栽过这一次）
    for (const p of ["demo", "live"]) {
      assert.equal(
        found.has(p),
        false,
        `解析器把 profile 名 ${p} 当成了工具名 —— 先修解析器，别去登记它`
      );
    }

    const t = tables();
    const known = new Set([...t.read, ...t.write]);
    const missing = [...found].filter((n) => !known.has(n)).sort();
    assert.deepEqual(
      missing,
      [],
      `源码调用过但未登记的工具名：${missing.join(", ")}\n` +
        "请登记进 scripts/mcp_call.py 的 READ_TOOLS 或 WRITE_TOOLS —— " +
        "未登记的写工具在只读模式下会被默认拒绝，功能会哑掉"
    );
  });
});

describe("L1-3 · 结构锁：拒绝必须早于起子进程", { skip: !HAS_PYTHON }, () => {
  it("main() 里 precheck(...) 出现在 open_session(...) 之前", () => {
    const src = stripComments(read("scripts/mcp_call.py"));
    const start = src.indexOf("def main(");
    assert.ok(start > 0, "找不到 main() —— 解析锚点没了，这条锁等于没写");
    const body = src.slice(start);

    const iPre = body.indexOf("precheck(");
    const iSpawn = body.indexOf("open_session(");
    assert.ok(iPre >= 0, "main() 里没有调用 precheck() —— 准入判据不见了");
    assert.ok(iSpawn >= 0, "main() 里没有调用 open_session() —— 解析锚点没了");
    assert.ok(
      iPre < iSpawn,
      "precheck() 在 open_session() 之后 —— 被拒的请求仍会先起 MCP 服务端，" +
        "章程「不产生网络请求」那半句就不成立了"
    );
  });

  it("旧的「先起进程再判写工具」写法没有回来", () => {
    const src = stripComments(read("scripts/mcp_call.py"));
    assert.equal(
      /open_session\([^)]*\)[\s\S]*?a\.tool in WRITE_TOOLS/.test(src),
      false,
      "又出现了「起完进程再判 a.tool in WRITE_TOOLS」的写法"
    );
    assert.equal(
      src.includes("read_only = not a.allow_write"),
      false,
      "main() 里那个没人用的 read_only 变量又回来了"
    );
  });

  it("main() 里真的调用了 assert_tool_tables()（自校验不能只定义不接线）", () => {
    // 实测教训：把 main() 里那一行删掉，12 条用例**一条都不红** ——
    // 函数还在、测试也还在单独调它，于是「表为空/重叠」在真运行时根本没人管。
    // 定义得再好，不接线就等于没有。
    const src = stripComments(read("scripts/mcp_call.py"));
    const start = src.indexOf("def main(");
    assert.ok(start > 0, "找不到 main()");
    assert.ok(
      src.slice(start).includes("assert_tool_tables()"),
      "main() 里没有调用 assert_tool_tables() —— 自校验成了死代码"
    );
  });
});
