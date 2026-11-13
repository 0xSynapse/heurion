/**
 * 来源等级第 4 期（docs/design/PROVENANCE.md 4.5、6.2）：分析结果登记与绑定、来源证明、AI 使用声明。
 */
import { describe, expect, it } from 'vitest'
import { MeasurementService } from '../src/measurements/service.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { formatMeasure } from '../src/model/measurements.ts'
import { aiDisclosure, provenanceProof } from '../src/model/provenance-report.ts'
import { confirmBlocks } from '../src/model/provenance.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { OpService } from '../src/ops/service.ts'
import { ResultError, registerResult } from '../src/research/results.ts'
import { Store } from '../src/store/db.ts'

const SAMPLE = `# 结果

多因素分析显示，年龄与生存相关。

# 讨论

本研究提示新辅助治疗可能有效。`

function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs, undefined, undefined, { provenance: true })
  const row = docs.create({ owner: 'u1', title: '测试稿件', content: schema.node('doc', null, parseBlocks(SAMPLE)) })
  const ids: string[] = []
  docs.get(row.id).forEach(n => ids.push(n.attrs.id as string))
  return { store, docs, ops, docId: row.id, ids, measures: new MeasurementService(store, null) }
}

describe('P 值显示', () => {
  it('小于 0.001 写「<0.001」，其余三位小数', () => {
    expect(formatMeasure(0.0004, 'pval', 3)).toBe('<0.001')
    expect(formatMeasure(0.032, 'pval', 3)).toBe('0.032')
    expect(formatMeasure(0.5, 'pval', 3)).toBe('0.500')
  })
})

describe('分析结果登记', () => {
  it('AI 登记的数值必须在本轮分析输出里出现过（可四舍五入）', () => {
    const { store, docId } = setup()
    const reg = (values: Record<string, number>, observe: string | null = 't1') => registerResult(store, { owner: 'u1', name: 'OS Cox · 年龄', method: 'Cox 回归', values, doc_id: docId, via: 'ai', observe })
    expect(() => reg({ estimate: 1.42 }, null)).toThrow(ResultError)
    expect(() => reg({ estimate: 1.42 })).toThrow(/找不到/)
    store.addObservedNumbers('t1', [1.4213, 1.08, 1.87, 0.0123, 312])
    const r = reg({ estimate: 1.42, ci_low: 1.08, ci_high: 1.87, p_value: 0.012, n: 312 })
    expect(r.version).toBe(1)
    // 同名再登记、数值不变：版本不变；变了：版本 +1
    expect(reg({ estimate: 1.42, ci_low: 1.08, ci_high: 1.87, p_value: 0.012, n: 312 }).version).toBe(1)
    store.addObservedNumbers('t1', [1.39])
    expect(reg({ estimate: 1.39, ci_low: 1.08, ci_high: 1.87, p_value: 0.012, n: 312 }).version).toBe(2)
  })

  it('用户本人登记不要求观察记录；不认识的统计量拒绝', () => {
    const { store } = setup()
    expect(registerResult(store, { owner: 'u1', name: '手工结果', values: { estimate: 2.1 }, via: 'user' }).values).toEqual({ estimate: 2.1 })
    expect(() => registerResult(store, { owner: 'u1', name: 'x', values: { hr: 2.1 }, via: 'user' })).toThrow(/不认识/)
  })

  it('绑定进稿件：重新分析后数字随之更新；别人看不到当前值只看快照', () => {
    const { store, docs, docId, measures } = setup()
    const r = registerResult(store, { owner: 'u1', name: 'OS Cox · 年龄', values: { estimate: 1.42, p_value: 0.0004 }, via: 'user' })
    const doc = docs.store.getDoc(docId)!
    const hr = measures.bind({ userId: 'u1', via: 'ai', space: 'work' }, doc, { source: 'analysis_result', source_id: r.id, field: 'estimate' })
    const p = measures.bind({ userId: 'u1', via: 'ai', space: 'work' }, doc, { source: 'analysis_result', source_id: r.id, field: 'p_value' })
    expect(hr.view.text).toBe('1.42')
    expect(p.view.text).toBe('<0.001')
    registerResult(store, { owner: 'u1', name: 'OS Cox · 年龄', values: { estimate: 1.39, p_value: 0.0004 }, via: 'user' })
    expect(measures.views(doc, { userId: 'u1', via: 'user', space: 'work' }).get(hr.row.id)!.text).toBe('1.39')
    const other = measures.views(doc, { userId: 'u2', via: 'user', space: 'work' }).get(hr.row.id)!
    expect(other.status).toBe('no_access')
    expect(other.text).toBe('1.42')
  })
})

