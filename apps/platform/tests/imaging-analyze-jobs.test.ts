import { mkdtempSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TenantService, DEFAULT_SETTINGS } from '../src/auth/tenants.ts'
import { Accounts } from '../src/auth/accounts.ts'
import { issueToken } from '../src/auth/token.ts'
import { buildApi } from '../src/http/api.ts'
import { makeInvoker } from '../src/http/invoke.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import { INTERRUPTED_REASON } from '../src/imaging/analyze-jobs.ts'
import { isNifti } from '../src/imaging/nifti-sniff.ts'

/** 最小的 NIfTI-1 头（sizeof_hdr = 348，magic "n+1\0"），后面带几个体素字节 */
function niftiBytes(gz = true): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(352 + 8)
  new DataView(b.buffer).setInt32(0, 348, true)
  b.set([0x6e, 0x2b, 0x31, 0], 344)
  return gz ? new Uint8Array(gzipSync(b)) : b
}
/** 带 DICM 前缀的最小 DICOM Part 10 文件开头 */
function dicomBytes(): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(256)
  b.set([0x44, 0x49, 0x43, 0x4d], 128)
  return b
}

/**
 * 旧版「影像分析」接口改为异步（docs/design/IMAGING_STUDIES.md「旧版影像分析的后台任务」）：
 * 202 立即返回、后台失败记入任务、完成后带 record_id、平台重启后为 interrupted。
 */

const SECRET = 'test-secret'
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
const RESULT = {
  model_name: 'bronchiectasis_mucus_analyzer', modality: 'Chest HRCT', key_slice_png_base64: PNG_B64,
  metrics: { broncho_arterial_ratio: 1.42, total_mucus_volume_cm3: 1.2, high_attenuation_mucus_cm3: 0 },
}

function env(root = mkdtempSync(join(tmpdir(), 'hr-img-async-')), store = new Store(':memory:')) {
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: SECRET }))
  const svc = new PatientService(root, tenants, keys, store)
  return { root, store, tenants, keys, svc }
}

function appFor(store: Store, svc: PatientService, extra: { imagingAcceptIdentified?: boolean } = {}) {
  const docs = new Documents(store)
  return buildApi({
    docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img-async-render-'))),
    accounts: new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' }),
    devMode: false, devUser: 'dev', patients: svc, ...extra,
  })
}

function setup() {
  const e = env()
  const hosp = e.store.createTenant({ name: '呼吸科', kind: 'org' })
  const user = e.store.createUser({ username: 'dr_wang', display_name: '王医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const other = e.store.createUser({ username: 'dr_zhou', display_name: '周医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const tok = (u: string) => `Bearer ${issueToken(SECRET, { u, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: e.store.getUser(u)!.token_version })}`
  const patient = e.svc.create({ userId: user, via: 'user' }, { sex: 'F', birth_year: 1970 })
  const app = appFor(e.store, e.svc)
  return { ...e, hosp, user, other, tok, patient, app }
}

type Env = ReturnType<typeof setup>

/** 假 worker：每次分析请求挂起，直到测试调用 release(结果) */
let workerHandler: (path: string, init: RequestInit) => Promise<Response>
const origFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    if (!url.startsWith('http://127.0.0.1:8004')) return origFetch(input, init)
    return workerHandler(new URL(url).pathname, init)
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = origFetch; vi.restoreAllMocks() })

function deferredWorker() {
  const pending: Array<(r: Response | Error) => void> = []
  const paths: string[] = []
  workerHandler = (path, init) => {
    paths.push(path)
    if (path.startsWith('/api/v1/analyze/jobs/')) return Promise.resolve(Response.json({ stage: '肺叶分割', detail: '第 2 步 / 共 4 步', percent: 60 }))
    if (path.startsWith('/api/v1/samples/')) return Promise.resolve(new Response(new Uint8Array([1, 2, 3])))
    return new Promise((resolve, reject) => {
      pending.push(r => (r instanceof Error ? reject(r) : resolve(r)))
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })
  }
  return {
    paths,
    release: (r: Response | Error) => { const f = pending.shift(); if (!f) throw new Error('没有挂起的 worker 请求'); f(r) },
    waitPending: async () => { for (let i = 0; i < 100 && pending.length === 0; i++) await new Promise(r => setTimeout(r, 5)) },
  }
}

