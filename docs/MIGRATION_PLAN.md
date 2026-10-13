# Heurion 1.0 → 2.0 功能迁移计划

**Status:** v0.3（2026-10-02：1.0 停用，多用户 / 文档仓库 / 记忆提前为迁移批次 R1–R3；嵌入模型、注册方式、账户迁移已定）
**跟踪:** heurion 仓库 epic #1174
**前提:** 2.0 架构见 [PLATFORM.md](PLATFORM.md)（平台持有结构化文档模型，AI 经 MCP 写入；S 系列路线 [DESIGN_S_SERIES.md](archive/DESIGN_S_SERIES.md) 已停用）。1.0 的代码只作参考实现，按需复制逻辑，不共享包、不共享数据。

**2026-10-02 决定：** Heurion 1.0 停用（不再修复，代码审查发现的问题不处理），但它的三块关键能力提前迁移，作为紧接着做的三个批次（见 §2.5）：**R1 多用户管理与隔离**、**R2 文档仓库**（用户自己的文档管理 + 参考资料库）、**R3 记忆**。三个批次与 P2 deck 画布（C1）、M1 十份文档评测（C2）并行推进。不做模型 / provider 降级。

## 1. 迁移原则

1.0 的每项功能按下面四类处理：

| 类别 | 判定 | 在 2.0 里的形态 |
|---|---|---|
| **A. dsh 替代** | 通用智能体能力 | 不迁移，1.0 实现直接废弃；最多写一份 skill 或 persona 说明 |
| **B. 领域 MCP 工具** | 需要 AI 在编辑中调用的医疗能力 | `apps/platform/src/<domain>/` + 注册进 `/mcp`（与文档工具同一个 `heurion` server），按用户范围令牌 |
| **C. 服务端模块 + UI** | 需要人直接操作的数据和流程 | REST 接口 + 前端页面；AI 需要用时，再同时开放 MCP 工具 |
| **D. 暂缓或放弃** | 与"快速 AI 编辑 + 医学文献"主线关系弱 | 先不做，按需求再评估 |

两条硬约束（与 DESIGN.md 一致）：

- 所有外部检索只走 heurion 的 MCP，不给模型通用联网能力；
- 引用只能来自 `insert_citation`（操作层写前强制），正文论断要经核对（见 M1）。

## 2. 1.0 功能清单与去向

### A. dsh 替代（不迁移）

| 1.0 功能 | 1.0 位置 | dsh 对应 |
|---|---|---|
| 对话工具循环、doom-loop、回合预算 | `modules/chat/`、`tools/doom-loop.ts` | agent 生命周期、工具执行管线 |
| LLM 网关（多 provider、reasoning） | `common/llm-gateway/` | `packages/llm`（DeepSeek 原生适配 + pi-ai 自定义路由） |
| 子代理 | `tools/subagent-runner.ts` | `packages/subagent`（2.0 实测中模型已自动使用） |
| 上下文压缩 | `memory/compaction/`、`context-compressor.ts` | `packages/compaction` |
| 任务计划 | `tools/set-task-plan-tool.ts` | `packages/plan`、`packages/todo` |
| MCP 客户端、运行时安装 MCP | `tools/mcp-client.ts`、`mcp-tools.ts` | `packages/mcp/mcp-client`（profile 声明） |
| 看图 | `tools/view-image-tool.ts` | `read_image` |
| 浏览器代理 | `tools/browser-agent-tool.ts`、`cf-browser-agent` | `packages/browser-use`（需要时经白名单开放） |
| 文档和 deck 编辑引擎（EditOp、提案、重基、锚点守卫、pptx-viewer-core） | `edit-*`、`doc-proposal`、`deck-proposal`、`edit-deck-bytes-tool` 等 | **不属于 dsh 替代**：由平台自研（模型 + 操作层 + 写前守卫 + MCP，见 PLATFORM.md）。doc 已完成（P0–P1），deck 在 P2 |
| 图表渲染 | `render-chart-tool`、`chart-renderer`、`deck-chart-embed` | dsh shell 里用 matplotlib 生成图片 → `asset_upload` → 插入文档；deck 原生图表数据在 P2 的 `set_chart_data` |
| 技能沉淀 | `modules/skills`、`skill-tools` | `packages/skill`（文件系统 skill） |

