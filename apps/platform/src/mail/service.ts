import type { Store, MailMessageRow, UserRow, MailAttachment } from '../store/db.ts'
import type { Mailer } from '../auth/mailer.ts'

export interface SendMailInput {
  userId: string
  recipientUserId?: string | null
  tenantId?: string | null
  sender?: string
  senderName?: string
  recipient: string
  subject: string
  body: string
  category: 'followup' | 'research' | 'notification' | 'general'
  patientId?: string | null
  patientCode?: string | null
  studyId?: string | null
  studyTitle?: string | null
  calendarEventId?: string | null
  folder?: 'inbox' | 'sent'
  threadId?: string | null
  inReplyTo?: string | null
  attachments?: MailAttachment[] | string | null
}

export interface MailDeliveryInfo {
  status: 'delivered' | 'external_sent' | 'simulated' | 'failed'
  note: string
  external: boolean
  configured: boolean
}

export interface MailSummaryItem {
  id: string
  subject: string
  category: string
  sender: string
  sender_name?: string | null
  patient_code?: string | null
  study_id?: string | null
  created_at: string
}

export interface MailSummaryResult {
  hours: number
  total: number
  count: number
  unread: number
  followup_count: number
  research_count: number
  source_mails: MailSummaryItem[]
  items: MailSummaryItem[]
  generated_at: string
  summary: string
  ai_powered: boolean
}

function extractEmail(str: string): string {
  if (!str) return ''
  const m = str.match(/<([^>]+)>/)
  return (m && m[1] ? m[1] : str).trim()
}

/** 移除字符串中的所有 Emoji 彩色表情符号，保证临床科研工作站专业严谨的视觉体系 */
export function stripEmojis(str: string): string {
  if (!str) return ''
  return str
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B50}-\u{2B55}\u{FE00}-\u{FE0F}]/gu, '')
    .trim()
}

/** 解码 RFC 2047 格式的 MIME 头部字段 (如 =?UTF-8?B?...?= 或 =?UTF-8?Q?...?=) */
export function decodeMimeWords(str: string): string {
  if (!str || !str.includes('=?')) return str
  // RFC 2047 规范：相邻 encoded-word 之间的空白符必须被忽略
  const cleaned = str.replace(/(\?=\s+=\?)/g, '?==?')
  return cleaned.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
    try {
      const enc = encoding.toUpperCase()
      const cs = (charset || 'utf-8').toLowerCase()
      if (enc === 'B') {
        const buf = Buffer.from(text, 'base64')
        const decoder = new TextDecoder(cs.includes('gb') ? 'gb18030' : 'utf-8')
        return decoder.decode(buf)
      } else if (enc === 'Q') {
        const replaced = text.replace(/_/g, ' ')
        const bytes: number[] = []
        for (let i = 0; i < replaced.length; i++) {
          if (replaced[i] === '=' && i + 2 < replaced.length && /^[0-9A-Fa-f]{2}$/.test(replaced.slice(i + 1, i + 3))) {
            bytes.push(parseInt(replaced.slice(i + 1, i + 3), 16))
            i += 2
          } else {
            bytes.push(replaced.charCodeAt(i))
          }
        }
        const decoder = new TextDecoder(cs.includes('gb') ? 'gb18030' : 'utf-8')
        return decoder.decode(new Uint8Array(bytes))
      }
    } catch {
      return text
    }
    return text
  })
}

/** 解码 Quoted-Printable 格式的正文 (支持 UTF-8 与 GB18030 / GBK) */
export function decodeQuotedPrintable(str: string, charset?: string): string {
  if (!str) return ''
  // 1. 去除软换行 (soft line breaks: =\r\n 或 =\n)
  const s = str.replace(/=\r?\n/g, '')
  if (!/=[0-9A-Fa-f]{2}/.test(s)) return s

  // 2. 将 =XX 转换为真实字节
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && i + 2 < s.length && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      const code = s.charCodeAt(i)
      if (code < 128) {
        bytes.push(code)
      } else {
        const charBuf = Buffer.from(s[i]!, 'utf-8')
        for (const b of charBuf) bytes.push(b)
      }
    }
  }
  const u8 = new Uint8Array(bytes)
  const cs = (charset || '').toLowerCase()
  if (cs.includes('gb')) {
    try {
      return new TextDecoder('gb18030').decode(u8)
    } catch {}
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(u8)
    } catch {
      return s
    }
  }
}

/** 智能探测并解码 Base64 编码的邮件正文块（支持换行折行、空格容错、UTF-8 及 GB18030） */
export function decodeBase64Chunk(raw: string, charset?: string): string {
  if (!raw) return raw
  // 移除所有空白符（空格、换行、制表符）
  const compact = raw.replace(/\s+/g, '')
  // 合法 Base64 结构判定
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length < 8) {
    return raw
  }

  const padLen = (4 - (compact.length % 4)) % 4
  const padded = compact + '='.repeat(padLen)

  try {
    const buf = Buffer.from(padded, 'base64')
    let decoded = ''
    const cs = (charset || '').toLowerCase()
    if (cs.includes('gb')) {
      try {
        decoded = new TextDecoder('gb18030').decode(buf)
      } catch {}
    }
    if (!decoded) {
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      } catch {
        try {
          decoded = new TextDecoder('gb18030').decode(buf)
        } catch {}
      }
    }
    if (!decoded) return raw

    // 含有中文，或者是正常可读文本
    if (/[\u4e00-\u9fa5]/.test(decoded)) {
      return decoded
    }
    const cleanChars = decoded.replace(/[\r\n\t\x20-\x7e\u00a0-\uffff]/g, '')
    if (cleanChars.length === 0 && decoded.trim().length > 3) {
      return decoded
    }
  } catch {
    // not valid base64
  }
  return raw
}

/** 智能从原始 MIME 字符串中提取 text/plain 或 text/html 内容 */
export function parseMimeText(rawText: string): string {
  if (!rawText) return ''
  const boundaryMatch = rawText.match(/boundary="?([^"\r\n;]+)"?/i)
  if (boundaryMatch) {
    const boundary = boundaryMatch[1]!.trim()
    const parts = rawText.split(new RegExp(`--${boundary}(?:--)?`))
    // 优先寻找 text/plain
    for (const part of parts) {
      const split = part.split(/\r?\n\r?\n/)
      if (split.length > 1 && /content-type:\s*text\/plain/i.test(split[0]!)) {
        const bodyPart = split.slice(1).join('\n\n').trim()
        const csMatch = split[0]!.match(/charset="?([^"\r\n;]+)"?/i)
        return decodeEmailBody(bodyPart, csMatch ? csMatch[1] : undefined)
      }
    }
    // 备选 text/html
    for (const part of parts) {
      const split = part.split(/\r?\n\r?\n/)
      if (split.length > 1 && /content-type:\s*text\/html/i.test(split[0]!)) {
        const bodyPart = split.slice(1).join('\n\n').trim()
        const csMatch = split[0]!.match(/charset="?([^"\r\n;]+)"?/i)
        const html = decodeEmailBody(bodyPart, csMatch ? csMatch[1] : undefined)
        return html
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<\/div>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&amp;/gi, '&')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .trim()
      }
    }
  }
  return rawText
}

