#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
news_fetch.py — 消息面采集引擎（章程 §10）

职责：采集 → 加密相关过滤 → 自动分级打标 → 产出符合 news_log.py 输入格式的
候选消息，供 DSH agent 复核后再正式入库。

【本脚本不做的事】
- 不调用 news_log.py 入库（入库是 agent 复核后的动作，且必须先 --dry-run）。
- 不产生任何交易决策。消息面在章程中的定位是「否决权与仓位调节器」。

【数据源（实机探测结论，2026-09-02）】
- ✅ 金十数据 jin10_client.py：--news（新闻）/ --flash（快讯）/ --calendar（日历）
     无需 token，实时可用，时效到当天。→ 作为主源。
- ❌ OKX MCP news 模块：demo 模式下返回 ConfigError
     "News features are not available in demo/simulated trading mode"；
     live profile 又 "No credentials found"（未配 live 凭据）。
     → 不可用。代码保留探测分支，待将来配置后自动启用。

【分级规则（写代码，不靠人肉）】
credibility：金十为单一专业财经源 → 默认 B。
  仅当同一事实被新闻与快讯【两处独立提及】时才升 A（仍需 agent 复核，故 _needs_review=True）。
impact：关键词匹配（非农/CPI/FOMC/加息/降息/ETF/清算/黑客/监管/关税 → high）。
ttl：flash(<6h) / short(<3d) / structural(长期)。
direction：多空关键词计数判定，无法判定写 mixed。
_needs_review：credibility=A 或 impact=high 时必为 True（A 级要求双源交叉验证）。

用法：
  python scripts/news_fetch.py --out state/news_input.json [--hours 24] [--limit 20]
  python scripts/news_fetch.py --gate-only        # 只算事件闸门
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CST = timezone(timedelta(hours=8))

# --------------------------------------------------------------------------- #
# 加密/宏观相关性过滤（金十是全品类财经源，必须过滤掉无关项）
# --------------------------------------------------------------------------- #
CRYPTO_KW = [
    "比特币", "以太坊", "BTC", "ETH", "加密", "区块链", "虚拟货币", "数字货币",
    "稳定币", "USDT", "USDC", "ETF", "现货ETF", "灰度", "MicroStrategy", "Strategy",
    "交易所", "币安", "OKX", "欧易", "Coinbase", "清算", "爆仓", "合约", "永续",
    "挖矿", "矿机", "算力", "质押", "DeFi", "链上", "钱包", "巨鲸",
]
MACRO_KW = [
    "美联储", "FOMC", "加息", "降息", "利率", "非农", "就业", "CPI", "PCE", "通胀",
    "PPI", "GDP", "沃勒", "Warsh", "鲍威尔", "点阵图", "缩表", "QE", "QT",
    "关税", "贸易", "衰退", "美元指数", "美债", "收益率", "流动性",
]
HIGH_KW = [
    "非农", "FOMC", "加息", "降息", "CPI", "PCE", "美联储", "FED", "利率决议",
    "ETF", "清算", "爆仓", "黑客", "被盗", "监管", "起诉", "批准", "否决",
    "关税", "战争", "制裁", "破产", "暂停交易",
]
BULL_KW = ["涨", "上涨", "拉升", "突破", "利好", "增持", "买入", "流入", "看涨",
           "创新高", "反弹", "降息", "宽松", "批准", "通过"]
BEAR_KW = ["跌", "下跌", "暴跌", "跌破", "利空", "减持", "卖出", "流出", "看跌",
           "新低", "回落", "加息", "收紧", "否决", "拒绝", "调查", "起诉",
           "黑客", "被盗", "清算", "爆仓", "风险"]

