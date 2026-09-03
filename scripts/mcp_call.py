#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mcp_call.py — 直连 okx-trade-mcp 的 stdio JSON-RPC 桥接器（MCP 连接器不可用时的降级通道）

用途：当 MCP 连接器（mcp__okx-demo__* / mcp__okx-live__*）在当前会话未暴露为工具时，
本脚本通过 spawn `okx-trade-mcp --profile <demo|live>` 子进程，用 MCP 协议（JSON-RPC 2.0 over
stdio）调用其工具，从而保证交易系统仍能拿到真实账户数据。

设计约束（安全）：
- 默认启用服务端 `--read-only` 开关（禁用所有写操作），防止误下单。
- 需要下单/平仓/挂单时必须显式传 --allow-write，且必须走 --profile demo。
- live profile 强制只读，任何写操作一律拒绝（章程 §2：实盘账户只读）。

用法：
  # 列出该 profile 暴露的全部工具
  # 只读模式下会在 stderr 额外报告「被隐藏的写工具」数量，stdout 始终保持纯 JSON
  # （提示走 stderr 是为了不破坏现有 json.load(sys.stdin) 的调用方）
  python scripts/mcp_call.py --profile demo --list-tools
  python scripts/mcp_call.py --profile demo --list-tools --no-probe   # 跳过探测，省一次子进程启动

  # 只读调用
  python scripts/mcp_call.py --profile demo --tool account_get_balance --args '{"ccy":"USDT"}'
  python scripts/mcp_call.py --profile demo --tool swap_get_positions
  python scripts/mcp_call.py --profile demo --tool swap_get_algo_orders --args '{"status":"pending"}'

  # 写操作（仅 demo）
  python scripts/mcp_call.py --profile demo --allow-write --tool swap_set_leverage --args '{...}'
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

SERVER = "okx-trade-mcp"
READ_TOOLS = {
    # 明确只读的工具白名单（用于 --read-only 之外的二次校验）
    "account_get_balance", "account_get_positions", "account_get_account",
    "swap_get_positions", "swap_get_algo_orders", "swap_get_orders",
    "swap_get_fills", "swap_get_ticker", "swap_get_candles",
    "market_get_ticker", "market_get_candles",
}
WRITE_TOOLS = {
    "swap_place_order", "swap_place_algo_order", "swap_cancel_algo_order",
    "swap_cancel_order", "swap_close_position", "swap_set_leverage",
    "swap_set_margin_mode", "swap_place_batch_orders",
}


def resolve_server():
    """Windows 下 okx-trade-mcp 是 .cmd 垫片，Popen 直接调用会 FileNotFoundError。"""
    if os.name != "nt":
        return SERVER
    for cand in ("okx-trade-mcp.cmd", "okx-trade-mcp.ps1", "okx-trade-mcp"):
        p = shutil.which(cand)
        if p:
            return p
    raise RuntimeError("未找到 okx-trade-mcp，请确认已 npm install -g @okx_retail/okx-trade-mcp")


def spawn(profile, read_only):
    exe = resolve_server()
    args = [exe, "--profile", profile, "--modules", "all"]
    if read_only:
        args.append("--read-only")
    env = dict(os.environ)
    env.setdefault("OKX_TIMEOUT_MS", "20000")
    # Windows 下 .cmd 需要 shell=True；PATH 中可能有空格，统一加引号
    cmd = subprocess.list2cmdline([a if a == exe else a for a in args])
    return subprocess.Popen(
        cmd if os.name == "nt" else args,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", bufsize=1, env=env, shell=(os.name == "nt"),
    )


def rpc(proc, method, params=None, timeout=30):
    """发送单条 JSON-RPC 请求并读取到匹配的响应（跳过 notification）。"""
    msg = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        msg["params"] = params
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("server closed stdout")
        line = line.strip()
        if not line:
            continue
        try:
            resp = json.loads(line)
        except json.JSONDecodeError:
            continue  # 非 JSON 行（如 npm 更新提示）跳过
        if isinstance(resp, dict) and resp.get("id") == 1:
            return resp


def close_proc(proc):
    """统一收尾：关 stdin → terminate → 超时则 kill。"""
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()


def open_session(profile, allow_write):
    """起一个已完成 initialize 握手的会话，返回 proc。"""
    proc = spawn(profile, not allow_write)
    try:
        rpc(proc, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "okx-trader-cli", "version": "1.0"},
        })
        proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()
    except Exception:
        close_proc(proc)
        raise
    return proc


