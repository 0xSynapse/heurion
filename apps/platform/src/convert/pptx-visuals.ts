import { DOMParser, type Element as XElement, type Node as XNode } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import { autoNumOf, bulletOf, colorOf, fillColorOf, formatAutoNum, textColorOf, type SchemeColors } from '../model/ooxml-color.ts'

/**
 * 导入 pptx 的「显示层」（只给画布的近似预览用，不进文档模型、不影响导出）。
 *
 * 导入时模型只保留可编辑的内容：组合、母版 / 版式上的装饰（logo、页眉页脚图片、色条）、主题色都不在模型里，
 * 画布按模型画出来就和原文件差很多（导出走原文修补，所以导出是对的）。这里从原始 pptx 包和形状原文里读出这些显示信息：
 * - 每个版式：背景、母版与版式上的非占位符形状（按页面比例定位）、主题配色（含 clrMap 映射）；
 * - 每页：自己的背景、是否隐藏母版形状；
 * - 组合 / 连接线形状：展开成子形状（按组合框比例定位），以及形状的主题色填充与默认文字颜色。
 * 已导入的旧文档同样适用（原始包与形状原文导入时就存了）。
 */

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export interface VisualRun { t?: string; br?: true; sz?: number; b?: true; i?: true; u?: true; sup?: true; sub?: true; color?: string; font?: string }
export interface VisualPara { align?: 'l' | 'ctr' | 'r' | 'just'; sz: number; runs: VisualRun[]; lvl?: number; /** 项目符号或编号文字。 */ bu?: string }
export interface VisualText {
  anchor: 't' | 'ctr' | 'b'
  /** 内边距（pt）：左、上、右、下。 */
  ins: [number, number, number, number]
  wrap: boolean
  /** 竖排：vert / eaVert（自上而下）、vert270（自下而上）。 */
  vert?: 'vert' | 'vert270'
  paras: VisualPara[]
}
/** 一个显示用的形状；x / y / w / h 是相对所在框（页面或组合）的比例。 */
export interface VisualPart {
  x: number; y: number; w: number; h: number
  rot?: number; flipH?: true; flipV?: true
  geom?: string
  fill?: string
  /** 线条（颜色、粗细 pt；head / tail：起点 / 终点有箭头）。 */
  line?: VisualLine
  /** 连接线 / 直线：按框的对角线画。 */
  connector?: true
  /** 自由曲线（custGeom）：路径按框归一化到 0–1；fill / stroke 为 false 表示这条路径不填充 / 不描边。 */
  paths?: Array<{ d: string; fill: boolean; stroke: boolean }>
  /** 图片：pptx 包里的媒体路径（ppt/media/…）。 */
  img?: string
  /** 图片裁剪（比例）：左、上、右、下。 */
  crop?: [number, number, number, number]
  text?: VisualText
}
export interface VisualLine { color: string; w: number; head?: true; tail?: true }
export interface VisualBg { color?: string; img?: string }
export interface LayoutVisuals {
  bg: VisualBg | null; parts: VisualPart[]; colors: SchemeColors
  /** 主题字体（标题 / 正文；没写字体的文字用它）。 */
  fonts: { major: string; minor: string }
}
export interface SlideVisuals { bg: VisualBg | null; hideMaster: boolean }
export interface ShapeVisuals {
  fill?: string; line?: VisualLine; color?: string; geom?: string; parts?: VisualPart[]
  /** 图片裁剪（比例）：左、上、右、下。 */
  crop?: [number, number, number, number]
  /** 表格的列宽与行高（相对表格框的比例；与原文件的网格一致）。 */
  table?: { cols: number[]; rows: number[] }
}
export interface DeckVisuals { layouts: Record<string, LayoutVisuals>; slides: Record<string, SlideVisuals> }

/** 画布能显示的图片格式：浏览器原生支持的，加上服务端转成 png 的 emf / wmf（tiff 不画）。 */
const WEB_IMAGE = /\.(png|jpe?g|gif|bmp|svg|webp|emf|wmf)$/i

const kids = (el: XNode | null | undefined): XElement[] => {
  const out: XElement[] = []
  for (let c = el?.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as XElement)
  return out
}
const local = (el: XElement) => el.localName ?? el.nodeName.replace(/^.*:/, '')
const first = (el: XElement | undefined | null, ns: string, name: string): XElement | undefined =>
  el ? kids(el).find(c => c.namespaceURI === ns && local(c) === name) : undefined
const deep = (el: XElement | undefined | null, ns: string, name: string): XElement | undefined =>
  (el?.getElementsByTagNameNS(ns, name)[0] as XElement | undefined) ?? undefined
