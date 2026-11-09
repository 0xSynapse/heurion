import type { Node as PMNode } from 'prosemirror-model'
import type { SourceMap } from './doc-parser.ts'

/**
 * 给早期导入、没有原版映射的 PDF 稿补生成映射（docs/design/PDF_ORIGINAL_VIEW.md §7）：
 * 重新解析原文件得到一份新文档与它的映射，再把映射的块 id 换成当前文档里同一块的 id。
 *
 * 对应关系按文档顺序、同类型且文字相同来找（导入后没改过的块文字与重新解析的一致；块 id 在导入时随机分配，不能直接用）。
 * 改过的块找不到对应，不进映射：原版上照常按 §5.3 退回在区域里按文字找、画整块。
 */
export function rebindSourceMap(current: PMNode, freshDoc: PMNode, fresh: SourceMap): { map: SourceMap; matched: number; total: number } {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const list = (doc: PMNode, only?: Set<string>) => {
    const out: Array<{ id: string; type: string; text: string }> = []
    doc.descendants(n => {
      const id = n.attrs?.id as string | undefined
      if (id && (!only || only.has(id))) out.push({ id, type: n.type.name, text: norm(n.textContent) })
      return true
    })
    return out
  }
  const want = list(freshDoc, new Set(Object.keys(fresh.nodes)))
  const have = list(current)
  const nodes: SourceMap['nodes'] = {}
  let j = 0
  for (const w of want) {
    // 往后找同类型、同文字的块（窗口 400 个块：中间可能插了新写的内容）；找到后从它后面继续，保持顺序
    let hit = -1
    for (let k = j; k < Math.min(have.length, j + 400); k++) {
      const h = have[k]!
      if (h.type === w.type && h.text === w.text && !nodes[h.id]) { hit = k; break }
    }
    if (hit < 0) continue
    nodes[have[hit]!.id] = fresh.nodes[w.id]!
    j = hit + 1
  }
  return { map: { ...fresh, nodes }, matched: Object.keys(nodes).length, total: want.length }
}
