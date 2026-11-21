# MCP 模块化与 Aegis-OS 接入

**状态：** 阶段 0 已完成，阶段 1 未开始（见 §5 阶段表）· 本文是 MCP 对外接入与 Aegis 融合的**唯一**现行文档，实施时在这里更新状态。取代已删除的 `design/AEGIS_APP_PROTOCOL.md` 与 aegis-app-sdk 包的 README（历史版本见 git）。

## 1. 目标与用户体验

Heurion 现在主要给人用：浏览器登录、在界面里操作；AI 经平台自己的 dsh 回合工作。下一步把工作台的每个模块抽成**独立的 MCP**，让外部智能体（例如运行在 Aegis-OS 上的 agy）安全地调用：

1. 用户打开 agy，agy 作为 **Aegis-OS 的受限进程**运行（影子工作区、内核沙箱、出站代理）。
2. Aegis 的一级目录里列出 Heurion 的各个模块（每个一行）。用户授权哪个模块，agy 就按需挂载哪个模块的 MCP。
3. 调用时由 Aegis 在出站边界注入令牌与请求头，**令牌不进入模型上下文**。
4. 高危操作（不可恢复的删除、机构设置、临床确认、对外发信等）返回需要租约，由用户在 Aegis 里批准后签出租约、重试。
5. 不论哪个智能体调用，文档写入都经 Heurion 服务端的操作层与写前守卫（来源规则、引用守卫、安全小改、用户优先），**守卫不依赖智能体自觉**（与论文一的论点一致）。

## 2. 现状（以代码为准，2026-11-21）

### 2.1 两条接入路径

| 接入方 | 入口 | 鉴权 | 工具范围 |
|---|---|---|---|
| 平台内的 dsh 回合 | `/mcp`（`handleMcp`，只允许回环地址；对外由 Caddy 返回 404） | 平台签发的 MCP 令牌，`claims.u` 用户、`d` 文档、`p` 权限、`s` dsh 进程、`t` 范围；进程停止后令牌立即失效（`isLiveSession`） | `mcp/scope.ts`：`t=doc` 普通稿件、`t=deck` 幻灯片、缺省全部 |
| 外部智能体（AAP-1.0） | Node 处理器 `handleAegisMcp`（`/api/aegis/mcp`、`/api/mcp`，仅 `Accept: text/event-stream`）；Hono 路由 `POST /api/aegis/mcp` → `handleAegisMcpJsonRpc` | 授权令牌 `aegis_at_heurion.<grant_id>.<secret>`（服务端只存哈希，随用户令牌版本、用户与机构状态失效）；请求头 `X-Aegis-Agent-Id / Org-Id / Turn-Id / Lease-Token` | 授权上的 `tool_scope` |

两条路径都由 `buildMcpServer()`（`apps/platform/src/mcp/server.ts`）构建；外部路径经 `buildAegisMcpServer()` 包一层，加上 `aegisToolScope`、租约检查 `leaseAuthorizer`、代理 id 与回合前缀 `aegis:<agent>:`。

**开关：** 外部路径全部受 `HEURION_AEGIS` 控制（`config.ts` 的 `aegisEnabled`，默认关，生产环境关）。关闭时 `/api/aegis/*` 与 `/.well-known/aegis-*` 一律 404。

### 2.2 已实现的 AAP-1.0 部件

- **应用清单** `GET /.well-known/aegis-app.json`（`aegis/manifest.ts`）：`schema_version: 'AAP-1.0'`、各鉴权端点、能力预览（`zero_prompt` / `lease_gated`）、技能包 `/.well-known/aegis-skills/heurion-clinical-research/SKILL.md`。
- **鉴权**（`aegis/auth.ts` + `http/api.ts`）：
  - 设备码登录（RFC 8628）：`/api/aegis/auth/device`、`/device/approve`，表 `agent_device_codes`；
  - 令牌兑换与吊销：`POST / DELETE /api/aegis/auth/token`（AI 不能自己签发，`human_only`）；
  - 授权列表 `/api/aegis/auth/grants`，表 `agent_grants`。
- **租约**：离线租约由本地 Aegis 节点用 Ed25519 私钥签名，Heurion 用授权登记的节点公钥验签，最长 15 分钟（`MAX_OFFLINE_LEASE_SEC`）；在线租约由用户经 `/api/aegis/leases/approve` 批准。
- **工具范围** `tool_scope`（`store/db.ts`）：`all | canvas | clinical | research | readonly`，由 `aegisScopeAllows` 按工具名正则过滤。
- **回合与回滚**：外部智能体的写入记在 `aegis:<agent>:` 前缀的回合下，`doc_revert_turn` 可按回合或代理撤销。
- **为外部智能体准备的参数**：`asset_upload` 与报告上传支持 `data_base64`；数据集与化验长表的导出支持 `return_content`。

