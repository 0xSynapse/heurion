import type { Node as PMNode } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import type { CommentRow } from '../store/db.ts'
import { indexById } from './ids.ts'
import { plainText } from './markdown.ts'

/**
 * 评论锚点（PLATFORM.md §4.1）：有文字的锚点是 comment(thread) mark，挂在 Yjs 文本上，
 * 跨编辑不漂移；无文字的块（图、不可编辑块）锚在块 id 上。
 */

export interface AnchorLocation {
  located: boolean
  /** 锚点所在的块（mark 跨多个块时取全部）。 */
  node_ids: string[]
  /** 当前被锚定的文字。 */
  text: string
  /** 所属章节标题（如「1 引言」「方法」「结果」）。 */
  section_title?: string
  /** 所属章节标题块的 node_id。 */
  section_node_id?: string
}

/** 查找目标块所属的最近章节标题（heading）及其 node_id。 */
export function findSectionForNode(doc: PMNode, targetNodeId: string): { section_title?: string; section_node_id?: string } {
  if (!targetNodeId) return {}
  let currentTitle: string | undefined
  let currentId: string | undefined
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i)
    if (block.type.name === 'heading') {
      const t = block.textContent.trim()
      if (t) {
        currentTitle = t
        currentId = (block.attrs.id as string | undefined) ?? undefined
      }
    }
    let matched = block.attrs.id === targetNodeId
    if (!matched && !block.isTextblock) {
      block.descendants(n => {
        if (n.attrs?.id === targetNodeId) {
          matched = true
          return false
        }
        return true
      })
    }
    if (matched) {
      return { section_title: currentTitle, section_node_id: currentId }
    }
  }
  return {}
}

/** 文档中每条线程 mark 覆盖的块与文字。 */
export function threadMarks(doc: PMNode): Map<string, { node_ids: string[]; text: string }> {
  const out = new Map<string, { node_ids: string[]; text: string }>()
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // 文本块自己没有 id（deck 形状里的段落）：归到最近的带 id 的祖先
    let id = node.attrs.id as string | null | undefined
    if (!id) {
      const $pos = doc.resolve(pos)
      for (let d = $pos.depth; d > 0 && !id; d--) id = $pos.node(d).attrs.id as string | null | undefined
    }
    if (!id) return false
    node.forEach(child => {
      for (const m of child.marks) {
        if (m.type.name !== 'comment') continue
        const thread = m.attrs.thread as string
        const entry = out.get(thread) ?? { node_ids: [], text: '' }
        if (!entry.node_ids.includes(id!)) entry.node_ids.push(id!)
        entry.text += child.isText ? child.text : ''
        out.set(thread, entry)
      }
    })
    return false
  })
  return out
}

export function locate(doc: PMNode, comment: Pick<CommentRow, 'id' | 'node_id' | 'snippet'>, marks = threadMarks(doc)): AnchorLocation {
  const hit = marks.get(comment.id)
  if (hit) {
    const primaryNodeId = hit.node_ids[0] ?? comment.node_id
    const sec = findSectionForNode(doc, primaryNodeId)
    return { located: true, node_ids: hit.node_ids, text: hit.text, ...sec }
  }
  const byId = indexById(doc)
  const nodeHit = byId.get(comment.node_id)
  // 无 mark 的块级锚点：块还在即定位
  if (!comment.snippet) {
    if (!nodeHit) return { located: false, node_ids: [], text: '' }
    const sec = findSectionForNode(doc, comment.node_id)
    return { located: true, node_ids: [comment.node_id], text: plainText(nodeHit.node).slice(0, 200), ...sec }
  }
  // 表格 / 图表等复合块审稿批注（带可读摘要 snippet 但锚在整块 node_id 上）：块还在即视为已定位
  if (nodeHit && (nodeHit.node.type.name === 'table' || nodeHit.node.type.name === 'figure' || comment.snippet.startsWith('[表格]'))) {
    const sec = findSectionForNode(doc, comment.node_id)
    return { located: true, node_ids: [comment.node_id], text: comment.snippet, ...sec }
  }
  const sec = nodeHit ? findSectionForNode(doc, comment.node_id) : {}
  return { located: false, node_ids: nodeHit ? [comment.node_id] : [], text: '', ...sec }
}

export class AnchorError extends Error {}

/**
 * 给新评论打锚点（PLATFORM.md §5.4）。颗粒度只有两种：
 * - 一个段落内的连续文字：doc 的段落 / 标题；deck 形状里的某一段（paragraph = 该段在形状里的序号）；
 * - 一整块：snippet 为空——doc 的块（列表项、表格、图……）或 deck 的整个形状。
 * 跨段落、跨块的选区不接受（与 Claude Docs 一致），调用方应在选区阶段就拦下。
 */
