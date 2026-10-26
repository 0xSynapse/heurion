"""
医生点选分割结节（T2.3，lung_nodule_pipeline.segment_nodule_at_points 与 POST /api/v1/pipeline/lung-nodule/point）：
- 只保留包含正点的连通域；点在结节边上（3 mm 内）时吸附到最近的连通域；点空了 found = false；
- 正 / 负点按原顺序交给 VISTA-3D（第一个正点决定窗口）；
- 接口：阅片器的 LPS 坐标经体积几何换算到体素（斜位、倒序序列），输出病人坐标、关键层 SOP 与单 segment 的 DICOM SEG；
- 体积没有 DICOM 几何、点在序列外时 400。
"""
import base64
import io
import os
import sys

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))
sys.path.insert(0, os.path.dirname(__file__))

import server
from lung_nodule_pipeline import segment_nodule_at_points, select_components_at_points
from volume_geometry import lps_to_voxel, voxel_to_lps

from test_lung_nodule_pipeline import SPACING, build_phantom
from test_volume_geometry import _zip_dir, make_series


class PointNeural:
    """假 VISTA-3D：提示点（任一正点）落在哪个结节里就返回该结节，外加一个游离连通域；肺叶图全为右上叶。"""

    def __init__(self, nodule_masks, stray=True):
        self.device = type("D", (), {"type": "cpu"})()
        self.masks = nodule_masks
        self.stray = stray
        self.calls = []

    def _verified_weights(self, name):
        return None, {"version": "v0.5.7"}

    def get_vista3d_model(self):
        return None

    def infer_vista3d_nodule(self, vol, spacing, prompt_point=None, extra_points=None, prompt_class=None):
        self.calls.append((list(prompt_point), [(list(q), lab) for q, lab in (extra_points or [])]))
        self.prompt_class = prompt_class
        mask = np.zeros(vol.shape, dtype=np.uint8)
        positives = [prompt_point] + [q for q, lab in (extra_points or []) if lab == 1]
        for m in self.masks:
            if any(m[tuple(q)] for q in positives):
                mask[m] = 1
        if self.stray:
            mask[1:3, 1:3, 1:3] = 1
        return mask, {"window_zyx": [[0, 0, 0], list(vol.shape)]}

    def infer_vista3d_lung_lobes(self, vol, spacing, resample_mm=None):
        return np.full(vol.shape, 30, dtype=np.uint8), {"lobe_voxels": {}}


@pytest.fixture(scope="module")
def phantom():
    return build_phantom()


def test_click_inside_nodule(phantom):
    vol, nodules, _ = phantom
    a = nodules["A"]
    fake = PointNeural([n["mask"] for n in nodules.values()])
    res = segment_nodule_at_points(fake, vol, SPACING, [{"zyx": list(a["center"]), "positive": True}])
    assert res["found"] is True and res["model_id"] == "lung_nodule_point" and res["model_version"] == "vista3d@0.5.7"
    n = res["nodule"]
    assert n["segmentation"] == "vista3d" and n["lobe"] == "RUL" and n["detection_score"] is None
    # 游离连通域被丢掉：体积约等于 r = 6 mm 的球
    assert abs(n["metrics"]["volume_mm3"] - 4 / 3 * np.pi * 6 ** 3) / (4 / 3 * np.pi * 6 ** 3) < 0.1
    assert 11.0 <= n["metrics"]["long_axis_mm"] <= 13.5
    assert len(n["_mask_vox"][0]) == int(a["mask"].sum())
    assert n["center_lps_mm"] is None and n["key_slice_sop_instance_uid"] is None   # 没有几何
    assert res["prompt_points"][0]["zyx"] == list(a["center"])
    assert fake.prompt_class == 23            # 点提示按「肺肿瘤」类别


def test_click_on_edge_snaps_to_nearest_component():
    shape = (20, 40, 40)
    m = np.zeros(shape, dtype=bool)
    m[8:12, 15:25, 15:25] = True
    raw = m.astype(np.uint8)
    out = select_components_at_points(raw, [[10, 20, 27]], (1.0, 1.0, 1.0))      # 离边缘 3 个体素 = 3 mm
    assert out.sum() == m.sum()
    assert select_components_at_points(raw, [[10, 20, 30]], (1.0, 1.0, 1.0)).sum() == 0   # 6 mm：太远


def test_click_on_background_is_not_found(phantom):
    vol, nodules, _ = phantom
    fake = PointNeural([n["mask"] for n in nodules.values()], stray=False)
    res = segment_nodule_at_points(fake, vol, SPACING, [{"zyx": [24, 100, 100], "positive": True}])
    assert res["found"] is False and res["nodule"] is None and "没有分割到" in res["reason"]


def test_negative_points_passed_in_order(phantom):
    vol, nodules, _ = phantom
    a, b = nodules["A"], nodules["B"]
    fake = PointNeural([n["mask"] for n in nodules.values()])
    pts = [{"zyx": [24, 40, 34], "positive": False}, {"zyx": list(a["center"]), "positive": True},
           {"zyx": list(b["center"]), "positive": True}]
    res = segment_nodule_at_points(fake, vol, SPACING, pts, lobe=False)
    # 第一个正点决定窗口，其余按原顺序（负点标签 0）
    assert fake.calls[0] == (list(a["center"]), [([24, 40, 34], 0), (list(b["center"]), 1)])
    # 两个正点各自所在的连通域都保留
    assert len(res["nodule"]["_mask_vox"][0]) == int(a["mask"].sum() + b["mask"].sum())
    assert res["nodule"]["lobe"] is None


