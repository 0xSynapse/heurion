"""PDF 文字层（pdf_text.py）：逐字读取、上下标与粗体、竖排、页面旋转，以及按文字层修 Docling 的块文字。"""

from __future__ import annotations

import io

from src import pdf_text as T
from src.pdf_text import Char


def _pdf() -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    # 第 1 页：段首粗体小标题、上标引用、两个词之间只有间隔没有空格、行末区间短横
    c.setFont("Helvetica-Bold", 10)
    c.drawString(72, 760, "Eligibility.")
    c.setFont("Helvetica", 10)
    c.drawString(130, 760, "This study included adults with suspected tuberculosis.")
    c.drawString(72, 740, "associated with risk")
    x = 72 + c.stringWidth("associated with risk", "Helvetica", 10)
    c.setFont("Helvetica", 6)
    c.drawString(x, 744, "3,4")
    x += c.stringWidth("3,4", "Helvetica", 6)
    c.setFont("Helvetica", 10)
    c.drawString(x, 740, ". Next sentence follows here.")
    c.drawString(72, 720, "Other")
    c.drawString(106, 720, "Menopausal")
    c.drawString(72, 700, "prevalence 17.1% (95% CI, 8.8–")
    c.drawString(72, 688, "30.6%) in the cohort overall")
    c.showPage()
    # 第 2 页：竖排印刷的表（字自下而上）
    c.saveState()
    c.translate(300, 100)
    c.rotate(90)
    c.setFont("Helvetica", 9)
    for k in range(24):
        c.drawString(0, -k * 14, f"Row {k} value 1.{k % 10}{k % 10} (0.{k % 10}-2.{k % 10}) p = 0.0{k % 10}")
    c.restoreState()
    c.showPage()
    # 第 3 页：页面属性设成横向（/Rotate 90），字在显示方向上是正的
    c.setPageRotation(90)
    c.saveState()
    c.translate(A4[0], 0)
    c.rotate(90)
    c.setFont("Helvetica", 10)
    c.drawString(72, 500, "Landscape table caption text here")
    c.restoreState()
    c.showPage()
    c.save()
    return buf.getvalue()


PDF = _pdf()
PAGES = T.extract(PDF)


def _line(page: T.Page, y_min: float, y_max: float) -> list[Char]:
    return [c for c in page.chars if y_min <= (c.t + c.b) / 2 <= y_max]


def test_extract_reads_bold_superscript_and_gaps() -> None:
    p1 = PAGES[1]
    first = _line(p1, 70, 90)
    assert "".join(c.c for c in first).startswith("Eligibility.This")
    assert all(c.bold for c in first[:12]) and not any(c.bold for c in first[13:])
    sup = [c for c in _line(p1, 85, 110) if c.script == "sup"]
    assert "".join(c.c for c in sup) == "3,4"
    other = _line(p1, 115, 130)
    m = next(c for c in other if c.c == "M")
    assert m.space_before  # 「Other」与「Menopausal」之间只有间隔


def test_rotation_and_page_rotate() -> None:
    assert T.rotation(PAGES[2].chars) in (90, 270)
    p3 = PAGES[3]
    assert T.rotation(p3.chars) == 0
    # 换算到显示方向后字在页面范围内，且从左到右排
    xs = [c.l for c in p3.chars]
    assert all(0 <= c.l <= p3.width and 0 <= c.t <= p3.height for c in p3.chars)
    assert xs == sorted(xs)


def test_enrich_fixes_docling_text() -> None:
    p1 = PAGES[1]
    # 段首粗体
    e = T.enrich("Eligibility. This study included adults with suspected tuberculosis.", _line(p1, 70, 90))
    assert e.text.startswith("Eligibility. This") and e.text[:e.bold_prefix] == "Eligibility."
    # 上标两边 Docling 加的空格去掉，标成上标
    e = T.enrich("associated with risk 3,4 . Next sentence follows here.", _line(p1, 85, 110))
    assert "risk3,4. Next" in e.text
    s, t, kind = next(m for m in e.marks if m[2] == "sup")
    assert e.text[s:t] == "3,4"
    # 丢掉的空格补回
    assert T.enrich("OtherMenopausal", _line(p1, 115, 130)).text == "Other Menopausal"
    # 行末区间短横被 Docling 当成断词去掉：补回
    e = T.enrich("prevalence 17.1% (95% CI, 8.830.6%) in the cohort overall", _line(p1, 135, 160))
    assert "8.8–30.6%" in e.text


def _chars(spec: list[tuple[str, float, bool]], y: float = 100.0) -> list[Char]:
    """合成字：(字, 左边位置, 是否另起一行)；每字宽 5、字号 10，间隔超过 1.8 记为有空白。"""
    out: list[Char] = []
    last_r = None
    for ch, x, nl in spec:
        yy = y + (12 if nl else 0)
        gap = last_r is not None and x - last_r > 1.8
        out.append(Char(ch, x, yy, x + 5, yy + 10, False, False, 10.0, yy + 8, space_before=gap or nl, newline_before=nl))
        last_r = x + 5
        y = yy
    return out


