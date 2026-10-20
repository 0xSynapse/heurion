/**
 * v2 压力任务 S1：复杂期刊模板（ANALYSIS_PLAN_v2 §2.2）。
 * 在 manuscripts/data/docx 的期刊格式稿件上，用程序加入投稿须知常见的版式特征（特征清单先于模板写定）：
 *   编号列表、合并单元格的表头、表题域代码（SEQ）、脚注、合作者留下的修订痕迹、合作者的 Word 批注、分节符。
 * 文字全部来自原文（编号列表由方法部分一段的句子拆成），只改版式；返回每个特征所在段落的首句，供任务与判定定位。
 */
import { strFromU8, strToU8 } from '../../../apps/platform/node_modules/fflate/esm/browser.js'
import * as D from '../exp3/docx.ts'

const DOC = 'word/document.xml'
const RPR = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/><w:szCs w:val="24"/>'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const doc = (pkg: D.Pkg) => D.docXml(pkg)
const withDoc = (pkg: D.Pkg, xml: string): D.Pkg => ({ ...pkg, [DOC]: strToU8(xml) })
const text = (pkg: D.Pkg, part: string) => (pkg[part] ? strFromU8(pkg[part]) : null)

/** 合作者姓名（虚构）。 */
export const COAUTHOR = 'Li Ming'
export const COAUTHOR_COMMENT = 'Please state the exact follow-up window here.'
export const FOOTNOTE_TEXT = 'Data sources and definitions follow the original study protocol.'

export interface TemplateFeatures {
  /** 由方法部分一段拆成的编号列表各项（原文句子）。 */
  list: { items: string[]; numId: string }
  /** 第一张表：表头第一格文字与跨列格文字。 */
  table: { firstHeader: string; spanText: string; columns: number }
  /** 表题（以 “Table n” 开头的段落）首句。 */
  captions: string[]
  /** 带脚注的段落首句与脚注挂的短语。 */
  footnote: { para: string; phrase: string }
  /** 合作者修订：所在段落首句、被删与插入的文字。 */
  tracked: { para: string; del: string; ins: string }
  /** 合作者批注：所在段落首句与锚定短语。 */
  comment: { para: string; snippet: string }
  /** 分节符所在段落（参考文献标题之前的最后一段）首句。 */
  sectionBreakPara: string
}

/** 一节的正文段落（二级标题 title 之后到下一个同级或更高级标题）。 */
function sectionBody(pkg: D.Pkg, title: RegExp): D.Para[] {
  const ps = D.paras(doc(pkg))
  const i = ps.findIndex(p => D.headingLevel(p) === 2 && title.test(p.text.trim()))
  if (i < 0) return []
  const j = ps.findIndex((p, k) => k > i && D.headingLevel(p) > 0 && D.headingLevel(p) <= 2)
  return ps.slice(i + 1, j < 0 ? undefined : j).filter(isProse)
}

/** 正文段落：至少两句、25 个词以上、含可用短语；排除图表题、缩写说明与方案罗列。 */
function isProse(p: D.Para): boolean {
  if (D.headingLevel(p) !== 0 || p.xml.includes('w:numPr') || p.text.length <= 120) return false
  if (/^(Table|Figure|Fig\.?)\s*\d/.test(p.text) || /^Abbreviations?\b/i.test(p.text)) return false
  if (/^([A-Z][A-Za-z0-9-]*\s[^,.;]{2,40}[,;]\s*){3,}/.test(p.text)) return false
  if (sentences(p.text).length < 2 || p.text.split(/\s+/).length < 25) return false
  try { phraseIn(p, 'start'); return true } catch { return false }
}

const METHODS = /^(materials? and )?(methods?|patients and methods|methodology)\b/i
const RESULTS = /^results\b/i
const DISCUSSION = /^discussion\b/i

