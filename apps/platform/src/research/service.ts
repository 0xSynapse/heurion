import { randomUUID } from 'node:crypto'
import type { DatasetService } from '../datasets/service.ts'
import type { Store, StudyRole, StudyRow } from '../store/db.ts'
import { allows, type Access, type Level } from './access.ts'
import { calculateSampleSize, type SampleSizeInput, type SampleSizeResult } from './sample-size.ts'

/** 研究的计划样本量：只保存计算参数，结果由服务端重新计算（客户端不能直接写入一个样本量数字） */
export interface SampleSizePlan {
  input: SampleSizeInput
  result: Pick<SampleSizeResult, 'design' | 'groups' | 'total' | 'total_with_dropout' | 'events_required' | 'method' | 'methods_text_zh' | 'methods_text_en'>
  saved_at: string
  saved_by: string
}

export function parseSampleSizePlan(raw: string | null | undefined): SampleSizePlan | null {
  if (!raw) return null
  try { return JSON.parse(raw) as SampleSizePlan } catch { return null }
}

/**
 * 临床研究项目：把研究方案、数据集、分析、稿件放在一起。
 * - 文档（方案 / 论文 / 幻灯片）与数据集经「归入」进研究，各自只属于一个研究；归入研究的文档不出现在写作的文档列表里（docs.context）。
 * - 分析不用手工维护：用这个研究的数据集画出来的图（带分析来源的资产）自动汇总。
 * - 删除研究：里面的文档一起进回收站（可恢复），数据集仍在「全部数据集」里。
 * - 研究团队（docs/design/TEAM.md）：负责人 + 同机构成员（editor 可改、viewer 只读）；研究里的文档、数据集、分析按成员角色共享，
 *   访问判定统一在 access.ts。负责人可加 / 移成员、改角色、转交；成员可退出；机构管理员可做离职交接（只换负责人，不给自己读权限）。
 * 入组患者（从患者库按条件筛选）见 cohort.ts：入组关系在机构的患者库里，不进 study_items。
 */

export const DESIGNS: Record<NonNullable<StudyRow['design']>, string> = {
  retrospective_cohort: '回顾性队列', prospective_cohort: '前瞻性队列', rct: '随机对照试验', case_control: '病例对照', cross_sectional: '横断面', other: '其他',
}
export const STATUSES: Record<StudyRow['status'], string> = { planning: '筹备中', ongoing: '进行中', completed: '已完成' }
export const DOC_ROLES: Record<string, string> = { protocol: '研究方案', manuscript: '论文', slides: '幻灯片', other: '其他文档' }

export type LabRuleOp = '=' | '>' | '>=' | '<' | '<=' | 'between'
export type LabRuleMode = 'latest' | 'any' | 'baseline' | 'min' | 'max' | 'count'
export type ImagingMetricKey =
  | 'signoff_count'
  | 'lesion_diameter_mm'
  | 'lesion_volume_cm3'
  | 'l3_smi'
  | 'vat_to_sat_ratio'
  | 'bar_ratio'
  | 'ham_volume_cm3'

export type RulePredicate =
  | { kind: 'demographics'; min_age?: number; max_age?: number; sex?: 'M' | 'F' }
  | { kind: 'tags'; mode: 'all' | 'any' | 'none'; tags: string[] }
  | {
      kind: 'lab'
      name: string
      op: LabRuleOp
      value: number
      value_to?: number
      mode?: LabRuleMode
      since?: string
      until?: string
      change?: { type: 'abs_drop' | 'pct_drop' | 'abs_rise' | 'pct_rise'; min_delta: number; within_days?: number }
    }
  | {
      kind: 'imaging'
      metric: ImagingMetricKey
      op: '>' | '>=' | '<' | '<=' | '='
      value: number
      min_followups?: number
    }
  | {
      kind: 'record'
      record_kind?: 'pathology' | 'discharge' | 'imaging' | 'lab_report' | 'note' | 'any'
      keyword?: string
      mode?: 'present' | 'absent'
    }
  | { kind: 'manual'; label: string }

export interface EligibilityRule {
  id: string
  type: 'inclusion' | 'exclusion'
  title: string
  source_clause?: string
  enabled: boolean
  requires_manual_confirm?: boolean
  predicate: RulePredicate
}

export interface ScreeningFunnelSnapshot {
  assessed_total: number
  inclusion_passed: number
  excluded_total: number
  exclusions_by_rule: Array<{
    rule_id: string
    title: string
    kind: 'inclusion_failed' | 'exclusion_matched'
    count: number
  }>
  eligible_total: number
  updated_at: string
}

export interface EligibilityProtocol {
  version: number
  template_id?: string | null
  source_doc_id?: string | null
  extracted_at?: string | null
  inclusion_rules: EligibilityRule[]
  exclusion_rules: EligibilityRule[]
  last_funnel?: ScreeningFunnelSnapshot | null
}

export interface CustomVarDef {
  id?: string
  key: string
  label: string
  group?: 'demographics' | 'baseline_labs' | 'imaging' | 'treatment' | 'outcomes' | 'custom'
  kind: 'continuous' | 'categorical' | 'binary' | 'date' | 'text'
  type?: 'continuous' | 'categorical' | 'binary' | 'date' | 'text'
  unit?: string
  options?: string[]
  value_labels?: Record<string, string>
}

export const ELIGIBILITY_TEMPLATES: Array<{
  id: string
  name: string
  description: string
  inclusion_rules: Omit<EligibilityRule, 'id'>[]
  exclusion_rules: Omit<EligibilityRule, 'id'>[]
}> = [
  {
    id: 'oncology_solid_tumor',
    name: '实体瘤临床研究标准模板',
    description: '适用于肺癌、肝癌、结直肠癌等实体瘤回顾性/前瞻性队列与临床试验',
    inclusion_rules: [
      {
        type: 'inclusion',
        title: '年龄 18–75 周岁',
        enabled: true,
        predicate: { kind: 'demographics', min_age: 18, max_age: 75 },
      },
      {
        type: 'inclusion',
        title: '经组织学或病理学确诊恶性肿瘤病历记录',
        enabled: true,
        predicate: { kind: 'record', record_kind: 'pathology', keyword: '癌', mode: 'present' },
      },
      {
        type: 'inclusion',
        title: '具备至少 1 次已定稿基线影像学可测量病灶评估',
        enabled: true,
        predicate: { kind: 'imaging', metric: 'signoff_count', op: '>=', value: 1 },
      },
    ],
    exclusion_rules: [
      {
        type: 'exclusion',
        title: '严重肾功能不全（血肌酐 > 180 μmol/L）',
        enabled: true,
        predicate: { kind: 'lab', name: '肌酐', op: '>', value: 180, mode: 'latest' },
      },
      {
        type: 'exclusion',
        title: '严重肝功能异常（ALT > 120 U/L）',
        enabled: true,
        predicate: { kind: 'lab', name: 'ALT', op: '>', value: 120, mode: 'latest' },
      },
      {
        type: 'exclusion',
        title: '合并其他活动性恶性肿瘤或妊娠状态（人工复核）',
        enabled: true,
        requires_manual_confirm: true,
        predicate: { kind: 'manual', label: '合并其他活动性恶性肿瘤或妊娠状态' },
      },
    ],
  },
  {
    id: 'metabolic_chronic_disease',
    name: '代谢与慢病管理队列模板',
    description: '适用于糖尿病、高血压、慢性肾病及体成分（肌少症/内脏肥胖）队列研究',
    inclusion_rules: [
      {
        type: 'inclusion',
        title: '年龄 ≥ 18 周岁',
        enabled: true,
        predicate: { kind: 'demographics', min_age: 18 },
      },
      {
        type: 'inclusion',
        title: '确诊 2型糖尿病 或 高血压',
        enabled: true,
        predicate: { kind: 'tags', mode: 'any', tags: ['2型糖尿病', '糖尿病', '高血压'] },
      },
      {
        type: 'inclusion',
        title: '基线或最新 HbA1c ≥ 6.5%',
        enabled: true,
        predicate: { kind: 'lab', name: 'HbA1c', op: '>=', value: 6.5, mode: 'latest' },
      },
    ],
    exclusion_rules: [
      {
        type: 'exclusion',
        title: '终末期肾病（eGFR < 15 mL/min/1.73m²）',
        enabled: true,
        predicate: { kind: 'lab', name: 'eGFR', op: '<', value: 15, mode: 'latest' },
      },
      {
        type: 'exclusion',
        title: '合并恶性肿瘤病史',
        enabled: true,
        predicate: { kind: 'tags', mode: 'any', tags: ['恶性肿瘤'] },
      },
    ],
  },
  {
    id: 'radiomics_body_comp',
    name: '影像组学与体成分纵向随访模板',
    description: '适用于 CT/MRI 靶病灶演变、L3 骨骼肌指数 (SMI) 与疗效评估研究',
    inclusion_rules: [
      {
        type: 'inclusion',
        title: '年龄 18–80 周岁',
        enabled: true,
        predicate: { kind: 'demographics', min_age: 18, max_age: 80 },
      },
      {
        type: 'inclusion',
        title: '完成至少 1 次定稿影像学评估',
        enabled: true,
        predicate: { kind: 'imaging', metric: 'signoff_count', op: '>=', value: 1 },
      },
    ],
    exclusion_rules: [
      {
        type: 'exclusion',
        title: '影像伪影严重或关键临床结局缺失（人工复核）',
        enabled: true,
        requires_manual_confirm: true,
        predicate: { kind: 'manual', label: '影像伪影严重或关键临床结局缺失' },
      },
    ],
  },
]

