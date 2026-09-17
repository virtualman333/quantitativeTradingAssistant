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

为什么读写必须分开
------------------
`state/month_state.json` 不是一份普通缓存，它是 **L1-6 的分母**：
`month_peak_equity` 每次被抬高都会让「真实回撤」变大，而 `month_peak_equity` 只增不减
（除了跨月重置），所以一次错误的写入是**不可逆**的 —— 轻则整月档位被压到 DEFEND，
重则 `guard.ts` 误判熔断、**停止一切开新仓**。

而原来的 `ensure_month_state()` 是个「名字看不出会写盘」的写入口，被三条路径调用，
其中两条是**纯展示**路径：
  - `scripts/dashboard.py` —— 账户权益来自 AI 手填的 `--account` 快照 JSON（可能过期）；
  - `scripts/mail_report.py` —— 报表，而且调用时**没传 now**，与下一行的
    `month_metrics(..., now=now)` 可能落在不同月份。

后果有两条，都不报错：
  ① 跨月首日先打开一次看板，整月的 `month_start_equity` 就被**冻结成那份快照里的数字**；
  ② 快照权益若高于当月峰值，`month_peak_equity` 被**永久抬高** →
     此后真实权益看起来一直是深度回撤 → **误触发 L1-6**。

所以现在：
  - `update_month_state()` = **唯一写入口**，只允许交易主循环（`archive_round.py`）调用；
  - `read_month_state()` = 只读视图，跨月时**虚拟重置**（不落盘）；
  - `month_metrics()` = **纯计算**，`state` 缺省时走只读视图，**绝不写盘**。

为什么坏文件不能当成「首次初始化」
----------------------------------
上面两条挡的是「不该写的人写」。还有第三条路能让分母消失，而且**根本不用写**：

`_load_state()` 此前是 `except Exception: return {}` —— 文件读不出来就当首次初始化。
于是只要 `state/month_state.json` 变成半截（进程在 `json.dump` 中途被杀 / 断电 / 磁盘满），
下一次 `update_month_state()` 就会把 `month_peak_equity` **重新初始化成当前权益**：
真实回撤立刻归零，L1-6 熔断在当月剩余时间里再也触发不了，而且**不留任何痕迹** ——
用户看到的是一份干净的 `month_state.json` 和一条「回撤 0.00%，正常」。

所以现在「文件不存在」与「文件读不出来」是**两件事**：

  - 不存在   → 首次运行，正常，照旧 `_reset_state()`；
  - 读不出来 → **数据丢了**：坏文件原样留档（`.corrupt-<时间戳>`，不删不改，那是排查线索），
               新状态照写（否则每轮都算不出回撤），但**本轮抛 `MonthStateCorrupt`** ——
               让 `archive_round.py` 把 `month_dd_error` 落盘、让 `guard.ts` 走它自己那条
               「回撤未知 + 点名告警」的路。重置后的那个 0% 不是「这个月没有回撤」，
               只是「峰值丢了」，不能拿它当结论。

