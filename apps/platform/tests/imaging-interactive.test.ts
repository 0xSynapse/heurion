import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { buildApi } from '../src/http/api.ts'
import { ImagingInteractive, parsePoints, type PromptPoint } from '../src/imaging/interactive.ts'
import { ImagingStudyService, POINT_TASK, segRef } from '../src/imaging/studies.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import { dicom, FakeOrthanc, fakeWorker, seriesFiles } from './imaging-fakes.ts'

const STUDY = '1.2.840.113619.2.55.3.3001'
const CT = `${STUDY}.2`
const AI_SEG = `${STUDY}.97`

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** worker 点选分割的响应：结节在点击处，附一个新的单 segment SEG */
function pointResult(segUid: string, over: Record<string, unknown> = {}) {
  return {
    model_id: 'lung_nodule_point', model_version: 'vista3d@0.5.7', device: 'mps', elapsed_ms: 1150,
    timings_ms: { segmentation: 1120, measurement: 19, seg: 10 }, found: true, reason: null,
    prompt_points: [],
    nodule: {
      index: 1, detection_score: null, center_vox_zyx: [221, 297, 209], box_vox_zyx: [214, 288, 200, 228, 306, 219], lobe: null, segmentation: 'vista3d', key_slice_z: 222,
      metrics: { long_axis_mm: 17.1, short_axis_mm: 14.1, mean_diameter_mm: 15.6, volume_mm3: 2187.5, mean_hu: -40, std_hu: 120, nodule_type: 'solid', solid_core_diameter_mm: null, ctr: null },
      warnings: [], center_lps_mm: [-43.13, 37.73, 108.12], box_lps_mm: [-52, 29, 99, -35, 46, 117], key_slice_sop_instance_uid: `${CT}.222`, seg_segment_number: 1,
    },
    seg: { dicom_base64: Buffer.from(dicom(STUDY, segUid, `${segUid}.1`)).toString('base64'), series_instance_uid: segUid, sop_instance_uid: `${segUid}.1` },
    ...over,
  }
}

interface Opts { found?: boolean; evictOnce?: boolean; lobe?: string | null; lobeFail?: boolean }

function env(opts: Opts = {}) {
  const store = new Store(':memory:')
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-img-it-')), new TenantService(store, { devMode: false }), new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const dr = store.createUser({ username: 'dr_li', display_name: '李医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const orthanc = new FakeOrthanc()
  const svc = new ImagingStudyService(patients, orthanc)
  const loaded = new Set<string>()
  let segN = 0
  let evict = !!opts.evictOnce
  const worker = fakeWorker((path, init) => {
    if (path === '/api/v1/volume/upload') { loaded.add((init.body as FormData).get('volume_id') as string); return ok({ cached: false }) }
    const st = /^\/api\/v1\/volume\/([^/]+)\/status$/.exec(path)
    if (st) return ok({ ready: loaded.has(decodeURIComponent(st[1]!)) })
    if (path === '/api/v1/pipeline/lung-nodule/point') {
      const vid = JSON.parse(init.body as string).volume_id as string
      if (evict) { evict = false; loaded.delete(vid) }
      if (!loaded.has(vid)) return ok({ detail: `点选分割失败: 找不到影像: '${vid}'` }, 404)
      if (opts.found === false) return ok({ ...pointResult('x'), found: false, nodule: null, seg: null, reason: '点击处 3 mm 内没有分割到结构' })
      const uid = `${STUDY}.98.${++segN}`
      orthanc.seriesTags.set(uid, { modality: 'SEG', instances: 1 })
      return ok(pointResult(uid))
    }
    if (path === '/api/v1/pipeline/lung-nodule/lobe') return opts.lobeFail ? ok({ detail: 'boom' }, 500) : ok({ lobe: opts.lobe === undefined ? 'RUL' : opts.lobe, note: null })
    return ok({ detail: 'unexpected' }, 500)
  })
  const it = new ImagingInteractive(svc, orthanc, 'http://worker:8004', { fetch: worker.fetchImpl })
  const a: Actor = { userId: dr, via: 'user' }
  return { store, patients, orthanc, svc, worker, it, a, dr, loaded }
}

async function seeded(opts: Opts = {}) {
  const t = env(opts)
  const p = t.patients.create(t.a, { sex: 'M', birth_year: 1960 })
  const study = (await t.svc.importDicom(t.a, p.id, seriesFiles(STUDY, CT, 40))).studies[0]!
  return { ...t, p, study }
}

const CLICK: PromptPoint = { lps_mm: [-43, 37.7, 108.1], positive: true }

