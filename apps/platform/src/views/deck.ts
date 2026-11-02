import type { Node as PMNode } from 'prosemirror-model'
import { pt } from '../model/deck-schema.ts'
import { isDecoName, layoutByName } from '../model/deck-templates.ts'
import type { LayoutInfo } from '../ops/deck.ts'
import type { MeasureLookup } from '../model/measurements.ts'
import { measurementLegend } from './read.ts'

/**
 * deck 的读视图（PLATFORM.md §7 MCP 面）：outline 列出每页；slide_read 列出一页的形状
 * （id、种类、占位符、几何 pt、文字 markdown）。几何用 pt：模型按 pt 思考与 set_xfrm 一致。
 */

const KIND: Record<string, string> = { text: '文本', shape: '图形', image: '图片', table: '表格', chart: '图表', group: '组合', line: '线条', opaque: '不可编辑' }
const PH: Record<string, string> = { title: '标题', ctrTitle: '标题', subTitle: '副标题', body: '正文', obj: '内容', pic: '图片', dt: '日期', ftr: '页脚', sldNum: '页码' }

/** 段落 → 一行 markdown：lvl 缩进成列表，引用写 [@c:id]，测量写 [@m:id]，强调保留。 */
function paragraphMd(p: PMNode, bulleted: boolean): string {
  let s = ''
  p.forEach(c => {
    if (c.isText) {
      let t = c.text!
      if (c.marks.some(m => m.type.name === 'bold')) t = `**${t}**`
      if (c.marks.some(m => m.type.name === 'italic')) t = `*${t}*`
      s += t
    } else if (c.type.name === 'citation') s += `[@c:${c.attrs.cite_id}]`
    else if (c.type.name === 'measurement') s += `[@m:${c.attrs.m_id}]`
    else if (c.type.name === 'hard_break') s += '<br>'
  })
  const lvl = p.attrs.lvl as number
  return bulleted ? `${'  '.repeat(lvl)}- ${s}` : s
}

/** 正文占位符默认有项目符号；段落属性写了 a:buNone 的（模板的说明、数字等）没有。 */
export const hasBullet = (shape: PMNode, p: PMNode) => (shape.attrs.ph === 'body' || shape.attrs.ph === 'obj') && !/<a:buNone\b/.test(String(p.attrs.ppr ?? ''))

export function shapeText(shape: PMNode): string {
  if (shape.attrs.kind === 'table') {
    const rows: string[] = []
    shape.firstChild?.forEach(row => {
      const cells: string[] = []
      row.forEach(cell => { const parts: string[] = []; cell.forEach(p => parts.push(paragraphMd(p, false))); cells.push(parts.join('<br>')) })
      rows.push(`| ${cells.join(' | ')} |`)
    })
    return rows.join('\n')
  }
  const lines: string[] = []
  shape.forEach(p => { if (p.type.name === 'paragraph') lines.push(paragraphMd(p, hasBullet(shape, p) && p.textContent.trim() !== '')) })
  return lines.join('\n').trim()
}

function slideTitle(slide: PMNode): string {
  let title = ''
  slide.forEach(s => { if (!title && s.type.name === 'shape' && (s.attrs.ph === 'title' || s.attrs.ph === 'ctrTitle')) title = s.textContent })
  if (title) return title
  // 没有标题占位符：取最靠上、字最多的文本形状的第一行
  let best: PMNode | null = null
  slide.forEach(s => {
    if (s.type.name !== 'shape' || s.attrs.kind !== 'text' || !s.textContent.trim()) return
    if (!best || (s.attrs.y as number) < (best.attrs.y as number)) best = s
  })
  return (best as PMNode | null)?.firstChild?.textContent.slice(0, 60) ?? ''
}

export function deckOutline(input: { doc: PMNode; docId: string; title: string; rev: number; layouts: LayoutInfo[]; size: { cx: number; cy: number }; openComments: number; platform?: boolean }): string {
  const lines = [`doc_id=${input.docId} · 《${input.title}》 · 幻灯片 ${input.doc.childCount} 页 · 页面 ${pt(input.size.cx)}×${pt(input.size.cy)}pt · rev=${input.rev} · open 评论 ${input.openComments}`]
  input.doc.forEach((slide, _o, i) => {
    let shapes = 0
    let notes = ''
    slide.forEach(c => { if (c.type.name === 'shape') shapes++; else notes = c.textContent })
    const pending = slide.attrs.suggest ? ` ⟨待采纳·${slide.attrs.suggest === 'insert' ? '新增' : '删除'}⟩` : ''
    lines.push(`第 ${i + 1} 页 {#${slide.attrs.id}}${pending} [${slide.attrs.layout_name || '无版式'}]${slide.attrs.hidden ? ' (隐藏)' : ''} ${slideTitle(slide) || '（无标题）'} · ${shapes} 个形状${notes ? ' · 有备注' : ''}`)
  })
  if (input.layouts.length > 0) lines.push(`可用版式：${input.layouts.map(l => { const def = layoutByName(l.name); return def && input.platform ? `${l.name}（${def.hint}）` : l.name }).join('、')}`)
  if (input.platform) lines.push('模板：deck_templates 列出全部模板，apply_theme 换模板')
  return lines.join('\n')
}

