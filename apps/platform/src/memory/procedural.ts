import type { Complete } from '../harness/complete.ts'
import type { Documents } from '../model/runtime.ts'
import { pendingGroups } from '../ops/suggest.ts'
import type { HarnessRuleRow, HarnessRuleVersionRow, Store } from '../store/db.ts'
import {
  inferSkillDomain,
  type DocCueState,
  type EnvironmentCueContext,
  type SkillDomain,
} from './domain-adapters.ts'
import { sensitiveReason } from './guard.ts'

export interface ProceduralRuleInput {
  scope: 'global' | 'user' | 'project'
  owner: string
  project_id?: string | null
  category: 'guard' | 'tool' | 'subagent' | 'format'
  trigger_pattern: string
  rule: string
}

/** 系统预置的基准执行策略（作为自演进底座）。 */
const BASELINE_RULES: Array<Omit<HarnessRuleRow, 'id' | 'created_at' | 'updated_at'>> = [
  {
    scope: 'global',
    owner: 'system',
    project_id: null,
    category: 'guard',
    trigger_pattern: 'conflict_user_edited',
    rule: '若目标块在 base_rev 之后被用户修改过，绝不可强制全块替换；必须以最新 rev 为准，优先使用 replace_text 原文精准替换。',
    evidence_count: 10,
    status: 'active',
  },
  {
    scope: 'global',
    owner: 'system',
    project_id: null,
    category: 'guard',
    trigger_pattern: 'citation_not_registered',
    rule: '正文严禁直接出现 DOI/PMID 或手写参考文献；必须先调用 insert_citation 注册获得 [@c:cite_id] 标记后再写入正文。',
    evidence_count: 10,
    status: 'active',
  },
  {
    scope: 'global',
    owner: 'system',
    project_id: null,
    category: 'guard',
    trigger_pattern: 'pending_suggestion',
    rule: '目标块若处于待采纳修订状态，不得继续强制覆盖修改；应先引导用户采纳或拒绝该修订。',
    evidence_count: 10,
    status: 'active',
  },
  {
    scope: 'global',
    owner: 'system',
    project_id: null,
    category: 'subagent',
    trigger_pattern: 'survival|kaplan|hazard|table1|baseline|基线|生存曲线|统计',
    rule: '涉及临床队列统计、基线 Table 1、Kaplan-Meier 曲线或 HR 风险比时，必须主动委托 biostatistician 产出标准表格后再整合进文档。',
    evidence_count: 10,
    status: 'active',
  },
  {
    scope: 'global',
    owner: 'system',
    project_id: null,
    category: 'subagent',
    trigger_pattern: 'background|evidence|clinical trial|reference|pubmed|文献|证据|试验|机理',
    rule: '涉及医学背景机制、最新临床试验或权威文献佐证时，必须主动委托 literature_researcher 检索并登记引用。',
    evidence_count: 10,
    status: 'active',
  },
  {
    scope: 'global',
    owner: 'system',
    project_id: null,
    category: 'guard',
    trigger_pattern: 'safevantage_low_coverage',
    rule: '引用仅含摘要（缺少开放全文或数据表）的文献时：涉及亚组效应或精确统计量（HR/CI/P 值）落笔前优先调用 oa_fulltext 拉取全文；若无开放全文且摘要未载明该细粒度数值，正文仅引述摘要明确披露的总体结论，严禁外推编造数值并在回复中说明。',
    evidence_count: 8,
    status: 'active',
  },
]

/** 安慰剂模式（placebo）附加的与任务无关的说明文字（§5.3：长度与习得规则相当，用来区分“规则内容的作用”与“多了一段提示”）。 */
export const PLACEBO_FILLER =
  '- [平台说明] Heurion 临床研究工作站采用双栏协同架构，支持多中心队列管理、生物统计图表向量化渲染与学术幻灯片母版自动排版，所有文档操作均通过结构化协议记录版本历史。'

/** SafeVantage (P1) 高风险文档状态下的盲区主动侦察指令。 */
export const BLINDSPOT_VANTAGING_HINT =
  '- [盲区侦察提示] 当前文档存在未决修订/批注且缺少专项历史经验，请在直接修改正文前先调用 doc_read 或 comments_list 探查上下文。'

export const BASELINE_TRIGGER_CODES = new Set(BASELINE_RULES.map(r => r.trigger_pattern.split('|')[0]!))

const CRITICAL_TOOL_TOKENS_RE =
  /\b(doc_read|doc_edit|replace_text|replace_block|insert_citation|comments_list|oa_fulltext|deck_edit|fisher_exact|ack_comments|move|merge)\b/g

/**
 * Skill-V 规则重写非退化校验（Non-Regression Guard）：
 * 防止 LLM 反向归因精炼时丢失原规则中的关键工具锚点、产出于过短空泛表述或混入敏感信息。
 */
export function isNonRegressiveRewrite(oldRule: string, newRule: string): boolean {
  const trimmed = newRule.trim()
  if (trimmed.length < 15) return false
  if (sensitiveReason(trimmed)) return false
  const oldTokens = [...new Set(oldRule.match(CRITICAL_TOOL_TOKENS_RE) ?? [])]
  if (oldTokens.length > 0) {
    const newTokens = new Set(trimmed.match(CRITICAL_TOOL_TOKENS_RE) ?? [])
    const retainedAny = oldTokens.some(t => newTokens.has(t))
    const hasRecoveryArrow = /→|成功修复轨迹|修复操作序列/.test(trimmed)
    if (!retainedAny && !hasRecoveryArrow) {
      return false
    }
  }
  return true
}

/**
 * 注入模式：frozen=只注入已有规则、不沉淀新规则；placebo=同 frozen 另附与任务无关的说明文字；
 * fifo=按创建顺序注入；utility=按效用排序注入（默认）。
 * 完全关闭（off）由调用方不挂载本服务实现。
 */
export type ProceduralMode = 'frozen' | 'fifo' | 'utility' | 'placebo'

const NO_STATE: DocCueState = {
  recentUserEdits: false,
  openComments: false,
  pendingSuggestions: false,
  hasTable: false,
  lowCoverageCitations: false,
}

