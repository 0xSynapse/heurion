import { describe, expect, it } from 'vitest'
import { ClaimService } from '../src/claims/service.ts'
import { assessTablesWithVision, gridsAgree, numbersFaithful, parseGrid, type TableVision } from '../src/claims/table-vision.ts'
import type { TableSummary } from '../src/claims/extract.ts'
import { unrotateBox } from '../src/convert/pdf-crop.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'

// 审稿按页面图像核对表格（docs/design/PDF_ORIGINAL_VIEW.md §12.3）

const IMG = [{ mime: 'image/png' as const, data: 'AAAA' }]

function summary(headers: string[], rows: string[][], caption = 'Table 1. Baseline'): TableSummary {
  return { node_id: 't1', caption, headers, rows, sample_sizes: [], numbers: [] }
}

/** 表格模型把两行并成了一行、表注混进了表格（按文字规则判为不可信）；页面上实际是两行 */
const MERGED = summary(['Variable', 'Group A (n=200)'], [['Male Female', '50 (40%) 150 (75%)'], ['Age', '62'], ['Abbreviations: n, number', '']])
const PAGE = [['Variable', 'Group A (n=200)'], ['Male', '50 (40%)'], ['Female', '150 (75%)'], ['Age', '62']]
const PAGE_WORDS = ['Variable', 'Group', 'A', '(n=200)', 'Male', '50', '(40%)', 'Female', '150', '(75%)', 'Age', '62']

function vision(reply: string | Error, words = PAGE_WORDS): TableVision & { calls: number } {
  const v = {
    calls: 0,
    source: async () => ({ images: IMG, words }),
    complete: async () => { v.calls++; if (reply instanceof Error) throw reply; return reply },
  }
  return v
}

describe('按页面图像核对表格', () => {
  it('解析模型抄出的网格：容忍代码块、补空格、去掉空行；格式不对返回 null', () => {
    expect(parseGrid('```json\n{"header_rows": 1, "rows": [["A", "B"], [" 1 ", null], ["", ""]]}\n```')).toEqual({ rows: [['A', 'B'], ['1', '']], headerRows: 1 })
    expect(parseGrid('没有表格')).toBeNull()
    expect(parseGrid('{"rows": [["only one row"]]}')).toBeNull()
  })

  it('抄出的数字要在文字层里：认错的数字拉低比例（按出现次数，统一千分位写法）', () => {
    expect(numbersFaithful(PAGE, PAGE_WORDS)).toBe(1)
    expect(numbersFaithful([['1,234', '5']], ['1,234', '5'])).toBe(1)
    expect(numbersFaithful([['Male', '58 (40%)']], PAGE_WORDS)).toBe(0.5)
    expect(numbersFaithful([['62', '62']], ['62'])).toBe(0.5)
  })

  it('网格比较只看表头以下；空白、短横写法不同算相同', () => {
    expect(gridsAgree([['A', 'B'], ['x', '1–2']], [['A merged', ''], ['x', '1 - 2']])).toBe(true)
    expect(gridsAgree([['A', 'B'], ['x', '1']], [['A', 'B'], ['x', '1'], ['y', '2']])).toBe(false)
  })

  it('与转换结果一致：确认可信，照常核查（即使按文字规则原本不可信）', async () => {
    const v = vision(JSON.stringify({ header_rows: 1, rows: [MERGED.headers, ...MERGED.rows] }))
    const r = await assessTablesWithVision([MERGED], v)
    expect(r.verified).toBe(1)
    expect(r.tables[0]).toBe(MERGED)
    expect(r.skipped).toEqual([])
  })

  it('不一致且数字都对得上文字层：改用图像识别的表格，并说明', async () => {
    const r = await assessTablesWithVision([MERGED], vision(JSON.stringify({ header_rows: 1, rows: PAGE })))
    expect(r.reread).toEqual(['Table 1. Baseline'])
    expect(r.tables[0]!.rows).toEqual(PAGE.slice(1))
    expect(r.tables[0]!.sample_sizes).toEqual([200])
    expect(r.tables[0]!.grid_rows).toBeUndefined()
  })

  it('抄错数字、调用失败、没有图像时：退回按文字规则判断（不可信的表跳过）', async () => {
    const wrong = PAGE.map(row => row.map(c => c.replace('50', '58')))
    for (const v of [vision(JSON.stringify({ rows: wrong })), vision(new Error('timeout')), null]) {
      const r = await assessTablesWithVision([MERGED], v)
      expect(r.tables).toEqual([])
      expect(r.skipped).toHaveLength(1)
      expect(r.reread).toEqual([])
    }
  })

  it('最多核对 max 张；按文字规则不可信的表优先', async () => {
    const good = { ...summary(['Variable', 'n'], [['Age', '62']], 'Table 2. Other'), node_id: 't2' }
    const seen: string[] = []
    const v: TableVision = {
      max: 1,
      source: async id => { seen.push(id); return { images: IMG, words: PAGE_WORDS } },
      complete: async () => JSON.stringify({ rows: PAGE }),
    }
    await assessTablesWithVision([good, MERGED], v)
    expect(seen).toEqual(['t1'])
  })

  it('竖排页转正后的坐标换回原文件方向（裁图用）', () => {
    // 原页 600 × 800（竖），转正时顺时针加了 90°，映射里的页是 800 × 600
    const page = { w: 800, h: 600, rot: 90 }
    // 原页上 (100, 200)–(300, 250) 的框，顺时针转 90° 后是 (H - y, x)：(550, 100)–(600, 300)
    expect(unrotateBox([550, 100, 600, 300], page)).toEqual([100, 200, 300, 250])
    expect(unrotateBox([10, 20, 30, 40], { w: 600, h: 800 })).toEqual([10, 20, 30, 40])
    // 逆时针（270）：转正后是 (y, W - x)
    expect(unrotateBox([200, 300, 250, 500], { w: 800, h: 600, rot: 270 })).toEqual([100, 200, 300, 250])
  })
})

describe('深度审稿接上图像核对', () => {
  it('转换稿的表格并错了行：按图像识别的表格核查出百分比错误，并给出说明', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const md = `# 稿件\n\n## Results\n\nTable 1. Baseline\n\n| Variable | Group A (n=200) |\n|---|---|\n| Male Female | 50 (40%) 150 (75%) |\n| Age | 62 |\n| Abbreviations: n, number | |\n`
    const row = docs.create({ owner: 'u', title: '稿件', markdown: md })
    const claims = new ClaimService(docs, {} as PubMedClient)
    const v = vision(JSON.stringify({ header_rows: 1, rows: PAGE }))
    const tableId = (() => { let id = ''; docs.get(row.id).descendants(n => { if (n.type.name === 'table') id = n.attrs.id; return !id }); return id })()
    v.source = async id => (id === tableId ? { images: IMG, words: PAGE_WORDS } : null)
    const r = await claims.runFourStageDeepReview(row.id, { mode: 'heurion_evolved', owner: 'u', assessTables: true, tableVision: v })
    expect(v.calls).toBe(1)
    expect(r.warnings.some(w => w.includes('按页面图像重新识别'))).toBe(true)
    // 50/200 = 25% ≠ 40%：转换稿里这一格是「50 (40%) 150 (75%)」，不按图像识别就核查不出来
    expect(r.stage4_deduplicated_comments.some(c => c.subtype === 'table_cell_percentage_arithmetic_error' && c.snippet === '50 (40%)')).toBe(true)
  })
})
