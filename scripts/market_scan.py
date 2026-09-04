#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
market_scan.py — OKX 永续合约多周期行情扫描与技术指标计算引擎

用途：为交易 AI 提供确定性的、可复现的技术面摘要，避免把上千根 K 线塞进模型上下文。
数据源：OKX 公开 REST 端点（无需认证）。
输出：JSON 摘要到 stdout，同时可选落盘归档。

用法:
    python market_scan.py                          # 按 24h 成交额取前 15 个 USDT 永续扫描
    python market_scan.py --top 20                 # 指定候选池大小
    python market_scan.py --inst BTC-USDT-SWAP     # 指定单个标的（可重复）
    python market_scan.py --insts BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP
    python market_scan.py --save <dir>             # 同时归档快照
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

# 域名候选：主站被 DNS 污染/断连时依次回退；环境变量 OKX_PUBLIC_BASE 可强制指定。
# 另：urllib 自动读取 HTTPS_PROXY/HTTP_PROXY 环境变量，挂代理时无需改代码。
BASES = (
    [os.environ["OKX_PUBLIC_BASE"].rstrip("/")]
    if os.environ.get("OKX_PUBLIC_BASE")
    else ["https://www.okx.com", "https://aws.okx.com", "https://okx.com"]
)
BASE = BASES[0]
CST = timezone(timedelta(hours=8))
DEFAULT_INSTS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]
# 默认候选池大小：按 24h 成交额取前 N 个 USDT 永续（用户指令：不限 BTC/ETH，目标是盈利）
DEFAULT_TOP = 15
MAX_WORKERS = 8
# 分析用周期：4H 定大势，1H 定结构，15m 定入场
BARS = ["4H", "1H", "15m"]
CANDLE_LIMIT = 300


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
def _http_get(path: str, params: dict | None = None, retries: int = 3) -> dict:
    qs = "?" + urllib.parse.urlencode(params) if params else ""
    ctx = ssl.create_default_context()
    last_err = None
    for base in BASES:  # 主域名不通（DNS 污染/断连）时换备用域名
        url = base + path + qs
        for attempt in range(retries):
            try:
                req = urllib.request.Request(
                    url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                        "Accept": "application/json",
                    },
                )
                with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                if attempt < retries - 1:
                    time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f"GET {path}{qs} failed on all {BASES}: {last_err}")


# --------------------------------------------------------------------------
# 指标
# --------------------------------------------------------------------------
def ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2.0 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def sma(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    ag = sum(gains[:period]) / period
    al = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        ag = (ag * (period - 1) + gains[i]) / period
        al = (al * (period - 1) + losses[i]) / period
    if al == 0:
        return 100.0
    rs = ag / al
    return 100.0 - (100.0 / (1.0 + rs))


def macd(closes: list[float], fast=12, slow=26, signal=9) -> dict | None:
    if len(closes) < slow + signal:
        return None
    ef, es = ema(closes, fast), ema(closes, slow)
    line = [a - b for a, b in zip(ef, es)]
    sig = ema(line[slow - 1:], signal)
    hist_now = line[-1] - sig[-1]
    hist_prev = line[-2] - sig[-2] if len(sig) > 1 else hist_now
    return {
        "macd": round(line[-1], 4),
        "signal": round(sig[-1], 4),
        "hist": round(hist_now, 4),
        "hist_prev": round(hist_prev, 4),
        "hist_rising": hist_now > hist_prev,
        "cross": "bull" if line[-1] > sig[-1] else "bear",
    }


def atr(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    trs = []
    for i in range(1, len(closes)):
        trs.append(max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        ))
    a = sum(trs[:period]) / period
    for i in range(period, len(trs)):
        a = (a * (period - 1) + trs[i]) / period
    return a


def bollinger(closes: list[float], period: int = 20, mult: float = 2.0) -> dict | None:
    if len(closes) < period:
        return None
    window = closes[-period:]
    mid = sum(window) / period
    var = sum((x - mid) ** 2 for x in window) / period
    sd = var ** 0.5
    up, lo = mid + mult * sd, mid - mult * sd
    pos = (closes[-1] - lo) / (up - lo) if up != lo else 0.5
    return {
        "upper": round(up, 2),
        "mid": round(mid, 2),
        "lower": round(lo, 2),
        "width_pct": round((up - lo) / mid * 100, 3) if mid else None,
        "pct_b": round(pos, 3),
    }


# --------------------------------------------------------------------------
# 数据抓取与分析
# --------------------------------------------------------------------------
def fetch_candles(inst: str, bar: str, limit: int = CANDLE_LIMIT) -> list[list[float]]:
    """返回按时间升序排列的 [ts, o, h, l, c, vol]，仅取已收盘 K 线。"""
    res = _http_get("/api/v5/market/candles", {"instId": inst, "bar": bar, "limit": str(limit)})
    if res.get("code") != "0":
        raise RuntimeError(f"candles {inst} {bar}: {res.get('msg')}")
    rows = []
    for r in res.get("data", []):
        # r[8] == confirm: '1'=已收盘, '0'=进行中
        rows.append([
            int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]),
            int(r[8]) if len(r) > 8 else 1,
        ])
    rows.reverse()  # OKX 返回最新在前，反转为升序
    return rows


