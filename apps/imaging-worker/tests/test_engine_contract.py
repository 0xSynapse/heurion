"""
引擎输出契约：只输出真实计算结果；缺输入报错；名称/方法如实；空间方向统一为规范 LPS+。
"""
import os
import sys

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from engine import (
    MONAIEngine, ModelUnavailableError, MonaiNeuralInferencePipeline, generate_synthetic_ct_volume,
    canonical_lps_affine, display_plane_slice, NOT_IMPLEMENTED_MODELS,
)
from model_registry import OFFICIAL_MODEL_REGISTRY, get_model_status
from spatial_canonicalizer import to_canonical_lps
from server import app


@pytest.fixture(scope="module")
def engine():
    return MONAIEngine()


# ---------------- 空间方向 ----------------

def test_canonical_affine_round_trip():
    """规范体积写成 NIfTI 后再规范化，体素不变；方向码为 L/P/S。"""
    import nibabel as nib
    rng = np.random.default_rng(0)
    vol = rng.normal(size=(5, 6, 7)).astype(np.float32)
    sp = (2.0, 0.7, 0.8)
    aff = canonical_lps_affine(sp)
    assert nib.aff2axcodes(aff) == ("L", "P", "S")
    back, _, spacing = to_canonical_lps(np.transpose(vol, (2, 1, 0)), aff)
    assert np.array_equal(back, vol)
    assert np.allclose(spacing, sp)


def test_display_plane_orientation():
    """轴位原样（A 上 R 左）；冠状/矢状位 S 在上。"""
    vol = np.zeros((4, 5, 6), dtype=np.float32)
    vol[3, 0, 0] = 1.0  # 最上层、最前、最右
    assert display_plane_slice(vol, "axial", 3)[0, 0] == 1.0
    assert display_plane_slice(vol, "coronal", 0)[0, 0] == 1.0
    assert display_plane_slice(vol, "sagittal", 0)[0, 0] == 1.0


def test_spleen_lies_on_patient_left(engine):
    """真实腹部 CT：MONAI 脾脏分割结果位于患者左侧（规范体积中 x 较大的一侧）。"""
    if not get_model_status("spleen_ct")["is_ready"]:
        pytest.skip("脾脏模型权重未就绪")
    vol, sp, _ = engine.load_volume_data("spleen_test")
    mask, meta = engine.neural_pipeline.infer_spleen(vol, sp)
    assert meta["real_neural_inference"] is True
    assert mask.shape == vol.shape
    _, _, x = np.where(mask > 0)
    assert x.size > 1000
    assert x.mean() > vol.shape[2] / 2


# ---------------- 输入缺失与未实现 ----------------

def test_load_volume_missing_raises(engine):
    with pytest.raises(FileNotFoundError):
        engine.load_volume_data("no_such_sample_xyz")
    with pytest.raises(ValueError):
        engine.load_volume_data("")


@pytest.mark.parametrize("model", ["coronary_artery_calcification", "covid19_lung_infection", "lung_lobe_segmenter", "lung_airway_segmenter", "stroke_ischemic_lesion"])
def test_not_implemented_models_raise(engine, model):
    vol, _ = generate_synthetic_ct_volume(shape=(16, 32, 32))
    with pytest.raises(ModelUnavailableError) as ei:
        engine.analyze_volume(volume=vol, spacing=(1.5, 0.8, 0.8), model_name=model)
    assert "未实现" in str(ei.value)
    mask, method = engine.extract_mask_for_model(vol, (1.5, 0.8, 0.8), model)
    assert mask is None and method is None


def test_analyze_requires_model(engine):
    vol, _ = generate_synthetic_ct_volume(shape=(16, 32, 32))
    with pytest.raises(ValueError):
        engine.analyze_volume(volume=vol, spacing=(1.5, 0.8, 0.8), model_name=None)


def test_brats_rejects_single_channel(engine):
    with pytest.raises(ValueError):
        engine.neural_pipeline.infer_brats(None, ["T1c", "T1", "T2", "FLAIR"])
    data_dir = os.path.join(os.path.dirname(__file__), "..", "data")
    with pytest.raises(ValueError):
        engine.neural_pipeline.infer_brats(os.path.join(data_dir, "spleen_test.nii.gz"), ["T1c", "T1", "T2", "FLAIR"])
    with pytest.raises(ValueError):
        engine.neural_pipeline.infer_brats(os.path.join(data_dir, "brats_brain_mri.nii.gz"), None)


