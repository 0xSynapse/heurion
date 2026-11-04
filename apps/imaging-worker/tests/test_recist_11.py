"""
RECIST 1.1 多靶病灶与最低点（Nadir）参照单元测试（PRD T3.1）。
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from recist import evaluate_recist_11_response  # noqa: E402


def test_recist_11_nadir_reference_detects_pd_after_pr():
    # 基线 50 mm -> 第 1 次随访缩小至 25 mm (PR, -50%) -> 第 2 次随访反弹至 32 mm
    # 相对基线仍是 -36%（若错误按基线算会判 PR），但相对最低点 Nadir 25 mm 增长 +28% 且 +7 mm (>=20% & >=5mm) -> PD！
    res = evaluate_recist_11_response(
        baseline_lesions=[{"id": "L1", "longest_diameter_mm": 50.0}],
        followup_lesions=[{"id": "L1", "longest_diameter_mm": 32.0}],
        prior_timepoints=[[{"id": "L1", "longest_diameter_mm": 25.0}]],
    )
    assert res["category"] == "PD"
    assert res["baseline_sum_mm"] == pytest.approx(50.0)
    assert res["nadir_sum_mm"] == pytest.approx(25.0)
    assert res["followup_sum_mm"] == pytest.approx(32.0)
    assert res["pct_from_nadir"] == pytest.approx(28.0)


def test_recist_11_multi_target_organ_cap_and_lesion_id_matching():
    # 同一器官最多选 2 个靶病灶，全身最多 5 个；随访按 lesion_id 匹配（即使顺序打乱）
    baseline = [
        {"id": "lung_1", "organ": "lung", "longest_diameter_mm": 20.0},
        {"id": "lung_2", "organ": "lung", "longest_diameter_mm": 15.0},
        {"id": "lung_3", "organ": "lung", "longest_diameter_mm": 12.0},  # 第 3 个肺病灶，被每器官 <=2 上限跳过
        {"id": "liver_1", "organ": "liver", "longest_diameter_mm": 25.0},
    ]
    followup = [
        {"id": "liver_1", "organ": "liver", "longest_diameter_mm": 15.0},
        {"id": "lung_2", "organ": "lung", "longest_diameter_mm": 9.0},
        {"id": "lung_1", "organ": "lung", "longest_diameter_mm": 12.0},
    ]
    res = evaluate_recist_11_response(baseline, followup)
    # 选中 lung_1 (20) + lung_2 (15) + liver_1 (25) = 60 mm；随访 12 + 9 + 15 = 36 mm (-40%) -> PR
    assert res["selected_target_count"] == 3
    assert res["baseline_sum_mm"] == pytest.approx(60.0)
    assert res["followup_sum_mm"] == pytest.approx(36.0)
    assert res["category"] == "PR"


def test_recist_11_lymph_node_short_axis_cr_under_10mm():
    # 病理性淋巴结短径 >= 15 mm 纳入靶病灶；随访短径 < 10 mm 且非淋巴结靶病灶归零时判 CR
    baseline = [
        {"id": "tumor_1", "longest_diameter_mm": 22.0},
        {"id": "ln_1", "is_lymph_node": True, "short_axis_mm": 18.0},
    ]
    followup = [
        {"id": "tumor_1", "longest_diameter_mm": 0.0},
        {"id": "ln_1", "is_lymph_node": True, "short_axis_mm": 8.5},
    ]
    res = evaluate_recist_11_response(baseline, followup)
    assert res["category"] == "CR"
