#!/usr/bin/env python3
"""Generate 1200x630 social cards (Open Graph / X summary_large_image) for heurion.org.

Covers the blog, homepage, Aegis OS product/tutorial pages, and the clinical
tools hub. Every card is a real 1200x630 PNG so X never has to guess.

Usage:
    python3 scripts/generate_og_cards.py

Requires `rsvg-convert` (librsvg) and the Noto / Inter / JetBrains Mono fonts.
The generated PNGs are written to apps/site/ and served from /site/<name>.png.
"""

from __future__ import annotations

import html
import subprocess
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "apps" / "site"

PAPER = "#FAF8F4"
INK = "#151C19"
MUTED = "#4A534E"
HAIRLINE = "#D8D2C6"
GREEN = "#0A7D52"
BRIGHT_GREEN = "#00C472"
DARK_PANEL = "#151C19"
PANEL_LINE = "#2B3731"
PANEL_MUTED = "#8FA096"

SERIF_ZH = "Noto Serif CJK SC"
SERIF_EN = "Noto Serif Display"
SANS = "Inter"
SANS_ZH = "Noto Sans CJK SC"
MONO = "JetBrains Mono"


@dataclass
class Card:
    filename: str
    number: str
    category: str
    eyebrow: str
    title_lines: list[str]
    subtitle_lines: list[str]
    metrics: list[tuple[str, str]]
    panel_layers: list[str]
    panel_stat: str
    panel_stat_label: str
    lang: str = "zh"
    title_size: int = 68
    title_line_height: int = 80
    title_y: int = 224
    number_size: int = 148
    top_right: str = "SYSTEMS MONOGRAPH · 2026"
    footer_url: str = "heurion.org/blog"
    footer_cta: str = "READ THE MONOGRAPH  →"


