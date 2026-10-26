"""
体积几何（volume_geometry + dicom_io）：
- 用 pydicom 生成斜位、倒序（法向朝足侧且文件顺序打乱）、非 1 mm 间距的小 DICOM 序列，
  经目录 / zip 字节 / 上传端点加载后，逐层验证 SOPInstanceUID 对应与体素 → 病人坐标换算；
- NIfTI 只有仿射；单个 DICOM 文件的几何；CachedVolume 的兼容性；结节输出的病人坐标字段。
"""
import io
import os
import random
import sys
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

import server
from dicom_io import load_volume
from resource_gate import VolumeCache
from volume_geometry import (
    CachedVolume, box_to_lps_bounds, geometry_of, geometry_summary, sop_uid_at, voxel_to_lps,
)


def _rot(axis, deg):
    t = np.deg2rad(deg)
    c, s = np.cos(t), np.sin(t)
    if axis == "x":
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if axis == "z":
        return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    raise ValueError(axis)


def make_series(tmpdir, n_slices=9, rows=20, cols=24, pixel_spacing=(0.7, 0.9), slice_gap=1.6,
                tilt_deg=12.0, inplane_deg=20.0, feet_first_normal=True, seed=0, flip_row_dir=False,
                frame_of_reference="all"):
    """
    生成一个 DICOM 序列并返回 {sop_uid: (ipp, iop, pixel_spacing, pixels)}：
    - IOP：先绕 z 转 inplane_deg、再绕 x 倾斜 tilt_deg（斜位）；feet_first_normal 时列方向取反，使法向量朝足侧；
    - 层间距 slice_gap（IPP 沿法向递增），SliceThickness 故意写成 2.0（与真实间距不同）；
    - 文件名与 InstanceNumber 都打乱，不能靠文件顺序；
    - flip_row_dir 时行方向也取反（列号增大朝患者右侧），与列方向一起构成行列翻转的源图；
    - frame_of_reference：all = 每张都有 FrameOfReferenceUID；none = 都没有；partial = 只有一部分有。
      none 时同时去掉 StudyID / ReferringPhysicianName（Type 2，模拟真实数据缺失）。
    """
    import pydicom
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage

    rng = np.random.default_rng(seed)
    rot = _rot("x", tilt_deg) @ _rot("z", inplane_deg)
    r_vec = rot @ np.array([1.0, 0.0, 0.0])
    c_vec = rot @ np.array([0.0, 1.0, 0.0])
    if feet_first_normal:
        c_vec = -c_vec
    if flip_row_dir:
        r_vec = -r_vec
    normal = np.cross(r_vec, c_vec)
    origin = np.array([-30.0, 12.5, 200.0])
    series_uid = generate_uid()
    study_uid = generate_uid()
    for_uid = generate_uid()
    truth = {}
    order = list(range(n_slices))
    random.Random(seed).shuffle(order)
    for file_idx, k in enumerate(order):
        ipp = origin + normal * slice_gap * k
        pixels = rng.integers(-1000, 1000, size=(rows, cols)).astype(np.int16)
        sop_uid = generate_uid()
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CTImageStorage
        meta.MediaStorageSOPInstanceUID = sop_uid
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = Dataset()
        ds.file_meta = meta
        ds.SOPClassUID = CTImageStorage
        ds.SOPInstanceUID = sop_uid
        ds.SeriesInstanceUID = series_uid
        ds.StudyInstanceUID = study_uid
        if frame_of_reference == "all" or (frame_of_reference == "partial" and file_idx % 2 == 0):
            ds.FrameOfReferenceUID = for_uid
        ds.PatientID = "SYN-0001"
        ds.PatientName = "Synthetic^Phantom"
        ds.PatientBirthDate = ""
        ds.PatientSex = "O"
        ds.StudyDate = "20260101"
        ds.StudyTime = "120000"
        ds.StudyID = "1"
        ds.AccessionNumber = ""
        ds.ReferringPhysicianName = ""
        ds.SeriesNumber = 2
        ds.Manufacturer = "Synthetic"
        if frame_of_reference == "none":
            del ds.StudyID
            del ds.ReferringPhysicianName
        ds.Modality = "CT"
        ds.InstanceNumber = n_slices - file_idx
        ds.ImagePositionPatient = [f"{v:.6f}" for v in ipp]
        ds.ImageOrientationPatient = [f"{v:.8f}" for v in list(r_vec) + list(c_vec)]
        ds.PixelSpacing = [str(pixel_spacing[0]), str(pixel_spacing[1])]
        ds.SliceThickness = "2.0"
        ds.Rows, ds.Columns = rows, cols
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
        ds.RescaleSlope, ds.RescaleIntercept = "1", "0"
        ds.PixelData = pixels.tobytes()
        path = os.path.join(tmpdir, f"img_{file_idx:03d}_{sop_uid[-6:]}.dcm")
        pydicom.dcmwrite(path, ds, enforce_file_format=True)
        truth[sop_uid] = {"ipp": ipp, "r": r_vec, "c": c_vec, "ps": pixel_spacing, "pixels": pixels, "k": k}
    return truth, normal


