import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from ct_extensions import (  # noqa: E402
    analyze_head_ct_ich,
    analyze_rib_fractures,
    classify_rib_fracture_acuity,
    lobe_ctss_score,
    quantify_pneumonia_ctss,
)


def test_pneumonia_ctss_score_and_3d_quantification():
    assert lobe_ctss_score(0.0) == 0
    assert lobe_ctss_score(3.2) == 1
    assert lobe_ctss_score(18.0) == 2
    assert lobe_ctss_score(35.0) == 3
    assert lobe_ctss_score(60.0) == 4
    assert lobe_ctss_score(82.0) == 5

    # Construct a synthetic 3D HU volume + 5-lobe mask
    hu = np.full((10, 10, 10), -850.0, dtype=np.float32)
    lobes = np.zeros((10, 10, 10), dtype=np.int32)
    # Divide 1000 voxels into 5 lobes of 200 voxels each (2 slices per lobe)
    for idx in range(5):
        lobes[idx * 2 : (idx + 1) * 2, :, :] = idx + 1

    # RUL (lobe 1): 4 voxels GGO (-500 HU) -> 2% -> CTSS 1
    hu[0, 0, :4] = -500.0
    # RLL (lobe 3): 40 voxels GGO (-450 HU) + 20 voxels consolidation (-100 HU) -> 60/200 = 30% -> CTSS 3
    hu[4, :4, :] = -450.0
    hu[5, :2, :] = -100.0

    res = quantify_pneumonia_ctss(hu_volume=hu, lobe_mask=lobes, spacing_mm=(10.0, 10.0, 10.0))
    assert res["task"] == "pneumonia_ild_ct"
    assert res["lobes"]["RUL"]["involvement_pct"] == 2.0
    assert res["lobes"]["RUL"]["ctss_score"] == 1
    assert res["lobes"]["RLL"]["ggo_pct"] == 20.0
    assert res["lobes"]["RLL"]["consolidation_pct"] == 10.0
    assert res["lobes"]["RLL"]["involvement_pct"] == 30.0
    assert res["lobes"]["RLL"]["ctss_score"] == 3
    assert res["total_ctss"] == 4
    assert res["severity_reference"] == "mild"
    assert res["status_label"] == "规则推算，待医生确认"
    assert res["requires_confirmation"] is True


def test_rib_fracture_numbering_and_acuity():
    assert classify_rib_fracture_acuity(cortical_gap_mm=1.2, callus_formation_ratio=0.05) == "acute"
    assert classify_rib_fracture_acuity(cortical_gap_mm=0.8, callus_formation_ratio=0.45) == "subacute_healing"
    assert classify_rib_fracture_acuity(cortical_gap_mm=0.0, callus_formation_ratio=0.92, margin_sclerosis=True) == "chronic_old"

    res = analyze_rib_fractures([
        {
            "side": "left",
            "rib_number": 7,
            "anatomical_arc": "anterior",
            "cortical_gap_mm": 0.0,
            "callus_formation_ratio": 0.90,
            "margin_sclerosis": True,
            "displacement_mm": 0.5,
            "confidence": 0.92,
        },
        {
            "side": "right",
            "rib_number": 4,
            "anatomical_arc": "lateral",
            "cortical_gap_mm": 1.8,
            "callus_formation_ratio": 0.02,
            "displacement_mm": 3.1,
            "confidence": 0.95,
        },
        {
            "side": "right",
            "rib_number": 6,
            "anatomical_arc": "posterior",
            "cortical_gap_mm": 0.6,
            "callus_formation_ratio": 0.40,
            "displacement_mm": 1.0,
            "confidence": 0.88,
        },
    ])
    assert res["counts"] == {"total": 3, "acute": 1, "subacute_healing": 1, "chronic_old": 1}
    # Right side sorted first (Rib 4 -> Rib 6), then Left side (Rib 7)
    assert [f["location_code"] for f in res["fractures"]] == [
        "R-Rib4-lateral",
        "R-Rib6-posterior",
        "L-Rib7-anterior",
    ]
    assert res["fractures"][0]["acuity"] == "acute"
    assert res["fractures"][0]["displaced"] is True
    assert res["fractures"][1]["acuity"] == "subacute_healing"
    assert res["fractures"][2]["acuity"] == "chronic_old"

    with pytest.raises(ValueError):
        analyze_rib_fractures([{"side": "right", "rib_number": 13}])


def test_head_ct_ich_and_stat_priority():
    res = analyze_head_ct_ich(
        hemorrhages=[
            {
                "subtype": "intraparenchymal",
                "hemisphere": "left",
                "location_zh": "左侧基底节区",
                "axis_a_mm": 40.0,
                "axis_b_mm": 30.0,
                "extent_c_mm": 30.0,
                "volume_ml": 19.2,
                "mean_hu": 64.0,
            },
            {
                "subtype": "intraventricular",
                "hemisphere": "bilateral",
                "location_zh": "双侧侧脑室后角",
                "volume_ml": 4.5,
                "mean_hu": 58.0,
            },
        ],
        midline_shift_mm=6.4,
        priority="stat",
    )
    assert res["task"] == "head_ich_ct"
    assert res["queue_priority"] == "stat"
    assert res["p90_sla_seconds"] == 60
    assert res["hemorrhage_detected"] is True
    assert res["subtypes_present"] == ["intraparenchymal", "intraventricular"]
    assert res["lesions"][0]["abc2_volume_ml"] == 18.0
    assert res["total_volume_ml"] == 23.7
    assert res["midline_shift_mm"] == 6.4
    assert res["significant_mass_effect"] is True
    assert res["critical_alert_pending_confirmation"] is True
    assert res["status_label"] == "规则推算，待医生确认"
