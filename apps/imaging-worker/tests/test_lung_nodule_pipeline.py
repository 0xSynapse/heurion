"""
肺结节模型链（lung_nodule_pipeline）：
- 用假的 RetinaNet / VISTA-3D 推理（合成球形结节、已知体素间距）验证测量换算、平均径、排序、去重、
  分割失败分支、层厚警告、肺叶定位与响应字段；
- 权重缺失时 501；
- DELETE /api/v1/volume/{volume_id}；
- 本机有真实权重与 LIDC 样本时跑一次真实推理冒烟测试。
"""
import math
import os
import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

import server
from engine import ModelUnavailableError
from lung_nodule_pipeline import (
    VISTA3D_LUNG_LOBE_LABELS, deduplicate_detections, run_lung_nodule_pipeline, series_quality_control,
)
from model_registry import get_model_status, get_pipeline_status


TOP_KEYS = {"model_id", "model_version", "device", "elapsed_ms", "series_qc", "nodules", "warnings"}
QC_KEYS = {"slice_thickness_mm", "spacing_mm", "shape", "warnings", "geometry"}
NODULE_KEYS = {"index", "detection_score", "center_vox_zyx", "box_vox_zyx", "lobe", "segmentation", "key_slice_z", "metrics", "warnings",
               "center_lps_mm", "box_lps_mm", "key_slice_sop_instance_uid", "seg_segment_number"}
METRIC_KEYS = {"long_axis_mm", "short_axis_mm", "mean_diameter_mm", "volume_mm3", "mean_hu", "std_hu",
               "nodule_type", "solid_core_diameter_mm", "ctr"}

SPACING = (1.25, 0.7, 0.7)
SHAPE = (48, 120, 120)
LOBE_RIGHT_UPPER = 30   # VISTA-3D "right lung upper lobe"
LOBE_LEFT_UPPER = 28    # VISTA-3D "left lung upper lobe"


# ---------------------------------------------------------------------------
# 合成体积与假模型
# ---------------------------------------------------------------------------

def _sphere(shape, spacing, center, radius_mm):
    zz, yy, xx = np.ogrid[:shape[0], :shape[1], :shape[2]]
    dz, dy, dx = spacing
    cz, cy, cx = center
    return ((zz - cz) * dz) ** 2 + ((yy - cy) * dy) ** 2 + ((xx - cx) * dx) ** 2 <= radius_mm ** 2


def _box_around(center, radius_mm, spacing, shape):
    """包住球体的左闭右开体素框 [z0, y0, x0, z1, y1, x1]。"""
    out_lo, out_hi = [], []
    for c, d, n in zip(center, spacing, shape):
        r = int(math.ceil(radius_mm / d))
        out_lo.append(max(0, c - r))
        out_hi.append(min(n, c + r + 1))
    return out_lo + out_hi


def build_phantom(spacing=SPACING, shape=SHAPE, seed=0):
    """
    肺背景 -850 HU；三个球形结节（x < 60 在患者右侧，x ≥ 60 在患者左侧）：
    A 实性 r=6 mm (+40 HU)；B 纯磨玻璃 r=4 mm (-600 HU)；C 部分实性 r=5 mm（-600 HU 外壳 + r=3 mm +30 HU 核）。
    """
    rng = np.random.default_rng(seed)
    vol = np.full(shape, -850.0, dtype=np.float32) + rng.normal(0, 5, shape).astype(np.float32)
    z = shape[0] // 2
    nodules = {
        "A": {"center": (z, 40, 30), "radius": 6.0},
        "B": {"center": (z, 40, 90), "radius": 4.0},
        "C": {"center": (z, 85, 40), "radius": 5.0},
    }
    masks = {}
    for name, n in nodules.items():
        masks[name] = _sphere(shape, spacing, n["center"], n["radius"])
    vol[masks["A"]] = 40.0
    vol[masks["B"]] = -600.0
    vol[masks["C"]] = -600.0
    vol[_sphere(shape, spacing, nodules["C"]["center"], 3.0)] = 30.0
    for name, n in nodules.items():
        n["mask"] = masks[name]
        n["box"] = _box_around(n["center"], n["radius"], spacing, shape)
    # 肺叶图：右肺（x < 60）为右上叶，左肺为左上叶；结节体素不属于任何肺叶（模拟肺叶分割排除结节）
    lobe_map = np.zeros(shape, dtype=np.uint8)
    lobe_map[:, :, :60] = LOBE_RIGHT_UPPER
    lobe_map[:, :, 60:] = LOBE_LEFT_UPPER
    for m in masks.values():
        lobe_map[m] = 0
    return vol, nodules, lobe_map


