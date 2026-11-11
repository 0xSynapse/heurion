# 自演进四阶段临床深度审稿（Heurion Deep Review）顶会顶刊版导读与全量复现指南

> **英文标题**：**Self-Evolving Clinical Deep Review: Eliminating Recurring Methodological False Alarms without Compromising Objective Error Recall via Comment-Driven Dual-Track Memory**  
> **中文译名**：**自演进四阶段临床深度审稿：基于批注驱动双轨记忆在不牺牲客观错误召回率的前提下消除重复方法学误报**  
> **作者署名**：**Hui Zhao**$^{1,*}$, **Dong Qian**$^{2,3}$ (中国科学技术大学附属第一医院肿瘤放疗科 / 荷兰 Erasmus MC Cancer Institute), **Heurion Research Team**$^{1}$  
> **在线评测总规模**：**15,682 次真实在线大模型 API 调用**（累计 **46.06M 输入 token**、**4.25M 输出 token**，横跨 `deepseek-v4-flash`、`deepseek-chat` [DeepSeek-V3] 与 `deepseek-reasoner` [DeepSeek-R1 64k CoT] 三代异构基座）  
> **配套交付件**：
> - [`paper-deep-review/main.tex`](./main.tex) & [`paper-deep-review/main.pdf`](./main.pdf)：按 NeurIPS/ICLR Oral 与 *Nature Medicine* / *Lancet Digital Health* / *JAMIA* 双重顶会顶刊标准重构的 16 页英文手稿（含 7 节规范结构、7 张统计对照表、4 张 TikZ/PGFPlots 矢量图、Algorithm 1 伪代码、22 篇核实参考文献，0 编译警告、0 Overfull hbox）
> - [`paper-deep-review/ARXIV_SUBMISSION.txt`](./ARXIV_SUBMISSION.txt)、[`paper-deep-review/ax.tar`](./ax.tar) & [`paper-deep-review/heurion_deep_review_arxiv.tar.gz`](./heurion_deep_review_arxiv.tar.gz)：符合 arXiv AutoTeX 规范的提交元数据（摘要 1,857 字符 / 249 词，严格 `< 1,920` 字符与 `< 250` 词限制）与平铺无注释源码包
> - 四套独立可复现基准脚本与在线实测结果 JSON：
>   1. [`benchmarks/run-injected-review-evolution.ts`](./benchmarks/run-injected-review-evolution.ts) $\to$ [`results/injected_deep_review_evolution.json`](./results/injected_deep_review_evolution.json)（Clean-Room AST 基线与同稿/跨稿基础演化流水线）
>   2. [`benchmarks/run-ablation-and-kfold.mts`](./benchmarks/run-ablation-and-kfold.mts) $\to$ [`results/ablation_and_kfold.json`](./results/ablation_and_kfold.json)（正交架构消融、$2\times 2$ 记忆解耦、5 折分层交叉验证与 5 种随机顺序收敛曲线，9,232 次调用）
>   3. [`benchmarks/run-frontier-and-crossjudge.mts`](./benchmarks/run-frontier-and-crossjudge.mts) $\to$ [`results/frontier_and_crossjudge.json`](./results/frontier_and_crossjudge.json)（DeepSeek-R1 64k CoT / DeepSeek-V3 全文单通对比、跨基座泛化与三范式双盲临床评审员 Fleiss' $\kappa$ 一致性评测，3,070 次调用）
>   4. [`benchmarks/run-safety-passa-trackb.mts`](./benchmarks/run-safety-passa-trackb.mts) $\to$ [`results/safety_passa_trackb.json`](./results/safety_passa_trackb.json)（混合全栈对抗反驳红队压力测试、Pass A PMC `<table-wrap>` 外部文献引证核查与 Track B 写前程序性防错闭环，3,380 次调用）

---

## 一、 Master 红队审计发现与核心架构升级（Clean-Room 科学诚信保障）

