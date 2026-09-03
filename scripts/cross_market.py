#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cross_market.py — 跨市场关联分析（lead-lag 诊断 + 比价动量回测）

验证 ETH-BTC 的领先-滞后关系是否可交易：
  1. lead-lag 诊断：ETH 过去 k 小时收益 与 BTC 当前收益 的相关系数，找 ETH 领先几小时。
  2. 比价动量回测：ETH/BTC 比价短期动量（ETH 相对走强/走弱）→ 做多/做空 BTC。

用法：
  python scripts/cross_market.py --hours 2160
"""

from __future__ import annotations

import argparse
import math
import sys

import backtest as bt


def corr(x, y):
    n = len(x)
    if n < 3:
        return None
    mx = sum(x) / n
    my = sum(y) / n
    cov = sum((x[i] - mx) * (y[i] - my) for i in range(n))
    vx = sum((a - mx) ** 2 for a in x)
    vy = sum((b - my) ** 2 for b in y)
    if vx == 0 or vy == 0:
        return None
    return cov / math.sqrt(vx * vy)


def load_aligned(insts, hours):
    data = {}
    for inst in insts:
        c = bt.fetch_candles(inst, "1H", hours + bt.WARMUP + bt.MAX_HOLD_BARS)
        data[inst] = {row[0]: row for row in c}  # ts -> [ts,o,h,l,c,vol]
    common = sorted(set(data[insts[0]].keys()) & set(data[insts[1]].keys()))
    return data, common


def lead_lag(data, common, inst_a, inst_b, max_lag=24):
    ra, rb = [], []
    for i in range(1, len(common)):
        a0 = data[inst_a].get(common[i - 1])
        a1 = data[inst_a].get(common[i])
        b0 = data[inst_b].get(common[i - 1])
        b1 = data[inst_b].get(common[i])
        if a0 and a1 and b0 and b1:
            ra.append(a1[4] / a0[4] - 1)
            rb.append(b1[4] / b0[4] - 1)
    n = len(ra)
    out = []
    for k in range(max_lag + 1):
        # A 在 t-k 的收益 vs B 在 t 的收益（k>0 表示 A 领先 B）
        c = corr(ra[: n - k], rb[k:])
        out.append((k, c))
    return out


def ratio_momentum_backtest(inst_btc, inst_eth, data, common, hours, lookback, threshold):
    # 构建 BTC 的 K 线序列（用 common 时间轴）
    ts_list = [t for t in common if t in data[inst_btc]]
    btc_close = [data[inst_btc][t][4] for t in ts_list]
    btc_high = [data[inst_btc][t][2] for t in ts_list]
    btc_low = [data[inst_btc][t][3] for t in ts_list]
    eth_close = [data[inst_eth][t][4] if t in data[inst_eth] else None for t in ts_list]

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

    for i in range(bt.WARMUP + lookback, len(ts_list) - 1):
        if pos:
            hi, lo = btc_high[i], btc_low[i]
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
                close(btc_close[i], i, "超时")
            continue

        # 比价动量：ETH/BTC 过去 lookback 根的变化
        r_now = eth_close[i] / btc_close[i]
        r_prev = eth_close[i - lookback] / btc_close[i - lookback]
        mom = r_now / r_prev - 1
        if mom >= threshold:
            side = "long"
        elif mom <= -threshold:
            side = "short"
        else:
            continue

        ind = bt.compute_indicators(btc_close[: i + 1], btc_high[: i + 1], btc_low[: i + 1],
                                    [0.0] * (i + 1))
        if ind["atr14"] is None or ind["atr14"] <= 0:
            continue

        entry = btc_close[i + 1] if i + 1 < len(ts_list) else btc_close[i]
        atr = ind["atr14"]
        stop = entry - bt.ATR_STOP_MULT * atr if side == "long" else entry + bt.ATR_STOP_MULT * atr
        tp = entry + bt.TP_RR * bt.ATR_STOP_MULT * atr if side == "long" else entry - bt.TP_RR * bt.ATR_STOP_MULT * atr
        pos = {"side": side, "entry": entry, "stop": stop, "tp": tp, "open_i": i + 1}

    if pos:
        close(btc_close[-1], len(ts_list) - 1, "回测结束")
    return bt.summarize(trades)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=2160)
    ap.add_argument("--lookback", type=int, default=6, help="比价动量回看小时数")
    ap.add_argument("--threshold", type=float, default=0.01, help="比价动量阈值（默认 0.01）")
    args = ap.parse_args()

    data, common = load_aligned(["BTC-USDT-SWAP", "ETH-USDT-SWAP"], args.hours)
    print(f"对齐 K 线 {len(common)} 根（近 {args.hours}h）")

    # 1) lead-lag 诊断
    print("\n[lead-lag] ETH 领先 BTC 的相关系数（k=ETH领先小时数）:")
    for k, c in lead_lag(data, common, "ETH-USDT-SWAP", "BTC-USDT-SWAP", 12):
        print(f"  k={k:>2}  corr={'-' if c is None else round(c, 3)}")

    # 2) 比价动量回测
    print(f"\n[比价动量回测] lookback={args.lookback}h threshold={args.threshold * 100:.1f}%")
    for lb, th in [(4, 0.01), (6, 0.01), (12, 0.015), (24, 0.02)]:
        r = ratio_momentum_backtest("BTC-USDT-SWAP", "ETH-USDT-SWAP", data, common, args.hours, lb, th)
        wr = f"{r['winRate']:.1f}" if r["winRate"] is not None else "-"
        pf = f"{r['profitFactor']:.2f}" if r["profitFactor"] is not None else "-"
        print(f"  lb={lb:>2} th={th:.3f}: 笔数{r['trades']:>4} 胜率{wr:>7}% PF{pf:>7} 总收益{r['totalPnlPct']:>8}% 回撤{r['maxDrawdownPct']:>7}%")


if __name__ == "__main__":
    main()
