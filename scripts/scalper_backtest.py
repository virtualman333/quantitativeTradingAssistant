#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scalper_backtest.py — 超短线策略历史回测引擎

默认内置策略与 scripts/scalper.py 严格一致：
  趋势  ：最近 5 根 1m 收盘价的最小二乘斜率（>0 做多，<0 做空，必出方向）
  止损  ：ATR(1m, 14) × atr-mult
  止盈  ：止损距离 × 凯利盈亏比 RR（强趋势胜率 0.60 / 弱 0.52，RR 夹 [1.5, 4.0]）
  成本  ：taker 双边 fee-rate × 2（开、平各计一次）+ 可选 --slippage-bps 单边滑点
  反转  ：可选 --close-on-reversal，持仓期间趋势反向则平仓
  出场  ：可选 --rr 固定止盈倍率（0=自动凯利/策略优先）、--max-hold 持仓超时（分钟）平仓
  执行  ：信号在已收盘 K 线后产生 → 下一根开盘价入场（无未来函数）

K 线周期：
  --bar 1m/3m/5m/15m/30m/1H/4H/6H/12H/1D…，默认 1m。数据层只向 OKX 拉 1m 一种
  K 线（含 SQLite 缓存，同区间只拉一次）；5m/15m/1H 等由 1m 本地聚合入库后再回测，
  因此同一区间无论按多少周期、拆成多少段批量回测，都不会重复请求行情。

支持自定义策略：
  --strategy DIR  加载 agent/strategies/<id>/strategy.py 的 signal(ctx) 逐根判向，
                  支持 flat（观望不开仓）、可选覆盖 atr_mult / rr，
                  或直接返回 sl/tp 止盈止损点位（按信号根收盘价换算成距离，
                  在下一根开盘价入场时重建，与实盘 scalper.py 口径一致）；
                  close-on-reversal 时策略反向（非 flat）才触发反转平仓。

进度（回测 job）：
  --job-id ID    每根 K 线都向 stderr 周期打印 {"p":..,"stage":".."} 进度 JSON 行，
                  供主进程转发到 UI 实时进度条。

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
from strategy_loader import load_strategy, call_signal, make_ctx, resolve_stops

CST = timezone(timedelta(hours=8))
MIN_MS = 60_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
BAR_MS = MIN_MS  # 1m（内置策略基准周期）
BAR_OPTIONS = ("1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D")


def bar_ms(bar: str) -> int:
    """K 线周期 → 毫秒（结尾单位 m/h/d/w，如 5m/15m/1H/4H/1D）。"""
    s = bar.strip().lower()
    if len(s) < 2:
        raise ValueError(f"无法解析 K 线周期: {bar}")
    try:
        num = int(s[:-1])
    except ValueError as exc:
        raise ValueError(f"无法解析 K 线周期: {bar}") from exc
    unit = s[-1]
    if unit == "m":
        return num * MIN_MS
    if unit == "h":
        return num * HOUR_MS
    if unit == "d":
        return num * DAY_MS
    if unit == "w":
        return num * 7 * DAY_MS
    raise ValueError(f"无法解析 K 线周期: {bar}")


def report_progress(job_id: str, pct: int, stage: str, msg: str = "") -> None:
    """回测进度上报：独立 JSON 行写 stderr（不影响 stdout 最终结果）。"""
    if not job_id:
        return
    sys.stderr.write(json.dumps({"p": pct, "stage": stage, "msg": msg}, ensure_ascii=False) + "\n")
    sys.stderr.flush()

# K 线缓存库：先查库，缺的区间才从 OKX 拉，拉到即入库（下次秒开）
DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "scalper_candles.db"
)


