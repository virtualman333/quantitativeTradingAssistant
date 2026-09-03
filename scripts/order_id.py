#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
order_id.py — 订单幂等 ID 生成器（章程 §6.1，提案 P005 于 2026-09-02 经用户批准）

为什么需要幂等 ID：
    下单请求超时时，调用方无法区分「交易所未受理」与「已受理但响应丢失」。
    没有幂等 ID，只能在「重试 → 重复建仓」与「不重试 → 漏单」之间二选一 ——
    两者都直接违反章程 §5 仓位纪律。

为什么交给脚本而不是 AI 手写：
    OKX 的 clOrdId 只允许 ^[A-Za-z][A-Za-z0-9]{0,31}$，下划线与连字符一律被拒。
    2026-09-02 对照实验：omt1a 下单成功 / omt_1a 返回 "All operations failed"，
    唯一变量就是那个下划线。AI 手写 ID 极易再次踩坑，
    因此把格式约束固化进代码，比写进章程靠自觉可靠。

用法：
  # 生成并登记一个幂等 ID（同时追加写入 state/order_idem_<round_id>.json）
  python scripts/order_id.py --round R000004 --seq 1
  python scripts/order_id.py --round R000004 --seq 2 --params '{"instId":"ETH-USDT-SWAP","sz":"10"}'

  # 只校验格式，不登记（AI 手写 ID 前的自检）
  python scripts/order_id.py --verify okxr4n1t283145

  # 列出本轮已登记的全部 ID（事后对账用）
  python scripts/order_id.py --round R000004 --list

幂等重试约定（章程 §6.1）：
    请求超时 / 网络异常时，必须用**同一个 clOrdId** 重试，不得改用新 ID，也不得直接放弃。
    重试后用 swap_get_orders 按 clOrdId 回查，确认实际成交笔数，避免重复建仓。
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, "state")
CST = timezone(timedelta(hours=8))

# OKX 规范：字母开头，仅字母数字，最长 32 位
PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,31}$")


def round_num(round_id):
    """R000004 -> 4"""
    m = re.search(r"(\d+)\s*$", round_id or "")
    return int(m.group(1)) if m else 0


def gen_id(round_id, seq):
    """生成合规 clOrdId：okx + r<轮次> + n<本轮序号> + t<unix 时间戳末 6 位>"""
    tail = str(int(time.time()))[-6:]
    cid = "okxr%dn%dt%s" % (round_num(round_id), seq, tail)
    if not PATTERN.match(cid):
        raise ValueError("生成的 ID 不符合 OKX 规范: %r" % cid)
    if len(cid) > 32:
        raise ValueError("生成的 ID 超过 32 字符: %r" % cid)
    return cid


def record_path(round_id):
    return os.path.join(STATE, "order_idem_%s.json" % round_id)


def load_rows(path):
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_rows(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)


def main():
    ap = argparse.ArgumentParser(description="OKX 订单幂等 ID 生成与校验（章程 §6.1）")
    ap.add_argument("--round", help="轮次 ID，如 R000004")
    ap.add_argument("--seq", type=int, help="本轮内第几笔（从 1 开始）")
    ap.add_argument("--params", default="{}",
                    help="预期下单参数 JSON，一并登记用于事后对账")
    ap.add_argument("--verify", help="只校验一个 ID 的格式，不登记")
    ap.add_argument("--list", action="store_true", help="列出该轮次已登记的 ID")
    ap.add_argument("--force", action="store_true",
                    help="同 round+seq 已存在时仍生成新 ID（默认拒绝，防手滑重复下单）")
    a = ap.parse_args()

    # 模式一：仅校验格式
    if a.verify:
        cid = a.verify
        ok = bool(PATTERN.match(cid)) and len(cid) <= 32
        reason = ""
        if not ok:
            if len(cid) > 32:
                reason = "长度 %d > 32" % len(cid)
            elif not cid[:1].isalpha():
                reason = "首字符必须是字母"
            else:
                bad = sorted(set(ch for ch in cid if not ch.isalnum()))
                reason = "含非法字符：%s（OKX 仅允许字母数字，禁止 _ - 等）" % "、".join(bad)
        print(json.dumps({"ok": ok, "clOrdId": cid, "reason": reason or "格式合规"},
                         ensure_ascii=False, indent=2))
        return 0 if ok else 2

    if not a.round:
        print(json.dumps({"ok": False, "error": "需指定 --round（或改用 --verify 校验）"},
                         ensure_ascii=False))
        return 2

    path = record_path(a.round)
    rows = load_rows(path)

    # 模式二：列出本轮已登记 ID
    if a.list:
        print(json.dumps({"ok": True, "round_id": a.round, "count": len(rows),
                          "records": rows}, ensure_ascii=False, indent=2))
        return 0

    # 模式三：生成并登记
    if a.seq is None:
        print(json.dumps({"ok": False, "error": "需指定 --seq（本轮内第几笔，从 1 开始）"},
                         ensure_ascii=False))
        return 2

    dup = [r for r in rows if r.get("seq") == a.seq]
    if dup and not a.force:
        print(json.dumps({
            "ok": False,
            "error": "--round %s --seq %d 已登记过 ID %s。超时重试必须用**同一个 ID**，"
                     "不要生成新 ID；确属新订单请改用更大的 --seq，或加 --force 覆盖。"
                     % (a.round, a.seq, dup[-1].get("clOrdId")),
            "existing": dup[-1],
        }, ensure_ascii=False, indent=2))
        return 2

    try:
        params = json.loads(a.params) if a.params else {}
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": "--params 不是合法 JSON: %s" % e},
                         ensure_ascii=False))
        return 2

    try:
        cid = gen_id(a.round, a.seq)
    except ValueError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1

    rec = {
        "clOrdId": cid,
        "round_id": a.round,
        "seq": a.seq,
        "created_cst": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
        "params": params,
        "status": "issued",      # issued → filled / cancelled，事后由 AI 回查更新
        "ordId": None,
    }
    rows.append(rec)
    save_rows(path, rows)

    print(json.dumps({"ok": True, "clOrdId": cid, "round_id": a.round, "seq": a.seq,
                      "record_file": os.path.relpath(path, ROOT).replace("\\", "/"),
                      "note": "超时重试必须复用同一 clOrdId；事后用 swap_get_orders 按 clOrdId "
                              "回查成交笔数，确认未重复建仓。"},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
