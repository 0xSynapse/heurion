import type { Node as PMNode } from 'prosemirror-model'
import { locate, threadMarks } from '../model/anchors.ts'
import { plainText, serializeBlock } from '../model/markdown.ts'
import { diffNodes } from '../model/runtime.ts'
import type { CitationRow, CommentRow } from '../store/db.ts'

/**
 * 读视图（PLATFORM.md §6.2）：给模型的紧凑文本视图。所有视图都带 rev，
 * 写入时作为 base_rev。块 id 以 `{#id}` 前缀出现。
 */

const PAGE_CHARS = 12_000

function topBlocks(doc: PMNode): PMNode[] {
  const out: PMNode[] = []
  doc.forEach(n => out.push(n))
  return out
}

/** 引用编号：按正文中首次出现顺序。 */
export function citationOrder(doc: PMNode): string[] {
  const order: string[] = []
  doc.descendants(n => {
    if (n.type.name === 'citation' && !order.includes(n.attrs.cite_id as string)) order.push(n.attrs.cite_id as string)
  })
  return order
}

export function outline(input: { doc: PMNode; docId: string; title: string; rev: number; citations: CitationRow[]; openComments: number }): string {
  const blocks = topBlocks(input.doc)
  const lines: string[] = []
  const used = citationOrder(input.doc).length
  lines.push(`doc_id=${input.docId} · 《${input.title}》 · rev=${input.rev} · ${blocks.length} 个顶层块 · 引用 ${used}/${input.citations.length}（文中使用/已登记）· open 评论 ${input.openComments}`)
  // 每个标题统计其下（到下一个同级或更高级标题之前）的块数与字数
  const headings = blocks.map((b, i) => ({ b, i })).filter(x => x.b.type.name === 'heading')
  if (headings.length === 0) {
    const chars = blocks.reduce((s, b) => s + plainText(b).length, 0)
    lines.push(`（无标题）全文 ${blocks.length} 块，${chars} 字`)
  }
  const firstHeading = headings[0]?.i ?? blocks.length
  if (headings.length > 0 && firstHeading > 0) {
    const chars = blocks.slice(0, firstHeading).reduce((s, b) => s + plainText(b).length, 0)
    lines.push(`（首个标题前）${firstHeading} 块，${chars} 字，首块 {#${blocks[0]!.attrs.id}}`)
  }
  headings.forEach(({ b, i }, k) => {
    const level = b.attrs.level as number
    const isDelete = b.attrs.suggest === 'delete'
    let end = blocks.length
    for (const h of headings.slice(k + 1)) {
      if (!isDelete && h.b.attrs.suggest === 'delete') continue
      if ((h.b.attrs.level as number) <= level) { end = h.i; break }
    }
    const rawBody = blocks.slice(i + 1, end)
    const body = isDelete ? rawBody : rawBody.filter(x => x.attrs.suggest !== 'delete')
    const chars = body.reduce((s, x) => s + plainText(x).length, 0)
    const tag = b.attrs.suggest === 'insert' ? '⟨待采纳·新增⟩ ' : b.attrs.suggest === 'delete' ? '⟨待采纳·删除⟩ ' : ''
    lines.push(`${'  '.repeat(level - 1)}${'#'.repeat(level)} {#${b.attrs.id}} ${tag}${plainText(b)}（${body.length} 块，${chars} 字）`)
  })
  return lines.join('\n')
}

export interface ReadInput {
  doc: PMNode
  docId: string
  rev: number
  comments: CommentRow[]
  /** 从某个标题开始读到下一个同级或更高级标题之前。 */
  section_id?: string
  from_id?: string
  to_id?: string
  /** 分页游标：顶层块下标。 */
  cursor?: number
}

export class ReadError extends Error {}

