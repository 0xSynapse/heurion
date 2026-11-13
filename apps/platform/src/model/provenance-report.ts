import type { Node as PMNode } from 'prosemirror-model'
import type { Store } from '../store/db.ts'
import type { MeasureView } from './measurements.ts'
import { aiSpans, hasAiText } from './provenance.ts'

/**
 * 来源证明与 AI 使用声明（docs/design/PROVENANCE.md 6.2）。
 *
 * - 来源证明：随稿件附带的 JSON，列出每段 AI 未确认的文字、每个绑定数字的来源、每条引用的证据（全文 / 摘要 / 无），
 *   以及 AI 的修改回合与确认次数——审稿人或作者自己可以逐条核对。
 * - AI 使用声明：按来源证明统计出的一段话（中 / 英），作者粘进投稿系统；只陈述平台记录到的事实，不替作者下结论。
 */

export interface ProvenanceProof {
  doc: { id: string; title: string; rev: number }
  generated_at: string
  summary: {
    ai_unconfirmed_blocks: number
    ai_unconfirmed_chars: number
    ai_touched_blocks: number
    ai_touched_confirmed: number
    bound_numbers: number
    analysis_bound_numbers: number
    citations_used: number
    citations_fulltext: number
    citations_abstract_only: number
    citations_no_source: number
    citations_added_by_ai: number
    ai_turns: number
    confirmations: number
  }
  ai_text: Array<{ block_id: string; section: string; text: string; turn: string | null }>
  ai_touched: Array<{ block_id: string; section: string; confirmed: boolean }>
  numbers: Array<{ m_id: string; text: string; source_kind: string; source: string; status: string }>
  citations: Array<{ cite_id: string; doi: string; pmid: string | null; reference: string; evidence: 'fulltext' | 'abstract' | 'none'; added_by_ai: boolean }>
  ai_turns: Array<{ turn_id: string; first_at: string; commits: number }>
}

/** 顶层块所在的节（最近一个标题的文字；标题前的块记为「开头」）。 */
function sections(doc: PMNode): Map<string, string> {
  const out = new Map<string, string>()
  let current = '开头'
  doc.forEach(top => {
    if (top.type.name === 'heading') current = top.textContent.trim() || current
    const sec = current
    if (top.attrs.id) out.set(String(top.attrs.id), sec)
    top.descendants(n => { if (n.attrs.id) out.set(String(n.attrs.id), sec); return true })
  })
  return out
}

export function provenanceProof(store: Store, docId: string, doc: PMNode, measures: Map<string, MeasureView>): ProvenanceProof {
  const row = store.getDoc(docId)!
  const sec = sections(doc)
  const blocks = new Map<string, PMNode>()
  doc.descendants(n => { if (n.isTextblock) { if (n.attrs.id) blocks.set(String(n.attrs.id), n); return false } return true })

  const aiText: ProvenanceProof['ai_text'] = []
  for (const [id, n] of blocks) for (const s of aiSpans(n)) aiText.push({ block_id: id, section: sec.get(id) ?? '', text: s.text, turn: s.turn })

  // AI 改过的块（op_log 里 AI 的提交涉及的、现在还在的文本块）与 AI 的回合
  const log = store.opLog(docId)
  const touched = new Set<string>()
  const turns = new Map<string, { first_at: string; commits: number }>()
  let confirmations = 0
  const aiCites = new Set<string>()
  for (const e of log) {
    if (e.actor === 'ai') {
      for (const c of (e.affected as Array<{ node_id: string; kind: string }>) ?? []) if (c.kind !== 'removed' && blocks.has(c.node_id)) touched.add(c.node_id)
      if (e.turn_id) { const t = turns.get(e.turn_id); if (t) t.commits++; else turns.set(e.turn_id, { first_at: e.created_at, commits: 1 }) }
    }
  }
  for (const r of store.opsLog(docId)) {
    const text = JSON.stringify(r.ops)
    if (r.actor === 'ai') for (const m of text.matchAll(/\[@c:([a-z0-9]+)\]/g)) aiCites.add(m[1]!)
    if (/"op":"confirm_text"/.test(text)) confirmations++
  }
  const aiTouched = [...touched].map(id => ({ block_id: id, section: sec.get(id) ?? '', confirmed: !hasAiText(blocks.get(id)!) }))

  const used = new Set<string>()
  doc.descendants(n => { if (n.type.name === 'citation' && n.attrs.cite_id) used.add(String(n.attrs.cite_id)); return true })
  const citations: ProvenanceProof['citations'] = store.listCitations(docId).filter(c => used.has(c.id)).map(c => {
    const full = store.getFullText(c.doi)?.text
    const abs = store.getAbstract(c.doi)?.abstract
    return { cite_id: c.id, doi: c.doi, pmid: c.pmid, reference: c.formatted, evidence: full ? 'fulltext' : abs ? 'abstract' : 'none', added_by_ai: aiCites.has(c.id) }
  })

  const usedM = new Set<string>()
  doc.descendants(n => { if (n.type.name === 'measurement' && n.attrs.m_id) usedM.add(String(n.attrs.m_id)); return true })
  const rows = new Map(store.listMeasurements(docId).map(m => [m.id, m]))
  const numbers: ProvenanceProof['numbers'] = [...usedM].filter(id => rows.has(id)).map(id => {
    const m = rows.get(id)!
    const v = measures.get(id)
    return { m_id: id, text: v?.text ?? '', source_kind: m.source_kind, source: v?.source_label ?? m.bound_label, status: v?.status ?? 'unknown' }
  })

  return {
    doc: { id: docId, title: row.title, rev: row.rev },
    generated_at: new Date().toISOString(),
    summary: {
      ai_unconfirmed_blocks: new Set(aiText.map(a => a.block_id)).size,
      ai_unconfirmed_chars: aiText.reduce((s, a) => s + a.text.length, 0),
      ai_touched_blocks: aiTouched.length,
      ai_touched_confirmed: aiTouched.filter(a => a.confirmed).length,
      bound_numbers: numbers.length,
      analysis_bound_numbers: numbers.filter(n => n.source_kind === 'analysis_result').length,
      citations_used: citations.length,
      citations_fulltext: citations.filter(c => c.evidence === 'fulltext').length,
      citations_abstract_only: citations.filter(c => c.evidence === 'abstract').length,
      citations_no_source: citations.filter(c => c.evidence === 'none').length,
      citations_added_by_ai: citations.filter(c => c.added_by_ai).length,
      ai_turns: turns.size,
      confirmations,
    },
    ai_text: aiText,
    ai_touched: aiTouched,
    numbers,
    citations,
    ai_turns: [...turns].map(([turn_id, t]) => ({ turn_id, ...t })),
  }
}

