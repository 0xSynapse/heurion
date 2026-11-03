import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { buildApi } from '../src/http/api.ts'
import { ImagingPipeline } from '../src/imaging/pipeline.ts'
import { ImagingStudyService, lesionDistance } from '../src/imaging/studies.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import { dicom, FakeOrthanc, fakeWorker, NODULE_RESULT, seriesFiles } from './imaging-fakes.ts'

/**
 * 影子模式（T1.8，机构设置 imaging_ai_visibility = shadow）：自动分析照常运行，结果对界面、阅片器与 AI 都不可见；
 * SEG 不存入影像存储；影子期对照报告只给机构管理员。
 */

const STUDY = '1.2.840.113619.2.55.3.3001'
const THIN = `${STUDY}.2`
const SEG = `${STUDY}.77`

const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const segFile = dicom(STUDY, SEG, `${SEG}.1`)
const WITH_SEG = {
  ...NODULE_RESULT,
  nodules: NODULE_RESULT.nodules.map(n => ({ ...n, seg_segment_number: n.segmentation === 'vista3d' ? 1 : null })),
  seg: { dicom_base64: Buffer.from(segFile).toString('base64'), series_instance_uid: SEG, sop_instance_uid: `${SEG}.1` },
}

function env(handler: (path: string) => Response = path => path.endsWith('/lung-nodule') ? ok(WITH_SEG) : ok({ ok: true })) {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-img-sh-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const admin = store.createUser({ username: 'admin_li', display_name: '李主任', password_hash: 'x', tenant: { id: hosp.id, role: 'admin' } }).id
  const dr = store.createUser({ username: 'dr_wang', display_name: '王医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const orthanc = new FakeOrthanc()
  orthanc.seriesTags.set(SEG, { modality: 'SEG', description: 'Heurion AI lung nodules', sliceThickness: null, kernel: null })
  const svc = new ImagingStudyService(patients, orthanc, { acceptIdentified: true })
  const worker = fakeWorker(handler)
  const pipeline = new ImagingPipeline(svc, orthanc, 'http://worker:8004', { fetch: worker.fetchImpl })
  const a: Actor = { userId: dr, via: 'user' }
  const ai: Actor = { userId: dr, via: 'ai' }
  const setMode = (mode: 'visible' | 'shadow') => tenants.update(admin, { settings: { imaging_ai_visibility: mode } })
  return { store, tenants, patients, orthanc, svc, worker, pipeline, a, ai, admin, dr, setMode }
}

async function seeded(handler?: (path: string) => Response) {
  const t = env(handler)
  const p = t.patients.create(t.a, { sex: 'M', birth_year: 1958 })
  const r = await t.svc.importDicom(t.a, p.id, seriesFiles(STUDY, THIN, 40))
  return { ...t, p, study: r.studies[0]! }
}

/** 库里某次运行的全部病灶（绕过可见性过滤，核对影子结果确实入库） */
const rawLesions = (t: Awaited<ReturnType<typeof seeded>>, runId: string) =>
  t.patients.imagingLookup(t.a).db.prepare('SELECT id, status FROM imaging_lesions WHERE run_id = ?').all(runId) as Array<{ id: string; status: string }>

describe('影子模式（T1.8）', () => {
  it('设置默认是显示；只有 visible / shadow 两个取值', () => {
    const t = env()
    expect(t.tenants.view(t.admin).settings.imaging_ai_visibility).toBe('visible')
    t.tenants.update(t.admin, { settings: { imaging_ai_visibility: 'off' } })
    expect(t.tenants.view(t.admin).settings.imaging_ai_visibility).toBe('visible')
    t.setMode('shadow')
    expect(t.tenants.view(t.admin).settings.imaging_ai_visibility).toBe('shadow')
  })

  it('影子运行：检出入库但对界面、阅片器、AI 都不可见；SEG 不存入影像存储；按 id 访问当不存在', async () => {
    const t = await seeded()
    t.setMode('shadow')
    const r = t.pipeline.enqueue(t.a, t.study.id)
    expect(r.run!.visibility).toBe('shadow')
    await t.pipeline.idle()

    const stored = rawLesions(t, r.run!.id)
    expect(stored).toHaveLength(2)
    expect(t.svc.listLesions(t.a, t.study.id)).toEqual([])
    expect(t.svc.listLesions(t.ai, t.study.id)).toEqual([])
    expect(t.svc.lesionsByStudyUid(t.a, STUDY)).toEqual([])
    const st = t.svc.listStudies(t.a, t.p.id, true)[0]!
    expect(st).toMatchObject({ ai_shadow: true, runs: [], lesions: { proposed: 0, confirmed: 0, rejected: 0 } })
    expect(t.svc.listStudies(t.ai, t.p.id)[0]!.ai_shadow).toBe(true)
    // SEG 没进 Orthanc，也没登记为序列（OHIF 的序列栏看不到）
    expect([...t.orthanc.instances.values()].some(i => i.series === SEG)).toBe(false)
    expect(st.series.map(x => x.modality)).toEqual(['CT'])

    const id = stored[0]!.id
    expect(() => t.svc.reviewLesion(t.a, id, { status: 'confirmed' })).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => t.svc.lesionEvents(t.a, id)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => t.svc.editLesion(t.a, id, { label: 'x' })).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => t.svc.studyUidOfLesion(t.a, id)).toThrow(expect.objectContaining({ status: 404 }))

    // 运行本身照常完成，摘要标明影子
    const run = t.patients.imagingLookup(t.a).db.prepare('SELECT status, summary FROM imaging_runs WHERE id = ?').get(r.run!.id) as { status: string; summary: string }
    expect(run.status).toBe('done')
    expect(JSON.parse(run.summary)).toMatchObject({ shadow: true, seg_stored: false, found: 2 })
  })

  it('影子与显示互不取代；影子运行不与医生已审核的结节去重；医生的点选分割不受影子模式影响', async () => {
    const t = await seeded()
    // 先在显示模式下分析，医生确认 1 号
    t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()
    const visible = t.svc.listLesions(t.a, t.study.id)
    t.svc.reviewLesion(t.a, visible[0]!.id, { status: 'confirmed' })

    t.setMode('shadow')
    const sh = t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()
    // 影子运行：两个检出都入库（不因 1 号已被确认而跳过），显示的 2 号待确认没有被取代
    expect(rawLesions(t, sh.run!.id).map(l => l.status)).toEqual(['proposed', 'proposed'])
    expect(t.svc.listLesions(t.a, t.study.id).map(l => l.id)).toEqual(visible.map(l => l.id))

    // 切回显示：影子期的检出仍不显示；显示的重新分析只取代显示的旧检出，影子检出保持原状
    t.setMode('visible')
    t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()
    expect(rawLesions(t, sh.run!.id).map(l => l.status)).toEqual(['proposed', 'proposed'])
    expect(t.svc.listLesions(t.a, t.study.id).every(l => l.id !== rawLesions(t, sh.run!.id)[0]!.id)).toBe(true)
    expect(t.svc.lesionEvents(t.a, visible[1]!.id).map(e => e.action)).toEqual(['create', 'supersede'])

    // 显式指定可见性的运行（医生点选分割）不随机构设置
    t.setMode('shadow')
    expect(t.svc.startRun(t.a, t.study.id, { task: 'lung_nodule_point', model_id: 'lung_nodule_point', visibility: 'visible' }).visibility).toBe('visible')
  })

  it('同一处判定：中心距离不超过较大的半径（至少 3 mm）；没有病人坐标时不配对', () => {
    expect(lesionDistance({ center_lps_mm: [0, 0, 0], mean_diameter_mm: 10 }, { center_lps_mm: [4, 0, 0] })).toEqual({ d: 4, radius: 5 })
    expect(lesionDistance({ center_lps_mm: [0, 0, 0] }, { center_lps_mm: [0, 0, 2] })).toEqual({ d: 2, radius: 3 })
    expect(lesionDistance({ center_lps_mm: [0, 0, 0] }, { center_lps_mm: null })).toBeNull()
  })

  it('影子期对照报告：AI 检出与医生标注逐一配对，算敏感度与只有 AI 的检出；统计失败与耗时；只给机构管理员', async () => {
    let fail = false
    const t = await seeded(path => path.endsWith('/lung-nodule') ? (fail ? new Response('{"detail":"显存不足"}', { status: 500 }) : ok(WITH_SEG)) : ok({ ok: true }))
    t.setMode('shadow')
    t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()
    // 医生在阅片器里标了两个结节：一个就在 AI 的 1 号旁边，一个 AI 没检出
    t.svc.addLesion(t.a, t.study.id, { kind: 'lung_nodule', source: 'manual', location: 'RUL', metrics: { center_lps_mm: [-44.0, 38.5, 108.0], mean_diameter_mm: 7.9 } })
    const missed = t.svc.addLesion(t.a, t.study.id, { kind: 'lung_nodule', source: 'manual', location: 'LUL', metrics: { center_lps_mm: [60, 20, 90], mean_diameter_mm: 4.2 } })
    // 撤销（superseded）与否决的不算参照
    t.svc.withdrawLesion(t.a, t.svc.addLesion(t.a, t.study.id, { kind: 'lung_nodule', source: 'manual', metrics: { center_lps_mm: [0, 0, 0] } }).id)
    fail = true
    t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()

    const adminActor: Actor = { userId: t.admin, via: 'user' }
    const rep = t.svc.shadowReport(adminActor)
    expect(rep.mode).toBe('shadow')
    expect(rep.runs).toMatchObject({ total: 2, done: 1, failed: 1, pending: 0 })
    expect(rep.runs.failures[0]!.error).toContain('显存不足')
    expect(rep.runs.turnaround_ms!.p90).toBeGreaterThanOrEqual(0)
    expect(rep.studies).toHaveLength(1)
    // 2 号没有病人坐标，配不上 → 只有 AI
    expect(rep.studies[0]).toMatchObject({ study_id: t.study.id, patient_id: t.p.id, ai: 2, reference: 2, matched: 1, ai_only: 1,
      missed: [{ lesion_id: missed.id, mean_diameter_mm: 4.2, location: 'LUL' }] })
    expect(rep.totals).toMatchObject({ studies: 1, studies_with_reference: 1, reference: 2, matched: 1, ai_only: 1, sensitivity: 0.5, ai_only_per_study: 1 })
    expect(t.svc.shadowReport(adminActor, '2999-01-01')).toMatchObject({ runs: { total: 0 }, studies: [], totals: { sensitivity: null } })

    expect(() => t.svc.shadowReport(t.a)).toThrow(expect.objectContaining({ status: 403 }))
    expect(() => t.svc.shadowReport({ userId: t.admin, via: 'ai' })).toThrow(expect.objectContaining({ status: 403 }))
  })
})

