# 示例策略：趋势跟踪（等价于平台内置「内置趋势策略」，可作为自定义修改起点）
# 在「策略库 → 新建策略 → 用 LLM 改写优化」里直接改，或手工编辑本文件。
def signal(ctx):
    closes = ctx["closes"]
    n = ctx["n"]
    if n < 6:
        return {"direction": "flat", "reason": "样本不足，观望"}
    wins = closes[n - 5:n]                       # 最近 5 根 1m 收盘价
    price = closes[n - 1] or 1e-9
    slope = (wins[-1] - wins[0]) / 4 / price     # 每根平均相对斜率
    if slope >= 0.0002:
        return {"direction": "long", "reason": "5 根斜率上行，强势做多"}
    if slope <= -0.0002:
        return {"direction": "short", "reason": "5 根斜率下行，强势做空"}
    return {"direction": "long" if slope >= 0 else "short", "reason": "弱趋势，顺势方向"}