export class StudyError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message) }
}

export const ROLE_LABELS: Record<StudyRole, string> = {
  owner: '主要研究者 (PI / 负责人)',
  sub_i: '共同研究者 (Sub-I)',
  cra: '临床监查员 (CRA，监查只读)',
  crc: '临床协调员 (CRC)',
  statistician: '生物统计师',
  data_manager: '数据管理员 (DM)',
  radiologist: '放射/影像评估员',
  auditor: '质控/稽查员 (Auditor，只读)',
  editor: '通用可编辑',
  viewer: '通用只读',
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export function parseEligibilityPlan(raw: string | null | undefined): EligibilityProtocol | null {
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as Partial<EligibilityProtocol>
    if (!obj || typeof obj !== 'object') return null
    return {
      version: typeof obj.version === 'number' ? obj.version : 1,
      template_id: obj.template_id ?? null,
      source_doc_id: obj.source_doc_id ?? null,
      extracted_at: obj.extracted_at ?? null,
      inclusion_rules: Array.isArray(obj.inclusion_rules) ? obj.inclusion_rules : [],
      exclusion_rules: Array.isArray(obj.exclusion_rules) ? obj.exclusion_rules : [],
      last_funnel: obj.last_funnel ?? null,
    }
  } catch {
    return null
  }
}

export function parseCustomVars(raw: string | null | undefined): CustomVarDef[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((v): v is CustomVarDef => Boolean(v && typeof v === 'object' && typeof v.key === 'string' && typeof v.label === 'string'))
  } catch {
    return []
  }
}

export class StudyService {
  /** 删除研究时的回调（清掉患者库里的入组关系，见 cohort.ts） */
  onRemove: ((owner: string, id: string) => void) | null = null

  constructor(private readonly store: Store, private readonly datasets?: DatasetService, private readonly access?: Access) {}

  /** 研究本身（成员才看得到；level 不够时 403）。 */
  get(user: string, id: string, level: Level = 'read'): StudyRow { return this.own(user, id, level) }

  /** 我在研究里的角色（不是成员为 null） */
  role(user: string, id: string): StudyRole | null { return this.store.studyRole(id, user) }

  private own(user: string, id: string, level: Level = 'read'): StudyRow {
    const s = this.store.getStudy(id)
    const role = s ? this.store.studyRole(id, user) : null
    if (!s || !role) throw new StudyError('not_found', '研究不存在', 404)
    if (!allows(role, level)) throw new StudyError('forbidden', level === 'manage' ? '只有研究负责人能做这件事' : '你在这个研究里是只读成员', 403)
    return s
  }

  private name = (id: string) => this.store.getUser(id)?.display_name ?? id

  list(user: string) {
    return this.store.listStudies(user).map(s => {
      const items = this.store.studyItems(s.id)
      return {
        ...s,
        eligibility_plan: parseEligibilityPlan(s.eligibility_plan),
        custom_vars: parseCustomVars(s.custom_vars),
        sample_size_plan: parseSampleSizePlan(s.sample_size_plan),
        my_role: s.my_role, shared: s.owner !== user, shared_by: s.owner !== user ? this.name(s.owner) : null,
        members: this.store.studyMembers(s.id).length,
        docs: items.filter(i => i.kind === 'doc').length, datasets: items.filter(i => i.kind === 'dataset').length,
      }
    })
  }

  // —— 成员 ——

  members(user: string, id: string) {
    this.own(user, id)
    return this.store.studyMembers(id).map(m => ({ user_id: m.user_id, name: this.name(m.user_id), role: m.role, role_label: ROLE_LABELS[m.role], added_at: m.added_at, me: m.user_id === user }))
  }

  /** 可以加进研究的人：与研究同机构、在用、还不是成员（负责人加人时选） */
  candidates(user: string, id: string) {
    const s = this.own(user, id, 'manage')
    if (!s.tenant_id) return []
    const cur = new Set(this.store.studyMembers(id).map(m => m.user_id))
    return this.store.listUsers().filter(u => u.tenant_id === s.tenant_id && u.status === 'active' && !cur.has(u.id))
      .map(u => ({ user_id: u.id, name: u.display_name, username: u.username }))
  }

  private sameTenant(s: StudyRow, userId: unknown) {
    const u = typeof userId === 'string' ? this.store.getUser(userId) : undefined
    if (!u || u.status !== 'active' || !s.tenant_id || u.tenant_id !== s.tenant_id) throw new StudyError('bad_member', '只能加本机构在用的成员', 400)
    return u
  }

  addMember(user: string, id: string, input: { user_id?: unknown; role?: unknown }) {
    const s = this.own(user, id, 'manage')
    const u = this.sameTenant(s, input.user_id)
    const allowed: StudyRole[] = ['sub_i', 'cra', 'crc', 'statistician', 'data_manager', 'radiologist', 'auditor', 'editor', 'viewer']
    const role: StudyRole = typeof input.role === 'string' && allowed.includes(input.role as StudyRole) ? (input.role as StudyRole) : 'editor'
    if (this.store.studyRole(id, u.id) === 'owner') throw new StudyError('bad_member', '负责人不能改成别的角色，先转交', 409)
    this.store.setStudyMember({ study_id: id, user_id: u.id, role, added_by: user })
    this.access?.invalidate()
    return this.members(user, id)
  }

  setRole(user: string, id: string, target: string, roleIn: unknown) {
    this.own(user, id, 'manage')
    const cur = this.store.studyRole(id, target)
    if (!cur) throw new StudyError('not_found', '研究里没有这位成员', 404)
    if (cur === 'owner') throw new StudyError('bad_member', '负责人不能改成别的角色，先转交', 409)
    const allowed: StudyRole[] = ['sub_i', 'cra', 'crc', 'statistician', 'data_manager', 'radiologist', 'auditor', 'editor', 'viewer']
    if (!allowed.includes(roleIn as StudyRole)) throw new StudyError('bad_role', '角色不合法')
    this.store.setStudyMember({ study_id: id, user_id: target, role: roleIn as StudyRole, added_by: user })
    this.access?.invalidate()
    return this.members(user, id)
  }

