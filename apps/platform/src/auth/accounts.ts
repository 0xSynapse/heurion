import { createHash, randomInt, randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { Store, UserRow } from '../store/db.ts'
import { BotError, BotGuard, type Solution } from './bot-guard.ts'
import { devUserFor } from './dev.ts'
import { MailerError, type Mailer } from './mailer.ts'
import { issueToken, verifyToken } from './token.ts'

/**
 * 账户（MIGRATION_PLAN.md §2.5 R1）：开放注册（第一个用户是管理员）、用户名 + 密码登录、可吊销的登录令牌。
 * 登录令牌是平台签名令牌（aud=web）带账户令牌版本 v：停用、改密码、强制下线时版本加一，旧令牌立即失效。
 * 开发模式下仍接受开发令牌（`<令牌>` / `<令牌>:<名字>`），e2e 与浏览器测试用；生产环境只认账户令牌。
 */

export class AuthError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 429 = 400) {
    super(message)
  }
}

/** 对外的用户信息（不含密码哈希与令牌版本）。 */
export interface PublicUser {
  id: string
  username: string
  display_name: string
  email: string | null
  work_email_prefix: string | null
  work_email: string
  role: UserRow['role']
  status: UserRow['status']
  created_at: string
  last_login_at: string | null
}

export const publicUser = (u: UserRow): PublicUser => {
  const prefix = (u.work_email_prefix || u.username.toLowerCase()).replace(/[^a-z0-9._-]/g, '') || 'doctor'
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    email: u.email ?? null,
    work_email_prefix: u.work_email_prefix ?? null,
    work_email: `${prefix}@heurion.org`,
    role: u.role,
    status: u.status,
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  }
}

const USERNAME = /^[\p{L}\p{N}_.-]{2,32}$/u
const BCRYPT_COST = 10

export function checkPassword(password: string): string | null {
  if (password.length < 8) return '密码至少 8 位'
  if (password.length > 72) return '密码最多 72 位'
  if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) return '密码要同时包含字母和数字'
  return null
}

/** 固定窗口限流（进程内；多实例部署时换成共享存储，M2）。 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>()
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** 记一次并返回是否超限。 */
  hit(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.reset <= now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs })
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k)
      return false
    }
    h.count++
    return h.count > this.limit
  }

  clear(key: string): void {
    this.hits.delete(key)
  }
}

export interface AccountOptions {
  secret: string
  /** 开发模式：接受开发令牌。 */
  devMode: boolean
  devToken: string
  devUser: string
  tokenTtlSeconds?: number
  /** 防机器人（默认按 secret 新建；测试传低难度）。 */
  botGuard?: BotGuard
  /** 发验证码邮件（找回密码、绑定邮箱）。 */
  mailer?: Mailer
}

const CODE_TTL_MS = 10 * 60_000
const RESEND_MS = 60_000
const CODE_ATTEMPTS = 5
const IP_CODES_PER_10MIN = 5
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const normalizeEmail = (email: unknown) => String(email ?? '').trim().toLowerCase()
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')

/** 注册 / 登录请求里的防机器人字段：工作量证明的解，以及陷阱字段 website（人看不到）。 */
export interface BotFields { pow?: Solution; website?: unknown }

export class Accounts {
  private readonly registerLimit = new RateLimiter(5, 60 * 60_000)
  private readonly loginLimit = new RateLimiter(20, 5 * 60_000)
  private readonly failureLimit = new RateLimiter(5, 15 * 60_000)
  private readonly ttl: number
  readonly bots: BotGuard

  constructor(private readonly store: Store, private readonly opts: AccountOptions) {
    this.ttl = opts.tokenTtlSeconds ?? 14 * 24 * 3600
    this.bots = opts.botGuard ?? new BotGuard({ secret: opts.secret })
  }

