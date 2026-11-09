"""PDF 文字层：逐字的位置、字号、粗斜体与上下标，以及与 Docling 块文字的对齐。

Docling 输出的块只有纯文字和块的位置，不带格式。这里直接读 PDF 文字层（pypdfium2），用于：
- 段首小标题（「Eligibility. This study …」）：块开头一段粗体、后面是正文；
- 上下标：字号明显小、基线抬高 / 降低的字（引用角标、kg/m²、CO₂）；
- 粘词：Docling 拼出的文字里丢了空格（「flowdiagramfor」），而 PDF 里两个词之间有间隔；
- 以后原版 PDF 视图里把块文字映射回页面位置（见 docs/design/PDF_ORIGINAL_VIEW.md）。

坐标统一用左上角为原点的 PDF 点，与 parser._box 一致。扫描页没有文字层，这里得到空列表。
"""

from __future__ import annotations

import ctypes
import difflib
import io
import math
import re
import statistics
import unicodedata
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Char:
    c: str
    l: float
    t: float
    r: float
    b: float
    bold: bool
    italic: bool
    size: float          # 宽松字框高度，约等于字号
    base: float          # 基线（左上原点，越大越靠下）
    font: str = ""       # 字体名（有的 PDF 字体名是乱码、读不出粗细，靠「与正文不是同一种字体」判断强调）
    angle: int = 0       # 字的方向（度，pdfium 的约定：270 = 自下而上排的竖排字）
    space_before: bool = False   # 与前一个字之间有空白（PDF 里的空格、换行或明显间隔）
    newline_before: bool = False  # 与前一个字不在同一行
    script: str = ""     # "sup" / "sub" / ""
    w: int = -1          # 所属词的序号（原版映射里编，见 parser._source_map）


@dataclass
class Page:
    no: int
    width: float
    height: float
    chars: list[Char] = field(default_factory=list)


_BOLD_NAME = re.compile(r"bold|black|heavy|semibold|demibold|-bd\b|,bd\b", re.I)
_ITALIC_NAME = re.compile(r"italic|oblique|-it\b|,it\b", re.I)


def extract(pdf_bytes: bytes, pages: list[int] | None = None) -> dict[int, Page]:
    """读出各页的字（不含空白字符；空白记在下一个字的 space_before 上）。pages 为 None 时读全部页。"""
    import pypdfium2 as pdfium
    import pypdfium2.raw as R

    out: dict[int, Page] = {}
    pdf = pdfium.PdfDocument(io.BytesIO(pdf_bytes))
    try:
        buf = ctypes.create_string_buffer(128)
        flags = ctypes.c_int()
        ox, oy = ctypes.c_double(), ctypes.c_double()
        for i in range(len(pdf)):
            no = i + 1
            if pages is not None and no not in pages:
                continue
            page = pdf[i]
            w, h = page.get_size()  # 显示方向的页面尺寸（已按 /Rotate 转过）
            rot = page.get_rotation() % 360
            pw, ph = (w, h) if rot in (0, 180) else (h, w)  # 未旋转的页面尺寸（字框坐标用的）

            def disp(x: float, y: float, rot: int = rot, pw: float = pw, ph: float = ph) -> tuple[float, float]:
                """PDF 用户空间的点（左下原点、未旋转）→ 显示方向、左上原点（与 Docling 的坐标一致）。"""
                if rot == 90:
                    return y, x
                if rot == 180:
                    return pw - x, y
                if rot == 270:
                    return ph - y, pw - x
                return x, ph - y

            pg = Page(no, float(w), float(h))
            tp = page.get_textpage()
            fonts: dict[tuple[str, int], tuple[bool, bool]] = {}
            pending_space = False
            last_base: float | None = None
            last_r: float | None = None
            try:
                n = tp.count_chars()
                for k in range(n):
                    code = R.FPDFText_GetUnicode(tp.raw, k)
                    # pdfium 把排版断词的行末连字符记作 \x02：统一成软连字符
                    ch = "­" if code == 2 else (chr(code) if 0 < code < 0x110000 else "")
                    if not ch or ch.isspace() or code in (0xFFFE, 0xFFFF):
                        pending_space = True
                        continue
                    l, b, r, t = tp.get_charbox(k, loose=True)
                    if r <= l and t <= b:
                        continue
                    R.FPDFText_GetCharOrigin(tp.raw, k, ox, oy)
                    R.FPDFText_GetFontInfo(tp.raw, k, buf, 128, ctypes.byref(flags))
                    weight = R.FPDFText_GetFontWeight(tp.raw, k)
                    key = (buf.value.decode("latin-1", "replace"), weight)
                    if key not in fonts:
                        name = key[0]
                        fonts[key] = (weight >= 600 or bool(_BOLD_NAME.search(name)),
                                      bool(flags.value & 64) or bool(_ITALIC_NAME.search(name)))
                    bold, italic = fonts[key]
                    angle = (round(math.degrees(R.FPDFText_GetCharAngle(tp.raw, k))) + rot) % 360
                    x1, y1 = disp(l, b)
                    x2, y2 = disp(r, t)
                    dl, dr, dt, db = min(x1, x2), max(x1, x2), min(y1, y2), max(y1, y2)
                    # 字号按字的方向取：横排取高，竖排取宽
                    size = float(db - dt) if angle in (0, 180) else float(dr - dl)
                    base = disp(ox.value, oy.value)[1]
                    newline = last_base is not None and (abs(base - last_base) > max(size, 1.0) * 0.9 and
                                                         (last_r is None or dl < last_r - size))
                    gap = last_r is not None and not newline and dl - last_r > max(size, 1.0) * 0.18
                    pg.chars.append(Char(ch, dl, dt, dr, db, bold, italic, size, base, font=key[0], angle=angle,
                                         space_before=pending_space or gap or newline, newline_before=newline))
                    pending_space = False
                    last_base, last_r = base, dr
            finally:
                tp.close()
                page.close()
            _mark_scripts(pg.chars)
            out[no] = pg
    finally:
        pdf.close()
    return out


