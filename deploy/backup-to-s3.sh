#!/usr/bin/env bash
# Heurion 2.0 备份到 S3 兼容存储（rclone）。
#   backup-to-s3.sh daily               数据库在线快照（node:sqlite backup，不直接拷正在写的库）
#   backup-to-s3.sh weekly              用户工作区（dsh 的文件、图）
#   backup-to-s3.sh upload-dir <目录> <前缀>   上传一个目录（切换时的 1.0 全量备份）
# 环境（.env.production）：S3_ENDPOINT、S3_REGION、S3_ACCESS_KEY、S3_SECRET_KEY、S3_BUCKET；保留 BACKUP_RETAIN_DAYS（7）/ BACKUP_RETAIN_WEEKS（4），
# 总量上限 BACKUP_MAX_GB（8，留在 Cloudflare R2 免费的 10 GB 以内），超出时从最旧的删，每类至少留 BACKUP_MIN_KEEP（2）份
set -euo pipefail

# 只从 .env.production 读备份要用的变量（S3_*、BACKUP_*），不整体 source：
# 文件里有 `EMAIL_FROM=Heurion <no-reply@heurion.org>` 这类 shell 不能直接执行的行。已经在环境里的变量优先。
ENV_FILE="${HEURION_ENV_FILE:-/opt/heurion2/.env.production}"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r k v; do
    case "$k" in
      S3_*|BACKUP_*) [ -n "${!k:-}" ] || export "$k=$v" ;;
    esac
  done < "$ENV_FILE"
fi

STATUS_FILE="${BACKUP_STATUS_FILE:-/opt/heurion2/backup-status.json}"
status() { printf '{"last_run":"%s","status":"%s","message":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" > "$STATUS_FILE"; }

MODE="${1:-daily}"
STAMP=$(date -u +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_BUCKET:-}" ]; then
  echo "[BACKUP-SKIPPED] S3 未配置" >&2; status skipped "S3 not configured"; exit 0
fi
command -v rclone >/dev/null 2>&1 || { echo "[BACKUP-FAILED] 没有 rclone" >&2; status failed "rclone missing"; exit 1; }

mkdir -p ~/.config/rclone
cat > ~/.config/rclone/rclone.conf <<EOF
[s3]
type = s3
provider = Other
endpoint = ${S3_ENDPOINT:-https://s3.amazonaws.com}
region = ${S3_REGION:-us-east-1}
access_key_id = ${S3_ACCESS_KEY}
secret_access_key = ${S3_SECRET_KEY}
EOF
chmod 600 ~/.config/rclone/rclone.conf
DEST="s3:${S3_BUCKET}/heurion2"

case "$MODE" in
  upload-dir)
    rclone copy "$2" "$DEST/$3" --s3-no-check-bucket
    echo "✓ 已上传 $2 → $DEST/$3"; exit 0 ;;
  daily)
    # 在平台容器里用 SQLite 在线备份 API 做一致性快照
    docker exec heurion2 node -e "
      const { DatabaseSync, backup } = require('node:sqlite');
      backup(new DatabaseSync('/app/data/platform/platform.db', { readOnly: true }), '/tmp/platform-backup.db')
        .then(() => console.log('snapshot ok')).catch(e => { console.error(e); process.exit(1) })"
    docker cp heurion2:/tmp/platform-backup.db "$TMP/platform-$STAMP.db"
    docker exec heurion2 rm -f /tmp/platform-backup.db
    [ -s "$TMP/platform-$STAMP.db" ] || { status failed "snapshot empty"; exit 1; }
    gzip -9 "$TMP/platform-$STAMP.db"
    rclone copy "$TMP/platform-$STAMP.db.gz" "$DEST/db/" --s3-no-check-bucket
    echo "✓ 数据库备份：platform-$STAMP.db.gz"
    # 各机构的患者库（docs/design/TENANCY.md）：逐个做一致性快照，连同已加密的原始文件一起打包。
    # 文件与自由文本是用机构密钥加密的密文；机构密钥由平台主密钥（HEURION_KEK / HEURION_SECRET）包裹——恢复时必须有同一把主密钥。
    docker exec heurion2 node -e "
      const { DatabaseSync, backup } = require('node:sqlite'); const fs = require('node:fs'); const path = require('node:path')
      const root = '/app/data/tenants', out = '/tmp/hb/tenants'
      fs.rmSync('/tmp/hb', { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true })
      const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'patients.db'))) : []
      ;(async () => {
        for (const d of dirs) {
          fs.mkdirSync(path.join(out, d), { recursive: true })
          await backup(new DatabaseSync(path.join(root, d, 'patients.db'), { readOnly: true }), path.join(out, d, 'patients.db'))
          if (fs.existsSync(path.join(root, d, 'files'))) fs.cpSync(path.join(root, d, 'files'), path.join(out, d, 'files'), { recursive: true })
        }
        console.log('tenants', dirs.length)
      })().catch(e => { console.error(e); process.exit(1) })"
    docker exec heurion2 tar czf /tmp/tenants-backup.tar.gz -C /tmp/hb tenants
    docker cp heurion2:/tmp/tenants-backup.tar.gz "$TMP/tenants-$STAMP.tar.gz"
    docker exec heurion2 rm -rf /tmp/hb /tmp/tenants-backup.tar.gz
    rclone copy "$TMP/tenants-$STAMP.tar.gz" "$DEST/tenants/" --s3-no-check-bucket
    echo "✓ 患者库备份：tenants-$STAMP.tar.gz"
    KEEP="${BACKUP_RETAIN_DAYS:-7}"; PREFIXES="db tenants" ;;
  weekly)
    # 工作区与数据集（上传的研究数据表）
    docker run --rm -v heurion2_data:/data:ro alpine sh -c 'cd /data && tar czf - platform/workspaces $( [ -d platform/datasets ] && echo platform/datasets )' > "$TMP/workspaces-$STAMP.tar.gz"
    rclone copy "$TMP/workspaces-$STAMP.tar.gz" "$DEST/workspaces/" --s3-no-check-bucket
    echo "✓ 工作区备份：workspaces-$STAMP.tar.gz"
    KEEP="${BACKUP_RETAIN_WEEKS:-4}"; PREFIXES=workspaces ;;
  *) echo "usage: $0 daily|weekly|upload-dir <dir> <prefix>"; exit 2 ;;
