import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { TenantService } from '../src/auth/tenants.ts'
import { Accounts } from '../src/auth/accounts.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { DatasetService, parseCsv } from '../src/datasets/service.ts'
import type { Ingest } from '../src/datasets/ingest.ts'
import { buildApi } from '../src/http/api.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { CohortService } from '../src/research/cohort.ts'
import { PublicationBundleService, toBundleRecords } from '../src/research/publication-bundle.ts'
import { SubjectVarService } from '../src/research/subject-vars.ts'
import { StudyError, StudyService } from '../src/research/service.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'

const ingest: Ingest = async (_owner, src) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-ing-'))
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
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'pb-pt-')), tenants, keys, store)
  const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'pb-ds-')), ingest)
  const studies = new StudyService(store, datasets)
  const cohort = new CohortService(studies, patients, datasets)
  const hosp = store.createTenant({ name: '国家医学中心', kind: 'org' })
  const user = store.createUser({ username: 'pi_doctor', display_name: '课题组负责人', password_hash: 'hash', email: 'pi@hospital.org', tenant: { id: hosp.id, role: 'member' } })
  const actor: Actor = { userId: user.id, via: 'user' }
  const bundleService = new PublicationBundleService(studies, patients, datasets)
  return { store, studies, patients, datasets, cohort, bundleService, actor, user }
}

const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b!)

describe('投稿材料包：拒绝空研究', () => {
  it('研究没有入组受试者时抛出 StudyError（400），不模拟受试者', async () => {
    const { studies, bundleService, actor, user } = setupEnv()
    const study = studies.create(user.id, { title: '空研究', design: 'prospective_cohort' })
    const err = await bundleService.buildBundle(actor, study.id).catch(e => e)
    expect(err).toBeInstanceOf(StudyError)
    expect(err.code).toBe('empty_cohort')
    expect(err.status).toBe(400)
    expect(err.message).toContain('没有入组受试者')
  })

  it('路由 POST /api/studies/:sid/publication-bundle 对空研究返回 400 与中文提示', async () => {
    const { store, studies, patients, datasets, cohort, user } = setupEnv()
    const docs = new Documents(store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'pb-render-'))),
      accounts: new Accounts(store, { secret: 'test-secret', devMode: true, devToken: 'dev', devUser: user.id }),
      devMode: true, devUser: user.id, datasets, studies, patients, cohort,
    })
    const study = studies.create(user.id, { title: '空研究', design: 'prospective_cohort' })
    const token = `Bearer ${issueToken('test-secret', { u: user.id, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: user.token_version })}`
    const res = await app.request(`/api/studies/${study.id}/publication-bundle`, { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; code: string }
    expect(body.code).toBe('empty_cohort')
    expect(body.error).toMatch(/[一-龥]/)
  })
})

describe('投稿材料包：缺失值不补', () => {
  it('toBundleRecords 对未记录字段一律给 null', () => {
    const [r] = toBundleRecords([{ subject_id: 'S001', sex: null, age_at_enroll: null, vars: {} }])
    expect(r).toEqual({ subject_id: 'S001', treatment_arm: null, age: null, sex: null, l3_smi: null, vat_to_sat: null, followup_months: null, os_status: null })
  })

  it('真实入组的受试者：缺性别 / 年龄 / 随访 / 结局时保持缺失，Table 1 显示 Missing，不生成 KM、Love Plot、ROC', async () => {
    const { studies, patients, bundleService, actor, user } = setupEnv()
    const year = new Date().getUTCFullYear()
    const p1 = patients.create(actor, { sex: 'M', birth_year: year - 60, tags: [] })
    const p2 = patients.create(actor, { tags: [] })
    const study = studies.create(user.id, { title: '胃癌队列', design: 'prospective_cohort' })
    patients.enroll(actor, study.id, [p1.id, p2.id])

    const bundle = await bundleService.buildBundle(actor, study.id)
    const files = unzipSync(bundle.zipBuffer)
    const names = Object.keys(files)
    expect(bundle.totalFiles).toBe(names.length)

    // 缺失如实记录
    expect(bundle.report.n_subjects).toBe(2)
    expect(bundle.report.missing.age).toBe(1)
    expect(bundle.report.missing.sex).toBe(1)
    expect(bundle.report.missing.followup_months).toBe(2)
    expect(bundle.report.missing.os_status).toBe(2)
    expect(bundle.report.survival.included).toBe(0)
    expect(bundle.report.survival.excluded_missing_time_or_status).toBe(2)

    // Table 1：单列总体描述，缺失数可见；没有补出来的「未知」性别或另一位受试者的年龄
    const docx = unzipSync(files['Table1_Baseline_Characteristics.docx']!)
    const xml = text(docx['word/document.xml'])
    expect(xml).toContain('Missing')
    expect(xml).not.toContain('未知')
    expect(xml).not.toContain('试验组')
    expect(xml).not.toContain('对照组')

    // 没有结局数据就不画 KM / 森林图；不生成 Love Plot、列线图、ROC/DCA
    expect(names.some(n => /Kaplan|Forest|Love|Nomogram|ROC|DCA/i.test(n))).toBe(false)

    const ms = text(files['Manuscript_Statistical_Methods_and_Results.md'])
    expect(ms).toContain('No imputation was performed')
    expect(ms).toContain('No survival analysis was performed: 2 of 2')
    expect(ms).not.toMatch(/Propensity Score|PSM|IPTW|post-matching|Schoenfeld|AUC/)
    const manifest = text(files['README_Submission_Manifest.txt'])
    expect(manifest).toContain('2 excluded for missing follow-up time or outcome status')
    const py = text(files['Statistical_Reproducibility_Script.py'])
    expect(py).not.toContain('0.62')
    expect(py).not.toContain('verified successfully')
  })
})

