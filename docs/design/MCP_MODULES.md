# MCP 模块化与外部接入

**状态：** 阶段 0–4 已完成；通用接入（个人访问令牌、OAuth 2.1）与 aegis-os v0.9 声明式清单已实现；阶段 5 用单一地址跑通（§3.7）。生产环境已打开 `HEURION_AEGIS`（2026-11-21；见 §5 阶段表）· 本文是 MCP 对外接入的**唯一**现行文档，实施时在这里更新状态。AAP-1.0（`aegis_at_*` 令牌、`aegis-app.json`）是兼容层、计划停用（§0.3）。取代已删除的 `design/AEGIS_APP_PROTOCOL.md` 与 aegis-app-sdk 包的 README（历史版本见 git）。

## 0. 接入指南

Heurion 的 MCP 是标准的 Streamable HTTP（只用 POST，响应一律 JSON，无状态），任何 MCP 客户端都能接，不依赖某个智能体运行时的协议。按工作台分成九个模块（§3.2），可以接全部已授权模块，也可以只接一个。站点开关 `HEURION_AEGIS` 关闭时以下地址一律 404。

### 0.1 通用接入：OAuth（推荐）或个人访问令牌

支持 MCP 鉴权规范的客户端（Claude Code、Cursor、MCP Inspector 等）只填地址即可：`claude mcp add --transport http heurion https://heurion.org/api/mcp`，首次连接会打开浏览器，登录 Heurion 后在确认页逐个模块勾选并批准（§0.4）。不支持 OAuth 的客户端用下面的个人访问令牌。

1. 登录 Heurion →「设置 → MCP 访问令牌」→ 逐个模块选「不开放 / 只读 / 读写」→ 签发，得到 `hr_pat.<id>.<secret>`（只显示一次；默认 90 天，可随时吊销）。患者、影像、临床研究、数据分析要所在机构先在机构设置里打开（§3.5）。
2. 地址：`https://<站点>/api/mcp`（全部已授权模块）或 `https://<站点>/api/mcp/<模块>`（`writing`、`literature`、`analysis`、`patients`、`imaging`、`research`、`knowledge`、`memory`、`admin`）。请求头只需 `Authorization: Bearer <令牌>`。例如 Claude Code：`claude mcp add --transport http heurion https://heurion.org/api/mcp --header "Authorization: Bearer hr_pat.…"`（设置页可一键复制）。
3. 可选请求头：`X-Agent-Id`（智能体标识，审计与撤销按它区分，缺省 `mcp-client`）、`X-Aegis-Session-Id`（同一会话读到的数字写进稿件时算有出处，缺省按回合）、`X-Aegis-Turn-Id`（同一回合的写入可整回合撤销；缺省时同一令牌闲置 10 分钟算新回合）。
4. 发现：公开的模块目录 `GET /api/mcp/modules`（地址、只读工具、需要批准的工具、技能文档）；每个模块的说明 `/.well-known/aegis-skills/heurion-<模块>/SKILL.md`；连接时 `initialize` 返回的说明只含所连模块。
5. 文件：`workspace_put` 放进工作区（≤10MB），更大的 `PUT /api/mcp/files/<path>`；`workspace_get` / `GET /api/mcp/files/<path>` 取回（§3.4）。
6. 高风险操作（不可恢复的删除、机构设置、临床确认等）返回 `approval_required`，由用户在 Heurion 网页「待确认操作」里批准后重试。写进稿件一律经服务端的操作层与来源规则，不依赖客户端自觉。

### 0.2 经 aegis-os v0.9：声明式 MCP 清单 + 标准设备码

