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
 *
 * 运行
 * ----
 *     pnpm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertCommentStripped, read, stripComments, stripPythonStrings } from "./_src.ts";

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
