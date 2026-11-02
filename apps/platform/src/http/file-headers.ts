import type { MiddlewareHandler } from 'hono'

/**
 * 用户可控内容的下发策略。
 * 患者原件、归档图、导入文档里的媒体都来自用户或 AI，平台同源返回时若被当作 HTML/SVG 执行，
 * 脚本就能读到 localStorage 里的登录令牌。所以：
 * - 所有 /api 响应加 nosniff，浏览器不得把声明类型以外的内容当脚本或页面；
 * - 可执行类型（HTML、SVG、XML、JS）一律加 CSP sandbox：即使被直接打开也是不透明源、不运行脚本；
 * - 患者原件只有魔数确认为 PDF / 常见位图时才内联展示，其余一律按二进制附件下载。
 */

const ACTIVE_TYPE = /^\s*(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/(x-)?javascript|application\/ecmascript)\b/i
const SANDBOX_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"

export const apiSecurityHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  const type = c.res.headers.get('Content-Type') ?? ''
  if (ACTIVE_TYPE.test(type)) c.res.headers.set('Content-Security-Policy', SANDBOX_CSP)
}

/** 按文件头魔数识别可安全内联的类型；识别不出返回 null。 */
export function sniffInlineMime(bytes: Uint8Array): string | null {
  const at = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b)
  if (at([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf' // %PDF-
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (at([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (at([0x47, 0x49, 0x46, 0x38])) return 'image/gif' // GIF8
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp' // RIFF....WEBP
  return null
}

/** 患者原件 / 分享原件的响应头：内容类型由服务端按魔数判定，不信任上传方声明的 MIME。 */
export function userFileHeaders(name: string, bytes: Uint8Array): Record<string, string> {
  const inline = sniffInlineMime(bytes)
  return {
    'Content-Type': inline ?? 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  }
}
