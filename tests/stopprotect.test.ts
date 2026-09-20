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
 * 本文件锁五件事：
 *   A. 决策函数（真跑，不是读源码）：三种动作的边界，含「不知道」不许被当成「有止损」；
 *   A2. 判据本身（真跑）：**「有挂单」不等于「有止损」** —— 只有带止损触发价的委托才算，
 *       且两种拼写（`slTriggerPx` / 快照重命名后的 `slTrigger`）都要认；
 *   A3. 全仓裸仓巡检 `findNakedPositions()`（真跑）：**逐持仓**判，且把「一条都没挂」
 *       与「挂了止盈忘了止损」分开说 —— 后者才是这条链真正会漏的那一格；
 *   B. 止损存在性判据只有一份实现，且 `okx.confirmAlgo()` 与 `main.ts` 的裸仓巡检都走它
 *       （口径不许分裂）。反面扫描抓**两种**形状 —— 2026-09-21 之前只认 `a.instId ===`，
 *       而 `main.ts` 当时用的是 `.map(a => a.inst)` + `Set.has`：**同一件事换了个形状
 *       就从锁下面走过去了**（锁看着在管，那一格走不到）；
 *   C. 结构锁：两条路径都真的经过 `ensureStopProtection()`，而那个假的理由文案
 *       不许再出现 —— **旧形状改回去必须变红**（负向验证见本轮台账）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { read, stripComments, walk } from "./_src.ts";
import {
  decideStopProtection,
  findNakedPositions,
  pendingAlgoFor,
  pendingStopsFor,
} from "../src/stopprotect.ts";

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
  // ⚠ 这三条 fixture 必须带 `slTriggerPx`。此前它们只有 `instId` —— 那时的判据只数
  // 条数，于是这种「没有任何止损触发价的委托」被当成止损用了好几轮，测试还替它背了书。
  const algo = [
    { algoId: "1", instId: "ETH-USDT-SWAP", slTriggerPx: "3000" },
    { algoId: "2", instId: "BTC-USDT-SWAP", slTriggerPx: "70000" },
    { algoId: "3", instId: "ETH-USDT-SWAP", slTriggerPx: "3050" },
  ];

  it("只数该标的，不多不少", () => {
    assert.equal(pendingStopsFor(algo, "ETH-USDT-SWAP"), 2);
    assert.equal(pendingStopsFor(algo, "BTC-USDT-SWAP"), 1);
    assert.equal(pendingStopsFor(algo, "SOL-USDT-SWAP"), 0);
  });

  it("★ 「有挂单」不等于「有止损」：没有止损触发价的一律不算", () => {
    // 本轮核心。一条只有止盈的委托（OCO 掉了一条腿、条件单、或任何 `slTriggerPx` 为空的
    // 形态）此前会被算成止损 —— 于是回查通过、巡检写「止损在挂」、裸仓告警一声不响，
    // 而交易所侧根本没有止损。判据比它要回答的问题窄，缩掉的那格恰好最要命。
    for (const noSl of [
      { algoId: "t1", instId: "ETH-USDT-SWAP" },                     // 完全没有这个键
      { algoId: "t2", instId: "ETH-USDT-SWAP", slTriggerPx: "" },     // 空串
      { algoId: "t3", instId: "ETH-USDT-SWAP", slTriggerPx: null },   // null
      { algoId: "t4", instId: "ETH-USDT-SWAP", tpTriggerPx: "3300" }, // 只有止盈
      { algoId: "t5", instId: "ETH-USDT-SWAP", slTriggerPx: "abc" },  // 非数字
      { algoId: "t6", instId: "ETH-USDT-SWAP", slTriggerPx: "0" },    // 0 不是价位
      { algoId: "t7", instId: "ETH-USDT-SWAP", slTriggerPx: "-1" },   // 负数是「市价」的占位，不是触发价
    ]) {
      assert.equal(pendingStopsFor([noSl], "ETH-USDT-SWAP"), 0, `被算成止损了：${JSON.stringify(noSl)}`);
    }
    // 反面：换上真的触发价，同一条形状就必须被认出来 —— 否则上面那组可以「一律判 0」而恒真
    assert.equal(
      pendingStopsFor([{ algoId: "t8", instId: "ETH-USDT-SWAP", slTriggerPx: "3000" }], "ETH-USDT-SWAP"),
      1
    );
  });

  it("触发价是数字（不是字符串）也要认 —— 交易所两种都返回过", () => {
    assert.equal(pendingStopsFor([{ instId: "ETH-USDT-SWAP", slTriggerPx: 3000 }], "ETH-USDT-SWAP"), 1);
  });

  it("两种拼写都认：原始 `instId`/`slTriggerPx` 与快照重命名后的 `inst`/`slTrigger`", () => {
    // 账户快照 `buildSnapshot()` 会把键改名，而快照里的 `slTrigger` 到本轮为止是
    // **零读取方**（只被 JSON.stringify 带进提示词）。只认一种拼写的话，另一种形态喂进来
    // 会恒判「没有止损」—— 要么凭空多出一个裸仓去平仓，要么把真裸仓看漏。
    assert.equal(
      pendingStopsFor([{ algoId: "m1", inst: "ETH-USDT-SWAP", slTrigger: "3000" }], "ETH-USDT-SWAP"),
      1
    );
    assert.equal(
      pendingStopsFor([{ algoId: "m2", inst: "ETH-USDT-SWAP" }], "ETH-USDT-SWAP"),
      0,
      "只有标的、没有触发价，不算止损"
    );
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

  it("pendingAlgoFor 数全部挂单，两者的差额就是「挂了单但没止损」", () => {
    const mixed = [
      { instId: "ETH-USDT-SWAP", slTriggerPx: "3000" },
      { instId: "ETH-USDT-SWAP", tpTriggerPx: "3300" },
    ];
    assert.equal(pendingAlgoFor(mixed, "ETH-USDT-SWAP"), 2);
    assert.equal(pendingStopsFor(mixed, "ETH-USDT-SWAP"), 1);
    assert.equal(pendingAlgoFor(mixed, ""), 0);
    assert.equal(pendingAlgoFor(undefined, "ETH-USDT-SWAP"), 0);
  });
});