/** 智能探测并解码邮件正文（兼容全文本 Base64、分块 Base64、Quoted-Printable、MIME Multipart 及多字符集） */
export function decodeEmailBody(body: string, charset?: string): string {
  if (!body) return ''
  // 1. 若正文中包含 MIME boundary 结构，优先提取正文分块
  let text = parseMimeText(body).trim()

  // 2. 全文 Base64 探测与解码
  const fullDecoded = decodeBase64Chunk(text, charset)
  if (fullDecoded !== text) {
    text = fullDecoded
  } else {
    // 3. 分段 Base64 探测（如邮件带有部分未分块明文，或带有引用头部）
    const blocks = text.split(/\r?\n\r?\n/)
    let changed = false
    const decodedBlocks = blocks.map(b => {
      const trimmedBlock = b.trim()
      const d = decodeBase64Chunk(trimmedBlock, charset)
      if (d !== trimmedBlock) {
        changed = true
        return d
      }
      return b
    })
    if (changed) {
      text = decodedBlocks.join('\n\n')
    }
  }

  // 4. Quoted-Printable 探测与解码 (支持 UTF-8 与 GB18030)
  if (/=[0-9A-Fa-f]{2}/.test(text) || /=\r?\n/.test(text)) {
    text = decodeQuotedPrintable(text, charset)
  }

  // 5. 清理残留的 MIME boundary 标记
  text = text.replace(/--[a-zA-Z0-9_\-=]+--?\s*$/g, '').trim()
  return text
}

export class MailService {
  readonly domain: string
  private readonly complete?: ((system: string, user: string) => Promise<string>) | null
  private summaryCache = new Map<string, { time: number; hash: string; result: MailSummaryResult }>()

  constructor(
    private readonly store: Store,
    private readonly mailer?: Mailer,
    opts: {
      domain?: string
      complete?: ((system: string, user: string) => Promise<string>) | null
    } = {},
  ) {
    this.domain = (opts.domain || 'heurion.org').replace(/heurion\.com$/, 'heurion.org')
    this.complete = opts.complete
    this.healExistingMessages()
  }

  /** 自愈历史收到的 Base64 / QP 未解码邮件与补全内置种子邮件的医学附件 */
  public healExistingMessages(): number {
    let healed = 0
    try {
      const rows = this.store.db.prepare('SELECT id, body, subject, sender_name, attachments FROM mail_messages ORDER BY rowid DESC LIMIT 500;').all() as Array<{
        id: string
        body: string
        subject: string
        sender_name: string
        attachments?: string | null
      }>
      for (const row of rows) {
        let needsUpdate = false
        let nextBody = row.body
        let nextSubject = row.subject
        let nextSenderName = row.sender_name
        let nextAttachments = row.attachments

        if (row.body) {
          const decoded = decodeEmailBody(row.body)
          if (decoded && decoded !== row.body) {
            nextBody = decoded
            needsUpdate = true
          }
        }
        if (row.subject && row.subject.includes('=?')) {
          const decodedSub = decodeMimeWords(row.subject)
          if (decodedSub !== row.subject) {
            nextSubject = decodedSub
            needsUpdate = true
          }
        }
        if (row.sender_name && row.sender_name.includes('=?')) {
          const decodedName = decodeMimeWords(row.sender_name)
          if (decodedName !== row.sender_name) {
            nextSenderName = decodedName
            needsUpdate = true
          }
        }

        // 补全内置医学随访与科研课题附件
        if (!row.attachments || row.attachments === '[]') {
          if (row.subject && row.subject.includes('PT-BRONCHO-001')) {
            nextAttachments = JSON.stringify([
              {
                id: 'att-broncho-hrct',
                name: 'PT-BRONCHO-001_HRCT_3D_Mucus_Volumetry.pdf',
                size: 1845120,
                mime: 'application/pdf',
                data_base64: Buffer.from(`%PDF-1.4\n%PT-BRONCHO-001 HRCT 3D Mucus Volumetry Report\nAirway Mucus Segmenter BAR=1.45 HAM=12.44cm3\n`).toString('base64'),
              },
              {
                id: 'att-broncho-pft',
                name: 'PFT_Spirometry_Report_2026Q3.pdf',
                size: 839680,
                mime: 'application/pdf',
                data_base64: Buffer.from(`%PDF-1.4\n%Pulmonary Function Laboratory Report\nFEV1 1.82L (62% pred), FVC 2.95L, FEV1/FVC 61.7%\n`).toString('base64'),
              }
            ])
            needsUpdate = true
          } else if (row.subject && row.subject.includes('DAPA-HF')) {
            nextAttachments = JSON.stringify([
              {
                id: 'att-dapa-psm-table1',
                name: 'DAPA-HF_PSM_Balance_Diagnostics_Table1.csv',
                size: 148480,
                mime: 'text/csv',
                data_base64: Buffer.from(`Covariate,Dapagliflozin (N=710),Standard_Care (N=710),SMD\nAge (years),66.2 (10.8),66.5 (11.1),0.027\nFemale (%),23.4%,23.8%,0.009\nLVEF (%),31.2 (6.8),31.0 (6.7),0.030\nNT-proBNP (pg/mL),1437 (850-2800),1442 (860-2780),0.012\neGFR (mL/min/1.73m2),65.8 (19.4),66.1 (19.2),0.015\nL3_SMI (cm2/m2),41.5 (7.2),41.3 (7.1),0.028\n`).toString('base64'),
              },
              {
                id: 'att-dapa-dsmb-charter',
                name: 'DSMB_Interim_Charter_v3.pdf',
                size: 2457600,
                mime: 'application/pdf',
                data_base64: Buffer.from(`%PDF-1.4\n%DSMB Interim Charter v3.0\nDAPA-HF Clinical Trial NCT03036124 Interim Analysis Plan\n`).toString('base64'),
              }
            ])
            needsUpdate = true
          } else if (row.subject && row.subject.includes('PT-NSCLC-002')) {
            nextAttachments = JSON.stringify([
              {
                id: 'att-nsclc-recist',
                name: 'RECIST_1.1_Tumor_Response_Chart.pdf',
                size: 1228800,
                mime: 'application/pdf',
                data_base64: Buffer.from(`%PDF-1.4\n%RECIST 1.1 Tumor Response Longitudinal Evaluation\nPT-NSCLC-002 Osimertinib 80mg Week 8 Target Lesion Sum: -32.4% (Partial Response PR)\n`).toString('base64'),
              }
            ])
            needsUpdate = true
          }
        }

        if (needsUpdate) {
          this.store.db.prepare('UPDATE mail_messages SET body = ?, subject = ?, sender_name = ?, attachments = ? WHERE id = ?')
            .run(nextBody, nextSubject, nextSenderName, nextAttachments ?? null, row.id)
          healed++
        }
      }
    } catch {
      // 容错保护
    }
    return healed
  }

  /** 是否配置了真实外网发信服务 (SMTP 或 Resend) */
  isConfigured(): boolean {
    return this.mailer?.configured ?? false
  }

  /** 发信服务类型 ('smtp' | 'resend' | 'dev-mock') */
  mailerMode(): string {
    return this.mailer?.mode ?? 'dev-mock'
  }

  /** 用户的工作邮箱地址 (支持设置专属前缀，如 hz@heurion.org 或 zhaohui@heurion.org) */
  userEmail(username: string, workEmailPrefix?: string | null): string {
    const raw = (workEmailPrefix || username).toLowerCase().replace(/[^a-z0-9_.-]/g, '') || 'doctor'
    const cleanUser = raw.replace(/^dr[._-]/, '') || raw
    const domain = (this.domain || 'heurion.org').replace(/heurion\.com$/, 'heurion.org')
    return `${cleanUser}@${domain}`
  }

