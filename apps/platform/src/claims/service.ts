import type { Node as PMNode } from 'prosemirror-model'
import type { Complete } from '../harness/complete.ts'
import { attachComment, AnchorError } from '../model/anchors.ts'
import { indexById } from '../model/ids.ts'
import { readGrid } from '../model/table-grid.ts'
import type { Documents } from '../model/runtime.ts'
import { relevantPassages, type FullTextClient } from '../literature/fulltext.ts'
import type { PubMedClient } from '../literature/pubmed.ts'
import type { CitationRow, ClaimVerdict, EvidenceTier } from '../store/db.ts'
import { referencePlan } from '../model/references.ts'
import { snapshotText } from '../model/measurements.ts'
import { getDomainSkillAdapter } from '../memory/domain-adapters.ts'
import {
  auditInternalConsistency,
  auditMethodResultConsistency,
  auditSpinAndGuidelines,
  buildManuscriptScratchpad,
  classifySectionRole,
  classifyVerificationTier,
  extractClaims,
  extractTableSummaries,
  isExemptedByActiveRules,
  type Claim,
  type DeepReviewAuditIssue,
  type DeepReviewCategory,
  type ManuscriptScratchpad,
  type SectionRole,
  type TableSummary,
  type VerificationTier,
} from './extract.ts'
import { headingText, isPendingDeletion } from './extract.ts'
import { assessTablesWithVision, rereadTablesWarning, type TableVision } from './table-vision.ts'

/**
 * 论断核对与四阶段深度临床评审服务（M1，PLATFORM.md §5.5 & Google PAT arXiv:2606.28277 扩展）：
 * - Stage 1：章节感知切分（intro / methods / results / discussion）与跨章节共享 Scratchpad 构建；
 * - Stage 2：自适应推理预算分配（light / medium / high）；
 * - Stage 3：并行多维专项深审（Pass A 文献/PMC表格核对 + Pass B 表文算术自洽 + Pass C 统计方法配对 + Pass D Spin/规范）；
 * - Stage 4：全局合成 Judge（跨章节去重、严重度门控、基于自进化记忆过滤假阳性，并挂载为文内批注 {#c:id}）。
 */

const PAGE = 8
/** 给模型的摘要上限（C2 评测：1800 字时六成摘要的结果 / 结论段被截掉，数字类召回低 16 个百分点）。 */
export const ABSTRACT_MAX = 4000

/** 超长摘要截断时优先保留结果与结论段（数字和结论在那里），前面的背景 / 方法按剩余长度保留。 */
export function fitAbstract(abstract: string, max = ABSTRACT_MAX): string {
  if (abstract.length <= max) return abstract
  const m = /\b(RESULTS?|FINDINGS)\b\s*[:：]?/.exec(abstract) ?? /\bCONCLUSIONS?\b\s*[:：]?/.exec(abstract)
  if (!m || m.index === 0) return abstract.slice(0, max)
  const tail = abstract.slice(m.index)
  if (tail.length >= max - 200) return tail.slice(0, max)
  return `${abstract.slice(0, max - tail.length - 3).trimEnd()} … ${tail}`
}

/**
 * 论断核对的判定标准（verifyPrompt 与 C2 评测共用，改这里两边一起变）。
 * v4（四阶段学术审稿工作流）：
 * - 关注数值等价性（如 74% 与 0.74）与效应方向性矛盾；
 * - 结合章节角色（section_role）与核查预算分级（verification_tier: high/medium/light）分配审查力度；
 * - 理由用中文，明确给出【建议修改为】纠正文本。
 */
export const CLAIM_CRITERIA =
  '逐条只依据所引文献的摘要（以及给出的开放获取全文与表格片段）判断，不凭记忆补充：' +
  'supported = 摘要或全文/表格支持该句的说法与数字（注意百分比与小数等价性，如 74% 与 0.74 视为一致）；' +
  'unsupported = 摘要或全文/表格与该句矛盾，或数字、结论、人群、药物 / 干预、效应方向任何一处对不上——只要你的理由里指出了某处不符，结论就必须是 unsupported，不能是 unclear；若为特定亚组/分层，请对照对应表格列核对；若摘要支持总体趋势，但开放全文/表格中给出了相反或修正后的数字（例如多因素校正后无显著差异），必须判为 unsupported，在 reason 中写明「全文/表格修正了摘要结论」，并在 evidence_quote 中附上对应的全文/表格原文；' +
  'unclear = 证据涉及该句的内容，但信息不足以确认或否定。' +
  '没有摘要和全文片段，或它们根本没涉及该句说的内容时，判 unclear 并标 no_evidence=true（这类不会逐句挂评论，只在总结里汇总）。' +
  '每条结果在 claim_report 中还需输出 evidence_tier（table = 经开放全文表格/图注核实，fulltext = 经开放全文正文段落核实，abstract = 仅凭 PubMed 摘要核实，none = 无可用摘要或全文证据）与 evidence_quote（原文摘要或开放全文/表格中与该句论断直接对应的具体原文原句或表格行摘录，必须原样摘录原文中的关键句或 Markdown 表格行，供医生直接对照）。' +
  'reason 用中文，一两句话写明依据（引用摘要或表格里的关键数字或结论）；若判 unsupported 且文献有明确相反或正确数字，请在末尾加上【建议修改为】：<简明纠正文本>。'

export interface ClaimEvidence {
  claim_id: string
  node_id: string
  sentence: string
  section_title?: string
  section_role?: SectionRole
  verification_tier?: VerificationTier
  citations: Array<{
    cite_id: string
    number: number | null
    reference: string
    abstract: string | null
    /** 开放获取全文里与该句最相关的片段（摘要之外的证据；没有开放全文时缺省）。 */
    fulltext?: { source: string; passages: string[] }
  }>
  /** 所引文献都没有可用摘要：没有可核对的证据。 */
  no_abstract?: true
  last_verdict?: ClaimVerdict
}

export type DeepReviewMode =
  | 'zero_shot'
  | 'pass_at_k'
  | 'pat_baseline'
  | 'heurion_deep'
  | 'heurion_evolved'

export interface SynthesizedReviewComment {
  id: string
  comment_id?: string
  node_id: string
  section_title?: string
  section_role: SectionRole
  verification_tier: VerificationTier
  category: DeepReviewCategory | 'missing_citation'
  subtype?: string
  severity: 'critical' | 'major' | 'minor'
  sentence: string
  snippet: string
  reason: string
  suggestion: string
  source_pass: 'llm_stage3' | 'pass_a_citation' | 'pass_b_internal' | 'pass_c_method' | 'pass_d_spin'
  /** 针对表格某一格：[网格行, 列]（node_id 是表格） */
  cell?: [number, number]
}

export interface FourStageReviewResult {
  doc_id: string
  mode: DeepReviewMode
  scratchpad: ManuscriptScratchpad
  stage1_sections: number
  stage2_budget_counts: Record<VerificationTier, number>
  stage3_raw_candidates: number
  stage4_deduplicated_comments: SynthesizedReviewComment[]
  active_rules_applied: string[]
  /** 给用户看的审稿说明（如表格结构不可靠、已跳过表格核查） */
  warnings: string[]
}

export function untrustedTablesWarning(skipped: string[]): string {
  return `此 PDF 有 ${skipped.length} 张表格未能可靠识别，本次审稿没有核查这些表格：${skipped.join('；')}。建议上传 Word 原稿以获得完整审稿。`
}

export const TABLES_UNRELIABLE_WARNING =
  '此 PDF 的表格未能可靠识别（文档解析服务不可用，已用备用方式导入），本次审稿跳过了依赖表格的核查。建议上传 Word 原稿以获得完整审稿。'

/**
 * 从临床医生的自然语言反驳（Rebuttal）与原句上下文中提炼去数字化的专科边界规则（Track A narrow）。
 * 强制剥离具体样本量、P 值、HR、置信区间等实例数字，确保 0% 跨队列实例泄漏（Instance Contamination = 0%）。
 */
