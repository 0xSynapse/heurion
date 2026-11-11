# 自演进四阶段临床深度审稿（Heurion Deep Review）Clean-Room 论文导读与复现指南

> **英文标题**：**Self-Evolving Clinical Deep Review: Eliminating Recurring Methodological False Alarms without Compromising Objective Error Recall via Comment-Driven Dual-Track Memory**  
> **中文译名**：**自演进四阶段临床深度审稿：基于批注驱动双轨记忆在不牺牲客观错误召回率的前提下消除重复方法学误报**  
> **配套文件**：
> - [`paper-deep-review/main.tex`](./main.tex) & [`paper-deep-review/main.pdf`](./main.pdf)：经 Clean-Room 审计重构并完成真实在线 `deepseek-v4-flash` 端到端实验后的英文 LaTeX 论文源码与编译版 PDF
> - [`paper-deep-review/benchmarks/run-injected-review-evolution.ts`](./benchmarks/run-injected-review-evolution.ts) & [`paper-deep-review/results/injected_deep_review_evolution.json`](./results/injected_deep_review_evolution.json)：19 篇 2025 PMC 开放获取 JATS XML 全文论文（38 份 clean/injected 全文，57 处植入客观错误 `E1`–`E7`）Clean-Room AST + 在线 `deepseek-v4-flash`（3,285 次调用，7.90M 输入 token）端到端实测结果 JSON
> - [`apps/platform/eval/deep-review/known-organic-errors.json`](../apps/platform/eval/deep-review/known-organic-errors.json) & [`apps/platform/eval/deep-review/adjudications/organic-known-issues.jsonl`](../apps/platform/eval/deep-review/adjudications/organic-known-issues.jsonl)：发表版原文自带真实错误（`unexpected_true`，对应 `known-issues.md` 30 条核定记录）

---

## 一、 Clean-Room 科学诚信保证（防过拟合与物理双盲协议）

1. **100% 领域通用 AST 核查器（[`extract.ts`](../apps/platform/src/claims/extract.ts) & [`ci-check.ts`](../apps/platform/src/claims/ci-check.ts)）**：
   - 不包含任何针对特定测试集论文的药物名、菌株名、句子级正则或合成 `design_boundary_*` 告警触发器；全部规则仅基于二维 ProseMirror `TableGrid` 算术、精度感知置信区间（排除 `p=`、`n=` 与单位上标 `m^2`）及统计方法配对逻辑。
2. **物理双盲隔离的临床作者模拟代理（[`simulateBlindClinician`](../apps/platform/scripts/eval-review-run.ts)）**：
   - 函数签名物理上不接收 `variant`（`clean`/`injected`）、不接收 `injections.json`、不接收 `split`（`dev`/`test`），仅提取稿件自身方法、按相关度排序的全部表格（含表题与表注）及对照证据窗口，彻底杜绝 Oracle Peeking。
   - 事后对全部 `291` 次双盲作者裁决校准显示：真实客观错误采纳修复率高达 **95.2% (179/188)**，对方法学边界误报反驳率提升至 **38.8% (40/103)**（共 49 条原始作者回复夹带稿件样本量或百分比数字）。
   - 在跨论文迁移（`dev` $N=11 \to$ `test` $N=8$）中，进入 `test` 集后为每篇测试论文克隆完全冻结的独立记忆快照（零状态篡改）；向 `evolveAuditChecklistsFromDevMisses` 传入非 `dev` 论文直接抛出运行时安全异常。
3. **零模板 LLM 蒸馏、停用词防护与双重脱敏锁（[`synthesizeSanitizedBoundaryRuleAsync`](../apps/platform/src/claims/service.ts)）**：
   - 经 `hasInstanceLeakage` + `sensitiveReason` 双重校验，4 条归并后的 Track A 专科边界规则、3 条 `dev` 跨章节核查清单与 3 条 Track B 固化前置守卫规则（源自 87 条采纳修复信号）的跨论文数字泄漏率严格为 **0.0% (0)**；同时 `NON_EXEMPTABLE_SUBTYPES` + `isHardObjectiveReviewFinding` 确保客观算术/CI/表文错误误豁免率严格为 **0.0% (0/38)**。

---

## 二、 核心实验结果总览

### 实验 1：19 篇 2025 PMC 全文论文（57 处植入错误 `E1`–`E7`）Clean-Room AST × 在线 `deepseek-v4-flash` 端到端实测结果

