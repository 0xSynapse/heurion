---
name: heurion-clinical-research
description: 知衡 (Heurion 2.0) 第一方临床与科研智能工作台 SOP。用于临床病历结构化抽取、知家 (PHR) 档案管理、真实世界队列纳排、CoW 沙箱统计建模、可溯源图表上传与多智能体论文/幻灯片协同写作。
---

# 知衡 (Heurion 2.0) — Aegis-OS 第一方应用协同作业指南 (`AAP-1.0`)

当你在 **Aegis-OS Runtime (`aegis-os`)**（支持 Antigravity `agy`、Hermes、Claude Code、Codex 等异构智能体）中挂载或调用 `heurion` 时，请遵循以下标准作业规程（SOP）。

---

## 1. 身份与权限边界（医生同权 + 两级门控）

1. **医生同权与机构隔离**：
   - 你通过 `Authorization: Bearer aegis_at_heurion.<grant_id>.<secret>` 继承当前绑定医生/研究员的完整身份（`user_id`、`tenant_id`、课题组成员角色）。
   - 严禁在论文、幻灯片或外部模型提示词中硬编码患者真实姓名、身份证号、手机号或住院号（PHI 写前守卫会自动拦截），一律使用患者代号（如 `P-2026-001`）。
2. **`[Zero-Prompt]` 日常科研与文稿操作（自动放行，走 CoW 回滚与 `via=ai` 标记）**：
   - 论文/病历编辑：`doc_outline` $\rightarrow$ `doc_read` $\rightarrow$ `doc_edit`
   - 幻灯片制作：`deck_edit` $\rightarrow$ `layout_check` $\rightarrow$ `slide_render`
   - 按智能体回合精准回滚：`doc_revert_turn(doc_id, agent_only=true)`（仅撤销你当前 `X-Aegis-Agent-Id` 的最近一轮改动，不破坏人类医生或其他协作 Agent 的修订）
   - 临床建档与抽取：`patient_create`、`report_upload`（支持 `bytes_base64`）、`report_lab_add`
3. **`[Lease-Gated]` 临床签字与对外不可逆操作（需租约授权）**：
   - 包括：双人复核模式下的临床指标签字确认（`patient_admin.record_confirm`）、对外分享知家健康档案（`phr_share_admin.*`）、正式发送外部邮件（`mail_admin.send`）、修改机构安全策略（`tenant_admin.*`）。
   - 若工具返回 `code: "lease_required"` 及 `escalation_id: "esc-heurion-..."`，请将 `escalation_id` 或 `approve_cmd` 告知医生：
     - 医生可在终端执行 `aegis-os policy approve <escalation_id>`（由本地节点 Ed25519 私钥签发 `X-Aegis-Lease-Token`）；
     - 或在知衡 Web 顶栏「待确认」面板一键点击「批准（15分钟租约）」，随后你即可重试该操作。

---

## 2. 跨 CoW 沙箱的统计建模与图表溯源标准链路

在 `aegis-os` 隔离的 Copy-on-Write 影子工作区中执行临床统计分析（Kaplan-Meier 生存曲线、Cox 回归、PSM 倾向性评分匹配、森林图等）时，请按以下 4 步执行：

1. **探查数据结构**：
   - 调用 `study_read` 或 `dataset_describe(dataset_id)` 查看变量名、类型、缺失率与样本量。
2. **下行拉取脱敏 CSV 到本地 CoW 沙箱**：
   - 调用 `dataset_open(dataset_id, return_content=true)`（或针对单患者调用 `labs_open(patient_id, return_content=true)`）。
   - 将返回的 `csv_content` 使用 `aegis-os` 的 `fs_write` 写入当前影子工作区（如 `scratch/cohort.csv`）。
3. **在本地沙箱内运行统计与绘图脚本**：
   - 使用 `fs_write` 编写分析脚本（如 `scratch/km_plot.py`），并通过 `proc_exec` 执行脚本生成高清图表（`.png` / `.svg`）。
4. **上行回传图表并绑定完整计算溯源（Provenance）**：
   - 读取生成的图片为 Base64，调用 `asset_upload`：
     - `bytes_base64`: 图片 Base64 编码
     - `code`: 分析脚本完整源码字符串
     - `datasets`: `["<dataset_id>"]`
   - 随后在 `doc_edit` 或 `deck_edit` 中引用返回的 `asset:<asset_id>` 插入论文或幻灯片。研究页「分析来源」将自动展示该图表的生成代码与数据集版本，确保医学论文 100% 可复现。

---

## 3. 多智能体协同写作最佳实践（Writer + Statistician + Fact-Checker）

当多个智能体通过 `aegis-os` IPC 总线协同撰写同一篇医学论文时：
1. **Statistician Agent**：负责 `dataset_open` $\rightarrow$ `proc_exec` 统计检验 $\rightarrow$ `asset_upload` 上传图表，并通过 `ipc_send` 将 `asset_id` 与核心统计量（HR, 95% CI, P 值）发给 Writer Agent。
2. **Writer Agent**：通过 `doc_read` 读取目标章节块 ID，调用 `doc_edit` 写入正文与图表引用，使用不同 `X-Aegis-Agent-Id` 保持各自独立的 `turn_bases` 回滚基线。
3. **Fact-Checker Agent**：调用 `pubmed_search` / `openalex_search` / `verify_claims` 核对正文论断与参考文献一致性，对存疑句段挂载批注供主治医师终审。
