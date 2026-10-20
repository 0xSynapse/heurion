import { randomBytes } from 'node:crypto'
import { DOMParser, XMLSerializer, type Element as XElement, type Node as XNode } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import type { Mark, Node as PMNode } from 'prosemirror-model'
import { threadMarks } from '../model/anchors.ts'
import { assignIds } from '../model/ids.ts'
import { schema } from '../model/schema.ts'
import { looksLikeHeaderRow } from '../model/table-header.ts'

/**
 * docx → 平台模型（PLATFORM.md §7.1）。
 *
 * 覆盖：标题（样式名 / outlineLvl）、段落、项目与编号列表（numbering.xml）、表格
 * （gridSpan / vMerge）、粗斜体 / 上下标 / 下划线 / 超链接、图片（导出为资产）、修订
 * （接受插入、丢弃删除）、内容控件（展开）。其余结构落为 opaque。
 * 每个顶层块（列表为每一项）的原始 XML 记入 src，供修补式导出使用。
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

export interface ImportedAsset { key: string; name: string; mime: string; bytes: Uint8Array }

/** 导入的 Word 批注线程（只含锚在文字上的；回复按 commentsExtended 的父子关系归到根批注下）。 */
export interface ImportedComment {
  /** 文档里 comment mark 的临时线程名（`word:<批注 id>`），入库时由 bindComments 换成平台线程 id。 */
  key: string
  word_id: string
  author: string | null
  date: string | null
  text: string
  /** Word 里已标记为「已解决」。 */
  done: boolean
  replies: Array<{ author: string | null; date: string | null; text: string }>
}

export interface DocxImport {
  doc: PMNode
  /** 节点 id → 原始 XML。 */
  src: Array<{ node_id: string; xml: string }>
  /** 待写入的资产：figure.asset_id 暂为 key，入库后由调用方替换为真实 asset id。 */
  assets: ImportedAsset[]
  /** Word 批注：文档里以 `word:<id>` 线程名锚定，入库时用 bindComments 换成平台线程。 */
  comments: ImportedComment[]
  warnings: string[]
}

type XDocument = ReturnType<DOMParser['parseFromString']>

/** 带文字的修订元素（插入、删除、移动）。 */
const REVISION = new Set(['ins', 'del', 'moveFrom', 'moveTo'])
/** 修订版块的 suggest_of 占位：分配 id 后换成紧挨在前面的原文版本块的 id。 */
const PREVIOUS = '@previous'

const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml'

/** comments.xml + commentsExtended.xml → 根批注（含回复）与回复批注 id 集合。 */
function parseComments(comments: XDocument | null, extended: XDocument | null): { roots: Map<string, ImportedComment>; replies: Set<string> } {
  const roots = new Map<string, ImportedComment>()
  const replies = new Set<string>()
  if (!comments) return { roots, replies }
  const all: Array<{ id: string; author: string | null; date: string | null; text: string; paraIds: string[] }> = []
  const list = comments.getElementsByTagNameNS(W, 'comment')
  for (let i = 0; i < list.length; i++) {
    const c = list.item(i)!
    const paras = children(c).filter(x => local(x) === 'p')
    const text = paras.map(p => { const ts = p.getElementsByTagNameNS(W, 't'); let s = ''; for (let k = 0; k < ts.length; k++) s += ts.item(k)!.textContent ?? ''; return s }).join('\n').trim()
    const paraIds = paras.map(p => p.getAttributeNS(W14, 'paraId') || p.getAttribute('w14:paraId') || '').filter(Boolean)
    all.push({ id: wAttr(c, 'id') ?? '', author: wAttr(c, 'author'), date: wAttr(c, 'date'), text, paraIds })
  }
  // 回复关系：回复批注最后一段的 paraId 指向父批注某一段的 paraId
  const parentOf = new Map<string, string>()
  const done = new Map<string, boolean>()
  const ex = extended?.getElementsByTagNameNS(W15, 'commentEx')
  for (let i = 0; i < (ex?.length ?? 0); i++) {
    const e = ex!.item(i)!
    const pid = e.getAttributeNS(W15, 'paraId') || e.getAttribute('w15:paraId') || ''
    const parent = e.getAttributeNS(W15, 'paraIdParent') || e.getAttribute('w15:paraIdParent') || ''
    if (parent) parentOf.set(pid, parent)
    done.set(pid, (e.getAttributeNS(W15, 'done') || e.getAttribute('w15:done')) === '1')
  }
  const ownerOfPara = new Map<string, string>()
  for (const c of all) for (const pid of c.paraIds) ownerOfPara.set(pid, c.id)
  const rootOf = (c: (typeof all)[number]): string | null => {
    const parent = parentOf.get(c.paraIds.at(-1) ?? '')
    return parent ? ownerOfPara.get(parent) ?? null : null
  }
  for (const c of all) {
    if (rootOf(c)) continue
    roots.set(c.id, { key: `word:${c.id}`, word_id: c.id, author: c.author, date: c.date, text: c.text, done: done.get(c.paraIds.at(-1) ?? '') ?? false, replies: [] })
  }
  for (const c of all) {
    let r = rootOf(c)
    // 回复的回复：一路找到根批注
    for (let guard = 0; r && !roots.has(r) && guard < 20; guard++) r = rootOf(all.find(x => x.id === r)!)
    if (!r || !roots.has(r)) continue
    replies.add(c.id)
    roots.get(r)!.replies.push({ author: c.author, date: c.date, text: c.text })
  }
  return { roots, replies }
}

