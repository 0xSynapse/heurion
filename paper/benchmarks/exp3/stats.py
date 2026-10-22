"""
实验 3 的确证性分析（按 paper/benchmarks/ANALYSIS_PLAN.md 与 v2/ANALYSIS_PLAN_v2.md）。
  .venv-compute/bin/python3 -I paper/benchmarks/exp3/stats.py <结果目录> [<结果目录> ...] [--data <平台数据根目录>] [--out <输出目录>]

输入：各结果目录下的 turns-<组>.jsonl，以及该次运行的平台数据库（执行信号）。
输出：stats.json 与 stats.md（表格 + 文字结论），写到 --out（默认第一个结果目录）。

主要终点：每回合提交后被写前守卫拦下的次数（guard_rejections）。
主要模型在 stats.R（glmmTMB 负二项混合模型）；本脚本整理数据、导出 turns.csv，并给出稳健性分析：
负二项回归（NB2）+ 按用户聚类稳健标准误（收敛失败退回泊松），配对 Wilcoxon，按配对 bootstrap，H3 非劣效。
"""
import argparse
import json
import sqlite3
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf
from scipy import stats

warnings.filterwarnings("ignore")
ALL_ARMS = ["off", "frozen", "placebo", "utility"]
NAMES = {"off": "无记忆", "frozen": "只有预置规则", "placebo": "安慰剂", "utility": "完整系统"}


def load(dirs: list[Path], data_root: Path) -> pd.DataFrame:
    rows = []
    for d in dirs:
        signals: dict[str, int] = {}
        summary_file = d / "summary.json"
        for arm in ALL_ARMS:
            db = data_root / d.name / arm / "platform" / "platform.db"
            if db.exists():
                con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
                for (turn,) in con.execute("select turn_id from execution_signals where turn_id is not null"):
                    signals[turn] = signals.get(turn, 0) + 1
                con.close()
        # Fallback if data_root was already cleaned up but turns.csv exists
        csv_fallback: dict[tuple[str, str, int, str, str], int] = {}
        csv_file = d / "turns.csv"
        if not signals and csv_file.exists():
            old_df = pd.read_csv(csv_file)
            for _, orow in old_df.iterrows():
                key = (str(orow["arm"]), str(orow["user_key"]), int(orow["session"]), str(orow["topic"]), str(orow["archetype"]))
                csv_fallback[key] = int(orow["signals"])
        for arm in ALL_ARMS:
            f = d / f"turns-{arm}.jsonl"
            if not f.exists():
                continue
            for line in f.read_text().splitlines():
                r = json.loads(line)
                ukey = f"{r['arm']}/{r['user']}/{d.name}"
                fb_key = (str(r["arm"]), ukey, int(r["session"]), str(r["topic"]), str(r["archetype"]))
                r["signals"] = signals.get(r.get("turn_id") or "", csv_fallback.get(fb_key, r.get("guard_rejections", 0)))
                r["run"] = d.name
                rows.append(r)
    df = pd.DataFrame(rows)
    df["pair"] = df["seed"]
    df["user_key"] = df["arm"] + "/" + df["user"] + "/" + df["run"]
    return df