def test_letter_spaced_words_are_not_split() -> None:
    # 「T A B L E」每个字之间都有间隔：不补空格
    cs = _chars([(c, 10 + k * 9, False) for k, c in enumerate("TABLE")] + [("2", 70, False)])
    assert T.enrich("TABLE 2", cs).text == "TABLE 2"


def test_soft_hyphen_line_break_is_joined() -> None:
    # 「dia-」行末的软连字符（pdfium 记作 \x02）：Docling 留下「dia- betes」，接成一个词
    spec = [(c, 10 + k * 5, False) for k, c in enumerate("dia")] + [("­", 25, False)]
    spec += [(c, 10 + k * 5, k == 0) for k, c in enumerate("betes")]
    assert T.enrich("dia- betes", _chars(spec)).text == "diabetes"


def test_source_map_aligns_block_text_to_pdf_words() -> None:
    from src.parser import _postprocess

    line = _line(PAGES[1], 70, 90)
    box = [min(c.l for c in line) - 1, min(c.t for c in line) - 1, max(c.r for c in line) + 1, max(c.b for c in line) + 1, 595.0, 842.0]
    blocks = [{"type": "paragraph", "text": "Eligibility. This study included adults with suspected tuberculosis.", "page": 1, "_box": box}]
    out: dict = {}
    res = _postprocess(blocks, PDF, out)
    words = out["source"]["words"]
    assert len(out["source"]["pages"]) == 3 and any(w[5] == "Eligibility." for w in words)
    # 只有这一块时它被当成论文标题；块文字逐词对齐到原版的词
    b = res[0]
    assert [words[w][5] for _, _, w in b["src"]["spans"]][:3] == ["Eligibility.", "This", "study"]
    s, e, w = b["src"]["spans"][1]
    assert b["text"][s:e] == "This" and b["src"]["regions"][0][0] == 1


def test_rotated_pages_are_normalized() -> None:
    from src.parser import normalize_rotation

    fixed, rot = normalize_rotation(PDF)
    assert rot == {2: 90}
    assert T.rotation(T.extract(fixed, {2})[2].chars) == 0
    assert normalize_rotation(fixed)[1] == {}  # 已经转正的不再转


def test_compound_hyphen_restored_only_for_real_compounds() -> None:
    spec = [(c, 10 + k * 5, False) for k, c in enumerate("well")] + [("­", 30, False)]
    spec += [(c, 10 + k * 5, k == 0) for k, c in enumerate("trained")]
    cs = _chars(spec)
    assert T.enrich("welltrained staff", cs, vocab={"well", "trained", "staff"}).text.startswith("well-trained")
    assert T.enrich("welltrained staff", cs, vocab={"staff"}).text.startswith("welltrained")
    assert T.enrich("welltrained staff", cs, vocab={"well-trained"}).text.startswith("well-trained")


def _cell_chars(lines: list[tuple[str, float, float]]) -> list[Char]:
    """合成单元格里的字：(文字, 左边位置, 基线)；每字宽 4、字号 8。"""
    out: list[Char] = []
    for text, x, base in lines:
        for k, ch in enumerate(text):
            if ch == " ":
                continue
            out.append(Char(ch, x + k * 4, base - 7, x + k * 4 + 4, base + 1, False, False, 8.0, base,
                            space_before=k > 0 and text[k - 1] == " ", newline_before=k == 0))
    return out


def test_merged_table_rows_split_by_label_lines() -> None:
    from src.parser import _split_merged_rows

    pg = T.Page(1, 600, 800, _cell_chars([("Male", 10, 110), ("Female", 10, 122), ("12 (3.0)", 60, 110), ("15 (4.1)", 60, 122)]))
    t = {"rows": [["Sex", "n (%)"], ["Male Female", "12 (3.0) 15 (4.1)"]], "header_rows": 1,
         "_cells": [[0, 0, [5, 80, 55, 95]], [0, 1, [55, 80, 120, 95]], [1, 0, [5, 100, 55, 125]], [1, 1, [55, 100, 120, 125]]]}
    _split_merged_rows(t, pg)
    assert t["rows"] == [["Sex", "n (%)"], ["Male", "12 (3.0)"], ["Female", "15 (4.1)"]]
    # 「数值一行、区间一行」不拆
    pg2 = T.Page(1, 600, 800, _cell_chars([("Waist", 10, 110), ("circumference", 10, 122), ("1.05", 80, 110), ("(0.67, 1.66)", 80, 122)]))
    t2 = {"rows": [["Item", "OR"], ["Waist circumference", "1.05 (0.67, 1.66)"]], "header_rows": 1,
          "_cells": [[1, 0, [5, 100, 75, 125]], [1, 1, [75, 100, 140, 125]]]}
    _split_merged_rows(t2, pg2)
    assert len(t2["rows"]) == 2


def test_table_cells_keep_spaces_around_superscripts() -> None:
    # 单元格（scripts=False）：不去上标两边的空格，也不给格式
    p1 = PAGES[1]
    e = T.enrich("associated with risk 3,4 . Next sentence follows here.", _line(p1, 85, 110), scripts=False)
    assert "risk 3,4 ." in e.text and e.marks == [] and e.bold_prefix == 0
