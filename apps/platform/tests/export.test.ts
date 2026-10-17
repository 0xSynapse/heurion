import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { exportDocx } from '../src/convert/docx-export.ts'
import { cleanBibText } from '../src/literature/format.ts'
import { bindAssets, importDocx } from '../src/convert/docx-import.ts'
import { attachComment } from '../src/model/anchors.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
import { docx, drawing, IMAGE_REL, li, p, PNG } from './fixtures.ts'

/** 模拟 API 的导入流程，返回平台里的文档。 */
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
    asset: id => { const a = store.getAsset(id); return a ? { mime: a.mime, bytes: store.getAssetBytes(id)! } : null },
  })
  return { store, docs, ops, docId: row.id, exportNow }
}

const bodyOf = (bytes: Uint8Array) => {
  const xml = strFromU8(unzipSync(bytes)['word/document.xml']!)
  return xml.slice(xml.indexOf('<w:body>') + 8, xml.indexOf('</w:body>'))
}

const BODY = [
  p('引言', '<w:pStyle w:val="Heading1"/>'),
  p('心衰是常见病。', '', '<w:b/>'),
  li('第一步', 0), li('第二步', 0),
  `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
].join('')

describe('docx 导出（修补式）', () => {
  it('导入后不改：正文逐字节原样写回', () => {
    const original = docx(BODY)
    const t = importInto(original)
    expect(bodyOf(t.exportNow().bytes)).toBe(bodyOf(original))
  })

  it('改一段：只有该段重新生成，其余原样；回读内容一致', () => {
    const original = docx(BODY)
    const t = importInto(original)
    const para = t.docs.get(t.docId).child(1).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'replace_text', id: para, find: '常见病', replace: '高发病' },
      { op: 'insert_after', anchor_id: t.docs.get(t.docId).child(2).child(1).attrs.id as string, markdown: '- 第三步' },
    ] }, { actor: 'user', turnId: null })
    const out = t.exportNow().bytes
    const body = bodyOf(out)
    expect(body).toContain(p('引言', '<w:pStyle w:val="Heading1"/>'))
    expect(body).not.toContain('常见病')
    expect(body).toContain('<w:b/>') // 替换后保留粗体
    // 新列表项接在原列表的编号上
    expect(body.match(/<w:numId w:val="1"\/>/g)!.length).toBe(3)
    const back = importDocx(out)
    expect(back.doc.textContent).toBe(t.docs.get(t.docId).textContent)
  })

  it('新建文档：标题、列表、表格合并、引用编号、参考文献、评论、图片', () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const ops = new OpService(docs)
    const row = docs.create({ owner: 'u', title: 't', content: schema.node('doc', null, parseBlocks('# 引言\n\n心衰常见。\n\n1. 甲\n2. 乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')) })
    const cite = store.upsertCitation({ doc_id: row.id, doi: '10.1056/x', pmid: null, formatted: 'Doe J. Trial. N Engl J Med. 2020.', url: null })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0])
    const asset = store.putAsset({ owner: 'u', mime: 'image/png', name: 'c.png', bytes: png })
    const para = docs.get(row.id).child(1).attrs.id as string
    ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [
      { op: 'replace_text', id: para, find: '常见', replace: `常见[@c:${cite.id}]` },
      { op: 'insert_after', anchor_id: para, markdown: `![发病率](asset:${asset.id} "图 1")` },
    ] }, { actor: 'ai', turnId: null })
    const c = store.addComment({ doc_id: row.id, node_id: para, snippet: '心衰' })
    store.addReply(c.id, 'user', '补充数据')
    docs.commit(row.id, attachComment(docs.get(row.id), para, '心衰', c.id).doc, { actor: 'user', turnId: null, ops: [] })

    const out = exportDocx({
      doc: docs.get(row.id), baseline: null, pkg: null, src: () => null,
      citations: store.listCitations(row.id), comments: store.listComments(row.id),
      asset: id => { const a = store.getAsset(id); return a ? { mime: a.mime, bytes: store.getAssetBytes(id)! } : null },
    })
    const files = unzipSync(out.bytes)
    const body = strFromU8(files['word/document.xml']!)
    expect(body).toContain('<w:pStyle w:val="Heading1"/>')
    expect(body).toContain('[1]')
    expect(body).toContain('Doe J. Trial')
    expect(body).toContain('<w:commentRangeStart')
    expect(strFromU8(files['word/comments.xml']!)).toContain('补充数据')
    expect(files['word/numbering.xml']).toBeDefined()
    expect(Object.keys(files).some(f => f.startsWith('word/media/'))).toBe(true)
    expect(strFromU8(files['[Content_Types].xml']!)).toContain('Extension="png"')
    // 回读：结构保持
    const back = importDocx(out.bytes)
    const kinds: string[] = []
    back.doc.forEach(n => kinds.push(n.type.name))
    expect(kinds.slice(0, 5)).toEqual(['heading', 'paragraph', 'figure', 'ordered_list', 'table'])
    expect(back.doc.child(3).childCount).toBe(2)
  })
})

describe('docx 导出：图、不可编辑段落、列表样式', () => {
  const withImage = (body: string) => docx(body, { rels: IMAGE_REL, files: { 'word/media/image1.png': PNG } })
  const drawings = (bytes: Uint8Array) => (bodyOf(bytes).match(/<w:drawing>/g) ?? []).length

  it('文字与图混排的段落：原样写回时图不重复；改了文字后图仍只出现一次', () => {
    const original = withImage(`${p('前文')}<w:p><w:r><w:t>见下图</w:t></w:r>${drawing()}</w:p>${p('后文')}`)
    const t = importInto(original)
    expect(bodyOf(t.exportNow().bytes)).toBe(bodyOf(original))
    const para = t.docs.get(t.docId).child(1).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: para, find: '见下图', replace: '见图 1' }] }, { actor: 'user', turnId: null })
    const out = t.exportNow().bytes
    expect(drawings(out)).toBe(1)
    expect(bodyOf(out)).toContain('见图 1')
  })

  it('只有一张图的段落：未改动时逐字节写回', () => {
    const original = withImage(`${p('前文')}<w:p>${drawing()}</w:p>`)
    const t = importInto(original)
    expect(t.docs.get(t.docId).child(1).type.name).toBe('figure')
    expect(bodyOf(t.exportNow().bytes)).toBe(bodyOf(original))
  })

  it('含文本框 / 脚注的段落导入为不可编辑块，导出原样保留', () => {
    const textbox = `<w:p><w:r><w:t>正文</w:t></w:r><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:t>框内文字</w:t></mc:Choice></mc:AlternateContent></w:r></w:p>`
    const footnote = `<w:p><w:r><w:t>有脚注</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`
    const r = importDocx(docx(textbox + footnote))
    expect(r.doc.child(0).type.name).toBe('opaque')
    expect(r.doc.child(1).attrs.kind).toBe('脚注')
    expect(r.warnings.join()).toContain('不可编辑块')
    const t = importInto(docx(textbox + footnote + p('可编辑')))
    const last = t.docs.get(t.docId).child(2).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: last, find: '可编辑', replace: '已编辑' }] }, { actor: 'user', turnId: null })
    const body = bodyOf(t.exportNow().bytes)
    expect(body).toContain('框内文字')
    expect(body).toContain('<w:footnoteReference w:id="1"/>')
  })

  it('新建的无序列表沿用原文件无序列表的编号定义与段落样式', () => {
    const bullet = (t: string) => p(t, '<w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr>')
    const original = docx(`${bullet('原有项')}${p('正文')}`)
    // numId 7 → abstractNum 3（bullet）
    const files = unzipSync(original)
    files['word/numbering.xml'] = strToU8(`<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num></w:numbering>`)
    const t = importInto(zipSync(files))
    const para = t.docs.get(t.docId).child(1).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: para, markdown: '- 新项' }] }, { actor: 'user', turnId: null })
    const out = unzipSync(t.exportNow().bytes)
    const numbering = strFromU8(out['word/numbering.xml']!)
    expect(numbering).toMatch(/<w:num w:numId="9001"><w:abstractNumId w:val="3"\/>/)
    expect(numbering).not.toContain('w:abstractNumId="9001"')
    expect(bodyOf(t.exportNow().bytes)).toMatch(/<w:pStyle w:val="ListBullet"\/><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="9001"\/>/)
  })

  it('SVG 矢量图分析图表导出为 docx：光栅化为 PNG 嵌入并带 SVG 扩展，不降级为文字占位符', () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const ops = new OpService(docs)
    const row = docs.create({ owner: 'u', title: '分析报告', content: schema.node('doc', null, parseBlocks('# 分析报告\n\n正文描述。')) })
    const svgStr = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="800" height="400"><rect width="800" height="400" fill="#2563eb"/><text x="400" y="200" fill="#ffffff" font-size="24" text-anchor="middle">分析图表</text></svg>'
    const svgBytes = strToU8(svgStr)
    const asset = store.putAsset({ owner: 'u', mime: 'image/svg+xml', name: 'analysis.svg', bytes: svgBytes })
    const para = docs.get(row.id).child(1).attrs.id as string
    ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [
      { op: 'insert_after', anchor_id: para, markdown: `![粘液栓定量分析](asset:${asset.id} "图 1 支气管粘液栓定量指标对比")` },
    ] }, { actor: 'ai', turnId: null })

    const out = exportDocx({
      doc: docs.get(row.id), baseline: null, pkg: null, src: () => null,
      citations: store.listCitations(row.id), comments: store.listComments(row.id),
      asset: id => {
        const cleanId = String(id).replace(/^asset:/, '')
        const a = store.getAsset(cleanId)
        return a ? { mime: a.mime, bytes: store.getAssetBytes(cleanId)! } : null
      },
    })

    expect(out.warnings).toEqual([])
    const files = unzipSync(out.bytes)
    const body = strFromU8(files['word/document.xml']!)
    expect(body).not.toContain('[图：')
    expect(body).not.toContain('[图:')
    expect(body).toContain('<w:drawing>')
    expect(body).toContain('asvg:svgBlip')
    expect(body).toContain('图 1 支气管粘液栓定量指标对比')
    expect(files[`word/media/heurion-${asset.id}.png`]).toBeDefined()
    expect(files[`word/media/heurion-${asset.id}.svg`]).toBeDefined()
    expect(strFromU8(files['[Content_Types].xml']!)).toContain('Extension="png"')
    expect(strFromU8(files['[Content_Types].xml']!)).toContain('Extension="svg"')
  })

  it('单列表单型表格（如申报书章节表）修改后导出不注入 <w:tblHeader/>，且单元格内 <br> 拆分为独立段落 <w:p>', () => {
    const formTable = `<w:tbl><w:tr><w:tc>${p('一、国内外开展现状（请详细阐述技术背景）')}</w:tc></w:tr><w:tr><w:tc>${p('二、开展该技术的目的、意义和必要性')}</w:tc></w:tr></w:tbl>`
    const t = importInto(docx(formTable))
    const tbl = t.docs.get(t.docId).child(0)
    expect(tbl.type.name).toBe('table')
    expect(tbl.child(0).child(0).attrs.header).toBe(false)

    const tblId = tbl.attrs.id as string
    t.ops.edit({
      doc_id: t.docId,
      base_rev: 0,
      mode: 'apply',
      ops: [{
        op: 'replace_block',
        id: tblId,
        markdown: '| **一、国内外开展现状**<br>（一）国外开展现状：第一段内容。<br>（二）国内开展现状：第二段内容。 |\n| --- |\n| **二、开展该技术的目的、意义和必要性**<br>第三段内容。 |',
      }],
    }, { actor: 'ai', turnId: null })

    const body = bodyOf(t.exportNow().bytes)
    expect(body).not.toContain('<w:tblHeader/>')
    expect(body).not.toContain('<w:br/>')
    const firstRowMatch = body.match(/<w:tr>[\s\S]*?<\/w:tr>/)
    expect(firstRowMatch).not.toBeNull()
    const firstRowParas = firstRowMatch![0].match(/<w:p\b/g) ?? []
    expect(firstRowParas.length).toBe(3)
  })
})

describe('docx 导出：参考文献去重与重复表头', () => {
  const REFS_DOC = (entries: string[]) => docx([
    p('心衰是常见病。'),
    p('参考文献', '<w:pStyle w:val="Heading1"/>'),
    ...entries.map(e => p(e)),
  ].join(''))

  const cite = (t: ReturnType<typeof importInto>) => {
    const c = t.store.upsertCitation({ doc_id: t.docId, doi: '10.1056/x', pmid: null, formatted: 'Doe J. Trial. N Engl J Med. 2020.', url: null })
    const para = t.docs.get(t.docId).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'replace_text', id: para, find: '常见病', replace: `常见病[@c:${c.id}]` },
    ] }, { actor: 'user', turnId: null })
  }

  it('末尾是用户自己写的文献表：平台引用合并进去，接着编号，不另起标题', () => {
    const t = importInto(REFS_DOC(['[1] Smith A. Foo study. Lancet. 2001.', '[2] Lee B. Bar trial. JAMA. 2002.']))
    cite(t)
    const out = t.exportNow()
    const body = bodyOf(out.bytes)
    expect(body).toContain('Smith A. Foo study')
    expect(body).toContain('Lee B. Bar trial')
    expect(body).toContain('[3] Doe J. Trial. N Engl J Med. 2020.')
    expect(body).toContain('<w:vertAlign w:val="superscript"/></w:rPr><w:t>[3]</w:t>')
    expect(body.match(/参考文献/g)!.length).toBe(1)
    expect(body.indexOf('Lee B. Bar trial')).toBeLessThan(body.indexOf('[3] Doe J.'))
    expect(out.warnings.some(w => w.includes('平台引用已合并进去，从 [3] 起编号'))).toBe(true)
  })

  it('末尾是平台上次导出的文献表：复用标题、不重复输出条目', () => {
    const t = importInto(REFS_DOC(['[1] Doe J. Trial. N Engl J Med. 2020.']))
    cite(t)
    const body = bodyOf(t.exportNow().bytes)
    expect(body.match(/Doe J\. Trial/g)!.length).toBe(1)
    expect(body.match(/参考文献/g)!.length).toBe(1)
  })

  it('原文件显式标注的重复表头（含长文本、两行）在修改单元格后保留', () => {
    const hdr = '<w:trPr><w:tblHeader/></w:trPr>'
    const long = '项目名称（请填写完整的课题全称及编号，不超过一百字，并注明所属学科、承担单位、起止年月与经费来源等信息）'
    const tbl = `<w:tbl><w:tr>${hdr}<w:tc>${p(long)}</w:tc><w:tc>${p('负责人')}</w:tc></w:tr>`
      + `<w:tr>${hdr}<w:tc>${p('甲')}</w:tc><w:tc>${p('乙')}</w:tc></w:tr>`
      + `<w:tr><w:tc>${p('数据1')}</w:tc><w:tc>${p('数据2')}</w:tc></w:tr></w:tbl>`
    const t = importInto(docx(tbl))
    const table = t.docs.get(t.docId).child(0)
    const cell = table.child(2).child(0).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'replace_text', id: cell, find: '数据1', replace: '数据一' },
    ] }, { actor: 'user', turnId: null })
    const body = bodyOf(t.exportNow().bytes)
    expect(body).toContain('数据一')
    expect(body.match(/<w:tblHeader\/>/g)?.length).toBe(2)
  })

  it('单列表单型表格即使原文件显式标注了表头，修改后导出也不加重复表头', () => {
    const tbl = `<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc>${p('一、国内外开展现状（请详细阐述技术背景）')}</w:tc></w:tr>`
      + `<w:tr><w:tc>${p('二、开展该技术的目的、意义和必要性')}</w:tc></w:tr></w:tbl>`
    const t = importInto(docx(tbl))
    const cell = t.docs.get(t.docId).child(0).child(1).child(0).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [
      { op: 'replace_text', id: cell, find: '目的', replace: '目标' },
    ] }, { actor: 'user', turnId: null })
    const body = bodyOf(t.exportNow().bytes)
    expect(body).toContain('目标')
    expect(body).not.toContain('<w:tblHeader/>')
  })
})

describe('文献文本清理', () => {
  it('&amp; 最后解码，双重转义只解一层', () => {
    expect(cleanBibText('&amp;lt;5 mm')).toBe('&lt;5 mm')
    expect(cleanBibText('Smith &amp; Jones <i>Nature</i>')).toBe('Smith & Jones Nature')
  })

  it('只清理一次：入库原样保存，旧记录由一次性迁移清理，重复执行不会再解码', () => {
    expect(cleanBibText('&lt;i&gt;x&lt;/i&gt; &#38; &#x26;')).toBe('<i>x</i> & &')
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const row = docs.create({ owner: 'u', title: 't', content: schema.node('doc', null, parseBlocks('正文')) })
    // 清理过的文本里本身就含字面量「&lt;」（来源是双重转义）：入库与读取都不能再解码
    const c = store.upsertCitation({ doc_id: row.id, doi: '10.1/x', pmid: null, formatted: 'Dose &lt;5 mg. Nature.', url: null })
    expect(c.formatted).toBe('Dose &lt;5 mg. Nature.')
    expect(store.listCitations(row.id)[0]!.formatted).toBe('Dose &lt;5 mg. Nature.')
    // 旧记录：迁移标记清掉后模拟上线前的脏数据，迁移只跑一次
    store.insertCitation({ ...c, id: 'cold1', doi: '10.1/y', formatted: 'Smith &amp; Jones. <i>Nature</i>.' })
    ;(store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db.prepare("DELETE FROM app_settings WHERE key = 'migration.citations_clean_text'").run()
    store.cleanLegacyCitations()
    const after = () => store.listCitations(row.id).map(x => x.formatted)
    expect(after()).toEqual(['Dose <5 mg. Nature.', 'Smith & Jones. Nature.'])
    store.cleanLegacyCitations()
    expect(after()).toEqual(['Dose <5 mg. Nature.', 'Smith & Jones. Nature.'])
  })
})

describe('docx 导出：导入表格修改后保留原格式', () => {
  const TBL_PR = '<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="8000" w:type="dxa"/><w:jc w:val="center"/></w:tblPr>'
  const GRID = '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="6000"/></w:tblGrid>'
  const SHD = '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>'
  const RPR = '<w:rFonts w:ascii="Arial" w:eastAsia="黑体"/><w:sz w:val="21"/>'
  const cellP = (text: string) => `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr>${RPR}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  const tc = (text: string, w: number, extra = '') => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${extra}${SHD}</w:tcPr>${cellP(text)}</w:tc>`
  const TABLE = `<w:tbl>${TBL_PR}${GRID}`
    + `<w:tr><w:trPr><w:trHeight w:val="400"/></w:trPr>${tc('项目', 2000)}${tc('内容', 6000)}</w:tr>`
    + `<w:tr>${tc('甲', 2000, '<w:vMerge w:val="restart"/>')}${tc('第一行', 6000)}</w:tr>`
    + `<w:tr>${tc('', 2000, '<w:vMerge/>')}${tc('第二行', 6000)}</w:tr></w:tbl>`

  const setupTable = () => {
    const t = importInto(docx(TABLE))
    const tbl = t.docs.get(t.docId).child(0)
    return { ...t, tblId: tbl.attrs.id as string, cellPara: (r: number, c: number) => tbl.child(r).child(c).child(0).attrs.id as string }
  }

  it('改一个单元格：表格样式、列宽、行高、底纹、跨行合并与未改单元格原文全部保留；改过的格沿用段落与字体属性', () => {
    const t = setupTable()
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: t.cellPara(1, 1), find: '第一行', replace: '第一行（已改）' }] }, { actor: 'user', turnId: null })
    const body = bodyOf(t.exportNow().bytes)
    expect(body).toContain(TBL_PR)
    expect(body).toContain(GRID)
    expect(body).toContain('<w:trHeight w:val="400"/>')
    expect(body.match(/w:fill="D9E2F3"/g)!.length).toBe(6)
    expect(body).toContain(cellP('第二行'))
    expect(body).toContain(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr>${RPR}</w:rPr><w:t xml:space="preserve">第一行（已改）</w:t></w:r></w:p>`)
    expect(body).toContain('<w:vMerge w:val="restart"/>')
    expect(body).toContain('<w:vMerge/>')
    const back = importDocx(t.exportNow().bytes).doc.child(0)
    expect(back.child(1).child(0).attrs.rowspan).toBe(2)
  })

  it('加一行：新行沿用上方同列单元格的底纹与字体；合并区加高', () => {
    const t = setupTable()
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'table_insert_rows', id: t.tblId, at: 2, rows: [['', '新增行']] }] }, { actor: 'ai', turnId: null })
    const body = bodyOf(t.exportNow().bytes)
    expect(body).toContain(GRID)
    expect(body.match(/w:fill="D9E2F3"/g)!.length).toBe(8)
    expect(body).toContain(`<w:rPr>${RPR}</w:rPr><w:t xml:space="preserve">新增行</w:t>`)
    const back = importDocx(t.exportNow().bytes).doc.child(0)
    expect(back.child(1).child(0).attrs.rowspan).toBe(3)
    expect(back.childCount).toBe(4)
  })

  it('加一列：保留表格样式，按原表总宽平均分列宽', () => {
    const t = setupTable()
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'table_insert_cols', id: t.tblId, at: 2, cells: ['备注', '', ''] }] }, { actor: 'ai', turnId: null })
    const body = bodyOf(t.exportNow().bytes)
    expect(body).toContain(TBL_PR)
    expect(body.match(/<w:gridCol w:w="2666"\/>/g)!.length).toBe(3)
    expect(body).toContain('备注')
  })
})

