"""
肺结节评估指标（src/nodule_eval.py，PRD T1.7）：匹配规则、阈值扫描、FROC、分层敏感度、测量一致性、从标注掩码取参考结节。
全部用手算得出的小例子，不跑模型。
"""
import math
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from nodule_eval import (  # noqa: E402
    Case, PredNodule, RefNodule, bland_altman, evaluate, froc, match_case, operating_point,
    recommend_operating_point, refs_from_mask, render_markdown, size_bin, slice_thickness_bin,
    stratified_by_meta, stratified_sensitivity, voxel_dice,
)

SP = (1.0, 1.0, 1.0)


def ref(i, c, d, t="solid", v=None):
    return RefNodule(id=i, center_vox_zyx=c, diameter_mm=d, type=t, volume_mm3=v)


def pred(s, c, d=None, v=None):
    return PredNodule(score=s, center_vox_zyx=c, mean_diameter_mm=d, volume_mm3=v)


def test_hit_within_radius_and_min_radius_for_tiny_nodules():
    c = Case("a", SP, refs=[ref("big", (50, 50, 50), 10.0), ref("tiny", (10, 10, 10), 3.0)],
             preds=[pred(0.9, (50, 50, 54.9)), pred(0.8, (10, 10, 12.4)), pred(0.7, (50, 50, 56))])
    hits, fps = match_case(c)
    # 距离 4.9 < 半径 5 命中；3 mm 小结节按 2.5 mm 命中半径，2.4 命中；距离 6 > 5 是假阳性
    assert set(hits) == {"big", "tiny"}
    assert [p.score for p in fps] == [0.7]


def test_duplicate_hits_count_once_and_keep_highest_score_not_fp():
    c = Case("a", SP, refs=[ref("n", (20, 20, 20), 8.0)], preds=[pred(0.4, (20, 20, 21)), pred(0.9, (20, 21, 20))])
    hits, fps = match_case(c)
    assert hits["n"].score == 0.9
    assert fps == []


def test_operating_point_and_threshold():
    cases = [
        Case("a", SP, refs=[ref("a1", (10, 10, 10), 8), ref("a2", (40, 40, 40), 8)], preds=[pred(0.9, (10, 10, 10)), pred(0.3, (40, 40, 40)), pred(0.2, (70, 70, 70))]),
        Case("b", SP, refs=[ref("b1", (10, 10, 10), 8)], preds=[pred(0.6, (90, 90, 90))]),
    ]
    assert operating_point(cases, 0.0) == {"threshold": 0.0, "sensitivity": 2 / 3, "fp_per_scan": 1.0, "hits": 2, "references": 3, "false_positives": 2}
    assert operating_point(cases, 0.5) == {"threshold": 0.5, "sensitivity": 1 / 3, "fp_per_scan": 0.5, "hits": 1, "references": 3, "false_positives": 1}


def test_froc_picks_best_sensitivity_under_each_fp_rate():
    cases = [Case("a", SP, refs=[ref("r1", (10, 10, 10), 8), ref("r2", (40, 40, 40), 8)],
                  preds=[pred(0.9, (10, 10, 10)), pred(0.8, (80, 80, 80)), pred(0.7, (40, 40, 40))])]
    r = froc(cases, fp_rates=(0.5, 1.0))
    # 阈值 0.9：敏感度 0.5、FP 0；阈值 0.7：敏感度 1、FP 1
    assert r["points"] == [{"fp_per_scan": 0.5, "sensitivity": 0.5}, {"fp_per_scan": 1.0, "sensitivity": 1.0}]
    assert r["cpm"] == pytest.approx(0.75)


def test_size_bins_follow_lung_rads():
    assert [size_bin(d) for d in (3, 5.9, 6, 7.9, 8, 14.9, 15, 30)] == ["<6", "<6", "6–<8", "6–<8", "8–<15", "8–<15", "≥15", "≥15"]


def test_stratified_by_size_and_type():
    cases = [Case("a", SP, refs=[ref("s", (10, 10, 10), 5, "solid"), ref("g", (40, 40, 40), 10, "pure_ggo")], preds=[pred(0.9, (40, 40, 40))])]
    st = stratified_sensitivity(cases, 0.5)
    assert st["size"] == {"<6": {"references": 1, "hits": 0, "sensitivity": 0.0}, "8–<15": {"references": 1, "hits": 1, "sensitivity": 1.0}}
    assert st["type"]["pure_ggo"]["sensitivity"] == 1.0 and st["type"]["solid"]["sensitivity"] == 0.0


def test_bland_altman_absolute_and_relative():
    ba = bland_altman([7.0, 9.0], [6.0, 10.0])
    assert ba["mean"] == pytest.approx(0.0) and ba["sd"] == pytest.approx(math.sqrt(2))
    rel = bland_altman([110.0], [90.0], relative=True)
    assert rel["mean"] == pytest.approx(0.2) and rel["loa_low"] == rel["loa_high"] == pytest.approx(0.2)
    assert bland_altman([], []) is None


