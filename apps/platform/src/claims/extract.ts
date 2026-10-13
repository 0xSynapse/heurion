import { createHash } from 'node:crypto'
import type { Node as PMNode } from 'prosemirror-model'

/**
 * 论断抽取（M1 verify_claims）：把正文切成句子，带引用的句子是「论断」，
 * 含数值（HR / OR / RR / CI / 百分比 / 样本量 / P 值）却没有引用的句子是「缺出处」。
 */

export interface Claim {
  claim_id: string
  node_id: string
  /** 句子原文，引用写成 [n]。 */
  sentence: string
  /** 句子里最长的一段纯文字（评论锚点用）。 */
  snippet: string
  cite_ids: string[]
}

const NUMERIC = /(?:\b(?:HR|OR|RR|CI|IQR|SD)\b(?=[^\n。！？；!?]*\d))|\d+(\.\d+)?\s*[%％]|[nN]\s*[=＝]\s*\d+|\b[Pp]\s*[<=＜＝]\s*0?\.\d+|\d+\s*例/
const PLACEHOLDER = /(?:待定|待填|待补充|待确认|TODO|TBD|\[待|【待)/i
/** 句末：中文句号类，或英文句点 / 问叹号后跟空白或结尾（避免把 0.74 断开）。 */
const END = /[。！？；!?]|\.(?=\s|$)/

interface Piece { text: string; cite?: string }

function pieces(block: PMNode): Piece[] {
  const out: Piece[] = []
  block.forEach(child => {
    if (child.isText) out.push({ text: child.text! })
    else if (child.type.name === 'citation') out.push({ text: '', cite: child.attrs.cite_id as string })
    else if (child.type.name === 'hard_break') out.push({ text: '\n' })
  })
  return out
}

interface Sentence { parts: Piece[] }

function sentences(block: PMNode): Sentence[] {
  const out: Sentence[] = []
  let cur: Piece[] = []
  const flush = () => {
    if (cur.some(p => p.cite || p.text.trim())) out.push({ parts: cur })
    cur = []
  }
  for (const p of pieces(block)) {
    if (p.cite) { cur.push(p); continue }
    let rest = p.text
    while (rest) {
      const m = END.exec(rest)
      if (!m) { cur.push({ text: rest }); break }
      cur.push({ text: rest.slice(0, m.index + 1) })
      rest = rest.slice(m.index + 1)
      flush()
    }
  }
  flush()
  // 句末之后紧跟的引用（英文写法 "…outcomes.[1]"）归到前一句
  const merged: Sentence[] = []
  for (const s of out) {
    const onlyCites = s.parts.every(p => p.cite || !p.text.trim())
    if (onlyCites && merged.length > 0) merged[merged.length - 1]!.parts.push(...s.parts)
    else merged.push(s)
  }
  return merged
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10)

/** 句中含外部研究或外部对比词时，即便同时提到「本研究/表 1」也可能是半句缺引用，需保留给模型判断。 */
const EXTERNAL_STUDY_CUE =
  /(?:既往|另有研究|文献|指南|荟萃分析|系统评价|报道|显示.*可使|提示.*风险|\b(?:previous|prior|earlier|other)\s+stud(?:y|ies)\b|\b(?:literature|guidelines?|reported|meta-analysis|systematic\s+review)\b)/i

/** 纯粹描述本研究自身队列、样本或图表的句子（不含外部文献对比），不应作为「缺文献引用」报错。 */
const OWN_STUDY_SENTENCE =
  /(?:本研究|本队列|本组|我院|我科|本中心|我中心|本文|表\s*\d+|图\s*\d+|\b(?:Table|Fig(?:ure)?)\s*\d+|\b(?:our|this|present|current)\s+(?:study|cohort|trial|analysis|patients?|population|data|series|center|hospital)\b|\bwe\s+(?:enrolled|included|analyzed|observed|found|recruited|evaluated|retrospectively)\b)/i

export function extractClaims(doc: PMNode, numbers: Map<string, number>): { claims: Claim[]; unsourced: Claim[] } {
  const claims: Claim[] = []
  const unsourced: Claim[] = []

  const visit = (node: PMNode, inTable: boolean) => {
    if (node.type.name === 'figure' || node.type.name === 'code_block') return
    if (node.type.name === 'table') {
      node.forEach(child => visit(child, true))
      return
    }
    if (!node.isTextblock) {
      node.forEach(child => visit(child, inTable))
      return
    }
    const nodeId = node.attrs.id as string | null
    if (!nodeId || node.attrs.suggest === 'delete') return
    for (const s of sentences(node)) {
      const cites = [...new Set(s.parts.filter(p => p.cite).map(p => p.cite!))]
      const sentence = s.parts.map(p => p.cite ? `[${numbers.get(p.cite) ?? '?'}]` : p.text).join('').trim()
      const plain = s.parts.map(p => p.text).join('').trim()
      // 引用把句子切成几段连续文字，取最长的一段做锚点
      const runs: string[] = ['']
      for (const p of s.parts) {
        if (p.cite) runs.push('')
        else runs[runs.length - 1] += p.text
      }
      const snippet = runs.map(r => r.trim()).sort((a, b) => b.length - a.length)[0] ?? ''
      const claim: Claim = { claim_id: `k${hash(`${nodeId}|${plain}`)}`, node_id: nodeId, sentence, snippet, cite_ids: cites }
      if (cites.length > 0) {
        claims.push(claim)
      } else if (
        !inTable &&
        node.type.name !== 'heading' &&
        !PLACEHOLDER.test(plain) &&
        NUMERIC.test(plain) &&
        !(OWN_STUDY_SENTENCE.test(plain) && !EXTERNAL_STUDY_CUE.test(plain))
      ) {
        unsourced.push(claim)
      }
    }
  }

  doc.forEach(child => visit(child, false))
  return { claims, unsourced }
}
