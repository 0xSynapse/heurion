import pytest
import numpy as np
from fastapi.testclient import TestClient

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from registration import (
    compute_normalized_cross_correlation,
    run_3d_deformable_registration,
    compute_pet_metrics_and_fusion,
    delineate_radiotherapy_targets
)
from server import app
sys.path.insert(0, os.path.dirname(__file__))
from synthetic_pet_ct import generate_synthetic_pet_ct_pair


def test_synthetic_pet_ct_pair():
    ct, pet, meta = generate_synthetic_pet_ct_pair(shape=(24, 48, 48), spacing=(2.0, 1.0, 1.0))
    assert ct.shape == (24, 48, 48)
    assert pet.shape == (24, 48, 48)
    assert np.min(ct) <= -800.0  # Lung / air
    assert np.max(ct) >= 200.0   # Bone
    assert np.max(pet) >= 10.0   # Peak tumor SUV


def test_deformable_registration_ncc_improvement():
    ct, _, _ = generate_synthetic_pet_ct_pair(shape=(24, 48, 48), spacing=(2.0, 1.0, 1.0))
    # Create displaced moving volume
    moving = np.roll(ct, shift=(1, 2, -1), axis=(0, 1, 2))
    
    res = run_3d_deformable_registration(
        fixed_vol=ct,
        moving_vol=moving,
        spacing=(2.0, 1.0, 1.0),
        iterations=8,
        smoothing_sigma=1.0
    )
    assert res["status"] == "success"
    assert res["final_ncc"] >= res["initial_ncc"]
    assert res["mse_reduction_percent"] >= 0.0
    assert res["max_displacement_mm"] > 0.0
    assert res["method"] == "simplified_demons_ddf"
    assert "B-Spline" not in res["summary_markdown"]
    assert "简化 Demons" in res["summary_markdown"]


def test_pet_metrics_require_roi_or_exclusion_note():
    ct, pet, _ = generate_synthetic_pet_ct_pair(shape=(24, 48, 48), spacing=(2.0, 1.0, 1.0))
    # 既无 ROI 也无生理摄取排除说明：拒绝全体积统计
    with pytest.raises(ValueError):
        compute_pet_metrics_and_fusion(ct_volume=ct, pet_volume=pet, spacing=(2.0, 1.0, 1.0))
    # 单位为 BQML（非 SUV）：报错
    roi = np.zeros(pet.shape, dtype=bool)
    roi[8:16, 16:32, 24:44] = True
    with pytest.raises(ValueError):
        compute_pet_metrics_and_fusion(ct_volume=ct, pet_volume=pet, spacing=(2.0, 1.0, 1.0),
                                       roi_mask=roi, metadata={"Units": "BQML"})


def test_pet_metrics_within_roi():
    ct = np.full((10, 20, 20), 40.0, dtype=np.float32)
    pet = np.full((10, 20, 20), 1.0, dtype=np.float32)
    pet[2:4, 2:4, 2:4] = 9.0       # ROI 外的高摄取（如生理摄取），不得计入
    pet[6:8, 10:12, 10:12] = 4.0   # ROI 内 8 个体素
    pet[7, 11, 11] = 6.0
    roi = np.zeros(pet.shape, dtype=bool)
    roi[5:9, 8:14, 8:14] = True

    res = compute_pet_metrics_and_fusion(ct_volume=ct, pet_volume=pet, spacing=(2.0, 1.0, 1.0),
                                         suv_threshold=2.5, roi_mask=roi)
    assert res["suv_max"] == 6.0
    assert res["suv_mean"] == round((7 * 4.0 + 6.0) / 8, 2)
    assert res["mtv_cm3"] == round(8 * 2.0 / 1000.0, 2)
    assert res["key_slice_index"] == 7
    assert res["tracer"] is None
    assert "18F-FDG" not in res["summary_markdown"]
    assert res["suv_units_verified"] is False
    assert "未校验" in res["suv_note"]

    res2 = compute_pet_metrics_and_fusion(ct_volume=ct, pet_volume=pet, spacing=(2.0, 1.0, 1.0),
                                          roi_mask=roi, metadata={"tracer": "68Ga-PSMA", "Units": "GML"})
    assert res2["tracer"] == "68Ga-PSMA"
    assert res2["suv_units_verified"] is True
    assert res2["fusion_png_base64"].startswith("data:image/png;base64,")


def test_delineate_targets_empty_gtv_raises():
    ct = np.full((10, 20, 20), 40.0, dtype=np.float32)
    with pytest.raises(ValueError):
        delineate_radiotherapy_targets(ct, np.zeros(ct.shape, dtype=bool), spacing=(3.0, 1.0, 1.0))