  /** 获取与某邮件相关的往来会话流 (Gmail Threads 模式) */
  getThread(userId: string, mailId: string): MailMessageRow[] {
    const thread = this.store.listThreadMessages(userId, mailId)
    return thread.map(m => this.normalizeMail(m))
  }

  /** 是否属于平台内部域名 */
  isPlatformDomain(email: string): boolean {
    const lower = email.toLowerCase()
    return lower.endsWith(`@${this.domain}`) || lower.endsWith('@heurion.org') || lower.endsWith('@heurion.com')
  }

  /** 是否为外部互联网真实邮箱（包含 @ 且不属于平台内部域名，必须通过 SMTP/Resend 发往外网） */
  isExternalEmail(email: string): boolean {
    const clean = email.trim().toLowerCase()
    if (!clean.includes('@')) return false
    return !this.isPlatformDomain(clean)
  }

  /** 标准化并解码邮件，若发现存有未解码的 MIME/QP 内容，异步自动洗白存储 */
  private normalizeMail(m: MailMessageRow): MailMessageRow {
    const cleanSub = decodeMimeWords(m.subject)
    const cleanBody = decodeEmailBody(m.body)
    const cleanName = m.sender_name ? decodeMimeWords(m.sender_name) : m.sender_name
    if (cleanSub !== m.subject || cleanBody !== m.body || cleanName !== m.sender_name) {
      try {
        this.store.updateMailCleanText(m.id, cleanSub, cleanBody, cleanName)
      } catch { /* 忽略并发冲突 */ }
      return { ...m, subject: cleanSub, body: cleanBody, sender_name: cleanName }
    }
    return m
  }

  /** 获取邮件列表（若首次访问则自动载入临床与科研示范邮件） */
  list(userId: string, username: string, filterOrCategory?: string | { category?: string; folder?: string; starred?: boolean; unreadOnly?: boolean; search?: string }): MailMessageRow[] {
    this.ensureSeed(userId, username)
    return this.store.listMailMessages(userId, filterOrCategory).map(m => this.normalizeMail(m))
  }

  /** 获取单封邮件 */
  get(userId: string, id: string): MailMessageRow | undefined {
    const m = this.store.getMailMessage(userId, id)
    return m ? this.normalizeMail(m) : undefined
  }

  /** 获取最近 N 小时（默认48小时）收件箱邮件的 AI 临床科研动态提要汇总 */
  async getRecentSummary(userId: string, hours = 48, force = false): Promise<MailSummaryResult> {
    const user = this.store.getUser(userId)
    const username = user?.username ?? userId
    this.ensureSeed(userId, username)

    const now = Date.now()
    const cutoffIso = new Date(now - hours * 3600000).toISOString()
    const allInbox = this.store.listMailMessages(userId, { folder: 'inbox' }).map(m => this.normalizeMail(m))
    const recent = allInbox.filter(m => m.created_at >= cutoffIso)

    // 若 48 小时内收到的邮件较少（例如开发环境新账户），则取最近的前 5 封收件箱邮件进行汇总演示
    const targetMails = recent.length > 0 ? recent : allInbox.slice(0, 5)

    const items: MailSummaryItem[] = targetMails.map(m => ({
      id: m.id,
      subject: m.subject,
      category: m.category,
      sender: m.sender,
      sender_name: m.sender_name,
      patient_code: m.patient_code,
      study_id: m.study_id,
      created_at: m.created_at,
    }))

    const total = targetMails.length
    const unread = targetMails.filter(m => !m.read).length
    const followup_count = targetMails.filter(m => m.category === 'followup').length
    const research_count = targetMails.filter(m => m.category === 'research').length

    if (items.length === 0) {
      return {
        hours,
        total: 0,
        count: 0,
        unread: 0,
        followup_count: 0,
        research_count: 0,
        source_mails: [],
        items: [],
        generated_at: new Date().toISOString(),
        summary: '近 48 小时收件箱暂无新邮件。您可起草新专邮进行临床随访或科研协同。',
        ai_powered: false,
      }
    }

    const currentHash = items.map(i => `${i.id}:${i.created_at}`).join('|')
    const cached = this.summaryCache.get(userId)
    if (!force && cached && cached.hash === currentHash && (now - cached.time < 300_000)) {
      return cached.result
    }

    let summaryText = ''
    let aiPowered = false

    if (this.complete) {
      try {
        const mailContext = targetMails.map((m, idx) => {
          return `【邮件 ${idx + 1}】
- 主题：${m.subject}
- 发件人：${m.sender_name ? `${m.sender_name} (${m.sender})` : m.sender}
- 类别：${m.category}
- 关联患者：${m.patient_code || '无'}
- 关联课题：${m.study_id || '无'}
- 时间：${m.created_at}
- 正文：${m.body.slice(0, 600)}`
        }).join('\n\n')

        const system = `你是一位高年资临床主任与多中心医学试验学术秘书。你的职责是将主诊医师近 48 小时收到的医疗与科研邮件进行高密度、精炼的要点提炼与行动指引。
请使用结构化 Markdown 无序列表输出，要求：
1. 语言极其凝练专业，直接切入核心临床与科研指标（如 BAR、HAM容积、RECIST评估、PSM倾向评分、DSMB审查）；
2. 必须包含且仅包含三个小节：
   - ### 重点随访与复查预警（每个事项使用无序列表格式，如：- **PT-BRONCHO-001**：关键指标；建议门诊/复查时间）
   - ### 科研课题与试验进展（每个事项使用无序列表格式，如：- **DAPA-HF**：入组进度与会议日程）
   - ### 行动要点与待办（医师近期必须跟进确认的事项清单，使用无序列表）
3. 篇幅适中（约 200~350 字），排版美观紧凑。
4. 严禁在输出中包含任何 Emoji 表情符号或装饰图标，所有小节标题只输出纯文本（如 ### 重点随访与复查预警），不要带任何表情或符号前缀。
5. 严禁使用 Markdown 表格语法（| 列1 | 列2 |），一律使用无序列表（- **项目**：内容），确保窄屏侧边栏的极致排版体验。不要输出多余的总体文档大标题（如 # 邮件摘要），不要废话和礼貌用语。`

        const userPrompt = `以下是主诊医师近 48 小时收到的 ${targetMails.length} 封重要邮件，请生成摘要报告：\n\n${mailContext}`

        const res = await this.complete(system, userPrompt)
        if (res && res.trim().length > 30) {
          summaryText = stripEmojis(res.trim())
          aiPowered = true
        }
      } catch (err) {
        console.warn('[mail-summary] LLM call failed, falling back to rule-based summary', (err as Error).message)
      }
    }

    if (!summaryText) {
      summaryText = stripEmojis(this.generateFallbackSummary(targetMails))
      aiPowered = false
    }

    const result: MailSummaryResult = {
      hours,
      total,
      count: total,
      unread,
      followup_count,
      research_count,
      source_mails: items,
      items,
      generated_at: new Date().toISOString(),
      summary: summaryText,
      ai_powered: aiPowered,
    }

    this.summaryCache.set(userId, { time: now, hash: currentHash, result })
    return result
  }

