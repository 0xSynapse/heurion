"""
Clinical Radiology Presentation State (DICOM GSPS / TID 1500) and PACS Viewport Renderer
Decouples raw image pixels from vector annotations (calipers, contours, badges, compass, scale bar).
Renders publication-grade PACS viewport images adhering to ACR standards with canonical orientation.
"""

import io
import base64
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from typing import Dict, Any, Tuple, Optional, List
try:
    from .spatial_canonicalizer import get_radiological_orientation_labels
except (ImportError, ValueError):
    from spatial_canonicalizer import get_radiological_orientation_labels


def get_sans_font(size: int = 12, bold: bool = False):
    try:
        from PIL import ImageFont
        font_names = [
            "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
            "Arial Bold.ttf" if bold else "Arial.ttf",
            "Helvetica-Bold.ttf" if bold else "Helvetica.ttf"
        ]
        for name in font_names:
            try:
                return ImageFont.truetype(name, size)
            except Exception:
                continue
    except Exception:
        pass
    return ImageFont.load_default()


def get_cjk_font(size: int = 12):
    try:
        from PIL import ImageFont
        cjk_candidates = [
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
        ]
        for path in cjk_candidates:
            try:
                return ImageFont.truetype(path, size), True
            except Exception:
                continue
    except Exception:
        pass
    return get_sans_font(size=size), False


