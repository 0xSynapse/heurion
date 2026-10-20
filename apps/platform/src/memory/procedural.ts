import type { Documents } from '../model/runtime.ts'
import { pendingGroups } from '../ops/suggest.ts'
import type { HarnessRuleRow, Store } from '../store/db.ts'

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
]

/**
 * 注入模式：frozen=只注入已有规则、不沉淀新规则；fifo=按创建顺序注入；utility=按效用排序注入（默认）。
 * 完全关闭（off）由调用方不挂载本服务实现。
 */
export type ProceduralMode = 'frozen' | 'fifo' | 'utility'

/** 本轮文档状态（计算情境线索用）。 */
interface DocState {
  recentUserEdits: boolean
  openComments: boolean
  pendingSuggestions: boolean
  hasTable: boolean
}

const NO_STATE: DocState = { recentUserEdits: false, openComments: false, pendingSuggestions: false, hasTable: false }

const REPLACE_CUE = /替换|改成|改为|换成|措辞|replace/i
const TABLE_CUE = /表格|基线表|单元格|table|cell/i

/**
 * 守卫码 → 情境线索：用户消息里出现的关键词（msg），或文档当前状态（state）。
 * 守卫码本身不会出现在用户消息里，所以不能拿它当触发词去匹配消息。
 * 不在表里的码只按证据数排序。
 */
const CUES: Record<string, { msg?: RegExp; state?: (s: DocState) => boolean }> = {
  conflict_user_edited: { state: s => s.recentUserEdits },
  text_not_found: { msg: REPLACE_CUE, state: s => s.recentUserEdits },
  citation_not_registered: { msg: /doi|pmid|10\.\d{4,9}\/|引用|参考文献|文献|cite|citation|reference/i },
  pending_suggestion: { state: s => s.pendingSuggestions },
  anchor_has_open_comments: { msg: /批注|评论|comment/i, state: s => s.openComments },
  ambiguous_match: { msg: REPLACE_CUE },
  invalid_table: { msg: TABLE_CUE, state: s => s.hasTable },
  cell_not_found: { msg: TABLE_CUE, state: s => s.hasTable },
  user_reverted_turn: { msg: /重写|改写|润色|精简|扩写|rewrite|revise|polish/i },
}

/** 效用权重：证据数、消息线索、文档状态线索。手工设定，未调参。 */
const W_EVIDENCE = 0.1
const W_MESSAGE = 5
const W_STATE = 8
/** 每轮最多注入的规则数。 */
const MAX_RULES = 4

export class ProceduralHarnessService {
  constructor(
    private readonly store: Store,
    private readonly docs?: Documents,
    private readonly opts: { mode?: ProceduralMode; budget?: number } = {},
  ) {
    this.ensureBaselineRules()
  }

  /** 初始化系统级基准规则。 */
  private ensureBaselineRules(): void {
    const existing = this.store.listHarnessRules('system', ['active'])
    if (existing.length === 0) {
      for (const r of BASELINE_RULES) {
        this.store.addHarnessRule(r)
      }
    }
  }

