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
| `imaging_runs` | AI 运行：任务、模型与版本、状态、`visibility`（visible / shadow）。阅片器点选分割每次也记一条（任务 `lung_nodule_point`），不列进检查的分析状态 |
| `imaging_lesions` | 病灶：来源（ai / manual）、状态（proposed / confirmed / rejected / superseded）、否决原因、位置、测量（JSON）、分割引用、版本号 |
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
| 新增病灶 | 补充的病灶直接为已确认（阅片器里点选） | 只能新增待确认的病灶 |
| 确认 / 否决病灶 | 可以 | 不可以 |
| 修边界、撤销补充的病灶 | 可以（阅片器里） | 不可以 |
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
  │ 换发只读 Cookie hv_dicomweb（aud=dicomweb，4 h，Path=/api，HttpOnly，SameSite=Strict，https 时 Secure）
  ▼ 302 → /viewer?StudyInstanceUIDs=…
OHIF（deploy/viewer 构建的镜像，根路径）            同源读 viewer.<域名>/api/dicomweb/… 与 /api/viewer/lesions
```

- Cookie 只对打开过的检查有效（每打开一个检查加一个，最多 20 个），即使医生有权限，没打开过的检查也读不到。
- 账户停用、改密码、强制下线后，Cookie 和票据都立即失效。
- 阅片器子域名上只有：`/session`、只读 DICOMweb、OHIF 静态页面。主站的其它接口在那里一律 404，也不认主站令牌；反过来，主站也不认阅片器 Cookie。
- 分流只看 `Host` 头（Caddy 原样转发）；`X-Forwarded-Host` 可被客户端伪造，不用于分流。
- OHIF 会按患者 ID 查「同一患者的检查」，并用结果列出左侧检查栏。平台不做全库检索，只在这张 Cookie 允许的检查里查（把允许的 UID 列表用逗号分隔转给 Orthanc，再按原条件过滤）。
- 部署：Caddy 的 `viewer.{$HOSTNAME}` 站点转发到平台；平台设置 `VIEWER_HOST`、`VIEWER_URL=http://viewer:8080`；DNS 要有 viewer 子域名的记录。
- 构建：`deploy/viewer/build.sh`，用 OHIF v3.13.12 官方源码和官方 Dockerfile，加上 `deploy/viewer/app-config.js`。以后在这里加 Heurion 结节面板扩展（T2.2）。
- 2026-10-26 本机验证：Podman 里跑 Orthanc 与阅片器，worktree 里跑平台与 worker，用无头 Chromium 打开胸部 CT（269 层）。274 个 DICOMweb 请求全部成功，无失败请求、无页面错误，影像正常显示。

## 结节面板（T2.2）

OHIF 扩展 `@heurion/extension-nodules`（`deploy/viewer/heurion-nodules/`）。构建时复制进 OHIF 源码，并在 `app-config.js` 里用 `customizationService` 的 `mode` 阶段把面板加到 viewer 模式右侧第一位，不改 OHIF 自带模式的源码。

