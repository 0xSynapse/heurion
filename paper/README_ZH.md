# Heurion 2.0 arXiv 论文中文全文导读与投稿指南

> **英文标题**：**Heurion 2.0: A Contract-Guarded Dual-Surface Architecture with Self-Evolving Memory for Zero-Hallucination Clinical Research**  
> **中文译名**：**Heurion 2.0：面向零幻觉临床研究的契约受控双表面架构与自演进记忆系统**  
> **配套文件**：
> - [`paper/main.tex`](./main.tex)：符合 arXiv AutoTeX 标准、内嵌参考文献（`.bbl`）与 TikZ/PGFPlots 矢量图的完整英文 LaTeX 源码
> - [`paper/heurion2_arxiv.tar.gz`](./heurion2_arxiv.tar.gz)：可直接拖拽上传至 arXiv 的打包源码归档
> - [`paper/ARXIV_SUBMISSION.txt`](./ARXIV_SUBMISSION.txt)：arXiv 网页表单一键复制粘贴元数据（含纯文本格式摘要）
> - [`paper/benchmarks/run_eval.ts`](./benchmarks/run_eval.ts) & [`paper/results/benchmark_results.json`](./results/benchmark_results.json)：100% 真实运行在平台引擎上的实证基准测试脚本与实验结果

---

## 一、 核心摘要（中文对照版）

自主大语言模型（LLM）智能体通过自由 Shell 执行与直接文件操作在软件工程领域取得了显著成功。然而，将这种**“脚本修改 + 事后审计（Script-and-Audit）”**范式直接移植到高风险的临床医学与科学研究场景时，会引发严重的系统性失效：Office Open XML（`.docx`/`.pptx`）稿件在重序列化时发生破坏性的排版漂移、静默覆盖人类合作者的并发修改、编造虚假的文献标识符（DOI/PMID）或缺乏依据的统计结论、泄露受保护的患者健康信息（PHI），以及在跨会话写作中重复触发相同的护栏错误。

本文提出 **Heurion 2.0**——一个建立在**契约受控双表面架构（Contract-Guarded Dual-Surface Architecture）**与**三层自演进记忆系统（Three-Layer Self-Evolving Memory System）**之上的协同临床研究与科学写作平台：
1. **双表面 CRDT 协同核与字节级无损导出**：摒弃让智能体通过临时脚本直接篡改磁盘文件的做法，以具有全生命周期稳定块寻址（`{#id}`）的单一 CRDT 真源（ProseMirror + Yjs）为核心，同步投射出面向人类研究者的富文本/幻灯片画布视图与面向 AI 的紧凑注解 Markdown 视图及受控操作原语。支持在 CRDT 空间内按回合（Per-Turn）精准撤销 AI 修改而不伤及同一段落内的人类并发编辑，并对未改动区域实现 **100% 字节级（Byte-for-Byte）无损 OOXML 导出**。
2. **零幻觉证据闭环**：写前语法守卫从源头拦截任何未登记的裸写 DOI/PMID，强制通过 Crossref/PubMed/OpenAlex 核验并生成原子引用节点 `[@c:id]`；配合多智能体核查管线（`literature_researcher`、`biostatistician`、`fact_checker`），将正文句子与 PubMed 摘要及 PMC 全文进行四分类语义对齐，并将存疑断言锚定为内联批注。
3. **隐私保护的临床研究管线与人机权限同构**：实施租户级物理库隔离与信封加密、双阶段确定性 PHI 扫描脱敏（校验码核验身份证号/卡号/病历号/姓名+敏感诊断）、受试者假名映射（`P001`）、患者原始健康档案（PHR）只读红线，以及经自动化测试形式化验证的**人机权限同构**（$\mathcal{E}_{\text{REST}} = \mathcal{E}_{\text{MCP}} \sqcup \mathcal{E}_{\text{NOT\_FOR\_AI}}$）。
4. **跨领域三层自演进记忆架构**：结合（Layer 1）无副作用的写前干跑探针（`doc_validate` / `dry_run`）、（Layer 2）基于可插拔领域技能适配器（`manuscript` / `biostats` / `deck` / `general_mcp`）的双轨自演进引擎——包含自监督退化-重构技能训练（Track A，配实例-技能解耦与 PHI 隐私守卫）与零人工模板轨迹对比合成及反向归因（Track B，支持 `Routing Miss` 触发词自动扩充、`Rule Insufficiency` 边界强化与跨领域 MoE 门控路由）、以及（Layer 3）后台跨会话元策略蒸馏。

