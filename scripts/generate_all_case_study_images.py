#!/usr/bin/env python3
"""
官网影像演示图生成脚本（公开数据集 + 仓库内真实算法输出）

原则：
1. 图上的每一个轮廓、卡尺、数值都来自仓库已有算法对公开数据集的实际计算结果；
   不手画病灶、不写死测量值、不编造病理/分期/基因/日期/患者故事。
2. 数据只用 apps/imaging-worker/data/ 下的公开数据集样本，图上标明数据来源，不称「真实患者」「临床病例」。
3. 体数据统一经 dicom_io.load_nifti（spatial_canonicalizer.to_canonical_lps）转到 LPS 后再渲染：
   轴位上方为前（A）、图像左侧为患者右（R）；冠状/矢状位上方为头侧（S）。不使用 np.rot90 手调方向。
4. 算法跑不通（缺模型权重、输出为空）就跳过该图并打印原因，不退回到手画。

运行：apps/imaging-worker/.venv/bin/python scripts/generate_all_case_study_images.py
"""

import io
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import scipy.ndimage as ndi
from PIL import Image, ImageDraw

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE_DIR = os.path.join(ROOT_DIR, "apps", "site")
DATA_DIR = os.path.join(ROOT_DIR, "apps", "imaging-worker", "data")
sys.path.insert(0, os.path.join(ROOT_DIR, "apps", "imaging-worker", "src"))

from dicom_io import load_nifti, apply_ct_window  # noqa: E402
from presentation_state import render_pacs_viewport, get_cjk_font, get_sans_font  # noqa: E402
from spatial_canonicalizer import to_canonical_lps, get_radiological_orientation_labels  # noqa: E402
from recist import calculate_recist_metrics  # noqa: E402

# 数据来源标注：具体出处无法确认，统一写「公开数据集样本」加样本文件名，不猜测数据集名称
SOURCE_SPLEEN = "公开数据集样本 spleen_test（腹部 CT）"
SOURCE_CHEST = "公开数据集样本 chest_lung_ct（胸部 CT）"
SOURCE_LIDC = "公开数据集样本 lidc_lung_nodule_ct（胸部 CT，附带结节标注掩膜）"
DISCLAIMER = "公开数据集上的算法输出演示，非临床病例，不构成诊断意见"

# 统一配色
COL_BG = (7, 14, 23)
COL_TEXT = (226, 232, 240)
COL_MUTED = (148, 163, 184)
COL_ACCENT = (56, 189, 248)
COL_WARN = (251, 191, 36)


# ---------------------------------------------------------------------------
# 通用渲染工具
# ---------------------------------------------------------------------------

def font(size: int):
    f, _ = get_cjk_font(size=size)
    return f


def text_width(f, s: str) -> int:
    b = f.getbbox(s)
    return b[2] - b[0]


def wrap_text(f, s: str, max_w: int) -> List[str]:
    """按像素宽度逐字折行（中英混排）。"""
    lines, cur = [], ""
    for ch in s:
        if text_width(f, cur + ch) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def add_caption_panel(img: Image.Image, title: str, lines: List[str]) -> Image.Image:
    """在图像下方追加说明栏：数据来源、算法与免责声明。自动折行，保证文字不溢出。"""
    w = img.width
    f_title, f_body = font(14), font(12)
    pad = 14
    body: List[Tuple[str, Tuple[int, int, int]]] = []
    for ln in lines:
        col = COL_WARN if ln.startswith("注") else COL_MUTED
        for sub in wrap_text(f_body, ln, w - 2 * pad):
            body.append((sub, col))
    h = pad + 20 + len(body) * 17 + pad
    out = Image.new("RGB", (w, img.height + h), COL_BG)
    out.paste(img.convert("RGB"), (0, 0))
    d = ImageDraw.Draw(out)
    d.line([(0, img.height), (w, img.height)], fill=(30, 58, 95), width=1)
    y = img.height + pad
    d.text((pad, y), title, fill=COL_TEXT, font=f_title)
    y += 22
    for s, col in body:
        d.text((pad, y), s, fill=col, font=f_body)
        y += 17
    return out


