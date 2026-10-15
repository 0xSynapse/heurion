import os
import re
import glob
from typing import Tuple, Optional
from PIL import ImageFont

_CACHED_CJK_FONT_PATH: Optional[str] = None
_CACHED_CJK_FONT_INDEX: int = 0
_CACHED_SANS_FONT_PATH: Optional[str] = None
_CHECKED_FONTS = False

CJK_CANDIDATE_PATHS = [
    # Linux (Debian, Ubuntu, CentOS, Fedora, Alpine)
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/source-han-sans/SourceHanSansCN-Regular.otf",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/cjkuni-uming/uming.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    # macOS (prioritize pure vector CJK fonts without mixed bitmap strikes)
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    # Windows
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simsun.ttc",
    "C:/Windows/Fonts/simhei.ttf",
]

SANS_CANDIDATE_PATHS = [
    # Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    # macOS
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    # Windows
    "C:/Windows/Fonts/arial.ttf",
]

SANS_BOLD_CANDIDATE_PATHS = [
    # Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    # macOS
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    # Windows
    "C:/Windows/Fonts/arialbd.ttf",
]


def _detect_cjk_font() -> Optional[str]:
    global _CACHED_CJK_FONT_PATH, _CACHED_CJK_FONT_INDEX
    if _CACHED_CJK_FONT_PATH is not None:
        return _CACHED_CJK_FONT_PATH or None

    # On macOS 14/15+, PingFang.ttc lives in /System/Library/AssetsV2
    candidates = list(CJK_CANDIDATE_PATHS)
    for pf_match in glob.glob("/System/Library/AssetsV2/**/PingFang.ttc", recursive=True):
        candidates.insert(0, pf_match)

    for path in candidates:
        if os.path.exists(path):
            idx = 3 if path.endswith("PingFang.ttc") else 0
            try:
                f = ImageFont.truetype(path, 14, index=idx)
            except Exception:
                idx = 0
                try:
                    f = ImageFont.truetype(path, 14, index=0)
                except Exception:
                    continue
            try:
                mask = f.getmask("支气管扩张")
                if mask.getbbox() and mask.getbbox()[2] > 10:
                    _CACHED_CJK_FONT_PATH = path
                    _CACHED_CJK_FONT_INDEX = idx
                    return path
            except Exception:
                continue

    # Try fontconfig glob on Linux if available
    for pattern in ["/usr/share/fonts/**/*cjk*.ttc", "/usr/share/fonts/**/*wqy*.ttc"]:
        for match in glob.glob(pattern, recursive=True):
            if os.path.exists(match):
                try:
                    f = ImageFont.truetype(match, 14)
                    mask = f.getmask("支气管扩张")
                    if mask.getbbox() and mask.getbbox()[2] > 10:
                        _CACHED_CJK_FONT_PATH = match
                        _CACHED_CJK_FONT_INDEX = 0
                        return match
                except Exception:
                    continue

    _CACHED_CJK_FONT_PATH = ""
    return None


def get_cjk_font(size: int = 14) -> Tuple[ImageFont.FreeTypeFont | ImageFont.ImageFont, bool]:
    """
    Returns a TrueType font supporting Chinese/CJK characters and a boolean flag `supports_cjk`.
    If no CJK TrueType font is installed on the host OS, returns a fallback sans/default font with `supports_cjk=False`.
    """
    cjk_path = _detect_cjk_font()
    if cjk_path:
        try:
            return ImageFont.truetype(cjk_path, size, index=_CACHED_CJK_FONT_INDEX), True
        except Exception:
            try:
                return ImageFont.truetype(cjk_path, size), True
            except Exception:
                pass

    # Fallback to sans font or default font
    sans_font = get_sans_font(size=size, bold=False)
    return sans_font, False


