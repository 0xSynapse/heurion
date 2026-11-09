import { describe, expect, it } from 'vitest'
import { ClaimService } from '../src/claims/service.ts'
import { assessTableTrust } from '../src/claims/table-trust.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'

const HEAD = ['Variable', 'Drug (n = 30)', 'Placebo (n = 30)', 'P']

describe('逐表判断表格结构是否可信', () => {
  it('正常表格可信：n (%)、均值 ± 标准差、置信区间、P 值', () => {
    expect(assessTableTrust({
      headers: HEAD,
      rows: [['Male', '15 (50%)', '18 (60%)', '0.436'], ['Age', '61.2 ± 8.1', '59.9 ± 9.0', '<0.001'], ['OR', '1.93 (1.10-3.38)', '', '0.02']],
    })).toEqual({ reliable: true, reasons: [] })
  })

  it('首行大半是数字：表头丢失或方向识别反了', () => {
    const r = assessTableTrust({ headers: ['p value', '0.022', '0.007', '0.278'], rows: [['OR', '1.9', '2.4', '1.4']] })
    expect(r.reliable).toBe(false)
    expect(r.reasons[0]).toContain('首行')
  })

  it('一格挤着几个数字：多行被识别成一行', () => {
    const r = assessTableTrust({ headers: HEAD, rows: [['Colon Rectal', '12 0', '15 0', ''], ['II III IV', '1 7 4', '2 6 7', '0.241']] })
    expect(r.reliable).toBe(false)
    expect(r.reasons[0]).toContain('挤着多个数字')
  })

  it('数值格粘着行标签文字；表注混进单元格；只有一行或一列', () => {
    expect(assessTableTrust({ headers: HEAD, rows: [['Anemia G1', 'and 2 26 (86.7%)', '27 (90%)', '1.00'], ['', 'G3 and 4 4 (13.3%)', '3 (10%)', '']] }).reasons[0])
      .toContain('行标签')
    expect(assessTableTrust({ headers: HEAD, rows: [['Age', '61', '60', '0.3'], ['Abbreviations: OR, odds ratio', '', '', '']] }).reasons[0])
      .toContain('表注')
    expect(assessTableTrust({ headers: ['FIGURE 3 Short-term pain relief'], rows: [] }).reasons[0]).toContain('一行或一列')
  })
})

// 两张表：Table 1 正常（表头 N=200，50 (40%) 算错），Table 2 识别坏了（几行挤在一格）
const MD = `# 稿件

## Results

We enrolled 412 patients in total (Table 1).

Table 1. Baseline characteristics

| Variable | Group A (n=200) |
|---|---|
| Male, n (%) | 50 (40%) |

Table 2. Cancer stage

| Variable | Group B (n=150) |
|---|---|
| II III IV | 1 7 4 |
| Colon Rectal | 12 0 |
`

function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const row = docs.create({ owner: 'u', title: '稿件', markdown: MD })
  return { row, claims: new ClaimService(docs, {} as PubMedClient) }
}

describe('Docling 导入的 PDF：审稿逐表判断', () => {
  it('只跳过不可信的表：可信表照常核查，不可信表不进规则核查和模型输入，并提示是哪张表', async () => {
    const t = setup()
    const prompts: string[] = []
    const complete = async (sys: string, user: string) => { prompts.push(`${sys}\n${user}`); return '[]' }
    const r = await t.claims.runFourStageDeepReview(t.row.id, { mode: 'heurion_evolved', owner: 'u', assessTables: true, complete })
    const subtypes = r.stage4_deduplicated_comments.map(c => c.subtype)
    expect(subtypes).toContain('table_cell_percentage_arithmetic_error')
    expect(r.scratchpad.table_sample_sizes).toEqual([200])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('1 张表格')
    expect(r.warnings[0]).toContain('Table 2. Cancer stage')
    const all = prompts.join('\n')
    expect(all).toContain('50 (40%)')
    expect(all).not.toContain('1 7 4')
  })

  it('全部表格都不可信时，规则核查不会回头从文档重新提取表格', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const row = docs.create({ owner: 'u', title: '稿件', markdown: MD.replace('| Male, n (%) | 50 (40%) |', '| Male | 50 40 |\n| Female | 150 60 |') })
    const r = await new ClaimService(docs, {} as PubMedClient).runFourStageDeepReview(row.id, { mode: 'heurion_evolved', owner: 'u', assessTables: true })
    const subtypes = r.stage4_deduplicated_comments.map(c => c.subtype)
    expect(subtypes).not.toContain('prose_table_sample_size_mismatch')
    expect(r.scratchpad.table_sample_sizes).toEqual([])
    expect(r.warnings[0]).toContain('2 张表格')
  })

  it('不开启逐表判断（Word 稿）时所有表格照常使用', async () => {
    const t = setup()
    const r = await t.claims.runFourStageDeepReview(t.row.id, { mode: 'heurion_evolved', owner: 'u' })
    expect(r.warnings).toEqual([])
    expect(r.scratchpad.table_sample_sizes.sort()).toEqual([150, 200])
  })
})