const REPLACE_CUE = /替换|改成|改为|换成|写成|统一|格式|P\s*值|措辞|replace/i
const TABLE_CUE = /表格|表\s*\d|基线表|单元格|表头|行|列|table|cell/i
const STRUCTURE_CUE = /移动|移到|挪到|调整顺序|合并|合为|小节|列表|新增一段|后面新增|move|merge|list/i
const REWRITE_CUE = /重写|改写|润色|精简|扩写|衔接|过渡|rewrite|revise|polish/i
const BIOSTATS_CUE = /统计|队列|基线表|table\s*1|生存|kaplan|cox|倾向性|卡方|fisher|非参数|偏态|ecrf|survival|cohort/i
const DECK_CUE = /幻灯片|演示文稿|ppt|pptx|slide|deck|版式|双栏|标题页|溢出|图表页|layout/i
const SAFEVANTAGE_MSG_CUE =
  /引用|文献|摘要|全文|亚组|讨论|结果|对比|数值|统计|hr|or|rr|ci|p\s*值|subgroup|citation|reference|abstract|fulltext|oa_fulltext|discuss/i

/**
 * 错误码 → 通用情境线索：用户消息里出现的任务特征词（msg），或环境状态谓词（state）。
 * 错误码本身不会出现在用户消息里，因此通过动作语义词、环境状态以及反向归因动态扩充的 trigger_pattern 共同门控路由。
 */
const CUES: Record<string, { msg?: RegExp; state?: (s: DocCueState, m: string) => boolean }> = {
  conflict_user_edited: { state: s => s.recentUserEdits },
  text_not_found: { msg: REPLACE_CUE, state: (s, m) => s.recentUserEdits && REPLACE_CUE.test(m) },
  citation_not_registered: { msg: /doi|pmid|10\.\d{4,9}\/|引用|参考文献|文献|cite|citation|reference/i },
  pending_suggestion: { state: s => s.pendingSuggestions },
  anchor_has_open_comments: { msg: /批注|评论|comment/i, state: s => s.openComments },
  ambiguous_match: { msg: REPLACE_CUE, state: (s, m) => s.recentUserEdits && REPLACE_CUE.test(m) },
  invalid_table: { msg: TABLE_CUE, state: (s, m) => s.hasTable && TABLE_CUE.test(m) },
  cell_not_found: { msg: TABLE_CUE, state: (s, m) => s.hasTable && TABLE_CUE.test(m) },
  invalid_structure: { msg: STRUCTURE_CUE, state: (_s, m) => STRUCTURE_CUE.test(m) },
  user_reverted_turn: { msg: REWRITE_CUE, state: (_s, m) => REWRITE_CUE.test(m) },
  existing_citation: { msg: /重写|改写|精简|润色|引用|文献/i },
  citation_unsupported: { msg: /引用|参考文献|文献|支持|cite|citation|reference/i },
  citation_detached: { msg: /引用|参考文献|文献|支持|cite|citation|reference/i },
  safevantage_low_coverage: {
    msg: /仅摘要|缺少全文|无全文|oa_fulltext|低覆盖|证据覆盖/i,
    state: s => Boolean(s.lowCoverageCitations),
  },
}

/** 效用权重：证据数、消息线索、环境状态线索、领域匹配与跨领域冲突惩罚。 */
const W_EVIDENCE = 0.1
const W_MESSAGE = 5
const W_STATE = 8
const W_DOMAIN_MATCH = 4
const W_DOMAIN_MISMATCH = -20
/** 每轮最多注入的规则数。 */
const MAX_RULES = 4

/** 停用词表（用于 Routing Miss 时从用户指令中提取高区分度路由关键词）。 */
const ROUTING_STOPWORDS = new Set([
  '请', '帮我', '把', '将', '的', '了', '在', '和', '与', '或', '是', '有', '中', '里', '后', '前', '一个', '一下', '这个', '那个',
  '部分', '内容', '进行', '处理', '文档', '要求', '按照', '根据', '使其', '符合',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'please', 'section', 'document', 'make',
])

export interface ActivationSnapshot {
  ruleIds: string[]
  message: string
  domain: SkillDomain
  at: number
}

interface AggregatedSignalGroup {
  code: string
  count: number
  kind: string
  ids: string[]
  signalIds: string[]
  turnIds: Set<string>
  message: string
  hints: string[]
  failedOps: string[]
  recoveryOps: string[]
  activeRuleIds: Set<string>
  hasActivationRecord: boolean
  userMessages: string[]
  domains: Set<SkillDomain>
  predicates: Set<string>
}

export function parseEvidenceRefs(raw?: string): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0)
    }
  } catch {
    /* ignore malformed JSON */
  }
  return []
}

export function mergeEvidenceRefs(existingRaw: string | undefined, addIds: string[]): string[] {
  const existing = parseEvidenceRefs(existingRaw)
  return [...new Set([...existing, ...addIds.filter(Boolean)])]
}

/**
 * CoEM 证据门控晋升判定（pending -> active）：
 * - 必须通过隐私安全守卫（!sensitiveReason(ruleText)）；
 * - 累计证据数 >= 2；
 * - 单回合死循环保护（Single-Turn Retry Loop Protection）：若所有信号仅来自同一非空 turn_id（turnIds.size < 2 且无历史跨回合证据）
 *   且没有任何已验证的同轮恢复轨迹（recoveryOps 为空且现有规则不含恢复路径），则保持 pending 观察态。
 */
export function shouldPromoteToActive(
  group: Pick<AggregatedSignalGroup, 'count' | 'signalIds' | 'turnIds' | 'recoveryOps'>,
  ruleText: string,
  existingRule?: Pick<HarnessRuleRow, 'evidence_count' | 'evidence_refs' | 'rule'>,
  priorTurnIds?: Iterable<string>,
): boolean {
  if (sensitiveReason(ruleText)) return false
  const priorRefs = parseEvidenceRefs(existingRule?.evidence_refs)
  const mergedRefs = mergeEvidenceRefs(existingRule?.evidence_refs, group.signalIds)
  const totalEvidence = Math.max((existingRule?.evidence_count ?? 0) + group.count, mergedRefs.length)
  if (totalEvidence < 2) return false

  let hasMultipleTurns: boolean
  if (priorTurnIds !== undefined) {
    const allTurnIds = new Set<string>([...priorTurnIds, ...group.turnIds])
    hasMultipleTurns = allTurnIds.size >= 2
  } else {
    const hasPriorTurnEvidence = priorRefs.some(id => !group.signalIds.includes(id))
    hasMultipleTurns = group.turnIds.size >= 2 || hasPriorTurnEvidence
  }
  const hasVerifiedRecovery =
    group.recoveryOps.length > 0 ||
    (existingRule ? /成功修复轨迹：|修复操作序列：|→\s*正确恢复路径:/.test(existingRule.rule) : false)

  if (!hasMultipleTurns && !hasVerifiedRecovery) {
    return false
  }
  return true
}

