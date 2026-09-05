import math

# 参数自选与注释：
# K=20：观察窗口（1m周期，≤30根，兼顾灵敏与稳定）
# ER_SINGLE=0.65：效率比>此判单边（近20根波动65%以上沿同向，趋势强）
# ER_RANGE=0.35：效率比<此判震荡（波动多内消，无方向）
# DEV_MULT=1.5：震荡中价偏离均值达1.5倍ATR/price时触均值回归

def lin_slope(ys):
    k = len(ys)
    xs = list(range(k))
    mx = sum(xs) / k
    my = sum(ys) / k
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    return num / (den + 1e-12)

def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    atr = ctx["atr"]
    price = ctx["price"]
    
    if n < 25:
        return {"direction": "flat", "reason": "样本不足25根观望"}
    
    K = 20
    win = closes[n-K:n]
    move = abs(win[-1] - win[0])
    swings = sum(abs(win[i] - win[i-1]) for i in range(1, K))
    er = move / (swings + 1e-12)
    
    mean = sum(win) / K
    dev = (atr / (price + 1e-12)) * 1.5
    
    if er > 0.65:
        s = lin_slope(win)
        if s > 0:
            return {"direction": "long", "reason": f"单边ER={er:.2f}斜率上行顺势多"}
        elif s < 0:
            return {"direction": "short", "reason": f"单边ER={er:.2f}斜率下行顺势空"}
        else:
            return {"direction": "flat", "reason": "单边但斜率平观望"}
    elif er < 0.35:
        if price < mean * (1 - dev):
            return {"direction": "long", "reason": f"震荡ER={er:.2f}价低均值回归多"}
        elif price > mean * (1 + dev):
            return {"direction": "short", "reason": f"震荡ER={er:.2f}价高均值回归空"}
        else:
            return {"direction": "flat", "reason": "震荡未达偏离观望"}
    else:
        return {"direction": "flat", "reason": f"ER={er:.2f}边界模糊观望"}