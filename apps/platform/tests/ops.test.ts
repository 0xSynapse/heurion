import { describe, expect, it } from 'vitest'
import { attachComment } from '../src/model/anchors.ts'
import { parseBlocks, serializeBlocks } from '../src/model/markdown.ts'
import { schema } from '../src/model/schema.ts'
import { OpError } from '../src/ops/types.ts'
import { outline, read } from '../src/views/read.ts'
import { exportMarkdown } from '../src/views/render.ts'
import { ids, setup } from './helpers.ts'

const SAMPLE = `# 引言

心力衰竭是**常见**疾病。

## 方法

- 第一项
- 第二项

| 指标 | 值 |
| --- | --- |
| HR | 0.8 |`

function expectOpError(fn: () => unknown, code: string): OpError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(OpError)
    expect((err as OpError).code).toBe(code)
    return err as OpError
  }
  throw new Error(`expected OpError ${code}`)
}

describe('markdown 方言', () => {
  it('读视图 markdown 往返：结构与格式保留，{#id} 前缀被忽略', () => {
    const doc = schema.node('doc', null, parseBlocks(SAMPLE))
    const blocks: ReturnType<typeof schema.node>[] = []
    doc.forEach(n => blocks.push(n))
    const md = serializeBlocks(blocks)
    expect(md).toContain('**常见**')
    expect(md).toContain('| HR | 0.8 |')
    const again = schema.node('doc', null, parseBlocks(md.replace('# 引言', '{#h1aa} # 引言').replace('心力衰竭', '{#abcd} 心力衰竭')))
    expect(again.textContent).toBe(doc.textContent)
  })

  it('引用标记解析为原子节点', () => {
    const [p] = parseBlocks('见文献[@c:c1234567]。')
    expect(p!.child(1).type.name).toBe('citation')
    expect(p!.child(1).attrs.cite_id).toBe('c1234567')
  })
})

