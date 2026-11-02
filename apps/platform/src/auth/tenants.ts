import type { DepartmentRow, Store, TenantInviteRow, TenantRow, UserRow } from '../store/db.ts'

/**
 * 租户（机构）：设计见 docs/design/TENANCY.md。
 * - 双重身份：每个账户有「工作空间」（users.tenant_id：加入了医院就是医院，否则是个人空间）和「个人空间」
 *   （users.personal_tenant_id：知家的家人档案）。个人注册得到个人租户（本人为管理员）；已有账户经邀请（链接或按用户名）
 *   由本人接受后加入医院，个人空间保留；同一时间最多加入一家医院。工作台按工作空间、知家按个人空间（Space）。
 * - 机构管理员：成员（角色、停用）、邀请、机构设置、本机构审计。平台运营（users.role=admin）：建机构、停用 / 恢复机构。
 * - 平台运营不经这里读任何租户的业务数据；患者数据（第二期）按租户分库，见设计稿。
 */

export interface TenantSettings {
  /** 患者模块（第二期）是否开放 */
  patient_module: boolean
  /** 患者数据能否发给外部模型（托管版默认开） */
  external_model_for_patients: boolean
  /** 患者默认可见范围：创建者 + 诊疗组 / 本机构全员 */
  patient_visibility: 'care_team' | 'tenant'
  /** AI 修改患者记录：review = 进待确认、由医生确认（默认）；direct = 和人一样直接生效 */
  ai_patient_writes: 'review' | 'direct'
  /** 接受知家家庭分享（家人可在知家里选本院的科室分享档案；docs/design/SHARING.md）。只对机构有意义 */
  accept_patient_shares: boolean
  /**
   * 影像 AI 自动分析结果是否显示（docs/design/IMAGING_STUDIES.md「影子模式」）：shadow = 分析照常运行、结果只进影子期对照报告，
   * 对界面、阅片器与 AI 都不可见（一期上线前的回顾评估，PRD 关口 G1）；visible = 正常显示。医生在阅片器里的点选分割不受影响。
   */
  imaging_ai_visibility: 'visible' | 'shadow'
}

export const DEFAULT_SETTINGS: TenantSettings = { patient_module: true, external_model_for_patients: true, patient_visibility: 'care_team', ai_patient_writes: 'review', accept_patient_shares: true, imaging_ai_visibility: 'visible' }

export class TenantError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message) }
}

export interface TenantView {
  id: string; name: string; kind: TenantRow['kind']; status: TenantRow['status']
  role: UserRow['tenant_role']; settings: TenantSettings; members: number
  /** 个人空间（知家）的租户 id；纯医院账号还没建时为 null */
  personal_id: string | null
  /** 已加入医院（工作空间是机构） */
  in_org: boolean
}

export interface MemberView {
  id: string; username: string; display_name: string; email: string | null
  tenant_role: UserRow['tenant_role']; status: UserRow['status']; created_at: string; last_login_at: string | null; doc_count: number
  /** 已有账户加入的（自己另有个人空间 / 知家；移出时回到那里） */
  joined: boolean
  /** 所在科室列表 */
  departments?: Array<{ id: string; name: string }>
}

const INVITE_DAYS_MAX = 30

/** 请求所在的空间：work = 工作台（医院或个人）；personal = 知家（个人空间）。 */
export type Space = 'work' | 'personal'

export interface InviteView { code: string; tenant: string; tenant_id: string; role: TenantInviteRow['role']; invited_by: string | null; expires_at: string }

export class TenantService {
  constructor(private readonly store: Store, private readonly opts: { devMode: boolean }) {}

  /** 用户在某个空间的租户（默认工作空间）。开发令牌用户（没有账户记录）在开发模式下两个空间是同一个虚拟个人租户。 */
  of(userId: string, space: Space = 'work'): TenantRow {
    if (space === 'personal') return this.personalOf(userId)
    const u = this.store.getUser(userId)
    if (u?.tenant_id) {
      const t = this.store.getTenant(u.tenant_id)
      if (t) return t
    }
    if (!u && this.opts.devMode) {
      const id = 'tdev_' + userId.replace(/[^A-Za-z0-9_-]/g, '_')
      return this.store.getTenant(id) ?? this.store.createTenant({ id, name: `${userId}（开发）`, kind: 'personal' })
    }
    throw new TenantError('no_tenant', '账户没有所属机构', 403)
  }

