#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scalper_backtest.py — 超短线策略历史回测引擎

与 scripts/scalper.py 的策略严格一致：
  趋势  ：最近 5 根 1m 收盘价的最小二乘斜率（>0 做多，<0 做空，必出方向）
  止损  ：ATR(1m, 14) × atr-mult
  止盈  ：止损距离 × 凯利盈亏比 RR（强趋势胜率 0.60 / 弱 0.52，RR 夹 [1.5, 4.0]）
  成本  ：taker 双边 fee-rate × 2（开、平各计一次）
  反转  ：可选 --close-on-reversal，持仓期间趋势反向则平仓
  执行  ：信号在已收盘 K 线后产生 → 下一根开盘价入场（无未来函数）

用法：
  python scripts/scalper_backtest.py --inst BTC-USDT-SWAP --start 2026-09-01 [--end 2026-09-03]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

from market_scan import _http_get

CST = timezone(timedelta(hours=8))
BAR_MS = 60_000  # 1m

# K 线缓存库：先查库，缺的区间才从 OKX 拉，拉到即入库（下次秒开）
DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "scalper_candles.db"
)


def _db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS candles ("
        "inst TEXT NOT NULL, bar TEXT NOT NULL, ts INTEGER NOT NULL,"
        "o REAL, h REAL, l REAL, c REAL, vol REAL,"
        "PRIMARY KEY (inst, bar, ts))"
    )
    return conn


def parse_time(s: str) -> int:
    s = s.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return int(datetime.strptime(s, fmt).replace(tzinfo=CST).timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError(f"无法解析时间: {s}")


def fmt_ts(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, CST).strftime("%Y-%m-%d %H:%M:%S")


def fetch_okx(inst: str, start_ms: int, end_ms: int) -> list[list[float]]:
    """从 OKX 拉 [start_ms, end_ms] 区间的 1m 已收盘 K 线，升序返回 [ts,o,h,l,c,vol]。

    注意：history-candles 用 `after` 游标向前翻页（返回该时间戳「之前」更旧的数据），
    与 /market/candles 的 before 语义相反，踩过坑。
    """
    rows: list[list[float]] = []
    after = end_ms
    while True:
        res = _http_get(
            "/api/v5/market/history-candles",
            {"instId": inst, "bar": "1m", "limit": "100", "after": str(after)},
        )
        if res.get("code") != "0":
            raise RuntimeError(f"history-candles {inst}: {res.get('msg')}")
        data = res.get("data", [])
        if not data:
            break
        oldest = int(data[-1][0])
        for r in data:
            ts = int(r[0])
            if len(r) > 8 and r[8] == "0":
                continue  # 跳过进行中的 K 线
            if ts < start_ms or ts > end_ms:
                continue
            rows.append([ts, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])])
        if oldest <= start_ms or len(data) < 100:
            break
        after = oldest
    rows.sort(key=lambda x: x[0])
    return rows


def fetch_history(inst: str, start_ms: int, end_ms: int) -> tuple[list[list[float]], dict]:
    """带 SQLite 缓存的取数：先查库，缺口区间才拉 OKX，拉到即入库。

    返回 ([ts,o,h,l,c,vol] 升序, 缓存信息 {fromDb, fetched})。
    判定命中：库内覆盖 [start, end]（末端容差 1 根，因最后一根可能刚收盘）且无内部空洞。
    """
    conn = _db()
    try:
        lo, hi, cnt = conn.execute(
            "SELECT MIN(ts), MAX(ts), COUNT(*) FROM candles "
            "WHERE inst=? AND bar=? AND ts BETWEEN ? AND ?",
            (inst, "1m", start_ms, end_ms),
        ).fetchone()

        def _covered() -> bool:
            if lo is None or hi is None:
                return False
            if lo > start_ms or hi < end_ms - BAR_MS:
                return False
            # 库内根数应接近满配（允许 2 根容差，防交易所个别缺根导致永远不命中）
            return cnt >= (hi - lo) // BAR_MS + 1 - 2

        fetched = 0
        if not _covered():
            segs: list[tuple[int, int]] = []
            if lo is None:
                segs.append((start_ms, end_ms))
            else:
                if lo > start_ms:
                    segs.append((start_ms, min(lo - BAR_MS, end_ms)))
                if hi < end_ms - BAR_MS:
                    segs.append((max(hi + BAR_MS, start_ms), end_ms))
            for s, e in segs:
                if e < s:
                    continue
                rows = fetch_okx(inst, s, e)
                conn.executemany(
                    "INSERT OR REPLACE INTO candles VALUES (?,?,?,?,?,?,?,?)",
                    [(inst, "1m", r[0], r[1], r[2], r[3], r[4], r[5]) for r in rows],
                )
                conn.commit()
                fetched += len(rows)

        out = conn.execute(
            "SELECT ts, o, h, l, c, vol FROM candles "
            "WHERE inst=? AND bar=? AND ts BETWEEN ? AND ? ORDER BY ts",
            (inst, "1m", start_ms, end_ms),
        ).fetchall()
        return [list(r) for r in out], {"fromDb": cnt or 0, "fetched": fetched}
    finally:
        conn.close()


