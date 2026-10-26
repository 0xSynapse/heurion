import { strFromU8, strToU8, zipSync } from 'fflate'
import type { Mark, Node as PMNode } from 'prosemirror-model'
import { Resvg } from '@resvg/resvg-js'
import { DECK_THEMES } from '../model/deck-themes.ts'
import { chartWorkbook, newChartXml, patchChart, readChart, type ChartData } from './pptx-chart.ts'
import type { CitationRow } from '../store/db.ts'
import { citationOrder } from '../views/read.ts'
import { childrenRaw, safeUnzipPptx } from './pptx-import.ts'

/**
 * deck 模型 → pptx（PLATFORM.md §7）：修补式，以原始文件包为底座。
 * - 没改过的幻灯片部件原样保留；改过的页重建形状树：没改过的形状原样写回，改过的形状只替换
 *   文字体 / 位置（沿用原有 bodyPr、lstStyle、段落与文字段格式），新形状按占位符或文本框生成；
 * - 新增的页按版式生成；删页、调整顺序同步 presentation.xml / rels / content types；
 * - 引用写成上标 [n]（编号按全文首次出现顺序）。
 */

export interface PptxExportInput {
  doc: PMNode
  baseline: PMNode | null
  pkg: Uint8Array
  src: (nodeId: string) => string | null
  citations: CitationRow[]
  /** 图片资产（新插入的图片写进 ppt/media）。 */
  asset?: (id: string) => { mime: string; bytes: Uint8Array } | null
}

/** 一页幻灯片的关系表：新图片要在这里登记，返回 rId。 */
interface SlideRels {
  image(assetId: string): string | null
  /** 新建图表：生成图表部件（含内嵌工作簿），在本页登记关系，返回 rId。 */
  chart(data: ChartData): string | null
}

const FILL_ELEMENTS = /<a:(solidFill|gradFill|pattFill|blipFill|grpFill)\b[^>]*>[\s\S]*?<\/a:\1>|<a:(noFill|grpFill)\s*\/>/

const fillXml = (fill: string) => fill === 'none' ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`

/** spPr 里设置填充：替换已有的顶层填充（不动 a:ln 里的），没有就放在几何之后。 */
function withShapeFill(xml: string, fill: string): string {
  const sp = /<p:spPr\b[^>]*?\/>|<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/.exec(xml)
  if (!sp) return xml
  let inner = sp[0].startsWith('<p:spPr') && sp[0].endsWith('/>') ? '' : sp[0].replace(/^<p:spPr\b[^>]*>/, '').replace(/<\/p:spPr>$/, '')
  const openTag = /^<p:spPr\b[^>]*?(?=\/?>)/.exec(sp[0])![0]
  const ln = /<a:ln\b[^>]*?\/>|<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/.exec(inner)?.[0] ?? ''
  const withoutLn = ln ? inner.replace(ln, '\u0000LN\u0000') : inner
  let replaced = withoutLn.replace(FILL_ELEMENTS, fillXml(fill))
  if (replaced === withoutLn) {
    const geom = /<a:(prstGeom|custGeom)\b[^>]*?\/>|<a:(prstGeom|custGeom)\b[^>]*>[\s\S]*?<\/a:\2>/.exec(replaced)
    replaced = geom ? replaced.replace(geom[0], geom[0] + fillXml(fill)) : replaced.replace(/^(<a:xfrm\b[\s\S]*?<\/a:xfrm>)?/, m => m + fillXml(fill))
  }
  inner = replaced.replace('\u0000LN\u0000', ln)
  return xml.replace(sp[0], `${openTag}>${inner}</p:spPr>`)
}

/** 页面背景：替换或新建 p:bg（cSld 的第一个子元素）。 */
function withBackground(xml: string, bg: string): string {
  const el = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
  if (/<p:bg\b[\s\S]*?<\/p:bg>/.test(xml)) return xml.replace(/<p:bg\b[\s\S]*?<\/p:bg>/, el)
  return xml.replace(/<p:cSld\b([^>]*)>/, `<p:cSld$1>${el}`)
}

const PRST = { rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse' } as const

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g
const esc = (s: string) => s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 设置 / 删除开始标签上的属性（value = null 删除）。 */
function setAttr(xml: string, tag: string, name: string, value: string | null): string {
  const open = new RegExp(`<${tag}\\b[^>]*?/?>`).exec(xml)
  if (!open) return xml
  let t = open[0]
  const attr = new RegExp(`\\s${name}="[^"]*"`)
  if (attr.test(t)) t = value === null ? t.replace(attr, '') : t.replace(attr, ` ${name}="${value}"`)
  else if (value !== null) t = t.replace(new RegExp(`^<${tag}`), `<${tag} ${name}="${value}"`)
  return xml.slice(0, open.index) + t + xml.slice(open.index + open[0].length)
}