def build_presentation_state_payload(
    plane: str,
    slice_idx: int,
    total_slices: int,
    physical_loc_mm: float,
    spacing: Tuple[float, float, float],
    window_center: float,
    window_width: float,
    window_name: str,
    calipers: List[Dict[str, Any]],
    diagnostic_badges: List[Dict[str, Any]],
    qa_summary: Optional[Dict[str, Any]] = None,
    contours: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    Constructs a structured Presentation State payload adhering to DICOM GSPS / TID 1500 standards.
    """
    orientation = get_radiological_orientation_labels(plane)
    return {
        "plane": plane,
        "slice_index": slice_idx,
        "total_slices": total_slices,
        "physical_location_z_mm": round(physical_loc_mm, 2),
        "pixel_spacing_mm": [round(spacing[1], 3), round(spacing[2], 3)],
        "slice_thickness_mm": round(spacing[0], 2),
        "window": {
            "name": window_name,
            "center": int(window_center),
            "width": int(window_width)
        },
        "orientation_compass": orientation,
        "calipers": calipers,
        "diagnostic_badges": diagnostic_badges,
        "contours": contours or [],
        "qa_summary": qa_summary or {}
    }


def render_pacs_viewport(
    slice_uint8: np.ndarray,
    plane: str,
    slice_idx: int,
    total_slices: int,
    physical_loc_mm: float,
    spacing_xy: Tuple[float, float],
    slice_thickness_mm: float,
    window_info: Dict[str, Any],
    calipers: Optional[List[Dict[str, Any]]] = None,
    diagnostic_badges: Optional[List[Dict[str, Any]]] = None,
    title_banner: Optional[str] = None,
    hud_lines: Optional[List[str]] = None,
    overlays_rgba: Optional[List[Tuple[np.ndarray, Tuple[int, int, int, int]]]] = None
) -> Tuple[bytes, str]:
    """
    Renders an ACR/PACS compliant viewport image with:
    - Canonical orientation
    - 4-direction orientation compass markers (A/P/L/R or S/I/L/R)
    - Corner PACS HUDs (WL/WW, Slice Loc, Thickness, Img #)
    - Vector calipers with ticks
    - Scale bar in bottom right
    """
    h, w = slice_uint8.shape
    base_img = Image.fromarray(slice_uint8).convert("RGBA")

    # Composite segmentation masks if provided
    if overlays_rgba:
        for mask_bool, rgba in overlays_rgba:
            if mask_bool is not None and np.any(mask_bool):
                mask_layer = np.zeros((h, w, 4), dtype=np.uint8)
                mask_layer[mask_bool] = rgba
                base_img = Image.alpha_composite(base_img, Image.fromarray(mask_layer, mode="RGBA"))

    draw = ImageDraw.Draw(base_img)
    font_hud, supports_cjk = get_cjk_font(size=12 if h >= 400 else 10)
    font_compass = get_sans_font(size=14 if h >= 400 else 11, bold=True)
    font_scale = get_sans_font(size=11, bold=True)
    font_title = get_sans_font(size=13 if h >= 400 else 10, bold=True)

    # 1. Semi-transparent Diagnostic HUD Banner at top
    hud_h = 115 if h >= 400 else 85
    hud_overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    hud_draw = ImageDraw.Draw(hud_overlay)
    hud_draw.rectangle([0, 0, w, hud_h], fill=(15, 23, 42, 215))
    hud_draw.line([(0, hud_h), (w, hud_h)], fill=(56, 189, 248, 160), width=1)
    base_img = Image.alpha_composite(base_img, hud_overlay)
    draw = ImageDraw.Draw(base_img)

    if title_banner:
        draw.text((12, 6), title_banner, fill=(56, 189, 248, 255), font=font_title)

    if hud_lines:
        y_pos = 24 if h >= 400 else 18
        line_step = 15 if h >= 400 else 11
        for line in hud_lines:
            draw.text((12, y_pos), line, fill=(241, 245, 249, 245), font=font_hud)
            y_pos += line_step

    # 2. PACS Standard 4-direction Compass Markers (A/P/L/R)
    compass = get_radiological_orientation_labels(plane)
    top_label, bot_label = compass["top"], compass["bottom"]
    left_label, right_label = compass["left"], compass["right"]

    compass_color = (255, 235, 59, 230) # High-visibility radiological yellow
    # Top marker (just below HUD banner)
    draw.text((w // 2 - 6, hud_h + 6), top_label, fill=compass_color, font=font_compass)
    # Bottom marker
    draw.text((w // 2 - 6, h - 22), bot_label, fill=compass_color, font=font_compass)
    # Left marker
    draw.text((8, h // 2 - 8), left_label, fill=compass_color, font=font_compass)
    # Right marker
    draw.text((w - 20, h // 2 - 8), right_label, fill=compass_color, font=font_compass)

    # 3. Bottom-Left Corner PACS Metadata
    wl = window_info.get("center", -600)
    ww = window_info.get("width", 1500)
    wname = window_info.get("name", "lung")
    pacs_bl_text = [
        f"Im: #{slice_idx}/{total_slices}  Loc: {physical_loc_mm:.1f}mm",
        f"Thick: {slice_thickness_mm:.2f}mm",
        f"WL: {wl}  WW: {ww} [{wname}]"
    ]
    bl_y = h - 52
    for bl_t in pacs_bl_text:
        draw.text((12, bl_y), bl_t, fill=(148, 163, 184, 230), font=font_scale)
        bl_y += 14

    # 4. Scale Bar (lower right)
    dy, dx = spacing_xy
    scale_px = int(50.0 / max(dx, 0.1))
    margin_x = w - scale_px - 25
    margin_y = h - 22
    draw.line([(margin_x, margin_y), (margin_x + scale_px, margin_y)], fill=(255, 255, 255, 230), width=3)
    draw.text((margin_x, margin_y - 15), "5 cm", fill=(255, 255, 255, 230), font=font_scale)

    # 5. Render PACS Calipers
    if calipers:
        for cal in calipers:
            p1 = (int(cal["p1"][0]), int(cal["p1"][1]))
            p2 = (int(cal["p2"][0]), int(cal["p2"][1]))
            color = tuple(cal.get("color", (56, 189, 248, 255)))
            c_tick_len = cal.get("tick_len", 5)
            # Line
            draw.line([p1, p2], fill=color, width=2)
            # Orthogonal tick ends
            dx_c = p2[0] - p1[0]
            dy_c = p2[1] - p1[1]
            dist = max(float(np.hypot(dx_c, dy_c)), 1e-4)
            nx = -dy_c / dist
            ny = dx_c / dist
            for pt in [p1, p2]:
                t1 = (int(pt[0] - nx * c_tick_len), int(pt[1] - ny * c_tick_len))
                t2 = (int(pt[0] + nx * c_tick_len), int(pt[1] + ny * c_tick_len))
                draw.line([t1, t2], fill=color, width=2)
            # Caliper text
            val_str = f"{cal['value_mm']:.1f}mm"
            mid_x = (p1[0] + p2[0]) // 2
            mid_y = (p1[1] + p2[1]) // 2
            draw.text((mid_x - 12, mid_y + 6), val_str, fill=color, font=font_scale)

    # 6. Render Diagnostic Callout Badge
    if diagnostic_badges:
        for badge in diagnostic_badges:
            bx, by = int(badge["anchor"][0]), int(badge["anchor"][1])
            t1 = badge.get("title", "")
            t2 = badge.get("subtitle", "")
            t3 = badge.get("detail", "")
            
            b1 = font_hud.getbbox(t1)
            b2 = font_hud.getbbox(t2)
            b3 = font_hud.getbbox(t3) if t3 else (0, 0, 0, 0)
            bw = max(b1[2] - b1[0], b2[2] - b2[0], b3[2] - b3[0]) + 14
            bh = 48 if t3 else 36

            # Determine leader direction so badge stays strictly inside viewport
            dy_lead = -28 if by > 160 else 28
            elbow_y = by + dy_lead

            if bx + 45 + bw < w - 12:
                # Lead to the right
                dx_lead = 45
                elbow_x = bx + dx_lead
                text_x = elbow_x + 6
                end_x = text_x + bw
            else:
                # Lead to the left
                dx_lead = -45
                elbow_x = bx + dx_lead
                text_x = max(12, elbow_x - bw - 6)
                end_x = text_x
            
            draw.line([(bx, by), (elbow_x, elbow_y)], fill=(56, 189, 248, 220), width=1)
            draw.line([(elbow_x, elbow_y), (end_x, elbow_y)], fill=(56, 189, 248, 220), width=1)
            
            # Badge background
            draw.rectangle([text_x - 4, elbow_y - 20, text_x + bw, elbow_y + bh - 20], fill=(15, 23, 42, 235), outline=(56, 189, 248, 190), width=1)
            draw.text((text_x, elbow_y - 18), t1, fill=(255, 235, 59, 255), font=font_hud)
            draw.text((text_x, elbow_y - 2), t2, fill=(56, 189, 248, 255), font=font_hud)
            if t3:
                draw.text((text_x, elbow_y + 14), t3, fill=(251, 146, 60, 255), font=font_hud)

    buf = io.BytesIO()
    base_img.convert("RGB").save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    b64_str = "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
    return png_bytes, b64_str
