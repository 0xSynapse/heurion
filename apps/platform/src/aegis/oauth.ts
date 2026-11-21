import { createHash, randomBytes } from 'node:crypto'
import { grantModules, MODULE_IDS, MODULES, parseModuleGrant, type ModuleGrant } from '../mcp/modules.ts'
import type { Store } from '../store/db.ts'
import type { AegisAuthService } from './auth.ts'
import { safeEqualHex } from './sdk.ts'

/**
 * MCP 的 OAuth 2.1 授权服务器（docs/design/MCP_MODULES.md §0.4；MCP 鉴权规范）。
 *
 * - 发现：受保护资源元数据（RFC 9728）指向本站授权服务器；授权服务器元数据（RFC 8414）。
 * - 客户端：动态注册（RFC 7591），只有公开客户端（token_endpoint_auth_method = none），一律 PKCE S256。
 * - 授权：`/oauth/authorize` 校验后转到应用里的确认页（`/app?mcp_authorize=<id>`）；用户登录后逐个模块勾选，
 *   批准即建一条授权（agent_grants，令牌前缀 hr_oat），并发一次性授权码。
 * - 令牌：授权码 + code_verifier 换访问令牌（1 小时）与刷新令牌（30 天，每次刷新轮换）。访问令牌就是那条授权的
 *   令牌，网关的校验、模块权限、机构外发策略、审计都与个人访问令牌相同；在设置页吊销即全部失效。
 * - 资源指示符（RFC 8707）：resource 必须是本站的 MCP 地址（/api/mcp 或 /api/aegis/mcp 下）。
 */

export const ACCESS_TTL_MS = 60 * 60 * 1000
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const REQUEST_TTL_MS = 10 * 60 * 1000
const CODE_TTL_MS = 5 * 60 * 1000