  private checkBot(ip: string, input: BotFields): void {
    try {
      this.bots.verify(ip, input.pow, input.website)
    } catch (err) {
      if (err instanceof BotError) throw new AuthError('bot_check', '人机校验没有通过，请刷新页面后重试', 400)
      throw err
    }
  }

  /** 机构停用时成员不能登录、已有令牌失效。 */
  private tenantActive(u: UserRow): boolean {
    return !u.tenant_id || this.store.getTenant(u.tenant_id)?.status !== 'suspended'
  }

  /** 注册：带邀请码时加入邀请方的机构（按邀请的角色），否则得到个人租户。 */
  register(input: { username?: string; password?: string; display_name?: string; invite?: string } & BotFields, ip: string): { user: PublicUser; token: string } {
    if (this.registerLimit.hit(ip)) throw new AuthError('rate_limited', '注册太频繁，请稍后再试', 429)
    this.checkBot(ip, input)
    const username = (input.username ?? '').trim().normalize('NFKC')
    const password = input.password ?? ''
    if (!USERNAME.test(username)) throw new AuthError('invalid_username', '用户名 2–32 位，可用字母、数字、中文、_ . -')
    const weak = checkPassword(password)
    if (weak) throw new AuthError('weak_password', weak)
    if (this.store.getUserByName(username)) throw new AuthError('username_taken', '这个用户名已被使用', 409)
    const displayName = (input.display_name ?? '').trim().slice(0, 40) || username
    let tenant: { id: string; role: UserRow['tenant_role'] } | undefined
    if (input.invite) {
      const inv = this.store.getInvite(String(input.invite))
      // 按用户名邀请的（发给某个已有账户）不能拿来注册新账户
      if (!inv || inv.revoked_at || inv.used_at || inv.target_user_id || Date.parse(inv.expires_at) < Date.now()) throw new AuthError('invite_invalid', '邀请链接无效或已过期，请让管理员重新发一个')
      if (this.store.getTenant(inv.tenant_id)?.status !== 'active') throw new AuthError('tenant_suspended', '这个机构已停用', 403)
      tenant = { id: inv.tenant_id, role: inv.role }
    }
    const user = this.store.createUser({ username, display_name: displayName, password_hash: bcrypt.hashSync(password, BCRYPT_COST), tenant })
    if (input.invite && tenant) this.store.useInvite(String(input.invite), user.id)
    this.store.updateUser(user.id, { touchLogin: true })
    return { user: publicUser(this.store.getUser(user.id)!), token: this.tokenFor(user) }
  }

  login(input: { username?: string; password?: string } & BotFields, ip: string): { user: PublicUser; token: string } {
    if (this.loginLimit.hit(ip)) throw new AuthError('rate_limited', '登录太频繁，请稍后再试', 429)
    this.checkBot(ip, input)
    return this.verifyCredentials(input, ip, false)
  }

  /** CLI 令牌兑换（如 `aegis app login heurion`）校验用户名密码与限流，不走浏览器表单 PoW。 */
  verifyCredentials(input: { username?: string; password?: string }, ip: string, checkRateLimit = true): { user: PublicUser; token: string } {
    if (checkRateLimit && this.loginLimit.hit(ip)) throw new AuthError('rate_limited', '登录太频繁，请稍后再试', 429)
    const username = (input.username ?? '').trim()
    const failKey = `u:${username.toLowerCase()}`
    const user = this.store.getUserByName(username)
    // 用户名不存在也做一次哈希比较，响应时间不暴露用户名是否存在
    const ok = bcrypt.compareSync(input.password ?? '', user?.password_hash ?? DUMMY_HASH)
    if (!user || !ok) {
      if (this.failureLimit.hit(failKey)) throw new AuthError('rate_limited', '密码错误次数过多，请 15 分钟后再试', 429)
      throw new AuthError('bad_credentials', '用户名或密码不对', 401)
    }
    if (user.status !== 'active') throw new AuthError('disabled', '账户已停用，请联系管理员', 403)
    if (!this.tenantActive(user)) throw new AuthError('tenant_suspended', '所在机构已停用，请联系平台', 403)
    this.failureLimit.clear(failKey)
    this.store.updateUser(user.id, { touchLogin: true })
    return { user: publicUser(this.store.getUser(user.id)!), token: this.tokenFor(user) }
  }

