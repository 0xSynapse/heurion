import pytest
import numpy as np
from fastapi.testclient import TestClient

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from totalsegmentator import (
    generate_synthetic_whole_body_ct,
    analyze_whole_body_ct,
    render_totalsegmentator_l3_slice,
    TOTAL_SEGMENTATOR_CLASSES
)
from engine import MONAIEngine
from server import app


def test_totalsegmentator_classes_definition():
    assert len(TOTAL_SEGMENTATOR_CLASSES) >= 70
    assert "liver" in TOTAL_SEGMENTATOR_CLASSES
    assert "spleen" in TOTAL_SEGMENTATOR_CLASSES
    assert "psoas_major_left" in TOTAL_SEGMENTATOR_CLASSES
    assert "vertebrae_L3" in TOTAL_SEGMENTATOR_CLASSES
    assert "visceral_adipose_tissue" in TOTAL_SEGMENTATOR_CLASSES
    assert "subcutaneous_adipose_tissue" in TOTAL_SEGMENTATOR_CLASSES


def test_generate_synthetic_whole_body_ct():
    vol, masks = generate_synthetic_whole_body_ct(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    assert vol.shape == (32, 64, 64)
    assert "sat" in masks
    assert "muscle" in masks
    assert "vat" in masks
    assert "spine" in masks
    assert "liver" in masks
    assert np.mean(vol[masks["sat"] > 0]) < -50.0  # Fat is negative HU
    assert np.mean(vol[masks["muscle"] > 0]) > 20.0 # Muscle is positive HU
    assert np.mean(vol[masks["spine"] > 0]) > 200.0 # Bone is high HU


def test_analyze_whole_body_ct_sarcopenia_male_and_female():
    vol, masks = generate_synthetic_whole_body_ct(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    
    # Test Male profile
    res_m = analyze_whole_body_ct(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        patient_sex="M",
        patient_height_m=1.75,
        patient_weight_kg=70.0,
        l3_slice_index=16
    )
    assert res_m["status"] == "success"
    assert res_m["l3_vertebra_slice_index"] == 16
    bc_m = res_m["body_composition"]
    assert bc_m["skeletal_muscle_area_cm2"] > 0
    assert bc_m["skeletal_muscle_index_cm2_m2"] > 0
    # 平台不判定肌少症，不输出切点与判定字段
    assert "smi_cutoff" not in bc_m and "sarcopenia_detected" not in bc_m
    assert bc_m["visceral_adipose_cm2"] > 0
    assert bc_m["subcutaneous_adipose_cm2"] > 0
    assert bc_m["vat_to_sat_ratio"] > 0
    # 阈值法分不开肝脾肾，不输出器官体积，也不钳制到「正常范围」
    assert res_m["organ_volumetry_cm3"]["liver"] is None
    assert res_m["organ_volumetry_cm3"]["spleen"] is None

    # Test Female profile
    res_f = analyze_whole_body_ct(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        patient_sex="F",
        patient_height_m=1.62,
        patient_weight_kg=55.0,
        l3_slice_index=16
    )
    bc_f = res_f["body_composition"]
    assert bc_f["skeletal_muscle_index_cm2_m2"] > 0
    assert res_f["key_slice_png_size_bytes"] > 500
    assert "HU 阈值法" in res_f["summary_markdown"]
    assert "不是 TotalSegmentator" in res_f["summary_markdown"]


def test_analyze_whole_body_ct_without_height_or_sex():
    """缺身高、性别时不代入缺省值：SMI、切点、肌少症判定均为空，并给出提示。"""
    vol, _ = generate_synthetic_whole_body_ct(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    res = analyze_whole_body_ct(volume=vol, spacing=(2.0, 1.0, 1.0), l3_slice_index=16)
    bc = res["body_composition"]
    assert bc["skeletal_muscle_area_cm2"] > 0
    assert bc["skeletal_muscle_index_cm2_m2"] is None
    assert "sarcopenia_detected" not in bc
    assert res["data_warnings"] == ["缺身高：未计算 SMI"]


def test_engine_integration_whole_body_segmenter():
    engine = MONAIEngine()
    vol, _ = generate_synthetic_whole_body_ct(shape=(24, 48, 48), spacing=(2.0, 1.0, 1.0))
    res = engine.analyze_volume(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        model_name="whole_body_ct_segmenter",
        patient_sex="M",
        patient_height_m=1.72
    )
    assert res["status"] == "success"
    assert res["model_name"] == "whole_body_ct_segmenter"
    assert "body_composition" in res
    assert "organ_volumetry_cm3" in res
    # 体成分分析没有病灶径线，不再用肌肉面积、肝体积冒充
    assert res["recist_metrics"]["total_volume_cm3"] is None
    assert res["body_composition"]["skeletal_muscle_index_cm2_m2"] > 0


def test_api_whole_body_endpoint():
    client = TestClient(app)
    payload = {
        "z_slices": 24,
        "y_dim": 48,
        "x_dim": 48,
        "patient_sex": "M",
        "patient_height_m": 1.70,
        "patient_weight_kg": 65.0
    }
    # 没有给出影像时不再用合成体冒充，直接 400
    resp_missing = client.post("/api/v1/analyze/whole-body", json=payload)
    assert resp_missing.status_code == 400

    payload["sample_id"] = "spleen_test"
    resp = client.post("/api/v1/analyze/whole-body", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert data["model_name"] == "whole_body_ct_segmenter"
    assert "body_composition" in data
    assert data["body_composition"]["skeletal_muscle_index_cm2_m2"] > 0
    assert data["key_slice_png_base64"].startswith("data:image/png;base64,")


def test_extract_anatomical_compartments_3d():
    from totalsegmentator import extract_anatomical_compartments_3d
    vol, _ = generate_synthetic_whole_body_ct(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    comps = extract_anatomical_compartments_3d(vol, spacing=(2.0, 1.0, 1.0))
    
    assert "body_mask" in comps
    assert "bone_skeleton" in comps
    assert "lung_parenchyma" in comps
    assert "mediastinum_central" in comps
    assert "thoracic_cage" in comps
    
    # Critical anatomical invariance: lung parenchyma strictly excludes bone skeleton
    assert not np.any(comps["lung_parenchyma"] & comps["bone_skeleton"])
    # Bones are present in the volume
    assert np.any(comps["bone_skeleton"])

