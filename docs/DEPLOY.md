# Heurion 2.0 部署

单机 Docker Compose，跑在一台 Ubuntu 服务器上。
push `0xSynapse/heurion` 的 main 分支，GitHub Actions 就会构建镜像（GHCR）并通过 SSH 部署。服务器地址只放在 secret 里，文档和代码都不写：站点经 Cloudflare 代理，源站 IP 不公开。

## 组成

| 容器 | 镜像 | 说明 |
|---|---|---|
| `heurion2` | `ghcr.io/0xsynapse/heurion2:<sha>`（根目录 `Dockerfile`） | 平台：页面、REST / SSE、协同 WebSocket、MCP、每用户 dsh 子进程、LibreOffice 渲染、OCR。数据卷 `heurion2_data` → `/app/data` |
| `heurion2-embedder` | `ghcr.io/0xsynapse/heurion2-embedder:<sha>`（`apps/embedder/Dockerfile`） | 本地 bge-m3 嵌入服务，模型在构建时打进镜像，只在内部网络可达 |
| `heurion2-imaging-worker` | `ghcr.io/0xsynapse/heurion2-imaging-worker:<sha>`（`apps/imaging-worker/Dockerfile`） | 影像分析（MONAI + PyTorch CPU）。模型权重在卷 `heurion2_imaging-models` 里，部署时预热、校验 |
| `heurion2-doc-parser` | `ghcr.io/0xsynapse/heurion2-doc-parser:<sha>`（`apps/doc-parser/Dockerfile`） | PDF 结构化解析（Docling）。模型在构建时打进镜像，运行时离线。只接入没有外网的 `parser` 网络 |
| `heurion2-caddy` | `caddy:2.8-alpine` | 反向代理加自动 HTTPS，只有它暴露 80/443。`/mcp`、`/llm` 对外返回 404；`www` 跳转到根域名；启用 pacs 时还有阅片器子域名 `viewer.<主域名>` |
| `heurion2-orthanc`（pacs，可选） | `orthancteam/orthanc:26.9.1` | 影像存储（DICOM + DICOMweb）。只在内部网络给平台访问，不映射端口，Basic 认证。数据卷 `heurion2_orthanc-db`，**不备份**（见下文） |
| `heurion2-viewer`（pacs，可选） | `ghcr.io/0xsynapse/heurion2-viewer:<sha>`（`deploy/viewer/build.sh`，OHIF v3.13.12） | 阅片器静态页。浏览器只经平台访问（`viewer.<主域名>` → Caddy → 平台 → 这里），影像经平台的 DICOMweb 代理按患者权限读取 |

各服务的内存上限和线程数见 `deploy/docker-compose.yml` 开头的预算表。换机器时要按新机器的内存和核数重新分配。

**AI 代码隔离**：平台容器以 root 启动，入口脚本 `deploy/entrypoint.sh` 整理好数据目录权限后，降到 `node` 用户运行平台。
- 每个平台用户的 dsh 进程，以及它执行的代码，经 `sudo` 加 `deploy/sandbox/heurion-sandbox-exec` 降到该用户专属的 uid（从 20000 起，见 `sandbox_uids` 表）。
- 这些进程只能进自己的工作区，读不到数据库、其他用户的工作区和平台进程的环境变量；环境里只有白名单变量；进程数和文件大小有上限。
- 模型调用经平台代理（`/llm/v1`），真实的 DeepSeek key 不进 dsh。
- 出站白名单：入口脚本用 iptables 只允许隔离 uid 连本机平台端口（MCP 和模型代理），外网和内部网络的其他服务（含 Orthanc、阅片器）一律拒绝。所以容器需要 `cap_add: [NET_ADMIN]`。
- 部署后用 `deploy/sandbox/probe.sh` 自检。

服务器上的目录 `/opt/heurion2`：`docker-compose.yml`、`Caddyfile`、`orthanc/orthanc.json`（启用 pacs 时用；内容变了 deploy.sh 重建 Orthanc）、`.env.production`（权限 0600，由 CI 用 secret 生成）、`scripts/`、`backup-status.json`。

## 网络与 DNS

