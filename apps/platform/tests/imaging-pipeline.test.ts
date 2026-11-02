import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { buildApi } from '../src/http/api.ts'
import { ImagingPipeline, selectLungSeries } from '../src/imaging/pipeline.ts'
import { ImagingStudyService, type SeriesView } from '../src/imaging/studies.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import { dicom, FakeOrthanc, fakeWorker, NODULE_RESULT, seriesFiles } from './imaging-fakes.ts'

const STUDY = '1.2.840.113619.2.55.3.2001'
const THIN = `${STUDY}.2`
const THICK = `${STUDY}.3`

const series = (over: Partial<SeriesView>): SeriesView => ({ id: 'se', modality: 'CT', body_part: 'CHEST', description: null, slice_thickness: 1, kernel: 'B70f', instances: 300, ...over })

describe('按病种选序列（W1.2 肺结节）', () => {
  it('薄层肺算法优先于薄层软组织算法与厚层；定位像不选', () => {
    const r = selectLungSeries([
      series({ id: 'scout', instances: 2, slice_thickness: null }),
      series({ id: 'thick', slice_thickness: 5, kernel: 'B70f' }),
      series({ id: 'soft', slice_thickness: 1, kernel: 'B30f' }),
      series({ id: 'lung', slice_thickness: 1, kernel: 'B70f' }),
    ])
    expect(r.series?.id).toBe('lung')
    expect(r.notes).toEqual([])
  })

  it('只有 2 mm 软组织算法时可分析但写明原因；全是厚层、非胸部、非 CT 时不分析并说明', () => {
    const r = selectLungSeries([series({ slice_thickness: 2, kernel: 'STANDARD' })])
    expect(r.series).not.toBeNull()
    expect(r.notes).toEqual(['所选序列层厚 2 mm，大于推荐的 1.25 mm', '所选序列不是肺算法重建（STANDARD）'])
    expect(selectLungSeries([series({ slice_thickness: 5 })]).reason).toContain('层厚均大于 2.5 mm')
    expect(selectLungSeries([series({ body_part: 'HEAD' })]).reason).toContain('不是胸部')
    expect(selectLungSeries([series({ modality: 'MR' })]).reason).toBe('检查中没有 CT 序列')
    expect(selectLungSeries([series({ instances: 10 })]).reason).toContain('至少 30 层')
  })
})