def _mark_scripts(chars: list[Char]) -> None:
    """按行标出上下标：比本行主字号小两成以上，且基线抬高（上标）或降低（下标）。"""
    start = 0
    for k in range(1, len(chars) + 1):
        if k < len(chars) and not _new_line(chars, k):
            continue
        line = chars[start:k]
        start = k
        letters = [c for c in line if c.c.isalnum()]
        if len(letters) < 4:
            continue
        main = statistics.median(c.size for c in letters)
        normal = [c.base for c in letters if c.size >= main * 0.9]
        if not normal:
            continue
        base = statistics.median(normal)
        for c in line:
            if c.size >= main * 0.85:
                continue
            if c.base < base - main * 0.15:
                c.script = "sup"
            elif c.base > base + main * 0.08:
                c.script = "sub"


def _new_line(chars: list[Char], k: int) -> bool:
    """k 处是否另起一行（上下标的基线本来就有偏移，不能单凭基线判断）。"""
    a, b = chars[k - 1], chars[k]
    if b.newline_before:
        return True
    return b.l < a.l - max(a.size, b.size) * 2


def rotation(chars: list[Char]) -> int:
    """一片区域里字的主方向：六成以上的字是竖排时返回 90 / 270，否则 0。"""
    letters = [c for c in chars if c.c.isalnum()]
    if len(letters) < 20:
        return 0
    for a in (90, 270):
        if sum(1 for c in letters if abs(c.angle - a) <= 5) >= len(letters) * 0.6:
            return a
    return 0


def chars_in(page: Page, box: list[float], pad: float = 2.0) -> list[Char]:
    """字框中心落在 box（左、上、右、下）内的字，保持文字层顺序。"""
    l, t, r, b = box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad
    return [c for c in page.chars if l <= (c.l + c.r) / 2 <= r and t <= (c.t + c.b) / 2 <= b]


# —— 对齐 ——

_SOFT = "­"
_DASHES = "-‐‑‒–—―−" + _SOFT


