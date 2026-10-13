import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

const SECRET = 'test-secret'

/** 测试用发信器：记下每封邮件（取验证码）。 */
function fakeMailer() {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  return {
    configured: true,
    available: true,
    mode: 'dev-mock' as const,
    sent,
    async send(to: string, subject: string, text: string) {
      sent.push({ to, subject, text })
      return { success: true, mode: 'simulated' as const, messageId: 'mock-msg-id' }
    },
    code: () => /(\d{6})/.exec(sent.at(-1)?.text ?? '')?.[1],
  }
}

function env(devMode = true) {
  const mailer = fakeMailer()
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
  // 测试用低难度、不限最短填写时间
  const accounts = new Accounts(store, { secret: SECRET, devMode, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 300, minDelayMs: 0 }), mailer })
  const app = buildApi({
    docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))),
    accounts, devMode, devUser: 'dev',
  })
  const pow = async () => solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge)
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    // 注册 / 登录自动带上人机校验的解（专门测防机器人的用例自己传 pow）
    if (/^\/api\/auth\/(register|login|password-code)$/.test(path) && body && typeof body === 'object' && !('pow' in body)) body = { ...body, pow: await pow() }
    const res = await app.request(path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data: any = text
    try { data = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, data }
  }
  const register = async (username: string, password = 'secret123') => {
    const r = await call('POST', '/api/auth/register', undefined, { username, password })
    expect(r.status).toBe(201)
    return r.data as { token: string; user: { id: string; role: string } }
  }
  return { store, docs, accounts, call, register, pow, mailer }
}

describe('账户：注册与登录', () => {
  it('第一个注册的用户是管理员，之后是普通用户；用户名不区分大小写唯一', async () => {
    const t = env()
    expect((await t.call('GET', '/api/auth/config')).data).toEqual({ has_users: false, dev_mode: true })
    const a = await t.register('Alice')
    const b = await t.register('bob')
    expect([a.user.role, b.user.role]).toEqual(['admin', 'user'])
    expect((await t.call('POST', '/api/auth/register', undefined, { username: 'alice', password: 'secret123' })).status).toBe(409)
    expect((await t.call('GET', '/api/me', a.token)).data).toMatchObject({ username: 'Alice', role: 'admin' })
  })

  it('用户名与密码规则', async () => {
    const t = env()
    expect((await t.call('POST', '/api/auth/register', undefined, { username: 'x', password: 'secret123' })).data.code).toBe('invalid_username')
    expect((await t.call('POST', '/api/auth/register', undefined, { username: '张三', password: 'short1' })).data.code).toBe('weak_password')
    expect((await t.call('POST', '/api/auth/register', undefined, { username: '张三', password: 'onlyletters' })).data.code).toBe('weak_password')
    expect((await t.call('POST', '/api/auth/register', undefined, { username: '张三', password: 'letters123' })).status).toBe(201)
  })

  it('登录：错误密码 401，连续失败后限流；正确密码拿到令牌', async () => {
    const t = env()
    await t.register('carol')
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'carol', password: 'wrong1234' })).status).toBe(401)
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'nobody', password: 'wrong1234' })).status).toBe(401)
    const ok = await t.call('POST', '/api/auth/login', undefined, { username: 'CAROL', password: 'secret123' })
    expect(ok.status).toBe(200)
    expect((await t.call('GET', '/api/docs', ok.data.token)).status).toBe(200)
    for (let i = 0; i < 5; i++) await t.call('POST', '/api/auth/login', undefined, { username: 'carol', password: 'bad' })
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'carol', password: 'bad' })).status).toBe(429)
  })

  it('注册按来源限流', async () => {
    const t = env()
    for (let i = 0; i < 5; i++) await t.register(`user${i}`)
    expect((await t.call('POST', '/api/auth/register', undefined, { username: 'user9', password: 'secret123' })).status).toBe(429)
  })
})

