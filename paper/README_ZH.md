# Heurion ADI（双表面契约守护 CRDT 与词元级补丁 OOXML 协同文档引擎）Clean-Room 论文导读与复现指南

> **英文标题**：**Beyond File Scripting: A Contract-Guarded Dual-Surface CRDT and Token-Patched OOXML Engine for Human-AI Scientific Co-Authoring**  
> **中文译名**：**超越文件脚本：面向人机科学协同写作的契约守护双表面 CRDT 与词元级补丁 OOXML 引擎**  
> **定位说明**：本篇专注于 **Agent-Document Interface（ADI）协同编辑与出版级 Word 双向无损系统底座**（面向 HCI / System Demonstration / 系统架构报告），与第二篇临床深度审稿及批注驱动自演进论文（[`paper-deep-review/main.tex`](../paper-deep-review/main.tex)）完全正交互补。  
> **核心配套文件**：
> - [`paper/main.tex`](./main.tex)：精悍重构后的 Clean-Room 英文 LaTeX 论文源码（零拼凑概念、零占位符假文献、100% 对应生产引擎源码）
> - [`paper/benchmarks/run-clean-adi-eval.ts`](./benchmarks/run-clean-adi-eval.ts) & [`paper/results/clean_adi_benchmark.json`](./results/clean_adi_benchmark.json)：基于 **19 篇真实 2025 PMC 开放获取临床全文（总计 150,152 词、2,719 个 AST 块）** 的确定性引擎基准与输出 JSON
- [`paper/benchmarks/run-online-adi-llm-eval.ts`](./benchmarks/run-online-adi-llm-eval.ts) & [`paper/results/online_adi_llm_benchmark.json`](./results/online_adi_llm_benchmark.json)：使用真实在线大模型（`deepseek-v4-flash`，$T=0$）跨 19 篇临床全文执行的 **171 轮多步工具调用与冲突自修实测结果**
> - [`paper/ARXIV_SUBMISSION.txt`](./ARXIV_SUBMISSION.txt) & [`paper/heurion2_arxiv.tar.gz`](./heurion2_arxiv.tar.gz)：arXiv 提交元数据与无注释纯净源码包

---

## 一、 核心技术贡献（100% 对应平台底层实现）

1. **双表面同源 CRDT 投影（[`runtime.ts`](../apps/platform/src/model/runtime.ts) + [`read.ts`](../apps/platform/src/views/read.ts) + [`table-grid.ts`](../apps/platform/src/model/table-grid.ts)）**：
   - 单一服务端权威 Yjs + ProseMirror 状态同时投影人类富文本 WebSocket 编辑器与 AI Agent 的 Annotated Markdown 视图；
   - 提供生命周期稳定的块 ID（`{#id}`）、跨行列合并二维逻辑坐标网格（`readGrid`，以 `<` 和 `^` 显式对齐合并区）、平台注册原子引用（`[@c:id]`）、Word 行内不透明域/脚注原子（`[@w:id]`）及批注锚点（`{#c:id}`）。
2. **细粒度多轮共编契约与两级选择性回滚（[`service.ts`](../apps/platform/src/ops/service.ts) + [`apply.ts`](../apps/platform/src/ops/apply.ts) + [`revert.ts`](../apps/platform/src/ops/revert.ts)）**：
   - **逐块已读视野（`noteSeen`）与医生手改增量保护**：突破传统文档级 `ETag`（`base_rev == doc_rev`）在多轮会话中的盲改漏洞——即使 Agent 在其他段落获得了最新文档版本号，仍会拦截其对未重读段落的覆盖；即使重读后，若润色删除了医生手改的关键统计值（如 `HR 1.12`）或新增补充句，仍被 `conflict_user_edited` 精准阻断；
   - **同段异句无锁交换（`replace_text`）** 与 **零副作用预检（`doc_validate`）**；
   - **两级 `revertTurn`**：内存态通过回合作用域 `Y.UndoManager` 支持**同段人机交错修改后的乱序单轮 AI 撤销**；冷重启后通过 SQLite 状态向量与 [`revertByNodes`](../apps/platform/src/ops/revert.ts) 按“人类修改优先跳过”安全回退。
3. **段内词元级补丁 OOXML 双向无损引擎（[`docx-import.ts`](../apps/platform/src/convert/docx-import.ts) + [`docx-patch.ts`](../apps/platform/src/convert/docx-patch.ts) + [`docx-export.ts`](../apps/platform/src/convert/docx-export.ts)）**：
   - 未触碰块经 `node_src` 100% 原始字节直写；
   - **已修改段落**经 `docx-patch` 将原始 `<w:p>` 解析为记号树，仅切割变化的 `<w:t>` 文本切片，使段内 **EndNote 复杂引文域（`ADDIN EN.CITE`）、`SEQ` 动态题注域、脚注、书签、`<m:oMath>` 行内公式、`<w:sdt>` 内容控件、合作者待审修订（`w:ins/w:del`）与线程批注（`w15:paraIdParent`）** 100% 原位保留，并在导出 `suggest` 修订时自动剥离 `w:del` 重复 `w14:paraId`。

---

## 二、 Clean-Room 实测结果摘要（19 篇 2025 PMC 全文，150,152 词）

### 实验 1：三种真实代码管线的 `.docx` 往返保真度对比

