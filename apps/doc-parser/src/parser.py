"""Docling 解析：PDF → 按阅读顺序的结构化块。

输出（JSON 可序列化 dict）::

    {
      "engine": "docling", "engine_version": "2.x",
      "page_count": 3,
      "blocks": [
        {"type": "heading", "level": 1, "text": "...", "page": 1},
        {"type": "paragraph", "text": "...", "page": 1},
        {"type": "list", "ordered": true, "start": 1, "items": ["..."], "page": 1},
        {"type": "table", "rows": [["..."]], "header_rows": 1, "caption": "...", "page": 1},
        {"type": "figure", "mime": "image/png", "data": "<base64>", "caption": "...", "page": 1},
        {"type": "formula", "latex": "...", "page": 2}
      ],
      "scanned_pages": [{"page": 3, "ocr": true}, {"page": 4, "ocr": false, "mime": "image/png", "data": "<base64>"}],
      "warnings": []
    }

- 页眉页脚（Docling 归入 furniture 层）不输出。
- 扫描页（文字层少于 20 个字符）由 Docling OCR 出文字；OCR 也没识别出文字的页附整页图，
  由平台决定是否插入并在文档开头说明。
- 表格是规则网格：合并单元格的文字放在左上角格，被覆盖的格留空。
"""

from __future__ import annotations

import base64
import io
import re
import threading
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Any

from . import settings

# 文字层少于这么多个非空白字符的页视为扫描页（与平台 poppler 方案的阈值一致）
SCANNED_CHARS = 20

# 模型目录里的子目录（docling-tools models download / prefetch_models 的布局）
MODEL_DIRS = {
    "layout": "docling-project--docling-layout-heron",
    "tableformer": "docling-project--docling-models",
    "code_formula": "docling-project--CodeFormulaV2",
    "ocr": "RapidOcr",
}
REQUIRED_MODELS = {
    "layout": "版面分析（docling-layout-heron）",
    "tableformer": "表格结构（TableFormer）",
    "ocr": "OCR（RapidOCR / PP-OCR，扫描页用）",
}
OPTIONAL_MODELS = {
    "code_formula": "公式识别（CodeFormulaV2）",
}


class ModelsMissingError(RuntimeError):
    """模型目录缺少必需模型：服务拒绝启动，绝不在运行时下载。"""


def _has_model(models_dir: Path, name: str) -> bool:
    d = models_dir / MODEL_DIRS[name]
    return d.is_dir() and any(d.iterdir())


def check_models(models_dir: Path) -> dict[str, bool]:
    """各模型是否已在本地目录里。"""
    return {k: _has_model(models_dir, k) for k in MODEL_DIRS}


def ensure_models(models_dir: Path) -> dict[str, bool]:
    present = check_models(models_dir)
    missing = [REQUIRED_MODELS[k] for k in REQUIRED_MODELS if not present[k]]
    if missing:
        raise ModelsMissingError(
            f"模型目录 {models_dir} 缺少：{'、'.join(missing)}。"
            "请先在联网环境运行预下载命令：cd apps/doc-parser && uv run python -m src.prefetch_models"
            "（或设置 DOC_PARSER_MODELS_DIR 指向已下载好的目录）。运行时不会联网下载模型。"
        )
    return present


def build_converter(models_dir: Path, present: dict[str, bool]) -> Any:
    from docling.datamodel.accelerator_options import AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions, TableFormerMode
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opts = PdfPipelineOptions(artifacts_path=str(models_dir))
    opts.enable_remote_services = False  # 不调用任何远程 API
    opts.do_table_structure = True
    opts.table_structure_options.mode = TableFormerMode.ACCURATE
    opts.table_structure_options.do_cell_matching = True
    opts.do_formula_enrichment = settings.FORMULA and present.get("code_formula", False)
    opts.do_code_enrichment = False
    opts.do_picture_classification = False
    opts.do_picture_description = False
    opts.generate_picture_images = True
    opts.images_scale = 2.0
    opts.accelerator_options = AcceleratorOptions(num_threads=settings.THREADS)
    # 标题层级：按 PDF 书签、编号（1.2.3）、字号推断（版面模型本身只识别「是标题」）
    opts.heading_hierarchy_options.enabled = True
    # OCR：RapidOCR（PP-OCR，ONNX 推理，中英文）；artifacts_path 给定时只读本地模型，缺了直接报错不下载
    opts.do_ocr = True
    opts.ocr_options = RapidOcrOptions(lang=["ch"], backend="onnxruntime")
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})


# —— PDF 文字层：判定扫描页、渲染整页图（pypdfium2，Docling 自带依赖） ——


def page_text_chars(pdf_bytes: bytes) -> list[int]:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        out = []
        for i in range(len(pdf)):
            page = pdf[i]
            tp = page.get_textpage()
            text = tp.get_text_range()
            out.append(len(re.sub(r"\s", "", text)))
            tp.close()
            page.close()
        return out
    finally:
        pdf.close()


def render_page_png(pdf_bytes: bytes, page_no: int, dpi: int = 150) -> bytes:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        page = pdf[page_no - 1]
        img = page.render(scale=dpi / 72).to_pil()
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        page.close()
        return buf.getvalue()
    finally:
        pdf.close()


