#!/bin/sh
# 构建 Heurion 阅片器镜像：OHIF 官方源码 + 官方 Dockerfile + 我们的配置（以后加 Heurion 扩展，T2.2）。部署在独立子域名的根路径。
# 用法：deploy/viewer/build.sh [镜像名]    需要 docker 或 podman（Podman 虚拟机建议 ≥ 8 GB 内存）
#   VIEWER_PREPARE_ONLY=1 deploy/viewer/build.sh   只准备构建上下文（$SRC）不构建：CI（deploy-v2.yml）用 buildx 自己构建并推送
set -eu
OHIF_TAG=v3.13.12
IMAGE=${1:-heurion2-viewer:$OHIF_TAG}
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${OHIF_SRC_DIR:-$HERE/.ohif-src}

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$OHIF_TAG" https://github.com/OHIF/Viewers.git "$SRC"
fi
test "$(git -C "$SRC" describe --tags --exact-match)" = "$OHIF_TAG"
cp "$HERE/app-config.js" "$SRC/platform/app/public/config/heurion.js"

# Heurion 结节面板扩展：复制进 OHIF 的 extensions/（pnpm 工作区自动收录），并登记到 pluginConfig.json
rm -rf "$SRC/extensions/heurion-nodules"
cp -R "$HERE/heurion-nodules" "$SRC/extensions/heurion-nodules"
cp "$SRC/extensions/test-extension/babel.config.js" "$SRC/extensions/heurion-nodules/babel.config.js"
node -e '
  const fs = require("fs"), f = process.argv[1], cfg = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!cfg.extensions.some(e => e.packageName === "@heurion/extension-nodules")) cfg.extensions.push({ packageName: "@heurion/extension-nodules" });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
' "$SRC/platform/app/pluginConfig.json"

if [ "${VIEWER_PREPARE_ONLY:-}" = "1" ]; then echo "构建上下文已准备：$SRC"; exit 0; fi
ENGINE=$(command -v docker || command -v podman)
"$ENGINE" build -t "$IMAGE" --build-arg PUBLIC_URL=/ --build-arg APP_CONFIG=config/heurion.js -f "$SRC/Dockerfile" "$SRC"
echo "已构建 $IMAGE"
