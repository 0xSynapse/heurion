import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { generateAegisNodeKeyPair, signAegisLeaseToken } from '../src/aegis/auth.ts'
import {
  defineAegisManifest,
  extractAegisHeaders,
  formatApprovalRequired,
  issueAegisGrantTokenString,
  parseAegisGrantTokenString,
  verifyAegisLeaseToken,
} from '../../../packages/aegis-app-sdk/src/index.ts'
import { buildAegisManifest } from '../src/aegis/manifest.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { DatasetService } from '../src/datasets/service.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { moduleOf } from '../src/mcp/modules.ts'
import type { McpDeps } from '../src/mcp/server.ts'
import { ClaimService } from '../src/claims/service.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import { TurnService } from '../src/turns/service.ts'

function createTestEnv(opts: { aegisEnabled?: boolean; provenance?: boolean; mcpDeps?: (base: { docs: Documents; ops: OpService; registry: TurnRegistry; dir: string }) => McpDeps } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heurion-aegis-'))
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs, undefined, undefined, { provenance: opts.provenance ?? false })
  const registry = new TurnRegistry()
  const accounts = new Accounts(store, {
    secret: 'test-secret',
    devMode: false,
    devToken: 'dev',
    devUser: 'dev',
    botGuard: { issue: () => ({} as never), verify: () => {} } as never,
  })
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const patients = new PatientService(
    join(dir, 'tenants'),
    tenants,
    keys,
    store,
    {
      pages: async (_name, _mime, bytes) => [new TextDecoder().decode(bytes)],
      complete: async () =>
        JSON.stringify({
          report_date: '2026-03-01',
          labs: [{ test_name: '肌酐', value: 128, unit: 'umol/L', ref_low: 44, ref_high: 97, flag: 'H' }],
        }),
    },
    ({ owner, title }) => docs.create({ owner, title }).id,
  )
  const datasets = new DatasetService(store, join(dir, 'ds'), async () => {
    const outDir = mkdtempSync(join(dir, 'ds-out-'))
    const csvPath = join(outDir, 'data.csv')
    writeFileSync(csvPath, 'arm,age\nA,62\nB,58\n')
    return {
      csv: csvPath,
      cleanup: () => {},
      profile: {
        ok: true,
        rows: 2,
        truncated: false,
        columns: [
          { name: 'arm', type: 'categorical', missing: 0, unique: 2 },
          { name: 'age', type: 'numeric', missing: 0, unique: 2 },
        ],
      },
    }
  })
  const app = buildApi({
    docs,
    ops,
    turns: new TurnService(docs, {} as HarnessPool, registry),
    turnRegistry: registry,
    postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient,
    pubmed: {} as PubMedClient,
    renderer: new SlideRenderer(join(dir, 'render')),
    accounts,
    devMode: false,
    aegisEnabled: opts.aegisEnabled ?? true,
    devUser: 'dev',
    patients,
    datasets,
    workspaceDir: () => dir,
    ...(opts.mcpDeps ? { mcpDeps: opts.mcpDeps({ docs, ops, registry, dir }) } : {}),
  })

  // 注册一名医生用户（首个用户为平台运营 + 个人机构管理员）
  const reg = accounts.register(
    {
      username: 'dr_zhang',
      password: 'Password123!',
      display_name: '张主任',
    },
    '127.0.0.1',
  )

  /** 通过 /api/aegis/mcp 发送 MCP JSON-RPC tools/call 请求 */
  const callAegisTool = async (
    token: string,
    toolName: string,
    args: Record<string, unknown>,
    headers: {
      agentId?: string
      orgId?: string
      turnId?: string
      leaseToken?: string
    } = {},
  ) => {
    const reqHeaders: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    }
    if (headers.agentId) reqHeaders['x-aegis-agent-id'] = headers.agentId
    if (headers.orgId) reqHeaders['x-aegis-org-id'] = headers.orgId
    if (headers.turnId) reqHeaders['x-aegis-turn-id'] = headers.turnId
    if (headers.leaseToken) reqHeaders['x-aegis-lease-token'] = headers.leaseToken

    const res = await app.request('/api/aegis/mcp', {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    })
    const status = res.status
    const turnIdHeader = res.headers.get('x-aegis-turn-id')
    const rawJson = (await res.json()) as any
    if (status !== 200) {
      return { status, isError: true, body: rawJson, turnIdHeader }
    }
    const rpcResult = rawJson.result as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    const firstText = rpcResult?.content?.[0]?.text ?? ''
    let parsed: any = firstText
    try {
      parsed = JSON.parse(firstText)
    } catch {}
    return {
      status,
      isError: Boolean(rpcResult?.isError),
      body: parsed,
      text: firstText,
      turnIdHeader,
    }
  }

  return { app, store, docs, ops, accounts, tenants, patients, datasets, reg, callAegisTool }
}