CARDS: list[Card] = [
    Card(
        filename="og-blog-aegis-zh.png",
        number="03",
        category="AEGIS OS",
        eyebrow="AEGIS OS · TRANSACTIONAL AGENT KERNEL",
        title_lines=["超越 Git 分支", "与共享目录"],
        subtitle_lines=["面向代码、文件树与数据流水线的", "多智能体事务协作内核"],
        metrics=[
            ("0.42ms", "写时复制影子派生"),
            ("98.7%", "四级 LCS 自动归并"),
            ("SHA-256", "内容寻址产物总线"),
        ],
        panel_layers=["TRUNK", "SHADOW · A", "SHADOW · B"],
        panel_stat="0.42ms",
        panel_stat_label="COPY-ON-WRITE FORK",
        title_size=72,
    ),
    Card(
        filename="og-blog-aegis-en.png",
        number="03",
        category="AEGIS OS",
        eyebrow="AEGIS OS · TRANSACTIONAL AGENT KERNEL",
        title_lines=["Beyond Git Branches", "& Shared Folders"],
        subtitle_lines=["Shadow workspaces, TTL claims & transactional", "auto-merge across code, files and data pipelines"],
        metrics=[
            ("0.42ms", "Copy-on-Write fork"),
            ("98.7%", "4-tier LCS auto-merge"),
            ("SHA-256", "CAS artifact bus"),
        ],
        panel_layers=["TRUNK", "SHADOW · A", "SHADOW · B"],
        panel_stat="0.42ms",
        panel_stat_label="COPY-ON-WRITE FORK",
        lang="en",
        title_size=64,
        title_line_height=78,
    ),
    Card(
        filename="og-blog-dual-surface-zh.png",
        number="01",
        category="HEURION 2.0",
        eyebrow="HEURION 2.0 · DUAL-SURFACE CRDT",
        title_lines=["为什么自由 Shell 智能体", "写不好科研论文？"],
        subtitle_lines=["双表面 CRDT、字节级 OOXML 补丁", "与 0.128ms 单轮靶向回滚"],
        metrics=[
            ("100%", "未改段落字节保真"),
            ("0.128ms", "单轮靶向回滚"),
            ("99.6%", "输出 Token 节省"),
        ],
        panel_layers=["HUMAN · WYSIWYG", "CRDT · YJS", "AGENT · OPS"],
        panel_stat="100%",
        panel_stat_label="OOXML BYTE IDENTITY",
        title_size=64,
        title_line_height=78,
    ),
    Card(
        filename="og-blog-dual-surface-en.png",
        number="01",
        category="HEURION 2.0",
        eyebrow="HEURION 2.0 · DUAL-SURFACE CRDT",
        title_lines=["Why Free-Form Shell", "Agents Fail at", "Research Manuscripts"],
        subtitle_lines=["Dual-Surface CRDT, byte-preserving OOXML", "and 0.128ms selective rollback"],
        metrics=[
            ("100%", "OOXML byte identity"),
            ("0.128ms", "Selective rollback"),
            ("99.6%", "Output token savings"),
        ],
        panel_layers=["HUMAN · WYSIWYG", "CRDT · YJS", "AGENT · OPS"],
        panel_stat="100%",
        panel_stat_label="OOXML BYTE IDENTITY",
        lang="en",
        title_size=54,
        title_line_height=62,
        title_y=216,
    ),
    Card(
        filename="og-blog-parity-zh.png",
        number="02",
        category="CAPABILITY PARITY",
        eyebrow="HUMAN–AGENT · CAPABILITY PARITY",
        title_lines=["人机权限与", "能力对等"],
        subtitle_lines=["AI 的权限 = 用户的权限", "每个界面能力都有对应的原生工具"],
        metrics=[
            ("100%", "全路由原生工具对等"),
            ("0 Fork", "共享同一套鉴权与审计"),
            ("3-Tier", "自主 / 确认卡 / 人类主权"),
        ],
        panel_layers=["HUMAN · GUI", "MCP · TOOLS", "AUDIT · RBAC"],
        panel_stat="100%",
        panel_stat_label="ROUTE-TO-TOOL PARITY",
        title_size=74,
    ),
    Card(
        filename="og-blog-parity-en.png",
        number="02",
        category="CAPABILITY PARITY",
        eyebrow="HUMAN–AGENT · CAPABILITY PARITY",
        title_lines=["Human-Agent", "Capability Parity"],
        subtitle_lines=["AI permissions equal user permissions.", "Every UI capability becomes a native tool."],
        metrics=[
            ("100%", "Route-to-tool parity"),
            ("0 Fork", "Shared RBAC & audit"),
            ("3-Tier", "Autonomy / confirm / human"),
        ],
        panel_layers=["HUMAN · GUI", "MCP · TOOLS", "AUDIT · RBAC"],
        panel_stat="100%",
        panel_stat_label="ROUTE-TO-TOOL PARITY",
        lang="en",
        title_size=66,
        title_line_height=78,
    ),
    Card(
        filename="og-blog-home-zh.png",
        number="HR",
        category="RESEARCH LAB",
        eyebrow="HEURION RESEARCH · ROTTERDAM",
        title_lines=["系统架构专论", "与工程手记"],
        subtitle_lines=["双表面 CRDT · 人机同权", "Aegis OS 事务级智能体操作系统"],
        metrics=[
            ("03", "双语系统专论"),
            ("ZH / EN", "完整双语版本"),
            ("OPEN", "开源代码与预印本"),
        ],
        panel_layers=["CRDT · DOCS", "PARITY · TOOLS", "AEGIS · OS"],
        panel_stat="03",
        panel_stat_label="SYSTEMS MONOGRAPHS",
        title_size=74,
    ),
    Card(
        filename="og-blog-home-en.png",
        number="HR",
        category="RESEARCH LAB",
        eyebrow="HEURION RESEARCH · ROTTERDAM",
        title_lines=["Systems", "Monographs"],
        subtitle_lines=["Dual-Surface CRDTs · Capability Parity", "and the Aegis OS agent kernel"],
        metrics=[
            ("03", "Bilingual monographs"),
            ("ZH / EN", "Full bilingual editions"),
            ("OPEN", "Code & preprints"),
        ],
        panel_layers=["CRDT · DOCS", "PARITY · TOOLS", "AEGIS · OS"],
        panel_stat="03",
        panel_stat_label="SYSTEMS MONOGRAPHS",
        lang="en",
        title_size=82,
        title_line_height=92,
        title_y=232,
    ),
    Card(
        filename="og-heurion-research.png",
        number="HR",
        category="HEURION RESEARCH",
        eyebrow="SYSTEMS · AGENTS · CLINICAL AI",
        title_lines=["Heurion", "Research"],
        subtitle_lines=["Long-form systems architecture monographs", "from code and documents to transactional agents"],
        metrics=[
            ("CRDT", "Dual-surface documents"),
            ("MCP", "Human-agent parity"),
            ("AEGIS", "Transactional agent OS"),
        ],
        panel_layers=["DOCS", "TOOLS", "KERNEL"],
        panel_stat="HR",
        panel_stat_label="HEURION RESEARCH",
        lang="en",
        title_size=86,
        title_line_height=94,
        title_y=236,
    ),
    Card(
        filename="og-home-zh.png",
        number="HR",
        category="HEURION RESEARCH",
        eyebrow="CLINICAL AI · DOCUMENTS · AGENT OS",
        title_lines=["临床科研 AI 工作台", "与事务型 Agent 内核"],
        subtitle_lines=["Heurion 2.0 & OmniCanvas · Aegis OS", "结构化文档、临床证据与多 Agent 安全运行时"],
        metrics=[
            ("98.6%", "PHI 脱敏召回"),
            ("0.128ms", "单轮靶向回滚"),
            ("0.0%", "沙箱逃逸攻击 ASR"),
        ],
        panel_layers=["DOCS · CRDT", "EVIDENCE · PUBMED", "AGENTS · AEGIS"],
        panel_stat="2.0",
        panel_stat_label="HEURION 2.0",
        title_size=66,
        title_line_height=78,
        top_right="HEURION.ORG · 2026",
        footer_url="heurion.org",
        footer_cta="EXPLORE HEURION.ORG  →",
    ),
    Card(
        filename="og-home-en.png",
        number="HR",
        category="HEURION RESEARCH",
        eyebrow="CLINICAL AI · DOCUMENTS · AGENT OS",
        title_lines=["Clinical Research AI", "& Agent OS Runtime"],
        subtitle_lines=["Heurion 2.0 & OmniCanvas · Aegis OS", "Structured documents, evidence & safe agent runtime"],
        metrics=[
            ("98.6%", "PHI de-identification"),
            ("0.128ms", "Selective rollback"),
            ("0.0%", "Sandbox escape ASR"),
        ],
        panel_layers=["DOCS · CRDT", "EVIDENCE · PUBMED", "AGENTS · AEGIS"],
        panel_stat="2.0",
        panel_stat_label="HEURION 2.0",
        lang="en",
        title_size=62,
        title_line_height=76,
        top_right="HEURION.ORG · 2026",
        footer_url="heurion.org",
        footer_cta="EXPLORE HEURION.ORG  →",
    ),
    Card(
        filename="og-aegis-os-zh.png",
        number="AOS",
        category="AGENT SECURITY CONTROL PLANE",
        eyebrow="AEGIS OS · AGENT SECURITY CONTROL PLANE",
        title_lines=["Aegis OS", "多 Agent 安全控制平面"],
        subtitle_lines=["隔离 · 协作 · 同意 · 撤销 · 审计", "本地与 64GB 云端沙箱并行运行多个 Agent"],
        metrics=[
            ("0.0%", "80 项逃逸攻击 ASR"),
            ("90.7–97.9%", "授权弹窗消除"),
            ("0.42ms", "CoW 影子工作区"),
        ],
        panel_layers=["SANDBOX", "POLICY", "AUDIT"],
        panel_stat="0.0%",
        panel_stat_label="ATTACK SUCCESS RATE",
        title_size=58,
        title_line_height=72,
        title_y=220,
        number_size=92,
        top_right="HEURION.ORG · 2026",
        footer_url="heurion.org/aegis-os",
        footer_cta="EXPLORE AEGIS OS  →",
    ),
    Card(
        filename="og-aegis-os-en.png",
        number="AOS",
        category="AGENT SECURITY CONTROL PLANE",
        eyebrow="AEGIS OS · AGENT SECURITY CONTROL PLANE",
        title_lines=["Aegis OS", "Multi-Agent Control Plane"],
        subtitle_lines=["Isolation · collaboration · consent · revocation · audit", "Run agents locally or in 64GB cloud sandboxes"],
        metrics=[
            ("0.0%", "80-vector escape ASR"),
            ("90.7–97.9%", "Prompt reduction"),
            ("0.42ms", "CoW shadow workspace"),
        ],
        panel_layers=["SANDBOX", "POLICY", "AUDIT"],
        panel_stat="0.0%",
        panel_stat_label="ATTACK SUCCESS RATE",
        lang="en",
        title_size=54,
        title_line_height=70,
        title_y=220,
        number_size=92,
        top_right="HEURION.ORG · 2026",
        footer_url="heurion.org/aegis-os",
        footer_cta="EXPLORE AEGIS OS  →",
    ),
    Card(
        filename="og-tools-zh.png",
        number="07",
        category="STATELESS CLINICAL UTILITIES",
        eyebrow="HEURION RESEARCH · NO LOGIN REQUIRED",
        title_lines=["临床科研", "免登录在线工具"],
        subtitle_lines=["E-value · CONSORT / STROBE · Table 1", "PubMed 核验 · 生存曲线 · 森林图 · PHI 扫描"],
        metrics=[
            ("07", "免登录工具"),
            ("0", "注册 / 上传留存"),
            ("DOCX", "发表级原生导出"),
        ],
        panel_layers=["E-VALUE", "TABLE 1", "PHI SCAN"],
        panel_stat="07",
        panel_stat_label="STATELESS UTILITIES",
        title_size=74,
        top_right="HEURION.ORG · 2026",
        footer_url="heurion.org/tools",
        footer_cta="OPEN THE TOOLBOX  →",
    ),
    Card(
        filename="og-tools-en.png",
        number="07",
        category="STATELESS CLINICAL UTILITIES",
        eyebrow="HEURION RESEARCH · NO LOGIN REQUIRED",
        title_lines=["Clinical Research", "Free Online Tools"],
        subtitle_lines=["E-value · CONSORT / STROBE · Table 1", "PubMed checker · Kaplan-Meier · Forest plots"],
        metrics=[
            ("07", "No-login tools"),
            ("0", "Uploads retained"),
            ("DOCX", "Publication-grade export"),
        ],
        panel_layers=["E-VALUE", "TABLE 1", "PHI SCAN"],
        panel_stat="07",
        panel_stat_label="STATELESS UTILITIES",
        lang="en",
        title_size=66,
        title_line_height=78,
        top_right="HEURION.ORG · 2026",
        footer_url="heurion.org/tools",
        footer_cta="OPEN THE TOOLBOX  →",
    ),
]