- 清单 `GET /.well-known/mcp-bundle.json`（schema `aegis-mcp-bundle/v1`，`aegis/bundle.ts` 由模块注册表生成）：每个模块一个服务器 `heurion-<模块>`，地址是完整 URL（按请求的 origin，生产在反向代理后按 `X-Forwarded-Proto` 还原 https）；`trust_level = trusted_internal`、`dlp_mode = off`（作者邮箱、机构名不在本地假名化；患者在平台侧只用代号且受机构外发策略管控）、文献与资料库开 `strip_prompt_injection`、`request_timeout_ms = 300000`；`profiles`：默认开放的模块 `default / open / <模块>`，管理 `default / admin`，患者等四个 `clinical / full / <模块>`。`tool_overrides`：服务端已有回合撤销与来源规则保护的写工具标 `read_only`（免得本地防火墙把每次写入放进待审队列），需要租约的高风险工具标 `staged_write`。
- 鉴权：`auth_realm` 指向 RFC 8628 设备码端点 `/api/aegis/auth/device` 与 `/api/aegis/auth/token`。两者都接受表单（`application/x-www-form-urlencoded`）和 JSON；OAuth 的 `scope`（如 `writing:rw literature:r`）在没给 `modules` 时当作模块权限；`verification_uri` / `verification_uri_complete` 是完整 URL；轮询按 RFC 8628 §3.5 在顶层 `error` 返回 `authorization_pending` / `expired_token` / `access_denied` / `invalid_grant`，中文说明在 `error_description`（`code` 保留给老客户端）。拿到的令牌是 `aegis_at_heurion.*`，地址用 `/api/aegis/mcp/<模块>`（与 `/api/mcp/<模块>` 是同一个处理函数）。
- 字段名与枚举值按 aegis-os 源码（`aos-mcp-gateway/src/mcp_bundle.rs`、`mcp_firewall.rs`、`aos-egress/src/pseudonym.rs`）核对；尚未用 v0.9 的二进制实际跑过。

### 0.4 OAuth 2.1（`aegis/oauth.ts`）

按 MCP 鉴权规范实现，Heurion 自己就是授权服务器：
- **发现**：MCP 地址返回 401 时带 `WWW-Authenticate: Bearer resource_metadata="<站点>/.well-known/oauth-protected-resource<地址路径>", scope="…"`。`scope` 是建议申请的权限：整站地址给默认开放模块的读写，按模块的地址只给该模块（官方 SDK 优先用它，避免把九个模块全申请）。受保护资源元数据（RFC 9728）指向本站；授权服务器元数据（RFC 8414）在 `/.well-known/oauth-authorization-server`。
- **客户端**：动态注册 `POST /oauth/register`（RFC 7591；只发公开客户端，回调地址限 https、本机回环 http 或私有 scheme；每 IP 每小时 30 次）。尚不支持 Client ID Metadata Document。
- **授权**：`GET /oauth/authorize`（必须 PKCE S256；`resource` 必须是本站 MCP 地址，RFC 8707）。客户端或回调地址不对时直接显示错误，不重定向（防开放重定向）；其余错误按规范重定向回客户端。校验通过后转到应用里的确认页 `/app?mcp_authorize=<id>`（10 分钟有效；没登录先登录，登录后自动打开），用户按模块勾选并批准或拒绝，回调带 `code`、`state`、`iss`（RFC 9207）。
- **令牌**：`POST /oauth/token`（表单或 JSON）。授权码 5 分钟、一次性；访问令牌 `hr_oat.*` 1 小时；刷新令牌 `hr_ort.*` 30 天、每次刷新轮换（旧的访问令牌与刷新令牌立即失效）。撤销 `POST /oauth/revoke`（RFC 7009）。
- **与其余部分的关系**：一次授权就是授权表里的一行（设置页列为「OAuth 授权（自动续期）」，吊销即全部失效）；访问令牌的校验、模块权限 ∩ 机构允许、审计、来源规则都与个人访问令牌相同。模块没授权时 403 带 `error="insufficient_scope"`，客户端可据此追加授权。
- 元数据、注册、令牌、撤销与 MCP 地址开放跨域（`*`，只用 Bearer、不带 Cookie），给浏览器里的 MCP 客户端用。

### 0.3 AAP-1.0（兼容，计划停用）

`/.well-known/aegis-app.json`、`aegis_at_heurion.*` 令牌、`/api/aegis/mcp`、`X-Aegis-*` 请求头、Ed25519 离线租约照常可用（§2.2、§3.6），但新接入请用 §0.1 或 §0.2。停用条件：aegis-os 全部改用 §0.2 的清单与标准设备码（或 OAuth 2.1）之后，先停签新的 AAP 令牌，再关地址。

## 1. 目标与用户体验

Heurion 现在主要给人用：浏览器登录、在界面里操作；AI 经平台自己的 dsh 回合工作。下一步把工作台的每个模块抽成**独立的 MCP**，让外部智能体（例如运行在 Aegis-OS 上的 agy）安全地调用：

