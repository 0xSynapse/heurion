import { describe, it, expect } from 'vitest'
import { Store } from '../src/store/db.ts'
import { MailService } from '../src/mail/service.ts'
import { CalendarService } from '../src/calendar/service.ts'
import type { Mailer, SendMailOptions } from '../src/auth/mailer.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { TurnService } from '../src/turns/service.ts'

function makeTestApp() {
  const store = new Store(':memory:')
  store.createUser({ id: 'dev', username: 'dev', display_name: '开发者', password_hash: 'x', role: 'admin', email: 'dev@heurion.org' })
  const docs = new Documents(store)
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
  const accounts = new Accounts(store, { secret: 'test-secret', devMode: true, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: 'test-secret', baseMax: 300, minDelayMs: 0 }) })
  const mail = new MailService(store)
  const calendar = new CalendarService(store, mail)
  const app = buildApi({
    docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))),
    accounts, devMode: true, devUser: 'dev', mail, calendar,
  })
  const call = (method: string, path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer dev')
    return app.request(path, { ...init, method, headers })
  }
  return {
    rawApp: app,
    get: (path: string, init?: RequestInit) => call('GET', path, init),
    post: (path: string, init?: RequestInit) => call('POST', path, init),
    patch: (path: string, init?: RequestInit) => call('PATCH', path, init),
    delete: (path: string, init?: RequestInit) => call('DELETE', path, init),
  }
}

