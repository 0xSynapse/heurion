/**
 * 可插拔领域技能适配器（Domain Skill Adapters）：
 * 将双轨自演进内核（Corruption-Reconstruction Loop + Trajectory-Contrastive Backward Credit Assignment）
 * 从单一的医学论文写作解耦，泛化支持：
 * - manuscript：学术与研究报告写作
 * - biostats：生物统计建模、队列筛选与生存分析（对接 research/* 与 datasets/*）
 * - deck：学术与高管演示文稿排版工程（对接 ops/deck.ts 与 convert/pptx-*）
 * - general_mcp：通用代码、SQL 查询与外部 MCP 工具调用
 */

export type SkillDomain = 'manuscript' | 'biostats' | 'deck' | 'general_mcp' | (string & {})

/** 兼容现有文档状态线索（DocState）。 */
export interface DocCueState {
  recentUserEdits: boolean
  openComments: boolean
  pendingSuggestions: boolean
  hasTable: boolean
  /** SafeVantage (P1): 当前文档是否存在仅靠摘要支撑（缺少开放全文）或低覆盖率/存疑的文献引用与论断。 */
  lowCoverageCitations?: boolean
}

/** 领域无关的通用环境上下文（供 MoE 门控路由器与反向归因使用）。 */
export interface EnvironmentCueContext {
  domain?: SkillDomain
  /** 当前回合可用或已调用的工具名列表（如 ['dataset_table1', 'dataset_survival']）。 */
  activeTools?: string[]
  /** 领域环境动态谓词（如 { hasSmallExpectedCell: true, skewedVars: 3, slideBulletCount: 8 }）。 */
  predicates?: Record<string, boolean | number | string>
  /** 文档编辑状态（向后兼容）。 */
  docState?: DocCueState
}

export interface ExtractedSkillCandidate {
  op: 'create' | 'update' | 'merge'
  kind: 'preference' | 'style' | 'term' | 'fact'
  content: string
  target_ids?: string[]
  reason: string
}

export interface DomainSkillAdapter {
  readonly domain: SkillDomain
  readonly label: string
  /** 当未显式传入 domain 时，用于从用户消息或工具名推断领域的线索正则。 */
  readonly cueRegex: RegExp
  /** 确定性前向退化算子 C_domain(x_0) -> x_tilde：剥离专家修辞、结构排版或方法学包装，仅保留裸要点与原始数据骨架。 */
  corruptDeterministic(exemplar: string): string
  /** LLM 前向退化提示词。 */
  corruptionPrompt(exemplar: string): { system: string; user: string }
  /** 挂载当前激活技能集合 S_t 重建输出 x_hat 的提示词。 */
  reconstructionPrompt(skeleton: string, activeSkillsBlock: string): { system: string; user: string }
  /** 自对比损失与四算子反向归因（create / update / narrow / merge）提示词。 */
  backwardPrompt(
    skeleton: string,
    reconstructed: string,
    exemplar: string,
    activeSkills: Array<{ id: string; kind: string; content: string }>,
  ): { system: string; user: string }
  /** 确定性对比特征提取（当未配置在线 LLM 或在确定性基准测试中作为后备）。 */
  extractContrastCandidates(
    skeleton: string,
    reconstructed: string,
    exemplar: string,
    activeSkills: Array<{ id: string; kind: string; content: string }>,
  ): ExtractedSkillCandidate[]
  /**
   * 实例-技能解耦守卫（Instance–Skill Decoupling Guard）：
   * 拦截将单次任务的具体样本量（如 n=312）、精确结果值（HR=0.68）、表主键或特定项目字面量直接固化为全局技能的条目。
   * 返回非空字符串表示拦截原因；返回 null 表示通过。
   */
  hasInstanceLeakage(ruleText: string): string | null
}

