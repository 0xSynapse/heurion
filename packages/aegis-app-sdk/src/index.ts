import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto'

/**
 * Aegis 应用协议 AAP-1.0 的 SDK：清单类型、授权令牌、请求头、Ed25519 离线租约与「需要租约」返回格式。
 *
 * Heurion 平台自己也用这一份实现（`apps/platform/src/aegis/auth.ts` 从这里引入），
 * 所以第三方应用照这里签的租约、解析的请求头，与平台的校验逐字一致（tests/aegis-app.test.ts 交叉校验）。
 * 协议现状与按模块开放的方案见 docs/design/MCP_MODULES.md。
 */

export const AAP_PROTOCOL = 'AAP-1.0' as const

/** 离线（本地节点自签）租约的最长有效期：避免一张租约长期替代人工审批。 */
export const MAX_OFFLINE_LEASE_SEC = 15 * 60

// —— 清单（`GET /.well-known/aegis-app.json`） ——

export interface AegisCapabilityPreview {
  name: string
  tier: 'zero_prompt' | 'lease_gated'
  lease_scope?: string
  description: string
}

/** 应用按模块开放的 MCP：Aegis 一级目录每个模块一行，三级发现只拉一个模块的工具定义。 */
export interface AegisAppModule {
  id: string
  title: string
  summary: string
  /** 该模块的 MCP 地址（Streamable HTTP，POST）。 */
  mcp_http: string
  /** 对外部智能体的默认开放方式：open 默认开放；org_opt_in 机构开启后才能授权；readonly_default 只读开放、写操作走租约。 */
  external: 'open' | 'org_opt_in' | 'readonly_default'
  /** 只读授权（r）时保留的工具。 */
  read_only_tools: string[]
  /** 需要租约的工具 → 租约作用域。 */
  lease_gated: Record<string, string>
  /** 该模块的技能文档（说明 + 工具清单）。 */
  skill_url?: string
}

export interface AegisAppManifest {
  schema_version: typeof AAP_PROTOCOL
  app_id: string
  name: string
  version: string
  category: string
  trust_tier: 'first_party' | 'verified' | 'community'
  description: string
  homepage: string
  endpoints: {
    /** 挂全部已授权模块的 MCP 地址；按模块的地址见 modules[].mcp_http。 */
    mcp_http: string
    auth_device_code: string
    auth_device_approve?: string
    auth_token_exchange: string
    auth_token_revoke: string
    auth_grants: string
    lease_approve: string
  }
  auth: {
    modes: Array<'device_code' | 'pat' | 'credentials'>
    token_prefix: string
    requires_node_pubkey: boolean
    supports_lease_verification: 'ed25519'
  }
  modules?: AegisAppModule[]
  capabilities_preview: AegisCapabilityPreview[]
  skills?: Array<{ name: string; description: string; url: string }>
}

/** 校验清单：协议版本、应用 id、地址都以 `/` 开头、模块 id 不重复。 */
export function defineAegisManifest(manifest: AegisAppManifest): AegisAppManifest {
  if (manifest.schema_version !== AAP_PROTOCOL) throw new Error(`AAP 协议版本无效：${String(manifest.schema_version)}`)
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(manifest.app_id)) throw new Error(`AAP app_id「${manifest.app_id}」不合规：须匹配 /^[a-z0-9][a-z0-9_-]{1,62}$/`)
  const paths = [...Object.values(manifest.endpoints), ...(manifest.modules ?? []).map(m => m.mcp_http)]
  for (const p of paths) if (p && !p.startsWith('/')) throw new Error(`AAP 地址「${p}」须以 / 开头`)
  const ids = new Set<string>()
  for (const m of manifest.modules ?? []) {
    if (ids.has(m.id)) throw new Error(`AAP 模块 id 重复：${m.id}`)
    ids.add(m.id)
  }
  return manifest
}

// —— 授权令牌 `aegis_at_<app_id>.<grant_id>.<secret>` ——

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 常量时间比较两个十六进制串。 */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

const GRANT_TOKEN = /^(?:aegis_at_([a-z0-9_-]+)|h1_agt)\.(g_[a-zA-Z0-9_-]+)\.([A-Za-z0-9_-]+)$/