### 2.3 工具与模块现状

- 共 124 个 `registerTool`，分在 7 个注册函数里：`registerCanvasTools`（38）、`registerHealthcareTools`、4 个影像注册函数、`registerAdminTools`（15 个管理工具：account、tenant_admin、org_template、phr_share、platform_admin、doc_manage、project_manage、comment_manage、dataset_manage、kb_manage、memory_manage、patient_admin、study_admin、task_queue、asset_provenance）。
- 所有工具共用一个请求上下文 `Ctx`：文档权限（`check`）、当前回合、来源规则二的观察记录键（`observeKey`）、租约检查。
- `apps/canvas-service` 用 `buildCanvasMcpServer()` 只挂画布工具（服务名 `omnicanvas`），单独部署，是「按模块拆分」的先例。
- `packages/aegis-app-sdk`（只有 `src/index.ts`，没有 `package.json`）：给第三方应用用的清单校验、令牌、请求头解析、Ed25519 租约工具；平台经相对路径 `aegis/sdk.ts` 引用，`tests/aegis-app.test.ts` 在用。

### 2.4 已知不一致（实施时修）

| 问题 | 位置 | 处理阶段 |
|---|---|---|
| 清单宣称不存在的能力：`dataset_analyze`、`phr_share_admin`、`mail_admin` | `aegis/manifest.ts` | 2（清单按模块生成） |
| `tool_scope` 的 `clinical`、`research` 没有过滤规则，等同 `all` | `aegisScopeAllows` | 2（改为模块权限） |
| SDK 与平台不一致：协议名 `aegis-app/1.0` vs `AAP-1.0`；请求头 `X-Aegis-Session-Id` vs `X-Aegis-Turn-Id`；错误码 `lease_required` vs `approval_required`；包无法按名导入 | `packages/aegis-app-sdk` | 2 |
| 两套接入代码：Node 处理器与 Hono 处理器各一份；`api.ts` 另拼一份 `aegisMcpDeps`（固定字符串密钥、`isLiveSession` 恒为真、依赖与 `index.ts` 的 `mcpDeps` 不同步） | `index.ts`、`http/api.ts` | 1 |
| 工具说明 `INSTRUCTIONS` 是一整段，含 dsh 专用内容（shell 里跑 Python、工作区 `data/`） | `mcp/server.ts` | 3 |
| 接收文件的工具多数只认服务器工作区里的 `path` | asset、报告、知识库、数据集、DICOM | 3 |

## 3. 方案

### 3.1 模块注册表

目标形态：每个模块一个声明（阶段 0 先落了注册表 `mcp/modules.ts`，见下文）：

```ts
interface HeurionModule {
  id: ModuleId
  title: string
  summary: string                          // Aegis 一级目录里的一行
  register(server: McpServer, ctx: Ctx): void
  requires: Array<keyof McpDeps>           // 缺依赖就不挂
  readOnlyTools: string[]                  // 只读授权时保留的工具
  leaseGated: Record<string, string>       // 工具 → 租约 scope
  instructions: string                     // 该模块的工具说明
}
```

- `buildMcpServer()` 改为挂上全部模块，给 dsh 用，**行为不变**。
- `mcp/scope.ts`（doc / deck）与 `aegisScopeAllows`（正则）都改成按「模块 + 只读标记」计算，不再靠工具名前缀。

**阶段 0 的实际做法**（`apps/platform/src/mcp/modules.ts`）：工具注册代码暂不搬家，注册表按工具名（名字优先、其次前缀）登记每个工具属于哪个模块；`buildMcpServer` 新增可选的 `modules`，只挂指定模块的工具，不给时与拆分前逐字一致。只读工具集合 `READ_ONLY_TOOLS` 移进注册表，取代 `AEGIS_READONLY_TOOLS` 正则（测试证明逐个一致）。两处范围规则留到阶段 2，因为它们不能写成模块的并集、硬改会改变行为：
- Aegis 的 `canvas` 范围正则 `/^(doc_|comment…)/` 顺带放进了 `doc_manage`、`comment_manage` 两个管理工具；
- dsh 的 doc / deck 范围只排除了一部分管理工具（`tenant_admin`、`platform_admin` 等），`doc_manage`、`dataset_manage` 等仍在稿件范围里。

