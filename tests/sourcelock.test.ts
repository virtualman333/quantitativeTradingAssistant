/**
 * sourcelock.test.ts —— 「读源码做结构断言」这套工具**自己**的可证伪性
 *
 * 为什么需要这份测试
 * ------------------
 * 本仓有大量断言不看行为、只看源码形态（闸门还在不在调用点、上限是不是只有一份、
 * 读盘是不是只走一条路）。这类锁的价值全在「实现改坏了它会红」；一旦它其实**恒真**，
 * 它就不只是没用，而是**有害的** —— 它会让人以为这块有保护。
 *
 * 本轮实测出三种让它恒真的形状，都在本文件里逐条钉住：
 *
 *   1. **散文满足了断言**：`archive_round.py` 的模块 docstring 里写着「读走
 *      `jsonstore.read_json_state()`」、`month_risk.py` 里那段的 docstring 带着
 *      `jsonstore.quarantine_broken()` —— 而 `stripComments()` 只认 C 风格注释，
 *      对 `.py` 等于没剥。把真调用删掉，锁照样绿。
 *   2. **自证只有一半**：`!stripped.includes("<注释原文>")` 在「那段注释被删掉（或当初
 *      就抄错了字）」时同样成立 —— 实测 `monthguard.test.ts` 用的标记在
 *      `src/scalper.ts` 里出现 **0 次**，这条自证从写下那天起就没证明过任何东西。
 *   3. **自比较**：`deepEqual(f(x), f(x))` 只证明确定性，漏掉一个参数、改掉顺序都不红。
 *   4. **底座自己从没被验过**（§E / §F）：`stripComments()` 是全仓几十条源码锁的公共
 *      底座，却一直由「它自己的直觉」兜着；拿 TypeScript 官方解析器一对账，78 个文件
 *      里 **47 个不一致**（7 个是真失步：正则里的引号让扫描器失步，注释漏成代码、
 *      行尾代码被吃掉）。而它用在 `.py` 上时**什么都没剥**（`scripts/mcp_call.py`
 *      11404 → 11404），三条 Python 结构锁因此在读裸源码。现在两边的真值分别来自
 *      TypeScript 编译器与 CPython 自己的 `tokenize`。
 *
 * 运行
 * ----
 *     pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ROOT,
  assertCommentStripped,
  commentSpansByTs,
  read,
  stripComments,
  stripPythonCode,
  stripPythonStrings,
  tsStripProblems,
  walk,
  REGEX_AFTER_PUNCT,
  REGEX_AFTER_WORD,
} from "./_src.ts";

/** 取出源码里所有三引号块（docstring）的正文。 */
function tripleQuotedBlocks(src: string): string[] {
  const out: string[] = [];
  for (const q of ['"""', "'''"]) {
    let i = 0;
    while (true) {
      const a = src.indexOf(q, i);
      if (a < 0) break;
      const b = src.indexOf(q, a + 3);
      if (b < 0) break;
      out.push(src.slice(a + 3, b));
      i = b + 3;
    }
  }
  return out;
}

/**
 * 源码里的**散文全文**（各 docstring 正文按原样拼起来，代码一律丢掉）。
 *
 * 「旧口径为什么是假锁」只有把散文单独拎出来才证得了：光说「剥完还在」，
 * 说不出它原先是被散文满足的。返回的是**未剥的正文**；要验「它已经被剥掉」，
 * 得把正文重新裹回三引号再交给 `stripPythonStrings` —— 一段没有引号的裸文本，
 * 交进去当然什么都剥不掉（这一版最初就写错在这里，测试当场把它逼了出来）。
 */
function proseOnly(src: string): string {
  return tripleQuotedBlocks(src).join("\n");
}

// ── A. stripPythonStrings：该剥的要剥、不该剥的别动 ──────────────────────