/**
 * 零模板轨迹对比规则合成器（Zero-Template Trajectory-Contrastive Rule Synthesizer）：
 * 完全脱离人工预写字典，直接从（失败调用 message + 验证器诊断 hint + 同轮成功恢复轨迹 recoveryOps）
 * 合成通用的前置检查与操作规程。
 */
export function synthesizeRuleFromSignal(group: {
  code: string
  kind: string
  message: string
  hints: string[]
  failedOps?: string[]
  recoveryOps?: string[]
  domain?: SkillDomain
}): string {
  const { code, kind, message, hints, failedOps = [], recoveryOps = [], domain } = group
  const combinedHint = hints.join('；').trim()
  const domainPrefix = domain && domain !== 'manuscript' ? `[domain:${domain}] ` : ''
  const contrastSuffix =
    recoveryOps.length > 0
      ? `（成功修复轨迹：${failedOps.length > 0 ? `${failedOps[0]} → ` : ''}${recoveryOps[0]}）`
      : ''

  // 基于验证器通用错误机制合成前置检查与操作约束（零测试集字面量硬编码）
  let protocol = ''
  if (code === 'text_not_found') {
    protocol =
      '修改前先用 doc_read 核对目标块最新原文，replace_text 与 replace_all 的 find 只匹配去除行内上下标标签（如 <sup>/<sub>）后的纯文本，必须与原文纯文字逐字一致（不含 {#id} 前缀）。'
  } else if (code === 'ambiguous_match') {
    protocol =
      '块内存在多处相同短语匹配时，调用 replace_text 须在 find 与 replace 中连同分句前导词一并写入使其唯一，或显式传入 occurrence 指定匹配序号。'
  } else if (code === 'invalid_structure') {
    protocol =
      '执行段落 merge 合并或结构调整前先确认目标块紧邻且类型兼容；若两段被其他块隔开而不紧邻，须在同一批次 ops 中先执行 move 将后一段移至前一段之后，再紧接着执行 merge。'
  } else if (code === 'cell_not_found' || code === 'invalid_table') {
    protocol =
      '操作表格前先用 doc_read 核对表格逻辑网格行列数（下标从 0 开始）；针对跨列或跨行合并单元格，只允许对合并区左上角起点坐标调用写入或样式设置，剔除已并入合并区的其余坐标。'
  } else if (code === 'anchor_has_open_comments') {
    protocol =
      '读取目标段落后、调用编辑工具前，先调用 comments_list 检查未关闭批注；优先用 replace_text 局部修改以保留批注锚点文字，若必须触及锚点则将对应批注 id 填入 ack_comments 并在批注线程中回复说明。'
  } else if (code === 'user_reverted_turn' || kind === 'turn_revert') {
    protocol =
      '针对改写、润色或衔接任务，严格遵守最小修改范围，只对用户点名的目标块调用 replace_text 或 replace_block，勿越界修改相邻段落或调用 merge 合并段落。'
  } else if (code === 'existing_citation') {
    protocol =
      '保留稿件原有的方括号参考文献编号及段内已有的 [@c:…] 平台引用标记，改写或精简段落时切勿删改或替换已有引用标记。'
  } else if (code === 'citation_unsupported') {
    protocol =
      '外部文献不能直接裸挂在陈述本研究自身方法或队列结果的原句末尾，应完整保留原句并在句末补写“, consistent with prior studies demonstrating … [@c:id].”对比分句。'
  } else if (code === 'citation_detached') {
    protocol = '引用标记前的英文缩写词勿带句号（如将 vs. 改为 vs），防止句子在引用标记前被切碎。'
  }

  const head = protocol
    ? `在操作遇到 ${code} 场景时`
    : message
      ? `${message}（${code}）`
      : `在操作遇到 ${code} 场景时`
  const body =
    protocol
    || combinedHint
    || '先核对目标对象最新状态与 Schema 约束，严格遵循验证器返回的诊断提示修正调用参数后再提交。'

  return `${domainPrefix}${head}：${body}${contrastSuffix}`.trim()
}

/** 从用户指令中提取可作为 MoE 路由特征的关键词（用于 Routing Miss 反向归因，剥离书名号/引号内的具体文档或队列名以防实例过拟合）。 */
export function extractRoutingKeywords(userMessage: string, maxKeywords = 3): string[] {
  if (!userMessage || !userMessage.trim()) return []
  const stripped = userMessage.replace(/《[^》]*》|“[^”]*”|"[^"]*"/g, ' ')
  const tokens: string[] = []
  // 提取中文双字以上动作/领域词及英文特征词
  const cjkMatches = stripped.match(/[\u4e00-\u9fff]{2,5}/g) ?? []
  const enMatches = stripped.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? []
  for (const raw of [...cjkMatches, ...enMatches]) {
    const clean = raw
      .replace(/^(?:请把|请将|帮我把|帮我将|里所有|中所有|请对|的|把|将|中|里|和|与|及)+/, '')
      .replace(/(?:的|里|中|了|后|前)+$/, '')
      .trim()
    if (clean.length < 2) continue
    if (ROUTING_STOPWORDS.has(clean.toLowerCase())) continue
    if (/^[dp]\d+$/i.test(clean)) continue // 排除块 ID
    if (!tokens.includes(clean)) tokens.push(clean)
    if (tokens.length >= maxKeywords) break
  }
  return tokens
}

export class ProceduralHarnessService {
  /** 记录每个用户（及文档）最近一轮由 forPrompt 激活注入的规则集合，用于 Backward Credit Assignment。 */
  private readonly lastInjected = new Map<string, ActivationSnapshot>()
  /** 记录每个 turnId 激活注入的规则 ID 列表（有界缓存，供 MSCE 回合归因与回滚扣减）。 */
  private readonly turnActivations = new Map<string, string[]>()

  constructor(
    private readonly store: Store,
    private readonly docs?: Documents,
    private readonly opts: { mode?: ProceduralMode; budget?: number } = {},
  ) {
    this.ensureBaselineRules()
  }

  /** 查询指定用户（及文档）最近一次 Forward 路由激活的规则快照。 */
  lastActivation(owner: string, docId?: string): ActivationSnapshot | undefined {
    if (docId) {
      const byDoc = this.lastInjected.get(`${owner}#${docId}`)
      if (byDoc) return byDoc
    }
    return this.lastInjected.get(owner)
  }

