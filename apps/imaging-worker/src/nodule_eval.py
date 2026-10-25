"""
肺结节检出与测量的评估指标（PRD T1.7）。

只做纯计算，不跑模型：输入每个病例的参考结节（医师共识标注）与模型输出，给出
- 阈值扫描：每个检出分数阈值下的敏感度与每例假阳性数（用来定 min_score）；
- FROC：每例假阳性 1/8、1/4、1/2、1、2、4、8 时的敏感度及其平均（CPM，LUNA16 口径）；
- 分层敏感度：按参考结节平均径（Lung-RADS 实性结节分档）与密度类型；
- 测量一致性：匹配上的结节的平均径误差、体积相对误差（Bland–Altman 均值与 95% 一致性界限）。

匹配规则（LUNA16）：预测中心落在参考结节半径（mm）以内即命中；一个参考结节只计一次，取分数最高的命中；
命中同一参考结节的其余预测不算假阳性；没命中任何参考结节的预测是假阳性。
参考结节直径小于 5 mm 时，命中半径按 2.5 mm 计，避免极小结节因标注中心的体素误差被判漏检。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

FROC_FP_RATES = (0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0)
SCORE_GRID = (0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)
# Lung-RADS v2022 实性结节平均径分档（mm）
SIZE_BINS: Tuple[Tuple[str, float, float], ...] = (("<6", 0.0, 6.0), ("6–<8", 6.0, 8.0), ("8–<15", 8.0, 15.0), ("≥15", 15.0, math.inf))
MIN_HIT_RADIUS_MM = 2.5


@dataclass
class RefNodule:
    id: str
    center_vox_zyx: Tuple[float, float, float]
    diameter_mm: float
    type: str = "unknown"
    volume_mm3: Optional[float] = None


@dataclass
class PredNodule:
    score: float
    center_vox_zyx: Tuple[float, float, float]
    mean_diameter_mm: Optional[float] = None
    volume_mm3: Optional[float] = None


@dataclass
class Case:
    case_id: str
    spacing_zyx: Tuple[float, float, float]
    refs: List[RefNodule]
    preds: List[PredNodule]
    elapsed_ms: Optional[float] = None
    meta: Dict[str, Any] = field(default_factory=dict)


def distance_mm(a: Sequence[float], b: Sequence[float], spacing: Sequence[float]) -> float:
    return math.sqrt(sum(((float(x) - float(y)) * float(s)) ** 2 for x, y, s in zip(a, b, spacing)))


def match_case(case: Case, threshold: float = 0.0) -> Tuple[Dict[str, PredNodule], List[PredNodule]]:
    """分数 ≥ threshold 的预测与参考结节匹配；返回（参考 id → 命中的预测，假阳性列表）"""
    preds = sorted((p for p in case.preds if p.score >= threshold), key=lambda p: -p.score)
    hits: Dict[str, PredNodule] = {}
    fps: List[PredNodule] = []
    for p in preds:
        hit_any = False
        for r in case.refs:
            if distance_mm(p.center_vox_zyx, r.center_vox_zyx, case.spacing_zyx) <= max(r.diameter_mm / 2.0, MIN_HIT_RADIUS_MM):
                hit_any = True
                hits.setdefault(r.id, p)  # 分数从高到低遍历，先到的就是最高分
        if not hit_any:
            fps.append(p)
    return hits, fps


def operating_point(cases: Sequence[Case], threshold: float) -> Dict[str, float]:
    n_ref = sum(len(c.refs) for c in cases)
    n_hit = n_fp = 0
    for c in cases:
        hits, fps = match_case(c, threshold)
        n_hit += len(hits)
        n_fp += len(fps)
    return {
        "threshold": threshold,
        "sensitivity": n_hit / n_ref if n_ref else float("nan"),
        "fp_per_scan": n_fp / len(cases) if cases else float("nan"),
        "hits": n_hit, "references": n_ref, "false_positives": n_fp,
    }


def threshold_sweep(cases: Sequence[Case], grid: Sequence[float] = SCORE_GRID) -> List[Dict[str, float]]:
    return [operating_point(cases, t) for t in grid]


def froc(cases: Sequence[Case], fp_rates: Sequence[float] = FROC_FP_RATES) -> Dict[str, Any]:
    """在所有出现过的分数上扫描，取每例假阳性不超过目标值时的最高敏感度；CPM 为各点平均"""
    scores = sorted({p.score for c in cases for p in c.preds}, reverse=True)
    curve = [operating_point(cases, s) for s in scores]
    points = []
    for rate in fp_rates:
        ok = [pt["sensitivity"] for pt in curve if pt["fp_per_scan"] <= rate]
        points.append({"fp_per_scan": rate, "sensitivity": max(ok) if ok else 0.0})
    cpm = float(np.mean([p["sensitivity"] for p in points])) if points else float("nan")
    return {"points": points, "cpm": cpm}


def size_bin(d: float) -> str:
    for name, lo, hi in SIZE_BINS:
        if lo <= d < hi:
            return name
    return SIZE_BINS[-1][0]


def stratified_sensitivity(cases: Sequence[Case], threshold: float) -> Dict[str, Dict[str, Dict[str, float]]]:
    """按平均径分档与密度类型统计敏感度（参考结节数为 0 的分组不列）"""
    by: Dict[str, Dict[str, List[int]]] = {"size": {}, "type": {}}
    for c in cases:
        hits, _ = match_case(c, threshold)
        for r in c.refs:
            for key, group in (("size", size_bin(r.diameter_mm)), ("type", r.type or "unknown")):
                cell = by[key].setdefault(group, [0, 0])
                cell[0] += 1
                cell[1] += 1 if r.id in hits else 0
    order = [b[0] for b in SIZE_BINS]
    return {
        key: {g: {"references": n, "hits": h, "sensitivity": h / n} for g, (n, h) in sorted(groups.items(), key=lambda kv: order.index(kv[0]) if kv[0] in order else 99)}
        for key, groups in by.items()
    }


def bland_altman(pred: Sequence[float], ref: Sequence[float], relative: bool = False) -> Optional[Dict[str, float]]:
    """差值（或相对差值 = 差 / 两者均值）的均值与 95% 一致性界限"""
    pairs = [(float(p), float(r)) for p, r in zip(pred, ref) if p is not None and r is not None and (not relative or (p + r) > 0)]
    if not pairs:
        return None
    d = np.array([(p - r) / ((p + r) / 2.0) if relative else p - r for p, r in pairs])
    sd = float(d.std(ddof=1)) if len(d) > 1 else 0.0
    m = float(d.mean())
    return {"n": len(d), "mean": m, "sd": sd, "loa_low": m - 1.96 * sd, "loa_high": m + 1.96 * sd}


def measurement_agreement(cases: Sequence[Case], threshold: float) -> Dict[str, Any]:
    pd_, rd, pv, rv = [], [], [], []
    for c in cases:
        hits, _ = match_case(c, threshold)
        for r in c.refs:
            p = hits.get(r.id)
            if not p:
                continue
            if p.mean_diameter_mm is not None:
                pd_.append(p.mean_diameter_mm); rd.append(r.diameter_mm)
            if p.volume_mm3 is not None and r.volume_mm3 is not None:
                pv.append(p.volume_mm3); rv.append(r.volume_mm3)
    return {
        "mean_diameter_mm": bland_altman(pd_, rd),
        "volume_relative": bland_altman(pv, rv, relative=True),
    }


def runtime_summary(cases: Sequence[Case]) -> Optional[Dict[str, float]]:
    t = [c.elapsed_ms for c in cases if c.elapsed_ms is not None]
    if not t:
        return None
    return {"n": len(t), "median_ms": float(np.median(t)), "p90_ms": float(np.percentile(t, 90)), "max_ms": float(max(t))}


def evaluate(cases: Sequence[Case], operating_threshold: float) -> Dict[str, Any]:
    return {
        "cases": len(cases),
        "references": sum(len(c.refs) for c in cases),
        "operating_threshold": operating_threshold,
        "operating_point": operating_point(cases, operating_threshold),
        "stratified": stratified_sensitivity(cases, operating_threshold),
        "measurement": measurement_agreement(cases, operating_threshold),
        "threshold_sweep": threshold_sweep(cases),
        "froc": froc(cases),
        "runtime": runtime_summary(cases),
    }


def refs_from_mask(mask: np.ndarray, spacing: Sequence[float], per_label: bool = False) -> List[RefNodule]:
    """从参考标注（标签图）得到参考结节：默认每个连通域一个（26 邻接）；per_label 时每个标签值一个。
    直径取等体积球直径，中心取质心。"""
    from scipy import ndimage

    voxel = float(np.prod(spacing))
    if per_label:
        labels = mask.astype(np.int32)
        ids = [int(v) for v in np.unique(labels) if v != 0]
    else:
        labels, n = ndimage.label(mask > 0, structure=np.ones((3, 3, 3), dtype=bool))
        ids = list(range(1, n + 1))
    refs = []
    for i in ids:
        comp = labels == i
        n_vox = int(comp.sum())
        if n_vox == 0:
            continue
        vol = n_vox * voxel
        center = tuple(float(x) for x in ndimage.center_of_mass(comp))
        refs.append(RefNodule(id=f"m{i}", center_vox_zyx=center, diameter_mm=(6.0 * vol / math.pi) ** (1.0 / 3.0), volume_mm3=vol))  # type: ignore[arg-type]
    return refs


def render_markdown(report: Dict[str, Any]) -> str:
    """评估报告（中文 Markdown）"""
    pct = lambda x: "—" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x * 100:.1f}%"
    num = lambda x, d=2: "—" if x is None else f"{x:.{d}f}"
    meta = report.get("meta", {})
    op = report["operating_point"]
    lines = [
        f"# 肺结节检出评估：{meta.get('manifest', '')}",
        "",
        f"- 模型：{meta.get('model_version', '未知')}（设备 {meta.get('device', '未知')}）",
        f"- 代码版本：{meta.get('git_commit', '未知')}；评估时间：{meta.get('generated_at', '')}",
        f"- 病例 {report['cases']} 例，参考结节 {report['references']} 个；匹配规则见 src/nodule_eval.py 开头",
        "",
        f"## 工作点（检出分数 ≥ {report['operating_threshold']}）",
        "",
        f"敏感度 {pct(op['sensitivity'])}（{op['hits']}/{op['references']}），每例假阳性 {num(op['fp_per_scan'])} 个。",
        "",
        "| 分组 | 参考结节 | 命中 | 敏感度 |",
        "| --- | --- | --- | --- |",
    ]
    for key, title in (("size", "平均径"), ("type", "密度类型")):
        for g, v in report["stratified"][key].items():
            lines.append(f"| {title} {g} | {v['references']} | {v['hits']} | {pct(v['sensitivity'])} |")
    lines += ["", "## 阈值扫描", "", "| 分数阈值 | 敏感度 | 每例假阳性 |", "| --- | --- | --- |"]
    for pt in report["threshold_sweep"]:
        lines.append(f"| {pt['threshold']} | {pct(pt['sensitivity'])} | {num(pt['fp_per_scan'])} |")
    fr = report["froc"]
    lines += ["", f"## FROC（CPM {num(fr['cpm'], 3)}）", "", "| 每例假阳性 | 敏感度 |", "| --- | --- |"]
    lines += [f"| {p['fp_per_scan']} | {pct(p['sensitivity'])} |" for p in fr["points"]]
    m = report["measurement"]
    lines += ["", "## 测量一致性（工作点上匹配的结节）", ""]
    d, v = m["mean_diameter_mm"], m["volume_relative"]
    d_text = "无数据" if not d else "n={}，均值 {} mm，95% 一致性界限 {} 至 {} mm".format(d["n"], num(d["mean"]), num(d["loa_low"]), num(d["loa_high"]))
    v_text = "无数据" if not v else "n={}，均值 {}，95% 一致性界限 {} 至 {}".format(v["n"], pct(v["mean"]), pct(v["loa_low"]), pct(v["loa_high"]))
    lines.append(f"- 平均径（预测 − 参考）：{d_text}")
    lines.append(f"- 体积相对差：{v_text}")
    rt = report.get("runtime")
    lines += ["", "## 耗时", "", "无数据" if not rt else f"中位数 {rt['median_ms'] / 1000:.1f} s，P90 {rt['p90_ms'] / 1000:.1f} s，最长 {rt['max_ms'] / 1000:.1f} s（{rt['n']} 例）"]
    lines += ["", "分割 Dice 需要模型输出分割掩码（T1.6 DICOM SEG），本报告暂不含。", ""]
    return "\n".join(lines)
