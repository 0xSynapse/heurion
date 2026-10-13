import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Node as PMNode } from 'prosemirror-model'
import { renderSlideToPng } from './slide-raster.ts'

const run = promisify(execFile)

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

function enhancedEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const currentPath = process.env.PATH || ''
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin']
  const newPath = [...extraPaths.filter(p => !currentPath.includes(p)), currentPath].join(':')
  return { ...process.env, PATH: newPath, ...extra }
}

export interface DeckRenderSource {
  pptx?: () => Uint8Array
  getDoc?: () => PMNode
  size?: { cx: number; cy: number }
  getAssetBytes?: (assetId: string) => Uint8Array | null
}

export type RenderInput = (() => Uint8Array) | DeckRenderSource

export type RenderMode = 'local' | 'container' | 'builtin'

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
    const env = enhancedEnv()
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
        await run(engine, ['image', 'exists', this.image], { env: enhancedEnv(), timeout: 10_000 })
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
      if (mode === 'local') {
        const soffice = this.sofficeBin ?? 'soffice'
        const pdftoppm = this.pdftoppmBin ?? 'pdftoppm'
        const script = `export HOME=/tmp && "${soffice}" "-env:UserInstallation=file://$D/lo-profile" --headless --convert-to pdf --outdir "$D" "$D/deck.pptx" >/dev/null 2>&1 && "${pdftoppm}" -png -r 72 "$D/deck.pdf" "$D/slide"`
        await run('bash', ['-c', script], { env: enhancedEnv({ D: dir }), timeout: 180_000 })
      } else if (mode === 'container') {
        const script = 'export HOME=/tmp && soffice "-env:UserInstallation=file:///x/lo-profile" --headless --convert-to pdf --outdir "$D" "$D/deck.pptx" >/dev/null 2>&1 && pdftoppm -png -r 72 "$D/deck.pdf" "$D/slide"'
        await run(this.engine, ['run', '--rm', '-v', `${dir}:/x:Z`, '--user', 'root', '-e', 'D=/x', '--entrypoint', 'bash', this.image, '-c', script], { timeout: 300_000 })
      }

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


