# Heurion 2.0 平台架构

**Status:** v0.4（2026-10-01）· P0、P1、M1 论断核对已实现；P2 后端与查看器已实现（`apps/platform`）· **跟踪:** epic [#16](https://github.com/0xaicrypto/heurion2/issues/16) · **决策人:** JZ
**关系:** 本文是 v0.4 起的唯一架构。[DESIGN_S_SERIES.md](archive/DESIGN_S_SERIES.md) 描述的 S 系列路线（dsh 用 python 改文件 + Collabora 编辑面）已于 2026-10-01 停用，保留为决策记录。

## 目录

1. [定位与范围](#1-定位与范围)
2. [原则](#2-原则)
3. [总体架构](#3-总体架构)
4. [数据模型](#4-数据模型)
5. [统一编辑框架](#5-统一编辑框架)
6. [doc 内核](#6-doc-内核)
7. [deck 内核](#7-deck-内核)
8. [MCP 接口面](#8-mcp-接口面)
9. [前端](#9-前端)
10. [决策记录](#10-决策记录)
11. [风险](#11-风险)
12. [分期 P0–P3](#12-分期-p0p3)

---

## 1. 定位与范围

**平台 = 自建 doc/slides 编辑平台 + 面向 agent 的结构化文档通道。**

- 平台持有带稳定 id 的结构化文档模型，对外暴露两类面：给**人**的编辑器（P1 起实时协同），给 **AI** 的 MCP 工具（结构化读写，写前守卫）。
- docx 先行（P0–P1）；deck 内核 P2；多用户 / 容器隔离沿用 DESIGN.md 的 M2 里程碑。
- doc 与 deck **能力对齐不再是设计约束**：两种媒体用两个内核，共享同一套平台底座（操作层、守卫、评论、引用、版本、MCP 约定）。

## 2. 原则

1. **平台持有真相与 id。** 结构化模型是唯一真相；docx/pptx 文件是导入 / 导出视图。id 由平台分配，写在模型节点上，不依赖文件内属性在编辑器间存活。
2. **AI 对文档的一切写入走操作层。** dsh 经 MCP `doc_edit(ops)` → 写前守卫 → 原子应用。dsh 的 **shell 保留**，只用于计算类任务（统计、作图、数字数、读资料）；文档不在工作区里，也没有任何「用文件写回文档」的入口，所以模型在结构上绕不过操作层。shell 产出的图经 `asset_upload` 进入平台。
3. **用户优先。** AI 的写入不能覆盖 `base_rev` 之后用户改过的块（`conflict_user_edited`）；用户的写入不受 AI 守卫阻挡。用户在编辑器里的编辑经协同层实时写入同一个 Y.Doc（CRDT 更新流），AI 写入前先把尚未落库的用户编辑落掉，冲突守卫因此看得到用户正在改的块。
4. **dsh 仍是执行层。** 对话循环、工具执行、LLM 调用、子代理、上下文压缩不变；「office 文件读写」从 dsh 职责中移出（文档模型与守卫是平台核心，dsh 的 office 技能给不了结构化 id、写前守卫与原子 ops）。
5. **产品规则保留：** 评论 = 带锚点的编辑指令、用户优先、引用规范（insert_citation 单通道）、可回滚。语义不变，实现位置迁移到操作层。
6. **自研 = 组合成熟件，不从零造。** doc 内核 ProseMirror + Yjs（编辑器直接用 ProseMirror，schema 前后端共用一份）；deck 内核 Univer slides（Apache-2.0）+ fork Casual Slides 的 pptx 导入层。

## 3. 总体架构

```
dsh 子进程（每用户一个；shell 仅计算；工具 = heurion MCP）
   │ MCP（Streamable HTTP，/mcp，用户级范围令牌）
   ▼
apps/platform（Node + Hono）
 ├─ mcp/        MCP 工具面（读视图 / doc_edit / 评论 / 文献 / 引用 / 资产）+ 回合登记
 ├─ ops/        操作层：zod 校验 → 写前守卫 → 内存应用（prosemirror-transform）→ 单个 Yjs 事务
 ├─ model/      schema、id、markdown 方言、锚点、Documents（每文档 Y.Doc，updateYFragment 最小差异写入）
 ├─ views/      读视图（outline / read / search / diff）与渲染（HTML、markdown 导出）
 ├─ convert/    docx 导入（保留原始 XML）/ docx 修补式导出 / PDF 导入（doc-parser 主路径，poppler 兜底）
 ├─ turns/      回合：登记 → dsh 执行 → 每份改过的文档打版本
 ├─ harness/    dsh 进程池、profile patch、事件映射
 ├─ http/       REST + SSE（前端、文档变更推送）
 ├─ memory/     记忆：提议 / 确认、敏感内容守卫、三层开关、回合开头按预算注入
 ├─ kb/         参考资料库：抽取（pdftotext / docx / pptx）→ 切块（保留页码）→ 向量化 → 混合检索（FTS5 + 余弦，RRF）
 ├─ web/        P0 单页（预览、选区评论、对话、版本、引用、资料库）
 └─ store/      node:sqlite

apps/embedder（127.0.0.1:8003，本地 bge-m3 q8，Transformers.js + ONNX；/health、/embed）
   资料不出本机；没起来时资料库只用关键词检索，起来后自动补向量（EMBEDDING_URL 配地址）

apps/doc-parser（127.0.0.1:8005，Docling：版面、表格结构、公式 → LaTeX、扫描页 OCR；/health、/parse）
   PDF 导入主路径；模型部署时预下载，运行时离线，容器只接入无外网的 internal 网络。
   没配置 / 预热未完成（/health 503）/ 解析失败时平台退回 poppler 启发式方案，导入结果的 importEngine 记录路径（DOC_PARSER_URL 配地址）
```

| 组件 | S 系列（已停用） | 平台 | 变化 |
| --- | --- | --- | --- |
| 真相 | docx/pptx 文件（版本库） | 结构化模型（Yjs） | ⛳ 核心 |
| 寻址 | 文件内 id 载体（paraId / shape id） | 平台块 id（模型节点属性） | ⛳ 核心 |
| AI 编辑 | dsh python 直接改文件 | MCP `doc_edit(ops)` + 写前守卫 | ⛳ 核心 |
| 守卫 | 写后审计（漂移 / 存活率 / DOI） | 写前强制 | ⛳ 核心 |
| 合并 | 三方合并（写后） | 节点级冲突守卫 + CRDT 合并 | ⛳ 核心 |
| 评论 | 文件内 comments.xml 同步 | 平台评论（锚 = 文本上的 comment mark），导出时写入 comments.xml | 迁移 |
| 编辑面 | Collabora iframe（WOPI） | ProseMirror 编辑器（doc）；P2 Univer（deck） | 迁移 |
| dsh 进程 | 每文档一个 | 每用户一个（一个会话可编辑多份文档） | 变化 |

## 4. 数据模型

`node:sqlite`（`apps/platform/src/store/db.ts`）：

```
docs(id, owner, title, kind doc|deck, rev, state BLOB)   -- state = Y.encodeStateAsUpdate
op_log(doc_id, rev, actor ai|user|system, turn_id, ops, affected)   -- 每次提交一行，只增
node_changes(doc_id, rev, node_id, actor, kind)          -- 节点级变更索引（冲突守卫）
versions(doc_id, seq, rev, source create|import|turn|user|restore, turn_id, note, state BLOB)
node_src(doc_id, node_id, xml)                           -- 导入时每个块的原始 OOXML（逐字节）
doc_packages(doc_id, kind, bytes)                        -- 导入的原始文件包（导出底座）
assets(id, owner, mime, name, bytes)                     -- 图片等资产
citations(id, doc_id, doi, pmid, formatted, url)         -- UNIQUE(doc_id, doi)
comments(id, doc_id, node_id, snippet, status, resolved_by) / comment_replies(…, role, text, turn_id)
turns(id, user_id, doc_id, message, status) / messages(doc_id, role, text, turn_id)
```

- **rev**：每次提交加一，模型读到的 rev 作为下一次写入的 `base_rev`。
- **版本**：回合结束（本回合改过的每份文档各一版）/ 手动保存 / 导入 / 回滚时打快照；与上一版 rev 相同则不重复打。回滚 = 把旧快照作为一次用户提交写回并打新版本（历史只增）。
- 浏览器编辑按 400ms 合批成一次用户提交（rev+1、op log、节点变更索引）；用户级撤销在浏览器（y-prosemirror 的 yUndoPlugin，只撤自己的编辑）；AI 回合的撤销见 §5.6。

## 5. 统一编辑框架

### 5.1 身份：块 id 与锚点

- 可寻址节点（标题 / 段落 / 列表 / 列表项 / 表格 / 图 / 不可编辑块）的 `id` 是模型节点属性：4 位起的 base36 短 id，文档内唯一，导入或插入时由平台分配，之后不变。表格单元格按 (row, col) 寻址。
- 模型看到 / 使用的都是块 id（读视图里的 `{#id}` 前缀），不复述原文定位。
- **评论锚点** = 文本上的 `comment(thread)` mark（Yjs 里是文本格式属性，随编辑移动）；无文字的块（图、不可编辑块）锚在块 id 上。锚点只在被锚定的文字真的消失时丢失，而这正是锚点守卫拦截的情形。
- **锚点颗粒度**（2026-10-01 定，doc 与 Claude Docs 实测一致，deck 取最小颗粒度）：
  - doc：一个段落 / 标题**内**的连续文字（`\n` 对应硬换行；精确匹配，失配时唯一的不区分大小写匹配）；或整块（不带文字，用于列表、表格、图等非文本块）。**跨块选区不接受**——编辑器选区阶段只给提示「评论只能选在一个段落内」，接口返回 400。
  - deck：形状里**某一段**内的文字（带段落序号 `paragraph`）；或**整个形状**（单击形状，不带文字）。跨段落、跨形状的选区只给提示。
  - 整块 / 整形状的评论锚的是块本身：块里文字被整体改写后，标记自动补回整块，不算丢锚；块被删除才算。
  - 前端提交选区在段落内的**位置**和按同一规则算出的引用文字（硬换行记作换行、引用不计文字）；服务端按位置打锚点，重复出现的文字也能锚准。位置与文字对不上（期间文档变了）时退回按文字查找，仍找不到就要求重选。

### 5.2 写路径

| 路径 | 执行者 | 流程 |
| --- | --- | --- |
| ① 起草 / 修改 | dsh | `doc_outline` → `doc_read` → `doc_edit(ops)`（一批原子提交）→ 回合结束落版 |
| ② 用户编辑 | 用户 | 编辑器 → 协同网关（WebSocket）→ 同一个 Y.Doc；合批落库为用户提交。REST `POST /api/docs/:id/edit` 保留给程序调用（同一操作层，actor=user） |
| ③ 评论驱动 | dsh | 评论触发回合 → `comments_list`（锚点所在块与文字）→ `doc_edit` → `comment_reply`；改过内容的线程留给用户关闭 |

### 5.3 守卫（写前强制，只对 AI）

每批操作在应用前后校验；任一失败 → 整批拒绝（原子性），返回 `{ code, message, op_index, hint, current }`：

| 守卫 | 规则 | 失败码 |
| --- | --- | --- |
| 冲突（用户优先） | 目标块在 `base_rev` 之后被用户改过（`replace_text` 除外：原文即守卫） | `conflict_user_edited`（附当前内容与新 rev） |
| 引用 | 写入内容出现 DOI、PMID 或手写参考文献条目 | `citation_not_registered` |
| 引用 | `[@c:id]` 未在本文档登记 | `citation_unknown` |
| 锚点 | 本批操作会让 open 评论失去锚点，且线程未列入 `ack_comments` | `anchor_has_open_comments`（附线程与用户要求） |
| 结构 | 找不到块 / 原文 / 单元格，非法嵌套，编辑不可编辑块 | `node_not_found` / `text_not_found`（附 `near` 近似候选）/ `ambiguous_match`（附每处 `matches` 上下文）/ `occurrence_out_of_range` / `cell_not_found` / `invalid_structure` / `node_not_editable` |
| 参数 | op 形状、markdown、`base_rev` | `invalid_markdown` / `invalid_base_rev` / zod 校验错误 |

- **为什么用 `base_rev` + 节点变更索引，而不是 `expectText`：** `expectText` 要求模型复述原文，「复述原文失配」正是 S 系列要消灭的失败来源；按 id + rev 判定冲突不依赖模型抄写，且冲突时直接返回当前内容，模型一次就能改对。
- **`replace_text` 以原文为守卫**（对齐 Claude Docs 的 find 编辑）：`find` 必须在块内原样出现，用户改掉了这几个字就自然匹配不上（`text_not_found`，附当前内容），所以不再按 `base_rev` 判冲突——用户改了同一段的别处不影响 AI 的小改。整块替换（`replace_block` 等）仍按 `base_rev`。
- **匹配规则**：块内字面匹配，不跨块；引用标记、硬换行算一个单位，`find` 不能跳过它们（「只在引用后追加」的情形例外，见代码）；空白不做容错。失配时不猜，返回 `near`（空白 / 大小写不同、中间隔着引用的写法，带可直接重试的原文）；多处匹配返回每处上下文，带 `occurrence` 重试。大小写不同且唯一时直接按不区分大小写匹配。
- **Yjs 写入核对**：`updateYFragment` 后读回核对。y-prosemirror 1.3.7 在引用等行内原子节点之后的文字只改格式时不更新格式属性（实测）；修补在原有 Yjs 元素上补格式与元素属性（以临时 Y.Doc 里生成的同内容作参照），不删不换元素，协作者的并发输入与回合撤销都不受影响。
- **最小差异写入**：替换只改真正变化的字（去掉相同的开头与结尾），引用、格式、评论锚点落在保留下来的字上不动。纯文字替换按文字比较，保留的字保持原格式；新插入的字沿用被替换的第一个字的格式，纯插入取左右邻字共有的格式。
- **锚点跟随**：锚点随最小差异自然收缩到保留下来的字（与 Claude Docs 一致）；被锚定的字全部消失 → 锚点守卫拦截。**例外：正在回答的评论**——评论触发的回合（「让 AI 处理」/ `@heurion`）里，用户要改的往往正是被评论的文字，这条线程的锚点被改没时自动重新锚到原块 / 形状上，线程保持 open 等用户确认；其他线程照常拦截。
- **人类编辑不经硬守卫**：Yjs 更新在客户端已生效，服务端拒绝只能断开重连。落库后做事后检查（`collab/postcheck.ts`，目前检查手写 DOI / PMID / 参考文献条目），以页面提示呈现，不拒绝写入。
- **块 id 维护**：编辑器回车拆段、粘贴会复制或丢失块 id——浏览器插件当场补号，服务端落库前再修一次并广播（两端都修，以服务端为准）。

### 5.4 评论闭环

- 评论数据在 SQLite，锚点在模型里（comment mark）；读取时实时定位（`located` / 锚定块 / 当前文字）。创建时按 §5.1 的颗粒度打锚点，打不上返回 400（不再退化为整块锚点）。
- 触发：前端「让 AI 处理」/「评论并让 AI 处理」，或评论 / 回复里写 `@heurion`（自动排队，只认用户写的内容，AI 的回复不会自我召唤）→ 服务端组装提示 → 回合。
- 回合队列：每个用户一个 FIFO 队列（一个用户一个 dsh 进程），对话、评论处理、@heurion 都排进同一队列；回合事件同时推到文档的 SSE 流，页面上自动触发的回合同样可见。
  - **持久化**：排队中的任务存在 SQLite `turn_queue`，服务重启后继续执行；重启时没跑完的回合标为 `interrupted`（已提交的修改保留，可撤销）。
  - **任务队列面板**（对话页签顶部，跨文档）：执行中的任务（文档、要求、已运行时长）+ 排队中的任务（位次、已等待时长）；评论任务显示用户写的要求。可逐个**取消**排队任务、只**停止**当前任务（后面的照常执行）、或**全部停止**。`GET /api/queue`、`POST /api/queue/:id/cancel`。
  - **停止卡住的任务**：先让等待中的 dsh 调用立即失败、放行队列，再结束 dsh 进程（下一个任务重新拉起）；模型调用卡住、进程关不掉时队列也不会被堵死。每个 dsh 进程的 MCP 令牌带进程代号，进程被停止后旧令牌立即失效——旧进程在退出前的几秒里不能再写入，写入不会记到下一个回合名下。
  - **无响应超时**：回合连续 5 分钟没有任何动静（dsh 的模型输出、工具调用 / 结果，或本回合的提交）→ 按「停止」同样的方式自动停止，回合记为 `timeout`，页面提示「模型服务 5 分钟无响应，已自动停止」，队列继续。`TURN_IDLE_TIMEOUT_MS` 可调。起因：DeepSeek 接口曾出现请求发出后十余分钟不返回（实测直连 `chat/completions` 同样挂起）。
  - 开发令牌 `<token>:<名字>` 映射到独立的开发用户；e2e 用 `dev:e2e`，不占手工测试用户的队列。
- AI 回复写入线程（role 固定为 ai）；**本回合改过文档时 `comment_resolve` 被拒绝**（`user_confirms_changes`），只有判断无需修改并说明后 AI 才能关闭线程。
- 导出 docx 时 open 线程写为 `comments.xml`（Word 用户可见）。

### 5.5 引用规范

- `pubmed_search` → `insert_citation`（DOI 必须能在 Crossref 查到）→ 正文写返回的 `[@c:<cite_id>]`。
- 引用在模型里是行内原子节点 `citation(cite_id)`：编号按文中首次出现顺序计算，参考文献表由平台在预览 / 导出时生成；模型不能手写编号或参考文献表。
- 守卫在写入前拦截正文里的 DOI / PMID / 手写参考文献；不再需要回合后审计与自修。

### 5.6 撤销

| 谁的修改 | 怎么撤 | 说明 |
| --- | --- | --- |
| 用户自己 | ⌘Z / ⌘⇧Z（浏览器 yUndoPlugin） | 只撤本人的编辑，不会撤掉 AI 或别人的改动 |
| 某一轮 AI | 对话里「撤销本轮修改」（`POST /api/docs/:id/turns/:turnId/revert`） | 该回合专属的 Y.UndoManager 撤销它的全部提交；用户在此期间的编辑保留。服务重启后不可用 |
| 任意时刻 | 版本回滚 | 回合结束、手动保存、导入、回滚时打的快照 |

## 6. doc 内核

| 件 | 选型 | 说明 |
| --- | --- | --- |
| 模型 | ProseMirror schema（`model/schema.ts`）+ Yjs | 标题 / 段落（样式名、对齐）/ 有序与无序列表（可嵌套）/ 表格（colspan、rowspan、表头）/ 图（资产）/ 不可编辑块 / 引用原子节点；mark：粗、斜、下划线、上下标、代码、链接、评论 |
| 写入 | prosemirror-transform 在内存应用 → `updateYFragment` 最小差异写入 Y.Doc | 未改动的节点在 Yjs 里保持原样（P1 编辑器同步的前提）；Node 中无 DOM 运行已验证 |
| 内容格式 | markdown 方言（`model/markdown.ts`） | CommonMark + GFM 表格 + `[@c:id]` + `![说明](asset:<id> "图注")` + `<sup>/<sub>/<u>/<br>`；读视图带 `{#id}` 前缀，写入时忽略 |
| 导入 | 自写 OOXML 解析（`convert/docx-import.ts`） | 标题（样式名 / outlineLvl / 中文「标题 N」）、列表（numbering.xml，相邻同类列表合并）、表格（gridSpan / vMerge）、格式、超链接、图片（入资产库）、修订（接受插入、丢弃删除）、内容控件、题注并回图；含文本框 / 嵌入对象 / 脚注的段落整段落为 opaque（避免修改后重新生成丢内容）；含域代码（EndNote / Zotero 等）的段落仍可编辑，导入时提示修改后域变为文字；其余落为 opaque。每个顶层块保存**逐字节原文** |
| PDF 导入 | `convert/pdf-import.ts` + `convert/doc-parser.ts` | 主路径调本地 doc-parser（Docling）：标题（含层级推断）、段落、列表、表格（规则网格、表头行）、图（入资产库 + 图注）、公式（schema 无公式节点，存为 `style: 'Code'` 段落里的 `$$LaTeX$$`）；扫描页由 OCR 出文字并在开头注明，OCR 也没识别出文字才插整页图。服务不可用时退回 poppler（`pdftohtml -xml` 启发式）。原始 PDF 存为文件包 |
| 导出 | 修补式（`convert/docx-export.ts`） | 以原始文件包为底座（样式、编号、关系、媒体、页面设置）；导入后**未改动的块原样写回**（与图混排的段落：拆出的图也原样跟随时才整段写回，避免图重复），改过 / 新增的块按模型生成，新列表沿用原文件同类列表的编号定义与段落样式；新建文档用内置模板（宋体 / Times New Roman、标题样式）。引用为上标 [n] + 参考文献表；open 评论写入 comments.xml；图片嵌入 |
| 撤销 | 用户：浏览器 yUndoPlugin；AI：每个回合一个服务端 Y.UndoManager（§5.6）；任何时候：版本回滚 | |

保真口径：**未改动的块逐字节保真**（3 份真实文档「导入 → 不改 → 导出」正文与原文件逐字节一致）；改动 / 新增的块按平台样式生成，花式 Word 特性（SmartArt、域代码、文本框）导入为 opaque 或注记，原样写回、不可编辑。不使用 mammoth（转 HTML 丢失原始 XML，无法修补式导出）与 docx npm 包（整份重新生成）。

## 7. deck 内核

**现状（P2 后端 + C1 画布第 1–3 周已实现）：平台自己的 deck 模型 + 自写 pptx 导入 / 修补式导出 + LibreOffice 渲染 + 在查看器上自建的画布（选中、拖动、缩放、样式、插图、主题）。**

**原则：人和 AI 能力一致（2026-10-02 JZ）。** 画布上人能做的每个编辑都是操作层里的一个 deck 操作，画布（REST edit，actor=user）与 AI（MCP `deck_edit`）用同一套定义（`ops/deck.ts` 的 `DeckOp`）；不做只有界面能用的修改。每个画布功能的验收都包含「AI 经 MCP 也能做」（`tests/mcp.test.ts`、e2e）。

- **模型**（`model/deck-schema.ts`）：与 doc 一样用 ProseMirror + Yjs 表示（幻灯片 → 形状 → 段落），因此版本、op log、冲突守卫、修订、撤销本轮全部复用。形状记录种类（文本 / 图形 / 图片 / 表格 / 图表 / 组合 / 线条 / 不可编辑）、占位符、几何（EMU）、原 cNvPr id；段落与文字段的原始格式（`a:pPr` / `a:rPr`）以属性保留，改文字时沿用字号、颜色、字体。
- **导入**（`convert/pptx-import.ts`）：自写。不用 Casual Slides 的导入器——它输出 Univer 的渲染结构，而后端需要的是形状 / 文字 / 占位符 / 几何与**逐字节原文**（修补式导出的前提）；Casual 的导入器留给画布阶段。没写位置的占位符从版式 / 母版继承几何；纯色填充与页面背景记下供查看器近似渲染；备注读入。
- **导出**（`convert/pptx-export.ts`）：修补式。未改动的页原样保留；改过的页重建形状树（未改动的形状原样、改过的形状只替换文字体 / 位置、新形状按占位符或文本框生成）；新增页按版式生成；删页、调页序同步 presentation.xml / rels / content types；备注改动修补原备注页。3 份真实 deck「导入 → 不改 → 导出」所有部件逐字节一致；修改后 LibreOffice 渲染原设计完整保留。
- **新建 deck**：内置最小模板（`convert/pptx-template.ts`：母版 + 标题页 / 标题和内容 / 空白三种版式 + 主题）。
- **渲染**（`render/slides.ts`）：LibreOffice 转 PDF → pdftoppm 转 PNG，按（文档, rev）缓存；容器内直接运行，本地开发自动改用 heurion2:dev 镜像。
- **版面检查**（`views/layout.ts`）：按字号近似估算文字溢出、形状重叠、超出页面、字号过小。
- **MCP 面**：`doc_outline`（各页 id / 版式 / 标题 + 可用版式）/ `slide_read`（形状 id、种类、占位符、几何 pt、文字）/ `deck_edit(ops)`（add_slide 按版式填占位符 / delete_slide / move_slide / set_text / replace_text / add_shape / set_xfrm / delete_shape / set_notes / table_set_cells）/ `layout_check` / `slide_render`（PNG 交给多模态模型自查）；守卫同 §5.3，按形状判定。
- **页面**：deck 查看器按模型近似渲染（位置、文字、填充、图片），每页可切换 LibreOffice 精确预览；AI 改动高亮、修订标红 / 绿。评论按最小颗粒度：形状里一个段落内选中文字，或单击形状评论整个形状（§5.1）。编辑走对话。
- **形状内 `replace_text`**：逐段匹配（同 doc 的规则，不跨段落），改文字时沿用原文字段的 `a:rPr`。
- **样式与素材操作（C1）**：`set_fill`（形状填充 / 无填充）、`set_background`（页面背景）、`set_text_style`（颜色、字号、粗斜体、对齐，整个形状或某一段）、`add_shape` 带 `geometry`（rect / roundRect / ellipse）与 `fill` / `color`（色块、标题条、卡片）、`add_image`（资产插图，高度按原图比例）、`set_z`（叠放顺序）、`apply_theme`（`model/deck-themes.ts` 的四套主题：背景、标题 / 正文颜色、强调色；之后新加的页沿用）。颜色可写主题记号（accent / title / body / surface…），按该页主题取色，换主题时跟着变。导出全部写回 pptx：`spPr` 填充与几何、`p:bg`、文字段 `a:rPr` 颜色与字号、`a:pPr` 对齐、`p:pic` + `ppt/media` + 关系、pptx 主题的强调色与字体。`slide_read` 显示主题、背景、填充、文字颜色与字号，AI 看得到样式。
- **AI 生成图片**：`diagram_render`（MCP）——模型写自包含 SVG（机制、流程、研究设计图），平台用 resvg 本地渲染成 PNG 存为资产，再插入文档（`![图注](asset:id)`）或幻灯片（`add_image`）；脚本、事件属性、外部引用一律拒绝。数据图仍用 shell 里的 matplotlib + `asset_upload`。照片式插画需要图像生成模型（未接入，待定）。
- **画布（`web/src/deck.ts`）**：单击选中形状 → 拖顶部手柄移动、拖 8 个控制点缩放（图片拖角保持比例）、方向键微调（Shift 10pt，连续按键合并成一次提交）、Delete 删除；选中框画在页面外层，形状超出页面时控制点仍可拖；形状里拖动仍是选文字评论，与移动互不干扰。幻灯片工具条：主题、背景、插入文本框 / 色块 / 图片、填充、文字色、字号、粗体、对齐、置顶 / 置底、删除；颜色板列当前主题的颜色（以主题记号提交）+ 自定义。幻灯片宽度随中间栏自适应。
- **为什么不用 Univer（2026-10-02 调研）**：开源版 slides 是原型（元素修改是 OPERATION 不是 MUTATION，没有撤销与协同事件，没有表格 / 图表），pptx 导入导出、表格、图表、协同都在 Univer Pro（商业许可）；还要引入 React 与约 1MB 的界面框架，并维护两套模型的映射。Casual Slides 基于改过的 Univer OSS，导入层输出 Univer 的模型，不适合作我们的数据来源。
- **画布上直接改字（C1 第 2 周）**：双击文本框 / 色块 / 占位符原地改字，点别处或 ⌘↩ 提交、Esc 取消；回车新起一段；引用角标是整体、不会被打散；光标落在双击处（浏览器双击选中的一片可能带着分段，直接打字会并段）。提交 `set_paragraphs`：逐段最小差异，未改的字保留原有颜色、加粗、引用与评论标记——AI 改多段文字时同样用它。表格单元格双击改字（`table_set_cells`）；每页下方的备注区双击编辑（`set_notes`）。改字期间服务端回推的更新先缓一缓，改完再重绘。
- **表格**：`add_table`（画布「＋表格」与 MCP 同一个操作）——表头用主题强调色、白色粗体，交替行用卡片色；导出为 PowerPoint 原生表格（`p:graphicFrame` + `a:tbl`）；换主题时表头与交替行底色跟着换、表头保持白字。
- **对话里的工具失败**：工具结果带原因与建议（平台工具的 `{code, message, hint}`），对话里显示「<哪一步>没成功：<原因>」（提醒色，悬停看建议与错误码），本轮摘要写「N 步调整后重试」。
- **多选、排列、吸附（C1 第 3 周）**：Shift+单击多选（同一页），拖任一手柄整体移动，方向键 / Delete / 填充 / 文字样式 / 层级作用于全部选中、一次提交。「排列」菜单走 `align_shapes`（左 / 水平居中 / 右 / 上 / 垂直居中 / 下；多个对齐选区、单个对齐页面）与 `distribute_shapes`（横向 / 纵向等距，首尾不动）——AI 同样用这两个操作，不必自己算坐标。拖动与缩放吸附页面边与中线、同页其他形状的边与中线（6px，显示参考线；缩放只吸附正在拖的边；按住 Alt 不吸附）。
- **表格增删行列**：`table_insert_rows` / `table_delete_rows` / `table_insert_cols` / `table_delete_cols`（画布选中表格后的「＋行 / ＋列 / −行 / −列」作用在最近点过的单元格），新行沿用相邻正文行的格式与底色（不沿用表头），新列沿用相邻列；不能删光。导入的表格增删行列后导出：保留原 graphicFrame、tblPr 样式、列宽与行高，重建 `a:tbl`。
- **与 AI 并发修改**：拖动、改字期间服务端回推的更新先缓存，结束后再重绘；提交时发现形状已被删除就跳过并提示，被 AI 挪过 / 改过就以用户的为准并提示（AI 的版本可在「版本」里找回）——用户优先（§2 原则 3）。
- **图表（C1）**：导入时从图表部件缓存读出类型、标题、类别、系列与数值（形状属性 `chart`，另记 `chart_part`）；柱 / 条 / 折线 / 面积 / 饼 / 圆环可改数据，散点等只读。`add_chart` 新建原生图表（颜色取主题），`chart_set_data` 改类别 / 系列 / 数值 / 标题——画布「＋图表 ▾」按类型插入示例数据，双击图表或选中后「编辑数据」打开数据表（行是类别、列是系列，可增删），保存即提交同一个 `chart_set_data`；数据表里还能换类型（`chart_set_type`；饼图 / 圆环图只能一个系列；导入的图表换类型后按新图表导出、换新形状 id，原文件里的图表样式不保留）；AI 经 `deck_edit` 用同样的操作，`slide_read` 打印图表数据。画布按数据画 SVG 近似预览，精确效果看 LibreOffice 预览。导出：新建图表生成图表部件 + 内嵌工作簿；导入的图表改数据后修补原部件缓存（保留系列样式、数据标签；增系列克隆末个系列换色）并重写内嵌工作簿 Sheet1，PowerPoint「编辑数据」看到的就是新数据。已核对 LibreOffice 与 macOS 快速查看；快速查看的缩略图对饼图只画整圆、对空值不按 idx 对位（python-pptx 生成的文件同样如此，属其渲染器限制）。
- **过渡**：Collabora / WOPI 已于 2026-10-01 随 S 系列停用。

## 8. MCP 接口面

dsh 经 `/mcp`（Streamable HTTP，无状态）访问；MCP server 名 `heurion`，模型看到的工具名为 `mcp__heurion__<tool>`。令牌按 `(用户, 文档集合, 权限, 过期时间, 用途=mcp)` 签发，一个会话可编辑该用户的多份文档；浏览器令牌与 MCP 令牌不通用。

### 8.1 工具

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `doc_list` | — | 可访问的文档 |
| `doc_create` | `title, markdown?` | `doc_id, rev`（初始内容同样受守卫约束） |
| `doc_outline` | `doc_id` | rev、标题树（块 id、各节块数与字数）、引用与评论数 |
| `doc_read` | `doc_id, section_id? / from_id..to_id? / cursor?` | 带 `{#id}` 前缀的 markdown，分页；末尾列出范围内的 open 评论 |
| `doc_search` | `doc_id, query` | 命中块 id 与片段 |
| `doc_edit` | `doc_id, base_rev, ops[], ack_comments?, mode?` | 新 rev、逐 op 结果（新增 / 受影响 id）；整批原子 |
| `doc_history` / `doc_diff` | `doc_id` / `from_version, to_version?` | 版本列表 / 块级变化 |
| `comments_list` / `comment_reply` / `comment_resolve` | `doc_id, …` | 线程与锚点 / 回复（role=ai）/ 关闭（规则见 §5.4） |
| `pubmed_search` / `doi_lookup` | 检索式 / DOI | 文献元数据 |
| `insert_citation` / `list_citations` | `doc_id, doi` / `doc_id` | `cite_id` 与 `[@c:id]` 标记 / 登记表与文中编号 |
| `asset_upload` | 工作区内相对路径 | `asset_id`（png/jpg/svg/gif/webp ≤ 10MB；路径限制在工作区内） |
| `kb_search` | `query, file_ids?, project?, top_k?` | 参考资料库片段与出处（文件、页码、DOI / PMID）；关键词 + 向量（本地 bge-m3）RRF 合并 |
| `kb_read` | `file_id, from_page?, to_page?` | 资料原文（按页） |
| `memory_propose` | `content, kind, scope?, reason?, explicit?` | 提议一条记忆（待用户确认）；`explicit` = 用户明确要求，直接生效。敏感内容被拦（`sensitive_content`）；本轮关闭记忆时 `memory_off` |
| `memory_search` | `query` | 已生效的相关记忆（全局 + 当前项目） |
| `memory_forget` | `target, memory_ids?` | 用户明确要求忘掉时彻底删除；多条相近返回候选（`ambiguous`）先确认。暂停 / 本轮不用记忆时也可用 |

### 8.2 doc_edit 操作

| op | 参数 | 说明 |
| --- | --- | --- |
| `insert_after` / `insert_before` | `anchor_id, markdown` | 插入一个或多个块；锚点是列表项时插入列表项 |
| `replace_block` | `id, markdown` | 整块替换，第一个块沿用原 id 与段落样式 |
| `replace_text` | `id, find, replace, occurrence?` | 块内替换，**小改动首选**：原文即守卫（不看 `base_rev`）、最小差异写入、保留格式 / 引用 / 锚点；find 容忍 markdown 转义与强调符号；失配返回近似候选 |
| `delete` | `ids` | 删除最后一个块时留空段落 |
| `move` | `ids, after`（null = 文档开头） | |
| `set_block_style` | `id, type?, level?, align?, style?` | 段落 ↔ 标题、级别、对齐、Word 样式名 |
| `table_set_cells` / `table_insert_rows` / `table_delete_rows` | `id, …` | 单元格内容为行内 markdown |

`mode: 'suggest'`：修改作为待采纳修订提交（块级：改动的块 = 原块待删除 + 新块待新增；新增块待新增；删除的块留在原位待删除；同一批共享修订组）。页面勾选「修订模式」时回合在服务端强制 suggest，不依赖模型传参。修订中的块不能再被 AI 修改（`pending_suggestion`）；读视图标出 `⟨待采纳·新增 / 删除⟩`；导出按「未采纳」处理。

### 8.3 安全边界

- 文档只能经 MCP 写入；shell 与工作区只做计算，工作区里没有文档文件。
- profile 关闭 `session-log-deepseek` 与 dsh 联网工具，外部检索只走 MCP；不加载 dsh office 技能。
- shell 仍在，因此仍是 danger-full-access：M2 的每用户容器、出口白名单、非 root 运行是上线前提。
- **账户与鉴权**（`src/auth/`，迁移批次 R1）：开放注册，第一个用户是管理员；用户名 + bcrypt 密码；登录令牌是平台签名令牌（aud=web）带账户令牌版本，停用、改密码、退出所有设备、管理员强制下线时版本加一，旧令牌立即失效。所有文档接口、资产、协同网关、MCP、队列按所有者隔离，另一用户访问一律 404（`tests/accounts.test.ts` 逐接口验证）。
- **防机器人**（`auth/bot-guard.ts`）：注册与登录需要工作量证明（服务端签名的 SHA-256 题，浏览器后台约 1 秒算完，一题一用，同一来源失败越多题越难）+ 陷阱字段 + 领题后最短 1.5 秒；另按 IP 限流（注册 5 次 / 小时，登录 20 次 / 5 分钟，同一用户名连续 5 次密码错误锁 15 分钟）。自建、不依赖第三方验证码（境内可用、不外发用户信息）。
- **开发模式**（`HEURION_DEV_MODE`，生产默认关闭）：另外接受开发令牌，`<token>:<名字>` 映射到独立开发用户（e2e 用 `dev:e2e`）；管理员可把开发期文档认领到自己的账户。生产环境必须设置 `HEURION_SECRET`。
- **邮箱与找回密码**（能力同 1.0，经 Resend 发信：`RESEND_API_KEY`、`EMAIL_FROM`；开发环境未配置时验证码打在服务日志里）：个人设置里绑定邮箱（发码 → 核对）；登录页「忘记密码」发码 → 验证码 + 新密码，重置后所有旧登录失效并直接登录。验证码 6 位、10 分钟有效、60 秒内不重发、错 5 次作废、一次有效，只存哈希；找回发码需人机校验，且不论邮箱是否注册都返回同样结果（修复 1.0 可探测邮箱是否注册的问题）。没绑邮箱的用户在工作台看到一次绑定提醒。
- **文档仓库 · 我的文档**（R2）：项目（文件夹）——文档可归入项目、在项目间移动，删除项目时文档回到「未分组」；新文档放进当前文档所在的项目。全文搜索（标题 + 正文，SQLite FTS5 trigram：3 个字以上走索引，1–2 个字退回 LIKE；文档提交后 2 秒防抖更新索引，启动时补齐）；左栏搜索框显示命中片段。回收站：删除即移进回收站（列表、编辑、协同、MCP、排队中的 AI 任务都不可访问），可恢复，30 天后自动彻底删除，也可手动彻底删除。复制文档：内容、项目、引用（换新 id、正文标记跟着改）、幻灯片的原始 pptx 包与形状原文；不复制评论与历史。AI 侧：`docs_search`（跨文档搜索），`doc_list` 带项目名。
- **1.0 账户导入**：`pnpm import-h1-users <1.0 库路径> [--apply]`，默认预演；1.0 已验证的邮箱一起导入。

## 9. 前端

- **P0**（`apps/platform/src/web/index.html`，无构建）：文档列表、新建 / 上传 docx；只读预览（文档变更 SSE 推送，AI 改动的块高亮闪烁）；选中文字 → 评论 / 评论并让 AI 处理；对话（工具步骤可见、可停止）；版本（保存、对比、回滚）；引用；导出 md / docx；读视图（看模型看到的内容）。
- **P1**（`apps/platform/web`，Vite 构建，server 托管 `dist-web/`）：ProseMirror 编辑器（schema 与服务端共用）+ y-prosemirror + 自制 provider（断线重连、重连后补齐双方缺失更新）；工具栏（段落 / 标题、粗斜下划线、上下标、列表、表格、撤销重做）与快捷键、Markdown 式输入规则、表格编辑（prosemirror-tables）；AI 改动的块高亮；选区评论与 @heurion；修订在正文里标红 / 绿并可就地采纳或拒绝；有待采纳修订时正文上方出现修订提示条（处数、上一处 / 下一处、全部采纳 / 拒绝），不单设页签；对话里每轮可「撤销本轮修改」；事后检查提示。视觉语言取自 Heurion logo：墨蓝石板主色 + 天蓝 AI / 强调色、圆角胶囊，左栏墨色底带品牌标识，支持深色模式。交互：没有浏览器原生弹窗（新建直接建「未命名」并就地改标题、点标题重命名，其余用页内对话框）；导出合并为一个菜单；没打开文档时是欢迎页（新建 / 上传 + 示例指令，点示例新建并把指令填进对话框）；AI 的工作过程以人话显示（「检索 PubMed：…」「修改文档（2 处操作）」），每轮结束折叠成「已完成 · N 步」；每轮改动后正文上方出现「本轮 AI 改了 N 处 · 上一处 / 下一处 · 撤销本轮」；失败 / 超时 / 被停止的回合可一键重试（原要求、原选项）；三栏各自滚动，对话输入框始终可见。多人光标（awareness）留到 P3。
- **P2**：deck 编辑面（Univer 画布 + 评论面板 / 形状锚点）。

## 10. 决策记录

| 决策 | 选择 | 原因 / 代价 |
| --- | --- | --- |
| 真相源 | 结构化模型（Yjs）持有真相；文件 = 导入 / 导出视图 | 编辑器不再能摧毁寻址体系（实测：LO 丢 paraId、重编号 shape id） |
| 代码位置 | 新建 `apps/platform`，S 系列 `apps/server` / `apps/web` 停用 | 新架构与旧的文件真相模型不兼容，不在旧代码上改 |
| AI 编辑方式 | MCP `doc_edit(ops)` + 写前守卫；shell 保留给计算 | 守卫成为硬闸；「复述原文失配」「整文件重生成」被结构消灭；实测模型只在数字数时用 shell |
| 用户优先 | `base_rev` + 节点变更索引；`replace_text` 以原文为守卫 | 整块改写不依赖模型复述原文；小改动的原文本来就要写出，用它判定比整块 rev 更细，用户改同段别处不误伤 |
| 回合队列 | 进程内 FIFO + SQLite 持久化，不引入消息队列 | 单实例、每用户一个 dsh 进程，SQLite 已满足持久、可取消、可查看；Redis / BullMQ 在多实例或独立 worker（M2 多账户横向扩展）时再换，队列逻辑集中在 `TurnService`，替换面小 |
| 评论锚点颗粒度（2026-10-01 JZ） | doc 同 Claude Docs：段落内或整块；deck 最小颗粒度：段落内或整个形状 | 跨段落锚点让「改什么」含糊，AI 修改也随之跨段；选区阶段拦下比事后猜测可靠 |
| 内容格式 | markdown 方言 + 块 id 前缀 | 对 LLM 友好、token 少；实测 deepseek-flash 一次写对 |
| 引用 | `[@c:id]` 原子节点，编号与参考文献表由平台生成 | 编号永不错乱；手写引用在写前被拦截 |
| doc 导入 / 导出 | 自写 OOXML 解析 + 修补式导出 | 未改动的块逐字节保真；mammoth / docx npm 包做不到 |
| dsh 进程粒度 | 每用户一个 | 文档不在工作区里，一个会话可编辑多份文档 |
| 编辑器 | 直接用 ProseMirror，不套 Tiptap | 前后端共用同一份 schema，Yjs 结构由一份定义保证一致；Tiptap 的默认节点名 / 属性与平台 schema 不同，硬对齐容易出现细微不一致而损坏协同数据。Tiptap 也是 ProseMirror 的封装，需要其 UI 扩展时可迁移 |
| 协同 | Yjs + y-prosemirror + 自制最小 ws 协议（帧 = 类型 + y-protocols sync） | y-websocket 协议面大于需要 |
| 修订粒度 | 块级 | 实现稳、和块 id / 冲突守卫同一粒度；字符级修订留到需要时再做 |
| AI 回合撤销 | 每回合一个服务端 Y.UndoManager | CRDT 语义下只撤该回合的改动，用户期间的编辑保留；服务重启后不可用，退回版本回滚 |
| deck 内核（P2） | 自建模型 + 修补式导出；画布在查看器上自建（2026-10-02 由 Univer 改为自建） | Univer 开源版 slides 是原型、完整功能在 Pro；自建画布与操作层同一套模型，每个手势都是 AI 也能用的操作 |
| 人和 AI 能力一致（2026-10-02 JZ） | 画布的每个编辑都是共享的 deck 操作，MCP 同样开放 | 平台的核心是 AI 经 MCP 编辑；只有界面能做的功能会让 AI 做不到用户要求的事 |
| 放弃 OnlyOffice（2026-10-01 JZ） | 自建内核 | 引擎在外 = 渲染 / 载体 / 许可三重不可控 |
| Collabora | 2026-10-01 随 S 系列停用 | 平台模式下接入需「导出 → 编辑 → 整份导入」，不再值得维护 |

## 11. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 生成块的样式与原文档不完全一致 | 改过的段落在 Word 里观感略有差异 | 生成时沿用原文件的样式表与编号；评测纳入「导入 → 修改 → 导出」专项 |
| 导入覆盖面（文本框、域代码、脚注、复杂编号） | 部分内容只读 | opaque 原样写回不丢；按评测样本逐项扩展 |
| 协同层（Yjs 持久化、断线重连） | 数据安全 | 每次提交写全量状态 + op log；关停前落库；单进程持有每文档 Y.Doc（多实例部署需要按文档路由） |
| 编辑器拆段 / 粘贴产生重复 id | 寻址错乱 | 浏览器与服务端两端补号，服务端落库前强制唯一 |
| Casual Slides 上游年轻 | deck 地基 | fork 进组织；导入层隔离清晰，可整体自维护 |
| 模型对新工具面的适配 | 回合成功率 | e2e 任务集持续回归；错误码附 hint 与 current |
| shell 仍可执行任意代码 | 安全 | M2 每用户容器 + 出口白名单 |
| 正文发往 DeepSeek 官方 API | 合规 | M2 PHI 评审；预留私有部署模型路由 |

## 12. 分期 P0–P3

| 期 | 内容 | 退出条件 | 状态 |
| --- | --- | --- | --- |
| **P0 doc 模型与操作层** | 模型 + Yjs 持久化；操作层与写前守卫；MCP 工具面；dsh 接入；评论锚点与 @heurion；版本；docx 导入 / 修补式导出 | e2e 任务集全绿；未改动块导出逐字节保真；导出可被 LibreOffice 打开 | ✅ 2026-10-01 |
| **P1 doc 编辑面** | ProseMirror 编辑器 + y-prosemirror + 自制 ws 协议；用户编辑合批落库与 id 修复；事后检查；用户撤销 + AI 回合撤销；修订（suggest）模式；回合队列 | 用户逐字编辑与 AI 修改并行无丢失；断线重连恢复 | ✅ 2026-10-01 |
| **P2 deck 内核** | deck 模型（PM + Yjs）；pptx 导入 / 修补式导出 / 新建模板；`slide_read` / `deck_edit` / `layout_check` / `slide_render`（LibreOffice）；deck 查看器；**Univer 画布编辑**（下一步） | deck e2e 全绿；未改动 deck 导出逐字节一致；画布编辑可用 | 🟡 2026-10-01 后端 + 查看器完成（e2e 25 项含幻灯片从零制作 / 插页改页；3 份真实 deck 往返逐字节一致）；画布编辑待做 |
| **P3 硬化** | deck 多人协同 / 离线恢复 / 权限细化 / 大文档性能 | M1 同口径评测达标 | — |

**验证（2026-10-01）**：单测 41 项（模型 / 操作层 / 守卫 / MCP / docx 往返 / 协同网关 / 修订）；浏览器测试 11 项（`pnpm ui`，真实 Chromium：打字同步、拆段 id、工具栏、选区评论、修订就地采纳、撤销、断线重连）；e2e 19 项（`pnpm e2e`，真实 dsh + deepseek-flash，含 @heurion 自动触发、修订模式、撤销本轮、LibreOffice 打开导出文件）；3 份真实 docx「导入 → 不改 → 导出」正文逐字节一致。

**P0 实测（deepseek-flash，2026-10-01）**

| 任务 | 耗时 | 工具调用 | 结果 |
| --- | --- | --- | --- |
| 起草带两篇引用的证据段 | 22s（S 系列同类 43s） | 9 次，0 报错 | 引用经 PubMed / Crossref 登记，正文无 DOI，引言未动 |
| 评论驱动修改 | 12s | 6 次，0 报错 | `replace_text` 一处，锚点保留，线程回复、留给用户关闭 |
| 同会话追问压缩 | 19s | 6 次，0 报错 | 保留两个 HR 与引用；shell 仅用于数字数 |
| 导入 docx 后改一段 | 9s | 5 次，0 报错 | 其余块导出时原样写回 |
