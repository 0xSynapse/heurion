/**
 * 医疗与科研邮件工作空间 (Heurion Clinical & Research Mailbox)
 * 
 * 专为临床医生与医学科研工作者设计：
 * 1. 邮箱域名：@heurion.org (如 <username>@heurion.org)
 * 2. 随访提醒邮件：患者影像 3D 容积复查、耐药基因突变监测、恶病质恶化警示
 * 3. 科研进度邮件：多中心 RCT 倾向评分匹配 (PSM) 质控报告、DSMB 盲态审核
 * 4. 完备的收件箱管理体系：
 *    - 分页导航 (Paging & Page Size)
 *    - 批量操作 (Batch Read / Unread / Star / Trash / Restore / Delete)
 *    - 星标收藏 (Starred) 与废纸篓 (Trash)
 *    - 列表管理视图 (Mail Table) 与统计看板 (Dashboard) 自由切换
 * 5. 深度交互联动：
 *    - 邮件一键「添加到日历」
 *    - 随访邮件一键直达「患者档案」
 *    - 科研邮件一键进入「科研课题」
 */

import { icon } from './icons.ts'
import { askConfirm } from './dialogs.ts'

export type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
export type Notice = (msg: string, error?: boolean) => void

export interface MailHooks {
  leaveDoc(): void
  openPatient?(idOrCode: string): Promise<void>
  openStudy?(idOrTitle: string): Promise<void>
  openCalendar?(eventId?: string): Promise<void>
}

export interface MailAttachment {
  id: string
  name: string
  size: number
  mime: string
  data_base64?: string
  url?: string
}

export interface MailMessage {
  id: string
  owner?: string
  user_id?: string
  sender: string
  sender_name?: string
  recipient: string
  subject: string
  body: string
  category: 'followup' | 'research' | 'notification' | 'general'
  patient_id?: string | null
  patient_code?: string | null
  study_id?: string | null
  study_title?: string | null
  read: number | boolean
  starred?: number | boolean
  created_at: string
  folder?: 'inbox' | 'sent' | 'trash'
  delivery_status?: 'delivered' | 'external_sent' | 'simulated' | 'failed'
  delivery_note?: string | null
  calendar_event_id?: string | null
  thread_id?: string | null
  in_reply_to?: string | null
  attachments?: MailAttachment[] | string | null
  thread?: MailMessage[]
}

export interface ComposeInitial {
  recipient?: string
  subject?: string
  body?: string
  category?: 'followup' | 'research' | 'notification' | 'general'
  patient_code?: string
  study_id?: string
  thread_id?: string
  in_reply_to?: string
  attachments?: MailAttachment[]
}

export function formatAttachmentSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function parseAttachments(raw: unknown): MailAttachment[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw as MailAttachment[]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as MailAttachment[]
    } catch {}
  }
  return []
}

export interface MailStatus {
  configured: boolean
  mode: 'smtp' | 'resend' | 'dev-mock'
  user_email: string
}

export interface MailSummaryItem {
  id: string
  subject: string
  sender: string
  recipient: string
  created_at: string
  category: string
  patient_code?: string
  study_id?: string
}

export interface MailSummaryResult {
  hours: number
  total: number
  count?: number
  unread: number
  followup_count: number
  research_count: number
  source_mails: MailSummaryItem[]
  items?: MailSummaryItem[]
  summary: string
  generated_at: string
}

function renderDeliveryPill(status?: string): string {
  switch (status) {
    case 'external_sent':
      return `<span class="mail-delivery-pill ok" title="已成功通过外网 SMTP 发出">${icon('check', { size: 10, class: 'mail-pill-icon' })} 外网已发</span>`
    case 'delivered':
      return `<span class="mail-delivery-pill ok" title="已送达院内专邮收件箱">${icon('check', { size: 10, class: 'mail-pill-icon' })} 站内送达</span>`
    case 'simulated':
      return `<span class="mail-delivery-pill sim" title="本地开发模拟，未配置外网发信服务">${icon('info', { size: 10, class: 'mail-pill-icon' })} 本地模拟</span>`
    case 'failed':
      return `<span class="mail-delivery-pill fail" title="发信失败">${icon('close', { size: 10, class: 'mail-pill-icon' })} 发送失败</span>`
    default:
      return ''
  }
}

const CATEGORY_NAMES: Record<string, string> = {
  followup: '随访提醒',
  research: '科研进展',
  notification: '系统通知',
  general: '综合沟通',
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export function renderMessageAttachments(msg: MailMessage): string {
  const atts = parseAttachments(msg.attachments)
  if (!atts || atts.length === 0) return ''
  return `
    <div class="mail-attachments-wrap">
      <div class="mail-attachments-header">
        ${icon('paperclip', { size: 13 })} 包含 ${atts.length} 个医学附件 / 质控数据文件
      </div>
      <div class="mail-attachment-grid">
        ${atts.map(att => {
          const ext = att.name.includes('.') ? att.name.split('.').pop() || 'FILE' : 'FILE'
          return `
            <div class="mail-attachment-card" data-att-id="${esc(att.id)}">
              <div class="attachment-icon-col">
                ${icon('file', { size: 20 })}
              </div>
              <div class="attachment-info-col">
                <div class="attachment-name" title="${esc(att.name)}">${esc(att.name)}</div>
                <div class="attachment-meta">
                  <span class="attachment-ext-tag">${esc(ext.toUpperCase())}</span>
                  <span>${formatAttachmentSize(att.size)}</span>
                </div>
              </div>
              <div class="attachment-actions-col">
                <a href="/api/mail/messages/${esc(msg.id)}/attachments/${esc(att.id)}/download" target="_blank" download="${esc(att.name)}" class="mail-btn ghost sm" title="下载附件">
                  ${icon('download', { size: 12 })} 下载
                </a>
                <button type="button" class="mail-btn ghost sm btn-import-kb" data-msg-id="${esc(msg.id)}" data-att-id="${esc(att.id)}" data-att-name="${esc(att.name)}" title="一键导入到个人资料库进行向量化检索">
                  ${icon('sparkles', { size: 12 })} 导入知识库
                </button>
              </div>
            </div>
          `
        }).join('')}
      </div>
    </div>
  `
}

export function renderAttachmentChips(atts: MailAttachment[], prefix: 'inline' | 'compose'): string {
  if (!atts || atts.length === 0) return ''
  return atts.map((a, idx) => `
    <span class="attached-chip">
      ${icon('file', { size: 12 })}
      <span>${esc(a.name)} (${formatAttachmentSize(a.size)})</span>
      <button type="button" class="attached-chip-remove" data-remove-${prefix}="${idx}" title="移除附件">
        ${icon('close', { size: 11 })}
      </button>
    </span>
  `).join('')
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const res = reader.result as string
      const commaIdx = res.indexOf(',')
      resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/** 浏览器端 RFC 2047 MIME 头部解码 (如 =?UTF-8?B?...?= 或 =?UTF-8?Q?...?=) */
export function decodeMimeWords(str: string): string {
  if (!str || !str.includes('=?')) return str
  const cleaned = str.replace(/(\?=\s+=\?)/g, '?==?')
  return cleaned.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
    try {
      const enc = encoding.toUpperCase()
      const cs = (charset || 'utf-8').toLowerCase()
      if (enc === 'B') {
        const bin = atob(text)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return new TextDecoder(cs.includes('gb') ? 'gb18030' : 'utf-8').decode(bytes)
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
        return new TextDecoder(cs.includes('gb') ? 'gb18030' : 'utf-8').decode(new Uint8Array(bytes))
      }
    } catch {
      return text
    }
    return text
  })
}

/** 修复历史误将纯英文标题当做 Base64 或将 URL 参数当做 Quoted-Printable 解码造成的乱码 */
export function repairMojibakeEmailBody(text: string): string {
  if (!text) return ''
  let out = text
  out = out.replace(/(?:澶佸Ы骞惰唇娅掝櫙璀硓[锟\uFFFD]*|夁姽并贽櫒譳z[\uFFFD]*)/g, 'Confirm your email address')
  if (/https?:\/\/[^\s<>"']*[\u4e00-\u9fff]/.test(out)) {
    try {
      const td = new TextDecoder('gb18030')
      out = out.replace(/(https?:\/\/[^\s<>"']*?[?#&][A-Za-z0-9_.-]+)([\u4e00-\u9fff])([A-Za-z0-9_.-]+)/g, (full, prefix, cjk, suffix) => {
        for (let b1 = 0x81; b1 <= 0xfe; b1++) {
          for (let b2 = 0x30; b2 <= 0x7e; b2++) {
            if (b2 === 0x7f) continue
            if (td.decode(new Uint8Array([b1, b2])) === cjk) {
              const hex = b1.toString(16).toLowerCase().padStart(2, '0')
              const ascii = String.fromCharCode(b2)
              return `${prefix}=${hex}${ascii}${suffix}`
            }
          }
        }
        return full
      })
    } catch {}
  }
  return out
}

export function looksLikeQuotedPrintable(str: string): boolean {
  if (!str) return false
  if (/=\r?\n/.test(str)) return true
  if (/(?:=[0-9A-Fa-f]{2}){2,}/.test(str)) return true
  if (/=3D/i.test(str) || /=(?:20|09)(?:\r?\n|$)/.test(str) || /=0D=0A/i.test(str)) return true
  return false
}

/** 浏览器端 Quoted-Printable 正文解码 (支持 UTF-8 与 GB18030 / GBK，保护 URL 参数与已有 UTF-8 字符) */
export function decodeQuotedPrintable(str: string, charset?: string): string {
  if (!str) return ''
  const hasSoftBreak = /=\r?\n/.test(str)
  const s = hasSoftBreak ? str.replace(/=\r?\n/g, '') : str
  if (!/=[0-9A-Fa-f]{2}/.test(s)) return s
  if (!hasSoftBreak && !looksLikeQuotedPrintable(s)) return s

  const cs = (charset || '').toLowerCase()
  return s.replace(/(?:=[0-9A-Fa-f]{2})+/g, (match, offset, fullStr) => {
    const before = fullStr.slice(Math.max(0, offset - 200), offset)
    if (/https?:\/\/[^\s<>"']*?[?#&][A-Za-z0-9_.-]+$/i.test(before) && !/^=3D/i.test(match)) {
      return match
    }
    const bytes: number[] = []
    for (let i = 0; i < match.length; i += 3) {
      bytes.push(parseInt(match.slice(i + 1, i + 3), 16))
    }
    const u8 = new Uint8Array(bytes)
    let decoded = ''
    if (cs.includes('gb')) {
      try {
        decoded = new TextDecoder('gb18030', { fatal: true }).decode(u8)
      } catch {}
    }
    if (!decoded) {
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(u8)
      } catch {
        if (u8.length >= 2) {
          try {
            decoded = new TextDecoder('gb18030', { fatal: true }).decode(u8)
          } catch {}
        }
      }
    }
    if (!decoded || decoded.includes('\uFFFD') || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded)) {
      return match
    }
    return decoded
  })
}

/** 智能探测并解码 Base64 编码的邮件正文块（支持换行折行、行首缩进容错、UTF-8 及 GB18030） */
export function decodeBase64Chunk(raw: string, charset?: string): string {
  if (!raw) return raw
  const trimmed = raw.trim()
  const lines = trimmed.split(/\r?\n/)
  for (const line of lines) {
    const l = line.trim()
    if (l && /\s/.test(l)) {
      return raw
    }
  }

  const compact = trimmed.replace(/\s+/g, '')
  if (
    compact.length < 12 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) ||
    /^[A-Za-z]+$/.test(compact)
  ) {
    return raw
  }

  try {
    const bin = atob(compact)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

    let decoded = ''
    const cs = (charset || '').toLowerCase()
    if (cs.includes('gb')) {
      try {
        decoded = new TextDecoder('gb18030', { fatal: true }).decode(bytes)
      } catch {}
    }
    if (!decoded) {
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {}
    }
    if (!decoded || decoded.includes('\uFFFD')) return raw
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded)) {
      return raw
    }

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

/** 智能判定正文是否为标准 HTML 富文本格式邮件 (如包含 DOCTYPE、html 骨架或 table/div 邮件模板标签) */
export function isHtmlEmail(raw?: string): boolean {
  if (!raw) return false
  const s = raw.trim()
  if (/^<!DOCTYPE\s+html/i.test(s) || /^<html[\s>]/i.test(s)) return true
  if (/<table[\s>]/i.test(s) && /<\/table>/i.test(s)) return true
  if (/<(div|p|span|section)[^>]*style=/i.test(s) && /<\/(div|p|span|section)>/i.test(s)) return true
  return false
}

/** 智能探测并解码邮件正文（兼容全文本 Base64、分块 Base64、Quoted-Printable、MIME Multipart 及多字符集） */
export function decodeEmailBody(body: string, charset?: string): string {
  if (!body) return ''
  // 1. 若正文中包含 MIME boundary 结构，优先提取正文分块
  let text = parseMimeText(body).trim()

  // 若已经是 HTML 格式邮件，仅解码 Quoted-Printable，避免分段 Base64 误判破坏 HTML 结构
  if (isHtmlEmail(text)) {
    if (looksLikeQuotedPrintable(text)) {
      text = decodeQuotedPrintable(text, charset)
    }
    text = repairMojibakeEmailBody(text)
    text = text.replace(/--[a-zA-Z0-9_\-=]+--?\s*$/g, '').trim()
    return text
  }

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

  // 4. Quoted-Printable 探测与解码 (支持 UTF-8 与 GB18030，排除普通 URL 参数)
  if (looksLikeQuotedPrintable(text)) {
    text = decodeQuotedPrintable(text, charset)
  }

  // 5. 修复历史误解码造成的乱码
  text = repairMojibakeEmailBody(text)

  // 6. 清理残留的 MIME boundary 标记
  text = text.replace(/--[a-zA-Z0-9_\-=]+--?\s*$/g, '').trim()
  return text
}

/** 移除字符串中的所有 Emoji 彩色表情符号，保证临床科研工作站专业严谨的视觉体系 */
export function stripEmojis(str: string): string {
  if (!str) return ''
  return str
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B50}-\u{2B55}\u{FE00}-\u{FE0F}]/gu, '')
    .trim()
}

function formatSenderDisplay(senderName?: string, sender?: string): string {
  const cleanSender = (sender || '').trim()
  const rawName = (senderName || '').trim()
  const decodedName = decodeMimeWords(rawName)
  const isBounce = /^[0-9a-f]{12,}(?:-[0-9a-f]{4,})+$/i.test(decodedName)
  if (!decodedName || decodedName.toLowerCase() === cleanSender.toLowerCase() || isBounce) {
    if (isBounce && cleanSender.includes('@')) {
      const domain = cleanSender.split('@')[1]!.replace(/^(?:send|notify|mail|bounce|bounces|email|mg|em)\./gi, '').replace(/^(?:send|notify|mail)\./gi, '')
      return domain || cleanSender
    }
    return cleanSender
  }
  return `${decodedName} <${cleanSender}>`
}

export function extractPureEmail(str?: string): string {
  if (!str) return ''
  const m = str.match(/<([^>]+)>/)
  if (m && m[1]) return m[1].trim()
  return str.trim()
}