def _zip_dir(d):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for f in sorted(os.listdir(d)):
            zf.write(os.path.join(d, f), arcname=f"series/{f}")
    return buf.getvalue()


def _check_geometry(vol, spacing, geometry, truth, normal, slice_gap):
    assert geometry["frame"] == "dicom_lps" and geometry["index_order"] == "zyx"
    uids = geometry["sop_instance_uids"]
    assert len(uids) == vol.shape[0] and all(u in truth for u in uids)
    assert len(set(uids)) == vol.shape[0]
    a = np.asarray(geometry["affine_zyx_to_lps"])
    # 层间距按 IPP 投影算出（不是 SliceThickness 2.0）
    assert abs(spacing[0] - slice_gap) < 1e-3
    rng = np.random.default_rng(1)
    for k in range(vol.shape[0]):
        t = truth[uids[k]]
        # 规范化第 k 层的任意体素在病人坐标中的位置，必须落在该 SOP 图像的平面上
        for _ in range(12):
            y = int(rng.integers(0, vol.shape[1]))
            x = int(rng.integers(0, vol.shape[2]))
            p = (a @ np.array([k, y, x, 1.0]))[:3]
            d = p - t["ipp"]
            assert abs(np.dot(d, normal)) < 1e-3, "体素不在对应 SOP 图像的平面上"
            col = np.dot(d, t["r"]) / t["ps"][1]
            row = np.dot(d, t["c"]) / t["ps"][0]
            ri, ci = int(round(row)), int(round(col))
            assert abs(row - ri) < 1e-3 and abs(col - ci) < 1e-3
            # 像素值一致：说明 仿射 + SOP 对应 + 像素重排 三者一致
            assert vol[k, y, x] == t["pixels"][ri, ci]
    # 规范化 z 朝头侧：仿射 z 列的病人 Z 分量为正
    assert a[2, 0] > 0
    return uids


@pytest.mark.parametrize("feet_first_normal", [True, False])
def test_oblique_reversed_series_from_dir_and_zip(tmp_path, feet_first_normal):
    truth, normal = make_series(str(tmp_path), feet_first_normal=feet_first_normal, slice_gap=1.6)
    entry = load_volume(str(tmp_path))
    vol, spacing, modality = entry
    assert isinstance(entry, CachedVolume) and modality == "CT"
    uids_dir = _check_geometry(vol, spacing, geometry_of(entry), truth, normal, 1.6)

    z_entry = load_volume(_zip_dir(str(tmp_path)), "series.zip")
    uids_zip = _check_geometry(z_entry[0], z_entry[1], geometry_of(z_entry), truth, normal, 1.6)
    assert uids_dir == uids_zip
    # 规范化 z 从足侧到头侧：沿法向的位置随 k 单调，方向取决于法向朝向
    ks = [truth[u]["k"] for u in uids_dir]
    assert ks == (sorted(ks, reverse=True) if feet_first_normal else sorted(ks))