/** 形状第一段文字的颜色与字号（读 a:rPr）。 */
function textLook(shape: PMNode): string {
  let xml: string | undefined
  shape.descendants(n => { if (!xml && n.isText) xml = n.marks.find(m => m.type.name === 'rpr')?.attrs.xml as string | undefined; return !xml })
  if (!xml) return ''
  const color = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(xml.replace(/<a:ln\b[\s\S]*?<\/a:ln>/, ''))?.[1]
  const sz = /\ssz="(\d+)"/.exec(xml)?.[1]
  return [color ? `文字 #${color.toUpperCase()}` : '', sz ? `${Number(sz) / 100}pt` : ''].filter(Boolean).join(' ')
}

const CHART_TYPE: Record<string, string> = { column: '柱状图', bar: '条形图', line: '折线图', pie: '饼图', area: '面积图', doughnut: '圆环图', scatter: '散点图', other: '图表' }

/** 图表数据（slide_read 给 AI 看；chart_set_data 用同样的结构改）。 */
function chartText(chart: { type: string; title?: string; categories: string[]; series: Array<{ name: string; values: Array<number | null> }> }): string {
  const lines = [`${CHART_TYPE[chart.type] ?? chart.type}${chart.title ? `「${chart.title}」` : ''}`, `类别：${chart.categories.join(' | ')}`]
  for (const s of chart.series) lines.push(`系列「${s.name}」：${s.values.map(v => (v === null ? '—' : v)).join(' | ')}`)
  return lines.join('\n')
}

export function slideRead(slide: PMNode, index: number, rev: number): string {
  const look = [slide.attrs.theme ? `主题 ${slide.attrs.theme}` : '', slide.attrs.bg ? `背景 #${slide.attrs.bg}` : ''].filter(Boolean).join(' · ')
  const lines = [`第 ${index + 1} 页 {#${slide.attrs.id}} [${slide.attrs.layout_name || '无版式'}]${look ? ` · ${look}` : ''} · rev=${rev}`, '形状（x, y, 宽 × 高，单位 pt；* 表示位置继承自版式；从下到上的叠放顺序）：']
  const decos: string[] = []
  slide.forEach(shape => {
    if (shape.type.name === 'notes') { lines.push(`备注：${shape.textContent}`); return }
    const a = shape.attrs
    if (isDecoName(a.name)) {
      // 模板装饰合成一行（换模板时自动替换，一般不用管）；图文版式的图片区单独标出位置
      if (/:picture$/.test(a.name as string)) lines.push(`- {#${a.id}} 图片区 (${pt(a.x as number)}, ${pt(a.y as number)}, ${pt(a.w as number)}×${pt(a.h as number)}) [模板装饰：add_image 放在这里]`)
      else decos.push(`{#${a.id}}`)
      return
    }
    const role = a.ph ? `${PH[a.ph as string] ?? a.ph}占位符` : (KIND[a.kind as string] ?? a.kind)
    const geo = `(${pt(a.x as number)}, ${pt(a.y as number)}, ${pt(a.w as number)}×${pt(a.h as number)})${a.xfrm_inherited ? '*' : ''}`
    const pending = a.suggest ? ` ⟨待采纳·${a.suggest === 'insert' ? '新增' : '删除'}⟩` : ''
    const body = a.kind === 'text' || a.kind === 'table' ? shapeText(shape) : a.kind === 'chart' && a.chart ? chartText(a.chart as Parameters<typeof chartText>[0]) : (a.description as string) || (a.kind === 'shape' ? '（无文字）' : '')
    const editable = a.kind === 'text' || a.kind === 'table' || a.kind === 'shape' || a.kind === 'image' || (a.kind === 'chart' && a.chart) ? '' : ' [内容不可编辑]'
    const style = [a.geom && a.geom !== 'rect' ? String(a.geom) : '', a.fill ? (a.fill === 'none' ? '无填充' : `填充 #${a.fill}`) : '', textLook(shape)].filter(Boolean).join(' ')
    lines.push(`- {#${a.id}}${pending} ${role} ${geo}${style ? ` [${style}]` : ''}${editable}${body ? `\n  ${body.replace(/\n/g, '\n  ')}` : ''}`)
  })
  if (decos.length > 0) lines.push(`- 模板装饰 ${decos.length} 个 ${decos.join(' ')}（色条、色块等，不能写字；apply_theme 换模板时自动替换，不想要可以 delete_shape）`)
  return lines.join('\n')
}

/** 全部幻灯片的文字（doc_read 对 deck 的回应；按页分页）。 */
export function deckRead(doc: PMNode, rev: number, cursor = 0, pageSlides = 8, measurements?: MeasureLookup): string {
  const parts: string[] = []
  const slides: PMNode[] = []
  let i = cursor
  for (; i < doc.childCount && i < cursor + pageSlides; i++) { parts.push(slideRead(doc.child(i), i, rev)); slides.push(doc.child(i)) }
  const more = i < doc.childCount ? `\n\n（未读完，下一页 cursor=${i}）` : ''
  return parts.join('\n\n') + more + measurementLegend(slides, measurements)
}
