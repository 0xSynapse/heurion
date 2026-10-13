"""doc-parser 运行配置（环境变量）。

数据不出本机：模型只从本地目录加载，运行时强制 Hugging Face 离线模式；
首次使用前用 `uv run python -m src.prefetch_models` 预下载模型（见 README）。
"""

from __future__ import annotations

import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = APP_DIR.parent.parent

HOST = os.environ.get("DOC_PARSER_HOST", "127.0.0.1")
PORT = int(os.environ.get("DOC_PARSER_PORT", os.environ.get("PORT", "8005")))

# 模型目录：默认放在仓库 data/ 下（已在 .gitignore 里），容器里由 Dockerfile 指到 /models
MODELS_DIR = Path(os.environ.get("DOC_PARSER_MODELS_DIR", str(REPO_ROOT / "data" / "doc-parser-models"))).resolve()

# 单个 PDF 上限（字节）与页数上限
MAX_BYTES = int(os.environ.get("DOC_PARSER_MAX_BYTES", str(80 * 1024 * 1024)))
MAX_PAGES = int(os.environ.get("DOC_PARSER_MAX_PAGES", "400"))

# 公式识别（CodeFormula 模型，CPU 上较慢）；设 0 关闭
FORMULA = os.environ.get("DOC_PARSER_FORMULA", "1") == "1"

# 分段解析：每次只转换这么多页，逐段释放内存。Docling 会在整次转换期间持有所有页的页图，
# 峰值内存随页数线性增长（实测扫描页每页约 +0.7 GB）；分段后峰值只取决于段长。0 = 不分段
PAGE_CHUNK = int(os.environ.get("DOC_PARSER_PAGE_CHUNK", "0"))

# CPU 线程数
THREADS = int(os.environ.get("DOC_PARSER_THREADS", "4"))


def enforce_offline() -> None:
    """运行时禁止任何模型 / 数据下载：Hugging Face 与 transformers 走离线模式。"""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["DO_NOT_TRACK"] = "1"
    os.environ.setdefault("OMP_NUM_THREADS", str(THREADS))
