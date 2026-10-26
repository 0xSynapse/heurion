"""
肺结节模型链（lung_nodule_pipeline）：
1. 层厚质控（> 2.5 mm 只警告、不拒绝）；
2. MONAI lung_nodule_ct_detection（RetinaNet）多结节检出，按中心距去重；
3. 每个检出框以框中心为 VISTA-3D 正点提示做分割，只保留与检出框重叠的连通域；
4. 测量：长径、短径、平均径、体积、HU 均值/标准差、密度分型、实性成分直径、CTR；
5. VISTA-3D 肺叶类别分割做肺叶定位。

只输出模型与测量的真实结果：分割失败时如实标注 segmentation="failed"，测量退回检出框径并写明，
不以规则法或其他模型替代；权重不可用时由 MonaiNeuralInferencePipeline 抛出 ModelUnavailableError（HTTP 501）。
本模块不导入 engine（避免循环导入），通过参数接收 engine.MonaiNeuralInferencePipeline 实例。
"""
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import scipy.ndimage as ndi

try:
    from .recist import calculate_subsolid_metrics
    from .volume_geometry import box_to_lps_bounds, geometry_summary, sop_uid_at, voxel_to_lps
except (ImportError, ValueError):
    from recist import calculate_subsolid_metrics
    from volume_geometry import box_to_lps_bounds, geometry_summary, sop_uid_at, voxel_to_lps


PIPELINE_ID = "lung_nodule_pipeline"
DETECTOR_REGISTRY_NAME = "lung_nodule_ct"
SEGMENTER_REGISTRY_NAME = "vista3d"

# 层厚质控阈值：超过即在 series_qc.warnings 里提示（不拒绝分析）
THICK_SLICE_LIMIT_MM = 2.5

# VISTA-3D 全局类别号 -> 肺叶缩写。来源：vista3d_v0.5.7 bundle 的 docs/labels.json
# （"left lung upper lobe": 28, "left lung lower lobe": 29, "right lung upper lobe": 30,
#   "right lung middle lobe": 31, "right lung lower lobe": 32），configs/inference.json 的 subclass["20"] 亦为 [28..32]。
VISTA3D_LUNG_LOBE_LABELS: Dict[int, str] = {
    28: "LUL",
    29: "LLL",
    30: "RUL",
    31: "RML",
    32: "RLL",
}

# 结节中心体素未落在任何肺叶内时，向外搜索的额外半径（mm）
LOBE_SEARCH_MARGIN_MM = 5.0

# 分割长径超过检出框轴位长边的该倍数时判为过分割（常见于假阳性小框上点提示扩散到肺实质/血管），不采用该分割
OVERSEGMENTATION_RATIO = 2.0

ALLOWED_NODULE_TYPES = ("solid", "part_solid", "pure_ggo")


# ---------------------------------------------------------------------------
# 基础几何
# ---------------------------------------------------------------------------

def _version_tag(status: Dict[str, Any]) -> str:
    """登记版本 "v0.5.9" -> "0.5.9"。"""
    v = str(status.get("version") or "unknown")
    return v[1:] if v.startswith("v") else v


def box_center_zyx(box: List[int]) -> List[int]:
    """左闭右开体素框 [z0, y0, x0, z1, y1, x1] 的中心体素（与 infer_lung_nodule_ct 的中心定义一致）。"""
    z0, y0, x0, z1, y1, x1 = [int(v) for v in box]
    return [int(round((z0 + z1 - 1) / 2.0)), int(round((y0 + y1 - 1) / 2.0)), int(round((x0 + x1 - 1) / 2.0))]


def box_extent_mm(box: List[int], spacing: Tuple[float, float, float]) -> Tuple[float, float, float]:
    """检出框在 z、y、x 三个方向的物理边长（mm）。"""
    z0, y0, x0, z1, y1, x1 = [int(v) for v in box]
    dz, dy, dx = [float(s) for s in spacing]
    return (z1 - z0) * dz, (y1 - y0) * dy, (x1 - x0) * dx


