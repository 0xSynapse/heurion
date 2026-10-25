import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, randomBytes, timingSafeEqual, verify as cryptoVerify, sign as cryptoSign } from 'node:crypto'
import type { AgentGrantRow, Store, TenantRow, UserRow } from '../store/db.ts'

/**
 * Aegis Application Protocol (AAP-1.0) — 统一身份鉴权与 Ed25519 租约验签服务
 *
 * 1. 统一应用授权令牌（App Grant Token）：
 *    `aegis_at_<app_id>.<grant_id>.<secret>`（兼容 `h1_agt.<grant_id>.<secret>` 简写）
 *    服务端仅存 SHA-256 哈希，并与 `users.token_version`、用户启用状态、机构状态实时联动。
 * 2. 离线/在线双模租约验签（Lease Verification）：
 *    - 支持离线校验 `X-Aegis-Lease-Token`：由本地 Aegis-OS Policy Engine 使用节点 Ed25519 私钥签名，
 *      应用服务端使用 Grant 注册的 `aegis_node_pubkey` 验签，零网络往返确认人工审批意图。
 *    - 支持在线租约表 `agent_leases`：由用户在 Web/CLI 调用 `/api/aegis/leases/approve` 批准 `escalation_id` 后签发。
 */

export interface AegisLeasePayload {
  /** 租约 ID（如 lease-9f8e7d6c） */
  iss: string
  /** 绑定的 App Grant ID（如 g_01HXYZ） */
  sub: string
  /** 目标应用 ID（如 'heurion'） */
  app: string
  /** 允许的 Agent ID（如 'agent-writer' 或 '*'） */
  agent: string
  /** 授权作用域（如 'heurion:mail_admin.send'、'heurion:clinical_confirm'、'heurion:*'） */
  scope: string
  /** 授权资源范围（如 'patient:P001' 或 '*'） */
  resource: string
  /** 签发时间戳（秒） */
  iat: number
  /** 过期时间戳（秒） */
  exp: number
}

export interface VerifiedAegisGrant {
  grant: AgentGrantRow
  user: UserRow
  tenant: TenantRow | null
}

/** Raw 32-byte Ed25519 public key ASN.1 SPKI DER prefix */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
/** Raw 32-byte Ed25519 private key ASN.1 PKCS#8 DER prefix */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function safeHexEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'utf8')
  const b = Buffer.from(bHex, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 解析 Ed25519 公钥（支持 PEM、SPKI base64/base64url、或 `ed25519:<base64/hex>` 32 字节裸公钥）。
 */
export function parseEd25519PublicKey(pubkeyStr: string): KeyObject {
  const trimmed = pubkeyStr.trim()
  if (trimmed.startsWith('-----BEGIN')) {
    return createPublicKey(trimmed)
  }
  const rawPart = trimmed.startsWith('ed25519:') ? trimmed.slice('ed25519:'.length).trim() : trimmed
  // 64 hex chars = 32 bytes raw Ed25519 public key
  if (/^[0-9a-fA-F]{64}$/.test(rawPart)) {
    const raw = Buffer.from(rawPart, 'hex')
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
  }
  const buf = Buffer.from(rawPart, 'base64')
  if (buf.length === 32) {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, buf]), format: 'der', type: 'spki' })
  }
  return createPublicKey({ key: buf, format: 'der', type: 'spki' })
}

/**
 * 解析 Ed25519 私钥（支持 PEM、PKCS#8 DER base64、或 32 字节 hex/base64 种子）。
 */
export function parseEd25519PrivateKey(privkeyStr: string | KeyObject): KeyObject {
  if (typeof privkeyStr !== 'string') return privkeyStr
  const trimmed = privkeyStr.trim()
  if (trimmed.startsWith('-----BEGIN')) {
    return createPrivateKey(trimmed)
  }
  const rawPart = trimmed.startsWith('ed25519:') ? trimmed.slice('ed25519:'.length).trim() : trimmed
  if (/^[0-9a-fA-F]{64}$/.test(rawPart)) {
    const raw = Buffer.from(rawPart, 'hex')
    return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
  }
  const buf = Buffer.from(rawPart, 'base64')
  if (buf.length === 32) {
    return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, buf]), format: 'der', type: 'pkcs8' })
  }
  return createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' })
}

/** 生成本地 Aegis-OS 节点 Ed25519 密钥对（返回 `ed25519:<base64>` 格式公钥与 PEM 私钥）。 */
export function generateAegisNodeKeyPair(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  const raw32 = spki.subarray(spki.length - 32)
  return {
    publicKey: `ed25519:${raw32.toString('base64')}`,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  }
}

/** 使用节点 Ed25519 私钥签发 `X-Aegis-Lease-Token`（`<payload_b64url>.<sig_b64url>`）。 */
export function signAegisLeaseToken(payload: AegisLeasePayload, privateKey: string | KeyObject): string {
  const keyObj = parseEd25519PrivateKey(privateKey)
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = cryptoSign(null, Buffer.from(payloadB64, 'utf8'), keyObj)
  return `${payloadB64}.${sig.toString('base64url')}`
}

