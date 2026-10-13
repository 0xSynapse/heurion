import type { Node as PMNode } from 'prosemirror-model'
import { DECK_THEMES, DEFAULT_THEME, resolveColor } from '../model/deck-themes.ts'
import { renderSvg } from './diagram.ts'

export interface ChartData {
  type: string
  title?: string
  categories: string[];
  series: Array<{ name: string; values: Array<number | null> }>
  colors?: string[]
}

const CHART_COLORS = ['0EA5E9', 'F59E0B', '10B981', '8B5CF6', 'EF4444', '64748B']

const toHex = (c: string | null | undefined, fallback = '#000000'): string => {
  if (!c || c === 'none') return 'none'
  return c.startsWith('#') ? c : `#${c}`
}

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export function chartSvg(c: ChartData, w: number, h: number): string {
  const color = (i: number) => toHex(c.colors?.[i] || CHART_COLORS[i % CHART_COLORS.length])
  const fs = Math.max(8, Math.min(14, h / 22))
  const titleH = c.title ? fs * 1.8 : 0
  const legendH = fs * 1.8
  const title = c.title
    ? `<text x="${w / 2}" y="${fs * 1.3}" font-size="${fs * 1.1}" font-weight="600" text-anchor="middle" fill="currentColor">${esc(c.title)}</text>`
    : ''
  const round = c.type === 'pie' || c.type === 'doughnut'
  const legendItems = round ? c.categories : c.series.map(s => s.name)
  const itemW = Math.min(90, w / Math.max(1, legendItems.length))
  const legend = legendItems
    .map((name, i) => {
      const x = w / 2 - (legendItems.length * itemW) / 2 + i * itemW
      return `<rect x="${x}" y="${h - legendH + fs * 0.3}" width="${fs * 0.8}" height="${fs * 0.8}" fill="${color(i)}"/><text x="${x + fs}" y="${h - legendH + fs * 1.05}" font-size="${fs * 0.85}" fill="currentColor">${esc(name.slice(0, 10))}</text>`
    })
    .join('')
  const top = titleH + fs * 0.5
  const bottom = h - legendH
  let body = ''
  if (round) {
    const values = (c.series[0]?.values ?? []).map(v => Math.max(0, v ?? 0))
    const total = values.reduce((a, b) => a + b, 0) || 1
    const r = Math.max(4, Math.min(w, bottom - top) / 2 - 4)
    const cx = w / 2
    const cy = (top + bottom) / 2
    let angle = -Math.PI / 2
    body = values
      .map((v, i) => {
        const a2 = angle + (v / total) * Math.PI * 2
        const large = a2 - angle > Math.PI ? 1 : 0
        const p1 = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
        const p2 = [cx + r * Math.cos(a2), cy + r * Math.sin(a2)]
        angle = a2
        if (v >= total) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color(i)}"/>`
        return `<path d="M${cx},${cy} L${p1[0]},${p1[1]} A${r},${r} 0 ${large} 1 ${p2[0]},${p2[1]} Z" fill="${color(i)}" stroke="#fff" stroke-width="1"/>`
      })
      .join('')
    if (c.type === 'doughnut') body += `<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="#fff"/>`
  } else {
    const all = c.series.flatMap(s => s.values).filter((v): v is number => v !== null)
    const max = Math.max(0, ...all)
    const min = Math.min(0, ...all)
    const span = max - min || 1
    const left = fs * 3
    const plotW = w - left - fs
    const plotH = bottom - top - fs * 1.6
    const n = c.categories.length || 1
    const horizontal = c.type === 'bar'
    const y = (v: number) => top + plotH - ((v - min) / span) * plotH
    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map(f => {
        const v = min + span * f
        const yy = y(v)
        return horizontal
          ? ''
          : `<line x1="${left}" x2="${w - fs}" y1="${yy}" y2="${yy}" stroke="currentColor" stroke-opacity=".12"/><text x="${left - 4}" y="${yy + fs * 0.35}" font-size="${fs * 0.8}" text-anchor="end" fill="currentColor" fill-opacity=".7">${+v.toFixed(2)}</text>`
      })
      .join('')
    const labels = c.categories
      .map((cat, ci) =>
        horizontal
          ? `<text x="${left - 4}" y="${top + (ci + 0.5) * (plotH / n) + fs * 0.35}" font-size="${fs * 0.8}" text-anchor="end" fill="currentColor">${esc(cat.slice(0, 8))}</text>`
          : `<text x="${left + (ci + 0.5) * (plotW / n)}" y="${top + plotH + fs * 1.2}" font-size="${fs * 0.8}" text-anchor="middle" fill="currentColor">${esc(cat.slice(0, 10))}</text>`,
      )
      .join('')
    if (c.type === 'line' || c.type === 'area') {
      body = c.series
        .map((s, si) => {
          const pts = s.values
            .map((v, ci) => (v === null ? null : ([left + (ci + 0.5) * (plotW / n), y(v)] as const)))
            .filter((p): p is readonly [number, number] => !!p)
          if (pts.length === 0) return ''
          const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ')
          const area =
            c.type === 'area'
              ? `<path d="${line} L${pts.at(-1)![0]},${y(Math.max(min, 0))} L${pts[0]![0]},${y(Math.max(min, 0))} Z" fill="${color(si)}" fill-opacity=".35"/>`
              : ''
          return `${area}<path d="${line}" fill="none" stroke="${color(si)}" stroke-width="2"/>${c.type === 'line' ? pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="${color(si)}"/>`).join('') : ''}`
        })
        .join('')
    } else {
      const groupW = (horizontal ? plotH : plotW) / n
      const barW = (groupW * 0.75) / Math.max(1, c.series.length)
      const zero = horizontal ? left + ((0 - min) / span) * plotW : y(0)
      body = c.categories
        .map((_, ci) =>
          c.series
            .map((s, si) => {
              const v = s.values[ci]
              if (v === null || v === undefined) return ''
              const offset = ci * groupW + groupW * 0.125 + si * barW
              if (horizontal) {
                const x2 = left + ((v - min) / span) * plotW
                return `<rect x="${Math.min(zero, x2)}" y="${top + offset}" width="${Math.abs(x2 - zero)}" height="${barW * 0.9}" fill="${color(si)}"/>`
              }
              const yy = y(v)
              return `<rect x="${left + offset}" y="${Math.min(zero, yy)}" width="${barW * 0.9}" height="${Math.abs(zero - yy)}" fill="${color(si)}"/>`
            })
            .join(''),
        )
        .join('')
    }
    body = grid + body + labels
  }
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${title}${body}${legend}</svg>`
}

/** 简单的文本拆行（支持中英文混合按宽度截断）。 */
function wrapLines(text: string, maxW: number, fontSize: number): string[] {
  if (!text) return []
  const paragraphs = text.split('\n')
  const result: string[] = []
  for (const p of paragraphs) {
    if (!p) {
      result.push('')
      continue
    }
    let current = ''
    let curW = 0
    for (const ch of p) {
      const chW = /[⺀-￯]/.test(ch) ? fontSize : fontSize * 0.58
      if (curW + chW > maxW && current.length > 0) {
        result.push(current)
        current = ch
        curW = chW
      } else {
        current += ch
        curW += chW
      }
    }
    if (current) result.push(current)
  }
  return result
}

export interface RenderSlideOptions {
  slide: PMNode
  size: { cx: number; cy: number }
  theme?: string
  getAssetBytes?: (assetId: string) => Uint8Array | null
}

const PH_SIZE: Record<string, number> = { title: 38, ctrTitle: 42, subTitle: 22, body: 18 }

/** 将 ProseMirror slide 转换为自包含的标准 SVG。 */
export function renderSlideToSvg(opts: RenderSlideOptions): string {
  const { slide, size } = opts
  const W = Math.round(size.cx / 12700)
  const H = Math.round(size.cy / 12700)
  const themeName = (slide.attrs?.theme as string) || opts.theme || DEFAULT_THEME
  const theme = DECK_THEMES[themeName] ?? DECK_THEMES[DEFAULT_THEME]!

  let bgHex = theme.bg
  if (slide.attrs?.bg) {
    const resolved = resolveColor(slide.attrs.bg as string, themeName)
    if (resolved && resolved !== 'none') bgHex = resolved
  }

  const elements: string[] = []
  elements.push(`<rect width="${W}" height="${H}" fill="${toHex(bgHex)}"/>`)

  slide.forEach(shape => {
    if (shape.type.name !== 'shape') return
    const a = shape.attrs
    const x = Math.round((a.x as number) / 12700)
    const y = Math.round((a.y as number) / 12700)
    const w = Math.round((a.w as number) / 12700)
    const h = Math.round((a.h as number) / 12700)
    if (w <= 0 || h <= 0) return

    const rot = a.rot ? (a.rot as number) / 60000 : 0
    const rotAttr = rot ? ` transform="rotate(${rot} ${x + w / 2} ${y + h / 2})"` : ''

    // 1. 形状底色与几何
    let fill = a.fill ? resolveColor(a.fill as string, themeName) : null
    if (!fill && a.kind === 'shape') fill = theme.surface
    const hasFill = fill && fill !== 'none'

    let geomSvg = ''
    if (hasFill) {
      if (a.geom === 'ellipse') {
        geomSvg = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${toHex(fill)}" stroke="none"/>`
      } else if (a.geom === 'roundRect') {
        const radius = Math.min(w, h) * 0.16
        geomSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${toHex(fill)}" stroke="none"/>`
      } else {
        geomSvg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${toHex(fill)}" stroke="none"/>`
      }
    }
    if (geomSvg) elements.push(`<g${rotAttr}>${geomSvg}</g>`)

    // 2. 图片
    if (a.kind === 'image' && a.asset_id) {
      const bytes = opts.getAssetBytes?.(a.asset_id as string)
      if (bytes && bytes.length > 0) {
        const b64 = Buffer.from(bytes).toString('base64')
        elements.push(
          `<g${rotAttr}><image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${b64}" preserveAspectRatio="xMidYMid meet"/></g>`,
        )
      } else {
        elements.push(
          `<g${rotAttr}><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${toHex(theme.surface)}" stroke="${toHex(theme.muted)}" stroke-dasharray="4 4"/><text x="${x + w / 2}" y="${y + h / 2}" font-size="14" fill="${toHex(theme.muted)}" text-anchor="middle" font-family="sans-serif">图片</text></g>`,
        )
      }
      return
    }

    // 3. 图表
    if (a.kind === 'chart' && a.chart) {
      const chartCode = chartSvg(a.chart as ChartData, w, h)
      elements.push(`<g transform="translate(${x}, ${y})"${rotAttr}>${chartCode}</g>`)
      return
    }

    // 4. 表格
    if (a.kind === 'table') {
      const tableNode = shape.firstChild
      if (tableNode) {
        const rowCount = tableNode.childCount
        const colCount = tableNode.firstChild?.childCount ?? 1
        const rowH = h / Math.max(1, rowCount)
        const colW = w / Math.max(1, colCount)
        const tableEls: string[] = []

        tableNode.forEach((row, _ro, ri) => {
          row.forEach((cell, _co, ci) => {
            const cx = x + ci * colW
            const cy = y + ri * rowH
            tableEls.push(
              `<rect x="${cx}" y="${cy}" width="${colW}" height="${rowH}" fill="${ri === 0 ? toHex(theme.surface) : 'none'}" stroke="${toHex(theme.muted)}" stroke-opacity="0.3"/>`,
            )
            const text = cell.textContent.trim()
            if (text) {
              const lines = wrapLines(text, colW - 8, 12)
              lines.slice(0, 3).forEach((line, li) => {
                tableEls.push(
                  `<text x="${cx + 6}" y="${cy + 16 + li * 14}" font-size="12" fill="${toHex(theme.body)}" font-family="sans-serif">${esc(line)}</text>`,
                )
              })
            }
          })
        })
        elements.push(`<g${rotAttr}>${tableEls.join('')}</g>`)
      }
      return
    }

    // 5. 文本内容
    const ph = a.ph as string | null
    const defaultFs = ph && PH_SIZE[ph] ? PH_SIZE[ph]! : 18
    const isTitle = ph === 'title' || ph === 'ctrTitle'
    const isCtr = ph === 'ctrTitle' || (theme.frame === 'center' && isTitle)
    const defaultColor = isTitle ? theme.title : theme.body
    const defaultWeight = isTitle ? '700' : '400'

    // 内边距
    const padX = 8
    const padY = 8
    const innerW = Math.max(20, w - padX * 2)

    let cursorY = y + padY + defaultFs

    const textEls: string[] = []

    shape.forEach(p => {
      if (p.type.name !== 'paragraph') return
      const pText = p.textContent.trim()
      if (!pText) return

      let fs = defaultFs
      let color = defaultColor
      let weight = defaultWeight

      // 检查段落文字级 marks
      p.forEach(inlineNode => {
        if (inlineNode.isText) {
          if (inlineNode.marks.some(m => m.type.name === 'bold')) weight = '700'
          const rpr = inlineNode.marks.find(m => m.type.name === 'rpr')?.attrs?.xml as string | undefined
          if (rpr) {
            const sz = /\ssz="(\d+)"/.exec(rpr)?.[1]
            if (sz) fs = Number(sz) / 100
            const cMatch = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(rpr)?.[1]
            if (cMatch) color = cMatch
          }
        }
      })

      const align = p.attrs?.align || (isCtr ? 'center' : 'left')
      const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
      const textX = align === 'center' ? x + w / 2 : align === 'right' ? x + w - padX : x + padX

      const lines = wrapLines(pText, innerW, fs)
      const lineH = Math.round(fs * 1.35)

      for (const line of lines) {
        if (cursorY > y + h) break
        textEls.push(
          `<text x="${textX}" y="${cursorY}" font-size="${fs}" font-weight="${weight}" fill="${toHex(color)}" text-anchor="${anchor}" font-family="sans-serif">${esc(line)}</text>`,
        )
        cursorY += lineH
      }
      cursorY += Math.round(fs * 0.4) // 段落间距
    })

    if (textEls.length > 0) {
      elements.push(`<g${rotAttr}>${textEls.join('')}</g>`)
    }
  })

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; }
    </style>
  </defs>
  ${elements.join('\n  ')}
</svg>`
}

/** 渲染一页 Slide 为高质量 PNG。 */
export function renderSlideToPng(opts: RenderSlideOptions, width = 1600): Uint8Array {
  const svg = renderSlideToSvg(opts)
  return renderSvg(svg, width, { maxBytes: 25 * 1024 * 1024 }).png
}
