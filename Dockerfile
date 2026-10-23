# Heurion 平台单机镜像：平台 server（模型 + 操作层 + MCP + 协同网关 + 编辑器页面）+ dsh 子进程
FROM node:24-bookworm-slim

# dsh shell 的计算环境（统计、作图、读资料）。文档编辑只走 MCP，因此不装 python-docx/pptx。
# LibreOffice 无界面版（Writer / Impress）：导出文件的渲染校验、幻灯片渲染；poppler：PDF 转 PNG；Noto CJK 保证中文渲染
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv git ca-certificates sudo iptables curl \
      libreoffice-writer-nogui libreoffice-impress-nogui poppler-utils \
      fonts-noto-cjk fonts-liberation2 \
    && rm -rf /var/lib/apt/lists/*
# 统计：回归（statsmodels）、生存分析（lifelines）、读 SPSS / Stata（pyreadstat）；matplotlib 默认用 Noto CJK，中文不出方框
RUN python3 -m venv /opt/compute \
    && /opt/compute/bin/pip install --no-cache-dir pandas matplotlib scipy openpyxl statsmodels lifelines pyreadstat \
    && /opt/compute/bin/python -c "import matplotlib, os; p = os.path.join(os.path.dirname(matplotlib.__file__), 'mpl-data', 'matplotlibrc'); open(p, 'a').write('\\nfont.family: sans-serif\\nfont.sans-serif: Noto Sans CJK SC, Noto Sans CJK JP, DejaVu Sans\\naxes.unicode_minus: False\\n')" \
    && chmod -R a+rX /opt/compute
ENV PATH=/opt/compute/bin:$PATH

RUN npm install -g pnpm@12.5.1

WORKDIR /app
# 先只拷贝依赖清单与补丁，确保仅修改业务代码时不会使 pnpm install 与 OCR 语言包缓存失效
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY packages/canvas-ui/package.json ./packages/canvas-ui/
COPY apps/platform/package.json ./apps/platform/
RUN pnpm install --frozen-lockfile --filter @heurion2/platform...

# OCR 语言模型（简中 + 英文）构建时下载进镜像（置于 COPY . . 之前，避免改代码重复下载）
RUN mkdir -p /opt/ocr-cache && cd /app/apps/platform \
    && node -e "import('tesseract.js').then(async ({ createWorker }) => { const w = await createWorker('chi_sim+eng', 1, { cachePath: '/opt/ocr-cache' }); await w.terminate() })" \
    && ls -la /opt/ocr-cache && chmod -R a+rX /opt/ocr-cache

COPY . .
RUN pnpm --filter @heurion2/platform build \
    && chmod -R a+rX /app \
    && mkdir -p /app/data && chown -R node:node /app/data

# AI 代码隔离：平台以 node 运行；每个平台用户的 dsh 及其执行的代码经 sudo + 启动器降到专属 uid
COPY deploy/sandbox/heurion-sandbox-exec /usr/local/bin/heurion-sandbox-exec
COPY deploy/sandbox/sudoers /etc/sudoers.d/heurion
COPY deploy/entrypoint.sh /usr/local/bin/heurion-entrypoint
RUN chown root:root /usr/local/bin/heurion-sandbox-exec /usr/local/bin/heurion-entrypoint /etc/sudoers.d/heurion \
    && chmod 0755 /usr/local/bin/heurion-sandbox-exec /usr/local/bin/heurion-entrypoint \
    && chmod 0440 /etc/sudoers.d/heurion && visudo -cf /etc/sudoers.d/heurion

# 以 root 启动：入口整理数据目录权限后降到 node 运行平台
ENV NODE_ENV=production \
    HEURION_DEV_MODE=0 \
    HEURION_DATA_DIR=/app/data \
    HEURION_SANDBOX=1 \
    HEURION_OCR_CACHE=/opt/ocr-cache \
    PORT=8787
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/heurion-entrypoint"]
CMD ["pnpm", "--filter", "@heurion2/platform", "start"]
