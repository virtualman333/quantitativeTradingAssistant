# 布林带均值回归：MA20 ± 2σ 上下轨外反向开仓，回到带内观望
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 21:
        return {"direction": "flat", "reason": "样本不足，观望"}
    win = closes[n - 20:n]
    price = closes[n - 1]
    m = sum(win) / 20.0
    v = sum((x - m) ** 2 for x in win) / 20.0
    sd = v ** 0.5
    up = m + 2 * sd
    lo = m - 2 * sd
    if price >= up:
        return {"direction": "short", "reason": "突破布林上轨，博弈回归"}
    if price <= lo:
        return {"direction": "long", "reason": "跌破布林下轨，博弈回归"}
    return {"direction": "flat", "reason": "价格在布林带内，观望"}