  /**
   * 个人空间（知家）。老账户就是个人租户；加入医院后保留原来的；纯医院账号（经邀请注册进机构）第一次用知家时建一个。
   */
  personalOf(userId: string): TenantRow {
    const u = this.store.getUser(userId)
    if (!u) return this.of(userId, 'work')
    if (u.personal_tenant_id) {
      const t = this.store.getTenant(u.personal_tenant_id)
      if (t) return t
    }
    const cur = u.tenant_id ? this.store.getTenant(u.tenant_id) : undefined
    if (cur?.kind === 'personal') { this.store.setPersonalTenant(u.id, cur.id); return cur }
    const t = this.store.createTenant({ name: `${u.display_name}（个人）`, kind: 'personal', created_by: u.id })
    this.store.setPersonalTenant(u.id, t.id)
    return t
  }

  /** 租户角色（开发用户是自己虚拟租户的管理员；个人空间里本人就是管理员）。 */
  roleOf(userId: string, space: Space = 'work'): UserRow['tenant_role'] {
    if (space === 'personal') return 'admin'
    const u = this.store.getUser(userId)
    return u ? u.tenant_role : 'admin'
  }

  /** 是否已加入一家医院（工作空间是机构、且不是自己的个人空间）。 */
  inOrg(userId: string): boolean {
    const u = this.store.getUser(userId)
    if (!u?.tenant_id) return false
    const t = this.store.getTenant(u.tenant_id)
    return t?.kind === 'org' && t.id !== u.personal_tenant_id
  }

  /** 机构是否可用（停用的机构，成员不能登录、令牌失效）。 */
  active(userId: string): boolean {
    try { return this.of(userId).status === 'active' } catch { return false }
  }

  settings(t: TenantRow): TenantSettings {
    let raw: Partial<TenantSettings> = {}
    try { raw = JSON.parse(t.settings || '{}') as Partial<TenantSettings> } catch { /* 坏的设置当默认 */ }
    return { ...DEFAULT_SETTINGS, ...raw }
  }

  view(userId: string): TenantView {
    const t = this.of(userId)
    const u = this.store.getUser(userId)
    return {
      id: t.id, name: t.name, kind: t.kind, status: t.status, role: this.roleOf(userId), settings: this.settings(t), members: this.store.tenantMembers(t.id).length || 1,
      personal_id: u?.personal_tenant_id ?? (t.kind === 'personal' ? t.id : null), in_org: this.inOrg(userId),
    }
  }

  private requireAdmin(actor: string): TenantRow {
    const t = this.of(actor)
    if (this.roleOf(actor) !== 'admin') throw new TenantError('forbidden', '只有机构管理员能做这件事', 403)
    return t
  }

  update(actor: string, patch: { name?: unknown; settings?: Partial<Record<keyof TenantSettings, unknown>> }): TenantView {
    const t = this.requireAdmin(actor)
    const next: Parameters<Store['updateTenant']>[1] = {}
    if (typeof patch.name === 'string') {
      const name = patch.name.trim().slice(0, 60)
      if (!name) throw new TenantError('bad_name', '机构名称不能为空')
      next.name = name
    }
    if (patch.settings && typeof patch.settings === 'object') {
      const cur = this.settings(t)
      const s = patch.settings
      if (typeof s.patient_module === 'boolean') cur.patient_module = s.patient_module
      if (typeof s.external_model_for_patients === 'boolean') cur.external_model_for_patients = s.external_model_for_patients
      if (s.patient_visibility === 'care_team' || s.patient_visibility === 'tenant') cur.patient_visibility = s.patient_visibility
      if (s.ai_patient_writes === 'review' || s.ai_patient_writes === 'direct') cur.ai_patient_writes = s.ai_patient_writes
      if (typeof s.accept_patient_shares === 'boolean') cur.accept_patient_shares = s.accept_patient_shares
      if (s.imaging_ai_visibility === 'visible' || s.imaging_ai_visibility === 'shadow') cur.imaging_ai_visibility = s.imaging_ai_visibility
      next.settings = JSON.stringify(cur)
    }
    this.store.updateTenant(t.id, next)
    return this.view(actor)
  }

