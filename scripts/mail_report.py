#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mail_report.py — 每轮交易循环的邮件报告渲染器

设计原则：
  邮件格式由脚本确定性渲染，AI 只负责把渲染结果投递出去。
  这样几十轮、几百轮之后邮件格式不会漂移，也不会因为某轮上下文
  紧张就漏掉关键字段。

数据来源（全部只读）：
  logs/rounds.jsonl        本轮结构化快照
  state/runtime.json       运行态（熔断、当日止损计数）
  ledger/trades.csv        交易台账（月度已实现盈亏）
  state/month_state.json   月度目标基准（本脚本自动初始化/跨月重置）

输出：JSON {subject, body, risk_tier, alerts[]}

用法：
  python scripts/mail_report.py --round-id R000003 --out state/mail_out.json
  python scripts/mail_report.py --print          # 直接打印最后一轮（调试用）
"""

import argparse
import csv
import json
import os
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CST = timezone(timedelta(hours=8))

ROUNDS = os.path.join(ROOT, "logs", "rounds.jsonl")
RUNTIME = os.path.join(ROOT, "state", "runtime.json")
LEDGER = os.path.join(ROOT, "ledger", "trades.csv")
MONTH_STATE = os.path.join(ROOT, "state", "month_state.json")

MONTHLY_TARGET_PCT = 10.0          # 月度目标收益率（%）
RECIPIENT = "virtualman@vip.qq.com"

# 目标进度自适应风险档位（章程 §5.3）
TIER = {
    "DEFEND":  {"risk_pct": 0.5, "label": "防守档", "note": "月度回撤 ≥8%，停止追目标，只做高确定性单"},
    "REDUCE":  {"risk_pct": 1.0, "label": "降档",   "note": "月度回撤 5%~8%，降低风险暴露"},
    "LOCK":    {"risk_pct": 0.8, "label": "锁利档", "note": "月度目标已达成，保住利润为主"},
    "ATTACK":  {"risk_pct": 2.0, "label": "进攻档", "note": "进度落后于时间，放大仓位（不降低开仓门槛）"},
    "BASE":    {"risk_pct": 1.5, "label": "基准档", "note": "正常推进"},
}


def _now():
    return datetime.now(CST)


def load_last_round(round_id=None):
    """取最后一条轮次记录；若指定 round_id 则精确匹配。"""
    rows = []
    if not os.path.exists(ROUNDS):
        return None
    with open(ROUNDS, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    if not rows:
        return None
    if round_id:
        for r in rows:
            if r.get("round_id") == round_id:
                return r
        return None
    return rows[-1]


def load_runtime():
    if not os.path.exists(RUNTIME):
        return {}
    with open(RUNTIME, encoding="utf-8") as f:
        return json.load(f)


def month_realized_pnl(year_month):
    """台账中指定月份的已实现盈亏合计（不含手续费另计）。"""
    if not os.path.exists(LEDGER):
        return 0.0, 0, 0.0
    pnl = 0.0
    fee = 0.0
    n = 0
    with open(LEDGER, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            t = (row.get("trade_time_cst") or "")
            if not t.startswith(year_month):
                continue
            try:
                pnl += float(row.get("pnl_usdt") or 0)
            except ValueError:
                pass
            try:
                fee += float(row.get("fee_usdt") or 0)
            except ValueError:
                pass
            n += 1
    return pnl, n, fee


def days_in_month(y, m):
    if m == 12:
        return 31
    import calendar
    return calendar.monthrange(y, m)[1]


def ensure_month_state(equity):
    """维护月度基准：跨月自动重置；同月持续跟踪权益峰值（用于真实回撤计算）。"""
    now = _now()
    ym = now.strftime("%Y-%m")
    st = {}
    if os.path.exists(MONTH_STATE):
        try:
            with open(MONTH_STATE, encoding="utf-8") as f:
                st = json.load(f)
        except Exception:
            st = {}
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
    # 注意：json.dump 的 fp 必须传位置参数，不能写成 fp=f（会 TypeError）
    with open(MONTH_STATE, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
    return st


def pick_risk_tier(month_pnl_pct, time_progress, month_dd_pct):
    """按月度回撤 / 目标进度 / 时间进度 选择下一轮风险档位。

    ATTACK 档必须有最小时间进度门槛：月初头几天时间进度极低，完成度
    必然接近 0，若不设门槛会被误判成「严重落后」，导致一开局就满仓。
    """
    if month_dd_pct <= -8.0:
        return "DEFEND", TIER["DEFEND"]
    if month_dd_pct <= -5.0:
        return "REDUCE", TIER["REDUCE"]
    if month_pnl_pct >= MONTHLY_TARGET_PCT:
        return "LOCK", TIER["LOCK"]
    # 进度落后：完成率不足时间进度的一半，且当月已过去至少 20%
    achieved_ratio = month_pnl_pct / MONTHLY_TARGET_PCT if MONTHLY_TARGET_PCT else 0
    if time_progress >= 0.20 and achieved_ratio < time_progress * 0.5:
        return "ATTACK", TIER["ATTACK"]
    return "BASE", TIER["BASE"]


def fmt_pos(p):
    """渲染一行持仓。"""
    inst = p.get("instrument", "?")
    sym = inst.split("-")[0]
    side = p.get("side") or "无"
    if not p.get("size_contracts") and side in ("无", "", None):
        return "   %-4s  无持仓" % sym
    size = p.get("size_contracts") or "-"
    entry = p.get("entry") or "-"
    lev = p.get("leverage") or "-"
    tp = p.get("tp") or "-"
    sl = p.get("sl") or "-"
    upl = p.get("upl")
    upl_s = ("%+ .2f" % float(upl)) if upl not in (None, "", "-") else "-"
    return "   %-4s  %s  数量 %s 张 | 开仓 %s | 杠杆 %sx | 止盈 %s | 止损 %s | 浮盈 %s USDT" % (
        sym, side, size, entry, lev, tp, sl, upl_s)


def fmt_live(lw):
    """渲染实盘存量仓位（只读监控）。多行结构化，避免原样 dump JSON 导致
    用户最关心的风险项（裸仓/浮亏/距强平）埋在一行字符串里读不出来。"""
    if not isinstance(lw, dict):
        return ["   %s" % lw]

    def g(k, d="-"):
        v = lw.get(k)
        return d if v in (None, "", "-") else v

    def num(k, fmt="%s", d="-"):
        v = lw.get(k)
        if v in (None, "", "-"):
            return d
        try:
            return fmt % float(v)
        except (TypeError, ValueError):
            return str(v)

    inst = g("instrument", "?")
    itype = lw.get("inst_type") or ""
    head = "   %s%s" % (inst, ("  [%s]" % itype) if itype else "")

    side = lw.get("side") or "多"
    out = [head]
    out.append("     持仓     %s %s | 开仓均价 %s | 杠杆 %sx" % (
        side, num("size_base", "%.8f"), num("entry", "%.4f"), g("leverage")))
    out.append("     标记价   %s | 名义敞口 %s USD" % (
        num("mark", "%.2f"), num("notional_usd", "%.2f")))

    upl = lw.get("upl")
    upl_s = num("upl", "%+.2f")
    ratio = lw.get("upl_ratio_pct")
    ratio_s = ("（%+.2f%%）" % float(ratio)) if ratio not in (None, "", "-") else ""
    flag = ""
    try:
        flag = "  ⚠ 浮亏" if float(upl) < 0 else "  ✅ 浮盈"
    except (TypeError, ValueError):
        pass
    out.append("     浮动盈亏 %s USDT%s%s" % (upl_s, ratio_s, flag))

    sl = lw.get("sl")
    naked = sl in (None, "", "-", False)
    out.append("     止损     %s%s" % (
        "无" if naked else sl, "   🔴 裸仓（无止损保护）" if naked else ""))

    dist = lw.get("dist_to_liq_pct")
    dist_s = ("，距强平 %.2f%%" % float(dist)) if dist not in (None, "", "-") else ""
    out.append("     强平价   %s | 保证金率 %s%s" % (
        num("liq_px", "%.4f"), num("mgn_ratio", "%.4f"), dist_s))

    note = lw.get("note")
    if note:
        out.append("     备注     %s" % note)
    return out


def render(rnd, runtime, month_state, tier_key, tier, mp):
    """mp: 月度进度字典"""
    now = _now()
    rid = rnd.get("round_id", "?")
    t = rnd.get("time_cst", now.strftime("%Y-%m-%d %H:%M:%S"))
    equity = float(rnd.get("equity_usdt") or 0)
    avail = float(rnd.get("available_usdt") or 0)

    trades = rnd.get("trades") or []
    actions = rnd.get("actions") or []
    has_trade = bool(trades)

    # ---- 主题行 ----
    tag = "交易" if has_trade else "观望"
    if has_trade:
        detail = "/".join(sorted({(x.get("action") or "?") for x in trades}))
        tag = "★" + detail
    subject = "[OKX AI] %s %s | %s | 权益 %.2f | 月进度 %.1f%%" % (
        rid, t[5:16], tag, equity, mp["achieved_pct_of_target"])

    # ---- 正文 ----
    L = []
    A = L.append
    A("【OKX 自主交易 AI · 每轮执行报告】")
    A("")
    A("轮次：%s" % rid)
    A("时间：%s（CST）" % t)
    A("环境：%s" % (rnd.get("env") or "模拟盘 demo"))
    A("")
    A("─" * 58)
    A("")

    # 1 账户
    A("1. 账户状态")
    A("   总权益     %.2f USDT" % equity)
    A("   可用保证金 %.2f USDT" % avail)
    A("   占用保证金 %.2f USDT" % (equity - avail))

    # 月度目标进度
    A("")
    A("   月度目标进度（目标 +%.1f%%）" % MONTHLY_TARGET_PCT)
    A("   ├ 月初基准   %.2f USDT" % mp["month_start_equity"])
    A("   ├ 当前权益   %.2f USDT（月度 %.2f%%）" % (equity, mp["month_pnl_pct"]))
    A("   ├ 已实现盈亏 %+.2f USDT（%d 笔平仓，手续费 %.2f）" % (
        mp["realized_pnl"], mp["realized_n"], mp["fee"]))
    A("   ├ 时间进度   %.1f%%（第 %d/%d 天）" % (
        mp["time_progress"] * 100, mp["day"], mp["days_in_month"]))
    A("   └ 目标完成度 %.1f%%%s" % (
        mp["achieved_pct_of_target"],
        "  ✅ 已达标" if mp["month_pnl_pct"] >= MONTHLY_TARGET_PCT else ""))
    A("")
    A("   下一轮风险档位：%s  risk_pct = %.1f%%" % (tier["label"], tier["risk_pct"]))
    A("   依据：%s" % tier["note"])
    A("")
    A("─" * 58)
    A("")

    # 2 持仓
    A("2. 持仓明细")
    poss = rnd.get("positions") or []
    if poss:
        for p in poss:
            A(fmt_pos(p))
    else:
        A("   无持仓")
    live = rnd.get("live_watch") or []
    if live:
        A("")
        A("   [实盘存量仓位 · 只读监控]")
        for lw in live:
            for line in fmt_live(lw):
                A(line)
    A("")
    A("─" * 58)
    A("")

    # 3 消息面
    A("3. 消息面")
    news = rnd.get("news") or {}
    if news:
        A("   A级 %s 条 | B级 %s 条" % (news.get("a_count", 0), news.get("b_count", 0)))
        if news.get("headline"):
            A("   关键结论：%s" % news["headline"])
        if news.get("gate"):
            A("   闸门状态：%s" % news["gate"])
    else:
        A("   本轮未采集或未记录消息面")
    A("")
    A("─" * 58)
    A("")

    # 4 操作
    A("4. 本轮操作")
    if trades:
        for tr in trades:
            A("   %s %s %s | 数量 %s 张（%s） | 成交均价 %s" % (
                tr.get("trade_time_cst", "")[-8:] or "-",
                tr.get("instrument", "?"),
                tr.get("action", "?"),
                tr.get("size_contracts", "-"),
                tr.get("size_base", "-"),
                tr.get("avg_price", "-")))
            A("        方向 %s | 杠杆 %sx | 止盈 %s | 止损 %s | 盈亏 %s USDT | 手续费 %s" % (
                tr.get("direction", "-"), tr.get("leverage", "-"),
                tr.get("tp_price", "-"), tr.get("sl_price", "-"),
                tr.get("pnl_usdt", "-"), tr.get("fee_usdt", "-")))
            if tr.get("decision_summary"):
                A("        决策：%s" % tr["decision_summary"])
    else:
        A("   无操作")
    if actions:
        A("")
        for a in actions:
            A("   · %s" % (a if isinstance(a, str) else json.dumps(a, ensure_ascii=False)))
    A("")
    A("─" * 58)
    A("")

    # 5 决策摘要
    A("5. 决策摘要")
    dec = (rnd.get("decision") or "").strip()
    if not dec:
        dec = "（本轮未记录决策文本，详见 state/decision_%s.md）" % rid
    for line in dec.splitlines():
        A("   %s" % line)
    A("")
    A("─" * 58)
    A("")

    # 6 告警
    alerts = []
    for p in poss:
        if p.get("size_contracts"):
            if not p.get("sl") or str(p.get("sl")).strip() in ("", "-", "0"):
                alerts.append("⚠ 裸仓告警：%s 无止损委托" % p.get("instrument"))
    if runtime.get("circuit_breaker"):
        alerts.append("⚠ 熔断中：当日已止损 %s 次，本轮起停止开新仓" % runtime.get("day_sl_count"))
    if mp["month_dd_pct"] <= -5.0:
        alerts.append("⚠ 月度回撤 %.2f%%，已触发降档保护" % mp["month_dd_pct"])

    A("6. 告警与待办")
    if alerts:
        for a in alerts:
            A("   %s" % a)
    else:
        A("   无")
    A("")
    A("─" * 58)
    A("")

    A("7. 归档状态")
    A("   已永久留存")
    A("   日志：logs/%s/%s.md" % (t[:7], t[:10]))
    A("   决策：state/decision_%s.md" % rid)
    A("   快照：%s" % (rnd.get("snapshot_path") or "state/snapshots/"))
    A("")
    A("─" * 58)
    A("本邮件由 scripts/mail_report.py 自动生成，%s" % now.strftime("%Y-%m-%d %H:%M:%S"))
    A("收件人：%s ｜ 数据来源：OKX 公开行情 + demo/live 账户" % RECIPIENT)

    return subject, "\n".join(L), alerts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--round-id", default="", help="指定轮次号；留空取最后一轮")
    ap.add_argument("--out", default="", help="输出 JSON 路径")
    ap.add_argument("--print", dest="do_print", action="store_true")
    args = ap.parse_args()

    rnd = load_last_round(args.round_id or None)
    if not rnd:
        print("ERROR: 未找到轮次记录（logs/rounds.jsonl 为空或不存在）")
        return 1
    runtime = load_runtime()
    equity = float(rnd.get("equity_usdt") or 0)

    now = _now()
    ym = now.strftime("%Y-%m")
    mst = ensure_month_state(equity)
    realized, realized_n, fee = month_realized_pnl(ym)

    m0 = float(mst.get("month_start_equity") or equity)
    peak = max(float(mst.get("month_peak_equity") or m0), m0, equity)
    month_pnl_pct = ((equity - m0) / m0 * 100) if m0 else 0.0
    # 真实回撤：从月度权益峰值回落的比例（不是月末对月初，峰值已被 ensure_month_state 更新）
    month_dd_pct = ((equity - peak) / peak * 100) if peak else 0.0

    dim = days_in_month(now.year, now.month)
    time_progress = now.day / dim
    achieved_pct_of_target = (month_pnl_pct / MONTHLY_TARGET_PCT * 100) if MONTHLY_TARGET_PCT else 0

    mp = {
        "month": ym,
        "month_start_equity": m0,
        "equity": equity,
        "month_pnl_pct": month_pnl_pct,
        "month_dd_pct": month_dd_pct,
        "realized_pnl": realized,
        "realized_n": realized_n,
        "fee": fee,
        "day": now.day,
        "days_in_month": dim,
        "time_progress": time_progress,
        "achieved_pct_of_target": achieved_pct_of_target,
    }

    tier_key, tier = pick_risk_tier(month_pnl_pct, time_progress, month_dd_pct)
    subject, body, alerts = render(rnd, runtime, mst, tier_key, tier, mp)

    payload = {
        "round_id": rnd.get("round_id"),
        "time_cst": rnd.get("time_cst"),
        "to": RECIPIENT,
        "subject": subject,
        "body": body,
        "body_format": "PLAIN",
        "risk_tier": tier_key,
        "risk_pct": tier["risk_pct"],
        "month_progress": mp,
        "alerts": alerts,
        "has_trade": bool(rnd.get("trades")),
    }

    if args.out:
        outp = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)
        with open(outp, "w", encoding="utf-8") as f:
            json.dump(payload, ensure_ascii=False, indent=2, fp=f)
        print("written: %s" % outp)
        print("subject: %s" % subject)
        print("risk_tier: %s (risk_pct=%.1f%%)" % (tier_key, tier["risk_pct"]))
        print("body chars: %d | alerts: %d" % (len(body), len(alerts)))

    if args.do_print or not args.out:
        print("\n" + "=" * 62)
        print(subject)
        print("=" * 62)
        print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
