import { describe, expect, it } from 'vitest'
import { ClaimService } from '../src/claims/service.ts'
import { assessTablesWithVision, gridsAgree, numbersFaithful, parseGrid, type TableVision } from '../src/claims/table-vision.ts'
import type { TableSummary } from '../src/claims/extract.ts'
import { unrotateBox } from '../src/convert/pdf-crop.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'

// 审稿按页面图像核对表格（docs/design/PDF_ORIGINAL_VIEW.md §12.3）：图像只用来确认，不替换转换结果

const IMG = [{ mime: 'image/png' as const, data: 'AAAA' }]

function summary(headers: string[], rows: string[][], caption = 'Table 1. Baseline'): TableSummary {
  return { node_id: 't1', caption, headers, rows, sample_sizes: [], numbers: [] }
}

/** 表头是年份（首行大半是数字），按文字规则判为不可信；其实表格是对的 */
const YEARS = summary(['Variable', '2019 (n=200)', '2020 (n=100)'], [['Male, n (%)', '50 (40%)', '30 (30%)'], ['Age', '62', '61']])
const YEARS_GRID = [YEARS.headers, ...YEARS.rows]
const YEARS_WORDS = ['Variable', '2019', '(n=200)', '2020', '(n=100)', 'Male,', 'n', '(%)', '50', '(40%)', '30', '(30%)', 'Age', '62', '61']

function vision(reply: string | Error, words = YEARS_WORDS): TableVision & { calls: number } {
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

  it('表头文字折行被拆成两行时并回一行；真正的第二层表头（上一行空着的列）不并', () => {
    const wrapped = parseGrid(JSON.stringify({ header_rows: 2, rows: [['Variables', 'Control Arm', 'p'], ['', '(n = 30)', ''], ['Age', '54.7', '0.8']] }))
    expect(wrapped).toEqual({ rows: [['Variables', 'Control Arm (n = 30)', 'p'], ['Age', '54.7', '0.8']], headerRows: 1 })
    const twoLevel = parseGrid(JSON.stringify({ header_rows: 2, rows: [['', 'Overuse', ''], ['', 'n', 'HR (95% CI)'], ['BMQ', '449', '0.91']] }))
    expect(twoLevel!.headerRows).toBe(2)
  })

  it('抄出的数字要在文字层里：认错的数字拉低比例（按出现次数，统一千分位写法）', () => {
    expect(numbersFaithful(YEARS_GRID, YEARS_WORDS)).toBe(1)
    expect(numbersFaithful([['1,234', '5']], ['1,234', '5'])).toBe(1)
    expect(numbersFaithful([['Male', '58 (40%)']], ['50', '(40%)'])).toBe(0.5)
    expect(numbersFaithful([['62', '62']], ['62'])).toBe(0.5)
  })

  it('网格比较不看表头：按图像的第一行表体对齐；空白、短横写法不同算相同', () => {
    expect(gridsAgree([['A', 'B'], ['x', '1–2']], [['A merged', ''], ['x', '1 - 2']])).toBe(true)
    // 转换结果是两层表头、图像把表头并成了一层：表体对得上就算一致
    expect(gridsAgree([['', 'Overuse'], ['', 'n'], ['BMQ', '449'], ['Sex', '']], [['', 'Overuse n'], ['BMQ', '449'], ['Sex', '']])).toBe(true)
    expect(gridsAgree([['A', 'B'], ['x', '1']], [['A', 'B'], ['x', '1'], ['y', '2']])).toBe(false)
    // 相邻两列并成一格（列数不同）：不一致
    expect(gridsAgree([['A', 'B', 'C'], ['x', '1', '2']], [['A', 'B C'], ['x', '1 2']])).toBe(false)
  })

  it('与图像一致：确认可信，按文字规则原本不可信的表也照常核查', async () => {
    const v = vision(JSON.stringify({ header_rows: 1, rows: YEARS_GRID }))
    const r = await assessTablesWithVision([YEARS], v)
    expect(r.verified).toBe(1)
    expect(r.tables[0]).toBe(YEARS)
    expect(r.skipped).toEqual([])
  })

  it('不一致、抄错数字、调用失败、没有图像时：按文字规则判断（不可信的表跳过），不改用图像抄出的表', async () => {
    const shifted = [YEARS.headers, ['Male, n (%)', '50 (40%) 30 (30%)', ''], ['Age', '62', '61']]
    const wrong = YEARS_GRID.map(row => row.map(c => c.replace('50', '58')))
    for (const v of [vision(JSON.stringify({ rows: shifted })), vision(JSON.stringify({ rows: wrong })), vision(new Error('timeout')), null]) {
      const r = await assessTablesWithVision([YEARS], v)
      expect(r.tables).toEqual([])
      expect(r.skipped).toHaveLength(1)
      expect(r.verified).toBe(0)
    }
    // 按文字规则可信的表：不一致也照常核查（用转换结果）
    const good = summary(['Variable', 'n'], [['Age', '62']])
    const r = await assessTablesWithVision([good], vision(JSON.stringify({ rows: [['Variable', 'n'], ['Age', '63']] }), ['Variable', 'n', 'Age', '62', '63']))
    expect(r.tables).toEqual([good])
  })

  it('最多核对 max 张；按文字规则不可信的表优先', async () => {
    const good = { ...summary(['Variable', 'n'], [['Age', '62']], 'Table 2. Other'), node_id: 't2' }
    const seen: string[] = []
    const v: TableVision = {
      max: 1,
      source: async id => { seen.push(id); return { images: IMG, words: YEARS_WORDS } },
      complete: async () => JSON.stringify({ rows: YEARS_GRID }),
    }
    await assessTablesWithVision([good, YEARS], v)
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
  const md = `# 稿件\n\n## Results\n\nTable 1. Baseline\n\n| Variable | 2019 (n=200) | 2020 (n=100) |\n|---|---|---|\n| Male, n (%) | 50 (40%) | 30 (30%) |\n| Age | 62 | 61 |\n`

  async function review(withVision: boolean) {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const row = docs.create({ owner: 'u', title: '稿件', markdown: md })
    const claims = new ClaimService(docs, {} as PubMedClient)
    const v = vision(JSON.stringify({ header_rows: 1, rows: YEARS_GRID }))
    const r = await claims.runFourStageDeepReview(row.id, { mode: 'heurion_evolved', owner: 'u', assessTables: true, ...(withVision ? { tableVision: v } : {}) })
    return { r, calls: v.calls }
  }

  it('按文字规则不可信、但与页面图像一致的表：照常核查，查出百分比错误', async () => {
    const { r, calls } = await review(true)
    expect(calls).toBe(1)
    expect(r.warnings).toEqual([])
    // 50/200 = 25% ≠ 40%
    expect(r.stage4_deduplicated_comments.some(c => c.subtype === 'table_cell_percentage_arithmetic_error' && c.snippet === '50 (40%)')).toBe(true)
  })

  it('没有图像核对时同一张表被跳过并提示', async () => {
    const { r } = await review(false)
    expect(r.warnings.some(w => w.includes('未能可靠识别'))).toBe(true)
    expect(r.stage4_deduplicated_comments.some(c => c.subtype === 'table_cell_percentage_arithmetic_error')).toBe(false)
  })
})
