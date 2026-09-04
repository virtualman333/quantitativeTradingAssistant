def _safe_div(a, b):
    return a / b if b != 0 else 0.0

def signal(ctx):
    closes = ctx["closes"]
    vols = ctx["vols"]
    n = ctx["n"]
    atr = ctx.get("atr", 0.0)
    price = ctx["price"]
    
    if n < 6:
        return {"direction": "flat", "reason": "样本不足，观望"}
    
    if price <= 0:
        price = closes[n - 1]
    if price <= 0:
        return {"direction": "flat", "reason": "价格异常，观望"}
    
    win = closes[n - 5:n]
    slope = (win[-1] - win[0]) / (4.0 * price)
    
    atr_ratio = _safe_div(atr, price)
    if atr_ratio < 0.0008:
        return {"direction": "flat", "reason": "波动过低无分歧，观望"}
    
    vol_recent = sum(vols[n - 3:n]) / 3.0
    vol_prev = sum(vols[n - 6:n - 3]) / 3.0
    if _safe_div(vol_recent, vol_prev) < 1.1:
        return {"direction": "flat", "reason": "量能未放大，观望"}
    
    unit = max(atr, price * 0.0005)
    if slope > 0.0002:
        return {"direction": "long", "sl": price - unit, "tp": price + unit * 1.2, "reason": "强势上行放量波动，顺势开多"}
    elif slope < -0.0002:
        return {"direction": "short", "sl": price + unit, "tp": price - unit * 1.2, "reason": "强势下行放量波动，顺势开空"}
    
    return {"direction": "flat", "reason": "趋势不明朗，观望"}