1. **候选级选择性 Stage-4 记忆路由（Candidate-Scoped Selective Stage-4 Routing，[`service.ts`](../apps/platform/src/claims/service.ts)）**：
   - **红队发现**：若将 Track A 蒸馏出的边界豁免规则全局无差别塞入 Stage 3 章节审稿 System Prompt（Legacy Global Stuffing），累积规则会导致大模型检测阈值整体向保守偏移，在 5 折分层交叉验证（OOF CV）中使未见错误召回率显著下降 `-12.3 pp`（`87.7% -> 75.4%`，McNemar $p=0.0156$）。
   - **架构根治**：Stage 3 彻底移除全局豁免规则（仅保留纯增量核查清单），改为在 Stage 4 仅针对通过 $\mathcal{F}_{\text{hard}}$ 硬核防火墙、且类别（`:cat=`）与专科方法学词元（`:kw=`）精确匹配的特定候选意见按需挂载（最多 Top-2 条），同时永久拦截 `rounding_and_percentage` 四舍五入借口规则跨篇传播。升级后 5 折 OOF 纯 Track A 召回率恢复至 `82.5%`（与冷启动无统计学差异 $p=0.375$），冻结测试集 `test` 召回升至 **83.3% (20/24)**，全量 19 篇演化总召回达 **89.5% (51/57)**。
2. **五重通用不变量混合安全底线 $\mathcal{F}_{\text{hard}}$（[`extract.ts`](../apps/platform/src/claims/extract.ts)）**：
   - **红队发现**：混合模式下 Stage 3 大模型产出的审稿意见无静态 `subtype`（`subtype = null`），在全量对抗反驳攻击下曾出现 23 条真实客观错误被写入同稿 `rev_exempt_<hash>` 豁免记录，导致同稿 R2 召回跌至 `71.9%`（`test` 跌至 `62.5%`）。
   - **架构根治**：在 `isHardObjectiveReviewFinding` 中引入零语料特异词的五重通用数学/生物统计不变量（CI 几何包含检验、显式多项加减算术不等式、$p \ge 0.05$ 阳性 Spin 冲突、参数/非参数假设检验硬错配、同分析集跨章节同 CI 数值冲突），将真实客观错误上的虚假同稿豁免记录从 **`23` 条清零至 `0` 条（64/64 = 100.0% 拦截）**。
3. **双重数字与专科病种/术式括号举例脱敏器（[`scrubSpecialtyExampleLeakage`](../apps/platform/src/claims/service.ts)）**：
   - 封堵大模型在规则括号举例中夹带特定病种或术式名（如“妊娠期高血压”、“局部皮瓣修复”、“皮肤移植”）的跨专科泄漏漏洞，所有基准套件共 `>90` 条在线蒸馏规则与核查清单实现 **0.0% 数字与病种/术式泄漏**。
4. **双轨精确率透明汇报（Conservative $\text{Prec}_{\text{inj}}$ + Adjudicated $\text{Prec}_{\text{org}}$）**：
   - 所有主表同步汇报保守下界精确率 $\text{Prec}_{\text{inj}} = \text{TP}_{\text{inj}} / (\text{TP}_{\text{inj}} + \text{FP})$（剔除原文自带真错加分）与含核定原文发表真错精确率 $\text{Prec}_{\text{org}}$，并提供 Wilson 95% CI、双侧精确 McNemar 检验与 $2^{19}=524,288$ 篇级配对置换检验 $p$ 值。

---

## 二、 核心实验结果总览

### 1. 主基准、前沿推理模型（DeepSeek-R1 / V3）对比与正交架构消融（19 篇 2025 PMC 全文，57 处植入错误）

