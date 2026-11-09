import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { auditInternalConsistency, extractTableSummaries } from '../src/claims/extract.ts'
import { exportDocx } from '../src/convert/docx-export.ts'
import { formatNumber, importDocx } from '../src/convert/docx-import.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
import { docx, p } from './fixtures.ts'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

// 期刊模板的常见写法：编号挂在「标题 1/2」样式上，numbering.xml 的层级用 pStyle 关联样式
const STYLES = strToU8(`<?xml version="1.0"?><w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:numPr><w:numId w:val="5"/></w:numPr></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr></w:style>
</w:styles>`)
const NUMBERING = strToU8(`<?xml version="1.0"?><w:numbering ${W}>
  <w:abstractNum w:abstractNumId="3">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading1"/><w:lvlText w:val="%1."/></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:pStyle w:val="Heading2"/><w:lvlText w:val="%1.%2"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="4"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1"/></w:lvl></w:abstractNum>
  <w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num>
  <w:num w:numId="6"><w:abstractNumId w:val="4"/></w:num>
  <w:num w:numId="7"><w:abstractNumId w:val="4"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride></w:num>
</w:numbering>`)
const files = { 'word/styles.xml': STYLES, 'word/numbering.xml': NUMBERING }

const h1 = (t: string, extra = '') => p(t, `<w:pStyle w:val="Heading1"/>${extra}`)
const h2 = (t: string) => p(t, '<w:pStyle w:val="Heading2"/>')
const headings = (bytes: Uint8Array) => {
  const out: Array<[string | null, string]> = []
  importDocx(bytes).doc.forEach(n => { if (n.type.name === 'heading') out.push([n.attrs.number as string | null, n.textContent]) })
  return out
}

describe('投稿稿件常见的 Word 结构', () => {
  it('标题自动编号：样式上的编号按层级计数，下级在上级变化时重新开始；numId 0 取消编号；重新编号覆盖起始值', () => {
    const body = [
      h1('Abstract', '<w:numPr><w:numId w:val="0"/></w:numPr>'), // 摘要不编号
      h1('Introduction'), h1('Methods'), h2('Study design'), h2('Statistical analysis'), h1('Results'), h2('Baseline'),
      p('Part', '<w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="6"/></w:numPr>'),
      p('Restarted', '<w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr>'),
    ].join('')
    expect(headings(docx(body, { files }))).toEqual([
      [null, 'Abstract'], ['1.', 'Introduction'], ['2.', 'Methods'], ['2.1', 'Study design'], ['2.2', 'Statistical analysis'],
      ['3.', 'Results'], ['3.1', 'Baseline'], ['I', 'Part'], ['III', 'Restarted'],
    ])
  })

  it('编号格式化：字母、罗马数字、补零、中文', () => {
    expect([formatNumber(28, 'lowerLetter'), formatNumber(14, 'upperRoman'), formatNumber(4, 'decimalZero'), formatNumber(23, 'chineseCounting'), formatNumber(10, 'chineseCounting')])
      .toEqual(['ab', 'XIV', '04', '二十三', '十'])
  })

  it('EndNote 引文域与题注 SEQ 域：显示结果算正文文字，指令不进正文；带 SEQ 域的表题仍能被审稿识别', () => {
    const cite = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE &lt;EndNote&gt;&lt;Cite&gt;&lt;RecNum&gt;7&lt;/RecNum&gt;&lt;/Cite&gt;&lt;/EndNote&gt;</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>[12]</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
    const body = [
      `<w:p><w:r><w:t xml:space="preserve">Prior work found 25% </w:t></w:r>${cite}<w:r><w:t>.</w:t></w:r></w:p>`,
      '<w:p><w:r><w:t xml:space="preserve">Table </w:t></w:r><w:fldSimple w:instr=" SEQ Table \\* ARABIC "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t>. Baseline characteristics</w:t></w:r></w:p>',
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Variable</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>All (n=120)</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Male</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>60 (50%)</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ].join('')
    const doc = importDocx(docx(body)).doc
    expect(doc.child(0).textContent).toBe('Prior work found 25% [12].')
    expect(doc.textContent).not.toMatch(/ADDIN|EndNote|SEQ/)
    expect(extractTableSummaries(doc)[0]!.caption).toBe('Table 1. Baseline characteristics')
  })

  it('修订：被删除的旧数字只作为待采纳修订保留，审稿核查只看采纳后的文字', () => {
    const body = [
      '<w:p><w:r><w:t xml:space="preserve">We enrolled </w:t></w:r><w:del w:id="1" w:author="A"><w:r><w:delText>400</w:delText></w:r></w:del><w:ins w:id="2" w:author="A"><w:r><w:t>120</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> patients.</w:t></w:r></w:p>',
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Variable</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>All (n=120)</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Male</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>60 (50%)</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ].join('')
    const doc = importDocx(docx(body)).doc
    expect([doc.child(0).attrs.suggest, doc.child(0).textContent]).toEqual(['delete', 'We enrolled 400 patients.'])
    expect([doc.child(1).attrs.suggest, doc.child(1).textContent]).toEqual(['insert', 'We enrolled 120 patients.'])
    // 旧数字 400 与表格 n=120 不一致，但它已被删除：不应报「正文与表格样本量不一致」
    expect(auditInternalConsistency(doc).map(i => i.subtype)).not.toContain('prose_table_sample_size_mismatch')
  })

  it('文本框里的文字完整保留（不截断），算正文文字', () => {
    const long = 'Table 2. Multivariable Cox regression for overall survival adjusted for age, sex, stage, ECOG performance status and smoking history (n = 184)'
    const body = `<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent><w:p><w:r><w:t>${long}</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
    const doc = importDocx(docx(body)).doc
    expect(doc.textContent).toContain('(n = 184)')
    // 文本框里带题注域与修订删除：只算显示出来的文字
    const mixed = `<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent><w:p><w:r><w:t xml:space="preserve">Table </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> SEQ Table \\* ARABIC </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:del w:id="1" w:author="A"><w:r><w:delText> old 999</w:delText></w:r></w:del><w:r><w:t>. Outcomes</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
    const t = importDocx(docx(mixed)).doc.textContent
    expect(t).toBe('Table 3. Outcomes')
  })

  it('导出往返：带自动编号的标题导出后（含 AI 改写标题）不会出现重复编号，编号仍由 Word 生成', () => {
    const bytes = docx([h1('Introduction'), h1('Methods'), h2('Study design')].join(''), { files })
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const r = importDocx(bytes)
    const row = docs.create({ owner: 'u', title: 't', content: r.doc, source: 'import' })
    store.putNodeSrc(row.id, r.src)
    store.putPackage(row.id, 'docx', bytes)
    let design: string | null = null
    docs.get(row.id).forEach(n => { if (n.textContent === 'Study design') design = n.attrs.id as string })
    new OpService(docs).edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: design!, find: 'Study design', replace: 'Study design and setting' }] }, { actor: 'ai', turnId: 't1' })
    const out = exportDocx({
      doc: docs.get(row.id), baseline: docs.versionDoc(row.id, 1), pkg: bytes,
      src: id => store.getNodeSrc(row.id, id), citations: store.listCitations(row.id), comments: store.listComments(row.id), asset: () => null,
    }).bytes
    const xml = strFromU8(unzipSync(out)['word/document.xml']!)
    expect(xml).not.toMatch(/<w:t[^>]*>\s*2\.1/)
    expect(headings(out)).toEqual([['1.', 'Introduction'], ['2.', 'Methods'], ['2.1', 'Study design and setting']])
  })
})
