#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
news_db.py — 消息面 SQLite 存储层（可信新闻复用）

为什么用 SQLite：
  news.jsonl 是「只追加审计流水」，每次要查「最近 N 小时、A/B 级可信消息」
  必须线性扫全文件，数据量一大就慢。SQLite 提供结构化索引查询，
  让「已入库的可信消息」能直接被复用，避免每轮重复抓取（news_fetch）
  与重复双源验证（news_verify）。

数据关系（两条并存，各司其职）：
  news/news.jsonl   只追加审计流水（L1-7，不可改写）
  news/news.db      SQLite 结构化查询缓存（可由 jsonl 重建）

可信度：
  A = 双源交叉验证（具备否决权）；B = 单一专业源；C = 仅情绪参考。

用法（CLI）：
  python scripts/news_db.py --init                            # 建表（幂等）
  python scripts/news_db.py --query --hours 24 --min-cred B   # 查最近 N 小时可信消息
  python scripts/news_db.py --insert --input state/news_input.json  # 插入（去重）
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

# Windows 控制台默认 GBK，json.dumps 输出里若含 ⚠ 等符号会 UnicodeEncodeError；
# 强制 stdout/stderr 走 UTF-8（子进程侧 execFileAsync/subprocess 也按 utf-8 解码）。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT, "news", "news.db")
CST = timezone(timedelta(hours=8))

# 与 news_log.py normalize() 输出的字段对齐
_COLS = [
    "fp", "logged_at_cst", "round_id", "published_at", "source", "title",
    "summary", "url", "category", "credibility", "credibility_reason",
    "verification", "impact", "direction", "ttl", "symbols", "actionable", "note",
]
_SCHEMA = """
CREATE TABLE IF NOT EXISTS news (
  fp TEXT PRIMARY KEY,
  logged_at_cst TEXT,
  round_id TEXT,
  published_at TEXT,
  source TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  category TEXT,
  credibility TEXT,
  credibility_reason TEXT,
  verification TEXT,
  impact TEXT,
  direction TEXT,
  ttl TEXT,
  symbols TEXT,
  actionable INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_logged ON news(logged_at_cst);
CREATE INDEX IF NOT EXISTS idx_news_cred ON news(credibility);
"""

_CRED_RANK = {"A": 0, "B": 1, "C": 2}
_IMP_RANK = {"high": 0, "mid": 1, "low": 2}


