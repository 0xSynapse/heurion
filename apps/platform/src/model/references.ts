import type { Node as PMNode } from 'prosemirror-model'

/**
 * 参考文献编号与正文末尾文献表的合并（docx 导出、网页预览、markdown 导出、编辑器与 MCP 共用）。
 *
 * 导入的文稿常在末尾自带一份手写的参考文献表（[1]…[k]，正文里写的是纯文字「[1]」）。
 * 平台引用（insert_citation）不另起一份文献表，而是接在用户的表后面编号：[k+1]、[k+2]……
 * 用户表里某条若带着某个平台引用的 DOI，该引用直接沿用那条的编号，不重复列出。
 * 上一次导出追加进去的平台条目（文本或 DOI 对得上）在下次导出时去掉重排，不会越积越多。
 */

/** 文献表标题：「参考文献」「References」「五、参考文献：」等。 */
export const REF_TITLE = /^(?:[一二三四五六七八九十\d]+[.、\s]*)?(?:参考文献|references|bibliography)[:：]?$/i
/** 文献表条目：「[12] 作者. 标题…」。 */
const REF_ENTRY = /^\[(\d+)\]\s+(\S[\s\S]*)$/
const DOI = /\b10\.\d{4,9}\/[^\s,;]+/g

export interface CitationLike { id: string; doi: string; formatted: string }

export interface ReferencePlan {
  /** 正文里每个平台引用的编号。 */
  numbers: Map<string, number>
  /** 需要追加到文献表的平台引用（按编号排序；与用户条目重复的不在其中）。 */
  append: Array<{ id: string; n: number }>
  /** 正文保留到哪个顶层块（不含）；之后是要去掉的旧平台条目、空行或（无用户条目时的）段落式标题。 */
  bodyEnd: number
  /** 末尾已有可复用的「参考文献」标题块（heading），追加时不再另起标题。 */
  hasHeading: boolean
  /** 用户自己写的条目数（取最大编号）；> 0 表示平台引用合并进了用户的文献表。 */
  userCount: number
  /** 与用户条目重复、沿用其编号的平台引用数。 */
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
const doisIn = (text: string) => [...text.matchAll(DOI)].map(m => m[0].replace(/[.)\]]+$/, '').toLowerCase())

export function referencePlan(doc: PMNode, citations: readonly CitationLike[]): ReferencePlan {
  const byId = new Map(citations.map(c => [c.id, c]))
  const order = citationOrderOf(doc).filter(id => byId.has(id))
  const knownText = new Set(citations.map(c => norm(c.formatted)))
  const doiToId = new Map(citations.filter(c => c.doi.startsWith('10.')).map(c => [c.doi.toLowerCase(), c.id]))
  const isPlatform = (text: string) => knownText.has(norm(text)) || doisIn(text).some(d => doiToId.has(d))

  type Entry = { idx: number; n: number; text: string }
  const entryAt = (i: number): Entry | null => {
    const node = doc.child(i)
    if (node.type.name !== 'paragraph') return null
    const m = REF_ENTRY.exec(node.textContent.trim())
    return m ? { idx: i, n: Number(m[1]), text: m[2]! } : null
  }
  const isBlank = (i: number) => { const n = doc.child(i); return n.type.name === 'paragraph' && n.textContent.trim() === '' && n.childCount === 0 }

  // 从末尾往前：① 空行；② 上次追加的平台条目；③ 用户条目（其余 [n] 行）；④ 「参考文献」标题
  let i = doc.childCount - 1
  while (i >= 0 && isBlank(i)) i--
  const platform: Entry[] = []
  for (let e = i >= 0 ? entryAt(i) : null; e && isPlatform(e.text); e = i >= 0 ? entryAt(i) : null) { platform.unshift(e); i--; while (i >= 0 && isBlank(i)) i-- }
  const user: Entry[] = []
  // 平台条目从 [1] 编起说明前面没有用户表（或用户表全是平台引用），不再往前认用户条目
  if (!(platform.length > 0 && platform[0]!.n === 1)) {
    for (let e = i >= 0 ? entryAt(i) : null; e; e = i >= 0 ? entryAt(i) : null) { user.unshift(e); i--; while (i >= 0 && isBlank(i)) i-- }
  }
  const titleIdx = i >= 0 && (doc.child(i).type.name === 'heading' || doc.child(i).type.name === 'paragraph') && REF_TITLE.test(doc.child(i).textContent.trim()) ? i : -1

  // 用户条目里带着平台引用 DOI 的：该引用沿用用户的编号
  const fixed = new Map<string, number>()
  for (const e of user) for (const d of doisIn(e.text)) { const id = doiToId.get(d); if (id && !fixed.has(id)) fixed.set(id, e.n) }
  const userCount = user.reduce((m, e) => Math.max(m, e.n), 0)
  const numbers = numberCitations(order, userCount, fixed)
  const append = order.filter(id => !fixed.has(id)).map(id => ({ id, n: numbers.get(id)! }))

  let bodyEnd = doc.childCount
  let hasHeading = false
  if (order.length > 0) {
    if (user.length > 0) bodyEnd = user[user.length - 1]!.idx + 1
    else if (titleIdx !== -1) {
      hasHeading = doc.child(titleIdx).type.name === 'heading'
      bodyEnd = hasHeading ? titleIdx + 1 : titleIdx
    } else if (platform.length > 0) bodyEnd = platform[0]!.idx
  }
  return { numbers, append, bodyEnd, hasHeading, userCount: order.length > 0 ? userCount : 0, duplicates: order.filter(id => fixed.has(id)).length }
}