def analyze_bar(inst: str, bar: str) -> dict:
    rows = fetch_candles(inst, bar)
    live = rows[-1] if rows and rows[-1][6] == 0 else None
    closed = [r for r in rows if r[6] == 1]
    if len(closed) < 60:
        raise RuntimeError(f"{inst} {bar}: insufficient closed candles ({len(closed)})")

    o = [r[1] for r in closed]
    h = [r[2] for r in closed]
    l = [r[3] for r in closed]
    c = [r[4] for r in closed]
    v = [r[5] for r in closed]

    e20, e50 = ema(c, 20), ema(c, 50)
    e200 = ema(c, 200) if len(c) >= 200 else None
    a14 = atr(h, l, c, 14)
    last = c[-1]

    # 趋势判定：EMA 排列 + 价格位置
    trend = "range"
    if e20[-1] > e50[-1] and last > e20[-1]:
        trend = "up"
    elif e20[-1] < e50[-1] and last < e20[-1]:
        trend = "down"

    # 结构：近 N 根的摆动高低点
    n = min(60, len(c))
    swing_hi, swing_lo = max(h[-n:]), min(l[-n:])

    # 量能：最近一根 vs 20 期均量
    vol_ma20 = sma(v, 20)
    vol_ratio = round(v[-1] / vol_ma20, 3) if vol_ma20 else None

    # 连续 K 线方向（动能）
    streak = 0
    for i in range(len(c) - 1, 0, -1):
        d = 1 if c[i] > o[i] else -1
        if streak == 0 or (streak > 0 and d > 0) or (streak < 0 and d < 0):
            streak += d
        else:
            break

    return {
        "bar": bar,
        "closed_bars": len(closed),
        "last_closed_ts": datetime.fromtimestamp(closed[-1][0] / 1000, CST).strftime("%Y-%m-%d %H:%M:%S"),
        "close": round(last, 2),
        "live_close": round(live[4], 2) if live else None,
        "ema20": round(e20[-1], 2),
        "ema50": round(e50[-1], 2),
        "ema200": round(e200[-1], 2) if e200 else None,
        "above_ema200": (last > e200[-1]) if e200 else None,
        "trend": trend,
        "rsi14": round(rsi(c, 14) or 0, 2),
        "macd": macd(c),
        "atr14": round(a14, 2) if a14 else None,
        "atr_pct": round(a14 / last * 100, 3) if a14 else None,
        "boll": bollinger(c),
        "swing_high_60": round(swing_hi, 2),
        "swing_low_60": round(swing_lo, 2),
        "dist_to_high_pct": round((swing_hi - last) / last * 100, 2),
        "dist_to_low_pct": round((last - swing_lo) / last * 100, 2),
        "vol_ratio": vol_ratio,
        "candle_streak": streak,
        "chg_pct_5": round((last / c[-6] - 1) * 100, 2) if len(c) > 6 else None,
        "chg_pct_20": round((last / c[-21] - 1) * 100, 2) if len(c) > 21 else None,
    }


def fetch_context(inst: str) -> dict:
    """资金费率 / 持仓量 / 24h 盘口。"""
    ctx: dict = {}
    try:
        t = _http_get("/api/v5/market/ticker", {"instId": inst})["data"][0]
        ctx["ticker"] = {
            "last": float(t["last"]),
            "bid": float(t["bidPx"]) if t.get("bidPx") else None,
            "ask": float(t["askPx"]) if t.get("askPx") else None,
            "high24h": float(t["high24h"]),
            "low24h": float(t["low24h"]),
            "vol24h_ccy": float(t["volCcy24h"]),
            "chg24h_pct": round((float(t["last"]) / float(t["open24h"]) - 1) * 100, 2),
        }
    except Exception as exc:  # noqa: BLE001
        ctx["ticker_error"] = str(exc)
    try:
        f = _http_get("/api/v5/public/funding-rate", {"instId": inst})["data"][0]
        ctx["funding"] = {
            "rate_pct": round(float(f["fundingRate"]) * 100, 5),
            "next_rate_pct": round(float(f["nextFundingRate"]) * 100, 5) if f.get("nextFundingRate") else None,
            "next_time": datetime.fromtimestamp(int(f["fundingTime"]) / 1000, CST).strftime("%Y-%m-%d %H:%M:%S"),
        }
    except Exception as exc:  # noqa: BLE001
        ctx["funding_error"] = str(exc)
    try:
        oi = _http_get("/api/v5/public/open-interest", {"instType": "SWAP", "instId": inst})["data"][0]
        ctx["open_interest"] = {"oi_ccy": float(oi["oiCcy"]), "oi_usd": float(oi.get("oiUsd") or 0)}
    except Exception as exc:  # noqa: BLE001
        ctx["oi_error"] = str(exc)
    return ctx