describe('Aegis Application Protocol (AAP-1.0) & Heurion 2.0 第一方集成', () => {
  it('0. 未开放 Aegis（HEURION_AEGIS 默认关闭）：接口与发现清单一律 404，/api/me 告诉前端不显示终端授权', async () => {
    const { app, reg } = createTestEnv({ aegisEnabled: false })
    const auth = { Authorization: `Bearer ${reg.token}` }
    expect((await app.request('/.well-known/aegis-app.json')).status).toBe(404)
    expect((await app.request('/.well-known/aegis-skills/heurion-clinical-research/SKILL.md')).status).toBe(404)
    expect((await app.request('/api/aegis/auth/grants', { headers: auth })).status).toBe(404)
    expect((await app.request('/api/aegis/auth/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    expect((await app.request('/api/aegis/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    const me = await (await app.request('/api/me', { headers: auth })).json() as { aegis: boolean }
    expect(me.aegis).toBe(false)
  })

  it('1. Manifest 自描述与自动发现：GET /.well-known/aegis-app.json 符合 AAP-1.0 规范', async () => {
    const { app } = createTestEnv()
    const res = await app.request('/.well-known/aegis-app.json')
    expect(res.status).toBe(200)
    const manifest = (await res.json()) as any
    expect(manifest.schema_version).toBe('AAP-1.0')
    expect(manifest.app_id).toBe('heurion')
    expect(manifest.trust_tier).toBe('first_party')
    expect(manifest.endpoints.mcp_http).toBe('/api/aegis/mcp')
    expect(manifest.auth.token_prefix).toBe('aegis_at_heurion.')
    expect(manifest.auth.supports_lease_verification).toBe('ed25519')
    expect(manifest.capabilities_preview.some((c: any) => c.name === 'doc_edit' && c.tier === 'zero_prompt')).toBe(true)
    expect(manifest.capabilities_preview.some((c: any) => c.name === 'lab_resolve' && c.tier === 'lease_gated')).toBe(true)
  })

  it('2. 统一鉴权与身份生命周期联动：签发 aegis_at_heurion.*、兼容 h1_agt.*、机构校验、全端下线与吊销即刻失效', async () => {
    const { app, store, reg, callAegisTool } = createTestEnv()
    const nodeKeys = generateAegisNodeKeyPair()

    // 通过账号密码或 Session 签发 Aegis Grant Token，并绑定本地 Aegis-OS 节点 Ed25519 公钥
    const issueRes = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'dr_zhang',
        password: 'Password123!',
        name: 'MacBook-Pro-Aegis',
        node_pubkey: nodeKeys.publicKey,
        tool_scope: 'all',
      }),
    })
    expect(issueRes.status).toBe(201)
    const issued = (await issueRes.json()) as any
    expect(issued.access_token).toMatch(/^aegis_at_heurion\.g_[0-9a-f]+\.[A-Za-z0-9_-]+$/)
    expect(issued.bound_user.id).toBe(reg.user.id)
    expect(issued.bound_node_pubkey).toBe(nodeKeys.publicKey)

    const token = issued.access_token as string
    // 验证正常调用 MCP
    const listRes = await callAegisTool(token, 'doc_list', {}, { agentId: 'agent-main' })
    expect(listRes.status).toBe(200)
    expect(listRes.isError).toBe(false)

    // 验证 h1_agt.<grant_id>.<secret> 简写别名兼容
    const aliasToken = token.replace(/^aegis_at_heurion\./, 'h1_agt.')
    const aliasRes = await callAegisTool(aliasToken, 'doc_list', {}, { agentId: 'agent-main' })
    expect(aliasRes.status).toBe(200)

    // 验证跨机构请求头拦截 (X-Aegis-Org-Id 不匹配 -> 403 org_mismatch)
    const wrongOrg = await callAegisTool(token, 'doc_list', {}, { agentId: 'agent-main', orgId: 't_other_hospital' })
    expect(wrongOrg.status).toBe(403)
    expect(wrongOrg.body.code).toBe('org_mismatch')

    // 查看用户已绑定的 Aegis Grants 列表
    const grantsRes = await app.request('/api/aegis/auth/grants', {
      headers: { authorization: `Bearer ${reg.token}` },
    })
    expect(grantsRes.status).toBe(200)
    const grantsJson = (await grantsRes.json()) as any
    expect(grantsJson.grants).toHaveLength(1)
    expect(grantsJson.grants[0].last_agent_id).toBe('agent-main')

    // 吊销该令牌（模拟 `aegis app logout heurion`）
    const revokeRes = await app.request('/api/aegis/auth/token', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(revokeRes.status).toBe(200)
    const afterRevoke = await callAegisTool(token, 'doc_list', {})
    expect(afterRevoke.status).toBe(401)
    expect(afterRevoke.body.code).toBe('grant_revoked')

    // 重新签发一枚令牌，测试用户在 Web 端执行「全端强制下线」（token_version + 1）后立即失效
    const issue2 = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Workstation-2', node_pubkey: nodeKeys.publicKey }),
    })
    const token2 = ((await issue2.json()) as any).access_token as string
    expect((await callAegisTool(token2, 'doc_list', {})).status).toBe(200)

    await app.request('/api/auth/logout-everywhere', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}` },
    })
    const afterLogoutAll = await callAegisTool(token2, 'doc_list', {})
    expect(afterLogoutAll.status).toBe(401)
    expect(afterLogoutAll.body.code).toBe('token_version_mismatch')

    // 重新登录并签发第三枚令牌，测试账户被停用后立即失效
    const relogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dr_zhang', password: 'Password123!' }),
    })
    const newSessionToken = ((await relogin.json()) as any).token as string
    const issue3 = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${newSessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Workstation-3' }),
    })
    const token3 = ((await issue3.json()) as any).access_token as string
    store.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(reg.user.id)
    const afterDisabled = await callAegisTool(token3, 'doc_list', {})
    expect(afterDisabled.status).toBe(401)
    expect(afterDisabled.body.code).toBe('user_disabled')
  })

  it('3. 多智能体 [Zero-Prompt] 并发协作与按 Agent 回合精准 CoW 回滚 (doc_revert_turn)', async () => {
    const { app, reg, callAegisTool } = createTestEnv()
    const issueRes = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Multi-Agent-Swarm' }),
    })
    const { access_token: token } = (await issueRes.json()) as any

    // 创建一篇含两个章节的论文草稿
    const created = await callAegisTool(
      token,
      'doc_create',
      {
        title: 'DAPA-HF 队列真实世界研究',
        markdown: '# 引言\n\n心衰背景待补充。\n\n# 统计结果\n\n生存分析结果待补充。',
      },
      { agentId: 'agent-lead', turnId: 'init-doc' },
    )
    expect(created.isError).toBe(false)
    const docId = created.body.doc_id as string

    const read0 = await callAegisTool(token, 'doc_read', { doc_id: docId }, { agentId: 'agent-lead' })
    const introParaId = /\{#([a-z0-9]+)\} 心衰背景待补充。/.exec(read0.text?.replace(/[⟦⟧]/g, "") ?? '')![1]!
    const statsParaId = /\{#([a-z0-9]+)\} 生存分析结果待补充。/.exec(read0.text?.replace(/[⟦⟧]/g, "") ?? '')![1]!

    // Agent 1 (agent-writer) 修改「引言」段落
    const editWriter = await callAegisTool(
      token,
      'doc_edit',
      {
        doc_id: docId,
        base_rev: created.body.rev,
        ops: [{ op: 'replace_text', id: introParaId, find: '心衰背景待补充。', replace: '射血分数降低型心衰患者预后较差。' }],
      },
      { agentId: 'agent-writer', turnId: 'turn-w1' },
    )
    expect(editWriter.isError).toBe(false)
    expect(editWriter.turnIdHeader).toBe('aegis:agent-writer:turn-w1')

    // Agent 2 (agent-stats) 并发修改「统计结果」段落
    const editStats = await callAegisTool(
      token,
      'doc_edit',
      {
        doc_id: docId,
        base_rev: editWriter.body.rev,
        ops: [{ op: 'replace_text', id: statsParaId, find: '生存分析结果待补充。', replace: '治疗组 24 个月累积生存率为 86.4%（P<0.001）。' }],
      },
      { agentId: 'agent-stats', turnId: 'turn-s1' },
    )
    expect(editStats.isError).toBe(false)
    expect(editStats.turnIdHeader).toBe('aegis:agent-stats:turn-s1')

    const readBoth = await callAegisTool(token, 'doc_read', { doc_id: docId }, { agentId: 'agent-lead' })
    expect(readBoth.text).toContain('射血分数降低型心衰患者预后较差。')
    expect(readBoth.text).toContain('治疗组 24 个月累积生存率为 86.4%（P<0.001）。')

    // 精准回滚 agent-writer 的回合（保留其后 agent-stats 的修改！）
    const revertWriter = await callAegisTool(
      token,
      'doc_revert_turn',
      { doc_id: docId, agent_id: 'agent-writer' },
      { agentId: 'agent-lead' },
    )
    expect(revertWriter.isError).toBe(false)
    expect(revertWriter.body.reverted_turn_id).toBe('aegis:agent-writer:turn-w1')

    const readAfterRevert = await callAegisTool(token, 'doc_read', { doc_id: docId }, { agentId: 'agent-lead' })
    // 读视图用 ⟦⟧ 标出 AI 未确认的文字：比较去掉标记后的文字
    const afterText = (readAfterRevert.text ?? '').replace(/[⟦⟧]/g, '')
    expect(afterText).toContain('心衰背景待补充。')
    expect(afterText).toContain('治疗组 24 个月累积生存率为 86.4%（P<0.001）。')
  })

  it('4. [Lease-Gated] 提权拦截、Ed25519 节点公钥离线验签与服务端租约审批', async () => {
    const { app, tenants, reg, callAegisTool } = createTestEnv()
    const nodeKeys = generateAegisNodeKeyPair()
    const rogueKeys = generateAegisNodeKeyPair()

    // 开启机构「AI 写入患者数据需医生审核」策略
    tenants.update(reg.user.id, { settings: { ai_patient_writes: 'review' } })

    const issueRes = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Clinical-Node',
        node_pubkey: nodeKeys.publicKey,
      }),
    })
    const { access_token: token, grant_id: grantId } = (await issueRes.json()) as any

    // 4.1 临床审核 [Lease-Gated]：Agent 建档并上传化验报告（[Zero-Prompt] 允许直接完成提取并进入 pending）
    const ptCreated = await callAegisTool(token, 'patient_create', { sex: 'M', birth_year: 1962, tags: ['心衰'] }, { agentId: 'agent-clinical' })
    const patientId = ptCreated.body.patient_id as string

    const reportB64 = Buffer.from('姓名：王某某\n肌酐 128 umol/L (44-97)', 'utf8').toString('base64')
    const uploaded = await callAegisTool(
      token,
      'report_upload',
      { patient_id: patientId, data_base64: reportB64, filename: 'lab.txt', report_date: '2026-03-01' },
      { agentId: 'agent-clinical' },
    )
    expect(uploaded.isError).toBe(false)
    const recordId = uploaded.body.record_id as string

    // 未携带 Lease 调用 report_resolve -> 返回 approval_required 与 escalation_id
    const unleasedResolve = await callAegisTool(
      token,
      'report_resolve',
      { patient_id: patientId, record_id: recordId, action: 'confirm' },
      { agentId: 'agent-clinical' },
    )
    expect(unleasedResolve.isError).toBe(false)
    expect(unleasedResolve.body.status).toBe('approval_required')
    expect(unleasedResolve.body.escalation_id).toMatch(/^esc-heurion-/)
    expect(unleasedResolve.body.suggested_lease_scope).toContain('action=heurion:clinical_confirm')

    // 携带伪造私钥签名的 X-Aegis-Lease-Token -> 验签失败，仍返回 approval_required
    const nowSec = Math.floor(Date.now() / 1000)
    const forgedLease = signAegisLeaseToken(
      {
        iss: 'lease-forged',
        sub: grantId,
        app: 'heurion',
        agent: 'agent-clinical',
        scope: 'heurion:clinical_confirm',
        resource: patientId,
        iat: nowSec,
        exp: nowSec + 600,
      },
      rogueKeys.privateKeyPem,
    )
    const forgedAttempt = await callAegisTool(
      token,
      'report_resolve',
      { patient_id: patientId, record_id: recordId, action: 'confirm' },
      { agentId: 'agent-clinical', leaseToken: forgedLease },
    )
    expect(forgedAttempt.body.status).toBe('approval_required')
    expect(forgedAttempt.body.reason).toContain('签名校验失败')

    // 签名合法但有效期超过 15 分钟的离线租约 -> 拒绝，避免一张租约长期替代人工审批
    const longLease = signAegisLeaseToken(
      { iss: 'lease-too-long', sub: grantId, app: 'heurion', agent: 'agent-clinical', scope: 'heurion:clinical_confirm', resource: patientId, iat: nowSec, exp: nowSec + 3600 },
      nodeKeys.privateKeyPem,
    )
    const longAttempt = await callAegisTool(
      token,
      'report_resolve',
      { patient_id: patientId, record_id: recordId, action: 'confirm' },
      { agentId: 'agent-clinical', leaseToken: longLease },
    )
    expect(longAttempt.body.status).toBe('approval_required')
    expect(longAttempt.body.reason).toContain('有效期过长')

    // 携带由绑定的本地 Aegis-OS 节点私钥签发的合法 X-Aegis-Lease-Token -> 零往返验签通过并直接完成确认！
    const validLease = signAegisLeaseToken(
      {
        iss: 'lease-ed25519-001',
        sub: grantId,
        app: 'heurion',
        agent: 'agent-clinical',
        scope: 'heurion:clinical_confirm',
        resource: patientId,
        iat: nowSec,
        exp: nowSec + 600,
      },
      nodeKeys.privateKeyPem,
    )
    const leasedResolve = await callAegisTool(
      token,
      'report_resolve',
      { patient_id: patientId, record_id: recordId, action: 'confirm' },
      { agentId: 'agent-clinical', leaseToken: validLease },
    )
    expect(leasedResolve.isError).toBe(false)
    expect(leasedResolve.body).toMatchObject({
      result: 'confirm',
      lease_authorized: true,
      lease_id: 'lease-ed25519-001',
      lease_via: 'ed25519_header',
    })

    // 4.2 管理类高危操作 [Lease-Gated]（如彻底删除回收站文档 doc_manage.purge）+ 服务端批准 escalation_id
    const tempDoc = await callAegisTool(token, 'doc_create', { title: '待彻底删除草稿' }, { agentId: 'agent-cleaner' })
    const tempDocId = tempDoc.body.doc_id as string
    await callAegisTool(token, 'doc_manage', { action: 'trash', doc_id: tempDocId }, { agentId: 'agent-cleaner' })

    // 首次调用 purge（无 Lease）-> 返回 approval_required 与 escalation_id
    const purgeUnleased = await callAegisTool(
      token,
      'doc_manage',
      { action: 'purge', doc_id: tempDocId, reason: '清理废弃测试草稿' },
      { agentId: 'agent-cleaner' },
    )
    expect(purgeUnleased.body.status).toBe('approval_required')
    const escId = purgeUnleased.body.escalation_id as string
    expect(escId).toMatch(/^esc-heurion-/)

    // 医生本人在 Web/CLI 调用 POST /api/aegis/leases/approve 批准该 escalation_id
    const approveRes = await app.request('/api/aegis/leases/approve', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ escalation_id: escId, ttl_secs: 600 }),
    })
    expect(approveRes.status).toBe(200)
    const approveBody = (await approveRes.json()) as any
    expect(approveBody.lease.id).toMatch(/^lease-heurion-/)

    // 批准后 Agent 重试同一操作 -> 自动匹配服务端活跃租约并执行成功！
    const purgeLeased = await callAegisTool(
      token,
      'doc_manage',
      { action: 'purge', doc_id: tempDocId },
      { agentId: 'agent-cleaner' },
    )
    expect(purgeLeased.isError).toBe(false)
    expect(purgeLeased.body.lease_authorized).toBe(true)
    expect(purgeLeased.body.lease_via).toBe('server_lease')
  })

  it('5. CoW 沙箱桥接：支持无共享目录的 Base64 资产上传与内联分析代码溯源 (asset_upload)', async () => {
    const { app, datasets, reg, callAegisTool } = createTestEnv()
    const issueRes = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'CoW-Sandbox-Node' }),
    })
    const { access_token: token } = (await issueRes.json()) as any

    const ds = datasets.upload(reg.user.id, 'dapa_cohort.csv', new TextEncoder().encode('arm,age\nA,62\nB,58\n')).dataset
    await datasets.idle()

    // 模拟在 Aegis-OS CoW 隔离沙箱内生成的 PNG 与 Python 分析脚本，经 HTTP MCP 直接上传
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
    const inlinePy = 'import lifelines\n# Kaplan-Meier survival curve generated in Aegis-OS CoW sandbox\n'

    const up = await callAegisTool(
      token,
      'asset_upload',
      {
        data_base64: pngBase64,
        filename: 'km_dapa.png',
        code: inlinePy,
        dataset_ids: [ds.id],
      },
      { agentId: 'agent-biostat', turnId: 'km-turn-01' },
    )
    expect(up.isError).toBe(false)
    expect(up.body.asset_id).toMatch(/^a/)
    expect(up.body.provenance).toBe('已记录代码与数据来源')

    // 验证平台资产溯源接口记录了内联代码、数据集版本与 Agent 回合 ID
    const provRes = await app.request(`/api/assets/${up.body.asset_id}/provenance`, {
      headers: { authorization: `Bearer ${reg.token}` },
    })
    expect(provRes.status).toBe(200)
    const prov = (await provRes.json()) as any
    expect(prov.code).toContain('Kaplan-Meier survival curve')
    expect(prov.datasets[0]).toMatchObject({ id: ds.id, name: 'dapa_cohort', rows: 2 })
    expect(prov.turn_id).toBe('aegis:agent-biostat:km-turn-01')
  })

  it('6. CoW 沙箱下行数据桥接：dataset_open 与 labs_open 在 Aegis-OS 调用下自动内联返回 csv_content', async () => {
    const { app, datasets, patients, reg, callAegisTool } = createTestEnv()
    const issueRes = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'CoW-Downlink-Node' }),
    })
    const { access_token: token } = (await issueRes.json()) as any

    const ds = datasets.upload(reg.user.id, 'cohort_downlink.csv', new TextEncoder().encode('arm,age\nA,62\nB,58\n')).dataset
    await datasets.idle()

    // 1) dataset_open 通过 /api/aegis/mcp 带 X-Aegis-Agent-Id 调用时自动返回 csv_content
    const dsOpened = await callAegisTool(
      token,
      'dataset_open',
      { dataset_id: ds.id },
      { agentId: 'agent-biostat' },
    )
    expect(dsOpened.isError).toBe(false)
    expect(dsOpened.body.path).toBe(`data/${ds.id}.csv`)
    expect(dsOpened.body.csv_content).toContain('arm,age\nA,62\nB,58')

    // 2) 患者化验长表 labs_open 同样返回去标识化 csv_content
    const pt = await callAegisTool(token, 'patient_create', { sex: 'F', birth_year: 1970 }, { agentId: 'agent-clinical' })
    const patientId = pt.body.patient_id as string
    const reportB64 = Buffer.from('肌酐 128 umol/L', 'utf8').toString('base64')
    const up = await callAegisTool(
      token,
      'report_upload',
      { patient_id: patientId, data_base64: reportB64, filename: 'lab.txt', kind: 'lab_report', report_date: '2026-03-01' },
      { agentId: 'agent-clinical' },
    )
    await callAegisTool(
      token,
      'report_lab_add',
      { patient_id: patientId, record_id: up.body.record_id, test_name: '肌酐', value: 128, unit: 'umol/L', ref_low: 44, ref_high: 97 },
      { agentId: 'agent-clinical' },
    )
    const confirmRec = await app.request(`/api/patients/${patientId}/records/${up.body.record_id}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}` },
    })
    expect(confirmRec.status).toBe(200)

    const labsOpened = await callAegisTool(
      token,
      'labs_open',
      { patient_id: patientId },
      { agentId: 'agent-biostat' },
    )
    expect(labsOpened.isError).toBe(false)
    expect(labsOpened.body.rows).toBe(1)
    expect(labsOpened.body.csv_content).toContain('128')
  })

  it('7. Web 端提权申请查询与拒绝接口：GET /api/aegis/leases/escalations 与 POST /api/aegis/leases/reject', async () => {
    const { app, reg, callAegisTool } = createTestEnv()
    const issueRes = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Escalation-UI-Test' }),
    })
    const { access_token: token } = (await issueRes.json()) as any

    const doc = await callAegisTool(token, 'doc_create', { title: '拟清理草稿' }, { agentId: 'agent-1' })
    await callAegisTool(token, 'doc_manage', { action: 'trash', doc_id: doc.body.doc_id }, { agentId: 'agent-1' })

    const purgeAttempt = await callAegisTool(
      token,
      'doc_manage',
      { action: 'purge', doc_id: doc.body.doc_id, reason: '尝试彻底删除' },
      { agentId: 'agent-1' },
    )
    expect(purgeAttempt.body.status).toBe('approval_required')
    const escId = purgeAttempt.body.escalation_id as string

    // 查询待处理的提权申请列表
    const listRes = await app.request('/api/aegis/leases/escalations?status=pending', {
      headers: { authorization: `Bearer ${reg.token}` },
    })
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as any
    expect(listBody.escalations.some((e: any) => e.id === escId && e.status === 'pending')).toBe(true)

    // 医生在界面拒绝该提权申请
    const rejectRes = await app.request('/api/aegis/leases/reject', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ escalation_id: escId }),
    })
    expect(rejectRes.status).toBe(200)
    const rejectBody = (await rejectRes.json()) as any
    expect(rejectBody.escalation.status).toBe('rejected')

    // 拒绝后再次批准应返回 409 already_decided
    const approveAfterReject = await app.request('/api/aegis/leases/approve', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ escalation_id: escId }),
    })
    expect(approveAfterReject.status).toBe(409)
  })

  it('8. SDK 与平台同一份实现：平台清单通过 SDK 校验；令牌、请求头、离线租约、需要租约的返回', () => {
    const manifest = defineAegisManifest(buildAegisManifest())
    expect(manifest.schema_version).toBe('AAP-1.0')
    expect(() => defineAegisManifest({ ...manifest, schema_version: 'aegis-app/1.0' as 'AAP-1.0' })).toThrow()

    const tokenObj = issueAegisGrantTokenString('acme-bio-eln')
    expect(tokenObj.rawToken).toMatch(/^aegis_at_acme-bio-eln\.g_[0-9a-f]+\./)
    const parsed = parseAegisGrantTokenString(tokenObj.rawToken, 'acme-bio-eln')
    expect(parsed?.grantId).toBe(tokenObj.grantId)
    expect(parsed?.tokenHash).toBe(tokenObj.tokenHash)
    expect(parseAegisGrantTokenString(tokenObj.rawToken, 'heurion')).toBeNull()

    const headers = extractAegisHeaders({
      Authorization: `Bearer ${tokenObj.rawToken}`,
      'X-Aegis-Agent-Id': 'hermes-01',
      'X-Aegis-Session-Id': 'sess-99',
      'X-Aegis-Turn-Id': 'turn-7',
    })
    expect(headers).toMatchObject({ agentId: 'hermes-01', sessionId: 'sess-99', turnId: 'turn-7' })

    // 平台导出的签名函数就是 SDK 的：用它签的租约，SDK 验签通过；改了作用域或超过 15 分钟则拒绝
    const kp = generateAegisNodeKeyPair()
    const nowSec = Math.floor(Date.now() / 1000)
    const payload = { iss: 'lease-1', sub: tokenObj.grantId, app: 'acme-bio-eln', agent: 'hermes-01', scope: 'acme-bio-eln:sign.*', resource: 'exp-42', iat: nowSec, exp: nowSec + 300 }
    const expectOk = { appId: 'acme-bio-eln', grantId: tokenObj.grantId, agentId: 'hermes-01', scope: 'acme-bio-eln:sign.experiment', resource: 'exp-42' }
    expect(verifyAegisLeaseToken(signAegisLeaseToken(payload, kp.privateKeyPem), kp.publicKey, expectOk).ok).toBe(true)
    expect(verifyAegisLeaseToken(signAegisLeaseToken(payload, kp.privateKeyPem), kp.publicKey, { ...expectOk, scope: 'acme-bio-eln:delete' }).ok).toBe(false)
    expect(verifyAegisLeaseToken(signAegisLeaseToken({ ...payload, exp: nowSec + 3600 }, kp.privateKeyPem), kp.publicKey, expectOk).ok).toBe(false)

    const errPayload = formatApprovalRequired({ escalation_id: 'esc-acme-001', scope: 'acme-bio-eln:sign.experiment', resource: 'exp-42', reason: '签章归档不可撤销' })
    expect(errPayload.status).toBe('approval_required')
    expect(errPayload.suggested_lease_scope).toBe('action=acme-bio-eln:sign.experiment, resource=exp-42')
  })

  it('9. RFC 8628 设备码免密终端绑定与第一方智能体技能包自动发现', async () => {
    const { app, reg, callAegisTool } = createTestEnv()
    const kp = generateAegisNodeKeyPair()

    // 1. 校验 Manifest 暴露了 skills 列表以及第一方 SKILL.md 端点可读
    const mfRes = await app.request('/.well-known/aegis-app.json')
    const mf = (await mfRes.json()) as any
    expect(Array.isArray(mf.skills)).toBe(true)
    expect(mf.skills.some((s: any) => s.name === 'heurion-clinical-research')).toBe(true)
    const skillRes = await app.request('/.well-known/aegis-skills/heurion-clinical-research/SKILL.md')
    expect(skillRes.status).toBe(200)
    const skillText = await skillRes.text()
    expect(skillText).toContain('name: heurion-clinical-research')

    // 2. 终端执行 `aegis-os app login heurion` 请求设备授权码
    const devRes = await app.request('/api/aegis/auth/device', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Hermes-MacBook-Pro',
        node_pubkey: kp.publicKey,
        tool_scope: 'all',
        write_mode: 'tracked',
      }),
    })
    expect(devRes.status).toBe(201)
    const devBody = (await devRes.json()) as any
    expect(devBody.device_code).toMatch(/^dc_[0-9a-f]{32}$/)
    expect(devBody.user_code).toMatch(/^HEUR-[A-Z0-9]{4}-[A-Z0-9]{4}$/)

    // 3. 医生尚未确认前，终端轮询 /api/aegis/auth/token 返回 428 authorization_pending
    const pollPending = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: devBody.device_code }),
    })
    expect(pollPending.status).toBe(428)
    const pendingBody = (await pollPending.json()) as any
    expect(pendingBody.code).toBe('authorization_pending')

    // 4. 医生在已登录的浏览器设置页输入 8 位设备码确认绑定
    const approveRes = await app.request('/api/aegis/auth/device/approve', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${reg.token}`,
        'content-type': 'application/json',
      },
      // 用户手输时常省略连字符、用小写：服务端归一化
      body: JSON.stringify({ user_code: devBody.user_code.replace(/-/g, '').toLowerCase() }),
    })
    expect(approveRes.status).toBe(200)
    const approveBody = (await approveRes.json()) as any
    expect(approveBody.ok).toBe(true)
    expect(approveBody.user_code).toBe(devBody.user_code)

    // 5. 终端再次轮询 /api/aegis/auth/token 成功换取一次性 aegis_at_heurion.* 令牌
    const pollOk = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: devBody.device_code }),
    })
    expect(pollOk.status).toBe(201)
    const tokenBody = (await pollOk.json()) as any
    expect(tokenBody.access_token).toMatch(/^aegis_at_heurion\.g_[0-9a-f]+\./)
    expect(tokenBody.bound_node_pubkey).toBe(kp.publicKey)

    // 6. 同一 device_code 不可二次重放兑换（防止窃取）
    const pollReplay = await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: devBody.device_code }),
    })
    expect(pollReplay.status).toBe(400)
    expect(((await pollReplay.json()) as any).code).toBe('token_already_consumed')

    // 7. 使用兑换出的令牌调用 MCP 工具验证可用
    const created = await callAegisTool(
      tokenBody.access_token,
      'doc_create',
      { title: '设备码免密登录测试文稿' },
      { agentId: 'hermes-device-1' },
    )
    expect(created.isError).toBe(false)
    expect(created.body.doc_id).toBeTruthy()
  })
})

