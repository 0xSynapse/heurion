# 嵌入服务镜像（参考资料库 / 记忆的向量化，本地 bge-m3 q8）。构建时把模型下载进镜像，运行时不依赖外网。
# 构建上下文是仓库根目录：docker build -f apps/embedder/Dockerfile .
FROM node:24-bookworm-slim

RUN npm install -g pnpm@12.5.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# pnpm-workspace.yaml 登记了依赖补丁（patchedDependencies），安装时要读到补丁文件
COPY patches ./patches
COPY apps/embedder/package.json ./apps/embedder/
RUN pnpm install --frozen-lockfile --filter @heurion2/embedder...

COPY apps/embedder ./apps/embedder
ENV EMBED_CACHE_DIR=/models \
    EMBED_HOST=0.0.0.0 \
    EMBED_PORT=8003
RUN pnpm --filter @heurion2/embedder precache && chmod -R a+rX /models /app

USER node
EXPOSE 8003
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8003/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@heurion2/embedder", "start"]