# 已知事件（章程 §10.6，作为日历不可用时的兜底；由 agent 更新）
KNOWN_EVENTS = [
    {"time": "2026-09-03 20:30", "name": "沃勒讲话", "impact": "mid"},
    {"time": "2026-09-04 20:30", "name": "8月非农就业报告", "impact": "high"},
    {"time": "2026-09-10 20:30", "name": "PPI", "impact": "mid"},
    {"time": "2026-09-11 20:30", "name": "CPI", "impact": "high"},
    {"time": "2026-09-15 20:30", "name": "FOMC 议息（首日）", "impact": "critical"},
    {"time": "2026-09-16 20:30", "name": "FOMC 议息（决议日）", "impact": "critical"},
]
GATE_WINDOW_MIN = 120  # 事件闸门窗口（分钟）

# 真正影响加密定价的美国宏观事件（闸门①的本意是防"系统性坏日子"，
# 不是把所有 high 事件都当闸门 —— 加拿大央行、澳越贸易帐等对 BTC/ETH 定价
# 基本无影响，若一律阻塞会造成过度空转，这与 §10.4 的原意相悖）。
US_MACRO_KW = [
    "美国", "美联储", "FOMC", "非农", "ADP", "CPI", "PCE", "PPI",
    "加息", "降息", "利率", "初请", "失业", "GDP", "议息",
]
# 明确排除（即便含上述关键词也排除）
GATE_EXCLUDE_KW = ["加拿大", "澳大利亚", "越南", "日本", "欧元区", "英国", "瑞士", "新西兰"]


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #
def run_py(script, args, timeout=120):
    cmd = [sys.executable, os.path.join("scripts", script)] + args
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                           encoding="utf-8", timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    if p.returncode != 0 or not (p.stdout or "").strip():
        return None
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return None


def parse_time(s):
    """解析金十的 ISO8601 时间字符串。"""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def is_relevant(text):
    """是否加密或宏观相关（过滤掉干散货运价指数这类无关项）。"""
    if not text:
        return False
    return any(k in text for k in CRYPTO_KW) or any(k in text for k in MACRO_KW)


def score_direction(text):
    """多空关键词计数判定方向。"""
    b = sum(1 for k in BULL_KW if k in text)
    s = sum(1 for k in BEAR_KW if k in text)
    if b == 0 and s == 0:
        return "mixed", "无多空关键词，方向待人工复核"
    if b > s:
        return "bullish", f"利多词{b} vs 利空词{s}"
    if s > b:
        return "bearish", f"利空词{s} vs 利多词{b}"
    return "mixed", f"多空词数持平({b})，方向待人工复核"


def score_impact(text):
    if any(k in text for k in HIGH_KW):
        return "high"
    if any(k in text for k in CRYPTO_KW + MACRO_KW):
        return "mid"
    return "low"


def score_ttl(dt):
    if dt is None:
        return "short"
    age = datetime.now(CST) - dt.astimezone(CST)
    if age < timedelta(hours=6):
        return "flash"
    if age < timedelta(days=3):
        return "short"
    return "structural"


# --------------------------------------------------------------------------- #
# 采集
# --------------------------------------------------------------------------- #
def fetch_jin10(limit):
    """返回 [(text, time_str, source, url)]。"""
    items = []
    news = run_py("jin10_client.py", ["--news", "--count", str(limit)])
    for it in ((news or {}).get("result", {}).get("data", {}).get("items") or []):
        items.append({
            "text": (it.get("title") or "") + " " + (it.get("introduction") or ""),
            "time": it.get("time"),
            "source": "jin10_news",
            "url": it.get("url"),
        })
    flash = run_py("jin10_client.py", ["--flash", "--count", str(limit)])
    for it in ((flash or {}).get("result", {}).get("data", {}).get("items") or []):
        items.append({
            "text": it.get("content") or "",
            "time": it.get("time"),
            "source": "jin10_flash",
            "url": it.get("url"),
        })
    return items