class FakeNeural:
    """替代 MonaiNeuralInferencePipeline：检出/分割/肺叶结果由合成体模给出。"""

    def __init__(self, nodules, lobe_map, detections, fail_prompts=(), lobe_error=None, stray_component=True):
        self.device = type("D", (), {"type": "cpu"})()
        self.nodules = nodules
        self.lobe_map = lobe_map
        self.detections = detections
        self.fail_prompts = {tuple(p) for p in fail_prompts}
        self.lobe_error = lobe_error
        self.stray_component = stray_component
        self.vista_calls = []
        self.lobe_calls = 0
        self.lobe_shapes = []
        self.lobe_resample = []
        self.roi_origins = []

    def _verified_weights(self, name):
        return Path("/dev/null"), {"version": {"lung_nodule_ct": "v0.5.9", "vista3d": "v0.5.7"}[name]}

    def detect_lung_nodules(self, vol, spacing, min_score=None):
        thr = 0.15 if min_score is None else float(min_score)
        dets = [dict(d) for d in self.detections if d["score"] >= thr]
        dets.sort(key=lambda d: -d["score"])
        return dets, {"raw_candidate_count": len(self.detections), "score_threshold": thr,
                      "score_threshold_source": "default_rule" if min_score is None else "request.min_score"}

    def infer_vista3d_nodule(self, vol, spacing, prompt_point=None):
        self.vista_calls.append(tuple(prompt_point))
        if tuple(prompt_point) in self.fail_prompts:
            raise RuntimeError("synthetic failure")
        mask = np.zeros(vol.shape, dtype=np.uint8)
        for n in self.nodules.values():
            if n["mask"][tuple(prompt_point)]:
                mask[n["mask"]] = 1
        if self.stray_component:
            # 与检出框不重叠的游离连通域：必须被丢弃
            mask[2:4, 2:4, 2:4] = 1
        return mask, {"real_neural_inference": True, "mask_touches_window_edge": False}

    def infer_vista3d_lung_lobes(self, vol, spacing, resample_mm=None):
        self.lobe_calls += 1
        self.lobe_shapes.append(tuple(vol.shape))
        self.lobe_resample.append(resample_mm)
        if self.lobe_error:
            raise RuntimeError(self.lobe_error)
        if vol.shape == self.lobe_map.shape:
            return self.lobe_map, {"lobe_voxels": {}}
        # roi 模式：按裁块在全图中的位置取对应肺叶图（裁块原点由测试登记）
        z0, y0, x0 = self.roi_origins.pop(0)
        return self.lobe_map[z0:z0 + vol.shape[0], y0:y0 + vol.shape[1], x0:x0 + vol.shape[2]], {"lobe_voxels": {}}


def _detections(nodules, scores):
    return [{"box_zyx": list(nodules[k]["box"]), "score": s} for k, s in scores.items()]


@pytest.fixture(scope="module")
def phantom():
    return build_phantom()


def _assert_contract(res):
    assert TOP_KEYS <= set(res)
    assert res["model_id"] == "lung_nodule_pipeline"
    assert res["model_version"] == "lung_nodule_ct@0.5.9+vista3d@0.5.7"
    assert res["device"] in ("cuda", "mps", "cpu")
    assert isinstance(res["elapsed_ms"], int)
    assert QC_KEYS <= set(res["series_qc"])
    for i, n in enumerate(res["nodules"], start=1):
        assert set(n) == NODULE_KEYS
        assert set(n["metrics"]) == METRIC_KEYS
        assert n["index"] == i
        assert n["segmentation"] in ("vista3d", "failed")
        assert len(n["center_vox_zyx"]) == 3 and len(n["box_vox_zyx"]) == 6
        assert n["lobe"] in (None, "RUL", "RML", "RLL", "LUL", "LLL")
        assert isinstance(n["warnings"], list)


# ---------------------------------------------------------------------------
# 合成体模测试
# ---------------------------------------------------------------------------

def test_lobe_label_table_matches_vista3d_bundle():
    """VISTA-3D v0.5.7 docs/labels.json：28/29 左上/下叶，30/31/32 右上/中/下叶。"""
    assert VISTA3D_LUNG_LOBE_LABELS == {28: "LUL", 29: "LLL", 30: "RUL", 31: "RML", 32: "RLL"}