def probe_full_tools(profile):
    """用 --allow-write 模式另起会话，取该 profile 的完整工具名列表。

    仅用于计算「只读模式下隐藏了多少写工具」。live profile 永不调用
    （live 的写操作是永久禁止的，不存在可用参数解锁的语义）。
    """
    if profile != "demo":
        return None
    proc = open_session(profile, allow_write=True)
    try:
        resp = rpc(proc, "tools/list")
        return [t.get("name") for t in resp.get("result", {}).get("tools", [])]
    finally:
        close_proc(proc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True, choices=["demo", "live"])
    ap.add_argument("--tool")
    ap.add_argument("--args", default="{}")
    ap.add_argument("--list-tools", action="store_true")
    ap.add_argument("--allow-write", action="store_true",
                    help="允许写操作（仅 demo 生效；live 永远拒绝）")
    ap.add_argument("--no-probe", action="store_true",
                    help="--list-tools 时跳过「隐藏写工具数量」探测（省一次子进程启动）")
    a = ap.parse_args()

    if a.profile == "live" and a.allow_write:
        print(json.dumps({"ok": False, "error":
              "REFUSED: live 账户只读（章程 §2），本脚本拒绝一切实盘写操作"},
              ensure_ascii=False))
        return 2

    read_only = not a.allow_write
    proc = open_session(a.profile, a.allow_write)
    try:
        if a.list_tools:
            resp = rpc(proc, "tools/list")
            tools = resp.get("result", {}).get("tools", [])
            names = [t.get("name") for t in tools]
            payload = {"ok": True, "tools": [
                {"name": t.get("name"), "desc": (t.get("description") or "")[:90]}
                for t in tools]}

            # P006：让「被隐藏的写工具」可观测 —— 不可观测的边界等于不存在的边界
            if a.profile == "live":
                payload["hidden_write_tools"] = []
                payload["_notice"] = ("live 账户永久只读（章程 §2）：写操作已被代码级拒绝，"
                                      "不存在可用参数解锁的写工具。")
            elif a.allow_write:
                payload["hidden_write_tools"] = []
                payload["_notice"] = ("当前为 --allow-write 模式：已列出全部 %d 个工具（含写操作）。"
                                      % len(names))
            else:
                hidden, probe_err = [], None
                if a.no_probe:
                    probe_err = "已用 --no-probe 跳过探测"
                else:
                    try:
                        full = probe_full_tools("demo")
                        hidden = sorted(n for n in set(full or []) - set(names) if n)
                    except Exception as e:            # 探测失败不得影响主输出
                        probe_err = str(e)[:120]
                payload["hidden_write_tools"] = hidden
                if probe_err:
                    payload["_notice"] = ("当前为 --read-only 模式，写操作工具未列出"
                                          "（隐藏数量探测失败：%s）。加 --allow-write 查看完整工具。"
                                          % probe_err)
                else:
                    payload["_notice"] = ("当前为 --read-only 模式，已隐藏 %d 个写操作工具：%s\n"
                                          "查看完整工具请加 --allow-write（仅 demo 生效；live 永远拒绝写操作）。"
                                          % (len(hidden), "、".join(hidden) if hidden else "无"))

            # stdout 保持纯 JSON（现有调用方一律 json.load(sys.stdin)），提示走 stderr
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            if payload.get("_notice"):
                print(payload["_notice"], file=sys.stderr)
            return 0

        if not a.tool:
            print(json.dumps({"ok": False, "error": "需指定 --tool 或 --list-tools"},
                             ensure_ascii=False))
            return 2

        if a.tool in WRITE_TOOLS and not a.allow_write:
            print(json.dumps({"ok": False, "error":
                  f"REFUSED: {a.tool} 是写操作，需显式 --allow-write"},
                  ensure_ascii=False))
            return 2

        params = json.loads(a.args) if a.args else {}
        resp = rpc(proc, "tools/call", {"name": a.tool, "arguments": params})
        if "error" in resp:
            print(json.dumps({"ok": False, "error": resp["error"]},
                             ensure_ascii=False, indent=2))
            return 1
        result = resp.get("result", {})
        # MCP content 结构：[{type:"text", text:"<json string>"}]
        out = result.get("content")
        if isinstance(out, list):
            texts = []
            for c in out:
                if c.get("type") == "text":
                    t = c.get("text", "")
                    try:
                        texts.append(json.loads(t))
                    except (json.JSONDecodeError, TypeError):
                        texts.append(t)
            out = texts[0] if len(texts) == 1 else texts
        print(json.dumps({"ok": True, "tool": a.tool,
                          "isError": result.get("isError", False),
                          "result": out}, ensure_ascii=False, indent=2))
        return 0
    finally:
        close_proc(proc)


if __name__ == "__main__":
    sys.exit(main())