# ---------------- 各分析的输出契约 ----------------

def test_vertebra_roi_mean_hu_only(engine):
    vol = np.full((10, 40, 40), 0.0, dtype=np.float32)
    vol[:, 10:30, 10:30] = 300.0
    vol[:, 15:25, 15:25] = 150.0
    sp = (2.0, 1.0, 1.0)
    res = engine.analyze_volume(volume=vol, spacing=sp, model_name="vertebra_segmenter")
    spine = res["recist_metrics"]["spine"]
    assert spine["roi_mean_hu"] is None
    assert spine["unit"] == "HU"
    assert "t_score_estimate" not in spine and "bmd_diagnosis" not in spine

    res2 = engine.analyze_volume(volume=vol, spacing=sp, model_name="vertebra_segmenter",
                                 prompt_point={"z": 5, "y": 20, "x": 20}, roi_radius_mm=3.0)
    assert res2["recist_metrics"]["spine"]["roi_mean_hu"] == 150.0


def test_region_growing_requires_seed_and_is_named_honestly(engine):
    vol, _ = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    with pytest.raises(ValueError):
        engine.analyze_volume(volume=vol, spacing=(2.0, 1.0, 1.0), model_name="vista3d_interactive_segmenter")
    res = engine.analyze_volume(volume=vol, spacing=(2.0, 1.0, 1.0), model_name="vista3d_interactive_segmenter",
                                prompt_point={"z": 16, "y": 36, "x": 44})
    assert res["model_name"] == "interactive_region_growing"
    assert res["engine_type"] == "rule_based"
    assert "不是 VISTA-3D" in res["neural_info"]["method"]


def test_radiomics_requires_mask(engine):
    vol, mask = generate_synthetic_ct_volume(shape=(24, 48, 48), spacing=(2.0, 1.0, 1.0))
    with pytest.raises(ValueError):
        engine.extract_radiomics(volume=vol, spacing=(2.0, 1.0, 1.0))
    with pytest.raises(ValueError):
        engine.extract_radiomics()
    res = engine.extract_radiomics(volume=vol, mask=mask, spacing=(2.0, 1.0, 1.0))
    assert res["status"] == "success"
    assert res["mask_source"] == "caller_array"


def test_diff_slice_no_trend_conclusion(engine):
    base, _ = generate_synthetic_ct_volume(shape=(16, 32, 32))
    follow = base.copy()
    follow[8, 10:14, 10:14] += 200.0
    engine.register_volume("diff_b", base, (1.5, 0.8, 0.8))
    engine.register_volume("diff_f", follow, (1.5, 0.8, 0.8))
    engine.register_volume("diff_other", base[:8], (1.5, 0.8, 0.8))
    res = engine.extract_diff_slice("diff_b", "diff_f", plane="coronal", window_preset="lung")
    assert res["registered"] is False
    assert "未配准" in res["registration_note"]
    assert "dominant_trend" not in res["statistics_3d"]
    assert res["statistics_3d"]["hu_increased_voxels"] >= 16
    with pytest.raises(ValueError):
        engine.extract_diff_slice("diff_b", "diff_other")


def test_mpr_without_model_has_no_overlay(engine):
    vol, _ = generate_synthetic_ct_volume(shape=(16, 32, 32))
    engine.register_volume("mpr_plain", vol, (1.5, 0.8, 0.8))
    res = engine.extract_mpr_slice("mpr_plain", plane="sagittal", window_preset="lung")
    assert res["overlay_model"] is None
    assert res["lesion_present"] is False
    assert res["orientation_labels"]["top"] == "S"
    res2 = engine.extract_mpr_slice("mpr_plain", plane="axial", window_preset="lung", model_name="lung_nodule_segmenter")
    if res2["overlay_model"]:
        assert "阈值示意" in res2["overlay_method"]


# ---------------- 模型登记与清单 ----------------