### B. 领域 MCP 工具

| 1.0 功能 | 1.0 位置 | 2.0 计划 | 里程碑 |
|---|---|---|---|
| PubMed 检索 | `search-citation-tool`、`medical-web-tools` | ✅ 已完成 `pubmed_search` | M0 |
| DOI 元数据、引用登记 | `crossref.client`、`insert-citation-tool`、`citation-store` | ✅ 已完成 `doi_lookup` / `insert_citation` / `list_citations` | M0 |
| 引用守卫 | `citation-guard`、`citation-audit` | ✅ 已完成：操作层写前拦截 DOI / PMID / 手写参考文献条目；人类编辑事后提示 | P0 |
| 论断核对（1.0 没有） | — | **新：`verify_claims`**，正文论断对照已登记文献的摘要或全文 | M1 |
| OpenAlex 检索 | `openalex-search-tool` | ✅ 已完成 `openalex_search` | M3 |
| OA 全文 | `oa-pdf-tool`（Unpaywall） | `oa_fulltext`，同时为论断核对供给全文 | M3 |
| 医学网站、全文抽取 | `medical-web-tools`（visit/extract） | `fetch_article`（经 ssrf-guard + 域名白名单） | M3 |
| 引用格式（AMA 以外） | `citation-format` | ✅ 已完成 `insert_citation(style)`：Vancouver / APA / GB/T 7714 | M3 |
| 用户知识库检索 | `modules/knowledge`、`retrieval/unified-search` | `kb_search` / `kb_read`（关键词 + 向量，RRF），见 §2.5 R2 | **R2** |
| 统计分析 | `stats-engine`、`stat-*`、`python-stats-worker` | 容器预装 scipy/statsmodels/lifelines + **统计 skill**；需要可复核的结果时用 `run_stats`（固定实现，输出方法学段落） | M4 |
| 投稿选刊 | `modules/submission`（DOAJ、OpenAlex、warning list） | `journal_match` | M5 |
| 临床图谱检索 | `clinical-graph-tools`（search_node / search_encounter） | `patient_search` / `encounter_search`（按用户授权） | M6 |
| 入排筛选 | `research/eligibility-screening` | `screen_eligibility` | M6 |
| 记忆检索 | `memory-tools`、Brain 2.0 | `memory_search` / `memory_propose`，见 §2.5 R3 | **R3** |

### C. 服务端模块 + UI

| 1.0 功能 | 1.0 位置 | 2.0 计划 | 里程碑 |
|---|---|---|---|
| 文档列表、上传、版本、回滚、下载 | `modules/documents` | ✅ 已完成（M0） | M0 |
| 文档预览 | 1.0 富编辑器 / deck 画布 | ✅ doc：平台编辑器即预览；deck：P2 | P1 |
| 版本对比 | #1172 形状级 diff | ✅ doc：块级 diff（`doc_diff` / 版本面板）；deck：P2 形状级 | P0 |
| 评论 → AI 处理 | `modules/comments`、`comment-tools` | ✅ 评论锚定在文字上（comment mark），@heurion 自动触发；AI 回复写回线程；导出写入 comments.xml | P0–P1 |
| 导入 PDF、参考文献 | `doc-import`、`document-extractor`（OCR） | 上传 PDF 进工作区（模型用 pdf 技能读取）；参考文献批量导入到登记表 | M1 |
| 在线手工编辑 | 1.0 DocEditor + deck 画布 | ✅ doc：ProseMirror + Yjs 实时协同编辑器（修订模式、撤销本轮 AI 修改）；deck：P2 Univer | P1 |
| 账户、登录、多用户 | `modules/auth`、`ownership` | 账户 + 签名令牌（可吊销）+ 按用户划分数据，见 §2.5 R1 | **R1** |
| 每用户容器隔离、网络出口白名单 | —（1.0 没有） | 调度器按用户起容器；出口代理只放行 LLM 端点和 /mcp | M2 |
| 审计日志 | `AuditLog`、EventLog | 每个 MCP 调用、每回合、每个版本都写审计日志 | M2 |
| PHI 扫描 | `common/pii-scanner`、doc phi-scan | 上传与导出时扫描；命中后需要确认 | M2 |
| 审批 | `modules/approvals` | 导出或投稿前审批（先做规则配置） | M5 |
| 知识库管理（上传资料） | `modules/knowledge`、`files`、`file-pipeline` | 参考资料库：上传 → 抽取 → 切块、嵌入 → `kb_search`，见 §2.5 R2 | **R2** |
| 文档组织（项目、搜索、回收站） | `modules/documents`、`/app/writing` | 项目（文件夹）→ 多份文档 + 共享资料；标题 / 全文搜索；回收站，见 §2.5 R2 | **R2** |
| 研究项目 | `modules/research`、`research-detail` | R2 的「项目」先承担组织作用；研究数据（入排、患者）仍在 M6 | M6 |
| 患者、病历、检验、影像 | `patients`、`medical-records`、`labs`、`imaging`（DICOM） | 按合规评审后再迁移；影像查看沿用现成的 viewer | M6 |
| 投稿工作流 | `modules/submission`、`submission.tsx` | 选刊 + 按期刊格式重排（AI）+ cover letter | M5 |
| 设置、管理后台、模型配置 | `settings`、`admin` | 用户管理在 R1；模型路由与配额在 M2 | R1 / M2 |
| 数据导出 | `export-data.tsx` | 按用户打包导出（合规要求） | M2 |
| 可观测性 | telemetry、Loki/Grafana | 回合耗时、工具调用、token 成本入库；日志沿用 Loki | M2 |