const num = (v: string | null | undefined, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v))
const quiet = { onError: () => {} }
const parseXml = (xml: string) => new DOMParser(quiet as never).parseFromString(xml, 'text/xml')

/** 形状原文是 spTree 里的片段，没有命名空间声明：包一层再解析。 */
const FRAGMENT_NS = [
  `xmlns:p="${P}"`, `xmlns:a="${A}"`, `xmlns:r="${R}"`,
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"',
  'xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main"',
  'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"',
  'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"',
].join(' ')

function resolvePart(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = from.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** 坐标变换：比例 = o + EMU × s。 */
interface Frame { sx: number; sy: number; ox: number; oy: number }

interface Ctx {
  /** 形状所在部件（解析图片关系用）。 */
  part: string
  colors: SchemeColors
  fonts: { major: string; minor: string }
}

export class PptxVisuals {
  private readonly files: Record<string, Uint8Array>
  private readonly docs = new Map<string, ReturnType<typeof parseXml> | null>()
  private readonly relCache = new Map<string, Map<string, { target: string; type: string }>>()
  private deckCache: DeckVisuals | null = null
  readonly size: { cx: number; cy: number }

  constructor(pkg: Uint8Array) {
    // 只解出 XML 与关系部件（媒体不解压，图片按路径另取）
    this.files = unzipSync(pkg, { filter: f => /\.(xml|rels)$/i.test(f.name) })
    const sz = this.parse('ppt/presentation.xml')?.getElementsByTagNameNS(P, 'sldSz')[0]
    this.size = { cx: num(sz?.getAttribute('cx'), 12192000), cy: num(sz?.getAttribute('cy'), 6858000) }
  }

  private parse(name: string) {
    if (!this.docs.has(name)) this.docs.set(name, this.files[name] ? parseXml(strFromU8(this.files[name]!)) : null)
    return this.docs.get(name)!
  }

  private rels(part: string) {
    let out = this.relCache.get(part)
    if (out) return out
    out = new Map()
    const doc = this.parse(part.replace(/([^/]+)$/, '_rels/$1.rels'))
    const list = doc?.getElementsByTagName('Relationship')
    for (let i = 0; list && i < list.length; i++) {
      const r = list.item(i)!
      out.set(r.getAttribute('Id') ?? '', { target: r.getAttribute('Target') ?? '', type: r.getAttribute('Type') ?? '' })
    }
    this.relCache.set(part, out)
    return out
  }

  private relOfType(part: string, type: string): string | null {
    const rel = [...this.rels(part).values()].find(r => r.type.endsWith(`/${type}`))
    return rel ? resolvePart(part, rel.target) : null
  }

  private root(part: string): XElement | undefined {
    return this.parse(part)?.documentElement as unknown as XElement | undefined
  }

  /** 母版的主题配色（含 clrMap 映射）与主题字体；版式的 clrMapOvr 覆盖映射。 */
  private theme(master: string | null, layout: string | null): { colors: SchemeColors; fonts: Ctx['fonts'] } {
    const colors: SchemeColors = {}
    const fonts = { major: '', minor: '' }
    const themePart = master ? this.relOfType(master, 'theme') : null
    const theme = themePart ? this.root(themePart) : undefined
    const scheme = deep(theme, A, 'clrScheme')
    for (const c of kids(scheme)) {
      const hex = colorOf(c.toString())
      if (hex) colors[local(c)] = hex
    }
    const fontScheme = deep(theme, A, 'fontScheme')
    fonts.major = deep(deep(fontScheme, A, 'majorFont'), A, 'latin')?.getAttribute('typeface') ?? ''
    fonts.minor = deep(deep(fontScheme, A, 'minorFont'), A, 'latin')?.getAttribute('typeface') ?? ''
    const majorEa = deep(deep(fontScheme, A, 'majorFont'), A, 'ea')?.getAttribute('typeface')
    const minorEa = deep(deep(fontScheme, A, 'minorFont'), A, 'ea')?.getAttribute('typeface')
    if (majorEa) fonts.major = fonts.major ? `${fonts.major}, ${majorEa}` : majorEa
    if (minorEa) fonts.minor = fonts.minor ? `${fonts.minor}, ${minorEa}` : minorEa
    const map: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }
    const clrMap = master ? deep(this.root(master), P, 'clrMap') : undefined
    for (const k of Object.keys(map)) map[k] = clrMap?.getAttribute(k) ?? map[k]!
    const ovr = layout ? deep(deep(this.root(layout), P, 'clrMapOvr'), A, 'overrideClrMapping') : undefined
    for (const k of Object.keys(map)) map[k] = ovr?.getAttribute(k) ?? map[k]!
    for (const [k, v] of Object.entries(map)) if (colors[v]) colors[k] = colors[v]!
    return { colors, fonts }
  }

  private background(part: string, ctx: Ctx): VisualBg | null {
    const bg = deep(deep(this.root(part), P, 'cSld'), P, 'bg')
    if (!bg) return null
    const bgPr = first(bg, P, 'bgPr')
    if (bgPr) {
      const blip = deep(first(bgPr, A, 'blipFill'), A, 'blip')
      if (blip) {
        const img = this.media(blip, part)
        if (img) return { img }
      }
      const color = fillColorOf(bgPr.toString(), ctx.colors)
      return color ? { color } : null
    }
    const ref = first(bg, P, 'bgRef')
    const color = ref ? colorOf(ref.toString(), ctx.colors) : null
    return color ? { color } : null
  }

  private media(blip: XElement, part: string): string | null {
    const rid = blip.getAttributeNS(R, 'embed') || blip.getAttribute('r:embed')
    const rel = rid ? this.rels(part).get(rid) : undefined
    if (!rel || rel.target.startsWith('http')) return null
    const path = resolvePart(part, rel.target)
    return WEB_IMAGE.test(path) ? path : null
  }

  /** 整份 deck 的版式与页面显示信息（按包缓存）。 */
  deck(): DeckVisuals {
    if (this.deckCache) return this.deckCache
    const layouts: Record<string, LayoutVisuals> = {}
    const slides: Record<string, SlideVisuals> = {}
    const full: Frame = { sx: 1 / this.size.cx, sy: 1 / this.size.cy, ox: 0, oy: 0 }
    for (const layout of Object.keys(this.files).filter(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f))) {
      const master = this.relOfType(layout, 'slideMaster')
      const { colors, fonts } = this.theme(master, layout)
      const parts: VisualPart[] = []
      const showMaster = this.root(layout)?.getAttribute('showMasterSp') !== '0'
      if (master && showMaster) this.tree(master, { part: master, colors, fonts }, full, parts)
      this.tree(layout, { part: layout, colors, fonts }, full, parts)
      const bg = this.background(layout, { part: layout, colors, fonts }) ?? (master ? this.background(master, { part: master, colors, fonts }) : null)
      layouts[layout] = { bg, parts, colors, fonts }
    }
    for (const slide of Object.keys(this.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))) {
      const layout = this.relOfType(slide, 'slideLayout')
      const colors = layout ? layouts[layout]?.colors ?? {} : {}
      slides[slide] = {
        bg: this.background(slide, { part: slide, colors, fonts: { major: '', minor: '' } }),
        hideMaster: this.root(slide)?.getAttribute('showMasterSp') === '0',
      }
    }
    this.deckCache = { layouts, slides }
    return this.deckCache
  }

  /** 母版 / 版式的 spTree：只画非占位符形状（占位符是给幻灯片填内容的提示框）。 */
  private tree(part: string, ctx: Ctx, frame: Frame, out: VisualPart[]): void {
    const spTree = deep(deep(this.root(part), P, 'cSld'), P, 'spTree')
    for (const el of kids(spTree)) {
      if (deep(el, P, 'ph')) continue
      this.element(el, ctx, frame, out)
    }
  }

  /**
   * 幻灯片上一个形状（原文）的显示信息：组合展开成子形状、连接线画成线；主题色填充与默认文字颜色。
   * part / layout：形状所在的幻灯片部件与它的版式（解析图片关系与主题色）。
   */
  shape(xml: string, part: string | null, layout: string | null): ShapeVisuals | null {
    const doc = parseXml(`<root ${FRAGMENT_NS}>${xml}</root>`)
    const el = kids(doc.documentElement as unknown as XElement)[0]
    if (!el) return null
    const lv = layout ? this.deck().layouts[layout] : undefined
    const master = layout ? this.relOfType(layout, 'slideMaster') : null
    const ctx: Ctx = { part: part ?? '', colors: lv?.colors ?? {}, fonts: this.theme(master, layout).fonts }
    const name = local(el)
    const out: ShapeVisuals = {}
    if (name === 'grpSp') {
      const xfrm = deep(first(el, P, 'grpSpPr'), A, 'xfrm')
      const chOff = first(xfrm, A, 'chOff')
      const chExt = first(xfrm, A, 'chExt')
      const ext = first(xfrm, A, 'ext')
      const cw = num(chExt?.getAttribute('cx')) || num(ext?.getAttribute('cx')) || 1
      const ch = num(chExt?.getAttribute('cy')) || num(ext?.getAttribute('cy')) || 1
      const frame: Frame = { sx: 1 / cw, sy: 1 / ch, ox: -num(chOff?.getAttribute('x')) / cw, oy: -num(chOff?.getAttribute('y')) / ch }
      const parts: VisualPart[] = []
      for (const c of kids(el)) this.element(c, ctx, frame, parts, el)
      out.parts = parts
      return out
    }
    if (name === 'graphicFrame') {
      const tbl = deep(el, A, 'tbl')
      const ext = first(first(el, P, 'xfrm'), A, 'ext')
      if (!tbl || !ext) return null
      const cols = kids(first(tbl, A, 'tblGrid')).map(c => num(c.getAttribute('w')))
      const rows = kids(tbl).filter(c => local(c) === 'tr').map(r => num(r.getAttribute('h')))
      const W = cols.reduce((a, b) => a + b, 0) || num(ext.getAttribute('cx')) || 1
      const H = Math.max(rows.reduce((a, b) => a + b, 0), num(ext.getAttribute('cy'))) || 1
      return { table: { cols: cols.map(c => round(c / W)), rows: rows.map(r => round(r / H)) } }
    }
    if (name === 'pic') {
      const src = first(first(el, P, 'blipFill'), A, 'srcRect')
      const c = ['l', 't', 'r', 'b'].map(k => num(src?.getAttribute(k)) / 100000) as [number, number, number, number]
      if (c.some(v => v !== 0)) out.crop = c
    }
    const spPr = first(el, P, 'spPr')
    const fill = this.fill(el, spPr, ctx)
    if (fill) out.fill = fill
    const line = this.line(el, spPr, ctx, name === 'cxnSp')
    if (line) out.line = line
    const color = this.fontRefColor(el, ctx)
    if (color) out.color = color
    const geom = first(spPr, A, 'prstGeom')?.getAttribute('prst')
    if (geom && geom !== 'rect') out.geom = geom
    if (name === 'cxnSp') {
      const xfrm = first(spPr, A, 'xfrm')
      out.parts = [{ x: 0, y: 0, w: 1, h: 1, connector: true, line: line ?? { color: ctx.colors.tx1 ?? '000000', w: 0.75 }, ...flips(xfrm) }]
    }
    return Object.keys(out).length > 0 ? out : null
  }

  /** 一个元素（形状 / 图片 / 连接线 / 组合）按 frame 换算后加进 out。group：所在组合（grpFill 取组合的填充）。 */
  private element(el: XElement, ctx: Ctx, frame: Frame, out: VisualPart[], group?: XElement): void {
    const name = local(el)
    if (name === 'AlternateContent') {
      // mc:AlternateContent：取 Fallback（或第一个 Choice）里的形状
      const branch = kids(el).find(c => local(c) === 'Fallback') ?? kids(el)[0]
      for (const c of kids(branch)) this.element(c, ctx, frame, out, group)
      return
    }
    if (!['sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame'].includes(name)) return
    const nv = kids(el)[0]
    if (deep(nv, P, 'cNvPr')?.getAttribute('hidden') === '1') return
    if (name === 'grpSp') {
      const xfrm = deep(first(el, P, 'grpSpPr'), A, 'xfrm')
      const off = first(xfrm, A, 'off'), ext = first(xfrm, A, 'ext'), chOff = first(xfrm, A, 'chOff'), chExt = first(xfrm, A, 'chExt')
      const kx = num(chExt?.getAttribute('cx')) ? num(ext?.getAttribute('cx')) / num(chExt?.getAttribute('cx')) : 1
      const ky = num(chExt?.getAttribute('cy')) ? num(ext?.getAttribute('cy')) / num(chExt?.getAttribute('cy')) : 1
      const inner: Frame = {
        sx: frame.sx * kx, sy: frame.sy * ky,
        ox: frame.ox + frame.sx * (num(off?.getAttribute('x')) - num(chOff?.getAttribute('x')) * kx),
        oy: frame.oy + frame.sy * (num(off?.getAttribute('y')) - num(chOff?.getAttribute('y')) * ky),
      }
      for (const c of kids(el)) this.element(c, ctx, inner, out, el)
      return
    }
    const spPr = first(el, P, 'spPr')
    const xfrm = name === 'graphicFrame' ? first(el, P, 'xfrm') : first(spPr, A, 'xfrm')
    const off = first(xfrm, A, 'off'), ext = first(xfrm, A, 'ext')
    if (!off || !ext) return
    const part: VisualPart = {
      x: round(frame.ox + num(off.getAttribute('x')) * frame.sx),
      y: round(frame.oy + num(off.getAttribute('y')) * frame.sy),
      w: round(num(ext.getAttribute('cx')) * frame.sx),
      h: round(num(ext.getAttribute('cy')) * frame.sy),
      ...flips(xfrm),
    }
    const rot = num(xfrm?.getAttribute('rot')) / 60000
    if (rot) part.rot = rot
    if (name === 'graphicFrame') return // 表格 / 图表 / SmartArt 在母版或组合里很少见，先不画
    const geom = first(spPr, A, 'prstGeom')?.getAttribute('prst')
    if (geom && geom !== 'rect') part.geom = geom
    const cust = first(spPr, A, 'custGeom')
    if (cust) {
      const paths = customPaths(cust, num(ext.getAttribute('cx')), num(ext.getAttribute('cy')))
      if (paths.length > 0) part.paths = paths
    }
    const preset = geom ? presetPaths(geom, first(spPr, A, 'prstGeom')!, num(ext.getAttribute('cx')), num(ext.getAttribute('cy'))) : null
    if (preset) {
      part.paths = preset
      const fill = this.fill(el, spPr, ctx, group)
      if (fill) part.fill = fill
      const line = this.line(el, spPr, ctx, name === 'cxnSp')
      if (line) part.line = line
      const text = this.text(el, ctx)
      if (text) part.text = text
      out.push(part)
      return
    }
    if (name === 'cxnSp' || geom === 'line' || geom === 'straightConnector1') {
      part.connector = true
      part.line = this.line(el, spPr, ctx, true) ?? { color: ctx.colors.tx1 ?? '000000', w: 0.75 }
      out.push(part)
      return
    }
    if (name === 'pic') {
      const blipFill = first(el, P, 'blipFill')
      const blip = first(blipFill, A, 'blip')
      const img = blip ? this.media(blip, ctx.part) : null
      if (!img) return
      part.img = img
      const src = first(blipFill, A, 'srcRect')
      if (src) {
        const c = ['l', 't', 'r', 'b'].map(k => num(src.getAttribute(k)) / 100000) as [number, number, number, number]
        if (c.some(v => v !== 0)) part.crop = c
      }
    } else {
      const fill = this.fill(el, spPr, ctx, group)
      if (fill) part.fill = fill
      const blip = deep(first(spPr, A, 'blipFill'), A, 'blip')
      const img = blip ? this.media(blip, ctx.part) : null
      if (img) part.img = img
    }
    const line = this.line(el, spPr, ctx, false)
    if (line) part.line = line
    const text = this.text(el, ctx)
    if (text) part.text = text
    if (!part.fill && !part.line && !part.img && !part.text) return
    out.push(part)
  }

  private fill(el: XElement, spPr: XElement | undefined, ctx: Ctx, group?: XElement): string | undefined {
    for (const c of kids(spPr)) {
      const n = local(c)
      if (n === 'noFill') return undefined
      if (n === 'solidFill' || n === 'gradFill') return fillColorOf(c.toString(), ctx.colors) ?? undefined
      if (n === 'pattFill') return colorOf(first(c, A, 'fgClr')?.toString(), ctx.colors) ?? undefined
      if (n === 'grpFill') {
        // 组合填充：沿父组合往上找（组合自己也可能是 grpFill）
        const parent = (group ?? el.parentNode) as XElement | null
        return parent && local(parent) === 'grpSp' ? this.fill(parent, first(parent, P, 'grpSpPr'), ctx) : undefined
      }
      if (n === 'blipFill') return undefined
    }
    const ref = deep(first(el, P, 'style'), A, 'fillRef')
    if (ref && num(ref.getAttribute('idx')) > 0) return colorOf(ref.toString(), ctx.colors) ?? undefined
    return undefined
  }

  private line(el: XElement, spPr: XElement | undefined, ctx: Ctx, connector: boolean): VisualLine | undefined {
    const ln = first(spPr, A, 'ln')
    const w = num(ln?.getAttribute('w'), 9525) / 12700
    const ends = (out: VisualLine): VisualLine => {
      const end = (name: string) => { const t = first(ln, A, name)?.getAttribute('type'); return !!t && t !== 'none' }
      if (end('headEnd')) out.head = true
      if (end('tailEnd')) out.tail = true
      return out
    }
    if (ln) {
      if (first(ln, A, 'noFill')) return undefined
      const color = fillColorOf(ln.toString(), ctx.colors)
      if (color) return ends({ color, w })
    }
    const ref = deep(first(el, P, 'style'), A, 'lnRef')
    if (ref && (num(ref.getAttribute('idx')) > 0 || connector)) {
      const color = colorOf(ref.toString(), ctx.colors)
      if (color) return ends({ color, w })
    }
    return undefined
  }

  private fontRefColor(el: XElement, ctx: Ctx): string | undefined {
    const ref = deep(first(el, P, 'style'), A, 'fontRef')
    return (ref ? colorOf(ref.toString(), ctx.colors) : null) ?? undefined
  }

  private text(el: XElement, ctx: Ctx): VisualText | undefined {
    const txBody = first(el, P, 'txBody')
    if (!txBody) return undefined
    const paras = kids(txBody).filter(c => local(c) === 'p')
    if (!paras.some(p => (p.textContent ?? '').trim())) return undefined
    const bodyPr = first(txBody, A, 'bodyPr')
    const lstStyle = first(txBody, A, 'lstStyle')
    const anchor = (bodyPr?.getAttribute('anchor') ?? 't') as VisualText['anchor']
    const ins = (k: string, d: number) => num(bodyPr?.getAttribute(k), d) / 12700
    const scale = num(first(bodyPr, A, 'normAutofit')?.getAttribute('fontScale'), 100000) / 100000
    const shapeColor = this.fontRefColor(el, ctx) ?? ctx.colors.tx1
    const font = (face: string | null | undefined): string | undefined => {
      if (!face) return undefined
      if (face.startsWith('+mj')) return ctx.fonts.major || undefined
      if (face.startsWith('+mn')) return ctx.fonts.minor || undefined
      return face
    }
    const vertAttr = bodyPr?.getAttribute('vert')
    const vert = vertAttr === 'vert270' ? 'vert270' as const : vertAttr && vertAttr !== 'horz' ? 'vert' as const : undefined
    /** 自动编号：同一级连续的同样式编号累加，换级或换样式重新计数。 */
    const counters = new Map<number, { type: string; n: number }>()
    return {
      ...(vert ? { vert } : {}),
      anchor: anchor === 'ctr' || anchor === 'b' ? anchor : 't',
      ins: [ins('lIns', 91440), ins('tIns', 45720), ins('rIns', 91440), ins('bIns', 45720)],
      wrap: bodyPr?.getAttribute('wrap') !== 'none',
      paras: paras.map(p => {
        const pPr = first(p, A, 'pPr')
        const lvl = num(pPr?.getAttribute('lvl'))
        const levelDef = deep(lstStyle, A, `lvl${lvl + 1}pPr`)
        const defs = [first(pPr, A, 'defRPr'), first(levelDef, A, 'defRPr')]
        const defSz = defs.map(d => d?.getAttribute('sz')).find(Boolean)
        const end = first(p, A, 'endParaRPr')
        const baseSz = num(defSz ?? end?.getAttribute('sz'), 1800) / 100
        const defColor = defs.map(d => textColorOf(d?.toString(), ctx.colors)).find(Boolean) ?? shapeColor
        const runs: VisualRun[] = []
        for (const r of kids(p)) {
          const n = local(r)
          if (n === 'br') { runs.push({ br: true }); continue }
          if (n !== 'r' && n !== 'fld') continue
          const t = first(r, A, 't')?.textContent ?? ''
          if (!t) continue
          const rPr = first(r, A, 'rPr')
          const run: VisualRun = { t }
          const sz = rPr?.getAttribute('sz')
          run.sz = Math.round((sz ? Number(sz) / 100 : baseSz) * scale * 10) / 10
          const on = (k: string) => rPr?.getAttribute(k) === '1' || rPr?.getAttribute(k) === 'true'
          if (on('b')) run.b = true
          if (on('i')) run.i = true
          const u = rPr?.getAttribute('u')
          if (u && u !== 'none') run.u = true
          const baseline = num(rPr?.getAttribute('baseline'))
          if (baseline > 0) run.sup = true
          if (baseline < 0) run.sub = true
          const color = textColorOf(rPr?.toString(), ctx.colors) ?? defColor
          if (color) run.color = color
          const face = font(first(rPr, A, 'ea')?.getAttribute('typeface') ?? first(rPr, A, 'latin')?.getAttribute('typeface'))
          if (face) run.font = face
          runs.push(run)
        }
        const algn = pPr?.getAttribute('algn') ?? levelDef?.getAttribute('algn')
        const para: VisualPara = { sz: Math.round(baseSz * scale * 10) / 10, runs }
        if (lvl) para.lvl = lvl
        for (const k of [...counters.keys()]) if (k > lvl) counters.delete(k)
        const an = autoNumOf(pPr?.toString()) ?? (bulletOf(pPr?.toString()) === undefined ? autoNumOf(levelDef?.toString()) : null)
        if (an && runs.length > 0) {
          const prev = counters.get(lvl)
          const n = prev && prev.type === an.type ? prev.n + 1 : an.start
          counters.set(lvl, { type: an.type, n })
          para.bu = formatAutoNum(an.type, n)
        } else {
          counters.delete(lvl)
          const bu = bulletOf(pPr?.toString()) ?? bulletOf(levelDef?.toString())
          if (bu && runs.length > 0) para.bu = bu
        }
        if (algn === 'l' || algn === 'ctr' || algn === 'r' || algn === 'just') para.align = algn
        return para
      }),
    }
  }

  /** 原始包里的一个媒体文件（画布显示母版 / 组合里的图片用）；路径必须在 ppt/media/ 下。 */
  static mediaBytes(pkg: Uint8Array, path: string): Uint8Array | null {
    if (!/^ppt\/media\/[\w.-]+$/.test(path) || !WEB_IMAGE.test(path)) return null
    const files = unzipSync(pkg, { filter: f => f.name === path })
    return files[path] ?? null
  }
}

