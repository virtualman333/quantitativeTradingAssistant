# RSI 超买超卖反转：极端区反向开仓，中间区观望
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 16:
        return {"direction": "flat", "reason": "样本不足，观望"}
    win = closes[n - 15:n]
    g = 0.0
    l = 0.0
    for i in range(1, len(win)):
        d = win[i] - win[i - 1]
        if d >= 0:
            g += d
        else:
            l -= d
    if g + l <= 1e-12:
        return {"direction": "flat", "reason": "近 14 根近乎无波动，观望"}
    rs = g / l if l > 1e-12 else 99.0
    rsi = 100.0 - 100.0 / (1.0 + rs)
    if rsi <= 25:
        return {"direction": "long", "reason": f"RSI={rsi:.0f} 超卖，博反弹"}
    if rsi >= 75:
        return {"direction": "short", "reason": f"RSI={rsi:.0f} 超买，博回落"}
    return {"direction": "flat", "reason": "RSI 处于中间区，观望"}
