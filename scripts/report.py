#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
report.py — 日报 / 周报统计引擎

从 ledger/trades.csv（逐笔台账）与 logs/rounds.jsonl（权益序列）中做确定性统计，
输出结构化指标 + Markdown 报告骨架。交易 AI 在此基础上补写策略层分析。

用法:
    python scripts/report.py --daily 2026-09-01
    python scripts/report.py --weekly-end 2026-09-06     # 该日所在自然周(周一~周日)
    python scripts/report.py --daily 2026-09-01 --json   # 仅输出指标 JSON
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(ROOT, "ledger", "trades.csv")
ROUNDS = os.path.join(ROOT, "logs", "rounds.jsonl")

CLOSE_ACTIONS = {"平仓", "止损触发", "止盈触发", "时间止损平仓"}


def _f(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def load_trades(start: date, end: date) -> list[dict]:
    if not os.path.exists(LEDGER):
        return []
    out = []
    # utf-8-sig：容忍可能存在的 BOM，否则首列名会带 \ufeff 导致取不到值
    with open(LEDGER, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            ts = (row.get("trade_time_cst") or "").strip()
            if not ts:
                continue
            try:
                d = datetime.strptime(ts[:10], "%Y-%m-%d").date()
            except ValueError:
                continue
            if start <= d <= end:
                out.append(row)
    return out


def load_equity(start: date, end: date) -> list[tuple[str, float]]:
    if not os.path.exists(ROUNDS):
        return []
    out = []
    with open(ROUNDS, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = r.get("time_cst", "")
            try:
                d = datetime.strptime(ts[:10], "%Y-%m-%d").date()
            except ValueError:
                continue
            if start <= d <= end:
                out.append((ts, _f(r.get("equity_usdt"))))
    return out


def max_drawdown(series: list[float]) -> dict:
    if not series:
        return {"mdd_pct": 0.0, "mdd_usdt": 0.0}
    peak = series[0]
    mdd_pct = mdd_abs = 0.0
    for v in series:
        peak = max(peak, v)
        dd_abs = peak - v
        dd_pct = dd_abs / peak * 100 if peak else 0.0
        mdd_abs = max(mdd_abs, dd_abs)
        mdd_pct = max(mdd_pct, dd_pct)
    return {"mdd_pct": round(mdd_pct, 4), "mdd_usdt": round(mdd_abs, 2)}


def compute(start: date, end: date) -> dict:
    trades = load_trades(start, end)
    eq = load_equity(start, end)
    eq_vals = [v for _, v in eq]

    closes = [t for t in trades if (t.get("action") or "").strip() in CLOSE_ACTIONS]
    opens = [t for t in trades if (t.get("action") or "").strip() == "开仓"]

    pnls = [_f(t.get("pnl_usdt")) for t in closes]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    fees = sum(_f(t.get("fee_usdt")) for t in trades)

    avg_win = sum(wins) / len(wins) if wins else 0.0
    avg_loss = abs(sum(losses) / len(losses)) if losses else 0.0

    by_inst: dict[str, dict] = {}
    for t in closes:
        k = t.get("instrument") or "?"
        b = by_inst.setdefault(k, {"pnl": 0.0, "n": 0, "wins": 0})
        b["pnl"] += _f(t.get("pnl_usdt"))
        b["n"] += 1
        if _f(t.get("pnl_usdt")) > 0:
            b["wins"] += 1
    for b in by_inst.values():
        b["pnl"] = round(b["pnl"], 2)
        b["win_rate_pct"] = round(b["wins"] / b["n"] * 100, 2) if b["n"] else 0.0

    by_dir: dict[str, dict] = {}
    for t in closes:
        k = t.get("direction") or "?"
        b = by_dir.setdefault(k, {"pnl": 0.0, "n": 0})
        b["pnl"] += _f(t.get("pnl_usdt"))
        b["n"] += 1
    for b in by_dir.values():
        b["pnl"] = round(b["pnl"], 2)

    equity_start = eq_vals[0] if eq_vals else None
    equity_end = eq_vals[-1] if eq_vals else None

    return {
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "rounds_executed": len(eq),
        "equity_start": equity_start,
        "equity_end": equity_end,
        "equity_chg_usdt": round(equity_end - equity_start, 2) if eq_vals else 0.0,
        "equity_chg_pct": round((equity_end / equity_start - 1) * 100, 4) if eq_vals and equity_start else 0.0,
        "trade_actions_total": len(trades),
        "open_count": len(opens),
        "close_count": len(closes),
        "realized_pnl_usdt": round(sum(pnls), 2),
        "win_count": len(wins),
        "loss_count": len(losses),
        "win_rate_pct": round(len(wins) / len(closes) * 100, 2) if closes else None,
        "avg_win_usdt": round(avg_win, 2),
        "avg_loss_usdt": round(avg_loss, 2),
        "profit_factor": round(sum(wins) / abs(sum(losses)), 3) if losses and sum(losses) else None,
        "payoff_ratio": round(avg_win / avg_loss, 3) if avg_loss else None,
        "max_win_usdt": round(max(pnls), 2) if pnls else 0.0,
        "max_loss_usdt": round(min(pnls), 2) if pnls else 0.0,
        "total_fee_usdt": round(fees, 4),
        "by_instrument": by_inst,
        "by_direction": by_dir,
        **max_drawdown(eq_vals),
    }


def render(m: dict, kind: str) -> str:
    p = m["period"]
    title = f"当日交易总结报告 — {p['start']}" if kind == "daily" else f"周度盈利分析报告 — {p['start']} ~ {p['end']}"
    L = [f"# {title}", "", f"生成时间：{datetime.now(CST).strftime('%Y-%m-%d %H:%M:%S')} CST",
         "数据来源：`ledger/trades.csv` + `logs/rounds.jsonl`（只追加归档，可完整回溯）", "", "## 一、核心指标", "",
         "| 指标 | 数值 |", "|------|------|"]
    rows = [
        ("执行轮次", m["rounds_executed"]),
        ("期初权益 (USDT)", f"{m['equity_start']:,.2f}" if m["equity_start"] else "—"),
        ("期末权益 (USDT)", f"{m['equity_end']:,.2f}" if m["equity_end"] else "—"),
        ("权益变动 (USDT)", f"{m['equity_chg_usdt']:+,.2f}"),
        ("**收益率**", f"**{m['equity_chg_pct']:+.4f}%**"),
        ("已实现盈亏 (USDT)", f"{m['realized_pnl_usdt']:+,.2f}"),
        ("开仓笔数", m["open_count"]),
        ("平仓笔数", m["close_count"]),
        ("盈利 / 亏损笔数", f"{m['win_count']} / {m['loss_count']}"),
        ("**胜率**", f"**{m['win_rate_pct']}%**" if m["win_rate_pct"] is not None else "— (无平仓)"),
        ("平均盈利 / 平均亏损", f"{m['avg_win_usdt']:,.2f} / {m['avg_loss_usdt']:,.2f}"),
        ("盈亏比 (payoff)", m["payoff_ratio"] if m["payoff_ratio"] else "—"),
        ("利润因子 (profit factor)", m["profit_factor"] if m["profit_factor"] else "—"),
        ("最大单笔盈利 / 亏损", f"{m['max_win_usdt']:+,.2f} / {m['max_loss_usdt']:+,.2f}"),
        ("**最大回撤**", f"**{m['mdd_pct']:.4f}%**（{m['mdd_usdt']:,.2f} USDT）"),
        ("手续费总额 (USDT)", f"{m['total_fee_usdt']:,.4f}"),
    ]
    L += [f"| {k} | {v} |" for k, v in rows]

    L += ["", "## 二、品种盈利贡献", ""]
    if m["by_instrument"]:
        L += ["| 标的 | 平仓笔数 | 盈亏 (USDT) | 胜率 |", "|------|----------|-------------|------|"]
        L += [f"| {k} | {v['n']} | {v['pnl']:+,.2f} | {v['win_rate_pct']}% |" for k, v in m["by_instrument"].items()]
    else:
        L.append("_本期无平仓交易。_")

    L += ["", "## 三、方向盈利贡献", ""]
    if m["by_direction"]:
        L += ["| 方向 | 平仓笔数 | 盈亏 (USDT) |", "|------|----------|-------------|"]
        L += [f"| {k} | {v['n']} | {v['pnl']:+,.2f} |" for k, v in m["by_direction"].items()]
    else:
        L.append("_本期无平仓交易。_")

    L += ["", "## 四、策略效果总结", "", "<!-- AI_ANALYSIS_START -->",
          "_（由交易 AI 补写：持仓回顾、决策质量复盘、纪律执行情况、下期调整方向）_",
          "<!-- AI_ANALYSIS_END -->", "",
          "---", "", "_本报告基于只追加的归档数据自动生成，指标可复算、可审计。_", ""]
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--daily", help="YYYY-MM-DD")
    g.add_argument("--weekly-end", dest="weekly_end", help="该日期所在自然周(周一~周日)")
    ap.add_argument("--json", action="store_true", help="仅输出指标 JSON，不写报告文件")
    args = ap.parse_args()

    if args.daily:
        d = datetime.strptime(args.daily, "%Y-%m-%d").date()
        start = end = d
        kind, sub = "daily", "daily"
        name = d.isoformat()
    else:
        d = datetime.strptime(args.weekly_end, "%Y-%m-%d").date()
        start = d - timedelta(days=d.weekday())
        end = start + timedelta(days=6)
        kind, sub = "weekly", "weekly"
        iso = start.isocalendar()
        name = f"{iso[0]}-W{iso[1]:02d}"

    m = compute(start, end)
    if args.json:
        print(json.dumps(m, ensure_ascii=False, indent=2))
        return 0

    out_dir = os.path.join(ROOT, "reports", sub)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{name}.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(render(m, kind))
    print(json.dumps({"ok": True, "report": path, "metrics": m}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