- 列表：阅片器子域名上的 `GET /api/viewer/lesions?StudyInstanceUID=`，只限 Cookie 允许的检查。显示位置（肺叶）、平均径（长 × 短）、体积、密度类型、CT 值、检出分数、分割失败等提示、状态与否决原因。
- 跳转：worker 给每个结节输出关键层的 `key_slice_sop_instance_uid` 与病人坐标 `center_lps_mm` / `box_lps_mm`（DICOM LPS，mm），平台入库到病灶 `metrics`。面板按 SOPInstanceUID 在视口的影像列表里定位，必要时先把所在序列放进视口，再切到肺窗 W1500 / L−600。结节中心不一定落在关键层上（相差可达一个层厚）。
- 确认 / 否决：`POST /api/viewer/lesions/:id/review`，只限 Cookie 允许的检查，并且必须带 `X-Heurion-Viewer: 1` 请求头（跨站表单带不上，防 CSRF）。否决须选原因：血管断面、纤维灶 / 瘢痕、钙化灶、淋巴结、伪影、其他。写入以医生本人身份经同一服务层，留痕与主站一致。主站对应接口为 `GET …/studies/:stid/lesions`（AI 用 `imaging_lesions` 只读）和 `POST …/lesions/:lid/review`（AI 不可用）。
- 重新分析：与医生已确认 / 否决的结节是同一处的检出不再新增（两边都有病人坐标时按坐标距离判断，否则在同一序列内按体素坐标），运行摘要记 `matched_reviewed`。
- 轮廓（T1.6）：worker 为每个分割成功的结节生成 DICOM SEG 的一个 segment（BINARY，引用源序列；category SCT 49755003、type SCT 27925004、部位 SCT 39607008；推荐显示色为黄色）。平台存回 Orthanc，登记为检查的派生序列，病灶记 `seg_ref = <序列行 id>#<segment 编号>`。面板点结节时先显式加载 SEG（`displaySet.load`）并叠加到当前视口，只画描边、不填充，再跳到 segment 中心并高亮；SEG 在阅片器里只读（`panelSegmentation.disableEditing`）。没有 SEG 的结节仍按关键层跳转。
- 旧 SEG 清理：重新分析后，曾被病灶引用、且引用它的病灶全部已被取代的 SEG，从 Orthanc 删除并删索引（访问留痕 `imaging_seg_removed`）；本次新生成但没有任何病灶引用的 SEG（其中结节都与已审核结节重合）当场删除。医生确认 / 否决过的结节所引用的 SEG 一律保留。运行摘要记 `seg_removed`。
- 截断提示：只对挑出的结节掩码判断是否碰到 VISTA-3D 推理窗口边界（窗口边界就是体积边缘时不算）。原先按原始输出判断，血管等无关连通域碰边也会误报。
- 面板提示：每个结节只突出一条需核对的要点（分割失败 / 可能被截断），worker 的完整提示收在「详情」里。
- 源图缺 FrameOfReferenceUID 时（本机测试数据由 pydicom 生成，就缺这一项），SEG 用按源序列派生的参照系 UID，运行摘要写明。OHIF 按 SOP 引用对位，实测叠加位置正确；扫描仪产生的 CT 都带这个 UID，不会走这条路。
- 2026-10-26 本机验证（无头 Chromium，胸部 CT 269 层）：
  - 面板列出结节，确认与否决都能保存，平台留痕正确。
  - 点结节 4 后视口显示 `I:129`，正是关键层 CT_0129。
  - 重新分析时 2 个已审核结节没有重复新增。
  - 随访 CT：点 1 号结节后跳到 `I:222`，结节外画出黄色描边，没有缺显示色的提示。

## 点选补漏与修边界（T2.3）

医生在阅片器里点结节，VISTA-3D 按点分割、测量，生成轮廓。平台 `src/imaging/interactive.ts`，worker `lung_nodule_pipeline.segment_nodule_at_points`。

- 面板操作：
  - 「点选添加结节」后在影像上点漏掉的结节，新建医生补充的病灶（直接为已确认，编号「医生补充 N」）。
  - 结节上的「修正边界」：「补入」点属于结节的部分，「排除」点不属于的部分；每点一次重新分割；可「撤销上一点」。
  - 医生补充的结节可「撤销」（标为 superseded，不再列出）；AI 检出的结节仍用否决。
  - Esc 退出点选。单击取 cornerstone3D 的 `CORNERSTONE_TOOLS_MOUSE_CLICK` 事件（按下后未拖动即松开），拖动调窗不受影响。
- 接口（阅片器子域名，Cookie 允许的检查，必须带 `X-Heurion-Viewer: 1`）：
  - `POST /api/viewer/series/prepare {study_uid, series_uid}`：面板打开后预加载当前 CT 序列。
  - `POST /api/viewer/lesions/point {study_uid, series_uid, points}`：补漏，201。
  - `POST /api/viewer/lesions/:id/refine {points, replace?}`：修边界。
  - `POST /api/viewer/lesions/:id/withdraw`：撤销医生补充的病灶。
  - `points` 为病人坐标 `[{lps_mm: [X, Y, Z], positive}]`，最多 20 个。主站没有这些接口，AI 也不能调用（服务层拒绝 `via = ai`）。
