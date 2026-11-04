# Heurion 2.0 医学影像微服务镜像 (MONAI & PyTorch CPU 优化版)
# 职责：3D 卷积分割、气道血管匹配、支气管扩张量化、粘液栓定位、RECIST 1.1 靶病灶测量
# 构建上下文是仓库根目录：docker build -f apps/imaging-worker/Dockerfile .

FROM python:3.12-slim-bookworm

# 复制官方 uv 二进制工具以实现极速依赖安装
COPY --from=ghcr.io/astral-sh/uv:0.6.5 /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8004 \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    VECLIB_MAXIMUM_THREADS=2 \
    NUMEXPR_NUM_THREADS=2 \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# 0. 安装系统字体（支持中文医学 HUD 标注与标尺绘制）
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-dejavu-core fonts-wqy-microhei && \
    rm -rf /var/lib/apt/lists/*

# 1. 按 uv.lock 锁定的精确版本安装全部依赖（CPU 版 PyTorch 从官方 CPU 源安装同版本轮子，剥离 4GB+ CUDA 依赖）
COPY apps/imaging-worker/pyproject.toml apps/imaging-worker/uv.lock ./apps/imaging-worker/
RUN cd /app/apps/imaging-worker && \
    uv venv /opt/venv && \
    uv export --frozen --no-dev --no-emit-project --no-hashes > /tmp/lock.txt && \
    grep -E '^torch==' /tmp/lock.txt > /tmp/torch-cpu.txt && \
    grep -vE '^(#|\.|torch==|triton==|nvidia-|cuda-)' /tmp/lock.txt > /tmp/requirements.txt && \
    uv pip install --no-cache --python /opt/venv/bin/python \
      --index-url https://download.pytorch.org/whl/cpu --no-deps -r /tmp/torch-cpu.txt && \
    uv pip install --no-cache --python /opt/venv/bin/python \
      --no-deps -r /tmp/requirements.txt && \
    rm -f /tmp/lock.txt /tmp/torch-cpu.txt /tmp/requirements.txt

# 3. 先仅拷贝模型注册表与预热脚本，并默认仅烘焙轻量核心基座权重 (spleen_ct 23MB)；
#    其余大体积模型权重（合计 ~2.3GB）在生产环境持久化卷 imaging-models 中并发预热并长期保留，
#    从而避免每次修改 engine.py / server.py 时在 CI 构建期重复串行下载和上传 2.3GB 镜像层。
RUN mkdir -p /app/apps/imaging-worker/src /app/apps/imaging-worker/data /app/models
ENV HEURION_MODEL_DIR=/app/models
COPY apps/imaging-worker/src/model_registry.py apps/imaging-worker/src/bake_models.py /app/apps/imaging-worker/src/
RUN python3 /app/apps/imaging-worker/src/bake_models.py

# 4. 复制其余业务源码
COPY apps/imaging-worker/src /app/apps/imaging-worker/src

WORKDIR /app/apps/imaging-worker

# 5. 创建非 root 用户运行，确保隔离安全性并赋予模型目录与数据目录写权限
RUN useradd -m -u 1000 imaginguser && \
    chown -R imaginguser:imaginguser /app /opt/venv

USER imaginguser
EXPOSE 8004

# 6. 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8004/health')"

# 7. 单 Worker 启动，控制最大并发防止 3D 体素操作突发内存翻倍
CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8004", "--workers", "1"]
