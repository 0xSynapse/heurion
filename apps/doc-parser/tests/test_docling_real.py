"""真跑 Docling（需要先预下载模型；没有模型时跳过）。

现场用 reportlab 生成样例 PDF：标题 / 段落 / 无序与有序列表 / 带表头的表格 / 嵌入图片 + 图注 / 公式行，
外加一页「扫描页」（整页是文字的位图，没有文字层）。全程装上网络守卫：任何外连都会让测试失败。
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path

import pytest

from .conftest import needs_models

OUT_DIR = Path(os.environ.get("DOC_PARSER_TEST_OUT", "")) if os.environ.get("DOC_PARSER_TEST_OUT") else None


def _chart_png() -> bytes:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (480, 300), "white")
    d = ImageDraw.Draw(img)
    d.line([(40, 260), (460, 260)], fill="black", width=2)
    d.line([(40, 20), (40, 260)], fill="black", width=2)
    for i, h in enumerate([120, 180, 90, 210]):
        x = 80 + i * 95
        d.rectangle([x, 260 - h, x + 50, 260], fill=(50 + i * 40, 90, 200 - i * 30))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _scanned_page_png() -> bytes:
    """模拟扫描页：把几段英文文字画成位图。"""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("L", (1240, 1754), 255)  # A4 @150dpi
    d = ImageDraw.Draw(img)
    font = None
    for cand in ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if Path(cand).exists():
            font = ImageFont.truetype(cand, 34)
            break
    font = font or ImageFont.load_default(size=34)
    lines = [
        "Scanned Appendix",
        "",
        "The scanned page describes the follow-up schedule.",
        "Patients were contacted every three months after",
        "discharge to record adverse events.",
    ]
    y = 160
    for ln in lines:
        d.text((150, y), ln, fill=0, font=font)
        y += 56
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(scope="module")
def parsed() -> dict:
    from src.parser import Parser

    pdf = _build_pdf()
    p = Parser()
    out = p.parse(pdf, "sample.pdf")
    if OUT_DIR:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / "sample.pdf").write_bytes(pdf)
        slim = {**out, "blocks": [{k: (v[:32] + "…" if k == "data" else v) for k, v in b.items()} for b in out["blocks"]],
                "scanned_pages": [{k: (v[:32] + "…" if k == "data" else v) for k, v in s.items()} for s in out["scanned_pages"]]}
        (OUT_DIR / "sample.json").write_text(json.dumps(slim, ensure_ascii=False, indent=2))
    return out


def _build_pdf() -> bytes:
    """两页样例：第 1 页由 platypus 排版；第 2 页用 canvas 把扫描位图铺满整页。"""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    first = sample_pdf_first_page()
    # 用 canvas 生成扫描页，再把两份 PDF 拼起来（pypdfium2 是 Docling 的依赖）
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.drawImage(ImageReader(io.BytesIO(_scanned_page_png())), 0, 0, width=A4[0], height=A4[1])
    c.showPage()
    c.save()

    import pypdfium2 as pdfium

    dst = pdfium.PdfDocument(first)
    src = pdfium.PdfDocument(buf.getvalue())
    dst.import_pages(src)
    out = io.BytesIO()
    dst.save(out)
    return out.getvalue()


def sample_pdf_first_page() -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import Image, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    ss = getSampleStyleSheet()
    body = ss["BodyText"]
    t = Table([["Group", "N", "Mean age"], ["Control", "40", "61.2"], ["Exercise", "42", "60.8"], ["Total", "82", "61.0"]], colWidths=[4 * cm, 2.5 * cm, 3 * cm])
    t.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
    ]))
    story = [
        Paragraph("Effects of Exercise on Postoperative Recovery", ss["Title"]),
        Paragraph("1. Introduction", ss["Heading1"]),
        Paragraph(
            "Regular physical activity is associated with improved outcomes in patients recovering from surgery. "
            "This study examines the effect of a structured exercise program on recovery time in adults.",
            body,
        ),
        Paragraph("The key aims of the study were:", body),
        ListFlowable([ListItem(Paragraph("Measure recovery time after surgery", body)), ListItem(Paragraph("Compare two exercise programs", body))], bulletType="bullet"),
        Paragraph("1.1 Study steps", ss["Heading2"]),
        ListFlowable([ListItem(Paragraph("Screen eligible patients", body)), ListItem(Paragraph("Randomize to two arms", body)), ListItem(Paragraph("Follow up for six months", body))], bulletType="1"),
        Paragraph("2. Methods", ss["Heading1"]),
        Paragraph("Table 1. Baseline characteristics of the cohort.", body),
        t,
        Spacer(1, 12),
        Paragraph("The body mass index was computed as follows:", body),
        Paragraph("<i>BMI</i> = <i>w</i> / <i>h</i><super>2</super>", ss["Heading3"]),
        Spacer(1, 12),
        Image(io.BytesIO(_chart_png()), width=10 * cm, height=6.25 * cm),
        Paragraph("Figure 1. Recovery time by group.", body),
    ]
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm, topMargin=2 * cm, bottomMargin=2 * cm).build(story)
    return buf.getvalue()


@needs_models
def test_structure(parsed: dict) -> None:
    types = [b["type"] for b in parsed["blocks"]]
    assert parsed["engine"] == "docling"
    assert parsed["page_count"] == 2
    for t in ("heading", "paragraph", "list", "table", "figure"):
        assert t in types, f"缺少 {t}：{types}"

    headings = [b for b in parsed["blocks"] if b["type"] == "heading"]
    assert any("Effects of Exercise" in h["text"] for h in headings)
    assert any(h["text"].startswith("1. Introduction") for h in headings)

    lists = [b for b in parsed["blocks"] if b["type"] == "list"]
    assert any(any("Measure recovery time" in i for i in lst["items"]) for lst in lists)
    steps = next(lst for lst in lists if any("Randomize" in i for i in lst["items"]))
    assert steps["ordered"] is True and steps["items"][0] == "Screen eligible patients"
    levels = {h["text"]: h["level"] for h in headings}
    assert levels["Effects of Exercise on Postoperative Recovery"] == 1
    assert levels["1. Introduction"] == 2 and levels["1.1 Study steps"] == 3

    table = next(b for b in parsed["blocks"] if b["type"] == "table")
    assert len(table["rows"]) == 4 and len(table["rows"][0]) == 3
    assert table["rows"][0][0] == "Group"
    assert table["rows"][2][2] == "60.8"

    fig = next(b for b in parsed["blocks"] if b["type"] == "figure")
    assert fig["data"] and fig["mime"] == "image/png"


@needs_models
def test_scanned_page_is_ocred(parsed: dict) -> None:
    assert [s["page"] for s in parsed["scanned_pages"]] == [2]
    assert parsed["scanned_pages"][0]["ocr"] is True
    text = " ".join(b.get("text", "") for b in parsed["blocks"] if b.get("page") == 2)
    assert "follow-up" in text.lower() or "discharge" in text.lower()


@needs_models
def test_parse_makes_no_network_calls(no_network: list) -> None:
    """离线环境变量 + artifacts_path 下，加载模型并解析都不发起外网连接。"""
    from src import settings
    from src.parser import Parser

    settings.enforce_offline()
    p = Parser()
    out = p.parse(sample_pdf_first_page(), "offline.pdf")
    assert out["blocks"]
    assert no_network == []


def formula_pdf() -> bytes:
    """一页带编号的显示公式（逻辑回归），用 canvas 按排版习惯摆放分式、下标与求和号。"""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    _w, h = A4
    c.setFont("Helvetica-Bold", 14)
    c.drawString(72, h - 80, "2. Model")
    c.setFont("Helvetica", 10)
    c.drawString(72, h - 105, "The logistic model relates the probability of recovery to the covariates as")
    y = h - 150
    c.setFont("Times-Italic", 13)
    c.drawString(200, y, "p")
    c.setFont("Times-Roman", 13)
    c.drawString(212, y, "=")
    c.drawString(250, y + 9, "1")
    c.line(228, y + 5, 330, y + 5)
    c.drawString(230, y - 9, "1 + exp(")
    c.setFont("Times-Italic", 13)
    c.drawString(280, y - 9, "b")
    c.setFont("Times-Roman", 8)
    c.drawString(287, y - 12, "0")
    c.setFont("Times-Roman", 13)
    c.drawString(292, y - 9, "+")
    c.setFont("Times-Italic", 13)
    c.drawString(312, y - 9, "x")
    c.setFont("Times-Italic", 8)
    c.drawString(319, y - 12, "i")
    c.setFont("Times-Roman", 13)
    c.drawString(323, y - 9, ")")
    c.drawString(480, y, "(1)")
    c.setFont("Helvetica", 10)
    c.drawString(72, h - 190, "where p denotes the probability of recovery within 30 days.")
    c.showPage()
    c.save()
    return buf.getvalue()


@needs_models
def test_formula_to_latex() -> None:
    from src import settings
    from src.parser import Parser, check_models

    p = Parser()
    if not (settings.FORMULA and check_models(settings.MODELS_DIR)["code_formula"]):
        pytest.skip("公式识别模型未下载或已关闭")
    out = p.parse(formula_pdf(), "formula.pdf")
    formulas = [b for b in out["blocks"] if b["type"] == "formula"]
    assert formulas, [b["type"] for b in out["blocks"]]
    assert "\\frac" in formulas[0]["latex"]


@needs_models
def test_page_chunking_keeps_absolute_page_numbers(monkeypatch: pytest.MonkeyPatch) -> None:
    """分段解析（每段 1 页）与整篇解析结果一致，页码是全文页码。"""
    from src import settings
    from src.parser import Parser

    pdf = _build_pdf()
    whole = Parser().parse(pdf, "a.pdf")
    monkeypatch.setattr(settings, "PAGE_CHUNK", 1)
    chunked = Parser().parse(pdf, "a.pdf")
    strip = lambda r: [(b["type"], b.get("text"), b.get("level"), b.get("page")) for b in r["blocks"]]  # noqa: E731
    assert strip(chunked) == strip(whole)
    assert chunked["scanned_pages"] == whole["scanned_pages"]
    assert {b["page"] for b in chunked["blocks"]} == {1, 2}
