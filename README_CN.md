<div align="center">

# Heurion 2.0 & OmniCanvas (中文版)

### 下一代 AI 原生协同创作与医学智能工作台
Next-Gen AI-Native Collaborative Workspace & Medical Intelligence Platform

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A524.0.0-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9+-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://pnpm.io/"><img src="https://img.shields.io/badge/pnpm-workspace-F69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm workspace" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/Protocol-MCP%20Compliant-0052CC?style=flat-square&logo=anthropic&logoColor=white" alt="MCP Compliant" /></a>
  <a href="https://github.com/yjs/yjs"><img src="https://img.shields.io/badge/CRDT-Yjs%20%7C%20ProseMirror-FF6F00?style=flat-square" alt="CRDT Powered" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/Agent-DeepSeek%20Harness-4D6BFE?style=flat-square" alt="DeepSeek Harness" /></a>
  <a href="https://github.com/yisibl/resvg-js"><img src="https://img.shields.io/badge/Rasterizer-resvg--js%20(Pure%20Rust)-FF4081?style=flat-square" alt="resvg-js" /></a>
  <a href="https://vitest.dev/"><img src="https://img.shields.io/badge/Tests-361%20Passed%20(100%25)-brightgreen?style=flat-square&logo=vitest&logoColor=white" alt="Test Coverage" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <a href="./README.md"><b>English</b></a> • <b>简体中文</b>
</p>

