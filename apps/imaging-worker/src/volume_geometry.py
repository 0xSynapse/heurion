"""
体积几何：把规范化体积的体素下标对应回 DICOM 病人坐标与具体 DICOM 图像。

约定
- 仿射 affine_zyx_to_lps（4×4）：列向量 [z, y, x, 1]（规范化体积的体素下标，体素中心为整数，
  与 vol[z, y, x] 的下标顺序相同）→ [X, Y, Z, 1]，DICOM 病人坐标系（LPS：+X 患者左、+Y 后、+Z 头侧），单位 mm。
  DICOM 来源时由 ImageOrientationPatient / ImagePositionPatient / PixelSpacing 推出；
  NIfTI 来源时由文件仿射（RAS）换算到 LPS。
- sop_instance_uids：长度 = 规范化体积的 z 层数，第 k 项是规范化 z = k 那一层对应的 SOPInstanceUID。
  按每帧 ImagePositionPatient 在切片法向量上的投影与规范化 z 层的投影匹配，不依赖文件顺序；匹配不上为 None。
  多帧 DICOM 的各帧共用一个 SOPInstanceUID，frame_numbers 给出 1 起始的帧号（单帧图像为 None）。
  NIfTI 没有 SOP 列表（None）。
"""
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

# RAS 世界坐标 ↔ LPS 世界坐标
_RAS_TO_LPS = np.diag([-1.0, -1.0, 1.0, 1.0])
# 规范化体积的 (x, y, z) 下标列 → (z, y, x) 下标列
_XYZ_TO_ZYX_COLS = [2, 1, 0, 3]


class CachedVolume(tuple):
    """
    体积缓存的值：仍是三元组 (volume, spacing, modality)，原有的 `vol, spacing, modality = ...` 解包与
    VolumeCache 的字节计数（取 entry[0]）都不变；几何信息挂在 .geometry 属性上（没有时为 None）。
    source_headers：{SOPInstanceUID: 去掉 PixelData 的 pydicom 头}，生成 DICOM SEG 时用作源图；
    NIfTI 或非 DICOM 来源为 None。这些头含患者信息，只留在 worker 内存里，不进任何响应。
    """

    def __new__(cls, volume: np.ndarray, spacing: Tuple[float, float, float], modality: str,
                geometry: Optional[Dict[str, Any]] = None, source_headers: Optional[Dict[str, Any]] = None):
        obj = super().__new__(cls, (volume, spacing, modality))
        obj.geometry = geometry
        obj.source_headers = source_headers
        return obj

    def __getnewargs__(self):
        return (self[0], self[1], self[2], self.geometry, self.source_headers)


def geometry_of(entry: Any) -> Optional[Dict[str, Any]]:
    return getattr(entry, "geometry", None)


def source_headers_of(entry: Any) -> Optional[Dict[str, Any]]:
    return getattr(entry, "source_headers", None)


def strip_pixel_data(ds: Any) -> Any:
    """复制 pydicom 数据集的全部元素（及 file_meta），但不带 PixelData 等像素元素，用作 SEG 的源图头。"""
    import pydicom
    pixel_tags = {0x7FE00010, 0x7FE00008, 0x7FE00009}
    hdr = pydicom.Dataset()
    for elem in ds:
        if int(elem.tag) not in pixel_tags:
            hdr.add(elem)
    if getattr(ds, "file_meta", None) is not None:
        hdr.file_meta = ds.file_meta
    return hdr


def canonical_affine_from_ras(affine_ras_xyz: np.ndarray) -> np.ndarray:
    """
    spatial_canonicalizer.to_canonical_lps 返回的仿射（规范化数组 (x, y, z) 下标 → RAS 世界坐标）
    换成本模块约定的 affine_zyx_to_lps（(z, y, x) 下标 → DICOM LPS 世界坐标）。
    """
    a = _RAS_TO_LPS @ np.asarray(affine_ras_xyz, dtype=np.float64)
    return a[:, _XYZ_TO_ZYX_COLS]


