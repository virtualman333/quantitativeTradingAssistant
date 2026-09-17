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

登记表怎么读写（`state/order_idem_<轮次>.json`）：
    这张表是「本轮哪几笔单已经发过」的**唯一记录**，也是事后按 clOrdId 对账的索引，
    所以它与 `month_state.json` / `runtime.json` 走同一条规矩：

    - **写**一律经 `jsonstore.atomic_write_json`（半截文件是「读不出来」的成因）；
    - **读**一律经 `jsonstore.read_json_state_strict`：读不出来就**拒绝生成新 ID**
      （既不猜「没发过」，也不猜「发过」），原文件保持不动交给人工处置。
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta

# 状态文件读写的唯一底座（原子写 + 分得开「还没有文件」与「文件坏了」）。
# 登记表是 `state/` 下的 JSON，与 month_state / runtime 同一条规矩 —— 见 jsonstore 模块头。
import jsonstore

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
    """读本轮的登记表。**读不出来就抛 `jsonstore.StateUnreadable`**，绝不返回空表。

    为什么不能「读坏了就当空的」：这张表是「本轮哪几笔单已经发过」的**唯一记录**，
    而它管的是章程 §6.1 的幂等 —— 拿空表继续往下走，等于告诉调用方
    「本轮一笔都没发过」，于是同一个 `--seq` 会被再生成一个新 `clOrdId`
    （或反过来，事后按 clOrdId 对账时找不到那笔）。**「不知道」被伪装成「没有」**，
    正是本仓在 `runtime.json` 上反复踩的那个形状。

    文件不存在是另一回事（新轮次第一次发单），返回空表，允许初始化。
    """
    return jsonstore.read_json_state_strict(path, expect=list) or []


def save_rows(path, rows):
    """原子写。登记表与 `month_state.json` 同一条规矩：`state/` 下的 JSON 不是缓存。

    就地 `open(path, "w") + json.dump` 正是半截文件的成因，而半截文件在**读**那一侧
    会变成「这张表坏了」—— 于是「写不原子」与「读坏了当空的」两个毛病合起来，
    净效果是**一次写到一半就丢掉整轮的幂等记录**。
    """
    jsonstore.atomic_write_json(path, rows)


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
    rel = os.path.relpath(path, ROOT).replace("\\", "/")
    try:
        rows = load_rows(path)
    except jsonstore.StateUnreadable as e:
        # 登记表读不出来 = 「本轮发过哪几笔」无从得知。**一律拒绝**，包括 --list ——
        # 此前这条路会打印 `ok:true, count:0`，等于告诉对账的人「本轮没有已登记的 ID」，
        # 而真相是「不知道」。不知道就要说出来，代价是这一轮必须有人工介入（刻意不给
        # 逃生门：一个 --force 就能绕过的守卫，在真正着急下单的那天一定会被用掉）。
        print(json.dumps({
            "ok": False,
            "error": "幂等登记表读不出来：%s" % e.error,
            "record_file": rel,
            "action": "原文件保持不动（它是唯一的对账线索，不许覆盖）。请人工打开确认后，"
                      "改好它、或改名归档再重跑；在此之前不会生成也不会列出任何 clOrdId —— "
                      "读不到表就无法判断 --seq 是否已经发过（章程 §6.1 幂等）。",
        }, ensure_ascii=False, indent=2))
        return 3

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