def test_measurements_sorting_and_contract(phantom):
    vol, nodules, lobe_map = phantom
    # 检出分数故意与大小顺序相反：B 分最高，A 最低
    fake = FakeNeural(nodules, lobe_map, _detections(nodules, {"A": 0.6, "B": 0.95, "C": 0.8}))
    res = run_lung_nodule_pipeline(fake, vol, SPACING, modality="CT")
    _assert_contract(res)
    assert res["warnings"] == []
    assert res["series_qc"]["slice_thickness_mm"] == 1.25
    assert res["series_qc"]["spacing_mm"] == [1.25, 0.7, 0.7]
    assert res["series_qc"]["shape"] == list(SHAPE)
    assert res["series_qc"]["warnings"] == []
    # 没有几何（直接传数组）：病人坐标与 SOP 字段为 null
    assert res["series_qc"]["geometry"] == {"frame": None, "has_sop_uids": False}
    assert all(n["center_lps_mm"] is None and n["box_lps_mm"] is None and n["key_slice_sop_instance_uid"] is None
               for n in res["nodules"])
    assert fake.lobe_calls == 1

    ns = res["nodules"]
    assert len(ns) == 3
    # 按平均径从大到小：A (r=6) > C (r=5) > B (r=4)
    assert [n["detection_score"] for n in ns] == [0.6, 0.8, 0.95]
    means = [n["metrics"]["mean_diameter_mm"] for n in ns]
    assert means == sorted(means, reverse=True)

    expected = [("A", 6.0, "solid", "RUL"), ("C", 5.0, "part_solid", "RUL"), ("B", 4.0, "pure_ggo", "LUL")]
    for n, (name, r, ntype, lobe) in zip(ns, expected):
        m = n["metrics"]
        assert n["segmentation"] == "vista3d"
        # 长径/短径：轴位最大层面上直径 ≈ 2r（体素离散误差 ≤ 2 个面内像素）
        assert abs(m["long_axis_mm"] - 2 * r) <= 2 * 0.7 + 1e-6, (name, m)
        assert abs(m["short_axis_mm"] - 2 * r) <= 2 * 0.7 + 1e-6, (name, m)
        assert m["mean_diameter_mm"] == round((m["long_axis_mm"] + m["short_axis_mm"]) / 2.0, 1)
        # 体积按体素间距换算：体素数 × 1.25 × 0.7 × 0.7，且接近 4/3·π·r³
        n_vox = int(nodules[name]["mask"].sum())
        assert m["volume_mm3"] == round(n_vox * 1.25 * 0.7 * 0.7, 1)
        assert abs(m["volume_mm3"] - 4.0 / 3.0 * math.pi * r ** 3) / (4.0 / 3.0 * math.pi * r ** 3) < 0.15
        assert m["nodule_type"] == ntype
        assert n["lobe"] == lobe
        assert n["center_vox_zyx"] == list(nodules[name]["center"])
        assert n["key_slice_z"] == nodules[name]["center"][0]
        # 中心体素在肺叶图里是 0（结节被排除），肺叶按邻域归属并写明
        assert any("肺叶体素最多者" in w for w in n["warnings"])

    a, c, b = ns
    assert abs(a["metrics"]["mean_hu"] - 40.0) < 1.0
    assert a["metrics"]["std_hu"] < 1.0
    assert a["metrics"]["solid_core_diameter_mm"] is None and a["metrics"]["ctr"] is None
    assert abs(b["metrics"]["mean_hu"] + 600.0) < 1.0
    assert b["metrics"]["solid_core_diameter_mm"] is None and b["metrics"]["ctr"] is None
    # 部分实性：实性核 r=3 mm → 直径约 6 mm，CTR 约 0.6
    assert abs(c["metrics"]["solid_core_diameter_mm"] - 6.0) <= 2 * 0.7
    assert 0.4 < c["metrics"]["ctr"] < 0.8
    assert c["metrics"]["std_hu"] > 100.0


