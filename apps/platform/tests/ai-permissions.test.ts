import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import { H_AS, H_INTERNAL, makeInvoker } from '../src/http/invoke.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry, type TurnNotice } from '../src/mcp/turns.ts'
import { MemoryService } from '../src/memory/service.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

/**
 * AI 的权限与用户本人一致（docs/design/AI_PERMISSIONS.md）：
 * 管理员的 AI 能做管理员能做的事，普通成员的 AI 不能；高风险操作只生成确认卡，用户本人确认后才执行，AI 不能确认自己的操作。
 */
const SECRET = 'test-secret'

async function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {}, workspaceDir: () => ws } as unknown as HarnessPool
  const ws = mkdtempSync(join(tmpdir(), 'aiperm-ws-'))
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  const memory = new MemoryService(store, null)
  const registry = new TurnRegistry()
  const ops = new OpService(docs)
  const app = buildApi({
    docs, ops, turns: new TurnService(docs, pool, registry, { memory }), postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'aiperm-r-'))), accounts, devMode: false, devUser: 'dev', memory,
  })
  const invoke = makeInvoker(app)
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    if (/^\/api\/auth\/register$/.test(path)) body = { ...(body as object), pow: solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge) }
    const res = await app.request(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json }
  }
  const register = async (username: string, invite?: string) => (await call('POST', '/api/auth/register', undefined, { username, password: 'passw0rd123', ...(invite ? { invite } : {}) })).json
  const op = await register('operator')
  const org = (await call('POST', '/api/platform/tenants', op.token, { name: '医院 A' })).json
  const admin = await register('admin1', org.invite.code)
  const inv = (await call('POST', '/api/tenant/invites', admin.token, { role: 'member' })).json
  const member = await register('member1', inv.code)
  const notices: TurnNotice[] = []
  const connect = async (userId: string) => {
    registry.begin(userId, { turnId: `turn-${userId}`, touched: new Set(), notify: n => notices.push(n), mode: 'apply' })
    const claims = verifyToken(SECRET, issueToken(SECRET, { u: userId, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const server = buildMcpServer({
      docs, ops, turns: registry, secret: SECRET, claims: new ClaimService(docs, {} as PubMedClient), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'aiperm-r2-'))),
      pubmed: {} as PubMedClient, crossref: {} as CrossrefClient, workspaceDir: () => ws, isLiveSession: () => true, memory, invoke,
    }, claims)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'aiperm', version: '0' })
    await client.connect(b)
    return async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text?: string }> }
      return { isError: !!r.isError, data: JSON.parse(r.content.map(c => c.text ?? '').join('')) as any }
    }
  }
  return { store, app, call, invoke, op, admin, member, org, connect, notices, ws }
}