def fetch_top_insts(top: int) -> list[tuple[str, float]]:
    """按 24h 成交额（USDT 计价）取前 top 个 USDT 永续合约（state=live）。

    用户指令（2026-09-03）：不限 BTC/ETH，可交易交易所支持的任意 USDT 永续。
    候选池按流动性（成交额）排序，AI 在候选池内自由选择方向与标的。
    """
    res = _http_get("/api/v5/market/tickers", {"instType": "SWAP"})
    rows = []
    for r in res.get("data", []):
        inst = r.get("instId", "")
        if not inst.endswith("-USDT-SWAP"):
            continue
        try:
            # volCcy24h 是「币数量」，须 × 现价才是 USDT 计价的成交额（否则低价 meme 币会霸榜）
            last = float(r.get("last") or 0)
            ccy = float(r.get("volCcy24h") or 0)
            vol = ccy * last
        except (TypeError, ValueError):
            vol = 0.0
        rows.append((inst, vol))
    rows.sort(key=lambda x: x[1], reverse=True)
    return rows[:top]


def fetch_specs(insts: list[str]) -> dict[str, dict]:
    """获取合约规格（每张面值 / 数量步长 / 价格步长 / 最小下单），一次拉全量再筛选。"""
    want = set(insts)
    specs: dict[str, dict] = {}
    try:
        res = _http_get("/api/v5/public/instruments", {"instType": "SWAP"})
    except Exception:  # noqa: BLE001
        return specs
    for r in res.get("data", []):
        iid = r.get("instId", "")
        if iid not in want:
            continue
        try:
            specs[iid] = {
                "ctVal": float(r.get("ctVal") or 0),
                "lotSz": float(r.get("lotSz") or 0),
                "minSz": float(r.get("minSz") or 0),
                "tickSz": float(r.get("tickSz") or 0),
                "ctType": r.get("ctType", ""),
                "settleCcy": r.get("settleCcy", ""),
                "state": r.get("state", ""),
            }
        except (TypeError, ValueError):
            continue
    return specs


def digest(inst: str, item: dict) -> str:
    """生成单标的的一行精简摘要，供 LLM 全览候选池（避免把整段行情 JSON 塞进上下文）。"""
    bars = item.get("bars", {})
    ctx = item.get("context", {})
    conf = item.get("confluence", {})
    spec = item.get("spec", {})
    tk = ctx.get("ticker", {}) or {}
    fd = ctx.get("funding", {}) or {}

    last = tk.get("last")
    last_s = f"{last:.4f}" if isinstance(last, (int, float)) else "?"
    chg = tk.get("chg24h_pct")
    chg_s = f"{chg:+.2f}%" if isinstance(chg, (int, float)) else "?"

    def g(bar: str, key: str):
        v = (bars.get(bar) or {}).get(key)
        return v

    def trend(bar: str):
        return str(g(bar, "trend") or "-")

    rsi1h = g("1H", "rsi14")
    vr = g("1H", "vol_ratio")
    atrp = g("1H", "atr_pct")

    # 区间分位：60 根 K 线摆动区间内的位置
    lo = g("4H", "swing_low_60")
    hi = g("4H", "swing_high_60")
    close4h = g("4H", "close")
    rp = "?"
    if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) and isinstance(close4h, (int, float)) and hi > lo:
        rp = f"{max(0.0, min(100.0, (close4h - lo) / (hi - lo) * 100)):.0f}%"

    fr = fd.get("rate_pct")
    fr_s = f"{fr:+.4f}%" if isinstance(fr, (int, float)) else "?"

    parts = [
        f"{inst} px{last_s}({chg_s})",
        f"score{conf.get('score', '?')}",
        f"4H:{trend('4H')}/1H:{trend('1H')}/15m:{trend('15m')}",
        f"RSI(1H){rsi1h if isinstance(rsi1h, (int, float)) else '?'}",
        f"volR{vr if isinstance(vr, (int, float)) else '?'}",
        f"ATR%{atrp if isinstance(atrp, (int, float)) else '?'}",
        f"range{rp}",
        f"fund{fr_s}",
    ]
    if spec:
        parts.append(
            f"spec(ctVal{spec.get('ctVal')} lotSz{spec.get('lotSz')} minSz{spec.get('minSz')} tickSz{spec.get('tickSz')})"
        )
    if item.get("error"):
        parts.append(f"err:{item['error'][:60]}")
    return " | ".join(parts)


