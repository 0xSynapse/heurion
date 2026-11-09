import { describe, expect, it } from 'vitest'
import { ClaimService } from '../src/claims/service.ts'
import { mergeContinuedTables, type DocParserBlock } from '../src/convert/doc-parser.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { Store } from '../src/store/db.ts'

const HEAD = ['Variable', 'Group A (n=206)', 'Group B (n=206)']

describe('PDF 跨页续表合并', () => {
  it('下一页、列数相同、没有表题的表并进前一张；续页重复的表头去掉；可连续跨多页', () => {
    const blocks: DocParserBlock[] = [
      { type: 'table', rows: [HEAD, ['Age', '62', '61']], header_rows: 1, caption: 'Table 1. Baseline', page: 4 },
      { type: 'table', rows: [HEAD, ['Male', '124', '118']], header_rows: 1, page: 5 },
      { type: 'table', rows: [['Smoker', '98', '102']], header_rows: 0, page: 6 },
    ]
    const out = mergeContinuedTables(blocks)
    expect(out).toHaveLength(1)
    expect(out[0]!.type === 'table' && out[0]!.rows).toEqual([HEAD, ['Age', '62', '61'], ['Male', '124', '118'], ['Smoker', '98', '102']])
  })

  it('不合并：列数不同、隔了一页、同一页、后一张有自己的表题、中间隔着正文', () => {
    const t = (page: number, cols = 3, caption?: string): DocParserBlock => ({ type: 'table', rows: [Array.from({ length: cols }, (_, i) => `c${i}`), Array.from({ length: cols }, () => '1')], header_rows: 1, page, ...(caption ? { caption } : {}) })
    expect(mergeContinuedTables([t(1), t(2, 4)])).toHaveLength(2)
    expect(mergeContinuedTables([t(1), t(3)])).toHaveLength(2)
    expect(mergeContinuedTables([t(1), t(1)])).toHaveLength(2)
    expect(mergeContinuedTables([t(1), t(2, 3, 'Table 2. Outcomes')])).toHaveLength(2)
    expect(mergeContinuedTables([t(1), { type: 'paragraph', text: 'Text', page: 2 }, t(2)])).toHaveLength(3)
  })

  it('表题印在表下方的跨页表：前半张没表题、后半张带表题且没有表头时合并，表题给合并后的表', () => {
    const out = mergeContinuedTables([
      { type: 'table', rows: [HEAD, ['Age', '62', '61']], header_rows: 1, page: 3 },
      { type: 'table', rows: [['Male', '124', '118']], header_rows: 0, caption: 'TABLE 1: Baseline characteristics', page: 4 },
    ])
    expect(out).toHaveLength(1)
    const t = out[0] as Extract<DocParserBlock, { type: 'table' }>
    expect(t.caption).toBe('TABLE 1: Baseline characteristics')
    expect(t.rows).toEqual([HEAD, ['Age', '62', '61'], ['Male', '124', '118']])
    // 后半张有自己的表头：是另一张表
    expect(mergeContinuedTables([
      { type: 'table', rows: [HEAD, ['Age', '62', '61']], header_rows: 1, page: 3 },
      { type: 'table', rows: [HEAD, ['Male', '124', '118']], header_rows: 1, caption: 'TABLE 2: Outcomes', page: 4 },
    ])).toHaveLength(2)
  })

  it('续表之间隔着页眉页脚、「(Continued)」与「Table 1 (continued)」也合并；表格下方的表题归给前一张表', () => {
    const blocks: DocParserBlock[] = [
      { type: 'table', rows: [HEAD, ['Age', '62', '61']], header_rows: 1, page: 5 },
      { type: 'paragraph', text: 'Sakboonyarat et al. Global Heart DOI: 10.5334/gh.1515', page: 5 },
      { type: 'paragraph', text: 'Table 1 Characteristics of study participants.', page: 5 },
      { type: 'paragraph', text: '(Continued)', page: 5 },
      { type: 'heading', level: 2, text: 'TABLE 1 (Continued)', page: 6 },
      { type: 'table', rows: [HEAD, ['Male', '124', '118']], header_rows: 1, page: 6 },
      { type: 'paragraph', text: 'Results continue here.', page: 6 },
    ]
    const out = mergeContinuedTables(blocks)
    expect(out.map(b => b.type)).toEqual(['table', 'paragraph'])
    const t = out[0] as Extract<DocParserBlock, { type: 'table' }>
    expect(t.caption).toBe('Table 1 Characteristics of study participants.')
    expect(t.rows).toEqual([HEAD, ['Age', '62', '61'], ['Male', '124', '118']])
  })

  it('表格下方的表题即使没有续表也只出现一次；续表自带「TABLE 1 Continued」表题照样合并', () => {
    const one = mergeContinuedTables([
      { type: 'table', rows: [HEAD, ['Age', '62', '61']], header_rows: 1, page: 3 },
      { type: 'paragraph', text: 'Table 2 Outcomes by group.', page: 3 },
      { type: 'paragraph', text: 'Body text.', page: 3 },
    ])
    expect(one.map(b => b.type)).toEqual(['table', 'paragraph'])
    expect((one[0] as any).caption).toBe('Table 2 Outcomes by group.')
    const two = mergeContinuedTables([
      { type: 'table', rows: [HEAD, ['Age', '62', '61']], header_rows: 1, caption: 'TABLE 1 Baseline', page: 4 },
      { type: 'table', rows: [HEAD, ['Male', '124', '118']], header_rows: 1, caption: 'TABLE 1 Continued', page: 5 },
    ])
    expect(two).toHaveLength(1)
    expect((two[0] as any).caption).toBe('TABLE 1 Baseline')
  })

  it('表题以 Figure 开头的「表格」是误认成表格的图：只保留图注', () => {
    const out = mergeContinuedTables([{ type: 'table', rows: [['', 'ARD', 'SE'], ['Study A', '0.1', '0.02']], header_rows: 1, caption: 'FIGURE 3 Forest plot of relative risk', page: 9 }])
    expect(out).toEqual([{ type: 'paragraph', text: 'FIGURE 3 Forest plot of relative risk', page: 9 }])
  })
})

describe('审稿读取图注', () => {
  it('图注里的内容交给模型审读', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const content = schema.node('doc', null, [
      schema.node('heading', { level: 2 }, [schema.text('Results')]),
      schema.node('paragraph', null, [schema.text('Survival differed between groups (Figure 1).')]),
      schema.node('figure', { asset_id: 'a1', caption: 'Figure 1. Kaplan–Meier curves; log-rank P = 0.017 (n = 412).' }),
    ])
    const row = docs.create({ owner: 'u', title: 't', content })
    const seen: string[] = []
    await new ClaimService(docs, {} as PubMedClient).runFourStageDeepReview(row.id, {
      mode: 'heurion_evolved', owner: 'u', complete: async (_s, user) => { seen.push(user); return '[]' },
    })
    expect(seen.join('\n')).toContain('log-rank P = 0.017 (n = 412)')
  })
})