describe('账户：令牌吊销', () => {
  it('改密码后其他设备的令牌失效，当前设备拿到新令牌', async () => {
    const t = env()
    const { token } = await t.register('dave')
    const other = (await t.call('POST', '/api/auth/login', undefined, { username: 'dave', password: 'secret123' })).data.token
    expect((await t.call('PATCH', '/api/me', token, { current_password: 'nope1234', new_password: 'newpass123' })).status).toBe(401)
    const r = await t.call('PATCH', '/api/me', token, { current_password: 'secret123', new_password: 'newpass123' })
    expect(r.status).toBe(200)
    expect((await t.call('GET', '/api/docs', other)).status).toBe(401)
    expect((await t.call('GET', '/api/docs', r.data.token)).status).toBe(200)
  })

  it('管理员停用用户：该用户的令牌立即失效、不能再登录；启用后可登录', async () => {
    const t = env()
    const admin = await t.register('admin')
    const user = await t.register('erin')
    expect((await t.call('PATCH', `/api/admin/users/${user.user.id}`, admin.token, { status: 'disabled' })).status).toBe(200)
    expect((await t.call('GET', '/api/docs', user.token)).status).toBe(401)
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'erin', password: 'secret123' })).status).toBe(403)
    await t.call('PATCH', `/api/admin/users/${user.user.id}`, admin.token, { status: 'active' })
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'erin', password: 'secret123' })).status).toBe(200)
  })

  it('退出所有设备 / 管理员强制下线', async () => {
    const t = env()
    const admin = await t.register('admin')
    const user = await t.register('frank')
    await t.call('POST', `/api/admin/users/${user.user.id}/logout`, admin.token)
    expect((await t.call('GET', '/api/docs', user.token)).status).toBe(401)
    await t.call('POST', '/api/auth/logout-everywhere', admin.token)
    expect((await t.call('GET', '/api/docs', admin.token)).status).toBe(401)
  })

  it('普通用户不能用管理接口；不能把最后一个管理员降级或停用', async () => {
    const t = env()
    const admin = await t.register('admin')
    const user = await t.register('gina')
    expect((await t.call('GET', '/api/admin/users', user.token)).status).toBe(403)
    expect((await t.call('PATCH', `/api/admin/users/${admin.user.id}`, admin.token, { role: 'user' })).status).toBe(409)
    await t.call('PATCH', `/api/admin/users/${user.user.id}`, admin.token, { role: 'admin' })
    expect((await t.call('PATCH', `/api/admin/users/${admin.user.id}`, admin.token, { role: 'user' })).status).toBe(200)
  })

  it('生产模式（非开发模式）不接受开发令牌', async () => {
    const dev = env(true)
    expect((await dev.call('GET', '/api/docs', 'dev')).status).toBe(200)
    const prod = env(false)
    expect((await prod.call('GET', '/api/docs', 'dev')).status).toBe(401)
    expect((await prod.call('GET', '/api/docs', 'dev:e2e')).status).toBe(401)
  })
})