def test_refs_from_mask_components_and_labels():
    m = np.zeros((40, 40, 40), dtype=np.float32)
    m[5:9, 5:9, 5:9] = 1      # 64 体素
    m[25:27, 25:27, 25:27] = 2  # 8 体素，独立连通域
    spacing = (2.0, 1.0, 1.0)
    comps = refs_from_mask(m, spacing)
    assert len(comps) == 2
    big = max(comps, key=lambda r: r.volume_mm3)
    assert big.volume_mm3 == pytest.approx(128.0)
    assert big.center_vox_zyx == pytest.approx((6.5, 6.5, 6.5))
    assert big.diameter_mm == pytest.approx((6 * 128 / math.pi) ** (1 / 3))
    assert len(refs_from_mask(m, spacing, per_label=True)) == 2


def test_evaluate_and_markdown_report():
    cases = [Case("a", SP, refs=[ref("r", (10, 10, 10), 8, v=268.0)], preds=[pred(0.9, (10, 10, 11), d=8.4, v=280.0), pred(0.1, (60, 60, 60))], elapsed_ms=50000)]
    rep = evaluate(cases, 0.15)
    assert rep["operating_point"]["sensitivity"] == 1.0 and rep["operating_point"]["fp_per_scan"] == 0.0
    assert rep["measurement"]["mean_diameter_mm"]["mean"] == pytest.approx(0.4)
    assert rep["runtime"]["median_ms"] == 50000
    rep["meta"] = {"manifest": "测试", "model_version": "x", "device": "cpu", "git_commit": "abc", "generated_at": "2026-10-25T00:00:00"}
    md = render_markdown(rep)
    assert "敏感度 100.0%（1/1），每例假阳性 0.00 个" in md
    assert "| 0.05 | 100.0% | 1.00 |" in md  # 阈值 0.05 时 0.1 分的假阳性被计入
    assert "分割 Dice" in md


def test_voxel_dice_and_mask_evaluation():
    m_ref = np.zeros((20, 20, 20), dtype=np.uint8)
    m_pred = np.zeros((20, 20, 20), dtype=np.uint8)
    m_ref[4:8, 4:8, 4:8] = 1     # 64 voxels
    m_pred[5:9, 4:8, 4:8] = 1    # 64 voxels, overlap 3*4*4 = 48 voxels -> Dice = 96 / 128 = 0.75
    refs = refs_from_mask(m_ref, SP)
    assert len(refs) == 1 and refs[0].mask_vox_zyx is not None
    pred_vox = tuple(v.astype(np.int32) for v in np.nonzero(m_pred))
    assert voxel_dice(pred_vox, refs[0].mask_vox_zyx) == pytest.approx(0.75)

    p = PredNodule(score=0.85, center_vox_zyx=(6.0, 5.5, 5.5), mean_diameter_mm=5.0, volume_mm3=64.0, mask_vox_zyx=pred_vox)
    rep = evaluate([Case("c1", SP, refs=refs, preds=[p])], 0.15)
    assert rep["measurement"]["dice"]["n"] == 1
    assert rep["measurement"]["dice"]["mean"] == pytest.approx(0.75)
    md = render_markdown(rep)
    assert "- 分割 Dice：n=1，均值 0.750" in md


def test_stratified_by_meta_and_recommend_operating_point():
    assert [slice_thickness_bin(x) for x in (0.625, 1.25, 1.5, 2.5, 3.0, None)] == [
        "≤1.25mm", "≤1.25mm", "1.25–2.5mm", "1.25–2.5mm", ">2.5mm", "unknown"
    ]
    cases = [
        Case(
            "c1", (1.0, 0.8, 0.8),
            refs=[ref("r1", (10, 10, 10), 8.0)],
            preds=[pred(0.82, (10, 10, 10)), pred(0.22, (40, 40, 40))],
            meta={"scanner": "Siemens", "dose": "LDCT", "slice_thickness_mm": 1.0},
        ),
        Case(
            "c2", (3.0, 0.8, 0.8),
            refs=[ref("r2", (20, 20, 20), 8.0)],
            preds=[pred(0.45, (20, 20, 20)), pred(0.18, (50, 50, 50))],
            meta={"scanner": "GE", "dose": "SDCT", "slice_thickness_mm": 3.0},
        ),
    ]
    s_meta = stratified_by_meta(cases, 0.30)
    assert s_meta["slice_thickness"]["≤1.25mm"]["sensitivity"] == 1.0
    assert s_meta["slice_thickness"]["≤1.25mm"]["fp_per_scan"] == 0.0
    assert s_meta["slice_thickness"][">2.5mm"]["sensitivity"] == 1.0
    assert s_meta["dose"]["LDCT"]["cases"] == 1

    rec = recommend_operating_point(cases, target_sensitivity=0.95, max_fp_per_scan=1.0)
    assert rec["meets_target"] is True
    assert rec["sensitivity"] == 1.0
    assert rec["fp_per_scan"] == 0.0
    assert rec["threshold"] == pytest.approx(0.45)