def render_crops(pdf_bytes: bytes, crops: list[tuple[int, list[float]]], scale: float = 2.0) -> list[bytes | None]:
    """按页码与区域（PDF 点，左上原点 [l, t, r, b]）裁出 PNG；单张失败返回 None。"""
    import pypdfium2 as pdfium

    out: list[bytes | None] = []
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        for page_no, (l, t, r, b) in crops:
            try:
                page = pdf[page_no - 1]
                w, h = page.get_size()
                pad = 4.0
                l, t, r, b = max(0.0, l - pad), max(0.0, t - pad), min(w, r + pad), min(h, b + pad)
                # crop 是从四边各裁掉多少（左、下、右、上）
                img = page.render(scale=scale, crop=(l, h - b, w - r, t)).to_pil()
                page.close()
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                out.append(buf.getvalue())
            except Exception:
                out.append(None)
        return out
    finally:
        pdf.close()


# —— DoclingDocument → 块 ——

_NUMBERED = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+\S")
_ORDERED_MARKER = re.compile(r"^\(?(\d{1,3})[.)、）]?$")
# 图 / 表题注开头（「Figure 1」「Fig. 2」「FIGURE 3」「Table 1」「图 1」「表 2」）
_FIG_LABEL = re.compile(r"^\s*(?:fig(?:ure)?s?\.?|图)\s*[a-z]?\d+", re.I)
_TABLE_LABEL = re.compile(r"^\s*(?:table|表)\s*[a-z]?\d+", re.I)
# 期刊加在图表下方的对象 DOI（「https://doi.org/10.1371/journal.pone.0327936.g001」）
_FLOAT_DOI = re.compile(r"^(?:https?://)?(?:dx\.)?doi\.org/\S+\.(?:g|t|s)\d{3}$", re.I)
# 期刊版面上被版面模型认成标题的标签（去掉空格、转小写后整串比对；「RE S EARCH ART I CL E」这类字距拉开的也能认出）
_FURNITURE_HEADING = re.compile(
    r"^\*?(?:openaccess|research|researcharticle|article|articleopen|original|originalarticle|originalresearch|"
    r"originalinvestigation|originalpaper|review|reviewarticle|briefreport|shortcommunication|editedby|reviewedby|"
    r"correspondence|correspondingauthors?|citation|copyright|keywords?|tocitethisarticle|checkforupdates|peerreview)[:.]?$"
)
_META_HEADING = re.compile(r"https?://|doi\.org|^doi\b|^(?:received|accepted|published)\b", re.I)
# 论文的标准一级章节（不带编号时据此定层级）
_TOP_SECTION = re.compile(
    r"^(?:abstract|summary|simple summary|author summary|plain language summary|graphical abstract|highlights|research in context|"
    r"introduction|background|methods?|materials? and methods|methods and materials|patients and methods|subjects and methods|"
    r"participants and methods|methodology|results|results and discussion|discussion|conclusions?|concluding remarks|"
    r"references|bibliography|acknowledge?ments?|supporting information|supplementary (?:material|materials|information|data)|"
    r"appendix|abbreviations|keywords|data availability(?: statement)?|code availability|availability of data and materials|"
    r"authors?'? contributions?|funding(?: information| statement)?|competing interests?|conflicts? of interests?(?: statement)?|"
    r"declarations?|ethics(?: statement| approval and consent to participate| declarations)?|consent (?:for publication|statement)|"
    r"additional information|publisher'?s note|generative ai statement|author details|reporting summary)$",
    re.I,
)
# 结构式摘要里的小标题：摘要与引言之间的这些标题放到摘要下一级
_ABSTRACT_SUB = re.compile(
    r"^(?:background|objectives?|aims?|purpose|design|methods?|methods and findings|setting|participants|interventions?|"
    r"main outcomes?(?: and measures)?|outcomes?|results|findings|conclusions?|interpretation|trial registration|"
    r"author summary|why was this study done\??|what did the researchers do and find\??|what do these findings mean\??|"
    r"subjects and controls|context|importance|evidence|funding)$",
    re.I,
)
_SENT_END = re.compile(r"[.!?:;。！？][\"”’)\]]*$")
_DANGLING_END = re.compile(
    r"(?:,|\b(?:the|of|and|or|in|to|a|an|with|for|by|as|at|on|from|that|than|was|were|is|are|be|between|among|this|"
    r"these|which|whereas|while|after|before|into|per|vs\.?))$",
    re.I,
)
# 没有图注、面积小于页面这个比例的图：期刊 logo、页眉标志、「Check for updates」、许可证图标等版面杂物
_FURNITURE_PIC_AREA = 0.02


def _page_of(item: Any) -> int | None:
    prov = getattr(item, "prov", None)
    return prov[0].page_no if prov else None


def _box(item: Any, doc: Any) -> list[float] | None:
    """条目在页面上的位置：[左, 上, 右, 下, 页宽, 页高]（PDF 点，左上原点）。"""
    prov = getattr(item, "prov", None)
    if not prov:
        return None
    page = doc.pages.get(prov[0].page_no) if hasattr(doc, "pages") else None
    if page is None:
        return None
    h = page.size.height
    b = prov[0].bbox.to_top_left_origin(h)
    return [float(b.l), float(b.t), float(b.r), float(b.b), float(page.size.width), float(h)]


