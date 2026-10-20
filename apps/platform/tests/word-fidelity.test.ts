import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { exportDocx } from '../src/convert/docx-export.ts'
import { bindAssets, importDocx } from '../src/convert/docx-import.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
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