1. 用户打开 agy，agy 作为 **Aegis-OS 的受限进程**运行（影子工作区、内核沙箱、出站代理）。
2. Aegis 的一级目录里列出 Heurion 的各个模块（每个一行）。用户授权哪个模块，agy 就按需挂载哪个模块的 MCP。
3. 调用时由 Aegis 在出站边界注入令牌与请求头，**令牌不进入模型上下文**。
4. 高危操作（不可恢复的删除、机构设置、临床确认、对外发信等）返回需要租约，由用户在 Aegis 里批准后签出租约、重试。
5. 不论哪个智能体调用，文档写入都经 Heurion 服务端的操作层与写前守卫（来源规则、引用守卫、安全小改、用户优先），**守卫不依赖智能体自觉**（与论文一的论点一致）。

## 2. 现状（以代码为准，2026-11-21）

### 2.1 接入路径

| 接入方 | 入口 | 鉴权 | 工具范围 |
|---|---|---|---|
| 平台内的 dsh 回合 | `/mcp`（`handleMcp`，只允许回环地址；对外由 Caddy 返回 404） | 平台签发的 MCP 令牌，`claims.u` 用户、`d` 文档、`p` 权限、`s` dsh 进程、`t` 范围；进程停止后令牌立即失效（`isLiveSession`） | `mcp/scope.ts`：`t=doc` 普通稿件、`t=deck` 幻灯片、缺省全部 |
| 外部 MCP 客户端（通用） | `POST /api/mcp`、`POST /api/mcp/:module`，与下一行是同一个处理函数 | 个人访问令牌 `hr_pat.<grant_id>.<secret>`（设置页签发，存在同一张授权表里；`/api/me/mcp-tokens` 列出、签发、吊销）；请求头只要 `Authorization` | 令牌上的模块权限 ∩ 机构允许 |
| 外部智能体（AAP-1.0 兼容 / aegis-os） | Hono 路由 `POST /api/aegis/mcp`（授权里的全部模块）与 `POST /api/aegis/mcp/:module`（只挂该模块）→ `handleAegisMcpRequest`（MCP SDK 的 Web 标准 Streamable HTTP，无状态，响应一律 JSON；支持批量与通知；只声明 `application/json` 的客户端照常可用）。依赖与 dsh 同一份（`index.ts` 的 `mcpDeps` 经 `buildApi({ mcpDeps })` 传入） | 授权令牌 `aegis_at_heurion.<grant_id>.<secret>`（服务端只存哈希，随用户令牌版本、用户与机构状态失效）；请求头 `X-Aegis-Agent-Id / Org-Id / Session-Id / Turn-Id / Lease-Token` | 授权上的模块权限 |

两条路径都由 `buildMcpServer()`（`apps/platform/src/mcp/server.ts`）构建；外部路径经 `buildAegisMcpServer()` 包一层，加上模块权限 `aegisModules`、观察记录键、租约检查 `leaseAuthorizer`、代理 id 与回合前缀 `aegis:<agent>:`。

**开关：** 外部路径全部受 `HEURION_AEGIS` 控制（`config.ts` 的 `aegisEnabled`，代码默认关；生产 2026-11-21 起在 `deploy/docker-compose.yml` 打开）。关闭时 `/api/aegis/*` 与 `/.well-known/aegis-*` 一律 404。

### 2.2 已实现的 AAP-1.0 部件

- **应用清单** `GET /.well-known/aegis-app.json`（`aegis/manifest.ts`）：`schema_version: 'AAP-1.0'`、各鉴权端点、`modules[]`（每个模块的地址、默认开放方式、只读工具、需要租约的工具）与能力预览，均由模块注册表生成；技能包 `/.well-known/aegis-skills/heurion-clinical-research/SKILL.md`。
- **鉴权**（`aegis/auth.ts` + `http/api.ts`）：
  - 设备码登录（RFC 8628）：`/api/aegis/auth/device`、`/device/approve`，表 `agent_device_codes`；
  - 令牌兑换与吊销：`POST / DELETE /api/aegis/auth/token`（AI 不能自己签发，`human_only`）；
  - 授权列表 `/api/aegis/auth/grants`，表 `agent_grants`。