export function read(input: ReadInput): string {
  const blocks = topBlocks(input.doc)
  const idx = (id: string) => {
    const i = blocks.findIndex(b => b.attrs.id === id || containsId(b, id))
    if (i === -1) throw new ReadError(`找不到块 ${id}（读取范围只能用 doc_outline 中的 id）`)
    return i
  }
  let start = 0
  let end = blocks.length
  if (input.section_id) {
    start = idx(input.section_id)
    const head = blocks[start]!
    if (head.type.name === 'heading') {
      const level = head.attrs.level as number
      for (let i = start + 1; i < blocks.length; i++) {
        const b = blocks[i]!
        if (b.type.name === 'heading' && (b.attrs.level as number) <= level) { end = i; break }
      }
    } else end = start + 1
  }
  if (input.from_id) start = idx(input.from_id)
  if (input.to_id) end = idx(input.to_id) + 1
  if (input.cursor !== undefined) start = Math.max(start, input.cursor)

  const parts: string[] = []
  let size = 0
  let i = start
  for (; i < end; i++) {
    const md = serializeBlock(blocks[i]!, { ids: true }, '')
    if (size > 0 && size + md.length > PAGE_CHARS) break
    parts.push(md)
    size += md.length
  }
  const more = i < end ? ` · 未读完，下一页 cursor=${i}` : ''
  const header = `doc_id=${input.docId} · rev=${input.rev} · 顶层块 ${start + 1}–${i}/${blocks.length}${more}`

  // 本范围内的 open 评论（锚点 = 写入目标）
  const range = new Set<string>()
  for (const b of blocks.slice(start, i)) collectIdsInto(b, range)
  const marks = threadMarks(input.doc)
  const notes = input.comments
    .filter(c => c.status === 'open')
    .map(c => ({ c, loc: locate(input.doc, c, marks) }))
    .filter(x => x.loc.node_ids.some(id => range.has(id)))
    .map(x => `- 评论 ${x.c.id} @ {#${x.loc.node_ids.join('}, {#')}}「${x.loc.text.slice(0, 80)}」：${x.c.replies.filter(r => r.role === 'user').at(-1)?.text ?? ''}`)
  const tail = notes.length > 0 ? `\n\n---\n本范围内的 open 评论：\n${notes.join('\n')}` : ''
  return `${header}\n\n${parts.join('\n\n')}${tail}`
}

function containsId(node: PMNode, id: string): boolean {
  let found = false
  node.descendants(n => {
    if (n.attrs.id === id) found = true
    return !found
  })
  return found
}

function collectIdsInto(node: PMNode, set: Set<string>): void {
  if (node.attrs.id) set.add(node.attrs.id as string)
  node.descendants(n => { if (n.attrs.id) set.add(n.attrs.id as string) })
}

/** 检索：按块返回命中片段（大小写、空白不敏感）。 */
export function search(doc: PMNode, query: string, limit = 20): Array<{ id: string; type: string; snippet: string }> {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ')
  const terms = norm(query).split(' ').filter(Boolean)
  if (terms.length === 0) return []
  const hits: Array<{ id: string; type: string; snippet: string; score: number }> = []
  doc.descendants(n => {
    if (!n.attrs.id || !(n.isTextblock || n.type.name === 'figure' || n.type.name === 'opaque' || n.type.name === 'table')) return true
    const text = plainText(n)
    const t = norm(text)
    const score = terms.filter(term => t.includes(term)).length
    if (score > 0) {
      const at = Math.max(0, t.indexOf(terms[0]!) - 40)
      hits.push({ id: n.attrs.id as string, type: n.type.name, snippet: text.slice(at, at + 160), score })
    }
    return n.type.name !== 'table'
  })
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score: _s, ...h }) => h)
}

/** 两个版本之间的块级变化摘要。 */
export function diff(before: PMNode, after: PMNode): Array<{ id: string; kind: string; before?: string; after?: string }> {
  const index = (doc: PMNode) => {
    const m = new Map<string, PMNode>()
    doc.descendants(n => { if (n.attrs.id) m.set(n.attrs.id as string, n); return n.type.name !== 'table' })
    return m
  }
  const a = index(before)
  const b = index(after)
  return diffNodes(before, after).map(c => ({
    id: c.node_id,
    kind: c.kind,
    ...(a.has(c.node_id) && c.kind !== 'added' ? { before: plainText(a.get(c.node_id)!).slice(0, 300) } : {}),
    ...(b.has(c.node_id) && c.kind !== 'removed' ? { after: plainText(b.get(c.node_id)!).slice(0, 300) } : {}),
  }))
}