| 评测工况与数据集切分 | 植入客观错误召回率 (`E1`–`E7`) | 原文自带真错检出 (`Clean`) | 真正误报数 (`Clean / Inj`) | 精确率 (含原文真错) | F1 分数 | 安全底线与治理核验 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Clean-Room AST Only (`All`, $N=19$)** | 66.7% (38/57) | 7 处 | **9 (5 / 4)** | **85.5%** | **74.9%** | 0 LLM 调用（0.26 干净 FP/篇） |
| **Adversarial Rebuttal Stress ($N=19$)** | 66.7% (38/57) | 7 处 | 9 (5 / 4) | 85.5% | 74.9% | **0.0% 客观错误误豁免 (0/38)** |
| `pat_baseline` 纯文本 4 阶段 LLM ($N=19$) | 56.1% (32/57) | 14 处 | 1,081 (532 / 549) | 5.7% | 10.3% | 表格 E7 召回仅 12.5%（15.42 重度 FP/篇） |
| `heurion_deep` 冷启动混合审稿 ($N=19$) | **84.2% (48/57)** | **25 处** | 76 (47 / 29) | 60.2% | 70.2% | 较 `pat_baseline` 削减 **93.0%** 误报 |
| `heurion_evolved` 同稿 Round 2 ($N=19$) | 82.5% (47/57) | 23 处 | **56 (31 / 25)** | **65.2% (+5.0pt)** | **72.8% (+2.6pt)** | 干净稿误报下降 **34.0%**（0.0% 实例泄漏） |
| **`heurion_evolved` 跨论文演化 (`All`, $N=19$)** | **84.2% (48/57)** | 20 处 | **54 (32 / 22)** | **66.0% (+5.8pt)** | **74.0% (+3.8pt)** | **零召回损失**，总误报下降 **28.9%**（`dev` 降 **43.5%**） |
| `heurion_deep` 未见测试集冷启动 (`test`, $N=8$) | 75.0% (18/24) | **7 处** | 30 (19 / 11) | 54.5% | 63.1% | 0 规则（2.25 重度干净 FP/篇） |
| `heurion_evolved` 同稿 Round 2 (`test`, $N=8$) | 70.8% (17/24) | **7 处** | **23 (12 / 11)** | **60.3% (+5.8pt)** | **65.1% (+2.0pt)** | `test` 干净稿误报下降 **36.8%** |
| **`heurion_evolved` 冻结零样本迁移 (`test`, $N=8$)** | **79.2% (19/24, +4.2pt)** | 5 处 | **28 (16 / 12)** | **54.8%** | **64.8% (+1.7pt)** | **召回与精确率双升**（干净 FP 降 **15.8%**，4 规则 + 3 技能，0% 泄漏） |

- **分项召回率跃升（`Clean-Room AST` $\to$ 在线 `heurion_deep` / `heurion_evolved` 跨篇演化）**：`E1` 80.0% $\to$ 80.0% / **90.0%**（`test` 达 **100.0%**）、`E2` 83.3% $\to$ 83.3% / **100.0%**（`test` 达 **100.0%**）、`E3` 62.5% $\to$ **87.5%**、`E4` 75.0% $\to$ 87.5% / **100.0%**（`test` 达 **100.0%**）、`E5` 62.5% $\to$ **87.5%**（冷启动）、`E6` 语义 Spin 22.2% $\to$ **77.8%**（3.5 倍提升）、`E7` 表内求和 87.5% $\to$ 87.5% / **100.0%**（`test` 达 **100.0%**）。

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

# 2. 运行在线大模型混合审稿 + 物理双盲临床作者自演进全量评测（需配置 DEEPSEEK_API_KEY，建议 DSH_MODEL=deepseek-v4-flash）
./apps/platform/node_modules/.bin/tsx paper-deep-review/benchmarks/run-injected-review-evolution.ts --llm

# 3. 运行全部 64 项深度审稿、同稿复审消音、停用词防护、锚定与防泄漏单元测试
cd apps/platform && ./node_modules/.bin/vitest run src/claims/claims-pat.test.ts tests/review-evidence.test.ts tests/deep-review-anchor.test.ts tests/claim-actions.test.ts tests/memory-evolve.test.ts tests/procedural-memory.test.ts tests/evolve-harness.test.ts
```
