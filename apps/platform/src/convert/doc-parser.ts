import type { Node as PMNode } from 'prosemirror-model'
import { schema } from '../model/schema.ts'
import type { ImportedAsset } from './docx-import.ts'

/**
 * 本地 PDF 结构化解析服务（apps/doc-parser，Docling）的客户端与结果 → 文档模型转换。
 * 服务只在本机 / 内部网络；不可用、未就绪或解析失败时由 pdf-import.ts 退回 poppler 方案。
 */

export type DocParserBlock =
  | { type: 'heading'; level: number; text: string; page?: number | null }
  | { type: 'paragraph'; text: string; page?: number | null }
  | { type: 'list'; ordered: boolean; start?: number; items: string[]; page?: number | null }
  | { type: 'table'; rows: string[][]; header_rows?: number; caption?: string; page?: number | null }
  | { type: 'figure'; mime?: string; data: string; caption?: string; page?: number | null }
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
export function docParserToDoc(r: DocParseResult, baseName: string): { doc: PMNode; assets: ImportedAsset[]; warnings: string[]; text: string } {
  const assets: ImportedAsset[] = []
  const warnings: string[] = [...(r.warnings ?? [])]
  const notes: string[] = []
  const para = (t: string, attrs: Record<string, unknown> | null = null) => schema.node('paragraph', attrs, t ? [schema.text(t)] : [])
  const nodes: PMNode[] = []
  const textParts: string[] = []
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

  const blocks = r.blocks
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
        nodes.push(schema.node('heading', { level: Math.min(Math.max(Math.round(b.level) || 1, 1), 6) }, [schema.text(text)]))
        textParts.push(text)
        break
      }
      case 'paragraph': {
        const text = b.text.trim()
        if (!text) break
        nodes.push(para(text))
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
        const width = Math.max(0, ...b.rows.map(r => r.length))
        const rows = b.rows.filter(r => r.some(c => c.trim()))
        if (!rows.length || !width) break
        const header = Math.max(0, b.header_rows ?? 0)
        if (b.caption?.trim()) { nodes.push(para(b.caption.trim())); textParts.push(b.caption.trim()) }
        nodes.push(schema.node('table', null, rows.map((r, ri) => schema.node('table_row', null,
          Array.from({ length: width }, (_, ci) => schema.node('table_cell', { header: ri < header }, [para((r[ci] ?? '').trim())]))))))
        textParts.push(...rows.flat())
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
        nodes.push(schema.node('figure', { asset_id: key, alt: caption, caption }))
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
  return { doc: schema.node('doc', null, nodes), assets, warnings, text: textParts.join('\n') }
}
