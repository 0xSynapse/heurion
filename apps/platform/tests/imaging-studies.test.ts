import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { buildApi } from '../src/http/api.ts'
import type { Orthanc } from '../src/imaging/orthanc.ts'
import { dicom, FakeOrthanc } from './imaging-fakes.ts'
import { expandUpload, ImagingStudyService } from '../src/imaging/studies.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'

function env() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-img-st-')), tenants, keys, store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const dr = store.createUser({ username: 'dr_wang', display_name: '王医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const other = store.createUser({ username: 'dr_zhao', display_name: '赵医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const orthanc = new FakeOrthanc()
  const svc = new ImagingStudyService(patients, orthanc)
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  return { store, patients, keys, hosp, dr, other, orthanc, svc, as }
}

const STUDY = '1.2.840.113619.2.55.3.1001'
const SERIES = '1.2.840.113619.2.55.3.1001.2'

describe('上传文件展开', () => {
  it('zip 里的 DICOM 入库，DICOMDIR、隐藏文件、非 DICOM 跳过并说明原因', () => {
    const zip = zipSync({
      'CT/IM0001': dicom(STUDY, SERIES, '1'), 'CT/IM0002': dicom(STUDY, SERIES, '2'), 'DICOMDIR': dicom(STUDY, SERIES, 'dir'),
      'readme.txt': new TextEncoder().encode('hello'), '__MACOSX/CT/._IM0001': new Uint8Array(10), 'CT/.DS_Store': new Uint8Array(10),
    })
    const r = expandUpload([{ name: 'study.zip', bytes: zip }, { name: 'IM0003', bytes: dicom(STUDY, SERIES, '3') }])
    expect(r.dicom.map(d => d.name).sort()).toEqual(['IM0003', 'study.zip/CT/IM0001', 'study.zip/CT/IM0002'])
    expect(r.skipped).toEqual([{ name: 'study.zip/DICOMDIR', reason: 'DICOMDIR 目录文件不入库' }, { name: 'study.zip/readme.txt', reason: '不是 DICOM 文件' }])
  })
})

describe('影像检查入库（W1.0）', () => {
  it('建检查与序列索引；UID、检查号只以密文存放；重复上传不重复建档', async () => {
    const t = env()
    const a = t.as(t.dr)
    const p = t.patients.create(a, { sex: 'F', birth_year: 1961 })
    const r = await t.svc.importDicom(a, p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }, { name: 'IM2', bytes: dicom(STUDY, SERIES, '2') }])
    expect(r.files).toMatchObject({ received: 2, uploaded: 2, duplicates: 0, skipped: [] })
    expect(r.conflicts).toBe(0)
    expect(r.studies).toHaveLength(1)
    expect(r.studies[0]).toMatchObject({ study_uid: STUDY, study_date: '2026-10-20', modalities: ['CT'], description: '胸部 CT 平扫', accession: 'ACC-778899', source: 'upload' })
    expect(r.studies[0]!.series).toEqual([expect.objectContaining({ series_uid: SERIES, slice_thickness: 1.25, kernel: 'B70f', instances: 2, body_part: 'CHEST' })])

    // 库里没有明文 UID 与检查号
    const db = t.patients.imagingLookup(a).db
    const raw = JSON.stringify([db.prepare('SELECT * FROM imaging_studies').all(), db.prepare('SELECT * FROM imaging_series').all()])
    expect(raw).not.toContain(STUDY)
    expect(raw).not.toContain('ACC-778899')

    const again = await t.svc.importDicom(a, p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }, { name: 'IM3', bytes: dicom(STUDY, SERIES, '3') }])
    expect(again.files).toMatchObject({ uploaded: 1, duplicates: 1 })
    const list = t.svc.listStudies(a, p.id, true)
    expect(list).toHaveLength(1)
    expect(list[0]!.series[0]!.instances).toBe(3)
    // AI 视图不含 UID 与检查号
    expect(JSON.stringify(t.svc.listStudies(t.as(t.dr, 'ai'), p.id))).not.toContain(STUDY)
    // 访问留痕
    expect(t.patients.accessLog(a, p.id).map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['imaging_upload', 'imaging_upload_update']))
  })

  it('同一检查已属于另一位患者时不关联，也不透露是谁', async () => {
    const t = env()
    const a = t.as(t.dr)
    const p1 = t.patients.create(a, { sex: 'F', birth_year: 1961 })
    const p2 = t.patients.create(a, { sex: 'M', birth_year: 1970 })
    await t.svc.importDicom(a, p1.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])
    const r = await t.svc.importDicom(a, p2.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])
    expect(r.conflicts).toBe(1)
    expect(r.studies).toEqual([])
    expect(t.svc.listStudies(a, p2.id)).toEqual([])
    expect(JSON.stringify(r)).not.toContain(p1.id)
  })

  it('只有诊疗组成员能上传；AI 不能上传；没有 DICOM 时说明原因', async () => {
    const t = env()
    const p = t.patients.create(t.as(t.dr), { sex: 'F', birth_year: 1961 })
    await expect(t.svc.importDicom(t.as(t.other), p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])).rejects.toMatchObject({ status: 404 })
    await expect(t.svc.importDicom(t.as(t.dr, 'ai'), p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])).rejects.toMatchObject({ code: 'forbidden' })
    await expect(t.svc.importDicom(t.as(t.dr), p.id, [{ name: 'a.txt', bytes: new TextEncoder().encode('x') }])).rejects.toMatchObject({ code: 'no_dicom', message: expect.stringContaining('不是 DICOM 文件') })
    expect(t.orthanc.instances.size).toBe(0)
  })

  it('按 StudyInstanceUID 查找：看不到患者的人当作不存在', async () => {
    const t = env()
    const p = t.patients.create(t.as(t.dr), { sex: 'F', birth_year: 1961 })
    const r = await t.svc.importDicom(t.as(t.dr), p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])
    expect(t.svc.resolveStudyUid(t.as(t.dr), STUDY).studyId).toBe(r.studies[0]!.id)
    expect(() => t.svc.resolveStudyUid(t.as(t.other), STUDY)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => t.svc.resolveStudyUid(t.as(t.dr), '1.2.3')).toThrow(expect.objectContaining({ status: 404 }))
  })
})

