import io
import os
import time
import numpy as np
import torch
from typing import Dict, Any, Tuple, Optional, List
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import label, binary_dilation, binary_fill_holes, find_objects, sum as ndimage_sum

try:
    from .device import get_optimal_device, get_device_info
    from .dicom_io import apply_ct_window
    from .renderer import png_to_base64
    from .font_utils import get_cjk_font, get_sans_font, sanitize_text
    from .spatial_canonicalizer import verify_and_enforce_anatomical_landmarks, get_radiological_orientation_labels
    from .quality_assurance import assess_ct_quality
    from .presentation_state import build_presentation_state_payload, render_pacs_viewport
except (ImportError, ValueError):
    from device import get_optimal_device, get_device_info
    from dicom_io import apply_ct_window
    from renderer import png_to_base64
    from font_utils import get_cjk_font, get_sans_font, sanitize_text
    from spatial_canonicalizer import verify_and_enforce_anatomical_landmarks, get_radiological_orientation_labels
    from quality_assurance import assess_ct_quality
    from presentation_state import build_presentation_state_payload, render_pacs_viewport


def generate_synthetic_bronchiectasis_ct(
    shape: Tuple[int, int, int] = (48, 128, 128),
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8)
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Synthesizes a realistic thoracic HRCT volume exhibiting:
    1. Lung parenchyma background (-750 HU)
    2. Dilated bronchus with thickened walls (Signet Ring sign, BAR > 1.3)
    3. Accompanying pulmonary artery (+55 HU)
    4. Intraluminal mucus plug / mucoid impaction (+32 HU soft tissue density inside airway)
    5. Peripheral 'tree-in-bud' branching bronchiolar impaction
    Returns:
    - volume (float32 HU)
    - airway_mask (uint8 binary)
    - mucus_mask (uint8 binary)
    """
    z_dim, y_dim, x_dim = shape
    volume = np.full(shape, -1000.0, dtype=np.float32)  # Air
    airway_mask = np.zeros(shape, dtype=np.uint8)
    mucus_mask = np.zeros(shape, dtype=np.uint8)

    z_coords, y_coords, x_coords = np.meshgrid(
        np.arange(z_dim), np.arange(y_dim), np.arange(x_dim), indexing="ij"
    )
    cy, cx = y_dim // 2, x_dim // 2

    # Thoracic chest cage & soft tissue wall
    body_mask = ((y_coords - cy) / (y_dim * 0.44))**2 + ((x_coords - cx) / (x_dim * 0.44))**2 <= 1.0
    volume[body_mask] = 40.0

    # Bilateral lungs: Observer Left = Patient Right (x < cx); Observer Right = Patient Left (x > cx)
    right_lung = ((y_coords - cy) / (y_dim * 0.30))**2 + ((x_coords - (cx - x_dim * 0.22)) / (x_dim * 0.17))**2 <= 1.0
    left_lung = ((y_coords - cy) / (y_dim * 0.30))**2 + ((x_coords - (cx + x_dim * 0.22)) / (x_dim * 0.17))**2 <= 1.0
    lung_field = left_lung | right_lung
    volume[lung_field] = -750.0

    # Spine bone in posterior (bottom half in canonical LPS orientation)
    spine = ((y_coords - (cy + y_dim * 0.32)) / (y_dim * 0.08))**2 + ((x_coords - cx) / (x_dim * 0.08))**2 <= 1.0
    volume[spine] = 480.0

    # Dilated Bronchus in Right Lower Lobe (Center: lz, ly, lx)
    lz = z_dim // 2
    ly = cy + 4
    lx = cx - int(x_dim * 0.18)

    # 1. Dilated Bronchial Wall (Thickened ring: outer radius 11, inner lumen radius 8)
    dist_sq = ((y_coords - ly))**2 + ((x_coords - lx))**2
    z_dist = np.abs(z_coords - lz)
    in_range = z_dist <= 8

    # 2. Accompanying Pulmonary Artery (Radius 5.5, Adjacent to bronchus -> BAR = 8.0 / 5.5 = 1.45 > 1.1)
    artery_y = ly - 9
    artery_x = lx + 8
    artery_dist_sq = ((y_coords - artery_y))**2 + ((x_coords - artery_x))**2
    artery = in_range & (artery_dist_sq <= 5.5**2)

    bronchial_wall = in_range & (dist_sq <= 11.0**2) & (dist_sq >= 8.0**2) & (~artery)
    bronchial_lumen = in_range & (dist_sq < 8.0**2)

    volume[bronchial_wall] = 20.0  # thickened wall
    volume[bronchial_lumen] = -900.0  # patent air lumen
    volume[artery] = 55.0  # vascular attenuation
    airway_mask[bronchial_lumen] = 1

    # 3. Inspissated Mucus Plug (Mucoid Impaction inside the dilated lumen)
    plug = in_range & (dist_sq < 8.0**2) & (y_coords >= ly - 1) & (z_dist <= 5)
    volume[plug] = 32.0  # Mucus attenuation (+15 to +50 HU)
    mucus_mask[plug] = 1
    airway_mask[plug] = 1  # The plug resides within the airway envelope

    # 4. Tree-in-bud sign (Branching centrilobular impacted nodules in outer periphery)
    for offset_y, offset_x in [(18, -14), (22, -10), (16, -20), (25, -16)]:
        tib_y = ly + offset_y
        tib_x = lx + offset_x
        tib_nodule = (z_dist <= 3) & (((y_coords - tib_y)**2 + (x_coords - tib_x)**2) <= 2.8**2)
        volume[tib_nodule] = 25.0
        mucus_mask[tib_nodule] = 1

    # Add Gaussian CT sensor noise
    noise = np.random.normal(0, 8, shape).astype(np.float32)
    volume += noise

    return volume, airway_mask, mucus_mask


def extract_mucus_locations(
    volume: np.ndarray,
    mucus_mask: np.ndarray,
    patent_airway_mask: np.ndarray,
    spacing: Tuple[float, float, float],
    ham_threshold_hu: float = 70.0
) -> Tuple[List[Dict[str, Any]], Dict[str, float], str]:
    """
    粘液栓的空间分布：
    - 左右 × 上/中/下肺野的启发式分区：按层面在扫描范围内的相对高度三等分（上 ≥0.62，中 0.38–0.62，下 <0.38），
      不是肺叶/肺段分割；canonical LPS 下 z=0 为足侧、z 增大朝头侧，相对高度取 z/层数
      （旧实现把 z/层数 < 0.38 当上叶，上下颠倒）；
    - 主要粘液栓连通域的层面范围、质心、体积、CT 值，以及是否靠近通畅大气道（中心/外周）。
    """
    z_dim, y_dim, x_dim = volume.shape
    vx_vol_cm3 = (spacing[0] * spacing[1] * spacing[2]) / 1000.0

    z_coords_m, y_coords_m, x_coords_m = np.where(mucus_mask)
    if len(z_coords_m) == 0:
        return [], {}, "未检测到明显气道粘液栓"

    cx = x_dim // 2

    # LPS：x 小为患者右侧；z=0 为足侧，相对高度 = z/层数（越大越靠头侧）
    is_right_m = x_coords_m <= cx
    height_m = z_coords_m / max(z_dim, 1)
    zone_idx_m = np.where(height_m >= 0.62, 0, np.where(height_m >= 0.38, 1, 2))

    zone_names = ("上肺野", "中肺野", "下肺野")
    lobar_vols = {}
    for side_name, side_sel in (("右", is_right_m), ("左", ~is_right_m)):
        for zi, zname in enumerate(zone_names):
            cnt = int(np.sum(side_sel & (zone_idx_m == zi)))
            lobar_vols[f"{side_name}{zname}"] = round(float(cnt * vx_vol_cm3), 2)

    # Connected components clustering for dominant plugs
    labeled, num_clusters = label(mucus_mask)
    if num_clusters == 0:
        return [], lobar_vols, "未检测到明显气道粘液栓"

    counts = np.bincount(labeled.ravel())
    if len(counts) <= 1:
        return [], lobar_vols, "未检测到明显气道粘液栓"

    cluster_sizes = counts[1:]
    sorted_order = np.argsort(cluster_sizes)[::-1]
    top_cluster_ids = [int(idx + 1) for idx in sorted_order if cluster_sizes[idx] >= 8][:8]

    if not top_cluster_ids:
        return [], lobar_vols, "仅见散在微小细支气管分泌物"

    slices = find_objects(labeled)
    dilated_central = binary_dilation(patent_airway_mask, iterations=3)

    cluster_info_list = []
    for c_id in top_cluster_ids:
        sl = slices[c_id - 1]
        if sl is None:
            continue
        sub_labeled = (labeled[sl] == c_id)
        sub_coords = np.where(sub_labeled)
        if len(sub_coords[0]) == 0:
            continue

        z_coords = sub_coords[0] + sl[0].start
        y_coords = sub_coords[1] + sl[1].start
        x_coords = sub_coords[2] + sl[2].start

        c_voxels = len(z_coords)
        c_vol_cm3 = round(c_voxels * vx_vol_cm3, 2)
        c_vol_mm3 = round(c_vol_cm3 * 1000.0, 1)

        cz = int(np.mean(z_coords))
        cy_c = int(np.mean(y_coords))
        cx_c = int(np.mean(x_coords))

        z_min, z_max = int(np.min(z_coords)), int(np.max(z_coords))

        cluster_hu = volume[sl][sub_labeled]
        mean_hu = float(round(float(np.mean(cluster_hu)), 1))
        max_hu = float(round(float(np.max(cluster_hu)), 1))
        is_ham = bool(max_hu >= ham_threshold_hu)

        is_right = bool(cx_c <= cx)
        side = "右" if is_right else "左"
        height = float(cz / max(z_dim, 1))
        zone = "上肺野" if height >= 0.62 else ("中肺野" if height >= 0.38 else "下肺野")
        lobe_key = f"{side}{zone}"

        central_overlap = float(np.sum(dilated_central[sl][sub_labeled]))
        is_central = bool((central_overlap / max(c_voxels, 1)) > 0.25)
        zone_type = "靠近通畅大气道（中心）" if is_central else "远离通畅大气道（外周）"

        cluster_info_list.append({
            "cluster_id": int(c_id),
            "lobe": lobe_key,
            "zone": lobe_key,
            "zone_method": "按层面高度的启发式分区，非肺叶分割",
            "location_name": f"{lobe_key}（启发式分区）",
            "full_location": f"{lobe_key}（启发式分区） · {zone_type}",
            "zone_type": zone_type,
            "is_central": bool(is_central),
            "slice_range": f"第 #{z_min} ~ #{z_max} 层",
            "centroid_slice": int(cz),
            "centroid_voxel": [int(cz), int(cy_c), int(cx_c)],
            "volume_cm3": float(c_vol_cm3),
            "volume_mm3": float(c_vol_mm3),
            "mean_hu": float(mean_hu),
            "max_hu": float(max_hu),
            "is_ham": bool(is_ham)
        })

    cluster_info_list.sort(key=lambda x: x["volume_cm3"], reverse=True)

    total_mucus_vol = sum(lobar_vols.values())
    predominant_lobes = []
    if total_mucus_vol > 0:
        sorted_lobes = sorted(lobar_vols.items(), key=lambda x: x[1], reverse=True)
        for l_name, l_vol in sorted_lobes:
            if l_vol > 0:
                pct = round((l_vol / total_mucus_vol) * 100, 1)
                predominant_lobes.append(f"{l_name} ({pct}%)")

    summary_text = ("、".join(predominant_lobes[:2]) + "（按层面高度的启发式分区）") if predominant_lobes else "双肺散在"
    return cluster_info_list[:6], lobar_vols, summary_text


def measure_bronchial_wall_thickness(
    slice_hu: np.ndarray,
    cx: int,
    cy: int,
    r_px: float,
    dx: float,
    num_rays: int = 16
) -> Optional[float]:
    """
    Measures authentic bronchial wall thickness by radial sampling from lumen boundary
    to outer wall-parenchyma transition.
    Returns measured thickness in mm, or None if not reliably measurable.
    """
    h, w = slice_hu.shape
    if r_px < 1.5 or not (0 <= cx < w and 0 <= cy < h):
        return None

    wall_thicknesses_px = []
    max_search_px = int(max(r_px * 1.5, 10.0 / max(dx, 0.1)))

    for angle in np.linspace(0, 2 * np.pi, num_rays, endpoint=False):
        cos_a = np.cos(angle)
        sin_a = np.sin(angle)

        ray_dists = np.arange(0, max_search_px + 1)
        xs = np.clip(np.round(cx + (r_px + ray_dists) * cos_a).astype(int), 0, w - 1)
        ys = np.clip(np.round(cy + (r_px + ray_dists) * sin_a).astype(int), 0, h - 1)
        profile = slice_hu[ys, xs]

        in_wall = profile >= -450.0
        if not in_wall[0]:
            continue

        outer_transitions = np.where(~in_wall)[0]
        if len(outer_transitions) > 0 and outer_transitions[0] > 0:
            wall_thicknesses_px.append(float(outer_transitions[0]))

    if len(wall_thicknesses_px) >= 4:
        med_px = float(np.median(wall_thicknesses_px))
        thick_mm = round(med_px * dx, 1)
        if 0.4 <= thick_mm <= 8.0:
            return thick_mm
    return None


def detect_airway_artery_pairs(
    slice_hu: np.ndarray,
    airway_mask: np.ndarray,
    spacing_xy: Tuple[float, float],
    target_hint: Optional[Tuple[int, int]] = None
) -> Dict[str, Any]:
    """
    Automated Airway-Artery Matching (AAM) Algorithm:
    Identifies genuine intraparenchymal airway-artery cross-sections (Signet Ring sign):
    1. Extracts candidate bronchus lumens from airway envelope.
    2. Searches annular surrounding parenchymal zone for companion pulmonary artery (+20 to +180 HU).
    3. Calculates authentic physical diameters and Broncho-Arterial Ratio (BAR).
    4. Generates caliper endpoints for PACS presentation state.
    """
    dy, dx = spacing_xy
    h, w = slice_hu.shape
    if np.sum(airway_mask) < 4:
        return {"found": False, "has_companion_artery": False}

    lbl_br, n_br = label(airway_mask)
    if n_br == 0:
        return {"found": False, "has_companion_artery": False}

    counts = np.bincount(lbl_br.ravel())
    candidates = []

    for bid in range(1, n_br + 1):
        sz = counts[bid]
        r_px = np.sqrt(sz / np.pi)
        d_mm = 2.0 * r_px * dx
        if not (3.0 <= d_mm <= 28.0):
            continue

        coords = np.where(lbl_br == bid)
        cy = int(np.mean(coords[0]))
        cx = int(np.mean(coords[1]))

        # Exclude trachea / main carina in top center
        if cy < h * 0.22 and abs(cx - w // 2) < w * 0.12:
            continue

        # Annular search for companion vessel (+25 to +200 HU)
        min_sr = max(int(r_px * 0.7), 2)
        max_sr = max(int(r_px + 14), int(18.0 / dx))
        y0, y1 = max(0, cy - max_sr), min(h, cy + max_sr + 1)
        x0, x1 = max(0, cx - max_sr), min(w, cx + max_sr + 1)
        patch = slice_hu[y0:y1, x0:x1]

        v_cand = (patch >= 25.0) & (patch <= 200.0)
        lbl_v, n_v = label(v_cand)
        if n_v > 0:
            v_counts = np.bincount(lbl_v.ravel())
            for vid in range(1, n_v + 1):
                vsz = v_counts[vid]
                v_r_px = np.sqrt(vsz / np.pi)
                v_d_mm = 2.0 * v_r_px * dx
                if not (2.5 <= v_d_mm <= 15.0):
                    continue

                v_coords = np.where(lbl_v == vid)
                v_cy = int(np.mean(v_coords[0])) + y0
                v_cx = int(np.mean(v_coords[1])) + x0
                dist_px = np.hypot(v_cy - cy, v_cx - cx)
                dist_mm = dist_px * dx

                if dist_px < 1.5 or dist_mm > max_sr * dx:
                    continue

                bar = d_mm / max(v_d_mm, 0.1)
                # In physiological thoracic anatomy, signet rings have 1.05 <= BAR <= 2.6
                hint_pen = np.hypot(cy - target_hint[0], cx - target_hint[1]) * 0.05 if target_hint else 0.0
                score = (d_mm * 1.2) + (10.0 - abs(bar - 1.50) * 2.0) - (dist_mm * 0.15) - hint_pen

                candidates.append({
                    "br_cx": cx, "br_cy": cy, "br_d_mm": d_mm, "br_r_px": int(round(r_px)),
                    "art_cx": v_cx, "art_cy": v_cy, "art_d_mm": v_d_mm, "art_r_px": int(round(v_r_px)),
                    "bar": bar, "dist_mm": dist_mm, "score": score
                })

    if candidates:
        candidates.sort(key=lambda c: c["score"], reverse=True)
        top = candidates[0]
        return {
            "found": True,
            "has_companion_artery": True,
            "bronchus_center": (top["br_cx"], top["br_cy"]),
            "bronchus_diameter_mm": round(float(top["br_d_mm"]), 1),
            "artery_center": (top["art_cx"], top["art_cy"]),
            "artery_diameter_mm": round(float(top["art_d_mm"]), 1),
            "bar": round(float(top["bar"]), 2),
            "dist_mm": round(float(top["dist_mm"]), 1),
            "br_p1": (int(top["br_cx"] - top["br_r_px"]), int(top["br_cy"])),
            "br_p2": (int(top["br_cx"] + top["br_r_px"]), int(top["br_cy"])),
            "art_p1": (int(top["art_cx"] - top["art_r_px"]), int(top["art_cy"])),
            "art_p2": (int(top["art_cx"] + top["art_r_px"]), int(top["art_cy"]))
        }

    # Fallback: bronchus detected without clear companion artery
    if n_br > 0:
        top_bid = int(np.argmax(counts[1:]) + 1)
        sz = counts[top_bid]
        r_px = np.sqrt(sz / np.pi)
        d_mm = 2.0 * r_px * dx
        coords = np.where(lbl_br == top_bid)
        cy = int(np.mean(coords[0]))
        cx = int(np.mean(coords[1]))
        return {
            "found": True,
            "has_companion_artery": False,
            "bronchus_center": (cx, cy),
            "bronchus_diameter_mm": round(float(d_mm), 1),
            "artery_center": None,
            "artery_diameter_mm": None,
            "bar": None,
            "dist_mm": None,
            "br_p1": (int(cx - r_px), int(cy)),
            "br_p2": (int(cx + r_px), int(cy)),
            "art_p1": None,
            "art_p2": None
        }

    return {"found": False, "has_companion_artery": False}


def analyze_bronchiectasis_and_mucus(
    volume: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    window_preset: str = "lung",
    mucus_min_hu: float = 10.0,
    mucus_max_hu: float = 75.0,
    ham_threshold_hu: float = 70.0,
    bar_cutoff: float = 1.10,
    return_masks: bool = False,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Executes quantitative Clinical HRCT Bronchiectasis and Mucus Plug Impaction Analysis:
    1. Spatial normalization & anatomical verification (LPS+ canonical orientation)
    2. CT Acquisition Protocol & Physics Quality Assurance (QA)
    3. Lung parenchyma & conducting airway tree segmentation
    4. Multi-density mucus plug quantification (Standard Mucus vs High-Attenuation Mucus HAM)
    5. Genuine Airway-Artery Matching (AAM) with authentic BAR measurement
    6. Decoupled DICOM GSPS / TID 1500 Presentation State payload
    7. Publication-grade PACS Viewport rendering with compass, scale bar, and corner HUDs
    """
    t0 = time.time()
    device = get_optimal_device()
    dev_info = get_device_info()

    # 1. Enforce anatomical spatial integrity (canonical LPS+ orientation)
    volume = verify_and_enforce_anatomical_landmarks(volume)

    # 2. Physics & Protocol Quality Assurance
    qa_report = assess_ct_quality(volume, spacing, metadata=metadata)

    vx_vol_cm3 = (spacing[0] * spacing[1] * spacing[2]) / 1000.0
    tensor_vol = torch.from_numpy(volume).to(device)

    # 3. Extract thoracic cavity envelope (excludes scanner table and external ambient air)
    body_3d = np.zeros_like(volume, dtype=bool)
    for z in range(volume.shape[0]):
        sl = volume[z]
        body_sl = binary_fill_holes(sl > -450.0)
        lbls, num_f = label(body_sl)
        if num_f > 0:
            szs = ndimage_sum(body_sl, lbls, range(1, num_f + 1))
            largest_l = np.argmax(szs) + 1
            body_3d[z] = (lbls == largest_l)
        else:
            body_3d[z] = body_sl
    if np.sum(body_3d) < 100:
        body_3d = (volume > -990.0) & (volume < 1500.0)

    body_tensor = torch.from_numpy(body_3d).to(device)

    # 4. Extract genuine conducting airway tree & dilated bronchi
    air_inside_body = (volume > -1020.0) & (volume < -850.0) & body_3d

    patent_np = np.zeros_like(volume, dtype=bool)
    z_dim = volume.shape[0]
    for z in range(z_dim):
        sl_air = air_inside_body[z]
        if not np.any(sl_air):
            continue
        sl_vol = volume[z]
        lbl_air, n_air = label(sl_air)
        if n_air == 0:
            continue
        sizes = ndimage_sum(sl_air, lbl_air, range(1, n_air + 1))
        for i, sz in enumerate(sizes, 1):
            if 8 <= sz <= 2500:
                blob = (lbl_air == i)
                ring = binary_dilation(blob, iterations=2) & (~blob)
                if np.sum(ring) > 0 and np.mean(sl_vol[ring]) > -450.0:
                    patent_np[z] |= blob

    # If patent_np is sparse (e.g. synthetic volume or peripheral bronchi), fall back to air blobs < 2500 px
    if np.sum(patent_np) < 50:
        for z in range(z_dim):
            sl_air = air_inside_body[z]
            lbl_air, n_air = label(sl_air)
            if n_air == 0:
                continue
            sizes = ndimage_sum(sl_air, lbl_air, range(1, n_air + 1))
            for i, sz in enumerate(sizes, 1):
                if 8 <= sz <= 2500:
                    patent_np[z] |= (lbl_air == i)

    # 5. Detect intraluminal mucus plugs and mucoid impaction
    mucus_candidates = (tensor_vol >= mucus_min_hu) & (tensor_vol <= mucus_max_hu) & body_tensor
    ham_candidates = (tensor_vol > ham_threshold_hu) & (tensor_vol <= 120.0) & body_tensor

    mucus_cand_np = mucus_candidates.cpu().numpy().astype(bool)
    ham_cand_np = ham_candidates.cpu().numpy().astype(bool)

    dilated_envelope = binary_dilation(patent_np, iterations=2)
    ham_plugs_np = ham_cand_np & dilated_envelope

    if np.sum(ham_plugs_np) > 0:
        intraluminal_mucus = mucus_cand_np & binary_dilation(ham_plugs_np, iterations=2)
    else:
        intraluminal_mucus = mucus_cand_np & dilated_envelope

    mucus_plugs_np = ham_plugs_np | intraluminal_mucus

    total_mucus_voxels = int(np.sum(mucus_plugs_np))
    total_ham_voxels = int(np.sum(ham_plugs_np))
    total_tib_voxels = int(np.sum(mucus_plugs_np & (~ham_plugs_np)))

    # Authentic voxel-counted volumes
    mucus_vol_cm3 = round(total_mucus_voxels * vx_vol_cm3, 2)
    ham_vol_cm3 = round(total_ham_voxels * vx_vol_cm3, 2)
    tib_vol_cm3 = round(total_tib_voxels * vx_vol_cm3, 2)

    airway_vol_cm3 = round(float(np.sum(patent_np) * vx_vol_cm3), 2)
    total_lumen_vol = airway_vol_cm3 + mucus_vol_cm3
    occlusion_rate_pct = round((mucus_vol_cm3 / max(total_lumen_vol, 1e-6)) * 100.0, 1) if total_lumen_vol > 0 else 0.0
    occlusion_rate_pct = min(occlusion_rate_pct, 100.0)

    # 6. Find key slice with maximum mucus impaction or patent airway
    mucus_per_slice = np.sum(mucus_plugs_np, axis=(1, 2))
    if np.max(mucus_per_slice) > 0:
        key_slice_idx = int(np.argmax(mucus_per_slice))
    else:
        airway_per_slice = np.sum(patent_np, axis=(1, 2))
        if np.max(airway_per_slice) > 0:
            key_slice_idx = int(np.argmax(airway_per_slice))
        else:
            key_slice_idx = volume.shape[0] // 2

    # Extract spatial and anatomical locations of mucus plugs
    mucus_nodule_locations, lobar_distribution, distribution_summary = extract_mucus_locations(
        volume=volume,
        mucus_mask=mucus_plugs_np,
        patent_airway_mask=patent_np,
        spacing=spacing,
        ham_threshold_hu=ham_threshold_hu
    )

    # 7. Genuine Airway-Artery Matching (AAM) on Key Slice
    key_patent = patent_np[key_slice_idx]
    key_mucus = mucus_plugs_np[key_slice_idx]
    key_ham = ham_plugs_np[key_slice_idx]
    key_airway_envelope = key_patent | key_mucus

    target_hint = None
    if mucus_nodule_locations:
        c_vox = mucus_nodule_locations[0]["centroid_voxel"]
        target_hint = (c_vox[1], c_vox[2])

    aam_res = detect_airway_artery_pairs(
        slice_hu=volume[key_slice_idx],
        airway_mask=key_airway_envelope,
        spacing_xy=(spacing[1], spacing[2]),
        target_hint=target_hint
    )

    # 关键层没有检出伴行动脉时，取最近的、能检出气道-动脉配对的相邻层（±8 层内）。
    # 选层只看「是否检出配对」与距离，不看 BAR 大小，避免挑选最支持阳性结论的层面（选择偏倚）。
    key_slice_offset = 0
    if not aam_res.get("has_companion_artery"):
        search_offsets = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8]
        for off in search_offsets:
            cand_z = key_slice_idx + off
            if 0 <= cand_z < volume.shape[0]:
                cand_aam = detect_airway_artery_pairs(
                    slice_hu=volume[cand_z],
                    airway_mask=patent_np[cand_z] | mucus_plugs_np[cand_z],
                    spacing_xy=(spacing[1], spacing[2]),
                    target_hint=target_hint
                )
                if cand_aam.get("has_companion_artery") and cand_aam.get("bar") is not None:
                    key_slice_idx = cand_z
                    key_slice_offset = off
                    aam_res = cand_aam
                    key_patent = patent_np[key_slice_idx]
                    key_mucus = mucus_plugs_np[key_slice_idx]
                    key_ham = ham_plugs_np[key_slice_idx]
                    break

    if aam_res.get("found"):
        bronchus_caliber_mm = aam_res.get("bronchus_diameter_mm")
        if aam_res.get("has_companion_artery"):
            artery_caliber_mm = aam_res.get("artery_diameter_mm")
            bar_ratio = aam_res.get("bar")
        else:
            artery_caliber_mm = None
            bar_ratio = None
    else:
        bronchus_caliber_mm = None
        artery_caliber_mm = None
        bar_ratio = None

    # Authentic wall thickness measurement (radial sampling outward from lumen border)
    wall_thickness_mm = None
    wall_to_lumen_ratio = None
    if aam_res.get("found") and bronchus_caliber_mm is not None:
        bc_x, bc_y = aam_res.get("bronchus_center", (0, 0))
        r_px = bronchus_caliber_mm / (2.0 * max(spacing[2], 0.1))
        wall_thickness_mm = measure_bronchial_wall_thickness(
            volume[key_slice_idx], bc_x, bc_y, r_px, spacing[2]
        )
        if wall_thickness_mm is not None:
            wall_to_lumen_ratio = round(wall_thickness_mm / max(bronchus_caliber_mm, 0.1), 2)

    # 8. BAR 分档（只描述测值所在区间，不给柱状/曲张/囊状等形态学诊断）
    if bar_ratio is not None:
        if bar_ratio > 2.0:
            phenotype = f"BAR {bar_ratio} (> 2.0)"
        elif bar_ratio > 1.5:
            phenotype = f"BAR {bar_ratio} (1.5–2.0)"
        elif bar_ratio > bar_cutoff:
            phenotype = f"BAR {bar_ratio} ({bar_cutoff}–1.5)"
        else:
            phenotype = f"BAR {bar_ratio} (≤ {bar_cutoff})"
    elif bronchus_caliber_mm is not None:
        phenotype = f"支气管内径 {bronchus_caliber_mm} mm（伴行动脉未见清晰截面，BAR 未测得）"
    else:
        phenotype = "关键层未见明确气道截面 (未测得)"
    phenotype_method = "按单层 BAR 测值分档，仅描述测值区间，非影像形态学分型"

    # 9. 征象（按测值阈值的启发式标注，未经验证）
    signs_detected = []
    if bar_ratio is not None and bar_ratio > bar_cutoff:
        signs_detected.append(f"印戒征 (启发式: BAR = {bar_ratio} > {bar_cutoff})")
    if wall_to_lumen_ratio is not None and wall_to_lumen_ratio > 0.20:
        signs_detected.append(f"双轨征 (启发式: 管壁厚度/内径 {wall_to_lumen_ratio} > 0.20)")
    if mucus_vol_cm3 > 1.0:
        signs_detected.append(f"指套征 (启发式: 气道内粘液样密度 {mucus_vol_cm3} cm³ > 1.0 cm³)")
    if total_tib_voxels > 30:
        signs_detected.append(f"树芽征 (启发式: 外周细支气管内粘液样密度 {tib_vol_cm3} cm³)")
    if ham_vol_cm3 > 0.5:
        signs_detected.append(f"高密度粘液 (≥{ham_threshold_hu:.0f} HU 体积 {ham_vol_cm3} cm³)")
    if distribution_summary and distribution_summary != "双肺散在":
        signs_detected.append(f"粘液栓主要分布: {distribution_summary}")

    # 累及肺野启发式评分（6 个启发式肺野 × 0–3 分，借用 Reiff 0–18 量程）：按各肺野粘液栓体积计分。
    # 原始 Reiff 评分按各肺叶支扩形态类型计分，此处并非该定义，未经验证。
    reiff_score = 0
    for l_key, l_vol in lobar_distribution.items():
        if l_vol >= 4.0:
            reiff_score += 3
        elif l_vol >= 1.5:
            reiff_score += 2
        elif l_vol > 0.05:
            reiff_score += 1

    # 粘液栓分级：按阻塞率和粘液体积的启发式阈值，未经验证；只写阈值依据，不给严重度诊断
    if occlusion_rate_pct >= 40.0 or mucus_vol_cm3 >= 10.0:
        bhalla_score = "2 (阻塞率 ≥40% 或粘液体积 ≥10 cm³)"
    elif occlusion_rate_pct >= 15.0 or mucus_vol_cm3 >= 2.0:
        bhalla_score = "1 (阻塞率 ≥15% 或粘液体积 ≥2 cm³)"
    else:
        bhalla_score = "0 (阻塞率 <15% 且粘液体积 <2 cm³)"

    # 10. Build Calipers and Diagnostic Badges for PACS Presentation State (Authentic only)
    calipers = []
    if aam_res.get("found") and aam_res.get("br_p1") and aam_res.get("br_p2") and bronchus_caliber_mm is not None:
        calipers.append({
            "name": "Bronchus Lumen Caliper",
            "type": "bronchus",
            "p1": tuple(aam_res["br_p1"]),
            "p2": tuple(aam_res["br_p2"]),
            "value_mm": bronchus_caliber_mm,
            "color": (56, 189, 248, 255),
            "tick_len": 5
        })
        if aam_res.get("has_companion_artery") and aam_res.get("art_p1") and aam_res.get("art_p2") and artery_caliber_mm is not None:
            calipers.append({
                "name": "Companion Artery Caliper",
                "type": "companion_artery",
                "p1": tuple(aam_res["art_p1"]),
                "p2": tuple(aam_res["art_p2"]),
                "value_mm": artery_caliber_mm,
                "color": (251, 146, 60, 255),
                "tick_len": 4
            })

    # Diagnostic callout badge
    badges = []
    if aam_res.get("found") and bronchus_caliber_mm is not None:
        anchor_x = (aam_res["br_p1"][0] + (aam_res["art_p1"][0] if aam_res.get("art_p1") else aam_res["br_p2"][0])) // 2
        anchor_y = aam_res["br_p1"][1]

        if bar_ratio is not None and artery_caliber_mm is not None:
            badge_title = f"BAR: {bar_ratio:.2f} ({'> ' if bar_ratio > bar_cutoff else '≤ '}{bar_cutoff})"
            badge_sub = f"支气管 {bronchus_caliber_mm:.1f}mm / 伴行动脉 {artery_caliber_mm:.1f}mm"
        else:
            badge_title = f"支气管径: {bronchus_caliber_mm:.1f}mm"
            badge_sub = "伴行动脉未检出截面 (BAR未测得)"

        if mucus_nodule_locations:
            badge_detail = f"局部粘液栓: {occlusion_rate_pct}% 阻塞 ({mucus_nodule_locations[0]['zone']}, 启发式分区)"
        else:
            badge_detail = "支气管管腔通畅"

        badges.append({
            "anchor": (anchor_x, anchor_y),
            "title": badge_title,
            "subtitle": badge_sub,
            "detail": badge_detail
        })

    # 11. Render Publication-grade PACS Viewport Image
    ct_windowed = apply_ct_window(volume, window_name="lung")
    key_ct_uint8 = ct_windowed[key_slice_idx]

    overlays_rgba = [
        (key_patent, (0, 229, 255, 95)),    # Cyan: Airway lumen
        (key_mucus, (239, 68, 68, 190)),    # Crimson: Mucus plug
        (key_ham, (217, 70, 239, 230))      # Magenta: High-attenuation mucus HAM
    ]

    bar_str = f"{bar_ratio:.2f}" if bar_ratio is not None else "未测得"
    br_str = f"{bronchus_caliber_mm:.1f}mm" if bronchus_caliber_mm is not None else "未测得"
    art_str = f"{artery_caliber_mm:.1f}mm" if artery_caliber_mm is not None else "未检出"
    wt_str = f"{wall_to_lumen_ratio}" if wall_to_lumen_ratio is not None else "未测得"

    hud_lines = [
        f"计算加速: {dev_info.get('accelerator', str(device))} | 关键断面: 第 #{key_slice_idx} 层",
        f"BAR 分档: {phenotype}",
        f"BAR 扩张比: {bar_str} (支气管: {br_str} / 伴行动脉: {art_str}) | 管壁厚度比: {wt_str}",
        f"粘液栓体积: {mucus_vol_cm3} cm3 (HAM高密度: {ham_vol_cm3} cm3) | 阻塞率: {occlusion_rate_pct}%",
        f"优势分布: {distribution_summary}",
        f"粘液栓分级(启发式): {bhalla_score} | 累及肺野评分(启发式, 0-18): {reiff_score}"
    ]

    physical_loc_mm = float(key_slice_idx * spacing[0])
    png_bytes, b64_str = render_pacs_viewport(
        slice_uint8=key_ct_uint8,
        plane="axial",
        slice_idx=key_slice_idx,
        total_slices=volume.shape[0],
        physical_loc_mm=physical_loc_mm,
        spacing_xy=(spacing[1], spacing[2]),
        slice_thickness_mm=spacing[0],
        window_info={"center": -600, "width": 1500, "name": "lung"},
        calipers=calipers,
        diagnostic_badges=badges,
        title_banner="HEURION CHEST-CT // AIRWAY & MUCUS QUANTIFICATION (RESEARCH)",
        hud_lines=hud_lines,
        overlays_rgba=overlays_rgba
    )

    # 12. Build Structured Presentation State Payload (DICOM GSPS / TID 1500)
    ps_payload = build_presentation_state_payload(
        plane="axial",
        slice_idx=key_slice_idx,
        total_slices=volume.shape[0],
        physical_loc_mm=physical_loc_mm,
        spacing=spacing,
        window_center=-600,
        window_width=1500,
        window_name="lung",
        calipers=calipers,
        diagnostic_badges=badges,
        qa_summary=qa_report,
        contours=[]
    )

    elapsed = round(time.time() - t0, 3)
    primary_loc = mucus_nodule_locations[0]["full_location"] if mucus_nodule_locations else "未见明显局灶粘液栓"

    lobar_md = ""
    for l_name, l_vol in lobar_distribution.items():
        if l_vol > 0:
            lobar_md += f"  - **{l_name}**: `{l_vol} cm³`\n"

    nodule_md = ""
    if mucus_nodule_locations:
        for idx, n in enumerate(mucus_nodule_locations, 1):
            ham_badge = " [HAM高密度]" if n.get("is_ham") else ""
            nodule_md += (
                f"  {idx}. **{n['location_name']}** ({n['zone_type']}){ham_badge}：\n"
                f"     - 切片层号: `{n['slice_range']}` (中心断面: `第 #{n['centroid_slice']} 层`)\n"
                f"     - 栓塞体积: `{n['volume_cm3']} cm³` ({n['volume_mm3']} mm³)\n"
                f"     - 局部 CT 值: 均值 `{n['mean_hu']} HU` (峰值 `{n['max_hu']} HU`)\n"
            )

    bar_md = f"`{bar_ratio}`" if bar_ratio is not None else "`未测得 (未检出伴行动脉)`"
    wt_md = f"`{wall_to_lumen_ratio}`" if wall_to_lumen_ratio is not None else "`未测得`"

    res = {
        "status": "success",
        "analysis_type": "bronchiectasis_and_mucus",
        "accelerator": dev_info.get("accelerator", str(device)),
        "inference_duration_sec": elapsed,
        "key_slice_index": key_slice_idx,
        "metrics": {
            "broncho_arterial_ratio": bar_ratio,
            "bronchus_caliber_mm": bronchus_caliber_mm,
            "artery_caliber_mm": artery_caliber_mm,
            "wall_thickness_mm": wall_thickness_mm,
            "wall_to_lumen_ratio": wall_to_lumen_ratio,
            "morphological_phenotype": phenotype,
            "total_mucus_volume_cm3": mucus_vol_cm3,
            "high_attenuation_mucus_cm3": ham_vol_cm3,
            "tree_in_bud_volume_cm3": tib_vol_cm3,
            "total_airway_volume_cm3": airway_vol_cm3,
            "airway_occlusion_rate_pct": occlusion_rate_pct,
            "bhalla_mucoid_score": bhalla_score,
            "reiff_score": reiff_score,
            "score_method": "启发式：粘液栓分级按阻塞率和粘液体积、累及肺野评分按各启发式肺野粘液体积计算，并非 Bhalla/Reiff 原始定义，未经验证",
            "zone_method": "按层面高度的启发式分区（上/中/下肺野），非肺叶分割",
            "morphological_phenotype_method": phenotype_method,
            "key_slice_offset": key_slice_offset,
            "signs_detected": signs_detected,
            "lobar_distribution": lobar_distribution,
            "distribution_summary": distribution_summary,
            "primary_location": primary_loc,
            "mucus_nodule_locations": mucus_nodule_locations,
            "aam_detection": {
                "pair_found": aam_res.get("found", False),
                "has_companion_artery": aam_res.get("has_companion_artery", False),
                "distance_mm": aam_res.get("dist_mm")
            }
        },
        "key_slice_png_base64": b64_str,
        "key_slice_png_size_bytes": len(png_bytes),
        "presentation_state": ps_payload,
        "slice_metadata": {
            "slice_index": key_slice_idx,
            "total_slices": volume.shape[0],
            "physical_location_z_mm": physical_loc_mm,
            "slice_thickness_mm": spacing[0],
            "pixel_spacing_xy_mm": (spacing[1], spacing[2]),
            "window_preset": "lung",
            "window_center": -600,
            "window_width": 1500
        },
        "qa_report": qa_report,
        "summary_markdown": (
            f"### 气道与粘液栓定量结果\n\n"
            f"- **计算加速设备**: `{dev_info.get('accelerator')}` (耗时: {elapsed}s)\n"
            f"- **BAR 分档**: **{phenotype}**\n"
            f"- **支气管-伴行动脉径比 (BAR)**: {bar_md} (本实现以 BAR > {bar_cutoff} 计为管径比升高)\n"
            f"- **管壁厚度/内径比**: {wt_md} (本实现阈值 0.20)\n"
            f"- **粘液栓总体积**: `{mucus_vol_cm3} cm³` (≥{ham_threshold_hu:.0f} HU 高密度部分: `{ham_vol_cm3} cm³`)\n"
            f"- **气道管腔阻塞率**: `{occlusion_rate_pct}%`\n"
            f"- **粘液栓分级（启发式）**: `{bhalla_score}` | **累及肺野评分（启发式，0–18）**: `{reiff_score}`\n"
            f"- **CT 质控分级**: `{qa_report.get('protocol_tier')}` (可信度: {qa_report.get('quality_confidence_score')})\n"
            f"- **粘液栓分布（按层面高度的启发式分区，非肺叶分割）**:\n" +
            (lobar_md if lobar_md else "  - 双肺未见明显粘液栓聚集\n") +
            f"- **主要粘液栓位置 (Top {len(mucus_nodule_locations)})**:\n" +
            (nodule_md if nodule_md else "  - 未检测到孤立粘液结节\n") +
            f"- **按测值阈值标注的征象（启发式，未经验证）**:\n" +
            "".join([f"  - {s}\n" for s in signs_detected]) +
            f"\n> 上述所见需结合临床与实验室检查判断。"
        )
    }

    if return_masks:
        res["mask"] = mucus_plugs_np.astype(np.uint8)
        res["mucus_mask"] = mucus_plugs_np.astype(np.uint8)
        res["patent_airway_mask"] = patent_np.astype(np.uint8)

    return res
