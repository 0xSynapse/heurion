import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { DatasetService, parseCsv } from '../src/datasets/service.ts'
import type { Ingest } from '../src/datasets/ingest.ts'
import { buildNomogram } from '../src/research/prediction-models.ts'
import { StudyError, StudyService } from '../src/research/service.ts'
import { SubjectVarService } from '../src/research/subject-vars.ts'
import { ImagingReviewService } from '../src/imaging/review.ts'
import { ImagingStudyService } from '../src/imaging/studies.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientError, PatientService, type Actor } from '../src/tenancy/patients.ts'
import { dicom, FakeOrthanc } from './imaging-fakes.ts'

const ingest: Ingest = async (_owner, src) => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-ing-'))
  copyFileSync(src, join(dir, 'data.csv'))
  const recs = parseCsv(readFileSync(src, 'utf8'))
  return {
    csv: join(dir, 'data.csv'), cleanup: () => {},
    profile: { ok: true, rows: recs.length - 1, truncated: false, columns: (recs[0] ?? []).map(name => ({ name, type: 'text' as const, missing: 0, unique: 1 })) },
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function env() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'sv-pt-')), tenants, keys, store)
  const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'sv-ds-')), ingest)
  const studies = new StudyService(store, datasets)
  const hosp = store.createTenant({ name: '医院', kind: 'org' })
  const user = store.createUser({ username: 'pi', display_name: 'PI', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } })
  const a: Actor = { userId: user.id, via: 'user' }
  const ai: Actor = { userId: user.id, via: 'ai' }
  const year = new Date().getUTCFullYear()
  const pts = [0, 1, 2].map(i => patients.create(a, { sex: 'M', birth_year: year - 60 - i, tags: [] }))
  const study = studies.create(user.id, { title: '队列', design: 'retrospective_cohort' })
  patients.enroll(a, study.id, pts.map(p => p.id))
  const svars = new SubjectVarService(studies, patients, datasets)
  return { store, patients, datasets, studies, svars, study, pts, a, ai, user }
}