def mask_outline(mask2d: np.ndarray) -> np.ndarray:
    m = mask2d > 0
    return m & ~ndi.binary_erosion(m, iterations=1)


def save_png(img: Image.Image, name: str) -> str:
    path = os.path.join(SITE_DIR, name)
    img.convert("RGB").save(path, format="PNG", optimize=True)
    print(f"  已保存: {path} ({img.width}x{img.height})")
    return path


def png_bytes_to_image(png: bytes) -> Image.Image:
    return Image.open(io.BytesIO(png)).convert("RGB")


def load_mask_lps(path: str, ref_shape: Tuple[int, int, int]) -> Tuple[np.ndarray, Tuple[float, float, float]]:
    m, sp = load_nifti(path)
    assert m.shape == ref_shape, f"掩膜尺寸 {m.shape} 与影像 {ref_shape} 不一致"
    return (m > 0.5).astype(np.uint8), sp


# ---------------------------------------------------------------------------
# 图 1：MONAI 3D-UNet 脾脏分割（spleen_test）
# ---------------------------------------------------------------------------

def generate_spleen_monai() -> Optional[Dict[str, Any]]:
    print("[1] MONAI 脾脏分割（spleen_ct 官方权重）...")
    import nibabel as nib
    from device import get_optimal_device
    from engine import MonaiNeuralInferencePipeline

    path = os.path.join(DATA_DIR, "spleen_test.nii.gz")
    vol, sp = load_nifti(path)

    pipe = MonaiNeuralInferencePipeline(get_optimal_device())
    try:
        # 传文件路径：由 MONAI 变换处理方向与重采样，并逆变换回原始体素网格
        mask_file_zyx, meta = pipe.infer_spleen(path)
    except RuntimeError as e:
        print(f"  跳过：{e}")
        return None
    # infer_spleen 返回的是原文件数组顺序的 (Z, Y, X)；转回 (X, Y, Z) 后与影像走同一套 LPS 规范化
    affine = nib.load(path).affine
    mask_lps, _, _ = to_canonical_lps(np.transpose(mask_file_zyx, (2, 1, 0)).astype(np.float32), affine)
    mask = (mask_lps > 0.5).astype(np.uint8)
    if mask.sum() == 0:
        print("  跳过：模型输出为空")
        return None

    rec = calculate_recist_metrics(mask, sp)
    z = rec["key_slice_index"]
    sl = apply_ct_window(vol[z], "abdomen")
    cal = rec["caliper_longest"]
    calipers = [{
        "p1": cal["p1"], "p2": cal["p2"], "value_mm": rec["longest_diameter_mm"],
        "color": (0, 220, 255, 255), "tick_len": 5,
    }]
    hud = [
        "模型: MONAI spleen_ct_segmentation 3D-UNet（官方权重）",
        f"推理: {meta['accelerator']} | 耗时 {meta['inference_duration_sec']} s",
        f"分割体积: {rec['total_volume_cm3']} cm3（{int(mask.sum()):,} 体素）",
        f"关键层（最大截面）最长径: {rec['longest_diameter_mm']} mm",
        f"数据: {SOURCE_SPLEEN}",
    ]
    png, _ = render_pacs_viewport(
        slice_uint8=sl, plane="axial", slice_idx=z, total_slices=vol.shape[0],
        physical_loc_mm=float(z * sp[0]), spacing_xy=(sp[1], sp[2]), slice_thickness_mm=sp[0],
        window_info={"center": 40, "width": 400, "name": "abdomen"},
        calipers=calipers, title_banner="HEURION IMAGING // MONAI SPLEEN SEGMENTATION",
        hud_lines=hud, overlays_rgba=[(mask[z] > 0, (168, 85, 247, 110)), (mask_outline(mask[z]), (216, 180, 254, 255))],
    )
    img = add_caption_panel(png_bytes_to_image(png), "脾脏自动分割与体积测量", [
        f"数据来源：{SOURCE_SPLEEN}，体素间距 {sp[2]:.3f}×{sp[1]:.3f}×{sp[0]:.2f} mm。",
        "算法：engine.MonaiNeuralInferencePipeline.infer_spleen（MONAI 官方 spleen_ct 3D-UNet 权重，滑窗推理）"
        " → recist.calculate_recist_metrics（体积与最大截面最长径）。紫色为模型分割结果，青色卡尺为算法给出的最长径。",
        f"注：{DISCLAIMER}。",
    ])
    save_png(img, "demo-spleen-monai-segmentation.png")
    return {"volume_cm3": rec["total_volume_cm3"], "ld_mm": rec["longest_diameter_mm"], "slice": z,
            "voxels": int(mask.sum()), "duration_s": meta["inference_duration_sec"], "accelerator": meta["accelerator"]}


