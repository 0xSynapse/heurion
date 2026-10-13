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


# —— DoclingDocument → 块 ——

_NUMBERED = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+\S")
_ORDERED_MARKER = re.compile(r"^\(?(\d{1,3})[.)、）]?$")


def _page_of(item: Any) -> int | None:
    prov = getattr(item, "prov", None)
    return prov[0].page_no if prov else None


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
    for cell in data.table_cells:
        r, c = int(cell.start_row_offset_idx), int(cell.start_col_offset_idx)
        if 0 <= r < nr and 0 <= c < nc:
            rows[r][c] = _clean(cell.text)
            if getattr(cell, "column_header", False):
                header_rows.add(r)
    # 表头行：从第 0 行起连续的列表头行
    h = 0
    while h in header_rows:
        h += 1
    caption = _clean(item.caption_text(doc)) if hasattr(item, "caption_text") else ""
    return {"type": "table", "rows": rows, "header_rows": h, "caption": caption, "page": _page_of(item)}


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
            for ref in getattr(it, "captions", []) or []:
                caption_refs.add(ref.cref)

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
            blocks.append(_table_block(item, doc))
        elif isinstance(item, PictureItem):
            data = _image_b64(item.get_image(doc))
            caption = _clean(item.caption_text(doc))
            if data is None:
                warnings.append(f"第 {_page_of(item)} 页有一张图片未能提取")
                continue
            blocks.append({"type": "figure", "mime": "image/png", "data": data, "caption": caption, "page": _page_of(item)})
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
                blocks.append({"type": "heading", "level": 1, "text": text, "page": _page_of(item)})
        elif isinstance(item, SectionHeaderItem):
            text = _clean(item.text)
            if text:
                blocks.append({"type": "heading", "level": _heading_level(text, int(item.level), has_title), "text": text, "page": _page_of(item)})
        elif isinstance(item, TextItem):
            if item.self_ref in caption_refs:
                continue
            if item.label in (DocItemLabel.PAGE_HEADER, DocItemLabel.PAGE_FOOTER):
                continue
            text = _clean(item.text)
            if text:
                blocks.append({"type": "paragraph", "text": text, "page": _page_of(item)})
    flush()
    for b in blocks:
        b.pop("ref", None)
    return (_postprocess(blocks) if post else blocks), warnings


_ITEM_NUMBER = re.compile(r"^(\d{1,3})[.)、]?\s+(?=\S)")


def _postprocess(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """版面模型给出的结构做两处修正。

    1. 列表：Docling 没识别出编号、但每项都以连续数字开头（「1 xxx」「2 xxx」）时改成有序列表并去掉编号。
    2. 标题：第一页开头的、不带编号的第一个标题视为文档标题（1 级），其余标题整体下移一级——
       否则「论文标题」与「1. Introduction」会同为 1 级。只在后面还有 ≥2 个 1 级标题时这样处理。
    """
    for b in blocks:
        if b["type"] != "list" or b["ordered"] or len(b["items"]) < 2:
            continue
        nums = [_ITEM_NUMBER.match(t) for t in b["items"]]
        if all(nums) and all(int(m.group(1)) == int(nums[0].group(1)) + i for i, m in enumerate(nums)):  # type: ignore[union-attr]
            b["ordered"] = True
            b["start"] = int(nums[0].group(1))  # type: ignore[union-attr]
            b["items"] = [t[m.end():] for t, m in zip(b["items"], nums)]  # type: ignore[union-attr]

    first = next((i for i, b in enumerate(blocks) if b["type"] == "heading"), None)
    if first is not None:
        h = blocks[first]
        body_before = any(b["type"] in ("paragraph", "list", "table") for b in blocks[:first])
        rest = [b for b in blocks[first + 1:] if b["type"] == "heading"]
        if (h.get("page") in (1, None) and not body_before and not _NUMBERED.match(h["text"]) and h["level"] == 1
                and sum(1 for b in rest if b["level"] == 1) >= 2):
            for b in rest:
                b["level"] = min(b["level"] + 1, 4)
    return blocks


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
        blocks = _postprocess(blocks)
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