describe('研究变量：来源与核实状态', () => {
  it('手工录入为未核实；研究者核实后记录核实人与时间；改值后回到未核实', () => {
    const t = env()
    const r = t.svars.manual(t.a, t.study.id, [{ subject_id: 'S001', var_id: 'followup_months', value: '12.5' }, { subject_id: 'S001', var_id: 'os_status', value: 1 }])
    expect(r.written).toBe(2)
    let v = t.svars.list(t.a, t.study.id).values.find(x => x.var_id === 'followup_months')!
    expect(v).toMatchObject({ subject_id: 'S001', value: 12.5, source: 'ecrf_manual', status: 'unverified', entered_via: 'user', verified_by: null })

    expect(t.svars.verify(t.a, t.study.id, { var_id: 'followup_months' }).verified).toBe(1)
    v = t.svars.list(t.a, t.study.id).values.find(x => x.var_id === 'followup_months')!
    expect(v.status).toBe('verified')
    expect(v.verified_by).toBe(t.user.id)
    expect(v.verified_at).toBeTruthy()

    t.svars.manual(t.a, t.study.id, [{ subject_id: 'S001', var_id: 'followup_months', value: 13 }])
    v = t.svars.list(t.a, t.study.id).values.find(x => x.var_id === 'followup_months')!
    expect(v).toMatchObject({ value: 13, status: 'unverified', verified_by: null })

    // 清除 = 删除，不补值
    expect(t.svars.manual(t.a, t.study.id, [{ subject_id: 'S001', var_id: 'followup_months', value: null }]).cleared).toBe(1)
    const sum = t.svars.list(t.a, t.study.id).summary.find(s => s.var_id === 'followup_months')!
    expect(sum).toMatchObject({ entered: 0, verified: 0, missing: 3 })
  })

  it('AI 录入一律未核实，且不能核实', () => {
    const t = env()
    t.svars.manual(t.ai, t.study.id, [{ subject_id: 'S002', var_id: 'treatment_arm', value: '干预组' }])
    const v = t.svars.list(t.a, t.study.id).values.find(x => x.var_id === 'treatment_arm')!
    expect(v).toMatchObject({ status: 'unverified', entered_via: 'ai' })
    expect(() => t.svars.verify(t.ai, t.study.id, { var_id: 'treatment_arm' })).toThrow(PatientError)
    expect(t.svars.list(t.a, t.study.id).values.find(x => x.var_id === 'treatment_arm')!.status).toBe('unverified')
  })

  it('校验值与来源：事件只能 0/1、时间不能为负；影像变量不能手工录入', () => {
    const t = env()
    const r = t.svars.manual(t.a, t.study.id, [
      { subject_id: 'S001', var_id: 'os_status', value: 2 },
      { subject_id: 'S001', var_id: 'followup_months', value: -1 },
      { subject_id: 'S999', var_id: 'followup_months', value: 3 },
    ])
    expect(r.written).toBe(0)
    expect(r.skipped.map(s => s.reason)).toEqual(['事件只能是 0 或 1：2', '时间不能为负', '受试者不在本研究，或你不在其诊疗组'])
    expect(() => t.svars.manual(t.a, t.study.id, [{ subject_id: 'S001', var_id: 'l3_smi', value: 45 }])).toThrow(StudyError)
  })

  it('从数据集按列映射导入：记录数据集 id 与列名；空单元格不写入', async () => {
    const t = env()
    const csv = 'sid,arm,fu,death\nS001,A,10,1\nS002,B,,0\nS003,A,7,x\n'
    const { dataset } = t.datasets.upload(t.user.id, 'outcomes.csv', Buffer.from(csv), { name: '随访登记' })
    await t.datasets.idle()
    const r = t.svars.importDataset(t.a, t.study.id, { dataset_id: dataset.id, subject_col: 'sid', mapping: { treatment_arm: 'arm', followup_months: 'fu', os_status: 'death' } })
    expect(r.written).toBe(7)
    expect(r.empty_cells).toBe(1)
    expect(r.skipped).toEqual([{ subject_id: 'S003', var_id: 'os_status', reason: '不是数字：x' }])
    const vals = t.svars.list(t.a, t.study.id).values
    expect(vals.find(v => v.subject_id === 'S002' && v.var_id === 'followup_months')).toBeUndefined()
    const arm = vals.find(v => v.subject_id === 'S001' && v.var_id === 'treatment_arm')!
    expect(arm).toMatchObject({ value: 'A', source: 'dataset_import', status: 'unverified' })
    expect(arm.source_ref).toMatchObject({ dataset_id: dataset.id, column: 'arm' })
    expect(() => t.svars.importDataset(t.a, t.study.id, { dataset_id: dataset.id, subject_col: 'sid', mapping: { l3_smi: 'fu' } })).toThrow(/影像分析记录/)
  })

  it('从影像分析记录导入：只取实测值并记录方法；没有身高的记录不采用 SMI', () => {
    const t = env()
    t.patients.addImagingRecord(t.a, t.pts[0]!.id, {
      title: 'L3 体成分', report_date: '2026-09-01', model_id: 'whole_body_ct_segmenter', modality: 'CT', key_slice_png: PNG,
      metrics: { patient_height_m: 1.7, body_composition: { skeletal_muscle_index_cm2_m2: 48.2, vat_to_sat_ratio: 0.9 } },
    })
    t.patients.addImagingRecord(t.a, t.pts[1]!.id, {
      title: 'L3 体成分', report_date: '2026-09-02', model_id: 'whole_body_ct_segmenter', modality: 'CT', key_slice_png: PNG,
      metrics: { body_composition: { skeletal_muscle_index_cm2_m2: 40.1, vat_to_sat_ratio: 1.2 } },
    })
    const r = t.svars.importImaging(t.a, t.study.id)
    expect(r.written).toBe(3)
    const vals = t.svars.list(t.a, t.study.id).values
    const smi = vals.find(v => v.subject_id === 'S001' && v.var_id === 'l3_smi')!
    expect(smi).toMatchObject({ value: 48.2, source: 'imaging_analysis', status: 'unverified' })
    expect(smi.method).toContain('whole_body_ct_segmenter')
    expect(smi.method).toContain('身高 1.7 m')
    expect(smi.source_ref.imaging_record_id).toBeTruthy()
    expect(vals.find(v => v.subject_id === 'S002' && v.var_id === 'l3_smi')).toBeUndefined()
    expect(vals.find(v => v.subject_id === 'S002' && v.var_id === 'vat_to_sat')!.value).toBe(1.2)
    expect(r.skipped).toContainEqual({ subject_id: 'S002', var_id: 'l3_smi', reason: '影像记录没有身高，不采用 SMI' })
    expect(r.skipped).toContainEqual({ subject_id: 'S003', var_id: 'l3_smi', reason: '没有影像分析记录' })
  })

  it('T2.8 肺结节科研变量：只取定稿快照数据（类型、平均径、体积、实性成分），未定稿不导入，定稿后未重签的修改不影响已签值', async () => {
    const t = env()
    const admin = t.store.createUser({ username: 'admin', display_name: '主任', password_hash: 'x', tenant: { id: t.store.getUser(t.user.id)!.tenant_id!, role: 'admin' } })
    const rev = t.store.createUser({ username: 'rev', display_name: '审核医师', password_hash: 'x', tenant: { id: t.store.getUser(t.user.id)!.tenant_id!, role: 'member' } })
    t.patients.addMember(t.a, t.pts[0]!.id, rev.id)
    const orthanc = new FakeOrthanc()
    const imgSvc = new ImagingStudyService(t.patients, orthanc, { acceptIdentified: true })
    const reviewSvc = new ImagingReviewService(t.patients)
    reviewSvc.setReadingRole({ userId: admin.id, via: 'user' }, rev.id, 'reviewer', (u, tid) => t.store.getUser(u)?.tenant_id === tid)

    const dicomStudy = (await imgSvc.importDicom(t.a, t.pts[0]!.id, [{ name: 'IM1', bytes: dicom('1.2.840.113619.2.55.3.9901', '1.2.840.113619.2.55.3.9901.1', '1') }])).studies[0]!
    const n1 = imgSvc.addLesion(t.a, dicomStudy.id, {
      kind: 'lung_nodule', source: 'manual', label: '主病灶', location: 'RUL',
      metrics: { nodule_type: 'part_solid', mean_diameter_mm: 14.2, volume_mm3: 1120, solid_core_diameter_mm: 6.4, segmentation: 'vista3d' },
    })

    // 1) 尚未定稿时：不能导入结节科研变量
    const beforeSign = t.svars.importImaging(t.a, t.study.id, { var_ids: ['nodule_type', 'nodule_mean_diameter_mm', 'nodule_volume_mm3', 'nodule_solid_core_mm'] })
    expect(beforeSign.written).toBe(0)
    expect(beforeSign.skipped).toContainEqual({ subject_id: 'S001', var_id: 'nodule_mean_diameter_mm', reason: '有影像检查但尚未定稿（科研只取定稿数据）' })

    // 2) 初写提交并由审核医师定稿 v1
    reviewSvc.submitRead(t.a, dicomStudy.id)
    const V: Actor = { userId: rev.id, via: 'user' }
    reviewSvc.finalize(V, dicomStudy.id, { expected_revision: reviewSvc.view(V, dicomStudy.id).revision })

    // 3) 定稿后又改了病灶但尚未再次定稿：导入的仍是第 1 版定稿快照的值（14.2 mm，而不是未签字的 19.9 mm）
    imgSvc.editLesion(t.a, n1.id, { metrics: { nodule_type: 'solid', mean_diameter_mm: 19.9, volume_mm3: 2500, solid_core_diameter_mm: 19.9, segmentation: 'vista3d' } })
    const afterSign = t.svars.importImaging(t.a, t.study.id, { var_ids: ['nodule_type', 'nodule_mean_diameter_mm', 'nodule_volume_mm3', 'nodule_solid_core_mm'] })
    expect(afterSign.written).toBe(4)
    const vals = t.svars.list(t.a, t.study.id).values.filter(v => v.subject_id === 'S001')
    expect(vals.find(v => v.var_id === 'nodule_type')?.value).toBe('部分实性')
    expect(vals.find(v => v.var_id === 'nodule_mean_diameter_mm')?.value).toBe(14.2)
    expect(vals.find(v => v.var_id === 'nodule_volume_mm3')?.value).toBe(1120)
    expect(vals.find(v => v.var_id === 'nodule_solid_core_mm')?.value).toBe(6.4)
    expect(vals.find(v => v.var_id === 'nodule_mean_diameter_mm')?.source_ref).toMatchObject({ dicom_study_id: dicomStudy.id, signoff_version: 1 })
  })
})

describe('列线图：基线生存率必须由调用方提供', () => {
  const predictors = [{ variable: 'age', label: '年龄', type: 'continuous' as const, beta: 0.03, min_val: 40, max_val: 80 }]
  it('不提供基线生存率时不输出绝对生存概率，只给总分标尺', () => {
    const n = buildNomogram({ predictors })
    expect(n.absolute_survival).toBe(false)
    expect(n.survival_scale).toEqual({ year1: [], year3: [], year5: [] })
    expect(n.svg).toContain('Baseline survival not supplied')
    expect(n.svg).not.toContain('1-Year Survival Prob.')
  })
  it('只提供部分年份时只画这些年份', () => {
    const n = buildNomogram({ predictors, baseline_survival: { year3: 0.7 } })
    expect(n.absolute_survival).toBe(true)
    expect(n.survival_scale.year1).toEqual([])
    expect(n.survival_scale.year3.length).toBeGreaterThan(0)
    expect(n.svg).toContain('3-Year Survival Prob.')
    expect(n.svg).not.toContain('1-Year Survival Prob.')
  })
})
