<div align="center">

# Heurion 2.0 & OmniCanvas

### End-to-End Clinical Research AI Workstation & Collaborative Canvas
端到端临床科研全流程智能工作台与协同创作画布

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
  <a href="#english"><b>English</b></a> • <a href="#heurion-20--omnicanvas-中文版"><b>简体中文</b></a> • <a href="./README_CN.md"><b>独立中文文档</b></a>
</p>

[Features](#key-features) • [Architecture](#dual-engine-architecture) • [Quick Start](#quick-start) • [MCP Tools](#mcp-tools-matrix) • [Testing](#testing--quality-assurance) • [Docs](#architecture--documentation)

---
</div>

<a name="english"></a>

## <img src="docs/icons/overview.svg" width="18" height="18" valign="middle" /> Overview

**Heurion 2.0** is an **end-to-end clinical research AI workstation and collaborative canvas** engineered for the full lifecycle of medical discovery:
- **Patient Data Collection**: Digitizing outpatient/inpatient records, multimodal lab report OCR, and personal health records (PHR) with clinical claim authorization.
- **Research Project & Cohort Management**: Managing clinical studies, protocol milestones, and complex multi-parameter patient cohort filtering (inclusion/exclusion criteria).
- **Data Governance & Autonomous Memory Evolution**: Clean clinical datasets (CSV, Excel, SAS, SPSS, Stata) and a self-evolving memory engine that distills research hypotheses, statistical definitions, and team consensus over time.
- **Statistical Analysis & Paper Writing**: Sandboxed statistical computing (Table 1, Kaplan-Meier curves), structured collaborative paper drafting (Docs & Slides dual-mode), rigorous literature verification (PubMed, Europe PMC, OpenAlex), and verifiable citations.

Unlike conventional LLM interfaces that treat documents as flat Markdown strings and overwrite entire texts, Heurion maintains a **structured document model with globally stable Block IDs**. All AI agent edits (such as DeepSeek, Claude, or GPT) interact via the standardized **Model Context Protocol (MCP)** and pass through strict operational **Write Guards** (ensuring user primacy, citation integrity, and human comment anchor preservation).

The project features a **decoupled dual-engine architecture**:
1. **Heurion Medical Platform (`@heurion2/platform`)**: Full-featured clinical research intelligence workstation with PHR ingestion, cohort query builder, sandboxed analytics, literature grounding, and PHI privacy scanning.
2. **OmniCanvas Microservice (`@heurion2/canvas-service`)**: Decoupled, standalone collaborative workspace providing rich-text document editing and interactive slide presentation design, equipped with 30 pure Canvas MCP tools for document layout and slide deck generation, with zero domain coupling.

---

## <img src="docs/icons/features.svg" width="18" height="18" valign="middle" /> Key Features

### <img src="docs/icons/studio.svg" width="16" height="16" valign="middle" /> 1. Modern Document & Presentation Studio (Dual-Mode)
- **Fluid Docs & Slides Dual-Mode**: Seamlessly switch between long-form structured document authoring and 16:9 interactive presentation slide decks.
- **Modern Designer Panel**: Built-in document outline navigation, real-time slide filmstrip, card-based layouts, instant template injection, and customizable themes.
- **Rich Multimodal Clipboard & Live Preview**: Native clipboard extraction supporting OS screenshots, rich text, and images. Features instant local zero-latency preview (`createObjectURL`) alongside strict server-side zero-byte validation.

### <img src="docs/icons/shield.svg" width="16" height="16" valign="middle" /> 2. Structured Document Model & Write Guards
- **Stable Block Identifiers**: Every paragraph, heading, table, and slide possesses an immutable Block ID. AI agents insert, replace, move, or modify targeted blocks without risky whole-document overwrites.
- **User Primacy**: Human edits take precedence in concurrent conflicts.
- **Comment Anchor Preservation**: Re-indexes and protects inline comments and annotations across AI and human editing sessions.
- **Atomic Transactions & Safe Rollback**: Every change to the underlying CRDT is validated, pre-checked, and applied atomically.

### <img src="docs/icons/zap.svg" width="16" height="16" valign="middle" /> 3. Self-Contained Vector Slide Rasterizer
- **Zero Heavyweight External Dependencies**: Embedded Rust/WASM-based `@resvg/resvg-js` high-performance rendering engine.
- **Native 4K PNG Rendering**: Renders SVG/HTML slide decks directly into high-fidelity PNG thumbnails and exports within the Node.js process—no LibreOffice (`soffice`), Docker, or headless Chrome required.
- **Two-Tier Caching & Anti-Stampede Locks**: In-memory LRU plus on-disk caching guarded by concurrency mutexes to prevent cache stampedes under heavy traffic.

### <img src="docs/icons/globe.svg" width="16" height="16" valign="middle" /> 4. Real-Time Multi-Party CRDT Collaboration
- **Distributed Lock-Free Sync**: Powered by Yjs CRDT (Conflict-free Replicated Data Type) and WebSocket protocol for sub-millisecond human-to-human and human-to-AI co-editing.
- **Snapshot Persistence & Reconnection**: Automatic state persistence to disk with incremental delta synchronization upon reconnecting.

### <img src="docs/icons/stethoscope.svg" width="16" height="16" valign="middle" /> 5. Academic Grounding & Clinical Compliance
- **Multi-Source Literature Retrieval**: Integrated federated search across NCBI PubMed, Europe PMC, and OpenAlex.
- **Citation Verification Engine**: Validates cited literature, checks DOIs/PMIDs, and automatically compiles standardized reference lists with bidirectional links.
- **Patient Health Records (PHR) & Cohorts**: Multi-tenant patient record assets and compound cohort query builder.
- **PHI Privacy Leak Scanner**: Built-in scanner to detect, flag, and mask Protected Health Information (PHI) before content is committed or sent off-premise.

### <img src="docs/icons/chart.svg" width="16" height="16" valign="middle" /> 6. Clinical Collaboration & Publication Evidence Suite
- **De-Identified Subject Management (S001...)**: Compound criteria filtering to enroll eligible patients, decoupling clinical codes from academic research subject IDs with instant wide/long dataset synthesis.
- **Publication-Grade Native Word Table 1**: Automated generation of native Word `.docx` 3-line tables complying with ICMJE/NEJM standards (1.5pt/0.5pt borders, Times/Songti academic typography, and statistical footnotes).
- **CONSORT 2010 / STROBE Flowcharts**: Vector SVG and Mermaid dynamic participant enrollment flowcharts.
- **Causal Inference & Sensitivity Diagnostics**: Absolute standardized mean difference (SMD) Love Plots and VanderWeele E-value unmeasured confounding sensitivity calculator with bilingual academic defense statements.

### <img src="docs/icons/bot.svg" width="16" height="16" valign="middle" /> 7. Standardized Model Context Protocol (MCP)
- Exposes structured, safe toolsets over standard MCP transports (SSE and Stdio).
- Out-of-the-box integration with [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), Claude Desktop, Cursor, Gemini, and custom AI agent workflows.

---

## <img src="docs/icons/layers.svg" width="18" height="18" valign="middle" /> Dual-Engine Architecture

Heurion 2.0 is structured as a modern pnpm Monorepo:

```
heurion2/
├── apps/
│   ├── platform/              # [Platform] Heurion 2.0 Medical Intelligence Workspace (Port: 8787)
│   │   ├── src/
│   │   │   ├── model/         # Structured Document/Deck schema, Block IDs & comment anchors
│   │   │   ├── ops/           # Validation → Write Guards → Atomic application layer
│   │   │   ├── mcp/           # Platform MCP Server (DeepSeek Harness / Claude)
│   │   │   ├── render/        # resvg-js vector rasterizer & slide deck engine
│   │   │   ├── literature/    # PubMed / Europe PMC / OpenAlex search & citation formatting
│   │   │   ├── tenancy/       # Patient records, PHR share credentials & Claims
│   │   │   ├── ops/phi-scan.ts# PHI de-identification & security scanner
│   │   │   ├── harness/       # DeepSeek Harness sandbox process pool
│   │   │   └── collab/        # Yjs WebSocket collaboration gateway
│   │   └── web/               # Platform ProseMirror collaborative editing UI
│   │
│   ├── canvas-service/        # [Canvas] OmniCanvas Standalone Canvas Microservice (Port: 8888)
│   │   ├── src/
│   │   │   ├── index.ts       # Standalone microservice entry (REST + WebSocket + MCP)
│   │   │   ├── app.ts         # Pure Canvas MCP Server (30 authoring/formatting tools)
│   │   │   └── collab.ts      # Standalone Yjs CRDT room manager
│   │   └── web/               # Document & slide deck workspace frontend
│   │       ├── src/editor.ts  # Document editor core
│   │       ├── src/deck.ts    # Slide deck designer core
│   │       └── src/main.ts    # Workspace shell & command center
│   │
│   └── embedder/              # [Search] Local embedding & semantic search helper service
│
├── docs/                      # Architectural specifications & migration plans
└── scripts/                   # Ops, container build, and benchmarking scripts
```

---

## <img src="docs/icons/terminal.svg" width="18" height="18" valign="middle" /> Quick Start

### 1. Prerequisites
- **Node.js**: $\ge 24.0.0$
- **Package Manager**: `pnpm` ($\ge 9.0.0$)
- *(Optional)* **Docker**: For sandboxed container deployment

### 2. Installation & Configuration
Clone the repository and prepare the environment configuration:

```bash
git clone https://github.com/heurion-org/heurion.git
cd heurion2

# Create environment file from template
cp .env.example .env

# Install all workspace dependencies
pnpm install
```

Configure your credentials in `.env`:
```ini
# DeepSeek API Key (for dsh agent runner)
DEEPSEEK_API_KEY=your_deepseek_api_key_here

# Server ports & data directory
PORT=8787
HEURION_DATA_DIR=./data
HEURION_SECRET=your_production_secret_32_bytes_string
HEURION_DEV_TOKEN=dev

# Optional: Literature search acceleration keys
NCBI_API_KEY=
CONTACT_EMAIL=
```

### 3. Build & Run Services

#### Running Heurion Medical Platform
```bash
# 1. Build frontend assets
pnpm --filter @heurion2/platform build

# 2. Start platform server (Web UI + REST API + /collab + /mcp on port 8787)
pnpm --filter @heurion2/platform dev
```
Open your browser at: `http://127.0.0.1:8787`

> **Frontend HMR Development**: Run `pnpm --filter @heurion2/platform dev:web` to launch the Vite hot-module-reload server on `http://127.0.0.1:5173` (proxies API calls to port 8787).

#### Running OmniCanvas Standalone Microservice
```bash
# 1. Build standalone web assets
pnpm --filter @heurion2/canvas-service build

# 2. Start standalone service (runs on port 8888)
PORT=8888 pnpm --filter @heurion2/canvas-service dev
```
Open your browser at: `http://127.0.0.1:8888`

---

## <img src="docs/icons/tools.svg" width="18" height="18" valign="middle" /> MCP Tools Matrix

Heurion equips AI models with a standardized, boundary-checked tool suite:

### <img src="docs/icons/file-text.svg" width="16" height="16" valign="middle" /> OmniCanvas General Authoring Tools (`@heurion2/canvas-service`)
| Category | Tool Name | Description |
| :--- | :--- | :--- |
| **Canvas Lifecycle** | `canvas_create`, `canvas_get`, `canvas_list` | Create, inspect, and list document/slide canvas entities |
| **Block Mutation** | `canvas_block_insert`, `canvas_block_replace` | Insert, modify, or update structured content by stable Block ID |
| **Block Structure**| `canvas_block_move`, `canvas_block_delete` | Reorder hierarchy or safely delete blocks without corruption |
| **Slide Authoring** | `canvas_slide_add`, `canvas_slide_update` | Add new presentation slides, apply layout templates & themes |
| **Slide Rendering** | `canvas_slide_render`, `canvas_slide_delete`| Trigger resvg engine for 4K PNG rasterization & slide removal |
| **Rich Elements**   | `canvas_table_insert`, `canvas_chart_insert` | Insert structured data tables and analytical charts |

### <img src="docs/icons/dna.svg" width="16" height="16" valign="middle" /> Medical Research Tools (`@heurion2/platform`)
| Category | Tool Name | Description |
| :--- | :--- | :--- |
| **PubMed** | `literature_search_pubmed` | Search NCBI PubMed; retrieve structured abstracts & PMIDs |
| **Europe PMC** | `literature_search_europepmc` | Search Europe PMC open-access articles and metadata |
| **OpenAlex** | `literature_search_openalex` | Query OpenAlex for high-impact citations and bibliographic traces |
| **Citations** | `format_citations` | Generate verified academic references with traceable link anchors |
| **Clinical Records** | `patient_get`, `patient_cohort_query`| Query de-identified patient demographics & compound cohorts |
| **PHI Protection** | `phi_scan_text` | Run HIPAA / PHI privacy leak scans against raw texts |

---

## <img src="docs/icons/flask.svg" width="18" height="18" valign="middle" /> Testing & Quality Assurance

The codebase enforces strict end-to-end automated testing with a **100% test pass rate**:

```bash
# 1. Static type checking across all workspace packages and web apps
pnpm typecheck

# 2. Run unit and integration test suites (47 test suites, 361 tests passing)
pnpm test

# 3. Run real agent end-to-end evaluation (requires DEEPSEEK_API_KEY)
pnpm --filter @heurion2/platform e2e

# 4. Run browser UI end-to-end tests via Playwright
pnpm --filter @heurion2/platform ui
```

---

## <img src="docs/icons/book.svg" width="18" height="18" valign="middle" /> Architecture & Documentation

- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**Documentation Index (docs/README.md)**](docs/README.md): Complete engineering & domain design specifications.
- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**Platform Architecture (PLATFORM.md)**](docs/PLATFORM.md): Document model, operational Write Guards, and DSH execution pool.
- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**Deployment Guide (DEPLOY.md)**](docs/DEPLOY.md): Production setups, containerization, reverse proxying & TLS.
- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**Self-Evolving Memory Governance PRD (MEMORY_GOVERNANCE_PRD.md)**](docs/design/MEMORY_GOVERNANCE_PRD.md): Three-tier memory architecture, CoEM/SafeVantage gating, and evidence coverage verification.
- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**Cohort Architecture (COHORT.md)**](docs/design/COHORT.md): Medical cohort compound filtering rules.
- <img src="docs/icons/bullet.svg" width="8" height="8" valign="middle" /> [**Patient Data & Sharing (PATIENT.md & SHARING.md)**](docs/design/PATIENT.md): Authorization claims & record privacy.

