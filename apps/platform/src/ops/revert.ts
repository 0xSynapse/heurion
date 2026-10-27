import type { Node as PMNode } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import { indexById } from '../model/ids.ts'

/**
 * 按节点撤销一个 AI 回合（服务重启后 Y.UndoManager 不在时的退路，PLATFORM.md §5.6）：
 * 以回合开始前的文档（base）为准——该回合新增的块删掉、改过的块换回原样、删掉的块放回原位。
 * 用户在回合之后改过的块跳过（用户优先），返回跳过的块 id。
 */
export function revertByNodes(
  current: PMNode,
  base: PMNode,
  changes: Array<{ node_id: string; kind: 'added' | 'modified' | 'removed' }>,
  userTouched: Set<string>,
): { doc: PMNode; skipped: string[] } {
  const baseIndex = indexById(base)
  const ids = new Set(changes.map(c => c.node_id))
  const skipped: string[] = []
  const tr = new Transform(current)
  current.descendants(n => {
    if (n.attrs.id && userTouched.has(n.attrs.id as string) && n.attrs.suggest_of) {
      userTouched.add(String(n.attrs.suggest_of))
    }
    return true
  })

  for (const id of ids) {
    if (userTouched.has(id)) { skipped.push(id); continue }
    const now = indexById(tr.doc).get(id)
    const before = baseIndex.get(id)
    if (now && !before) {
      // 回合新增的块：删除（容器会变空时连同容器一起删，到文档根时保留一个空段落）
      const $pos = tr.doc.resolve(now.pos)
      if ($pos.parent.canReplace($pos.index(), $pos.index() + 1)) tr.delete(now.pos, now.pos + now.node.nodeSize)
      else if ($pos.depth > 0) tr.delete($pos.before(), $pos.after())
      else skipped.push(id)
    } else if (now && before && !now.node.eq(before.node)) {
      // 回合改过的块：换回原样（只换叶子级块；容器类的变化由其子块的增删体现，幻灯片还原自身属性与备注）
      if (now.node.isTextblock || ['table', 'figure', 'opaque', 'shape'].includes(now.node.type.name)) {
        tr.replaceWith(now.pos, now.pos + now.node.nodeSize, before.node)
      } else if (now.node.type.name === 'slide') {
        const beforeNotes = before.node.lastChild?.type.name === 'notes' ? before.node.lastChild : null
        const nowNotes = now.node.lastChild?.type.name === 'notes' ? now.node.lastChild : null
        const shapes: PMNode[] = []
        now.node.forEach(c => { if (c.type.name === 'shape') shapes.push(c) })
        if (JSON.stringify(now.node.attrs) !== JSON.stringify(before.node.attrs) || !(beforeNotes ? nowNotes?.eq(beforeNotes) : !nowNotes)) {
          const updatedSlide = now.node.type.create(before.node.attrs, beforeNotes ? [...shapes, beforeNotes] : shapes, before.node.marks)
          tr.replaceWith(now.pos, now.pos + now.node.nodeSize, updatedSlide)
        }
      }
    }
  }

  // 回合删掉的块：只放回最外层，插在原来的前一个兄弟之后（否则父块开头 / 文档开头）
  const removed = [...ids].filter(id => !userTouched.has(id) && baseIndex.has(id) && !indexById(tr.doc).has(id))
  const removedSet = new Set(removed)
  base.descendants((node, pos) => {
    const id = node.attrs.id as string | null
    if (!id || !removedSet.has(id)) return true
    const $pos = base.resolve(pos)
    for (let d = $pos.depth; d > 0; d--) if (removedSet.has($pos.node(d).attrs.id as string)) return false
    const index = indexById(tr.doc)
    let anchor: { node: PMNode; pos: number } | undefined
    for (let i = $pos.index() - 1; i >= 0 && !anchor; i--) {
      const sib = $pos.parent.child(i).attrs.id as string | null
      if (sib) anchor = index.get(sib)
    }
    const parentId = $pos.depth > 0 ? ($pos.parent.attrs.id as string | null) : null
    try {
      if (anchor) tr.insert(anchor.pos + anchor.node.nodeSize, node)
      else if (parentId && index.get(parentId)) tr.insert(index.get(parentId)!.pos + 1, node)
      else tr.insert(0, node)
    } catch {
      skipped.push(id)
    }
    return false
  })
  return { doc: tr.doc, skipped }
}