**实证评估表明**：Heurion 2.0 在 50 组临床试验方案修订基准测试中实现了 **100% 未修改块字节级保真**、**100% 并发编辑冲突与未注册引用写前拦截**、**亚毫秒级操作延迟**（写前预检平均 `0.168 ms`，受控写入 `0.351 ms`，按回合选择性回滚 `0.128 ms`）；在在线 `deepseek-flash` 多会话实测中，**零人工模板（Zero-Template）自演进**使总体守卫拦截率降低 **62.5%**、未见过的 Heldout 外部验证队列拦截率降低 **75.0%**（一次通过率从 `33.3%` 提升至 `83.3%`，第 3 会话降至 `0` 拦截），并在医学稿件写作（对齐度 `+155.3%`）、生物统计建模（`0.000 -> 0.612`）与学术演示文稿排版（`+161.5%`）三大领域实现 **100% 目标领域路由命中率**与 **0% 跨领域负迁移/隐私泄漏**。

---

## 二、 章节结构与核心论点导读

### Section 1: Introduction（引言）
- **立论靶子**：剖析为什么通用 Coding Agent（自由 Shell + Python 脚本改文件）在严肃临床科研写作中会失效。
- **第一代系统（Heurion v1 / S-Series）的真实工程复盘**：总结了事后审计（Post-hoc Audit）的三大死结：(1) LibreOffice 重排抹除 `w14:paraId` 导致块定位失效；(2) 全块复述 `expectText` 导致标点/空白符漂移；(3) 事后发现幻觉时污染已落盘，无法在保留人类并发编辑的前提下只回滚 AI 的操作。

### Section 2: System Overview & Design Principles（系统概览与三大形式化不变量）
提出了支撑整篇论文理论高度的 **3 个架构不变量（Architectural Invariants）**：
- **Invariant 1（写前结构安全不变量）**：形式化定义状态转移 $\mathcal{T}(S_r, \mathcal{O}, r_{\text{base}})$，证明任何整块覆写若与人类改动集 $\Delta_{\text{user}}(r_{\text{base}}, r)$ 相交、或含未注册引用，必然在污染 CRDT 前被原子拒绝。
- **Invariant 2（人机权限同构不变量）**：形式化定义 $\mathcal{E}_{\text{REST}} = \phi(\mathcal{E}_{\text{MCP}}) \sqcup \mathcal{E}_{\text{NOT\_FOR\_AI}}$，其中 $\phi$ 为携带当前用户身份与租户上下文的进程内 Loopback 调度器。
- **Invariant 3（声明式与程序性记忆正交不变量）**：主观写作风格偏好 $\mathcal{M}_D$ 必须经人类确认，客观防错执行策略 $\mathcal{M}_P$ 由确定性运行时信号 $\Sigma_{\text{exec}}$ 自动演进，两者互不污染。

