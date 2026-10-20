import { strFromU8, strToU8, zipSync } from 'fflate'
import type { Mark, Node as PMNode } from 'prosemirror-model'
import { Resvg } from '@resvg/resvg-js'
import { referencePlan } from '../model/references.ts'
import { colWidths } from '../model/schema.ts'
import { readGrid, type GridCell } from '../model/table-grid.ts'
import { looksLikeHeaderRow } from '../model/table-header.ts'
import type { CitationRow, CommentRow } from '../store/db.ts'
import { bodyChildrenRaw, elementChildrenRaw, safeUnzipDocx } from './docx-import.ts'

/**
 * 平台模型 → docx（PLATFORM.md §6 导出）：修补式。
 *
 * - 有原始文件包（导入的文档）：沿用其样式、编号、关系、媒体、页面设置；
 *   导入后没改过的块直接写回原始 XML（字节不变），改过 / 新增的块按模型生成。
 * - 没有原始文件包（平台新建）：用内置模板（标题样式、列表编号、宋体 / Times New Roman）。
 * - 引用按文中首次出现顺序编号为上标 [n]，末尾生成参考文献表；open 评论写入 comments.xml。
 */

export interface ExportInput {
  doc: PMNode
  /** 导入时的模型（判断块是否改过）；平台新建的文档为 null。 */
  baseline: PMNode | null
  /** 原始文件包；平台新建的文档为 null。 */
  pkg: Uint8Array | null
  src: (nodeId: string) => string | null
  citations: CitationRow[]
  comments: CommentRow[]
  asset: (id: string) => { mime: string; bytes: Uint8Array } | null
}

export interface ExportResult { bytes: Uint8Array; warnings: string[] }

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const SECT = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'

// XML 1.0 不允许的控制字符
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g
const esc = (s: string) => s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

class Package {
  files: Record<string, Uint8Array>
  private relsXml: string
  private nextRel: number
  constructor(files: Record<string, Uint8Array>) {
    this.files = files
    this.relsXml = this.text('word/_rels/document.xml.rels') ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
    const ids = [...this.relsXml.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]))
    this.nextRel = Math.max(1000, ...ids) + 1
  }
  text(name: string): string | null { return this.files[name] ? strFromU8(this.files[name]!) : null }
  put(name: string, content: string | Uint8Array): void { this.files[name] = typeof content === 'string' ? strToU8(content) : content }
  /** 已存在同类型同目标的关系就复用。 */
  rel(type: string, target: string, external = false): string {
    const existing = new RegExp(`<Relationship[^>]*Id="([^"]+)"[^>]*Type="${REL}/${type}"[^>]*Target="${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(this.relsXml)
      ?? new RegExp(`<Relationship[^>]*Target="${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*Type="${REL}/${type}"[^>]*Id="([^"]+)"`).exec(this.relsXml)
    if (existing) return existing[1]!
    const id = `rId${this.nextRel++}`
    this.relsXml = this.relsXml.replace('</Relationships>', `<Relationship Id="${id}" Type="${REL}/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/></Relationships>`)
    return id
  }
  contentDefault(ext: string, type: string): void {
    const ct = this.text('[Content_Types].xml')!
    if (new RegExp(`Extension="${ext}"`, 'i').test(ct)) return
    this.put('[Content_Types].xml', ct.replace('</Types>', `<Default Extension="${ext}" ContentType="${type}"/></Types>`))
  }
  contentOverride(part: string, type: string): void {
    const ct = this.text('[Content_Types].xml')!
    if (ct.includes(`PartName="${part}"`)) return
    this.put('[Content_Types].xml', ct.replace('</Types>', `<Override PartName="${part}" ContentType="${type}"/></Types>`))
  }
  finish(): Uint8Array {
    this.put('word/_rels/document.xml.rels', this.relsXml)
    return zipSync(this.files)
  }
}

function template(): Record<string, Uint8Array> {
  const heading = (n: number) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[36, 32, 28, 26, 24, 24][n - 1]}"/></w:rPr></w:style>`
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${[1, 2, 3, 4, 5, 6].map(heading).join('')}
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
</w:styles>`
  return {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/styles.xml': strToU8(styles),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/></Relationships>`),
  }
}

/** 段落样式名 → styleId（按包里的 styles.xml）。 */
function styleIndex(stylesXml: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!stylesXml) return map
  for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>(?:(?!<\/w:style>)[\s\S])*?<w:name w:val="([^"]+)"/g)) {
    map.set(m[2]!.toLowerCase(), m[1]!)
    map.set(m[1]!.toLowerCase(), m[1]!)
  }
  return map
}

function imageSize(bytes: Uint8Array, mime: string): { w: number; h: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    if ((mime === 'image/png' || mime === 'image/x-png') && bytes.length > 24) return { w: dv.getUint32(16), h: dv.getUint32(20) }
    if (mime === 'image/gif' && bytes.length > 10) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) }
    if (mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/pjpeg') {
      let i = 2
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null
        const marker = bytes[i + 1]!
        const len = dv.getUint16(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5) }
        i += 2 + len
      }
    }
  } catch { /* 尺寸未知 */ }
  return null
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/x-png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/webp': 'webp',
}

/** rPr 子元素在 schema 里的顺序（CT_RPr）；Word 对顺序敏感，合并后按此排序。 */
const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath']

/** pPr 子元素在 schema 里的顺序（CT_PPr）。 */
const PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange']

/** tcPr 中 tcW / gridSpan / vMerge 之后的子元素顺序（CT_TcPr）。 */
const TCPR_ORDER = ['tcBorders', 'shd', 'noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark']