  // —— 成员 ——

  members(actor: string): MemberView[] {
    const t = this.requireAdmin(actor)
    const depts = this.store.listDepartments(t.id)
    return this.store.tenantMembers(t.id).map(u => {
      const v = memberView(u)
      v.departments = depts.filter(d => d.members.includes(u.id)).map(d => ({ id: d.id, name: d.name }))
      return v
    })
  }

  /** 改成员的机构角色或停用 / 启用（只能管本机构的人；不能让机构失去最后一位管理员）。 */
  setMember(actor: string, userId: string, patch: { tenant_role?: unknown; status?: unknown }): MemberView {
    const t = this.requireAdmin(actor)
    const u = this.store.getUser(userId)
    if (!u || u.tenant_id !== t.id) throw new TenantError('not_found', '成员不存在', 404)
    const role = patch.tenant_role === 'admin' || patch.tenant_role === 'member' ? patch.tenant_role : undefined
    const status = patch.status === 'active' || patch.status === 'disabled' ? patch.status : undefined
    const losesAdmin = u.tenant_role === 'admin' && (role === 'member' || status === 'disabled')
    if (losesAdmin && this.store.tenantMembers(t.id).filter(m => m.tenant_role === 'admin' && m.status === 'active').length <= 1) {
      throw new TenantError('last_admin', '机构至少要有一位管理员', 409)
    }
    if (role) this.store.setTenantRole(u.id, role)
    if (status) this.store.updateUser(u.id, { status, bumpTokenVersion: status === 'disabled' })
    return memberView({ ...this.store.getUser(u.id)!, doc_count: 0 })
  }

  // —— 科室（知家分享的落点；一人可在多个科室）——

  /** 本机构的科室与成员（机构成员都能看：分享收件箱按科室划分，医生要知道自己在哪些科室）。 */
  departments(actor: string): Array<DepartmentRow & { members: Array<{ id: string; display_name: string }> }> {
    const t = this.of(actor)
    return this.store.listDepartments(t.id).map(d => ({ ...d, members: d.members.flatMap(id => { const u = this.store.getUser(id); return u ? [{ id, display_name: u.display_name }] : [] }) }))
  }

  createDepartment(actor: string, name: unknown): DepartmentRow {
    const t = this.requireAdmin(actor)
    const n = typeof name === 'string' ? name.trim().slice(0, 40) : ''
    if (!n) throw new TenantError('bad_name', '科室名称不能为空')
    if (this.store.listDepartments(t.id).some(d => d.name === n)) throw new TenantError('duplicate', `已经有「${n}」了`, 409)
    if (t.kind === 'personal') throw new TenantError('personal', '个人空间没有科室；科室是医院等机构用的', 400)
    return this.store.addDepartment(t.id, n)
  }

  private ownDepartment(actor: string, id: string): DepartmentRow {
    const t = this.requireAdmin(actor)
    const d = this.store.getDepartment(id)
    if (!d || d.tenant_id !== t.id) throw new TenantError('not_found', '科室不存在', 404)
    return d
  }

  renameDepartment(actor: string, id: string, name: unknown): DepartmentRow {
    this.ownDepartment(actor, id)
    const n = typeof name === 'string' ? name.trim().slice(0, 40) : ''
    if (!n) throw new TenantError('bad_name', '科室名称不能为空')
    this.store.renameDepartment(id, n)
    return this.store.getDepartment(id)!
  }

  /** 删除科室：发给这个科室的分享随之不再可见（家人那边显示「科室已撤销」）。 */
  deleteDepartment(actor: string, id: string): void {
    this.ownDepartment(actor, id)
    this.store.deleteDepartment(id)
  }

