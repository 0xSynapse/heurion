import type { Node as PMNode } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import { assignIds, collectIds, indexById, newId, stripIds } from '../model/ids.ts'
import { diffNodes } from '../model/runtime.ts'

/**
 * suggest 模式（块级修订，PLATFORM.md §8.2）：AI 的一批修改不直接生效，而是同时保留原块与新块——
 * 改动的块 → 原块标 delete + 新块标 insert（suggest_of = 原块 id）；新增的块标 insert；
 * 删除的块放回原位标 delete。同一批修改共享 suggest_group，用户逐组采纳或拒绝。
 */

const clear = { suggest: null, suggest_group: null, suggest_of: null, suggest_author: null }

/** pos 处的块自身或某个祖先是待采纳的新增块（修改它们只是在改同一条修订，不另起修订）。 */
function insidePendingInsert(doc: PMNode, pos: number, self?: PMNode): boolean {
  if (self?.attrs.suggest === 'insert') return true
  const $pos = doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).attrs.suggest === 'insert') return true
  return false
}

/** 把 before → after 的变化表达为待采纳修订，返回新文档。 */
export function toSuggestion(before: PMNode, after: PMNode, group: string): PMNode {
  const changes = diffNodes(before, after)
  if (changes.length === 0) return after
  const taken = new Set([...collectIds(before), ...collectIds(after)])
  const old = indexById(before)
  const tr = new Transform(after)

  // ① 改动的块：原块（delete）+ 新块（insert，内部 id 重新分配避免与原块重复）。
  // 改的是一条还没采纳的新增（或它里面的内容，例如修订版表格的单元格）：并入那条修订，保持原组与 suggest_of，
  // 不再复制出第二份——否则同一张表会出现多份待新增副本，失去配对，采纳或导出时内容重复
  for (const c of changes.filter(x => x.kind === 'modified')) {
    const hit = indexById(tr.doc).get(c.node_id)
    const prevHit = old.get(c.node_id)
    const prev = prevHit?.node
    if (!hit || !prev) continue
    if (insidePendingInsert(before, prevHit.pos, prev)) {
      if (prev.attrs.suggest === 'insert') {
        tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, suggest: 'insert', suggest_group: prev.attrs.suggest_group, suggest_of: prev.attrs.suggest_of, suggest_author: prev.attrs.suggest_author })
      }
      continue
    }
    const fresh = assignIds(stripIds(hit.node), taken)
    const inserted = fresh.type.create({ ...fresh.attrs, id: newId(taken), suggest: 'insert', suggest_group: group, suggest_of: c.node_id }, fresh.content, fresh.marks)
    const deleted = prev.type.create({ ...prev.attrs, suggest: 'delete', suggest_group: group, suggest_of: null }, prev.content, prev.marks)
    tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, [deleted, inserted])
  }

  // ② 新增的块（只标最外层；加在一条待采纳新增里面的，属于那条修订，不另标）
  const added = new Set(changes.filter(x => x.kind === 'added').map(x => x.node_id))
  const marks: number[] = []
  tr.doc.descendants((node, pos) => {
    if (!node.attrs.id || !added.has(node.attrs.id as string)) return true
    const $pos = tr.doc.resolve(pos)
    for (let d = $pos.depth; d > 0; d--) if (added.has($pos.node(d).attrs.id as string)) return false
    if (insidePendingInsert(tr.doc, pos)) return false
    // 整段替换修订版时多出来的块：操作层已并入那条修订，不另标新组
    if (node.attrs.suggest === 'insert' && node.attrs.suggest_group) return false
    marks.push(pos)
    return false
  })
  for (const pos of marks) {
    const node = tr.doc.nodeAt(pos)!
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, suggest: 'insert', suggest_group: group, suggest_of: null })
  }

  // ③ 删除的块（只放回最外层）：插回原位置——原文里紧挨着的前一个兄弟之后，否则父块开头。
  // 按文档顺序放回，连续删除的几块里前一块已先放回，所以锚点可以是它（若都锚到同一个未删兄弟，会倒序）
  const removed = new Set(changes.filter(x => x.kind === 'removed').map(x => x.node_id))
  const restore: Array<{ node: PMNode; prevSiblings: string[]; parent: string | null }> = []
  before.descendants((node, pos) => {
    if (!node.attrs.id || !removed.has(node.attrs.id as string)) return true
    const $pos = before.resolve(pos)
    for (let d = $pos.depth; d > 0; d--) if (removed.has($pos.node(d).attrs.id as string)) return false
    // 撤回的是一条还没采纳的新增：直接拿掉，不变成「待删除」
    if (insidePendingInsert(before, pos, node)) return false
    const parent = $pos.parent
    // 由近到远的前面兄弟：最近的那个若没能放回（或没有 id），退到更前面的
    const prevSiblings: string[] = []
    for (let i = $pos.index() - 1; i >= 0; i--) {
      const sib = parent.child(i).attrs.id as string | null
      if (sib) prevSiblings.push(sib)
    }
    restore.push({ node, prevSiblings, parent: $pos.depth === 0 ? null : (parent.attrs.id as string | null) ?? null })
    return false
  })
  for (const r of restore) {
    const node = r.node.type.create({ ...r.node.attrs, suggest: 'delete', suggest_group: group, suggest_of: null }, r.node.content, r.node.marks)
    const index = indexById(tr.doc)
    const anchor = r.prevSiblings.map(id => index.get(id)).find(Boolean)
    try {
      if (anchor) tr.insert(anchor.pos + anchor.node.nodeSize, node)
      else if (r.parent && index.get(r.parent)) tr.insert(index.get(r.parent)!.pos + 1, node)
      else tr.insert(0, node)
    } catch {
      // 原位置已不接受该块（容器被改造）：放弃展示这条删除，修改照常进入修订
    }
  }
  return tr.doc
}