/** 合并两段子元素原文：同名元素以 over 为准，结果按给定的 schema 顺序排列。 */
function mergeEls(base: string, over: string, order: string[]): string {
  // 以带前缀的完整名字为键（w:sz、w14:textOutline……），不同命名空间的同名元素互不覆盖
  const name = (el: string) => /^<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(el)?.[1] ?? el
  const els = new Map<string, string>()
  for (const el of elementChildrenRaw(`<x>${base}</x>`)) els.set(name(el), el)
  for (const el of elementChildrenRaw(`<x>${over}</x>`)) els.set(name(el), el)
  // w: 元素按 schema 顺序；扩展命名空间（w14: 等）排在后面，彼此保持原顺序（sort 是稳定的）
  const rank = (n: string) => { const i = n.startsWith('w:') ? order.indexOf(n.slice(2)) : -1; return i === -1 ? order.length : i }
  return [...els.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(e => e[1]).join('')
}

/** 原文元素开始标签里的属性值（兼容单双引号）；没有该属性返回 null。 */
function attrOf(el: string, name: string): string | null {
  const open = /^<[^>]*>/.exec(el)?.[0] ?? ''
  const m = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`).exec(open)
  return m ? m[2]! : null
}

/** 原文元素里第一个名为 w:local 的直接子元素。 */
function childEl(el: string | undefined, local: string): string | undefined {
  return el ? elementChildrenRaw(el).find(k => new RegExp(`^<w:${local}\\b`).test(k)) : undefined
}

export function exportDocx(input: ExportInput): ExportResult {
  const warnings: string[] = []
  const pkg = new Package(input.pkg ? safeUnzipDocx(input.pkg) : template())
  const originalXml = pkg.text('word/document.xml')
  const styles = styleIndex(pkg.text('word/styles.xml'))
  const baseline = new Map<string, PMNode>()
  input.baseline?.descendants(n => { if (n.attrs.id) baseline.set(n.attrs.id as string, n) })
  const unchanged = (n: PMNode) => {
    const id = n.attrs.id as string | null
    const before = id ? baseline.get(id) : undefined
    return before !== undefined && before.eq(n) ? input.src(id!) : null
  }

  // 块在父节点中的位置（判断从段落里拆出的图是否原样跟随）
  const positions = (doc: PMNode | null) => {
    const m = new Map<string, { parent: PMNode; index: number }>()
    doc?.descendants((n, _pos, parent, index) => { if (n.attrs.id && parent) m.set(n.attrs.id as string, { parent, index }) })
    return m
  }
  const basePos = positions(input.baseline)
  const curPos = positions(input.doc)
  /** 原样写回时已经包含在段落原文里的图（不再单独生成）。 */
  const skip = new Set<string>()
  /**
   * 段落能否原样写回：未改动；若原文里嵌着图（导入时拆成了后续的图块），这些图块也必须
   * 原样、按原顺序紧跟在后面——否则重新生成段落（不含图），图按模型单独生成。
   */
  const verbatim = (n: PMNode): string | null => {
    const src = unchanged(n)
    if (!src || !/<w:(drawing|pict)\b/.test(src)) return src
    const id = n.attrs.id as string
    const b = basePos.get(id)
    const c = curPos.get(id)
    if (!b || !c) return null
    const figures: PMNode[] = []
    for (let i = b.index + 1; i < b.parent.childCount; i++) {
      const sib = b.parent.child(i)
      if (sib.type.name !== 'figure' || input.src(sib.attrs.id as string)) break
      figures.push(sib)
    }
    for (let k = 0; k < figures.length; k++) {
      const cur = c.parent.maybeChild(c.index + 1 + k)
      if (!cur || !cur.eq(figures[k]!)) return null
    }
    for (const f of figures) skip.add(f.attrs.id as string)
    return src
  }

  // 编号：新列表优先沿用原文件里同类列表的 abstractNum 与段落样式；没有时用平台自己的（ids 9000+）
  let numberingXml = pkg.text('word/numbering.xml')
  const abstractOf = new Map([...(numberingXml ?? '').matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>(?:(?!<\/w:num>)[\s\S])*?<w:abstractNumId w:val="(\d+)"/g)].map(m => [m[1]!, m[2]!]))
  const listTemplate = new Map<string, { abstractId: string; pStyle: string | null }>()
  input.baseline?.descendants(n => {
    if (!/_list$/.test(n.type.name) || listTemplate.has(n.type.name)) return true
    const first = n.firstChild?.firstChild
    const src = first?.attrs.id ? input.src(first.attrs.id as string) : null
    const numId = src ? /<w:numId w:val="(\d+)"/.exec(src)?.[1] : undefined
    const abstractId = numId ? abstractOf.get(numId) : undefined
    if (abstractId) listTemplate.set(n.type.name, { abstractId, pStyle: /<w:pStyle w:val="([^"]+)"/.exec(src!)?.[1] ?? null })
    return true
  })
  const newNums: string[] = []
  const numStyle = new Map<string, string | null>()
  let nextNum = 9001
  let usesPlatformNumbering = false
  const numFor = (ordered: boolean): string => {
    const id = String(nextNum++)
    const tpl = listTemplate.get(ordered ? 'ordered_list' : 'bullet_list')
    if (!tpl) usesPlatformNumbering = true
    const abstractId = tpl?.abstractId ?? (ordered ? '9002' : '9001')
    newNums.push(`<w:num w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/>${ordered ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : ''}</w:num>`)
    numStyle.set(id, tpl?.pStyle ?? null)
    return id
  }

  // 引用编号与评论
  // 引用编号与参考文献表：正文末尾已有用户自己的文献表时，平台引用接在其后编号（见 model/references.ts）
  const refPlan = referencePlan(input.doc, input.citations)
  const citeNumber = refPlan.numbers
  const openComments = new Map(input.comments.filter(c => c.status === 'open').map(c => [c.id, c]))
  const commentIds = new Map<string, number>()
  let nextCommentId = Math.max(-1, ...[...(pkg.text('word/comments.xml') ?? '').matchAll(/<w:comment\b[^>]*w:id="(\d+)"/g)].map(m => Number(m[1]))) + 1
  // 每条线程最后出现在哪个段落（跨段落的评论范围在最后一段结束）
  const lastPara = new Map<string, PMNode>()
  input.doc.descendants(n => {
    if (n.isTextblock) n.forEach(c => c.marks.forEach(m => { if (m.type.name === 'comment' && openComments.has(m.attrs.thread as string)) lastPara.set(m.attrs.thread as string, n) }))
  })
  const commentEndParas = new Set(lastPara.values())
  const started = new Set<string>()

  const headingStyle = (level: number) => styles.get(`heading ${level}`) ?? styles.get(`标题 ${level}`) ?? `Heading${level}`
  const missingHeading = new Set<number>()
  let nextDocPr = 90_001

  /** base：沿用的原文 run 属性（rPr 的子元素原文，不含粗斜体等由 mark 表达的属性），与 mark 合并后按 schema 顺序输出。 */
  const runProps = (marks: readonly Mark[], extra = '', base = ''): string => {
    let p = extra
    for (const m of marks) {
      if (m.type.name === 'bold') p += '<w:b/>'
      else if (m.type.name === 'italic') p += '<w:i/>'
      else if (m.type.name === 'underline') p += '<w:u w:val="single"/>'
      else if (m.type.name === 'sup') p += '<w:vertAlign w:val="superscript"/>'
      else if (m.type.name === 'sub') p += '<w:vertAlign w:val="subscript"/>'
      else if (m.type.name === 'code') p += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'
      else if (m.type.name === 'link') p += '<w:rStyle w:val="Hyperlink"/>'
    }
    if (base) p = mergeEls(base, p, RPR_ORDER)
    return p ? `<w:rPr>${p}</w:rPr>` : ''
  }

  const textRuns = (text: string, marks: readonly Mark[], base = ''): string =>
    text.split('\t').map((part, i) => `${i > 0 ? `<w:r>${runProps(marks, '', base)}<w:tab/></w:r>` : ''}${part ? `<w:r>${runProps(marks, '', base)}<w:t xml:space="preserve">${esc(part)}</w:t></w:r>` : ''}`).join('')

  const inline = (para: PMNode, baseRPr = ''): string => {
    let out = ''
    const activeHere = new Set<string>()
    para.forEach(child => {
      const threads = child.marks.filter(m => m.type.name === 'comment' && openComments.has(m.attrs.thread as string)).map(m => m.attrs.thread as string)
      for (const t of threads) {
        if (!started.has(t)) {
          started.add(t)
          commentIds.set(t, nextCommentId++)
          out += `<w:commentRangeStart w:id="${commentIds.get(t)}"/>`
        }
        activeHere.add(t)
      }
      let run = ''
      if (child.isText) run = textRuns(child.text!, child.marks, baseRPr)
      else if (child.type.name === 'hard_break') run = '<w:r><w:br/></w:r>'
      else if (child.type.name === 'citation') {
        const n = citeNumber.get(child.attrs.cite_id as string)
        // 上标编号沿用所在段落的字体字号（导入稿件的模板格式）
        run = `<w:r>${runProps([], '<w:vertAlign w:val="superscript"/>', baseRPr)}<w:t>[${n ?? '?'}]</w:t></w:r>`
      }
      const link = child.marks.find(m => m.type.name === 'link')
      if (link && run) {
        const href = String(link.attrs.href)
        run = href.startsWith('#')
          ? `<w:hyperlink w:anchor="${esc(href.slice(1))}">${run}</w:hyperlink>`
          : `<w:hyperlink r:id="${pkg.rel('hyperlink', href, true)}">${run}</w:hyperlink>`
      }
      out += run
    })
    for (const t of activeHere) {
      if (lastPara.get(t) !== para) continue
      const id = commentIds.get(t)!
      out += `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`
    }
    return out
  }

  /** styleId：没有自带样式时使用的段落样式 id（列表沿用原文件列表的样式）。 */
  const pPr = (node: PMNode, extra = '', styleId?: string): string => {
    let p = ''
    if (!node.attrs.style && styleId && node.type.name === 'paragraph') {
      p += `<w:pStyle w:val="${esc(styleId)}"/>`
    } else if (node.type.name === 'heading') {
      const level = Math.min(6, Math.max(1, node.attrs.level as number))
      const id = headingStyle(level)
      if (!styles.has(id.toLowerCase())) missingHeading.add(level)
      p += `<w:pStyle w:val="${esc(id)}"/>`
    } else if (node.attrs.style) {
      const id = styles.get(String(node.attrs.style).toLowerCase())
      if (id) p += `<w:pStyle w:val="${esc(id)}"/>`
    }
    p += extra
    const align = node.attrs.align as string | null
    if (align) p += `<w:jc w:val="${align === 'justify' ? 'both' : align === 'left' ? 'left' : align}"/>`
    return p ? `<w:pPr>${p}</w:pPr>` : ''
  }

  /**
   * 导入后改过的正文段落：沿用原段落的段落属性（间距、缩进、对齐……）、首个文字 run 的字体字号，
   * 以及段落开始标签上的属性（w14:paraId、修订标识），与表格单元格的规则一致；
   * 段落自带样式或对齐（如 set_block_style 改过）时只覆盖 pStyle / jc。原文含图的段落不走这里。
   */
  const regenerated = (node: PMNode, extraPPr: string): string | null => {
    const id = node.attrs.id as string | null
    const raw = id ? input.src(id) : null
    if (!raw || !/^<w:p\b/.test(raw) || /<w:(drawing|pict)\b/.test(raw)) return null
    const kids = elementChildrenRaw(raw)
    const pPrRaw = kids.find(k => /^<w:pPr\b/.test(k))
    const firstRun = kids.find(k => /^<w:r\b/.test(k) && /<w:t\b/.test(k))
    const rPrRaw = firstRun ? elementChildrenRaw(firstRun).find(k => /^<w:rPr\b/.test(k)) : undefined
    // 顶层段落不是列表项；原来是标题样式而现在成了普通段落时，不再沿用标题样式。
    // 分节符（pPr 里的 sectPr）属于该段落所在节的结尾，改了文字仍要保留，否则其后的分页 / 页面设置会丢
    let base = pPrRaw ? stripEls(innerOf(pPrRaw), ['pPrChange', 'rPr', 'numPr']) : ''
    if (node.type.name === 'paragraph' && !node.attrs.style) base = stripEls(base, ['pStyle'])
    const own = innerOf(pPr(node, extraPPr) || '<w:pPr/>')
    const merged = own ? mergeEls(base, own, PPR_ORDER) : base
    const rPr = rPrRaw ? stripEls(innerOf(rPrRaw), ['b', 'bCs', 'i', 'iCs', 'u', 'vertAlign', 'rStyle', 'rPrChange', 'ins', 'del']) : ''
    const open = /^<w:p\b[^>]*>/.exec(raw)![0]
    return `${open}${merged ? `<w:pPr>${merged}</w:pPr>` : ''}${inline(node, rPr)}</w:p>`
  }

  const paragraph = (node: PMNode, extraPPr = ''): string =>
    verbatim(node) ?? regenerated(node, extraPPr) ?? `<w:p>${pPr(node, extraPPr)}${inline(node)}</w:p>`

  const figure = (node: PMNode): string => {
    const rawId = String(node.attrs.asset_id || '')
    const assetId = rawId.replace(/^asset:/, '')
    let asset = input.asset(assetId)
    let ext = asset ? IMAGE_EXT[asset.mime] : undefined
    let svgBytes: Uint8Array | null = null
    let size: { w: number; h: number } | null = null

    if (asset && (asset.mime === 'image/svg+xml' || (!ext && String(node.attrs.alt || '').includes('svg')))) {
      try {
        const svgBuf = Buffer.from(asset.bytes)
        const nat = new Resvg(svgBuf).render()
        const natW = nat.width || 800
        const natH = nat.height || 600
        size = { w: natW, h: natH }
        const targetW = Math.max(1600, natW * 2)
        const rendered = new Resvg(svgBuf, {
          fitTo: { mode: 'width', value: targetW },
          font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans CJK SC' },
        }).render()
        svgBytes = asset.bytes
        asset = { mime: 'image/png', bytes: new Uint8Array(rendered.asPng()) }
        ext = 'png'
      } catch (err) {
        warnings.push(`矢量图 ${node.attrs.asset_id} 光栅化失败（${(err as Error).message}），以文字占位`)
        return `<w:p><w:r><w:t xml:space="preserve">[图：${esc(String(node.attrs.alt || node.attrs.caption || ''))}]</w:t></w:r></w:p>`
      }
    }

    if (!asset || !ext) {
      warnings.push(`图片 ${node.attrs.asset_id} 无法嵌入（${asset ? asset.mime : '资产不存在'}），以文字占位`)
      return `<w:p><w:r><w:t xml:space="preserve">[图：${esc(String(node.attrs.alt || node.attrs.caption || ''))}]</w:t></w:r></w:p>`
    }
    const name = `media/heurion-${assetId}.${ext}`
    pkg.put(`word/${name}`, asset.bytes)
    pkg.contentDefault(ext, asset.mime)
    const rid = pkg.rel('image', name)

    let blipXml = `<a:blip r:embed="${rid}"/>`
    if (svgBytes) {
      const svgName = `media/heurion-${assetId}.svg`
      pkg.put(`word/${svgName}`, svgBytes)
      pkg.contentDefault('svg', 'image/svg+xml')
      const svgRid = pkg.rel('image', svgName)
      blipXml = `<a:blip r:embed="${rid}"><a:extLst><a:ext uri="{96DAC542-7CC2-4485-AB96-5902FA35C682}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${svgRid}"/></a:ext></a:extLst></a:blip>`
    }

    size = size ?? imageSize(asset.bytes, asset.mime) ?? { w: 800, h: 600 }
    const maxW = 5_486_400 // 6 英寸
    let cx = size.w * 9525
    let cy = size.h * 9525
    if (cx > maxW) { cy = Math.round(cy * maxW / cx); cx = maxW }
    const docPr = nextDocPr++
    const drawing = `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docPr}" name="${esc(String(node.attrs.alt || 'figure'))}" descr="${esc(String(node.attrs.alt ?? ''))}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill>${blipXml}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
    const caption = node.attrs.caption
      ? `<w:p><w:pPr>${styles.has('caption') ? `<w:pStyle w:val="${styles.get('caption')}"/>` : ''}<w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">${esc(String(node.attrs.caption))}</w:t></w:r></w:p>`
      : ''
    return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>${drawing}</w:r></w:p>${caption}`
  }

  /**
   * 导入表格的原始格式：按位置把原表 XML 与基线表格对齐，以单元格首段 id 为键记下
   * 单元格属性（tcPr）、所在行属性（trPr）与段落原文；段落 id 在表格操作中保持不变，所以增删行列后仍能找回。
   */
  interface TableSrc {
    tblPr: string
    grid: number[]
    tcPr: Map<string, string>
    trPr: Map<string, string>
    para: Map<string, string>
  }
  // 与导入端的判定一致（docx-import：有 vMerge 且 val 缺省或为 continue），兼容单引号、非自闭合等写法
  const isVMergeContinue = (tc: string) => {
    const v = childEl(childEl(tc, 'tcPr'), 'vMerge')
    return !!v && (attrOf(v, 'w:val') ?? 'continue') === 'continue'
  }
  const tableSrc = (node: PMNode): TableSrc | null => {
    const id = node.attrs.id as string
    const xml = input.src(id)
    const base = baseline.get(id)
    if (!xml || !base || base.type.name !== 'table') return null
    const kids = elementChildrenRaw(xml)
    const out: TableSrc = {
      tblPr: kids.find(k => /^<w:tblPr\b/.test(k)) ?? '',
      grid: elementChildrenRaw(kids.find(k => /^<w:tblGrid\b/.test(k)) ?? '<x/>').filter(k => /^<w:gridCol\b/.test(k)).map(k => Number(attrOf(k, 'w:w') ?? 0)),
      tcPr: new Map(), trPr: new Map(), para: new Map(),
    }
    let bi = 0
    for (const tr of kids.filter(k => /^<w:tr\b/.test(k))) {
      const trKids = elementChildrenRaw(tr)
      // 与导入一致：vMerge 续行格不对应模型里的单元格；整行都是续行格的行在模型里不存在
      const tcs = trKids.filter(k => /^<w:tc\b/.test(k) && !isVMergeContinue(k))
      if (tcs.length === 0) continue
      const brow = base.maybeChild(bi++)
      if (!brow) break
      const trPr = trKids.find(k => /^<w:trPr\b/.test(k)) ?? ''
      tcs.forEach((tc, ci) => {
        const bcell = brow.maybeChild(ci)
        const key = bcell?.firstChild?.attrs.id as string | undefined
        if (!bcell || !key) return
        const tcKids = elementChildrenRaw(tc)
        out.tcPr.set(key, tcKids.find(k => /^<w:tcPr\b/.test(k)) ?? '')
        out.trPr.set(key, trPr)
        const ps = tcKids.filter(k => /^<w:p\b/.test(k))
        if (ps.length === bcell.childCount) bcell.forEach((p, _o, i) => { if (p.attrs.id) out.para.set(p.attrs.id as string, ps[i]!) })
      })
    }
    return out
  }

  const innerOf = (el: string) => elementChildrenRaw(el).join('')
  const stripEls = (inner: string, names: string[]) =>
    elementChildrenRaw(`<x>${inner}</x>`).filter(k => !names.some(n => new RegExp(`^<w:${n}\\b`).test(k))).join('')

  const table = (node: PMNode): string => {
    const src = unchanged(node)
    if (src) return src
    const orig = tableSrc(node)
    // 原表首行是否显式标了重复表头：与导入端一致（有 tblHeader 且 val 不是 0 / false / off；没标为 false；无原表为 null）
    const firstTr = orig ? elementChildrenRaw(input.src(node.attrs.id as string)!).find(k => /^<w:tr\b/.test(k)) : undefined
    const headerEl = childEl(childEl(firstTr, 'trPr'), 'tblHeader')
    const origHasTblHeader = !orig ? null : !!headerEl && !/^(0|false|off)$/i.test(attrOf(headerEl, 'w:val') ?? '1')
    const grid = readGrid(node)
    const width = Math.max(1, grid.width)
    // 列宽：列数没变沿用原表各列宽度；列数变了按原表总宽平均分；新表 9000 twip 平均分
    // 显式设定过列宽（table_set_style）时按比例分配总宽
    const total = orig && orig.grid.length > 0 ? orig.grid.reduce((a, b) => a + b, 0) : 9000
    const set = colWidths(node)
    const colWs = set && set.length === width
      ? set.map(w => Math.floor(total * w / set.reduce((a, b) => a + b, 0)))
      : orig && orig.grid.length === width ? orig.grid : Array.from({ length: width }, () => Math.floor(total / width))
    const spanW = (left: number, span: number) => colWs.slice(left, left + span).reduce((a, b) => a + b, 0)

    // 重复表头行（Word 只认表格开头连续的几行）：
    // 显式设定过（table_set_header / 工具栏）→ 开头连续的表头行；
    // 否则单列表格（表单型，如申报书章节表）一律不加；多列且原文件显式标注过 → 开头连续的表头行（不受长度限制）；
    // 原文件显式未标注 → 不加；无原文件（新建表格）→ 仅首行且符合共用的表头规则时才加
    let leading = 0
    while (leading < node.childCount) {
      let all = node.child(leading).childCount > 0
      node.child(leading).forEach(c => { if (!c.attrs.header) all = false })
      if (!all) break
      leading++
    }
    let headerRows = 0
    if (node.attrs.header_explicit || (node.attrs.header_rows !== null && node.attrs.header_rows !== undefined)) {
      headerRows = leading
    } else if (width < 2) {
      // 不加
    } else if (origHasTblHeader === true) {
      headerRows = leading
    } else if (origHasTblHeader === null && node.firstChild?.firstChild?.attrs.header) {
      const cells: PMNode[][] = []
      node.firstChild.forEach(cell => { const ps: PMNode[] = []; cell.forEach(p => ps.push(p)); cells.push(ps) })
      if (looksLikeHeaderRow(cells)) headerRows = 1
    }

    const keyOf = (cell: GridCell) => cell.node.firstChild?.attrs.id as string | undefined
    // 新加的单元格没有原文：借同一列最近的有原文的单元格（先往上找，再往下找）；
    // 整列都是新的（新加的列）时借同一行最近的（先往左，再往右）。边框写在单元格上的文件（WPS、LibreOffice 生成）靠这个才有边框
    const fmtSource = (cell: GridCell): GridCell | null => {
      if (!orig) return null
      const has = (other: GridCell | undefined) => { const k = other && keyOf(other); return !!k && orig.tcPr.has(k) }
      if (has(cell)) return cell
      for (const dir of [-1, 1]) {
        for (let r = cell.top + dir; r >= 0 && r < grid.height; r += dir) {
          const other = grid.at(r, cell.left)
          if (has(other)) return other!
        }
      }
      for (const dir of [-1, 1]) {
        for (let c = dir < 0 ? cell.left - 1 : cell.left + cell.colspan; c >= 0 && c < grid.width; c += dir) {
          const other = grid.at(cell.top, c)
          if (has(other)) return other!
        }
      }
      return null
    }
    const tcPrXml = (cell: GridCell, continuation: boolean): string => {
      const srcCell = fmtSource(cell)
      const raw = srcCell ? orig!.tcPr.get(keyOf(srcCell)!) ?? '' : ''
      const inner = raw ? innerOf(raw) : ''
      const cnf = elementChildrenRaw(`<x>${inner}</x>`).find(k => /^<w:cnfStyle\b/.test(k)) ?? ''
      let rest = stripEls(inner, ['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcPrChange'])
      // 显式设定的底纹 / 垂直对齐覆盖原文件（'' = 去掉底纹）
      const bg = cell.node.attrs.background as string | null
      const va = cell.node.attrs.valign as string | null
      const over = (bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${esc(bg)}"/>` : '') + (va ? `<w:vAlign w:val="${va}"/>` : '')
      if (bg !== null || va !== null) rest = mergeEls(bg !== null ? stripEls(rest, ['shd']) : rest, over, TCPR_ORDER)
      const merge = continuation ? '<w:vMerge/>' : cell.rowspan > 1 ? '<w:vMerge w:val="restart"/>' : ''
      return `<w:tcPr>${cnf}<w:tcW w:w="${spanW(cell.left, cell.colspan)}" w:type="dxa"/>${cell.colspan > 1 ? `<w:gridSpan w:val="${cell.colspan}"/>` : ''}${merge}${rest}</w:tcPr>`
    }
    const trPrXml = (r: number): string => {
      let raw = ''
      if (orig) {
        for (let rr = r; rr >= 0 && !raw; rr--) {
          for (const c of grid.cells) {
            const k = c.top === rr ? keyOf(c) : undefined
            if (k && orig.trPr.has(k)) { raw = orig.trPr.get(k)!; break }
          }
        }
      }
      // 行属性里的表头标记由上面的规则决定；网格前后空位会打乱逻辑网格，一并去掉
      let inner = raw ? stripEls(innerOf(raw), ['tblHeader', 'gridBefore', 'gridAfter', 'wBefore', 'wAfter', 'trPrChange', 'ins', 'del']) : ''
      if (r < headerRows) {
        const at = inner.search(/<w:(tblCellSpacing|jc|hidden)\b/)
        inner = at === -1 ? inner + '<w:tblHeader/>' : inner.slice(0, at) + '<w:tblHeader/>' + inner.slice(at)
      }
      return inner ? `<w:trPr>${inner}</w:trPr>` : ''
    }

    // 单元格段落：未改的段落写回原文；改过或新加的沿用原段落（或借来的格式源首段）的段落属性与首个 run 的字符属性
    const fmtOf = (paraId: string | undefined, fallbackCell: GridCell | null) => {
      const raw = (paraId && orig?.para.get(paraId)) ?? (fallbackCell && orig ? orig.para.get(keyOf(fallbackCell)!) : undefined)
      if (!raw) return null
      const pKids = elementChildrenRaw(raw)
      const pPrRaw = pKids.find(k => /^<w:pPr\b/.test(k)) ?? ''
      const firstRun = pKids.find(k => /^<w:r\b/.test(k)) ?? ''
      const rPrRaw = elementChildrenRaw(firstRun).find(k => /^<w:rPr\b/.test(k)) ?? ''
      return {
        pPr: pPrRaw ? stripEls(innerOf(pPrRaw), ['pPrChange', 'sectPr']) : '',
        rPr: rPrRaw ? stripEls(innerOf(rPrRaw), ['b', 'bCs', 'i', 'iCs', 'u', 'vertAlign', 'rStyle', 'rPrChange', 'ins', 'del']) : '',
      }
    }
    const genPara = (p: PMNode, fmt: { pPr: string; rPr: string } | null) => {
      // 沿用原段落属性；段落自带样式或对齐（如 set_block_style 改过）时只覆盖 pStyle / jc，间距、缩进等照旧
      const own = p.attrs.style || p.attrs.align ? innerOf(pPr(p)) : ''
      const merged = !fmt ? own : own ? mergeEls(fmt.pPr, own, PPR_ORDER) : fmt.pPr
      return `<w:p>${merged ? `<w:pPr>${merged}</w:pPr>` : ''}${inline(p, fmt?.rPr ?? '')}</w:p>`
    }
    const cellParas = (cell: GridCell): string => {
      const fallback = fmtSource(cell)
      let paras = ''
      cell.node.forEach(p => {
        const id = p.attrs.id as string | undefined
        const before = id ? baseline.get(id) : undefined
        if (id && before?.eq(p) && orig?.para.has(id)) {
          paras += orig.para.get(id)!
          return
        }
        const fmt = fmtOf(id, fallback)
        let hasBr = false
        p.forEach(ch => { if (ch.type.name === 'hard_break') hasBr = true })
        // 单元格里改过的段落按换行拆成独立段落（批注收尾段落不拆，以免批注范围错位）
        if (hasBr && !commentEndParas.has(p) && p.type.name === 'paragraph') {
          let seg: PMNode[] = []
          p.forEach(ch => {
            if (ch.type.name === 'hard_break') {
              paras += genPara(p.type.create({ ...p.attrs, id: null }, seg, p.marks), fmt)
              seg = []
            } else seg.push(ch)
          })
          paras += genPara(p.type.create({ ...p.attrs, id: null }, seg, p.marks), fmt)
        } else paras += genPara(p, fmt)
      })
      return paras || '<w:p/>'
    }

    const rows: string[] = []
    for (let r = 0; r < grid.height; r++) {
      let tcs = ''
      for (let c = 0; c < width;) {
        const cell = grid.at(r, c)
        if (!cell) { c++; continue }
        if (cell.top !== r) tcs += `<w:tc>${tcPrXml(cell, true)}<w:p/></w:tc>`
        else tcs += `<w:tc>${tcPrXml(cell, false)}${cellParas(cell)}</w:tc>`
        c = cell.left + cell.colspan
      }
      rows.push(`<w:tr>${trPrXml(r)}${tcs}</w:tr>`)
    }
    const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`
    const tblPr = orig?.tblPr || `<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLook w:val="04A0"/></w:tblPr>`
    return `<w:tbl>${tblPr}<w:tblGrid>${colWs.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`
  }

  const list = (node: PMNode, ilvl: number, numId: string | null): string => {
    const ordered = node.type.name === 'ordered_list'
    // 与原文件里同列表的项共用编号（取第一个原样写回项的 numId）
    let id = numId
    if (!id) {
      node.forEach(item => {
        const src = item.firstChild ? input.src(item.firstChild.attrs.id as string) : null
        const m = src ? /<w:numId w:val="(\d+)"/.exec(src) : null
        if (!id && m) id = m[1]!
      })
    }
    id ??= numFor(ordered)
    let out = ''
    node.forEach(item => {
      item.forEach((child, _o, idx) => {
        if (idx === 0 && child.type.name === 'paragraph') {
          // 没有自带样式的列表段落：沿用原文件列表的段落样式，否则 List Paragraph（包里有该样式时）
          const styleId = numStyle.get(id!) ?? styles.get('list paragraph')
          out += verbatim(child) ?? `<w:p>${pPr(child, `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${id}"/></w:numPr>`, styleId)}${inline(child)}</w:p>`
        } else if (/_list$/.test(child.type.name)) {
          out += list(child, Math.min(8, ilvl + 1), child.type === node.type ? id : null)
        } else out += block(child)
      })
    })
    return out
  }

  const block = (node: PMNode): string => {
    switch (node.type.name) {
      case 'paragraph':
      case 'heading':
        return paragraph(node)
      case 'bullet_list':
      case 'ordered_list':
        return list(node, 0, null)
      case 'table':
        return table(node)
      case 'figure':
        if (skip.has(node.attrs.id as string)) return ''
        return unchanged(node) ?? figure(node)
      case 'opaque': {
        const src = input.src(node.attrs.id as string)
        if (src) return src
        warnings.push(`不可编辑块 ${node.attrs.id} 缺少原始内容，以文字占位`)
        return `<w:p><w:r><w:t xml:space="preserve">[${esc(String(node.attrs.description))}]</w:t></w:r></w:p>`
      }
      default:
        return ''
    }
  }

  // 参考文献表：去掉上次导出追加的平台条目后，① 末尾有用户自己的文献表 → 平台条目接在其后，沿用其最后一条的段落与字体格式；
  // ② 末尾只有「参考文献」标题 → 复用标题；③ 都没有 → 另起「参考文献」标题
  const byId = new Map(input.citations.map(c => [c.id, c]))
  let body = ''
  input.doc.forEach((n, _off, idx) => {
    if (idx < refPlan.bodyEnd) body += block(n)
  })
  if (refPlan.append.length > 0) {
    let pprXml = '<w:pPr><w:ind w:left="440" w:hanging="440"/></w:pPr>'
    let rprXml = ''
    if (refPlan.userCount > 0) {
      const last = input.doc.child(refPlan.bodyEnd - 1)
      const src = last.attrs.id ? input.src(last.attrs.id as string) : null
      if (src) {
        // 沿用段落与字体格式，但不带分节符、段前分页与修订标记（否则每条新条目都会另起一节 / 一页、修订 id 重复）
        const kids = elementChildrenRaw(src)
        const ppr = kids.find(k => /^<w:pPr\b/.test(k))
        const rpr = childEl(kids.find(k => /^<w:r\b/.test(k)), 'rPr')
        pprXml = ppr ? `<w:pPr>${stripEls(innerOf(ppr), ['sectPr', 'pPrChange', 'pageBreakBefore'])}</w:pPr>` : ''
        rprXml = rpr ? `<w:rPr>${stripEls(innerOf(rpr), ['rPrChange', 'ins', 'del'])}</w:rPr>` : ''
      }
      warnings.push(refPlan.duplicates > 0
        ? `正文末尾已有参考文献表（${refPlan.userCount} 条）：平台引用已合并进去，从 [${refPlan.userCount + 1}] 起编号；其中 ${refPlan.duplicates} 条与表中已有文献相同，沿用原编号`
        : `正文末尾已有参考文献表（${refPlan.userCount} 条）：平台引用已合并进去，从 [${refPlan.userCount + 1}] 起编号`)
    } else if (!refPlan.hasHeading) {
      const h = headingStyle(1)
      if (!styles.has(h.toLowerCase())) missingHeading.add(1)
      body += `<w:p><w:pPr><w:pStyle w:val="${esc(h)}"/></w:pPr><w:r><w:t>参考文献</w:t></w:r></w:p>`
    }
    for (const { id, n } of refPlan.append) {
      body += `<w:p>${pprXml}<w:r>${rprXml}<w:t xml:space="preserve">[${n}] ${esc(byId.get(id)!.formatted)}</w:t></w:r></w:p>`
    }
  } else if (refPlan.userCount > 0 && refPlan.duplicates > 0) {
    warnings.push(`正文里的引用都已在末尾的参考文献表中（${refPlan.duplicates} 条），沿用表中编号`)
  }

  // document.xml：沿用原文件的根元素（命名空间）与页面设置
  let head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>`
  let sect = SECT
  if (originalXml) {
    const bodyStart = /<w:body\b[^>]*>/.exec(originalXml)
    if (bodyStart) head = originalXml.slice(0, bodyStart.index + bodyStart[0].length)
    const last = bodyChildrenRaw(originalXml).at(-1)
    sect = last && /^<w:sectPr\b/.test(last) ? last : ''
    // 确保生成内容用到的命名空间都已声明
    for (const [prefix, uri] of [['r', REL], ['wp', 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'], ['a', 'http://schemas.openxmlformats.org/drawingml/2006/main'], ['pic', 'http://schemas.openxmlformats.org/drawingml/2006/picture']] as const) {
      if (!new RegExp(`xmlns:${prefix}=`).test(head)) head = head.replace(/<w:document\b/, `<w:document xmlns:${prefix}="${uri}"`)
    }
  }
  pkg.put('word/document.xml', `${head}${body}${sect}</w:body></w:document>`)

  // 补齐缺失的标题样式
  if (missingHeading.size > 0) {
    const stylesXml = pkg.text('word/styles.xml')
    if (stylesXml) {
      const add = [...missingHeading].map(n => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[36, 32, 28, 26, 24, 24][n - 1]}"/></w:rPr></w:style>`).join('')
      pkg.put('word/styles.xml', stylesXml.replace('</w:styles>', `${add}</w:styles>`))
    }
  }

  // 编号
  if (newNums.length > 0) {
    const lvls = (ordered: boolean) => Array.from({ length: 9 }, (_, i) => ordered
      ? `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][i % 3]}"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${420 * (i + 1)}" w:hanging="420"/></w:pPr></w:lvl>`
      : `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${['•', '◦', '▪'][i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${420 * (i + 1)}" w:hanging="420"/></w:pPr></w:lvl>`).join('')
    const abstracts = !usesPlatformNumbering ? '' : `<w:abstractNum w:abstractNumId="9001"><w:multiLevelType w:val="hybridMultilevel"/>${lvls(false)}</w:abstractNum><w:abstractNum w:abstractNumId="9002"><w:multiLevelType w:val="hybridMultilevel"/>${lvls(true)}</w:abstractNum>`
    if (!numberingXml) {
      numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}></w:numbering>`
      pkg.rel('numbering', 'numbering.xml')
      pkg.contentOverride('/word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml')
    }
    // abstractNum 必须排在所有 num 之前
    const firstNum = numberingXml.search(/<w:num\b/)
    numberingXml = firstNum === -1
      ? numberingXml.replace('</w:numbering>', `${abstracts}</w:numbering>`)
      : numberingXml.slice(0, firstNum) + abstracts + numberingXml.slice(firstNum)
    numberingXml = numberingXml.replace('</w:numbering>', `${newNums.join('')}</w:numbering>`)
    pkg.put('word/numbering.xml', numberingXml)
  }

  // 评论
  if (commentIds.size > 0) {
    const entries = [...commentIds].map(([thread, id]) => {
      const c = openComments.get(thread)!
      const paras = c.replies.map(r => `<w:p><w:r><w:t xml:space="preserve">${r.role === 'ai' ? 'Heurion' : '用户'}：${esc(r.text)}</w:t></w:r></w:p>`).join('') || '<w:p/>'
      return `<w:comment w:id="${id}" w:author="Heurion" w:initials="H" w:date="${c.created_at.slice(0, 19)}Z">${paras}</w:comment>`
    }).join('')
    const existing = pkg.text('word/comments.xml')
    pkg.put('word/comments.xml', existing
      ? existing.replace('</w:comments>', `${entries}</w:comments>`)
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${NS}>${entries}</w:comments>`)
    pkg.rel('comments', 'comments.xml')
    pkg.contentOverride('/word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml')
  }

  return { bytes: pkg.finish(), warnings: [...new Set(warnings)] }
}
