import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto'

/**
 * Aegis Application Protocol (AAP-1.0) Official SDK
 * 供第一方（Heurion 2.0）与第三方应用快速接入 Aegis-OS 运行时（Antigravity / Hermes 多智能体沙箱）。
 */

export interface AegisCapabilityGroup {
  group: string
  tools: string[]
  tier: 'auto' | 'lease-gated' | 'human-only'
  lease_scope?: string
  description: string
}

export interface AegisAppManifest {
  protocol: 'aegis-app/1.0'
  app: {
    id: string
    name: string
    version: string
    vendor: string
    description: string
    homepage?: string
    categories?: string[]
  }
  mcp: {
    transport: 'streamable-http' | 'stdio' | 'unix-socket'
    endpoint: string
    eager_tools: string[]
    lazy_tools: 'all_remaining' | string[]
  }
  auth: {
    modes: Array<'user_grant_token' | 'session_jwt' | 'dev_token' | 'oauth2_pkce' | 'device_code'>
    token_exchange_endpoint: string
    token_revoke_endpoint: string
    token_prefix: string
    identity_binding: {
      requires_user_account: boolean
      supports_org_tenancy: boolean
      binds_aegis_node_pubkey: boolean
    }
    required_headers: string[]
    optional_headers?: string[]
  }
  capabilities: AegisCapabilityGroup[]
  security: {
    network_egress: string[]
    phi_policy?: 'deidentified_only' | 'encrypted_at_rest' | 'none'
    supports_cow_turn_revert: boolean
    turn_revert_tool?: string
    lease_verification: {
      supports_ed25519_offline_verify: boolean
      supports_server_escalation: boolean
      escalation_approve_endpoint?: string
    }
  }
  skills?: Array<{
    name: string
    description: string
    path: string
  }>
}

/**
 * 校验并声明符合 AAP-1.0 规范的应用自描述清单 (`/.well-known/aegis-app.json`)。
 */
export function defineAegisManifest(manifest: AegisAppManifest): AegisAppManifest {
  if (manifest.protocol !== 'aegis-app/1.0') {
    throw new Error(`Invalid AAP protocol version: ${String(manifest.protocol)}`)
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(manifest.app.id)) {
    throw new Error(`Invalid AAP app.id "${manifest.app.id}": must match /^[a-z0-9][a-z0-9_-]{1,62}$/`)
  }
  if (!manifest.mcp.endpoint.startsWith('/')) {
    throw new Error(`Invalid AAP mcp.endpoint "${manifest.mcp.endpoint}": must start with "/"`)
  }
  return manifest
}

export interface AegisRequestHeaders {
  authorization?: string
  agentId?: string
  sessionId?: string
  leaseToken?: string
}

export interface AegisLeasePayload {
  iss: string
  sub: string
  aud: string
  agt: string
  scp: string
  res: string
  iat: number
  exp: number
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

/**
 * 生成符合 AAP-1.0 规范的用户授权令牌：`aegis_at_<app_id>.<grant_id>.<random_secret>`
 */
export function issueAegisGrantTokenString(appId: string): {
  grantId: string
  rawToken: string
  tokenPrefix: string
  tokenHash: string
} {
  const grantId = 'ag_' + randomBytes(6).toString('hex')
  const secret = randomBytes(24).toString('base64url')
  const rawToken = `aegis_at_${appId}.${grantId}.${secret}`
  const tokenPrefix = `aegis_at_${appId}.${grantId}.${secret.slice(0, 6)}`
  const tokenHash = sha256Hex(rawToken)
  return { grantId, rawToken, tokenPrefix, tokenHash }
}

/**
 * 解析并校验 `aegis_at_<app_id>.<grant_id>.<secret>` 格式令牌。
 */
export function parseAegisGrantTokenString(
  rawToken: string,
  expectedAppId?: string,
): { appId: string; grantId: string; secret: string; tokenHash: string } | null {
  const m = /^(?:aegis_at_([a-z0-9_-]+)|h1_agt)\.(ag_[a-f0-9]+)\.([A-Za-z0-9_-]{16,})$/.exec(rawToken.trim())
  if (!m) return null
  const appId = m[1] ?? expectedAppId ?? 'heurion'
  if (expectedAppId && m[1] && m[1] !== expectedAppId) return null
  const grantId = m[2]!
  const secret = m[3]!
  return {
    appId,
    grantId,
    secret,
    tokenHash: sha256Hex(rawToken.trim()),
  }
}

/**
 * 从标准 Fetch Request 或键值 Header 对象中提取 AAP-1.0 上下文头。
 */
export function extractAegisHeaders(
  headers: Headers | Record<string, string | undefined>,
): AegisRequestHeaders {
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined
    const lower = name.toLowerCase()
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v
    }
    return undefined
  }
  return {
    authorization: get('authorization'),
    agentId: get('x-aegis-agent-id')?.trim() || undefined,
    sessionId: get('x-aegis-session-id')?.trim() || undefined,
    leaseToken: get('x-aegis-lease-token')?.trim() || undefined,
  }
}

