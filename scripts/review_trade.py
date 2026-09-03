#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
review_trade.py — 交易复盘与自动进化引擎

闭环：平仓 → 强制归因 → 归因为其一类 → 同类累计达标 → 自动生成章程优化提案

设计要点：
  * 亏损交易 **必须** 复盘，未复盘的会在 --prepare 中持续列出（无法绕过）
  * 盈利交易 **可选** 复盘（用于提炼可复制模式），不强制
  * 归因分类固定 7 类，避免每次自由发挥导致统计失效
  * 归因统计达到阈值（默认同类 >=3 次）自动生成优化提案，写入 PLAYBOOK.md
  * 所有产物只追加，复盘结论不可篡改

命令：
  python scripts/review_trade.py --prepare    # 列出待复盘交易 + 生成模板
  python scripts/review_trade.py --commit --input state/review_input.json
  python scripts/review_trade.py --stats      # 归因分布 + 提案状态
"""

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(ROOT, "ledger", "trades.csv")
STATE_DIR = os.path.join(ROOT, "state")
REVIEWED = os.path.join(STATE_DIR, "reviewed_trades.json")
EVOLUTION = os.path.join(ROOT, "EVOLUTION.md")
PLAYBOOK = os.path.join(ROOT, "PLAYBOOK.md")
CST = timezone(timedelta(hours=8))

CLOSE_ACTIONS = {"平仓", "止损触发", "止盈触发", "时间止损平仓"}
PROPOSAL_THRESHOLD = 3

CAUSES = {
    "signal_quality": "信号质量 — 共振分/门槛达标但结构本身是假突破，技术依据不成立",
    "timing":         "入场时机 — 方向对但点位差，追高/区间中枢进场/没等回踩",
    "sizing":         "仓位规模 — 单笔风险占比过大或过小，导致盈亏不对称",
    "stop_loss":      "止损设置 — 止损过窄被正常波动扫掉，或过宽导致单笔亏损超额",
    "take_profit":    "止盈设置 — 止盈过早锁定小利，或过贪回吐利润",
    "external_event": "外部事件 — 消息面/黑天鹅/数据公布导致的不可技术预判亏损",
    "execution":      "执行问题 — 滑点、未成交、下单参数错误、系统故障",
}


def now_cst():
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")


def load_trades():
    if not os.path.exists(LEDGER):
        return []
    with open(LEDGER, encoding="utf-8-sig", newline="") as f:
        return [r for r in csv.DictReader(f) if r.get("trade_time_cst")]


def _f(v, d=0.0):
    try:
        return float(v)
    except Exception:
        return d


def load_reviewed():
    if os.path.exists(REVIEWED):
        try:
            with open(REVIEWED, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"reviews": [], "proposals": []}


def save_reviewed(d):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(REVIEWED, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def trade_key(t):
    """交易唯一键：时间+标的+动作+价格+数量"""
    return "|".join([
        t.get("trade_time_cst", ""), t.get("instrument", ""),
        t.get("action", ""), t.get("avg_price", ""), t.get("size_contracts", ""),
    ])


def cmd_prepare():
    trades = load_trades()
    closes = [t for t in trades if t.get("action") in CLOSE_ACTIONS]
    rv = load_reviewed()
    done = {r["key"] for r in rv["reviews"]}

    pending = [t for t in closes if trade_key(t) not in done]
    forced = [t for t in pending if _f(t.get("pnl_usdt")) < 0]
    optional = [t for t in pending if _f(t.get("pnl_usdt")) >= 0]

    print("=" * 74)
    print("待复盘交易 | 已平仓 %d 笔 ｜ 已复盘 %d 笔 ｜ 待复盘 %d 笔"
          % (len(closes), len(done), len(pending)))
    print("=" * 74)

    if not pending:
        print("\n无待复盘交易。")
        return 0

    if forced:
        print("\n【强制复盘 · 亏损交易 %d 笔】—— 未全部完成前，不得开新仓" % len(forced))
        for i, t in enumerate(forced, 1):
            print("  %d. %s  %s %s  %s张 @%s  盈亏 %s USDT"
                  % (i, t.get("trade_time_cst"), t.get("instrument"),
                     t.get("direction", ""), t.get("size_contracts"),
                     t.get("avg_price"), t.get("pnl_usdt")))
    if optional:
        print("\n【可选复盘 · 盈利交易 %d 笔】" % len(optional))
        for i, t in enumerate(optional, 1):
            print("  %d. %s  %s %s  盈亏 %s USDT"
                  % (i, t.get("trade_time_cst"), t.get("instrument"),
                     t.get("direction", ""), t.get("pnl_usdt")))

    # 生成模板文件供 AI 填写
    tmpl = []
    A = tmpl.append
    A("{")
    A('  "reviews": [')
    blocks = []
    for t in pending:
        pnl = _f(t.get("pnl_usdt"))
        b = []
        b.append("    {")
        b.append('      "key": %s,' % json.dumps(trade_key(t), ensure_ascii=False))
        b.append('      "pnl_usdt": %s,' % t.get("pnl_usdt", "0"))
        b.append('      "round_id": %s,' % json.dumps(t.get("round_id", ""), ensure_ascii=False))
        b.append('      "open_round_id": "",')
        b.append('      "cause": "",            // 必填，七选一：%s' % " / ".join(CAUSES.keys()))
        b.append('      "cause_detail": "",     // 必填，具体哪里错了，禁止写"行情不好"这类无信息量的归因')
        b.append('      "market_context": "",   // 必填，开仓时的市场环境（趋势/震荡/事件前后）')
        b.append('      "was_rule_compliant": true,  // 必填，是否严格遵守了章程')
        b.append('      "rule_violation": "",   // 若 was_rule_compliant=false，说明违反了哪条')
        b.append('      "counterfactual": "",   // 必填，重来一次会在哪一步做得不同')
        b.append('      "lesson": "",           // 必填，可复用的经验，一句话')
        b.append('      "action_item": "",      // 选填，需要改动章程/脚本的具体动作')
        b.append('      "severity": "mid"       // low/mid/high，对策略的影响程度')
        b.append("    }")
        blocks.append("\n".join(b))
    A(",\n".join(blocks))
    A("  ]")
    A("}")

    out = os.path.join(STATE_DIR, "review_template.json")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(tmpl))
    print("\n模板已生成 → %s" % os.path.relpath(out, ROOT))
    print("填写后执行：python scripts/review_trade.py --commit --input %s" % os.path.relpath(out, ROOT))
    return 0


def cmd_commit(path_in):
    p = path_in if os.path.isabs(path_in) else os.path.join(ROOT, path_in)
    if not os.path.exists(p):
        print("[review] 文件不存在: %s" % p)
        return 2
    with open(p, encoding="utf-8") as f:
        payload = json.load(f)

    rv = load_reviewed()
    done = {r["key"] for r in rv["reviews"]}
    accepted, errs = [], []

    for r in payload.get("reviews", []):
        key = r.get("key", "")
        if not key:
            errs.append("条目缺少 key")
            continue
        if key in done:
            errs.append("重复提交: %s" % key[:40])
            continue
        cause = (r.get("cause") or "").strip()
        if cause not in CAUSES:
            errs.append("cause 非法(%r)，必须是七类之一" % cause)
            continue
        for field in ("cause_detail", "market_context", "counterfactual", "lesson"):
            if not (r.get(field) or "").strip():
                errs.append("%s 缺必填字段 %s" % (key[:30], field))
                break
        else:
            r["committed_at_cst"] = now_cst()
            accepted.append(r)
            done.add(key)

    if errs:
        print("[review] 校验未通过，未写入任何内容：")
        for e in errs:
            print("   - %s" % e)
        return 1
    if not accepted:
        print("[review] 无有效条目")
        return 1

    rv["reviews"].extend(accepted)
    save_reviewed(rv)

    # 追加到 EVOLUTION.md
    os.makedirs(ROOT, exist_ok=True)
    if not os.path.exists(EVOLUTION):
        with open(EVOLUTION, "w", encoding="utf-8") as f:
            f.write("# 进化日志 EVOLUTION.md\n\n"
                    "> 每笔交易复盘的第一手记录。只追加，永不改写。\n"
                    "> 由 `scripts/review_trade.py` 写入，人工与 AI 均不得编辑历史条目。\n\n---\n")

    L = []
    for r in accepted:
        pnl = _f(r.get("pnl_usdt"))
        L.append("\n## %s ｜ %s ｜ 盈亏 %s USDT" % (
            r.get("committed_at_cst"), "亏损复盘" if pnl < 0 else "盈利复盘", r.get("pnl_usdt")))
        L.append("")
        L.append("- **交易键**：`%s`" % r.get("key"))
        L.append("- **关联轮次**：%s ｜ **开仓轮次**：%s"
                 % (r.get("round_id") or "-", r.get("open_round_id") or "-"))
        L.append("- **归因分类**：`%s` — %s" % (r.get("cause"), CAUSES.get(r.get("cause"), "")))
        L.append("- **是否合规**：%s %s"
                 % ("是" if r.get("was_rule_compliant") else "**否**",
                    ("（违规：%s）" % r.get("rule_violation")) if r.get("rule_violation") else ""))
        L.append("- **市场环境**：%s" % r.get("market_context"))
        L.append("")
        L.append("**具体错在哪**：%s" % r.get("cause_detail"))
        L.append("")
        L.append("**重来一次会怎么做**：%s" % r.get("counterfactual"))
        L.append("")
        L.append("**可复用经验**：%s" % r.get("lesson"))
        if r.get("action_item"):
            L.append("")
            L.append("**待执行改进**：%s" % r.get("action_item"))
        L.append("")
        L.append("---")

    with open(EVOLUTION, "a", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")

    print("=" * 70)
    print("复盘已提交 %d 条 → EVOLUTION.md" % len(accepted))
    print("=" * 70)
    for r in accepted:
        print("  [%s] %s | %s" % (r.get("cause"), r.get("key")[:44], r.get("lesson")[:40]))

    # 检查是否触发提案阈值
    generate_proposals(rv)
    return 0


def generate_proposals(rv):
    """同类归因累计达阈值 → 生成优化提案（写入 PLAYBOOK.md 待批准区）"""
    cnt = {}
    for r in rv["reviews"]:
        c = r.get("cause")
        cnt[c] = cnt.get(c, 0) + 1

    existing_titles = {p.get("cause") for p in rv.get("proposals", [])}
    new_props = []

    for cause, n in cnt.items():
        if n >= PROPOSAL_THRESHOLD and cause not in existing_titles:
            lessons = [r.get("lesson", "") for r in rv["reviews"]
                       if r.get("cause") == cause and r.get("lesson")]
            items = [r.get("action_item", "") for r in rv["reviews"]
                     if r.get("cause") == cause and r.get("action_item")]
            new_props.append({
                "created_at_cst": now_cst(),
                "cause": cause,
                "count": n,
                "status": "pending_approval",
                "lessons": lessons,
                "action_items": [i for i in items if i],
            })

    if not new_props:
        return

    rv.setdefault("proposals", []).extend(new_props)
    save_reviewed(rv)

    if not os.path.exists(PLAYBOOK):
        with open(PLAYBOOK, "w", encoding="utf-8") as f:
            f.write("# 策略进化 Playbook\n\n"
                    "> 从 EVOLUTION.md 的复盘记录中提炼的可执行规则改进。\n"
                    "> **待批准区的规则在用户签字前一律不生效**，AI 不得据此交易。\n\n---\n")

    L = []
    for p in new_props:
        L.append("\n## 提案 · %s（累计 %d 次）— 待批准" % (p["cause"], p["count"]))
        L.append("")
        L.append("**归因说明**：%s" % CAUSES.get(p["cause"], ""))
        L.append("")
        L.append("**触发阈值**：同类归因累计 %d 次 ≥ %d" % (p["count"], PROPOSAL_THRESHOLD))
        L.append("")
        L.append("**沉淀经验**：")
        for i, s in enumerate(p["lessons"], 1):
            L.append("  %d. %s" % (i, s))
        if p["action_items"]:
            L.append("")
            L.append("**拟改动**：")
            for i, s in enumerate(p["action_items"], 1):
                L.append("  %d. %s" % (i, s))
        L.append("")
        L.append("**状态**：⏳ 待用户批准（批准后才写入 AGENT_TRADING_RULES.md）")
        L.append("")
        L.append("---")

    with open(PLAYBOOK, "a", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")

    print("")
    print("!! 触发 %d 条优化提案，已写入 PLAYBOOK.md 待批准区：" % len(new_props))
    for p in new_props:
        print("   - %s（%d 次）" % (p["cause"], p["count"]))


def cmd_stats():
    rv = load_reviewed()
    reviews = rv.get("reviews", [])
    if not reviews:
        print("暂无复盘记录")
        return 0

    cnt = {}
    pnl_by = {}
    for r in reviews:
        c = r.get("cause")
        cnt[c] = cnt.get(c, 0) + 1
        pnl_by[c] = pnl_by.get(c, 0.0) + _f(r.get("pnl_usdt"))

    print("=" * 74)
    print("归因分布 ｜ 累计复盘 %d 笔" % len(reviews))
    print("=" * 74)
    print("%-16s %6s %12s   %s" % ("归因类别", "次数", "累计盈亏", "状态"))
    print("-" * 74)
    for c, n in sorted(cnt.items(), key=lambda x: -x[1]):
        st = ""
        if n >= PROPOSAL_THRESHOLD:
            prop = next((p for p in rv.get("proposals", []) if p.get("cause") == c), None)
            st = ("提案已生成·%s" % (prop.get("status") if prop else "?")) if prop else "⚠ 应生成提案"
        print("%-16s %6d %12.2f   %s" % (c, n, pnl_by[c], st))
    print("-" * 74)

    viol = [r for r in reviews if not r.get("was_rule_compliant")]
    if viol:
        print("\n⚠ 违规交易 %d 笔（未遵守章程）：" % len(viol))
        for r in viol:
            print("   - %s : %s" % (r.get("key")[:40], r.get("rule_violation")))

    props = rv.get("proposals", [])
    if props:
        print("\n优化提案 %d 条：" % len(props))
        for p in props:
            print("   [%s] %s（%d 次）" % (p.get("status"), p.get("cause"), p.get("count")))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prepare", action="store_true")
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--stats", action="store_true")
    ap.add_argument("--input", default="")
    args = ap.parse_args()

    if args.prepare:
        return cmd_prepare()
    if args.commit:
        if not args.input:
            print("[review] --commit 需要 --input")
            return 2
        return cmd_commit(args.input)
    if args.stats:
        return cmd_stats()
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