export function synthesizeSanitizedBoundaryRule(
  rebuttalText: string,
  context: { sentence?: string; category?: string; reason?: string } = {},
): { patternKey: string; rule: string } {
  const combined = `${rebuttalText} ${context.sentence ?? ''} ${context.reason ?? ''}`.toLowerCase()

  // 1. 目标试验模拟（TTE）克隆-删失-加权（CCW）伪队列与因果效应指标
  if (
    /(?:target\s+trial\s+emulation|\btte\b|clone|克隆|删失|ccw|不死时间|immortal\s+time|伪队列)/i.test(combined)
  ) {
    return {
      patternKey: 'target_trial_emulation_ccw',
      rule:
        '[domain:manuscript] [narrow:review_boundary:target_trial_emulation_ccw] 审稿核查边界收窄：在目标试验模拟（Target Trial Emulation, TTE）采用克隆-删失-加权（CCW）消除不死时间偏倚的研究中，结果表中的克隆伪队列样本量（clones）允许大于或不同于原始入组分组人数，且优先报告绝对风险差（RD）与相对风险（RR）而非传统 HR，免于触发样本量不一致或缺失 HR 误报。',
    }
  }

  // 2. 单臂 II 期临床试验与历史对照 / ITT vs 手术切除分母
  if (
    /(?:单臂|single[\s-]arm|历史对照|historical\s+control|无需.*对照组|without\s+a\s+control\s+arm|手术.*人群.*itt)/i.test(
      combined,
    )
  ) {
    return {
      patternKey: 'single_arm_phase2_trial',
      rule:
        '[domain:manuscript] [narrow:review_boundary:single_arm_phase2_trial] 审稿核查边界收窄：在探索性单臂 II 期临床试验（Single-Arm Phase II Trial）中，基线特征表与生存终点系与预设历史对照阈值比对，无需平行对照组及组间比较 P 值；且病理缓解率（pCR/MPR）允许按接受手术切除人群（Per-Protocol）与全入组人群（ITT）分别报告，免于触发缺平行对照组误报。',
    }
  }

  // 3. 临床筛查人群 vs 随机化队列 vs 非随机观察队列 / 发现-训练-验证多层子队列设计
  if (
    /(?:非\s*ccr|non[\s-]ccr|观察队列|筛查.*随机|平行观察|双队列|多队列|发现队列|训练队列|验证队列|子队列|multi[\s-]cohort)/i.test(
      combined,
    )
  ) {
    return {
      patternKey: 'multi_cohort_trial_structure',
      rule:
        '[domain:manuscript] [narrow:review_boundary:multi_cohort_trial_structure] 审稿核查边界收窄：当临床研究同时包含总筛查人群、达完全缓解（cCR）随机化队列与未达标平行观察队列时，各亚表分母按对应子队列独立核算，不强制要求随机表两组之和等于总筛查人数。',
    }
  }

  // 4. 转化医学体内外动物实验分组与临床组织芯片队列（TMA）双体系规范
  if (
    /(?:小鼠|动物实验|荷瘤|xenograft|\bmice\b|组织芯片|\btma\b|流式|免疫微环境|体外实验)/i.test(combined)
  ) {
    return {
      patternKey: 'translational_animal_tma_dual_cohort',
      rule:
        '[domain:manuscript] [narrow:review_boundary:translational_animal_tma_dual_cohort] 审稿核查边界收窄：在肿瘤放射免疫转化医学研究中，体内动物荷瘤实验（mice per group）与临床组织芯片（TMA）患者队列属于独立实验体系，不同独立实验批次的小鼠每组样本量允许按实验模块分别设定，且实验组自身测量结果无需标注外部文献引用。',
    }
  }

  // 5. 通用去数字化反驳规则合成（剥离所有阿拉伯数字、百分比与患者标识）
  const sanitizedRebuttal = rebuttalText
    .replace(/\b(?:n|N|clones?|HR|OR|RR|P|p)\s*[=<>≤≥:：]\s*\d+(?:\.\d+)?%?/g, '指定统计量')
    .replace(/\b\d+(?:\.\d+)?\s*(?:%|％|例|人|名|个|只|天|月|年|mm³|mm3|mm|Gy)\b/g, '特定定量值')
    .replace(/\b\d+(?:\.\d+)?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)

  const candidate = `[domain:manuscript] [narrow:review_boundary] 审稿核查边界收窄：当方法或结果段陈述本研究自身入组队列、基线统计或专科设计（${sanitizedRebuttal || '不含外部研究对比词'}）时，属于合理专科研究边界，免于触发缺文献引用或教条误报。`

  // 通过实例解耦守卫二次校验，若仍含实例数字泄露则回退为安全抽象规则
  const adapter = getDomainSkillAdapter('manuscript')
  if (adapter.hasInstanceLeakage(candidate)) {
    return {
      patternKey: 'self_cohort_boundary',
      rule:
        '[domain:manuscript] [narrow:review_boundary] 审稿核查边界收窄：当方法或结果段陈述本研究自身入组队列、基线统计或本中心随访协议数据（且不含外部研究对比词）时，属于自报数据边界，免于触发缺文献引用（missing_citation）告警。',
    }
  }

  return {
    patternKey: 'custom_clinical_boundary',
    rule: candidate,
  }
}

export class ClaimService {
  constructor(
    private readonly docs: Documents,
    private readonly pubmed: PubMedClient,
    private readonly fulltext: FullTextClient | null = null,
  ) {}

  private getActiveBoundaryRules(owner?: string): string[] {
    const store = this.docs.store as any
    if (typeof store?.listMemories !== 'function') return []
    const resolvedOwner = owner ?? 'local'
    try {
      const mems = store.listMemories(resolvedOwner, ['active']) as Array<{ content: string; status?: string }>
      return (mems ?? [])
        .filter(m => !m.status || m.status === 'active')
        .map(m => m.content)
        .filter(c => c.includes('[narrow:review_boundary'))
    } catch {
      return []
    }
  }

  private extract(docId: string, activeRules: string[] = []): {
    claims: Claim[]
    unsourced: Claim[]
    tables: TableSummary[]
    scratchpad: ManuscriptScratchpad
  } {
    const doc = this.docs.get(docId)
    const store = this.docs.store as any
    const rawMeasures = typeof store?.listMeasurements === 'function' ? store.listMeasurements(docId) : []
    const measures = new Map<string, string>((rawMeasures as any[]).map((m: any) => [String(m.id), snapshotText(m)]))
    const rawCitations = typeof store?.listCitations === 'function' ? store.listCitations(docId) : []
    const { claims, unsourced: rawUnsourced } = extractClaims(
      doc,
      referencePlan(doc, rawCitations).numbers,
      measures,
    )
    const tables = extractTableSummaries(doc)
    const scratchpad = buildManuscriptScratchpad(doc, tables)
    const unsourced = rawUnsourced.filter(
      u =>
        !isExemptedByActiveRules(
          {
            category: 'missing_citation',
            reason: '数值型论断缺少出处',
            sentence: u.sentence,
            section_role: u.section_role,
          },
          activeRules,
        ),
    )
    return { claims, unsourced, tables, scratchpad }
  }

  private async abstractFor(doi: string, pmid: string | null): Promise<string | null> {
    const cached = this.docs.store.getAbstract(doi)
    if (cached) return cached.abstract
    let id = pmid
    let abstract: string | null = null
    try {
      id ??= await this.pubmed.pmidForDoi(doi)
      abstract = id ? await this.pubmed.abstract(id) : null
    } catch {
      return null // 网络问题不缓存，下次再取
    }
    this.docs.store.putAbstract(doi, id, abstract)
    return abstract
  }