  /** 设置科室成员（只能是本机构的人）。 */
  setDepartmentMembers(actor: string, id: string, userIds: unknown): DepartmentRow & { members: string[] } {
    const d = this.ownDepartment(actor, id)
    const ids = Array.isArray(userIds) ? [...new Set(userIds.filter((u): u is string => typeof u === 'string'))].slice(0, 500) : []
    for (const u of ids) if (this.store.getUser(u)?.tenant_id !== d.tenant_id) throw new TenantError('not_member', '只能把本机构的成员分进科室', 400)
    this.store.setDepartmentMembers(id, ids)
    return this.store.listDepartments(d.tenant_id).find(x => x.id === id)!
  }

  // —— 邀请 ——

  invite(actor: string, input: { role?: unknown; email?: unknown; days?: unknown }): TenantInviteRow {
    const t = this.requireAdmin(actor)
    const role = input.role === 'admin' ? 'admin' : 'member'
    const email = typeof input.email === 'string' && input.email.trim() ? input.email.trim().toLowerCase().slice(0, 120) : null
    const days = Math.min(INVITE_DAYS_MAX, Math.max(1, Number(input.days) || 7))
    // 个人租户开始邀请别人：变成机构（旧行为，保留）。它从此只是工作空间；本人的知家第一次用时另建个人空间
    if (t.kind === 'personal') {
      this.store.updateTenant(t.id, { kind: 'org' })
      if (this.store.getUser(actor)?.personal_tenant_id === t.id) this.store.setPersonalTenant(actor, null)
    }
    return this.store.addInvite({ tenant_id: t.id, role, email, created_by: actor, days })
  }

  /**
   * 按用户名邀请已有账户：只有这个人能接受（本人在头像菜单 / 通知里看到）。对方已在别的医院时直接拒绝发出。
   */
  inviteUser(actor: string, input: { username?: unknown; role?: unknown; days?: unknown }): TenantInviteRow {
    const t = this.requireAdmin(actor)
    if (t.kind !== 'org') throw new TenantError('personal', '个人空间不能邀请别人加入；按用户名邀请是医院等机构用的', 400)
    const name = typeof input.username === 'string' ? input.username.trim() : ''
    const target = name ? this.store.getUserByName(name) : undefined
    if (!target || target.status !== 'active') throw new TenantError('no_user', `平台上没有在用的账户「${name}」`, 404)
    if (target.id === actor) throw new TenantError('self', '不能邀请自己', 400)
    if (target.tenant_id === t.id) throw new TenantError('already_member', `「${target.display_name}」已经是本机构成员`, 409)
    if (this.inOrg(target.id)) throw new TenantError('in_other_org', `「${target.display_name}」已经在另一家医院；一个账户同一时间只能加入一家医院`, 409)
    const role = input.role === 'admin' ? 'admin' : 'member'
    const days = Math.min(INVITE_DAYS_MAX, Math.max(1, Number(input.days) || 7))
    return this.store.addInvite({ tenant_id: t.id, role, email: null, created_by: actor, days, target_user_id: target.id })
  }

  /** 发给我（按用户名）的待处理邀请。 */
  myInvites(userId: string): InviteView[] {
    return this.store.invitesForUser(userId).flatMap(inv => {
      const t = this.store.getTenant(inv.tenant_id)
      if (!t || t.status !== 'active') return []
      return [{ code: inv.code, tenant: t.name, tenant_id: t.id, role: inv.role, invited_by: this.store.getUser(inv.created_by)?.display_name ?? null, expires_at: inv.expires_at }]
    })
  }

  /** 已登录用户看邀请（链接邀请或按用户名邀请）：确认页用。别人的按用户名邀请一律当不存在。 */
  inviteFor(userId: string, code: string): InviteView {
    const inv = this.usableInvite(code)
    if (inv.target_user_id && inv.target_user_id !== userId) throw new TenantError('invite_invalid', '邀请链接无效', 404)
    const t = this.store.getTenant(inv.tenant_id)!
    return { code: inv.code, tenant: t.name, tenant_id: t.id, role: inv.role, invited_by: this.store.getUser(inv.created_by)?.display_name ?? null, expires_at: inv.expires_at }
  }