export class OAuthError extends Error {
  constructor(readonly error: string, message: string, readonly status = 400) { super(message) }
  body() { return { error: this.error, error_description: this.message } }
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const b64url = (buf: Buffer) => buf.toString('base64url')

/** 模块权限对应的 OAuth scope：`writing:rw`、`literature:r`……（未给权限的 `writing` 当 rw）。 */
export const SCOPES_SUPPORTED: string[] = MODULE_IDS.flatMap(id => [`${id}:r`, `${id}:rw`])

export function authServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES_SUPPORTED,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/api/mcp/modules`,
  }
}

/** 受保护资源元数据：resource 是客户端要连的 MCP 地址（按 well-known 后面的路径），授权服务器就是本站。 */
export function protectedResourceMetadata(origin: string, path: string) {
  const resource = isMcpPath(path) ? `${origin}${path}` : `${origin}/api/mcp`
  return {
    resource,
    authorization_servers: [origin],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: '知衡 Heurion MCP',
    resource_documentation: `${origin}/api/mcp/modules`,
  }
}

const isMcpPath = (p: string) => /^\/api\/(aegis\/)?mcp(\/[a-z]+)?$/.test(p)

/** resource 参数（RFC 8707）：可以不给；给了就必须是本站的 MCP 地址。 */
function checkResource(resource: string | null | undefined, origin: string): string | null {
  if (!resource) return null
  let u: URL
  try { u = new URL(resource) } catch { throw new OAuthError('invalid_target', 'resource 不是有效的 URL') }
  if (u.origin !== origin || !isMcpPath(u.pathname.replace(/\/$/, ''))) throw new OAuthError('invalid_target', `resource 必须是本站的 MCP 地址（${origin}/api/mcp…）`)
  return `${u.origin}${u.pathname.replace(/\/$/, '')}`
}

/** 回调地址：https，或本机回环的 http（原生客户端），或私有 URI scheme（如 cursor://…）。 */
function validRedirect(uri: string): boolean {
  let u: URL
  try { u = new URL(uri) } catch { return false }
  if (u.hash) return false
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'].includes(u.protocol)
}

/** RFC 8252 §7.3：本机回环 http 回调允许端口动态变化，其余 URI 必须精确匹配。 */
function redirectUriMatches(registeredList: string[], actual: string): boolean {
  if (registeredList.includes(actual)) return true
  let act: URL
  try { act = new URL(actual) } catch { return false }
  if (act.hash || act.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(act.hostname)) return false
  return registeredList.some(reg => {
    try {
      const r = new URL(reg)
      return r.protocol === 'http:' && r.hostname === act.hostname && r.pathname === act.pathname && r.search === act.search
    } catch { return false }
  })
}

/** scope（空格或逗号分隔）→ 预选的模块权限；不认识的 scope 忽略，什么都没有时预选默认开放的模块读写。 */
export function scopeToModules(scope: string | null | undefined): ModuleGrant {
  const parts = (scope ?? '').split(/[\s,]+/).filter(p => /^[a-z]+(:(r|rw))?$/.test(p) && (MODULE_IDS as readonly string[]).includes(p.split(':')[0]!))
  if (parts.length) { try { return parseModuleGrant(parts.join(',')) } catch { /* 落到默认 */ } }
  return Object.fromEntries(MODULES.filter(m => m.external === 'open').map(m => [m.id, 'rw'])) as ModuleGrant
}

export class OAuthService {
  constructor(private readonly store: Store, private readonly auth: AegisAuthService) {}

  /** 动态客户端注册（RFC 7591）：只发公开客户端。 */
  register(body: Record<string, unknown>) {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
    if (!uris.length || uris.length > 10) throw new OAuthError('invalid_redirect_uri', '需要 1–10 个 redirect_uris')
    const bad = uris.filter(u => !validRedirect(u))
    if (bad.length) throw new OAuthError('invalid_redirect_uri', `回调地址不合规（要 https、本机回环 http 或私有 scheme）：${bad.slice(0, 3).join('、')}`)
    const method = body.token_endpoint_auth_method
    if (method !== undefined && method !== 'none') throw new OAuthError('invalid_client_metadata', '只支持公开客户端（token_endpoint_auth_method = none），用 PKCE')
    const name = (typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : 'MCP 客户端').slice(0, 100)
    const client_id = 'mcpc_' + b64url(randomBytes(18))
    this.store.addOAuthClient({ client_id, client_name: name, redirect_uris: uris })
    return {
      client_id, client_name: name, redirect_uris: uris, client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }
  }

  /**
   * 授权请求：校验客户端与回调地址后记下请求，返回应用里确认页的地址。
   * 客户端或回调地址不对时不能重定向回去（防开放重定向），抛 OAuthError 由调用方显示错误页；其余错误按规范重定向回客户端。
   */
  authorize(q: Record<string, string | undefined>, origin: string): { redirect: string } {
    const client = q.client_id ? this.store.getOAuthClient(q.client_id) : undefined
    if (!client) throw new OAuthError('invalid_client', '未注册的 client_id')
    const redirect = q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined)
    if (!redirect || !redirectUriMatches(client.redirect_uris, redirect)) throw new OAuthError('invalid_request', 'redirect_uri 与注册的不一致')
    const back = (error: string, description: string) => ({ redirect: withParams(redirect, { error, error_description: description, state: q.state, iss: origin }) })
    if (q.response_type !== 'code') return back('unsupported_response_type', '只支持 response_type=code')
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', '必须用 PKCE（code_challenge_method=S256）')
    let resource: string | null
    try { resource = checkResource(q.resource, origin) } catch (err) { return back('invalid_target', (err as Error).message) }
    const id = 'oar_' + b64url(randomBytes(18))
    this.store.addOAuthRequest({ id, client_id: client.client_id, redirect_uri: redirect, state: q.state ?? null, code_challenge: q.code_challenge, scope: q.scope ?? null, resource, ttl_ms: REQUEST_TTL_MS })
    return { redirect: `${origin}/app?mcp_authorize=${encodeURIComponent(id)}` }
  }

  /** 确认页要显示的内容。 */
  requestView(id: string) {
    const r = this.store.getOAuthRequest(id)
    if (!r || r.status !== 'pending' || r.expires_at <= new Date().toISOString()) throw new OAuthError('invalid_request', '授权请求不存在或已过期，请回到客户端重新发起', 404)
    const client = this.store.getOAuthClient(r.client_id)!
    let redirectHost = r.redirect_uri
    try { const u = new URL(r.redirect_uri); redirectHost = u.host || `${u.protocol}//` } catch { /* 原样 */ }
    return { id: r.id, client_name: client.client_name, redirect_host: redirectHost, resource: r.resource, requested: scopeToModules(r.scope) }
  }

  /** 用户在确认页的决定：批准 → 建授权、发授权码；拒绝 → access_denied。返回要跳回客户端的地址。 */
  decide(id: string, userId: string, approve: boolean, modules: unknown, origin: string): { redirect: string } {
    const r = this.store.getOAuthRequest(id)
    if (!r) throw new OAuthError('invalid_request', '授权请求不存在', 404)
    // 先校验模块权限，免得请求已标为批准、授权却建不出来
    if (approve && modules !== undefined) {
      try { parseModuleGrant(modules) } catch (err) { throw new OAuthError('invalid_scope', (err as Error).message) }
    }
    if (!this.store.decideOAuthRequest(id, approve ? 'approved' : 'denied')) throw new OAuthError('invalid_request', '授权请求已处理或已过期，请回到客户端重新发起', 409)
    if (!approve) return { redirect: withParams(r.redirect_uri, { error: 'access_denied', error_description: '用户拒绝了授权', state: r.state ?? undefined, iss: origin }) }
    const client = this.store.getOAuthClient(r.client_id)!
    const issued = this.auth.issueGrant({ kind: 'oauth', userId, name: client.client_name, modules: modules ?? scopeToModules(r.scope), ttlDays: 1 })
    const code = b64url(randomBytes(32))
    this.store.addOAuthCode({ code_hash: sha256(code), client_id: r.client_id, redirect_uri: r.redirect_uri, code_challenge: r.code_challenge, resource: r.resource, user_id: userId, grant_id: issued.grant.id, ttl_ms: CODE_TTL_MS })
    return { redirect: withParams(r.redirect_uri, { code, state: r.state ?? undefined, iss: origin }) }
  }

  /** 令牌端点（RFC 6749 §4.1.3 / §6，OAuth 2.1）。 */
  token(body: Record<string, unknown>, origin: string) {
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined)
    const clientId = str('client_id')
    if (str('grant_type') === 'authorization_code') {
      const code = str('code'), verifier = str('code_verifier')
      if (!code || !verifier || !clientId) throw new OAuthError('invalid_request', '需要 code、code_verifier 与 client_id')
      const c = this.store.takeOAuthCode(sha256(code))
      if (!c) throw new OAuthError('invalid_grant', '授权码无效、已用过或已过期')
      if (c.client_id !== clientId) throw new OAuthError('invalid_grant', '授权码不是发给这个客户端的')
      if (str('redirect_uri') && str('redirect_uri') !== c.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri 与授权请求不一致')
      if (b64url(createHash('sha256').update(verifier, 'ascii').digest()) !== c.code_challenge) throw new OAuthError('invalid_grant', 'code_verifier 校验失败（PKCE）')
      const resource = checkResource(str('resource'), origin)
      if (resource && c.resource && resource !== c.resource) throw new OAuthError('invalid_target', 'resource 与授权请求不一致')
      return this.issue(c.grant_id, clientId)
    }
    if (str('grant_type') === 'refresh_token') {
      const rt = str('refresh_token')
      if (!rt || !clientId) throw new OAuthError('invalid_request', '需要 refresh_token 与 client_id')
      const r = this.store.takeOAuthRefreshToken(sha256(rt))
      if (!r || r.client_id !== clientId) throw new OAuthError('invalid_grant', '刷新令牌无效、已用过或已过期')
      checkResource(str('resource'), origin)
      return this.issue(r.grant_id, clientId)
    }
    if (str('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
      const deviceCode = str('device_code')
      if (!deviceCode) throw new OAuthError('invalid_request', '需要 device_code')
      const polled = this.auth.pollDeviceCode(deviceCode)
      if (polled.status === 'pending') throw new OAuthError('authorization_pending', polled.error)
      if (polled.status === 'expired') throw new OAuthError('expired_token', polled.error)
      if (polled.status === 'consumed') throw new OAuthError('access_denied', polled.error)
      if (polled.status !== 'approved') throw new OAuthError('invalid_grant', polled.error)
      const scope = Object.entries(grantModules(polled.grant)).map(([k, v]) => `${k}:${v}`).join(' ')
      const expiresIn = polled.grant.expires_at
        ? Math.max(1, Math.floor((Date.parse(polled.grant.expires_at) - Date.now()) / 1000))
        : ACCESS_TTL_MS / 1000
      return { access_token: polled.token, token_type: 'Bearer', expires_in: expiresIn, scope }
    }
    throw new OAuthError('unsupported_grant_type', '只支持 authorization_code、refresh_token 与 device_code')
  }

  /** 撤销（RFC 7009）：访问令牌或刷新令牌都会吊销整条授权。不认识的令牌也回 200。 */
  revoke(token: string | undefined): void {
    if (!token) return
    const m = /^hr_o(?:at|rt)\.(g_[a-zA-Z0-9_-]+)\./.exec(token.trim())
    if (!m) return
    const grant = this.store.getAgentGrant(m[1]!)
    if (!grant) return
    const ok = token.startsWith('hr_oat.') ? safeEqualHex(grant.token_hash, sha256(token.trim())) : !!this.store.takeOAuthRefreshToken(sha256(token.trim()))
    if (ok) this.store.revokeAgentGrant(grant.id)
  }

  private issue(grantId: string, clientId: string) {
    const grant = this.store.getAgentGrant(grantId)
    const user = grant ? this.store.getUser(grant.user_id) : undefined
    if (!grant || grant.revoked_at || !user || user.status !== 'active' || user.token_version !== grant.user_token_version) {
      throw new OAuthError('invalid_grant', '授权已被吊销或账户状态已变化，请重新授权')
    }
    const access = `hr_oat.${grant.id}.${b64url(randomBytes(24))}`
    const refresh = `hr_ort.${grant.id}.${b64url(randomBytes(32))}`
    this.store.rotateAgentGrantToken(grant.id, sha256(access), `hr_oat.${grant.id}.${access.split('.')[2]!.slice(0, 4)}…`, new Date(Date.now() + ACCESS_TTL_MS).toISOString())
    this.store.addOAuthRefreshToken({ token_hash: sha256(refresh), grant_id: grant.id, client_id: clientId, ttl_ms: REFRESH_TTL_MS })
    const scope = Object.entries(grantModules(grant)).map(([k, v]) => `${k}:${v}`).join(' ')
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope }
  }
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
  return u.toString()
}
