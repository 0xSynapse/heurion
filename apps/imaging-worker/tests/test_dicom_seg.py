"""
结节 DICOM SEG（dicom_seg + /api/v1/pipeline/lung-nodule）：
- 合成源序列：斜位、倒序（法向朝足侧、文件顺序打乱）、行列翻转、非 1 mm 间距；
- 把 SEG 读回：每帧按其引用的源图 IPP / IOP / PixelSpacing 换算到病人坐标，必须与规范化掩码经仿射得到的点集完全一致；
- SEG 属性：BINARY、引用源序列、ASCII 序列描述、Manufacturer、算法信息、编码；
- 不能生成（无几何 / NIfTI、无成功分割、seg=false）时 seg 为 null 并写明原因。
"""
import base64
import io
import os
import sys

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

import server
from dicom_seg import SegUnavailable, build_nodule_seg
from test_lung_nodule_pipeline import FakeNeural
from test_volume_geometry import _zip_dir, make_series


def seg_points_lps(seg_bytes, source_headers_by_uid):
    """
    读回 SEG：{segment_number: 病人坐标点集 (N, 3)}。每帧的正像素 (行, 列) 用该帧引用的源图
    （DerivationImageSequence → SourceImageSequence → ReferencedSOPInstanceUID）的 IPP / IOP / PixelSpacing 换算。
    """
    import pydicom
    ds = pydicom.dcmread(io.BytesIO(seg_bytes))
    arr = ds.pixel_array
    if arr.ndim == 2:
        arr = arr[np.newaxis]
    out = {}
    for i, fg in enumerate(ds.PerFrameFunctionalGroupsSequence):
        sid = fg.SegmentIdentificationSequence if "SegmentIdentificationSequence" in fg else ds.SharedFunctionalGroupsSequence[0].SegmentIdentificationSequence
        seg_no = int(sid[0].ReferencedSegmentNumber)
        uid = str(fg.DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID)
        src = source_headers_by_uid[uid]
        ipp = np.array([float(v) for v in src.ImagePositionPatient])
        iop = [float(v) for v in src.ImageOrientationPatient]
        r_vec, c_vec = np.array(iop[:3]), np.array(iop[3:])
        dy, dx = [float(v) for v in src.PixelSpacing]
        rr, cc = np.nonzero(arr[i])
        pts = ipp[None, :] + cc[:, None] * dx * r_vec[None, :] + rr[:, None] * dy * c_vec[None, :]
        out.setdefault(seg_no, []).append(pts)
    return ds, {k: np.concatenate(v, axis=0) for k, v in out.items()}


def _as_set(pts):
    return {tuple(np.round(p, 2)) for p in pts}


def _run_seg_pipeline(tmp_path, monkeypatch, feet_first_normal, flip_row_dir, fail_second=False, seg=True,
                      frame_of_reference="all"):
    truth, normal = make_series(str(tmp_path), n_slices=14, rows=48, cols=40, pixel_spacing=(0.7, 0.9),
                                slice_gap=1.6, feet_first_normal=feet_first_normal, flip_row_dir=flip_row_dir,
                                frame_of_reference=frame_of_reference)
    client = TestClient(server.app)
    vid = f"t16-seg-{int(feet_first_normal)}{int(flip_row_dir)}{int(fail_second)}{int(seg)}-{frame_of_reference}"
    r = client.post("/api/v1/volume/upload", data={"volume_id": vid},
                    files={"file": ("series.zip", _zip_dir(str(tmp_path)), "application/zip")})
    assert r.status_code == 200, r.text
    vol, spacing, _ = server.engine.volume_cache[vid]
    geom = server.engine.get_volume_geometry(vid)
    zz, yy, xx = np.ogrid[:vol.shape[0], :vol.shape[1], :vol.shape[2]]
    dz, dy, dx = spacing

    def ball(c, r):
        return ((zz - c[0]) * dz) ** 2 + ((yy - c[1]) * dy) ** 2 + ((xx - c[2]) * dx) ** 2 <= r ** 2

    big_c, small_c = (7, 30, 12), (6, 12, 28)
    nod = {
        "A": {"center": big_c, "radius": 5.0, "mask": ball(big_c, 5.0), "box": [3, 22, 6, 12, 39, 19]},
        "B": {"center": small_c, "radius": 3.0, "mask": ball(small_c, 3.0), "box": [4, 8, 25, 9, 17, 32]},
    }
    b_box = nod["B"]["box"]
    b_prompt = [int(round((b_box[i] + b_box[i + 3] - 1) / 2.0)) for i in range(3)]
    fake = FakeNeural(nod, np.full(vol.shape, 30, dtype=np.uint8),
                      [{"box_zyx": nod["A"]["box"], "score": 0.8}, {"box_zyx": nod["B"]["box"], "score": 0.9}],
                      fail_prompts=[b_prompt] if fail_second else (), stray_component=False)
    neural = server.engine.neural_pipeline
    for name in ("_verified_weights", "detect_lung_nodules", "infer_vista3d_nodule", "infer_vista3d_lung_lobes"):
        monkeypatch.setattr(neural, name, getattr(fake, name))
    for name in ("get_lung_nodule_model", "get_vista3d_model"):
        monkeypatch.setattr(neural, name, lambda: None)
    res = client.post("/api/v1/pipeline/lung-nodule", json={"volume_id": vid, "seg": seg})
    assert res.status_code == 200, res.text
    return res.json(), nod, geom, server.engine.volume_cache[vid], vid