describe('投稿材料包：流向图与 Love Plot 不编造', () => {
  it('没有纳排记录时流向图只有入组 → 分析 → 各组人数，无编造的排除项', async () => {
    const { studies, patients, actor, user } = setupEnv()
    const study = studies.create(user.id, { title: '队列', design: 'retrospective_cohort' })
    const year = new Date().getUTCFullYear()
    const p1 = patients.create(actor, { sex: 'F', birth_year: year - 50, tags: [] })
    const p2 = patients.create(actor, { sex: 'M', birth_year: year - 55, tags: [] })
    const p3 = patients.create(actor, { sex: 'M', birth_year: year - 65, tags: [] })
    patients.enroll(actor, study.id, [p1.id, p2.id, p3.id])
    patients.unenroll(actor, study.id, p3.id)

    const svc = new PublicationBundleService(studies, patients)
    const bundle = await svc.buildBundle(actor, study.id)
    const svg = text(unzipSync(bundle.zipBuffer)['Figure1_Participant_Flow.svg'])
    expect(svg).toContain('入组受试者 (Enrolled)')
    expect(svg).toContain('n = 3')
    expect(svg).toContain('移出研究 (Withdrawn): n = 1')
    expect(svg).toContain('纳入本次分析 (Included)')
    expect(svg).toContain('n = 2')
    // 原来编造的排除原因、评估人数与失访格子都不应出现
    expect(svg).not.toMatch(/Assessed for eligibility|Excluded: n|未行对比增强|合并其他恶性肿瘤|关键生化检验|失访|依从性/)
    // 没有分组信息时不按 i%2 分组
    expect(svg).not.toMatch(/试验组|对照组/)
    expect(bundle.report.grouped).toBe(false)
  })

  it('有已核实的分组与随访时：按真实分组做 KM / Cox，排除缺随访或结局者并写明人数；仍不生成匹配后 Love Plot', async () => {
    const { studies, patients, datasets, actor, user } = setupEnv()
    const study = studies.create(user.id, { title: '分组队列', design: 'retrospective_cohort' })
    const year = new Date().getUTCFullYear()
    const pts = Array.from({ length: 13 }, (_, i) => patients.create(actor, { sex: i % 3 ? 'M' : 'F', birth_year: year - 50 - i, tags: [] }))
    patients.enroll(actor, study.id, pts.map(p => p.id))
    const data: Array<[string | null, number | null, number | null]> = [
      ['A 方案', 10, 1], ['A 方案', 14, 0], ['A 方案', 20, 1], ['A 方案', 25, 0], ['A 方案', 30, 1], ['A 方案', null, 1],
      ['B 方案', 5, 1], ['B 方案', 8, 1], ['B 方案', 12, 1], ['B 方案', 18, 0], ['B 方案', 22, 1], ['B 方案', 9, null],
      [null, 15, 0],
    ]
    const svars = new SubjectVarService(studies, patients, datasets)
    const entries = data.flatMap(([arm, t, e], i) => {
      const sid = `S${String(i + 1).padStart(3, '0')}`
      return [
        ...(arm ? [{ subject_id: sid, var_id: 'treatment_arm', value: arm }] : []),
        ...(t !== null ? [{ subject_id: sid, var_id: 'followup_months', value: t }] : []),
        ...(e !== null ? [{ subject_id: sid, var_id: 'os_status', value: e }] : []),
      ]
    })
    expect(svars.manual(actor, study.id, entries).written).toBe(entries.length)
    for (const v of ['treatment_arm', 'followup_months', 'os_status']) svars.verify(actor, study.id, { var_id: v })

    const bundle = await new PublicationBundleService(studies, patients).buildBundle(actor, study.id)
    const files = unzipSync(bundle.zipBuffer)
    const names = Object.keys(files)

    expect(bundle.report.arms).toEqual([{ name: 'A 方案', n: 6 }, { name: 'B 方案', n: 6 }])
    expect(bundle.report.arm_missing).toBe(1)
    expect(bundle.report.survival.excluded_missing_time_or_status).toBe(2)
    expect(bundle.report.survival.excluded_missing_arm).toBe(1)
    expect(bundle.report.survival.included).toBe(10)
    expect(names).toContain('Figure2_Kaplan_Meier_Survival_Curve.svg')
    expect(names).toContain('Figure3_Cox_Forest_Plot.svg')
    expect(names.some(n => /Love/i.test(n))).toBe(false)

    const flow = text(files['Figure1_Participant_Flow.svg'])
    expect(flow).toContain('A 方案')
    expect(flow).toContain('分组缺失 (Arm missing)')

    const ms = text(files['Manuscript_Statistical_Methods_and_Results.md'])
    expect(ms).toContain('10 participants were included in the survival analysis; 2 for missing follow-up time or outcome status and 1 for missing treatment arm were excluded')
    expect(ms).toContain('unadjusted')
    expect(ms).toContain('| treatment_arm | eCRF 手工录入 | 12 | 0 | 1 / 13 |')
    expect(ms).not.toMatch(/Propensity Score|PSM|IPTW|post-matching|matched/)
    const xml = text(unzipSync(files['Table1_Baseline_Characteristics.docx']!)['word/document.xml'])
    expect(xml).toContain('Missing')
  })

  it('未核实的变量不进入分析：README 写明来源、核实状态与原因', async () => {
    const { studies, patients, datasets, actor, user } = setupEnv()
    const study = studies.create(user.id, { title: '未核实队列', design: 'retrospective_cohort' })
    const year = new Date().getUTCFullYear()
    const pts = Array.from({ length: 4 }, (_, i) => patients.create(actor, { sex: 'M', birth_year: year - 60 - i, tags: [] }))
    patients.enroll(actor, study.id, pts.map(p => p.id))
    const svars = new SubjectVarService(studies, patients, datasets)
    svars.manual(actor, study.id, ['S001', 'S002', 'S003', 'S004'].flatMap((sid, i) => [
      { subject_id: sid, var_id: 'treatment_arm', value: i % 2 ? '对照' : '干预' },
      { subject_id: sid, var_id: 'followup_months', value: 10 + i },
      { subject_id: sid, var_id: 'os_status', value: i % 2 },
    ]))
    // 只核实分组，随访与结局未核实
    svars.verify(actor, study.id, { var_id: 'treatment_arm' })

    const bundle = await new PublicationBundleService(studies, patients).buildBundle(actor, study.id)
    const files = unzipSync(bundle.zipBuffer)
    expect(bundle.report.grouped).toBe(true)
    expect(bundle.report.survival.generated).toBe(false)
    expect(Object.keys(files).some(n => /Kaplan/.test(n))).toBe(false)
    const fu = bundle.report.provenance.find(p => p.var_id === 'followup_months')!
    expect(fu).toMatchObject({ entered: 4, verified: 0, unverified_excluded: 4, missing: 4 })
    const readme = text(files['README_Submission_Manifest.txt'])
    expect(readme).toContain('followup_months (总随访时间): source eCRF 手工录入; 0 verified, 4 unverified (not used)')
    expect(readme).toContain('总随访时间：4 个值未经研究者核实，未进入 Table 1 与生存分析')
    // 年龄、性别不纳入核实流程，注明来源
    expect(readme).toContain('age, sex: 来源：患者主档案')
    expect(text(files['Manuscript_Statistical_Methods_and_Results.md'])).toContain('来源：患者主档案')
    // 未核实的随访时间不进 Table 1
    const xml = text(unzipSync(files['Table1_Baseline_Characteristics.docx']!)['word/document.xml'])
    expect(xml).not.toContain('总随访时间')
  })
})
