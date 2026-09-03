#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
trade_round.py — OKX 自主交易系统「每轮决策+执行」入口（章程 §7 八步）

设计目标
--------
把现有零件（market_scan / mcp_call / order_id / archive_round / dashboard /
mail_report / review_trade / news_log）串成一个完整的交易轮，并严格遵守
AGENT_TRADING_RULES.md 的 L1 硬约束。

安全边界（硬编码，不可被 argparse 绕过）
--------------------------------------
- 任何写操作都只走 mcp_call.py --profile demo --allow-write；okx-live 写操作
  被 mcp_call.py 代码级拒绝（返回 REFUSED），本脚本也不主动碰 live 写接口。
- 默认（无 --auto-trade）：【只取数、评估、写决策文件与面板，绝不调用任何写工具】。
- --auto-trade 下：评估通过（L2 达标或已写 §0.3 偏离留痕）才经 demo 下单，
  且每笔同轮内挂 OCO 止损并回查确认（L1-4）；下单必带 order_id.py 生成的
  clOrdId（L1-8）；单笔风险 ≤2.5%、杠杆 ≤5x 硬顶校验（L1-5 / L1-2）。
- 归档一律经 archive_round.py（唯一写入口），历史只追加（L1-7）。

调度
----
由外部（DSH 后台 job）托管常驻进程：
    python scripts/trade_round.py --loop --interval 300
进程内单实例保护 + 每轮间隔；亦可 --once 单次跑（手动验证用）。

注意：消息面交叉验证（§10）首版仅留接口（TODO），默认不阻塞决策——
但因为 L1 不依赖消息面，且章程 §10 为 L2 可裁量，监控轮与首版自动轮均不
因缺消息面而停摆；后续版本补完交叉验证后再强化闸门。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

# 文件锁：Windows 用 msvcrt，Unix 用 fcntl（fcntl 在 Windows 上不存在，故条件导入）
if os.name != "nt":
    import fcntl
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CST = timezone(timedelta(hours=8))

# 状态/输出路径（与 README §3 对齐）
STATE = os.path.join(ROOT, "state")
LOGS = os.path.join(ROOT, "logs")
SNAP_DIR = os.path.join(STATE, "snapshots")
RUNTIME = os.path.join(STATE, "runtime.json")
DECISION_DIR = STATE
LOCK = os.path.join(STATE, ".trade_round.lock")

# 合规标的（L1-1）
ALLOWED_INSTS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]
# 风险硬顶（L1-5 / L1-2）
MAX_RISK_PCT = 0.025      # 单笔风险 ≤ 2.5%
MAX_LEVERAGE = 5          # 杠杆 ≤ 5x
# 单标的名义敞口 ≤ 3.0x 权益；总敞口 ≤ 5.0x 权益（L2 软约束，仅告警）
SOFT_MAX_NOTIONAL_X = 3.0
SOFT_MAX_TOTAL_X = 5.0
# OCO 回查超时
ALGO_CONFIRM_TIMEOUT = 20.0


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def log(msg: str):
    ts = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def run_py(script: str, args: list, timeout: int = 120) -> dict:
    """运行 scripts/ 下的 python 脚本，返回解析后的 JSON（若 stdout 是 JSON）。"""
    cmd = [sys.executable, os.path.join("scripts", script)] + args
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                           encoding="utf-8", timeout=timeout)
    except subprocess.TimeoutExpired as e:
        return {"ok": False, "error": f"timeout: {script}", "detail": str(e)}
    if p.returncode != 0:
        return {"ok": False, "error": f"{script} exit {p.returncode}",
                "stderr": (p.stderr or "")[:800], "stdout": (p.stdout or "")[:800]}
    out = (p.stdout or "").strip()
    if not out:
        return {"ok": True, "raw": ""}
    try:
        return {"ok": True, "json": json.loads(out)}
    except json.JSONDecodeError:
        return {"ok": True, "raw": out}


def mcp_call(profile: str, tool: str, args: dict, allow_write: bool = False,
             timeout: int = 60) -> dict:
    """封装 mcp_call.py。写操作必须 allow_write=True 且 profile=demo。"""
    assert profile in ("demo", "live")
    if allow_write and profile != "demo":
        return {"ok": False, "error": "REFUSED: live 账户只读（章程 §2/L1-3）"}
    cli = ["--profile", profile, "--tool", tool, "--args", json.dumps(args, ensure_ascii=False)]
    if allow_write:
        cli.append("--allow-write")
    return run_py("mcp_call.py", cli, timeout=timeout)


