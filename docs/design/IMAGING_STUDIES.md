# 影像检查（DICOM）存储、索引与访问

对应 PRD v3.0 工作列表 T1.1（Orthanc 与 DICOMweb 代理）、T1.2（W1.0 手工上传 DICOM）、T1.3（影像数据模型）。

## 结构

```
浏览器（患者页上传 / OHIF 阅片）
   │  /api/patients/:ptid/imaging/dicom      上传（multipart，DICOM 或 zip）
   │  /api/patients/:ptid/imaging/studies    检查列表
   │  /api/dicomweb/studies/...              DICOMweb 只读代理
   ▼
平台（鉴权 + 按患者权限放行 + 访问留痕）
   │  ORTHANC_URL（内部网络，Basic 认证）
   ▼
Orthanc（DICOM 原件，DICOMweb 插件；不对外暴露）
```

- DICOM 原件只存在 Orthanc。平台库只存索引、AI 结果和医生的确认留痕。
- 浏览器和影像 worker 都不直接访问 Orthanc，一律经平台代理。代理只放行当前用户能看到的患者的检查。
- 部署：`deploy/docker-compose.yml` 的 `orthanc` 服务属于 `pacs` profile，默认不启动。只在允许存放患者原始数据的服务器（医院内网）上启用。

## 数据模型（机构患者库 `patients.db`）

| 表 | 内容 |
| --- | --- |
| `imaging_studies` | 检查：患者、StudyInstanceUID（加密 + 机构密钥 HMAC）、检查日期、模态、描述与检查号（加密）、来源（upload / pacs） |
| `imaging_series` | 序列：SeriesInstanceUID（加密 + HMAC）、模态、部位、层厚、重建核、层数 |
| `imaging_runs` | AI 运行：任务、模型与版本、状态、`visibility`（visible / shadow） |
| `imaging_lesions` | 病灶：来源（ai / manual）、状态（proposed / confirmed / rejected）、否决原因、位置、测量（JSON）、分割引用、版本号 |
| `imaging_lesion_events` | 病灶的每次改动：谁、经人还是 AI、动作、改前、改后 |

- DICOM UID 和检查号属于可识别信息，只存密文。按 UID 查找和去重用机构密钥下的 HMAC。
- 同一检查（同一个 StudyInstanceUID）已关联到本机构另一位患者时，不重复关联。上传结果只返回冲突数，不透露是哪位患者。
- 所有读写都经 `PatientService.imagingScope`：读要求能看到患者，写要求是诊疗组成员。访问记入患者的 `access_log`（`imaging_upload`、`dicomweb_view`、`lesion_*`）。

## 人与 AI 的分工

| 动作 | 医生 | AI |
| --- | --- | --- |
| 上传 DICOM | 可以 | 不可以（原件不经 AI） |
| 读检查列表 | 可以，含 UID（OHIF 打开检查用） | `imaging_studies`，不含 UID、检查号 |
| DICOMweb 读影像 | OHIF 经代理读取 | 不可以（体素数据不进模型上下文） |
| 新增病灶 | 补充的病灶直接为已确认 | 只能新增待确认的病灶 |
| 确认 / 否决病灶 | 可以 | 不可以 |
| 影子模式的结果 | 只给内部评估 | 不可见 |

REST 与 MCP 的对应关系登记在 `tests/parity.test.ts`。

## DICOMweb 代理

- `GET /api/dicomweb/studies?StudyInstanceUID=…`：必须带 UID，每个 UID 都要能看到，不提供全库检索。
- `GET /api/dicomweb/studies/:uid[/...]`：路径只允许 `/studies/<UID>/…` 加字符白名单，转发到 Orthanc 的 `/dicom-web/`。
- 响应带 `Cache-Control: private, no-store`。
- BulkDataURI 指回平台：Orthanc 配置 `DicomWeb.PublicRoot = /api/dicomweb/` 决定路径；主机与协议由平台代理用 `Forwarded: host=…;proto=…` 头传给 Orthanc（取浏览器访问用的 Host / X-Forwarded-Host 与协议，字符不合法时不传）。Orthanc 不认 `X-Forwarded-Host`。2026-10-26 在 orthancteam/orthanc:26.9.1 上实测：元数据、bulk、frames 都经代理取到。

## 分析流水线（T1.4，`src/imaging/pipeline.ts`）

1. 触发：上传有新实例的检查后自动排队；也可在检查列表里「重新分析」，或由 AI 调 `imaging_study_analyze`。
2. 选序列（W1.2，`selectLungSeries`）：只看胸部 CT，排除少于 30 层的定位像；层厚大于 2.5 mm 不分析并说明原因。优先选 ≤ 1.25 mm 的肺算法序列；其次退选时，把层厚、重建核的问题写进运行摘要。
3. 排队：运行记在 `imaging_runs`，状态依次为 queued → running → done / failed。并发数由 `IMAGING_PIPELINE_CONCURRENCY` 设定，默认 1。
4. 处理：平台从 Orthanc 取出整个序列的 zip，经 `/api/v1/volume/upload` 交给 worker，再调 `/api/v1/pipeline/lung-nodule`（T1.5）。结束后调 `DELETE /api/v1/volume/:id` 释放 worker 内存。
5. 入库：每个检出写成一条 `source = ai`、`status = proposed` 的病灶。同一任务旧运行里从未经医生处理的检出标为 `superseded`，医生确认或否决过的保留。
6. 失败：如实记下原因，例如「模型不可用（HTTP 501）：…」「影像服务连接失败：…」。服务重启后，库里仍是 queued / running 的运行在列表中显示为「已中断」，可重新分析。

