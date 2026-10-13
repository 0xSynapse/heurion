import { randomBytes } from 'node:crypto'
import type { TenantService } from '../auth/tenants.ts'
import type { PhrClaimRow, PersonLinkRow, Store } from '../store/db.ts'
import { PatientError, type Actor, type PatientService } from './patients.ts'

/**
 * 机构认领码与患者/家庭成员绑定服务 (docs/design/PATIENT.md §4, §8)：
 * - 医生在机构患者页生成一次性认领码（24小时有效，一码一用）。
 * - 成人患者或家属在知家端输入认领码与成员 ID，发起认领申请。
 * - 医生在机构端确认绑定（防错绑，留完整审计记录；认领严禁由 AI 代为确认）。
 * - 绑定后在 person_links 登记，将机构病历行与自然人/家庭成员正式链接。
 * - 医生或家属可随时撤销申请或解除绑定。
 */

// 认领码字符集：去掉易混淆的 0, O, 1, I
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

function generateCode(): string {
  const bytes = randomBytes(8)
  let code = ''
  for (let i = 0; i < 8; i++) {
    const byte = bytes[i] ?? 0
    code += CODE_CHARS[byte % CODE_CHARS.length]
    if (i === 3) code += '-' // 形式如: 9ABC-2DEF
  }
  return code
}

export class PatientClaimService {
  constructor(
    private readonly store: Store,
    private readonly tenants: TenantService,
    private readonly patients: PatientService,
  ) {}

  /**
   * 医生生成一次性认领码（有效期 24 小时）。
   */
  createClaimCode(a: Actor, patientId: string): { claim_id: string; code: string; expires_at: string } {
    const t = this.tenants.of(a.userId, 'work')
    if (t.kind !== 'org') throw new PatientError('org_only', '生成认领码只能在医院机构内操作', 403)
    this.patients.assertEditable({ ...a, space: 'work' }, patientId)

    const code = generateCode()
    const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString()
    const row = this.store.addClaim({
      code,
      tenant_id: t.id,
      patient_id: patientId,
      created_by: a.userId,
      expires_at: expiresAt,
    })

    return {
      claim_id: row.id,
      code: row.code,
      expires_at: row.expires_at,
    }
  }

  /**
   * 家人/患者在知家端输入认领码，指定要关联的家庭成员。
   */
  requestClaim(a: Actor, code: string, claimantPatientId: string): { claim_id: string; hospital_name: string; status: string } {
    const own = this.tenants.of(a.userId, a.space ?? 'work')
    if (own.kind !== 'personal') throw new PatientError('personal_only', '输入认领码只能在知家（个人空间）操作', 403)
    this.patients.assertEditable(a, claimantPatientId)

    const cleanCode = code.trim().toUpperCase()
    const claim = this.store.getClaimByCode(cleanCode)
    if (!claim) throw new PatientError('not_found', '认领码不存在或已失效', 404)

    if (claim.status === 'revoked') throw new PatientError('claim_revoked', '该认领码已被撤回', 400)
    if (claim.status === 'confirmed') throw new PatientError('claim_used', '该认领码已完成绑定', 400)
    if (claim.status === 'requested' && claim.claimant_user_id !== a.userId) {
      throw new PatientError('claim_conflict', '该认领码正在由其他申请处理中', 409)
    }

    if (Date.parse(claim.expires_at) <= Date.now()) {
      this.store.updateClaim(claim.id, { status: 'expired' })
      throw new PatientError('claim_expired', '认领码已超过 24 小时有效期失效', 400)
    }

    this.store.updateClaim(claim.id, {
      status: 'requested',
      claimant_user_id: a.userId,
      claimant_patient_id: claimantPatientId,
      requested_at: new Date().toISOString(),
    })

    const hospital = this.store.getTenant(claim.tenant_id)?.name ?? '合作医院'
    this.patients.sharedLog(own.id, claimantPatientId, a.userId, a.via, 'claim_request', `向 ${hospital} 申请绑定病历档案`)

    return {
      claim_id: claim.id,
      hospital_name: hospital,
      status: 'requested',
    }
  }