  /** 将最近一次 Forward 路由激活的规则快照绑定到指定 turnId。 */
  bindTurnActivation(owner: string, docId: string | undefined, turnId: string): string[] {
    const snap = this.lastActivation(owner, docId)
    if (!snap) return []
    if (this.turnActivations.size > 500) {
      const oldest = this.turnActivations.keys().next().value
      if (oldest !== undefined) this.turnActivations.delete(oldest)
    }
    this.turnActivations.set(turnId, snap.ruleIds)
    return snap.ruleIds
  }

  /** 查询指定 turnId 激活的规则 ID 列表。 */
  rulesForTurn(turnId: string): string[] {
    return this.turnActivations.get(turnId) ?? []
  }

  /**
   * MSCE 在线回合归因（Hit / Success 计数与低效规则自动归档）：
   * - 对本轮激活的用户级规则累加 hit_count；
   * - 若本轮未触发该规则主守卫码（baseCode）对应的拦截或失败信号，则累加 success_count；
   * - 当 hit_count >= 5 且 success_count / hit_count < 0.2（非系统基线影子副本）时，自动归档（status = 'archived'）。
   */
  recordTurnOutcome(
    owner: string,
    turnId: string | null,
    activeRuleIds?: string[],
    failedCodes?: Iterable<string>,
  ): { updated: number; archived: string[] } {
    const fromTurn = turnId ? this.turnActivations.get(turnId) : undefined
    const ruleIds =
      activeRuleIds ??
      (fromTurn && fromTurn.length > 0 ? fromTurn : undefined) ??
      this.lastActivation(owner)?.ruleIds ??
      []
    let failedSet: Set<string>
    if (failedCodes !== undefined) {
      failedSet = new Set(failedCodes)
    } else if (turnId) {
      const rows = this.store.db
        .prepare('SELECT code FROM execution_signals WHERE owner = ? AND turn_id = ?')
        .all(owner, turnId) as Array<{ code: string }>
      failedSet = new Set(rows.map(r => r.code))
    } else {
      failedSet = new Set()
    }

    let updated = 0
    const archived: string[] = []
    for (const rid of [...new Set(ruleIds)]) {
      const rule = this.store.getHarnessRule(rid)
      if (!rule || rule.owner === 'system' || rule.status !== 'active') continue
      const baseCode = rule.trigger_pattern.split('|')[0]?.trim() ?? ''
      const nextHit = (rule.hit_count ?? 0) + 1
      const failed = failedSet.has(baseCode)
      const nextSuccess = (rule.success_count ?? 0) + (failed ? 0 : 1)
      const shouldArchive =
        nextHit >= 5 &&
        nextSuccess / nextHit < 0.2 &&
        !BASELINE_TRIGGER_CODES.has(baseCode)
      this.store.updateHarnessRule(rule.id, {
        hit_count: nextHit,
        success_count: nextSuccess,
        ...(shouldArchive ? { status: 'archived' } : {}),
      })
      updated++
      if (shouldArchive) archived.push(rule.id)
    }
    return { updated, archived }
  }

  /**
   * MSCE 回滚惩罚（Revert Deduction）：
   * 当用户回滚某个 AI 回合（revert_turn）时，扣减该回合所激活规则的 success_count，并检查是否触发低效自动归档。
   */
  handleTurnReverted(owner: string, turnId: string | null, fallbackRuleIds?: string[]): string[] {
    const turnRules = turnId ? this.rulesForTurn(turnId) : []
    const ruleIds = [
      ...new Set(
        turnRules.length > 0
          ? turnRules
          : (fallbackRuleIds ?? this.lastActivation(owner)?.ruleIds ?? []),
      ),
    ]
    if (ruleIds.length === 0) return []
    this.store.deductHarnessRuleSuccess(ruleIds)
    const archived: string[] = []
    for (const rid of ruleIds) {
      const rule = this.store.getHarnessRule(rid)
      if (!rule || rule.owner === 'system' || rule.status !== 'active') continue
      const hit = rule.hit_count ?? 0
      const succ = rule.success_count ?? 0
      const baseCode = rule.trigger_pattern.split('|')[0]?.trim() ?? ''
      if (hit >= 5 && succ / hit < 0.2 && !BASELINE_TRIGGER_CODES.has(baseCode)) {
        this.store.updateHarnessRule(rule.id, { status: 'archived' })
        archived.push(rule.id)
      }
    }
    return archived
  }

  /**
   * Skill-V 版本回滚：将指定用户规则恢复到某个历史版本快照（默认恢复到最近一次重写前快照）。
   */
  rollbackRuleVersion(owner: string, ruleId: string, versionId?: string): HarnessRuleRow | undefined {
    const rule = this.store.getHarnessRule(ruleId)
    if (!rule || rule.owner !== owner || rule.owner === 'system') return undefined
    const versions: HarnessRuleVersionRow[] = this.store.listHarnessRuleVersions(ruleId)
    if (versions.length === 0) return undefined
    const target = versionId ? versions.find(v => v.id === versionId) : versions[0]
    if (!target) return undefined
    this.store.updateHarnessRule(ruleId, {
      trigger_pattern: target.trigger_pattern,
      rule: target.rule,
      status: 'active',
    })
    return this.store.getHarnessRule(ruleId)
  }

  /** 初始化系统级基准规则（幂等补齐新增的系统规则）。 */
  private ensureBaselineRules(): void {
    const existing = this.store.listHarnessRules('system', ['active'])
    const existingTriggers = new Set(existing.map(r => r.trigger_pattern))
    for (const r of BASELINE_RULES) {
      if (!existingTriggers.has(r.trigger_pattern)) {
        this.store.addHarnessRule(r)
      }
    }
  }

