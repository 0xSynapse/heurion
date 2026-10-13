# Heurion 2.0 PDF 结构化解析服务镜像（Docling，CPU）
# 职责：PDF → 按阅读顺序的标题 / 段落 / 列表 / 表格 / 图 / 公式；扫描页 OCR。
# 模型在构建期下载进镜像（/models），运行期强制离线，不联网。
# 构建上下文是仓库根目录：docker build -f apps/doc-parser/Dockerfile .

FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.5.26 /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=2 \
    DOC_PARSER_THREADS=2 \
    DOC_PARSER_MODELS_DIR=/models \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app/apps/doc-parser

# OpenCV / ONNX Runtime / PyTorch 运行库
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# 1. CPU 版 PyTorch（剥离 CUDA，镜像小几个 GB）
RUN uv venv /opt/venv && \
    uv pip install --no-cache --python /opt/venv/bin/python \
      --index-url https://download.pytorch.org/whl/cpu "torch>=2.2.0" "torchvision"

# 2. 其余依赖（Docling、FastAPI、ONNX Runtime 等，见 pyproject.toml）
COPY apps/doc-parser/pyproject.toml apps/doc-parser/README.md ./
RUN uv pip install --no-cache --python /opt/venv/bin/python -r pyproject.toml

# 3. 代码
COPY apps/doc-parser/src ./src

# 4. 构建期预下载模型（版面、表格结构、RapidOCR，默认也含公式模型）到 /models；这是唯一联网的步骤。
#    HF_HUB_DISABLE_XET=1：Xet 传输在部分网络下会卡住，改用普通 HTTPS 下载。
#    WITH_FORMULA=1（默认）：公式模型（640 MB）也打进镜像，运行时用 DOC_PARSER_FORMULA 开关，
#    以后内存够了（16 GB 机器）改环境变量即可开启，不用重建镜像；镜像体积敏感时用 --build-arg WITH_FORMULA=0。
#    下载器会顺带拉取版面模型的 ONNX 版（171 MB），当前走 PyTorch 引擎用不到（已实测删掉后解析正常），删掉。
ARG WITH_FORMULA=1
RUN HF_HUB_DISABLE_XET=1 python -m src.prefetch_models --output /models $([ "$WITH_FORMULA" = "1" ] || echo --no-formula) && \
    rm -rf /models/docling-project--docling-layout-heron-onnx && \
    chmod -R a+rX /models

# 5. 运行期离线：Hugging Face / transformers 离线模式（代码里也会再设一次）；artifacts_path 指向 /models
ENV HF_HUB_OFFLINE=1 \
    MALLOC_ARENA_MAX=2 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    DOC_PARSER_HOST=0.0.0.0 \
    DOC_PARSER_PORT=8005

RUN useradd -m -u 1000 parser && chown -R parser:parser /app
USER parser
EXPOSE 8005

# 预热完成前 /health 返回 503，start-period 留足模型加载时间
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8005/health')"

CMD ["python", "-m", "src.server"]
