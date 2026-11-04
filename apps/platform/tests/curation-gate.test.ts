import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { AnnotationCurationService, evaluateNonInferiorityGate } from '../src/imaging/curation-gate.ts'
import { ImagingReviewService } from '../src/imaging/review.ts'
import { ImagingStudyService } from '../src/imaging/studies.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import { dicom, FakeOrthanc } from './imaging-fakes.ts'

/**
 * 标注库与模型发布门控（PRD W7.1–W7.4，T3.6）单元测试：
 * 1. W7.1：审核医师定稿后自动进入已核实标注库（保留 AI 原始输出、定稿终值、修改幅度与审核级别），未定稿初级医师标注拒绝入库；
 * 2. W7.2：双人独立标注抽样对比（体素 Dice 与径线 Bland-Altman 偏倚/95% LoA）；
 * 3. W7.4：模型非劣效门控（整体与大小/密度亚组）、临床课题负责人（PI）+ 信息科双人审批、一键回滚与 AI 安全边界拦截。
 */

const STUDY_UID = '1.2.840.113619.2.55.3.8801'
const SERIES_UID = `${STUDY_UID}.2`

function setupEnv() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-curation-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const makeUser = (username: string, display_name: string, role: 'admin' | 'member' = 'member') =>
    store.createUser({ username, display_name, password_hash: 'x', tenant: { id: hosp.id, role } }).id
  const admin = makeUser('admin_it', '信息科张工', 'admin')
  const pi = makeUser('pi_zhao', '赵主任（PI）')
  const reader = makeUser('dr_wang', '王医师（初写）')
  const reviewer = makeUser('dr_chen', '陈主任（审核）')
  const reviewer2 = makeUser('dr_liu', '刘主任（审核2）')

  const orthanc = new FakeOrthanc()
  const studies = new ImagingStudyService(patients, orthanc, { acceptIdentified: true })
  const review = new ImagingReviewService(patients, u => store.getUser(u)?.display_name ?? null)
  const curation = new AnnotationCurationService(patients)
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })

  review.setReadingRole(as(admin), reviewer, 'reviewer', (u, tid) => store.getUser(u)?.tenant_id === tid)
  review.setReadingRole(as(admin), reviewer2, 'reviewer', (u, tid) => store.getUser(u)?.tenant_id === tid)

  return { store, tenants, patients, hosp, admin, pi, reader, reviewer, reviewer2, orthanc, studies, review, curation, as }
}

const errCode = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (err) {
    return (err as { code?: string }).code ?? String(err)
  }
}

