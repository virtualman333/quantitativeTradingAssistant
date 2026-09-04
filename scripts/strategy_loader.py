#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
strategy_loader.py — 超短线自定义策略加载器（回测引擎 / 实盘信号引擎共用）

策略 = 一个 Python 文件 strategy.py，位于 agent/strategies/<id>/ 下，
必须导出一个函数：

    def signal(ctx: dict) -> dict:
        # ctx 字段（全部是「已收盘」历史，杜绝未来函数）：
        #   ts     : list[int]    每根 1m K 线开盘毫秒时间戳（升序，含当前根）
        #   closes : list[float]  收盘价（含当前根）
        #   highs  : list[float]  最高价
        #   lows   : list[float]  最低价
        #   vols   : list[float]  成交量
        #   n      : int          「当前已收盘根数」= len(closes)；
        #                        回测逐根回放时 n 从 warmup 递增到全量，
        #                        实盘一次给最近 120 根、n = len(closes)。
        #                        想只看最近 k 根：closes[n-k:n]
        #   atr    : float        当前 1m ATR(14)（截至当前根）
        #   price  : float        当前根收盘价
        # 返回 dict（direction 必填，其余可选）：
        #   {"direction": "long"|"short"|"flat",
        #    "reason": "一句话中文依据",
        #    "atr_mult": 2.5,   # 可选：覆盖默认止损距离 = ATR × 该系数
        #    "rr": 2.0,         # 可选：覆盖默认止盈/止损盈亏比（夹 [1.2, 5.0]）
        #    "sl": 59800.0,     # 可选：自定义止损价（绝对点位，以 ctx.price 为参照计算）
        #    "tp": 60400.0}     # 可选：自定义止盈价；与 sl 同时给出时引擎直接采用
        #                       #（回测/实盘一致生效），未给则回退 atr_mult / rr 推导。

        引擎安全兜底：signal 抛任何异常都按 flat 处理（只记录错误，绝不破坏引擎/下单）；
        direction 不在合法集合内一律 flat；atr_mult / rr 由引擎夹到安全区间；
        sl/tp 点位须与 direction 一致（多单 sl < price < tp，空单反之），否则回退默认距离。
        """
from __future__ import annotations

import importlib.util
import json
import os
import sys
import types

VALID_DIRS = {"long", "short", "flat"}
DEFAULT_ATR_MULT_RANGE = (0.3, 20.0)
DEFAULT_RR_RANGE = (1.2, 5.0)


def load_strategy(strategy_dir: str | None) -> types.ModuleType | None:
    """加载策略目录下的 strategy.py。strategy_dir 为空/不存在 → 返回 None（引擎用内置规则）。"""
    if not strategy_dir:
        return None
    py = os.path.join(strategy_dir, "strategy.py")
    if not os.path.isfile(py):
        raise RuntimeError(f"策略文件不存在: {py}")
    try:
        spec = importlib.util.spec_from_file_location("user_strategy", py)
        if spec is None or spec.loader is None:
            raise RuntimeError("无法创建策略模块")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"加载策略失败: {exc}") from exc
    if not callable(getattr(mod, "signal", None)):
        raise RuntimeError("策略必须定义 signal(ctx) 函数")
    return mod


def call_signal(mod: types.ModuleType | None, ctx: dict) -> dict:
    """调用策略 signal，做格式/数值兜底。无策略模块时返回 None（调用方按内置规则处理）。"""
    if mod is None:
        return {"direction": None, "reason": "", "atr_mult": None, "rr": None}
    try:
        raw = mod.signal(ctx)
    except Exception as exc:  # noqa: BLE001
        return {
            "direction": "flat",
            "reason": f"策略执行异常已按观望处理: {exc}",
            "atr_mult": None,
            "rr": None,
            "error": str(exc),
        }
    if not isinstance(raw, dict):
        return {
            "direction": "flat",
            "reason": "策略返回非 dict，已按观望处理",
            "atr_mult": None,
            "rr": None,
            "error": f"非 dict: {type(raw).__name__}",
        }
    direction = str(raw.get("direction", "")).strip().lower()
    if direction not in VALID_DIRS:
        direction = "flat"
    reason = str(raw.get("reason", "")).strip() or ("观望" if direction == "flat" else direction)
    atr_mult = raw.get("atr_mult")
    if atr_mult is not None:
        try:
            atr_mult = float(atr_mult)
            atr_mult = max(DEFAULT_ATR_MULT_RANGE[0], min(atr_mult, DEFAULT_ATR_MULT_RANGE[1]))
        except (TypeError, ValueError):
            atr_mult = None
    rr = raw.get("rr")
    if rr is not None:
        try:
            rr = float(rr)
            rr = max(DEFAULT_RR_RANGE[0], min(rr, DEFAULT_RR_RANGE[1]))
        except (TypeError, ValueError):
            rr = None
    # 自定义止盈止损点位（绝对价）。flat 时点位无意义 → 置 None
    sl = tp = None
    if direction != "flat":
        sl = raw.get("sl")
        tp = raw.get("tp")
        sl = _to_num(sl)
        tp = _to_num(tp)
    return {
        "direction": direction,
        "reason": reason,
        "atr_mult": atr_mult,
        "rr": rr,
        "sl": sl,
        "tp": tp,
    }


def _to_num(v) -> float | None:
    """把策略返回的数值字段转 float；缺失 / 非数值 / NaN → None。"""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # 过滤 NaN


def resolve_stops(direction: str, ref: float, sig: dict | None,
                  fallback_sl_dist: float, fallback_rr: float):
    """按 direction 定下止损/止盈距离——回测与实盘引擎共用，保证两端口径一致。

    策略在 signal 里给了 sl/tp（绝对点位）且方向摆放合法 → 直接采用并换算成距离；
    否则回退默认：sl_dist = fallback_sl_dist，tp_dist = sl_dist × fallback_rr。

    direction: "long" / "short"（flat 不应传入，由调用方提前跳过）
    ref      : signal 的参考价（点位以该价为参照给出；实盘=最新收盘，回测=当前根收盘）
    sig      : call_signal() 的输出（含 sl/tp）；无自定义策略时传 None

    返回 (sl_dist, tp_dist, rr, used_direct, note)
      used_direct: 本次是否直接采用了策略给的 sl/tp 点位
      note: 点位被回退时的中文原因（正常为空串）
    """
    note = ""
    if sig is not None:
        sl = sig.get("sl")
        tp = sig.get("tp")
        if sl is not None and tp is not None and ref and ref > 0:
            if direction == "long" and sl < ref < tp:
                sl_dist = ref - sl
                tp_dist = tp - ref
            elif direction == "short" and sl > ref > tp:
                sl_dist = sl - ref
                tp_dist = ref - tp
            else:
                sl = tp = None
            if sl is not None and tp is not None and sl_dist > 0 and tp_dist > sl_dist:
                return sl_dist, tp_dist, tp_dist / sl_dist, True, ""
            note = "策略 sl/tp 点位与方向不符或间距不合法，已回退默认止盈止损"
    return fallback_sl_dist, fallback_sl_dist * fallback_rr, fallback_rr, False, note


def make_ctx(ts, closes, highs, lows, vols, n, atr_val, error_hint: str = "") -> dict:
    """组装传给策略的 ctx（全量序列引用 + 当前索引 n，避免每根复制历史）。"""
    return {
        "ts": ts,
        "closes": closes,
        "highs": highs,
        "lows": lows,
        "vols": vols,
        "n": int(n),
        "atr": atr_val,
        "price": closes[n - 1] if n > 0 and n <= len(closes) else 0.0,
        "error": error_hint or None,
    }


def _smoke(ctx: dict) -> dict:
    """冒烟自检：给 loader 自测用（import 后直接调一次，验证函数可跑且返回合法）。"""
    closes = ctx.get("closes", [])
    if len(closes) >= 60:
        n = len(closes)
        price = closes[-1]
        wins = closes[n - 5:n]
        slope = (wins[-1] - wins[0]) / max(price, 1e-9) if len(wins) >= 2 else 0.0
        direction = "long" if slope >= 0 else "short"
        return {
            "direction": direction,
            "reason": "内置趋势规则冒烟（最近 5 根斜率）",
            "atr_mult": None,
            "rr": None,
        }
    return {"direction": "flat", "reason": "样本不足", "atr_mult": None, "rr": None}


if __name__ == "__main__":
    # python strategy_loader.py --smoke：打印 ctx 字段说明 + 默认规则一次输出
    ap = None
    try:
        import argparse

        ap = argparse.ArgumentParser()
        ap.add_argument("--smoke", action="store_true")
        args = ap.parse_args()
        if args.smoke:
            closes = [round(60000 + i * 3.2, 2) for i in range(120)]
            highs = [c + 20 for c in closes]
            lows = [c - 20 for c in closes]
            ts = list(range(120))
            vols = [100.0] * 120
            print(json.dumps({"ok": True, "signal": _smoke(make_ctx(ts, closes, highs, lows, vols, 120, 12.0))}, ensure_ascii=False))
    except SystemExit:
        sys.exit(0)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