def esc(value: str) -> str:
    return html.escape(value, quote=True)


def text(
    x: float,
    y: float,
    value: str,
    *,
    size: int,
    fill: str,
    family: str = SANS,
    weight: int = 400,
    spacing: float | None = None,
    anchor: str = "start",
    opacity: float | None = None,
) -> str:
    attrs = [
        f'x="{x:g}"',
        f'y="{y:g}"',
        f'fill="{fill}"',
        f'font-family="{family}"',
        f'font-size="{size}"',
        f'font-weight="{weight}"',
        f'text-anchor="{anchor}"',
    ]
    if spacing is not None:
        attrs.append(f'letter-spacing="{spacing:g}"')
    if opacity is not None:
        attrs.append(f'opacity="{opacity:g}"')
    return f'<text {" ".join(attrs)}>{esc(value)}</text>'


def logo(x: float, y: float) -> str:
    return f"""
    <g transform="translate({x:g} {y:g})">
      <rect x="0" y="6" width="9" height="26" rx="4.5" fill="{INK}"/>
      <rect x="27" y="14" width="9" height="18" rx="4.5" fill="{INK}"/>
      <rect x="7" y="17" width="22" height="8" rx="4" fill="{GREEN}"/>
      <circle cx="31.5" cy="5" r="4.5" fill="{BRIGHT_GREEN}"/>
    </g>"""