def _db() -> sqlite3.Connection:
    """打开缓存库连接（autocommit + WAL，兼容多个回测 job 并行写缓存）。

    Python sqlite3 默认在事务里「先读后写」会触发锁升级死锁（SQLITE_BUSY 且 busy_timeout
    不生效）；批量回测是多进程并行时一定会遇到。isolation_level=None 让每条语句即时提交，
    写缓存只走下面 _tx() 的 BEGIN IMMEDIATE 短事务 + busy_timeout 等锁，读写互不阻塞。
    """
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
    except sqlite3.Error:
        pass  # 只读/极端环境下 WAL 设置失败不致命
    conn.execute(
        "CREATE TABLE IF NOT EXISTS candles ("
        "inst TEXT NOT NULL, bar TEXT NOT NULL, ts INTEGER NOT NULL,"
        "o REAL, h REAL, l REAL, c REAL, vol REAL,"
        "PRIMARY KEY (inst, bar, ts))"
    )
    return conn


def _tx(conn: sqlite3.Connection, sql: str, data: list[tuple]) -> None:
    """单批写入的短事务：BEGIN IMMEDIATE 先抢写锁（busy_timeout 内等待其他进程），
    整批一次提交后立刻释放，最大限度减少多进程并行时的写锁冲突。"""
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.executemany(sql, data)
        conn.execute("COMMIT")
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise


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


def fetch_okx(inst: str, bar: str, start_ms: int, end_ms: int) -> list[list[float]]:
    """从 OKX 拉 [start_ms, end_ms] 区间的已收盘 K 线，升序返回 [ts,o,h,l,c,vol]。

    注意：history-candles 用 `after` 游标向前翻页（返回该时间戳「之前」更旧的数据），
    与 /market/candles 的 before 语义相反，踩过坑。
    """
    rows: list[list[float]] = []
    after = end_ms
    while True:
        res = _http_get(
            "/api/v5/market/history-candles",
            {"instId": inst, "bar": bar, "limit": "100", "after": str(after)},
        )
        if res.get("code") != "0":
            raise RuntimeError(f"history-candles {inst} {bar}: {res.get('msg')}")
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


def _row_hits(conn, inst: str, bar: str, lo_ms: int, hi_ms: int) -> tuple[int, int, int]:
    """库内 [lo_ms, hi_ms] 范围已存 K 线的 (min ts, max ts, 根数)。"""
    return conn.execute(
        "SELECT COALESCE(MIN(ts),0), COALESCE(MAX(ts),0), COUNT(*) FROM candles "
        "WHERE inst=? AND bar=? AND ts BETWEEN ? AND ?",
        (inst, bar, lo_ms, hi_ms),
    ).fetchone()


def _gaps(conn, inst: str, bar: str, start_ms: int, end_ms: int, bms: int) -> list[tuple[int, int]]:
    """返回需要补拉的缺口区间。

    判定命中：库内覆盖 [start, end]（末端容差 1 根，因最后一根可能刚收盘）
    且无内部空洞（根数接近满配，容差 2 根，防交易所个别缺根导致永远不命中）。
    有洞时回退为整段补拉，保证收敛。
    """
    lo, hi, cnt = _row_hits(conn, inst, bar, start_ms, end_ms)
    if cnt > 0 and lo <= start_ms and hi >= end_ms - bms:
        expected = (hi - lo) // bms + 1
        if expected - cnt <= 2:
            return []
    if cnt == 0:
        return [(start_ms, end_ms)]
    expected = (hi - lo) // bms + 1
    if expected - cnt > 2:
        return [(start_ms, end_ms)]  # 中间有洞 → 整段重补
    segs: list[tuple[int, int]] = []
    if lo > start_ms:
        segs.append((start_ms, min(lo - bms, end_ms)))
    if hi < end_ms - bms:
        segs.append((max(hi + bms, start_ms), end_ms))
    return [g for g in segs if g[1] >= g[0]]


def _write_1m(conn, inst: str, gs: int, ge: int) -> int:
    """补拉一段 1m 缺口并入库，返回入库根数。"""
    rows = fetch_okx(inst, "1m", gs, ge)
    if not rows:
        return 0
    _tx(
        conn,
        "INSERT OR REPLACE INTO candles VALUES (?,?,?,?,?,?,?,?)",
        [(inst, "1m", r[0], r[1], r[2], r[3], r[4], r[5]) for r in rows],
    )
    return len(rows)


