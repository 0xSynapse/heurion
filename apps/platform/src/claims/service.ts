import type { Node as PMNode } from 'prosemirror-model'
import { attachComment, AnchorError } from '../model/anchors.ts'
import type { Documents } from '../model/runtime.ts'
import { relevantPassages, type FullTextClient } from '../literature/fulltext.ts'
import type { PubMedClient } from '../literature/pubmed.ts'
import type { ClaimVerdict } from '../store/db.ts'
import { referencePlan } from '../model/references.ts'
import {
  extractClaims,
  extractTableSummaries,
  type Claim,
  type SectionRole,
  type TableSummary,
  type VerificationTier,
} from './extract.ts'

/**
 * 论断核对（M1，PLATFORM.md §5.5）。分工：
 * - 平台：抽出带引用的句子与「缺出处」的数值句，附带章节角色（Stage 1）、核查预算分级（Stage 2）与全表数值摘要，为每条引用取 PubMed 摘要作为证据（缓存）；
 * - 调用方模型：逐条判断「支持 / 不支持 / 无法判断」，经 claim_report 提交；
 * - 平台：不支持、无法判断、缺出处的论断以 AI 评论挂到该句，由用户决定是否修改（不自动改写）。
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
 * v4（Google PAT 四阶段学术审稿工作流）：
 * - 关注数值等价性（如 74% 与 0.74）与效应方向性矛盾；
 * - 结合章节角色（section_role）与核查预算分级（verification_tier: high/medium/light）分配审查力度；
 * - 理由用中文，明确给出【建议修改为】纠正文本。
 */
export const CLAIM_CRITERIA =
  '逐条只依据所引文献的摘要（以及给出的开放获取全文与表格片段）判断，不凭记忆补充：' +
  'supported = 摘要或全文/表格支持该句的说法与数字（注意百分比与小数等价性，如 74% 与 0.74 视为一致）；' +
  'unsupported = 摘要或全文/表格与该句矛盾，或数字、结论、人群、药物 / 干预、效应方向任何一处对不上——只要你的理由里指出了某处不符，结论就必须是 unsupported，不能是 unclear；若为特定亚组/分层，请对照对应表格列核对；' +
  'unclear = 证据涉及该句的内容，但信息不足以确认或否定。' +
  '没有摘要和全文片段，或它们根本没涉及该句说的内容时，判 unclear 并标 no_evidence=true（这类不会逐句挂评论，只在总结里汇总）。' +
  'reason 用中文，一两句话写明依据（引用摘要或表格里的关键数字或结论）；若判 unsupported 且文献有明确相反或正确数字，请在末尾加上【建议修改为】：<简明纠正文本>。'

export interface ClaimEvidence {
  claim_id: string
  node_id: string
  sentence: string
  section_title?: string
  section_role?: SectionRole
  verification_tier?: VerificationTier
  citations: Array<{ cite_id: string; number: number | null; reference: string; abstract: string | null
    /** 开放获取全文里与该句最相关的片段（摘要之外的证据；没有开放全文时缺省）。 */
    fulltext?: { source: string; passages: string[] } }>
  /** 所引文献都没有可用摘要：没有可核对的证据。 */
  no_abstract?: true
  last_verdict?: ClaimVerdict
}

export class ClaimService {
  constructor(private readonly docs: Documents, private readonly pubmed: PubMedClient, private readonly fulltext: FullTextClient | null = null) {}

