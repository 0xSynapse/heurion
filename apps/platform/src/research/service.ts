import type { DatasetService } from '../datasets/service.ts'
import type { Store, StudyRole, StudyRow } from '../store/db.ts'
import { allows, type Access, type Level } from './access.ts'

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
        ...s, my_role: s.my_role, shared: s.owner !== user, shared_by: s.owner !== user ? this.name(s.owner) : null,
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

  update(owner: string, id: string, patch: { title?: unknown; design?: unknown; status?: unknown; summary?: unknown }): StudyRow {
    this.own(owner, id, 'write')
    const next: Parameters<Store['updateStudy']>[1] = {}
    if (patch.title !== undefined) { const t = clean(patch.title, 120); if (!t) throw new StudyError('bad_title', '研究名称不能为空'); next.title = t }
    if (patch.design !== undefined) next.design = design(patch.design)
    if (patch.status !== undefined) { const st = status(patch.status); if (!st) throw new StudyError('bad_status', '状态只能是 planning / ongoing / completed'); next.status = st }
    if (patch.summary !== undefined) next.summary = clean(patch.summary, 4000) || null
    this.store.updateStudy(id, next)
    // 研究改名：归入文档的归属标签跟着更新
    if (next.title) for (const i of this.store.studyItems(id).filter(i => i.kind === 'doc')) this.store.setDocContext(i.ref_id, { kind: 'study', study_id: id, title: next.title, role: i.role })
    return this.store.getStudy(id)!
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
    // 分析：用研究数据集画的图或直接归档到本研究的科研图表，不论是哪位成员画的
    const analyses = this.store.provenanceAssetsUsing([...ids, id])
      .map(a => ({ asset_id: a.id, name: a.name, created_at: a.created_at, by: this.name(a.owner), datasets: a.provenance.datasets.filter(d => ids.has(d.id)).map(d => d.name), has_code: Boolean(a.provenance.code), code_path: a.provenance.code_path }))
    const members = this.store.studyMembers(id).map(m => ({ user_id: m.user_id, name: this.name(m.user_id), role: m.role }))
    return { ...s, my_role: myRole, owner_name: this.name(s.owner), design_label: s.design ? DESIGNS[s.design] : null, status_label: STATUSES[s.status], members, docs, datasets, analyses }
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
