import type { Node as PMNode } from 'prosemirror-model'
import { DOI as DOI_PATTERN } from '../ops/citation-check.ts'

/**
 * 参考文献编号与正文末尾文献表的合并（docx 导出、网页预览、markdown 导出、编辑器、MCP 与论断核对共用）。
 *
 * 导入的文稿常在末尾自带一份参考文献表（[1]…[k]，正文里写的是纯文字「[1]」）。这份表是用户文档的内容，一律原样保留：
 * - 平台引用（insert_citation）若与表中某条是同一篇（DOI 相同或文本相同），沿用那条的编号，不重复列出；
 * - 其余平台引用接在表后编号：[k+1]、[k+2]……，不另起一份文献表。
 * 平台导出的文件下载后再上传时，平台引用已变成纯文字「[n]」、文献表也成了文档内容，同样走上面的规则，不会越积越多。
 */

/** 文献表标题：「参考文献」「参考资料」「附-参考资料：」「References」「五、参考文献：」等。 */
export const REF_TITLE = /^(?:(?:附[-—:：\s]*)|(?:[一二三四五六七八九十\d]+[.、\s]*))?(?:参考文献|参考资料|引用文献|references|bibliography)[:：]?$/i
/** 文献表条目：「[12] 作者. 标题…」，也认 GB/T 7714 常见的「[12]作者」（括号后不空格）、全角括号「［12］」与实心方头括号「【12】」。 */
const REF_ENTRY = /^[[［【](\d+)[\]］】]\s*(\S[\s\S]*)$/
/** 带文献表标题时也认「1、…」「1. …」纯数字序号段落。 */
const PLAIN_REF_ENTRY = /^(\d+)[.、．]\s*(\S[\s\S]*)$/
const DOI = new RegExp(DOI_PATTERN.source, 'gi')

export interface CitationLike { id: string; doi: string; formatted: string }

export interface ReferencePlan {
  /** 正文里每个平台引用的编号。 */
  numbers: Map<string, number>
  /** 与表中已有条目是同一篇、沿用其编号的平台引用（正文里用到的）。 */
  fixed: Map<string, number>
  /** 需要追加到文献表的平台引用（按编号排序）。 */
  append: Array<{ id: string; n: number }>
  /** 正文保留到哪个顶层块（不含）；之后只是空行或（没有条目时的）段落式标题。 */
  bodyEnd: number
  /** 末尾已有可复用的「参考文献」标题块（heading），追加时不再另起标题。 */
  hasHeading: boolean
  /** 末尾已有文献表的条目数（取最大编号）；平台引用从它之后编号。正文里还没有平台引用时也照常给出（编辑器据此编号）。 */
  userCount: number
  /** 正文里用到的平台引用中，沿用已有条目编号的个数。 */
  duplicates: number
}

/** 把正文里引用的出现顺序换成编号：fixed 里的沿用给定编号，其余从 offset + 1 起依次编号。编辑器也用它。 */
export function numberCitations(order: readonly string[], offset: number, fixed: ReadonlyMap<string, number> | Record<string, number>): Map<string, number> {
  const get = (id: string) => fixed instanceof Map ? fixed.get(id) : (fixed as Record<string, number>)[id]
  const out = new Map<string, number>()
  let next = offset
  for (const id of order) {
    const f = get(id)
    out.set(id, f ?? ++next)
  }
  return out
}

