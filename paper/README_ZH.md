# Heurion 2.0 arXiv 论文中文全文导读与投稿指南

> **英文标题**：**Heurion 2.0: A Contract-Guarded Dual-Surface Architecture with Self-Evolving Memory for Citation-Grounded Clinical Research Authoring**  
> **中文译名**：**Heurion 2.0：面向引用可溯源临床研究写作的契约受控双表面架构与自演进记忆系统**  
> **配套文件**：
> - [`paper/main.tex`](./main.tex)：符合 arXiv AutoTeX 标准、内嵌参考文献（`.bbl`）与 TikZ/PGFPlots 矢量图的完整英文 LaTeX 源码
> - [`paper/heurion2_arxiv.tar.gz`](./heurion2_arxiv.tar.gz)：可直接拖拽上传至 arXiv 的打包源码归档
> - [`paper/ARXIV_SUBMISSION.txt`](./ARXIV_SUBMISSION.txt)：arXiv 网页表单一键复制粘贴元数据（含纯文本格式摘要）
> - [`paper/benchmarks/run_eval.ts`](./benchmarks/run_eval.ts) & [`paper/results/benchmark_results.json`](./results/benchmark_results.json)：在平台引擎上进程内运行的基准测试脚本与实验结果

---

## 一、 核心摘要（中文对照版）

自主大语言模型（LLM）智能体通过自由 Shell 执行与直接文件操作在软件工程领域取得了显著成功。然而，将这种**“脚本修改 + 事后审计（Script-and-Audit）”**范式直接移植到高风险的临床医学与科学研究场景时，会引发严重的系统性失效：Office Open XML（`.docx`/`.pptx`）稿件在重序列化时发生破坏性的排版漂移、静默覆盖人类合作者的并发修改、编造虚假的文献标识符（DOI/PMID）或缺乏依据的统计结论、泄露受保护的患者健康信息（PHI），以及在跨会话写作中重复触发相同的护栏错误。

本文提出 **Heurion 2.0**——一个建立在**契约受控双表面架构（Contract-Guarded Dual-Surface Architecture）**与**三层自演进记忆系统（Three-Layer Self-Evolving Memory System）**之上的协同临床研究与科学写作平台：
1. **双表面 CRDT 协同核与字节级无损导出**：摒弃让智能体通过临时脚本直接篡改磁盘文件的做法，以具有全生命周期稳定块寻址（`{#id}`）的单一 CRDT 真源（ProseMirror + Yjs）为核心，同步投射出面向人类研究者的富文本/幻灯片画布视图与面向 AI 的紧凑注解 Markdown 视图及受控操作原语。支持在 CRDT 空间内按回合（Per-Turn）精准撤销 AI 修改而不伤及同一段落内的人类并发编辑，并对未改动区域按原始 XML 切片原样导出（修补式 OOXML 导出）。
2. **引用可溯源的证据闭环**：写前语法守卫从源头拦截任何未登记的裸写 DOI/PMID，强制通过 Crossref/PubMed/OpenAlex 核验并生成原子引用节点 `[@c:id]`；配合多智能体核查管线（`literature_researcher`、`biostatistician`、`fact_checker`），将正文句子与 PubMed 摘要及 PMC 全文进行四分类语义对齐，并将存疑断言锚定为内联批注。
3. **隐私保护的临床研究管线与人机权限同构**：实施租户级物理库隔离与信封加密、双阶段确定性 PHI 扫描脱敏（校验码核验身份证号/卡号/病历号/姓名+敏感诊断）、受试者假名映射（`P001`）、患者原始健康档案（PHR）只读红线，以及由 CI 自动化测试强制检查的**人机权限同构**（$\mathcal{E}_{\text{REST}} = \phi(\mathcal{E}_{\text{MCP}}) \sqcup \mathcal{E}_{\text{NOT\_FOR\_AI}}$）。
4. **三层自演进记忆架构**：结合（Layer 1）无副作用的写前干跑探针（`doc_validate` / `dry_run`）、（Layer 2）物理隔离人类确认的声明式偏好与从运行时拦截/回滚信号自动结晶的程序性防错策略（按效用密度实时重排注入）、以及（Layer 3）后台跨会话元策略蒸馏。

**实证评估表明**：在基于同一份合成方案模板的 50 次试验中，导出时被检查的未改动块均原样保留，测试集中的陈旧整块覆写与未注册引用均在写前被拦截，且操作延迟为亚毫秒级（写前预检平均 `0.168 ms`，受控写入 `0.351 ms`，按回合选择性回滚 `0.128 ms`），并在 3 个连续写作会话内将新型护栏触发错误收敛至 **0**。

---

## 二、 章节结构与核心论点导读

### Section 1: Introduction（引言）
- **立论靶子**：剖析为什么通用 Coding Agent（自由 Shell + Python 脚本改文件）在严肃临床科研写作中会失效。
- **第一代系统（Heurion v1 / S-Series）的真实工程复盘**：明确指出 v1“脚本修改 + 事后审计”范式的三大致命缺陷：(1) **AI 编辑直接搞乱文档结构**（脚本重序列化抹除期刊模板的段落/字体属性 `<w:pPr>`/`<w:rPr>`、破坏列表编号链与复杂表格、弄丢批注锚点与 `w14:paraId`）；(2) **静默覆盖人工编辑内容**（基于文件快照或整段重写会直接抹掉医生在同一段落插入的临床补充或并发修改，事后三路合并极易出错）；(3) **事后审计无法挽救破坏性的写入接口**（审计发生时结构损毁与人工内容丢失已成定局，只能粗暴整文件回滚）。

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
- **修补式无损导出**：通过 `node_src` 缓存原包 XML 切片，未修改节点按原始 XML 切片原样写回。

