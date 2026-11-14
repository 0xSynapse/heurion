/**
 * 修订决定卡（docs/design/PROTECTION_RESOLUTION.md 第一步）：AI 的修改因合作者待采纳的修订被拦下时，
 * 错误附上这条修订的信息；用户确认「采纳」后，平台以用户身份采纳，再以 AI 身份重新提交（仍经全部守卫）。
 */
import type { Node as PMNode } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { parseBlocks } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { acceptRevisionAndRetry, remapRevisionIds, type RevisionFollowup } from '../src/ops/revision-decision.ts'
import { OpService } from '../src/ops/service.ts'
import { OpError, type EditBatch } from '../src/ops/types.ts'
import { Store } from '../src/store/db.ts'

const SAMPLE = `# 结果

在 120 名患者中，pCR 率为 37%，R0 切除率为 97%。

本研究提示新辅助治疗可能有效。`

/** 第二段变成合作者「Li Ming」的待采纳修订对（与导入 Word 修订后的结构相同） */
function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs, undefined, undefined, { provenance: true })
  const row = docs.create({ owner: 'u1', title: '测试', content: schema.node('doc', null, parseBlocks(SAMPLE)) })
  const doc = docs.get(row.id)
  const para = doc.child(1)
  const orig = para.type.create({ ...para.attrs, suggest: 'delete', suggest_group: 'gx', suggest_author: 'Li Ming' }, para.content)
  const rev = para.type.create({ ...para.attrs, id: 'revx', suggest: 'insert', suggest_group: 'gx', suggest_of: para.attrs.id, suggest_author: 'Li Ming' }, schema.text('在 120 名患者中，pCR 率为 37%，R0 切除率为 97%（意向性人群）。'))
  const content: PMNode[] = []
  doc.forEach((n, _o, i) => { if (i === 1) content.push(orig, rev); else content.push(n) })
  docs.commit(row.id, doc.type.create(doc.attrs, content), { actor: 'user', turnId: null, ops: [] })
  return { store, docs, ops, docId: row.id, originalId: para.attrs.id as string }
}

const AI = { actor: 'ai' as const, turnId: 't1', observe: 't1' }
const errOf = (fn: () => unknown) => { try { fn() } catch (e) { if (e instanceof OpError) return e; throw e } return null }
const blocks = (doc: PMNode) => { const o: Array<{ id: string; text: string; suggest: string | null; author: string | null }> = []; doc.forEach(n => o.push({ id: n.attrs.id as string, text: n.textContent, suggest: n.attrs.suggest as string | null, author: n.attrs.suggest_author as string | null })); return o }

function blocked(t: ReturnType<typeof setup>, batch: EditBatch) {
  const err = errOf(() => t.ops.edit(batch, AI))
  expect(err).not.toBeNull()
  const resolution = err!.extra.resolution!
  const followup: RevisionFollowup = { kind: 'revision_decision', decision: resolution, batch, meta: { turnId: 't1', observe: 't1', answering: null } }
  return { err: err!, followup }
}

describe('修订决定卡', () => {
  it('规则一要转建议、但段落里有合作者修订：错误附上这条修订（组、作者、原文版本与修订版 id）', () => {
    const t = setup()
    const { err } = blocked(t, { doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply', ops: [{ op: 'replace_text', id: 'revx', find: '在 120 名患者中', replace: '在全部可评估的 120 名患者中，按方案人群分析结果提示' }] })
    expect(err.code).toBe('coauthor_revision_pending')
    expect(err.extra.resolution).toEqual({ kind: 'revision_decision', group: 'gx', author: 'Li Ming', original_id: t.originalId, revision_id: 'revx' })
  })

  it('改原文版本被拦时同样附上修订信息（能找到修订版 id）', () => {
    const t = setup()
    const { err } = blocked(t, { doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply', ops: [{ op: 'replace_block', id: t.originalId, markdown: '改写的一段。' }] })
    expect(err.code).toBe('pending_suggestion')
    expect(err.extra.resolution?.revision_id).toBe('revx')
  })

  it('确认后：以用户身份采纳导师的修订，再按 AI 的修改重新提交；AI 的改动成为 AI 自己的建议，不记到导师名下', () => {
    const t = setup()
    const { followup } = blocked(t, { doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply', ops: [{ op: 'replace_text', id: 'revx', find: '在 120 名患者中', replace: '在全部可评估的 120 名患者中，按方案人群分析结果提示' }] })
    const out = acceptRevisionAndRetry({ docs: t.docs, ops: t.ops }, 'u1', followup)
    expect(out.accepted).toBeGreaterThan(0)
    expect(out.retry.ok).toBe(true)
    if (out.retry.ok) expect(out.retry.mode).toBe('suggest')
    const after = blocks(t.docs.get(t.docId))
    // 导师的修订已采纳（不再挂着）；剩下的待采纳修订是 AI 的
    expect(after.some(b => b.author === 'Li Ming')).toBe(false)
    const ins = after.find(b => b.suggest === 'insert')!
    expect(ins.text).toContain('全部可评估的')
    expect(ins.text).toContain('（意向性人群）')
    const del = after.find(b => b.suggest === 'delete')!
    expect(del.id).toBe(t.originalId)
    expect(del.text).toContain('（意向性人群）')
  })

  it('AI 当时改的是原文版本（整段重写）：采纳后重新提交被冲突守卫拦下，不会冲掉导师的修订', () => {
    const t = setup()
    const { followup } = blocked(t, { doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply', ops: [{ op: 'replace_block', id: t.originalId, markdown: '改写的一段，没有导师加的限定。' }] })
    const out = acceptRevisionAndRetry({ docs: t.docs, ops: t.ops }, 'u1', followup)
    expect(out.accepted).toBeGreaterThan(0)
    expect(out.retry).toMatchObject({ ok: false, code: 'conflict_user_edited' })
    const para = blocks(t.docs.get(t.docId)).find(b => b.id === t.originalId)!
    expect(para.text).toContain('（意向性人群）')
    expect(para.suggest).toBeNull()
  })

  it('重新提交仍经全部检查：没有出处的数字照样被拦', () => {
    const t = setup()
    const { followup } = blocked(t, { doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'suggest', ops: [{ op: 'replace_text', id: 'revx', find: '97%', replace: '98.5%' }] })
    const out = acceptRevisionAndRetry({ docs: t.docs, ops: t.ops }, 'u1', followup)
    expect(out.retry).toMatchObject({ ok: false, code: 'unobserved_number' })
  })

  it('修订已被用户处理过：不重复采纳，仍按映射后的 id 重新提交', () => {
    const t = setup()
    const { followup } = blocked(t, { doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'suggest', ops: [{ op: 'replace_text', id: 'revx', find: '在 120 名患者中', replace: '在全部 120 名患者中' }] })
    const first = acceptRevisionAndRetry({ docs: t.docs, ops: t.ops }, 'u1', followup)
    expect(first.accepted).toBeGreaterThan(0)
    const second = acceptRevisionAndRetry({ docs: t.docs, ops: t.ops }, 'u1', followup)
    expect(second.accepted).toBe(0)
  })

  it('id 映射：字段值与 markdown 里的 {#id} 都换掉，别的文字不动', () => {
    const ops = [{ op: 'replace_block', id: 'revx', markdown: '见 {#revx}，revx 不变' }]
    expect(remapRevisionIds(ops, 'revx', 'p1')).toEqual([{ op: 'replace_block', id: 'p1', markdown: '见 {#p1}，revx 不变' }])
  })
})
