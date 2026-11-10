import { strToU8, zipSync } from 'fflate'

/**
 * pptx 图表（C1 图表数据编辑）：读图表部件的缓存（类型、类别、系列、数值）、按新数据修补缓存（增删系列时克隆
 * 第一个 c:ser）、生成内嵌工作簿（PowerPoint「编辑数据」看到的就是它）、新建最小可用的图表部件。
 * 图表数据在模型里是形状属性 chart（ChartData）；导入的图表另记 chart_part（部件路径），导出时修补原部件。
 */

export type ChartType = 'column' | 'bar' | 'line' | 'pie' | 'area' | 'scatter' | 'doughnut' | 'other'

export interface ChartSeries { name: string; values: Array<number | null> }

export interface ChartData {
  type: ChartType
  title?: string
  categories: string[]
  series: ChartSeries[]
  /** 各系列颜色（6 位十六进制，可缺）；查看器与新建图表用。 */
  colors?: string[]
}

/** 平台能改数据的图表类型（其余类型只读显示）。 */
export const EDITABLE_CHART_TYPES: ChartType[] = ['column', 'bar', 'line', 'pie', 'area', 'doughnut']

const XML_ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' }
const unescapeXml = (s: string) => s.replace(/&(?:lt|gt|quot|apos|amp);/g, e => XML_ENTITIES[e] ?? e)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 片段里第一个 <name> 元素（自闭合或带内容）。 */
function element(xml: string, name: string): string | null {
  const re = new RegExp(`<${name}\\b[^>]*?/>|<${name}\\b[^>]*>[\\s\\S]*?</${name}>`)
  return re.exec(xml)?.[0] ?? null
}

/** 缓存（strCache / numCache）里的点：按 idx 排好，缺的点为 null。 */
function cachePoints(xml: string | null): Array<string | null> {
  if (!xml) return []
  const count = Number(/<c:ptCount val="(\d+)"/.exec(xml)?.[1] ?? 0)
  const out: Array<string | null> = Array.from({ length: count }, () => null)
  for (const m of xml.matchAll(/<c:pt idx="(\d+)"[^>]*>\s*<c:v>([\s\S]*?)<\/c:v>/g)) {
    const i = Number(m[1])
    if (i >= out.length) out.length = i + 1
    out[i] = unescapeXml(m[2]!)
  }
  return out
}

/** 绘图区里第一个图表元素：c:barChart / c:lineChart / c:pieChart …。 */
function plotChart(xml: string): { name: string; xml: string } | null {
  const m = /<c:(barChart|bar3DChart|lineChart|line3DChart|pieChart|pie3DChart|doughnutChart|areaChart|area3DChart|scatterChart|radarChart|bubbleChart)\b[\s\S]*?<\/c:\1>/.exec(xml)
  return m ? { name: m[1]!, xml: m[0] } : null
}

function typeOf(name: string, xml: string): ChartType {
  if (name.startsWith('bar')) return /<c:barDir val="bar"/.test(xml) ? 'bar' : 'column'
  if (name.startsWith('line')) return 'line'
  if (name.startsWith('pie')) return 'pie'
  if (name === 'doughnutChart') return 'doughnut'
  if (name.startsWith('area')) return 'area'
  if (name === 'scatterChart') return 'scatter'
  return 'other'
}

/** 读图表部件（chartN.xml）：类型、标题、类别（取第一个系列的 c:cat）、各系列名称与数值、系列颜色。 */
export function readChart(xml: string): ChartData | null {
  const chart = plotChart(xml)
  if (!chart) return null
  const sers = [...chart.xml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map(m => m[0])
  if (sers.length === 0) return null
  const catXml = element(sers[0]!, 'c:cat') ?? element(sers[0]!, 'c:xVal')
  const categories = cachePoints(catXml).map(v => v ?? '')
  const series = sers.map((ser, i) => {
    const name = cachePoints(element(element(ser, 'c:tx') ?? '', 'c:strCache')).find(v => v !== null) ?? /<c:tx>\s*<c:v>([\s\S]*?)<\/c:v>/.exec(ser)?.[1] ?? `系列 ${i + 1}`
    const values = cachePoints(element(ser, 'c:val') ?? element(ser, 'c:yVal')).map(v => (v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v)))
    return { name: unescapeXml(name), values }
  })
  const n = Math.max(categories.length, ...series.map(s => s.values.length))
  while (categories.length < n) categories.push('')
  for (const s of series) while (s.values.length < n) s.values.push(null)
  const colors = sers.map(ser => /<c:spPr>[\s\S]*?<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(ser)?.[1]?.toUpperCase() ?? '')
  const titleXml = element(xml, 'c:title')
  const title = titleXml ? [...titleXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => unescapeXml(m[1]!)).join('') : ''
  return { type: typeOf(chart.name, chart.xml), ...(title ? { title } : {}), categories, series, ...(colors.some(Boolean) ? { colors } : {}) }
}

