import { describe, expect, it } from 'vitest'
import { extractTableSummaries } from '../src/claims/extract.ts'
import { buildTable, mergeContinuedTables, type DocParserBlock } from '../src/convert/doc-parser.ts'
import { schema } from '../src/model/schema.ts'
import { readGrid } from '../src/model/table-grid.ts'
import type { Node as PMNode } from 'prosemirror-model'

type TableBlock = Extract<DocParserBlock, { type: 'table' }>
const para = (t: string) => schema.node('paragraph', null, t ? [schema.text(t)] : [])
/** 逻辑网格：起始格写文字，被覆盖的格写「^」 */
const gridOf = (t: PMNode) => {
  const g = readGrid(t)
  return Array.from({ length: g.height }, (_, r) => Array.from({ length: g.width }, (_, c) => {
    const cell = g.at(r, c)
    return !cell ? '?' : cell.top === r && cell.left === c ? cell.node.textContent : '^'
  }))
}

const BASE: TableBlock = {
  type: 'table', header_rows: 2, page: 3,
  rows: [
    ['Characteristic', 'Drug (n = 79)', '', 'P'],
    ['', 'Pre', 'Post', ''],
    ['Sex', 'Male', '40', '0.3'],
    ['', 'Female', '39', '0.4'],
  ],
  spans: [[0, 0, 2, 1], [0, 1, 1, 2], [0, 3, 2, 1], [2, 0, 2, 1]],
}

describe('PDF 表格保留合并单元格', () => {
  it('按 spans 生成跨行 / 跨列单元格，表头行标记为表头', () => {
    const t = buildTable(BASE, para)!
    expect(gridOf(t)).toEqual([
      ['Characteristic', 'Drug (n = 79)', '^', 'P'],
      ['^', 'Pre', 'Post', '^'],
      ['Sex', 'Male', '40', '0.3'],
      ['^', 'Female', '39', '0.4'],
    ])
    expect(t.child(0).child(1).attrs).toMatchObject({ colspan: 2, rowspan: 1, header: true })
    expect(t.child(2).child(0).attrs).toMatchObject({ rowspan: 2, header: false })
    expect(() => t.check()).not.toThrow()
  })

  it('非法合并区丢弃、文字不丢：越界截断、重叠、盖住有字单元格', () => {
    const t = buildTable({
      type: 'table', rows: [['A', 'B', 'C'], ['1', '2', '3']],
      spans: [[0, 1, 1, 9], [0, 0, 1, 2], [1, 0, 1, 2], [5, 0, 2, 2]],
    }, para)!
    // [0,1,1,9] 截成跨 2 列后盖住有字的 C；[0,0,1,2] 盖住 B；[1,0,1,2] 盖住「2」；[5,0,…] 起点越界：全部丢弃
    expect(gridOf(t)).toEqual([['A', 'B', 'C'], ['1', '2', '3']])
  })

  it('全空行去掉，但合并区经过的空行保留；整行被跨行合并盖住时退回不合并写法', () => {
    const t = buildTable({ type: 'table', rows: [['A', 'B'], ['', ''], ['x', 'y'], ['', '']], spans: [[2, 0, 2, 1]] }, para)!
    expect(gridOf(t)).toEqual([['A', 'B'], ['x', 'y'], ['^', '']])
    const all = buildTable({ type: 'table', rows: [['A', 'B'], ['', '']], spans: [[0, 0, 2, 1], [0, 1, 2, 1]] }, para)!
    expect(gridOf(all)).toEqual([['A', 'B']])
  })

  it('跨页续表合并时，续表的合并区随行下移；落在被去掉的重复表头里的合并区丢弃', () => {
    const out = mergeContinuedTables([
      BASE,
      { type: 'table', page: 4, header_rows: 1, rows: [BASE.rows[0]!, ['Age', '<65', '30', '0.5'], ['', '≥65', '49', '0.6']], spans: [[0, 1, 1, 2], [1, 0, 2, 1]] },
    ])
    expect(out).toHaveLength(1)
    const merged = out[0] as TableBlock
    expect(merged.rows).toHaveLength(6)
    expect(merged.spans).toEqual([...BASE.spans!, [4, 0, 2, 1]])
    expect(gridOf(buildTable(merged, para)!)[5]).toEqual(['^', '≥65', '49', '0.6'])
  })
})

describe('审稿读表格按逻辑网格对齐列', () => {
  it('表头跨列合并铺到每一列，正文合并单元格只在起始格；列不错位', () => {
    const doc = schema.node('doc', null, [buildTable(BASE, para)!])
    const [s] = extractTableSummaries(doc)
    expect(s!.headers).toEqual(['Characteristic', 'Drug (n = 79)', 'Drug (n = 79)', 'P'])
    expect(s!.rows).toEqual([
      ['', 'Pre', 'Post', ''],
      ['Sex', 'Male', '40', '0.3'],
      ['', 'Female', '39', '0.4'],
    ])
    expect(s!.sample_sizes).toEqual([79])
  })
})
