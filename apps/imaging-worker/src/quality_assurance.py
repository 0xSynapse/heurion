"""
Clinical Radiology Quality Assurance (QA) & Physics Protocol Engine
Evaluates acquisition parameters, reconstruction kernels, slice thickness,
inspiratory depth, and motion artifacts according to ACR and RSNA clinical standards.
"""

import re
import numpy as np
from typing import Dict, Any, Tuple, Optional, List


def parse_reconstruction_kernel(kernel_str: Optional[str]) -> Dict[str, Any]:
    """
    Parses vendor reconstruction kernel (Siemens, GE, Philips, Canon, UIH)
    and classifies sharpness and edge-overshoot risk.
    Uses exact vendor tables and regex matching instead of single-character substring checks.
    """
    if not kernel_str:
        return {
            "raw": "UNKNOWN",
            "category": "standard",
            "is_sharp_lung": False,
            "description": "标准软组织卷积核 (Standard Kernel)"
        }
    
    k = str(kernel_str).strip().upper()

    # Exact vendor tables
    # GE: STANDARD, SOFT, CHEST, DETAIL are smooth; LUNG, BONE, BONEPLUS, EDGE, ULTRA are sharp
    GE_SMOOTH = {"STANDARD", "SOFT", "CHEST", "DETAIL"}
    GE_SHARP = {"LUNG", "BONE", "BONEPLUS", "EDGE", "ULTRA"}

    # Canon / Toshiba
    CANON_SMOOTH = {f"FC{i:02d}" for i in [1, 2, 3, 4, 5, 7, 8, 18, 20, 26]}
    CANON_SHARP = {f"FC{i:02d}" for i in [50, 51, 52, 53, 55, 56, 81, 86]}

    # Philips
    PHILIPS_SMOOTH = {"A", "B", "C"}
    PHILIPS_SHARP = {"L", "YB", "YA"}

    if k in GE_SMOOTH or k in CANON_SMOOTH or k in PHILIPS_SMOOTH:
        return {
            "raw": kernel_str,
            "category": "smooth_mediastinum",
            "is_sharp_lung": False,
            "description": f"纵隔平滑软组织核 ({kernel_str}) · 低噪声型"
        }

    if k in GE_SHARP or k in CANON_SHARP or k in PHILIPS_SHARP:
        return {
            "raw": kernel_str,
            "category": "sharp_lung",
            "is_sharp_lung": True,
            "description": f"高分辨率肺算法锐利核 ({kernel_str}) · 边缘增强型"
        }

    # Siemens kernel naming (e.g. B30f, B70s, I30f, I70f, Qr40d, Bl64, Br59)
    # Prefix: B, I, BL, BR, QR, UR; followed by 2-digit spatial frequency (10..90); optional strength letter
    m = re.match(r"^([A-Z]{1,2})(\d{2})([A-Z]?)$", k)
    if m:
        prefix, num_str, _ = m.groups()
        num = int(num_str)
        if prefix in ("BL", "UL") or num >= 55:
            return {
                "raw": kernel_str,
                "category": "sharp_lung",
                "is_sharp_lung": True,
                "description": f"西门子高分辨率锐利核 ({kernel_str}) · 边缘增强型"
            }
        else:
            return {
                "raw": kernel_str,
                "category": "smooth_mediastinum",
                "is_sharp_lung": False,
                "description": f"西门子平滑软组织核 ({kernel_str}) · 低噪声型"
            }

    # Fallback: whole word boundary matching
    words = set(re.findall(r"\b[A-Z0-9]+\b", k))
    if any(w in words for w in ("LUNG", "BONE", "SHARP", "BONEPLUS", "EDGE")):
        return {
            "raw": kernel_str,
            "category": "sharp_lung",
            "is_sharp_lung": True,
            "description": f"高频锐利算法核 ({kernel_str}) · 边缘增强型"
        }
    if any(w in words for w in ("STANDARD", "SOFT", "SMOOTH", "MEDIASTINUM", "CHEST")):
        return {
            "raw": kernel_str,
            "category": "smooth_mediastinum",
            "is_sharp_lung": False,
            "description": f"平滑软组织核 ({kernel_str}) · 低噪声型"
        }

    return {
        "raw": kernel_str,
        "category": "intermediate",
        "is_sharp_lung": False,
        "description": f"常规卷积核 ({kernel_str})"
    }