def test_upload_endpoint_keeps_geometry_and_pipeline_fields(tmp_path, monkeypatch):
    """/api/v1/volume/upload（zip）保留几何；缓存条目仍按三元组读取；pipeline 输出病人坐标与 SOP。"""
    truth, normal = make_series(str(tmp_path), n_slices=12, rows=40, cols=40, slice_gap=1.25)
    client = TestClient(server.app)
    vid = "t22-geom-upload"
    r = client.post("/api/v1/volume/upload", data={"volume_id": vid},
                    files={"file": ("series.zip", _zip_dir(str(tmp_path)), "application/zip")})
    try:
        assert r.status_code == 200, r.text
        assert r.json()["geometry"] == {"frame": "dicom_lps", "has_sop_uids": True}
        vol, spacing, modality = server.engine.volume_cache[vid]
        geom = server.engine.get_volume_geometry(vid)
        _check_geometry(vol, spacing, geom, truth, normal, 1.25)
        assert client.get(f"/api/v1/volume/{vid}/status").json()["ready"] is True
        r2 = client.post("/api/v1/volume/upload", data={"volume_id": vid},
                         files={"file": ("series.zip", b"ignored", "application/zip")})
        assert r2.json()["cached"] is True and r2.json()["geometry"]["has_sop_uids"] is True

        # 假检出 / 分割：结节放在规范化体素 (6, 20, 20)
        from test_lung_nodule_pipeline import FakeNeural
        center = (6, 20, 20)
        zz, yy, xx = np.ogrid[:vol.shape[0], :vol.shape[1], :vol.shape[2]]
        dz, dy, dx = spacing
        ball = ((zz - center[0]) * dz) ** 2 + ((yy - center[1]) * dy) ** 2 + ((xx - center[2]) * dx) ** 2 <= 4.0 ** 2
        nod = {"N": {"center": center, "radius": 4.0, "mask": ball, "box": [3, 14, 15, 10, 27, 26]}}
        fake = FakeNeural(nod, np.full(vol.shape, 30, dtype=np.uint8), [{"box_zyx": nod["N"]["box"], "score": 0.9}])
        neural = server.engine.neural_pipeline
        for name in ("_verified_weights", "detect_lung_nodules", "infer_vista3d_nodule", "infer_vista3d_lung_lobes"):
            monkeypatch.setattr(neural, name, getattr(fake, name))
        for name in ("get_lung_nodule_model", "get_vista3d_model"):
            monkeypatch.setattr(neural, name, lambda: None)
        res = client.post("/api/v1/pipeline/lung-nodule", json={"volume_id": vid}).json()
        assert res["series_qc"]["geometry"] == {"frame": "dicom_lps", "has_sop_uids": True}
        n = res["nodules"][0]
        a = np.asarray(geom["affine_zyx_to_lps"])
        expected = (a @ np.array(list(n["center_vox_zyx"]) + [1.0]))[:3]
        assert np.allclose(n["center_lps_mm"], expected, atol=0.01)
        assert n["key_slice_sop_instance_uid"] == geom["sop_instance_uids"][n["key_slice_z"]]
        # 关键层的 SOP 图像平面上应包含 (key_slice_z, y, x) 处的体素
        t = truth[n["key_slice_sop_instance_uid"]]
        p = (a @ np.array([n["key_slice_z"], n["center_vox_zyx"][1], n["center_vox_zyx"][2], 1.0]))[:3]
        assert abs(np.dot(p - t["ipp"], normal)) < 1e-3
        box = n["box_lps_mm"]
        assert len(box) == 6 and all(box[i] < box[i + 3] for i in range(3))
        assert all(box[i] - 0.01 <= n["center_lps_mm"][i] <= box[i + 3] + 0.01 for i in range(3))
    finally:
        server.engine.remove_volume(vid)