### D. 暂缓或放弃

| 1.0 功能 | 理由 |
|---|---|
| 插件市场、外部应用 API（`modules/plugins`、`external`） | dsh 的 skill 和 MCP 已经覆盖扩展需求；等有真实外部接入方时再做 |
| 日程、今日、提醒（`calendar`、`today`、`schedule`） | 偏离主线 |
| 经验进化、技能归纳（`modules/evolution`） | 依赖 Brain 2.0，先做检索 |
| sidecar 意图路由（`intent-routing`） | dsh 由模型自行选择工具，不再需要前置路由 |
| 生成图片（`generate-image-tool`） | 医学写作用处小 |

## 2.5 迁移批次 R1–R3（1.0 关键能力）

1.0 的实现细节已调研（2026-10-01）。总体取舍：保留产品上必要的流程，换掉 1.0 的存储方式（整份 JSON 快照、JSONL 向量全量读进内存）和正则命令路由；AI 侧一律改成 MCP 工具。

### R1 多用户管理与隔离（约 1 周，最先做：R2、R3 的数据都按用户划分）✅ 2026-10-02

**已完成**：账户、可吊销令牌、开放注册与防机器人（工作量证明 + 陷阱字段 + 限流）、逐接口隔离测试、登录 / 注册页、用户菜单、个人设置、管理员用户管理、1.0 账户导入脚本（本地 1.0 库预演：304 个可导入）。未做：出口白名单（仍在 M2）。2026-10-03 起 AI 执行的代码按平台用户隔离（专属 uid、模型经平台代理），见 DEPLOY.md。

