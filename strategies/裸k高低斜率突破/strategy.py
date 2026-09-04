def signal(ctx):
    closes = ctx["closes"]
    highs = ctx["highs"]
    lows = ctx["lows"]
    n = ctx["n"]
    atr = ctx["atr"]
    price = ctx["price"]

    if n < 6:
        return {"direction": "flat", "reason": "样本不足，观望"}
    if price <= 0:
        return {"direction": "flat", "reason": "价格异常，观望"}

    atr_ratio = atr / price
    if atr_ratio < 0.0003 or atr_ratio > 0.008:
        return {"direction": "flat", "reason": "波动率不符，观望"}

    l0, l1, l2 = lows[n-3], lows[n-2], lows[n-1]
    h0, h1, h2 = highs[n-3], highs[n-2], highs[n-1]
    slope = (closes[n-1] - closes[n-5]) / 4 / price

    if l0 < l1 < l2 and h2 > h1 and slope > 0.0001:
        return {"direction": "long", "reason": "裸K低点抬升破前高，斜率确认"}
    if h0 > h1 > h2 and l2 < l1 and slope < -0.0001:
        return {"direction": "short", "reason": "裸K高点下移破前低，斜率确认"}

    return {"direction": "flat", "reason": "裸K无明确结构，观望"}