# Heurion 2.0 文档导航 (Documentation Index)

欢迎阅读 Heurion 2.0 平台工程与设计文档。本目录按职责划分为**核心架构与部署**、**业务与临床科研设计**、**自演进记忆与研究**以及**视觉资产**四个部分。

---

## 核心架构与部署 (Core Architecture & Ops)

| 文档 | 描述 |
|---|---|
| [**PLATFORM.md**](PLATFORM.md) | **平台核心架构**：基于 ProseMirror + Yjs CRDT 的文档与幻灯片双模引擎、写前守卫（Write Guards）、三层自演进记忆引擎、双服务解耦（`platform` 与 `canvas-service`）、Model Context Protocol (MCP) 接口体系。 |
| [**DEPLOY.md**](DEPLOY.md) | **生产环境部署指南**：单机 Docker Compose 架构、Caddy 反向代理、容器安全沙箱与 UID 隔离、S3 增量异地备份。 |

---

## 业务与临床科研系统设计 (Domain Designs)

位于 [`design/`](design/) 目录，涵盖临床多租户、课题组、患者档案、记忆治理与安全红线设计：

| 文档 | 模块 | 关键内容 |
|---|---|---|
| [`design/TENANCY.md`](design/TENANCY.md) | 租户与空间 | 工作空间（机构/科室）与个人空间的双重身份、邀请/加入/退出机制、数据隔离边界。 |
| [`design/TEAM.md`](design/TEAM.md) | 课题团队 | 角色模型（PI 主要研究者、Co-PI、CRA、研究员等）、权限矩阵与课题协作。 |
| [`design/PATIENT.md`](design/PATIENT.md) | 患者档案 (知家) | 患者档案模型、检查检验指标、PHI 隐私脱敏与受试者编码。 |
| [`design/SHARING.md`](design/SHARING.md) | 档案共享凭证 | 家属端向医生/医院安全共享档案的授权 Claims、只读访问控制、审计流水。 |
| [`design/COHORT.md`](design/COHORT.md) | 临床科研队列 | 复合条件检索、入组与排除标准自动筛选、队列样本集管理。 |
| [`design/AI_PERMISSIONS.md`](design/AI_PERMISSIONS.md) | AI 权限与红线 | 医疗大模型外发红线、操作前权限校验、安全话术兜底机制。 |
| [`design/AEGIS_APP_PROTOCOL.md`](design/AEGIS_APP_PROTOCOL.md) | Aegis OS 应用协议 (`AAP-1.0`) | 第一方/第三方统一鉴权、App Store 自发现清单 (`/.well-known/aegis-app.json`)、Ed25519 加密租约验签与 Heurion 2.0 接入方案。 |
| [`design/MEMORY_GOVERNANCE_PRD.md`](design/MEMORY_GOVERNANCE_PRD.md) | 自演进记忆治理 PRD | 从临床医生、统计师与 PI 视角定义三层记忆治理升级的用户场景、UI 显性交互变化、对话隐性体感指标与完整架构逻辑。 |

---

## 研究与演进 (Research & Evolution)

| 文档 | 描述 |
|---|---|
| [**MEMORY_PAPER_ROADMAP.md**](MEMORY_PAPER_ROADMAP.md) | **自演进记忆论文落地对照**：CoEM / SafeVantage / Skill-V / MSCE / MemSkill / MemTransfer 六篇前沿论文机制，与 Heurion 三层自演进记忆实现的差距、落点文件、DDL 规范与分阶段演进路线。 |
| [**MEMORY_P0_EVALUATION.md**](MEMORY_P0_EVALUATION.md) | **P0 阶段研究作用与测试数据报告**：详解 CoEM 与 SafeVantage 对 Heurion 2.0 产品的赋能机制、三维裁决矩阵、状态流转图，以及 7 大测试套件（63 项用例）的实测数据汇总。 |

---

## 视觉与图表资产 (Assets)

- [`icons/`](icons/)：包含平台与 README 使用的高保真矢量 SVG 图标（如 `studio.svg`, `features.svg`, `dna.svg`, `shield.svg`, `book.svg` 等）。
