"""
Heurion 2.0 - 3D Radiomics Feature Extraction Engine
特征定义参照 IBSI 命名，但本实现未做 IBSI 参考数据集的一致性验证，数值不保证与 IBSI 参考值或 PyRadiomics 一致。
表面积为体素面法（统计暴露体素面），不是三角网格（marching cubes）表面积。
ROI 为空或体素不足时对应特征返回 None，不填 0。

Extracts quantitative multi-dimensional imaging biomarkers:
1. 3D Morphological / Shape Features (Volume, Surface Area, Sphericity, Compactness, Axes, Diameters)
2. First-Order Intensity Statistics (Mean, Std, Skewness, Kurtosis, Entropy, Percentiles, IQR)
3. 3D GLCM (Gray Level Co-occurrence Matrix) Texture Features
4. 3D GLRLM (Gray Level Run Length Matrix) Texture Features
"""

import math
from typing import Dict, Any, Tuple, Optional, List
import numpy as np
import scipy.ndimage as ndi


def _max_pairwise_distance(pts: np.ndarray) -> float:
    """点集两两最大距离：优先在三维凸包顶点上穷举；点共面/共线导致凸包失败时对全部点分块精确计算。"""
    from scipy.spatial import ConvexHull

    cand = pts
    if len(pts) >= 5:
        try:
            cand = pts[ConvexHull(pts).vertices]
        except Exception:
            cand = pts
    best = 0.0
    chunk = 2048
    for i in range(0, len(cand), chunk):
        block = cand[i:i + chunk]
        d2 = np.sum((block[:, None, :] - cand[None, :, :]) ** 2, axis=-1)
        best = max(best, float(np.max(d2)))
    return float(np.sqrt(best))