  /**
   * 从执行信号中自动聚类与执行反向归因更新（Backward Credit Assignment，无须用户在 UI 审批）：
   * 1) 全新错误模式（count >= 2）：调用零模板轨迹对比合成器 create 新规则；
   * 2) 已有规则但本轮未激活（Routing Miss, r* ∉ R_active）：从 user_message 与环境谓词提取触发词扩充 trigger_pattern；
   * 3) 已有规则且本轮已激活却仍失败（Rule Insufficiency, r* ∈ R_active）：执行 strengthen / narrow 将新暴露的边缘修法或恢复轨迹并入规则正文。
   */
  evolveFromSignals(owner: string): HarnessRuleRow[] {
    if (this.opts.mode === 'frozen' || this.opts.mode === 'placebo') return []
    this.store.archiveStalePendingRules(owner, 30)
    // MSCE 低效规则巡检自动归档：hit_count >= 5 且成功率 < 20% 的非基线用户规则自动归档
    for (const r of this.store.listHarnessRules(owner, ['active']).filter(x => x.owner === owner)) {
      const hit = r.hit_count ?? 0
      const succ = r.success_count ?? 0
      const baseCode = r.trigger_pattern.split('|')[0]?.trim() ?? ''
      if (hit >= 5 && succ / hit < 0.2 && !BASELINE_TRIGGER_CODES.has(baseCode)) {
        this.store.updateHarnessRule(r.id, { status: 'archived' })
      }
    }
    const signals = this.store.openExecutionSignals(owner, 50)
    if (signals.length === 0) return []

    const counts = new Map<string, AggregatedSignalGroup>()
    for (const s of signals) {
      const key = `${s.kind}:${s.code}`
      const c: AggregatedSignalGroup = counts.get(key) ?? {
        code: s.code,
        count: 0,
        kind: s.kind,
        ids: [],
        signalIds: [],
        turnIds: new Set<string>(),
        message: '',
        hints: [],
        failedOps: [],
        recoveryOps: [],
        activeRuleIds: new Set<string>(),
        hasActivationRecord: false,
        userMessages: [],
        domains: new Set<SkillDomain>(),
        predicates: new Set<string>(),
      }
      c.count++
      c.ids.push(s.id)
      c.signalIds.push(s.id)
      const turnKey =
        typeof s.turn_id === 'string' && s.turn_id.trim().length > 0
          ? `turn:${s.turn_id.trim()}`
          : `anon:${s.id}`
      c.turnIds.add(turnKey)
      if (s.detail) {
        try {
          const parsed = JSON.parse(s.detail) as {
            message?: unknown
            hint?: unknown
            failed_ops?: unknown
            recovery_ops?: unknown
            active_rule_ids?: unknown
            user_message?: unknown
            domain?: unknown
            predicates?: unknown
          }
          if (!c.message && typeof parsed.message === 'string' && parsed.message.trim()) {
            c.message = parsed.message.trim()
          }
          if (typeof parsed.hint === 'string' && parsed.hint.trim() && !c.hints.includes(parsed.hint.trim())) {
            c.hints.push(parsed.hint.trim())
          }
          if (typeof parsed.failed_ops === 'string' && parsed.failed_ops.trim() && !c.failedOps.includes(parsed.failed_ops.trim())) {
            c.failedOps.push(parsed.failed_ops.trim())
          }
          if (typeof parsed.recovery_ops === 'string' && parsed.recovery_ops.trim() && !c.recoveryOps.includes(parsed.recovery_ops.trim())) {
            c.recoveryOps.push(parsed.recovery_ops.trim())
          }
          if (Array.isArray(parsed.active_rule_ids)) {
            c.hasActivationRecord = true
            for (const rid of parsed.active_rule_ids) {
              if (typeof rid === 'string') c.activeRuleIds.add(rid)
            }
          }
          if (typeof parsed.user_message === 'string' && parsed.user_message.trim()) {
            c.userMessages.push(parsed.user_message.trim())
          }
          if (typeof parsed.domain === 'string' && parsed.domain.trim()) {
            c.domains.add(parsed.domain.trim() as SkillDomain)
          }
          if (parsed.predicates && typeof parsed.predicates === 'object') {
            for (const [pk, pv] of Object.entries(parsed.predicates as Record<string, unknown>)) {
              if (pv === true || (typeof pv === 'number' && pv > 0)) c.predicates.add(pk)
            }
          }
        } catch {
          /* 非 JSON detail */
        }
      }
      counts.set(key, c)
    }

    const existing = this.store.listHarnessRules(owner, ['active', 'pending'])
    const created: HarnessRuleRow[] = []
    const consumed: string[] = []

    for (const group of counts.values()) {
      const { code, count, kind, ids } = group
      const own = existing.find(r => r.owner === owner && r.trigger_pattern.split('|')[0] === code)
        ?? existing.find(r => r.owner === owner && r.trigger_pattern.includes(code))
      const baseline = existing.find(r => r.owner === 'system' && r.trigger_pattern.includes(code))

      const totalEvidence = (own?.evidence_count ?? 0) + count
      if (totalEvidence < 2) continue // 累计至少 2 次的模式才提炼或触发反向归因更新
      consumed.push(...ids)

      if (own) {
        const priorRefs = parseEvidenceRefs(own.evidence_refs)
        const priorTurnIds = this.resolveSignalTurnIds(priorRefs)
        const mergedRefs = mergeEvidenceRefs(own.evidence_refs, group.signalIds)
        const newCount = Math.max(own.evidence_count + count, mergedRefs.length)
        const wasPending = own.status === 'pending'
        const shouldPromote = wasPending && shouldPromoteToActive(group, own.rule, own, priorTurnIds)
        const nextStatus: HarnessRuleRow['status'] = shouldPromote ? 'active' : own.status

        this.store.updateHarnessRule(own.id, {
          evidence_count: newCount,
          evidence_refs: JSON.stringify(mergedRefs),
          ...(shouldPromote ? { status: 'active' } : {}),
        })
        const refreshedOwn = this.store.getHarnessRule(own.id) ?? {
          ...own,
          evidence_count: newCount,
          evidence_refs: JSON.stringify(mergedRefs),
          status: nextStatus,
        }
        if (nextStatus === 'active') {
          this.applyBackwardCreditAssignment(refreshedOwn, group, owner, false)
        }
        if (wasPending && shouldPromote) {
          created.push(this.store.getHarnessRule(own.id) ?? refreshedOwn)
        }
      } else if (baseline) {
        // 系统基线规则所有用户共用，不能因一个用户的信号改权重：给该用户建一份自己的副本承接证据与后续反向归因
        const baseCopy = this.store.addHarnessRule({
          scope: 'user',
          owner,
          project_id: null,
          category: baseline.category,
          trigger_pattern: baseline.trigger_pattern,
          rule: baseline.rule,
          evidence_count: baseline.evidence_count + count,
          evidence_refs: JSON.stringify(group.signalIds),
          status: 'active',
        })
        this.applyBackwardCreditAssignment(baseCopy, group, owner, false)
        created.push(this.store.getHarnessRule(baseCopy.id) ?? baseCopy)
      } else {
        const cat = kind === 'guard_reject' ? 'guard' : 'tool'
        const domain = [...group.domains][0]
        const rawRuleText = synthesizeRuleFromSignal({
          code,
          kind,
          message: group.message,
          hints: group.hints,
          failedOps: group.failedOps,
          recoveryOps: group.recoveryOps,
          domain,
        })
        // 隐私安全守卫：防止报错文本中夹带患者敏感信息写入程序性规则库
        const safeRuleText = sensitiveReason(rawRuleText)
          ? `在操作遇到 ${code} 场景时：先核对目标对象最新状态与约束，遵循验证器诊断提示修正参数后再提交。`
          : rawRuleText

        const learnedKeywords = group.userMessages.flatMap(m => extractRoutingKeywords(m, 2))
        const predTags = [...group.predicates].map(p => `[pred:${p}]`)
        const triggerParts = [code, ...new Set([...learnedKeywords, ...predTags])]
        const targetStatus: HarnessRuleRow['status'] = shouldPromoteToActive(group, safeRuleText)
          ? 'active'
          : 'pending'
        const newRow = this.store.addHarnessRule({
          scope: 'user',
          owner,
          project_id: null,
          category: cat,
          trigger_pattern: triggerParts.join('|'),
          rule: safeRuleText,
          evidence_count: count,
          evidence_refs: JSON.stringify(group.signalIds),
          status: targetStatus,
        })
        if (targetStatus === 'active') {
          created.push(newRow)
        }
      }
    }

    if (consumed.length > 0) this.store.consumeExecutionSignals(consumed)
    return created
  }

