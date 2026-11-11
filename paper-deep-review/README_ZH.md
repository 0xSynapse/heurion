# 自演进四阶段临床深度审稿（Heurion Deep Review）Clean-Room 论文导读与复现指南

> **英文标题**：**Self-Evolving Clinical Deep Review: Eliminating Recurring Methodological False Alarms without Compromising Objective Error Recall via Comment-Driven Dual-Track Memory**  
> **中文译名**：**自演进四阶段临床深度审稿：基于批注驱动双轨记忆在不牺牲客观错误召回率的前提下消除重复方法学误报**  
> **配套文件**：
> - [`paper-deep-review/main.tex`](./main.tex)：经 Clean-Room 审计重构后的独立英文 LaTeX 论文源码（零特定论文词元泄漏、真实核验参考文献、区分原文自带真错 `unexpected_true`）
> - [`paper-deep-review/benchmarks/run-injected-review-evolution.ts`](./benchmarks/run-injected-review-evolution.ts) & [`paper-deep-review/results/injected_deep_review_evolution.json`](./results/injected_deep_review_evolution.json)：19 篇 2025 PMC 开放获取 JATS XML 全文论文（38 份 clean/injected 全文，57 处植入客观错误 `E1`–`E7`）Clean-Room 端到端基准脚本与结果 JSON
> - [`apps/platform/eval/deep-review/known-organic-errors.json`](../apps/platform/eval/deep-review/known-organic-errors.json) & [`apps/platform/eval/deep-review/adjudications/organic-known-issues.jsonl`](../apps/platform/eval/deep-review/adjudications/organic-known-issues.jsonl)：发表版原文自带真实错误（`unexpected_true`）核定库

---

## 一、 Clean-Room 科学诚信保证（防过拟合与物理双盲协议）

1. **100% 领域通用 AST 核查器（[`extract.ts`](../apps/platform/src/claims/extract.ts) & [`ci-check.ts`](../apps/platform/src/claims/ci-check.ts)）**：
   - 不包含任何针对特定测试集论文的药物名、菌株名、句子级正则或合成 `design_boundary_*` 告警触发器；全部规则仅基于二维 ProseMirror `TableGrid` 算术、精度感知置信区间（排除 `p=`、`n=` 与单位上标 `m^2`）及统计方法配对逻辑。
2. **物理双盲隔离的临床作者模拟代理（[`simulateBlindClinician`](../apps/platform/scripts/eval-review-run.ts)）**：
   - 函数签名物理上不接收 `variant`（`clean`/`injected`）、不接收 `injections.json`、不接收 `split`（`dev`/`test`），彻底杜绝 Oracle Peeking。
   - 在跨论文迁移（`dev` $N=11 \to$ `test` $N=8$）中，进入 `test` 集后记忆库完全冻结；向 `evolveAuditChecklistsFromDevMisses` 传入非 `dev` 论文会直接抛出运行时安全异常。
3. **零模板 LLM 蒸馏与双重脱敏锁（[`synthesizeSanitizedBoundaryRuleAsync`](../apps/platform/src/claims/service.ts)）**：
   - 经 `hasInstanceLeakage` + `sensitiveReason` 双重校验，首次草稿若夹带具体样本量或百分比自动执行二次剥离，实例泄漏率严格为 `0.0%`；同时 `NON_EXEMPTABLE_SUBTYPES` 确保客观算术/CI/表文错误误豁免率严格为 `0.0%`。

---

## 二、 核心实验结果总览

### 实验 1：19 篇 2025 PMC 全文论文（57 处植入错误 `E1`–`E7`）Clean-Room AST 实测结果