describe('T3.6 / W7.1 医生修正数据的结构化回收（已核实标注库）', () => {
  it('未定稿的初级医师标注拒绝进入已核实标注库；审核医师定稿后自动入库并保留 AI 原值、最终值与修改幅度', async () => {
    const t = setupEnv()
    const R = t.as(t.reader)
    const V = t.as(t.reviewer)
    const p = t.patients.create(R, { sex: 'F', birth_year: 1965 })
    t.patients.addMember(R, p.id, t.reviewer)

    const study = (await t.studies.importDicom(R, p.id, [{ name: 'IM1', bytes: dicom(STUDY_UID, SERIES_UID, '1') }])).studies[0]!
    const run = t.studies.startRun(R, study.id, { task: 'lung_nodule', model_id: 'lung_nodule_pipeline', model_version: 'v1.0.0' })
    t.studies.setRunStatus(R, run.id, 'done')

    // 1) AI 检出结节 1（后续被医生修边界：平均径 7.4 -> 8.2 mm，体积 210 -> 285 mm³）
    const l1 = t.studies.addLesion(R, study.id, {
      run_id: run.id,
      kind: 'lung_nodule',
      source: 'ai',
      label: '结节 1',
      location: 'RUL',
      seg_ref: 'se000000000001#1',
      metrics: { mean_diameter_mm: 7.4, volume_mm3: 210, nodule_type: 'solid' },
    })
    // 2) AI 检出结节 2（直接确认未改动）
    const l2 = t.studies.addLesion(R, study.id, {
      run_id: run.id,
      kind: 'lung_nodule',
      source: 'ai',
      label: '结节 2',
      location: 'LLL',
      seg_ref: 'se000000000001#2',
      metrics: { mean_diameter_mm: 5.2, volume_mm3: 75, nodule_type: 'pure_ggo' },
    })
    // 3) AI 检出结节 3（假阳性被否决）
    const l3 = t.studies.addLesion(R, study.id, {
      run_id: run.id,
      kind: 'lung_nodule',
      source: 'ai',
      label: '结节 3',
      location: 'RML',
      seg_ref: 'se000000000001#3',
      metrics: { mean_diameter_mm: 4.1, volume_mm3: 36, nodule_type: 'solid' },
    })

    // 初写医师确认、修边界、否决、并手工补充 1 枚漏检
    t.studies.reviewLesion(R, l1.id, { status: 'confirmed' })
    t.studies.editLesion(R, l1.id, {
      seg_ref: 'se000000000002#1',
      metrics: { mean_diameter_mm: 8.2, volume_mm3: 285, nodule_type: 'solid' },
    })
    t.studies.reviewLesion(R, l2.id, { status: 'confirmed' })
    t.studies.reviewLesion(R, l3.id, { status: 'rejected', reason: '血管断面' })
    const lManual = t.studies.addLesion(R, study.id, {
      kind: 'lung_nodule',
      source: 'manual',
      label: '医生补充 1',
      location: 'LUL',
      seg_ref: 'se000000000003#1',
      metrics: { mean_diameter_mm: 6.0, volume_mm3: 113, nodule_type: 'part_solid' },
    })
    t.review.submitRead(R, study.id)

    // 定稿前：标注库为空，且显式调用 ingestFinalizedStudy 被拒绝（unfinalized_not_admitted）
    expect(t.curation.listEntries(R, { study_id: study.id })).toHaveLength(0)
    expect(errCode(() => t.curation.ingestFinalizedStudy(R, study.id))).toBe('unfinalized_not_admitted')

    // 审核医师定稿（v1）：自动触发入库
    const view = t.review.view(V, study.id)
    const signoff = t.review.finalize(V, study.id, { expected_revision: view.revision })
    expect(signoff.version).toBe(1)

    const entries = t.curation.listEntries(V, { study_id: study.id })
    expect(entries).toHaveLength(4)

    const byLesion = new Map(entries.map(e => [e.lesion_id, e]))

    // 校验已修正结节（true_positive_refined）
    const e1 = byLesion.get(l1.id)!
    expect(e1.curation_category).toBe('true_positive_refined')
    expect(e1.quality_tier).toBe('high_verified')
    expect(e1.reviewer_id).toBe(t.reviewer)
    expect(e1.reviewer_role).toBe('reviewer')
    expect(e1.signoff_version).toBe(1)
    expect(e1.ai_original_seg_ref).toBe('se000000000001#1')
    expect(e1.seg_ref).toBe('se000000000002#1')
    expect(e1.ai_original_metrics).toMatchObject({ mean_diameter_mm: 7.4, volume_mm3: 210 })
    expect(e1.final_metrics).toMatchObject({ mean_diameter_mm: 8.2, volume_mm3: 285 })
    expect(e1.modification_magnitude).toMatchObject({
      was_refined: true,
      seg_ref_changed: true,
      delta_mean_diameter_mm: 0.8,
      delta_volume_mm3: 75,
    })

    // 校验直接确认结节（true_positive_confirmed）
    const e2 = byLesion.get(l2.id)!
    expect(e2.curation_category).toBe('true_positive_confirmed')
    expect(e2.modification_magnitude.was_refined).toBe(false)
    expect(e2.modification_magnitude.delta_mean_diameter_mm).toBe(0)

    // 校验已否决假阳性（false_positive_rejected）
    const e3 = byLesion.get(l3.id)!
    expect(e3.curation_category).toBe('false_positive_rejected')
    expect(e3.status).toBe('rejected')
    expect(e3.reject_reason).toBe('血管断面')

    // 校验医生补充漏检（false_negative_added）
    const eManual = byLesion.get(lManual.id)!
    expect(eManual.curation_category).toBe('false_negative_added')
    expect(eManual.source).toBe('manual')
    expect(eManual.ai_original_metrics).toBeNull()

    // 定稿后若初写医师又改了病灶而未再次定稿：显式 ingestFinalizedStudy 拒绝（防止未定稿改动混入）
    t.studies.editLesion(R, l2.id, { metrics: { mean_diameter_mm: 5.8, volume_mm3: 95, nodule_type: 'pure_ggo' } })
    expect(errCode(() => t.curation.ingestFinalizedStudy(V, study.id))).toBe('unfinalized_not_admitted')
  })
})