  private generateFallbackSummary(mails: MailMessageRow[]): string {
    const followups = mails.filter(m => m.category === 'followup' || m.patient_code)
    const research = mails.filter(m => m.category === 'research' || m.study_id)
    const others = mails.filter(m => !followups.includes(m) && !research.includes(m))

    const parts: string[] = []

    if (followups.length > 0) {
      parts.push('### 重点随访与复查预警')
      for (const m of followups) {
        const pt = m.patient_code ? `\`${m.patient_code}\`` : ''
        let hint = ''
        if (m.body.includes('HAM =') || m.subject.includes('HAM')) hint = '气道高密度粘液栓 (HAM) 复查及肺功能 (PFT) 评估'
        else if (m.body.includes('RECIST') || m.subject.includes('RECIST')) hint = 'RECIST 1.1 疗效评估与耐药突变监测'
        else if (m.body.includes('SMI =') || m.subject.includes('肌少症')) hint = '恶液质肌少症肠内营养 (ONS) 与化疗耐受评估'
        else hint = m.subject.replace(/【[^】]+】/, '').trim().slice(0, 32)
        parts.push(`- **${pt || '随访'}**：${hint}，需及时锁定门诊日程与影像对比。`)
      }
    }

    if (research.length > 0) {
      parts.push('### 科研课题与试验进展')
      for (const m of research) {
        const st = m.study_id ? `\`${m.study_id}\`` : ''
        let hint = ''
        if (m.body.includes('PSM') || m.subject.includes('倾向评分')) hint = '第 3 阶段队列入组质控达标，18 项协变量 PSM 匹配收敛 (SMD < 0.05)'
        else if (m.body.includes('DSMB') || m.subject.includes('DSMB')) hint = 'DSMB 独立数据监查委员会中期审查会，审议复合终点与同质性'
        else hint = m.subject.replace(/【[^】]+】/, '').trim().slice(0, 36)
        parts.push(`- **${st || '课题'}**：${hint}。`)
      }
    }

    if (others.length > 0) {
      parts.push('### 待办事项与综合通报')
      for (const m of others) {
        parts.push(`- **来信**：${m.subject.slice(0, 35)}（发自 ${m.sender_name || m.sender.split('@')[0]}）`)
      }
    }

    return parts.join('\n\n')
  }

  /** 发送新邮件（同步落库 + 异步外网派发） */
  send(input: SendMailInput): MailMessageRow {
    const user = this.store.getUser(input.userId)
    const sender = input.sender || this.userEmail(user?.username ?? input.userId)
    const senderName = input.senderName || user?.display_name || '主诊医师'
    const recipient = input.recipient.trim()

    const attachmentsJson = Array.isArray(input.attachments)
      ? JSON.stringify(input.attachments)
      : (typeof input.attachments === 'string' ? input.attachments : null)

    // 若明确指定投递至收件箱（如日程创建联动自动下发给本人的随访/科研提醒）
    if (input.folder === 'inbox') {
      return this.store.createMailMessage({
        user_id: input.recipientUserId || input.userId,
        tenant_id: input.tenantId ?? null,
        sender,
        sender_name: senderName,
        recipient,
        subject: input.subject,
        body: input.body,
        category: input.category,
        patient_id: input.patientId ?? null,
        patient_code: input.patientCode ?? null,
        study_id: input.studyId ?? null,
        study_title: input.studyTitle ?? null,
        read: 0,
        starred: 0,
        calendar_event_id: input.calendarEventId ?? null,
        folder: 'inbox',
        delivery_status: 'delivered',
        delivery_note: '系统日程提醒即时送达',
        attachments: attachmentsJson,
      })
    }

    const isExternal = this.isExternalEmail(recipient)
    const internalUser = isExternal ? undefined : this.findInternalUser(recipient)

    let deliveryStatus: MailMessageRow['delivery_status'] = 'delivered'
    let deliveryNote = '院内 / 课题组即时协同送达'

    if (isExternal) {
      if (this.mailer?.configured) {
        deliveryStatus = 'external_sent'
        deliveryNote = `已通过外网发信服务 (${this.mailer.mode.toUpperCase()}) 投递至 ${recipient}`
      } else {
        deliveryStatus = 'simulated'
        deliveryNote = `本地开发模拟：未配置外网发信服务 (SMTP/RESEND_API_KEY)，外部邮箱 (${recipient}) 暂无法收到真实邮件；若需真实发信请在 .env 中配置 SMTP 服务。`
      }
    }

    // 1. 发件人发件箱归档 (folder = 'sent')
    const sentMsg = this.store.createMailMessage({
      user_id: input.userId,
      tenant_id: input.tenantId ?? null,
      sender,
      sender_name: senderName,
      recipient,
      subject: input.subject,
      body: input.body,
      category: input.category,
      patient_id: input.patientId ?? null,
      patient_code: input.patientCode ?? null,
      study_id: input.studyId ?? null,
      study_title: input.studyTitle ?? null,
      read: 1, // 发件人本人视角默认已阅
      starred: 0,
      calendar_event_id: input.calendarEventId ?? null,
      folder: 'sent',
      delivery_status: deliveryStatus,
      delivery_note: deliveryNote,
      thread_id: input.threadId ?? null,
      in_reply_to: input.inReplyTo ?? null,
      attachments: attachmentsJson,
    })

    // 2. 若收件人为系统内部用户（或发给自己），投递一封至收件人收件箱 (folder = 'inbox')
    if (internalUser) {
      this.store.createMailMessage({
        user_id: internalUser.id,
        tenant_id: internalUser.tenant_id ?? null,
        sender,
        sender_name: senderName,
        recipient,
        subject: input.subject,
        body: input.body,
        category: input.category,
        patient_id: input.patientId ?? null,
        patient_code: input.patientCode ?? null,
        study_id: input.studyId ?? null,
        study_title: input.studyTitle ?? null,
        read: 0,
        starred: 0,
        calendar_event_id: input.calendarEventId ?? null,
        folder: 'inbox',
        delivery_status: 'delivered',
        delivery_note: '院内即时协同送达',
        thread_id: input.threadId ?? null,
        in_reply_to: input.inReplyTo ?? null,
        attachments: attachmentsJson,
      })
    }

    // 3. 外网邮件异步发送（或本地模拟打印）
    if (isExternal && this.mailer) {
      let senderAddress = (sender.endsWith(`@${this.domain}`) || sender.endsWith('@heurion.org'))
        ? sender
        : this.userEmail(user?.username ?? input.userId)
      if (senderAddress.endsWith('@heurion.com')) {
        senderAddress = senderAddress.replace(/@heurion\.com$/, '@heurion.org')
      }
      const mailOpts = {
        replyTo: senderAddress,
        senderName: `${senderName} (Heurion)`,
        senderAddress,
      }
      this.mailer.send(recipient, input.subject, input.body, undefined, mailOpts)
        .then(res => {
          if (res.mode === 'simulated') {
            this.store.updateMailDelivery(sentMsg.id, 'simulated', `本地开发模拟：未配置外网发信服务 (SMTP/RESEND_API_KEY)，外部邮箱 (${recipient}) 暂无法收到真实邮件；若需真实发信请在 .env 中配置 SMTP 服务。`)
          } else {
            this.store.updateMailDelivery(sentMsg.id, 'external_sent', `已通过 ${res.mode.toUpperCase()} 成功送出至 ${recipient}`)
          }
        })
        .catch(err => {
          this.store.updateMailDelivery(sentMsg.id, 'failed', `外网发送失败: ${(err as Error).message}`)
        })
    }

    return sentMsg
  }

