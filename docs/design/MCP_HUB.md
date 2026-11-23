# Heurion MCP Hub（公开免鉴权工具、渐进式发现与原生 OAuth 2.1）

本文档说明 Heurion 2.0 在既有[九模块外部 MCP 与 AAP 架构](MCP_MODULES.md)之上新增的 **Phase 0 + Phase 1C** 能力，以及 Official MCP Registry 清单发布方式。

## 1. 总览：一条统一架构，三种接入形态

| 形态 | 端点 | 鉴权与策略 | 适用场景 | 清单条目 |
|---|---|---|---|---|
| **公开科研工具箱（Phase 0）** | `POST /api/public/mcp` | 零鉴权、无数据库状态；IP 限流（整站 30/min，PubMed 核验 15/min + 24h 内存缓存） | Official MCP Registry 免登录试用、文献核验、E-value、CONSORT、Table 1、KM、森林图、PHI 扫描 | `org.heurion/clinical-research-tools` |
| **渐进式发现 Hub（Phase 1C）** | `POST /api/mcp/hub`（兼容 `/api/aegis/mcp/hub`） | OAuth 2.1（PKCE S256 / CIMD / DCR / 设备码）与 `hr_pat.*`；九模块权限 ∩ 机构外发策略（`aegis_modules`）∩ RBAC | 上下文敏感的多模块通用客户端（Claude Desktop、Cursor、OpenCode 等） | `org.heurion/heurion` |
| **经典全量 / 分模块网关** | `POST /api/mcp` 与 `/api/mcp/:module` | 同上（另含 Aegis-OS v0.9 声明式清单元数据 `/.well-known/mcp-bundle.json`） | `aegis-os v0.9+` 单点审批编排与按模块隔离挂载 | `/.well-known/mcp-bundle.json` |

## 2. 渐进式发现机制（`/api/mcp/hub`）

- **`tools/list` 精简载荷**：默认仅暴露 3 个发现/调度元工具 + 最多 12 个已授权 **Eager Core** 工具（`doc_list`、`doc_outline`、`doc_read`、`doc_search`、`doc_edit`、`doc_revert_turn`、`comments_list`、`comment_reply`、`pubmed_search`、`insert_citation`、`asset_upload`、`action_status`），大幅降低初始提示词 schema 占用。
- **混合检索目录（`apps/platform/src/mcp-hub/catalog.ts`）**：启动后将全量内置外部工具与共享工作区工具（`workspace_put` / `workspace_get` / `workspace_list`）同步至 SQLite `mcp_tool_catalog` 与 `mcp_tool_fts`（trigram 分词），结合词法精确/前缀匹配、FTS5 trigram 与可选本地 `bge-m3` 向量（RRF 融合）。
- **前置强制隔离**：`hub_search_tools` 与 `hub_describe_tool` 在排序截断前即剔除机构未开启外发（`aegis_modules`）的模块及账户无权访问的管理工具；`hub_call_tool` 在执行前通过 Zod 校验并按模块权限执行 `403 WWW-Authenticate: Bearer error="insufficient_scope"` 或 `module_not_allowed_by_org`。

## 3. 原生 OAuth 2.1 CIMD 与 SEP-1036 URL Mode Elicitation

- **CIMD（`apps/platform/src/aegis/oauth.ts`）**：`/.well-known/oauth-authorization-server` 声明 `client_id_metadata_document_supported: true`；当 `client_id` 为 `https://...` URL 时，先校验协议、拒绝 `localhost` / `.local` / `.internal` 及私网/回环 IP 与 DNS 重绑定解析结果（fail-closed），抓取并验证客户端元数据后缓存至 `oauth_clients.expires_at`（1 小时 TTL）。
- **SEP-1036 URL Mode Elicitation（`apps/platform/src/mcp/admin-tools.ts`）**：高风险需确认操作生成 `pending_actions` 记录与 `${publicOrigin}/app?action=<action_id>` 后：
  - 若经 `aegis-os` 且已签发有效租约（Header Ed25519 或服务端 `agent_leases`），直接放行执行（`lease_authorized: true`）；
  - 若客户端在 MCP 握手阶段声明 `capabilities.elicitation.url`，服务器通过 `server.server.elicitInput({ mode: 'url', ... })` 诱导带外确认并读取执行结果；
  - 若运行在无状态 Streamable HTTP 单次请求下，优雅降级返回 `approval_required` / `pending_confirmation` 并附带 `approve_url`，点击链接登录后自动打开 `/app` 待确认面板。

## 4. Official MCP Registry 清单

- `deploy/mcp-registry/writing.server.json` -> `org.heurion/writing`（`https://heurion.org/api/mcp/writing-studio`）—— 主打科学写作与幻灯片垂直工作台（含 `.docx` 导入导出与 `literature` 引用闭环）
- `deploy/mcp-registry/deep-review.server.json` -> `org.heurion/deep-review`（`https://heurion.org/api/mcp/deep-review`）—— 主打四阶段临床深度审稿（含零模型消耗 AST 试用 `https://heurion.org/api/public/deep-review/mcp`）
- `deploy/mcp-registry/clinical-research-tools.server.json` -> `org.heurion/clinical-research-tools`（`https://heurion.org/api/public/mcp`）
- `deploy/mcp-registry/heurion.server.json` -> `org.heurion/heurion`（`https://heurion.org/api/mcp/hub`）—— 定位为企业全功能 Hub

## 5. Writing 与 Deep Review 垂直端点架构

- **`POST /api/mcp/writing-studio`**（`apps/platform/src/mcp-hub/verticals.ts`）：打包 `writing` + `literature` 模块全部能力及 `doc_import_docx` / `doc_export_docx`，排除重型审稿编排工具，使外部 Agent 在单连接内完成「文献检索 → 引用登记 → 写前守卫 → 协同修改 → Word 交付」。
- **`POST /api/mcp/deep-review`**（`apps/platform/src/mcp-hub/verticals.ts`）：暴露 22 个聚焦审稿的工具（`deep_review_audit_markdown`、`deep_review_audit`、`deep_review_start`、`deep_review_status`、`verify_claims`、`claim_report`、文献检索、`doc_import_docx`、只读阅稿与批注反驳进化），默认仅申请 `writing:rw literature:rw` 作用域。
- **`POST /api/public/deep-review/mcp`**（`apps/platform/src/mcp-hub/public-mcp.ts`）：零鉴权、零服务端大模型消耗的确定性 AST 表文自洽 + PubMed 文献核验试用入口（20–30 次/分钟 IP 限流）。

发布流程（部署上线并验证冒烟通过后执行）：

```bash
mcp-publisher login dns --domain heurion.org --private-key <HEX_ED25519_PRIVATE_KEY>
mcp-publisher publish deploy/mcp-registry/writing.server.json
mcp-publisher publish deploy/mcp-registry/deep-review.server.json
```
