"""块级后处理（不需要模型）。"""

from src.parser import _postprocess


def test_numbered_items_become_ordered_list() -> None:
    blocks = [{"type": "list", "ordered": False, "start": 1, "items": ["1 Screen", "2 Randomize", "3 Follow up"], "page": 1}]
    out = _postprocess(blocks)
    assert out[0]["ordered"] is True and out[0]["start"] == 1
    assert out[0]["items"] == ["Screen", "Randomize", "Follow up"]


def test_non_consecutive_numbers_stay_unordered() -> None:
    blocks = [{"type": "list", "ordered": False, "start": 1, "items": ["3.5 mg daily", "10 mg weekly"], "page": 1}]
    assert _postprocess(blocks)[0]["ordered"] is False


def test_document_title_pushes_sections_down() -> None:
    h = lambda t, lvl: {"type": "heading", "level": lvl, "text": t, "page": 1}  # noqa: E731
    out = _postprocess([h("A Study Title", 1), h("1. Introduction", 1), {"type": "paragraph", "text": "x", "page": 1}, h("1.1 Aims", 2), h("2. Methods", 1)])
    assert [b["level"] for b in out if b["type"] == "heading"] == [1, 2, 3, 2]


def test_numbered_first_heading_is_not_title() -> None:
    h = lambda t, lvl: {"type": "heading", "level": lvl, "text": t, "page": 1}  # noqa: E731
    out = _postprocess([h("1. Introduction", 1), h("2. Methods", 1), h("3. Results", 1)])
    assert [b["level"] for b in out] == [1, 1, 1]


def test_document_to_blocks_merges_inline_formula_and_skips_furniture() -> None:
    """用 docling_core 直接构造文档（不需要模型）：行内组合并成一段、页眉不输出、表格转网格、题注不重复。"""
    from docling_core.types.doc import ContentLayer, DocItemLabel, DoclingDocument, TableCell, TableData

    from src.parser import document_to_blocks

    doc = DoclingDocument(name="t")
    doc.add_text(label=DocItemLabel.PAGE_HEADER, text="Journal header", content_layer=ContentLayer.FURNITURE)
    doc.add_heading(text="1. Methods", level=1)
    g = doc.add_inline_group()
    doc.add_text(label=DocItemLabel.TEXT, text="The rate is", parent=g)
    doc.add_formula(text="\\alpha = 0.05", parent=g)
    doc.add_text(label=DocItemLabel.TEXT, text="two-sided.", parent=g)
    lst = doc.add_list_group()
    doc.add_list_item(text="first", enumerated=True, marker="1.", parent=lst)
    doc.add_list_item(text="second", enumerated=True, marker="2.", parent=lst)
    cells = [TableCell(text=t, start_row_offset_idx=r, end_row_offset_idx=r + 1, start_col_offset_idx=c, end_col_offset_idx=c + 1, column_header=r == 0)
             for r, row in enumerate([["A", "B"], ["1", "2"]]) for c, t in enumerate(row)]
    cap = doc.add_text(label=DocItemLabel.CAPTION, text="Table 1. Demo.")
    doc.add_table(data=TableData(num_rows=2, num_cols=2, table_cells=cells), caption=cap)
    doc.add_formula(text="E = mc^2")

    blocks, _ = document_to_blocks(doc)
    assert [b["type"] for b in blocks] == ["heading", "paragraph", "list", "table", "formula"]
    assert blocks[1]["text"] == "The rate is $\\alpha = 0.05$ two-sided."
    assert blocks[2]["ordered"] is True and blocks[2]["items"] == ["first", "second"]
    assert blocks[3]["rows"] == [["A", "B"], ["1", "2"]] and blocks[3]["header_rows"] == 1
    assert blocks[3]["caption"] == "Table 1. Demo."
    assert blocks[4]["latex"] == "E = mc^2"
    assert all("Journal header" not in str(b) for b in blocks)
    assert "spans" not in blocks[3]


def test_table_block_keeps_merged_cells() -> None:
    """合并单元格输出 spans；与已有合并区重叠、或盖住有字单元格的合并区丢弃，文字不丢。"""
    from docling_core.types.doc import DoclingDocument, TableCell, TableData

    from src.parser import document_to_blocks

    def cell(t: str, r: int, c: int, rs: int = 1, cs: int = 1, hdr: bool = False) -> TableCell:
        return TableCell(text=t, row_span=rs, col_span=cs, start_row_offset_idx=r, end_row_offset_idx=r + rs,
                         start_col_offset_idx=c, end_col_offset_idx=c + cs, column_header=hdr)

    cells = [
        cell("Characteristic", 0, 0, rs=2, hdr=True), cell("Drug (n = 79)", 0, 1, cs=2, hdr=True), cell("P", 0, 3, rs=2, hdr=True),
        cell("Pre", 1, 1, hdr=True), cell("Post", 1, 2, hdr=True),
        cell("Sex", 2, 0, rs=2), cell("Male", 2, 1), cell("40", 2, 2), cell("0.3", 2, 3),
        cell("Female", 3, 1), cell("39", 3, 2), cell("0.4", 3, 3),
        # 盖住了有字的「0.4」：丢弃合并，只留文字
        cell("Bad", 4, 2, rs=1, cs=2), cell("X", 4, 3),
    ]
    doc = DoclingDocument(name="t")
    doc.add_table(data=TableData(num_rows=5, num_cols=4, table_cells=cells))
    blocks, _ = document_to_blocks(doc)
    t = blocks[0]
    assert t["header_rows"] == 2
    assert t["spans"] == [[0, 0, 2, 1], [0, 1, 1, 2], [0, 3, 2, 1], [2, 0, 2, 1]]
    assert t["rows"][0] == ["Characteristic", "Drug (n = 79)", "", "P"]
    assert t["rows"][4] == ["", "", "Bad", "X"]