  /** 移出成员（负责人）；成员自己退出用 leave */
  removeMember(user: string, id: string, target: string) {
    if (target === user) return this.leave(user, id)
    this.own(user, id, 'manage')
    if (this.store.studyRole(id, target) === 'owner') throw new StudyError('bad_member', '负责人不能被移出，先转交', 409)
    if (!this.store.removeStudyMember(id, target)) throw new StudyError('not_found', '研究里没有这位成员', 404)
    this.access?.invalidate()
    return this.members(user, id)
  }

  leave(user: string, id: string): { left: true } {
    this.own(user, id)
    if (this.store.studyRole(id, user) === 'owner') throw new StudyError('owner_cannot_leave', '负责人不能直接退出：先把研究转交给别人', 409)
    this.store.removeStudyMember(id, user)
    this.access?.invalidate()
    return { left: true }
  }

  /** 负责人转交（新负责人须同机构；原负责人留作可编辑成员） */
  transfer(user: string, id: string, to: unknown) {
    const s = this.own(user, id, 'manage')
    const u = this.sameTenant(s, to)
    if (u.id === user) return this.members(user, id)
    this.store.transferStudy(id, u.id, user, true)
    this.access?.invalidate()
    return this.members(user, id)
  }

  /** 机构管理员看到的本机构研究（只有标题、负责人、成员数——用于离职交接，不含内容） */
  tenantStudies(admin: string) {
    const a = this.store.getUser(admin)
    if (!a?.tenant_id || a.tenant_role !== 'admin') throw new StudyError('forbidden', '只有机构管理员能做交接', 403)
    return this.store.listTenantStudies(a.tenant_id).map(s => ({ study_id: s.id, title: s.title, owner: s.owner, owner_name: this.name(s.owner), members: this.store.studyMembers(s.id).length, updated_at: s.updated_at }))
  }

  /** 离职交接（机构管理员）：把研究负责人换成本机构的另一位成员；原负责人移出。管理员自己不因此成为成员。 */
  handover(admin: string, id: string, to: unknown) {
    const a = this.store.getUser(admin)
    const s = this.store.getStudy(id)
    if (!a?.tenant_id || a.tenant_role !== 'admin' || !s || s.tenant_id !== a.tenant_id) throw new StudyError('not_found', '研究不存在', 404)
    const u = this.sameTenant(s, to)
    const from = s.owner
    if (u.id !== from) this.store.transferStudy(id, u.id, admin, false)
    this.access?.invalidate()
    return { study_id: id, from, to: u.id }
  }

  create(owner: string, input: { title?: unknown; design?: unknown; status?: unknown; summary?: unknown }): StudyRow {
    const title = clean(input.title, 120)
    if (!title) throw new StudyError('bad_title', '研究名称不能为空')
    return this.store.addStudy({ owner, title, design: design(input.design), status: status(input.status) ?? 'planning', summary: clean(input.summary, 4000) || null })
  }

  update(owner: string, id: string, patch: {
    title?: unknown
    design?: unknown
    status?: unknown
    summary?: unknown
    eligibility_plan?: unknown
    custom_vars?: unknown
    sample_size_plan?: unknown
  }) {
    const cur = this.own(owner, id, 'write')
    const next: Parameters<Store['updateStudy']>[1] = {}
    if (patch.title !== undefined) { const t = clean(patch.title, 120); if (!t) throw new StudyError('bad_title', '研究名称不能为空'); next.title = t }
    if (patch.design !== undefined) next.design = design(patch.design)
    if (patch.status !== undefined) { const st = status(patch.status); if (!st) throw new StudyError('bad_status', '状态只能是 planning / ongoing / completed'); next.status = st }
    if (patch.summary !== undefined) next.summary = clean(patch.summary, 4000) || null
    if (patch.eligibility_plan !== undefined) {
      if (patch.eligibility_plan === null) {
        next.eligibility_plan = null
      } else if (typeof patch.eligibility_plan === 'object') {
        const existing = parseEligibilityPlan(cur.eligibility_plan)
        const incoming = patch.eligibility_plan as Partial<EligibilityProtocol>
        const normalized: EligibilityProtocol = {
          version: typeof incoming.version === 'number' ? incoming.version : (existing?.version ?? 0) + 1,
          template_id: incoming.template_id !== undefined ? incoming.template_id : (existing?.template_id ?? null),
          source_doc_id: incoming.source_doc_id !== undefined ? incoming.source_doc_id : (existing?.source_doc_id ?? null),
          extracted_at: incoming.extracted_at !== undefined ? incoming.extracted_at : (existing?.extracted_at ?? null),
          inclusion_rules: Array.isArray(incoming.inclusion_rules) ? sanitizeRules(incoming.inclusion_rules, 'inclusion') : (existing?.inclusion_rules ?? []),
          exclusion_rules: Array.isArray(incoming.exclusion_rules) ? sanitizeRules(incoming.exclusion_rules, 'exclusion') : (existing?.exclusion_rules ?? []),
          last_funnel: incoming.last_funnel !== undefined ? incoming.last_funnel : (existing?.last_funnel ?? null),
        }
        next.eligibility_plan = JSON.stringify(normalized)
      }
    }
    if (patch.custom_vars !== undefined) {
      if (patch.custom_vars === null) {
        next.custom_vars = null
      } else if (Array.isArray(patch.custom_vars)) {
        const sanitized = sanitizeCustomVars(patch.custom_vars)
        next.custom_vars = JSON.stringify(sanitized)
      }
    }
    if (patch.sample_size_plan !== undefined) {
      if (patch.sample_size_plan === null) {
        next.sample_size_plan = null
      } else {
        // 只接受计算参数 { input }；按参数重新计算，计算失败（缺参数 / 非法）直接报错
        const input = (patch.sample_size_plan as { input?: unknown })?.input
        if (!input || typeof input !== 'object') throw new StudyError('bad_sample_size', '计划样本量需提供计算参数 input')
        let r: SampleSizeResult
        try { r = calculateSampleSize(input as SampleSizeInput) } catch (e) { throw new StudyError('bad_sample_size', (e as Error).message) }
        const plan: SampleSizePlan = {
          input: input as SampleSizeInput,
          result: {
            design: r.design, groups: r.groups, total: r.total, total_with_dropout: r.total_with_dropout,
            ...(r.events_required !== undefined ? { events_required: r.events_required } : {}),
            method: r.method, methods_text_zh: r.methods_text_zh, methods_text_en: r.methods_text_en,
          },
          saved_at: new Date().toISOString(),
          saved_by: this.name(owner),
        }
        next.sample_size_plan = JSON.stringify(plan)
      }
    }
    this.store.updateStudy(id, next)
    // 研究改名：归入文档的归属标签跟着更新
    if (next.title) for (const i of this.store.studyItems(id).filter(i => i.kind === 'doc')) this.store.setDocContext(i.ref_id, { kind: 'study', study_id: id, title: next.title, role: i.role })
    const updated = this.store.getStudy(id)!
    return {
      ...updated,
      eligibility_plan: parseEligibilityPlan(updated.eligibility_plan),
      custom_vars: parseCustomVars(updated.custom_vars),
      sample_size_plan: parseSampleSizePlan(updated.sample_size_plan),
    }
  }

  /** 保存最近一次筛选漏斗快照到研究的 eligibility_plan */
  saveScreeningFunnel(user: string, id: string, funnel: ScreeningFunnelSnapshot, fallbackRules?: { inclusion_rules?: EligibilityRule[]; exclusion_rules?: EligibilityRule[] }): EligibilityProtocol {
    const s = this.own(user, id, 'read')
    const cur = parseEligibilityPlan(s.eligibility_plan) ?? {
      version: 1,
      inclusion_rules: fallbackRules?.inclusion_rules ?? [],
      exclusion_rules: fallbackRules?.exclusion_rules ?? [],
    }
    const next: EligibilityProtocol = {
      ...cur,
      inclusion_rules: fallbackRules?.inclusion_rules && fallbackRules.inclusion_rules.length > 0 ? fallbackRules.inclusion_rules : cur.inclusion_rules,
      exclusion_rules: fallbackRules?.exclusion_rules && fallbackRules.exclusion_rules.length > 0 ? fallbackRules.exclusion_rules : cur.exclusion_rules,
      last_funnel: funnel,
    }
    this.store.updateStudy(id, { eligibility_plan: JSON.stringify(next) })
    return next
  }

