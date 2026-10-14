import type { Node as PMNode } from 'prosemirror-model'
import { attachComment, AnchorError } from '../model/anchors.ts'
import type { Documents } from '../model/runtime.ts'
import { relevantPassages, type FullTextClient } from '../literature/fulltext.ts'
import type { PubMedClient } from '../literature/pubmed.ts'
import type { ClaimVerdict } from '../store/db.ts'
import { citationOrder } from '../views/read.ts'
import { extractClaims, type Claim } from './extract.ts'

/**
 * 论断核对（M1，PLATFORM.md §5.5）。分工：
 * - 平台：抽出带引用的句子与「缺出处」的数值句，为每条引用取 PubMed 摘要作为证据（缓存）；
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
 * v3（2026-10-03，按 C2 评测）：理由里指出不符就必须判不支持；没有可核对的证据单独标出，不逐句挂评论；理由用中文。
 */
export const CLAIM_CRITERIA =
  '逐条只依据所引文献的摘要（以及给出的开放获取全文与表格片段）判断，不凭记忆补充：' +
  'supported = 摘要或全文/表格支持该句的说法与数字；' +
  'unsupported = 摘要或全文/表格与该句矛盾，或数字、结论、人群、药物 / 干预、效应方向任何一处对不上——只要你的理由里指出了某处不符，结论就必须是 unsupported，不能是 unclear；若为特定亚组/分层，请对照对应表格列核对；' +
  'unclear = 证据涉及该句的内容，但信息不足以确认或否定。' +
  '没有摘要和全文片段，或它们根本没涉及该句说的内容时，判 unclear 并标 no_evidence=true（这类不会逐句挂评论，只在总结里汇总）。' +
  'reason 用中文，一两句话写明依据（引用摘要或表格里的关键数字或结论）；若判 unsupported 且文献有明确相反或正确数字，请在末尾加上【建议修改为】：<简明纠正文本>。'

export interface ClaimEvidence {
  claim_id: string
  node_id: string
  sentence: string
  citations: Array<{ cite_id: string; number: number | null; reference: string; abstract: string | null
    /** 开放获取全文里与该句最相关的片段（摘要之外的证据；没有开放全文时缺省）。 */
    fulltext?: { source: string; passages: string[] } }>
  /** 所引文献都没有可用摘要：没有可核对的证据。 */
  no_abstract?: true
  last_verdict?: ClaimVerdict
}

export class ClaimService {
  constructor(private readonly docs: Documents, private readonly pubmed: PubMedClient, private readonly fulltext: FullTextClient | null = null) {}

  private extract(docId: string): { claims: Claim[]; unsourced: Claim[] } {
    const doc = this.docs.get(docId)
    const order = citationOrder(doc)
    return extractClaims(doc, new Map(order.map((id, i) => [id, i + 1])))
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

  /** 一页待核对的论断（带证据）+ 缺出处的数值句。 */
  async evidence(docId: string, cursor = 0): Promise<{ rev: number; claims: ClaimEvidence[]; unsourced: Array<{ claim_id: string; node_id: string; sentence: string }>; total: number; next_cursor: number | null }> {
    const { claims, unsourced } = this.extract(docId)
    const store = this.docs.store
    const cites = new Map(store.listCitations(docId).map(c => [c.id, c]))
    const order = citationOrder(this.docs.get(docId))
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
          cite_id: id, number: order.includes(id) ? order.indexOf(id) + 1 : null, reference: row.formatted, abstract: abstract ? fitAbstract(abstract) : null,
          ...(passages.length ? { fulltext: { source: full!.source === 'pmc' ? 'PMC 开放获取全文' : '开放获取全文（Unpaywall）', passages } } : {}),
        })
      }
      const last = store.getClaimCheck(docId, c.claim_id)?.verdict
      const noAbstract = citations.every(x => !x.abstract && !x.fulltext)
      out.push({ claim_id: c.claim_id, node_id: c.node_id, sentence: c.sentence, citations, ...(noAbstract ? { no_abstract: true as const } : {}), ...(last ? { last_verdict: last } : {}) })
    }
    const next = cursor + PAGE < claims.length ? cursor + PAGE : null
    return {
      rev: this.docs.rev(docId),
      claims: out,
      unsourced: cursor === 0 ? unsourced.map(u => ({ claim_id: u.claim_id, node_id: u.node_id, sentence: u.sentence })) : [],
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

/** 「核对全部论断」回合的提示。 */
export function verifyPrompt(docId: string): string {
  return (
    `请核对并审查文档 ${docId}，只把真正有问题、需要作者注意的地方挂为评论，不直接修改正文：\n` +
    `1. 带引用论断核对：调用 verify_claims（doc_id="${docId}"），按 next_cursor 翻页直到取完；${CLAIM_CRITERIA}每页判断完用 claim_report 提交；\n` +
    `2. 全文语义理解与数据自洽性审查：结合 doc_read 通读全文与表格，通过语义理解甄别潜在问题——\n` +
    `   - 对本研究自身队列/病例数据、样本量、自报基线表格（如 Table 1），原本就不应挂外部文献引用，若无异常切勿挂任何评论（不要机械判为 missing_citation）；\n` +
    `   - 若发现真正的问题（例如：① 引言/讨论引述外部既往研究或指南数据却漏标引用；② 表内百分比加总异常、频数与总样本量 N 的分母不一致；③ 正文描述与表/图中的数字矛盾；④ 统计量与 P 值/置信区间前后矛盾），请用 comment_add（或对 unsourced 外部论断用 claim_report）在对应块/片段上直接挂载评论说明原因与建议；\n` +
    `3. 最后用两三句话总结核对结果：几处文献不支持或数据异常（已挂评论）、几处缺少可核对的摘要证据。`
  )
}