def test_nifti_has_affine_without_sop(tmp_path):
    import nibabel as nib
    data = np.arange(4 * 5 * 6, dtype=np.float32).reshape(4, 5, 6)  # (X, Y, Z) 文件数组
    aff = np.array([[-0.8, 0, 0, 10.0], [0, 0.9, 0, -20.0], [0, 0, 2.5, 30.0], [0, 0, 0, 1]])  # RAS
    path = str(tmp_path / "t.nii.gz")
    nib.save(nib.Nifti1Image(data, aff), path)
    entry = load_volume(path)
    vol, spacing, _ = entry
    g = geometry_of(entry)
    assert g["frame"] == "dicom_lps" and g["sop_instance_uids"] is None
    assert geometry_summary(g) == {"frame": "dicom_lps", "has_sop_uids": False}
    a = np.asarray(g["affine_zyx_to_lps"])
    # 每个规范化体素 → LPS，再换回 RAS → 文件体素下标，值必须一致
    inv = np.linalg.inv(aff)
    for z, y, x in [(0, 0, 0), (5, 4, 3), (2, 1, 3), (3, 4, 0)]:
        lps = a @ np.array([z, y, x, 1.0])
        ras = np.array([-lps[0], -lps[1], lps[2], 1.0])
        i, j, k = [int(round(v)) for v in (inv @ ras)[:3]]
        assert vol[z, y, x] == data[i, j, k]


def test_single_dicom_file_geometry(tmp_path):
    truth, _ = make_series(str(tmp_path), n_slices=1, tilt_deg=0, inplane_deg=0, feet_first_normal=False)
    (uid, t), = truth.items()
    f = os.path.join(str(tmp_path), os.listdir(str(tmp_path))[0])
    entry = load_volume(f)
    vol, _, _ = entry
    g = geometry_of(entry)
    assert g["sop_instance_uids"] == [uid] and g["frame_numbers"] is None
    p = voxel_to_lps(g, (0, 3, 5))
    expected = t["ipp"] + 5 * t["ps"][1] * t["r"] + 3 * t["ps"][0] * t["c"]
    assert np.allclose(p, expected, atol=0.01)
    assert vol[0, 3, 5] == t["pixels"][3, 5]


def test_cached_volume_compat_and_cache_bytes():
    vol = np.zeros((4, 8, 8), dtype=np.float32)
    entry = CachedVolume(vol, (1.0, 1.0, 1.0), "CT", {"frame": "dicom_lps"})
    v, sp, mod = entry
    assert v is vol and mod == "CT" and len(entry) == 3 and entry[0] is vol
    cache = VolumeCache(max_bytes=10 ** 9)
    cache["a"] = entry
    cache["b"] = (vol, (1.0, 1.0, 1.0), "CT")
    assert cache.status()["volumes"] == 2
    assert cache._bytes == 2 * vol.nbytes
    assert geometry_of(cache["a"]) == {"frame": "dicom_lps"} and geometry_of(cache["b"]) is None
    # 没有几何时的换算结果为 None
    assert voxel_to_lps(None, (0, 0, 0)) is None and box_to_lps_bounds(None, [0, 0, 0, 1, 1, 1]) is None
    assert sop_uid_at(None, 0) is None
    assert geometry_summary(None) == {"frame": None, "has_sop_uids": False}


def test_sagittal_acquisition_has_affine_but_no_sop_per_z(tmp_path):
    """矢状位采集：规范化 z 轴与切片法向不平行，一层不对应一张原图，SOP 列表为空并写明原因。"""
    import pydicom
    truth, _ = make_series(str(tmp_path), n_slices=6, tilt_deg=0, inplane_deg=0, feet_first_normal=False)
    for f in os.listdir(str(tmp_path)):
        p = os.path.join(str(tmp_path), f)
        ds = pydicom.dcmread(p)
        k = truth[ds.SOPInstanceUID]["k"]
        # 行方向 = 前→后 (0,1,0)，列方向 = 头→足 (0,0,-1)：法向量沿 X
        ds.ImageOrientationPatient = ["0", "1", "0", "0", "0", "-1"]
        ds.ImagePositionPatient = [f"{1.6 * k:.3f}", "0", "0"]
        ds.save_as(p)
    entry = load_volume(str(tmp_path))
    g = geometry_of(entry)
    assert g["frame"] == "dicom_lps" and g["sop_instance_uids"] is None
    assert "非轴位" in g["note"]