/**
 * 导入的 Word 批注入库前：给每个线程分配平台 id，把文档里 `word:<id>` 线程名换掉，
 * 并按锚定的文字算出锚点块与片段（与 API 新建评论的字段一致）。
 */
export function bindComments(doc: PMNode, comments: ImportedComment[], makeId: () => string): { doc: PMNode; threads: Array<ImportedComment & { id: string; node_id: string; snippet: string }> } {
  const rename = new Map(comments.map(c => [c.key, makeId()]))
  const remark = (marks: readonly Mark[]) => marks.map(m => (m.type.name === 'comment' && rename.has(m.attrs.thread as string) ? m.type.create({ thread: rename.get(m.attrs.thread as string) }) : m))
  const walk = (n: PMNode): PMNode => {
    if (n.isLeaf) return n.mark(remark(n.marks))
    const kids: PMNode[] = []
    n.forEach(c => kids.push(walk(c)))
    return n.type.create(n.attrs, kids, n.marks)
  }
  const out = walk(doc)
  const anchors = threadMarks(out)
  const threads = comments.flatMap(c => {
    const id = rename.get(c.key)!
    const a = anchors.get(id)
    return a ? [{ ...c, id, node_id: a.node_ids[0]!, snippet: a.text.slice(0, 200) }] : []
  })
  return { doc: out, threads }
}

export class DocxImportError extends Error {}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', emf: 'image/emf', wmf: 'image/wmf' }

const children = (el: XNode): XElement[] => {
  const out: XElement[] = []
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as XElement)
  return out
}
const local = (el: XElement) => el.localName ?? el.nodeName.replace(/^.*:/, '')
const child = (el: XElement, name: string) => children(el).find(c => local(c) === name && c.namespaceURI === W)
const wAttr = (el: XElement | undefined, name: string) => el?.getAttributeNS(W, name) ?? el?.getAttribute(`w:${name}`) ?? null

/**
 * body 顶层子元素的原文（逐字节），与 DOM 中 body 的元素子节点一一对应。
 * 用原文而不是重新序列化：写回时字节不变，也不会多出命名空间声明。
 */
export function bodyChildrenRaw(xml: string): string[] {
  const open = /<w:body\b[^>]*>/.exec(xml)
  if (!open) return []
  return childrenFrom(xml, open.index + open[0].length)
}

/** 一个元素（原始 XML 字符串）的直接子元素原文；自闭合元素返回空数组。 */
export function elementChildrenRaw(xml: string): string[] {
  const open = /^\s*<[A-Za-z_][\w.:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/.exec(xml)
  if (!open || open[1] === '/') return []
  return childrenFrom(xml, open[0].length)
}

function childrenFrom(xml: string, from: number): string[] {
  const out: string[] = []
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g
  tag.lastIndex = from
  let depth = 0
  let start = -1
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (m[2] === undefined) continue // 注释 / 处理指令
    const closing = m[1] === '/'
    const selfClosing = m[3] === '/'
    if (closing) {
      if (depth === 0) break // 父元素的结束标签
      depth--
      if (depth === 0) out.push(xml.slice(start, m.index + m[0].length))
    } else if (selfClosing) {
      if (depth === 0) out.push(m[0])
    } else {
      if (depth === 0) start = m.index
      depth++
    }
  }
  return out
}

interface StyleInfo { name: string; outline: number | null; basedOn: string | null }
interface ListInfo { numId: string; ilvl: number; ordered: boolean }

const MAX_ZIP_BYTES = 150 * 1024 * 1024
const MAX_ZIP_ENTRIES = 2500

export function safeUnzipDocx(bytes: Uint8Array): Record<string, Uint8Array> {
  let totalBytes = 0
  let entries = 0
  return unzipSync(bytes, {
    filter(file) {
      entries++
      totalBytes += file.originalSize ?? 0
      if (entries > MAX_ZIP_ENTRIES || totalBytes > MAX_ZIP_BYTES) {
        throw new DocxImportError('DOCX_INVALID: zip 解压体积或条目数超限')
      }
      return true
    },
  })
}