describe("stripPythonStrings · 剥得动", () => {
  it("剥掉 `#` 行注释", () => {
    const src = "# 这里是注释\nx = 1  # 行尾注释\ny = 2\n";
    const got = stripPythonStrings(src);
    assert.ok(!got.includes("这里是注释"));
    assert.ok(!got.includes("行尾注释"));
    assert.ok(got.includes("x = 1"));
    assert.ok(got.includes("y = 2"));
  });

  it("剥掉 docstring 的内容（这是本轮的病根）", () => {
    const src = 'def f():\n    """说明里引用了 jsonstore.read_json_state() 这件事"""\n    return 1\n';
    const got = stripPythonStrings(src);
    assert.ok(!got.includes("jsonstore.read_json_state("), "docstring 里的引用活下来了 —— 结构锁会由散文满足");
    assert.ok(got.includes("def f():"), "函数定义被一起剥掉了");
    assert.ok(got.includes("return 1"), "docstring 之后的代码被一起剥掉了");
  });

  it("剥掉普通字符串的内容，包括 r/b/f 前缀", () => {
    const src = 'a = "SECRET_A"\nb = r"SECRET_B"\nc = f"SECRET_{x}"\nd = b"SECRET_D"\ne = \'SECRET_E\'\n';
    const got = stripPythonStrings(src);
    for (const s of ["SECRET_A", "SECRET_B", "SECRET_{", "SECRET_D", "SECRET_E"]) {
      assert.ok(!got.includes(s), `字符串内容 ${s} 没被剥掉`);
    }
    assert.ok(got.includes("a ="), "赋值语句被一起剥掉了");
    assert.ok(got.includes("e ="), "赋值语句被一起剥掉了");
  });

  it("保留字面量里的换行（按行切片的断言不会被挤在一起）", () => {
    const src = '"""line1\nline2\nline3"""\nCODE\n';
    const got = stripPythonStrings(src);
    const count = (s: string) => (s.match(/\n/g) ?? []).length;
    assert.equal(count(got), count(src), `换行数变了，行号会塌：${JSON.stringify(got)}`);
    assert.ok(got.endsWith("CODE\n"));
  });

  it("字符串里的 `#` 不算注释起点（多行三引号里也一样）", () => {
    // 样本要够狠：单行字符串里 `#` 在中间时，「当成注释」与「当字符串内容」恰好
    // 都不留痕迹（前者把 `#` 之后当注释吃掉、后者整段吃掉）—— 本轮第一版样本就是
    // 这样，注入「字符串内遇到 # 就中断」时它照样绿。三引号里跨了行才分得开。
    const src = 'u = """a\n#b\nc"""\nCODEMARK\n';
    const got = stripPythonStrings(src);
    assert.ok(!got.includes("#b\nc"), "字符串里 `#` 之后的内容泄漏成了代码");
    assert.ok(!/^c/m.test(got), "三引号块结尾那一行泄漏成了代码");
    assert.ok(got.includes("CODEMARK"), "字符串后面的代码被当成注释吃掉了");
    const count = (s: string) => (s.match(/\n/g) ?? []).length;
    assert.equal(count(got), count(src), "换行数变了，行号会塌");
  });

  it("转义引号不会提前结束字符串", () => {
    const src = 'a = "he said \\"hi\\" ok"\nCODEMARK\n';
    const got = stripPythonStrings(src);
    assert.ok(!got.includes("he said"));
    assert.ok(got.includes("CODEMARK"), "转义处理不对，后面的代码被吃掉了");
  });
});

describe("stripPythonStrings · 别剥过头", () => {
  it("真调用原样留着", () => {
    const src = "def f():\n    st = jsonstore.read_json_state(path)\n    return st\n";
    const got = stripPythonStrings(src);
    assert.ok(got.includes("jsonstore.read_json_state("), "把真调用也剥掉了 —— 结构锁会误红");
  });

  it("链式调用、比较、正则里的字符不会被打乱", () => {
    const src = "if a >= 1 and b != 2:\n    os.replace(tmp, dst)\n";
    assert.ok(stripPythonStrings(src).includes("os.replace(tmp, dst)"));
  });

  it("剥注释的 C 风格实现不受影响（TS 侧照旧）", () => {
    const src = "// 注释\nconst a = 1;\n";
    assert.ok(!stripComments(src).includes("注释"));
    assert.ok(stripComments(src).includes("const a = 1;"));
  });
});

// ── B. 真实仓库：三处曾经由散文满足的锁，现在只能由代码满足 ─────────────