# ---------------------------------------------------------------------------
# 图 2：三正交 MPR（chest_lung_ct），十字定位于体数据几何中心
# ---------------------------------------------------------------------------

def generate_chest_mpr() -> Dict[str, Any]:
    print("[2] 三正交 MPR（LPS 规范方向）...")
    vol, sp = load_nifti(os.path.join(DATA_DIR, "chest_lung_ct.nii.gz"))
    dz, dy, dx = sp
    zdim, ydim, xdim = vol.shape
    # 定位点取体数据几何中心，不依赖任何病灶或气道检测算法
    z, cy, cx = zdim // 2, ydim // 2, xdim // 2
    focus_note = f"十字定位：体数据几何中心（z={z}, y={cy}, x={cx}）"

    win = apply_ct_window(vol, "lung")
    # LPS (Z,Y,X)：z 增大向头侧，y 增大向后，x 增大向患者左
    axial = win[z]                       # 行=前→后，列=右→左：上 A、左 R
    coronal = win[::-1, cy, :]           # 行=头→足，列=右→左：上 S、左 R
    sagittal = win[::-1, :, cx]          # 行=头→足，列=前→后：上 S、左 A
    panels = [
        ("axial", axial, (dy, dx), (cy, cx), f"轴位 #{z}/{zdim}"),
        ("coronal", coronal, (dz, dx), (zdim - 1 - z, cx), f"冠状位 #{cy}/{ydim}"),
        ("sagittal", sagittal, (dz, dy), (zdim - 1 - z, cy), f"矢状位 #{cx}/{xdim}"),
    ]
    size = 340
    gap = 12
    head = 44
    out = Image.new("RGB", (3 * size + 4 * gap, head + size + gap), COL_BG)
    d = ImageDraw.Draw(out)
    d.text((gap, 10), "三正交多平面重建（MPR）· 肺窗 W1500 / L-600 · 按物理间距等比例显示", fill=COL_TEXT, font=font(14))
    f_lab, f_cmp = font(12), get_sans_font(size=13, bold=True)
    for i, (plane, img2d, (sr, sc), (fr, fc), label) in enumerate(panels):
        h_mm, w_mm = img2d.shape[0] * sr, img2d.shape[1] * sc
        scale = size / max(h_mm, w_mm)
        ph, pw = int(round(h_mm * scale)), int(round(w_mm * scale))
        tile = Image.fromarray(img2d).resize((pw, ph), Image.Resampling.BILINEAR).convert("RGB")
        ox = gap + i * (size + gap) + (size - pw) // 2
        oy = head + (size - ph) // 2
        d.rectangle([gap + i * (size + gap) - 1, head - 1, gap + i * (size + gap) + size, head + size], outline=(30, 41, 59))
        out.paste(tile, (ox, oy))
        # 十字线（中间留空，不遮挡目标）
        px = ox + (fc + 0.5) * sc * scale
        py = oy + (fr + 0.5) * sr * scale
        for a, b in [((px - 14, py), (px - 4, py)), ((px + 4, py), (px + 14, py)),
                     ((px, py - 14), (px, py - 4)), ((px, py + 4), (px, py + 14))]:
            d.line([a, b], fill=(0, 240, 255), width=2)
        # 方位标识
        cmp_lab = get_radiological_orientation_labels(plane)
        bx, by = gap + i * (size + gap), head
        d.text((bx + size // 2 - 5, by + 4), cmp_lab["top"], fill=(255, 235, 59), font=f_cmp)
        d.text((bx + size // 2 - 5, by + size - 20), cmp_lab["bottom"], fill=(255, 235, 59), font=f_cmp)
        d.text((bx + 5, by + size // 2 - 8), cmp_lab["left"], fill=(255, 235, 59), font=f_cmp)
        d.text((bx + size - 16, by + size // 2 - 8), cmp_lab["right"], fill=(255, 235, 59), font=f_cmp)
        d.text((bx + 6, by + size - 20), label, fill=COL_ACCENT, font=f_lab)
        # 5 cm 比例尺
        bar = 50.0 * scale
        d.line([(bx + size - 12 - bar, by + size - 26), (bx + size - 12, by + size - 26)], fill=(255, 255, 255), width=2)
        d.text((bx + size - 12 - bar, by + size - 42), "5 cm", fill=(255, 255, 255), font=f_lab)
    img = add_caption_panel(out, "三正交多平面重建", [
        f"数据来源：{SOURCE_CHEST}，体素间距 {dx:.3f}×{dy:.3f}×{dz:.2f} mm。",
        "处理：dicom_io.load_nifti 统一到 LPS 方向后直接取三个正交平面，按物理间距等比例缩放；未做任何病灶标注。"
        + focus_note + "。",
        f"注：{DISCLAIMER}。",
    ])
    save_png(img, "demo-chest-mpr-3view.png")
    return {"focus": (z, cy, cx)}


# ---------------------------------------------------------------------------
# 图 3、4：lidc_lung_nodule_ct 结节 —— 样本附带标注掩膜上的 RECIST 测量与影像组学特征
# ---------------------------------------------------------------------------

def run_lidc() -> Tuple[np.ndarray, np.ndarray, Tuple[float, float, float]]:
    vol, sp = load_nifti(os.path.join(DATA_DIR, "lidc_lung_nodule_ct.nii.gz"))
    mask, msp = load_mask_lps(os.path.join(DATA_DIR, "lidc_lung_nodule_mask.nii.gz"), vol.shape)
    assert np.allclose(sp, msp, atol=1e-3), "掩膜与影像体素间距不一致"
    return vol, mask, sp


def generate_lidc_recist(vol: np.ndarray, mask: np.ndarray, sp: Tuple[float, float, float]) -> Dict[str, Any]:
    print("[3] 肺结节 RECIST 测量（recist.py，样本附带标注掩膜）...")
    rec = calculate_recist_metrics(mask, sp)
    z = rec["key_slice_index"]
    sl = apply_ct_window(vol[z], "lung")
    cal = rec["caliper_longest"]
    m2 = mask[z] > 0

    hud = [
        "ROI: 样本附带的结节标注掩膜（非自动检出）",
        f"关键层（最大截面）: #{z}",
        f"最长径 LD: {rec['longest_diameter_mm']} mm | 垂直方向最大跨度: {rec['short_axis_mm']} mm",
        f"标注体积: {rec['total_volume_cm3']} cm3",
        f"数据: 公开数据集样本 lidc_lung_nodule_ct",
    ]
    ys, xs = np.where(m2)
    cyc, cxc = int(ys.mean()), int(xs.mean())
    png, _ = render_pacs_viewport(
        slice_uint8=sl, plane="axial", slice_idx=z, total_slices=vol.shape[0],
        physical_loc_mm=float(z * sp[0]), spacing_xy=(sp[1], sp[2]), slice_thickness_mm=sp[0],
        window_info={"center": -600, "width": 1500, "name": "lung"},
        title_banner="HEURION CHEST-CT // RECIST 1.1 MEASUREMENT",
        hud_lines=hud, overlays_rgba=[(mask_outline(m2), (255, 77, 79, 255))],
    )
    full = png_bytes_to_image(png)
    # 放大视窗：以标注中心为准裁出 96×96 像素并 5 倍放大（只裁剪不旋转，方位与左图一致）
    half = 48
    y0 = int(np.clip(cyc - half, 0, sl.shape[0] - 2 * half))
    x0 = int(np.clip(cxc - half, 0, sl.shape[1] - 2 * half))
    k = full.height // (2 * half)
    crop = Image.fromarray(sl[y0:y0 + 2 * half, x0:x0 + 2 * half]).resize((2 * half * k, 2 * half * k), Image.Resampling.BILINEAR).convert("RGBA")
    ov = np.zeros((2 * half * k, 2 * half * k, 4), dtype=np.uint8)
    m_crop = np.kron(m2[y0:y0 + 2 * half, x0:x0 + 2 * half].astype(np.uint8), np.ones((k, k), dtype=np.uint8)) > 0
    ov[m_crop] = (255, 77, 79, 70)
    ov[mask_outline(m_crop)] = (255, 77, 79, 255)
    crop = Image.alpha_composite(crop, Image.fromarray(ov, mode="RGBA")).convert("RGB")
    dc = ImageDraw.Draw(crop)
    p1 = ((cal["p1"][0] - x0 + 0.5) * k, (cal["p1"][1] - y0 + 0.5) * k)
    p2 = ((cal["p2"][0] - x0 + 0.5) * k, (cal["p2"][1] - y0 + 0.5) * k)
    dc.line([p1, p2], fill=(0, 220, 255), width=3)
    vx, vy = p2[0] - p1[0], p2[1] - p1[1]
    nrm = max(float(np.hypot(vx, vy)), 1e-4)
    nx, ny = -vy / nrm * 9, vx / nrm * 9
    for p in (p1, p2):
        dc.line([(p[0] - nx, p[1] - ny), (p[0] + nx, p[1] + ny)], fill=(0, 220, 255), width=3)
    f_lab = font(15)
    lab = f"LD {rec['longest_diameter_mm']} mm"
    lx, ly = min(max(p2[0] + 12, 8), crop.width - text_width(f_lab, lab) - 12), min(max(p2[1] - 10, 8), crop.height - 28)
    dc.rectangle([lx - 4, ly - 2, lx + text_width(f_lab, lab) + 4, ly + 20], fill=(15, 23, 42))
    dc.text((lx, ly), lab, fill=(0, 230, 255), font=f_lab)
    cmp_lab = get_radiological_orientation_labels("axial")
    f_c = get_sans_font(size=14, bold=True)
    dc.text((crop.width // 2 - 5, 6), cmp_lab["top"], fill=(255, 235, 59), font=f_c)
    dc.text((crop.width // 2 - 5, crop.height - 22), cmp_lab["bottom"], fill=(255, 235, 59), font=f_c)
    dc.text((6, crop.height // 2 - 8), cmp_lab["left"], fill=(255, 235, 59), font=f_c)
    dc.text((crop.width - 18, crop.height // 2 - 8), cmp_lab["right"], fill=(255, 235, 59), font=f_c)
    bar = 10.0 / sp[2] * k  # 1 cm
    dc.line([(crop.width - 16 - bar, crop.height - 30), (crop.width - 16, crop.height - 30)], fill=(255, 255, 255), width=3)
    dc.text((crop.width - 16 - bar, crop.height - 48), "1 cm", fill=(255, 255, 255), font=font(12))
    dc.text((8, 8), f"放大 ×{k}", fill=COL_ACCENT, font=font(13))
    # 在全图上标出放大区域
    dfull = ImageDraw.Draw(full)
    dfull.rectangle([x0, y0, x0 + 2 * half, y0 + 2 * half], outline=(0, 220, 255), width=1)

    combo = Image.new("RGB", (full.width + crop.width + 12, full.height), COL_BG)
    combo.paste(full, (0, 0))
    combo.paste(crop, (full.width + 12, 0))
    img = add_caption_panel(combo, "肺结节 RECIST 1.1 径线与体积测量", [
        f"数据来源：{SOURCE_LIDC}，层厚 {sp[0]} mm，像素间距 {sp[2]:.3f} mm。",
        "算法：recist.calculate_recist_metrics —— 在样本附带的结节标注掩膜上选最大截面层，经凸包求最长径（青色卡尺）、"
        "计算垂直方向最大跨度与三维体积。红色轮廓为样本附带的标注，不是本平台自动分割的结果。",
        "仅此一个时间点：本图不涉及疗效评估，也没有随访对比。",
        f"注：{DISCLAIMER}。",
    ])
    save_png(img, "demo-lidc-nodule-recist.png")
    return {"slice": z, "ld_mm": rec["longest_diameter_mm"], "short_mm": rec["short_axis_mm"],
            "volume_cm3": rec["total_volume_cm3"]}


def generate_lidc_radiomics(vol: np.ndarray, mask: np.ndarray, sp: Tuple[float, float, float]) -> Dict[str, Any]:
    print("[4] 肺结节影像组学特征（radiomics.py）...")
    from radiomics import extract_radiomics_features
    num_bins = 16
    r = extract_radiomics_features(vol, mask, spacing=sp, num_bins=num_bins)
    g = r["feature_groups"]
    sh, fo, gl, rl = g["shape_3d"], g["first_order"], g["glcm"], g["glrlm"]
    cards = [
        (f"三维形状（{len(sh)} 项，节选）", [
            ("体积", f"{sh['volume_cm3']} cm3"),
            ("表面积", f"{sh['surface_area_mm2']} mm2"),
            ("面积体积比", f"{sh['surface_to_volume_ratio']} /mm"),
            ("球形度", f"{sh['sphericity']}"),
            ("最大三维径", f"{sh['max_3d_diameter_mm']} mm"),
            ("伸长率 / 扁平度", f"{sh['elongation']} / {sh['flatness']}"),
        ]),
        (f"一阶统计（{len(fo)} 项，节选）", [
            ("均值 ± 标准差", f"{fo['mean']} ± {fo['std']} HU"),
            ("中位数", f"{fo['median']} HU"),
            ("P10 / P90", f"{fo['p10']} / {fo['p90']} HU"),
            ("偏度", f"{fo['skewness']}"),
            ("峰度", f"{fo['kurtosis']}"),
            ("熵", f"{fo['entropy']}"),
        ]),
        (f"纹理 GLCM {len(gl)} 项 / GLRLM {len(rl)} 项（节选）", [
            ("GLCM 对比度", f"{gl['contrast']}"),
            ("GLCM 同质性", f"{gl['homogeneity']}"),
            ("GLCM 联合熵", f"{gl['joint_entropy']}"),
            ("GLCM 相关性", f"{gl['correlation']}"),
            ("GLRLM 短游程优势", f"{rl['short_run_emphasis']}"),
            ("GLRLM 游程百分比", f"{rl['run_percentage']}"),
        ]),
    ]
    W, gap, cw = 1012, 14, 0
    cw = (W - 4 * gap) // 3
    head = 52
    row_h = 40
    ch = 36 + 6 * row_h + 8
    out = Image.new("RGB", (W, head + ch + gap), COL_BG)
    d = ImageDraw.Draw(out)
    d.text((gap, 10), f"三维影像组学特征（共计算 {r['feature_count']} 项，以下为节选）", fill=COL_TEXT, font=font(16))
    d.text((gap, 32), f"ROI：样本附带的结节标注掩膜（{r['lesion_voxel_count']} 体素）· 纹理灰度离散 {num_bins} 级 · 单一时间点",
           fill=COL_MUTED, font=font(12))
    f_t, f_k, f_v = font(13), font(12), get_sans_font(size=13, bold=True)
    for i, (title, rows) in enumerate(cards):
        x = gap + i * (cw + gap)
        y = head
        d.rectangle([x, y, x + cw, y + ch], fill=(11, 20, 36), outline=(30, 58, 95))
        d.text((x + 10, y + 9), title, fill=COL_ACCENT, font=f_t)
        d.line([(x + 10, y + 30), (x + cw - 10, y + 30)], fill=(30, 48, 75))
        ry = y + 38
        for k_, v_ in rows:
            d.text((x + 10, ry), k_, fill=(203, 213, 225), font=f_k)
            d.text((x + 10, ry + 16), v_, fill=(255, 255, 255), font=f_v)
            ry += row_h
    img = add_caption_panel(out, "影像组学特征提取", [
        f"数据来源：{SOURCE_LIDC}；ROI 与上一张 RECIST 图相同。",
        "算法：radiomics.extract_radiomics_features —— 三维形状、一阶直方图统计、GLCM 与 GLRLM 纹理特征，全部数值为本次实际计算结果。"
        "该实现尚未与 IBSI 参考数据集或 PyRadiomics 做一致性校验。",
        f"注：{DISCLAIMER}；单一时间点，不含治疗前后对比。",
    ])
    save_png(img, "demo-lidc-nodule-radiomics.png")
    return {"feature_count": r["feature_count"], "sphericity": sh["sphericity"], "volume_cm3": sh["volume_cm3"],
            "max3d_mm": sh["max_3d_diameter_mm"], "mean_hu": fo["mean"]}


# ---------------------------------------------------------------------------
# 未生成的图（如实记录原因，不退回手画）
# ---------------------------------------------------------------------------

SKIPPED = {
    "疗效差分热力图（原 real-case-3 / real-case-nsclc-3）": "需要同一受试者两次随访扫描，公开数据集中没有，不伪造。",
    "L3 体成分 / SMI（原 real-case-4 / real-case-sarco-1）": "totalsegmentator.py 实为 HU 阈值法（肌肉掩膜混入肝肾肠等软组织，L3 层由骨量最大层近似），"
        "且样本无身高数据，SMI 无从计算；不作为算法输出展示。",
    "前列腺 T2 MRI 分区（原 real-case-prostate-1）": "MONAI prostate_mri 权重在 prostate_mri 样本上推理输出为空掩膜（0 体素）。",
    "支气管扩张 / 粘液栓定量图": "bronchiectasis.py 为启发式阈值法，在 chest_lung_ct 上关键层落在肺门、粘液候选区可能为血管或淋巴结，经决定不对外展示。",
    "诊断链 / PK 毒性信息图（原 *_diagnostic_chain、sarco-2）": "属于编造的临床叙事，没有数据支撑。",
}


def main() -> None:
    os.makedirs(SITE_DIR, exist_ok=True)
    t0 = time.time()
    print(f"输出目录: {SITE_DIR}")
    summary: Dict[str, Any] = {}
    summary["spleen"] = generate_spleen_monai()
    summary["mpr"] = generate_chest_mpr()
    lv, lm, lsp = run_lidc()
    summary["lidc_recist"] = generate_lidc_recist(lv, lm, lsp)
    summary["lidc_radiomics"] = generate_lidc_radiomics(lv, lm, lsp)
    print("\n== 关键数值（均为本次计算结果）==")
    for k, v in summary.items():
        print(f"  {k}: {v}")
    print("\n== 未生成的图 ==")
    for k, v in SKIPPED.items():
        print(f"  {k}: {v}")
    print(f"\n完成，用时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