  /** 发送新邮件（等待外网投递完成并返回详细状态） */
  async sendAsync(input: SendMailInput): Promise<{ message: MailMessageRow; delivery: MailDeliveryInfo }> {
    const user = this.store.getUser(input.userId)
    const sender = input.sender || this.userEmail(user?.username ?? input.userId)
    const senderName = input.senderName || user?.display_name || '主诊医师'
    const recipient = input.recipient.trim()

    const isExternal = this.isExternalEmail(recipient)
    const internalUser = isExternal ? undefined : this.findInternalUser(recipient)

    let senderAddress = (sender.endsWith(`@${this.domain}`) || sender.endsWith('@heurion.org'))
      ? sender
      : this.userEmail(user?.username ?? input.userId)
    if (senderAddress.endsWith('@heurion.com')) {
      senderAddress = senderAddress.replace(/@heurion\.com$/, '@heurion.org')
    }

    const mailOpts = {
      replyTo: senderAddress,
      senderName: `${senderName} (Heurion)`,
      senderAddress,
    }

    let deliveryStatus: MailMessageRow['delivery_status'] = 'delivered'
    let deliveryNote = '院内 / 课题组即时协同送达'

    if (isExternal) {
      if (this.mailer?.configured) {
        try {
          const res = await this.mailer.send(recipient, input.subject, input.body, undefined, mailOpts)
          deliveryStatus = res.mode === 'simulated' ? 'simulated' : 'external_sent'
          deliveryNote = res.mode === 'simulated'
            ? `本地开发模拟：未配置外网发信服务 (SMTP/RESEND_API_KEY)，外部邮箱 (${recipient}) 暂无法收到真实邮件；若需真实发信请在 .env 中配置 SMTP 服务。`
            : `已通过 ${res.mode.toUpperCase()} 成功发送至 ${recipient}`
        } catch (err) {
          deliveryStatus = 'failed'
          deliveryNote = `外网发送失败: ${(err as Error).message}`
        }
      } else {
        deliveryStatus = 'simulated'
        deliveryNote = `本地开发模拟：未配置外网发信服务 (SMTP/RESEND_API_KEY)，外部邮箱 (${recipient}) 暂无法收到真实邮件；若需真实发信请在 .env 中配置 SMTP 服务。`
        if (this.mailer) {
          await this.mailer.send(recipient, input.subject, input.body, undefined, mailOpts).catch(() => {})
        }
      }
    }

    const attachmentsJson = Array.isArray(input.attachments)
      ? JSON.stringify(input.attachments)
      : (typeof input.attachments === 'string' ? input.attachments : null)

    const sentMsg = this.store.createMailMessage({
      user_id: input.userId,
      tenant_id: input.tenantId ?? null,
      sender,
      sender_name: senderName,
      recipient,
      subject: input.subject,
      body: input.body,
      category: input.category,
      patient_id: input.patientId ?? null,
      patient_code: input.patientCode ?? null,
      study_id: input.studyId ?? null,
      study_title: input.studyTitle ?? null,
      read: 1,
      starred: 0,
      calendar_event_id: input.calendarEventId ?? null,
      folder: 'sent',
      delivery_status: deliveryStatus,
      delivery_note: deliveryNote,
      thread_id: input.threadId ?? null,
      in_reply_to: input.inReplyTo ?? null,
      attachments: attachmentsJson,
    })

    if (internalUser) {
      this.store.createMailMessage({
        user_id: internalUser.id,
        tenant_id: internalUser.tenant_id ?? null,
        sender,
        sender_name: senderName,
        recipient,
        subject: input.subject,
        body: input.body,
        category: input.category,
        patient_id: input.patientId ?? null,
        patient_code: input.patientCode ?? null,
        study_id: input.studyId ?? null,
        study_title: input.studyTitle ?? null,
        read: 0,
        starred: 0,
        calendar_event_id: input.calendarEventId ?? null,
        folder: 'inbox',
        delivery_status: 'delivered',
        delivery_note: '院内即时协同送达',
        thread_id: input.threadId ?? null,
        in_reply_to: input.inReplyTo ?? null,
        attachments: attachmentsJson,
      })
    }

    return {
      message: sentMsg,
      delivery: {
        status: deliveryStatus ?? 'delivered',
        note: deliveryNote,
        external: isExternal,
        configured: this.mailer?.configured ?? false,
      },
    }
  }

