import { describe, expect, it } from 'vitest'
import { jatsToMarkdown } from '../scripts/eval-jats.ts'
import { extractTableSummaries } from '../src/claims/extract.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'

const XML = `<?xml version="1.0"?>
<article xmlns:xlink="http://www.w3.org/1999/xlink">
<front><article-meta>
  <title-group><article-title>Metformin in <italic>type 1</italic> diabetes</article-title></title-group>
  <abstract abstract-type="graphical"><p>Graphical abstract text</p></abstract>
  <abstract>
    <sec><title>Background</title><p>Insulin resistance is common.</p></sec>
    <sec><title>Results</title><p>We enrolled 412 participants; HR 0.72 (95% CI 0.58–0.89).</p></sec>
  </abstract>
</article-meta></front>
<body>
  <sec><title>Introduction</title>
    <p>Prior trials were mixed.<sup><xref ref-type="bibr" rid="r1">1</xref>,<xref ref-type="bibr" rid="r2">2</xref></sup> Others disagreed [<xref ref-type="bibr" rid="r3">3</xref>] and some <xref ref-type="bibr" rid="r1">1</xref> did not.</p>
    <p>1. This sentence starts like a list and has *stars* and a cell | pipe.</p>
  </sec>
  <sec><title>Methods</title>
    <sec><title>Statistical analysis</title>
      <p>Counts were 5 × 10<sup>9</sup>/L. See <xref ref-type="table" rid="t1">Table 1</xref>.
        <table-wrap id="t1"><label>Table 1</label><caption><title>Baseline characteristics</title></caption>
          <table>
            <thead>
              <tr><th rowspan="2">Variable</th><th colspan="2">Group</th></tr>
              <tr><th>A (n=206)</th><th>B (n=206)</th></tr>
            </thead>
            <tbody>
              <tr><td>Male, n (%)</td><td>124 (60.2)</td><td>118 (57.3)</td></tr>
              <tr><td>^</td><td>a|b</td><td></td></tr>
            </tbody>
          </table>
          <table-wrap-foot><fn><p>Data are n (%).</p></fn></table-wrap-foot>
        </table-wrap>
      After the table.</p>
    </sec>
  </sec>
  <sec><title>Results</title>
    <fig id="f1"><label>Figure 1</label><caption><p>Kaplan–Meier curves.</p></caption></fig>
  </sec>
</body>
<back>
  <glossary><title>Abbreviations</title><def-list>
    <def-item><term>HR</term><def><p>hazard ratio</p></def></def-item>
  </def-list></glossary>
  <ref-list><title>References</title>
    <ref id="r1"><label>1</label><mixed-citation>Smith J. A trial. Lancet. 2020;1:1–2.</mixed-citation></ref>
    <ref id="r2"><label>2.</label><element-citation><person-group><name><surname>Lee</surname><given-names>K</given-names></name></person-group><article-title>Another</article-title><source>BMJ</source><year>2021</year><volume>3</volume><fpage>10</fpage><pub-id pub-id-type="doi">10.1/x</pub-id></element-citation></ref>
    <ref id="r3"><mixed-citation>Wu L. Third. JAMA. 2022.</mixed-citation></ref>
  </ref-list>
</back>
</article>`