@pytest.mark.parametrize("feet_first_normal,flip_row_dir", [(True, False), (False, True), (True, True)])
def test_seg_roundtrip_oblique_reversed_flipped(tmp_path, monkeypatch, feet_first_normal, flip_row_dir):
    from volume_geometry import source_headers_of
    res, nod, geom, entry, vid = _run_seg_pipeline(tmp_path, monkeypatch, feet_first_normal, flip_row_dir)
    try:
        seg = res["seg"]
        assert seg is not None, res["warnings"]
        assert set(seg) >= {"dicom_base64", "series_instance_uid", "sop_instance_uid", "segments"}
        # 结节按平均径排序：A（大）为 1 号，B 为 2 号；segment 按结节编号顺序
        assert [n["index"] for n in res["nodules"]] == [1, 2]
        assert seg["segments"] == [{"segment_number": 1, "nodule_index": 1}, {"segment_number": 2, "nodule_index": 2}]
        assert [n["seg_segment_number"] for n in res["nodules"]] == [1, 2]

        headers = source_headers_of(entry)
        ds, pts = seg_points_lps(base64.b64decode(seg["dicom_base64"]), headers)
        a = np.asarray(geom["affine_zyx_to_lps"])
        for n, key in zip(res["nodules"], ["A", "B"]):
            z, y, x = np.nonzero(nod[key]["mask"])
            expected = (a @ np.stack([z, y, x, np.ones_like(z)]).astype(float))[:3].T
            got = pts[n["seg_segment_number"]]
            assert _as_set(got) == _as_set(expected)
            assert len(got) == len(expected)
            # 质心与 center_lps_mm 一致（合成球体：质心即中心体素）
            assert np.allclose(got.mean(axis=0), n["center_lps_mm"], atol=0.05)

        # SEG 属性
        src_series = next(iter(headers.values())).SeriesInstanceUID
        assert ds.Modality == "SEG" and ds.SegmentationType == "BINARY"
        assert ds.SeriesDescription == "Heurion AI lung nodules" and ds.SeriesDescription.isascii()
        assert ds.Manufacturer == "Heurion"
        assert ds.SOPInstanceUID == seg["sop_instance_uid"] and ds.SeriesInstanceUID == seg["series_instance_uid"]
        assert ds.ReferencedSeriesSequence[0].SeriesInstanceUID == src_series
        assert ds.StudyInstanceUID == next(iter(headers.values())).StudyInstanceUID
        assert ds.FrameOfReferenceUID == getattr(next(iter(headers.values())), "FrameOfReferenceUID", ds.FrameOfReferenceUID)
        for sd in ds.SegmentSequence:
            assert sd.SegmentAlgorithmType == "AUTOMATIC"
            assert sd.SegmentAlgorithmName == "lung_nodule_pipeline"
            assert len(sd.RecommendedDisplayCIELabValue) == 3  # 阅片器缺显示色会提示并改用默认色
            cat = sd.SegmentedPropertyCategoryCodeSequence[0]
            typ = sd.SegmentedPropertyTypeCodeSequence[0]
            assert (cat.CodingSchemeDesignator, cat.CodeValue) == ("SCT", "49755003")
            assert (typ.CodingSchemeDesignator, typ.CodeValue) == ("SCT", "27925004")
            algo = sd.SegmentationAlgorithmIdentificationSequence[0]
            assert algo.AlgorithmName == "lung_nodule_pipeline" and algo.AlgorithmVersion == res["model_version"]
        assert res["timings_ms"]["seg"] >= 0
    finally:
        server.engine.remove_volume(vid)


def test_failed_segmentation_gets_no_segment(tmp_path, monkeypatch):
    res, nod, geom, entry, vid = _run_seg_pipeline(tmp_path, monkeypatch, True, False, fail_second=True)
    try:
        failed = [n for n in res["nodules"] if n["segmentation"] == "failed"]
        ok = [n for n in res["nodules"] if n["segmentation"] == "vista3d"]
        assert len(failed) == 1 and len(ok) == 1
        assert failed[0]["seg_segment_number"] is None
        assert ok[0]["seg_segment_number"] == 1
        assert res["seg"]["segments"] == [{"segment_number": 1, "nodule_index": ok[0]["index"]}]
    finally:
        server.engine.remove_volume(vid)


