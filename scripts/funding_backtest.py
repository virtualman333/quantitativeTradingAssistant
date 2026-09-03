#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
funding_backtest.py — 资金费率因子回测

验证「衍生品结构」因子是否有 alpha（相比纯技术因子的优势）。

资金费率两种经典用法：
  reversal（反转）：费率极端偏高=多头拥挤→超买→做空；极端偏低=空头拥挤→做多。
  trend   （趋势）：费率持续为正且高=多头强势→顺势做多；为负→顺势做空。

用法：
  python scripts/funding_backtest.py --inst BTC-USDT-SWAP --hours 2160
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import sys
import urllib.parse
import urllib.request

import backtest as bt

OKX = "https://www.okx.com"


def fetch_funding(inst: str, hours: int):
    """分页拉 funding-rate-history，返回按 fundingTime 升序的 [(ts_ms, rate), ...]"""
    rows = []
    before = ""
    need = hours // 8 + 20
    while len(rows) < need:
        params = {"instId": inst, "limit": "100"}
        if before:
            params["before"] = before
        url = OKX + "/api/v5/public/funding-rate-history?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=25) as resp:
            d = json.loads(resp.read().decode())
        data = d.get("data", [])
        if d.get("code") != "0" or not data:
            break
        for x in data:
            rows.append((int(x["fundingTime"]), float(x["fundingRate"])))
        if len(data) < 100:
            break
        before = str(data[-1]["fundingTime"])
    rows.sort()
    return rows


def funding_backtest(inst: str, hours: int, mode: str, threshold: float):
    c1h = bt.fetch_candles(inst, "1H", hours + bt.WARMUP + bt.MAX_HOLD_BARS)
    funds = fetch_funding(inst, hours)
    f_ts = [f[0] for f in funds]
    ts1h = [c[0] for c in c1h]

    trades = []
    pos = None

    def close(exit_px, exit_i, reason):
        nonlocal pos
        side, entry = pos["side"], pos["entry"]
        pnl = (exit_px / entry - 1) * (1 if side == "long" else -1)
        net = pnl - bt.COST_ONE_WAY * 2
        trades.append({"side": side, "entry": round(entry, 2), "exit": round(exit_px, 2),
                       "bars": exit_i - pos["open_i"], "reason": reason, "pnlPct": round(net * 100, 3)})
        pos = None

    for i in range(bt.WARMUP, len(c1h) - 1):
        if pos:
            bar = c1h[i]
            hi, lo = bar[2], bar[3]
            if pos["side"] == "long":
                if lo <= pos["stop"]:
                    close(pos["stop"], i, "止损")
                elif hi >= pos["tp"]:
                    close(pos["tp"], i, "止盈")
            else:
                if hi >= pos["stop"]:
                    close(pos["stop"], i, "止损")
                elif lo <= pos["tp"]:
                    close(pos["tp"], i, "止盈")
            if pos and i - pos["open_i"] >= bt.MAX_HOLD_BARS:
                close(bar[4], i, "超时")
            continue

        # 当前有效资金费率 = 最近一次 funding 结算（fundingTime <= 1H[i] 收盘时刻）
        j = bisect.bisect_right(f_ts, ts1h[i] + 3600 * 1000) - 1
        if j < 0:
            continue
        rate = funds[j][1]

        if mode == "reversal":
            if rate >= threshold:
                side = "short"
            elif rate <= -threshold:
                side = "long"
            else:
                continue
        else:  # trend
            if rate >= threshold:
                side = "long"
            elif rate <= -threshold:
                side = "short"
            else:
                continue

        # 入场需要 ATR
        ind = bt.compute_indicators(
            [c[4] for c in c1h[: i + 1]], [c[2] for c in c1h[: i + 1]],
            [c[3] for c in c1h[: i + 1]], [c[5] for c in c1h[: i + 1]])
        if ind["atr14"] is None or ind["atr14"] <= 0:
            continue

        entry = c1h[i + 1][1]
        atr = ind["atr14"]
        stop = entry - bt.ATR_STOP_MULT * atr if side == "long" else entry + bt.ATR_STOP_MULT * atr
        tp = entry + bt.TP_RR * bt.ATR_STOP_MULT * atr if side == "long" else entry - bt.TP_RR * bt.ATR_STOP_MULT * atr
        pos = {"side": side, "entry": entry, "stop": stop, "tp": tp, "open_i": i + 1}

    if pos:
        close(c1h[-1][4], len(c1h) - 1, "回测结束")
    return bt.summarize(trades)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--inst", action="append")
    ap.add_argument("--hours", type=int, default=2160)
    ap.add_argument("--threshold", type=float, default=0.0005, help="费率阈值（默认 0.0005）")
    args = ap.parse_args()

    def fmt(v, prec=2):
        return f"{v:.{prec}f}" if v is not None else "-"

    insts = args.inst or bt.DEFAULT_INSTS
    for inst in insts:
        print(f"\n===== {inst}（近 {args.hours}h，阈值 {args.threshold * 100:.3f}%）=====")
        for mode, label in [("reversal", "极值反转"), ("trend", "极值趋势")]:
            try:
                r = funding_backtest(inst, args.hours, mode, args.threshold)
                print(f"{label:<6} 笔数{r['trades']:>4} 胜率{fmt(r['winRate'], 1):>7} PF{fmt(r['profitFactor']):>7} 总收益{fmt(r['totalPnlPct']):>8} 回撤{fmt(r['maxDrawdownPct']):>7}")
            except Exception as e:  # noqa: BLE001
                print(f"{label} ERR {e}")


if __name__ == "__main__":
    main()