[核心特性](#核心特性-features) • [双服务架构](#双服务架构解耦-architecture) • [快速开始](#快速开始-quick-start) • [MCP 工具矩阵](#mcp-工具矩阵-model-context-protocol) • [测试与质量](#测试与质量保证-testing--quality) • [架构文档](#架构与深度文档-documentation)

---
</div>

## <img src="docs/icons/overview.svg" width="18" height="18" valign="middle" /> 平台概述 (Overview)

**Heurion 2.0** 是一套专为临床医学与生命科学科研全生命周期打造的**端到端全流程智能工作台与协同画布**（Clinical Research AI Workstation）。

与传统的单点大模型写作工具不同，Heurion 深度贯通临床科研的全链路：
- **患者数据收集与资产化**：门诊与住院病历数字化录入、化验单多模态 OCR 结构化提取、知家患者数字健康档案（PHR）协同沉淀，多租户授权 Claims 机制保障数据合规。
- **科研项目与队列管理**：多课题集中立项与多租户权限隔离，多维复杂条件交并筛选（入排标准、诊断编码、检验值区间），秒级锁定目标人群画像。
- **数据治理与自主记忆演进**：临床科研数据集（CSV/Excel/SAS/SPSS/Stata）标准化清洗与治理，独创课题记忆演进引擎，自动吸收研究假设与统计口径，越用越懂你的科研意图。
- **严谨统计、论文撰写与学术汇报**：隔离沙箱环境秒级运行 Python/R 脚本自动输出 Table 1 与生存曲线，Docs & Slides 双模协同，写前守卫保护人类编辑优先权，PubMed/EuropePMC/OpenAlex 交叉验真。

平台采用**结构化稳定 ID 文档模型**，将粒度精确到段落与区块。所有 AI 智能体（如 DeepSeek、Claude、GPT 等）的操作均通过标准 **Model Context Protocol (MCP)** 执行，并在操作层经过严格的**写前守卫（Write Guards）**保护，确保人类优先权、学术引用有效性、以及评论锚点的持久不失效。

项目提供**双引擎解耦架构**：
1. **Heurion Medical Platform (`@heurion2/platform`)**：全功能医学智能工作台，包含患者数据采集、队列筛选、沙箱统计、多源文献检索（PubMed、Europe PMC、OpenAlex）、PHR 患者数字档案、PHI 敏感信息泄露拦截与多租户权限控制。
2. **OmniCanvas 微服务 (`@heurion2/canvas-service`)**：完全解耦的独立在线协同工作台，集成现代化长文排版与幻灯片设计器，内置 30 项纯净版 Canvas MCP 通用排版与幻灯片生成工具，零领域耦合。

---

## <img src="docs/icons/features.svg" width="18" height="18" valign="middle" /> 核心特性 (Features)

### <img src="docs/icons/studio.svg" width="16" height="16" valign="middle" /> 1. 文档与演示文稿一体化双模工作台
- **Docs & Slides 双形态无缝切换**：支持文档长文排版模式与 16:9 交互式演示文稿（Slide Deck）模式。
- **现代化设计器**：内置大纲导航、实时缩略图胶卷、卡片化版式设计、模板库快速注入与颜色/主题系统。
- **即时图文混排与安全预览**：重构剪贴板原生多模态支持，支持操作系统截图粘贴即时高保真预览，并在落盘前实施严格的二进制校验。

### <img src="docs/icons/shield.svg" width="16" height="16" valign="middle" /> 2. 结构化文档模型与写前守卫 (Write Guards)
- **稳定块标识符（Stable Block IDs）**：文档和幻灯片具备全局唯一稳定的 Block ID，智能体可精准定位插入、追加、替换或修饰，杜绝“全篇覆写”导致的内容丢失与冲突。
- **用户优先级原则（User Primacy）**：人类用户的并发编辑具有最高裁判权。
- **评论锚点保护（Anchor Preservation）**：AI 编辑前后自动重算并保护人类留下的行内批注与评论锚点。
- **原子事务与操作回滚**：所有对 CRDT 的更改均经过校验、预演与原子提交。

### <img src="docs/icons/zap.svg" width="16" height="16" valign="middle" /> 3. 自闭环矢量光栅化引擎 (Self-Contained Rasterizer)
- **告别重量级外部依赖**：服务端内置基于 Rust/WASM 的 `@resvg/resvg-js` 高性能渲染引擎。
- **无依赖高清渲染**：无需在部署环境安装庞大的 LibreOffice（`soffice`）或无头浏览器，即可纯在 Node.js 进程内秒级将 SVG/HTML 矢量幻灯片光栅化为 4K 高保真 PNG 预览图。
- **并发防击穿与双级缓存**：具备内存 LRU 与磁盘持久化双层缓存，带高并发防请求击穿互斥锁。

### <img src="docs/icons/globe.svg" width="16" height="16" valign="middle" /> 4. 实时多端协同 (Yjs CRDT)
- **分布式无锁协同**：基于 Yjs CRDT（Conflict-free Replicated Data Type）与 WebSocket 协议，实现真人之间、人机之间的毫秒级协同操作。
- **状态同步与持久化**：支持协同文档的快照落盘与离线重连增量同步。

### <img src="docs/icons/stethoscope.svg" width="16" height="16" valign="middle" /> 5. 严肃学术与医学证据链 (Medical Grounding)
- **多源权威文献检索**：深度聚合 PubMed、Europe PMC 以及 OpenAlex 学术文献库。
- **严格引用规范校验**：内置引用解析引擎，智能体引用的文献必须经过校验，生成标准学术引注锚点与文末参考书目。
- **PHR 患者健康档案与高级队列**：支持多租户隔离的患者健康档案（PHR）、资产管理、高级组合队列检索。
- **PHI 隐私泄漏安全扫描**：内置 `phi-scan` 模块，自动拦截与告警未经脱敏的患者敏感个人健康信息。

### <img src="docs/icons/chart.svg" width="16" height="16" valign="middle" /> 6. 临床科研课题组协作与学术发表级证据链 (Clinical Evidence Suite)
- **去标识化受试者管理（S001...）**：多维条件筛选真实患者入组，自动解耦临床代号与学术编号，支持一键生成队列宽表/长表数据集。
- **发表级 Table 1 原生 Word 三线表**：自动化生成符合顶刊要求的顶底 1.5pt、栏目 0.5pt、Times New Roman / 宋体排版与统计学检验脚注的 `.docx` 文件。
- **CONSORT 2010 / STROBE 入组流向图**：矢量 SVG 与 Mermaid 动态渲染入组纳排流程。
- **因果推断与混杂偏倚控制**：Love Plot 绝对 SMD 均衡点图与 VanderWeele E-value 未测混杂敏感度中英双语学术抗辩陈述。

### <img src="docs/icons/bot.svg" width="16" height="16" valign="middle" /> 7. 标准化 Model Context Protocol (MCP)
- 原生支持标准 MCP 协议，通过 SSE / Stdio 暴露结构化工具集。
- 深度兼容 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）、Claude Desktop、Cursor 等任意兼容 MCP 的 Agent 运行时。

---

## <img src="docs/icons/layers.svg" width="18" height="18" valign="middle" /> 双服务架构解耦 (Architecture)

Heurion 2.0 采用现代化 pnpm Monorepo 组织代码，清晰划分医学业务工作台与通用协同微服务：

```
heurion2/
├── apps/
│   ├── platform/              # [Platform] Heurion 2.0 核心医学智能工作台 (Port: 8787)
│   │   ├── src/
│   │   │   ├── model/         # 结构化文档/幻灯片模型、Block ID、方言与评论锚点
│   │   │   ├── ops/           # 校验 → 写前守卫 → 原子应用操作层
│   │   │   ├── mcp/           # MCP 服务端（面向 DeepSeek Harness / Claude）
│   │   │   ├── render/        # resvg-js 矢量光栅化与幻灯片渲染引擎
│   │   │   ├── literature/    # PubMed / Europe PMC / OpenAlex 检索与引文格式化
│   │   │   ├── tenancy/       # 患者档案、PHR 共享凭证与访问控制 (Claims)
│   │   │   ├── ops/phi-scan.ts# PHI 敏感信息脱敏与安全扫描器
│   │   │   ├── harness/       # DeepSeek Harness 沙箱进程池调度
│   │   │   └── collab/        # Yjs WebSocket 协同网关
│   │   └── web/               # 平台端 ProseMirror 协同编辑界面
│   │
│   ├── canvas-service/        # [Canvas] OmniCanvas 独立画布与文档微服务 (Port: 8888)
│   │   ├── src/
│   │   │   ├── index.ts       # 独立微服务入口 (REST + WebSocket + MCP)
│   │   │   ├── app.ts         # 纯净版 Canvas MCP Server（30 个排版/创作工具）
│   │   │   └── collab.ts      # 独立 Yjs CRDT 协同房间管理
│   │   └── web/               # 文档与演示文稿独立前端工作台
│   │       ├── src/editor.ts  # 文档编辑器核心
│   │       ├── src/deck.ts    # 幻灯片设计器核心
│   │       └── src/main.ts    # 现代工作台交互与命令体系
│   │
│   └── embedder/              # [Search] 本地向量与语义嵌入支持服务
│
├── docs/                      # 架构规范、迁移计划与设计说明
└── scripts/                   # 自动化运维、容器构建与评测脚本
```

---

## <img src="docs/icons/terminal.svg" width="18" height="18" valign="middle" /> 快速开始 (Quick Start)

### 1. 环境准备
- **Node.js**: $\ge 24.0.0$
- **包管理器**: `pnpm` ($\ge 9.0.0$)
- *(可选)* **Docker**: 用于容器化隔离沙箱部署

### 2. 依赖安装与配置
克隆代码库并配置环境变量：

```bash
git clone https://github.com/heurion-org/heurion.git
cd heurion2

# 复制配置文件
cp .env.example .env

# 安装所有子包依赖（自动完成原生构建）
pnpm install
```

根据需要在 `.env` 中填写配置项：
```ini
# DeepSeek 官方 API Key（用于 dsh 智能体）
DEEPSEEK_API_KEY=your_deepseek_api_key_here

# 服务端口与数据目录
PORT=8787
HEURION_DATA_DIR=./data
HEURION_SECRET=your_production_secret_32_bytes_string
HEURION_DEV_TOKEN=dev

# 可选：文献检索提速密钥
NCBI_API_KEY=
CONTACT_EMAIL=
```

### 3. 编译与启动服务

#### 运行全功能医学智能工作台 (Heurion Platform)
```bash
# 1. 编译 Web 前端资源
pnpm --filter @heurion2/platform build

# 2. 启动服务 (默认端口 8787: 承载 Web UI + REST API + Yjs /collab + /mcp)
pnpm --filter @heurion2/platform dev
```
启动后在浏览器打开：`http://127.0.0.1:8787`

> **前端热重载开发**：使用 `pnpm --filter @heurion2/platform dev:web` 可在 `http://127.0.0.1:5173` 启动带 HMR 的 Vite 开发服务器，自动反向代理 API 至 8787。

#### 运行独立画布微服务 (OmniCanvas Standalone)
```bash
# 1. 编译独立画布前端资源
pnpm --filter @heurion2/canvas-service build

# 2. 启动独立服务 (默认端口 8888)
PORT=8888 pnpm --filter @heurion2/canvas-service dev
```
启动后在浏览器打开：`http://127.0.0.1:8888`

---

## <img src="docs/icons/tools.svg" width="18" height="18" valign="middle" /> MCP 工具矩阵 (Model Context Protocol)

Heurion 为大模型提供了标准化、受安全约束的操作工具箱：

### <img src="docs/icons/file-text.svg" width="16" height="16" valign="middle" /> OmniCanvas 通用创作工具集 (`@heurion2/canvas-service`)
| 分类 | 工具名称 | 功能描述 |
| :--- | :--- | :--- |
| **画布管理** | `canvas_create`, `canvas_get`, `canvas_list` | 创建、查询与列出文档/幻灯片画布实体 |
| **区块编辑** | `canvas_block_insert`, `canvas_block_replace` | 精准按 Block ID 插入、替换或更新结构化内容 |
| **区块操作** | `canvas_block_move`, `canvas_block_delete` | 调整内容块层级结构或安全移除内容块 |
| **幻灯片制作**| `canvas_slide_add`, `canvas_slide_update` | 新增单页幻灯片、设置布局模版与标题排版 |
| **视觉呈现** | `canvas_slide_render`, `canvas_slide_delete`| 实时调用内置 resvg 引擎光栅化为 4K 高清预览 |
| **表格与图表**| `canvas_table_insert`, `canvas_chart_insert` | 插入高表现力数据表格、柱状图/折线图等结构化视图 |

### <img src="docs/icons/dna.svg" width="16" height="16" valign="middle" /> 医学科研专用扩展工具集 (`@heurion2/platform`)
| 分类 | 工具名称 | 功能描述 |
| :--- | :--- | :--- |
| **文献检索** | `literature_search_pubmed` | 检索 NCBI PubMed 权威医学文献，提取结构化摘要与 PMID |
| **欧洲检索** | `literature_search_europepmc` | 检索 Europe PMC 开放获取文献及全文信息 |
| **学术索引** | `literature_search_openalex` | 基于 OpenAlex 检索高引论文、学术作者及文献溯源信息 |
| **引文校验** | `format_citations` | 按照规范生成带溯源链接的学术标准引用格式 |
| **健康档案** | `patient_get`, `patient_cohort_query` | 安全读取患者基本特征、进行多维度临床队列检索 |
| **合规与脱敏**| `phi_scan_text` | 执行 HIPAA / PHI 敏感健康信息泄露扫描 |

---

## <img src="docs/icons/flask.svg" width="18" height="18" valign="middle" /> 测试与质量保证 (Testing & Quality)

本项目坚持高覆盖率与自动化测试驱动，全代码库测试通过率保持在 **100%**：

```bash
# 1. 静态类型检查（覆盖全部子包与前端工程）
pnpm typecheck

# 2. 运行自动化单元测试与集成测试（47 套件，361 测试全部 PASS）
pnpm test

# 3. 运行端到端真实智能体评测（需配置 DEEPSEEK_API_KEY）
pnpm --filter @heurion2/platform e2e

# 4. 运行浏览器 UI 自动化交互测试
pnpm --filter @heurion2/platform ui
```

---

## <img src="docs/icons/book.svg" width="18" height="18" valign="middle" /> 架构与深度文档 (Documentation)

- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**文档总览索引 (docs/README.md)**](docs/README.md)：全量架构规范与临床科研领域设计导航
- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**平台整体技术架构 (PLATFORM.md)**](docs/PLATFORM.md)：系统模型层、操作层写前守卫、DSH 调度设计
- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**多环境部署指南 (DEPLOY.md)**](docs/DEPLOY.md)：生产环境、容器化编排、反向代理与 TLS 配置
- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**自演进记忆治理与证据分级 PRD (MEMORY_GOVERNANCE_PRD.md)**](docs/design/MEMORY_GOVERNANCE_PRD.md)：三层记忆架构、CoEM/SafeVantage 门控与引文证据覆盖度核验
- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**临床队列设计 (COHORT.md)**](docs/design/COHORT.md)：医学队列检索与多条件交并过滤
- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**患者数据与共享凭证 (PATIENT.md & SHARING.md)**](docs/design/PATIENT.md)：患者档案授权 Claims 机制

---

## <img src="docs/icons/scale.svg" width="18" height="18" valign="middle" /> 贡献与开源许可 (License)

欢迎提交 Issue 和 Pull Request 来完善 Heurion 2.0！

本项目基于 [MIT License](./LICENSE) 协议开源。
