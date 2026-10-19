import { describe, expect, it } from 'vitest'
import { ids, setup } from './helpers.ts'

describe('Layer 1: Task-Level Probe (validate & dry-run)', () => {
  it('validate 预检合法操作：返回 valid=true，且不改变文档 rev 与内容', () => {
    const { docs, ops, docId } = setup('# 标题\n\n第一段内容')
    const [h1, p1] = ids(docs, docId)
    const revBefore = docs.rev(docId)

    const res = ops.validate({
      doc_id: docId,
      base_rev: revBefore,
      mode: 'apply',
      ops: [{ op: 'replace_text', id: p1!, find: '第一段', replace: '修改后的第一段' }],
    }, { actor: 'ai', turnId: 't1' })

    expect(res.valid).toBe(true)
    expect(res.code).toBeUndefined()
    // 文档 rev 与内容不受影响
    expect(docs.rev(docId)).toBe(revBefore)
    expect(docs.get(docId).textContent).toContain('第一段内容')
    expect(docs.get(docId).textContent).not.toContain('修改后的第一段')
  })

  it('validate 遇守卫拦截（如用户修改冲突）：返回 valid=false 及结构化 hint，不抛出异常', () => {
    const { docs, ops, docId } = setup('# 标题\n\n第一段内容')
    const [h1, p1] = ids(docs, docId)
    const baseRev = docs.rev(docId)

    // 用户改动 p1 块，使版本递增
    ops.edit({
      doc_id: docId,
      base_rev: baseRev,
      mode: 'apply',
      ops: [{ op: 'replace_block', id: p1!, markdown: '用户改过的段落' }],
    }, { actor: 'user', turnId: null })

    const newRev = docs.rev(docId)
    expect(newRev).toBeGreaterThan(baseRev)

    // AI 尝试以旧 baseRev 整体替换 p1（触发 conflict_user_edited）
    const res = ops.validate({
      doc_id: docId,
      base_rev: baseRev,
      mode: 'apply',
      ops: [{ op: 'replace_block', id: p1!, markdown: 'AI 欲覆盖的内容' }],
    }, { actor: 'ai', turnId: 't2' })

    expect(res.valid).toBe(false)
    expect(res.code).toBe('conflict_user_edited')
    expect(res.hint).toContain('以 current 为准重新决定改法')
    expect(res.current).toBeDefined()
  })

  it('validate 遇未登记引用：返回 valid=false 与 citation_not_registered 错误码', () => {
    const { docs, ops, docId } = setup('# 标题\n\n第一段内容')
    const [h1, p1] = ids(docs, docId)

    const res = ops.validate({
      doc_id: docId,
      base_rev: docs.rev(docId),
      mode: 'apply',
      ops: [{ op: 'replace_text', id: p1!, find: '第一段内容', replace: '包含未登记引用 10.1056/NEJMoa0000000' }],
    }, { actor: 'ai', turnId: 't3' })

    expect(res.valid).toBe(false)
    expect(res.code).toBe('citation_not_registered')
    expect(res.hint).toContain('insert_citation')
  })

  it('doc_edit 支持 dry_run 试探预检：不提交改动', () => {
    const { docs, ops, docId } = setup('# 标题\n\n第一段内容')
    const [h1, p1] = ids(docs, docId)
    const revBefore = docs.rev(docId)

    const res = ops.edit({
      doc_id: docId,
      base_rev: revBefore,
      mode: 'apply',
      dry_run: true,
      ops: [{ op: 'replace_text', id: p1!, find: '第一段', replace: '预检测试' }],
    }, { actor: 'ai', turnId: 't4' })

    expect(res.rev).toBe(revBefore)
    expect(res.changes).toHaveLength(0)
    expect(docs.rev(docId)).toBe(revBefore)
    expect(docs.get(docId).textContent).toContain('第一段内容')
  })
})