// —— 写 ——

const colName = (i: number) => { let s = ''; let n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) } return s }

function strCache(values: string[]): string {
  return `<c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache>`
}

function numCache(values: Array<number | null>): string {
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache>`
}

/** 一个系列的 tx / cat / val（公式指向内嵌工作簿 Sheet1：A 列类别、第 1 行系列名）。 */
function seriesParts(data: ChartData, si: number): { tx: string; cat: string; val: string } {
  const col = colName(si + 1)
  const last = data.categories.length + 1
  return {
    tx: `<c:tx><c:strRef><c:f>Sheet1!$${col}$1</c:f>${strCache([data.series[si]!.name])}</c:strRef></c:tx>`,
    cat: `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${last}</c:f>${strCache(data.categories)}</c:strRef></c:cat>`,
    val: `<c:val><c:numRef><c:f>Sheet1!$${col}$2:$${col}$${last}</c:f>${numCache(data.series[si]!.values)}</c:numRef></c:val>`,
  }
}

/** 用新数据修补一个已有的 c:ser（保留它的样式 spPr、标记、数据标签等）。 */
function patchSeries(ser: string, data: ChartData, si: number): string {
  const p = seriesParts(data, si)
  let out = ser
    .replace(/<c:idx val="\d+"\/>/, `<c:idx val="${si}"/>`)
    .replace(/<c:order val="\d+"\/>/, `<c:order val="${si}"/>`)
  out = element(out, 'c:tx') ? out.replace(element(out, 'c:tx')!, p.tx) : out.replace(/(<c:order val="\d+"\/>)/, `$1${p.tx}`)
  // 单独设色的数据点（c:dPt）按点数裁掉多余的
  out = out.replace(/<c:dPt>[\s\S]*?<\/c:dPt>/g, d => Number(/<c:idx val="(\d+)"/.exec(d)?.[1] ?? 0) < data.categories.length ? d : '')
  for (const [name, xml] of [['c:cat', p.cat], ['c:val', p.val]] as const) {
    const old = element(out, name)
    if (old) out = out.replace(old, xml)
    else out = name === 'c:cat' ? out.replace(/(<c:val\b)/, `${xml}$1`) : out.replace(/<\/c:ser>$/, `${xml}</c:ser>`)
  }
  return out
}

/** 修补图表部件：系列逐个修补，多出来的克隆最后一个系列（换成下一个强调色），少了就删掉；标题按需替换。 */
export function patchChart(xml: string, data: ChartData): string {
  const chart = plotChart(xml)
  if (!chart) return xml
  const sers = [...chart.xml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map(m => m[0])
  if (sers.length === 0) return xml
  const next = data.series.map((_, si) => {
    const base = sers[si] ?? recolor(sers[sers.length - 1]!, si)
    return patchSeries(base, data, si)
  })
  // 系列整体替换：第一个系列的位置放全部新系列
  const firstAt = chart.xml.indexOf(sers[0]!)
  const lastEnd = chart.xml.lastIndexOf(sers[sers.length - 1]!) + sers[sers.length - 1]!.length
  const plot = chart.xml.slice(0, firstAt) + next.join('') + chart.xml.slice(lastEnd)
  let out = xml.replace(chart.xml, plot)
  if (data.title !== undefined) {
    const old = element(out, 'c:title')
    const want = data.title.trim()
    if (old && want) out = out.replace(old, titleXml(want))
    else if (old && !want) out = out.replace(old, '').replace(/<c:autoTitleDeleted val="0"\/>/, '<c:autoTitleDeleted val="1"/>')
    else if (!old && want) out = out.replace(/(<c:chart>)/, `$1${titleXml(want)}`).replace(/<c:autoTitleDeleted val="1"\/>/, '<c:autoTitleDeleted val="0"/>')
  }
  return out
}

const PALETTE = ['0EA5E9', 'F59E0B', '10B981', '8B5CF6', 'EF4444', '64748B']

function recolor(ser: string, si: number): string {
  const hex = PALETTE[si % PALETTE.length]!
  return ser.replace(/(<c:spPr>[\s\S]*?<a:solidFill>\s*<a:srgbClr val=")[0-9A-Fa-f]{6}(")/, `$1${hex}$2`)
}

function titleXml(text: string): string {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="1400" b="1"/><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
}

/**
 * 内嵌工作簿：Sheet1 的 A 列是类别、第 1 行是系列名（与系列公式一致）。用 inlineStr，不需要 sharedStrings。
 */
export function chartWorkbook(data: ChartData): Uint8Array {
  const rows: string[] = []
  const cell = (ref: string, v: string | number | null) => v === null || v === '' ? '' : typeof v === 'number'
    ? `<c r="${ref}"><v>${v}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`
  rows.push(`<row r="1">${data.series.map((s, si) => cell(`${colName(si + 1)}1`, s.name)).join('')}</row>`)
  data.categories.forEach((c, ci) => {
    rows.push(`<row r="${ci + 2}">${cell(`A${ci + 2}`, c)}${data.series.map((s, si) => cell(`${colName(si + 1)}${ci + 2}`, s.values[ci] ?? null)).join('')}</row>`)
  })
  const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`
  return zipSync({
    '[Content_Types].xml': strToU8(xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')),
    '_rels/.rels': strToU8(xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')),
    'xl/workbook.xml': strToU8(xml('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')),
    'xl/_rels/workbook.xml.rels': strToU8(xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')),
    'xl/worksheets/sheet1.xml': strToU8(xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`)),
  })
}

/** 新建图表部件（chartN.xml）：柱 / 条 / 折线 / 饼 / 面积 / 圆环；系列颜色取 colors，外部数据指向内嵌工作簿（rId1）。 */
export function newChartXml(data: ChartData): string {
  const colors = data.series.map((_, i) => data.colors?.[i] || PALETTE[i % PALETTE.length]!)
  const ser = (si: number) => {
    const p = seriesParts(data, si)
    const fill = data.type === 'line'
      ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${colors[si]}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>`
      : `<c:spPr><a:solidFill><a:srgbClr val="${colors[si]}"/></a:solidFill></c:spPr>`
    // 饼图：每个扇区一种颜色
    const dpts = data.type === 'pie' || data.type === 'doughnut'
      ? data.categories.map((_, ci) => `<c:dPt><c:idx val="${ci}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${data.colors?.[ci] || PALETTE[ci % PALETTE.length]}"/></a:solidFill></c:spPr></c:dPt>`).join('')
      : ''
    return `<c:ser><c:idx val="${si}"/><c:order val="${si}"/>${p.tx}${fill}${data.type === 'column' || data.type === 'bar' ? '<c:invertIfNegative val="0"/>' : ''}${dpts}${p.cat}${p.val}${data.type === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`
  }
  const sers = data.series.map((_, si) => ser(si)).join('')
  const axes = '<c:axId val="111111111"/><c:axId val="222222222"/>'
  let plot: string
  switch (data.type) {
    case 'pie': plot = `<c:pieChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/></c:pieChart>`; break
    case 'doughnut': plot = `<c:doughnutChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>`; break
    case 'line': plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/>${axes}</c:lineChart>`; break
    case 'area': plot = `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}${axes}</c:areaChart>`; break
    default: plot = `<c:barChart><c:barDir val="${data.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers}<c:gapWidth val="80"/>${axes}</c:barChart>`
  }
  const round = data.type === 'pie' || data.type === 'doughnut'
  const axisXml = round ? '' : `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${data.type === 'bar' ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${data.type === 'bar' ? 'b' : 'l'}"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="111111111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
  const title = data.title?.trim() ? titleXml(data.title.trim()) : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:autoTitleDeleted val="${title ? 0 : 1}"/><c:plotArea><c:layout/>${plot}${axisXml}</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200"/></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`
}

/** 校验图表数据（操作层用）：返回错误说明或 null。 */
export function checkChartData(data: ChartData): string | null {
  if (data.categories.length === 0) return '至少要有一个类别'
  if (data.series.length === 0) return '至少要有一个系列'
  if (data.categories.length > 200) return '类别最多 200 个'
  if (data.series.length > 20) return '系列最多 20 个'
  for (const s of data.series) {
    if (s.values.length !== data.categories.length) return `系列「${s.name}」有 ${s.values.length} 个数值，类别有 ${data.categories.length} 个，要一样多`
    if (s.values.some(v => v !== null && !Number.isFinite(v))) return `系列「${s.name}」里有不是数字的值`
  }
  if ((data.type === 'pie' || data.type === 'doughnut') && data.series.length > 1) return '饼图 / 圆环图只能有一个系列'
  return null
}