describe('T3.6 / W7.2 双人独立标注抽样与医师间一致性报告', () => {
  it('记录两名高年资医师的独立标注并汇总 Dice 与 Bland-Altman 径线差异；同一人自比或 AI 录入拒绝', async () => {
    const t = setupEnv()
    const V1 = t.as(t.reviewer)
    const p = t.patients.create(V1, { sex: 'M', birth_year: 1960 })
    t.patients.addMember(V1, p.id, t.reviewer2)
    const study = (await t.studies.importDicom(V1, p.id, [{ name: 'IM1', bytes: dicom(STUDY_UID, SERIES_UID, '1') }])).studies[0]!

    // 同一医师不能作为双人独立标注
    expect(errCode(() => t.curation.recordDualReaderSample(V1, study.id, {
      lesion_key: 'N1',
      reader_a_id: t.reviewer,
      reader_b_id: t.reviewer,
      reader_a_diameter_mm: 8.2,
      reader_b_diameter_mm: 8.0,
      voxel_dice: 0.84,
    }))).toBe('invalid_dual_readers')

    // AI 禁止录入
    expect(errCode(() => t.curation.recordDualReaderSample(t.as(t.reviewer, 'ai'), study.id, {
      lesion_key: 'N1',
      reader_a_id: t.reviewer,
      reader_b_id: t.reviewer2,
      reader_a_diameter_mm: 8.2,
      reader_b_diameter_mm: 8.0,
      voxel_dice: 0.84,
    }))).toBe('forbidden')

    t.curation.recordDualReaderSample(V1, study.id, {
      lesion_key: 'N1',
      reader_a_id: t.reviewer,
      reader_b_id: t.reviewer2,
      reader_a_diameter_mm: 8.4,
      reader_b_diameter_mm: 8.0,
      voxel_dice: 0.86,
    })
    t.curation.recordDualReaderSample(V1, study.id, {
      lesion_key: 'N2',
      reader_a_id: t.reviewer,
      reader_b_id: t.reviewer2,
      reader_a_diameter_mm: 6.1,
      reader_b_diameter_mm: 6.3,
      voxel_dice: 0.82,
    })

    const report = t.curation.interObserverReport(V1)
    expect(report.sampled_studies).toBe(1)
    expect(report.total_paired_lesions).toBe(2)
    expect(report.mean_voxel_dice).toBe(0.84)
    expect(report.min_voxel_dice).toBe(0.82)
    expect(report.mean_abs_diameter_diff_mm).toBe(0.3)
    expect(report.bland_altman.mean_bias_mm).toBe(0.1)
    expect(report.bland_altman.loa_lower_mm).toBeLessThan(0)
    expect(report.bland_altman.loa_upper_mm).toBeGreaterThan(0)
  })
})

