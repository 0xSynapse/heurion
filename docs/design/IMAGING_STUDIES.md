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
| `imaging_reading_roles` | 阅片角色（T2.7）：成员是初写（reader，默认）还是审核（reviewer），由机构管理员设置 |
| `imaging_read_submissions` | 初写完成（提交审核）：谁、何时、当时的留痕位置 |
| `imaging_signoffs` | 定稿：检查、版本号、谁、何时、留痕位置、模式（dual / self / single）、本轮初写医师、病灶快照与其 SHA-256；只追加 |
| `imaging_followups` | 随访对比的每次匹配：本次检查、前片、触发方式（auto / manual）、状态、原因、配准与计数摘要（T2.4） |
| `imaging_lesion_links` | 两期病灶的对应：本次病灶、前片病灶（新发 / 消失只有一侧）、来源（ai / manual）、状态（active / superseded）、变化分类、匹配当时的指标快照 |
| `imaging_link_events` | 对应关系的每次改动：自动匹配、重新匹配、医生拆开 / 重新对应、失效 |
| `imaging_series_anchors` | 旧分析没有肺部锚点时补算的结果（按序列缓存） |

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
| 影子模式的结果 | 不可见；机构管理员看影子期对照报告 | 不可见（对照报告也不给） |
| 审核视图、审核状态、定稿快照 | 可以 | `imaging_review`（只读） |
| 初写完成（提交审核） | 可以（医生本人的声明） | 不可以 |
| 定稿 | 只有审核医师（个人空间为本人） | 不可以（PRD 第 6 节「禁止」类） |
| 设置阅片角色、是否允许自审 | 机构管理员 | 不可以 |
| 随访对比 | 看；重新匹配；拆开、重新对应 | `imaging_followup` 只读 |

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

## 影子模式（T1.8）

一期上线前做回顾评估（PRD 关口 G1）用：AI 照常分析，结果不让医生看到，以免影响判断；医生正常阅片，在阅片器里标出结节，作为参照。

- **开关**：机构设置 `imaging_ai_visibility`，取值 `visible`（默认）或 `shadow`。由机构管理员在「机构管理 → 概览与设置」中修改，AI 经 `tenant_admin update_settings` 修改时须管理员确认。
- **作用范围**：只影响新排队的自动分析（上传后自动分析、重新分析、AI 调 `imaging_study_analyze`）。每次运行入队时把设置值记进 `imaging_runs.visibility`，事后改设置不改变已有运行。
  - 切回 `visible` 后，影子期的结果依旧不显示。
  - 医生在阅片器里的点选分割显式记为 `visible`，不受影子模式影响。
- **不可见的范围**：
  - 检查列表不列影子运行，病灶数不计影子检出；`ai_shadow = true` 告诉界面和 AI 「结果不显示，不是没有结节」。
  - 病灶列表、阅片器结节面板、`imaging_lesions` 都不返回影子检出。按病灶 id 确认、否决、修改、看留痕，一律当作不存在（404）。
  - 上传、重新分析和 `imaging_study_analyze` 都不返回影子运行的 id，只返回 `shadow: true`。
  - 影子运行的 DICOM SEG 不存入 Orthanc。存进去的话，OHIF 左侧序列栏会直接列出这个序列。所以影子期的检出只有中心、框和测量，没有轮廓。
- **影子与显示互不干扰**：
  - 重新分析只取代同一可见性下旧运行的待确认检出（`supersedeProposed`）。
  - 影子运行不和医生已审核的结节去重，对照需要 AI 的全部检出。
- **影子期对照报告**：`GET /api/imaging/shadow-report[?since=YYYY-MM-DD]`。
  - 只给机构管理员本人在界面上看。服务层拒绝 `via = ai`，parity 测试登记在 NOT_FOR_AI。读取时记机构审计 `imaging.shadow_report`。
  - **配对方法**：每个检查取最近一次完成的影子肺结节分析，与医生标注的结节配对。医生标注指阅片器里补充的结节，以及确认过的正式检出；撤销、否决的不算。按病人坐标最近者优先配对，中心距离不超过两者较大的半径（至少 3 mm）。没有病人坐标的检出配不上。
  - **输出内容**：
    - 每个检查：AI 检出数、医生标注数、配对数、只有 AI 的检出数、漏检结节（平均径与位置）。
    - 运行情况：完成、失败（附原因）、未完成，以及入队到结果就绪的 P50 / P90。G1 要求「影子期无重大故障」和 P90 ≤ 3 分钟，这两项正好对应。
    - 汇总：敏感度与每例只有 AI 的检出数，只按有医生标注的检查计算。
  - **局限**：
    - 医生没在阅片器里标的检查，无法区分「没有结节」和「没标」，不计入敏感度。
    - 「只有 AI 的检出」可能是假阳性，也可能是医生漏标，需要复核。
    - 报告只有统计和内部 id，按结节类型、尺寸分层的正式评估仍用锁定测试集（T1.7）。

