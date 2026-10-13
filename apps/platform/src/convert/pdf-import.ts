import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DOMParser, type Element as XElement, type Node as XNode } from '@xmldom/xmldom'
import type { Node as PMNode } from 'prosemirror-model'
import type { Ocr } from '../kb/ocr.ts'
import { assignIds } from '../model/ids.ts'
import { schema } from '../model/schema.ts'
import { docParserToDoc, type DocParser } from './doc-parser.ts'
import type { ImportedAsset } from './docx-import.ts'

const run = promisify(execFile)

const POPPLER_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
const POPPLER_ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` }

function resolveBinary(name: string): string {
  for (const d of POPPLER_DIRS) {
    const p = join(d, name)
    if (existsSync(p)) return p
  }
  return name
}

export interface PdfImport {
  doc: PMNode
  assets: ImportedAsset[]
  warnings: string[]
  doi: string | null
  pmid: string | null
  pageCount: number
  /** 实际使用的解析路径：docling = 本地 doc-parser 服务；poppler = pdftohtml 启发式兜底 */
  engine: 'docling' | 'poppler'
  /** 走兜底时的原因（服务未配置 / 未就绪 / 解析失败） */
  fallbackReason?: string
}

export interface PdfImportOptions {
  /** 扫描页 OCR（kb/ocr.ts 的 localOcr），只用于 poppler 兜底路径；不给时扫描页退回整页图片 */
  ocr?: Ocr
  /** 本地结构化解析服务（apps/doc-parser，Docling）；给了且就绪时作为主路径 */
  docParser?: DocParser | null
}

export class PdfImportError extends Error {}

// —— pdftohtml -xml 的版面元素 ——

export interface PdfLine {
  top: number
  left: number
  width: number
  height: number
  size: number
  bold: boolean
  text: string
}

export interface PdfImage {
  top: number
  left: number
  width: number
  height: number
  /** 图片文件内容；由调用方读入 */
  bytes: Uint8Array
  mime: string
}

export interface PdfPage {
  number: number
  width: number
  height: number
  lines: PdfLine[]
  images: PdfImage[]
}

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>,;]+[^\s"<>,;.)\]])/i
const PMID_RE = /\bPMID:?\s*(\d{6,9})\b/i

/**
 * PDF 导入为可编辑文档。主路径是本地 doc-parser 服务（Docling：版面分析、表格结构、公式、扫描页 OCR）；
 * 服务没配置、未就绪（模型未加载 / 预热中）或解析失败时退回 poppler 启发式方案，结果里的 engine 记录用了哪条路径。
 */
export async function importPdf(bytes: Uint8Array, filename: string, opts: PdfImportOptions = {}): Promise<PdfImport> {
  const baseName = filename.replace(/\.pdf$/i, '').trim() || '文档'
  let fallbackReason = '未配置文档解析服务'
  if (opts.docParser) {
    if (!(await opts.docParser.ready())) fallbackReason = '文档解析服务未就绪'
    else {
      try {
        const r = await opts.docParser.parse(bytes, filename)
        const built = docParserToDoc(r, baseName)
        const head = built.text.slice(0, 6000)
        return {
          doc: assignIds(built.doc, new Set()), assets: built.assets, warnings: built.warnings,
          doi: DOI_RE.exec(head)?.[1] ?? null, pmid: PMID_RE.exec(head)?.[1] ?? null,
          pageCount: r.page_count, engine: 'docling',
        }
      } catch (err) {
        fallbackReason = `文档解析服务出错：${(err as Error).message.slice(0, 160)}`
      }
    }
  }
  const out = await importPdfPoppler(bytes, filename, opts)
  if (opts.docParser) out.warnings.unshift(`${fallbackReason}，已改用基础解析（版面还原可能不完整）`)
  return { ...out, fallbackReason }
}

/**
 * poppler 兜底方案：
 * 1. pdftohtml -xml 取每行文字的位置、字号、粗细，以及嵌入图片（含位置）；
 * 2. 按字号 / 粗细识别标题层级，按行距与缩进合并段落、去断行连字符，识别列表与按列对齐的表格，
 *    删除各页重复的页眉页脚和页码；
 * 3. 只插入 PDF 里真正的嵌入图片；几乎没有文字层的页视为扫描页：有 OCR 时识别成文字，
 *    没有时退回整页图片，并在文档开头注明。
 * 原始 PDF 由调用方另存为文件包。
 */
export async function importPdfPoppler(bytes: Uint8Array, filename: string, opts: PdfImportOptions = {}): Promise<PdfImport> {
  const dir = mkdtempSync(join(tmpdir(), 'heurion-pdf-import-'))
  const warnings: string[] = []
  const baseName = filename.replace(/\.pdf$/i, '').trim() || '文档'

  try {
    const file = join(dir, 'in.pdf')
    writeFileSync(file, bytes)

    let xml: string
    try {
      await run(resolveBinary('pdftohtml'), ['-xml', '-enc', 'UTF-8', '-nodrm', '-fontfullname', '-q', file, join(dir, 'out')], {
        timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: POPPLER_ENV,
      })
      xml = readFileSync(join(dir, 'out.xml'), 'utf8')
    } catch (err) {
      throw new PdfImportError(`无法解析这个 PDF：${(err as Error).message.slice(0, 160)}`)
    }
    const pages = parsePdfXml(xml, src => {
      const path = src.startsWith('/') ? src : join(dir, src)
      if (!existsSync(path)) return null
      return { bytes: new Uint8Array(readFileSync(path)), mime: /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png' }
    })

    // 扫描页：文字层几乎为空
    const scanned = pages.filter(isScannedPage).map(p => p.number)
    const ocrText = new Map<number, string>()
    if (scanned.length && opts.ocr) {
      try {
        for (const [k, v] of await opts.ocr(bytes, scanned)) if (v.trim()) ocrText.set(k, v)
      } catch (err) {
        warnings.push(`扫描页 OCR 失败：${(err as Error).message.slice(0, 120)}`)
      }
    }
    // 没有 OCR 结果的扫描页渲染整页图
    const pageImages = new Map<number, Uint8Array>()
    for (const n of scanned.filter(n => !ocrText.has(n))) {
      try {
        await run(resolveBinary('pdftoppm'), ['-png', '-r', '150', '-f', String(n), '-l', String(n), '-singlefile', file, join(dir, `scan-${n}`)], { timeout: 120_000, env: POPPLER_ENV })
        pageImages.set(n, new Uint8Array(readFileSync(join(dir, `scan-${n}.png`))))
      } catch (err) {
        warnings.push(`第 ${n} 页渲染失败：${(err as Error).message.slice(0, 100)}`)
      }
    }

    const built = buildPdfDoc(pages, { baseName, ocrText, pageImages })
    warnings.push(...built.warnings)

    const head = pages.slice(0, 2).flatMap(p => p.lines.map(l => l.text)).join('\n')
    const doi = DOI_RE.exec(head)?.[1] ?? null
    const pmid = PMID_RE.exec(head)?.[1] ?? null

    return { doc: assignIds(built.doc, new Set()), assets: built.assets, warnings, doi, pmid, pageCount: pages.length, engine: 'poppler' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// —— XML 解析 ——

const num = (e: XElement, k: string) => Number(e.getAttribute(k) ?? 0) || 0

function textOf(n: XNode): string {
  let s = ''
  for (let c = n.firstChild; c; c = c.nextSibling) s += c.nodeType === 3 ? (c.nodeValue ?? '') : textOf(c)
  return s
}

/** 一行是否整体加粗：所有非空文字都在 <b> 里 */
function allBold(n: XNode, inB = false): boolean {
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) { if ((c.nodeValue ?? '').trim() && !inB) return false }
    else if (!allBold(c, inB || (c as XElement).tagName === 'b')) return false
  }
  return true
}

export function parsePdfXml(xml: string, loadImage: (src: string) => { bytes: Uint8Array; mime: string } | null): PdfPage[] {
  const dom = new DOMParser().parseFromString(xml.replace(/<!DOCTYPE[^>]*>/, ''), 'text/xml')
  const fonts = new Map<string, { size: number; bold: boolean }>()
  const pages: PdfPage[] = []
  const pageEls = dom.getElementsByTagName('page')
  for (let i = 0; i < pageEls.length; i++) {
    const pe = pageEls[i]!
    const page: PdfPage = { number: num(pe, 'number') || i + 1, width: num(pe, 'width'), height: num(pe, 'height'), lines: [], images: [] }
    for (let c = pe.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue
      const e = c as XElement
      if (e.tagName === 'fontspec') {
        // fontspec 在整个文件里按 id 全局有效
        fonts.set(e.getAttribute('id') ?? '', { size: num(e, 'size'), bold: /bold|black|heavy|semibold|demi/i.test(e.getAttribute('family') ?? '') })
      } else if (e.tagName === 'text') {
        const text = textOf(e).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').replace(/\s+/g, ' ').trim()
        if (!text) continue
        const f = fonts.get(e.getAttribute('font') ?? '') ?? { size: num(e, 'height'), bold: false }
        page.lines.push({ top: num(e, 'top'), left: num(e, 'left'), width: num(e, 'width'), height: num(e, 'height'), size: f.size, bold: f.bold || allBold(e), text })
      } else if (e.tagName === 'image') {
        const img = loadImage(e.getAttribute('src') ?? '')
        if (img) page.images.push({ top: num(e, 'top'), left: num(e, 'left'), width: num(e, 'width'), height: num(e, 'height'), ...img })
      }
    }
    pages.push(page)
  }
  return pages
}

/** 文字层少于 20 个字符的页视为扫描页（或纯图页） */
export function isScannedPage(p: PdfPage): boolean {
  const chars = p.lines.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0)
  return chars < 20
}

// —— 版面 → 结构化文档 ——

type Block =
  | { kind: 'heading'; level: number; text: string; top: number }
  | { kind: 'paragraph'; text: string; top: number }
  | { kind: 'list'; ordered: boolean; start: number; items: string[]; top: number }
  | { kind: 'table'; rows: string[][]; header: boolean; top: number }
  | { kind: 'figure'; key: string; caption: string; top: number }

const BULLET = /^[•·▪◦‣∙●○■□►▸✓–—-]\s+/
// 「1. 」「1) 」「(1) 」后须有空格（避免把 3.5 mg 当成编号）；「1、」「（1）」可直接接文字
const ORDERED = /^(?:(\d{1,3})[.)]\s+|(\d{1,3})[、）]\s*|[（(](\d{1,3})[）)]\s*|([a-z])[.)]\s+)(?=\S)/
const SENTENCE_END = /[.。!！?？:：;；]$/
const CJK = /[　-〿㐀-鿿＀-￯]/

/** 把下一行接到上一行：去断行连字符，中文之间不加空格 */
function joinLine(prev: string, next: string): string {
  if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(next)) return prev.slice(0, -1) + next
  if (CJK.test(prev.slice(-1)) && CJK.test(next[0] ?? '')) return prev + next
  return `${prev} ${next}`
}

/** 页眉页脚用的归一化：数字统一替换，便于跨页比对「第 3 页」「Page 3」之类 */
const normEdge = (t: string) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase()
const PAGE_NUMBER = /^(?:page\s*)?#(?:\s*(?:of|\/)\s*#)?$|^第\s*#\s*页(?:\s*[,，/]?\s*共\s*#\s*页)?$|^-\s*#\s*-$|^#$/

/** 找出各页重复出现在页面上下边缘的行（页眉、页脚、页码） */
function edgeLines(pages: PdfPage[]): Set<PdfLine> {
  const drop = new Set<PdfLine>()
  const counts = new Map<string, number>()
  const edge = (p: PdfPage, l: PdfLine) => p.height > 0 && (l.top < p.height * 0.08 || l.top + l.height > p.height * 0.92)
  for (const p of pages) {
    const seen = new Set<string>()
    for (const l of p.lines) if (edge(p, l)) seen.add(normEdge(l.text))
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const textPages = pages.filter(p => !isScannedPage(p)).length
  for (const p of pages) {
    for (const l of p.lines) {
      if (!edge(p, l)) continue
      const k = normEdge(l.text)
      if (PAGE_NUMBER.test(k) || (textPages >= 2 && (counts.get(k) ?? 0) >= 2)) drop.add(l)
    }
  }
  return drop
}

/** 正文字号：按字符数加权的众数 */
function bodySize(lines: PdfLine[]): number {
  const w = new Map<number, number>()
  for (const l of lines) w.set(Math.round(l.size), (w.get(Math.round(l.size)) ?? 0) + l.text.length)
  let best = 0, bestN = -1
  for (const [s, n] of w) if (n > bestN) { best = s; bestN = n }
  return best || 12
}

/** 同一行（top 相近）的连续元素归成一组；表格识别按组进行 */
function rowsOf(lines: PdfLine[]): PdfLine[][] {
  const rows: PdfLine[][] = []
  for (const l of lines) {
    const last = rows.at(-1)
    const ref = last?.[0]
    if (ref && Math.abs(ref.top - l.top) <= Math.max(2, Math.min(ref.height, l.height) * 0.5) && l.left > last.at(-1)!.left) last.push(l)
    else rows.push([l])
  }
  return rows
}

/** 把一段连续的多单元格行转成表格：按各单元格左边界聚成列 */
function tableOf(rows: PdfLine[][]): { rows: string[][]; header: boolean } | null {
  const lefts = rows.flat().map(l => l.left).sort((a, b) => a - b)
  const cols: number[] = []
  for (const x of lefts) if (!cols.length || x - cols.at(-1)! > 12) cols.push(x)
  if (cols.length < 2 || cols.length > 12) return null
  const out = rows.map(r => {
    const cells = cols.map(() => '')
    for (const l of r) {
      let ci = 0
      for (let i = 0; i < cols.length; i++) if (l.left >= cols[i]! - 6) ci = i
      cells[ci] = cells[ci] ? `${cells[ci]} ${l.text}` : l.text
    }
    return cells
  })
  // 大多数行要填满至少一半的列，否则更像是错位的正文
  const filled = out.filter(r => r.filter(Boolean).length >= Math.ceil(cols.length / 2)).length
  if (filled < out.length * 0.7) return null
  return { rows: out, header: rows[0]!.every(l => l.bold) }
}

export function buildPdfDoc(
  pages: PdfPage[],
  ctx: { baseName: string; ocrText?: Map<number, string>; pageImages?: Map<number, Uint8Array> },
): { doc: PMNode; assets: ImportedAsset[]; warnings: string[] } {
  const assets: ImportedAsset[] = []
  const warnings: string[] = []
  const notes: string[] = []
  const drop = edgeLines(pages)
  const textLines = pages.filter(p => !isScannedPage(p)).flatMap(p => p.lines.filter(l => !drop.has(l)))
  const body = bodySize(textLines)

  // 标题候选：字号明显大于正文，或与正文同号但整行加粗的短行
  const isHeadingLine = (l: PdfLine) => {
    if (l.text.length > 120 || SENTENCE_END.test(l.text) && !/^\d+(\.\d+)*\.?\s/.test(l.text)) return false
    if (l.size >= body * 1.15) return true
    return l.bold && l.size >= body * 0.95 && l.text.length <= 80 && !BULLET.test(l.text)
  }
  const headingSizes = [...new Set(textLines.filter(isHeadingLine).map(l => Math.round(l.size)))].sort((a, b) => b - a)
  const levelOf = (l: PdfLine) => Math.min(headingSizes.indexOf(Math.round(l.size)) + 1 || 1, 4)

  const blocks: Block[] = []
  let figN = 0
  for (const page of pages) {
    const pageBlocks: Block[] = []

    if (isScannedPage(page)) {
      const ocr = ctx.ocrText?.get(page.number)
      if (ocr) {
        notes.push(`第 ${page.number} 页为扫描页，文字由 OCR 识别，请对照原文核对`)
        for (const para of ocr.split(/\n\s*\n/).map(s => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)) pageBlocks.push({ kind: 'paragraph', text: para, top: 0 })
      } else {
        const rendered = ctx.pageImages?.get(page.number)
        const largest = [...page.images].sort((a, b) => b.width * b.height - a.width * a.height)[0]
        const img = rendered ? { bytes: rendered, mime: 'image/png' } : largest ? { bytes: largest.bytes, mime: largest.mime } : null
        notes.push(`第 ${page.number} 页为扫描页，未识别文字`)
        if (img) {
          const key = `pdf_scan_${page.number}`
          assets.push({ key, name: `${ctx.baseName}_p${page.number}.${img.mime === 'image/jpeg' ? 'jpg' : 'png'}`, mime: img.mime, bytes: img.bytes })
          pageBlocks.push({ kind: 'figure', key, caption: `第 ${page.number} 页（扫描页）`, top: 0 })
        }
      }
      blocks.push(...pageBlocks)
      continue
    }

    const lines = page.lines.filter(l => !drop.has(l))
    const rows = rowsOf(lines)
    let cur: Block | null = null
    let prev: PdfLine | null = null
    const flush = () => { if (cur) pageBlocks.push(cur); cur = null }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      // 表格：连续 ≥2 行，每行 ≥2 个分离的单元格
      if (row.length >= 2) {
        let j = i
        while (j < rows.length && rows[j]!.length >= 2) j++
        if (j - i >= 2) {
          const t = tableOf(rows.slice(i, j))
          if (t) {
            flush()
            pageBlocks.push({ kind: 'table', rows: t.rows, header: t.header, top: row[0]!.top })
            prev = null
            i = j - 1
            continue
          }
        }
      }
      for (const l of row) {
        const gap = prev ? l.top - (prev.top + prev.height) : Infinity
        const sameFlow = prev !== null && gap >= -2 && gap < Math.max(prev.height, l.height) * 0.75 && Math.abs(prev.size - l.size) < 1.5

        if (isHeadingLine(l)) {
          const c = cur as Block | null
          // 换行的长标题：同字号、紧挨着的上一行也是标题时接上
          if (c?.kind === 'heading' && sameFlow && prev && isHeadingLine(prev)) { c.text = joinLine(c.text, l.text) }
          else { flush(); cur = { kind: 'heading', level: levelOf(l), text: l.text, top: l.top } }
          prev = l
          continue
        }

        const bullet = BULLET.exec(l.text)
        const ordered = bullet ? null : ORDERED.exec(l.text)
        if (bullet || ordered) {
          const isOrdered = !!ordered
          const text = l.text.slice((bullet ?? ordered)![0].length).trim()
          const c = cur as Block | null
          if (c?.kind === 'list' && c.ordered === isOrdered && gap < l.height * 1.5) c.items.push(text)
          else {
            flush()
            const start = ordered ? Number(ordered[1] ?? ordered[2] ?? ordered[3] ?? 0) || (ordered[4] ? ordered[4].charCodeAt(0) - 96 : 1) : 1
            cur = { kind: 'list', ordered: isOrdered, start, items: [text], top: l.top }
          }
          prev = l
          continue
        }

        const c = cur as Block | null
        if (c?.kind === 'list' && sameFlow && prev && l.left > prev.left - 2 && !SENTENCE_END.test(c.items.at(-1)!)) {
          // 列表项的续行（比列表符号缩进）
          c.items[c.items.length - 1] = joinLine(c.items.at(-1)!, l.text)
        } else if (c?.kind === 'paragraph' && sameFlow && prev && !(SENTENCE_END.test(prev.text) && (l.left > prev.left + l.size * 1.2 || prev.width < l.width * 0.6))) {
          // 同段续行；上一行以句末标点结束且本行首行缩进 / 上一行明显较短时另起一段
          c.text = joinLine(c.text, l.text)
        } else {
          flush()
          cur = { kind: 'paragraph', text: l.text, top: l.top }
        }
        prev = l
      }
    }
    flush()

    // 嵌入图片：过滤装饰性小图，按纵向位置插到最近的文字块前；紧随其后的「图 N / Figure N」段落作为题注
    const imgs = page.images.filter(im => im.width >= 32 && im.height >= 32).sort((a, b) => a.top - b.top)
    for (const im of imgs) {
      const key = `pdf_img_${page.number}_${++figN}`
      assets.push({ key, name: `${ctx.baseName}_图${figN}.${im.mime === 'image/jpeg' ? 'jpg' : 'png'}`, mime: im.mime, bytes: im.bytes })
      let at = pageBlocks.findIndex(b => b.top > im.top)
      if (at < 0) at = pageBlocks.length
      let caption = ''
      const next = pageBlocks[at]
      if (next?.kind === 'paragraph' && /^(fig(ure)?\.?|图|表|table)\s*\d/i.test(next.text) && next.text.length < 300) {
        caption = next.text
        pageBlocks.splice(at, 1)
      }
      pageBlocks.splice(at, 0, { kind: 'figure', key, caption, top: im.top })
    }
    blocks.push(...pageBlocks)
  }

  // 跨页续段：上一页最后一段没以句末标点结束、下一页第一块是段落时合并
  const merged: Block[] = []
  for (const b of blocks) {
    const last = merged.at(-1)
    if (last?.kind === 'paragraph' && b.kind === 'paragraph' && b.top < last.top && !SENTENCE_END.test(last.text) && /^[a-z一-鿿]/.test(b.text)) last.text = joinLine(last.text, b.text)
    else merged.push(b)
  }

  const para = (t: string) => schema.node('paragraph', null, t ? [schema.text(t)] : [])
  const nodes: PMNode[] = []
  if (notes.length) nodes.push(para(`导入说明：${notes.join('；')}。`))
  for (const b of merged) {
    switch (b.kind) {
      case 'heading': nodes.push(schema.node('heading', { level: b.level }, [schema.text(b.text)])); break
      case 'paragraph': nodes.push(para(b.text)); break
      case 'list':
        nodes.push(schema.node(b.ordered ? 'ordered_list' : 'bullet_list', b.ordered ? { start: b.start } : null,
          b.items.map(t => schema.node('list_item', null, [para(t)]))))
        break
      case 'table':
        nodes.push(schema.node('table', null, b.rows.map((r, ri) => schema.node('table_row', null,
          r.map(cell => schema.node('table_cell', { header: b.header && ri === 0 }, [para(cell)]))))))
        break
      case 'figure': nodes.push(schema.node('figure', { asset_id: b.key, alt: b.caption, caption: b.caption })); break
    }
  }
  if (!nodes.length) {
    nodes.push(para('（该 PDF 没有可识别的内容）'))
    warnings.push('PDF 中没有文字层，也没有可提取的图片')
  }
  if (notes.length) warnings.push(...notes)
  return { doc: schema.node('doc', null, nodes), assets, warnings }
}
