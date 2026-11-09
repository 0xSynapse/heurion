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
import statistics
import threading
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Any

from . import pdf_text, settings

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
    r"correspondence|correspondingauthors?|citation|copyright|keywords?|tocitethisarticle|checkforupdates|peerreview|"
    r"open|contentslistsavailableatsciencedirect|hhspublicaccess|authormanuscripts?|orcidi?ds?|articleinformation|articleinfo|"
    r"affiliations?|footnotes)[:.]?$"
)
# 第一页上、论文正文开始前可以保留的标题（导读框、要点）
_FRONT_KEEP = re.compile(
    r"^(?:strengths and limitations(?: of this study)?|key points|key messages|what is already known.*|what (?:this study|this paper) adds.*|"
    r"what is new.*|what is known.*|highlights|research in context|plain language summary|graphical abstract|core tip|"
    r"significance(?: statement)?|in brief|summary|author summary|simple summary|lay summary)$",
    re.I,
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
    r"additional information|publisher'?s note|generative ai statement|author details|reporting summary|"
    # 文末声明的其他写法
    r"contributors|data sharing(?: statement)?|declarations? of (?:competing )?interests?|declaration of generative ai.*|"
    r"credit authorship contribution statement|disclosures?(?: statement)?|sources? of funding|consent(?: for publication)?|"
    r"perspectives|research insights?|ethics approval.*|appendix.*|supplementary data|supporting information|"
    # 导读框（JAMA、Lancet、AHA 等期刊放在摘要旁边的要点框），与一级章节同级
    r"what is new\??|what is known.*|what is relevant\??|what are the clinical implications\??|"
    r"clinical (?:and )?pathophysiological implications?|evidence before this study|added value of this study|"
    r"implications of all the available evidence|key points|key messages)$",
    re.I,
)


_BODY_START = re.compile(
    r"^(?:introduction|background|methods?|materials? and methods|methods and materials|patients and methods|"
    r"subjects and methods|participants and methods|methodology|results|discussion)$",
    re.I,
)


def _section_name(t: str) -> str:
    """比对章节名用：去掉首尾标点，「&」当「and」。"""
    return re.sub(r"\s*&\s*", " and ", t.strip(" .:"))
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


def _all_regions(item: Any, doc: Any) -> list[list[float]]:
    """条目的全部位置（跨页、跨栏的段落 Docling 给多处）：[[页, 左, 上, 右, 下], …]。"""
    out: list[list[float]] = []
    for pv in getattr(item, "prov", None) or []:
        page = doc.pages.get(pv.page_no) if hasattr(doc, "pages") else None
        if page is None:
            continue
        b = pv.bbox.to_top_left_origin(page.size.height)
        out.append([pv.page_no, round(float(b.l), 1), round(float(b.t), 1), round(float(b.r), 1), round(float(b.b), 1)])
    return out


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
    t = re.sub(r"\s+", " ", (text or "").replace("\u0000", "")).strip()
    # 中文行末换行被拼成了空格（「是在传统 的正畸治疗中」）：两边都是汉字或中文标点时去掉
    return re.sub(r"(?<=[㐀-鿿　-〿，；：（）])\s+(?=[㐀-鿿　-〿，；：（）])", "", t)


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
    cell_boxes: list[list[Any]] = []
    tb = _box(item, doc)
    for cell in data.table_cells:
        r, c = int(cell.start_row_offset_idx), int(cell.start_col_offset_idx)
        if 0 <= r < nr and 0 <= c < nc:
            rows[r][c] = _clean(cell.text)
            bb = getattr(cell, "bbox", None)
            if bb is not None and tb is not None and rows[r][c]:
                try:
                    b2 = bb.to_top_left_origin(tb[5]) if "BOTTOM" in str(getattr(bb, "coord_origin", "")).upper() else bb
                    cell_boxes.append([r, c, [float(b2.l), float(b2.t), float(b2.r), float(b2.b)]])
                except Exception:
                    pass
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
    if cell_boxes:
        block["_cells"] = cell_boxes
    if tb is not None:
        block["_box"] = tb
    return block