- **租约**：离线租约由本地 Aegis 节点用 Ed25519 私钥签名，Heurion 用授权登记的节点公钥验签，最长 15 分钟（`MAX_OFFLINE_LEASE_SEC`）；在线租约由用户经 `/api/aegis/leases/approve` 批准。
- **模块权限**：授权与设备码上的 `modules` 列（JSON，如 `{"writing":"rw","literature":"r"}`）；`r` 只挂该模块的只读工具，`rw` 挂全部。签发 / 设备码接口接受 `modules`（对象、`writing:rw,literature:r` 或数组）；设置页按模块选「不开放 / 只读 / 读写」。旧的 `tool_scope` 仍保留，没有 `modules` 的授权按它换算（`legacyScopeModules`）：`all` 全部读写、`readonly` 全部只读、`canvas` 写作 + 文献、`clinical` 写作 / 文献 / 资料库 / 记忆 + 患者 + 影像、`research` 同上换成分析 + 临床研究。
- **回合与回滚**：外部智能体的写入记在 `aegis:<agent>:` 前缀的回合下，`doc_revert_turn` 可按回合或代理撤销。
- **为外部智能体准备的参数**：`asset_upload` 与报告上传支持 `data_base64`；数据集与化验长表的导出支持 `return_content`。

### 2.3 工具与模块现状

- 共 124 个 `registerTool`，分在 7 个注册函数里：`registerCanvasTools`（38）、`registerHealthcareTools`、4 个影像注册函数、`registerAdminTools`（15 个管理工具：account、tenant_admin、org_template、phr_share、platform_admin、doc_manage、project_manage、comment_manage、dataset_manage、kb_manage、memory_manage、patient_admin、study_admin、task_queue、asset_provenance）。
- 所有工具共用一个请求上下文 `Ctx`：文档权限（`check`）、当前回合、来源规则二的观察记录键（`observeKey`）、租约检查。
- `apps/canvas-service` 用 `buildCanvasMcpServer()` 只挂画布工具（服务名 `omnicanvas`），单独部署，是「按模块拆分」的先例。
- `packages/aegis-app-sdk`（`@heurion2/aegis-app-sdk`）：清单类型与校验、授权令牌、请求头解析、Ed25519 离线租约签发与验签、`approval_required` 返回格式。平台的令牌与租约校验（`aegis/auth.ts`）直接用它，第三方照它实现与平台逐字一致。

### 2.4 已知不一致（实施时修）

| 问题 | 位置 | 处理阶段 |
|---|---|---|
| ~~清单宣称不存在的能力~~：清单改由模块注册表生成，测试保证列出的工具都存在 | `aegis/manifest.ts` | ✅ 2 |
| ~~`clinical`、`research` 没有过滤规则~~：改为模块权限，旧值按 §2.2 换算（`canvas` 不再顺带放进 `doc_manage`、`comment_manage`） | `mcp/modules.ts` | ✅ 2 |
| ~~SDK 与平台不一致~~（协议名、请求头、租约格式、错误码、包名）：平台改用 SDK 的实现 | `packages/aegis-app-sdk` | ✅ 2 |
| ~~外部智能体读到的数字不算「看到过」~~：网关总会开平台回合，观察记录键落在回合 id 上，而回合 id 下没人记录，开了来源规则（生产开着）时外部智能体写数字一律被拒。改为 `sess:<授权>:<会话>` 并由网关记录 | `mcp/server.ts` | ✅ 2 |
| ~~两套接入代码与两份依赖~~：已合为一个处理函数、同一份依赖（外部网关有意去掉 `subagents`、`executionSignals`，见 §6 第 4 项） | `index.ts`、`http/api.ts` | ✅ 1 |
| ~~工具说明是一整段、含 dsh 专用内容~~：按行标上所属，外部智能体只拿共同规则与所连模块 | `mcp/instructions.ts` | ✅ 3 |
| ~~接收文件的工具只认服务器工作区里的 `path`~~：外部智能体先把文件放进工作区再传 path（§3.4） | `aegis/files.ts`、`mcp/workspace-tools.ts` | ✅ 3 |

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
- **跨模块观察记录**：来源规则二的观察记录键统一为 `sess:<grant>:<X-Aegis-Session-Id>`（没有会话头时退回 Turn-Id）。智能体经患者模块读到的数字，再经写作模块写进稿件时仍算「看到过」。外部智能体在本机自己算出的数字**不算**，`result_register` 也登记不了（登记同样要求数值出现在平台记录的输出里）：要写进稿件的统计量用平台的分析工具（`dataset_survival`、`dataset_logistic` 等）算。自己放进工作区再用 `workspace_get` 读回的数字也不算。
- **合并接入代码**：两个处理函数合成一个，依赖统一用 `index.ts` 的 `mcpDeps`（真实密钥、真实会话判断、`invoke`）。

### 3.4 外部智能体适配（阶段 3 已实现）