  /**
   * 医生侧确认绑定（防错绑，留审计；认领不用机构管理员或 AI 代处理）。
   * 可选二次校验（verify.birth_year）：与知家申请档案核对，防止误认领。
   */
  confirmClaim(a: Actor, claimId: string, verify?: { birth_year?: number }): { ok: boolean; link_id: string } {
    if (a.via === 'ai') throw new PatientError('forbidden', '医生确认认领绑定必须由医生本人在界面操作，AI 不能代为确认', 403)
    const t = this.tenants.of(a.userId, 'work')
    const claim = this.store.getClaim(claimId)
    if (!claim || claim.tenant_id !== t.id) throw new PatientError('not_found', '认领申请不存在', 404)
    if (this.tenants.roleOf(a.userId, 'work') !== 'admin') {
      this.patients.assertEditable({ ...a, space: 'work' }, claim.patient_id)
    }

    if (claim.status !== 'requested') {
      throw new PatientError('invalid_status', `当前认领状态为 ${claim.status}，无法确认`, 400)
    }
    if (Date.parse(claim.expires_at) <= Date.now()) {
      this.store.updateClaim(claim.id, { status: 'expired' })
      throw new PatientError('claim_expired', '认领码已过期失效', 400)
    }

    if (!claim.claimant_user_id || !claim.claimant_patient_id) {
      throw new PatientError('incomplete_request', '缺少申请人家庭档案信息', 400)
    }

    // 二次核验：若提供出生年份，核对是否与知家档案匹配（防错选）
    if (verify?.birth_year !== undefined && typeof verify.birth_year === 'number') {
      const markers = this.patients.memberMarkers(claim.claimant_user_id, claim.claimant_patient_id)
      if (markers?.birth_year && markers.birth_year !== verify.birth_year) {
        throw new PatientError('verification_failed', `患者出生年份核对不一致（档案为 ${markers.birth_year} 年）`, 400)
      }
    }

    const link = this.store.transaction(() => {
      const created = this.store.addPersonLink({
        tenant_id: t.id,
        hospital_patient_id: claim.patient_id,
        claimant_user_id: claim.claimant_user_id!,
        claimant_patient_id: claim.claimant_patient_id!,
        claim_id: claim.id,
        verified_by: a.userId,
      })

      this.store.updateClaim(claim.id, {
        status: 'confirmed',
        confirmed_by: a.userId,
        confirmed_at: new Date().toISOString(),
      })
      return created
    })

    // 在患者和知家两端分别记审计日志
    const personalTenant = this.tenants.of(claim.claimant_user_id, 'personal')
    this.patients.sharedLog(personalTenant.id, claim.claimant_patient_id, a.userId, a.via, 'claim_confirmed', `${t.name} 已确认绑定病历档案`)

    return { ok: true, link_id: link.id }
  }

  /**
   * 撤销认领码或解除关联绑定。
   */
  revokeClaim(a: Actor, claimId: string): { ok: boolean } {
    const claim = this.store.getClaim(claimId)
    if (!claim) throw new PatientError('not_found', '认领申请不存在', 404)

    // 检查权限：创建医生/所属机构，或申请的家属本人
    const t = this.tenants.of(a.userId, a.space ?? 'work')
    const isHospital = t.id === claim.tenant_id
    const isClaimant = a.userId === claim.claimant_user_id
    if (!isHospital && !isClaimant) throw new PatientError('not_found', '认领申请不存在', 404)
    if (isHospital && !isClaimant && this.tenants.roleOf(a.userId, a.space ?? 'work') !== 'admin') {
      this.patients.assertEditable({ ...a, space: 'work' }, claim.patient_id)
    }

    this.store.transaction(() => {
      this.store.updateClaim(claim.id, {
        status: 'revoked',
        revoked_by: a.userId,
        revoked_at: new Date().toISOString(),
      })

      // 如果已经有关联的 person_link，一并解除
      const links = this.store.listLinksForHospitalPatient(claim.tenant_id, claim.patient_id)
      for (const l of links) {
        if (l.claim_id === claim.id && l.status === 'active') {
          this.store.revokePersonLink(l.id, a.userId)
        }
      }
    })

    return { ok: true }
  }

  /**
   * 医生查看患者的认领历史和绑定关系。
   */
  listPatientClaims(a: Actor, patientId: string) {
    const t = this.tenants.of(a.userId, 'work')
    this.patients.read(a, patientId)
    const claims = this.store.listClaimsForPatient(t.id, patientId)
    const links = this.store.listLinksForHospitalPatient(t.id, patientId)
    return {
      claims: claims.map(c => {
        let claimantInfo: { birth_year?: number | null } | undefined
        if (c.status === 'requested' && c.claimant_user_id && c.claimant_patient_id) {
          const markers = this.patients.memberMarkers(c.claimant_user_id, c.claimant_patient_id)
          claimantInfo = { birth_year: markers?.birth_year ?? null }
        }
        return {
          id: c.id,
          code: c.code,
          status: Date.parse(c.expires_at) <= Date.now() && c.status === 'active' ? 'expired' : c.status,
          expires_at: c.expires_at,
          created_at: c.created_at,
          requested_at: c.requested_at,
          confirmed_at: c.confirmed_at,
          claimant_info: claimantInfo,
        }
      }),
      links: links.map(l => ({
        id: l.id,
        status: l.status,
        verified_at: l.verified_at,
        created_at: l.created_at,
      })),
    }
  }

  /**
   * 家人查看知家成员关联绑定的机构病历。
   */
  listMemberLinks(a: Actor, claimantPatientId: string) {
    const own = this.tenants.of(a.userId, a.space ?? 'work')
    this.patients.read(a, claimantPatientId)
    const links = this.store.listLinksForClaimant(a.userId, claimantPatientId)
    return links.map(l => {
      const hospital = this.store.getTenant(l.tenant_id)
      return {
        id: l.id,
        hospital_id: l.tenant_id,
        hospital_name: hospital?.name ?? '合作医院',
        status: l.status,
        verified_at: l.verified_at,
      }
    })
  }
}
