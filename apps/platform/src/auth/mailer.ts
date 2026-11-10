import nodemailer from 'nodemailer'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
}

export interface MailDeliveryResult {
  success: boolean
  mode: 'smtp' | 'resend' | 'simulated' | 'dev-mock'
  messageId?: string
  info?: string
}

export interface SendMailOptions {
  replyTo?: string
  senderName?: string
  senderAddress?: string
}

/**
 * 发信（验证码、随访提醒专邮、科研进度通报）。
 * 支持：
 * 1. 标准 SMTP（如 Gmail、QQ、163、企业邮箱、本地 Mailpit）
 * 2. Resend API (RESEND_API_KEY)
 * 3. 本地开发模拟（记录日志并在系统发件箱标注）
 */
export interface Mailer {
  /** 配了真实发信服务。 */
  readonly configured: boolean
  /** 能发（配了服务，或开发环境打日志）。 */
  readonly available: boolean
  readonly mode: 'smtp' | 'resend' | 'dev-mock'
  send(to: string, subject: string, text: string, html?: string, opts?: SendMailOptions): Promise<MailDeliveryResult>
}

export class MailerError extends Error {}

function makeFrom(baseFrom: string, senderName?: string, senderAddress?: string): string {
  const ltIdx = baseFrom.indexOf('<')
  const gtIdx = ltIdx >= 0 ? baseFrom.indexOf('>', ltIdx + 1) : -1
  const defaultAddr = (ltIdx >= 0 && gtIdx > ltIdx ? baseFrom.slice(ltIdx + 1, gtIdx).trim() : baseFrom.trim()) || 'no-reply@heurion.org'
  let addr = senderAddress || defaultAddr
  if (addr.endsWith('@heurion.com')) {
    addr = addr.replace(/@heurion\.com$/, '@heurion.org')
  }
  const defaultName = ltIdx >= 0 ? (baseFrom.slice(0, ltIdx).trim().replace(/^"|"$/g, '') || 'Heurion') : 'Heurion'
  const name = senderName || defaultName
  return `"${name}" <${addr}>`
}

export function createMailer(opts: {
  resendApiKey?: string
  smtp?: SmtpConfig
  from?: string
  production: boolean
  log?: (line: string) => void
}): Mailer {
  const from = opts.from || 'Heurion 临床工作站 <no-reply@heurion.org>'

  // 1. 优先使用标准 SMTP
  if (opts.smtp?.host) {
    const auth = (opts.smtp.user && opts.smtp.pass)
      ? { user: opts.smtp.user, pass: opts.smtp.pass }
      : undefined
    const transport = nodemailer.createTransport({
      host: opts.smtp.host,
      port: opts.smtp.port,
      secure: opts.smtp.secure,
      auth,
    })

    return {
      configured: true,
      available: true,
      mode: 'smtp',
      async send(to, subject, text, html, sendOpts) {
        try {
          const info = await transport.sendMail({
            from: makeFrom(from, sendOpts?.senderName, sendOpts?.senderAddress),
            to,
            subject,
            text,
            html: html || text.replace(/\n/g, '<br>'),
            replyTo: sendOpts?.replyTo,
          })
          return { success: true, mode: 'smtp', messageId: info.messageId, info: '通过 SMTP 发送成功' }
        } catch (err) {
          throw new MailerError(`SMTP 邮件发送失败: ${(err as Error).message}`)
        }
      },
    }
  }

  // 2. 使用 Resend API (若配置)
  if (opts.resendApiKey) {
    return {
      configured: true,
      available: true,
      mode: 'resend',
      async send(to, subject, text, html, sendOpts) {
        const fromAddr = makeFrom(from, sendOpts?.senderName, sendOpts?.senderAddress)
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.resendApiKey}` },
          body: JSON.stringify({
            from: fromAddr,
            to: [to],
            subject,
            text,
            html,
            reply_to: sendOpts?.replyTo,
          }),
        })
        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          console.error(`[resend-error] HTTP ${res.status}:`, errText)
          let errMsg = `Resend 邮件发送失败（HTTP ${res.status}）`
          try {
            const parsed = JSON.parse(errText)
            if (parsed.message) errMsg += `: ${parsed.message}`
          } catch {
            if (errText) errMsg += `: ${errText}`
          }
          throw new MailerError(errMsg)
        }
        const data = await res.json().catch(() => ({})) as { id?: string }
        return { success: true, mode: 'resend', messageId: data.id, info: '通过 Resend 发送成功' }
      },
    }
  }

  // 3. 本地开发模拟 / 生产环境未配置
  const log = opts.log ?? (line => console.log(line))
  return {
    configured: false,
    available: !opts.production,
    mode: 'dev-mock',
    async send(to, subject, text, _html, sendOpts) {
      if (opts.production) throw new MailerError('邮件服务未配置 (未设置 SMTP_HOST 或 RESEND_API_KEY)')
      log(`[邮件·开发模式未真正发送] 发件人: ${makeFrom(from, sendOpts?.senderName, sendOpts?.senderAddress)} | 回复: ${sendOpts?.replyTo || '无'} | 收件人: ${to} | 主题: ${subject}`)
      return {
        success: true,
        mode: 'simulated',
        info: '本地开发模拟：未配置外网发信服务 (SMTP/RESEND_API_KEY)，未向外网真实发送。',
      }
    },
  }
}