---

<br />

---

# Heurion 2.0 & OmniCanvas (中文版)

> 本节包含完整的中文版使用指南。你也可以直接查阅 [独立中文文档 (README_CN.md)](./README_CN.md)。

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

### <img src="docs/icons/bot.svg" width="16" height="16" valign="middle" /> 6. 标准化 Model Context Protocol (MCP)
- 原生支持标准 MCP 协议，通过 SSE / Stdio 暴露结构化工具集。
- 深度兼容 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）、Claude Desktop、Cursor 等任意兼容 MCP 的 Agent 运行时。

---

## <img src="docs/icons/terminal.svg" width="18" height="18" valign="middle" /> 中文快速开始

```bash
git clone https://github.com/heurion-org/heurion.git
cd heurion2

cp .env.example .env
pnpm install

# 启动 Heurion 平台 (http://127.0.0.1:8787)
pnpm --filter @heurion2/platform build
pnpm --filter @heurion2/platform dev

# 启动独立 OmniCanvas 画布服务 (http://127.0.0.1:8888)
pnpm --filter @heurion2/canvas-service build
PORT=8888 pnpm --filter @heurion2/canvas-service dev
```

详细中文说明请查阅完整中文文档：[**README_CN.md**](./README_CN.md)

---

## <img src="docs/icons/scale.svg" width="18" height="18" valign="middle" /> 开源许可 (License)

本项目基于 [MIT License](./LICENSE) 协议开源。
