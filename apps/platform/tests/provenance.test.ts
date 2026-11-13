/**
 * 来源等级第 1 期（docs/design/PROVENANCE.md）：服务端维护文字的 AI 来源标记、读取记录持久化、已有文档回填。
 */
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { serializeBlocks } from '../src/model/markdown.ts'
import { aiSpans, hasAiText } from '../src/model/provenance.ts'
import { OpService } from '../src/ops/service.ts'
import { resolveSuggestions } from '../src/ops/suggest.ts'
import { ids, setup } from './helpers.ts'

const SAMPLE = `# 结果

在 120 名患者中，pCR 率为 37%。

本研究提示新辅助治疗可能有效。`

/** 块里被标为 AI 的文字（拼成一串，便于断言）。 */
const aiText = (block: PMNode) => aiSpans(block).map(s => s.text).join('|')
const blockById = (doc: PMNode, id: string) => { let found: PMNode | undefined; doc.descendants(n => { if (n.attrs.id === id) found = n; return !found }); return found! }

describe('来源标记：AI 写入', () => {
  it('人写的原文没有标记；AI 片段替换只标新写入的词', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, p1] = ids(docs, docId)
    expect(hasAiText(docs.get(docId))).toBe(false)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: 'pCR 率为 37%', replace: '病理完全缓解率为 37%' }] }, { actor: 'ai', turnId: 't1' })
    const block = blockById(docs.get(docId), p1!)
    expect(aiText(block)).toBe('病理完全缓解')
    expect(aiSpans(block)[0]!.turn).toBe('t1')
  })

  it('AI 用 Markdown 整段替换自己的文字：没改的 AI 文字仍是 AI（不会被洗成人写的），人写的仍是人', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, p1, p2] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: p2!, markdown: 'These findings warrant a phase 3 trial.' }] }, { actor: 'ai', turnId: 't1' })
    const added = ids(docs, docId).find(id => ![p1, p2].includes(id) && blockById(docs.get(docId), id)?.textContent.includes('phase 3'))!
    expect(aiText(blockById(docs.get(docId), added))).toBe('These findings warrant a phase 3 trial.')
    ops.edit({ doc_id: docId, base_rev: docs.rev(docId), mode: 'apply', ops: [{ op: 'replace_block', id: added, markdown: 'These findings warrant a larger phase 3 trial.' }] }, { actor: 'ai', turnId: 't2' })
    const spans = aiSpans(blockById(docs.get(docId), added))
    expect(spans.map(s => s.text).join('')).toBe('These findings warrant a larger phase 3 trial.')
    // 原有的词保留第一轮的回合，新词记第二轮
    expect(spans.some(s => s.turn === 't1') && spans.some(s => s.turn === 't2' && s.text.includes('larger'))).toBe(true)
    // 人写的段落不受影响
    expect(hasAiText(blockById(docs.get(docId), p1!))).toBe(false)
  })

  it('Markdown 读视图与导出不带来源标记', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, p1] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '120 名患者', replace: '120 名可评估患者' }] }, { actor: 'ai', turnId: 't1' })
    const blocks: PMNode[] = []
    docs.get(docId).forEach(n => blocks.push(n))
    const md = serializeBlocks(blocks)
    expect(md).toContain('120 名可评估患者')
    expect(md).not.toMatch(/prov|span/)
  })
})