def box_radius_mm(box: List[int], spacing: Tuple[float, float, float]) -> float:
    """检出框的等效半径：三个方向物理边长的均值 / 2。"""
    return float(np.mean(box_extent_mm(box, spacing))) / 2.0


def center_distance_mm(c1: List[float], c2: List[float], spacing: Tuple[float, float, float]) -> float:
    d = (np.asarray(c1, dtype=np.float64) - np.asarray(c2, dtype=np.float64)) * np.asarray(spacing, dtype=np.float64)
    return float(np.sqrt(np.sum(d ** 2)))


# ---------------------------------------------------------------------------
# 质控 / 去重
# ---------------------------------------------------------------------------

def series_quality_control(
    shape: Tuple[int, ...], spacing: Tuple[float, float, float], modality: Optional[str] = None
) -> Dict[str, Any]:
    """
    序列质控。worker 的体积只携带体素间距，层厚取 z 方向间距（slice_thickness_source 标明来源）。
    层厚 > 2.5 mm 时写入警告，但不拒绝分析。
    """
    dz, dy, dx = [float(s) for s in spacing]
    thickness = round(dz, 3)
    warnings: List[str] = []
    if thickness > THICK_SLICE_LIMIT_MM:
        warnings.append(
            f"层厚 {thickness} mm > {THICK_SLICE_LIMIT_MM} mm：部分容积效应会使小结节、磨玻璃及实性成分的测值偏差增大，"
            "检出灵敏度也可能下降；建议使用 ≤1.25 mm 薄层重建复核。"
        )
    if modality and str(modality).upper() != "CT":
        warnings.append(f"输入模态为 {modality}，本模型链只针对胸部 CT 训练与设计。")
    return {
        "slice_thickness_mm": thickness,
        "slice_thickness_source": "z_spacing",
        "spacing_mm": [round(dz, 4), round(dy, 4), round(dx, 4)],
        "shape": [int(s) for s in shape],
        "warnings": warnings,
    }


def deduplicate_detections(
    detections: List[Dict[str, Any]], spacing: Tuple[float, float, float]
) -> Tuple[List[Dict[str, Any]], int]:
    """
    去重：两个检出中心的物理距离小于两者半径的平均值时视为同一结节，保留分数高者。
    按分数降序贪心处理；返回 (保留的检出, 被合并掉的个数)。
    """
    ordered = sorted(detections, key=lambda d: -float(d["score"]))
    kept: List[Dict[str, Any]] = []
    merged = 0
    for det in ordered:
        c = box_center_zyx(det["box_zyx"])
        r = box_radius_mm(det["box_zyx"], spacing)
        duplicate = False
        for k in kept:
            ck = box_center_zyx(k["box_zyx"])
            rk = box_radius_mm(k["box_zyx"], spacing)
            if center_distance_mm(c, ck, spacing) < (r + rk) / 2.0:
                duplicate = True
                break
        if duplicate:
            merged += 1
        else:
            kept.append(det)
    return kept, merged


# ---------------------------------------------------------------------------
# 分割后处理与测量
# ---------------------------------------------------------------------------

def mask_touches_window(mask: np.ndarray, window_zyx: Any, dims: Tuple[int, ...]) -> bool:
    """
    结节掩码是否碰到 VISTA-3D 推理窗口的边界（可能被截断）。window_zyx = [lo, hi]（规范化体素下标，hi 不含）；
    窗口边界就是体积边缘的那一侧不算（体积外本来就没有内容）。
    只看已挑出的结节掩码：VISTA-3D 原始输出里常有血管等无关连通域碰到窗口边界，不能据此判断结节被截断。
    """
    if not mask.any():
        return False
    lo, hi = window_zyx
    idx = np.nonzero(mask)
    for a in range(3):
        if (lo[a] > 0 and int(idx[a].min()) <= lo[a]) or (hi[a] < dims[a] and int(idx[a].max()) >= hi[a] - 1):
            return True
    return False