  /**
   * 从研究方案文档（role='protocol'）或研究简介/传入文本中智能提取结构化纳入与排除标准（EligibilityProtocol）。
   */
  extractEligibilityFromProtocol(
    user: string,
    id: string,
    opts?: { protocol_text?: string; doc_id?: string; template_id?: string; save?: boolean },
  ): {
    eligibility_plan: EligibilityProtocol
    extracted_count: number
    extracted_custom_vars: CustomVarDef[]
    recommended_design: StudyRow['design']
    source_summary: string
    templates: typeof ELIGIBILITY_TEMPLATES
  } {
    const s = this.own(user, id, opts?.save === false ? 'read' : 'write')
    const existing = parseEligibilityPlan(s.eligibility_plan)

    if (opts?.template_id) {
      const tpl = ELIGIBILITY_TEMPLATES.find(t => t.id === opts.template_id)
      if (!tpl) throw new StudyError('bad_template', '未找到对应的专科纳排模板', 404)
      const plan: EligibilityProtocol = {
        version: (existing?.version ?? 0) + 1,
        template_id: tpl.id,
        source_doc_id: existing?.source_doc_id ?? null,
        extracted_at: new Date().toISOString(),
        inclusion_rules: tpl.inclusion_rules.map((r, idx) => ({ ...r, id: `inc_tpl_${idx + 1}` })),
        exclusion_rules: tpl.exclusion_rules.map((r, idx) => ({ ...r, id: `exc_tpl_${idx + 1}` })),
        last_funnel: existing?.last_funnel ?? null,
      }
      if (opts?.save !== false) {
        this.store.updateStudy(id, { eligibility_plan: JSON.stringify(plan) })
      }
      return {
        eligibility_plan: plan,
        extracted_count: plan.inclusion_rules.length + plan.exclusion_rules.length,
        extracted_custom_vars: [],
        recommended_design: s.design,
        source_summary: `专科模板：${tpl.name}`,
        templates: ELIGIBILITY_TEMPLATES,
      }
    }

    let rawText = typeof opts?.protocol_text === 'string' ? opts.protocol_text.trim() : ''
    let sourceDocId: string | null = null
    let sourceSummary = '研究简介与标题'

    if (!rawText) {
      const items = this.store.studyItems(id).filter(i => i.kind === 'doc')
      const targetItem = opts?.doc_id
        ? items.find(i => i.ref_id === opts.doc_id)
        : (items.find(i => i.role === 'protocol') ?? items[0])
      if (targetItem) {
        const docRow = this.store.getDoc(targetItem.ref_id)
        const docBody = this.readDocPlainText(targetItem.ref_id)
        if (docBody.trim()) {
          rawText = docBody.trim()
          sourceDocId = targetItem.ref_id
          sourceSummary = `研究文档《${docRow?.title ?? targetItem.ref_id}》`
        }
      }
    } else {
      sourceSummary = '自定义方案文本'
    }

    if (s.summary) {
      rawText = rawText ? `${rawText}\n\n${s.summary}` : s.summary
    }
    if (s.title && !rawText) {
      rawText = s.title
    }

    const extracted = parseProtocolTextToRules(rawText, s.design)
    const blueprint = extractProtocolBlueprintExtras(rawText)
    const plan: EligibilityProtocol = {
      version: (existing?.version ?? 0) + 1,
      template_id: null,
      source_doc_id: sourceDocId,
      extracted_at: new Date().toISOString(),
      inclusion_rules: extracted.inclusion_rules,
      exclusion_rules: extracted.exclusion_rules,
      last_funnel: existing?.last_funnel ?? null,
    }
    const existingCustomVars = parseCustomVars(s.custom_vars)
    const mergedCustomVars = [...existingCustomVars]
    const seenKeys = new Set(existingCustomVars.map(v => v.key))
    const newlyAddedVars: CustomVarDef[] = []
    for (const cv of blueprint.custom_vars) {
      if (!seenKeys.has(cv.key)) {
        seenKeys.add(cv.key)
        mergedCustomVars.push(cv)
        newlyAddedVars.push(cv)
      }
    }
    const extractedCount = plan.inclusion_rules.length + plan.exclusion_rules.length
    if (opts?.save !== false) {
      this.store.updateStudy(id, {
        // 一条都没识别到时不覆盖已有的纳排方案
        ...(extractedCount > 0 ? { eligibility_plan: JSON.stringify(plan) } : {}),
        ...(newlyAddedVars.length > 0 ? { custom_vars: JSON.stringify(mergedCustomVars) } : {}),
        ...(!s.design && blueprint.recommended_design ? { design: blueprint.recommended_design } : {}),
      })
    }
    return {
      eligibility_plan: plan,
      extracted_count: extractedCount,
      ...(extractedCount === 0
        ? { note: '未从方案中识别到纳排条款；已有的纳排方案未改动。可手动添加规则，或从专科模板中选择。' }
        : {}),
      extracted_custom_vars: newlyAddedVars,
      recommended_design: blueprint.recommended_design,
      source_summary: sourceSummary,
      templates: ELIGIBILITY_TEMPLATES,
    }
  }