describe('T3.6 / W7.4 模型非劣效门控、PI + 信息科双人审批与一键回滚', () => {
  const baselineMetrics = {
    overall: { sensitivity: 0.88, fp_per_scan: 1.5, mean_dice: 0.81 },
    by_size: {
      '<6': { sensitivity: 0.72, dice: 0.74, n_gt: 15 },
      '6-<8': { sensitivity: 0.88, dice: 0.81, n_gt: 20 },
      '8-<15': { sensitivity: 0.94, dice: 0.85, n_gt: 20 },
      '>=15': { sensitivity: 0.96, dice: 0.88, n_gt: 10 },
    },
    by_density: {
      solid: { sensitivity: 0.91, dice: 0.84, n_gt: 40 },
      part_solid: { sensitivity: 0.86, dice: 0.79, n_gt: 15 },
      pure_ggo: { sensitivity: 0.80, dice: 0.76, n_gt: 10 },
    },
  }

  it('非劣效门控：整体与任意大小/密度亚组不低于上一版通过；任一亚组劣化即拦截并指出具体亚组', () => {
    const improved = {
      ...baselineMetrics,
      overall: { sensitivity: 0.90, fp_per_scan: 1.3, mean_dice: 0.83 },
    }
    expect(evaluateNonInferiorityGate(improved, baselineMetrics).passed).toBe(true)

    const degradedSubgroup = {
      ...baselineMetrics,
      overall: { sensitivity: 0.89, fp_per_scan: 1.4, mean_dice: 0.82 },
      by_density: {
        ...baselineMetrics.by_density,
        pure_ggo: { sensitivity: 0.71, dice: 0.76, n_gt: 10 }, // 磨玻璃亚组灵敏度下降
      },
    }
    const res = evaluateNonInferiorityGate(degradedSubgroup, baselineMetrics)
    expect(res.passed).toBe(false)
    expect(res.failures).toEqual([
      expect.objectContaining({
        metric: 'sensitivity',
        subgroup: 'density:pure_ggo',
        baseline_value: 0.8,
        candidate_value: 0.71,
      }),
    ])
  })

  it('完整发布闭环：首版上线 -> 劣化候选版被门控拦截 -> 合格 v1.1 经 PI 与信息科双人审批上线 -> 一键回滚至 v1.0；AI 全程禁止操作', () => {
    const t = setupEnv()
    const PI = t.as(t.pi)
    const IT = t.as(t.admin)
    const AI = t.as(t.admin, 'ai')

    // AI 禁止登记模型
    expect(errCode(() => t.curation.registerCandidateRelease(AI, {
      task: 'lung_nodule',
      model_id: 'lung_nodule_pipeline',
      version: 'v1.0.0',
      weights_sha256: 'sha256-v100',
      eval_metrics: baselineMetrics,
    }))).toBe('forbidden')

    // 1) 登记并上线 v1.0.0 基线版
    const v1 = t.curation.registerCandidateRelease(IT, {
      task: 'lung_nodule',
      model_id: 'lung_nodule_pipeline',
      version: 'v1.0.0',
      weights_sha256: 'sha256-v100',
      eval_metrics: baselineMetrics,
    })
    expect(v1.gate_passed).toBe(true)

    // 只有单人审批不能激活上线；同一人不能兼签 PI 与 IT
    t.curation.approveRelease(PI, v1.id, { role: 'pi', note: '临床评测达标' })
    expect(errCode(() => t.curation.activateRelease(IT, v1.id))).toBe('approval_incomplete')
    expect(errCode(() => t.curation.approveRelease(PI, v1.id, { role: 'it_admin' }))).toBe('dual_control_same_user')
    expect(errCode(() => t.curation.approveRelease(AI, v1.id, { role: 'it_admin' }))).toBe('forbidden')

    // 信息科完成第二人审批并激活 v1.0.0
    const v1Approved = t.curation.approveRelease(IT, v1.id, { role: 'it_admin', note: '容器镜像与哈希核验通过' })
    expect(v1Approved.status).toBe('approved')
    expect(errCode(() => t.curation.activateRelease(AI, v1.id))).toBe('forbidden')
    const v1Active = t.curation.activateRelease(IT, v1.id)
    expect(v1Active.status).toBe('active')
    expect(t.curation.activeRelease(PI, 'lung_nodule', 'lung_nodule_pipeline')?.version).toBe('v1.0.0')

    // 2) 登记一个假阳性率升高的候选版 v1.0.1-bad：自动与 v1.0.0 比对并判定门控不通过
    const vBad = t.curation.registerCandidateRelease(IT, {
      task: 'lung_nodule',
      model_id: 'lung_nodule_pipeline',
      version: 'v1.0.1-bad',
      weights_sha256: 'sha256-bad',
      eval_metrics: {
        ...baselineMetrics,
        overall: { sensitivity: 0.88, fp_per_scan: 2.4, mean_dice: 0.81 },
      },
    })
    expect(vBad.baseline_version).toBe('v1.0.0')
    expect(vBad.gate_passed).toBe(false)
    expect(errCode(() => t.curation.approveRelease(PI, vBad.id, { role: 'pi' }))).toBe('gate_not_passed')
    expect(errCode(() => t.curation.activateRelease(IT, vBad.id))).toBe('gate_not_passed')

    // 3) 登记通过非劣效门控的 v1.1.0 并经 PI + 信息科双签上线
    const v11 = t.curation.registerCandidateRelease(IT, {
      task: 'lung_nodule',
      model_id: 'lung_nodule_pipeline',
      version: 'v1.1.0',
      weights_sha256: 'sha256-v110',
      eval_metrics: {
        ...baselineMetrics,
        overall: { sensitivity: 0.91, fp_per_scan: 1.2, mean_dice: 0.84 },
      },
    })
    expect(v11.gate_passed).toBe(true)
    t.curation.approveRelease(PI, v11.id, { role: 'pi', note: 'v1.1 灵敏度提升' })
    t.curation.approveRelease(IT, v11.id, { role: 'it_admin', note: '准予上线' })
    t.curation.activateRelease(IT, v11.id)
    expect(t.curation.activeRelease(PI, 'lung_nodule', 'lung_nodule_pipeline')?.version).toBe('v1.1.0')

    // 4) 一键回滚：从 v1.1.0 回滚至上一版 v1.0.0（AI 禁止回滚）
    expect(errCode(() => t.curation.rollbackRelease(AI, {
      task: 'lung_nodule',
      model_id: 'lung_nodule_pipeline',
      reason: 'AI 尝试回滚',
    }))).toBe('forbidden')

    const rb = t.curation.rollbackRelease(IT, {
      task: 'lung_nodule',
      model_id: 'lung_nodule_pipeline',
      reason: '院内新扫描仪序列出现偶发伪影，回滚至 v1.0.0',
    })
    expect(rb.rolled_back.version).toBe('v1.1.0')
    expect(rb.rolled_back.status).toBe('rolled_back')
    expect(rb.restored.version).toBe('v1.0.0')
    expect(rb.restored.status).toBe('active')
    expect(t.curation.activeRelease(PI, 'lung_nodule', 'lung_nodule_pipeline')?.version).toBe('v1.0.0')
  })
})
