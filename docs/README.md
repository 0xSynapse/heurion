# Heurion 2.0 文档导航

## 架构与部署

| 文档 | 内容 |
|---|---|
| [PLATFORM.md](PLATFORM.md) | 平台架构：文档 / 幻灯片双内核（ProseMirror + Yjs）、操作层与写前守卫、评论与引用、导入导出、MCP 接口面（dsh 回合）、决策记录 |
| [DEPLOY.md](DEPLOY.md) | 生产部署：Docker Compose、Caddy、发布流程、Secrets、备份与恢复、影像存储 |
| [design/MCP_MODULES.md](design/MCP_MODULES.md) | MCP 模块化与外部接入：接入指南（个人访问令牌、aegis-os 清单与设备码、AAP 兼容）、按模块开放、外发策略、阶段状态 |

## 设计文档（`design/`）

| 文档 | 模块 | 状态 |
|---|---|---|
| [TENANCY.md](design/TENANCY.md) | 机构与个人空间、数据隔离、加密患者库 | 现行 |
| [TEAM.md](design/TEAM.md) | 研究团队角色与权限 | 现行 |
| [AI_PERMISSIONS.md](design/AI_PERMISSIONS.md) | AI 的权限 = 用户的权限；高风险操作的确认 | 现行 |
| [PATIENT.md](design/PATIENT.md) | 知家：家庭健康档案 | 部分实现 |
| [SHARING.md](design/SHARING.md) | 知家「分享给医生」 | 现行 |
| [COHORT.md](design/COHORT.md) | 研究入组与研究数据集 | 现行 |
| [IMAGING_STUDIES.md](design/IMAGING_STUDIES.md) | 影像检查（DICOM）、去标识、结节模型链、阅片与所见草稿 | 现行 |
| [PROVENANCE.md](design/PROVENANCE.md) | 来源等级：AI 文字来源标记、观察记录、写前检查 | 分期上线中 |
| [PROTECTION_RESOLUTION.md](design/PROTECTION_RESOLUTION.md) | 写作保护拦下之后的处理 | 草案 |
| [WORD_ROUNDTRIP.md](design/WORD_ROUNDTRIP.md) | Word 回流三方合并 | 草案 |
| [PDF_ORIGINAL_VIEW.md](design/PDF_ORIGINAL_VIEW.md) | 学术 PDF 原版视图 | 第 1–4 阶段已实现 |
| [IMPORT_EVAL.md](design/IMPORT_EVAL.md) | PDF / Word 导入质量评测 | 现行 |
| [REVIEW_QUALITY.md](design/REVIEW_QUALITY.md) | 深度审稿质量记录与自演进 | 第一步已实现 |
| [DEEP_REVIEW_PRODUCT.md](design/DEEP_REVIEW_PRODUCT.md) | 深度审稿独立产品 | 草案 |
| [DEEP_REVIEW_EVAL.md](design/DEEP_REVIEW_EVAL.md) | 深度审稿评测集 | 草案 |
| [MEMORY_GOVERNANCE_PRD.md](design/MEMORY_GOVERNANCE_PRD.md) | 自演进记忆治理与证据分级 | 部分实现 |