- DNS 托管在 Cloudflare。根域名和 `www` 都是指向服务器的 A 记录，**开着代理**（橙色云朵）。
- 收信：`MX` 指向 Cloudflare Email Routing，由 Worker 转发给 `/api/mail/inbound`。发信用 Resend，相关的 SPF / DKIM 记录不要动。
- Caddy 自己给根域名和 `www` 申请证书。换服务器、改完 DNS 以后，`docker restart heurion2-caddy` 能让它马上申请，不用等重试。
- 服务器防火墙（ufw）只放行 22、80、443。SSH 只允许密钥登录。

## 发布流程

0. **经 PR 合进 main**（2026-11-02 起）。不要直接 push main。
   1. 在分支上开发，推送分支：`git push origin <分支>`。本地 `origin` 有两个推送地址，分支会同时到 `0xSynapse/heurion` 和 `heurion-org/heurion`。
   2. 在 `0xSynapse/heurion` 上开 PR：`gh pr create -R 0xSynapse/heurion --base main --head <分支>`。`ci.yml` 在 PR 上运行「类型检查与测试」。
   3. CI 通过后合并：`gh pr merge -R 0xSynapse/heurion <PR 号> --merge`。合并就是 push main，触发下面的部署（部署前还会再测一次）。
   4. 同步公开镜像：`git pull --ff-only origin main` 后 `git push origin main`。0xSynapse 那边已是最新，这一步只更新 `heurion-org/heurion`。要写明 `origin main`：本地 main 跟踪的是 `public`（heurion-org），不带参数的 `git pull` 会拉错仓库。
   - `heurion-org/heurion` 的 main 要求 PR 和「类型检查与测试」，但不对管理员强制。镜像同步这一次推送是唯一预期的绕过，推送时提示「Bypassed rule violations」属正常；外部贡献仍走那边的 PR。
   - `0xSynapse/heurion` 的 main 开启分支保护（要求 PR 与「类型检查与测试」通过，不对管理员强制）后，紧急修复仍可由管理员直接 push，但要在提交信息里写明原因，事后补 PR 说明。
1. push main，触发 `deploy-v2.yml`，依次执行：
   1. 类型检查和测试；
   2. 构建 4 个镜像，推到 GHCR（打 `<sha>` 和 `latest` 两个标签）；阅片器镜像在单独的 job 里并行处理：`deploy/viewer` 没变时只给已有镜像加标签，变了才从 OHIF 源码重建（见「启用影像存储」）；
   3. 生成 `.env.production`，拷贝部署文件；
   4. 运行 `scripts/deploy.sh`；
   5. 沙箱隔离自检；
   6. 冒烟检查：`/healthz`、首页、`/app`，以及 `/mcp`、`/llm` 必须返回 404；启用 pacs 时再查匿名 `/api/me` 为 401、阅片器子域名可达、Orthanc 与阅片器容器正常（`deploy/pacs-check.sh`）；
   7. 清 Cloudflare 缓存。

   只改 `*.md` 或 `docs/` 的提交不会触发部署。
2. `deploy.sh` 依次执行：
   1. 清理磁盘，拉镜像；
   2. `compose up`。Caddyfile 内容变了的话会重建 Caddy；
   3. 等 `https://<HOSTNAME>/healthz` 通过；
   4. 预热影像模型；
   5. 安装 S3 备份定时任务。

   健康检查失败时，自动回滚到上一个镜像。
3. 预发：`deploy-staging.yml`，**只能手动触发**（Actions → Deploy Staging → Run workflow）。
   - 它部署到 `STAGING_HOST`，域名是 `staging.heurion.org`；用独立的 secret，不配 S3，默认不发邮件。
   - `STAGING_HOST` 必须是一台不跑生产的机器，否则会用预发配置覆盖生产。

## Secrets（`0xSynapse/heurion` 仓库）

| Secret | 用途 |
|---|---|
| `VPS_HOST` / `VPS_USER` / `VPS_SSH_KEY` | 生产 SSH 部署。用一把 CI 专用的密钥，它的公钥放在服务器的 `authorized_keys` 里 |
| `HEURION2_SECRET` | 平台主密钥，没设时用 `SERVER_SECRET`。**它同时用来派生患者数据的加密主密钥**（见下文） |
| `DEEPSEEK_API_KEY` | 模型 |
| `RESEND_API_KEY` | 发信（验证码、通知） |
| `NCBI_API_KEY` | PubMed 限流提升 |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 备份。现在用 Cloudflare R2，`S3_REGION=auto`，token 只授权备份用的那个 bucket |
| `CF_API_TOKEN` / `CF_ZONE_ID` | 部署后清 Cloudflare 缓存 |
| `STAGING_HOST` / `STAGING_USER` / `STAGING_SSH_KEY` / `STAGING_KNOWN_HOSTS` / `STAGING_HEURION_SECRET` / `STAGING_ORTHANC_PASSWORD` | 预发，只在需要时设置，用完删掉 |
| `ORTHANC_PASSWORD` | 影像存储（Orthanc）口令，启用 pacs 时必填：32–128 位字母、数字、`-`、`_`，用 `openssl rand -hex 32` 生成。没设或不合格时部署直接失败，不会生成弱口令 |