## 审核与定稿（T2.7）

PRD W5.1（审核视图）、W5.2（审核医师修改并定稿）。代码：`src/imaging/review.ts`，接口 `src/http/routes/imaging-review.ts`，AI 工具 `src/mcp/imaging-review-tools.ts`，界面 `web/src/imaging-review.ts`（患者页影像检查表的「审核」列）。

### 阅片角色

- 每个机构成员在影像上是「初写」（reader，默认）或「审核」（reviewer）。机构管理员在「机构管理 → 成员与邀请」的「阅片角色」列里设置（`PUT /api/imaging/reading-roles/:uid`）。
- 角色存在机构患者库的 `imaging_reading_roles`，按机构隔离，不改平台账户表和科室表。没有挂在科室上：一个人可在多个科室，而签发权限是个人的；科室的 `department_members` 每次整体重写，也不适合挂属性。
- 成员离开机构（被移出或自己退出）时删除其角色行（`TenantService.onMemberLeft`），再被邀请加入时从初写重新开始，不会悄悄恢复定稿权限。
- 个人空间（个人租户）没有角色：本人就是唯一的医生，可以直接定稿（`mode = single`），不需要「初写完成」。

### 流程与状态

按检查定稿：一次检查的结节集合一起签，符合放射科「初写—审核—签发」的流程。

```
初写中 ──初写完成──▶ 待审核 ──定稿──▶ 已定稿 v1 ──任何病灶改动──▶ 定稿后修改中 ──定稿──▶ 已定稿 v2 …
reading            submitted         finalized               amending
```

- 状态不另存，由留痕推出：「留痕位置」= 检查可见病灶的最大事件 id（不含定稿标记、不含影子病灶）。最近一次定稿的留痕位置与当前相同即「已定稿」，否则「定稿后修改中」。所以主站确认 / 否决、阅片器点选 / 修边界 / 撤销、后台补肺叶、AI 重新分析产生的新检出，都会让已定稿的检查回到「定稿后修改中」，不需要在每条写路径里加钩子。
- 定稿后的修改不阻止（诊疗组成员仍可在阅片器里改），但不覆盖：旧快照原样保留，随访库仍读旧快照，直到审核医师再次定稿生成新版本。
- 重新分析：定稿后仍可以重新分析。和已审核结节重合的检出不入库，检查保持已定稿；有新检出时变成待确认，检查进入「定稿后修改中」，处理后再定稿。影子模式的运行不影响审核状态（影子病灶不在留痕位置里）。
- 不提供「撤销定稿」：只能改了再定一版。

### 定稿规则

`POST /api/patients/:ptid/imaging/studies/:stid/finalize {expected_revision, note?}`，返回 201 与快照。依次检查：

| 情况 | 结果 |
| --- | --- |
| AI（`via = ai`） | 403；接口登记在 NOT_FOR_AI，也没有对应 MCP 工具 |
| 不在诊疗组（含机构全员可见、紧急访问的只读者） | 403 / 404（与其他写操作一致）。审核医师须先加入诊疗组 |
| 角色不是审核（机构） | 403 `not_reviewer` |
| 没带 `expected_revision`，或与当前留痕位置不同（打开审核视图后有人改了病灶，或别人已定稿） | 400 `revision_required` / 409 `stale_revision` |
| 已定稿且之后没有改动（两位审核医师同时点，后到的） | 409 `already_finalized`。同一库的写是串行的；多进程时 `UNIQUE (study_id, version)` 兜底，同样返回 409 |
| 首次定稿前没有人「初写完成」（机构） | 409 `not_submitted` |
| 自审（见下）且机构不允许 | 403 `self_review` |
| 还有待确认的 AI 检出 | 409 `pending_lesions`：必须逐个确认或否决，不提供「一并确认」 |
| 有结节的肺叶还在后台定位 | 409 `locating`（否则定稿后定位结果一到就变成「定稿后修改中」） |
| 本检查的 AI 分析正在排队 / 运行（本进程里真的在跑的；服务重启残留的不算） | 409 `analysis_running` |
| 没有结节 | 可以定稿：「未见结节」也是结论，快照为空 |

