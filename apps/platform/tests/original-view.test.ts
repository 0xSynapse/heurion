import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { bindSourceMap, docParserToDoc, mergeContinuedTables, type DocParserBlock, type DocParseResult } from '../src/convert/doc-parser.ts'
import { assignIds } from '../src/model/ids.ts'
import { Store } from '../src/store/db.ts'
import { Documents } from '../src/model/runtime.ts'
import { duplicateDoc } from '../src/model/duplicate.ts'

// 原版 PDF 视图的映射（docs/design/PDF_ORIGINAL_VIEW.md §3）：doc-parser 给的 src → 按块 id 存

const words: NonNullable<DocParseResult['source']>['words'] = [
  [1, 10, 10, 40, 20, 'Methods'], [1, 10, 30, 30, 40, 'We'], [1, 32, 30, 60, 40, 'enrolled'], [1, 62, 30, 80, 40, 'adults.'],
  [2, 10, 10, 30, 20, 'Age'], [2, 40, 10, 60, 20, '37.4'],
]
const result = (blocks: DocParserBlock[]): DocParseResult => ({
  engine: 'docling', page_count: 2, warnings: [], scanned_pages: [], blocks,
  source: { pages: [{ w: 600, h: 800 }, { w: 600, h: 800 }], words },
})

describe('原版映射', () => {
  it('段落 / 标题的对齐随首尾空白平移，表格单元格落到格里的段落，图记区域', () => {
    const built = docParserToDoc(result([
      { type: 'heading', level: 2, text: 'Methods', src: { regions: [[1, 10, 10, 40, 20]], spans: [[0, 7, 0]] } },
      { type: 'paragraph', text: '  We enrolled adults.', src: { regions: [[1, 10, 30, 80, 40]], spans: [[2, 4, 1], [5, 13, 2], [14, 21, 3]] } },
      { type: 'table', rows: [['Variable', 'Value'], ['Age', '37.4']], header_rows: 1, src: { regions: [[2, 5, 5, 300, 100]], cells: [[1, 0, [[0, 3, 4]]], [1, 1, [[0, 4, 5]]]] } },
      { type: 'paragraph', text: 'No position information.' },
    ]), 'x')
    expect(built.sourceMap?.blocks.map(b => b.index)).toEqual([0, 1, 2])
    const doc = assignIds(built.doc, new Set())
    const map = bindSourceMap(doc, built.sourceMap!)
    const [h, p, table] = [doc.child(0), doc.child(1), doc.child(2)]
    expect(map.nodes[h.attrs.id]).toEqual({ text: 'Methods', regions: [[1, 10, 10, 40, 20]], spans: [[0, 7, 0]] })
    // 段落文字去掉了开头两个空格，对齐下标跟着减 2
    expect(map.nodes[p.attrs.id]!.spans).toEqual([[0, 2, 1], [3, 11, 2], [12, 19, 3]])
    expect(map.nodes[p.attrs.id]!.text).toBe('We enrolled adults.')
    expect(map.nodes[table.attrs.id]).toEqual({ regions: [[2, 5, 5, 300, 100]] })
    const cellParas: string[] = []
    table.descendants(n => { if (n.isTextblock && map.nodes[n.attrs.id]) cellParas.push(`${n.textContent}:${JSON.stringify(map.nodes[n.attrs.id]!.spans)}`); return true })
    expect(cellParas).toEqual(['Age:[[0,3,4]]', '37.4:[[0,4,5]]'])
    expect(Object.keys(map.nodes)).toHaveLength(5)
  })

  it('没有 source（旧版 doc-parser）时不生成映射', () => {
    const r = result([{ type: 'paragraph', text: 'x', src: { regions: [[1, 0, 0, 1, 1]] } }])
    delete r.source
    expect(docParserToDoc(r, 'x').sourceMap).toBeUndefined()
  })

  it('续表合并：区域接上，续表单元格的行号下移，重复的表头去掉', () => {
    const head = ['Variable', 'Value']
    const out = mergeContinuedTables([
      { type: 'table', rows: [head, ['Age', '37']], header_rows: 1, caption: 'Table 1. Baseline.', page: 1, src: { regions: [[1, 0, 0, 10, 10]], cells: [[1, 0, [[0, 3, 0]]]] } },
      { type: 'table', rows: [head, ['BMI', '26']], header_rows: 1, caption: 'Table 1. Cont.', page: 2, src: { regions: [[2, 0, 0, 10, 10]], cells: [[0, 0, [[0, 8, 1]]], [1, 0, [[0, 3, 2]]]] } },
    ])
    expect(out).toHaveLength(1)
    const t = out[0] as Extract<DocParserBlock, { type: 'table' }>
    expect(t.src?.regions).toEqual([[1, 0, 0, 10, 10], [2, 0, 0, 10, 10]])
    expect(t.src?.cells).toEqual([[1, 0, [[0, 3, 0]]], [2, 0, [[0, 3, 2]]]])
  })

  it('随原始文件包存取，复制文档时一并复制', () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const row = docs.create({ owner: 'u', title: 't', markdown: 'hello' })
    expect(store.hasSourceMap(row.id)).toBe(false)
    store.putPackage(row.id, 'pdf', new Uint8Array([37, 80, 68, 70]), 'docling')
    store.putSourceMap(row.id, { version: 1, pages: [], words: [], nodes: { a: { regions: [[1, 0, 0, 1, 1]] } } })
    expect(store.hasSourceMap(row.id)).toBe(true)
    expect(JSON.parse(gunzipSync(store.getSourceMapGz(row.id)!).toString()).nodes.a.regions).toEqual([[1, 0, 0, 1, 1]])
    const copy = duplicateDoc(docs, store.getDoc(row.id)!, 'u')
    expect(store.hasSourceMap(copy.id)).toBe(true)
    expect(store.getImportInfo(copy.id)?.import_engine).toBe('docling')
  })
})