def test_input_validation(phantom):
    vol, nodules, _ = phantom
    fake = PointNeural([n["mask"] for n in nodules.values()])
    with pytest.raises(ValueError, match="正点"):
        segment_nodule_at_points(fake, vol, SPACING, [{"zyx": [24, 40, 30], "positive": False}])
    with pytest.raises(ValueError, match="不在影像范围"):
        segment_nodule_at_points(fake, vol, SPACING, [{"zyx": [99, 40, 30], "positive": True}])
    with pytest.raises(ValueError, match="1~20"):
        segment_nodule_at_points(fake, vol, SPACING, [])


def test_lps_round_trip():
    a = np.array([[0.0, 0.1, 0.7, -100.0], [0.0, 0.7, -0.1, 20.0], [-1.25, 0.0, 0.0, 300.0], [0, 0, 0, 1.0]])
    geom = {"affine_zyx_to_lps": a.tolist()}
    for zyx in ([0, 0, 0], [12, 33, 7], [47, 119, 119]):
        assert lps_to_voxel(geom, voxel_to_lps(geom, zyx)) == zyx
    assert lps_to_voxel(None, [0, 0, 0]) is None


def test_point_endpoint_with_dicom_geometry(tmp_path, monkeypatch):
    """斜位、倒序的 DICOM 序列：阅片器 LPS 坐标 → 体素 → 分割 → 病人坐标 / 关键层 SOP / 单 segment SEG。"""
    import pydicom
    make_series(str(tmp_path), n_slices=12, rows=40, cols=40, slice_gap=1.25)
    client = TestClient(server.app)
    vid = "t23-point"
    r = client.post("/api/v1/volume/upload", data={"volume_id": vid},
                    files={"file": ("series.zip", _zip_dir(str(tmp_path)), "application/zip")})
    assert r.status_code == 200, r.text
    try:
        vol, spacing, _ = server.engine.volume_cache[vid]
        geom = server.engine.get_volume_geometry(vid)
        center = (6, 20, 20)
        zz, yy, xx = np.ogrid[:vol.shape[0], :vol.shape[1], :vol.shape[2]]
        dz, dy, dx = spacing
        ball = ((zz - center[0]) * dz) ** 2 + ((yy - center[1]) * dy) ** 2 + ((xx - center[2]) * dx) ** 2 <= 4.0 ** 2
        fake = PointNeural([ball])
        neural = server.engine.neural_pipeline
        for name in ("_verified_weights", "infer_vista3d_nodule", "infer_vista3d_lung_lobes", "get_vista3d_model"):
            monkeypatch.setattr(neural, name, getattr(fake, name))

        click = voxel_to_lps(geom, center)
        res = client.post("/api/v1/pipeline/lung-nodule/point", json={"volume_id": vid, "points": [{"lps_mm": click}]})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["found"] is True and fake.calls[0][0] == list(center)
        n = body["nodule"]
        assert "_mask_vox" not in n and n["seg_segment_number"] == 1 and n["lobe"] == "RUL"
        assert n["key_slice_sop_instance_uid"] == geom["sop_instance_uids"][n["key_slice_z"]]
        assert np.allclose(n["center_lps_mm"], voxel_to_lps(geom, n["center_vox_zyx"]), atol=0.01)
        assert body["prompt_points"][0]["positive"] is True
        seg = pydicom.dcmread(io.BytesIO(base64.b64decode(body["seg"]["dicom_base64"])))
        assert seg.Modality == "SEG" and len(seg.SegmentSequence) == 1
        assert seg.SegmentSequence[0].SegmentAlgorithmType == "SEMIAUTOMATIC"
        assert seg.SeriesDescription == "Heurion lung nodule (point prompt)"
        assert body["timings_ms"]["seg"] >= 0 and "segmentation" in body["timings_ms"]

        # 点在序列外 → 400；点空了 → 200 + found = false
        far = list(click)
        far[2] += 500.0
        r = client.post("/api/v1/pipeline/lung-nodule/point", json={"volume_id": vid, "points": [{"lps_mm": far}]})
        assert r.status_code == 400 and "不在所分析的序列范围内" in r.json()["detail"]
        fake.stray = False
        empty = voxel_to_lps(geom, (2, 35, 35))
        r = client.post("/api/v1/pipeline/lung-nodule/point", json={"volume_id": vid, "points": [{"lps_mm": empty}]})
        assert r.status_code == 200 and r.json()["found"] is False and r.json()["seg"] is None
        # 补肺叶：局部肺叶分割
        r = client.post("/api/v1/pipeline/lung-nodule/lobe", json={"volume_id": vid, "lps_mm": click, "radius_mm": 4})
        assert r.status_code == 200 and r.json()["lobe"] == "RUL" and r.json()["center_vox_zyx"] == list(center)
        # 体积不在缓存 → 404
        r = client.post("/api/v1/pipeline/lung-nodule/point", json={"volume_id": "no-such", "points": [{"lps_mm": click}]})
        assert r.status_code == 404
    finally:
        server.engine.remove_volume(vid)


def test_point_endpoint_requires_dicom_geometry(monkeypatch):
    vid = "t23-nogeom"
    server.engine.register_volume(vid, np.zeros((10, 20, 20), dtype=np.float32), (1.0, 1.0, 1.0))
    try:
        r = TestClient(server.app).post("/api/v1/pipeline/lung-nodule/point", json={"volume_id": vid, "points": [{"lps_mm": [0, 0, 0]}]})
        assert r.status_code == 400 and "几何" in r.json()["detail"]
    finally:
        server.engine.remove_volume(vid)
