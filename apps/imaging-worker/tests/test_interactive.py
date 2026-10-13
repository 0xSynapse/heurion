import pytest
import numpy as np
from fastapi.testclient import TestClient

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from engine import generate_synthetic_ct_volume, MONAIEngine
from interactive import interactive_segment_3d
from server import app


def test_interactive_segment_positive_click():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    res = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[{'z': 16, 'y': 36, 'x': 44, 'is_positive': True}]
    )
    assert res["status"] == "success"
    assert res["voxel_count"] > 100
    assert res["volume_cm3"] > 0.1
    assert res["key_slice_index"] == 16
    assert 40.0 <= res["target_hu"] <= 70.0


def test_interactive_segment_negative_repulsion():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    res_pos_only = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[{'z': 16, 'y': 36, 'x': 44, 'is_positive': True}]
    )
    
    # Add negative click right next to positive region
    res_with_neg = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[
            {'z': 16, 'y': 36, 'x': 44, 'is_positive': True},
            {'z': 16, 'y': 44, 'x': 44, 'is_positive': False}
        ]
    )
    assert res_with_neg["status"] == "success"
    assert res_with_neg["voxel_count"] < res_pos_only["voxel_count"]


def test_interactive_segment_bbox_constraint():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    res = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[{'z': 16, 'y': 36, 'x': 44, 'is_positive': True}],
        bbox={'z_min': 14, 'z_max': 18, 'y_min': 30, 'y_max': 42, 'x_min': 38, 'x_max': 50}
    )
    mask = res["mask"]
    # Check that mask does not leak outside bounding box
    assert np.all(mask[:14, :, :] == 0)
    assert np.all(mask[19:, :, :] == 0)


def test_interactive_segment_api_endpoint():
    client = TestClient(app)
    res = client.post("/api/v1/analyze/interactive-segment", json={
        "sample_id": "chest_lung_ct",
        "points": [
            {"z": 115, "y": 256, "x": 256, "is_positive": True}
        ],
        "window_preset": "lung",
        "plane": "axial"
    })
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["model_name"] == "interactive_region_growing"
    assert data["engine_type"] == "rule_based"
    assert "slice_png_base64" in data
    assert data["slice_png_base64"].startswith("data:image/png;base64,")
    assert "recist_metrics" in data
    assert data["positive_prompts_count"] == 1
    assert data["negative_prompts_count"] == 0
    assert "HU 区域生长" in data["summary_markdown"]
    assert "VISTA-3D 交互" not in data["summary_markdown"]

    # 无提示点、无影像：如实报错
    assert client.post("/api/v1/analyze/interactive-segment", json={"sample_id": "chest_lung_ct", "points": []}).status_code == 400
    assert client.post("/api/v1/analyze/interactive-segment", json={"points": [{"z": 1, "y": 1, "x": 1}]}).status_code == 400


def test_models_list_contains_advanced_architectures():
    client = TestClient(app)
    res = client.get("/api/v1/models")
    assert res.status_code == 200
    model_ids = [m["id"] for m in res.json()["models"]]
    assert "vista3d_interactive_segmenter" in model_ids
    assert "whole_body_ct_segmenter" in model_ids


def test_interactive_segment_dual_track_modes():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    
    # 1. CT 值似然 + 梯度模式（默认；旧名 "deep" 为别名，如实返回真实模式名）
    res_deep = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[{'z': 16, 'y': 36, 'x': 44, 'is_positive': True}],
        mode="deep"
    )
    assert res_deep["status"] == "success"
    assert res_deep["engine_mode"] == "hu_likelihood_gradient"
    assert "非神经网络" in res_deep["method"]
    assert res_deep["voxel_count"] > 50

    # 2. Fast Heuristic EDT Mode
    res_fast = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[{'z': 16, 'y': 36, 'x': 44, 'is_positive': True}],
        mode="fast"
    )
    assert res_fast["status"] == "success"
    assert res_fast["engine_mode"] == "fast"
    assert res_fast["voxel_count"] > 50

    # 3. Anatomical Prior Mask Constraint
    prior = np.zeros(vol.shape, dtype=bool)
    prior[14:18, 32:40, 40:48] = True
    res_prior = interactive_segment_3d(
        volume=vol,
        spacing=(2.0, 1.0, 1.0),
        points=[{'z': 16, 'y': 36, 'x': 44, 'is_positive': True}],
        mode="deep",
        anatomical_prior=prior
    )
    assert res_prior["status"] == "success"
    # Ensure mask is strictly within anatomical prior
    assert np.all((res_prior["mask"] > 0) <= prior)



def test_interactive_segment_requires_prompt_points():
    vol, _ = generate_synthetic_ct_volume(shape=(16, 32, 32), spacing=(2.0, 1.0, 1.0))
    # 无提示点：报错，不默认取中心种子
    with pytest.raises(ValueError):
        interactive_segment_3d(volume=vol, spacing=(2.0, 1.0, 1.0))
    # 只有包围盒、没有正提示点：报错
    with pytest.raises(ValueError):
        interactive_segment_3d(volume=vol, spacing=(2.0, 1.0, 1.0),
                               bbox={'z_min': 0, 'z_max': 4, 'y_min': 0, 'y_max': 4, 'x_min': 0, 'x_max': 4})
    # 坐标缺失：报错，不补中心
    with pytest.raises(ValueError):
        interactive_segment_3d(volume=vol, spacing=(2.0, 1.0, 1.0), points=[{'z': 8, 'y': 16, 'is_positive': True}])
    with pytest.raises(ValueError):
        interactive_segment_3d(volume=vol, spacing=(2.0, 1.0, 1.0), points=[{'z': 8, 'y': 16, 'x': 16}], mode="medsam")
