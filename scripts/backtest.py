#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backtest.py — 因子策略历史回测引擎

目的：在 OKX 历史 K 线上回放「因子评分专家」的策略规则，量化其是否真的有
alpha（胜率 / 盈亏比 / 最大回撤 / 夏普），而不是靠 demo 盘慢慢试。

策略规则（严格取自 experts/factor/expert.json，章程 §4）：
  方向  ：多周期共振分 ≥ +28 做多，≤ -28 做空（4H 50% / 1H 30% / 15m 20% 加权，
          本回测用 4H + 1H 两周期，权重归一化为 4H 62.5% / 1H 37.5%）
  过滤  ：4H 与 1H 趋势一致；1H 量比 ≥0.8；4H 区间分位避开 38%~62% 中枢；
          盈亏比 ≥1.6（用 2×ATR 止损 + RR 止盈时天然满足，这里 RR 取 2.0）
  执行  ：信号出现 → 下一根 1H 开盘价入场；止损 2×ATR(1H)；止盈 RR×止损；
          最多持仓 48 根 1H（2 天）超时平仓
  成本  ：taker 0.05% + 滑点 0.02%（开、平各计一次，合计约 0.14%/笔）

说明：
  - 资金费率历史过滤未纳入（弱因子，主要为持仓成本），如需可后续接
    funding-rate-history 端点补齐。
  - 同一根 K 线内同时触及止损与止盈时，保守按「先触止损」处理。
  - 只用「已收盘」K 线的指标做信号，入场用下一根开盘价 → 无未来函数。

用法：
  python scripts/backtest.py                     # BTC+ETH，默认参数
  python scripts/backtest.py --inst BTC-USDT-SWAP --hours 720
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# 域名候选：主站被 DNS 污染/断连时依次回退；环境变量 OKX_PUBLIC_BASE 可强制指定
BASES = (
    [os.environ["OKX_PUBLIC_BASE"].rstrip("/")]
    if os.environ.get("OKX_PUBLIC_BASE")
    else ["https://www.okx.com", "https://aws.okx.com", "https://okx.com"]
)
BASE = BASES[0]
DEFAULT_INSTS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]

# 成本（单边）
TAKER_FEE = 0.0005   # 0.05%
SLIPPAGE = 0.0002    # 0.02%
COST_ONE_WAY = TAKER_FEE + SLIPPAGE

# 策略参数
SCORE_THRESHOLD = 28      # |共振分| ≥28
VOL_RATIO_MIN = 0.8       # 1H 量比下限
RANGE_MID_LOW = 38.0      # 4H 区间分位中枢下沿
RANGE_MID_HIGH = 62.0     # 4H 区间分位中枢上沿
ATR_STOP_MULT = 2.0       # 止损 = 2×ATR(1H)
TP_RR = 2.0               # 止盈 = RR×止损
MAX_HOLD_BARS = 48        # 最多持仓 48 根 1H
WARMUP = 60               # 指标预热 K 线数

WEIGHT_4H = 0.625  # 4H 50% / (4H 50% + 1H 30%)
WEIGHT_1H = 0.375  # 1H 30% / (4H 50% + 1H 30%)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _http_get(path: str, params: dict, retries: int = 3):
    qs = "?" + urllib.parse.urlencode(params)
    ctx = ssl.create_default_context()
    last = None
    for base in BASES:  # 主域名不通（DNS 污染/断连）时换备用域名
        url = base + path + qs
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
                last = exc
                if attempt < retries - 1:
                    time.sleep(1.2 * (attempt + 1))
    raise last


def fetch_candles(inst: str, bar: str, limit: int):
    """分页拉历史 K 线，返回按时间升序的 [ts(ms), o, h, l, c, vol]（仅已收盘）。

    注意：/market/candles 单次最多 300 根，拉更长历史必须用
    /market/history-candles（单页最多 100 根，用 after 游标向前翻页）。
    """
    rows = []
    after = ""
    while len(rows) < limit:
        params = {"instId": inst, "bar": bar, "limit": "100"}
        if after:
            params["after"] = after
        res = _http_get("/api/v5/market/history-candles", params)
        if res.get("code") != "0":
            raise RuntimeError(f"history-candles {inst} {bar}: {res.get('msg')}")
        data = res.get("data", [])
        if not data:
            break
        for r in data:
            # r = [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
            if len(r) > 8 and r[8] == "0":
                continue  # 跳过进行中的 K 线
            rows.append([int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])])
        if len(data) < 100:
            break
        after = str(data[-1][0])  # 最旧一根的时间戳，继续向前翻
    rows.reverse()  # OKX 返回最新在前 → 升序
    return rows[-limit:]


# --------------------------------------------------------------------------- #
# 指标（与 market_scan.py 同公式，此处独立实现以支持滚动回放）
# --------------------------------------------------------------------------- #
def _ema(values, period):
    if not values:
        return []
    k = 2.0 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def _rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50.0
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
    return 100.0 - 100.0 / (1.0 + ag / al)