/**
 * custGeom 的路径 → SVG path（坐标归一化到 0–1）。点可以是数字或参考线名；参考线按路径自己的 w / h 求值
 * （只支持常见公式：*\/ +- +\/ val min max abs），求不出来的路径跳过。
 */
function customPaths(cust: XElement, shapeW: number, shapeH: number): Array<{ d: string; fill: boolean; stroke: boolean }> {
  const out: Array<{ d: string; fill: boolean; stroke: boolean }> = []
  const gds = kids(first(cust, A, 'gdLst')).map(g => [g.getAttribute('name') ?? '', g.getAttribute('fmla') ?? ''] as const)
  for (const path of kids(first(cust, A, 'pathLst'))) {
    if (local(path) !== 'path') continue
    const w = num(path.getAttribute('w')) || shapeW || 1
    const h = num(path.getAttribute('h')) || shapeH || 1
    const vars: Record<string, number> = { w, h, wd2: w / 2, hd2: h / 2, l: 0, t: 0, r: w, b: h, ss: Math.min(w, h) }
    for (const [name, fmla] of gds) {
      const v = evalGuide(fmla, vars)
      if (v !== null) vars[name] = v
    }
    const val = (s: string | null): number | null => {
      if (s === null) return null
      const n = Number(s)
      return Number.isFinite(n) ? n : (vars[s] ?? null)
    }
    const f = (x: number, y: number) => `${+(x / w).toFixed(4)} ${+(y / h).toFixed(4)}`
    let d = ''
    let cx = 0, cy = 0
    let ok = true
    for (const cmd of kids(path)) {
      const pts = kids(cmd).filter(c => local(c) === 'pt').map(p => [val(p.getAttribute('x')), val(p.getAttribute('y'))] as const)
      if (pts.some(([x, y]) => x === null || y === null)) { ok = false; break }
      const xy = pts as unknown as Array<[number, number]>
      switch (local(cmd)) {
        case 'moveTo': d += `M${f(...xy[0]!)}`; [cx, cy] = xy[0]!; break
        case 'lnTo': d += `L${f(...xy[0]!)}`; [cx, cy] = xy[0]!; break
        case 'cubicBezTo': d += `C${xy.map(p => f(...p)).join(' ')}`; [cx, cy] = xy[2]!; break
        case 'quadBezTo': d += `Q${xy.map(p => f(...p)).join(' ')}`; [cx, cy] = xy[1]!; break
        case 'close': d += 'Z'; break
        case 'arcTo': {
          const wR = val(cmd.getAttribute('wR')) ?? 0, hR = val(cmd.getAttribute('hR')) ?? 0
          const st = (val(cmd.getAttribute('stAng')) ?? 0) / 60000 * Math.PI / 180
          const sw = (val(cmd.getAttribute('swAng')) ?? 0) / 60000 * Math.PI / 180
          const ox = cx - wR * Math.cos(st), oy = cy - hR * Math.sin(st)
          const ex = ox + wR * Math.cos(st + sw), ey = oy + hR * Math.sin(st + sw)
          d += `A${+(wR / w).toFixed(4)} ${+(hR / h).toFixed(4)} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${f(ex, ey)}`
          cx = ex; cy = ey
          break
        }
      }
    }
    if (ok && d) out.push({ d, fill: path.getAttribute('fill') !== 'none', stroke: path.getAttribute('stroke') !== '0' && path.getAttribute('stroke') !== 'false' })
  }
  return out
}

