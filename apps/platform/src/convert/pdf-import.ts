import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { DOMParser, type Element as XElement, type Node as XNode } from '@xmldom/xmldom'
import type { Mark as PMMark, Node as PMNode } from 'prosemirror-model'
import type { Ocr } from '../kb/ocr.ts'
import { deckSchema, emu } from '../model/deck-schema.ts'
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
  kind: 'doc' | 'deck'
  title?: string | null
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

export interface PdfRun {
  text: string
  size: number
  bold: boolean
  italic: boolean
  color?: string
  family?: string
}

export interface PdfLine {
  top: number
  left: number
  width: number
  height: number
  size: number
  bold: boolean
  italic?: boolean
  text: string
  color?: string
  family?: string
  runs?: PdfRun[]
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

/** 快速检测 PDF 是否为横屏演示文稿（宽幅比 > 1.15，例如 16:9 或 4:3 幻灯片，支持 /Rotate 旋转角计算） */
export function isDeckPdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 512 * 1024)
  const s = Buffer.from(bytes.slice(0, limit)).toString('latin1')
  const matches = [...s.matchAll(/\/MediaBox\s*\[\s*([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s*\]/g)]
  if (matches.length > 0) {
    let landscape = 0
    const rotateMatch = /\/Rotate\s+(\d+)/.exec(s)
    const rotate = rotateMatch ? parseInt(rotateMatch[1]!, 10) : 0
    const isRotated = rotate === 90 || rotate === 270

    for (const m of matches) {
      let w = Math.abs(parseFloat(m[3]!) - parseFloat(m[1]!))
      let h = Math.abs(parseFloat(m[4]!) - parseFloat(m[2]!))
      if (isRotated) {
        const tmp = w
        w = h
        h = tmp
      }
      if (w > h * 1.15) landscape++
    }
    return landscape > matches.length / 2
  }
  return false
}

/**
 * PDF 导入为可编辑文档或演示文稿。
 * 1. 若为横屏演示文稿（16:9 / 4:3），自动导入为幻灯片（kind='deck'），保留 2D 画布坐标、形状、段落与图文排版，完全可就地编辑；
 * 2. 若为竖版文档，且本地 doc-parser 服务就绪，优先由 Docling 解析为结构化文档；
 * 3. 服务未配置或未就绪时由 poppler 启发式解析，绝不使用整页截图替代文本。
 */
export async function importPdf(bytes: Uint8Array, filename: string, opts: PdfImportOptions = {}): Promise<PdfImport> {
  const baseName = filename.replace(/\.pdf$/i, '').trim() || '文档'
  let fallbackReason = '未配置文档解析服务'

  const fastDeck = isDeckPdf(bytes)
  // 若确定不是演示文稿且配置了 docParser 服务，优先尝试 Docling 服务
  if (!fastDeck && opts.docParser) {
    if (!(await opts.docParser.ready())) fallbackReason = '文档解析服务未就绪'
    else {
      try {
        const r = await opts.docParser.parse(bytes, filename)
        const built = docParserToDoc(r, baseName)
        const head = built.text.slice(0, 6000)
        return {
          kind: 'doc',
          title: built.title ?? null,
          doc: assignIds(built.doc, new Set()),
          assets: built.assets,
          warnings: built.warnings,
          doi: DOI_RE.exec(head)?.[1] ?? null,
          pmid: PMID_RE.exec(head)?.[1] ?? null,
          pageCount: r.page_count,
          engine: 'docling',
        }
      } catch (err) {
        fallbackReason = `文档解析服务出错：${(err as Error).message.slice(0, 160)}`
      }
    }
  }

  const out = await importPdfPoppler(bytes, filename, opts)
  if (out.kind === 'doc' && opts.docParser) {
    out.warnings.unshift(`${fallbackReason}，已改用基础解析（版面还原可能不完整）`)
    out.fallbackReason = fallbackReason
  }
  return out
}

/**
 * poppler 兜底方案：
 * 1. pdftohtml -xml 提取每页文字位置、字号、粗细、颜色、图片；
 * 2. 若横宽比 > 1.15，按幻灯片构建为 deckSchema（可点击拖拽的卡片与文本框、原版颜色与字号）；
 * 3. 若为竖版文档，按层级解析标题、段落、列表、表格与嵌入图片，杜绝整页截图。
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
    const rootDir = resolve(dir)
    const pages = parsePdfXml(xml, src => {
      if (!src) return null
      const path = resolve(rootDir, src)
      if (!path.startsWith(rootDir + sep)) return null
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

    const landscapePages = pages.filter(p => p.width > p.height * 1.15).length
    const isDeck = pages.length > 0 && landscapePages > pages.length / 2

    const built = isDeck
      ? buildPdfDeck(pages, { baseName, ocrText, pageImages })
      : buildPdfDoc(pages, { baseName, ocrText, pageImages })
    warnings.push(...built.warnings)

    const head = pages.slice(0, 2).flatMap(p => p.lines.map(l => l.text)).join('\n')
    const doi = DOI_RE.exec(head)?.[1] ?? null
    const pmid = PMID_RE.exec(head)?.[1] ?? null

    return {
      kind: isDeck ? 'deck' : 'doc',
      title: built.title ?? null,
      doc: assignIds(built.doc, new Set()),
      assets: built.assets,
      warnings,
      doi,
      pmid,
      pageCount: pages.length,
      engine: 'poppler',
    }
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

function hasItalic(n: XNode): boolean {
  for (let c = n.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && ((c as XElement).tagName === 'i' || (c as XElement).tagName === 'em')) return true
    if (hasItalic(c)) return true
  }
  return false
}

interface FontMeta {
  size: number
  bold: boolean
  italic: boolean
  color?: string
  family?: string
}

export function parsePdfXml(xml: string, loadImage: (src: string) => { bytes: Uint8Array; mime: string } | null): PdfPage[] {
  const dom = new DOMParser().parseFromString(xml.replace(/<!DOCTYPE[^>]*>/, ''), 'text/xml')
  const fonts = new Map<string, FontMeta>()
  const pages: PdfPage[] = []
  const pageEls = dom.getElementsByTagName('page')
  for (let i = 0; i < pageEls.length; i++) {
    const pe = pageEls[i]!
    const page: PdfPage = { number: num(pe, 'number') || i + 1, width: num(pe, 'width'), height: num(pe, 'height'), lines: [], images: [] }
    const rawItems: Array<{ top: number; left: number; width: number; height: number; size: number; bold: boolean; italic: boolean; color?: string; family?: string; text: string }> = []

    for (let c = pe.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue
      const e = c as XElement
      if (e.tagName === 'fontspec') {
        const fam = e.getAttribute('family') ?? ''
        const color = e.getAttribute('color') ?? undefined
        fonts.set(e.getAttribute('id') ?? '', {
          size: num(e, 'size'),
          bold: /bold|black|heavy|semibold|demi/i.test(fam),
          italic: /italic|oblique/i.test(fam),
          family: fam || undefined,
          color: color ? color.replace(/^#/, '').toUpperCase() : undefined,
        })
      } else if (e.tagName === 'text') {
        const text = textOf(e).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').replace(/\s+/g, ' ').trim()
        if (!text) continue
        const f = fonts.get(e.getAttribute('font') ?? '') ?? { size: num(e, 'height'), bold: false, italic: false }
        rawItems.push({
          top: num(e, 'top'),
          left: num(e, 'left'),
          width: num(e, 'width'),
          height: num(e, 'height'),
          size: f.size,
          bold: f.bold || allBold(e),
          italic: f.italic || hasItalic(e),
          color: f.color,
          family: f.family,
          text,
        })
      } else if (e.tagName === 'image') {
        const img = loadImage(e.getAttribute('src') ?? '')
        if (img) page.images.push({ top: num(e, 'top'), left: num(e, 'left'), width: num(e, 'width'), height: num(e, 'height'), ...img })
      }
    }

    // 缝合同一水平线上的连续碎片（如 poppler 分割中英文字体）
    rawItems.sort((a, b) => a.top - b.top || a.left - b.left)
    const lines: PdfLine[] = []
    for (const item of rawItems) {
      const last = lines.at(-1)
      if (last && Math.abs(last.top - item.top) <= Math.max(3, Math.min(last.height, item.height) * 0.4)
          && item.left >= last.left - 2 && item.left <= last.left + last.width + Math.max(25, last.size * 2)) {
        const needsSpace = !/[　-〿㐀-鿿]/.test(last.text.slice(-1)) && !/[　-〿㐀-鿿]/.test(item.text[0] ?? '')
        last.width = Math.max(last.width, item.left + item.width - last.left)
        last.height = Math.max(last.height, item.height)
        last.text = needsSpace ? `${last.text} ${item.text}` : `${last.text}${item.text}`
        last.runs!.push({
          text: (needsSpace ? ' ' : '') + item.text,
          size: item.size,
          bold: item.bold,
          italic: item.italic,
          color: item.color,
          family: item.family,
        })
      } else {
        lines.push({
          top: item.top,
          left: item.left,
          width: item.width,
          height: item.height,
          size: item.size,
          bold: item.bold,
          italic: item.italic,
          color: item.color,
          family: item.family,
          text: item.text,
          runs: [{
            text: item.text,
            size: item.size,
            bold: item.bold,
            italic: item.italic,
            color: item.color,
            family: item.family,
          }],
        })
      }
    }
    page.lines = lines
    pages.push(page)
  }
  return pages
}

/** 文字层少于 20 个字符的页视为扫描页（或纯图页） */
export function isScannedPage(p: PdfPage): boolean {
  const chars = p.lines.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0)
  return chars < 20
}