def compute_shape_features(
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.0, 1.0, 1.0)
) -> Dict[str, float]:
    """
    3D 形态特征（体素面法表面积；未经 IBSI 一致性验证）。
    
    Args:
        mask: 3D binary numpy array (Z, Y, X) where >0 represents the lesion ROI
        spacing: Voxel spacing in mm (dz, dy, dx)
    """
    dz, dy, dx = [float(s) for s in spacing]
    voxel_volume_mm3 = dz * dy * dx
    
    binary_mask = (mask > 0).astype(np.uint8)
    voxel_count = int(np.sum(binary_mask))
    
    if voxel_count == 0:
        return {
            "voxel_count": 0,
            "volume_cm3": None,
            "volume_mm3": None,
            "surface_area_mm2": None,
            "surface_to_volume_ratio": None,
            "sphericity": None,
            "compactness_1": None,
            "compactness_2": None,
            "spherical_disproportion": None,
            "major_axis_length_mm": None,
            "minor_axis_length_mm": None,
            "least_axis_length_mm": None,
            "elongation": None,
            "flatness": None,
            "max_3d_diameter_mm": None,
        }

    volume_mm3 = voxel_count * voxel_volume_mm3
    volume_cm3 = volume_mm3 / 1000.0

    # Surface Area calculation via voxel face adjacency
    # Check 6-connected neighbor faces that are outside the mask
    # Cast to int32 to prevent uint8 underflow wrap-around (0 - 1 = 255) in np.diff
    pad_mask = np.pad((mask > 0).astype(np.int32), 1, mode="constant", constant_values=0)
    
    # Boundary faces in each dimension (both + and - directions)
    diff_z = np.abs(np.diff(pad_mask, axis=0))
    diff_y = np.abs(np.diff(pad_mask, axis=1))
    diff_x = np.abs(np.diff(pad_mask, axis=2))
    
    # Face areas: z-face area = dy*dx; y-face area = dz*dx; x-face area = dz*dy
    area_z = float(np.sum(diff_z)) * (dy * dx)
    area_y = float(np.sum(diff_y)) * (dz * dx)
    area_x = float(np.sum(diff_x)) * (dz * dy)
    surface_area_mm2 = area_z + area_y + area_x

    # Sphericity = (pi^(1/3) * (6 * V)^(2/3)) / A
    # Compactness 1 = V / (sqrt(pi) * A^(1.5))
    # Compactness 2 = 36 * pi * V^2 / A^3 = Sphericity^3
    if surface_area_mm2 > 0:
        surface_to_volume_ratio = surface_area_mm2 / volume_mm3
        sphericity = (math.pi ** (1.0 / 3.0) * ((6.0 * volume_mm3) ** (2.0 / 3.0))) / surface_area_mm2
        # 不钳制：体素面法高估表面积，球形度通常偏低；如出现 >1 也如实输出
        compactness_1 = volume_mm3 / (math.sqrt(math.pi) * (surface_area_mm2 ** 1.5))
        compactness_2 = sphericity ** 3.0
        spherical_disproportion = 1.0 / sphericity if sphericity > 0 else 0.0
    else:
        surface_to_volume_ratio = 0.0
        sphericity = 0.0
        compactness_1 = 0.0
        compactness_2 = 0.0
        spherical_disproportion = 0.0

    # Coordinates of ROI voxels in physical space (mm)
    z_idx, y_idx, x_idx = np.where(binary_mask > 0)
    pts_physical = np.stack([
        z_idx.astype(np.float64) * dz,
        y_idx.astype(np.float64) * dy,
        x_idx.astype(np.float64) * dx
    ], axis=1)

    # Centroid and Covariance / Inertia Matrix
    centroid = np.mean(pts_physical, axis=0)
    centered = pts_physical - centroid
    cov_matrix = np.cov(centered, rowvar=False) if len(pts_physical) > 1 else np.eye(3)
    
    # Eigenvalues of covariance matrix
    eigenvals = np.linalg.eigvalsh(cov_matrix)
    eigenvals = np.sort(np.maximum(eigenvals, 1e-8))[::-1]  # descending: lambda1 >= lambda2 >= lambda3
    
    # Semi-axes of equivalent ellipsoid: a = 2*sqrt(lambda1), b = 2*sqrt(lambda2), c = 2*sqrt(lambda3)
    major_axis = 4.0 * math.sqrt(float(eigenvals[0]))
    minor_axis = 4.0 * math.sqrt(float(eigenvals[1]))
    least_axis = 4.0 * math.sqrt(float(eigenvals[2]))
    
    elongation = math.sqrt(float(eigenvals[1]) / float(eigenvals[0])) if eigenvals[0] > 0 else 1.0
    flatness = math.sqrt(float(eigenvals[2]) / float(eigenvals[0])) if eigenvals[0] > 0 else 1.0

    # 最大三维径 (Feret Max)：表面体素中心两两最大距离。
    # 最远点对必在凸包顶点上，先求凸包再在顶点间穷举，结果确定且精确
    struct = ndi.generate_binary_structure(3, 1)
    eroded = ndi.binary_erosion(binary_mask, structure=struct)
    surface_mask = binary_mask & (~eroded)
    sz, sy, sx = np.where(surface_mask > 0)

    if len(sz) > 1:
        surf_pts = np.stack([
            sz.astype(np.float64) * dz,
            sy.astype(np.float64) * dy,
            sx.astype(np.float64) * dx
        ], axis=1)
        max_3d_diameter_mm = _max_pairwise_distance(surf_pts)
    else:
        max_3d_diameter_mm = 0.0

    return {
        "voxel_count": voxel_count,
        "volume_cm3": round(volume_cm3, 3),
        "volume_mm3": round(volume_mm3, 2),
        "surface_area_mm2": round(surface_area_mm2, 2),
        "surface_to_volume_ratio": round(surface_to_volume_ratio, 4),
        "sphericity": round(sphericity, 4),
        "compactness_1": round(compactness_1, 5),
        "compactness_2": round(compactness_2, 4),
        "spherical_disproportion": round(spherical_disproportion, 3),
        "major_axis_length_mm": round(major_axis, 2),
        "minor_axis_length_mm": round(minor_axis, 2),
        "least_axis_length_mm": round(least_axis, 2),
        "elongation": round(elongation, 4),
        "flatness": round(flatness, 4),
        "max_3d_diameter_mm": round(max_3d_diameter_mm, 2),
    }


