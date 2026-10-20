import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { exportDocx } from '../src/convert/docx-export.ts'
import { bindAssets, bindComments, importDocx } from '../src/convert/docx-import.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { newCommentId, Store } from '../src/store/db.ts'
import { read } from '../src/views/read.ts'
import { docx, p } from './fixtures.ts'

/** 模拟 API 的导入流程（与 export.test.ts 相同）。 */
function importInto(bytes: Uint8Array) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const r = importDocx(bytes)
  const ids = new Map(r.assets.map(a => [a.key, store.putAsset({ owner: 'u', mime: a.mime, name: a.name, bytes: a.bytes }).id]))
  const row = docs.create({ owner: 'u', title: 't', content: bindAssets(r.doc, ids), source: 'import' })
  store.putNodeSrc(row.id, r.src)
  store.putPackage(row.id, 'docx', bytes)
  const exportNow = () => exportDocx({
    doc: docs.get(row.id), baseline: docs.versionDoc(row.id, 1), pkg: bytes,
    src: id => store.getNodeSrc(row.id, id), citations: store.listCitations(row.id), comments: store.listComments(row.id),
    asset: () => null,
  })
  const view = () => read({ doc: docs.get(row.id), docId: row.id, rev: docs.rev(row.id), comments: store.listComments(row.id, 'open') })
  return { store, docs, ops, docId: row.id, exportNow, view, warnings: r.warnings }
}

const bodyOf = (bytes: Uint8Array) => {
  const xml = strFromU8(unzipSync(bytes)['word/document.xml']!)
  return xml.slice(xml.indexOf('<w:body>') + 8, xml.indexOf('</w:body>'))
}
const firstPara = (bytes: Uint8Array) => bodyOf(bytes).split('</w:p>')[0]!
const NOTES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>数据来源见方案。</w:t></w:r></w:p></w:footnote></w:footnotes>'
const FOOTNOTE_RUN = '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>'
const SEQ = '<w:fldSimple w:instr=" SEQ Table \\* ARABIC "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
const ENDNOTE_CITE = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE &lt;EndNote&gt;&lt;/EndNote&gt;</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>[3]</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'

describe('Word 行内结构：脚注引用与域代码', () => {
  it('带脚注的段落可以编辑，导出后脚注引用仍在原处；读视图列出脚注内容', () => {
    const t = importInto(docx(`<w:p><w:r><w:t xml:space="preserve">本研究为单中心研究。</w:t></w:r>${FOOTNOTE_RUN}<w:r><w:t xml:space="preserve">共纳入 110 例。</w:t></w:r></w:p>`, { files: { 'word/footnotes.xml': new TextEncoder().encode(NOTES) } }))
    const para = t.docs.get(t.docId).child(0)
    expect(para.type.name).toBe('paragraph')
    const view = t.view()
    expect(view).toMatch(/本研究为单中心研究。\[@w:w1\]共纳入 110 例。/)
    expect(view).toContain('[@w:w1] 脚注：数据来源见方案。')
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: para.attrs.id as string, find: '共纳入 110 例', replace: '共纳入 110 例受试者' }] }, { actor: 'ai', turnId: 't1' })
    const first = firstPara(t.exportNow().bytes)
    expect(first).toContain('受试者')
    expect(first).toContain('<w:footnoteReference w:id="1"/>')
    expect(first.indexOf('单中心研究')).toBeLessThan(first.indexOf('footnoteReference'))
    expect(first.indexOf('footnoteReference')).toBeLessThan(first.indexOf('受试者'))
  })

  it('改了含 SEQ 题注编号的表题：域代码保留', () => {
    const t = importInto(docx(`<w:p><w:r><w:t xml:space="preserve">Table </w:t></w:r>${SEQ}<w:r><w:t xml:space="preserve">. Patient characteristics.</w:t></w:r></w:p>`))
    expect(t.warnings.join()).not.toContain('域')
    const id = t.docs.get(t.docId).child(0).attrs.id as string
    expect(t.view()).toContain('[@w:w1] 域代码（显示为「1」）')
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id, find: 'Patient characteristics', replace: 'Baseline characteristics' }] }, { actor: 'ai', turnId: 't1' })
    const first = firstPara(t.exportNow().bytes)
    expect(first).toContain('Baseline characteristics')
    expect(first).toContain('SEQ Table')
  })

  it('EndNote 引用（复杂域）：整段改写时原样保留标记即可保留域；编造的标记整批拒绝；删掉标记会去掉该域', () => {
    const t = importInto(docx(`<w:p><w:r><w:t xml:space="preserve">既往研究支持该结论</w:t></w:r>${ENDNOTE_CITE}<w:r><w:t>。</w:t></w:r></w:p>`))
    const id = t.docs.get(t.docId).child(0).attrs.id as string
    expect(t.view()).toContain('[@w:w1] 域代码（显示为「[3]」）')
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id, markdown: '多项既往研究支持这一结论[@w:w1]。' }] }, { actor: 'ai', turnId: 't1' })
    const first = firstPara(t.exportNow().bytes)
    expect(first).toContain('多项既往研究')
    expect(first).toContain('ADDIN EN.CITE')
    expect(first.match(/fldCharType="(begin|end)"/g)).toEqual(['fldCharType="begin"', 'fldCharType="end"'])

    const rev = t.docs.rev(t.docId)
    expect(() => t.ops.edit({ doc_id: t.docId, base_rev: rev, mode: 'apply', ops: [{ op: 'replace_block', id, markdown: '新句子[@w:w9]。' }] }, { actor: 'ai', turnId: 't2' }))
      .toThrow(/不是文档里已有的脚注或域代码标记/)

    t.ops.edit({ doc_id: t.docId, base_rev: rev, mode: 'apply', ops: [{ op: 'replace_block', id, markdown: '多项既往研究支持这一结论。' }] }, { actor: 'ai', turnId: 't3' })
    expect(firstPara(t.exportNow().bytes)).not.toContain('EN.CITE')
  })

  it('未改动时含域代码与脚注的段落逐字节写回', () => {
    const body = `<w:p><w:r><w:t xml:space="preserve">见表 </w:t></w:r>${SEQ}${FOOTNOTE_RUN}</w:p>${p('其他段落')}`
    const original = docx(body, { files: { 'word/footnotes.xml': new TextEncoder().encode(NOTES) } })
    const t = importInto(original)
    expect(bodyOf(t.exportNow().bytes)).toBe(bodyOf(original))
  })
})

