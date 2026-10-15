import { createHash } from 'node:crypto'
import type { Node as PMNode } from 'prosemirror-model'

/**
 * 论断抽取（M1 verify_claims）：把正文切成句子，带引用的句子是「论断」，
 * 含数值（HR / OR / RR / CI / 百分比 / 样本量 / P 值）却没有引用的句子是「缺出处」。
 */

export type SectionRole = 'intro' | 'methods' | 'results' | 'discussion' | 'other'
export type VerificationTier = 'light' | 'medium' | 'high'

export interface Claim {
  claim_id: string
  node_id: string
  /** 句子原文，引用写成 [n]。 */
  sentence: string
  /** 句子里最长的一段纯文字（评论锚点用）。 */
  snippet: string
  cite_ids: string[]
  /** 所在章节标题（Stage 1 章节感知切分）。 */
  section_title?: string
  /** 所在章节学术角色（intro / methods / results / discussion / other）。 */
  section_role?: SectionRole
  /** 自适应核查预算分级（Stage 2：light / medium / high）。 */
  verification_tier?: VerificationTier
}

export interface TableSummary {
  node_id: string
  section_title?: string
  headers: string[]
  rows: string[][]
  /** 表格表头或单元格中声明的样本量（如 N=120、(n=60)）。 */
  sample_sizes: number[]
  /** 表格内出现的全部数值与百分比字符串（用于正文-表格一致性核对）。 */
  numbers: string[]
}