// —— 演示文稿（Deck）版面还原 ——

export function extractDeckTitle(pages: PdfPage[]): string | null {
  const p1 = pages.find(p => !isScannedPage(p))
  if (!p1 || !p1.lines.length) return null
  const candidates = p1.lines.filter(l => {
    const t = l.text.trim()
    return t.length >= 2 && t.length <= 120 && !/^\d+$/.test(t)
  })
  if (!candidates.length) return null
  const maxSz = Math.max(...candidates.map(l => l.size))
  const titleLines = candidates.filter(l => l.size >= maxSz - 2)
  if (!titleLines.length) return null
  titleLines.sort((a, b) => a.top - b.top || a.left - b.left)
  return titleLines.map(l => l.text).join(' ').trim() || null
}

export function buildPdfDeck(
  pages: PdfPage[],
  ctx: { baseName: string; ocrText?: Map<number, string>; pageImages?: Map<number, Uint8Array> },
): { doc: PMNode; assets: ImportedAsset[]; warnings: string[]; title?: string | null } {
  const assets: ImportedAsset[] = []
  const warnings: string[] = []
  const slides: PMNode[] = []
  const title = extractDeckTitle(pages)
  let figN = 0
  let shapeN = 0

  for (const page of pages) {
    const pageW = page.width || 960
    const pageH = page.height || 540

    if (isScannedPage(page)) {
      const rendered = ctx.pageImages?.get(page.number)
      const largest = [...page.images].sort((a, b) => b.width * b.height - a.width * a.height)[0]
      const img = rendered ? { bytes: rendered, mime: 'image/png' } : largest ? { bytes: largest.bytes, mime: largest.mime } : null
      const ocr = ctx.ocrText?.get(page.number)
      const shapes: PMNode[] = []
      if (img) {
        const key = `pdf_slide_${page.number}`
        assets.push({ key, name: `${ctx.baseName}_p${page.number}.${img.mime === 'image/jpeg' ? 'jpg' : 'png'}`, mime: img.mime, bytes: img.bytes })
        shapes.push(deckSchema.node('shape', {
          id: `sh_${page.number}_scan`,
          kind: 'image',
          asset_id: key,
          x: 0,
          y: 0,
          w: emu(pageW),
          h: emu(pageH),
        }))
      }
      const notes = ocr ? deckSchema.node('notes', null, [deckSchema.node('paragraph', null, [deckSchema.text(ocr)])]) : null
      const slideContent = notes ? [...shapes, notes] : shapes
      slides.push(deckSchema.node('slide', { id: `s_${page.number}` }, slideContent))
      continue
    }

    const shapes: PMNode[] = []

    // 1. 背景色检测：分析文本颜色，若大部分文字为白色/浅色，则判断该页为暗色主题
    let lightCharCount = 0
    let totalCharCount = 0
    for (const l of page.lines) {
      const len = l.text.replace(/\s/g, '').length
      totalCharCount += len
      if (l.color) {
        const hex = l.color.replace(/^#/, '')
        if (hex.length === 6) {
          const r = parseInt(hex.slice(0, 2), 16)
          const g = parseInt(hex.slice(2, 4), 16)
          const b = parseInt(hex.slice(4, 6), 16)
          if ((r * 0.299 + g * 0.587 + b * 0.114) > 170) lightCharCount += len
        }
      }
    }
    const isDarkBg = totalCharCount > 0 && lightCharCount / totalCharCount > 0.4
    const slideBg = isDarkBg ? '0B131E' : null

    // 2. 嵌入图片：背景大图优先作为最底层 shape，其余图片按坐标转为 image shape
    const validImages = page.images.filter(im => im.width >= 16 && im.height >= 16)
    const bgImgs: typeof validImages = []
    const contentImgs: typeof validImages = []
    for (const im of validImages) {
      if (im.width >= pageW * 0.75 && im.height >= pageH * 0.75) bgImgs.push(im)
      else contentImgs.push(im)
    }

    for (const im of bgImgs) {
      const key = `pdf_img_${page.number}_${++figN}`
      assets.push({ key, name: `${ctx.baseName}_img${figN}.${im.mime === 'image/jpeg' ? 'jpg' : 'png'}`, mime: im.mime, bytes: im.bytes })
      shapes.push(deckSchema.node('shape', {
        id: `sh_${page.number}_bg_${figN}`,
        kind: 'image',
        asset_id: key,
        x: emu(im.left),
        y: emu(im.top),
        w: emu(im.width),
        h: emu(im.height),
      }))
    }

    for (const im of contentImgs) {
      const key = `pdf_img_${page.number}_${++figN}`
      assets.push({ key, name: `${ctx.baseName}_img${figN}.${im.mime === 'image/jpeg' ? 'jpg' : 'png'}`, mime: im.mime, bytes: im.bytes })
      shapes.push(deckSchema.node('shape', {
        id: `sh_${page.number}_img_${figN}`,
        kind: 'image',
        asset_id: key,
        x: emu(im.left),
        y: emu(im.top),
        w: emu(im.width),
        h: emu(im.height),
      }))
    }

    // 3. 文字行聚类成独立文本框 shape
    const sortedLines = [...page.lines].sort((a, b) => a.top - b.top || a.left - b.left)
    interface Cluster {
      lines: PdfLine[]
      minX: number
      minY: number
      maxX: number
      maxY: number
    }
    const clusters: Cluster[] = []

    for (const l of sortedLines) {
      let matched: Cluster | null = null
      let bestDist = Infinity

      for (const c of clusters) {
        const vGap = l.top - c.maxY
        const maxVGap = Math.min(48, Math.max(l.height, 14) * 2.2)
        if (vGap < -Math.max(l.height, 10) * 0.5 || vGap > maxVGap) continue

        const clusterW = c.maxX - c.minX
        const leftDiff = Math.abs(l.left - c.minX)
        const overlap = Math.min(l.left + l.width, c.maxX) - Math.max(l.left, c.minX)

        const isHorizNear = leftDiff <= Math.max(28, l.size * 1.5) || overlap >= Math.min(l.width, clusterW) * 0.3
        // 跨列保护：横向差值明显且不重叠时不合并（多栏卡片）
        if (leftDiff > 60 && overlap <= 0) continue

        // 语义隔离
        if (l.top > pageH * 0.88 && c.minY < pageH * 0.75) continue
        if (c.lines.some(cl => cl.size >= 26) && l.size <= 12 && vGap > 20) continue

        if (isHorizNear) {
          const dist = Math.abs(vGap) + leftDiff * 0.5
          if (dist < bestDist) {
            bestDist = dist
            matched = c
          }
        }
      }

      if (matched) {
        matched.lines.push(l)
        matched.minX = Math.min(matched.minX, l.left)
        matched.minY = Math.min(matched.minY, l.top)
        matched.maxX = Math.max(matched.maxX, l.left + l.width)
        matched.maxY = Math.max(matched.maxY, l.top + l.height)
      } else {
        clusters.push({
          lines: [l],
          minX: l.left,
          minY: l.top,
          maxX: l.left + l.width,
          maxY: l.top + l.height,
        })
      }
    }

    // 4. 将聚类构建为具有可编辑文本段落的 shape 节点
    for (const c of clusters) {
      const minX = Math.round(c.minX)
      const minY = Math.round(c.minY)
      const w = Math.max(50, Math.round(c.maxX - c.minX + 16))
      const h = Math.max(20, Math.round(c.maxY - c.minY + 8))

      const paras: PMNode[] = []
      let curRuns: PdfRun[] = []
      let prevLine: PdfLine | null = null

      const shapeMid = minX + w / 2
      let isCentered = false
      if (c.lines.length > 0) {
        let centerDev = 0
        for (const l of c.lines) {
          const lMid = l.left + l.width / 2
          centerDev += Math.abs(lMid - shapeMid)
        }
        const avgDev = centerDev / c.lines.length
        if (avgDev < Math.max(14, w * 0.08) && w >= 60) {
          isCentered = true
        }
      }
      const alignAttr = isCentered ? 'center' : null
      const pprAttr = isCentered ? '<a:pPr algn="ctr"/>' : null

      const flushPara = () => {
        if (!curRuns.length) return
        const inlines: PMNode[] = []
        for (const run of curRuns) {
          if (!run.text) continue
          const marks: PMMark[] = []
          if (run.bold) marks.push(deckSchema.marks.bold.create())
          if (run.italic) marks.push(deckSchema.marks.italic.create())
          const sz = Math.round((run.size || 14) * 100)
          const col = run.color ? run.color.replace(/^#/, '').toUpperCase() : null
          const rprXml = `<a:rPr sz="${sz}"${col ? `><a:solidFill><a:srgbClr val="${col}"/></a:solidFill></a:rPr>` : '/>'}`
          marks.push(deckSchema.marks.rpr.create({ xml: rprXml }))
          inlines.push(deckSchema.text(run.text, marks))
        }
        if (inlines.length) paras.push(deckSchema.node('paragraph', { align: alignAttr, ppr: pprAttr }, inlines))
        curRuns = []
      }

      for (const line of c.lines) {
        const lineRuns = line.runs && line.runs.length > 0 ? line.runs : [{
          text: line.text,
          size: line.size,
          bold: line.bold,
          italic: line.italic ?? false,
          color: line.color,
          family: line.family,
        }]

        const isBullet = /^[•·▪◦‣∙●○■□►▸✓–—-]\s+/.test(line.text)
        const gap = prevLine ? line.top - (prevLine.top + prevLine.height) : 0
        const isSameFlow = prevLine !== null && !isBullet && gap < Math.max(prevLine.height, line.height) * 0.7 && Math.abs(prevLine.size - line.size) < 2

        if (isSameFlow) {
          if (curRuns.length > 0) {
            const last = curRuns[curRuns.length - 1]!
            const needsSpace = !/[　-〿㐀-鿿]/.test(last.text.slice(-1)) && !/[　-〿㐀-鿿]/.test(lineRuns[0]?.text?.[0] ?? '')
            if (needsSpace) last.text += ' '
          }
          curRuns.push(...lineRuns)
        } else {
          flushPara()
          curRuns.push(...lineRuns)
        }
        prevLine = line
      }
      flushPara()

      if (!paras.length) continue

      shapes.push(deckSchema.node('shape', {
        id: `sh_${page.number}_txt_${++shapeN}`,
        kind: 'text',
        x: emu(minX),
        y: emu(minY),
        w: emu(w),
        h: emu(h),
      }, paras))
    }

    slides.push(deckSchema.node('slide', { id: `s_${page.number}`, bg: slideBg }, shapes))
  }

  if (!slides.length) {
    slides.push(deckSchema.node('slide', { id: 's_1' }, []))
  }

  const doc = deckSchema.node('doc', null, slides)
  return { doc, assets, warnings, title }
}

// —— 竖版文档（Doc）版面还原 ——

type Block =
  | { kind: 'heading'; level: number; text: string; top: number }
  | { kind: 'paragraph'; text: string; top: number }
  | { kind: 'list'; ordered: boolean; start: number; items: string[]; top: number }
  | { kind: 'table'; rows: string[][]; header: boolean; top: number }
  | { kind: 'figure'; key: string; caption: string; top: number }

const BULLET = /^[•·▪◦‣∙●○■□►▸✓–—-]\s+/
const ORDERED = /^(?:(\d{1,3})[.)]\s+|(\d{1,3})[、）]\s*|[（(](\d{1,3})[）)]\s*|([a-z])[.)]\s+)(?=\S)/
const SENTENCE_END = /[.。!！?？:：;；]$/
const CJK = /[　-〿㐀-鿿＀-￯]/

