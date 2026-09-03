#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
裁量偏离统计 — 章程 v2.0 §0.4 的落地工具。

扫描 logs/rounds.jsonl 的 deviations[] 数组，回答三个问题：
  1. 历史上一共做了多少次裁量偏离，偏离了哪些基准？
  2. 有没有某条基准被反复偏离（≥5 次）—— 说明该基准本身可能失效，应提案修订而非每轮留痕
  3. 有没有偏离记录缺字段（§0.3 必填五项）—— 缺字段等同未留痕，属 L1-7 违规

零第三方依赖，只读，绝不写入任何归档文件。

用法：
    python scripts/deviation_stats.py                # 全量汇总
    python scripts/deviation_stats.py --list         # 逐条列出
    python scripts/deviation_stats.py --round R000004  # 指定轮次
    python scripts/deviation_stats.py --json         # 机读输出
"""

import argparse
import json
import os
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROUNDS_JSONL = os.path.join(ROOT, "logs", "rounds.jsonl")

# §0.3 必填五项
REQUIRED_FIELDS = ("baseline", "actual", "rationale", "falsifier", "risk_delta")

# 无信息量说理黑名单（§0.3 禁止项）—— 命中即告警
LOW_INFO_PHRASES = (
    "综合判断", "感觉可以", "章程已松绑", "章程松绑", "灵活处理",
    "视情况而定", "经验判断", "大概", "应该没问题",
)

# 反复偏离阈值：达到即建议提案修订该基准（§0.4）
REPEAT_THRESHOLD = 5


def load_rounds(path):
    """读取只追加的 rounds.jsonl，跳过坏行而不中断（历史归档优先于严格解析）。"""
    if not os.path.exists(path):
        return [], 0
    rows, bad = [], 0
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
    return rows, bad


def collect(rows, round_filter=None):
    """抽取全部偏离记录，附带所属轮次上下文。"""
    out = []
    for r in rows:
        rid = r.get("round_id", "?")
        if round_filter and rid != round_filter:
            continue
        devs = r.get("deviations") or []
        if not isinstance(devs, list):
            continue
        for d in devs:
            if not isinstance(d, dict):
                # 允许纯字符串形式，但标记为字段不全
                d = {"baseline": str(d)}
            out.append({
                "round_id": rid,
                "time_cst": r.get("time_cst", ""),
                "has_trades": bool(r.get("trades")),
                "dev": d,
            })
    return out


def audit(dev):
    """校验单条偏离记录，返回问题列表。"""
    problems = []
    for f in REQUIRED_FIELDS:
        v = dev.get(f)
        if v is None or (isinstance(v, str) and not v.strip()):
            problems.append("缺字段 %s" % f)
    rationale = str(dev.get("rationale") or "")
    for p in LOW_INFO_PHRASES:
        if p in rationale:
            problems.append("rationale 含无信息量表述「%s」" % p)
    if rationale and len(rationale.strip()) < 30:
        problems.append("rationale 过短（%d 字，建议 ≥30）" % len(rationale.strip()))
    fals = str(dev.get("falsifier") or "")
    if fals and not any(ch.isdigit() for ch in fals):
        problems.append("falsifier 不含任何具体数值，难以事后检验")
    return problems


def norm_baseline(s):
    """把 baseline 归一化到章节粒度，便于聚类统计。"""
    s = str(s or "未标注").strip()
    # 取开头的章节号，如 "§4.1 ③ 量比 ≥0.8" → "§4.1 ③"
    head = s.split("——")[0].split("(")[0].strip()
    return head[:40] if head else s[:40]


def main():
    ap = argparse.ArgumentParser(description="裁量偏离统计（章程 v2.0 §0.4）")
    ap.add_argument("--list", action="store_true", help="逐条列出偏离记录")
    ap.add_argument("--round", dest="round_id", help="只看指定轮次，如 R000004")
    ap.add_argument("--json", action="store_true", help="机读 JSON 输出")
    args = ap.parse_args()

    rows, bad = load_rounds(ROUNDS_JSONL)
    recs = collect(rows, args.round_id)

    by_baseline = defaultdict(list)
    flawed = []
    for rec in recs:
        by_baseline[norm_baseline(rec["dev"].get("baseline"))].append(rec)
        probs = audit(rec["dev"])
        if probs:
            flawed.append({"round_id": rec["round_id"], "problems": probs,
                           "baseline": rec["dev"].get("baseline")})

    repeat = {k: len(v) for k, v in by_baseline.items() if len(v) >= REPEAT_THRESHOLD}

    if args.json:
        print(json.dumps({
            "rounds_scanned": len(rows),
            "bad_lines": bad,
            "deviation_count": len(recs),
            "by_baseline": {k: len(v) for k, v in by_baseline.items()},
            "repeat_over_threshold": repeat,
            "flawed_records": flawed,
        }, ensure_ascii=False, indent=2))
        return 0

    print("=" * 62)
    print("裁量偏离统计 — 章程 v2.0 §0.4")
    print("=" * 62)
    print("扫描轮次：%d 轮%s" % (len(rows), ("（%d 行解析失败）" % bad) if bad else ""))
    if args.round_id:
        print("过滤条件：round_id == %s" % args.round_id)
    print("偏离记录：%d 条" % len(recs))
    print()

    if not recs:
        print("暂无裁量偏离记录。")
        print()
        print("说明：这意味着迄今全部决策均在 L2 基准内完成（或尚无偏离发生）。")
        print("      §0.4 的「基准单 vs 裁量单」绩效对比需出现首笔裁量单后才有意义。")
        return 0

    print("── 按基准归类 " + "─" * 46)
    for k, v in sorted(by_baseline.items(), key=lambda kv: -len(kv[1])):
        flag = "  ⚠ 已达反复偏离阈值，建议提案修订该基准" if len(v) >= REPEAT_THRESHOLD else ""
        print("  %-42s %2d 次%s" % (k, len(v), flag))
    print()

    if repeat:
        print("── ⚠ 反复偏离警示 " + "─" * 42)
        print("  以下基准被偏离 ≥%d 次，说明基准本身可能已失效。" % REPEAT_THRESHOLD)
        print("  按 §0.4：应主动提案修订数值，而非继续每轮留痕。")
        for k, n in repeat.items():
            print("    · %s（%d 次）" % (k, n))
        print()

    if flawed:
        print("── 🔴 留痕质量问题（§0.3 必填五项 / 说理质量）" + "─" * 14)
        print("  缺字段或说理无信息量等同未留痕，属 L1-7 违规，须追加更正记录。")
        for f in flawed:
            print("    · %s ｜ %s" % (f["round_id"], f.get("baseline")))
            for p in f["problems"]:
                print("        - %s" % p)
        print()
    else:
        print("留痕质量：✅ 全部记录字段完整、说理具体。")
        print()

    if args.list:
        print("── 逐条明细 " + "─" * 48)
        for rec in recs:
            d = rec["dev"]
            print()
            print("  [%s] %s ｜ %s" % (rec["round_id"], rec["time_cst"],
                                       "有成交" if rec["has_trades"] else "无成交"))
            for f in REQUIRED_FIELDS:
                val = d.get(f, "—")
                print("    %-11s %s" % (f + ":", val))

    return 0


if __name__ == "__main__":
    sys.exit(main())
