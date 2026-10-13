import numpy as np
import scipy.ndimage as ndi
from typing import Dict, Any, Tuple, Optional
from scipy.spatial import ConvexHull
from scipy.spatial.distance import pdist, squareform

def calculate_recist_metrics(
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.0, 1.0, 1.0)
) -> Dict[str, Any]:
    """
    Computes RECIST 1.1 quantitative metrics from a 3D binary mask:
    1. Total Volume (cm³)
    2. Key Slice Index (axial slice with maximum cross-sectional area)
    3. Longest Diameter (LD) in mm on the key slice (accelerated via Convex Hull)
    4. Perpendicular Short Axis in mm
    5. Caliper endpoints for graphical rendering
    """
    # Spacing: (dz, dy, dx) or (dx, dy, dz). We assume volume shape is (Z, Y, X)
    # voxel volume in mm³
    vx_vol_mm3 = spacing[0] * spacing[1] * spacing[2]
    total_voxels = int(np.sum(mask > 0))
    volume_cm3 = round(total_voxels * vx_vol_mm3 / 1000.0, 2)

    if total_voxels == 0:
        return {
            "total_volume_cm3": 0.0,
            "key_slice_index": 0,
            "longest_diameter_mm": 0.0,
            "short_axis_mm": 0.0,
            "caliper_longest": None,
            "caliper_short": None,
            "has_lesion": False
        }

    # Sum along axial slices (axis 0: Z)
    slice_areas = np.sum(mask > 0, axis=(1, 2))
    key_slice_idx = int(np.argmax(slice_areas))

    slice_2d = mask[key_slice_idx] > 0
    y_coords, x_coords = np.where(slice_2d)

    if len(x_coords) < 2:
        return {
            "total_volume_cm3": volume_cm3,
            "key_slice_index": key_slice_idx,
            "longest_diameter_mm": 0.0,
            "short_axis_mm": 0.0,
            "caliper_longest": None,
            "caliper_short": None,
            "has_lesion": True
        }

    # Scale pixel coordinates by in-plane spacing (dy, dx)
    dy, dx = spacing[1], spacing[2]
    pts = np.column_stack((x_coords * dx, y_coords * dy))

    # Accelerated diameter search: the maximum pairwise distance between points
    # always occurs between two vertices of the 2D convex hull.
    # This reduces complexity from O(N^2) (e.g. 50,000^2 pairs) to O(V^2) (V <= 60 vertices).
    if len(pts) >= 4:
        try:
            hull = ConvexHull(pts)
            hull_idx = hull.vertices
            hull_pts = pts[hull_idx]
            dists = squareform(pdist(hull_pts))
            hi, hj = np.unravel_index(np.argmax(dists), dists.shape)
            i = hull_idx[hi]
            j = hull_idx[hj]
            longest_diameter_mm = round(float(dists[hi, hj]), 1)
        except Exception:
            # Fallback if points are collinear or 1D
            dists = squareform(pdist(pts))
            i, j = np.unravel_index(np.argmax(dists), dists.shape)
            longest_diameter_mm = round(float(dists[i, j]), 1)
    else:
        dists = squareform(pdist(pts))
        i, j = np.unravel_index(np.argmax(dists), dists.shape)
        longest_diameter_mm = round(float(dists[i, j]), 1)

    p1 = (int(x_coords[i]), int(y_coords[i]))
    p2 = (int(x_coords[j]), int(y_coords[j]))

    # For perpendicular short axis: search along perpendicular direction
    dx_vec = pts[j, 0] - pts[i, 0]
    dy_vec = pts[j, 1] - pts[i, 1]
    norm = np.hypot(dx_vec, dy_vec)
    if norm > 0:
        perp_x = -dy_vec / norm
        perp_y = dx_vec / norm
        # Project points onto perpendicular vector
        proj = pts[:, 0] * perp_x + pts[:, 1] * perp_y
        short_axis_mm = round(float(np.ptp(proj)), 1)
        k_min = int(np.argmin(proj))
        k_max = int(np.argmax(proj))
        caliper_short = {
            "p1": [int(x_coords[k_min]), int(y_coords[k_min])],
            "p2": [int(x_coords[k_max]), int(y_coords[k_max])],
            "length_mm": short_axis_mm
        }
    else:
        short_axis_mm = 0.0
        caliper_short = None

    return {
        "total_volume_cm3": volume_cm3,
        "key_slice_index": key_slice_idx,
        "longest_diameter_mm": longest_diameter_mm,
        "short_axis_mm": short_axis_mm,
        "caliper_longest": {
            "p1": [p1[0], p1[1]],
            "p2": [p2[0], p2[1]],
            "length_mm": longest_diameter_mm
        },
        "caliper_short": caliper_short,
        "has_lesion": True
    }