def _font_size(text: str, box: list[float] | None) -> float:
    """按文字框面积与字数估算字号（约等于每字 0.5 个字号宽、行高 1 个字号）。"""
    if not box or not text:
        return 0.0
    area = max(0.0, (box[2] - box[0]) * (box[3] - box[1]))
    return (area / (0.5 * len(text))) ** 0.5


def _in_float(item: Any, doc: Any) -> bool:
    """条目挂在表格或图片下面（图里的坐标轴文字、被认成表格的森林图里的数字等）。"""
    par = getattr(item, "parent", None)
    for _ in range(8):
        if par is None:
            return False
        cref = par.cref
        if cref.startswith(("#/tables/", "#/pictures/")):
            return True
        if not cref.startswith("#/groups/"):
            return False
        try:
            par = par.resolve(doc).parent
        except Exception:
            return False
    return False


def _float_texts(item: Any, doc: Any) -> list[tuple[str, list[float]]]:
    """图 / 表下面挂着的全部文字条目（含组里的），带位置。"""
    out: list[tuple[str, list[float]]] = []
    stack = list(getattr(item, "children", []) or [])
    while stack:
        try:
            k = stack.pop(0).resolve(doc)
        except Exception:
            continue
        t = _clean(getattr(k, "text", "") or "")
        b = _box(k, doc)
        if t and b:
            out.append((t, b))
        stack.extend(getattr(k, "children", []) or [])
    return out


def _absorbed_caption(texts: list[tuple[str, list[float]]]) -> str:
    """图注被版面模型并进了图里：找「Figure n」开头的文字，连同它下方、左边对齐的文字拼成图注。"""
    for t, b in texts:
        if _FIG_LABEL.match(t):
            below = sorted((x for x in texts if x[1][1] >= b[1] - 2 and abs(x[1][0] - b[0]) <= 15), key=lambda x: (x[1][1], x[1][0]))
            return " ".join(x[0] for x in below)
    return ""


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\u0000", "")).strip()


def _image_b64(img: Any) -> str | None:
    if img is None:
        return None
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _table_block(item: Any, doc: Any) -> dict[str, Any]:
    data = item.data
    nr, nc = int(data.num_rows), int(data.num_cols)
    rows = [["" for _ in range(nc)] for _ in range(nr)]
    header_rows: set[int] = set()
    # 合并单元格：[起始行, 起始列, 跨行数, 跨列数]；文字只写在起始格，被覆盖的格留空
    candidates: list[list[int]] = []
    for cell in data.table_cells:
        r, c = int(cell.start_row_offset_idx), int(cell.start_col_offset_idx)
        if 0 <= r < nr and 0 <= c < nc:
            rows[r][c] = _clean(cell.text)
            if getattr(cell, "column_header", False):
                header_rows.add(r)
            rs = max(1, min(int(getattr(cell, "row_span", 1) or 1), nr - r))
            cs = max(1, min(int(getattr(cell, "col_span", 1) or 1), nc - c))
            if rs > 1 or cs > 1:
                candidates.append([r, c, rs, cs])
    # 合并区与已登记的合并区重叠、或覆盖到别的有字单元格时丢弃（只保留文字），避免丢字或下游拼出非法表格
    spans: list[list[int]] = []
    covered: set[tuple[int, int]] = set()
    for r, c, rs, cs in candidates:
        area = {(r + dr, c + dc) for dr in range(rs) for dc in range(cs)}
        if area & covered or any(rows[y][x] for y, x in area if (y, x) != (r, c)):
            continue
        spans.append([r, c, rs, cs])
        covered |= area
    # 表头行：从第 0 行起连续的列表头行
    h = 0
    while h in header_rows:
        h += 1
    caption = _clean(item.caption_text(doc)) if hasattr(item, "caption_text") else ""
    block: dict[str, Any] = {"type": "table", "rows": rows, "header_rows": h, "caption": caption, "page": _page_of(item)}
    if spans:
        block["spans"] = spans
    return block


def _heading_level(text: str, docling_level: int, has_title: bool) -> int:
    """Docling 的版面模型通常不区分标题层级；按「1.2 xxx」编号深度推断，否则用 Docling 给的层级。"""
    base = 1 if has_title else 0
    m = _NUMBERED.match(text)
    if m:
        depth = m.group(1).count(".") + 1
        return max(1, min(base + depth, 4))
    return max(1, min(base + max(docling_level, 1), 4))


@dataclass
class _ListAcc:
    parent: str
    ordered: bool
    start: int
    items: list[str] = field(default_factory=list)
    page: int | None = None


