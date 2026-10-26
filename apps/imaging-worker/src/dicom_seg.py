"""
把结节分割写成 DICOM SEG（highdicom），供平台存回 Orthanc、由 OHIF 原生显示轮廓。

- 掩码从规范化体积逐张映射回源图：规范化体素 (z, y, x) 经 affine_zyx_to_lps 得到病人坐标，
  再用该层对应源图自己的 ImagePositionPatient / ImageOrientationPatient / PixelSpacing 求出 (行, 列)。
  不假设规范化后的 y/x 与源图的行/列方向一致（源图可以是斜位、行列翻转或倒序）。
- 每个成功分割的结节一个 segment，SegmentationType = BINARY。
- 编码取自 pydicom 3.0.2 自带的 DICOM 编码表（pydicom/sr/_concepts_dict.py、_cid_dict.py）：
  segmented_property_category = SCT 49755003 "Morphologically Abnormal Structure"（CID 7150 Segmentation Property Category）
  segmented_property_type     = SCT 27925004 "Nodule"（CID 7151 Segmentation Property Type）
  anatomic_region             = SCT 39607008 "Lung"
  算法家族                     = DCM 123110 "Artificial Intelligence"（CID 7162）
"""
import base64
import io
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

SEG_SERIES_DESCRIPTION = "Heurion AI lung nodules"
SEG_MANUFACTURER = "Heurion"
SEG_ALGORITHM_NAME = "lung_nodule_pipeline"
SEG_SERIES_NUMBER = 9701


# highdicom 从源图直接读取的患者 / 检查属性中，DICOM 规定为 Type 2（可为空）的那些：源图缺失时在副本上补空值
_TYPE2_FILL = (
    "PatientID", "PatientName", "PatientBirthDate", "PatientSex",
    "StudyID", "StudyDate", "StudyTime", "AccessionNumber", "ReferringPhysicianName",
)


def derived_frame_of_reference_uid(series_instance_uid: str) -> str:
    """源序列缺 FrameOfReferenceUID 时，由其 SeriesInstanceUID 确定性派生（2.25 + UUIDv5），同一序列每次相同。"""
    import uuid
    return "2.25." + str(uuid.uuid5(uuid.NAMESPACE_OID, "heurion-for:" + str(series_instance_uid)).int)


def prepare_source_headers(headers: Sequence[Any]) -> Tuple[List[Any], bool]:
    """
    给 highdicom 用的源图头副本（不改缓存里的原件）：
    - Type 2 属性缺失时补空值（符合 DICOM：Type 2 可为空）；
    - 全部源图都缺 FrameOfReferenceUID（CT 图像中为 Type 1，源序列本身不合规）时，按 SeriesInstanceUID 派生一个，
      并返回 derived=True 供调用方在响应里写明；部分缺失则拒绝生成。
    """
    try:
        from .volume_geometry import strip_pixel_data
    except (ImportError, ValueError):
        from volume_geometry import strip_pixel_data
    has_for = [bool(getattr(h, "FrameOfReferenceUID", "")) for h in headers]
    if any(has_for) and not all(has_for):
        raise SegUnavailable("部分源图缺少 FrameOfReferenceUID，不能生成 DICOM SEG")
    derived = not any(has_for)
    out = []
    for h in headers:
        c = strip_pixel_data(h)
        for kw in _TYPE2_FILL:
            if kw not in c:
                setattr(c, kw, "")
        if derived:
            c.FrameOfReferenceUID = derived_frame_of_reference_uid(c.SeriesInstanceUID)
        out.append(c)
    return out, derived


class SegUnavailable(Exception):
    """不能生成 SEG（源图信息缺失、多帧源图、没有可写入的分割等）；消息写进响应 warnings。"""


def _floats(raw: Any, n: int) -> Optional[np.ndarray]:
    try:
        if raw is not None and len(raw) >= n:
            return np.array([float(str(v).replace(",", ".")) for v in raw[:n]], dtype=np.float64)
    except Exception:
        pass
    return None