def detect_pulmonary_vessel_cross_section(
    volume: np.ndarray,
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    key_slice_idx: Optional[int] = None,
    search_radius_mm: float = 18.0
) -> Dict[str, Any]:
    """
    启发式判断分割目标是否更像肺血管横截面而非孤立结节（未经临床验证，仅作提示）。

    判据（均为本实现自定的阈值，不是 Fleischner / Lung-RADS 的条文）：
    1. 关键层等效直径 <= 9.5 mm 才进入判定；
    2. 关键层上距中心 1.2~8.5 mm 内存在面积 2~45 mm² 的含气腔（<= -780 HU），视为可能的伴行支气管；
    3. 以中心为种子的 -150~250 HU 软组织连通域在 z 向跨度 >= 7.5 mm 或触及搜索框上下界；
    4. 该连通域触及搜索框面内边界且等效直径 <= 7.5 mm。
    任一判据成立即标记 is_vessel，reasons 列出实际触发的判据与测值。
    """
    dz, dy, dx = [float(s) for s in spacing]
    is_lung = float(np.min(volume)) < -500.0 and float(np.mean(volume)) < -150.0
    if not is_lung:
        return {"is_vessel": False, "reasons": []}

    z_pts, y_pts, x_pts = np.where(mask > 0)
    if len(z_pts) == 0:
        return {"is_vessel": False, "reasons": []}

    cz = int(key_slice_idx) if key_slice_idx is not None else int(np.median(z_pts))
    slice_mask = mask[cz] > 0
    if not np.any(slice_mask):
        cz = int(np.median(z_pts))
        slice_mask = mask[cz] > 0
    if not np.any(slice_mask):
        return {"is_vessel": False, "reasons": []}

    # Isolate the target 2D connected component on key slice (avoiding multi-component inflation)
    lbl2d, n_comp = ndi.label(slice_mask)
    c_counts = np.bincount(lbl2d.flat)
    c_counts[0] = 0
    target_comp_idx = int(np.argmax(c_counts))
    target_slice_mask = (lbl2d == target_comp_idx)

    sy_pts, sx_pts = np.where(target_slice_mask)
    cy = int(np.mean(sy_pts))
    cx = int(np.mean(sx_pts))

    in_plane_area_mm2 = float(np.sum(target_slice_mask) * dy * dx)
    in_plane_d = round(float(2.0 * np.sqrt(in_plane_area_mm2 / np.pi)), 1) if in_plane_area_mm2 > 0 else 0.0

    # Genuine solitary nodules > 9.5mm are virtually never simple normal branching vessel cross-sections
    if in_plane_d > 9.5:
        return {"is_vessel": False, "in_plane_diameter_mm": in_plane_d, "reasons": []}

    rz = max(3, int(np.ceil(search_radius_mm / dz)))
    ry = max(8, int(np.ceil(search_radius_mm / dy)))
    rx = max(8, int(np.ceil(search_radius_mm / dx)))

    z_lo, z_hi = max(0, cz - rz), min(volume.shape[0], cz + rz + 1)
    y_lo, y_hi = max(0, cy - ry), min(volume.shape[1], cy + ry + 1)
    x_lo, x_hi = max(0, cx - rx), min(volume.shape[2], cx + rx + 1)

    sub_vol = volume[z_lo:z_hi, y_lo:y_hi, x_lo:x_hi]
    local_cz = cz - z_lo
    local_cy = cy - y_lo
    local_cx = cx - x_lo

    soft_tissue = (sub_vol >= -150.0) & (sub_vol <= 250.0)
    lbl, n_components = ndi.label(soft_tissue)
    seed_lbl = lbl[local_cz, local_cy, local_cx]

    if seed_lbl == 0:
        window = lbl[max(0, local_cz-1):local_cz+2, max(0, local_cy-1):local_cy+2, max(0, local_cx-1):local_cx+2]
        nz = window[window > 0]
        if len(nz) > 0:
            seed_lbl = int(np.bincount(nz).argmax())

    if seed_lbl == 0:
        return {"is_vessel": False, "in_plane_diameter_mm": in_plane_d, "reasons": []}

    comp = (lbl == seed_lbl)
    cz_pts, cy_pts, cx_pts = np.where(comp)
    z_span = float((cz_pts.max() - cz_pts.min() + 1) * dz)

    touches_z_boundary = bool((cz_pts.min() == 0) or (cz_pts.max() == sub_vol.shape[0] - 1))
    touches_xy_boundary = bool((cy_pts.min() == 0) or (cy_pts.max() == sub_vol.shape[1] - 1) or (cx_pts.min() == 0) or (cx_pts.max() == sub_vol.shape[2] - 1))

    # Check companion bronchus air lumen within 1.2mm to 8.5mm on key slice
    sl = sub_vol[local_cz]
    yy, xx = np.ogrid[:sl.shape[0], :sl.shape[1]]
    dist_map = np.sqrt(((yy - local_cy) * dy)**2 + ((xx - local_cx) * dx)**2)
    ring_mask = (dist_map >= 1.2) & (dist_map <= 8.5)
    air_lumens = (sl <= -780.0) & ring_mask
    air_lbl, n_air = ndi.label(air_lumens)
    has_companion_bronchus = False
    bronchus_caliber_mm = 0.0

    if n_air > 0:
        for a_idx in range(1, n_air + 1):
            a_area = float(np.sum(air_lbl == a_idx) * (dy * dx))
            # Typical companion bronchus lumen area: 2.0 to 45 mm2 (diam 1.6 to 7.5 mm)
            if 2.0 <= a_area <= 45.0:
                has_companion_bronchus = True
                bronchus_caliber_mm = round(float(2.0 * np.sqrt(a_area / np.pi)), 1)
                break

    is_vessel = False
    reasons = []

    # 1. Signet ring sign: Companion bronchus next to small dot (classic pulmonary artery branch)
    if has_companion_bronchus and in_plane_d <= 9.0:
        is_vessel = True
        reasons.append(f"伴行支气管印戒征 (气道内径 {bronchus_caliber_mm}mm)")

    # 2. Longitudinal Z-span continuity (3D through-flow across slices)
    if (touches_z_boundary or z_span >= 7.5) and in_plane_d <= 8.5:
        is_vessel = True
        reasons.append(f"3D纵向跨切片延伸 (Z跨度 {z_span:.1f}mm, 连续贯通)")

    # 3. Connection to branching vascular trunk
    if touches_xy_boundary and in_plane_d <= 7.5:
        is_vessel = True
        reasons.append("向肺门主干血管分叉延伸")

    return {
        "is_vessel": is_vessel,
        "in_plane_diameter_mm": in_plane_d,
        "z_span_mm": z_span,
        "has_companion_bronchus": has_companion_bronchus,
        "bronchus_caliber_mm": bronchus_caliber_mm,
        "touches_z_boundary": touches_z_boundary,
        "reasons": reasons
    }