describe('AAP-1.0 网关（阶段 1：一个处理函数、与 dsh 同一份依赖）', () => {
  const issue = async (app: ReturnType<typeof createTestEnv>['app']) => {
    const res = await app.request('/api/aegis/auth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dr_zhang', password: 'Password123!', name: 'test-node', node_pubkey: generateAegisNodeKeyPair().publicKey, tool_scope: 'all' }),
    })
    return ((await res.json()) as { access_token: string }).access_token
  }
  const rpc = (app: ReturnType<typeof createTestEnv>['app'], token: string, body: unknown, accept?: string) => app.request('/api/aegis/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-aegis-agent-id': 'agent-p1', ...(accept ? { accept } : {}) },
    body: JSON.stringify(body),
  })

  it('标准 MCP 客户端：initialize 握手、声明 SSE 的客户端也拿到 JSON、批量请求、通知', async () => {
    const { app } = createTestEnv()
    const token = await issue(app)
    const init = await rpc(app, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agy', version: '0' } } }, 'application/json, text/event-stream')
    expect(init.status).toBe(200)
    expect(init.headers.get('content-type')).toContain('application/json')
    expect(init.headers.get('x-aegis-turn-id')).toMatch(/^aegis:agent-p1:/)
    expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('heurion')

    const batch = await rpc(app, token, [
      { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'doc_list', arguments: {} } },
      { jsonrpc: '2.0', id: 'b', method: 'tools/list', params: {} },
    ])
    expect(batch.status).toBe(200)
    const out = (await batch.json()) as Array<{ id: string; result: { content?: unknown; tools?: Array<{ name: string }> } }>
    expect(out.map(r => r.id).sort()).toEqual(['a', 'b'])
    expect(out.find(r => r.id === 'b')!.result.tools!.some(t => t.name === 'doc_edit')).toBe(true)

    const note = await rpc(app, token, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(note.status).toBe(202)
  })

  it('网关用的是传入的 dsh 依赖；但不挂子专家委派、工具失败不记进 dsh 的执行信号', async () => {
    const failures: Array<{ code: string }> = []
    const searched: string[] = []
    const { app } = createTestEnv({
      mcpDeps: ({ docs, ops, registry, dir }) => ({
        docs, ops, turns: registry, secret: 's', claims: new ClaimService(docs, {} as PubMedClient), renderer: new SlideRenderer(join(dir, 'r2')),
        pubmed: { search: async (q: string) => { searched.push(q); return [] } } as unknown as PubMedClient,
        crossref: {} as CrossrefClient, workspaceDir: () => dir, isLiveSession: () => true,
        subagents: {} as McpDeps['subagents'],
        executionSignals: { recordToolFailure: (f: { code: string }) => { failures.push(f) } } as unknown as McpDeps['executionSignals'],
      }),
    })
    const token = await issue(app)
    const search = await rpc(app, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pubmed_search', arguments: { query: 'esophageal cancer' } } })
    expect(search.status).toBe(200)
    expect(searched).toEqual(['esophageal cancer'])
    const tools = (await (await rpc(app, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as { result: { tools: Array<{ name: string }> } }
    expect(tools.result.tools.map(t => t.name)).not.toContain('delegate_task')
    const res = await rpc(app, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'doc_read', arguments: { doc_id: 'no-such-doc' } } })
    expect(((await res.json()) as { result: { isError: boolean } }).result.isError).toBe(true)
    expect(failures).toEqual([])
  })

  it('不带 JSON Content-Type 的请求（如 curl -d）也按 JSON-RPC 处理', async () => {
    const { app } = createTestEnv()
    const token = await issue(app)
    const res = await app.request('/api/aegis/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0)
  })

  it('旧的 /api/mcp 别名已移除；网关只接受 POST', async () => {
    const { app } = createTestEnv()
    const token = await issue(app)
    expect((await app.request('/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status).not.toBe(200)
    expect((await app.request('/api/aegis/mcp', { method: 'GET', headers: { authorization: `Bearer ${token}` } })).status).not.toBe(200)
  })
})

describe('AAP-1.0 按模块开放（阶段 2）', () => {
  const issue = async (app: ReturnType<typeof createTestEnv>['app'], grant: Record<string, unknown>) => {
    const res = await app.request('/api/aegis/auth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dr_zhang', password: 'Password123!', name: 'node', node_pubkey: generateAegisNodeKeyPair().publicKey, ...grant }),
    })
    return { status: res.status, body: (await res.json()) as { access_token: string; modules?: Record<string, string>; error?: string } }
  }
  const rpc = async (app: ReturnType<typeof createTestEnv>['app'], token: string, path: string, method: string, params: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-aegis-agent-id': 'agent-m', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    return { status: res.status, body: (await res.json()) as any }
  }
  const toolNames = async (app: ReturnType<typeof createTestEnv>['app'], token: string, path = '/api/aegis/mcp') =>
    ((await rpc(app, token, path, 'tools/list', {})).body.result.tools as Array<{ name: string }>).map(t => t.name)

  it('清单按模块注册表生成：九个模块、各自地址；列出的工具都真实存在，不再有虚构能力', async () => {
    const { app } = createTestEnv()
    const manifest = (await (await app.request('/.well-known/aegis-app.json')).json()) as any
    expect(manifest.modules.map((m: any) => m.id)).toEqual(['writing', 'literature', 'analysis', 'patients', 'imaging', 'research', 'knowledge', 'memory', 'admin'])
    expect(manifest.modules[0].mcp_http).toBe('/api/aegis/mcp/writing')
    const all = new Set(await toolNames(app, (await issue(app, { tool_scope: 'all' })).body.access_token))
    const listed = [
      ...manifest.capabilities_preview.map((c: any) => c.name),
      ...manifest.modules.flatMap((m: any) => [...m.read_only_tools, ...Object.keys(m.lease_gated)]),
    ]
    expect(listed.filter((n: string) => !all.has(n))).toEqual([])
    for (const fake of ['dataset_analyze', 'phr_share_admin', 'mail_admin']) expect(listed).not.toContain(fake)
  })

  it('按模块的地址只挂该模块；未授权的模块 403、不存在的模块 404', async () => {
    const { app } = createTestEnv()
    const { body } = await issue(app, { modules: 'writing:rw,literature:r' })
    expect(body.modules).toEqual({ writing: 'rw', literature: 'r' })
    const lit = await toolNames(app, body.access_token, '/api/aegis/mcp/literature')
    expect(lit).toContain('pubmed_search')
    expect(lit).not.toContain('insert_citation') // 只读权限
    expect(lit).not.toContain('doc_edit') // 别的模块
    const writing = await toolNames(app, body.access_token, '/api/aegis/mcp/writing')
    expect(writing).toContain('doc_edit')
    expect(writing).not.toContain('pubmed_search')
    const all = await toolNames(app, body.access_token)
    expect(all).toContain('doc_edit')
    expect(all).toContain('pubmed_search')
    expect(all).not.toContain('patient_read')
    const denied = await rpc(app, body.access_token, '/api/aegis/mcp/patients', 'tools/list', {})
    expect(denied.status).toBe(403)
    expect(denied.body.code).toBe('module_not_granted')
    expect((await rpc(app, body.access_token, '/api/aegis/mcp/nope', 'tools/list', {})).status).toBe(404)
  })

  it('模块权限校验：未知模块、空权限拒绝签发；授权列表返回实际生效的模块与模块目录', async () => {
    const { app } = createTestEnv()
    expect((await issue(app, { modules: 'writing:rw,secret:rw' })).status).toBe(400)
    expect((await issue(app, { modules: {} })).status).toBe(400)
    expect((await issue(app, { modules: { writing: 'admin' } })).status).toBe(400)
    const { body } = await issue(app, { modules: { knowledge: 'r' } })
    const tools = await toolNames(app, body.access_token)
    expect(tools.sort()).toEqual(['kb_read', 'kb_search'])
  })

  it('旧的 tool_scope 换算成模块权限：clinical 不含研究、research 不含患者、readonly 不含写工具', async () => {
    const { app } = createTestEnv()
    const clinical = await toolNames(app, (await issue(app, { tool_scope: 'clinical' })).body.access_token)
    expect(clinical).toContain('patient_read')
    expect(clinical).toContain('doc_edit')
    expect(clinical.some(n => n.startsWith('study_'))).toBe(false)
    expect(clinical).not.toContain('tenant_admin')
    const research = await toolNames(app, (await issue(app, { tool_scope: 'research' })).body.access_token)
    expect(research).toContain('study_list')
    expect(research).not.toContain('patient_read')
    const canvas = await toolNames(app, (await issue(app, { tool_scope: 'canvas' })).body.access_token)
    expect(canvas.every(n => ['writing', 'literature'].includes(String(moduleOf(n))))).toBe(true)
    const ro = await toolNames(app, (await issue(app, { tool_scope: 'readonly' })).body.access_token)
    expect(ro).toContain('doc_read')
    expect(ro).not.toContain('doc_edit')
  })

  it('观察记录跨模块、跨回合共享：同一会话读到的数字可以写进另一篇稿件；换个会话就不算看到过', async () => {
    const { app, store, docs } = createTestEnv({ provenance: true })
    const token = (await issue(app, { tool_scope: 'all' })).body.access_token
    const call = (path: string, name: string, args: Record<string, unknown>, headers: Record<string, string>) =>
      rpc(app, token, path, 'tools/call', { name, arguments: args }, headers).then(r => r.body.result as { isError?: boolean; content: Array<{ text: string }> })
    // 来源文稿由用户本人写（AI 新建文稿时写数字同样要有出处）
    const owner = store.getUserByName('dr_zhang')!.id
    const srcId = docs.create({ owner, title: '来源', markdown: '中位随访 37.6 个月。' }).id
    const target = await call('/api/aegis/mcp/writing', 'doc_create', { title: '目标', markdown: '随访结果待补充。' }, { 'x-aegis-session-id': 's1', 'x-aegis-turn-id': 't0' })
    const tgt = JSON.parse(target.content[0]!.text) as { doc_id: string; rev: number }
    // 换一个模块地址、换一个回合读来源（患者 / 影像等模块读到的结果同理）
    expect((await call('/api/aegis/mcp', 'doc_read', { doc_id: srcId }, { 'x-aegis-session-id': 's1', 'x-aegis-turn-id': 't1' })).isError).toBeFalsy()
    const read = await call('/api/aegis/mcp/writing', 'doc_read', { doc_id: tgt.doc_id }, { 'x-aegis-session-id': 's1', 'x-aegis-turn-id': 't1' })
    const para = /\{#([a-z0-9]+)\} 随访结果待补充。/.exec(read.content[0]!.text.replace(/[⟦⟧]/g, ''))![1]!
    const edit = (session: string, rev: number) => call('/api/aegis/mcp', 'doc_edit', {
      doc_id: tgt.doc_id, base_rev: rev, ops: [{ op: 'replace_text', id: para, find: '随访结果待补充。', replace: '中位随访 37.6 个月。' }],
    }, { 'x-aegis-session-id': session, 'x-aegis-turn-id': 't2' })
    const other = await edit('s2', tgt.rev)
    expect(other.isError).toBe(true)
    expect(other.content[0]!.text).toContain('unobserved_number')
    const same = await edit('s1', tgt.rev)
    expect(same.isError, same.content[0]?.text).toBeFalsy()
  })
})
