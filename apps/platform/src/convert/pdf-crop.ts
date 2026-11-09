import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { InlineImage } from '../harness/complete.ts'

const run = promisify(execFile)

/** 原版映射里的页：尺寸（转正后的显示方向）与解析时额外加的顺时针旋转 */
export interface MapPage { w: number; h: number; rot?: number }

function pdftoppm(): string {
  for (const p of ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/usr/bin/pdftoppm']) if (existsSync(p)) return p
  return 'pdftoppm'
}

/**
 * 原版映射的坐标（doc-parser 把竖排页转正后的显示方向）→ 原文件的显示方向（pdftoppm 按原文件的 /Rotate 渲染）。
 * rot 是转正时额外加的顺时针角度：转正后 (x', y') 与原来 (x, y) 的关系按 rot 反推。
 */
export function unrotateBox(box: number[], page: MapPage): number[] {
  const rot = ((page.rot ?? 0) % 360 + 360) % 360
  // 原文件显示方向的页面尺寸
  const W = rot === 90 || rot === 270 ? page.h : page.w
  const H = rot === 90 || rot === 270 ? page.w : page.h
  const back = (x: number, y: number): [number, number] =>
    rot === 90 ? [y, H - x] : rot === 270 ? [W - y, x] : rot === 180 ? [W - x, H - y] : [x, y]
  const [x1, y1] = back(box[0]!, box[1]!)
  const [x2, y2] = back(box[2]!, box[3]!)
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
}

/**
 * 审稿按页面图像核对表格的原料（PDF_ORIGINAL_VIEW.md §12.3）：表格块在原版上的区域裁成图（最多 3 页），
 * 外加区域里文字层的词（核对模型抄出的数字）。没有映射、块没有区域时返回 null。
 */
export function tableSourceProvider(pdf: Uint8Array, mapGz: Uint8Array): (nodeId: string) => Promise<{ images: InlineImage[]; words: string[] } | null> {
  let map: { pages?: MapPage[]; words?: Array<[number, number, number, number, number, string]>; nodes?: Record<string, { regions?: number[][]; rot?: number }> } | null = null
  return async nodeId => {
    if (!map) {
      const { gunzipSync } = await import('node:zlib')
      map = JSON.parse(gunzipSync(mapGz).toString('utf8'))
    }
    const regions = map!.nodes?.[nodeId]?.regions?.slice(0, 3) ?? []
    if (!regions.length) return null
    const inside = (w: [number, number, number, number, number, string]) => regions.some(([p, l, t, r, b]) => {
      const cx = (w[1] + w[3]) / 2, cy = (w[2] + w[4]) / 2
      return w[0] === p && cx >= l! - 1 && cx <= r! + 1 && cy >= t! - 1 && cy <= b! + 1
    })
    const words = (map!.words ?? []).filter(inside).map(w => w[5])
    const images = await renderRegions(pdf, regions, map!.pages ?? [], 4, map!.nodes?.[nodeId]?.rot ?? 0)
    return images.length ? { images, words } : null
  }
}

/** PNG 顺时针转 rot 度（用 resvg 渲染一张套着这张图的 SVG，不另装图像库） */
async function rotatePng(png: Buffer, rot: number): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js')
  const w = png.readUInt32BE(16)
  const h = png.readUInt32BE(20)
  const [W, H, tf] = rot === 90 ? [h, w, `translate(${h},0) rotate(90)`]
    : rot === 270 ? [h, w, `translate(0,${w}) rotate(270)`]
      : [w, h, `translate(${w},${h}) rotate(180)`]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">` +
    `<g transform="${tf}"><image width="${w}" height="${h}" xlink:href="data:image/png;base64,${png.toString('base64')}"/></g></svg>`
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'original' } }).render().asPng())
}

/**
 * 按区域（[页, 左, 上, 右, 下]，原版映射的坐标）从 PDF 裁出图像，转成正向。长边约 1400 像素（模型按自己的上限再缩放）。
 * 渲染失败的区域跳过；全部失败时返回空数组。
 */
export async function renderRegions(pdf: Uint8Array, regions: number[][], pages: MapPage[], pad = 4, blockRot = 0): Promise<InlineImage[]> {
  if (!regions.length) return []
  const dir = mkdtempSync(join(tmpdir(), 'heurion-crop-'))
  const out: InlineImage[] = []
  try {
    const file = join(dir, 'in.pdf')
    writeFileSync(file, pdf)
    for (const [k, [p, ...box]] of regions.entries()) {
      const page = pages[p! - 1]
      if (!page) continue
      const [l, t, r, b] = unrotateBox(box, page)
      const wPt = r! - l! + pad * 2
      const hPt = b! - t! + pad * 2
      if (wPt <= 2 || hPt <= 2) continue
      const dpi = Math.max(110, Math.min(300, Math.round((1400 / Math.max(wPt, hPt)) * 72)))
      const px = (v: number) => String(Math.max(0, Math.round((v * dpi) / 72)))
      const prefix = join(dir, `c${k}`)
      try {
        await run(pdftoppm(), ['-r', String(dpi), '-png', '-singlefile', '-f', String(p), '-l', String(p),
          '-x', px(l! - pad), '-y', px(t! - pad), '-W', px(wPt), '-H', px(hPt), file, prefix], { timeout: 60_000 })
        let png: Buffer = readFileSync(`${prefix}.png`)
        // 整页转正的角度，加上块自己的（横竖混排页上的竖排表）
        const rot = (((page.rot ?? 0) + blockRot) % 360 + 360) % 360
        if (rot) png = await rotatePng(png, rot)
        out.push({ mime: 'image/png', data: png.toString('base64') })
      } catch {
        /* 这一块渲染失败：跳过 */
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return out
}
