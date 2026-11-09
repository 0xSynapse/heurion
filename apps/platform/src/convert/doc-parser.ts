import type { Node as PMNode } from 'prosemirror-model'
import { schema } from '../model/schema.ts'
import { readGrid } from '../model/table-grid.ts'
import type { ImportedAsset } from './docx-import.ts'

/**
 * 本地 PDF 结构化解析服务（apps/doc-parser，Docling）的客户端与结果 → 文档模型转换。
 * 服务只在本机 / 内部网络；不可用、未就绪或解析失败时由 pdf-import.ts 退回 poppler 方案。
 */

/** 文字范围上的格式（doc-parser 从 PDF 文字层读出）：[起, 止, 种类]，按 text 的字符下标 */
export type DocParserMark = [number, number, string]

/**
 * 块在原版 PDF 上的位置（原版视图用，docs/design/PDF_ORIGINAL_VIEW.md §3）：
 * regions [[页, 左, 上, 右, 下], …]；spans [[起, 止, 词序号], …] 按块 text 的下标；表格 cells [[行, 列, spans], …]
 */
export interface DocParserSrc { regions: number[][]; spans?: number[][]; cells?: Array<[number, number, number[][]]> }
/** 各页尺寸与全文的词：[页, 左, 上, 右, 下, 文字]（PDF 点，左上原点、显示方向） */
export interface DocParserSource { pages: Array<{ w: number; h: number }>; words: Array<[number, number, number, number, number, string]> }

/** 导入后、块 id 分配前的原版映射：按文档顶层块的位置记 */
export interface PendingSourceMap {
  pages: DocParserSource['pages']
  words: DocParserSource['words']
  blocks: Array<{ index: number; text?: string; spans?: number[][]; regions: number[][]; cells?: Array<[number, number, number[][]]> }>
}
/** 存下来的原版映射：块 id → 导入时的文字、对齐与区域 */
export interface SourceMap {
  version: 1
  pages: DocParserSource['pages']
  words: DocParserSource['words']
  nodes: Record<string, { text?: string; spans?: number[][]; regions?: number[][] }>
}

export type DocParserBlock =
  | { type: 'heading'; level: number; text: string; page?: number | null; marks?: DocParserMark[]; src?: DocParserSrc }
  | { type: 'paragraph'; text: string; page?: number | null; marks?: DocParserMark[]; src?: DocParserSrc }
  | { type: 'list'; ordered: boolean; start?: number; items: string[]; page?: number | null; src?: DocParserSrc }
  /** spans：合并单元格 [起始行, 起始列, 跨行数, 跨列数]，文字只在起始格，被覆盖的格为空 */
  | { type: 'table'; rows: string[][]; header_rows?: number; caption?: string; page?: number | null; spans?: number[][]; src?: DocParserSrc }
  | { type: 'figure'; mime?: string; data: string; caption?: string; page?: number | null; src?: DocParserSrc }
  | { type: 'formula'; latex: string; text?: string; page?: number | null }

export interface DocParserScannedPage {
  page: number
  /** OCR 是否识别出了文字 */
  ocr: boolean
  /** OCR 没识别出文字时附整页图（base64） */
  mime?: string
  data?: string
}

export interface DocParseResult {
  engine: string
  engine_version?: string
  page_count: number
  blocks: DocParserBlock[]
  scanned_pages: DocParserScannedPage[]
  warnings: string[]
  /** 原版视图的映射原料（新版 doc-parser 才有） */
  source?: DocParserSource
}

export interface DocParser {
  /** 服务是否就绪（模型已加载、预热完成）；不就绪时调用方直接走兜底 */
  ready(): Promise<boolean>
  parse(bytes: Uint8Array, filename: string): Promise<DocParseResult>
}

export class DocParserError extends Error {}

export class HttpDocParser implements DocParser {
  private readonly base: string
  constructor(url: string, private readonly opts: { timeoutMs?: number; healthTimeoutMs?: number; fetch?: typeof fetch } = {}) {
    this.base = url.replace(/\/+$/, '')
  }

  private get fetch(): typeof fetch { return this.opts.fetch ?? fetch }

