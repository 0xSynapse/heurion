import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { DatasetService, parseCsv } from '../src/datasets/service.ts'
import type { Ingest } from '../src/datasets/ingest.ts'
import { CohortService } from '../src/research/cohort.ts'
import { StudyService } from '../src/research/service.ts'
import { SubjectVarService } from '../src/research/subject-vars.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { assessRecist, PatientError, PatientService, RECIST_NOTE, type Actor } from '../src/tenancy/patients.ts'

const ingest: Ingest = async (_owner, src) => {
  const dir = mkdtempSync(join(tmpdir(), 'dec-ing-'))
  copyFileSync(src, join(dir, 'data.csv'))
  const recs = parseCsv(readFileSync(src, 'utf8'))
  return { csv: join(dir, 'data.csv'), cleanup: () => {}, profile: { ok: true, rows: recs.length - 1, truncated: false, columns: (recs[0] ?? []).map(name => ({ name, type: 'text' as const, missing: 0, unique: 1 })) } }
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function env(root = mkdtempSync(join(tmpdir(), 'dec-pt-')), store = new Store(':memory:')) {
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const patients = new PatientService(root, tenants, keys, store)
  const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'dec-ds-')), ingest)
  const studies = new StudyService(store, datasets)
  return { root, store, patients, datasets, studies }
}

describe('RECIST 1.1 分类收紧', () => {
  const img = { model_id: 'lung_nodule_segmenter', modality: 'CT' }
  it('基线没有 ≥ 10 mm 靶病灶时不适用', () => {
    const r = assessRecist({ longest_diameter_mm: 8 }, { longest_diameter_mm: 4 }, img, img)
    expect(r).toMatchObject({ category: 'NA', reason: '基线没有 ≥ 10 mm 的可测量靶病灶' })
  })
  it('随访缺测值、缺测量方法或方法不一致时不适用', () => {
    expect(assessRecist({ longest_diameter_mm: 30 }, {}, img, img).reason).toBe('随访缺少对应靶病灶的长径测值')
    expect(assessRecist({ longest_diameter_mm: 30 }, { longest_diameter_mm: 10 }, {}, img).reason).toContain('缺少测量方法记录')
    expect(assessRecist({ longest_diameter_mm: 30, slice_thickness_mm: 1 }, { longest_diameter_mm: 10, slice_thickness_mm: 5 }, img, img).reason).toContain('层厚 1 / 5 mm')
    expect(assessRecist({ longest_diameter_mm: 30 }, { longest_diameter_mm: 10 }, img, { ...img, model_id: 'other' }).reason).toContain('分析模型')
  })
  it('按全部靶病灶直径总和计算；新发病灶判 PD；标注未经阅片确认', () => {
    const lesions = (...d: number[]) => ({ target_lesions: d.map(x => ({ longest_diameter_mm: x })) })
    // 基线 20 + 15（6 mm 的不算靶病灶）= 35 → 随访 12 + 10 = 22，-37.1% → PR
    const pr = assessRecist(lesions(20, 15, 6), lesions(12, 10, 9), img, img)
    expect(pr.category).toBe('PR')
    expect(pr.detail).toContain('2 个基线 ≥ 10 mm 靶病灶的直径总和由 35 mm 变为 22 mm')
    // 总和只 -10%，但有新发病灶 → PD
    const pd = assessRecist(lesions(20), { ...lesions(18), new_lesions: true }, img, img)
    expect(pd.category).toBe('PD')
    expect(pd.name).toContain('新发病灶')
    expect(assessRecist(lesions(20), lesions(0), img, img).category).toBe('CR')
    expect(assessRecist(lesions(20), lesions(25), img, img).category).toBe('PD')
    expect(assessRecist(lesions(20), lesions(19), img, img).category).toBe('SD')
    expect(RECIST_NOTE).toBe('按 RECIST 1.1 阈值计算，未经阅片确认')
  })
})

