# MACD 趋势跟随：只做动能同侧——DIF>DEA 且 DIF>0 做多，DIF<DEA 且 DIF<0 做空
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 35:
        return {"direction": "flat", "reason": "样本不足，观望"}
    base = closes[-60:] if n >= 60 else closes   # 只算最近 60 根，避免长历史逐根重复 EMA
    def ema(span):
        k = 2.0 / (span + 1)
        e = base[0]
        out = [e]
        for c in base[1:]:
            e = e + (c - e) * k
            out.append(e)
        return out
    e12 = ema(12)
    e26 = ema(26)
    dif = [a - b for a, b in zip(e12, e26)]
    dea = [dif[0]]
    for i in range(1, len(dif)):
        dea.append(dea[-1] + (dif[i] - dea[-1]) * 0.2)
    d, s = dif[-1], dea[-1]
    if d > s and d > 0:
        return {"direction": "long", "reason": "DIF 在零轴上方金叉，动能向上"}
    if d < s and d < 0:
        return {"direction": "short", "reason": "DIF 在零轴下方死叉，动能向下"}
    return {"direction": "flat", "reason": "DIF/DEA 动能不足或过零轴，观望"}