def _atr(highs, lows, closes, period=14):
    if len(closes) < period + 1:
        return None
    trs = []
    for i in range(1, len(closes)):
        trs.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    a = sum(trs[:period]) / period
    for i in range(period, len(trs)):
        a = (a * (period - 1) + trs[i]) / period
    return a


def _macd(closes, fast=12, slow=26, signal=9):
    if len(closes) < slow + signal:
        return {"cross": "bear", "hist_rising": False}
    ef, es = _ema(closes, fast), _ema(closes, slow)
    line = [a - b for a, b in zip(ef, es)]
    sig = _ema(line[slow - 1:], signal)
    hist_now = line[-1] - sig[-1]
    hist_prev = line[-2] - sig[-2] if len(sig) > 1 else hist_now
    return {
        "cross": "bull" if line[-1] > sig[-1] else "bear",
        "hist_rising": hist_now > hist_prev,
    }


def compute_indicators(closes, highs, lows, vols):
    """给定（截至某时刻的）序列，返回该时刻的指标 dict"""
    last = closes[-1]
    e20 = _ema(closes, 20)
    e50 = _ema(closes, 50)
    e200 = _ema(closes, 200) if len(closes) >= 200 else None
    a14 = _atr(highs, lows, closes, 14)

    trend = "range"
    if e20[-1] > e50[-1] and last > e20[-1]:
        trend = "up"
    elif e20[-1] < e50[-1] and last < e20[-1]:
        trend = "down"

    n = min(60, len(closes))
    swing_hi = max(highs[-n:])
    swing_lo = min(lows[-n:])
    range_pos = (last - swing_lo) / (swing_hi - swing_lo) * 100 if swing_hi != swing_lo else 50.0

    vol_ma20 = sum(vols[-20:]) / 20 if len(vols) >= 20 else 0
    vol_ratio = vols[-1] / vol_ma20 if vol_ma20 else 0.0

    return {
        "close": last,
        "trend": trend,
        "above_ema200": (last > e200[-1]) if e200 else None,
        "rsi14": _rsi(closes),
        "macd": _macd(closes),
        "atr14": a14,
        "range_pos": range_pos,
        "vol_ratio": vol_ratio,
    }


def score_bar(ind):
    """单周期共振打分（-100~+100），与 market_scan.confluence 同规则"""
    s = 0.0
    s += 40 if ind["trend"] == "up" else (-40 if ind["trend"] == "down" else 0)
    if ind["above_ema200"] is True:
        s += 20
    elif ind["above_ema200"] is False:
        s -= 20
    m = ind["macd"]
    s += 12 if m["cross"] == "bull" else -12
    s += 8 if m["hist_rising"] else -8
    r = ind["rsi14"]
    if r > 72:
        s -= 15
    elif r < 28:
        s += 15
    elif r > 55:
        s += 8
    elif r < 45:
        s -= 8
    return max(-100, min(100, s))


def indicator_series(candles, warmup=WARMUP):
    """对每根已收盘 K 线计算指标（前 warmup 根为 None）"""
    closes = [c[4] for c in candles]
    highs = [c[2] for c in candles]
    lows = [c[3] for c in candles]
    vols = [c[5] for c in candles]
    series = [None] * len(candles)
    for i in range(warmup, len(candles)):
        series[i] = compute_indicators(closes[: i + 1], highs[: i + 1], lows[: i + 1], vols[: i + 1])
    return series


