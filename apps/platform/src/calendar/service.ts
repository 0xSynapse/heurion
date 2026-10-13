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
    if (opts?.username) {
      this.ensureSeed(userId, opts.username)
    }
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

  /** 首次访问用户初始化种子日程 */
  private ensureSeed(userId: string, username: string): void {
    const existing = this.store.listCalendarEvents(userId)
    if (existing.length > 0) return

    // 基于当前日期动态安排未来几天的合理日程
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = now.getDate()

    // 辅助格式化时间
    const dateStr = (offsetDays: number, hour: number, minute: number) => {
      const target = new Date(now.getTime() + offsetDays * 86400000)
      const yy = target.getFullYear()
      const mm = String(target.getMonth() + 1).padStart(2, '0')
      const dd = String(target.getDate()).padStart(2, '0')
      const hh = String(hour).padStart(2, '0')
      const min = String(minute).padStart(2, '0')
      return `${yy}-${mm}-${dd} ${hh}:${min}`
    }

    const seedEvents: Array<Omit<CalendarEventRow, 'id' | 'created_at' | 'updated_at'>> = [
      {
        user_id: userId,
        tenant_id: null,
        title: '【随访】PT-BRONCHO-001 气道CT与高密度粘液栓复查',
        description: '变应性支气管肺曲霉病规律服药 12 周随访，进行薄层 HRCT 3D 容积对比，评估 BAR 与粘液栓吸收率，复查总 IgE。',
        start_time: dateStr(1, 9, 30),
        end_time: dateStr(1, 10, 30),
        all_day: 0,
        category: 'followup',
        status: 'scheduled',
        patient_id: 'PT-BRONCHO-001',
        patient_code: 'PT-BRONCHO-001',
        study_id: null,
        study_title: null,
        location: '门诊二楼呼吸专科 3 诊室 / CT 3 号机房',
        mail_id: null,
      },
      {
        user_id: userId,
        tenant_id: null,
        title: '【科研】DAPA-HF 课题入组质控与 PSM 平衡评审会',
        description: 'DAPA-HF 里程碑前瞻性队列研究 (NCT03036124) 第 3 阶段数据质控评审，审定 1:1 PSM 匹配后 18 项协变量平衡及 Table 1 三线表。',
        start_time: dateStr(2, 14, 0),
        end_time: dateStr(2, 16, 0),
        all_day: 0,
        category: 'research',
        status: 'scheduled',
        patient_id: null,
        patient_code: null,
        study_id: 'DAPA-HF-RCT-2019',
        study_title: 'DAPA-HF 达格列净心衰里程碑前瞻性队列研究 (NCT03036124)',
        location: '医院第二学术报告厅 / 线上腾讯会议',
        mail_id: null,
      },
      {
        user_id: userId,
        tenant_id: null,
        title: '【随访】PT-NSCLC-002 奥希替尼靶向 RECIST 1.1 疗效评估',
        description: '右上肺腺癌靶向治疗第 8 周疗效访视，胸部增强 CT 靶病灶长径和测量与液体活检耐药突变监测。',
        start_time: dateStr(4, 14, 0),
        end_time: dateStr(4, 15, 0),
        all_day: 0,
        category: 'followup',
        status: 'scheduled',
        patient_id: 'PT-NSCLC-002',
        patient_code: 'PT-NSCLC-002',
        study_id: null,
        study_title: null,
        location: '胸部肿瘤科门诊 5 诊室',
        mail_id: null,
      },
      {
        user_id: userId,
        tenant_id: null,
        title: '【科研】DSMB 独立数据监查委员会中期审查闭门会议',
        description: '审议 4,744 例大样本随机对照队列的心血管死亡与心衰恶化复合事件盲态裁定与预设亚组同质性检验。',
        start_time: dateStr(6, 19, 0),
        end_time: dateStr(6, 21, 0),
        all_day: 0,
        category: 'research',
        status: 'scheduled',
        patient_id: null,
        patient_code: null,
        study_id: 'DAPA-HF-RCT-2019',
        study_title: 'DAPA-HF 达格列净心衰里程碑前瞻性队列研究 (NCT03036124)',
        location: '国际远程多中心加密视频会议系统',
        mail_id: null,
      },
      {
        user_id: userId,
        tenant_id: null,
        title: '【随访】PT-SARCO-003 营养支持与化疗耐受评估（低 SMI）',
        description: '复测 L3 SMI 骨骼肌指数，评估握力变化及化疗血液学毒副反应风险。',
        start_time: dateStr(3, 10, 0),
        end_time: dateStr(3, 11, 0),
        all_day: 0,
        category: 'followup',
        status: 'scheduled',
        patient_id: 'PT-SARCO-003',
        patient_code: 'PT-SARCO-003',
        study_id: null,
        study_title: null,
        location: '肿瘤营养与药学联合门诊',
        mail_id: null,
      },
    ]

    for (const item of seedEvents) {
      this.store.createCalendarEvent(item)
    }
  }
}