**仓库变量**（Settings → Secrets and variables → Actions → Variables）：

| 变量 | 用途 |
|---|---|
| `ENABLE_PACS` | 设为 `1` 启用影像存储与阅片器（pacs profile）；不设或 `0` 不启用，部署与之前完全一致 |
| `IMAGING_RETENTION_DAYS` | 云端影像原件保留天数，只在启用 pacs 时生效。不设时生产用 **180**；`0` = 不清理 |
| `STAGING_ENABLE_PACS` / `STAGING_IMAGING_RETENTION_DAYS` | 预发的对应开关，含义同上 |

**密钥与数据**：
- 各机构的患者文件和自由文本，用机构自己的数据密钥加密；机构数据密钥再用平台主密钥加密保存。
- 没设 `HEURION_KEK` 时，平台主密钥由 `HEURION_SECRET` 推导出来（`tenancy/keys.ts`）。
- **丢了 `HEURION2_SECRET`，或者换了它，现有的患者数据和所有备份都解不开。** 换服务器、恢复备份时，必须用同一个值。

## 备份与恢复

`deploy/backup-to-s3.sh`，由 cron 运行。脚本自己只从 `.env.production` 里读取 `S3_*` 和 `BACKUP_*` 这几项，不会把整个文件 source 进来。

| 任务 | 时间（服务器时区） | 内容 | 位置 |
|---|---|---|---|
| daily | 每天 02:20 | `platform.db`，以及各机构的 `patients.db` 和加密文件。数据库都用 SQLite 在线备份接口做一致性快照 | `heurion2/db/`、`heurion2/tenants/` |
| weekly | 每周日 03:20 | 用户工作区、数据集 | `heurion2/workspaces/` |

- **轮换**：每天的备份保留 `BACKUP_RETAIN_DAYS`（7）份，每周的保留 `BACKUP_RETAIN_WEEKS`（4）份。每次备份完，如果总量超过 `BACKUP_MAX_GB`（8，留在 R2 免费的 10 GB 以内），就从最旧的开始删，每类至少留 `BACKUP_MIN_KEEP`（2）份。删到最少份数仍然超量时，状态记为 `warn`。
- **状态**：`/opt/heurion2/backup-status.json`；日志在 `/var/log/heurion2-backup.log`。
- **云端影像不备份，原件在医院**：Orthanc 的卷 `heurion2_orthanc-db` 不进 S3 备份（R2 的 8 GB 上限也放不下 DICOM）。平台库里的检查索引、AI 结果、病灶、测量与审核留痕随 `patients.db` 正常备份；恢复后原件不在的检查需要医院重新上传。
- **手动备份**：`bash /opt/heurion2/scripts/backup-to-s3.sh daily`（或 `weekly`）。
- **恢复**：
  1. `rclone copy s3:<bucket>/heurion2/db/<最新>.db.gz` 和 `tenants/<最新>.tar.gz`，下载到临时目录，解压。
  2. 停掉平台：`docker compose -p heurion2 --env-file .env.production stop heurion2`。
  3. 把 `platform.db` 放到卷里的 `platform/platform.db`；把各机构的目录放到 `tenants/<id>/`。属主是 `node`，数据库文件权限 0600。
  4. 启动平台。
  5. 确认 `.env.production` 里的 `HEURION_SECRET` 和备份当时的一致。

  可以先在临时目录里演练：打开数据库跑 `PRAGMA integrity_check`，再试着用当前密钥解开 `tenants.dek`。

## 迁移到新服务器

2026-10-13 换服务器时就是这么做的，停机约 5 分钟。

1. **准备新机器**：
   - 装 Docker（官方仓库，带 compose 插件）、rclone；
   - SSH 改为只允许密钥登录，ufw 放行 22、80、443；
   - 把 CI 部署密钥的公钥加到 `authorized_keys`。
