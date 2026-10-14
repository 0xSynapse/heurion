import { timingSafeEqual } from 'node:crypto'
import type { Context, Hono } from 'hono'
import type { Documents } from '../../model/runtime.ts'
import type { Store } from '../../store/db.ts'
import type { PatientService, Actor } from '../../tenancy/patients.ts'
import type { MailService } from '../../mail/service.ts'
import type { CalendarService } from '../../calendar/service.ts'
import type { KbService } from '../../kb/service.ts'
import { schema } from '../../model/schema.ts'
import { parseBlocks } from '../../model/markdown.ts'
import { ExtractError } from '../../kb/extract.ts'

export interface MailCalendarRouteContext {
  store: Store
  docs: Documents
  mail: MailService
  calendar: CalendarService
  kb?: KbService
  projectOf: (c: Context<{ Variables: { user: string } }>, id: unknown) => string | null | false
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  pt: (c: Context<{ Variables: { user: string } }>) => PatientService
}

/**
 * 注册邮件信箱与日历排期相关路由：
 * 包含状态摘要、会话流转、AI 智能回复推荐、一键归档到文档/患者档案、
 * 附件转入知识库与下载、未读标记、批处理、外部 Inbound Webhook，以及日程事件 CRUD 与批量管理。
 */
export function registerMailCalendarRoutes(
  app: Hono<{ Variables: { user: string } }>,
  ctx: MailCalendarRouteContext
): void {
  const { store, docs, mail, calendar, kb, projectOf, me, pt } = ctx

  // —— 邮件与随访计划、科研进度信箱 (Mail) ——
  app.get('/api/mail/status', c => {
    const user = c.get('user')
    const u = store.getUser(user)
    return c.json({
      configured: mail.isConfigured(),
      mode: mail.mailerMode(),
      user_email: mail.userEmail(u?.username ?? user, u?.work_email_prefix),
      work_email_prefix: u?.work_email_prefix ?? null,
    })
  })

  app.get('/api/mail/summary', async c => {
    const user = c.get('user')
    const u = store.getUser(user)
    if (!u) return c.json({ error: '未登录' }, 401)
    const hours = Math.max(1, Math.min(168, Number(c.req.query('hours') || '48')))
    const force = c.req.query('force') === '1' || c.req.query('force') === 'true'
    const result = await mail.getRecentSummary(user, hours, force)
    return c.json(result)
  })

  app.get('/api/mail/messages', c => {
    const user = c.get('user')
    const u = store.getUser(user)
    const category = c.req.query('category') || undefined
    const folder = c.req.query('folder') || 'inbox'
    const starred = c.req.query('starred') === '1' || c.req.query('starred') === 'true'
    const unreadOnly = c.req.query('unread') === '1' || c.req.query('unread') === 'true'
    const search = c.req.query('search') || undefined
    const pageParam = c.req.query('page')
    const pageSizeParam = c.req.query('page_size') || c.req.query('pageSize')

    const list = mail.list(user, u?.username ?? user, { category, folder, starred, unreadOnly, search })

    if (pageParam !== undefined) {
      const page = Math.max(1, parseInt(pageParam, 10) || 1)
      const pageSize = Math.max(1, Math.min(100, parseInt(pageSizeParam || '20', 10) || 20))
      const total = list.length
      const totalPages = Math.ceil(total / pageSize) || 1
      const start = (page - 1) * pageSize
      const items = list.slice(start, start + pageSize)
      return c.json({
        items,
        total,
        page,
        page_size: pageSize,
        total_pages: totalPages,
      })
    }

    return c.json(list)
  })

  app.get('/api/mail/messages/:id', c => {
    const user = c.get('user')
    const m = mail.get(user, c.req.param('id'))
    if (!m) return c.json({ error: '邮件不存在' }, 404)
    const thread = mail.getThread(user, m.id)
    return c.json({ ...m, thread })
  })

  app.post('/api/mail/messages', async c => {
    const user = c.get('user')
    const u = store.getUser(user)
    const body = await c.req.json()
    if (!body.subject || !body.body) return c.json({ error: '主题与正文不能为空' }, 400)
    const result = await mail.sendAsync({
      userId: user,
      tenantId: u?.tenant_id,
      sender: mail.userEmail(u?.username ?? user, u?.work_email_prefix),
      senderName: u?.display_name ?? '主诊医师',
      recipient: body.recipient || body.to || 'colleague@heurion.org',
      subject: body.subject,
      body: body.body,
      category: body.category || 'general',
      patientId: body.patient_id,
      patientCode: body.patient_code,
      studyId: body.study_id,
      studyTitle: body.study_title,
      threadId: body.thread_id,
      inReplyTo: body.in_reply_to,
      attachments: body.attachments,
    })
    return c.json({ ...result.message, delivery: result.delivery }, 201)
  })

  // AI 智能建议回复 (Clinical Smart Reply)
  app.get('/api/mail/messages/:id/smart-replies', async c => {
    const user = c.get('user')
    const m = mail.get(user, c.req.param('id'))
    if (!m) return c.json({ error: '邮件不存在' }, 404)
    const replies = await mail.suggestSmartReplies(user, c.req.param('id'))
    return c.json({ replies })
  })

  // 邮件一键转为科研文稿 (Filing to Document)
  app.post('/api/mail/messages/:id/to-doc', async c => {
    const user = c.get('user')
    const m = mail.get(user, c.req.param('id'))
    if (!m) return c.json({ error: '邮件不存在' }, 404)

    const thread = mail.getThread(user, m.id)
    const allMails = thread.length > 0 ? thread : [m]

    const bodyJson = await c.req.json().catch(() => ({})) as { project_id?: string | null }
    const project = projectOf(c, bodyJson.project_id)
    if (project === false) return c.json({ error: '项目不存在' }, 404)

    const cleanSubject = m.subject.replace(/^(?:(?:\s*(?:re|fwd|fw|回复|转发)[：:]\s*)+)/i, '').trim() || '邮件'
    const docTitle = `[邮件归档] ${cleanSubject}`

    let md = `# ${docTitle}\n\n`
    md += `> **临床专邮会话归档**\n`
    md += `> - 主题：${m.subject}\n`
    md += `> - 类别：${m.category}\n`
    md += `> - 归档时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`
    if (m.patient_code) md += `> - 关联患者：\`${m.patient_code}\`\n`
    if (m.study_id) md += `> - 关联课题：\`${m.study_id}\`\n`
    md += `\n---\n\n`

    allMails.forEach((msg, idx) => {
      md += `## 会话 ${idx + 1} · 发件人：${msg.sender_name || msg.sender} (${msg.created_at})\n\n`
      md += `- **发件人**：${msg.sender_name ? `${msg.sender_name} <${msg.sender}>` : msg.sender}\n`
      md += `- **收件人**：${msg.recipient}\n`
      md += `- **发送时间**：${msg.created_at}\n\n`
      md += `### 邮件正文\n\n${msg.body}\n\n`

      if (msg.attachments) {
        try {
          const atts = JSON.parse(msg.attachments) as Array<{ name: string; size: number; mime: string }>
          if (Array.isArray(atts) && atts.length > 0) {
            md += `### 随附医学附件\n\n`
            atts.forEach((a, aIdx) => {
              md += `${aIdx + 1}. **${a.name}** (${(a.size / 1024).toFixed(1)} KB, \`${a.mime}\`)\n`
            })
            md += `\n`
          }
        } catch {}
      }
      md += `---\n\n`
    })

    const content = schema.node('doc', null, parseBlocks(md))
    const row = docs.create({ owner: user, title: docTitle, content })
    if (project) store.setDocProject(row.id, project)

    return c.json({ ok: true, doc_id: row.id, title: row.title }, 201)
  })

  // 邮件一键归档到患者档案 (Filing to Patient EHR)
  app.post('/api/mail/messages/:id/to-patient', async c => {
    const user = c.get('user')
    const m = mail.get(user, c.req.param('id'))
    if (!m) return c.json({ error: '邮件不存在' }, 404)

    const bodyJson = await c.req.json().catch(() => ({})) as { patient_id?: string; patient_code?: string; note?: string }
    const patientKey = bodyJson.patient_id || m.patient_id || bodyJson.patient_code || m.patient_code
    if (!patientKey) return c.json({ error: '请指定目标患者' }, 400)

    let ptRow: any
    try {
      ptRow = pt(c).read(me(c), patientKey)
    } catch {
      try {
        const allPts = pt(c).list(me(c))
        ptRow = allPts.find(p => p.id === patientKey || p.code === patientKey)
      } catch {}
    }
    if (!ptRow) return c.json({ error: `未找到患者档案 [${patientKey}]` }, 404)

    const docTitle = `${ptRow.code} 随访专邮记录 · ${m.subject.slice(0, 30)}`
    let md = `# ${docTitle}\n\n`
    md += `> **患者随访专邮归档**\n`
    md += `> - 患者编号：\`${ptRow.code}\`\n`
    md += `> - 邮件主题：${m.subject}\n`
    md += `> - 发件人：${m.sender_name ? `${m.sender_name} (${m.sender})` : m.sender}\n`
    md += `> - 收件人：${m.recipient}\n`
    md += `> - 邮件日期：${m.created_at}\n`
    if (bodyJson.note) md += `> - 医生批注：${bodyJson.note}\n`
    md += `\n---\n\n### 邮件正文记录\n\n${m.body}\n`

    const content = schema.node('doc', null, parseBlocks(md))
    const docRow = docs.create({ owner: user, title: docTitle, content })

    pt(c).linkDoc(me(c), ptRow.id, docRow.id, 'consultation')
    store.updateMailPatient(user, m.id, ptRow.id, ptRow.code)

    return c.json({
      ok: true,
      patient_id: ptRow.id,
      patient_code: ptRow.code,
      doc_id: docRow.id,
      title: docTitle,
    }, 201)
  })

  // 邮件附件导入到资料库 (Import Attachment to KB / RAG)
  app.post('/api/mail/messages/:id/attachments/:attId/to-kb', async c => {
    if (!kb) return c.json({ error: '资料库未启用' }, 503)
    const user = c.get('user')
    const m = mail.get(user, c.req.param('id'))
    if (!m) return c.json({ error: '邮件不存在' }, 404)

    const attId = c.req.param('attId')
    let attachments: Array<{ id: string; name: string; size: number; mime: string; data_base64?: string }> = []
    if (m.attachments) {
      try {
        attachments = JSON.parse(m.attachments)
      } catch {}
    }
    const att = attachments.find(a => a.id === attId || a.name === attId)
    if (!att) return c.json({ error: '附件不存在' }, 404)

    let bytes: Uint8Array
    if (att.data_base64) {
      bytes = new Uint8Array(Buffer.from(att.data_base64, 'base64'))
    } else {
      const textContent = `【邮件附件资料】${att.name}\n来源邮件：${m.subject}\n发件人：${m.sender_name || m.sender}\n时间：${m.created_at}\n\n${m.body}`
      bytes = new TextEncoder().encode(textContent)
    }

    try {
      const r = await kb.upload(user, {
        name: att.name,
        bytes,
        project_id: null,
      })
      return c.json({ ok: true, file: r.file, duplicate: r.duplicate }, 201)
    } catch (err) {
      if (err instanceof ExtractError) {
        return c.json({ ok: false, error: err.message }, 400)
      }
      throw err
    }
  })

  // 邮件附件直接下载 (Download Attachment)
  app.get('/api/mail/messages/:id/attachments/:attId/download', c => {
    const user = c.get('user')
    const m = mail.get(user, c.req.param('id'))
    if (!m) return c.json({ error: '邮件不存在' }, 404)

    const attId = c.req.param('attId')
    let attachments: Array<{ id: string; name: string; size: number; mime: string; data_base64?: string }> = []
    if (m.attachments) {
      try {
        attachments = JSON.parse(m.attachments)
      } catch {}
    }
    const att = attachments.find(a => a.id === attId || a.name === attId)
    if (!att) return c.json({ error: '附件不存在' }, 404)

    let bytes: Uint8Array
    if (att.data_base64) {
      bytes = new Uint8Array(Buffer.from(att.data_base64, 'base64'))
    } else {
      const textContent = `【Heurion 专邮附件】${att.name}\n主题：${m.subject}\n发件人：${m.sender}\n时间：${m.created_at}\n\n${m.body}`
      bytes = new TextEncoder().encode(textContent)
    }

    return c.body(Buffer.from(bytes), 200, {
      'Content-Type': att.mime || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(att.name)}`,
      'Cache-Control': 'no-store',
    })
  })

  app.patch('/api/mail/messages/:id/read', async c => {
    const user = c.get('user')
    const m = mail.get(user, c.req.param('id'))
    if (!m) return c.json({ error: '邮件不存在' }, 404)
    const body = (await c.req.json().catch(() => ({ read: true }))) as { read?: boolean }
    mail.markRead(user, c.req.param('id'), body.read !== false)
    return c.json({ ok: true })
  })

  app.patch('/api/mail/messages/:id/star', async c => {
    const user = c.get('user')
    const m = mail.get(user, c.req.param('id'))
    if (!m) return c.json({ error: '邮件不存在' }, 404)
    const body = (await c.req.json().catch(() => ({ starred: true }))) as { starred?: boolean }
    mail.setStarred(user, c.req.param('id'), body.starred !== false)
    return c.json({ ok: true })
  })

  app.post('/api/mail/read-all', c => {
    const user = c.get('user')
    mail.markAllRead(user)
    return c.json({ ok: true })
  })

  app.post('/api/mail/batch', async c => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { action?: string; ids?: string[]; folder?: 'inbox' | 'sent' | 'trash' }
    if (body.action === 'empty_trash') {
      const count = mail.emptyTrash(user)
      return c.json({ ok: true, count })
    }
    const ids = Array.isArray(body.ids) ? body.ids : []
    if (!ids.length) return c.json({ ok: false, error: '未提供邮件 ID 列表' }, 400)
    switch (body.action) {
      case 'read':
        mail.batchRead(user, ids, true)
        break
      case 'unread':
        mail.batchRead(user, ids, false)
        break
      case 'star':
        mail.batchStar(user, ids, true)
        break
      case 'unstar':
        mail.batchStar(user, ids, false)
        break
      case 'trash':
        mail.batchMove(user, ids, 'trash')
        break
      case 'restore':
        mail.batchMove(user, ids, 'inbox')
        break
      case 'delete':
        mail.batchDelete(user, ids)
        break
      case 'move':
        if (body.folder === 'inbox' || body.folder === 'sent' || body.folder === 'trash') {
          mail.batchMove(user, ids, body.folder)
        }
        break
      default:
        return c.json({ ok: false, error: '未知的邮件批量操作类型' }, 400)
    }
    return c.json({ ok: true, count: ids.length })
  })

  app.delete('/api/mail/trash', c => {
    const user = c.get('user')
    const count = mail.emptyTrash(user)
    return c.json({ ok: true, count })
  })

  app.delete('/api/mail/messages/:id', c => {
    const user = c.get('user')
    const m = mail.get(user, c.req.param('id'))
    if (!m) return c.json({ error: '邮件不存在' }, 404)
    mail.delete(user, c.req.param('id'))
    return c.json({ ok: true })
  })

  // 外部来信 Webhook (支持 Cloudflare Email Routing / Resend Inbound 等投递给各医生专属邮箱，如 hui@heurion.org)
  app.post('/api/mail/inbound', async c => {
    const secret = process.env.MAIL_INBOUND_SECRET
    if (!secret && process.env.NODE_ENV === 'production') {
      return c.json({ error: 'inbound_webhook_not_configured' }, 503)
    }
    if (secret) {
      const provided = c.req.header('x-inbound-secret') || (c.req.header('authorization')?.startsWith('Bearer ') ? c.req.header('authorization')!.slice(7) : '')
      const secBuf = Buffer.from(secret, 'utf8')
      const provBuf = Buffer.from(provided, 'utf8')
      if (secBuf.length !== provBuf.length || !timingSafeEqual(secBuf, provBuf)) {
        return c.json({ error: 'unauthorized' }, 401)
      }
    }
    const body = await c.req.json().catch(() => ({}))
    const from = body.from || body.sender || ''
    const to = Array.isArray(body.to) ? body.to[0] : (body.to || body.recipient || '')
    const subject = body.subject || ''
    const text = body.text || body.body || body.html || ''
    if (!to || !from) return c.json({ error: '缺少发件人(from)或收件人(to)' }, 400)

    const res = await mail.receiveInbound({
      from,
      fromName: body.from_name || body.name,
      to,
      subject,
      body: text,
      category: body.category || 'general',
    })
    if (!res.success) return c.json({ ok: false, error: res.reason }, 404)
    return c.json({ ok: true, id: res.message?.id }, 201)
  })

  // —— 日历与随访排期、科研项目进度 (Calendar) ——
  app.get('/api/calendar/events', c => {
    const user = c.get('user')
    const u = store.getUser(user)
    const from = c.req.query('from') || undefined
    const to = c.req.query('to') || undefined
    const category = c.req.query('category') || undefined
    const status = c.req.query('status') || undefined
    const search = c.req.query('search') || undefined
    const pageParam = c.req.query('page')
    const pageSizeParam = c.req.query('page_size') || c.req.query('pageSize')

    const list = calendar.list(user, { from, to, category, status, search, username: u?.username ?? user })

    if (pageParam !== undefined) {
      const page = Math.max(1, parseInt(pageParam, 10) || 1)
      const pageSize = Math.max(1, Math.min(100, parseInt(pageSizeParam || '20', 10) || 20))
      const total = list.length
      const totalPages = Math.ceil(total / pageSize) || 1
      const start = (page - 1) * pageSize
      const items = list.slice(start, start + pageSize)
      return c.json({
        items,
        total,
        page,
        page_size: pageSize,
        total_pages: totalPages,
      })
    }

    return c.json(list)
  })

  app.get('/api/calendar/events/:id', c => {
    const user = c.get('user')
    const e = calendar.get(user, c.req.param('id'))
    if (!e) return c.json({ error: '日程不存在' }, 404)
    return c.json(e)
  })

  app.post('/api/calendar/events', async c => {
    const user = c.get('user')
    const u = store.getUser(user)
    const body = await c.req.json()
    if (!body.title || !body.start_time || !body.end_time) {
      return c.json({ error: '标题、开始时间与结束时间为必填项' }, 400)
    }
    const e = calendar.create({
      userId: user,
      tenantId: u?.tenant_id,
      title: body.title,
      description: body.description,
      startTime: body.start_time,
      endTime: body.end_time,
      allDay: Boolean(body.all_day),
      category: body.category || 'general',
      patientId: body.patient_id,
      patientCode: body.patient_code,
      studyId: body.study_id,
      studyTitle: body.study_title,
      location: body.location,
      sendEmail: Boolean(body.send_email),
      username: u?.username ?? user,
    })
    return c.json(e, 201)
  })

  app.patch('/api/calendar/events/:id', async c => {
    const user = c.get('user')
    const body = await c.req.json()
    const updated = calendar.update(user, c.req.param('id'), body)
    if (!updated) return c.json({ error: '日程不存在' }, 404)
    return c.json(updated)
  })

  app.post('/api/calendar/batch', async c => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({})) as { action?: string; ids?: string[] }
    const ids = Array.isArray(body.ids) ? body.ids : []
    if (!ids.length) return c.json({ ok: false, error: '未提供日程 ID 列表' }, 400)
    switch (body.action) {
      case 'complete':
        calendar.batchUpdateStatus(user, ids, 'completed')
        break
      case 'schedule':
        calendar.batchUpdateStatus(user, ids, 'scheduled')
        break
      case 'delete':
        calendar.batchDelete(user, ids)
        break
      default:
        return c.json({ ok: false, error: '未知的日程批量操作类型' }, 400)
    }
    return c.json({ ok: true, count: ids.length })
  })

  app.delete('/api/calendar/events/:id', c => {
    const user = c.get('user')
    const e = calendar.get(user, c.req.param('id'))
    if (!e) return c.json({ error: '日程不存在' }, 404)
    calendar.delete(user, c.req.param('id'))
    return c.json({ ok: true })
  })
}