  /**
   * 本人接受邀请加入医院：工作空间换成医院（角色按邀请），个人空间（知家）保留。管理员不能代接受；AI 发起要本人确认。
   */
  accept(userId: string, code: string): TenantView {
    const u = this.store.getUser(userId)
    if (!u) throw new TenantError('no_account', '开发令牌用户不能加入机构', 400)
    const inv = this.usableInvite(code)
    if (inv.target_user_id && inv.target_user_id !== userId) throw new TenantError('invite_invalid', '邀请链接无效', 404)
    if (inv.email && u.email && inv.email !== u.email.toLowerCase()) throw new TenantError('invite_email', '这个邀请是发给另一个邮箱的', 403)
    if (u.tenant_id === inv.tenant_id) throw new TenantError('already_member', '你已经是这个机构的成员', 409)
    if (this.inOrg(userId)) throw new TenantError('in_other_org', '你已经在另一家医院；先退出那家，才能加入新的', 409)
    // 个人空间留下：老账户的个人租户就是现在的工作空间
    return this.store.transaction(() => {
      if (!u.personal_tenant_id && u.tenant_id && this.store.getTenant(u.tenant_id)?.kind === 'personal') this.store.setPersonalTenant(u.id, u.tenant_id)
      this.store.moveUserToTenant(u.id, inv.tenant_id, inv.role)
      this.store.useInvite(inv.code, u.id)
      return this.view(userId)
    })
  }

  /** 本人拒绝一个发给自己的邀请。 */
  decline(userId: string, code: string): void {
    const inv = this.store.getInvite(code)
    if (!inv || inv.target_user_id !== userId || inv.used_at || inv.revoked_at) throw new TenantError('invite_invalid', '邀请不存在', 404)
    this.store.revokeInvite(code)
  }

  /**
   * 离开医院（本人退出，或管理员移出）：工作空间回到个人空间。取舍（docs/design/TENANCY.md）：
   * - 还负责着本院研究的，先转交（或由管理员交接）才能离开；
   * - 本院研究里的成员身份、本院科室归属随之去掉；
   * - 本院患者的诊疗组记录保留（访问日志与历史可追溯），但人不在本院后读不到（患者库按工作空间取）；重新加入后恢复。
   */
  private detach(userId: string, tenantId: string): void {
    const owned = this.store.listTenantStudies(tenantId).filter(st => st.owner === userId)
    if (owned.length) throw new TenantError('owns_studies', `还负责着本院的 ${owned.length} 个研究（${owned.slice(0, 3).map(st => `「${st.title}」`).join('、')}${owned.length > 3 ? '…' : ''}）；先转交给本院同事，或请机构管理员做离职交接`, 409)
    this.store.transaction(() => {
      for (const st of this.store.listTenantStudies(tenantId)) this.store.removeStudyMember(st.id, userId)
      for (const d of this.store.listDepartments(tenantId)) if (d.members.includes(userId)) this.store.setDepartmentMembers(d.id, d.members.filter(m => m !== userId))
      const home = this.personalOf(userId)
      this.store.moveUserToTenant(userId, home.id, 'admin')
    })
  }

  /** 本人退出医院。 */
  leave(userId: string): TenantView {
    const u = this.store.getUser(userId)
    if (!u || !this.inOrg(userId)) throw new TenantError('not_in_org', '你现在不在任何医院', 400)
    if (u.tenant_role === 'admin' && this.store.tenantMembers(u.tenant_id!).filter(m => m.tenant_role === 'admin' && m.status === 'active').length <= 1) {
      throw new TenantError('last_admin', '你是本院唯一的管理员；先把别人设为管理员再退出', 409)
    }
    this.detach(userId, u.tenant_id!)
    return this.view(userId)
  }

  /** 管理员把成员移出本院（他的个人空间不受影响；纯医院账号回到自己的个人空间）。 */
  removeMember(actor: string, userId: string): void {
    const t = this.requireAdmin(actor)
    const u = this.store.getUser(userId)
    if (!u || u.tenant_id !== t.id) throw new TenantError('not_found', '成员不存在', 404)
    if (u.id === actor) throw new TenantError('self', '不能把自己移出；要离开请用「退出医院」', 400)
    if (t.kind !== 'org') throw new TenantError('personal', '个人空间没有别的成员', 400)
    this.detach(userId, t.id)
  }

