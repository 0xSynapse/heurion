#!/bin/bash
# AI 代码隔离自检（在平台容器里以 node 运行：docker exec -u node heurion2 bash /app/deploy/sandbox/probe.sh）。
# 以两个测试 uid 跑「攻击者」命令，确认读不到平台密钥、数据库、别人的工作区；能正常在自己的工作区干活。
# 全部通过退出 0，否则退出 1。会建 / 删两个以 sandbox-probe- 开头的测试目录。
set -uo pipefail
ROOT=/app/data/platform
A=sandbox-probe-a; B=sandbox-probe-b
fail=0
ok()  { echo "✓ $1"; }
bad() { echo "✗ $1"; fail=1; }
run_as() { # $1 uid, $2 名字, $3 命令。环境与平台的启动器一致：只有代理令牌，没有平台密钥
  env -i PATH=/usr/local/bin:/usr/bin:/bin DEEPSEEK_API_KEY=h1.probe-proxy-token HEURION_MCP_TOKEN=h1.probe-mcp-token \
    sudo -n /usr/local/bin/heurion-sandbox-exec "$1" "$ROOT/workspaces/$2" "$ROOT/dsh-homes/$2" -- bash -c "$3" 2>&1
}

# 准备：B 的工作区里放一个「秘密」
run_as 59998 "$B" 'echo b-secret > secret.txt' >/dev/null

[ "$(run_as 59999 "$A" 'id -u')" = "59999" ] && ok "以专属 uid 运行" || bad "没有降到专属 uid"
[ "$(run_as 59999 "$A" 'ulimit -u')" = "512" ] && ok "进程数受限" || bad "进程数没有受限"
run_as 59999 "$A" 'echo hello > out.txt && cat out.txt' | grep -q hello && ok "自己的工作区可读写" || bad "自己的工作区不可写"
[ "$(stat -c %G "$ROOT/workspaces/$A/out.txt" 2>/dev/null)" = "node" ] && cat "$ROOT/workspaces/$A/out.txt" >/dev/null 2>&1 \
  && ok "平台能读用户生成的文件（资产上传）" || bad "平台读不到用户生成的文件"

out=$(run_as 59999 "$A" 'cat /proc/1/environ; for p in /proc/[0-9]*; do tr "\0" "\n" < $p/environ 2>/dev/null; done | grep -E "HEURION_SECRET|RESEND|DEEPSEEK_API_KEY=sk-" ')
[ -z "$(echo "$out" | grep -E 'HEURION_SECRET=|RESEND_API_KEY=|DEEPSEEK_API_KEY=sk-')" ] && ok "读不到平台进程的环境（密钥）" || bad "读到了平台进程的环境"
run_as 59999 "$A" 'printenv' | grep -qE 'HEURION_SECRET|RESEND_API_KEY|DEEPSEEK_API_KEY=sk-' && bad "自己的环境里有平台密钥" || ok "自己的环境里没有平台密钥"
run_as 59999 "$A" "head -c 16 $ROOT/platform.db" | grep -q 'SQLite' && bad "读到了平台数据库" || ok "读不到平台数据库"
run_as 59999 "$A" "ls $ROOT" | grep -q 'platform.db' && bad "能列出平台数据目录" || ok "不能列出平台数据目录"
run_as 59999 "$A" "cat $ROOT/workspaces/$B/secret.txt" | grep -q b-secret && bad "读到了别人的工作区" || ok "读不到别人的工作区"
run_as 59999 "$A" "echo x > $ROOT/workspaces/$B/pwn.txt" >/dev/null; [ -e "$ROOT/workspaces/$B/pwn.txt" ] && bad "写进了别人的工作区" || ok "写不进别人的工作区"
run_as 59999 "$A" 'sudo -n true' >/dev/null 2>&1 && bad "隔离用户能用 sudo" || ok "隔离用户不能用 sudo"
run_as 59999 "$A" 'ls /app/data' >/dev/null 2>&1 && bad "能列出 /app/data" || ok "不能列出 /app/data"
run_as 59999 "$A" "curl -fsS -m 5 http://127.0.0.1:${PORT:-8787}/healthz" | grep -q '"ok":true' && ok "能连本机平台（MCP / 模型代理）" || bad "连不上本机平台"
run_as 59999 "$A" 'curl -sS -m 5 -o /dev/null https://example.com' >/dev/null 2>&1 && bad "能访问外网" || ok "不能访问外网"
run_as 59999 "$A" 'curl -sS -m 5 -o /dev/null http://embedder:8003/health' >/dev/null 2>&1 && bad "能访问内部网络的其他服务" || ok "不能访问内部网络的其他服务"

# 数据导入（与平台 datasets/ingest.ts 同一条路）：平台在工作区里建中转目录、放输入 → 以该 uid 运行导入脚本 → 平台读结果、清理
run_as 59999 "$A" 'python3 -c "import pandas, scipy, statsmodels, lifelines, pyreadstat, openpyxl, matplotlib"' >/dev/null && ok "统计包可用（pandas、statsmodels、lifelines、pyreadstat）" || bad "统计包缺失"
STAGE="$ROOT/workspaces/$A/.datasets/probe"
mkdir -p "$STAGE" && { chmod 2777 "$ROOT/workspaces/$A/.datasets" 2>/dev/null || true; } && chmod 2777 "$STAGE" && printf 'grp,val\nA,1\nB,2\n' > "$STAGE/input.csv" && chmod 644 "$STAGE/input.csv"
run_as 59999 "$A" "python3 /app/apps/platform/scripts/dataset_ingest.py $STAGE/input.csv $STAGE/out" >/dev/null
grep -q '"ok": true' "$STAGE/out/profile.json" 2>/dev/null && head -1 "$STAGE/out/data.csv" | grep -q 'grp,val' && rm -rf "$STAGE" && [ ! -e "$STAGE" ] \
  && ok "数据导入在隔离环境里运行，平台能读结果并清理" || bad "数据导入在隔离环境里失败"

# 图片附件（AI 的 read_image 走这条路）：dsh 保存附件时会对上层目录逐级 fsync，/app/data、dsh-homes 对隔离用户不可读，
# 必须能跳过（patches/@deepseek-ai__dsh-attachment-local），否则 read_image 报 EACCES
ATT=$(ls -d /app/node_modules/.pnpm/@deepseek-ai+dsh-attachment-local@*/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js 2>/dev/null | head -1)
run_as 59999 "$A" "node --input-type=module -e \"import { saveImageFile } from '$ATT'; const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'); const r = await saveImageFile('$ROOT/dsh-homes/$A/attachments/v1', { data: png, mediaType: 'image/png' }, { maxImageBytes: 2e7, maxMessageImageBytes: 2e8, maxImagePixels: 64e6, maxImageDimension: 8192, mediaTypes: ['image/png'] }, { maxPixels: 4194304, maxDimension: 8192, maxBytes: 4194304 }); console.log('saved', r.attachmentId)\"" | grep -q '^saved ' \
  && ok "隔离环境里能保存图片附件（read_image）" || bad "隔离环境里保存图片附件失败（read_image 会报 EACCES）"

rm -rf "$ROOT/workspaces/$A" "$ROOT/workspaces/$B" "$ROOT/dsh-homes/$A" "$ROOT/dsh-homes/$B" 2>/dev/null \
  || sudo -n /usr/local/bin/heurion-sandbox-exec 59999 "$ROOT/workspaces/$A" "$ROOT/dsh-homes/$A" -- bash -c 'rm -rf ./* ./.tmp' >/dev/null 2>&1
exit $fail
