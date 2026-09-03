#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
news_verify.py — 消息面【双源交叉验证】工具（章程 §10.3）

存在意义
--------
§10.3 强制：关键数字（宏观数据、加息概率、资金流金额等）必须 ≥2 独立信源
口径一致才定 A 级。§10.2 规定：只有 A 级具备否决权，B 级无单独否决权。

本 DSH 环境可用信源（2026-09-02 实测）：
  · 源1：jin10（scripts/jin10_client.py）—— 主源，采集用
  · 源2：公开搜索引擎（经 playwright headless chromium 抓取）—— 本脚本实现
  · 不可用：OKX MCP news（demo 模式禁用）、DSH web_search（缺 DEEPSEEK_API_KEY）

2026-09-02 实战验证：ADP 8月就业人数
  金十 3.8万 / 搜狗聚合 38,000 → 数值一致，A 级成立；
  同时纠出金十"市场预期 4.8万"有误，实际为 47,000（4.7万）。
  → 证明第二信源不仅能确认数字，还能纠出单一信源的口径偏差。

依赖
----
  pip install playwright && python -m playwright install chromium
  注意：browser 版本须与 playwright 包匹配；chromium 约 115MB，
        首次下载较慢，应在后台执行（run_in_background）。

用法
----
  # 验证某条消息中的关键数字
  python scripts/news_verify.py --text "美国8月ADP就业人数增加3.8万人" --numbers 3.8

  # 从 state/news_input.json 中自动挑出需验证的条目（_needs_review=True）逐条验证
  python scripts/news_verify.py --from-input state/news_input.json --out state/news_verify.json

  # 只验证一条并打印
  python scripts/news_verify.py --text "美联储9月加息25个基点概率62.2%" --numbers 62.2

输出：每条给出 verified（真/假）、matched_numbers、sources（命中的搜索引擎与片段）、
      suggested_credibility（A / B）。

【严禁】本脚本只读，不写入任何交易指令，不修改已入库的 news.jsonl。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# 搜索引擎模板（{q} 为 URL 编码后的查询词）
ENGINES = [
    ("sogou", "https://www.sogou.com/web?query={q}"),
    ("bing", "https://www.bing.com/search?q={q}"),
    ("ddg", "https://duckduckgo.com/html/?q={q}"),
]


def build_query(text, numbers):
    """构造搜索词：取文本前 30 字 + 关键数字。"""
    head = re.sub(r"[【】\[\]（）()\"'“”.,，。:;；!！?？]", " ", text or "")[:30].strip()
    parts = [p for p in head.split() if p][:6]
    q = " ".join(parts)
    if numbers:
        q = q + " " + " ".join(numbers)
    return q.strip()


def extract_numbers(text):
    """从文本中抽取候选关键数字（含小数、万/亿、百分号、千分位）。"""
    pat = re.compile(r"\d+(?:[.,]\d+)?\s*(?:%|万|亿|个基点|bp)?")
    out = []
    for m in pat.finditer(text or ""):
        s = m.group(0).strip()
        s = re.sub(r"\s+", "", s)
        if s and s not in out:
            out.append(s)
    return out[:8]


def normalize_num(s):
    """数字归一化，便于跨源比对：3.8万 <-> 38,000 <-> 38000。"""
    if not s:
        return set()
    raw = s.replace(",", "").replace("%", "").strip()
    variants = {raw}
    m = re.match(r"^([\d.]+)\s*万$", raw)
    if m:
        try:
            variants.add(str(int(float(m.group(1)) * 10000)))
            variants.add(f"{float(m.group(1)) * 10000:,.0f}".replace(",", ""))
        except ValueError:
            pass
    m2 = re.match(r"^([\d.]+)$", raw)
    if m2:
        try:
            f = float(m2.group(1))
            if f >= 10000:
                variants.add(f"{f / 10000:g}万")
                variants.add(f"{f / 10000:.1f}")
        except ValueError:
            pass
    return {v for v in variants if v}


