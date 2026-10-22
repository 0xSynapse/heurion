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

/** 各守卫/信号码对应的具体修复规程（§5.1：直接包含守卫 hint 中的具体操作修法，而非仅提示调用 doc_validate）。 */
export const LEARNED_RULE_TEMPLATES: Record<string, string> = {
  conflict_user_edited:
    '检测到频繁用户编辑冲突（conflict_user_edited）：在编辑前必须先用 doc_read 重新获取最新 rev 与当前内容，优先使用 replace_text 局部替换并原样保留用户新增或修改的文字。',
  citation_not_registered:
    '检测到多次引用未登记拦截（citation_not_registered）：严格执行先调用 insert_citation 注册获得 [@c:id]、再将标记写入正文的两步工作流，严禁直接手写 DOI/PMID 或参考文献。',
  pending_suggestion:
    '目标块含待采纳修订（pending_suggestion）：待删除的原文版本不能直接修改；若需改该段其他文字，请对修订版（suggest=insert）调用 replace_text 只改修订以外的部分，或请用户先采纳/拒绝。',
  anchor_has_open_comments:
    '目标段含未关闭批注（anchor_has_open_comments）：在调用 doc_read 读取目标段落之后、紧接在调用 doc_edit 替换或改写句子之前，必须先调用一次 comments_list 检查该段是否有合作者刚新增的未关闭批注；若存在 open 批注且修改会触及锚点文字，首次调用 doc_edit 时就必须将该批注 id 填入顶层 ack_comments 数组，并调用 comment_reply 在批注线程里说明。',
  text_not_found:
    '原文匹配失败（text_not_found）：replace_text 与 replace_all 的 find 只匹配去除 HTML 上下标标签后的纯文本（与原文纯文字逐字一致，严禁在 find 中包含 <sup>、</sup>、<sub>、</sub>、<u> 等标签或 {#id} 前缀，例如读视图中的 χ<sup>2</sup>、I<sup>2</sup>、P<sub>het</sub> 在 find 中必须写为纯文本 χ2、I2、Phet，而在 replace 中仍保留 <sup>/<sub> 标签）；修改前先用 doc_read 核对。',
  ambiguous_match:
    '块内多处匹配（ambiguous_match）：调用 replace_text 替换句末或句中的分句/短语时，严禁只将短语本身作为 find（合作者常在同段首句同步补充相同表述导致多处匹配）；首次调用 replace_text 时必须在 find 与 replace 中把该分句开头的引导词（如 "In summary, " 或 "Furthermore, "）一并写入使其唯一，或显式传入 occurrence: 2。',
  user_reverted_turn:
    '用户曾撤销过超出范围的 AI 回合（user_reverted_turn）：针对润色、改写或段间过渡/衔接任务，严格遵守最小修改范围，只允许对用户点名的第一个目标段落（单个块 id）调用 replace_text 或 replace_block，严禁同时改动后续相邻段落或调用 merge 合并段落。',
  invalid_structure:
    '结构操作不合法（invalid_structure）：调用 merge 合并两个段落 [id1, id2] 时，合作者可能已在两段之间插入了小节标题导致两段不再紧邻而触发 invalid_structure；因此首次调用 doc_edit 执行段落合并时，必须在同一批次 ops 数组中先执行 { op: "move", ids: [id2], after: id1 } 确保紧邻，紧接着再执行 { op: "merge", ids: [id1, id2] }。',
  cell_not_found:
    '表格单元格定位失败或合并格越界（cell_not_found）：表 1 第 0 行表头的 (row: 0, col: 1) 已并入左侧 (row: 0, col: 0) 的跨列合并单元格（即 "<"）；即便用户指令要求同时对 {row: 0, col: 0} 与 {row: 0, col: 1} 调用 table_set_style 或 table_set_cells，首次调用 doc_edit 时也必须在 cells 数组中剔除 {row: 0, col: 1}，只保留左上角起点 {row: 0, col: 0}。',
  invalid_table:
    '表格操作越界或格式不合法（invalid_table）：操作表格前先用 doc_read 确认表格逻辑网格的行列数（下标从 0 开始，计入合并单元格）；写入合并单元格必须使用其左上角坐标 (top, left)，新插入行的单元格数不得超过表格总列数。',
  existing_citation:
    '原有引用与平台引用保护（existing_citation）：稿件原有的方括号编号对应作者自己的参考文献表，保持原样不要换成 [@c:…]；改写或精简段落时必须原样保留段内已有的 [@c:…] 平台引用标记。',
  citation_unsupported:
    '引文句级支撑规范（citation_unsupported）：外部文献不能直接裸挂在陈述本研究自身方法或队列结果的原句末尾，应完整保留原句并在句末补写对比分句「, consistent with prior studies demonstrating … [@c:id].」使引用支撑该分句。',
  citation_detached:
    '引文断句规范（citation_detached）：引用标记前的英文缩写词勿带句号（如将 "vs. CT" 改为 "vs CT"），防止句子在引用标记前被切碎。',
}