describe('阅片器点选分割（T2.3）', () => {
  it('补漏：预加载序列 → 点选分割 → SEG 存回 → 医生补充的病灶（已确认）→ 后台补上肺叶', async () => {
    const t = await seeded()
    await t.it.prepare(t.a, STUDY, CT)
    expect(t.orthanc.archives).toEqual([CT])
    const l = await t.it.addAtPoints(t.a, STUDY, CT, [CLICK])
    expect(t.orthanc.archives).toEqual([CT])   // 已预加载：不再上传
    expect(l).toMatchObject({ source: 'manual', status: 'confirmed', label: '医生补充 1', location: null, version: 1 })
    expect(l.metrics).toMatchObject({ mean_diameter_mm: 15.6, detection_score: null, prompt_points: [CLICK], lobe_status: 'pending', key_slice_sop_instance_uid: `${CT}.222` })
    const call = t.worker.calls.find(c => c.path.endsWith('/point'))!
    expect(call.body).toEqual({ volume_id: expect.stringMatching(/^series_se[0-9a-f]{12}$/), points: [CLICK], seg: true, lobe: false })

    // 运行记录：点选任务、模型版本、所在序列；不列进检查的分析状态
    const run = t.svc.runSource(t.a, l.run_id!).run
    expect(run).toMatchObject({ task: POINT_TASK, status: 'done', model_version: 'vista3d@0.5.7', series_id: t.study.series[0]!.id })
    expect(run.summary).toMatchObject({ found: true, points: 1, negative_points: 0, seg_stored: true })
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.runs).toEqual([])

    // 阅片器列表：带 SEG 位置与所在序列
    const v = t.svc.lesionsByStudyUid(t.a, STUDY).find(x => x.id === l.id)!
    expect(v.series_uid).toBe(CT)
    expect(v.seg).toEqual({ series_uid: `${STUDY}.98.1`, segment_number: 1 })

    await t.it.idle()
    const after = t.svc.listLesions(t.a, t.study.id)[0]!
    expect(after).toMatchObject({ location: 'RUL', version: 1, metrics: { lobe_status: 'done' } })
    expect(t.svc.lesionEvents(t.a, l.id).map(e => e.action)).toEqual(['create', 'locate'])
    const lobeCall = t.worker.calls.find(c => c.path.endsWith('/lobe'))!
    expect(lobeCall.body).toMatchObject({ lps_mm: [-43.13, 37.73, 108.12], radius_mm: 7.8 })
    // 再点同一处：已有结节，不重复添加，也不留轮廓；运行照常记下
    const segsBefore = t.svc.listStudies(t.a, t.p.id)[0]!.series.length
    await expect(t.it.addAtPoints(t.a, STUDY, CT, [CLICK])).rejects.toMatchObject({ code: 'duplicate_lesion', status: 409, message: expect.stringContaining('医生补充 1') })
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.series.length).toBe(segsBefore)
    expect(t.svc.listLesions(t.a, t.study.id)).toHaveLength(1)
    // 否决之后可以再补回（医生改主意）；编号递增
    t.svc.reviewLesion(t.a, l.id, { status: 'rejected', reason: '其他' })
    expect((await t.it.addAtPoints(t.a, STUDY, CT, [CLICK])).label).toBe('医生补充 2')
    await t.it.idle()
  })

  it('点击处没有结构：422 写明原因，不建病灶，运行照常记下（未分割到）', async () => {
    const t = await seeded({ found: false })
    await expect(t.it.addAtPoints(t.a, STUDY, CT, [CLICK])).rejects.toMatchObject({ code: 'nothing_segmented', status: 422, message: '点击处 3 mm 内没有分割到结构' })
    expect(t.svc.listLesions(t.a, t.study.id)).toEqual([])
  })

  it('worker 重启或淘汰了序列：重新上传后再试一次', async () => {
    const t = await seeded({ evictOnce: true })
    await t.it.prepare(t.a, STUDY, CT)
    const l = await t.it.addAtPoints(t.a, STUDY, CT, [CLICK])
    expect(l.status).toBe('confirmed')
    expect(t.orthanc.archives).toEqual([CT, CT])
    await t.it.idle()
  })

  it('AI 不能点选；只能在 CT 序列上；至少一个正点；坐标格式校验', async () => {
    const t = await seeded()
    await expect(t.it.addAtPoints({ ...t.a, via: 'ai' }, STUDY, CT, [CLICK])).rejects.toMatchObject({ status: 403 })
    await expect(t.it.addAtPoints(t.a, STUDY, CT, [{ ...CLICK, positive: false }])).rejects.toMatchObject({ code: 'bad_points' })
    const SEG = `${STUDY}.50`
    t.orthanc.seriesTags.set(SEG, { modality: 'SEG' })
    const st = (await t.svc.importDicom(t.a, t.p.id, [{ name: 's', bytes: dicom(STUDY, SEG, `${SEG}.1`) }])).studies[0]!
    expect(st.id).toBe(t.study.id)
    await expect(t.it.addAtPoints(t.a, STUDY, SEG, [CLICK])).rejects.toMatchObject({ code: 'not_ct', status: 409 })
    await expect(t.it.addAtPoints(t.a, STUDY, `${STUDY}.404`, [CLICK])).rejects.toMatchObject({ status: 404 })
    expect(() => parsePoints([])).toThrow('1~20')
    expect(() => parsePoints([{ lps_mm: [1, 2] }])).toThrow('[X, Y, Z]')
    expect(() => parsePoints([{ lps_mm: [1, 2, Number.NaN] }])).toThrow('[X, Y, Z]')
    expect(parsePoints([{ lps_mm: [1, 2, 3] }])).toEqual([{ lps_mm: [1, 2, 3], positive: true }])
  })

  it('修边界：AI 结节以其中心为第一个正点，追加负点重新分割；点选的中间轮廓没人引用时清掉；AI 原始 SEG 一律保留', async () => {
    const t = await seeded()
    // AI 分析的结果：两个结节共用一个 SEG
    t.orthanc.seriesTags.set(AI_SEG, { modality: 'SEG', instances: 1 })
    const up = await t.orthanc.upload(dicom(STUDY, AI_SEG, `${AI_SEG}.1`))
    const aiSeg = await t.svc.addDerivedSeries(t.a, t.study.id, up.seriesId)
    const run = t.svc.startRun(t.a, t.study.id, { task: 'lung_nodule', model_id: 'lung_nodule_pipeline', series_id: t.study.series[0]!.id })
    const ai = t.svc.addLesion(t.a, t.study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', label: '结节 1', location: 'RUL', seg_ref: segRef(aiSeg, 1),
      metrics: { detection_score: 0.93, mean_diameter_mm: 20.5, center_lps_mm: [-42.23, 36.84, 108.12] } })
    const ai2 = t.svc.addLesion(t.a, t.study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', label: '结节 2', seg_ref: segRef(aiSeg, 2), metrics: { center_lps_mm: [20, 30, 40] } })

    const NEG: PromptPoint = { lps_mm: [-30, 40, 108], positive: false }
    const r1 = await t.it.refine(t.a, ai.id, [NEG])
    const sent = t.worker.calls.filter(c => c.path.endsWith('/point')).at(-1)!.body as { points: PromptPoint[] }
    expect(sent.points).toEqual([{ lps_mm: [-42.23, 36.84, 108.12], positive: true }, NEG])
    expect(r1).toMatchObject({ status: 'proposed', version: 2, location: 'RUL', metrics: { detection_score: 0.93, mean_diameter_mm: 15.6, refined: true, prompt_points: sent.points } })
    expect(r1.seg_ref).not.toBe(segRef(aiSeg, 1))
    expect(t.orthanc.deleted).toEqual([])          // AI SEG 还被结节 2 引用
    await t.it.idle()

    // 再修一次：上一次的点选轮廓只被它引用，被换下后清掉；点累积
    const POS: PromptPoint = { lps_mm: [-44, 38, 110], positive: true }
    const r2 = await t.it.refine(t.a, ai.id, [POS])
    expect((t.worker.calls.filter(c => c.path.endsWith('/point')).at(-1)!.body as { points: PromptPoint[] }).points).toEqual([...sent.points, POS])
    expect(r2.version).toBe(3)                     // 每次修边界 +1；肺叶定位不加版本号
    expect(t.orthanc.deleted).toEqual([`${STUDY}.98.1`])
    // replace：只用给出的点（面板「撤销上一点」）
    await t.it.refine(t.a, ai.id, [{ lps_mm: [-42.23, 36.84, 108.12], positive: true }], true)
    expect((t.worker.calls.filter(c => c.path.endsWith('/point')).at(-1)!.body as { points: PromptPoint[] }).points).toHaveLength(1)
    await t.it.idle()
    expect(t.svc.lesionEvents(t.a, ai.id).map(e => e.action)).toEqual(['create', 'edit', 'locate', 'edit', 'locate', 'edit', 'locate'])
    // 结节 2 也修过之后，AI SEG 已没有病灶引用，仍然保留
    await t.it.refine(t.a, ai2.id, [NEG])
    await t.it.idle()
    expect(t.orthanc.deleted).not.toContain(AI_SEG)
    expect(t.orthanc.deleted).toHaveLength(2)
  })

  it('肺叶定位过时（期间又修了边界）不覆盖；定位失败如实记下', async () => {
    const t = await seeded({ lobeFail: true })
    const l = await t.it.addAtPoints(t.a, STUDY, CT, [CLICK])
    expect(t.svc.setLesionLocation(t.a, l.id, l.version + 1, { location: 'LLL', status: 'done' })).toBe(false)
    await t.it.idle()
    const after = t.svc.listLesions(t.a, t.study.id)[0]!
    expect(after.location).toBeNull()
    expect(after.metrics).toMatchObject({ lobe_status: 'failed', lobe_note: expect.stringContaining('肺叶定位失败') })
  })

  it('撤销医生补充的结节：不再列出，轮廓清掉；AI 检出的不能撤销', async () => {
    const t = await seeded()
    const l = await t.it.addAtPoints(t.a, STUDY, CT, [CLICK])
    await t.it.idle()
    const w = await t.it.withdraw(t.a, l.id)
    expect(w.status).toBe('superseded')
    expect(t.svc.listLesions(t.a, t.study.id)).toEqual([])
    expect(t.orthanc.deleted).toEqual([`${STUDY}.98.1`])
    expect(t.svc.lesionEvents(t.a, l.id).at(-1)!.action).toBe('withdraw')
    const ai = t.svc.addLesion(t.a, t.study.id, { kind: 'lung_nodule', source: 'ai' })
    await expect(t.it.withdraw(t.a, ai.id)).rejects.toMatchObject({ code: 'not_manual', status: 409 })
    await expect(t.it.withdraw({ ...t.a, via: 'ai' }, l.id)).rejects.toMatchObject({ status: 403 })
  })
})