describe('JATS → 平台 markdown（深度审稿评测语料）', () => {
  const { title, markdown, stats } = jatsToMarkdown(XML)

  it('标题、结构化摘要写成段落前缀，不另起标题', () => {
    expect(title).toBe('Metformin in type 1 diabetes')
    expect(markdown).toContain('# Metformin in type 1 diabetes')
    expect(markdown).toContain('## Abstract')
    expect(markdown).toContain('Background: Insulin resistance is common.')
    expect(markdown).not.toContain('Graphical abstract')
    expect(markdown).not.toMatch(/^#+ Background$/m)
  })

  it('引用：上标整组补方括号，原文自带括号保持，无括号数字补括号', () => {
    expect(markdown).toContain('Prior trials were mixed.[1,2]')
    expect(markdown).toContain('Others disagreed [3]')
    expect(markdown).toContain('some [1] did not')
    expect(stats.citations).toBe(4)
  })

  it('非引用上标写成 ^，段首块级标记与强调符号被转义', () => {
    expect(markdown).toContain('5 × 10^9/L')
    expect(markdown).toContain('\\1. This sentence')
    expect(markdown).toContain('\\*stars\\*')
  })

  it('嵌套章节按层级出标题；段内表格拆成独立块，表题在前、表注在后', () => {
    expect(markdown).toContain('## Methods')
    expect(markdown).toContain('### Statistical analysis')
    const iCap = markdown.indexOf('Table 1. Baseline characteristics')
    const iTable = markdown.indexOf('| Variable |')
    const iFoot = markdown.indexOf('Data are n (%).')
    const iAfter = markdown.indexOf('After the table.')
    expect(iCap).toBeGreaterThan(-1)
    expect(iCap).toBeLessThan(iTable)
    expect(iTable).toBeLessThan(iFoot)
    expect(iFoot).toBeLessThan(iAfter)
    expect(markdown).toContain('Figure 1. Kaplan–Meier curves.')
    expect(markdown).toContain('HR: hazard ratio')
  })

  it('文献表：label 去掉标点，element-citation 拼成一行，没有 label 的按序号', () => {
    expect(markdown).toContain('## References')
    expect(markdown).toContain('[1] Smith J. A trial. Lancet. 2020;1:1–2.')
    expect(markdown).toContain('[2] Lee K. Another. BMJ. 2021;3:10. doi:10.1/x.')
    expect(markdown).toContain('[3] Wu L. Third. JAMA. 2022.')
    expect(stats.references).toBe(3)
  })

  it('平台能导入：合并单元格保留，单元格里的 ^ 与 | 被转义，审稿代码能读到表题与分组人数', () => {
    expect(stats.tables).toBe(1)
    expect(stats.tablesFlattened).toBe(0)
    const docs = new Documents(new Store(':memory:'))
    const row = docs.create({ owner: 'u', title, markdown })
    const doc = docs.get(row.id)
    let table: any = null
    doc.descendants(n => { if (n.type.name === 'table') table = n; return !table })
    expect(table).toBeTruthy()
    const first = table.child(0)
    expect(first.child(0).attrs.rowspan).toBe(2)
    expect(first.child(1).attrs.colspan).toBe(2)
    expect(table.textContent).toContain('a|b')
    expect(table.child(3).child(0).textContent).toBe('^')
    const [summary] = extractTableSummaries(doc)
    expect(summary!.caption).toBe('Table 1. Baseline characteristics')
    expect(summary!.sample_sizes).toEqual([206])
  })

  it('floats-group 里的表格放到正文第一次引用它的段落之后，未引用的放在正文末尾', () => {
    const xml = `<article><front><article-meta><title-group><article-title>T</article-title></title-group></article-meta></front>
      <body><sec><title>Results</title><p>First para.</p><p>See <xref ref-type="table" rid="t1">Table 1</xref>.</p><p>Last para.</p></sec></body>
      <back><notes><p>Publisher's note.</p></notes></back>
      <floats-group>
        <table-wrap id="t1"><label>Table 1</label><caption><p>Cited.</p></caption><table><tr><th>a</th></tr><tr><td>1</td></tr></table></table-wrap>
        <fig id="f9"><label>Figure 9</label><caption><p>Never cited.</p></caption></fig>
      </floats-group></article>`
    const { markdown: md, stats: st } = jatsToMarkdown(xml)
    expect(st.tables).toBe(1)
    expect(md.indexOf('See Table 1.')).toBeLessThan(md.indexOf('Table 1. Cited.'))
    expect(md.indexOf('Table 1. Cited.')).toBeLessThan(md.indexOf('Last para.'))
    expect(md.indexOf('Last para.')).toBeLessThan(md.indexOf('Figure 9. Never cited.'))
    expect(md).not.toContain("Publisher's note")
  })

  it('相邻引用补分隔符不粘成一个数；脚注标记不与单词粘连；摘要小节里的列表保留；章节编号写进标题', () => {
    const xml = `<article><front><article-meta><title-group><article-title>T</article-title></title-group>
      <abstract abstract-type="summary"><title>Author summary</title><sec><title>Why was this study done?</title>
        <list list-type="bullet"><list-item><p>Because obesity is common.</p></list-item></list></sec></abstract>
      <abstract><p>Main abstract.</p></abstract></article-meta></front>
      <body><sec><label>2.1</label><title>Study design</title>
        <p>Reduce salt (<xref ref-type="bibr" rid="b12">12</xref><xref ref-type="bibr" rid="b42">42</xref>).</p>
        <table-wrap id="t1"><label>Table 1</label><table><tr><th>a</th></tr><tr><td>1</td></tr></table>
          <table-wrap-foot><fn id="f1"><p><sup>c</sup>Average of both ovaries.</p><p>Second paragraph.</p></fn></table-wrap-foot></table-wrap>
      </sec></body></article>`
    const { markdown: md } = jatsToMarkdown(xml)
    expect(md).toContain('Reduce salt (12, 42).')
    expect(md).not.toContain('1242')
    expect(md).toContain('^c Average of both ovaries. Second paragraph.')
    expect(md).toContain('## Author summary')
    expect(md).toContain('Why was this study done?')
    expect(md).toContain('- Because obesity is common.')
    expect(md).toContain('## Abstract')
    expect(md).toContain('Main abstract.')
    expect(md).toContain('## 2.1 Study design')
  })

  it('保真度检查：转换正确时全部通过；数字被改动、表格单元格错位时能查出来', async () => {
    const { checkFidelity } = await import('../scripts/eval-jats-check.ts')
    const good = checkFidelity(XML, markdown)
    expect(good.missingNumbers).toEqual([])
    expect(good.tables.mismatched).toEqual([])
    expect(good.missingHeadings).toEqual([])
    expect(good.escapeResidue).toEqual([])
    expect(good.ok).toBe(true)
    // 把摘要里的 412 改掉、表格里两格对调：都应被发现
    const broken = markdown.replace('412 participants', '421 participants').replace('| 124 (60.2) | 118 (57.3) |', '| 118 (57.3) | 124 (60.2) |')
    const bad = checkFidelity(XML, broken)
    expect(bad.missingNumbers.map(x => x.token)).toContain('412')
    expect(bad.extraNumbers.map(x => x.token)).toContain('421')
    expect(bad.tables.mismatched).toHaveLength(1)
    expect(bad.ok).toBe(false)
    expect(good.extraNumbers).toEqual([])
  })

  it('文献条目：citation-alternatives 里取 mixed-citation；相邻元素之间补空格，PMID / DOI / 页码不粘连', () => {
    const xml = `<article><front><article-meta><title-group><article-title>T</article-title></title-group></article-meta></front>
      <body><p>x</p></body><back><ref-list>
        <ref id="b1"><citation-alternatives><element-citation><year>2017</year></element-citation>
          <mixed-citation><person-group><name><surname>Roe</surname></name></person-group>. <source>NEJM</source>. <year>2017</year>;<volume>376</volume>:<fpage>1407</fpage><pub-id pub-id-type="pmid">10863216</pub-id><pub-id pub-id-type="pmid">38350885</pub-id><pub-id pub-id-type="doi">10.1056/x</pub-id></mixed-citation>
        </citation-alternatives></ref></ref-list></back></article>`
    const { markdown: md } = jatsToMarkdown(xml)
    expect(md).toContain('[1] Roe. NEJM. 2017;376:1407 10863216 38350885 10.1056/x')
    expect(md).not.toMatch(/1086321638350885/)
    // 文字以「195.」结尾、后面紧跟 DOI：补空格，不拼成假小数
    const xml2 = xml.replace('<fpage>1407</fpage>', '<fpage>195</fpage>.').replace(/<pub-id pub-id-type="pmid">\d+<\/pub-id>/g, '')
    expect(jatsToMarkdown(xml2).markdown).toContain('195. 10.1056/x')
  })

  it('文献表放在正文「References」章节里（没有 back）时，章节标题不重复、条目照常输出', () => {
    const xml = `<article><front><article-meta><title-group><article-title>T</article-title></title-group></article-meta></front>
      <body><sec><title>Discussion</title><p>Text [<xref ref-type="bibr" rid="b1">1</xref>].</p></sec>
        <sec><title>References</title><ref-list><ref id="b1"><label>1.</label><mixed-citation>Doe J. X. 2020.</mixed-citation></ref></ref-list></sec></body></article>`
    const { markdown: md, stats: st } = jatsToMarkdown(xml)
    expect(st.references).toBe(1)
    expect(md.match(/^## References$/gm)).toHaveLength(1)
    expect(md).toContain('[1] Doe J. X. 2020.')
    expect(st.unknown).toEqual({})
  })
})