def _norm_char(c: str) -> str:
    """对齐用的规范化：兼容分解（ﬁ → fi、全角 → 半角）、小写；连字符一律去掉（行末断词两边不一致）。"""
    s = unicodedata.normalize("NFKC", c).lower()
    return "".join(x for x in s if not x.isspace() and x not in _DASHES)


def align(text: str, chars: list[Char]) -> list[int | None]:
    """块文字逐字对应到 chars 的下标（对不上的为 None）。按规范化后的字符序列做最长匹配。"""
    a_src: list[int] = []
    a = []
    for i, c in enumerate(text):
        for x in _norm_char(c):
            a.append(x)
            a_src.append(i)
    b_src: list[int] = []
    b = []
    for j, ch in enumerate(chars):
        for x in _norm_char(ch.c):
            b.append(x)
            b_src.append(j)
    out: list[int | None] = [None] * len(text)
    if not a or not b:
        return out
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for blk in sm.get_matching_blocks():
        if blk.size < 2 and len(a) > 20:
            continue  # 孤立的单字匹配多半是巧合
        for d in range(blk.size):
            i, j = a_src[blk.a + d], b_src[blk.b + d]
            if out[i] is None:
                out[i] = j
    return out


# —— 用对齐结果修块文字 ——

@dataclass
class Enriched:
    text: str
    marks: list[list[Any]]           # [起, 止, "sup" | "sub" | "italic"]
    bold_prefix: int                  # 开头连续粗体的字数（0 = 没有）
    matched: float                    # 块文字里对上的比例