  /** 请求令牌 → 用户 id（账户令牌，或开发模式下的开发令牌）；无效返回 null。 */
  userFor(token: string | null | undefined): string | null {
    if (!token) return null
    if (token.startsWith('h1.')) {
      const claims = verifyToken(this.opts.secret, token, 'web')
      if (!claims) return null
      const user = this.store.getUser(claims.u)
      if (!user || user.status !== 'active' || user.token_version !== (claims.v ?? -1) || !this.tenantActive(user)) return null
      return user.id
    }
    return this.opts.devMode ? devUserFor(token, this.opts.devToken, this.opts.devUser) : null
  }

  /** 当前用户信息；开发用户没有账户记录。 */
  me(userId: string): PublicUser | { id: string; username: string; display_name: string; email: null; role: 'user'; dev: true } {
    const user = this.store.getUser(userId)
    if (user) return publicUser(user)
    return { id: userId, username: userId, display_name: userId, email: null, role: 'user', dev: true }
  }

  updateProfile(userId: string, input: { display_name?: string; work_email_prefix?: string; current_password?: string; new_password?: string }): { user: PublicUser; token?: string } {
    const user = this.store.getUser(userId)
    if (!user) throw new AuthError('no_account', '开发用户没有账户资料', 400)
    let token: string | undefined
    if (input.new_password !== undefined) {
      if (!bcrypt.compareSync(input.current_password ?? '', user.password_hash)) throw new AuthError('bad_credentials', '当前密码不对', 401)
      const weak = checkPassword(input.new_password)
      if (weak) throw new AuthError('weak_password', weak)
      // 改密码让其他设备上的登录失效；当前设备拿新令牌
      const updated = this.store.updateUser(userId, { password_hash: bcrypt.hashSync(input.new_password, BCRYPT_COST), bumpTokenVersion: true })!
      token = this.tokenFor(updated)
    }
    if (input.display_name !== undefined) {
      const name = input.display_name.trim().slice(0, 40)
      if (!name) throw new AuthError('invalid_display_name', '显示名不能为空')
      this.store.updateUser(userId, { display_name: name })
    }
    if (input.work_email_prefix !== undefined) {
      const raw = input.work_email_prefix.trim().toLowerCase()
      if (raw) {
        if (!/^[a-z0-9._-]{2,32}$/.test(raw)) {
          throw new AuthError('invalid_prefix', '邮箱前缀须为 2-32 位小写字母、数字、点号或短横线', 400)
        }
        const existing = this.store.getUserByWorkEmailPrefix(raw)
        if (existing && existing.id !== userId) {
          throw new AuthError('prefix_taken', '该专属工作邮箱前缀已被其他医生占用', 409)
        }
        this.store.updateUser(userId, { work_email_prefix: raw })
      } else {
        this.store.updateUser(userId, { work_email_prefix: null })
      }
    }
    return { user: publicUser(this.store.getUser(userId)!), ...(token ? { token } : {}) }
  }

  // —— 邮箱：绑定与找回密码（验证码 6 位、10 分钟有效、60 秒内不重发、错 5 次作废、一次有效；只存哈希） ——