def select_components_overlapping_box(mask: np.ndarray, box: List[int]) -> np.ndarray:
    """只保留与检出框有重叠的三维连通域（26 邻接）。"""
    binary = np.asarray(mask) > 0
    if not binary.any():
        return np.zeros(binary.shape, dtype=np.uint8)
    labeled, n = ndi.label(binary, structure=np.ones((3, 3, 3), dtype=bool))
    if n == 0:
        return np.zeros(binary.shape, dtype=np.uint8)
    z0, y0, x0, z1, y1, x1 = [int(v) for v in box]
    inside = np.unique(labeled[z0:z1, y0:y1, x0:x1])
    inside = inside[inside > 0]
    if inside.size == 0:
        return np.zeros(binary.shape, dtype=np.uint8)
    return np.isin(labeled, inside).astype(np.uint8)


def _mean_diameter(long_mm: Optional[float], short_mm: Optional[float]) -> Optional[float]:
    """平均径 = (长径 + 短径) / 2，保留 1 位小数（Lung-RADS v2022 习惯）。"""
    if long_mm is None or short_mm is None:
        return None
    return round((float(long_mm) + float(short_mm)) / 2.0, 1)


def measure_segmented_nodule(
    volume: np.ndarray, mask: np.ndarray, spacing: Tuple[float, float, float], box: List[int]
) -> Tuple[Optional[Dict[str, Any]], Optional[int], List[str]]:
    """
    在分割掩膜上测量。长径/短径取 recist.calculate_recist_metrics 的定义（分割面积最大的轴位层上的最大径与其垂直径），
    分型与实性成分取 recist.calculate_subsolid_metrics。实性成分直径与 CTR 只对 part_solid 输出。
    掩膜在关键层不足两个体素、无法测径时返回 (None, None, 警告)，由调用方按分割失败处理。
    """
    warnings: List[str] = []
    dz, dy, dx = [float(s) for s in spacing]
    nodule = mask > 0
    sub = calculate_subsolid_metrics(volume, mask.astype(np.uint8), spacing=spacing)
    long_mm = sub.get("longest_diameter_mm")
    short_mm = sub.get("short_axis_mm")
    if not sub.get("has_lesion") or not long_mm:
        return None, None, ["分割掩膜过小（关键层不足两个体素），无法测径"]

    hu = volume[nodule].astype(np.float64)
    nodule_type = sub.get("nodule_type")
    if nodule_type not in ALLOWED_NODULE_TYPES:
        if nodule_type == "suspected_vessel":
            warnings.append("密度分型未输出：" + str(sub.get("measurement_note") or "启发式判定为疑似血管截面"))
        else:
            warnings.append(f"密度分型未输出（{sub.get('nodule_type_zh') or nodule_type}）")
        nodule_type = None

    solid_core = None
    ctr = None
    if nodule_type == "part_solid":
        solid_core = sub.get("solid_core_diameter_mm")
        ctr = sub.get("consolidation_tumor_ratio")

    # 与检出框对比：长径远超框径视为过分割，不采用（由调用方退回框径）
    box_long = max(box_extent_mm(box, spacing)[1:])
    if box_long > 0 and float(long_mm) > OVERSEGMENTATION_RATIO * box_long:
        return None, None, [
            f"分割长径 {long_mm} mm 超过检出框轴位长边 {round(box_long, 1)} mm 的 {OVERSEGMENTATION_RATIO:g} 倍，"
            "疑似沿肺实质、血管或胸膜过分割，未采用该分割"
        ]

    metrics = {
        "long_axis_mm": float(long_mm),
        "short_axis_mm": float(short_mm),
        "mean_diameter_mm": _mean_diameter(long_mm, short_mm),
        "volume_mm3": round(float(np.sum(nodule)) * dz * dy * dx, 1),
        "mean_hu": round(float(np.mean(hu)), 1),
        "std_hu": round(float(np.std(hu)), 1),
        "nodule_type": nodule_type,
        "solid_core_diameter_mm": solid_core,
        "ctr": ctr,
    }
    return metrics, int(sub.get("key_slice_index", 0)), warnings


