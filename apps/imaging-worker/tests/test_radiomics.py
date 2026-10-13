import pytest
import numpy as np
from fastapi.testclient import TestClient

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from engine import generate_synthetic_ct_volume, MONAIEngine
from radiomics import (
    compute_shape_features,
    compute_first_order_features,
    compute_glcm_features,
    compute_glrlm_features,
    extract_radiomics_features
)
from server import app


def test_radiomics_shape_features():
    vol, mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    shape_feats = compute_shape_features(mask, spacing=(2.0, 1.0, 1.0))
    
    assert shape_feats["voxel_count"] > 100
    assert shape_feats["volume_cm3"] > 1.0
    assert shape_feats["surface_area_mm2"] > 100.0
    assert 0.0 < shape_feats["sphericity"] <= 1.0
    assert shape_feats["max_3d_diameter_mm"] > 10.0
    assert shape_feats["major_axis_length_mm"] >= shape_feats["minor_axis_length_mm"]
    assert shape_feats["minor_axis_length_mm"] >= shape_feats["least_axis_length_mm"]


def test_radiomics_first_order_statistics():
    vol, mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    fo = compute_first_order_features(vol, mask, spacing=(2.0, 1.0, 1.0))
    
    # In synthetic volume, lesion is ~55 HU
    assert 40.0 <= fo["mean"] <= 70.0
    assert fo["std"] > 0.0
    assert fo["min"] < fo["mean"] < fo["max"]
    assert fo["iqr"] > 0.0
    assert fo["entropy"] > 0.0
    assert 0.0 <= fo["uniformity"] <= 1.0


def test_radiomics_glcm_features():
    vol, mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    glcm = compute_glcm_features(vol, mask, num_bins=16)
    
    assert glcm["contrast"] >= 0.0
    assert glcm["dissimilarity"] >= 0.0
    assert 0.0 <= glcm["homogeneity"] <= 1.0
    assert 0.0 <= glcm["energy_asm"] <= 1.0
    assert glcm["joint_entropy"] > 0.0


def test_radiomics_glrlm_features():
    vol, mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    glrlm = compute_glrlm_features(vol, mask, num_bins=16)
    
    assert 0.0 <= glrlm["short_run_emphasis"] <= 1.0
    assert glrlm["long_run_emphasis"] >= 1.0
    assert glrlm["gray_level_nonuniformity"] > 0.0
    assert glrlm["run_length_nonuniformity"] > 0.0
    assert 0.0 < glrlm["run_percentage"] <= 1.0


def test_empty_mask_handling():
    vol = np.zeros((16, 32, 32), dtype=np.float32)
    mask = np.zeros((16, 32, 32), dtype=np.uint8)
    
    res = extract_radiomics_features(vol, mask, spacing=(1.0, 1.0, 1.0))
    # ROI 为空：报错状态，不填 0
    assert res["status"] == "error"
    assert res["lesion_voxel_count"] == 0
    assert res["features_flat"] == {}
    assert compute_first_order_features(vol, mask)["mean"] is None
    assert compute_shape_features(mask)["sphericity"] is None


def test_feret_diameter_deterministic_and_exact():
    mask = np.zeros((20, 40, 40), dtype=np.uint8)
    mask[4:16, 6:30, 10:22] = 1
    spacing = (2.0, 0.8, 0.8)
    a = compute_shape_features(mask, spacing=spacing)["max_3d_diameter_mm"]
    b = compute_shape_features(mask, spacing=spacing)["max_3d_diameter_mm"]
    expected = np.sqrt((11 * 2.0) ** 2 + (23 * 0.8) ** 2 + (11 * 0.8) ** 2)
    assert a == b == round(float(expected), 2)


def test_sphericity_not_clamped():
    # 单体素立方体：球形度 = π^(1/3)·6^(2/3)/6 ≈ 0.806，按公式如实输出
    mask = np.zeros((5, 5, 5), dtype=np.uint8)
    mask[2, 2, 2] = 1
    sph = compute_shape_features(mask)["sphericity"]
    assert sph == round(float(np.pi ** (1 / 3) * 6 ** (2 / 3) / 6), 4)
    assert "IBSI 标准" not in extract_radiomics_features(np.zeros((5, 5, 5), dtype=np.float32) + mask * 10, mask)["markdown_report"]


def test_radiomics_api_endpoint():
    client = TestClient(app)
    # 没有 ROI 掩膜来源：不再用 HU 阈值临时造掩膜，直接 400
    res_no_mask = client.post("/api/v1/analyze/radiomics", json={"sample_id": "lidc_lung_nodule_ct", "num_bins": 16})
    assert res_no_mask.status_code == 400

    # 使用放射科医师标注的真实掩膜
    res = client.post("/api/v1/analyze/radiomics", json={
        "sample_id": "lidc_lung_nodule_ct",
        "mask_sample_id": "lidc_lung_nodule_mask",
        "num_bins": 16
    })
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert "feature_groups" in data
    assert "features_flat" in data
    assert "markdown_report" in data
    assert data["feature_count"] >= 40
    assert "shape_volume_cm3" in data["features_flat"]
    assert "firstorder_mean" in data["features_flat"]
    assert "glcm_homogeneity" in data["features_flat"]
    assert "glrlm_short_run_emphasis" in data["features_flat"]
