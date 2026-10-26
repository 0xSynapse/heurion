#!/bin/sh
# 构建 Heurion 阅片器镜像：OHIF 官方源码 + 官方 Dockerfile + 我们的配置（以后加 Heurion 扩展，T2.2）。部署在独立子域名的根路径。
# 用法：deploy/viewer/build.sh [镜像名]    需要 docker 或 podman（Podman 虚拟机建议 ≥ 8 GB 内存）
set -eu
OHIF_TAG=v3.13.12
IMAGE=${1:-heurion2-viewer:$OHIF_TAG}
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${OHIF_SRC_DIR:-$HERE/.ohif-src}
ENGINE=$(command -v docker || command -v podman)

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$OHIF_TAG" https://github.com/OHIF/Viewers.git "$SRC"
fi
test "$(git -C "$SRC" describe --tags --exact-match)" = "$OHIF_TAG"
cp "$HERE/app-config.js" "$SRC/platform/app/public/config/heurion.js"

"$ENGINE" build -t "$IMAGE" --build-arg PUBLIC_URL=/ --build-arg APP_CONFIG=config/heurion.js -f "$SRC/Dockerfile" "$SRC"
echo "已构建 $IMAGE"