## 阅片器（OHIF，T2.1）

阅片器部署在独立子域名（`VIEWER_HOST`，如 `viewer.heurion.org`），与主站不同源：OHIF 这样的大型第三方前端即使有 XSS，也读不到主站浏览器里的登录令牌。

```
患者页「在阅片器中打开」
  │ POST /api/imaging/viewer-ticket {study_uid}     主站，Bearer 令牌；校验能看到该检查
  ▼ 一次性票据（aud=viewer，60 s，绑定该检查，只能用一次）
viewer.<域名>/session?ticket=…                      平台按 Host 分流到阅片器入口
  │ 换发只读 Cookie hv_dicomweb（aud=dicomweb，4 h，Path=/api/dicomweb，HttpOnly，SameSite=Strict，https 时 Secure）
  ▼ 302 → /viewer?StudyInstanceUIDs=…
OHIF（deploy/viewer 构建的镜像，根路径）            同源读 viewer.<域名>/api/dicomweb/…
```

- Cookie 只对打开过的检查有效（每打开一个检查加一个，最多 20 个），即使医生有权限，没打开过的检查也读不到。
- 账户停用、改密码、强制下线后，Cookie 和票据都立即失效。
- 阅片器子域名上只有：`/session`、只读 DICOMweb、OHIF 静态页面。主站的其它接口在那里一律 404，也不认主站令牌；反过来，主站也不认阅片器 Cookie。
- 分流只看 `Host` 头（Caddy 原样转发）；`X-Forwarded-Host` 可被客户端伪造，不用于分流。
- OHIF 会按患者 ID 查「同一患者的其它检查」。平台不提供全库检索，阅片器上这类查询返回空列表。
- 部署：Caddy 的 `viewer.{$HOSTNAME}` 站点转发到平台；平台设置 `VIEWER_HOST`、`VIEWER_URL=http://viewer:8080`；DNS 要有 viewer 子域名的记录。
- 构建：`deploy/viewer/build.sh`，用 OHIF v3.13.12 官方源码和官方 Dockerfile，加上 `deploy/viewer/app-config.js`。以后在这里加 Heurion 结节面板扩展（T2.2）。
- 2026-10-26 本机验证：Podman 里跑 Orthanc 与阅片器，worktree 里跑平台与 worker，用无头 Chromium 打开胸部 CT（269 层）。274 个 DICOMweb 请求全部成功，无失败请求、无页面错误，影像正常显示。

## 资源与排队

多人同时上传时只排队，不撑爆内存。分两层：

| 层 | 规则 | 配置 |
| --- | --- | --- |
| 平台派发 | 同时派发给 worker 的分析数有上限；按用户轮转，一人批量上传不会堵住别人；界面显示「前面还有 N 个任务」 | `IMAGING_PIPELINE_CONCURRENCY`（默认 1） |
| worker 推理闸门 | 每个任务按预计峰值占用内存预算，总和不超过预算才放行；严格先来先到；单个超预算的任务等前面跑完后独占。所有重型推理（含后台任务 `/tasks/analyze`）都经这道闸门 | `IMAGING_MEMORY_BUDGET_GB`（默认容器上限的 80%）、`IMAGING_CONCURRENCY`（默认 2）、`IMAGING_COST_<任务>_GB` |
| worker 体积缓存 | 按字节设上限，超出时淘汰最久未用的体积及其掩膜 | `IMAGING_VOLUME_CACHE_GB`（默认 6） |

肺结节模型链在本机（Apple M4 Pro，14 核，24 GB）上用 LIDC 样本实测，结果见下表。按 CPU 峰值把这条模型链登记为 18 GB、GPU 登记为 12 GB；其它推理默认登记 6 GB。

| 设备 | 总耗时 | 内存峰值 |
| --- | --- | --- |
| GPU（MPS） | 87 s | RSS 4.0 GB，占用 11.7 GB |
| CPU，全肺肺叶 | 382 s | RSS 17.3 GB |
| CPU，不做肺叶 | 198 s | RSS 12.6 GB |

生产机 64 GB：worker 容器上限 32 GB、预算 26 GB，所以 CPU 上同时只跑一例肺结节分析。worker 的 `/health` 返回闸门与缓存的实时状态。

## 待办

- PACS 自动转发（C-STORE，T3.8）开启前 `DicomServerEnabled` 保持关闭。
- 上传目前整批读入内存（默认单次上限 2 GB，`IMAGING_UPLOAD_MAX_MB`）。前端按 300 MB 分批；以后改成流式。
- Orthanc 用官方维护的 `orthancteam/orthanc:26.9.1`（amd64 / arm64）；原先的 `jodogne/orthanc-plugins:1.12.4` 只有 amd64。配置文件挂到 `/etc/orthanc/heurion.json`，`${ORTHANC_PASSWORD}` 的环境变量替换已在本机验证（无口令 / 错口令均 401）。