### 3.2 模块划分（按工作台界面）

| 模块 | 工具（前缀 / 名称） | 工具数 | 说明字数 | 默认对外部智能体 |
|---|---|---|---|---|
| `writing` 写作 | doc_*、docs_search、deck_templates、deck_edit、slide_*、layout_check、comments_list、comment_add / reply / resolve、image_search、insert_measurement、list_measurements、asset_upload、diagram_render | 26 | 约 3.4 万 | 开放 |
| `literature` 文献 | pubmed_search、openalex_search、oa_fulltext、doi_lookup、insert_citation、list_citations、import_references、verify_claims、claim_report | 9 | 约 0.5 万 | 开放 |
| `analysis` 数据分析 | dataset_*（dataset_manage 除外）、result_register、result_list | 12 | 约 1.1 万 | 机构开启后 |
| `patients` 患者与知家 | patient_*（patient_admin 除外）、labs_*、lab_*、report_*、share_*、phr_member_links、phi_scan | 25 | 约 1.0 万 | 机构开启后 |
| `imaging` 影像 | imaging_* | 29 | 约 2.5 万 | 机构开启后 |
| `research` 临床研究 | study_*（study_admin 除外） | 16 | 约 1.3 万 | 机构开启后 |
| `knowledge` 资料库 | kb_search、kb_read | 2 | 约 0.1 万 | 开放 |
| `memory` 记忆 | memory_*（memory_manage 除外） | 4 | 约 0.2 万 | 开放 |
| `admin` 管理 | 15 个管理工具、action_status、delegate_task | 17 | 约 1.5 万 | 只读开放，写操作走租约 |

合计 140 个工具（124 个业务工具 + 15 个管理工具 + action_status）。说明字数按工具定义的 JSON 长度计。

跨模块引用（例如写作里的 `insert_measurement` 要读影像 / 分析的结果）由服务端完成，不要求智能体同时挂两个模块。

### 3.3 按模块开放

- **地址**：`/api/aegis/mcp/:module`，每次请求只构建该模块的 McpServer。Aegis 三级发现的第三级只拉一个模块的工具定义。
- **清单**：`aegis-app.json` 增加 `modules[]`（id、一句话说明、MCP 地址、只读工具、需租约的工具、技能文档地址），能力预览由注册表生成，不再手写。仍是一个应用 `heurion`：一次登录、一个授权。
- **授权**：`agent_grants.tool_scope` 改为模块权限列表，例如 `writing:rw, literature:r, patients:r`；设备码确认页逐个列出模块让用户勾选。旧的 `all / canvas / readonly` 迁移为等价的模块列表。
- **跨模块观察记录**：来源规则二的观察记录键统一为 `sess:<grant>:<X-Aegis-Session-Id>`（没有会话头时退回 Turn-Id）。智能体经患者模块读到的数字，再经写作模块写进稿件时仍算「看到过」。外部智能体在本机影子工作区里自己算出的数字**不算**，要经 `result_register` 登记后才能写入。
- **合并接入代码**：两个处理函数合成一个，依赖统一用 `index.ts` 的 `mcpDeps`（真实密钥、真实会话判断、`invoke`）。

### 3.4 外部智能体适配

- **文件进**：外部智能体的文件在用户本机的影子工作区，`path` 对它没有意义。所有接收文件的工具统一支持 `data_base64`；大文件（DICOM、数据集）走「申请上传地址 → 直传 → 拿到 id」。
- **文件出**：`dataset_open` 一类对外部智能体一律直接返回内容（≤5MB）或给下载地址。
- **说明拆分**：`INSTRUCTIONS` 拆成三部分：共同规则（来源规则、引用、测量、沟通方式）、各模块自己的说明、dsh 专用（shell、工作区）。外部智能体只拿共同规则和所连模块的部分；每个模块另发布 `/.well-known/aegis-skills/<module>/SKILL.md`。

### 3.5 患者数据外发策略

dsh 回合的数据外发边界由 `harness/profile/heurion.cordis.yml` 守住（不开 `session-log-deepseek`、不开网页工具）。外部智能体背后接的是别家大模型，它一调用患者、影像、研究、分析模块，返回的化验、报告、影像结论就会进入那家厂商。患者只用代号，但这些仍是健康数据。

- `writing`、`literature`、`knowledge`、`memory` 默认开放。
- `patients`、`imaging`、`research`、`analysis` 默认关闭：机构管理员在机构设置里打开「允许外部智能体访问」后才能授权；按模块、按调用记审计日志（谁、哪个智能体、哪个患者 / 数据集）。
- 生产环境开启 `HEURION_AEGIS` 时按模块逐个开。