/** 签发授权令牌（服务端只存 tokenHash）。 */
export function issueAegisGrantTokenString(appId: string): { grantId: string; rawToken: string; tokenPrefix: string; tokenHash: string } {
  const grantId = 'g_' + randomBytes(8).toString('hex')
  const secret = randomBytes(24).toString('base64url')
  const rawToken = `aegis_at_${appId}.${grantId}.${secret}`
  return { grantId, rawToken, tokenPrefix: `aegis_at_${appId}.${grantId}.${secret.slice(0, 6)}`, tokenHash: sha256Hex(rawToken) }
}

/** 解析授权令牌；`appId` 给出时校验前缀。兼容 `h1_agt.<grant_id>.<secret>` 简写（此时 appId 为空）。 */
export function parseAegisGrantTokenString(rawToken: string, appId?: string): { appId: string | null; grantId: string; secret: string; tokenHash: string } | null {
  const token = rawToken.trim()
  const m = GRANT_TOKEN.exec(token)
  if (!m) return null
  if (appId && m[1] && m[1] !== appId) return null
  return { appId: m[1] ?? null, grantId: m[2]!, secret: m[3]!, tokenHash: sha256Hex(token) }
}

// —— 请求头 ——

export interface AegisRequestHeaders {
  authorization?: string
  protocol?: string
  agentId?: string
  orgId?: string
  /** 智能体会话：同一会话跨模块读到的结果共用一份观察记录（来源规则二）。 */
  sessionId?: string
  /** 智能体回合：同一回合的写入归到一个平台回合，可整回合撤销。 */
  turnId?: string
  leaseToken?: string
}

/** 从 Fetch Headers 或键值对象里取 AAP-1.0 请求头（名字不区分大小写）。 */
export function extractAegisHeaders(headers: Headers | Record<string, string | undefined>): AegisRequestHeaders {
  const get = (name: string): string | undefined => {
    if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name)?.trim() || undefined
    for (const [k, v] of Object.entries(headers as Record<string, string | undefined>)) if (k.toLowerCase() === name) return v?.trim() || undefined
    return undefined
  }
  return {
    authorization: get('authorization'),
    protocol: get('x-aegis-protocol'),
    agentId: get('x-aegis-agent-id'),
    orgId: get('x-aegis-org-id'),
    sessionId: get('x-aegis-session-id'),
    turnId: get('x-aegis-turn-id'),
    leaseToken: get('x-aegis-lease-token'),
  }
}

// —— Ed25519 密钥与离线租约 `X-Aegis-Lease-Token`（`<payload_b64url>.<sig_b64url>`） ——

export interface AegisLeasePayload {
  /** 租约 ID（如 lease-9f8e7d6c） */
  iss: string
  /** 绑定的授权 ID（如 g_0123abcd） */
  sub: string
  /** 目标应用 ID（如 'heurion'） */
  app: string
  /** 允许的智能体 ID（或 '*'） */
  agent: string
  /** 授权作用域（如 'heurion:clinical_confirm'、'heurion:tenant_admin.*'） */
  scope: string
  /** 授权资源范围（如患者 id 或 '*'） */
  resource: string
  /** 签发时间（秒） */
  iat: number
  /** 过期时间（秒） */
  exp: number
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** 解析 Ed25519 公钥：PEM、SPKI DER base64、或 `ed25519:<base64 / hex>` 32 字节裸公钥。 */
export function parseEd25519PublicKey(pubkeyStr: string): KeyObject {
  const trimmed = pubkeyStr.trim()
  if (trimmed.startsWith('-----BEGIN')) return createPublicKey(trimmed)
  const raw = trimmed.startsWith('ed25519:') ? trimmed.slice('ed25519:'.length).trim() : trimmed
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw, 'hex')]), format: 'der', type: 'spki' })
  const buf = Buffer.from(raw, 'base64')
  if (buf.length === 32) return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, buf]), format: 'der', type: 'spki' })
  return createPublicKey({ key: buf, format: 'der', type: 'spki' })
}

/** 解析 Ed25519 私钥：PEM、PKCS#8 DER base64、或 32 字节 hex / base64 种子。 */
export function parseEd25519PrivateKey(privkey: string | KeyObject): KeyObject {
  if (typeof privkey !== 'string') return privkey
  const trimmed = privkey.trim()
  if (trimmed.startsWith('-----BEGIN')) return createPrivateKey(trimmed)
  const raw = trimmed.startsWith('ed25519:') ? trimmed.slice('ed25519:'.length).trim() : trimmed
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(raw, 'hex')]), format: 'der', type: 'pkcs8' })
  const buf = Buffer.from(raw, 'base64')
  if (buf.length === 32) return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, buf]), format: 'der', type: 'pkcs8' })
  return createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' })
}