describe('数据隔离：另一个用户访问一律 404', () => {
  it('文档、读视图、导出、编辑、评论、资产、版本、队列', async () => {
    const t = env()
    const a = await t.register('alice')
    const b = await t.register('bob')
    const doc = (await t.call('POST', '/api/docs', a.token, { title: 'A 的文档', markdown: '# 标题\n\n第一段。' })).data
    const html = (await t.call('GET', `/api/docs/${doc.id}/html`, a.token)).data.html as string
    const node = /data-id="([a-z0-9]+)"/.exec(html)![1]
    const comment = (await t.call('POST', `/api/docs/${doc.id}/comments`, a.token, { node_id: node, snippet: '', text: '改一下' })).data
    const asset = t.docs.store.putAsset({ owner: a.user.id, mime: 'image/png', name: 'a.png', bytes: new Uint8Array([1]) })

    expect((await t.call('GET', '/api/docs', b.token)).data).toEqual([])
    const probes: Array<[string, string, unknown?]> = [
      ['GET', `/api/docs/${doc.id}`],
      ['GET', `/api/docs/${doc.id}/html`],
      ['GET', `/api/docs/${doc.id}/read`],
      ['GET', `/api/docs/${doc.id}/export.md`],
      ['GET', `/api/docs/${doc.id}/export.docx`],
      ['GET', `/api/docs/${doc.id}/diff`],
      ['PATCH', `/api/docs/${doc.id}`, { title: '改名' }],
      ['POST', `/api/docs/${doc.id}/edit`, { base_rev: 0, ops: [{ op: 'delete', ids: [node] }] }],
      ['POST', `/api/docs/${doc.id}/comments`, { node_id: node, snippet: '', text: '偷看' }],
      ['POST', `/api/docs/${doc.id}/comments/${comment.id}/replies`, { text: '回复' }],
      ['POST', `/api/docs/${doc.id}/comments/${comment.id}/resolve`],
      ['DELETE', `/api/docs/${doc.id}/comments/${comment.id}`],
      ['POST', `/api/docs/${doc.id}/chat?async=1`, { message: '改' }],
      ['POST', `/api/docs/${doc.id}/save`],
      ['POST', `/api/docs/${doc.id}/versions/1/restore`],
      ['GET', `/api/assets/${asset.id}`],
      ['DELETE', `/api/docs/${doc.id}`],
    ]
    for (const [method, path, body] of probes) {
      const r = await t.call(method, path, b.token, body)
      expect([path, r.status]).toEqual([path, 404])
    }
    // A 的数据没被动过
    expect((await t.call('GET', `/api/docs/${doc.id}`, a.token)).data.title).toBe('A 的文档')
    expect((await t.call('GET', `/api/queue`, b.token)).data).toEqual({ running: null, active: [], queued: [] })
    expect(t.accounts.userFor(b.token)).toBe(b.user.id)
  })

  it('开发模式：管理员认领开发期文档；普通用户不能认领', async () => {
    const t = env()
    t.docs.create({ owner: 'dev', title: '开发期文档' })
    const admin = await t.register('admin')
    const user = await t.register('hank')
    expect((await t.call('POST', '/api/me/claim-dev-data', user.token)).status).toBe(403)
    expect((await t.call('POST', '/api/me/claim-dev-data', admin.token)).data).toEqual({ docs: 1, assets: 0 })
    expect((await t.call('GET', '/api/docs', admin.token)).data.map((d: any) => d.title)).toEqual(['开发期文档'])
    expect((await t.call('GET', '/api/docs', 'dev')).data).toEqual([])
  })
})

