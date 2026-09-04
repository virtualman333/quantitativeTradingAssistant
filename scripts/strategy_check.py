#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
strategy_check.py — LLM 生成/人工编辑策略的「内置规则」校验（保存前 gate）

校验：
  1. 语法（py_compile）
  2. 存在 signal(ctx) 函数
  3. 用真实规模样例 ctx 冒烟调用一次，返回必须合法（direction ∈ long/short/flat）
  4. 顶层代码安全检查：不允许 import 网络/进程/文件等危险模块（回测/实盘只想要纯计算）

用法：
  python scripts/strategy_check.py --dir agent/strategies/<id>
输出 JSON {ok, errors[], warnings[], functions[], sample}
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import py_compile
import sys

# 本地策略只允许纯计算；这些模块说明策略越界了（可能要外联/读盘/写盘）
FORBIDDEN_IMPORTS = {
    "os", "subprocess", "socket", "requests", "urllib", "http",
    "pathlib", "shutil", "pickle", "sqlite3", "shelve", "ctypes",
    "ftplib", "smtplib", "telnetlib", "paramiko", "asyncio", "multiprocessing", "threading",
    "json",  # 无需 IO，禁止避免探测路径
    "sys",
}

# 允许的顶级 import：纯数学/统计/集合操作
ALLOWED_TOP = {"math", "statistics", "collections", "itertools", "functools", "operator", "random", "bisect"}

BANNED_SNIPPETS = [
    "open(",
    "__import__",
    "eval(",
    "exec(",
    "compile(",
    "importlib",
    "socket.",
    "subprocess",
]


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="策略目录（含 strategy.py）")
    args = ap.parse_args()

    errors: list[str] = []
    warnings: list[str] = []
    py = os.path.join(args.dir, "strategy.py")

    if not os.path.isfile(py):
        errors.append(f"未找到 {py}")
    else:
        # 1) 语法
        try:
            py_compile.compile(py, doraise=True)
        except py_compile.PyCompileError as exc:
            errors.append(f"语法错误: {exc}")

        # 2) 静态红线扫描（在 AST 编译之上再做文本扫描，兼容 try/except import 绕过）
        try:
            src = open(py, "r", encoding="utf-8").read()
        except OSError as exc:
            errors.append(f"读取失败: {exc}")
            src = ""

        import ast
        if src:
            try:
                tree = ast.parse(src)
            except SyntaxError as exc:
                errors.append(f"AST 解析失败: {exc}")
                tree = None
            if tree is not None:
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        for a in node.names:
                            top = (a.name or "").split(".")[0]
                            if top in FORBIDDEN_IMPORTS:
                                errors.append(f"禁止 import {top}（策略只允许纯计算）")
                            elif top not in ALLOWED_TOP:
                                warnings.append(f"import {top} 未在白名单内，请只用纯计算库")
                    elif isinstance(node, ast.ImportFrom):
                        top = (node.module or "").split(".")[0]
                        if top in FORBIDDEN_IMPORTS:
                            errors.append(f"禁止 import {top}（策略只允许纯计算）")
                        elif top not in ALLOWED_TOP:
                            warnings.append(f"import {top} 未在白名单内，请只用纯计算库")
            for s in BANNED_SNIPPETS:
                if s in src:
                    errors.append(f"出现危险调用片段: {s}")

        # 3) 冒烟执行
        if not errors:
            try:
                spec = importlib.util.spec_from_file_location("check_strategy", py)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"加载失败: {exc}")
                mod = None
            if not errors and not callable(getattr(mod, "signal", None)):
                errors.append("必须定义函数 signal(ctx)（返回 direction/reason）")
            if not errors:
                import math
                n = 120
                base = 60000.0
                closes, highs, lows, vols = [], [], [], []
                for i in range(n):
                    drift = math.sin(i / 7) * 60 + (i % 11) * 3.0
                    c = base + drift
                    closes.append(round(c, 2))
                    highs.append(round(c + abs(math.cos(i / 3)) * 40 + 5, 2))
                    lows.append(round(c - abs(math.sin(i / 5)) * 40 - 5, 2))
                    vols.append(round(80 + abs(math.sin(i / 4)) * 220, 2))
                ts = [1700000000000 + i * 60000 for i in range(n)]
                ctx = {
                    "ts": ts, "closes": closes, "highs": highs, "lows": lows, "vols": vols,
                    "n": n, "atr": 30.0, "price": closes[-1], "error": None,
                }
                try:
                    out = mod.signal(ctx)
                    if not isinstance(out, dict):
                        errors.append(f"signal 返回类型应为 dict，实际 {type(out).__name__}")
                    else:
                        d = str(out.get("direction", "")).lower()
                        if d not in ("long", "short", "flat"):
                            errors.append(f"direction 必须是 long/short/flat，实际 {out.get('direction')!r}")
                        fn_names = [x for x in dir(mod) if not x.startswith("_")]
                        print(json.dumps({
                            "ok": len(errors) == 0,
                            "errors": errors,
                            "warnings": warnings,
                            "functions": fn_names,
                            "sample": {"direction": out.get("direction"), "reason": str(out.get("reason", ""))[:120]},
                        }, ensure_ascii=False, indent=2))
                        return 0 if len(errors) == 0 else 1
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"冒烟调用 signal 失败: {exc}")

    print(json.dumps({
        "ok": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "functions": [],
        "sample": None,
    }, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