export function normalizeSubject(sub?: string): string {
  const decoded = decodeMimeWords(sub || '')
  return decoded.replace(/^(?:(?:\s*(?:re|fwd|fw|回复|转发)[：:]\s*)+)/i, '').trim()
}

export function getAvatarInitial(nameOrEmail?: string): string {
  if (!nameOrEmail) return 'M'
  const clean = nameOrEmail.replace(/<[^>]+>/g, '').trim()
  const first = clean[0] || 'M'
  return first.toUpperCase()
}

export function formatTimeShort(dateStr?: string): string {
  if (!dateStr) return ''
  const clean = dateStr.replace('T', ' ').replace(/\.\d+Z$/, '')
  return clean.length >= 16 ? clean.slice(5, 16) : clean
}

export function snippetText(str?: string, max = 80): string {
  if (!str) return ''
  const decoded = decodeEmailBody(str)
  let clean = decoded
  if (isHtmlEmail(decoded)) {
    clean = decoded
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<xml[^>]*>[\s\S]*?<\/xml>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
  }
  clean = clean.replace(/[\r\n\t\s]+/g, ' ').replace(/>+[^\n]*/g, '').trim()
  return clean.length > max ? clean.slice(0, max) + '...' : clean
}

export function generateThreadQuote(msg: MailMessage): string {
  const dateStr = msg.created_at || '近期'
  const senderStr = formatSenderDisplay(msg.sender_name, msg.sender)
  let rawBody = msg.body || ''
  if (isHtmlEmail(rawBody)) {
    rawBody = rawBody
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<xml[^>]*>[\s\S]*?<\/xml>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  const bodyText = (rawBody || '').split('\n').map(l => `> ${l}`).join('\n')
  return `\n\n------------------ 原始邮件 ------------------\n发件人: ${senderStr}\n发送时间: ${dateStr}\n收件人: ${msg.recipient}\n主题: ${decodeMimeWords(msg.subject)}\n\n${bodyText}`
}

/**
 * 格式化邮件正文为具有临床科研专业排版的 HTML，自动兼容外部标准 HTML 富文本邮件
 */
function formatEmailBody(raw: string): string {
  if (!raw) return ''
  const decoded = decodeEmailBody(raw)

  // 1. 若为标准 HTML 邮件（如 NVIDIA 等外部系统通知），采用无脚本隔离沙箱 iframe 渲染真实排版与样式
  if (isHtmlEmail(decoded)) {
    let html = decoded
      .trim()
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    if (!/<base\s/i.test(html)) {
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, '$&<base target="_blank" rel="noopener noreferrer">')
      } else {
        html = `<base target="_blank" rel="noopener noreferrer">${html}`
      }
    }
    const resetStyle = `
      <meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none';">
      <style>
        html, body {
          margin: 0;
          padding: 0;
          background-color: transparent;
        }
        img { max-width: 100% !important; height: auto; }
      </style>
    `
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, `$&${resetStyle}`)
    } else if (!/^<!DOCTYPE/i.test(html) && !/^<html/i.test(html)) {
      html = `<!DOCTYPE html><html><head><meta charset="utf-8">${resetStyle}</head><body>${html}</body></html>`
    }

    return `
      <div class="mail-html-embed-wrap" style="width: 100%; border-radius: 6px; overflow: hidden; background: #ffffff;">
        <iframe
          class="mail-html-frame"
          title="邮件内容预览"
          sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
          srcdoc="${esc(html)}"
          style="width: 100%; border: none; min-height: 480px; display: block;"
          onload="try {
            const doc = this.contentWindow.document;
            const h = Math.max(doc.body ? doc.body.scrollHeight : 0, doc.documentElement ? doc.documentElement.scrollHeight : 0);
            if (h > 0) this.style.height = (h + 30) + 'px';
          } catch(e) {}"
        ></iframe>
      </div>
    `
  }

  // 2. 原有的临床科研 Markdown / 纯文本结构化排版
  const lines = decoded.split('\n')
  const out: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      out.push('<div class="mail-p-gap"></div>')
      continue
    }

    if (trimmed.startsWith('【') && trimmed.endsWith('】')) {
      out.push(`<h4 class="mail-section-title">${esc(trimmed)}</h4>`)
    } else if (trimmed.startsWith('# ')) {
      out.push(`<h3 class="mail-h1">${esc(trimmed.slice(2))}</h3>`)
    } else if (trimmed.startsWith('## ')) {
      out.push(`<h4 class="mail-h2">${esc(trimmed.slice(3))}</h4>`)
    } else if (trimmed.startsWith('### ')) {
      out.push(`<h4 class="mail-h3">${esc(trimmed.slice(4))}</h4>`)
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const content = trimmed.slice(2)
      out.push(`<div class="mail-bullet"><span class="mail-bullet-dot">▪</span><span>${formatHighlights(content)}</span></div>`)
    } else {
      out.push(`<p class="mail-p">${formatHighlights(trimmed)}</p>`)
    }
  }

  return out.join('')
}