### 3.6 Aegis 侧约定（代码不在本仓库）

- 以受限进程启动 agy；一级目录里每个模块一行（`heurion/writing`：connected / available_not_connected + 一句话）。
- 出站代理注入 `Authorization: Bearer aegis_at_heurion.*`、`X-Aegis-Protocol: AAP-1.0`、`X-Aegis-Agent-Id`、`X-Aegis-Session-Id`、`X-Aegis-Turn-Id`，按需加 `X-Aegis-Lease-Token`。
- 收到需要租约的返回时，在 CLI 请用户批准，签出租约后重试。
- 同一次智能体回合的所有写入用同一个 `X-Aegis-Turn-Id`，Heurion 把它们归到一个平台回合，可整回合撤销。

## 4. 涉及的代码

| 文件 | 改动 |
|---|---|
| `apps/platform/src/mcp/modules.ts` | 模块注册表（阶段 0 已建） |
| `apps/platform/src/mcp/server.ts` | （以后）注册函数按模块拆到 `mcp/modules/`；`buildMcpServer` 改为挂全部模块；`INSTRUCTIONS` 拆分；`aegisScopeAllows` 换成模块权限 |
| `apps/platform/src/mcp/scope.ts` | doc / deck 范围改为按模块计算 |
| `apps/platform/src/index.ts`、`apps/platform/src/http/api.ts` | 合并两套 Aegis 处理函数与依赖；新增 `/api/aegis/mcp/:module` |
| `apps/platform/src/aegis/manifest.ts` | 由模块注册表生成 `modules[]` 与能力预览 |
| `apps/platform/src/store/db.ts` | `agent_grants` 的模块权限、机构「允许外部智能体」设置、外部调用审计 |
| `packages/aegis-app-sdk/src/index.ts` | 与平台的协议名、请求头、错误码对齐，补 `package.json` |
| 测试 | `tests/parity.test.ts`（工具清单前后一致）、`tests/aegis-app.test.ts`、新增模块权限与跨模块观察记录测试 |

## 5. 阶段与状态

| 阶段 | 内容 | 验证 | 状态 |
|---|---|---|---|
| 0 拆模块 | 模块注册表（`mcp/modules.ts`）；`buildMcpServer` 可选 `modules`；只读集合移进注册表 | `tests/mcp-modules.test.ts`：每个工具恰好一个模块、全部模块与不指定逐字一致、各模块并集 = 全部、只读集合与旧正则一致；全部测试通过 | ✅ 2026-11-21 |
| 1 合并接入 | 两个处理函数合一，统一依赖 | `aegis-app.test.ts` 通过；外部令牌在会话停止、用户停用后被拒 | 未开始 |
| 2 按模块开放 | `/api/aegis/mcp/:module`、清单 `modules[]`、模块权限（取代 `canvas` 范围正则）、dsh 的 doc / deck 范围改按模块计算、跨模块观察记录、SDK 对齐 | 每个模块只暴露自己的工具；只读授权写入被拒；患者模块读到的数字可经写作模块写入 | 未开始 |
| 3 外部适配 | 文件统一 base64 / 上传地址；说明与技能按模块拆 | 不经服务器工作区完成「上传图 → 插入稿件」「导出数据集 → 本机分析 → 登记结果 → 写入」 | 未开始 |
| 4 外发策略 | 机构开关、审计；生产逐模块开 `HEURION_AEGIS` | 未开启的机构授权患者模块被拒；审计可查 | 未开始 |
| 5 端到端 | agy 经 Aegis 跑通「写作 + 文献」，再扩到其他模块 | 真实稿件上完成一轮修改与引用，守卫生效、可整回合撤销 | 未开始 |

## 6. 待决定

1. ~~模块划分~~：按 §3.2 的九个（2026-11-21 定）。
2. ~~部署形态~~：同一进程按模块出多个地址（2026-11-21 定）。
3. 患者类模块对外部智能体的开放策略（§3.5）：待定，阶段 4 前定。

## 7. 变更记录

- 2026-11-21：阶段 0 完成：模块注册表与按模块构建；模块划分定为九个、同一进程按模块出多个地址（§6 第 1、2 项已定）。
- 2026-11-21：新建，合并并取代 AEGIS_APP_PROTOCOL.md 与 aegis-app-sdk 包的 README；现状按代码重新核对。
