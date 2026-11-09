import { gunzipSync } from 'node:zlib'

/**
 * 原版映射的只读查询（docs/design/PDF_ORIGINAL_VIEW.md §5.3 / §5.4）：
 * - 块 → 原版页码：评论卡片显示「第 N 页」，comments_list 给 AI 的锚点带 page。页码取块在原版上的第一处区域；
 *   只有词对齐、没有区域的块（表格单元格段落）取第一个词所在的页。
 * - 块导入时的文字：与转换稿当前文字不同说明块改过，评论卡片标「转换稿里这段已修改」（原版上的位置可能不准）。
 * 映射导入后不变，按文档缓存解析结果（最多留 32 份）。
 */
type Pager = (nodeIds: Array<string | null | undefined>) => number | null

interface MapNodes { nodes?: Record<string, { text?: string; regions?: number[][]; spans?: number[][] }>; words?: Array<[number, ...unknown[]]> }

export interface SourceIndex {
  page: Pager
  /** 块导入时的文字（映射里没有记文字的块返回 undefined） */
  importText: (nodeId: string) => string | undefined
}

const cache = new Map<string, { size: number; index: SourceIndex }>()

export function sourceIndex(docId: string, gz: Uint8Array | null): SourceIndex | null {
  if (!gz) return null
  const hit = cache.get(docId)
  if (hit && hit.size === gz.byteLength) return hit.index
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
  const index: SourceIndex = {
    page: ids => {
      for (const id of ids) {
        const p = id ? pageOf(id) : null
        if (p != null) return p
      }
      return null
    },
    importText: id => nodes[id]?.text,
  }
  cache.set(docId, { size: gz.byteLength, index })
  if (cache.size > 32) cache.delete(cache.keys().next().value!)
  return index
}

/** 只要页码时的简写 */
export function sourcePager(docId: string, gz: Uint8Array | null): Pager | null {
  return sourceIndex(docId, gz)?.page ?? null
}
