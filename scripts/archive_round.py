#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
archive_round.py — 交易轮次归档器（唯一写入口）

保证每轮日志格式一致、台账严格只追加、运行态正确演进。
所有写操作均为 append（除 state/runtime.json 为覆盖），历史行永不改写。

`state/runtime.json` 的读写有两条硬要求（与 `state/month_state.json` 同一套，两者都是
安全判据的载体，不是缓存）：

- **写**走 `jsonstore.atomic_write_json()` —— 半截文件会让 `loadRunState()` 退回「字段未知」，
  而更早的版本会让本文件把「读不出来」当成「首次运行」。
- **读**走 `jsonstore.read_json_state()` —— 「文件不存在」（首次运行，正常）与
  「文件存在但读不出来」（**数据丢了**）必须分开。后者要留档坏文件（`.corrupt-<时间戳>`）、
  在状态里留下 `day_counters_compromised` 标记，并让 `circuit_breaker` 写 `null`（未知）
  而不是 `false`（未熔断）—— 否则看板与邮件会一起告诉用户「今日未熔断」。

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

import month_risk
import jsonstore

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

# ── 运行态被写坏时的标记键 ────────────────────────────────────────────────
# `state/runtime.json` 一坏，本日累计计数（止损次数 / 当日盈亏 / 成交笔数）就没了来源。
# 这几个键记下「哪一天的本日计数已经不可信」：重置出来的 0 不是「今天没止损过」，
# 只是「数字丢了」。跨日自动清除（新的一天本来就要清零，昨天那场损坏不再影响本日）。
COMPROMISED_KEY = "day_counters_compromised"
COMPROMISED_KEYS = (
    COMPROMISED_KEY,
    "day_counters_compromised_at",
    "day_counters_compromised_error",
)


class RuntimeStateCorrupt(RuntimeError):
    """`state/runtime.json` 读不出来，**且坏文件也挪不动**。

    只在保不住证据时抛：这时宁可不写新状态（下一轮读还会发现它坏了、还会再试一次留档），
    也不能覆盖掉唯一的排查线索再假装什么都没发生。
    """


def _stamp(r: dict) -> str:
    """留档时间戳。优先用本轮归档时间（与留档里其它时间是同一个时钟），解析不了就退回当前时刻。"""
    try:
        return datetime.strptime(r["time_cst"], "%Y-%m-%d %H:%M:%S").strftime("%Y%m%d-%H%M%S")
    except (KeyError, ValueError, TypeError):
        return datetime.now(CST).strftime("%Y%m%d-%H%M%S")