describe("结构锁 · 散文不再能替代代码", () => {
  //: 与 `runtimecorrupt.test.ts` 的 D 组同一批标记，且**这两条实测确实同时出现在
  //: docstring 与代码里**（`archive_round.py:14` 的模块说明、`month_risk.py:134` 的
  //: 函数说明）。只列真的有散文对照面的那两条 —— 没有对照面的那一条写进来是凑数。
  const CASES = [
    { file: "scripts/archive_round.py", marker: "jsonstore.read_json_state(" },
    { file: "scripts/month_risk.py", marker: "jsonstore.quarantine_broken(" },
  ];

  for (const c of CASES) {
    it(`${c.file} · ${c.marker} 的散文那一份确实被剥掉了`, () => {
      const raw = read(c.file);
      const stripped = stripPythonStrings(raw);

      assert.ok(raw.includes(c.marker), "原文里连这个标记都没有 —— 这条对照失去意义");
      assert.ok(
        stripped.includes(c.marker),
        "剥过之后标记没了：真调用不在代码里了，runtimecorrupt 那条锁**本该**红"
      );

      // ★ 关键一步：证明「散文里确实有一份、而且它已经被剥掉」。
      //   否则上面两条只说明「剥完还在」，说不出「旧口径为什么是假锁」。
      assert.ok(
        proseOnly(raw).includes(c.marker),
        `${c.file} 的 docstring 里没有这个标记 —— 那它不是被散文满足的，这条对照要重写`
      );
      assert.ok(
        !stripPythonStrings('"""' + proseOnly(raw) + '"""').includes(c.marker),
        `docstring 里的 ${c.marker} 没被剥掉 —— 结构锁又会退回到「由散文满足」`
      );
    });
  }
});

// ── C. 自证的两种恒真形状，各自钉一条负向对照 ───────────────────────────

describe("assertCommentStripped · 两向都必须会红", () => {
  const RAW = "// 那个 20 是章程外的数\nconst a = 1;\n";
  const STRIPPED = stripComments(RAW);

  it("正常情形通过", () => {
    assertCommentStripped(RAW, STRIPPED, "那个 20 是章程外的数", "自测");
  });

  it("★ 标记不在原文里时必须红（这正是 monthguard 原先的形态）", () => {
    assert.throws(
      () => assertCommentStripped(RAW, STRIPPED, "这句注释根本不在原文里", "自测"),
      /对照面/,
      "标记不在原文里却通过了 —— 这条自证是恒真的"
    );
  });

  it("★ 注释没被剥掉时必须红", () => {
    assert.throws(
      () => assertCommentStripped(RAW, RAW, "那个 20 是章程外的数", "自测"),
      /没被剥掉/,
      "注释没剥却通过了 —— 后面那些源码形态断言会失真"
    );
  });

  it("真实仓库上：剥完确实找不到那段注释（月/超短线两条路径各自的自证都靠它）", () => {
    const raw = read("src/scalper.ts");
    assertCommentStripped(
      raw,
      stripComments(raw),
      "MCP 返回是三层洋葱 result.data.data",
      "scalper.ts · stripComments 自证"
    );
  });
});

// ── D. 这套工具本身不许退化成空话 ────────────────────────────────────────

describe("扫描面自证", () => {
  it("stripPythonStrings 在真实文件上确实改变了内容（不是原样返回）", () => {
    const raw = read("scripts/archive_round.py");
    const stripped = stripPythonStrings(raw);
    assert.notEqual(stripped, raw, "输出与输入一模一样 —— 这个函数什么都没做");
    assert.ok(stripped.length < raw.length, "剥过之后反而变长了");
  });

  it("三引号块的提取器有判别力（夹在中间的那一段取得到）", () => {
    const sample = 'a = 1\n"""ONE"""\nb = 2\n\'\'\'TWO\'\'\'\n';
    assert.deepEqual(tripleQuotedBlocks(sample).sort(), ["ONE", "TWO"]);
  });
});