describe('doc_edit 操作', () => {
  it('insert_after / replace_text / delete / move', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [h1, p1, h2] = ids(docs, docId)
    const r1 = ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'insert_after', anchor_id: p1!, markdown: '新增段落一。\n\n新增段落二。' },
      { op: 'replace_text', id: p1!, find: '常见', replace: '高发' },
    ] }, { actor: 'ai', turnId: null })
    expect(r1.rev).toBe(1)
    expect(r1.results[0]!.ids).toHaveLength(2)
    const text = docs.get(docId).textContent
    expect(text).toContain('心力衰竭是高发疾病')
    expect(text).toContain('新增段落二')
    // 替换继承原格式（粗体）
    const p = docs.get(docId).child(1)
    expect(p.child(1).marks.map(m => m.type.name)).toEqual(['bold'])

    const added = r1.results[0]!.ids
    ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [
      { op: 'move', ids: [added[1]!], after: h1! },
      { op: 'delete', ids: [h2!] },
    ] }, { actor: 'ai', turnId: null })
    const now = ids(docs, docId)
    expect(now[1]).toBe(added[1])
    expect(now).not.toContain(h2)
  })

  it('批次原子：一个 op 失败则整批不生效', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const before = docs.get(docId)
    const [, p1] = ids(docs, docId)
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'replace_text', id: p1!, find: '常见', replace: '高发' },
      { op: 'delete', ids: ['nope'] },
    ] }, { actor: 'ai', turnId: null }), 'node_not_found')
    expect(docs.get(docId).eq(before)).toBe(true)
    expect(docs.rev(docId)).toBe(0)
  })

  it('replace_text：找不到时返回当前原文；多处匹配要求 occurrence', () => {
    const { docs, ops, docId } = setup('甲乙甲乙')
    const [p] = ids(docs, docId)
    const e = expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '丙', replace: 'x' }] }, { actor: 'ai', turnId: null }), 'text_not_found')
    expect(String(e.extra.current)).toContain('甲乙甲乙')
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '甲', replace: 'x' }] }, { actor: 'ai', turnId: null }), 'ambiguous_match')
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '甲', replace: 'x', occurrence: 2 }] }, { actor: 'ai', turnId: null })
    expect(docs.get(docId).textContent).toBe('甲乙x乙')
  })

  it('列表与表格操作', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const doc = docs.get(docId)
    const list = doc.child(3)
    const item = list.child(0).attrs.id as string
    const table = doc.child(4).attrs.id as string
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'insert_after', anchor_id: item, markdown: '- 插入项' },
      { op: 'table_set_cells', id: table, cells: [{ row: 1, col: 1, markdown: '**0.75**' }] },
      { op: 'table_insert_rows', id: table, at: 2, rows: [['LVEF', '35%']] },
    ] }, { actor: 'ai', turnId: null })
    const after = docs.get(docId)
    expect(after.child(3).childCount).toBe(3)
    expect(after.child(3).child(1).textContent).toBe('插入项')
    expect(after.child(4).childCount).toBe(3)
    expect(after.child(4).textContent).toContain('0.75')
  })

  it('表格增删列：单列表格加一列后可写第二列；按逻辑列处理合并单元格；不能删光', () => {
    const { docs, ops, docId } = setup('| 项目 |\n| --- |\n| 甲 |')
    const table = docs.get(docId).child(0).attrs.id as string
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'table_insert_cols', id: table, at: 1, cells: ['说明'] },
      { op: 'table_set_cells', id: table, cells: [{ row: 1, col: 1, markdown: '乙' }] },
    ] }, { actor: 'ai', turnId: null })
    let t = docs.get(docId).child(0)
    expect(t.child(0).childCount).toBe(2)
    expect(t.child(0).child(1).textContent).toBe('说明')
    expect(t.child(0).child(1).attrs.header).toBe(true)
    expect(t.child(1).child(1).textContent).toBe('乙')

    ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [{ op: 'table_insert_cols', id: table, at: 0 }] }, { actor: 'ai', turnId: null })
    t = docs.get(docId).child(0)
    expect(t.child(1).textContent).toBe('甲乙')
    expect(t.child(1).childCount).toBe(3)

    ops.edit({ doc_id: docId, base_rev: 2, mode: 'apply', ops: [{ op: 'table_delete_cols', id: table, at: 0, count: 2 }] }, { actor: 'ai', turnId: null })
    t = docs.get(docId).child(0)
    expect(t.child(1).textContent).toBe('乙')
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 3, mode: 'apply', ops: [{ op: 'table_delete_cols', id: table, at: 0, count: 1 }] }, { actor: 'ai', turnId: null }), 'invalid_structure')
  })

  it('表格增删列：合并单元格内插列加宽、删列收窄；含跨行合并时拒绝', () => {
    // 首行前两格合并（colspan=2）：| a(2列) | c |，第二行 | 1 | 2 | 3 |
    const [base] = parseBlocks('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |')
    const withSpan = (rowspan: number) => {
      const r0 = base!.child(0)
      const merged = r0.child(0).type.create({ ...r0.child(0).attrs, colspan: 2, rowspan }, r0.child(0).content)
      const r1 = rowspan > 1 ? base!.child(1).type.create(null, [base!.child(1).child(2)]) : base!.child(1)
      return base!.type.create(base!.attrs, [r0.type.create(r0.attrs, [merged, r0.child(2)]), r1])
    }
    const { docs, ops } = setup()
    const d2 = docs.create({ owner: 'u1', title: 't', content: schema.node('doc', null, [withSpan(1)]) }).id
    const table = docs.get(d2).child(0).attrs.id as string
    ops.edit({ doc_id: d2, base_rev: 0, mode: 'apply', ops: [{ op: 'table_insert_cols', id: table, at: 1 }] }, { actor: 'ai', turnId: null })
    let t = docs.get(d2).child(0)
    expect(t.child(0).child(0).attrs.colspan).toBe(3)
    expect(t.child(0).childCount).toBe(2)
    expect(t.child(1).childCount).toBe(4)
    ops.edit({ doc_id: d2, base_rev: 1, mode: 'apply', ops: [{ op: 'table_delete_cols', id: table, at: 0, count: 2 }] }, { actor: 'ai', turnId: null })
    t = docs.get(d2).child(0)
    expect(t.child(0).child(0).attrs.colspan).toBe(1)
    expect(t.child(1).textContent).toBe('23')

    const row3 = docs.create({ owner: 'u1', title: 't', content: schema.node('doc', null, [withSpan(2)]) })
    const t3 = docs.get(row3.id).child(0).attrs.id as string
    expectOpError(() => ops.edit({ doc_id: row3.id, base_rev: 0, mode: 'apply', ops: [{ op: 'table_insert_cols', id: t3, at: 1 }] }, { actor: 'ai', turnId: null }), 'invalid_structure')
  })

  it('结构守卫：不能在列表项后插入标题', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const item = docs.get(docId).child(3).child(0).attrs.id as string
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: item, markdown: '# 标题' }] }, { actor: 'ai', turnId: null }), 'invalid_structure')
  })
})