def _agg_bucket(conn, inst: str, bar: str, lo_ms: int, hi_ms: int, bms: int) -> None:
    """把库内 1m 数据按 K 线周期本地聚合（o 取首、h/l 取极值、c 取末、vol 求和），
    写入 bar 层缓存。5m/15m/1H 等回测因此只拉一次 1m，所有周期共享同一份底层数据。"""
    rows = conn.execute(
        "SELECT ts,o,h,l,c,vol FROM candles WHERE inst=? AND bar='1m' "
        "AND ts BETWEEN ? AND ? ORDER BY ts",
        (inst, lo_ms, hi_ms),
    ).fetchall()
    if not rows:
        return
    cur_ts = None
    cur: list = []
    out: list[tuple] = []
    for r in rows:
        ts, o, h, l, c, v = r
        b = ts // bms * bms
        if b != cur_ts:
            if cur_ts is not None:
                out.append(tuple(cur))
            cur = [inst, bar, b, o, h, l, c, v]
            cur_ts = b
        else:
            cur[4] = max(cur[4], h)
            cur[5] = min(cur[5], l)
            cur[6] = c
            cur[7] += v
    if cur_ts is not None:
        out.append(tuple(cur))
    if out:
        _tx(conn, "INSERT OR REPLACE INTO candles VALUES (?,?,?,?,?,?,?,?)", out)


def fetch_history(inst: str, bar: str, start_ms: int, end_ms: int) -> tuple[list[list[float]], dict]:
    """带 SQLite 缓存的取数：先查库，缺口区间才拉，拉到即入库。

    1m 是唯一会请求 OKX 的周期；其余周期先确保底层 1m 完整，再本地聚合成目标周期。
    因此同一区间无论回测多少次、多少周期、多少策略都只拉一次 1m。
    返回 ([ts,o,h,l,c,vol] 升序, 缓存信息 {fromDb, fetched})。
    """
    bms = bar_ms(bar)
    conn = _db()
    try:
        fetched = 0
        # 缺口按 3 轮收敛（极端情况下某段拉不到会返回，由上层根数不足检查兜底报错）
        for _ in range(3):
            gaps = _gaps(conn, inst, bar, start_ms, end_ms, bms)
            if not gaps:
                break
            for gs, ge in gaps:
                if bar == "1m":
                    fetched += _write_1m(conn, inst, gs, ge)
                else:
                    agg_lo = gs // bms * bms  # 缺口对齐到目标周期桶边界
                    for s1, e1 in _gaps(conn, inst, "1m", agg_lo, ge, MIN_MS):
                        fetched += _write_1m(conn, inst, s1, e1)
                    _agg_bucket(conn, inst, bar, agg_lo, ge, bms)
        out = conn.execute(
            "SELECT ts, o, h, l, c, vol FROM candles "
            "WHERE inst=? AND bar=? AND ts BETWEEN ? AND ? ORDER BY ts",
            (inst, bar, start_ms, end_ms),
        ).fetchall()
        hits = _row_hits(conn, inst, bar, start_ms, end_ms)
        return [list(r) for r in out], {"fromDb": hits[2], "fetched": fetched}
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


