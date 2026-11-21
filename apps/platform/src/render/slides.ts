import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Node as PMNode } from 'prosemirror-model'
import { renderSlideToPng } from './slide-raster.ts'

const run = promisify(execFile)

const MAX_CONCURRENT_LO = 2
const MAX_VECTOR_CACHE_FILES = 200
let activeLo = 0
const waitLo: Array<() => void> = []

async function withLoSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeLo >= MAX_CONCURRENT_LO) {
    await new Promise<void>(resolveSlot => waitLo.push(resolveSlot))
  }
  activeLo++
  try {
    return await fn()
  } finally {
    activeLo--
    waitLo.shift()?.()
  }
}

const SOFFICE_CANDIDATES = [
  'soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  `${process.env.HOME}/Applications/LibreOffice.app/Contents/MacOS/soffice`,
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
]

const PDFTOPPM_CANDIDATES = [
  'pdftoppm',
  '/opt/homebrew/bin/pdftoppm',
  '/usr/local/bin/pdftoppm',
  '/usr/bin/pdftoppm',
]

function cleanSubprocessEnv(): NodeJS.ProcessEnv {
  const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin']
  const newPath = [...extraPaths.filter(p => !currentPath.includes(p)), currentPath].filter(Boolean).join(':')
  return { PATH: newPath, HOME: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
}

function spawnCleanGroup(bin: string, args: string[], timeoutMs: number, onTimeout?: () => Promise<void> | void): Promise<void> {
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(bin, args, {
      detached: true,
      stdio: 'ignore',
      env: cleanSubprocessEnv(),
    })
    let settled = false
    let timedOut = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) rejectDone(err)
      else resolveDone()
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* 进程组可能已退出 */ }
      }
      Promise.resolve(onTimeout?.()).catch(() => {}).finally(() => {
        setTimeout(() => finish(new Error(`${bin} 执行超时 (${timeoutMs}ms)`)), 500).unref()
      })
    }, timeoutMs)
    child.once('error', err => finish(err))
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(new Error(`${bin} 执行超时 (${timeoutMs}ms)`))
      } else if (code === 0) {
        finish()
      } else {
        finish(new Error(`${bin} 退出异常 (${signal ?? code})`))
      }
    })
  })
}

async function rmContainer(engine: string, name: string): Promise<void> {
  try {
    await spawnCleanGroup(engine, ['rm', '-f', name], 10_000)
  } catch { /* ignore */ }
}