describe('AI 的权限 = 用户的权限', () => {
  it('普通成员的 AI 调管理工具被拒；管理员的 AI 可以做常规管理（直接生效，审计 via=ai）', async () => {
    const t = await setup()
    const asMember = await t.connect(t.member.user.id)
    const denied = await asMember('tenant_admin', { action: 'update_settings', settings: { ai_patient_writes: 'direct' }, reason: '测试' })
    expect(denied.isError).toBe(true)
    expect(denied.data.code).toBe('forbidden')
    expect((await asMember('tenant_admin', { action: 'audit' })).isError).toBe(true)
    expect((await asMember('platform_admin', { action: 'tenants' })).isError).toBe(true)
    expect((await asMember('org_template', { action: 'create', label: '模板', org_name: '医院 A' })).isError).toBe(true)

    const asAdmin = await t.connect(t.admin.user.id)
    const me = await asAdmin('account', { action: 'view' })
    expect(me.data.tenant.role).toBe('admin')
    const tpl = await asAdmin('org_template', { action: 'create', label: '省立模板', org_name: '医院 A', preset: 'ahslyy' })
    expect(tpl.isError).toBe(false)
    expect((await asAdmin('org_template', { action: 'list' })).data.templates.some((x: any) => x.id === tpl.data.id)).toBe(true)
    const audit = t.store.listAudit({ tenant: t.org.tenant.id }).find(a => a.action === 'tenant.template_create')
    expect(audit?.via).toBe('ai')
    expect(audit?.actor).toBe(t.admin.user.id)
    // 管理员的 AI 也看得到本机构审计（与管理员本人一致）
    expect((await asAdmin('tenant_admin', { action: 'audit' })).isError).toBe(false)
  })

  it('高风险操作只生成确认卡；AI 不能确认；用户确认后以用户身份执行（审计 via=ai-confirmed、confirmed_by）', async () => {
    const t = await setup()
    const asAdmin = await t.connect(t.admin.user.id)
    const r = await asAdmin('tenant_admin', { action: 'update_settings', settings: { ai_patient_writes: 'direct' }, reason: '科室决定 AI 补录直接生效' })
    expect(r.data.status).toBe('pending_confirmation')
    expect(t.notices.some(n => n.type === 'action' && n.action.id === r.data.action_id)).toBe(true)
    // 还没生效
    expect((await t.call('GET', '/api/tenant', t.admin.token)).json.settings.ai_patient_writes).toBe('review')

    // AI 自己确认：进程内调用（AI 的身份）一律拒绝；MCP 也没有确认工具
    const self = await t.invoke(t.admin.user.id, 'POST', `/api/actions/${r.data.action_id}/confirm`, { json: {} })
    expect(self.status).toBe(403)
    // 伪造的进程内调用头（网络上来的）当作未登录
    const forged = await t.app.request(`/api/actions/${r.data.action_id}/confirm`, { method: 'POST', headers: { [H_INTERNAL]: 'guess', [H_AS]: t.admin.user.id } })
    expect(forged.status).toBe(401)
    // 别人不能确认
    expect((await t.call('POST', `/api/actions/${r.data.action_id}/confirm`, t.member.token, {})).status).toBe(404)

    const ok = await t.call('POST', `/api/actions/${r.data.action_id}/confirm`, t.admin.token, {})
    expect(ok.status).toBe(200)
    expect(ok.json.status).toBe('done')
    expect((await t.call('GET', '/api/tenant', t.admin.token)).json.settings.ai_patient_writes).toBe('direct')
    const entry = t.store.listAudit({ tenant: t.org.tenant.id }).find(a => a.action === 'tenant.update')
    expect(entry).toMatchObject({ actor: t.admin.user.id, via: 'ai-confirmed', confirmed_by: t.admin.user.id })
    // 不能确认第二次
    expect((await t.call('POST', `/api/actions/${r.data.action_id}/confirm`, t.admin.token, {})).status).toBe(409)
    expect((await asAdmin('action_status', { action_id: r.data.action_id })).data.status).toBe('done')
  })

  it('HTTP 层兜底：需确认的接口，AI 未经确认直接调用一律拒绝；经确认卡（ai-confirmed）才执行', async () => {
    const t = await setup()
    const user = t.admin.user.id
    // 清空记忆是需确认的操作：AI 直接调接口被拒
    const direct = await t.invoke(user, 'DELETE', '/api/memory')
    expect(direct.status).toBe(403)
    expect((direct.json as any).code).toBe('confirmation_required')
    // 同一接口，用户确认后执行
    const confirmed = await t.invoke(user, 'DELETE', '/api/memory', undefined, { via: 'ai-confirmed', confirmedBy: user })
    expect(confirmed.status).toBeLessThan(300)
    // 带路径参数的需确认接口也挡得住；不需确认的同前缀接口不受影响
    expect((await t.invoke(user, 'DELETE', '/api/docs/abc/purge')).status).toBe(403)
    expect((await t.invoke(user, 'GET', '/api/memory')).status).toBe(200)
  })

  it('拒绝、过期；确认卡上可改的字段（紧急访问理由）', async () => {
    const t = await setup()
    const asAdmin = await t.connect(t.admin.user.id)
    const a = await asAdmin('platform_admin', { action: 'tenants' })
    expect(a.isError).toBe(true) // 机构管理员不是平台运营

    const r1 = await asAdmin('tenant_admin', { action: 'invite', invite_role: 'admin', reason: '新来的主任' })
    expect(r1.data.status).toBe('pending_confirmation')
    expect((await t.call('POST', `/api/actions/${r1.data.action_id}/reject`, t.admin.token, {})).json.status).toBe('rejected')
    expect((await t.call('GET', '/api/tenant/invites', t.admin.token)).json.filter((i: any) => i.role === 'admin')).toEqual([])

    const r2 = await asAdmin('tenant_admin', { action: 'invite', reason: '过期测试' })
    t.store.db.prepare('UPDATE pending_actions SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 25 * 3600_000).toISOString(), r2.data.action_id)
    const late = await t.call('POST', `/api/actions/${r2.data.action_id}/confirm`, t.admin.token, {})
    expect(late.status).toBe(409)
    expect((await asAdmin('action_status', { action_id: r2.data.action_id })).data.status).toBe('expired')

    // 平台运营的 AI 能管机构（需确认）
    const asOp = await t.connect(t.op.user.id)
    expect((await asOp('platform_admin', { action: 'tenants' })).data.length).toBeGreaterThan(0)
    const r3 = await asOp('platform_admin', { action: 'create_tenant', name: '医院 C', reason: '新签约' })
    expect(r3.data.status).toBe('pending_confirmation')
    const done = await t.call('POST', `/api/actions/${r3.data.action_id}/confirm`, t.op.token, {})
    expect(done.json.status).toBe('done')
    expect((await t.call('GET', '/api/platform/tenants', t.op.token)).json.some((x: any) => x.name === '医院 C')).toBe(true)
  })

  it('院徽：AI 用工作区文件上传需确认；文件只能来自工作区', async () => {
    const t = await setup()
    const asAdmin = await t.connect(t.admin.user.id)
    const tpl = await asAdmin('org_template', { action: 'create', label: '模板', org_name: '医院 A' })
    writeFileSync(join(t.ws, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#004098"/></svg>')
    expect((await asAdmin('org_template', { action: 'set_logo', template_id: tpl.data.id, file_path: '/etc/hosts' })).data.code).toBe('outside_workspace')
    const r = await asAdmin('org_template', { action: 'set_logo', template_id: tpl.data.id, file_path: 'logo.svg', reason: '官方院徽' })
    expect(r.data.status).toBe('pending_confirmation')
    expect((await t.call('POST', `/api/actions/${r.data.action_id}/confirm`, t.admin.token, {})).json.status).toBe('done')
    expect((await t.call('GET', '/api/tenant/templates', t.admin.token)).json.templates.find((x: any) => x.id === tpl.data.id).has_logo).toBe(true)
  })
})