- **自审**：本检查的「初写医师」= 提交过初写完成的人 ∪ 做过初写阶段修改的人。定稿人属于初写医师，或根本没有初写医师，就是自审。默认禁止；机构设置 `imaging_self_review = true`（人手不足的科室）后允许，定稿记 `mode = self`。后续版本（v2…）沿用全部历史上的初写医师，所以审核医师改了再签不算自审。
- **初写 / 审核修改的划分**（只看留痕）：首次「初写完成」之前的医生改动都算初写，包括审核医师提前动手的（此人因此也成为本检查的初写医师，不能自审）；之后的改动，提交过初写的人或角色不是审核的人做的算初写，其余算审核。AI 检出的 `create` 是 AI 原值；`supersede`、`locate`、`finalize` 是系统留痕，不算任何一方的修改。
- **快照**：检查当前全部病灶（不含影子与已取代的）的 id、版本、状态、否决原因、名称、位置、测量、分割引用；记 SHA-256。表上有触发器，`UPDATE imaging_signoffs` 一律失败（删患者时级联删除仍可）。
- **留痕**：每个病灶记一条 `finalize` 事件（after 里是定稿 id、版本与当时的病灶版本），患者访问日志 `imaging_finalize`，平台审计 `imaging.finalize`（详情含版本、模式、病灶数、快照 hash）。初写完成记 `imaging_read_submit` 与 `imaging.read_submit`；设置角色记 `imaging.reading_role`。审核意见与初写说明加密存放。

### 审核视图（W5.1）

`GET /api/patients/:ptid/imaging/studies/:stid/review`（AI：`imaging_review`）。数据全部来自 `imaging_lesion_events`，不另记一份：

- 每个结节：AI 原值（AI 检出 `create` 事件的 after；医生补充的给出谁、在哪个阶段补充）、初写修改、审核修改（每条带事件 id、时间、操作者、字段级前后值、发生在第几版定稿之后）、当前值、状态与版本、在最近一次定稿里的版本以及是否与当前一致。
- 定稿后被撤销的结节列在 `removed_since_finalized`。影子检出和其他已取代的结节不列。
- `revision`：定稿请求要带回的留痕位置。`finalize.allowed / blockers`：当前操作者能否定稿及原因（AI 读到的永远是不能）。
- 定稿历史 `signoffs`；`GET …/signoffs/:seq` 取某一版的完整快照。
- 跳转：视图里每个结节的「跳转」打开阅片器并定位到该结节（票据接口接受 `lesion_id`，经 `/session` 带到 OHIF 地址的 `HeurionLesion` 参数，结节面板据此定位；只是界面定位，不是权限）。
- 阅片器结节面板顶部显示审核状态；已定稿时提示「此时修改会生成新的定稿版本」。

### 随访库

- `ImagingReviewService.finalizedLesions(actor, studyId)`：最近一次定稿快照里已确认的结节（版本与测量为签字时的值），`stale = true` 表示之后又有未定稿的改动；没定稿过为 null。
- `finalizedStudies(actor, patientId)`：患者全部已定稿检查，按检查日期从早到晚。
- 随访对比（T2.4）与科研取数应改用这两个方法，只读医生签过的值。

## 随访对比（T2.4）

PRD W3：同一患者的前后两期胸部 CT，配准后对应结节，标出新发、消失、增大、缩小、稳定，给出径线与体积变化和体积倍增时间（VDT）。平台 `src/imaging/followup.ts`，worker `src/nodule_matching.py`。

### 流程

1. 触发：本次检查的肺结节分析成功入库后自动排一次匹配（`ImagingPipeline` 的 `onRunDone`）；阅片器结节面板里可「重新匹配」（主站也有对应接口，患者页暂未加按钮）。影子模式的运行不触发，影子运行的病灶两期都不参与。
2. 找前片（`findPrior`）：同一患者、检查日期严格早于本次的 CT，从近到远取第一个有参照病灶的检查。
   - 参照病灶：前片里已确认的肺结节（`DEFAULT_REFERENCE.prior = ['confirmed']`）。T2.7 定稿上线后改这一处为优先「定稿」。本次参与对比的是待确认与已确认的结节，所以本次分析刚完成、医生还没审核时对比就已就绪。
   - 本次没有检查日期：不找前片，说明原因。没有检查日期的其他检查不参与；同一天的其他检查不作前片（分不清先后，间隔 0 天），在说明里列出。
   - 更近的前片还没有确认的结节时退到更早的一期，并说明「某日的检查有 N 个待确认的 AI 检出、还没有确认的结节」。
   - 预计算（W3.1）：最近的一期前片从没分析过时，用同一条流水线排队分析它。只追溯这一期：因预计算而分析的检查，其完成后的匹配不再往更早追溯，避免连锁分析全部历史。前片的检出确认后需要重新匹配一次（目前不在确认时自动重匹配）。