2. **（可选）预发演练**：把 `STAGING_*` 指向新机器，手动跑预发。数据可以用在线快照搬过去试一遍。
3. **部署新机器**：把 `VPS_HOST`、`VPS_USER`、`VPS_SSH_KEY` 改成新机器的，然后 push main。
   - 这时 DNS 还指向旧机器，CI 的健康检查和冒烟检查实际测到的是旧机器。
   - 新机器上的容器状态要另外检查。
4. **停机迁移**：
   1. 旧机器上 `docker stop heurion2`，然后用 `docker run --rm -v heurion2_data:/d:ro alpine tar -czf - -C /d .` 把整个数据卷打包；
   2. 两台服务器之间直接传过去（用 agent 转发，不在服务器上留密钥），核对 sha256；
   3. 新机器上停掉平台，清空卷，用 `tar -xzpf … --numeric-owner` 解开。沙箱按 uid 区分工作区，所以必须保留数字属主；
   4. 启动平台。
5. **切 DNS**：在 Cloudflare 上把根域名和 `www` 的 A 记录**直接改**成新 IP。不要用导入：导入只会新增记录，旧记录还在的话，流量会分到两台机器上。然后 `docker restart heurion2-caddy`。
6. **验证**：冒烟检查；用当前密钥解开机构数据密钥；收发一封邮件。然后清一次 Cloudflare 缓存。
7. **回滚**：DNS 改回旧 IP，旧机器上 `docker start heurion2`。切换之后在新机器上写入的数据不会带回旧机器。旧机器保留到确认新机器没有问题、新的异地备份能恢复为止。

## 启用影像存储（pacs）

生产启用 Orthanc 与 OHIF 阅片器后，医生能在患者页上传 DICOM、在阅片器里看片、跑影像 AI。影像在浏览器里先去标识化再上传；托管生产机上的影像只是**工作副本，原件在医院**，按保留期清理，不备份。平台通过 `/api/me` 的 `features.dicom`（是否配置了 `ORTHANC_URL`）决定是否显示影像检查界面。

### 需要手动做的步骤

1. **Cloudflare DNS**：加一条 `viewer` 的 A 记录，指向与根域名相同的服务器 IP，**开代理**（橙色云朵）。Caddy 会为 `viewer.heurion.org` 申请证书，DNS 没有这条记录时证书申请会反复失败（主站不受影响）。
2. **secret `ORTHANC_PASSWORD`**：`openssl rand -hex 32` 生成，设到 `0xSynapse/heurion` 的 Actions secrets。只用于平台与 Orthanc 之间（内部网络），不需要告诉任何人；换口令就是改 secret 后重新部署。
3. **（可选）仓库变量 `IMAGING_RETENTION_DAYS`**：不设时为 180 天；`0` 不清理。
4. **先用预发演练**：设仓库变量 `STAGING_ENABLE_PACS=1`、secret `STAGING_ORTHANC_PASSWORD`（另生成一个，不与生产共用），可选变量 `STAGING_IMAGING_RETENTION_DAYS`；DNS 加 `viewer.staging` 的 A 记录指向预发机器，**不开代理**（灰色云朵：预发域名本来就不走 Cloudflare 代理，免费证书也不覆盖二级子域名，由 Caddy 直接申请证书）。然后 Actions → Deploy Staging → Run workflow，在预发上传一例去标识化的 CT、打开阅片器、跑一次分析。演练完删掉预发的 secret 与变量。
5. **仓库变量 `ENABLE_PACS=1`**，然后合并任意一个会触发部署的 PR（或 Actions → Deploy Heurion 2.0 → Run workflow）。部署后看冒烟检查里的 pacs 部分是否通过。

### 部署时发生什么

