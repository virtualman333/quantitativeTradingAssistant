/**
 * stopprotect.test.ts —— L1-4「挂单失败且重试无效 → 立即市价平仓」的落点
 *
 * 为什么需要这份测试
 * ------------------
 * 章程 L1-4 有两句。前半句（同轮挂止损 + 回查）本仓早就实现了，后半句
 * （挂不上就重试、重试无效立即平仓）**一句落点都没有**：
 *
 *   - `scalpOnce()` 挂完 OCO 只把 `oco.ok && confirmed` 拼进一句日志，
 *     失败时既不重试也不平仓；
 *   - 下一轮巡检看到「已有持仓 + 方向一致」就 `skipped`，理由写着
 *     「等止盈/止损触发」—— **这句话在裸仓上是假的**，交易所侧根本没有止损。
 *
 * 净效果：一条无人值守的 60 秒循环能留下**永久裸仓**，而本地台账照记 sl/tp、
 * 界面照显示「持仓中」，没有任何一处会说出「这笔没有止损」。
 *
 * 本文件锁三件事：
 *   A. 决策函数（真跑，不是读源码）：三种动作的边界，含「不知道」不许被当成「有止损」；
 *   B. 止损存在性判据只有一份实现，且 `okx.confirmAlgo()` 用它（口径不许分裂）；
 *   C. 结构锁：两条路径都真的经过 `ensureStopProtection()`，而那个假的理由文案
 *      不许再出现 —— **旧形状改回去必须变红**（负向验证见本轮台账）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { read, stripComments, walk } from "./_src.ts";
import { decideStopProtection, pendingStopsFor } from "../src/stopprotect.ts";

describe("A. 决策：没有止损时先补挂，补挂走不通才平仓", () => {
  it("已有 pending 止损 → 什么都不做（不许重复挂第二份）", () => {
    const d = decideStopProtection({ pendingStops: 2, rehangTried: false, canRehang: true });
    assert.equal(d.action, "none");
    assert.match(d.why, /2 条/, `理由里没给出条数：${d.why}`);
  });

  it("没有止损、挂得出去、还没试过 → 补挂（章程的「重试」）", () => {
    const d = decideStopProtection({ pendingStops: 0, rehangTried: false, canRehang: true });
    assert.equal(d.action, "rehang");
  });

  it("补挂试过一次仍失败 → 立即市价平仓（章程后半句）", () => {
    const d = decideStopProtection({ pendingStops: 0, rehangTried: true, canRehang: true });
    assert.equal(d.action, "close");
    assert.match(d.why, /重试/, `没说清为什么直接平仓：${d.why}`);
  });

  it("挂不出去（缺触发价 / 缺合规 clOrdId）→ 也要平仓，不许留裸仓", () => {
    const noPrice = decideStopProtection({ pendingStops: 0, rehangTried: false, canRehang: false });
    assert.equal(noPrice.action, "close");
    // 这一条是**边界处最容易写错的地方**：`canRehang=false` 时如果判成 "rehang"，
    // 上层会拿着 undefined 的价位去挂单，挂不上又回到今天这个「只报不处置」的老路。
    const tried = decideStopProtection({ pendingStops: 0, rehangTried: true, canRehang: false });
    assert.equal(tried.action, "close");
  });

  it("「不知道有没有止损」不许被当成「有止损」", () => {
    // pendingStops 是 NaN/undefined 时按 0 处理（当作没有）—— 反过来的话，
    // 一次取数失败就会让一个裸仓被永久放过，而这条路径没有任何人会去复核。
    for (const bad of [Number.NaN, undefined as unknown as number, null as unknown as number]) {
      const d = decideStopProtection({ pendingStops: bad, rehangTried: false, canRehang: true });
      assert.equal(d.action, "rehang", `pendingStops=${String(bad)} 被判成了有止损`);
    }
  });
});

describe("A2. 止损存在性判据 pendingStopsFor（真跑）", () => {
  const algo = [
    { algoId: "1", instId: "ETH-USDT-SWAP" },
    { algoId: "2", instId: "BTC-USDT-SWAP" },
    { algoId: "3", instId: "ETH-USDT-SWAP" },
  ];

  it("只数该标的，不多不少", () => {
    assert.equal(pendingStopsFor(algo, "ETH-USDT-SWAP"), 2);
    assert.equal(pendingStopsFor(algo, "BTC-USDT-SWAP"), 1);
    assert.equal(pendingStopsFor(algo, "SOL-USDT-SWAP"), 0);
  });

  it("非数组 / 空标的 → 0，且不抛异常", () => {
    for (const bad of [undefined, null, {}, "[]", 42]) {
      assert.equal(pendingStopsFor(bad, "ETH-USDT-SWAP"), 0, `${String(bad)} 没返回 0`);
    }
    assert.equal(pendingStopsFor(algo, ""), 0);
  });

  it("缺 instId 的行不许被算进任何标的", () => {
    assert.equal(pendingStopsFor([{ algoId: "x" }, { instId: undefined }], "ETH-USDT-SWAP"), 0);
  });
});

describe("B. 判据只有一份：confirmAlgo 用的是同一份实现", () => {
  const code = (p: string) => stripComments(read(p));

  it("全仓只有 stopprotect.ts 定义 pendingStopsFor，没有第二份「按 instId 数一下」", () => {
    const defs = walk("src", ".ts").filter((f) =>
      /export\s+function\s+pendingStopsFor\s*\(/.test(code(f))
    );
    assert.deepEqual(defs, ["src/stopprotect.ts"], `pendingStopsFor 的定义不是唯一一份：${defs.join(", ")}`);

    // 反面：`a.instId === inst` 这种手写判据如果在别处又出现，口径就会分裂
    // （今天判「有没有止损」，明天变成「有没有同标的挂单」）。
    const handwritten: string[] = [];
    for (const f of walk("src", ".ts")) {
      if (f === "src/stopprotect.ts") continue;
      const c = code(f);
      // `cancelAlgoOrders` 需要的是「撤哪些单」，必须拿到行本身，不是存在性判据 ——
      // 它用 `String(a.instId ?? "") === inst` 是有理由的，按文件名排除。
      if (f === "src/okx.ts") continue;
      if (/a\.instId\s*===/.test(c)) handwritten.push(f);
    }
    assert.deepEqual(handwritten, [], `出现了手写的止损存在性判据：${handwritten.join(", ")}`);

    const okxC = code("src/okx.ts");
    assert.ok(
      okxC.includes("pendingStopsFor(unwrap("),
      "confirmAlgo 没用 pendingStopsFor —— 章程点名的这条回查是两个调用点的唯一判据，不许各写一份"
    );
  });
});

describe("C. 结构锁：两条路径都真的经过 ensureStopProtection", () => {
  const scalper = stripComments(read("src/scalper.ts"));

  it("开单链：止损保护接在「成交后」，且不再是「只拼一句日志」", () => {
    // ⚠ 这里必须锚在**开单链那一次调用**上。只写 `includes("const protect = await
    // ensureStopProtection({")` 是不够的：巡检裸仓那一支也长这样，于是把开单链整段
    // 架空（改成无效调用）这条锁照样绿 —— 本轮负向验证 D1 实测踩到。
    // 判别特征用参数 `clOrdId: \`${cl}oc\`` —— 只有开单链沿用主单 ID（L1-8 幂等约定）。
    // ⚠ 中间的 `(?:(?!\}\);)[\s\S])*?` 不是装饰：巡检那条调用在文件里**排在前面**，
    // 若允许跨过一次 `});` 去匹配后面的 `clOrdId`，就把开单链架空也照样绿
    // （本轮 D1 第一版实测：假绿）。
    assert.match(
      scalper,
      /const protect = await ensureStopProtection\(\{(?:(?!\}\);)[\s\S])*?clOrdId: `\$\{cl\}oc`/,
      "开单链上没有把「成交后的止损保护」接上 —— L1-4 第一句（同轮挂止损）又没了落点"
    );
    const calls = (scalper.match(/await ensureStopProtection\(\{/g) ?? []).length;
    assert.equal(calls, 2, `ensureStopProtection 的调用点应为 2（开单后 / 巡检发现裸仓），实际 ${calls}`);
    // 旧形状：`OCO=${oco.ok} 回查=${confirmed}`。它本身没错，错在它是**唯一的**处置。
    assert.ok(
      !/OCO=\$\{oco\.ok\}/.test(scalper),
      "旧的「只拼一句日志」形状回来了 —— 挂单失败时又会既不重试也不平仓"
    );
    assert.ok(
      scalper.includes("settleTrade(trade, await fetchLastPrice(cfg.inst))"),
      "保护性平仓之后仍把这一笔记成「持仓中」—— 界面会显示一笔永远不动的持仓"
    );
    assert.ok(scalper.includes("trade.note = protect.note"), "台账里没留下「发生了什么」");
  });

  it("巡检链：判「已有持仓方向一致」之前先判止损在不在，且假理由文案不许再出现", () => {
    // ⚠ 这里是**整句**匹配，不是「出现过这个名字」。只判 `includes("pendingStopsFor(")`
    // 的话，`const pending = pendingStopsFor(...) || 1;` 照样绿 —— 而那一行等于
    // 「永远认为有止损」，正是这条锁要拦的东西（本轮负向验证 D2 实测）。
    assert.match(
      scalper,
      /const pending = pendingStopsFor\(acct\.algoOrders, cfg\.inst\);/,
      "「方向一致」那条分支没有判止损在不在（或判了却没把结果当判据）—— 裸仓会被无限期跳过"
    );
    // 这句话在裸仓上是假的：它断言了「止盈/止损会触发」。新的措辞把条数写出来，
    // 只有真的查到 pending 单才说得出口。
    assert.ok(
      !scalper.includes("等止盈/止损触发"),
      "「等止盈/止损触发」又出现了 —— 它在没有止损的持仓上是一句假话"
    );
    assert.match(scalper, /止损在挂（\$\{pending\} 条），等触发/, "判到有止损时没有把条数说出来");
  });

  it("平仓与补挂只有一处实现（两个调用点共用 ensureStopProtection）", () => {
    const defs = scalper.match(/async function ensureStopProtection\(/g) ?? [];
    assert.equal(defs.length, 1, "ensureStopProtection 出现了不止一份实现");
    assert.ok(
      scalper.includes("await closePosition({"),
      "ensureStopProtection 里没有平仓 —— L1-4「重试无效立即市价平仓」没有落点"
    );
    // 全仓 `await closePosition(` 只允许三处，各有其语义：① 本函数（L1-4 兜底）；
    // ② 趋势反转平仓（既有功能）；③ 用户点「一键全平」。多出来的第四处就是
    // 「同一件事写两遍」的开始 —— 那时候又要问一遍「谁说了算」。
    const callSites = (scalper.match(/await closePosition\(/g) ?? []).length;
    assert.equal(
      callSites,
      3,
      `closePosition 出现 ${callSites} 次（应为 3：L1-4 兜底 / 趋势反转平仓 / 用户一键全平）—— ` +
        "多出来的那处就是「同一件事写两遍」的开始"
    );
  });

  it("自证：上面这些探针字符串在源码里真的存在（删掉锁就自己红）", () => {
    // 防止「探针拼错 → 断言恒真/恒假」。逐条确认探针是有落点的。
    for (const probe of [
      "ensureStopProtection(",
      "pendingStopsFor(acct.algoOrders, cfg.inst)",
      "await closePosition({",
      "trade.note = protect.note",
    ]) {
      assert.ok(scalper.includes(probe), `探针 ${probe} 在 scalper.ts 里找不到 —— 这条锁已经失效`);
    }
    assert.ok(
      read("src/stopprotect.ts").includes("export function decideStopProtection("),
      "决策函数不见了"
    );
    assert.ok(
      walk("src", ".ts").includes("src/stopprotect.ts"),
      "src/stopprotect.ts 掉出源码扫描面了"
    );
  });
});