def _load_runtime(r: dict):
    """读运行态，返回 `(state, corrupt)`。

    - `({}  , None)`      —— 文件还不存在：**首次运行**，正常，可以初始化
    - `({}  , {...})`     —— 存在但读不出来 / 顶层不是对象：**数据丢了**。坏文件已原样留档。

    为什么要分成两件事：`runtime.json` 不是缓存，它是「本日熔断 / 成交笔数 / 轮次号」的载体。
    此前这里是 `except Exception: st = {}`，于是「文件坏了」与「新机器首次运行」在代码里
    长得一模一样 —— 而接下来的逻辑是「新的一天/首次 → 计数清零 + 基准取当前权益」，
    再原子写回去。一次损坏的净效果是：**当日止损计数归零 → `circuit_breaker` 变成 False →
    看板与邮件都会明确告诉用户「今日未熔断」**（实际可能已经熔断两次），
    而那份坏文件作为唯一线索，被紧接着的原子写**覆盖销毁**。
    与 `month_risk` 挡的是同一件事（L1-6 的分母被静默清零），只是这边连证据都不留。
    """
    st, err = jsonstore.read_json_state(RUNTIME)
    if err is None:
        return (st or {}), None
    try:
        dest = jsonstore.quarantine_broken(RUNTIME, _stamp(r))
    except OSError as e:
        raise RuntimeStateCorrupt("%s（且坏文件也挪不动，本轮未改动运行态：%s）" % (err, e))
    return {}, {"error": err, "archive": os.path.basename(dest)}



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
    # ★ 「文件不存在」与「文件读不出来」是两件事（见 `_load_runtime`）。
    st, corrupt = _load_runtime(r)
    today = r["time_cst"][:10]
    if st.get("current_day") != today:
        st["current_day"] = today
        st["day_sl_count"] = 0
        st["day_start_equity"] = r["equity_usdt"]
        st["day_trade_count"] = 0
        # 跨日：昨天的本日计数本来就要清零，昨天那场损坏不再影响本日的可信度。
        for k in COMPROMISED_KEYS:
            st.pop(k, None)
    if corrupt:
        # 坏文件 → 既不知道它属于哪一天，也不知道当天的计数累计到几。重置出来的 0
        # 不是「今天没止损过」，只是「数字丢了」：写进状态让界面显示「—」、
        # 让看板与邮件点名，而不是照旧沉默地报一句「未熔断」。
        # 注意顺序：必须在跨日清零**之后**写，否则同一天里标记会被下一步的清零擦掉。
        st[COMPROMISED_KEY] = True
        st["day_counters_compromised_at"] = r["time_cst"]
        st["day_counters_compromised_error"] = corrupt["error"]
        # 坏文件留档了 —— 把「这里出过事」留在状态里（与 month_state 同一约定：
        # 免得下次有人看到一份干净的 runtime.json 以为从没出过事）。
        st["recovered_from"] = corrupt["archive"]
        st["recovered_error"] = corrupt["error"]
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
    if st.get(COMPROMISED_KEY):
        # 「不知道熔没熔断」与「没熔断」是两件事。写 None（JSON null）而不是 False ——
        # 消费方把 falsy 值读成「一切正常」正是本仓 `month_dd_pct ?? 0` 那个坑，
        # 而这里的后果是看板与邮件齐声说「今日未熔断」，实际已经熔断过两次。
        st["circuit_breaker"] = None
    else:
        st["circuit_breaker"] = bool(st["day_sl_count"] >= 2 or st["day_pnl_pct"] <= -3.0)
    st["open_positions"] = len(r.get("positions") or [])
    # ── 月度回撤：章程 L1-6「月度回撤 ≥12% → 强制停止开新仓」的判据 ──────────
    # 这个字段 src/main.ts 一直在读（`j.month_dd_pct ?? 0`），但**从来没有任何脚本写过**，
    # 于是那条 L1 熔断恒不触发。口径归 month_risk.py，本文件只负责落盘。
    # 顺带把阈值也落盘：总览页要显示「回撤 -3.5% / 熔断线 -12%」，但界面**不许**
    # 自己抄一份章程常量（本仓「同一事实两处写法必然漂移」已连续多轮命中）。
    # 两个数都取自 month_risk.py，与 l1_6_tripped 的判据同源。
    # ★ `update_month_state()` 是全仓**唯一**会改动月度基准/峰值的调用点（本脚本每轮拿的是
    #   真账户权益）。看板与邮件走 `month_metrics()` 的只读口径 —— 否则一份手填的账户快照
    #   就能把 `month_peak_equity` 永久抬高，让真实权益一直显示成深度回撤、误触发 L1-6。
    try:
        mst = month_risk.update_month_state(r["equity_usdt"])
        mm = month_risk.month_metrics(r["equity_usdt"], state=mst)
        st["month_dd_pct"] = round(float(mm["month_dd_pct"]), 4)
        st["month_pnl_pct"] = round(float(mm["month_pnl_pct"]), 4)
        st["month_start_equity"] = round(float(mm["month_start_equity"]), 4)
        st["month_peak_equity"] = round(float(mm["month_peak_equity"]), 4)
        st["month_dd_cap_pct"] = round(float(month_risk.L1_MONTH_DD_PCT), 4)
        st["monthly_target_pct"] = round(float(mm["monthly_target_pct"]), 4)
        st["l1_6_tripped"] = month_risk.month_dd_circuit_tripped(mm["month_dd_pct"])
        # 算成功就把上一轮的错误擦掉 —— 否则一次失败会永久留在文件里，
        # 界面会一直显示「数据缺失」，而实际上数据早就恢复了（stale key 陷阱）。
        st.pop("month_dd_error", None)
    except Exception as e:  # noqa: BLE001 —— 月度状态算不出来不该让整轮归档失败
        # 失败时**要把上一轮的月度数值一并清掉**：st 是「读旧文件 + 覆盖字段」，
        # 不清就是把上一轮的回撤当成这一轮的呈现。陈旧的回撤比没有回撤更危险 ——
        # 从高点摔下来那一轮若恰好算不出数，界面会拿旧的小回撤告诉用户「还安全」，
        # 而这条 L1 恰恰是「没有下一笔了」级别的闸门。
        # 清成缺失后，guard.ts 走的是它自己声明的那条路径：放行 + 点名告警
        # （「不知道回撤多少」≠「没有回撤」）。
        for k in (
            "month_dd_pct",
            "month_pnl_pct",
            "month_start_equity",
            "month_peak_equity",
            "month_dd_cap_pct",
            "monthly_target_pct",
            "l1_6_tripped",
        ):
            st.pop(k, None)
        st["month_dd_error"] = f"{type(e).__name__}: {e}"
    # ★ 原子写（jsonstore）：runtime.json 是「熔断 / 月度回撤」两条 L1 的读数，
    #   半截文件会让 loadRunState() 退回「全部字段未知」——`?? 0` 那条教训说明
    #   「读不到」必须始终保持可分辨，不能让一次崩溃把它变成「看起来正常」。
    jsonstore.atomic_write_json(RUNTIME, st)
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