function env(handler: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const store = new Store(':memory:')
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-img-pl-')), new TenantService(store, { devMode: false }), new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const dr = store.createUser({ username: 'dr_wang', display_name: '王医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const orthanc = new FakeOrthanc()
  orthanc.seriesTags.set(THICK, { sliceThickness: 5, kernel: 'B30f' })
  const svc = new ImagingStudyService(patients, orthanc)
  const worker = fakeWorker(handler)
  const pipeline = new ImagingPipeline(svc, orthanc, 'http://worker:8004', { fetch: worker.fetchImpl })
  const a: Actor = { userId: dr, via: 'user' }
  return { store, patients, orthanc, svc, worker, pipeline, a, dr }
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const happy = (path: string) => path.endsWith('/lung-nodule') ? ok(NODULE_RESULT) : ok({ ok: true })

async function seeded(handler: (path: string, init: RequestInit) => Response | Promise<Response> = happy) {
  const t = env(handler)
  const p = t.patients.create(t.a, { sex: 'M', birth_year: 1958 })
  const r = await t.svc.importDicom(t.a, p.id, [...seriesFiles(STUDY, THIN, 40), ...seriesFiles(STUDY, THICK, 40)])
  return { ...t, p, study: r.studies[0]! }
}

describe('分析流水线（T1.4）', () => {
  it('选薄层序列 → 取原件交给 worker → 检出入库为待确认 → 释放 worker 缓存', async () => {
    const t = await seeded()
    const r = t.pipeline.enqueue(t.a, t.study.id)
    expect(r.run).toMatchObject({ status: 'queued', task: 'lung_nodule', model_id: 'lung_nodule_pipeline' })
    expect(t.pipeline.isActive(r.run!.id)).toBe(true)
    await t.pipeline.idle()
    expect(t.pipeline.isActive(r.run!.id)).toBe(false)

    expect(t.orthanc.archives).toEqual([THIN])
    const volumeId = `run_${r.run!.id}`
    expect(t.worker.calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST /api/v1/volume/upload', 'POST /api/v1/pipeline/lung-nodule', `DELETE /api/v1/volume/${volumeId}`])
    expect(t.worker.calls[0]!.body).toEqual({ volume_id: volumeId })
    expect(t.worker.calls[1]!.body).toEqual({ volume_id: volumeId, max_nodules: 20 })

    const run = t.svc.listStudies(t.a, t.p.id)[0]!.runs[0]!
    expect(run).toMatchObject({ status: 'done', error: null, model_version: 'lung_nodule_ct@0.5.9+vista3d@0.5.7' })
    expect(run.summary).toMatchObject({ found: 2, device: 'cpu', elapsed_ms: 4200, superseded: 0 })

    const lesions = t.svc.listLesions(t.a, t.study.id)
    expect(lesions.map(l => [l.label, l.location, l.status, l.source])).toEqual([['结节 1', 'RUL', 'proposed', 'ai'], ['结节 2', 'LLL', 'proposed', 'ai']])
    expect(lesions[0]!.metrics).toMatchObject({ mean_diameter_mm: 8.2, volume_mm3: 288.4, detection_score: 0.93, key_slice_z: 120, segmentation: 'vista3d' })
    expect(lesions[0]!.metrics).toMatchObject({ center_lps_mm: [-43.13, 37.73, 108.12], key_slice_sop_instance_uid: '1.2.826.0.1.3680043.8.498.6995' })
    expect(lesions[1]!.metrics).toMatchObject({ center_lps_mm: null, key_slice_sop_instance_uid: null })
    expect(lesions[1]!.metrics).toMatchObject({ segmentation: 'failed', warnings: ['分割失败，测量取检出框径'] })
  })

  it('worker 报模型不可用：运行失败并如实记原因，仍释放缓存；不留检出', async () => {
    const t = await seeded(path => path.endsWith('/lung-nodule') ? new Response(JSON.stringify({ detail: 'lung_nodule_ct 权重缺失' }), { status: 501 }) : ok({ ok: true }))
    const r = t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()
    const run = t.svc.listStudies(t.a, t.p.id)[0]!.runs[0]!
    expect(run.status).toBe('failed')
    expect(run.error).toBe('模型不可用（HTTP 501）：lung_nodule_ct 权重缺失')
    expect(t.worker.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/v1/volume/run_${r.run!.id}` })
    expect(t.svc.listLesions(t.a, t.study.id)).toEqual([])
  })

  it('worker 连不上：失败原因可读，没上传成功就不调删除', async () => {
    const t = await seeded(() => { throw new TypeError('fetch failed') })
    t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.runs[0]!.error).toBe('影像服务连接失败：fetch failed')
    expect(t.worker.calls.map(c => c.method)).toEqual(['POST'])
  })

  it('重新分析：旧运行里未处理的检出被取代，医生处理过的保留', async () => {
    const t = await seeded()
    t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()
    const [first, second] = t.svc.listLesions(t.a, t.study.id)
    t.svc.reviewLesion(t.a, first!.id, { status: 'confirmed' })
    t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()
    const now = t.svc.listLesions(t.a, t.study.id)
    expect(now.map(l => l.id)).toContain(first!.id)
    expect(now.map(l => l.id)).not.toContain(second!.id)
    // 1 号结节医生已确认：第二次分析里同一处的检出不再新增；只新增 2 号
    expect(now.filter(l => l.status === 'proposed')).toHaveLength(1)
    expect(now.filter(l => l.label === '结节 1')).toHaveLength(1)
    expect(t.svc.lesionEvents(t.a, second!.id).map(e => e.action)).toEqual(['create', 'supersede'])
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.runs[0]!.summary).toMatchObject({ superseded: 1, matched_reviewed: 1, found: 1 })
  })

  it('分割结果（DICOM SEG）存回 Orthanc、登记为派生序列；结节记下所在 segment；阅片器列表带 SEG 的 UID', async () => {
    const SEG = `${STUDY}.77`
    const segFile = dicom(STUDY, SEG, `${SEG}.1`)
    const withSeg = {
      ...NODULE_RESULT,
      nodules: NODULE_RESULT.nodules.map(n => ({ ...n, seg_segment_number: n.segmentation === 'vista3d' ? 1 : null })),
      seg: { dicom_base64: Buffer.from(segFile).toString('base64'), series_instance_uid: SEG, sop_instance_uid: `${SEG}.1` },
    }
    const t = await seeded(path => path.endsWith('/lung-nodule') ? ok(withSeg) : ok({ ok: true }))
    t.orthanc.seriesTags.set(SEG, { modality: 'SEG', description: 'Heurion AI lung nodules', sliceThickness: null, kernel: null })
    t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()
    expect([...t.orthanc.instances.values()].some(i => i.series === SEG)).toBe(true)
    const st = t.svc.listStudies(t.a, t.p.id, true)[0]!
    expect(st.series.find(x => x.series_uid === SEG)).toMatchObject({ modality: 'SEG' })
    expect(st.runs[0]!.summary).toMatchObject({ seg_stored: true })
    const lesions = t.svc.lesionsByStudyUid(t.a, STUDY)
    expect(lesions[0]!.seg).toEqual({ series_uid: SEG, segment_number: 1 })
    expect(lesions[1]!.seg).toBeNull() // 分割失败的结节没有 segment
    // 自动选序列时不会选到 SEG
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.runs[0]!.status).toBe('done')
  })

  it('重新分析：旧 SEG 只被已取代的检出引用时从影像存储清掉；医生确认过的结节的 SEG 保留', async () => {
    let n = 0
    const SEGS: string[] = []
    const withSeg = () => {
      const SEG = `${STUDY}.8${++n}`
      SEGS.push(SEG)
      return {
        ...NODULE_RESULT,
        nodules: NODULE_RESULT.nodules.map(x => ({ ...x, seg_segment_number: x.segmentation === 'vista3d' ? 1 : null })),
        seg: { dicom_base64: Buffer.from(dicom(STUDY, SEG, `${SEG}.1`)).toString('base64'), series_instance_uid: SEG, sop_instance_uid: `${SEG}.1` },
      }
    }
    const t = await seeded(path => path.endsWith('/lung-nodule') ? ok(withSeg()) : ok({ ok: true }))
    const segSeries = () => t.svc.listStudies(t.a, t.p.id, true)[0]!.series.filter(x => x.modality === 'SEG').map(x => x.series_uid)
    const markSeg = () => { for (const u of SEGS) t.orthanc.seriesTags.set(u, { modality: 'SEG', sliceThickness: null, kernel: null }) }

    // 第一次分析 → 第二次分析：第一次的检出都没处理过，全部被取代，第一次的 SEG 被清掉
    const prime = (fn: () => void) => { const orig = t.orthanc.upload.bind(t.orthanc); t.orthanc.upload = async b => { const r = await orig(b); fn(); return r } }
    prime(markSeg)
    t.pipeline.enqueue(t.a, t.study.id); await t.pipeline.idle()
    t.pipeline.enqueue(t.a, t.study.id); await t.pipeline.idle()
    expect(t.orthanc.deleted).toEqual([SEGS[0]])
    expect(segSeries()).toEqual([SEGS[1]])
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.runs[0]!.summary).toMatchObject({ seg_removed: 1 })
    expect(t.patients.accessLog(t.a, t.p.id).some((l: { action: string }) => l.action === 'imaging_seg_removed')).toBe(true)

    // 医生确认第二次的 1 号结节 → 第三次分析：同一结节不重复新增，第二次的 SEG 因被已确认结节引用而保留
    const confirmed = t.svc.listLesions(t.a, t.study.id).find(l => l.label === '结节 1')!
    t.svc.reviewLesion(t.a, confirmed.id, { status: 'confirmed' })
    t.pipeline.enqueue(t.a, t.study.id); await t.pipeline.idle()
    expect(segSeries()).toContain(SEGS[1])
    expect(t.svc.lesionsByStudyUid(t.a, STUDY).find(l => l.id === confirmed.id)!.seg).toEqual({ series_uid: SEGS[1], segment_number: 1 })
    // 第三次的 SEG 里只有 1 号结节，它与已确认结节同一处没有入库：这份 SEG 无人引用，当场清掉
    expect(t.orthanc.deleted).toEqual([SEGS[0], SEGS[2]])
    expect(segSeries()).toEqual([SEGS[1]])
    expect(t.svc.listStudies(t.a, t.p.id)[0]!.runs[0]!.summary).toMatchObject({ seg_stored: false, matched_reviewed: 1 })
  })

  it('SEG 存不进影像存储时：检出照常入库，运行摘要写明原因', async () => {
    const withSeg = { ...NODULE_RESULT, seg: { dicom_base64: Buffer.from('not dicom').toString('base64'), series_instance_uid: '1.2', sop_instance_uid: '1.2.1' } }
    const t = await seeded(path => path.endsWith('/lung-nodule') ? ok(withSeg) : ok({ ok: true }))
    t.pipeline.enqueue(t.a, t.study.id)
    await t.pipeline.idle()
    const run = t.svc.listStudies(t.a, t.p.id)[0]!.runs[0]!
    expect(run.status).toBe('done')
    expect(run.summary).toMatchObject({ seg_stored: false })
    expect((run.summary as { warnings: string[] }).warnings.some(w => w.startsWith('分割结果（DICOM SEG）未能存入影像存储'))).toBe(true)
    expect(t.svc.listLesions(t.a, t.study.id)).toHaveLength(2)
  })

  it('多用户排队按用户轮转：一人批量提交不会堵住别人；可查前面还有几个任务', async () => {
    const t = await seeded()
    const drB = t.store.createUser({ username: 'dr_li', display_name: '李医生', password_hash: 'x', tenant: { id: t.store.getUser(t.dr)!.tenant_id!, role: 'member' } }).id
    const b: Actor = { userId: drB, via: 'user' }
    const pB = t.patients.create(b, { sex: 'F', birth_year: 1966 })
    const stB = (await t.svc.importDicom(b, pB.id, seriesFiles('1.2.840.113619.2.55.3.3001', '1.2.840.113619.2.55.3.3001.2', 40))).studies[0]!
    const a1 = t.pipeline.enqueue(t.a, t.study.id).run!.id
    const a2 = t.pipeline.enqueue(t.a, t.study.id).run!.id
    const a3 = t.pipeline.enqueue(t.a, t.study.id).run!.id
    const b1 = t.pipeline.enqueue(b, stB.id).run!.id
    await Promise.resolve() // 让第一次派发发生
    expect(t.pipeline.waitingAhead(a1)).toBeNull() // 已在分析
    expect(t.pipeline.waitingAhead(b1)).toBe(1)    // 只等正在分析的 a1
    expect(t.pipeline.waitingAhead(a3)).toBe(3)
    await t.pipeline.idle()
    const order = t.worker.calls.filter(c => c.path === '/api/v1/volume/upload').map(c => String((c.body as { volume_id: string }).volume_id).slice(4))
    expect(order).toEqual([a1, b1, a2, a3])
  })

  it('没有合适序列时不建运行，说明原因', async () => {
    const t = env(happy)
    const p = t.patients.create(t.a, { sex: 'M', birth_year: 1958 })
    const r = await t.svc.importDicom(t.a, p.id, seriesFiles(STUDY, THICK, 40))
    expect(t.pipeline.enqueue(t.a, r.studies[0]!.id)).toEqual({ task: 'lung_nodule', skipped: '胸部 CT 层厚均大于 2.5 mm（最薄 5 mm），不适合结节分析' })
    expect(t.svc.listStudies(t.a, p.id)[0]!.runs).toEqual([])
  })
})

describe('分析接口', () => {
  function api() {
    const t = env(happy)
    const docs = new Documents(t.store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img-pl-r-'))), accounts: new Accounts(t.store, { secret: 'test-secret', devMode: false, devToken: 'dev', devUser: 'dev' }),
      devMode: false, devUser: 'dev', patients: t.patients, orthanc: t.orthanc, imagingPipeline: t.pipeline,
    })
    const auth = { Authorization: `Bearer ${issueToken('test-secret', { u: t.dr, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: t.store.getUser(t.dr)!.token_version })}` }
    return { ...t, app, auth }
  }

  it('上传即排队分析；列表带运行状态；可重新分析；不适用时 409', async () => {
    const t = api()
    const p = t.patients.create(t.a, { sex: 'M', birth_year: 1958 })
    const form = new FormData()
    for (const f of seriesFiles(STUDY, THIN, 40)) form.append('files', new File([f.bytes], f.name))
    const up = await t.app.request(`/api/patients/${p.id}/imaging/dicom`, { method: 'POST', headers: t.auth, body: form })
    expect(up.status).toBe(201)
    const body = await up.json() as { studies: Array<{ id: string }>; analysis: Array<{ study_id: string; task: string; run_id: string | null; skipped: string | null }> }
    expect(body.analysis).toEqual([{ study_id: body.studies[0]!.id, task: 'lung_nodule', run_id: expect.any(String), shadow: false, skipped: null, notes: [] }])
    await t.pipeline.idle()

    const list = await (await t.app.request(`/api/patients/${p.id}/imaging/studies`, { headers: t.auth })).json() as Array<{ runs: Array<{ status: string }>; lesions: { proposed: number } }>
    expect(list[0]!.runs[0]!.status).toBe('done')
    expect(list[0]!.lesions.proposed).toBe(2)

    const again = await t.app.request(`/api/patients/${p.id}/imaging/studies/${body.studies[0]!.id}/analyze`, { method: 'POST', headers: { ...t.auth, 'Content-Type': 'application/json' }, body: '{}' })
    expect(again.status).toBe(202)
    await t.pipeline.idle()
    expect((await t.app.request(`/api/patients/${p.id}/imaging/studies/is-none/analyze`, { method: 'POST', headers: t.auth })).status).toBe(404)

    // 重复上传同样的文件：没有新实例，不再排队
    const form2 = new FormData()
    for (const f of seriesFiles(STUDY, THIN, 40)) form2.append('files', new File([f.bytes], f.name))
    const up2 = await (await t.app.request(`/api/patients/${p.id}/imaging/dicom`, { method: 'POST', headers: t.auth, body: form2 })).json() as { analysis: unknown[] }
    expect(up2.analysis).toEqual([])
  })

  it('服务重启后遗留的排队 / 处理中运行显示为中断', async () => {
    const t = api()
    const p = t.patients.create(t.a, { sex: 'M', birth_year: 1958 })
    const r = await t.svc.importDicom(t.a, p.id, seriesFiles(STUDY, THIN, 40))
    // 直接建运行、不经本进程的队列，模拟上一个进程留下的
    t.svc.startRun(t.a, r.studies[0]!.id, { task: 'lung_nodule', model_id: 'lung_nodule_pipeline' })
    const list = await (await t.app.request(`/api/patients/${p.id}/imaging/studies`, { headers: t.auth })).json() as Array<{ runs: Array<{ status: string; error: string }> }>
    expect(list[0]!.runs[0]).toMatchObject({ status: 'interrupted', error: '服务重启，分析中断，请重新分析' })
  })
})