  private extract(docId: string): { claims: Claim[]; unsourced: Claim[]; tables: TableSummary[] } {
    const doc = this.docs.get(docId)
    // 编号与导出一致（正文末尾有用户自己的文献表时接在其后编号）
    const { claims, unsourced } = extractClaims(doc, referencePlan(doc, this.docs.store.listCitations(docId)).numbers)
    const tables = extractTableSummaries(doc)
    return { claims, unsourced, tables }
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

  /** 一页待核对的论断（带证据）+ 缺出处的数值句 + 文档表格数值摘要（首页）。 */
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
    total: number
    next_cursor: number | null
  }> {
    const { claims, unsourced, tables } = this.extract(docId)
    const store = this.docs.store
    const cites = new Map(store.listCitations(docId).map(c => [c.id, c]))
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
          cite_id: id, number: numbers.get(id) ?? null, reference: row.formatted, abstract: abstract ? fitAbstract(abstract) : null,
          ...(passages.length ? { fulltext: { source: full!.source === 'pmc' ? 'PMC 开放获取全文' : '开放获取全文（Unpaywall）', passages } } : {}),
        })
      }
      const last = store.getClaimCheck(docId, c.claim_id)?.verdict
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
    return {
      rev: this.docs.rev(docId),
      claims: out,
      unsourced: cursor === 0 ? unsourced.map(u => ({
        claim_id: u.claim_id,
        node_id: u.node_id,
        sentence: u.sentence,
        ...(u.section_title ? { section_title: u.section_title } : {}),
        ...(u.section_role ? { section_role: u.section_role } : {}),
        ...(u.verification_tier ? { verification_tier: u.verification_tier } : {}),
      })) : [],
      ...(cursor === 0 && tables.length > 0 ? { tables } : {}),
      total: claims.length,
      next_cursor: next,
    }
  }

  /**
   * 记录核对结果；不支持 / 无法判断 / 缺出处 → 在该句挂 AI 评论（同一句同一结论不重复挂）。
   * 没有可核对证据的「无法判断」（no_evidence，或所引文献都没有摘要）只记录、不挂评论（C2：否则八成正确的句子被挂评论），
   * 状态为 no_evidence，由回合总结汇总。返回每条的处理结果。
   */
  report(docId: string, results: Array<{ claim_id: string; verdict: ClaimVerdict; reason: string; no_evidence?: boolean }>): Array<{ claim_id: string; status: 'recorded' | 'commented' | 'unchanged' | 'stale' | 'no_evidence'; comment_id?: string }> {
    const store = this.docs.store
    const { claims, unsourced } = this.extract(docId)
    const byId = new Map([...claims, ...unsourced].map(c => [c.claim_id, c]))
    const cites = new Map(store.listCitations(docId).map(c => [c.id, c]))
    const hasAbstract = (claim: Claim) => claim.cite_ids.some(id => { const row = cites.get(id); return !!(row && (store.getAbstract(row.doi)?.abstract || store.getFullText(row.doi)?.text)) })
    const out: Array<{ claim_id: string; status: 'recorded' | 'commented' | 'unchanged' | 'stale' | 'no_evidence'; comment_id?: string }> = []
    let doc = this.docs.get(docId)
    const commentOps: Array<{ op: 'claim_comment'; thread: string }> = []
    const pendingChecks: Array<() => void> = []
    for (const r of results) {
      const claim = byId.get(r.claim_id)
      if (!claim) { out.push({ claim_id: r.claim_id, status: 'stale' }); continue }
      const prev = store.getClaimCheck(docId, r.claim_id)
      if (prev && prev.verdict === 'exempted' && r.verdict !== 'supported') {
        out.push({ claim_id: r.claim_id, status: 'unchanged' })
        continue
      }
      const selfReported =
        r.verdict === 'missing_citation' &&
        /(?:本研究|自报|自身队列|本队列|基线数据|表格单元格|无需引用|不需引用|不应挂.*引用|无需改动)/.test(r.reason)
      const effectiveVerdict: ClaimVerdict = selfReported ? 'supported' : r.verdict
      if (prev && prev.verdict === effectiveVerdict && (effectiveVerdict === 'supported' || prev.comment_id)) {
        out.push({ claim_id: r.claim_id, status: 'unchanged', ...(prev.comment_id ? { comment_id: prev.comment_id } : {}) })
        continue
      }
      const noEvidence = effectiveVerdict === 'unclear' && (r.no_evidence === true || !hasAbstract(claim))
      let commentId: string | null = null
      if (effectiveVerdict !== 'supported' && effectiveVerdict !== 'exempted' && !noEvidence) {
        const res = this.prepareComment(docId, doc, claim, effectiveVerdict, r.reason)
        doc = res.doc
        commentId = res.commentId
        if (res.anchored) commentOps.push({ op: 'claim_comment', thread: res.commentId })
      }
      const cId = commentId
      pendingChecks.push(() => {
        store.putClaimCheck({ doc_id: docId, claim_id: r.claim_id, node_id: claim.node_id, sentence: claim.sentence, verdict: effectiveVerdict, reason: noEvidence ? `（没有可核对的证据）${r.reason}` : r.reason, comment_id: cId, rev: this.docs.rev(docId) })
      })
      out.push({ claim_id: r.claim_id, status: noEvidence ? 'no_evidence' : commentId ? 'commented' : 'recorded', ...(commentId ? { comment_id: commentId } : {}) })
    }
    if (commentOps.length > 0) {
      this.docs.commit(docId, doc, { actor: 'system', turnId: null, ops: commentOps })
    }
    for (const put of pendingChecks) put()
    return out
  }

  private prepareComment(docId: string, doc: PMNode, claim: Claim, verdict: ClaimVerdict, reason: string): { commentId: string; doc: PMNode; anchored: boolean } {
    const store = this.docs.store
    const label = { unsupported: '所引文献不支持该论断', unclear: '无法从所引文献判断', missing_citation: '数值型论断缺少出处', supported: '', exempted: '' }[verdict]
    const row = store.addComment({ doc_id: docId, node_id: claim.node_id, snippet: claim.snippet })
    let nextDoc = doc
    let anchored = false
    try {
      nextDoc = attachComment(doc, claim.node_id, claim.snippet, row.id).doc
      anchored = true
    } catch (err) {
      if (!(err instanceof AnchorError)) throw err
      // 找不到锚定文字：退化为整块锚点
      store.db.prepare('UPDATE comments SET snippet = \'\' WHERE id = ?').run(row.id)
    }
    store.addReply(row.id, 'ai', `论断核对：${label}。${reason}\n句子：${claim.sentence}`)
    return { commentId: row.id, doc: nextDoc, anchored }
  }
}