def test_mean_diameter_with_anisotropic_spacing():
    """面内间距 0.6 × 0.9 mm：长短径必须按各自方向的间距换算。"""
    spacing = (1.0, 0.6, 0.9)
    shape = (30, 80, 60)
    vol = np.full(shape, -850.0, dtype=np.float32)
    center = (15, 40, 30)
    # 物理上的椭球：y 半轴 9 mm，x 半轴 6 mm，z 半轴 4 mm
    zz, yy, xx = np.ogrid[:shape[0], :shape[1], :shape[2]]
    ell = (((zz - 15) * 1.0) / 4.0) ** 2 + (((yy - 40) * 0.6) / 9.0) ** 2 + (((xx - 30) * 0.9) / 6.0) ** 2 <= 1.0
    vol[ell] = 20.0
    nod = {"E": {"center": center, "radius": 9.0, "mask": ell, "box": [11, 25, 23, 20, 56, 38]}}
    fake = FakeNeural(nod, np.full(shape, LOBE_RIGHT_UPPER, dtype=np.uint8), _detections(nod, {"E": 0.9}))
    res = run_lung_nodule_pipeline(fake, vol, spacing)
    m = res["nodules"][0]["metrics"]
    assert abs(m["long_axis_mm"] - 18.0) <= 2 * 0.6 + 1e-6
    assert abs(m["short_axis_mm"] - 12.0) <= 2 * 0.9 + 1e-6
    assert m["mean_diameter_mm"] == round((m["long_axis_mm"] + m["short_axis_mm"]) / 2.0, 1)
    assert m["volume_mm3"] == round(int(ell.sum()) * 1.0 * 0.6 * 0.9, 1)
    # 中心体素就在肺叶内：直接归属，不写邻域说明
    assert res["nodules"][0]["lobe"] == "RUL"
    assert not any("肺叶" in w for w in res["nodules"][0]["warnings"])


def test_deduplicate_keeps_higher_score(phantom):
    vol, nodules, lobe_map = phantom
    box_a = nodules["A"]["box"]
    shifted = [box_a[0], box_a[1] + 1, box_a[2] + 1, box_a[3], box_a[4] + 1, box_a[5] + 1]
    dets = [
        {"box_zyx": list(box_a), "score": 0.55},
        {"box_zyx": shifted, "score": 0.9},
        {"box_zyx": list(nodules["B"]["box"]), "score": 0.5},
    ]
    kept, merged = deduplicate_detections(dets, SPACING)
    assert merged == 1
    assert [d["score"] for d in kept] == [0.9, 0.5]

    fake = FakeNeural(nodules, lobe_map, dets)
    res = run_lung_nodule_pipeline(fake, vol, SPACING)
    assert len(res["nodules"]) == 2
    assert {n["detection_score"] for n in res["nodules"]} == {0.9, 0.5}
    assert res["detection"]["merged_duplicates"] == 1


def test_far_apart_detections_not_merged():
    """中心距离 ≥ 平均半径时不合并。"""
    dets = [
        {"box_zyx": [10, 10, 10, 20, 24, 24], "score": 0.9},
        {"box_zyx": [10, 30, 30, 20, 44, 44], "score": 0.8},
    ]
    kept, merged = deduplicate_detections(dets, SPACING)
    assert merged == 0 and len(kept) == 2


def test_segmentation_failure_falls_back_to_box(phantom):
    vol, nodules, lobe_map = phantom
    box_b = nodules["B"]["box"]
    prompt_b = (
        int(round((box_b[0] + box_b[3] - 1) / 2.0)),
        int(round((box_b[1] + box_b[4] - 1) / 2.0)),
        int(round((box_b[2] + box_b[5] - 1) / 2.0)),
    )
    fake = FakeNeural(nodules, lobe_map, _detections(nodules, {"A": 0.9, "B": 0.8}), fail_prompts=[prompt_b])
    res = run_lung_nodule_pipeline(fake, vol, SPACING)
    _assert_contract(res)
    failed = [n for n in res["nodules"] if n["segmentation"] == "failed"]
    assert len(failed) == 1
    f = failed[0]
    m = f["metrics"]
    # 退回框径：轴位面框边长 = 体素数 × 面内间距
    ey = (box_b[4] - box_b[1]) * 0.7
    ex = (box_b[5] - box_b[2]) * 0.7
    assert m["long_axis_mm"] == round(max(ey, ex), 1)
    assert m["short_axis_mm"] == round(min(ey, ex), 1)
    assert m["mean_diameter_mm"] == round((m["long_axis_mm"] + m["short_axis_mm"]) / 2.0, 1)
    for k in ("volume_mm3", "mean_hu", "std_hu", "nodule_type", "solid_core_diameter_mm", "ctr"):
        assert m[k] is None, k
    assert f["warnings"][0] == "VISTA-3D 分割失败"
    assert any("synthetic failure" in w for w in f["warnings"])
    assert any("检出框的轴位面边长" in w for w in f["warnings"])
    assert f["center_vox_zyx"] == list(prompt_b)
    assert f["key_slice_z"] == prompt_b[0]
    assert f["lobe"] == "LUL"


def test_segmentation_without_box_overlap_is_failed(phantom):
    """VISTA-3D 结果只剩与框不重叠的连通域时按失败处理。"""
    vol, nodules, lobe_map = phantom
    # 框放在没有结节的位置：假 VISTA-3D 只返回游离连通域
    dets = [{"box_zyx": [20, 100, 100, 28, 110, 110], "score": 0.9}]
    fake = FakeNeural(nodules, lobe_map, dets)
    res = run_lung_nodule_pipeline(fake, vol, SPACING)
    n = res["nodules"][0]
    assert n["segmentation"] == "failed"
    assert any("无重叠" in w for w in n["warnings"])


