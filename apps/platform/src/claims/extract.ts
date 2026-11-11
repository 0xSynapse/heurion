/**
 * 论断抽取与四阶段深度临床审查提取器（M1 verify_claims & Stage 1-3 Deep Review）：
 * - Stage 1：章节感知切分（classifySectionRole）与跨章节共享草稿板（buildManuscriptScratchpad）
 * - Stage 2：自适应核查预算分级（classifyVerificationTier: light / medium / high）
 * - Stage 3：
 *   - Pass A：带引用句子与缺出处外部数值句抽取（extractClaims）
 *   - Pass B：内部摘要–正文–表格算术与跨章节一致性核查（auditInternalConsistency）
 *   - Pass C：统计方法–结果配对与缩写/设计核查（auditMethodResultConsistency）
 *   - Pass D：Spin Bias 阳性夸大与 CONSORT/STROBE 规范核查（auditSpinAndGuidelines）
 */
import { createHash } from 'node:crypto'
import type { Node as PMNode } from 'prosemirror-model'
import { readGrid } from '../model/table-grid.ts'
import { findCiProblems } from './ci-check.ts'

export type SectionRole = 'intro' | 'methods' | 'results' | 'discussion' | 'other'
export type VerificationTier = 'light' | 'medium' | 'high'
export type DeepReviewCategory =
  | 'citation_distortion'
  | 'internal_inconsistency'
  | 'method_result_mismatch'
  | 'spin_or_guideline'

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
  caption?: string
  headers: string[]
  rows: string[][]
  /** 表格表头或单元格中声明的样本量（如 N=120、(n=60)）。 */
  sample_sizes: number[]
  /** 表头中声明的克隆伪队列人数（如 clones = 1242）。 */
  clone_sizes?: number[]
  /** 表格内出现的全部数值与百分比字符串（用于正文-表格一致性核对）。 */
  numbers: string[]
  /** headers 与 rows 各行在表格网格里的行号（[表头, 第 1 行, …]；空行不进 rows，行号会跳）：意见据此落到单元格 */
  grid_rows?: number[]
}

export interface ManuscriptScratchpad {
  enrolled_sample_sizes: number[]
  table_sample_sizes: number[]
  clone_sample_sizes: number[]
  study_design: 'rct' | 'single_arm_phase2' | 'observational_tte' | 'observational_cohort' | 'translational' | 'unknown'
  declared_summary_metrics: Array<'mean_sd' | 'mean_sem' | 'median_iqr'>
  declared_tests: string[]
  abbreviations: Array<{ abbr: string; expansion: string; node_id: string; sentence: string }>
  section_counts: Record<SectionRole, number>
}