def compute_first_order_features(
    volume: np.ndarray,
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.0, 1.0, 1.0),
    num_bins: int = 32
) -> Dict[str, float]:
    """
    一阶灰度统计与直方图特征（未经 IBSI 一致性验证）。
    
    Args:
        volume: 3D numpy array of image intensities (e.g. HU for CT, signal intensity for MRI)
        mask: 3D binary numpy array of the ROI
        spacing: Voxel spacing (dz, dy, dx)
        num_bins: Number of histogram bins for entropy & uniformity
    """
    voxel_vol = float(spacing[0] * spacing[1] * spacing[2])
    roi_voxels = volume[mask > 0].astype(np.float64)
    n = len(roi_voxels)
    
    if n == 0:
        return {
            "mean": None,
            "std": None,
            "variance": None,
            "skewness": None,
            "kurtosis": None,
            "median": None,
            "min": None,
            "max": None,
            "range": None,
            "iqr": None,
            "p10": None,
            "p90": None,
            "mad": None,
            "rms": None,
            "energy": None,
            "total_energy": None,
            "entropy": None,
            "uniformity": None,
        }

    mean_val = float(np.mean(roi_voxels))
    var_val = float(np.var(roi_voxels))
    std_val = float(np.sqrt(var_val))
    
    # Skewness & Kurtosis
    if std_val > 1e-6:
        z_scores = (roi_voxels - mean_val) / std_val
        skewness = float(np.mean(z_scores ** 3))
        kurtosis = float(np.mean(z_scores ** 4))  # Pearson kurtosis (normal = 3)
    else:
        skewness = 0.0
        kurtosis = 3.0

    median_val = float(np.median(roi_voxels))
    min_val = float(np.min(roi_voxels))
    max_val = float(np.max(roi_voxels))
    range_val = max_val - min_val

    p10 = float(np.percentile(roi_voxels, 10))
    p25 = float(np.percentile(roi_voxels, 25))
    p75 = float(np.percentile(roi_voxels, 75))
    p90 = float(np.percentile(roi_voxels, 90))
    iqr = p75 - p25

    mad = float(np.mean(np.abs(roi_voxels - mean_val)))
    rms = float(np.sqrt(np.mean(roi_voxels ** 2)))
    energy = float(np.sum(roi_voxels ** 2))
    total_energy = energy * voxel_vol

    # Histogram entropy and uniformity
    hist_counts, _ = np.histogram(roi_voxels, bins=num_bins)
    probs = hist_counts.astype(np.float64) / n
    probs_nonzero = probs[probs > 0]
    entropy = -float(np.sum(probs_nonzero * np.log2(probs_nonzero)))
    uniformity = float(np.sum(probs ** 2))

    return {
        "mean": round(mean_val, 2),
        "std": round(std_val, 2),
        "variance": round(var_val, 2),
        "skewness": round(skewness, 4),
        "kurtosis": round(kurtosis, 4),
        "median": round(median_val, 2),
        "min": round(min_val, 2),
        "max": round(max_val, 2),
        "range": round(range_val, 2),
        "iqr": round(iqr, 2),
        "p10": round(p10, 2),
        "p90": round(p90, 2),
        "mad": round(mad, 2),
        "rms": round(rms, 2),
        "energy": round(energy, 1),
        "total_energy": round(total_energy, 1),
        "entropy": round(entropy, 4),
        "uniformity": round(uniformity, 4),
    }


def discretize_roi(
    volume: np.ndarray,
    mask: np.ndarray,
    num_bins: int = 16
) -> np.ndarray:
    """Discretizes ROI voxel values into num_bins discrete levels (0 to num_bins-1)."""
    roi_voxels = volume[mask > 0]
    if len(roi_voxels) == 0:
        return np.zeros_like(volume, dtype=np.int32)
    
    v_min = np.min(roi_voxels)
    v_max = np.max(roi_voxels)
    span = v_max - v_min
    if span <= 1e-6:
        return np.zeros_like(volume, dtype=np.int32)
    
    # Scale to [0, num_bins - 1]
    scaled = np.floor(((volume - v_min) / span) * num_bins).astype(np.int32)
    scaled = np.clip(scaled, 0, num_bins - 1)
    return scaled


