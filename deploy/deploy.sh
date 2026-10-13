#!/usr/bin/env bash
# Heurion 2.0 生产部署（在 VPS 上运行，CI 通过 SSH 调用）。
#   HEURION2_IMAGE=ghcr.io/…/heurion2:<sha> EMBEDDER_IMAGE=ghcr.io/…/heurion2-embedder:<sha> bash deploy.sh
#
# 目录：/opt/heurion2（CI 拷来 docker-compose.yml、Caddyfile、脚本、.env.production）。
# 第一次部署时如果 1.0 还在跑（nexus-server 容器存在），先做切换（cutover-v1.sh）：停 1.0、全量备份、导入账户。
# 健康检查失败自动回滚：切换那次回滚到 1.0（1.0 的卷与目录在 cleanup-v1.sh 之前都保留），之后回滚到上一个 2.0 镜像。
set -euo pipefail

DIR="${DEPLOY_DIR:-/opt/heurion2}"
cd "$DIR"
: "${HEURION2_IMAGE:?需要 HEURION2_IMAGE}"
: "${EMBEDDER_IMAGE:?需要 EMBEDDER_IMAGE}"
: "${IMAGING_WORKER_IMAGE:?需要 IMAGING_WORKER_IMAGE}"
: "${DOC_PARSER_IMAGE:?需要 DOC_PARSER_IMAGE}"
export HEURION2_IMAGE EMBEDDER_IMAGE IMAGING_WORKER_IMAGE DOC_PARSER_IMAGE
[ -f .env.production ] || { echo "缺少 $DIR/.env.production" >&2; exit 1; }
chmod 600 .env.production

# 自动 Swap 检查（小内存机器至少要有 2GB Swap 防 OOM；已有足够 swap 时跳过）
SWAP_TOTAL_MB=$(free -m 2>/dev/null | awk '/^Swap:/ {print $2}' || echo 0)
if [ -n "$SWAP_TOTAL_MB" ] && [ "$SWAP_TOTAL_MB" -lt 2048 ]; then
  if [ ! -f /swapfile ] && command -v fallocate >/dev/null 2>&1; then
    echo "== 配置 4GB NVMe Swap 虚拟内存（防 OOM 救生圈）..."
    ( fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile ) || true
    if ! grep -q '/swapfile' /etc/fstab 2>/dev/null; then
      echo '/swapfile none swap sw 0 0' >> /etc/fstab 2>/dev/null || true
    fi
  fi
fi

COMPOSE=(docker compose -p heurion2 --env-file .env.production -f docker-compose.yml)
HOSTNAME=$(grep '^HOSTNAME=' .env.production | head -1 | cut -d= -f2-)
[ -n "$HOSTNAME" ] || { echo "HOSTNAME 没有设置" >&2; exit 1; }

# 回滚点：当前在跑的 2.0 镜像 ID（不是 tag）
PREV_APP=$(docker inspect --format '{{.Image}}' heurion2 2>/dev/null || true)
PREV_EMB=$(docker inspect --format '{{.Image}}' heurion2-embedder 2>/dev/null || true)
PREV_IMG=$(docker inspect --format '{{.Image}}' heurion2-imaging-worker 2>/dev/null || true)
PREV_DOCP=$(docker inspect --format '{{.Image}}' heurion2-doc-parser 2>/dev/null || true)

# 磁盘空间保障函数：拉取新镜像前/后释放未在运行的旧镜像、历史构建缓存与系统临时数据
reclaim_disk_space() {
  echo "== 检查与清理 VPS 磁盘空间..."
  df -h / | tail -1
  # 1. 清理已退出/停止的无用容器
  docker container prune -f >/dev/null 2>&1 || true
  # 2. 彻底删除没有容器正在使用的旧镜像（-a: 包含所有旧版本 tag 镜像）
  # 说明：当前正在运行的容器（如当前 heurion2/embedder/imaging-worker）所绑定的镜像不会被删除
  docker image prune -af >/dev/null 2>&1 || true
  # 3. 清理构建缓存与孤儿网络
  docker builder prune -af >/dev/null 2>&1 || true
  docker network prune -f >/dev/null 2>&1 || true
  # 4. 清理 systemd journal 日志与 apt 缓存，防止系统日志堆积数 GB
  if command -v journalctl >/dev/null 2>&1; then
    journalctl --vacuum-size=100M >/dev/null 2>&1 || true
  fi
  apt-get clean >/dev/null 2>&1 || true
  rm -rf /tmp/docker-* /tmp/extract-* 2>/dev/null || true
  # 5. 如果已经切换到 2.0，彻底清除 1.0 的残留大文件（代码库、旧模型与全量备份）
  if [ -f .cutover-done ]; then
    rm -rf /opt/heurion /opt/nexus-embedding-models backups/v1-final-* 2>/dev/null || true
    docker volume ls -q 2>/dev/null | grep -E '^heurion_' | xargs -r docker volume rm 2>/dev/null || true
  fi
  echo "== 清理后磁盘可用空间："
  df -h / | tail -1
}

reclaim_disk_space

pulled=0
for i in 1 2 3; do
  if "${COMPOSE[@]}" pull; then pulled=1; break; fi
  echo "⚠️  拉取镜像失败（第 $i 次），清理磁盘与缓存后 10 秒重试..."
  reclaim_disk_space
  sleep 10
done
[ "$pulled" -eq 1 ] || { echo "❌ 拉取镜像失败"; exit 1; }

