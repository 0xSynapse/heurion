import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { importDocx } from '../convert/docx-import.ts'
import { importPptx } from '../convert/pptx-import.ts'
import type { Ocr } from './ocr.ts'

const run = promisify(execFile)

const PDFTOTEXT_CANDIDATES = [
  'pdftotext',
  '/opt/homebrew/bin/pdftotext',
  '/usr/local/bin/pdftotext',
  '/usr/bin/pdftotext',
]

function resolvePdftotext(): string {
  for (const p of PDFTOTEXT_CANDIDATES) {
    if (p.startsWith('/') && existsSync(p)) return p
  }
  return 'pdftotext'
}

/** 抽取结果：按页的文字（docx / txt 没有页的概念，记为第 1 页），以及能识别出的 DOI / PMID。 */
export interface Extracted {
  pages: string[]
  doi: string | null
  pmid: string | null
  /** 给用户的提示（扫描件没有文字层等）。 */
  note: string | null
}

export class ExtractError extends Error {}

export const KB_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
}

/** OCR 最多识别的页数（扫描的整本书只取前面这些页）。 */
const OCR_MAX_PAGES = 200

/**
 * 按文件名后缀抽取文字（PDF 用 poppler 的 pdftotext，按换页符分页）。
 * 给了 ocr 时，没有文字层的页（扫描件、扫描页）做 OCR。
 */
export async function extractText(name: string, bytes: Uint8Array, opts: { ocr?: Ocr; onOcr?: (done: number, total: number) => void } = {}): Promise<Extracted> {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  let pages: string[]
  let ocred = 0
  if (ext === 'pdf') {
    pages = await pdfPages(bytes)
    const empty = pages.map((p, i) => (p.trim().length < 20 ? i + 1 : 0)).filter(Boolean).slice(0, OCR_MAX_PAGES)
    if (opts.ocr && empty.length > 0) {
      try {
        const got = await opts.ocr(bytes, empty, opts.onOcr)
        for (const [page, text] of got) if (text.trim()) { pages[page - 1] = text; ocred++ }
      } catch (err) {
        throw new ExtractError(`扫描页文字识别（OCR）失败：${(err as Error).message.slice(0, 200)}`)
      }
    }
  }
  else if (ext === 'docx') {
    const doc = importDocx(bytes).doc
    pages = [doc.textBetween(0, doc.content.size, '\n', ' ')]
  } else if (ext === 'pptx') {
    const doc = importPptx(bytes).doc
    pages = []
    doc.forEach(slide => pages.push(slide.textBetween(0, slide.content.size, '\n', ' ')))
  } else if (ext === 'txt' || ext === 'md') {
    pages = [new TextDecoder('utf-8').decode(bytes)]
  } else {
    throw new ExtractError(`不支持的文件类型 .${ext}（支持 PDF、docx、pptx、txt、md）`)
  }
  const total = pages.reduce((n, p) => n + p.trim().length, 0)
  const note = ocred > 0
    ? `${ocred} 页是扫描页，已用 OCR 识别文字（可能有识别错误）`
    : ext === 'pdf' && total < pages.length * 20
      ? '这份 PDF 几乎没有文字层（可能是扫描件），没有识别到文字，检索不到内容'
      : total === 0 ? '没有抽取到文字' : null
  const head = pages.slice(0, 2).join('\n')
  const doi = /\b(10\.\d{4,9}\/[^\s"<>,;]+[^\s"<>,;.)\]])/i.exec(head)?.[1] ?? null
  const pmid = /\bPMID:?\s*(\d{6,9})\b/i.exec(head)?.[1] ?? null
  return { pages, doi, pmid, note }
}

export async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'heurion-kb-'))
  try {
    const file = join(dir, 'in.pdf')
    writeFileSync(file, bytes)
    const bin = resolvePdftotext()
    const { stdout } = await run(bin, ['-enc', 'UTF-8', file, '-'], {
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
    })
    const pages = stdout.split('\f')
    if (pages.length > 1 && pages.at(-1)!.trim() === '') pages.pop()
    return pages
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ExtractError('缺少 pdftotext（poppler-utils），无法抽取 PDF 文字')
    throw new ExtractError(`PDF 抽取失败：${(err as Error).message.slice(0, 200)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 切块：约 size 字一块，块间重叠 overlap 字；尽量在段落处断开，块的页码记为它开始的那一页。
 * 过短的块（< 20 字）并到前一块。
 */
export function chunkPages(pages: string[], size = 1200, overlap = 150): Array<{ page: number; text: string }> {
  const out: Array<{ page: number; text: string }> = []
  let buf = ''
  let page = 1
  const flush = () => {
    const text = buf.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    if (text.length >= 20 || out.length === 0) { if (text) out.push({ page, text }) }
    else if (text) out[out.length - 1]!.text += `\n${text}`
    // 重叠尾巴从词边界开始（英文不从半个词起头）
    let tail = text.length > overlap ? text.slice(-overlap) : ''
    const sp = tail.search(/\s/)
    if (sp > 0 && sp < overlap / 2 && /\w/.test(tail[0]!)) tail = tail.slice(sp + 1)
    buf = tail
  }
  pages.forEach((content, i) => {
    for (const para of content.split(/\n\s*\n|\n(?=\s*[•\-\d]+[.)、]?\s)/)) {
      const p = para.replace(/\s*\n\s*/g, ' ').trim()
      if (!p) continue
      if (buf.length + p.length + 1 > size && buf.length > overlap) flush()
      // 缓冲里只剩重叠尾巴时，这一块算新段落所在的页
      if (buf.length <= overlap) page = i + 1
      if (p.length > size) {
        // 超长段落：按剩余空间切片，每块不超过 size
        let rest = p
        while (rest) {
          const room = size - buf.length - (buf ? 1 : 0)
          buf += (buf ? ' ' : '') + rest.slice(0, room)
          rest = rest.slice(room)
          if (buf.length >= size - 1) { flush(); page = i + 1 }
        }
      } else {
        buf += (buf ? '\n' : '') + p
      }
    }
  })
  if (buf.trim().length > overlap || out.length === 0) flush()
  return out
}