def compute_glcm_features(
    volume: np.ndarray,
    mask: np.ndarray,
    num_bins: int = 16
) -> Dict[str, float]:
    """
    Computes 3D Gray Level Co-occurrence Matrix (GLCM) texture features across 13 symmetric directions.
    
    Metrics:
        - Contrast
        - Dissimilarity
        - Homogeneity (Inverse Difference Moment)
        - Joint Energy (Angular Second Moment)
        - Joint Entropy
        - Correlation
    """
    binary_mask = (mask > 0)
    if np.sum(binary_mask) < 2:
        return {
            "contrast": None,
            "dissimilarity": None,
            "homogeneity": None,
            "energy_asm": None,
            "joint_entropy": None,
            "correlation": None,
        }

    discrete = discretize_roi(volume, binary_mask, num_bins=num_bins)
    
    # 13 primary non-redundant directions in 3D
    offsets = [
        (0, 0, 1), (0, 1, 0), (1, 0, 0),
        (0, 1, 1), (0, 1, -1),
        (1, 0, 1), (1, 0, -1),
        (1, 1, 0), (1, -1, 0),
        (1, 1, 1), (1, 1, -1),
        (1, -1, 1), (1, -1, -1)
    ]
    
    P_accum = np.zeros((num_bins, num_bins), dtype=np.float64)
    z_dim, y_dim, x_dim = volume.shape

    for dz, dy, dx in offsets:
        # Determine valid overlapping slices
        z_src = slice(max(0, -dz), min(z_dim, z_dim - dz))
        z_dst = slice(max(0, dz), min(z_dim, z_dim + dz))
        y_src = slice(max(0, -dy), min(y_dim, y_dim - dy))
        y_dst = slice(max(0, dy), min(y_dim, y_dim + dy))
        x_src = slice(max(0, -dx), min(x_dim, x_dim - dx))
        x_dst = slice(max(0, dx), min(x_dim, x_dim + dx))

        src_mask = binary_mask[z_src, y_src, x_src]
        dst_mask = binary_mask[z_dst, y_dst, x_dst]
        valid_pairs = src_mask & dst_mask
        
        if np.any(valid_pairs):
            vals_src = discrete[z_src, y_src, x_src][valid_pairs]
            vals_dst = discrete[z_dst, y_dst, x_dst][valid_pairs]
            
            # Symmetrized pair counts
            np.add.at(P_accum, (vals_src, vals_dst), 1.0)
            np.add.at(P_accum, (vals_dst, vals_src), 1.0)

    total_pairs = np.sum(P_accum)
    if total_pairs <= 0:
        return {
            "contrast": None,
            "dissimilarity": None,
            "homogeneity": None,
            "energy_asm": None,
            "joint_entropy": None,
            "correlation": None,
        }

    P = P_accum / total_pairs
    
    # Coordinate grids
    i_indices, j_indices = np.indices((num_bins, num_bins), dtype=np.float64)
    diff = np.abs(i_indices - j_indices)

    # 1. Contrast: sum(|i - j|^2 * P)
    contrast = float(np.sum((diff ** 2) * P))

    # 2. Dissimilarity: sum(|i - j| * P)
    dissimilarity = float(np.sum(diff * P))

    # 3. Homogeneity (Inverse Difference Moment): sum(P / (1 + |i - j|^2))
    homogeneity = float(np.sum(P / (1.0 + (diff ** 2))))

    # 4. Joint Energy (Angular Second Moment): sum(P^2)
    energy_asm = float(np.sum(P ** 2))

    # 5. Joint Entropy: -sum(P * log2(P))
    p_nonzero = P[P > 0]
    joint_entropy = -float(np.sum(p_nonzero * np.log2(p_nonzero)))

    # 6. Correlation
    mu_i = float(np.sum(i_indices * P))
    mu_j = float(np.sum(j_indices * P))
    var_i = float(np.sum(((i_indices - mu_i) ** 2) * P))
    var_j = float(np.sum(((j_indices - mu_j) ** 2) * P))
    cov_ij = float(np.sum((i_indices - mu_i) * (j_indices - mu_j) * P))
    
    denom = math.sqrt(var_i * var_j) if (var_i > 0 and var_j > 0) else 1e-6
    correlation = cov_ij / denom

    return {
        "contrast": round(contrast, 4),
        "dissimilarity": round(dissimilarity, 4),
        "homogeneity": round(homogeneity, 4),
        "energy_asm": round(energy_asm, 5),
        "joint_entropy": round(joint_entropy, 4),
        "correlation": round(correlation, 4),
    }


