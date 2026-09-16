#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
month_risk.py — 月度风险口径的唯一来源（月度基准 / 峰值 / 回撤 / L1-6 熔断判据）

为什么单独成模块
----------------
「月度回撤」这个数字此前在**三处各算一遍**：
  - scripts/mail_report.py  → 选风险档位（§5.3）
  - scripts/dashboard.py §1b → 看板上的「月度目标进度」
  - src/main.ts 执行前第 ④ 步 → 章程 L1-6 熔断

前两处公式相同但各写一份；第三处读 `state/runtime.json` 的 `month_dd_pct`，
而**全仓没有任何脚本写过这个字段**（唯一的 runtime.json 写入者 archive_round.py
只写 day_sl_count / day_pnl_pct / circuit_breaker / round_count）——
于是 `src/main.ts` 里的 `j.month_dd_pct ?? 0` 恒为 0，`0 <= -12` 永假，
章程 L1-6「月度回撤 ≥ 12% 强制停止开新仓」自建立起**从未触发过**。

现在：
  - 本模块算（唯一实现）；
  - `archive_round.py` 每轮把结果写进 `state/runtime.json`；
  - 主 Agent 路径与超短线路径都从那里读，并过 `guard.ts` 的同一道闸门。

口径
----
`month_start_equity` 跨月重置为当月首次见到的权益，`month_peak_equity` 只增不减。
**真实回撤 = (当前权益 − 月度峰值) / 月度峰值**（不是月末对月初）。负数=回撤。
**L1-6 的判据是回撤本身**，与「本月是否盈利」无关。
"""

import calendar
import json
import os
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CST = timezone(timedelta(hours=8))

MONTH_STATE = os.path.join(ROOT, "state", "month_state.json")

# 月度目标收益率（%），章程 §0.1 进阶目标
MONTHLY_TARGET_PCT = 10.0

# 章程 §1 L1-6：月度回撤 ≥ 12% → 强制停止开新仓（不可裁量）
L1_MONTH_DD_PCT = -12.0


def _now(now=None):
    """当前时间（CST）。传入 now 时直接返回，便于测试注入。"""
    return now or datetime.now(CST)


def days_in_month(y, m):
    return calendar.monthrange(y, m)[1]


def _load_state():
    if not os.path.exists(MONTH_STATE):
        return {}
    try:
        with open(MONTH_STATE, encoding="utf-8") as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except Exception:  # noqa: BLE001 —— 状态文件坏了就当作首次初始化，不阻断整轮
        return {}


def ensure_month_state(equity, now=None):
    """维护月度基准：跨月自动重置；同月持续跟踪权益峰值（用于真实回撤计算）。"""
    now = _now(now)
    ym = now.strftime("%Y-%m")
    st = _load_state()
    if st.get("month") != ym:
        st = {
            "month": ym,
            "month_start_equity": equity,
            "month_peak_equity": equity,
            "month_start_cst": now.strftime("%Y-%m-%d %H:%M:%S"),
            "reset_note": "跨月自动重置（或首次初始化）",
        }
    else:
        # 峰值只增不减；真实回撤 = (当前权益 - 峰值) / 峰值
        if equity > float(st.get("month_peak_equity") or 0):
            st["month_peak_equity"] = equity
    st["last_update_cst"] = now.strftime("%Y-%m-%d %H:%M:%S")
    os.makedirs(os.path.dirname(MONTH_STATE), exist_ok=True)
    # 注意：json.dump 的 fp 必须传位置参数，不能写成 fp=f（会 TypeError）
    with open(MONTH_STATE, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
    return st


def month_metrics(equity, now=None, state=None):
    """当月风险指标（唯一口径）。

    返回 dict：
      month / month_start_equity / month_peak_equity
      month_pnl_pct   当月收益率（%，相对月初权益）
      month_dd_pct    **真实回撤**（%，相对当月峰值；负数=回撤）
      time_progress / day / days_in_month / achieved_pct_of_target / monthly_target_pct

    `state` 可传入已经 `ensure_month_state()` 过的状态，避免同一轮重复读文件。
    """
    now = _now(now)
    st = state if state is not None else ensure_month_state(equity, now)
    equity = float(equity or 0)

    m0 = float(st.get("month_start_equity") or equity)
    peak = max(float(st.get("month_peak_equity") or m0), m0, equity)

    month_pnl_pct = ((equity - m0) / m0 * 100) if m0 else 0.0
    month_dd_pct = ((equity - peak) / peak * 100) if peak else 0.0

    dim = days_in_month(now.year, now.month)
    time_progress = now.day / dim if dim else 0.0

    return {
        "month": now.strftime("%Y-%m"),
        "month_start_equity": m0,
        "month_peak_equity": peak,
        "month_pnl_pct": month_pnl_pct,
        "month_dd_pct": month_dd_pct,
        "day": now.day,
        "days_in_month": dim,
        "time_progress": time_progress,
        "achieved_pct_of_target": (month_pnl_pct / MONTHLY_TARGET_PCT * 100) if MONTHLY_TARGET_PCT else 0.0,
        "monthly_target_pct": MONTHLY_TARGET_PCT,
    }


def month_dd_circuit_tripped(month_dd_pct):
    """章程 L1-6：月度回撤 >= 12% → 熔断（强制停止开新仓）。

    判据与 `src/guard.ts` 的 `MAX_MONTH_DD_PCT` 是同一个数：
    两边都只是引用章程 §1 L1-6，测试会把它们钉回章程原文。
    """
    try:
        return float(month_dd_pct) <= L1_MONTH_DD_PCT
    except (TypeError, ValueError):
        # 没有数据不等于「没有回撤」。熔断判据在拿不到数时只能放行（由 TS 侧点名告警），
        # 这里如实返回 False，不替调用方猜。
        return False


if __name__ == "__main__":  # 手动排查用：打印当月指标
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--equity", type=float, required=True, help="当前账户权益（USDT）")
    a = ap.parse_args()
    m = month_metrics(a.equity)
    m["l1_6_tripped"] = month_dd_circuit_tripped(m["month_dd_pct"])
    print(json.dumps(m, ensure_ascii=False, indent=2))
