/**
 * 平台引用写回 Word 时，按稿件原来用的文献管理软件写成它认得的引用域：
 *
 * - EndNote 稿件：`ADDIN EN.CITE`，域指令里带完整题录（EndNote 的「随文题录」），作者在 Word 里点
 *   「Update Citations and Bibliography」时按自己的样式重新编号、写进参考文献表；
 * - Zotero 稿件：`ADDIN ZOTERO_ITEM CSL_CITATION`，带 itemData（文档里的条目不在作者的文库里时 Zotero 用它）；
 * - 其他稿件：仍是纯文字编号（由导出器合并进原参考文献表）。
 *
 * 显示文字（如「[30]」）沿用稿件现有引用的样式（方括号 / 圆括号 / 上标），软件更新时会改成正确的编号。
 * 题录从登记引用时保存的格式化文本解析（AMA / Vancouver 一类：作者. 题目. 期刊. 年;卷(期):页. doi:…）。
 */

export type CitationManager = 'endnote' | 'zotero' | null
export type CiteStyle = 'bracket' | 'paren' | 'sup'

export interface ParsedRef {
  authors: Array<{ family: string; given: string }>
  title: string
  journal: string
  year: string
  volume: string
  issue: string
  pages: string
  doi: string
  pmid: string | null
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 稿件用的文献管理软件与引用显示样式（看原 document.xml 里的引用域）。 */
export function detectCitationManager(documentXml: string | null): { manager: CitationManager; style: CiteStyle } {
  if (!documentXml) return { manager: null, style: 'bracket' }
  const en = documentXml.indexOf('ADDIN EN.CITE')
  const zo = documentXml.indexOf('ADDIN ZOTERO_ITEM')
  const manager: CitationManager = en >= 0 && (zo < 0 || en < zo) ? 'endnote' : zo >= 0 ? 'zotero' : null
  let style: CiteStyle = 'bracket'
  if (manager) {
    // 第一个引用域的显示文字：separate 之后的第一段文字与它的 run 属性
    const at = manager === 'endnote' ? en : zo
    const sep = documentXml.indexOf('w:fldCharType="separate"', at)
    if (sep > 0) {
      const run = /<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:t\b[^>]*>([^<]*)<\/w:t>/.exec(documentXml.slice(sep))
      const shown = run?.[1]?.trim() ?? ''
      style = shown.startsWith('(') ? 'paren' : shown.startsWith('[') ? 'bracket' : /superscript/.test(run?.[0] ?? '') || /^\d/.test(shown) ? 'sup' : 'bracket'
    }
  }
  return { manager, style }
}

export const displayText = (n: number | string, style: CiteStyle) => style === 'paren' ? `(${n})` : style === 'sup' ? String(n) : `[${n}]`

/** 从格式化文本解析题录（解析不出的字段留空，题目退回整段文字）。 */
export function parseFormatted(formatted: string, doi: string, pmid: string | null): ParsedRef {
  const text = formatted.replace(/\s+/g, ' ').trim()
  const out: ParsedRef = { authors: [], title: '', journal: '', year: '', volume: '', issue: '', pages: '', doi, pmid }
  // 期刊. 年;卷(期):页
  const tail = /\.\s+([^.]+?)\.?\s+((?:19|20)\d\d)(?:\s*[A-Za-z]{3}(?:\s+\d{1,2})?)?\s*[;.](?:\s*(\d+)(?:\((\w+)\))?(?::\s*([\w-–]+))?)?/.exec(text)
  const firstDot = text.indexOf('. ')
  const authorPart = firstDot > 0 ? text.slice(0, firstDot) : ''
  if (authorPart && authorPart.length < 400 && /[A-Z]/.test(authorPart)) {
    for (const a of authorPart.split(/,\s*/)) {
      const t = a.trim()
      if (!t || /^et al\.?$/i.test(t)) continue
      const m = /^(.+?)\s+([A-Z]{1,4})$/.exec(t)
      out.authors.push(m ? { family: m[1]!, given: m[2]! } : { family: t, given: '' })
    }
  }
  if (tail) {
    out.journal = tail[1]!.trim()
    out.year = tail[2]!
    out.volume = tail[3] ?? ''
    out.issue = tail[4] ?? ''
    out.pages = (tail[5] ?? '').replace(/–/g, '-')
    const titleStart = firstDot > 0 ? firstDot + 2 : 0
    out.title = text.slice(titleStart, tail.index).trim().replace(/\.$/, '')
  }
  if (!out.title) out.title = text
  return out
}

/** EndNote 的引用域指令（随文题录）。recNum：EndNote 用它与随文题录对应；与作者文库里的号不同也无妨，更新时按内容匹配。 */
export function endnoteInstr(ref: ParsedRef, recNum: number, display: string): string {
  const au = ref.authors.map(a => `<author>${xmlEsc(a.given ? `${a.family}, ${a.given}` : a.family)}</author>`).join('')
  const pages = ref.pages ? `<pages>${xmlEsc(ref.pages)}</pages>` : ''
  const record = `<record><rec-number>${recNum}</rec-number><ref-type name="Journal Article">17</ref-type><contributors><authors>${au}</authors></contributors>`
    + `<titles><title>${xmlEsc(ref.title)}</title>${ref.journal ? `<secondary-title>${xmlEsc(ref.journal)}</secondary-title>` : ''}</titles>`
    + (ref.journal ? `<periodical><full-title>${xmlEsc(ref.journal)}</full-title></periodical>` : '')
    + pages + (ref.volume ? `<volume>${xmlEsc(ref.volume)}</volume>` : '') + (ref.issue ? `<number>${xmlEsc(ref.issue)}</number>` : '')
    + (ref.year ? `<dates><year>${xmlEsc(ref.year)}</year></dates>` : '')
    + (ref.pmid ? `<accession-num>${xmlEsc(ref.pmid)}</accession-num>` : '')
    + (ref.doi ? `<electronic-resource-num>${xmlEsc(ref.doi)}</electronic-resource-num>` : '')
    + '</record>'
  const first = ref.authors[0]?.family ?? ''
  return ` ADDIN EN.CITE <EndNote><Cite><Author>${xmlEsc(first)}</Author><Year>${xmlEsc(ref.year)}</Year><RecNum>${recNum}</RecNum><DisplayText>${xmlEsc(display)}</DisplayText>${record}</Cite></EndNote>`
}

/** Zotero 的引用域指令（CSL_CITATION，带 itemData；uris 留空：条目不在作者文库里时 Zotero 用随文数据）。 */
export function zoteroInstr(ref: ParsedRef, itemId: number, citationId: string, display: string): string {
  const item: Record<string, unknown> = { id: itemId, type: 'article-journal', title: ref.title }
  if (ref.journal) item['container-title'] = ref.journal
  if (ref.volume) item.volume = ref.volume
  if (ref.issue) item.issue = ref.issue
  if (ref.pages) item.page = ref.pages
  if (ref.doi) item.DOI = ref.doi
  if (ref.pmid) item.PMID = ref.pmid
  if (ref.authors.length) item.author = ref.authors.map(a => ({ family: a.family, given: a.given }))
  if (ref.year) item.issued = { 'date-parts': [[ref.year]] }
  const data = {
    citationID: citationId,
    properties: { formattedCitation: display, plainCitation: display, noteIndex: 0 },
    citationItems: [{ id: itemId, uris: [], itemData: item }],
    schema: 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json',
  }
  return ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(data)} `
}

/** 一个完整的复杂域：begin、指令、separate、显示文字（run 属性 rPr）、end。 */
export function fieldRuns(instr: string, display: string, rPr: string): string {
  return '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    + `<w:r><w:instrText xml:space="preserve">${xmlEsc(instr)}</w:instrText></w:r>`
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    + `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(display)}</w:t></w:r>`
    + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
}

/** 参考文献表现有条目的编号格式（「29.」+ 制表符、「29. 」「29、」「[29] 」），新条目照着写。 */
export function entryPrefix(lastEntryText: string | null, n: number): { text: string; tab: boolean } {
  const t = lastEntryText ?? ''
  // 「29.」「29、」「29．」：分隔符与后面的空白（制表符单独写成 w:tab）照抄
  const m = /^\d+([.、．])([ \t]*)/.exec(t)
  if (m) return m[2]!.includes('\t') ? { text: `${n}${m[1]}`, tab: true } : { text: `${n}${m[1]}${m[2]}`, tab: false }
  const b = /^([[［【])\d+([\]］】])(\s*)/.exec(t)
  if (b) return { text: `${b[1]}${n}${b[2]}${b[3] || ' '}`, tab: false }
  return { text: `[${n}] `, tab: false }
}
