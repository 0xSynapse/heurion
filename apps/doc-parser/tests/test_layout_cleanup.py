"""版面整理（不需要模型）：论文标题、期刊版面标签、标题层级、图注、子图、图里漏出的文字、断开的段落。

块里的 _box 是 [左, 上, 右, 下, 页宽, 页高]（PDF 点，左上原点），由 document_to_blocks 写入、_postprocess 用完删掉。
"""

from __future__ import annotations

import base64
import io
from typing import Any

from src.parser import _postprocess, document_to_blocks, render_crops

W, H = 600.0, 800.0
BODY = "This is ordinary body text of the article that runs long enough to set the typical font size of the page."


def box(l: float, t: float, r: float, b: float) -> list[float]:
    return [l, t, r, b, W, H]


def para(text: str, page: int = 1, b: list[float] | None = None, **kw: Any) -> dict[str, Any]:
    # 默认按正文字号（约 10 点、每字 5 点宽）给框：最宽 400，超出折行
    if b is None:
        width = min(400.0, len(text) * 5.0)
        lines = -(-len(text) * 5 // 400)
        b = box(100, 300, 100 + width, 300 + lines * 10)
    return {"type": "paragraph", "text": text, "page": page, "_box": b, **kw}


def head(text: str, dl: int = 1, page: int = 1, b: list[float] | None = None) -> dict[str, Any]:
    return {"type": "heading", "level": 1, "text": text, "page": page, "_box": b or box(100, 200, 100 + len(text) * 6, 212), "_dl": dl}


def fig(caption: str = "", page: int = 1, b: list[float] | None = None, data: str = "AAAA") -> dict[str, Any]:
    return {"type": "figure", "mime": "image/png", "data": data, "caption": caption, "page": page, "_box": b or box(100, 100, 500, 400)}


def levels(blocks: list[dict[str, Any]]) -> list[tuple[str, int]]:
    return [(b["text"], b["level"]) for b in blocks if b["type"] == "heading"]


def test_title_by_font_size_moves_to_front_and_journal_labels_demoted() -> None:
    blocks = [
        head("OPEN ACCESS", b=box(50, 160, 97, 166)),
        head("REVIEWED BY", b=box(50, 217, 86, 222)),
        # 侧栏里的人名：字号明显小于正文
        head("Lei Lan", b=box(50, 275, 72, 281)),
        head("RE S EARCH ART I CL E", b=box(46, 69, 157, 77)),
        head("Heat therapy for primary dysmenorrhea: a systematic review", b=box(220, 126, 492, 195)),
        head("SophieRoche 1,2 NimeshNaran 1 SuzanneReeves 2", b=box(46, 174, 235, 204)),
        para(BODY), para(BODY), head("Introduction"), para(BODY), head("Methods"), para(BODY), head("Results"),
    ]
    out = _postprocess(blocks)
    assert out[0] == {"type": "heading", "level": 1, "text": "Heat therapy for primary dysmenorrhea: a systematic review", "page": 1}
    assert [t for t, _ in levels(out)] == ["Heat therapy for primary dysmenorrhea: a systematic review", "Introduction", "Methods", "Results"]
    # 版面标签保留为段落（不丢字），私有字段全部删掉
    assert {"OPEN ACCESS", "Lei Lan", "RE S EARCH ART I CL E"} <= {b["text"] for b in out if b["type"] == "paragraph"}
    assert not any(k.startswith("_") for b in out for k in b)


def test_no_title_when_nothing_stands_out() -> None:
    out = _postprocess([para(BODY), head("Introduction"), para(BODY), head("Methods"), head("Results")])
    assert out[0]["type"] == "paragraph"


def test_levels_from_standard_sections_and_docling_font_levels() -> None:
    blocks = [
        head("A Study of Something Important Today", b=box(100, 50, 500, 110)),
        para(BODY),
        head("Abstract"), head("Purpose"), head("Methods"), head("Results"), para(BODY),
        head("Introduction"), para(BODY),
        head("Materials and methods", dl=1), head("Study design", dl=2), head("Outcome variables", dl=2),
        head("Blood pressure", dl=3), head("Statistical analysis", dl=2),
        head("Results", dl=1), head("Participants", dl=1),
        head("Discussion"), head("Author contributions"), head("References"),
    ]
    out = _postprocess(blocks)
    assert levels(out) == [
        ("A Study of Something Important Today", 1),
        ("Abstract", 2), ("Purpose", 3), ("Methods", 3), ("Results", 3),
        ("Introduction", 2),
        ("Materials and methods", 2), ("Study design", 3), ("Outcome variables", 3), ("Blood pressure", 4), ("Statistical analysis", 3),
        ("Results", 2), ("Participants", 3),
        ("Discussion", 2), ("Author contributions", 2), ("References", 2),
    ]


def test_numbered_headings_and_unnumbered_subheading_inside() -> None:
    blocks = [
        head("A Study of Something Important Today", b=box(100, 50, 500, 110)), para(BODY),
        head("1. Introduction"), head("2. Methods"), head("2.4.2. Secondary outcomes"), head("Sleep quality", dl=1), head("3. Results"),
    ]
    assert levels(_postprocess(blocks))[1:] == [("1. Introduction", 2), ("2. Methods", 2), ("2.4.2. Secondary outcomes", 4), ("Sleep quality", 4), ("3. Results", 2)]


def test_captions_attach_to_figures() -> None:
    blocks = [
        para(BODY),
        fig(page=2), para("-41", page=2), para("Fig. 2 Changes in CAVI from baseline.", page=2, _caption=True),
        # 图注在页底、图在下一页顶部
        para("Figure 3 Prevalence of disease.", page=3), fig(page=4),
        # 图与图注之间隔着图内注释
        fig(page=5), para("Included in primary endpoint analysis; no early termination visits.", page=5), para("Fig 4. Flow chart.", page=5),
    ]
    out = _postprocess(blocks)
    assert [b["caption"] for b in out if b["type"] == "figure"] == ["Fig. 2 Changes in CAVI from baseline.", "Figure 3 Prevalence of disease.", "Fig 4. Flow chart."]
    # 坐标轴刻度碎片去掉
    assert all(b.get("text") != "-41" for b in out)


def test_continued_caption_paragraph_appends() -> None:
    out = _postprocess([fig("Fig. 1 | Clamp measurements in type 1 diabetes and", page=3), para("controls during the clamp.", page=3, _caption=True)])
    assert [b["type"] for b in out] == ["figure"]
    assert out[0]["caption"] == "Fig. 1 | Clamp measurements in type 1 diabetes and controls during the clamp."


def test_panels_merge_into_one_figure_falls_back_without_pdf() -> None:
    blocks = [
        fig(page=4, b=box(70, 50, 300, 190), data="A1"),
        fig(page=4, b=box(320, 50, 520, 190), data="A2"),
        fig("Fig. 1 | Clamp measurements.", page=4, b=box(70, 200, 520, 560), data="BIG"),
        fig("Fig. 2 | Another figure.", page=5),
    ]
    out = _postprocess(blocks)
    assert [(b["caption"], b["data"]) for b in out] == [("Fig. 1 | Clamp measurements.", "BIG"), ("Fig. 2 | Another figure.", "AAAA")]


def test_two_labelled_figures_on_one_page_stay_apart() -> None:
    out = _postprocess([fig("Figure 1 A."), fig("Figure 2 B.")])
    assert len(out) == 2


def test_render_crops_cuts_region() -> None:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument.new()
    pdf.new_page(W, H)
    buf = io.BytesIO()
    pdf.save(buf)
    png = render_crops(buf.getvalue(), [(1, [100, 100, 300, 200]), (9, [0, 0, 10, 10])])
    from PIL import Image

    img = Image.open(io.BytesIO(png[0]))  # type: ignore[arg-type]
    # 区域 200×100 点、四边各留 4 点、2 倍缩放
    assert img.size == (416, 216)
    assert png[1] is None


def test_figure_without_image_keeps_caption_as_paragraph() -> None:
    blocks = [{"type": "figure", "mime": "image/png", "data": None, "caption": "FIGURE 3 Forest plot.", "page": 2, "_box": box(50, 80, 550, 650), "_render": True}]
    assert _postprocess(blocks) == [{"type": "paragraph", "text": "FIGURE 3 Forest plot.", "page": 2}]


def test_paragraphs_broken_by_page_or_float_are_joined() -> None:
    blocks = [
        para("Earlier systematic reviews offered valuable insights by suggesting heat therapy might be effective and potentially"),
        fig("Figure 3 Short-term pain relief.", page=1),
        para("comparable to analgesic medication. However, conclusions were constrained."),
        para("A full sentence that ends here with enough words to count as body text."),
        para("Another paragraph starts normally and stays separate from the previous one."),
        para("The modified index assesses eleven symptoms, and the treat-"),
        para("ment response was graded by"),
        para("Two blinded raters scored all cases independently of each other."),
    ]
    out = _postprocess(blocks)
    texts = [b["text"] for b in out if b["type"] == "paragraph"]
    assert texts[0] == ("Earlier systematic reviews offered valuable insights by suggesting heat therapy might be effective and potentially "
                        "comparable to analgesic medication. However, conclusions were constrained.")
    assert texts[1].startswith("A full sentence") and texts[2].startswith("Another paragraph")
    # 断词连字符去掉；以介词结尾的接下一段
    assert texts[3] == "The modified index assesses eleven symptoms, and the treatment response was graded by Two blinded raters scored all cases independently of each other."
    # 图移到接好的段落后面
    assert [b["type"] for b in out][:2] == ["paragraph", "figure"]


def _png(w: int = 40, h: int = 20) -> Any:
    from PIL import Image

    return Image.new("RGB", (w, h), "white")


def test_document_to_blocks_cleans_floats() -> None:
    """用 docling_core 构造带位置的文档：logo 去掉、图注从图里找回、图里的文字不进正文、单格「表格」还原成段落、图表 DOI 去掉、表注跟在表后。"""
    from docling_core.types.doc import (
        BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, ImageRef, ProvenanceItem, Size, TableCell, TableData,
    )

    doc = DoclingDocument(name="t")
    doc.add_page(page_no=1, size=Size(width=W, height=H))
    prov = lambda l, t, r, b: ProvenanceItem(page_no=1, bbox=BoundingBox(l=l, t=t, r=r, b=b, coord_origin=CoordOrigin.TOPLEFT), charspan=(0, 0))  # noqa: E731
    img = lambda: ImageRef.from_pil(_png(), dpi=72)  # noqa: E731

    doc.add_picture(prov=prov(36, 34, 151, 90), image=img())  # 页眉 logo：小、无图注
    pic = doc.add_picture(prov=prov(50, 100, 550, 400), image=img())
    doc.add_text(label=DocItemLabel.TEXT, text="100", parent=pic, prov=prov(60, 120, 80, 130))
    doc.add_text(label=DocItemLabel.SECTION_HEADER, text="FIGURE 2", parent=pic, prov=prov(61, 360, 85, 366))
    doc.add_text(label=DocItemLabel.CAPTION, text="Frailty phenotype and components.", parent=pic, prov=prov(61, 370, 521, 390))
    doc.add_text(label=DocItemLabel.TEXT, text="https://doi.org/10.1371/journal.pone.0327936.g002", prov=prov(50, 405, 300, 412))

    one = TableData(num_rows=1, num_cols=1, table_cells=[TableCell(text="FIGURE 3 Short-term pain relief.", start_row_offset_idx=0, end_row_offset_idx=1, start_col_offset_idx=0, end_col_offset_idx=1)])
    doc.add_table(data=one, prov=prov(50, 420, 550, 440))

    cells = [TableCell(text=t, start_row_offset_idx=r, end_row_offset_idx=r + 1, start_col_offset_idx=c, end_col_offset_idx=c + 1)
             for r, row in enumerate([["Group", "n"], ["A", "12"]]) for c, t in enumerate(row)]
    tbl = doc.add_table(data=TableData(num_rows=2, num_cols=2, table_cells=cells), prov=prov(50, 450, 550, 520))
    note = doc.add_text(label=DocItemLabel.FOOTNOTE, text="BMI, body mass index.", parent=tbl, prov=prov(50, 525, 300, 532))
    tbl.footnotes.append(note.get_ref())
    doc.add_text(label=DocItemLabel.TEXT, text="9", parent=tbl, prov=prov(60, 470, 70, 480))  # 挂在表格下的散字

    blocks, _ = document_to_blocks(doc)
    assert [b["type"] for b in blocks] == ["figure", "paragraph", "table", "paragraph"]
    assert blocks[0]["caption"] == "FIGURE 2 Frailty phenotype and components."
    assert base64.b64decode(blocks[0]["data"])[:4] == b"\x89PNG"
    assert blocks[1]["text"] == "FIGURE 3 Short-term pain relief."
    assert blocks[3]["text"] == "BMI, body mass index."
    assert not any(k.startswith("_") for b in blocks for k in b)
