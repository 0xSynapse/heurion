import { randomBytes } from 'node:crypto'
import type { Node as PMNode } from 'prosemirror-model'
import { isAddressable } from './schema.ts'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 短 base36 id（4 位起步，冲突时加长）。只要求在单个文档内唯一。 */
export function newId(taken: Set<string>): string {
  for (let len = 4; ; len++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const bytes = randomBytes(len * 2)
      let id = ''
      for (const b of bytes) {
        if (b >= 252) continue
        id += ALPHABET[b % 36]
        if (id.length === len) break
      }
      if (id.length < len) continue
      // 首字符用字母：避免与数字、序号混淆
      if (!/^[a-z]/.test(id)) continue
      if (!taken.has(id)) {
        taken.add(id)
        return id
      }
    }
  }
}

/** 文档内全部已用 id。 */
export function collectIds(doc: PMNode): Set<string> {
  const ids = new Set<string>()
  doc.descendants(n => {
    if (n.attrs.id) ids.add(n.attrs.id as string)
  })
  return ids
}

/** id → 节点及其位置（pos 指节点起点）。 */
export function indexById(doc: PMNode): Map<string, { node: PMNode; pos: number }> {
  const map = new Map<string, { node: PMNode; pos: number }>()
  doc.descendants((node, pos) => {
    if (node.attrs.id) map.set(node.attrs.id as string, { node, pos })
  })
  return map
}

/**
 * 给缺 id 或在本树内重复的可寻址节点补号；taken 为文档里已占用的 id，新分配的 id 会加入其中。
 * 插入新内容前应先 stripIds，保证新节点全部重新分配、不与现有节点撞号。
 */
export function assignIds(node: PMNode, taken: Set<string>): PMNode {
  const seen = new Set<string>()
  const walk = (n: PMNode): PMNode => {
    let attrs = n.attrs
    if (isAddressable(n)) {
      const id = n.attrs.id as string | null
      if (!id || seen.has(id)) attrs = { ...n.attrs, id: newId(taken) }
      else taken.add(id)
      seen.add(attrs.id as string)
    }
    if (n.isLeaf) return attrs === n.attrs ? n : n.type.create(attrs, null, n.marks)
    const children: PMNode[] = []
    n.forEach(c => children.push(walk(c)))
    return n.type.create(attrs, children, n.marks)
  }
  return walk(node)
}

/** 去掉所有 id（解析出的新内容插入前使用，保证全部重新分配）。 */
export function stripIds(node: PMNode): PMNode {
  if (node.isText) return node
  const attrs = 'id' in node.attrs ? { ...node.attrs, id: null } : node.attrs
  if (node.isLeaf) return node.type.create(attrs, null, node.marks)
  const children: PMNode[] = []
  node.forEach(c => children.push(stripIds(c)))
  return node.type.create(attrs, children, node.marks)
}