def test_seg_disabled_by_request(tmp_path, monkeypatch):
    res, _, _, _, vid = _run_seg_pipeline(tmp_path, monkeypatch, True, False, seg=False)
    try:
        assert res["seg"] is None
        assert all(n["seg_segment_number"] is None for n in res["nodules"])
    finally:
        server.engine.remove_volume(vid)


def test_seg_unavailable_without_dicom_source(monkeypatch):
    """直接注册的数组 / NIfTI 没有源图：seg 为 null，warnings 写明原因。"""
    from test_lung_nodule_pipeline import build_phantom, _detections, SPACING
    vol, nodules, lobe_map = build_phantom()
    fake = FakeNeural(nodules, lobe_map, _detections(nodules, {"A": 0.9}))
    neural = server.engine.neural_pipeline
    for name in ("_verified_weights", "detect_lung_nodules", "infer_vista3d_nodule", "infer_vista3d_lung_lobes"):
        monkeypatch.setattr(neural, name, getattr(fake, name))
    for name in ("get_lung_nodule_model", "get_vista3d_model"):
        monkeypatch.setattr(neural, name, lambda: None)
    server.engine.register_volume("t16-noseg", vol, SPACING, "CT")
    try:
        res = TestClient(server.app).post("/api/v1/pipeline/lung-nodule", json={"volume_id": "t16-noseg"}).json()
        assert res["seg"] is None
        assert any("未生成 DICOM SEG" in w and "几何" in w for w in res["warnings"])
        assert res["nodules"][0]["seg_segment_number"] is None
    finally:
        server.engine.remove_volume("t16-noseg")


def test_build_seg_requires_segments_and_sources():
    with pytest.raises(SegUnavailable):
        build_nodule_seg([], {"affine_zyx_to_lps": np.eye(4).tolist(), "sop_instance_uids": ["1"]}, {"1": object()}, "v")
    with pytest.raises(SegUnavailable):
        build_nodule_seg([(1, (np.array([0]), np.array([0]), np.array([0])))],
                         {"affine_zyx_to_lps": np.eye(4).tolist(), "sop_instance_uids": None}, None, "v")
    with pytest.raises(SegUnavailable):
        build_nodule_seg([(1, (np.array([0]), np.array([0]), np.array([0])))], None, None, "v")


def test_seg_construction_error_degrades_to_warning(tmp_path, monkeypatch):
    """源图头缺少 highdicom 要求的属性：结节结果照常返回，seg 为 null 并写明原因。"""
    import dicom_seg
    real = dicom_seg.build_nodule_seg

    def broken(segments, geometry, headers, version):
        broken_headers = {}
        for uid, h in headers.items():
            c = __import__("volume_geometry").strip_pixel_data(h)
            del c.StudyInstanceUID   # Type 1，不补
            broken_headers[uid] = c
        return real(segments, geometry, broken_headers, version)

    import engine as engine_mod
    monkeypatch.setattr(engine_mod, "build_nodule_seg", broken)
    res, _, _, _, vid = _run_seg_pipeline(tmp_path, monkeypatch, True, False)
    try:
        assert res["seg"] is None
        assert any("未生成 DICOM SEG：构造失败" in w for w in res["warnings"])
        assert all(n["seg_segment_number"] is None for n in res["nodules"])
        assert all(n["segmentation"] == "vista3d" for n in res["nodules"])
    finally:
        server.engine.remove_volume(vid)


def test_missing_frame_of_reference_is_derived_and_flagged(tmp_path, monkeypatch):
    """源序列全部缺 FrameOfReferenceUID：SEG 用按 SeriesInstanceUID 派生的 UID，响应标明并给出警告；Type 2 缺失补空。"""
    import pydicom
    from dicom_seg import derived_frame_of_reference_uid
    from volume_geometry import source_headers_of
    res, _, _, entry, vid = _run_seg_pipeline(tmp_path, monkeypatch, True, False, frame_of_reference="none")
    try:
        seg = res["seg"]
        assert seg is not None and seg["frame_of_reference_derived"] is True
        assert any("FrameOfReferenceUID" in w for w in res["warnings"])
        ds = pydicom.dcmread(io.BytesIO(base64.b64decode(seg["dicom_base64"])))
        src = next(iter(source_headers_of(entry).values()))
        assert ds.FrameOfReferenceUID == derived_frame_of_reference_uid(src.SeriesInstanceUID)
        assert "FrameOfReferenceUID" not in src   # 缓存里的源图头不被修改
        assert ds.StudyID == "" and ds.ReferringPhysicianName == ""
    finally:
        server.engine.remove_volume(vid)


def test_partial_frame_of_reference_refused(tmp_path, monkeypatch):
    res, _, _, _, vid = _run_seg_pipeline(tmp_path, monkeypatch, True, False, frame_of_reference="partial")
    try:
        assert res["seg"] is None
        assert any("部分源图缺少 FrameOfReferenceUID" in w for w in res["warnings"])
    finally:
        server.engine.remove_volume(vid)