- **文件进出**：平台接收文件的工具（数据集、资料库、文档导入、院徽、记忆导入、资产）都按用户工作区解析 `path` / `file_path`，所以不逐个改工具，而是给外部智能体一条进出工作区的通道（`aegis/files.ts`）：
  - MCP 工具 `workspace_put`（base64，≤10MB，落在工作区 `aegis-files/` 下，返回 path）、`workspace_get`（≤5MB 直接返回文字或 base64，更大的给下载地址）、`workspace_list`（`mcp/workspace-tools.ts`）。只在外部网关注册、挂在每个模块的地址上（`SHARED_TOOLS`），dsh 不注册；只读授权只挂后两个。
  - HTTP `PUT / GET /api/aegis/files/<path>`（同一授权令牌，写入要有读写模块，≤100MB）。
  - 一律按真实路径判断，`..`、绝对路径、指到工作区外的符号链接都拒绝。
  - `asset_upload`、`report_upload` 原本就支持 `data_base64`；`dataset_open`、`labs_open` 对外部智能体默认直接返回内容。
  - 影像工具的 `file_path` 不在此列：AI 直接给的影像路径本来就被 `tenancy/imaging-guard.ts` 拦下，影像只能经患者档案进入。
- **出处**：工作区文件工具的返回不计入观察记录（文件可能是智能体自己放进来的）。本机分析的数字不能登记、不能写进稿件（见 §3.3）。
- **说明拆分**（`mcp/instructions.ts`）：原说明按行标上所属（共同规则或某个模块）。dsh 拿全部、原文不变（测试用指纹锁定）；外部智能体只拿共同规则与所连模块的行，涉及 dsh 专有环境的行（shell 里跑 Python、回合开头注入的记忆、对话里的确认卡）换成外部版本，并附文件进出说明。
- **技能文档**：每个模块发布 `/.well-known/aegis-skills/heurion-<module>/SKILL.md`（共同规则 + 本模块说明 + 该地址上实际的工具清单），清单 `modules[].skill_url` 与 `skills[]` 列出。

### 3.5 患者数据外发策略（阶段 4 已实现，2026-11-21 定）

dsh 回合的数据外发边界由 `harness/profile/heurion.cordis.yml` 守住（不开 `session-log-deepseek`、不开网页工具）。外部智能体背后接的是别家大模型，它一调用患者、影像、研究、分析模块，返回的化验、报告、影像结论就会进入那家厂商。患者只用代号，但这些仍是健康数据。

- `writing`、`literature`、`knowledge`、`memory` 默认开放；`admin` 只读开放、需确认的操作走租约。
- `patients`、`imaging`、`research`、`analysis` 默认关闭：机构设置 `aegis_modules`（`auth/tenants.ts`）逐个打开后才可用。个人空间由本人在「机构与邀请」里打开（本人就是个人空间的管理员）。机构设置「患者数据可以交给外部模型分析」（`external_model_for_patients`）关闭时，这四个一律不开。
- 生效方式：每次请求都用「授权的模块权限 ∩ 用户所在机构允许的模块」（`aegisEffectiveModules`，`mcp/server.ts`），MCP 网关、文件直传、授权列表一致；机构打开或关掉立即生效，不用重新授权。被挡住的模块地址返回 403 `module_not_allowed_by_org`。设置页签发授权时这些模块显示「机构未开启」、不能选；已有授权里被挡住的模块标出「暂不可用」。
- 审计：这四个模块的每次工具调用记一条 `aegis.tool_call`（用户、智能体 id、工具与模块、授权 id、患者 / 数据集 / 研究等资源 id、成功与否），归到用户所在机构，机构管理员在「安全审计」里可查。默认开放的模块不记。
- 外部智能体自己也可以经 `tenant_admin update_settings` 提议打开，但那是需确认的操作，要用户批准租约。
- 生产环境：阶段 4 只实现策略；阶段 5 单一地址跑通后于 2026-11-21 打开 `HEURION_AEGIS`。

### 3.6 Aegis 侧约定（代码不在本仓库）

- 以受限进程启动 agy；一级目录里每个模块一行（`heurion/writing`：connected / available_not_connected + 一句话）。
- 出站代理注入 `Authorization: Bearer aegis_at_heurion.*`、`X-Aegis-Protocol: AAP-1.0`、`X-Aegis-Agent-Id`、`X-Aegis-Session-Id`、`X-Aegis-Turn-Id`，按需加 `X-Aegis-Lease-Token`。
- 收到需要租约的返回时，在 CLI 请用户批准，签出租约后重试。
- 同一次智能体回合的所有写入用同一个 `X-Aegis-Turn-Id`，Heurion 把它们归到一个平台回合，可整回合撤销。