/** 段落末尾附近一段只含字母与空格、落在同一个 run 里的短语。 */
function phraseIn(p: D.Para, from: 'start' | 'end'): string {
  const runs = [...p.xml.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]!)
  const cands = runs.flatMap(t => [...t.matchAll(/[A-Za-z][A-Za-z ]{18,58}[A-Za-z]/g)].map(m => m[0]).filter(x => x.split(' ').length >= 4))
  if (!cands.length) throw new Error(`段落里找不到合适的短语：${p.text.slice(0, 60)}`)
  return from === 'end' ? cands[cands.length - 1]! : cands[0]!
}

const sentences = (s: string) => s.split(/(?<=[.;])\s+(?=[A-Z(])/).map(x => x.trim()).filter(x => x.length > 20)
const lead = (p: D.Para | string) => (typeof p === 'string' ? p : p.text).slice(0, 60)

let paraSeq = 0
const paraId = () => (0x5e000000 + ++paraSeq).toString(16).toUpperCase()

/** F1 编号列表：方法部分第一段有 ≥3 句的正文拆成编号列表（新增 decimal 编号定义）。 */
function numberedList(pkg: D.Pkg): [D.Pkg, TemplateFeatures['list']] {
  const p = sectionBody(pkg, METHODS).find(x => sentences(x.text).length >= 3 && sentences(x.text).length <= 8)
  if (!p) throw new Error('方法部分没有可拆成列表的段落')
  const items = sentences(p.text)
  const numId = '9101'
  const listXml = items.map(s => `<w:p w14:paraId="${paraId()}" w14:textId="77777777"><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:r><w:rPr>${RPR}</w:rPr><w:t xml:space="preserve">${esc(s)}</w:t></w:r></w:p>`).join('')
  let out = withDoc(pkg, doc(pkg).replace(p.xml, listXml))
  const abstract = `<w:abstractNum w:abstractNumId="${numId}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`
  const num = `<w:num w:numId="${numId}"><w:abstractNumId w:val="${numId}"/></w:num>`
  const numbering = text(out, 'word/numbering.xml')!
  const firstNum = numbering.search(/<w:num\b/)
  const next = (firstNum < 0 ? numbering.replace('</w:numbering>', abstract + '</w:numbering>') : numbering.slice(0, firstNum) + abstract + numbering.slice(firstNum)).replace('</w:numbering>', num + '</w:numbering>')
  out = { ...out, 'word/numbering.xml': strToU8(next) }
  return [out, { items, numId }]
}

/** F2 合并单元格表头：第一张表上方加一行，第一格与原表头第一格纵向合并，其余列合并成一个跨列格。 */
function mergedHeader(pkg: D.Pkg): [D.Pkg, TemplateFeatures['table']] {
  const xml = doc(pkg)
  const tbl = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(xml)
  if (!tbl) throw new Error('稿件里没有表格')
  const firstRow = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/.exec(tbl[0])!
  const cells = [...firstRow[0].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)]
  if (cells.length < 3) throw new Error('第一张表列数太少')
  const firstHeader = D.paras(cells[0]![0]).map(p => p.text).join('').trim()
  const spanText = 'Study groups'
  const cell = (tcPr: string, t: string) => `<w:tc><w:tcPr>${tcPr}</w:tcPr><w:p w14:paraId="${paraId()}" w14:textId="77777777"><w:r><w:rPr>${RPR}<w:b/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p></w:tc>`
  const top = `<w:tr>${cell('<w:vMerge w:val="restart"/>', firstHeader)}${cell(`<w:gridSpan w:val="${cells.length - 1}"/>`, spanText)}</w:tr>`
  // 原表头第一格改为纵向合并的延续格（文字移到上方的起始格）
  const contCell = `<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p w14:paraId="${paraId()}" w14:textId="77777777"/></w:tc>`
  const newFirstRow = firstRow[0].replace(cells[0]![0], contCell)
  const newTbl = tbl[0].replace(firstRow[0], top + newFirstRow)
  return [withDoc(pkg, xml.replace(tbl[0], newTbl)), { firstHeader, spanText, columns: cells.length }]
}