def render_svg(card: Card) -> str:
    title_family = SERIF_ZH if card.lang == "zh" else SERIF_EN
    body_family = f'{SANS}, {SANS_ZH}' if card.lang == "zh" else SANS

    # Main title
    title_svg = []
    for i, line in enumerate(card.title_lines):
        title_svg.append(
            text(
                64,
                card.title_y + i * card.title_line_height,
                line,
                size=card.title_size,
                fill=INK,
                family=title_family,
                weight=600,
            )
        )

    subtitle_y = card.title_y + (len(card.title_lines) - 1) * card.title_line_height + 46
    subtitle_svg = []
    for i, line in enumerate(card.subtitle_lines):
        subtitle_svg.append(
            text(64, subtitle_y + i * 34, line, size=22, fill=MUTED, family=body_family, weight=400)
        )

    # Keep metrics anchored to the bottom, but push them down when a 3-line
    # English title needs more vertical room.
    metrics_top = max(
        438,
        subtitle_y + (len(card.subtitle_lines) - 1) * 34 + 38,
    )
    metric_svg = [
        f'<line x1="64" y1="{metrics_top}" x2="120" y2="{metrics_top}" stroke="{GREEN}" stroke-width="2"/>',
        f'<line x1="120" y1="{metrics_top}" x2="816" y2="{metrics_top}" stroke="{HAIRLINE}" stroke-width="1"/>',
    ]
    for i, (value, label) in enumerate(card.metrics):
        x = 64 + i * 254
        metric_svg.append(
            text(x, metrics_top + 46, value, size=30, fill=INK, family=MONO, weight=600)
        )
        metric_svg.append(
            text(x, metrics_top + 72, label, size=13, fill=MUTED, family=body_family, weight=400)
        )
        if i > 0:
            metric_svg.append(
                f'<line x1="{x - 24}" y1="{metrics_top + 20}" x2="{x - 24}" y2="{metrics_top + 76}" stroke="{HAIRLINE}" stroke-width="1"/>'
            )

    # Right panel: a tiny stack diagram that reads as trunk + shadow workspaces.
    layer_svg = []
    for i, label in enumerate(card.panel_layers):
        x = 920 + i * 14
        y = 300 + i * 54
        width = 240 - i * 14
        is_last = i == len(card.panel_layers) - 1
        fill = "#233E33" if i == 0 else DARK_PANEL
        stroke = BRIGHT_GREEN if is_last else "#3A4A42"
        label_fill = BRIGHT_GREEN if is_last else (PAPER if i == 0 else PANEL_MUTED)
        layer_svg.append(
            f'<rect x="{x}" y="{y}" width="{width}" height="46" rx="5" fill="{fill}" stroke="{stroke}" stroke-width="1"/>'
        )
        layer_svg.append(
            text(x + 16, y + 29, label, size=11, fill=label_fill, family=MONO, weight=500, spacing=1)
        )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="{PAPER}"/>

  <!-- editorial grid, barely visible -->
  <g opacity="0.035" stroke="{INK}" stroke-width="1">
    <line x1="64" y1="0" x2="64" y2="630"/>
    <line x1="816" y1="0" x2="816" y2="630"/>
    <line x1="0" y1="108" x2="816" y2="108"/>
  </g>

  <!-- right panel -->
  <rect x="880" y="0" width="320" height="630" fill="{DARK_PANEL}"/>
  <rect x="880" y="0" width="3" height="630" fill="{BRIGHT_GREEN}"/>
  <circle cx="1132" cy="54" r="126" fill="{BRIGHT_GREEN}" opacity="0.045"/>

  {logo(64, 48)}
  {text(112, 62, "Heurion Research", size=22, fill=INK, family=SANS, weight=600)}
  {text(112, 82, "ENGINEERING & SYSTEMS", size=9, fill=MUTED, family=MONO, weight=400, spacing=1.4)}
  {text(816, 62, card.top_right, size=10, fill=MUTED, family=MONO, weight=400, spacing=1.2, anchor="end")}

  <line x1="64" y1="108" x2="816" y2="108" stroke="{HAIRLINE}" stroke-width="1"/>

  <rect x="64" y="146" width="8" height="8" fill="{GREEN}"/>
  {text(84, 155, card.eyebrow, size=12, fill=GREEN, family=MONO, weight=500, spacing=1.5)}

  {''.join(title_svg)}
  {''.join(subtitle_svg)}
  {''.join(metric_svg)}

  {text(64, 586, "Hui Zhao (@0xSynapse)", size=12, fill=MUTED, family=MONO, weight=400)}
  {text(292, 586, card.footer_url, size=12, fill=GREEN, family=MONO, weight=500)}
  {text(816, 586, card.footer_cta, size=10, fill=GREEN, family=MONO, weight=500, spacing=1.3, anchor="end")}

  {text(920, 64, "NO.", size=11, fill=PANEL_MUTED, family=MONO, weight=400, spacing=3)}
  {text(914, 198, card.number, size=card.number_size, fill=BRIGHT_GREEN, family=SERIF_EN, weight=600)}
  {text(920, 230, card.category, size=10, fill=PAPER, family=MONO, weight=400, spacing=1.6)}

  <line x1="920" y1="254" x2="1160" y2="254" stroke="{PANEL_LINE}" stroke-width="1"/>
  {''.join(layer_svg)}

  <line x1="920" y1="494" x2="1160" y2="494" stroke="{PANEL_LINE}" stroke-width="1"/>
  {text(920, 548, card.panel_stat, size=44, fill=PAPER, family=SANS, weight=600)}
  {text(920, 572, card.panel_stat_label, size=9, fill=PANEL_MUTED, family=MONO, weight=400, spacing=1.2)}
</svg>
"""
    return svg


def main() -> None:
    missing = [card.filename for card in CARDS if not card.filename]
    assert not missing
    for card in CARDS:
        svg_path = OUT_DIR / f".{card.filename}.svg"
        png_path = OUT_DIR / card.filename
        svg_path.write_text(render_svg(card), encoding="utf-8")
        subprocess.run(
            [
                "rsvg-convert",
                "--width",
                "1200",
                "--height",
                "630",
                "--format",
                "png",
                "--output",
                str(png_path),
                str(svg_path),
            ],
            check=True,
        )
        svg_path.unlink()
        size_kb = png_path.stat().st_size / 1024
        print(f"wrote {png_path.relative_to(ROOT)} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