def calculate_subsolid_metrics(
    volume: np.ndarray,
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.0, 1.0, 1.0),
    solid_hu_threshold: float = -150.0,
    key_slice_idx: Optional[int] = None
) -> Dict[str, Any]:
    """
    结节整体与实性成分的双通道测量（只给测量值，不做 Lung-RADS 分类、不给病理倾向与随访建议）：
    1. 整体边界：关键层最大长径、垂直短径、体积；
    2. 实性成分：掩膜内 >= solid_hu_threshold（默认 -150 HU，本实现自定阈值）的体素，测其关键层长径与体积；
    3. CTR = 实性成分长径 / 整体长径；
    4. 按测量值的密度分型（启发式）：无实性体素为 pure_ggo；CTR >= 0.8 或实性体素占 >= 75% 为 solid；否则 part_solid；
    5. 层厚质控说明。
    Lung-RADS 分类依赖随访对比、病灶位置等单次 CT 测量之外的信息，这里不输出分类，由使用者按原始指南自行判读。
    """
    dz, dy, dx = [float(s) for s in spacing]
    slice_thickness_mm = round(dz, 2)
    if slice_thickness_mm <= 1.5:
        qc_tier = "optimal"
        qc_badge = "薄层"
        qc_desc = f"薄层扫描 ({slice_thickness_mm}mm ≤ 1.5mm)"
        qc_warning = None
    elif slice_thickness_mm <= 2.5:
        qc_tier = "acceptable"
        qc_badge = "常规层厚"
        qc_desc = f"常规切片层厚 ({slice_thickness_mm}mm)"
        qc_warning = None
    else:
        qc_tier = "thick_slice_warning"
        qc_badge = "厚层"
        qc_desc = f"扫描层厚偏厚 ({slice_thickness_mm}mm > 2.5mm)"
        qc_warning = (
            f"当前扫描层厚较厚 ({slice_thickness_mm}mm)，部分容积效应可能使磨玻璃成分与微小实性成分的测值产生偏差；"
            f"薄层 HRCT (≤1.25mm) 重建可减小该偏差。"
        )

    quality_control = {
        "slice_thickness_mm": slice_thickness_mm,
        "pixel_spacing_mm": [round(dy, 3), round(dx, 3)],
        "is_thin_slice": slice_thickness_mm <= 1.5,
        "tier": qc_tier,
        "badge": qc_badge,
        "description": qc_desc,
        "warning": qc_warning,
    }

    total_metrics = calculate_recist_metrics(mask, spacing=spacing)
    if not total_metrics.get("has_lesion", False) or total_metrics.get("longest_diameter_mm", 0.0) == 0.0:
        # 掩膜为空（或关键层不足两个体素）：没有可测目标，测量值置空
        total_metrics["nodule_type"] = "none"
        total_metrics["nodule_type_zh"] = "掩膜内无可测目标"
        total_metrics["solid_core_diameter_mm"] = None
        total_metrics["solid_core_volume_cm3"] = None
        total_metrics["solid_core_caliper"] = None
        total_metrics["consolidation_tumor_ratio"] = None
        total_metrics["quality_control"] = quality_control
        return total_metrics

    nodule_voxels = mask > 0
    solid_voxels = nodule_voxels & (volume >= solid_hu_threshold)
    solid_count = int(np.sum(solid_voxels))

    total_ld = total_metrics["longest_diameter_mm"]

    # 启发式血管截面判定（见 detect_pulmonary_vessel_cross_section）
    target_slice = key_slice_idx if key_slice_idx is not None else total_metrics.get("key_slice_index")
    vessel_check = detect_pulmonary_vessel_cross_section(
        volume=volume,
        mask=mask,
        spacing=spacing,
        key_slice_idx=target_slice
    )
    if vessel_check.get("is_vessel", False):
        # 判为疑似血管截面：不做结节测量（实性成分、CTR、密度分型均不输出），
        # 掩膜本身的几何测量保留，供叠加图与人工复核
        total_metrics["is_vessel"] = True
        total_metrics["vessel_info"] = vessel_check
        total_metrics["nodule_type"] = "suspected_vessel"
        total_metrics["nodule_type_zh"] = "疑似血管截面，未做结节测量"
        total_metrics["solid_core_diameter_mm"] = None
        total_metrics["solid_core_volume_cm3"] = None
        total_metrics["solid_core_caliper"] = None
        total_metrics["consolidation_tumor_ratio"] = None
        total_metrics["measurement_note"] = (
            "启发式血管判定成立（" + "，".join(vessel_check.get("reasons", [])) + "），未做结节测量；该判定未经验证，需人工复核"
        )
        total_metrics["quality_control"] = quality_control
        return total_metrics

    # 掩膜内 CT 值统计
    attenuations = volume[nodule_voxels]
    mean_hu = round(float(np.mean(attenuations)), 1)
    max_hu = round(float(np.max(attenuations)), 1)
    min_hu = round(float(np.min(attenuations)), 1)

    if solid_count == 0:
        nodule_type = "pure_ggo"
        nodule_type_zh = "纯磨玻璃密度 (掩膜内无 ≥{:.0f} HU 体素)".format(solid_hu_threshold)
        solid_ld = 0.0
        solid_vol = 0.0
        solid_caliper = None
        ctr = 0.0
    else:
        solid_metrics = calculate_recist_metrics(solid_voxels.astype(np.uint8), spacing=spacing)
        solid_ld = solid_metrics["longest_diameter_mm"]
        solid_vol = solid_metrics["total_volume_cm3"]
        solid_caliper = solid_metrics.get("caliper_longest")
        ctr = round(float(solid_ld / total_ld), 2) if total_ld > 0 else None

        if (ctr is not None and ctr >= 0.8) or solid_count >= int(0.75 * np.sum(nodule_voxels)):
            nodule_type = "solid"
            nodule_type_zh = "实性密度为主"
        else:
            nodule_type = "part_solid"
            nodule_type_zh = "部分实性 (磨玻璃与实性成分混合)"

    return {
        **total_metrics,
        "nodule_type": nodule_type,
        "nodule_type_zh": nodule_type_zh,
        "nodule_type_method": f"按掩膜内 CT 值阈值 ({solid_hu_threshold:.0f} HU) 与 CTR 的启发式分型，非指南定义",
        "solid_hu_threshold": solid_hu_threshold,
        "solid_core_diameter_mm": solid_ld,
        "solid_core_volume_cm3": solid_vol,
        "solid_core_caliper": solid_caliper,
        "consolidation_tumor_ratio": ctr,
        "mean_attenuation_hu": mean_hu,
        "max_attenuation_hu": max_hu,
        "min_attenuation_hu": min_hu,
        "quality_control": quality_control,
        "has_lesion": True
    }


