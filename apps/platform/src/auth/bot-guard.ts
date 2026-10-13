import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * 注册 / 登录的防机器人（自建，不依赖第三方验证码，境内可用、不外发用户信息）：
 * 1. 工作量证明（思路同 ALTCHA）：服务端签发 challenge = SHA-256(salt + n)，n ∈ [0, max] 不告诉客户端；
 *    浏览器穷举 n（平均约 1 秒），服务端核对签名、过期、答案，一题只能用一次。同一来源失败越多，max 越大。
 * 2. 陷阱字段：页面上隐藏的输入框，人不会填，脚本常会填。
 * 3. 最短填写时间：领题后过快提交视为脚本。
 */

export interface Challenge {
  algorithm: 'SHA-256'
  challenge: string
  /** 带签发时间与过期时间：`<随机>?issued=<ms>&expires=<ms>` */
  salt: string
  maxnumber: number
  signature: string
}

export interface Solution {
  challenge?: string
  salt?: string
  number?: number
  signature?: string
}

export class BotError extends Error {}

export interface BotGuardOptions {
  secret: string
  /** 基础难度（穷举上限）；默认 100k，浏览器平均约 1 秒。 */
  baseMax?: number
  /** 题目有效期。 */
  ttlMs?: number
  /** 领题后最短提交间隔。 */
  minDelayMs?: number
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export class BotGuard {
  private readonly used = new Map<string, number>()
  private readonly failures = new Map<string, { count: number; reset: number }>()
  private readonly baseMax: number
  private readonly ttl: number
  private readonly minDelay: number

  constructor(private readonly opts: BotGuardOptions) {
    this.baseMax = opts.baseMax ?? 100_000
    this.ttl = opts.ttlMs ?? 10 * 60_000
    this.minDelay = opts.minDelayMs ?? 1500
  }

  /** 签发一道题；同一来源最近失败越多，题越难（最多 16 倍）。 */
  issue(source: string, now = Date.now()): Challenge {
    const f = this.failures.get(source)
    const level = f && f.reset > now ? Math.min(4, f.count) : 0
    const maxnumber = this.baseMax * 2 ** level
    const salt = `${randomBytes(12).toString('hex')}?issued=${now}&expires=${now + this.ttl}`
    const n = randomBytes(4).readUInt32BE() % (maxnumber + 1)
    const challenge = sha256(salt + n)
    return { algorithm: 'SHA-256', challenge, salt, maxnumber, signature: this.sign(`${challenge}:${salt}`) }
  }

  /** 核对；不通过抛 BotError（并记一次来源失败）。 */
  verify(source: string, solution: Solution | undefined, honeypot: unknown, now = Date.now()): void {
    try {
      if (typeof honeypot === 'string' && honeypot.trim() !== '') throw new BotError('honeypot')
      const { challenge, salt, number, signature } = solution ?? {}
      if (!challenge || !salt || typeof number !== 'number' || !signature) throw new BotError('missing')
      if (!this.signatureOk(`${challenge}:${salt}`, signature)) throw new BotError('signature')
      const params = new URLSearchParams(salt.split('?')[1] ?? '')
      const issued = Number(params.get('issued'))
      const expires = Number(params.get('expires'))
      if (!issued || !expires || now > expires || expires > now + this.ttl + 5000 || issued > now + 5000) throw new BotError('expired')
      if (now - issued < this.minDelay) throw new BotError('too_fast')
      if (sha256(salt + number) !== challenge) throw new BotError('wrong')
      this.prune(now)
      if (this.used.has(signature)) throw new BotError('replay')
      this.used.set(signature, expires)
    } catch (err) {
      if (this.failures.size >= 5000) {
        for (const [k, v] of this.failures) if (v.reset <= now) this.failures.delete(k)
        if (this.failures.size >= 5000) {
          const oldest = this.failures.keys().next().value
          if (oldest !== undefined) this.failures.delete(oldest)
        }
      }
      const f = this.failures.get(source)
      if (!f || f.reset <= now) this.failures.set(source, { count: 1, reset: now + 60 * 60_000 })
      else f.count++
      throw err
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', `bot-guard:${this.opts.secret}`).update(payload).digest('hex')
  }

  private signatureOk(payload: string, signature: string): boolean {
    const a = Buffer.from(this.sign(payload))
    const b = Buffer.from(signature)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private prune(now: number): void {
    if (this.used.size < 5000) return
    for (const [k, exp] of this.used) if (exp < now) this.used.delete(k)
    for (const [k, f] of this.failures) if (f.reset <= now) this.failures.delete(k)
  }
}

/** 解题（测试与非浏览器客户端用；浏览器在 web/src/account.ts 里用 Web Crypto 解）。 */
export function solveChallenge(c: Challenge): Solution {
  for (let n = 0; n <= c.maxnumber; n++) {
    if (sha256(c.salt + n) === c.challenge) return { challenge: c.challenge, salt: c.salt, number: n, signature: c.signature }
  }
  throw new Error('no solution')
}
