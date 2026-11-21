# Heurion 2.0

临床科研智能工作台：医生在同一处管理患者资料与临床研究、分析数据、写论文和做幻灯片，AI 与人在同一份结构化文档上协作。线上地址：<https://heurion.org>。

## 核心设计

- **结构化文档模型**：文档与幻灯片是带稳定块 id 的 ProseMirror + Yjs 模型；Word / PowerPoint 文件只是导入 / 导出视图，导出时未改动的部分逐字节写回原文件。
- **AI 只能经操作层写入**：AI 的每次修改都是结构化操作，先过写前守卫（用户优先、来源规则、引用规范、评论锚点）再原子应用；没有「用文件整体替换文档」的入口。
- **MCP 工具面**：平台把文档、文献、数据分析、患者、影像、研究等能力以 MCP 工具暴露，平台内的 AI 回合（dsh）经它工作；外部 MCP 客户端与智能体的接入（个人访问令牌、按模块地址）见 [`docs/design/MCP_MODULES.md`](docs/design/MCP_MODULES.md) §0。
- **多租户与隐私**：机构与个人空间隔离、每机构独立加密的患者库、患者只用代号，AI 的权限等于所代表用户的权限。

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