def exclusions(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    infra = df["status"].isin(["harness_error"]) | (df["status"].isin(["error", "timeout"]))
    invalid = df["detail"].fillna("").str.startswith("布置无效")
    kept = df[~infra & ~invalid].copy()
    return kept, {"total": int(len(df)), "infra_or_error": int(infra.sum()), "invalid_setup": int(invalid.sum()), "analysed": int(len(kept))}


def contrast_rr(res, a_name: str, b_name: str) -> dict:
    idx = list(res.params.index)
    L = np.zeros(len(idx))
    L[idx.index(a_name)] = 1
    L[idx.index(b_name)] = -1
    t = res.t_test(L)
    diff, se = float(t.effect[0]), float(t.sd[0][0])
    return {"rate_ratio": float(np.exp(diff)), "ci95": [float(np.exp(diff - 1.96 * se)), float(np.exp(diff + 1.96 * se))], "p": float(t.pvalue)}


def fit_count(df: pd.DataFrame, outcome: str, arms: list[str]) -> dict:
    """组别的率比（以无记忆为参照）+ 完整系统 vs 只有预置规则（及安慰剂对比）。"""
    formula = f"{outcome} ~ C(arm, Treatment('off')) + session + C(topic) + C(archetype)"
    groups = pd.factorize(df["user_key"])[0]
    model = "negative binomial (NB2)"
    try:
        res = smf.negativebinomial(formula, df).fit(cov_type="cluster", cov_kwds={"groups": groups}, disp=0, maxiter=200)
        if not np.isfinite(res.params).all() or not res.mle_retvals.get("converged", True):
            raise RuntimeError("not converged")
    except Exception:
        model = "poisson (fallback)"
        res = smf.poisson(formula, df).fit(cov_type="cluster", cov_kwds={"groups": groups}, disp=0, maxiter=200)
    out: dict = {"model": model}
    for arm in [a for a in arms if a != "off"]:
        name = f"C(arm, Treatment('off'))[T.{arm}]"
        b, se = res.params[name], res.bse[name]
        out[f"{arm}_vs_off"] = {"rate_ratio": float(np.exp(b)), "ci95": [float(np.exp(b - 1.96 * se)), float(np.exp(b + 1.96 * se))], "p": float(res.pvalues[name])}
    out["utility_vs_frozen"] = contrast_rr(res, "C(arm, Treatment('off'))[T.utility]", "C(arm, Treatment('off'))[T.frozen]")
    if "placebo" in arms:
        out["utility_vs_placebo"] = contrast_rr(res, "C(arm, Treatment('off'))[T.utility]", "C(arm, Treatment('off'))[T.placebo]")
        out["frozen_vs_placebo"] = contrast_rr(res, "C(arm, Treatment('off'))[T.frozen]", "C(arm, Treatment('off'))[T.placebo]")
    return out


def holm(ps: dict[str, float]) -> dict[str, float]:
    items = sorted(ps.items(), key=lambda kv: kv[1])
    m, adj, running = len(items), {}, 0.0
    for i, (k, p) in enumerate(items):
        running = max(running, min(1.0, (m - i) * p))
        adj[k] = running
    return adj


def per_user(df: pd.DataFrame, col: str, arms: list[str]) -> pd.DataFrame:
    """每个用户的每回合均值；行 = 配对（种子），列 = 组别。"""
    return df.groupby(["pair", "arm"])[col].mean().unstack("arm")[arms]


def wilcoxon(u: pd.DataFrame, a: str, b: str) -> dict:
    d = (u[a] - u[b]).dropna()
    if len(d) < 2 or (d == 0).all():
        return {"n_pairs": int(len(d)), "p": None, "lower_in_a": int((d < 0).sum())}
    s = stats.wilcoxon(u[a].loc[d.index], u[b].loc[d.index])
    return {"n_pairs": int(len(d)), "p": float(s.pvalue), "lower_in_a": int((d < 0).sum()), "median_diff": float(d.median())}


def cluster_bootstrap(df: pd.DataFrame, col: str, a: str, b: str, reps: int = 2000, seed: int = 7) -> list[float]:
    """按配对（种子）重抽，组别 a 与 b 每回合均值之差的 95% 区间。"""
    rng = np.random.default_rng(seed)
    pairs = df["pair"].unique()
    means = df.groupby(["pair", "arm"])[col].agg(["sum", "count"])
    diffs = []
    for _ in range(reps):
        pick = rng.choice(pairs, size=len(pairs), replace=True)
        tot = {arm: [0.0, 0] for arm in (a, b)}
        for p in pick:
            for arm in (a, b):
                if (p, arm) in means.index:
                    s, c = means.loc[(p, arm)]
                    tot[arm][0] += s
                    tot[arm][1] += c
        diffs.append(tot[a][0] / max(tot[a][1], 1) - tot[b][0] / max(tot[b][1], 1))
    return [float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+", type=Path)
    ap.add_argument("--data", type=Path, default=Path(__file__).parent / "data")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    df = load(args.dirs, args.data)
    df, ex = exclusions(df)
    df["success"] = df["success"].astype(int)
    arms = [a for a in ALL_ARMS if a in set(df["arm"].unique())]

    res: dict = {"exclusions": ex, "descriptive": {}}
    for arm in arms:
        g = df[df["arm"] == arm]
        res["descriptive"][arm] = {
            "users": int(g["user_key"].nunique()), "turns": int(len(g)),
            "guard_per_turn": float(g["guard_rejections"].mean()), "guard_total": int(g["guard_rejections"].sum()),
            "signals_per_turn": float(g["signals"].mean()), "success_rate": float(g["success"].mean()),
            "heldout_guard_per_turn": float(g[g["split"] == "heldout"]["guard_rejections"].mean()) if (g["split"] == "heldout").any() else None,
            "guard_by_session": [float(g[g["session"] == s]["guard_rejections"].mean()) for s in sorted(g["session"].unique())],
            "mean_seconds": float(g["ms"].mean() / 1000),
        }

    primary = fit_count(df, "guard_rejections", arms)
    adj = holm({"H1": primary["utility_vs_off"]["p"], "H2": primary["utility_vs_frozen"]["p"]})
    primary["holm"] = adj
    res["primary"] = primary
    res["secondary_signals"] = fit_count(df, "signals", arms)
    held = df[df["split"] == "heldout"]
    res["heldout_descriptive"] = {arm: float(held[held["arm"] == arm]["guard_rejections"].mean()) for arm in arms} if len(held) else None

    u = per_user(df, "guard_rejections", arms)
    rob: dict = {
        "wilcoxon_utility_vs_off": wilcoxon(u, "utility", "off"),
        "wilcoxon_utility_vs_frozen": wilcoxon(u, "utility", "frozen"),
        "bootstrap_diff_utility_minus_off": cluster_bootstrap(df, "guard_rejections", "utility", "off"),
        "bootstrap_diff_utility_minus_frozen": cluster_bootstrap(df, "guard_rejections", "utility", "frozen"),
        "per_user_guard_per_turn": u.round(3).to_dict(orient="index"),
    }
    if "placebo" in arms:
        rob["wilcoxon_utility_vs_placebo"] = wilcoxon(u, "utility", "placebo")
        rob["bootstrap_diff_utility_minus_placebo"] = cluster_bootstrap(df, "guard_rejections", "utility", "placebo")
    res["robustness"] = rob
    lo, hi = cluster_bootstrap(df, "success", "utility", "off")
    diff = float(df[df["arm"] == "utility"]["success"].mean() - df[df["arm"] == "off"]["success"].mean())
    res["H3_noninferiority"] = {"diff": diff, "ci95": [lo, hi], "margin": -0.05, "noninferior": lo > -0.05}

    out = args.out or args.dirs[0]
    df[["arm", "user_key", "pair", "session", "split", "topic", "archetype", "guard_rejections", "signals", "success"]].to_csv(out / "turns.csv", index=False)
    (out / "stats.json").write_text(json.dumps(res, ensure_ascii=False, indent=2, default=float))
    lines = ["# 实验 3 统计结果", "", f"排除：{ex}", "", "| 组 | 用户 | 回合 | 每回合被拦下 | 每回合全部信号 | 完成率 | 留出论文每回合被拦下 |", "|---|---|---|---|---|---|---|"]
    for arm in arms:
        d = res["descriptive"][arm]
        lines.append(f"| {NAMES[arm]} | {d['users']} | {d['turns']} | {d['guard_per_turn']:.3f} | {d['signals_per_turn']:.3f} | {d['success_rate']:.1%} | {d['heldout_guard_per_turn'] if d['heldout_guard_per_turn'] is None else round(d['heldout_guard_per_turn'], 3)} |")
    lines += ["", f"主要模型：{primary['model']}（按用户聚类稳健标准误）", "", "| 比较 | 率比 | 95% CI | p | Holm p |", "|---|---|---|---|---|"]
    cmp_rows = [("utility_vs_off", "H1 完整系统 vs 无记忆", "H1"), ("utility_vs_frozen", "H2 完整系统 vs 只有预置规则", "H2"), ("frozen_vs_off", "只有预置规则 vs 无记忆（描述）", None)]
    if "placebo" in arms:
        cmp_rows.extend([("utility_vs_placebo", "完整系统 vs 安慰剂（探索）", None), ("frozen_vs_placebo", "只有预置规则 vs 安慰剂（探索）", None), ("placebo_vs_off", "安慰剂 vs 无记忆（描述）", None)])
    for key, label, h in cmp_rows:
        c = primary[key]
        lines.append(f"| {label} | {c['rate_ratio']:.2f} | {c['ci95'][0]:.2f}–{c['ci95'][1]:.2f} | {c['p']:.4f} | {'' if h is None else f'{adj[h]:.4f}'} |")
    r = res["robustness"]
    lines += ["", f"稳健性：Wilcoxon 完整系统 vs 无记忆 {r['wilcoxon_utility_vs_off']}；vs 只有预置规则 {r['wilcoxon_utility_vs_frozen']}",
              f"按配对 bootstrap 的每回合差（完整系统 − 无记忆）95% CI：{r['bootstrap_diff_utility_minus_off']}；（完整系统 − 只有预置规则）：{r['bootstrap_diff_utility_minus_frozen']}",
              "", f"H3 非劣效（完成率差 完整系统 − 无记忆）：{res['H3_noninferiority']}"]
    (out / "stats.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    sys.exit(main())