/**
 * 生成本地 Aegis-OS 节点 Ed25519 密钥对（DER Base64 编码）。
 */
export function generateAegisNodeKeyPair(): { publicKeyBase64: string; privateKeyBase64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyBase64: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
    privateKeyBase64: (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
  }
}

/**
 * 由本地 Aegis-OS 节点私钥签发短期租约 `X-Aegis-Lease-Token`。
 */
export function signAegisLeaseToken(payload: AegisLeasePayload, privateKeyBase64: string): string {
  const privKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sigB64 = sign(null, Buffer.from(payloadB64, 'utf8'), privKey).toString('base64url')
  return `aegis_lease.${payloadB64}.${sigB64}`
}

/**
 * 离线验签 `X-Aegis-Lease-Token`（Ed25519）。
 */
export function verifyEd25519LeaseToken(
  token: string,
  publicKeyBase64: string,
  requiredScope: string,
  resource = '*',
  expectedAudience?: string,
): { ok: true; payload: AegisLeasePayload } | { ok: false; error: string } {
  const parts = token.trim().split('.')
  if (parts.length !== 3 || parts[0] !== 'aegis_lease') {
    return { ok: false, error: 'Lease 令牌格式无效（期望 aegis_lease.<payload>.<sig>）' }
  }
  const [, payloadB64, sigB64] = parts as [string, string, string]
  let pubKey
  try {
    pubKey = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
  } catch {
    return { ok: false, error: '无效的节点 Ed25519 公钥' }
  }
  try {
    const valid = verify(
      null,
      Buffer.from(payloadB64, 'utf8'),
      pubKey,
      Buffer.from(sigB64, 'base64url'),
    )
    if (!valid) return { ok: false, error: 'Lease 令牌 Ed25519 签名校验失败' }
  } catch {
    return { ok: false, error: 'Lease 令牌签名验证异常' }
  }

  let payload: AegisLeasePayload
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as AegisLeasePayload
  } catch {
    return { ok: false, error: 'Lease 令牌载荷无法解析' }
  }

  const nowSec = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    return { ok: false, error: 'Lease 令牌已过期' }
  }
  if (expectedAudience && payload.aud && payload.aud !== expectedAudience && payload.aud !== '*') {
    return { ok: false, error: `Lease 令牌受众不匹配 (${payload.aud})` }
  }
  const scopes = String(payload.scp ?? '').split(/[\s,]+/).filter(Boolean)
  const scopeMatched =
    scopes.includes('*') ||
    scopes.includes(requiredScope) ||
    scopes.some(s => s.endsWith(':*') && requiredScope.startsWith(s.slice(0, -1)))
  if (!scopeMatched) {
    return { ok: false, error: `Lease 令牌未覆盖所需权限范围 (${requiredScope})` }
  }
  if (payload.res && payload.res !== '*' && resource !== '*' && payload.res !== resource) {
    return { ok: false, error: `Lease 令牌资源范围不匹配 (期望 ${resource}，实际 ${payload.res})` }
  }
  return { ok: true, payload }
}

/**
 * 生成符合 AAP-1.0 §4.2 规范的 `lease_required` 拦截响应载荷。
 */
export function formatLeaseRequiredError(input: {
  escalation_id: string
  scope: string
  resource?: string
  reason: string
  approve_cmd?: string
}) {
  return {
    code: 'lease_required' as const,
    escalation_id: input.escalation_id,
    required_scope: input.scope,
    resource: input.resource ?? '*',
    message: `高危操作 [${input.scope}] 需要人类批准短期租约 (Session Lease) 后方可执行：${input.reason}`,
    approve_hint:
      input.approve_cmd ??
      `请让用户在 Aegis-OS 终端执行 policy_approve_escalation(escalation_id="${input.escalation_id}")，或在应用 Web 界面批准该提权申请后重试。`,
  }
}
