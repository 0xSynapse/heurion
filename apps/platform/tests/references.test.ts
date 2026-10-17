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

  it('合并后的文件重新导入再导出：上次追加的平台条目去掉重排，始终只有一份文献表', () => {
    const cites = [{ doi: '10.1056/new', formatted: 'Doe J. New. NEJM. 2020. doi:10.1056/new' }]
    const first = setup(USER, cites).exportNow().bytes
    // 引用文本后来更新过；在重新导入的文稿里再次插入同一条引用
    const again = setup([], [{ doi: '10.1056/new', formatted: 'Doe J, Roe K. New (updated). NEJM. 2020. doi:10.1056/new' }], first)
    const body = bodyOf(again.exportNow().bytes)
    expect(body.match(/参考文献/g)!.length).toBe(1)
    expect(body.match(/Doe J/g)!.length).toBe(1)
    expect(body).toContain('[3] Doe J, Roe K. New (updated).')
    expect(body).toContain('Smith A. Foo study')
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