  invites(actor: string): Array<TenantInviteRow & { target_username: string | null }> {
    return this.store.listInvites(this.requireAdmin(actor).id).map(inv => ({ ...inv, target_username: inv.target_user_id ? this.store.getUser(inv.target_user_id)?.username ?? null : null }))
  }

  revokeInvite(actor: string, code: string): void {
    const t = this.requireAdmin(actor)
    const inv = this.store.getInvite(code)
    if (!inv || inv.tenant_id !== t.id) throw new TenantError('not_found', '邀请不存在', 404)
    this.store.revokeInvite(code)
  }

  /** 邀请是否可用（注册页显示「加入 XX」；不需要登录）。 */
  checkInvite(code: string): { tenant: string; role: TenantInviteRow['role']; email: string | null } {
    const inv = this.usableInvite(code)
    // 按用户名邀请的只给被邀请人本人看（登录后在 /api/me/invites 里）
    if (inv.target_user_id) throw new TenantError('invite_invalid', '邀请链接无效', 404)
    return { tenant: this.store.getTenant(inv.tenant_id)!.name, role: inv.role, email: inv.email }
  }

  usableInvite(code: string): TenantInviteRow {
    const inv = typeof code === 'string' ? this.store.getInvite(code) : undefined
    if (!inv || inv.revoked_at) throw new TenantError('invite_invalid', '邀请链接无效', 404)
    if (inv.used_at) throw new TenantError('invite_used', '这个邀请链接已经用过了', 409)
    if (Date.parse(inv.expires_at) < Date.now()) throw new TenantError('invite_expired', '邀请链接已过期，请让管理员重新发一个')
    const t = this.store.getTenant(inv.tenant_id)
    if (!t || t.status !== 'active') throw new TenantError('tenant_suspended', '这个机构已停用', 403)
    return inv
  }

  // —— 平台运营 ——

  private requireOperator(actor: string): void {
    if (this.store.getUser(actor)?.role !== 'admin') throw new TenantError('forbidden', '只有平台运营能做这件事', 403)
  }

  listAll(actor: string) {
    this.requireOperator(actor)
    return this.store.listTenants().map(t => ({ id: t.id, name: t.name, kind: t.kind, status: t.status, created_at: t.created_at, members: t.members, admins: t.admins, docs: t.docs }))
  }

  /** 新建机构：返回给首位管理员的邀请（平台运营不成为该机构的成员）。 */
  createOrg(actor: string, input: { name?: unknown; admin_email?: unknown }): { tenant: TenantRow; invite: TenantInviteRow } {
    this.requireOperator(actor)
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : ''
    if (!name) throw new TenantError('bad_name', '机构名称不能为空')
    const tenant = this.store.createTenant({ name, kind: 'org', created_by: actor })
    const email = typeof input.admin_email === 'string' && input.admin_email.trim() ? input.admin_email.trim().toLowerCase() : null
    const invite = this.store.addInvite({ tenant_id: tenant.id, role: 'admin', email, created_by: actor, days: INVITE_DAYS_MAX })
    return { tenant, invite }
  }

  setStatus(actor: string, tenantId: string, status: unknown): void {
    this.requireOperator(actor)
    const t = this.store.getTenant(tenantId)
    if (!t) throw new TenantError('not_found', '机构不存在', 404)
    if (status !== 'active' && status !== 'suspended') throw new TenantError('bad_status', '状态只能是 active 或 suspended')
    if (status === 'suspended' && this.store.getUser(actor)?.tenant_id === tenantId) throw new TenantError('self', '不能停用自己所在的机构', 409)
    this.store.updateTenant(t.id, { status })
  }
}

const memberView = (u: UserRow & { doc_count: number }): MemberView => ({
  id: u.id, username: u.username, display_name: u.display_name, email: u.email ?? null, tenant_role: u.tenant_role, status: u.status,
  created_at: u.created_at, last_login_at: u.last_login_at, doc_count: u.doc_count,
  joined: Boolean(u.personal_tenant_id && u.personal_tenant_id !== u.tenant_id),
})