def confluence(bars: dict) -> dict:
    """多周期共振打分：-100(极空) ~ +100(极多)。权重 4H:0.5 / 1H:0.3 / 15m:0.2"""
    weights = {"4H": 0.5, "1H": 0.3, "15m": 0.2}
    score = 0.0
    detail = {}
    for bar, w in weights.items():
        b = bars.get(bar)
        if not b:
            continue
        s = 0.0
        # 趋势 (±40)
        s += 40 if b["trend"] == "up" else (-40 if b["trend"] == "down" else 0)
        # EMA200 位置 (±20)
        if b.get("above_ema200") is True:
            s += 20
        elif b.get("above_ema200") is False:
            s -= 20
        # MACD (±20)
        m = b.get("macd")
        if m:
            s += 12 if m["cross"] == "bull" else -12
            s += 8 if m["hist_rising"] else -8
        # RSI 极值反向修正 (±20)
        r = b.get("rsi14") or 50
        if r > 72:
            s -= 15
        elif r < 28:
            s += 15
        elif r > 55:
            s += 8
        elif r < 45:
            s -= 8
        s = max(-100, min(100, s))
        detail[bar] = round(s, 1)
        score += s * w
    return {"score": round(score, 1), "per_bar": detail}


def scan_one(inst: str, specs: dict[str, dict]) -> tuple[str, dict]:
    """扫描单个标的（供线程池并发）。"""
    try:
        bars = {b: analyze_bar(inst, b) for b in BARS}
        item = {"bars": bars, "context": fetch_context(inst), "confluence": confluence(bars)}
        if inst in specs:
            item["spec"] = specs[inst]
    except Exception as exc:  # noqa: BLE001
        item = {"error": str(exc)}
    return inst, item


def scan(insts: list[str], specs: dict[str, dict]) -> dict:
    now = datetime.now(CST)
    out = {
        "scan_time_cst": now.strftime("%Y-%m-%d %H:%M:%S"),
        "scan_time_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "source": "OKX public REST (live market data)",
        "instruments": {},
        "digest": [],
    }
    results: dict[str, dict] = {}
    if len(insts) <= 2:
        for inst in insts:
            i, item = scan_one(inst, specs)
            results[i] = item
    else:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            futs = {ex.submit(scan_one, inst, specs): inst for inst in insts}
            for fut in as_completed(futs):
                try:
                    i, item = fut.result()
                except Exception as exc:  # noqa: BLE001
                    i, item = futs[fut], {"error": str(exc)}
                results[i] = item
    # 保持 insts 原始顺序输出
    for inst in insts:
        item = results.get(inst, {"error": "scan failed"})
        out["instruments"][inst] = item
        out["digest"].append(digest(inst, item))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inst", action="append", help="指定标的，可重复（优先级最高）")
    ap.add_argument("--insts", help="逗号分隔的标的列表，如 BTC-USDT-SWAP,ETH-USDT-SWAP")
    ap.add_argument("--top", type=int, default=0, help=f"按 24h 成交额取前 N 个 USDT 永续（默认 {DEFAULT_TOP}）")
    ap.add_argument("--save", help="快照归档目录")
    args = ap.parse_args()

    # 候选池优先级：--inst/--insts 显式指定 > --top N > 默认 top
    explicit = list(args.inst or [])
    if args.insts:
        explicit += [s.strip() for s in args.insts.split(",") if s.strip()]

    if explicit:
        insts = explicit
        universe = None
    else:
        top = args.top if args.top and args.top > 0 else DEFAULT_TOP
        ranked = fetch_top_insts(top)
        insts = [i for i, _ in ranked]
        universe = [
            {"instId": i, "turnoverUsd24h": round(v, 2), "rank": idx + 1}
            for idx, (i, v) in enumerate(ranked)
        ]

    specs = fetch_specs(insts)
    result = scan(insts, specs)
    if universe is not None:
        result["universe"] = universe
        result["universe_note"] = (
            "候选池=按 24h 成交额排序的前 N 个 USDT 永续（state=live）。"
            "可交易候选池内任意标的，做多/做空均可；优先流动性好、规格清晰的标的。"
        )

    if args.save:
        os.makedirs(args.save, exist_ok=True)
        stamp = datetime.now(CST).strftime("%Y%m%dT%H%M%S")
        path = os.path.join(args.save, f"market_{stamp}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
        result["_archived_to"] = path

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