describe("A3. 全仓裸仓巡检 findNakedPositions（真跑）", () => {
  const pos = (over: Record<string, unknown> = {}) => ({
    inst: "ETH-USDT-SWAP",
    side: "long",
    sizeContracts: 10,
    ...over,
  });

  it("挂了止损的持仓不算裸仓；一条单都没有的算", () => {
    assert.deepEqual(findNakedPositions([pos()], [{ inst: "ETH-USDT-SWAP", slTrigger: "3000" }]), []);
    const naked = findNakedPositions([pos()], []);
    assert.equal(naked.length, 1);
    assert.equal(naked[0].inst, "ETH-USDT-SWAP");
    assert.match(naked[0].reason, /没有任何 pending 算法单/);
  });

  it("★ 只有止盈的挂单不算止损 —— 且理由要把「挂了 1 条但没有止损」说出来", () => {
    // 这一格是旧的 `Set.has(inst)` 判据**永远走不到**的：inst 在集合里，于是它判「有止损」。
    const naked = findNakedPositions([pos()], [{ inst: "ETH-USDT-SWAP", tpTrigger: "3300" }]);
    assert.equal(naked.length, 1, "只有止盈的持仓被当成有止损了");
    assert.equal(naked[0].algoOrders, 1, "没说清该标的其实挂着 1 条单");
    assert.equal(naked[0].stopOrders, 0);
    assert.match(naked[0].reason, /没有一条带止损触发价/, `理由没指出「有单但没止损」：${naked[0].reason}`);
  });

  it("逐持仓判：一个标的挂了止盈、另一个连单都没有 → 两笔裸仓", () => {
    const naked = findNakedPositions(
      [pos({ inst: "ETH-USDT-SWAP" }), pos({ inst: "SOL-USDT-SWAP" })],
      [{ inst: "ETH-USDT-SWAP", tpTrigger: "3300" }]
    );
    assert.deepEqual(naked.map((n) => n.inst).sort(), ["ETH-USDT-SWAP", "SOL-USDT-SWAP"]);
  });

  it("另一个标的的止损不能替这笔持仓背书", () => {
    const naked = findNakedPositions([pos()], [{ inst: "BTC-USDT-SWAP", slTrigger: "70000" }]);
    assert.equal(naked.length, 1, "拿别的标的的止损当成了这笔的止损");
  });

  it("张数为 0 的持仓不算裸仓（那是「没有持仓」，不是「有持仓没止损」）", () => {
    assert.deepEqual(findNakedPositions([pos({ sizeContracts: 0 })], []), []);
  });

  it("原始持仓行（`instId`/`pos`）也认；坏输入不抛异常", () => {
    const naked = findNakedPositions([{ instId: "ETH-USDT-SWAP", pos: "-10", side: "short" }], []);
    assert.equal(naked.length, 1);
    assert.equal(naked[0].sizeContracts, 10, "张数应取绝对值（空仓 pos 是负的）");
    for (const bad of [undefined, null, {}, "x", 42]) {
      assert.deepEqual(findNakedPositions(bad, []), [], `${String(bad)} 没返回空数组`);
    }
  });
});