def map_mask_to_source_frames(
    voxels_zyx: Tuple[np.ndarray, np.ndarray, np.ndarray],
    geometry: Dict[str, Any],
    source_headers: Dict[str, Any],
) -> Dict[str, Tuple[np.ndarray, np.ndarray]]:
    """
    规范化体积中的体素 (zz, yy, xx) → {SOPInstanceUID: (rows, cols)}，行列号属于该 SOP 源图本身。
    映射不是整数像素（偏差 > 0.01 像素）或越界时报错，避免把掩码写错位置。
    """
    a = np.asarray(geometry["affine_zyx_to_lps"], dtype=np.float64)
    uids = geometry.get("sop_instance_uids") or []
    zz, yy, xx = [np.asarray(v, dtype=np.int64) for v in voxels_zyx]
    out: Dict[str, List[np.ndarray]] = {}
    for k in np.unique(zz):
        k = int(k)
        uid = uids[k] if 0 <= k < len(uids) else None
        if uid is None or uid not in source_headers:
            raise SegUnavailable(f"规范化第 {k} 层没有对应的源图（SOPInstanceUID 缺失）")
        hdr = source_headers[uid]
        ipp = _floats(getattr(hdr, "ImagePositionPatient", None), 3)
        iop = _floats(getattr(hdr, "ImageOrientationPatient", None), 6)
        ps = _floats(getattr(hdr, "PixelSpacing", None), 2)
        if ipp is None or iop is None or ps is None:
            raise SegUnavailable(f"源图 {uid} 缺少 IPP / IOP / PixelSpacing")
        r_vec, c_vec = iop[:3], iop[3:]
        sel = zz == k
        pts = np.stack([zz[sel], yy[sel], xx[sel], np.ones(int(sel.sum()), dtype=np.int64)], axis=0).astype(np.float64)
        lps = (a @ pts)[:3].T - ipp
        rows_f = lps @ c_vec / ps[0]
        cols_f = lps @ r_vec / ps[1]
        rows, cols = np.rint(rows_f).astype(np.int64), np.rint(cols_f).astype(np.int64)
        if np.max(np.abs(rows_f - rows)) > 0.01 or np.max(np.abs(cols_f - cols)) > 0.01:
            raise SegUnavailable(f"规范化体素映射到源图 {uid} 时不落在整数像素上（源图与规范化网格不对齐）")
        n_rows, n_cols = int(hdr.Rows), int(hdr.Columns)
        if rows.min() < 0 or cols.min() < 0 or rows.max() >= n_rows or cols.max() >= n_cols:
            raise SegUnavailable(f"规范化体素映射到源图 {uid} 时越界")
        prev = out.get(uid)
        if prev is None:
            out[uid] = [rows, cols]
        else:
            out[uid] = [np.concatenate([prev[0], rows]), np.concatenate([prev[1], cols])]
    return {u: (v[0], v[1]) for u, v in out.items()}