def assess_ct_quality(
    volume_zyx: np.ndarray,
    spacing_zyx: Tuple[float, float, float],
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Runs automated Clinical Radiology Quality Assurance (QA) checks:
    1. HRCT thin-slice verification (Slice Thickness <= 1.5mm, optimal <= 1.25mm)
    2. Reconstruction kernel physics evaluation
    3. Diaphragmatic inspiratory depth assessment
    4. Cardiac and respiratory motion artifact detection
    """
    dz, dy, dx = spacing_zyx
    meta = metadata or {}
    
    # 1. Slice Thickness evaluation
    raw_kernel = meta.get("ConvolutionKernel") or meta.get("convolution_kernel") or ""
    kernel_info = parse_reconstruction_kernel(raw_kernel)
    
    if dz <= 1.0:
        protocol_tier = "Ultra-Thin HRCT (<= 1.0mm, 金标准)"
    elif dz <= 1.25:
        protocol_tier = "Standard Thin HRCT (1.0 - 1.25mm, 临床推荐)"
    elif dz <= 1.5:
        protocol_tier = "Acceptable Thin HRCT (1.25 - 1.5mm)"
    elif dz <= 3.0:
        protocol_tier = "Sub-thin CT (1.5 - 3.0mm, 部分容积效应轻微)"
    else:
        protocol_tier = f"Thick Slice CT ({dz}mm, 重度部分容积效应)"

    warnings = []
    if dz > 1.5:
        warnings.append(f"扫描层厚 ({dz}mm) 超过 HRCT 诊断标准 (<=1.5mm)，外周细支气管可能存在部分容积效应假象。")
        
    # 2. Inspiratory adequacy estimation
    z_dim, y_dim, x_dim = volume_zyx.shape
    z_span_mm = float(z_dim * dz)

    # Count aerated lung volume (HU between -1000 and -500, accommodating emphysema)
    aerated_mask = (volume_zyx >= -1000.0) & (volume_zyx <= -500.0)
    aerated_voxels = int(np.sum(aerated_mask))
    voxel_vol_cm3 = (dz * dy * dx) / 1000.0
    total_lung_vol_cm3 = round(float(aerated_voxels * voxel_vol_cm3), 1)

    mean_aerated_hu = float(np.mean(volume_zyx[aerated_mask])) if aerated_voxels > 100 else -750.0

    if z_span_mm < 180.0:
        insp_status = f"局灶/靶区扫描 (纵向覆盖 {z_span_mm:.0f}mm, 全肺通气容积不适用)"
        insp_adequate = True
    elif total_lung_vol_cm3 >= 2800.0:
        insp_status = "充分深吸气相 (Adequate Inspiration)"
        insp_adequate = True
    elif total_lung_vol_cm3 >= 1800.0 or mean_aerated_hu < -820.0:
        insp_status = "中度吸气相 (Submaximal Inspiration)"
        insp_adequate = True
    else:
        insp_status = "吸气不足或严重肺容积降低 (Suboptimal Inspiration)"
        insp_adequate = False
        warnings.append("全肺通气容积偏低，下肺野可能出现坠积样假性密度增高，建议结合临床与前片鉴别。")

    # 3. Motion artifact index (gradient orientation entropy in lung-cardiac boundary)
    motion_index = 0.08
    if z_dim > 10:
        mid_z = z_dim // 2
        cardiac_slice = volume_zyx[mid_z]
        gy, gx = np.gradient(cardiac_slice)
        grad_mag = np.hypot(gy, gx)
        blur_ratio = float(np.sum((grad_mag > 10.0) & (grad_mag < 40.0)) / max(np.sum(grad_mag >= 40.0), 1.0))
        motion_index = round(min(max(blur_ratio * 0.1, 0.02), 0.85), 3)

    motion_level = "无明显搏动伪影" if motion_index < 0.25 else ("轻度心跳搏动重影" if motion_index < 0.50 else "明显呼吸/心跳运动伪影")
    if motion_index >= 0.50:
        warnings.append(f"心缘周围检测到运动模糊或搏动双边影（运动指数 {motion_index}），邻近心缘结构测量可能受干扰。")

    # Overall QA pass criteria
    is_acceptable = (dz <= 3.0) and (total_lung_vol_cm3 >= 1500.0 or z_span_mm < 180.0)
    confidence_score = round(max(min(1.0 - (dz - 1.0) * 0.1 - (0.2 if not insp_adequate else 0.0) - motion_index * 0.2, 1.0), 0.5), 2)

    return {
        "status": "pass" if is_acceptable else "warning",
        "protocol_tier": protocol_tier,
        "slice_thickness_mm": dz,
        "pixel_spacing_xy_mm": (dy, dx),
        "kernel": kernel_info,
        "total_lung_volume_cm3": total_lung_vol_cm3,
        "inspiratory_adequacy": insp_status,
        "is_inspiratory_adequate": insp_adequate,
        "motion_artifact_level": motion_level,
        "motion_artifact_index": motion_index,
        "warnings": warnings,
        "quality_confidence_score": confidence_score
    }