/** 文档里的待采纳修订组：组 id → 块数。 */
export function pendingGroups(doc: PMNode): Array<{ group: string; inserts: number; deletes: number }> {
  const groups = new Map<string, { inserts: number; deletes: number }>()
  doc.descendants(n => {
    if (!n.attrs.suggest) return true
    const g = groups.get(n.attrs.suggest_group as string) ?? { inserts: 0, deletes: 0 }
    if (n.attrs.suggest === 'insert') g.inserts++
    else g.deletes++
    groups.set(n.attrs.suggest_group as string, g)
    return true
  })
  return [...groups].map(([group, v]) => ({ group, ...v }))
}

/**
 * 采纳 / 拒绝修订组（group = null 表示全部）。采纳：删掉 delete 块，insert 块转正并接过原块 id；
 * 拒绝：删掉 insert 块，delete 块恢复。删除会让容器变空时连同容器一起删除。
 */
export function resolveSuggestions(doc: PMNode, group: string | null, accept: boolean): PMNode {
  const tr = new Transform(doc)
  const targets: Array<{ pos: number; node: PMNode }> = []
  doc.descendants((node, pos) => {
    if (node.attrs.suggest && (group === null || node.attrs.suggest_group === group)) targets.push({ pos, node })
    return true
  })
  // 从后往前处理，前面的位置不受影响
  for (const { pos, node } of targets.reverse()) {
    const mapped = tr.mapping.map(pos)
    const current = tr.doc.nodeAt(mapped)
    if (!current || current.attrs.suggest_group !== node.attrs.suggest_group || current.attrs.suggest !== node.attrs.suggest) continue
    const remove = (node.attrs.suggest === 'delete') === accept
    if (remove) {
      const $pos = tr.doc.resolve(mapped)
      if ($pos.parent.canReplace($pos.index(), $pos.index() + 1)) tr.delete(mapped, mapped + current.nodeSize)
      else if ($pos.depth > 0) tr.delete($pos.before(), $pos.after())
      else tr.replaceWith(mapped, mapped + current.nodeSize, current.type.schema.node('paragraph', { id: current.attrs.id }))
    } else {
      const id = accept && current.attrs.suggest_of ? current.attrs.suggest_of : current.attrs.id
      tr.setNodeMarkup(mapped, undefined, { ...current.attrs, ...clear, id })
    }
  }
  return tr.doc
}

/** 导出视图：待采纳的修订按「拒绝」处理（文档在采纳前保持原样）。 */
export function withoutPending(doc: PMNode): PMNode {
  let has = false
  doc.descendants(n => { if (n.attrs.suggest) has = true; return !has })
  return has ? resolveSuggestions(doc, null, false) : doc
}