describe('守卫', () => {
  it('冲突：用户在 base_rev 之后改过的块，AI 不能整块改；用户改不受限', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, p1, , p2] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '常见', replace: '少见' }] }, { actor: 'user', turnId: null })
    const e = expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p1!, markdown: '心力衰竭是高发疾病。' }] }, { actor: 'ai', turnId: null }), 'conflict_user_edited')
    expect(JSON.stringify(e.extra.current)).toContain('少见')
    // 别的块不受影响；用新 rev 后可以改
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p2!, markdown: '- 改写项' }] }, { actor: 'ai', turnId: null })
    ops.edit({ doc_id: docId, base_rev: 2, mode: 'apply', ops: [{ op: 'replace_block', id: p1!, markdown: '心力衰竭是高发疾病。' }] }, { actor: 'ai', turnId: null })
    expect(docs.get(docId).textContent).toContain('高发')
  })

  it('replace_text 以原文为守卫：旧 rev 也能改（原文还在），原文被用户改掉则匹配不上', () => {
    const { docs, ops, docId } = setup(SAMPLE)
    const [, p1] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '心力衰竭', replace: '心衰' }] }, { actor: 'user', turnId: null })
    // 用户改的是别的字：AI 按原文改仍然成功
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '常见', replace: '高发' }] }, { actor: 'ai', turnId: null })
    expect(docs.get(docId).child(1).textContent).toBe('心衰是高发疾病。')
    // 用户改掉的原文：匹配不上，返回当前内容供重读
    const e = expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '心力衰竭', replace: 'HF' }] }, { actor: 'ai', turnId: null }), 'text_not_found')
    expect(JSON.stringify(e.extra.current)).toContain('心衰')
  })

  it('引用：DOI、手写参考文献、未登记的 cite_id 被拒绝', () => {
    const { store, docs, ops, docId } = setup(SAMPLE)
    const [, p1] = ids(docs, docId)
    const edit = (markdown: string) => () => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: p1!, markdown }] }, { actor: 'ai', turnId: null })
    expectOpError(edit('见 doi:10.1056/NEJMoa1409077。'), 'citation_not_registered')
    expectOpError(edit('1. McMurray JJ, Packer M, et al. Angiotensin-neprilysin inhibition. N Engl J Med. 2014;371:993-1004.'), 'citation_not_registered')
    expectOpError(edit('见文献[@c:cnotreal]。'), 'citation_unknown')
    const c = store.upsertCitation({ doc_id: docId, doi: '10.1056/nejmoa1409077', pmid: null, formatted: 'McMurray JJ. ...', url: null })
    edit(`PARADIGM-HF 显示获益[@c:${c.id}]。`)()
    expect(exportMarkdown(docs.get(docId), store.listCitations(docId))).toContain('获益[1]')
  })

  it('锚点：被锚定的文字全部被改掉、或整块删除，需要 ack', () => {
    const { store, docs, ops, docId } = setup(SAMPLE)
    const [, p1] = ids(docs, docId)
    const comment = store.addComment({ doc_id: docId, node_id: p1!, snippet: '常见' })
    const anchored = attachComment(docs.get(docId), p1!, '常见', comment.id)
    docs.commit(docId, anchored.doc, { actor: 'user', turnId: null, ops: [] })
    store.addReply(comment.id, 'user', '这里改成具体发病率')
    // 被锚定的两个字全被换掉：锚点消失，拦下
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '常见', replace: '约 2% 成人罹患的' }] }, { actor: 'ai', turnId: null }), 'anchor_has_open_comments')
    // 删除整段：同样必须 ack
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [{ op: 'delete', ids: [p1!] }] }, { actor: 'ai', turnId: null }), 'anchor_has_open_comments')
    ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ack_comments: [comment.id], ops: [{ op: 'delete', ids: [p1!] }] }, { actor: 'ai', turnId: null })
  })
})