export function attachComment(
  doc: PMNode, nodeId: string, snippet: string, thread: string, paragraph?: number, range?: { from: number; to: number },
): { doc: PMNode; snippet: string } {
  const hit = indexById(doc).get(nodeId)
  if (!hit) throw new AnchorError(`找不到块 ${nodeId}`)
  const { node, pos } = hit
  const mark = doc.type.schema.marks.comment!.create({ thread })
  const tr = new Transform(doc)
  const textblocks: Array<{ node: PMNode; pos: number }> = []
  if (node.isTextblock) textblocks.push({ node, pos })
  else node.descendants((n, p) => { if (n.isTextblock) textblocks.push({ node: n, pos: pos + 1 + p }); return !n.isTextblock })

  const wanted = snippet.replace(/\r\n?/g, '\n').trim()
  if (range) {
    // 选区位置（段落内偏移）：精确定位重复出现的文字；文字与位置对不上（期间文档变了）时退回按文字查找
    const tb = node.isTextblock ? textblocks[0] : paragraph !== undefined ? textblocks[paragraph] : undefined
    if (!tb) throw new AnchorError('选中的文字要落在一个段落内')
    const { from, to } = range
    const size = tb.node.content.size
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > size || from >= to) throw new AnchorError('选区位置无效，请重新选择')
    const text = paragraphText(tb.node, from, to)
    if (!text.trim()) throw new AnchorError('选中的内容里没有文字')
    if (text.trim() === wanted || !wanted) {
      tr.addMark(tb.pos + 1 + from, tb.pos + 1 + to, mark)
      return { doc: tr.doc, snippet: text.trim() }
    }
    const r = findInParagraph(tb.node, tb.pos, wanted)
    if (!r) throw new AnchorError('文档已变化，选中的文字对不上，请重新选择')
    tr.addMark(r.from, r.to, mark)
    return { doc: tr.doc, snippet: wanted }
  }
  if (!wanted) {
    // 整块 / 整个形状
    for (const tb of textblocks) if (tb.node.content.size > 0) tr.addMark(tb.pos + 1, tb.pos + tb.node.nodeSize - 1, mark)
    return { doc: tr.doc, snippet: '' }
  }
  let scope: Array<{ node: PMNode; pos: number }>
  if (node.isTextblock) scope = textblocks
  else if (node.type.name === 'shape') {
    if (paragraph !== undefined) {
      const tb = textblocks[paragraph]
      if (!tb) throw new AnchorError(`形状 ${nodeId} 没有第 ${paragraph + 1} 段`)
      scope = [tb]
    } else scope = textblocks
  } else {
    throw new AnchorError('选中的文字要落在一个段落内；要评论整块请不带选中文字')
  }
  const found: Array<{ from: number; to: number }> = []
  for (const tb of scope) {
    const r = findInParagraph(tb.node, tb.pos, wanted)
    if (r) found.push(r)
  }
  if (found.length === 0) throw new AnchorError(`块 ${nodeId} 中找不到选中的文字（评论只能落在一个段落内）`)
  if (found.length > 1) throw new AnchorError('选中的文字在多个段落里都有，请带上段落位置')
  tr.addMark(found[0]!.from, found[0]!.to, mark)
  return { doc: tr.doc, snippet: wanted }
}

/**
 * 段落内 [from, to) 的文字：硬换行记作换行，引用等行内原子不计文字。前端用同一规则从选区算出引用文字，
 * 两边一致才按位置打锚点。
 */
export function paragraphText(block: PMNode, from: number, to: number): string {
  return block.textBetween(from, to, '\n', leaf => (leaf.type.name === 'hard_break' ? '\n' : ''))
}

/** 在一个段落里找文字：硬换行记作换行；先精确，再不区分大小写。 */
function findInParagraph(block: PMNode, pos: number, wanted: string): { from: number; to: number } | null {
  let text = ''
  const from: number[] = []
  const to: number[] = []
  block.forEach((child, offset) => {
    const start = pos + 1 + offset
    if (child.isText) {
      for (let i = 0; i < child.text!.length; i++) { text += child.text![i]; from.push(start + i); to.push(start + i + 1) }
    } else if (child.type.name === 'hard_break') {
      text += '\n'; from.push(start); to.push(start + child.nodeSize)
    }
  })
  let at = text.indexOf(wanted)
  if (at === -1 && text.toLowerCase().length === text.length && wanted.toLowerCase().length === wanted.length) {
    // 转小写会改变长度的字符（如 İ）下位置对不上，这时不做大小写回退
    const lower = text.toLowerCase()
    at = lower.indexOf(wanted.toLowerCase())
    if (at !== -1 && lower.indexOf(wanted.toLowerCase(), at + 1) !== -1) at = -1
  }
  return at === -1 ? null : { from: from[at]!, to: to[at + wanted.length - 1]! }
}
