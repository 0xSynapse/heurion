import { describe, expect, it } from 'vitest'
import { gunzipSync, gzipSync } from 'node:zlib'
import { bindSourceMap, docParserToDoc, mergeContinuedTables, type DocParserBlock, type DocParseResult } from '../src/convert/doc-parser.ts'
import { assignIds } from '../src/model/ids.ts'
import { Store } from '../src/store/db.ts'
import { Documents } from '../src/model/runtime.ts'
import { duplicateDoc } from '../src/model/duplicate.ts'
import { findQuoteWords, type Word } from '../web/src/quote-match.ts'
import { sourcePager } from '../src/convert/source-pages.ts'

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

describe('原版视图的引用兜底定位（§12.2）', () => {
  // 表格两行：「Age | 62 | 61」「Men | 124 (60.2%) | 118 (57.3%)」
  const W: Word[] = [
    [2, 10, 100, 30, 110, 'Age'], [2, 100, 100, 115, 110, '62'], [2, 200, 100, 215, 110, '61'],
    [2, 10, 120, 30, 130, 'Men'], [2, 100, 120, 115, 130, '124'], [2, 117, 120, 150, 130, '(60.2%)'],
    [2, 200, 120, 215, 130, '118'], [2, 217, 120, 250, 130, '(57.3%)'],
    [3, 10, 100, 30, 110, '124'],
  ]
  const table = [[2, 5, 95, 260, 135]]

  it('在块的区域里按文字找到单元格：空白与短横不同也能对上，只取区域内的词', () => {
    expect(findQuoteWords(W, table, '124 (60.2%)')).toEqual([4, 5])
    expect(findQuoteWords(W, table, '124(60.2 %)')).toEqual([4, 5])
    expect(findQuoteWords(W, table, 'Men')).toEqual([3])
  })

  it('找不到、出现不止一次或太短时返回 null（退回画整块）', () => {
    expect(findQuoteWords(W, table, '99 (1.0%)')).toBeNull()
    expect(findQuoteWords(W, table, '6')).toBeNull()
    expect(findQuoteWords(W, [[2, 5, 95, 260, 135], [3, 5, 95, 260, 135]], '124')).toBeNull()
  })
})

describe('评论的原版页码（§5.4）', () => {
  it('块取第一处区域的页，只有词对齐的单元格段落取第一个词的页；都没有时 null', () => {
    const map = {
      version: 1, pages: [{ w: 600, h: 800 }, { w: 600, h: 800 }, { w: 600, h: 800 }],
      words: [[1, 0, 0, 1, 1, 'a'], [3, 0, 0, 1, 1, 'b']],
      nodes: { p1: { regions: [[2, 0, 0, 10, 10]] }, cell: { text: 'b', spans: [[0, 1, 1]] }, empty: {} },
    }
    const pager = sourcePager('doc-pager-test', gzipSync(Buffer.from(JSON.stringify(map))))!
    expect(pager(['p1'])).toBe(2)
    expect(pager(['cell'])).toBe(3)
    expect(pager(['missing', 'empty', 'p1'])).toBe(2)
    expect(pager(['missing', null])).toBeNull()
    expect(sourcePager('x', null)).toBeNull()
  })
})