describe('1.0 账户导入', () => {
  it('导入用户名、密码哈希、角色、停用状态；原密码可登录；重复运行幂等；冲突与无效行跳过', async () => {
    const bcrypt = (await import('bcryptjs')).default
    const { DatabaseSync } = await import('node:sqlite')
    const { importH1Users } = await import('../src/auth/import-h1.ts')
    const path = join(mkdtempSync(join(tmpdir(), 'h1-')), 'h1.db')
    const h1 = new DatabaseSync(path)
    h1.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT NOT NULL, password_hash TEXT, role TEXT, status TEXT,
      is_admin INTEGER, disabled_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL, email TEXT, email_verified INTEGER)`)
    const hash = (pw: string) => bcrypt.hashSync(pw, 4).replace(/^\$2b\$/, '$2a$') // 1.0 用 bcryptjs，前缀可能是 $2a$
    const add = h1.prepare('INSERT INTO users (id, username, display_name, password_hash, role, status, is_admin, disabled_at, deleted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    add.run('h1', 'drwang', '王医生', hash('oldpass123'), 'user', 'approved', 1, null, null, '2025-01-01')
    add.run('h2', null, '李研究员', hash('another123'), 'user', 'approved', 0, null, null, '2025-01-02')
    add.run('h3', 'gone', '离职', hash('x1234567'), 'user', 'approved', 0, null, '2025-06-01', '2025-01-03')
    add.run('h4', 'nopass', '无密码', null, 'user', 'approved', 0, null, null, '2025-01-04')
    add.run('h5', 'paused', '停用', hash('paused123'), 'user', 'approved', 0, '2025-05-01', null, '2025-01-05')
    add.run('h6', 'taken', '同名', hash('taken1234'), 'user', 'approved', 0, null, null, '2025-01-06')
    add.run('h7', null, 'Dr Jane Doe', hash('spaced1234'), 'user', 'approved', 0, null, null, '2025-01-07')
    h1.prepare("UPDATE users SET email = 'Wang@Hosp.cn', email_verified = 1 WHERE id = 'h1'").run()
    h1.prepare("UPDATE users SET email = 'li@hosp.cn', email_verified = 0 WHERE id = 'h2'").run()
    h1.close()

    const t = env()
    await t.register('taken')
    const dry = importH1Users(path, t.store, false)
    expect(dry.imported.map(u => u.username)).toEqual(['drwang', '李研究员', 'paused', 'Dr Jane Doe'])
    expect(t.store.getUserByName('drwang')).toBeUndefined()

    const report = importH1Users(path, t.store, true)
    expect(report.imported).toEqual([
      { username: 'drwang', role: 'admin', status: 'active' },
      { username: '李研究员', role: 'user', status: 'active' },
      { username: 'paused', role: 'user', status: 'disabled' },
      { username: 'Dr Jane Doe', role: 'user', status: 'active' },
    ])
    expect(report.skipped.map(s => s.reason)).toEqual(['已删除', '没有密码，无法登录'])
    expect(report.conflicts).toEqual(['taken'])
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'drwang', password: 'oldpass123' })).data.user).toMatchObject({ role: 'admin', display_name: '王医生' })
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'paused', password: 'paused123' })).status).toBe(403)

    // 已验证的邮箱一起导入（小写），未验证的不导
    expect(t.store.getUserByName('drwang')!.email).toBe('wang@hosp.cn')
    expect(t.store.getUserByName('李研究员')!.email).toBeNull()
    const again = importH1Users(path, t.store, true)
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'dr jane doe', password: 'spaced1234' })).status).toBe(200)
    expect([again.imported.length, again.already.length]).toEqual([0, 4])
  })
})

describe('1.0 账户导入：旧版表结构', () => {
  it('#1136 之前的 1.0（没有 username / email 列）：用显示名作登录名导入', async () => {
    const bcrypt = (await import('bcryptjs')).default
    const { DatabaseSync } = await import('node:sqlite')
    const { importH1Users } = await import('../src/auth/import-h1.ts')
    const path = join(mkdtempSync(join(tmpdir(), 'h1old-')), 'h1.db')
    const h1 = new DatabaseSync(path)
    h1.exec(`PRAGMA journal_mode = WAL; CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT, status TEXT,
      is_admin INTEGER, created_at TEXT NOT NULL)`)
    h1.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run('o1', 'Dr Old', bcrypt.hashSync('oldpass123', 4), 'user', 'approved', 1, '2025-01-01')
    h1.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run('o2', '待审核', bcrypt.hashSync('pending123', 4), 'user', 'pending', 0, '2025-01-02')
    h1.close()
    const t = env()
    const report = importH1Users(path, t.store, true)
    expect(report.imported).toEqual([
      { username: 'Dr Old', role: 'admin', status: 'active' },
      { username: '待审核', role: 'user', status: 'disabled' },
    ])
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'dr old', password: 'oldpass123' })).status).toBe(200)
    expect(t.store.getUserByName('Dr Old')!.email).toBeNull()
  })

  it('users 表缺必需列时报清楚的错', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { importH1Users } = await import('../src/auth/import-h1.ts')
    const path = join(mkdtempSync(join(tmpdir(), 'h1bad-')), 'h1.db')
    const h1 = new DatabaseSync(path)
    h1.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)')
    h1.close()
    expect(() => importH1Users(path, env().store, false)).toThrow('缺少 display_name')
  })
})

describe('防机器人', () => {
  it('注册 / 登录必须带人机校验的解；陷阱字段被填、解被重放都拒绝', async () => {
    const t = env()
    const body = { username: 'ivy', password: 'secret123' }
    expect((await t.call('POST', '/api/auth/register', undefined, { ...body, pow: undefined })).data.code).toBe('bot_check')
    expect((await t.call('POST', '/api/auth/register', undefined, { ...body, website: 'http://spam.example' })).data.code).toBe('bot_check')
    const solved = await t.pow()
    expect((await t.call('POST', '/api/auth/register', undefined, { ...body, pow: solved })).status).toBe(201)
    expect((await t.call('POST', '/api/auth/login', undefined, { ...body, pow: solved })).data.code).toBe('bot_check')
    expect((await t.call('POST', '/api/auth/login', undefined, { ...body, pow: { ...(await t.pow()), number: -1 } })).data.code).toBe('bot_check')
    expect((await t.call('POST', '/api/auth/login', undefined, body)).status).toBe(200)
  })

  it('签名伪造、领题后过快提交、过期都拒绝；同一来源失败越多题越难', () => {
    const guard = new BotGuard({ secret: SECRET, baseMax: 100, minDelayMs: 1500, ttlMs: 60_000 })
    const t0 = 1_000_000
    const c = guard.issue('ip1', t0)
    const s = solveChallenge(c)
    expect(() => guard.verify('ip1', s, '', t0 + 500)).toThrow('too_fast')
    expect(() => guard.verify('ip1', { ...s, signature: 'f'.repeat(64) }, '', t0 + 2000)).toThrow('signature')
    expect(() => guard.verify('ip1', s, '', t0 + 120_000)).toThrow('expired')
    guard.verify('ip1', s, '', t0 + 2000)
    expect(guard.issue('ip1', t0 + 3000).maxnumber).toBe(800) // 3 次失败 → 8 倍
    expect(guard.issue('ip2', t0 + 3000).maxnumber).toBe(100)
  })
})

describe('邮箱：绑定与找回密码', () => {
  it('绑定邮箱：发码 → 核对；错码累计 5 次作废；邮箱被别人占用不能绑', async () => {
    const t = env()
    const a = await t.register('amy')
    const b = await t.register('ben')
    expect((await t.call('POST', '/api/me/email-code', a.token, { email: 'Amy@Example.com' })).status).toBe(200)
    expect(t.mailer.sent.at(-1)!.to).toBe('amy@example.com')
    expect((await t.call('POST', '/api/me/email', a.token, { email: 'amy@example.com', code: '000000' })).data.code).toBe('bad_code')
    const r = await t.call('POST', '/api/me/email', a.token, { email: 'amy@example.com', code: t.mailer.code() })
    expect(r.data.email).toBe('amy@example.com')
    expect((await t.call('POST', '/api/me/email-code', b.token, { email: 'amy@example.com' })).data.code).toBe('email_taken')
    // 60 秒内不能重发
    expect((await t.call('POST', '/api/me/email-code', b.token, { email: 'ben@example.com' })).status).toBe(200)
    expect((await t.call('POST', '/api/me/email-code', b.token, { email: 'ben@example.com' })).data.code).toBe('code_throttled')
    for (let i = 0; i < 5; i++) await t.call('POST', '/api/me/email', b.token, { email: 'ben@example.com', code: '111111' })
    expect((await t.call('POST', '/api/me/email', b.token, { email: 'ben@example.com', code: t.mailer.code() })).data.code).toBe('bad_code')
  })

  it('找回密码：未绑定的邮箱同样返回成功但不发信；验证码重置后旧登录全部失效、原密码不能再用', async () => {
    const t = env()
    const a = await t.register('cara')
    await t.call('POST', '/api/me/email-code', a.token, { email: 'cara@example.com' })
    await t.call('POST', '/api/me/email', a.token, { email: 'cara@example.com', code: t.mailer.code() })
    const before = t.mailer.sent.length
    expect((await t.call('POST', '/api/auth/password-code', undefined, { email: 'nobody@example.com' })).status).toBe(200)
    expect(t.mailer.sent.length).toBe(before)
    expect((await t.call('POST', '/api/auth/password-code', undefined, { email: 'cara@example.com' })).status).toBe(200)
    expect(t.mailer.sent.length).toBe(before + 1)
    expect((await t.call('POST', '/api/auth/reset-password', undefined, { email: 'cara@example.com', code: t.mailer.code(), new_password: 'weak' })).data.code).toBe('weak_password')
    const reset = await t.call('POST', '/api/auth/reset-password', undefined, { email: 'cara@example.com', code: t.mailer.code(), new_password: 'fresh12345' })
    expect(reset.status).toBe(200)
    expect((await t.call('GET', '/api/docs', a.token)).status).toBe(401)
    expect((await t.call('GET', '/api/docs', reset.data.token)).status).toBe(200)
    expect((await t.call('POST', '/api/auth/login', undefined, { username: 'cara', password: 'secret123' })).status).toBe(401)
    // 验证码一次有效
    expect((await t.call('POST', '/api/auth/reset-password', undefined, { email: 'cara@example.com', code: t.mailer.code(), new_password: 'again12345' })).data.code).toBe('bad_code')
  })

  it('找回密码发码需要人机校验', async () => {
    const t = env()
    expect((await t.call('POST', '/api/auth/password-code', undefined, { email: 'x@example.com', pow: undefined })).data.code).toBe('bot_check')
  })

  it('生产环境没配邮件服务：找回密码一律提示联系管理员（不论邮箱是否注册）', async () => {
    const { createMailer } = await import('../src/auth/mailer.ts')
    const store = new Store(':memory:')
    const accounts = new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: SECRET, baseMax: 50, minDelayMs: 0 }), mailer: createMailer({ production: true }) })
    const ask = async (email: string) => {
      const c = accounts.bots.issue('ip')
      return accounts.sendResetCode({ email, pow: solveChallenge(c) }, 'ip').catch(err => err.code)
    }
    expect(await ask('a@example.com')).toBe('mail_unavailable')
  })
})

describe('重试回合', () => {
  it('失败的回合按原要求、原选项重新排队；别人的回合、进行中的回合不能重试', async () => {
    const t = env()
    const a = await t.register('amy')
    const b = await t.register('ben')
    const doc = (await t.call('POST', '/api/docs', a.token, { title: '文档', markdown: '第一段。' })).data
    const turn = t.store.createTurn({ user_id: a.user.id, doc_id: doc.id, message: '把第一段改成英文', opts: JSON.stringify({ suggest: true }) })
    expect((await t.call('POST', `/api/docs/${doc.id}/turns/${turn.id}/retry`, a.token)).status).toBe(409)
    t.store.endTurn(turn.id, 'timeout', '模型服务 5 分钟无响应，已自动停止')
    expect((await t.call('POST', `/api/docs/${doc.id}/turns/${turn.id}/retry`, b.token)).status).toBe(404)
    expect((await t.call('POST', `/api/docs/${doc.id}/turns/${turn.id}/retry`, a.token)).status).toBe(202)
    await new Promise(r => setTimeout(r, 10))
    expect((await t.call('GET', '/api/queue', a.token)).data.running).toMatchObject({ label: '把第一段改成英文', suggest: true })
  })
})
