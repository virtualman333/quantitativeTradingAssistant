#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
archive_round.py — 交易轮次归档器（唯一写入口）

保证每轮日志格式一致、台账严格只追加、运行态正确演进。
所有写操作均为 append（除 state/runtime.json 为覆盖），历史行永不改写。

用法:
    python scripts/archive_round.py --in round.json
    cat round.json | python scripts/archive_round.py

入参 JSON 结构见 README 或 AGENT_TRADING_RULES.md §8。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LEDGER = os.path.join(ROOT, "ledger", "trades.csv")
ROUNDS_JSONL = os.path.join(ROOT, "logs", "rounds.jsonl")
RUNTIME = os.path.join(ROOT, "state", "runtime.json")

LEDGER_FIELDS = [
    "trade_time_cst", "round_id", "env", "instrument", "direction", "action",
    "size_contracts", "size_base", "avg_price", "leverage", "notional_usdt",
    "tp_price", "sl_price", "pnl_usdt", "fee_usdt", "risk_budget_usdt",
    "order_id", "algo_id", "decision_summary",
]


def _fmt(v, dash="—"):
    if v is None or v == "":
        return dash
    if isinstance(v, float):
        return f"{v:,.2f}" if abs(v) >= 1 else f"{v:.4f}"
    return str(v)


def render_md(r: dict) -> str:
    """渲染用户指定格式的人读日志块。"""
    L = []
    L.append(f"## 【定时任务执行日志】{r['round_id']}")
    L.append("")
    L.append(f"时间：{r['time_cst']}（轮次间隔：{r.get('interval', '1 小时')}）")
    L.append("")
    L.append(
        f"**1. 账户状态**：总权益 {_fmt(r['equity_usdt'])} USDT ｜ "
        f"可用保证金 {_fmt(r['available_usdt'])} USDT"
        f"{'　｜　环境：' + r.get('env', 'demo') if r.get('env') else ''}"
    )
    L.append("")
    L.append("**2. 持仓明细**：")
    pos_map = {p["instrument"]: p for p in r.get("positions", [])}
    for inst, label in (("BTC-USDT-SWAP", "BTC/USDT"), ("ETH-USDT-SWAP", "ETH/USDT")):
        p = pos_map.get(inst)
        if not p:
            L.append(f"- {label}：**无持仓**")
        else:
            L.append(
                f"- {label}：**{p['side']}** 数量 {_fmt(p.get('size_contracts'))} 张"
                f"（{_fmt(p.get('size_base'))} {label.split('/')[0]}）"
                f" ｜ 开仓价 {_fmt(p.get('entry'))} ｜ 现价 {_fmt(p.get('mark'))}"
                f" ｜ 杠杆 {_fmt(p.get('leverage'))}x ｜ 止盈 {_fmt(p.get('tp'))}"
                f" ｜ 止损 {_fmt(p.get('sl'))} ｜ 浮盈 {_fmt(p.get('upl'))} USDT"
            )
    if r.get("live_watch"):
        L.append("")
        L.append("  _实盘只读监控（不干预）_：")
        for w in r["live_watch"]:
            L.append(
                f"  - {w['instrument']}（{w.get('inst_type', '')}）{_fmt(w.get('size_base'))} "
                f"@ {_fmt(w.get('entry'))} ｜ 现价 {_fmt(w.get('mark'))} ｜ "
                f"浮盈 {_fmt(w.get('upl'))} USDT ｜ 强平价 {_fmt(w.get('liq_px'))} ｜ "
                f"保证金率 {_fmt(w.get('mgn_ratio'))}"
            )
    L.append("")
    L.append("**3. 本轮操作**：")
    acts = r.get("actions", [])
    if not acts:
        L.append("- 无操作（观望）")
    else:
        for a in acts:
            L.append(f"- {a}")
    L.append("")
    L.append("**4. 决策摘要**：")
    L.append("")
    L.append(r.get("decision", "（缺失）"))
    if r.get("market_summary"):
        L.append("")
        L.append("<details><summary>本轮行情与指标快照</summary>")
        L.append("")
        L.append("```")
        L.append(r["market_summary"].rstrip())
        L.append("```")
        L.append("")
        L.append("</details>")
    L.append("")
    L.append(f"**5. 归档状态**：已永久留存（快照 `{r.get('snapshot_path', 'n/a')}`）")
    L.append("")
    L.append("---")
    L.append("")
    return "\n".join(L)