def enrich(text: str, chars: list[Char], scripts: bool = True) -> Enriched:
    """按 PDF 文字层修块文字：补回丢掉的空格与行末区间短横、去掉 Docling 在上标两边加的空格，给出上下标 / 斜体范围与开头粗体长度。

    scripts=False（表格单元格）：只补空格与短横，不动上标两边的空格，也不给格式。
    """
    m = align(text, chars)
    letters = [i for i, c in enumerate(text) if not c.isspace()]
    matched = sum(1 for i in letters if m[i] is not None) / len(letters) if letters else 0.0
    if matched < 0.6:
        return Enriched(text, [], 0, matched)

    # 「强调」：粗体，或者与本块正文字体不同的非斜体、非上下标字（字体名读不出粗细的 PDF 里，段首小标题常是另一种字体）
    fonts = [chars[j].font for j in m if j is not None]
    body_font = max(set(fonts), key=fonts.count) if fonts else ""
    strong = lambda ch: ch.bold or (bool(ch.font) and ch.font != body_font and not ch.italic and not ch.script)  # noqa: E731
    # 要补空格的位置：PDF 里同一行上两个字之间有空白，Docling 拼接时丢了（「OtherMenopausal」）
    ins: set[int] = set()
    for i in range(1, len(text)):
        j, pj = m[i], m[i - 1]
        if (j is not None and pj is not None and j == pj + 1 and chars[j].space_before and not chars[j].newline_before
                and text[i].isalnum() and text[i - 1].isalnum()):
            ins.add(i)
    # Docling 把行末的连字符当断词去掉了，但那是数值区间的短横（「8.8–\n30.6」→「8.830.6」）：补回。
    # 短横（–—−）一律补；普通连字符只在一边是数字时补（「COVID-\n19」），字母之间的是真断词
    dash_at: dict[int, str] = {}
    for i in range(1, len(text)):
        j, pj = m[i], m[i - 1]
        if j is None or pj is None or j - pj < 2 or not chars[j].newline_before:
            continue
        mid = "".join(chars[x].c for x in range(pj + 1, j))
        if mid and all(c in _DASHES and c != _SOFT for c in mid) and text[i - 1] not in _DASHES:
            if mid[-1] != "-" or text[i - 1].isdigit() or text[i].isdigit():
                dash_at[i] = mid[-1]
    # 反过来：Docling 留下了「dia- betes」，而 PDF 文字层里这两个字前后相接、只隔一个换行（排版软件的断词连字符不进文字层）
    drop: set[int] = set()
    for k in range(1, len(text) - 2):
        if text[k] in _DASHES and text[k + 1] == " " and text[k - 1].isalpha() and text[k + 2].islower():
            pj, j = m[k - 1], m[k + 2]
            if (pj is not None and j is not None and j > pj and chars[j].newline_before
                    and all(chars[x].c == _SOFT for x in range(pj + 1, j))):
                drop.update((k, k + 1))
    # 字距拉开的字（「T A B L E」）每个字之间都有间隔：一个词拆开后有不足两个字的段，这个词就不补
    for tok in re.finditer(r"\S+", text):
        cuts = [i for i in range(tok.start() + 1, tok.end()) if i in ins]
        if not cuts:
            continue
        edges = [tok.start(), *cuts, tok.end()]
        if any(b - a < 2 for a, b in zip(edges, edges[1:])):
            ins.difference_update(cuts)

    out: list[str] = []
    style: list[str] = []
    bold: list[bool] = []
    prev_j: int | None = None
    for i, c in enumerate(text):
        j = m[i]
        if i in drop:
            continue
        if c.isspace() and not scripts:
            out.append(c)
            style.append("")
            bold.append(False)
            continue
        if c.isspace():
            # Docling 在上标前后加的空格：PDF 里两边紧挨着（没有空白）就去掉
            nj = next((m[k] for k in range(i + 1, min(i + 3, len(text))) if not text[k].isspace()), None)
            nc = next((text[k] for k in range(i + 1, min(i + 3, len(text))) if not text[k].isspace()), "")
            if (prev_j is not None and nj is not None and nj == prev_j + 1 and not chars[nj].space_before
                    and (chars[nj].script or chars[prev_j].script)):
                continue
            # 上标后面紧跟标点（「risk3,4 .」）：标点前的空格是 Docling 加的
            if prev_j is not None and chars[prev_j].script == "sup" and nc and nc in ".,;:)]" and out and not out[-1].isspace():
                continue
            out.append(c)
            style.append("")
            bold.append(bool(bold and bold[-1]))
            continue
        if i in dash_at:
            out.append(dash_at[i])
            style.append("")
            bold.append(bool(bold and bold[-1]))
        elif i in ins and j is not None:
            out.append(" ")
            style.append("")
            bold.append(strong(chars[j]) and bool(bold and bold[-1]))
        ch = chars[j] if j is not None else None
        out.append(c)
        style.append(ch.script if ch and ch.script else ("italic" if ch and ch.italic else ""))
        bold.append(strong(ch) if ch else bool(bold and bold[-1]))
        if j is not None:
            prev_j = j
    new = "".join(out)
    # 对齐时去掉的连字符等没对上的字：两边是同一种上下标时归入其中（「3,5-7」整段是上标）
    for k, c in enumerate(new):
        if style[k] or c.isspace() or c.isalnum():
            continue
        p = next((style[x] for x in range(k - 1, -1, -1) if not new[x].isspace()), "")
        n = next((style[x] for x in range(k + 1, len(new)) if not new[x].isspace()), "")
        if p and p == n and p != "italic":
            style[k] = p

    marks: list[list[Any]] = []
    k = 0
    while k < len(new):
        s = style[k]
        if not s or new[k].isspace():
            k += 1
            continue
        e = k
        while e + 1 < len(new) and (style[e + 1] == s or (new[e + 1].isspace() and e + 2 < len(new) and style[e + 2] == s)):
            e += 1
        # 上下标只认数字、字母、常见符号；单个斜体标点不算
        seg = new[k:e + 1]
        if s != "italic" or any(ch.isalpha() for ch in seg):
            marks.append([k, e + 1, s])
        k = e + 1

    bp = 0
    while bp < len(new) and (bold[bp] or new[bp].isspace()):
        bp += 1
    while bp > 0 and new[bp - 1].isspace():
        bp -= 1
    # 小标题后面的句号 / 冒号有时是正文字体：算进小标题
    if bp:
        mm = re.match(r"\s*[.:：。]", new[bp:])
        if mm:
            bp += mm.end()
    if bp >= len(new.rstrip()):
        bp = 0  # 整块都是粗体：不是段首小标题
    if not scripts:
        return Enriched(new, [], 0, matched)
    return Enriched(new, marks, bp, matched)