# --------------------------------------------------------------------------- #
# 回放
# --------------------------------------------------------------------------- #
def backtest(inst: str, hours: int, filters: dict | None = None):
    # 过滤开关（默认全开；消融测试时关掉某个因子观察绩效变化）
    f = {"trend": True, "vol": True, "range": True}
    if filters:
        f.update(filters)
    # 拉数据：1H 覆盖回测窗口，4H 覆盖更久以供热身与趋势
    c1h = fetch_candles(inst, "1H", hours + WARMUP + MAX_HOLD_BARS)
    c4h = fetch_candles(inst, "4H", math.ceil((hours + WARMUP + MAX_HOLD_BARS) / 4) + 60)

    ts1h = [c[0] for c in c1h]
    ts4h = [c[0] for c in c4h]
    ind1h = indicator_series(c1h)
    ind4h = indicator_series(c4h)

    trades = []
    pos = None  # {side, entry, stop, tp, open_i}

    def close_trade(exit_px, exit_i, reason):
        nonlocal pos
        side = pos["side"]
        entry = pos["entry"]
        pnl_pct = (exit_px / entry - 1) * (1 if side == "long" else -1)
        net_pct = pnl_pct - COST_ONE_WAY * 2  # 开 + 平 各一次成本
        trades.append({
            "side": side,
            "entry": round(entry, 2),
            "exit": round(exit_px, 2),
            "bars": exit_i - pos["open_i"],
            "reason": reason,
            "pnlPct": round(net_pct * 100, 3),
        })
        pos = None

    for i in range(WARMUP, len(c1h) - 1):
        # 持仓管理
        if pos is not None:
            bar = c1h[i]
            hi, lo = bar[2], bar[3]
            if pos["side"] == "long":
                if lo <= pos["stop"]:
                    close_trade(pos["stop"], i, "止损")
                    # 同根也触及止盈时保守按止损
                elif hi >= pos["tp"]:
                    close_trade(pos["tp"], i, "止盈")
            else:
                if hi >= pos["stop"]:
                    close_trade(pos["stop"], i, "止损")
                elif lo <= pos["tp"]:
                    close_trade(pos["tp"], i, "止盈")
            # 超时平仓（用本根收盘价）
            if pos is not None and i - pos["open_i"] >= MAX_HOLD_BARS:
                close_trade(bar[4], i, "超时")
            continue

        # 信号评估（只用已收盘数据）
        i1 = ind1h[i]
        if i1 is None or i1["atr14"] is None or i1["atr14"] <= 0:
            continue
        # 找最近已收盘 4H：ts4h[j] + 4h <= ts1h[i] + 1h  →  ts4h[j] <= ts1h[i] - 3h
        j = bisect.bisect_right(ts4h, ts1h[i] - 3 * 3600 * 1000) - 1
        if j < 0:
            continue
        i4 = ind4h[j]
        if i4 is None:
            continue

        score = WEIGHT_4H * score_bar(i4) + WEIGHT_1H * score_bar(i1)

        # 过滤
        if score >= SCORE_THRESHOLD:
            side = "long"
        elif score <= -SCORE_THRESHOLD:
            side = "short"
        else:
            continue

        # 4H 与 1H 趋势「不冲突」（4H=range 时以 1H 为主导；方向由共振分正负决定）
        if f["trend"]:
            conflict = (i4["trend"] == "up" and i1["trend"] == "down") or (
                i4["trend"] == "down" and i1["trend"] == "up"
            )
            if conflict:
                continue
        # 1H 量比
        if f["vol"] and i1["vol_ratio"] < VOL_RATIO_MIN:
            continue
        # 4H 区间分位避开 38%~62% 中枢
        if f["range"] and RANGE_MID_LOW <= i4["range_pos"] <= RANGE_MID_HIGH:
            continue

        # 入场 = 下一根 1H 开盘价
        entry = c1h[i + 1][1]
        atr = i1["atr14"]
        stop = entry - ATR_STOP_MULT * atr if side == "long" else entry + ATR_STOP_MULT * atr
        tp = entry + TP_RR * ATR_STOP_MULT * atr if side == "long" else entry - TP_RR * ATR_STOP_MULT * atr
        pos = {"side": side, "entry": entry, "stop": stop, "tp": tp, "open_i": i + 1}

    # 结束仍持仓 → 用最后一根收盘价平
    if pos is not None:
        close_trade(c1h[-1][4], len(c1h) - 1, "回测结束")

    return summarize(trades)


def summarize(trades):
    n = len(trades)
    if n == 0:
        return {"trades": 0, "winRate": None, "avgPnlPct": None, "profitFactor": None,
                "maxDrawdownPct": None, "sharpe": None, "totalPnlPct": 0, "list": []}
    wins = [t for t in trades if t["pnlPct"] > 0]
    losses = [t for t in trades if t["pnlPct"] <= 0]
    gross_win = sum(t["pnlPct"] for t in wins)
    gross_loss = abs(sum(t["pnlPct"] for t in losses))

    # 累计收益曲线 → 最大回撤
    eq = 100.0
    peak = 100.0
    max_dd = 0.0
    pnls = [t["pnlPct"] for t in trades]
    for p in pnls:
        eq *= (1 + p / 100)
        peak = max(peak, eq)
        max_dd = max(max_dd, (peak - eq) / peak * 100)

    avg = sum(pnls) / n
    std = (sum((p - avg) ** 2 for p in pnls) / n) ** 0.5 if n > 1 else 0
    sharpe = avg / std * math.sqrt(n) if std > 0 else None  # 简化年化（按交易笔数）

    total = 1.0
    for p in pnls:
        total *= (1 + p / 100)
    total_pnl = (total - 1) * 100

    return {
        "trades": n,
        "winRate": round(len(wins) / n * 100, 2),
        "avgPnlPct": round(avg, 3),
        "profitFactor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "maxDrawdownPct": round(max_dd, 2),
        "sharpe": round(sharpe, 2) if sharpe is not None else None,
        "totalPnlPct": round(total_pnl, 2),
        "list": trades,
    }


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--inst", action="append", help="标的，可重复；默认 BTC+ETH")
    ap.add_argument("--hours", type=int, default=720, help="回测窗口（小时，默认 720 = 30 天）")
    args = ap.parse_args()

    insts = args.inst or DEFAULT_INSTS
    out = {"asOf": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "params": {"hours": args.hours, "costPerTradePct": round(COST_ONE_WAY * 2 * 100, 3),
                      "scoreThreshold": SCORE_THRESHOLD, "atrStopMult": ATR_STOP_MULT, "tpRR": TP_RR},
           "instruments": {}}
    for inst in insts:
        try:
            out["instruments"][inst] = backtest(inst, args.hours)
        except Exception as exc:  # noqa: BLE001
            out["instruments"][inst] = {"error": str(exc)}

    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
