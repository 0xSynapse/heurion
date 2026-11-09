import type { InlineImage, VisionComplete } from '../harness/complete.ts'
import { summaryFromRows, type TableSummary } from './extract.ts'
import { assessTableTrust } from './table-trust.ts'

/**
 * 审稿时按页面图像核对表格（docs/design/PDF_ORIGINAL_VIEW.md §12.3）。
 *
 * PDF 经 Docling 导入的表格是从版面推断的，行列可能错位。审稿前把表格区域的截图交给图像模型逐格抄一遍：
 * - 抄出的数字必须都在 PDF 文字层里（防止模型认错数字后，核查据此报出不存在的计算错误）；
 * - 与转换结果一致：表格可信，照常核查；
 * - 不一致：核查改用抄出的表格（意见锚在整张表，原版上按单元格文字定位）；
 * - 图像不可用、调用失败、抄出的数字对不上文字层：退回按文字规则判断可信度。
 */

/** 一张表的核对原料：表格区域的截图（续表几页就几张）与区域内文字层的词 */
export interface TableSource { images: InlineImage[]; words: string[] }

export interface TableVision {
  source: (nodeId: string) => Promise<TableSource | null>
  complete: VisionComplete
  /** 每次审稿最多核对几张表（默认 8） */
  max?: number
}

export interface VisionTableResult {
  tables: TableSummary[]
  /** 按文字规则判为不可信、又没能按图像核对的表（说明文字） */
  skipped: string[]
  /** 改用图像识别结果参加核查的表（说明文字） */
  reread: string[]
  /** 按图像核对后确认一致的表数 */
  verified: number
}

const SYSTEM =
  '你是表格转录员。把图片里的表格逐格抄成 JSON，只输出 JSON：{"header_rows": <表头行数>, "rows": [["格", "格", …], …]}。' +
  '规则：逐字照抄（数字、符号、上下标、括号、正负号原样保留，上标写成 ^x），不翻译、不计算、不补全、不改正；' +
  '每一行的格数相同；合并单元格的文字只写在左上那一格，被它覆盖的格写空字符串；' +
  '表题、表注、脚注不算表格，不要抄；有几张图时它们是同一张表的连续几页，按顺序接起来，续页重复的表头只保留一次。'

/** 解析模型输出的网格；格式不对返回 null */
export function parseGrid(raw: string): { rows: string[][]; headerRows: number } | null {
  const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, ''))
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as { rows?: unknown; header_rows?: unknown }
    if (!Array.isArray(j.rows) || !j.rows.length) return null
    const rows = j.rows
      .filter((r): r is unknown[] => Array.isArray(r))
      .map(r => r.map(c => (c == null ? '' : String(c)).replace(/\s+/g, ' ').trim()))
      .filter(r => r.some(Boolean))
    if (rows.length < 2 || Math.max(...rows.map(r => r.length)) < 2) return null
    const headerRows = Math.max(0, Math.min(Number(j.header_rows) || 1, rows.length - 1))
    return { rows, headerRows }
  } catch {
    return null
  }
}

const NUM = /\d+(?:[.,·]\d+)*/g
const normNum = (s: string) => s.replace(/[,·]/g, '.')

/** 抄出的数字有多少在文字层里出现过（按出现次数，统一千分位与小数点写法） */
export function numbersFaithful(grid: string[][], words: string[]): number {
  const pool = new Map<string, number>()
  for (const t of words.join(' ').match(NUM) ?? []) pool.set(normNum(t), (pool.get(normNum(t)) ?? 0) + 1)
  const want = grid.flat().join(' ').match(NUM) ?? []
  if (!want.length) return 1
  let hit = 0
  for (const t of want) {
    const k = normNum(t)
    const n = pool.get(k) ?? 0
    if (n > 0) { hit++; pool.set(k, n - 1) }
  }
  return hit / want.length
}

const normCell = (s: string) => s.normalize('NFKC').replace(/\^/g, '').replace(/[‐-―−]/g, '-').replace(/\s+/g, '').toLowerCase()

/** 两份网格的表体（表头以下）是否一致：行列数相同、九成五以上的非空格逐格相同（表头的合并单元格写法不同，不比） */
export function gridsAgree(a: string[][], b: string[][], headerRows = 1): boolean {
  const width = (g: string[][]) => Math.max(0, ...g.map(r => r.length))
  if (a.length !== b.length || width(a) !== width(b)) return false
  let total = 0
  let same = 0
  for (let r = headerRows; r < a.length; r++) {
    for (let c = 0; c < width(a); c++) {
      const x = normCell(a[r]![c] ?? '')
      const y = normCell(b[r]![c] ?? '')
      if (!x && !y) continue
      total++
      if (x === y) same++
    }
  }
  return total === 0 || same / total >= 0.95
}

/** 一张表的称呼：表题开头，否则序号 */
function label(t: TableSummary, i: number): string {
  const cap = (t.caption ?? '').trim()
  return cap ? (cap.length > 40 ? `${cap.slice(0, 40)}…` : cap) : `第 ${i + 1} 张表`
}

/**
 * 逐表判断可信度，能按图像核对的先核对。按文字规则不可信的表优先占用核对名额。
 * vision 为空时只按文字规则（与原来的做法相同）。
 */
export async function assessTablesWithVision(tables: TableSummary[], vision?: TableVision | null): Promise<VisionTableResult> {
  const trust = tables.map(t => assessTableTrust(t))
  const read = new Map<number, { rows: string[][]; headerRows: number }>()
  if (vision) {
    const order = tables.map((_, i) => i).sort((x, y) => Number(trust[x]!.reliable) - Number(trust[y]!.reliable))
    for (const i of order.slice(0, vision.max ?? 8)) {
      try {
        const src = await vision.source(tables[i]!.node_id)
        if (!src?.images.length) continue
        const cap = tables[i]!.caption ? `表题：${tables[i]!.caption}\n` : ''
        const parsed = parseGrid(await vision.complete(SYSTEM, `${cap}请抄出这张表。`, src.images))
        // 抄出的数字对不上文字层：不用（宁可退回原来的做法，也不让认错的数字进核查）
        if (parsed && numbersFaithful(parsed.rows, src.words) >= 0.98) read.set(i, parsed)
      } catch {
        /* 图像核对失败：这张表按文字规则判断 */
      }
    }
  }
  const out: VisionTableResult = { tables: [], skipped: [], reread: [], verified: 0 }
  tables.forEach((t, i) => {
    const v = read.get(i)
    if (v) {
      if (gridsAgree([t.headers, ...t.rows], v.rows, Math.max(1, v.headerRows))) {
        out.verified++
        out.tables.push(t)
      } else {
        out.reread.push(label(t, i))
        out.tables.push(summaryFromRows(t, v.rows))
      }
      return
    }
    if (trust[i]!.reliable) out.tables.push(t)
    else out.skipped.push(`${label(t, i)}（${trust[i]!.reasons[0]}）`)
  })
  return out
}

export function rereadTablesWarning(reread: string[]): string {
  return `${reread.length} 张表格的转换结果与 PDF 页面不一致，本次审稿按页面图像重新识别的表格核查：${reread.join('；')}。这些表格上的意见在原版 PDF 上按单元格文字定位。`
}