describe('阅片器点选接口', () => {
  it('Cookie 允许的检查、阅片器请求头；补漏 201、修边界、撤销、预加载；坏参数 400', async () => {
    const t = await seeded()
    const docs = new Documents(t.store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img-it-r-'))), accounts: new Accounts(t.store, { secret: 'test-secret', devMode: false, devToken: 'dev', devUser: 'dev' }),
      devMode: false, devUser: 'dev', patients: t.patients, orthanc: t.orthanc, imagingPipeline: null, imagingInteractive: t.it,
    })
    const H = { Authorization: `Bearer ${issueToken('test-secret', { u: t.dr, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: t.store.getUser(t.dr)!.token_version })}`, 'Content-Type': 'application/json' }
    process.env.VIEWER_HOST = 'viewer.test'
    process.env.VIEWER_URL = 'http://ohif:8080'
    try {
      const url = (await (await app.request('/api/imaging/viewer-ticket', { method: 'POST', headers: H, body: JSON.stringify({ study_uid: STUDY }) })).json() as { url: string }).url
      const cookie = (await app.request(url)).headers.get('set-cookie')!.split(';')[0]!
      const V = 'http://viewer.test'
      const post = (path: string, body: unknown, extra: Record<string, string> = { 'X-Heurion-Viewer': '1' }) =>
        app.request(`${V}${path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })

      expect((await post('/api/viewer/series/prepare', { study_uid: STUDY, series_uid: CT })).status).toBe(200)
      expect((await post('/api/viewer/lesions/point', { study_uid: STUDY, series_uid: CT, points: [CLICK] }, {})).status).toBe(403)
      expect((await post('/api/viewer/lesions/point', { study_uid: `${STUDY}.7`, series_uid: CT, points: [CLICK] })).status).toBe(404)
      expect((await post('/api/viewer/lesions/point', { study_uid: STUDY, series_uid: CT, points: [] })).status).toBe(400)
      const created = await post('/api/viewer/lesions/point', { study_uid: STUDY, series_uid: CT, points: [CLICK] })
      expect(created.status).toBe(201)
      const l = await created.json() as { id: string; series_uid: string; seg: { series_uid: string; segment_number: number }; status: string }
      expect(l).toMatchObject({ series_uid: CT, seg: { series_uid: `${STUDY}.98.1`, segment_number: 1 }, status: 'confirmed' })
      await t.it.idle()

      const refined = await post(`/api/viewer/lesions/${l.id}/refine`, { points: [{ lps_mm: [-30, 40, 108], positive: false }] })
      expect(refined.status).toBe(200)
      expect(await refined.json()).toMatchObject({ id: l.id, version: 2, seg: { series_uid: `${STUDY}.98.2` } })
      await t.it.idle()
      const w = await post(`/api/viewer/lesions/${l.id}/withdraw`, {})
      expect(await w.json()).toEqual({ id: l.id, status: 'superseded' })
      expect((await post(`/api/viewer/lesions/${l.id}/refine`, { points: [CLICK] })).status).toBe(404)
      // 主站上没有这些接口
      expect((await app.request('/api/viewer/lesions/point', { method: 'POST', headers: H, body: '{}' })).status).toBe(404)
    } finally {
      delete process.env.VIEWER_HOST
      delete process.env.VIEWER_URL
    }
  })
})
