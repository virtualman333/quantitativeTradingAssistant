#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
news_log.py — 消息面归档器（只追加，永不改写/删除）

职责：
  把 AI 每轮采集并研判过的新闻条目，做结构化持久化 + 去重 + 可信度分级校验。
  采集与研判由 AI 完成（MCP 调用只有 AI 侧可用），本脚本只负责"落账"，
  与 archive_round.py 同构：确定性工作交给脚本，判断工作交给 AI。

归档产物：
  news/news.jsonl        全量消息流水（每行一条，只追加）
  news/YYYY-MM-DD.md     当日消息摘要（人类可读，按可信度与影响力排序）
  state/news_brief.txt   供当轮决策直接引用的简报（覆盖式，非归档物）

可信度分级（Ai 研判时必须赋值，脚本会强制校验）：
  A  一手/权威 + 至少 2 个独立信源交叉验证一致
  B  单一专业财经媒体，未经交叉验证
  C  自媒体/聚合站/AI 生成内容 —— 仅作情绪参考，禁止作为决策依据
  D  无法验证的传闻 —— 脚本拒绝入库

用法：
  python scripts/news_log.py --input state/news_input.json
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta

try:
    import news_db  # 同目录 SQLite 存储层（可信消息复用索引）
except Exception:
    news_db = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEWS_DIR = os.path.join(ROOT, "news")
NEWS_JSONL = os.path.join(NEWS_DIR, "news.jsonl")
STATE_DIR = os.path.join(ROOT, "state")
BRIEF_PATH = os.path.join(STATE_DIR, "news_brief.txt")
CST = timezone(timedelta(hours=8))

VALID_CRED = {"A", "B", "C"}
VALID_IMPACT = {"high", "mid", "low"}
VALID_DIR = {"bullish", "bearish", "neutral", "mixed"}
VALID_TTL = {"flash", "short", "structural"}

# 低质信源（归入 C 级，仅情绪参考）。可随 Playbook 迭代补充。
LOW_TIER_KEYWORDS = [
    "搜狐", "币圈网", "alibtc", "120btc", "bihai123", "百家号",
    "今日头条", "网易号", "雪球", "贴吧", "知乎", "微信公众",
]


def now_cst():
    return datetime.now(CST)


def fingerprint(title):
    """标题归一化指纹：去掉标点/空白/数字差异，用于跨源去重。"""
    s = re.sub(r"[\s\W_]+", "", title.lower())
    s = re.sub(r"\d+", "", s)          # 去掉数字，避免"涨5%"与"涨6%"算两条
    return hashlib.md5(s.encode("utf-8")).hexdigest()[:12]