  async ready(): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.base}/health`, { signal: AbortSignal.timeout(this.opts.healthTimeoutMs ?? 2000) })
      if (!res.ok) return false
      const body = await res.json() as { ready?: boolean }
      return body.ready === true
    } catch {
      return false
    }
  }

  async parse(bytes: Uint8Array, filename: string): Promise<DocParseResult> {
    const form = new FormData()
    form.append('file', new File([bytes as Uint8Array<ArrayBuffer>], filename || 'input.pdf', { type: 'application/pdf' }))
    let res: Response
    try {
      res = await this.fetch(`${this.base}/parse`, { method: 'POST', body: form, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300_000) })
    } catch (err) {
      throw new DocParserError(`文档解析服务不可用：${(err as Error).message.slice(0, 120)}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new DocParserError(`文档解析服务返回 ${res.status}：${text.slice(0, 200)}`)
    }
    const body = await res.json() as DocParseResult
    if (!body || !Array.isArray(body.blocks)) throw new DocParserError('文档解析服务返回格式不正确')
    return { ...body, scanned_pages: body.scanned_pages ?? [], warnings: body.warnings ?? [] }
  }
}

const decodeB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const extOf = (mime: string) => mime === 'image/jpeg' ? 'jpg' : 'png'
const CAPTION = /^(fig(ure)?\.?|图|表|table)\s*\d/i

/**
 * 解析结果 → 平台文档节点（尚未分配 id）。
 * - 标题 / 段落 / 列表 / 表格用对应节点；表格是规则网格（合并单元格的文字在左上角格）。
 * - 公式：schema 没有公式节点，用代码样式段落（style='Code'，与 markdown 代码块同一表示）保存 LaTeX 源码，
 *   写成 `$$…$$`；公式识别没跑时保留 PDF 文字层原文。
 * - 图片作为资产（figure 节点 asset_id 先填 key，调用方 bindAssets 换成资产 id），图注写在 caption。
 * - 扫描页：OCR 识别出文字的在开头注明「请核对」；OCR 也没识别出文字的退回整页图并在开头注明。
 */
