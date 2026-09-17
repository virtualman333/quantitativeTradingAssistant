#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dashboard.py — 生成 DASHBOARD.md（一页纸全局面板）

存在的意义：章程 §12 规定 DASHBOARD 每轮必须更新。靠 AI 每轮手写字数会漂移、
格式会走样，故改为脚本生成 —— 确定性部分（轮次、复盘债、提案、消息）自动拉取，
账户/持仓等需要 MCP 的部分由 AI 通过 --account 传入 JSON。

用法：
  python scripts/dashboard.py                          # 只更新自动部分
  python scripts/dashboard.py --account state/account_snapshot.json
  python scripts/dashboard.py --account state/account_snapshot.json --next-round 21:26

account_snapshot.json 结构：
{
  "demo": {"equity": 80025.5939, "avail": 80025.5939, "positions": [
      {"inst":"BTC-USDT-SWAP","side":"多","size":1.2,"avg":78000,"lever":5,
       "tp":81000,"sl":77000,"upl":120.5,"has_oco":true}]},
  "live": {"equity": 7495.0, "positions": [
      {"inst":"ETH-USDT (MARGIN)","side":"多","size":6.067,"avg":2470.39,"lever":5,
       "tp":null,"sl":null,"upl":-179.15,"has_oco":false,"upl_ratio":-5.97,
       "mark":2443.42,"liq":1271.27,"mgn_ratio":23.55}]}
}
"""

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone, timedelta

import jsonstore

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DASH = os.path.join(ROOT, "DASHBOARD.md")
STATE = os.path.join(ROOT, "state")
RUNTIME = os.path.join(STATE, "runtime.json")
REVIEWED = os.path.join(STATE, "reviewed_trades.json")
NEWS_JSONL = os.path.join(ROOT, "news", "news.jsonl")
LEDGER = os.path.join(ROOT, "ledger", "trades.csv")
ACCOUNT = os.path.join(STATE, "account_snapshot.json")
CHARTER = os.path.join(ROOT, "AGENT_TRADING_RULES.md")
CST = timezone(timedelta(hours=8))

CLOSE_ACTIONS = {"平仓", "止损触发", "止盈触发", "时间止损平仓"}
DIR_CN = {"bullish": "利多", "bearish": "利空", "neutral": "中性", "mixed": "多空交织"}
IMP_CN = {"high": "高", "mid": "中", "low": "低"}


def charter_version():
    """从章程标题自动解析版本号（如 '# ... 章程 v1.4' → 'v1.4'）。

    不硬编码 —— 否则每次章程升版都要改脚本，且极易忘记同步导致面板显示旧版本。
    解析失败时降级为 '未知' 并提示，绝不静默显示错误版本。
    """
    import re
    try:
        with open(CHARTER, encoding="utf-8") as f:
            for line in f:
                if line.startswith("#"):
                    m = re.search(r"v(\d+\.\d+)", line)
                    if m:
                        return "v" + m.group(1)
                    break
    except OSError:
        pass
    return "未知（章程解析失败，请检查 AGENT_TRADING_RULES.md）"


def now():
    return datetime.now(CST)


def load_json(p, default=None):
    if not os.path.exists(p):
        return default
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def read_runtime():
    """读运行态，返回 `(dict, error)`：**「没有文件」与「文件坏了」必须分得开**。

    这里原来写的是 `load_json(RUNTIME, {}) or {}` —— 两条路都得到 `{}`，于是下面那段
    熔断告警**静默消失**：坏文件的净效果不是「状态读不出来」，而是看板告诉用户
    「今日未熔断」（实际可能已经熔断过两次）。`month_state` 那条同类教训已经吃过一次，
    处置办法一样：分得开，然后**说出来**。
    """
    data, err = jsonstore.read_json_state(RUNTIME)
    return (data or {}), err


def _f(v, d=0.0):
    try:
        return float(v)
    except Exception:
        return d


def load_news_today(day):
    rows = []
    if not os.path.exists(NEWS_JSONL):
        return rows
    with open(NEWS_JSONL, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if (o.get("logged_at_cst") or "").startswith(day):
                rows.append(o)
    return rows


def load_trades_today(day):
    if not os.path.exists(LEDGER):
        return []
    out = []
    with open(LEDGER, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if (r.get("trade_time_cst") or "").startswith(day):
                out.append(r)
    return out


def build(args):
    t = now()
    day = t.strftime("%Y-%m-%d")
    runtime, runtime_err = read_runtime()
    rv = load_json(REVIEWED, {"reviews": [], "proposals": []}) or {"reviews": [], "proposals": []}
    acct = load_json(args.account, None) if args.account else (load_json(ACCOUNT, None))
    news = load_news_today(day)
    trades = load_trades_today(day)

    L = []
    A = L.append

    # ── 头部 ─────────────────────────────────────────────
    A("# 交易系统面板 DASHBOARD")
    A("")
    A("> 本文件由 `scripts/dashboard.py` 自动生成，每轮结束时更新（章程 §12 硬性要求）。")
    A("> 想看「为什么这么决策」→ `state/decision_RXXXXXX.md`；想看「学到了什么」→ `EVOLUTION.md`")
    A("")
    A("**更新时间**：%s ｜ **已执行轮次**：%s ｜ **上次轮次**：%s"
      % (t.strftime("%Y-%m-%d %H:%M:%S"),
         runtime.get("round_count", 0),
         runtime.get("last_round_id", "-")))
    if args.next_round:
        A("**下次轮次**：%s" % args.next_round)
    A("")

    # ── 熔断 / 待办告警（最重要，放最前）────────────────
    alerts = []
    # 「计数不可信」必须排在「熔断中」前面：此时 `circuit_breaker` 是 null（未知），
    # 下面那条 `if` 天然不成立，沉默就等于报了一句「今日未熔断」—— 那是最危险的一种谎。
    if runtime_err:
        alerts.append("🔴 **运行态文件损坏** — 本日熔断状态读不出来（%s）。下一轮归档会把坏文件"
                      "留档为 `state/runtime.json.corrupt-*` 并按本轮权益重建；**在此之前以及重建后"
                      "的本日剩余时间里，止损计数与当日盈亏都是「重置后的 0」而不是结论**，"
                      "不能据此断定未熔断" % runtime_err)
    elif runtime.get("day_counters_compromised"):
        alerts.append("🔴 **本日计数不可信** — 运行态文件曾在 %s 损坏并被重建（%s）。"
                      "本日止损计数与当日盈亏已经从 0 重新开始累计，看板上的数字**不是本日实况**，"
                      "熔断与否需要人工核对交易所账单"
                      % (runtime.get("day_counters_compromised_at") or "某轮",
                         runtime.get("day_counters_compromised_error") or "原因未记录"))
    elif runtime.get("circuit_breaker"):
        alerts.append("🔴 **熔断中** — 当日止损 %s 次 或 日亏损 %.2f%%，本日停止开新仓"
                      % (runtime.get("day_sl_count", 0), _f(runtime.get("day_pnl_pct"))))

    # 复盘债
    closes = [x for x in trades if x.get("action") in CLOSE_ACTIONS]
    done_keys = {r.get("key") for r in rv["reviews"]}
    debt = [x for x in closes if "|".join([
        x.get("trade_time_cst", ""), x.get("instrument", ""), x.get("action", ""),
        x.get("avg_price", ""), x.get("size_contracts", "")]) not in done_keys]
    loss_debt = [x for x in debt if _f(x.get("pnl_usdt")) < 0]
    if loss_debt:
        alerts.append("🔴 **复盘债 %d 笔（含亏损 %d 笔）** — 未清零前**禁止开新仓**（章程 §11.2）"
                      % (len(debt), len(loss_debt)))
    elif debt:
        alerts.append("🟡 待复盘 %d 笔（均为盈利，可选复盘，不阻断交易）" % len(debt))

    # 无止损持仓
    if acct:
        for env in ("demo", "live"):
            for p in (acct.get(env, {}) or {}).get("positions", []) or []:
                if not p.get("has_oco"):
                    alerts.append("🔴 **裸仓告警（%s）**：%s %s %s @%s ｜ 浮亏 %s"
                                  % (env, p.get("inst"), p.get("side"),
                                     p.get("size"), p.get("avg"), p.get("upl")))

    # 待批准提案
    pend = [p for p in rv.get("proposals", []) if p.get("status") == "pending_approval"]
    if pend:
        alerts.append("🟡 **待批准提案 %d 条** → `PLAYBOOK.md`（批准前不生效）" % len(pend))

    if alerts:
        A("## ⚠ 需要你注意")
        A("")
        for a in alerts:
            A("- %s" % a)
        A("")
    else:
        A("## ✅ 无告警")
        A("")
        A("无熔断、无复盘债、无裸仓、无待批准提案。")
        A("")

    # ── 账户与持仓 ───────────────────────────────────────
    A("## 1. 账户状态")
    A("")
    if not acct:
        A("_（未提供账户快照。运行 `dashboard.py --account state/account_snapshot.json` 注入）_")
        A("")
    else:
        A("| 环境 | 总权益 (USDT) | 可用 | 持仓数 |")
        A("|------|--------------|------|--------|")
        for env, label in (("demo", "模拟盘 · 执行"), ("live", "实盘 · 只读")):
            e = acct.get(env) or {}
            pos = e.get("positions") or []
            A("| %s | %s | %s | %d |"
              % (label, e.get("equity", "-"), e.get("avail", "-"), len(pos)))
        A("")

        for env, label in (("demo", "模拟盘"), ("live", "实盘（只读）")):
            pos = (acct.get(env) or {}).get("positions") or []
            if not pos:
                continue
            A("**%s 持仓**" % label)
            A("")
            A("| 标的 | 方向 | 数量 | 开仓均价 | 现价 | 杠杆 | 止盈 | 止损 | 浮盈亏 | 保护 |")
            A("|------|------|------|----------|------|------|------|------|--------|------|")
            for p in pos:
                A("| %s | %s | %s | %s | %s | %sx | %s | %s | %s | %s |"
                  % (p.get("inst"), p.get("side"), p.get("size"), p.get("avg"),
                     p.get("mark", "-"), p.get("lever"),
                     p.get("tp") if p.get("tp") else "—",
                     p.get("sl") if p.get("sl") else "**无**",
                     p.get("upl"), "✅" if p.get("has_oco") else "🔴 **裸仓**"))
            A("")

    # ── 月度目标进度（月度收益率/回撤/进度一律取自 month_risk.py，档位算法取自 mail_report）──
    demo_eq = _f((acct or {}).get("demo", {}).get("equity"), 0.0)
    if demo_eq > 0:
        try:
            import mail_report as _mr
            import month_risk as _mrk
            # ★ 看板是**只读展示**：month_metrics() 是纯计算，绝不改动 state/month_state.json。
            #   此前这里调的是 ensure_month_state()（会写盘），而 demo_eq 来自 AI 手填的
            #   `--account` 快照 —— 一份过期的、或比当月峰值更高的快照，会把
            #   `month_peak_equity` 永久抬高（只增不减、不可逆），于是真实权益此后一直被算成
            #   深度回撤，`guard.ts` 误触发 L1-6 停止一切开新仓；跨月首日打开一次看板还会把
            #   整月的 `month_start_equity` 冻结成快照里的数字。基准与峰值只由 archive_round.py 写。
            m = _mrk.month_metrics(demo_eq)
            n = _mrk._now()
            dim = m["days_in_month"]
            pnl_pct = m["month_pnl_pct"]
            dd_pct = m["month_dd_pct"]
            # 状态文件损坏时 dd_pct 是「虚拟重置后的 0」，不是「这个月没有回撤」——
            # 展示层必须把它显示成「—」，否则用户看到的是一个和「一切正常」长得一样的假数字。
            corrupt = bool(m.get("month_state_corrupt"))
            tp = m["time_progress"]
            ach = m["achieved_pct_of_target"]
            m0 = m["month_start_equity"]
            realized, realized_n, fee = _mr.month_realized_pnl(m["month"])
            tk, tier = _mr.pick_risk_tier(pnl_pct, tp, dd_pct)

            A("## 1b. 月度目标进度（目标 +%.0f%%）" % _mrk.MONTHLY_TARGET_PCT)
            A("")
            done = int(round(ach / 10.0))
            bar = "█" * min(done, 10) + "░" * max(0, 10 - min(done, 10))
            A("```")
            A("  %s  %.1f%%  （第 %d/%d 天，时间已过 %.0f%%）"
              % (bar, ach, n.day, dim, tp * 100))
            A("```")
            A("")
            A("| 指标 | 数值 |")
            A("|------|------|")
            A("| 月初基准权益 | %.2f USDT |" % m0)
            A("| 当前权益 | %.2f USDT |" % demo_eq)
            A("| 月度收益率 | **%+.2f%%** %s |"
              % (pnl_pct, "✅ 已达标" if pnl_pct >= _mr.MONTHLY_TARGET_PCT else ""))
            A("| 月度回撤（自峰值） | %s |"
              % ("**—** ⚠ 状态文件损坏" if corrupt else "%.2f%%" % dd_pct))
            A("| 已实现盈亏 | %+.2f USDT（%d 笔平仓，手续费 %.2f）|" % (realized, realized_n, fee))
            A("| **当前风险档位** | **%s** — risk_pct = **%.1f%%** |" % (tier["label"], tier["risk_pct"]))
            A("| 档位依据 | %s |" % tier["note"])
            A("")
            if corrupt:
                # 「0% 回撤」是最危险的一种谎：它和「一切正常」长得一模一样。
                A("> ⚠ **月度状态文件损坏**（%s）：月度基准与峰值不可信，上表的回撤是"
                  "「虚拟重置后的 0」而**不是结论**，档位仅供参照。`archive_round.py` "
                  "下一轮会把坏文件隔离留档（`.corrupt-<时间戳>`）并按真实权益重建基准，"
                  "这一轮的回撤进日志与邮件告警。" % (m.get("corrupt_error") or "原因未记录"))
                A("")
            if dd_pct <= -8.0:
                A("> 🔴 **已触发 DEFEND 防守档**：月度回撤 %.2f%%。本月目标已放弃，只做最高确定性单。" % dd_pct)
                A("")
        except Exception as e:
            A("## 1b. 月度目标进度")
            A("")
            A("_（月度进度计算失败：%s）_" % e)
            A("")

    # ── 当日交易 ─────────────────────────────────────────
    A("## 2. 当日交易")
    A("")
    if not trades:
        A("本日暂无成交。")
        A("")
    else:
        A("| 时间 | 标的 | 方向 | 操作 | 数量 | 均价 | 盈亏 | 决策摘要 |")
        A("|------|------|------|------|------|------|------|----------|")
        for x in trades:
            A("| %s | %s | %s | %s | %s | %s | %s | %s |"
              % (x.get("trade_time_cst", "")[11:], x.get("instrument"),
                 x.get("direction"), x.get("action"), x.get("size_contracts"),
                 x.get("avg_price"), x.get("pnl_usdt"),
                 (x.get("decision_summary") or "")[:40]))
        A("")

    # ── 消息面 ───────────────────────────────────────────
    A("## 3. 消息面（今日入库 %d 条）" % len(news))
    A("")
    usable = [n for n in news if n.get("credibility") in ("A", "B")]
    if not usable:
        A("今日无 A/B 级消息，消息面不参与决策。")
        A("")
    else:
        A("| 级别 | 方向 | 影响 | 标题 | 发布 |")
        A("|------|------|------|------|------|")
        oc = {"A": 0, "B": 1}
        oi = {"high": 0, "mid": 1, "low": 2}
        for n in sorted(usable, key=lambda x: (oc.get(x.get("credibility"), 9),
                                               oi.get(x.get("impact"), 9))):
            A("| %s | %s | %s | %s | %s |"
              % (n.get("credibility"),
                 DIR_CN.get(n.get("direction"), n.get("direction")),
                 IMP_CN.get(n.get("impact"), n.get("impact")),
                 (n.get("title") or "")[:44], n.get("published_at") or "?"))
        A("")
        hi = [n for n in usable if n.get("impact") == "high"]
        if hi:
            A("**高影响消息决策含义**：")
            A("")
            for n in hi:
                A("- **[%s/%s]** %s" % (n.get("credibility"),
                                        DIR_CN.get(n.get("direction"), ""),
                                        n.get("note") or n.get("title")))
            A("")

    # ── 进化状态 ─────────────────────────────────────────
    A("## 4. 进化状态")
    A("")
    reviews = rv.get("reviews", [])
    if not reviews:
        A("暂无复盘记录（系统尚未产生已平仓交易）。")
        A("")
    else:
        cnt, pnl_by = {}, {}
        for r in reviews:
            c = r.get("cause")
            cnt[c] = cnt.get(c, 0) + 1
            pnl_by[c] = pnl_by.get(c, 0.0) + _f(r.get("pnl_usdt"))
        A("累计复盘 **%d** 笔 ｜ 归因分布：" % len(reviews))
        A("")
        A("| 归因 | 次数 | 累计盈亏 |")
        A("|------|------|----------|")
        for c, n in sorted(cnt.items(), key=lambda x: -x[1]):
            A("| `%s` | %d | %.2f |" % (c, n, pnl_by[c]))
        A("")
        last = reviews[-1]
        A("**最近一条经验**（%s）：" % last.get("committed_at_cst", ""))
        A("")
        A("> %s" % (last.get("lesson") or ""))
        A("")

    props = rv.get("proposals", [])
    if props:
        A("**优化提案**：")
        A("")
        A("| 归因 | 次数 | 状态 |")
        A("|------|------|------|")
        for p in props:
            st = {"pending_approval": "⏳ 待批准（不生效）",
                  "approved": "✅ 已生效",
                  "rejected": "❌ 已否决"}.get(p.get("status"), p.get("status"))
            A("| `%s` | %s | %s |" % (p.get("cause"), p.get("count"), st))
        A("")

    # ── 当前生效规则 ─────────────────────────────────────
    A("## 5. 当前生效规则速查")
    A("")
    A("| 项目 | 状态 |")
    A("|------|------|")
    A("| 章程版本 | **%s**（`AGENT_TRADING_RULES.md`）|" % charter_version())
    A("| 月度目标 | **≥ +10%（年化 213.8%）** |")
    A("| 路径 A 趋势共振 | ✅ **生效**（共振 ≥28、量比 ≥0.8、盈亏比 ≥1.6）|")
    A("| 路径 B 区间均值回归 | ✅ **已生效**（2026-09-01 用户批准）|")
    A("| 标的范围 | BTC-USDT-SWAP / ETH-USDT-SWAP 永续 |")
    A("| 杠杆上限 | 5x（红线，永不放宽）|")
    A("| 单笔风险 | 档位基准 1.5%（进攻 2.0% / 防守 0.5%）× 信号系数，**硬顶 2.0%** |")
    A("| 风险档位 | DEFEND 0.5% / REDUCE 1.0% / LOCK 0.8% / BASE 1.5% / ATTACK 2.0% |")
    A("| 敞口上限 | 单标的 ≤3.0× 权益，总敞口 ≤5.0× 权益 |")
    A("| 熔断 | 当日 3 次止损 或 回撤 ≥5%；**月度回撤 ≥8% → 放弃当月目标** |")
    A("| 止损 | 1.5×ATR(1H)，mark 价触发 |")
    A("| 止盈 | ≥ 2R |")
    A("| 消息面作用 | 否决权 + 仓位调节，**不作为开仓信号** |")
    A("| 进化闸门 | 亏损未复盘 → **禁止开新仓** |")
    A("| 邮件推送 | **每轮必发** → virtualman@vip.qq.com（交易完成后发送）|")
    A("")

    # ── 本周事件 ─────────────────────────────────────────
    A("## 6. 事件风险日历")
    A("")
    A("| 日期 | 事件 | 影响 | 闸门 |")
    A("|------|------|------|------|")
    A("| 2026-09-03 20:30 | 美联储理事沃勒通胀讲话（FOMC 静默期前最后官员表态）| 中 | 建议谨慎 |")
    A("| 2026-09-04 20:30 | **8月非农就业报告**（预期 +5.0万~5.8万，失业率 4.1%）| 高 | 前后 2h 禁开新仓 |")
    A("| 2026-09-10 | 美国 8月 PPI | 中 | — |")
    A("| 2026-09-11 | 美国 8月 CPI | 高 | 前后 2h 禁开新仓 |")
    A("| **2026-09-15~16** | **FOMC 议息（决议 9/16，加息概率 64%~66.4%）** | **极高** | 前后 2h 禁开新仓 |")
    A("| 2026-09 中旬 | CLARITY 法案投票 | 中 | — |")
    A("")
    A("> ⚠ **非农反应函数已反转**（2026-09-01 确认）：加息定价环境下，"
      "强就业数据 = 鹰派 = 利空加密；弱数据 = 打消加息 = 利多加密。"
      "与 2024-2025 年「弱数据→降息→利多」的旧直觉相反，9/4 解读时务必反着读。")
    A("")

    A("---")
    A("")
    A("_生成者：`scripts/dashboard.py` ｜ 完整纪律：`AGENT_TRADING_RULES.md` ｜ "
      "源码清单：`NEWS_SOURCES.md` ｜ 复盘流水：`EVOLUTION.md`_")

    with open(DASH, "w", encoding="utf-8") as f:
        f.write("\n".join(L))

    print("DASHBOARD.md 已更新（%d 行）" % len(L))
    if alerts:
        print("告警 %d 条：" % len(alerts))
        for a in alerts:
            print("   - %s" % a.replace("**", ""))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account", default="", help="账户快照 JSON（由 AI 经 MCP 采集后写入）")
    ap.add_argument("--next-round", default="", help="下次轮次时间，如 21:26")
    return build(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
