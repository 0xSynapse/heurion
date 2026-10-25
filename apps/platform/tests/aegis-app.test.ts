import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { generateAegisNodeKeyPair, signAegisLeaseToken } from '../src/aegis/auth.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { DatasetService } from '../src/datasets/service.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import { TurnService } from '../src/turns/service.ts'

function createTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'heurion-aegis-'))
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
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
    devUser: 'dev',
    patients,
    datasets,
    workspaceDir: () => dir,
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
    const introParaId = /\{#([a-z0-9]+)\} 心衰背景待补充。/.exec(read0.text ?? "")![1]!
    const statsParaId = /\{#([a-z0-9]+)\} 生存分析结果待补充。/.exec(read0.text ?? "")![1]!

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
    expect(readAfterRevert.text).toContain('心衰背景待补充。')
    expect(readAfterRevert.text).toContain('治疗组 24 个月累积生存率为 86.4%（P<0.001）。')
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
})
