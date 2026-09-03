#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
polymarket_sentiment.py — Polymarket 预测市场情绪采集

用途：从 Polymarket 拉取「加密 / 宏观」相关预测市场的隐含概率与成交量，
      作为市场情绪信号（预测市场价格 = 市场对该事件发生概率的集体判断）。

数据源：Polymarket 公开 REST（Gamma API 市场发现 + CLOB API 中间价）。
       只读、无需 API key、无需钱包。

用法：
    python scripts/polymarket_sentiment.py                 # 默认 12 个相关市场
    python scripts/polymarket_sentiment.py --limit 20
    python scripts/polymarket_sentiment.py --kw "bitcoin,fed,rate"

输出：JSON 到 stdout。
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"

# 加密 + 宏观相关关键词（小写匹配 question）
KW = [
    "bitcoin", "btc", "ethereum", "eth", "crypto", "solana", "xrp", "avax", "doge",
    "cardano", "chainlink", "litecoin", "polkadot", "tether", "usdt", "usdc",
    "coinbase", "binance", "fed", "rate cut", "rate hike", "fomc", "recession",
    "inflation", "cpi", "sec", "etf", "stablecoin", "tariff", "strategic reserve",
    "bitcoin reserve", "halving",
]


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _http_get(base: str, path: str, params: dict | None = None, retries: int = 3):
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    ctx = ssl.create_default_context()
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                         "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < retries - 1:
                time.sleep(1.2 * (attempt + 1))
    raise last_err


def _parse(s):
    """Gamma 里 outcomes/outcomePrices/clobTokenIds 都是 JSON 字符串，统一解"""
    if s is None:
        return None
    if isinstance(s, (list, dict)):
        return s
    try:
        return json.loads(s)
    except Exception:  # noqa: BLE001
        return None


def _num(v):
    try:
        return float(v)
    except Exception:  # noqa: BLE001
        return None


def _midpoint(token_id) -> float | None:
    """CLOB 中间价（0-1，即市场隐含概率）"""
    try:
        r = _http_get(CLOB, "/midpoint", {"token_id": token_id})
        if isinstance(r, dict):
            return _num(r.get("midpoint"))
    except Exception:  # noqa: BLE001
        pass
    return None


def _is_short_term_noise(q: str) -> bool:
    """跳过 5 分钟/1 小时等短时 Up-or-Down 噪音市场（与长期情绪无关）"""
    low = q.lower()
    if "up or down" not in low:
        return False
    return any(t in low for t in (" 5m", " 1h", " 4h", " 15m", " 30m", " - "))


def _match_kw(q_lower: str, kws) -> bool:
    """词边界匹配：避免 sec 误中 second、fed 误中 federal"""
    for k in kws:
        if re.search(r"(?<![a-z0-9])" + re.escape(k) + r"(?![a-z0-9])", q_lower):
            return True
    return False


def main():
    # Windows 控制台默认 GBK，强制 stdout 用 utf-8 输出中文，避免乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=12, help="返回市场数（默认 12）")
    ap.add_argument("--kw", type=str, default="", help="自定义关键词，逗号分隔")
    args = ap.parse_args()

    kws = [k.strip().lower() for k in args.kw.split(",") if k.strip()] or KW

    markets = _http_get(GAMMA, "/markets", {
        "active": "true", "closed": "false",
        "order": "volume", "ascending": "false", "limit": 1000,
    })
    if not isinstance(markets, list):
        print(json.dumps({"ok": False, "error": "Gamma API 返回异常"}, ensure_ascii=False))
        sys.exit(1)

    picked = []
    for m in markets:
        q = m.get("question") or ""
        if _is_short_term_noise(q):
            continue
        if _match_kw(q.lower(), kws):
            picked.append(m)
        if len(picked) >= args.limit:
            break

    out = []
    for m in picked:
        outcomes = _parse(m.get("outcomes")) or ["Yes", "No"]
        prices = _parse(m.get("outcomePrices"))
        toks = _parse(m.get("clobTokenIds")) or []

        # 概率：优先 outcomePrices，否则用 CLOB 中间价兜底
        prob: dict = {}
        if isinstance(prices, list) and prices:
            for i, lab in enumerate(outcomes):
                prob[str(lab)] = _num(prices[i]) if i < len(prices) else None
        elif toks:
            p0 = _midpoint(toks[0])
            if p0 is not None:
                prob[str(outcomes[0])] = round(p0, 4)
                if len(outcomes) > 1:
                    prob[str(outcomes[1])] = round(1 - p0, 4)

        out.append({
            "question": m.get("question"),
            "slug": m.get("slug"),
            "conditionId": m.get("conditionId"),
            "prob": prob,
            "volume24h": _num(m.get("volume")),
            "liquidity": _num(m.get("liquidity")),
            "endDate": m.get("endDate"),
        })

    # 情绪汇总：第一个 outcome 概率 > 0.5 的市场视为「市场偏多」
    bull = 0
    for o in out:
        vals = list(o["prob"].values())
        if vals and vals[0] is not None and vals[0] > 0.5:
            bull += 1

    print(json.dumps({
        "ok": True,
        "asOf": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "Polymarket 预测市场：价格=市场隐含概率(0-1)；第一个 outcome 概率>0.5 视为偏多。",
        "matched": len(out),
        "bullishCount": bull,
        "markets": out,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