- 分割：
  - 第一个正点决定 VISTA-3D 推理窗口（与模型链相同，约 144 mm 见方），其余正 / 负点一并作为提示。
  - 点提示的类别为「肺肿瘤」（VISTA-3D 全局类别 23），按 MONAI 约定点标签加 2。
  - 只保留包含正点的连通域；正点落在边缘外 3 mm 内时吸附到最近的连通域。
  - 修边界时用该结节此前的全部点加新点；AI 结节没修过时以其中心为第一个正点。
- 选「肺肿瘤」类别的依据（2026-10-26 本机实测）：
  - LIDC 样本标注结节的 Dice：中心点 0.82、偏心点 0.85；纯点提示为 0.80 / 0.80。
  - 点在肺实质、血管上时，纯点提示沿肺实质扩散成 40~80 万体素的大块；加类别后多数只有几千体素，个别血管点仍有 19 万体素。
  - 只有一个标注结节，证据有限，以后用 T1.7 的评估集复核。
- 结果检查：
  - 点击处没有分割到结构：422 并写明原因，不建病灶。
  - 点到列表里已有（待确认 / 已确认）的结节：409「这里已有「结节 N」」，不重复添加、不存轮廓；否决过的不算，医生可以补回。
  - 长径超过 30 mm 时提示可能沿血管或胸膜扩散，请加排除点核对。
- 轮廓：每次点选生成只有一个 segment 的 DICOM SEG（SegmentAlgorithmType = SEMIAUTOMATIC，序列描述 `Heurion lung nodule (point prompt)`），存回 Orthanc。
  - 面板不刷新页面即加载：清掉 OHIF 按检查缓存的元数据请求，再按序列取。
  - 换下的旧 segment 在视口里隐藏。
  - 修边界后，点选产生的中间轮廓没有病灶再引用时从 Orthanc 删除，阅片器里一并移除。AI 分析的原始 SEG 保留，作为 AI 原值的追溯依据和「AI 轮廓 / 医生修正」的配对数据（W7）。
- 留痕：
  - 每次点选记一条运行：模型版本、所在序列、点数、负点数、耗时、是否分割到；未分割到或重复点选也记。
  - 病灶测量里存 `prompt_points`、`point_run_id`；修边界版本号加一，事件 `edit`；撤销记 `withdraw`。
- 肺叶：局部肺叶分割约占点选总耗时的一半，所以点选先返回轮廓与测量（`lobe_status = pending`，面板显示「肺叶定位中…」），平台在后台调 `POST /api/v1/pipeline/lung-nodule/lobe` 补上。
  - 只在病灶版本未变时写入（期间又修了边界就以新的为准），不加版本号，事件 `locate`。
  - 结节周围没有肺叶体素或失败时写明原因，在面板「详情」里显示。
- 序列缓存：worker 里以 `series_<序列行 id>` 缓存；同一序列的并发预加载共用一次上传。worker 重启或按内存淘汰后，点选收到 404 时重新上传再试一次。
- 资源：点选与补肺叶走 worker 推理闸门的交互通道（见「资源与排队」），不排在整例分析后面。
- 耗时（2026-10-26 本机，随访 CT 512 × 512 × 269）：

  | 设备 | 点选（worker） | 浏览器里点击到新结节出现 | 修边界一次（接口往返） | 后台补肺叶 |
  | --- | --- | --- | --- | --- |
  | GPU（MPS，M4 Pro） | 1.15~1.2 s（VISTA-3D 1.1 s、测量 0.02 s、SEG 0.01 s） | 1.6~1.7 s | 1.2~2.4 s | 2.4 s |
  | CPU（6 线程，M4 Pro） | 4.9~5.5 s（首次加载模型另加 1.4 s） | — | — | 20 s |

  PRD 目标 ≤ 1 秒要靠 CUDA GPU（T0.5）。测量原先对整卷做连通域（约 0.7 s），改为只在推理窗口和结节周围算。把推理窗口缩到 96 mm 以下能快一些，但同一结节体积随之变化（2188 → 1931 → 1530 mm³），没有采用。