def build_nodule_seg(
    segments: Sequence[Tuple[int, Tuple[np.ndarray, np.ndarray, np.ndarray]]],
    geometry: Optional[Dict[str, Any]],
    source_headers: Optional[Dict[str, Any]],
    model_version: str,
) -> Dict[str, Any]:
    """
    segments：[(结节编号, 规范化体素下标 (zz, yy, xx))]，按结节编号顺序；segment_number 从 1 开始依次编号。
    返回 {"dicom_base64", "series_instance_uid", "sop_instance_uid", "segments": [{"segment_number", "nodule_index"}],
          "size_bytes", "referenced_instances"}。不能生成时抛 SegUnavailable。
    """
    import highdicom as hd
    from pydicom.sr.codedict import codes

    if not geometry or geometry.get("affine_zyx_to_lps") is None:
        raise SegUnavailable("体积没有病人坐标几何（非 DICOM 来源），不能生成 DICOM SEG")
    if not source_headers or not geometry.get("sop_instance_uids") or all(u is None for u in geometry["sop_instance_uids"]):
        raise SegUnavailable("体积没有逐层对应的源图 SOPInstanceUID / 头信息（NIfTI 或非轴位采集），不能生成 DICOM SEG")
    if geometry.get("frame_numbers"):
        raise SegUnavailable("源图为多帧 DICOM，暂不支持生成 SEG")
    if not segments:
        raise SegUnavailable("没有成功分割（segmentation = vista3d）的结节，未生成 DICOM SEG")

    # 每个 segment 映射到源图（行, 列）
    per_segment: List[Dict[str, Tuple[np.ndarray, np.ndarray]]] = []
    used_uids: set = set()
    for _, vox in segments:
        mapped = map_mask_to_source_frames(vox, geometry, source_headers)
        per_segment.append(mapped)
        used_uids.update(mapped.keys())

    # 源图按规范化 z 顺序排列，只取含有分割的图像（highdicom 要求 pixel_array 帧与 source_images 一一对应）
    order = [u for u in geometry["sop_instance_uids"] if u in used_uids]
    seen: set = set()
    order = [u for u in order if not (u in seen or seen.add(u))]
    src, for_derived = prepare_source_headers([source_headers[u] for u in order])
    rows, cols = int(src[0].Rows), int(src[0].Columns)
    if any(int(h.Rows) != rows or int(h.Columns) != cols for h in src):
        raise SegUnavailable("源图行列数不一致，不能生成 DICOM SEG")
    pos = {u: i for i, u in enumerate(order)}
    pixel = np.zeros((len(order), rows, cols, len(segments)), dtype=bool)
    for s_i, mapped in enumerate(per_segment):
        for uid, (rr, cc) in mapped.items():
            pixel[pos[uid], rr, cc, s_i] = True

    algo = hd.AlgorithmIdentificationSequence(
        name=SEG_ALGORITHM_NAME, family=codes.cid7162.ArtificialIntelligence, version=str(model_version),
    )
    descriptions = []
    seg_list = []
    for s_i, (nodule_index, _) in enumerate(segments, start=1):
        descriptions.append(hd.seg.SegmentDescription(
            segment_number=s_i,
            segment_label=f"Nodule {int(nodule_index)}",
            segmented_property_category=codes.SCT.MorphologicallyAbnormalStructure,
            segmented_property_type=codes.SCT.Nodule,
            algorithm_type=hd.seg.SegmentAlgorithmTypeValues.AUTOMATIC,
            algorithm_identification=algo,
            anatomic_regions=[codes.SCT.Lung],
            # 推荐显示色（黄色，肺窗上醒目）：OHIF 等阅片器缺这一项会提示并改用默认色
            display_color=hd.color.CIELabColor.from_rgb(255, 210, 0),
        ))
        seg_list.append({"segment_number": s_i, "nodule_index": int(nodule_index)})

    series_uid = hd.UID()
    sop_uid = hd.UID()
    seg = hd.seg.Segmentation(
        source_images=src,
        pixel_array=pixel,
        segmentation_type=hd.seg.SegmentationTypeValues.BINARY,
        segment_descriptions=descriptions,
        series_instance_uid=series_uid,
        series_number=SEG_SERIES_NUMBER,
        sop_instance_uid=sop_uid,
        instance_number=1,
        manufacturer=SEG_MANUFACTURER,
        manufacturer_model_name=SEG_ALGORITHM_NAME,
        software_versions=str(model_version),
        device_serial_number="N/A",
        series_description=SEG_SERIES_DESCRIPTION,
        content_label="NODULES",
        content_description="Heurion lung nodule segmentation",
    )
    buf = io.BytesIO()
    seg.save_as(buf)
    raw = buf.getvalue()
    return {
        "dicom_base64": base64.b64encode(raw).decode("ascii"),
        "series_instance_uid": str(series_uid),
        "sop_instance_uid": str(sop_uid),
        "segments": seg_list,
        "size_bytes": len(raw),
        "referenced_instances": len(order),
        "frame_of_reference_derived": for_derived,
    }