def test_delineate_targets_anisotropic_margin_and_lung_kept():
    # 体内全为肺组织 (-800 HU)，四周一圈软组织体壁，外面是体外空气
    ct = np.full((30, 40, 40), -1000.0, dtype=np.float32)
    ct[:, 2:38, 2:38] = 40.0
    ct[:, 4:36, 4:36] = -800.0
    gtv = np.zeros(ct.shape, dtype=bool)
    gtv[15, 20, 20] = True
    res = delineate_radiotherapy_targets(ct, gtv, spacing=(3.0, 1.0, 1.0),
                                         ctv_margin_mm=6.0, ptv_margin_mm=0.0)
    # 各向异性外扩：z 方向 6mm = 2 层，xy 方向 6 个体素；肺组织不被裁掉
    # 体积 = 物理半径 6mm 球内的体素数
    zz, yy, xx = np.meshgrid(np.arange(30), np.arange(40), np.arange(40), indexing="ij")
    expected = (((zz - 15) * 3.0) ** 2 + (yy - 20) ** 2 + (xx - 20) ** 2) <= 36.0
    assert res["ctv_volume_cm3"] == round(int(expected.sum()) * 3.0 / 1000.0, 2)
    assert res["ctv_external_air_voxels_removed"] == 0
    assert res["ctv_bone_voxels_removed"] == 0
    assert "bone_barrier_clipped" not in res
    assert "ICRU" not in res["summary_markdown"]
    assert "TG-101" not in res["summary_markdown"]


def test_delineate_radiotherapy_targets_hierarchy():
    ct, pet, _ = generate_synthetic_pet_ct_pair(shape=(24, 48, 48), spacing=(2.0, 1.0, 1.0))
    metabolic_mask = pet >= 2.5
    res = delineate_radiotherapy_targets(
        ct_volume=ct,
        metabolic_or_lesion_mask=metabolic_mask,
        spacing=(2.0, 1.0, 1.0),
        ctv_margin_mm=4.0,
        ptv_margin_mm=3.0
    )
    assert res["status"] == "success"
    # Volumetric hierarchy: GTV < CTV < PTV
    assert 0 < res["gtv_volume_cm3"] <= res["ctv_volume_cm3"]
    assert res["ctv_volume_cm3"] <= res["ptv_volume_cm3"]
    assert "dicom_rt_roi_metadata" in res
    assert res["rtstruct_png_size_bytes"] > 500


def test_registration_endpoints_api():
    client = TestClient(app)

    # 1. Deformable registration
    # 1. 形变配准：不给影像不再用合成体 + np.roll 冒充，400；网格不一致 400
    assert client.post("/api/v1/registration/deformable", json={"iterations": 5}).status_code == 400
    resp_mis = client.post("/api/v1/registration/deformable", json={
        "fixed_sample_id": "lidc_lung_nodule_ct", "moving_sample_id": "prostate_mri", "iterations": 2})
    assert resp_mis.status_code == 400
    assert client.post("/api/v1/registration/deformable", json={
        "fixed_sample_id": "no_such_sample", "moving_sample_id": "no_such_sample"}).status_code == 404

    # 2. PET-CT：缺 PET 400；不确认 SUV 400
    assert client.post("/api/v1/registration/pet-ct-fusion", json={"ct_sample_id": "lidc_lung_nodule_ct"}).status_code == 400
    assert client.post("/api/v1/registration/pet-ct-fusion", json={
        "ct_sample_id": "lidc_lung_nodule_ct", "pet_sample_id": "lidc_lung_nodule_ct"}).status_code == 400

    # 3. RT-STRUCT：缺 GTV 掩膜 400；用真实标注掩膜时 GTV ≤ CTV ≤ PTV
    assert client.post("/api/v1/rtstruct/delineate", json={"sample_id": "lidc_lung_nodule_ct"}).status_code == 400
    resp_rt = client.post("/api/v1/rtstruct/delineate", json={
        "sample_id": "lidc_lung_nodule_ct", "gtv_mask_sample_id": "lidc_lung_nodule_mask",
        "ctv_margin_mm": 5.0, "ptv_margin_mm": 3.0})
    assert resp_rt.status_code == 200
    data_rt = resp_rt.json()
    assert data_rt["gtv_volume_cm3"] <= data_rt["ctv_volume_cm3"] <= data_rt["ptv_volume_cm3"]
    assert data_rt["rtstruct_png_base64"].startswith("data:image/png;base64,")