def document_to_blocks(doc: Any, post: bool = True) -> tuple[list[dict[str, Any]], list[str]]:
    """把 DoclingDocument 按阅读顺序转成块列表。"""
    from docling_core.types.doc import (
        DocItemLabel,
        FormulaItem,
        InlineGroup,
        ListItem,
        PictureItem,
        SectionHeaderItem,
        TableItem,
        TextItem,
        TitleItem,
    )

    blocks: list[dict[str, Any]] = []
    warnings: list[str] = []
    # 已作为图 / 表题注输出的文字，不再重复成段落
    caption_refs: set[str] = set()
    for coll in (doc.pictures, doc.tables):
        for it in coll:
            for ref in [*(getattr(it, "captions", []) or []), *(getattr(it, "footnotes", []) or [])]:
                caption_refs.add(ref.cref)

    def footnotes(it: Any) -> None:
        """图 / 表的脚注（缩写说明、统计方法注释）紧跟在图表后输出成段落。"""
        for ref in getattr(it, "footnotes", []) or []:
            try:
                t = _clean(ref.resolve(doc).text)
            except Exception:
                continue
            if t:
                blocks.append({"type": "paragraph", "text": t, "page": _page_of(it)})

    items = list(doc.iterate_items())
    has_title = any(isinstance(it, TitleItem) for it, _ in items)
    lst: _ListAcc | None = None

    def flush() -> None:
        nonlocal lst
        if lst and lst.items:
            blocks.append({"type": "list", "ordered": lst.ordered, "start": lst.start, "items": lst.items, "page": lst.page})
        lst = None

    # 行内组（文字与行内公式混排的一段）：合并回一个段落，公式写成 $LaTeX$
    inline: dict[str, Any] | None = None

    def inline_parent(it: Any) -> Any | None:
        par = it.parent.resolve(doc) if getattr(it, "parent", None) else None
        return par if isinstance(par, InlineGroup) else None

    for item, _depth in items:
        # 挂在图 / 表下面的文字（坐标轴、图例、被认成表格的图里的数字）不进正文；图注、脚注在图表处单独处理
        if not isinstance(item, (TableItem, PictureItem)) and _in_float(item, doc):
            continue
        grp = inline_parent(item) if isinstance(item, (TextItem, FormulaItem)) and not isinstance(item, ListItem) else None
        if grp is not None:
            piece = _clean(item.text)
            if isinstance(item, FormulaItem):
                piece = f"${piece}$" if piece else _clean(getattr(item, "orig", ""))
            if not piece:
                continue
            owner = grp.parent.resolve(doc) if grp.parent else None
            if isinstance(owner, ListItem) and lst and lst.items:
                # 列表项里的行内组：接到当前列表项后面
                lst.items[-1] = f"{lst.items[-1]} {piece}".strip()
                continue
            if inline is not None and inline["ref"] == grp.self_ref:
                inline["text"] = f"{inline['text']} {piece}"
                continue
            flush()
            inline = {"type": "paragraph", "text": piece, "page": _page_of(item), "ref": grp.self_ref}
            blocks.append(inline)
            continue
        inline = None
        if isinstance(item, ListItem):
            text = _clean(item.text)
            parent = item.parent.cref if item.parent else ""
            # 嵌套列表的子项挂在父列表项下：平铺到同一个列表里
            if lst and (parent == lst.parent or parent.startswith("#/groups/") and lst.items and lst.parent.startswith("#/groups/") and _is_nested(doc, parent, lst.parent)):
                if text:
                    lst.items.append(text)
                continue
            flush()
            ordered = bool(getattr(item, "enumerated", False))
            start = 1
            m = _ORDERED_MARKER.match((getattr(item, "marker", "") or "").strip())
            if ordered and m:
                start = int(m.group(1))
            lst = _ListAcc(parent=parent, ordered=ordered, start=start, items=[text] if text else [], page=_page_of(item))
            continue
        flush()

        if isinstance(item, TableItem):
            tb = _table_block(item, doc)
            filled = [c for r in tb["rows"] for c in r if c]
            # 题注是「Figure n」的「表格」：被认成表格的图（森林图等），按区域从 PDF 裁图
            if _FIG_LABEL.match(tb["caption"]):
                blocks.append({"type": "figure", "mime": "image/png", "data": None, "caption": tb["caption"], "page": tb["page"],
                               "_box": _box(item, doc), "_render": True})
                footnotes(item)
                continue
            if len(filled) > 1:
                blocks.append(tb)
                footnotes(item)
                continue
            # 不是表格的「表格」：
            # - 没有内容、底下挂着一堆文字的：被认成表格的图（森林图等），按区域从 PDF 裁图
            # - 只有一格字的：表注、图题被认成了表格，还原成段落
            texts = _float_texts(item, doc)
            cap = tb["caption"] or _absorbed_caption(texts)
            if not filled and len(texts) >= 5:
                blocks.append({"type": "figure", "mime": "image/png", "data": None, "caption": cap, "page": tb["page"],
                               "_box": _box(item, doc), "_render": True})
            else:
                for t in (tb["caption"], *filled):
                    if t:
                        blocks.append({"type": "paragraph", "text": t, "page": tb["page"], "_box": _box(item, doc),
                                       "_caption": bool(_FIG_LABEL.match(t) or _TABLE_LABEL.match(t))})
            footnotes(item)
        elif isinstance(item, PictureItem):
            caption = _clean(item.caption_text(doc)) or _absorbed_caption(_float_texts(item, doc))
            box = _box(item, doc)
            if not caption and box and (box[2] - box[0]) * (box[3] - box[1]) < _FURNITURE_PIC_AREA * box[4] * box[5]:
                continue
            data = _image_b64(item.get_image(doc))
            if data is None:
                warnings.append(f"第 {_page_of(item)} 页有一张图片未能提取")
                continue
            blocks.append({"type": "figure", "mime": "image/png", "data": data, "caption": caption, "page": _page_of(item), "_box": box})
            footnotes(item)
        elif isinstance(item, FormulaItem):
            latex = (item.text or "").strip()
            if latex:
                blocks.append({"type": "formula", "latex": latex, "page": _page_of(item)})
            elif _clean(getattr(item, "orig", "")):
                # 公式识别没跑或失败：保留 PDF 文字层里的原文
                blocks.append({"type": "formula", "latex": "", "text": _clean(item.orig), "page": _page_of(item)})
        elif isinstance(item, TitleItem):
            text = _clean(item.text)
            if text:
                blocks.append({"type": "heading", "level": 1, "text": text, "page": _page_of(item), "_box": _box(item, doc), "_dl": 0})
        elif isinstance(item, SectionHeaderItem):
            text = _clean(item.text)
            if text:
                blocks.append({"type": "heading", "level": _heading_level(text, int(item.level), has_title), "text": text,
                               "page": _page_of(item), "_box": _box(item, doc), "_dl": int(item.level)})
        elif isinstance(item, TextItem):
            if item.self_ref in caption_refs:
                continue
            if item.label in (DocItemLabel.PAGE_HEADER, DocItemLabel.PAGE_FOOTER):
                continue
            text = _clean(item.text)
            if text and not _FLOAT_DOI.match(text):
                blocks.append({"type": "paragraph", "text": text, "page": _page_of(item), "_box": _box(item, doc),
                               "_caption": item.label == DocItemLabel.CAPTION})
    flush()
    for b in blocks:
        b.pop("ref", None)
    return (_postprocess(blocks) if post else blocks), warnings