/** 通用实例污染检测：拦截未声明为“示例/例如/e.g.”却硬编码特定样本量、精确统计结果或内部主键的规则。 */
function commonInstanceLeakage(ruleText: string): string | null {
  const allowsExample = /例如|示例|比如|如：|e\.g\.|for example|such as|格式为/i.test(ruleText)
  if (!allowsExample) {
    if (/\b(?:n|N)\s*=\s*\d{2,}\b/.test(ruleText) || /纳入\s*\d{2,}\s*例/.test(ruleText)) {
      return '包含特定队列具体样本量数值（instance_sample_size_leak）'
    }
    if (/\b(?:HR|OR|RR)\s*=\s*\d+\.\d{2}\b/.test(ruleText) && /\d+\.\d{2}\s*[–-]\s*\d+\.\d{2}/.test(ruleText)) {
      return '包含单篇研究的具体效应量与置信区间数值（instance_effect_size_leak）'
    }
    if (/\b(?:SELECT|UPDATE|DELETE)\b[\s\S]*\bWHERE\s+\w+_id\s*=\s*['"]?[a-z0-9_-]{4,}/i.test(ruleText)) {
      return '包含具体数据库行主键字面量（instance_primary_key_leak）'
    }
  }
  return null
}

/** 1. 学术与研究报告写作适配器（Manuscript Adapter）。 */
export const manuscriptAdapter: DomainSkillAdapter = {
  domain: 'manuscript',
  label: '学术与研究写作',
  cueRegex: /段落|章节|摘要|引言|方法|结果|讨论|润色|改写|引用|参考文献|稿件|论文|abstract|introduction|methods|results|discussion|manuscript|paragraph|cite/i,

  corruptDeterministic(exemplar: string): string {
    const sentences = exemplar
      .replace(/\s+/g, ' ')
      .split(/(?<=[.。!?！？；;])\s*/)
      .map(s => s.trim())
      .filter(Boolean)
    const bullets = sentences.map(s => {
      return s
        .replace(/^(?:Furthermore|Moreover|In addition|Notably|Importantly|Specifically|However|Conversely|Taken together|In summary|此外|另外|值得注意的是|综上所述|因此|然而)[,，\s]*/i, '')
        .replace(/,\s*consistent with prior (?:studies|literature|reports)[^.。]*/i, '')
        .replace(/\(\s*(?:95%\s*CI[,:\s]*|IQR[,:\s]*|SD[,:\s]*)/gi, '(')
        .replace(/\bP\s*=\s*\.(\d+)/g, 'p=0.$1')
        .trim()
    })
    return bullets.map(b => `- ${b}`).join('\n')
  },

  corruptionPrompt(exemplar: string) {
    return {
      system:
        '你是自监督技能训练器的前向退化算子（Forward Corruption Operator）。请将输入的高水平学术段落退化为“无修辞的粗粒度事实要点骨架（x_tilde）”：\n' +
        '1. 剥离高阶学术过渡词、语态修饰、因果克制措辞（hedging）与规范化统计括号排版；\n' +
        '2. 完整保留底层核心事实与原始数字，但统一降级为简短平实的清单要点；\n' +
        '3. 只输出退化后的要点列表，不要解释。',
      user: exemplar,
    }
  },

  reconstructionPrompt(skeleton: string, activeSkillsBlock: string) {
    return {
      system:
        '你是学术写作重建器（Skill-Routed Reconstructor）。请仅根据给定的“事实要点骨架”与当前激活的“写作技能卡”，将其重建为正式的学术论文段落。\n' +
        (activeSkillsBlock ? `\n${activeSkillsBlock}\n` : '') +
        '只输出重建后的段落正文。',
      user: skeleton,
    }
  },

  backwardPrompt(skeleton, reconstructed, exemplar, activeSkills) {
    return {
      system:
        '你是自监督语义扩散的反向归因器（Backward Credit Assignment Engine）。\n' +
        '对比【退化骨架 x_tilde】、【模型挂载当前技能重建的段落 x_hat】与【黄金原稿 x_0】，分析 x_hat 与 x_0 在论证结构、句式规范、统计量报告格式、过渡衔接上的差距，并对当前激活技能库执行四算子归因：\n' +
        '- create：当 x_0 体现了通用写作规范而当前技能库缺失时，新增可迁移的写作/格式技能（严禁写入本文具体样本量 N 或具体疾病结论）；\n' +
        '- update（strengthen / narrow）：当某条已激活技能表述不充分或边界过宽导致 x_hat 偏离 x_0 时，强化或收窄该技能；\n' +
        '- merge：当多条已有技能重复时合并。\n' +
        '请输出 JSON：{"ops":[{"op":"create"|"update"|"merge","kind":"style"|"preference"|"term","content":"≤80字的可迁移规则","target_ids":["m_..."],"reason":"归因依据"}]}',
      user: JSON.stringify({ skeleton, reconstructed, exemplar, active_skills: activeSkills }),
    }
  },

  extractContrastCandidates(_skeleton, reconstructed, exemplar, activeSkills) {
    const out: ExtractedSkillCandidate[] = []
    // 1. 统计量与置信区间排版规范对比
    if (/\b(?:HR|OR|RR)\s*=\s*\d+\.\d+\s*\(95%\s*CI[,:\s]/i.test(exemplar) && !/\(95%\s*CI[,:\s]/i.test(reconstructed)) {
      const content = '[domain:manuscript] 报告效应量（HR/OR/RR）时，统一使用“效应量 = X.XX (95% CI, X.XX–X.XX; P = .XXX)”的标准括号结构。'
      const existing = activeSkills.find(s => /效应量|95%\s*CI/i.test(s.content))
      if (existing) {
        out.push({ op: 'update', kind: 'style', target_ids: [existing.id], content, reason: '已激活规则未明确 95% CI 与 P 值同括号分号分隔格式（strengthen）' })
      } else {
        out.push({ op: 'create', kind: 'style', content, reason: '原稿采用标准效应量与 95% CI 括号报告规范，重建稿缺失该规范' })
      }
    }
    // 2. P 值前导零与精确值规范对比
    if (/\bP\s*=\s*\.\d{2,3}\b/.test(exemplar) && /\bp\s*=\s*0\.\d+/i.test(reconstructed)) {
      out.push({
        op: 'create',
        kind: 'style',
        content: '[domain:manuscript] 统计显著性 P 值使用大写斜体 P 并省略小数点前的 0（例如写为 P = .032 或 P < .001）。',
        reason: '原稿遵循 AMA/JAMA 无前导零 P 值格式，重建稿未对齐',
      })
    }
    // 3. 外部文献对比分句结构与因果克制（hedging）
    if (/consistent with prior|in line with previous|与既往研究一致/i.test(exemplar) && !/consistent with|in line with|既往研究/i.test(reconstructed)) {
      out.push({
        op: 'create',
        kind: 'style',
        content: '[domain:manuscript] 讨论段陈述本队列发现并引述外部文献时，先完整陈述本研究结果，再以“, consistent with prior studies demonstrating...”分句衔接外部证据。',
        reason: '原稿采用主句陈述本队列发现 + 分句衔接外部证据的论证结构',
      })
    }
    // 4. 观察性研究因果克制措辞
    if (/\b(?:associated with|correlated with|相关)\b/i.test(exemplar) && /\b(?:caused|proved|导致|证明了)\b/i.test(reconstructed)) {
      out.push({
        op: 'create',
        kind: 'preference',
        content: '[domain:manuscript] 非随机观察性研究表述结局关系时保持因果克制，使用“was associated with（与…相关）”而非强因果词“caused / proved”。',
        reason: '原稿严格使用相关性措辞，重建稿过度使用因果表述',
      })
    }
    return out
  },

  hasInstanceLeakage(ruleText: string) {
    return commonInstanceLeakage(ruleText)
  },
}

/** 2. 生物统计与数据科学建模适配器（Biostats & Data Science Adapter）。 */
export const biostatsAdapter: DomainSkillAdapter = {
  domain: 'biostats',
  label: '数据科学与生物统计建模',
  cueRegex: /统计|队列|基线表|table\s*1|生存分析|kaplan|cox|倾向性评分|psm|因果推断|分布|非参数|卡方|fisher|ecrf|变量|回归|cohort|survival|biostat|p-value|hazard/i,

  corruptDeterministic(exemplar: string): string {
    return exemplar
      .split(/\n+/)
      .map(line =>
        line
          .replace(/\(?(?:Shapiro-Wilk|Kolmogorov-Smirnov|Schoenfeld|Mann-Whitney|Wilcoxon|Kruskal-Wallis|Fisher's exact|Fine-Gray)[^).。]*\)?/gi, '')
          .replace(/(?:median\s*\[IQR\]|中位数\s*\[四分位距\]|mean\s*±\s*SD|均数\s*±\s*标准差)/gi, '汇总统计量')
          .replace(/(?:事件数\/变量数\s*\(EPV\)\s*≥\s*10|EPV\s*>=\s*10)/gi, '')
          .trim(),
      )
      .filter(Boolean)
      .map(l => `- ${l}`)
      .join('\n')
  },

  corruptionPrompt(exemplar: string) {
    return {
      system:
        '你是数据科学与生物统计领域的退化算子。请将输入的规范统计分析方案（SAP）或分析脚本退化为“仅包含分析目标与原始变量列表的粗粒度需求（x_tilde）”，剥离具体的分布正态性检验步骤、小样本修正检验名称、比例风险假定检验与共线性诊断细节。只输出退化后的需求骨架。',
      user: exemplar,
    }
  },

  reconstructionPrompt(skeleton: string, activeSkillsBlock: string) {
    return {
      system:
        '你是生物统计分析规划器。请根据给定的分析需求骨架与当前激活的“统计建模技能卡”，生成严谨的统计分析执行方案与检验选择规程。\n' +
        (activeSkillsBlock ? `\n${activeSkillsBlock}\n` : '') +
        '只输出重建后的统计分析方案。',
      user: skeleton,
    }
  },

  backwardPrompt(skeleton, reconstructed, exemplar, activeSkills) {
    return {
      system:
        '你是数据科学与统计建模的反向归因器。对比【原始分析需求 x_tilde】、【重建统计方案 x_hat】与【黄金统计方案 x_0】，提炼可跨数据集复用的统计方法学技能（如连续变量正态性检验与 Median [IQR] 选择、分类变量期望频数 <5 时选用 Fisher 精确检验、Cox 模型 Schoenfeld 残差检验与 EPV 约束等）。严禁包含特定数据集的样本量或业务数值。\n' +
        '输出 JSON：{"ops":[{"op":"create"|"update"|"merge","kind":"preference"|"style"|"term","content":"≤80字的可迁移统计方法规则","target_ids":[],"reason":"归因依据"}]}',
      user: JSON.stringify({ skeleton, reconstructed, exemplar, active_skills: activeSkills }),
    }
  },

  extractContrastCandidates(_skeleton, reconstructed, exemplar, activeSkills) {
    const out: ExtractedSkillCandidate[] = []
    if (/median\s*\[IQR\]|中位数.*四分位|Mann-Whitney|Wilcoxon/i.test(exemplar) && !/median|IQR|四分位|非参数/i.test(reconstructed)) {
      const content = '[domain:biostats] 连续变量汇总前先检验分布偏态性：偏态分布变量一律报告 Median [IQR] 并采用 Mann-Whitney U / Kruskal-Wallis 非参数检验。'
      const existing = activeSkills.find(s => /偏态|Median|IQR/i.test(s.content))
      if (existing) {
        out.push({ op: 'update', kind: 'preference', target_ids: [existing.id], content, reason: '强化偏态连续变量的非参数检验配对规范（strengthen）' })
      } else {
        out.push({ op: 'create', kind: 'preference', content, reason: '黄金统计方案对偏态连续变量采用 Median [IQR] 与非参数检验，重建方案遗漏' })
      }
    }
    if (/Fisher's exact|Fisher\s*精确/i.test(exemplar) && !/Fisher/i.test(reconstructed)) {
      out.push({
        op: 'create',
        kind: 'preference',
        content: '[domain:biostats] 分类变量列联表比较时，若任意单元格理论期望频数 < 5，自动由卡方检验切换为 Fisher 精确检验。',
        reason: '黄金统计方案包含稀疏单元格 Fisher 精确检验回退规则',
      })
    }
    if (/Schoenfeld|比例风险假定|EPV|events per variable/i.test(exemplar) && !/Schoenfeld|比例风险|EPV/i.test(reconstructed)) {
      out.push({
        op: 'create',
        kind: 'preference',
        content: '[domain:biostats] 拟合多变量 Cox 比例风险模型时，须检验 Schoenfeld 残差满足比例风险假定，且确保事件数与自变量比值（EPV）≥ 10。',
        reason: '黄金统计方案要求验证比例风险假定与 EPV 下限',
      })
    }
    return out
  },

  hasInstanceLeakage(ruleText: string) {
    return commonInstanceLeakage(ruleText)
  },
}

/** 3. 演示文稿与视觉排版工程适配器（Slide Deck & Visual Layout Adapter）。 */
export const deckAdapter: DomainSkillAdapter = {
  domain: 'deck',
  label: '演示文稿与视觉排版工程',
  cueRegex: /幻灯片|演示文稿|ppt|pptx|slide|deck|排版|版式|母版|标题页|双栏|图表页|溢出|bullet|layout/i,

  corruptDeterministic(exemplar: string): string {
    return exemplar
      .replace(/\[(?:layout|slide_layout|chart_pairing|action_title):[^\]]*\]/gi, '')
      .split(/\n+/)
      .map(s => s.replace(/^#+\s*/, '').replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean)
      .join(' ')
  },

  corruptionPrompt(exemplar: string) {
    return {
      system:
        '你是演示文稿领域的退化算子。请将输入的结构化高质量幻灯片大纲/页面内容退化为“不分栏、无结论先行标题、混成一整段的原始信息流水账（x_tilde）”。只输出退化后的纯文本。',
      user: exemplar,
    }
  },

  reconstructionPrompt(skeleton: string, activeSkillsBlock: string) {
    return {
      system:
        '你是演示文稿结构与视觉排版器。请根据给定的原始信息与当前激活的“幻灯片排版技能卡”，将其规划为结构化的幻灯片页面（包含页面标题、版式选择、要点列表与图表配对说明）。\n' +
        (activeSkillsBlock ? `\n${activeSkillsBlock}\n` : '') +
        '只输出重建后的幻灯片结构。',
      user: skeleton,
    }
  },

  backwardPrompt(skeleton, reconstructed, exemplar, activeSkills) {
    return {
      system:
        '你是演示文稿工程的反向归因器。对比【原始信息流水账 x_tilde】、【重建幻灯片 x_hat】与【黄金幻灯片范例 x_0】，提炼可跨汇报复用的幻灯片结构与排版技能（如结论先行标题 Action Title、单页要点上限 ≤4 条防溢出、对比信息采用双栏版式、核心数据主张配对可视化图表等）。严禁包含具体汇报的业务数字或项目名称。\n' +
        '输出 JSON：{"ops":[{"op":"create"|"update"|"merge","kind":"style"|"preference","content":"≤80字的可迁移幻灯片排版规则","target_ids":[],"reason":"归因依据"}]}',
      user: JSON.stringify({ skeleton, reconstructed, exemplar, active_skills: activeSkills }),
    }
  },

  extractContrastCandidates(_skeleton, reconstructed, exemplar, activeSkills) {
    const out: ExtractedSkillCandidate[] = []
    if (/Action Title|结论先行|降低了|提升了|reduced|increased|improved/i.test(exemplar.split('\n')[0] ?? '') && /^(?:结果|背景|分析|Results|Background|Overview)\b/i.test(reconstructed.trim())) {
      const content = '[domain:deck] 幻灯片页标题一律采用“结论先行标题（Action Title，直接点明核心趋势或幅度）”，避免使用“结果 / 数据分析”等名词性空泛标题。'
      const existing = activeSkills.find(s => /Action Title|结论先行/i.test(s.content))
      if (existing) {
        out.push({ op: 'update', kind: 'style', target_ids: [existing.id], content, reason: '强化页标题结论先行约束（strengthen）' })
      } else {
        out.push({ op: 'create', kind: 'style', content, reason: '黄金幻灯片采用结论先行标题，重建稿退化为空泛名词标题' })
      }
    }
    if (/two_column|双栏|左右对比|2-column/i.test(exemplar) && !/two_column|双栏|2-column/i.test(reconstructed)) {
      out.push({
        op: 'create',
        kind: 'style',
        content: '[domain:deck] 展示两组方案或队列前后对比时，优先选用双栏对比版式（two_column），单页要点控制在 4 条以内以防文本框视觉溢出。',
        reason: '黄金幻灯片采用双栏版式并控制单页信息密度',
      })
    }
    if (/chart|图表|森林图|生存曲线/i.test(exemplar) && !/chart|图表/i.test(reconstructed)) {
      out.push({
        op: 'create',
        kind: 'preference',
        content: '[domain:deck] 含定量趋势或多组比较的页面，采用左图右文版式配对柱状图/趋势图，避免纯文字堆砌数字。',
        reason: '黄金幻灯片将定量结论与图表组件同页配对',
      })
    }
    return out
  },

  hasInstanceLeakage(ruleText: string) {
    return commonInstanceLeakage(ruleText)
  },
}

/** 4. 通用代码 / SQL / 外部 MCP 工具适配器（General MCP & Tool Adapter）。 */
export const generalMcpAdapter: DomainSkillAdapter = {
  domain: 'general_mcp',
  label: '通用软件工程与 MCP 工具调用',
  cueRegex: /sql|query|database|schema|api|mcp|script|code|python|typescript|函数|接口|查询|代码|脚本/i,

  corruptDeterministic(exemplar: string): string {
    return exemplar
      .split(/\n+/)
      .map(s => s.replace(/--.*$/, '').replace(/\/\/.*$/, '').trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' ')
  },

  corruptionPrompt(exemplar: string) {
    return {
      system: '将输入的标准代码/查询/工具调用规程退化为简短的自然语言任务意图（x_tilde），隐去具体的边界校验、分页限流与异常处理细节。',
      user: exemplar,
    }
  },

  reconstructionPrompt(skeleton: string, activeSkillsBlock: string) {
    return {
      system:
        '请根据任务意图与当前激活的“工程与工具技能卡”，编写稳健的查询或工具调用实现。\n' +
        (activeSkillsBlock ? `\n${activeSkillsBlock}\n` : ''),
      user: skeleton,
    }
  },

  backwardPrompt(skeleton, reconstructed, exemplar, activeSkills) {
    return {
      system:
        '对比【任务意图 x_tilde】、【重建实现 x_hat】与【标准实现 x_0】，提炼通用的工具调用、Schema 预检、幂等与异常处理技能，严禁包含硬编码表主键或密钥。\n' +
        '输出 JSON：{"ops":[{"op":"create"|"update"|"merge","kind":"preference"|"style","content":"≤80字的可迁移工程规则","target_ids":[],"reason":"归因依据"}]}',
      user: JSON.stringify({ skeleton, reconstructed, exemplar, active_skills: activeSkills }),
    }
  },

  extractContrastCandidates(_skeleton, reconstructed, exemplar) {
    const out: ExtractedSkillCandidate[] = []
    if (/LIMIT\s+\d+|pagination|分页/i.test(exemplar) && !/LIMIT|pagination|分页/i.test(reconstructed)) {
      out.push({
        op: 'create',
        kind: 'preference',
        content: '[domain:general_mcp] 执行数据检索或列表查询时，默认附加显式分页与 LIMIT 上界，防止全表扫描撑爆上下文窗口。',
        reason: '标准查询包含显式 LIMIT 与分页保护',
      })
    }
    return out
  },

  hasInstanceLeakage(ruleText: string) {
    return commonInstanceLeakage(ruleText)
  },
}

const ADAPTERS: Record<string, DomainSkillAdapter> = {
  manuscript: manuscriptAdapter,
  biostats: biostatsAdapter,
  deck: deckAdapter,
  general_mcp: generalMcpAdapter,
}

/** 注册自定义领域适配器（支持任意第三方领域扩展）。 */
export function registerDomainSkillAdapter(adapter: DomainSkillAdapter): void {
  ADAPTERS[adapter.domain] = adapter
}

/** 获取指定领域的技能适配器；未指定时按提示词/工具上下文自动推断。 */
export function getDomainSkillAdapter(domain?: SkillDomain, contextHint = ''): DomainSkillAdapter {
  if (domain && ADAPTERS[domain]) return ADAPTERS[domain]!
  for (const adapter of [biostatsAdapter, deckAdapter, generalMcpAdapter, manuscriptAdapter]) {
    if (adapter.cueRegex.test(contextHint)) return adapter
  }
  return manuscriptAdapter
}

/** 根据消息、工具名与文档类型推断所属技能领域。 */
export function inferSkillDomain(message: string, ctx?: EnvironmentCueContext, docKind?: 'doc' | 'deck'): SkillDomain {
  if (ctx?.domain) return ctx.domain
  if (docKind === 'deck') return 'deck'
  const toolsStr = (ctx?.activeTools ?? []).join(' ')
  if (/deck_|slide_|layout_check|pptx/i.test(toolsStr) || deckAdapter.cueRegex.test(message)) return 'deck'
  if (/dataset_|cohort_|survival|table1|ecrf|causal/i.test(toolsStr) || biostatsAdapter.cueRegex.test(message)) return 'biostats'
  if (generalMcpAdapter.cueRegex.test(message) && !manuscriptAdapter.cueRegex.test(message)) return 'general_mcp'
  return 'manuscript'
}