### Section 3: Dual-Surface Co-Editing & Byte-Preserving Document Engine（双表面协同与字节无损引擎）
对应代码实现：[`apps/platform/src/model/runtime.ts`](../apps/platform/src/model/runtime.ts)、[`apps/platform/src/ops/service.ts`](../apps/platform/src/ops/service.ts)、[`apps/platform/src/convert/docx-export.ts`](../apps/platform/src/convert/docx-export.ts)
- **双表面投射**：同一棵 Yjs 文档树，向人类暴露 ProseMirror 协同视图，向 AI 暴露带 `{#id}`、`[@c:id]`、`{#c:id}` 的紧凑 Annotated Markdown。
- **最小差分更新**：`replace_text` 在保留段落内所有内联样式、引用节点和批注锚点的前提下，仅更新 `Y.XmlFragment` 变动前缀与后缀之间的子节点。
- **双层按回合撤销（`revertTurn`）**：内存态通过绑定独立 `ServerOrigin` 的 `Y.UndoManager` 实现**同一段落内保留人类并发改动的字符级 AI 撤销**；跨重启态通过 `turn_doc_bases` 与 `revertByNodes` 实现块级安全回退。
- **修补式无损导出**：通过 `node_src` 缓存原包 XML 切片，未修改节点 100% 逐字节原样写回。

### Section 4: Zero-Hallucination Evidence Loop & Privacy-Preserving Clinical Pipeline（零幻觉证据闭环与隐私管线）
对应代码实现：[`apps/platform/src/claims/service.ts`](../apps/platform/src/claims/service.ts)、[`apps/platform/src/ops/phi-scan.ts`](../apps/platform/src/ops/phi-scan.ts)、[`apps/platform/src/subagents/service.ts`](../apps/platform/src/subagents/service.ts)
- **写前引用护栏**：正则阻断任何裸 DOI/PMID，强制走 `insert_citation` 登记为原子节点 `[@c:cite_id]`。
- **多智能体句级事实核查（`verify_claims`）**：结合 PubMed 摘要与 PMC 全文，输出四分类结论（`supported` / `contradicted` / `unsupported` / `uncited_stat`）并支持“临床经验豁免（Clinical Experience Exemption）”。
- **双阶段 PHI 脱敏与生统沙箱**：MOD 11-2 身份证校验、Luhn 卡号校验、姓名+诊断共现脱敏、`P001` 假名反映射、PHR 只读守卫，以及 Table 1 / KM / CONSORT / E-value / Nomogram / MONAI 3D 分割沙箱。

### Section 5: Three-Layer Self-Evolving Agent Architecture（跨领域三层自演进架构）
对应代码实现：[`apps/platform/src/memory/domain-adapters.ts`](../apps/platform/src/memory/domain-adapters.ts)、[`apps/platform/src/memory/skill-trainer.ts`](../apps/platform/src/memory/skill-trainer.ts)、[`apps/platform/src/memory/procedural.ts`](../apps/platform/src/memory/procedural.ts)、[`apps/platform/src/memory/execution-signals.ts`](../apps/platform/src/memory/execution-signals.ts)、[`apps/platform/src/harness/evolve-harness.ts`](../apps/platform/src/harness/evolve-harness.ts)
- **Layer 1（写前探针）**：`doc_validate` 与 `dry_run` 零副作用试跑。
- **Layer 2（跨领域双轨自演进与 MoE 门控重排）**：
  - **Track A（自监督退化-重构技能训练，`SkillTrainingService`）**：基于可插拔领域技能适配器（`manuscript` / `biostats` / `deck` / `general_mcp`），对专家范例执行“前向退化 $\mathcal{C}_d(x_0) \to \tilde{x}$ $\to$ 挂载技能重建 $\hat{x}$ $\to$ 自对比反向归因（`create / update / narrow / merge`）”，并通过实例-技能解耦守卫（`hasInstanceLeakage`）与 PHI 隐私守卫（`sensitiveReason`）拦截具体样本量、精确统计结果或患者隐私。
  - **Track B（零人工模板轨迹对比合成与反向归因，`ProceduralHarnessService`）**：彻底移除手写错误模板字典（`LEARNED_RULE_TEMPLATES`），直接从验证器诊断 `hint` 与同轮恢复轨迹（$a_{\text{fail}} \to a_{\text{recover}}$）合成规则；当错误复发时，根据激活快照 $R_{\text{active}}$ 自动区分 **Routing Miss（$r^* \notin R_{\text{active}}$，剥离队列实例名后扩充 `trigger_pattern`）** 与 **Rule Insufficiency（$r^* \in R_{\text{active}}$，执行 `strengthen / narrow` 边界强化）**，并通过领域门控 MoE 评分公式 $U(r \mid d, q)$ 实现跨领域零负迁移注入。