def test_oversegmentation_rejected(phantom):
    """小检出框上分割出远超框径的区域（扩散到肺实质）：不采用，按失败退回框径。"""
    vol, nodules, lobe_map = phantom
    z, y, x = nodules["A"]["center"]
    # 只包住 A 中心 4×4 像素（约 2.8 mm）的小框，A 的分割长径约 12 mm > 2 × 2.8 mm
    small_box = [z - 1, y - 2, x - 2, z + 2, y + 2, x + 2]
    fake = FakeNeural(nodules, lobe_map, [{"box_zyx": small_box, "score": 0.3}])
    res = run_lung_nodule_pipeline(fake, vol, SPACING)
    n = res["nodules"][0]
    assert n["segmentation"] == "failed"
    assert any("过分割" in w for w in n["warnings"])
    assert n["metrics"]["volume_mm3"] is None
    assert n["metrics"]["long_axis_mm"] == round(4 * 0.7, 1)


def test_thick_slice_warning_and_lobe_failure():
    spacing = (3.0, 0.7, 0.7)
    vol, nodules, lobe_map = build_phantom(spacing=spacing, shape=(24, 120, 120))
    fake = FakeNeural(nodules, lobe_map, _detections(nodules, {"A": 0.9}), lobe_error="lobe boom")
    res = run_lung_nodule_pipeline(fake, vol, spacing)
    _assert_contract(res)
    assert res["series_qc"]["slice_thickness_mm"] == 3.0
    assert len(res["series_qc"]["warnings"]) == 1 and "2.5" in res["series_qc"]["warnings"][0]
    # 不拒绝：仍然输出结节
    assert len(res["nodules"]) == 1
    assert res["nodules"][0]["lobe"] is None
    assert any("肺叶分割失败" in w and "lobe boom" in w for w in res["warnings"])


def test_series_qc_threshold_boundary():
    assert series_quality_control((10, 10, 10), (2.5, 0.7, 0.7))["warnings"] == []
    assert len(series_quality_control((10, 10, 10), (2.51, 0.7, 0.7))["warnings"]) == 1
    assert len(series_quality_control((10, 10, 10), (1.0, 0.7, 0.7), modality="MR")["warnings"]) == 1


def test_max_nodules_and_min_score(phantom):
    vol, nodules, lobe_map = phantom
    fake = FakeNeural(nodules, lobe_map, _detections(nodules, {"A": 0.3, "B": 0.95, "C": 0.8}))
    res = run_lung_nodule_pipeline(fake, vol, SPACING, max_nodules=2)
    # 按检出分数取前 2 个（B、C），再按平均径排序
    assert [n["detection_score"] for n in res["nodules"]] == [0.8, 0.95]
    assert any("max_nodules" in w for w in res["warnings"])

    res = run_lung_nodule_pipeline(fake, vol, SPACING, min_score=0.9)
    assert [n["detection_score"] for n in res["nodules"]] == [0.95]
    assert res["detection"]["score_threshold_source"] == "request.min_score"

    with pytest.raises(ValueError):
        run_lung_nodule_pipeline(fake, vol, SPACING, max_nodules=0)
    with pytest.raises(ValueError):
        run_lung_nodule_pipeline(fake, vol, SPACING, min_score=1.5)