3. 肺部锚点：worker 跑肺结节模型链时顺带计算 `series_qc.lung_anchor`（降采样到约 4 mm，体表逐层填洞后取 < −500 HU 的体内含气，保留不小于最大者 15% 的连通域；给出肺质心、肺尖高度、包围盒；整例约 0.02~0.07 s）。旧分析没有锚点时，平台从 Orthanc 取出该序列交给 `POST /api/v1/pipeline/lung-nodule/anchor` 补算并缓存到 `imaging_series_anchors`；序列已不在 Orthanc 时如实说明，只用结节配准。
4. 配准与指派（worker `POST /api/v1/pipeline/lung-nodule/match`，只读坐标与大小，不读体素、不经推理闸门）：
   - 不同日期检查的 LPS 坐标原点由扫描床位置决定，两期可相差几百毫米。锚点平移：左右、前后取肺质心之差，头足方向两期肺尖都在扫描范围内时取肺尖高度之差（受吸气程度影响小于质心），否则取质心之差。
   - 刚性配准：结节对给出平移假设（有锚点时只取锚点平移 ±35 mm 内的），按一一对应的内点数（容差 6 mm + 0.5 × 较大平均径）选最优，再迭代最近点（内点 ≥ 3 时 Kabsch 刚性，旋转超过 10° 视为体位差异过大，只做平移）。锚点窗外有明显更多一致结节对（≥ 3 且比窗内多 2 个）时以结节为准并写明。医生已确认的对应作为已知内点参与配准。
   - 指派：配准后按质心距离做匈牙利指派（`scipy.optimize.linear_sum_assignment`）。门限 = max(10 mm, 较大平均径) + 配准不确定度（可靠时 max(2 mm, 2 × 残差 RMS)，粗配准时 12 mm）。两侧肺叶都已知且不同时代价加 5 mm，不作硬约束（叶间裂附近的肺叶分割可能出错）。门限内还有其它候选时标为有歧义并列出候选。
   - 配准质量：`fine` = 至少 3 个一致的结节对，或 2 个且与锚点一致，或有医生确认的对应；`coarse` = 只有锚点，或只有 2 个结节对而没有锚点；`none` = 都没有，按原始坐标比对并写明不可靠。不做形变配准：吸气程度不同造成的下叶结节位移由门限吸收，超出时如实给出新发 / 消失，并标需核对。
5. 入库：自动匹配的链接（`source = ai`）每次重匹配整体换新；医生的对应（`source = manual`）保留，病灶不再可参与时失效（留痕 `invalidate`）。没有病人坐标的结节不参与，列为「未对比，可手动对应」。

### 变化分类与误差范围

| 项 | 规则 |
| --- | --- |
| 新发 / 消失 | 本次 / 前片的结节没有对应 |
| 依据 | 两期都有体积（分割成功）时按体积，否则按平均径 |
| 稳定（在误差范围内） | 体积变化 < ±25%；或平均径变化 ≤ 1.5 mm |
| 增大 / 缩小 | 超出上述范围 |
| VDT | Schwartz：间隔天数 × ln2 / ln(V2 / V1)。只在两期都有体积、间隔 > 0 天且体积增大时给出；体积缩小或不变时注明「不适用」；增大但在误差内时照给并注明「不可靠」 |

- 阈值依据（凭文献记忆写出，本次没有联网核对原文；本平台 AI 分割的重复性也还没在本机构数据上实测，所以是临时值，可用 `IMAGING_FOLLOWUP_VOLUME_TOL_PCT`、`IMAGING_FOLLOWUP_DIAMETER_TOL_MM` 调整）：
  - 体积 ±25%：BTS 肺结节指南（Callister 等，Thorax 2015）以体积变化 ≥ 25% 为有意义的生长；Fleischner 学会 2017 年的测量声明（Bankier 等，Radiology 2017）指出不同扫描间半自动体积测量的差异可达约 25%。
  - 平均径 1.5 mm：Lung-RADS v2022 以平均径增大 > 1.5 mm 定义「生长」。Fleischner 2017 认为 < 2 mm 的径线变化不能可靠判断；取 1.5 mm 与 Lung-RADS 一致，偏敏感。