def get_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    try:
        conn.executescript(_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def now_cst():
    return datetime.now(CST)


def _norm_symbols(v):
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return json.dumps(v, ensure_ascii=False)
    return "[]"


def insert_entry(e: dict) -> bool:
    """插入一条（按 fp 去重）。返回是否真正插入（False=已存在）。"""
    conn = get_conn()
    try:
        cur = conn.execute("SELECT 1 FROM news WHERE fp = ?", (e.get("fp"),))
        if cur.fetchone():
            return False
        conn.execute(
            "INSERT INTO news (%s) VALUES (%s)"
            % (",".join(_COLS), ",".join("?" * len(_COLS))),
            tuple(
                json.dumps(e.get(c), ensure_ascii=False) if c == "symbols" else e.get(c)
                for c in _COLS
            ),
        )
        conn.commit()
        return True
    finally:
        conn.close()


def insert_many(entries: list) -> tuple[int, int]:
    """批量插入，返回 (新增数, 重复数)。"""
    added = dup = 0
    conn = get_conn()
    try:
        for e in entries:
            if conn.execute("SELECT 1 FROM news WHERE fp = ?", (e.get("fp"),)).fetchone():
                dup += 1
                continue
            conn.execute(
                "INSERT INTO news (%s) VALUES (%s)"
                % (",".join(_COLS), ",".join("?" * len(_COLS))),
                tuple(
                    json.dumps(e.get(c), ensure_ascii=False) if c == "symbols" else e.get(c)
                    for c in _COLS
                ),
            )
            added += 1
        conn.commit()
    finally:
        conn.close()
    return added, dup


def query_recent(hours: int, min_cred: str = "B", limit: int = 40) -> list[dict]:
    """查最近 N 小时、可信度 >= min_cred 的消息，按 可信度→影响→时间 排序。"""
    init_db()
    cutoff = (now_cst() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM news WHERE logged_at_cst >= ? ORDER BY logged_at_cst DESC LIMIT ?",
            (cutoff, limit * 3),
        ).fetchall()
    finally:
        conn.close()

    out = []
    for r in rows:
        d = dict(r)
        if d.get("symbols"):
            try:
                d["symbols"] = json.loads(d["symbols"])
            except Exception:
                d["symbols"] = []
        # 过滤可信度低于门槛的
        if _CRED_RANK.get(d.get("credibility"), 9) > _CRED_RANK.get(min_cred, 9):
            continue
        out.append(d)

    # 稳定排序：可信度 → 影响；时间顺序保持 SQL 的 DESC（新在前）
    out.sort(key=lambda e: (_CRED_RANK.get(e.get("credibility"), 9),
                            _IMP_RANK.get(e.get("impact"), 9)))
    return out[:limit]


def import_from_jsonl() -> tuple[int, int]:
    """把 news/news.jsonl 的历史消息导入 SQLite（一次性迁移，幂等）。"""
    path = os.path.join(ROOT, "news", "news.jsonl")
    if not os.path.exists(path):
        return 0, 0
    init_db()
    added = dup = 0
    conn = get_conn()
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if not e.get("fp"):
                    continue
                if conn.execute("SELECT 1 FROM news WHERE fp = ?", (e["fp"],)).fetchone():
                    dup += 1
                    continue
                conn.execute(
                    "INSERT INTO news (%s) VALUES (%s)"
                    % (",".join(_COLS), ",".join("?" * len(_COLS))),
                    tuple(
                        json.dumps(e.get(c), ensure_ascii=False) if c == "symbols" else e.get(c)
                        for c in _COLS
                    ),
                )
                added += 1
        conn.commit()
    finally:
        conn.close()
    return added, dup


def main():
    ap = argparse.ArgumentParser(description="消息面 SQLite 存储层")
    ap.add_argument("--init", action="store_true", help="建表（幂等）")
    ap.add_argument("--query", action="store_true", help="查询可信消息")
    ap.add_argument("--insert", action="store_true", help="从 input 插入")
    ap.add_argument("--import-jsonl", action="store_true", help="从 news/news.jsonl 一次性迁移历史数据")
    ap.add_argument("--input", default="state/news_input.json")
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--min-cred", default="B", choices=["A", "B", "C"])
    ap.add_argument("--limit", type=int, default=40)
    a = ap.parse_args()

    if a.init or a.query:
        init_db()
    if a.init and not a.query:
        print("[news_db] 表已就绪 -> %s" % os.path.relpath(DB_PATH, ROOT))
        return 0

    if a.query:
        rows = query_recent(a.hours, a.min_cred, a.limit)
        print(json.dumps({"count": len(rows), "items": rows}, ensure_ascii=False, indent=2))
        return 0

    if a.insert:
        path = a.input if os.path.isabs(a.input) else os.path.join(ROOT, a.input)
        if not os.path.exists(path):
            print("[news_db] 输入文件不存在: %s" % path)
            return 2
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
        items = payload.get("items") or payload if isinstance(payload, list) else []
        init_db()
        added, dup = insert_many(items)
        print("[news_db] 新增 %d 条 / 重复 %d 条 -> %s" % (added, dup, os.path.relpath(DB_PATH, ROOT)))
        return 0

    if a.import_jsonl:
        added, dup = import_from_jsonl()
        print("[news_db] 迁移完成：新增 %d 条 / 已存在 %d 条 -> %s"
              % (added, dup, os.path.relpath(DB_PATH, ROOT)))
        return 0

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