  /** 从执行信号中自动聚类与沉淀经验（无须用户在 UI 审批）。 */
  evolveFromSignals(owner: string): HarnessRuleRow[] {
    if (this.opts.mode === 'frozen') return []
    const signals = this.store.openExecutionSignals(owner, 50)
    if (signals.length === 0) return []

    const counts = new Map<string, { code: string; count: number; kind: string; ids: string[] }>()
    for (const s of signals) {
      const key = `${s.kind}:${s.code}`
      const c = counts.get(key) ?? { code: s.code, count: 0, kind: s.kind, ids: [] }
      c.count++
      c.ids.push(s.id)
      counts.set(key, c)
    }

    const rules = this.store.listHarnessRules(owner, ['active'])
    const created: HarnessRuleRow[] = []

    // 只消费已经提炼过的信号；不足 2 次的留着，跨回合、跨会话继续累积
    const consumed: string[] = []
    for (const { code, count, kind, ids } of counts.values()) {
      if (count < 2) continue // 至少发生 2 次的模式才提炼为固定规则
      consumed.push(...ids)
      const own = rules.find(r => r.owner === owner && r.trigger_pattern.includes(code))
      const baseline = rules.find(r => r.owner === 'system' && r.trigger_pattern.includes(code))
      if (own) {
        this.store.bumpHarnessRule(own.id)
      } else if (baseline) {
        // 系统基线规则所有用户共用，不能因一个用户的信号改权重：给该用户建一份自己的副本承接证据
        created.push(this.store.addHarnessRule({
          scope: 'user',
          owner,
          project_id: null,
          category: baseline.category,
          trigger_pattern: baseline.trigger_pattern,
          rule: baseline.rule,
          evidence_count: baseline.evidence_count + count,
          status: 'active',
        }))
      } else {
        const cat = kind === 'guard_reject' ? 'guard' : 'tool'
        let ruleText = `在操作遇到 ${code} 场景时：优先调用 doc_validate 预检，遵循错误 hint 进行自适应修偏。`
        if (code === 'conflict_user_edited') {
          ruleText = '检测到频繁用户编辑冲突：在编辑前必须先 doc_read 重新获取最新 rev，优先使用 replace_text 避免覆盖冲突。'
        } else if (code === 'citation_not_registered') {
          ruleText = '检测到多次引用未登记拦截：严格执行先 insert_citation 再插入 [@c:id] 的两步工作流。'
        } else if (code === 'user_reverted_turn') {
          ruleText = '用户曾撤销过整个 AI 回合：针对此类敏感章节，修改前多与用户对齐大纲，尽量减小单次修改的颗粒度。'
        }
        const newRow = this.store.addHarnessRule({
          scope: 'user',
          owner,
          project_id: null,
          category: cat,
          trigger_pattern: code,
          rule: ruleText,
          evidence_count: count,
          status: 'active',
        })
        created.push(newRow)
      }
    }

    if (consumed.length > 0) this.store.consumeExecutionSignals(consumed)
    return created
  }

  /**
   * 为回合拼装程序性策略上下文：
   * utility 模式按 证据数 + 消息线索 + 文档状态线索 排序，fifo 模式按创建顺序；再在字符预算内贪心装入。
   */
  async forPrompt(owner: string, docId: string, message: string, budget = this.opts.budget ?? 1000): Promise<string> {
    const listed = this.store.listHarnessRules(owner, ['active'])
    // 用户自己的副本覆盖同触发特征的系统基线规则
    const ownTriggers = new Set(listed.filter(r => r.owner === owner).map(r => r.trigger_pattern))
    const allRules = listed.filter(r => r.owner === owner || !ownTriggers.has(r.trigger_pattern))
    if (allRules.length === 0) return ''

    let ordered: HarnessRuleRow[]
    if (this.opts.mode === 'fifo') {
      ordered = [...allRules].sort((a, b) => a.created_at.localeCompare(b.created_at))
    } else {
      const state = this.docState(docId)
      ordered = allRules
        .map(r => ({ r, score: this.score(r, message, state) }))
        .sort((a, b) => b.score - a.score)
        .map(x => x.r)
    }

    const picked: HarnessRuleRow[] = []
    let totalLen = 0
    for (const r of ordered) {
      const lineLen = r.rule.length + 20
      if (totalLen + lineLen > budget) continue
      picked.push(r)
      totalLen += lineLen
      if (picked.length >= MAX_RULES) break
    }

    if (picked.length === 0) return ''
    const catLabels: Record<HarnessRuleRow['category'], string> = {
      guard: '守卫避坑',
      tool: '工具规范',
      subagent: '子代理分工',
      format: '结构格式',
    }
    return `［执行策略与避坑指南］系统根据过往执行与守卫反馈沉淀的策略（本轮必须遵守）：\n${picked.map(p => `- [${catLabels[p.category]}] ${p.rule}`).join('\n')}\n\n`
  }

  /** 效用分：U = 0.1·证据数 + 5·[消息线索] + 8·[文档状态线索]。 */
  private score(r: HarnessRuleRow, message: string, state: DocState): number {
    let score = r.evidence_count * W_EVIDENCE
    const cue = CUES[r.trigger_pattern]
    if (cue) {
      if (cue.msg?.test(message)) score += W_MESSAGE
      if (cue.state?.(state)) score += W_STATE
    } else if (matches(r.trigger_pattern, message)) {
      // 系统基线里的子代理规则：trigger_pattern 本身就是关键词正则
      score += W_MESSAGE
    }
    return score
  }

  private docState(docId: string): DocState {
    if (!this.docs) return NO_STATE
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
      }
    } catch {
      return NO_STATE
    }
  }
}

function matches(pattern: string, message: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(message)
  } catch {
    return false
  }
}