// —— Word 批注 ——

const enc = (s: string) => new TextEncoder().encode(s)
const COMMENTS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">'
  + '<w:comment w:id="7" w:author="Li Ming" w:date="2026-10-18T08:00:00Z" w:initials="LM"><w:p w14:paraId="0A1B2C3D"><w:r><w:t>Please state the follow-up window.</w:t></w:r></w:p></w:comment>'
  + '<w:comment w:id="8" w:author="Dong Qian" w:date="2026-10-18T09:00:00Z" w:initials="DQ"><w:p w14:paraId="0A1B2C3E"><w:r><w:t>Agreed.</w:t></w:r></w:p></w:comment>'
  + '</w:comments>'
const COMMENTS_EX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="0A1B2C3D" w15:done="0"/><w15:commentEx w15:paraId="0A1B2C3E" w15:paraIdParent="0A1B2C3D" w15:done="0"/></w15:commentsEx>'
const REF = (id: number) => `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`
const COMMENTED = '<w:p><w:r><w:t xml:space="preserve">本研究纳入 </w:t></w:r><w:commentRangeStart w:id="7"/><w:commentRangeStart w:id="8"/><w:r><w:t>110 例</w:t></w:r><w:commentRangeEnd w:id="7"/><w:commentRangeEnd w:id="8"/>'
  + `${REF(7)}${REF(8)}<w:r><w:t xml:space="preserve">患者，随访 3 年。</w:t></w:r></w:p>`
const COMMENT_RELS = '<Relationship Id="rId30" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rId31" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>'
const withComments = () => docx(COMMENTED + p('其他段落。'), { rels: COMMENT_RELS, files: { 'word/comments.xml': enc(COMMENTS_XML), 'word/commentsExtended.xml': enc(COMMENTS_EX) } })