def load_existing_fps():
    fps = set()
    if not os.path.exists(NEWS_JSONL):
        return fps
    with open(NEWS_JSONL, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                fps.add(json.loads(line)["fp"])
            except Exception:
                continue
    return fps


def guess_credibility(item):
    """AI 未给出可信度时兜底推断，并给出理由。"""
    src = (item.get("source") or "") + " " + (item.get("url") or "")
    for kw in LOW_TIER_KEYWORDS:
        if kw.lower() in src.lower():
            return "C", "命中低质信源名单(%s)，自动降级为仅情绪参考" % kw
    return "B", "未标注可信度，兜底判为 B（单一信源）"


def validate(item):
    """强制校验，返回 (ok, errors, warnings)。"""
    errs, warns = [], []

    if not item.get("title", "").strip():
        errs.append("缺少 title")
    if not item.get("source", "").strip():
        errs.append("缺少 source")

    cred = (item.get("credibility") or "").strip().upper()
    if cred not in VALID_CRED:
        if cred == "D":
            errs.append("D 级（不可验证传闻）拒绝入库")
        else:
            warns.append("credibility 非法(%r)，将兜底推断" % cred)

    imp = (item.get("impact") or "").strip().lower()
    if imp not in VALID_IMPACT:
        warns.append("impact 非法(%r)，置为 low" % imp)

    d = (item.get("direction") or "").strip().lower()
    if d not in VALID_DIR:
        warns.append("direction 非法(%r)，置为 neutral" % d)

    ttl = (item.get("ttl") or "").strip().lower()
    if ttl not in VALID_TTL:
        warns.append("ttl 非法(%r)，置为 short" % ttl)

    # A 级必须有交叉验证说明
    if cred == "A" and not (item.get("verification") or "").strip():
        warns.append("A 级却无 verification 交叉验证说明，降级为 B")
        cred = "B"

    # 宏观预期类数据必须有时间戳（这是 8/26 vs 9/1 加息概率反转事件的核心教训）
    if item.get("category") in ("macro", "policy", "etf_flow"):
        if not (item.get("published_at") or "").strip():
            warns.append("宏观/政策类消息缺 published_at，时效无法校验，谨慎使用")

    return (len(errs) == 0), errs, warns, cred


def normalize(item, fp):
    cred, cred_reason = "", ""
    if (item.get("credibility") or "").strip().upper() in VALID_CRED:
        cred = item["credibility"].strip().upper()
        cred_reason = item.get("credibility_reason", "") or "AI 研判赋值"
    else:
        cred, cred_reason = guess_credibility(item)

    return {
        "fp": fp,
        "logged_at_cst": now_cst().strftime("%Y-%m-%d %H:%M:%S"),
        "round_id": item.get("round_id", ""),
        "published_at": (item.get("published_at") or "").strip(),
        "source": (item.get("source") or "").strip(),
        "title": (item.get("title") or "").strip(),
        "summary": (item.get("summary") or "").strip(),
        "url": (item.get("url") or "").strip(),
        "category": (item.get("category") or "general").strip(),
        "credibility": cred,
        "credibility_reason": cred_reason,
        "verification": (item.get("verification") or "").strip(),
        "impact": (item.get("impact") or "low").strip().lower(),
        "direction": (item.get("direction") or "neutral").strip().lower(),
        "ttl": (item.get("ttl") or "short").strip().lower(),
        "symbols": item.get("symbols") or [],
        "actionable": bool(item.get("actionable", False)),
        "note": (item.get("note") or "").strip(),
    }


DIR_CN = {"bullish": "利多", "bearish": "利空",
          "neutral": "中性", "mixed": "多空交织"}
IMP_CN = {"high": "高", "mid": "中", "low": "低"}
TTL_CN = {"flash": "突发(<4h)", "short": "短期(<24h)", "structural": "结构性(长期)"}
CAT_CN = {
    "macro": "宏观经济", "policy": "货币/监管政策", "etf_flow": "ETF/机构资金流",
    "onchain": "链上/交易所", "geopolitics": "地缘政治", "market": "市场情绪/资金",
    "project": "项目方动态", "general": "其他",
}


def render_day_md(day, entries):
    L = []
    A = L.append
    A("# 消息面日志 · %s" % day)
    A("")
    A("> 本文件由 `scripts/news_log.py` 自动生成，只追加不改写。")
    A("> 可信度：A=多源交叉验证 / B=单一专业源 / C=仅情绪参考（禁止作决策依据）")
    A("")
    A("生成时间：%s ｜ 本日条目：%d 条" % (now_cst().strftime("%Y-%m-%d %H:%M:%S"), len(entries)))
    A("")

    if not entries:
        A("（本日暂无消息入库）")
        return "\n".join(L)

    # 按 可信度 → 影响力 排序
    order_c = {"A": 0, "B": 1, "C": 2}
    order_i = {"high": 0, "mid": 1, "low": 2}
    entries = sorted(entries, key=lambda e: (order_c.get(e["credibility"], 9),
                                             order_i.get(e["impact"], 9),
                                             e["logged_at_cst"]))

    # 统计
    cnt = {}
    for e in entries:
        cnt[e["credibility"]] = cnt.get(e["credibility"], 0) + 1
    A("可信度分布：A=%d / B=%d / C=%d" % (cnt.get("A", 0), cnt.get("B", 0), cnt.get("C", 0)))
    A("")
    A("---")
    A("")

    for e in entries:
        tag = "[%s]" % e["credibility"]
        A("### %s %s" % (tag, e["title"]))
        A("")
        A("- **来源**：%s ｜ **发布**：%s ｜ **入库**：%s"
          % (e["source"], e["published_at"] or "未标注", e["logged_at_cst"]))
        A("- **分类**：%s ｜ **影响**：%s ｜ **方向**：%s ｜ **时效**：%s"
          % (CAT_CN.get(e["category"], e["category"]),
             IMP_CN.get(e["impact"], e["impact"]),
             DIR_CN.get(e["direction"], e["direction"]),
             TTL_CN.get(e["ttl"], e["ttl"])))
        if e.get("round_id"):
            A("- **关联轮次**：%s" % e["round_id"])
        if e["verification"]:
            A("- **交叉验证**：%s" % e["verification"])
        A("- **分级理由**：%s" % e["credibility_reason"])
        if e["summary"]:
            A("")
            A("> %s" % e["summary"].replace("\n", "\n> "))
        if e["note"]:
            A("")
            A("**决策含义**：%s" % e["note"])
        if e["url"]:
            A("")
            A("[原文](%s)" % e["url"])
        A("")
        A("---")
        A("")

    return "\n".join(L)


def render_brief(entries, round_id):
    """供当轮决策引用的紧凑简报（覆盖式，非归档物）。"""
    L = []
    A = L.append
    A("消息面简报 | 生成 %s | 轮次 %s" % (now_cst().strftime("%Y-%m-%d %H:%M:%S"), round_id or "-"))
    A("=" * 66)
    usable = [e for e in entries if e["credibility"] in ("A", "B")]
    A("可用消息(A/B级) %d 条 ｜ 仅情绪参考(C级) %d 条"
      % (len(usable), len(entries) - len(usable)))
    A("")
    if not usable:
        A("（无 A/B 级消息，消息面不参与本轮决策）")
    for e in usable:
        A("[%s/%s/%s] %s" % (e["credibility"],
                             IMP_CN.get(e["impact"], e["impact"]),
                             DIR_CN.get(e["direction"], e["direction"]),
                             e["title"]))
        A("    来源 %s | 发布 %s | %s" % (e["source"], e["published_at"] or "?", CAT_CN.get(e["category"], e["category"])))
        if e["note"]:
            A("    → %s" % e["note"])
        A("")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="消息 JSON 文件（相对 ROOT 或绝对路径）")
    ap.add_argument("--round-id", default="")
    ap.add_argument("--dry-run", action="store_true",
                    help="只校验不落盘。因 news.jsonl 只追加不可删，"
                         "任何试跑/验证必须先 --dry-run，确认无误后再正式入库")
    args = ap.parse_args()

    path = args.input if os.path.isabs(args.input) else os.path.join(ROOT, args.input)
    if not os.path.exists(path):
        print("[news_log] 输入文件不存在: %s" % path)
        return 2

    with open(path, encoding="utf-8") as f:
        payload = json.load(f)

    # 兼容两种上游格式：news_fetch.py 直接输出 list[...]，旧契约是 dict{"items":[...]}
    if isinstance(payload, dict):
        raw_items = payload.get("items") or []
    elif isinstance(payload, list):
        raw_items = payload
    else:
        raw_items = []
    if not raw_items:
        print("[news_log] 输入中无 items，跳过")
        return 1

    os.makedirs(NEWS_DIR, exist_ok=True)
    os.makedirs(STATE_DIR, exist_ok=True)

    existing = load_existing_fps()
    accepted, rejected, dup = [], [], 0

    print("=" * 70)
    print("消息面归档 | 输入 %d 条 | 已存在指纹 %d 个" % (len(raw_items), len(existing)))
    print("=" * 70)

    for it in raw_items:
        title = (it.get("title") or "").strip()
        fp = fingerprint(title)
        if fp in existing:
            dup += 1
            print("  [重复] %s" % title[:46])
            continue
        ok, errs, warns, cred = validate(it)
        if not ok:
            rejected.append((title, errs))
            print("  [拒绝] %s -> %s" % (title[:40], "; ".join(errs)))
            continue
        it["credibility"] = cred
        if cred not in VALID_CRED:
            it["credibility"] = "B"
        if (it.get("impact") or "").lower() not in VALID_IMPACT:
            it["impact"] = "low"
        if (it.get("direction") or "").lower() not in VALID_DIR:
            it["direction"] = "neutral"
        if (it.get("ttl") or "").lower() not in VALID_TTL:
            it["ttl"] = "short"
        if not it.get("round_id"):
            it["round_id"] = args.round_id

        e = normalize(it, fp)
        accepted.append(e)
        existing.add(fp)
        for w in warns:
            print("  [警告] %s -> %s" % (title[:36], w))
        print("  [入库] [%s] %s" % (e["credibility"], title[:46]))

    if not accepted:
        print("\n无新消息入库（全部重复或被拒绝）")
        return 0

    if args.dry_run:
        print("")
        print("-" * 70)
        print("[DRY-RUN] 校验通过 %d 条，未写入任何文件。" % len(accepted))
        print("          确认无误后去掉 --dry-run 正式入库。")
        print("-" * 70)
        return 0

    # 1) 追加到 jsonl（只追加审计流水，L1-7）
    with open(NEWS_JSONL, "a", encoding="utf-8") as f:
        for e in accepted:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    # 1.5) 同步写 SQLite（可信消息复用索引；失败不影响 jsonl 主流程）
    if news_db is not None:
        try:
            added, dup = news_db.insert_many(accepted)
            print("  → news/news.db（SQLite 索引，新增 %d / 重复 %d）" % (added, dup))
        except Exception as e:
            print("  [警告] SQLite 写入失败（不影响 jsonl）: %s" % str(e)[:120])

    # 2) 重建当日 md（读取当日全部条目，按天聚合重写是可接受的：
    #    原始流水在 jsonl 里只追加，md 只是投影视图）
    day = now_cst().strftime("%Y-%m-%d")
    day_entries = []
    if os.path.exists(NEWS_JSONL):
        with open(NEWS_JSONL, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                o = json.loads(line)
                if (o.get("logged_at_cst") or "").startswith(day):
                    day_entries.append(o)

    month_dir = os.path.join(NEWS_DIR, day[:7])
    os.makedirs(month_dir, exist_ok=True)
    day_md = os.path.join(month_dir, "%s.md" % day)
    with open(day_md, "w", encoding="utf-8") as f:
        f.write(render_day_md(day, day_entries))

    # 3) 覆盖式简报
    with open(BRIEF_PATH, "w", encoding="utf-8") as f:
        f.write(render_brief(accepted, args.round_id))

    print("")
    print("-" * 70)
    print("入库 %d 条 ｜ 重复跳过 %d 条 ｜ 拒绝 %d 条" % (len(accepted), dup, len(rejected)))
    print("  → news/news.jsonl（只追加）")
    print("  → %s（当日投影）" % os.path.relpath(day_md, ROOT))
    print("  → state/news_brief.txt（当轮简报，覆盖式）")
    print("-" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