- **账户**：`users`（用户名唯一、显示名、bcrypt 密码哈希、`role` user / admin、`status` active / disabled、`token_version`、最近登录）。**开放注册**（2026-10-02 定）：任何人可注册，第一个注册的用户是管理员；注册与登录按 IP 限流、密码最小强度，管理员可停用账户。
- **1.0 账户迁移**（2026-10-02 定：迁移用户数据）：一次性脚本从 1.0 的 Prisma SQLite 导入用户名、显示名、bcrypt 密码哈希（与平台同算法，原密码可直接登录）、角色、停用状态；`role` / `isAdmin` 合并为 `role`，已软删除的用户不导入，用户名冲突时报告不覆盖。脚本可重复运行（按用户名幂等）。1.0 的文档、引用、知识库、记忆不迁移。
- **登录令牌**：沿用平台已有的签名令牌（`auth/token.ts`，aud=web），带 `token_version`：停用用户、改密码、管理员强制下线时版本加一，旧令牌立即失效。修复 1.0 的缺陷：停用用户的 JWT 在 24 小时内仍可用；`role` 与 `isAdmin` 两个字段重复。
- **接口**：注册 / 登录 / 当前用户 / 改资料与密码；管理员：用户列表、停用 / 启用、改角色、重置密码、强制下线。
- **数据隔离**：所有数据按所有者划分（文档已有 `owner`；评论、引用、资产、版本、回合、队列经文档或用户归属校验）。逐个接口过一遍归属检查，跨用户访问一律 404。MCP 令牌、协同网关、dsh 进程、工作区目录已经按用户划分，补上目录名安全处理。
- **开发令牌**：`auth/dev.ts` 只在开发模式启用（e2e、浏览器测试继续用子用户）；生产环境只接受账户令牌。
- **页面**：登录 / 注册、右上角用户菜单、管理员的用户管理页。
- **验收**：跨用户访问矩阵测试（文档、评论、资产、协同、MCP、队列、导出各一条，另一用户访问返回 404 / 401）；停用后旧令牌立即失效；注册 / 登录限流生效；1.0 账户导入后用原密码可登录；e2e 在两个用户下各跑一遍。
- **不迁移**：邮箱 / 短信验证码、第三方应用 OAuth、Stripe 与套餐字段。每用户容器与出口白名单仍在 M2。
- 1.0 参考：`modules/auth/auth.router.ts`、`common/auth.guard.ts`、`common/ownership.ts`、`lib/upload-path.ts`、`modules/admin/admin.router.ts`。

### R2 文档仓库（约 2 周）

**进度（2026-10-02）**：a. 我的文档 ✅（项目、全文搜索、回收站、复制、`docs_search`）；b. 参考资料库 ✅（流水线、`apps/embedder` 本地 bge-m3 q8、混合检索、`kb_search` / `kb_read`、资料库页与「引用资料」、归入项目、扫描页本地 OCR（tesseract.js 简中 + 英文，只识别没有文字层的页，最多 200 页））。

**检索评测（2026-10-02，`scripts/kb-eval.ts`）**：10 篇 CC-BY 开放获取论文 PDF（PMC 开放数据，与 C2 同一批；183 页、799 块，入库连向量化约 2 分钟），30 个问题（19 英文、11 中文问英文文献），其中 19 个标注了答案片段。语料里刻意有成对的近似主题（两篇 SGLT2、两篇 GLP-1、两篇免疫检查点、两篇 RSV）。

| | 资料级 Hit@1（英 / 中） | 片段级 Hit@1 | 片段级 Hit@8 |
|---|---|---|---|
| 关键词（FTS5 trigram，问题拆词 OR） | 100% / 18% | 58% | 79% |
| 向量（bge-m3） | 100% / 100% | 63% | 95% |
| 混合 RRF | 100% / 91% | 79% | 89% |

结论：向量检索是中文问英文文献的关键（关键词几乎失效）；混合检索把含答案的片段排第一的比例最高。已知不足：图表里的数据（森林图）抽不到文字；pdftotext 偶有断词；同主题文献间仍会混淆。每条检索约 30 ms。

两部分，都按用户（和项目）划分：

**a. 我的文档**
- **项目**（文件夹）：一个项目包含多份文档（doc / deck）和一组共享资料（见 b），左栏按项目分组；文档可在项目间移动。
- **搜索**：标题与正文全文搜索（SQLite FTS5，文档提交时更新索引）。
- **回收站**：删除改为软删除，可恢复，定期清理；复制文档。