/** 少数常见预设几何直接生成路径（归一化 0–1）：环形弧、弧线、圆环、折线连接线。其余按 clip-path 或矩形近似。 */
function presetPaths(prst: string, geomEl: XElement, w: number, h: number): Array<{ d: string; fill: boolean; stroke: boolean }> | null {
  const adj: Record<string, number> = {}
  for (const g of kids(first(geomEl, A, 'avLst'))) {
    const m = /^val\s+(-?\d+)/.exec(g.getAttribute('fmla') ?? '')
    if (m) adj[g.getAttribute('name') ?? ''] = Number(m[1])
  }
  const W = w || 1, H = h || 1
  const pt = (x: number, y: number) => `${+(x / W).toFixed(4)} ${+(y / H).toFixed(4)}`
  const rad = (a: number) => a / 60000 * Math.PI / 180
  /** 椭圆（中心 cx, cy，半径 rx, ry）上视觉角 a 处的点。 */
  const onEllipse = (cx: number, cy: number, rx: number, ry: number, a: number): [number, number] => {
    const t = Math.atan2(Math.sin(a) * rx, Math.cos(a) * ry)
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]
  }
  const arc = (rx: number, ry: number, st: number, sw: number, reverse = false) => {
    const [x, y] = onEllipse(W / 2, H / 2, rx, ry, reverse ? st : st + sw)
    return `A${+(rx / W).toFixed(4)} ${+(ry / H).toFixed(4)} 0 ${sw > Math.PI ? 1 : 0} ${reverse ? 0 : 1} ${pt(x, y)}`
  }
  switch (prst) {
    case 'blockArc': case 'arc': {
      const st = rad(adj.adj1 ?? (prst === 'arc' ? 16200000 : 10800000))
      const en = rad(adj.adj2 ?? 0)
      let sw = en - st
      while (sw <= 0) sw += Math.PI * 2
      const rx = W / 2, ry = H / 2
      const [sx, sy] = onEllipse(W / 2, H / 2, rx, ry, st)
      if (prst === 'arc') return [{ d: `M${pt(sx, sy)}${arc(rx, ry, st, sw)}`, fill: false, stroke: true }]
      const dr = Math.min(W, H) * (adj.adj3 ?? 25000) / 100000
      const irx = Math.max(0, rx - dr), iry = Math.max(0, ry - dr)
      const [ix, iy] = onEllipse(W / 2, H / 2, irx, iry, st + sw)
      return [{ d: `M${pt(sx, sy)}${arc(rx, ry, st, sw)}L${pt(ix, iy)}${arc(irx, iry, st, sw, true)}Z`, fill: true, stroke: true }]
    }
    case 'donut': {
      const dr = Math.min(W, H) * (adj.adj ?? 25000) / 100000
      const ring = (rx: number, ry: number) => `M${pt(W / 2 - rx, H / 2)}A${+(rx / W).toFixed(4)} ${+(ry / H).toFixed(4)} 0 1 1 ${pt(W / 2 + rx, H / 2)}A${+(rx / W).toFixed(4)} ${+(ry / H).toFixed(4)} 0 1 1 ${pt(W / 2 - rx, H / 2)}Z`
      return [{ d: ring(W / 2, H / 2) + ring(W / 2 - dr, H / 2 - dr), fill: true, stroke: true }]
    }
    case 'bentConnector2': return [{ d: `M0 0L1 0L1 1`, fill: false, stroke: true }]
    case 'bentConnector3': {
      const x = (adj.adj1 ?? 50000) / 100000
      return [{ d: `M0 0L${x} 0L${x} 1L1 1`, fill: false, stroke: true }]
    }
    default: return null
  }
}

function evalGuide(fmla: string, vars: Record<string, number>): number | null {
  const [op, ...args] = fmla.trim().split(/\s+/)
  const a = args.map(x => (Number.isFinite(Number(x)) ? Number(x) : vars[x!]))
  if (a.some(v => v === undefined)) return null
  const [x = 0, y = 0, z = 0] = a as number[]
  switch (op) {
    case '*/': return z ? x * y / z : null
    case '+-': return x + y - z
    case '+/': return z ? (x + y) / z : null
    case 'val': return x
    case 'min': return Math.min(x, y)
    case 'max': return Math.max(x, y)
    case 'abs': return Math.abs(x)
    default: return null
  }
}

/** 比例坐标保留 5 位小数（1920px 宽的页面上误差远小于 1px），减小接口体积。 */
const round = (v: number) => Math.round(v * 1e5) / 1e5

function flips(xfrm: XElement | undefined): { flipH?: true; flipV?: true } {
  const out: { flipH?: true; flipV?: true } = {}
  if (xfrm?.getAttribute('flipH') === '1') out.flipH = true
  if (xfrm?.getAttribute('flipV') === '1') out.flipV = true
  return out
}
