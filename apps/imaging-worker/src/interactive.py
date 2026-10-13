"""
Heurion 2.0 - 交互式点击分割（经典图像处理方法，不含神经网络）
支持正/负提示点、包围盒约束与解剖先验掩膜约束。
两种模式：
- "hu_likelihood_gradient"：以种子点 CT 值的高斯似然 × 按 Sobel 梯度加权的距离衰减打分后阈值化；
- "fast"：种子点 CT 值容差 + 欧氏距离范围。
旧模式名 "deep" 已弃用，暂作为 "hu_likelihood_gradient" 的别名接受（它从来不是 MedSAM / VISTA-3D 推理），新调用请使用 "hu_likelihood_gradient"。
"""

from typing import List, Dict, Any, Tuple, Optional
import numpy as np
import scipy.ndimage as ndi


def interactive_segment_3d(
    volume: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    points: Optional[List[Dict[str, Any]]] = None,
    bbox: Optional[Dict[str, int]] = None,
    current_mask: Optional[np.ndarray] = None,
    intensity_tolerance_hu: Optional[float] = None,
    mode: str = "hu_likelihood_gradient",
    anatomical_prior: Optional[np.ndarray] = None,
) -> Dict[str, Any]:
    """
    基于点击提示的 3D 交互分割（经典方法，不含神经网络）。
    - "hu_likelihood_gradient"（别名 "deep"）：种子 CT 值高斯似然 × Sobel 梯度加权距离衰减；
    - "fast"：种子 CT 值容差 + 欧氏距离范围。
    至少需要一个带完整 z/y/x 坐标的正提示点，否则报错（不再默认取体积中心作种子）。

    Args:
        volume: 3D numpy array (Z, Y, X) containing voxel intensities (HU for CT)
        spacing: Voxel spacing (dz, dy, dx) in mm
        points: List of prompt clicks: [{'z': int, 'y': int, 'x': int, 'is_positive': bool}]
        bbox: Optional 3D bounding box: {'z_min': int, 'z_max': int, 'y_min': int, 'y_max': int, 'x_min': int, 'x_max': int}
        current_mask: 保留参数，当前实现不使用
        intensity_tolerance_hu: Intensity range around seed for adaptive segmentation (defaults to adaptive IQR)
        mode: "hu_likelihood_gradient"（别名 "deep"）或 "fast"
        anatomical_prior: Optional boolean 3D mask restricting candidate region (e.g. from TotalSegmentator)

    Returns:
        Dict containing binary segmentation mask, volume metrics, and refined key slice index.
    """
    z_dim, y_dim, x_dim = volume.shape
    dz, dy, dx = [float(s) for s in spacing]
    voxel_vol_cm3 = (dz * dy * dx) / 1000.0

    if mode == "deep":
        mode = "hu_likelihood_gradient"
    if mode not in ("hu_likelihood_gradient", "fast"):
        raise ValueError(f"未知分割模式：{mode}（可选 hu_likelihood_gradient / fast）")

    # 提示点必须带完整坐标，缺失即报错，不补中心
    for idx, p in enumerate(points or []):
        missing = [k for k in ("z", "y", "x") if p.get(k) is None]
        if missing:
            raise ValueError(f"第 {idx + 1} 个提示点缺少坐标 {missing}")

    pos_points = [p for p in (points or []) if p.get('is_positive', True)]
    neg_points = [p for p in (points or []) if not p.get('is_positive', True)]
    if not pos_points:
        raise ValueError("至少需要一个正提示点（is_positive=True）才能分割，不使用默认种子")

    # 1. Collect sample intensities at positive click seeds
    seed_values = []
    for p in pos_points:
        pz = int(np.clip(p['z'], 0, z_dim - 1))
        py = int(np.clip(p['y'], 0, y_dim - 1))
        px = int(np.clip(p['x'], 0, x_dim - 1))
        # Take a 3x3x3 neighborhood around seed to be robust to single-pixel noise
        z_lo, z_hi = max(0, pz - 1), min(z_dim, pz + 2)
        y_lo, y_hi = max(0, py - 1), min(y_dim, py + 2)
        x_lo, x_hi = max(0, px - 1), min(x_dim, px + 2)
        seed_values.extend(volume[z_lo:z_hi, y_lo:y_hi, x_lo:x_hi].flatten())

    target_hu = float(np.median(seed_values))
    iqr_val = float(np.percentile(seed_values, 75) - np.percentile(seed_values, 25))
    tol = intensity_tolerance_hu or max(35.0, min(120.0, iqr_val * 2.5 + 25.0))

    # 2. Spatial Distance Transform from positive seeds
    pos_seed_grid = np.zeros(volume.shape, dtype=bool)
    for p in pos_points:
        pz = int(np.clip(p['z'], 0, z_dim - 1))
        py = int(np.clip(p['y'], 0, y_dim - 1))
        px = int(np.clip(p['x'], 0, x_dim - 1))
        pos_seed_grid[pz, py, px] = True

    if np.any(pos_seed_grid):
        dist_to_pos_mm = ndi.distance_transform_edt(~pos_seed_grid, sampling=(dz, dy, dx))
    else:
        dist_to_pos_mm = np.full(volume.shape, 999.0, dtype=np.float32)

    # 3. Spatial Distance Transform from negative seeds
    neg_seed_grid = np.zeros(volume.shape, dtype=bool)
    for p in neg_points:
        pz = int(np.clip(p['z'], 0, z_dim - 1))
        py = int(np.clip(p['y'], 0, y_dim - 1))
        px = int(np.clip(p['x'], 0, x_dim - 1))
        neg_seed_grid[pz, py, px] = True

    if np.any(neg_seed_grid):
        dist_to_neg_mm = ndi.distance_transform_edt(~neg_seed_grid, sampling=(dz, dy, dx))
    else:
        dist_to_neg_mm = np.full(volume.shape, 999.0, dtype=np.float32)

    # 4. Dual-Track Inference Branching
    if mode == "hu_likelihood_gradient":
        # 种子 CT 值的高斯似然（非神经网络语义模型）
        seed_arr = np.array(seed_values, dtype=np.float32)
        mu_fg = float(np.median(seed_arr))
        sigma_fg = max(14.0, float(np.std(seed_arr)) * 1.5)

        p_hu = np.exp(-((volume - mu_fg) ** 2) / (2.0 * (sigma_fg ** 2)))

        # 3D Sobel gradient magnitude / edge barrier
        gz = ndi.sobel(volume, axis=0) / dz
        gy = ndi.sobel(volume, axis=1) / dy
        gx = ndi.sobel(volume, axis=2) / dx
        grad_mag = np.sqrt(gz ** 2 + gy ** 2 + gx ** 2)
        grad_barrier = grad_mag / (grad_mag + 50.0)

        # Modulate spatial distance by gradient barrier
        eff_pos_dist = dist_to_pos_mm * (1.0 + 1.2 * grad_barrier)

        score = p_hu * np.exp(-eff_pos_dist / 25.0)

        if np.any(neg_seed_grid):
            repel_factor = 1.0 - np.exp(-(dist_to_neg_mm ** 2) / (2.0 * (8.0 ** 2)))
            score = score * repel_factor
            score[dist_to_neg_mm < 4.0] = 0.0

        candidate = (score >= 0.15) & (p_hu >= 0.15) & (dist_to_pos_mm <= 45.0)
    else:
        # Fast Heuristic EDT Mode
        hu_diff = np.abs(volume - target_hu)
        intensity_match = hu_diff <= tol
        spatial_reach = dist_to_pos_mm <= 45.0
        candidate = intensity_match & spatial_reach
        if np.any(neg_seed_grid):
            neg_repel = (dist_to_neg_mm < dist_to_pos_mm) | (dist_to_neg_mm < 6.0)
            candidate = candidate & (~neg_repel)

    # 5. Anatomical Prior Constraint (TotalSegmentator atlas mask)
    if anatomical_prior is not None and anatomical_prior.shape == volume.shape:
        candidate = candidate & (anatomical_prior > 0)

    # Bounding box constraint if provided
    if bbox:
        b_zmin = max(0, bbox.get('z_min', 0))
        b_zmax = min(z_dim, bbox.get('z_max', z_dim - 1) + 1)
        b_ymin = max(0, bbox.get('y_min', 0))
        b_ymax = min(y_dim, bbox.get('y_max', y_dim - 1) + 1)
        b_xmin = max(0, bbox.get('x_min', 0))
        b_xmax = min(x_dim, bbox.get('x_max', x_dim - 1) + 1)
        
        box_mask = np.zeros(volume.shape, dtype=bool)
        box_mask[b_zmin:b_zmax, b_ymin:b_ymax, b_xmin:b_xmax] = True
        candidate = candidate & box_mask

    # 6. Connected Component Extraction preserving positive seeds
    labeled, num_features = ndi.label(candidate)
    final_mask = np.zeros(volume.shape, dtype=np.uint8)

    if num_features > 0:
        # 只保留与正提示点重叠的连通域；种子不在候选区内时结果为空，不拿其他连通域替代
        seed_labels = np.unique(labeled[pos_seed_grid])
        seed_labels = seed_labels[seed_labels > 0]
        for sl in seed_labels:
            final_mask[labeled == sl] = 1

    # Morphological closing to seal small micro-holes
    struct = ndi.generate_binary_structure(3, 1)
    final_mask = ndi.binary_closing(final_mask, structure=struct).astype(np.uint8)

    # Negative seed hard veto
    if np.any(neg_seed_grid):
        dilated_neg = ndi.binary_dilation(neg_seed_grid, iterations=2)
        final_mask[dilated_neg] = 0

    voxel_count = int(np.sum(final_mask))
    volume_cm3 = round(voxel_count * voxel_vol_cm3, 3)

    # Determine key slice (primary positive click slice, or slice with largest cross-sectional area)
    if voxel_count > 0:
        z_areas = np.sum(final_mask, axis=(1, 2))
        best_slice = int(np.argmax(z_areas))
        if pos_points:
            primary_click_z = pos_points[0].get('z')
            if primary_click_z is not None and 0 <= primary_click_z < z_dim and z_areas[primary_click_z] > 0:
                best_slice = primary_click_z
    else:
        best_slice = int(np.clip(int(pos_points[0]['z']), 0, z_dim - 1))

    return {
        "status": "success",
        "engine_mode": mode,
        "method": "种子点 CT 值高斯似然 × Sobel 梯度加权距离衰减（经典方法，非神经网络）" if mode == "hu_likelihood_gradient" else "种子点 CT 值容差 + 欧氏距离范围（经典方法，非神经网络）",
        "mask": final_mask,
        "voxel_count": voxel_count,
        "volume_cm3": volume_cm3,
        "key_slice_index": best_slice,
        "target_hu": round(target_hu, 1),
        "tolerance_hu": round(tol, 1),
        "positive_prompts_count": len(pos_points),
        "negative_prompts_count": len(neg_points),
    }
