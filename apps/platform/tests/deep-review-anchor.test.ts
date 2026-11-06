import { describe, expect, it } from 'vitest'
import { ClaimService } from '../src/claims/service.ts'
import { locate } from '../src/model/anchors.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'

describe('审稿批注锚点', () => {
  it('LLM 给出完整原句时，批注锚定完整句子而不是截断到 60 字', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const sentence = '本研究纳入 120 例患者并采用多因素回归分析评估预后因素，结果显示高表达组与低表达组之间的总生存期存在显著差异，且该差异在调整年龄、性别与分期后仍然稳定存在。'
    const row = docs.create({ owner: 'u1', title: '审稿锚点', markdown: `# 结果\n\n${sentence}` })
    const p1 = docs.get(row.id).lastChild!.attrs.id as string
    const claims = new ClaimService(docs, {} as PubMedClient)
    const complete = async () => JSON.stringify([{
      node_id: p1,
      sentence,
      category: 'method_result_mismatch',
      severity: 'major',
      reason: '统计方法与结果报告的指标不一致。',
      suggestion: '请核对统计方法并统一报告指标。',
    }])

    await claims.runFourStageDeepReview(row.id, { mode: 'heurion_deep', complete, anchorComments: true })
    const comment = store.listComments(row.id).find(c => c.snippet === sentence)
    expect(comment).toBeDefined()
    expect(locate(docs.get(row.id), comment!).text).toBe(sentence)
  })
})