_ITEM_NUMBER = re.compile(r"^(\d{1,3})[.)、]?\s+(?=\S)")


def _postprocess(blocks: list[dict[str, Any]], pdf_bytes: bytes | None = None) -> list[dict[str, Any]]:
    """版面模型给出的结构做修正（全文一起做；分段解析时最后统一调用）。

    1. 列表：Docling 没识别出编号、但每项都以连续数字开头（「1 xxx」「2 xxx」）时改成有序列表并去掉编号。
    2. 图：独立成段的图注并回相邻的无图注图；同一页上连续的子图（最多一个图号）合成一张，按区域从 PDF 重新裁图。
    3. 论文标题：第一页上字号最大的、至少 4 个词的文字，提到最前面作 1 级标题。
    4. 期刊版面标签（OPEN ACCESS、REVIEWED BY、CORRESPONDENCE、侧栏里的人名等）、DOI / 日期被认成的标题，还原成段落。
    5. 标题层级：带编号的按编号深度；不带编号且能认出标准一级章节（引言、方法、结果、讨论、文末声明）的，
       以这些为一级、其余为其下级，Docling 的字号层级只用来判断是否再下一级。
    6. 换页 / 换栏、或被图表隔开而断开的段落接回去。
    """
    for b in blocks:
        if b["type"] != "list" or b["ordered"] or len(b["items"]) < 2:
            continue
        nums = [_ITEM_NUMBER.match(t) for t in b["items"]]
        if all(nums) and all(int(m.group(1)) == int(nums[0].group(1)) + i for i, m in enumerate(nums)):  # type: ignore[union-attr]
            b["ordered"] = True
            b["start"] = int(nums[0].group(1))  # type: ignore[union-attr]
            b["items"] = [t[m.end():] for t, m in zip(b["items"], nums)]  # type: ignore[union-attr]

    _drop_figure_debris(blocks)
    _attach_captions(blocks)
    _merge_panels(blocks)
    has_title = _pick_title(blocks)
    _demote_headings(blocks)
    if has_title or any("_dl" in b for b in blocks):
        _assign_levels(blocks, has_title)
    else:
        _legacy_title_shift(blocks)
    _join_paragraphs(blocks)
    _render_figures(blocks, pdf_bytes)
    for b in blocks:
        for k in [k for k in b if k.startswith("_")]:
            del b[k]
    return blocks


def _legacy_title_shift(blocks: list[dict[str, Any]]) -> None:
    """没有位置信息时（旧数据）：第一页开头不带编号的第一个标题视为文档标题，其余标题整体下移一级。"""
    first = next((i for i, b in enumerate(blocks) if b["type"] == "heading"), None)
    if first is None:
        return
    h = blocks[first]
    body_before = any(b["type"] in ("paragraph", "list", "table") for b in blocks[:first])
    rest = [b for b in blocks[first + 1:] if b["type"] == "heading"]
    if (h.get("page") in (1, None) and not body_before and not _NUMBERED.match(h["text"]) and h["level"] == 1
            and sum(1 for b in rest if b["level"] == 1) >= 2):
        for b in rest:
            b["level"] = min(b["level"] + 1, 4)


