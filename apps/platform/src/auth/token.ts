import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * 范围令牌（PLATFORM.md §6.6）：按 (用户, 文档集合, 权限, 过期时间, 用途) 签发。
 * MCP 令牌（aud=mcp）只给 dsh；浏览器令牌（aud=web）只给前端，两者不通用。
 * 格式：`h1.<base64url(json)>.<hmac>`。
 */

/** mcp：dsh 回连平台 MCP；web：浏览器；llm：dsh 经平台代理调用模型（真实 API key 不进 dsh）。 */
export type Audience = 'mcp' | 'web' | 'llm'
export type Permission = 'read' | 'write'

export interface TokenClaims {
  /** 用户 */
  u: string
  /** 可访问的文档：'*' 表示该用户的全部文档 */
  d: '*' | string[]
  p: Permission[]
  aud: Audience
  /** 过期时间（unix 秒） */
  exp: number
  /** dsh 进程代号：进程被停止后它的令牌立即失效（停止的回合不能再写入）。 */
  s?: string
  /** 登录令牌（aud=web）的账户令牌版本：与账户当前版本不一致即失效（停用、改密码、强制下线）。 */
  v?: number
  /** MCP 工具范围（aud=mcp）：doc = 普通稿件，deck = 幻灯片；缺省为全部工具（见 mcp/scope.ts）。 */
  t?: 'doc' | 'deck'
}

const b64 = (s: string) => Buffer.from(s).toString('base64url')
const sign = (secret: string, body: string) => createHmac('sha256', secret).update(`h1.${body}`).digest('base64url')

export function issueToken(secret: string, claims: Omit<TokenClaims, 'exp'> & { ttlSeconds: number }): string {
  const { ttlSeconds, ...rest } = claims
  const body = b64(JSON.stringify({ ...rest, exp: Math.floor(Date.now() / 1000) + ttlSeconds }))
  return `h1.${body}.${sign(secret, body)}`
}

export function verifyToken(secret: string, token: string, aud: Audience): TokenClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'h1') return null
  const [, body, mac] = parts as [string, string, string]
  const expected = Buffer.from(sign(secret, body))
  const actual = Buffer.from(mac)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  let claims: TokenClaims
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims
  } catch {
    return null
  }
  if (claims.aud !== aud || claims.exp < Date.now() / 1000) return null
  return claims
}

export function canAccess(claims: TokenClaims, docId: string, perm: Permission): boolean {
  return claims.p.includes(perm) && (claims.d === '*' || claims.d.includes(docId))
}