describe('AI 生成的影像报告存为待医生确认的草稿', () => {
  function setup(root?: string, store?: Store) {
    const t = env(root, store)
    const hosp = t.store.createTenant({ name: '医院', kind: 'org' })
    const user = t.store.createUser({ username: 'dr', display_name: 'Dr', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } })
    const a: Actor = { userId: user.id, via: 'user' }
    const p = t.patients.create(a, { sex: 'M', birth_year: 1970, tags: [] })
    t.patients.addImagingRecord(a, p.id, { title: 'HRCT', report_date: '2026-10-01', model_id: 'bronchiectasis_mucus_analyzer', metrics: { bar_max: 1.5 }, key_slice_png: PNG })
    return { ...t, a, ai: { userId: user.id, via: 'ai' } as Actor, p, user, hosp }
  }

  it('AI 生成 → pending；AI 不能确认；医生确认后 confirmed；医生本人生成直接 confirmed', () => {
    const t = setup()
    const r = t.patients.generateComprehensiveReport(t.ai, t.p.id, {})
    expect(r.saved_status).toBe('pending')
    let rec = t.patients.read(t.a, t.p.id).records.find(x => x.id === r.saved_record_id)!
    expect(rec).toMatchObject({ status: 'pending', origin: 'ai_report', confirmed_by: null })
    // 待确认页预览：医生能看到草稿全文与来源、状态
    const preview = t.patients.recordText(t.a, t.p.id, r.saved_record_id!)
    expect(preview).toMatchObject({ status: 'pending', origin: 'ai_report', kind: 'report' })
    expect(preview.text).toContain('影像量化所见报告')
    expect(preview.text).toContain('上述所见需结合临床与实验室检查判断')
    expect(() => t.patients.resolveRecord(t.ai, t.p.id, r.saved_record_id!, { accept: true })).toThrow(PatientError)
    t.patients.resolveRecord(t.a, t.p.id, r.saved_record_id!, { accept: true })
    rec = t.patients.read(t.a, t.p.id).records.find(x => x.id === r.saved_record_id)!
    expect(rec).toMatchObject({ status: 'confirmed', confirmed_by: t.user.id, origin: 'ai_report' })

    const own = t.patients.generateComprehensiveReport(t.a, t.p.id, {})
    expect(own.saved_status).toBe('confirmed')
    expect(t.patients.read(t.a, t.p.id).records.find(x => x.id === own.saved_record_id)).toMatchObject({ status: 'confirmed', origin: 'platform_report' })
    expect('urgency' in own).toBe(false)
  })

  it('迁移：以前 AI 生成并直接确认的报告改回待医生确认', () => {
    const t = setup()
    const own = t.patients.generateComprehensiveReport(t.a, t.p.id, {})
    // 模拟旧数据：AI 生成、直接 confirmed、没有 origin（访问日志记 via = ai）
    const tenantDir = readdirSync(t.root)[0]!
    const db = new DatabaseSync(join(t.root, tenantDir, 'patients.db'))
    db.prepare("INSERT INTO records (id, patient_id, kind, title, report_date, text_enc, status, created_by, created_at, confirmed_by, confirmed_at) VALUES ('rc_legacy', ?, 'report', '旧 AI 报告', '2026-09-01', NULL, 'confirmed', ?, '2026-09-01', ?, '2026-09-01')").run(t.p.id, t.user.id, t.user.id)
    db.prepare("INSERT INTO access_log (at, user_id, patient_id, action, via, detail) VALUES ('2026-09-01', ?, ?, 'record_confirm', 'ai', 'rc_legacy')").run(t.user.id, t.p.id)
    db.close()
    t.patients.close()

    const again = new PatientService(t.root, new TenantService(t.store, { devMode: false }), new TenantKeys(t.store, kekFrom({ secret: 'test-secret' })), t.store)
    const recs = again.read(t.a, t.p.id).records
    expect(recs.find(x => x.id === 'rc_legacy')).toMatchObject({ status: 'pending', origin: 'ai_report', confirmed_by: null })
    // 医生本人生成的不受影响
    expect(recs.find(x => x.id === own.saved_record_id)).toMatchObject({ status: 'confirmed' })
  })
})

describe('队列宽表：SMI 只取已核实值，不判定肌少症', () => {
  it('宽表没有「肌少症阳性」列；SMI 列只有已核实的值并注明来源', async () => {
    const t = env()
    const hosp = t.store.createTenant({ name: '医院', kind: 'org' })
    const user = t.store.createUser({ username: 'pi', display_name: 'PI', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } })
    const a: Actor = { userId: user.id, via: 'user' }
    const pts = [0, 1].map(i => t.patients.create(a, { sex: 'M', birth_year: 1960 + i, tags: [] }))
    for (const p of pts) {
      t.patients.addImagingRecord(a, p.id, { title: 'L3', report_date: '2026-09-01', model_id: 'whole_body_ct_segmenter', key_slice_png: PNG,
        metrics: { patient_height_m: 1.7, body_composition: { skeletal_muscle_index_cm2_m2: 41.5, sarcopenia_detected: true, vat_to_sat_ratio: 1.1 } } })
    }
    const study = t.studies.create(user.id, { title: '队列', design: 'retrospective_cohort' })
    t.patients.enroll(a, study.id, pts.map(p => p.id))
    const svars = new SubjectVarService(t.studies, t.patients, t.datasets)
    svars.importImaging(a, study.id, { var_ids: ['l3_smi'] })
    svars.verify(a, study.id, { items: [{ subject_id: 'S001', var_id: 'l3_smi' }] })

    const cohort = new CohortService(t.studies, t.patients, t.datasets)
    const { dataset } = await cohort.dataset(a, study.id, { shape: 'wide' })
    const csv = parseCsv(readFileSync(t.datasets.readyCsv(user.id, dataset.id).path, 'utf8'))
    const header = csv[0]!
    expect(header.join(',')).not.toMatch(/sarcopenia|smi_baseline|smi_latest|lung_rads/)
    const iv = header.indexOf('l3_smi_verified'), is = header.indexOf('l3_smi_source')
    expect(iv).toBeGreaterThan(0)
    const s1 = csv.find(r => r[0] === 'S001')!, s2 = csv.find(r => r[0] === 'S002')!
    expect(s1[iv]).toBe('41.5')
    expect(s1[is]).toContain('影像分析记录')
    expect(s1[is]).toContain('已核实')
    expect(s2[iv]).toBe('') // 未核实 → 不进宽表
  })
})