| 保真度维度 | Markdown 重序列化管线 | XML `<w:p>` 脚本 (`pPr` 保留) | **Heurion ADI (`node_src` + `docx-patch`)** |
| :--- | :---: | :---: | :---: |
| **未修改块逐字节一致率（2,553 块）** | 0.0% (0/2,553) | **100.0%** (2,553/2,553) | **100.0% (2,553/2,553)** |
| **已改段内 EndNote 复杂域 (`ADDIN EN.CITE`)** | 0.0% (0/19) | 0.0% (0/19) | **100.0% (19/19)** |
| **已改段内 `SEQ` 题注域 + 脚注引用** | 0.0% (0/19) | 0.0% (0/19) | **100.0% (19/19)** |
| **已改段内书签 + 符号 + 高亮 + `<m:oMath>` 公式** | 0.0% (0/19) | 0.0% (0/19) | **100.0% (19/19)** |
| **外层内容控件包裹 (`<w:sdt>`)** | 0.0% (0/19) | **100.0%** (19/19) | **100.0% (19/19)** |
| **已改段/表合作者 `w:ins`/`w:del` 修订归属** | 0.0% (0/19) | 0.0% (0/19) | **100.0% (19/19)** |
| **线程批注 (`w15:paraIdParent`) 与锚点闭合** | 0.0% (0/19) | 0.0% (0/19) | **100.0% (19/19)** |
| **已修改块出版级结构总存活率（114 处）** | 0.0% (0/114) | 16.7% (19/114) | **100.0% (114/114)** |

- **7,903 词长文真实延迟中位数（P50）**：`.docx` 导入水合 `29.00 ms`、无副作用预检 `doc_validate` **`2.90 ms`**、8 操作原子批次编辑 `17.42 ms`、段内选择性回滚 `revertTurn` **`5.28 ms`**、词元补丁 `.docx` 导出 **`15.53 ms`**。

### 实验 2：人机并发共编契约与两级选择性回滚（8 类场景 × 19 篇全文 = 152 次试验）

- **磁盘直接覆写基线（Disk Overwrite）**：S1–S8 全场景 `0.0%`；
- **朴素文档级乐观锁基线（Naive Doc-Rev `ETag` + 线性快照撤销）**：仅能拦截 S1 直接旧版本号覆盖（`100.0%`），在 S2（持新版本号覆盖未重读段落）、S3（重读后误删医生订正的 `HR` 值）、S4（同段异句并发交换）及 S7–S8（同段交错修改后的乱序/跨重启单轮撤销）上全部为 `0.0%`；
- **Heurion ADI**：S1–S8 全部 **100.0%** 通过（含 S6 `57/57` 裸 DOI / 原生 `[1]` 劫持 / 伪造 `[@w:w99]` 拦截，以及 18 篇含表临床全文的二维 `TableGrid` 合并坐标校验 `18/18 = 100.0%`）。

### 实验 3：真实在线大模型多步工具协同与回合内自主自修（`deepseek-v4-flash`，171 轮真实会话）

| 在线评测指标 / 任务负载（每组 57 轮） | Direct OOXML LLM 直接改写 | Naive Doc-Rev MCP 基线 | **Heurion ADI 契约 MCP** |
| :--- | :---: | :---: | :---: |
| **W1：富出版结构段内精修（EndNote + 脚注 + 公式）** | **100.0%** (19/19) | 0.0% (0/19) | **100.0% (19/19)** |
| **W2：多轮会话中途医生并发改稿（`HR 1.48 -> 1.12`）** | 0.0% (0/19) | 0.0% (0/19) | **100.0% (19/19)** |
| **W3：真实临床合并表头更新 + 挂批注段落重写** | 0.0% (0/19) | 0.0% (0/19) | **100.0% (19/19)** |
| **端到端任务与 OOXML 保真总成功率（57 轮）** | 33.3% (19/57) | 0.0% (0/57) | **100.0% (57/57)** |
| **导出 `.docx` 严格 XML 合法率（`DOMParser`）** | 94.7% (54/57) | **100.0%** (57/57) | **100.0% (57/57)** |
| **W2 并发冲突触发后回合内自主自修率** | N/A | 0.0% (0 次捕获) | **100.0% (14/14)** |
| **单轮平均输出 Token / W3 表格任务平均耗时** | 3,446 tok / 28.98 s | 546 tok / 6.43 s | **798 tok** / **9.13 s** |

---

## 三、 一键复现命令

```bash
# 1. 运行 19 篇真实 2025 PMC 全文确定性 ADI 引擎基准测试（无需 API Key，约 10 秒）
./apps/platform/node_modules/.bin/tsx paper/benchmarks/run-clean-adi-eval.ts

# 2. 运行真实在线 LLM 多步工具闭环与冲突自修基准（需配置 .env 中 DEEPSEEK_API_KEY 与 DSH_MODEL=deepseek-v4-flash）
./apps/platform/node_modules/.bin/tsx --env-file-if-exists=.env paper/benchmarks/run-online-adi-llm-eval.ts --concurrency 8

# 3. 运行平台底层 Word 保真、编辑契约与跨重启回滚单元测试套件
./apps/platform/node_modules/.bin/vitest run apps/platform/tests/word-fidelity.test.ts apps/platform/tests/ops.test.ts apps/platform/tests/revert.test.ts

# 4. 重新打包纯净 arXiv 上传压缩包（生成 paper/ax.tar 与 paper/heurion2_arxiv.tar.gz）
./apps/platform/node_modules/.bin/tsx paper/scripts/prepare_arxiv_tar.ts
```
