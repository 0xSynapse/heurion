import type { TableSummary } from './extract.ts'

/**
 * 逐表判断表格结构是否可信（用于由版面推断出来的表格，即 PDF 经 Docling 导入的稿件）。
 * 只看表格本身，不依赖原文；判为不可信的表不参与依赖表格的数值核查，也不交给模型，并提示用户。
 *
 * 信号来自导入质量评测（docs/design/IMPORT_EVAL.md）里对不上的表：
 * - 首行大半是数字：表头丢失，或横排 / 转置的表被识别反了方向；
 * - 一格里挤着几个数字（「12 0」「100 0」）：几行被识别成了一行；
 * - 表注（Abbreviations: / Note:）混进单元格：表格边界识别错了；
 * - 数值格前面粘着行标签文字（「and 2 26 (86.7%)」）：跨行的行标签被拆进了数值列；
 * - 只有一行或一列：把图题等误认成了表格。
 * 规则在 19 篇评测论文（76 张表）上没有误判可信的表。
 * 只依据文字的表（研究特征表等）即便拆分不准，也不影响数值核查，不在此判断范围内。
 */

export interface TableTrust {
  reliable: boolean
  /** 不可信的原因（中文，给用户看） */
  reasons: string[]
}

const NUM = String.raw`[<>≤≥]?\s*[-−–]?\d+(?:[.,·]\d+)?%?`
/** 整格只有两个以上用空白隔开的数字 */
const STACKED = new RegExp(String.raw`^${NUM}(?:\s+${NUM})+$`)
/** 以数字开头的格子（含「(1.2–3.4)」「<0.001」「-0.5」） */
const LEADING_NUMBER = /^[<>≤≥([]?\s*[-−–]?\d/
const TABLE_NOTE = /^(?:abbreviations?|notes?)\s*[:.：]/i
/** 数值格前面粘着行标签文字：「and 2 26 (86.7%)」「G3 and 4 4 (13.3%)」 */
const GLUED_LABEL = /^\p{L}[^()]*?\s[<>≤≥]?\d+(?:\.\d+)?\s*\(\s*[-−–]?\d+(?:\.\d+)?\s*%?\s*\)\s*\*?$/u

export function assessTableTrust(t: Pick<TableSummary, 'headers' | 'rows'>): TableTrust {
  const reasons: string[] = []

  // 只有一行或一列：多半是把图题、页面文字误认成了表格
  if (t.headers.length < 2 || t.rows.length === 0) {
    return { reliable: false, reasons: ['只识别出一行或一列，可能不是表格'] }
  }

  // 首行（第一列是行标签，不算）
  const head = t.headers.slice(1).map(c => c.trim()).filter(Boolean)
  if (head.length >= 2 && head.filter(c => LEADING_NUMBER.test(c)).length / head.length >= 0.5) {
    reasons.push('首行大部分是数字，表头可能丢失或表格方向识别错误')
  }

  const body = t.rows.flatMap(r => r.slice(1)).map(c => c.trim()).filter(c => /\d/.test(c))
  const stacked = body.filter(c => STACKED.test(c)).length
  if (stacked >= 2 || (stacked >= 1 && stacked / body.length >= 0.1)) {
    reasons.push(`有 ${stacked} 个单元格挤着多个数字，可能多行被识别成了一行`)
  }

  const glued = body.filter(c => GLUED_LABEL.test(c)).length
  if (glued >= 2 || (glued >= 1 && glued / body.length >= 0.1)) {
    reasons.push(`有 ${glued} 个数值单元格混进了行标签文字，行标签与数值可能错位`)
  }

  if ([t.headers, ...t.rows].some(r => r.some(c => TABLE_NOTE.test(c.trim())))) {
    reasons.push('表注混进了单元格，表格边界可能识别错误')
  }

  return { reliable: reasons.length === 0, reasons }
}