def get_sans_font(size: int = 14, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Returns a clean Sans-Serif font for medical HUD, calipers, and scale bars."""
    paths = SANS_BOLD_CANDIDATE_PATHS if bold else SANS_CANDIDATE_PATHS
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    # Try CJK font as sans fallback if available
    cjk = _detect_cjk_font()
    if cjk:
        try:
            return ImageFont.truetype(cjk, size)
        except Exception:
            pass
    try:
        return ImageFont.load_default()
    except Exception:
        return None  # type: ignore


_TRANSLATION_MAP = [
    (r"计算加速\s*:\s*", "Acc: "),
    (r"关键断面\s*:\s*第\s*#?(\d+)\s*层", r"Key Slice: #\1"),
    (r"关键断面\s*:\s*", "Key Slice: "),
    (r"形态分型\s*:\s*", "Phenotype: "),
    (r"柱状支气管扩张", "Cylindrical Bronchiectasis"),
    (r"囊状支气管扩张", "Cystic Bronchiectasis"),
    (r"静脉曲张型支气管扩张", "Varicose Bronchiectasis"),
    (r"轻度支气管扩张", "Mild Bronchiectasis"),
    (r"未见明显扩张", "No Dilation"),
    (r"BAR\s*扩张比\s*:\s*", "BAR: "),
    (r"BAR\s*:\s*", "BAR: "),
    (r"参考\s*<=\s*1\.0", "Ref <=1.0"),
    (r"管壁厚度比\s*:\s*", "Wall/Lumen: "),
    (r"粘液栓体积\s*:\s*", "Mucus Vol: "),
    (r"HAM高密度\s*:\s*", "HAM: "),
    (r"HAM\s*高密度\s*:\s*", "HAM: "),
    (r"阻塞率\s*:\s*", "Occlusion: "),
    (r"阻塞", "Blocked"),
    (r"优势分布\s*:\s*", "Distribution: "),
    (r"双肺散在", "Diffuse bilateral"),
    (r"右肺中叶", "RML"),
    (r"右肺下叶", "RLL"),
    (r"右肺上叶", "RUL"),
    (r"左肺上叶", "LUL"),
    (r"左肺下叶", "LLL"),
    (r"Bhalla\s*粘液分级\s*:\s*", "Bhalla Mucus: "),
    (r"Reiff\s*严重度评分\s*:\s*", "Reiff Score: "),
    (r"部分支气管粘液栓塞", "Partial Occlusion"),
    (r"广泛粘液嵌顿", "Total Occlusion"),
    (r"管腔通畅", "Patent"),
    (r"粘液栓\s*:\s*", "Mucus: "),
    (r"未见明显局灶粘液栓", "No focal mucus plug"),
    (r"第\s*#?(\d+)\s*层", r"#\1"),
    (r"正常肺血管分支断面", "Normal Pulmonary Vessel"),
    (r"正常肺血管截面", "Normal Pulmonary Vessel"),
    (r"正常肺血管分支", "Normal Pulmonary Vessel"),
    (r"正常解剖结构", "Normal Anatomy"),
    (r"非肺结节", "Not a Nodule"),
    (r"非结节", "Not a Nodule"),
    (r"伴行血管", "Companion Vessel"),
    (r"伴行印戒征", "Signet Ring"),
    (r"实性结节", "Solid Nodule"),
    (r"磨玻璃结节", "GGN"),
    (r"部分实性结节", "Subsolid Nodule"),
    (r"实性核心", "Solid Core"),
    (r"类", "Cat"),
    (r"轴位", "Axial"),
    (r"冠状位", "Coronal"),
    (r"矢状位", "Sagittal"),
    (r"横断面", "Axial"),
    (r"额状面", "Coronal"),
    (r"矢状面", "Sagittal"),
]


def sanitize_text(text: str, supports_cjk: bool) -> str:
    """
    Sanitizes diagnostic text for HUD and caliper rendering:
    - If `supports_cjk` is True, returns original text.
    - If `supports_cjk` is False, translates common medical phrases to clean English
      and strips any residual non-ASCII characters to prevent PIL from drawing '□' glyphs.
    """
    if supports_cjk:
        return text

    res = text
    for pat, rep in _TRANSLATION_MAP:
        res = re.sub(pat, rep, res)

    # Strip any remaining CJK characters (Unicode 4E00-9FFF) to ensure no replacement square boxes
    res = re.sub(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]", "", res)
    # Clean up empty parentheses like " ()" or "( )"
    res = re.sub(r"\(\s*\)", "", res)
    # Clean up multiple spaces
    res = re.sub(r"\s{2,}", " ", res).strip()
    return res