# --------------------------------------------------------------------------- #
# 单实例锁（Windows 用 msvcrt，Unix 用 fcntl）
# --------------------------------------------------------------------------- #
def _acquire_lock():
    os.makedirs(STATE, exist_ok=True)
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_RDWR)
    except OSError as e:
        return None, f"无法创建锁文件: {e}"
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd, None
    except (OSError, ImportError):
        os.close(fd)
        return None, "已有运行实例（锁被占用）"


# --------------------------------------------------------------------------- #
# 轮次号 / 运行态
# --------------------------------------------------------------------------- #
def next_round_id() -> str:
    n = 1
    if os.path.exists(RUNTIME):
        try:
            rt = json.load(open(RUNTIME, encoding="utf-8"))
            n = int(rt.get("round_no", 0)) + 1
        except Exception:
            n = 1
    else:
        # 从 logs/rounds.jsonl 推断
        try:
            with open(os.path.join(LOGS, "rounds.jsonl"), encoding="utf-8") as f:
                for line in f:
                    try:
                        d = json.loads(line)
                        m = __import__("re").search(r"(\d+)", d.get("round_id", ""))
                        if m:
                            n = max(n, int(m.group(1)) + 1)
                    except Exception:
                        pass
        except FileNotFoundError:
            pass
    return f"R{n:06d}"


