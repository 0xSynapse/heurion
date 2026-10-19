import type { Documents } from '../model/runtime.ts'
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

export class ProceduralHarnessService {
  constructor(private readonly store: Store, private readonly docs?: Documents) {
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
    const signals = this.store.openExecutionSignals(owner, 50)
    if (signals.length === 0) return []

    const counts = new Map<string, { code: string; count: number; kind: string }>()
    for (const s of signals) {
      const key = `${s.kind}:${s.code}`
      const c = counts.get(key) ?? { code: s.code, count: 0, kind: s.kind }
      c.count++
      counts.set(key, c)
    }

    const rules = this.store.listHarnessRules(owner, ['active'])
    const created: HarnessRuleRow[] = []

    for (const { code, count, kind } of counts.values()) {
      if (count < 2) continue // 至少发生 2 次的模式才提炼为固定规则
      const matched = rules.find(r => r.trigger_pattern.includes(code))
      if (matched) {
        this.store.bumpHarnessRule(matched.id)
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

    this.store.consumeExecutionSignals(signals.map(s => s.id))
    return created
  }

  /**
   * 为回合拼装程序性策略上下文：
   * 结合文档状态（是否有近期用户编辑）和当前消息主题，筛选高置信度的避坑策略。
   */
  async forPrompt(owner: string, docId: string, message: string, budget = 1000): Promise<string> {
    const allRules = this.store.listHarnessRules(owner, ['active'])
    if (allRules.length === 0) return ''

    // 检查当前文档在 base_rev 之后是否有用户改动
    const hasRecentUserEdits = this.docs
      ? this.store.userTouchedSince(docId, Math.max(0, this.docs.rev(docId) - 2)).length > 0
      : false

    const scored = allRules.map(r => {
      let score = r.evidence_count * 0.1
      const pat = new RegExp(r.trigger_pattern, 'i')
      if (pat.test(message)) score += 5
      if (hasRecentUserEdits && r.trigger_pattern.includes('conflict')) score += 8
      if (/doi|pmid|引用|文献/i.test(message) && r.category === 'guard') score += 4
      if (/表|统计|hr|生存/i.test(message) && r.trigger_pattern.includes('survival')) score += 6
      return { r, score }
    }).sort((a, b) => b.score - a.score)

    const picked: HarnessRuleRow[] = []
    let totalLen = 0
    for (const { r } of scored) {
      const lineLen = r.rule.length + 20
      if (totalLen + lineLen > budget) continue
      picked.push(r)
      totalLen += lineLen
      if (picked.length >= 4) break
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
}