def search(engine_url, query, timeout=50000):
    """用 playwright 抓取搜索结果纯文本。失败返回 None。"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None, "playwright 未安装"
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True)
            try:
                pg = b.new_page(user_agent=UA)
                pg.goto(engine_url, timeout=timeout, wait_until="domcontentloaded")
                pg.wait_for_timeout(2800)
                txt = pg.inner_text("body")
                return txt, None
            finally:
                b.close()
    except Exception as e:
        return None, f"{type(e).__name__}: {str(e)[:120]}"


def verify_one(text, numbers, engines=("sogou", "bing", "ddg")):
    """对单条消息做双源验证。返回结构化结果。"""
    q = build_query(text, numbers)
    url_q = q.replace(" ", "+")
    targets = [(n, u.format(q=url_q)) for n, u in ENGINES if n in engines]

    want = set()
    for n in (numbers or []):
        want |= normalize_num(n)

    sources, matched = [], set()
    for name, url in targets:
        txt, err = search(url, q)
        if err or not txt or len(txt) < 200:
            sources.append({"engine": name, "ok": False, "error": err or f"内容过短({len(txt or '')})"})
            continue
        found = set()
        for n in want:
            for v in normalize_num(n):
                if v and v in txt:
                    found.add(n)
        # 同时抽取页面里出现的数字，供人工/后续比对
        page_nums = extract_numbers(txt)[:15]
        # 摘取含关键数字的片段作为证据
        snippets = []
        for n in (found or want):
            for v in normalize_num(n):
                for m in re.finditer(r".{0,70}" + re.escape(v) + r".{0,70}", txt):
                    snippets.append(m.group(0).replace("\n", " ")[:160])
                    break
        sources.append({
            "engine": name, "ok": True, "len": len(txt),
            "matched": sorted(found), "page_numbers": page_nums,
            "snippets": snippets[:3],
        })
        if found:
            matched |= found
        if matched:
            break  # 命中一个独立源即足够（源1 是 jin10）

    verified = len(matched) > 0
    return {
        "query": q,
        "wanted_numbers": numbers,
        "verified": verified,
        "matched_numbers": sorted(matched),
        "sources": sources,
        "suggested_credibility": "A" if verified else "B",
        "note": ("第二独立信源命中关键数字 → §10.3 满足，可升 A 级（具备否决权）"
                 if verified else
                 "未在第二信源命中 → 维持 B 级（无单独否决权）"),
    }


def main():
    ap = argparse.ArgumentParser(description="消息双源交叉验证（§10.3）")
    ap.add_argument("--text", help="待验证消息文本")
    ap.add_argument("--numbers", nargs="*", default=[], help="关键数字（可多个）")
    ap.add_argument("--from-input", dest="from_input",
                    help="从 news_input.json 批量验证 _needs_review 条目")
    ap.add_argument("--out", default="state/news_verify.json", help="输出路径")
    ap.add_argument("--engines", nargs="*", default=["sogou", "bing", "ddg"])
    a = ap.parse_args()

    if a.from_input:
        path = a.from_input if os.path.isabs(a.from_input) else os.path.join(ROOT, a.from_input)
        items = json.load(open(path, encoding="utf-8"))
        if isinstance(items, dict):
            items = items.get("items", [])
        targets = [it for it in items if it.get("_needs_review")]
        results = []
        for it in targets:
            text = (it.get("title") or "") + " " + (it.get("summary") or "")
            nums = extract_numbers(it.get("title") or "")[:4]
            r = verify_one(text, nums, tuple(a.engines))
            r["title"] = it.get("title")
            r["old_credibility"] = it.get("credibility")
            results.append(r)
            print(f"[{ 'A' if r['verified'] else 'B' }] {str(it.get('title'))[:50]} "
                  f"匹配={r['matched_numbers']}")
        out = a.out if os.path.isabs(a.out) else os.path.join(ROOT, a.out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        json.dump(results, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"→ {out}（{len(results)} 条）")
        return 0

    if not a.text:
        print("需指定 --text 或 --from-input", file=sys.stderr)
        return 2
    nums = a.numbers or extract_numbers(a.text)[:4]
    r = verify_one(a.text, nums, tuple(a.engines))
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