**b. 参考资料库**（1.0 的「知识库 / 文件」）
- **上传与处理流水线**：上传（PDF / docx / pptx / txt）→ 抽取文字（PDF 文本层，扫描件 OCR；保留页码）→ 切块（约 1200 字、重叠 150，按段落断开）→ 嵌入。每个阶段有状态、可重试，页面可见进度。按内容哈希去重。
- **嵌入模型**：本地 bge-m3（2026-10-02 定），沿用 1.0 `packages/embedding-server` 的做法（Transformers.js + ONNX，HTTP `/embed`），作为平台旁边的一个服务（容器镜像里一起起）；资料不出本机。服务不可用时资料停在「待嵌入」、关键词检索照常可用，恢复后自动补齐。
- **存储**：`kb_files`（所有者、项目、文件名、哈希、页数、状态、DOI / PMID 若能识别）、`kb_chunks`（文件、页码、文字、嵌入向量 BLOB）+ FTS5 关键词索引。检索是关键词与向量两路结果用 RRF 合并；按用户过滤后暴力余弦，规模大了再上 sqlite-vec。
- **MCP 工具**：`kb_search(query, project?, top_k?)` 返回片段、出处（文件、页码）；`kb_read(file_id, pages?)` 读原文。资料若是已发表文献（识别到 DOI / PMID），AI 引用时仍走 `insert_citation`（引用规范不变）；非文献资料（指南 PDF、内部材料）在回复和评论里标明出处，不进参考文献表。
- **页面**：资料库页（上传、处理进度、预览、删除、归入项目）；对话框里「引用资料」选择器，选中的资料随本轮提示给 AI。
- **验收**：上传一份 30 页 PDF 后 1 分钟内可检索；`kb_search` 在评测集上的命中率（与 C2 共用语料）；AI 写作时主动检索资料并标明出处的 e2e 步骤。
- **不迁移**：上传后自动抽取事实进记忆（等 R3 稳定后再评估）、知识空白自动研究、遥测仪表盘、临床病历入库、JSONL 向量文件。
- 1.0 参考：`modules/files/file-pipeline.service.ts`、`lib/document-extractor.ts`、`lib/text-chunker.ts`、`retrieval/unified-search.ts`、`retrieval/rrf-fusion.ts`、`modules/knowledge/knowledge-inject.ts`。

### R3 记忆（约 1.5 周）

**进度（2026-10-02）**：✅ 存储、守卫、三层开关、注入、`memory_propose` / `memory_search`、记忆页、对话卡片、「不用记忆」、管理员开关、导出导入。

参考 Claude 的「聊天搜索与记忆」设计（2026-10-02 定）：按条目记、随用随记、用户随时可看可改可删、可整体暂停 / 单次关闭；不同的是写入要用户确认（医疗写作里记错一条「事实」会悄悄污染之后每份文档）。

- **范围**：用户的写作偏好、常用术语与写法、反复出现的事实（例如「本院伦理批号 …」「我们组的统计软件是 R」），按全局或项目生效；同一份记忆在文档和幻灯片的对话里都可用。会话内的上下文压缩由 dsh 负责，不在这里。
- **存储**：`memories`（所有者、范围 global / project、种类 preference / fact / style / term、内容、来源（回合 / 评论 / 手动 / 导入，带来源文档与回合）、状态 proposed / active / rejected / archived、是否用户明确要求、嵌入向量）+ `memory_events`（变更历史：谁、何时、改前改后）。单表加历史，不用 1.0 的版本化图谱与双写。
- **写入走审核**：AI 用 `memory_propose(content, kind, scope, reason, explicit?)` 提议，进「待确认」，对话里显示「记住这条？」卡片（采纳 / 改写 / 拒绝）。用户在对话里明确说「记住 …」时，AI 提议并标 `explicit`，直接生效（记审计）。语义重复（嵌入相似度 ≥ 0.95，无嵌入时按规范化文本）合并到已有条目；拒绝过的同一内容不再提议。
- **敏感内容不进记忆**（写前守卫，用户要求也不行）：患者可识别信息（姓名 + 病情、住院号 / 病历号 / MRN、身份证号、手机号、出生日期、住址）、银行卡号等。被拦时告诉用户原因，不静默丢弃。记忆不按患者划分。
- **使用**：每回合开始按预算注入相关的 active 记忆（全局 + 当前文档所在项目；超预算时按与本轮消息的相似度、再按更新时间排序）；AI 也可用 `memory_search(query)` 按需检索。用户说「忘掉…」时 AI 用 `memory_forget(target)` 彻底删除（多条相近先确认；暂停或本轮不用记忆时也能忘），对话里显示「已忘记」卡片，可撤销。
- **开关**（三层）：
  - 管理员：本实例停用记忆——同时删除所有用户的记忆（界面上写明，二次确认）。
  - 用户：开启 / 暂停（暂停 = 保留已有记忆，但不注入、不提议）/ 清空（彻底删除，不可恢复）。
  - 单次对话：对话框里「本轮不用记忆」——这一轮不注入、`memory_*` 工具不可用、不产生提议。