def append_md(r: dict) -> str:
    dt = datetime.strptime(r["time_cst"], "%Y-%m-%d %H:%M:%S")
    day_dir = os.path.join(ROOT, "logs", dt.strftime("%Y-%m"))
    os.makedirs(day_dir, exist_ok=True)
    path = os.path.join(day_dir, dt.strftime("%Y-%m-%d") + ".md")
    new_file = not os.path.exists(path)
    with open(path, "a", encoding="utf-8") as fh:
        if new_file:
            fh.write(f"# 交易执行日志 — {dt.strftime('%Y-%m-%d')}\n\n")
            fh.write("> 本文件为只追加归档，历史内容不得修改或删除。\n")
            fh.write("> 纪律基准：`AGENT_TRADING_RULES.md`\n\n---\n\n")
        fh.write(render_md(r))
    return path


def append_jsonl(r: dict) -> str:
    os.makedirs(os.path.dirname(ROUNDS_JSONL), exist_ok=True)
    with open(ROUNDS_JSONL, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    return ROUNDS_JSONL


def append_trades(r: dict) -> int:
    trades = r.get("trades") or []
    if not trades:
        return 0
    exists = os.path.exists(LEDGER)
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    with open(LEDGER, "a", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=LEDGER_FIELDS, extrasaction="ignore")
        if not exists:
            w.writeheader()
        for t in trades:
            t.setdefault("round_id", r["round_id"])
            t.setdefault("env", r.get("env", "demo"))
            t.setdefault("trade_time_cst", r["time_cst"])
            w.writerow(t)
    return len(trades)


def update_runtime(r: dict) -> dict:
    st = {}
    if os.path.exists(RUNTIME):
        try:
            with open(RUNTIME, encoding="utf-8") as fh:
                st = json.load(fh)
        except Exception:  # noqa: BLE001
            st = {}
    today = r["time_cst"][:10]
    if st.get("current_day") != today:
        st["current_day"] = today
        st["day_sl_count"] = 0
        st["day_start_equity"] = r["equity_usdt"]
        st["day_trade_count"] = 0
    st["round_count"] = st.get("round_count", 0) + 1
    st["last_round_id"] = r["round_id"]
    st["last_run_cst"] = r["time_cst"]
    st["equity_usdt"] = r["equity_usdt"]
    st.setdefault("inception_equity", r["equity_usdt"])
    st.setdefault("inception_date", today)
    st["day_sl_count"] = st.get("day_sl_count", 0) + int(r.get("sl_triggered", 0))
    st["day_trade_count"] = st.get("day_trade_count", 0) + len(r.get("trades") or [])
    dse = st.get("day_start_equity") or r["equity_usdt"]
    st["day_pnl_usdt"] = round(r["equity_usdt"] - dse, 4)
    st["day_pnl_pct"] = round((r["equity_usdt"] / dse - 1) * 100, 4) if dse else 0.0
    st["circuit_breaker"] = bool(st["day_sl_count"] >= 2 or st["day_pnl_pct"] <= -3.0)
    st["open_positions"] = len(r.get("positions") or [])
    os.makedirs(os.path.dirname(RUNTIME), exist_ok=True)
    with open(RUNTIME, "w", encoding="utf-8") as fh:
        json.dump(st, fh, ensure_ascii=False, indent=2)
    return st


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", help="轮次 JSON 文件；缺省读 stdin")
    args = ap.parse_args()

    raw = open(args.infile, encoding="utf-8").read() if args.infile else sys.stdin.read()
    r = json.loads(raw)

    # 长文本可放独立文件，避免 JSON 转义出错；路径相对项目根目录
    for key, fkey in (("decision", "decision_file"), ("market_summary", "market_summary_file")):
        fp = r.pop(fkey, None)
        if fp:
            full = fp if os.path.isabs(fp) else os.path.join(ROOT, fp)
            with open(full, encoding="utf-8") as fh:
                r[key] = fh.read()

    for k in ("round_id", "time_cst", "equity_usdt", "available_usdt"):
        if k not in r:
            print(f"ERROR: 缺少必填字段 {k}", file=sys.stderr)
            return 2

    md = append_md(r)
    jl = append_jsonl(r)
    n = append_trades(r)
    st = update_runtime(r)

    print(json.dumps({
        "ok": True,
        "md_log": md,
        "jsonl": jl,
        "trades_appended": n,
        "runtime": st,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