- 体积与平均径变化方向相反且都超出误差时，提示核对分割。
- 两期层厚不同（相差 > 0.3 mm）或有 > 1.25 mm 的厚层时，在说明里提示体积可比性下降；阈值不随层厚改变。
- 变化在读取时按两侧病灶的当前测量重新计算（医生修边界后随之更新）；链接里另存匹配当时的快照。

### 病灶状态改变后的对应

- 本次的结节被否决、撤销或被重新分析取代：前片对应的结节显示为「消失」并标需核对。前片的结节不再是确认状态：本次结节显示为「新发」并标需核对。
- 匹配之后新增的结节（点选补充、重新分析的新检出）或前片新确认的结节：显示为「未对比」，提示重新匹配。重新分析成功后会自动重匹配。
- 前片没了（如前片的结节全被否决）：重新匹配时所有现行链接失效（`no_prior`）；换了前片（`prior_changed`）同理。

### 医生调整与权限

- 拆开：一对对应改为本次「新发」+ 前片「消失」。重新对应：本次结节对应到前片的另一个结节，或选「前片没有」；双方原来的对应失效，另一方改为单侧。都记 `imaging_link_events`（谁、经人还是 AI、动作、改前、改后），并记患者访问留痕 `followup_*`。
- 前片结节只能来自当前的前片检查，不能与同一检查里的结节对应（409）。
- 接口：
  - 主站：`GET /api/patients/:ptid/imaging/studies/:stid/followup`（AI 用 `imaging_followup` 只读）、`POST …/followup/rematch`、`POST …/followup/links {lesion_id, prior_lesion_id}`、`POST /api/patients/:ptid/imaging/followup-links/:lkid/unlink`。
  - 阅片器子域名：`GET /api/viewer/followup?StudyInstanceUID=`、`POST /api/viewer/followup/rematch {study_uid}`、`POST /api/viewer/followup/links {study_uid, lesion_id, prior_lesion_id}`、`POST /api/viewer/followup/links/:id/unlink`。写接口要求 Cookie 允许的检查与 `X-Heurion-Viewer: 1`，与确认 / 否决相同。
  - 阅片器里读本次检查的对比会带出前片结节的编号、肺叶和测量（不含前片 UID），这是医生对该患者本就有权看到的信息；按前片的 UID 读对比仍要求前片在 Cookie 里。
- 写操作服务层拒绝 `via = ai`（parity 测试登记在 NOT_FOR_AI）。非诊疗组成员读写都当不存在（404）。
- 并发：同一检查正在匹配时再触发不另起，合并为「这次完成后再跑一次」。服务重启时没完成的匹配显示为「已中断」，可重新匹配。worker 失败时记失败原因，原有链接不动。

### 结节面板

- 顶部：前片日期与间隔、配准质量（不可靠时用醒目颜色）、误差范围、说明（锚点、层厚、跳过的检查等）、前片里消失的结节、「重新匹配」。
- 每个结节：变化分类、前片对应结节（编号与平均径）、Δ平均径、Δ体积（含百分比）、VDT、「在误差范围内」、「医生对应」「请核对」；「拆开」「改对应」（下拉选前片结节或「前片没有」）。
- 两期并排、联动翻页（W3.4，P1）本次没做：OHIF 的挂片协议要按两期检查改，面板只给出前片对应结节的信息。

### 局限与待办

- 合成点集与合成胸部体积上验证了配准与锚点（`tests/test_nodule_matching.py`）；本机三例真实 CT（LIDC、肺部样本、COPD）上锚点能找到两肺与肺尖，但还没有真实的两期同一患者数据验证匹配准确率，上线前要用随访病例集评估。
- 只做刚性配准；吸气差异大、体位差异大（如俯卧 / 仰卧）时只能如实降级。
- 前片确认结节后不会自动重匹配，需医生点「重新匹配」（T2.7 定稿上线后可在定稿时触发）。

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

## 报告里的测量数字（测量原子，T2.5）

报告里病灶的大小、体积、CT 值写成测量原子 `[@m:id]`，绑定已确认病灶的测量；医生重测后报告里的数字随之更新，AI 不能手写测量数字。设计与规则见 `docs/PLATFORM.md` §5.5.1。

- 读病灶经 `ImagingStudyService.measurementSource`（读权限，影子病灶当不存在）；只能绑定 `status = confirmed` 的病灶。
- 病灶被否决、撤销或被取代后，报告里对应的数字醒目标出，导出时注明。
- 文档读者没有该患者权限时只看到绑定时的快照。