describe('AI 运行与病灶（T1.3）', () => {
  async function seeded() {
    const t = env()
    const a = t.as(t.dr)
    const p = t.patients.create(a, { sex: 'F', birth_year: 1961 })
    const r = await t.svc.importDicom(a, p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])
    return { ...t, a, p, study: r.studies[0]! }
  }

  it('AI 检出为待确认；确认 / 否决只能由医生做；修改测量版本加一并留痕', async () => {
    const t = await seeded()
    const ai = t.as(t.dr, 'ai')
    const run = t.svc.startRun(t.a, t.study.id, { task: 'lung_nodule', model_id: 'lung_nodule_ct', model_version: '0.5.9', series_id: t.study.series[0]!.id })
    expect(run).toMatchObject({ status: 'queued', visibility: 'visible', model_version: '0.5.9' })
    expect(t.svc.setRunStatus(t.a, run.id, 'running').started_at).toBeTruthy()
    expect(t.svc.setRunStatus(t.a, run.id, 'done').finished_at).toBeTruthy()

    const l = t.svc.addLesion(t.a, t.study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', location: '右肺上叶', metrics: { mean_diameter_mm: 6.4, volume_mm3: 120 } })
    expect(l).toMatchObject({ status: 'proposed', source: 'ai', version: 1 })
    expect(() => t.svc.reviewLesion(ai, l.id, { status: 'confirmed' })).toThrow(expect.objectContaining({ code: 'needs_human_review' }))
    expect(() => t.svc.addLesion(ai, t.study.id, { kind: 'lung_nodule', source: 'manual' })).toThrow(expect.objectContaining({ code: 'forbidden' }))

    const edited = t.svc.editLesion(t.a, l.id, { metrics: { mean_diameter_mm: 6.8, volume_mm3: 131 } })
    expect(edited).toMatchObject({ version: 2, metrics: { mean_diameter_mm: 6.8 }, location: '右肺上叶' })
    const rejected = t.svc.reviewLesion(t.a, l.id, { status: 'rejected', reason: '血管断面' })
    expect(rejected).toMatchObject({ status: 'rejected', reject_reason: '血管断面' })
    const manual = t.svc.addLesion(t.a, t.study.id, { kind: 'lung_nodule', source: 'manual', location: '左肺下叶' })
    expect(manual.status).toBe('confirmed')

    const events = t.svc.lesionEvents(t.a, l.id)
    expect(events.map(e => e.action)).toEqual(['create', 'edit', 'reject'])
    expect(events[1]).toMatchObject({ before: { metrics: { mean_diameter_mm: 6.4 } }, after: { metrics: { mean_diameter_mm: 6.8 } } })
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.lesions).toEqual({ proposed: 0, confirmed: 1, rejected: 1 })
    // 不在诊疗组的医生不能改
    expect(() => t.svc.editLesion(t.as(t.other), l.id, { label: 'x' })).toThrow(expect.objectContaining({ status: 404 }))
  })

  it('影子模式运行的病灶对界面和 AI 都不可见', async () => {
    const t = await seeded()
    const run = t.svc.startRun(t.a, t.study.id, { task: 'lung_nodule', model_id: 'lung_nodule_ct', visibility: 'shadow' })
    t.svc.addLesion(t.a, t.study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai' })
    expect(t.svc.listLesions(t.a, t.study.id)).toEqual([])
    expect(t.svc.listLesions(t.as(t.dr, 'ai'), t.study.id, { includeShadow: true })).toEqual([])
    expect(t.svc.listLesions(t.a, t.study.id, { includeShadow: true })).toHaveLength(1)
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.lesions.proposed).toBe(0)
  })
})