### 3.7 阶段 5 端到端结果与 Aegis 侧缺口（2026-11-21，aegis-os 0.4.10）

**做法**：本机 Heurion（`HEURION_AEGIS=1`）→ `aegis-os app login heurion --token aegis_at_…`（独立 `--runtime-dir`，不碰 `~/.aegis`；本机地址需 `AOS_ALLOW_INSECURE_LOCAL_APP_ENDPOINT=1`）→ `app mount` 拿到 44 个工具（写作 26 + 文献 9 + 资料库 2 + 记忆 4 + 文件 3）→ agy 只用工作区级 `.agents/mcp_config.json` 接 `aegis-os mcp-stdio`（全局 `~/.gemini` 配置不改），会话级 `--settings` 只放行 `mcp(aegis-os/app_call_tool)`，`--sandbox` 运行。

**结果**：
- agy 经 `app_call_tool` 完成「新建稿件 → PubMed 检索 → `insert_citation` 登记 → `doc_read` → `doc_edit` 带 `[@c:…]` 改写」，写入经操作层、记在 `aegis:` 回合下。
- 来源规则在服务端生效：无出处的数字（「5 年生存率 47.3%」）被拒（`unobserved_number`）；`doc_revert_turn` 可撤销。
- **规则缺口**：agy 把编造的「5 年总生存率 52.4%」放进带引用的句子，而该文献只存了摘要——按规则二这是「摘要里查不到、无法核对」，当时**写入并标 `needs_user_check`**，不拒绝。agy 如实转告了核对提示，但编造的数字确实进了稿件（以 AI 未确认文字、待核对的形式），确认只靠智能体转告。已改：这种情况整批转为待采纳修订，人采纳才进正文（§6 第 6 项）。
- agy 在无交互模式下有一次想跑终端命令，被会话权限拒绝、没有产出；提示词明确禁止后正常。