| 审稿管线与基座模型 | 总召回率 [95% CI] | E7 表格算术 | 原文真错 (`Clean`) | 总误报 (`Clean/Inj`) | $\text{Prec}_{\text{inj}}$ / $\text{Prec}_{\text{org}}$ | $\text{F1}_{\text{inj}}$ / $\text{F1}_{\text{org}}$ | 输出 Token / 关键统计显著性 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `pat_baseline` (`v4-flash` 纯文本四阶段) | 52.6% (30/57) `[39.9, 65.0]` | 12.5% | 29 | 1,094 (568/526) | 3.2% / 5.7% | 6.0% / 10.3% | 557.8k（重度误报疲劳） |
| Full-Context `deepseek-chat` (V3 + 全量二维表) | 73.7% (42/57) `[61.0, 83.4]` | 37.5% | 34 | 104 (68/36) | 28.8% / 46.7% | 41.4% / 57.2% | 59.7k（单通漏检 62.5% E7） |
| Full-Context `deepseek-reasoner` (R1 64k CoT) | **94.7% (54/57)** `[85.6, 98.2]` | **100.0%** | 28 | 80 (44/36) | 40.3% / 57.9% | 56.5% / **71.9%** | **1,389.9k**（耗时 `~183 s`/篇） |
| **Clean-Room AST Only（零 LLM 确定性核查）** | 66.7% (38/57) `[53.7, 77.5]` | 87.5% | **7** | **7 (4/3)** | **84.8% / 88.3%** | **74.7% / 76.0%** | **0**（0.21 重度干净 FP/篇） |
| **Heurion Deep (`deepseek-chat` V3 同基座)** | 86.0% (49/57) `[74.7, 92.7]` | **100.0%** | 26 | **73 (41/32)** | **47.5% / 60.5%** | **61.2% / 71.0%** | **96.8k**（vs B2: $\text{Prec}_{\text{inj}}$ `+18.7 pp` $p=0.0026$；Token 仅 R1 的 `1/14.4`） |
| **Heurion Deep (`v4-flash` 冷启动全栈)** | 87.7% (50/57) `[76.8, 93.9]` | 87.5% | **28** | 82 (45/37) | 45.0% / 59.0% | 59.5% / 70.5% | 100.1k（vs PAT: FP `-92.5%` $p<10^{-5}$） |
| $\quad-$ 移除结构化 AST (`Pass B/C/D`) | 54.4% (31/57) `[41.6, 66.6]` | 37.5% | 22 | 68 (37/31) | 34.0% / 50.0% | 41.8% / 52.1% | 召回暴跌 **-33.3 pp** ($p=2.1\times 10^{-5}$) |
| $\quad-$ 移除二维表格网格 (`TableGrid`) | 68.4% (39/57) `[55.5, 79.0]` | 12.5% | 20 | 78 (40/38) | 36.1% / 49.4% | 47.2% / 57.4% | 召回下降 **-19.3 pp** ($p=0.0034$) |
| $\quad-$ 移除 Stage 4 全文复核器 | 84.2% (48/57) `[72.6, 91.5]` | 87.5% | 32 | **176 (97/79)** | 26.7% / 40.1% | 40.6% / 54.3% | **误报暴增 +114.6%** ($p=3.1\times 10^{-5}$) |
| **Heurion Evolved（选择性 Stage-4 路由，All 19）** | **89.5% (51/57)** `[78.9, 95.1]` | 87.5% | 25 | 78 (45/33) | **46.9% / 59.6%** | **61.5% / 71.6%** | **零泄漏（0.0%）**，召回与 F1 双升 |

### 2. $2\times 2$ 记忆解耦与 5 折分层交叉验证（Selective Stage-4 Routing vs. Legacy Global Stuffing）

- **冻结未见 `test` 集（$N=8$，24 处错误）$2\times 2$ 正交消融**：
  - `Cold-Start`：`19/24 (79.2%)`，总 FP `37 (19/18)`
  - `Legacy Unfiltered Global Prompt`（旧版全局注入）：召回跌至 `17/24 (70.8%, -8.3 pp)`
  - **`Track A Only (Selective Stage 4, 0% Oracle)`**：**`19/24 (79.2%，零召回损失)`**，干净稿误报下降 **-21.1%**（`19 -> 15`）
  - **`Checklists Only (Dev Misses)`**：**`20/24 (83.3%, +4.2 pp)`**，总 FP `31 (18/13)`
  - **`Full Evolved (Selective Stage 4)`**：**`20/24 (83.3%，较全局注入 +12.5 pp)`**，总 FP `32 (16/16)`，$\text{F1}_{\text{org}} = 66.7\%$
- **全语料 5 折分层交叉验证（Out-of-Fold $N=19$，57 处未见错误）**：
  - `OOF Cold-Start`：`50/57 (87.7%)`，FP `82 (45/37)`
  - `OOF Legacy Global Track A`：`43/57 (75.4%)`，显著召回坍塌 `-12.3 pp`（McNemar $p=0.0156$，置换 $p=0.0313$）
  - **`OOF Selective Stage-4 Track A (0% Oracle)`**：恢复至 **`47/57 (82.5%，较全局注入 +7.0 pp)`**，与冷启动无显著差异（$p=0.375$），干净 FP 降至 `37 (-17.8%)`
- **5 种随机论文顺序置换收敛实验**：平均 `36.0 ± 0.0` 次反驳触发严格次线性收敛至 **`5.00 ± 0.00`** 个规范方法学边界家族（终点标准差 `SD = 0.00`，完全顺序无关）。

