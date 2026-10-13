import io
import os
import time
import numpy as np
import torch
from typing import Dict, Any, Tuple, Optional, List
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import (
    map_coordinates,
    gaussian_filter,
    binary_dilation,
    generate_binary_structure,
    iterate_structure,
    label,
    distance_transform_edt
)

try:
    from .device import get_optimal_device, get_device_info
    from .dicom_io import apply_ct_window
    from .renderer import png_to_base64
except (ImportError, ValueError):
    from device import get_optimal_device, get_device_info
    from dicom_io import apply_ct_window
    from renderer import png_to_base64


def get_sans_font(size: int = 14, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Loads a clean Sans-Serif font for medical HUD and metric callouts."""
    font_paths = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
    ]
    for p in font_paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def apply_turbo_colormap(norm_vals: np.ndarray) -> np.ndarray:
    """
    Applies standard Turbo / Hot multi-spectral colormap (0.0 ~ 1.0 -> RGB uint8).
    Smoothly transitions: Blue -> Cyan -> Green -> Yellow -> Red -> Dark Red.
    """
    x = np.clip(norm_vals, 0.0, 1.0)
    # Polynomial approximation for high-visibility clinical Turbo colormap
    r = 34.61 + x * (1172.42 + x * (-1079.02 + x * (33.60 + x * (375.40 - x * 670.45))))
    g = -0.54 + x * (991.31 + x * (-998.05 + x * (581.45 + x * (-170.51 + x * -35.61))))
    b = 100.46 + x * (203.73 + x * (-2174.65 + x * (3932.12 + x * (-2600.93 + x * 595.66))))
    
    r = np.clip(r, 0, 255).astype(np.uint8)
    g = np.clip(g, 0, 255).astype(np.uint8)
    b = np.clip(b, 0, 255).astype(np.uint8)
    
    return np.stack([r, g, b], axis=-1)


def compute_normalized_cross_correlation(vol1: np.ndarray, vol2: np.ndarray) -> float:
    """Computes Normalized Cross Correlation (NCC, -1.0 to 1.0) between two 3D volumes."""
    v1 = vol1.astype(np.float64)
    v2 = vol2.astype(np.float64)
    v1_mean = np.mean(v1)
    v2_mean = np.mean(v2)
    v1_centered = v1 - v1_mean
    v2_centered = v2 - v2_mean
    num = np.sum(v1_centered * v2_centered)
    den = np.sqrt(np.sum(v1_centered**2) * np.sum(v2_centered**2))
    return float(num / den) if den > 1e-8 else 0.0


def run_3d_deformable_registration(
    fixed_vol: np.ndarray,
    moving_vol: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    iterations: int = 12,
    smoothing_sigma: float = 1.0
) -> Dict[str, Any]:
    """
    简化 Demons 稠密位移场 (DDF) 形变配准（单分辨率，非 B 样条）：
    每次迭代以固定图像梯度计算光流力 (diff·∇F / |∇F|²)，高斯平滑后累加到位移场，
    再对位移场做一次高斯平滑作为正则，按体素坐标重采样移动图像。
    位移在体素坐标中求解，未按各轴物理间距加权；输出的 mm 位移量按 spacing 换算。
    """
    t0 = time.time()
    z_dim, y_dim, x_dim = fixed_vol.shape

    # Initial similarity
    initial_ncc = compute_normalized_cross_correlation(fixed_vol, moving_vol)
    initial_mse = float(np.mean((fixed_vol - moving_vol)**2))

    # Dense Displacement Field (DDF) initialized to zero
    u_z = np.zeros(fixed_vol.shape, dtype=np.float32)
    u_y = np.zeros(fixed_vol.shape, dtype=np.float32)
    u_x = np.zeros(fixed_vol.shape, dtype=np.float32)

    # Coordinate grids
    gz, gy, gx = np.meshgrid(
        np.arange(z_dim), np.arange(y_dim), np.arange(x_dim), indexing="ij"
    )

    current_warped = moving_vol.copy()

    # 单分辨率迭代（无图像金字塔）
    for it in range(iterations):
        diff = fixed_vol - current_warped
        # Spatial gradients of fixed image
        grad_z, grad_y, grad_x = np.gradient(fixed_vol)
        grad_norm = grad_z**2 + grad_y**2 + grad_x**2 + 1e-4

        # Optical flow / Demons force update
        force_z = (diff * grad_z) / grad_norm
        force_y = (diff * grad_y) / grad_norm
        force_x = (diff * grad_x) / grad_norm

        # Fluid-like Gaussian smoothing
        u_z += gaussian_filter(force_z, sigma=smoothing_sigma) * 0.4
        u_y += gaussian_filter(force_y, sigma=smoothing_sigma) * 0.4
        u_x += gaussian_filter(force_x, sigma=smoothing_sigma) * 0.4

        # Elastic regularization
        u_z = gaussian_filter(u_z, sigma=smoothing_sigma)
        u_y = gaussian_filter(u_y, sigma=smoothing_sigma)
        u_x = gaussian_filter(u_x, sigma=smoothing_sigma)

        # Warp coordinates
        coords = np.array([gz + u_z, gy + u_y, gx + u_x])
        current_warped = map_coordinates(moving_vol, coords, order=1, mode="nearest")

    final_ncc = compute_normalized_cross_correlation(fixed_vol, current_warped)
    final_mse = float(np.mean((fixed_vol - current_warped)**2))

    # Magnitude of physical deformation in mm
    disp_magnitude_voxels = np.sqrt(u_z**2 + u_y**2 + u_x**2)
    disp_magnitude_mm = np.sqrt((u_z * spacing[0])**2 + (u_y * spacing[1])**2 + (u_x * spacing[2])**2)
    max_displacement_mm = float(np.max(disp_magnitude_mm))
    mean_displacement_mm = float(np.mean(disp_magnitude_mm))

    # Render key slice with displacement vector field heatmap overlay
    key_slice_idx = z_dim // 2
    warped_slice = current_warped[key_slice_idx]
    disp_slice = disp_magnitude_mm[key_slice_idx]

    ct_windowed = apply_ct_window(warped_slice, window_name="abdomen" if np.min(warped_slice) > -500 else "lung")
    base_img = Image.fromarray(ct_windowed).convert("RGBA")

    norm_disp = np.clip(disp_slice / max(max_displacement_mm, 1.0), 0.0, 1.0)
    disp_rgb = apply_turbo_colormap(norm_disp)
    h, w = warped_slice.shape
    disp_alpha = (norm_disp * 180.0).astype(np.uint8)
    disp_rgba = np.dstack([disp_rgb, disp_alpha])
    disp_img = Image.fromarray(disp_rgba, mode="RGBA")

    fused_img = Image.alpha_composite(base_img, disp_img)
    draw = ImageDraw.Draw(fused_img)

    font_bold = get_sans_font(12, bold=True)
    font_reg = get_sans_font(11, bold=False)

    hud_bg = [(8, 8), (270, 96)]
    draw.rounded_rectangle(hud_bg, radius=4, fill=(15, 23, 42, 215), outline=(51, 65, 85, 255))
    draw.text((16, 12), "Simplified Demons DDF Registration", font=font_bold, fill=(241, 245, 249, 255))
    draw.text((16, 28), f"Key Slice: #{key_slice_idx}/{z_dim} | Spacing: {spacing[1]}mm", font=font_reg, fill=(148, 163, 184, 255))
    draw.text((16, 44), f"NCC: {round(initial_ncc, 3)} -> {round(final_ncc, 3)} (+{round(final_ncc - initial_ncc, 3)})", font=font_reg, fill=(52, 211, 153, 255))
    draw.text((16, 60), f"MSE Drop: {round(max(0.0, (initial_mse - final_mse) / max(initial_mse, 1e-4) * 100.0), 1)}%", font=font_reg, fill=(250, 204, 21, 255))
    draw.text((16, 76), f"Max Disp: {round(max_displacement_mm, 2)} mm (mean: {round(mean_displacement_mm, 2)} mm)", font=font_reg, fill=(56, 189, 248, 255))

    buf = io.BytesIO()
    fused_img.convert("RGB").save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    elapsed = round(time.time() - t0, 3)

    return {
        "status": "success",
        "method": "simplified_demons_ddf",
        "method_zh": "简化 Demons 稠密位移场（单分辨率，固定图像梯度光流力 + 高斯平滑正则）",
        "iterations_completed": iterations,
        "elapsed_sec": elapsed,
        "initial_ncc": round(initial_ncc, 4),
        "final_ncc": round(final_ncc, 4),
        "ncc_improvement": round(final_ncc - initial_ncc, 4),
        "initial_mse": round(initial_mse, 2),
        "final_mse": round(final_mse, 2),
        "mse_reduction_percent": round(max(0.0, (initial_mse - final_mse) / max(initial_mse, 1e-4) * 100.0), 1),
        "max_displacement_mm": round(max_displacement_mm, 2),
        "mean_displacement_mm": round(mean_displacement_mm, 2),
        "key_slice_index": key_slice_idx,
        "registered_slice_png_base64": png_to_base64(png_bytes),
        "registered_slice_png_size_bytes": len(png_bytes),
        "warped_volume": current_warped,
        "displacement_field": {
            "u_z": u_z,
            "u_y": u_y,
            "u_x": u_x,
            "magnitude_map": disp_magnitude_mm,
        },
        "summary_markdown": (
            f"### 3D 形变配准（简化 Demons 稠密位移场）报告\n"
            f"- **初始归一化互相关 (NCC)**: `{round(initial_ncc, 4)}` → **配准后 NCC**: `{round(final_ncc, 4)}` (提升 `{round(final_ncc - initial_ncc, 4)}`)\n"
            f"- **均方误差 (MSE) 降幅**: `{round(max(0.0, (initial_mse - final_mse) / max(initial_mse, 1e-4) * 100.0), 1)}%` (耗时 `{elapsed}s`)\n"
            f"- **最大位移形变量**: `{round(max_displacement_mm, 2)} mm` (平均位移: `{round(mean_displacement_mm, 2)} mm`)\n"
        )
    }


def compute_pet_metrics_and_fusion(
    ct_volume: np.ndarray,
    pet_volume: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    suv_threshold: float = 2.5,
    key_slice_index: Optional[int] = None,
    alpha: float = 0.55,
    roi_mask: Optional[np.ndarray] = None,
    physiological_exclusion_note: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    在给定 ROI 内计算 SUV 指标并生成 PET-CT 融合关键层：
    - SUV_max / SUV_mean（ROI 内 >= suv_threshold 的体素）
    - MTV（cm³）与 TLG = MTV × SUV_mean

    全体积阈值会把脑、膀胱、肾、心肌等生理性摄取计入 MTV，因此调用方必须二选一：
    - roi_mask：只在该 ROI 内统计；
    - physiological_exclusion_note：不给 ROI 时，说明 pet_volume 已如何排除生理性摄取（原文写入结果）。
    两者都没有时报错。

    metadata（可选）：
    - "tracer" 或 "Radiopharmaceutical"：示踪剂名称，没有就不写；
    - "Units"：PET 体素单位。BQML 等非 SUV 单位直接报错；未提供时标注「未校验 SUV 换算」。
    """
    t0 = time.time()
    z_dim, y_dim, x_dim = ct_volume.shape
    voxel_vol_cm3 = (spacing[0] * spacing[1] * spacing[2]) / 1000.0
    meta = metadata or {}

    if roi_mask is not None:
        roi = np.asarray(roi_mask).astype(bool)
        if roi.shape != pet_volume.shape:
            raise ValueError(f"roi_mask 形状 {roi.shape} 与 PET 体积 {pet_volume.shape} 不一致")
        if not np.any(roi):
            raise ValueError("roi_mask 为空，无法计算 SUV 指标")
        roi_desc = "调用方提供的 ROI"
    elif physiological_exclusion_note and str(physiological_exclusion_note).strip():
        roi = np.ones(pet_volume.shape, dtype=bool)
        roi_desc = f"全体积（调用方说明：{str(physiological_exclusion_note).strip()}）"
    else:
        raise ValueError(
            "未提供 roi_mask 或生理性摄取排除说明：全体积阈值会把脑、膀胱等生理性摄取计入 MTV，拒绝计算"
        )

    tracer = meta.get("tracer") or meta.get("Radiopharmaceutical")
    units = meta.get("Units")
    units_norm = str(units).strip().upper().replace("/", "") if units else None
    if units_norm in ("BQML", "BQ", "CNTS", "COUNTS"):
        raise ValueError(f"PET 体素单位为 {units}，不是 SUV；需先按注射剂量、衰变与体重换算为 SUV")
    if units_norm in ("GML", "SUV", "SUVBW"):
        suv_note = f"PET 单位标记为 {units}，按 SUV 使用；换算过程未在本模块复核"
        suv_units_verified = True
    else:
        suv_note = "未校验 PET 体素值是否为 SUV（缺少单位/剂量/衰变/体重信息），按输入值直接计算"
        suv_units_verified = False

    # ROI 内阈值分割的代谢体积
    pet_in_roi = np.where(roi, pet_volume, -np.inf)
    metabolic_mask = roi & (pet_volume >= suv_threshold)
    suv_max = round(float(np.max(pet_volume[roi])), 2)

    if np.any(metabolic_mask):
        suv_mean = round(float(np.mean(pet_volume[metabolic_mask])), 2)
        mtv_cm3 = round(float(np.sum(metabolic_mask)) * voxel_vol_cm3, 2)
        tlg = round(mtv_cm3 * suv_mean, 2)
    else:
        # ROI 内没有达到阈值的体素：不输出均值与体积
        suv_mean = None
        mtv_cm3 = 0.0
        tlg = None
    # 关键层：ROI 内 SUV 峰值所在层
    peak_z = int(np.unravel_index(int(np.argmax(pet_in_roi)), pet_volume.shape)[0])

    chosen_slice_idx = key_slice_index if key_slice_index is not None and 0 <= key_slice_index < z_dim else peak_z

    # Render PET-CT color fusion image
    ct_slice = ct_volume[chosen_slice_idx]
    pet_slice = pet_volume[chosen_slice_idx]
    mask_slice = metabolic_mask[chosen_slice_idx]

    # 1. CT Grayscale Background (mediastinal window: -125 to 225 HU)
    ct_windowed = apply_ct_window(ct_slice, window_name="mediastinum")
    base_img = Image.fromarray(ct_windowed).convert("RGBA")

    # 2. Colorized PET Foreground
    h, w = ct_slice.shape
    # Normalize PET SUV for display (0.0 to max(suv_max, 5.0))
    norm_pet = np.clip(pet_slice / max(suv_max, 5.0), 0.0, 1.0)
    pet_rgb = apply_turbo_colormap(norm_pet)

    # Alpha mask: low SUV has 0 alpha, above threshold alpha scales smoothly
    pet_alpha = np.zeros((h, w), dtype=np.uint8)
    active_pet = pet_slice >= 1.0
    pet_alpha[active_pet] = np.clip((norm_pet[active_pet] * 255.0 * alpha + 40.0), 0, 255).astype(np.uint8)

    pet_rgba = np.dstack([pet_rgb, pet_alpha])
    pet_img = Image.fromarray(pet_rgba, mode="RGBA")

    fused_img = Image.alpha_composite(base_img, pet_img)
    draw = ImageDraw.Draw(fused_img)

    font_bold = get_sans_font(12, bold=True)
    font_reg = get_sans_font(11, bold=False)

    # 3. Clinical HUD Box
    hud_bg = [(8, 8), (260, 96)]
    draw.rounded_rectangle(hud_bg, radius=4, fill=(15, 23, 42, 215), outline=(51, 65, 85, 255))
    draw.text((16, 12), f"PET-CT Fusion{f' ({tracer})' if tracer else ''}", font=font_bold, fill=(241, 245, 249, 255))
    draw.text((16, 28), f"Key Slice: #{chosen_slice_idx}/{z_dim} | Spacing: {spacing[1]}mm", font=font_reg, fill=(148, 163, 184, 255))
    draw.text((16, 44), f"SUV_max: {suv_max} | SUV_mean: {suv_mean if suv_mean is not None else '--'}", font=font_reg, fill=(251, 146, 60, 255))
    draw.text((16, 60), f"MTV (Metabolic Vol): {mtv_cm3} cm³", font=font_reg, fill=(250, 204, 21, 255))
    draw.text((16, 76), f"TLG: {tlg if tlg is not None else '--'}", font=font_reg, fill=(52, 211, 153, 255))

    # 4. SUV Heatmap Colorbar (Right side)
    cb_x = w - 24
    cb_y_start = 16
    cb_height = 80
    for i in range(cb_height):
        frac = 1.0 - (i / cb_height)
        col = apply_turbo_colormap(np.array([frac]))[0]
        draw.line([(cb_x, cb_y_start + i), (cb_x + 12, cb_y_start + i)], fill=tuple(col), width=1)
    draw.rectangle([(cb_x, cb_y_start), (cb_x + 12, cb_y_start + cb_height)], outline=(255, 255, 255, 200))
    draw.text((cb_x - 36, cb_y_start - 2), f"{suv_max}", font=font_reg, fill=(255, 255, 255, 255))
    draw.text((cb_x - 24, cb_y_start + cb_height - 10), "0.0", font=font_reg, fill=(255, 255, 255, 255))

    buf = io.BytesIO()
    fused_img.convert("RGB").save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    elapsed = round(time.time() - t0, 3)

    return {
        "status": "success",
        "elapsed_sec": elapsed,
        "key_slice_index": chosen_slice_idx,
        "suv_max": suv_max,
        "suv_mean": suv_mean,
        "suv_threshold": suv_threshold,
        "mtv_cm3": mtv_cm3,
        "tlg": tlg,
        "tlg_g": tlg,
        "tracer": tracer,
        "roi": roi_desc,
        "suv_units_verified": suv_units_verified,
        "suv_note": suv_note,
        "fusion_png_base64": png_to_base64(png_bytes),
        "fusion_png_size_bytes": len(png_bytes),
        "summary_markdown": (
            f"**PET-CT 融合定量{f'（{tracer}）' if tracer else ''}**\n"
            f"- **统计范围**: {roi_desc}\n"
            f"- **SUV_max**: `{suv_max}`（阈值 `{suv_threshold}`）\n"
            f"- **SUV_mean（≥阈值体素）**: `{suv_mean if suv_mean is not None else '无达到阈值的体素'}`\n"
            f"- **MTV**: `{mtv_cm3} cm³`\n"
            f"- **TLG**: `{tlg if tlg is not None else '--'}`\n"
            f"- **SUV 峰值所在层**: 第 `#{chosen_slice_idx}` 层\n"
            f"- **单位说明**: {suv_note}\n"
        )
    }


def delineate_radiotherapy_targets(
    ct_volume: np.ndarray,
    metabolic_or_lesion_mask: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    ctv_margin_mm: float = 6.0,
    ptv_margin_mm: float = 4.0,
    key_slice_index: Optional[int] = None
) -> Dict[str, Any]:
    """
    由 GTV 掩膜按物理间距各向异性外扩得到 CTV / PTV（几何外扩，未做剂量学或规范符合性验证）：
    - GTV：调用方提供的掩膜，为空时报错；
    - CTV：GTV 的欧氏距离（按各轴 spacing 计算）<= ctv_margin_mm 的区域，
      去除 > 250 HU 的骨性体素与体外空气（与图像边界相连的 < -500 HU 连通域），再并回 GTV；
      肺组织不被裁剪；裁剪只是逐体素掩膜，不是沿解剖屏障的测地距离外扩；
    - PTV：CTV 的欧氏距离 <= ptv_margin_mm 的区域，去除体外空气，再并回 CTV。
    """
    t0 = time.time()
    z_dim, y_dim, x_dim = ct_volume.shape
    voxel_vol_cm3 = (spacing[0] * spacing[1] * spacing[2]) / 1000.0
    sampling = tuple(float(v) for v in spacing)

    gtv_mask = np.asarray(metabolic_or_lesion_mask).astype(bool)
    if gtv_mask.shape != ct_volume.shape:
        raise ValueError(f"GTV 掩膜形状 {gtv_mask.shape} 与 CT 体积 {ct_volume.shape} 不一致")
    if not np.any(gtv_mask):
        raise ValueError("GTV 掩膜为空，无法外扩靶区")

    # 1. GTV Volume in cm³
    gtv_voxels = int(np.sum(gtv_mask))
    gtv_vol_cm3 = round(gtv_voxels * voxel_vol_cm3, 2)

    # 体外空气：与层面边界相连的 < -500 HU 连通域（肺不与边界相连，不会被当作体外空气）
    low = ct_volume < -500.0
    lbl, n_lbl = label(low)
    border_ids = np.unique(np.concatenate([
        lbl[:, 0, :].ravel(), lbl[:, -1, :].ravel(), lbl[:, :, 0].ravel(), lbl[:, :, -1].ravel()
    ]))
    border_ids = border_ids[border_ids > 0]
    external_air = np.isin(lbl, border_ids) if border_ids.size else np.zeros_like(low)
    bone_barrier = ct_volume > 250.0

    # 2. CTV：按物理距离各向异性外扩
    dist_from_gtv = distance_transform_edt(~gtv_mask, sampling=sampling)
    ctv_raw = dist_from_gtv <= ctv_margin_mm
    ctv_mask = (ctv_raw & ~bone_barrier & ~external_air) | gtv_mask
    bone_voxels_removed = int(np.sum(ctv_raw & bone_barrier & ~gtv_mask))
    air_voxels_removed = int(np.sum(ctv_raw & external_air & ~gtv_mask))
    ctv_voxels = int(np.sum(ctv_mask))
    ctv_vol_cm3 = round(ctv_voxels * voxel_vol_cm3, 2)

    # 3. PTV：CTV 再按物理距离外扩
    dist_from_ctv = distance_transform_edt(~ctv_mask, sampling=sampling)
    ptv_mask = ((dist_from_ctv <= ptv_margin_mm) & ~external_air) | ctv_mask
    ptv_voxels = int(np.sum(ptv_mask))
    ptv_vol_cm3 = round(ptv_voxels * voxel_vol_cm3, 2)

    # Key slice selection
    if key_slice_index is None or not (0 <= key_slice_index < z_dim):
        z_counts = [int(np.sum(gtv_mask[z])) for z in range(z_dim)]
        key_slice_index = int(np.argmax(z_counts)) if np.max(z_counts) > 0 else z_dim // 2

    # 4. Render DICOM RT-STRUCT Contour Visualization
    ct_slice = ct_volume[key_slice_index]
    gtv_sl = gtv_mask[key_slice_index]
    ctv_sl = ctv_mask[key_slice_index]
    ptv_sl = ptv_mask[key_slice_index]

    ct_windowed = apply_ct_window(ct_slice, window_name="lung" if np.min(ct_slice) < -500 else "abdomen")
    base_img = Image.fromarray(ct_windowed).convert("RGBA")

    h, w = ct_slice.shape
    overlay = np.zeros((h, w, 4), dtype=np.uint8)

    # PTV: Translucent Cyan/Blue (56, 189, 248, 80)
    overlay[ptv_sl] = [56, 189, 248, 80]
    # CTV: Translucent Emerald (52, 211, 153, 110)
    overlay[ctv_sl] = [52, 211, 153, 110]
    # GTV: High-visibility Red (239, 68, 68, 160)
    overlay[gtv_sl] = [239, 68, 68, 160]

    overlay_img = Image.fromarray(overlay, mode="RGBA")
    fused_img = Image.alpha_composite(base_img, overlay_img)
    draw = ImageDraw.Draw(fused_img)

    font_bold = get_sans_font(12, bold=True)
    font_reg = get_sans_font(11, bold=False)

    # HUD Box
    hud_bg = [(8, 8), (280, 100)]
    draw.rounded_rectangle(hud_bg, radius=4, fill=(15, 23, 42, 215), outline=(51, 65, 85, 255))
    draw.text((16, 12), "Geometric Target Expansion", font=font_bold, fill=(241, 245, 249, 255))
    draw.text((16, 28), f"Key Slice: #{key_slice_index}/{z_dim} | Margin: CTV +{ctv_margin_mm}mm, PTV +{ptv_margin_mm}mm", font=font_reg, fill=(148, 163, 184, 255))
    draw.text((16, 46), f"GTV (Gross Tumor): {gtv_vol_cm3} cm³", font=font_reg, fill=(248, 113, 113, 255))
    draw.text((16, 62), f"CTV (Clinical Target): {ctv_vol_cm3} cm³", font=font_reg, fill=(52, 211, 153, 255))
    draw.text((16, 78), f"PTV (Planning Target): {ptv_vol_cm3} cm³", font=font_reg, fill=(56, 189, 248, 255))

    # Legend
    legend_bg = [(w - 110, 8), (w - 8, 76)]
    draw.rounded_rectangle(legend_bg, radius=4, fill=(15, 23, 42, 215), outline=(51, 65, 85, 255))
    draw.rectangle([(w - 102, 16), (w - 92, 26)], fill=(239, 68, 68, 255))
    draw.text((w - 86, 14), "GTV (Tumor)", font=font_reg, fill=(226, 232, 240, 255))
    draw.rectangle([(w - 102, 34), (w - 92, 44)], fill=(52, 211, 153, 255))
    draw.text((w - 86, 32), "CTV (Margin)", font=font_reg, fill=(226, 232, 240, 255))
    draw.rectangle([(w - 102, 52), (w - 92, 62)], fill=(56, 189, 248, 255))
    draw.text((w - 86, 50), "PTV (Setup)", font=font_reg, fill=(226, 232, 240, 255))

    buf = io.BytesIO()
    fused_img.convert("RGB").save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    elapsed = round(time.time() - t0, 3)

    return {
        "status": "success",
        "elapsed_sec": elapsed,
        "key_slice_index": key_slice_index,
        "gtv_volume_cm3": gtv_vol_cm3,
        "ctv_volume_cm3": ctv_vol_cm3,
        "ptv_volume_cm3": ptv_vol_cm3,
        "ctv_margin_mm": ctv_margin_mm,
        "ptv_margin_mm": ptv_margin_mm,
        "ctv_bone_voxels_removed": bone_voxels_removed,
        "ctv_external_air_voxels_removed": air_voxels_removed,
        "expansion_method": "按各轴物理间距的欧氏距离变换外扩；CTV 逐体素去除 >250 HU 骨性体素与体外空气；未做剂量学或规范符合性验证",
        "rtstruct_png_base64": png_to_base64(png_bytes),
        "rtstruct_png_size_bytes": len(png_bytes),
        "dicom_rt_roi_metadata": {
            "GTV": {"roi_number": 1, "roi_name": "GTV_Primary", "volume_cm3": gtv_vol_cm3, "display_color": [239, 68, 68]},
            "CTV": {"roi_number": 2, "roi_name": "CTV_Clinical", "volume_cm3": ctv_vol_cm3, "display_color": [52, 211, 153]},
            "PTV": {"roi_number": 3, "roi_name": "PTV_Planning", "volume_cm3": ptv_vol_cm3, "display_color": [56, 189, 248]},
        },
        "summary_markdown": (
            f"### 靶区几何外扩结果\n"
            f"- **GTV（输入掩膜）**: `{gtv_vol_cm3} cm³`（第 `#{key_slice_index}` 层截面最大）\n"
            f"- **CTV**: `{ctv_vol_cm3} cm³`（物理距离外扩 `+{ctv_margin_mm}mm`，去除骨性体素 {bone_voxels_removed} 个、体外空气体素 {air_voxels_removed} 个）\n"
            f"- **PTV**: `{ptv_vol_cm3} cm³`（CTV 再外扩 `+{ptv_margin_mm}mm`）\n"
            f"- **说明**: 纯几何外扩，未做剂量学或规范符合性验证。\n"
        )
    }
