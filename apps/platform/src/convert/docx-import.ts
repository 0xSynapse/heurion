import { DOMParser, XMLSerializer, type Element as XElement, type Node as XNode } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import type { Mark, Node as PMNode } from 'prosemirror-model'
import { assignIds } from '../model/ids.ts'
import { schema } from '../model/schema.ts'

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

export interface DocxImport {
  doc: PMNode
  /** 节点 id → 原始 XML。 */
  src: Array<{ node_id: string; xml: string }>
  /** 待写入的资产：figure.asset_id 暂为 key，入库后由调用方替换为真实 asset id。 */
  assets: ImportedAsset[]
  warnings: string[]
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
  const out: string[] = []
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g
  tag.lastIndex = open.index + open[0].length
  let depth = 0
  let start = -1
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (m[2] === undefined) continue // 注释 / 处理指令
    const closing = m[1] === '/'
    const selfClosing = m[3] === '/'
    if (closing) {
      if (depth === 0) break // </w:body>
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
  const rawList = bodyChildrenRaw(strFromU8(files['word/document.xml']!))
  children(body).forEach((el, i) => { if (rawList[i] !== undefined) rawByEl.set(el, rawList[i]!) })
  const xmlOf = (el: XElement) => rawByEl.get(el) ?? serializer.serializeToString(el)

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
   * 段落里模型表达不了的内容：flags.unmodelled（文本框、嵌入对象、脚注 / 尾注引用）→ 整段落为
   * 不可编辑块原样写回，避免修改后重新生成时丢失；flags.fields（域代码）→ 仍可编辑，修改后域变为文字。
   */
  interface InlineFlags { unmodelled: string | null; fields: boolean }

  /** 段落里的行内内容；图片单独收集为块。 */
  const inlineOf = (p: XElement, figures: PMNode[], flags: InlineFlags = { unmodelled: null, fields: false }): PMNode[] => {
    const out: PMNode[] = []
    const walk = (el: XElement, marks: readonly Mark[]) => {
      for (const c of children(el)) {
        const name = local(c)
        if (c.namespaceURI !== W) {
          if (name === 'AlternateContent') flags.unmodelled ??= '文本框'
          continue
        }
        switch (name) {
          case 'r': runOf(c, marks, out, figures, flags); break
          case 'hyperlink': {
            const id = c.getAttributeNS(R, 'id') ?? c.getAttribute('r:id')
            const href = id ? rels.get(id) : c.getAttribute('w:anchor') ? `#${c.getAttribute('w:anchor')}` : undefined
            walk(c, href ? schema.marks.link!.create({ href }).addToSet(marks) : marks)
            break
          }
          case 'fldSimple': flags.fields = true; walk(c, marks); break
          case 'ins': case 'smartTag': case 'customXml': walk(c, marks); break
          case 'sdt': { const content = child(c, 'sdtContent'); if (content) walk(content, marks); break }
          case 'del': case 'pPr': case 'bookmarkStart': case 'bookmarkEnd': case 'proofErr': break
          default: break
        }
      }
    }
    walk(p, [])
    return out
  }

  const runOf = (r: XElement, outer: readonly Mark[], out: PMNode[], figures: PMNode[], flags: InlineFlags) => {
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
    for (const c of children(r)) {
      const name = local(c)
      if (c.namespaceURI !== W) {
        if (name === 'AlternateContent') flags.unmodelled ??= '文本框'
        continue
      }
      if (name === 't' && c.textContent) out.push(schema.text(c.textContent, marks))
      else if (name === 'tab') out.push(schema.text('\t', marks))
      else if (name === 'br' || name === 'cr') out.push(schema.node('hard_break'))
      else if (name === 'drawing' || name === 'pict') {
        const fig = figureFor(c)
        if (fig) figures.push(fig)
        else flags.unmodelled ??= name === 'pict' ? '文本框或图形' : '图形'
      }
      else if (name === 'object') flags.unmodelled ??= '嵌入对象'
      else if (name === 'footnoteReference') flags.unmodelled ??= '脚注'
      else if (name === 'endnoteReference') flags.unmodelled ??= '尾注'
      else if (name === 'fldChar') flags.fields = true
    }
  }

  const blocks: PMNode[] = []
  let unmodelledCount = 0
  let fieldParagraphs = 0
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

    if (numId && numId !== '0' && level === null) {
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
          paras.push(schema.node('paragraph', null, inlineOf(p, figures)))
        }
        const attrs = { colspan: span, rowspan: 1, header: false }
        cells.push({ attrs, content: paras.length > 0 ? paras : [schema.node('paragraph')] })
        if (vMerge === 'restart') merging.set(col, { row: ri, cell: cells.length - 1 })
        else merging.delete(col)
        col += span
      }
      const isShortMultiColFirstRow = ri === 0 && cells.length >= 2 && cells.every(c => {
        if (c.content.length > 2) return false
        let len = 0
        let hasBr = false
        for (const p of c.content) {
          len += p.textContent.length
          p.forEach(ch => { if (ch.type.name === 'hard_break') hasBr = true })
        }
        return !hasBr && len <= 80
      })
      const isHeader = explicitHeader !== null ? explicitHeader : isShortMultiColFirstRow
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
  if (unmodelledCount > 0) warnings.push(`${unmodelledCount} 个段落含文本框、嵌入对象或脚注，已作为不可编辑块原样保留`)
  if (fieldParagraphs > 0) warnings.push(`${fieldParagraphs} 个段落含域代码（如 EndNote / Zotero 引用、交叉引用），这些段落被修改后域会变为普通文字`)
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
  const doc = assignIds(raw, new Set())
  const src: Array<{ node_id: string; xml: string }> = []
  const pending = new Map(pendingSrc.map(p => [p.node, p.xml]))
  const walkPair = (a: PMNode, b: PMNode) => {
    const x = pending.get(a)
    if (x && b.attrs.id) src.push({ node_id: b.attrs.id as string, xml: x })
    for (let i = 0; i < a.childCount && i < b.childCount; i++) walkPair(a.child(i), b.child(i))
  }
  walkPair(raw, doc)
  return { doc, src, assets, warnings: [...new Set(warnings)] }
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
