/**
 * 专家审阅页（review/expert-review.ts）：管理员上传题目包得到私密链接；医生凭链接读题、逐条存答案、下载测试稿；
 * 替换题目包时链接与答案不变；只有管理员能上传和导出，AI 不能上传。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import { makeInvoker } from '../src/http/invoke.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { ReviewError, progress, validatePackage } from '../src/review/expert-review.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

const SECRET = 'test-secret'

// 测试数据：按上传时的原样 JSON 处理（各章节结构不同，用 any 便于逐处改坏）
const PKG: any = {
  title: '论文一专家审阅',
  intro: ['感谢您的帮助。'],
  sections: [
    {
      id: 'consent', title: '同意', items: [{
        key: 'consent', questions: [
          { key: 'use', label: '同意使用？', type: 'choice', options: ['同意', '不同意'] },
          { key: 'why', label: '不同意的原因', type: 'text', when: { key: 'use', values: ['不同意'] } },
        ],
      }],
    },
    {
      id: 's1', title: '全文核对', items: [{
        key: 's1-01', title: 'HR 0.62', blocks: [{ label: 'AI 写的句子', text: 'HR 为 0.62。', highlight: ['0.62'], compare: { label: '原文', text: '……' } }],
        links: [{ label: 'DOI', url: 'https://doi.org/10.1/x' }], files: ['P01.docx'],
        questions: [{ key: 'found', label: '全文里有这个数吗？', type: 'choice', options: ['有', '没有', '拿不到全文'] }, { key: 'note', label: '备注', type: 'text', optional: true }],
      }],
    },
  ],
}
const FILES = { 'P01.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', b64: Buffer.from('PK-fake-docx').toString('base64') } }

function env() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {}, workspaceDir: () => '/tmp' } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }) })
  const app = buildApi({
    docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'er-r-'))), accounts, devMode: false, devUser: 'dev',
  })
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let data: any = text
    try { data = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, data, headers: res.headers }
  }
  const register = async (username: string) => {
    const pow = solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge)
    return (await call('POST', '/api/auth/register', undefined, { username, password: 'password-123', pow })).data as { token: string; user: { id: string } }
  }
  return { store, app, call, register, invoke: makeInvoker(app) }
}

describe('题目包校验', () => {
  it('合法的题目包规整后保留已知字段', () => {
    const pkg = validatePackage({ ...PKG, extra: 'x' }, new Set(['P01.docx']))
    expect(pkg.sections[1]!.items[0]!.blocks![0]!.compare?.label).toBe('原文')
    expect((pkg as unknown as Record<string, unknown>).extra).toBeUndefined()
  })
  it('附件没上传、键重复、条件指向后面的问题、非 https 链接：拒绝', () => {
    const bad = (p: unknown, files = ['P01.docx']) => { try { validatePackage(p, new Set(files)); return null } catch (e) { return (e as ReviewError).message } }
    expect(bad(PKG, [])).toContain('没有上传')
    expect(bad({ ...PKG, sections: [PKG.sections[0], { ...PKG.sections[0], id: 'x' }] })).toContain('重复')
    const swapped = structuredClone(PKG)
    swapped.sections[0]!.items[0]!.questions.reverse()
    expect(bad(swapped)).toContain('前面的问题')
    const http = structuredClone(PKG)
    http.sections[1]!.items[0]!.links![0]!.url = 'http://x'
    expect(bad(http)).toContain('https')
  })
  it('进度：选填题不计；条件题只在条件满足时计入', () => {
    const pkg = validatePackage(PKG, new Set(['P01.docx']))
    expect(progress(pkg, {}).total).toBe(2)
    expect(progress(pkg, { 'consent.use': '不同意' }).total).toBe(3)
    expect(progress(pkg, { 'consent.use': '同意', 's1-01.found': '有' })).toMatchObject({ answered: 2, total: 2 })
  })
})

describe('专家审阅接口', () => {
  it('管理员上传得到链接；医生凭链接读题、存答案、下载测试稿；错误答案拒绝；替换题目包时答案保留', async () => {
    const t = env()
    const admin = await t.register('admin')
    const up = await t.call('POST', '/api/admin/expert-reviews', admin.token, { package: PKG, files: FILES })
    expect(up.status).toBe(200)
    expect(up.data.path).toBe(`/review/${up.data.token}`)
    // 库里只有 token 的哈希
    expect(JSON.stringify(t.store.listExpertReviews())).not.toContain(up.data.token)
    const api = `/api/public/expert-review/${up.data.token}`

    const got = await t.call('GET', api)
    expect(got.status).toBe(200)
    expect(got.data.package.title).toBe('论文一专家审阅')
    expect(got.data.progress).toMatchObject({ answered: 0, total: 2 })

    const saved = await t.call('PUT', `${api}/answers`, undefined, { answers: [{ key: 'consent.use', value: '同意' }, { key: 's1-01.note', value: '见第 3 页' }] })
    expect(saved.status).toBe(200)
    expect(saved.data.progress).toMatchObject({ answered: 1, total: 2 })
    expect((await t.call('PUT', `${api}/answers`, undefined, { answers: [{ key: 's1-01.found', value: '也许' }] })).status).toBe(400)
    expect((await t.call('PUT', `${api}/answers`, undefined, { answers: [{ key: 'nope.x', value: '有' }] })).status).toBe(400)
    // 清除一条
    await t.call('PUT', `${api}/answers`, undefined, { answers: [{ key: 's1-01.note', value: '' }] })
    expect((await t.call('GET', api)).data.answers).toEqual({ 'consent.use': '同意' })

    const file = await t.app.request(`${api}/files/P01.docx`)
    expect(file.status).toBe(200)
    expect(await file.text()).toBe('PK-fake-docx')
    expect(file.headers.get('content-disposition')).toContain('P01.docx')
    expect((await t.app.request(`${api}/files/other.docx`)).status).toBe(404)

    // 补题：同一个 id 重新上传，链接不变、答案保留
    const more = structuredClone(PKG)
    more.sections[1]!.items.push({ ...more.sections[1]!.items[0]!, key: 's1-02' })
    const re = await t.call('POST', '/api/admin/expert-reviews', admin.token, { id: up.data.id, package: more, files: FILES })
    expect(re.data.replaced).toBe(true)
    const after = await t.call('GET', api)
    expect(after.data.package.sections[1].items).toHaveLength(2)
    expect(after.data.answers['consent.use']).toBe('同意')

    const exp = await t.call('GET', `/api/admin/expert-reviews/${up.data.id}/answers`, admin.token)
    expect(exp.data.answers).toHaveLength(1)
    expect(t.store.listAudit({ action: 'expert_review.export' })).toHaveLength(1)
  })

  it('错误或过短的链接：404；不需要登录也不会泄露别的审阅', async () => {
    const t = env()
    const admin = await t.register('admin')
    await t.call('POST', '/api/admin/expert-reviews', admin.token, { package: PKG, files: FILES })
    expect((await t.call('GET', '/api/public/expert-review/abc')).status).toBe(404)
    expect((await t.call('GET', `/api/public/expert-review/${'x'.repeat(32)}`)).status).toBe(404)
    expect((await t.call('PUT', `/api/public/expert-review/${'x'.repeat(32)}/answers`, undefined, { answers: [] })).status).toBe(404)
  })

  it('只有平台管理员能上传、列表、导出；AI 不能上传', async () => {
    const t = env()
    const admin = await t.register('admin')
    const user = await t.register('user1')
    expect((await t.call('POST', '/api/admin/expert-reviews', undefined, { package: PKG, files: FILES })).status).toBe(401)
    expect((await t.call('POST', '/api/admin/expert-reviews', user.token, { package: PKG, files: FILES })).status).toBe(403)
    expect((await t.call('GET', '/api/admin/expert-reviews', user.token)).status).toBe(403)
    const ai = await t.invoke(admin.user.id, 'POST', '/api/admin/expert-reviews', { json: { package: PKG, files: FILES } }, { via: 'ai' })
    expect(ai.status).toBe(403)
    expect((await t.call('GET', '/api/admin/expert-reviews', admin.token)).data).toHaveLength(0)
    const bad = await t.call('POST', '/api/admin/expert-reviews', admin.token, { package: PKG, files: {} })
    expect(bad.status).toBe(400)
  })
})