| 评测工况与数据集切分 | 植入客观错误召回率 (`E1`–`E7`) | 原文自带真错检出 (`unexpected_true`) | 真正误报数 (`Clean / Inj`) | 精确率 (含原文真错) | F1 分数 | 安全底线核验 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Clean-Room AST Only (`All`, $N=19$)** | **66.7% (38/57)** | **7 处（干净版）** | **9 (5 / 4)** | **85.5%** | **74.9%** | 0 LLM 调用（0.26 FP/篇） |
| **Clean-Room AST Only (`dev`, $N=11$)** | 72.7% (24/33) | 6 处（干净版） | 5 (3 / 2) | 88.1% | 79.7% | 原始干净告警 9 条（6 真错 + 3 误报） |
| **Clean-Room AST Only (`test`, $N=8$)** | 58.3% (14/24) | 1 处（干净版） | 4 (2 / 2) | 80.0% | 67.4% | 原始干净告警 3 条（1 真错 + 2 误报） |
| **Adversarial Rebuttal Stress ($N=19$)** | **66.7% (38/57)** | **7 处（干净版）** | 9 (5 / 4) | **85.5%** | **74.9%** | **0.0% 客观错误误豁免 (0/38)** |

- **Clean-Room 纯 AST 分项召回率（零 LLM 调用）**：`E1` 8/10 (80.0%)、`E2` 5/6 (83.3%)、`E3` 5/8 (62.5%)、`E4` 6/8 (75.0%)、`E5` 5/8 (62.5%)、`E6` 2/9 (22.2%，开放语义 Spin 需结合 Stage 3 LLM 检出)、`E7` 7/8 (87.5%)。
- **在线混合大模型与物理双盲临床作者评测（`--llm`）**：在仓库根目录 `.env` 中配置 `DEEPSEEK_API_KEY` 后，运行下方命令即可自动补全 `pat_baseline`、`heurion_deep` 与 `heurion_evolved`（`dev -> test` 冻结迁移 + 双盲临床作者校准矩阵）在线实测数据。

### 实验 2：7 篇临床肿瘤学真实错误片段（Vignettes）在线 `deepseek-chat` 端到端实测对比

| 审稿管线模式 | 有机发表错误召回率 (`8` 处真错) | 总误报数 (FP) | 精确率 (Precision) | F1 分数 | 活跃边界规则（泄漏率） |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `zero_shot`（单次审稿） | 37.5% (3/8) | 15 | 16.7% | 23.1% | 0 (0.0%) |
| `pass_at_k`（$k=3$ 并集） | 62.5% (5/8) | 26 | 16.1% | 25.6% | 0 (0.0%) |
| `pat_baseline`（4 阶段纯文本 Google PAT） | 37.5% (3/8) | 14 | 17.6% | 24.0% | 0 (0.0%) |
| `heurion_deep`（冷启动四阶段 + 表格 AST） | **100.0% (8/8)** | 16 | 33.3% | 50.0% | 0 (0.0%) |
| **`heurion_evolved`（双轨自演进）** | **100.0% (8/8)** | **0 (-100.0%)** | **100.0%** | **100.0%** | **4 (0.0%)** |

---

## 三、 一键复现命令

```bash
# 1. 运行 Clean-Room 纯 AST 基准测试（无需 API Key，约 11 秒）
./apps/platform/node_modules/.bin/tsx paper-deep-review/benchmarks/run-injected-review-evolution.ts --no-llm

# 2. 运行在线大模型混合审稿 + 物理双盲临床作者自演进全量评测（需在 .env 配置 DEEPSEEK_API_KEY）
./apps/platform/node_modules/.bin/tsx paper-deep-review/benchmarks/run-injected-review-evolution.ts --llm

# 3. 运行全部 51 项深度审稿、置信区间、锚定与防泄漏单元测试
./apps/platform/node_modules/.bin/vitest run apps/platform/tests/ci-check.test.ts apps/platform/tests/review-evidence.test.ts apps/platform/tests/deep-review-anchor.test.ts apps/platform/tests/deep-review-pdf-tables.test.ts apps/platform/tests/imaging-review.test.ts apps/platform/src/claims/claims-pat.test.ts
```
