/**
 * DrawingML 颜色解析（只做显示用，服务端与画布共用；不依赖 DOM，按正则读 XML 片段）。
 *
 * 支持 srgbClr / schemeClr / prstClr / sysClr / scrgbClr，以及常见的亮度修饰 lumMod、lumOff、tint、shade。
 * 主题色（schemeClr）按「主题配色 + 母版 clrMap」解析：scheme 里既有 dk1 / lt1 / accent1…，也有映射后的 tx1 / bg1 / tx2 / bg2。
 */

export type SchemeColors = Record<string, string>

/** PowerPoint 常见的预设颜色名（prstClr）。 */
const PRESET: Record<string, string> = {
  white: 'FFFFFF', black: '000000', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00',
  gray: '808080', grey: '808080', lightGray: 'D3D3D3', darkGray: 'A9A9A9', silver: 'C0C0C0', orange: 'FFA500',
  purple: '800080', navy: '000080', teal: '008080', maroon: '800000', olive: '808000', lime: '00FF00',
  aqua: '00FFFF', cyan: '00FFFF', fuchsia: 'FF00FF', magenta: 'FF00FF', brown: 'A52A2A', pink: 'FFC0CB',
  gold: 'FFD700', darkBlue: '00008B', darkRed: '8B0000', darkGreen: '006400', ltGray: 'D3D3D3', dkGray: 'A9A9A9',
}

const COLOR_EL = /<a:(srgbClr|schemeClr|prstClr|sysClr|scrgbClr)\b([^>]*?)(\/>|>([\s\S]*?)<\/a:\1>)/

/** 颜色元素（srgbClr 等）的 6 位十六进制；解析不了返回 null。 */
export function colorOf(xml: string | null | undefined, scheme: SchemeColors = {}): string | null {
  if (!xml) return null
  const m = COLOR_EL.exec(xml)
  if (!m) return null
  const [, kind, attrs, , body = ''] = m
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs!)?.[1]
  let base: string | null = null
  if (kind === 'srgbClr') base = attr('val') ?? null
  else if (kind === 'schemeClr') base = scheme[attr('val') ?? ''] ?? null
  else if (kind === 'prstClr') base = PRESET[attr('val') ?? ''] ?? null
  else if (kind === 'sysClr') base = attr('lastClr') ?? (attr('val') === 'window' ? 'FFFFFF' : attr('val') === 'windowText' ? '000000' : null)
  else if (kind === 'scrgbClr') {
    const ch = (n: string) => Math.round(Math.max(0, Math.min(100000, Number(attr(n) ?? 0))) / 100000 * 255)
    base = [ch('r'), ch('g'), ch('b')].map(v => v.toString(16).padStart(2, '0')).join('')
  }
  if (!base || !/^[0-9A-Fa-f]{6}$/.test(base)) return null
  return applyMods(base.toUpperCase(), body)
}

/** 填充元素里（solidFill 等）的颜色：取 solidFill；渐变取第一个色标。 */
export function fillColorOf(xml: string | null | undefined, scheme: SchemeColors = {}): string | null {
  if (!xml) return null
  const solid = /<a:solidFill\b[^>]*>([\s\S]*?)<\/a:solidFill>/.exec(xml)
  if (solid) return colorOf(solid[1], scheme)
  const grad = /<a:gs\b[^>]*>([\s\S]*?)<\/a:gs>/.exec(xml)
  if (grad) return colorOf(grad[1], scheme)
  return null
}

/** 文字段属性（a:rPr / a:defRPr）的文字颜色：去掉轮廓线、效果、高亮里的颜色后取填充色。 */
export function textColorOf(rpr: string | null | undefined, scheme: SchemeColors = {}): string | null {
  if (!rpr) return null
  const own = rpr
    .replace(/<a:ln\b[\s\S]*?<\/a:ln>/g, '')
    .replace(/<a:effectLst\b[\s\S]*?<\/a:effectLst>/g, '')
    .replace(/<a:highlight\b[\s\S]*?<\/a:highlight>/g, '')
  return fillColorOf(own, scheme)
}

/** Wingdings 等符号字体里常用作项目符号的字符 → 对应的 Unicode 字符。 */
const SYMBOL_BULLETS: Record<string, string> = { 'Ø': '➢', 'l': '●', 'n': '■', 'q': '❑', 'ü': '✔', '§': '■', 'v': '❖', 'Ÿ': '•', 'è': '➔', 'à': '➔', 'Ü': '➢', 'p': '□', 'u': '◆' }

/**
 * 段落属性（a:pPr / a:lvl1pPr）规定的项目符号：'' 表示不要符号（buNone），字符表示用它，undefined 表示没写（沿用版式 / 母版）。
 * 自动编号（buAutoNum）没法在单段里算出序号，按不显示处理。
 */
export function bulletOf(ppr: string | null | undefined): string | undefined {
  if (!ppr) return undefined
  if (/<a:buNone\b/.test(ppr) || /<a:buAutoNum\b/.test(ppr)) return ''
  const ch = /<a:buChar\b[^>]*\bchar="([^"]*)"/.exec(ppr)?.[1]
  if (ch === undefined) return undefined
  const char = ch.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  const font = /<a:buFont\b[^>]*\btypeface="([^"]*)"/.exec(ppr)?.[1] ?? ''
  return /wingdings|symbol/i.test(font) || ['Ø', '§', 'ü', 'Ÿ', 'è', 'Ü'].includes(char) ? (SYMBOL_BULLETS[char] ?? '•') : char
}

function applyMods(hex: string, body: string): string {
  if (!body) return hex
  let [h, s, l] = rgbToHsl(hex)
  let rgb: [number, number, number] | null = null
  const val = (name: string) => { const m = new RegExp(`<a:${name}\\s+val="(-?\\d+)"`).exec(body); return m ? Number(m[1]) / 100000 : null }
  const lumMod = val('lumMod')
  const lumOff = val('lumOff')
  if (lumMod !== null || lumOff !== null) l = Math.max(0, Math.min(1, l * (lumMod ?? 1) + (lumOff ?? 0)))
  rgb = hslToRgb(h, s, l)
  const tint = val('tint')
  const shade = val('shade')
  if (tint !== null) rgb = rgb.map(c => c + (255 - c) * (1 - tint)) as [number, number, number]
  if (shade !== null) rgb = rgb.map(c => c * shade) as [number, number, number]
  return rgb.map(c => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('').toUpperCase()
}

function rgbToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex, 16)
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}