- CI 往 `.env.production` 追加：`COMPOSE_PROFILES=pacs`、`ORTHANC_URL=http://orthanc:8042`、`ORTHANC_USER=heurion`、`ORTHANC_PASSWORD`、`VIEWER_URL=http://viewer:8080`、`VIEWER_HOST` 与 `VIEWER_SITE`（都是 `viewer.<HOSTNAME>`）、`IMAGING_RETENTION_DAYS`。不启用时这些一行都不写。
- `deploy.sh` 读 `COMPOSE_PROFILES`，拉镜像、`compose up`、回滚都覆盖 `orthanc` 与 `viewer`；`VIEWER_SITE` 变化会让 compose 重建 Caddy。Caddy 的 `VIEWER_SITE` 不会为空：compose 里有默认值 `viewer.localhost`（空值会让 Caddyfile 解析失败）。
- Orthanc 只拿到自己的口令，不读整个 `.env.production`；不映射端口；隔离 uid 连不到它（`deploy/sandbox/probe.sh` 检查 `orthanc:8042`、`viewer:8080`）。
- **阅片器镜像的构建**：OHIF 从源码构建要 15–25 分钟。CI 按 `deploy/viewer` 下受版本控制文件的内容算指纹，推 `heurion2-viewer:src-<指纹>`；GHCR 里已有同一指纹时只加 `<sha>` / `latest` 标签，不重建。需要重建时用 registry 上的 `buildcache`（mode=max）复用依赖安装层。没有用 GHA 缓存当主手段：它每仓库 10 GB、按 LRU 淘汰，和另外 4 个大镜像共用，命中不可靠。不管 pacs 开没开，每次部署都会准备好阅片器镜像（不变时几秒钟）。

### 保留期清理

平台每天跑一次（启动 10 分钟后先跑一次，`src/imaging/retention.ts`）：检查「最后上传时间」超过 `IMAGING_RETENTION_DAYS` 天，就从 Orthanc 删除整个检查（原件与 AI 生成的 SEG）。平台库保留检查索引、AI 结果、病灶、测量与审核留痕。界面上这类检查不再有「在阅片器中打开」「重新分析」，并写明「影像原件已按保留期（N 天）从云端删除，可重新上传」；重新上传同一检查即恢复。有分析在进行的检查跳过，删除失败第二天再试；每次删除在患者访问记录里记一条「影像原件按保留期删除」（系统定时任务），平台日志前缀 `[imaging-retention]`。

### 关闭与回滚

- **关闭**：删掉仓库变量 `ENABLE_PACS`（或设为 `0`）后重新部署。`deploy.sh` 会移除 `heurion2-orthanc`、`heurion2-viewer` 容器，Caddy 的阅片器站点回到 `viewer.localhost`，界面不再显示影像检查。卷 `heurion2_orthanc-db` 保留，再次启用时影像还在；确定不要时手动 `docker volume rm heurion2_orthanc-db`。
- **回滚某次部署**：健康检查失败时 `deploy.sh` 自动回滚，阅片器镜像一并回到上一个；手动回滚见「运维」里的五个镜像。
- **只是阅片器坏了**：可以先关闭 pacs（上面），或在服务器上用上一版镜像 `VIEWER_IMAGE=ghcr.io/0xsynapse/heurion2-viewer:<上一个 sha>` 手动部署。

## 运维

- **告警**：
  - 平台内部：模型服务认证失败或余额不足，立即发邮件；15 分钟内有 5 个回合失败，也发邮件。收件人是绑定了邮箱的管理员，同类告警一小时最多一封（`src/ops-alert/alerts.ts`）。
  - 外部：`uptime.yml` 每 10 分钟探测一次 heurion.org，连续失败就开一个 issue，恢复后自动关闭。它必须放在默认分支 main 的 `.github/workflows/` 下才会定时运行。
- **日志**：`docker logs -f heurion2`（json-file 轮转，单个容器最多约 250 MB）。
- **手动部署 / 回滚到某个版本**：在 `/opt/heurion2` 下运行 `HEURION2_IMAGE=…:<sha> EMBEDDER_IMAGE=…:<sha> IMAGING_WORKER_IMAGE=…:<sha> DOC_PARSER_IMAGE=…:<sha> VIEWER_IMAGE=…:<sha> bash scripts/deploy.sh`，五个镜像都要指定（没启用 pacs 时 `VIEWER_IMAGE` 可以省略）。
- **本地验证容器**：`scripts/container.sh build && scripts/container.sh up`（单容器，开发用）。

## 历史

- 2026-10-02：2.0 部署到 1.0 所在的 VPS，替换掉 1.0。2026-10-03 决定放弃 1.0 的全部数据，2.0 从零开始。切换脚本是 `cutover-v1.sh`，清理用 `cleanup-v1.yml`，这两个现在都只是为了兼容旧机器才保留。
- 2026-10-13：生产换了一台内存更大的服务器。同时配上 R2 异地备份；在这之前生产一直没有异地备份。