/** F3 表题域代码：“Table n.” 的编号改为 SEQ 域。 */
function captionFields(pkg: D.Pkg): [D.Pkg, string[]] {
  let xml = doc(pkg)
  const captions: string[] = []
  for (const p of D.paras(xml).filter(x => /^Table \d+/.test(x.text))) {
    // 表题首个 run 以 “Table n” 开头（后面可能接 “.”、“:” 或标题文字）
    const run = /<w:r\b[^>]*><w:rPr>((?:(?!<\/w:rPr>)[\s\S])*)<\/w:rPr><w:t xml:space="preserve">Table (\d+)([^<]*)<\/w:t><\/w:r>/.exec(p.xml)
    if (!run) continue
    const rpr = run[1]!
    const r = (t: string) => (t ? `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>` : '')
    const field = `${r('Table ')}<w:fldSimple w:instr=" SEQ Table \\* ARABIC ">${r(run[2]!)}</w:fldSimple>${r(run[3]!)}`
    xml = xml.replace(p.xml, p.xml.replace(run[0], field))
    captions.push(lead(p))
  }
  if (!captions.length) throw new Error('没有找到表题')
  return [withDoc(pkg, xml), captions]
}

/** F4 脚注：讨论部分第二段某个短语后加脚注（footnotes.xml + 关系 + 内容类型）。 */
function footnote(pkg: D.Pkg): [D.Pkg, TemplateFeatures['footnote']] {
  const p = sectionBody(pkg, DISCUSSION)[1] ?? sectionBody(pkg, DISCUSSION)[0]!
  const phrase = phraseIn(p, 'start')
  const ref = `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>`
  const run = [...p.xml.matchAll(/<w:r\b[^>]*>(?:<w:rPr>((?:(?!<\/w:rPr>|<\/w:r>)[\s\S])*)<\/w:rPr>)?<w:t\b[^>]*>([^<]*)<\/w:t><\/w:r>/g)].find(m => m[2]!.includes(phrase))!
  const t = run[2]!
  const i = t.indexOf(phrase) + phrase.length
  const r = (s: string) => (s ? `<w:r><w:rPr>${run[1] ?? ''}</w:rPr><w:t xml:space="preserve">${s}</w:t></w:r>` : '')
  const xml = doc(pkg).replace(p.xml, p.xml.replace(run[0], r(t.slice(0, i)) + ref + r(t.slice(i))))
  const notes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${esc(FOOTNOTE_TEXT)}</w:t></w:r></w:p></w:footnote></w:footnotes>`
  const rels = text(pkg, 'word/_rels/document.xml.rels')!.replace('</Relationships>', '<Relationship Id="rIdFootnotes1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>')
  const types = text(pkg, '[Content_Types].xml')!.replace('</Types>', '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>')
  return [{ ...withDoc(pkg, xml), 'word/footnotes.xml': strToU8(notes), 'word/_rels/document.xml.rels': strToU8(rels), '[Content_Types].xml': strToU8(types) }, { para: lead(p), phrase }]
}

/** F5 合作者修订：结果部分第二段一个短语被合作者改写（待采纳）。 */
function tracked(pkg: D.Pkg): [D.Pkg, TemplateFeatures['tracked']] {
  const p = sectionBody(pkg, RESULTS)[1] ?? sectionBody(pkg, RESULTS)[0]!
  const del = phraseIn(p, 'end')
  const ins = `${del} (per-protocol analysis)`
  const out = D.humanTrackedChange(pkg, lead(p), del, ins, COAUTHOR)
  if (!out) throw new Error('修订没能写入')
  return [out, { para: lead(p), del, ins }]
}

/** F6 合作者批注：讨论部分第三段（不足时为最后一段）一个短语上的 Word 批注。 */
function comment(pkg: D.Pkg): [D.Pkg, TemplateFeatures['comment']] {
  const body = sectionBody(pkg, DISCUSSION)
  const p = body[2] ?? body[body.length - 1]!
  const snippet = phraseIn(p, 'start')
  const out = D.humanComment(pkg, lead(p), snippet, COAUTHOR_COMMENT, COAUTHOR, 7)
  if (!out) throw new Error('批注没能写入')
  return [out, { para: lead(p), snippet }]
}

/** F7 分节符：讨论（或结论）部分最后一段正文带分节符（其后另起一页）。 */
function sectionBreak(pkg: D.Pkg): [D.Pkg, string] {
  const xml = doc(pkg)
  const body = sectionBody(pkg, /^conclusions?\b/i).length ? sectionBody(pkg, /^conclusions?\b/i) : sectionBody(pkg, DISCUSSION)
  const p = body[body.length - 1]
  if (!p) throw new Error('讨论与结论部分没有正文段落')
  const final = /<w:sectPr>[\s\S]*?<\/w:sectPr>(?=\s*<\/w:body>)/.exec(xml)![0]
  const sect = final.replace('<w:sectPr>', '<w:sectPr><w:type w:val="nextPage"/>')
  const next = p.xml.includes('<w:pPr>') ? p.xml.replace('</w:pPr>', `${sect}</w:pPr>`) : p.xml.replace(/(<w:p\b[^>]*>)/, `$1<w:pPr>${sect}</w:pPr>`)
  return [withDoc(pkg, xml.replace(p.xml, next)), lead(p)]
}

/** 生成复杂期刊模板。 */
export function complexTemplate(base: D.Pkg): { pkg: D.Pkg; features: TemplateFeatures } {
  let pkg = base
  const [p1, list] = numberedList(pkg); pkg = p1
  const [p2, table] = mergedHeader(pkg); pkg = p2
  const [p3, captions] = captionFields(pkg); pkg = p3
  const [p4, fn] = footnote(pkg); pkg = p4
  const [p5, tc] = tracked(pkg); pkg = p5
  const [p6, cm] = comment(pkg); pkg = p6
  const [p7, sb] = sectionBreak(pkg); pkg = p7
  return { pkg, features: { list, table, captions, footnote: fn, tracked: tc, comment: cm, sectionBreakPara: sb } }
}

// —— 特征是否仍在（两组共用的判定） ——


export interface FeatureState {
  list_numbered: boolean
  table_merged: boolean
  caption_fields: boolean
  footnote_kept: boolean
  tracked_kept: boolean
  comment_kept: boolean
  section_break_kept: boolean
}

export function featureState(pkg: D.Pkg, f: TemplateFeatures): FeatureState {
  const xml = doc(pkg)
  const ps = D.paras(xml)
  const listItems = ps.filter(p => new RegExp(`<w:numId w:val="${f.list.numId}"/>`).test(p.xml))
  // 编辑会改掉段落开头，按脚注引用本身找所在段落
  const fnPara = ps.find(p => p.xml.includes('<w:footnoteReference'))
  const notes = text(pkg, 'word/footnotes.xml') ?? ''
  const trPara = ps.find(p => p.xml.includes(`w:author="${COAUTHOR}"`) && /<w:(ins|del)\b/.test(p.xml))
  const caps = ps.filter(p => /^Table \d+/.test(p.text))
  return {
    list_numbered: listItems.length >= f.list.items.length && f.list.items.every(s => listItems.some(p => p.text.includes(s.slice(0, 30)))),
    table_merged: /<w:gridSpan w:val="\d+"\/>/.test(xml) && /<w:vMerge w:val="restart"\/>/.test(xml),
    caption_fields: caps.length >= f.captions.length && caps.every(p => p.xml.includes('SEQ Table')),
    footnote_kept: !!fnPara && fnPara.xml.includes('<w:footnoteReference') && notes.includes(FOOTNOTE_TEXT),
    tracked_kept: !!trPara,
    comment_kept: D.commentAnchored(pkg, COAUTHOR_COMMENT),
    section_break_kept: (xml.match(/<w:sectPr\b/g) ?? []).length >= 2,
  }
}