def compute_glrlm_features(
    volume: np.ndarray,
    mask: np.ndarray,
    num_bins: int = 16
) -> Dict[str, float]:
    """
    Computes 3D Gray Level Run Length Matrix (GLRLM) texture features along Z, Y, X axes.
    
    Metrics:
        - Short Run Emphasis (SRE)
        - Long Run Emphasis (LRE)
        - Gray Level Non-uniformity (GLN)
        - Run Length Non-uniformity (RLN)
        - Run Percentage (RP)
        - Low Gray Level Run Emphasis (LGRE)
        - High Gray Level Run Emphasis (HGRE)
    """
    binary_mask = (mask > 0)
    nv = int(np.sum(binary_mask))
    if nv < 2:
        return {
            "short_run_emphasis": None,
            "long_run_emphasis": None,
            "gray_level_nonuniformity": None,
            "run_length_nonuniformity": None,
            "run_percentage": None,
            "low_gray_run_emphasis": None,
            "high_gray_run_emphasis": None,
        }

    discrete = discretize_roi(volume, binary_mask, num_bins=num_bins)
    max_dim = max(volume.shape)
    R_accum = np.zeros((num_bins, max_dim + 1), dtype=np.float64)

    # 1D line scanner helper
    def scan_lines(data_2d: np.ndarray, mask_2d: np.ndarray):
        for line_data, line_mask in zip(data_2d, mask_2d):
            if not np.any(line_mask):
                continue
            cur_val = -1
            cur_len = 0
            for v, m in zip(line_data, line_mask):
                if m:
                    if v == cur_val:
                        cur_len += 1
                    else:
                        if cur_len > 0 and cur_val >= 0:
                            R_accum[cur_val, cur_len] += 1.0
                        cur_val = v
                        cur_len = 1
                else:
                    if cur_len > 0 and cur_val >= 0:
                        R_accum[cur_val, cur_len] += 1.0
                    cur_val = -1
                    cur_len = 0
            if cur_len > 0 and cur_val >= 0:
                R_accum[cur_val, cur_len] += 1.0

    # Scan along X axis (across Z, Y)
    z_dim, y_dim, x_dim = volume.shape
    scan_lines(discrete.reshape(-1, x_dim), binary_mask.reshape(-1, x_dim))

    # Scan along Y axis (across Z, X)
    d_y = np.transpose(discrete, (0, 2, 1)).reshape(-1, y_dim)
    m_y = np.transpose(binary_mask, (0, 2, 1)).reshape(-1, y_dim)
    scan_lines(d_y, m_y)

    # Scan along Z axis (across Y, X)
    d_z = np.transpose(discrete, (1, 2, 0)).reshape(-1, z_dim)
    m_z = np.transpose(binary_mask, (1, 2, 0)).reshape(-1, z_dim)
    scan_lines(d_z, m_z)

    total_runs = float(np.sum(R_accum))
    if total_runs <= 0:
        return {
            "short_run_emphasis": None,
            "long_run_emphasis": None,
            "gray_level_nonuniformity": None,
            "run_length_nonuniformity": None,
            "run_percentage": None,
            "low_gray_run_emphasis": None,
            "high_gray_run_emphasis": None,
        }

    # Grids: gray level i (0 to num_bins-1), run length l (1 to max_dim)
    i_levels = np.arange(num_bins, dtype=np.float64)[:, np.newaxis]
    run_lengths = np.arange(max_dim + 1, dtype=np.float64)[np.newaxis, :]
    run_lengths[0, 0] = 1.0 # avoid div by zero for unused 0 index

    # SRE: sum(R(i,l) / l^2) / Nr
    sre = float(np.sum(R_accum[:, 1:] / (run_lengths[:, 1:] ** 2)) / total_runs)

    # LRE: sum(l^2 * R(i,l)) / Nr
    lre = float(np.sum((run_lengths[:, 1:] ** 2) * R_accum[:, 1:]) / total_runs)

    # GLN: sum_i( (sum_l R(i,l))^2 ) / Nr
    runs_per_gray = np.sum(R_accum[:, 1:], axis=1)
    gln = float(np.sum(runs_per_gray ** 2) / total_runs)

    # RLN: sum_l( (sum_i R(i,l))^2 ) / Nr
    runs_per_len = np.sum(R_accum[:, 1:], axis=0)
    rln = float(np.sum(runs_per_len ** 2) / total_runs)

    # RP: Nr / Nv (across the 3 scanned axes, normalized by total scanned voxels)
    total_vox_scanned = 3.0 * nv
    rp = float(total_runs / total_vox_scanned) if total_vox_scanned > 0 else 0.0

    # LGRE: sum(R(i,l) / (i+1)^2) / Nr
    lgre = float(np.sum(R_accum[:, 1:] / ((i_levels + 1.0) ** 2)) / total_runs)

    # HGRE: sum((i+1)^2 * R(i,l)) / Nr
    hgre = float(np.sum(((i_levels + 1.0) ** 2) * R_accum[:, 1:]) / total_runs)

    return {
        "short_run_emphasis": round(sre, 4),
        "long_run_emphasis": round(lre, 3),
        "gray_level_nonuniformity": round(gln, 2),
        "run_length_nonuniformity": round(rln, 2),
        "run_percentage": round(rp, 4),
        "low_gray_run_emphasis": round(lgre, 4),
        "high_gray_run_emphasis": round(hgre, 2),
    }


