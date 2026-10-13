import { Resvg } from '@resvg/resvg-js'

/**
 * AI 生成的示意图：模型写 SVG，平台渲染成 PNG（resvg，本地、不联网）存成资产，再插进文档或幻灯片。
 * 只接受自包含的 SVG：不许脚本、事件属性、foreignObject、外部引用（http / file 链接、外部图片）。
 */

export class DiagramError extends Error {}

const MAX_SVG = 512 * 1024

export function checkSvg(svg: string, maxBytes = MAX_SVG): void {
  if (svg.length > maxBytes) throw new DiagramError(`SVG 超过 ${Math.round(maxBytes / 1024)}KB`)
  if (!/<svg\b/i.test(svg)) throw new DiagramError('不是 SVG（缺少 <svg> 根元素）')
  if (/<script\b/i.test(svg)) throw new DiagramError('SVG 里不能有 <script>')
  if (/<foreignObject\b/i.test(svg)) throw new DiagramError('SVG 里不能有 <foreignObject>，文字请用 <text>')
  if (/\son[a-z]+\s*=/i.test(svg)) throw new DiagramError('SVG 里不能有事件属性（onclick 等）')
  // href / xlink:href 只能指向文档内部（#id）或内嵌 data: 图片
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    const v = m[1]!.trim()
    if (!v.startsWith('#') && !/^data:image\/(png|jpeg|gif|svg\+xml);/i.test(v)) throw new DiagramError(`SVG 引用了外部资源（${v.slice(0, 60)}），只能用文档内部引用或内嵌图片`)
  }
  if (/url\(\s*["']?(?!#)[^)]*\)/i.test(svg.replace(/url\(\s*["']?data:[^)]*\)/gi, ''))) throw new DiagramError('SVG 样式里引用了外部资源，只能用 url(#id)')
}

/** 渲染成 PNG；width 是输出像素宽度（高度按 SVG 比例）。 */
export function renderSvg(svg: string, width = 1600, opts?: { maxBytes?: number }): { png: Uint8Array; width: number; height: number } {
  checkSvg(svg, opts?.maxBytes)
  const w = Math.max(200, Math.min(4096, Math.round(width)))
  let r: Resvg
  try {
    r = new Resvg(svg, { fitTo: { mode: 'width', value: w }, background: 'rgba(255,255,255,0)', font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans CJK SC' } })
  } catch (err) {
    throw new DiagramError(`SVG 解析失败：${(err as Error).message.slice(0, 200)}`)
  }
  const out = r.render()
  return { png: new Uint8Array(out.asPng()), width: out.width, height: out.height }
}