/** AI 使用声明草稿（按来源证明统计；只陈述平台记录到的事实）。 */
export function aiDisclosure(p: ProvenanceProof, lang: 'zh' | 'en'): string {
  const s = p.summary
  const secs = [...new Set(p.ai_touched.map(a => a.section).filter(Boolean))]
  const secList = (xs: string[]) => xs.slice(0, 6).join(lang === 'zh' ? '、' : ', ') + (xs.length > 6 ? (lang === 'zh' ? ' 等' : ', and others') : '')
  if (lang === 'zh') {
    if (s.ai_turns === 0 && s.ai_touched_blocks === 0) return '本文写作过程中未使用 AI 生成或修改正文内容。作者对全文内容负责。'
    const out: string[] = []
    out.push(`本文写作过程中使用了 Heurion 平台的 AI 写作助手（共 ${s.ai_turns} 轮对话）。`)
    if (s.ai_touched_blocks) {
      out.push(`AI 参与修改了${secs.length ? `「${secList(secs)}」部分的` : ''} ${s.ai_touched_blocks} 个段落，其中 ${s.ai_touched_confirmed} 段已由作者逐段审阅确认${s.ai_touched_blocks > s.ai_touched_confirmed ? `，${s.ai_touched_blocks - s.ai_touched_confirmed} 段尚未逐段确认` : ''}。`)
    }
    out.push(s.citations_added_by_ai
      ? `AI 补充了 ${s.citations_added_by_ai} 条参考文献；平台为每条引用保存了摘要或全文，用于核对其是否支持所在论断。`
      : 'AI 未新增参考文献，参考文献均由作者选定。')
    if (s.analysis_bound_numbers) out.push(`正文中 ${s.analysis_bound_numbers} 个统计数字直接绑定到分析结果，可追溯到对应的分析脚本与数据集。`)
    out.push(s.ai_unconfirmed_blocks === 0 ? 'AI 生成或修改的内容均已经作者审阅确认，作者对全文内容负责。' : '作者对全文内容负责。')
    return out.join('')
  }
  if (s.ai_turns === 0 && s.ai_touched_blocks === 0) return 'No AI tools were used to generate or edit the text of this manuscript. The authors take full responsibility for its content.'
  const out: string[] = []
  out.push(`An AI writing assistant (Heurion platform) was used during the preparation of this manuscript (${s.ai_turns} session${s.ai_turns === 1 ? '' : 's'}).`)
  if (s.ai_touched_blocks) {
    out.push(` The assistant edited ${s.ai_touched_blocks} paragraph${s.ai_touched_blocks === 1 ? '' : 's'}${secs.length ? ` in the ${secList(secs)} section${secs.length === 1 ? '' : 's'}` : ''}; ${s.ai_touched_confirmed} of these were individually reviewed and confirmed by the authors${s.ai_touched_blocks > s.ai_touched_confirmed ? ` and ${s.ai_touched_blocks - s.ai_touched_confirmed} have not yet been individually confirmed` : ''}.`)
  }
  out.push(s.citations_added_by_ai
    ? ` The assistant suggested ${s.citations_added_by_ai} reference${s.citations_added_by_ai === 1 ? '' : 's'}; for each, the platform retained the abstract or full text used to verify that it supports the cited statement.`
    : ' No references were added by the assistant; all references were selected by the authors.')
  if (s.analysis_bound_numbers) out.push(` ${s.analysis_bound_numbers} statistical value${s.analysis_bound_numbers === 1 ? ' is' : 's are'} linked directly to the underlying analysis results and traceable to the analysis scripts and datasets.`)
  out.push(s.ai_unconfirmed_blocks === 0
    ? ' All AI-generated or AI-edited content was reviewed and confirmed by the authors, who take full responsibility for the content of this manuscript.'
    : ' The authors take full responsibility for the content of this manuscript.')
  return out.join('')
}
