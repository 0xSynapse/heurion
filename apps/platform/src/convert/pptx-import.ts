import { DOMParser, type Element as XElement, type Node as XNode } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import type { Mark, Node as PMNode } from 'prosemirror-model'
import { assignIds } from '../model/ids.ts'
import { deckSchema, type ShapeKind } from '../model/deck-schema.ts'
import { readChart } from './pptx-chart.ts'
import type { ImportedAsset } from './docx-import.ts'

/**
 * pptx → deck 模型（PLATFORM.md §7）。
 *
 * 每页按 spTree 的顶层子元素逐个建形状：文本 / 占位符（文字、段落与文字段的原始格式）、图片（入资产库）、
 * 表格（单元格文字）、图表 / 组合 / 连接线 / 其他（不可编辑，可移动、可删除）。
 * 每个形状保存**逐字节原文**（修补式导出：未改动的形状原样写回）；没写位置的占位符从版式 / 母版继承几何。
 * 演讲者备注读入 notes。
 */

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export interface PptxImport {
  doc: PMNode
  /** 形状 id → 原始 XML。 */
  src: Array<{ node_id: string; xml: string }>
  assets: ImportedAsset[]
  /** 页面尺寸（EMU）。 */
  size: { cx: number; cy: number }
  warnings: string[]
}

export class PptxImportError extends Error {}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', emf: 'image/emf', wmf: 'image/wmf', tif: 'image/tiff', tiff: 'image/tiff' }

const kids = (el: XNode | null | undefined): XElement[] => {
  const out: XElement[] = []
  for (let c = el?.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as XElement)
  return out
}
const local = (el: XElement) => el.localName ?? el.nodeName.replace(/^.*:/, '')
const first = (el: XElement | undefined, ns: string, name: string): XElement | undefined =>
  el ? kids(el).find(c => c.namespaceURI === ns && local(c) === name) : undefined
const deep = (el: XElement | undefined, ns: string, name: string): XElement | undefined =>
  (el?.getElementsByTagNameNS(ns, name)[0] as XElement | undefined) ?? undefined
const num = (v: string | null | undefined, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v))

/** 父元素里顶层子元素的原文（逐字节），与 DOM 子元素一一对应。 */
export function childrenRaw(xml: string, openTag: RegExp): string[] {
  const open = openTag.exec(xml)
  if (!open) return []
  const out: string[] = []
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g
  tag.lastIndex = open.index + open[0].length
  let depth = 0
  let start = -1
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (m[2] === undefined) continue
    if (m[1] === '/') {
      if (depth === 0) break
      depth--
      if (depth === 0) out.push(xml.slice(start, m.index + m[0].length))
    } else if (m[3] === '/') {
      if (depth === 0) out.push(m[0])
    } else {
      if (depth === 0) start = m.index
      depth++
    }
  }
  return out
}

