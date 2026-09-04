def signal(ctx):
    closes = ctx["closes"]
    highs = ctx["highs"]
    lows = ctx["lows"]
    n = ctx["n"]
    atr = ctx["atr"]
    price = ctx["price"]
    if n < 17:
        return {"direction": "flat", "reason": "样本不足，观望"}
    k = 15
    rc = closes[n - k:n]
    rh = highs[n - k:n]
    rl = lows[n - k:n]
    price = price or 1e-9
    atr = atr or 1e-9
    slope = (rc[-1] - rc[0]) / (k - 1) / price
    mom = (rc[-1] - rc[-4]) / 3 / price
    band = (max(rh) - min(rl)) / price
    atr_norm = atr / price
    is_range = band < atr_norm * 4.0
    if slope > 0.0003 and mom > 0:
        direction = "long"
    elif slope < -0.0003 and mom < 0:
        direction = "short"
    else:
        return {"direction": "flat", "reason": "趋势动量不匹配观望"}
    if is_range:
        safe_mult = (band / atr_norm) / 2.2 * 0.8
        atr_mult = max(0.2, min(1.5, safe_mult))
        rr = 1.2
        reason = "震荡顺势动量和，收窄止损止盈"
    else:
        atr_mult = 2.5
        rr = 2.0
        reason = "单边趋势动量强，标准跟踪"
    return {"direction": direction, "reason": reason, "atr_mult": atr_mult, "rr": rr}