/** 正文里平台引用的首次出现顺序。 */
export function citationOrderOf(doc: PMNode): string[] {
  const order: string[] = []
  doc.descendants(n => {
    if (n.type.name === 'citation' && !order.includes(n.attrs.cite_id as string)) order.push(n.attrs.cite_id as string)
  })
  return order
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
const doisIn = (text: string) => [...text.matchAll(DOI)].map(m => m[0].replace(/[.,;]+$/, '').toLowerCase())

export function referencePlan(doc: PMNode, citations: readonly CitationLike[]): ReferencePlan {
  const byId = new Map(citations.map(c => [c.id, c]))
  const order = citationOrderOf(doc).filter(id => byId.has(id))

  // 从末尾往前：空行 → 文献表条目（全部当作文档内容保留）→「参考文献」标题
  const entryAt = (i: number) => {
    const node = doc.child(i)
    if (node.type.name !== 'paragraph') return null
    const m = REF_ENTRY.exec(node.textContent.trim())
    return m ? { idx: i, n: Number(m[1]), text: m[2]! } : null
  }
  const isBlank = (i: number) => { const n = doc.child(i); return n.type.name === 'paragraph' && n.textContent.trim() === '' && n.childCount === 0 }
  let i = doc.childCount - 1
  while (i >= 0 && isBlank(i)) i--
  const entries: Array<{ idx: number; n: number; text: string }> = []
  for (let e = i >= 0 ? entryAt(i) : null; e; e = i >= 0 ? entryAt(i) : null) { entries.unshift(e); i--; while (i >= 0 && isBlank(i)) i-- }
  if (entries.length === 0 && i >= 0) {
    // 若末尾是「1、…」「1. …」格式的段落，且上方紧邻「参考文献 / 附-参考资料」标题，也视为已有文献表
    let scan = i
    const plainEntries: Array<{ idx: number; n: number; text: string }> = []
    while (scan >= 0) {
      const node = doc.child(scan)
      const m = node.type.name === 'paragraph' ? PLAIN_REF_ENTRY.exec(node.textContent.trim()) : null
      if (!m) break
      plainEntries.unshift({ idx: scan, n: Number(m[1]), text: m[2]! })
      scan--
      while (scan >= 0 && isBlank(scan)) scan--
    }
    if (plainEntries.length > 0 && scan >= 0 && (doc.child(scan).type.name === 'heading' || doc.child(scan).type.name === 'paragraph') && REF_TITLE.test(doc.child(scan).textContent.trim())) {
      entries.push(...plainEntries)
      i = scan
    }
  }
  if (i >= 0 && doc.child(i).type.name === 'ordered_list') {
    let prev = i - 1
    while (prev >= 0 && isBlank(prev)) prev--
    if (prev >= 0 && (doc.child(prev).type.name === 'heading' || doc.child(prev).type.name === 'paragraph') && REF_TITLE.test(doc.child(prev).textContent.trim())) {
      const listNode = doc.child(i)
      const start = Math.max(1, Number(listNode.attrs.start ?? 1))
      const listEntries: Array<{ idx: number; n: number; text: string }> = []
      listNode.forEach((item, _off, k) => {
        listEntries.push({ idx: i, n: start + k, text: item.textContent.trim() })
      })
      entries.unshift(...listEntries)
      i = prev
    }
  }
  const titleIdx = i >= 0 && (doc.child(i).type.name === 'heading' || doc.child(i).type.name === 'paragraph') && REF_TITLE.test(doc.child(i).textContent.trim()) ? i : -1

  // 正文里用到的平台引用若与表中某条是同一篇（DOI 或文本相同），沿用那条的编号
  const fixed = new Map<string, number>()
  for (const id of order) {
    const c = byId.get(id)!
    const doi = c.doi.toLowerCase()
    const hit = entries.find(e => (doi.startsWith('10.') && doisIn(e.text).includes(doi)) || norm(e.text) === norm(c.formatted))
    if (hit) fixed.set(id, hit.n)
  }
  const userCount = entries.reduce((m, e) => Math.max(m, e.n), 0)
  const numbers = numberCitations(order, userCount, fixed)
  const append = order.filter(id => !fixed.has(id)).map(id => ({ id, n: numbers.get(id)! }))

  // 只有要追加时才裁掉末尾的空行 / 段落式标题（追加的条目接在最后一条或标题后面）
  let bodyEnd = doc.childCount
  let hasHeading = false
  if (append.length > 0) {
    if (entries.length > 0) bodyEnd = entries[entries.length - 1]!.idx + 1
    else if (titleIdx !== -1) {
      hasHeading = doc.child(titleIdx).type.name === 'heading'
      bodyEnd = hasHeading ? titleIdx + 1 : titleIdx
    }
  }
  return { numbers, fixed, append, bodyEnd, hasHeading, userCount, duplicates: fixed.size }
}