def _unrotate_table(t: dict[str, Any], angle: int) -> None:
    """竖排印刷的表（整张表转了 90°）：表格模型按页面方向读出来是转置的，转回原来的行列。

    自下而上排的字（pdfium 角度 270）：模型读出的第 0 行是原表最后一列，原表 [行 j][列 k] = 读出 [nr-1-k][j]；
    自上而下（90）：原表 [行 j][列 k] = 读出 [k][nc-1-j]。合并单元格无法可靠换算，丢弃（文字保留）。
    """
    g = t["rows"]
    nr, nc = len(g), len(g[0]) if g else 0
    if not nr or not nc:
        return
    if angle == 270:
        t["rows"] = [[g[nr - 1 - k][j] for k in range(nr)] for j in range(nc)]
    else:
        t["rows"] = [[g[k][nc - 1 - j] for k in range(nr)] for j in range(nc)]
    t["header_rows"] = 1
    t.pop("spans", None)
    t["_unrotated"] = True  # 单元格位置还是转回前的行列，原版映射不给单元格对齐


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
                regs = _all_regions(item, doc)
                if len(regs) > 1:
                    blocks[-1]["_regions"] = regs
    flush()
    for b in blocks:
        b.pop("ref", None)
    return (_postprocess(blocks) if post else blocks), warnings


_ITEM_NUMBER = re.compile(r"^(\d{1,3})[.)、]?\s+(?=\S)")