- 2026-10-26 浏览器验证（无头 Chromium，随访 CT）：
  - 结节 1 加排除点后平均径 15.9 → 15.4 mm，撤销上一点后回到 15.9 mm，黄色轮廓随之更新。
  - 点已有的结节 1，提示重复，不建病灶。
  - 否决低分候选 C5 后在该处点选补回，新结节 1.7 s 出现在列表；稍后肺叶显示「未定」，详情写明周围 10.6 mm 内没有肺叶体素。该候选其实在胸骨上窝软组织里，并非结节，这里只验证流程。
  - 撤销后列表恢复，阅片器里的 SEG 序列与 Orthanc 一致。

## 资源与排队

多人同时上传时只排队，不撑爆内存。分两层：

| 层 | 规则 | 配置 |
| --- | --- | --- |
| 平台派发 | 同时派发给 worker 的分析数有上限；按用户轮转，一人批量上传不会堵住别人；界面显示「前面还有 N 个任务」 | `IMAGING_PIPELINE_CONCURRENCY`（默认 1） |
| worker 推理闸门 | 每个任务按预计峰值占用内存预算，总和不超过预算才放行；严格先来先到；单个超预算的任务等前面跑完后独占。所有重型推理（含后台任务 `/tasks/analyze`）都经这道闸门 | `IMAGING_MEMORY_BUDGET_GB`（默认容器上限的 80%）、`IMAGING_CONCURRENCY`（默认 2）、`IMAGING_COST_<任务>_GB` |
| 交互通道 | 阅片器点选分割与补肺叶排在所有普通任务之前、不占并发名额；普通任务只能用到「预算 − 交互预留」，留出的内存保证点选不必等整例分析跑完 | `IMAGING_INTERACTIVE_RESERVE_GB`（默认 4）；点选登记 CPU 4 GB / GPU 3 GB |
| worker 体积缓存 | 按字节设上限，超出时淘汰最久未用的体积及其掩膜 | `IMAGING_VOLUME_CACHE_GB`（默认 6） |

肺结节模型链在本机（Apple M4 Pro，14 核，24 GB）上用 LIDC 样本实测，结果见下表。按 CPU 峰值把这条模型链登记为 18 GB、GPU 登记为 12 GB；其它推理默认登记 6 GB。

| 设备 | 总耗时 | 内存峰值 |
| --- | --- | --- |
| GPU（MPS） | 87 s | RSS 4.0 GB，占用 11.7 GB |
| CPU，全肺肺叶 | 382 s | RSS 17.3 GB |
| CPU，不做肺叶 | 198 s | RSS 12.6 GB |

生产机 64 GB：worker 容器上限 32 GB、预算 26 GB、交互预留 4 GB，所以 CPU 上同时只跑一例肺结节分析（18 GB ≤ 22 GB），同时还能做点选。worker 的 `/health` 返回闸门与缓存的实时状态。

## 待办

- PACS 自动转发（C-STORE，T3.8）开启前 `DicomServerEnabled` 保持关闭。
- 上传目前整批读入内存（默认单次上限 2 GB，`IMAGING_UPLOAD_MAX_MB`）。前端按 300 MB 分批；以后改成流式。
- Orthanc 用官方维护的 `orthancteam/orthanc:26.9.1`（amd64 / arm64）；原先的 `jodogne/orthanc-plugins:1.12.4` 只有 amd64。配置文件挂到 `/etc/orthanc/heurion.json`，`${ORTHANC_PASSWORD}` 的环境变量替换已在本机验证（无口令 / 错口令均 401）。