def test_lobe_modes_and_timings(phantom):
    vol, nodules, lobe_map = phantom
    dets = _detections(nodules, {"A": 0.6, "B": 0.95})
    # off：不调用肺叶分割，lobe 为 null 并写明
    fake = FakeNeural(nodules, lobe_map, dets)
    res = run_lung_nodule_pipeline(fake, vol, SPACING, lobe_mode="off")
    _assert_contract(res)
    assert fake.lobe_calls == 0
    assert all(n["lobe"] is None for n in res["nodules"])
    assert any("lobe_mode=off" in w for w in res["warnings"])
    assert res["lobe_segmentation"]["status"] == "off"

    # roi：每个结节各做一次局部肺叶分割，裁块 ±96 mm，结果与全肺一致
    fake = FakeNeural(nodules, lobe_map, dets)
    for k in ("B", "A"):  # 结节按检出分数降序处理：B、A
        c = nodules[k]["center"]
        fake.roi_origins.append(tuple(max(0, int(c[i] - math.ceil(90.0 / SPACING[i]))) for i in range(3)))
    res = run_lung_nodule_pipeline(fake, vol, SPACING, lobe_mode="roi", lobe_resample_mm=2.0)
    assert fake.lobe_calls == 2
    assert all(s != vol.shape for s in fake.lobe_shapes) or vol.shape[1] * 0.7 <= 192
    assert fake.lobe_resample == [2.0, 2.0]
    assert [n["lobe"] for n in res["nodules"]] == ["RUL", "LUL"]
    assert res["lobe_segmentation"]["mode"] == "roi" and res["lobe_segmentation"]["resample_mm"] == 2.0

    # 各阶段计时
    t = res["timings_ms"]
    assert {"model_load", "detection", "segmentation_per_nodule", "segmentation_total", "measurement", "lobe_segmentation"} <= set(t)
    assert len(t["segmentation_per_nodule"]) == 2

    with pytest.raises(ValueError):
        run_lung_nodule_pipeline(fake, vol, SPACING, lobe_mode="bogus")
    with pytest.raises(ValueError):
        run_lung_nodule_pipeline(fake, vol, SPACING, lobe_resample_mm=0.2)


def test_no_detections_skips_lobe_segmentation(phantom):
    vol, nodules, lobe_map = phantom
    fake = FakeNeural(nodules, lobe_map, [])
    res = run_lung_nodule_pipeline(fake, vol, SPACING)
    _assert_contract(res)
    assert res["nodules"] == [] and fake.lobe_calls == 0 and fake.vista_calls == []


# ---------------------------------------------------------------------------
# HTTP 端点
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    return TestClient(server.app)


def _install_fake(monkeypatch, fake):
    neural = server.engine.neural_pipeline
    for name in ("_verified_weights", "detect_lung_nodules", "infer_vista3d_nodule", "infer_vista3d_lung_lobes"):
        monkeypatch.setattr(neural, name, getattr(fake, name))
    for name in ("get_lung_nodule_model", "get_vista3d_model"):
        monkeypatch.setattr(neural, name, lambda: None)


def test_pipeline_endpoint_contract(client, monkeypatch, phantom):
    vol, nodules, lobe_map = phantom
    fake = FakeNeural(nodules, lobe_map, _detections(nodules, {"A": 0.6, "B": 0.95, "C": 0.8}))
    _install_fake(monkeypatch, fake)
    server.engine.register_volume("t15-endpoint", vol, SPACING, "CT")
    try:
        r = client.post("/api/v1/pipeline/lung-nodule", json={"volume_id": "t15-endpoint", "max_nodules": 20, "min_score": None})
        assert r.status_code == 200, r.text
        res = r.json()
        _assert_contract(res)
        assert res["device"] == server.engine.neural_pipeline.device.type
        assert [n["lobe"] for n in res["nodules"]] == ["RUL", "RUL", "LUL"]
        assert "load" in res["timings_ms"]
        r = client.post("/api/v1/pipeline/lung-nodule", json={"volume_id": "t15-endpoint", "lobe_mode": "off"})
        assert r.status_code == 200 and all(n["lobe"] is None for n in r.json()["nodules"])
        assert client.post("/api/v1/pipeline/lung-nodule", json={"volume_id": "t15-endpoint", "lobe_mode": "x"}).status_code == 400
        # 默认参数
        r = client.post("/api/v1/pipeline/lung-nodule", json={"volume_id": "t15-endpoint"})
        assert r.status_code == 200
        r = client.post("/api/v1/pipeline/lung-nodule", json={"volume_id": "t15-endpoint", "max_nodules": 0})
        assert r.status_code == 400
    finally:
        server.engine.remove_volume("t15-endpoint")


def test_pipeline_endpoint_missing_inputs(client):
    assert client.post("/api/v1/pipeline/lung-nodule", json={}).status_code == 400
    assert client.post("/api/v1/pipeline/lung-nodule", json={"volume_id": "no_such_volume_t15"}).status_code == 404


def test_pipeline_endpoint_501_when_weights_missing(client, monkeypatch, tmp_path, phantom):
    """权重目录为空：两个组成模型均不可用，返回 501，不退回规则法。"""
    vol, _, _ = phantom
    monkeypatch.setenv("HEURION_MODEL_DIR", str(tmp_path))
    server.engine.register_volume("t15-noweights", vol, SPACING, "CT")
    try:
        r = client.post("/api/v1/pipeline/lung-nodule", json={"volume_id": "t15-noweights"})
        assert r.status_code == 501, r.text
        assert "lung_nodule_ct" in r.json()["detail"]
        st = get_pipeline_status("lung_nodule_pipeline")
        assert st["is_ready"] is False and "lung_nodule_ct" in st["unavailable_reason"]
    finally:
        server.engine.remove_volume("t15-noweights")