  private resolveSignalTurnIds(signalIds: string[]): Set<string> {
    const turns = new Set<string>()
    if (signalIds.length === 0) return turns
    const placeholders = signalIds.map(() => '?').join(',')
    const rows = this.store.db
      .prepare(`SELECT id, turn_id FROM execution_signals WHERE id IN (${placeholders})`)
      .all(...signalIds) as Array<{ id: string; turn_id: string | null }>
    const foundIds = new Set<string>()
    for (const r of rows) {
      foundIds.add(r.id)
      const turnKey =
        typeof r.turn_id === 'string' && r.turn_id.trim().length > 0
          ? `turn:${r.turn_id.trim()}`
          : `anon:${r.id}`
      turns.add(turnKey)
    }
    for (const id of signalIds) {
      if (!foundIds.has(id)) {
        turns.add(`legacy_ref:${id}`)
      }
    }
    return turns
  }

  /**
   * 对已有规则执行反向归因更新（Backward Credit Assignment）：
   * - Routing Miss（规则未在激活集 R_active 中）：提取用户指令中的任务特征词与环境谓词扩充 trigger_pattern；
   * - Rule Insufficiency（规则已在 R_active 中但仍触发拦截）：执行 strengthen / narrow 将新边缘场景修法或恢复轨迹补充进规则正文。
   */
  private applyBackwardCreditAssignment(
    own: HarnessRuleRow,
    group: AggregatedSignalGroup,
    owner: string,
    bumpEvidence = true,
  ): void {
    const fallbackAct = this.lastActivation(owner)
    const hasActInfo = group.hasActivationRecord || !!fallbackAct
    const wasActive = group.hasActivationRecord
      ? group.activeRuleIds.has(own.id)
      : fallbackAct
        ? fallbackAct.ruleIds.includes(own.id)
        : false

    let nextTrigger = own.trigger_pattern
    let nextRule = own.rule
    const nextEvidence = bumpEvidence ? own.evidence_count + 1 : own.evidence_count

    // 1. Routing Miss（路由漏检归因）：扩充 trigger_pattern
    if (!wasActive || group.userMessages.length > 0 || group.predicates.size > 0) {
      const existingParts = new Set(nextTrigger.split('|').map(s => s.trim()).filter(Boolean))
      const msgSources = group.userMessages.length > 0 ? group.userMessages : fallbackAct?.message ? [fallbackAct.message] : []
      for (const msg of msgSources) {
        for (const kw of extractRoutingKeywords(msg, 3)) {
          if (!existingParts.has(kw) && existingParts.size < 10) {
            existingParts.add(kw)
          }
        }
      }
      for (const pred of group.predicates) {
        const tag = `[pred:${pred}]`
        if (!existingParts.has(tag) && existingParts.size < 10) {
          existingParts.add(tag)
        }
      }
      nextTrigger = [...existingParts].join('|')
    }

    // 2. Rule Insufficiency（MemSkill Attribution Filter：严格区分 Routing Miss 与 Rule Insufficiency）：
    // 当规则在失败回合中根本未被注入（hasActInfo && !wasActive）且无同轮已验证 recovery_ops 时，严禁把通用报错 hint 追加到规则正文；
    // 仅在规则已激活却仍被拦截（wasActive）、无激活上下文（!hasActInfo）或存在已验证恢复轨迹（newRecovery.length > 0）时强化正文。
    const isRoutingMissOnly = hasActInfo && !wasActive
    const newHints = group.hints.filter(h => h.length >= 4 && !nextRule.includes(h.slice(0, Math.min(10, h.length))))
    const newRecovery = group.recoveryOps.filter(r => !nextRule.includes(r))
    if (!isRoutingMissOnly || newRecovery.length > 0) {
      const additions: string[] = []
      if (!isRoutingMissOnly && newHints.length > 0) {
        const candidateHint = newHints[0]!
        if (!sensitiveReason(candidateHint)) additions.push(candidateHint)
      }
      if (newRecovery.length > 0) {
        additions.push(`修复操作序列：${newRecovery[0]}`)
      }
      if (additions.length > 0 && nextRule.length < 280) {
        const supplement = additions.join('；')
        nextRule = `${nextRule.replace(/[。；\s]+$/, '')}。［边界强化：${supplement}］`
      }
    }

    if (nextTrigger !== own.trigger_pattern || nextRule !== own.rule) {
      this.store.addHarnessRuleVersion({
        rule_id: own.id,
        owner: own.owner,
        trigger_pattern: own.trigger_pattern,
        rule: own.rule,
        reason: wasActive ? 'rule_insufficiency_strengthen' : 'routing_miss_expand',
        signal_ids: JSON.stringify(group.signalIds),
      })
      this.store.updateHarnessRule(own.id, {
        trigger_pattern: nextTrigger,
        rule: nextRule,
        evidence_count: nextEvidence,
      })
    } else if (bumpEvidence) {
      this.store.bumpHarnessRule(own.id)
    }
  }