def box_fallback_metrics(box: List[int], spacing: Tuple[float, float, float]) -> Tuple[Dict[str, Any], int, List[str]]:
    """分割失败时的退回测量：只给检出框的轴位面边长（长边/短边），体积、HU、分型一律为空。"""
    _, ey, ex = box_extent_mm(box, spacing)
    long_mm = round(max(ey, ex), 1)
    short_mm = round(min(ey, ex), 1)
    metrics = {
        "long_axis_mm": long_mm,
        "short_axis_mm": short_mm,
        "mean_diameter_mm": _mean_diameter(long_mm, short_mm),
        "volume_mm3": None,
        "mean_hu": None,
        "std_hu": None,
        "nodule_type": None,
        "solid_core_diameter_mm": None,
        "ctr": None,
    }
    note = "长径/短径/平均径为 RetinaNet 检出框的轴位面边长，不是分割测量；体积、CT 值与密度分型未测"
    return metrics, box_center_zyx(box)[0], [note]


# ---------------------------------------------------------------------------
# 肺叶定位
# ---------------------------------------------------------------------------

def locate_lobe(
    lobe_map: np.ndarray, center_zyx: List[int], spacing: Tuple[float, float, float], radius_mm: float
) -> Tuple[Optional[str], Optional[str]]:
    """
    结节中心落在哪个肺叶。中心体素不属于任何肺叶（结节本身常被肺叶分割排除）时，
    在中心周围 (结节半径 + 5 mm) 的球内取肺叶体素最多者；仍找不到返回 None。
    返回 (肺叶缩写, 说明)。
    """
    cz, cy, cx = [int(v) for v in center_zyx]
    val = int(lobe_map[cz, cy, cx])
    if val in VISTA3D_LUNG_LOBE_LABELS:
        return VISTA3D_LUNG_LOBE_LABELS[val], None

    r_mm = float(radius_mm) + LOBE_SEARCH_MARGIN_MM
    dz, dy, dx = [float(s) for s in spacing]
    rz, ry, rx = [max(1, int(np.ceil(r_mm / d))) for d in (dz, dy, dx)]
    z0, z1 = max(0, cz - rz), min(lobe_map.shape[0], cz + rz + 1)
    y0, y1 = max(0, cy - ry), min(lobe_map.shape[1], cy + ry + 1)
    x0, x1 = max(0, cx - rx), min(lobe_map.shape[2], cx + rx + 1)
    zz, yy, xx = np.ogrid[z0:z1, y0:y1, x0:x1]
    ball = ((zz - cz) * dz) ** 2 + ((yy - cy) * dy) ** 2 + ((xx - cx) * dx) ** 2 <= r_mm ** 2
    region = lobe_map[z0:z1, y0:y1, x0:x1][ball]
    votes = {lab: int(np.sum(region == lab)) for lab in VISTA3D_LUNG_LOBE_LABELS}
    best = max(votes, key=lambda k: votes[k])
    if votes[best] == 0:
        return None, f"结节中心周围 {round(r_mm, 1)} mm 内没有肺叶分割体素，肺叶未定"
    return VISTA3D_LUNG_LOBE_LABELS[best], (
        f"结节中心体素不在肺叶分割内，按中心周围 {round(r_mm, 1)} mm 内肺叶体素最多者归属"
    )


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

LOBE_MODES = ("full", "roi", "off")
# lobe_mode="roi" 时每个结节周围裁取的半边长（mm）。VISTA-3D 一个 128³ 滑窗在 1.5 mm 下覆盖 192 mm；
# 取 90 mm 使裁块重采样后 ≤ 122 体素、只需一个滑窗（96 mm 会得到 129 体素，需 8 个滑窗，实测反而更慢）
LOBE_ROI_HALF_MM = 90.0


