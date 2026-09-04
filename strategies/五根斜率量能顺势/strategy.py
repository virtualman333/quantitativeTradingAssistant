def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 10:
        return {"direction": "flat", "reason": "样本不足，观望"}
    price = ctx["price"] or closes[n - 1] or 1e-9
    if price <= 0:
        price = 1e-9
    k = 5
    wins = closes[n - k:n]
    slope = (wins[-1] - wins[0]) / (k - 1) / price
    vols = ctx["vols"]
    vol_recent = vols[n - k:n]
    vol_avg_win = vols[n - 15:n] if n >= 15 else vols[:n]
    vol_avg = sum(vol_avg_win) / len(vol_avg_win) if vol_avg_win else 1e-9
    vol_recent_avg = sum(vol_recent) / k
    vol_cond = vol_recent_avg > vol_avg * 1.1
    atr = ctx["atr"] if ctx["atr"] > 0 else 1e-9
    atr_ratio = atr / price
    vol_filter = atr_ratio > 0.0005
    thresh = 0.0002
    if slope > thresh and vol_cond and vol_filter:
        return {"direction": "long", "reason": "5根斜率正,量能放大波动足,顺势多"}
    elif slope < -thresh and vol_cond and vol_filter:
        return {"direction": "short", "reason": "5根斜率负,量能放大波动足,顺势空"}
    else:
        return {"direction": "flat", "reason": "趋势弱或量波不足,观望"}