- **可见与可控**：记忆页（待确认收件箱、按种类列出、编辑、删除；每条显示出处，点击打开来源文档）；修改立即对下一回合生效；导出（JSON）/ 导入（导入的条目进待确认）。
- **验收**：用户确认的偏好在下一份新文档的回合里生效（e2e：先让 AI 记住「数值保留两位小数」，新文档里写结果段时遵守）；拒绝的提议不再出现；删除后不再注入；「本轮不用记忆」的回合不注入也不提议；含住院号的提议被拦；暂停后不注入。
- **不迁移**：版本化记忆图谱与旧存储双写、技能进化、记忆分层升降级、过期传播、按患者划分。
- 1.0 参考：`memory/proposal/proposal.service.ts`、`memory/memory-gateway.ts`、`retrieval/memory-projection.ts`、`web/components/brain/IngestionInbox.tsx`；设计文档 `docs/design/BRAIN2_MEMORY_LIFECYCLE.md`。

### 排期（与 C1、C2 并行）

| 周 | 迁移批次 | 并行 |
|---|---|---|
| 第 1 周 | R1 多用户与隔离 | C2 收集 10 份文档、制定标注规范；C1 Univer 接入调研 |
| 第 2–3 周 | R2 文档仓库（项目 / 搜索 / 回收站 → 资料库流水线 → `kb_search`） | C1 画布：形状拖拽、缩放、直接改字；C2 标注与首轮评测 |
| 第 4–5 周 | R3 记忆 | C1 画布：图表数据、插图；C2 回归基准接进 CI |

## 3. 里程碑

| 里程碑 | 目标 | 退出标准 |
|---|---|---|
| **M0** ✅ | 架构跑通 | SDK 接入、文献 MCP、引用校验、版本回滚、容器化；3 个真实任务通过 |
| **P0–P1** ✅ | 文档平台（doc） | 见 PLATFORM.md §12：模型 + 操作层 + MCP + docx 往返 + 协同编辑器 |
| **P2** | 文档平台（deck） | 见 PLATFORM.md §12 |
| **M1 写作可用** | 单用户能高质量完成医学写作 | PDF/参考文献导入、**论断核对（`verify_claims`）**；**10 份真实文档评测**（延迟、保真、论断正确率）。预览、版本对比、评论驱动 AI、手写引用识别已在 P0–P1 完成 |
| **R1–R3 迁移批次** | 1.0 关键能力 | 多用户与隔离、文档仓库（项目 / 搜索 / 回收站 + 参考资料库）、记忆，见 §2.5 |
| **M2 可上线** | 多用户安全使用 | 每用户容器、出口白名单、审计、PHI 扫描、导出、可观测性、多实例部署（按文档路由协同）。账户与数据隔离已在 R1 |
| **M3 文献与知识** | 检索覆盖面 | OpenAlex、Unpaywall 全文、全文抽取、多引用格式。用户资料库已在 R2 |
| **M4 统计与图表** | 可复核的统计 | 统计 skill + `run_stats`，输出结果表、图和方法学段落 |
| **M5 投稿** | 从稿件到投稿 | 选刊、期刊格式重排、cover letter、导出审批 |
| **M6 临床与研究** | 研究项目与临床数据 | 研究项目、入排筛选、患者和病历（先过合规评审） |
| ~~M7 记忆~~ | 个性化 | 提前到 R3 |

## 4. 待决策

1. ~~在线手工编辑怎么做~~ **已定（2026-10-01）**：自建编辑器内核（doc：ProseMirror + Yjs；deck：Univer），不嵌入 Collabora / ONLYOFFICE。见 PLATFORM.md §10。
2. **患者、病历、影像是否留在 2.0 主线**，还是拆成独立产品线：它们的合规要求（PHI）远高于写作。
3. **隔离粒度**：R1 按用户；组织 / 团队共享留到 M2 之后（数据模型预留 `org_id`）。
4. ~~1.0 的数据要不要迁移~~ **已定（2026-10-03，改）**：放弃 1.0 的全部数据，包括用户账户；2.0 部署到 1.0 的 VPS 上从零开始（导入脚本保留但不在切换中使用）。
5. ~~嵌入模型~~ **已定（2026-10-02）**：本地 bge-m3（见 R2）。
6. ~~注册方式~~ **已定（2026-10-02）**：开放注册，限流 + 管理员可停用（见 R1）。