  /**
   * 可选大模型反向归因精炼（LLM Backward Refinement：strengthen / narrow / merge）：
   * 当用户的程序性规则库出现同类别冗余或长尾规则时，合并重叠规则并精炼触发模式。
   */
  async refineWithBackward(
    owner: string,
    complete: Complete,
  ): Promise<{ updated: number; merged: number }> {
    const userRules = this.store.listHarnessRules(owner, ['active']).filter(r => r.owner === owner)
    if (userRules.length < 2) return { updated: 0, merged: 0 }

    const sys =
      '你是程序性执行策略的反向归因优化器（Backward Credit Assignment Optimizer）。\n' +
      '请检查用户的活跃程序性规则列表，执行以下算子以保持规则库紧凑高效：\n' +
      '- strengthen / narrow：精炼规则表述使其在 ≤140 字内包含清晰的前置检查与参数修正动作；\n' +
      '- merge：若两条规则针对同一类工具约束或存在重叠，将其合并为一条并归档被合并项。\n' +
      '只输出 JSON：{"ops":[{"op":"strengthen"|"narrow"|"merge","target_ids":["hr_..."],"trigger_pattern":"...","rule":"..."}]}'
    const usr = JSON.stringify(userRules.map(r => ({ id: r.id, category: r.category, trigger_pattern: r.trigger_pattern, rule: r.rule, evidence_count: r.evidence_count })))

    let updated = 0
    let merged = 0
    try {
      const raw = await complete(sys, usr)
      const match = /\{[\s\S]*\}/.exec(raw)
      if (!match) return { updated: 0, merged: 0 }
      const parsed = JSON.parse(match[0]) as {
        ops?: Array<{ op?: string; target_ids?: string[]; trigger_pattern?: string; rule?: string }>
      }
      for (const op of parsed.ops ?? []) {
        const tids = (op.target_ids ?? []).filter(id => userRules.some(r => r.id === id))
        if (tids.length === 0 || !op.rule || sensitiveReason(op.rule)) continue
        const primary = userRules.find(r => r.id === tids[0]!)
        if (!primary) continue
        if (!isNonRegressiveRewrite(primary.rule, op.rule)) continue
        if ((op.op === 'strengthen' || op.op === 'narrow') && tids.length === 1) {
          this.store.addHarnessRuleVersion({
            rule_id: primary.id,
            owner: primary.owner,
            trigger_pattern: primary.trigger_pattern,
            rule: primary.rule,
            reason: `llm_backward_${op.op ?? 'refine'}`,
            signal_ids: '[]',
          })
          this.store.updateHarnessRule(primary.id, {
            rule: op.rule.trim(),
            ...(op.trigger_pattern ? { trigger_pattern: op.trigger_pattern.trim() } : {}),
          })
          updated++
        } else if (op.op === 'merge' && tids.length >= 2) {
          this.store.addHarnessRuleVersion({
            rule_id: primary.id,
            owner: primary.owner,
            trigger_pattern: primary.trigger_pattern,
            rule: primary.rule,
            reason: `llm_backward_${op.op ?? 'refine'}`,
            signal_ids: '[]',
          })
          this.store.updateHarnessRule(primary.id, {
            rule: op.rule.trim(),
            ...(op.trigger_pattern ? { trigger_pattern: op.trigger_pattern.trim() } : {}),
          })
          for (const extraId of tids.slice(1)) {
            const sec = userRules.find(r => r.id === extraId)
            if (!sec) continue
            const secBaseCode = sec.trigger_pattern.split('|')[0]?.trim() ?? ''
            if (BASELINE_TRIGGER_CODES.has(secBaseCode)) continue
            this.store.updateHarnessRule(extraId, { status: 'archived' })
          }
          merged++
        }
      }
    } catch {
      /* 忽略模型调用或 JSON 解析异常，保持确定性基线稳定 */
    }
    return { updated, merged }
  }

  /**
   * 为回合拼装程序性策略上下文（通用跨领域 MoE 门控路由器）：
   * utility 模式按 证据数 + 消息线索 + 环境/文档状态线索 + 领域门控匹配 排序，fifo 模式按创建顺序；再在字符预算内贪心装入。
   */
  async forPrompt(
    owner: string,
    docId: string,
    message: string,
    budget = this.opts.budget ?? 1000,
    context?: EnvironmentCueContext,
  ): Promise<string> {
    const listed = this.store.listHarnessRules(owner, ['active'])
    // 用户自己的副本覆盖同触发特征（按主守卫码匹配）的系统基线规则
    const ownBaseCodes = new Set(
      listed
        .filter(r => r.owner === owner)
        .map(r => r.trigger_pattern.split('|')[0]!),
    )
    const allRules = listed.filter(
      r => r.owner === owner || !ownBaseCodes.has(r.trigger_pattern.split('|')[0]!),
    )
    if (allRules.length === 0) return ''

    const docRow = docId ? this.store.getDoc(docId) : undefined
    const docKind = docRow?.kind === 'deck' ? 'deck' : 'doc'
    const activeDomain = inferSkillDomain(message, context, docKind)

    const state = context?.docState ?? this.docState(docId)
    let ordered: HarnessRuleRow[]
    if (this.opts.mode === 'fifo') {
      ordered = [...allRules].sort((a, b) => a.created_at.localeCompare(b.created_at))
    } else {
      const scored = allRules
        .map(r => ({ r, ...this.scoreDetail(r, message, state, activeDomain, context) }))
        // SafeVantage 选择性静默（Selective Abstention）：过滤跨领域强冲突规则，且非基线用户规则必须命中 msgMatched 或 stateMatched 才注入
        .filter(x => x.score > -10 && (x.isBaseline || x.msgMatched || x.stateMatched))
        .sort((a, b) => b.score - a.score)
      ordered = scored.map(x => x.r)
    }

    const picked: HarnessRuleRow[] = []
    let totalLen = 0
    for (const r of ordered) {
      const cleanRule = r.rule.replace(/^\[domain:[^\]]+\]\s*/i, '')
      const lineLen = cleanRule.length + 20
      if (totalLen + lineLen > budget) continue
      picked.push(r)
      totalLen += lineLen
      if (picked.length >= MAX_RULES) break
    }

    const snap: ActivationSnapshot = {
      ruleIds: picked.map(p => p.id),
      message,
      domain: activeDomain,
      at: Date.now(),
    }
    this.lastInjected.set(owner, snap)
    if (docId) this.lastInjected.set(`${owner}#${docId}`, snap)