/** 通配符作用域匹配：支持完全匹配、`heurion:mail_admin.*`、`heurion:*` 或 `*`。 */
export function matchLeasePattern(grantedPattern: string, requiredValue: string): boolean {
  if (grantedPattern === '*' || grantedPattern === requiredValue) return true
  if (grantedPattern.endsWith('*')) {
    const prefix = grantedPattern.slice(0, -1)
    return requiredValue.startsWith(prefix)
  }
  return false
}

export class AegisAuthService {
  readonly store: Store
  readonly appId: string

  constructor(store: Store, appId = 'heurion') {
    this.store = store
    this.appId = appId
  }

  /**
   * 为指定用户签发新的 `aegis_at_<app_id>.<grant_id>.<secret>` 应用授权令牌。
   */
  issueGrant(input: {
    userId: string
    name?: string
    nodePubkey?: string | null
    toolScope?: AgentGrantRow['tool_scope']
    permissions?: string[]
    docIds?: string[] | null
    writeMode?: AgentGrantRow['write_mode']
    ttlDays?: number | null
  }): { token: string; grant: AgentGrantRow; user: UserRow; tenant: TenantRow | null } {
    const user = this.store.getUser(input.userId)
    if (!user || user.status !== 'active') {
      throw new Error('用户不存在或已被停用')
    }
    const tenant = user.tenant_id ? (this.store.getTenant(user.tenant_id) ?? null) : null
    if (tenant && tenant.status === 'suspended') {
      throw new Error('所属机构已暂停服务，无法签发 Agent 授权令牌')
    }
    if (input.nodePubkey) {
      // 校验公钥格式合法性
      parseEd25519PublicKey(input.nodePubkey)
    }
    const grantId = 'g_' + randomBytes(8).toString('hex')
    const secret = randomBytes(24).toString('base64url')
    const prefix = `aegis_at_${this.appId}`
    const token = `${prefix}.${grantId}.${secret}`
    const tokenHash = sha256Hex(token)
    const expiresAt =
      input.ttlDays === null
        ? null
        : new Date(Date.now() + Math.max(1, input.ttlDays ?? 90) * 86400_000).toISOString()

    const grant = this.store.createAgentGrant({
      id: grantId,
      app_id: this.appId,
      user_id: user.id,
      name: input.name?.trim() || 'Aegis-OS Workstation',
      token_hash: tokenHash,
      token_prefix: `${prefix}.${grantId}.${secret.slice(0, 4)}…`,
      aegis_node_pubkey: input.nodePubkey ?? null,
      tool_scope: input.toolScope ?? 'all',
      permissions: input.permissions ?? ['*'],
      doc_ids: input.docIds ?? null,
      write_mode: input.writeMode ?? 'tracked',
      user_token_version: user.token_version,
      expires_at: expiresAt,
    })

    return { token, grant, user, tenant }
  }