  /**
   * 找回密码发码：不论邮箱是否绑定了账户都返回成功（不暴露邮箱是否注册），只有绑定了才真的发。
   * 需要人机校验（防止拿来批量发垃圾邮件）。
   */
  async sendResetCode(input: { email?: string } & BotFields, ip: string): Promise<{ ok: true; expires_in: number }> {
    this.checkBot(ip, input)
    // 发不了信时在查邮箱之前就报错：否则「有账户报错、没账户成功」会暴露邮箱是否注册
    if (!this.opts.mailer?.available) throw new AuthError('mail_unavailable', '邮件服务未配置，请联系管理员重置密码', 400)
    const email = normalizeEmail(input.email)
    if (!EMAIL.test(email)) throw new AuthError('invalid_email', '邮箱格式不对')
    const user = this.store.getUserByEmail(email)
    await this.issueCode(email, 'reset', ip, !!user && user.status === 'active')
    return { ok: true, expires_in: CODE_TTL_MS / 1000 }
  }

  /** 用验证码重置密码：所有旧登录失效，返回新登录令牌。 */
  resetPassword(input: { email?: string; code?: string; new_password?: string }): { user: PublicUser; token: string } {
    const email = normalizeEmail(input.email)
    const weak = checkPassword(input.new_password ?? '')
    if (weak) throw new AuthError('weak_password', weak)
    if (!this.useCode(email, 'reset', input.code)) throw new AuthError('bad_code', '验证码不对或已过期', 400)
    const user = this.store.getUserByEmail(email)
    if (!user || user.status !== 'active') throw new AuthError('bad_code', '验证码不对或已过期', 400)
    const updated = this.store.updateUser(user.id, { password_hash: bcrypt.hashSync(input.new_password!, BCRYPT_COST), bumpTokenVersion: true, touchLogin: true })!
    return { user: publicUser(updated), token: this.tokenFor(updated) }
  }

  /** 绑定邮箱第一步：给新邮箱发码（已登录，无需人机校验，按来源限流）。 */
  async sendBindCode(userId: string, emailInput: unknown, ip: string): Promise<{ ok: true; expires_in: number }> {
    if (!this.store.getUser(userId)) throw new AuthError('no_account', '开发用户没有账户资料')
    const email = normalizeEmail(emailInput)
    if (!EMAIL.test(email)) throw new AuthError('invalid_email', '邮箱格式不对')
    const owner = this.store.getUserByEmail(email)
    if (owner && owner.id !== userId) throw new AuthError('email_taken', '这个邮箱已绑定其他账户', 409)
    await this.issueCode(email, `bind:${userId}`, ip, true)
    return { ok: true, expires_in: CODE_TTL_MS / 1000 }
  }

  /** 绑定邮箱第二步：核对验证码后写入。 */
  bindEmail(userId: string, input: { email?: string; code?: string }): PublicUser {
    const email = normalizeEmail(input.email)
    if (!this.useCode(email, `bind:${userId}`, input.code)) throw new AuthError('bad_code', '验证码不对或已过期', 400)
    const owner = this.store.getUserByEmail(email)
    if (owner && owner.id !== userId) throw new AuthError('email_taken', '这个邮箱已绑定其他账户', 409)
    this.store.setUserEmail(userId, email)
    return publicUser(this.store.getUser(userId)!)
  }

  private async issueCode(target: string, purpose: string, ip: string, deliver: boolean): Promise<void> {
    const now = Date.now()
    const recent = this.store.latestVerificationCode(target, purpose)
    if (recent && !recent.used_at && now - recent.created_at < RESEND_MS) throw new AuthError('code_throttled', '60 秒内只能发送一次，请稍后再试', 429)
    if (this.store.countVerificationCodesByIp(ip, now - 10 * 60_000) >= IP_CODES_PER_10MIN) throw new AuthError('rate_limited', '发送太频繁，请稍后再试', 429)
    const code = String(randomInt(100000, 1000000))
    // 不发信也记一条（同样计入限流与重发间隔），响应时间和行为与真发一致
    this.store.addVerificationCode({ id: randomUUID(), target, purpose, code_hash: hashCode(code), ip, created_at: now, expires_at: now + CODE_TTL_MS })
    if (!deliver) return
    const mailer = this.opts.mailer
    if (!mailer) throw new AuthError('mail_unavailable', '邮件服务未配置，请联系管理员重置密码', 400)
    const subject = purpose === 'reset' ? 'Heurion 重置密码验证码' : 'Heurion 绑定邮箱验证码'
    try {
      await mailer.send(target, subject, `你的验证码是：${code}（10 分钟内有效）。如果不是你本人操作，请忽略这封邮件。`)
    } catch (err) {
      if (err instanceof MailerError) throw new AuthError('mail_unavailable', `${err.message}，请联系管理员重置密码`, 400)
      throw err
    }
  }