def calculate_volume_doubling_time(
    baseline_vol_cm3: float,
    followup_vol_cm3: float,
    days_interval: float
) -> Dict[str, Any]:
    """
    Schwartz 体积倍增时间：VDT = (间隔天数 × ln2) / ln(V2 / V1)。
    只输出计算值与体积变化方向，不按 VDT 区间给恶性风险判断或处置建议。
    """
    if baseline_vol_cm3 <= 0 or followup_vol_cm3 <= 0 or days_interval <= 0:
        return {
            "vdt_days": None,
            "volume_change_cm3": None,
            "volume_change_percent": None,
            "category": "indeterminate",
            "label": "无法计算",
            "description": "需要两次测量均为正体积且随访间隔大于 0 天方可计算倍增时间。",
        }

    vol_diff = round(followup_vol_cm3 - baseline_vol_cm3, 3)
    pct_change = round(((followup_vol_cm3 - baseline_vol_cm3) / baseline_vol_cm3) * 100.0, 1)

    if followup_vol_cm3 < baseline_vol_cm3:
        return {
            "vdt_days": None,
            "volume_change_cm3": vol_diff,
            "volume_change_percent": pct_change,
            "category": "decreased",
            "label": f"体积缩小 {abs(pct_change)}%",
            "description": f"随访体积较基线缩小 {abs(pct_change)}%（{days_interval:g} 天），体积未增长，不计算倍增时间。",
        }
    if followup_vol_cm3 == baseline_vol_cm3:
        return {
            "vdt_days": None,
            "volume_change_cm3": 0.0,
            "volume_change_percent": 0.0,
            "category": "unchanged",
            "label": "体积无变化",
            "description": "两次测量体积相同，不计算倍增时间。",
        }

    vdt = (days_interval * np.log(2.0)) / np.log(followup_vol_cm3 / baseline_vol_cm3)
    vdt_days = round(float(vdt), 1)
    return {
        "vdt_days": vdt_days,
        "volume_change_cm3": vol_diff,
        "volume_change_percent": pct_change,
        "category": "increased",
        "label": f"体积增大 {pct_change}%，VDT {vdt_days} 天",
        "description": f"随访体积较基线增大 {pct_change}%（{days_interval:g} 天），Schwartz 体积倍增时间 {vdt_days} 天。",
    }