describe('docx 导出：表格样式设定', () => {
  it('显式表头行数、列宽比例、底纹与垂直对齐写进 docx；单列表格显式设了表头也加', () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const ops = new OpService(docs)
    const row = docs.create({ owner: 'u', title: 't', content: schema.node('doc', null, parseBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n| 单列 |\n| --- |\n| x |')) })
    const t1 = docs.get(row.id).child(0).attrs.id as string
    const t2 = docs.get(row.id).child(1).attrs.id as string
    ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [
      { op: 'table_set_header', id: t1, rows: 2 },
      { op: 'table_set_style', id: t1, col_widths: [1, 3], cells: [{ row: 2, col: 1, background: 'FFEEAA', valign: 'bottom' }] },
      { op: 'table_set_header', id: t2, rows: 1 },
    ] }, { actor: 'ai', turnId: null })
    const out = exportDocx({ doc: docs.get(row.id), baseline: null, pkg: null, src: () => null, citations: [], comments: [], asset: () => null })
    const body = bodyOf(out.bytes)
    const [tbl1, tbl2] = body.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g)!
    expect(tbl1!.match(/<w:tblHeader\/>/g)!.length).toBe(2)
    expect(tbl1).toContain('<w:gridCol w:w="2250"/><w:gridCol w:w="6750"/>')
    expect(tbl1).toContain('<w:shd w:val="clear" w:color="auto" w:fill="FFEEAA"/><w:vAlign w:val="bottom"/>')
    expect(tbl2!.match(/<w:tblHeader\/>/g)!.length).toBe(1)
  })
})

