import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { buildApi } from '../src/http/api.ts'
import { ImagingFollowup } from '../src/imaging/followup.ts'
import { OrthancError } from '../src/imaging/orthanc.ts'
import { ImagingPipeline } from '../src/imaging/pipeline.ts'
import { purgeExpiredOriginals, RETENTION_ACTOR, startImagingRetention } from '../src/imaging/retention.ts'
import { ImagingStudyService } from '../src/imaging/studies.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import { dicom, FakeOrthanc, fakeWorker, NODULE_RESULT, seriesFiles } from './imaging-fakes.ts'

/**
 * 影像原件保留期清理（src/imaging/retention.ts）：到期删除、未到期不删、分析中跳过、删除失败重试、
 * 删除后的视图与入口、重新上传恢复、配置为 0 时不跑；随访取前片时原件不在不崩。
 */

const STUDY = '1.2.840.113619.2.55.3.7001'
const SERIES = `${STUDY}.2`
const SEG = `${STUDY}.99`
const DAY = 86_400_000
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const quiet = { log: () => {}, error: () => {} }

function env() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-img-ret-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const dr = store.createUser({ username: 'dr_wang', display_name: '王医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const orthanc = new FakeOrthanc()
  orthanc.seriesTags.set(SEG, { modality: 'SEG', bodyPart: null, sliceThickness: null, kernel: null })
  const svc = new ImagingStudyService(patients, orthanc)
  const a: Actor = { userId: dr, via: 'user' }
  const worker = fakeWorker(path => path === '/api/v1/pipeline/lung-nodule' ? ok(NODULE_RESULT) : ok({ ok: true }))
  const pipeline = new ImagingPipeline(svc, orthanc, 'http://worker:8004', { fetch: worker.fetchImpl })
  const db = () => patients.imagingLookup(a).db
  return { store, patients, dr, orthanc, svc, a, worker, pipeline, db }
}

/** 一位患者、一个检查（40 层 CT）、一个已完成的分析（含一个 AI 生成的 SEG）、一个确认过的结节 */
async function seeded() {
  const t = env()
  const p = t.patients.create(t.a, { sex: 'F', birth_year: 1961 })
  const study = (await t.svc.importDicom(t.a, p.id, seriesFiles(STUDY, SERIES, 40))).studies[0]!
  const run = t.svc.startRun(t.a, study.id, { task: 'lung_nodule', model_id: 'lung_nodule_pipeline', series_id: study.series[0]!.id })
  t.svc.setRunStatus(t.a, run.id, 'running')
  t.svc.setRunStatus(t.a, run.id, 'done', null, { summary: { found: 1 } })
  const segUp = await t.orthanc.upload(dicom(STUDY, SEG, `${SEG}.1`))
  const segId = await t.svc.addDerivedSeries(t.a, study.id, segUp.seriesId)
  const lesion = t.svc.addLesion(t.a, study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', label: '结节 1', metrics: { mean_diameter_mm: 8.2 }, seg_ref: `${segId}#1` })
  t.svc.reviewLesion(t.a, lesion.id, { status: 'confirmed' })
  return { ...t, p, study, run, lesion }
}

const later = (days: number) => () => Date.now() + days * DAY

describe('影像原件保留期清理', () => {
  it('到期：从 Orthanc 删除整个检查（含 SEG）；索引、AI 结果、病灶与留痕保留；检查标记为原件已删除', async () => {
    const t = await seeded()
    expect(t.orthanc.instances.size).toBe(41)
    const r = await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(31), log: quiet })
    expect(r).toEqual({ purged: 1, busy: 0, failed: 0 })
    expect(t.orthanc.deletedStudies).toEqual([STUDY])
    expect(t.orthanc.instances.size).toBe(0)

    const st = t.svc.listStudies(t.a, t.p.id, true)[0]!
    expect(st.originals_deleted).toMatchObject({ retention_days: 30, message: '影像原件已按保留期（30 天）从云端删除，可重新上传' })
    expect(st.series.map(s => s.modality).sort()).toEqual(['CT', 'SEG'])   // 序列索引保留
    expect(st.runs[0]).toMatchObject({ id: t.run.id, status: 'done' })
    expect(st.lesions).toMatchObject({ confirmed: 1 })
    expect(t.svc.listLesions(t.a, t.study.id)[0]).toMatchObject({ id: t.lesion.id, status: 'confirmed', metrics: { mean_diameter_mm: 8.2 } })
    expect(t.svc.lesionEvents(t.a, t.lesion.id).map(e => e.action)).toEqual(['create', 'confirm'])
    // 检查与序列的 orthanc_id 置空
    expect(t.db().prepare('SELECT orthanc_id FROM imaging_studies').get()).toEqual({ orthanc_id: null })
    expect(t.db().prepare('SELECT COUNT(*) AS n FROM imaging_series WHERE orthanc_id IS NOT NULL').get()).toEqual({ n: 0 })
    // 访问留痕：系统定时任务
    const log = t.db().prepare("SELECT user_id, via, detail FROM access_log WHERE action = 'imaging_originals_purged'").all()
    expect(log).toEqual([{ user_id: RETENTION_ACTOR, via: 'system', detail: t.study.id }])
    expect(t.patients.accessLog(t.a, t.p.id).find(l => l.action === 'imaging_originals_purged')).toMatchObject({ user: '系统定时任务', via: 'system' })

    // 再跑一次不重复删除
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(40), log: quiet })).toEqual({ purged: 0, busy: 0, failed: 0 })
  })

  it('未到期不删；保留期按最后一次上传计算', async () => {
    const t = await seeded()
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(29), log: quiet })).toEqual({ purged: 0, busy: 0, failed: 0 })
    expect(t.orthanc.deletedStudies).toEqual([])
    // 20 天前的上传、10 天前又补传了几层：从补传那次算，30 天未到
    t.db().prepare('UPDATE imaging_studies SET updated_at = ?').run(new Date(Date.now() - 20 * DAY).toISOString())
    await t.svc.importDicom(t.a, t.p.id, [{ name: 'IM-extra', bytes: dicom(STUDY, SERIES, 'extra') }])
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(25), log: quiet })).toMatchObject({ purged: 0 })
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(31), log: quiet })).toMatchObject({ purged: 1 })
  })

  it('有排队 / 进行中的分析时跳过；服务重启留下的（本进程没在跑）不阻止', async () => {
    const t = await seeded()
    const queued = t.svc.startRun(t.a, t.study.id, { task: 'lung_nodule', model_id: 'lung_nodule_pipeline', series_id: t.study.series[0]!.id })
    // 不给 isRunActive：库里 queued 的一律视为进行中
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(31), log: quiet })).toEqual({ purged: 0, busy: 1, failed: 0 })
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(31), isRunActive: id => id === queued.id, log: quiet })).toEqual({ purged: 0, busy: 1, failed: 0 })
    expect(t.orthanc.deletedStudies).toEqual([])
    // 进行中（running）同样跳过
    t.svc.setRunStatus(t.a, queued.id, 'running')
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(31), isRunActive: () => true, log: quiet })).toMatchObject({ busy: 1, purged: 0 })
    // 本进程并没有在跑这次运行（上一个进程留下的）：照常清理
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(31), isRunActive: () => false, log: quiet })).toEqual({ purged: 1, busy: 0, failed: 0 })
  })

  it('删除失败不改库，下次重试', async () => {
    const t = await seeded()
    const errors: string[] = []
    const del = t.orthanc.deleteStudy.bind(t.orthanc)
    let fail = true
    t.orthanc.deleteStudy = async (id: string) => { if (fail) throw new OrthancError(503, '影像存储（Orthanc）连接失败'); return del(id) }
    const r1 = await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(31), log: { log: () => {}, error: (m: string) => errors.push(m) } })
    expect(r1).toEqual({ purged: 0, busy: 0, failed: 1 })
    expect(errors[0]).toContain('下次重试')
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.originals_deleted).toBeNull()
    expect(t.orthanc.instances.size).toBe(41)
    expect(t.db().prepare("SELECT COUNT(*) AS n FROM access_log WHERE action = 'imaging_originals_purged'").get()).toEqual({ n: 0 })

    fail = false
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(32), log: quiet })).toEqual({ purged: 1, busy: 0, failed: 0 })
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.originals_deleted).not.toBeNull()
  })

  it('删除后：不能再排队分析、不能开阅片器、点选分割说明序列已不在；重新上传同一检查即恢复，保留期重新计算', async () => {
    const t = await seeded()
    await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(31), log: quiet })
    // 分析：返回原因，不建运行
    const runsBefore = t.svc.listStudies(t.a, t.p.id)[0]!.runs.length
    expect(t.pipeline.enqueue(t.a, t.study.id)).toEqual({ task: 'lung_nodule', skipped: '影像原件已按保留期（30 天）从云端删除，可重新上传' })
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.runs.length).toBe(runsBefore)
    // 阅片器点选分割：序列已不在影像存储
    expect(() => t.svc.viewerSeries(t.a, STUDY, SERIES)).toThrow(expect.objectContaining({ code: 'series_missing' }))
    expect(() => t.svc.lesionSource(t.a, t.lesion.id)).toThrow(expect.objectContaining({ code: 'series_missing' }))

    // 重新上传同一检查（同一 StudyInstanceUID）：恢复
    const again = await t.svc.importDicom(t.a, t.p.id, seriesFiles(STUDY, SERIES, 40))
    expect(again.studies.map(s => s.id)).toEqual([t.study.id])
    const st = t.svc.listStudies(t.a, t.p.id, true)[0]!
    expect(st.originals_deleted).toBeNull()
    expect(st.lesions).toMatchObject({ confirmed: 1 })
    expect(t.svc.viewerSeries(t.a, STUDY, SERIES).orthancId).toBeTruthy()
    const r = t.pipeline.enqueue(t.a, t.study.id)
    expect(r.run).toBeTruthy()
    await t.pipeline.idle()
    // 重新上传后的保留期从这次上传算：刚上传，不删
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(10), log: quiet })).toMatchObject({ purged: 0 })
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, now: later(31), log: quiet })).toMatchObject({ purged: 1 })
  })

  it('接口：检查列表带原件状态；阅片器票据返回 409 并说明', async () => {
    const t = await seeded()
    await purgeExpiredOriginals(t.patients, t.orthanc, { days: 7, now: later(8), log: quiet })
    const docs = new Documents(t.store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img-ret-r-'))), accounts: new Accounts(t.store, { secret: 'test-secret', devMode: false, devToken: 'dev', devUser: 'dev' }),
      devMode: false, devUser: 'dev', patients: t.patients, orthanc: t.orthanc, imagingPipeline: t.pipeline,
    })
    const H = { Authorization: `Bearer ${issueToken('test-secret', { u: t.dr, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: t.store.getUser(t.dr)!.token_version })}`, 'Content-Type': 'application/json' }
    const list = await (await app.request(`/api/patients/${t.p.id}/imaging/studies`, { headers: H })).json() as Array<{ originals_deleted: { message: string } | null }>
    expect(list[0]!.originals_deleted!.message).toBe('影像原件已按保留期（7 天）从云端删除，可重新上传')
    const an = await app.request(`/api/patients/${t.p.id}/imaging/studies/${t.study.id}/analyze`, { method: 'POST', headers: H, body: '{}' })
    expect(an.status).toBe(409)
    expect(((await an.json()) as { error: string }).error).toContain('从云端删除')
    process.env.VIEWER_HOST = 'viewer.test'
    process.env.VIEWER_URL = 'http://ohif:8080'
    try {
      const tk = await app.request('/api/imaging/viewer-ticket', { method: 'POST', headers: H, body: JSON.stringify({ study_uid: STUDY }) })
      expect(tk.status).toBe(409)
      expect(await tk.json()).toMatchObject({ code: 'originals_deleted', error: expect.stringContaining('可重新上传') })
    } finally {
      delete process.env.VIEWER_HOST
      delete process.env.VIEWER_URL
    }
  })

  it('保留期为 0 时不清理，也不启动定时任务；没有影像存储时也不启动', async () => {
    const t = await seeded()
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 0, now: later(3650), log: quiet })).toEqual({ purged: 0, busy: 0, failed: 0 })
    expect(t.orthanc.deletedStudies).toEqual([])
    expect(startImagingRetention(t.patients, t.orthanc, { days: 0 })).toBeNull()
    expect(startImagingRetention(t.patients, null, { days: 30 })).toBeNull()
  })

  describe('定时', () => {
    afterEach(() => { vi.useRealTimers() })
    it('启动后先跑一次，之后每天一次', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
      const t = await seeded()
      const spy = vi.spyOn(t.orthanc, 'deleteStudy')
      const stop = startImagingRetention(t.patients, t.orthanc, { days: 30, now: later(31), initialDelayMs: 1000, log: quiet })!
      expect(stop).toBeTypeOf('function')
      await vi.advanceTimersByTimeAsync(1000)
      expect(spy).toHaveBeenCalledTimes(1)
      // 再上传一个新检查，次日到期（now 固定在 31 天后）
      await t.svc.importDicom(t.a, t.p.id, seriesFiles(`${STUDY}.5`, `${STUDY}.5.1`, 2))
      await vi.advanceTimersByTimeAsync(DAY)
      expect(spy).toHaveBeenCalledTimes(2)
      stop()
      await vi.advanceTimersByTimeAsync(2 * DAY)
      expect(spy).toHaveBeenCalledTimes(2)
    })
  })
})

