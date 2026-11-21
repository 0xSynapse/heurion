import { randomBytes } from 'node:crypto'
// 令牌、租约的格式与验签只有一份实现，在 SDK 里（第三方应用与平台逐字一致）
import {
  type AegisLeasePayload,
  generateAegisNodeKeyPair,
  MAX_OFFLINE_LEASE_SEC,
  matchLeasePattern,
  parseEd25519PrivateKey,
  parseEd25519PublicKey,
  safeEqualHex,
  sha256Hex,
  signAegisLeaseToken,
  verifyAegisLeaseToken,
} from './sdk.ts'
import { secureRandomInt } from '../auth/random.ts'
import { parseModuleGrant } from '../mcp/modules.ts'
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

export interface VerifiedAegisGrant {
  grant: AgentGrantRow
  user: UserRow
  tenant: TenantRow | null
}

export { MAX_OFFLINE_LEASE_SEC, generateAegisNodeKeyPair, matchLeasePattern, parseEd25519PrivateKey, parseEd25519PublicKey, signAegisLeaseToken }
export type { AegisLeasePayload }

/** 规范化模块权限为存库的 JSON；不给返回 null（按 tool_scope 换算）。格式不对抛错。 */
function normalizeModules(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null
  return JSON.stringify(parseModuleGrant(input))
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
    /** pat = 个人访问令牌 `hr_pat.<id>.<secret>`（通用 MCP）；不给 = AAP-1.0 令牌 `aegis_at_<app>.…` */
    kind?: 'pat' | 'oauth' | 'aap'
    userId: string
    name?: string
    nodePubkey?: string | null
    toolScope?: AgentGrantRow['tool_scope']
    /** 模块权限（JSON 对象、`writing:rw,literature:r` 或模块数组）；给了就以它为准，不给按 toolScope 换算。 */
    modules?: unknown
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
    // 个人访问令牌（hr_pat）：给任何 MCP 客户端用的通用令牌，与 AAP-1.0 无关；aegis_at_<app> 是 AAP 兼容令牌（计划停用）
    const prefix = input.kind === 'pat' ? 'hr_pat' : input.kind === 'oauth' ? 'hr_oat' : `aegis_at_${this.appId}`
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
      modules: normalizeModules(input.modules),
      permissions: input.permissions ?? ['*'],
      doc_ids: input.docIds ?? null,
      write_mode: input.writeMode ?? 'tracked',
      user_token_version: user.token_version,
      expires_at: expiresAt,
    })

    return { token, grant, user, tenant }
  }

  /**
   * RFC 8628 设备码模式第 1 步：由 `aegis-os app login heurion` 发起免密终端绑定请求，
   * 生成 `device_code` 与供医生在浏览器输入的 8 位短码 `user_code`（如 `HEUR-A8F2`）。
   */
  createDeviceCode(input: {
    name?: string
    nodePubkey?: string | null
    toolScope?: AgentGrantRow['tool_scope']
    /** 模块权限（JSON 对象、`writing:rw,literature:r` 或模块数组）；给了就以它为准，不给按 toolScope 换算。 */
    modules?: unknown
    writeMode?: AgentGrantRow['write_mode']
    ttlSecs?: number
  }): {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
    expires_at: string
  } {
    if (input.nodePubkey) {
      parseEd25519PublicKey(input.nodePubkey)
    }
    const deviceCode = 'dc_' + randomBytes(16).toString('hex')
    // 排除易混淆字符 0/O/1/I，生成 8 位大写字母数字短码 HEUR-XXXX-XXXX（32^8 ≈ 40 bit，4 位只有 20 bit 可被穷举）
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
    let suffix = ''
    for (let i = 0; i < 8; i++) {
      suffix += alphabet[secureRandomInt(alphabet.length)]
    }
    const userCode = `HEUR-${suffix.slice(0, 4)}-${suffix.slice(4)}`
    const ttlSecs = Math.max(30, Math.min(1800, input.ttlSecs ?? 600))
    const row = this.store.createAgentDeviceCode({
      device_code: deviceCode,
      user_code: userCode,
      app_id: this.appId,
      name: input.name?.trim() || 'Aegis-OS Workstation',
      aegis_node_pubkey: input.nodePubkey ?? null,
      tool_scope: input.toolScope ?? 'all',
      modules: normalizeModules(input.modules),
      write_mode: input.writeMode ?? 'tracked',
      ttl_secs: ttlSecs,
    })
    return {
      device_code: row.device_code,
      user_code: row.user_code,
      verification_uri: `/app?aegis_device=${encodeURIComponent(row.user_code)}`,
      expires_in: ttlSecs,
      interval: 2,
      expires_at: row.expires_at,
    }
  }

  /**
   * RFC 8628 设备码模式第 2 步：已登录的医生/研究员在 Web 设置页输入 `user_code` 确认绑定。
   */
  approveDeviceCode(input: {
    userCode: string
    userId: string
    toolScope?: AgentGrantRow['tool_scope']
    /** 模块权限（JSON 对象、`writing:rw,literature:r` 或模块数组）；给了就以它为准，不给按 toolScope 换算。 */
    modules?: unknown
    writeMode?: AgentGrantRow['write_mode']
    ttlDays?: number | null
  }): { grant: AgentGrantRow; user: UserRow; tenant: TenantRow | null; user_code: string } {
    const normalized = input.userCode.trim().toUpperCase().replace(/\s+/g, '')
    const bare = normalized.replace(/^HEUR-?/, '').replace(/-/g, '')
    const formatted = bare.length === 8 ? `HEUR-${bare.slice(0, 4)}-${bare.slice(4)}` : `HEUR-${bare}`
    const row = this.store.getAgentDeviceCodeByUserCode(formatted) ?? this.store.getAgentDeviceCodeByUserCode(normalized)
    if (!row) {
      throw new Error('未找到该设备授权码，请核对终端显示的 8 位短码（如 HEUR-XXXX-XXXX）')
    }
    if (row.status !== 'pending') {
      throw new Error('该设备授权码已被使用或已失效')
    }
    if (row.expires_at <= new Date().toISOString()) {
      throw new Error('该设备授权码已过期，请在终端重新执行 aegis-os app login')
    }
    const issued = this.issueGrant({
      userId: input.userId,
      name: row.name,
      nodePubkey: row.aegis_node_pubkey,
      toolScope: input.toolScope ?? row.tool_scope,
      // 用户在确认页另选了范围就以确认页为准；否则沿用终端发起时请求的模块
      modules: input.modules ?? (input.toolScope ? undefined : row.modules ?? undefined),
      writeMode: input.writeMode ?? row.write_mode,
      ttlDays: input.ttlDays === undefined ? 90 : input.ttlDays,
    })
    const updated = this.store.approveAgentDeviceCode(row.user_code, input.userId, issued.grant.id, issued.token)
    if (!updated) {
      throw new Error('设备授权码状态已变更，请勿重复确认')
    }
    return {
      grant: issued.grant,
      user: issued.user,
      tenant: issued.tenant,
      user_code: row.user_code,
    }
  }

  /**
   * RFC 8628 设备码模式第 3 步：`aegis-os app login` 轮询 `POST /api/aegis/auth/token` 兑换一次性 `aegis_at_heurion.*` 令牌。
   */
  pollDeviceCode(deviceCode: string):
    | { status: 'approved'; token: string; grant: AgentGrantRow; user: UserRow; tenant: TenantRow | null }
    | { status: 'pending' | 'expired' | 'consumed' | 'invalid'; error: string } {
    const row = this.store.getAgentDeviceCode(deviceCode.trim())
    if (!row) {
      return { status: 'invalid', error: '无效的 device_code' }
    }
    if (row.status === 'consumed') {
      return { status: 'consumed', error: '该设备码已成功兑换令牌，请勿重复使用' }
    }
    if (row.expires_at <= new Date().toISOString()) {
      return { status: 'expired', error: '设备授权码已过期，请重新发起 aegis-os app login' }
    }
    if (row.status === 'pending') {
      return { status: 'pending', error: `等待用户在浏览器输入设备码 ${row.user_code} 确认绑定` }
    }
    const consumedToken = this.store.consumeAgentDeviceCode(row.device_code)
    if (!consumedToken || !row.grant_id || !row.user_id) {
      return { status: 'consumed', error: '该设备码已被兑换使用' }
    }
    const grant = this.store.getAgentGrant(row.grant_id)
    const user = this.store.getUser(row.user_id)
    if (!grant || !user) {
      return { status: 'invalid', error: '关联的授权记录或用户不存在' }
    }
    const tenant = user.tenant_id ? (this.store.getTenant(user.tenant_id) ?? null) : null
    return { status: 'approved', token: consumedToken, grant, user, tenant }
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
    const m = /^(?:aegis_at_[a-z0-9_-]+|h1_agt|hr_pat|hr_oat)\.(g_[a-zA-Z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token)
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

    if (!safeEqualHex(grant.token_hash, directHash) && !safeEqualHex(grant.token_hash, canonicalHash)) {
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
      const check = verifyAegisLeaseToken(input.leaseTokenHeader, input.grant.aegis_node_pubkey, {
        appId: this.appId, grantId: input.grant.id, agentId: input.agentId, scope: input.requiredScope, resource: reqResource,
      })
      if (!check.ok) return { authorized: false, reason: check.reason }
      return { authorized: true, via: 'ed25519_header', leaseId: check.payload.iss || 'lease-ed25519' }
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
