#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
factor_analysis.py — 因子归因（消融测试）

目的：逐一把策略里的过滤因子「关掉」，观察绩效变化，判断每个因子是
「有 alpha（该保留）」还是「拖累（该砍掉）」。

判读方法：
  - 关掉某因子后 PF / 总收益显著变差 → 该因子有效，保留。
  - 关掉某因子后 PF / 总收益变好 → 该因子在拖累，应放宽或移除。
  - 「仅共振分」是基准：只靠共振分方向、不加任何过滤的表现。

用法：
  python scripts/factor_analysis.py --hours 720
"""

from __future__ import annotations

import argparse
import sys

import backtest as bt

VARIANTS = [
    ("完整策略", {}),
    ("去趋势过滤", {"trend": False}),
    ("去量比过滤", {"vol": False}),
    ("去区间过滤", {"range": False}),
    ("仅共振分", {"trend": False, "vol": False, "range": False}),
]


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--inst", action="append", help="标的，可重复；默认 BTC+ETH")
    ap.add_argument("--hours", type=int, default=720, help="回测窗口（小时）")
    args = ap.parse_args()

    insts = args.inst or bt.DEFAULT_INSTS
    for inst in insts:
        print(f"\n===== {inst}（近 {args.hours} 小时）=====")
        print(f"{'变体':<10}{'笔数':>5}{'胜率%':>8}{'PF':>7}{'总收益%':>9}{'回撤%':>8}")
        print("-" * 50)
        for name, flt in VARIANTS:
            r = bt.backtest(inst, args.hours, flt)
            wr = f"{r['winRate']:.1f}" if r["winRate"] is not None else "-"
            pf = f"{r['profitFactor']:.2f}" if r["profitFactor"] is not None else "-"
            print(f"{name:<10}{r['trades']:>5}{wr:>8}{pf:>7}{r['totalPnlPct']:>9}{r['maxDrawdownPct']:>8}")
    print()


if __name__ == "__main__":
    main()
