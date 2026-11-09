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
        # 框的面积按字数算（最后一行不满时也按满行折算），字号估出来都是 10 点
        width = min(400.0, len(text) * 5.0)
        b = box(100, 300, 100 + width, 300 + len(text) * 50.0 / width)
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


# —— 2026-11-09：按 PDF 文字层与扩充评测集补的规则 ——

def test_runin_heading_split_below_current_section() -> None:
    title = head("A randomized trial of something in adults with disease", b=box(100, 60, 500, 110))
    blocks = [
        title, head("Methods"),
        para("Eligibility. This study included adults with suspected tuberculosis at four sites.", _bold=12),
        # 作者贡献：人名后面是 CRediT 角色，不拆
        para("Jane Doe: conceptualization, methodology, writing - original draft.", _bold=9),
        # 带数字（作者行）的不拆
        para("Smith 1,2: this is not a heading at all but an author list line.", _bold=10),
    ]
    blocks[2]["page"] = blocks[3]["page"] = blocks[4]["page"] = 2
    out = _postprocess(blocks)
    assert levels(out)[1:] == [("Methods", 2), ("Eligibility", 3)]
    paras = [b["text"] for b in out if b["type"] == "paragraph"]
    assert paras[0].startswith("This study included") and paras[1].startswith("Jane Doe:") and paras[2].startswith("Smith 1,2")


def test_abstract_labels_are_not_split() -> None:
    blocks = [
        head("A randomized trial of something in adults with disease", b=box(100, 60, 500, 110)),
        para("Background: Ovarian cancer survival remains poor despite many years of chemotherapy research.", _bold=11),
        head("Introduction", page=2),
    ]
    out = _postprocess(blocks)
    assert out[1]["type"] == "paragraph" and out[1]["text"].startswith("Background:")


def test_running_heads_in_margin_dropped_but_repeated_notes_kept() -> None:
    blocks = []
    for p in (1, 2, 3):
        blocks += [head("Articles", page=p, b=box(500, 20, 560, 30)), para(BODY, page=p), para("*p < 0.05.", page=p, b=box(100, 700, 150, 708))]
    out = _postprocess(blocks)
    assert not any(b["text"] == "Articles" for b in out if "text" in b)
    assert sum(1 for b in out if b.get("text") == "*p < 0.05.") == 3


def test_label_only_caption_takes_following_legend_and_orphan_caption_moves_back() -> None:
    blocks = [
        fig("FIG. 1.", page=3, data="AAAA"),
        {"type": "list", "ordered": False, "items": ["a Median time to surgery.", "b Predicted annual time."], "page": 3},
        fig("Age specific vaccination strategy", page=5),  # 吸进来的坐标轴文字，不是图注
        para(BODY, page=5),
        para("Fig. 2: Impact of outbreak response strategies on predicted cases.", page=5),
        fig("Fig. 3: Efficiency of strategies.", page=6),
    ]
    out = _postprocess(blocks)
    figs = [b for b in out if b["type"] == "figure"]
    assert figs[0]["caption"] == "FIG. 1. a Median time to surgery. b Predicted annual time."
    assert figs[1]["caption"].startswith("Fig. 2: Impact")
    assert figs[2]["caption"].startswith("Fig. 3")


def test_rotated_table_is_unrotated() -> None:
    from src.parser import _unrotate_table

    # 原表 3 行 × 2 列，按自下而上排的字读出来是 2 行 × 3 列、行序反过来
    t = {"rows": [["2", "4", "6"], ["1", "3", "5"]], "header_rows": 0, "spans": [[0, 0, 1, 2]]}
    _unrotate_table(t, 270)
    assert t["rows"] == [["1", "2"], ["3", "4"], ["5", "6"]] and t["header_rows"] == 1 and "spans" not in t
    t = {"rows": [["5", "3", "1"], ["6", "4", "2"]], "header_rows": 0}
    _unrotate_table(t, 90)
    assert t["rows"] == [["1", "2"], ["3", "4"], ["5", "6"]]