/** 与 API 导入一致：Word 批注换成平台线程后再建文档，再写入评论与回复。 */
function importWithComments(bytes: Uint8Array) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const r = importDocx(bytes)
  const bound = bindComments(r.doc, r.comments, newCommentId)
  const row = docs.create({ owner: 'u', title: 't', content: bound.doc, source: 'import' })
  store.putNodeSrc(row.id, r.src)
  store.putPackage(row.id, 'docx', bytes)
  for (const t of bound.threads) {
    store.addComment({ id: t.id, doc_id: row.id, node_id: t.node_id, snippet: t.snippet, source_ref: `word:${t.word_id}:${t.replies.length}` })
    store.addReply(t.id, 'user', t.text, null, t.author)
    for (const x of t.replies) store.addReply(t.id, 'user', x.text, null, x.author)
    if (t.done) store.setCommentStatus(row.id, t.id, 'resolved', 'user')
  }
  const exportNow = () => exportDocx({
    doc: docs.get(row.id), baseline: docs.versionDoc(row.id, 1), pkg: bytes,
    src: id => store.getNodeSrc(row.id, id), citations: store.listCitations(row.id), comments: store.listComments(row.id), asset: () => null,
  }).bytes
  const view = () => read({ doc: docs.get(row.id), docId: row.id, rev: docs.rev(row.id), comments: store.listComments(row.id, 'open') })
  const thread = () => store.listComments(row.id)[0]!
  return { store, docs, ops, docId: row.id, exportNow, view, thread }
}
const part = (bytes: Uint8Array, name: string) => strFromU8(unzipSync(bytes)[name]!)

describe('Word 批注：导入为平台评论线程，导出为 Word 线程回复', () => {
  it('导入：根批注与回复（含原作者）成为一条平台线程，锚在被批注的文字上；读视图可见', () => {
    const t = importWithComments(withComments())
    const c = t.thread()
    expect(c.source_ref).toBe('word:7:1')
    expect(c.snippet).toBe('110 例')
    expect(c.replies.map(r => [r.author, r.text])).toEqual([['Li Ming', 'Please state the follow-up window.'], ['Dong Qian', 'Agreed.']])
    expect(t.view()).toContain('「110 例」：Agreed.（Dong Qian）')
  })

  it('不改动：正文与批注部件原样写回', () => {
    const original = withComments()
    const out = importWithComments(original).exportNow()
    expect(bodyOf(out)).toBe(bodyOf(original))
    expect(part(out, 'word/comments.xml')).toBe(COMMENTS_XML)
    expect(part(out, 'word/commentsExtended.xml')).toBe(COMMENTS_EX)
  })

  it('AI 在线程里回复：写成新的 Word 批注并挂到根批注下，范围标记紧贴根批注；回读仍是同一条线程', () => {
    const t = importWithComments(withComments())
    t.store.addReply(t.thread().id, 'ai', '已在方法中写明中位随访 36 个月。')
    const out = t.exportNow()
    const comments = part(out, 'word/comments.xml')
    expect(comments).toMatch(/<w:comment w:id="9" w:author="Heurion AI"[^>]*><w:p w14:paraId="([0-9A-F]{8})">.*已在方法中写明/)
    const pid = /<w:comment w:id="9"[^>]*><w:p w14:paraId="([0-9A-F]{8})"/.exec(comments)![1]
    expect(part(out, 'word/commentsExtended.xml')).toContain(`w15:paraId="${pid}" w15:paraIdParent="0A1B2C3D"`)
    const body = bodyOf(out)
    expect(body).toContain('<w:commentRangeStart w:id="7"/><w:commentRangeStart w:id="9"/>')
    expect(body).toContain('<w:commentRangeEnd w:id="7"/><w:commentRangeEnd w:id="9"/>')
    expect(body).toContain('<w:commentReference w:id="9"/>')
    const back = importDocx(out)
    expect(back.comments).toHaveLength(1)
    expect(back.comments[0]!.replies.map(r => r.author)).toEqual(['Dong Qian', 'Heurion AI'])
  })

  it('改写批注所在段落（不动被批注的文字）：沿用原批注 id，不重复生成根批注', () => {
    const t = importWithComments(withComments())
    const id = t.docs.get(t.docId).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id, find: '随访 3 年', replace: '中位随访 36 个月' }] }, { actor: 'ai', turnId: 't1' })
    const out = t.exportNow()
    const first = firstPara(out)
    expect(first).toContain('中位随访 36 个月')
    expect(first).toContain('<w:commentRangeStart w:id="7"/>')
    expect(first).toContain('<w:commentReference w:id="7"/>')
    expect(part(out, 'word/comments.xml').match(/<w:comment w:id="7"/g)).toHaveLength(1)
  })

  it('在平台里解决：Word 里标为已解决', () => {
    const t = importWithComments(withComments())
    t.store.setCommentStatus(t.docId, t.thread().id, 'resolved', 'user')
    expect(part(t.exportNow(), 'word/commentsExtended.xml')).toMatch(/w15:paraId="0A1B2C3D"[^>]*w15:done="1"/)
  })
})