def test_registry_ready_only_when_engine_implements():
    implemented = {k for k, v in OFFICIAL_MODEL_REGISTRY.items() if v.engine_implemented}
    assert implemented == set(MonaiNeuralInferencePipeline.NEURAL_LOADERS.keys())
    for name, spec in OFFICIAL_MODEL_REGISTRY.items():
        st = get_model_status(name)
        if not spec.engine_implemented:
            assert st["is_ready"] is False
        if not spec.sha256:
            assert st["verified"] is False
    # 虚构的 COPD 模型条目已删除；TotalSegmentator 没有登记假哈希
    assert "copd_emphysema" not in OFFICIAL_MODEL_REGISTRY
    assert OFFICIAL_MODEL_REGISTRY["totalsegmentator"].sha256 == ""
    assert OFFICIAL_MODEL_REGISTRY["spleen_ct"].version == "v0.5.3"


def test_models_endpoint_honest():
    client = TestClient(app)
    data = client.get("/api/v1/models", params={"include_all": True}).json()
    by_id = {m["id"]: m for m in data["models"]}
    for mid in ("coronary_artery_calcification", "lung_lobe_segmenter", "lung_airway_segmenter", "covid19_lung_infection"):
        assert by_id[mid]["is_ready"] is False
    assert by_id["lung_nodule_segmenter"]["engine_type"] == "rule_based"
    assert by_id["vista3d_interactive_segmenter"]["engine_type"] == "rule_based"
    for mid in ("pancreas_tumor_segmenter", "kidney_tumor_segmenter", "liver_lesion_segmenter"):
        assert "BTCV" in by_id[mid]["name"]
        assert "肿瘤" not in by_id[mid]["name"] and "病灶分割" not in by_id[mid]["name"]
    for m in data["models"]:
        if m["engine_type"] == "deep_learning" and m["is_ready"]:
            st = get_model_status(m["weights_registry_name"])
            assert st["engine_implemented"] and st["verified"]
    assert set(NOT_IMPLEMENTED_MODELS) >= {"coronary_artery_calcification", "lung_lobe_segmenter"}


def test_all_15_monai_zoo_weights_implemented_and_exposed(engine):
    expected_16 = {
        "spleen_ct",
        "swinunetr_btcv",
        "brats_mri",
        "lung_nodule_ct",
        "wholebody_ct",
        "prostate_mri",
        "pancreas_ct_dints",
        "renal_structures_cect",
        "wholebrainseg_large_unest",
        "vista3d",
        "breast_density",
        "pathology_tumor_detection",
        "pathology_nuclei",
        "endoscopic_tool",
        "ventricular_short_axis",
        "valve_landmarks",
    }
    implemented = {k for k, v in OFFICIAL_MODEL_REGISTRY.items() if v.engine_implemented}
    assert implemented == expected_16
    assert set(MonaiNeuralInferencePipeline.NEURAL_LOADERS.keys()) == expected_16

    client = TestClient(app)
    data = client.get("/api/v1/models", params={"include_all": True}).json()
    exposed_weights = {m["weights_registry_name"] for m in data["models"] if m.get("weights_registry_name")}
    assert expected_16.issubset(exposed_weights)

    # 验证轻量 2D/3D 模型的真实权重推理管线能正常产出结构化指标
    vol_small, _ = generate_synthetic_ct_volume(shape=(16, 64, 64), spacing=(2.0, 1.0, 1.0))
    for model_id in ("valve_landmarks", "breast_density", "pathology_tumor_detection", "endoscopic_tool"):
        reg_name = model_id
        if get_model_status(reg_name)["is_ready"]:
            res = engine.analyze_volume(volume=vol_small, spacing=(2.0, 1.0, 1.0), model_name=model_id)
            assert res["engine_type"] == "deep_learning"
            assert res["neural_info"]["real_neural_inference"] is True


def test_removed_and_strict_endpoints():
    client = TestClient(app)
    assert client.get("/api/v1/clinical/audit-cases").status_code == 404
    assert client.post("/api/v1/mpr/info", json={}).status_code == 400
    assert client.post("/api/v1/mpr/slice", json={"sample_id": "no_such_sample"}).status_code == 404
    assert client.post("/api/v1/mpr/diff-slice", json={"baseline_id": "lidc_lung_nodule_ct"}).status_code == 400
    assert client.post("/api/v1/mpr/diff-slice", json={
        "baseline_path": "/nonexistent/a.nii.gz", "followup_id": "lidc_lung_nodule_ct"}).status_code == 404
    assert client.post("/api/v1/tasks/analyze", json={"model_name": "lung_nodule_segmenter"}).status_code == 400
    assert client.post("/api/v1/recist/emphysema", json={}).status_code == 400