def run(inst, start_ms, end_ms, atr_mult, fee_rate, notional, close_on_reversal,
        strategy_dir=None, job_id="", rr=0.0, slippage_bps=0.0, max_hold=0, bar="1m"):
    """回测主循环。

    strategy_dir 为空 → 内置规则（最近 5 根收盘斜率判向，与 scalper.py 严格一致）；
    strategy_dir 指定 → 逐根调用 strategy.py 的 signal(ctx)，支持 flat / 覆盖 atr_mult / rr。
    bar: K 线周期（1m/5m/15m/1H…），信号逻辑与周期无关，按该周期 K 线回放。
    job_id 非空 → 向 stderr 上报进度 JSON 行。
    rr: >0 强制固定止盈倍率（策略显式返回 rr 时优先；0=自动：内置凯利 / 策略默认）
    slippage_bps: 单边滑点（1 bps=0.01%），开平仓均按不利方向计入成交价
    max_hold: 持仓最长分钟数（跨周期按根折算），0=不限；到点以当前收盘价超时平仓
    """
    bms = bar_ms(bar)
    hold_bars = 0
    if max_hold and max_hold > 0:
        hold_bars = max(1, math.ceil(max_hold / (bms // MIN_MS)))
    report_progress(job_id, 1, "data", f"正在取数：{bar}（1m 为源，SQLite 缓存，只拉一次）…")
    strat_mod = None
    if strategy_dir:
        strat_mod = load_strategy(strategy_dir)  # 失败会抛 RuntimeError，由 main 统一报错

    warmup = 60  # 预热 K 线（ATR 14 + 斜率 5，留足余量）
    candles, cache_info = fetch_history(inst, bar, start_ms - warmup * bms, end_ms)
    if len(candles) < warmup + 5:
        raise RuntimeError(f"{bar} 已收盘 K 线不足（仅 {len(candles)} 根）")

    ts = [c[0] for c in candles]
    o = [c[1] for c in candles]
    h = [c[2] for c in candles]
    l = [c[3] for c in candles]
    c = [c[4] for c in candles]
    vols = [candles[k][5] for k in range(len(candles))]

    fee_amt = notional * fee_rate * 2  # 双边手续费（固定名义金额）
    fee_pct = fee_rate * 2 * 100
    slip = slippage_bps / 10000.0  # 单边滑点比例：开、平仓均按不利方向计入成交价
    force_rr = rr if rr and rr > 0 else None  # 固定止盈倍率（0=自动凯利 / 策略默认）

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
        # 平仓同样按不利方向吃滑点：多单卖出成交价更低、空单买回成交价更高
        fill = exit_px * (1 - slip) if side == "long" else exit_px * (1 + slip)
        raw_pct = (fill / entry - 1) * (1 if side == "long" else -1) * 100
        net_pct = raw_pct - fee_pct
        raw_usdt = notional * raw_pct / 100
        net_usdt = raw_usdt - fee_amt
        trades.append({
            "n": len(trades) + 1,
            "side": side,
            "entryTs": fmt_ts(pos["open_ts"]),
            "exitTs": fmt_ts(ts[exit_i]),
            "entry": round(entry, 2),
            "exit": round(fill, 2),
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

    loop_start = warmup
    loop_total = max(1, len(candles) - 1 - warmup)
    report_progress(job_id, 5, "backtest", "开始逐根回放…")

    i = loop_start
    while i < len(candles) - 1:
        # 用根 i 的 TR 更新 Wilder ATR（得到截至根 i 的 ATR）
        tr = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        atr_val = (atr_val * 13 + tr) / 14

        # 当前内置方向（默认规则 / 兜底 strength）；自定义策略时 direction 由 signal 决定
        direction, strength = detect_trend(c[i - 4:i + 1])
        if strat_mod is not None:
            sig = call_signal(strat_mod, make_ctx(ts, c, h, l, vols, i + 1, atr_val))
            direction = sig["direction"] if sig["direction"] != "flat" else None
        strat_reason = ""
        if strat_mod is not None:
            strat_reason = sig["reason"]

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
            # 反转平仓：自定义策略 flat=观望不平；内置规则只要反向就平
            if exit_px is None and close_on_reversal and direction is not None and direction != pos["side"]:
                exit_px, reason = c[i], "趋势反转"
            if exit_px is None and hold_bars and (i - pos["open_i"]) >= hold_bars:
                exit_px, reason = c[i], "持仓超时"
            if exit_px is not None:
                close_trade(exit_px, i, reason)
                i += 1
                continue
        else:
            # 空仓：信号入场（下一根开盘价，避免未来函数）
            if atr_val > 0 and direction is not None:
                if strat_mod is not None:
                    use_atr_mult_i = sig["atr_mult"] if sig["atr_mult"] is not None else atr_mult
                    use_rr_i = sig["rr"]
                else:
                    use_atr_mult_i = atr_mult
                    use_rr_i = None
                if use_rr_i is None:
                    if force_rr is not None:
                        use_rr_i = force_rr
                    else:
                        win_rate = 0.60 if strength == "strong" else 0.52
                        use_rr_i = kelly_rr(win_rate)
                fallback_sl_dist = atr_val * use_atr_mult_i
                # 入场开仓按不利方向吃滑点：多单买价更高、空单卖价更低（仍无未来函数）
                raw_entry = o[i + 1]
                entry = raw_entry * (1 + slip) if direction == "long" else raw_entry * (1 - slip)
                # 策略给 sl/tp 点位 → 以信号根收盘 c[i] 为参照换算距离，再按实际入场价重建
                if strat_mod is not None:
                    sl_dist, tp_dist, rr_i, _direct, _note = resolve_stops(
                        direction, c[i], sig, fallback_sl_dist, use_rr_i
                    )
                else:
                    sl_dist, tp_dist, rr_i, _direct, _note = resolve_stops(
                        direction, c[i], None, fallback_sl_dist, use_rr_i
                    )
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
                    "rr": rr_i,
                    "reason": strat_reason,
                }
        i += 1
        if job_id and (i - loop_start) % 150 == 0:
            pct = 5 + round((i - loop_start) / loop_total * 94)
            report_progress(job_id, min(99, pct), "backtest", f"已回放 {i - loop_start} 根，成交 {len(trades)} 笔")

    # 结束仍持仓 → 最后一根收盘价平
    if pos is not None:
        close_trade(c[-1], len(candles) - 1, "回测结束")

    report_progress(job_id, 100, "backtest", f"完成，共 {len(trades)} 笔交易")
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
    ap.add_argument("--rr", type=float, default=0.0, help="固定止盈 RR（0=自动：内置凯利 / 策略显式返回 rr 优先）")
    ap.add_argument("--slippage-bps", type=float, default=0.0, help="单边滑点（bps=1/10000，开平均按不利方向计入成交价）")
    ap.add_argument("--max-hold", type=int, default=0, help="持仓最长分钟数，0=不限（超时以当前收盘价平仓）")
    ap.add_argument("--close-on-reversal", action="store_true", help="趋势反转平仓")
    ap.add_argument("--strategy", default="", help="自定义策略目录 agent/strategies/<id>（空=内置规则）")
    ap.add_argument("--bar", default="1m", choices=list(BAR_OPTIONS), help="K 线周期（默认 1m；其他周期由 1m 本地聚合，不重复拉取行情）")
    ap.add_argument("--job-id", default="", help="回测任务 ID（非空时向 stderr 上报进度 JSON）")
    args = ap.parse_args()

    try:
        start_ms = parse_time(args.start)
        end_ms = parse_time(args.end) if args.end else int(datetime.now(CST).timestamp() * 1000)
        if end_ms <= start_ms:
            raise ValueError("结束时间必须晚于开始时间")
        result = run(
            args.inst, start_ms, end_ms, args.atr_mult, args.fee_rate,
            args.notional, args.close_on_reversal,
            strategy_dir=args.strategy or None,
            job_id=args.job_id,
            rr=args.rr,
            slippage_bps=args.slippage_bps,
            max_hold=args.max_hold,
            bar=args.bar,
        )
        out = {
            "inst": args.inst,
            "bar": args.bar,
            "start": fmt_ts(start_ms),
            "end": fmt_ts(end_ms),
            "cache": result.get("cache", {}),
            "params": {
                "bar": args.bar,
                "atrMult": args.atr_mult,
                "feeRate": args.fee_rate,
                "feePct": round(args.fee_rate * 2 * 100, 3),
                "notional": args.notional,
                "rr": args.rr,
                "slippageBps": args.slippage_bps,
                "maxHold": args.max_hold,
                "closeOnReversal": args.close_on_reversal,
                "strategy": args.strategy or "",
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
