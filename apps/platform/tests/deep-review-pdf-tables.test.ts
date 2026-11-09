import { describe, expect, it } from 'vitest'
import { ClaimService, TABLES_UNRELIABLE_WARNING } from '../src/claims/service.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'

// 正文样本量 412 与表头 N=200 不一致（表格可靠时应报出），表格单元格 50 (40%) 按 N=200 算也不对
const MD = `# 稿件

## Results

We enrolled 412 patients in total (Table 1).

Table 1. Baseline characteristics

| Variable | Group A (n=200) |
|---|---|
| Male, n (%) | 50 (40%) |
`

function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const row = docs.create({ owner: 'u', title: '稿件', markdown: MD })
  return { store, docs, row, claims: new ClaimService(docs, {} as PubMedClient) }
}

describe('PDF 走 poppler 兜底导入时的深度审稿', () => {
  it('表格可靠时照常做表格核查，没有提示', async () => {
    const t = setup()
    const r = await t.claims.runFourStageDeepReview(t.row.id, { mode: 'heurion_evolved', owner: 'u' })
    const subtypes = r.stage4_deduplicated_comments.map(c => c.subtype)
    expect(subtypes).toContain('prose_table_sample_size_mismatch')
    expect(subtypes).toContain('table_cell_percentage_arithmetic_error')
    expect(r.warnings).toEqual([])
  })

  it('表格不可靠时跳过一切依赖表格的核查，模型输入里也没有表格内容，并返回提示', async () => {
    const t = setup()
    const prompts: string[] = []
    const complete = async (sys: string, user: string) => { prompts.push(`${sys}\n${user}`); return '[]' }
    const r = await t.claims.runFourStageDeepReview(t.row.id, { mode: 'heurion_evolved', owner: 'u', tablesUnreliable: true, complete })
    const subtypes = r.stage4_deduplicated_comments.map(c => c.subtype)
    expect(subtypes).not.toContain('prose_table_sample_size_mismatch')
    expect(subtypes).not.toContain('table_cell_percentage_arithmetic_error')
    expect(r.scratchpad.table_sample_sizes).toEqual([])
    expect(r.warnings).toEqual([TABLES_UNRELIABLE_WARNING])
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.join('\n')).not.toContain('50 (40%)')
    expect(prompts.join('\n')).toContain('结构不可靠')
  })

  it('导入记录：保存 PDF 的解析路径；旧数据没有记录时为 null', () => {
    const t = setup()
    t.store.putPackage(t.row.id, 'pdf', new Uint8Array([1]), 'poppler')
    expect(t.store.getImportInfo(t.row.id)).toEqual({ kind: 'pdf', import_engine: 'poppler' })
    t.store.putPackage(t.row.id, 'docx', new Uint8Array([1]))
    expect(t.store.getImportInfo(t.row.id)).toEqual({ kind: 'docx', import_engine: null })
    expect(t.store.getImportInfo('不存在')).toBeNull()
  })
})
