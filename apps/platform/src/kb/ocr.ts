import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createWorker } from 'tesseract.js'

const run = promisify(execFile)

const PDFTOPPM_CANDIDATES = [
  'pdftoppm',
  '/opt/homebrew/bin/pdftoppm',
  '/usr/local/bin/pdftoppm',
  '/usr/bin/pdftoppm',
]

function resolvePdftoppm(): string {
  for (const p of PDFTOPPM_CANDIDATES) {
    if (p.startsWith('/') && existsSync(p)) return p
  }
  return 'pdftoppm'
}

/** 给扫描页做 OCR：返回页码（1 起）→ 文字。onPage 报进度（第几页 / 共几页）。 */
export type Ocr = (pdf: Uint8Array, pages: number[], onPage?: (done: number, total: number) => void) => Promise<Map<number, string>>

/**
 * 本地 OCR（tesseract.js，简体中文 + 英文）：poppler 的 pdftoppm 把页面渲染成 200 dpi 的图，逐页识别。
 * 资料不出本机；语言模型第一次用时下载到 cacheDir，之后离线可用。
 */
export function localOcr(cacheDir: string, langs = 'chi_sim+eng'): Ocr {
  mkdirSync(cacheDir, { recursive: true })
  let workerPromise: ReturnType<typeof createWorker> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let activeTasks = 0

  const acquireWorker = () => {
    activeTasks++
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (!workerPromise) {
      workerPromise = createWorker(langs, 1, { cachePath: cacheDir }).catch(err => {
        workerPromise = null
        throw err
      })
    }
    return workerPromise
  }

  const releaseWorker = () => {
    activeTasks = Math.max(0, activeTasks - 1)
    if (activeTasks === 0 && workerPromise) {
      idleTimer = setTimeout(() => {
        const w = workerPromise
        workerPromise = null
        idleTimer = null
        if (w) void w.then(inst => inst.terminate()).catch(() => {})
      }, 60_000)
      idleTimer.unref?.()
    }
  }

  return async (pdf, pages, onPage) => {
    const out = new Map<number, string>()
    if (pages.length === 0) return out
    const dir = mkdtempSync(join(tmpdir(), 'heurion-ocr-'))
    const worker = await acquireWorker()
    try {
      const file = join(dir, 'in.pdf')
      writeFileSync(file, pdf)
      const bin = resolvePdftoppm()
      for (const [i, page] of pages.entries()) {
        await run(bin, ['-r', '200', '-gray', '-png', '-f', String(page), '-l', String(page), file, join(dir, `p${page}`)], {
          timeout: 120_000,
          env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
        })
        const img = readdirSync(dir).find(f => f.startsWith(`p${page}-`) || f === `p${page}.png`)
        if (img) {
          const { data } = await worker.recognize(join(dir, img))
          out.set(page, tidy(data.text))
          rmSync(join(dir, img), { force: true })
        }
        onPage?.(i + 1, pages.length)
      }
      return out
    } finally {
      releaseWorker()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** tesseract 在汉字之间加空格：去掉汉字（及中文标点）之间的空格。 */
export function tidy(text: string): string {
  const cjk = '[\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef]'
  return text.replace(new RegExp(`(${cjk}) +(?=${cjk})`, 'g'), '$1').replace(/[ \t]+\n/g, '\n').trim()
}

/** 图片 OCR（拍照的化验单）：tesseract 直接识别图片。 */
export type ImageOcr = (image: Uint8Array) => Promise<string>

export function localImageOcr(cacheDir: string, langs = 'chi_sim+eng'): ImageOcr {
  mkdirSync(cacheDir, { recursive: true })
  return async image => {
    const worker = await createWorker(langs, 1, { cachePath: cacheDir })
    try {
      const { data } = await worker.recognize(Buffer.from(image))
      return tidy(data.text)
    } finally {
      await worker.terminate()
    }
  }
}
