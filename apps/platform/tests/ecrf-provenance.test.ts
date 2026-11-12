import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { DatasetService, parseCsv } from '../src/datasets/service.ts'
import type { Ingest } from '../src/datasets/ingest.ts'
import { CohortService } from '../src/research/cohort.ts'
import { EcrfService, labMatchesAliases } from '../src/research/ecrf.ts'
import { StudyService } from '../src/research/service.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'

const ingest: Ingest = async (_owner, src) => {
  const dir = mkdtempSync(join(tmpdir(), 'ecrf-ing-'))
  copyFileSync(src, join(dir, 'data.csv'))
  const recs = parseCsv(readFileSync(src, 'utf8'))
  const header = recs[0] ?? []
  return {
    csv: join(dir, 'data.csv'), cleanup: () => {},
    profile: { ok: true, rows: recs.length - 1, truncated: false, columns: header.map(name => ({ name, type: 'text' as const, missing: 0, unique: 1 })) },
  }
}

function setupEnv() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'ecrf-pt-')), tenants, keys, store)
  const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'ecrf-ds-')), ingest)
  const studies = new StudyService(store, datasets)
  const cohort = new CohortService(studies, patients, datasets)
  const ecrf = new EcrfService(studies, patients, datasets)
  const hosp = store.createTenant({ name: '研究中心', kind: 'org' })
  const user = store.createUser({ username: 'pi', display_name: 'PI', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } })
  const actor: Actor = { userId: user.id, via: 'user' }
  return { studies, patients, cohort, ecrf, actor, user }
}

describe('Auto-eCRF：化验同义词精确匹配', () => {
  it('HbA1c 不当成血红蛋白，CRP 不当成肌酐，尿微量白蛋白不当成血清白蛋白', () => {
    const hbAliases = ['hemoglobin', 'hgb', 'hb', '血红蛋白']
    const crAliases = ['creatinine', 'scr', 'cr', '肌酐', '血肌酐']
    const albAliases = ['albumin', 'alb', '白蛋白', '血清白蛋白']
    expect(labMatchesAliases({ test_key: 'hba1c', test_name: 'HbA1c' }, hbAliases)).toBe(false)
    expect(labMatchesAliases({ test_key: 'hba1c', test_name: '糖化血红蛋白(HbA1c)' }, hbAliases)).toBe(false)
    expect(labMatchesAliases({ test_key: 'x', test_name: 'Hb A1c' }, hbAliases)).toBe(false)
    expect(labMatchesAliases({ test_key: 'crp', test_name: 'C 反应蛋白 (CRP)' }, crAliases)).toBe(false)
    expect(labMatchesAliases({ test_key: 'umalb', test_name: '尿微量白蛋白' }, albAliases)).toBe(false)
    // 正例：整词、括号缩写、大小写与空白差异都能匹配
    expect(labMatchesAliases({ test_key: 'hemoglobin', test_name: '血红蛋白' }, hbAliases)).toBe(true)
    expect(labMatchesAliases({ test_key: 'x', test_name: '血红蛋白(Hb)' }, hbAliases)).toBe(true)
    expect(labMatchesAliases({ test_key: 'x', test_name: '肌酐（Cr）' }, crAliases)).toBe(true)
    expect(labMatchesAliases({ test_key: 'x', test_name: ' Serum Creatinine ' }, ['serum creatinine'])).toBe(true)
    expect(labMatchesAliases({ test_key: 'nt_probnp', test_name: 'NT-proBNP' }, ['nt_pro_bnp', 'ntprobnp', 'nt-probnp'])).toBe(true)
  })

  it('端到端：只有 HbA1c / CRP / 尿微量白蛋白时，血红蛋白、肌酐、白蛋白为缺失；年龄性别标为主档案来源且未核实；不输出写死的置信度', async () => {
    const { studies, patients, cohort, ecrf, actor, user } = setupEnv()
    const study = studies.create(user.id, { title: '糖尿病队列', design: 'retrospective_cohort' })
    const pt = patients.create(actor, { sex: 'F', birth_year: 1970, tags: [] })
    // 研究快照只纳入挂在报告原件上的已确认化验
    const f = patients.addFile(actor, pt.id, { name: 'lab.pdf', mime: 'application/pdf', bytes: Uint8Array.from([1]), report_date: '2025-06-01' })
    patients.addRecordLab(actor, pt.id, f.record.id, { test_name: 'HbA1c', value: 7.2, unit: '%' })
    patients.addRecordLab(actor, pt.id, f.record.id, { test_name: 'CRP', value: 12, unit: 'mg/L' })
    patients.addRecordLab(actor, pt.id, f.record.id, { test_name: '尿微量白蛋白', value: 45, unit: 'mg/L' })
    patients.resolveRecord(actor, pt.id, f.record.id, { accept: true })
    cohort.enroll(actor, study.id, { patient_ids: [pt.id] })

    const res = await ecrf.extractCohortEcrf(actor, study.id, ['age', 'sex', 'hemoglobin', 'creatinine', 'albumin', 'hba1c'])
    const v = res.rows[0]!.variables
    expect(v.hba1c!.value).toBe(7.2)
    expect(v.hba1c!.source_tier).toBe('lab')
    expect(v.hemoglobin!.value).toBeNull()
    expect(v.creatinine!.value).toBeNull()
    expect(v.albumin!.value).toBeNull()
    expect(v.hemoglobin!.source_tier).toBe('none')

    // 年龄 / 性别取自患者主档案，不在核实流程内
    expect(v.age!.source_tier).toBe('registry')
    expect(v.age!.verified).toBe(false)
    expect(v.sex!.verified).toBe(false)

    // 不再输出按来源类型写死的置信度常数
    for (const cell of Object.values(v)) expect('confidence' in cell).toBe(false)
    expect('avg_confidence' in res.summary).toBe(false)
    expect(res.summary.verified_cells).toBe(0)
    expect(res.summary.cells_by_source_tier).toEqual({ registry: 2, lab: 1, imaging: 0, manual: 0 })
  })
})