def _ms(t: float) -> int:
    return int(round((time.time() - t) * 1000))


def _call_lobes(neural: Any, volume: np.ndarray, spacing: Tuple[float, float, float], resample_mm: Optional[float]):
    if resample_mm is None:
        return neural.infer_vista3d_lung_lobes(volume, spacing)
    return neural.infer_vista3d_lung_lobes(volume, spacing, resample_mm=resample_mm)


def run_lung_nodule_pipeline(
    neural: Any,
    volume: np.ndarray,
    spacing: Tuple[float, float, float],
    modality: Optional[str] = "CT",
    max_nodules: int = 20,
    min_score: Optional[float] = None,
    lobe_mode: str = "full",
    lobe_resample_mm: Optional[float] = None,
    geometry: Optional[Dict[str, Any]] = None,
    return_masks: bool = False,
) -> Dict[str, Any]:
    """
    neural：engine.MonaiNeuralInferencePipeline 实例，需提供 _verified_weights、detect_lung_nodules、
    infer_vista3d_nodule、infer_vista3d_lung_lobes 与 device。
    lobe_mode：full = 全肺做一次 VISTA-3D 肺叶分割（默认）；roi = 只在每个结节周围 ±96 mm 的区域做；
    off = 不做肺叶定位（lobe 为 null 并写明）。lobe_resample_mm 为空时用 bundle 的 1.5 mm。
    geometry：体积几何（volume_geometry），用于把结节换算到 DICOM 病人坐标与 SOPInstanceUID；为空时这些字段为 null。
    return_masks：为真时结果带内部键 "_masks" = {结节编号: 规范化体素下标 (zz, yy, xx)}，只含分割成功的结节，
    供调用方生成 DICOM SEG（调用方须在返回响应前移除该键）。
    返回契约见 apps/imaging-worker 的 POST /api/v1/pipeline/lung-nodule；timings_ms 为各阶段耗时。
    """
    t0 = time.time()
    if max_nodules is None or int(max_nodules) < 1 or int(max_nodules) > 100:
        raise ValueError("max_nodules 须在 1~100 之间")
    if min_score is not None and not (0.0 <= float(min_score) <= 1.0):
        raise ValueError("min_score 须在 0~1 之间")
    if lobe_mode not in LOBE_MODES:
        raise ValueError(f"lobe_mode 须为 {'/'.join(LOBE_MODES)}")
    if lobe_resample_mm is not None and not (1.0 <= float(lobe_resample_mm) <= 5.0):
        raise ValueError("lobe_resample_mm 须在 1~5 mm 之间")
    volume = np.asarray(volume)
    if volume.ndim != 3:
        raise ValueError(f"需要三维体积，收到 {volume.ndim} 维")
    spacing = tuple(float(s) for s in spacing)
    timings: Dict[str, Any] = {}

    # 两个组成模型的权重都必须就绪，否则直接抛 ModelUnavailableError（不退回规则法）
    _, det_status = neural._verified_weights(DETECTOR_REGISTRY_NAME)
    _, seg_status = neural._verified_weights(SEGMENTER_REGISTRY_NAME)
    model_version = f"{DETECTOR_REGISTRY_NAME}@{_version_tag(det_status)}+{SEGMENTER_REGISTRY_NAME}@{_version_tag(seg_status)}"
    # 权重加载单独计时（已加载过则接近 0）
    t = time.time()
    for loader in ("get_lung_nodule_model", "get_vista3d_model"):
        if hasattr(neural, loader):
            getattr(neural, loader)()
    timings["model_load"] = _ms(t)

    series_qc = series_quality_control(volume.shape, spacing, modality)
    series_qc["geometry"] = geometry_summary(geometry)
    if geometry and geometry.get("affine_zyx_to_lps") is not None and len(geometry.get("sop_instance_uids") or []) not in (0, volume.shape[0]):
        geometry = {**geometry, "sop_instance_uids": None}
        series_qc["geometry"]["has_sop_uids"] = False
    warnings: List[str] = []

    # 1) 检出 + 去重 + 数量上限
    t = time.time()
    detections, det_info = neural.detect_lung_nodules(volume, spacing, min_score=min_score)
    kept, merged = deduplicate_detections(detections, spacing)
    truncated = max(0, len(kept) - int(max_nodules))
    if truncated:
        warnings.append(f"去重后检出 {len(kept)} 个，按检出分数只分析前 {int(max_nodules)} 个（max_nodules），其余 {truncated} 个未分析")
    kept = kept[: int(max_nodules)]
    timings["detection"] = _ms(t)

    # 2) 逐结节 VISTA-3D 点提示分割与测量
    nodules: List[Dict[str, Any]] = []
    seg_times: List[int] = []
    measure_ms = 0
    for det in kept:
        box = [int(v) for v in det["box_zyx"]]
        prompt = box_center_zyx(box)
        n_warnings: List[str] = []
        metrics = None
        key_z = None
        center = prompt
        segmentation = "failed"
        mask_vox = None
        t = time.time()
        try:
            raw_mask, seg_meta = neural.infer_vista3d_nodule(volume, spacing, prompt_point=prompt)
            seg_times.append(_ms(t))
            t = time.time()
            mask = select_components_overlapping_box(raw_mask, box)
            if not mask.any():
                n_warnings.append("VISTA-3D 分割结果与检出框无重叠")
            else:
                metrics, key_z, seg_warnings = measure_segmented_nodule(volume, mask, spacing, box)
                n_warnings.extend(seg_warnings)
                if metrics is not None:
                    segmentation = "vista3d"
                    center = [int(round(float(c))) for c in ndi.center_of_mass(mask)]
                    if return_masks:
                        mask_vox = tuple(v.astype(np.int32) for v in np.nonzero(mask))
                    win = (seg_meta or {}).get("window_zyx")
                    touches = mask_touches_window(mask, win, volume.shape) if win else bool((seg_meta or {}).get("mask_touches_window_edge"))
                    if touches:
                        n_warnings.append("分割触及 VISTA-3D 推理区域边界，可能被截断，测值可能偏小")
            measure_ms += _ms(t)
        except Exception as exc:
            if type(exc).__name__ == "ModelUnavailableError":
                raise
            seg_times.append(_ms(t))
            n_warnings.append(f"VISTA-3D 分割出错：{exc}")

        if segmentation == "failed":
            metrics, key_z, fb_warnings = box_fallback_metrics(box, spacing)
            n_warnings.insert(0, "VISTA-3D 分割失败")
            n_warnings.extend(fb_warnings)

        nodules.append({
            "detection_score": round(float(det["score"]), 3),
            "center_vox_zyx": center,
            "box_vox_zyx": box,
            "lobe": None,
            "segmentation": segmentation,
            "key_slice_z": int(key_z),
            "metrics": metrics,
            "warnings": n_warnings,
            "_radius_mm": (metrics["mean_diameter_mm"] or 0.0) / 2.0,
            "_mask_vox": mask_vox,
        })
    timings["segmentation_per_nodule"] = seg_times
    timings["segmentation_total"] = int(sum(seg_times))
    timings["measurement"] = measure_ms

    # 3) 肺叶定位
    t = time.time()
    lobe_meta: Dict[str, Any] = {"status": "skipped", "mode": lobe_mode}
    if nodules and lobe_mode == "off":
        lobe_meta = {"status": "off", "mode": lobe_mode}
        warnings.append("按请求未做肺叶定位（lobe_mode=off），所有结节 lobe 为 null")
    elif nodules:
        try:
            if lobe_mode == "full":
                lobe_map, meta = _call_lobes(neural, volume, spacing, lobe_resample_mm)
                lobe_meta = {"status": "ok", "mode": lobe_mode, "lobe_voxels": meta.get("lobe_voxels")}
                for n in nodules:
                    lobe, note = locate_lobe(lobe_map, n["center_vox_zyx"], spacing, n["_radius_mm"])
                    n["lobe"] = lobe
                    if note:
                        n["warnings"].append(note)
            else:
                # roi：每个结节周围 ±LOBE_ROI_HALF_MM 的局部区域各做一次；肺叶判别只用到局部上下文
                for n in nodules:
                    c = n["center_vox_zyx"]
                    lo = [max(0, int(c[i] - np.ceil(LOBE_ROI_HALF_MM / spacing[i]))) for i in range(3)]
                    hi = [min(volume.shape[i], int(c[i] + np.ceil(LOBE_ROI_HALF_MM / spacing[i])) + 1) for i in range(3)]
                    crop = volume[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]
                    lobe_map, _ = _call_lobes(neural, crop, spacing, lobe_resample_mm)
                    local = [c[i] - lo[i] for i in range(3)]
                    lobe, note = locate_lobe(lobe_map, local, spacing, n["_radius_mm"])
                    n["lobe"] = lobe
                    if note:
                        n["warnings"].append(note)
                lobe_meta = {"status": "ok", "mode": lobe_mode, "roi_half_mm": LOBE_ROI_HALF_MM}
            if lobe_resample_mm is not None:
                lobe_meta["resample_mm"] = float(lobe_resample_mm)
        except Exception as exc:
            if type(exc).__name__ == "ModelUnavailableError":
                raise
            lobe_meta = {"status": "failed", "mode": lobe_mode}
            for n in nodules:
                n["lobe"] = None
            warnings.append(f"VISTA-3D 肺叶分割失败，所有结节 lobe 为 null：{exc}")
    timings["lobe_segmentation"] = _ms(t)

    # 4) 按平均径从大到小排序并编号
    nodules.sort(key=lambda n: -(n["metrics"]["mean_diameter_mm"] or 0.0))
    masks: Dict[int, Any] = {}
    for i, n in enumerate(nodules, start=1):
        n.pop("_radius_mm", None)
        n["index"] = i
        vox = n.pop("_mask_vox", None)
        if vox is not None:
            masks[i] = vox
        n["seg_segment_number"] = None
        # 病人坐标与 DICOM 图像：center_vox_zyx / box_vox_zyx / key_slice_z 经体积几何换算
        n["center_lps_mm"] = voxel_to_lps(geometry, n["center_vox_zyx"])
        n["box_lps_mm"] = box_to_lps_bounds(geometry, n["box_vox_zyx"])
        n["key_slice_sop_instance_uid"] = sop_uid_at(geometry, n["key_slice_z"])
    ordered_keys = ("index", "detection_score", "center_vox_zyx", "box_vox_zyx", "lobe",
                    "segmentation", "key_slice_z", "metrics", "warnings",
                    "center_lps_mm", "box_lps_mm", "key_slice_sop_instance_uid", "seg_segment_number")
    nodules = [{k: n[k] for k in ordered_keys} for n in nodules]

    result = {
        "model_id": PIPELINE_ID,
        "model_version": model_version,
        "device": str(getattr(neural.device, "type", neural.device)),
        "elapsed_ms": int(round((time.time() - t0) * 1000)),
        "series_qc": series_qc,
        "nodules": nodules,
        "warnings": warnings,
        "detection": {
            **det_info,
            "candidates_after_threshold": len(detections),
            "merged_duplicates": merged,
            "analyzed": len(nodules),
            "box_convention": "[z0, y0, x0, z1, y1, x1] 体素下标，左闭右开",
        },
        "lobe_segmentation": lobe_meta,
        "timings_ms": timings,
        "seg": None,
    }
    if return_masks:
        result["_masks"] = masks
    return result