**Aegis 侧缺口**（aegis-os 仓库，不在本仓库修）：
1. 不发 `X-Aegis-Turn-Id`：同一智能体的所有调用落在一个平台回合里（命令行测试与之后的 agy 运行共用同一个回合号），整回合撤销会撤掉它自始至终的改动。应按智能体的每一轮发一个 Turn-Id。
2. 只认单一地址 `/api/aegis/mcp`：不读清单的 `modules[]`、不能按模块挂载；登录时请求 `tool_scope: all`，不传 `modules`。一级目录还不是每个模块一行。
3. `X-Aegis-Session-Id` 固定为 `ses-<org>-<agent>`：观察记录跨所有会话共享，粒度偏粗。
4. `app connect --token aegis_at_…` 不认现成令牌，仍走设备码；`app login --token` 可以。
5. 租约判断在客户端按 `capabilities_preview` 的工具名做；现在清单由注册表生成，名字都存在，但管理工具按动作区分是否要租约，客户端按工具名判断会偏严。

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
| 1 合并接入 | `handleAegisMcpRequest` 取代 Node 处理器与手写 JSON-RPC 转发；`buildApi` 接收 dsh 的 `mcpDeps`；去掉只在 SSE 下可用的 `/api/mcp` 别名；非 JSON 的 Content-Type 按 JSON 处理；单个请求 120 秒超时回 504 | `aegis-app.test.ts`（含新增：initialize 握手、声明 SSE 的客户端拿到 JSON、批量、通知 202、网关使用传入依赖）；本地真实服务 `HEURION_AEGIS=1` 下纯 JSON 客户端、SSE 客户端、批量请求均通过；令牌随用户停用 / 全端下线 / 吊销失效（原有用例） | ✅ 2026-11-21 |
| 2 按模块开放 | `/api/aegis/mcp/:module`、清单 `modules[]`（由注册表生成）、授权上的模块权限（取代 `tool_scope` 正则，旧值换算）、设置页按模块授权、观察记录键 `sess:<授权>:<会话>`、SDK 与平台合为一份实现。dsh 的 doc / deck 范围**没有**改（见 §6 第 5 项） | `aegis-app.test.ts` 新增 5 项：清单九个模块且列出的工具都存在；按模块地址只挂该模块、只读权限只挂只读工具、未授权 403、未知模块 404；非法模块权限拒绝签发；旧 `tool_scope` 换算；同一会话换地址换回合读到的数字可写进另一篇稿件、换会话被来源规则拒绝。SDK 测试改为平台清单经 SDK 校验、租约互通 | ✅ 2026-11-21 |
| 3 外部适配 | 工作区文件通道（MCP 三个工具 + HTTP 直传）；说明按模块拆、dsh 原文不变；每个模块的 SKILL.md | `mcp-instructions.test.ts`（dsh 说明指纹、外部只含所连模块、文件工具只在外部、SKILL.md）；`aegis-app.test.ts` 新增 5 项：本机图片 → 工作区 → 资产 → 插入稿件；取回文本、路径越界拒绝、只读不能放；HTTP 直传 6MB 与下载、401 / 403；自己放的文件读回不算出处；SKILL.md 与 initialize 的说明。本地真实服务验证 MCP 与 HTTP 进出、SKILL.md。原计划的「本机分析 → 登记 → 写入」改为「平台分析工具算 → 登记 → 写入」（§3.3） | ✅ 2026-11-21 |
| 4 外发策略 | 机构设置 `aegis_modules`（默认关、随 `external_model_for_patients`）；运行时取授权 ∩ 机构允许；四个模块的调用审计；机构设置与授权页界面。生产环境**未**打开 `HEURION_AEGIS`（2026-11-21 定：等阶段 5） | `aegis-app.test.ts` 新增 3 项：默认关时授权了也用不了、模块地址 403、文件直传 403、授权列表标出；机构打开 / 关掉立即生效，非法设置 400，不许交给外部模型时一律不开；调用审计（谁、哪个智能体、哪个患者、成败），管理员可查，默认开放模块不记 | ✅ 2026-11-21 |
| 6 通用接入 | 个人访问令牌 `hr_pat.*`（设置页签发 / 吊销）；通用地址 `/api/mcp[/<模块>]`、`/api/mcp/files/*`、模块目录 `/api/mcp/modules`；`X-Aegis-*` 请求头全部可选（智能体缺省 `mcp-client`，闲置 10 分钟算新回合）；对外说明、技能文档、批准提示改为中性（网页「待确认操作」批准） | `aegis-app.test.ts` 新增 3 项：只带 `Authorization` 的普通客户端接通用地址、吊销即失效；闲置换回合；模块目录与文件、开关关闭 404。本地用 MCP 官方 SDK 的标准客户端只带个人令牌连写作地址：29 个工具、能建稿件 | ✅ 2026-11-21 |
| 7 aegis-os v0.9 | `/.well-known/mcp-bundle.json`（aegis-mcp-bundle/v1）；设备码与令牌端点兼容 RFC 8628（表单、`scope` → 模块、完整 `verification_uri`、标准 `error`）；网关超时 120 → 300 秒 | `aegis-app.test.ts` 新增 2 项：清单字段与枚举、九个完整 URL、技能可拉取、反向代理 https、开关关闭 404；表单方式跑通设备码到 `tools/list`。未用 v0.9 二进制实测 | ✅ 2026-11-21 |
| 8 OAuth 2.1 | 按 MCP 鉴权规范：受保护资源元数据、授权服务器元数据、动态注册、授权码 + PKCE、资源指示符、刷新令牌轮换、撤销；应用内确认页；401 / 403 的 `WWW-Authenticate` 带建议 scope（§0.4）。顺带修正设备码确认链接（原来指向官网首页 `/`，改为 `/app?aegis_device=…` 并自动打开设置） | `aegis-app.test.ts` 新增 4 项：发现与元数据、跨域、开关关闭 404；完整流程与只能用批准的模块、授权码一次性、错误的 code_verifier；刷新轮换、1 小时过期、吊销后刷新失败、拒绝回 access_denied；不安全请求（回调地址、未注册客户端、不重定向、缺 PKCE、别处的 resource）。本地用 MCP 官方 SDK 的 OAuth 客户端流程（`authProvider`）对真实服务跑通：从 401 自动发现 → 注册 → 授权 → 换令牌 → 调工具；整站地址预选默认四个模块、文献地址只预选文献。确认页界面只过了类型检查 | ✅ 2026-11-21 |
| 9 停用 AAP | 停签 `aegis_at_*`，再关 AAP 地址与清单（§0.3） | — | 未开始 |
| 5 端到端 | agy 经 Aegis 跑通「写作 + 文献」，再扩到其他模块 | 单一地址下 agy 完成一轮修改与引用、无出处数字被拒、可撤销（§3.7）；按模块挂载、回合粒度等 Aegis 侧缺口修复后再验；带引用句里的编造数字已改为转待采纳修订（§6 第 6 项，`aegis-app.test.ts`、`provenance-guard.test.ts` 覆盖） | 部分完成 2026-11-21 |