  private readDocPlainText(docId: string): string {
    if (this.access?.docText) {
      try {
        const raw = this.access.docText(docId)
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
            const lines: string[] = []
            collectJsonText(parsed, lines)
            if (lines.length > 0) return lines.join('\n')
          } catch {
            return raw
          }
        }
      } catch {
        // Fallback to docs_fts
      }
    }
    try {
      const row = this.store.db.prepare('SELECT title, body FROM docs_fts WHERE doc_id = ?').get(docId) as { title?: string; body?: string } | undefined
      if (row?.body) return `${row.title ?? ''}\n${row.body}`.trim()
    } catch {
      // Ignore
    }
    return ''
  }

  /** 删除研究：研究里的文档（方案、论文、幻灯片）一起进回收站（可恢复，恢复后在文档列表里）；数据集保留在「全部数据集」。返回进回收站的文档数。 */
  remove(owner: string, id: string): { trashed_docs: number } {
    this.own(owner, id, 'manage')
    let n = 0
    for (const i of this.store.studyItems(id)) if (i.kind === 'doc') {
      this.store.setDocContext(i.ref_id, null)
      const d = this.store.getDoc(i.ref_id)
      if (d && !d.deleted_at) { this.store.trashDoc(i.ref_id, true); n++ }
    }
    this.onRemove?.(owner, id)
    this.store.deleteStudy(id)
    return { trashed_docs: n }
  }

  /** 把文档或数据集归入研究（只能是自己的；已在别的研究里时要先移出）。 */
  link(owner: string, id: string, input: { kind?: unknown; ref_id?: unknown; role?: unknown }): void {
    const s = this.own(owner, id, 'write')
    const kind = input.kind === 'doc' || input.kind === 'dataset' ? input.kind : null
    const ref = typeof input.ref_id === 'string' ? input.ref_id : ''
    if (!kind || !ref) throw new StudyError('bad_item', 'kind 只能是 doc / dataset，ref_id 必填')
    if (kind === 'doc') {
      const d = this.store.getDoc(ref)
      if (!d || d.owner !== owner || d.deleted_at) throw new StudyError('not_found', '文档不存在', 404)
      const ctx = d.context ? JSON.parse(d.context) as { kind: string } : null
      if (ctx?.kind === 'patient') throw new StudyError('in_patient', '这份文档属于一位患者（病例报告），不能归入研究', 409)
    } else {
      const ds = this.store.getDataset(ref)
      if (!ds || ds.owner !== owner) throw new StudyError('not_found', '数据集不存在', 404)
      if (ds.status === 'review') throw new StudyError('needs_review', '数据集含有待确认的身份信息列，请先在「数据」里完成去标识处理后再归入研究', 409)
    }
    const cur = this.store.studyOf(kind, ref)
    if (cur?.study_id === id) return
    if (cur) throw new StudyError('in_other_study', `已经归在研究「${this.store.getStudy(cur.study_id)?.title ?? ''}」里，先从那里移出`, 409)
    const role = kind === 'dataset' ? 'data' : typeof input.role === 'string' && DOC_ROLES[input.role] ? input.role : 'other'
    this.store.addStudyItem({ study_id: id, kind, ref_id: ref, role })
    if (kind === 'doc') this.store.setDocContext(ref, { kind: 'study', study_id: id, title: s.title, role })
    this.access?.invalidate()
  }

  /** 移出研究：文档回到创建者的文档列表，数据集回到创建者的「全部数据集」。 */
  unlink(owner: string, id: string, kind: unknown, ref: string): void {
    this.own(owner, id, 'write')
    if (kind !== 'doc' && kind !== 'dataset') throw new StudyError('bad_item', 'kind 只能是 doc / dataset')
    if (!this.store.removeStudyItem(id, kind, ref)) throw new StudyError('not_found', '研究里没有这一项', 404)
    if (kind === 'doc') this.store.setDocContext(ref, null)
    this.access?.invalidate()
  }

  /** 研究的全部内容：文档（按角色）、数据集、自动汇总的分析。 */
  read(owner: string, id: string) {
    const s = this.own(owner, id)
    const myRole = this.store.studyRole(id, owner)!
    const items = this.store.studyItems(id)
    const docs = items.filter(i => i.kind === 'doc').flatMap(i => {
      const d = this.store.getDoc(i.ref_id)
      return d && !d.deleted_at ? [{ doc_id: d.id, title: d.title, kind: d.kind, role: i.role, updated_at: d.updated_at, added_at: i.added_at, created_by: this.name(d.owner) }] : []
    })
    const datasetIds = items.filter(i => i.kind === 'dataset').map(i => i.ref_id)
    const datasets = datasetIds.flatMap(dsId => {
      const d = this.store.getDataset(dsId)
      const o = d?.origin ? JSON.parse(d.origin) as { kind?: string; shape?: string } : null
      return d ? [{ dataset_id: d.id, name: d.name, format: d.format, rows: d.rows, cols: d.cols, status: d.status, updated_at: d.updated_at, version: d.version, cohort: o?.kind === 'cohort' ? { shape: o.shape ?? 'wide' } : null }] : []
    })
    const ids = new Set(datasetIds)
    const latestCohortVerByShape = new Map<string, { version: number; rows: number; name: string }>()
    for (const d of datasets) {
      if (d.cohort?.shape) {
        const cur = latestCohortVerByShape.get(d.cohort.shape)
        if (!cur || (d.version ?? 1) > cur.version) {
          latestCohortVerByShape.set(d.cohort.shape, { version: d.version ?? 1, rows: d.rows, name: d.name })
        }
      }
    }
    const dsById = new Map(datasets.map(d => [d.dataset_id, d]))
    // 分析：用研究数据集画的图或直接归档到本研究的科研图表，不论是哪位成员画的；自动检测底层数据集版本是否已升级
    const analyses = this.store.provenanceAssetsUsing([...ids, id])
      .map(a => {
        let stale_data = false
        let stale_reason: string | null = null
        for (const pd of a.provenance.datasets) {
          if (!pd?.id || pd.id === id) continue
          const curDs = dsById.get(pd.id)
          if (curDs) {
            const pdVer = pd.version ?? 1
            const curVer = curDs.version ?? 1
            if (curVer > pdVer || (curDs.rows > 0 && pd.rows > 0 && curDs.rows !== pd.rows)) {
              stale_data = true
              stale_reason = `数据已更新至 v${curVer} (${curDs.rows}行)，此图基于旧版 v${pdVer} (${pd.rows}行)`
              break
            }
            if (curDs.cohort?.shape) {
              const latestCohort = latestCohortVerByShape.get(curDs.cohort.shape)
              if (latestCohort && latestCohort.version > pdVer) {
                stale_data = true
                stale_reason = `队列已更新至 v${latestCohort.version} (${latestCohort.rows}行)，此图基于旧版 v${pdVer}`
                break
              }
            }
          }
        }
        return {
          asset_id: a.id,
          name: a.name,
          created_at: a.created_at,
          by: this.name(a.owner),
          datasets: a.provenance.datasets.filter(d => ids.has(d.id)).map(d => d.name),
          has_code: Boolean(a.provenance.code),
          code_path: a.provenance.code_path,
          stale_data,
          stale_reason,
        }
      })
    const members = this.store.studyMembers(id).map(m => ({ user_id: m.user_id, name: this.name(m.user_id), role: m.role }))
    return {
      ...s,
      eligibility_plan: parseEligibilityPlan(s.eligibility_plan),
      custom_vars: parseCustomVars(s.custom_vars),
      sample_size_plan: parseSampleSizePlan(s.sample_size_plan),
      eligibility_templates: ELIGIBILITY_TEMPLATES,
      my_role: myRole,
      owner_name: this.name(s.owner),
      design_label: s.design ? DESIGNS[s.design] : null,
      status_label: STATUSES[s.status],
      members,
      docs,
      datasets,
      analyses,
    }
  }

  /** 研究里可分析的数据集（研究文档里对话时自动带上）。 */
  readyDatasets(owner: string, id: string) {
    return this.read(owner, id).datasets.filter(d => d.status === 'ready')
  }
}

function design(v: unknown): StudyRow['design'] {
  return typeof v === 'string' && v in DESIGNS ? v as StudyRow['design'] : null
}
function status(v: unknown): StudyRow['status'] | null {
  return v === 'planning' || v === 'ongoing' || v === 'completed' ? v : null
}

function collectJsonText(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (typeof obj.text === 'string' && obj.text.trim()) {
    out.push(obj.text)
  }
  if (Array.isArray(obj.content)) {
    const blockParts: string[] = []
    for (const child of obj.content) {
      if (child && typeof child === 'object' && typeof (child as Record<string, unknown>).text === 'string') {
        blockParts.push((child as Record<string, unknown>).text as string)
      } else {
        if (blockParts.length > 0) {
          out.push(blockParts.join(''))
          blockParts.length = 0
        }
        collectJsonText(child, out)
      }
    }
    if (blockParts.length > 0) out.push(blockParts.join(''))
  }
}

function sanitizeRules(raw: unknown[], defaultType: 'inclusion' | 'exclusion'): EligibilityRule[] {
  const out: EligibilityRule[] = []
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    if (!r || typeof r !== 'object') continue
    const obj = r as Partial<EligibilityRule>
    if (!obj.predicate || typeof obj.predicate !== 'object') continue
    const type = obj.type === 'inclusion' || obj.type === 'exclusion' ? obj.type : defaultType
    out.push({
      id: typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `${type === 'inclusion' ? 'inc' : 'exc'}_${randomUUID().slice(0, 6)}`,
      type,
      title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim().slice(0, 200) : summarizePredicate(obj.predicate),
      source_clause: typeof obj.source_clause === 'string' ? obj.source_clause.slice(0, 300) : undefined,
      enabled: obj.enabled !== false,
      requires_manual_confirm: Boolean(obj.requires_manual_confirm || obj.predicate.kind === 'manual'),
      predicate: obj.predicate,
    })
  }
  return out
}

