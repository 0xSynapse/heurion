# Heurion 2.0 文档导航 (Documentation Index)

欢迎阅读 Heurion 2.0 平台工程与设计文档。本目录按职责划分为**核心架构与部署**、**业务与临床科研设计**以及**资产**三个部分。

---

## 核心架构与部署 (Core Architecture & Ops)

| 文档 | 描述 |
|---|---|
| [**PLATFORM.md**](PLATFORM.md) | **平台核心架构**：基于 ProseMirror + Yjs CRDT 的文档与幻灯片双模引擎、写前守卫（Write Guards）、双服务解耦（`platform` 与 `canvas-service`）、Model Context Protocol (MCP) 接口体系。 |
| [**DEPLOY.md**](DEPLOY.md) | **生产环境部署指南**：单机 Docker Compose 架构、Caddy 反向代理、容器安全沙箱与 UID 隔离、S3 增量异地备份。 |

---

## 业务与临床科研系统设计 (Domain Designs)

位于 [`design/`](design/) 目录，涵盖临床多租户、课题组、患者档案与安全红线设计：

| 文档 | 模块 | 关键内容 |
|---|---|---|
| [`design/TENANCY.md`](design/TENANCY.md) | 租户与空间 | 工作空间（机构/科室）与个人空间的双重身份、邀请/加入/退出机制、数据隔离边界。 |
| [`design/TEAM.md`](design/TEAM.md) | 课题团队 | 角色模型（PI 主要研究者、Co-PI、CRA、研究员等）、权限矩阵与课题协作。 |
| [`design/PATIENT.md`](design/PATIENT.md) | 患者档案 (知家) | 患者档案模型、检查检验指标、PHI 隐私脱敏与受试者编码。 |
| [`design/SHARING.md`](design/SHARING.md) | 档案共享凭证 | 家属端向医生/医院安全共享档案的授权 Claims、只读访问控制、审计流水。 |
| [`design/COHORT.md`](design/COHORT.md) | 临床科研队列 | 复合条件检索、入组与排除标准自动筛选、队列样本集管理。 |
| [`design/AI_PERMISSIONS.md`](design/AI_PERMISSIONS.md) | AI 权限与红线 | 医疗大模型外发红线、操作前权限校验、安全话术兜底机制。 |
| [`design/AEGIS_APP_PROTOCOL.md`](design/AEGIS_APP_PROTOCOL.md) | Aegis OS 应用协议 (`AAP-1.0`) | 第一方/第三方统一鉴权、App Store 自发现清单 (`/.well-known/aegis-app.json`)、Ed25519 加密租约验签与 Heurion 2.0 接入方案。 |

---

## 视觉与图表资产 (Assets)

- [`icons/`](icons/)：包含平台与 README 使用的高保真矢量 SVG 图标（如 `studio.svg`, `features.svg`, `dna.svg`, `shield.svg`, `book.svg` 等）。