## 6. 待决定

1. ~~模块划分~~：按 §3.2 的九个（2026-11-21 定）。
2. ~~部署形态~~：同一进程按模块出多个地址（2026-11-21 定）。
3. ~~患者类模块对外部智能体的开放策略~~：机构开关、默认关、调用审计（§3.5，2026-11-21 定）；生产环境已于 2026-11-21 打开。
4. 外部智能体能否用子专家委派（`delegate_task`）、其工具失败是否记进执行信号：阶段 1 暂不开放、不记录。开放 `delegate_task` 前，它的入组数据守卫要先接租约授权；执行信号若要记录，需带来源标记，避免第三方调用噪声混进 dsh 的演进。
5. dsh 的 doc / deck 范围（`mcp/scope.ts`）按模块计算：未做。现行范围不是模块的并集（稿件范围里有 `doc_manage`、`dataset_manage` 等管理工具），改成按模块会改变 dsh 在稿件回合里能用的工具，需要单独评估；外部接入不受影响。
6. ~~外部智能体在「只存了摘要的文献」所在句子里写数字~~：不拒绝（全文可能在付费墙后），整批转为待采纳修订，由人对照全文确认后采纳；dsh 与外部智能体同一规则（`ops/service.ts` 的 `guardProvenance`，PROVENANCE.md 2.2；2026-11-21 定）。

## 7. 变更记录

- 2026-11-21：OAuth 2.1（阶段 8，§0.4）：支持 MCP 鉴权规范的客户端只填地址即可浏览器登录、按模块授权；设备码确认链接改到 `/app`。
- 2026-11-21：文档定位改为「MCP 模块化与外部接入」，新增 §0 接入指南。通用接入：个人访问令牌 `hr_pat.*`、`/api/mcp[/<模块>]`、模块目录、请求头可选、闲置换回合（阶段 6）。对齐 aegis-os v0.9：`mcp-bundle.json`、RFC 8628 表单与标准错误码、网关超时 300 秒（阶段 7）。AAP-1.0 标为兼容层、计划停用。
- 2026-11-21：生产环境打开 `HEURION_AEGIS`（`deploy/docker-compose.yml`）：设置页「智能体授权」与机构设置里的模块开关对用户可见；患者、影像、研究、分析仍默认关。大文件直传上限降到 100MB，与 Caddy 的请求体限制一致。
- 2026-11-21：来源规则二收紧：文献只有摘要、数字在摘要里找不到时，整批转为待采纳修订（原为写入并提示核对；dsh 与外部智能体同一规则）。
- 2026-11-21：阶段 5（部分）：agy 经 Aegis-OS 单一地址端到端跑通写作 + 文献；记录 Aegis 侧 5 处缺口与规则二的摘要缺口（§3.7、§6 第 6 项）。
- 2026-11-21：阶段 4 完成：患者、影像、研究、分析四个模块对外部智能体默认关，机构逐个打开、立即生效，调用记审计；生产环境仍不打开（§6 第 3 项已定）。
- 2026-11-21：阶段 3 完成：外部智能体的工作区文件通道、工具说明按模块拆（dsh 不变）、每个模块的 SKILL.md；本机分析的数字不能登记写入，自己放进工作区的文件读回不算出处。
- 2026-11-21：阶段 2 完成：按模块的地址与清单、授权改为模块权限、设置页按模块授权、跨模块观察记录（顺带修复外部智能体写数字一律被来源规则拒绝）、SDK 与平台合为一份实现；dsh 范围暂不改（§6 第 5 项）。
- 2026-11-21：阶段 1 完成：外部智能体网关合为一个处理函数，与 dsh 共用依赖；`/api/mcp` 别名移除；外部网关不挂 `delegate_task`、不记执行信号（§6 第 4 项）。
- 2026-11-21：阶段 0 完成：模块注册表与按模块构建；模块划分定为九个、同一进程按模块出多个地址（§6 第 1、2 项已定）。
- 2026-11-21：新建，合并并取代 AEGIS_APP_PROTOCOL.md 与 aegis-app-sdk 包的 README；现状按代码重新核对。