describe('评论锚点：最小 diff 下的跟随（与 Claude Docs 一致）', () => {
  function withComment(text: string, snippet: string) {
    const env = setup(text)
    const [p1] = ids(env.docs, env.docId)
    const c = env.store.addComment({ doc_id: env.docId, node_id: p1!, snippet })
    env.docs.commit(env.docId, attachComment(env.docs.get(env.docId), p1!, snippet, c.id).doc, { actor: 'user', turnId: null, ops: [] })
    const anchored = () => [...env.docs.get(env.docId).child(0).content.content].filter(n => n.marks.some(m => m.type.name === 'comment')).map(n => n.text).join('')
    return { ...env, p1: p1!, comment: c, anchored }
  }

  it('保留原文再补充：锚点精确保留，无需 ack', () => {
    const t = withComment('司美格鲁肽是 GLP-1 受体激动剂。', 'GLP-1 受体激动剂')
    t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: t.p1, find: 'GLP-1 受体激动剂。', replace: 'GLP-1 受体激动剂，每周皮下注射一次。' }] }, { actor: 'ai', turnId: null })
    expect(t.anchored()).toBe('GLP-1 受体激动剂')
  })

  it('部分改写：锚点收缩到保留下来的字，不随替换扩张', () => {
    const t = withComment('心衰很常见。', '很常见')
    t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: t.p1, find: '很常见。', replace: '很少见。' }] }, { actor: 'ai', turnId: null })
    expect(t.docs.get(t.docId).child(0).textContent).toBe('心衰很少见。')
    expect(t.anchored()).toBe('很见')
  })

  it('被锚定的文字整体改写：普通回合被拦下；正在回答这条评论的回合重新锚定到整段', () => {
    const t = withComment('心衰很常见。', '很常见')
    const op = { op: 'replace_text' as const, id: t.p1, find: '很常见。', replace: '约影响 2% 的成人。' }
    expectOpError(() => t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [op] }, { actor: 'ai', turnId: null }), 'anchor_has_open_comments')
    t.ops.edit({ doc_id: t.docId, base_rev: 1, mode: 'apply', ops: [op] }, { actor: 'ai', turnId: null, answering: t.comment.id })
    expect(t.anchored()).toBe('心衰约影响 2% 的成人。')
    expect(t.store.getComment(t.docId, t.comment.id)!.status).toBe('open')
  })

  it('正在回答的评论不豁免别的评论', () => {
    const t = withComment('心衰很常见。', '很常见')
    const other = t.store.addComment({ doc_id: t.docId, node_id: t.p1, snippet: '心衰' })
    t.docs.commit(t.docId, attachComment(t.docs.get(t.docId), t.p1, '心衰', other.id).doc, { actor: 'user', turnId: null, ops: [] })
    expectOpError(() => t.ops.edit({ doc_id: t.docId, base_rev: 2, mode: 'apply', ops: [{ op: 'replace_block', id: t.p1, markdown: 'HF 约影响 2% 的成人。' }] }, { actor: 'ai', turnId: null, answering: t.comment.id }), 'anchor_has_open_comments')
  })
})

describe('replace_text 匹配', () => {
  it('最小 diff：只改变化的字，格式与引用保留', () => {
    const { store, docs, ops, docId } = setup('占位。')
    const c = store.upsertCitation({ doc_id: docId, doi: '10.1056/x', pmid: null, formatted: 'x', url: null })
    const [p] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p!, markdown: `心衰是**常见**疾病[@c:${c.id}]，预后差。` }] }, { actor: 'user', turnId: null })
    ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [
      { op: 'replace_text', id: p!, find: '是常见疾病', replace: '是常见慢性疾病' },
      { op: 'replace_text', id: p!, find: '预后差', replace: '预后较差' },
    ] }, { actor: 'ai', turnId: null })
    const node = docs.get(docId).child(0)
    expect(node.textContent).toBe('心衰是常见慢性疾病，预后较差。')
    let bold = '', cites = 0
    node.forEach(n => { if (n.marks.some(m => m.type.name === 'bold')) bold += n.text; if (n.type.name === 'citation') cites++ })
    expect(bold).toBe('常见')
    expect(cites).toBe(1)
  })

  it('多处匹配：拒绝并列出每处上下文；带 occurrence 即可改指定一处', () => {
    const { docs, ops, docId } = setup('风险降低，死亡风险降低。')
    const [p] = ids(docs, docId)
    const e = expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '风险降低', replace: '风险下降' }] }, { actor: 'ai', turnId: null }), 'ambiguous_match')
    expect((e.extra.current as { matches: unknown[] }).matches).toHaveLength(2)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '风险降低', replace: '风险下降', occurrence: 2 }] }, { actor: 'ai', turnId: null })
    expect(docs.get(docId).child(0).textContent).toBe('风险降低，死亡风险下降。')
  })

  it('大小写不同：唯一时回退为不区分大小写匹配', () => {
    const { docs, ops, docId } = setup('The SELECT trial enrolled patients.')
    const [p] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: 'select trial', replace: 'SELECT 试验' }] }, { actor: 'ai', turnId: null })
    expect(docs.get(docId).child(0).textContent).toBe('The SELECT 试验 enrolled patients.')
  })

  it('空白不一致：不猜，返回近似候选', () => {
    const { docs, ops, docId } = setup('HR 0.80 (95% CI 0.72-0.90).')
    const [p] = ids(docs, docId)
    const e = expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: 'HR  0.80', replace: 'HR 0.81' }] }, { actor: 'ai', turnId: null }), 'text_not_found')
    expect(JSON.stringify((e.extra.current as { near: unknown[] }).near)).toContain('HR 0.80')
    expect(docs.get(docId).child(0).textContent).toBe('HR 0.80 (95% CI 0.72-0.90).')
  })
})