function joinLine(prev: string, next: string): string {
  if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(next)) return prev.slice(0, -1) + next
  if (CJK.test(prev.slice(-1)) && CJK.test(next[0] ?? '')) return prev + next
  return `${prev} ${next}`
}

const normEdge = (t: string) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase()
const PAGE_NUMBER = /^(?:page\s*)?#(?:\s*(?:of|\/)\s*#)?$|^第\s*#\s*页(?:\s*[,，/]?\s*共\s*#\s*页)?$|^-\s*#\s*-$|^#$/

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

function bodySize(lines: PdfLine[]): number {
  const w = new Map<number, number>()
  for (const l of lines) w.set(Math.round(l.size), (w.get(Math.round(l.size)) ?? 0) + l.text.length)
  let best = 0, bestN = -1
  for (const [s, n] of w) if (n > bestN) { best = s; bestN = n }
  return best || 12
}

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
  const filled = out.filter(r => r.filter(Boolean).length >= Math.ceil(cols.length / 2)).length
  if (filled < out.length * 0.7) return null
  return { rows: out, header: rows[0]!.every(l => l.bold) }
}

/**
 * 依据学术论文分栏结构重排文本行阅读顺序：
 * 避免左右双栏在相同垂直 top 时被简单扫描行交替穿插（行1左 + 行1右）。
 */