describe('邮件与日历系统集成 (Mail & Calendar Integration)', () => {
  it('1. MailService: 邮箱域名规范化、初始空收件箱、收发与标记已读', () => {
    const store = new Store(':memory:')
    const mail = new MailService(store)

    // 域名使用 heurion.org (支持每个医生专属邮箱，如 hui@heurion.org)
    expect(mail.userEmail('wang')).toBe('wang@heurion.org')
    expect(mail.userEmail('hui')).toBe('hui@heurion.org')
    expect(mail.userEmail('Dr_Zhao')).toBe('zhao@heurion.org')

    // 首次访问不应注入任何虚拟演示种子邮件
    expect(mail.list('u1', 'wang').length).toBe(0)

    // 投递随访通知与科研进展邮件至收件箱
    const followupMail = mail.send({
      userId: 'u1',
      recipientUserId: 'u1',
      sender: 'followup@heurion.org',
      recipient: 'wang@heurion.org',
      subject: '【随访计划】P-0001 呼吸专科复查通知',
      body: '患者需按计划进行薄层 CT 与肺功能复查。',
      category: 'followup',
      patientId: 'P-0001',
      patientCode: 'P-0001',
      folder: 'inbox',
    })
    const researchMail = mail.send({
      userId: 'u1',
      recipientUserId: 'u1',
      sender: 'research@heurion.org',
      recipient: 'wang@heurion.org',
      subject: '【科研进度】队列研究数据质控简报',
      body: '队列入组数据已完成阶段核查。',
      category: 'research',
      studyId: 'STUDY-001',
      folder: 'inbox',
    })

    const list = mail.list('u1', 'wang')
    expect(list.length).toBe(2)

    // 标记已读与全标已读
    expect(followupMail.read).toBe(0)
    mail.markRead('u1', followupMail.id, true)
    expect(mail.get('u1', followupMail.id)?.read).toBe(1)

    mail.markAllRead('u1')
    const allRead = mail.list('u1', 'wang')
    expect(allRead.every(m => m.read === 1)).toBe(true)

    // 发送新邮件
    const sent = mail.send({
      userId: 'u1',
      recipient: 'colleague@heurion.com',
      subject: '关于 P-0004 的随访反馈',
      body: '患者目前耐受良好，未见明显不良反应。',
      category: 'followup',
      patientId: 'P-0004',
      patientCode: 'P-0004',
    })
    expect(sent.id).toBeDefined()
    expect(sent.subject).toContain('P-0004')

    // 删除邮件
    mail.delete('u1', sent.id)
    expect(mail.get('u1', sent.id)).toBeUndefined()
    mail.delete('u1', researchMail.id)
    expect(mail.get('u1', researchMail.id)).toBeUndefined()
  })

  it('2. CalendarService: 初始空日历、随访门诊日程与邮件联动创建', () => {
    const store = new Store(':memory:')
    const mail = new MailService(store)
    const calendar = new CalendarService(store, mail)

    // 首次访问不应注入任何虚拟演示日程
    const events = calendar.list('u2', { username: 'zhao' })
    expect(events.length).toBe(0)

    // 创建新日程并联动发送通知邮件
    const newEvent = calendar.create({
      userId: 'u2',
      username: 'zhao',
      title: '【随访】P-0003 营养预康复二期访视',
      startTime: '2026-10-20 10:00',
      endTime: '2026-10-20 11:00',
      category: 'followup',
      patientId: 'P-0003',
      patientCode: 'P-0003',
      location: '营养门诊',
      sendEmail: true,
    })
    expect(newEvent.id).toBeDefined()

    // 确认联动生成了一封随访提醒邮件
    const mails = mail.list('u2', 'zhao')
    const matchedMail = mails.find(m => m.subject.includes('P-0003 营养预康复二期访视'))
    expect(matchedMail).toBeDefined()
    expect(matchedMail?.calendar_event_id).toBe(newEvent.id)
    expect(matchedMail?.recipient).toBe('zhao@heurion.org')

    // 更新日程状态（完成）
    const updated = calendar.update('u2', newEvent.id, { status: 'completed' })
    expect(updated?.status).toBe('completed')

    // 删除日程
    calendar.delete('u2', newEvent.id)
    expect(calendar.get('u2', newEvent.id)).toBeUndefined()
  })

  it('3. HTTP API: /api/mail/* 与 /api/calendar/* 端到端 REST 接口健全性', async () => {
    const api = makeTestApp()

    // 1. 初始邮件列表为空（无演示假数据）
    const initMailRes = await api.get('/api/mail/messages')
    expect(initMailRes.status).toBe(200)
    expect(await initMailRes.json()).toEqual([])

    // 2. 外部来信 Inbound Webhook 投递测试 (例如外部患者发往 dev@heurion.org)
    const inboundRes = await api.post('/api/mail/inbound', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'patient.external@gmail.com',
        from_name: '外部患者张先生',
        to: 'dev@heurion.org',
        subject: '口服吡非尼酮后轻微乏力咨询',
        body: '李医生您好，最近服药后有些乏力，是否需要调整剂量？',
      }),
    })
    expect(inboundRes.status).toBe(201)
    const inboundJson = await inboundRes.json() as any
    expect(inboundJson.ok).toBe(true)
    expect(inboundJson.id).toBeDefined()

    // 3. 确认该邮件已即时投递到医生 dev 的收件箱
    const checkMailRes = await api.get(`/api/mail/messages/${inboundJson.id}`)
    expect(checkMailRes.status).toBe(200)
    const received = await checkMailRes.json() as any
    expect(received.sender).toBe('patient.external@gmail.com')
    expect(received.recipient).toBe('dev@heurion.org')
    expect(received.subject).toContain('口服吡非尼酮后轻微乏力咨询')
    expect(received.folder).toBe('inbox')

    // 4. 标记已读与全部已读
    const readRes = await api.patch(`/api/mail/messages/${inboundJson.id}/read`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: true }),
    })
    expect(readRes.status).toBe(200)

    const allReadRes = await api.post('/api/mail/read-all')
    expect(allReadRes.status).toBe(200)

    // 5. 发送新邮件
    const composeRes = await api.post('/api/mail/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: 'test@heurion.org',
        subject: 'API 发送测试随访计划',
        body: '这是通过 API 发送的测试邮件正文',
        category: 'followup',
        patient_code: 'PT-001',
      }),
    })
    expect(composeRes.status).toBe(201)
    const composed = await composeRes.json() as any
    expect(composed.id).toBeDefined()
    expect(composed.sender).toMatch(/@(heurion\.org|heurion\.com)/)

    // 6. 初始日历事件列表为空（无演示假数据）
    const calRes = await api.get('/api/calendar/events')
    expect(calRes.status).toBe(200)
    expect(await calRes.json()).toEqual([])

    // 7. 新建日历事件
    const createEvRes = await api.post('/api/calendar/events', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '【科研】终点事件盲态审核',
        start_time: '2026-10-25 15:00',
        end_time: '2026-10-25 17:00',
        category: 'research',
        study_id: 'STUDY-001',
        study_title: '前瞻性队列研究',
        location: '第一会议室',
        send_email: true,
      }),
    })
    expect(createEvRes.status).toBe(201)
    const createdEv = await createEvRes.json() as any
    expect(createdEv.id).toBeDefined()

    // 8. 更新日历事件
    const updateEvRes = await api.patch(`/api/calendar/events/${createdEv.id}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    })
    expect(updateEvRes.status).toBe(200)
    const updatedEv = await updateEvRes.json() as any
    expect(updatedEv.status).toBe('completed')

    // 9. 删除日历事件
    const delEvRes = await api.delete(`/api/calendar/events/${createdEv.id}`)
    expect(delEvRes.status).toBe(200)
  })

  it('4. 方案3实施验证：外部来信 Webhook 投递入库，并自动向医生个人邮箱转发副本', async () => {
    const store = new Store(':memory:')
    // 创建医生用户，并绑定其真实的外部个人邮箱（如 zhaojimmy13@gmail.com）
    const doctor = store.createUser({
      id: 'dr_hui',
      username: 'hui',
      display_name: '赵辉 主任医师',
      password_hash: 'x',
      email: 'zhaojimmy13@gmail.com',
    })

    const forwardedMails: Array<{ to: string; subject: string; text: string; opts?: any }> = []
    const mockMailer: any = {
      configured: true,
      available: true,
      mode: 'smtp',
      send: async (to: string, subject: string, text: string, _html?: string, opts?: any) => {
        forwardedMails.push({ to, subject, text, opts })
        return { success: true, mode: 'smtp' }
      },
    }

    const mail = new MailService(store, mockMailer, { domain: 'heurion.org' })
    expect(mail.userEmail('hui')).toBe('hui@heurion.org')

    // 外部患者发信到 hui@heurion.org
    const res = await mail.receiveInbound({
      from: 'patient.li@163.com',
      fromName: '李患者',
      to: 'hui@heurion.org',
      subject: '关于术后复查 CT 时间预约咨询',
      body: '赵主任您好，我刚做完术后第一疗程，请问下周二能预约做薄层 CT 吗？',
    })

    expect(res.success).toBe(true)
    expect(res.message).toBeDefined()
    expect(res.forwardedTo).toBe('zhaojimmy13@gmail.com')

    // 1. 验证工作台【📥 收件箱】已正确归档
    const inbox = mail.list('dr_hui', 'hui', { folder: 'inbox' })
    const saved = inbox.find(m => m.id === res.message?.id)
    expect(saved).toBeDefined()
    expect(saved?.sender).toBe('patient.li@163.com')
    expect(saved?.recipient).toBe('hui@heurion.org')
    expect(saved?.subject).toBe('关于术后复查 CT 时间预约咨询')

    // 2. 验证自动向医生的个人邮箱转发了一份副本
    expect(forwardedMails.length).toBe(1)
    const forward = forwardedMails[0]!
    expect(forward.to).toBe('zhaojimmy13@gmail.com')
    expect(forward.subject).toContain('关于术后复查 CT 时间预约咨询')
    expect(forward.text).toContain('赵主任您好')
    expect(forward.opts?.replyTo).toBe('patient.li@163.com')
    expect(forward.opts?.senderAddress).toBe('hui@heurion.org')
  })

  it('5. 邮件与日历的分页 (Paging) 与批量操作 (Batch Operations) 端到端接口验证', async () => {
    const api = makeTestApp()

    // 先创建 5 封收件箱邮件与 5 个日历事件用于测试分页与批量操作
    for (let i = 1; i <= 5; i++) {
      await api.post('/api/mail/inbound', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `sender${i}@example.com`,
          from_name: `发件人${i}`,
          to: 'dev@heurion.org',
          subject: `测试分页邮件 #${i}`,
          body: `第 ${i} 封测试邮件内容`,
        }),
      })
      await api.post('/api/calendar/events', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `测试日程 #${i}`,
          start_time: `2026-10-2${i} 09:00`,
          end_time: `2026-10-2${i} 10:00`,
          category: 'followup',
        }),
      })
    }

    // 1. 测试邮件分页接口
    const pagedRes = await api.get('/api/mail/messages?page=1&page_size=2&folder=inbox')
    expect(pagedRes.status).toBe(200)
    const pagedData = await pagedRes.json() as any
    expect(pagedData.items).toBeDefined()
    expect(pagedData.items.length).toBe(2)
    expect(pagedData.total).toBe(5)
    expect(pagedData.page).toBe(1)
    expect(pagedData.page_size).toBe(2)
    expect(pagedData.total_pages).toBe(3)

    const [mail1, mail2] = pagedData.items
    expect(mail1.id).toBeDefined()
    expect(mail2.id).toBeDefined()

    // 2. 测试邮件标星接口
    const starRes = await api.patch(`/api/mail/messages/${mail1.id}/star`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: true }),
    })
    expect(starRes.status).toBe(200)

    // 3. 测试批量标为已读与批量标星
    const batchReadRes = await api.post('/api/mail/batch', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read', ids: [mail1.id, mail2.id] }),
    })
    expect(batchReadRes.status).toBe(200)
    const batchReadData = await batchReadRes.json() as any
    expect(batchReadData.ok).toBe(true)
    expect(batchReadData.count).toBe(2)

    // 4. 测试批量移入废纸篓 (trash) 与批量恢复 (restore)
    const batchTrashRes = await api.post('/api/mail/batch', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'trash', ids: [mail1.id] }),
    })
    expect(batchTrashRes.status).toBe(200)

    const checkTrashRes = await api.get('/api/mail/messages?folder=trash')
    const trashItems = await checkTrashRes.json() as any[]
    expect(trashItems.some(m => m.id === mail1.id)).toBe(true)

    // 恢复
    const batchRestoreRes = await api.post('/api/mail/batch', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restore', ids: [mail1.id] }),
    })
    expect(batchRestoreRes.status).toBe(200)

    // 5. 测试日历分页接口
    const calPagedRes = await api.get('/api/calendar/events?page=1&page_size=2')
    expect(calPagedRes.status).toBe(200)
    const calPagedData = await calPagedRes.json() as any
    expect(calPagedData.items.length).toBe(2)
    expect(calPagedData.total).toBe(5)

    // 6. 测试日历批量设为已完成与批量恢复待办
    const [ev1, ev2] = calPagedData.items
    const calBatchRes = await api.post('/api/calendar/batch', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete', ids: [ev1.id, ev2.id] }),
    })
    expect(calBatchRes.status).toBe(200)
    const calBatchData = await calBatchRes.json() as any
    expect(calBatchData.ok).toBe(true)

    const checkEv1 = await api.get(`/api/calendar/events/${ev1.id}`)
    const ev1Data = await checkEv1.json() as any
    expect(ev1Data.status).toBe('completed')
  })

  it('6. 外部发信边界健全性：向个人互联网邮箱 (Gmail/163) 发信，即使该邮箱已绑定站内用户，也必须作为外部邮件调用 mailer.send 真实发送', async () => {
    const store = new Store(':memory:')
    const sentExternalMails: Array<{ to: string; subject: string; text: string; senderAddress?: string }> = []
    const mockMailer: Mailer = {
      configured: true,
      available: true,
      mode: 'resend',
      async send(to: string, subject: string, text: string, _html?: string, opts?: SendMailOptions) {
        sentExternalMails.push({ to, subject, text, senderAddress: opts?.senderAddress })
        return { success: true, mode: 'resend', messageId: 'msg-external-123', info: '通过 Resend 发送成功' }
      },
    }

    // 模拟注册医生账户并绑定外部个人邮箱（如 zhaojimmy13@gmail.com）
    const user = store.createUser({
      username: 'hz',
      display_name: 'Dr. HZ',
      password_hash: 'hash',
      email: 'zhaojimmy13@gmail.com',
    })

    const mailService = new MailService(store, mockMailer, { domain: 'heurion.org' })

    // 医生在平台发信给自己的个人 Gmail 邮箱进行测试
    const result = await mailService.sendAsync({
      userId: user.id,
      recipient: 'zhaojimmy13@gmail.com',
      subject: '临床诊断随访测试',
      body: '测试正文内容',
      category: 'general',
    })

    // 核心验证：
    // 1. 必须判定为外部邮件 (external: true)
    expect(result.delivery.external).toBe(true)
    // 2. 投递状态必须为 external_sent，而非内部协同
    expect(result.delivery.status).toBe('external_sent')
    expect(result.delivery.note).toContain('RESEND')
    // 3. 真实调用了 mockMailer.send 并发送给 zhaojimmy13@gmail.com
    expect(sentExternalMails.length).toBe(1)
    expect(sentExternalMails[0]?.to).toBe('zhaojimmy13@gmail.com')
    // 4. 发件地址规范化为 @heurion.org
    expect(sentExternalMails[0]?.senderAddress).toBe('hz@heurion.org')
    // 5. 不会在自己的站内 inbox 里虚假生成一封「院内即时协同送达」邮件
    const inboxMails = mailService.list(user.id, user.username, { folder: 'inbox' })
    expect(inboxMails.some(m => m.subject === '临床诊断随访测试')).toBe(false)
  })

  it('7. 外部来信 Webhook 鉴权与 RFC 5322 地址解析 (无需 Session 登录凭证，支持带称谓地址)', async () => {
    const api = makeTestApp()

    // 模拟 Cloudflare Email Worker 发来的 Webhook，完全不带 Authorization Session Header
    const rawRes = await api.rawApp.request('/api/mail/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Jimmy Zhao <zhaojimmy13@gmail.com>',
        to: 'HZ (Heurion) <dev@heurion.org>',
        subject: 'Re: 临床诊断随访测试',
        body: '这是外部 Gmail 客户端直接回复的邮件正文',
      }),
    })

    expect(rawRes.status).toBe(201)
    const json = await rawRes.json() as any
    expect(json.ok).toBe(true)
    expect(json.id).toBeDefined()

    // 确认入库信息已将 RFC 5322 尖括号地址干净提取，成功匹配给医生 dev 账户
    const checkRes = await api.get(`/api/mail/messages/${json.id}`)
    expect(checkRes.status).toBe(200)
    const saved = await checkRes.json() as any
    expect(saved.sender).toBe('zhaojimmy13@gmail.com')
    expect(saved.sender_name).toBe('Jimmy Zhao')
    expect(saved.recipient).toBe('dev@heurion.org')
    expect(saved.subject).toBe('Re: 临床诊断随访测试')
  })

  it('8. MIME 编码与 Quoted-Printable 中文乱码自动解码与既有数据归一化 (RFC 2047 & QP)', async () => {
    const api = makeTestApp()

    // 模拟从 Gmail 客户端发来的真实原始 Base64 MIME 编码主题与 QP 编码正文
    const rawRes = await api.rawApp.request('/api/mail/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: '=?UTF-8?B?6LW15Lyf?= <zhaojimmy13@gmail.com>',
        to: 'HZ (Heurion) <dev@heurion.org>',
        subject: '=?UTF-8?B?UmU6IOa1i+ivlQ==?=',
        body: '=E6=B5=8B=E8=AF=95again 1113\n\nOn Wed, Oct 7, 2026 at 10:40=E2=80=AFAM HZ (Heurion) <hz@heurion.org> wrote=\n:\n\n> =E6=B5=8B=E8=AF=95',
      }),
    })

    expect(rawRes.status).toBe(201)
    const json = await rawRes.json() as any
    expect(json.ok).toBe(true)

    // 1. 验证入库解码：主题成功解码为 "Re: 测试"，发件人称谓成功解码为 "赵伟"，正文包含中文字符与软换行还原
    const checkRes = await api.get(`/api/mail/messages/${json.id}`)
    expect(checkRes.status).toBe(200)
    const saved = await checkRes.json() as any
    expect(saved.subject).toBe('Re: 测试')
    expect(saved.sender_name).toBe('赵伟')
    expect(saved.body).toContain('测试again 1113')
    expect(saved.body).toContain('wrote:')
    expect(saved.body).toContain('> 测试')
    expect(saved.body).not.toContain('=E6=B5=8B=E8=AF=95')
  })

  it('9. Google Email (Gmail Threads) 会话流自动聚合、专属工作邮箱前缀与往来回复关联', async () => {
    const api = makeTestApp()

    // 1. 医生设置专属工作邮箱前缀 (work_email_prefix)
    const patchMeRes = await api.patch('/api/me', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ work_email_prefix: 'zhaohui' }),
    })
    expect(patchMeRes.status).toBe(200)
    const meData = await patchMeRes.json() as any
    expect(meData.user.work_email_prefix).toBe('zhaohui')
    expect(meData.user.work_email).toBe('zhaohui@heurion.org')

    // 2. 外部患者来信，投递给医生的专属前缀邮箱 zhaohui@heurion.org
    const inboundRes1 = await api.rawApp.request('/api/mail/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Jimmy Zhao <zhaojimmy13@gmail.com>',
        to: 'Dr. Zhao <zhaohui@heurion.org>',
        subject: 'PT-BRONCHO-001 气道随访排期咨询',
        body: '赵医生您好，请问我下周二需要复查薄层 HRCT 吗？',
      }),
    })
    expect(inboundRes1.status).toBe(201)
    const inbound1 = await inboundRes1.json() as any

    // 3. 医生在站内查看这封邮件并获取会话流
    const detailRes1 = await api.get(`/api/mail/messages/${inbound1.id}`)
    expect(detailRes1.status).toBe(200)
    const mail1 = await detailRes1.json() as any
    expect(mail1.sender).toBe('zhaojimmy13@gmail.com')
    expect(mail1.thread).toBeDefined()
    expect(mail1.thread.length).toBe(1)

    // 4. 医生针对此邮件进行内联快速回复
    const replyRes = await api.post('/api/mail/messages', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: 'zhaojimmy13@gmail.com',
        subject: 'Re: PT-BRONCHO-001 气道随访排期咨询',
        body: '您好，需要按期进行复查，我已为您在门诊日历中排期。\n\n> 赵医生您好，请问我下周二需要复查薄层 HRCT 吗？',
        category: 'followup',
        patient_code: 'PT-BRONCHO-001',
        thread_id: inbound1.id,
        in_reply_to: inbound1.id,
      }),
    })
    expect(replyRes.status).toBe(201)
    const replyData = await replyRes.json() as any
    expect(replyData.sender).toBe('zhaohui@heurion.org')

    // 5. 外部用户再次回复
    const inboundRes2 = await api.rawApp.request('/api/mail/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Jimmy Zhao <zhaojimmy13@gmail.com>',
        to: 'Dr. Zhao <zhaohui@heurion.org>',
        subject: 'Re: Re: PT-BRONCHO-001 气道随访排期咨询',
        body: '收到，非常感谢赵医生！周二上午我会准时到院。',
      }),
    })
    expect(inboundRes2.status).toBe(201)

    // 6. 验证会话流 (Gmail Thread) 自动将上述 3 封邮件全部按时间顺序聚合
    const threadCheck = await api.get(`/api/mail/messages/${inbound1.id}`)
    const threadData = await threadCheck.json() as any
    expect(threadData.thread).toBeDefined()
    expect(threadData.thread.length).toBe(3)
    expect(threadData.thread[0].sender).toBe('zhaojimmy13@gmail.com')
    expect(threadData.thread[1].sender).toBe('zhaohui@heurion.org')
    expect(threadData.thread[2].sender).toBe('zhaojimmy13@gmail.com')
    expect(threadData.thread[2].body).toContain('周二上午我会准时到院')
  })

  it('10. Base64 编码的外部邮件正文智能自动解码与历史数据自动修复 (Gmail Chinese Reply Base64)', async () => {
    const api = makeTestApp()

    // 真实的 Gmail 中文回复 Base64 字符串（用户截图中的原始编码文本）
    // "回复\r\n\r\nOn Wed, Oct 7, 2026 at 11:54 AM HZ <huizhao@heurion.org> wrote:\r\n\r\n> 修改了专属邮件前缀\r\n"
    const rawBase64 = '5Zue5aSNDQoNCk9uIFdlZCwgT2N0IDcsIDIwMjYgYXQgMTE6NTQgQU0gSFogPGh1aXpoYW9AaGV1cmlvbi5vcmc+IHdyb3RlOg0KDQo+IOS/ruaUueS6huS4k+WxnumCruS7tuWJjee8gA0K'

    const inboundRes = await api.rawApp.request('/api/mail/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Jimmy Zhao <zhaojimmy13@gmail.com>',
        to: 'HZ <dev@heurion.org>',
        subject: 'Re: 测试专属邮件前缀',
        body: rawBase64,
      }),
    })

    expect(inboundRes.status).toBe(201)
    const json = await inboundRes.json() as any
    expect(json.ok).toBe(true)

    // 验证入库时已自动解码为中文内容
    const msgRes = await api.get(`/api/mail/messages/${json.id}`)
    expect(msgRes.status).toBe(200)
    const msg = await msgRes.json() as any
    expect(msg.body).toContain('回复')
    expect(msg.body).toContain('修改了专属邮件前缀')
    expect(msg.body).not.toContain('5Zue5aSNDQoNCk9u')
  })

  it('11. 多行换行与行首空格容错的 Base64 邮件解码（用户真实案例：什么情况？我打的是中文）', async () => {
    const api = makeTestApp()

    // 用户真实案例截图中的多行 Base64 字符串（含 76 字符换行与行首空格折行）
    const realUserBase64 = `5LuA5LmI5oOF5Ya177yfIOaIkeaJk+eahOaYr+S4reaWhw0KDQpPbiBXZWQsIE9jdCA3LCAyMDI2
 IGF0IDExOjU44oCvQU0gSlogPHpoYW9qaW1teTEzQGdtYWlsLmNvbT4gd3JvdGU6DQoNCj4g5Zue
5aSNDQo+DQo+IE9uIFdlZCwgT2N0IDcsIDIwMjYgYXQgMTE6NTTigK9BTSBIWiA8aHVpemhhb0Bo
ZXVyaW9uLm9yZz4gd3JvdGU6DQo+DQo+PiDkv67mlLnkuobkuJPlsZ7pgq7ku7bliY3nvIANCj4N
Cj4NCg==`

    const inboundRes = await api.rawApp.request('/api/mail/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Jimmy Zhao <zhaojimmy13@gmail.com>',
        to: 'HZ <dev@heurion.org>',
        subject: 'Re: 专属邮件前缀测试',
        body: realUserBase64,
      }),
    })

    expect(inboundRes.status).toBe(201)
    const json = await inboundRes.json() as any
    expect(json.ok).toBe(true)

    const msgRes = await api.get(`/api/mail/messages/${json.id}`)
    expect(msgRes.status).toBe(200)
    const msg = await msgRes.json() as any
    // 必须成功解码出中文正文与引用回复
    expect(msg.body).toContain('什么情况？ 我打的是中文')
    expect(msg.body).toContain('修改了专属邮件前缀')
    expect(msg.body).not.toContain('5LuA5LmI')
  })

  it('12. 外部原始 Multipart/Alternative MIME 邮件流的端到端自动解包与中文还原', async () => {
    const api = makeTestApp()

    const rawMimeBody = `MIME-Version: 1.0
Date: Wed, 7 Oct 2026 11:58:24 +0200
Subject: =?UTF-8?B?UmU6IOa1i+ivlQ==?=
From: JZ <zhaojimmy13@gmail.com>
To: huizhao@heurion.org
Content-Type: multipart/alternative; boundary="00000000000078b6630623e1f0e4"

--00000000000078b6630623e1f0e4
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: base64

5LuA5LmI5oOF5Ya177yfIOaIkeaJk+eahOaYr+S4reaWhw0KDQpPbiBXZWQsIE9jdCA3LCAyMDI2
IGF0IDExOjU44oCvQU0gSlogPHpoYW9qaW1teTEzQGdtYWlsLmNvbT4gd3JvdGU6DQoNCj4g5Zue
5aSNDQo+DQo+IE9uIFdlZCwgT2N0IDcsIDIwMjYgYXQgMTE6NTTigK9BTSBIWiA8aHVpemhhb0Bo
ZXVyaW9uLm9yZz4gd3JvdGU6DQo+DQo+PiDkv67mlLnkuobkuJPlsZ7pgq7ku7bliY3nvIANCj4N
Cj4NCg==
--00000000000078b6630623e1f0e4
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: base64

PGRpdiBkaXI9ImF1dG8iPuS7gOS5iOaDheWGte+8nyDmiJHmiZPlhYPnmoTmmK/kuK3mloc8L2Rp
dj4=
--00000000000078b6630623e1f0e4--`

    const inboundRes = await api.rawApp.request('/api/mail/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Jimmy Zhao <zhaojimmy13@gmail.com>',
        to: 'HZ <dev@heurion.org>',
        subject: 'Re: 测试',
        body: rawMimeBody,
      }),
    })

    expect(inboundRes.status).toBe(201)
    const json = await inboundRes.json() as any
    expect(json.ok).toBe(true)

    const msgRes = await api.get(`/api/mail/messages/${json.id}`)
    expect(msgRes.status).toBe(200)
    const msg = await msgRes.json() as any
    expect(msg.body).toContain('什么情况？ 我打的是中文')
    expect(msg.body).not.toContain('--00000000000078b6630623e1f0e4')
  })

  it('13. 废纸篓全生命周期、彻底删除与清空废纸篓 (Trash Lifecycle)', async () => {
    const api = makeTestApp()

    for (let i = 1; i <= 4; i++) {
      await api.post('/api/mail/inbound', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `doc${i}@example.com`,
          from_name: `协作医师${i}`,
          to: 'dev@heurion.org',
          subject: `废纸篓测试邮件 #${i}`,
          body: `第 ${i} 封邮件正文`,
        }),
      })
    }

    // 1. 获取收件箱邮件
    const initRes = await api.get('/api/mail/messages?folder=inbox')
    expect(initRes.status).toBe(200)
    const initMails = await initRes.json() as any[]
    expect(initMails.length).toBe(4)
    const allIds = initMails.map(m => m.id)

    // 2. 将收件箱全部邮件批量移入废纸篓
    const trashAllRes = await api.post('/api/mail/batch', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'trash', ids: allIds }),
    })
    expect(trashAllRes.status).toBe(200)

    // 3. 验证此时收件箱为空
    const inboxAfterTrash = await (await api.get('/api/mail/messages?folder=inbox')).json() as any[]
    expect(inboxAfterTrash.length).toBe(0)

    // 4. 验证废纸篓中存在这批邮件
    const trashList = await (await api.get('/api/mail/messages?folder=trash')).json() as any[]
    expect(trashList.length).toBe(allIds.length)

    // 5. 从废纸篓恢复一封邮件至收件箱
    const restoreId = allIds[0]!
    const restoreRes = await api.post('/api/mail/batch', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restore', ids: [restoreId] }),
    })
    expect(restoreRes.status).toBe(200)

    const inboxAfterRestore = await (await api.get('/api/mail/messages?folder=inbox')).json() as any[]
    expect(inboxAfterRestore.length).toBe(1)
    expect(inboxAfterRestore[0].id).toBe(restoreId)

    // 6. 单封彻底删除（物理删除）
    const deleteId = allIds[1]!
    const singleDelRes = await api.delete(`/api/mail/messages/${deleteId}`)
    expect(singleDelRes.status).toBe(200)

    const checkDelRes = await api.get(`/api/mail/messages/${deleteId}`)
    expect(checkDelRes.status).toBe(404)

    // 7. 清空废纸篓 (DELETE /api/mail/trash)
    const emptyTrashRes = await api.delete('/api/mail/trash')
    expect(emptyTrashRes.status).toBe(200)
    const emptyJson = await emptyTrashRes.json() as any
    expect(emptyJson.ok).toBe(true)
    expect(emptyJson.count).toBe(allIds.length - 2) // 减去恢复的 1 封和单删的 1 封

    const trashAfterEmpty = await (await api.get('/api/mail/messages?folder=trash')).json() as any[]
    expect(trashAfterEmpty.length).toBe(0)
  })
})