describe('评论锚点颗粒度（doc）', () => {
  it('段落内的文字可锚定（大小写不敏感回退）；跨块、不在块内的文字拒绝', async () => {
    const { AnchorError } = await import('../src/model/anchors.ts')
    const { docs, docId } = setup(SAMPLE)
    const doc = docs.get(docId)
    const [, p1, , list] = ids(docs, docId)
    expect(attachComment(doc, p1!, '常见疾病', 'c1').snippet).toBe('常见疾病')
    expect(() => attachComment(doc, p1!, '常见疾病\n\n方法', 'c2')).toThrow(AnchorError)
    expect(() => attachComment(doc, p1!, '第一项', 'c3')).toThrow(AnchorError)
    // 非文本块（列表）只能整块评论
    expect(() => attachComment(doc, list!, '第一项', 'c4')).toThrow(AnchorError)
    const whole = attachComment(doc, list!, '', 'c5').doc
    let marked = ''
    whole.descendants(n => { if (n.isText && n.marks.some(m => m.attrs.thread === 'c5')) marked += n.text; return true })
    expect(marked).toBe('第一项第二项')
  })
})

describe('读视图', () => {
  it('outline 与 read 带 rev 和块 id', () => {
    const { docs, store, docId } = setup(SAMPLE)
    const doc = docs.get(docId)
    const o = outline({ doc, docId, title: '测试', rev: 0, citations: [], openComments: 0 })
    expect(o).toContain('rev=0')
    expect(o).toMatch(/# \{#[a-z0-9]+\} 引言/)
    const h2 = doc.child(2).attrs.id as string
    const r = read({ doc, docId, rev: 0, comments: store.listComments(docId), section_id: h2 })
    expect(r).toContain('## 方法')
    expect(r).not.toContain('心力衰竭')
  })
})

describe('replace_text 跨引用标记', () => {
  it('find 跳过了引用标记、replace 只是追加：保留引用，只插入追加的部分', () => {
    const { store, docs, ops, docId } = setup('占位。')
    const c = store.upsertCitation({ doc_id: docId, doi: '10.1056/x', pmid: null, formatted: 'x', url: null })
    const [p] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p!, markdown: `HR 0.80（95% CI 0.72–0.90）[@c:${c.id}]。` }] }, { actor: 'user', turnId: null })
    ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '0.72–0.90）。', replace: '0.72–0.90）。局限：随访较短。' }] }, { actor: 'ai', turnId: null })
    const node = docs.get(docId).child(0)
    expect(node.textContent).toBe('HR 0.80（95% CI 0.72–0.90）。局限：随访较短。')
    let cites = 0
    node.forEach(n => { if (n.type.name === 'citation') cites++ })
    expect(cites).toBe(1)
  })

  it('真正的改写跨过引用：拒绝并提示原样写出引用标记', () => {
    const { store, docs, ops, docId } = setup('占位。')
    const c = store.upsertCitation({ doc_id: docId, doi: '10.1056/x', pmid: null, formatted: 'x', url: null })
    const [p] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p!, markdown: `风险降低[@c:${c.id}]。` }] }, { actor: 'user', turnId: null })
    const e = expectOpError(() => ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '风险降低。', replace: '风险显著降低。' }] }, { actor: 'ai', turnId: null }), 'text_not_found')
    expect(e.extra.hint).toContain('引用标记')
  })
})

