import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Node as PMNode } from 'prosemirror-model'
import { assignIds } from '../model/ids.ts'
import { schema } from '../model/schema.ts'
import type { ImportedAsset } from './docx-import.ts'

const run = promisify(execFile)

const PDFTOPPM_CANDIDATES = [
  'pdftoppm',
  '/opt/homebrew/bin/pdftoppm',
  '/usr/local/bin/pdftoppm',
  '/usr/bin/pdftoppm',
]

const PDFTOTEXT_CANDIDATES = [
  'pdftotext',
  '/opt/homebrew/bin/pdftotext',
  '/usr/local/bin/pdftotext',
  '/usr/bin/pdftotext',
]

function resolveBinary(candidates: string[]): string {
  for (const p of candidates) {
    if (p.startsWith('/') && existsSync(p)) return p
  }
  return candidates[0]
}

export interface PdfImport {
  doc: PMNode
  assets: ImportedAsset[]
  warnings: string[]
  doi: string | null
  pmid: string | null
  pageCount: number
}

export class PdfImportError extends Error {}

/**
 * 高保真 PDF 导入：
 * 1. 使用 poppler 的 pdftoppm 将 PDF 页面高分辨率（150 DPI）切片渲染为高清 PNG 资产；
 * 2. 同时使用 pdftotext 提取结构化文字层（段落、各级章节标题），保证文献检索与 AI 随航；
 * 3. 页面以原版高保真视图 (figure) + 结构化可编辑文本双层并存呈现，保全公式、图表、排版与原始影像；
 * 4. 自动检测医学 DOI 与 PMID。
 */
export async function importPdf(bytes: Uint8Array, filename: string): Promise<PdfImport> {
  const dir = mkdtempSync(join(tmpdir(), 'heurion-pdf-import-'))
  const assets: ImportedAsset[] = []
  const warnings: string[] = []
  const baseName = filename.replace(/\.pdf$/i, '').trim() || '文档'

  try {
    const file = join(dir, 'in.pdf')
    writeFileSync(file, bytes)

    const binPpm = resolveBinary(PDFTOPPM_CANDIDATES)
    const binTxt = resolveBinary(PDFTOTEXT_CANDIDATES)

    // 1. 切片渲染高清页面图
    let rendered = false
    try {
      await run(binPpm, ['-png', '-r', '150', file, join(dir, 'page')], {
        timeout: 180_000,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
      })
      rendered = true
    } catch (err) {
      warnings.push(`PDF 高清切片渲染提示：${(err as Error).message.slice(0, 100)}`)
    }

    const pagePngs = rendered
      ? readdirSync(dir)
          .filter(f => /^page-\d+\.png$/.test(f))
          .sort((a, b) => {
            const na = parseInt(a.replace(/^page-/, '').replace(/\.png$/, ''), 10)
            const nb = parseInt(b.replace(/^page-/, '').replace(/\.png$/, ''), 10)
            return na - nb
          })
      : []

    for (const [i, pngFile] of pagePngs.entries()) {
      const pageNum = i + 1
      const key = `pdf_page_${pageNum}`
      const imgBytes = readFileSync(join(dir, pngFile))
      assets.push({
        key,
        name: `${baseName}_p${pageNum}.png`,
        mime: 'image/png',
        bytes: new Uint8Array(imgBytes),
      })
    }

    // 2. 提取文字层
    let rawPages: string[] = []
    try {
      const { stdout } = await run(binTxt, ['-enc', 'UTF-8', file, '-'], {
        maxBuffer: 256 * 1024 * 1024,
        timeout: 120_000,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
      })
      rawPages = stdout.split('\f')
      if (rawPages.length > 1 && rawPages.at(-1)!.trim() === '') rawPages.pop()
    } catch (err) {
      warnings.push(`PDF 文字层抽取提示：${(err as Error).message.slice(0, 100)}`)
    }

    // 3. 元数据检测 (DOI / PMID)
    const head = (rawPages[0] || '') + '\n' + (rawPages[1] || '')
    const doi = /\b(10\.\d{4,9}\/[^\s"<>,;]+[^\s"<>,;.)\]])/i.exec(head)?.[1] ?? null
    const pmid = /\bPMID:?\s*(\d{6,9})\b/i.exec(head)?.[1] ?? null

    const totalPages = Math.max(pagePngs.length, rawPages.length)
    if (totalPages === 0) {
      const raw = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('（该 PDF 内容为空）')])])
      return { doc: assignIds(raw, new Set()), assets, warnings, doi, pmid, pageCount: 0 }
    }

    // 4. 构建结构化 ProseMirror 节点
    const blocks: PMNode[] = []
    blocks.push(schema.node('heading', { level: 1 }, [schema.text(baseName)]))

    for (let p = 0; p < totalPages; p++) {
      const pageNum = p + 1

      // 插入高保真页面视图
      if (p < pagePngs.length) {
        const key = `pdf_page_${pageNum}`
        blocks.push(
          schema.node('figure', {
            asset_id: key,
            alt: `第 ${pageNum} 页 原版高保真视图`,
            caption: `第 ${pageNum} 页 · 原版视图与图表`,
          })
        )
      }

      // 插入该页结构化文本
      const pageText = rawPages[p] || ''
      const paras = pageText.split(/\n{2,}/).map(t => t.trim()).filter(Boolean)
      for (const text of paras) {
        const isSection =
          text.length < 80 &&
          !/[。！？.!?]$/.test(text) &&
          /^(第[一二三四五六七八九十0-9]+[章节部分]|Abstract|Introduction|Background|Methods?|Materials?|Results?|Discussion|Conclusions?|References|Acknowledgments|Appendix|摘要|前言|背景|方法|材料|结果|讨论|结论|参考文献|致谢|附录|[0-9]+(\.[0-9]+)*\s+[A-Za-z\u4e00-\u9fa5])/i.test(
            text
          )

        if (isSection) {
          blocks.push(schema.node('heading', { level: 2 }, [schema.text(text)]))
        } else {
          blocks.push(schema.node('paragraph', null, [schema.text(text)]))
        }
      }
    }

    if (blocks.length === 1) {
      blocks.push(schema.node('paragraph', null, [schema.text('（未检测到文本或切片页面）')]))
    }

    const rawDoc = schema.node('doc', null, blocks)
    const doc = assignIds(rawDoc, new Set())

    return {
      doc,
      assets,
      warnings,
      doi,
      pmid,
      pageCount: totalPages,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