function sanitizeCustomVars(raw: unknown[]): CustomVarDef[] {
  const out: CustomVarDef[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Partial<CustomVarDef> & { id?: string; type?: string }
    const rawKey = typeof obj.key === 'string' && obj.key.trim() ? obj.key : typeof obj.id === 'string' ? obj.id : ''
    const key = rawKey.trim().replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_').slice(0, 64)
    const label = typeof obj.label === 'string' ? obj.label.trim().slice(0, 80) : ''
    if (!key || !label || seen.has(key)) continue
    seen.add(key)
    const rawKind = obj.kind ?? obj.type
    const kind = rawKind === 'continuous' || rawKind === 'categorical' || rawKind === 'binary' || rawKind === 'date' || rawKind === 'text'
      ? rawKind
      : 'text'
    out.push({
      id: key,
      key,
      label,
      group: obj.group ?? 'custom',
      kind,
      type: kind,
      unit: typeof obj.unit === 'string' && obj.unit.trim() ? obj.unit.trim().slice(0, 32) : undefined,
      options: Array.isArray(obj.options) ? obj.options.map(String).filter(Boolean) : undefined,
      value_labels: obj.value_labels && typeof obj.value_labels === 'object' ? obj.value_labels as Record<string, string> : undefined,
    })
  }
  return out
}

export function summarizePredicate(p: RulePredicate): string {
  switch (p.kind) {
    case 'demographics': {
      const parts: string[] = []
      if (p.min_age !== undefined && p.max_age !== undefined) parts.push(`年龄 ${p.min_age}–${p.max_age} 岁`)
      else if (p.min_age !== undefined) parts.push(`年龄 ≥ ${p.min_age} 岁`)
      else if (p.max_age !== undefined) parts.push(`年龄 ≤ ${p.max_age} 岁`)
      if (p.sex === 'M') parts.push('性别：男')
      else if (p.sex === 'F') parts.push('性别：女')
      return parts.join('，') || '人口学条件'
    }
    case 'tags':
      return `${p.mode === 'none' ? '不含标签' : p.mode === 'any' ? '含任一标签' : '确诊/含标签'}：${p.tags.join('、')}`
    case 'lab': {
      const modeLabel: Record<LabRuleMode, string> = {
        latest: '最新',
        any: '任意一次',
        baseline: '基线',
        min: '最低值',
        max: '最高值',
        count: '检测次数',
      }
      const m = p.mode ? `[${modeLabel[p.mode]}]` : ''
      const valStr = p.op === 'between' ? `${p.value}–${p.value_to ?? p.value}` : `${p.op} ${p.value}`
      const chg = p.change ? `（动态变化 ≥ ${p.change.min_delta}${p.change.type.startsWith('pct') ? '%' : ''}）` : ''
      return `检验 ${m}${p.name} ${valStr}${chg}`
    }
    case 'imaging': {
      const metricLabels: Record<ImagingMetricKey, string> = {
        signoff_count: '已定稿影像数',
        lesion_diameter_mm: '靶病灶直径(mm)',
        lesion_volume_cm3: '靶病灶体积(cm³)',
        l3_smi: 'L3 骨骼肌指数 SMI(cm²/m²)',
        vat_to_sat_ratio: '内脏/皮下脂肪比(VAT/SAT)',
        bar_ratio: '支气管动脉比(BAR)',
        ham_volume_cm3: '高密度肌肉体积(cm³)',
      }
      return `影像 ${metricLabels[p.metric] ?? p.metric} ${p.op} ${p.value}`
    }
    case 'record': {
      const kindLabels: Record<string, string> = {
        pathology: '病理记录',
        discharge: '出院小结',
        imaging: '影像报告',
        lab_report: '检验报告',
        note: '病程记录',
        any: '临床病历',
      }
      return `${kindLabels[p.record_kind ?? 'any'] ?? '病历'}${p.mode === 'absent' ? '不含' : '包含'}「${p.keyword || '指定记录'}」`
    }
    case 'manual':
      return `人工复核：${p.label}`
  }
}

const LAB_ALIAS_PATTERNS: Array<{ canonical: string; pattern: RegExp }> = [
  { canonical: 'HbA1c', pattern: /(?:HbA1c|糖化血红蛋白)/i },
  { canonical: 'eGFR', pattern: /(?:eGFR|肾小球滤过率)/i },
  { canonical: '肌酐', pattern: /(?:血肌酐|血清肌酐|肌酐|\bSCr\b|\bCr\b)/i },
  { canonical: 'ALT', pattern: /(?:谷丙转氨酶|\bALT\b)/i },
  { canonical: 'AST', pattern: /(?:谷草转氨酶|\bAST\b)/i },
  { canonical: 'TBIL', pattern: /(?:总胆红素|胆红素|\bTBIL\b)/i },
  { canonical: 'ALB', pattern: /(?:血清白蛋白|白蛋白|\bALB\b)/i },
  { canonical: 'WBC', pattern: /(?:白细胞计数|白细胞|\bWBC\b)/i },
  { canonical: 'PLT', pattern: /(?:血小板计数|血小板|\bPLT\b)/i },
  { canonical: 'Hb', pattern: /(?:血红蛋白|\bHGB\b|\bHb\b)/i },
  { canonical: 'AFP', pattern: /(?:甲胎蛋白|\bAFP\b)/i },
  { canonical: 'CEA', pattern: /(?:癌胚抗原|\bCEA\b)/i },
  { canonical: 'CRP', pattern: /(?:C反应蛋白|\bCRP\b)/i },
  { canonical: 'LDL', pattern: /(?:低密度脂蛋白|\bLDL-C\b|\bLDL\b)/i },
  { canonical: 'BMI', pattern: /(?:体重指数|\bBMI\b)/i },
]

const KNOWN_CONDITION_TAGS = [
  '2型糖尿病', '1型糖尿病', '糖尿病', '高血压', '冠心病', '心力衰竭', '心衰', '房颤',
  '慢性肾病', '慢性肾脏病', '肝硬化', '乙肝', '丙肝', '非小细胞肺癌', '小细胞肺癌', '肺癌',
  '肝细胞癌', '肝癌', '结直肠癌', '胃癌', '乳腺癌', '胰腺癌', '恶性肿瘤',
  '慢阻肺', 'COPD', '支气管扩张', '肺结节', '高脂血症', '脑卒中', '自身免疫性疾病', '活动性感染',
]

function normalizeOp(opRaw: string): LabRuleOp {
  const t = opRaw.trim()
  if (t === '≥' || t === '>=' || t.includes('大于等于') || t.includes('不低于') || t.includes('不少于') || t.includes('以上')) return '>='
  if (t === '≤' || t === '<=' || t.includes('小于等于') || t.includes('不超过') || t.includes('不高于') || t.includes('以下')) return '<='
  if (t === '>' || t.includes('大于') || t.includes('高于') || t.includes('超过')) return '>'
  if (t === '<' || t.includes('小于') || t.includes('低于') || t.includes('不足')) return '<'
  return '='
}

/**
 * 将研究方案文本拆解并解析为结构化纳入与排除规则列表。
 */