describe('来源证明与 AI 使用声明', () => {
  it('统计 AI 改过的段落、确认情况、AI 新增的引用与证据、绑定数字', () => {
    const { store, docs, ops, docId, ids, measures } = setup()
    const cite = store.upsertCitation({ doc_id: docId, doi: '10.1000/neo', pmid: null, formatted: 'NEO trial', url: null })
    store.putAbstract('10.1000/neo', null, 'Neoadjuvant chemoradiotherapy improved overall survival in esophageal squamous cell carcinoma.')
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: ids[3]!, markdown: `Neoadjuvant chemoradiotherapy improved overall survival in esophageal squamous cell carcinoma [@c:${cite.id}].` }] }, { actor: 'ai', turnId: 'turn-a', observe: null })
    const r = registerResult(store, { owner: 'u1', name: 'OS Cox · 年龄', values: { estimate: 1.42 }, via: 'user' })
    const m = measures.bind({ userId: 'u1', via: 'ai', space: 'work' }, store.getDoc(docId)!, { source: 'analysis_result', source_id: r.id, field: 'estimate' })
    ops.edit({ doc_id: docId, base_rev: docs.rev(docId), mode: 'apply', ops: [{ op: 'insert_after', anchor_id: ids[1]!, markdown: `年龄的 HR 为 [@m:${m.row.id}]。` }] }, { actor: 'ai', turnId: 'turn-b', observe: null })

    const view = () => measures.views(store.getDoc(docId)!, { userId: 'u1', via: 'user', space: 'work' })
    let proof = provenanceProof(store, docId, docs.get(docId), view())
    expect(proof.summary).toMatchObject({ ai_touched_blocks: 2, ai_touched_confirmed: 0, ai_unconfirmed_blocks: 2, citations_added_by_ai: 1, citations_abstract_only: 1, analysis_bound_numbers: 1, ai_turns: 2 })
    expect(proof.ai_touched.map(a => a.section).sort()).toEqual(['结果', '讨论'])
    expect(proof.numbers[0]).toMatchObject({ text: '1.42', source_kind: 'analysis_result' })
    let zh = aiDisclosure(proof, 'zh')
    expect(zh).toContain('2 个段落，其中 0 段已由作者逐段审阅确认，2 段尚未逐段确认')
    expect(zh).toContain('AI 补充了 1 条参考文献')
    expect(zh).toContain('1 个统计数字直接绑定到分析结果')
    expect(zh).not.toContain('均已经作者审阅确认')

    // 全部确认后：声明里写明已确认
    const { doc } = confirmBlocks(docs.get(docId), null)
    docs.commit(docId, doc, { actor: 'system', turnId: null, ops: [{ op: 'confirm_text', node_ids: 'all' }] })
    proof = provenanceProof(store, docId, docs.get(docId), view())
    expect(proof.summary).toMatchObject({ ai_touched_confirmed: 2, ai_unconfirmed_blocks: 0, confirmations: 1 })
    zh = aiDisclosure(proof, 'zh')
    expect(zh).toContain('均已经作者审阅确认')
    expect(aiDisclosure(proof, 'en')).toContain('reviewed and confirmed by the authors')
  })

  it('没用过 AI 的稿件', () => {
    const { store, docs, docId } = setup()
    const proof = provenanceProof(store, docId, docs.get(docId), new Map())
    expect(aiDisclosure(proof, 'zh')).toBe('本文写作过程中未使用 AI 生成或修改正文内容。作者对全文内容负责。')
  })
})