  /** 一页待核对的论断（带证据）+ 缺出处的数值句 + 文档表格数值摘要 + 四阶段深审问题（首页）。 */
  async evidence(docId: string, cursor = 0): Promise<{
    rev: number
    claims: ClaimEvidence[]
    unsourced: Array<{
      claim_id: string
      node_id: string
      sentence: string
      section_title?: string
      section_role?: SectionRole
      verification_tier?: VerificationTier
    }>
    tables?: TableSummary[]
    audit_issues?: DeepReviewAuditIssue[]
    scratchpad?: ManuscriptScratchpad
    total: number
    next_cursor: number | null
  }> {
    const store = this.docs.store as any
    const owner = typeof store?.getDoc === 'function' ? store.getDoc(docId)?.owner : undefined
    const activeRules = this.getActiveBoundaryRules(owner)
    const { claims, unsourced, tables, scratchpad } = this.extract(docId, activeRules)
    const cites = new Map<string, CitationRow>(
      ((typeof store?.listCitations === 'function' ? store.listCitations(docId) : []) as CitationRow[]).map(c => [c.id, c]),
    )
    const numbers = referencePlan(this.docs.get(docId), [...cites.values()]).numbers
    const page = claims.slice(cursor, cursor + PAGE)
    const out: ClaimEvidence[] = []
    for (const c of page) {
      const citations = []
      for (const id of c.cite_ids) {
        const row = cites.get(id)
        if (!row) continue
        const abstract = await this.abstractFor(row.doi, row.pmid)
        const full = this.fulltext ? await this.fulltext.get(row.doi).catch(() => null) : null
        const passages = full ? relevantPassages(full.text, c.sentence) : []
        citations.push({
          cite_id: id,
          number: numbers.get(id) ?? null,
          reference: row.formatted,
          abstract: abstract ? fitAbstract(abstract) : null,
          ...(passages.length ? { fulltext: { source: full!.source === 'pmc' ? 'PMC 开放获取全文' : '开放获取全文（Unpaywall）', passages } } : {}),
        })
      }
      const last = typeof store?.getClaimCheck === 'function' ? store.getClaimCheck(docId, c.claim_id)?.verdict : undefined
      const noAbstract = citations.every(x => !x.abstract && !x.fulltext)
      out.push({
        claim_id: c.claim_id,
        node_id: c.node_id,
        sentence: c.sentence,
        ...(c.section_title ? { section_title: c.section_title } : {}),
        ...(c.section_role ? { section_role: c.section_role } : {}),
        ...(c.verification_tier ? { verification_tier: c.verification_tier } : {}),
        citations,
        ...(noAbstract ? { no_abstract: true as const } : {}),
        ...(last ? { last_verdict: last } : {}),
      })
    }
    const next = cursor + PAGE < claims.length ? cursor + PAGE : null
    const auditIssues = cursor === 0 ? this.auditDeepReviewPasses(docId, { owner }) : undefined
    return {
      rev: this.docs.rev(docId),
      claims: out,
      unsourced: cursor === 0
        ? unsourced.map(u => ({
            claim_id: u.claim_id,
            node_id: u.node_id,
            sentence: u.sentence,
            ...(u.section_title ? { section_title: u.section_title } : {}),
            ...(u.section_role ? { section_role: u.section_role } : {}),
            ...(u.verification_tier ? { verification_tier: u.verification_tier } : {}),
          }))
        : [],
      ...(cursor === 0 && tables.length > 0 ? { tables } : {}),
      ...(cursor === 0 && auditIssues && auditIssues.length > 0 ? { audit_issues: auditIssues } : {}),
      ...(cursor === 0 ? { scratchpad } : {}),
      total: claims.length,
      next_cursor: next,
    }
  }

  /**
   * 记录核对结果；不支持 / 无法判断 / 缺出处 → 在该句挂 AI 评论（同一句同一结论不重复挂）。
   */
  report(
    docId: string,
    results: Array<{
      claim_id: string
      verdict: ClaimVerdict
      reason: string
      no_evidence?: boolean
      evidence_tier?: EvidenceTier
      evidence_quote?: string
    }>,
  ): Array<{ claim_id: string; status: 'recorded' | 'commented' | 'unchanged' | 'stale' | 'no_evidence'; comment_id?: string }> {
    const store = this.docs.store
    const { claims, unsourced } = this.extract(docId)
    const byId = new Map([...claims, ...unsourced].map(c => [c.claim_id, c]))
    const cites = new Map(store.listCitations(docId).map(c => [c.id, c]))
    const hasAbstract = (claim: Claim) =>
      claim.cite_ids.some(id => {
        const row = cites.get(id)
        return !!(row && (store.getAbstract(row.doi)?.abstract || store.getFullText(row.doi)?.text))
      })
    const out: Array<{ claim_id: string; status: 'recorded' | 'commented' | 'unchanged' | 'stale' | 'no_evidence'; comment_id?: string }> = []
    let doc = this.docs.get(docId)
    const commentOps: Array<{ op: 'claim_comment'; thread: string }> = []
    const pendingChecks: Array<() => void> = []
    for (const r of results) {
      const claim = byId.get(r.claim_id)
      if (!claim) {
        out.push({ claim_id: r.claim_id, status: 'stale' })
        continue
      }
      const prev = store.getClaimCheck(docId, r.claim_id)
      if (prev && prev.verdict === 'exempted' && r.verdict !== 'supported') {
        out.push({ claim_id: r.claim_id, status: 'unchanged' })
        continue
      }
      const selfReported =
        r.verdict === 'missing_citation' &&
        /(?:本研究|自报|自身队列|本队列|基线数据|表格单元格|无需引用|不需引用|不应挂.*引用|无需改动)/.test(r.reason)
      const effectiveVerdict: ClaimVerdict = selfReported ? 'supported' : r.verdict
      const { tier: effectiveTier, quote: effectiveQuote } = this.resolveEvidence(claim, cites, r.evidence_tier, r.evidence_quote)
      const needsHighRiskAbstractNotice =
        effectiveVerdict === 'supported' &&
        !selfReported &&
        effectiveTier === 'abstract' &&
        claim.verification_tier === 'high' &&
        claim.cite_ids.length > 0
      if (
        prev &&
        prev.verdict === effectiveVerdict &&
        prev.evidence_tier === effectiveTier &&
        (effectiveVerdict === 'supported' ? !needsHighRiskAbstractNotice || Boolean(prev.comment_id) : Boolean(prev.comment_id))
      ) {
        out.push({ claim_id: r.claim_id, status: 'unchanged', ...(prev.comment_id ? { comment_id: prev.comment_id } : {}) })
        continue
      }
      const noEvidence = effectiveVerdict === 'unclear' && (r.no_evidence === true || !hasAbstract(claim))
      let commentId: string | null = null
      if ((effectiveVerdict !== 'supported' && effectiveVerdict !== 'exempted' && !noEvidence) || needsHighRiskAbstractNotice) {
        const res = this.prepareComment(docId, doc, claim, effectiveVerdict, r.reason, effectiveTier, effectiveQuote)
        doc = res.doc
        commentId = res.commentId
        if (res.anchored) commentOps.push({ op: 'claim_comment', thread: res.commentId })
      }
      const cId = commentId
      pendingChecks.push(() => {
        store.putClaimCheck({
          doc_id: docId,
          claim_id: r.claim_id,
          node_id: claim.node_id,
          sentence: claim.sentence,
          verdict: effectiveVerdict,
          evidence_tier: effectiveTier,
          evidence_quote: effectiveQuote,
          reason: noEvidence ? `（没有可核对的证据）${r.reason}` : r.reason,
          comment_id: cId,
          rev: this.docs.rev(docId),
        })
      })
      out.push({
        claim_id: r.claim_id,
        status: noEvidence ? 'no_evidence' : commentId ? 'commented' : 'recorded',
        ...(commentId ? { comment_id: commentId } : {}),
      })
    }
    if (commentOps.length > 0) {
      this.docs.commit(docId, doc, { actor: 'system', turnId: null, ops: commentOps })
    }
    for (const put of pendingChecks) put()
    return out
  }

