# 放量突破：突破近 20 根高低点 + 量能 1.5 倍确认，否则观望
def signal(ctx):
    closes = ctx["closes"]
    highs = ctx["highs"]
    lows = ctx["lows"]
    vols = ctx["vols"]
    n = ctx["n"]
    if n < 21:
        return {"direction": "flat", "reason": "样本不足，观望"}
    price = closes[n - 1]
    prev_vols = vols[n - 21:n - 1]
    avg_vol = sum(prev_vols) / len(prev_vols) if prev_vols else 1e-12
    vol = vols[n - 1]
    ratio = vol / avg_vol
    if price > max(highs[n - 21:n - 1]) and ratio >= 1.5:
        return {"direction": "long", "reason": f"放量{ratio:.1f}倍突破 20 根高点，做多"}
    if price < min(lows[n - 21:n - 1]) and ratio >= 1.5:
        return {"direction": "short", "reason": f"放量{ratio:.1f}倍跌破 20 根低点，做空"}
    return {"direction": "flat", "reason": "未现放量突破，观望"}
