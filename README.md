# Heurion 2.0

临床科研智能工作台：医生在同一处管理患者资料与临床研究、分析数据、写论文和做幻灯片，AI 与人在同一份结构化文档上协作。线上地址：<https://heurion.org>。

## 核心设计

- **结构化文档模型**：文档与幻灯片是带稳定块 id 的 ProseMirror + Yjs 模型；Word / PowerPoint 文件只是导入 / 导出视图，导出时未改动的部分逐字节写回原文件。
- **AI 只能经操作层写入**：AI 的每次修改都是结构化操作，先过写前守卫（用户优先、来源规则、引用规范、评论锚点）再原子应用；没有「用文件整体替换文档」的入口。
- **MCP 工具面**：平台把文档、文献、数据分析、患者、影像、研究等能力以 MCP 工具暴露，平台内的 AI 回合（dsh）经它工作；外部 MCP 客户端接入见下方「接入 Heurion MCP」与 [`docs/design/MCP_MODULES.md`](docs/design/MCP_MODULES.md) §0。
- **多租户与隐私**：机构与个人空间隔离、每机构独立加密的患者库、患者只用代号，AI 的权限等于所代表用户的权限。

## 接入 Heurion MCP

Heurion 对外提供标准的 **Streamable HTTP** MCP 服务，支持 **OAuth 2.1（推荐）** 与 **个人访问令牌（PAT）** 两种鉴权方式，可直接接入 Antigravity、Claude Code、Cursor、腾讯 WorkBuddy 等客户端。

| 服务（Official MCP Registry） | 端点 URL | 鉴权方式 | 适用场景 |
|---|---|---|---|
| 科学写作与幻灯片（`org.heurion/writing`） | `https://heurion.org/api/mcp/writing-studio` | OAuth 2.1 / PAT | 论文写作、PubMed 检索与引文守卫、`.docx`/`.pptx` 编辑与批注 |
| 临床深度审稿（`org.heurion/deep-review`） | `https://heurion.org/api/mcp/deep-review` | OAuth 2.1 / PAT | 4 阶段临床审稿、表文一致性审计、PubMed 论断核查与反驳进化 |
| 公开临床工具（`org.heurion/clinical-research-tools`） | `https://heurion.org/api/public/mcp` | 免鉴权（Zero-auth） | E-value、CONSORT、Table 1、KM/森林图、PHI 扫描与 PubMed 校验 |
| 全平台多租户 Hub（`org.heurion/heurion`） | `https://heurion.org/api/mcp/hub` | OAuth 2.1 / PAT | 队列、EHR、MONAI 3D 影像与全模块工具渐进式检索 |

> 也可按单个模块接入 `https://heurion.org/api/mcp/<模块>`（`writing`、`literature`、`analysis`、`patients`、`imaging`、`research`、`knowledge`、`memory`、`admin`），详见 [`docs/design/MCP_MODULES.md`](docs/design/MCP_MODULES.md)。

### 方式一：OAuth 2.1 自动授权（推荐）

无需手动生成或复制密钥。在客户端配置端点 URL 后，首次连接会自动经 RFC 9728 / RFC 8414 元数据发现并打开浏览器跳转至 `https://heurion.org` 授权页；登录并勾选允许开放的模块后，客户端会自动完成 PKCE 换取令牌与无感续期（Access Token 1 小时、Refresh Token 30 天轮换，可随时在 Heurion「设置 → MCP 访问令牌」中吊销）。

**通用 JSON 配置示例**（如 Antigravity `~/.gemini/config/mcp_config.json`、Cursor、WorkBuddy 等）：

```json
{
  "mcpServers": {
    "heurion-writing": {
      "url": "https://heurion.org/api/mcp/writing-studio"
    },
    "heurion-deep-review": {
      "url": "https://heurion.org/api/mcp/deep-review"
    },
    "heurion-public-tools": {
      "url": "https://heurion.org/api/public/mcp"
    }
  }
}
```

