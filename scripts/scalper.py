#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scalper.py — 超短线（超高频）信号引擎（独立于主轮次）

用途：拉 1 分钟 K 线，强制识别趋势方向（趋势一定有，必出 long/short），
      用凯利公式推导止盈止损的盈亏比（RR），再结合 ATR 与手续费计算出
      含手续费的止盈 / 止损价。只输出信号 JSON，不下单（下单在 TS 侧，
      开单与止损止盈 OCO 同挂）。

数据源：OKX 公开 REST（无需认证），复用 market_scan 的 _http_get / ema / atr。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone

from market_scan import _http_get, ema, atr, fetch_specs

CST = timezone(timedelta(hours=8))


def fetch_candles_1m(inst: str, limit: int = 120) -> list[list[float]]:
    """返回按时间升序的 [ts, o, h, l, c, vol, confirm]，仅已收盘 1m K 线。"""
    res = _http_get("/api/v5/market/candles", {"instId": inst, "bar": "1m", "limit": str(limit)})
    if res.get("code") != "0":
        raise RuntimeError(f"candles {inst} 1m: {res.get('msg')}")
    rows = []
    for r in res.get("data", []):
        rows.append([
            int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]),
            int(r[8]) if len(r) > 8 else 1,
        ])
    rows.reverse()
    return [r for r in rows if r[6] == 1]


def detect_trend(closes: list[float], ema9: list[float], ema21: list[float]) -> tuple[str, str]:
    """强制识别趋势：EMA 排列 + 动量。趋势一定有，必返回 long 或 short。

    返回 (direction, strength)，direction ∈ {long, short}，strength ∈ {strong, weak}。
    """
    last = closes[-1]
    if last > ema9[-1] > ema21[-1]:
        return "long", "strong"
    if last < ema9[-1] < ema21[-1]:
        return "short", "strong"
    # EMA 纠缠时用动量强制选方向（最近 5 根收盘变化）
    mom = closes[-1] - closes[-6] if len(closes) >= 6 else closes[-1] - closes[0]
    return ("long" if mom >= 0 else "short"), "weak"


def kelly_rr(win_rate: float) -> float:
    """用凯利公式推导盈亏比 RR（止盈距离 / 止损距离）。

    保本盈亏比 RR0 = q/p 是凯利 f*=0 的临界（期望恰好为 0）。
    在保本基础上翻倍取安全边际，并夹在 [1.5, 4.0]：
    趋势越强（胜率越高），RR0 越小、RR 越低；趋势弱则 RR 抬高补偿。
    """
    q = 1.0 - win_rate
    rr0 = q / win_rate  # 凯利保本盈亏比
    rr = rr0 * 2.0
    return max(1.5, min(rr, 4.0))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inst", default="BTC-USDT-SWAP")
    ap.add_argument("--bars", type=int, default=120)
    ap.add_argument("--atr-mult", type=float, default=2.5, help="止损距离 = ATR × 该系数")
    ap.add_argument("--fee-rate", type=float, default=0.0005, help="单边 taker 手续费率（默认 0.0005）")
    args = ap.parse_args()

    try:
        rows = fetch_candles_1m(args.inst, args.bars)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"拉取 1m K 线失败: {exc}"}, ensure_ascii=False))
        return 1

    if len(rows) < 30:
        print(json.dumps({"error": f"1m 已收盘 K 线不足: {len(rows)}"}, ensure_ascii=False))
        return 1

    closes = [r[4] for r in rows]
    highs = [r[2] for r in rows]
    lows = [r[3] for r in rows]

    e9 = ema(closes, 9)
    e21 = ema(closes, 21)
    direction, strength = detect_trend(closes, e9, e21)

    a = atr(highs, lows, closes, 14) or 0.0
    last = closes[-1]
    if a <= 0 or last <= 0:
        print(json.dumps({"error": "ATR 或现价无效"}, ensure_ascii=False))
        return 1

    win_rate = 0.60 if strength == "strong" else 0.52
    rr = kelly_rr(win_rate)
    kelly_f = win_rate - (1.0 - win_rate) / rr  # 凯利理论仓位比例（参考值）

    sl_dist = a * args.atr_mult
    tp_dist = sl_dist * rr

    fee = args.fee_rate * 2.0  # 开平双边手续费
    # 止盈必须覆盖手续费，否则放大到至少 1.5 倍手续费
    if tp_dist / last < fee:
        tp_dist = last * fee * 1.5

    if direction == "long":
        sl = last - sl_dist
        tp = last + tp_dist
    else:
        sl = last + sl_dist
        tp = last - tp_dist

    spec = fetch_specs([args.inst]).get(args.inst, {})

    out = {
        "inst": args.inst,
        "direction": direction,
        "strength": strength,
        "entry_ref": round(last, 8),
        "sl": round(sl, 8),
        "tp": round(tp, 8),
        "atr": round(a, 8),
        "atr_pct": round(a / last * 100, 4),
        "rr": round(rr, 4),
        "win_rate": win_rate,
        "kelly_f": round(kelly_f, 4),
        "fee_rate": args.fee_rate,
        "fee_pct": round(fee * 100, 4),
        "sl_dist_pct": round(sl_dist / last * 100, 4),
        "tp_dist_pct": round(tp_dist / last * 100, 4),
        "net_tp_pct": round(tp_dist / last * 100 - fee * 100, 4),
        "net_sl_pct": round(sl_dist / last * 100 + fee * 100, 4),
        "spec": {
            "ctVal": spec.get("ctVal", 0),
            "lotSz": spec.get("lotSz", 0),
            "minSz": spec.get("minSz", 0),
            "tickSz": spec.get("tickSz", 0),
        },
        "closes": [round(c, 2) for c in closes[-60:]],  # 最近 60 根收盘价（供 LLM 判向）
        "sl_dist": round(sl_dist, 8),
        "tp_dist": round(tp_dist, 8),
        "bars": len(rows),
        "ts": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