def extract_radiomics_features(
    volume: np.ndarray,
    mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.0, 1.0, 1.0),
    num_bins: int = 16
) -> Dict[str, Any]:
    """
    提取 3D 影像组学特征（未经 IBSI 一致性验证）：
    - 3D Shape & Morphology
    - First-order Histogram Statistics
    - GLCM Texture
    - GLRLM Texture
    
    Returns structured grouped features, a flat dictionary suitable for dataset rows/CSV,
    and a formatted clinical Markdown report.
    """
    if int(np.sum(mask > 0)) == 0:
        # ROI 为空：没有可计算的特征，直接报错状态，不填 0
        return {
            "status": "error",
            "error": "ROI 掩膜为空，未计算影像组学特征",
            "lesion_voxel_count": 0,
            "feature_count": 0,
            "voxel_spacing_mm": list(spacing),
            "feature_groups": None,
            "features_flat": {},
            "markdown_report": "",
        }

    shape_feats = compute_shape_features(mask, spacing=spacing)
    first_order_feats = compute_first_order_features(volume, mask, spacing=spacing)
    glcm_feats = compute_glcm_features(volume, mask, num_bins=num_bins)
    glrlm_feats = compute_glrlm_features(volume, mask, num_bins=num_bins)

    # Create flat feature dictionary with standard radiomics prefixes
    flat: Dict[str, float] = {}
    for k, v in shape_feats.items():
        flat[f"shape_{k}"] = v
    for k, v in first_order_feats.items():
        flat[f"firstorder_{k}"] = v
    for k, v in glcm_feats.items():
        flat[f"glcm_{k}"] = v
    for k, v in glrlm_feats.items():
        flat[f"glrlm_{k}"] = v

    # Build rich Markdown report
    markdown_report = (
        "### 3D 影像组学定量特征\n\n"
        "> 特征定义参照 IBSI 命名，未经 IBSI 参考数据集一致性验证；表面积为体素面法。\n\n"
        f"**体素空间分布**: `{volume.shape[0]} 层 × {volume.shape[1]} × {volume.shape[2]}` | "
        f"**分辨率**: `{spacing[0]} × {spacing[1]} × {spacing[2]} mm` | "
        f"**病灶体素计数**: `{shape_feats['voxel_count']}`\n\n"
        "#### 1. 3D 几何形态学参数 (Morphology & Shape)\n"
        "| 参数指标 | 测量值 | 单位/范围 | 定义 |\n"
        "| :--- | :--- | :--- | :--- |\n"
        f"| **病灶体积 (Volume)** | **`{shape_feats['volume_cm3']} cm³`** ({shape_feats['volume_mm3']} mm³) | cm³ | 靶病灶三维空间总体积 |\n"
        f"| **表面积 (Surface Area)** | `{shape_feats['surface_area_mm2']} mm²` | mm² | 体素面法：暴露体素面面积之和（非网格表面） |\n"
        f"| **面容比 (Surface-to-Volume)** | `{shape_feats['surface_to_volume_ratio']}` | mm⁻¹ | 表面积 / 体积 |\n"
        f"| **球形度 (Sphericity)** | **`{shape_feats['sphericity']}`** | 理想球为 1 | π^(1/3)·(6V)^(2/3) / A；体素面法表面积偏大，数值偏低 |\n"
        f"| **紧凑度 (Compactness 1/2)** | `{shape_feats['compactness_1']}` / `{shape_feats['compactness_2']}` | 相对指数 | 体素聚集度与离散度指标 |\n"
        f"| **最大三维空间径 (Feret Max)** | **`{shape_feats['max_3d_diameter_mm']} mm`** | mm | 表面体素中心两两最大距离（凸包顶点精确计算） |\n"
        f"| **主惯性轴三维长径 (Major/Minor/Least)** | `{shape_feats['major_axis_length_mm']} / {shape_feats['minor_axis_length_mm']} / {shape_feats['least_axis_length_mm']}` | mm | 等效三维椭球体三轴长度 |\n"
        f"| **伸长率 / 扁平度 (Elongation / Flatness)** | `{shape_feats['elongation']} / {shape_feats['flatness']}` | 0~1.0 | 协方差特征值之比的平方根 |\n\n"
        "#### 2. 一阶直方图与灰度分布统计 (First-order Histogram)\n"
        "| 参数指标 | 测量值 | 定义 |\n"
        "| :--- | :--- | :--- |\n"
        f"| **平均密度 (Mean HU)** | `{first_order_feats['mean']} ± {first_order_feats['std']} HU` | ROI 内灰度均值与标准差 |\n"
        f"| **中位数 / 四分位距 (Median / IQR)** | `{first_order_feats['median']} HU` (IQR: `{first_order_feats['iqr']}`) | 抗偏态中位水平与核心 50% 离散跨度 |\n"
        f"| **极值跨度 (Min ~ Max [Range])** | `[{first_order_feats['min']}, {first_order_feats['max']}]` (跨度: `{first_order_feats['range']} HU`) | 最低与最高密度边界 |\n"
        f"| **第 10 / 90 百分位数 (P10 / P90)** | `P10: {first_order_feats['p10']} HU` / `P90: {first_order_feats['p90']} HU` | 消除单点噪点的有效密度区间 |\n"
        f"| **偏度 (Skewness)** | `{first_order_feats['skewness']}` | 灰度分布三阶标准矩，0 为对称 |\n"
        f"| **峰度 (Kurtosis)** | `{first_order_feats['kurtosis']}` | 正态分布基准为 3.0，>3 呈尖峰厚尾分布 |\n"
        f"| **信息熵 / 均匀度 (Entropy / Uniformity)** | `{first_order_feats['entropy']} bit` / `{first_order_feats['uniformity']}` | 直方图熵与各灰度级概率平方和 |\n\n"
        "#### 3. 灰度共生矩阵微观纹理 (GLCM Texture)\n"
        "| 参数指标 | 测量值 | 定义 |\n"
        "| :--- | :--- | :--- |\n"
        f"| **对比度 (Contrast)** | `{glcm_feats['contrast']}` | Σ(i−j)²·P(i,j) |\n"
        f"| **同质性 (Homogeneity / IDM)** | **`{glcm_feats['homogeneity']}`** | Σ P(i,j)/(1+(i−j)²) |\n"
        f"| **能量 / 二阶角动量 (Energy ASM)** | `{glcm_feats['energy_asm']}` | Σ P(i,j)² |\n"
        f"| **联合熵 (Joint Entropy)** | `{glcm_feats['joint_entropy']}` | 共生矩阵概率分布的熵 |\n"
        f"| **空间相关性 (Correlation)** | `{glcm_feats['correlation']}` | 灰度沿空间方向的线性依赖性 |\n\n"
        "#### 4. 灰度游程矩阵宏观异质性 (GLRLM Texture)\n"
        "| 参数指标 | 测量值 | 定义 |\n"
        "| :--- | :--- | :--- |\n"
        f"| **短游程优势度 (Short Run Emphasis, SRE)** | `{glrlm_feats['short_run_emphasis']}` | Σ R(i,j)/j² / 游程总数 |\n"
        f"| **长游程优势度 (Long Run Emphasis, LRE)** | `{glrlm_feats['long_run_emphasis']}` | Σ R(i,j)·j² / 游程总数 |\n"
        f"| **灰度不均一性 (GLN)** | `{glrlm_feats['gray_level_nonuniformity']}` | 各灰度级游程分布离散度 |\n"
        f"| **游程长度不均一性 (RLN)** | `{glrlm_feats['run_length_nonuniformity']}` | 长度空间分布多样性 |\n"
        f"| **游程百分比 (Run Percentage, RP)** | `{glrlm_feats['run_percentage']}` | 游程总数 / (3 × ROI 体素数)，3 个扫描方向 |\n"
    )

    return {
        "status": "success",
        "lesion_voxel_count": shape_feats["voxel_count"],
        "feature_count": len(flat),
        "voxel_spacing_mm": list(spacing),
        "feature_groups": {
            "shape_3d": shape_feats,
            "first_order": first_order_feats,
            "glcm": glcm_feats,
            "glrlm": glrlm_feats,
        },
        "features_flat": flat,
        "markdown_report": markdown_report,
    }