### Section 4: Citation-Grounded Evidence Loop & Privacy-Preserving Clinical Pipeline（引用可溯源证据闭环与隐私管线）
对应代码实现：[`apps/platform/src/claims/service.ts`](../apps/platform/src/claims/service.ts)、[`apps/platform/src/ops/phi-scan.ts`](../apps/platform/src/ops/phi-scan.ts)、[`apps/platform/src/subagents/service.ts`](../apps/platform/src/subagents/service.ts)
- **写前引用护栏**：正则阻断任何裸 DOI/PMID，强制走 `insert_citation` 登记为原子节点 `[@c:cite_id]`。
- **多智能体句级事实核查（`verify_claims`）**：结合 PubMed 摘要与 PMC 全文，输出四分类结论（`supported` / `contradicted` / `unsupported` / `uncited_stat`）并支持“临床经验豁免（Clinical Experience Exemption）”。
- **双阶段 PHI 脱敏与生统沙箱**：MOD 11-2 身份证校验、Luhn 卡号校验、姓名+诊断共现脱敏、`P001` 假名反映射、PHR 只读守卫，以及 Table 1 / KM / CONSORT / E-value / Nomogram / MONAI 3D 分割沙箱。

### Section 5: Three-Layer Self-Evolving Agent Architecture（三层自演进架构）
对应代码实现：[`apps/platform/src/memory/procedural.ts`](../apps/platform/src/memory/procedural.ts)、[`apps/platform/src/memory/execution-signals.ts`](../apps/platform/src/memory/execution-signals.ts)、[`apps/platform/src/harness/evolve-harness.ts`](../apps/platform/src/harness/evolve-harness.ts)
- **Layer 1（写前探针）**：`doc_validate` 与 `dry_run` 零副作用试跑。
- **Layer 2（双轨记忆与效用感知重排）**：给出效用评分公式 $U(r \mid d, q)$（综合历史证据数 $e_r$、任务触发词匹配、当前文档是否有近期人类并发编辑、以及临床统计/文献子领域匹配），在严苛 Token 预算下精准注入最高价值的最多 4 条规则。
- **Layer 3（元策略无感演进）**：后台聚合跨会话高频失败信号，自动生成 `evolved.cordis.yml` 动态 Profile 补丁。

### Section 6 & 7: Human-AI Permission Symmetry & Empirical Evaluation（权限同构与实证实验）
所有实验数据均由 `npx tsx ../../paper/benchmarks/run_eval.ts` 真实测得：
- **Table 1（三种架构的机制对比）**：只做定性对比，不含实测数值（v1 与脚本 agent 均未重新跑过）。
- **Table 2（Heurion 2.0 双表面引擎实测）**：同一份六块合成方案模板，50 次试验。被检查的未改动块（标题与末段）原样导出 50/50，陈旧整块覆写被拦截 50/50，段落内选择性回滚保留人类编辑 50/50；写前预检平均延迟 **0.168 ms**，受控编辑 **0.351 ms**，按回合回滚 **0.128 ms**。
- **Table 3（写前护栏与 PHI 扫描）**：作者手写的小测试集，按去重后计数：5 条裸引用句（共 50 次提交）全部被拦截；4 条 PHI 句（共 40 次扫描）全部被检出；4 条干净生统句（共 40 次扫描）无误报。引用守卫和冲突守卫没有测负样本。
- **Figure 2（三层自演进消融曲线）**：在 420 字符/轮的严格上下文预算下，对比无记忆基线（每轮恒定 6 次失败）、无排序 FIFO 记忆（因预算饱和卡在 4 次失败）与 Heurion 2.0（在第 2 会话末自动结晶新规则后，从第 3 会话起失败数降至 **0**，平均每轮仅消耗 **355 字符**）。
- **Table 4（系统全面性验证）**：commit `813fff29` 时 72 个测试文件 / 592 个测试用例全部通过，REST/MCP 接口同构审计 0 遗漏。

---

## 三、 如何修改作者信息并上传 arXiv？

1. **作者署名**：
   作者顺序为 Hui Zhao（一作）、钱医生（末位），两人均为通讯作者，钱东为第一通讯作者（通讯作者一行先列钱东）。Hui Zhao（Heurion，huizhao@heurion.org），中科大合作者（University of Science and Technology of China，qiandong@ustc.edu.cn）。钱东医生（中国科大附属第一医院放射肿瘤科）的英文署名按其近年论文习惯写作 Dong Qian。改完后重新打包（会剥离注释并追加 arXiv 编译指令，不要手工 `tar`）：
   ```bash
   cd apps/platform && npx tsx ../../paper/scripts/prepare_arxiv_tar.ts
   ```
2. **上传至 arXiv**：
   - 登录 [arxiv.org](https://arxiv.org/) -> **Start New Submission**。
   - 在 **Upload Files** 页面直接上传 `paper/heurion2_arxiv.tar.gz`，点击 **Process Files**（arXiv 的 AutoTeX 会自动编译 `main.tex` 并生成 PDF 预览）。
   - 在 **Metadata** 页面打开 [`paper/ARXIV_SUBMISSION.txt`](./ARXIV_SUBMISSION.txt)，直接复制粘贴其中的 **Title** 与 **Abstract** 即可。