describe('影子模式的接口', () => {
  async function api() {
    const t = env()
    const docs = new Documents(t.store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img-sh-r-'))), accounts: new Accounts(t.store, { secret: 'test-secret', devMode: false, devToken: 'dev', devUser: 'dev' }),
      devMode: false, devUser: 'dev', patients: t.patients, orthanc: t.orthanc, imagingPipeline: t.pipeline, imagingAcceptIdentified: true,
    })
    const bearer = (u: string) => ({ Authorization: `Bearer ${issueToken('test-secret', { u, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: t.store.getUser(u)!.token_version })}` })
    return { ...t, app, auth: bearer(t.dr), adminAuth: bearer(t.admin) }
  }

  it('上传与重新分析不返回影子运行的 id；列表标明影子模式；对照报告只给管理员', async () => {
    const t = await api()
    t.setMode('shadow')
    const p = t.patients.create(t.a, { sex: 'M', birth_year: 1958 })
    const form = new FormData()
    for (const f of seriesFiles(STUDY, THIN, 40)) form.append('files', new File([f.bytes], f.name))
    const up = await t.app.request(`/api/patients/${p.id}/imaging/dicom`, { method: 'POST', headers: t.auth, body: form })
    expect(up.status).toBe(201)
    const body = await up.json() as { studies: Array<{ id: string }>; analysis: unknown[] }
    expect(body.analysis).toEqual([{ study_id: body.studies[0]!.id, task: 'lung_nodule', run_id: null, shadow: true, skipped: null, notes: [] }])
    await t.pipeline.idle()

    const list = await (await t.app.request(`/api/patients/${p.id}/imaging/studies`, { headers: t.auth })).json() as Array<{ ai_shadow: boolean; runs: unknown[]; lesions: { proposed: number } }>
    expect(list[0]).toMatchObject({ ai_shadow: true, runs: [], lesions: { proposed: 0 } })
    const lesions = await (await t.app.request(`/api/patients/${p.id}/imaging/studies/${body.studies[0]!.id}/lesions`, { headers: t.auth })).json()
    expect(lesions).toEqual([])

    const again = await t.app.request(`/api/patients/${p.id}/imaging/studies/${body.studies[0]!.id}/analyze`, { method: 'POST', headers: { ...t.auth, 'Content-Type': 'application/json' }, body: '{}' })
    expect(again.status).toBe(202)
    expect(await again.json()).toMatchObject({ run_id: null, shadow: true })
    await t.pipeline.idle()

    expect((await t.app.request('/api/imaging/shadow-report', { headers: t.auth })).status).toBe(403)
    expect((await t.app.request('/api/imaging/shadow-report?since=yesterday', { headers: t.adminAuth })).status).toBe(400)
    const rep = await t.app.request('/api/imaging/shadow-report?since=2026-01-01', { headers: t.adminAuth })
    expect(rep.status).toBe(200)
    expect(await rep.json()).toMatchObject({ mode: 'shadow', runs: { total: 2, done: 2 }, totals: { studies: 1, studies_with_reference: 0, sensitivity: null } })
  })
})