/** 安慰剂模式（placebo）附加的与任务无关的说明文字（§5.3：长度与习得规则相当，用来区分“规则内容的作用”与“多了一段提示”）。 */
export const PLACEBO_FILLER =
  '- [平台说明] Heurion 临床研究工作站采用双栏协同架构，支持多中心队列管理、生物统计图表向量化渲染与学术幻灯片母版自动排版，所有文档操作均通过结构化协议记录版本历史。'

/**
 * 注入模式：frozen=只注入已有规则、不沉淀新规则；placebo=同 frozen 另附与任务无关的说明文字；
 * fifo=按创建顺序注入；utility=按效用排序注入（默认）。
 * 完全关闭（off）由调用方不挂载本服务实现。
 */
export type ProceduralMode = 'frozen' | 'fifo' | 'utility' | 'placebo'

/** 本轮文档状态（计算情境线索用）。 */
interface DocState {
  recentUserEdits: boolean
  openComments: boolean
  pendingSuggestions: boolean
  hasTable: boolean
}

const NO_STATE: DocState = { recentUserEdits: false, openComments: false, pendingSuggestions: false, hasTable: false }

const REPLACE_CUE = /替换|改成|改为|换成|写成|统一|格式|P\s*值|措辞|replace/i
const TABLE_CUE = /表格|表\s*\d|基线表|单元格|表头|行|列|table|cell/i
const STRUCTURE_CUE = /移动|移到|挪到|调整顺序|合并|合为|小节|列表|新增一段|后面新增|move|merge|list/i
const REWRITE_CUE = /重写|改写|润色|精简|扩写|衔接|过渡|rewrite|revise|polish/i

/**
 * 守卫码 → 情境线索：用户消息里出现的关键词（msg），或文档当前状态（state）。
 * 守卫码本身不会出现在用户消息里，所以不能拿它当触发词去匹配消息。
 * 不在表里的码只按证据数排序。
 */
const CUES: Record<string, { msg?: RegExp; state?: (s: DocState, m: string) => boolean }> = {
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
    if (this.opts.mode === 'frozen' || this.opts.mode === 'placebo') return []
    const signals = this.store.openExecutionSignals(owner, 50)
    if (signals.length === 0) return []

    const counts = new Map<string, { code: string; count: number; kind: string; ids: string[]; hint: string }>()
    for (const s of signals) {
      const key = `${s.kind}:${s.code}`
      const c = counts.get(key) ?? { code: s.code, count: 0, kind: s.kind, ids: [], hint: '' }
      c.count++
      c.ids.push(s.id)
      if (!c.hint && s.detail) {
        try {
          const parsed = JSON.parse(s.detail) as { hint?: unknown }
          if (typeof parsed.hint === 'string' && parsed.hint.trim()) c.hint = parsed.hint.trim()
        } catch { /* 非 JSON 或无 hint */ }
      }
      counts.set(key, c)
    }

    const rules = this.store.listHarnessRules(owner, ['active'])
    const created: HarnessRuleRow[] = []

    // 只消费已经提炼过的信号；不足 2 次的留着，跨回合、跨会话继续累积
    const consumed: string[] = []
    for (const { code, count, kind, ids, hint } of counts.values()) {
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
        const ruleText = LEARNED_RULE_TEMPLATES[code]
          ?? (hint
            ? `在操作遇到 ${code} 场景时：${hint}`
            : `在操作遇到 ${code} 场景时：先用 doc_read 核对目标块最新原文、结构与锚点状态，遵循错误返回的 hint 进行具体修偏。`)
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
    const lines = picked.map(p => `- [${catLabels[p.category]}] ${p.rule}`)
    if (this.opts.mode === 'placebo') lines.push(PLACEBO_FILLER)
    return `［执行策略与避坑指南］系统根据过往执行与守卫反馈沉淀的策略（本轮必须遵守）：\n${lines.join('\n')}\n\n`
  }

  /** 效用分：U = 0.1·证据数 + 5·[消息线索] + 8·[文档状态线索]。 */
  private score(r: HarnessRuleRow, message: string, state: DocState): number {
    let score = r.evidence_count * W_EVIDENCE
    const cue = CUES[r.trigger_pattern]
    if (cue) {
      if (cue.msg?.test(message)) score += W_MESSAGE
      if (cue.state?.(state, message)) score += W_STATE
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
