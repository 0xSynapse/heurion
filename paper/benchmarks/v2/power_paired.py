"""配对二分类终点的样本量（ANALYSIS_PLAN_v2 §2、§4）。

    python3 -I paper/benchmarks/v2/power_paired.py

两组在同一任务上配对运行，终点为“本回合是否发生某种损害”，主要分析为 McNemar 精确检验（双侧 α = 0.05）。
假设两组损害独立发生：只有对照组出事的概率 p_c(1−p_t)，只有平台组出事的概率 p_t(1−p_c)。
对每个 n 精确枚举不一致对数及其方向，求功效；输出功效首次达到 80% / 90% 的最小配对数。
"""

from math import comb


def binom_two_sided_p(k: int, n: int) -> float:
    """不一致对中较少一方为 k 时的精确双侧 p 值（符号检验）。"""
    if n == 0:
        return 1.0
    tail = sum(comb(n, i) for i in range(0, min(k, n - k) + 1)) / 2**n
    return min(1.0, 2 * tail)


def power(n: int, p_c: float, p_t: float, alpha: float = 0.05) -> float:
    a = p_c * (1 - p_t)  # 只有对照组出事
    b = p_t * (1 - p_c)  # 只有平台组出事
    q = a + b
    if q == 0:
        return 0.0
    r = a / q
    total = 0.0
    for d in range(0, n + 1):  # 不一致对数
        pd = comb(n, d) * q**d * (1 - q) ** (n - d)
        if pd < 1e-12:
            continue
        for k in range(0, d + 1):  # 其中只有对照组出事的对数
            if k * 2 <= d:
                continue  # 只计方向有利于平台组的检出
            if binom_two_sided_p(d - k, d) < alpha:
                total += pd * comb(d, k) * r**k * (1 - r) ** (d - k)
    return total


def min_n(p_c: float, p_t: float, target: float) -> int | None:
    for n in range(5, 401):
        if power(n, p_c, p_t) >= target:
            return n
    return None


SCENARIOS = {
    "附带损伤（压力模板）": [(0.10, 0.0), (0.10, 0.02), (0.20, 0.0), (0.20, 0.02), (0.30, 0.02)],
    "并发修改丢失": [(0.30, 0.0), (0.50, 0.0), (0.80, 0.0)],
    "引用编造或引错": [(0.20, 0.0), (0.20, 0.05), (0.30, 0.05), (0.50, 0.05)],
}

if __name__ == "__main__":
    for name, cases in SCENARIOS.items():
        print(f"## {name}")
        print("| 对照组发生率 | 平台组发生率 | 80% 功效所需配对数 | 90% 功效所需配对数 |")
        print("| --- | --- | --- | --- |")
        for p_c, p_t in cases:
            print(f"| {p_c:.0%} | {p_t:.0%} | {min_n(p_c, p_t, 0.8)} | {min_n(p_c, p_t, 0.9)} |")
        print()