/**
 * 反面扫描：什么样的写法算「又写了一份止损存在性判据」。
 *
 * ⚠ 判据与自证**共用这一份**。此前这里是内联正则、自证另写一遍 —— 「改判据那一处、
 * 自证照样绿」正是 2026-09-20 XWDA 那天踩过的坑。
 *
 * 两种形状都要抓，第二种是 2026-09-21 实测漏网的：
 *   ① `a.instId === inst`                        —— 直接拿一条单去比标的；
 *   ② `algoOrders.map(a => a.inst)` + `Set.has`  —— 先投影成标的名再做存在性判断。
 *      `src/main.ts` 的裸仓巡检原本长这样，而旧扫描只认①，于是**同一件事换了个形状
 *      就从锁下面走过去了**（这正是本轮要修的那一处）。前缀限定 `algo\w*` 是为了
 *      不误伤合法投影（`positions.map(p => p.inst)` 不是判据，见下面自证那一格）。
 */
const RIVAL_JUDGE_RES: RegExp[] = [
  /a\.instId\s*===/,
  /algo\w*\.map\(\s*\(?\s*[A-Za-z_$][\w$]*\s*\)?\s*=>\s*[A-Za-z_$][\w$]*\.inst(?:Id)?\b/i,
];

/** 一份源码（先剥注释）里命中的「对手判据」形状数 */
function rivalJudgeHits(source: string): number {
  return RIVAL_JUDGE_RES.filter((re) => re.test(source)).length;
}

describe("B. 判据只有一份：confirmAlgo 与裸仓巡检用的是同一份实现", () => {
  const code = (p: string) => stripComments(read(p));

  it("全仓只有 stopprotect.ts 定义 pendingStopsFor，没有第二份「按标的名数一下」", () => {
    const defs = walk("src", ".ts").filter((f) =>
      /export\s+function\s+pendingStopsFor\s*\(/.test(code(f))
    );
    assert.deepEqual(defs, ["src/stopprotect.ts"], `pendingStopsFor 的定义不是唯一一份：${defs.join(", ")}`);

    // 反面：手写判据在别处又出现，口径就会分裂
    // （今天判「有没有止损」，明天变成「有没有同标的挂单」）。
    const handwritten: string[] = [];
    for (const f of walk("src", ".ts")) {
      if (f === "src/stopprotect.ts") continue;
      // `cancelAlgoOrders` 需要的是「撤哪些单」，必须拿到行本身，不是存在性判据 ——
      // 它用 `String(a.instId ?? "") === inst` 是有理由的，按文件名排除。
      if (f === "src/okx.ts") continue;
      if (rivalJudgeHits(code(f))) handwritten.push(f);
    }
    assert.deepEqual(handwritten, [], `出现了手写的止损存在性判据：${handwritten.join(", ")}`);

    const okxC = code("src/okx.ts");
    assert.ok(
      okxC.includes("pendingStopsFor(unwrap("),
      "confirmAlgo 没用 pendingStopsFor —— 章程点名的这条回查是各调用点的唯一判据，不许各写一份"
    );
  });

  it("★ 裸仓巡检走 findNakedPositions，且它只定义一次", () => {
    const defs = walk("src", ".ts").filter((f) =>
      /export\s+function\s+findNakedPositions\s*\(/.test(code(f))
    );
    assert.deepEqual(defs, ["src/stopprotect.ts"], `findNakedPositions 的定义不是唯一一份：${defs.join(", ")}`);
    // 正反两面：main.ts 必须真的**调用**它（而不是只 import 了事）
    assert.match(
      code("src/main.ts"),
      /findNakedPositions\(\s*snap\.positions\s*,\s*snap\.algoOrders\s*\)/,
      "main.ts 的裸仓巡检没有走 findNakedPositions —— L1-4 的判据又分裂了"
    );
  });

  it("自证：两种对手形状都抓得到，合法的投影不许误伤（否则上面那条反面扫描是恒真的）", () => {
    assert.ok(rivalJudgeHits("const hit = a.instId === inst;"), "形状①（`a.instId ===`）没被抓到");
    assert.ok(
      rivalJudgeHits("const algoInsts = new Set(algoOrders.map((a) => a.inst));"),
      "形状②（`.map` → `Set`）没被抓到 —— 本轮的起因就是这个形状从锁下面走了过去"
    );
    // 合法的投影不是判据：判红了会把人逼去改命名，而不是改判据
    assert.equal(rivalJudgeHits("const insts = positions.map((p) => p.inst);"), 0, "持仓投影成标的名是合法的");
    assert.equal(
      rivalJudgeHits("const pending = pendingStopsFor(acct.algoOrders, cfg.inst);"),
      0,
      "走判据的写法不该判红"
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