export function importDocx(bytes: Uint8Array): DocxImport {
  let files: Record<string, Uint8Array>
  try {
    files = safeUnzipDocx(bytes)
  } catch (err) {
    if (err instanceof DocxImportError) throw err
    throw new DocxImportError('不是有效的 docx 文件（zip 解析失败）')
  }
  const xml = (name: string) => files[name] ? new DOMParser().parseFromString(strFromU8(files[name]!), 'text/xml') : null
  const document = xml('word/document.xml')
  if (!document) throw new DocxImportError('docx 缺少 word/document.xml')

  const styles = parseStyles(xml('word/styles.xml'))
  const numbering = parseNumbering(xml('word/numbering.xml'))
  const rels = parseRels(xml('word/_rels/document.xml.rels'))
  const serializer = new XMLSerializer()
  const assets: ImportedAsset[] = []
  const warnings: string[] = []
  const pendingSrc: Array<{ node: PMNode; xml: string }> = []

  const body = document.getElementsByTagNameNS(W, 'body')[0]
  if (!body) throw new DocxImportError('docx 缺少 w:body')
  const rawByEl = new Map<XElement, string>()
  const documentText = strFromU8(files['word/document.xml']!)
  const rawList = bodyChildrenRaw(documentText)
  // 正文层级的内容控件里的块同样记原文（按原文切片，不重新序列化，否则未改动时写回的 XML 与原文不同）
  const mapRaw = (el: XElement, raw: string) => {
    rawByEl.set(el, raw)
    if (local(el) !== 'sdt') return
    const content = child(el, 'sdtContent')
    const rawContent = elementChildrenRaw(raw).find(k => /^<w:sdtContent\b/.test(k))
    if (!content || !rawContent) return
    const rawKids = elementChildrenRaw(rawContent)
    const kids = children(content)
    if (rawKids.length === kids.length) kids.forEach((k, i) => mapRaw(k, rawKids[i]!))
  }
  children(body).forEach((el, i) => { if (rawList[i] !== undefined) mapRaw(el, rawList[i]!) })
  const xmlOf = (el: XElement) => rawByEl.get(el) ?? serializer.serializeToString(el)
  // 行内元素的原文：序列化时去掉根元素已声明的命名空间（避免写回时每个 run 都带一串 xmlns）
  const rootNs = [.../<w:document\b[^>]*>/.exec(documentText)?.[0].matchAll(/\sxmlns:([\w.-]+)="([^"]*)"/g) ?? []]
  const inlineXml = (el: XElement) => rootNs.reduce((s, m) => s.split(` xmlns:${m[1]}="${m[2]}"`).join(''), serializer.serializeToString(el))

  // 脚注 / 尾注正文（读视图里给模型看；导出时正文仍在原文件包里）
  const noteText = (part: string, tag: string) => {
    const out = new Map<string, string>()
    const d = xml(part)
    const list = d?.getElementsByTagNameNS(W, tag)
    for (let i = 0; i < (list?.length ?? 0); i++) {
      const n = list!.item(i)!
      const ts = n.getElementsByTagNameNS(W, 't')
      let text = ''
      for (let k = 0; k < ts.length; k++) text += ts.item(k)!.textContent ?? ''
      out.set(wAttr(n, 'id') ?? '', text.trim())
    }
    return out
  }
  const footnotes = noteText('word/footnotes.xml', 'footnote')
  const endnotes = noteText('word/endnotes.xml', 'endnote')
  // Word 批注：正在进行的批注范围（只记根批注；回复的范围与根批注重合）给文字加 comment mark
  const { roots: wordComments } = parseComments(xml('word/comments.xml'), xml('word/commentsExtended.xml'))
  const activeComments = new Set<string>()
  const withComments = (marks: readonly Mark[]) => {
    let out = marks
    for (const id of activeComments) out = schema.marks.comment!.create({ thread: `word:${id}` }).addToSet(out)
    return out
  }
  /** 批注范围的起止标记：更新进行中的范围；不是这类元素返回 false。 */
  const commentRange = (el: XElement): boolean => {
    const name = local(el)
    if (el.namespaceURI !== W || (name !== 'commentRangeStart' && name !== 'commentRangeEnd')) return false
    const id = wAttr(el, 'id') ?? ''
    if (wordComments.has(id)) {
      if (name === 'commentRangeStart') activeComments.add(id)
      else activeComments.delete(id)
    }
    return true
  }

  let wordKeys = 0
  const wordInline = (kind: 'footnote' | 'endnote' | 'field' | 'object', text: string, xmlText: string, marks: readonly Mark[]) =>
    schema.node('word_inline', { key: `w${++wordKeys}`, kind, text, xml: xmlText }, undefined, withComments(marks))

  /** 复杂域（fldChar begin … end）：从 begin 所在的兄弟元素起，找到与之配对的 end 所在元素的下标；找不到返回 -1。 */
  const fieldEnd = (kids: XElement[], from: number): number => {
    let depth = 0
    for (let j = from; j < kids.length; j++) {
      const chars = kids[j]!.getElementsByTagNameNS(W, 'fldChar')
      for (let k = 0; k < chars.length; k++) {
        const type = wAttr(chars.item(k)!, 'fldCharType')
        if (type === 'begin') depth++
        else if (type === 'end' && --depth === 0) return j
      }
    }
    return -1
  }
  /** 复杂域的显示文字：最外层 separate 之后、end 之前的文字（含嵌套域的结果）。 */
  const fieldResult = (els: XElement[]): string => {
    let depth = 0
    let shown = false
    let text = ''
    const visit = (el: XElement) => {
      for (const c of children(el)) {
        const name = local(c)
        if (name === 'fldChar') {
          const type = wAttr(c, 'fldCharType')
          if (type === 'begin') depth++
          else if (type === 'separate' && depth === 1) shown = true
          else if (type === 'end') depth--
        } else if (name === 't' && shown && depth >= 1) text += c.textContent ?? ''
        else visit(c)
      }
    }
    for (const el of els) visit(el)
    return text
  }
  const startsField = (el: XElement) => local(el) === 'r' && children(el).some(c => local(c) === 'fldChar' && wAttr(c, 'fldCharType') === 'begin')

  const headingLevel = (styleId: string | null, pPr: XElement | undefined): number | null => {
    const outline = pPr ? wAttr(child(pPr, 'outlineLvl'), 'val') : null
    if (outline !== null && Number(outline) < 9) return Math.min(6, Number(outline) + 1)
    let id = styleId
    for (let depth = 0; id && depth < 5; depth++) {
      const s = styles.get(id)
      if (!s) break
      const m = /^(?:heading|标题)\s*(\d)$/i.exec(s.name)
      if (m) return Math.min(6, Number(m[1]))
      if (/^title$/i.test(s.name)) return 1
      if (s.outline !== null) return Math.min(6, s.outline + 1)
      id = s.basedOn
    }
    return null
  }

  const figureFor = (drawing: XElement): PMNode | null => {
    const blip = drawing.getElementsByTagNameNS(A, 'blip')[0]
    const embed = blip?.getAttributeNS(R, 'embed') ?? blip?.getAttribute('r:embed')
    const target = embed ? rels.get(embed) : undefined
    if (!target) return null
    const path = target.startsWith('/') ? target.slice(1) : `word/${target}`
    const data = files[path]
    if (!data) return null
    const ext = path.split('.').pop()!.toLowerCase()
    const key = `import-${assets.length}`
    assets.push({ key, name: path.split('/').pop()!, mime: MIME[ext] ?? 'application/octet-stream', bytes: data })
    const docPr = drawing.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'docPr')[0]
    return schema.node('figure', { asset_id: key, alt: docPr?.getAttribute('descr') || docPr?.getAttribute('name') || '' })
  }

  /**
   * 段落里模型表达不了的内容：flags.unmodelled（文本框、嵌入对象）→ 整段落为不可编辑块原样写回，
   * 避免修改后重新生成时丢失；脚注 / 尾注引用与域代码 → word_inline 原子（原始 XML 原样写回，段落仍可编辑）；
   * flags.fields：找不到配对结束标记的残缺域代码，修改后会变为文字。
   */
  interface InlineFlags { unmodelled: string | null; fields: boolean }

  /** 这个 run 是否含模型表达不了的对象：兼容内容、嵌入对象，或不是图片的图形（图表、文本框、形状）。 */
  const isObjectRun = (r: XElement): boolean => children(r).some(c => {
    const name = local(c)
    if (c.namespaceURI !== W) return name === 'AlternateContent'
    if (name === 'object') return true
    if (name === 'drawing' || name === 'pict') return !isPicture(c)
    return false
  })
  /** 图形里有能解析到文件的图片（导入为图块）。 */
  const isPicture = (drawing: XElement): boolean => {
    const blip = drawing.getElementsByTagNameNS(A, 'blip')[0]
    const embed = blip?.getAttributeNS(R, 'embed') ?? blip?.getAttribute('r:embed')
    const target = embed ? rels.get(embed) : undefined
    return !!target && !!files[target.startsWith('/') ? target.slice(1) : `word/${target}`]
  }
  /** 对象在读视图里的说明：文本框带其中的文字，嵌入对象带程序名。 */
  const objectLabel = (el: XElement): string => {
    const box = el.getElementsByTagNameNS(W, 'txbxContent')[0]
    if (box) return `文本框：${(box.textContent ?? '').trim().slice(0, 80)}`
    if (el.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/chart', 'chart').length) return '图表'
    const ole = [...Array.from(el.getElementsByTagName('o:OLEObject'))][0]
    if (ole) return `嵌入对象（${ole.getAttribute('ProgID') ?? 'OLE'}）`
    return '图形'
  }

  /** 段落里的行内内容；图片单独收集为块。 */
  /**
   * mode：accepted = 接受所有修订后的文字（默认）；original = 修订前的原文（删除的文字算在内、插入的不算），
   * 用于把 Word 修订导入为平台的待采纳修订。
   */
  const inlineOf = (p: XElement, figures: PMNode[], flags: InlineFlags = { unmodelled: null, fields: false }, mode: 'accepted' | 'original' = 'accepted'): PMNode[] => {
    const out: PMNode[] = []
    const walk = (el: XElement, marks: readonly Mark[]) => {
      const kids = children(el)
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i]!
        const name = local(c)
        if (c.namespaceURI !== W) {
          // 段落层级的兼容内容（文本框等）：整体作为一个对象原子，原样写回
          if (name === 'AlternateContent') out.push(wordInline('object', objectLabel(c), inlineXml(c), marks))
          continue
        }
        if (commentRange(c)) continue
        if (startsField(c)) {
          const end = fieldEnd(kids, i)
          if (end >= 0) {
            const els = kids.slice(i, end + 1)
            out.push(wordInline('field', fieldResult(els), els.map(inlineXml).join(''), marks))
            i = end
            continue
          }
          flags.fields = true
        }
        switch (name) {
          case 'r': runOf(c, marks, out, figures, flags, mode); break
          case 'hyperlink': {
            const id = c.getAttributeNS(R, 'id') ?? c.getAttribute('r:id')
            const href = id ? rels.get(id) : c.getAttribute('w:anchor') ? `#${c.getAttribute('w:anchor')}` : undefined
            walk(c, href ? schema.marks.link!.create({ href }).addToSet(marks) : marks)
            break
          }
          case 'fldSimple': out.push(wordInline('field', c.textContent ?? '', inlineXml(c), marks)); break
          case 'ins': case 'moveTo': if (mode === 'accepted') walk(c, marks); break
          case 'del': case 'moveFrom': if (mode === 'original') walk(c, marks); break
          case 'smartTag': case 'customXml': walk(c, marks); break
          case 'sdt': { const content = child(c, 'sdtContent'); if (content) walk(content, marks); break }
          case 'pPr': case 'bookmarkStart': case 'bookmarkEnd': case 'proofErr': break
          default: break
        }
      }
    }
    walk(p, [])
    return out
  }

  const runOf = (r: XElement, outer: readonly Mark[], out: PMNode[], figures: PMNode[], flags: InlineFlags, mode: 'accepted' | 'original') => {
    // 脚注 / 尾注引用：整个 run 作为一个原子（编号样式、上标都在原 run 里）
    const note = children(r).find(c => c.namespaceURI === W && (local(c) === 'footnoteReference' || local(c) === 'endnoteReference'))
    if (note) {
      const kind = local(note) === 'footnoteReference' ? 'footnote' : 'endnote'
      const id = wAttr(note, 'id') ?? ''
      out.push(wordInline(kind, (kind === 'footnote' ? footnotes : endnotes).get(id) ?? '', inlineXml(r), outer))
      return
    }
    // 文本框、图表、形状、嵌入对象（公式编辑器、Excel 等）：整个 run 作为一个对象原子（原始 XML 原样写回），
    // 段落其余文字照常可改
    if (isObjectRun(r)) { out.push(wordInline('object', objectLabel(r), inlineXml(r), outer)); return }
    const rPr = child(r, 'rPr')
    let marks = outer
    const on = (name: string) => {
      const el = rPr && child(rPr, name)
      return !!el && !/^(0|false|none)$/.test(wAttr(el, 'val') ?? 'true')
    }
    if (on('b')) marks = schema.marks.bold!.create().addToSet(marks)
    if (on('i')) marks = schema.marks.italic!.create().addToSet(marks)
    if (on('u')) marks = schema.marks.underline!.create().addToSet(marks)
    const va = rPr && wAttr(child(rPr, 'vertAlign'), 'val')
    if (va === 'superscript') marks = schema.marks.sup!.create().addToSet(marks)
    if (va === 'subscript') marks = schema.marks.sub!.create().addToSet(marks)
    marks = withComments(marks)
    for (const c of children(r)) {
      const name = local(c)
      if (c.namespaceURI !== W) {
        if (name === 'AlternateContent') flags.unmodelled ??= '文本框'
        continue
      }
      if ((name === 't' || (name === 'delText' && mode === 'original')) && c.textContent) out.push(schema.text(c.textContent, marks))
      else if (name === 'tab') out.push(schema.text('\t', marks))
      else if (name === 'br' || name === 'cr') out.push(schema.node('hard_break'))
      else if ((name === 'drawing' || name === 'pict') && mode === 'accepted') {
        const fig = figureFor(c)
        if (fig) figures.push(fig)
        else flags.unmodelled ??= name === 'pict' ? '文本框或图形' : '图形'
      }
      else if (name === 'object') flags.unmodelled ??= '嵌入对象'
      else if (name === 'fldChar') flags.fields = true
    }
  }

  const blocks: PMNode[] = []
  let unmodelledCount = 0
  let fieldParagraphs = 0
  let acceptedRevisions = 0

  /** 段落里带文字的修订（插入、删除、移动；不含段落标记与格式的修订）及第一处修订的作者。 */
  const revisionOf = (p: XElement): { has: boolean; author: string | null } => {
    let has = false
    let author: string | null = null
    const visit = (el: XElement) => {
      for (const c of children(el)) {
        if (c.namespaceURI !== W || local(c) === 'pPr' || local(c) === 'rPr') continue
        if (REVISION.has(local(c)) && c.getElementsByTagNameNS(W, 'r').length > 0) {
          if (!has) author = wAttr(c, 'author')
          has = true
        } else visit(c)
      }
    }
    visit(p)
    return { has, author }
  }
  const textOf = (nodes: PMNode[]) => nodes.map(n => (n.isText ? n.text : n.type.name)).join('')
  // 列表栈：按 numId 连续分组，ilvl 决定嵌套
  let listStack: Array<{ info: ListInfo; items: PMNode[][] }> = []

  const flushLists = (toDepth = 0) => {
    while (listStack.length > toDepth) {
      const top = listStack.pop()!
      const list = schema.node(top.info.ordered ? 'ordered_list' : 'bullet_list', null,
        top.items.map(content => schema.node('list_item', null, content)))
      if (listStack.length > 0) {
        const parent = listStack[listStack.length - 1]!
        const last = parent.items[parent.items.length - 1]
        if (last) last.push(list)
        else parent.items.push([schema.node('paragraph'), list])
      } else blocks.push(list)
    }
  }

  const paragraph = (p: XElement) => {
    const pPr = child(p, 'pPr')
    const styleId = wAttr(pPr && child(pPr, 'pStyle'), 'val')
    const align = wAttr(pPr && child(pPr, 'jc'), 'val')
    const figures: PMNode[] = []
    const flags: InlineFlags = { unmodelled: null, fields: false }
    const commentsBefore = new Set(activeComments)
    const inline = inlineOf(p, figures, flags)
    const level = headingLevel(styleId, pPr)
    const numPr = pPr && child(pPr, 'numPr')
    const numId = wAttr(numPr && child(numPr, 'numId'), 'val')
    const ilvl = Number(wAttr(numPr && child(numPr, 'ilvl'), 'val') ?? 0)
    const styleName = styleId ? styles.get(styleId)?.name ?? styleId : null
    const alignAttr = align === 'center' ? 'center' : align === 'right' || align === 'end' ? 'right' : align === 'both' ? 'justify' : null
    const xmlText = xmlOf(p)

    if (flags.unmodelled) {
      // 整段原样保留（含编号属性），不进列表分组
      flushLists()
      const text = inline.map(n => n.textContent).join('').trim()
      const node = schema.node('opaque', { kind: flags.unmodelled, description: text.slice(0, 200) || `含${flags.unmodelled}的段落` })
      blocks.push(node)
      pendingSrc.push({ node, xml: xmlText })
      unmodelledCount++
      return
    }
    if (flags.fields) fieldParagraphs++

    // Word 修订：再按原文解析一遍（批注范围从同一起点重放），两者不同就导入为待采纳修订
    const revision = revisionOf(p)
    let original: PMNode[] | null = null
    if (revision.has) {
      const after = new Set(activeComments)
      activeComments.clear()
      for (const id of commentsBefore) activeComments.add(id)
      original = inlineOf(p, [], { unmodelled: null, fields: false }, 'original')
      activeComments.clear()
      for (const id of after) activeComments.add(id)
      if (textOf(original) === textOf(inline)) original = null
    }

    if (numId && numId !== '0' && level === null) {
      if (original) acceptedRevisions++
      // 换了一个列表 → 收起；更浅的层级 → 收起更深的层
      if (listStack.length > 0 && listStack[0]!.info.numId !== numId) flushLists(0)
      if (listStack.length > ilvl + 1) flushLists(ilvl + 1)
      while (listStack.length < ilvl + 1) {
        const depth = listStack.length
        listStack.push({ info: { numId, ilvl: depth, ordered: numbering.get(`${numId}:${depth}`) ?? false }, items: [] })
      }
      const para = schema.node('paragraph', { style: styleName, align: alignAttr }, inline)
      const level0 = listStack[ilvl]!
      level0.items.push([para, ...figures])
      pendingSrc.push({ node: para, xml: xmlText })
      return
    }
    flushLists()
    if (original) {
      // 原文版本（待删除）挂原始 XML，未改动时整段原样写回（修订仍在）；修订版（待新增）紧跟其后
      const type = level !== null ? 'heading' : 'paragraph'
      const base = level !== null ? { level, style: styleName, align: alignAttr } : { style: styleName, align: alignAttr }
      const rev = { suggest_group: `g${randomBytes(4).toString('hex')}`, suggest_author: revision.author }
      if (textOf(original).trim() === '') {
        // 整段都是新插入的
        const node = schema.node(type, { ...base, ...rev, suggest: 'insert' }, inline)
        blocks.push(node, ...figures)
        pendingSrc.push({ node, xml: xmlText })
      } else if (textOf(inline).trim() === '') {
        // 整段都被删除
        const node = schema.node(type, { ...base, ...rev, suggest: 'delete' }, original)
        blocks.push(node)
        pendingSrc.push({ node, xml: xmlText })
      } else {
        const del = schema.node(type, { ...base, ...rev, suggest: 'delete' }, original)
        blocks.push(del, schema.node(type, { ...base, ...rev, suggest: 'insert', suggest_of: PREVIOUS }, inline), ...figures)
        pendingSrc.push({ node: del, xml: xmlText })
      }
      return
    }
    // 紧跟在图后面的题注段落 → 并回图的 caption
    const prev = blocks[blocks.length - 1]
    if (figures.length === 0 && prev?.type.name === 'figure' && !prev.attrs.caption && styleName && /^(caption|题注)$/i.test(styleName)) {
      blocks[blocks.length - 1] = prev.type.create({ ...prev.attrs, caption: inline.map(n => n.textContent).join('') })
      return
    }
    // 只有一张图的段落：图本身承接段落原文（未改动时原样写回）
    if (inline.length === 0 && figures.length === 1) {
      blocks.push(figures[0]!)
      pendingSrc.push({ node: figures[0]!, xml: xmlText })
      return
    }
    if (inline.length > 0 || figures.length === 0) {
      const node = level !== null
        ? schema.node('heading', { level, style: styleName, align: alignAttr }, inline)
        : schema.node('paragraph', { style: styleName, align: alignAttr }, inline)
      blocks.push(node)
      pendingSrc.push({ node, xml: xmlText })
    }
    blocks.push(...figures)
  }

  const table = (tbl: XElement): PMNode => {
    const rows: PMNode[] = []
    // vMerge：记录每个网格列上正在延续的单元格（行下标、单元格下标）
    const merging = new Map<number, { row: number; cell: number }>()
    const rowCells: Array<Array<{ attrs: Record<string, unknown>; content: PMNode[] }>> = []
    children(tbl).filter(c => local(c) === 'tr').forEach((tr, ri) => {
      const trPr = child(tr, 'trPr')
      const tblHeaderEl = trPr && child(trPr, 'tblHeader')
      const explicitHeader = tblHeaderEl
        ? !/^(0|false|off)$/i.test(wAttr(tblHeaderEl, 'val') ?? '1')
        : null
      const cells: Array<{ attrs: Record<string, unknown>; content: PMNode[] }> = []
      let col = 0
      for (const tc of children(tr).filter(c => local(c) === 'tc')) {
        const tcPr = child(tc, 'tcPr')
        const span = Number(wAttr(tcPr && child(tcPr, 'gridSpan'), 'val') ?? 1)
        const vMergeEl = tcPr && child(tcPr, 'vMerge')
        const vMerge = vMergeEl ? (wAttr(vMergeEl, 'val') ?? 'continue') : null
        if (vMerge === 'continue') {
          const origin = merging.get(col)
          if (origin) {
            const cell = rowCells[origin.row]![origin.cell]!
            cell.attrs.rowspan = (cell.attrs.rowspan as number) + 1
          }
          col += span
          continue
        }
        const paras: PMNode[] = []
        for (const p of children(tc).filter(c => local(c) === 'p')) {
          const figures: PMNode[] = []
          if (revisionOf(p).has) acceptedRevisions++
          paras.push(schema.node('paragraph', null, inlineOf(p, figures)))
        }
        const attrs = { colspan: span, rowspan: 1, header: false }
        cells.push({ attrs, content: paras.length > 0 ? paras : [schema.node('paragraph')] })
        if (vMerge === 'restart') merging.set(col, { row: ri, cell: cells.length - 1 })
        else merging.delete(col)
        col += span
      }
      const isHeader = explicitHeader !== null ? explicitHeader : ri === 0 && looksLikeHeaderRow(cells.map(c => c.content))
      for (const c of cells) c.attrs.header = isHeader
      rowCells.push(cells)
    })
    for (const cells of rowCells) {
      if (cells.length === 0) continue
      rows.push(schema.node('table_row', null, cells.map(c => schema.node('table_cell', c.attrs, c.content))))
    }
    return schema.node('table', null, rows.length > 0 ? rows : [schema.node('table_row', null, [schema.node('table_cell', null, [schema.node('paragraph')])])])
  }

  const blockLevel = (el: XElement) => {
    // 正文层级的批注起止标记（跨段落的批注）：只更新范围，不打断列表分组
    if (commentRange(el)) return
    const name = local(el)
    if (el.namespaceURI === W && name === 'p') return paragraph(el)
    flushLists()
    if (el.namespaceURI === W && name === 'tbl') {
      const node = table(el)
      blocks.push(node)
      pendingSrc.push({ node, xml: xmlOf(el) })
      return
    }
    if (el.namespaceURI === W && name === 'sdt') {
      const content = child(el, 'sdtContent')
      if (content) for (const c of children(content)) blockLevel(c)
      return
    }
    if (el.namespaceURI === W && (name === 'sectPr' || name === 'bookmarkStart' || name === 'bookmarkEnd' || name === 'proofErr')) return
    const description = (el.textContent ?? '').trim().slice(0, 60) || name
    const node = schema.node('opaque', { kind: name, description })
    blocks.push(node)
    pendingSrc.push({ node, xml: xmlOf(el) })
  }

  for (const el of children(body)) blockLevel(el)
  flushLists()
  if (unmodelledCount > 0) warnings.push(`${unmodelledCount} 个段落含文本框或嵌入对象，已作为不可编辑块原样保留`)
  if (acceptedRevisions > 0) warnings.push(`${acceptedRevisions} 处 Word 修订位于列表或表格里，已按「接受」导入；未改动时导出仍原样保留修订`)
  if (fieldParagraphs > 0) warnings.push(`${fieldParagraphs} 个段落含不完整的域代码（缺少结束标记），这些段落被修改后域会变为普通文字`)
  if (blocks.length === 0) blocks.push(schema.node('paragraph'))

  // Word 常给相邻的列表项分配不同 numId：相邻的同类列表合并成一个
  const merged: PMNode[] = []
  for (const b of blocks) {
    const prev = merged[merged.length - 1]
    if (prev && /_list$/.test(b.type.name) && prev.type === b.type) {
      merged[merged.length - 1] = prev.type.create(prev.attrs, prev.content.append(b.content))
    } else merged.push(b)
  }

  // 分配 id：先给整棵树补号，再按节点身份把原始 XML 对上新 id
  const raw = schema.node('doc', null, merged)
  const ids = assignIds(raw, new Set())
  const src: Array<{ node_id: string; xml: string }> = []
  const pending = new Map(pendingSrc.map(p => [p.node, p.xml]))
  const walkPair = (a: PMNode, b: PMNode) => {
    const x = pending.get(a)
    if (x && b.attrs.id) src.push({ node_id: b.attrs.id as string, xml: x })
    for (let i = 0; i < a.childCount && i < b.childCount; i++) walkPair(a.child(i), b.child(i))
  }
  walkPair(raw, ids)
  // 修订版块指向紧挨在前面的原文版本块
  const fixed: PMNode[] = []
  ids.forEach((n, _o, i) => fixed.push(n.attrs.suggest_of === PREVIOUS ? n.type.create({ ...n.attrs, suggest_of: ids.child(i - 1).attrs.id }, n.content, n.marks) : n))
  const doc = ids.type.create(ids.attrs, fixed)
  const anchored = threadMarks(doc)
  const comments = [...wordComments.values()].filter(c => anchored.has(c.key))
  if (comments.length < wordComments.size) warnings.push(`${wordComments.size - comments.length} 条 Word 批注锚在图片或不可编辑内容上，没有转为平台评论（导出时原样保留）`)
  return { doc, src, assets, comments, warnings: [...new Set(warnings)] }
}