def test_paragraph_joins_across_full_page_figure_url_and_chinese() -> None:
    blocks = [
        para(BODY), para(BODY),
        para("Notably, when the vaccines protect against both"),
        fig("Fig. 1: Impact.", page=2),
        para("disease and infection, vaccinating older adults was more efficient.", page=3),
        para("Data were obtained from the study website (https://charls.pku.edu.", page=3),
        para("cn). The protocols were approved by the ethics committee.", page=3),
        para("牙周辅助加速成骨正畸治疗是在传统的正畸治疗中加入了切开牙槽骨骨皮质的措施", page=3),
        para("从而达到加速正畸牙移动的目的。", page=4),
    ]
    texts = [b["text"] for b in _postprocess(blocks) if b["type"] == "paragraph"][2:]
    assert texts[0] == "Notably, when the vaccines protect against both disease and infection, vaccinating older adults was more efficient."
    assert texts[1] == "Data were obtained from the study website (https://charls.pku.edu.cn). The protocols were approved by the ethics committee."
    assert texts[2] == "牙周辅助加速成骨正畸治疗是在传统的正畸治疗中加入了切开牙槽骨骨皮质的措施从而达到加速正畸牙移动的目的。"


def test_front_matter_headings_before_first_section_demoted() -> None:
    blocks = [
        head("World Journal of Clinical Cases", b=box(285, 30, 454, 80)),
        head("Observational Study", b=box(55, 210, 148, 220)),
        head("MiRNA-200a and miRNA-200b expression and vitamin-D level in obese patients", b=box(55, 226, 500, 291)),
        para(BODY),
        head("Abstract"),
    ]
    out = _postprocess(blocks)
    assert out[0]["text"].startswith("MiRNA-200a") and out[0]["level"] == 1
    assert [b["text"] for b in out if b["type"] == "heading"][1:] == ["Abstract"]


def test_bold_line_promoted_and_furniture_not_repromoted() -> None:
    blocks = [
        head("A randomized trial of something in adults with disease", b=box(100, 60, 500, 110)),
        head("Introduction"),
        para(BODY, page=2),
        para("Clinical Question", page=2, _allbold=True),
        para(BODY, page=2),
        head("Correspondence to", page=2),
        para(BODY, page=2),
    ]
    blocks[5]["_allbold"] = True
    out = _postprocess(blocks)
    hs = [b["text"] for b in out if b["type"] == "heading"]
    assert "Clinical Question" in hs and "Correspondence to" not in hs


def test_merged_heading_lines_with_different_styles_split() -> None:
    from src.parser import _split_merged_headings

    b = {"type": "heading", "text": "Results Population characteristic", "page": 3,
         "_lines": [("Results", (12.0, True)), ("Population characteristic", (10.0, True))], "_sig": (12.0, True, False, False)}
    wrapped = {"type": "heading", "text": "Influencing factors of global delta-NIHSS", "page": 3,
               "_lines": [("Influencing factors of global", (10.0, True)), ("delta-NIHSS", (10.0, False))]}
    blocks = [b, wrapped]
    _split_merged_headings(blocks)
    assert [x["text"] for x in blocks] == ["Results", "Population characteristic", "Influencing factors of global delta-NIHSS"]
    assert blocks[0]["_sig"][0] == 12.0 and blocks[1]["_sig"][0] == 10.0


def test_abbreviation_definitions_not_split_as_runin() -> None:
    blocks = [
        head("A randomized trial of something in adults with disease", b=box(100, 60, 500, 110)),
        head("Abbreviations"),
        para("AAP: American Academy of Pediatrics", page=2, _bold=4),
        para("Eligibility. This study included adults with suspected tuberculosis at four sites.", page=2, _bold=12),
    ]
    hs = [b["text"] for b in _postprocess(blocks) if b["type"] == "heading"]
    assert "AAP" not in hs and "Eligibility" in hs


def test_clean_removes_line_break_spaces_in_chinese() -> None:
    from src.parser import _clean

    assert _clean("是在传统 的正畸治疗中，加入了 切开牙槽骨 (PAOO) 技术") == "是在传统的正畸治疗中，加入了切开牙槽骨 (PAOO) 技术"
    # 软连字符连同后面换行留下的空白一起去掉
    assert _clean("two physicians indepen­ dently adjudicated") == "two physicians independently adjudicated"
