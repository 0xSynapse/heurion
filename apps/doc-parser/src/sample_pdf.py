"""内置的一页小 PDF（启动预热用）：标题、段落、三行两列表格，纯文字绘制，不依赖外部文件。"""

from __future__ import annotations


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def minimal_pdf(lines: list[tuple[str, float, float, float, bool]] | None = None) -> bytes:
    """lines: (文字, x, y_from_top, 字号, 粗体)。A4 页面，Helvetica。"""
    if lines is None:
        lines = [
            ("Warm-up Document", 72, 90, 20, True),
            ("1. Introduction", 72, 130, 14, True),
            ("This short paragraph is used to load the layout and table models into memory.", 72, 155, 10, False),
            ("Group", 72, 190, 10, True), ("Count", 220, 190, 10, True),
            ("Control", 72, 205, 10, False), ("40", 220, 205, 10, False),
            ("Treatment", 72, 220, 10, False), ("42", 220, 220, 10, False),
        ]
    h = 842
    ops = []
    for text, x, y, size, bold in lines:
        font = "F2" if bold else "F1"
        ops.append(f"BT /{font} {size} Tf {x} {h - y} Td ({_esc(text)}) Tj ET")
    stream = "\n".join(ops).encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)