def linear_slope(closes: list[float], n: int = 5) -> float:
    """最近 n 根收盘价的最小二乘斜率（每根单位时间内的价格变化量）。"""
    ys = closes[-n:] if len(closes) >= n else closes
    m = len(ys)
    if m < 2:
        return 0.0
    xm = (m - 1) / 2.0
    ym = sum(ys) / m
    denom = sum((x - xm) ** 2 for x in range(m))
    if denom == 0:
        return 0.0
    return sum((x - xm) * (y - ym) for x, y in zip(range(m), ys)) / denom


def detect_trend(closes: list[float]) -> tuple[str, str]:
    """返回 (direction, strength)。与 scalper.py 完全一致。"""
    last = closes[-1]
    slope = linear_slope(closes, 5)
    slope_pct = slope / last if last else 0.0
    direction = "long" if slope_pct >= 0 else "short"
    strength = "strong" if abs(slope_pct) >= 0.0002 else "weak"
    return direction, strength


def kelly_rr(win_rate: float) -> float:
    q = 1.0 - win_rate
    rr0 = q / win_rate
    return max(1.5, min(rr0 * 2.0, 4.0))


def run(inst, start_ms, end_ms, atr_mult, fee_rate, notional, close_on_reversal):
    warmup = 60  # 预热 K 线（ATR 14 + 斜率 5，留足余量）
    candles, cache_info = fetch_history(inst, start_ms - warmup * BAR_MS, end_ms)
    if len(candles) < warmup + 5:
        raise RuntimeError(f"1m 已收盘 K 线不足（仅 {len(candles)} 根）")

    ts = [c[0] for c in candles]
    o = [c[1] for c in candles]
    h = [c[2] for c in candles]
    l = [c[3] for c in candles]
    c = [c[4] for c in candles]

    fee_amt = notional * fee_rate * 2  # 双边手续费（固定名义金额）
    fee_pct = fee_rate * 2 * 100

    # 预热 Wilder ATR 到根 warmup-1
    atr_val = 0.0
    tr_seed: list[float] = []
    for k in range(1, warmup):
        tr = max(h[k] - l[k], abs(h[k] - c[k - 1]), abs(l[k] - c[k - 1]))
        if len(tr_seed) < 14:
            tr_seed.append(tr)
            if len(tr_seed) == 14:
                atr_val = sum(tr_seed) / 14
        else:
            atr_val = (atr_val * 13 + tr) / 14

    trades: list[dict] = []
    pos = None  # {side, entry, sl, tp, open_i, open_ts, rr}

    def close_trade(exit_px, exit_i, reason):
        nonlocal pos
        side = pos["side"]
        entry = pos["entry"]
        raw_pct = (exit_px / entry - 1) * (1 if side == "long" else -1) * 100
        net_pct = raw_pct - fee_pct
        raw_usdt = notional * raw_pct / 100
        net_usdt = raw_usdt - fee_amt
        trades.append({
            "n": len(trades) + 1,
            "side": side,
            "entryTs": fmt_ts(pos["open_ts"]),
            "exitTs": fmt_ts(ts[exit_i]),
            "entry": round(entry, 2),
            "exit": round(exit_px, 2),
            "sl": round(pos["sl"], 2),
            "tp": round(pos["tp"], 2),
            "bars": exit_i - pos["open_i"],
            "reason": reason,
            "rr": round(pos["rr"], 3),
            "pnlPct": round(raw_pct, 4),
            "feePct": round(fee_pct, 4),
            "netPnlPct": round(net_pct, 4),
            "pnlUsdt": round(raw_usdt, 4),
            "feeUsdt": round(fee_amt, 4),
            "netPnlUsdt": round(net_usdt, 4),
        })
        pos = None

    i = warmup
    while i < len(candles) - 1:
        # 用根 i 的 TR 更新 Wilder ATR（得到截至根 i 的 ATR）
        tr = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        atr_val = (atr_val * 13 + tr) / 14

        # 当前趋势（截至根 i 的收盘价，最近 5 根斜率）
        direction, strength = detect_trend(c[i - 4:i + 1])

        if pos is not None:
            # 持仓：先查止损止盈（同根同时触及保守按止损），再查趋势反转
            exit_px = None
            reason = None
            if pos["side"] == "long":
                if l[i] <= pos["sl"]:
                    exit_px, reason = pos["sl"], "止损"
                elif h[i] >= pos["tp"]:
                    exit_px, reason = pos["tp"], "止盈"
            else:
                if h[i] >= pos["sl"]:
                    exit_px, reason = pos["sl"], "止损"
                elif l[i] <= pos["tp"]:
                    exit_px, reason = pos["tp"], "止盈"
            if exit_px is None and close_on_reversal and direction != pos["side"]:
                exit_px, reason = c[i], "趋势反转"
            if exit_px is not None:
                close_trade(exit_px, i, reason)
                i += 1
                continue
        else:
            # 空仓：信号入场（下一根开盘价，避免未来函数）
            if atr_val > 0:
                win_rate = 0.60 if strength == "strong" else 0.52
                rr = kelly_rr(win_rate)
                sl_dist = atr_val * atr_mult
                tp_dist = sl_dist * rr
                entry = o[i + 1]
                if direction == "long":
                    sl = entry - sl_dist
                    tp = entry + tp_dist
                else:
                    sl = entry + sl_dist
                    tp = entry - tp_dist
                pos = {
                    "side": direction,
                    "entry": entry,
                    "sl": sl,
                    "tp": tp,
                    "open_i": i + 1,
                    "open_ts": ts[i + 1],
                    "rr": rr,
                }
        i += 1

    # 结束仍持仓 → 最后一根收盘价平
    if pos is not None:
        close_trade(c[-1], len(candles) - 1, "回测结束")

    return {**summarize(trades, len(candles)), "cache": cache_info}