export function orderPageLines(lines: PdfLine[], pageW: number, pageH: number): PdfLine[] {
  if (lines.length < 8 || pageW <= 0) return [...lines].sort((a, b) => a.top - b.top || a.left - b.left)

  const midX = pageW / 2
  const col1Lines: PdfLine[] = []
  const col2Lines: PdfLine[] = []
  const spanLines: PdfLine[] = []

  for (const l of lines) {
    const isCol1 = l.left < midX * 0.95 && (l.left + l.width) <= midX + 15
    const isCol2 = l.left >= midX - 15 && (l.left + l.width) > midX * 1.05
    if (isCol1) col1Lines.push(l)
    else if (isCol2) col2Lines.push(l)
    else spanLines.push(l)
  }

  // 双栏页面：左右栏均有较多行，且跨栏行占少数
  if (col1Lines.length < 4 || col2Lines.length < 4 || (col1Lines.length + col2Lines.length) < lines.length * 0.5) {
    return [...lines].sort((a, b) => a.top - b.top || a.left - b.left)
  }

  // 顶端通栏区域（如标题、作者、摘要）
  let topCutoff = 0
  const topSpanners = spanLines.filter(l => l.top < Math.min(...col1Lines.map(c => c.top), ...col2Lines.map(c => c.top)) + 5)
  if (topSpanners.length > 0) {
    topCutoff = Math.max(...topSpanners.map(l => l.top + l.height))
  }

  // 底端通栏区域（如脚注、页底图注）
  let botCutoff = pageH
  const botSpanners = spanLines.filter(l => l.top > Math.max(...col1Lines.map(c => c.top + c.height), ...col2Lines.map(c => c.top + c.height)) - 5)
  if (botSpanners.length > 0) {
    botCutoff = Math.min(...botSpanners.map(l => l.top))
  }

  const topBand = lines.filter(l => l.top < topCutoff).sort((a, b) => a.top - b.top || a.left - b.left)
  const botBand = lines.filter(l => l.top >= botCutoff).sort((a, b) => a.top - b.top || a.left - b.left)

  const midLines = lines.filter(l => l.top >= topCutoff && l.top < botCutoff)
  const midCol1 = midLines.filter(l => col1Lines.includes(l)).sort((a, b) => a.top - b.top || a.left - b.left)
  const midCol2 = midLines.filter(l => col2Lines.includes(l)).sort((a, b) => a.top - b.top || a.left - b.left)
  const midSpan = midLines.filter(l => !col1Lines.includes(l) && !col2Lines.includes(l)).sort((a, b) => a.top - b.top || a.left - b.left)

  // 顺序：顶端通栏 -> 左栏自上而下 -> 右栏自上而下 -> 中部通栏 -> 底端通栏
  return [...topBand, ...midCol1, ...midCol2, ...midSpan, ...botBand]
}