def _postprocess(blocks: list[dict[str, Any]], pdf_bytes: bytes | None = None,
                 out: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """版面模型给出的结构做修正（全文一起做；分段解析时最后统一调用）。

    1. 列表：Docling 没识别出编号、但每项都以连续数字开头（「1 xxx」「2 xxx」）时改成有序列表并去掉编号。
    2. 图：独立成段的图注并回相邻的无图注图；同一页上连续的子图（最多一个图号）合成一张，按区域从 PDF 重新裁图。
    3. 论文标题：第一页上字号最大的、至少 4 个词的文字，提到最前面作 1 级标题。
    4. 期刊版面标签（OPEN ACCESS、REVIEWED BY、CORRESPONDENCE、侧栏里的人名等）、DOI / 日期被认成的标题，还原成段落。
    5. 标题层级：带编号的按编号深度；不带编号且能认出标准一级章节（引言、方法、结果、讨论、文末声明）的，
       以这些为一级、其余为其下级，Docling 的字号层级只用来判断是否再下一级。
    6. 换页 / 换栏、或被图表、脚注、作者单位隔开而断开的段落接回去。
    7. 按 PDF 文字层（pdf_text.py）修文字：补回丢掉的空格、上下标与斜体（输出 marks）、段首粗体小标题拆成标题。
    """
    for b in blocks:
        if b["type"] != "list" or b["ordered"] or len(b["items"]) < 2:
            continue
        nums = [_ITEM_NUMBER.match(t) for t in b["items"]]
        if all(nums) and all(int(m.group(1)) == int(nums[0].group(1)) + i for i, m in enumerate(nums)):  # type: ignore[union-attr]
            b["ordered"] = True
            b["start"] = int(nums[0].group(1))  # type: ignore[union-attr]
            b["items"] = [t[m.end():] for t, m in zip(b["items"], nums)]  # type: ignore[union-attr]

    pages = _enrich_from_text_layer(blocks, pdf_bytes)
    _drop_running_heads(blocks)
    for b in blocks:
        # 被认成标题的图表题注（「Figure 1 …」「TABLE 2 …」「表3 …」）：还原成段落，后面按题注处理
        if b["type"] == "heading" and (_FIG_LABEL.match(b["text"]) or _TABLE_LABEL.match(b["text"])):
            b["type"] = "paragraph"
            b.pop("level", None)
    _drop_figure_debris(blocks)
    _attach_captions(blocks)
    _merge_panels(blocks)
    has_title = _pick_title(blocks, pages)
    _demote_headings(blocks)
    _split_runin_headings(blocks)
    if has_title or any("_dl" in b for b in blocks):
        _assign_levels(blocks, has_title)
    else:
        _legacy_title_shift(blocks)
    _join_paragraphs(blocks)
    _render_figures(blocks, pdf_bytes)
    if out is not None and pages:
        out["source"] = _source_map(blocks, pages)
    for b in blocks:
        for k in [k for k in b if k.startswith("_")]:
            del b[k]
        if "marks" in b and (b["type"] not in ("paragraph", "heading") or not b["marks"]):
            del b["marks"]
    return blocks


def _regions(b: dict[str, Any]) -> list[list[float]]:
    """块在页面上的区域：[[页, 左, 上, 右, 下], …]（接起来的段落有多个）。"""
    if "_regions" in b:
        return b["_regions"]
    x = b.get("_box")
    return [[b["page"], *[round(v, 1) for v in x[:4]]]] if x and b.get("page") else []


def _source_map(blocks: list[dict[str, Any]], pages: dict[int, Any]) -> dict[str, Any]:
    """原版映射的原料（docs/design/PDF_ORIGINAL_VIEW.md §3）：各页的词，每块的区域与「块文字 → 词」的对齐。

    块上写 src：{"regions": [[页, 左, 上, 右, 下], …], "spans": [[起, 止, 词序号], …]}（spans 按块的 text 下标）；
    表格另有 "cells": [[行, 列, spans], …]。返回 {"pages": [{"w", "h"}], "words": [[页, 左, 上, 右, 下, 文字], …]}。
    """
    words: list[list[Any]] = []
    for no in sorted(pages):
        cur: list[Any] | None = None
        for c in pages[no].chars:
            if cur is None or c.space_before:
                cur = [no, c.l, c.t, c.r, c.b, ""]
                words.append(cur)
            cur[1], cur[2], cur[3], cur[4] = min(cur[1], c.l), min(cur[2], c.t), max(cur[3], c.r), max(cur[4], c.b)
            cur[5] += c.c
            c.w = len(words) - 1
    for w in words:
        w[1:5] = [round(v, 1) for v in w[1:5]]

    def chars_of(regions: list[list[float]]) -> list[Any]:
        seen: set[int] = set()
        out_chars = []
        for p, l, t, r, bb in regions:
            pg = pages.get(int(p))
            if pg is None:
                continue
            for c in pdf_text.chars_in(pg, [l, t, r, bb]):
                if id(c) not in seen:
                    seen.add(id(c))
                    out_chars.append(c)
        return out_chars

    def spans(text: str, chars: list[Any]) -> list[list[int]]:
        m = pdf_text.align(text, chars)
        out_spans: list[list[int]] = []
        for i, j in enumerate(m):
            if j is None:
                continue
            w = chars[j].w
            if out_spans and out_spans[-1][2] == w and out_spans[-1][1] >= i - 1:
                out_spans[-1][1] = i + 1
            else:
                out_spans.append([i, i + 1, w])
        return out_spans

    for b in blocks:
        regions = _regions(b)
        if not regions:
            continue
        src: dict[str, Any] = {"regions": regions}
        if b["type"] in ("paragraph", "heading") and b.get("text"):
            src["spans"] = spans(b["text"], chars_of(regions))
        elif b["type"] == "table" and b.get("_cells") and b.get("page"):
            cells = []
            for r, c, box in b["_cells"]:
                if r < len(b["rows"]) and c < len(b["rows"][r]) and b["rows"][r][c]:
                    sp = spans(b["rows"][r][c], chars_of([[b["page"], *box]]))
                    if sp:
                        cells.append([r, c, sp])
            if cells and not b.get("_unrotated"):
                src["cells"] = cells
        b["src"] = src
    return {"pages": [{"w": round(pages[n].width, 1), "h": round(pages[n].height, 1)} for n in sorted(pages)], "words": words}


def _enrich_from_text_layer(blocks: list[dict[str, Any]], pdf_bytes: bytes | None) -> dict[int, Any]:
    """段落与标题按 PDF 文字层修文字、标上下标 / 斜体，记下开头粗体的长度（_bold）。文字层读不出时原样不动。

    返回读出的各页文字层（找回漏掉的标题时还要用）。
    """
    if not pdf_bytes:
        return {}
    todo = [b for b in blocks if b["type"] in ("paragraph", "heading") and b.get("_box") and b.get("page")]
    tables = [b for b in blocks if b["type"] == "table" and b.get("_cells") and b.get("page")]
    try:
        pages = pdf_text.extract(pdf_bytes)  # 全部页：原版映射要每页的词
    except Exception:
        return {}
    # 表格单元格只修文字（行末被当成断词去掉的区间短横、丢掉的空格），不标上下标：单元格里没有格式通道，
    # 去掉上标两边的空格会把「10 9 /L」拼成「109/L」
    for t in tables:
        pg = pages.get(t["page"])
        if pg is None or not pg.chars:
            continue
        for r, c, box in t["_cells"]:
            text = t["rows"][r][c]
            e = pdf_text.enrich(text, pdf_text.chars_in(pg, box, pad=1.0), scripts=False)
            if e.matched >= 0.8:
                t["rows"][r][c] = e.text
        if t.get("_box"):
            angle = pdf_text.rotation(pdf_text.chars_in(pg, t["_box"]))
            if angle:
                _unrotate_table(t, angle)
    for b in todo:
        pg = pages.get(b["page"])
        if pg is None or not pg.chars:
            continue
        # 跨页 / 跨栏的段落有几处位置：按顺序取各处的字
        cs = [c for p, *box in b["_regions"] if pages.get(int(p)) for c in pdf_text.chars_in(pages[int(p)], box)] \
            if b.get("_regions") else pdf_text.chars_in(pg, b["_box"])
        e = pdf_text.enrich(b["text"], cs)
        if e.matched < 0.6:
            continue
        if b["type"] == "heading":
            letters = [c for c in cs if c.c.isalpha()]
            if letters:
                half = len(letters) / 2
                b["_sig"] = (round(statistics.median(c.size for c in letters) * 2) / 2,
                             sum(c.bold for c in letters) > half, sum(c.italic for c in letters) > half,
                             e.text.upper() == e.text)
        b["text"] = e.text
        if e.marks:
            b["marks"] = e.marks
        if e.bold_prefix:
            b["_bold"] = e.bold_prefix
    return pages


def _drop_running_heads(blocks: list[dict[str, Any]]) -> None:
    """每页重复的短文字（「Articles」「Author Manuscript」等页眉、侧栏）：三页以上都有的去掉。

    只认页面上下边缘或左右页边里、不带数字的短文字；标准章节名除外（表注「*p < 0.05」这类每页重复的正文要保留）。
    """
    def margin(b: dict[str, Any]) -> bool:
        x = b.get("_box")
        if not x or len(x) < 6:
            return False
        w, h = x[4], x[5]
        return x[3] < h * 0.12 or x[1] > h * 0.88 or x[2] < w * 0.12 or x[0] > w * 0.88

    def key(b: dict[str, Any]) -> str | None:
        if (b["type"] not in ("heading", "paragraph") or len(b["text"].split()) > 8 or re.search(r"\d", b["text"])
                or not margin(b)):
            return None
        t = b["text"].strip(" .:")
        if _TOP_SECTION.match(t) or _ABSTRACT_SUB.match(t):
            return None
        return re.sub(r"\s+", "", t.lower())
    counts: dict[str, set[Any]] = {}
    for b in blocks:
        k = key(b)
        if k:
            counts.setdefault(k, set()).add(b.get("page"))
    repeated = {k for k, pages in counts.items() if len(pages) >= 3}
    if repeated:
        blocks[:] = [b for b in blocks if key(b) not in repeated]


# 段首粗体但不是小节标题的标签：版权页信息、作者贡献（CRediT）、图表与附件编号、脚注
_RUNIN_SKIP = re.compile(
    r"^(?:citation|editors?|academic editor|handling editor|received|revised|accepted|published(?: online)?|copyright|"
    r"data availability(?: statement)?|funding|competing interests?|conflicts? of interests?|keywords?|key ?words|"
    r"abbreviations?|correspondence|corresponding authors?|e-?mail|notes?|sources?|open access|edited by|reviewed by|"
    r"conceptuali[sz]ation|data curation|formal analysis|funding acquisition|investigation|methodology|"
    r"project administration|resources|software|supervision|validation|visuali[sz]ation|writing\b.*|"
    r"author contributions?|how to cite.*|(?:supplementary |s\d+ )(?:file|table|fig(?:ure)?|appendix|data|text|material)s?\b.*|"
    r"(?:table|fig(?:ure)?\.?|图|表)\s*\S+.*)$",
    re.I,
)


_CREDIT_ROLE = re.compile(
    r"\b(?:conceptuali[sz]ation|data curation|formal analysis|funding acquisition|methodology|project administration|"
    r"writing\s*[-–—]\s*(?:original|review))\b",
    re.I,
)


def _split_runin_headings(blocks: list[dict[str, Any]]) -> None:
    """段首小标题（「Eligibility. This study …」：开头一段粗体，以句号或冒号结尾）拆成标题 + 段落。"""
    body = _body_font_size(blocks)
    # 摘要里的「Background: …」「Methods. …」：摘要多是一段带粗体标签的文字，不拆（正文开始 = 第一个「引言 / 背景」标题）
    intro = next((k for k, b in enumerate(blocks) if b["type"] == "heading"
                  and re.match(r"^(?:\d+\.?\s*)?(?:introduction|background)$", b["text"].strip(" .:"), re.I)), None)
    i = 0
    while i < len(blocks):
        b = blocks[i]
        bp = b.get("_bold", 0)
        i += 1
        if b["type"] != "paragraph" or not bp or b.get("_caption"):
            continue
        name0 = b["text"][:bp].strip().rstrip(" .:：。-–—").strip()
        if _ABSTRACT_SUB.match(name0) and ((intro is None and b.get("page") == 1) or (intro is not None and i - 1 < intro)):
            continue
        t = b["text"]
        head, rest = t[:bp].strip(), t[bp:].strip()
        name = head.rstrip(" .:：。").strip()
        if not head or head[-1] not in ".:：。" or not name:
            continue
        if not (1 <= len(name.split()) <= 12 and len(name) <= 100 and len(rest.split()) >= 3):
            continue
        # 作者行、带单位编号的人名：除了开头的章节编号外不能有数字；也不能带上下标
        if re.search(r"\d", re.sub(r"^\d+(?:\.\d+)*\.?\s+", "", name)):
            continue
        if any(m[0] < bp for m in b.get("marks", []) if m[2] != "italic") or _RUNIN_SKIP.match(name):
            continue
        # 作者贡献（「Xiaoqing Jiang: conceptualization, methodology …」）
        if _CREDIT_ROLE.search(rest[:200]):
            continue
        if body and _font_size(t, b.get("_box")) < body * 0.85:
            continue  # 侧栏、脚注里的小字
        off = t.index(rest, bp)
        marks = [[s - off, e - off, k] for s, e, k in b.get("marks", []) if s >= off]
        heading = {"type": "heading", "level": 3, "text": name, "page": b.get("page"), "_box": b.get("_box"), "_runin": True}
        para = {**{k: v for k, v in b.items() if k not in ("_bold", "marks")}, "text": rest}
        if marks:
            para["marks"] = marks
        blocks[i - 1:i] = [heading, para]
        i += 1


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
    _attach_orphan_captions(blocks)


_LABEL_ONLY = re.compile(r"^\s*(?:fig(?:ure)?s?\.?|图)\s*[a-z]?\d+[a-z]?\s*[.:：]?\s*$", re.I)


def _fig_no(caption: str) -> str | None:
    m = _FIG_LABEL.match(caption or "")
    return re.sub(r"\D", "", m.group(0)) if m else None


def _attach_orphan_captions(blocks: list[dict[str, Any]]) -> None:
    """紧挨着规则没挂上的图注：

    - 图注只有图号（「FIG. 1.」）、说明文字在图后另起一段 / 一个列表：并进来；
    - 带图号的图注段落前后都不挨着图（版面顺序把它排到了下一张图前面）：给前面最近的、还没有带图号图注的图
      （原来的「图注」是从图里吸进来的坐标轴文字，换掉），隔着不超过 15 块、页码相差不超过 1。
    """
    for i, b in enumerate(blocks):
        if b["type"] != "figure" or not _LABEL_ONLY.match(b.get("caption") or "") or i + 1 >= len(blocks):
            continue
        n = blocks[i + 1]
        if n.get("page") != b.get("page"):
            continue
        if n["type"] == "paragraph" and not _FIG_LABEL.match(n["text"]) and len(n["text"].split()) <= 120:
            b["caption"] = f"{b['caption'].strip()} {n['text']}"
            n["type"] = "_drop"
        elif n["type"] == "list" and sum(len(t.split()) for t in n["items"]) <= 120:
            b["caption"] = " ".join([b["caption"].strip(), *n["items"]])
            n["type"] = "_drop"
    blocks[:] = [b for b in blocks if b["type"] != "_drop"]

    used = {_fig_no(b.get("caption", "")) for b in blocks if b["type"] == "figure"} - {None}
    i = 0
    while i < len(blocks):
        b = blocks[i]
        no = _fig_no(b["text"]) if b["type"] == "paragraph" and not _TABLE_LABEL.match(b["text"]) else None
        if not no or no in used:
            i += 1
            continue
        target = None
        for k in range(i - 1, max(-1, i - 16), -1):
            f = blocks[k]
            if f["type"] == "figure" and not _fig_no(f.get("caption", "")):
                if b.get("page") and f.get("page") and abs(b["page"] - f["page"]) > 1:
                    break
                target = f
                break
        if target is None:
            i += 1
            continue
        target["caption"] = b["text"]
        used.add(no)
        del blocks[i]


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


def _word_count(t: str) -> int:
    """词数：中日韩文字没有空格，每两个字算一个词。"""
    cjk = len(re.findall(r"[぀-ヿ㐀-鿿가-힯]", t))
    return len(re.sub(r"[぀-ヿ㐀-鿿가-힯]", " ", t).split()) + cjk // 2


def _pick_title(blocks: list[dict[str, Any]], pages: dict[int, Any] | None = None) -> bool:
    """第一页上字号最大、至少 4 个词的标题或段落是论文标题（期刊名、logo 文字通常不足 4 个词），提到最前面。

    版面模型漏掉了标题（文字层里有、却不在任何块里）时，从文字层找回第一页上字号最大的几行。
    """
    body = _body_font_size(blocks)
    best, best_size, best_score = None, 0.0, 0.0
    for i, b in enumerate(blocks):
        if b.get("page") != 1 or b["type"] not in ("heading", "paragraph") or not b.get("_box") or b.get("_caption"):
            continue
        t = b["text"]
        # 至少 4 个词，且不是字母拆开的期刊标志（「W J C C」）
        toks = t.split()
        if (_word_count(t) < 4 or len(t) > 300 or _META_HEADING.search(t)
                or sum(1 for w in toks if len(w) == 1) * 2 >= len(toks) > 1):
            continue
        size = _font_size(t, b["_box"])
        # 期刊名（刊头上的大字）通常只有几个词，论文标题多在 6 个词以上：词少的打折
        score = size * min(1.0, (_word_count(t) + 2) / 10)
        if score > best_score:
            best, best_size, best_score = i, size, score
    found = best is not None and not (body and best_size < body * 1.3)
    lost = _lost_title(blocks, pages, blocks[best] if found else None)
    if lost:
        blocks.insert(0, {"type": "heading", "level": 1, "text": lost[0], "page": 1, "_box": lost[1], "_title": True})
        return True
    if not found:
        return False
    t = blocks.pop(best)  # type: ignore[arg-type]
    blocks.insert(0, {"type": "heading", "level": 1, "text": t["text"], "page": t.get("page"), "_box": t.get("_box"), "_title": True})
    return True


def _lost_title(blocks: list[dict[str, Any]], pages: dict[int, Any] | None, chosen: dict[str, Any] | None) -> tuple[str, list[float]] | None:
    """第一页文字层里字号最大、明显大于正文、没落在任何块里的连续几行（版面模型漏掉的论文标题）。"""
    pg = (pages or {}).get(1)
    if pg is None or not pg.chars:
        return None
    sizes = sorted(c.size for p in pages.values() for c in p.chars if c.c.isalnum())  # type: ignore[union-attr]
    if not sizes:
        return None
    body = sizes[len(sizes) // 2]
    boxes = [b["_box"] for b in blocks if b.get("page") == 1 and b.get("_box")]
    covered = lambda c: any(x[0] - 2 <= (c.l + c.r) / 2 <= x[2] + 2 and x[1] - 2 <= (c.t + c.b) / 2 <= x[3] + 2 for x in boxes)  # noqa: E731
    big = [c for c in pg.chars if c.size >= body * 1.6 and not covered(c)]
    if len(big) < 15:
        return None
    top = max(c.size for c in big)
    if chosen is not None:
        # 已有候选的字号（文字层量的）不比找回的小：不用找回的
        mine = [c for c in pdf_text.chars_in(pg, chosen["_box"]) if c.c.isalnum()]
        if mine and statistics.median(c.size for c in mine) >= top * 0.9:
            return None
    lines: list[list[Any]] = []
    for c in big:
        if c.size < top * 0.9:
            continue
        if lines and abs(c.base - lines[-1][-1].base) < c.size * 0.5:
            lines[-1].append(c)
        elif not lines or c.base - lines[-1][-1].base < c.size * 2.2:
            lines.append([c])
        else:
            break
    chars = [c for ln in lines for c in ln]
    text = "".join((" " if c.space_before and i else "") + c.c for i, c in enumerate(chars)).strip()
    if _word_count(text) < 4 or len(text) > 300:
        return None
    box = [min(c.l for c in chars), min(c.t for c in chars), max(c.r for c in chars), max(c.b for c in chars), pg.width, pg.height]
    return text, box


def _demote_headings(blocks: list[dict[str, Any]]) -> None:
    """不是章节标题的「标题」还原成段落。"""
    body = _body_font_size(blocks)
    # 第一页上、第一个标准章节（摘要 / 引言 / 背景……）之前的标题：期刊名、文章类型、侧栏标签、作者名等版面信息
    first_std = next((i for i, b in enumerate(blocks) if b["type"] == "heading" and not b.get("_title")
                      and (_TOP_SECTION.match(b["text"].strip(" .:")) or _ABSTRACT_SUB.match(b["text"].strip(" .:"))
                           or _NUMBERED.match(b["text"]))), None)
    for i, b in enumerate(blocks):
        if (first_std is not None and i < first_std and b["type"] == "heading" and not b.get("_title") and b.get("page") == 1
                and b.get("_box") and any(x.get("_title") for x in blocks) and not _FRONT_KEEP.match(b["text"].strip(" .:"))):
            b["type"] = "paragraph"
            b.pop("level", None)
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
    is_top = lambda b: not _NUMBERED.match(b["text"]) and bool(_TOP_SECTION.match(_section_name(b["text"])))  # noqa: E731
    sig_order: list[tuple[float, bool, bool, bool]] = []
    body_started = False
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
    prev_level = base  # 上一个非段首小标题的层级
    for b in heads:
        t = b["text"]
        m = _NUMBERED.match(t)
        dl = int(b.get("_dl", 1) or 1)
        if m:
            lvl = base + m.group(1).count(".") + 1
            last_numbered, anchor_dl, last = lvl, None, None
        elif id(b) in in_abstract:
            lvl = base + 2
        elif b.get("_runin"):
            # 段首小标题：放到所在章节的下一级，不改变后面标题的推算
            b["level"] = max(1, min(prev_level + 1, 4))
            continue
        elif canonical and is_top(b):
            lvl = base + 1
            anchor_dl, last, last_numbered = None, None, None
            if _BODY_START.match(_section_name(t)):
                body_started = True
        elif last_numbered is not None:
            # 编号章节里不带编号的小标题：放到上一个编号标题下一级
            lvl = last_numbered + 1
        elif canonical and b.get("_sig") and not body_started:
            lvl = base + 2  # 正文开始前（导读框、侧栏）的小标题：不参与字样排序
        elif canonical and b.get("_sig"):
            # 有文字层的字样（字号、粗斜体、全大写）：同一字样同一层级，先出现的字样层级高
            sig = b["_sig"]
            k = next((x for x, s in enumerate(sig_order) if s[1:] == sig[1:] and abs(s[0] - sig[0]) <= 0.6), None)
            if k is None:
                sig_order.append(sig)
                k = len(sig_order) - 1
            lvl = base + 2 + min(k, 2)
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
        prev_level = b["level"]


def _join_paragraphs(blocks: list[dict[str, Any]]) -> None:
    """句子没写完的段落，与后面以小写字母开头或明显接续的正文段落接上；中间隔着的块留在接好的段落后面。

    可以跨过的块：图、表、图注，以及字号明显比正文小的段落（脚注、表注、作者单位、通讯地址）。
    续段以小写字母开头时还可以跨过标题和列表：换栏时版面顺序可能把下一栏开头的标题、文献表排在续段前面。
    """
    body = _body_font_size(blocks)
    def small(b: dict[str, Any]) -> bool:
        # 字号按块原来的文字与框估一次并记住：接上后半段后框没变、字数变多，再估会偏小
        if "_fs" not in b:
            b["_fs"] = _font_size(b["text"], b.get("_box")) if b.get("_box") else 0.0
        return bool(body and b["_fs"] and b["_fs"] < body * 0.85)
    aside = lambda b: (b["type"] in ("figure", "table") or _is_caption_para(b)  # noqa: E731
                       or (b["type"] == "paragraph" and (small(b) or bool(_TABLE_LABEL.match(b["text"])))))
    cjk = r"[㐀-鿿]"
    i = 0
    while i < len(blocks):
        a = blocks[i]
        ta = a.get("text", "")
        # 行末断开的网址（「https://charls.pku.edu.」+「cn). The …」）句号不算句末
        url_end = bool(re.search(r"(?:https?://|www\.)\S*\.$", ta))
        # 太短的不算正文段落（汉字按两个字符算）
        if (a["type"] != "paragraph" or a.get("_caption") or len(ta) + len(re.findall(cjk, ta)) < 40
                or (_SENT_END.search(ta) and not url_end)
                or small(a)):
            i += 1
            continue
        j, crossed, floats_only = i + 1, False, True
        while j < len(blocks) and j - i <= 8:
            if aside(blocks[j]):
                floats_only = floats_only and blocks[j]["type"] in ("figure", "table")
                j += 1
            elif blocks[j]["type"] in ("heading", "list"):
                crossed, floats_only = True, False
                j += 1
            else:
                break
        if j >= len(blocks) or j - i > 8:
            i += 1
            continue
        nb = blocks[j]
        pa, pb = a.get("page"), nb.get("page")
        # 中间隔着整页的图表时，续段在两页之后
        max_gap = 2 if floats_only and j > i + 1 else 1
        if (nb["type"] != "paragraph" or nb.get("_caption") or len(nb["text"]) < 6 or small(nb)
                or (len(nb["text"].split()) < 3 and not re.match(cjk, nb["text"]))
                or _FIG_LABEL.match(nb["text"]) or _TABLE_LABEL.match(nb["text"])
                or (pa and pb and not 0 <= pb - pa <= max_gap)):
            i += 1
            continue
        tb = nb["text"]
        lower = bool(re.match(r"[a-z(]", tb))
        # 中文：上一段末尾不是句末标点的汉字、下一段以汉字开头
        cjk_cont = bool(re.search(cjk + r"$", ta) and re.match(cjk, tb))
        if url_end and not lower:
            i += 1
            continue
        if not (lower or cjk_cont or (_DANGLING_END.search(ta) and not crossed)):
            i += 1
            continue
        hyphen = ta.endswith("-") and ta[-2:-1].isalpha() and tb[:1].islower()
        joined = ta[:-1] + tb if hyphen else (ta + tb if url_end or cjk_cont else f"{ta} {tb}")
        off = len(joined) - len(tb)
        marks = [m for m in a.get("marks", []) if m[1] <= len(ta) - (1 if hyphen else 0)]
        marks += [[s + off, e + off, k] for s, e, k in nb.get("marks", [])]
        a["text"] = joined
        if marks:
            a["marks"] = marks
        a["_regions"] = _regions(a) + _regions(nb)
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
        extra: dict[str, Any] = {}
        blocks = _postprocess(blocks, pdf_bytes, extra)
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
            # 原版 PDF 视图的映射原料（各页的词）；块上的 src 指向这里的词序号
            **({"source": extra["source"]} if extra.get("source") else {}),
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