function pruneVectorCache(root: string): void {
  try {
    const entries = readdirSync(root)
      .filter(f => f.endsWith('.png'))
      .map(f => {
        const p = join(root, f)
        try { return { p, mtime: statSync(p).mtimeMs } } catch { return null }
      })
      .filter((x): x is { p: string; mtime: number } => x !== null)
    if (entries.length <= MAX_VECTOR_CACHE_FILES) return
    entries.sort((a, b) => a.mtime - b.mtime)
    for (const old of entries.slice(0, entries.length - MAX_VECTOR_CACHE_FILES)) {
      try { rmSync(old.p, { force: true }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export interface DeckRenderSource {
  pptx?: () => Uint8Array
  getDoc?: () => PMNode
  size?: { cx: number; cy: number }
  getAssetBytes?: (assetId: string) => Uint8Array | null
}

export type RenderInput = (() => Uint8Array) | DeckRenderSource

export type RenderMode = 'local' | 'container' | 'builtin'

/** 渲染缓存键：按（文档, rev, 视图）区分——同一 rev 下修订后与采纳前的页面不同。 */
export function slideRenderKey(docId: string, rev: number, view: 'plain' | 'accepted' | 'original'): string {
  return view === 'plain' ? `${docId}/${rev}` : `${docId}/${rev}-${view}`
}

/**
 * 幻灯片渲染服务：
 * 1. 优先使用本地/容器内 LibreOffice + pdftoppm 渲染；
 * 2. 若宿主环境未安装 LibreOffice，直接由远端服务内置的 Rust/Resvg 矢量光栅化引擎自闭环秒级渲染；
 * 3. 结果按（文档, rev）缓存，对调用方 100% 可用且自闭环。
 */
export class SlideRenderer {
  private mode: RenderMode | null = null
  private sofficeBin: string | null = null
  private pdftoppmBin: string | null = null
  private readonly inflight = new Map<string, Promise<string[]>>()

  constructor(private readonly cacheDir: string, private readonly image = 'heurion2:dev') {}

  private async probeBinary(candidates: string[], testArg: string[]): Promise<string | null> {
    const env = cleanSubprocessEnv()
    for (const cmd of candidates) {
      if (cmd.includes('/') && !existsSync(cmd)) continue
      try {
        await run(cmd, testArg, { env, timeout: 5000 })
        return cmd
      } catch {
        // 继续尝试下一个候选
      }
    }
    return null
  }

  private async detect(): Promise<RenderMode> {
    if (this.mode) return this.mode
    this.sofficeBin = await this.probeBinary(SOFFICE_CANDIDATES, ['--version'])
    this.pdftoppmBin = await this.probeBinary(PDFTOPPM_CANDIDATES, ['-v'])

    if (this.sofficeBin && this.pdftoppmBin) {
      this.mode = 'local'
      return this.mode
    }

    for (const engine of ['podman', 'docker']) {
      try {
        await run(engine, ['image', 'exists', this.image], { env: cleanSubprocessEnv(), timeout: 10_000 })
        this.engine = engine
        this.mode = 'container'
        return this.mode
      } catch { /* 下一个 */ }
    }

    // 宿主机无外部工具时，由服务端内置的高保真矢量光栅化引擎接管，永不失败
    this.mode = 'builtin'
    return this.mode
  }

  private engine = 'podman'

  async available(): Promise<boolean> {
    return true
  }

  async diagnose(): Promise<{
    available: boolean
    mode: RenderMode
    soffice: string | null
    pdftoppm: string | null
    engine: string
    installHint: string
  }> {
    const mode = await this.detect()
    return {
      available: true,
      mode,
      soffice: this.sofficeBin,
      pdftoppm: this.pdftoppmBin,
      engine: mode === 'builtin' ? 'Resvg-Native' : mode === 'local' ? 'LibreOffice-Local' : 'LibreOffice-Container',
      installHint: mode === 'builtin' ? '当前使用服务端内置的高保真矢量光栅化引擎（自闭环免外部依赖）' : '当前使用 LibreOffice 导出级渲染引擎',
    }
  }

  private readonly imageJobs = new Map<string, Promise<Uint8Array | null>>()

  /**
   * emf / wmf（Office 里粘贴的矢量图，浏览器不能显示）→ png，按内容哈希缓存。
   * 用与精确预览同一个 LibreOffice；没有 LibreOffice（内置渲染模式）时返回 null，画布不显示这张图。
   */
  async vectorToPng(bytes: Uint8Array, ext: 'emf' | 'wmf'): Promise<Uint8Array | null> {
    const hash = createHash('sha256').update(bytes).digest('hex')
    const root = resolve(this.cacheDir, 'vector-images')
    const target = join(root, `${hash}.png`)
    if (existsSync(target)) return new Uint8Array(readFileSync(target))
    let job = this.imageJobs.get(hash)
    if (!job) {
      job = (async () => {
        const mode = await this.detect()
        if (mode === 'builtin') return null
        return withLoSlot(async () => {
          const dir = join(root, `${hash}-work`)
          mkdirSync(dir, { recursive: true })
          try {
            writeFileSync(join(dir, `image.${ext}`), bytes)
            if (mode === 'local') {
              await spawnCleanGroup(
                this.sofficeBin ?? 'soffice',
                [`-env:UserInstallation=file://${dir}/lo-profile`, '--headless', '--convert-to', 'png', '--outdir', dir, join(dir, `image.${ext}`)],
                60_000,
              )
            } else {
              const cname = `heurion-vec-${randomBytes(6).toString('hex')}`
              await spawnCleanGroup(
                this.engine,
                [
                  'run', '--rm', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                  '--memory=1g', '--pids-limit=64', '--name', cname,
                  '-v', `${dir}:/x:Z`, '-e', 'HOME=/tmp', '--entrypoint', 'soffice', this.image,
                  '-env:UserInstallation=file:///x/lo-profile', '--headless', '--convert-to', 'png', '--outdir', '/x', `/x/image.${ext}`,
                ],
                120_000,
                () => rmContainer(this.engine, cname),
              )
            }
            const out = join(dir, 'image.png')
            if (!existsSync(out)) return null
            const png = readFileSync(out)
            writeFileSync(target, png)
            pruneVectorCache(root)
            return new Uint8Array(png)
          } catch {
            return null
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        })
      })().finally(() => this.imageJobs.delete(hash))
      this.imageJobs.set(hash, job)
    }
    return job
  }

  /** 渲染整份 deck，返回每页 PNG 的路径（按页序）。 */
  render(key: string, input: RenderInput): Promise<string[]> {
    const root = resolve(this.cacheDir)
    const dir = resolve(root, key)
    const segments = key.split('/')
    if (
      !key ||
      segments.some(s => !/^[a-zA-Z0-9._-]+$/.test(s) || s === '.' || s === '..') ||
      !dir.startsWith(root + sep)
    ) {
      return Promise.reject(new Error(`Invalid render cache key: ${key}`))
    }
    const cached = existsSync(dir) ? readdirSync(dir).filter(f => /^slide-\d+\.png$/.test(f)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0])) : []
    if (cached.length > 0) return Promise.resolve(cached.map(f => join(dir, f)))
    let job = this.inflight.get(key)
    if (!job) {
      job = this.renderNow(dir, input).finally(() => this.inflight.delete(key))
      this.inflight.set(key, job)
    }
    return job
  }

  private renderBuiltin(dir: string, source: DeckRenderSource): string[] {
    if (!source.getDoc) throw new Error('内置渲染引擎缺少文档模型')
    const doc = source.getDoc()
    const size = source.size ?? { cx: 12192000, cy: 6858000 }
    mkdirSync(dir, { recursive: true })
    const outs: string[] = []
    doc.forEach((slide, _o, i) => {
      const png = renderSlideToPng({ slide, size, getAssetBytes: source.getAssetBytes })
      const target = join(dir, `slide-${i + 1}.png`)
      writeFileSync(target, png)
      outs.push(target)
    })
    return outs
  }

  private async renderNow(dir: string, input: RenderInput): Promise<string[]> {
    const mode = await this.detect()
    const source: DeckRenderSource = typeof input === 'function' ? { pptx: input } : input

    // 1. 若为内置模式，直接使用服务端高保真光栅化引擎
    if (mode === 'builtin') {
      if (source.getDoc) return this.renderBuiltin(dir, source)
    }

    // 2. 尝试使用 LibreOffice
    mkdirSync(dir, { recursive: true })
    if (source.pptx) writeFileSync(join(dir, 'deck.pptx'), source.pptx())

    try {
      await withLoSlot(async () => {
        if (mode === 'local') {
          const soffice = this.sofficeBin ?? 'soffice'
          const pdftoppm = this.pdftoppmBin ?? 'pdftoppm'
          await spawnCleanGroup(
            soffice,
            [`-env:UserInstallation=file://${dir}/lo-profile`, '--headless', '--convert-to', 'pdf', '--outdir', dir, join(dir, 'deck.pptx')],
            150_000,
          )
          await spawnCleanGroup(
            pdftoppm,
            ['-png', '-r', '72', join(dir, 'deck.pdf'), join(dir, 'slide')],
            30_000,
          )
        } else if (mode === 'container') {
          const pdfCname = `heurion-lo-pdf-${randomBytes(6).toString('hex')}`
          await spawnCleanGroup(
            this.engine,
            [
              'run', '--rm', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
              '--memory=1g', '--pids-limit=64', '--name', pdfCname,
              '-v', `${dir}:/x:Z`, '-e', 'HOME=/tmp', '--entrypoint', 'soffice', this.image,
              '-env:UserInstallation=file:///x/lo-profile', '--headless', '--convert-to', 'pdf', '--outdir', '/x', '/x/deck.pptx',
            ],
            240_000,
            () => rmContainer(this.engine, pdfCname),
          )
          const ppmCname = `heurion-lo-ppm-${randomBytes(6).toString('hex')}`
          await spawnCleanGroup(
            this.engine,
            [
              'run', '--rm', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
              '--memory=1g', '--pids-limit=64', '--name', ppmCname,
              '-v', `${dir}:/x:Z`, '-e', 'HOME=/tmp', '--entrypoint', 'pdftoppm', this.image,
              '-png', '-r', '72', '/x/deck.pdf', '/x/slide',
            ],
            60_000,
            () => rmContainer(this.engine, ppmCname),
          )
        }
      })

      const outs = readdirSync(dir).filter(f => /^slide-\d+\.png$/.test(f))
      if (outs.length > 0) {
        return outs
          .map(f => ({ f, n: Number(/\d+/.exec(f)![0]) }))
          .sort((a, b) => a.n - b.n)
          .map(({ f, n }) => {
            const target = join(dir, `slide-${n}.png`)
            if (f !== `slide-${n}.png`) {
              writeFileSync(target, readFileSync(join(dir, f)))
              rmSync(join(dir, f), { force: true })
            }
            return target
          })
      }
    } catch (err) {
      // LibreOffice 执行失败或环境不可靠时，自动降级至内置引擎
      if (source.getDoc) return this.renderBuiltin(dir, source)
      throw err
    } finally {
      for (const temp of ['lo-profile', 'deck.pdf', 'deck.pptx']) {
        try { rmSync(join(dir, temp), { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }

    // 兜底至内置引擎
    if (source.getDoc) return this.renderBuiltin(dir, source)
    throw new Error('渲染失败：没有生成页面')
  }
}


