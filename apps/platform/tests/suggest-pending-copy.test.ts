import { describe, expect, it } from 'vitest'
import { docxFor } from '../src/convert/exports.ts'
import { pendingGroups, resolveSuggestions, withoutPending } from '../src/ops/suggest.ts'
import { OpError } from '../src/ops/types.ts'
import { read } from '../src/views/read.ts'
import { ids, setup } from './helpers.ts'

const AI = { actor: 'ai' as const, turnId: null }
type Doc = ReturnType<ReturnType<typeof setup>['docs']['get']>
const tables = (doc: Doc) => { const o: Array<{ id: string; text: string; suggest: string | null }> = []; doc.forEach(n => { if (n.type.name === 'table') o.push({ id: n.attrs.id as string, text: n.textContent, suggest: n.attrs.suggest as string | null }) }); return o }
const errOf = (fn: () => unknown) => { try { fn() } catch (e) { return e as OpError } return null }

describe('修订版与原文版：后续修改并入同一条修订（生产事故：申报书表格重复）', () => {
  function tableSuggested() {
    const t = setup('前言。\n\n| 项 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\n结尾。')
    const table = ids(t.docs, t.docId)[1]!
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'suggest', ops: [{ op: 'table_set_cells', id: table, cells: [{ row: 1, col: 1, markdown: '10' }] }] }, AI)
    const copy = tables(t.docs.get(t.docId)).find(x => x.suggest === 'insert')!.id
    return { ...t, table, copy }
  }

  it('改原文版（待删除）的表格：拦下并指向修订版', () => {
    const t = tableSuggested()
    const err = errOf(() => t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'suggest', ops: [{ op: 'table_set_cells', id: t.table, cells: [{ row: 2, col: 1, markdown: '20' }] }] }, AI))
    expect(err?.code).toBe('pending_suggestion')
    expect(JSON.stringify(err)).toContain(t.copy)
    expect(tables(t.docs.get(t.docId))).toHaveLength(2)
  })

  it('改原文版表格里的段落（祖先待删除）也拦下', () => {
    const t = tableSuggested()
    let cell = ''
    t.docs.get(t.docId).child(1).descendants(n => { if (!cell && n.type.name === 'paragraph' && n.textContent === 'b') cell = n.attrs.id as string; return !cell })
    expect(cell).not.toBe('')
    const err = errOf(() => t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'suggest', ops: [{ op: 'replace_text', id: cell, find: 'b', replace: 'B' }] }, AI))
    expect(err?.code).toBe('pending_suggestion')
  })

  it('改修订版：并入同一条修订，不再复制出第三份；采纳得到两处改动，拒绝回到原表', () => {
    const t = tableSuggested()
    t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'suggest', ops: [{ op: 'table_set_cells', id: t.copy, cells: [{ row: 2, col: 1, markdown: '20' }] }] }, AI)
    const doc = t.docs.get(t.docId)
    expect(tables(doc).map(x => x.suggest)).toEqual(['delete', 'insert'])
    expect(pendingGroups(doc)).toHaveLength(1)
    const accepted = tables(resolveSuggestions(doc, null, true))
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.text).toContain('10')
    expect(accepted[0]!.text).toContain('20')
    for (const d of [resolveSuggestions(doc, null, false), withoutPending(doc)]) {
      const r = tables(d)
      expect(r).toHaveLength(1)
      expect(r[0]!.text).toBe('项值a1b2')
    }
  })

  it('删掉还没采纳的新增段落：直接消失，不留待删除的残块', () => {
    const t = setup('甲段。\n\n乙段。')
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'suggest', ops: [{ op: 'insert_after', anchor_id: ids(t.docs, t.docId)[0]!, markdown: '新增段。' }] }, AI)
    const added = ids(t.docs, t.docId)[1]!
    t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'suggest', ops: [{ op: 'delete', ids: [added] }] }, AI)
    const texts: string[] = []
    t.docs.get(t.docId).forEach(n => texts.push(n.textContent))
    expect(texts).toEqual(['甲段。', '乙段。'])
    expect(pendingGroups(t.docs.get(t.docId))).toHaveLength(0)
  })
})

describe('章节与修订', () => {
  const md = '# 一、现状\n\n现状正文。\n\n# 二、方案\n\n方案正文。'

  it('节内有待采纳修订时整节替换被拒，不会产生两份正文', () => {
    const t = setup(md)
    const [h1, p1] = ids(t.docs, t.docId)
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'suggest', ops: [{ op: 'replace_text', id: p1!, find: '现状', replace: '国内现状' }] }, AI)
    const err = errOf(() => t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'suggest', ops: [{ op: 'replace_block', id: h1!, markdown: '# 一、国内外现状\n\n新正文。' }] }, AI))
    expect(err?.code).toBe('pending_suggestion')
  })

  it('标题在修订里时按章节读，仍读到正文', () => {
    const t = setup(md)
    const [h1] = ids(t.docs, t.docId)
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'suggest', ops: [{ op: 'replace_text', id: h1!, find: '现状', replace: '国内外现状' }] }, AI)
    const view = read({ doc: t.docs.get(t.docId), docId: t.docId, rev: 1, comments: [], section_id: h1! })
    expect(view).toContain('现状正文。')
    expect(view).not.toContain('方案正文。')
  })
})

describe('导出', () => {
  it('有待采纳修订时导出给出提醒', () => {
    const t = setup('甲段。')
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'suggest', ops: [{ op: 'replace_text', id: ids(t.docs, t.docId)[0]!, find: '甲', replace: '乙' }] }, AI)
    expect(docxFor(t.docs, t.docId).warnings[0]).toContain('1 条待采纳修订')
  })
})