describe('影像检查接口与 DICOMweb 代理', () => {
  function api(orthanc: Orthanc | null) {
    const t = env()
    const docs = new Documents(t.store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img-st-r-'))), accounts: new Accounts(t.store, { secret: 'test-secret', devMode: false, devToken: 'dev', devUser: 'dev' }),
      devMode: false, devUser: 'dev', patients: t.patients, orthanc, imagingPipeline: null,
    })
    const tok = (u: string) => `Bearer ${issueToken('test-secret', { u, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: t.store.getUser(u)!.token_version })}`
    return { ...t, app, tok }
  }

  it('上传后列表带 UID；DICOMweb 只转发能看到的检查', async () => {
    const t = api(new FakeOrthanc())
    const p = t.patients.create(t.as(t.dr), { sex: 'F', birth_year: 1961 })
    const form = new FormData()
    form.append('files', new File([dicom(STUDY, SERIES, '1')], 'IM1'))
    form.append('files', new File([new Uint8Array(zipSync({ 'IM2': dicom(STUDY, SERIES, '2') }))], 'more.zip'))
    const up = await t.app.request(`/api/patients/${p.id}/imaging/dicom`, { method: 'POST', headers: { Authorization: t.tok(t.dr) }, body: form })
    expect(up.status).toBe(201)
    expect(((await up.json()) as { files: { uploaded: number } }).files.uploaded).toBe(2)

    const list = await (await t.app.request(`/api/patients/${p.id}/imaging/studies`, { headers: { Authorization: t.tok(t.dr) } })).json() as Array<{ study_uid: string }>
    expect(list[0]!.study_uid).toBe(STUDY)

    const qido = await t.app.request(`/api/dicomweb/studies?StudyInstanceUID=${STUDY}&includefield=all`, { headers: { Authorization: t.tok(t.dr) } })
    expect(qido.status).toBe(200)
    expect(qido.headers.get('cache-control')).toContain('no-store')
    const meta = await t.app.request(`/api/dicomweb/studies/${STUDY}/series/${SERIES}/metadata`, { headers: { Authorization: t.tok(t.dr) } })
    expect(meta.status).toBe(200)
    expect(await meta.json()).toEqual([{ ok: `/studies/${STUDY}/series/${SERIES}/metadata` }])

    // 看不到患者的医生、不带 UID 的检索、越界路径
    expect((await t.app.request(`/api/dicomweb/studies/${STUDY}/series`, { headers: { Authorization: t.tok(t.other) } })).status).toBe(404)
    expect((await t.app.request(`/api/dicomweb/studies?StudyInstanceUID=${STUDY}`, { headers: { Authorization: t.tok(t.other) } })).status).toBe(404)
    expect((await t.app.request('/api/dicomweb/studies', { headers: { Authorization: t.tok(t.dr) } })).status).toBe(400)
    expect((await t.app.request(`/api/dicomweb/studies/${STUDY}/series/%2E%2E`, { headers: { Authorization: t.tok(t.dr) } })).status).toBe(400)
    expect((await t.app.request(`/api/dicomweb/studies/${STUDY}/series`)).status).toBe(401)
  })

  it('没配置 Orthanc 时上传与 DICOMweb 返回 503', async () => {
    const t = api(null)
    const p = t.patients.create(t.as(t.dr), { sex: 'F', birth_year: 1961 })
    const form = new FormData()
    form.append('files', new File([dicom(STUDY, SERIES, '1')], 'IM1'))
    const up = await t.app.request(`/api/patients/${p.id}/imaging/dicom`, { method: 'POST', headers: { Authorization: t.tok(t.dr) }, body: form })
    expect(up.status).toBe(503)
    expect(((await up.json()) as { code: string }).code).toBe('orthanc_not_configured')
  })
})