> 腾讯 **WorkBuddy** 可在 `.mcp.json` 中为每项补充 `"type": "http"`，或直接在「连接器 → 自定义连接器」/ 企业后台「连接器管理」中选择 `MCP OAuth 2.1` + `http` 填入上述 URL。

**Claude Code CLI 示例**：

```bash
claude mcp add --transport http heurion-writing https://heurion.org/api/mcp/writing-studio
claude mcp add --transport http heurion-deep-review https://heurion.org/api/mcp/deep-review
claude mcp add --transport http heurion-public-tools https://heurion.org/api/public/mcp
```

### 方式二：个人访问令牌（PAT，适用于不支持 OAuth 或内网受限客户端）

1. 登录 <https://heurion.org> → **设置 → MCP 访问令牌** → 逐个模块选择「不开放 / 只读 / 读写」权限并签发令牌，得到 `hr_pat.<id>.<secret>`（仅显示一次，默认 90 天，可随时吊销）。
2. 在客户端配置中通过 `Authorization` 请求头携带令牌：

```json
{
  "mcpServers": {
    "heurion-writing": {
      "url": "https://heurion.org/api/mcp/writing-studio",
      "headers": {
        "Authorization": "Bearer hr_pat.<id>.<secret>"
      }
    }
  }
}
```

Claude Code CLI 对应命令：

```bash
claude mcp add --transport http heurion-writing https://heurion.org/api/mcp/writing-studio \
  --header "Authorization: Bearer hr_pat.<id>.<secret>"
```

### 方式三：经 Aegis OS 声明式清单一键接入（可选）

如使用 `aegis-os`，可直接从 `https://heurion.org/.well-known/mcp-bundle.json` 安装声明式 Bundle 并登录：

```bash
aegis-os mcp bundle install heurion
aegis-os mcp login heurion
```

## 仓库结构

```
apps/
  platform/        主平台（Node + Hono）：文档 / 幻灯片内核、操作层与守卫、MCP、患者与研究、影像、记忆；web/ 为前端
  canvas-service/  只含文档与画布工具的独立服务（MCP 服务名 omnicanvas）
  doc-parser/      本地 PDF 结构化解析（Docling）
  embedder/        本地向量化（bge-m3），资料库与记忆检索用
  imaging-worker/  医学影像推理（MONAI）
  site/            官网静态页
packages/
  canvas-ui/       文档编辑器与幻灯片画布前端组件
  aegis-app-sdk/   Aegis 应用协议工具函数（现状见 MCP_MODULES.md）
deploy/            生产部署（Docker Compose、Caddy、备份）
docs/              架构与设计文档
```

## 本地开发

需要 Node.js ≥ 24 与 pnpm。

```bash
pnpm install
cp .env.example .env                              # 填 DEEPSEEK_API_KEY 等
pnpm --filter @heurion2/platform build            # 构建前端
pnpm --filter @heurion2/platform dev              # http://127.0.0.1:8787
pnpm --filter @heurion2/platform dev:web          # 可选：前端热更新
```

幻灯片的精确预览与 emf 图片显示需要本机装 LibreOffice（`soffice`）与 poppler（`pdftoppm`），没有时退回内置渲染。

## 测试

```bash
pnpm typecheck                                    # 全部包的类型检查
pnpm test                                         # 单元与集成测试
pnpm --filter @heurion2/platform ui               # 浏览器测试（需先启动服务并构建前端）
pnpm --filter @heurion2/platform e2e              # 真实 AI 回合（需要 DEEPSEEK_API_KEY）
```

## 文档

- [文档导航](docs/README.md)
- [平台架构](docs/PLATFORM.md)
- [部署](docs/DEPLOY.md)
- [MCP 模块化与外部接入](docs/design/MCP_MODULES.md)

## 许可

[MIT](LICENSE)