展示路径仍然不抛异常（看板/邮件不该因为一个坏文件整页报错），但返回值里带
`state_corrupt`，界面据此把回撤显示成「—」而不是 `0.00%` ——
「0% 回撤」是最危险的一种谎，它长得和「一切正常」一模一样。
"""

import calendar
import json
import os
from datetime import datetime, timezone, timedelta

import jsonstore

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CST = timezone(timedelta(hours=8))

MONTH_STATE = os.path.join(ROOT, "state", "month_state.json")


class MonthStateCorrupt(RuntimeError):
    """`state/month_state.json` 存在但读不出来（= 数据丢了，不是首次运行）。

    专门给一个异常类型，是因为这条路此前被 `except: 当作首次初始化` 吞掉：
    月度峰值被静默清零 → 真实回撤恒为 0 → L1-6 熔断当月起再也触发不了，且不留痕迹。
    """

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
    """返回 `(state, error)` —— 「没有文件」与「文件坏了」是两件事。

    - `({}  , None)`   —— 文件还不存在：首次运行，可以初始化
    - `(None, "原因")` —— 文件存在但读不出来 / 结构不对：**数据丢了**，调用方必须显式处理
    """
    data, err = jsonstore.read_json_state(MONTH_STATE)
    if err:
        return None, err
    if data is None:
        return {}, None
    missing = [k for k in ("month", "month_peak_equity") if k not in data]
    if missing:
        # 能被 json 解析、但结构不是本模块写出来的形状（被别的程序覆写、被编辑坏）
        return None, "缺少必要字段：%s" % "、".join(missing)
    return data, None


def _quarantine_broken_state(now):
    """把读不出来的状态文件**原样留档**到 `.corrupt-<时间戳>`，返回目标路径。

    留档规则（含「同一秒内不覆盖前一份证据」）在 `jsonstore.quarantine_broken()` ——
    本模块与 `archive_round.py` 的 `runtime.json` 是同一条要求，各写一份必然漂移。
    """
    return jsonstore.quarantine_broken(MONTH_STATE, now.strftime("%Y%m%d-%H%M%S"))


def _reset_state(equity, now, note):
    """当月状态的初始形态（跨月重置 / 首次初始化 / 只读虚拟重置共用一份）。"""
    return {
        "month": now.strftime("%Y-%m"),
        "month_start_equity": equity,
        "month_peak_equity": equity,
        "month_start_cst": now.strftime("%Y-%m-%d %H:%M:%S"),
        "reset_note": note,
    }


def read_month_state(equity, now=None):
    """**只读**视图：返回「按这份权益与这个时刻应当使用的月度状态」，绝不落盘。

    跨月时不返回上一月的状态，而是给出一个虚拟重置的当月状态 —— 否则月初打开看板
    会拿上个月的基准去算这个月的收益率。虚拟重置只活在返回值里，写盘是
    `update_month_state()` 的事（它拿的才是当轮真实权益）。
    """
    now = _now(now)
    st, err = _load_state()
    if err:
        # 只读视图不抛异常（看板 / 邮件不该因为一个坏文件整页报错），但**绝不假装没事**：
        # 返回值带 `state_corrupt`，展示层据此把回撤显示成「—」而不是 0.00%。
        out = _reset_state(float(equity or 0), now, "只读视图：月度状态文件损坏，基准不可信（未落盘）")
        out["state_corrupt"] = True
        out["corrupt_error"] = err
        return out
    if st.get("month") != now.strftime("%Y-%m"):
        return _reset_state(float(equity or 0), now, "只读视图：跨月虚拟重置（未落盘）")
    return st


def update_month_state(equity, now=None):
    """**唯一写入口**：维护月度基准（跨月重置）与权益峰值（只增不减）。

    只有交易主循环（`archive_round.py`，每轮拿的是真账户权益）该调它。
    展示 / 报表路径一律走 `month_metrics()`（纯计算）—— 见模块头部「为什么读写必须分开」。
    """
    now = _now(now)
    ym = now.strftime("%Y-%m")
    equity = float(equity or 0)
    st, err = _load_state()
    if err:
        # 坏文件先留档再初始化 —— 顺序不能反：先写新状态就把唯一的排查线索覆盖掉了。
        try:
            dest = _quarantine_broken_state(now)
        except OSError as e:
            raise MonthStateCorrupt("%s（且坏文件也挪不动，未改动任何状态：%s）" % (err, e))
        st = _reset_state(
            equity, now, "原状态文件损坏，已隔离为 %s 并按本轮权益重新初始化" % os.path.basename(dest)
        )
        # 把「这里出过事」写进状态本身，免得下次有人看到一份干净的 month_state.json 以为从没出过事
        st["recovered_from"] = os.path.basename(dest)
        st["recovered_error"] = err
    elif st.get("month") != ym:
        st = _reset_state(equity, now, "跨月自动重置（或首次初始化）")
    else:
        # 峰值只增不减；真实回撤 = (当前权益 - 峰值) / 峰值
        if equity > float(st.get("month_peak_equity") or 0):
            st["month_peak_equity"] = equity
    st["last_update_cst"] = now.strftime("%Y-%m-%d %H:%M:%S")
    # ★ 原子写：半截文件会被读方当成「首次初始化」，进而把峰值静默清零（详见 jsonstore 模块头）。
    jsonstore.atomic_write_json(MONTH_STATE, st)
    if err:
        # 新基准已经写好（下一轮起恢复正常），但**这一轮必须失败**：重置出来的 0% 不是
        # 「这个月没有回撤」，只是「峰值丢了」。抛出去 → archive_round 记 month_dd_error
        # → guard.ts 走「回撤未知 + 点名告警」那条路，而不是拿 0 去放行。
        raise MonthStateCorrupt(err)
    return st


def month_metrics(equity, now=None, state=None):
    """当月风险指标（唯一口径）。**纯计算，绝不落盘。**

    返回 dict：
      month / month_start_equity / month_peak_equity
      month_pnl_pct   当月收益率（%，相对月初权益）
      month_dd_pct    **真实回撤**（%，相对当月峰值；负数=回撤）
      time_progress / day / days_in_month / achieved_pct_of_target / monthly_target_pct

    `state` 可传入已经 `update_month_state()` 或 `read_month_state()` 得到的状态，
    避免同一轮重复读文件；不传则走只读视图（不落盘）。
    """
    now = _now(now)
    equity = float(equity or 0)
    st = state if state is not None else read_month_state(equity, now)

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
        # 状态文件损坏时上面的回撤是「虚拟重置后的 0」，不是结论。
        # 一律带上这个标记，展示层才有机会把它显示成「—」而不是一个看起来很正常的 0.00%。
        "month_state_corrupt": bool(st.get("state_corrupt")),
        "corrupt_error": st.get("corrupt_error"),
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


if __name__ == "__main__":  # 手动排查用：打印当月指标（**只读**，不会改动基准与峰值）
    import argparse

    ap = argparse.ArgumentParser(
        description="打印当月风险指标。只读 —— 排查动作不该改动 L1-6 的分母。"
    )
    ap.add_argument("--equity", type=float, required=True, help="当前账户权益（USDT）")
    a = ap.parse_args()
    state = read_month_state(a.equity)
    m = month_metrics(a.equity, state=state)
    m["l1_6_tripped"] = month_dd_circuit_tripped(m["month_dd_pct"])
    m["state_source"] = MONTH_STATE
    m["state_month"] = state.get("month")
    print(json.dumps(m, ensure_ascii=False, indent=2))