export function extractDocTitle(pages: PdfPage[]): string | null {
  const p1 = pages.find(p => !isScannedPage(p))
  if (!p1 || !p1.lines.length) return null
  const candidates = p1.lines.filter(l => {
    if (p1.height > 0 && l.top > p1.height * 0.42) return false
    const t = l.text.trim()
    if (t.length < 4 || t.length > 250) return false
    if (/^(journal|volume|vol\.|issue|issn|isbn|doi:|https?:|page\s*\d|published|received|accepted|abstract|contents\b|arxiv:)/i.test(t)) return false
    if (/^\d+(\.\d+)*\s*$/i.test(t)) return false
    return true
  })
  if (!candidates.length) return null
  const maxSz = Math.max(...candidates.map(l => l.size))
  const titleLines = candidates.filter(l => l.size >= maxSz - 1.5)
  if (!titleLines.length) return null
  titleLines.sort((a, b) => a.top - b.top || a.left - b.left)
  return titleLines.map(l => l.text).join(' ').trim() || null
}

export function buildPdfDoc(
  pages: PdfPage[],
  ctx: { baseName: string; ocrText?: Map<number, string>; pageImages?: Map<number, Uint8Array> },
): { doc: PMNode; assets: ImportedAsset[]; warnings: string[]; title?: string | null } {
  const assets: ImportedAsset[] = []
  const warnings: string[] = []
  const notes: string[] = []
  const title = extractDocTitle(pages)
  const drop = edgeLines(pages)
  const textLines = pages.filter(p => !isScannedPage(p)).flatMap(p => p.lines.filter(l => !drop.has(l)))
  const body = bodySize(textLines)

  const isHeadingLine = (l: PdfLine) => {
    if (l.text.length > 120 || (SENTENCE_END.test(l.text) && !/^\d+(\.\d+)*\.?\s/.test(l.text))) return false
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

    const rawLines = page.lines.filter(l => !drop.has(l))
    const lines = orderPageLines(rawLines, page.width, page.height)
    const rows = rowsOf(lines)
    let cur: Block | null = null
    let prev: PdfLine | null = null
    const flush = () => { if (cur) pageBlocks.push(cur); cur = null }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
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
          c.items[c.items.length - 1] = joinLine(c.items.at(-1)!, l.text)
        } else if (c?.kind === 'paragraph' && sameFlow && prev && !(SENTENCE_END.test(prev.text) && (l.left > prev.left + l.size * 1.2 || prev.width < l.width * 0.6))) {
          c.text = joinLine(c.text, l.text)
        } else {
          flush()
          cur = { kind: 'paragraph', text: l.text, top: l.top }
        }
        prev = l
      }
    }
    flush()

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
  return { doc: schema.node('doc', null, nodes), assets, warnings, title }
}