  /** 核对并作废验证码（最新一条、未过期、未用过、错误次数未满）。 */
  private useCode(target: string, purpose: string, code: unknown): boolean {
    const row = this.store.latestVerificationCode(target, purpose)
    if (!row || row.used_at || Date.now() > row.expires_at || row.attempts >= CODE_ATTEMPTS) return false
    if (hashCode(String(code ?? '').trim()) !== row.code_hash) {
      this.store.markVerificationCode(row.id, { attempt: true })
      return false
    }
    this.store.markVerificationCode(row.id, { used: true })
    return true
  }

  /** 退出所有设备：令牌版本加一。 */
  logoutEverywhere(userId: string): void {
    this.store.updateUser(userId, { bumpTokenVersion: true })
  }

  // —— 管理员 ——

  isAdmin(userId: string): boolean {
    return this.store.getUser(userId)?.role === 'admin'
  }

  listUsers(): Array<PublicUser & { doc_count: number; imported: boolean }> {
    return this.store.listUsers().map(u => ({ ...publicUser(u), doc_count: u.doc_count, imported: !!u.imported_from }))
  }

  adminUpdate(actorId: string, userId: string, patch: { role?: UserRow['role']; status?: UserRow['status'] }): PublicUser {
    const user = this.store.getUser(userId)
    if (!user) throw new AuthError('not_found', '用户不存在', 404)
    if (patch.role !== undefined && !['user', 'admin'].includes(patch.role)) throw new AuthError('invalid_role', '角色只能是 user 或 admin')
    if (patch.status !== undefined && !['active', 'disabled'].includes(patch.status)) throw new AuthError('invalid_status', '状态只能是 active 或 disabled')
    // 不能把最后一个管理员降级或停用（包括自己），否则没人能管理
    const losesAdmin = user.role === 'admin' && (patch.role === 'user' || patch.status === 'disabled')
    if (losesAdmin && this.store.listUsers().filter(u => u.role === 'admin' && u.status === 'active').length <= 1) {
      throw new AuthError('last_admin', '至少要保留一个可用的管理员', 409)
    }
    if (actorId === userId && patch.status === 'disabled') throw new AuthError('self_disable', '不能停用自己', 409)
    return publicUser(this.store.updateUser(userId, { ...patch, bumpTokenVersion: patch.status === 'disabled' })!)
  }

  adminResetPassword(userId: string, password: string): void {
    if (!this.store.getUser(userId)) throw new AuthError('not_found', '用户不存在', 404)
    const weak = checkPassword(password)
    if (weak) throw new AuthError('weak_password', weak)
    this.store.updateUser(userId, { password_hash: bcrypt.hashSync(password, BCRYPT_COST), bumpTokenVersion: true })
  }

  adminLogout(userId: string): void {
    if (!this.store.getUser(userId)) throw new AuthError('not_found', '用户不存在', 404)
    this.store.updateUser(userId, { bumpTokenVersion: true })
  }

  private tokenFor(user: UserRow): string {
    return issueToken(this.opts.secret, { u: user.id, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: this.ttl, v: user.token_version })
  }
}

/** 用户名不存在时比较用的哈希（任意固定值的 bcrypt 哈希）。 */
const DUMMY_HASH = bcrypt.hashSync('heurion-dummy-password-1', BCRYPT_COST)