def _is_caption_para(b: dict[str, Any]) -> bool:
    return b["type"] == "paragraph" and (bool(b.get("_caption")) or bool(_FIG_LABEL.match(b["text"])))


def _is_debris(b: dict[str, Any]) -> bool:
    return b["type"] == "paragraph" and not _is_caption_para(b) and len(b["text"]) <= 30 and len(b["text"].split()) <= 3


def _drop_figure_debris(blocks: list[dict[str, Any]]) -> None:
    """图框外漏出的坐标轴刻度、图例碎片（「-41」「Weeks Weeks」）：紧挨着同一页的图、不超过 3 个词的短段落，去掉。"""
    changed = True
    while changed:
        changed = False
        for i, b in enumerate(blocks):
            if not _is_debris(b):
                continue
            near = [blocks[k] for k in (i - 1, i + 1) if 0 <= k < len(blocks)]
            if any(n["type"] == "figure" and n.get("page") == b.get("page") for n in near):
                del blocks[i]
                changed = True
                break


def _attach_captions(blocks: list[dict[str, Any]]) -> None:
    """独立成段的图注并进同一页上紧挨着的图：图在前面的接到图注末尾（续写的图注），否则给后面没有图注的图。"""
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if not _is_caption_para(b) or _TABLE_LABEL.match(b["text"]):
            i += 1
            continue
        prev = blocks[i - 1] if i > 0 else None
        nxt = blocks[i + 1] if i + 1 < len(blocks) else None
        same = lambda f: f is not None and f["type"] == "figure" and f.get("page") == b.get("page")  # noqa: E731
        labelled = bool(_FIG_LABEL.match(b["text"]))
        if same(prev) and (not prev["caption"] or not labelled or not _FIG_LABEL.match(prev["caption"])):  # type: ignore[index]
            prev["caption"] = f"{prev['caption']} {b['text']}".strip()  # type: ignore[index]
            del blocks[i]
            continue
        # 图与带图号的图注之间隔着一段图内注释（「Included in primary endpoint analysis …」）
        if (labelled and i >= 2 and same(blocks[i - 2]) and not blocks[i - 2]["caption"] and prev is not None
                and prev["type"] == "paragraph" and not _is_caption_para(prev) and len(prev["text"].split()) <= 60
                and prev.get("page") == b.get("page")):
            blocks[i - 2]["caption"] = b["text"]
            del blocks[i]
            continue
        # 图注在前：给紧随其后、没有图注的图（图注在页底、图在下一页顶部时允许跨一页）
        if (nxt is not None and nxt["type"] == "figure" and not nxt["caption"]
                and (nxt.get("page") == b.get("page") or (labelled and (nxt.get("page") or 0) == (b.get("page") or 0) + 1))):
            nxt["caption"] = b["text"]
            del blocks[i]
            continue
        i += 1


def _merge_panels(blocks: list[dict[str, Any]]) -> None:
    """同一页上连续的几张图、其中至少一张没有图注、图号不超过一个：是一张图被拆成的子图，合成一张。"""
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if b["type"] != "figure" or not b.get("_box"):
            i += 1
            continue
        j = i + 1
        while j < len(blocks) and blocks[j]["type"] == "figure" and blocks[j].get("_box") and blocks[j].get("page") == b.get("page"):
            j += 1
        group = blocks[i:j]
        caps = [g["caption"] for g in group if g["caption"]]
        labels = {re.sub(r"\s+", "", m.group(0).lower()) for c in caps if (m := _FIG_LABEL.match(c))}
        if len(group) > 1 and len(caps) < len(group) and len(labels) <= 1:
            boxes = [g["_box"] for g in group]
            union = [min(x[0] for x in boxes), min(x[1] for x in boxes), max(x[2] for x in boxes), max(x[3] for x in boxes), boxes[0][4], boxes[0][5]]
            # 先放标号的图注；裁图失败时退回面积最大的那张子图
            caps.sort(key=lambda c: 0 if _FIG_LABEL.match(c) else 1)
            biggest = max(group, key=lambda g: (g["_box"][2] - g["_box"][0]) * (g["_box"][3] - g["_box"][1]))
            blocks[i:j] = [{"type": "figure", "mime": "image/png", "data": biggest.get("data"), "caption": " ".join(caps),
                            "page": b.get("page"), "_box": union, "_render": True}]
        i += 1


def _render_figures(blocks: list[dict[str, Any]], pdf_bytes: bytes | None) -> None:
    """需要按区域裁图的图（合并的子图、被认成表格的图）：从 PDF 渲染；渲染不了时保留原图，没有原图的只留图注。"""
    todo = [i for i, b in enumerate(blocks) if b["type"] == "figure" and b.get("_render") and b.get("_box") and b.get("page")]
    images: list[bytes | None] = []
    if todo and pdf_bytes:
        try:
            images = render_crops(pdf_bytes, [(blocks[i]["page"], blocks[i]["_box"][:4]) for i in todo])
        except Exception:
            images = []
    for n, i in reversed(list(enumerate(todo))):
        img = images[n] if n < len(images) else None
        if img:
            blocks[i]["data"] = base64.b64encode(img).decode("ascii")
    for i in reversed(range(len(blocks))):
        b = blocks[i]
        if b["type"] == "figure" and not b.get("data"):
            if b.get("caption"):
                blocks[i] = {"type": "paragraph", "text": b["caption"], "page": b.get("page")}
            else:
                del blocks[i]