// ── E. 底座自己要被验：真值来自 TypeScript 官方解析器 ─────────────────────
//
// 为什么单开一节
// --------------
// `stripComments()` 是全仓「读源码做判定」那些锁的**公共底座**：止损、熔断、原子写……
// 几十条断言都踩在它上面。它错的时候锁不会报错，只会**对着一段缺斤少两的源码判绿**。
// 所以它不能由「第二份手写启发式」来验 —— 真值必须来自编译器本身。实测一对账：
//
//   | 版本                     | 不一致文件 |
//   | ------------------------ | ---------- |
//   | 改前的实现（只认引号那版） | **47 / 78**（7 个真失步，其余是行尾 `\r`）|
//   | 现在这版（六状态扫描器）   | **0 / 78** |
//
// 7 个真失步里最典型的是 `src/tools/web.ts`：正则 `<a[^>]+href="(\/\/du…` 里那个 `"`
// 被当成字符串开头，于是后面的行注释漏成了代码、行尾的代码又被整段吃掉。

const SOURCE_EXT = /\.(ts|mts|cts|vue)$/;
/** 安装 / 构建产物 —— 定义性排除，不属于源码 */
const ARTIFACT_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  ".git",
  "release",
  "out",
  "coverage",
  ".vscode",
]);

function allSources(): string[] {
  const out: string[] = [];
  const rec = (d: string): void => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!ARTIFACT_DIRS.has(e.name)) rec(rel);
      } else if (SOURCE_EXT.test(e.name)) {
        out.push(rel);
      }
    }
  };
  rec("");
  return out.sort();
}

