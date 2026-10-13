# Spike：编辑面选型 — Collabora Online（#4）

**Status:** 结论：**采纳 Collabora CODE 作为 doc 与 deck 的统一编辑面（S4）**；TipTap + XML 补丁器降级为备选。
**验证日期:** 2026-10-01
**验证环境:** macOS arm64 + podman（libkrun VM）+ `collabora/code:latest`（CODE 26.04.4.2）

---

## 1. 许可结论（生产前必须知道的事）

| 项 | 结论 |
|---|---|
| 源码 | MPL-2.0（[官方许可页](https://www.collaboraonline.com/terms/collabora-online-mplv2/)） |
| 官方二进制（`collabora/code` 镜像） | **附专有条件分发**；商标与 CSS 主题归 Collabora 专有 |
| CODE 定位 | 官方明确「仅测试/家用/小团队，**不建议生产**」——本意是逼企业用户订阅或自建 |
| 生产路径 | ① 买 Collabora Online（COOL）订阅；② 从 MPLv2 源码自建、去 Collabora 商标、自行维护 |
| 本项目 POC | ✅ 本地开发/评测用 CODE 二进制完全合规（这正是它的定位） |
| 本项目生产 | ✅ **已定（2026-10-01）：从 MPLv2 源码自建**——去 Collabora 商标/CSS 主题、自行构建与维护，不买 COOL 订阅。代价：安全补丁需自己跟踪 backport（参考 Nextcloud 社区的同类实践）；收益：无按人订阅成本、不受 CODE 的非生产条款约束。列入 M2 上线前工作 |

## 2. 集成面：最小 WOPI host（已实现并验证）

协议面只实现 CODE 依赖的三个入口（`apps/server/src/routes/wopi.ts`，~150 行）：

| 入口 | 实现 | 验证 |
|---|---|---|
| CheckFileInfo `GET /wopi/files/:docId` | BaseFileName/Size/UserCanWrite/LastModifiedTime/OwnerId/UserId + `UserCanNotWriteRelative` | ✅ 宿主与 podman 网络内（alpine 侧车）双端 200 |
| GetFile `GET .../contents` | head 版本字节直出 | ✅ 4314 字节往返 |
| PutFile `POST .../contents` | **用户保存 = 落 `user` 版本**（与 AI 落版同一条投影/漂移审计管线） | ✅ 200 + 新时间戳回传 |

鉴权：`access_token` = 按文档签发的 HMAC 令牌（复用文献 MCP 的 signDocToken），token 内绑 docId、与路径参数双重校验。

iframe 嵌入：`GET /api/docs/:id/editor` 返回 `{urlsrc, access_token, wopisrc}`（discovery 按 MIME 匹配 docx/pptx 的 `name="edit"` action，缓存 1h）；前端 `EditorOverlay` 以 form POST 提交 access_token 进 iframe，监听 `close` 消息返回并刷新。

## 3. 版本守卫映射（本轮最有价值的发现）

**LibreOffice / Collabora 回写会重新生成全部内嵌 id**（实测容器 LO 7.4 与 LO 源码双证：docx 的 `w14:paraId` 与 pptx 的 `cNvPr@id` 都在导出时重新生成，不回写导入值——`docxattributeoutput.cxx` 里 paraId 走 `m_nNextParaId++`）。这意味着**用户在 Collabora 里保存一次，所有评论锚点即报废**——spike 若只做协议层验证会漏掉这个坑。

对策已落地（S4 关键路径）：每次落版跑 **id 对齐重建（reconcile）**——把「文本未变」的段落/形状恢复成上一版 id（文本对齐 + 插入窗口容忍）；被改写的段落保留新 id（正是漂移语义）。效果：

- python-docx（AI 回合）天然保留 id，reconcile 为 no-op；
- Collabora 保存后，未触碰内容的 id 100% 恢复（单测覆盖）；
- 版本 meta 同时记录 `id_survival`（对齐后的锚点连续率，告警阈值 0.8）与用户保存的 `user_ops`（S5 三方合并的输入）。

CODE 原生**外部变更检测**与 §4.3 写后合并语义严丝合缝：

- CheckFileInfo 返回 `LastModifiedTime`（= head 版本时间）；
- PutFile 带 `X-COOL-WOPI-Timestamp`，与 head 不一致（编辑期间 AI 落了新版本/回滚）→ 返回 **409 `{COOLStatusCode: 1010}`**，CODE 主动弹「覆盖 / 重新加载」询问 —— 用户优先的冲突 UX 由编辑器原生承担；
- AI 回合进行中（busy）PutFile → 409；反向守护同样落地：回合快照时发现 head 被用户推进 → 拒落版并提示重试。

实测：旧时间戳 PutFile → 409 ✓；当前时间戳 → 200 ✓；回合期间用户推进 → AI 改动丢弃 ✓（单测）。

## 4. 为什么选 Collabora 而不是 TipTap + XML 补丁器

| 维度 | Collabora（CODE/COOL） | TipTap + XML 手术补丁器 |
|---|---|---|
| 保真 | LibreOffice 原生 OOXML 渲染/回写，最高 | 编辑器视图结构级保真；补丁器只保未触碰节点 |
| deck 编辑 | ✅ Impress 同一组件 | 需 pptx-react-viewer（license 待核）或 Konva 自研（多日） |
| 工程量 | WOPI host ~150 行 + 集成页 ~80 行，**已验证** | XML 补丁器 1–2k 行（表格最难），deck 另算 |
| 评论锚定 | 见 §5 开放项：文件内评论 → 同步进评论库 | 投影内选区直锚（S2 已建的面板可复用） |
| 基建重量 | CODE 容器 ~1GB 内存，多一个常驻组件 | 无 |
| 许可 | POC 免费；生产要决策（§1） | 无外部约束 |

结论：**保真 + doc/deck 双编辑 + 字级编辑三个硬需求，Collabora 以最小自研面全部满足**；XML 补丁器的 1–2k 行高风险自研被省掉。代价是运行时多一个容器与一个生产许可决策。

## 5. 开放项（S4/S5 范围）

1. **评论同步**：用户在 Collabora 里写的是文件内评论（docx `word/comments.xml`）。**docx 侧已落地**（`docs/office-comments.ts`：按所在段落的 paraId 锚定、file_comment_id 去重）。pptx 侧 Impress 评论同步待做（deck 编辑刚接通，跟随 S4 收尾）。
2. ~~无文本形状的锚点~~ **已落地（几何匹配）**：reconcile 第二遍按「同元素类型 + 同宽高」把无文本形状（图片/图表）对回上一版 id——图片被移动但未删除时评论跟随对象；误匹配（删一图加一张同尺寸图）风险 POC 可接受，漂移审计兜底。
3. **frame_ancestors**：CODE 默认放行 `localhost:*`；生产（M2）需把集成域写进 coolwsd 配置。
4. **视觉验收**：iframe 内实际编辑/保存需浏览器手工确认（本 spike 以协议层验证为准）——浏览器打开 `http://localhost:8787` → 选中已有文档 → 「编辑器」按钮即可。
5. **容器同网部署**：`scripts/container.sh up` 已把两个容器放进同一网络（别名互连）；本地开发拓扑（宿主 server + 容器 CODE）用 `HEURION_PUBLIC_URL=http://host.containers.internal:8787`。

## 6. 复现步骤

```sh
./scripts/container.sh collabora            # 起 CODE（:9980）
pnpm --filter @heurion2/server dev          # 宿主起 server（:8787）
# 浏览器 http://localhost:5173 → 选文档 → 「编辑器」
# 协议级冒烟：
curl -s http://127.0.0.1:8787/api/docs/<docId>/editor -H 'Authorization: Bearer dev'
curl -s "http://127.0.0.1:8787/wopi/files/<docId>?access_token=<token>"
```