/** 生成本地节点密钥对：公钥 `ed25519:<base64>`（登记到授权上），私钥 PEM（留在本机）。 */
export function generateAegisNodeKeyPair(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  return {
    publicKey: `ed25519:${spki.subarray(spki.length - 32).toString('base64')}`,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  }
}

/** 用节点私钥签发租约。 */
export function signAegisLeaseToken(payload: AegisLeasePayload, privateKey: string | KeyObject): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = sign(null, Buffer.from(payloadB64, 'utf8'), parseEd25519PrivateKey(privateKey))
  return `${payloadB64}.${sig.toString('base64url')}`
}

/** 作用域 / 资源通配：完全相同、`*`、或以 `*` 结尾的前缀（如 `heurion:tenant_admin.*`）。 */
export function matchLeasePattern(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true
  return granted.endsWith('*') && required.startsWith(granted.slice(0, -1))
}

/** 离线验签租约，并核对应用、授权、智能体、作用域、资源与有效期（最长 15 分钟）。 */
export function verifyAegisLeaseToken(
  token: string,
  nodePubkey: string,
  expect: { appId: string; grantId: string; agentId: string; scope: string; resource?: string; now?: number },
): { ok: true; payload: AegisLeasePayload } | { ok: false; reason: string } {
  const parts = token.trim().split('.')
  if (parts.length !== 2) return { ok: false, reason: 'X-Aegis-Lease-Token 格式非法（应为 <payload_b64url>.<sig_b64url>）' }
  const [payloadB64, sigB64] = parts as [string, string]
  try {
    if (!verify(null, Buffer.from(payloadB64, 'utf8'), parseEd25519PublicKey(nodePubkey), Buffer.from(sigB64, 'base64url'))) {
      return { ok: false, reason: 'X-Aegis-Lease-Token Ed25519 签名校验失败' }
    }
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as AegisLeasePayload
    const now = expect.now ?? Math.floor(Date.now() / 1000)
    const resource = expect.resource ?? '*'
    if (payload.app !== expect.appId) return { ok: false, reason: `Lease 目标应用不匹配（期望 ${expect.appId}，实际 ${payload.app}）` }
    if (payload.sub !== expect.grantId) return { ok: false, reason: 'Lease sub 与当前 Grant ID 不匹配' }
    if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, reason: 'X-Aegis-Lease-Token 租约已过期' }
    if (payload.exp - now > MAX_OFFLINE_LEASE_SEC) return { ok: false, reason: `X-Aegis-Lease-Token 有效期过长（离线租约最长 ${MAX_OFFLINE_LEASE_SEC / 60} 分钟）` }
    if (payload.agent && payload.agent !== '*' && payload.agent !== expect.agentId) return { ok: false, reason: `Lease 绑定的 Agent (${payload.agent}) 与当前调用方 (${expect.agentId}) 不一致` }
    if (!matchLeasePattern(payload.scope, expect.scope)) return { ok: false, reason: `Lease 作用域 (${payload.scope}) 未覆盖所需操作 (${expect.scope})` }
    if (!matchLeasePattern(payload.resource ?? '*', resource)) return { ok: false, reason: `Lease 资源范围 (${payload.resource}) 未覆盖目标资源 (${resource})` }
    return { ok: true, payload }
  } catch (err) {
    return { ok: false, reason: `X-Aegis-Lease-Token 解析或验签异常：${(err as Error).message}` }
  }
}

// —— 「需要租约」的工具返回 ——

/** 工具在缺少租约时返回的载荷（MCP 工具结果的 JSON 正文）；Aegis 据此请用户批准、签出租约后重试。 */
export interface AegisApprovalRequired {
  status: 'approval_required'
  escalation_id: string
  suggested_lease_scope: string
  reason: string
  summary?: string
  action_id?: string
  message: string
}

export function formatApprovalRequired(input: { escalation_id: string; scope: string; resource?: string; reason: string; summary?: string; action_id?: string }): AegisApprovalRequired {
  return {
    status: 'approval_required',
    escalation_id: input.escalation_id,
    suggested_lease_scope: `action=${input.scope}, resource=${input.resource ?? '*'}`,
    reason: input.reason,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.action_id ? { action_id: input.action_id } : {}),
    message: '这是 [Lease-Gated] 高风险操作，已生成提权申请；请在 Aegis-OS 终端或应用 Web 端批准租约后重试。',
  }
}
