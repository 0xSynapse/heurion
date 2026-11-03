#!/usr/bin/env bash
# 影像存储（pacs profile）部署后自检，在服务器上运行（deploy-v2.yml 的冒烟检查经 SSH 调用）：
#   - Orthanc 与阅片器容器在运行；
#   - 平台用 .env.production 里的口令能连 Orthanc，不带口令被拒（401）；
#   - 平台能取到阅片器（OHIF）的静态页。
# Orthanc 不映射端口，只能从平台容器里（内部网络）访问。全部通过退出 0。
set -euo pipefail
for c in heurion2-orthanc heurion2-viewer; do
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || { echo "✗ $c 没有运行"; exit 1; }
done
docker exec heurion2 node -e '
  const u = process.env.ORTHANC_URL, v = process.env.VIEWER_URL
  if (!u || !v) { console.error("✗ 平台没有 ORTHANC_URL / VIEWER_URL"); process.exit(1) }
  const auth = "Basic " + Buffer.from(`${process.env.ORTHANC_USER}:${process.env.ORTHANC_PASSWORD}`).toString("base64")
  ;(async () => {
    const ok = await fetch(`${u}/system`, { headers: { Authorization: auth } })
    const anon = await fetch(`${u}/system`)
    const viewer = await fetch(`${v}/`)
    console.log(`Orthanc（带口令）${ok.status}，Orthanc（匿名）${anon.status}，阅片器 ${viewer.status}`)
    process.exit(ok.ok && anon.status === 401 && viewer.ok ? 0 : 1)
  })().catch(e => { console.error("✗", e.message); process.exit(1) })'
echo "✓ 影像存储与阅片器正常"