describe('格式写入回归', () => {
  it('带格式的 replace_text 追加句子：新句子不被匹配起点的粗体染上', () => {
    const { store, docs, ops, docId } = setup('占位。')
    const c = store.upsertCitation({ doc_id: docId, doi: '10.1056/x', pmid: null, formatted: 'x', url: null })
    const [p] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p!, markdown: `HR **0.80（95% CI 0.72–0.90）**[@c:${c.id}]。` }] }, { actor: 'user', turnId: null })
    ops.edit({ doc_id: docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: `**0.80（95% CI 0.72–0.90）**[@c:${c.id}]。`, replace: `**0.80（95% CI 0.72–0.90）**[@c:${c.id}]。结论不宜外推。` }] }, { actor: 'ai', turnId: null })
    expect(read({ doc: docs.get(docId), docId, rev: 0, comments: [] })).toContain(`HR **0.80（95% CI 0.72–0.90）**[@c:${c.id}]。结论不宜外推。`)
  })

  it('引用之后的文字只改格式：Yjs 里同样生效', () => {
    const { docs, docId } = setup('占位。')
    const [p] = ids(docs, docId)
    const b = schema.marks.bold!.create()
    const cm = schema.marks.comment!.create({ thread: 't1' })
    const cite = schema.nodes.citation!.create({ cite_id: 'cx' })
    const mk = (tail: Parameters<typeof schema.text>[1]) => schema.node('doc', null, [schema.node('paragraph', { id: p }, [schema.text('HR ', [cm]), schema.text('0.80', [b, cm]), cite, schema.text('。尾。', tail)])])
    docs.commit(docId, mk([b]), { actor: 'user', turnId: null, ops: [] })
    docs.commit(docId, mk([cm]), { actor: 'user', turnId: null, ops: [] })
    expect(docs.get(docId).eq(mk([cm]))).toBe(true)
  })
})