describe('来源标记：人的修改', () => {
  it('人在 AI 文字中间改的词变成人写的，其余 AI 文字不变', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, , p2] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p2!, markdown: 'These results suggest neoadjuvant therapy is effective.' }] }, { actor: 'ai', turnId: 't1' })
    expect(aiText(blockById(docs.get(docId), p2!))).toBe('These results suggest neoadjuvant therapy is effective.')
    ops.edit({ doc_id: docId, base_rev: docs.rev(docId), mode: 'apply', ops: [{ op: 'replace_text', id: p2!, find: 'is effective', replace: 'may be effective' }] }, { actor: 'user', turnId: null })
    const block = blockById(docs.get(docId), p2!)
    expect(block.textContent).toBe('These results suggest neoadjuvant therapy may be effective.')
    expect(aiText(block)).not.toContain('may')
    expect(aiText(block)).toContain('neoadjuvant therapy')
  })

  it('浏览器里在 AI 文字中间打字（编辑器会继承标记）：落库时去掉新输入文字的 AI 标记', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, p1] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p1!, markdown: 'Among 120 patients, the pCR rate was 37%.' }] }, { actor: 'ai', turnId: 't1' })
    // 模拟编辑器：在 AI 文字中间插入一个词，新字继承了 prov 标记
    const doc = docs.get(docId)
    const block = blockById(doc, p1!)
    let pos = -1
    doc.descendants((n, p) => { if (n.attrs.id === p1) pos = p; return pos < 0 })
    const prov = block.firstChild!.marks
    const inner = pos + 1 + 'Among 120 '.length
    const typed = doc.type.schema.text('evaluable ', prov)
    const next = doc.replace(inner, inner, new Slice(Fragment.from(typed), 0, 0))
    docs.commit(docId, next, { actor: 'user', turnId: null, ops: [{ op: 'collab' }] })
    const after = blockById(docs.get(docId), p1!)
    expect(after.textContent).toBe('Among 120 evaluable patients, the pCR rate was 37%.')
    expect(aiText(after)).not.toContain('evaluable')
    expect(aiText(after)).toContain('patients')
  })

  it('人采纳 AI 的修订 = 确认：采纳后的文字没有 AI 标记', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, , p2] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'suggest', ops: [{ op: 'replace_block', id: p2!, markdown: 'Neoadjuvant therapy appears effective in this cohort.' }] }, { actor: 'ai', turnId: 't1' })
    expect(hasAiText(docs.get(docId))).toBe(true)
    const accepted = resolveSuggestions(docs.get(docId), null, true)
    docs.commit(docId, accepted, { actor: 'user', turnId: null, ops: [{ op: 'accept_suggestion', group: null }] })
    expect(docs.get(docId).textContent).toContain('appears effective')
    expect(hasAiText(docs.get(docId))).toBe(false)
  })

  it('撤销 AI 回合与恢复版本原样写回，不按写者重打标记', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, p1] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '37%', replace: '37%（11/30）' }] }, { actor: 'ai', turnId: 't1' })
    docs.snapshot(docId, 'user', '保存')
    const seq = docs.store.latestVersion(docId)!.seq
    ops.edit({ doc_id: docId, base_rev: docs.rev(docId), mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '120', replace: '一百二十' }] }, { actor: 'user', turnId: null })
    docs.restore(docId, seq)
    expect(aiText(blockById(docs.get(docId), p1!))).toContain('（11/30）')
  })
})

describe('读取记录持久化', () => {
  it('AI 读过的版本存在数据库里：换一个 OpService（模拟服务重启）冲突守卫照样按读取记录判断', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, p1, p2] = ids(docs, docId)
    ops.noteSeen(docId, ids(docs, docId), 0)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '37%', replace: '36.7%' }] }, { actor: 'user', turnId: null })
    ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: p2!, find: '可能', replace: '或许' }] }, { actor: 'ai', turnId: null })
    const restarted = new OpService(docs)
    expect(() => restarted.edit({ doc_id: docId, base_rev: docs.rev(docId), mode: 'apply', ops: [{ op: 'replace_block', id: p1!, markdown: '在 120 名患者中，pCR 率为 37%。' }] }, { actor: 'ai', turnId: null })).toThrow(/用户修改过/)
    expect(docs.store.aiReadRev(docId, p1!)).toBe(docs.rev(docId))
  })
})

describe('已有文档回填', () => {
  it('只回填由 AI 新建、之后没被人改过的块；人改过的 AI 块和人写的块不动', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, p1, p2] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: p2!, markdown: '第一段 AI 新写的讨论。' }, { op: 'insert_after', anchor_id: p2!, markdown: '第二段 AI 新写的讨论。' }] }, { actor: 'ai', turnId: 't-old' })
    const added = ids(docs, docId).filter(id => ![p1, p2].includes(id) && /AI 新写/.test(blockById(docs.get(docId), id)?.textContent ?? ''))
    expect(added).toHaveLength(2)
    const [a1, a2] = added.sort((x, y) => blockById(docs.get(docId), x).textContent.localeCompare(blockById(docs.get(docId), y).textContent))
    // 人改过第二段
    ops.edit({ doc_id: docId, base_rev: docs.rev(docId), mode: 'apply', ops: [{ op: 'replace_text', id: a2!, find: '讨论', replace: '讨论（已核对）' }] }, { actor: 'user', turnId: null })
    // 模拟上线前的旧文档：去掉全部来源标记（system 写入不重打标记）
    const stripped = docs.get(docId).type.schema.nodeFromJSON(JSON.parse(JSON.stringify(docs.get(docId).toJSON()).replace(/\{"type":"prov","attrs":\{[^}]*\}\},?/g, '').replace(/,\]/g, ']').replace(/"marks":\[\],?/g, '')))
    docs.commit(docId, stripped, { actor: 'system', turnId: null, ops: [{ op: 'test_strip' }] })
    expect(hasAiText(docs.get(docId))).toBe(false)

    expect(docs.backfillProvenance(docId)).toBe(1)
    expect(aiText(blockById(docs.get(docId), a1!))).toBe('第一段 AI 新写的讨论。')
    expect(aiSpans(blockById(docs.get(docId), a1!))[0]!.turn).toBe('t-old')
    expect(hasAiText(blockById(docs.get(docId), a2!))).toBe(false)
    expect(hasAiText(blockById(docs.get(docId), p1!))).toBe(false)
    // 再跑一次不重复提交
    const rev = docs.rev(docId)
    docs.backfillProvenance(docId)
    expect(docs.rev(docId)).toBe(rev)
  })
})