- **Layer 3（元策略无感演进）**：后台聚合跨会话高频失败信号，自动生成 `evolved.cordis.yml` 动态 Profile 补丁。

### Section 6 & 7: Human-AI Permission Symmetry & Empirical Evaluation（权限同构与实证实验）
所有实验数据均由 `paper/benchmarks/run_eval.ts`、`paper/benchmarks/v2/exp3-zero-template-pilot.ts` 与 `paper/benchmarks/v2/cross-domain-eval.ts` 真实测得：
- **Table 1（v1 vs. v2 架构对比）**：50 组临床方案修订实验，未修改块字节保真率 **100.0%**，并发冲突拦截率 **100.0%**，段落内选择性回滚保留人类编辑准确率 **100.0%**，写前预检平均延迟 **0.168 ms**，受控编辑提交延迟 **0.351 ms**，选择性回滚延迟 **0.128 ms**。
- **Table 2（写前护栏与 PHI 脱敏准确率）**：50 组未注册引用阻断率 **100.0%**，40 组复合 PHI 实体召回率 **100.0%**，40 组密集生统文本误报率 **0.0%**。
- **Figure 2（三层自演进消融曲线）**：在 420 字符/轮的严格上下文预算下，对比无记忆基线（每轮恒定 6 次失败）、无排序 FIFO 记忆（因预算饱和卡在 4 次失败）与 Heurion 2.0（在第 2 会话末自动结晶新规则后，从第 3 会话起失败数降至 **0**，平均每轮仅消耗 **355 字符**）。
- **Table 3（在线 `deepseek-flash` 零模板多会话程序性演进，72 回合）**：在 0 条人工模板下，`utility` 组将平均每轮拦截率从 `frozen` 组的 `0.667` 降至 **`0.250`（降低 62.5%）**，跨会话演进曲线为 `0.667 -> 0.167 -> 0.000 -> 0.167`，在未见过的 Heldout 外部验证队列上拦截率降低 **75.0%**（一次通过率从 `33.3%` 跃升至 **`83.3%`**）。
- **Table 4（在线 `deepseek-flash` 跨领域退化-重构技能训练与 MoE 路由）**：单轮自监督退化-重构使 `manuscript` 规范对齐分提升 **+155.3%**（`0.150 -> 0.383`）、`biostats` 从 `0.000` 跃升至 **`0.612`**、`deck` 提升 **+161.5%**（`0.187 -> 0.489`），实例数值与 PHI 泄漏率均为 **0.0%**；反向归因将隐式指令路由召回率从 `0.000` 恢复至 **`1.000`**，多领域混合会话目标命中率 **100.0%**、跨领域污染率 **0.0%**。
- **Table 5（系统全面性验证）**：74 个测试套件 / 613 个测试用例 100% 通过，REST/MCP 接口同构审计 0 遗漏。

---

## 三、 如何修改作者信息并上传 arXiv？

1. **修改作者署名**：
   打开 [`paper/main.tex`](./main.tex) 第 47~50 行，将 `\author{...}` 替换为你和合作者的真实姓名、单位（Affiliation）与机构邮箱，然后运行以下命令重新打包 `.tar.gz`：
   ```bash
   tar -czf paper/heurion2_arxiv.tar.gz -C paper main.tex
   ```
2. **上传至 arXiv**：
   - 登录 [arxiv.org](https://arxiv.org/) -> **Start New Submission**。
   - 在 **Upload Files** 页面直接上传 `paper/heurion2_arxiv.tar.gz`，点击 **Process Files**（arXiv 的 AutoTeX 会自动编译 `main.tex` 并生成 PDF 预览）。
   - 在 **Metadata** 页面打开 [`paper/ARXIV_SUBMISSION.txt`](./ARXIV_SUBMISSION.txt)，直接复制粘贴其中的 **Title** 与 **Abstract** 即可。