def _body_font_size(blocks: list[dict[str, Any]]) -> float:
    sizes = sorted(_font_size(b["text"], b.get("_box")) for b in blocks
                   if b["type"] == "paragraph" and b.get("_box") and len(b["text"].split()) >= 15)
    # 取偏小的中位数：段落少时不被扫描页 OCR 的大框带偏
    return sizes[(len(sizes) - 1) // 2] if sizes else 0.0


def _pick_title(blocks: list[dict[str, Any]]) -> bool:
    """第一页上字号最大、至少 4 个词的标题或段落是论文标题（期刊名、logo 文字通常不足 4 个词），提到最前面。"""
    body = _body_font_size(blocks)
    best, best_size = None, 0.0
    for i, b in enumerate(blocks):
        if b.get("page") != 1 or b["type"] not in ("heading", "paragraph") or not b.get("_box") or b.get("_caption"):
            continue
        t = b["text"]
        if len(t.split()) < 4 or len(t) > 300 or _META_HEADING.search(t):
            continue
        size = _font_size(t, b["_box"])
        if size > best_size:
            best, best_size = i, size
    if best is None or (body and best_size < body * 1.3):
        return False
    t = blocks.pop(best)
    blocks.insert(0, {"type": "heading", "level": 1, "text": t["text"], "page": t.get("page"), "_box": t.get("_box"), "_title": True})
    return True


def _demote_headings(blocks: list[dict[str, Any]]) -> None:
    """不是章节标题的「标题」还原成段落。"""
    body = _body_font_size(blocks)
    for b in blocks:
        if b["type"] != "heading" or b.get("_title"):
            continue
        t = b["text"]
        squashed = re.sub(r"\s+", "", t.lower())
        small_front = b.get("page") == 1 and body and b.get("_box") and _font_size(t, b["_box"]) < body * 0.8
        # 第一页上夹着单位编号的作者行（「SophieRoche 1,2 NimeshNaran 1 …」）
        author_line = b.get("page") == 1 and not _NUMBERED.match(t) and len(re.findall(r"\d", t)) >= 3
        if (_FURNITURE_HEADING.match(squashed) or _META_HEADING.search(t) or small_front or author_line
                or t.count("[") != t.count("]") or len(t.split()) > 30):
            b["type"] = "paragraph"
            b.pop("level", None)


def _assign_levels(blocks: list[dict[str, Any]], has_title: bool) -> None:
    base = 1 if has_title else 0
    heads = [b for b in blocks if b["type"] == "heading" and not b.get("_title")]
    is_top = lambda b: not _NUMBERED.match(b["text"]) and bool(_TOP_SECTION.match(b["text"].strip(" .:")))  # noqa: E731
    canonical = sum(1 for b in heads if is_top(b)) >= 3
    # 结构式摘要的范围：「Abstract」之后、「Introduction」之前
    names = [b["text"].strip(" .:").lower() for b in heads]
    in_abstract: set[int] = set()
    if "abstract" in names and "introduction" in names[names.index("abstract"):]:
        a, z = names.index("abstract"), names.index("introduction", names.index("abstract"))
        in_abstract = {id(heads[k]) for k in range(a + 1, z) if _ABSTRACT_SUB.match(heads[k]["text"].strip(" .:"))}
    anchor_dl: int | None = None   # 当前一级章节下，映射到「下一级」的 Docling 层级
    last: tuple[int, int] | None = None  # 上一个下级标题的（Docling 层级, 层级）
    last_numbered: int | None = None
    for b in heads:
        t = b["text"]
        m = _NUMBERED.match(t)
        dl = int(b.get("_dl", 1) or 1)
        if m:
            lvl = base + m.group(1).count(".") + 1
            last_numbered, anchor_dl, last = lvl, None, None
        elif id(b) in in_abstract:
            lvl = base + 2
        elif canonical and is_top(b):
            lvl = base + 1
            anchor_dl, last, last_numbered = None, None, None
        elif last_numbered is not None:
            # 编号章节里不带编号的小标题：放到上一个编号标题下一级
            lvl = last_numbered + 1
        elif canonical:
            if anchor_dl is None or dl <= anchor_dl:
                anchor_dl, lvl = dl, base + 2
            elif last and dl > last[0]:
                lvl = last[1] + 1
            elif last and dl == last[0]:
                lvl = last[1]
            else:
                lvl = base + 2
            last = (dl, lvl)
        else:
            lvl = base + max(dl, 1)
        b["level"] = max(1, min(lvl, 4))


def _join_paragraphs(blocks: list[dict[str, Any]]) -> None:
    """句子没写完的段落，与后面（可隔着最多两个图、表、图注）以小写字母开头或明显接续的段落接上；中间的图表移到段后。"""
    i = 0
    while i < len(blocks):
        a = blocks[i]
        if a["type"] != "paragraph" or a.get("_caption") or len(a["text"]) < 40 or _SENT_END.search(a["text"]):
            i += 1
            continue
        j = i + 1
        while j < len(blocks) and j - i <= 3 and (blocks[j]["type"] in ("figure", "table") or _is_caption_para(blocks[j])):
            j += 1
        if j >= len(blocks) or j - i > 3:
            i += 1
            continue
        nb = blocks[j]
        if (nb["type"] != "paragraph" or nb.get("_caption") or len(nb["text"].split()) < 3
                or _FIG_LABEL.match(nb["text"]) or _TABLE_LABEL.match(nb["text"])):
            i += 1
            continue
        ta, tb = a["text"], nb["text"]
        if not (re.match(r"[a-z(]", tb) or _DANGLING_END.search(ta)):
            i += 1
            continue
        a["text"] = ta[:-1] + tb if ta.endswith("-") and ta[-2:-1].isalpha() and tb[:1].islower() else f"{ta} {tb}"
        del blocks[j]
        # 同一段可能还要接下一块，i 不前进


def _is_nested(doc: Any, group_ref: str, outer_ref: str) -> bool:
    """group_ref 这个列表组是否嵌套在 outer_ref 列表组里（中间隔着一个列表项）。"""
    try:
        node = doc.groups[int(group_ref.rsplit("/", 1)[1])]
        for _ in range(4):
            parent = node.parent
            if parent is None:
                return False
            if parent.cref == outer_ref:
                return True
            node = parent.resolve(doc)
    except Exception:
        return False
    return False


class Parser:
    """持有 DocumentConverter（模型常驻内存）；解析串行执行，避免并发时内存翻倍。"""

    def __init__(self, models_dir: Path | None = None) -> None:
        self.models_dir = models_dir or settings.MODELS_DIR
        self.present = ensure_models(self.models_dir)
        self._converter = build_converter(self.models_dir, self.present)
        self._lock = threading.Lock()

    @property
    def capabilities(self) -> dict[str, bool]:
        return {
            "table_structure": True,
            "formula": bool(settings.FORMULA and self.present.get("code_formula")),
            "ocr": True,
        }

    def parse(self, pdf_bytes: bytes, filename: str = "input.pdf") -> dict[str, Any]:
        from docling.datamodel.base_models import ConversionStatus, DocumentStream

        chars = page_text_chars(pdf_bytes)
        if len(chars) > settings.MAX_PAGES:
            raise ValueError(f"PDF 共 {len(chars)} 页，超过上限 {settings.MAX_PAGES} 页")
        total = len(chars)
        chunk = settings.PAGE_CHUNK if settings.PAGE_CHUNK > 0 else max(total, 1)
        blocks: list[dict[str, Any]] = []
        warnings: list[str] = []
        partial = False
        with self._lock:
            for start in range(1, max(total, 1) + 1, chunk):
                end = min(start + chunk - 1, max(total, 1))
                try:
                    res = self._converter.convert(
                        DocumentStream(name=filename or "input.pdf", stream=io.BytesIO(pdf_bytes)),
                        raises_on_error=False, page_range=(start, end),
                    )
                    if res.status not in (ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS):
                        errs = "; ".join(str(getattr(e, "error_message", e)) for e in (res.errors or []))[:300]
                        raise RuntimeError(f"Docling 解析失败（{res.status}，第 {start}–{end} 页）：{errs}")
                    partial = partial or res.status == ConversionStatus.PARTIAL_SUCCESS
                    # 标题层级修正要看全文，分段时最后统一做
                    b, w = document_to_blocks(res.document, post=False)
                    blocks.extend(b)
                    warnings.extend(w)
                    del res
                finally:
                    _release_memory()
        blocks = _postprocess(blocks, pdf_bytes)
        if partial:
            warnings.append("部分页面解析失败，内容可能不完整")

        pages_with_text = {b.get("page") for b in blocks if b["type"] in ("paragraph", "heading", "list", "table", "formula")}
        scanned: list[dict[str, Any]] = []
        for i, n in enumerate(chars, start=1):
            if n >= SCANNED_CHARS:
                continue
            entry: dict[str, Any] = {"page": i, "ocr": i in pages_with_text}
            if not entry["ocr"]:
                try:
                    entry["mime"] = "image/png"
                    entry["data"] = base64.b64encode(render_page_png(pdf_bytes, i)).decode("ascii")
                except Exception as err:  # 渲染失败只记警告
                    entry.pop("mime", None)
                    warnings.append(f"第 {i} 页渲染失败：{str(err)[:100]}")
            scanned.append(entry)

        return {
            "engine": "docling",
            "engine_version": engine_version(),
            "page_count": len(chars),
            "blocks": blocks,
            "scanned_pages": scanned,
            "warnings": warnings,
        }


def _release_memory() -> None:
    """每次解析后把页图等临时内存还给系统（Linux glibc 需要 malloc_trim，否则常驻内存只涨不降）。"""
    import gc

    gc.collect()
    try:
        import ctypes
        import sys

        if sys.platform.startswith("linux"):
            ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


def engine_version() -> str:
    try:
        return metadata.version("docling")
    except metadata.PackageNotFoundError:
        return "unknown"
