/**
 * 实验 2a（MCP 编辑 vs 直接改 Word 文件）的 .docx 工具：把平台导出的朴素稿件加工成接近期刊模板的富格式稿件，
 * 以人类身份在文件上加批注、修订、插入文字，以及两组共用的判定与「未改动段落是否原样」度量。
 * 只做字符串级的 XML 处理，前提是被操作的文字落在同一个 w:r 里（稿件模板保证这一点）。
 */
import { strFromU8, strToU8, unzipSync, zipSync } from '../../../apps/platform/node_modules/fflate/esm/browser.js'

export type Pkg = Record<string, Uint8Array>

export const openDocx = (bytes: Uint8Array): Pkg => unzipSync(bytes)
export const saveDocx = (pkg: Pkg): Uint8Array => zipSync(pkg)

const DOC = 'word/document.xml'
export const docXml = (pkg: Pkg): string => strFromU8(pkg[DOC]!)
const withDoc = (pkg: Pkg, xml: string): Pkg => ({ ...pkg, [DOC]: strToU8(xml) })

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

export interface Para { xml: string; text: string }

/** 文档里所有段落（含表格单元格里的），文字只取 w:t（不含已删除的 w:delText）。 */
export function paras(xml: string): Para[] {
  return [...xml.matchAll(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map(m => ({
    xml: m[0],
    text: [...m[0].matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map(t => unesc(t[1]!)).join(''),
  }))
}

export const texts = (pkg: Pkg): string[] => paras(docXml(pkg)).map(p => p.text)

// —— 期刊模板化 ——

const RPR = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/><w:szCs w:val="24"/>'

/**
 * 加工成期刊模板风格：正文段落双倍行距、两端对齐、首行缩进，带 w14:paraId 与修订标识；
 * 所有文字统一字体字号，药名加粗，百分数斜体（形成多 run 段落）。
 */
export function journalize(pkg: Pkg, emphasize: string[], opts: { percentItalic?: boolean } = {}): Pkg {
  let xml = docXml(pkg)
  xml = xml.replace(
    /<w:document ([^>]*)>/,
    (_m, attrs: string) => `<w:document ${attrs} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">`,
  )
  let n = 0
  const para = (inner: string, inTable: boolean) => {
    n++
    const id = (0x1a2b3c00 + n).toString(16).toUpperCase()
    const isHeading = inner.includes('<w:pStyle w:val="Heading')
    let body = inner
    if (!isHeading && !inTable) {
      const ppr = '<w:spacing w:line="480" w:lineRule="auto"/><w:ind w:firstLine="480"/><w:jc w:val="both"/>'
      body = body.includes('<w:pPr>') ? body.replace('<w:pPr>', `<w:pPr>${ppr}`) : `<w:pPr>${ppr}</w:pPr>${body}`
    }
    // 每个 run 统一字体字号；按强调词拆 run
    body = body.replace(/<w:r>(?:<w:rPr>((?:(?!<\/w:rPr>|<\/w:r>)[\s\S])*)<\/w:rPr>)?<w:t xml:space="preserve">([^<]*)<\/w:t><\/w:r>/g, (_r, rpr: string | undefined, t: string) =>
      splitRuns(unesc(t), emphasize, opts.percentItalic ?? true).map(([seg, kind]) => {
        const extra = kind === 'b' ? '<w:b/><w:bCs/>' : kind === 'i' ? '<w:i/><w:iCs/>' : ''
        return `<w:r w:rsidRPr="00C4D5E6"><w:rPr>${rpr ?? ''}${RPR}${extra}</w:rPr><w:t xml:space="preserve">${esc(seg)}</w:t></w:r>`
      }).join(''))
    return `<w:p w14:paraId="${id}" w14:textId="77777777" w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3">${body}</w:p>`
  }
  xml = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p>([\s\S]*?)<\/w:p>/g, (m, inner: string | undefined) =>
    inner === undefined ? m.replace(/<w:p>([\s\S]*?)<\/w:p>/g, (_c, cell: string) => para(cell, true)) : para(inner, false))
  return withDoc(pkg, xml)
}

function splitRuns(text: string, emphasize: string[], percentItalic: boolean): Array<[string, 'b' | 'i' | '']> {
  const parts = [...emphasize.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ...(percentItalic ? ['\\d+(?:\\.\\d+)?%'] : [])]
  if (parts.length === 0) return [[text, '']]
  const pattern = new RegExp(`(${parts.join('|')})`, 'g')
  return text.split(pattern).filter(s => s !== '').map(s => [s, emphasize.includes(s) ? 'b' : percentItalic && /^\d+(?:\.\d+)?%$/.test(s) ? 'i' : ''])
}

// —— 人类在文件上的操作 ——

/** 在首行文字以 prefix 开头的段落里找到含 find 的 run，按 build 拆成新的片段。 */
function editRun(pkg: Pkg, prefix: string, find: string, build: (rpr: string, before: string, after: string) => string): Pkg | null {
  const xml = docXml(pkg)
  const para = paras(xml).find(p => p.text.startsWith(prefix))
  if (!para) return null
  const run = [...para.xml.matchAll(/<w:r\b[^>]*>(?:<w:rPr>((?:(?!<\/w:rPr>|<\/w:r>)[\s\S])*)<\/w:rPr>)?<w:t\b[^>]*>([^<]*)<\/w:t><\/w:r>/g)].find(r => unesc(r[2]!).includes(find))
  if (!run) return null
  const t = unesc(run[2]!)
  const i = t.indexOf(find)
  const next = para.xml.replace(run[0], build(run[1] ?? '', t.slice(0, i), t.slice(i + find.length)))
  return withDoc(pkg, xml.replace(para.xml, next))
}

const r = (rpr: string, t: string) => (t ? `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>` : '')

/** 人类直接改文字（插入 / 替换），不留修订痕迹。 */
export function humanReplace(pkg: Pkg, prefix: string, find: string, replace: string): Pkg | null {
  return editRun(pkg, prefix, find, (rpr, a, b) => r(rpr, a + replace + b))
}

/** 人类留下一条待采纳的修订（w:del + w:ins）。 */
export function humanTrackedChange(pkg: Pkg, prefix: string, find: string, replace: string, author: string): Pkg | null {
  const date = '2026-10-19T08:00:00Z'
  return editRun(pkg, prefix, find, (rpr, a, b) =>
    r(rpr, a)
    + `<w:del w:id="901" w:author="${author}" w:date="${date}"><w:r><w:rPr>${rpr}</w:rPr><w:delText xml:space="preserve">${esc(find)}</w:delText></w:r></w:del>`
    + `<w:ins w:id="902" w:author="${author}" w:date="${date}"><w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${esc(replace)}</w:t></w:r></w:ins>`
    + r(rpr, b))
}

/** 人类在一段文字上加批注（comments.xml + 关系 + 内容类型）；可多次调用，id 递增。 */
export function humanComment(pkg: Pkg, prefix: string, snippet: string, text: string, author: string, id = 0): Pkg | null {
  const out = editRun(pkg, prefix, snippet, (rpr, a, b) =>
    r(rpr, a)
    + `<w:commentRangeStart w:id="${id}"/>${r(rpr, snippet)}<w:commentRangeEnd w:id="${id}"/>`
    + `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`
    + r(rpr, b))
  if (!out) return null
  const entry = `<w:comment w:id="${id}" w:author="${esc(author)}" w:date="2026-10-19T08:00:00Z" w:initials="QD"><w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:comment>`
  if (out['word/comments.xml']) {
    return { ...out, 'word/comments.xml': strToU8(strFromU8(out['word/comments.xml']).replace('</w:comments>', `${entry}</w:comments>`)) }
  }
  const comments = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${entry}</w:comments>`
  const rels = strFromU8(out['word/_rels/document.xml.rels']!).replace('</Relationships>', '<Relationship Id="rIdComments1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>')
  const types = strFromU8(out['[Content_Types].xml']!).replace('</Types>', '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>')
  return { ...out, 'word/comments.xml': strToU8(comments), 'word/_rels/document.xml.rels': strToU8(rels), '[Content_Types].xml': strToU8(types) }
}

/** 段落的标题级别（Heading1–6 样式），正文为 0。 */
export const headingLevel = (p: Para): number => Number(/<w:pStyle w:val="Heading(\d)"\/>/.exec(p.xml)?.[1] ?? 0)

// —— 判定与度量（两组共用） ——

/** 文字为 text 的批注是否仍锚在正文里。 */
export function commentAnchored(pkg: Pkg, text: string): boolean {
  const comments = pkg['word/comments.xml'] ? strFromU8(pkg['word/comments.xml']) : ''
  const c = [...comments.matchAll(/<w:comment\b[^>]*w:id="(\d+)"[^>]*>([\s\S]*?)<\/w:comment>/g)].find(m => unesc(m[2]!).includes(text) || m[2]!.includes(esc(text)))
  if (!c) return false
  const xml = docXml(pkg)
  return xml.includes(`<w:commentRangeStart w:id="${c[1]}"/>`) && xml.includes(`<w:commentReference w:id="${c[1]}"/>`)
}

export const hasTrackedChange = (pkg: Pkg): boolean => /<w:(ins|del)\b/.test(docXml(pkg))

export interface Damage {
  /** 应当原样不动的段落数（排除本任务的目标段与人类改过的段）。 */
  untouched: number
  /** 其中 XML 逐字节相同。 */
  identical: number
  /** 文字没变但 XML 变了（格式、段落 ID、修订标识等丢失）。 */
  format_drift: number
  /** 文字也变了或段落不见了（越界改动）。 */
  content_changed: number
  /** 样式、编号、页面设置、字体表、主题等版式部件全部原样。 */
  styles_intact: boolean
  /** 有变化的其他部件（元数据、批注等新增内容也会列在这里，便于区分）。 */
  changed_parts: string[]
}

/** 以两组共同的源文件为基准，度量 after 里不该动的段落有没有被动过。 */
export function damage(source: Pkg, after: Pkg, exclude: (text: string) => boolean): Damage {
  const keep = paras(docXml(source)).filter(p => p.text.trim() !== '' && !exclude(p.text))
  const out = docXml(after)
  const outTexts = new Set(paras(out).map(p => p.text))
  let identical = 0
  let formatDrift = 0
  let contentChanged = 0
  for (const p of keep) {
    if (out.includes(p.xml)) identical++
    else if (outTexts.has(p.text)) formatDrift++
    else contentChanged++
  }
  const sameBytes = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i])
  const names = [...new Set([...Object.keys(source), ...Object.keys(after)])].filter(k => k !== 'word/document.xml')
  const changed = names.filter(k => !sameBytes(source[k], after[k]))
  const LAYOUT = /^word\/(styles|numbering|settings|fontTable|theme\/theme\d*|header\d*|footer\d*)\.xml$/
  return {
    untouched: keep.length,
    identical,
    format_drift: formatDrift,
    content_changed: contentChanged,
    // 版式部件按内容比较：去掉 XML 声明（python-docx 保存时把声明里的双引号改成单引号，样式本身没变）
    styles_intact: !changed.filter(k => LAYOUT.test(k)).some(k => prologless(source[k]) !== prologless(after[k])),
    changed_parts: changed,
  }
}

/** 部件内容（忽略 XML 声明与标签之间的空白：这些是序列化差异，不是改动）。 */
const prologless = (b?: Uint8Array) => (b ? strFromU8(b).replace(/^<\?xml[^>]*\?>\s*/, '').replace(/>\s+</g, '><') : null)

export interface FormatKept {
  /** 找到了对应的段落（与源段落文字重合度最高的那段）。 */
  found: boolean
  para_id: boolean
  /** 双倍行距、首行缩进、两端对齐。 */
  layout: boolean
  /** 所有文字 run 都保留了模板字体与字号。 */
  fonts: boolean
  /** 段内药名仍加粗、百分数仍斜体。 */
  emphasis: boolean
}

/** 被修改的那一段：模板格式还剩多少。 */
export function formatKept(source: Pkg, after: Pkg, targetPrefix: string, emphasize: string[]): FormatKept {
  const src = paras(docXml(source)).find(p => p.text.startsWith(targetPrefix))
  const none = { found: false, para_id: false, layout: false, fonts: false, emphasis: false }
  if (!src) return none
  const chars = new Set(src.text)
  let best: Para | undefined
  let bestScore = 0
  for (const p of paras(docXml(after))) {
    const score = [...new Set(p.text)].filter(c => chars.has(c)).length / Math.max(chars.size, 1)
    if (score > bestScore) { best = p; bestScore = score }
  }
  if (!best || bestScore < 0.5) return none
  const id = /w14:paraId="([0-9A-F]+)"/.exec(src.xml)?.[1]
  const runs = [...best.xml.matchAll(/<w:r\b[^>]*>((?:(?!<\/w:r>)[\s\S])*)<\/w:r>/g)].map(m => m[1]!).filter(r => /<w:t\b/.test(r))
  const runText = (r: string) => [...r.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map(t => unesc(t[1]!)).join('')
  // 原文里加粗的药名、斜体的百分数，改完后至少还有同样多（AI 新写的文字不要求加粗）
  const count = (xml: string, re: RegExp, mark: RegExp) =>
    [...xml.matchAll(/<w:r\b[^>]*>((?:(?!<\/w:r>)[\s\S])*)<\/w:r>/g)].map(m => m[1]!).filter(r => mark.test(r) && re.test(runText(r))).length
  // 没有指定强调词时（长稿）：只要求原段落里的加粗 / 斜体至少保留一处
  const drug = emphasize.length ? new RegExp(emphasize.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')) : /\S/
  const pct = /\d+(?:\.\d+)?%/
  const pctLeft = (best.text.match(/\d+(?:\.\d+)?%/g) ?? []).filter(x => src.text.includes(x)).length
  const emphasisOk = count(best.xml, drug, /<w:b\/>/) >= Math.min(count(src.xml, drug, /<w:b\/>/), (best.text.match(drug) ?? []).length)
    && (emphasize.length
      ? count(best.xml, pct, /<w:i\/>/) >= Math.min(count(src.xml, pct, /<w:i\/>/), pctLeft)
      : count(best.xml, /\S/, /<w:i\/>/) >= Math.min(count(src.xml, /\S/, /<w:i\/>/), 1))
  return {
    found: true,
    para_id: !!id && best.xml.includes(`w14:paraId="${id}"`),
    layout: /<w:spacing w:line="480"/.test(best.xml) && /<w:jc w:val="both"\/>/.test(best.xml) && /<w:ind w:firstLine="480"\/>/.test(best.xml),
    fonts: runs.length > 0 && runs.every(r => /w:ascii="Times New Roman"/.test(r) && /<w:sz w:val="24"\/>/.test(r)),
    emphasis: emphasisOk,
  }
}
