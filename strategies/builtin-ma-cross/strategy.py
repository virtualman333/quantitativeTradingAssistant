# 双均线趋势跟随：MA8 上穿 MA21 金叉做多、下穿死叉做空；未交叉观望
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 22:
        return {"direction": "flat", "reason": "样本不足，观望"}
    fast = sum(closes[n - 8:n]) / 8              # 当前 MA8
    slow = sum(closes[n - 21:n]) / 21            # 当前 MA21
    prev_fast = sum(closes[n - 9:n - 1]) / 8     # 上一根 MA8
    prev_slow = sum(closes[n - 22:n - 1]) / 21   # 上一根 MA21
    if prev_fast <= prev_slow and fast > slow:
        return {"direction": "long", "reason": "MA8 金叉上穿 MA21，趋势转多"}
    if prev_fast >= prev_slow and fast < slow:
        return {"direction": "short", "reason": "MA8 死叉下穿 MA21，趋势转空"}
    return {"direction": "flat", "reason": "双均线未交叉，观望"}