describe("stripComments · 与 TypeScript 官方解析器逐字符对账", () => {
  it("参考实现不是空转（全仓认出的注释区间足够多）", () => {
    let spans = 0;
    for (const f of allSources()) spans += commentSpansByTs(read(f)).length;
    assert.ok(
      spans > 500,
      `全仓只认出 ${spans} 段注释 —— 参考实现失灵，下面的对账会退化成「两边的空相等」`
    );
  });

  it("全仓源码一字不差（差异清单为空）", () => {
    const files = allSources();
    assert.ok(
      files.length >= 70,
      `只扫到 ${files.length} 个源码文件 —— 扫描面塌了，「全仓一致」会变成一句空话`
    );
    const bad: string[] = [];
    for (const f of files) {
      const problems = tsStripProblems(read(f));
      if (problems.length) bad.push(`${f}\n      ${problems.join("\n      ")}`);
    }
    assert.deepEqual(
      bad,
      [],
      `stripComments 与官方解析器不一致（${bad.length}/${files.length}）：\n  ${bad.join("\n  ")}`
    );
  });

  it("行注释不许把行尾的 `\\r` 一起吃掉（CRLF 文件的逐字节对齐）", () => {
    // 写死字面量 —— 不许引用实现里的任何常量，否则改常量它会跟着变（第 19 轮栽过）
    const src = "const a = 1; // 注释\r\nconst b = 2;\r\n";
    assert.equal(stripComments(src), "const a = 1; \r\nconst b = 2;\r\n");
  });

  it("正则字面量里的引号不会让扫描器失步（`src/tools/web.ts` 的真实形态）", () => {
    const src = 'const alt = [...html.matchAll(/href="(\\/\\/d)/g)]; // 注释\nconst CODE = 1;\n';
    assert.equal(
      stripComments(src),
      'const alt = [...html.matchAll(/href="(\\/\\/d)/g)]; \nconst CODE = 1;\n'
    );
  });

  it("模板串的 `${…}` 按代码扫描（嵌套模板也对得上）", () => {
    const src = "const t = `a${ `//x` }c`;\n/* 块注释 */\nconst CODE = 1;\n";
    assert.equal(stripComments(src), "const t = `a${ `//x` }c`;\n\nconst CODE = 1;\n");
  });

  it("`obj.of / 2` 这类属性名后跟除号不会被读成正则（否则行注释会漏成代码）", () => {
    const src = "const n = obj.of / 2; // 注释\nCODE\n";
    assert.equal(stripComments(src), "const n = obj.of / 2; \nCODE\n");
  });

  it("REGEX_AFTER_PUNCT 每个字符都有活样例（删掉哪一条都会红）", () => {
    for (const p of REGEX_AFTER_PUNCT) {
      const got = stripComments(`X${p}/a"b/g; // 注释\nCODE\n`);
      assert.ok(
        !got.includes("注释"),
        `${JSON.stringify(p)} 后面没被当成正则 —— 正则里的引号让扫描器失步，注释漏成了代码`
      );
      assert.ok(got.includes("CODE"), `${JSON.stringify(p)} 那一行后面的代码被吃掉了`);
    }
  });

  it("REGEX_AFTER_WORD 每个关键字都有活样例", () => {
    for (const kw of REGEX_AFTER_WORD) {
      const got = stripComments(`${kw} /a"b/g; // 注释\nCODE\n`);
      assert.ok(!got.includes("注释"), `关键字 ${kw} 后面没被当成正则`);
      assert.ok(got.includes("CODE"), `关键字 ${kw} 那一行后面的代码被吃掉了`);
    }
  });

  /**
   * 表外的可打印 ASCII 标点必须**逐条写明理由**。
   *
   * 为什么不能只循环遍历表本身：遍历登记表时，「表里少了一条」只会让循环少跑一圈 ——
   * **静默通过**。所以要拿现算出来的宇宙做减法（本仓早先的 `SOURCE_DIRS` 就是这么坏的）。
   */
  const PUNCT_UNIVERSE = [..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"];
  const PUNCT_EXCUSED: Record<string, string> = {
    '"': "字符串定界符，表达式可以在这里结束 → 后面只能是除号",
    "'": "同上",
    "`": "模板串定界符，同上",
    ")": "调用 / 分组结束，表达式可以在这里结束",
    "]": "下标 / 数组结束，同上",
    ".": "成员访问：点后面是属性名，不是正则位置",
    "\\": "字符串之外是非法字符",
    "#": "私有名 / hashbang，只可能是标识符的一部分",
    "$": "标识符字符",
    "_": "标识符字符",
    "@": "装饰器前缀，后面不接正则",
    "/": "注释已在正则之前单独判掉",
  };

  it("表外的标点逐条有理由，且理由不会腐烂成死条目", () => {
    const unaccounted = PUNCT_UNIVERSE.filter(
      (c) => !REGEX_AFTER_PUNCT.includes(c) && !(c in PUNCT_EXCUSED)
    );
    assert.deepEqual(
      unaccounted,
      [],
      `这些标点既不在表里、也没写理由：${JSON.stringify(unaccounted)}`
    );
    const stale = Object.keys(PUNCT_EXCUSED).filter((c) => REGEX_AFTER_PUNCT.includes(c));
    assert.deepEqual(stale, [], `这些已经进了表、豁免理由成了死条目：${JSON.stringify(stale)}`);
  });
});

// ── F. Python 侧：注释 / 字符串两种剥法各有分工，且不许空转 ────────────────
//
// 病灶（实测）：`mcplive.test.ts` 原先拿 `stripComments()` 去读 `.py`。它只认 C 风格
// 注释 —— 对 `scripts/mcp_call.py` 的输出与输入**一模一样**（11404 → 11404），
// 也就是**什么都没剥**：`#` 注释与 docstring 全在，三条结构锁因此在读裸源码。
// 而换用 `stripPythonStrings()` 又走向另一个极端：它把 `["--tool", "<name>"]` 的两个
// 操作数一起抹成 `""`，那条正则再也匹配不到任何东西。

const PYTHON = process.env.PYTHON || "python";
const HAS_PYTHON = spawnSync(PYTHON, ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

/** 真值：用 CPython 自己的 `tokenize` 造出「剥完应该长什么样」，只回 sha256。 */
const TOKENIZE_REF = `
import hashlib, io, json, sys, tokenize


def reference(src):
    lines = src.split("\\n")
    offs = [0]
    for ln in lines:
        offs.append(offs[-1] + len(ln) + 1)
    spans, pending = [], None
    for t in tokenize.generate_tokens(io.StringIO(src).readline):
        name = tokenize.tok_name.get(t.type, "")
        s = offs[t.start[0] - 1] + t.start[1]
        e = offs[t.end[0] - 1] + t.end[1]
        if name == "COMMENT":
            spans.append((s, e, "c"))
        elif name == "STRING":
            spans.append((s, e, "s"))
        elif name == "FSTRING_START":
            pending = s
        elif name == "FSTRING_END" and pending is not None:
            spans.append((pending, e, "s"))
            pending = None
    spans.sort()
    merged = []
    for s, e, k in spans:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e), merged[-1][2])
        else:
            merged.append((s, e, k))
    out, at = [], 0
    for s, e, k in merged:
        out.append(src[at:s])
        out.append("\\n" * src[s:e].count("\\n"))
        if k == "s":
            out.append('""')
        at = e
    out.append(src[at:])
    return "".join(out)


res = {}
for f in sys.argv[1:]:
    src = open(f, "r", encoding="utf-8", newline="").read()
    try:
        txt = reference(src)
    except Exception as exc:
        res[f] = "ERROR:" + str(exc)
        continue
    res[f] = hashlib.sha256(txt.encode("utf-8")).hexdigest()
print(json.dumps(res, ensure_ascii=False))
`;

const hashLines = (s: string) =>
  s.split("\n").filter((l) => l.trimStart().startsWith("#")).length;

describe("stripPythonCode · 与 CPython 自己的 tokenizer 逐字节对账", { skip: !HAS_PYTHON }, () => {
  it("scripts/*.py 全部一字不差", () => {
    const files = walk("scripts", ".py");
    assert.ok(files.length >= 20, `只扫到 ${files.length} 个 .py —— 扫描面塌了`);
    const r = spawnSync(PYTHON, ["-c", TOKENIZE_REF, ...files.map((f) => path.join(ROOT, f))], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
    assert.equal(r.status, 0, `python 失败：${r.stderr}`);
    const ref = JSON.parse(r.stdout) as Record<string, string>;

    const bad: string[] = [];
    for (const f of files) {
      const want = ref[path.join(ROOT, f)];
      assert.ok(
        typeof want === "string" && want.length === 64,
        `${f} 的真值缺失或异常：${String(want)}`
      );
      const mine = crypto
        .createHash("sha256")
        .update(stripPythonCode(read(f)), "utf8")
        .digest("hex");
      if (want !== mine) bad.push(`${f}（ts=${mine.slice(0, 12)} py=${want.slice(0, 12)}）`);
    }
    assert.deepEqual(bad, [], `与 CPython tokenize 不一致：\n  ${bad.join("\n  ")}`);
  });
});

describe("Python 侧剥法的分工", () => {
  it("★ `stripComments()` 对 Python 的 `#` 注释无能为力（所以 .py 一律走 stripPythonCode）", () => {
    const raw = read("scripts/mcp_call.py");
    assert.ok(
      hashLines(raw) >= 5,
      `样本里 # 起头注释只有 ${hashLines(raw)} 行，这条对照失去意义`
    );
    assert.equal(
      hashLines(stripComments(raw)),
      hashLines(raw),
      "stripComments 居然剥掉了 Python 注释 —— 那这条对照要重写"
    );
    assert.equal(hashLines(stripPythonCode(raw)), 0, "stripPythonCode 没把 # 起头注释剥干净");
  });

  it("`dropStrings: false` 保留字符串字面量（工具名对账靠它）", () => {
    const src =
      'x = ["--tool", "news_get_latest"]\nprose = """这里也写了一份 ["--tool", "假的"]"""\n';
    const kept = stripPythonCode(src, { dropStrings: false });
    assert.ok(
      kept.includes('"--tool"') && kept.includes('"news_get_latest"'),
      "把判据的操作数一起吃了 —— 那条正则再也匹配不到任何东西"
    );
    assert.ok(!kept.includes("假的"), "docstring 没被剥掉（散文又满足了断言）");
    assert.ok(!stripPythonCode(src).includes("news_get_latest"), "默认档应当把字符串内容一起抹掉");
  });

  it("真实文件上：两种剥法的差别就是「抓得到」与「一无所获」", () => {
    const RE = /["']--tool["']\s*,\s*["']([a-z][a-z0-9_]*)["']/g;
    const raw = read("scripts/news_fetch.py");
    const kept = [...stripPythonCode(raw, { dropStrings: false }).matchAll(RE)];
    const dropped = [...stripPythonCode(raw).matchAll(RE)];
    assert.ok(
      kept.length >= 1,
      "保留字符串那一档一个工具名都没抓到 —— 解析面为空，这条对账等于没写"
    );
    assert.deepEqual(
      dropped.map((m) => m[1]),
      [],
      "抹掉字符串那一档居然抓到东西了 ——「它抓不到」正是它不能用于这条锁的理由"
    );
  });
});