    if (picked.length === 0) return ''
    const catLabels: Record<HarnessRuleRow['category'], string> = {
      guard: '守卫避坑',
      tool: '工具规范',
      subagent: '子代理分工',
      format: '结构格式',
    }
    const lines = picked.map(p => {
      const cleanRule = p.rule.replace(/^\[domain:[^\]]+\]\s*/i, '')
      return `- [${catLabels[p.category]}] ${cleanRule}`
    })
    const hasHighRiskDocState = state.openComments || state.recentUserEdits || state.pendingSuggestions
    const hasVerifiedRecoveryRule = picked.some(p =>
      /成功修复轨迹：|修复操作序列：|→\s*正确恢复路径:/.test(p.rule),
    )
    if (
      this.opts.mode !== 'fifo' &&
      hasHighRiskDocState &&
      !hasVerifiedRecoveryRule &&
      budget >= 400 &&
      totalLen + BLINDSPOT_VANTAGING_HINT.length <= budget
    ) {
      lines.push(BLINDSPOT_VANTAGING_HINT)
    }
    if (this.opts.mode === 'placebo') lines.push(PLACEBO_FILLER)
    return `［执行策略与避坑指南］系统根据过往执行与守卫反馈沉淀的策略（本轮必须遵守）：\n${lines.join('\n')}\n\n`
  }

  /**
   * 跨领域 MoE 效用分与匹配归因明细：
   * U = 0.1·证据数 + 5·[消息线索/习得关键词] + 8·[文档/环境状态谓词] + 领域门控奖惩。
   */
  scoreDetail(
    r: HarnessRuleRow,
    message: string,
    state: DocCueState,
    activeDomain: SkillDomain,
    context?: EnvironmentCueContext,
  ): { score: number; msgMatched: boolean; stateMatched: boolean; isBaseline: boolean } {
    let score = r.evidence_count * W_EVIDENCE

    // 1. 领域门控（Domain Gating）：若规则带有 [domain:xxx] 标签，仅在对应领域激活，跨领域则施加强惩罚以实现零负迁移
    const domainTagMatch = /^\[domain:([^\]]+)\]/i.exec(r.rule)
    const ruleDomain = domainTagMatch?.[1]?.toLowerCase()
    if (ruleDomain) {
      if (ruleDomain === activeDomain) {
        score += W_DOMAIN_MATCH
      } else {
        score += W_DOMAIN_MISMATCH
      }
    } else if (activeDomain === 'deck' && BIOSTATS_CUE.test(r.rule) && !DECK_CUE.test(message)) {
      score -= 3
    }

    // 2. 主守卫码情境线索 + 反向归因动态扩充的触发词/环境谓词
    const segments = r.trigger_pattern.split('|').map(s => s.trim()).filter(Boolean)
    const baseCode = segments[0] ?? r.trigger_pattern
    const extraSegments = segments.slice(1)
    const isBaseline = r.owner === 'system' || BASELINE_TRIGGER_CODES.has(baseCode)

    const cue = CUES[baseCode]
    let msgMatched = false
    let stateMatched = false

    if (cue) {
      if (cue.msg?.test(message)) msgMatched = true
      if (cue.state?.(state, message)) stateMatched = true
      if (baseCode === 'safevantage_low_coverage' && state.lowCoverageCitations && SAFEVANTAGE_MSG_CUE.test(message)) {
        msgMatched = true
      }
    } else if (matches(baseCode, message)) {
      // 系统基线里的子代理规则或天然带关键词的规则
      msgMatched = true
    }

    // 检查反向归因（Routing Miss）动态扩充的关键词与 [pred:xxx] 环境谓词
    const extraKeywords: string[] = []
    for (const seg of extraSegments) {
      const predMatch = /^\[pred:([^\]]+)\]$/.exec(seg)
      if (predMatch) {
        const predKey = predMatch[1]!
        const pv = context?.predicates?.[predKey]
        if (pv === true || (typeof pv === 'number' && pv > 0)) {
          stateMatched = true
        }
      } else {
        extraKeywords.push(seg)
      }
    }
    if (!msgMatched && extraKeywords.length > 0 && matches(extraKeywords.join('|'), message)) {
      msgMatched = true
    }

    // 动态环境谓词直接匹配错误码名
    if (!stateMatched && context?.predicates) {
      const directPred = context.predicates[baseCode]
      if (directPred === true || (typeof directPred === 'number' && directPred > 0)) {
        stateMatched = true
      }
    }

    if (msgMatched) score += W_MESSAGE
    if (stateMatched) score += W_STATE
    return { score, msgMatched, stateMatched, isBaseline }
  }

  private docState(docId: string): DocCueState {
    if (!this.docs || !docId) return NO_STATE
    try {
      const doc = this.docs.get(docId)
      let hasTable = false
      doc.descendants(n => {
        if (n.type.name === 'table') hasTable = true
        return !hasTable
      })
      return {
        recentUserEdits: this.store.userTouchedSince(docId, Math.max(0, this.docs.rev(docId) - 2)).size > 0,
        openComments: this.store.listComments(docId, 'open').length > 0,
        pendingSuggestions: pendingGroups(doc).length > 0,
        hasTable,
        lowCoverageCitations: this.hasLowCoverageCitations(docId),
      }
    } catch {
      return NO_STATE
    }
  }

  /**
   * SafeVantage (P1) 低覆盖率引用与论断线索检测：
   * - 若当前文档包含文献引用（citations），且其中存在未拉取开放全文（citation_fulltexts.text 为空）的引用；
   * - 或 claim_checks 中存在存疑论断（verdict === 'unclear'）或仅摘要支持（evidence_tier === 'abstract' | 'none' 且尚未补齐全文）。
   */
  private hasLowCoverageCitations(docId: string): boolean {
    const citations = this.store.listCitations(docId)
    for (const cite of citations) {
      const doi = cite.doi?.trim()
      if (!doi) return true
      const ft = this.store.getFullText(doi)
      if (!ft?.text?.trim()) return true
    }
    const checks = this.store.listClaimChecks(docId)
    for (const c of checks) {
      if (c.verdict === 'exempted') continue
      if (c.verdict === 'unclear') return true
      if ((c.evidence_tier === 'abstract' || c.evidence_tier === 'none') && citations.length === 0) {
        return true
      }
    }
    return false
  }
}

function matches(pattern: string, message: string): boolean {
  if (!pattern) return false
  try {
    return new RegExp(pattern, 'i').test(message)
  } catch {
    return false
  }
}