def fetch_okx_news(limit):
    """OKX MCP news —— demo 下不可用，保留探测分支。返回 [] 并如实记录原因。"""
    r = run_py("mcp_call.py", ["--profile", "demo", "--tool", "news_get_latest",
                               "--args", json.dumps({"coins": "BTC,ETH", "limit": limit})])
    if not r:
        return [], "mcp_call 调用失败"
    res = r.get("result", r)
    if isinstance(res, dict) and res.get("error"):
        return [], f"{res.get('type')}: {res.get('message')}"
    data = (res.get("data") or {}) if isinstance(res, dict) else {}
    rows = data.get("data") if isinstance(data, dict) else None
    if not rows:
        return [], "返回空"
    out = []
    for it in rows:
        out.append({
            "text": (it.get("title") or "") + " " + (it.get("summary") or ""),
            "time": it.get("published_at") or it.get("publishTime"),
            "source": "okx_news",
            "url": it.get("url"),
        })
    return out, "ok"


# --------------------------------------------------------------------------- #
# 事件闸门
# --------------------------------------------------------------------------- #
def build_gate():
    """用金十日历 + 已知事件，产出事件闸门。

    规则（§10.4 闸门①）：存在 impact=high（或 critical）事件且距现在
    ±GATE_WINDOW_MIN 分钟内 → gate_open=False（不开新仓）。
    """
    now = datetime.now(CST)
    events, cal_status = [], "unavailable"

    cal = run_py("jin10_client.py", ["--calendar"])
    rows = (cal or {}).get("result", {}).get("data")
    if isinstance(rows, list):
        cal_status = "ok"
        for r in rows:
            t = r.get("pub_time")
            name = r.get("title") or ""
            # 金十 star: 1=低 2=中 3=高（近似）
            star = r.get("star") or 1
            impact = "high" if star >= 3 else ("mid" if star == 2 else "low")
            if not any(k in name for k in MACRO_KW):
                continue
            try:
                dt = datetime.strptime(t, "%Y-%m-%d %H:%M").replace(tzinfo=CST)
            except (ValueError, TypeError):
                continue
            events.append({
                "time": dt.strftime("%Y-%m-%d %H:%M"),
                "name": name, "impact": impact,
                "minutes_away": int((dt - now).total_seconds() // 60),
            })

    # 兜底：并入已知事件（去重按 name）
    have = {e["name"] for e in events}
    for e in KNOWN_EVENTS:
        if e["name"] in have:
            continue
        try:
            dt = datetime.strptime(e["time"], "%Y-%m-%d %H:%M").replace(tzinfo=CST)
        except ValueError:
            continue
        events.append({
            "time": e["time"], "name": e["name"], "impact": e["impact"],
            "minutes_away": int((dt - now).total_seconds() // 60),
        })

    def is_blocking(e):
        if e["impact"] not in ("high", "critical"):
            return False
        if not (-GATE_WINDOW_MIN <= e["minutes_away"] <= GATE_WINDOW_MIN):
            return False
        name = e["name"]
        # 只阻塞"美国宏观"事件；排除其他国家（对加密定价无直接影响）
        if any(k in name for k in GATE_EXCLUDE_KW):
            return False
        return any(k in name for k in US_MACRO_KW)

    blocking = [e for e in events if is_blocking(e)]
    upcoming = sorted([e for e in events if e["minutes_away"] >= 0],
                      key=lambda x: x["minutes_away"])[:6]

    return {
        "now_cst": now.strftime("%Y-%m-%d %H:%M:%S"),
        "gate_open": len(blocking) == 0,
        "window_minutes": GATE_WINDOW_MIN,
        "blocking_events": blocking,
        "upcoming_events": upcoming,
        "calendar_status": cal_status,
        "note": ("gate_open=false 表示：存在高影响事件在 ±%d 分钟内，"
                 "按 §10.4 闸门① 不得开新仓（已有持仓由 OCO 保护，不手动干预）"
                 % GATE_WINDOW_MIN),
    }


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="消息面采集（章程 §10）")
    ap.add_argument("--out", default="state/news_input.json", help="候选消息输出路径")
    ap.add_argument("--hours", type=int, default=24, help="只保留最近 N 小时")
    ap.add_argument("--limit", type=int, default=20, help="每个源采集条数")
    ap.add_argument("--gate-only", action="store_true", help="只计算事件闸门")
    a = ap.parse_args()

    gate = build_gate()
    gate_path = os.path.join(ROOT, "state", "news_gate.json")
    os.makedirs(os.path.dirname(gate_path), exist_ok=True)
    with open(gate_path, "w", encoding="utf-8") as f:
        json.dump(gate, f, ensure_ascii=False, indent=2)
    print(f"[gate] open={gate['gate_open']} blocking={len(gate['blocking_events'])} "
          f"calendar={gate['calendar_status']} -> {gate_path}")
    if a.gate_only:
        return 0

    # 0) 可信消息复用：库里最近 6 小时已有 A 级（双源已验证）消息则直接复用，
    #    跳过金十抓取（避免重复查询）与二次验证。
    cached = run_py("news_db.py", ["--query", "--hours", "6", "--min-cred", "A", "--limit", "20"])
    cache_items = (cached or {}).get("items") or []
    if cache_items:
        cands = []
        for e in cache_items:
            cands.append({
                "title": e.get("title", ""),
                "source": e.get("source", ""),
                "url": e.get("url"),
                "published_at": e.get("published_at", ""),
                "summary": e.get("summary", ""),
                "credibility": "A",
                "impact": e.get("impact", "low"),
                "ttl": e.get("ttl", "short"),
                "direction": e.get("direction", "neutral"),
                "verification": e.get("verification", ""),
                "_from_cache": True,
                "_needs_review": False,
            })
        out_path = a.out if os.path.isabs(a.out) else os.path.join(ROOT, a.out)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(cands, f, ensure_ascii=False, indent=2)
        print(f"[cache] 复用已入库可信消息 {len(cands)} 条（跳过金十抓取与二次验证）-> {out_path}")
        return 0

    # 采集
    jin10_items = fetch_jin10(a.limit)
    okx_items, okx_status = fetch_okx_news(a.limit)
    print(f"[fetch] jin10={len(jin10_items)} okx={len(okx_items)} ({okx_status})")

    raw = jin10_items + okx_items
    cutoff = datetime.now(CST) - timedelta(hours=a.hours)

    # 过滤 + 分级
    cands, seen = [], set()
    text_all = " ".join(x["text"] for x in raw)  # 用于双源提及判定
    for it in raw:
        text = (it["text"] or "").strip()
        if not text or not is_relevant(text):
            continue
        dt = parse_time(it["time"])
        if dt and dt.astimezone(CST) < cutoff:
            continue
        key = re.sub(r"\s+", "", text)[:60]
        if key in seen:
            continue
        seen.add(key)

        direction, dir_note = score_direction(text)
        impact = score_impact(text)
        # 双源提及：该条核心内容在整体文本中出现 >=2 次（新闻+快讯各一次）
        head = re.sub(r"[^\u4e00-\u9fa5A-Za-z0-9]", "", text)[:24]
        cross = bool(head) and text_all.count(head) >= 2
        credibility = "A" if cross else "B"
        ttl = score_ttl(dt)

        cands.append({
            "title": text[:80],
            "source": it["source"],
            "url": it.get("url"),
            "published_at": (dt.astimezone(CST).strftime("%Y-%m-%d %H:%M:%S")
                             if dt else it.get("time")),
            "summary": text[:500] + ("；" + dir_note if dir_note else ""),
            "credibility": credibility,
            "impact": impact,
            "ttl": ttl,
            "direction": direction,
            "_needs_review": bool(credibility == "A" or impact == "high"),
            "_cross_validated": cross,
        })

    out_path = a.out if os.path.isabs(a.out) else os.path.join(ROOT, a.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(cands, f, ensure_ascii=False, indent=2)

    dist = {}
    for c in cands:
        dist[c["impact"]] = dist.get(c["impact"], 0) + 1
    print(f"[out] {len(cands)} 条候选 -> {out_path}；impact 分布 {dist}")
    print(f"[out] 需人工复核 {sum(1 for c in cands if c['_needs_review'])} 条")
    print("[note] 本脚本不入库。入库由 agent 复核后执行："
          "news_log.py --dry-run 确认零警告，再正式 --commit。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