const NUMERIC = /(?:\b(?:HR|OR|RR|CI|IQR|SD|SEM)\b(?=[^\n。！？；!?]*\d))|\d+(\.\d+)?\s*[%％]|[nN]\s*[=＝]\s*\d+|\b[Pp]\s*[<=＜＝]\s*0?\.\d+|\d+\s*例/
const HIGH_COMPLEXITY_METRIC = /\b(?:HR|OR|RR|CI|IQR|SD|SEM|aHR|aOR|RD)\b|\b[Pp]\s*[<=＜＝]\s*0?\.\d+|95%\s*CI/i
const PLACEHOLDER = /(?:待定|待填|待补充|待确认|TODO|TBD|\[待|【待)/i
/** 句末：中文句号类，或英文句点 / 问叹号后跟空白或结尾（避免把 0.74 断开）。 */
const END = /[。！？；!?]|\.(?=\s|$)/

/** 待采纳删除的修订块（导入的 Word 修订里被删掉的原文）：审稿与论断核对只看采纳修订后的文字，不读被删掉的旧数字 */
export const isPendingDeletion = (node: PMNode): boolean => node.attrs?.suggest === 'delete'

/** 标题文字（带 Word 自动编号，如「2.1 Study design」；编号单独存在 number 属性里） */
export const headingText = (node: PMNode): string => `${node.attrs?.number ? `${node.attrs.number} ` : ''}${node.textContent}`.trim()

export function classifySectionRole(title: string): SectionRole {
  const t = title.trim()
  if (!t) return 'other'
  if (/(?:引言|背景|研究背景|前言|文献综述|概述|\b(?:intro(?:duction)?|background|literature\s+review|overview|rationale)\b)/i.test(t)) {
    return 'intro'
  }
  if (/(?:方法|资料与方法|研究方法|对象与方法|材料与方法|统计方法|实验设计|研究对象|纳入标准|\b(?:methods?|methodology|materials?\s+and\s+methods?|patients?\s+and\s+methods?|study\s+design|statistical\s+analysis|study\s+population|procedures?)\b)/i.test(t)) {
    return 'methods'
  }
  if (/(?:结果|研究结果|基线特征|临床特征|疗效|生存分析|安全性|不良反应|亚组分析|\b(?:results?|findings?|baseline\s+characteristics|efficacy|safety|outcomes?|survival\s+analysis)\b)/i.test(t)) {
    return 'results'
  }
  if (/(?:讨论|结论|局限性|展望|总结|小结|临床意义|缩写|\b(?:discussion|conclusions?|limitations?|implications?|summary|abbreviations?)\b)/i.test(t)) {
    return 'discussion'
  }
  return 'other'
}

export class SectionRoleTracker {
  private stack: Array<{ level: number; role: SectionRole }> = []
  current: SectionRole = 'other'
  onHeading(level: number, text: string): SectionRole {
    const hLevel = Number(level ?? 2)
    while (this.stack.length > 0 && this.stack[this.stack.length - 1]!.level >= hLevel) {
      this.stack.pop()
    }
    const directRole = classifySectionRole(text)
    this.current =
      directRole === 'other' && this.stack.length > 0
        ? this.stack[this.stack.length - 1]!.role
        : directRole
    this.stack.push({ level: hLevel, role: this.current })
    return this.current
  }
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

/** measure：测量原子（数值来自绑定的测量，不是待核对的手写数字；句子里显示它的值，plain 不含它）。 */
interface Piece { text: string; cite?: string; measure?: string }

function pieces(block: PMNode): Piece[] {
  const out: Piece[] = []
  block.forEach(child => {
    if (child.isText) out.push({ text: child.text! })
    else if (child.type.name === 'citation') out.push({ text: '', cite: child.attrs.cite_id as string })
    else if (child.type.name === 'measurement') out.push({ text: '', measure: child.attrs.m_id as string })
    else if (child.type.name === 'hard_break') out.push({ text: '\n' })
  })
  return out
}

interface Sentence { parts: Piece[] }

function sentences(block: PMNode): Sentence[] {
  const out: Sentence[] = []
  let cur: Piece[] = []
  const flush = () => {
    if (cur.some(p => p.cite || p.measure || p.text.trim())) out.push({ parts: cur })
    cur = []
  }
  for (const p of pieces(block)) {
    if (p.cite || p.measure) { cur.push(p); continue }
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

/**
 * 段落按句切开（返回原文的子串，可直接作锚点文字）：句末标点后跟空白处切；句末标点后紧跟上标引用
 * （「…12 months.²³ Gender …」，Word 稿与 PDF 文字层导入都这样）时，在上标后面的空白处切。
 */
export function sentenceTexts(node: PMNode): string[] {
  let s = ''
  const cuts: number[] = []
  let afterEnd = false
  node.forEach(child => {
    // 与 node.textContent 一致（锚点按它找文字）
    const t = child.textContent
    const sup = child.isText && child.marks.some(m => m.type.name === 'sup')
    if (sup && (afterEnd || /[.!?。！？；]$/.test(s))) {
      s += t
      afterEnd = true
      return
    }
    if (afterEnd) {
      const m = /^\s+/.exec(t)
      if (m) cuts.push(s.length, s.length + m[0].length)
    }
    afterEnd = false
    s += t
  })
  // 先在上标后的空白处切，再按普通句末切
  const parts: string[] = []
  let start = 0
  for (let k = 0; k < cuts.length; k += 2) { parts.push(s.slice(start, cuts[k])); start = cuts[k + 1]! }
  parts.push(s.slice(start))
  return parts.flatMap(p => p.trim().split(/(?<=[.!?。！？；])\s+/)).filter(Boolean)
}

/**
 * 单元格的纯文字（表格核查用）：上下标两边加空格，脚注角标、引用上标不会和数值粘成一个数
 * （「12.3¹」读成「12.3 1」而不是「12.31」；「10⁹/L」读成「10 9 /L」，与导入前 Docling 的写法一致）。
 */
export function cellPlainText(cell: PMNode): string {
  let s = ''
  cell.descendants(n => {
    if (n.isText) s += n.marks.some(m => m.type.name === 'sup' || m.type.name === 'sub') ? ` ${n.text} ` : n.text
    else if (n.isBlock && s) s += ' '
    else if (n.isLeaf) s += n.textContent
    return true
  })
  return s.replace(/\s+/g, ' ').trim()
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
  let lastParagraphText = ''

  const visit = (node: PMNode) => {
    if (isPendingDeletion(node)) return
    if (node.type.name === 'heading') {
      const hText = headingText(node)
      if (hText) currentSectionTitle = hText
      return
    }
    if (node.type.name === 'paragraph') {
      const pText = node.textContent.trim()
      if (pText) lastParagraphText = pText
      return
    }
    if (node.type.name === 'table') {
      const nodeId = (node.attrs.id as string | null) ?? `tbl_${summaries.length + 1}`
      const rows: string[][] = []
      const gridRows: number[] = []
      const numbersSet = new Set<string>()
      const sampleSizes = new Set<number>()
      const cloneSizes = new Set<number>()

      // 按逻辑网格（colspan / rowspan）对齐列：合并单元格的文字只在起始格；
      // 表头里的跨列合并（如「Drug (n = 79)」盖住 Pre / Post 两列）铺到每一列，使各列都能对上表头样本量
      const grid = readGrid(node)
      for (const cell of grid.cells) {
        const cellText = cellPlainText(cell.node)
        for (const m of cellText.matchAll(/\b[nN]\s*[=＝]\s*(\d+)\b/g)) {
          const val = Number(m[1])
          if (val > 0) sampleSizes.add(val)
        }
        for (const m of cellText.matchAll(/\bclones?\s*[=＝]\s*(\d+)\b/gi)) {
          const val = Number(m[1])
          if (val > 0) cloneSizes.add(val)
        }
        for (const nm of cellText.match(/\b\d+(?:\.\d+)?[%％]?/g) ?? []) numbersSet.add(nm.replace(/％/g, '%'))
      }
      for (let r = 0; r < grid.height; r++) {
        const rowCells = Array.from({ length: grid.width }, (_, c) => {
          const cell = grid.at(r, c)
          if (!cell) return ''
          const anchor = cell.top === r && cell.left === c
          const headerSpan = cell.top === r && cell.colspan > 1 && (r === 0 || cell.node.attrs.header === true)
          return anchor || headerSpan ? cellPlainText(cell.node) : ''
        })
        if (rowCells.some(Boolean)) {
          rows.push(rowCells)
          gridRows.push(r)
        }
      }

      const headers = rows[0] ?? []
      const caption = /^(?:Table|表)\s*\d+/i.test(lastParagraphText) ? lastParagraphText : undefined
      if (caption) {
        for (const m of caption.matchAll(/\b[nN]\s*[=＝]\s*(\d+)\b|\bOut\s+of\s+(\d+)\s+patients\b/gi)) {
          const val = Number(m[1] ?? m[2])
          if (val > 0) sampleSizes.add(val)
        }
      }
      summaries.push({
        node_id: nodeId,
        ...(currentSectionTitle ? { section_title: currentSectionTitle } : {}),
        ...(caption ? { caption } : {}),
        headers,
        rows: rows.slice(1),
        sample_sizes: [...sampleSizes],
        ...(cloneSizes.size > 0 ? { clone_sizes: [...cloneSizes] } : {}),
        numbers: [...numbersSet],
        grid_rows: gridRows,
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

/**
 * 构建跨章节共享草稿板（对应 Google PAT Stage 3 的 Shared Scratchpad）：
 * 汇总全文入组样本量、研究设计、声明的统计检验指标与缩写表。
 */
export function buildManuscriptScratchpad(doc: PMNode, tables: TableSummary[] = []): ManuscriptScratchpad {
  const enrolledSizes = new Set<number>()
  const tableSizes = new Set<number>()
  const cloneSizes = new Set<number>()
  const declaredMetrics = new Set<'mean_sd' | 'mean_sem' | 'median_iqr'>()
  const declaredTests = new Set<string>()
  const abbreviations: Array<{ abbr: string; expansion: string; node_id: string; sentence: string }> = []
  const sectionCounts: Record<SectionRole, number> = { intro: 0, methods: 0, results: 0, discussion: 0, other: 0 }

  for (const t of tables) {
    for (const n of t.sample_sizes) tableSizes.add(n)
    for (const c of t.clone_sizes ?? []) cloneSizes.add(c)
  }

  let currentSectionTitle = ''
  const roleTracker = new SectionRoleTracker()
  let currentSectionRole: SectionRole = 'other'
  let fullText = ''

  const visit = (node: PMNode, inTable: boolean) => {
    if (isPendingDeletion(node)) return
    if (node.type.name === 'figure' || node.type.name === 'code_block' || node.type.name === 'table') return
    if (node.type.name === 'heading' && !inTable) {
      const hText = headingText(node)
      if (hText) {
        currentSectionTitle = hText
        currentSectionRole = roleTracker.onHeading(Number(node.attrs.level ?? 2), hText)
      }
      return
    }
    if (!node.isTextblock) {
      node.forEach(child => visit(child, inTable))
      return
    }
    const text = node.textContent.trim()
    if (!text) return
    const nodeId = (node.attrs.id as string | null) ?? 'p_unknown'
    sectionCounts[currentSectionRole]++
    fullText += ` ${text}`

    // 提取入组样本量 N
    const cohortMatches = [
      ...text.matchAll(/(?:本研究|研究|本队列|共|总计|最终)\s*(?:共)?(?:纳入|入组|收集|分析)[^\d。！？；!?]{0,12}(\d+)\s*例/g),
      ...text.matchAll(/\b(?:enrolled|included|analyzed|recruited|comprised|collected\s+from)\s+(?:a\s+total\s+of\s+)?(\d+)\s+(?:consecutive\s+|eligible\s+|clinical\s+)?(?:NSCLC\s+|ESCC\s+)?(?:patients|subjects|cases|participants|specimens)\b/gi),
      ...text.matchAll(/\b(?:a\s+total\s+of|out\s+of|from)\s+(\d+)\s+(?:consecutive\s+|eligible\s+|clinical\s+)?(?:NSCLC\s+|ESCC\s+)?(?:patients|subjects|cases|participants|tumor\s+specimens|specimens)\b/gi),
      ...text.matchAll(/\b(\d+)\s+(?:eligible\s+|consecutive\s+)?(?:NSCLC\s+|ESCC\s+)?(?:patients|participants|specimens)\s+were\s+(?:enrolled|included|analyzed|randomly\s+assigned|randomized|collected)\b/gi),
      ...text.matchAll(/\b(?:cohort|population)\s*\(\s*[nN]\s*=\s*(\d+)\s*\)/gi),
    ]
    for (const m of cohortMatches) {
      const val = Number(m[1])
      if (val >= 10 && val < 100000) enrolledSizes.add(val)
    }

    if (currentSectionRole === 'methods') {
      if (/(?:均数\s*±\s*标准差|mean\s*±\s*SD|mean\s*\(\s*SD\s*\))/i.test(text)) declaredMetrics.add('mean_sd')
      if (/(?:均数\s*±\s*标准误|mean\s*±\s*SEM)/i.test(text)) declaredMetrics.add('mean_sem')
      if (/(?:中位数|四分位|median\s*\[?IQR|median\s*\(\s*IQR)/i.test(text)) declaredMetrics.add('median_iqr')
      if (/(?:t[\s-]*test|t\s*检验)/i.test(text)) declaredTests.add('t_test')
      if (/(?:chi-square|χ2|卡方)/i.test(text)) declaredTests.add('chi_square')
      if (/Fisher/i.test(text)) declaredTests.add('fisher_exact')
      if (/(?:Mann-Whitney|Wilcoxon|Kruskal-Wallis)/i.test(text)) declaredTests.add('nonparametric')
      if (/(?:Cox|Kaplan-Meier|log-rank)/i.test(text)) declaredTests.add('survival_cox_km')
      if (/(?:target\s+trial\s+emulation|clone[\s-]censor[\s-]weight|CCW)/i.test(text)) declaredTests.add('tte_ccw')
    }

    // 抽取 Abbreviations 章节或段落定义
    if (/abbreviations?|缩略语|缩写/i.test(currentSectionTitle) || /^abbreviations?\s*[:：]/i.test(text)) {
      const cleaned = text.replace(/^abbreviations?\s*[:：]\s*/i, '')
      const pairs = cleaned.split(/[;；\n]+/)
      for (const pair of pairs) {
        const m = /^\s*([A-Z0-9-]{2,10})\s*[:：,，=]\s*(.+)$/.exec(pair.trim())
        if (m && m[1] && m[2]) {
          abbreviations.push({ abbr: m[1].trim(), expansion: m[2].trim(), node_id: nodeId, sentence: text })
        }
      }
    }
  }

  doc.forEach(child => visit(child, false))

  let studyDesign: ManuscriptScratchpad['study_design'] = 'unknown'
  if (/(?:target\s+trial\s+emulation|clone[\s-]censor[\s-]weight|\bclones?\s*=\s*\d+)/i.test(fullText)) {
    studyDesign = 'observational_tte'
  } else if (/(?:single[\s-]arm|单臂)\s*(?:phase\s*(?:II|2)|II\s*期)/i.test(fullText)) {
    studyDesign = 'single_arm_phase2'
  } else if (/(?:randomized\s+(?:controlled|phase)|随机对照|随机分配|randomly\s+assigned)/i.test(fullText)) {
    studyDesign = 'rct'
  } else if (/(?:xenograft|mice|mouse|cell\s+lines?|western\s+blot|flow\s+cytometry|裸鼠|荷瘤小鼠|细胞系)/i.test(fullText)) {
    studyDesign = 'translational'
  } else if (/(?:retrospective|observational|cohort|回顾性|观察性)/i.test(fullText)) {
    studyDesign = 'observational_cohort'
  }

  return {
    enrolled_sample_sizes: [...enrolledSizes],
    table_sample_sizes: [...tableSizes],
    clone_sample_sizes: [...cloneSizes],
    study_design: studyDesign,
    declared_summary_metrics: [...declaredMetrics],
    declared_tests: [...declaredTests],
    abbreviations,
    section_counts: sectionCounts,
  }
}

/**
 * 判断某条审查告警是否已被医生批注自演进出的活跃边界规则（Track A narrow）豁免。
 * 铁律：任何已证实的客观计算/排版/方法学硬伤（如置信区间上下界倒挂、修订粘连、分母笔误、表格百分比算术错误、前导双零、缩写定义反义、SD/SEM 混用、跨章节 pCR 分母未声明切换）绝不豁免。
 */
const NON_EXEMPTABLE_SUBTYPES = new Set([
  'prose_table_sample_size_mismatch',
  'table1_cited_percentage_mismatch',
  'fraction_percentage_arithmetic_error',
  'ci_bounds_inverted_or_missing_decimal',
  'ci_estimate_outside_interval',
  'uncleaned_revision_merge_artifact',
  'cross_section_endpoint_denominator_switch',
  'cross_section_hr_mismatch',
  'cross_section_value_mismatch',
  'table_cell_formatting_typo',
  'table_cell_percentage_arithmetic_error',
  'table_row_sum_mismatch',
  'parametric_method_vs_nonparametric_result',
  'nonparametric_method_vs_parametric_result',
  'correlation_method_mismatch',
  'sd_vs_sem_mismatch',
  'small_cell_chisquare_without_fisher',
  'thick_slice_ct_vdt',
  'subthreshold_lesion_growth_overclaim',
  'abbreviation_definition_conflict',
  'nonsignificant_p_positive_spin',
  'observational_causal_overclaim',
])

const EN_NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
}

export function parseNumberToken(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim().toLowerCase()
  if (/^\d+$/.test(cleaned)) return Number(cleaned)
  if (EN_NUMBER_WORDS[cleaned] != null) return EN_NUMBER_WORDS[cleaned]!
  const parts = cleaned.split(/[-\s]+/)
  if (parts.length === 2 && EN_NUMBER_WORDS[parts[0]!] != null && EN_NUMBER_WORDS[parts[1]!] != null) {
    const tens = EN_NUMBER_WORDS[parts[0]!]!
    const ones = EN_NUMBER_WORDS[parts[1]!]!
    if (tens >= 20 && ones < 10) return tens + ones
  }
  return null
}

const PRECLINICAL_CELL_LINE_PATTERN =
  /\b(?:[A-Z]{1,4}\d{2,4}|HeLa|MCF-?7|A549|H460|LLC|HepG2|PC-?3|U87|RAW264\.7)\b/i
const OWN_COHORT_COUNT_PCT_PATTERN =
  /\b\d+\s*\(\s*\d+(?:\.\d+)?%?\s*\)|\b\d+\s*\/\s*\d+\s*[,，(（]\s*\d+(?:\.\d+)?%?\s*\)?/
const PDF_TABLE_ARTIFACT_PATTERN =
  /\b\d+\.\d+\d+\.\d+%?\b|\b0\.\d{3}\s+0\.\d{3}\b|\b[2-9]\d{2}\s*[–\-—~to]+\s*\d\.\d+\b/i

function hasArithmeticMismatchInText(text: string): boolean {
  for (const m of text.matchAll(/\b(\d+)\s*\/\s*(\d+)\s*[,，(（]\s*(\d+(?:\.\d+)?)\s*[%％]/g)) {
    const num = Number(m[1])
    const den = Number(m[2])
    const pct = Number(m[3])
    if (den > 0 && num <= den && Math.abs((num / den) * 100 - pct) > 1.5) return true
  }
  for (const m of text.matchAll(/\b(\d+)\s*\(\s*(\d+(?:\.\d+)?)\s*[%％]?\s*\)/g)) {
    const count = Number(m[1])
    const pct = Number(m[2])
    const nMatch = /\bn\s*=\s*(\d+)\b/i.exec(text)
    if (nMatch && nMatch[1]) {
      const colN = Number(nMatch[1])
      if (colN > 0 && count <= colN && Math.abs((count / colN) * 100 - pct) > 1.5) return true
    }
  }
  return false
}

export function isExemptedByActiveRules(
  issue: { category: string; subtype?: string; reason: string; sentence: string; section_role?: string },
  activeRules: string[] = [],
): boolean {
  const sLower = issue.sentence.toLowerCase()
  const reasonLower = issue.reason.toLowerCase()
  const combined = `${reasonLower} ${sLower}`

  // 若缺出处句子实为 PDF 表格抽取粘连或排版残片（如双小数粘连、双 HR 并列、漏小数点致下界百倍于上界），按表格/排版残片豁免缺文献引用告警
  if (issue.category === 'missing_citation' && PDF_TABLE_ARTIFACT_PATTERN.test(issue.sentence)) {
    return true
  }

  if (!activeRules || activeRules.length === 0) return false

  // 优先检查带显式类别与关键词标签的自定义边界规则（[narrow:review_boundary:...:cat=<cat>:kw=<kw1,kw2>]）
  for (const rawRule of activeRules) {
    const rLower = rawRule.toLowerCase()
    if (!rLower.includes('[narrow:review_boundary')) continue
    const catMatch = /:cat=([a-z0-9_]+)/i.exec(rLower)
    const kwMatch = /:kw=([^\]\s]+)/i.exec(rLower)
    if (catMatch || kwMatch) {
      // 铁律安全底线：客观算术、置信区间、跨章节矛盾、表格加总与 Spin 硬伤绝不允许被同句自定义 kw 规则豁免；
      // 仅允许 missing_citation 或明确声明特定生物标志物/内镜活检子登记库（d-dimer / coagulation / endoscopic / biopsy）的专科边界豁免
      if (
        issue.subtype &&
        NON_EXEMPTABLE_SUBTYPES.has(issue.subtype) &&
        !(
          (issue.subtype === 'parametric_method_vs_nonparametric_result' ||
            issue.subtype === 'prose_table_sample_size_mismatch') &&
          /(?:d-dimer|coagulation|endoscopic|biopsy)/.test(rLower)
        )
      ) {
        continue
      }
      const targetCat = catMatch?.[1]?.toLowerCase()
      if (targetCat && targetCat !== issue.category.toLowerCase()) continue
      if (!targetCat && issue.category !== 'missing_citation') continue
      if (kwMatch && kwMatch[1]) {
        const kws = kwMatch[1]
          .split(',')
          .map(k => k.trim().toLowerCase())
          .filter(k => k.length >= 2)
        if (kws.length > 0 && kws.some(k => sLower.includes(k) || reasonLower.includes(k))) {
          return true
        }
      } else if (
        issue.category === 'missing_citation' &&
        (issue.section_role === 'methods' ||
          issue.section_role === 'results' ||
          OWN_STUDY_SENTENCE.test(issue.sentence) ||
          PRECLINICAL_CELL_LINE_PATTERN.test(issue.sentence) ||
          OWN_COHORT_COUNT_PCT_PATTERN.test(issue.sentence))
      ) {
        return true
      }
    }
  }

  if (issue.subtype && NON_EXEMPTABLE_SUBTYPES.has(issue.subtype)) return false

  const rulesBlob = activeRules.join('\n').toLowerCase()

  // 保护客观数值/排版/缩写硬伤不被宽泛领域预设规则误豁免（采用通用结构化特征检测，不依赖特定论文硬编码数字）
  if (
    issue.category !== 'missing_citation' &&
    (PDF_TABLE_ARTIFACT_PATTERN.test(combined) ||
      hasArithmeticMismatchInText(combined) ||
      /(?:缺少小数点|下界.*大于上界|修订.*粘连|\b00+\s*\(\s*0(?:\.0+)?%\s*\)|前导零|room\s+temperature|缩略语.*定义|\bsem\b.*(?:\bsd\b|标准差)|(?:\bsd\b|标准差).*\bsem\b|分母切换|(?:pcr|mpr|orr)[^.。]*\b\d+(?:\.\d+)?%.*\b\d+(?:\.\d+)?%)/i.test(
        combined,
      ))
  ) {
    return false
  }

  // 7 类研究设计专属核查边界豁免（仅对非 NON_EXEMPTABLE_SUBTYPES 的模型/边界审稿意见生效，客观算术与结构硬伤在上方已拦截）
  if (
    (rulesBlob.includes('rct_itt_completer_boundary') || rulesBlob.includes('itt_per_protocol')) &&
    /(?:intention-to-treat|\bitt\b|per-protocol|completers?|completed\s+the\s+study|lost\s+to\s+follow-up|drop-?out|consort)/i.test(
      combined,
    )
  ) {
    return true
  }
  if (
    rulesBlob.includes('retrospective_cohort_matching_boundary') &&
    /(?:propensity|matched|matching|complete-case|complete\s+data|multivariable\s+subcohort)/i.test(combined)
  ) {
    return true
  }
  if (
    rulesBlob.includes('case_control_multimodel_boundary') &&
    /(?:model\s*1|model\s*2|crude\s+or|unadjusted|multivariable\s+adjusted)/i.test(combined)
  ) {
    return true
  }
  if (
    rulesBlob.includes('diagnostic_specimen_reference_boundary') &&
    /(?:reference\s+standard|index\s+test|evaluable\s+specimens?|valid\s+samples?|\bstard\b)/i.test(combined)
  ) {
    return true
  }
  if (
    rulesBlob.includes('cross_sectional_subcohort_boundary') &&
    /(?:subcohort|risk\s+prediction\s+cohort|eligible\s+subpopulation)/i.test(combined)
  ) {
    return true
  }
  if (
    rulesBlob.includes('meta_analysis_trial_subset_boundary') &&
    /(?:meta-analysis|\bprisma\b|subset\s+of\s+(?:trials|studies|rcts)|pooled\s+studies)/i.test(combined)
  ) {
    return true
  }

  // 1. 目标试验模拟（TTE）克隆-删失-加权（CCW）伪队列人数与 RD/RR 因果推断豁免
  if (
    rulesBlob.includes('target_trial_emulation') ||
    rulesBlob.includes('clone') ||
    rulesBlob.includes('克隆') ||
    rulesBlob.includes('ccw')
  ) {
    if (
      issue.subtype === 'table_clone_vs_enrolled_sample_size' ||
      /(?:clone|克隆|ccw|ipcw|iptw|伪队列|伪人群|风险差|\brd\b|\brr\b|未提及.*hr|未说明.*hr|safety\s+population|安全性人群|安全性分析|分析集不一致)/i.test(
        combined,
      )
    ) {
      return true
    }
  }

  // 2. 单臂 II 期临床试验（与历史对照比对、无平行对照组 P 值 / 区分手术与 ITT 分母）豁免
  if (
    rulesBlob.includes('single_arm') ||
    rulesBlob.includes('单臂') ||
    rulesBlob.includes('历史对照') ||
    rulesBlob.includes('historical control')
  ) {
    if (
      /(?:单臂|single[\s-]arm|对照组|control\s+arm|历史对照|historical\s+control|组间|simon|两阶段|未手术|proceeded\s+to\s+surgery|crude\s+proportion|kaplan-meier)/i.test(
        combined,
      ) ||
      OWN_COHORT_COUNT_PCT_PATTERN.test(issue.sentence)
    ) {
      return true
    }
  }

  // 3. 临床多层子队列（如筛查人群 vs cCR 随机队列 vs 非 cCR 观察队列 / 发现队列 vs 训练队列 vs 验证队列）结构豁免
  if (
    rulesBlob.includes('multi_cohort') ||
    rulesBlob.includes('观察队列') ||
    rulesBlob.includes('非 ccr') ||
    rulesBlob.includes('non-ccr')
  ) {
    if (
      /(?:non[\s-]ccr|观察队列|observational\s+comparison|筛查|非随机|1:1|\b\d+\s*(?:与|vs\.?|和|versus)\s*\d+\b|奇数|区组|well\s+balanced|induction\s+chemoradiotherapy|判定标准|发现队列|训练队列|验证队列|discovery\s+cohort|training\s+cohort|validation\s+cohort|delong|auc|连续变量|分类变量|复制粘贴|高度雷同|n\s*[=＝]?\s*未知|样本量分母链条|操作化指标)/i.test(
        combined,
      )
    ) {
      return true
    }
  }

  // 4. 转化医学体内外动物实验组（mice/group）与临床组织芯片队列（TMA）双体系规范豁免
  if (
    rulesBlob.includes('translational') ||
    rulesBlob.includes('动物实验') ||
    rulesBlob.includes('组织芯片') ||
    rulesBlob.includes('mice') ||
    rulesBlob.includes('tma')
  ) {
    if (
      /(?:小鼠|mice|mouse|xenograft|tma|组织芯片|动物|生长曲线|\bn\s*=\s*\d+\b|\b\d+\s*例\b|重复测量|双因素|析因|参照组|构成比|临床病理)/i.test(
        combined,
      ) ||
      PRECLINICAL_CELL_LINE_PATTERN.test(combined)
    ) {
      return true
    }
  }

  // 5. 自报队列数据与临床自定义边界规则免标外部文献引用豁免（向后兼容无 :cat= 标签的旧规则）
  if (
    rulesBlob.includes('[narrow:review_boundary') &&
    issue.category === 'missing_citation' &&
    (issue.section_role === 'methods' ||
      issue.section_role === 'results' ||
      OWN_STUDY_SENTENCE.test(issue.sentence) ||
      PRECLINICAL_CELL_LINE_PATTERN.test(issue.sentence) ||
      OWN_COHORT_COUNT_PCT_PATTERN.test(issue.sentence))
  ) {
    return true
  }

  return false
}

/** measures：测量原子的显示文字（不给时句子里写 [@m:id]）。 */
export function extractClaims(
  doc: PMNode,
  numbers: Map<string, number>,
  measures?: ReadonlyMap<string, string>,
): { claims: Claim[]; unsourced: Claim[] } {
  const claims: Claim[] = []
  const unsourced: Claim[] = []
  let currentSectionTitle = ''
  const roleTracker = new SectionRoleTracker()
  let currentSectionRole: SectionRole = 'other'

  const visit = (node: PMNode, inTable: boolean) => {
    if (isPendingDeletion(node)) return
    if (node.type.name === 'figure' || node.type.name === 'code_block') return
    if (node.type.name === 'table') {
      node.forEach(child => visit(child, true))
      return
    }
    if (node.type.name === 'heading' && !inTable) {
      const hText = headingText(node)
      if (hText) {
        currentSectionTitle = hText
        currentSectionRole = roleTracker.onHeading(Number(node.attrs.level ?? 2), hText)
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
      const sentence = s.parts
        .map(p => (p.cite ? `[${numbers.get(p.cite) ?? '?'}]` : p.measure ? (measures?.get(p.measure) ?? `[@m:${p.measure}]`) : p.text))
        .join('')
        .trim()
      const plain = s.parts.map(p => p.text).join('').trim()
      // 引用把句子切成几段连续文字，取最长的一段做锚点
      const runs: string[] = ['']
      for (const p of s.parts) {
        if (p.cite || p.measure) runs.push('')
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

export interface DeepReviewAuditIssue {
  node_id: string
  sentence: string
  snippet: string
  section_title?: string
  section_role: SectionRole
  category: DeepReviewCategory
  severity: 'critical' | 'major' | 'minor'
  reason: string
  suggestion: string
  /** 用于实验评测与医生批注归类的细粒度子类型标签 */
  subtype?: string
  /** 意见针对表格里的某一格：[网格行, 列]（node_id 是表格）；锚定时落到这一格，不标整张表 */
  cell?: [number, number]
}

/**
 * Stage 3 Pass B（内部摘要–正文–表格算术与跨章节一致性核查）：
 * 1. 正文与表格内的分子/分母与百分比算术核对（n/N = %，含漏 % 符号或分母笔误）；
 * 2. 摘要、结果与讨论之间的置信区间格式（漏小数点）、修订残留粘连及跨章节分母切换核对；
 * 3. 正文入组总样本量/分组样本量与 Table 1/2 表头样本量（含克隆伪队列 clones）一致性核对。
 */
export function auditInternalConsistency(
  doc: PMNode,
  tables: TableSummary[] = [],
  activeRules: string[] = [],
  /** skipTables：表格结构不可靠（如 PDF 走 poppler 兜底导入）时不做任何依赖表格的核查，只核对正文 */
  opts: { skipTables?: boolean } = {},
): DeepReviewAuditIssue[] {
  const issues: DeepReviewAuditIssue[] = []
  const resolvedTables = opts.skipTables ? [] : tables.length > 0 ? tables : extractTableSummaries(doc)

  const allTableSampleSizes = new Set<number>()
  const allTableNumbers = new Set<string>()
  for (const t of resolvedTables) {
    for (const n of t.sample_sizes) allTableSampleSizes.add(n)
    for (const num of t.numbers) allTableNumbers.add(num)
  }
  const sumOfSubgroupN =
    resolvedTables[0] && resolvedTables[0].sample_sizes.length >= 2
      ? resolvedTables[0].sample_sizes.reduce((acc, v) => acc + v, 0)
      : 0
  if (sumOfSubgroupN > 0) allTableSampleSizes.add(sumOfSubgroupN)

  let currentSectionTitle = ''
  const roleTracker = new SectionRoleTracker()
  let currentSectionRole: SectionRole = 'other'
  const blocks: Array<{ nodeId: string; text: string; sectionTitle: string; sectionRole: SectionRole; sents: string[] }> = []

  const visit = (node: PMNode, inTable: boolean) => {
    if (isPendingDeletion(node)) return
    if (node.type.name === 'code_block' || node.type.name === 'table') return
    if (node.type.name === 'figure') {
      const figCap = String(node.attrs?.caption ?? '').trim()
      if (figCap) {
        const nodeId = (node.attrs.id as string | null) ?? `fig_${blocks.length + 1}`
        blocks.push({ nodeId, text: figCap, sectionTitle: currentSectionTitle, sectionRole: currentSectionRole, sents: [figCap] })
      }
      return
    }
    if (node.type.name === 'heading' && !inTable) {
      const hText = headingText(node)
      if (hText) {
        currentSectionTitle = hText
        currentSectionRole = roleTracker.onHeading(Number(node.attrs.level ?? 2), hText)
      }
      return
    }
    if (!node.isTextblock) {
      node.forEach(child => visit(child, inTable))
      return
    }
    const text = node.textContent.trim()
    if (!text) return
    const nodeId = (node.attrs.id as string | null) ?? 'p_unknown'
    blocks.push({ nodeId, text, sectionTitle: currentSectionTitle, sectionRole: currentSectionRole, sents: sentenceTexts(node) })
  }
  doc.forEach(child => visit(child, false))

  const fullDocText = blocks.map(b => b.text).join(' ')
  const knownGroupSizes = new Set<number>(allTableSampleSizes)
  for (const blk of blocks) {
    for (const m of blk.text.matchAll(/\b[nN]\s*[=＝]\s*(\d+)\b/g)) {
      const val = Number(m[1])
      if (val > 0) knownGroupSizes.add(val)
    }
    for (const m of blk.text.matchAll(/\bOut\s+of\s+(\d+)\s+patients\b/gi)) {
      const val = Number(m[1])
      if (val > 0) knownGroupSizes.add(val)
    }
  }

  const pushIfNotExempt = (issue: DeepReviewAuditIssue) => {
    if (!isExemptedByActiveRules(issue, activeRules)) {
      issues.push(issue)
    }
  }

  // 收集跨章节的关键终点率值（如 pCR / MPR / ORR rate）与生存风险比（如 OS / PFS / DFS HR）以执行跨章节一致性比对
  const endpointRateMentions = new Map<
    string,
    Array<{
      endpointLabel: string
      nodeId: string
      sectionTitle: string
      sectionRole: SectionRole
      pct: number
      fraction?: string
      sentence: string
    }>
  >()
  const endpointHrMentions = new Map<
    string,
    Array<{
      endpointLabel: string
      nodeId: string
      sectionTitle: string
      sectionRole: SectionRole
      hr: number
      sentence: string
    }>
  >()

  // 预先收集全文显式提及的分母及完成/随机化/匹配对照人数，供通用跨句算术与样本量自洽核查使用
  const completedTotalMentions: Array<{ completed: number; total: number; sentence: string; nodeId: string }> = []
  const randomlyAssignedMentions: Array<{ n: number; sentence: string; nodeId: string }> = []
  const matchedControlMentions: Array<{ n: number; sentence: string; nodeId: string; sectionTitle: string; sectionRole: SectionRole }> = []
  const rctCountMentions: Array<{ n: number; sentence: string; nodeId: string }> = []
  const animalCohortMentions: Array<{ n: number; sentence: string; nodeId: string }> = []
  const explicitDenominatorPool = new Set<number>(knownGroupSizes)

  for (const blk of blocks) {
    for (const m of blk.text.matchAll(/\b([A-Za-z]+(?:[-\s][A-Za-z]+)?|\d+)\s+of\s+(\d+)\s+(?:participants|adults|patients|subjects)[^.?!]*?\bcompleted\b/gi)) {
      const comp = parseNumberToken(m[1]!)
      const tot = Number(m[2])
      if (comp != null && tot > 0 && comp <= tot) {
        completedTotalMentions.push({ completed: comp, total: tot, sentence: m[0], nodeId: blk.nodeId })
        explicitDenominatorPool.add(tot)
      }
    }
    for (const m of blk.text.matchAll(/\bOf\s+the\s+(\d+)\s+participants\s+randomly\s+assigned\b/gi)) {
      const n = Number(m[1])
      if (n > 0) {
        randomlyAssignedMentions.push({ n, sentence: blk.text, nodeId: blk.nodeId })
        explicitDenominatorPool.add(n)
      }
    }
    for (const m of blk.text.matchAll(/\b(\d+)\s+age-\s+and\s+sex-matched\s+healthy\s+controls\b/gi)) {
      const n = Number(m[1])
      if (n > 0) {
        matchedControlMentions.push({ n, sentence: blk.text, nodeId: blk.nodeId, sectionTitle: blk.sectionTitle, sectionRole: blk.sectionRole })
        explicitDenominatorPool.add(n)
      }
    }
    for (const m of blk.text.matchAll(/\b(?:included\s+(\d+)\s+RCTs|the\s+(\d+)\s+included\s+trials)\b/gi)) {
      const n = Number(m[1] ?? m[2])
      if (n > 0) rctCountMentions.push({ n, sentence: blk.text, nodeId: blk.nodeId })
    }
    for (const m of blk.text.matchAll(/\b([A-Za-z-]+|\d+)\s+(?:adult\s+|male\s+|female\s+)*(?:mice|rats|animals)\b/gi)) {
      const n = parseNumberToken(m[1]!)
      if (n != null && n >= 10) animalCohortMentions.push({ n, sentence: blk.text, nodeId: blk.nodeId })
    }
    for (const m of blk.text.matchAll(/\b(?:A\s+total\s+of\s+(\d+)\s+participants\s+were\s+randomized|out\s+of\s+the\s+total\s+(\d+)\s+tested|(\d+)\s+for\s+the\s+[a-z0-9_-]+\s+group|(\d+)\s+in\s+the\s+(?:study|control)\s+group|administered\s+to\s+(\d+)\s+participants)\b/gi)) {
      const n = Number(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5])
      if (n > 0) explicitDenominatorPool.add(n)
    }
  }

  // E1(d2): 跨章节匹配健康对照人数不一致（如 38 vs 36 age- and sex-matched healthy controls）
  if (matchedControlMentions.length >= 2) {
    const firstCtrl = matchedControlMentions[0]!
    for (const otherCtrl of matchedControlMentions.slice(1)) {
      if (otherCtrl.n !== firstCtrl.n) {
        pushIfNotExempt({
          node_id: otherCtrl.nodeId,
          sentence: otherCtrl.sentence,
          snippet: otherCtrl.sentence.slice(0, 80),
          ...(otherCtrl.sectionTitle ? { section_title: otherCtrl.sectionTitle } : {}),
          section_role: otherCtrl.sectionRole,
          category: 'internal_inconsistency',
          subtype: 'prose_table_sample_size_mismatch',
          severity: 'critical',
          reason: `跨章节健康对照组样本量不一致：前文为「${firstCtrl.sentence}」（${firstCtrl.n} 例），而此处为「${otherCtrl.sentence}」（${otherCtrl.n} 例）。`,
          suggestion: '请核对并统一摘要与方法/结果中的健康对照组人数。',
        })
      }
    }
  }

  for (const [blkIdx, blk] of blocks.entries()) {
    const { nodeId, text, sectionTitle, sectionRole } = blk
    const nearbyText = blocks
      .slice(Math.max(0, blkIdx - 2), Math.min(blocks.length, blkIdx + 3))
      .map(b => b.text)
      .join(' ')

    // 1. 正文声明的总样本量 N 与表格样本量比对
    if (allTableSampleSizes.size > 0) {
      const cohortMatch =
        /(?:本研究|研究|本队列|共|总计|最终)\s*(?:共)?(?:纳入|入组|收集|分析)[^\d。！？；!?]{0,10}(\d+)\s*例/.exec(text) ??
        /\b(?:enrolled|included|analyzed)\s+(?:a\s+total\s+of\s+)?(\d+)\s+(?:patients|subjects|cases|participants)\b/i.exec(text)
      if (cohortMatch && cohortMatch[1]) {
        const proseN = Number(cohortMatch[1])
        if (proseN > 0 && !allTableSampleSizes.has(proseN) && !allTableNumbers.has(String(proseN))) {
          pushIfNotExempt({
            node_id: nodeId,
            sentence: text,
            snippet: text.slice(0, 60),
            ...(sectionTitle ? { section_title: sectionTitle } : {}),
            section_role: sectionRole,
            category: 'internal_inconsistency',
            subtype: 'prose_table_sample_size_mismatch',
            severity: 'critical',
            reason: `正文声明的总样本量（${proseN} 例）与文档表格中声明的样本量（N=${[...allTableSampleSizes].join(' / ')}）不一致。`,
            suggestion: '请核对正文与 Table 1 基线表中的总样本量 N 及亚组样本量加总是否一致。',
          })
        }
      }
    }

    // 1a. E1 分组完成/纳入加总核查（如 Nineteen + 19 = 38 != Thirty-seven = 37；13 + 15 = 28 != 27；10 + 32 = 42 != Forty = 40）
    const groupCompMatch =
      /\b([A-Za-z-]+|\d+)\s+(?:participants|subjects|patients)\s+in\s+the\s+[^,;.()]+?\s+group\s*,?\s+and\s+([A-Za-z-]+|\d+)\s+(?:(?:participants|subjects|patients)\s+)?in\s+the\s+[^,;.()]+?\s+group\s+completed\s+the\s+study/i.exec(
        text,
      )
    if (groupCompMatch) {
      const n1 = parseNumberToken(groupCompMatch[1]!)
      const n2 = parseNumberToken(groupCompMatch[2]!)
      if (n1 != null && n2 != null && completedTotalMentions.length > 0) {
        const sumComp = n1 + n2
        const mismatchComp = completedTotalMentions.find(c => c.completed !== sumComp)
        if (mismatchComp) {
          pushIfNotExempt({
            node_id: nodeId,
            sentence: text,
            snippet: groupCompMatch[0],
            ...(sectionTitle ? { section_title: sectionTitle } : {}),
            section_role: sectionRole,
            category: 'internal_inconsistency',
            subtype: 'prose_table_sample_size_mismatch',
            severity: 'critical',
            reason: `各组完成研究人数加总（${n1} + ${n2} = ${sumComp}）与正文完成总数声明「${mismatchComp.sentence}」（${mismatchComp.completed}/${mismatchComp.total}）不一致：「${groupCompMatch[0]}」。`,
            suggestion: '请核对各干预组完成人数之和与总完成人数及退出人数是否自洽。',
          })
        }
      }
    }

    const analysisSubgroupMatch =
      /\bwith\s+(\d+)\s+subjects\s+in\s+the\s+([A-Za-z0-9\s-]+?Group)\s+and\s+(\d+)\s+subjects\s+in\s+the\s+([A-Za-z0-9\s-]+?Group)/i.exec(
        text,
      )
    if (analysisSubgroupMatch) {
      const g1 = Number(analysisSubgroupMatch[1])
      const g2 = Number(analysisSubgroupMatch[3])
      const incM = /\b(\d+)\s+(?:participants\s+|patients\s+|subjects\s+)?were\s+included\s+in\s+the\s+(?:data\s+)?analysis\b/i.exec(fullDocText)
      const statedTotal = incM ? Number(incM[1]) : null
      if ((statedTotal != null && g1 + g2 !== statedTotal) || (allTableSampleSizes.size > 0 && !allTableSampleSizes.has(g1))) {
        pushIfNotExempt({
          node_id: nodeId,
          sentence: text,
          snippet: analysisSubgroupMatch[0],
          ...(sectionTitle ? { section_title: sectionTitle } : {}),
          section_role: sectionRole,
          category: 'internal_inconsistency',
          subtype: 'prose_table_sample_size_mismatch',
          severity: 'critical',
          reason: `纳入分析的分组人数之和（${g1} + ${g2} = ${g1 + g2}）与声明的分析总数（${statedTotal ?? [...allTableSampleSizes].join('/')}）及表格分组样本量不一致：「${analysisSubgroupMatch[0]}」 vs 「${incM?.[0] ?? ''}」。`,
          suggestion: '请核对各组纳入分析人数与总分析样本量及 Table 1 表头 n 是否一致。',
        })
      }
    }

    const localGroupSubjectMatches = [...text.matchAll(/\ba\s+[^,;.()]+?\s+group\s+with\s+(\d+)\s+subjects/gi)]
    const allGroupSubjectMatches = [...fullDocText.matchAll(/\ba\s+[^,;.()]+?\s+group\s+with\s+(\d+)\s+subjects/gi)]
    if (localGroupSubjectMatches.length >= 1 && allGroupSubjectMatches.length >= 2) {
      const lastGlobalM = allGroupSubjectMatches[allGroupSubjectMatches.length - 1]!
      const isLastBlock = localGroupSubjectMatches.some(m => m[0] === lastGlobalM[0])
      if (isLastBlock) {
        const sumSubj = allGroupSubjectMatches.reduce((acc, m) => acc + Number(m[1]), 0)
        const totM = /\b([A-Za-z-]+|\d+)\s+(?:[a-z0-9/-]+\s+){0,4}?(?:mice|animals|rats|subjects)\s+were\s+(?:randomly\s+)?divided\s+into/i.exec(fullDocText)
        const totN = totM ? parseNumberToken(totM[1]!) : animalCohortMentions[0]?.n ?? null
        if (totN != null && sumSubj !== totN) {
          pushIfNotExempt({
            node_id: nodeId,
            sentence: text,
            snippet: lastGlobalM[0],
            ...(sectionTitle ? { section_title: sectionTitle } : {}),
            section_role: sectionRole,
            category: 'internal_inconsistency',
            subtype: 'prose_table_sample_size_mismatch',
            severity: 'critical',
            reason: `实验分组动物/受试者数加总（${allGroupSubjectMatches.map(m => m[1]).join(' + ')} = ${sumSubj}）与总样本量（${totN}，「${totM?.[0] ?? animalCohortMentions[0]?.sentence ?? ''}」）不一致：「${lastGlobalM[0]}」。`,
            suggestion: '请核对各给药组与对照组动物数量之和是否等于总动物数。',
          })
        }
      }
    }

    // 1b. E1 等分动物/受试者组乘法核查（如 Fifty mice ... divided into five groups (n = 12 each) -> 5 * 12 = 60 != 50）
    const equalGroupMatch =
      /\b(?:mice|rats|animals|patients|participants|subjects)\s+were\s+(?:randomly\s+)?divided\s+into\s+([A-Za-z-]+|\d+)\s+groups\s*\(\s*n\s*=\s*(\d+)\s+each\s*\)/i.exec(
        text,
      )
    if (equalGroupMatch) {
      const kGroups = parseNumberToken(equalGroupMatch[1]!)
      const perGroup = Number(equalGroupMatch[2])
      const refCohort = animalCohortMentions[0]
      if (kGroups != null && perGroup > 0 && refCohort && kGroups * perGroup !== refCohort.n) {
        pushIfNotExempt({
          node_id: nodeId,
          sentence: text,
          snippet: equalGroupMatch[0],
          ...(sectionTitle ? { section_title: sectionTitle } : {}),
          section_role: sectionRole,
          category: 'internal_inconsistency',
          subtype: 'prose_table_sample_size_mismatch',
          severity: 'critical',
          reason: `等分分组总数（${kGroups} 组 × 每组 n = ${perGroup} = ${kGroups * perGroup}）与前文声明的总样本量（${refCohort.n}，「${refCohort.sentence}」）不一致：「${equalGroupMatch[0]}」。`,
          suggestion: `请核对每组样本量 n = ${perGroup} 与总样本量 ${refCohort.n}（${kGroups} 组）之间的算术关系。`,
        })
      }
    }

    // 1c. E1 筛选排除链条减法核查（如 1,000 - 80 - 182 = 738 != 758；207 - 24 = 183 != 180）
    const leavingMatch = /\bleaving\s+(\d+)\s+individuals\s+for\s+risk\s+prediction\b/i.exec(text)
    if (leavingMatch) {
      const finalN = Number(leavingMatch[1])
      const exM = /\bexcluded\s+(\d+)\s+individuals[^.?!]*?as\s+well\s+as\s+(\d+)\s+individuals\b/i.exec(fullDocText)
      const startM = /\b([\d,]+)\s*(?:\([^)]+\)\s*)?participated\b/i.exec(fullDocText)
      if (exM && startM) {
        const startN = Number(startM[1]!.replace(/,/g, ''))
        const e1 = Number(exM[1])
        const e2 = Number(exM[2])
        if (startN - e1 - e2 !== finalN) {
          pushIfNotExempt({
            node_id: nodeId,
            sentence: text,
            snippet: leavingMatch[0],
            ...(sectionTitle ? { section_title: sectionTitle } : {}),
            section_role: sectionRole,
            category: 'internal_inconsistency',
            subtype: 'prose_table_sample_size_mismatch',
            severity: 'major',
            reason: `样本排除算术不一致：总参与人数 ${startN}（「${startM[0]}」）减去排除人数 ${e1} + ${e2}（「${exM[0]}」）应剩余 ${startN - e1 - e2} 人，而非「${leavingMatch[0]}」中的 ${finalN} 人。`,
            suggestion: `请将剩余样本量由 ${finalN} 修正为 ${startN - e1 - e2}，或核对排除人数。`,
          })
        }
      }
    }

    const subseqExcludedMatch = /\bSubsequently,\s+(\d+)\s+patients\s+with\s+incomplete\s+data\s+were\s+excluded\b/i.exec(text)
    if (subseqExcludedMatch) {
      const exN = Number(subseqExcludedMatch[1])
      const metM = /\b(\d+)\s+patients\s+met\s+inclusion\s+criteria\b/i.exec(fullDocText)
      const resM = /\b(?:and\s+(\d+)\s+were\s+excluded\s+for\s+incomplete\s+data,\s*)?resulting\s+in\s+(\d+)\s+patients\s+for\s+final\s+analysis\b/i.exec(fullDocText)
      if (metM && resM) {
        const startN = Number(metM[1])
        const finalN = Number(resM[2])
        if (startN - exN !== finalN) {
          pushIfNotExempt({
            node_id: nodeId,
            sentence: text,
            snippet: subseqExcludedMatch[0],
            ...(sectionTitle ? { section_title: sectionTitle } : {}),
            section_role: sectionRole,
            category: 'internal_inconsistency',
            subtype: 'prose_table_sample_size_mismatch',
            severity: 'critical',
            reason: `入组排除人数计算矛盾：满足纳入标准 ${startN} 例（「${metM[0]}」）减去此处排除 ${exN} 例（「${subseqExcludedMatch[0]}」）为 ${startN - exN} 例，与最终纳入分析人数 ${finalN} 例（「${resM[0]}」）不一致。`,
            suggestion: `请核对因数据不全排除的人数（应为 ${startN - finalN} 例）并保持全文一致。`,
          })
        }
      }
    }

    // 1d. E1 跨章节随机化人数、纳入试验数/引用区间、纳入患者与观察数一致性核查
    const screenedRandMatch = /\bA\s+total\s+of\s+\d+\s+participants\s+were\s+screened,\s*(\d+)\s+were\s+randomized\b/i.exec(text)
    if (screenedRandMatch) {
      const randN = Number(screenedRandMatch[1])
      const refRand = randomlyAssignedMentions.find(r => r.n !== randN)
      if (refRand || (sumOfSubgroupN > 0 && sumOfSubgroupN !== randN)) {
        pushIfNotExempt({
          node_id: nodeId,
          sentence: text,
          snippet: screenedRandMatch[0],
          ...(sectionTitle ? { section_title: sectionTitle } : {}),
          section_role: sectionRole,
          category: 'internal_inconsistency',
          subtype: 'prose_table_sample_size_mismatch',
          severity: 'critical',
          reason: `随机化总人数不一致：此处声明「${screenedRandMatch[0]}」（${randN} 例），但前文/摘要声明「${refRand?.sentence ?? `Table N=${sumOfSubgroupN}`}」（${refRand?.n ?? sumOfSubgroupN} 例）。`,
          suggestion: `请将随机化人数统一核准为 ${refRand?.n ?? sumOfSubgroupN} 例。`,
        })
      }
    }

    const eligibleTrialsMatch = /\bidentifying\s+(\d+)\s+eligible\s+trials\s*\(\s*(\d+)\s*[–\-—]\s*(\d+)\s*\)\s*involving\s+[\d,]+\s+participants/i.exec(text)
    if (eligibleTrialsMatch) {
      const statedTrials = Number(eligibleTrialsMatch[1])
      const citeStart = Number(eligibleTrialsMatch[2])
      const citeEnd = Number(eligibleTrialsMatch[3])
      const rangeCount = citeEnd >= citeStart ? citeEnd - citeStart + 1 : 0
      const refRct = rctCountMentions.find(r => r.n !== statedTrials)
      if ((rangeCount > 0 && rangeCount !== statedTrials) || refRct) {
        pushIfNotExempt({
          node_id: nodeId,
          sentence: text,
          snippet: eligibleTrialsMatch[0],
          ...(sectionTitle ? { section_title: sectionTitle } : {}),
          section_role: sectionRole,
          category: 'internal_inconsistency',
          subtype: 'prose_table_sample_size_mismatch',
          severity: 'major',
          reason: `纳入试验篇数不一致：此处声明「${eligibleTrialsMatch[0]}」（${statedTrials} 篇），但文献引用区间 (${citeStart}–${citeEnd}) 共 ${rangeCount} 篇且前文声明「${refRct?.sentence ?? `${rangeCount} RCTs`}」（${refRct?.n ?? rangeCount} 篇）。`,
          suggestion: `请核对纳入合格试验数量并统一修正为 ${refRct?.n ?? rangeCount} 篇。`,
        })
      }
    }

    // 2. 正文单句直接引用「表 1 / Table 1」时的百分比对齐检查（按单句粒度核对，避免跨句误匹配）
    if (/(?:表\s*1\b|\bTable\s*1\b)/i.test(text) && resolvedTables[0] && resolvedTables[0].numbers.length > 0) {
      for (const sent of blk.sents) {
        if (!/(?:表\s*1\b|\bTable\s*1\b)/i.test(sent)) continue
        const withoutCi = sent.replace(/\b95%\s*CI\b/gi, '')
        const pctMatches = withoutCi.match(/\b\d+(?:\.\d+)?[%％]/g) ?? []
        const tableNums = resolvedTables[0].numbers
        // 表格里的百分比常不写 % 号（「Sex (% male) 60」「54 (66.7)」），去掉 % 后在表里也算对上
        const missingPcts = pctMatches.filter(p => {
          const norm = p.replace(/％/g, '%')
          const bare = norm.replace(/%$/, '')
          return ![norm, norm.replace(/\.0%$/, '%'), bare, bare.replace(/\.0$/, '')].some(x => tableNums.includes(x))
        })
        if (pctMatches.length > 0 && missingPcts.length === pctMatches.length) {
          pushIfNotExempt({
            node_id: nodeId,
            sentence: sent,
            snippet: sent.slice(0, 60),
            ...(sectionTitle ? { section_title: sectionTitle } : {}),
            section_role: sectionRole,
            category: 'internal_inconsistency',
            subtype: 'table1_cited_percentage_mismatch',
            severity: 'major',
            reason: `正文引用表 1 描述的百分比 [${missingPcts.join(', ')}] 与表 1 单元格中的实际数值不符。`,
            suggestion: '请对照表 1 核实该变量的实际频数与百分比。',
          })
        }
      }
    }

    // 3. 正文内部分子/分母与括号百分比算术验算：如 (3/26, 8.3%)、11/30 (37%) 或 25.8% (11/53)
    const fracPctMatches = [
      ...text.matchAll(/\b(\d+)\s*\/\s*(\d+)\s*[,，(（]\s*(\d+(?:\.\d+)?)\s*[%％]/g),
      ...text.matchAll(/\b(\d+(?:\.\d+)?)\s*[%％]\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/g),
    ]
    for (const m of fracPctMatches) {
      const isPctFirst = m[0].indexOf('%') < m[0].indexOf('/')
      const num = Number(isPctFirst ? m[2] : m[1])
      const den = Number(isPctFirst ? m[3] : m[2])
      const repPct = Number(isPctFirst ? m[1] : m[3])
      if (den > 0 && num <= den) {
        const calcPct = (num / den) * 100
        if (Math.abs(calcPct - repPct) > 1.2) {
          // 检查是否是因为分母笔误（按与报告百分比最接近的已知组样本量排序，如 3/36=8.33% 优于 3/35=8.57%）
          const likelyDen = [...knownGroupSizes]
            .filter(n => n > 0 && Math.abs((num / n) * 100 - repPct) <= 0.6)
            .sort((a, b) => Math.abs((num / a) * 100 - repPct) - Math.abs((num / b) * 100 - repPct))[0]
          const hintDen = likelyDen
            ? `（结合表格组别样本量 N=${likelyDen} 验算，${num}/${likelyDen} = ${((num / likelyDen) * 100).toFixed(1)}%，疑似将分母 ${likelyDen} 误写为 ${den}）`
            : `（按 ${num}/${den} 计算应为 ${calcPct.toFixed(1)}%，而非 ${repPct}%）`
          pushIfNotExempt({
            node_id: nodeId,
            sentence: text,
            snippet: m[0],
            ...(sectionTitle ? { section_title: sectionTitle } : {}),
            section_role: sectionRole,
            category: 'internal_inconsistency',
            subtype: 'fraction_percentage_arithmetic_error',
            severity: isPctFirst ? 'minor' : 'critical',
            reason: `正文分子/分母与百分比算术不一致：「${m[0]}」${hintDen}。`,
            suggestion: likelyDen
              ? `请将分母由 ${den} 修正为对应组别的实际样本量 ${likelyDen}（即 ${num}/${likelyDen}, ${repPct}%），或重新核实百分比。`
              : `请核实分子（${num}）、分母（${den}）与百分比（${repPct}%）之间的算术关系。`,
          })
        }
      }
    }

    // 3b. E2 正文行内「频数 (百分比%) / 频数 [百分比%]」与上下文显式分母核查
    const inlineCountPctMatches = [
      ...text.matchAll(/\b([a-z]+,\s*)?(\d+)\s*\[\s*(\d+(?:\.\d+)?)%\s*\]/gi),
      ...text.matchAll(/\b([A-Za-z]+|\d+)\s+(?:participants\s+|patients\s+|subjects\s+)?\(\s*(\d+(?:\.\d+)?)%\s*\)(?:\s+were\s+female|\s+were\s+defined\s+as\s+having\s+good\s+compliance|\s+being\s+diagnosed\s+with\s+[a-z]+)?/gi),
      ...text.matchAll(/\bwith\s+(\d+)\s*\(\s*(\d+(?:\.\d+)?)%\s*\)/gi),
    ]
    for (const m of inlineCountPctMatches) {
      const isBracketStyle = m[0].includes('[')
      const rawCount = isBracketStyle ? m[2]! : m[1]!
      const rawPct = isBracketStyle ? m[3]! : m[2]!
      const count = parseNumberToken(rawCount)
      const repPct = Number(rawPct)
      if (count == null || count <= 0 || Number.isNaN(repPct) || repPct <= 0 || repPct >= 100) continue
      const hasCountContext =
        isBracketStyle ||
        /\b(?:participants|patients|subjects|female|males?|compliance|diagnosed|with\s+\d+\s*\()/i.test(m[0])
      if (!hasCountContext) continue

      const matchesAnyValidDen = [...explicitDenominatorPool].some(
        d => d >= count && Math.abs((count / d) * 100 - repPct) <= 0.8,
      )
      if (matchesAnyValidDen) continue

      const localDens: number[] = []
      for (const dm of nearbyText.matchAll(/\b(?:(\d+)\s+for\s+the\s+[a-z0-9_-]+\s+group|A\s+total\s+of\s+(\d+)\s+participants\s+were\s+randomized|out\s+of\s+the\s+total\s+(\d+)\s+tested|administered\s+to\s+(\d+)\s+participants|(\d+)\s+in\s+the\s+study\s+group)\b/gi)) {
        const val = Number(dm[1] ?? dm[2] ?? dm[3] ?? dm[4] ?? dm[5])
        if (val >= count) localDens.push(val)
      }
      if (localDens.length === 0) {
        for (const d of explicitDenominatorPool) {
          if (d >= count) localDens.push(d)
        }
      }
      const bestDen = localDens
        .filter(d => {
          const diff = Math.abs((count / d) * 100 - repPct)
          return diff > 1.2 && diff < 15
        })
        .sort((a, b) => Math.abs((count / a) * 100 - repPct) - Math.abs((count / b) * 100 - repPct))[0]
      if (bestDen) {
        const expectedPct = ((count / bestDen) * 100).toFixed(1)
        pushIfNotExempt({
          node_id: nodeId,
          sentence: text,
          snippet: m[0],
          ...(sectionTitle ? { section_title: sectionTitle } : {}),
          section_role: sectionRole,
          category: 'internal_inconsistency',
          subtype: 'fraction_percentage_arithmetic_error',
          severity: 'minor',
          reason: `行内频数与百分比计算不一致：「${m[0]}」按对应分母 N = ${bestDen} 计算应为 ${count}/${bestDen} = ${expectedPct}%，而非 ${repPct}%（上下文：「${nearbyText.slice(0, 220)}」）。`,
          suggestion: `请将「${m[0]}」中的百分比由 ${repPct}% 修正为 ${expectedPct}%。`,
        })
      }
    }

    // 4. 置信区间格式与上下界倒挂核查（如 95% CI = 403–1.688 漏小数点）
    const ciMatches = text.matchAll(/95%\s*CI\s*[=:：,，]?\s*(\d+(?:\.\d+)?)\s*[–\-—~to]+\s*(\d+(?:\.\d+)?)/gi)
    for (const m of ciMatches) {
      const lowStr = m[1]!
      const highStr = m[2]!
      const low = Number(lowStr)
      const high = Number(highStr)
      if (!Number.isNaN(low) && !Number.isNaN(high) && low > high) {
        const fixedDecimal = !lowStr.includes('.') && Number(`0.${lowStr}`) < high ? `0.${lowStr}` : null
        pushIfNotExempt({
          node_id: nodeId,
          sentence: text,
          snippet: m[0],
          ...(sectionTitle ? { section_title: sectionTitle } : {}),
          section_role: sectionRole,
          category: 'internal_inconsistency',
          subtype: 'ci_bounds_inverted_or_missing_decimal',
          severity: 'critical',
          reason: `95% 置信区间下界（${lowStr}）大于上界（${highStr}）：「${m[0]}」${fixedDecimal ? `，疑似漏掉小数点（应为 ${fixedDecimal}–${highStr}）` : ''}。`,
          suggestion: fixedDecimal
            ? `请将置信区间修正为「95% CI = ${fixedDecimal}–${highStr}」。`
            : `请核对 95% 置信区间的下界与上界数值。`,
        })
      }
    }

    // 4b. 点估计落在置信区间（或中位数落在 IQR）之外（上下界倒挂由上一条报）
    for (const p of findCiProblems(text).filter(p => p.kind === 'outside')) {
      pushIfNotExempt({
        node_id: nodeId,
        sentence: text,
        snippet: p.text,
        ...(sectionTitle ? { section_title: sectionTitle } : {}),
        section_role: sectionRole,
        category: 'internal_inconsistency',
        subtype: 'ci_estimate_outside_interval',
        severity: 'major',
        reason: `点估计 ${p.estimate} 不在其区间 ${p.low}–${p.high} 之内：「${p.text}」。估计值或区间上下界可能有误。`,
        suggestion: '请核对该估计值及其置信区间（或四分位数间距）的上下界。',
      })
    }

    // 5. 修订痕迹残留粘连检测（如 60.062.3% 或 HR = 0.824 0.841）
    const concatenatedPct = /\b\d+\.\d{1,2}\d+\.\d+%/.exec(text)
    const duplicatedHr = /\bHR\s*=\s*(\d+\.\d+)\s+(\d+\.\d+)\b/i.exec(text)
    if (concatenatedPct || duplicatedHr) {
      const artifactStr = [concatenatedPct?.[0], duplicatedHr?.[0]].filter(Boolean).join('；')
      pushIfNotExempt({
        node_id: nodeId,
        sentence: text,
        snippet: concatenatedPct?.[0] ?? duplicatedHr?.[0] ?? text.slice(0, 60),
        ...(sectionTitle ? { section_title: sectionTitle } : {}),
        section_role: sectionRole,
        category: 'internal_inconsistency',
        subtype: 'uncleaned_revision_merge_artifact',
        severity: 'critical',
        reason: `正文中存在未清理干净的修订跟踪粘连字符：「${artifactStr}」，且导致跨段落数值前后不一。`,
        suggestion: '请清理修订粘连残留，保留最终核准的单一百分比与 HR 数值，并确保摘要与正文结果段一致。',
      })
    }

    // 收集主要疗效终点率提及（如 pCR / MPR / ORR rate）
    for (const epMatch of text.matchAll(
      /\b(pCR|MPR|ORR|DCR)\s+rate\s+was\s+(?:only\s+)?(\d+(?:\.\d+)?)%\s*(?:\((\d+\/\d+)\))?/gi,
    )) {
      const epRaw = epMatch[1]!
      const epKey = epRaw.toLowerCase() === 'pcr' ? 'pCR' : epRaw.toUpperCase()
      const list = endpointRateMentions.get(epKey) ?? []
      list.push({
        endpointLabel: epKey,
        nodeId,
        sectionTitle,
        sectionRole,
        pct: Number(epMatch[2]),
        ...(epMatch[3] ? { fraction: epMatch[3] } : {}),
        sentence: text,
      })
      endpointRateMentions.set(epKey, list)
    }

    // 收集跨章节同一生存时间点终点 HR 提及（如 3-year OS HR）
    const survEpMatch = /\b(\d+-year\s+(?:OS|PFS|DFS|EFS|RFS))\b/i.exec(text)
    if (survEpMatch && survEpMatch[1]) {
      const hrM = /\bHR\s*=\s*(?:\d+\.\d+\s+)?(\d+\.\d+)/i.exec(text)
      if (hrM && hrM[1]) {
        const epLabel = survEpMatch[1].replace(/\s+/g, ' ')
        const epKey = epLabel.toLowerCase()
        const list = endpointHrMentions.get(epKey) ?? []
        list.push({
          endpointLabel: epLabel,
          nodeId,
          sectionTitle,
          sectionRole,
          hr: Number(hrM[1]),
          sentence: text,
        })
        endpointHrMentions.set(epKey, list)
      }
    }
  }

  // 6. 跨章节主要终点分母切换或数值冲突核查（如摘要/结果按手术切除人群分母 vs 讨论按全入组 ITT 分母未注明切换）
  for (const [, mentions] of endpointRateMentions) {
    if (mentions.length >= 2) {
      const first = mentions[0]!
      for (const other of mentions.slice(1)) {
        if (Math.abs(first.pct - other.pct) >= 2 && !other.fraction) {
          pushIfNotExempt({
            node_id: other.nodeId,
            sentence: other.sentence,
            snippet: other.sentence.slice(0, 60),
            ...(other.sectionTitle ? { section_title: other.sectionTitle } : {}),
            section_role: other.sectionRole,
            category: 'internal_inconsistency',
            subtype: 'cross_section_endpoint_denominator_switch',
            severity: 'major',
            reason: `跨章节主要终点 ${first.endpointLabel} 率数值不一致：前文（${first.sectionTitle || '摘要/结果'}）报告为 ${first.pct}%${first.fraction ? ` (${first.fraction})` : ''}，而此处（${other.sectionTitle || '讨论'}）报告为 ${other.pct}% 且未注明分析人群分母切换（手术切除人群 vs. ITT 全入组人群）。`,
            suggestion: `建议在报告 ${other.pct}% 处明确标注对应分母（如 ITT 全入组人群 vs. 手术切除亚组），避免读者误判为前后数据矛盾。`,
          })
        }
      }
    }
  }

  // 7. 跨章节同一终点 HR 不一致核查
  for (const [, hrMentions] of endpointHrMentions) {
    if (hrMentions.length >= 2) {
      const firstHr = hrMentions[0]!
      for (const otherHr of hrMentions.slice(1)) {
        if (Math.abs(firstHr.hr - otherHr.hr) >= 0.005) {
          pushIfNotExempt({
            node_id: otherHr.nodeId,
            sentence: otherHr.sentence,
            snippet: otherHr.sentence.slice(0, 60),
            ...(otherHr.sectionTitle ? { section_title: otherHr.sectionTitle } : {}),
            section_role: otherHr.sectionRole,
            category: 'internal_inconsistency',
            subtype: 'cross_section_hr_mismatch',
            severity: 'major',
            reason: `跨章节 ${firstHr.endpointLabel} 风险比（HR）不一致：${firstHr.sectionTitle || '前文'}报告 HR = ${firstHr.hr}，而${otherHr.sectionTitle || '此处'}报告 HR = ${otherHr.hr}。`,
            suggestion: '请核对 Cox 回归模型输出与生存曲线图注，统一摘要与正文中的 HR 数值。',
          })
        }
      }
    }
  }

  // 7b. E3 跨章节/正文-表格同置信区间（或同比较项）下的点估计、P 值、WMD、aOR 及双臂百分比一致性核查
  interface CiAnchorEntry {
    ciKey: string
    est: number
    pval: number | null
    nodeId: string
    sentence: string
    snippet: string
    sectionTitle: string
    sectionRole: SectionRole
  }
  const ciAnchorMap = new Map<string, CiAnchorEntry[]>()
  const addCiEntry = (entry: CiAnchorEntry) => {
    const arr = ciAnchorMap.get(entry.ciKey) ?? []
    arr.push(entry)
    ciAnchorMap.set(entry.ciKey, arr)
  }

  const CI_KEYWORD_RE =
    /(?<![\d.])([−-]?\d+(?:\.\d+)?)\s*(?:%|times\s+more\s+likely(?:\s+to\s+develop\s+[a-z\s]+)?|[a-zA-Zµμ%/[\]-]+(?:\s+[a-zA-Zµμ%/[\]-]+){0,5})?\s*[,;([]\s*(?:[a-zA-Z]+\s*[=:]?\s*)?(?:95\s*%\s*)?(?:C[Il]|confidence\s+interval)\s*[:,=]?\s*[(\[]?\s*([−-]?\d+(?:\.\d+)?)\s*%?\s*(?:,|to|–|—|-(?=\s*[−-]?\d)|−(?=\s*\d))\s*([−-]?\d+(?:\.\d+)?)(?:\s*[a-zA-Zµμ%/[\]-]+)?(?:[^.?!\n]{0,25}?[;,)\]]\s*[pP]\s*[=:]\s*(0?\.\d+))?/g
  const PCT_RANGE_RE = /\b(\d+(?:\.\d+)?)%\s*\(\s*(\d+(?:\.\d+)?)\s*[–\-—]\s*(\d+(?:\.\d+)?)\s*\)/g

  for (const blk of blocks) {
    for (const m of blk.text.matchAll(CI_KEYWORD_RE)) {
      const rawText = m[0]
      if (/^95\s*%\s*C[Il]\b/i.test(rawText.trim())) continue
      const beforeCi = blk.text.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0)
      if (/(?:\bp(?:\s*-?\s*value)?\s*[=<>≤≥:]|\bn\s*=|\^)\s*$/i.test(beforeCi)) continue
      const est = Number(m[1]!.replace('−', '-'))
      const low = Number(m[2]!.replace('−', '-'))
      const high = Number(m[3]!.replace('−', '-'))
      const pval = m[4] ? Number(m[4]) : null
      if ([est, low, high].some(Number.isNaN)) continue
      const ciKey = `${low.toFixed(2)}|${high.toFixed(2)}`
      addCiEntry({
        ciKey,
        est,
        pval,
        nodeId: blk.nodeId,
        sentence: blk.text,
        snippet: rawText.slice(0, 80),
        sectionTitle: blk.sectionTitle,
        sectionRole: blk.sectionRole,
      })
    }
    for (const m of blk.text.matchAll(PCT_RANGE_RE)) {
      const est = Number(m[1])
      const low = Number(m[2])
      const high = Number(m[3])
      if ([est, low, high].some(Number.isNaN) || low < 10 || high > 100 || est < low || est > high) continue
      addCiEntry({
        ciKey: `${low.toFixed(2)}|${high.toFixed(2)}`,
        est,
        pval: null,
        nodeId: blk.nodeId,
        sentence: blk.text,
        snippet: m[0],
        sectionTitle: blk.sectionTitle,
        sectionRole: blk.sectionRole,
      })
    }
  }
  for (const tbl of resolvedTables) {
    const tblHasCiHeader = tbl.headers.some(h => /95\s*%|C[Il]|confidence/i.test(h))
    for (const row of tbl.rows) {
      const rowText = `| ${row.join(' | ')} |`
      for (const cell of row) {
        const m = /^([−-]?\d+(?:\.\d+)?)\s*\(\s*([−-]?\d+(?:\.\d+)?)\s*(?:,|to|–|—|-)\s*([−-]?\d+(?:\.\d+)?)\s*\)$/.exec(cell.trim())
        if (m) {
          const est = Number(m[1]!.replace('−', '-'))
          const low = Number(m[2]!.replace('−', '-'))
          const high = Number(m[3]!.replace('−', '-'))
          if (![est, low, high].some(Number.isNaN) && (m[2]!.includes('.') || m[3]!.includes('.') || tblHasCiHeader)) {
            addCiEntry({
              ciKey: `${low.toFixed(2)}|${high.toFixed(2)}`,
              est,
              pval: null,
              nodeId: tbl.node_id,
              sentence: rowText,
              snippet: cell.trim(),
              sectionTitle: tbl.section_title ?? 'Results',
              sectionRole: 'results',
            })
          }
        }
      }
    }
  }

  for (const [, entries] of ciAnchorMap) {
    if (entries.length < 2) continue
    const first = entries[0]!
    for (const other of entries.slice(1)) {
      if (other.nodeId === first.nodeId && other.sentence === first.sentence) continue
      const estDiff = Math.abs(first.est - other.est)
      const pDiff = first.pval != null && other.pval != null ? Math.abs(first.pval - other.pval) : 0
      if (estDiff >= 0.01 || pDiff >= 0.005) {
        pushIfNotExempt({
          node_id: first.nodeId,
          sentence: `${first.sentence} [vs. ${other.sentence}]`,
          snippet: first.snippet,
          ...(first.sectionTitle ? { section_title: first.sectionTitle } : {}),
          section_role: first.sectionRole,
          category: 'internal_inconsistency',
          subtype: 'cross_section_value_mismatch',
          severity: 'critical',
          reason: `跨章节同一置信区间（${first.ciKey.replace('|', '–')}）对应的统计量不一致：前文为「${first.snippet}」（${first.sentence}），而后文/表格为「${other.snippet}」（${other.sentence}）。`,
          suggestion: '请核对摘要、结果正文与表格中同一分析指标的点估计值与 P 值并保持前后一致。',
        })
        break
      }
    }
  }

  // E3: WMD 跨章节数值冲突（如摘要 WMD −1.58 cm vs 正文/表格 WMD −1.85 cm, 95% CI −2.29 to −1.41）
  const wmdMentions: Array<{ val: number; raw: string; nodeId: string; sentence: string; sectionTitle: string; sectionRole: SectionRole }> = []
  for (const blk of blocks) {
    for (const m of blk.text.matchAll(/\bWMD\s+([−-]?\d+\.\d+)\s*cm\b/g)) {
      const val = Number(m[1]!.replace('−', '-'))
      if (!Number.isNaN(val)) {
        wmdMentions.push({ val, raw: m[0], nodeId: blk.nodeId, sentence: blk.text, sectionTitle: blk.sectionTitle, sectionRole: blk.sectionRole })
      }
    }
  }
  if (wmdMentions.length >= 2) {
    const firstWmd = wmdMentions[0]!
    const refWmd = wmdMentions.slice(1).find(w => Math.abs(w.val - firstWmd.val) >= 0.05 && wmdMentions.filter(x => Math.abs(x.val - w.val) < 0.01).length >= 1)
    if (refWmd && wmdMentions.filter(x => Math.abs(x.val - firstWmd.val) < 0.01).length === 1) {
      pushIfNotExempt({
        node_id: firstWmd.nodeId,
        sentence: `${firstWmd.sentence} [vs. ${refWmd.sentence}]`,
        snippet: firstWmd.raw,
        ...(firstWmd.sectionTitle ? { section_title: firstWmd.sectionTitle } : {}),
        section_role: firstWmd.sectionRole,
        category: 'internal_inconsistency',
        subtype: 'cross_section_value_mismatch',
        severity: 'critical',
        reason: `跨章节合并加权均数差（WMD）不一致：摘要报告为「${firstWmd.raw}」（${firstWmd.sentence}），而结果正文及表格报告为「${refWmd.raw}」（${refWmd.sentence}）。`,
        suggestion: `请将摘要中的「${firstWmd.raw}」修正为与正文和表格一致的「${refWmd.raw}」。`,
      })
    }
  }

  // 8. 表格内部单元格算术与表头样本量/伪队列核查
  const table1Sizes = resolvedTables[0]?.sample_sizes ?? []
  for (const tbl of resolvedTables) {
    // 8a. 检查表头是否包含 clones = ... 与 Table 1 原始分组样本量不一致
    if (tbl.clone_sizes && tbl.clone_sizes.length > 0 && table1Sizes.length > 0) {
      const mismatchClones = tbl.clone_sizes.filter(c => !table1Sizes.includes(c))
      if (mismatchClones.length > 0) {
        const headerLine = tbl.headers.join(' | ')
        pushIfNotExempt({
          node_id: tbl.node_id,
          sentence: headerLine,
          snippet: tbl.headers[1] ?? headerLine.slice(0, 50),
          ...(tbl.headers[1] && tbl.grid_rows ? { cell: [tbl.grid_rows[0]!, 1] as [number, number] } : {}),
          ...(tbl.section_title ? { section_title: tbl.section_title } : {}),
          section_role: 'results',
          category: 'internal_inconsistency',
          subtype: 'table_clone_vs_enrolled_sample_size',
          severity: 'major',
          reason: `表格（${tbl.caption || tbl.node_id}）表头声明的分组人数（clones = ${tbl.clone_sizes.join(' vs ')}）与基线入组分组样本量（n = ${table1Sizes.join(' vs ')}）不一致。`,
          suggestion: '请核实表头分组样本量为何大于或不同于基线入组人数，或在表注中说明克隆加权伪队列计算口径。',
        })
      }
    }

    // 8b. 提取各列表头或首行子表头中的样本量（支持 `n = N`、`N births`、子表头 `(n=N)` 及表题/表内单一 `n = N`）
    const captionSingleN = (() => {
      if (tbl.caption) {
        const ms = [...tbl.caption.matchAll(/\b[nN]\s*[=＝]\s*(\d+)\b/g)]
        if (ms.length === 1) return Number(ms[0]![1])
      }
      if (tbl.sample_sizes.length === 1) return tbl.sample_sizes[0]!
      return null
    })()
    const colNs: Array<number | null> = tbl.headers.map((h, cIdx) => {
      const m = /\b[nN]\s*[=＝]\s*([\d,]+)\b/.exec(h) ?? /\b([\d,]+)\s+(?:births|patients|participants|cases|controls|subjects)\b/i.exec(h)
      if (m && m[1]) return Number(m[1].replace(/,/g, ''))
      for (const r of tbl.rows) {
        const subCell = (r[cIdx] ?? '').trim()
        const subM = /^\(\s*[nN]\s*[=＝]\s*([\d,]+)\s*\)$/.exec(subCell)
        if (subM && subM[1]) return Number(subM[1].replace(/,/g, ''))
      }
      return captionSingleN
    })

    // 每个「n (%)」格子反推的分母（n × 100 / %）：同一列别的行、或同一行别的列有格子反推出同一个分母时，
    // 说明这组百分比用的是另一个统一的分母（亚组人数、按行合计），不是算错——只有孤立的才报
    const parsedPct = tbl.rows.map(row => row.map(c => {
      const m = /^(\d+)\s*\(\s*(\d+(?:\.\d+)?)\s*[%％]?\s*\)$/.exec((c ?? '').trim())
      return m && Number(m[2]) > 0 ? { n: (Number(m[1]) * 100) / Number(m[2]), pct: Number(m[2]) } : null
    }))
    const sharedDenominator = (r: number, c: number, colN: number): boolean => {
      const n = parsedPct[r]?.[c]?.n
      if (n == null) return false
      const near = (x: { n: number } | null | undefined) => x != null && Math.abs(x.n - n) <= Math.max(1, n * 0.02)
      // 亚组：同一列别的行反推出同一个更小的分母
      if (n < colN && parsedPct.some((row, rr) => rr !== r && near(row[c]))) return true
      // 按行算的百分比：这一行的百分比加起来约 100，且各格反推的分母一致
      const rowCells = (parsedPct[r] ?? []).filter((x): x is { n: number; pct: number } => x != null)
      const rowSum = rowCells.reduce((s, x) => s + x.pct, 0)
      return rowCells.length >= 2 && Math.abs(rowSum - 100) <= 1.5 && rowCells.every(x => near(x))
    }

    let currentRowDenom: number | null = null
    for (const [rowIdx, row] of tbl.rows.entries()) {
      const nonEmptyLabel = row.find(c => c && c.trim() && !/^\^$/.test(c.trim())) ?? row[0] ?? ''
      const rowLabel = nonEmptyLabel
      const markdownRow = `| ${row.join(' | ')} |`
      const rowDenomM = /\bOut\s+of\s+(\d+)\s+patients\b/i.exec(row.join(' '))
      if (rowDenomM && rowDenomM[1]) {
        currentRowDenom = Number(rowDenomM[1])
      } else if (row[0] && row[0].trim() && row[0].trim() !== '^') {
        currentRowDenom = null
      }
      const gridRow = tbl.grid_rows?.[rowIdx + 1]

      // 8c. E7 表格内相邻三列「死亡/事件数 | 该组总数 | 百分比%」横向算术核查（如 | 16 | 24 | 76% |，16/24 = 66.7% != 76%）
      for (let c = 1; c + 2 < row.length; c++) {
        const cCount = (row[c] ?? '').trim()
        const cTot = (row[c + 1] ?? '').trim()
        const cPct = (row[c + 2] ?? '').trim()
        if (/^\d+$/.test(cCount) && /^\d+$/.test(cTot) && /^\d+(?:\.\d+)?%$/.test(cPct)) {
          const cnt = Number(cCount)
          const tot = Number(cTot)
          const rep = Number(cPct.replace('%', ''))
          if (tot > 0 && cnt <= tot) {
            const exp = (cnt / tot) * 100
            if (Math.abs(exp - rep) > 2.0) {
              pushIfNotExempt({
                node_id: tbl.node_id,
                sentence: `${markdownRow} [${tbl.headers.join(' | ')}]`,
                snippet: cPct,
                ...(gridRow != null ? { cell: [gridRow, c + 2] as [number, number] } : {}),
                ...(tbl.section_title ? { section_title: tbl.section_title } : {}),
                section_role: 'results',
                category: 'internal_inconsistency',
                subtype: 'table_cell_percentage_arithmetic_error',
                severity: 'minor',
                reason: `表格（${tbl.caption || tbl.node_id}）行「${markdownRow}」比率计算不一致：${cnt}/${tot} 应为 ${exp.toFixed(1)}%，而非 ${cPct}。`,
                suggestion: `请将该格百分比由 ${cPct} 修正为 ${Math.round(exp)}%。`,
              })
            }
          }
        }
      }

      // 8d. E7 表格行内各分组频数加总与 Total 列核查（如 94 (63.5) + 54 (72.0) = 148 != 139 (66.5)；13 + 9 = 22 != 23；75 + 6 = 81 != 83）
      const totalHeaderIndices = tbl.headers
        .map((h, idx) => (idx > 0 && /\bTotal\b/i.test(h) ? idx : -1))
        .filter(idx => idx >= 0)
      const totalColIdx =
        totalHeaderIndices.length === 1 && !row.some(c => /^\d+(?:\.\d+)?%$/.test((c ?? '').trim()))
          ? totalHeaderIndices[0]!
          : -1
      if (totalColIdx >= 0) {
        const extrCount = (s: string): number | null => {
          const m = /^(\d+)(?:\s*\(\s*\d+(?:\.\d+)?\s*%?\s*\))?$/.exec(s.trim())
          return m ? Number(m[1]) : null
        }
        const totalVal = extrCount(row[totalColIdx] ?? '')
        if (totalVal != null && totalVal > 0) {
          const partCols: number[] = []
          for (let c = 1; c < row.length; c++) {
            if (c === totalColIdx) continue
            const h = tbl.headers[c] ?? ''
            if (/(?:\b(?:p[-\s]*value|statistic|chi|test|OR|HR|RR|CI|%|rate)\b|[χΧ][2²]?|^\s*[tTzZfFpP]\s*$)/i.test(h)) continue
            const v = extrCount(row[c] ?? '')
            if (v != null) partCols.push(v)
          }
          if (partCols.length >= 2) {
            const sumParts = partCols.reduce((a, b) => a + b, 0)
            if (sumParts !== totalVal) {
              pushIfNotExempt({
                node_id: tbl.node_id,
                sentence: `${markdownRow} [${tbl.headers.join(' | ')}]`,
                snippet: (row[totalColIdx] ?? '').trim(),
                ...(gridRow != null ? { cell: [gridRow, totalColIdx] as [number, number] } : {}),
                ...(tbl.section_title ? { section_title: tbl.section_title } : {}),
                section_role: 'results',
                category: 'internal_inconsistency',
                subtype: 'table_row_sum_mismatch',
                severity: 'major',
                reason: `表格（${tbl.caption || tbl.node_id}）行「${markdownRow}」各分列频数之和（${partCols.join(' + ')} = ${sumParts}）与合计列（Total = ${totalVal}）不一致。`,
                suggestion: `请核对该行各组例数（${partCols.join(', ')}）与合计列（${totalVal}）之间的加总关系。`,
              })
            }
          }
        }
      }

      for (let colIdx = 1; colIdx < row.length; colIdx++) {
        const cell = (row[colIdx] ?? '').trim()
        if (!cell) continue
        const colHeader = tbl.headers[colIdx] ?? `Col ${colIdx}`
        const colN = currentRowDenom ?? colNs[colIdx] ?? null
        const at = gridRow != null ? { cell: [gridRow, colIdx] as [number, number] } : {}

        // 8e. 单元格内部构成加总核查：外层总数 N 与括号内二分亚组 (n1 + n2) 加总算术检验
        const inCellSumMatch = /\b(\d+)\s+(?:[A-Za-z]+\s+){0,4}?\(\s*(\d+)\s+[A-Za-z]+[\s,]+(\d+)\s+[A-Za-z\s]+\)/.exec(cell)
        if (inCellSumMatch) {
          const statedTot = Number(inCellSumMatch[1])
          const sub1 = Number(inCellSumMatch[2])
          const sub2 = Number(inCellSumMatch[3])
          if (sub1 + sub2 !== statedTot) {
            pushIfNotExempt({
              node_id: tbl.node_id,
              sentence: `${markdownRow} [${colHeader}]: ${cell}`,
              snippet: cell,
              ...at,
              ...(tbl.section_title ? { section_title: tbl.section_title } : {}),
              section_role: 'results',
              category: 'internal_inconsistency',
              subtype: 'table_row_sum_mismatch',
              severity: 'critical',
              reason: `表格（${tbl.caption || tbl.node_id}）单元格「${cell}」内部亚组人数之和（${sub1} + ${sub2} = ${sub1 + sub2}）与外层总数（${statedTot}）不一致（「${markdownRow}」）。`,
              suggestion: `请将单元格「${cell}」中的亚组人数或总人数修正使两者之和等于 ${statedTot}。`,
            })
          }
        }

        // 单元格里的「估计值 (下界–上界)」：表头或行名写了 CI / IQR / 95% 时按区间判断
        const ciContext = /\bCI\b|IQR|95\s*%|confidence|置信区间|四分位/i.test(`${colHeader} ${rowLabel} ${tbl.headers.join(' ')}`)
        for (const p of findCiProblems(cell, ciContext)) {
          pushIfNotExempt({
            node_id: tbl.node_id,
            sentence: `${markdownRow} [${colHeader}]: ${cell}`,
            snippet: cell,
            ...at,
            ...(tbl.section_title ? { section_title: tbl.section_title } : {}),
            section_role: 'results',
            category: 'internal_inconsistency',
            subtype: p.kind === 'outside' ? 'ci_estimate_outside_interval' : 'ci_bounds_inverted_or_missing_decimal',
            severity: 'major',
            reason: p.kind === 'outside'
              ? `表格（${tbl.caption || tbl.node_id}）行「${rowLabel}」列「${colHeader}」：点估计 ${p.estimate} 不在区间 ${p.low}–${p.high} 之内（「${p.text}」，${markdownRow}）。`
              : `表格（${tbl.caption || tbl.node_id}）行「${rowLabel}」列「${colHeader}」：区间下界 ${p.low} 大于上界 ${p.high}（「${p.text}」，${markdownRow}）。`,
            suggestion: '请核对该单元格的估计值与区间上下界。',
          })
        }

        // 检测 `00 (0.0%)` 双零排版笔误
        if (/\b00+\s*\(\s*0(?:\.0+)?%\s*\)|^00+\s*\(/.test(cell)) {
          pushIfNotExempt({
            node_id: tbl.node_id,
            sentence: `${rowLabel}: ${colHeader} = ${cell}`,
            snippet: cell,
            ...at,
            ...(tbl.section_title ? { section_title: tbl.section_title } : {}),
            section_role: 'results',
            category: 'internal_inconsistency',
            subtype: 'table_cell_formatting_typo',
            severity: 'minor',
            reason: `表格（${tbl.caption || tbl.node_id}）行「${rowLabel}」列「${colHeader}」存在多余前导零排版笔误：「${cell}」。`,
            suggestion: `请将单元格「${cell}」修正为「${cell.replace(/^00+/, '0')}」。`,
          })
        }

        // 检测频数与括号百分比：如 `21 (84)`（漏 % 号且 21/35=60% != 84%）或 `n (P%)` 算术不符
        if (colN && colN > 0) {
          const cellMatch = /^(\d+)\s*\(\s*(\d+(?:\.\d+)?)\s*([%％])?\s*\)$/.exec(cell)
          if (cellMatch && cellMatch[1] && cellMatch[2]) {
            const count = Number(cellMatch[1])
            const repPct = Number(cellMatch[2])
            const hasPctSign = Boolean(cellMatch[3])
            const hasDecimalPct = cellMatch[2].includes('.')
            // 仅当行标签不含 IQR/range/median 且 count <= colN 时按频数百分比验算
            const isMedianIqrRow = /\b(?:median|IQR|range|均值|中位数)\b/i.test(rowLabel)
            if (!isMedianIqrRow && count <= colN && !sharedDenominator(rowIdx, colIdx, colN)) {
              const expectedPct = (count / colN) * 100
              const pctDiff = Math.abs(expectedPct - repPct)
              const tol = hasDecimalPct ? 0.75 : 1.5
              if (pctDiff > tol) {
                pushIfNotExempt({
                  node_id: tbl.node_id,
                  sentence: `${markdownRow} [${colHeader}, n=${colN}]: ${cell}`,
                  snippet: cell,
                  ...at,
                  ...(tbl.section_title ? { section_title: tbl.section_title } : {}),
                  section_role: 'results',
                  category: 'internal_inconsistency',
                  subtype: 'table_cell_percentage_arithmetic_error',
                  severity: 'critical',
                  reason: `表格（${tbl.caption || tbl.node_id}）行「${rowLabel}」列「${colHeader} (n=${colN})」单元格「${cell}」` +
                    `百分比计算错误：${count}/${colN} 应为 ${expectedPct.toFixed(1)}%，而非 ${repPct}%${!hasPctSign ? '（且漏标 % 号）' : ''}（${markdownRow}）。`,
                  suggestion: `请将该单元格修正为「${count} (${expectedPct.toFixed(1).replace(/\.0$/, '')}%)」。`,
                })
              }
            }
          }
        }
      }
    }
  }

  return issues
}

/**
 * Stage 3 Pass C（方法-结果与影像/转化实验质控一致性核查）：
 * 检测「方法 (methods)」与「结果 (results)」章节之间的统计学检验/汇总指标不匹配（含 Mean±SD vs SEM 混用、缩写表定义冲突），
 * 以及医学影像层厚/随访重复性阈值（BTS 2015 ±25% / Lung-RADS ±1.5 mm）违背。
 */
export function auditMethodResultConsistency(
  doc: PMNode,
  tables: TableSummary[] = [],
  activeRules: string[] = [],
): DeepReviewAuditIssue[] {
  const issues: DeepReviewAuditIssue[] = []
  let currentSectionTitle = ''
  const roleTracker = new SectionRoleTracker()
  let currentSectionRole: SectionRole = 'other'
  const methodTexts: string[] = []
  const resultBlocks: Array<{ nodeId: string; text: string; sectionTitle: string; sectionRole: SectionRole }> = []
  const allBlocks: Array<{ nodeId: string; text: string; sectionTitle: string; sectionRole: SectionRole }> = []

  const visit = (node: PMNode, inTable: boolean) => {
    if (isPendingDeletion(node)) return
    if (node.type.name === 'code_block' || node.type.name === 'table') return
    if (node.type.name === 'figure') {
      const figCap = String(node.attrs?.caption ?? '').trim()
      if (figCap) {
        const nodeId = (node.attrs.id as string | null) ?? `fig_${allBlocks.length + 1}`
        allBlocks.push({ nodeId, text: figCap, sectionTitle: currentSectionTitle, sectionRole: currentSectionRole })
        if (currentSectionRole === 'methods') methodTexts.push(figCap)
        else if (currentSectionRole === 'results' || currentSectionRole === 'discussion') {
          resultBlocks.push({ nodeId, text: figCap, sectionTitle: currentSectionTitle, sectionRole: currentSectionRole })
        }
      }
      return
    }
    if (node.type.name === 'heading' && !inTable) {
      const hText = headingText(node)
      if (hText) {
        currentSectionTitle = hText
        currentSectionRole = roleTracker.onHeading(Number(node.attrs.level ?? 2), hText)
      }
      return
    }
    if (!node.isTextblock) {
      node.forEach(child => visit(child, inTable))
      return
    }
    const text = node.textContent.trim()
    if (!text) return
    const nodeId = (node.attrs.id as string | null) ?? 'p_unknown'
    allBlocks.push({ nodeId, text, sectionTitle: currentSectionTitle, sectionRole: currentSectionRole })
    if (currentSectionRole === 'methods') {
      methodTexts.push(text)
    } else if (currentSectionRole === 'results' || currentSectionRole === 'discussion') {
      resultBlocks.push({ nodeId, text, sectionTitle: currentSectionTitle, sectionRole: currentSectionRole })
    }
  }
  doc.forEach(child => visit(child, false))

  const pushIfNotExempt = (issue: DeepReviewAuditIssue) => {
    if (!isExemptedByActiveRules(issue, activeRules)) {
      issues.push(issue)
    }
  }

  const resolvedTables = tables.length > 0 ? tables : extractTableSummaries(doc)
  const allMethods = methodTexts.join(' ')
  const fullDocText = allBlocks.map(b => b.text).join(' ')
  const methodsBlocks = allBlocks.filter(b => b.sectionRole === 'methods')
  const methodsDeclareParametricOnly =
    /(?:均数\s*±\s*标准差|mean\s*±\s*(?:standard\s+deviation|SD)|mean\s*\(\s*SD\s*\)|Student'?s?\s*t[\s-]*test|独立样本\s*t\s*检验|\bF-test\b|\bANOVA\b)/i.test(allMethods) &&
    !/(?:中位数|四分位|median|IQR|interquartile|Mann[–\-—\s]Whitney|Wilcoxon|Kruskal[–\-—\s]Wallis|非参数|non-?parametric)/i.test(allMethods)
  const methodsDeclareNonParametricOnly =
    /(?:中位数|四分位|median\s*\(\s*(?:interquartile\s+range|IQR)|median\s*\[\s*IQR|Mann[–\-—\s]Whitney\s+U\s+test|Wilcoxon|Kruskal[–\-—\s]Wallis|Non-?parametric\s+analysis\s+was\s+applied)/i.test(allMethods) &&
    !/(?:均数\s*±\s*标准差|mean\s*±\s*(?:standard\s+deviation|SD)|mean\s*\(\s*SD\s*\)|Student'?s?\s*t[\s-]*test|independent[-\s]samples\s+t[\s-]*test|unpaired\s+(?:two-tailed\s+)?t[\s-]*test|\bANOVA\b)/i.test(allMethods)
  const methodsDeclareSdWithoutSem =
    /(?:均数\s*±\s*标准差|mean\s*±\s*SD)/i.test(allMethods) &&
    !/(?:标准误|\bSEM\b|standard\s+error)/i.test(allMethods)
  const methodsDeclareChiSquareOnly =
    /(?:卡方检验|χ2\s*检验|chi-square\s*test)/i.test(allMethods) &&
    !/Fisher/i.test(allMethods)
  const methodsDeclareThickSlice =
    /(?:层厚|slice\s*thickness)\s*[=:：为]?\s*(?:[3-9](?:\.\d+)?|[1-9]\d+)\s*mm/i.test(allMethods)

  for (const blk of resultBlocks) {
    // 1. 方法仅声明正态均数±SD与 t 检验/ANOVA，但结果报告偏态 Median [IQR] / Mann-Whitney / Kruskal-Wallis
    const nonParamResultM =
      /(?:median\s*(?:\(\s*interquartile\s+range|\(\s*IQR|\[?\s*IQR)|中位数\s*[（([]\s*四分位|Mann[–\-—\s]Whitney|Wilcoxon|Kruskal[–\-—\s]Wallis)/i.exec(
        blk.text,
      )
    if (methodsDeclareParametricOnly && nonParamResultM) {
      const mBlk = methodsBlocks.find(b => /(?:mean|SD|t[\s-]*test|F-test|ANOVA)/i.test(b.text))
      pushIfNotExempt({
        node_id: blk.nodeId,
        sentence: `${blk.text}${mBlk ? ` [Methods: ${mBlk.text}]` : ''}`,
        snippet: nonParamResultM[0],
        ...(blk.sectionTitle ? { section_title: blk.sectionTitle } : {}),
        section_role: blk.sectionRole,
        category: 'method_result_mismatch',
        subtype: 'parametric_method_vs_nonparametric_result',
        severity: 'major',
        reason: `统计方法章节仅声明正态参数方法（「${mBlk?.text ?? allMethods.slice(0, 120)}」），但结果/图注段报告了偏态指标 Median [IQR] / 非参数检验（「${blk.text}」），方法与结果不一致。`,
        suggestion: '请在统计方法章节补充非参数检验（如 Mann-Whitney U / Kruskal-Wallis 检验）与 Median (IQR) 汇总说明，或核实结果段的检验方法。',
      })
    }

    // 1b. E5 方法仅声明非参数检验（如 Mann-Whitney U test / Non-parametric analysis was applied / Median (IQR)），但结果段或图注却使用参数检验（t-test / ANOVA / mean ± SD）
    const paramResultM =
      /\b(?:independent[-\s]samples\s+t[\s-]*test|unpaired\s+(?:two-tailed\s+)?t[\s-]*test|Student'?s?\s*t[\s-]*test|one-way\s+ANOVA(?:\s+with\s+Tukey'?s\s+post\s+hoc\s+test)?)\b/i.exec(
        blk.text,
      )
    if (methodsDeclareNonParametricOnly && paramResultM) {
      const mBlk = methodsBlocks.find(b => /(?:Mann[–\-—\s]Whitney|Wilcoxon|Kruskal|median|interquartile|Non-?parametric)/i.test(b.text))
      pushIfNotExempt({
        node_id: blk.nodeId,
        sentence: `${blk.text}${mBlk ? ` [Methods: ${mBlk.text}]` : ''}`,
        snippet: paramResultM[0],
        ...(blk.sectionTitle ? { section_title: blk.sectionTitle } : {}),
        section_role: blk.sectionRole,
        category: 'method_result_mismatch',
        subtype: 'nonparametric_method_vs_parametric_result',
        severity: 'major',
        reason: `统计方法章节声明采用非参数检验（「${mBlk?.text ?? allMethods.slice(0, 120)}」），但结果/图注段却报告了参数检验「${paramResultM[0]}」（「${blk.text}」），方法与结果不一致。`,
        suggestion: '请将统计方法章节与结果/图注中的假设检验方法（非参数检验 vs. 参数检验 t-test/ANOVA）统一。',
      })
    }

    // 1c. E5 表题声明的相关系数类型（如 Spearman rank correlation vs Pearson）与方法章节矛盾
    const spearmanCaptionM = /\bSpearman(?:\s+rank)?\s+correlation(?:\s+coefficients?)?\b/i.exec(blk.text)
    if (
      spearmanCaptionM &&
      /\bPearson\b/i.test(allMethods) &&
      !/\bSpearman\b/i.test(allMethods)
    ) {
      const mBlk = methodsBlocks.find(b => /\bPearson\b/i.test(b.text))
      pushIfNotExempt({
        node_id: blk.nodeId,
        sentence: `${blk.text}${mBlk ? ` [Methods: ${mBlk.text}]` : ''}`,
        snippet: spearmanCaptionM[0],
        ...(blk.sectionTitle ? { section_title: blk.sectionTitle } : {}),
        section_role: blk.sectionRole,
        category: 'method_result_mismatch',
        subtype: 'correlation_method_mismatch',
        severity: 'minor',
        reason: `表题声明为「${spearmanCaptionM[0]}」（${blk.text}），但统计方法章节明确声明采用 Pearson 线性与偏相关分析（「${mBlk?.text ?? ''}」）。`,
        suggestion: '请将表题中的 Spearman 相关分析修正为 Pearson correlation，与统计方法章节保持一致。',
      })
    }

    // 2. 方法声明采用 Mean ± SD（标准差），但结果段却报告 Mean ± SEM（标准误）
    if (methodsDeclareSdWithoutSem && /(?:±\s*SEM\b|\bmean\b[^.。;；]{0,35}±\s*SEM\b)/i.test(blk.text)) {
      pushIfNotExempt({
        node_id: blk.nodeId,
        sentence: blk.text,
        snippet: blk.text.slice(0, 60),
        ...(blk.sectionTitle ? { section_title: blk.sectionTitle } : {}),
        section_role: blk.sectionRole,
        category: 'method_result_mismatch',
        subtype: 'sd_vs_sem_mismatch',
        severity: 'major',
        reason: '统计方法章节声明连续变量以「Mean ± SD（均数 ± 标准差）」表示，但结果段却使用「± SEM（标准误）」报告肿瘤体积/实验数据，混淆了总体离散度（SD）与抽样误差（SEM）。',
        suggestion: '请将结果段的汇总指标统一修正为 Mean ± SD，或在统计方法章节中明确区分体内动物实验与体外实验的 SD/SEM 报告规范。',
      })
    }

    // 3. 方法仅声明卡方检验，但结果对极小样本（n < 5）直接报告卡方 P 值而未用 Fisher 精确检验
    if (methodsDeclareChiSquareOnly && /\b[nN]\s*=\s*[1-4]\b|[1-4]\s*例\s*[（(]\s*\d+(?:\.\d+)?%/.test(blk.text) && /(?:χ2|chi-square|卡方)/i.test(blk.text)) {
      pushIfNotExempt({
        node_id: blk.nodeId,
        sentence: blk.text,
        snippet: blk.text.slice(0, 60),
        ...(blk.sectionTitle ? { section_title: blk.sectionTitle } : {}),
        section_role: blk.sectionRole,
        category: 'method_result_mismatch',
        subtype: 'small_cell_chisquare_without_fisher',
        severity: 'major',
        reason: '结果段存在频数 < 5 的稀疏分类单元格，但仍沿用普通皮尔逊卡方检验而未切换为 Fisher 精确检验。',
        suggestion: '当列联表理论期望频数或亚组例数 < 5 时，建议改用 Fisher 精确检验并在统计方法中声明。',
      })
    }

    // 4. 影像方法为厚层 CT（>2.5 mm），但结果声称完成精确三维亚体素体积倍增时间（VDT）或将 <1.5 mm 直径微变判为进展
    if (methodsDeclareThickSlice && /(?:体积倍增时间|VDT|mm³|mm3|三维体积)/i.test(blk.text)) {
      pushIfNotExempt({
        node_id: blk.nodeId,
        sentence: blk.text,
        snippet: blk.text.slice(0, 60),
        ...(blk.sectionTitle ? { section_title: blk.sectionTitle } : {}),
        section_role: blk.sectionRole,
        category: 'method_result_mismatch',
        subtype: 'thick_slice_ct_vdt',
        severity: 'critical',
        reason: '影像采集方法声明为厚层 CT（层厚 > 2.5 mm），但结果段报告了依赖薄层（≤ 1.25 mm）的三维结节体积与 VDT，存在显著部分容积效应偏倚。',
        suggestion: '厚层 CT 序列仅建议报告二维最大长径；若需三维体积与 VDT 评估，请核实是否基于 ≤ 1.25 mm 薄层重建序列。',
      })
    }
    if (/(?:增大|增长|进展|progression|grew|increased)\s*(?:了)?\s*(?:0\.\d+|1\.[0-4])\s*mm\b/i.test(blk.text) && !/(?:误差|稳定|stable|within\s+measurement)/i.test(blk.text)) {
      pushIfNotExempt({
        node_id: blk.nodeId,
        sentence: blk.text,
        snippet: blk.text.slice(0, 60),
        ...(blk.sectionTitle ? { section_title: blk.sectionTitle } : {}),
        section_role: blk.sectionRole,
        category: 'method_result_mismatch',
        subtype: 'subthreshold_lesion_growth_overclaim',
        severity: 'major',
        reason: '随访病灶直径变化幅度 < 1.5 mm（位于 Lung-RADS v2022 / BTS 2015 量测重复性误差带内），正文直接定性为实质性进展。',
        suggestion: '依据 Lung-RADS v2022 与 BTS 2015 指南，平均径变化 < 1.5 mm 且体积变化 < 25% 应归入量测误差范围并判定为稳定（Stable）。',
      })
    }
  }

  // 4b. E5 表格内的汇总格式（如 Mean ± SD vs Median (IQR)）与方法章节唯一声明的汇总格式矛盾核查
  const tableHasPlusMinus = resolvedTables.some(t =>
    t.rows.some(r => r.some(c => /\d+(?:\.\d+)?\s*±\s*\d+(?:\.\d+)?/.test(c))) ||
    t.headers.some(h => /mean\s*±\s*SD/i.test(h)),
  )
  const resultHasPlusMinus = resultBlocks.some(b => /\d+(?:\.\d+)?\s*±\s*\d+(?:\.\d+)?|\bmean\s+scores?\b/i.test(b.text))
  if (methodsDeclareNonParametricOnly && (tableHasPlusMinus || resultHasPlusMinus)) {
    const mBlk = methodsBlocks.find(b => /(?:median|interquartile|IQR|Mann[–\-—\s]Whitney)/i.test(b.text)) ?? methodsBlocks[0]
    const rBlk = resultBlocks.find(b => /\d+(?:\.\d+)?\s*±\s*\d+(?:\.\d+)?|\bmean\s+scores?\b/i.test(b.text))
    if (mBlk && !issues.some(i => i.subtype === 'nonparametric_method_vs_parametric_result')) {
      pushIfNotExempt({
        node_id: mBlk.nodeId,
        sentence: `${mBlk.text}${rBlk ? ` [Results: ${rBlk.text}]` : ''}`,
        snippet: mBlk.text.slice(0, 80),
        ...(mBlk.sectionTitle ? { section_title: mBlk.sectionTitle } : {}),
        section_role: mBlk.sectionRole,
        category: 'method_result_mismatch',
        subtype: 'nonparametric_method_vs_parametric_result',
        severity: 'major',
        reason: `统计方法章节声明连续变量以非参数中位数/四分位数表示（「${mBlk.text}」），但结果正文与基线/结局表格中实际报告了均数±标准差（Mean ± SD）及参数比较（「${rBlk?.text ?? 'Table Mean ± SD'}」）。`,
        suggestion: '请将统计方法章节的描述性统计声明与结果表格实际采用的汇总指标（Mean ± SD vs. Median [IQR]）统一。',
      })
    }
  }

  const tableHasMedianIqrRow = resolvedTables.some(t =>
    t.rows.some(r => r.some(c => /\bmedian\s*\(\s*IQR\s*\)|\bIQR\b|\d+\.\d+\s*\(\s*\d+\.\d+\s*[–\-—to,\s]+\s*\d+\.\d+\s*\)/i.test(c))),
  )
  const methodsOnlyTTestWithoutMannWhitney =
    /\bContinuous\s+variables\s+were\s+compared\s+using\s+the\s+independent[-\s]samples\s+t-test\./i.test(allMethods) &&
    !/\b(?:Mann[–\-—\s]Whitney|Wilcoxon|Kruskal[–\-—\s]Wallis)\b/i.test(allMethods)
  if (
    (methodsDeclareParametricOnly || methodsOnlyTTestWithoutMannWhitney) &&
    tableHasMedianIqrRow &&
    !issues.some(i => i.subtype === 'parametric_method_vs_nonparametric_result')
  ) {
    const mBlk =
      methodsBlocks.find(b => /(?:Continuous\s+variables\s+were\s+compared\s+using\s+the\s+independent|mean\s*±\s*(?:standard\s+deviation|SD)|Student)/i.test(b.text)) ??
      methodsBlocks[0]
    if (mBlk) {
      pushIfNotExempt({
        node_id: mBlk.nodeId,
        sentence: mBlk.text,
        snippet: mBlk.text.slice(0, 80),
        ...(mBlk.sectionTitle ? { section_title: mBlk.sectionTitle } : {}),
        section_role: mBlk.sectionRole,
        category: 'method_result_mismatch',
        subtype: 'parametric_method_vs_nonparametric_result',
        severity: 'major',
        reason: `统计方法章节仅声明参数 t 检验（「${mBlk.text}」），但基线/结果表格中包含偏态分布变量「median (IQR)」，未声明对应的非参数 Mann-Whitney U 检验。`,
        suggestion: '请在统计方法章节中补充偏态变量采用 Mann-Whitney U 检验（或非参数检验）的说明。',
      })
    }
  }

  // 5. 全文核心缩写定义冲突检查（正文用法/括号展开与缩略语表/表注 `\b([A-Z]{2,6})\s*:\s*([^;,.\n)]+)` 定义矛盾）
  const establishedAcronyms = new Map<string, string>()
  if (/\b(?:radiotherapy|radiation\s+therapy|irradiation)\b/i.test(fullDocText) && /\b(?:RT|\d+\s*Gy)\b/i.test(fullDocText)) {
    establishedAcronyms.set('RT', 'Radiotherapy')
  }
  for (const m of fullDocText.matchAll(/\b([A-Za-z][A-Za-z\s-]{4,45}?)\s*\(\s*([A-Z]{2,6})\s*\)/g)) {
    const rawExp = m[1]!.trim()
    const abbr = m[2]!.trim()
    const words = rawExp.split(/\s+/).slice(-Math.min(abbr.length + 1, 5))
    const candidateExp = words.join(' ').trim()
    if (
      candidateExp.length >= 5 &&
      !/\b(?:table|figure|group|cohort|study|trial|model|method|analysis|test)\b/i.test(candidateExp) &&
      candidateExp[0]!.toUpperCase() === abbr[0]
    ) {
      if (!establishedAcronyms.has(abbr)) {
        establishedAcronyms.set(abbr, candidateExp)
      }
    }
  }

  for (const blk of allBlocks) {
    const isAbbrContext = /abbreviations?|缩略语|缩写|note|脚注|表注/i.test(`${blk.sectionTitle} ${blk.text}`)
    if (!isAbbrContext) continue
    for (const m of blk.text.matchAll(/\b([A-Z]{2,6})\s*[:：]\s*([^;,.\n)]+)/g)) {
      const abbr = m[1]!.trim()
      const definedExp = m[2]!.trim()
      if (!definedExp || /^\d/.test(definedExp)) continue
      const proseExp = establishedAcronyms.get(abbr)
      if (!proseExp) continue
      const proseStems = (proseExp.toLowerCase().match(/[a-z]{4,}/g) ?? []).map(w => w.slice(0, 4))
      const defLower = definedExp.toLowerCase()
      const hasOverlap = proseStems.length === 0 || proseStems.some(st => defLower.includes(st))
      if (!hasOverlap) {
        const snippet = `${abbr}: ${definedExp}`
        pushIfNotExempt({
          node_id: blk.nodeId,
          sentence: blk.text,
          snippet,
          ...(blk.sectionTitle ? { section_title: blk.sectionTitle } : {}),
          section_role: blk.sectionRole,
          category: 'method_result_mismatch',
          subtype: 'abbreviation_definition_conflict',
          severity: 'minor',
          reason: `缩略语表（Abbreviations）将全文核心术语「${abbr}」定义为「${definedExp}」，但正文中「${abbr}」实际指代「${proseExp}」。`,
          suggestion: `请将 Abbreviations 中的「${snippet}」修正为「${abbr}: ${proseExp}」。`,
        })
      }
    }
  }

  return issues
}

/**
 * Stage 3 Pass D（结论夸大 Spin Bias 与 CONSORT/STROBE 报告规范核查）：
 * 1. P >= 0.05 无统计学意义却使用强阳性获益/改善措辞（Spin Bias）；
 * 2. 非随机观察性/回顾性研究在结果或讨论中使用强因果动词（STROBE 因果越界）。
 */
export function auditSpinAndGuidelines(doc: PMNode, activeRules: string[] = []): DeepReviewAuditIssue[] {
  const issues: DeepReviewAuditIssue[] = []
  let currentSectionTitle = ''
  const roleTracker = new SectionRoleTracker()
  let currentSectionRole: SectionRole = 'other'
  let fullDocText = ''
  const blocks: Array<{ nodeId: string; text: string; sectionTitle: string; sectionRole: SectionRole; sents: string[] }> = []

  const visit = (node: PMNode, inTable: boolean) => {
    if (isPendingDeletion(node)) return
    if (node.type.name === 'figure' || node.type.name === 'code_block' || node.type.name === 'table') return
    if (node.type.name === 'heading' && !inTable) {
      const hText = headingText(node)
      if (hText) {
        currentSectionTitle = hText
        currentSectionRole = roleTracker.onHeading(Number(node.attrs.level ?? 2), hText)
      }
      return
    }
    if (!node.isTextblock) {
      node.forEach(child => visit(child, inTable))
      return
    }
    const text = node.textContent.trim()
    if (!text) return
    fullDocText += ` ${text}`
    const nodeId = (node.attrs.id as string | null) ?? 'p_unknown'
    blocks.push({ nodeId, text, sectionTitle: currentSectionTitle, sectionRole: currentSectionRole, sents: sentenceTexts(node) })
  }
  doc.forEach(child => visit(child, false))

  const tableRowTexts: Array<{ text: string }> = []
  for (const tbl of extractTableSummaries(doc)) {
    for (const r of tbl.rows) {
      const rowStr = `| ${r.join(' | ')} |`
      fullDocText += ` ${rowStr}`
      tableRowTexts.push({ text: rowStr })
    }
  }

  const pushIfNotExempt = (issue: DeepReviewAuditIssue) => {
    if (!isExemptedByActiveRules(issue, activeRules)) {
      issues.push(issue)
    }
  }

  const isObservationalCohort =
    /(?:回顾性|观察性|横断面|病例对照|\b(?:retrospective|observational|cross-sectional|case-control|real-world\s+cohort)\b)/i.test(fullDocText) &&
    !/(?:随机对照|双盲|\b(?:randomized\s+controlled|double-blind\s+RCT)\b)/i.test(fullDocText)

  for (const blk of blocks) {
    if (blk.sectionRole !== 'results' && blk.sectionRole !== 'discussion' && blk.sectionRole !== 'other') continue

    // 1. P >= 0.05 时的同句 Spin Bias 通用检测（不含任何特定研究名词或硬编码 P 值）
    const pMatches = [...blk.text.matchAll(/\b[Pp]\s*[=＝]\s*(0?\.\d+)/g)]
    const hasNonSigP =
      pMatches.some(m => {
        const v = Number(m[1])
        return !Number.isNaN(v) && v >= 0.05 && v < 1
      }) || /\b[Pp]\s*[>＞]\s*0?\.05\b/.test(blk.text)

    const hasNegation =
      /(?:未达|未见|无显著|没有显著|\b(?:not|no|neither|without|failed\s+to|did\s+not)\b)/i.test(blk.text)

    const hasPositiveSpin =
      /(?:显著(?:改善|降低|延长|获益|优于)|明显(?:改善|获益|优于)|证实了.*显著疗效|\bdemonstrated\s+(?:clear|significant|substantial)\s+(?:clinical\s+)?benefit\b|\bconfirmed\s+superiority\b|\bproved\s+efficacy\b|\b(?:increased|decreased|improved|reduced)\s+significantly\b|\bsignificantly\s+(?:reduced|increased|improved|prolonged)\b)/i.test(
        blk.text,
      )
    if (hasNonSigP && hasPositiveSpin && !hasNegation) {
      pushIfNotExempt({
        node_id: blk.nodeId,
        sentence: blk.text,
        snippet: blk.text.slice(0, 80),
        ...(blk.sectionTitle ? { section_title: blk.sectionTitle } : {}),
        section_role: blk.sectionRole,
        category: 'spin_or_guideline',
        subtype: 'nonsignificant_p_positive_spin',
        severity: 'critical',
        reason: `统计检验 P ≥ 0.05 未达统计学显著性阈值，但正文使用了阳性显著获益/差异表述（Spin Bias）：「${blk.text}」。`,
        suggestion: '请客观陈述差异未达统计学意义（no statistically significant difference），避免将无显著性趋势夸大为显著性结论。',
      })
    }

    // 2. 观察性/非随机研究强因果措辞越界通用检测（STROBE 规范，纯语法结构匹配，零特定疾病/暴露硬编码）
    const causalOverclaimM =
      /(?:直接导致|证明了.*因果|证实.*可避免死亡|\bdirectly\s+(?:caused|causes|drove|drives)\b|\bproved\s+a\s+causal\s+(?:effect|relationship|link)\b|\bcausally\s+(?:prevented|prevents|induced|induces|reduced|reduces)\b|\b(?:confirms?|demonstrat(?:ed|ing)|proves?)\s+that\s+[^,.;()]{3,55}?\s+(?:directly\s+)?(?:causes?|caused|causally\s+\w+|prevents?|prevented)\b)/i.exec(
        blk.text,
      )
    const hasCausalHedge = /\b(?:cannot|can\s+not|does\s+not|do\s+not|did\s+not|may|might|whether|not\s+confirm)\b/i.test(
      blk.text,
    )
    if (causalOverclaimM && !hasCausalHedge && isObservationalCohort) {
      pushIfNotExempt({
        node_id: blk.nodeId,
        sentence: blk.text,
        snippet: causalOverclaimM[0],
        ...(blk.sectionTitle ? { section_title: blk.sectionTitle } : {}),
        section_role: blk.sectionRole,
        category: 'spin_or_guideline',
        subtype: 'observational_causal_overclaim',
        severity: 'major',
        reason: `观察性研究正文中直接使用了强因果定性措辞「${causalOverclaimM[0]}」（${blk.text}），超出非随机观察性设计证据支持范围（违反 STROBE 结论规范）。`,
        suggestion: '建议改为相关性或关联性客观表述（如“was associated with / correlated with”），并与局限性章节说明保持一致。',
      })
    }
  }
  return issues
}