const NUMERIC = /(?:\b(?:HR|OR|RR|CI|IQR|SD)\b(?=[^\n。！？；!?]*\d))|\d+(\.\d+)?\s*[%％]|[nN]\s*[=＝]\s*\d+|\b[Pp]\s*[<=＜＝]\s*0?\.\d+|\d+\s*例/
const HIGH_COMPLEXITY_METRIC = /\b(?:HR|OR|RR|CI|IQR|SD|aHR|aOR)\b|\b[Pp]\s*[<=＜＝]\s*0?\.\d+|95%\s*CI/i
const PLACEHOLDER = /(?:待定|待填|待补充|待确认|TODO|TBD|\[待|【待)/i
/** 句末：中文句号类，或英文句点 / 问叹号后跟空白或结尾（避免把 0.74 断开）。 */
const END = /[。！？；!?]|\.(?=\s|$)/

export function classifySectionRole(title: string): SectionRole {
  const t = title.trim()
  if (!t) return 'other'
  if (/(?:引言|背景|研究背景|前言|文献综述|概述|\b(?:intro(?:duction)?|background|literature\s+review|overview|rationale)\b)/i.test(t)) {
    return 'intro'
  }
  if (/(?:方法|资料与方法|研究方法|对象与方法|材料与方法|统计方法|实验设计|研究对象|纳入标准|\b(?:methods?|methodology|materials?\s+and\s+methods?|patients?\s+and\s+methods?|study\s+design|statistical\s+analysis|study\s+population)\b)/i.test(t)) {
    return 'methods'
  }
  if (/(?:结果|研究结果|基线特征|临床特征|疗效|生存分析|安全性|不良反应|亚组分析|\b(?:results?|findings?|baseline\s+characteristics|efficacy|safety|outcomes?|survival\s+analysis)\b)/i.test(t)) {
    return 'results'
  }
  if (/(?:讨论|结论|局限性|展望|总结|小结|临床意义|\b(?:discussion|conclusions?|limitations?|implications?|summary)\b)/i.test(t)) {
    return 'discussion'
  }
  return 'other'
}

export function classifyVerificationTier(plain: string, citeCount: number, sectionRole: SectionRole): VerificationTier {
  const numMatches = plain.match(/\b\d+(?:\.\d+)?[%％]?/g)?.filter(n => !/^(?:19|20)\d{2}$/.test(n)) ?? []
  if (
    HIGH_COMPLEXITY_METRIC.test(plain) ||
    numMatches.length >= 2 ||
    (citeCount > 0 && NUMERIC.test(plain)) ||
    ((sectionRole === 'intro' || sectionRole === 'discussion') && NUMERIC.test(plain))
  ) {
    return 'high'
  }
  if (NUMERIC.test(plain) || numMatches.length === 1 || citeCount >= 2) {
    return 'medium'
  }
  return 'light'
}

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
export const EXTERNAL_STUDY_CUE =
  /(?:既往|另有研究|文献|指南|荟萃分析|系统评价|报道|显示.*可使|提示.*风险|\b(?:previous|prior|earlier|other)\s+stud(?:y|ies)\b|\b(?:literature|guidelines?|reported|meta-analysis|systematic\s+review)\b)/i

/** 纯粹描述本研究自身队列、样本或图表的句子（不含外部文献对比），不应作为「缺文献引用」报错。 */
export const OWN_STUDY_SENTENCE =
  /(?:本研究|本队列|本组|我院|我科|本中心|我中心|本文|表\s*\d+|图\s*\d+|\b(?:Table|Fig(?:ure)?)\s*\d+|\b(?:our|this|present|current)\s+(?:study|cohort|trial|analysis|patients?|population|data|series|center|hospital)\b|\bwe\s+(?:enrolled|included|analyzed|observed|found|recruited|evaluated|retrospectively)\b)/i

/**
 * 提取文档中所有表格的结构化摘要（用于 Stage 3 Pass B 跨章节与正文-表格内部一致性核对）。
 */
export function extractTableSummaries(doc: PMNode): TableSummary[] {
  const summaries: TableSummary[] = []
  let currentSectionTitle = ''

  const visit = (node: PMNode) => {
    if (node.type.name === 'heading') {
      const hText = node.textContent.trim()
      if (hText) currentSectionTitle = hText
      return
    }
    if (node.type.name === 'table') {
      const nodeId = (node.attrs.id as string | null) ?? `tbl_${summaries.length + 1}`
      const rows: string[][] = []
      const numbersSet = new Set<string>()
      const sampleSizes = new Set<number>()

      node.forEach(rowNode => {
        if (rowNode.type.name !== 'table_row') return
        const rowCells: string[] = []
        rowNode.forEach(cellNode => {
          const cellText = cellNode.textContent.replace(/\s+/g, ' ').trim()
          rowCells.push(cellText)
          const nMatches = cellText.matchAll(/\b[nN]\s*[=＝]\s*(\d+)\b/g)
          for (const m of nMatches) {
            const val = Number(m[1])
            if (val > 0) sampleSizes.add(val)
          }
          const numMatches = cellText.match(/\b\d+(?:\.\d+)?[%％]?/g) ?? []
          for (const nm of numMatches) {
            numbersSet.add(nm.replace(/％/g, '%'))
          }
        })
        if (rowCells.some(Boolean)) rows.push(rowCells)
      })

      const headers = rows[0] ?? []
      summaries.push({
        node_id: nodeId,
        ...(currentSectionTitle ? { section_title: currentSectionTitle } : {}),
        headers,
        rows: rows.slice(1),
        sample_sizes: [...sampleSizes],
        numbers: [...numbersSet],
      })
      return
    }
    if (!node.isTextblock) {
      node.forEach(child => visit(child))
    }
  }

  doc.forEach(child => visit(child))
  return summaries
}

export function extractClaims(doc: PMNode, numbers: Map<string, number>): { claims: Claim[]; unsourced: Claim[] } {
  const claims: Claim[] = []
  const unsourced: Claim[] = []
  let currentSectionTitle = ''
  let currentSectionRole: SectionRole = 'other'

  const visit = (node: PMNode, inTable: boolean) => {
    if (node.type.name === 'figure' || node.type.name === 'code_block') return
    if (node.type.name === 'table') {
      node.forEach(child => visit(child, true))
      return
    }
    if (node.type.name === 'heading' && !inTable) {
      const hText = node.textContent.trim()
      if (hText) {
        currentSectionTitle = hText
        currentSectionRole = classifySectionRole(hText)
      }
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
      const tier = classifyVerificationTier(plain, cites.length, currentSectionRole)
      const claim: Claim = {
        claim_id: `k${hash(`${nodeId}|${plain}`)}`,
        node_id: nodeId,
        sentence,
        snippet,
        cite_ids: cites,
        ...(currentSectionTitle ? { section_title: currentSectionTitle } : {}),
        section_role: currentSectionRole,
        verification_tier: tier,
      }
      if (cites.length > 0) {
        claims.push(claim)
      } else if (
        !inTable &&
        node.type.name !== 'heading' &&
        !PLACEHOLDER.test(plain) &&
        NUMERIC.test(plain)
      ) {
        // Stage 1/3 章节角色感知过滤：
        // 在「方法 (methods)」与「结果 (results)」章节中，无引用的数值句默认属于本研究自身数据，
        // 仅当句中明确含有外部研究/指南/既往文献提示词（EXTERNAL_STUDY_CUE）时才归入缺出处（unsourced）。
        const isSelfStudyBySection =
          (currentSectionRole === 'methods' || currentSectionRole === 'results') &&
          !EXTERNAL_STUDY_CUE.test(plain)
        const isSelfStudyByCue = OWN_STUDY_SENTENCE.test(plain) && !EXTERNAL_STUDY_CUE.test(plain)
        if (!isSelfStudyBySection && !isSelfStudyByCue) {
          unsourced.push(claim)
        }
      }
    }
  }

  doc.forEach(child => visit(child, false))
  return { claims, unsourced }
}
