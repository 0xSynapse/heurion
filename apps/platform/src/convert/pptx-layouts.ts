import { DOMParser, type Element as XElement } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import type { LayoutInfo, PlaceholderStyle } from '../ops/deck.ts'
import { bulletOf } from '../model/ooxml-color.ts'

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

/** pptx 包里的版式（名称、部件、占位符几何）与页面尺寸。 */
export function readLayouts(pkg: Uint8Array): { layouts: LayoutInfo[]; size: { cx: number; cy: number } } {
  const files = unzipSync(pkg)
  const parse = (name: string) => files[name] ? new DOMParser().parseFromString(strFromU8(files[name]!), 'text/xml') : null
  const pres = parse('ppt/presentation.xml')
  const sz = pres?.getElementsByTagNameNS(P, 'sldSz')[0]
  const size = { cx: Number(sz?.getAttribute('cx') ?? 12192000), cy: Number(sz?.getAttribute('cy') ?? 6858000) }
  const layouts: LayoutInfo[] = []
  const parts = Object.keys(files).filter(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
  const relTarget = (part: string, type: string): string | null => {
    const rels = parse(part.replace(/([^/]+)$/, '_rels/$1.rels'))
    const list = rels?.getElementsByTagName('Relationship')
    for (let i = 0; list && i < list.length; i++) {
      const r = list.item(i)!
      if (r.getAttribute('Type')?.endsWith(`/${type}`)) return new URL(r.getAttribute('Target')!, `http://x/${part}`).pathname.slice(1)
    }
    return null
  }
  const masters = new Map<string, MasterStyles>()
  const masterOf = (part: string) => {
    if (!masters.has(part)) masters.set(part, masterStyles(parse(part)))
    return masters.get(part)!
  }
  for (const part of parts) {
    const doc = parse(part)
    if (!doc) continue
    const masterPart = relTarget(part, 'slideMaster')
    const master = masterPart ? masterOf(masterPart) : null
    const name = doc.getElementsByTagNameNS(P, 'cSld')[0]?.getAttribute('name') ?? part
    const placeholders: LayoutInfo['placeholders'] = []
    const sps = doc.getElementsByTagNameNS(P, 'sp')
    for (let i = 0; i < sps.length; i++) {
      const sp = sps.item(i) as XElement
      const ph = sp.getElementsByTagNameNS(P, 'ph')[0]
      if (!ph) continue
      const off = sp.getElementsByTagNameNS(A, 'off')[0]
      const ext = sp.getElementsByTagNameNS(A, 'ext')[0]
      placeholders.push({
        type: ph.getAttribute('type') ?? 'body',
        idx: ph.getAttribute('idx'),
        x: Number(off?.getAttribute('x') ?? 0), y: Number(off?.getAttribute('y') ?? 0),
        w: Number(ext?.getAttribute('cx') ?? 0), h: Number(ext?.getAttribute('cy') ?? 0),
        style: placeholderStyle(sp, ph.getAttribute('type') ?? 'body', master),
      })
    }
    layouts.push({ name, part, placeholders })
  }
  return { layouts, size }
}

interface MasterStyles { title: PlaceholderStyle; body: PlaceholderStyle; other: PlaceholderStyle }

const ANCHORS = new Set(['t', 'ctr', 'b'])
const ALIGNS = new Set(['l', 'ctr', 'r', 'just'])

/** 一级段落的样式：a:lvl1pPr 的 algn 与 a:defRPr 的 sz / b。 */
function lvl1(el: XElement | undefined | null): PlaceholderStyle {
  const p = el?.getElementsByTagNameNS(A, 'lvl1pPr')[0]
  if (!p) return {}
  const out: PlaceholderStyle = {}
  const algn = p.getAttribute('algn')
  if (algn && ALIGNS.has(algn)) out.align = algn as PlaceholderStyle['align']
  const r = p.getElementsByTagNameNS(A, 'defRPr')[0]
  if (r?.getAttribute('sz')) out.size = Number(r.getAttribute('sz')) / 100
  if (r?.getAttribute('b')) out.bold = r.getAttribute('b') === '1'
  const fill = r ? (r.getElementsByTagNameNS(A, 'solidFill')[0] as XElement | undefined) : undefined
  if (fill && fill.parentNode === r) out.colorXml = fill.toString()
  const bullet = bulletOf(p.toString())
  if (bullet !== undefined) out.bullet = bullet
  return out
}

function anchorOf(sp: XElement | undefined): PlaceholderStyle {
  const a = sp?.getElementsByTagNameNS(A, 'bodyPr')[0]?.getAttribute('anchor')
  return a && ANCHORS.has(a) ? { anchor: a as PlaceholderStyle['anchor'] } : {}
}

/** 母版：标题 / 正文 / 其他文字样式，加上母版标题、正文占位符的锚点。 */
function masterStyles(doc: ReturnType<DOMParser['parseFromString']> | null): MasterStyles {
  const tx = doc?.getElementsByTagNameNS(P, 'txStyles')[0]
  const phSp = (type: string) => {
    const sps = doc?.getElementsByTagNameNS(P, 'sp')
    for (let i = 0; sps && i < sps.length; i++) {
      const sp = sps.item(i) as XElement
      const ph = sp.getElementsByTagNameNS(P, 'ph')[0]
      if (ph && (ph.getAttribute('type') ?? 'body') === type) return sp
    }
    return undefined
  }
  return {
    title: { anchor: 'ctr', ...anchorOf(phSp('title')), ...lvl1(tx?.getElementsByTagNameNS(P, 'titleStyle')[0]) },
    body: { anchor: 't', ...anchorOf(phSp('body')), ...lvl1(tx?.getElementsByTagNameNS(P, 'bodyStyle')[0]) },
    other: lvl1(tx?.getElementsByTagNameNS(P, 'otherStyle')[0]),
  }
}

/** 版式占位符的样式：版式自己写的优先，没写的按类型取母版（标题类取标题样式，其余取正文样式）。 */
function placeholderStyle(sp: XElement, type: string, master: MasterStyles | null): PlaceholderStyle {
  const base = master ? (type === 'title' || type === 'ctrTitle' ? master.title : master.body) : {}
  const own = { ...anchorOf(sp), ...lvl1(sp.getElementsByTagNameNS(A, 'lstStyle')[0]) }
  return { ...base, ...own }
}

