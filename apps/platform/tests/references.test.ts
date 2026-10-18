import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { exportDocx } from '../src/convert/docx-export.ts'
import { bindAssets, importDocx } from '../src/convert/docx-import.ts'
import { numberCitations, referencePlan } from '../src/model/references.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
import { exportMarkdown, renderHtml } from '../src/views/render.ts'
import { docx, p } from './fixtures.ts'

/** 导入一份末尾带文献表的 docx，在第一段插入给定引用。 */
function setup(entries: string[], cites: Array<{ doi: string; formatted: string }>, bytes?: Uint8Array) {
  const file = bytes ?? docx([p('心衰是常见病。'), p('参考文献', '<w:pStyle w:val="Heading1"/>'), ...entries.map(e => p(e))].join(''))
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const r = importDocx(file)
  const row = docs.create({ owner: 'u', title: 't', content: bindAssets(r.doc, new Map()), source: 'import' })
  store.putNodeSrc(row.id, r.src)
  store.putPackage(row.id, 'docx', file)
  const ids = cites.map(c => store.upsertCitation({ doc_id: row.id, doi: c.doi, pmid: null, formatted: c.formatted, url: null }).id)
  const para = docs.get(row.id).child(0).attrs.id as string
  const text = docs.get(row.id).child(0).textContent
  ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: para, find: text, replace: text + ids.map(id => `[@c:${id}]`).join('') }] }, { actor: 'user', turnId: null })
  const exportNow = () => exportDocx({ doc: docs.get(row.id), baseline: docs.versionDoc(row.id, 1), pkg: file, src: id => store.getNodeSrc(row.id, id), citations: store.listCitations(row.id), comments: [], asset: () => null })
  return { store, docs, docId: row.id, ids, exportNow }
}
const bodyOf = (bytes: Uint8Array) => { const x = strFromU8(unzipSync(bytes)['word/document.xml']!); return x.slice(x.indexOf('<w:body>') + 8, x.indexOf('</w:body>')) }
const USER = ['[1] Smith A. Foo study. Lancet. 2001. doi:10.1016/lancet.1', '[2] Lee B. Bar trial. JAMA. 2002.']