describe('代码审查回归（2026-10-17）', () => {
  it('引用文本更新过：末尾的旧平台文献表按 DOI 认出，不会出现两份参考文献表', () => {
    const t = importInto(docx([
      p('心衰是常见病。'),
      p('参考文献', '<w:pStyle w:val="Heading1"/>'),
      p('[1] Doe J. Old title. N Engl J Med. 2020. doi:10.1056/x'),
    ].join('')))
    const c = t.store.upsertCitation({ doc_id: t.docId, doi: '10.1056/x', pmid: null, formatted: 'Doe J. New title. N Engl J Med. 2020. doi:10.1056/x', url: null })
    const para = t.docs.get(t.docId).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: para, find: '常见病', replace: `常见病[@c:${c.id}]` }] }, { actor: 'user', turnId: null })
    const body = bodyOf(t.exportNow().bytes)
    expect(body).not.toContain('Old title')
    expect(body.match(/参考文献/g)!.length).toBe(1)
    expect(body).toContain('[1] Doe J. New title')
  })

  it('显式表头后在上方插入普通行：不再重复表头；删掉开头的表头行：剩下的表头行照常重复', () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const ops = new OpService(docs)
    const row = docs.create({ owner: 'u', title: 't', content: schema.node('doc', null, parseBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')) })
    const tid = docs.get(row.id).child(0).attrs.id as string
    const edit = (op: Record<string, unknown>) => ops.edit({ doc_id: row.id, base_rev: docs.rev(row.id), mode: 'apply', ops: [{ id: tid, ...op } as never] }, { actor: 'ai', turnId: null })
    const headers = () => bodyOf(exportDocx({ doc: docs.get(row.id), baseline: null, pkg: null, src: () => null, citations: [], comments: [], asset: () => null }).bytes).match(/<w:tblHeader\/>/g)?.length ?? 0
    edit({ op: 'table_set_header', rows: 2 })
    expect(headers()).toBe(2)
    edit({ op: 'table_delete_rows', at: 0, count: 1 })
    expect(headers()).toBe(1)
    edit({ op: 'table_insert_rows', at: 0, rows: [['x', 'y']] })
    expect(headers()).toBe(0)
  })

  it('单元格段落改对齐：只覆盖 jc，原段落的样式、间距、缩进保留', () => {
    const PPR = '<w:pStyle w:val="TableText"/><w:spacing w:before="60"/><w:ind w:left="120"/>'
    const tbl = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:p><w:pPr>${PPR}</w:pPr><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
    const t = importInto(docx(tbl))
    const pid = t.docs.get(t.docId).child(0).child(0).child(0).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'set_block_style', id: pid, align: 'center' }] }, { actor: 'ai', turnId: null })
    expect(bodyOf(t.exportNow().bytes)).toContain(`<w:pPr>${PPR}<w:jc w:val="center"/></w:pPr>`)
  })
})