def calculate_emphysema_metrics(
    volume: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    emphysema_hu_threshold: float = -950.0
) -> Dict[str, Any]:
    """
    肺实质低衰减区定量（只输出量化值，不做 GOLD 分级——GOLD 依据肺功能，不能由 CT 推出）：
    1. 双肺容积（L）：quality_assurance.segment_lungs 的阈值法肺分割（含肺内大气道）；
    2. 低衰减区容积：肺掩膜内 <= emphysema_hu_threshold（默认 -950 HU）；
    3. LAA% = 低衰减区容积 / 双肺容积 × 100%；
    4. 肺掩膜内平均 CT 值与 Perc15（第 15 百分位 CT 值）。
    肺分割失败时返回空值和原因，不给估计值。
    """
    try:
        from .quality_assurance import segment_lungs
    except (ImportError, ValueError):
        from quality_assurance import segment_lungs

    dz, dy, dx = [float(s) for s in spacing]
    voxel_vol_cm3 = (dz * dy * dx) / 1000.0
    voxel_vol_liters = voxel_vol_cm3 / 1000.0

    slice_thickness_mm = round(dz, 2)
    quality_control = {
        "slice_thickness_mm": slice_thickness_mm,
        "is_thin_slice": slice_thickness_mm <= 1.5,
        "warning": None if slice_thickness_mm <= 2.0 else f"层厚 {slice_thickness_mm}mm 偏厚，部分容积效应会抬高小低衰减区的 CT 值，LAA% 可能偏低"
    }
    method = {
        "lung_segmentation": "quality_assurance.segment_lungs（先去掉首尾不含人体的填充层）：< -400 HU 三维连通域，去除触及层面边界的体外空气，保留最大一到两个，逐层填洞（含肺内大气道）",
        "laa_threshold_hu": emphysema_hu_threshold,
    }

    # 去掉首尾不含人体（无 > -400 HU 体素）的填充层，避免肺经全空气填充层与体外空气连通而分割失败
    body_slices = np.where(np.any(volume > -400.0, axis=(1, 2)))[0]
    lung_mask = None
    if body_slices.size > 0:
        z0, z1 = int(body_slices[0]), int(body_slices[-1]) + 1
        sub_mask = segment_lungs(volume[z0:z1], voxel_vol_cm3)
        if sub_mask is not None:
            lung_mask = np.zeros(volume.shape, dtype=bool)
            lung_mask[z0:z1] = sub_mask
    if lung_mask is None or int(np.sum(lung_mask)) == 0:
        return {
            "status": "lung_segmentation_failed",
            "error": "未能分割出双肺（视野裁切到肺或肺与图像边界相连），不输出低衰减区定量",
            "total_lung_volume_liters": None,
            "emphysema_volume_liters": None,
            "laa_percent": None,
            "mean_lung_attenuation_hu": None,
            "perc15_hu": None,
            "emphysema_hu_threshold": emphysema_hu_threshold,
            "method": method,
            "quality_control": quality_control
        }

    total_lung_voxels = int(np.sum(lung_mask))
    lung_hu = volume[lung_mask]
    emphysema_voxels = int(np.sum(lung_hu <= emphysema_hu_threshold))

    total_lung_liters = round(total_lung_voxels * voxel_vol_liters, 2)
    emphysema_liters = round(emphysema_voxels * voxel_vol_liters, 3)
    laa_pct = round((emphysema_voxels / total_lung_voxels) * 100.0, 1)

    return {
        "status": "success",
        "total_lung_volume_liters": total_lung_liters,
        "emphysema_volume_liters": emphysema_liters,
        "laa_percent": laa_pct,
        "mean_lung_attenuation_hu": round(float(np.mean(lung_hu)), 1),
        "perc15_hu": round(float(np.percentile(lung_hu, 15)), 1),
        "emphysema_hu_threshold": emphysema_hu_threshold,
        "findings": f"双肺容积 {total_lung_liters} L，≤{emphysema_hu_threshold:.0f} HU 低衰减区 {emphysema_liters} L，占 {laa_pct}%。",
        "method": method,
        "quality_control": quality_control
    }
