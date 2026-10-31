import type { Node as PMNode } from 'prosemirror-model'
import { attachComment, AnchorError } from '../model/anchors.ts'
import type { Documents } from '../model/runtime.ts'
import { relevantPassages, type FullTextClient } from '../literature/fulltext.ts'
import type { PubMedClient } from '../literature/pubmed.ts'
import type { CitationRow, ClaimVerdict, EvidenceTier } from '../store/db.ts'
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
        (effectiveVerdict === 'supported' ? (!needsHighRiskAbstractNotice || Boolean(prev.comment_id)) : Boolean(prev.comment_id))
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
      out.push({ claim_id: r.claim_id, status: noEvidence ? 'no_evidence' : commentId ? 'commented' : 'recorded', ...(commentId ? { comment_id: commentId } : {}) })
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
      const targetPassages = tier === 'table' && fullPassages.some(isTablePassage)
        ? fullPassages.filter(isTablePassage)
        : fullPassages
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
    const quoteBlock = evidenceQuote
      ? `\n${evidenceTier === 'table' || evidenceTier === 'fulltext' ? '【匹配全文/表格原文】' : '【匹配摘要原文】'}：${evidenceQuote}`
      : ''
    store.addReply(row.id, 'ai', `论断核对：${label}。${reason}${quoteBlock}\n句子：${claim.sentence}`)
    return { commentId: row.id, doc: nextDoc, anchored }
  }
}

/** 「核对全部论断」回合的提示（基于四阶段多智能体学术审查工作流）。 */
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