# 切换中途失败：停 2.0，把 1.0 拉回来（1.0 的卷与 /opt/heurion 在清理前都在）
restore_v1() {
  echo "↩️  恢复 1.0"
  "${COMPOSE[@]}" down >/dev/null 2>&1 || true
  if [ -f /opt/heurion/docker-compose.yml ] && ! docker inspect nexus-server >/dev/null 2>&1; then
    # 1.0 的容器已被删：按切换时记下的镜像重建
    ( set -a; [ -f "$DIR/v1-images.env" ] && . "$DIR/v1-images.env"; set +a
      cd /opt/heurion && docker compose --env-file .env.production up -d ) || true
  fi
  docker start nexus-server nexus-embedding-server nexus-stats-worker nexus-caddy >/dev/null 2>&1 || true
  for i in $(seq 1 24); do
    curl -fsS "https://${HOSTNAME}/healthz" >/dev/null 2>&1 && { echo "↩️  1.0 已恢复"; return 0; }
    sleep 5
  done
  echo "❌ 1.0 恢复后仍不健康，需要人工介入（docker ps -a | grep nexus）"
}

CUTOVER=0
if [ ! -f .cutover-done ] && docker inspect nexus-server >/dev/null 2>&1; then
  CUTOVER=1
  echo "== 检测到 1.0：开始切换"
  if ! bash scripts/cutover-v1.sh; then
    echo "❌ 切换失败"
    restore_v1
    exit 1
  fi
fi

# Caddyfile 是挂载进容器的单个文件：内容变了 compose 不会重建 Caddy，旧配置会一直生效——按内容哈希判断，变了就重建（证书在卷里，几秒中断）
CADDY_HASH=$(sha256sum Caddyfile | cut -d' ' -f1)
CADDY_RECREATE=()
if [ "$(cat .caddyfile.sha 2>/dev/null)" != "$CADDY_HASH" ]; then CADDY_RECREATE=(--force-recreate caddy); fi

if ! "${COMPOSE[@]}" up -d --remove-orphans; then
  echo "❌ 启动 2.0 失败"
  "${COMPOSE[@]}" logs --tail=80 || true
  [ "$CUTOVER" -eq 1 ] && restore_v1
  exit 1
fi

if [ ${#CADDY_RECREATE[@]} -gt 0 ]; then
  echo "== Caddyfile 有变化：重建 Caddy"
  "${COMPOSE[@]}" up -d --no-deps "${CADDY_RECREATE[@]}" && echo "$CADDY_HASH" > .caddyfile.sha
fi

wait_health() {
  for i in $(seq 1 36); do
    if curl -fsS "https://${HOSTNAME}/healthz" >/dev/null 2>&1; then echo "✓ 健康：https://${HOSTNAME}/healthz"; return 0; fi
    echo "  健康检查第 $i/36 次未通过，5 秒后重试"; sleep 5
  done
  return 1
}

if wait_health; then
  if [ "$CUTOVER" -eq 1 ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > .cutover-done
    echo "✓ 已切换到 2.0。1.0 的卷与 /opt/heurion 仍保留，确认无误后运行 cleanup-v1 清理。"
  fi

  # 生产环境 MONAI 官方临床模型权重预热与校验（持久化存储在 imaging-models 卷中）
  echo "== [Models] 预热与校验生产环境 MONAI 深度学习权重（持久化卷 imaging-models）..."
  docker exec heurion2-imaging-worker python3 -c "
import sys
sys.path.insert(0, '/app/apps/imaging-worker/src')
from model_registry import OFFICIAL_MODEL_REGISTRY, pull_model, verify_model

targets = [k for k in OFFICIAL_MODEL_REGISTRY if k not in ('totalsegmentator', 'vista3d', 'copd_emphysema')]
print(f'正在校验 {len(targets)} 个官方临床模型权重...')
for k in targets:
    try:
        v = verify_model(k)
        if not v.get('installed') or not v.get('verified'):
            print(f'  拉取并校验模型: {k}...')
            pull_model(k)
        print(f'  ✓ 就绪: {k}')
    except Exception as e:
        print(f'  ⚠️ 模型 {k} 预热跳过: {e}')
" || echo "⚠️  模型预热在后台完成或由于网络重试，不影响主服务运行"

  # S3 备份（配置了才装定时任务）
  if grep -q '^S3_ACCESS_KEY=' .env.production && grep -q '^S3_BUCKET=.' .env.production; then
    command -v rclone >/dev/null 2>&1 || curl -fsSL https://rclone.org/install.sh | bash
    ( crontab -l 2>/dev/null | grep -v 'heurion2/scripts/backup-to-s3.sh' || true
      echo "20 2 * * * bash $DIR/scripts/backup-to-s3.sh daily >> /var/log/heurion2-backup.log 2>&1"
      echo "20 3 * * 0 bash $DIR/scripts/backup-to-s3.sh weekly >> /var/log/heurion2-backup.log 2>&1"
    ) | crontab -
    echo "✓ S3 备份定时任务（每天 02:20 数据库，每周日 03:20 工作区）"
  else
    echo "S3 未配置：跳过备份定时任务"
  fi
  reclaim_disk_space
  exit 0
fi

echo "❌ 健康检查失败"
"${COMPOSE[@]}" logs --tail=80 heurion2 || true
if [ "$CUTOVER" -eq 1 ]; then
  restore_v1
  exit 1
fi
if [ -n "$PREV_APP" ]; then
  echo "↩️  回滚到上一个镜像 $PREV_APP"
  HEURION2_IMAGE="$PREV_APP" EMBEDDER_IMAGE="${PREV_EMB:-$EMBEDDER_IMAGE}" IMAGING_WORKER_IMAGE="${PREV_IMG:-$IMAGING_WORKER_IMAGE}" DOC_PARSER_IMAGE="${PREV_DOCP:-$DOC_PARSER_IMAGE}" "${COMPOSE[@]}" up -d
  wait_health && echo "↩️  已回滚并恢复健康，请查日志修复后再发" || echo "❌ 回滚后仍不健康，需要人工介入"
fi
exit 1
