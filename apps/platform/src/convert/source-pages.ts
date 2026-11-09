import { gunzipSync } from 'node:zlib'

/**
 * 块 → 原版页码（docs/design/PDF_ORIGINAL_VIEW.md §5.4）：评论卡片显示「第 N 页」，comments_list 给 AI 的锚点带 page。
 * 页码取块在原版上的第一处区域；只有词对齐、没有区域的块（表格单元格段落）取第一个词所在的页。
 * 映射导入后不变，按文档缓存解析结果（最多留 32 份）。
 */
type Pager = (nodeIds: Array<string | null | undefined>) => number | null

interface MapNodes { nodes?: Record<string, { regions?: number[][]; spans?: number[][] }>; words?: Array<[number, ...unknown[]]> }

const cache = new Map<string, { size: number; pager: Pager }>()

export function sourcePager(docId: string, gz: Uint8Array | null): Pager | null {
  if (!gz) return null
  const hit = cache.get(docId)
  if (hit && hit.size === gz.byteLength) return hit.pager
  let map: MapNodes
  try {
    map = JSON.parse(gunzipSync(gz).toString('utf8')) as MapNodes
  } catch {
    return null
  }
  const nodes = map.nodes ?? {}
  const words = map.words ?? []
  const pageOf = (id: string): number | null => {
    const n = nodes[id]
    if (!n) return null
    const r = n.regions?.[0]?.[0]
    if (typeof r === 'number') return r
    const w = n.spans?.[0]?.[2]
    const p = typeof w === 'number' ? words[w]?.[0] : undefined
    return typeof p === 'number' ? p : null
  }
  const pager: Pager = ids => {
    for (const id of ids) {
      const p = id ? pageOf(id) : null
      if (p != null) return p
    }
    return null
  }
  cache.set(docId, { size: gz.byteLength, pager })
  if (cache.size > 32) cache.delete(cache.keys().next().value!)
  return pager
}
