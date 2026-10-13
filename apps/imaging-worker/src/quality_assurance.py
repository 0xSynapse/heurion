"""
Clinical Radiology Quality Assurance (QA) & Physics Protocol Engine
Evaluates acquisition parameters, reconstruction kernels, slice thickness,
inspiratory depth, and motion artifacts according to ACR and RSNA clinical standards.
"""

import re
import numpy as np
from typing import Dict, Any, Tuple, Optional, List


def _primary_kernel_name(kernel: Any) -> str:
    """
    取卷积核的主名称。Siemens 常把卷积核存成多值字段（如 ['Br64d', '3']，第二项为迭代重建强度），
    读出来可能是序列，也可能是被 str() 过的 "['Br64d', '3']"。
    """
    if kernel is None:
        return ""
    if isinstance(kernel, (list, tuple)) or (hasattr(kernel, "__iter__") and not isinstance(kernel, (str, bytes))):
        items = [str(x).strip() for x in kernel if str(x).strip()]
        return items[0] if items else ""
    text = str(kernel).strip()
    m = re.match(r"^\[\s*'([^']*)'", text)
    if m:
        return m.group(1).strip()
    return text.split("\\")[0].strip()


def parse_reconstruction_kernel(kernel_str: Optional[str]) -> Dict[str, Any]:
    """
    Parses vendor reconstruction kernel (Siemens, GE, Philips, Canon, UIH)
    and classifies sharpness and edge-overshoot risk.
    Uses exact vendor tables and regex matching instead of single-character substring checks.
    """
    kernel_str = _primary_kernel_name(kernel_str)
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


def segment_lungs(volume_zyx: np.ndarray, voxel_vol_cm3: float) -> Optional[np.ndarray]:
    """
    经典阈值法双肺分割：取 < -400 HU 的三维连通域，去掉碰到层面四边的连通域（体外空气、检查床下方空气），
    保留最大的一到两个（两肺可能经气管连成一个），逐层填洞把肺内血管纳入肺容积。
    分不出来（例如视野裁切到肺、肺与边界相连）时返回 None，不给估计值。
    """
    from scipy.ndimage import label, binary_fill_holes, sum as ndimage_sum

    air = volume_zyx < -400.0
    lbl, n = label(air)
    if n == 0:
        return None
    border = set(np.unique(np.concatenate([
        lbl[:, 0, :].ravel(), lbl[:, -1, :].ravel(), lbl[:, :, 0].ravel(), lbl[:, :, -1].ravel()
    ])).tolist())
    sizes = ndimage_sum(air, lbl, range(1, n + 1))
    candidates = sorted(
        ((float(sz), i + 1) for i, sz in enumerate(sizes) if (i + 1) not in border and sz * voxel_vol_cm3 > 50.0),
        reverse=True,
    )
    if not candidates:
        return None
    keep = [idx for sz, idx in candidates[:2] if sz >= 0.1 * candidates[0][0]]
    mask = np.isin(lbl, keep)
    for z in range(mask.shape[0]):
        mask[z] = binary_fill_holes(mask[z])
    return mask


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
        
    # 2. 吸气程度估计：先分割双肺，再按肺容积判断（不能直接数全视野的低密度体素，体外空气会被算进去）
    z_dim, y_dim, x_dim = volume_zyx.shape
    z_span_mm = float(z_dim * dz)
    voxel_vol_cm3 = (dz * dy * dx) / 1000.0
    lung_mask = segment_lungs(volume_zyx, voxel_vol_cm3)
    total_lung_vol_cm3: Optional[float] = None
    if lung_mask is not None:
        total_lung_vol_cm3 = round(float(np.sum(lung_mask) * voxel_vol_cm3), 1)

    insp_adequate: Optional[bool]
    if z_span_mm < 180.0:
        insp_status = f"局灶/靶区扫描 (纵向覆盖 {z_span_mm:.0f}mm, 全肺通气容积不适用)"
        insp_adequate = None
    elif total_lung_vol_cm3 is None:
        insp_status = "未能分割双肺（视野可能裁切到肺），吸气程度未评估"
        insp_adequate = None
        warnings.append("未能分割出完整双肺，吸气程度未评估。")
    elif total_lung_vol_cm3 >= 2800.0:
        insp_status = "充分深吸气相 (Adequate Inspiration)"
        insp_adequate = True
    elif total_lung_vol_cm3 >= 1800.0:
        insp_status = "中度吸气相 (Submaximal Inspiration)"
        insp_adequate = True
    else:
        insp_status = "吸气不足或严重肺容积降低 (Suboptimal Inspiration)"
        insp_adequate = False
        warnings.append("全肺容积偏低，下肺野可能出现坠积样密度增高，建议结合临床与前片鉴别。")

    # 3. 运动伪影指数：实验性指标，未经验证，仅作提示，不参与通过判定与可信度
    motion_index = 0.08
    if z_dim > 10:
        mid_z = z_dim // 2
        cardiac_slice = volume_zyx[mid_z]
        gy, gx = np.gradient(cardiac_slice)
        grad_mag = np.hypot(gy, gx)
        blur_ratio = float(np.sum((grad_mag > 10.0) & (grad_mag < 40.0)) / max(np.sum(grad_mag >= 40.0), 1.0))
        motion_index = round(min(max(blur_ratio * 0.1, 0.02), 0.85), 3)

    motion_level = ("无明显搏动伪影" if motion_index < 0.25 else ("轻度心跳搏动重影" if motion_index < 0.50 else "明显呼吸/心跳运动伪影")) + "（实验性指标）"

    # 总体判定：层厚 + 吸气程度（未评估时不扣分）
    is_acceptable = (dz <= 3.0) and (insp_adequate is not False)
    confidence_score = round(max(min(1.0 - (dz - 1.0) * 0.1 - (0.2 if insp_adequate is False else 0.0), 1.0), 0.5), 2)

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
