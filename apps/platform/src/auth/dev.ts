import { timingSafeEqual } from 'node:crypto'

/**
 * 开发期鉴权（M2 换成账户体系）：单一令牌映射到开发用户；「<令牌>:<名字>」映射到独立的开发用户
 * `<用户>:<名字>`（e2e / 手工测试各用各的队列与文档）。REST 与协同网关共用。
 */
export function devUserFor(token: string | null | undefined, devToken: string, devUser: string): string | null {
  if (!token || !devToken) return null
  const [base, sub] = token.split(':', 2)
  if (!base) return null
  const a = Buffer.from(base), b = Buffer.from(devToken)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (sub === undefined) return devUser
  return /^[a-z0-9_-]{1,32}$/.test(sub) ? `${devUser}:${sub}` : null
}