esac

# 只保留最新 KEEP 份
for PREFIX in $PREFIXES; do
  rclone lsf "$DEST/$PREFIX/" 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) \
    | while read -r f; do rclone deletefile "$DEST/$PREFIX/$f" 2>/dev/null || true; done || true
done

# 总量上限：按文件名里的时间戳找全部备份里最旧的一份删掉，直到总量不超过上限；每类至少留 MIN_KEEP 份
MAX_BYTES=$(( ${BACKUP_MAX_GB:-8} * 1024 * 1024 * 1024 ))
MIN_KEEP="${BACKUP_MIN_KEEP:-2}"
total_bytes() { rclone size "$DEST" --json --s3-no-check-bucket 2>/dev/null | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p'; }
OVER=0
while :; do
  TOTAL=$(total_bytes); TOTAL=${TOTAL:-0}
  [ "$TOTAL" -le "$MAX_BYTES" ] && break
  OLDEST=""; OLDEST_STAMP=""
  for PREFIX in db tenants workspaces; do
    FILES=$(rclone lsf "$DEST/$PREFIX/" 2>/dev/null | sort || true)
    COUNT=$(printf '%s\n' "$FILES" | grep -c . || true)
    [ "$COUNT" -gt "$MIN_KEEP" ] || continue
    F=$(printf '%s\n' "$FILES" | head -1)
    STAMP=$(printf '%s' "$F" | sed -n 's/^[a-z]*-\([0-9]\{8\}-[0-9]\{6\}\).*/\1/p')
    if [ -z "$OLDEST_STAMP" ] || [[ "$STAMP" < "$OLDEST_STAMP" ]]; then OLDEST="$PREFIX/$F"; OLDEST_STAMP="$STAMP"; fi
  done
  if [ -z "$OLDEST" ]; then OVER=1; break; fi
  echo "超过 ${BACKUP_MAX_GB:-8} GB 上限（当前 $((TOTAL / 1024 / 1024)) MB）：删除 $OLDEST"
  rclone deletefile "$DEST/$OLDEST" --s3-no-check-bucket
done
echo "备份总量：$(( $(total_bytes || echo 0) / 1024 / 1024 )) MB / 上限 ${BACKUP_MAX_GB:-8} GB"
if [ "$OVER" -eq 1 ]; then
  echo "[BACKUP-WARN] 每类只剩 $MIN_KEEP 份仍超过上限，需要调大 BACKUP_MAX_GB 或换付费额度" >&2
  status warn "over size cap with minimum copies"
  exit 0
fi
status ok "backup $MODE"
echo "[BACKUP-OK] $MODE"