def test_pipeline_listed_in_models(client):
    data = client.get("/api/v1/models", params={"include_all": True}).json()
    by_id = {m["id"]: m for m in data["models"]}
    entry = by_id["lung_nodule_pipeline"]
    assert entry["components"] == ["lung_nodule_ct", "vista3d"]
    assert entry["endpoint"] == "/api/v1/pipeline/lung-nodule"
    assert entry["model_version"] == "lung_nodule_ct@0.5.9+vista3d@0.5.7"
    ready = get_model_status("lung_nodule_ct")["is_ready"] and get_model_status("vista3d")["is_ready"]
    assert entry["is_ready"] is bool(ready)
    reg = client.get("/api/v1/models/registry").json()
    assert [p["name"] for p in reg["pipelines"]] == ["lung_nodule_pipeline"]
    assert {c["registry_name"] for c in reg["pipelines"][0]["components"]} == {"lung_nodule_ct", "vista3d"}


def test_delete_volume_endpoint(client):
    vol = np.zeros((4, 8, 8), dtype=np.float32)
    server.engine.register_volume("t15-delete", vol, (1.0, 1.0, 1.0), "CT")
    server.engine.mask_cache["t15-delete:lung_nodule_ct"] = np.zeros_like(vol, dtype=np.uint8)
    server.engine.mask_method_cache["t15-delete:lung_nodule_ct"] = "x"
    server.engine.mask_cache["t15-delete-other:lung_nodule_ct"] = np.zeros_like(vol, dtype=np.uint8)
    try:
        r = client.delete("/api/v1/volume/t15-delete")
        assert r.status_code == 200
        assert r.json() == {"volume_id": "t15-delete", "removed": True}
        assert not server.engine.has_volume("t15-delete")
        assert "t15-delete:lung_nodule_ct" not in server.engine.mask_cache
        assert "t15-delete:lung_nodule_ct" not in server.engine.mask_method_cache
        # 其他体积的缓存不受影响
        assert "t15-delete-other:lung_nodule_ct" in server.engine.mask_cache
        assert client.get("/api/v1/volume/t15-delete/status").json()["ready"] is False
        assert client.delete("/api/v1/volume/t15-delete").status_code == 404
    finally:
        server.engine.mask_cache.pop("t15-delete-other:lung_nodule_ct", None)


# ---------------------------------------------------------------------------
# 真实权重冒烟测试
# ---------------------------------------------------------------------------

LIDC_SAMPLE = Path(__file__).resolve().parent.parent / "data" / "lidc_lung_nodule_ct.nii.gz"
_REAL_READY = (
    LIDC_SAMPLE.exists()
    and LIDC_SAMPLE.with_name("lidc_lung_nodule_mask.nii.gz").exists()
    and get_model_status("lung_nodule_ct").get("is_ready", False)
    and get_model_status("vista3d").get("is_ready", False)
)


@pytest.mark.skipif(not _REAL_READY, reason="本机缺少 lung_nodule_ct / vista3d 校验通过的权重或 data/lidc_lung_nodule_ct.nii.gz")
def test_real_inference_smoke_lidc():
    res = server.engine.run_lung_nodule_pipeline("lidc_lung_nodule_ct", max_nodules=5)
    _assert_contract(res)
    assert res["device"] == server.engine.neural_pipeline.device.type
    for n in res["nodules"]:
        m = n["metrics"]
        assert m["long_axis_mm"] is not None and m["long_axis_mm"] > 0
        if n["segmentation"] == "vista3d":
            assert m["volume_mm3"] is not None and m["volume_mm3"] > 0
            assert m["nodule_type"] in (None, "solid", "part_solid", "pure_ggo")
        else:
            assert m["volume_mm3"] is None
    gt, _, _ = server.engine.load_volume_data("lidc_lung_nodule_mask")
    # 样本自带的标注结节应被检出并成功分割
    hits = [n for n in res["nodules"] if gt[tuple(n["center_vox_zyx"])] > 0]
    assert hits and hits[0]["segmentation"] == "vista3d"
    assert hits[0]["lobe"] is not None