def match_sop_uids(
    affine_zyx_to_lps: np.ndarray,
    n_slices: int,
    frame_positions: Sequence[Sequence[float]],
    frame_uids: Sequence[Optional[str]],
    frame_numbers: Sequence[Optional[int]],
    slice_normal: Sequence[float],
) -> Tuple[Optional[List[Optional[str]]], Optional[List[Optional[int]]], Optional[str]]:
    """
    规范化 z 层 ↔ 原始帧匹配：两者都投影到切片法向量上，取最近的帧，偏差须小于半个层间距。
    规范化 z 轴与切片法向量不平行（矢状/冠状采集，规范化后一层不对应一张原图）时返回 (None, None, 原因)。
    """
    a = np.asarray(affine_zyx_to_lps, dtype=np.float64)
    n = np.asarray(slice_normal, dtype=np.float64)
    n = n / max(np.linalg.norm(n), 1e-12)
    col_z, col_y, col_x = a[:3, 0], a[:3, 1], a[:3, 2]
    step = float(np.dot(n, col_z))
    if abs(step) < 1e-6 or abs(step) < 0.99 * np.linalg.norm(col_z) \
            or abs(np.dot(n, col_y)) > 1e-3 * max(np.linalg.norm(col_y), 1e-6) \
            or abs(np.dot(n, col_x)) > 1e-3 * max(np.linalg.norm(col_x), 1e-6):
        return None, None, "规范化 z 轴与原始切片法向量不平行（非轴位采集），无法逐层对应 SOPInstanceUID"
    proj_frames = np.array([float(np.dot(n, np.asarray(p, dtype=np.float64))) for p in frame_positions])
    origin = float(np.dot(n, a[:3, 3]))
    tol = 0.5 * abs(step)
    uids: List[Optional[str]] = []
    frames: List[Optional[int]] = []
    unmatched = 0
    for k in range(int(n_slices)):
        d = origin + k * step
        i = int(np.argmin(np.abs(proj_frames - d))) if len(proj_frames) else -1
        if i >= 0 and abs(proj_frames[i] - d) <= tol:
            uids.append(frame_uids[i])
            frames.append(frame_numbers[i])
        else:
            uids.append(None)
            frames.append(None)
            unmatched += 1
    note = f"{unmatched} 层未匹配到原始图像（层间距不均匀或缺层）" if unmatched else None
    return uids, frames, note


def make_geometry(
    affine_zyx_to_lps: Optional[np.ndarray],
    source: str,
    sop_instance_uids: Optional[List[Optional[str]]] = None,
    frame_numbers: Optional[List[Optional[int]]] = None,
    series_instance_uid: Optional[str] = None,
    note: Optional[str] = None,
) -> Dict[str, Any]:
    has_frames = frame_numbers is not None and any(f is not None for f in frame_numbers)
    return {
        "frame": "dicom_lps" if affine_zyx_to_lps is not None else None,
        "index_order": "zyx",
        "affine_zyx_to_lps": None if affine_zyx_to_lps is None else np.asarray(affine_zyx_to_lps, dtype=np.float64).tolist(),
        "source": source,
        "series_instance_uid": series_instance_uid,
        "sop_instance_uids": sop_instance_uids,
        "frame_numbers": frame_numbers if has_frames else None,
        "note": note,
    }


def voxel_to_lps(geometry: Optional[Dict[str, Any]], zyx: Sequence[float]) -> Optional[List[float]]:
    """规范化体素下标 (z, y, x)（可为小数）→ DICOM LPS 病人坐标 [X, Y, Z]（mm，保留 2 位小数）。"""
    if not geometry or geometry.get("affine_zyx_to_lps") is None:
        return None
    a = np.asarray(geometry["affine_zyx_to_lps"], dtype=np.float64)
    p = a @ np.array([float(zyx[0]), float(zyx[1]), float(zyx[2]), 1.0])
    return [round(float(v), 2) for v in p[:3]]


def box_to_lps_bounds(geometry: Optional[Dict[str, Any]], box_zyx: Sequence[int]) -> Optional[List[float]]:
    """
    左闭右开体素框 [z0, y0, x0, z1, y1, x1] 的 8 个角点（取体素边界：起点 -0.5、终点 -0.5）换算到 LPS 后的
    轴对齐包围盒 [xmin, ymin, zmin, xmax, ymax, zmax]（mm）。
    """
    if not geometry or geometry.get("affine_zyx_to_lps") is None:
        return None
    a = np.asarray(geometry["affine_zyx_to_lps"], dtype=np.float64)
    z0, y0, x0, z1, y1, x1 = [float(v) for v in box_zyx]
    pts = []
    for z in (z0 - 0.5, z1 - 0.5):
        for y in (y0 - 0.5, y1 - 0.5):
            for x in (x0 - 0.5, x1 - 0.5):
                pts.append((a @ np.array([z, y, x, 1.0]))[:3])
    pts = np.array(pts)
    return [round(float(v), 2) for v in list(pts.min(axis=0)) + list(pts.max(axis=0))]


def sop_uid_at(geometry: Optional[Dict[str, Any]], z: int) -> Optional[str]:
    if not geometry or not geometry.get("sop_instance_uids"):
        return None
    uids = geometry["sop_instance_uids"]
    return uids[int(z)] if 0 <= int(z) < len(uids) else None


def frame_number_at(geometry: Optional[Dict[str, Any]], z: int) -> Optional[int]:
    if not geometry or not geometry.get("frame_numbers"):
        return None
    fr = geometry["frame_numbers"]
    return fr[int(z)] if 0 <= int(z) < len(fr) else None


def geometry_summary(geometry: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """响应里 series_qc.geometry 的摘要。"""
    uids = (geometry or {}).get("sop_instance_uids")
    return {
        "frame": (geometry or {}).get("frame"),
        "has_sop_uids": bool(uids) and any(u is not None for u in uids),
    }