/** 相对部件路径解析（rels 的 Target 相对于源部件所在目录）。 */
function resolvePart(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = from.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

const relsPath = (part: string) => part.replace(/([^/]+)$/, '_rels/$1.rels')

interface Geometry { x: number; y: number; w: number; h: number; rot: number }

const MAX_ZIP_BYTES = 150 * 1024 * 1024
const MAX_ZIP_ENTRIES = 2500

export function safeUnzipPptx(bytes: Uint8Array): Record<string, Uint8Array> {
  let totalBytes = 0
  let entries = 0
  return unzipSync(bytes, {
    filter(file) {
      entries++
      totalBytes += file.originalSize ?? 0
      if (entries > MAX_ZIP_ENTRIES || totalBytes > MAX_ZIP_BYTES) {
        throw new PptxImportError('PPTX_INVALID: zip 解压体积或条目数超限')
      }
      return true
    },
  })
}

export function importPptx(bytes: Uint8Array): PptxImport {
  let files: Record<string, Uint8Array>
  try {
    files = safeUnzipPptx(bytes)
  } catch (err) {
    if (err instanceof PptxImportError) throw err
    throw new PptxImportError('不是有效的 pptx 文件（zip 解析失败）')
  }
  const text = (name: string) => files[name] ? strFromU8(files[name]!) : null
  const parse = (name: string) => { const t = text(name); return t ? new DOMParser().parseFromString(t, 'text/xml') : null }
  const rels = (part: string): Map<string, { target: string; type: string }> => {
    const out = new Map<string, { target: string; type: string }>()
    const doc = parse(relsPath(part))
    if (!doc) return out
    const list = doc.getElementsByTagName('Relationship')
    for (let i = 0; i < list.length; i++) {
      const r = list.item(i)!
      out.set(r.getAttribute('Id') ?? '', { target: r.getAttribute('Target') ?? '', type: r.getAttribute('Type') ?? '' })
    }
    return out
  }

  const presentation = parse('ppt/presentation.xml')
  if (!presentation) throw new PptxImportError('pptx 缺少 ppt/presentation.xml')
  const sldSz = presentation.getElementsByTagNameNS(P, 'sldSz')[0]
  const size = { cx: num(sldSz?.getAttribute('cx'), 12192000), cy: num(sldSz?.getAttribute('cy'), 6858000) }
  const presRels = rels('ppt/presentation.xml')
  const slideParts: string[] = []
  const ids = presentation.getElementsByTagNameNS(P, 'sldId')
  for (let i = 0; i < ids.length; i++) {
    const rid = ids.item(i)!.getAttributeNS(R, 'id') ?? ids.item(i)!.getAttribute('r:id') ?? ''
    const rel = presRels.get(rid)
    if (rel) slideParts.push(resolvePart('ppt/presentation.xml', rel.target))
  }

  const assets: ImportedAsset[] = []
  const warnings: string[] = []
  const pendingSrc: Array<{ node: PMNode; xml: string }> = []

  /** 版式 / 母版里的占位符几何：key = type 或 idx。 */
  const placeholderGeometry = new Map<string, Map<string, Geometry>>()
  const placeholdersOf = (part: string): Map<string, Geometry> => {
    let cached = placeholderGeometry.get(part)
    if (cached) return cached
    cached = new Map()
    placeholderGeometry.set(part, cached)
    const doc = parse(part)
    const tree = doc ? deep(doc.documentElement as unknown as XElement, P, 'spTree') : undefined
    for (const sp of kids(tree)) {
      const ph = deep(sp, P, 'ph')
      const g = geometryOf(sp)
      if (!ph || !g) continue
      const type = ph.getAttribute('type') ?? 'body'
      const idx = ph.getAttribute('idx')
      if (!cached.has(`type:${type}`)) cached.set(`type:${type}`, g)
      if (idx !== null) cached.set(`idx:${idx}`, g)
    }
    return cached
  }

  const slides: PMNode[] = []
  for (const part of slideParts) {
    const xml = text(part)
    if (!xml) { warnings.push(`缺少幻灯片 ${part}`); continue }
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const slideRels = rels(part)
    const layoutRel = [...slideRels.values()].find(r => r.type.endsWith('/slideLayout'))
    const layout = layoutRel ? resolvePart(part, layoutRel.target) : null
    const layoutRels = layout ? rels(layout) : new Map()
    const masterRel = [...layoutRels.values()].find(r => r.type.endsWith('/slideMaster'))
    const master = layout && masterRel ? resolvePart(layout, masterRel.target) : null
    const layoutName = layout ? (parse(layout)?.getElementsByTagNameNS(P, 'cSld')[0]?.getAttribute('name') ?? '') : ''

    const tree = deep(doc.documentElement as unknown as XElement, P, 'spTree')
    const raw = childrenRaw(xml, /<p:spTree\b[^>]*>/)
    const shapes: PMNode[] = []
    kids(tree).forEach((el, i) => {
      const name = local(el)
      if (name === 'nvGrpSpPr' || name === 'grpSpPr' || name === 'extLst') return
      const shape = shapeOf(el, part, slideRels, { layout, master })
      if (!shape) return
      shapes.push(shape)
      if (raw[i] !== undefined) pendingSrc.push({ node: shape, xml: raw[i]! })
    })

    const notesRel = [...slideRels.values()].find(r => r.type.endsWith('/notesSlide'))
    const notes = notesRel ? notesOf(resolvePart(part, notesRel.target)) : null
    const hidden = doc.documentElement?.getAttribute('show') === '0'
    const bgPr = deep(deep(doc.documentElement as unknown as XElement, P, 'bg'), P, 'bgPr')
    const bg = srgb(first(bgPr, A, 'solidFill'))
    slides.push(deckSchema.node('slide', { part, layout, layout_name: layoutName, hidden, bg }, notes ? [...shapes, notes] : shapes))
  }
  if (slides.length === 0) throw new PptxImportError('pptx 里没有幻灯片')

  function geometryOf(el: XElement): Geometry | null {
    const xfrm = deep(el, A, 'xfrm') ?? deep(el, P, 'xfrm')
    const off = first(xfrm, A, 'off')
    const ext = first(xfrm, A, 'ext')
    if (!off || !ext) return null
    return { x: num(off.getAttribute('x')), y: num(off.getAttribute('y')), w: num(ext.getAttribute('cx')), h: num(ext.getAttribute('cy')), rot: num(xfrm?.getAttribute('rot')) }
  }

  function shapeOf(el: XElement, part: string, slideRels: Map<string, { target: string; type: string }>, inherit: { layout: string | null; master: string | null }): PMNode | null {
    const name = local(el)
    const cNvPr = deep(el, P, 'cNvPr')
    const ph = deep(el, P, 'ph')
    const phType = ph ? (ph.getAttribute('type') ?? 'body') : null
    const phIdx = ph?.getAttribute('idx') ?? null
    let g = geometryOf(el)
    let inherited = false
    if (!g && ph) {
      for (const source of [inherit.layout, inherit.master]) {
        if (!source || g) continue
        const map = placeholdersOf(source)
        g = (phIdx !== null ? map.get(`idx:${phIdx}`) : undefined) ?? map.get(`type:${phType}`) ?? null
      }
      inherited = g !== null
    }
    const base = {
      name: cNvPr?.getAttribute('name') ?? '',
      nv_id: cNvPr?.getAttribute('id') ?? null,
      ph: phType,
      ph_idx: phIdx,
      ...(g ?? { x: 0, y: 0, w: 0, h: 0, rot: 0 }),
      xfrm_inherited: inherited,
    }
    const fill = srgb(first(first(el, P, 'spPr'), A, 'solidFill'))
    const make = (kind: ShapeKind, content: PMNode[] = [], extra: Record<string, unknown> = {}) =>
      deckSchema.node('shape', { ...base, kind, fill, ...extra }, content)

    switch (name) {
      case 'sp': {
        const txBody = first(el, P, 'txBody')
        if (!txBody) return make('shape')
        const bodyPr = first(txBody, A, 'bodyPr')
        const paragraphs = kids(txBody).filter(c => local(c) === 'p').map(paragraphOf)
        const hasText = paragraphs.some(p => p.textContent.trim())
        return make(ph || hasText ? 'text' : 'shape', paragraphs, { body_pr: bodyPr ? serializeAttrsOnly(bodyPr) : null })
      }
      case 'pic': {
        const blip = deep(el, A, 'blip')
        const rid = blip?.getAttributeNS(R, 'embed') ?? blip?.getAttribute('r:embed')
        const rel = rid ? slideRels.get(rid) : undefined
        const path = rel ? resolvePart(part, rel.target) : null
        const data = path ? files[path] : undefined
        if (!path || !data) return make('image', [], { description: '图片（数据缺失）' })
        const key = `import-${assets.length}`
        const ext = path.split('.').pop()!.toLowerCase()
        assets.push({ key, name: path.split('/').pop()!, mime: MIME[ext] ?? 'application/octet-stream', bytes: data })
        return make('image', [], { asset_id: key, description: cNvPr?.getAttribute('descr') ?? '' })
      }
      case 'graphicFrame': {
        const tbl = deep(el, A, 'tbl')
        if (tbl) return make('table', [tableOf(tbl)])
        const uri = deep(el, A, 'graphicData')?.getAttribute('uri') ?? ''
        if (uri.endsWith('/chart')) {
          // 图表：经关系找到 chartN.xml，读出类型、类别、系列与数值（读不出来就只读显示）
          const ref = deep(el, 'http://schemas.openxmlformats.org/drawingml/2006/chart', 'chart')
          const rid = ref?.getAttributeNS(R, 'id') ?? ref?.getAttribute('r:id')
          const rel = rid ? slideRels.get(rid) : undefined
          const chartPart = rel ? resolvePart(part, rel.target) : null
          const xml = chartPart && files[chartPart] ? strFromU8(files[chartPart]!) : null
          const chart = xml ? readChart(xml) : null
          return make('chart', [], { description: `图表：${chart?.title || base.name}`, chart, chart_part: chart ? chartPart : null })
        }
        if (uri.includes('diagram')) return make('opaque', [], { description: `SmartArt：${(el.textContent ?? '').trim().slice(0, 60)}` })
        return make('opaque', [], { description: `对象：${base.name}` })
      }
      case 'grpSp':
        return make('group', [], { description: `组合：${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || base.name}` })
      case 'cxnSp':
        return make('line')
      default:
        return make('opaque', [], { description: `${name}：${(el.textContent ?? '').trim().slice(0, 60)}` })
    }
  }

  function notesOf(part: string): PMNode | null {
    const doc = parse(part)
    if (!doc) return null
    const tree = deep(doc.documentElement as unknown as XElement, P, 'spTree')
    for (const sp of kids(tree)) {
      const ph = deep(sp, P, 'ph')
      if (ph?.getAttribute('type') !== 'body') continue
      const txBody = first(sp, P, 'txBody')
      const paragraphs = kids(txBody).filter(c => local(c) === 'p').map(paragraphOf).filter(p => p.textContent.trim())
      return paragraphs.length > 0 ? deckSchema.node('notes', null, paragraphs) : null
    }
    return null
  }

  return finish(slides, pendingSrc, assets, size, warnings)
}

/** solidFill 里的 srgbClr（主题色不解析，返回 null）。 */
function srgb(solidFill: XElement | undefined): string | null {
  const c = first(solidFill, A, 'srgbClr')?.getAttribute('val')
  return c && /^[0-9A-Fa-f]{6}$/.test(c) ? c.toUpperCase() : null
}

/** 只保留开始标签与子元素的原文（属性 + 子元素，如 bodyPr 的 normAutofit）。 */
function serializeAttrsOnly(el: XElement): string {
  return el.toString()
}

function paragraphOf(p: XElement): PMNode {
  const pPr = first(p, A, 'pPr')
  const lvl = num(pPr?.getAttribute('lvl'))
  const algn = pPr?.getAttribute('algn')
  const content: PMNode[] = []
  for (const c of kids(p)) {
    const name = local(c)
    if (name === 'r' || name === 'fld') {
      const t = first(c, A, 't')?.textContent ?? ''
      if (!t) continue
      content.push(deckSchema.text(t, runMarks(first(c, A, 'rPr'))))
    } else if (name === 'br') {
      content.push(deckSchema.node('hard_break'))
    }
  }
  return deckSchema.node('paragraph', {
    ppr: pPr ? pPr.toString() : null,
    lvl,
    align: algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' ? 'justify' : null,
  }, content)
}

function runMarks(rPr: XElement | undefined): readonly Mark[] {
  let marks: readonly Mark[] = []
  if (!rPr) return marks
  const on = (name: string) => { const v = rPr.getAttribute(name); return v === '1' || v === 'true' }
  if (on('b')) marks = deckSchema.marks.bold!.create().addToSet(marks)
  if (on('i')) marks = deckSchema.marks.italic!.create().addToSet(marks)
  const u = rPr.getAttribute('u')
  if (u && u !== 'none') marks = deckSchema.marks.underline!.create().addToSet(marks)
  const baseline = num(rPr.getAttribute('baseline'))
  if (baseline > 0) marks = deckSchema.marks.sup!.create().addToSet(marks)
  if (baseline < 0) marks = deckSchema.marks.sub!.create().addToSet(marks)
  const link = first(rPr, A, 'hlinkClick')
  if (link) marks = deckSchema.marks.link!.create({ href: link.getAttribute('r:id') ?? '' }).addToSet(marks)
  return deckSchema.marks.rpr!.create({ xml: rPr.toString() }).addToSet(marks)
}

function tableOf(tbl: XElement): PMNode {
  const rows = kids(tbl).filter(c => local(c) === 'tr').map(tr => {
    const cells = kids(tr).filter(c => local(c) === 'tc' && c.getAttribute('hMerge') !== '1' && c.getAttribute('vMerge') !== '1').map(tc => {
      const txBody = first(tc, A, 'txBody')
      const paragraphs = kids(txBody).filter(c => local(c) === 'p').map(paragraphOf)
      return deckSchema.node('table_cell', {
        colspan: num(tc.getAttribute('gridSpan'), 1),
        rowspan: num(tc.getAttribute('rowSpan'), 1),
        tcpr: first(tc, A, 'tcPr')?.toString() ?? null,
      }, paragraphs.length > 0 ? paragraphs : [deckSchema.node('paragraph')])
    })
    return deckSchema.node('table_row', null, cells.length > 0 ? cells : [deckSchema.node('table_cell', null, [deckSchema.node('paragraph')])])
  })
  return deckSchema.node('table', null, rows)
}

function finish(slides: PMNode[], pendingSrc: Array<{ node: PMNode; xml: string }>, assets: ImportedAsset[], size: { cx: number; cy: number }, warnings: string[]): PptxImport {
  const raw = deckSchema.node('doc', null, slides)
  const doc = assignIds(raw, new Set())
  const pending = new Map(pendingSrc.map(p => [p.node, p.xml]))
  const src: Array<{ node_id: string; xml: string }> = []
  const walk = (a: PMNode, b: PMNode) => {
    const x = pending.get(a)
    if (x && b.attrs.id) src.push({ node_id: b.attrs.id as string, xml: x })
    for (let i = 0; i < a.childCount && i < b.childCount; i++) walk(a.child(i), b.child(i))
  }
  walk(raw, doc)
  return { doc, src, assets, size, warnings: [...new Set(warnings)] }
}

/** 把 shape.asset_id 里的导入 key 换成真实资产 id。 */
export function bindDeckAssets(doc: PMNode, ids: Map<string, string>): PMNode {
  const walk = (n: PMNode): PMNode => {
    if (n.type.name === 'shape' && n.attrs.asset_id && ids.has(n.attrs.asset_id as string)) {
      return n.type.create({ ...n.attrs, asset_id: ids.get(n.attrs.asset_id as string) }, n.content, n.marks)
    }
    if (n.isLeaf || n.isTextblock) return n
    const out: PMNode[] = []
    n.forEach(c => out.push(walk(c)))
    return n.type.create(n.attrs, out, n.marks)
  }
  return walk(doc)
}
