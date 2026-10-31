# 自演进记忆论文 → Heurion 落地对照

本文评估 2026 年几篇「自演进记忆 / 可验证技能」方向的论文，指出哪些机制可以落到 Heurion 2.0 的三层自演进记忆架构里、落在哪些文件、改动量多大、优先级如何。

**文档定位**：这是选型与实施建议，不是论文阅读笔记。对每篇论文只保留与 Heurion 代码直接相关的机制，其余部分不展开。

**核查范围**：论文结论基于 arXiv / ACL Anthology 的摘要页；代码结论基于仓库当前 HEAD（`6f310b37`），行号可能随改动漂移，引用时请以符号名为准。

---

## 1. 结论速览

| 论文 | 可借的机制 | 落点 | 优先级 |
|---|---|---|---|
| [CoEM](#31-coem--规则准入的证据门控p0) | pending → commit → discard 的证据门控 | `harness_rules` 状态机 | **P0** |
| [SafeVantage](#32-safevantage--把不知道变成一等公民p0p1) | support / coverage 分离 + Abstain | `forPrompt()` 与 `ClaimsService` | **P0/P1** |
| [Skill-V](#33-skill-v--规则版本化与非退化回放p2) | 版本化 contract + 非退化回放 | 规则更新路径 | P2 |
| [MSCE](#34-msce--只借可靠性与证据指针p2) | reliability 估计 + 证据指针 | `harness_rules` schema | P2 |
| [MemSkill](#35-memskill--hard-case-队列p3) | designer 只看 hard case | Track B 信号筛选 | P3 |
| [MemTransfer](#36-memtransfer--只用于评测协议论文侧) | 单轴 mismatch 评测协议 | `paper/benchmarks/v2/` | 论文侧 |
| [A-MEM](#37-a-mem--不建议) | Zettelkasten 链接 | — | 不建议 |
| [K-Risk](#38-k-risk--不适用) | 自动驾驶长尾场景 | — | 不适用 |

一句话版本：**只有 CoEM 和 SafeVantage 值得马上做，Skill-V 值得排进下一个迭代，其余要么只服务论文，要么和产品无关。**

---

## 2. 代码现状（已核对）

| 位置 | 现状 | 问题 |
|---|---|---|
| `apps/platform/src/store/db.ts:719` | `harness_rules` 表：`id / scope / owner / project_id / category / trigger_pattern / rule / evidence_count / status / created_at / updated_at` | 无证据指针、无成功/失败计数、无版本历史 |
| `apps/platform/src/store/db.ts:356` | `status: 'active' \| 'archived'` | 没有 `pending`，新规则直接生效 |
| `apps/platform/src/memory/procedural.ts:382,414` | 从执行信号沉淀的新规则直接 `status: 'active'` | 偶发失败会被固化成永久规则 |
| `apps/platform/src/memory/procedural.ts:630` | `score()`：`0.1×evidence + 5×msg + 8×state + 领域门控` | 只能表达「多相关」，无法表达「多不确定」 |
| `apps/platform/src/memory/procedural.ts:105` | `CUES`：错误码 → `{ msg: RegExp, state: (s, m) => boolean }` | 可执行的适用性谓词，但硬编码在 TS 常量里，不是规则数据 |
| `apps/platform/src/memory/procedural.ts:671` | `[pred:xxx]` 触发段 + `EnvironmentCueContext.predicates` | 已有数据驱动的谓词通道，但只用于反向归因动态扩充 |
| `apps/platform/src/store/db.ts:475` | `ClaimVerdict = 'supported' \| 'unsupported' \| 'unclear' \| 'missing_citation' \| 'exempted'` | 不区分证据层级（摘要 / 全文 / 表格） |
| `apps/platform/src/memory/service.ts:13` | 记忆种类只有 `preference / fact / style / term` | 没有过程性知识，全部落在 `harness_rules` |

一个贯穿全文的观察：**声明式记忆（用户主观偏好）已有人工准入审批（`memories` 的 `proposed → active` 与 `memory_changes` 的 `pending → applied`，用户不批不生效），但程序性规则（底层工具/AST 的客观操作契约）却缺少对等的运行时验证器准入（Verifier-in-the-loop Gate）**——新规则一生成即 `active`。补齐「主观偏好由人审批准入、客观规程由验证器证据门控准入」的双轨准入对称性，是下面 P0 的直接依据。

---

## 3. 逐篇评估

### 3.1 CoEM —— 规则准入的证据门控（P0）

**论文**：[CoEM: Empowering Long-Context Reasoning with Commit-on-Evidence Memory](https://arxiv.org/abs/2609.36935)（arXiv:2609.36935）

**核心机制**：在固定上下文预算下，不立刻压缩证据，而是把可能有用但相关性未明的原文留在 *pending set*；新上下文到达后，由一个学习到的策略决定 `promote / retain / discard`；只有被冻结 verifier 判定为有保留证据支持的事实才允许提交。

**为什么适用**：这和 Heurion 的 Track B 是同一个问题——什么时候有资格把一次执行经验固化成长期规则。现在的答案是「同一错误码出现 ≥2 次」，这个阈值既不区分「单回合内连续死循环重试」与「跨回合独立复现」，也没有验证是否真正恢复成功，更没有撤销路径。

**现状差距**：

- 无 `pending` 态，规则一生成即生效
- `evidence_count` 只增不减，无法表达「这条规则后来被证伪」
- 规则不记录它由哪些 `execution_signals` 支持

**建议改动**：

1. `status` 扩为 `'pending' | 'active' | 'archived'`；系统内置的 5 条 `BASELINE_RULES` 迁移时强制保持 `active`
2. 新增 `evidence_refs TEXT NOT NULL DEFAULT '[]'`，存 `execution_signals.id` 数组
3. 新规则先进 `pending`，不参与 `forPrompt()` 注入（现有 `listHarnessRules(owner, ['active'])` 天然隔离）；但 `evolveFromSignals()` 需同时查询 `['active', 'pending']`，将新消费信号的 `id` 累入已有 `pending` 规则的 `evidence_refs`，避免因信号被 `consumeExecutionSignals()` 提前消费而死锁或重复创建 `pending` 规则
4. **晋升条件（零 LLM 成本的确定性 Verifier 门控）**：由于医生常在同一篇稿件（同一 `doc_id`）内连续工作数十个回合，Track B 工具规程不宜按跨 `doc_id` 门控（否则单篇写稿周期内永远无法激活，且会破坏现有单测与基准）；应要求 **≥2 个独立回合（不同 `turn_id`）的信号** + **至少 1 条信号带有同轮成功恢复轨迹（`ExecutionSignals.collectCommit` 捕获的非空 `recovery_ops`，作为确定性 Verifier 证明该修法确实通过了守卫校验）** + `sensitiveReason()` 通过
5. `pending` 超过 30 天未晋升 → `archived`

**DDL 草案**（注：Schema 迁移在 P0 一次性建齐 §3.1/§3.3/§3.4 所需列与版本表，其中版本快照与可靠性计数逻辑在 P2 填充）：

```sql
ALTER TABLE harness_rules ADD COLUMN evidence_refs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE harness_rules ADD COLUMN hit_count      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE harness_rules ADD COLUMN success_count  INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS harness_rule_versions (
  id             TEXT PRIMARY KEY,
  rule_id        TEXT NOT NULL,
  owner          TEXT NOT NULL,
  trigger_pattern TEXT NOT NULL,
  rule           TEXT NOT NULL,
  reason         TEXT,
  signal_ids     TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS harness_rule_versions_rule ON harness_rule_versions (rule_id, created_at);
```

**状态机**：

```
（signal 沉淀）──► pending ──(≥2 独立 turn_id + 含 recovery_ops 验证通过)──► active
                     │                                                        │
                     │ 30 天未晋升                                             │ 连续 N 次注入无改善
                     ▼                                                        ▼
                  archived ◄──────────────────────────────────────────────────┘
```

**工作量**：小。表加三列 + 一段状态机 + 迁移 + `procedural-memory.test.ts` 补 3 个用例。

**验收**：构造「同一错误码仅在同一个 `turn_id` 内连续重试失败 2 次（或无 `recovery_ops` 恢复轨迹）」的场景，断言规则停在 `pending` 且不出现在 `forPrompt()` 输出里；跨 `turn_id` 且带 `recovery_ops` 时晋升为 `active`。

---

### 3.2 SafeVantage —— 把「不知道」变成一等公民（P0/P1）

**论文**：[SafeVantage: Vantage-Aware Memory for Reliable Embodied Decisions](https://arxiv.org/abs/2609.36906)（arXiv:2609.36906）

**核心机制**：每条 claim 保留支持它的视角、相机位姿与估计位置，把 *positive support* 与 *search coverage* 分开；一个 calibrated head 综合支持度、空间一致性与覆盖率，输出 `Yes / No / Abstain`；`Abstain` 触发主动取景，取景决策由「终止决策损失的期望下降 − 移动成本」驱动。

**为什么适用**：Heurion 现在只有「打分取 top-k」，没有「我不该说话」这个输出。在临床写作里，错误地注入一条规则和缺失一条规则，代价是不对称的。

**两个落点，第二个价值更高。**

#### 落点 A：`forPrompt()` 增加 abstain 分支

现状 `score()` 是纯加性打分，分数高只说明规则相关，不说明情境被覆盖。建议：

- 计算 `coverage`：该 `owner` 在该 `domain` 下的活跃规则数、历史信号数、已处理文档数
- **保护基线守卫，仅抑制低置信度习得规则**：`recentUserEdits` 与 `pendingSuggestions` 恰是系统 `BASELINE_RULES`（`conflict_user_edited`、`pending_suggestion`）的触发条件，**绝不能在 `coverage < θ` 时把 `BASELINE_RULES` 或 `stateMatched === true` 的守卫规则一并抑制**（否则新用户会失去并发冲突保护，且破坏 `procedural-memory.test.ts:150-167`）。`Abstain` 只剔除**仅靠 `evidence_count` 凑分、既无 `msgMatched` 也无 `stateMatched`** 的低置信度用户规则
- 当高风险状态（如 `openComments` / `recentUserEdits`）存在且当前选中集 `picked` 中无对应状态规则覆盖时，在保留基线守卫的同时**追加**一条「主动取景指令」：先调用 `doc_read` 核对目标块或 `comments_list` 检查批注（取景成本对应 SafeVantage 的 travel cost：一次只读操作）

这条改动集中在 `procedural.ts` 的 `forPrompt()` 与 `score()`，不影响 schema。

#### 落点 B：`verify_claims` 正交分离 Support 与 Coverage，并展示匹配的全文/摘要具体内容（**推荐优先做**）

`apps/platform/src/claims/service.ts` 目前把摘要和全文一起喂给模型，判定却只有 `supported / unsupported / unclear`。临床上「仅摘要支持」和「全文表格支持」是两回事，且医生核对文献时不仅需要知道「是全文还是摘要」，更需要**直接看到符合或矛盾的那段全文/表格或摘要的具体原文内容**。

建议：

1. **正交建列（证据层级 + 原文摘录）**：保持 `ClaimVerdict`（`db.ts:475`）表达 Support（`supported | unsupported | unclear | missing_citation | exempted`），在 `claim_checks` 表与 `claim_report` 接口新增两个正交字段：
   - `evidence_tier: 'abstract' | 'fulltext' | 'table' | 'none'`（表达 Coverage 证据层级）
   - `evidence_quote: string`（所引文献摘要或开放全文/表格中与该句直接对应的具体原文句子或 Markdown 表格行摘录；若模型未传，平台自动从 `relevantPassages` 或摘要中抽取最匹配的原句/表格行回填）
2. 判定提示词（`service.ts:45-51`）要求模型同时输出 `verdict`、`evidence_tier` 与 `evidence_quote`；若摘要支持但开放全文/表格直接修正或推翻了摘要数字，应判为 `verdict: 'unsupported'`，在 `reason` 中注明「全文/表格修正了摘要结论」，并在 `evidence_quote` 中附上对应的全文表格行原文
3. **按核查风险分级（`verification_tier`）决定是否挂批注，并在面板与批注中透出原文摘录**：
   - 普通背景论断（`verification_tier === 'light' | 'medium'`）若 `verdict === 'supported'` 且 `evidence_tier === 'abstract'`，只在右侧核对面板展示「仅摘要核验」徽标与**匹配的摘要原文具体内容（`evidence_quote`）**，**不挂正文批注**
   - 仅当论断属于高风险定量/亚组结论（`verification_tier === 'high'`，如结果/讨论段的特定亚组 HR 或表格数值）且 `evidence_tier === 'abstract'` 时，才自动挂一条带【匹配摘要原文】的「高风险定量论断仅摘要支持，建议核对全文或表格」软批注
   - 右侧「引用与论断核对」面板（`web/src/main.ts`）同时支持查看所有已核对论断（含 `supported` 与 `unsupported/unclear`）的证据层级徽标及对应的**全文/表格或摘要原文摘录**

**工作量**：A 小；B 中（涉及 `claim_checks` 补列、提示词与原文自动抽取回填、风险分级批注门控、前端原文摘录展示）。

**验收**：构造一条 `verification_tier === 'light'` 的仅摘要支持论断断言 `verdict === 'supported'`、`evidence_tier === 'abstract'`、包含非空 `evidence_quote`（摘要原文）且**不挂正文批注**；构造一条 `verification_tier === 'high'` 的仅摘要支持亚组论断断言自动挂带摘要原文摘录的软提醒批注；构造一条带开放全文/表格的论断断言 `evidence_tier === 'fulltext' | 'table'` 且 `evidence_quote` 包含对应的全文/表格具体内容。

---

### 3.3 Skill-V —— 规则版本化与非退化回放（P2）

**论文**：[Skill-V: Verifiable Self-Evolving Skill Library for Interactive Agents](https://arxiv.org/abs/2610.11781)（arXiv:2610.11781）

**核心机制**：技能表示为带版本、可证伪的 contract，把语义意图绑定到可观测的行为判据；用环境结果驱动库演化——失败催生新技能，contract 评估与任务结果的分歧驱动**对已有技能边界的修订**；修订必须保留受保护的语义约束，并通过历史回放上的非退化校验；最后用 applicability-aware filter 排除确信不适用的候选。

**现状差距**：`updateHarnessRule()` 是无痕覆盖，`narrow / strengthen / merge` 之后没有任何回归检查。也就是说，规则改了以后，「零负迁移」只是论文里的一句话，不是流水线上的门槛。

**建议改动**：

1. 建 `harness_rule_versions`（见 §3.1 DDL），每次 `narrow / strengthen / merge` 前写快照
2. 修订落库前跑 `paper/benchmarks/v2/cross-domain-eval.ts` 的 replay 子集，掉点则拒绝并回滚
3. **受保护的语义约束（修复用户影子副本漏洞）**：虽然 `refineWithBackward()`（`procedural.ts:504`）已过滤掉 `owner === 'system'`，但 `evolveFromSignals()`（`procedural.ts:372-385`）在用户触发基线错误码时会克隆一份 `owner = user` 的用户副本，且 `forPrompt()`（`procedural.ts:564-571`）会用该副本**屏蔽（shadow）**系统基线规则。若 `refineWithBackward()` 将该用户副本 `narrow` 或 `merge` 掉，基线约束就会实质丢失。因此需将 5 条 `BASELINE_RULES` **及其同源用户影子副本的核心守卫子句**设为受保护不变量，禁止被 `merge` 归档或删减核心约束

**工作量**：中。主要成本在于先把 replay 集固化成可重复执行的基准，状态机本身不难。

**验收**：提交一个会让 deck 领域掉点或丢失基线用户副本核心约束的 `narrow / merge` 修订，断言被回放校验拒绝且规则内容未变。

---

### 3.4 MSCE —— 只借可靠性与证据指针（P2）

**论文**：[From Memory to Skills: Evidence-Grounded Governance for Long-Horizon LLM Agents](https://aclanthology.org/2026.findings-emnlp.1637/)（Findings of EMNLP 2026, pp. 34826–34847）

**核心机制**：把经验组织成三层——grounded step traces、可复用的 procedural policies、声明式环境认知；把有正向估计收益的证据支持策略「结晶」为可调用 skill，并保留 evidence links、applicability boundaries、decision guidance、verification rules、reliability estimates；用 reflection-weighted value backfilling 把稀疏的终局反馈传播到中间步骤。

**建议只借两点**：

1. **reliability**：`success_count / hit_count`。现在只有 `evidence_count`，只知道「命中过」，不知道「命中后有没有用」。**归因时机定义**：
   - `hit_count`：在 `forPrompt()` 选中注入且本回合实际发生了文档/工具写操作（`turns/service.ts:556` 中 `touched.size > 0` 或调用了对应域工具，排除未调工具的纯问答回合）时 `+1`
   - `success_count`：回合正常结束（`status === 'done'`）且同轮未产生该规则对应 `code` 的 `execution_signal` 时 `+1`；若用户在后续交互中触发了关联该 `turn_id` 的异步回滚信号（`ExecutionSignals.collectCommit` 中的 `user_reverted_turn`），则对应该回合已注入规则回扣 `success_count`
2. **evidence pointer**：`evidence_refs` 指回 `execution_signals`

**明确不建议照抄的部分**：把 applicability boundary、decision guidance、verification rules 做成纯文本字段。那会退化成 prompt 变体，没有可执行性，反而增加上下文预算占用。

**一个被低估的现有资产**：`procedural.ts:105` 的 `CUES` 里已经有 `state: s => s.recentUserEdits` 这类**可执行的适用性谓词**，`[pred:xxx]` 通道也已经能引用 `EnvironmentCueContext.predicates`。这正是 Skill-V 说的 "observable behavioral criteria" 的雏形，而且真的能跑——只是硬编码在 TS 常量里。**把它们统一提升为规则数据的一部分，比新造一套 schema 划算得多。**

---

### 3.5 MemSkill —— hard-case 队列（P3）

**论文**：[MemSkill: Learning and Evolving Memory Skills for Self-Evolving Agents](https://arxiv.org/abs/2602.02474)（arXiv:2602.02474）

**核心机制**：controller 选择少量相关技能，executor 产出技能引导的记忆，designer 定期复盘「选中的技能产出错误或不完整记忆」的 hard cases，据此提出技能细化与新技能。

**现状**：Track B 已经相当接近 controller + executor + designer 的三段结构，缺的是 designer 的**输入筛选**——现在所有信号一视同仁。

**建议**：等 §3.4 的 `success_count` 落地后，只把「规则已注入但仍失败」与「未注入且失败」的信号送进 designer，其余仅 bump `evidence_count`。

**依赖**：必须先有 §3.4 的可靠性计数。**所以顺序是 MSCE 的 reliability 先做，MemSkill 后做。**

---

### 3.6 MemTransfer —— 只用于评测协议（论文侧）

**论文**：[MemTransfer: Benchmarking Memory Beyond Matched Experience in Embodied Decision-Making](https://arxiv.org/abs/2609.32313)（arXiv:2609.32313）

**核心结论**：对一种 mismatch 的鲁棒性不蕴含对另一种 mismatch 的鲁棒性。论文里 Full-context 与原位 Episodic 在原始起点成功率达 95.3% / 100%，但换起点后掉 48–49 个百分点。

**这不是运行时机制，是评测方法。** 三条 mismatch 轴可以直接映射到 Heurion 的评测矩阵：

| MemTransfer 的轴 | Heurion 的对应物 |
|---|---|
| 起点位姿变化 | 换文档 / 换项目（同一课题的另一篇稿） |
| 路径可用性变化 | 换领域（manuscript → biostats → deck） |
| 历史量/相关性变化 | 换用户 / 换措辞 / 换历史条数 |

**建议**：把 `paper/benchmarks/v2/cross-domain-eval.ts` 扩成「固定 policy，只动一轴」的矩阵。这能把论文第 7 节（`§7.4 Online Zero-Template Evolution and Cross-Domain Skill Training`）的「零负迁移」从一句断言升级为可复现协议。

---

### 3.7 A-MEM —— 不建议

**论文**：[A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110)（NeurIPS 2025）

**核心机制**：借鉴 Zettelkasten，为每条记忆生成含上下文描述、关键词、标签的结构化笔记，并自动建立互链；新记忆写入时会反过来更新旧记忆的上下文表示。

**不推荐的理由**：Heurion 的记忆已经有 embedding + 归一化相似度去重 + `evolve.ts` 的 `create / merge / update / archive` 演进，覆盖了 A-MEM 的主要收益。在临床写作这个场景里，额外的图链接更多是检索噪声来源，而不是信号。除非将来要做跨课题的知识图谱，否则不划算。

---

### 3.8 K-Risk —— 不适用

**仓库**：[K-Risk: 知识驱动的自动驾驶长尾风险数据集](https://github.com/benmagnifico/K-Risk)

自动驾驶长尾风险场景数据集，与 Heurion 的临床科研写作没有交集。唯一可借的是「安全关键场景分级」的**概念**，属于论证素材而非实现。硬把 K-Risk 接进 Heurion 只会制造一个没有用户的模块。

---

## 4. 实施顺序

```
P0  CoEM pending 状态机            0.5–1 天   堵住假规则，补齐双轨准入对称性
P0  SafeVantage evidence_tier      1–2 天     唯一医生可感知的改动
P1  SafeVantage coverage abstain   2–3 天     依赖 forPrompt() 重构
P2  Skill-V 版本化 + 回放门槛      1 周       先把 replay 基准固化
P2  MSCE reliability 计数          2–3 天     解锁 MemSkill
P3  MemSkill hard-case 筛选        2 天       依赖 reliability
──  MemTransfer 评测矩阵           论文周期内   与实现并行
```

依赖关系：

- **Skill-V 的版本化** 依赖 §3.1 的表结构（`evidence_refs` 先有，版本表才有意义）
- **MemSkill** 依赖 §3.4 的 `hit_count / success_count`
- **SafeVantage 落点 A** 依赖 `forPrompt()` 现有结构，与 §3.1 无冲突，可并行

---

## 5. 如果只做一件事

做 **§3.1 的 `pending` 状态机**。

理由不是它最亮眼，而是它同时满足三个条件：改动最小（半天到一天）、修的是真实缺陷（单回合死循环重试或偶发失败被直接固化成永久规则）、且补上了架构层面的双轨准入对称性（主观偏好由人类 UI 审批准入，客观规程由运行时验证器证据门控准入）。这条做完，「声明式记忆与程序性规则的双轨准入对齐」本身就是论文里一个干净的论点。

第二件做 **§3.2 落点 B 的 `evidence_tier`**——这是整套建议里唯一一个普通医生能直接感知到的改动。

---

## 6. 参考文献

| # | 文献 | 作者 | 链接 |
|---|---|---|---|
| 1 | CoEM: Empowering Long-Context Reasoning with Commit-on-Evidence Memory (2026) | Jingguang Li, Yebo Wu, Zuyi Guo, Kailang Ma, Xianjie Dai, Han Zheng, Benwang Chen, Li Li, Can Rong, Heye Huang | <https://arxiv.org/abs/2609.36935> |
| 2 | SafeVantage: Vantage-Aware Memory for Reliable Embodied Decisions (2026) | Sean Hardesty Lewis, Zuyi Guo, Benwang Chen, Zirui Li, Hongyi Lin, Heye Huang | <https://arxiv.org/abs/2609.36906> |
| 3 | MemTransfer: Benchmarking Memory Beyond Matched Experience in Embodied Decision-Making (2026) | Haiming Tang, Xianjie Dai, Gujie Shao, Zuyi Guo, Jingguang Li, Kailang Ma, Yihong Tang, Heye Huang | <https://arxiv.org/abs/2609.32313> |
| 4 | Skill-V: Verifiable Self-Evolving Skill Library for Interactive Agents (2026) | Jie Ma, Zhipeng Qian, Yufei Ma, Zihan Liang, Jiayi Ji, Qingpeng Cai, Ben Chen, Peng Jiang, Xiaoshuai Sun | <https://arxiv.org/abs/2610.11781> |
| 5 | MemSkill: Learning and Evolving Memory Skills for Self-Evolving Agents (2026) | Haozhen Zhang, Quanyu Long, Jianzhu Bao, Tao Feng, Weizhi Zhang, Haodong Yue, Wenya Wang | <https://arxiv.org/abs/2602.02474> |
| 6 | From Memory to Skills: Evidence-Grounded Governance for Long-Horizon LLM Agents. *Findings of EMNLP 2026*, pp. 34826–34847 | Bo Tang, Yang Zhang, Guomian Zhuang, Wenqiang Wei, Gaoyang Zheng, Lindong Xie, Yanchao Tan, Feiyu Xiong, Qingyu Yang, Edward Chung, Zhiyu Li | <https://aclanthology.org/2026.findings-emnlp.1637/> |
| 7 | A-MEM: Agentic Memory for LLM Agents. *NeurIPS 2025* | Wujiang Xu, Zujie Liang, Kai Mei, Hang Gao, Juntao Tan, Yongfeng Zhang | <https://arxiv.org/abs/2502.12110> |
| 8 | K-Risk: 知识驱动的自动驾驶长尾风险数据集 | Heye Huang, Jingguang Li, Zhiyuan Zhou, Paul Liang, Mingyu Wu, Kitae Jang, Jianqiang Wang | <https://github.com/benmagnifico/K-Risk> |

**内部对照**：Heurion 自身的三层自演进记忆设计见 [`paper/main.tex`](../paper/main.tex) 第 5 节（`Three-Layer Self-Evolving Agent Architecture`）。