export function parseProtocolTextToRules(
  rawText: string,
  _studyDesign?: StudyRow['design'] | null,
): { inclusion_rules: EligibilityRule[]; exclusion_rules: EligibilityRule[] } {
  const inclusion_rules: EligibilityRule[] = []
  const exclusion_rules: EligibilityRule[] = []

  const lines = rawText
    .split(/\r?\n/)
    .flatMap(l => l.split(/[；;]/))
    .map(l => l.trim())
    .filter(Boolean)

  let currentSection: 'inclusion' | 'exclusion' = 'inclusion'
  let incSeq = 1
  let excSeq = 1

  const pushRule = (type: 'inclusion' | 'exclusion', rule: Omit<EligibilityRule, 'id' | 'type'>) => {
    const id = type === 'inclusion' ? `inc_${incSeq++}` : `exc_${excSeq++}`
    const full: EligibilityRule = { ...rule, id, type }
    if (type === 'inclusion') inclusion_rules.push(full)
    else exclusion_rules.push(full)
  }

  for (const rawLine of lines) {
    const cleaned = rawLine.replace(/^(?:\d+[.、)）]|\(\d+\)|（\d+）|[-*•①②③④⑤⑥⑦⑧⑨⑩])\s*/, '').trim()
    if (!cleaned) continue

    // Check section headers & skip non-criteria preamble lines
    if (/^(?:研究背景|背景|研究目的|目的|研究方法|方法|研究设计|结局指标|主要终点|次要终点)\s*[:：]/i.test(cleaned)) {
      continue
    }
    if (/^(?:纳入标准|入组标准|入选标准|inclusion\s*criteria)\s*[:：]?$/i.test(cleaned)) {
      currentSection = 'inclusion'
      continue
    }
    if (/^(?:排除标准|剔除标准|exclusion\s*criteria)\s*[:：]?$/i.test(cleaned)) {
      currentSection = 'exclusion'
      continue
    }

    let clause = cleaned
    let section = currentSection
    if (/^(?:纳入标准|入组标准|入选标准)[:：]\s*(.+)$/.test(clause)) {
      section = 'inclusion'
      clause = clause.replace(/^(?:纳入标准|入组标准|入选标准)[:：]\s*/, '').trim()
    } else if (/^(?:排除标准|剔除标准|排除)[:：]\s*(.+)$/.test(clause)) {
      section = 'exclusion'
      clause = clause.replace(/^(?:排除标准|剔除标准|排除)[:：]\s*/, '').trim()
    } else if (/^(?:排除|除外|剔除|不得合并|严禁合并)/.test(clause)) {
      section = 'exclusion'
    }

    if (clause.length < 2) continue

    let matchedClause = false

    // 1. Age rules
    const ageRangeMatch =
      clause.match(/年龄[^\d<>≤≥]*(\d{1,3})\s*(?:[-~～至到]|<=|≤)\s*(\d{1,3})\s*(?:周?岁)?/i) ??
      clause.match(/(\d{1,3})\s*(?:[-~～至到])\s*(\d{1,3})\s*(?:周?岁)/i)
    if (ageRangeMatch) {
      const minAge = Number(ageRangeMatch[1])
      const maxAge = Number(ageRangeMatch[2])
      if (minAge >= 0 && maxAge >= minAge && maxAge <= 120) {
        pushRule(section, {
          title: `年龄 ${minAge}–${maxAge} 岁`,
          source_clause: clause,
          enabled: true,
          predicate: { kind: 'demographics', min_age: minAge, max_age: maxAge },
        })
        matchedClause = true
      }
    } else {
      const ageSingleMatch =
        clause.match(/年龄\s*(>=|≥|>|<=|≤|<|大于等于|小于等于|不低于|不少于|不超过|大于|小于|高于|低于|年满)?\s*(\d{1,3})\s*(?:周?岁)?\s*(以上|以下)?/) ??
        clause.match(/(年满)\s*(\d{1,3})\s*(?:周?岁)/)
      if (ageSingleMatch) {
        const rawOp = (ageSingleMatch[1] || '') + (ageSingleMatch[3] || '')
        const ageVal = Number(ageSingleMatch[2])
        if (ageVal > 0 && ageVal <= 120) {
          const op = rawOp.includes('年满') ? '>=' : normalizeOp(rawOp || '>=')
          if (op === '>=' || op === '>') {
            const minAge = op === '>' ? ageVal + 1 : ageVal
            pushRule(section, {
              title: `年龄 ≥ ${minAge} 岁`,
              source_clause: clause,
              enabled: true,
              predicate: { kind: 'demographics', min_age: minAge },
            })
            matchedClause = true
          } else if (op === '<=' || op === '<') {
            const maxAge = op === '<' ? ageVal - 1 : ageVal
            pushRule(section, {
              title: `年龄 ≤ ${maxAge} 岁`,
              source_clause: clause,
              enabled: true,
              predicate: { kind: 'demographics', max_age: maxAge },
            })
            matchedClause = true
          }
        }
      }
    }

    // 2. Sex rules
    if (!/性别不限|男女不限/.test(clause)) {
      if (/(?:仅限女性|女性患者|性别为女)/.test(clause)) {
        pushRule(section, {
          title: '性别：女性',
          source_clause: clause,
          enabled: true,
          predicate: { kind: 'demographics', sex: 'F' },
        })
        matchedClause = true
      } else if (/(?:仅限男性|男性患者|性别为男)/.test(clause)) {
        pushRule(section, {
          title: '性别：男性',
          source_clause: clause,
          enabled: true,
          predicate: { kind: 'demographics', sex: 'M' },
        })
        matchedClause = true
      }
    }

    // 3. Lab rules
    for (const labEntry of LAB_ALIAS_PATTERNS) {
      if (!labEntry.pattern.test(clause)) continue
      const escaped = labEntry.pattern.source
      const rangeRe = new RegExp(`${escaped}[^\\d<>≤≥=]*(\\d+(?:\\.\\d+)?)\\s*[-~～至到]\\s*(\\d+(?:\\.\\d+)?)`, 'i')
      const singleRe = new RegExp(
        `${escaped}[^\\d<>≤≥=]*(>=|≥|>|<=|≤|<|=|大于等于|小于等于|不低于|不超过|高于|低于|大于|小于)\\s*(\\d+(?:\\.\\d+)?)`,
        'i',
      )
      const mode: LabRuleMode = /基线/.test(clause)
        ? 'baseline'
        : /(?:任意|曾有|历次)/.test(clause)
          ? 'any'
          : /(?:最高|峰值)/.test(clause)
            ? 'max'
            : /(?:最低|谷值)/.test(clause)
              ? 'min'
              : 'latest'

      const rm = clause.match(rangeRe)
      if (rm) {
        const v1 = Number(rm[1])
        const v2 = Number(rm[2])
        const pred: RulePredicate = {
          kind: 'lab',
          name: labEntry.canonical,
          op: 'between',
          value: v1,
          value_to: v2,
          mode,
        }
        pushRule(section, {
          title: summarizePredicate(pred),
          source_clause: clause,
          enabled: true,
          predicate: pred,
        })
        matchedClause = true
        break
      }
      const sm = clause.match(singleRe)
      if (sm) {
        const op = normalizeOp(sm[1]!)
        const val = Number(sm[2]!)
        const pred: RulePredicate = {
          kind: 'lab',
          name: labEntry.canonical,
          op,
          value: val,
          mode,
        }
        pushRule(section, {
          title: summarizePredicate(pred),
          source_clause: clause,
          enabled: true,
          predicate: pred,
        })
        matchedClause = true
        break
      }
    }

    // 4. Imaging rules
    if (/(?:L3\s*SMI|骨骼肌指数|\bSMI\b)/i.test(clause)) {
      const m = clause.match(/(>=|≥|>|<=|≤|<)\s*(\d+(?:\.\d+)?)/)
      if (m) {
        const op = normalizeOp(m[1]!) as '>' | '>=' | '<' | '<=' | '='
        const val = Number(m[2]!)
        const pred: RulePredicate = { kind: 'imaging', metric: 'l3_smi', op, value: val }
        pushRule(section, { title: summarizePredicate(pred), source_clause: clause, enabled: true, predicate: pred })
        matchedClause = true
      }
    } else if (/(?:靶病灶直径|病灶直径|结节直径|最大径)/.test(clause)) {
      const m = clause.match(/(>=|≥|>|<=|≤|<)\s*(\d+(?:\.\d+)?)\s*(cm|mm|厘米|毫米)?/i)
      if (m) {
        const op = normalizeOp(m[1]!) as '>' | '>=' | '<' | '<=' | '='
        const rawVal = Number(m[2]!)
        const unit = (m[3] || 'mm').toLowerCase()
        const valMm = unit === 'cm' || unit === '厘米' ? rawVal * 10 : rawVal
        const pred: RulePredicate = { kind: 'imaging', metric: 'lesion_diameter_mm', op, value: valMm }
        pushRule(section, { title: summarizePredicate(pred), source_clause: clause, enabled: true, predicate: pred })
        matchedClause = true
      }
    } else if (/(?:定稿影像|影像随访|CT\s*随访|MRI\s*随访|可测量病灶)/.test(clause)) {
      const m = clause.match(/(\d+)\s*次/)
      const count = m ? Math.max(1, Number(m[1])) : 1
      const pred: RulePredicate = { kind: 'imaging', metric: 'signoff_count', op: '>=', value: count, min_followups: count > 1 ? count - 1 : undefined }
      pushRule(section, { title: summarizePredicate(pred), source_clause: clause, enabled: true, predicate: pred })
      matchedClause = true
    }

    // 5. Pathology / Discharge / Clinical record rules
    const recKeywordMatch = clause.match(/(?:(病理|出院小结|影像|病程|检验)?(?:报告|记录|病历))(?:包含|含|中含|提示|显示|证实)[:：]?\s*([^\s，,。；;]+)/)
    if (recKeywordMatch) {
      const kindRaw = recKeywordMatch[1] || ''
      const record_kind = kindRaw === '病理' ? 'pathology'
        : kindRaw === '出院小结' ? 'discharge'
        : kindRaw === '影像' ? 'imaging'
        : kindRaw === '病程' ? 'note'
        : kindRaw === '检验' ? 'lab_report'
        : 'any'
      const kw = recKeywordMatch[2]!.trim()
      const pred: RulePredicate = {
        kind: 'record',
        record_kind,
        keyword: kw,
        mode: 'present',
      }
      pushRule(section, { title: summarizePredicate(pred), source_clause: clause, enabled: true, predicate: pred })
      matchedClause = true
    } else if (/(?:病理学?确诊|组织学确诊|细胞学确诊|穿刺活检确诊|病理证实)/.test(clause)) {
      const matchedTag = KNOWN_CONDITION_TAGS.find(t => clause.includes(t))
      const pred: RulePredicate = {
        kind: 'record',
        record_kind: 'pathology',
        keyword: matchedTag ?? '确诊',
        mode: /(?:未|无|缺乏)/.test(clause) ? 'absent' : 'present',
      }
      pushRule(section, { title: summarizePredicate(pred), source_clause: clause, enabled: true, predicate: pred })
      matchedClause = true
    }

    // 6. Diagnosis / History tag rules
    const rawHitTags = KNOWN_CONDITION_TAGS.filter(t => clause.includes(t))
    const hitTags = rawHitTags.filter(t => !rawHitTags.some(other => other !== t && other.includes(t)))
    if (hitTags.length > 0 && !matchedClause) {
      const isNegativeInInclusion = section === 'inclusion' && /(?:无|未合并|不含|除外|排除)/.test(clause)
      if (isNegativeInInclusion) {
        const pred: RulePredicate = { kind: 'tags', mode: 'any', tags: hitTags }
        pushRule('exclusion', {
          title: `排除合并：${hitTags.join('、')}`,
          source_clause: clause,
          enabled: true,
          predicate: pred,
        })
      } else {
        const pred: RulePredicate = {
          kind: 'tags',
          mode: section === 'exclusion' ? 'any' : (hitTags.length > 1 && /或/.test(clause) ? 'any' : 'all'),
          tags: hitTags,
        }
        pushRule(section, {
          title: section === 'exclusion' ? `排除合并：${hitTags.join('、')}` : `确诊/合并：${hitTags.join('、')}`,
          source_clause: clause,
          enabled: true,
          predicate: pred,
        })
      }
      matchedClause = true
    }

    // 7. Manual confirmation items (informed consent, ECOG, pregnancy, compliance, etc.)
    if (
      !matchedClause &&
      /(?:知情同意|ECOG|KPS|妊娠|哺乳|生存期|依从性|过敏|精神疾病|随访资料不完整|临床资料缺失)/i.test(clause)
    ) {
      pushRule(section, {
        title: clause.slice(0, 120),
        source_clause: clause,
        enabled: true,
        requires_manual_confirm: true,
        predicate: { kind: 'manual', label: clause.slice(0, 120) },
      })
    }
  }

  // 未识别到任何条款时返回空规则；不再套用与本研究无关的专科模板并冒充「从方案提取」
  return { inclusion_rules, exclusion_rules }
}