/** 片段里第一个完整的 <name> 元素（自闭合，或带子元素直到匹配的结束标签）。 */
function element(xml: string, name: string): string | null {
  const re = new RegExp(`<${name}\\b[^>]*?/>|<${name}\\b[^>]*>[\\s\\S]*?</${name}>`)
  return re.exec(xml)?.[0] ?? null
}

/** xmldom 序列化出来的片段会自带命名空间声明，放回文件里时去掉（父级已声明）。 */
const stripNs = (xml: string) => xml.replace(/\s+xmlns:(a|r|p)="[^"]*"/g, '')

function runProps(marks: readonly Mark[], forceSup = false): string {
  const rpr = marks.find(m => m.type.name === 'rpr')
  let xml = rpr ? stripNs(rpr.attrs.xml as string) : '<a:rPr lang="zh-CN" dirty="0"/>'
  const has = (n: string) => marks.some(m => m.type.name === n)
  xml = setAttr(xml, 'a:rPr', 'b', has('bold') ? '1' : /\sb="/.test(xml) ? '0' : null)
  xml = setAttr(xml, 'a:rPr', 'i', has('italic') ? '1' : /\si="/.test(xml) ? '0' : null)
  xml = setAttr(xml, 'a:rPr', 'u', has('underline') ? 'sng' : null)
  xml = setAttr(xml, 'a:rPr', 'baseline', has('sup') || forceSup ? '30000' : has('sub') ? '-25000' : null)

  const ts = marks.find(m => m.type.name === 'text_style')
  if (ts) {
    const { font_family, font_size, color } = ts.attrs as { font_family?: string; font_size?: string | number; color?: string }
    if (font_size) {
      const pt = typeof font_size === 'number' ? font_size : parseFloat(font_size)
      if (Number.isFinite(pt) && pt > 0) {
        xml = setAttr(xml, 'a:rPr', 'sz', String(Math.round(pt * 100)))
      }
    }
    if (color) {
      const hex = color.replace(/^#/, '').toUpperCase()
      if (/^[0-9A-F]{6}$/i.test(hex)) {
        xml = xml.replace(/<a:solidFill>[\s\S]*?<\/a:solidFill>/g, '')
        const fillTag = `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`
        if (xml.endsWith('/>')) xml = xml.slice(0, -2) + '>' + fillTag + '</a:rPr>'
        else xml = xml.replace(/<\/a:rPr>$/, fillTag + '</a:rPr>')
      }
    }
    if (font_family) {
      const fam = font_family.split(',')[0]!.trim().replace(/^['"]+|['"]+$/g, '')
      if (fam) {
        xml = xml.replace(/<a:(latin|ea|cs)\b[^>]*\/?>/g, '')
        const fontTags = `<a:latin typeface="${esc(fam)}"/><a:ea typeface="${esc(fam)}"/>`
        if (xml.endsWith('/>')) xml = xml.slice(0, -2) + '>' + fontTags + '</a:rPr>'
        else xml = xml.replace(/<\/a:rPr>$/, fontTags + '</a:rPr>')
      }
    }
  }

  return xml
}

function paragraphXml(p: PMNode, numbers: Map<string, number>): string {
  let ppr = p.attrs.ppr ? stripNs(p.attrs.ppr as string) : ''
  const lvl = p.attrs.lvl as number
  if (ppr) ppr = setAttr(ppr, 'a:pPr', 'lvl', lvl > 0 ? String(lvl) : null)
  else if (lvl > 0) ppr = `<a:pPr lvl="${lvl}"/>`
  const align = p.attrs.align as string | null
  const algn = align === 'center' ? 'ctr' : align === 'right' ? 'r' : align === 'left' ? 'l' : null
  if (algn) {
    if (ppr) ppr = setAttr(ppr, 'a:pPr', 'algn', algn)
    else ppr = `<a:pPr algn="${algn}"/>`
  }
  let runs = ''
  let lastMarks: readonly Mark[] = []
  p.forEach(c => {
    if (c.isText) {
      lastMarks = c.marks
      runs += `<a:r>${runProps(c.marks)}<a:t>${esc(c.text!)}</a:t></a:r>`
    } else if (c.type.name === 'hard_break') {
      runs += `<a:br>${runProps(lastMarks)}</a:br>`
    } else if (c.type.name === 'citation') {
      const n = numbers.get(c.attrs.cite_id as string)
      runs += `<a:r>${runProps(lastMarks, true)}<a:t>[${n ?? '?'}]</a:t></a:r>`
    }
  })
  return `<a:p>${ppr}${runs}</a:p>`
}

function txBodyInner(shape: PMNode, numbers: Map<string, number>): string {
  let out = ''
  shape.forEach(p => { if (p.type.name === 'paragraph') out += paragraphXml(p, numbers) })
  return out || '<a:p><a:endParaRPr lang="zh-CN"/></a:p>'
}

/**
 * Keynote 不显示 spPr 里没有几何（prstGeom / custGeom）的形状——占位符也一样，文字整块消失；PowerPoint 默认按矩形画。
 * 导出的每个 p:sp 都写明几何（缺了补矩形）。
 */
const GEOM_RECT = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
export function ensureGeometry(spXml: string): string {
  if (!/^<p:sp[\s>]/.test(spXml) || /<a:(prstGeom|custGeom)\b/.test(spXml)) return spXml
  if (/<p:spPr\s*\/>/.test(spXml)) return spXml.replace(/<p:spPr\s*\/>/, `<p:spPr>${GEOM_RECT}</p:spPr>`)
  // 几何在 xfrm 之后、填充之前（CT_ShapeProperties 的顺序）
  return spXml.replace(/<p:spPr(\b[^>]*)>([\s\S]*?)<\/p:spPr>/, (_m, attrs: string, inner: string) =>
    `<p:spPr${attrs}>${/<\/a:xfrm>/.test(inner) ? inner.replace(/<\/a:xfrm>/, `</a:xfrm>${GEOM_RECT}`) : GEOM_RECT + inner}</p:spPr>`)
}

/** 改过的形状：替换文字体 / 位置，其余原样。 */
function patchShape(src: string, shape: PMNode, before: PMNode | undefined, numbers: Map<string, number>): string {
  let xml = src
  const a = shape.attrs
  const moved = !before || a.x !== before.attrs.x || a.y !== before.attrs.y || a.w !== before.attrs.w || a.h !== before.attrs.h || (before.attrs.xfrm_inherited && !a.xfrm_inherited)
  if (moved && !a.xfrm_inherited) {
    const xfrm = `<a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/>`
    if (/<a:off\b[^>]*\/>\s*<a:ext\b[^>]*\/>/.test(xml)) xml = xml.replace(/<a:off\b[^>]*\/>\s*<a:ext\b[^>]*\/>/, xfrm)
    else if (/<p:spPr\s*\/>/.test(xml)) xml = xml.replace(/<p:spPr\s*\/>/, `<p:spPr><a:xfrm>${xfrm}</a:xfrm></p:spPr>`)
    else xml = xml.replace(/<p:spPr(\b[^>]*)>/, `<p:spPr$1><a:xfrm>${xfrm}</a:xfrm>`)
  }
  if (a.fill && a.fill !== (before?.attrs.fill ?? null)) xml = withShapeFill(xml, a.fill as string)
  const textChanged = !before || !before.content.eq(shape.content)
  if (textChanged && (a.kind === 'text' || a.kind === 'shape')) {
    const body = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(xml)
    if (body) {
      const keep = (element(body[1]!, 'a:bodyPr') ?? '<a:bodyPr/>') + (element(body[1]!, 'a:lstStyle') ?? '<a:lstStyle/>')
      xml = xml.replace(body[0], `<p:txBody>${keep}${txBodyInner(shape, numbers)}</p:txBody>`)
    } else {
      xml = xml.replace(/<\/p:sp>\s*$/, `<p:txBody><a:bodyPr/><a:lstStyle/>${txBodyInner(shape, numbers)}</p:txBody></p:sp>`)
    }
  }
  if (textChanged && a.kind === 'table') {
    const cells: PMNode[] = []
    shape.firstChild?.forEach(row => row.forEach(cell => cells.push(cell)))
    let i = 0
    xml = xml.replace(/<a:tc\b([^>]*)>([\s\S]*?)<\/a:tc>/g, (whole, attrs: string, inner: string) => {
      if (/hMerge="1"|vMerge="1"/.test(attrs)) return whole
      const cell = cells[i++]
      if (!cell) return whole
      const bodyPr = element(inner, 'a:bodyPr') ?? '<a:bodyPr/>'
      const rest = inner.replace(/<a:txBody>[\s\S]*?<\/a:txBody>/, '')
      let paras = ''
      cell.forEach(p => { paras += paragraphXml(p, numbers) })
      return `<a:tc${attrs}><a:txBody>${bodyPr}<a:lstStyle/>${paras}</a:txBody>${rest}</a:tc>`
    })
  }
  return xml
}

/**
 * 表格的 a:tbl。tblPr / 列宽 / 行高可沿用原文件（导入的表格增删行列后重建时），否则平分形状的宽高。
 */
function tableXml(shape: PMNode, numbers: Map<string, number>, from?: { tblPr?: string; grid?: string[]; rowHeights?: number[] }): string {
  const a = shape.attrs
  const rows: PMNode[] = []
  shape.firstChild?.forEach(r => rows.push(r))
  const cols = rows[0]?.childCount ?? 1
  const grid = from?.grid && from.grid.length === cols ? from.grid : Array.from({ length: cols }, () => String(Math.round((a.w as number) / cols)))
  const avgH = Math.round((a.h as number) / Math.max(1, rows.length))
  const tr = rows.map((r, ri) => {
    let cells = ''
    r.forEach(cell => {
      let paras = ''
      cell.forEach(p => { paras += paragraphXml(p, numbers) })
      const tcpr = cell.attrs.tcpr ? stripNs(cell.attrs.tcpr as string) : '<a:tcPr/>'
      cells += `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paras || '<a:p/>'}</a:txBody>${tcpr}</a:tc>`
    })
    return `<a:tr h="${from?.rowHeights?.[ri] ?? from?.rowHeights?.at(-1) ?? avgH}">${cells}</a:tr>`
  }).join('')
  return `<a:tbl>${from?.tblPr ?? '<a:tblPr firstRow="1" bandRow="1"/>'}<a:tblGrid>${grid.map(w => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>${tr}</a:tbl>`
}

/** 导入的表格增删了行列：保留原 graphicFrame（位置、名字、样式 tblPr、行高、列宽），重建 a:tbl。 */
function rebuildTable(src: string, shape: PMNode, numbers: Map<string, number>): string {
  const tbl = /<a:tbl>[\s\S]*<\/a:tbl>/.exec(src)
  if (!tbl) return src
  const tblPr = element(tbl[0], 'a:tblPr') ?? undefined
  const grid = [...tbl[0].matchAll(/<a:gridCol\b[^>]*\bw="(\d+)"/g)].map(m => m[1]!)
  const rowHeights = [...tbl[0].matchAll(/<a:tr\b[^>]*\bh="(\d+)"/g)].map(m => Number(m[1]))
  return src.replace(tbl[0], tableXml(shape, numbers, { tblPr, grid, rowHeights }))
}

const tableShape = (n: PMNode) => { const t = n.firstChild; return t ? [t.childCount, t.firstChild?.childCount ?? 0].join('×') : '' }

function newShapeXml(shape: PMNode, nvId: number, numbers: Map<string, number>, rels: SlideRels): string {
  const a = shape.attrs
  const name = esc(String(a.name || (a.ph ? 'Placeholder' : 'TextBox')))
  if (a.kind === 'image') {
    const rid = a.asset_id ? rels.image(a.asset_id as string) : null
    if (!rid) return ''
    return `<p:pic><p:nvPicPr><p:cNvPr id="${nvId}" name="${name}" descr="${esc(String(a.description ?? ''))}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  }
  if (a.kind === 'chart') {
    const rid = a.chart ? rels.chart(a.chart as ChartData) : null
    if (!rid) return ''
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${nvId}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`
  }
  if (a.kind === 'table') {
    // 新建的表格：p:graphicFrame + a:tbl（列宽平分，行高平分）
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${nvId}" name="${name}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tableXml(shape, numbers)}</a:graphicData></a:graphic></p:graphicFrame>`
  }
  if (!a.ph && (a.geom || (a.fill && a.fill !== 'none'))) {
    // 色块 / 标题条 / 卡片：几何 + 填充，文字居中
    const geom = PRST[(a.geom as keyof typeof PRST) ?? 'rect'] ?? 'rect'
    const xfrm = `<a:xfrm><a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/></a:xfrm>`
    return `<p:sp><p:nvSpPr><p:cNvPr id="${nvId}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fillXml((a.fill as string | null) ?? 'none')}<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/><a:lstStyle/>${txBodyInner(shape, numbers)}</p:txBody></p:sp>`
  }
  const ph = a.ph ? `<p:ph${a.ph === 'body' ? '' : ` type="${a.ph}"`}${a.ph_idx !== null ? ` idx="${a.ph_idx}"` : ''}/>` : ''
  // 平台新建的形状一律写明位置（占位符也写，不靠版式继承）：画布按模型位置画，导出要一致；
  // Keynote 对只靠版式继承位置的占位符显示不全
  const xfrm = `<a:xfrm><a:off x="${a.x}" y="${a.y}"/><a:ext cx="${a.w}" cy="${a.h}"/></a:xfrm>`
  const spPr = a.ph
    ? `<p:spPr>${xfrm}${GEOM_RECT}${a.fill ? fillXml(a.fill as string) : ''}</p:spPr>`
    : `<p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml((a.fill as string | null) ?? 'none')}</p:spPr>`
  // 占位符的文字与画布一致：顶端、左对齐（版式里标题页常是底端居中，不覆盖会和画布对不上）
  const bodyPr = a.ph ? '<a:bodyPr anchor="t"/>' : '<a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr>'
  const lstStyle = a.ph ? '<a:lstStyle><a:lvl1pPr algn="l"/></a:lstStyle>' : '<a:lstStyle/>'
  return `<p:sp><p:nvSpPr><p:cNvPr id="${nvId}" name="${name}"/><p:cNvSpPr${a.ph ? '><a:spLocks noGrp="1"/></p:cNvSpPr>' : ' txBox="1"/>'}<p:nvPr>${ph}</p:nvPr></p:nvSpPr>${spPr}<p:txBody>${bodyPr}${lstStyle}${txBodyInner(shape, numbers)}</p:txBody></p:sp>`
}

export function exportPptx(input: PptxExportInput): { bytes: Uint8Array; warnings: string[] } {
  const warnings: string[] = []
  const files = safeUnzipPptx(input.pkg)
  const text = (name: string) => files[name] ? strFromU8(files[name]!) : ''
  const put = (name: string, content: string) => { files[name] = strToU8(content) }
  const order = citationOrder(input.doc)
  const numbers = new Map(order.map((id, i) => [id, i + 1]))
  const baseline = new Map<string, PMNode>()
  input.baseline?.descendants(n => { if (n.attrs.id) baseline.set(n.attrs.id as string, n); return n.type.name !== 'shape' })

  let presXml = text('ppt/presentation.xml')
  let presRels = text('ppt/_rels/presentation.xml.rels')
  let contentTypes = text('[Content_Types].xml')
  // 现有幻灯片：部件 → rId
  const relOf = new Map<string, string>()
  for (const m of presRels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1]
    const target = /Target="([^"]+)"/.exec(m[0])?.[1]
    if (id && target && /slides\/slide\d+\.xml$/.test(target)) relOf.set(`ppt/${target.replace(/^\/?ppt\//, '').replace(/^\.\//, '')}`, id)
  }
  const sldIdOf = new Map<string, string>()
  for (const m of presXml.matchAll(/<p:sldId\b[^>]*?(?:\/>|>\s*<\/p:sldId>)/g)) {
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1]
    for (const [part, r] of relOf) if (r === rid) sldIdOf.set(part, /\bid="(\d+)"/.exec(m[0])![1]!)
  }
  let nextSldId = Math.max(255, ...[...sldIdOf.values()].map(Number)) + 1
  let nextRel = Math.max(0, ...[...presRels.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]))) + 1
  let nextSlideNo = Math.max(0, ...Object.keys(files).map(f => Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(f)?.[1] ?? 0))) + 1

  const keptParts = new Set<string>()
  const sldIds: string[] = []

  // 新插入的图片：写进 ppt/media（同一资产只写一份），在所在页的关系表里登记
  const media = new Map<string, string>()
  const ensureMedia = (rawAssetId: string): string | null => {
    const assetId = rawAssetId.replace(/^asset:/, '')
    if (media.has(assetId)) return media.get(assetId)!
    let a = input.asset?.(assetId)
    if (!a) return null

    let ext = ({
      'image/png': 'png',
      'image/x-png': 'png',
      'image/jpeg': 'jpeg',
      'image/jpg': 'jpeg',
      'image/pjpeg': 'jpeg',
      'image/gif': 'gif',
      'image/bmp': 'bmp',
      'image/x-ms-bmp': 'bmp',
      'image/webp': 'webp',
    } as Record<string, string>)[a.mime]

    if (a.mime === 'image/svg+xml') {
      try {
        const rendered = new Resvg(Buffer.from(a.bytes), {
          fitTo: { mode: 'width', value: 1920 },
          font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans CJK SC' },
        }).render()
        a = { mime: 'image/png', bytes: new Uint8Array(rendered.asPng()) }
        ext = 'png'
      } catch {
        return null
      }
    }

    if (!ext) return null
    const name = `heurion-${assetId}.${ext}`
    files[`ppt/media/${name}`] = new Uint8Array(a.bytes)
    if (!new RegExp(`<Default Extension="${ext}"`, 'i').test(contentTypes)) {
      contentTypes = contentTypes.replace('</Types>', `<Default Extension="${ext}" ContentType="${a.mime}"/></Types>`)
    }
    media.set(assetId, name)
    return name
  }
  // 新建图表：ppt/charts/chartN.xml + 关系（内嵌工作簿）+ 内容类型
  let nextChart = Math.max(0, ...Object.keys(files).map(f => Number(/^ppt\/charts\/chart(\d+)\.xml$/.exec(f)?.[1] ?? 0))) + 1
  const createChart = (data: ChartData): string => {
    const n = nextChart++
    const name = `chart${n}.xml`
    const book = `Microsoft_Excel_Worksheet_heurion${n}.xlsx`
    put(`ppt/charts/${name}`, newChartXml(data))
    files[`ppt/embeddings/${book}`] = new Uint8Array(chartWorkbook(data))
    put(`ppt/charts/_rels/${name}.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/package" Target="../embeddings/${book}"/></Relationships>`)
    contentTypes = contentTypes.replace('</Types>', `<Override PartName="/ppt/charts/${name}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`)
    if (!/<Default Extension="xlsx"/i.test(contentTypes)) contentTypes = contentTypes.replace('</Types>', '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/></Types>')
    return name
  }
  const slideRels = (part: string, initial: string) => {
    const relsPart = part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')
    let xml = initial
    let next = Math.max(0, ...[...xml.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]))) + 1
    const added = new Map<string, string>()
    let dirty = false
    return {
      rels: {
        image(assetId: string): string | null {
          if (added.has(assetId)) return added.get(assetId)!
          const name = ensureMedia(assetId)
          if (!name) { warnings.push(`图片资产 ${assetId} 读取失败，未导出`); return null }
          const rid = `rId${next++}`
          xml = xml.replace('</Relationships>', `<Relationship Id="${rid}" Type="${REL}/image" Target="../media/${name}"/></Relationships>`)
          added.set(assetId, rid)
          dirty = true
          return rid
        },
        chart(data: ChartData): string {
          const rid = `rId${next++}`
          xml = xml.replace('</Relationships>', `<Relationship Id="${rid}" Type="${REL}/chart" Target="../charts/${createChart(data)}"/></Relationships>`)
          dirty = true
          return rid
        },
      } satisfies SlideRels,
      flush(force = false) { if (dirty || force) put(relsPart, xml) },
    }
  }

  input.doc.forEach(slide => {
    const before = baseline.get(slide.attrs.id as string)
    let part = slide.attrs.part as string | null
    if (part && /^ppt\/slides\/slide\d+\.xml$/.test(part) && files[part]) {
      keptParts.add(part)
      if (!(before && before.eq(slide))) {
        const r = slideRels(part, text(part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')) || EMPTY_RELS)
        let xml = rebuildSlide(text(part), slide, before, input, numbers, r.rels)
        if (slide.attrs.bg && slide.attrs.bg !== (before?.attrs.bg ?? null)) xml = withBackground(xml, slide.attrs.bg as string)
        put(part, xml)
        r.flush()
        patchNotes(part, slide, before)
      }
    } else {
      part = `ppt/slides/slide${nextSlideNo++}.xml`
      keptParts.add(part)
      const layout = (slide.attrs.layout as string | null) ?? Object.keys(files).find(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f))
      const r = slideRels(part, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${layout ? `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/${layout.split('/').pop()}"/>` : ''}</Relationships>`)
      let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapesXml(slide, [], 2, input, numbers, r.rels)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
      if (slide.attrs.bg) xml = withBackground(xml, slide.attrs.bg as string)
      put(part, xml)
      r.flush(true)
      contentTypes = contentTypes.replace('</Types>', `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`)
      const rid = `rId${nextRel++}`
      presRels = presRels.replace('</Relationships>', `<Relationship Id="${rid}" Type="${REL}/slide" Target="slides/${part.split('/').pop()}"/></Relationships>`)
      relOf.set(part, rid)
      sldIdOf.set(part, String(nextSldId++))
      if (slide.lastChild?.type.name === 'notes') warnings.push('新增幻灯片的备注暂不导出')
    }
    sldIds.push(`<p:sldId id="${sldIdOf.get(part)}" r:id="${relOf.get(part)}"/>`)
  })

  // 删掉的页：移除部件、关系与内容类型
  const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const [part, rid] of relOf) {
    if (keptParts.has(part)) continue
    delete files[part]
    delete files[part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')]
    presRels = presRels.replace(new RegExp(`<Relationship\\b[^>]*Id="${escRe(rid)}"[^>]*?(?:/>|>\\s*</Relationship>)`), '')
    contentTypes = contentTypes.replace(new RegExp(`<Override PartName="/${escRe(part)}"[^>]*?(?:/>|>\\s*</Override>)`), '')
  }

  // 页序与页数都没变时不重写列表（原文件的写法可能带扩展属性）
  const originalOrder = [...presXml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map(m => m[1])
  const unchangedOrder = originalOrder.length === sldIds.length && sldIds.every((x, i) => x.includes(`r:id="${originalOrder[i]}"`))
  if (!unchangedOrder) presXml = /<p:sldIdLst\b[^>]*>[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\s*\/>/.test(presXml)
    ? presXml.replace(/<p:sldIdLst\b[^>]*>[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\s*\/>/, `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`)
    : presXml.replace(/(<p:sldMasterIdLst\b[\s\S]*?<\/p:sldMasterIdLst>)/, `$1<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`)
  if (!unchangedOrder) put('ppt/presentation.xml', presXml)
  // 导入的图表改了数据：修补图表部件的缓存，重写内嵌工作簿（PowerPoint「编辑数据」看到的就是它）
  input.doc.descendants(n => {
    if (n.type.name !== 'shape') return n.type.name !== 'slide' ? false : true
    const part = n.attrs.chart_part as string | null
    const data = n.attrs.chart as ChartData | null
    if (n.attrs.kind !== 'chart' || !part || !data || !files[part]) return false
    const xml = text(part)
    const before = baseline.get(n.attrs.id as string)?.attrs.chart ?? readChart(xml)
    if (JSON.stringify(before) === JSON.stringify(data)) return false
    put(part, patchChart(xml, data))
    const relsPart = part.replace(/([^/]+)$/, '_rels/$1.rels')
    const pkgRel = /<Relationship\b[^>]*Type="[^"]*\/package"[^>]*Target="([^"]+)"|<Relationship\b[^>]*Target="([^"]+)"[^>]*Type="[^"]*\/package"/.exec(text(relsPart))
    const target = pkgRel ? (pkgRel[1] ?? pkgRel[2])! : null
    const book = target ? `ppt/${target.replace(/^\.\.\//, '')}` : null
    if (book && /\.xlsx$/i.test(book) && files[book]) files[book] = new Uint8Array(chartWorkbook(data))
    else warnings.push(`图表 ${n.attrs.name || n.attrs.id} 的内嵌数据不是 xlsx，PowerPoint 里「编辑数据」会显示旧数据（图上显示的是新数据）`)
    return false
  })
  // 套用过主题：强调色与字体写进 pptx 主题（PowerPoint 里新建的页、图表也匹配）
  const themed = (() => { let k: string | null = null; input.doc.forEach(sl => { k ??= (sl.attrs.theme as string | null) ?? null }); return k })()
  const theme = themed ? DECK_THEMES[themed] : undefined
  if (theme && !(input.baseline && sameThemes(input.baseline, input.doc))) {
    for (const f of Object.keys(files)) {
      if (!/^ppt\/theme\/theme\d+\.xml$/.test(f)) continue
      let xml = text(f)
      for (const [slot, hex] of [['accent1', theme.accent], ['accent2', theme.accent2]] as const) {
        xml = xml.replace(new RegExp(`<a:${slot}>[\\s\\S]*?</a:${slot}>`), `<a:${slot}><a:srgbClr val="${hex}"/></a:${slot}>`)
      }
      xml = xml.replace(/(<a:majorFont>[\s\S]*?)<a:ea typeface="[^"]*"\s*\/>/, `$1<a:ea typeface="${esc(theme.titleFont)}"/>`)
      xml = xml.replace(/(<a:minorFont>[\s\S]*?)<a:ea typeface="[^"]*"\s*\/>/, `$1<a:ea typeface="${esc(theme.bodyFont)}"/>`)
      put(f, xml)
    }
  }
  put('ppt/_rels/presentation.xml.rels', presRels)
  put('[Content_Types].xml', contentTypes)
  return { bytes: zipSync(files), warnings }

  function patchNotes(part: string, slide: PMNode, before: PMNode | undefined): void {
    const now = slide.lastChild?.type.name === 'notes' ? slide.lastChild : null
    const prev = before?.lastChild?.type.name === 'notes' ? before.lastChild : null
    if ((now?.textContent ?? '') === (prev?.textContent ?? '')) return
    const rels = text(part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'))
    const target = /Type="[^"]*\/notesSlide"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Type="[^"]*\/notesSlide"/.exec(rels)
    const notesPart = target ? `ppt/${(target[1] ?? target[2])!.replace(/^\.\.\//, '')}` : null
    if (!notesPart || !files[notesPart]) { warnings.push('原文件没有备注页的幻灯片，备注改动暂不导出'); return }
    const xml = text(notesPart)
    const body = /(<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph\b[^>]*type="body"[\s\S]*?<p:txBody>)([\s\S]*?)(<\/p:txBody>)/.exec(xml)
    if (!body) return
    const keep = (element(body[2]!, 'a:bodyPr') ?? '<a:bodyPr/>') + '<a:lstStyle/>'
    let paras = ''
    now?.forEach(p => { paras += paragraphXml(p, numbers) })
    put(notesPart, xml.replace(body[0], `${body[1]}${keep}${paras || '<a:p/>'}${body[3]}`))
  }
}

const EMPTY_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'

/** 每页的主题都没变（不必重写 pptx 主题部件）。 */
function sameThemes(a: PMNode, b: PMNode): boolean {
  if (a.childCount !== b.childCount) return false
  for (let i = 0; i < a.childCount; i++) if (a.child(i).attrs.theme !== b.child(i).attrs.theme) return false
  return true
}

/** 重建一页的形状树：保留组头与其他非形状元素，形状按模型顺序。 */
function rebuildSlide(xml: string, slide: PMNode, before: PMNode | undefined, input: PptxExportInput, numbers: Map<string, number>, rels: SlideRels): string {
  const raw = childrenRaw(xml, /<p:spTree\b[^>]*>/)
  const head = raw.filter(r => /^<p:(nvGrpSpPr|grpSpPr)\b/.test(r))
  const usedIds = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map(m => Number(m[1]))
  const body = shapesXml(slide, head, Math.max(1, ...usedIds) + 1, input, numbers, rels, before)
  const open = /<p:spTree\b[^>]*>/.exec(xml)!
  const close = xml.indexOf('</p:spTree>', open.index)
  return xml.slice(0, open.index + open[0].length) + body + xml.slice(close)
}

function shapesXml(slide: PMNode, head: string[], nextId: number, input: PptxExportInput, numbers: Map<string, number>, rels: SlideRels, before?: PMNode): string {
  const prev = new Map<string, PMNode>()
  before?.forEach(s => { if (s.attrs.id) prev.set(s.attrs.id as string, s) })
  let out = head.map(ensureGeometry).join('')
  let id = nextId
  slide.forEach(shape => {
    if (shape.type.name !== 'shape') return
    const src = input.src(shape.attrs.id as string)
    const old = prev.get(shape.attrs.id as string)
    let xml: string
    if (src && old && old.eq(shape)) xml = src
    else if (src && old && shape.attrs.kind === 'table' && tableShape(old) !== tableShape(shape)) xml = rebuildTable(patchShape(src, shape, old, numbers), shape, numbers)
    else if (src) xml = patchShape(src, shape, old, numbers)
    else xml = newShapeXml(shape, id++, numbers, rels)
    out += ensureGeometry(xml)
  })
  return out
}