@pytest.mark.skipif(not _REAL_READY, reason="本机缺少 vista3d 校验通过的权重或 LIDC 样本")
def test_real_vista3d_nodule_dice_lidc():
    """LIDC 样本：以标注结节质心为正点提示，VISTA-3D 分割与标注的 Dice 应 ≥ 0.6（坐标/方向换算正确性的回归检查）。"""
    import scipy.ndimage as ndi
    vol, sp, _ = server.engine.load_volume_data("lidc_lung_nodule_ct")
    gt = (server.engine.load_volume_data("lidc_lung_nodule_mask")[0] > 0)
    lab, _ = ndi.label(gt)
    biggest = np.argmax(np.bincount(lab.flat)[1:]) + 1
    gt = lab == biggest
    center = [int(round(c)) for c in ndi.center_of_mass(gt)]
    mask, meta = server.engine.neural_pipeline.infer_vista3d_nodule(vol, sp, prompt_point=center)
    dice = 2.0 * float((mask.astype(bool) & gt).sum()) / float(mask.sum() + gt.sum())
    assert dice >= 0.6, dice
    assert meta["real_neural_inference"] is True


# ---------------------------------------------------------------------------
# 推理窗口截断判断：只看挑出的结节掩码（2026-10-26 随访 CT 上 20 mm 结节被误报）
# ---------------------------------------------------------------------------

def test_mask_touches_window_ignores_volume_edge():
    from lung_nodule_pipeline import mask_touches_window
    dims = (40, 60, 60)
    m = np.zeros(dims, dtype=np.uint8)
    m[10:15, 20:30, 20:30] = 1
    assert not mask_touches_window(m, [[5, 10, 10], [25, 40, 40]], dims)      # 在窗口内部
    assert mask_touches_window(m, [[10, 10, 10], [25, 40, 40]], dims)         # 贴住窗口下界
    assert mask_touches_window(m, [[5, 10, 10], [25, 40, 30]], dims)          # 贴住窗口上界（hi 不含）
    edge = np.zeros(dims, dtype=np.uint8)
    edge[0:3, 20:30, 20:30] = 1
    assert not mask_touches_window(edge, [[0, 10, 10], [25, 40, 40]], dims)   # 窗口下界就是体积边缘：不算截断
    assert not mask_touches_window(np.zeros(dims, dtype=np.uint8), [[5, 5, 5], [6, 6, 6]], dims)


class EdgeStrayNeural(FakeNeural):
    """VISTA-3D 原始输出里有一个碰到推理窗口边界的无关连通域（像血管），结节本身在窗口内部。"""

    def infer_vista3d_nodule(self, vol, spacing, prompt_point=None):
        mask, meta = super().infer_vista3d_nodule(vol, spacing, prompt_point)
        # 窗口 = 结节范围外扩 3 个体素：结节本身不碰窗口边界
        idx = np.nonzero(mask)
        lo = [max(0, int(i.min()) - 3) for i in idx]
        hi = [min(n, int(i.max()) + 4) for i, n in zip(idx, vol.shape)]
        stray = np.zeros_like(mask)
        stray[lo[0], lo[1]:hi[1], lo[2]] = 1   # 贴着窗口下界的一条线，与结节不相连
        mask = np.maximum(mask, stray)
        return mask, {**meta, "window_zyx": [lo, hi], "mask_touches_window_edge": True}


def test_stray_component_at_window_edge_does_not_flag_nodule(phantom):
    vol, nodules, lobe_map = phantom
    fake = EdgeStrayNeural(nodules, lobe_map, _detections(nodules, {"A": 0.9}), stray_component=False)
    res = run_lung_nodule_pipeline(fake, vol, SPACING)
    n = res["nodules"][0]
    assert n["segmentation"] == "vista3d"
    assert not any("推理区域边界" in w for w in n["warnings"]), n["warnings"]


class TruncatedNeural(FakeNeural):
    """推理窗口切过结节本身：应提示可能被截断"""

    def infer_vista3d_nodule(self, vol, spacing, prompt_point=None):
        mask, meta = super().infer_vista3d_nodule(vol, spacing, prompt_point)
        idx = np.nonzero(mask)
        lo = [max(0, int(i.min()) - 3) for i in idx]
        hi = [min(n, int(i.max()) + 4) for i, n in zip(idx, vol.shape)]
        lo[2] = int(prompt_point[2])           # 窗口左边界切在结节中心
        mask[:, :, : lo[2]] = 0
        return mask, {**meta, "window_zyx": [lo, hi], "mask_touches_window_edge": False}


def test_nodule_cut_by_window_is_flagged(phantom):
    vol, nodules, lobe_map = phantom
    fake = TruncatedNeural(nodules, lobe_map, _detections(nodules, {"A": 0.9}), stray_component=False)
    res = run_lung_nodule_pipeline(fake, vol, SPACING)
    assert any("推理区域边界" in w for w in res["nodules"][0]["warnings"])