describe('代码审查回归（2026-10-01）', () => {
  it('replace_text 含 emoji / 数学字母：按码元对齐，不丢字、不写入半个代理对', () => {
    const cases: Array<[string, string, string, string]> = [
      ['😀 good day', '😀 good', '😀 great', '😀 great day'],
      ['hello world', 'world', 'wörld 😀!', 'hello wörld 😀!'],
      ['a 𝛼 b', '𝛼 b', '𝛽 b', 'a 𝛽 b'],
    ]
    for (const [text, find, replace, want] of cases) {
      const { docs, ops, docId } = setup(text)
      const [p] = ids(docs, docId)
      ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find, replace }] }, { actor: 'ai', turnId: null })
      expect(docs.get(docId).child(0).textContent).toBe(want)
    }
  })

  it('find 只有强调符号（「**」）：不会把空串当匹配词卡死，按原文找不到处理', () => {
    const { docs, ops, docId } = setup('心衰是**常见**疾病。')
    const [p] = ids(docs, docId)
    expectOpError(() => ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p!, find: '**', replace: '' }] }, { actor: 'ai', turnId: null }), 'text_not_found')
  })

  it('评论按选区位置打锚点：重复出现的文字锚到选中的那一处', () => {
    const { docs, docId } = setup('细胞因子作用于细胞，细胞随后增殖。')
    const [p] = ids(docs, docId)
    const text = docs.get(docId).child(0).textContent
    const second = text.indexOf('细胞', text.indexOf('细胞') + 1)
    const anchored = attachComment(docs.get(docId), p!, '细胞', 'c1', undefined, { from: second, to: second + 2 })
    let at = -1
    anchored.doc.child(0).forEach((n, offset) => { if (at < 0 && n.marks.some(m => m.attrs.thread === 'c1')) at = offset })
    expect(at).toBe(second)
  })

  it('评论选区跨硬换行 / 包含引用：按位置锚定，引用文字与前端同一规则', async () => {
    const { AnchorError, paragraphText } = await import('../src/model/anchors.ts')
    const { store, docs, ops, docId } = setup('占位。')
    const c = store.upsertCitation({ doc_id: docId, doi: '10.1056/x', pmid: null, formatted: 'x', url: null })
    const [p] = ids(docs, docId)
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: p!, markdown: `第一行<br>第二行[@c:${c.id}]结束。` }] }, { actor: 'user', turnId: null })
    const block = docs.get(docId).child(0)
    const size = block.content.size
    expect(paragraphText(block, 0, size)).toBe('第一行\n第二行结束。')
    const r = attachComment(docs.get(docId), p!, '第一行\n第二行结束。', 'c2', undefined, { from: 0, to: size })
    expect(r.snippet).toBe('第一行\n第二行结束。')
    // 位置与文字对不上（期间文档变了）且文字也找不到：要求重选
    expect(() => attachComment(docs.get(docId), p!, '已经不存在的字', 'c3', undefined, { from: 0, to: 3 })).toThrow(AnchorError)
    // 越界位置
    expect(() => attachComment(docs.get(docId), p!, 'x', 'c4', undefined, { from: 0, to: size + 5 })).toThrow(AnchorError)
  })

  it('正在回答的评论重新锚到整块后：记录改成整块评论，之后再整体改写不会被拦', () => {
    const env = setup('心衰很常见。')
    const [p1] = ids(env.docs, env.docId)
    const cm = env.store.addComment({ doc_id: env.docId, node_id: p1!, snippet: '很常见' })
    env.docs.commit(env.docId, attachComment(env.docs.get(env.docId), p1!, '很常见', cm.id).doc, { actor: 'user', turnId: null, ops: [] })
    env.ops.edit({ doc_id: env.docId, base_rev: 1, mode: 'apply', ops: [{ op: 'replace_text', id: p1!, find: '很常见。', replace: '约影响 2% 的成人。' }] }, { actor: 'ai', turnId: null, answering: cm.id })
    expect(env.store.getComment(env.docId, cm.id)!.snippet).toBe('')
    // 下一轮（不再是回答这条评论）整段重写：整块评论跟着块走，不被锚点守卫拦下
    env.ops.edit({ doc_id: env.docId, base_rev: 2, mode: 'apply', ops: [{ op: 'replace_block', id: p1!, markdown: '心力衰竭影响约 2% 的成年人。' }] }, { actor: 'ai', turnId: null })
    expect(env.docs.get(env.docId).child(0).textContent).toBe('心力衰竭影响约 2% 的成年人。')
  })
})

describe('章节防重复守卫（导出与编辑一致性）', () => {
  it('replace_block 针对章节标题传入整章（标题 + 多段正文）时自动替换旧章节正文，不残留旧段落', () => {
    const md = `# 引言\n\n旧引言第一段。\n\n旧引言第二段。\n\n# 方法\n\n方法原稿。`
    const { docs, ops, docId } = setup(md)
    const [h1] = ids(docs, docId)
    ops.edit({
      doc_id: docId,
      base_rev: 0,
      mode: 'apply',
      ops: [{
        op: 'replace_block',
        id: h1!,
        markdown: `# 引言\n\n新引言第一段。\n\n新引言第二段。`,
      }],
    }, { actor: 'ai', turnId: null })

    const exported = exportMarkdown(docs.get(docId), [])
    expect(exported).toContain('新引言第一段。')
    expect(exported).toContain('新引言第二段。')
    expect(exported).not.toContain('旧引言第一段。')
    expect(exported).not.toContain('旧引言第二段。')
    expect(exported).toContain('# 方法')
    expect(exported).toContain('方法原稿。')
  })

  it('insert_after 针对章节标题插入带同名同级标题的整章内容时自动剥离重复标题', () => {
    const md = `# 引言\n\n# 方法\n\n方法原稿。`
    const { docs, ops, docId } = setup(md)
    const [h1] = ids(docs, docId)
    ops.edit({
      doc_id: docId,
      base_rev: 0,
      mode: 'apply',
      ops: [{
        op: 'insert_after',
        anchor_id: h1!,
        markdown: `# 引言\n\n补充的引言正文。`,
      }],
    }, { actor: 'ai', turnId: null })

    const doc = docs.get(docId)
    const headings: string[] = []
    doc.forEach(n => {
      if (n.type.name === 'heading') headings.push(n.textContent)
    })
    expect(headings).toEqual(['引言', '方法'])
    expect(exportMarkdown(doc, [])).toContain('补充的引言正文。')
  })
})