  private resolveEvidence(
    claim: Claim,
    cites: Map<string, CitationRow>,
    explicitTier?: EvidenceTier,
    explicitQuote?: string,
  ): { tier: EvidenceTier; quote: string } {
    const store = this.docs.store
    const fullPassages: string[] = []
    const abstracts: string[] = []
    for (const id of claim.cite_ids) {
      const row = cites.get(id)
      if (!row) continue
      const ft = store.getFullText(row.doi)?.text
      if (ft && ft.trim().length > 0) {
        const rel = relevantPassages(ft, claim.sentence)
        if (rel.length > 0) {
          fullPassages.push(...rel)
        } else {
          const blocks = ft.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
          if (blocks.length > 0) {
            const best = this.pickBestText(blocks, claim.sentence)
            if (best) fullPassages.push(best)
          }
        }
      }
      const abs = store.getAbstract(row.doi)?.abstract
      if (abs && abs.trim().length > 0) {
        abstracts.push(abs.trim())
      }
    }

    const isTablePassage = (p: string) => /\|.*\|/.test(p) || /\[(?:表格|Table)\b/i.test(p) || /\bTable\s+\d+/i.test(p)
    let tier: EvidenceTier
    if (explicitTier) {
      tier = explicitTier
    } else if (fullPassages.length > 0) {
      tier = fullPassages.some(isTablePassage) ? 'table' : 'fulltext'
    } else if (abstracts.length > 0) {
      tier = 'abstract'
    } else {
      tier = 'none'
    }

    if (explicitQuote && explicitQuote.trim().length > 0) {
      return { tier, quote: explicitQuote.trim().slice(0, 600) }
    }

    if (fullPassages.length > 0 && (tier === 'table' || tier === 'fulltext')) {
      const targetPassages =
        tier === 'table' && fullPassages.some(isTablePassage) ? fullPassages.filter(isTablePassage) : fullPassages
      const bestPassage = this.pickBestText(targetPassages, claim.sentence) ?? targetPassages[0]!
      const lines = bestPassage.split('\n').map(l => l.trim()).filter(Boolean)
      const tableLines = lines.filter(l => l.includes('|') && !/^\|\s*[-:]+(?:\s*\|\s*[-:]+)*\s*\|?$/.test(l))
      if (tableLines.length >= 2) {
        const captionLine = lines.find(l => /^\[(?:表格|Table)/i.test(l))
        const header = tableLines[0]!
        const dataRows = tableLines.slice(1)
        const bestRow = this.pickBestText(dataRows, claim.sentence) ?? dataRows[0]!
        const assembled = [captionLine, header, bestRow].filter(Boolean).join('\n')
        return { tier, quote: assembled.slice(0, 350) }
      }
      return { tier, quote: this.extractBestSentences(bestPassage, claim.sentence, 350) }
    }

    if (abstracts.length > 0) {
      const combined = abstracts.join('\n')
      return { tier, quote: this.extractBestSentences(combined, claim.sentence, 350, true) }
    }

    return { tier, quote: '' }
  }

  private scoreOverlap(candidate: string, claimSentence: string, inResultsSection = false): number {
    const rawNums = claimSentence.replace(/(\d)·(\d)/g, '$1.$2').match(/\d+(?:\.\d+)?%?/g) ?? []
    const claimNums = new Set<string>()
    for (const raw of rawNums) {
      const clean = raw.replace(/%$/, '')
      if (/^(19|20)\d\d$/.test(clean)) continue
      claimNums.add(clean)
      const val = Number(clean)
      if (!Number.isNaN(val)) {
        if (raw.endsWith('%')) {
          claimNums.add((val / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))
        } else if (val > 0 && val < 1 && clean.startsWith('0.')) {
          claimNums.add(String(Math.round(val * 1000) / 10))
        }
      }
    }
    const claimWords = new Set((claimSentence.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).map(w => w.slice(0, 6)))
    const claimCjk = new Set<string>()
    for (const m of claimSentence.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
      for (let i = 0; i + 2 <= m.length; i++) claimCjk.add(m.slice(i, i + 2))
    }

    let score = 0
    const candNorm = candidate.replace(/(\d)·(\d)/g, '$1.$2')
    const candNums = new Set(candNorm.match(/\d+(?:\.\d+)?/g) ?? [])
    for (const n of claimNums) {
      if (candNums.has(n) || candNorm.includes(n)) score += 5
    }
    const candLower = candidate.toLowerCase()
    for (const w of claimWords) {
      if (candLower.includes(w)) score += 2
    }
    for (const bg of claimCjk) {
      if (candidate.includes(bg)) score += 1
    }
    if (inResultsSection || /\b(RESULTS?|FINDINGS|CONCLUSIONS?|结果|结论)\b/i.test(candidate)) {
      score += 2
    }
    return score
  }

  private pickBestText(candidates: string[], claimSentence: string): string | undefined {
    if (candidates.length === 0) return undefined
    let best = candidates[0]!
    let bestScore = -1
    for (const c of candidates) {
      const s = this.scoreOverlap(c, claimSentence)
      if (s > bestScore) {
        bestScore = s
        best = c
      }
    }
    return best
  }

  private extractBestSentences(source: string, claimSentence: string, maxChars = 350, isAbstract = false): string {
    const sentences = source
      .split(/(?<=[.!?])\s+(?=[A-Z\u4e00-\u9fff\[])|(?<=[。！？；])\s*|\n+/)
      .map(s => s.trim())
      .filter(Boolean)
    if (sentences.length === 0) return source.trim().slice(0, maxChars)

    let inKeySection = false
    const scored = sentences.map((s, idx) => {
      if (isAbstract) {
        if (/\b(RESULTS?|FINDINGS|CONCLUSIONS?|结果|结论)\b\s*[:：]/i.test(s)) inKeySection = true
        else if (/\b(BACKGROUND|METHODS?|OBJECTIVES?|INTRODUCTION|背景|方法)\b\s*[:：]/i.test(s)) inKeySection = false
      }
      return { s, idx, score: this.scoreOverlap(s, claimSentence, isAbstract && inKeySection) }
    })

    scored.sort((a, b) => b.score - a.score || a.idx - b.idx)
    const first = scored[0]!
    const picked = [first]
    const second = scored[1]
    if (second && second.score >= 4 && first.s.length + 1 + second.s.length <= maxChars) {
      picked.push(second)
      picked.sort((a, b) => a.idx - b.idx)
    }
    return picked.map(p => p.s).join(' ').slice(0, maxChars)
  }

  private prepareComment(
    docId: string,
    doc: PMNode,
    claim: Claim,
    verdict: ClaimVerdict,
    reason: string,
    evidenceTier: EvidenceTier = 'none',
    evidenceQuote = '',
  ): { commentId: string; doc: PMNode; anchored: boolean } {
    const store = this.docs.store
    const label = {
      unsupported: '所引文献不支持该论断',
      unclear: '无法从所引文献判断',
      missing_citation: '数值型论断缺少出处',
      supported: '高风险定量/亚组论断仅由摘要支持（缺少全文或数据表佐证，建议核对原文全文）',
      exempted: '',
    }[verdict]
    const resolved = this.resolveTargetNodeAndSnippet(doc, claim.node_id, claim.snippet, claim.sentence)
    const row = store.addComment({ doc_id: docId, node_id: resolved.nodeId, snippet: resolved.snippet })
    let nextDoc = doc
    let anchored = false
    try {
      nextDoc = attachComment(doc, resolved.nodeId, resolved.anchorSnippet, row.id).doc
      anchored = true
    } catch (err) {
      if (!(err instanceof AnchorError)) throw err
      // 找不到段落内精确连续文字（如跨行内引用原子或表格块）：退化为整块 comment mark 锚点
      try {
        nextDoc = attachComment(doc, resolved.nodeId, '', row.id).doc
        anchored = true
      } catch {
        store.db.prepare("UPDATE comments SET snippet = '' WHERE id = ?").run(row.id)
      }
    }
    const quoteBlock = evidenceQuote
      ? `\n${evidenceTier === 'table' || evidenceTier === 'fulltext' ? '【匹配全文/表格原文】' : '【匹配摘要原文】'}：${evidenceQuote}`
      : ''
    store.addReply(row.id, 'ai', `论断核对：${label}。${reason}${quoteBlock}\n句子：${claim.sentence}`)
    return { commentId: row.id, doc: nextDoc, anchored }
  }

  /**
   * 批注锚点只取完整句子，避免把“半句话”挂到正文上：
   * - sentence 本身就是完整原句时原样返回；
   * - 结构化核查传入整段时，按 snippet 定位到所在句子；
   * - 超长且没有句末标点时，按逗号回退，尽量不截断在词中间。
   */
  /**
   * 表格意见要落的单元格段落：给了 [网格行, 列] 时取那一格（合并单元格取起始格）；否则在表内找唯一包含该文字的单元格。
   * anchor 是格内要标的文字（格里找得到 snippet 时只标它，否则标整格）。找不到时返回 null（退回整张表）。
   */
  private cellTarget(table: PMNode, snippet: string, cell?: [number, number]): { nodeId: string; anchor: string } | null {
    const grid = readGrid(table)
    const paraOf = (n: PMNode): PMNode | null => {
      let para: PMNode | null = null
      n.descendants(d => { if (!para && d.isTextblock && d.attrs.id && d.textContent.trim()) para = d; return !para })
      return para
    }
    const pick = (n: PMNode | null): { nodeId: string; anchor: string } | null => {
      if (!n) return null
      const text = n.textContent
      return { nodeId: n.attrs.id as string, anchor: snippet && text.includes(snippet) ? snippet : '' }
    }
    if (cell) {
      const c = grid.at(cell[0], cell[1])
      const hit = c ? pick(paraOf(c.node)) : null
      if (hit) return hit
    }
    if (!snippet) return null
    const found = grid.cells.map(c => paraOf(c.node)).filter((p): p is PMNode => !!p && p.textContent.includes(snippet))
    return found.length === 1 ? pick(found[0]!) : null
  }

  private sentenceForAnchor(text: string, probe: string, maxChars = 300): string {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return probe.trim()
    if (clean.length <= maxChars) return clean
    const needle = probe.replace(/\s+/g, ' ').trim().slice(0, 32)
    const at = needle ? clean.indexOf(needle) : -1
    let start = at >= 0 ? at : 0
    while (start > 0 && !/[。！？；!?;]/.test(clean[start - 1]!)) start--
    let end = at >= 0 ? at + Math.max(needle.length, 1) : Math.min(clean.length, maxChars)
    while (end < clean.length && !/[。！？；!?;]/.test(clean[end]!)) end++
    if (end < clean.length) end++
    let out = clean.slice(start, end).trim()
    if (out.length > maxChars) {
      const comma = out.lastIndexOf('，', maxChars)
      out = out.slice(0, comma > maxChars * 0.6 ? comma + 1 : maxChars).trim()
    }
    return out || clean.slice(0, maxChars)
  }

  /**
   * 为审稿/核查批注解析最匹配的文档块 ID 与可锚定片段：
   * - 当 LLM Stage 3 给出的 node_id 缺失、为章节标题或文字落在其他段落/表格时，自动按文本重叠度回溯真实块；
   * - 当句子中间夹有引用原子 [@c:...] / 测量原子 [@m:...] 时，自动提取段落内最长连续子串用于精确打标。
   */
  private resolveTargetNodeAndSnippet(
    doc: PMNode,
    rawNodeId: string,
    rawSnippet: string,
    sentence: string,
    cell?: [number, number],
  ): { nodeId: string; snippet: string; anchorSnippet: string } {
    const byId = indexById(doc)
    const cleanSentence = sentence.replace(/\[@[cm]:[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim()
    const displaySnippet = this.sentenceForAnchor(cleanSentence || rawSnippet, rawSnippet || cleanSentence)

    let targetId = rawNodeId
    const initialHit = byId.get(targetId)
    const probe = rawSnippet.replace(/^\[表格\]\s*/, '').trim().slice(0, 32) || cleanSentence.slice(0, 32)

    const blockContainsProbe = (node: PMNode): boolean => {
      if (!probe) return true
      const txt = node.textContent
      if (txt.includes(probe)) return true
      const clauses = ( cleanSentence || rawSnippet )
        .split(/[，。；、,;：:\s[\]()（）]+/)
        .map(s => s.trim())
        .filter(s => s.length >= 5)
      return clauses.some(c => txt.includes(c))
    }

    // 表格与图（问题出在图注里）按整块定位，不去别的段落里找相似文字
    const wholeBlock = (n: PMNode) => n.type.name === 'table' || n.type.name === 'figure'
    if (!initialHit || (!wholeBlock(initialHit.node) && !blockContainsProbe(initialHit.node))) {
      let bestId = initialHit ? targetId : ''
      let bestScore = initialHit ? this.scoreOverlap(initialHit.node.textContent, cleanSentence || rawSnippet) : -1
      doc.descendants(node => {
        const id = node.attrs?.id as string | undefined
        if (!id) return true
        if (!node.isTextblock && node.type.name !== 'table') return true
        const txt = node.textContent
        if (!txt.trim()) return false
        let s = this.scoreOverlap(txt, cleanSentence || rawSnippet)
        if (probe && txt.includes(probe)) s += 25
        if (node.type.name === 'paragraph' || node.type.name === 'table') s += 1
        if (s > bestScore) {
          bestScore = s
          bestId = id
        }
        return node.type.name !== 'table'
      })
      if (bestId) targetId = bestId
    }

    const finalHit = byId.get(targetId)
    if (!finalHit) {
      return { nodeId: targetId, snippet: displaySnippet, anchorSnippet: displaySnippet }
    }

    if (finalHit.node.type.name === 'table') {
      // 表格意见落到单元格：给了行列用那一格；否则按单元格文字在表内唯一匹配。转换稿与原版都只标那一格
      const inCell = this.cellTarget(finalHit.node, rawSnippet.replace(/^\[表格\]\s*/, '').trim(), cell)
      if (inCell) return { nodeId: inCell.nodeId, snippet: inCell.anchor || displaySnippet, anchorSnippet: inCell.anchor }
    }

    if (!finalHit.node.isTextblock) {
      // 表格、列表、图片等复合块：使用空 anchorSnippet 打整块 comment mark，同时保留可读 snippet
      return { nodeId: targetId, snippet: displaySnippet, anchorSnippet: '' }
    }

    const blockText = finalHit.node.textContent
    if (displaySnippet && blockText.includes(displaySnippet)) {
      return { nodeId: targetId, snippet: displaySnippet, anchorSnippet: displaySnippet }
    }

    // 从句子或 snippet 中提取在该段落中唯一出现的最长连续子串（避开 [@c:...] 行内原子断点）
    const segments = [rawSnippet, cleanSentence]
      .flatMap(s => s.split(/\[@[cm]:[^\]]+\]|[\r\n]+|[，。；：,;（）()[\]]+/))
      .map(s => s.trim())
      .filter(s => s.length >= 4)
      .sort((a, b) => b.length - a.length)

    for (const seg of segments) {
      const sub = this.sentenceForAnchor(seg, seg)
      if (blockText.includes(sub)) {
        return { nodeId: targetId, snippet: displaySnippet || sub, anchorSnippet: sub }
      }
    }

    return { nodeId: targetId, snippet: displaySnippet, anchorSnippet: '' }
  }

  /**
   * 静态/记忆感知的四阶段深度审稿专项巡检（Stage 3 Pass B 内部表文自洽 + Pass C 方法-结果配对 + Pass D Spin Bias 与规范）：
   * 可独立调用或与 verify_claims / runFourStageDeepReview 联合执行。
   */
  auditDeepReviewPasses(
    docId: string,
    opts: { includeInternal?: boolean; useMemory?: boolean; owner?: string } = {},
  ): DeepReviewAuditIssue[] {
    const doc = this.docs.get(docId)
    const tables = extractTableSummaries(doc)
    const activeRules = opts.useMemory !== false ? this.getActiveBoundaryRules(opts.owner) : []
    const includeInternal = opts.includeInternal !== false
    return [
      ...(includeInternal ? auditInternalConsistency(doc, tables, activeRules) : []),
      ...auditMethodResultConsistency(doc, tables, activeRules),
      ...auditSpinAndGuidelines(doc, activeRules),
    ]
  }

  /**
   * Stage 4 全局合成 Judge（Global Synthesis, Deduplication, Severity Gating & {#c:id} Comment Anchoring）：
   * 对应 Google PAT (arXiv:2606.28277) Stage 4：
   * 1. 跨章节/多通道重复问题去重（Deduplication）；
   * 2. 严重度分级排序（critical -> major -> minor）；
   * 3. 若开启自进化记忆（useMemory），依据活跃 `[narrow:review_boundary]` 规则过滤假阳性；
   * 4. 可选将去重后的审稿意见直接挂载为文档内联批注 `{#c:id}`。
   */
  synthesizeStage4Review(
    docId: string,
    candidates: SynthesizedReviewComment[],
    opts: {
      deduplicate?: boolean
      useMemory?: boolean
      owner?: string
      anchorComments?: boolean
    } = {},
  ): SynthesizedReviewComment[] {
    const activeRules = opts.useMemory ? this.getActiveBoundaryRules(opts.owner) : []
    const deduplicate = opts.deduplicate !== false

    const filtered = candidates.filter(c => !isExemptedByActiveRules(c, activeRules))
    const deduplicated: SynthesizedReviewComment[] = []
    const seenKeys = new Set<string>()

    for (const item of filtered) {
      if (deduplicate) {
        const normSentence = item.sentence.replace(/\s+/g, '').toLowerCase().slice(0, 60)
        const key = `${item.category}|${item.subtype ?? ''}|${item.node_id}|${normSentence}`
        if (seenKeys.has(key)) continue

        // 跨通道语义去重：同一段落/表格块若已被结构化精确核查（Pass B/C/D）定位，或同表同一子类型（如双零笔误、修订粘连含HR），合并去重
        const isRedundantWithExisting = deduplicated.some(existing => {
          if (existing.node_id !== item.node_id) return false
          if (existing.subtype && existing.subtype === item.subtype) return true
          if (
            existing.subtype === 'uncleaned_revision_merge_artifact' &&
            item.subtype === 'cross_section_hr_mismatch'
          ) {
            return true
          }
          if (existing.source_pass !== 'llm_stage3' && item.source_pass === 'llm_stage3') {
            return true
          }
          return false
        })
        if (isRedundantWithExisting) continue
        seenKeys.add(key)
      }
      deduplicated.push(item)
    }

    const sevRank: Record<'critical' | 'major' | 'minor', number> = { critical: 0, major: 1, minor: 2 }
    deduplicated.sort((a, b) => sevRank[a.severity] - sevRank[b.severity])

    if (opts.anchorComments && deduplicated.length > 0) {
      const store = this.docs.store as any
      if (typeof store?.addComment === 'function') {
        let doc = this.docs.get(docId)
        const ops: Array<{ op: 'claim_comment'; thread: string }> = []
        for (const item of deduplicated) {
          const resolved = this.resolveTargetNodeAndSnippet(doc, item.node_id, item.snippet, item.sentence, item.cell)
          item.node_id = resolved.nodeId
          const row = store.addComment({
            doc_id: docId,
            node_id: resolved.nodeId,
            snippet: resolved.snippet,
          })
          item.comment_id = row.id
          try {
            doc = attachComment(doc, resolved.nodeId, resolved.anchorSnippet, row.id).doc
            ops.push({ op: 'claim_comment', thread: row.id })
          } catch {
            /* 段落内多处重复或跨行内原子时，退化为整块 comment mark 锚点，确保正文中始终可定位高亮 */
            try {
              doc = attachComment(doc, resolved.nodeId, '', row.id).doc
              ops.push({ op: 'claim_comment', thread: row.id })
            } catch {
              /* 块级兜底 */
            }
          }
          if (typeof store?.addReply === 'function') {
            store.addReply(
              row.id,
              'ai',
              `[${item.severity.toUpperCase()} | ${item.category}] ${item.reason}\n【建议修改】：${item.suggestion}`,
            )
          }
        }
        if (ops.length > 0 && typeof (this.docs as any).commit === 'function') {
          this.docs.commit(docId, doc, { actor: 'system', turnId: null, ops })
        }
      }
    }

    return deduplicated
  }

  /**
   * 端到端四阶段临床深度审稿管线（支持 Google PAT 基线与 Heurion 2.0 模式同台对比）：
   * - `zero_shot`：单次全文调用（Google PAT Table 2 基线）；
   * - `pass_at_k`：k=3 独立全文采样汇总、无 Stage 4 去重（Google PAT Section 2 精度崩塌基线）；
   * - `pat_baseline`：原版 Google PAT 四阶段纯文本管线（Stage 1 章节切分 + Stage 2 预算分级 + Stage 3 共享 Scratchpad 分段 LLM 深审 + Stage 4 去重合成，不含结构化表文 AST 核查与批注自进化记忆）；
   * - `heurion_deep`：PAT 四阶段 + Stage 3 结构化四维核查（Pass A/B/C/D）+ Stage 4 全局合成与批注锚定；
   * - `heurion_evolved`：PAT 四阶段 + 结构化四维核查 + 医生批注反驳自进化记忆（Track A narrow + Track B）。
   */
  async deepReview(
    docId: string,
    opts: {
      mode?: DeepReviewMode
      complete?: Complete | null
      owner?: string
      anchorComments?: boolean
      passK?: number
      tablesUnreliable?: boolean
      assessTables?: boolean
      tableVision?: TableVision | null
    } = {},
  ): Promise<FourStageReviewResult> {
    return this.runFourStageDeepReview(docId, {
      mode: opts.mode ?? 'heurion_evolved',
      ...opts,
    })
  }

  async runFourStageDeepReview(
    docId: string,
    opts: {
      mode: DeepReviewMode
      complete?: Complete | null
      owner?: string
      anchorComments?: boolean
      passK?: number
      /** 表格结构不可靠（PDF 走 poppler 兜底导入）：规则核查与模型输入都不使用表格，并提示用户 */
      tablesUnreliable?: boolean
      /** 表格由版面推断（PDF 经 Docling 导入）：逐表判断可信度，不可信的表不参与核查、不交给模型，并提示用户 */
      assessTables?: boolean
      /** 与 assessTables 一起用：先按页面图像核对表格（PDF_ORIGINAL_VIEW.md §12.3），核对不了的再按文字规则判断 */
      tableVision?: TableVision | null
    },
  ): Promise<FourStageReviewResult> {
    const doc = this.docs.get(docId)
    let tables = opts.tablesUnreliable ? [] : extractTableSummaries(doc)
    const warnings = opts.tablesUnreliable ? [TABLES_UNRELIABLE_WARNING] : []
    if (opts.assessTables && tables.length) {
      const checked = await assessTablesWithVision(tables, opts.tableVision)
      tables = checked.tables
      if (checked.reread.length) warnings.push(rereadTablesWarning(checked.reread))
      if (checked.skipped.length) warnings.push(untrustedTablesWarning(checked.skipped))
    }
    // 全部表格都不可用时显式跳过，避免规则核查把空列表当成「未提供」而重新从文档提取表格
    const skipTables = opts.tablesUnreliable || (opts.assessTables === true && tables.length === 0)
    const scratchpad = buildManuscriptScratchpad(doc, tables)
    const useMemory = opts.mode === 'heurion_evolved'
    const activeRules = useMemory ? this.getActiveBoundaryRules(opts.owner) : []

    // Stage 1 & Stage 2：按章节切分文档并统计 Light / Medium / High 预算分布
    const sections: Array<{
      title: string
      role: SectionRole
      tier: VerificationTier
      blocks: Array<{ nodeId: string; text: string; tier: VerificationTier }>
    }> = []
    let curSection = {
      title: 'Abstract / Header',
      role: 'other' as SectionRole,
      tier: 'medium' as VerificationTier,
      blocks: [] as Array<{ nodeId: string; text: string; tier: VerificationTier }>,
    }
    const budgetCounts: Record<VerificationTier, number> = { light: 0, medium: 0, high: 0 }

    doc.forEach(node => {
      if (isPendingDeletion(node)) return
      if (node.type.name === 'heading') {
        if (curSection.blocks.length > 0) sections.push(curSection)
        const hText = headingText(node)
        const role = classifySectionRole(hText)
        curSection = { title: hText, role, tier: role === 'methods' || role === 'results' ? 'high' : 'medium', blocks: [] }
        return
      }
      // 图注存在图块的 caption 属性里（Word 题注与 PDF 图注都并进图块）：样本量、P 值常写在图注里，一并审读
      const figCaption = node.type.name === 'figure' ? String(node.attrs.caption ?? '').trim() : ''
      if (figCaption) {
        const nodeId = (node.attrs.id as string | null) ?? `fig_${curSection.blocks.length + 1}`
        const tier = classifyVerificationTier(figCaption, 0, curSection.role)
        budgetCounts[tier]++
        curSection.blocks.push({ nodeId, text: figCaption, tier })
        return
      }
      if (node.isTextblock) {
        const text = node.textContent.trim()
        if (!text) return
        const nodeId = (node.attrs.id as string | null) ?? `p_${curSection.blocks.length + 1}`
        const tier = classifyVerificationTier(text, 0, curSection.role)
        budgetCounts[tier]++
        if (tier === 'high') curSection.tier = 'high'
        curSection.blocks.push({ nodeId, text, tier })
      }
    })
    if (curSection.blocks.length > 0) sections.push(curSection)

    const candidates: SynthesizedReviewComment[] = []
    let seq = 1

    // 1. 若在 heurion_deep 或 heurion_evolved 模式下，执行 Stage 3 结构化临床四维核查（Pass B + Pass C + Pass D）
    if (opts.mode === 'heurion_deep' || opts.mode === 'heurion_evolved') {
      const structIssues = [
        ...auditInternalConsistency(doc, tables, activeRules, { skipTables }),
        ...auditMethodResultConsistency(doc, tables, activeRules),
        ...auditSpinAndGuidelines(doc, activeRules),
      ]
      for (const iss of structIssues) {
        candidates.push({
          id: `rev_struct_${seq++}`,
          node_id: iss.node_id,
          ...(iss.section_title ? { section_title: iss.section_title } : {}),
          section_role: iss.section_role,
          verification_tier: 'high',
          category: iss.category,
          ...(iss.subtype ? { subtype: iss.subtype } : {}),
          ...(iss.cell ? { cell: iss.cell } : {}),
          severity: iss.severity,
          sentence: iss.sentence,
          snippet: iss.snippet,
          reason: iss.reason,
          suggestion: iss.suggestion,
          source_pass:
            iss.category === 'internal_inconsistency'
              ? 'pass_b_internal'
              : iss.category === 'method_result_mismatch'
                ? 'pass_c_method'
                : 'pass_d_spin',
        })
      }
    }

    // 2. 若提供了在线大模型（complete），按对应模式执行 LLM 审稿推理
    if (opts.complete) {
      const rulesContext =
        useMemory && activeRules.length > 0
          ? `\n【本课题组已确认的专科审稿边界豁免规则（请严格遵守，切勿对以下情况误报）】：\n${activeRules.map(r => `- ${r}`).join('\n')}\n`
          : ''

      const parseLlmIssues = (rawJson: string, fallbackSection?: { title: string; role: SectionRole; firstNodeId: string }) => {
        const cleaned = rawJson.replace(/```(?:json)?/g, '').trim()
        const match = /\[[\s\S]*\]/.exec(cleaned) ?? /\{[\s\S]*\}/.exec(cleaned)
        if (!match) return
        try {
          const parsed = JSON.parse(match[0])
          const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.issues) ? parsed.issues : []
          for (const item of list) {
            if (!item || typeof item.reason !== 'string' || !item.reason.trim()) continue
            const catRaw = String(item.category ?? 'method_result_mismatch')
            const category: DeepReviewCategory =
              catRaw === 'internal_inconsistency' ||
              catRaw === 'method_result_mismatch' ||
              catRaw === 'spin_or_guideline' ||
              catRaw === 'citation_distortion'
                ? catRaw
                : 'method_result_mismatch'
            const sevRaw = String(item.severity ?? 'major')
            const severity: 'critical' | 'major' | 'minor' =
              sevRaw === 'critical' || sevRaw === 'major' || sevRaw === 'minor' ? sevRaw : 'major'
            const sentence = String(item.sentence ?? item.quote ?? fallbackSection?.title ?? '').trim()
            candidates.push({
              id: `rev_llm_${seq++}`,
              node_id: String(item.node_id ?? fallbackSection?.firstNodeId ?? 'p_1'),
              ...(fallbackSection?.title ? { section_title: fallbackSection.title } : {}),
              section_role: fallbackSection?.role ?? 'other',
              verification_tier: 'high',
              category,
              ...(item.subtype ? { subtype: String(item.subtype) } : {}),
              severity,
              sentence: sentence || '全文段落',
              snippet: sentence || '全文段落',
              reason: item.reason.trim(),
              suggestion: String(item.suggestion ?? '请核实并修正该处表述或数据。').trim(),
              source_pass: 'llm_stage3',
            })
          }
        } catch {
          /* JSON 解析容错 */
        }
      }

      const fullProse = sections
        .map(s => `## ${s.title}\n` + s.blocks.map(b => `[${b.nodeId}] ${b.text}`).join('\n'))
        .join('\n\n')

      const tableMarkdown = opts.tablesUnreliable
        ? '（本稿表格由 PDF 版面推断，行列结构不可靠，已略去；请不要依据表格做数值核对。）'
        : opts.mode === 'heurion_deep' || opts.mode === 'heurion_evolved'
          ? tables
              .map(
                t =>
                  `### Table (${t.node_id}): ${t.caption ?? ''}\n| ${t.headers.join(' | ')} |\n` +
                  t.rows.map(r => `| ${r.join(' | ')} |`).join('\n'),
              )
              .join('\n\n')
          : tables.map(t => `Table (${t.node_id}) headers: ${t.headers.join(', ')}`).join('\n')

      if (opts.mode === 'zero_shot') {
        const sys =
          '你是医学与科学期刊审稿专家。请单次通读以下论文全文，找出其中的客观计算/分母错误、统计方法与结果矛盾、研究设计缺陷或结论夸大问题。输出 JSON 数组：[{"node_id":"...","sentence":"原文原句","category":"internal_inconsistency|method_result_mismatch|spin_or_guideline","severity":"critical|major|minor","reason":"中文原因","suggestion":"中文修改建议"}]。'
        const raw = await opts.complete(sys, `${fullProse}\n\n${tableMarkdown}`)
        parseLlmIssues(raw)
      } else if (opts.mode === 'pass_at_k') {
        const k = opts.passK ?? 3
        const passPromises = Array.from({ length: k }, async (_, i) => {
          const sys = `你是科学论文审稿员（Pass #${i + 1}/${k}，侧重维度：${
            i === 0 ? '样本量与数值前后矛盾' : i === 1 ? '研究设计与对照组/统计学检验缺陷' : '结论夸大与缩写/排版规范'
          }）。请找出论文中所有可疑问题（宁可多报勿漏报）。输出 JSON 数组：[{"node_id":"...","sentence":"原文原句","category":"internal_inconsistency|method_result_mismatch|spin_or_guideline","severity":"critical|major|minor","reason":"中文原因","suggestion":"中文修改建议"}]。`
          return opts.complete!(sys, `${fullProse}\n\n${tableMarkdown}`)
        })
        const raws = await Promise.all(passPromises)
        for (const raw of raws) parseLlmIssues(raw)
      } else {
        // pat_baseline / heurion_deep / heurion_evolved：按 Stage 1 章节与 Stage 2 预算（重点审查 High/Medium 章节）共享 Scratchpad 并行执行（Stage 3 Parallel Deep Review）
        const scratchpadSummary =
          `【跨章节共享 Scratchpad】：入组样本量 N=${scratchpad.enrolled_sample_sizes.join('/') || '未知'}；` +
          `表格样本量 n=${scratchpad.table_sample_sizes.join('/') || '未知'}；` +
          (scratchpad.clone_sample_sizes.length ? `表头 clones=${scratchpad.clone_sample_sizes.join('/')}；` : '') +
          `声明统计指标=${scratchpad.declared_summary_metrics.join(', ') || '未声明'}；` +
          `声明检验方法=${scratchpad.declared_tests.join(', ') || '未声明'}。`

        const targetSections = sections.filter(sec => !(sec.tier === 'light' && sec.role === 'intro'))
        const secResults = await Promise.all(
          targetSections.map(async sec => {
            const secText = sec.blocks.map(b => `[${b.nodeId}] ${b.text}`).join('\n')
            const sys =
              `你是四阶段科学深度审稿系统（Stage 3 Specialist Reviewer，当前分配预算：${sec.tier.toUpperCase()} Thinking Track）。\n` +
              `${scratchpadSummary}${rulesContext}\n` +
              `请结合全局 Scratchpad 深入审查当前章节「${sec.title}」（角色：${sec.role}），重点核查：\n` +
              `1) 样本量分母、百分比算术（n/N）、置信区间上下界或修订粘连错误；\n` +
              `2) 统计方法（Mean±SD vs SEM vs Median[IQR]）、对照组设计与结果报告是否矛盾；\n` +
              `3) 跨章节终点指标（如 pCR、OS、HR）或缩略语定义是否前后不一致。\n` +
              `若无客观问题请返回 []；若有问题请严格输出 JSON 数组：[{"node_id":"块ID","sentence":"原文原句","category":"internal_inconsistency|method_result_mismatch|spin_or_guideline","severity":"critical|major|minor","reason":"中文具体原因","suggestion":"中文修改建议"}]。`
            const userPayload =
              sec.role === 'results' || sec.role === 'methods'
                ? `【当前章节正文】：\n${secText}\n\n【关联表格信息】：\n${tableMarkdown}`
                : `【当前章节正文】：\n${secText}`
            const raw = await opts.complete!(sys, userPayload)
            return { raw, sec }
          }),
        )
        for (const { raw, sec } of secResults) {
          parseLlmIssues(raw, {
            title: sec.title,
            role: sec.role,
            firstNodeId: sec.blocks[0]?.nodeId ?? 'p_1',
          })
        }
      }
    }

    // Stage 4：全局合成（pass_at_k 模式下不去重以展示 Google Section 2 的假阳性堆积效应；其余模式执行 Stage 4 去重与过滤）
    const synthesized = this.synthesizeStage4Review(docId, candidates, {
      deduplicate: opts.mode !== 'pass_at_k',
      useMemory,
      owner: opts.owner,
      anchorComments: opts.anchorComments,
    })

    return {
      doc_id: docId,
      mode: opts.mode,
      scratchpad,
      stage1_sections: sections.length,
      stage2_budget_counts: budgetCounts,
      stage3_raw_candidates: candidates.length,
      stage4_deduplicated_comments: synthesized,
      active_rules_applied: activeRules,
      warnings,
    }
  }

  /**
   * 审稿批注自演进闭环（Comment-Driven Dual-Track Evolution Loop）：
   * 将研究者在 `{#c:id}` 审稿批注上的交互反馈回流至双轨自演进引擎：
   * 1. 作者驳回/申辩（rebuttalText 非空且 acceptedFix !== true）：
   *    - 将关联的 claim_check 标记为 `exempted`（幂等豁免，后续复审不再重复挂批注）；
   *    - 触发 Track A `narrow` 算子：通过 `synthesizeSanitizedBoundaryRule` 动态提炼去数字化的专科边界记忆，避免对同类自报队列、TTE 克隆伪队列、单臂试验或转化实验再次误报。
   * 2. 作者采纳审稿意见并改稿修复（acceptedFix === true）：
   *    - 写入带 `recovery_ops` 的已验证执行信号（execution_signal），供 Track B 程序性策略引擎提炼前置守卫规则。
   */
  evolveFromReviewComment(
    docId: string,
    commentId: string,
    opts: {
      owner?: string
      rebuttalText?: string
      acceptedFix?: boolean
      issueCategory?: string
      recoveryOp?: string
      sentence?: string
      reason?: string
    } = {},
  ): {
    track: 'track_a_narrow' | 'track_b_procedural' | 'none'
    exemptedClaimId?: string
    memoryId?: string
    signalId?: string
    distilledRule?: string
  } {
    const store = this.docs.store as any
    const owner = opts.owner ?? (typeof store?.getDoc === 'function' ? store.getDoc(docId)?.owner : undefined) ?? 'local'
    const checks = (typeof store?.listClaimChecks === 'function' ? store.listClaimChecks(docId) : []) as Array<any>
    const linkedCheck = checks.find(c => c.comment_id === commentId)
    const commentObj = typeof store?.getComment === 'function' ? store.getComment(docId, commentId) : undefined
    const aiReplyText = commentObj?.replies?.find((r: any) => r.role === 'ai')?.text ?? ''

    // Case 1: 研究者回复驳回（Rebuttal）-> 豁免该论断 + Track A narrow 动态收窄边界记忆
    if (opts.rebuttalText && !opts.acceptedFix) {
      if (linkedCheck && typeof store?.putClaimCheck === 'function') {
        store.putClaimCheck({
          doc_id: docId,
          claim_id: linkedCheck.claim_id,
          node_id: linkedCheck.node_id,
          sentence: linkedCheck.sentence,
          verdict: 'exempted',
          evidence_tier: linkedCheck.evidence_tier,
          evidence_quote: linkedCheck.evidence_quote,
          reason: `作者申辩豁免：${opts.rebuttalText.trim()}`,
          comment_id: commentId,
          rev: this.docs.rev(docId),
        })
      }

      const { patternKey, rule: narrowRule } = synthesizeSanitizedBoundaryRule(opts.rebuttalText, {
        sentence: opts.sentence ?? linkedCheck?.sentence ?? commentObj?.snippet,
        category: opts.issueCategory,
        reason: opts.reason ?? linkedCheck?.reason ?? aiReplyText,
      })

      const existingMems = (typeof store?.listMemories === 'function' ? store.listMemories(owner) : []) as Array<any>
      const matchTag = `[narrow:review_boundary:${patternKey}]`
      const existingMem = existingMems.find(
        m => m.content.includes(matchTag) || (patternKey === 'self_cohort_boundary' && m.content.includes('[narrow:review_boundary]')),
      )
      const memRow =
        existingMem && typeof store?.updateMemory === 'function'
          ? (store.updateMemory(existingMem.id, { content: narrowRule }), existingMem)
          : store.addMemory({
              scope: 'user',
              owner,
              project_id: null,
              kind: 'preference',
              content: narrowRule,
              norm: narrowRule.toLowerCase(),
              reason: `审稿批注作者申辩收窄边界：${opts.rebuttalText.trim().slice(0, 80)}`,
              source: 'auto',
              source_doc_id: docId,
              source_turn_id: null,
              actor: 'user',
              explicit: 1,
              evidence: 1,
              status: 'active',
            })
      return {
        track: 'track_a_narrow',
        ...(linkedCheck ? { exemptedClaimId: linkedCheck.claim_id } : {}),
        memoryId: memRow.id,
        distilledRule: narrowRule,
      }
    }

    // Case 2: 研究者采纳审稿意见并改稿修复 -> 记录带恢复轨迹的信号供 Track B 提炼前置规则
    if (opts.acceptedFix) {
      const code = opts.issueCategory ?? (linkedCheck?.verdict === 'unsupported' ? 'citation_unsupported' : 'review_comment_fix')
      const recovery = opts.recoveryOp ?? 'doc_read → replace_text (align prose with table/method/citation evidence) → resolve_comment'
      const sigRow = store.addExecutionSignal({
        owner,
        doc_id: docId,
        turn_id: `review_fix_${commentId}`,
        kind: 'guard_reject',
        code,
        detail: JSON.stringify({
          message: `作者采纳审稿批注 ${commentId} 并完成正文修正`,
          hint: opts.reason ?? linkedCheck?.reason ?? '落笔前先核对正文数值与表格/统计方法/文献原文一致性，避免产生需审稿返工的不一致或夸大表述',
          failed_ops: 'unverified_prose_claim',
          recovery_ops: recovery,
          domain: 'manuscript',
        }),
      })
      return {
        track: 'track_b_procedural',
        ...(linkedCheck ? { exemptedClaimId: linkedCheck.claim_id } : {}),
        signalId: sigRow.id,
      }
    }

    return { track: 'none' }
  }
}

/** 「核对全部论断」回合的提示（基于四阶段多智能体学术审查工作流）。 */
export function verifyPrompt(docId: string): string {
  return (
    `请按四阶段学术审稿工作流核对并审查文档 ${docId}，只把真正有问题、需要作者注意的地方挂为评论，不直接修改正文：\n` +
    `1. [Stage 1 & 2 章节感知与预算分级核对]：调用 verify_claims（doc_id="${docId}"），按 next_cursor 翻页直到取完；结合每条论断的 section_role（intro/methods/results/discussion）与 verification_tier（high/medium/light）分配审查力度，重点深挖 high 级统计与定量论断；${CLAIM_CRITERIA}每页判断完用 claim_report 提交；\n` +
    `2. [Stage 3 多维专项审查（文献对齐 / 正文-表格自洽 / 方法-结果对齐 / Spin 与报告规范）]：结合 verify_claims 返回的 tables 摘要、audit_issues 与 doc_read 通读全文：\n` +
    `   - Pass A（外部文献对齐）：核实数值（含百分比与小数等价性）及效应方向是否与所引文献一致；若文献缺失摘要，可调用 pubmed_search 实时检索补全证据；\n` +
    `   - Pass B（跨章节与正文-表格自洽）：核对摘要、方法、结果及表格（如 Table 1）之间的总样本量 N、亚组频数/百分比加总、HR/OR/P 值及影像测量原子 [@m:id] 是否前后一致；\n` +
    `   - Pass C（统计/影像方法与结果一致性及缺出处溯源）：核查统计方法（正态 Mean±SD vs 偏态 Median[IQR] vs 标准误 SEM、卡方 vs Fisher 精确检验）及缩略语定义是否与结果一致；对引言/讨论中漏标引用的外部研究论断用 claim_report 标记；\n` +
    `   - Pass D（Spin Bias 与 CONSORT/STROBE 规范）：拦截 P ≥ 0.05 却使用“显著获益”阳性夸大措辞（Spin Bias）或观察性研究使用强因果定性措辞；\n` +
    `3. [Stage 4 全局汇总与严重度分级]：对跨章节重复问题去重，按严重度（严重 Critical / 主要 Major / 次要 Minor）在两三句话内总结核对结果。`
  )
}