/** 「核对全部论断」回合的提示（基于 Google PAT 四阶段多智能体学术审查工作流）。 */
export function verifyPrompt(docId: string): string {
  return (
    `请按四阶段学术审稿工作流核对并审查文档 ${docId}，只把真正有问题、需要作者注意的地方挂为评论，不直接修改正文：\n` +
    `1. [Stage 1 & 2 章节感知与预算分级核对]：调用 verify_claims（doc_id="${docId}"），按 next_cursor 翻页直到取完；结合每条论断的 section_role（intro/methods/results/discussion）与 verification_tier（high/medium/light）分配审查力度，重点深挖 high 级统计与定量论断；${CLAIM_CRITERIA}每页判断完用 claim_report 提交；\n` +
    `2. [Stage 3 多维专项审查（文献对齐 / 正文-表格自洽 / 外部论断溯源）]：结合 verify_claims 返回的 tables 摘要与 doc_read 通读全文：\n` +
    `   - Pass A（外部文献对齐）：核实数值（含百分比与小数等价性）及效应方向是否与所引文献一致；若文献缺失摘要，可调用 pubmed_search 实时检索补全证据；\n` +
    `   - Pass B（跨章节与正文-表格自洽）：核对摘要、方法、结果及表格（如 Table 1）之间的总样本量 N、亚组频数/百分比加总、HR/OR/P 值是否前后一致；\n` +
    `   - Pass C（缺出处外部论断甄别）：对本研究自身队列、方法与结果数据切勿机械判为 missing_citation；对引言/讨论中引述外部研究或指南数据却漏标引用的句子，用 claim_report 标记并可通过 pubmed_search 推荐候选文献；\n` +
    `3. [Stage 4 全局汇总与严重度分级]：对跨章节重复问题去重，按严重度（严重 Critical / 主要 Major / 次要 Minor）在两三句话内总结核对结果。`
  )
}