describe('参考文献合并进用户自己的文献表', () => {
  it('与用户条目同一篇文献（DOI 相同）：沿用用户编号，不重复列出；其余接着编号', () => {
    const t = setup(USER, [{ doi: '10.1056/new', formatted: 'Doe J. New. NEJM. 2020. doi:10.1056/new' }, { doi: '10.1016/lancet.1', formatted: 'Smith A. Foo study (platform). Lancet. 2001. doi:10.1016/lancet.1' }])
    const plan = referencePlan(t.docs.get(t.docId), t.store.listCitations(t.docId))
    expect(plan.numbers.get(t.ids[0]!)).toBe(3)
    expect(plan.numbers.get(t.ids[1]!)).toBe(1)
    expect(plan.append.map(a => a.n)).toEqual([3])
    expect(plan.duplicates).toBe(1)
    const out = t.exportNow()
    const body = bodyOf(out.bytes)
    expect(body).not.toContain('Foo study (platform)')
    expect(body).toContain('[3] Doe J. New.')
    expect(out.warnings[0]).toContain('其中 1 条与表中已有文献相同，沿用原编号')
  })

  it('合并后的文件下载后再上传、再次引用同一篇：沿用表里的编号，不重复追加，始终只有一份文献表', () => {
    const cites = [{ doi: '10.1056/new', formatted: 'Doe J. New. NEJM. 2020. doi:10.1056/new' }]
    const first = setup(USER, cites).exportNow().bytes
    // 引用文本后来更新过；在重新上传的文稿里再次插入同一条引用
    const again = setup([], [{ doi: '10.1056/new', formatted: 'Doe J, Roe K. New (updated). NEJM. 2020. doi:10.1056/new' }], first)
    const out = again.exportNow()
    const body = bodyOf(out.bytes)
    expect(body.match(/参考文献/g)!.length).toBe(1)
    expect(body.match(/Doe J/g)!.length).toBe(1)
    expect(body).toContain('[3] Doe J. New. NEJM.')
    expect(body).toContain('Smith A. Foo study')
    expect(out.warnings[0]).toContain('都已在末尾的参考文献表中')
  })

  it('表中各条都带 DOI、且都登记过但只引用了其中一篇：用户条目一条不删，引用沿用其编号', () => {
    const entries = ['[1] A. One. doi:10.1001/aaa', '[2] B. Two. doi:10.1001/bbb', '[3] C. Three. doi:10.1001/ccc']
    const t = setup(entries, [{ doi: '10.1001/bbb', formatted: 'B fmt' }])
    // 另外两篇只登记、没在正文里用
    t.store.upsertCitation({ doc_id: t.docId, doi: '10.1001/aaa', pmid: null, formatted: 'A fmt', url: null })
    t.store.upsertCitation({ doc_id: t.docId, doi: '10.1001/ccc', pmid: null, formatted: 'C fmt', url: null })
    const plan = referencePlan(t.docs.get(t.docId), t.store.listCitations(t.docId))
    expect(plan.numbers.get(t.ids[0]!)).toBe(2)
    expect(plan.append).toEqual([])
    const body = bodyOf(t.exportNow().bytes)
    for (const e of entries) expect(body).toContain(e)
    expect(body).not.toContain('B fmt')
  })

  it('表中最后一条正是被引的那篇：保留用户写的文本，沿用其编号', () => {
    const t = setup(['[1] A. One.', '[2] B. Two.', '[3] C. Three (user wording). doi:10.1001/ccc'], [{ doi: '10.1001/ccc', formatted: 'C platform wording' }])
    const plan = referencePlan(t.docs.get(t.docId), t.store.listCitations(t.docId))
    expect(plan.numbers.get(t.ids[0]!)).toBe(3)
    expect(plan.duplicates).toBe(1)
    const body = bodyOf(t.exportNow().bytes)
    expect(body).toContain('C. Three (user wording)')
    expect(body).not.toContain('C platform wording')
  })

  it('GB/T 7714 写法「[1]张三」（括号后不空格）与全角括号「［2］」也认作已有文献表', () => {
    const t = setup(['[1]张三. 心衰研究[J]. 中华心血管病杂志, 2020.', '［2］李四. 预后模型[J]. 中华内科杂志, 2021.'], [{ doi: '10.1056/new', formatted: 'Doe J. New. NEJM. 2020.' }])
    const plan = referencePlan(t.docs.get(t.docId), t.store.listCitations(t.docId))
    expect(plan.userCount).toBe(2)
    expect(plan.numbers.get(t.ids[0]!)).toBe(3)
  })

  it('正文里还没有平台引用时也给出已有文献表的条目数（编辑器插入第一条引用就编对号）', () => {
    const t = setup(['[1] A.', '[2] B.'], [])
    expect(referencePlan(t.docs.get(t.docId), t.store.listCitations(t.docId)).userCount).toBe(2)
  })

  it('追加条目沿用最后一条的格式，但不带分节符、段前分页与修订标记', () => {
    const last = '<w:p><w:pPr><w:pageBreakBefore/><w:ind w:left="420"/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:rPr><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">[2] Lee B. Bar trial. JAMA. 2002.</w:t></w:r></w:p>'
    const file = docx([p('心衰是常见病。'), p('参考文献', '<w:pStyle w:val="Heading1"/>'), p('[1] Smith A. Foo study. Lancet. 2001.'), last].join(''))
    const t = setup([], [{ doi: '10.1056/new', formatted: 'Doe J. New. NEJM. 2020.' }], file)
    const appended = /<w:p>(?:(?!<\/w:p>)[\s\S])*\[3\] Doe J[\s\S]*?<\/w:p>/.exec(bodyOf(t.exportNow().bytes))![0]
    expect(appended).toContain('<w:ind w:left="420"/>')
    expect(appended).toContain('<w:sz w:val="21"/>')
    expect(appended).not.toContain('sectPr')
    expect(appended).not.toContain('pageBreakBefore')
  })

  it('网页预览与 markdown 导出同样合并：不另起标题，编号接着用户的表', () => {
    const t = setup(USER, [{ doi: '10.1056/new', formatted: 'Doe J. New. NEJM. 2020. doi:10.1056/new' }])
    const rows = t.store.listCitations(t.docId)
    const md = exportMarkdown(t.docs.get(t.docId), rows)
    expect(md).toContain('心衰是常见病。[3]')
    expect(md).not.toContain('## 参考文献')
    expect(md.trimEnd().endsWith('[3] Doe J. New. NEJM. 2020. doi:10.1056/new')).toBe(true)
    const html = renderHtml(t.docs.get(t.docId), rows, id => id)
    expect(html).toContain('<ol start="3">')
    expect(html).not.toContain('<h2>参考文献</h2>')
  })

  it('没有用户文献表：照旧从 [1] 编号并另起标题', () => {
    const t = setup([], [{ doi: '10.1056/new', formatted: 'Doe J. New. NEJM. 2020.' }])
    const plan = referencePlan(t.docs.get(t.docId), t.store.listCitations(t.docId))
    expect(plan.userCount).toBe(0)
    expect(plan.numbers.get(t.ids[0]!)).toBe(1)
  })

  it('编辑器用的编号函数与服务端一致', () => {
    expect([...numberCitations(['a', 'b', 'c'], 2, { b: 1 })]).toEqual([['a', 3], ['b', 1], ['c', 4]])
    expect([...numberCitations(['a', 'b'], 0, {})]).toEqual([['a', 1], ['b', 2]])
  })
})