describe('docx 导出：原文 XML 的非标准写法与扩展属性', () => {
  it('单元格字体属性里的 w14 扩展元素全部保留（不同命名空间不互相覆盖），w: 元素在前', () => {
    const NS = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
    const rpr = `<w14:textOutline ${NS} w14:w="9525"/><w14:ligatures ${NS} w14:val="standard"/><w:sz w:val="21"/>`
    const tbl = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:rPr>${rpr}</w:rPr><w:t>甲乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
    const t = importInto(docx(tbl))
    const pid = t.docs.get(t.docId).child(0).child(0).child(0).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: pid, find: '乙', replace: '丙' }] }, { actor: 'user', turnId: null })
    const body = bodyOf(t.exportNow().bytes)
    const run = /<w:rPr>((?:(?!<\/w:rPr>)[\s\S])*)<\/w:rPr><w:t xml:space="preserve">甲丙/.exec(body)?.[1] ?? ''
    expect(run).toBe(`<w:sz w:val="21"/><w14:textOutline ${NS} w14:w="9525"/><w14:ligatures ${NS} w14:val="standard"/>`)
  })

  const SHD = (c: string) => `<w:shd w:val="clear" w:color="auto" w:fill="${c}"/>`
  const tc = (txt: string, extra: string, fill: string) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${extra}${SHD(fill)}</w:tcPr><w:p><w:r><w:t>${txt}</w:t></w:r></w:p></w:tc>`
  for (const [label, cont] of [['双引号', '<w:vMerge w:val="continue"/>'], ['单引号', "<w:vMerge w:val='continue'/>"], ['省略 val', '<w:vMerge/>'], ['非自闭合', '<w:vMerge></w:vMerge>']] as const) {
    it(`合并续行格写法（${label}）：导出端与导入端对齐，相邻格的格式不错位`, () => {
      const tbl = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>`
        + `<w:tr>${tc('合并', '<w:vMerge w:val="restart"/>', 'AAAAAA')}${tc('右上', '', 'BBBBBB')}</w:tr>`
        + `<w:tr>${tc('', cont, 'AAAAAA')}${tc('右下', '', 'CCCCCC')}</w:tr></w:tbl>`
      const t = importInto(docx(tbl))
      const pid = t.docs.get(t.docId).child(0).child(1).child(0).child(0).attrs.id as string
      t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: pid, find: '右下', replace: '右下改' }] }, { actor: 'user', turnId: null })
      const cells = bodyOf(t.exportNow().bytes).match(/<w:tc>[\s\S]*?<\/w:tc>/g)!
      const cell = cells.find(c => c.includes('右下改'))!
      expect(/w:fill="(\w+)"/.exec(cell)?.[1]).toBe('CCCCCC')
    })
  }

  it('表头标记与列宽用单引号写：仍识别为显式表头、沿用原列宽', () => {
    const row = (a: string, b: string, pr = '') => `<w:tr>${pr}<w:tc><w:p><w:r><w:t>${a}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>${b}</w:t></w:r></w:p></w:tc></w:tr>`
    const tbl = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w='1500'/><w:gridCol w:w='6500'/></w:tblGrid>`
      + row('很长很长的表头文字'.repeat(10), '列二', "<w:trPr><w:tblHeader w:val='1'/></w:trPr>") + row('数据1', '数据2') + '</w:tbl>'
    const t = importInto(docx(tbl))
    const pid = t.docs.get(t.docId).child(0).child(1).child(0).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: pid, find: '数据1', replace: '数据一' }] }, { actor: 'user', turnId: null })
    const body = bodyOf(t.exportNow().bytes)
    expect(body.match(/<w:tblHeader\/>/g)?.length).toBe(1)
    expect(body).toContain('<w:gridCol w:w="1500"/><w:gridCol w:w="6500"/>')
  })
})

describe('docx 导出：边框写在单元格上的表格（WPS / LibreOffice 生成）', () => {
  it('新加的列借同一行相邻单元格的边框与底纹，表头格借表头格', () => {
    const BORDERS = '<w:tcBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/></w:tcBorders>'
    const tc = (t: string, fill: string) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${BORDERS}<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/></w:tcPr><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`
    const tbl = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>${tc('指标', 'D9E2F3')}${tc('数值', 'D9E2F3')}</w:tr><w:tr>${tc('年龄', 'FFFFFF')}${tc('61', 'FFFFFF')}</w:tr></w:tbl>`
    const t = importInto(docx(tbl))
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'table_insert_cols', id: t.docs.get(t.docId).child(0).attrs.id as string, at: 2, cells: ['P 值', '0.81'] }] }, { actor: 'ai', turnId: null })
    const cells = bodyOf(t.exportNow().bytes).match(/<w:tc>[\s\S]*?<\/w:tc>/g)!
    const head = cells.find(c => c.includes('P 值'))!
    const body = cells.find(c => c.includes('0.81'))!
    expect(head).toContain('<w:tcBorders>')
    expect(head).toContain('w:fill="D9E2F3"')
    expect(body).toContain('<w:tcBorders>')
    expect(body).toContain('w:fill="FFFFFF"')
  })
})

