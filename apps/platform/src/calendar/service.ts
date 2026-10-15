import type { Store, CalendarEventRow } from '../store/db.ts'
import type { MailService } from '../mail/service.ts'

export interface CreateEventInput {
  userId: string
  tenantId?: string | null
  title: string
  description?: string | null
  startTime: string
  endTime: string
  allDay?: boolean
  category: 'followup' | 'research' | 'meeting' | 'general'
  patientId?: string | null
  patientCode?: string | null
  studyId?: string | null
  studyTitle?: string | null
  location?: string | null
  sendEmail?: boolean
  username?: string
}

export class CalendarService {
  constructor(
    private readonly store: Store,
    private readonly mailService?: MailService
  ) {}

  /** 获取日历事件列表（支持时间范围、分类、状态与搜索过滤） */
  list(userId: string, opts?: { from?: string; to?: string; category?: string; status?: string; search?: string; username?: string }): CalendarEventRow[] {
    return this.store.listCalendarEvents(userId, opts)
  }

  /** 获取单个日历事件 */
  get(userId: string, id: string): CalendarEventRow | undefined {
    return this.store.getCalendarEvent(userId, id)
  }

  /** 创建日历事件 */
  create(input: CreateEventInput): CalendarEventRow {
    const event = this.store.createCalendarEvent({
      user_id: input.userId,
      tenant_id: input.tenantId ?? null,
      title: input.title,
      description: input.description ?? null,
      start_time: input.startTime,
      end_time: input.endTime,
      all_day: input.allDay ? 1 : 0,
      category: input.category,
      status: 'scheduled',
      patient_id: input.patientId ?? null,
      patient_code: input.patientCode ?? null,
      study_id: input.studyId ?? null,
      study_title: input.studyTitle ?? null,
      location: input.location ?? null,
      mail_id: null,
    })

    // 可选联动：创建事件的同时分发一封对应的通知邮件
    if (input.sendEmail && this.mailService && input.username) {
      const email = this.mailService.userEmail(input.username)
      const mailCategory = input.category === 'followup' ? 'followup' : input.category === 'research' ? 'research' : 'notification'
      const mail = this.mailService.send({
        userId: input.userId,
        recipientUserId: input.userId,
        tenantId: input.tenantId,
        sender: input.category === 'followup' ? 'followup@heurion.org' : 'research@heurion.org',
        senderName: input.category === 'followup' ? 'Heurion 智能随访中心' : 'Heurion 科研协同办公室',
        recipient: email,
        subject: `【日程提醒】${input.title}`,
        category: mailCategory,
        patientId: input.patientId,
        patientCode: input.patientCode,
        studyId: input.studyId,
        studyTitle: input.studyTitle,
        calendarEventId: event.id,
        folder: 'inbox',
        body: `### 日程排期已确认\n\n- **日程主题**：${input.title}\n- **预约时间**：${input.startTime} ~ ${input.endTime}\n- **地点/形式**：${input.location || '线上 / 专科诊室'}\n${input.patientCode ? `- **关联患者**：\`${input.patientCode}\`\n` : ''}${input.studyTitle ? `- **关联课题**：${input.studyTitle}\n` : ''}\n**日程说明**：\n${input.description || '无具体说明'}\n\n该事项已同步保存在您的个人工作日历中。`,
      })
      this.store.updateCalendarEvent(input.userId, event.id, { mail_id: mail.id })
    }

    return event
  }

  /** 更新日历事件 */
  update(userId: string, id: string, patch: Partial<CalendarEventRow>): CalendarEventRow | undefined {
    return this.store.updateCalendarEvent(userId, id, patch)
  }

  /** 删除日历事件 */
  delete(userId: string, id: string): void {
    this.store.deleteCalendarEvent(userId, id)
  }

  /** 批量更新日程状态 (scheduled / completed) */
  batchUpdateStatus(userId: string, ids: string[], status: 'scheduled' | 'completed'): void {
    this.store.batchUpdateCalendarStatus(userId, ids, status)
  }

  /** 批量删除日程事件 */
  batchDelete(userId: string, ids: string[]): void {
    this.store.batchDeleteCalendarEvents(userId, ids)
  }
}