  /**
   * 校验 `Authorization: Bearer aegis_at_<app_id>.<grant_id>.<secret>`（或 `h1_agt.<grant_id>.<secret>`）：
   * 1. 解析 Grant ID 并常量时间比对 SHA-256 哈希
   * 2. 检查 Grant 未吊销、未过期
   * 3. 检查用户存在、`status === 'active'`、`user.token_version === grant.user_token_version`
   * 4. 检查用户当前所在租户未被暂停（`tenant.status !== 'suspended'`）
   */
  verifyGrantToken(rawToken: string, agentId?: string | null): { ok: true; verified: VerifiedAegisGrant } | { ok: false; code: string; error: string } {
    const token = rawToken.trim()
    const m = /^(?:aegis_at_[a-z0-9_-]+|h1_agt)\.(g_[a-zA-Z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token)
    if (!m) {
      return { ok: false, code: 'invalid_grant_format', error: '无效的 Aegis 应用授权令牌格式' }
    }
    const grantId = m[1]!
    const grant = this.store.getAgentGrant(grantId)
    if (!grant) {
      return { ok: false, code: 'grant_not_found', error: '授权令牌不存在' }
    }
    if (grant.revoked_at) {
      return { ok: false, code: 'grant_revoked', error: '该 Agent 授权令牌已被吊销' }
    }
    if (grant.expires_at && grant.expires_at <= new Date().toISOString()) {
      return { ok: false, code: 'grant_expired', error: '该 Agent 授权令牌已过期，请重新执行 aegis app login' }
    }

    // 兼容 h1_agt.<grant_id>.<secret> 别名：统一转换到 grant.app_id 前缀计算哈希或直接算原串
    const directHash = sha256Hex(token)
    const canonicalToken = token.startsWith('h1_agt.')
      ? `aegis_at_${grant.app_id}.${grantId}.${m[2]}`
      : token
    const canonicalHash = sha256Hex(canonicalToken)

    if (!safeHexEqual(grant.token_hash, directHash) && !safeHexEqual(grant.token_hash, canonicalHash)) {
      return { ok: false, code: 'invalid_grant_secret', error: '授权令牌密钥校验失败' }
    }

    const user = this.store.getUser(grant.user_id)
    if (!user || user.status !== 'active') {
      return { ok: false, code: 'user_disabled', error: '关联的医生/研究员账户已被停用' }
    }
    if (user.token_version !== grant.user_token_version) {
      return { ok: false, code: 'token_version_mismatch', error: '用户已修改密码或执行全端下线，请重新登录授权' }
    }

    const tenant = user.tenant_id ? (this.store.getTenant(user.tenant_id) ?? null) : null
    if (tenant && tenant.status === 'suspended') {
      return { ok: false, code: 'tenant_suspended', error: '所属医疗/科研机构已被暂停服务' }
    }

    this.store.touchAgentGrant(grant.id, agentId)
    return { ok: true, verified: { grant, user, tenant } }
  }

  /**
   * 校验 Tier 2 `[Lease-Gated]` 操作是否拥有有效租约：
   * - 优先验证请求头 `X-Aegis-Lease-Token` 的 Ed25519 签名（离线零往返）
   * - 其次查询服务端 `agent_leases` 表中由人工批准的活跃租约
   */
  verifyLease(input: {
    grant: AgentGrantRow
    agentId: string
    leaseTokenHeader?: string | null
    requiredScope: string
    requiredResource?: string
  }): { authorized: true; via: 'ed25519_header' | 'server_lease'; leaseId: string } | { authorized: false; reason: string } {
    const reqResource = input.requiredResource ?? '*'

    // 1. 若携带了 X-Aegis-Lease-Token，执行 Ed25519 验签与声明核验
    if (input.leaseTokenHeader && input.leaseTokenHeader.trim()) {
      if (!input.grant.aegis_node_pubkey) {
        return { authorized: false, reason: '当前 Grant 未绑定本地 Aegis-OS 节点 Ed25519 公钥，无法验签 X-Aegis-Lease-Token' }
      }
      const parts = input.leaseTokenHeader.trim().split('.')
      if (parts.length !== 2) {
        return { authorized: false, reason: 'X-Aegis-Lease-Token 格式非法（应为 <payload_b64url>.<sig_b64url>）' }
      }
      const payloadB64 = parts[0]!
      const sigB64 = parts[1]!
      try {
        const pubKey = parseEd25519PublicKey(input.grant.aegis_node_pubkey)
        const sigBuf = Buffer.from(sigB64, 'base64url')
        const validSig = cryptoVerify(null, Buffer.from(payloadB64, 'utf8'), pubKey, sigBuf)
        if (!validSig) {
          return { authorized: false, reason: 'X-Aegis-Lease-Token Ed25519 签名校验失败' }
        }
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as AegisLeasePayload
        const nowSec = Math.floor(Date.now() / 1000)
        if (payload.app !== this.appId) {
          return { authorized: false, reason: `Lease 目标应用不匹配（期望 ${this.appId}，实际 ${payload.app}）` }
        }
        if (payload.sub !== input.grant.id) {
          return { authorized: false, reason: `Lease sub 与当前 Grant ID 不匹配` }
        }
        if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
          return { authorized: false, reason: 'X-Aegis-Lease-Token 租约已过期' }
        }
        if (payload.agent && payload.agent !== '*' && payload.agent !== input.agentId) {
          return { authorized: false, reason: `Lease 绑定的 Agent (${payload.agent}) 与当前调用方 (${input.agentId}) 不一致` }
        }
        if (!matchLeasePattern(payload.scope, input.requiredScope)) {
          return { authorized: false, reason: `Lease 作用域 (${payload.scope}) 未覆盖所需操作 (${input.requiredScope})` }
        }
        if (!matchLeasePattern(payload.resource ?? '*', reqResource)) {
          return { authorized: false, reason: `Lease 资源范围 (${payload.resource}) 未覆盖目标资源 (${reqResource})` }
        }
        return { authorized: true, via: 'ed25519_header', leaseId: payload.iss || 'lease-ed25519' }
      } catch (err) {
        return { authorized: false, reason: `X-Aegis-Lease-Token 解析或验签异常：${(err as Error).message}` }
      }
    }

    // 2. 检查服务端已批准的短期租约表 agent_leases
    const activeLeases = this.store.listActiveAgentLeases(input.grant.id)
    for (const l of activeLeases) {
      const agentOk = l.agent_id === '*' || l.agent_id === input.agentId
      const scopeOk = matchLeasePattern(l.scope, input.requiredScope)
      const resOk = matchLeasePattern(l.resource, reqResource)
      if (agentOk && scopeOk && resOk) {
        return { authorized: true, via: 'server_lease', leaseId: l.id }
      }
    }

    return { authorized: false, reason: `操作 ${input.requiredScope} 属于 [Lease-Gated] 敏感动作，需医生/研究员审批授权` }
  }
}