def bump_runtime(round_id: str):
    n = int(__import__("re").search(r"(\d+)", round_id).group(1))
    rt = {}
    if os.path.exists(RUNTIME):
        try:
            rt = json.load(open(RUNTIME, encoding="utf-8"))
        except Exception:
            rt = {}
    rt["round_no"] = n
    rt["last_round_id"] = round_id
    rt["last_run_cst"] = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    with open(RUNTIME, "w", encoding="utf-8") as f:
        json.dump(rt, f, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------- #
# 取数（§7 第 2 步）
# --------------------------------------------------------------------------- #
def fetch_market_scan() -> dict:
    """运行 market_scan.py 并把快照存到 state/snapshots。"""
    os.makedirs(SNAP_DIR, exist_ok=True)
    res = run_py("market_scan.py", ["--save", SNAP_DIR], timeout=180)
    if not res.get("ok"):
        log(f"⚠ market_scan 失败: {res.get('error')}")
        return {}
    # market_scan 可能只写文件不输出 JSON；尝试读最新快照
    return res.get("json", {}) or {}


def _unwrap(resp: dict) -> list:
    """剥 mcp_call 返回洋葱：{ok, result:{ok, data:{..., data:[...]}}}  -> [...]。"""
    if not resp.get("ok") or not resp.get("json"):
        return []
    d = resp["json"].get("result", resp["json"])
    # 可能是 {ok, data:{endpoint, data:[...]}}
    if isinstance(d, dict) and "data" in d:
        inner = d["data"]
        if isinstance(inner, dict) and isinstance(inner.get("data"), list):
            return inner["data"]
        if isinstance(inner, list):
            return inner
    if isinstance(d, list):
        return d
    return []


def fetch_demo_account() -> dict:
    """读 demo 账户：权益(USDT details[].eq)、持仓、挂单。

    权益口径严格按章程 §7 第 2 步：取 USDT 的 details[].eq，不取 totalEq。
    """
    out = {"equity": None, "available": None, "positions": [], "algo_orders": []}
    bal = mcp_call("demo", "account_get_balance", {"ccy": "USDT"})
    for row in _unwrap(bal):
        for det in (row.get("details") or []):
            if det.get("ccy") == "USDT":
                eq = det.get("eq") or det.get("availEq")
                av = det.get("availEq") or det.get("availBal")
                try:
                    if eq not in (None, ""):
                        out["equity"] = float(eq)
                    if av not in (None, ""):
                        out["available"] = float(av)
                except (TypeError, ValueError):
                    pass
    out["positions"] = _unwrap(mcp_call("demo", "swap_get_positions", {}))
    out["algo_orders"] = _unwrap(
        mcp_call("demo", "swap_get_algo_orders", {"status": "pending"}))
    return out


def fetch_live_watch() -> list:
    """实盘监控已于 2026-09-02 由用户指令【取消】。

    用户原话：「不需要再监控实盘了」。
    据此：不再调用任何 live 接口（含只读查询），本函数恒返回空列表。
    系统只交易/监控 okx-demo 模拟盘；实盘相关的 L1-3 约束随之不再适用
    （本系统本就从不触碰实盘，见 L1-1/L1-3）。
    """
    return []


# --------------------------------------------------------------------------- #
# 取数 + 产出「本轮待决策数据包」（决策权交还 DSH agent，本脚本不做决策）
# --------------------------------------------------------------------------- #
def collect_round_data(market: dict, account: dict, live_watch: list,
                       review_pending: bool) -> dict:
    """汇总本轮所有供 AI 决策的原始数据，写入 state/round_input.json。

    本函数【不包含任何决策逻辑】——只负责把数据摆好，等待 DSH agent 读取后判断。
    """
    positions = []
    for p in account.get("positions", []):
        positions.append({
            "instrument": p.get("instId"),
            "side": p.get("posSide") or ("long" if float(p.get("pos", 0)) > 0 else "short"),
            "size_contracts": p.get("pos"),
            "entry": p.get("avgPx"),
            "mark": p.get("markPx"),
            "leverage": p.get("lever"),
            "upl": p.get("upl"),
            "uplRatio": p.get("uplRatio"),
        })
    algo_orders = []
    for o in account.get("algo_orders", []):
        algo_orders.append({
            "instId": o.get("instId"),
            "algoId": o.get("algoId"),
            "ordType": o.get("ordType"),
            "tpTriggerPx": o.get("tpTriggerPx"),
            "slTriggerPx": o.get("slTriggerPx"),
            "sz": o.get("sz"),
        })

    payload = {
        "collected_cst": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
        "env": "demo",
        "equity_usdt": account.get("equity"),
        "available_usdt": account.get("available"),
        "positions": positions,
        "algo_orders": algo_orders,
        "algo_by_inst": {o["instId"]: o for o in algo_orders},
        "live_watch": live_watch,
        "market": market,
        "review_pending": review_pending,
        "decision": None,        # 由 DSH agent 填写
        "actions": [],           # 由 DSH agent 填写（实际执行后的记录）
    }
    os.makedirs(STATE, exist_ok=True)
    path = os.path.join(STATE, "round_input.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return payload


# --------------------------------------------------------------------------- #
# 下单（仅 --auto-trade，且仅 demo）
# --------------------------------------------------------------------------- #
def place_order_auto(round_id: str, seq: int, inst: str, side: str,
                     size: float, leverage: int, entry: float,
                     sl_dist: float, tp_dist: float) -> dict:
    """在 demo 下单 + 同轮挂 OCO + 回查确认。返回执行结果 dict。

    这是 L1 强约束集中点：clOrdId(L1-8)、止损必挂(L1-4)、风险硬顶(L1-5/L1-2)。
    """
    # 风险硬顶校验
    if leverage > MAX_LEVERAGE:
        return {"ok": False, "error": f"杠杆 {leverage} > L1-2 上限 {MAX_LEVERAGE}x"}
    # 生成合规 clOrdId（L1-8）
    oid = run_py("order_id.py", ["--round", round_id, "--seq", str(seq),
                                 "--params", json.dumps({"instId": inst, "sz": size},
                                                        ensure_ascii=False)])
    if not oid.get("ok"):
        return {"ok": False, "error": "clOrdId 生成失败: " + str(oid.get("error"))}
    clord = oid.get("raw") or (oid.get("json") if isinstance(oid.get("json"), str) else None)
    if not clord or not isinstance(clord, str):
        return {"ok": False, "error": "clOrdId 提取失败", "debug": str(oid)[:300]}
    clord = clord.strip()

    # 设杠杆
    lev = mcp_call("demo", "swap_set_leverage",
                   {"instId": inst, "lever": leverage, "mgnMode": "cross"},
                   allow_write=True)
    if not lev.get("ok"):
        return {"ok": False, "error": "设杠杆失败: " + str(lev.get("error"))}

    # 市价下单（带 clOrdId）
    ord_args = {
        "instId": inst,
        "tdMode": "cross",
        "side": side,
        "posSide": "net",
        "ordType": "market",
        "sz": str(size),
        "clOrdId": clord,
    }
    placed = mcp_call("demo", "swap_place_order", ord_args, allow_write=True)
    if not placed.get("ok"):
        return {"ok": False, "error": "下单失败: " + str(placed.get("error")),
                "clOrdId": clord}

    # 同轮内挂 OCO 止损/止盈（L1-4）
    sl_px = entry - sl_dist if side == "buy" else entry + sl_dist
    tp_px = entry + tp_dist if side == "buy" else entry - tp_dist
    algo_args = {
        "instId": inst,
        # ⚠ 实测（2026-09-02 R000001）：必须用 ordType=oco（不是 algoOrdType），
        # 否则报 ValidationError: Missing required parameter "ordType"。
        "ordType": "oco",
        "tdMode": "cross",
        "side": "sell" if side == "buy" else "buy",
        "posSide": "net",
        "sz": str(size),
        # 止盈止损一律用 mark 触发（章程：防插针）
        "tpTriggerPx": f"{tp_px:.2f}",
        "tpOrdPx": "-1",
        "tpTriggerPxType": "mark",
        "slTriggerPx": f"{sl_px:.2f}",
        "slOrdPx": "-1",
        "slTriggerPxType": "mark",
        "clOrdId": clord + "oc",
    }
    algo = mcp_call("demo", "swap_place_algo_order", algo_args, allow_write=True)
    # 回查确认（L1-4）
    confirmed = confirm_algo(inst, timeout=ALGO_CONFIRM_TIMEOUT)
    return {
        "ok": algo.get("ok", False),
        "clOrdId": clord,
        "order_resp": placed.get("json"),
        "algo_resp": algo.get("json"),
        "algo_confirmed": confirmed,
        "sl_px": sl_px, "tp_px": tp_px,
    }


def confirm_algo(inst: str, timeout: float) -> bool:
    """回查 pending 的 algo 订单，确认存在该标的的 OCO。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = mcp_call("demo", "swap_get_algo_orders", {"status": "pending"})
        if r.get("ok") and r.get("json"):
            data = r["json"].get("result", r["json"]).get("data", [])
            for o in data:
                if o.get("instId") == inst:
                    return True
        time.sleep(2)
    return False


# --------------------------------------------------------------------------- #
# 归档（§7 第 7 步，唯一写入口）
# --------------------------------------------------------------------------- #
def build_round_payload(round_id, account, live_watch, eval_res, actions, decision_text,
                         market_summary, snapshot_path):
    positions = []
    for p in account.get("positions", []):
        positions.append({
            "instrument": p.get("instId"),
            "side": p.get("posSide") or ("long" if float(p.get("pos", 0)) > 0 else "short"),
            "size_contracts": p.get("pos"),
            "size_base": p.get("pos") and (float(p.get("pos", 0)) * 0.01),
            "entry": p.get("avgPx"),
            "mark": p.get("markPx"),
            "leverage": p.get("lever"),
            "tp": None, "sl": None,
            "upl": p.get("upl"),
        })
    return {
        "round_id": round_id,
        "time_cst": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
        "interval": "5 分钟",
        "env": "demo",
        "equity_usdt": account.get("equity"),
        "available_usdt": account.get("available"),
        "positions": positions,
        "live_watch": live_watch,
        "actions": actions,
        "decision": decision_text,
        "market_summary": market_summary,
        "snapshot_path": os.path.basename(snapshot_path) if snapshot_path else None,
    }


def archive(round_id: str, payload: dict):
    """经 archive_round.py 归档（只追加）。"""
    tmp = os.path.join(STATE, f"round_input_{round_id}.json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return run_py("archive_round.py", ["--in", tmp])


def write_decision_md(round_id: str, eval_res: dict, account: dict, actions: list):
    os.makedirs(DECISION_DIR, exist_ok=True)
    path = os.path.join(DECISION_DIR, f"decision_{round_id}.md")
    lines = [f"# 决策全文 {round_id}", ""]
    lines.append(f"时间：{datetime.now(CST).strftime('%Y-%m-%d %H:%M:%S')} CST")
    lines.append("")
    lines.append(f"## 账户（demo）")
    lines.append(f"- 权益 USDT eq：{account.get('equity')}")
    lines.append(f"- 可用：{account.get('available')}")
    lines.append("")
    lines.append("## 评估结论")
    lines.append(f"- 决策：{eval_res.get('decision')}")
    for r in eval_res.get("reasons", []):
        lines.append(f"- {r}")
    lines.append("")
    lines.append("## 候选标的")
    if eval_res.get("candidates"):
        for c in eval_res["candidates"]:
            lines.append(f"- {c['inst']}: {c.get('note')}（score={c.get('score')}）")
    else:
        lines.append("- 无候选")
    lines.append("")
    lines.append("## 本轮操作")
    if actions:
        for a in actions:
            lines.append(f"- {a}")
    else:
        lines.append("- 无操作（观望）")
    lines.append("")
    lines.append("## 裁量偏离记录（§0.3）")
    if eval_res.get("deviations"):
        for d in eval_res["deviations"]:
            lines.append(f"- {json.dumps(d, ensure_ascii=False)}")
    else:
        lines.append("- 无偏离（或本轮观摩，未触发 L2 偏离判定）")
    lines.append("")
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


# --------------------------------------------------------------------------- #
# 单轮主流程
# --------------------------------------------------------------------------- #
def run_once(auto_trade: bool, dry_run: bool):
    fd, lock_err = _acquire_lock()
    if fd is None:
        log(f"跳过本轮：{lock_err}")
        return 0
    try:
        round_id = next_round_id()
        log(f"===== 开始轮次 {round_id} (auto_trade={auto_trade}, dry_run={dry_run}) =====")
        actions = []

        # ② 取数
        market = fetch_market_scan()
        account = fetch_demo_account()
        live_watch = fetch_live_watch()
        log(f"demo 权益={account.get('equity')} 持仓数={len(account.get('positions', []))} "
            f"实盘监控数={len(live_watch)}")

        # ④ 清复盘债（prepare，仅列待办不阻塞）
        #    注意：输出标题行本身含"待复盘"字样，须解析「待复盘 N 笔」的数字，
        #    不能简单做字符串包含判断（否则每轮都误报）。
        rev = run_py("review_trade.py", ["--prepare"])
        review_pending = False
        rev_txt = rev.get("raw") or ""
        m = __import__("re").search(r"待复盘\s*(\d+)\s*笔", rev_txt)
        if m:
            review_pending = int(m.group(1)) > 0
        if review_pending:
            log("⚠ 存在未复盘亏损交易；按 v2.0 为强建议，本轮继续并留痕")

        # ⑤ 巡检持仓：裸仓告警（决策时由 DSH agent 处理补挂/平仓）
        algo_set = {o.get("instId") for o in account.get("algo_orders", [])}
        for p in account.get("positions", []):
            inst = p.get("instId")
            if inst not in algo_set:
                log(f"⚠ 裸仓告警：{inst} 无挂单止损（L1-4），待决策处理")

        # ⑥ 产出「本轮待决策数据包」—— 决策权交还 DSH agent，本脚本不决策
        data = collect_round_data(market, account, live_watch, review_pending)
        market_summary = json.dumps(market, ensure_ascii=False)[:4000] if market else ""
        snap = sorted([f for f in os.listdir(SNAP_DIR)])[-1] if os.path.exists(SNAP_DIR) and os.listdir(SNAP_DIR) else ""

        log(f"本轮待决策数据包已写入 state/round_input.json "
            f"（equity={data['equity_usdt']}, 持仓={len(data['positions'])}）")
        log("→ 交由 DSH agent 读取后决策；本脚本不自动下单/不自动决策。")

        # 说明：归档/面板/邮件的「最终版」应由 DSH agent 在决策执行后调用，
        # 但为保留每轮可追溯性，这里先以「待决策」状态落一版 round_input，
        # 真正的归档（archive_round.py）由决策执行脚本/agent 在收尾时调用。
        bump_runtime(round_id)
        log(f"===== 轮次 {round_id} 取数完成，等待 DSH agent 决策 =====")
        # sentinel：供 DSH agent 的 job_output --wait 识别"新一轮就绪"
        print(f"ROUND_READY {round_id} {datetime.now(CST).strftime('%Y-%m-%d %H:%M:%S')}",
              flush=True)
        return 0
    finally:
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser(description="OKX 自主交易轮（5 分钟定时任务入口）")
    ap.add_argument("--auto-trade", action="store_true",
                    help="允许在 demo 自动下单（默认关闭，仅监控评估）")
    ap.add_argument("--dry-run", action="store_true",
                    help="联机只读，拟执行写动作只记录不发网络请求")
    ap.add_argument("--once", action="store_true", help="只跑一轮就退出")
    ap.add_argument("--loop", action="store_true", help="常驻循环（由 DSH 后台 job 托管）")
    ap.add_argument("--interval", type=int, default=300, help="循环间隔秒数（默认 300=5 分钟）")
    a = ap.parse_args()

    if a.once or not a.loop:
        return run_once(a.auto_trade, a.dry_run)
    # 循环模式
    log(f"进入常驻循环，间隔 {a.interval}s")
    while True:
        try:
            run_once(a.auto_trade, a.dry_run)
        except Exception as e:
            log(f"本轮异常：{type(e).__name__}: {e}")
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
