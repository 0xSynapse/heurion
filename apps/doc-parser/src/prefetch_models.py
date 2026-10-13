"""预下载 Docling 模型到本地目录（构建镜像 / 本地开发首次使用前在联网环境运行一次）。

    cd apps/doc-parser && uv run python -m src.prefetch_models            # 默认 data/doc-parser-models
    DOC_PARSER_MODELS_DIR=/models uv run python -m src.prefetch_models     # 指定目录（Dockerfile 用）
    uv run python -m src.prefetch_models --no-formula                      # 不下公式模型（公式识别随之关闭）

下载内容（来源：Hugging Face 上 docling-project 发布的公开模型；RapidOCR 模型来自其官方模型仓库）：
- layout       版面分析（docling-layout-heron）
- tableformer  表格结构（docling-models 里的 TableFormer）
- code_formula 公式识别（CodeFormulaV2，可用 --no-formula 跳过）
- RapidOcr     OCR（PP-OCR 检测 / 识别 / 方向分类，ONNX；扫描页用）

这是整个服务唯一会联网的步骤；服务运行时强制离线。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import settings


def _dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="预下载 Docling 模型")
    ap.add_argument("--output", default=str(settings.MODELS_DIR), help="模型目录（默认 DOC_PARSER_MODELS_DIR 或 data/doc-parser-models）")
    ap.add_argument("--no-formula", action="store_true", help="不下载公式识别模型")
    args = ap.parse_args(argv)

    from docling.utils.model_downloader import download_models

    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    print(f"[prefetch] 下载到 {out}", flush=True)
    download_models(
        output_dir=out,
        force=False,
        progress=True,
        with_layout=True,
        with_tableformer=True,
        with_code_formula=not args.no_formula,
        with_picture_classifier=False,
        with_smolvlm=False,
        with_granite_vision=False,
        with_rapidocr=True,
        with_easyocr=False,
    )

    from .parser import check_models, ensure_models

    ensure_models(out)
    for name, ok in check_models(out).items():
        print(f"[prefetch] {name:13s} {'OK' if ok else '（未下载）'}")
    for sub in sorted(p for p in out.iterdir() if p.is_dir()):
        print(f"[prefetch] {sub.name:40s} {_dir_size(sub) / 1e6:8.1f} MB")
    print(f"[prefetch] 合计 {_dir_size(out) / 1e6:.1f} MB", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