function formatHighlights(text: string): string {
  let res = esc(text)
  res = res.replace(
    /(https?:\/\/[^\s<>"']+)|(PT-[A-Z0-9-]+)|(BAR\s*=\s*[0-9.]+)|(HAM\s*=\s*[0-9.]+\s*cm³)|(SMD\s*&lt;\s*0\.05)|(\*\*(.*?)\*\*)/g,
    (match, url, pt, bar, ham, smd, _boldFull, boldInner) => {
      if (url) {
        const trailingMatch = (url as string).match(/([.,;:!?)]+)$/)
        const cleanUrl = trailingMatch ? (url as string).slice(0, -trailingMatch[1]!.length) : (url as string)
        const trailing = trailingMatch ? trailingMatch[1]! : ''
        return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="mail-body-link" style="color:var(--accent, #2563eb);text-decoration:underline;word-break:break-all;">${cleanUrl}</a>${trailing}`
      }
      if (pt) return `<span class="mail-hl-code">${pt}</span>`
      if (bar) return `<span class="mail-hl-metric">${bar}</span>`
      if (ham) return `<span class="mail-hl-metric">${ham}</span>`
      if (smd) return `<span class="mail-hl-metric">${smd}</span>`
      if (boldInner !== undefined) return `<strong>${boldInner}</strong>`
      return match
    },
  )
  return res
}

function renderBriefingTableBlock(tableLines: string[]): string {
  const rows = tableLines.map(line => {
    const cells = line.split('|')
    if (cells.length > 2) {
      return cells.slice(1, -1).map(c => stripEmojis(c.trim()))
    }
    return [stripEmojis(line.trim())]
  })

  if (rows.length < 2) {
    return rows.map(r => `<p class="mail-briefing-p">${formatBriefingInline(r.join(' '))}</p>`).join('')
  }

  const headers = rows[0]!
  const isSeparator = rows[1]!.every(c => /^:?-+:?$/.test(c))
  const dataRows = isSeparator ? rows.slice(2) : rows.slice(1)

  // 1. 如果表格包含结构化实体代号（如患者、课题、项目），优先在窄侧边栏渲染为精致卡片列表
  const hasEntityCol = headers.some(h => /代号|患者|课题|项目|编号|ID/i.test(h))
  if (hasEntityCol && dataRows.length > 0) {
    const cardHtml = dataRows.map(row => {
      const titleVal = row[0] || '详情'
      const otherFields = row.slice(1)
      const otherHeaders = headers.slice(1)

      const fieldsHtml = otherFields.map((val, idx) => {
        const label = otherHeaders[idx] || '内容'
        const isAction = /建议|待办|处置|行动|门诊|复查/.test(label)
        return `
          <div class="mail-briefing-record-field ${isAction ? 'action' : ''}">
            <span class="record-k">${esc(label)}：</span>
            <span class="record-v">${formatBriefingInline(val)}</span>
          </div>
        `
      }).join('')

      return `
        <div class="mail-briefing-record-card">
          <div class="mail-briefing-record-head">
            <span class="mail-briefing-record-title">${formatBriefingInline(titleVal)}</span>
          </div>
          <div class="mail-briefing-record-fields">${fieldsHtml}</div>
        </div>
      `
    }).join('')

    return `<div class="mail-briefing-record-list">${cardHtml}</div>`
  }

  // 2. 通用 Markdown 表格渲染
  return `
    <div class="mail-briefing-table-wrap">
      <table class="mail-briefing-table">
        <thead>
          <tr>
            ${headers.map(h => `<th>${esc(h)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${dataRows.map(row => `
            <tr>
              ${row.map(cell => `<td>${formatBriefingInline(cell)}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `
}

function formatBriefingMarkdown(raw: string): string {
  if (!raw) return ''
  const decoded = decodeEmailBody(raw)
  const lines = decoded.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed) {
      out.push('<div class="mail-briefing-gap"></div>')
      continue
    }

    // 探测并解析 Markdown 表格
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        tableLines.push(lines[i]!.trim())
        i++
      }
      i--
      out.push(renderBriefingTableBlock(tableLines))
      continue
    }

    if (trimmed.startsWith('### ') || trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      const headingRaw = trimmed.replace(/^#+\s*/, '')
      const cleanHeading = stripEmojis(headingRaw)

      // 忽略多余的顶层文档大标题（如「主诊医师 48h 邮件摘要」），卡片头部已有「AI 动态速报 · 近48h」
      if (/^(?:主诊医师)?(?:近)?(?:48h|48小时)?(?:邮件)?(?:摘要|动态|速报|研判|报告)$/i.test(cleanHeading.replace(/\s+/g, ''))) {
        continue
      }

      let headingIcon = icon('sparkles', { size: 13, class: 'briefing-sec-icon info' })
      let secClass = ''
      if (cleanHeading.includes('随访') || cleanHeading.includes('预警') || cleanHeading.includes('风险') || cleanHeading.includes('急需') || cleanHeading.includes('警示')) {
        headingIcon = icon('warning', { size: 13, class: 'briefing-sec-icon warn' })
        secClass = 'warn'
      } else if (cleanHeading.includes('科研') || cleanHeading.includes('试验') || cleanHeading.includes('课题') || cleanHeading.includes('方案') || cleanHeading.includes('入组')) {
        headingIcon = icon('microscope', { size: 13, class: 'briefing-sec-icon research' })
        secClass = 'research'
      } else if (cleanHeading.includes('行动') || cleanHeading.includes('待办') || cleanHeading.includes('建议') || cleanHeading.includes('处置') || cleanHeading.includes('总结')) {
        headingIcon = icon('report', { size: 13, class: 'briefing-sec-icon action' })
        secClass = 'action'
      }

      out.push(`<div class="mail-briefing-sec-title ${secClass}">
        ${headingIcon}
        <span class="mail-briefing-sec-text">${esc(cleanHeading)}</span>
      </div>`)
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const content = stripEmojis(trimmed.slice(2))
      out.push(`<div class="mail-briefing-bullet">
        <span class="mail-briefing-bullet-dot"></span>
        <div class="mail-briefing-bullet-body">${formatBriefingInline(content)}</div>
      </div>`)
    } else if (/^\d+\.\s+/.test(trimmed)) {
      const match = trimmed.match(/^(\d+)\.\s+(.*)$/)
      if (match) {
        const content = stripEmojis(match[2] || '')
        out.push(`<div class="mail-briefing-bullet">
          <span class="mail-briefing-bullet-num">${match[1]}</span>
          <div class="mail-briefing-bullet-body">${formatBriefingInline(content)}</div>
        </div>`)
      } else {
        out.push(`<p class="mail-briefing-p">${formatBriefingInline(stripEmojis(trimmed))}</p>`)
      }
    } else {
      out.push(`<p class="mail-briefing-p">${formatBriefingInline(stripEmojis(trimmed))}</p>`)
    }
  }

  return out.join('')
}

function formatBriefingInline(text: string): string {
  let s = esc(stripEmojis(text))
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong class="mail-briefing-bold">$1</strong>')
  s = s.replace(/(PT-[A-Z0-9-]+)/g, '<span class="mail-briefing-pill" data-pt-code="$1" title="点击查看患者 $1 全景档案">$1</span>')
  s = s.replace(/((?:RCT|STUDY)-[A-Z0-9-]+)/g, '<span class="mail-briefing-study-pill" data-study-id="$1" title="点击查看科研项目 $1">$1</span>')
  s = s.replace(/(HAM\s*=\s*[0-9.]+\s*cm³?)/g, '<span class="mail-briefing-metric">$1</span>')
  s = s.replace(/(BAR\s*=\s*[0-9.]+)/g, '<span class="mail-briefing-metric">$1</span>')
  s = s.replace(/(RECIST\s*1\.[01])/g, '<span class="mail-briefing-metric">$1</span>')
  s = s.replace(/(SMD\s*&lt;\s*0\.05)/g, '<span class="mail-briefing-metric">$1</span>')
  return s
}

export function initMail(api: Api, notice: Notice, hooks: MailHooks) {
  const $ = (id: string) => document.getElementById(id)!
  let messages: MailMessage[] = []
  let activeFolder: 'inbox' | 'sent' | 'trash' = 'inbox'
  let activeFilter: 'all' | 'unread' | 'starred' | 'followup' | 'research' = 'all'
  let selectedMailId: string | null = null
  let currentUserEmail = 'doctor@heurion.org'
  let mailStatus: MailStatus | null = null

  // 最近 48 小时 AI 邮件摘要状态
  let summaryResult: MailSummaryResult | null = null
  let summaryLoading = false

  // 视图与分页状态
  let mainViewMode: 'list' | 'dashboard' = 'list'
  let currentPage = 1
  let pageSize = 15
  const selectedIds = new Set<string>()
  let mainEventsBound = false

  async function loadStatus(): Promise<void> {
    try {
      mailStatus = await api<MailStatus>('/api/mail/status')
      if (mailStatus?.user_email) {
        let email = mailStatus.user_email.replace(/@heurion\.com$/, '@heurion.org')
        email = email.replace(/^dr[._-]/i, '')
        currentUserEmail = email
      }
    } catch (err) {
      console.error('[mail] failed to load status', err)
    }
  }

  document.addEventListener('heurion:user-updated', ((e: CustomEvent<any>) => {
    if (e.detail?.work_email) {
      currentUserEmail = e.detail.work_email
      if (selectedMailId) {
        const cur = messages.find(x => x.id === selectedMailId)
        if (cur) renderMailDetail(cur)
      } else {
        renderMain()
      }
    }
  }) as EventListener)

  async function loadSummary(force = false): Promise<void> {
    summaryLoading = true
    if (force) {
      summaryResult = null
    }
    renderNavSummary()
    try {
      summaryResult = await api<MailSummaryResult>(`/api/mail/summary?hours=48${force ? '&force=true' : ''}`)
    } catch (err) {
      console.error('[mail] failed to load summary', err)
    } finally {
      summaryLoading = false
      renderNavSummary()
    }
  }

  async function loadMessages(): Promise<void> {
    try {
      if (!mailStatus) {
        await loadStatus()
      }
      const params = new URLSearchParams()
      params.set('folder', activeFolder)
      const loaded = await api<MailMessage[]>(`/api/mail/messages?${params.toString()}`)
      messages = (loaded || []).map(m => ({
        ...m,
        subject: decodeMimeWords(m.subject),
        body: decodeEmailBody(m.body),
        sender_name: m.sender_name ? decodeMimeWords(m.sender_name) : m.sender_name,
      }))
      // 清理已不在列表中的选中项
      const currentIds = new Set(messages.map(m => m.id))
      for (const id of Array.from(selectedIds)) {
        if (!currentIds.has(id)) selectedIds.delete(id)
      }
      renderNavSummary()
      renderMain()
    } catch (err) {
      console.error('[mail] failed to load messages', err)
    }
  }

  function getFilteredMessages(): MailMessage[] {
    const searchInput = $('docSearch') as HTMLInputElement | null
    const kw = (searchInput?.value ?? '').trim().toLowerCase()

    return messages.filter(m => {
      if (activeFilter === 'unread' && (m.read || activeFolder !== 'inbox')) return false
      if (activeFilter === 'starred' && !m.starred) return false
      if (activeFilter === 'followup' && m.category !== 'followup') return false
      if (activeFilter === 'research' && m.category !== 'research') return false

      if (!kw) return true
      return (
        m.subject.toLowerCase().includes(kw) ||
        m.sender.toLowerCase().includes(kw) ||
        m.recipient.toLowerCase().includes(kw) ||
        m.body.toLowerCase().includes(kw) ||
        (m.patient_code && m.patient_code.toLowerCase().includes(kw)) ||
        (m.study_id && m.study_id.toLowerCase().includes(kw))
      )
    })
  }

  function renderNavSummary(): void {
    const listEl = $('mailList')
    if (!listEl) return

    if (summaryLoading && !summaryResult) {
      listEl.innerHTML = `
        <li class="mail-briefing-loading-card">
          <div class="mail-loading-eyebrow">
            <span class="mail-pulse-indicator"></span>
            <span class="mail-loading-tag">AI CLINICAL SYNTHESIS</span>
            <span class="mail-loading-badge">48H MONITOR</span>
          </div>

          <div class="mail-loading-radar-container">
            <div class="mail-loading-radar-ring outer"></div>
            <div class="mail-loading-radar-ring inner"></div>
            <div class="mail-loading-radar-scanner"></div>
            <div class="mail-loading-radar-core">
              ${icon('sparkles', { size: 16 })}
            </div>
          </div>

          <div class="mail-loading-content">
            <div class="mail-loading-title">正在研判近 48 小时邮件</div>
            <div class="mail-loading-model-chip">
              <span class="mail-model-dot"></span>
              <span>DeepSeek 临床大模型研判中</span>
            </div>
            <div class="mail-loading-progress-track">
              <div class="mail-loading-progress-bar"></div>
            </div>
            <div class="mail-loading-desc">聚合多中心随访预警 · 关联科研进展 · 生成速报</div>
          </div>
        </li>
      `
      return
    }

    const rawTotal = summaryResult ? (summaryResult.total ?? summaryResult.count ?? ((summaryResult as any).items ? (summaryResult as any).items.length : 0)) : 0
    if (!summaryResult || rawTotal === 0) {
      listEl.innerHTML = `
        <li class="mail-briefing-card empty">
          <div class="mail-briefing-head">
            <div class="mail-briefing-head-left">
              <span class="mail-ai-chip">${icon('sparkles', { size: 12 })} AI 动态速报</span>
              <span class="mail-time-pill">近 48h</span>
            </div>
            <button class="mail-refresh-btn ${summaryLoading ? 'loading' : ''}" id="mailRefreshSummaryBtn" title="刷新 AI 摘要">
              ${icon('refresh', { size: 12, class: 'mail-refresh-svg' })}
              <span>${summaryLoading ? '生成中...' : '刷新'}</span>
            </button>
          </div>
          <div class="mail-briefing-empty-body">
            <div class="mail-briefing-empty-icon">${icon('mail', { size: 28 })}</div>
            <div class="mail-briefing-empty-title">近 48 小时内无新流入邮件</div>
            <div class="mail-briefing-empty-text">新收到的临床随访复查与科研进展邮件将在此处由 AI 自动聚合研判</div>
          </div>
        </li>
      `
      return
    }

    const { hours, total, count, unread, followup_count, research_count, source_mails, items, summary, generated_at } = summaryResult as any
    const totalCount = total ?? count ?? (items ? items.length : 0)
    const unreadCount = unread ?? 0
    const followupCount = followup_count ?? 0
    const researchCount = research_count ?? 0
    const sourceMails = source_mails || items || []

    listEl.innerHTML = `
      <li class="mail-briefing-card">
        <!-- 头部标题栏与刷新 -->
        <div class="mail-briefing-head">
          <div class="mail-briefing-head-left">
            <span class="mail-ai-chip">${icon('sparkles', { size: 12 })} AI 动态速报</span>
            <span class="mail-time-pill">近 ${hours || 48}h</span>
          </div>
          <button class="mail-refresh-btn ${summaryLoading ? 'loading' : ''}" id="mailRefreshSummaryBtn" title="点击由 DeepSeek 重新聚合分析">
            ${icon('refresh', { size: 12, class: 'mail-refresh-svg' })}
            <span>${summaryLoading ? '研判中...' : '刷新'}</span>
          </button>
        </div>

        <!-- 核心计数徽章 (2x2 网格，紧凑专业) -->
        <div class="mail-briefing-stats-row">
          <div class="mail-briefing-stat-pill" title="近48小时共收到邮件">
            <span class="stat-k">收件总计</span>
            <span class="stat-v">${totalCount}</span>
          </div>
          <div class="mail-briefing-stat-pill ${unreadCount > 0 ? 'unread' : ''}" title="未读待阅邮件">
            <span class="stat-k">待阅邮件</span>
            <span class="stat-v">${unreadCount}</span>
          </div>
          <div class="mail-briefing-stat-pill ${followupCount > 0 ? 'followup' : ''}" title="重点随访预警">
            <span class="stat-k">重点随访</span>
            <span class="stat-v">${followupCount}</span>
          </div>
          <div class="mail-briefing-stat-pill ${researchCount > 0 ? 'research' : ''}" title="科研进展通报">
            <span class="stat-k">科研进展</span>
            <span class="stat-v">${researchCount}</span>
          </div>
        </div>

        <!-- AI 研判正文 -->
        <div class="mail-briefing-body">
          ${formatBriefingMarkdown(summary)}
        </div>
      </li>
    `
  }

  // 保持兼容性别名
  const renderNavList = renderNavSummary


  function renderMain(): void {
    const page = $('page')
    if (!page) return
    page.className = 'page mail-page'

    const selectedMail = messages.find(m => m.id === selectedMailId)
    if (selectedMail) {
      renderMailDetail(selectedMail)
    } else if (mainViewMode === 'dashboard') {
      renderMailDashboard()
    } else {
      renderMailListView()
    }

    bindMainEvents()
  }

  /**
   * 现代化临床收件箱表格管理视图 (带批量操作、全选、标星、分页)
   */
  function renderMailListView(): void {
    const page = $('page')
    const filtered = getFilteredMessages()
    const totalItems = filtered.length
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    if (currentPage > totalPages) currentPage = totalPages
    if (currentPage < 1) currentPage = 1

    const startIdx = (currentPage - 1) * pageSize
    const pageItems = filtered.slice(startIdx, startIdx + pageSize)

    const allPageSelected = pageItems.length > 0 && pageItems.every(m => selectedIds.has(m.id))
    const hasSelection = selectedIds.size > 0

    const unreadCount = messages.filter(m => !m.read && m.folder !== 'sent' && m.folder !== 'trash').length
    const starredCount = messages.filter(m => m.starred).length
    const isSent = activeFolder === 'sent'
    const isTrash = activeFolder === 'trash'

    const folderTitle = isSent ? '已发送邮件 (Sent)' : isTrash ? '废纸篓 (Trash)' : '收件箱 (Inbox)'

    page.innerHTML = `
      <div class="mail-list-view">
        <!-- 顶部信息与快速操作条 -->
        <div class="mail-list-topbar">
          <div class="mail-list-title-group">
            <div class="mail-title-icon">${icon('mail', { size: 24 })}</div>
            <div>
              <h1 class="mail-main-heading">${folderTitle}</h1>
              <div class="mail-subheading">
                <span>医生专属接收信箱：<strong id="copyMailAddress" class="mail-copyable" title="点击复制">${esc(currentUserEmail)}</strong></span>
                <span class="mail-sep">·</span>
                <span>共 <strong>${totalItems}</strong> 封邮件</span>
                ${unreadCount > 0 ? `<span class="mail-sep">·</span><span class="mail-unread-alert">${unreadCount} 封未读待阅</span>` : ''}
              </div>
            </div>
          </div>

          <div class="mail-top-actions">
            ${isTrash && messages.length > 0 ? `
              <button class="mail-btn ghost danger icon-text" id="mailEmptyTrashBtn" title="永久删除废纸篓中的全部邮件">
                ${icon('trash', { size: 14 })} 清空废纸篓
              </button>
            ` : ''}
            <button class="mail-btn ghost icon-text" id="mailRefreshBtn" title="从服务器重新获取最新邮件与状态">
              ${icon('refresh', { size: 14 })} 刷新收取
            </button>
            <div class="cal-btn-group">
              <button class="cal-btn ${mainViewMode === 'list' ? 'active' : ''}" id="mailViewListBtn">邮件列表</button>
              <button class="cal-btn ${mainViewMode === 'dashboard' ? 'active' : ''}" id="mailViewDashBtn">统计看板</button>
            </div>
            <button class="mail-btn primary" id="mailComposeActionBtn">${icon('write', { size: 14 })} 写邮件</button>
          </div>
        </div>

        <!-- 文件夹切换标签 -->
        <div class="mail-folder-bar">
          <div class="mail-folder-tabs">
            <button class="mail-folder-tab ${activeFolder === 'inbox' ? 'active' : ''}" data-folder="inbox">
              ${icon('mail', { size: 14 })} 收件箱 ${unreadCount > 0 ? `<span class="mail-tab-count">${unreadCount}</span>` : ''}
            </button>
            <button class="mail-folder-tab ${activeFolder === 'sent' ? 'active' : ''}" data-folder="sent">
              ${icon('send', { size: 14 })} 已发送
            </button>
            <button class="mail-folder-tab ${activeFolder === 'trash' ? 'active' : ''}" data-folder="trash">
              ${icon('trash', { size: 14 })} 废纸篓
            </button>
          </div>

          <!-- 快速分类与过滤筛选 -->
          <div class="mail-filter-pills">
            <button class="mail-filter-chip ${activeFilter === 'all' ? 'active' : ''}" data-filter="all">全部</button>
            ${!isSent && !isTrash ? `<button class="mail-filter-chip ${activeFilter === 'unread' ? 'active' : ''}" data-filter="unread">未读 (${unreadCount})</button>` : ''}
            <button class="mail-filter-chip ${activeFilter === 'starred' ? 'active' : ''}" data-filter="starred">${icon('star', { size: 12, class: 'mail-star-icon-filled' })} 星标 (${starredCount})</button>
            <button class="mail-filter-chip ${activeFilter === 'followup' ? 'active' : ''}" data-filter="followup">随访通知</button>
            <button class="mail-filter-chip ${activeFilter === 'research' ? 'active' : ''}" data-filter="research">科研进展</button>
          </div>
        </div>

        <!-- 批量操作工具条 (当有勾选时高亮吸顶显示) -->
        <div class="mail-batch-bar ${hasSelection ? 'visible' : ''}">
          <div class="mail-batch-left">
            <label class="mail-checkbox-wrap">
              <input type="checkbox" id="mailSelectAllPage" ${allPageSelected ? 'checked' : ''} />
              <span class="mail-checkbox-label">全选本页 (${pageItems.length} 封)</span>
            </label>
            <span class="mail-batch-selected-count">已选择 <strong>${selectedIds.size}</strong> 封邮件</span>
          </div>
          <div class="mail-batch-actions">
            ${activeFolder !== 'sent' ? `
              <button class="mail-btn ghost sm" id="batchMarkReadBtn">
                ${icon('check', { size: 13 })} 标为已读
              </button>
              <button class="mail-btn ghost sm" id="batchMarkUnreadBtn">${icon('mail', { size: 13 })} 标为未读</button>
            ` : ''}
            <button class="mail-btn ghost sm" id="batchStarBtn">${icon('star', { size: 13, class: 'mail-star-icon-filled' })} 标星</button>
            <button class="mail-btn ghost sm" id="batchUnstarBtn">${icon('star', { size: 13 })} 取消星标</button>
            ${isTrash ? `
              <button class="mail-btn ghost sm ok" id="batchRestoreBtn">${icon('refresh', { size: 13 })} 恢复至收件箱</button>
              <button class="mail-btn ghost sm danger" id="batchDeletePermanentBtn">${icon('trash', { size: 13 })} 彻底删除</button>
            ` : `
              <button class="mail-btn ghost sm danger" id="batchMoveTrashBtn">
                ${icon('trash', { size: 13 })} 移入废纸篓
              </button>
            `}
            <button class="mail-btn ghost sm" id="batchClearSelection">取消选择</button>
          </div>
        </div>

        <!-- 邮件列表表格区 -->
        <div class="mail-table-container">
          ${pageItems.length === 0 ? `
            <div class="mail-empty-state">
              <div class="mail-empty-icon">${icon('mail', { size: 36 })}</div>
              <h3>${isTrash ? '废纸篓为空' : isSent ? '已发送邮件箱为空' : '暂无匹配邮件'}</h3>
              <p class="muted">当前分类或搜索条件下没有找到任何邮件</p>
            </div>
          ` : `
            <div class="mail-rows-list">
              ${pageItems.map(m => {
                const isUnread = !m.read && activeFolder === 'inbox'
                const isStarred = Boolean(m.starred)
                const isChecked = selectedIds.has(m.id)
                const catClass = `cat-${m.category}`
                const party = isSent ? `至: ${m.recipient}` : formatSenderDisplay(m.sender_name, m.sender)
                const snippet = m.body.slice(0, 64).replace(/\n/g, ' ')

                return `
                  <div class="mail-row ${isUnread ? 'unread' : ''} ${isChecked ? 'checked' : ''}" data-mail-id="${m.id}">
                    <div class="mail-row-check" onclick="event.stopPropagation()">
                      <input type="checkbox" class="mail-item-checkbox" data-id="${m.id}" ${isChecked ? 'checked' : ''} />
                    </div>
                    <button class="mail-row-star ${isStarred ? 'starred' : ''}" data-star-id="${m.id}" title="${isStarred ? '取消星标' : '标记星标'}" onclick="event.stopPropagation()">
                      ${icon('star', { size: 14, class: isStarred ? 'mail-star-icon-filled' : 'mail-star-icon-outline' })}
                    </button>
                    <div class="mail-row-sender" title="${esc(party)}">${esc(party)}</div>
                    <div class="mail-row-body-info">
                      <div class="mail-row-badges">
                        <span class="mail-badge ${catClass}">${CATEGORY_NAMES[m.category] || '邮件'}</span>
                        ${renderDeliveryPill(m.delivery_status)}
                        ${m.patient_code ? `<span class="mail-nav-tag tag-pt">${esc(m.patient_code)}</span>` : ''}
                        ${m.study_id ? `<span class="mail-nav-tag tag-st">${esc(m.study_id)}</span>` : ''}
                      </div>
                      <div class="mail-row-subject">
                        ${isUnread ? '<span class="mail-unread-dot" title="未读"></span>' : ''}
                        <span class="mail-subject-title">${esc(m.subject)}</span>
                        <span class="mail-subject-snippet">— ${esc(snippet)}</span>
                      </div>
                    </div>
                    <div class="mail-row-right">
                      <span class="mail-row-time">${m.created_at.slice(5, 16)}</span>
                      <div class="mail-row-hover-actions" onclick="event.stopPropagation()">
                        ${!isSent && !isTrash ? `
                          <button class="mail-hover-btn" data-toggle-read="${m.id}" title="${isUnread ? '标为已读' : '标为未读'}">
                            ${isUnread ? icon('check', { size: 13 }) : icon('mail', { size: 13 })}
                          </button>
                        ` : ''}
                        ${!isTrash ? `
                          <button class="mail-hover-btn" data-add-cal="${m.id}" title="加入日历排期">
                            ${icon('calendar', { size: 13 })}
                          </button>
                        ` : ''}
                        ${isTrash ? `
                          <button class="mail-hover-btn ok" data-restore-mail="${m.id}" title="恢复至收件箱">
                            ${icon('refresh', { size: 13 })}
                          </button>
                        ` : ''}
                        <button class="mail-hover-btn danger" data-del-mail="${m.id}" title="${isTrash ? '彻底删除' : '移入废纸篓'}">
                          ${icon('trash', { size: 13 })}
                        </button>
                      </div>
                    </div>
                  </div>
                `
              }).join('')}
            </div>
          `}
        </div>

        <!-- 完备分页控制栏 (Paging Bar) -->
        <div class="mail-paging-bar">
          <div class="mail-paging-info">
            显示 <strong>${totalItems === 0 ? 0 : startIdx + 1}</strong> - <strong>${Math.min(startIdx + pageSize, totalItems)}</strong> 条 / 共 <strong>${totalItems}</strong> 封邮件
          </div>
          <div class="mail-paging-controls">
            <div class="mail-page-size-wrap">
              <span class="muted">每页</span>
              <select id="mailPageSizeSelect" class="mail-select-sm">
                <option value="15" ${pageSize === 15 ? 'selected' : ''}>15 条</option>
                <option value="30" ${pageSize === 30 ? 'selected' : ''}>30 条</option>
                <option value="50" ${pageSize === 50 ? 'selected' : ''}>50 条</option>
              </select>
            </div>
            <div class="mail-page-btn-group">
              <button class="mail-btn ghost sm" id="mailFirstPage" ${currentPage <= 1 ? 'disabled' : ''}>« 首页</button>
              <button class="mail-btn ghost sm" id="mailPrevPage" ${currentPage <= 1 ? 'disabled' : ''}>‹ 上一页</button>
              <span class="mail-page-indicator">第 <strong>${currentPage}</strong> / ${totalPages} 页</span>
              <button class="mail-btn ghost sm" id="mailNextPage" ${currentPage >= totalPages ? 'disabled' : ''}>下一页 ›</button>
              <button class="mail-btn ghost sm" id="mailLastPage" ${currentPage >= totalPages ? 'disabled' : ''}>末页 »</button>
            </div>
          </div>
        </div>
      </div>
      <div id="mailModalAnchor"></div>
    `
  }

  function renderMailDashboard(): void {
    const unreadCount = messages.filter(m => !m.read && m.folder !== 'sent' && m.folder !== 'trash').length
    const followupCount = messages.filter(m => m.category === 'followup').length
    const researchCount = messages.filter(m => m.category === 'research').length
    const deliveredCount = messages.filter(m => m.delivery_status === 'delivered' || m.delivery_status === 'external_sent').length
    const simulatedCount = messages.filter(m => m.delivery_status === 'simulated').length

    const isSent = activeFolder === 'sent'
    const page = $('page')
    page.innerHTML = `
      <div class="mail-dashboard">
        <div class="mail-dash-hero">
          <div class="mail-dash-hero-left">
            <div class="mail-dash-icon-wrap">${icon('mail', { size: 28 })}</div>
            <div>
              <h1 class="mail-dash-title">${isSent ? 'Heurion 邮件工作台 · 已发送 (Outbox / Sent)' : 'Heurion 医疗与科研工作站邮箱'}</h1>
              <p class="mail-dash-sub">${isSent ? '记录所有外发随访提醒、科研进展通报与外网 SMTP / 本地模拟投递状态' : '专属临床随访跟踪通知、真实世界研究 (RWE) 质控与跨中心科研协作专邮'}</p>
            </div>
          </div>
          <div class="mail-dash-hero-right">
            <div class="mail-doctor-badge">
              <span class="mail-doc-label">当前医生专属邮箱</span>
              <span class="mail-doc-address" id="copyMailAddress" title="点击复制邮箱地址">
                ${esc(currentUserEmail)}
                <span class="mail-copy-icon">${icon('copy', { size: 13 })}</span>
              </span>
            </div>
            <div class="mail-dash-nav-btns">
              <button class="mail-btn primary" id="mailEnterListBtn">进入邮件管理列表 →</button>
            </div>
          </div>
        </div>

        <div class="mail-stats-grid">
          <div class="mail-stat-card" data-filter="all">
            <div class="mail-stat-num">${messages.length}</div>
            <div class="mail-stat-label">${isSent ? '全部已发送 (Sent)' : '全部邮件 (Total)'}</div>
          </div>
          ${isSent ? `
            <div class="mail-stat-card accent-followup" data-filter="followup">
              <div class="mail-stat-num">${deliveredCount}</div>
              <div class="mail-stat-label">已成功送达 (Delivered)</div>
            </div>
            <div class="mail-stat-card accent-unread" data-filter="unread">
              <div class="mail-stat-num">${simulatedCount}</div>
              <div class="mail-stat-label">本地模拟记录 (Simulated)</div>
            </div>
            <div class="mail-stat-card accent-research" data-filter="research">
              <div class="mail-stat-num">${followupCount}</div>
              <div class="mail-stat-label">随访复查预警 (Follow-up)</div>
            </div>
          ` : `
            <div class="mail-stat-card accent-unread" data-filter="unread">
              <div class="mail-stat-num">${unreadCount}</div>
              <div class="mail-stat-label">未读待阅 (Unread)</div>
            </div>
            <div class="mail-stat-card accent-followup" data-filter="followup">
              <div class="mail-stat-num">${followupCount}</div>
              <div class="mail-stat-label">患者随访计划 (Follow-up)</div>
            </div>
            <div class="mail-stat-card accent-research" data-filter="research">
              <div class="mail-stat-num">${researchCount}</div>
              <div class="mail-stat-label">科研进度通报 (Research)</div>
            </div>
          `}
        </div>

        <div class="mail-dash-sections">
          <div class="mail-dash-panel">
            <div class="mail-panel-head">
              <h3>${icon('users', { size: 16 })} 近期重点随访提醒</h3>
              <span class="muted">自动匹配患者影像量化指标与复查窗口</span>
            </div>
            <div class="mail-card-list">
              ${messages.filter(m => m.category === 'followup').slice(0, 3).map(m => `
                <div class="mail-preview-card" data-mail-id="${m.id}">
                  <div class="mail-preview-top">
                    <span class="mail-badge cat-followup">随访通知</span>
                    ${renderDeliveryPill(m.delivery_status)}
                    ${m.patient_code ? `<span class="mail-preview-pt">${icon('users', { size: 12 })} ${esc(m.patient_code)}</span>` : ''}
                    <span class="grow"></span>
                    <span class="mail-preview-date">${m.created_at.slice(5, 16)}</span>
                  </div>
                  <div class="mail-preview-sub">${esc(m.subject)}</div>
                  <div class="mail-preview-snippet">${esc(m.body.slice(0, 90))}…</div>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="mail-dash-panel">
            <div class="mail-panel-head">
              <h3>${icon('microscope', { size: 16 })} 科研课题推进与统计审核</h3>
              <span class="muted">涵盖多中心 RCT、PSM 质控与 DSMB 会议纪要</span>
            </div>
            <div class="mail-card-list">
              ${messages.filter(m => m.category === 'research').slice(0, 3).map(m => `
                <div class="mail-preview-card" data-mail-id="${m.id}">
                  <div class="mail-preview-top">
                    <span class="mail-badge cat-research">科研进展</span>
                    ${renderDeliveryPill(m.delivery_status)}
                    ${m.study_id ? `<span class="mail-preview-st">${icon('microscope', { size: 12 })} ${esc(m.study_id)}</span>` : ''}
                    <span class="grow"></span>
                    <span class="mail-preview-date">${m.created_at.slice(5, 16)}</span>
                  </div>
                  <div class="mail-preview-sub">${esc(m.subject)}</div>
                  <div class="mail-preview-snippet">${esc(m.body.slice(0, 90))}…</div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
      <div id="mailModalAnchor"></div>
    `
  }

  function renderMailDetail(m: MailMessage): void {
    const page = $('page')
    const catClass = `cat-${m.category}`
    const isUnread = !m.read && activeFolder === 'inbox'
    const isSent = m.folder === 'sent' || activeFolder === 'sent'
    const isTrash = m.folder === 'trash' || activeFolder === 'trash'
    const isStarred = Boolean(m.starred)

    // 计算上一封/下一封
    const filtered = getFilteredMessages()
    const currentIdx = filtered.findIndex(x => x.id === m.id)
    const prevMail = currentIdx > 0 ? filtered[currentIdx - 1] : null
    const nextMail = currentIdx >= 0 && currentIdx < filtered.length - 1 ? filtered[currentIdx + 1] : null

    // 会话流列表 (Gmail Threads)
    let threadMessages: MailMessage[] = (m.thread && m.thread.length > 0) ? [...m.thread] : [m]

    // 默认展开的邮件 ID 集合（当前查看的邮件和最新一封邮件默认展开，其余折叠）
    const expandedIds = new Set<string>()
    expandedIds.add(m.id)
    if (threadMessages.length > 0) {
      expandedIds.add(threadMessages[threadMessages.length - 1]!.id)
    }

    let inlineComposerActive = false
    let currentReplyTargetId: string = threadMessages[threadMessages.length - 1]!.id
    let quoteExpanded = false
    let inlineAttachments: MailAttachment[] = []
    const cachedSmartReplies: Record<string, string[]> = {}

    const cleanSubject = normalizeSubject(m.subject) || '邮件'
    const displaySubject = decodeMimeWords(m.subject)

    page.innerHTML = `
      <div class="mail-detail-wrap" id="mailDetailWrap">
        <!-- 顶部操作工具栏 (Top Toolbar) -->
        <div class="mail-toolbar">
          <button class="mail-btn ghost" id="mailBackBtn">
            ‹ 返回列表
          </button>
          <div class="mail-toolbar-nav">
            <button class="mail-btn ghost sm icon-only" id="mailPrevDetailBtn" ${!prevMail ? 'disabled' : ''} title="上一封邮件">‹</button>
            <button class="mail-btn ghost sm icon-only" id="mailNextDetailBtn" ${!nextMail ? 'disabled' : ''} title="下一封邮件">›</button>
          </div>
          <span class="grow"></span>

          <!-- Google Email 核心：快捷回复与转发按钮 -->
          <button class="mail-btn ghost" id="mailReplyTopBtn" title="快捷回复最新邮件">
            ${icon('reply', { size: 14 })} 回复
          </button>
          <button class="mail-btn ghost" id="mailForwardTopBtn" title="转发此会话">
            ${icon('forward', { size: 14 })} 转发
          </button>

          <!-- 邮件归档流转通道 -->
          <button class="mail-btn ghost" id="mailArchiveDocBtn" title="将本邮件及往来会话归档为新的科研文稿">
            ${icon('file', { size: 14 })} 归档为文稿
          </button>
          <button class="mail-btn ghost" id="mailArchivePatientBtn" title="将本邮件归档到患者全景健康档案">
            ${icon('archive', { size: 14 })} 归档到患者档案
          </button>

          <button class="mail-btn ghost" id="mailToggleStar" title="${isStarred ? '取消星标' : '标记星标'}">
            ${icon('star', { size: 14, class: isStarred ? 'mail-star-icon-filled' : '' })} ${isStarred ? '已标星' : '标星'}
          </button>
          ${!isSent && !isTrash ? `<button class="mail-btn ghost" id="mailToggleRead">${isUnread ? icon('check', { size: 14 }) + ' 标为已读' : icon('mail', { size: 14 }) + ' 标为未读'}</button>` : ''}
          <button class="mail-btn ghost" id="mailAddToCal" title="将邮件关联的复查或会议添加到日历">
            ${icon('calendar', { size: 14 })} 添加到日历
          </button>
          ${isTrash ? `
            <button class="mail-btn ghost ok" id="mailRestoreBtn">${icon('refresh', { size: 14 })} 恢复到收件箱</button>
            <button class="mail-btn ghost danger" id="mailDeletePermanentBtn">${icon('trash', { size: 14 })} 彻底删除</button>
          ` : `
            <button class="mail-btn ghost danger" id="mailDelete">${icon('trash', { size: 14 })} 移入废纸篓</button>
          `}
        </div>

        <!-- 邮件会话头部卡片 (Thread Header) -->
        <div class="mail-thread-header-card">
          <div class="mail-header-badge-row">
            <span class="mail-badge ${catClass}">${CATEGORY_NAMES[m.category] || '邮件'}</span>
            ${renderDeliveryPill(m.delivery_status)}
            ${isStarred ? `<span class="mail-badge cat-general">${icon('star', { size: 11, class: 'mail-star-icon-filled' })} 星标收藏</span>` : ''}
            ${m.patient_code ? `<span class="mail-header-tag tag-pt">${icon('users', { size: 13 })} 患者: ${esc(m.patient_code)}</span>` : ''}
            ${m.study_id ? `<span class="mail-header-tag tag-st">${icon('microscope', { size: 13 })} 课题: ${esc(m.study_id)}</span>` : ''}
            <span class="grow"></span>
            <span class="mail-thread-count-chip" id="mailThreadCountChip" ${threadMessages.length <= 1 ? 'style="display:none;"' : ''}>
              ${threadMessages.length} 封往来会话
            </span>
            <span class="mail-header-time">${m.created_at}</span>
          </div>

          <h1 class="mail-subject-display">${esc(displaySubject)}</h1>

          ${(m.patient_code || m.study_id) ? `
            <div class="mail-fast-actions-bar">
              <span class="fast-action-hint">临床与科研直达通道：</span>
              ${m.patient_code ? `
                <button class="fast-action-btn pt-action" id="mailJumpPatient" data-code="${esc(m.patient_code)}">
                  ${icon('users', { size: 14 })} 查看患者全景档案 (${esc(m.patient_code)}) →
                </button>
              ` : ''}
              ${m.study_id ? `
                <button class="fast-action-btn st-action" id="mailJumpStudy" data-study="${esc(m.study_id)}">
                  ${icon('microscope', { size: 14 })} 进入科研课题 (${esc(m.study_id)}) →
                </button>
              ` : ''}
            </div>
          ` : ''}
        </div>

        <!-- 会话流列表 (Thread Stream) -->
        <div class="mail-thread-stream" id="mailThreadStream"></div>

        <!-- Gmail 风格底部内联快速回复框 -->
        <div class="mail-inline-composer-wrap" id="mailInlineComposerWrap"></div>

        <!-- 底部落款 -->
        <div class="mail-footer-signature">
          <div class="mail-sig-line">Heurion Clinical Intelligence & Research Gateway</div>
          <div class="mail-sig-sub">电子邮箱通知专函 · 统一身份与多中心科研系统 (支持与外部真实邮箱双向流转)</div>
        </div>
      </div>
      <div id="mailModalAnchor"></div>
    `

    const wrap = $('mailDetailWrap')
    const threadStreamEl = $('mailThreadStream')
    const composerWrapEl = $('mailInlineComposerWrap')

    function updateThreadCards(): void {
      if (!threadStreamEl) return

      threadStreamEl.innerHTML = threadMessages.map((msg, idx) => {
        const isExp = expandedIds.has(msg.id)
        const isLast = idx === threadMessages.length - 1
        const avatar = getAvatarInitial(msg.sender_name || msg.sender)
        const pureSender = extractPureEmail(msg.sender)
        const senderDisplay = formatSenderDisplay(msg.sender_name, msg.sender)
        const timeShort = formatTimeShort(msg.created_at)

        if (!isExp) {
          // 折叠摘要行 (Collapsed Summary Card)
          return `
            <div class="mail-thread-msg collapsed" data-msg-id="${esc(msg.id)}">
              <div class="thread-msg-avatar" title="${esc(senderDisplay)}">${avatar}</div>
              <div class="thread-msg-sender" title="${esc(senderDisplay)}">${esc(senderDisplay)}</div>
              <div class="thread-msg-snippet">${esc(snippetText(msg.body, 90))}</div>
              <div class="thread-msg-meta">
                ${renderDeliveryPill(msg.delivery_status)}
                <span class="thread-msg-time">${timeShort}</span>
              </div>
            </div>
          `
        }

        // 展开正文卡片 (Expanded Message Card)
        return `
          <div class="mail-thread-msg expanded" data-msg-id="${esc(msg.id)}">
            <div class="thread-msg-head" data-toggle-msg="${threadMessages.length > 1 ? esc(msg.id) : ''}">
              <div class="thread-msg-avatar lg">${avatar}</div>
              <div class="thread-msg-info">
                <div class="thread-msg-info-top">
                  <span class="thread-msg-author"><b>${esc(senderDisplay)}</b></span>
                  <span class="thread-msg-addr">&lt;${esc(pureSender)}&gt;</span>
                  <span class="grow"></span>
                  <span class="thread-msg-time">${msg.created_at}</span>
                </div>
                <div class="thread-msg-info-sub">
                  <span class="thread-msg-recipient">发送给：${esc(msg.recipient)}</span>
                  ${renderDeliveryPill(msg.delivery_status)}
                </div>
              </div>
              <div class="thread-msg-actions" onclick="event.stopPropagation()">
                <button class="mail-btn ghost sm" data-card-reply="${esc(msg.id)}" title="针对此邮件回复">
                  ${icon('reply', { size: 13 })} 回复
                </button>
                <button class="mail-btn ghost sm" data-card-forward="${esc(msg.id)}" title="转发此邮件">
                  ${icon('forward', { size: 13 })} 转发
                </button>
              </div>
            </div>

            ${(msg.delivery_status || msg.folder === 'sent') ? `
              <div class="mail-delivery-notice ${msg.delivery_status === 'external_sent' || msg.delivery_status === 'delivered' ? 'ok' : msg.delivery_status === 'simulated' ? 'simulated' : 'fail'}">
                <div class="mail-delivery-title">
                  ${msg.delivery_status === 'external_sent' ? `${icon('check', { size: 13, class: 'mail-pill-icon' })} 外网邮件投递成功 (SMTP)` :
                    msg.delivery_status === 'delivered' ? `${icon('check', { size: 13, class: 'mail-pill-icon' })} 站内信件投递成功` :
                    msg.delivery_status === 'simulated' ? `${icon('info', { size: 13, class: 'mail-pill-icon' })} 本地开发模拟（未配置外网发信服务）` :
                    msg.delivery_status === 'failed' ? `${icon('close', { size: 13, class: 'mail-pill-icon' })} 外网发信失败` : '投递状态已记录'}
                </div>
                <div class="mail-delivery-text">
                  ${msg.delivery_note ? esc(msg.delivery_note) : (
                    msg.delivery_status === 'external_sent' ? `已通过外网 SMTP 服务成功推送给收件人 ${esc(msg.recipient)}。` :
                    msg.delivery_status === 'delivered' ? `收件人系院内专邮工作站用户，已投递至其收件箱。` :
                    msg.delivery_status === 'simulated' ? `当前环境未配置 SMTP_HOST / RESEND_API_KEY，系统在本地已模拟记录。如需真正发送至外部邮箱，请在 .env 中配置发信服务。` :
                    '外发状态已记录。'
                  )}
                </div>
              </div>
            ` : ''}

            <div class="mail-body-render">
              ${formatEmailBody(msg.body)}
            </div>
            ${renderMessageAttachments(msg)}
          </div>
        `
      }).join('')
    }

    function updateInlineComposer(): void {
      if (!composerWrapEl) return

      const targetMsg = threadMessages.find(x => x.id === currentReplyTargetId) || threadMessages[threadMessages.length - 1] || m
      const myEmail = currentUserEmail.toLowerCase()
      const pureSender = extractPureEmail(targetMsg.sender)
      const pureRecipient = extractPureEmail(targetMsg.recipient)
      const replyRecipient = pureSender.toLowerCase() === myEmail ? pureRecipient : (pureSender || pureRecipient)
      const targetCleanSub = normalizeSubject(targetMsg.subject)
      const replySubject = `Re: ${targetCleanSub || '邮件'}`

      if (!inlineComposerActive) {
        composerWrapEl.innerHTML = `
          <div class="mail-inline-collapsed" id="inlineReplyCollapsedBar">
            <div class="thread-msg-avatar sm">${getAvatarInitial(currentUserEmail)}</div>
            <div class="inline-collapsed-text">点击此处快速回复给 <strong>${esc(replyRecipient)}</strong>...</div>
            <span class="grow"></span>
            <button class="mail-btn ghost sm" id="btnActivateReply">${icon('reply', { size: 13 })} 快速回复</button>
            <button class="mail-btn ghost sm" id="btnActivateForward">${icon('forward', { size: 13 })} 转发</button>
          </div>
        `
        return
      }

      composerWrapEl.innerHTML = `
        <div class="mail-inline-expanded" id="inlineReplyExpandedBox">
          <div class="inline-expanded-header">
            <div class="inline-to-info">
              <span class="inline-to-tag">${icon('reply', { size: 13 })} 回复：</span>
              <span class="mail-recipient-chip">${esc(replyRecipient)}</span>
              <span class="inline-subject-preview">主题：${esc(replySubject)}</span>
            </div>
            <button class="mail-btn ghost sm" id="btnPopoutModal" title="在弹窗中进行全屏编辑">
              ${icon('write', { size: 13 })} 弹窗全屏编辑
            </button>
          </div>

          <!-- AI 智能建议回复 (Clinical Smart Reply) -->
          <div class="mail-smart-replies-wrap" id="inlineSmartRepliesWrap">
            <div class="smart-reply-header">
              <span class="smart-reply-title">${icon('bot', { size: 13 })} AI 临床建议回复</span>
              <span class="smart-reply-hint">基于往来语境实时生成，点击一键填入回复框</span>
            </div>
            <div class="smart-reply-chips-row" id="inlineSmartRepliesRow">
              <span class="smart-reply-placeholder">智能建议生成中...</span>
            </div>
          </div>

          <textarea id="inlineReplyTextarea" class="inline-reply-textarea" rows="4" placeholder="在此键入回复内容… 支持按 ⌘ + Enter 或 Ctrl + Enter 快捷发送"></textarea>

          <!-- 内联附件上传与预览 (Attachments) -->
          <div class="inline-attach-bar">
            <input type="file" id="inlineFileInput" multiple style="display:none;" />
            <button type="button" class="mail-btn ghost sm" id="btnInlineAddAttach">
              ${icon('paperclip', { size: 13 })} 添加附件
            </button>
            <span class="inline-attach-hint">支持医学报告、PDF、CSV、DICOM 说明</span>
          </div>
          <div class="inline-attachments-preview" id="inlineAttachPreview">
            ${renderAttachmentChips(inlineAttachments, 'inline')}
          </div>

          <div class="inline-quote-container">
            <button type="button" class="inline-quote-toggle" id="btnToggleQuote">
              ··· ${quoteExpanded ? '收起引用的原文' : '展开引用的原文'}
            </button>
            <div class="inline-quote-body ${quoteExpanded ? '' : 'hidden'}" id="inlineQuoteBody">
              <pre>${esc(generateThreadQuote(targetMsg))}</pre>
            </div>
          </div>

          <div class="inline-expanded-footer">
            <div class="inline-footer-left">
              <button class="mail-btn primary" id="btnSubmitInlineReply">
                ${icon('send', { size: 14 })} 发送回复
              </button>
              <button class="mail-btn ghost" id="btnCancelInline">取消</button>
            </div>
            <div class="inline-footer-right">
              <span class="inline-sender-hint">以 <strong>${esc(currentUserEmail)}</strong> 身份发出</span>
            </div>
          </div>
        </div>
      `

      // 异步加载并渲染 AI 智能回复药丸 (Smart Replies)
      const renderSmartRepliesPills = (replies: string[]) => {
        const row = $('inlineSmartRepliesRow')
        if (!row) return
        if (!replies || replies.length === 0) {
          row.innerHTML = `<span class="smart-reply-empty">暂无可用的临床建议回复</span>`
          return
        }
        row.innerHTML = replies.map(r => `
          <button type="button" class="smart-reply-pill-btn" data-reply-text="${esc(r)}">
            ${esc(r)}
          </button>
        `).join('')
      }

      const cached = cachedSmartReplies[targetMsg.id]
      if (cached) {
        renderSmartRepliesPills(cached)
      } else {
        void api<{ replies: string[] }>(`/api/mail/messages/${targetMsg.id}/smart-replies`).then(res => {
          if (res && Array.isArray(res.replies)) {
            cachedSmartReplies[targetMsg.id] = res.replies
            renderSmartRepliesPills(res.replies)
          } else {
            renderSmartRepliesPills([])
          }
        }).catch(() => {
          renderSmartRepliesPills([])
        })
      }
    }

    // 初始渲染
    updateThreadCards()
    updateInlineComposer()

    // 异步加载完整会话流 (Gmail Thread)
    if (!m.thread) {
      void api<MailMessage & { thread?: MailMessage[] }>(`/api/mail/messages/${m.id}`).then(full => {
        if (full && full.thread && full.thread.length > 0) {
          const decodedThread = full.thread.map(t => ({
            ...t,
            subject: decodeMimeWords(t.subject),
            body: decodeEmailBody(t.body),
            sender_name: t.sender_name ? decodeMimeWords(t.sender_name) : t.sender_name,
          }))
          m.thread = decodedThread
          if (selectedMailId === m.id) {
            threadMessages = [...decodedThread]
            expandedIds.add(threadMessages[threadMessages.length - 1]!.id)
            currentReplyTargetId = threadMessages[threadMessages.length - 1]!.id
            const chip = $('mailThreadCountChip')
            if (chip) {
              chip.textContent = `${threadMessages.length} 封往来会话`
              chip.style.display = threadMessages.length > 1 ? '' : 'none'
            }
            updateThreadCards()
            updateInlineComposer()
          }
        }
      }).catch(err => console.warn('[mail] load thread failed', err))
    }

    function triggerForward(targetMsg: MailMessage): void {
      const targetCleanSub = normalizeSubject(targetMsg.subject)
      const forwardSubject = `Fwd: ${targetCleanSub || '邮件'}`
      const forwardBody = `\n\n------------------ 转发邮件 ------------------\n发件人: ${formatSenderDisplay(targetMsg.sender_name, targetMsg.sender)}\n时间: ${targetMsg.created_at}\n收件人: ${targetMsg.recipient}\n主题: ${decodeMimeWords(targetMsg.subject)}\n\n${targetMsg.body}`

      showComposeModal({
        subject: forwardSubject,
        body: forwardBody,
        category: m.category,
        patient_code: m.patient_code || undefined,
        study_id: m.study_id || undefined,
      })
    }

    async function handleInlineReply(): Promise<void> {
      const textarea = $('inlineReplyTextarea') as HTMLTextAreaElement | null
      const content = textarea?.value.trim()
      if (!content) {
        notice('请输入回复内容', true)
        textarea?.focus()
        return
      }

      const targetMsg = threadMessages.find(x => x.id === currentReplyTargetId) || threadMessages[threadMessages.length - 1] || m
      const myEmail = currentUserEmail.toLowerCase()
      const pureSender = extractPureEmail(targetMsg.sender)
      const pureRecipient = extractPureEmail(targetMsg.recipient)
      const replyRecipient = pureSender.toLowerCase() === myEmail ? pureRecipient : (pureSender || pureRecipient)
      const targetCleanSub = normalizeSubject(targetMsg.subject)
      const replySubject = `Re: ${targetCleanSub || '邮件'}`

      const submitBtn = $('btnSubmitInlineReply') as HTMLButtonElement | null
      if (submitBtn) {
        submitBtn.disabled = true
        submitBtn.textContent = '发送中…'
      }

      const quoteText = generateThreadQuote(targetMsg)
      const fullBody = `${content}\n${quoteText}`

      try {
        const sentAtts = inlineAttachments.length > 0 ? [...inlineAttachments] : undefined

        const res = await api<{ id?: string; delivery?: { status?: string; note?: string } }>('/api/mail/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: replyRecipient,
            category: m.category,
            subject: replySubject,
            patient_code: m.patient_code || undefined,
            study_id: m.study_id || undefined,
            thread_id: m.thread_id || m.id,
            in_reply_to: targetMsg.id,
            body: fullBody,
            attachments: sentAtts,
          }),
        })

        if (res?.delivery?.status === 'external_sent') {
          notice('回复已通过外网 SMTP 服务成功发出！')
        } else if (res?.delivery?.status === 'simulated') {
          notice('回复已在本地模拟记录（未配置外网 SMTP）')
        } else if (res?.delivery?.status === 'failed') {
          notice('外发失败：' + (res.delivery.note || '请检查发信配置'), true)
        } else {
          notice('回复已成功发送！')
        }

        const newMsg: MailMessage = {
          id: res?.id || `reply-${Date.now()}`,
          sender: currentUserEmail,
          sender_name: '我',
          recipient: replyRecipient,
          subject: replySubject,
          body: fullBody,
          category: m.category,
          patient_code: m.patient_code,
          study_id: m.study_id,
          read: 1,
          created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
          folder: 'sent',
          delivery_status: (res?.delivery?.status as any) || 'delivered',
          delivery_note: res?.delivery?.note,
          thread_id: m.thread_id || m.id,
          in_reply_to: targetMsg.id,
          attachments: sentAtts,
        }

        inlineAttachments = []

        threadMessages.push(newMsg)
        if (!m.thread) m.thread = [m]
        m.thread.push(newMsg)
        expandedIds.add(newMsg.id)

        inlineComposerActive = false
        quoteExpanded = false

        const chip = $('mailThreadCountChip')
        if (chip) {
          chip.textContent = `${threadMessages.length} 封往来会话`
          chip.style.display = threadMessages.length > 1 ? '' : 'none'
        }

        updateThreadCards()
        updateInlineComposer()

        setTimeout(() => {
          const newEl = document.querySelector(`[data-msg-id="${newMsg.id}"]`)
          newEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }, 100)

        void loadMessages()
      } catch (err) {
        notice((err as Error).message, true)
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false
          submitBtn.innerHTML = `${icon('send', { size: 14 })} 发送回复`
        }
      }
    }

    // 绑定当前会话详情页内的交互事件
    wrap?.addEventListener('click', async e => {
      const target = e.target as HTMLElement

      // 点击折叠消息卡展开
      const collapsedRow = target.closest<HTMLElement>('.mail-thread-msg.collapsed')
      if (collapsedRow) {
        const id = collapsedRow.dataset.msgId
        if (id) {
          expandedIds.add(id)
          updateThreadCards()
        }
        return
      }

      // 点击展开卡头部折叠
      const toggleHead = target.closest<HTMLElement>('[data-toggle-msg]')
      if (toggleHead && !target.closest('button')) {
        const id = toggleHead.dataset.toggleMsg
        if (id && expandedIds.size > 1) {
          expandedIds.delete(id)
          updateThreadCards()
        }
        return
      }

      // 卡片内回复按钮
      const cardReplyBtn = target.closest<HTMLElement>('[data-card-reply]')
      if (cardReplyBtn) {
        currentReplyTargetId = cardReplyBtn.dataset.cardReply || m.id
        inlineComposerActive = true
        updateInlineComposer()
        $('inlineReplyTextarea')?.focus()
        $('mailInlineComposerWrap')?.scrollIntoView({ behavior: 'smooth' })
        return
      }

      // 卡片内转发按钮
      const cardFwdBtn = target.closest<HTMLElement>('[data-card-forward]')
      if (cardFwdBtn) {
        const id = cardFwdBtn.dataset.cardForward
        const fwdMsg = threadMessages.find(x => x.id === id) || m
        triggerForward(fwdMsg)
        return
      }

      // 顶部回复
      if (target.closest('#mailReplyTopBtn')) {
        inlineComposerActive = true
        updateInlineComposer()
        $('inlineReplyTextarea')?.focus()
        $('mailInlineComposerWrap')?.scrollIntoView({ behavior: 'smooth' })
        return
      }

      // 顶部转发
      if (target.closest('#mailForwardTopBtn')) {
        const lastMsg = threadMessages[threadMessages.length - 1] || m
        triggerForward(lastMsg)
        return
      }

      // 顶部操作：归档为文稿
      const archiveDocBtn = target.closest<HTMLElement>('#mailArchiveDocBtn')
      if (archiveDocBtn) {
        archiveDocBtn.setAttribute('disabled', 'true')
        archiveDocBtn.innerHTML = `${icon('file', { size: 14 })} 归档中...`
        try {
          const res = await api<{ ok: boolean; doc_id: string; title: string }>(`/api/mail/messages/${m.id}/to-doc`, {
            method: 'POST',
          })
          notice(`已成功将邮件归档为新文稿《${res.title}》！`)
        } catch (err) {
          notice(`归档失败: ${(err as Error).message}`, true)
        } finally {
          archiveDocBtn.removeAttribute('disabled')
          archiveDocBtn.innerHTML = `${icon('file', { size: 14 })} 归档为文稿`
        }
        return
      }

      // 顶部操作：归档到患者档案
      const archivePtBtn = target.closest<HTMLElement>('#mailArchivePatientBtn')
      if (archivePtBtn) {
        showArchivePatientModal(m)
        return
      }

      // 附件一键导入到个人资料库 / RAG 知识库
      const importKbBtn = target.closest<HTMLElement>('.btn-import-kb')
      if (importKbBtn) {
        const msgId = importKbBtn.dataset.msgId
        const attId = importKbBtn.dataset.attId
        const attName = importKbBtn.dataset.attName || '附件'
        if (msgId && attId) {
          importKbBtn.setAttribute('disabled', 'true')
          importKbBtn.innerHTML = `${icon('sparkles', { size: 12 })} 导入中...`
          try {
            const res = await api<{ ok: boolean; duplicate?: boolean; file?: { name: string } }>(`/api/mail/messages/${msgId}/attachments/${attId}/to-kb`, {
              method: 'POST',
            })
            if (res?.ok) {
              notice(`已成功将附件 "${attName}" 导入到个人资料库并建立向量索引！`)
              importKbBtn.innerHTML = `${icon('check', { size: 12 })} 已导入资料库`
            } else {
              notice(`导入失败: ${(res as any)?.error || '未知错误'}`, true)
              importKbBtn.removeAttribute('disabled')
              importKbBtn.innerHTML = `${icon('sparkles', { size: 12 })} 导入知识库`
            }
          } catch (err) {
            notice(`导入失败: ${(err as Error).message}`, true)
            importKbBtn.removeAttribute('disabled')
            importKbBtn.innerHTML = `${icon('sparkles', { size: 12 })} 导入知识库`
          }
        }
        return
      }

      // 底部折叠条激活回复
      if (target.closest('#inlineReplyCollapsedBar') || target.closest('#btnActivateReply')) {
        inlineComposerActive = true
        updateInlineComposer()
        $('inlineReplyTextarea')?.focus()
        return
      }

      // 底部折叠条激活转发
      if (target.closest('#btnActivateForward')) {
        const lastMsg = threadMessages[threadMessages.length - 1] || m
        triggerForward(lastMsg)
        return
      }

      // 点击 AI 建议回复药丸 -> 填入输入框
      const replyPill = target.closest<HTMLElement>('.smart-reply-pill-btn')
      if (replyPill) {
        const text = replyPill.dataset.replyText
        const textarea = $('inlineReplyTextarea') as HTMLTextAreaElement | null
        if (textarea && text) {
          textarea.value = text
          textarea.focus()
          notice('已自动填入 AI 建议回复，可按 ⌘+Enter 或点击发送')
        }
        return
      }

      // 内联回复添加附件按钮
      const addAttachBtn = target.closest<HTMLElement>('#btnInlineAddAttach')
      if (addAttachBtn) {
        ($('inlineFileInput') as HTMLInputElement | null)?.click()
        return
      }

      // 移除已选内联附件
      const removeInlineAtt = target.closest<HTMLElement>('[data-remove-inline]')
      if (removeInlineAtt) {
        const idx = parseInt(removeInlineAtt.dataset.removeInline!, 10)
        if (!isNaN(idx) && idx >= 0 && idx < inlineAttachments.length) {
          inlineAttachments.splice(idx, 1)
          const preview = $('inlineAttachPreview')
          if (preview) {
            preview.innerHTML = renderAttachmentChips(inlineAttachments, 'inline')
          }
        }
        return
      }

      // 弹窗全屏编辑
      if (target.closest('#btnPopoutModal')) {
        const text = ($('inlineReplyTextarea') as HTMLTextAreaElement)?.value || ''
        const targetMsg = threadMessages.find(x => x.id === currentReplyTargetId) || threadMessages[threadMessages.length - 1] || m
        const myEmail = currentUserEmail.toLowerCase()
        const pureSender = extractPureEmail(targetMsg.sender)
        const pureRecipient = extractPureEmail(targetMsg.recipient)
        const replyRecipient = pureSender.toLowerCase() === myEmail ? pureRecipient : (pureSender || pureRecipient)
        const quoteText = generateThreadQuote(targetMsg)
        showComposeModal({
          recipient: replyRecipient,
          subject: 'Re: ' + (normalizeSubject(targetMsg.subject) || '邮件'),
          body: text ? `${text}\n${quoteText}` : quoteText,
          category: m.category,
          patient_code: m.patient_code || undefined,
          study_id: m.study_id || undefined,
          thread_id: m.thread_id || m.id,
          in_reply_to: targetMsg.id,
          attachments: inlineAttachments.length > 0 ? [...inlineAttachments] : undefined,
        })
        return
      }

      // 引用折叠切换
      if (target.closest('#btnToggleQuote')) {
        quoteExpanded = !quoteExpanded
        const qb = $('inlineQuoteBody')
        if (qb) qb.classList.toggle('hidden', !quoteExpanded)
        const tbtn = $('btnToggleQuote')
        if (tbtn) tbtn.textContent = `··· ${quoteExpanded ? '收起引用的原文' : '展开引用的原文'}`
        return
      }

      // 取消内联回复
      if (target.closest('#btnCancelInline')) {
        inlineComposerActive = false
        updateInlineComposer()
        return
      }

      // 提交回复
      if (target.closest('#btnSubmitInlineReply')) {
        void handleInlineReply()
        return
      }
    })

    // 监听内联附件文件选取
    wrap?.addEventListener('change', async e => {
      const input = e.target as HTMLInputElement
      if (input.id === 'inlineFileInput' && input.files && input.files.length > 0) {
        const files = Array.from(input.files)
        for (const file of files) {
          try {
            const base64 = await readFileAsBase64(file)
            inlineAttachments.push({
              id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              name: file.name,
              size: file.size,
              mime: file.type || 'application/octet-stream',
              data_base64: base64,
            })
          } catch (err) {
            notice(`读取附件失败: ${file.name}`, true)
          }
        }
        input.value = ''
        const preview = $('inlineAttachPreview')
        if (preview) {
          preview.innerHTML = renderAttachmentChips(inlineAttachments, 'inline')
        }
      }
    })

    // 快捷键支持：⌘ + Enter 或 Ctrl + Enter 触发回复发送
    wrap?.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        const textarea = $('inlineReplyTextarea')
        if (document.activeElement === textarea) {
          e.preventDefault()
          void handleInlineReply()
        }
      }
    })

    // 自动标记已读
    if (isUnread) {
      void api(`/api/mail/messages/${m.id}/read`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: true }),
      }).then(() => {
        m.read = 1
        renderNavList()
      })
    }

    // 将会话中所有未读邮件均标为已读
    threadMessages.forEach(msg => {
      if (!msg.read && msg.folder !== 'sent' && msg.id !== m.id) {
        void api(`/api/mail/messages/${msg.id}/read`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ read: true }),
        }).catch(() => {})
        msg.read = 1
      }
    })
  }

  function bindMainEvents(): void {
    if (mainEventsBound) return
    mainEventsBound = true

    const page = $('page')
    if (!page) return

    // 统一委托单选/全选/分页大小变动事件
    page.addEventListener('change', e => {
      const target = e.target as HTMLElement
      if (target.id === 'mailSelectAllPage') {
        const checked = (target as HTMLInputElement).checked
        const filtered = getFilteredMessages()
        const startIdx = (currentPage - 1) * pageSize
        const pageItems = filtered.slice(startIdx, startIdx + pageSize)
        if (checked) {
          pageItems.forEach(m => selectedIds.add(m.id))
        } else {
          pageItems.forEach(m => selectedIds.delete(m.id))
        }
        renderMain()
        return
      }

      if (target.classList.contains('mail-item-checkbox')) {
        const chk = target as HTMLInputElement
        const id = chk.dataset.id
        if (!id) return
        if (chk.checked) selectedIds.add(id)
        else selectedIds.delete(id)
        renderMain()
        return
      }

      if (target.id === 'mailPageSizeSelect') {
        const sel = target as HTMLSelectElement
        pageSize = parseInt(sel.value, 10) || 15
        currentPage = 1
        renderMain()
        return
      }
    })

    // 统一委托页面所有点击事件（彻底解决重复绑定与内存泄露）
    page.addEventListener('click', async e => {
      const target = e.target as HTMLElement

      // 1. 复制医生邮箱
      if (target.closest('#copyMailAddress')) {
        navigator.clipboard?.writeText(currentUserEmail)
        notice('已复制医生工作邮箱地址: ' + currentUserEmail)
        return
      }

      // 2. 切换列表 / 看板
      if (target.closest('#mailViewListBtn') || target.closest('#mailEnterListBtn')) {
        mainViewMode = 'list'
        renderMain()
        return
      }
      if (target.closest('#mailViewDashBtn')) {
        mainViewMode = 'dashboard'
        renderMain()
        return
      }

      // 3. 刷新收取
      if (target.closest('#mailRefreshBtn')) {
        notice('正在刷新收件箱...')
        await loadMessages()
        notice('收件箱已刷新！')
        return
      }

      // 4. 写邮件
      if (target.closest('#mailComposeActionBtn')) {
        showComposeModal()
        return
      }

      // 5. 文件夹切换 (收件箱 / 已发送 / 废纸篓)
      const folderBtn = target.closest<HTMLButtonElement>('.mail-folder-tab')
      if (folderBtn) {
        const folder = folderBtn.dataset.folder as 'inbox' | 'sent' | 'trash'
        if (folder && activeFolder !== folder) {
          activeFolder = folder
          activeFilter = 'all'
          selectedMailId = null
          selectedIds.clear()
          currentPage = 1
          updateFolderButtons()
          void loadMessages()
        }
        return
      }

      // 6. 过滤筛选药丸 (全部 / 未读 / 星标 / 随访 / 科研)
      const filterChip = target.closest<HTMLButtonElement>('.mail-filter-chip')
      if (filterChip) {
        const filter = filterChip.dataset.filter as any
        if (filter) {
          activeFilter = filter
          currentPage = 1
          renderNavList()
          renderMain()
        }
        return
      }

      // 7. 分页翻页
      if (target.closest('#mailFirstPage')) { currentPage = 1; renderMain(); return }
      if (target.closest('#mailPrevPage')) { if (currentPage > 1) { currentPage--; renderMain() }; return }
      if (target.closest('#mailNextPage')) { currentPage++; renderMain(); return }
      if (target.closest('#mailLastPage')) {
        const filtered = getFilteredMessages()
        currentPage = Math.max(1, Math.ceil(filtered.length / pageSize))
        renderMain()
        return
      }

      // 8. 批量操作工具条按钮
      if (target.closest('#batchClearSelection')) {
        selectedIds.clear()
        renderMain()
        return
      }
      if (target.closest('#batchMarkReadBtn')) {
        if (selectedIds.size === 0) return
        const ids = Array.from(selectedIds)
        await api('/api/mail/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'read', ids }),
        })
        messages.forEach(m => { if (selectedIds.has(m.id)) m.read = 1 })
        notice(`已将 ${ids.length} 封邮件标记为已读`)
        selectedIds.clear()
        renderNavList()
        renderMain()
        return
      }
      if (target.closest('#batchMarkUnreadBtn')) {
        if (selectedIds.size === 0) return
        const ids = Array.from(selectedIds)
        await api('/api/mail/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unread', ids }),
        })
        messages.forEach(m => { if (selectedIds.has(m.id)) m.read = 0 })
        notice(`已将 ${ids.length} 封邮件标记为未读`)
        selectedIds.clear()
        renderNavList()
        renderMain()
        return
      }
      if (target.closest('#batchStarBtn')) {
        if (selectedIds.size === 0) return
        const ids = Array.from(selectedIds)
        await api('/api/mail/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'star', ids }),
        })
        messages.forEach(m => { if (selectedIds.has(m.id)) m.starred = 1 })
        notice(`已为 ${ids.length} 封邮件添加星标`)
        selectedIds.clear()
        renderNavList()
        renderMain()
        return
      }
      if (target.closest('#batchUnstarBtn')) {
        if (selectedIds.size === 0) return
        const ids = Array.from(selectedIds)
        await api('/api/mail/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unstar', ids }),
        })
        messages.forEach(m => { if (selectedIds.has(m.id)) m.starred = 0 })
        notice(`已取消 ${ids.length} 封邮件星标`)
        selectedIds.clear()
        renderNavList()
        renderMain()
        return
      }
      if (target.closest('#batchMoveTrashBtn')) {
        if (selectedIds.size === 0) return
        const ids = Array.from(selectedIds)
        const ok = await askConfirm({
          title: '移入废纸篓',
          message: `确定要将选中的 ${ids.length} 封邮件移入废纸篓吗？`,
          confirm: '确认移入',
          danger: true,
        })
        if (!ok) return
        await api('/api/mail/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'trash', ids }),
        })
        notice(`已将 ${ids.length} 封邮件移入废纸篓`)
        selectedIds.clear()
        await loadMessages()
        return
      }
      if (target.closest('#batchRestoreBtn')) {
        if (selectedIds.size === 0) return
        const ids = Array.from(selectedIds)
        await api('/api/mail/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'restore', ids }),
        })
        notice(`已恢复 ${ids.length} 封邮件至收件箱`)
        selectedIds.clear()
        await loadMessages()
        return
      }
      if (target.closest('#batchDeletePermanentBtn')) {
        if (selectedIds.size === 0) return
        const ids = Array.from(selectedIds)
        const ok = await askConfirm({
          title: '彻底永久删除',
          message: `彻底删除后这 ${ids.length} 封邮件将无法恢复，确定彻底删除吗？`,
          confirm: '彻底删除',
          danger: true,
        })
        if (!ok) return
        await api('/api/mail/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', ids }),
        })
        notice(`已彻底删除 ${ids.length} 封邮件`)
        selectedIds.clear()
        await loadMessages()
        return
      }

      // 9. 清空废纸篓按钮
      if (target.closest('#mailEmptyTrashBtn')) {
        const ok = await askConfirm({
          title: '清空废纸篓',
          message: '确定要清空废纸篓中的所有邮件吗？此操作无法撤销。',
          confirm: '清空废纸篓',
          danger: true,
        })
        if (!ok) return
        await api('/api/mail/trash', { method: 'DELETE' })
        notice('废纸篓已清空')
        selectedIds.clear()
        selectedMailId = null
        await loadMessages()
        return
      }

      // 10. 详情页顶部操作
      if (target.closest('#mailBackBtn')) {
        selectedMailId = null
        renderNavList()
        renderMain()
        return
      }
      if (target.closest('#mailPrevDetailBtn')) {
        const filtered = getFilteredMessages()
        const currentIdx = filtered.findIndex(x => x.id === selectedMailId)
        if (currentIdx > 0 && filtered[currentIdx - 1]) {
          selectedMailId = filtered[currentIdx - 1]!.id
          renderNavList()
          renderMain()
        }
        return
      }
      if (target.closest('#mailNextDetailBtn')) {
        const filtered = getFilteredMessages()
        const currentIdx = filtered.findIndex(x => x.id === selectedMailId)
        if (currentIdx >= 0 && currentIdx < filtered.length - 1 && filtered[currentIdx + 1]) {
          selectedMailId = filtered[currentIdx + 1]!.id
          renderNavList()
          renderMain()
        }
        return
      }
      if (target.closest('#mailToggleStar')) {
        if (!selectedMailId) return
        const mail = messages.find(x => x.id === selectedMailId)
        if (!mail) return
        const nextStar = !mail.starred
        await api(`/api/mail/messages/${mail.id}/star`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ starred: nextStar }),
        })
        mail.starred = nextStar ? 1 : 0
        notice(nextStar ? '已为邮件添加星标' : '已取消星标')
        renderNavList()
        renderMain()
        return
      }
      if (target.closest('#mailRestoreBtn')) {
        if (!selectedMailId) return
        await api('/api/mail/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'restore', ids: [selectedMailId] }),
        })
        notice('邮件已恢复至收件箱')
        selectedMailId = null
        await loadMessages()
        return
      }
      if (target.closest('#mailDeletePermanentBtn')) {
        if (!selectedMailId) return
        const ok = await askConfirm({
          title: '彻底永久删除邮件',
          message: '彻底删除后此邮件将无法找回，确认永久删除吗？',
          confirm: '永久删除',
          danger: true,
        })
        if (ok) {
          await api(`/api/mail/messages/${selectedMailId}`, { method: 'DELETE' })
          notice('邮件已彻底删除')
          selectedMailId = null
          await loadMessages()
        }
        return
      }
      if (target.closest('#mailDelete')) {
        if (!selectedMailId) return
        const ok = await askConfirm({
          title: '移入废纸篓',
          message: '确定要将此邮件移入废纸篓吗？',
          confirm: '移入废纸篓',
          danger: true,
        })
        if (ok) {
          await api('/api/mail/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'trash', ids: [selectedMailId] }),
          })
          notice('邮件已移入废纸篓')
          selectedMailId = null
          await loadMessages()
        }
        return
      }
      if (target.closest('#mailToggleRead') && selectedMailId) {
        const mail = messages.find(x => x.id === selectedMailId)
        if (mail) {
          const nextRead = !mail.read
          await api(`/api/mail/messages/${mail.id}/read`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: nextRead }),
          })
          mail.read = nextRead ? 1 : 0
          notice(nextRead ? '已标记为已读' : '已标记为未读')
          renderNavList()
          renderMain()
        }
        return
      }
      if (target.closest('#mailAddToCal') && selectedMailId) {
        const mail = messages.find(x => x.id === selectedMailId)
        if (mail) {
          await addEmailToCalendar(mail)
        }
        return
      }

      // 11. 行内悬浮快捷操作
      const restoreRowBtn = target.closest<HTMLElement>('[data-restore-mail]')
      if (restoreRowBtn) {
        e.stopPropagation()
        const id = restoreRowBtn.dataset.restoreMail!
        await api('/api/mail/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'restore', ids: [id] }),
        })
        notice('已恢复至收件箱')
        await loadMessages()
        return
      }

      const delMailBtn = target.closest<HTMLElement>('[data-del-mail]')
      if (delMailBtn) {
        e.stopPropagation()
        const id = delMailBtn.dataset.delMail!
        if (activeFolder === 'trash') {
          const ok = await askConfirm({
            title: '彻底永久删除邮件',
            message: '彻底删除后该邮件将无法找回，确定永久删除吗？',
            confirm: '永久删除',
            danger: true,
          })
          if (ok) {
            await api(`/api/mail/messages/${id}`, { method: 'DELETE' })
            notice('邮件已永久删除')
            await loadMessages()
          }
        } else {
          await api('/api/mail/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'trash', ids: [id] }),
          })
          notice('已移入废纸篓')
          await loadMessages()
        }
        return
      }

      const starRowBtn = target.closest<HTMLElement>('[data-star-id]')
      if (starRowBtn) {
        e.stopPropagation()
        const id = starRowBtn.dataset.starId!
        const mail = messages.find(x => x.id === id)
        if (mail) {
          const nextStar = !mail.starred
          await api(`/api/mail/messages/${id}/star`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ starred: nextStar }),
          })
          mail.starred = nextStar ? 1 : 0
          renderNavList()
          renderMain()
        }
        return
      }

      const readToggle = target.closest<HTMLElement>('[data-toggle-read]')
      if (readToggle) {
        e.stopPropagation()
        const id = readToggle.dataset.toggleRead!
        const mail = messages.find(x => x.id === id)
        if (mail) {
          const nextRead = !mail.read
          await api(`/api/mail/messages/${id}/read`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: nextRead }),
          })
          mail.read = nextRead ? 1 : 0
          notice(nextRead ? '已标为已读' : '已标为未读')
          renderNavList()
          renderMain()
        }
        return
      }

      const addCalRowBtn = target.closest<HTMLElement>('[data-add-cal]')
      if (addCalRowBtn) {
        e.stopPropagation()
        const id = addCalRowBtn.dataset.addCal!
        const mail = messages.find(x => x.id === id)
        if (mail) {
          await addEmailToCalendar(mail)
        }
        return
      }

      // 12. 点击邮件行进入详情（排除复选框、按钮）
      const row = target.closest<HTMLElement>('.mail-row')
      if (row && !target.closest('button') && !target.closest('input')) {
        const id = row.dataset.mailId
        if (id) {
          selectedMailId = id
          const targetMail = messages.find(x => x.id === id)
          if (targetMail && !targetMail.read) {
            targetMail.read = 1
            void api(`/api/mail/messages/${id}/read`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ read: true }),
            })
          }
          renderNavList()
          renderMain()
        }
        return
      }

      // 13. 患者 / 课题跳转
      const ptJump = target.closest<HTMLElement>('#mailJumpPatient')
      if (ptJump && hooks.openPatient) {
        const code = ptJump.dataset.code!
        await hooks.openPatient(code)
        return
      }
      const stJump = target.closest<HTMLElement>('#mailJumpStudy')
      if (stJump && hooks.openStudy) {
        const study = stJump.dataset.study!
        await hooks.openStudy(study)
        return
      }
    })
  }

  async function addEmailToCalendar(mail: MailMessage): Promise<void> {
    const today = new Date()
    const nextWeek = new Date(today.getTime() + 7 * 86400000)
    const dateStr = nextWeek.toISOString().slice(0, 10)
    const startTime = `${dateStr} 10:00`
    const endTime = `${dateStr} 11:30`

    try {
      await api('/api/calendar/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `【${CATEGORY_NAMES[mail.category] || '事项'}】${mail.subject}`,
          category: mail.category === 'research' ? 'research' : 'followup',
          start_time: startTime,
          end_time: endTime,
          patient_code: mail.patient_code || undefined,
          study_title: mail.study_id || undefined,
          notes: `由邮件《${mail.subject}》一键转化生成：\n${mail.body.slice(0, 140)}...`,
          send_email: false,
        }),
      })
      notice('已成功将此事项添加到日历排期！')
      if (hooks.openCalendar) {
        await hooks.openCalendar()
      }
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  function showArchivePatientModal(msg: MailMessage): void {
    const anchor = $('mailModalAnchor')
    if (!anchor) return

    anchor.innerHTML = `
      <div class="mail-modal-scrim" id="mailArchivePatientScrim">
        <div class="mail-modal-card archive-patient-modal" role="dialog" aria-modal="true">
          <div class="mail-modal-head">
            <h2>${icon('archive', { size: 16 })} 归档到患者档案 (Link to Patient EHR)</h2>
            <button class="mail-modal-close" id="mailArchivePatientClose" aria-label="关闭">${icon('close', { size: 16 })}</button>
          </div>
          <div class="archive-patient-body">
            <div class="archive-patient-meta">
              <div><strong>邮件主题：</strong>${esc(decodeMimeWords(msg.subject))}</div>
              <div><strong>发件人：</strong>${esc(formatSenderDisplay(msg.sender_name, msg.sender))} · <strong>时间：</strong>${msg.created_at}</div>
              ${msg.patient_code ? `<div style="margin-top:4px;color:var(--mint);"><strong>当前关联患者：</strong>${esc(msg.patient_code)}</div>` : ''}
            </div>

            <div class="form-row">
              <label>选择目标患者档案 (Select Target Patient) *</label>
              <input type="text" id="patientSearchInput" placeholder="输入患者姓名、代号或首字母筛选..." />
              <div class="patient-select-list" id="patientSelectList">
                <div class="patient-select-item" style="color:var(--muted); justify-content:center;">正在加载患者档案列表...</div>
              </div>
            </div>

            <div class="form-row">
              <label>归档临床批注与随访备忘 (Clinical Notes)</label>
              <textarea id="archivePatientNote" rows="3" placeholder="填写本次随访沟通纪要、处置建议或病程摘要...">${esc(`由邮件《${msg.subject}》归档的临床往来沟通记录`)}</textarea>
            </div>

            <div class="mail-modal-foot">
              <button type="button" class="mail-btn ghost" id="mailArchivePatientCancel">取消</button>
              <button type="button" class="mail-btn primary" id="mailArchivePatientSubmit" disabled>
                ${icon('archive', { size: 14 })} 确认归档到此患者档案
              </button>
            </div>
          </div>
        </div>
      </div>
    `

    const scrim = $('mailArchivePatientScrim')
    const close = () => { scrim?.remove() }
    $('mailArchivePatientClose')?.addEventListener('click', close)
    $('mailArchivePatientCancel')?.addEventListener('click', close)
    scrim?.addEventListener('click', e => { if (e.target === scrim) close() })

    let patientsList: any[] = []
    let selectedPatient: any = null

    const renderList = (filter = '') => {
      const listEl = $('patientSelectList')
      if (!listEl) return

      const q = filter.trim().toLowerCase()
      const filtered = patientsList.filter(p => {
        if (!q) return true
        const code = (p.code || '').toLowerCase()
        const name = (p.name || '').toLowerCase()
        const diag = (p.diagnosis || p.primary_diagnosis || '').toLowerCase()
        return code.includes(q) || name.includes(q) || diag.includes(q)
      })

      if (filtered.length === 0) {
        listEl.innerHTML = `<div class="patient-select-item" style="color:var(--muted); justify-content:center;">未找到匹配的患者档案</div>`
        return
      }

      listEl.innerHTML = filtered.map(p => {
        const isSelected = selectedPatient && selectedPatient.id === p.id
        const code = p.code || p.id
        const name = p.name ? ` · ${esc(p.name)}` : ''
        const sex = p.sex || p.gender ? ` (${esc(p.sex || p.gender)})` : ''
        const diag = p.diagnosis || p.primary_diagnosis ? ` · ${esc(p.diagnosis || p.primary_diagnosis)}` : ''
        return `
          <div class="patient-select-item ${isSelected ? 'selected' : ''}" data-pt-id="${esc(p.id)}">
            <span style="font-weight:600; color:var(--text);">${esc(code)}</span>
            <span style="color:var(--muted);">${name}${sex}${diag}</span>
          </div>
        `
      }).join('')
    }

    $('patientSearchInput')?.addEventListener('input', e => {
      renderList((e.target as HTMLInputElement).value)
    })

    $('patientSelectList')?.addEventListener('click', e => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.patient-select-item[data-pt-id]')
      if (!item) return
      const ptId = item.dataset.ptId
      selectedPatient = patientsList.find(p => p.id === ptId) || null
      renderList(($('patientSearchInput') as HTMLInputElement)?.value || '')

      const submitBtn = $('mailArchivePatientSubmit') as HTMLButtonElement | null
      if (submitBtn) {
        submitBtn.disabled = !selectedPatient
      }
    })

    // 异步加载患者列表
    void api<any[]>('/api/patients').then(pts => {
      patientsList = Array.isArray(pts) ? pts : []
      if (msg.patient_id) {
        selectedPatient = patientsList.find(p => p.id === msg.patient_id)
      } else if (msg.patient_code) {
        selectedPatient = patientsList.find(p => p.code === msg.patient_code)
      }
      renderList()
      const submitBtn = $('mailArchivePatientSubmit') as HTMLButtonElement | null
      if (submitBtn) {
        submitBtn.disabled = !selectedPatient
      }
    }).catch(err => {
      const listEl = $('patientSelectList')
      if (listEl) {
        listEl.innerHTML = `<div class="patient-select-item" style="color:var(--danger); justify-content:center;">加载患者列表失败: ${esc((err as Error).message)}</div>`
      }
    })

    $('mailArchivePatientSubmit')?.addEventListener('click', async () => {
      if (!selectedPatient) return
      const submitBtn = $('mailArchivePatientSubmit') as HTMLButtonElement
      submitBtn.disabled = true
      submitBtn.innerHTML = `${icon('archive', { size: 14 })} 归档中...`

      const note = ($('archivePatientNote') as HTMLTextAreaElement)?.value.trim()
      try {
        const res = await api<{ ok: boolean; patient_id: string; patient_code: string; title: string }>(`/api/mail/messages/${msg.id}/to-patient`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patient_id: selectedPatient.id,
            patient_code: selectedPatient.code,
            note,
          }),
        })

        msg.patient_id = res.patient_id
        msg.patient_code = res.patient_code
        notice(`已成功将邮件归档至患者 [${res.patient_code}] 的档案，并生成问诊记录！`)
        close()

        renderMailDetail(msg)
      } catch (err) {
        notice(`归档失败: ${(err as Error).message}`, true)
        submitBtn.disabled = false
        submitBtn.innerHTML = `${icon('archive', { size: 14 })} 确认归档到此患者档案`
      }
    })
  }

  function showComposeModal(initial?: ComposeInitial): void {
    const anchor = $('mailModalAnchor')
    if (!anchor) return

    const initialCat = initial?.category || 'followup'
    const composeAttachments: MailAttachment[] = initial?.attachments ? [...initial.attachments] : []

    anchor.innerHTML = `
      <div class="mail-modal-scrim" id="mailComposeScrim">
        <div class="mail-modal-card compose-card" role="dialog" aria-modal="true">
          <div class="mail-modal-head">
            <h2>${initial?.in_reply_to ? icon('reply', { size: 16 }) + ' 回复专邮' : initial?.subject?.startsWith('Fwd:') ? icon('forward', { size: 16 }) + ' 转发专邮' : icon('write', { size: 16 }) + ' 起草并发送医疗通知专邮'}</h2>
            <button class="mail-modal-close" id="mailComposeClose" aria-label="关闭">${icon('close', { size: 16 })}</button>
          </div>
          <div class="mail-smtp-status-tip ${mailStatus?.configured ? 'configured' : 'mock'}">
            ${mailStatus?.configured
              ? `<span class="smtp-dot ok"></span> <strong>发信服务已连接 (${mailStatus.mode === 'smtp' ? '标准 SMTP' : 'Resend'})</strong>：支持直接向外部真实邮箱（如 Gmail、网易、QQ 邮箱等）真实发信。`
              : `<span class="smtp-dot warn"></span> <strong>本地开发模拟模式</strong>：当前未配置外网发信服务 (SMTP)。发往外部邮箱时将在本地保留记录并模拟成功。`
            }
          </div>
          <form id="mailComposeForm" class="mail-form">
            <div class="form-row">
              <label>收件人邮箱 (Recipient) *</label>
              <input type="email" id="composeTo" required value="${esc(initial?.recipient || '')}" placeholder="如：patient@gmail.com 或 wang@heurion.org" />
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>邮件分类</label>
                <select id="composeCategory">
                  <option value="followup" ${initialCat === 'followup' ? 'selected' : ''}>患者随访计划 (Follow-up)</option>
                  <option value="research" ${initialCat === 'research' ? 'selected' : ''}>科研项目进展 (Research)</option>
                  <option value="general" ${initialCat === 'general' ? 'selected' : ''}>临床综合沟通 (General)</option>
                </select>
              </div>
              <div class="form-row">
                <label>发件人身份（站内专属工作信箱）</label>
                <input type="text" disabled value="${esc(currentUserEmail)}" class="disabled-input" title="发信将严格以此专属站内信箱对外发出，确保外部回复自动闭环流转入站" />
              </div>
            </div>

            <div class="form-row">
              <label>邮件主题 (Subject) *</label>
              <input type="text" id="composeSubject" required value="${esc(initial?.subject || '')}" placeholder="如：PT-BRONCHO-001 气道高密度栓塞第12周三维影像随访计划" />
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>关联患者代号 (可选)</label>
                <input type="text" id="composePtCode" value="${esc(initial?.patient_code || '')}" placeholder="如：PT-BRONCHO-001" />
              </div>
              <div class="form-row">
                <label>关联科研项目 (可选)</label>
                <input type="text" id="composeStudy" value="${esc(initial?.study_id || '')}" placeholder="如：DAPA-HF (NCT03036124)" />
              </div>
            </div>

            <div class="form-row">
              <label>正文内容 (Body) *</label>
              <textarea id="composeBody" rows="8" required placeholder="输入详细随访计划、影像复查指引、临床指标预警或科研推进通知…">${esc(initial?.body || '')}</textarea>
            </div>

            <!-- 附件管理与上传 -->
            <div class="form-row">
              <label>附件 (Attachments)</label>
              <div class="compose-attachments-bar">
                <input type="file" id="composeFileInput" multiple style="display:none;" />
                <button type="button" class="mail-btn ghost sm" id="btnComposeAddAttach">
                  ${icon('paperclip', { size: 13 })} 添加附件
                </button>
                <span class="compose-attach-hint">支持医学报告、PDF、CSV、DICOM 说明</span>
              </div>
              <div class="compose-attachments-preview" id="composeAttachPreview">
                ${renderAttachmentChips(composeAttachments, 'compose')}
              </div>
            </div>

            <div class="mail-modal-foot">
              <button type="button" class="mail-btn ghost" id="mailComposeCancel">取消</button>
              <button type="submit" class="mail-btn primary" id="mailComposeSubmit">发送邮件</button>
            </div>
          </form>
        </div>
      </div>
    `

    const scrim = $('mailComposeScrim')
    const close = () => { scrim?.remove() }
    $('mailComposeClose')?.addEventListener('click', close)
    $('mailComposeCancel')?.addEventListener('click', close)
    scrim?.addEventListener('click', e => { if (e.target === scrim) close() })

    // 附件添加与移除
    $('btnComposeAddAttach')?.addEventListener('click', () => {
      ($('composeFileInput') as HTMLInputElement | null)?.click()
    })

    $('composeFileInput')?.addEventListener('change', async (e: Event) => {
      const input = e.target as HTMLInputElement
      if (input.files && input.files.length > 0) {
        for (const file of Array.from(input.files)) {
          try {
            const base64 = await readFileAsBase64(file)
            composeAttachments.push({
              id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              name: file.name,
              size: file.size,
              mime: file.type || 'application/octet-stream',
              data_base64: base64,
            })
          } catch (err) {
            notice(`读取附件失败: ${file.name}`, true)
          }
        }
        input.value = ''
        const preview = $('composeAttachPreview')
        if (preview) {
          preview.innerHTML = renderAttachmentChips(composeAttachments, 'compose')
        }
      }
    })

    $('composeAttachPreview')?.addEventListener('click', (e: Event) => {
      const target = e.target as HTMLElement
      const removeBtn = target.closest<HTMLElement>('[data-remove-compose]')
      if (removeBtn) {
        const idx = parseInt(removeBtn.dataset.removeCompose!, 10)
        if (!isNaN(idx) && idx >= 0 && idx < composeAttachments.length) {
          composeAttachments.splice(idx, 1)
          const preview = $('composeAttachPreview')
          if (preview) {
            preview.innerHTML = renderAttachmentChips(composeAttachments, 'compose')
          }
        }
      }
    })

    const form = $('mailComposeForm') as HTMLFormElement
    form.onsubmit = async e => {
      e.preventDefault()
      const recipient = ($('composeTo') as HTMLInputElement).value.trim()
      const category = ($('composeCategory') as HTMLSelectElement).value as MailMessage['category']
      const subject = ($('composeSubject') as HTMLInputElement).value.trim()
      const patient_code = ($('composePtCode') as HTMLInputElement).value.trim() || undefined
      const study_id = ($('composeStudy') as HTMLInputElement).value.trim() || undefined
      const body = ($('composeBody') as HTMLTextAreaElement).value.trim()

      try {
        const res = await api<{ id?: string; delivery?: { status?: string; note?: string } }>('/api/mail/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient,
            category,
            subject,
            patient_code,
            study_id,
            thread_id: initial?.thread_id,
            in_reply_to: initial?.in_reply_to,
            body,
            attachments: composeAttachments.length > 0 ? composeAttachments : undefined,
          }),
        })

        if (res?.delivery?.status === 'external_sent') {
          notice('邮件已通过外网发信服务成功发出！')
        } else if (res?.delivery?.status === 'simulated') {
          notice('邮件已保存为已发送（本地模拟记录，未配置外网 SMTP）')
        } else if (res?.delivery?.status === 'failed') {
          notice('外网邮件发送失败：' + (res.delivery.note || '请检查 SMTP 配置'), true)
        } else {
          notice('邮件已成功投递！')
        }

        close()
        activeFolder = 'sent'
        updateFolderButtons()
        selectedMailId = res?.id || null
        await loadMessages()
      } catch (err) {
        notice((err as Error).message, true)
      }
    }
  }

  function updateFolderButtons(): void {
    const btnInbox = $('mailFolderInbox')
    const btnSent = $('mailFolderSent')
    const btnTrash = $('mailFolderTrash')
    btnInbox?.classList.toggle('on', activeFolder === 'inbox')
    btnSent?.classList.toggle('on', activeFolder === 'sent')
    btnTrash?.classList.toggle('on', activeFolder === 'trash')
  }

  // 绑定左侧栏交互按钮
  function initActionPills(): void {
    const fAll = $('mailFilterAll')
    const fUnread = $('mailFilterUnread')
    const fStarred = $('mailFilterStarred')
    const fFollowup = $('mailFilterFollowup')
    const fResearch = $('mailFilterResearch')
    const composeBtn = $('composeMailBtn')
    const btnInbox = $('mailFolderInbox')
    const btnSent = $('mailFolderSent')
    const btnTrash = $('mailFolderTrash')

    composeBtn?.addEventListener('click', () => showComposeModal())

    btnInbox?.addEventListener('click', () => {
      if (activeFolder !== 'inbox') {
        activeFolder = 'inbox'
        activeFilter = 'all'
        selectedMailId = null
        selectedIds.clear()
        currentPage = 1
        updateFolderButtons()
        updatePills('all')
        void loadMessages()
      }
    })

    btnSent?.addEventListener('click', () => {
      if (activeFolder !== 'sent') {
        activeFolder = 'sent'
        activeFilter = 'all'
        selectedMailId = null
        selectedIds.clear()
        currentPage = 1
        updateFolderButtons()
        updatePills('all')
        void loadMessages()
      }
    })

    btnTrash?.addEventListener('click', () => {
      if (activeFolder !== 'trash') {
        activeFolder = 'trash'
        activeFilter = 'all'
        selectedMailId = null
        selectedIds.clear()
        currentPage = 1
        updateFolderButtons()
        updatePills('all')
        void loadMessages()
      }
    })

    const updatePills = (active: typeof activeFilter) => {
      activeFilter = active
      currentPage = 1
      fAll?.classList.toggle('on', active === 'all')
      fUnread?.classList.toggle('on', active === 'unread')
      fStarred?.classList.toggle('on', active === 'starred')
      fFollowup?.classList.toggle('on', active === 'followup')
      fResearch?.classList.toggle('on', active === 'research')
      renderNavList()
      renderMain()
    }

    fAll?.addEventListener('click', () => updatePills('all'))
    fUnread?.addEventListener('click', () => updatePills('unread'))
    fStarred?.addEventListener('click', () => updatePills('starred'))
    fFollowup?.addEventListener('click', () => updatePills('followup'))
    fResearch?.addEventListener('click', () => updatePills('research'))

    $('docSearch')?.addEventListener('input', () => {
      if (!$('mailList')?.hidden) {
        currentPage = 1
        renderNavList()
        renderMain()
      }
    })

    // 左侧栏条目点击
    $('mailList')?.addEventListener('click', e => {
      const target = e.target as HTMLElement

      // 1. 刷新按钮
      const refreshBtn = target.closest<HTMLElement>('#mailRefreshSummaryBtn')
      if (refreshBtn) {
        e.stopPropagation()
        void loadSummary(true)
        return
      }

      // 2. 患者代号标签点击 -> 直达患者档案
      const ptPill = target.closest<HTMLElement>('.mail-briefing-pill, .mail-source-pt')
      if (ptPill) {
        e.stopPropagation()
        const code = ptPill.dataset.ptCode
        if (code && hooks.openPatient) {
          void hooks.openPatient(code)
        }
        return
      }

      // 3. 课题编号标签点击 -> 直达科研项目
      const stPill = target.closest<HTMLElement>('.mail-briefing-study-pill')
      if (stPill) {
        e.stopPropagation()
        const sid = stPill.dataset.studyId
        if (sid && hooks.openStudy) {
          void hooks.openStudy(sid)
        }
        return
      }

      // 4. 查看右侧全部邮件
      const viewAllBtn = target.closest<HTMLElement>('#mailBriefingViewAllBtn')
      if (viewAllBtn) {
        e.stopPropagation()
        selectedMailId = null
        mainViewMode = 'list'
        renderMain()
        return
      }

      // 5. 关联邮件来源项点击 -> 在右侧主视窗打开该邮件
      const sourceItem = target.closest<HTMLElement>('.mail-briefing-source-item')
      if (sourceItem) {
        const id = sourceItem.dataset.mailId
        if (id) {
          selectedMailId = id
          renderNavSummary()
          renderMain()
        }
        return
      }
    })
  }

  initActionPills()

  return {
    async enter(): Promise<void> {
      hooks.leaveDoc()
      await loadStatus()
      await Promise.all([
        loadMessages(),
        loadSummary(),
      ])
    },
    leave(): void {
      selectedMailId = null
    },
    async openMail(id: string): Promise<void> {
      selectedMailId = id
      await Promise.all([
        loadMessages(),
        loadSummary(),
      ])
    },
    async sendMail(mailData: Partial<MailMessage>): Promise<void> {
      await api('/api/mail/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mailData),
      })
      await Promise.all([
        loadMessages(),
        loadSummary(true),
      ])
    },
  }
}