async function submitFile(t: Env, opts: { user?: string; name?: string; bytes?: Uint8Array<ArrayBuffer> } = {}) {
  const fd = new FormData()
  fd.append('file', new File([opts.bytes ?? niftiBytes()], opts.name ?? '张三-胸部CT.nii.gz'))
  fd.append('model_id', 'bronchiectasis_mucus_analyzer')
  return t.app.request(`/api/patients/${t.patient.id}/imaging/analyze`, { method: 'POST', headers: { Authorization: t.tok(opts.user ?? t.user) }, body: fd })
}

async function jobs(t: Env, app = t.app) {
  const res = await app.request(`/api/patients/${t.patient.id}/imaging/jobs`, { headers: { Authorization: t.tok(t.user) } })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ active: any; latest: any }>
}

/** 轮询直到任务离开 running */
async function settled(t: Env) {
  for (let i = 0; i < 200; i++) {
    const j = await jobs(t)
    if (j.latest && j.latest.status !== 'running') return j
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('任务没有结束')
}

describe('旧版影像分析接口：异步任务', () => {
  it('202 立即返回（worker 还没算完），轮询可见进度；同一患者再提交 409；完成后带 record_id 并已入档', async () => {
    const t = setup()
    const w = deferredWorker()
    const res = await submitFile(t)
    expect(res.status).toBe(202)
    const body = await res.json() as any
    expect(body).toMatchObject({ ok: true, status: 'running', job: { status: 'running', patient_id: t.patient.id, file_name: '张三-胸部CT.nii.gz' } })
    expect(body.job_id).toMatch(/^imgjob_/)
    expect(body.job.via).toBeUndefined()

    await w.waitPending()
    const running = await jobs(t)
    expect(running.active).toMatchObject({ job_id: body.job_id, status: 'running', stage: '肺叶分割', percent: 60 })

    const dup = await submitFile(t)
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as any).job.job_id).toBe(body.job_id)

    w.release(Response.json(RESULT))
    const done = await settled(t)
    expect(done.active).toBeNull()
    expect(done.latest).toMatchObject({ job_id: body.job_id, status: 'completed', percent: 100 })
    expect(done.latest.record_id).toMatch(/^rc/)
    const detail = t.svc.read({ userId: t.user, via: 'user' }, t.patient.id)
    const rec = detail.records.find(r => r.id === done.latest.record_id)
    expect(rec?.kind).toBe('imaging')
    expect(detail.tags).toContain('BAR 增大')

    // 结束后可以再提交
    const again = await submitFile(t)
    expect(again.status).toBe(202)
    await w.waitPending()
    w.release(Response.json(RESULT))
    await settled(t)
  })

  it('任务终态写进机构患者库；上传文件名只存加密值', async () => {
    const t = setup()
    const w = deferredWorker()
    const body = await (await submitFile(t)).json() as any
    await w.waitPending()
    w.release(Response.json(RESULT))
    await settled(t)
    const scope = t.svc.imagingScope({ userId: t.user, via: 'user' }, t.patient.id, 'read')
    const row = scope.db.prepare('SELECT * FROM imaging_analyze_jobs WHERE id = ?').get(body.job_id) as any
    expect(row.status).toBe('completed')
    expect(row.record_id).toBeTruthy()
    expect(String(row.file_name_enc)).not.toContain('张三')
    expect(scope.decrypt(row.file_name_enc)).toBe('张三-胸部CT.nii.gz')
  })

  it('worker 返回 501 / 500、连不上、超时：任务记 failed 与可读原因，不产生未处理的 rejection', async () => {
    const cases: Array<[Response | Error, string]> = [
      [Response.json({ detail: '本机没有安装该模型权重' }, { status: 501 }), '模型不可用：本机没有安装该模型权重'],
      [new Response('<html>Internal Server Error</html>', { status: 500 }), '影像微服务出错（HTTP 500）'],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), '影像计算微服务连接异常：fetch failed（ECONNREFUSED）'],
      [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), '超过 300 秒'],
    ]
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      for (const [resp, expected] of cases) {
        const t = setup()
        const w = deferredWorker()
        expect((await submitFile(t)).status).toBe(202)
        await w.waitPending()
        w.release(resp)
        const j = await settled(t)
        expect(j.latest.status).toBe('failed')
        expect(j.latest.error).toContain(expected)
        expect(j.latest.record_id).toBeUndefined()
        // 失败后不再挡住重新提交
        expect((await submitFile(t)).status).toBe(202)
      }
      await new Promise(r => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('推理成功但入档失败：任务记 failed，原因说明推理已完成', async () => {
    const t = setup()
    const w = deferredWorker()
    vi.spyOn(t.svc, 'addImagingRecord').mockImplementation(() => { throw new Error('磁盘已满') })
    expect((await submitFile(t)).status).toBe(202)
    await w.waitPending()
    w.release(Response.json(RESULT))
    const j = await settled(t)
    expect(j.latest).toMatchObject({ status: 'failed', error: '推理已完成，但写入患者档案失败：磁盘已满' })

    // worker 没给关键截面
    const t2 = setup()
    const w2 = deferredWorker()
    expect((await submitFile(t2)).status).toBe(202)
    await w2.waitPending()
    w2.release(Response.json({ ...RESULT, key_slice_png_base64: '' }))
    expect((await settled(t2)).latest).toMatchObject({ status: 'failed', error: '影像计算未返回切片图像' })
  })

  it('推理期间被移出诊疗组：入档时重新核对权限，任务记 failed，不写入记录', async () => {
    const t = setup()
    const w = deferredWorker()
    const owner = { userId: t.user, via: 'user' as const }
    t.svc.addMember(owner, t.patient.id, t.other)
    expect((await submitFile(t, { user: t.other })).status).toBe(202)
    await w.waitPending()
    t.svc.removeMember(owner, t.patient.id, t.other)
    w.release(Response.json(RESULT))
    const j = await settled(t)
    expect(j.latest.status).toBe('failed')
    expect(j.latest.error).toMatch(/^推理已完成，但未能存入患者档案/)
    expect(t.svc.read(owner, t.patient.id).records.filter(r => r.kind === 'imaging')).toHaveLength(0)
  })

  it('平台重启：上一个进程留下的 running 任务读取时记为 interrupted 并写明原因，可重新提交', async () => {
    const t = setup()
    const w = deferredWorker()
    const body = await (await submitFile(t)).json() as any
    await w.waitPending()

    // 同一个数据目录与平台库，新的 PatientService 与路由（内存里的任务表为空）= 重启后的进程
    const t2 = env(t.root, t.store)
    const app2 = appFor(t.store, t2.svc)
    const j = await jobs(t, app2)
    expect(j.active).toBeNull()
    expect(j.latest).toMatchObject({ job_id: body.job_id, status: 'interrupted', error: INTERRUPTED_REASON })
    expect(j.latest.ended_at).toBeGreaterThan(0)
    // 再读一次仍是 interrupted（已写回库里）
    expect((await jobs(t, app2)).latest.status).toBe('interrupted')
    // 不挡住新任务
    const fd = new FormData()
    fd.append('file', new File([niftiBytes()], 'scan.nii.gz'))
    expect((await app2.request(`/api/patients/${t.patient.id}/imaging/analyze`, { method: 'POST', headers: { Authorization: t.tok(t.user) }, body: fd })).status).toBe(202)
    // 旧进程的推理收尾不影响
    w.release(new Error('进程已退出'))
    w.release(Response.json(RESULT))
  })

  it('从没提交过时 latest 为 null；没有影像 400；不在诊疗组看不到患者（404，与原来一致），均不登记任务', async () => {
    const t = setup()
    deferredWorker()
    expect(await jobs(t)).toEqual({ active: null, latest: null })
    const none = await t.app.request(`/api/patients/${t.patient.id}/imaging/analyze`, {
      method: 'POST', headers: { Authorization: t.tok(t.user), 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: 'x' }),
    })
    expect(none.status).toBe(400)
    expect(((await none.json()) as any).error).toBe('no_image')
    expect((await submitFile(t, { user: t.other })).status).toBe(404)
    const foreign = await t.app.request(`/api/patients/${t.patient.id}/imaging/jobs`, { headers: { Authorization: t.tok(t.other) } })
    expect(foreign.status).toBe(404)
    expect(await jobs(t)).toEqual({ active: null, latest: null })
  })

  it('sample_id 路径同样异步：入档带演示样本标注', async () => {
    const t = setup()
    const w = deferredWorker()
    const res = await t.app.request(`/api/patients/${t.patient.id}/imaging/analyze`, {
      method: 'POST', headers: { Authorization: t.tok(t.user), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sample_id: 'chest_lung_ct', model_id: 'bronchiectasis_mucus_analyzer' }),
    })
    expect(res.status).toBe(202)
    expect(((await res.json()) as any).job).toMatchObject({ file_name: 'chest_lung_ct', status: 'running' })
    await w.waitPending()
    expect(w.paths).toContain('/api/v1/analyze/sample')
    w.release(Response.json(RESULT))
    const j = await settled(t)
    expect(j.latest.status).toBe('completed')
    const rec = t.svc.read({ userId: t.user, via: 'user' }, t.patient.id).records.find(r => r.id === j.latest.record_id)!
    expect(rec.title).toMatch(/^【演示样本】/)
  })

  it('AI（via = ai）经 REST 调用：权限检查与原来一致（机构不许外部模型分析时 403），后台入档按 AI 记访问日志', async () => {
    const t = setup()
    const w = deferredWorker()
    const invoke = makeInvoker(t.app)
    const ok = await invoke(t.user, 'POST', `/api/patients/${t.patient.id}/imaging/analyze`, { json: { sample_id: 'chest_lung_ct' } })
    expect(ok.status).toBe(202)
    await w.waitPending()
    w.release(Response.json(RESULT))
    const j = await settled(t)
    expect(j.latest.status).toBe('completed')
    const log = t.svc.accessLog({ userId: t.user, via: 'user' }, t.patient.id)
    expect(log.find(l => l.action === 'imaging_analyze')?.via).toBe('ai')

    t.store.updateTenant(t.hosp.id, { settings: JSON.stringify({ ...DEFAULT_SETTINGS, external_model_for_patients: false }) })
    const denied = await invoke(t.user, 'POST', `/api/patients/${t.patient.id}/imaging/analyze`, { json: { sample_id: 'chest_lung_ct' } })
    expect(denied.status).toBe(403)
  })

  it('没开「接收原件」时只收 NIfTI：DICOM、zip 拒收（400，不登记任务、不调 worker），并说明去「上传影像」', async () => {
    const t = setup()
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
    for (const [name, bytes] of [['张三.dcm', dicomBytes()], ['张三.zip', zip], ['伪装成.nii.gz', gzipSync(dicomBytes())]] as const) {
      const res = await submitFile(t, { name, bytes: new Uint8Array(bytes) })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string; message: string }
      expect(body.error).toBe('identified_upload')
      expect(body.message).toContain('上传影像')
    }
    expect((await jobs(t)).latest).toBeNull()
  })

  it('院内部署开了「接收原件」：DICOM 照常提交（202）', async () => {
    const t = setup()
    workerHandler = async () => Response.json({ error: 'not_now' }, { status: 501 })
    const app = appFor(t.store, t.svc, { imagingAcceptIdentified: true })
    const fd = new FormData()
    fd.append('file', new File([dicomBytes()], 'scan.dcm'))
    const res = await app.request(`/api/patients/${t.patient.id}/imaging/analyze`, { method: 'POST', headers: { Authorization: t.tok(t.user) }, body: fd })
    expect(res.status).toBe(202)
  })

  it('NIfTI 判断按内容：NIfTI-1（压缩与不压缩）是；DICOM、zip、截断的 gzip、太短的文件不是', () => {
    expect(isNifti(niftiBytes(true))).toBe(true)
    expect(isNifti(niftiBytes(false))).toBe(true)
    expect(isNifti(dicomBytes())).toBe(false)
    expect(isNifti(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false)
    expect(isNifti(new Uint8Array([0x1f, 0x8b, 0, 0]))).toBe(false)
    expect(isNifti(new Uint8Array(100))).toBe(false)
  })

})