### 3. 三范式双盲临床评审员一致性、全栈对抗安全、Pass A 表格引证与 Track B 写前守卫

- **三范式双盲临床评审员一致性（$n=191$ 条初审发现：114 处真错，77 处误报）**：
  - `deepseek-v4-flash` 真错采纳率 `92.1%` / 误报反驳率 `36.4%`；`deepseek-chat` (V3) `93.0%` / `35.1%`（双模型 Cohen's $\kappa = \mathbf{0.932}$，一致率 `97.9%`）；独立推理范式 `deepseek-reasoner` (R1) 真错采纳率达 **`97.4% (111/114)`**（假反驳率仅 `2.6%`），三模型联合假反驳率为 **`0.0% (0/114)`**，整体 **Fleiss' $\kappa = \mathbf{0.642}$**（`95% CI [0.530, 0.754]`，$p < 10^{-14}$）。
- **混合全栈对抗反驳安全验证（$N=19$，对全部 120 条告警逐一发起方法学诡辩反驳）**：
  - 加固五重不变量 $\mathcal{F}_{\text{hard}}$ 后，真实客观错误上的虚假同稿豁免记录从 **`23` 条降至 `0` 条（64/64 = 100.0% 拦截）**，同稿 R2 召回从 `71.9%` 恢复至 **`82.5%`**（`test` 从 `62.5%` 恢复至 **`79.2%`**），同时合法拦截 61.5% 干净误报（`52 -> 20`，$\text{F1}_{\text{org}} = \mathbf{74.1\%}$）。
- **Pass A 外部文献 PMC `<table-wrap>` 引证核查基准（$N=36$ 条配对临床引证，横跨 12 篇 PMC XML）**：
  - 总体三分类准确率从仅用摘要的 **`52.8% (19/36)` 跃升至 `94.4% (34/36)`**（McNemar $p=2.75\times 10^{-4}$）；纯表格支撑引证忠实验证率从 **`0.0% (0/12)` 提升至 `91.7% (11/12)`**（$p=9.77\times 10^{-4}$）；数值篡改检出率从 **`66.7% (8/12)` 升至 `100.0% (12/12)`**。
- **Track B 写前程序性防错闭环基准（$N=24$ 项未见测试集临床改写任务，0 测试集信号）**：
  - 挂载仅由 `dev` 采纳轨迹固化的 3 条零数字写前守卫规则后，一次成稿零缺陷率从 **`58.3% (14/24)` 提升至 `87.5% (21/24)`**（`+29.2 pp`，精确双侧 McNemar $b=7, c=0, p=0.0156$，**0 例退化**），总残余客观错误数减少 **-73.3%**（`15 -> 4`）。

---

## 三、 一键复现与构建命令

```bash
# 1. 运行核心单元测试（含候选级选择性路由、五重不变量安全底线、病种举例脱敏、CI 几何与锚定，70 项测试）
cd apps/platform && ./node_modules/.bin/vitest run \
  src/claims/claims-pat.test.ts tests/review-evidence.test.ts tests/ci-check.test.ts \
  tests/memory-evolve.test.ts tests/deep-review-anchor.test.ts tests/claim-actions.test.ts \
  tests/procedural-memory.test.ts && cd ../..

# 2. 运行零 LLM Clean-Room AST 基准测试（无需 API Key，约 11 秒）
./apps/platform/node_modules/.bin/tsx paper-deep-review/benchmarks/run-injected-review-evolution.ts --no-llm

# 3. 运行四套在线大模型实测基准套件（需环境变量配置 DEEPSEEK_API_KEY）
./apps/platform/node_modules/.bin/tsx paper-deep-review/benchmarks/run-injected-review-evolution.ts --llm
./apps/platform/node_modules/.bin/tsx paper-deep-review/benchmarks/run-ablation-and-kfold.mts
./apps/platform/node_modules/.bin/tsx paper-deep-review/benchmarks/run-frontier-and-crossjudge.mts
./apps/platform/node_modules/.bin/tsx paper-deep-review/benchmarks/run-safety-passa-trackb.mts

# 4. 编译 16 页论文 PDF 并生成 arXiv AutoTeX 提交压缩包
cd paper-deep-review && ~/.local/bin/tectonic main.tex && cd ..
./apps/platform/node_modules/.bin/tsx paper-deep-review/scripts/prepare_arxiv_tar.ts
```