  /** 接收来自外部 Webhook (Cloudflare Email Routing 或 Resend Inbound) 的外部来信并实现方案 3（站内归档 + 个人邮箱自动转发副本） */
  async receiveInbound(input: {
    from: string
    fromName?: string
    to: string
    subject: string
    body: string
    category?: 'followup' | 'research' | 'notification' | 'general'
  }): Promise<{ success: boolean; message?: MailMessageRow; forwardedTo?: string; reason?: string }> {
    const recipient = extractEmail(input.to)
    const sender = extractEmail(input.from)
    const internalUser = this.findInternalUser(recipient)
    if (!internalUser) {
      return { success: false, reason: `收件地址 ${recipient} 未匹配到站内有效医生/研究员账户` }
    }

    const subject = decodeMimeWords(input.subject || '（无主题）')
    const body = decodeEmailBody(input.body || '')
    const rawFromName = input.fromName || input.from.split('<')[0]?.replace(/"/g, '')?.trim() || ''
    const decodedFromName = decodeMimeWords(rawFromName)
    const senderName = (decodedFromName && decodedFromName !== sender) ? decodedFromName : (sender.split('@')[0] || '外部来信')

    const msg = this.store.createMailMessage({
      user_id: internalUser.id,
      tenant_id: internalUser.tenant_id ?? null,
      sender,
      sender_name: senderName,
      recipient,
      subject,
      body,
      category: input.category || 'general',
      patient_id: null,
      patient_code: null,
      study_id: null,
      study_title: null,
      calendar_event_id: null,
      folder: 'inbox',
      read: 0,
      starred: 0,
      delivery_status: 'delivered',
      delivery_note: '外部外网来信 (通过 Webhook 接收)',
    })

    // 方案 3 联动：若医生在平台绑定了外部个人邮箱（如 Gmail / 医院邮箱），自动将副本无缝转交至其个人邮箱
    let forwardedTo: string | undefined
    const personalEmail = internalUser.email?.trim()
    if (personalEmail && personalEmail.toLowerCase() !== recipient.toLowerCase() && this.mailer?.configured) {
      forwardedTo = personalEmail
      const forwardSubject = `[Heurion 外部来信转交] ${subject}`
      const forwardBody = `【Heurion 临床工作站 · 专属邮箱自动转交通知】\n\n`
        + `发件人: ${senderName !== sender ? `${senderName} <${sender}>` : sender}\n`
        + `收件人: ${recipient} (您的 Heurion 专属工作邮箱)\n`
        + `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`
        + `--------------------------------------------------\n\n`
        + `${body}\n\n`
        + `--------------------------------------------------\n`
        + `提示：此邮件已同步归档至您的 Heurion 工作台【收件箱】中。直接回复此邮件即可送达外部发件人。`

      this.mailer.send(personalEmail, forwardSubject, forwardBody, undefined, {
        replyTo: sender,
        senderName: `${senderName !== sender ? senderName : '外部发件人'} (via Heurion)`,
        senderAddress: recipient,
      }).catch(err => {
        console.error('[inbound-forward-error]', personalEmail, (err as Error).message)
      })
    }

    return { success: true, message: msg, forwardedTo }
  }

  /** 查找系统注册的站内收件用户 */
  findInternalUser(recipientEmail: string): UserRow | undefined {
    const clean = extractEmail(recipientEmail).trim().toLowerCase()
    const byEmail = this.store.getUserByEmail(clean)
    if (byEmail) return byEmail

    const heurionMatch = clean.match(/^(?:dr[._-])?([a-z0-9_.-]+)@(heurion\.org|heurion\.com)$/)
    if (heurionMatch && heurionMatch[1]) {
      const username = heurionMatch[1]
      const byName = this.store.getUserByName(username)
      if (byName) return byName
    }

    const cleanUser = clean.split('@')[0]?.replace(/^dr[._-]/, '') || clean

    const all = this.store.listUsers()
    return all.find(u => {
      const uname = u.username.toLowerCase()
      const unameStripped = uname.replace(/^dr[._-]/, '')
      const workPrefix = (u.work_email_prefix || '').toLowerCase()
      if (workPrefix && (`${workPrefix}@${this.domain}` === clean || `${workPrefix}@heurion.org` === clean || `dr.${workPrefix}@heurion.org` === clean)) return true
      if (workPrefix && workPrefix === cleanUser) return true
      if (u.email && u.email.toLowerCase() === clean) return true
      if (uname === clean || unameStripped === cleanUser) return true
      if (`${uname}@${this.domain}` === clean || `${unameStripped}@${this.domain}` === clean) return true
      if (`dr.${uname}@${this.domain}` === clean) return true
      if (`${uname}@heurion.org` === clean || `${unameStripped}@heurion.org` === clean) return true
      if (`dr.${uname}@heurion.org` === clean) return true
      if (`${uname}@heurion.com` === clean || `${unameStripped}@heurion.com` === clean) return true
      if (`dr.${uname}@heurion.com` === clean) return true
      return false
    })
  }


  /** 标为已读/未读 */
  markRead(userId: string, id: string, read = true): void {
    this.store.markMailRead(userId, id, read)
  }

  /** 全部标为已读 */
  markAllRead(userId: string): void {
    this.store.markAllMailsRead(userId)
  }

  /** 标星 / 取消标星 */
  setStarred(userId: string, id: string, starred = true): void {
    this.store.setMailStarred(userId, id, starred)
  }

  /** 移动邮件文件夹 (inbox / sent / trash) */
  moveFolder(userId: string, id: string, folder: 'inbox' | 'sent' | 'trash'): void {
    this.store.moveMailFolder(userId, id, folder)
  }

  /** 删除邮件 */
  delete(userId: string, id: string): void {
    this.store.deleteMailMessage(userId, id)
  }

  /** 批量标为已读/未读 */
  batchRead(userId: string, ids: string[], read = true): void {
    this.store.batchMarkMailRead(userId, ids, read)
  }

  /** 批量标星 / 取消标星 */
  batchStar(userId: string, ids: string[], starred = true): void {
    this.store.batchSetMailStarred(userId, ids, starred)
  }

  /** 批量移动文件夹 (如移入废纸篓 / 批量恢复) */
  batchMove(userId: string, ids: string[], folder: 'inbox' | 'sent' | 'trash'): void {
    this.store.batchMoveMailFolder(userId, ids, folder)
  }

  /** 批量彻底删除 */
  batchDelete(userId: string, ids: string[]): void {
    this.store.batchDeleteMailMessages(userId, ids)
  }

  /** 清空废纸篓 */
  emptyTrash(userId: string): number {
    return this.store.emptyMailTrash(userId)
  }

  /** 首次访问用户种子数据初始化：涵盖随访计划与科研项目进度两大核心类别 */
  private ensureSeed(userId: string, username: string): void {
    const seeded = this.store.getUserSetting(userId, 'mail_seeded')
    if (seeded === '1') return

    // 检查任何文件夹（收件箱、已发送、废纸篓）中是否已有邮件
    const existing = this.store.listMailMessages(userId, { folder: 'all' })
    if (existing.length > 0) {
      this.store.setUserSetting(userId, 'mail_seeded', '1')
      return
    }

    const myEmail = this.userEmail(username)
    const now = new Date()
    const isoHoursAgo = (hours: number) => new Date(now.getTime() - hours * 3600000).toISOString()

    const seedMails: Array<Omit<MailMessageRow, 'id' | 'folder' | 'delivery_status' | 'delivery_note'>> = [
      {
        user_id: userId,
        tenant_id: null,
        sender: 'followup@heurion.org',
        sender_name: 'Heurion 智能随访中心',
        recipient: myEmail,
        subject: '【随访计划】PT-BRONCHO-001 气道高密度粘液栓 (HAM) 与支气管扩张 3 个月影像复查与肺功能随访',
        category: 'followup',
        patient_id: 'PT-BRONCHO-001',
        patient_code: 'PT-BRONCHO-001',
        study_id: null,
        study_title: null,
        read: 0,
        starred: 1,
        calendar_event_id: null,
        created_at: isoHoursAgo(2),
        body: `### 患者复查随访通知 · PT-BRONCHO-001

尊敬的主诊医师：

根据您为患者 **PT-BRONCHO-001** 制定的诊疗随访路径，患者已规律口服糖皮质激素（泼尼松 30mg qd）联合伏立康唑（200mg bid）治疗满 **12 周**。系统智能随访调度引擎已自动为您生成近期的随访复查计划：

- **患者代号**：\`PT-BRONCHO-001\` (52岁女性，零 PHI 规范建档)
- **基线量化基准**：
  - 支气管伴行动脉比 **BAR = 1.45** (双肺多发印戒征)
  - 高密度粘液栓容积 **HAM = 12.44 cm³ (98 HU)**
  - 血清总 IgE 1,840 IU/mL，曲霉特异性 IgE 24.6 kUA/L
- **本轮随访复查目标 (Follow-up Targets)**：
  1. **全胸部薄层吸气相 HRCT (1.0 mm)**：运行 \`airway_mucus_segmenter\` 自动对比高密度粘液栓 3D 容积吸收率及气道树再通程度；
  2. **肺功能测定 (PFT)**：评估 FEV1、FVC 及小气道阻塞通气功能改善率；
  3. **实验室生化及免疫**：血常规嗜酸性粒细胞绝对计数 (EOS)、血清总 IgE、肝功能监测（伏立康唑肝代谢监测）。
- **建议预约时间**：**2026年10月12日 (周一) 上午 09:30 - 10:30**
- **检查地点**：门诊综合二区呼吸专科诊室 / 影像中心 CT 3 号机房

您可直接在下方点击**「添加到日历」**以锁定门诊日程，或点击**「查看患者档案」**查阅基线 3D 影像切片与化验趋势。`,
        attachments: JSON.stringify([
          {
            id: 'att-broncho-hrct',
            name: 'PT-BRONCHO-001_HRCT_3D_Mucus_Volumetry.pdf',
            size: 1845120,
            mime: 'application/pdf',
            data_base64: Buffer.from(`%PDF-1.4\n%PT-BRONCHO-001 HRCT 3D Mucus Volumetry Report\nAirway Mucus Segmenter BAR=1.45 HAM=12.44cm3\n`).toString('base64'),
          },
          {
            id: 'att-broncho-pft',
            name: 'PFT_Spirometry_Report_2026Q3.pdf',
            size: 839680,
            mime: 'application/pdf',
            data_base64: Buffer.from(`%PDF-1.4\n%Pulmonary Function Laboratory Report\nFEV1 1.82L (62% pred), FVC 2.95L, FEV1/FVC 61.7%\n`).toString('base64'),
          }
        ]),
      },
      {
        user_id: userId,
        tenant_id: null,
        sender: 'research.dapa-hf@heurion.org',
        sender_name: 'DAPA-HF 国际多中心课题组',
        recipient: myEmail,
        subject: '【科研进度周报】DAPA-HF 里程碑前瞻性队列研究 · 第 3 阶段入组达标与倾向评分匹配 (PSM) 质控完成',
        category: 'research',
        patient_id: null,
        patient_code: null,
        study_id: 'DAPA-HF-RCT-2019',
        study_title: 'DAPA-HF 达格列净心衰里程碑前瞻性队列研究 (NCT03036124)',
        read: 0,
        starred: 1,
        calendar_event_id: null,
        created_at: isoHoursAgo(5),
        body: `### 国际多中心临床科研项目进度简报 (Study Progress Report)

**课题编号**：ClinicalTrials.gov Identifier: **NCT03036124** · EudraCT: **2016-003290-34**  
**课题名称**：DAPA-HF 达格列净在射血分数降低心衰患者中的疗效与预后评估前瞻性队列  
**牵头研究者**：Prof. John J.V. McMurray & Prof. Scott D. Solomon (全球 20 国 410 家参研中心)

尊敬的参研学者与课题组成员：

平台沙箱生物统计引擎已自动完成全中心数据治理与第 3 阶段入组质控，核心进度汇报如下：

1. **队列样本入组进度 (Accrual & Screening)**：
   - 国际多中心初筛累计 **5,640 例**，严格执行排除标准后合格入组 **4,744 例**；
   - 真实世界 18 项协变量 1:1 倾向评分匹配 (PSM) 成功收敛：**达格列净组 710 例 vs GDMT 对照组 710 例 (共 1,420 例)**。
2. **基线协变量平衡性诊断 (SMD Balance)**：
   - 年龄、LVEF、NT-proBNP、eGFR 及 **CT 测得的 L3 SMI 骨骼肌指数**等全部 18 项协变量的绝对标准化均数差 **SMD 均已收敛至 < 0.05**，完全达到拟随机化平行平衡。
3. **关键下步日程安排 (Upcoming Milestones)**：
   - **课题组统计评审会**：**2026年10月15日 (周四) 14:00 - 16:00**（审议 Table 1 三线表与 Kaplan-Meier 累积无事件生存分析初稿）；
   - **论文稿件撰写与图表联动**：在写作工作区绑定 \`{{research.table1}}\` 与 \`{{research.km_curve}}\`，准备投稿手稿排版。

请查收随附附件，并点击下方**「同步到日历」**记录下周四统计评审会日程。`,
        attachments: JSON.stringify([
          {
            id: 'att-dapa-psm-table1',
            name: 'DAPA-HF_PSM_Balance_Diagnostics_Table1.csv',
            size: 148480,
            mime: 'text/csv',
            data_base64: Buffer.from(`Covariate,Dapagliflozin (N=710),Standard_Care (N=710),SMD\nAge (years),66.2 (10.8),66.5 (11.1),0.027\nFemale (%),23.4%,23.8%,0.009\nLVEF (%),31.2 (6.8),31.0 (6.7),0.030\nNT-proBNP (pg/mL),1437 (850-2800),1442 (860-2780),0.012\neGFR (mL/min/1.73m2),65.8 (19.4),66.1 (19.2),0.015\nL3_SMI (cm2/m2),41.5 (7.2),41.3 (7.1),0.028\n`).toString('base64'),
          },
          {
            id: 'att-dapa-dsmb-charter',
            name: 'DSMB_Interim_Charter_v3.pdf',
            size: 2457600,
            mime: 'application/pdf',
            data_base64: Buffer.from(`%PDF-1.4\n%DSMB Interim Charter v3.0\nDAPA-HF Clinical Trial NCT03036124 Interim Analysis Plan\n`).toString('base64'),
          }
        ]),
      },
      {
        user_id: userId,
        tenant_id: null,
        sender: 'oncology.followup@heurion.org',
        sender_name: '胸部肿瘤随访监护组',
        recipient: myEmail,
        subject: '【随访提醒】PT-NSCLC-002 奥希替尼靶向治疗第 8 周 RECIST 1.1 疗效评估与耐药监测',
        category: 'followup',
        patient_id: 'PT-NSCLC-002',
        patient_code: 'PT-NSCLC-002',
        study_id: null,
        study_title: null,
        read: 1,
        starred: 0,
        calendar_event_id: null,
        created_at: isoHoursAgo(24),
        body: `### 肺癌靶向治疗周期性随访 · PT-NSCLC-002

- **患者信息**：58岁女性，右上肺腺癌伴纵隔淋巴结转移 (cT3N2M0, IIIA 期)，携带高丰度 EGFR Exon 19 del (42.6%)；
- **当前治疗**：甲磺酸奥希替尼片 80mg 口服 qd，当前完成第 8 周；
- **随访重点**：
  1. 胸部增强 CT 随访并启动 **RECIST 1.1 自动比对引擎**，计算靶病灶长径和 (SOD) 变化率；
  2. 外周血 ctDNA 游离肿瘤 DNA 液体活检（重点监测 C797S / MET 扩增等继发耐药突变）；
  3. 间质性肺炎 (ILD) 罕见毒副反应筛查。
- **推荐门诊随访时间**：**2026年10月13日 (周二) 下午 14:00 - 15:00**。`,
        attachments: JSON.stringify([
          {
            id: 'att-nsclc-recist',
            name: 'RECIST_1.1_Tumor_Response_Chart.pdf',
            size: 1228800,
            mime: 'application/pdf',
            data_base64: Buffer.from(`%PDF-1.4\n%RECIST 1.1 Tumor Response Longitudinal Evaluation\nPT-NSCLC-002 Osimertinib 80mg Week 8 Target Lesion Sum: -32.4% (Partial Response PR)\n`).toString('base64'),
          }
        ]),
      },
      {
        user_id: userId,
        tenant_id: null,
        sender: 'irb.research@heurion.org',
        sender_name: '临床医学伦理与科研办公室',
        recipient: myEmail,
        subject: '【科研日程】国际多中心临床试验 DSMB 独立数据监查委员会中期审查会日程',
        category: 'research',
        patient_id: null,
        patient_code: null,
        study_id: 'DAPA-HF-RCT-2019',
        study_title: 'DAPA-HF 达格列净心衰里程碑前瞻性队列研究 (NCT03036124)',
        read: 1,
        starred: 0,
        calendar_event_id: null,
        created_at: isoHoursAgo(36),
        body: `### 独立数据监查委员会 (DSMB) 中期审查会议通知

各参研中心主要研究者 (PI) 及统计师：

经伦理委员会审批准许（批件号：IRB-2017-MED-0428），DAPA-HF 试验 DSMB 委员会定于近期召开中期安全性与统计终点闭门审查研讨会：

- **会议日期**：**2026年10月16日 (周五) 19:00 - 21:00**
- **参会形式**：国际多中心加密远程视频研讨
- **审议事项**：
  - 核心复合终点 Primary MACE（心血管死亡或心衰恶化再住院）盲态事件裁定进度；
  - 预设亚组（伴 2 型糖尿病 vs 非糖尿病患者）心肾终点保护效应的同质性检验 ($P_{\\text{interaction}} = 0.80$)；
  - 临床严重不良事件 (SAE) 独立监查审查。`,
      },
      {
        user_id: userId,
        tenant_id: null,
        sender: 'nutrition.prehab@heurion.org',
        sender_name: '临床营养与药学监护组',
        recipient: myEmail,
        subject: '【营养随访】PT-SARCO-003 低 SMI 患者全肠内营养支持 (ONS) 与首剂化疗耐受随访',
        category: 'followup',
        patient_id: 'PT-SARCO-003',
        patient_code: 'PT-SARCO-003',
        study_id: null,
        study_title: null,
        read: 1,
        starred: 0,
        calendar_event_id: null,
        created_at: isoHoursAgo(48),

        body: `### 低 SMI 患者多学科随访 · PT-SARCO-003

- **患者信息**：64岁男性，胰腺癌局部进展期，L3 骨骼肌质量指数 **SMI = 29.92 cm²/m²**，肌肉辐射衰减 **MA = 26.4 HU**，实测握力 19 kg；
- **干预措施**：化疗首剂下调 20%，联合高蛋白全肠内营养支持 (ONS) 8 周；
- **随访目标**：评估化疗耐受性，复查右上肢握力、白蛋白、前白蛋白，测定是否发生 3~4 级血液学毒副反应；
- **建议门诊时间**：**2026年10月14日 (周三) 上午 10:00 - 11:00**。`,
      },
    ]

    for (const item of seedMails) {
      this.store.createMailMessage(item)
    }
    this.store.setUserSetting(userId, 'mail_seeded', '1')
  }

  /** AI 智能建议回复 (Clinical Smart Reply) */
  async suggestSmartReplies(userId: string, messageId: string): Promise<string[]> {
    const msg = this.store.getMailMessage(userId, messageId)
    if (!msg) return []

    // 1. 若配置了大模型 (DeepSeek)，尝试调用 AI 生成 3 条精简专业的临床回复建议
    if (this.complete) {
      try {
        const system = `你是一位高年资临床主任与多中心医学试验学术顾问。请针对主诊医师收到的这封临床/科研邮件，生成 3 条精简、专业、果断且符合诊疗/试验伦理规范的快捷回复建议（Smart Replies）。
要求：
1. 每条建议 1~2 句话（约 15~40 字），语气得体、专业直接；
2. 针对邮件的具体指标或议题（如随访复查安排、影像/肺功能对比、PSM平衡性确认、DSMB审查出席、病历确认）；
3. 严格禁止任何 Emoji 表情符号；
4. 必须且仅输出严格的 JSON 字符串数组格式，例如：
["已阅随访方案，已锁定下周一门诊与薄层 HRCT 复查日程。", "随访指标已复核，建议在门诊前先行完成肺功能与血常规化验。", "收到患者复查通知，请呼吸科随访护士跟进患者用药依从性。"]
严禁输出任何 markdown 代码块（如 \`\`\`json）、前缀或解释。`

        const userPrompt = `【来信信息】
- 发件人：${msg.sender_name ? `${msg.sender_name} <${msg.sender}>` : msg.sender}
- 主题：${msg.subject}
- 类别：${msg.category}
- 关联患者：${msg.patient_code || '无'}
- 关联课题：${msg.study_id || '无'}
- 正文摘录：
${msg.body.slice(0, 1000)}`

        const res = await this.complete(system, userPrompt)
        if (res) {
          const cleaned = stripEmojis(res.trim()).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
          const parsed = JSON.parse(cleaned)
          if (Array.isArray(parsed) && parsed.length >= 2) {
            const replies = parsed
              .map(s => stripEmojis(String(s).trim()))
              .filter(s => s.length >= 6 && s.length <= 80)
            if (replies.length >= 2) {
              return replies.slice(0, 3)
            }
          }
        }
      } catch (err) {
        console.warn('[smart-reply] LLM call failed, fallback to clinical rules', (err as Error).message)
      }
    }

    // 2. 备选：智能临床规则引擎（毫秒级响应）
    return this.fallbackSmartReplies(msg)
  }

  private fallbackSmartReplies(msg: MailMessageRow): string[] {
    const text = `${msg.subject} ${msg.body}`.toLowerCase()

    if (msg.category === 'followup' || msg.patient_code || text.includes('随访') || text.includes('ham') || text.includes('recist')) {
      if (text.includes('ham') || text.includes('粘液栓') || text.includes('支气管')) {
        return [
          '已阅随访方案。已为您锁定下周一门诊与吸气相薄层 HRCT 影像对比。',
          '随访指标已复核。已同步安排肺功能 (PFT) 与总 IgE 复查，重点评估小气道通气。',
          '收到患者随访通知。建议门诊前先行复核伏立康唑谷浓度与肝功能指标。',
        ]
      }
      if (text.includes('recist') || text.includes('奥希替尼') || text.includes('靶向') || text.includes('肿瘤')) {
        return [
          '已收悉随访提醒。已为您锁定下周二门诊与胸部增强 CT RECIST 1.1 自动对比。',
          '收到患者耐药监测报告。建议本次门诊同步抽取外网 ctDNA 进行继发耐药突变筛查。',
          '已确认靶向随访日程。请主管护士先行完成 ECOG 评分与 ILD 毒副反应初筛。',
        ]
      }
      if (text.includes('肌少症') || text.includes('营养') || text.includes('ons') || text.includes('smi')) {
        return [
          '已阅恶液质随访记录。同意化疗首剂下调 20% 并继续高蛋白全肠内营养支持。',
          '收到患者营养随访提醒。门诊时将复测 L3 SMI 骨骼肌质量指数与握力恢复情况。',
          '方案已确认。请营养科会诊医师协助监测患者口服耐受性及前白蛋白指标。',
        ]
      }
      return [
        '已确认患者随访计划，已锁定门诊与必要辅助检查日程。',
        '指标已复核。请患者按既定方案准时来院复查，有异常指标即刻汇报。',
        '随访通知已收悉，已将复查重点标注至该患者全景档案中。',
      ]
    }

    if (msg.category === 'research' || msg.study_id || text.includes('psm') || text.includes('dsmb') || text.includes('课题') || text.includes('队列')) {
      if (text.includes('psm') || text.includes('倾向评分') || text.includes('dapa-hf')) {
        return [
          '质控简报已收悉。18 项协变量 PSM 匹配收敛达标 (SMD < 0.05)，同意启动统计评审会。',
          '已审阅队列入组数据。请统计工作组将 Table 1 三线表及 KM 生存分析初稿发至文稿区。',
          '收到课题进展周报。建议按计划于周四召开多中心统计评审研讨会。',
        ]
      }
      if (text.includes('dsmb') || text.includes('审查') || text.includes('伦理')) {
        return [
          '已确认 DSMB 闭门审查会日程。我方中心将准时连线并提交盲态复合终点事件清单。',
          '伦理与监查通知已收悉。相关严重不良事件 (SAE) 独立监查报告已归档备查。',
          '收到会议通知。我方参研团队已准备好亚组同质性检验与数据核对材料。',
        ]
      }
      return [
        '课题进展报告已收悉，数据质控与里程碑进度符合方案设计。',
        '已审阅科研简报。相关统计分析结果已同步至研究工作台，请按计划推进。',
        '收到通知，我方参研团队将准时参加课题组协同讨论会。',
      ]
    }

    return [
      '邮件已收悉。已记录相关要点，稍后向您详细答复。',
      '已审阅来信内容，方案无异议，可按计划执行。',
      '收到，已转交临床研究工作组协同复核，有新进展即刻与您同步。',
    ]
  }
}