function parseStyles(doc: ReturnType<DOMParser['parseFromString']> | null): Map<string, StyleInfo> {
  const map = new Map<string, StyleInfo>()
  if (!doc) return map
  const list = doc.getElementsByTagNameNS(W, 'style')
  for (let i = 0; i < list.length; i++) {
    const s = list.item(i)!
    const id = wAttr(s, 'styleId')
    if (!id) continue
    const name = wAttr(child(s, 'name'), 'val') ?? id
    const pPr = child(s, 'pPr')
    const outline = wAttr(pPr && child(pPr, 'outlineLvl'), 'val')
    map.set(id, { name, outline: outline === null ? null : Number(outline), basedOn: wAttr(child(s, 'basedOn'), 'val') })
  }
  return map
}

/** `${numId}:${ilvl}` → 是否有序。 */
function parseNumbering(doc: ReturnType<DOMParser['parseFromString']> | null): Map<string, boolean> {
  const out = new Map<string, boolean>()
  if (!doc) return out
  const abstract = new Map<string, Map<number, boolean>>()
  const abs = doc.getElementsByTagNameNS(W, 'abstractNum')
  for (let i = 0; i < abs.length; i++) {
    const a = abs.item(i)!
    const levels = new Map<number, boolean>()
    for (const lvl of children(a).filter(c => local(c) === 'lvl')) {
      const fmt = wAttr(child(lvl, 'numFmt'), 'val') ?? 'bullet'
      levels.set(Number(wAttr(lvl, 'ilvl') ?? 0), fmt !== 'bullet' && fmt !== 'none')
    }
    abstract.set(wAttr(a, 'abstractNumId') ?? '', levels)
  }
  const nums = doc.getElementsByTagNameNS(W, 'num')
  for (let i = 0; i < nums.length; i++) {
    const n = nums.item(i)!
    const levels = abstract.get(wAttr(child(n, 'abstractNumId'), 'val') ?? '')
    if (!levels) continue
    for (const [lvl, ordered] of levels) out.set(`${wAttr(n, 'numId')}:${lvl}`, ordered)
  }
  return out
}

function parseRels(doc: ReturnType<DOMParser['parseFromString']> | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!doc) return out
  const list = doc.getElementsByTagName('Relationship')
  for (let i = 0; i < list.length; i++) {
    const r = list.item(i)!
    out.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '')
  }
  return out
}

/** 把 figure.asset_id 中的导入 key 换成真实资产 id。 */
export function bindAssets(doc: PMNode, ids: Map<string, string>): PMNode {
  const walk = (n: PMNode): PMNode => {
    if (n.type.name === 'figure') {
      const real = ids.get(n.attrs.asset_id as string)
      return real ? n.type.create({ ...n.attrs, asset_id: real }) : n
    }
    if (n.isLeaf) return n
    const kids: PMNode[] = []
    n.forEach(c => kids.push(walk(c)))
    return n.type.create(n.attrs, kids, n.marks)
  }
  return walk(doc)
}