describe('随访取前片时前片原件已删除', () => {
  const PRIOR = '1.2.840.113619.2.55.3.7101'
  const CUR = '1.2.840.113619.2.55.3.7102'
  const nod = (z: number) => ({
    index: 1, detection_score: 0.9, center_vox_zyx: [10, 100, 100], box_vox_zyx: [0, 0, 0, 1, 1, 1], lobe: 'RUL', segmentation: 'vista3d', key_slice_z: 10,
    center_lps_mm: [-43, 37, z], box_lps_mm: null, key_slice_sop_instance_uid: '1.2.3.1', metrics: { long_axis_mm: 8, short_axis_mm: 8, mean_diameter_mm: 8, volume_mm3: 260 }, warnings: [],
  })

  function fuEnv() {
    const t = env()
    t.orthanc.studyDates.set(PRIOR, '2025-10-20')
    t.orthanc.studyDates.set(CUR, '2026-10-20')
    // 旧分析：运行摘要里没有肺部锚点，随访时要从影像存储取出前片序列补算
    const worker = fakeWorker(path => {
      if (path === '/api/v1/pipeline/lung-nodule') return ok({ ...NODULE_RESULT, series_qc: { spacing_mm: [1.25, 0.7, 0.7] }, nodules: [nod(108)], seg: null })
      if (path === '/api/v1/pipeline/lung-nodule/match') return ok({ registration: { quality: 'coarse', reliable: false, translation_mm: [0, 0, 0], inliers: 0, notes: [] }, pairs: [], fixed: [], unmatched_prior: [], unmatched_current: [], skipped: [] })
      if (path === '/api/v1/pipeline/lung-nodule/anchor') return ok({ anchor: { ok: true, centroid_lps_mm: [0, 0, 0] } })
      return ok({ ok: true })
    })
    const followup = new ImagingFollowup(t.patients, t.orthanc, 'http://worker:8004', { fetch: worker.fetchImpl })
    const pipeline = new ImagingPipeline(t.svc, t.orthanc, 'http://worker:8004', { fetch: worker.fetchImpl, onRunDone: (x, run) => followup.onAnalysisDone(x, run) })
    followup.attachAnalyzer((x, studyId) => pipeline.enqueue(x, studyId))
    const settle = async () => { for (let i = 0; i < 5; i++) { await pipeline.idle(); await followup.idle() } }
    /** 只让前片过期：前片的「最后上传时间」改到 60 天前 */
    const expirePrior = (studyId: string) => t.db().prepare('UPDATE imaging_studies SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 60 * DAY).toISOString(), studyId)
    return { ...t, worker, followup, pipeline, settle, expirePrior }
  }

  it('前片已分析并确认：锚点补算如实说明「序列已不在影像存储中」，匹配照常完成', async () => {
    const t = fuEnv()
    const p = t.patients.create(t.a, { sex: 'F', birth_year: 1961 })
    const prior = (await t.svc.importDicom(t.a, p.id, seriesFiles(PRIOR, `${PRIOR}.2`, 40))).studies[0]!
    t.pipeline.enqueue(t.a, prior.id)
    await t.settle()
    for (const l of t.svc.listLesions(t.a, prior.id)) t.svc.reviewLesion(t.a, l.id, { status: 'confirmed' })
    const cur = (await t.svc.importDicom(t.a, p.id, seriesFiles(CUR, `${CUR}.2`, 40))).studies[0]!
    t.expirePrior(prior.id)
    expect(await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, log: quiet })).toMatchObject({ purged: 1 })

    t.pipeline.enqueue(t.a, cur.id)
    await t.settle()
    const v = t.followup.view(t.a, cur.id)
    expect(v.run).toMatchObject({ status: 'done' })
    expect(v.run!.summary!.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^前片肺部锚点：序列已不在影像存储中/)]))
    expect(t.orthanc.archives.filter(u => u === `${PRIOR}.2`)).toHaveLength(1)   // 只有当初分析前片时取过一次
  })

  it('前片没分析过且原件已删除：不排队预计算，说明原因', async () => {
    const t = fuEnv()
    const p = t.patients.create(t.a, { sex: 'F', birth_year: 1961 })
    const prior = (await t.svc.importDicom(t.a, p.id, seriesFiles(PRIOR, `${PRIOR}.2`, 40))).studies[0]!
    const cur = (await t.svc.importDicom(t.a, p.id, seriesFiles(CUR, `${CUR}.2`, 40))).studies[0]!
    t.expirePrior(prior.id)
    await purgeExpiredOriginals(t.patients, t.orthanc, { days: 30, log: quiet })

    t.pipeline.enqueue(t.a, cur.id)
    await t.settle()
    const v = t.followup.view(t.a, cur.id)
    expect(v.run).toMatchObject({ status: 'skipped' })
    expect(v.run!.summary!.notes).toEqual(expect.arrayContaining([expect.stringContaining('最近的前片不能分析：影像原件已按保留期（30 天）从云端删除')]))
    expect(t.svc.listStudies(t.a, p.id).find(s => s.id === prior.id)!.runs).toEqual([])
  })
})