/** 续表之间常见的页面杂项：续表标记、续表表题、页眉页脚（作者 et al.、DOI、期刊名、页码） */
const CONTINUED = /^[([]?\s*(?:continued|continues|cont'?d\.?)\s*[)\]]?\.?$/i
const CONTINUED_CAPTION = /^table\s+[a-z]?\d+[a-z]?\.?\s*[([]?\s*cont(?:inued|inues|'?d)?\.?(?![a-z])/i
const tableNumber = (c: string | undefined) => c?.trim().match(/^table\s+([a-z]?\d+[a-z]?)/i)?.[1]?.toLowerCase()
const TABLE_CAPTION = /^table\s+[a-z]?\d+[a-z]?\b/i
const FIGURE_CAPTION = /^fig(?:ure)?\.?\s*[a-z]?\d+/i
const RUNNING_HEAD = /\bet al\.|\bdoi\b|https?:\/\/|©|^\s*(?:page\s*)?\d{1,4}\s*$/i

/**
 * 表格整理（Docling 结果 → 文档模型之前）：
 * 1. 跨页续表合并：Docling 按页识别表格，一张长表跨页时会变成几张。后一张在下一页、列数相同、
 *    没有自己的新表题时并进前一张；续页开头与首页表头相同的行去掉。两张表之间允许隔着页眉页脚、
 *    「(Continued)」续表标记与「Table 1 (continued)」「Table 1. Cont.」续表表题；放在表格下方的表题（如「Table 1 …」）归给前一张表。
 *    后一张明确写着同一表号的续表表题时，还允许在同一页（并排排版），且允许隔着最多三段表注，表注移到合并后的表格后面。
 * 2. 表题以「Figure」开头的「表格」是被误认成表格的图（森林图等），只保留图注文字。
 */
export function mergeContinuedTables(blocks: DocParserBlock[]): DocParserBlock[] {
  const norm = (row: string[]) => row.map(c => c.replace(/\s+/g, ' ').trim().toLowerCase()).join('\u0001')
  const width = (rows: string[][]) => Math.max(0, ...rows.map(r => r.length))
  const textOf = (b: DocParserBlock) => (b.type === 'paragraph' || b.type === 'heading' ? b.text.trim() : '')
  const out: DocParserBlock[] = []
  // 已并入表格的块（放在表格下方、归给前一张表的表题），不再单独输出
  const used = new Set<number>()
  for (let i = 0; i < blocks.length; i++) {
    if (used.has(i)) continue
    const b = blocks[i]!
    // 误认成表格的图：只留图注
    if (b.type === 'table' && FIGURE_CAPTION.test((b.caption ?? '').trim())) {
      out.push({ type: 'paragraph', text: b.caption!.trim(), page: b.page })
      continue
    }
    out.push(b)
    if (b.type !== 'table') continue
    // 往后看：跳过页面杂项，找同一张表在下一页的续表
    let cur = out[out.length - 1] as Extract<DocParserBlock, { type: 'table' }>
    // 并进续表时跳过的表注，放到合并后的表格后面
    const after: DocParserBlock[] = []
    let held: DocParserBlock[] = []
    for (let j = i + 1; j < blocks.length; j++) {
      const n = blocks[j]!
      if (n.type !== 'table') {
        const t = textOf(n)
        const noise = t && t.length <= 160 && (CONTINUED.test(t) || CONTINUED_CAPTION.test(t) || RUNNING_HEAD.test(t))
        const lateCaption = !noise && t && TABLE_CAPTION.test(t) && !(cur.caption ?? '').trim() && j - i <= 4
        if (lateCaption) { cur = { ...cur, caption: t }; used.add(j); continue }
        if (noise) continue
        if (n.type === 'paragraph' && held.length < 3 && t.length < 600 && !TABLE_CAPTION.test(t)) { held.push(n); continue }
        break
      }
      const cap = (n.caption ?? '').trim()
      const a = tableNumber(cur.caption), b2 = tableNumber(cap)
      const explicit = !!cap && CONTINUED_CAPTION.test(cap) && (!a || !b2 || a === b2)
      if (
        cur.page == null || n.page == null || !(n.page === cur.page + 1 || (explicit && n.page === cur.page)) ||
        width(n.rows) !== width(cur.rows) || width(n.rows) === 0 ||
        (cap && !explicit) || (held.length > 0 && !explicit)
      ) break
      const head = cur.rows.slice(0, Math.max(cur.header_rows ?? 0, 1)).map(norm)
      let skip = 0
      while (skip < n.rows.length && skip < head.length && norm(n.rows[skip]!) === head[skip]) skip++
      // 续表的合并区整体下移；起点落在被去掉的重复表头里的合并区丢弃
      const offset = cur.rows.length - skip
      const moved = (n.spans ?? []).filter(s => s[0]! >= skip).map(([r, c, rs, cs]) => [r! + offset, c!, rs!, cs!])
      const spans = [...(cur.spans ?? []), ...moved]
      // 原版位置：区域接上，续表单元格的行号同样下移
      const src = cur.src || n.src ? {
        regions: [...(cur.src?.regions ?? []), ...(n.src?.regions ?? [])],
        cells: [...(cur.src?.cells ?? []), ...(n.src?.cells ?? []).filter(([r]) => r >= skip).map(([r, c, sp]) => [r + offset, c, sp] as [number, number, number[][]])],
      } : undefined
      cur = { ...cur, rows: [...cur.rows, ...n.rows.slice(skip)], page: n.page, ...(spans.length ? { spans } : {}), ...(src ? { src } : {}) }
      after.push(...held)
      held = []
      i = j // 续表及其间的页面杂项都已并入
    }
    out[out.length - 1] = cur
    out.push(...after)
  }
  return out
}

/**
 * Docling 表格 → 表格节点，保留合并单元格。
 * 合并区越界的截断；与别的合并区重叠、或盖住有字单元格的丢弃（只保留文字）。
 * 全空行去掉，但合并区经过的行保留，以免合并区断开；若某行整行都被上方的跨行合并盖住（表格非法），整张表退回不合并写法。
 */
export function buildTable(
  b: Extract<DocParserBlock, { type: 'table' }>,
  para: (t: string) => PMNode,
): PMNode | null {
  const width = Math.max(0, ...b.rows.map(r => r.length))
  if (!width) return null
  const rows = b.rows.map(r => Array.from({ length: width }, (_, ci) => (r[ci] ?? '').trim()))
  const header = Math.max(0, b.header_rows ?? 0)

  const spans: Array<{ r: number; c: number; rs: number; cs: number }> = []
  const owner = new Map<string, number>()
  for (const s of b.spans ?? []) {
    const [r, c] = [Math.trunc(Number(s[0])), Math.trunc(Number(s[1]))]
    if (!(r >= 0 && r < rows.length && c >= 0 && c < width)) continue
    const rs = Math.max(1, Math.min(Math.trunc(Number(s[2])) || 1, rows.length - r))
    const cs = Math.max(1, Math.min(Math.trunc(Number(s[3])) || 1, width - c))
    if (rs === 1 && cs === 1) continue
    const area: string[] = []
    let ok = true
    for (let dr = 0; dr < rs && ok; dr++) for (let dc = 0; dc < cs && ok; dc++) {
      const key = `${r + dr},${c + dc}`
      if (owner.has(key) || ((dr || dc) && rows[r + dr]![c + dc])) ok = false
      area.push(key)
    }
    if (!ok) continue
    for (const key of area) owner.set(key, spans.length)
    spans.push({ r, c, rs, cs })
  }

  const touched = new Set<number>()
  for (const s of spans) for (let dr = 0; dr < s.rs; dr++) touched.add(s.r + dr)
  const kept = rows.map((r, ri) => ri).filter(ri => touched.has(ri) || rows[ri]!.some(Boolean))
  if (!kept.length) return null

  const nonEmpty = rows.map((r, ri) => ri).filter(ri => rows[ri]!.some(Boolean))
  if (!nonEmpty.length) return null
  const plain = () => schema.node('table', null, nonEmpty.map(ri => schema.node('table_row', null,
    rows[ri]!.map(t => schema.node('table_cell', { header: ri < header }, [para(t)])))))

  const out: PMNode[] = []
  for (const ri of kept) {
    const cells: PMNode[] = []
    for (let ci = 0; ci < width; ci++) {
      const si = owner.get(`${ri},${ci}`)
      if (si === undefined) { cells.push(schema.node('table_cell', { header: ri < header }, [para(rows[ri]![ci]!)])); continue }
      const s = spans[si]!
      if (s.r !== ri || s.c !== ci) continue // 被合并区覆盖
      cells.push(schema.node('table_cell', { header: ri < header, colspan: s.cs, rowspan: s.rs }, [para(rows[ri]![ci]!)]))
    }
    if (!cells.length) return plain()
    out.push(schema.node('table_row', null, cells))
  }
  return schema.node('table', null, out)
}

/**
 * PDF 文字层丢了上标格式，「kg/m²」变成「kg/m 2」、「I²」变成「I 2」、「10⁹/L」变成「10 9 /L」。
 * 只认这几种不会有歧义的写法，去掉空格、把指数标成上标（文字内容里数字不变）。
 */
const SUP_RULES: RegExp[] = [
  // 面积、体积单位的指数：kg/m 2、m 2、cm 3、1.73 m 2
  /(\b(?:k?g\/m|m|cm|mm|km|µm|μm))\s([23])(?![\d.]*\d)/g,
  // 异质性 I²、决定系数 R²、卡方 χ²
  /((?<![\p{L}\d])[IRχΧ])\s?(2)(?=\s*(?:[=<>≥≤%:,;)]|test\b|$))/gu,
  // 计数单位 10⁹/L
  /(\b10)\s(\d{1,2})(?=\s?\/\s?[A-Za-zμµ])/g,
]

export function scriptedText(t: string): PMNode[] {
  const hits: Array<{ s: number; e: number; base: string; sup: string }> = []
  for (const re of SUP_RULES) {
    re.lastIndex = 0
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const s = m.index, e = m.index + m[0].length
      if (!hits.some(h => s < h.e && e > h.s)) hits.push({ s, e, base: m[1]!, sup: m[2]! })
    }
  }
  hits.sort((a, b) => a.s - b.s)
  const out: PMNode[] = []
  let p = 0
  for (const h of hits) {
    const pre = t.slice(p, h.s) + h.base
    if (pre) out.push(schema.text(pre))
    out.push(schema.text(h.sup, [schema.marks.sup!.create()]))
    p = h.e
  }
  if (p < t.length) out.push(schema.text(t.slice(p)))
  return out
}

const MARK_KINDS = new Set(['sup', 'sub', 'italic'])

/**
 * 带格式的文字：doc-parser 给了上下标 / 斜体范围的按范围加格式，其余部分仍按 scriptedText 的规则补上标
 * （文字层读不出格式时的兜底）。首尾空白去掉，范围随之平移；重叠或越界的范围丢弃。
 */
export function richText(text: string, marks?: DocParserMark[] | null): PMNode[] {
  const lead = text.length - text.trimStart().length
  const t = text.trim()
  const ms = (marks ?? [])
    .filter(m => Array.isArray(m) && MARK_KINDS.has(m[2]) && Number.isInteger(m[0]) && Number.isInteger(m[1]))
    .map(([s, e, k]) => [Math.max(0, s - lead), Math.min(t.length, e - lead), k] as const)
    .filter(([s, e]) => s < e)
    .sort((a, b) => a[0] - b[0])
  if (!ms.length) return t ? scriptedText(t) : []
  const out: PMNode[] = []
  let p = 0
  for (const [s, e, k] of ms) {
    if (s < p) continue
    if (s > p) out.push(...scriptedText(t.slice(p, s)))
    out.push(schema.text(t.slice(s, e), [schema.marks[k]!.create()]))
    p = e
  }
  if (p < t.length) out.push(...scriptedText(t.slice(p)))
  return out
}

export function docParserToDoc(r: DocParseResult, baseName: string): { doc: PMNode; assets: ImportedAsset[]; warnings: string[]; text: string; title?: string | null; sourceMap?: PendingSourceMap } {
  // 原版位置：记在生成的节点上，最后按顶层位置汇总（段落 / 标题的文字去掉了首尾空白，对齐下标随之平移）
  const srcOf = new Map<PMNode, PendingSourceMap['blocks'][number]>()
  const keep = (node: PMNode, src: DocParserSrc | undefined, raw?: string) => {
    if (!src?.regions?.length) return node
    if (raw === undefined) { srcOf.set(node, { index: -1, regions: src.regions, ...(src.cells?.length ? { cells: src.cells } : {}) }); return node }
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    const spans = (src.spans ?? []).map(([s, e, w]) => [s! - lead, Math.min(e! - lead, text.length), w!]).filter(([s, e]) => s! >= 0 && s! < e!)
    srcOf.set(node, { index: -1, text, regions: src.regions, ...(spans.length ? { spans } : {}) })
    return node
  }
  const assets: ImportedAsset[] = []
  const warnings: string[] = [...(r.warnings ?? [])]
  const notes: string[] = []
  // 公式（代码样式段落）保持原文，不做上标处理
  const para = (t: string, attrs: Record<string, unknown> | null = null) =>
    schema.node('paragraph', attrs, t ? (attrs?.style === 'Code' ? [schema.text(t)] : scriptedText(t)) : [])
  const nodes: PMNode[] = []
  const textParts: string[] = []
  let detectedTitle: string | null = null
  let figN = 0

  // OCR 也没识别出文字的扫描页：整页图按页码插在后续页内容之前
  const pendingScans: DocParserScannedPage[] = []
  for (const s of [...(r.scanned_pages ?? [])].sort((a, b) => a.page - b.page)) {
    if (s.ocr) notes.push(`第 ${s.page} 页为扫描页，文字由 OCR 识别，请对照原文核对`)
    else {
      notes.push(`第 ${s.page} 页为扫描页，未识别文字`)
      if (s.data) pendingScans.push(s)
    }
  }
  const emitScan = () => {
    const s = pendingScans.shift()!
    const mime = s.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    const key = `pdf_scan_${s.page}`
    assets.push({ key, name: `${baseName}_p${s.page}.${extOf(mime)}`, mime, bytes: decodeB64(s.data!) })
    nodes.push(schema.node('figure', { asset_id: key, alt: `第 ${s.page} 页（扫描页）`, caption: `第 ${s.page} 页（扫描页）` }))
  }

  const blocks = mergeContinuedTables(r.blocks)
  // 图题注可能被版面模型认成独立段落（紧跟在图后）：并进图注
  const skip = new Set<number>()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (skip.has(i)) continue
    while (pendingScans.length && (b.page ?? 0) > pendingScans[0]!.page) emitScan()
    switch (b.type) {
      case 'heading': {
        const text = b.text.trim()
        if (!text) break
        if (!detectedTitle && (b.level === 1 || !detectedTitle) && text.length >= 4 && text.length <= 250) {
          detectedTitle = text
        }
        nodes.push(keep(schema.node('heading', { level: Math.min(Math.max(Math.round(b.level) || 1, 1), 6) }, richText(b.text, b.marks)), b.src, b.text))
        textParts.push(text)
        break
      }
      case 'paragraph': {
        const text = b.text.trim()
        if (!text) break
        nodes.push(keep(schema.node('paragraph', null, richText(b.text, b.marks)), b.src, b.text))
        textParts.push(text)
        break
      }
      case 'list': {
        const items = b.items.map(t => t.trim()).filter(Boolean)
        if (!items.length) break
        nodes.push(schema.node(b.ordered ? 'ordered_list' : 'bullet_list', b.ordered ? { start: b.start && b.start > 0 ? b.start : 1 } : null,
          items.map(t => schema.node('list_item', null, [para(t)]))))
        textParts.push(...items)
        break
      }
      case 'table': {
        const table = buildTable(b, para)
        if (!table) break
        if (b.caption?.trim()) { nodes.push(para(b.caption.trim())); textParts.push(b.caption.trim()) }
        nodes.push(keep(table, b.src))
        textParts.push(...b.rows.flat().filter(c => c.trim()))
        break
      }
      case 'figure': {
        if (!b.data) break
        const mime = b.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
        let caption = (b.caption ?? '').trim()
        const next = blocks[i + 1]
        if (!caption && next?.type === 'paragraph' && CAPTION.test(next.text.trim()) && next.text.length < 300) {
          caption = next.text.trim()
          skip.add(i + 1)
        }
        const key = `pdf_img_${b.page ?? 0}_${++figN}`
        assets.push({ key, name: `${baseName}_图${figN}.${extOf(mime)}`, mime, bytes: decodeB64(b.data) })
        nodes.push(keep(schema.node('figure', { asset_id: key, alt: caption, caption }), b.src))
        if (caption) textParts.push(caption)
        break
      }
      case 'formula': {
        const latex = b.latex.trim()
        const text = latex ? `$$${latex}$$` : (b.text ?? '').trim()
        if (!text) break
        nodes.push(para(text, { style: 'Code' }))
        textParts.push(text)
        break
      }
    }
  }

  while (pendingScans.length) emitScan()

  if (notes.length) nodes.unshift(para(`导入说明：${notes.join('；')}。`))
  if (!nodes.length) {
    nodes.push(para('（该 PDF 没有可识别的内容）'))
    warnings.push('PDF 中没有可识别的文字或图片')
  }
  warnings.push(...notes)
  let sourceMap: PendingSourceMap | undefined
  if (r.source?.words?.length && srcOf.size) {
    const blocks = nodes.flatMap((n, index) => { const s = srcOf.get(n); return s ? [{ ...s, index }] : [] })
    sourceMap = { pages: r.source.pages, words: r.source.words, blocks }
  }
  return { doc: schema.node('doc', null, nodes), assets, warnings, text: textParts.join('\n'), title: detectedTitle, ...(sourceMap ? { sourceMap } : {}) }
}

/**
 * 文档建好、块 id 分配后，把原版映射换成按块 id 记（表格单元格的对齐落到格里第一个段落上）。
 * 节点文字与导入时对不上的（理论上不会）只留区域。
 */
export function bindSourceMap(doc: PMNode, pending: PendingSourceMap): SourceMap {
  const nodes: SourceMap['nodes'] = {}
  for (const b of pending.blocks) {
    if (b.index >= doc.childCount) continue
    const node = doc.child(b.index)
    const id = node.attrs.id as string | undefined
    if (!id) continue
    if (b.text !== undefined) {
      nodes[id] = node.textContent === b.text ? { text: b.text, regions: b.regions, ...(b.spans ? { spans: b.spans } : {}) } : { regions: b.regions }
      continue
    }
    nodes[id] = { regions: b.regions }
    if (node.type.name === 'table' && b.cells) {
      const grid = readGrid(node)
      for (const [r, c, spans] of b.cells) {
        const cell = grid.at(r, c)
        if (!cell || cell.top !== r || cell.left !== c) continue
        let para: PMNode | null = null
        cell.node.descendants(n => { if (!para && n.isTextblock && n.attrs.id) para = n; return !para })
        const p = para as PMNode | null
        if (p && p.textContent.length) nodes[p.attrs.id as string] = { text: p.textContent, spans: spans.filter(([s, e]) => s! < p.textContent.length && e! <= p.textContent.length) }
      }
    }
  }
  return { version: 1, pages: pending.pages, words: pending.words, nodes }
}
