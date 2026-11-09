import type { Mailer } from '../auth/mailer.ts'
import type { Store } from '../store/db.ts'

/**
 * 运维告警：平台自己发现的故障发邮件给管理员（绑定了邮箱的 admin 账户），同一类告警一小时最多一封。
 * 目前覆盖：模型服务不可用（认证失败、余额不足——不会自己恢复）、短时间内大量回合失败、
 * PDF 解析服务（doc-parser）不可用（导入会悄悄退回 poppler，表格结构不可靠）。
 * 站点整体宕机由外部探测负责（见 docs/DEPLOY.md）。
 */
export type AlertKind = 'model_auth' | 'model_balance' | 'turn_failures' | 'doc_parser_down'

const SUBJECT: Record<AlertKind, string> = {
  model_auth: '模型服务认证失败（API key 无效）',
  model_balance: '模型服务余额不足',
  turn_failures: 'AI 回合大量失败',
  doc_parser_down: 'PDF 解析服务不可用（导入已退回 poppler，表格识别不可靠）',
}

export class Alerts {
  private readonly last = new Map<AlertKind, number>()
  private failures: number[] = []
  private docParserMisses = 0

  /**
   * 定时健康检查的结果：连续 N 次（默认 2）不就绪才告警，避开重启预热期间的短暂不可用；恢复后计数清零。
   * 返回本次是否触发了告警（供测试与日志）。
   */
  docParserHealth(ready: boolean, detail = ''): boolean {
    if (ready) { this.docParserMisses = 0; return false }
    this.docParserMisses++
    if (this.docParserMisses < (this.opts.docParserMissThreshold ?? 2)) return false
    void this.notify('doc_parser_down', `健康检查连续 ${this.docParserMisses} 次未就绪${detail ? `：${detail}` : ''}。期间上传的 PDF 都走 poppler 兜底，审稿会跳过依赖表格的核查。`)
    return true
  }

  /** 一次 PDF 导入实际退回了 poppler（服务已配置却未就绪或解析出错）：直接告警（受一小时冷却限制） */
  docParserFallback(reason: string): void {
    void this.notify('doc_parser_down', `一次 PDF 导入退回 poppler：${reason}`)
  }

  constructor(
    private readonly store: Store,
    private readonly mailer: Mailer,
    private readonly opts: { cooldownMs?: number; failureWindowMs?: number; failureThreshold?: number; docParserMissThreshold?: number; log?: (line: string) => void } = {},
  ) {}

  /** 一个回合失败了（message = 失败原因）：识别不会自愈的模型错误立即告警，其余计数，超过阈值告警。 */
  turnFailed(message: string): void {
    if (/Authentication Fails|api key[^\n]*invalid|invalid[^\n]*api key|401/i.test(message)) void this.notify('model_auth', message)
    else if (/insufficient|balance|402/i.test(message)) void this.notify('model_balance', message)
    const now = Date.now()
    const window = this.opts.failureWindowMs ?? 15 * 60_000
    this.failures = [...this.failures.filter(t => now - t < window), now]
    if (this.failures.length >= (this.opts.failureThreshold ?? 5)) void this.notify('turn_failures', `${Math.round(window / 60_000)} 分钟内 ${this.failures.length} 个回合失败。最近一次：${message}`)
  }

  async notify(kind: AlertKind, detail: string): Promise<'sent' | 'cooldown' | 'no_recipient'> {
    const now = Date.now()
    if (now - (this.last.get(kind) ?? 0) < (this.opts.cooldownMs ?? 3600_000)) return 'cooldown'
    this.last.set(kind, now)
    const log = this.opts.log ?? (line => console.error(line))
    log(`[告警] ${SUBJECT[kind]}：${detail.slice(0, 300)}`)
    const to = this.store.listUsers().filter(u => u.role === 'admin' && u.status === 'active' && u.email).map(u => u.email!)
    if (to.length === 0 || !this.mailer.configured) return 'no_recipient'
    for (const addr of to) {
      try {
        await this.mailer.send(addr, `[Heurion 告警] ${SUBJECT[kind]}`, `${SUBJECT[kind]}\n\n${detail.slice(0, 1500)}\n\n时间：${new Date(now).toISOString()}\n同类告警一小时内不再重复发送。`)
      } catch (err) {
        log(`[告警] 发邮件给 ${addr} 失败：${(err as Error).message}`)
      }
    }
    return 'sent'
  }
}
