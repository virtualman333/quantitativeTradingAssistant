# 唐奇安通道突破：突破近 20 根高低点跟进，通道内观望
def signal(ctx):
    closes = ctx["closes"]
    highs = ctx["highs"]
    lows = ctx["lows"]
    n = ctx["n"]
    if n < 21:
        return {"direction": "flat", "reason": "样本不足，观望"}
    price = closes[n - 1]
    hi = max(highs[n - 21:n - 1])   # 近 20 根最高（不含当前根）
    lo = min(lows[n - 21:n - 1])    # 近 20 根最低
    if price > hi:
        return {"direction": "long", "reason": "收盘突破 20 根高点，跟进做多"}
    if price < lo:
        return {"direction": "short", "reason": "收盘跌破 20 根低点，跟进做空"}
    return {"direction": "flat", "reason": "仍在通道内，等待突破"}