const PROTOCOL_BIOMARKER_PATTERNS: Array<{
  pattern: RegExp
  key: string
  label: string
  kind: CustomVarDef['kind']
  group: CustomVarDef['group']
  unit?: string
}> = [
  { pattern: /\bKRAS\b/i, key: 'kras_status', label: 'KRAS 基因突变状态', kind: 'categorical', group: 'baseline_labs' },
  { pattern: /\bEGFR\b(?![\s_-]*(?:>=|<=|>|<|\d|滤过率))/i, key: 'egfr_mutation', label: 'EGFR 突变状态', kind: 'categorical', group: 'baseline_labs' },
  { pattern: /\bPD-?L1\b/i, key: 'pdl1_tps', label: 'PD-L1 表达水平 (TPS)', kind: 'continuous', group: 'baseline_labs', unit: '%' },
  { pattern: /\bHER2\b/i, key: 'her2_status', label: 'HER2 表达状态', kind: 'categorical', group: 'baseline_labs' },
  { pattern: /\bBRCA\b/i, key: 'brca_mutation', label: 'BRCA 突变状态', kind: 'categorical', group: 'baseline_labs' },
  { pattern: /\bECOG\b/i, key: 'ecog_score', label: 'ECOG 体能状态评分', kind: 'categorical', group: 'demographics', unit: '分' },
  { pattern: /\bmRS\b|改良Rankin/i, key: 'mrs_score', label: '改良 Rankin 量表评分 (mRS)', kind: 'categorical', group: 'outcomes', unit: '分' },
  { pattern: /\bNYHA\b|心功能分级/i, key: 'nyha_class', label: 'NYHA 心功能分级', kind: 'categorical', group: 'demographics' },
  { pattern: /\bTNM\b|临床分期|肿瘤分期/i, key: 'tnm_stage', label: 'TNM 临床分期', kind: 'categorical', group: 'demographics' },
  { pattern: /客观缓解率|\bORR\b|疗效评估|RECIST/i, key: 'orr_response', label: '客观缓解疗效 (ORR/RECIST)', kind: 'categorical', group: 'outcomes' },
  { pattern: /不良事件|不良反应|\bAE\b|\bSAE\b/i, key: 'adverse_event', label: '治疗相关不良事件 (AE)', kind: 'binary', group: 'outcomes' },
  { pattern: /尿白蛋白肌酐比|\bUACR\b/i, key: 'uacr', label: '尿白蛋白/肌酐比值 (UACR)', kind: 'continuous', group: 'outcomes', unit: 'mg/g' },
  { pattern: /左室射血分数|\bLVEF\b/i, key: 'lvef_pct', label: '左室射血分数 (LVEF)', kind: 'continuous', group: 'outcomes', unit: '%' },
]

/**
 * 从研究方案文本中提取推荐的研究设计类型 (design) 与课题专属终点/暴露/生物标志物变量 (custom_vars)
 */
export function extractProtocolBlueprintExtras(rawText: string): {
  recommended_design: StudyRow['design']
  custom_vars: CustomVarDef[]
} {
  let recommended_design: StudyRow['design'] = null
  if (/随机对照|\bRCT\b|随机双盲|随机分组/i.test(rawText)) {
    recommended_design = 'rct'
  } else if (/病例对照|case[-\s]?control/i.test(rawText)) {
    recommended_design = 'case_control'
  } else if (/横断面|现况调查|cross[-\s]?sectional/i.test(rawText)) {
    recommended_design = 'cross_sectional'
  } else if (/前瞻性|prospective/i.test(rawText)) {
    recommended_design = 'prospective_cohort'
  } else if (/队列|回顾性|随访研究|cohort/i.test(rawText)) {
    recommended_design = 'retrospective_cohort'
  }

  const custom_vars: CustomVarDef[] = []
  const seen = new Set<string>()
  for (const item of PROTOCOL_BIOMARKER_PATTERNS) {
    if (item.pattern.test(rawText) && !seen.has(item.key)) {
      seen.add(item.key)
      custom_vars.push({
        id: item.key,
        key: item.key,
        label: item.label,
        group: item.group,
        kind: item.kind,
        type: item.kind,
        unit: item.unit,
      })
    }
  }

  return { recommended_design, custom_vars }
}