def summarize(trades: list[dict], bars: int) -> dict:
    n = len(trades)
    empty = {
        "bars": bars,
        "summary": {
            "trades": 0, "longs": 0, "shorts": 0, "winRate": None,
            "totalPnlUsdt": 0.0, "totalNetPnlUsdt": 0.0, "totalFeeUsdt": 0.0,
            "totalNetPnlPct": 0.0, "avgNetPnlPct": None, "profitFactor": None,
            "maxDrawdownPct": 0.0, "sharpe": None, "avgBars": None,
        },
        "trades": [],
    }
    if n == 0:
        return empty

    wins = [t for t in trades if t["netPnlUsdt"] > 0]
    losses = [t for t in trades if t["netPnlUsdt"] <= 0]
    gross_win = sum(t["netPnlUsdt"] for t in wins)
    gross_loss = abs(sum(t["netPnlUsdt"] for t in losses))

    total_pnl = sum(t["pnlUsdt"] for t in trades)
    total_net = sum(t["netPnlUsdt"] for t in trades)
    total_fee = sum(t["feeUsdt"] for t in trades)

    # 复利曲线（按 netPnlPct）→ 最大回撤
    eq = 100.0
    peak = 100.0
    max_dd = 0.0
    net_pcts = [t["netPnlPct"] for t in trades]
    for p in net_pcts:
        eq *= (1 + p / 100)
        peak = max(peak, eq)
        max_dd = max(max_dd, (peak - eq) / peak * 100)

    avg = sum(net_pcts) / n
    std = (sum((p - avg) ** 2 for p in net_pcts) / n) ** 0.5 if n > 1 else 0
    sharpe = avg / std * math.sqrt(n) if std > 0 else None

    total_pct = 1.0
    for p in net_pcts:
        total_pct *= (1 + p / 100)
    total_net_pct = (total_pct - 1) * 100

    return {
        "bars": bars,
        "summary": {
            "trades": n,
            "longs": sum(1 for t in trades if t["side"] == "long"),
            "shorts": sum(1 for t in trades if t["side"] == "short"),
            "winRate": round(len(wins) / n * 100, 2),
            "totalPnlUsdt": round(total_pnl, 2),
            "totalNetPnlUsdt": round(total_net, 2),
            "totalFeeUsdt": round(total_fee, 2),
            "totalNetPnlPct": round(total_net_pct, 3),
            "avgNetPnlPct": round(avg, 4),
            "profitFactor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
            "maxDrawdownPct": round(max_dd, 2),
            "sharpe": round(sharpe, 2) if sharpe is not None else None,
            "avgBars": round(sum(t["bars"] for t in trades) / n, 1),
        },
        "trades": trades,
    }


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--inst", default="BTC-USDT-SWAP")
    ap.add_argument("--start", required=True, help="开始时间 YYYY-MM-DD[ HH:MM:SS]（CST）")
    ap.add_argument("--end", default="", help="结束时间，默认现在（CST）")
    ap.add_argument("--atr-mult", type=float, default=2.5, help="止损 = ATR × 该系数")
    ap.add_argument("--fee-rate", type=float, default=0.0005, help="单边 taker 费率")
    ap.add_argument("--notional", type=float, default=10000.0, help="每笔名义金额（USDT，算盈亏金额）")
    ap.add_argument("--close-on-reversal", action="store_true", help="趋势反转平仓")
    args = ap.parse_args()

    try:
        start_ms = parse_time(args.start)
        end_ms = parse_time(args.end) if args.end else int(datetime.now(CST).timestamp() * 1000)
        if end_ms <= start_ms:
            raise ValueError("结束时间必须晚于开始时间")
        result = run(
            args.inst, start_ms, end_ms, args.atr_mult, args.fee_rate,
            args.notional, args.close_on_reversal,
        )
        out = {
            "inst": args.inst,
            "start": fmt_ts(start_ms),
            "end": fmt_ts(end_ms),
            "cache": result.get("cache", {}),
            "params": {
                "atrMult": args.atr_mult,
                "feeRate": args.fee_rate,
                "feePct": round(args.fee_rate * 2 * 100, 3),
                "notional": args.notional,
                "closeOnReversal": args.close_on_reversal,
            },
            **result,
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
