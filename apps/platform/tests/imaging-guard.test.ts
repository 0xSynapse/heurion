import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { guardImagingPayload } from '../src/tenancy/imaging-guard.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientError, PatientService } from '../src/tenancy/patients.ts'
import { TurnService } from '../src/turns/service.ts'

/** 影像 worker 不认识用户、会把任意字符串当缓存键或文件路径：平台转发前必须整体收口。 */
describe('影像请求收口（imaging-guard）', () => {
  const reads: string[] = []
  const readPatient = (id: string) => { reads.push(id) }

  it('任何层级的路径字段都拒绝，只放行平台自己登记的路径', () => {
    for (const body of [
      { file_path: '/etc/passwd' },
      { mask_file_path: 'x' },
      { baseline_path: 'a' },
      { items: [{ file_path: '/tmp/a.nii.gz' }] },
      { file_paths: ['a', 'b'] },
    ]) {
      expect(() => guardImagingPayload(body, readPatient)).toThrow(PatientError)
    }
    expect(() => guardImagingPayload({ file_path: '/data/known.nii.gz' }, readPatient, new Set(['/data/known.nii.gz']))).not.toThrow()
  })

  it('任何字段里的患者体积键都核对读权限（不止 sample_id）', () => {
    reads.length = 0
    guardImagingPayload({ sample_id: 'chest_lung_ct', mask_sample_id: 'pt_ptaaa_pf1', regions: [{ ref: 'pt_ptbbb_pf2' }] }, readPatient)
    expect(reads).toEqual(['ptaaa', 'ptbbb'])
  })

  it('样本 ID 只允许安全字符，挡住拼路径时的 ../', () => {
    expect(() => guardImagingPayload({ sample_id: '../../etc/x' }, readPatient)).toThrow(PatientError)
    expect(() => guardImagingPayload({ sample_id: 'a..b' }, readPatient)).toThrow(PatientError)
    expect(() => guardImagingPayload({ sample_id: 'lidc_lung_nodule_mask', model_id: 'lung_nodule_segmenter', job_id: 'imgjob_1' }, readPatient)).not.toThrow()
  })

  it('HTTP：别的机构的医生拿不到患者影像，也不能直接指定服务器文件路径（均在访问 worker 前拒绝）', async () => {
    const SECRET = 'test-secret'
    const store = new Store(':memory:')
    const tenants = new TenantService(store, { devMode: false })
    const root = mkdtempSync(join(tmpdir(), 'img-guard-'))
    const patients = new PatientService(root, tenants, new TenantKeys(store, kekFrom({ secret: SECRET })), store)
    const hospA = store.createTenant({ name: 'A 院', kind: 'org' })
    const hospB = store.createTenant({ name: 'B 院', kind: 'org' })
    const drA = store.createUser({ username: 'dr_a', display_name: 'A', password_hash: 'x', tenant: { id: hospA.id, role: 'member' } }).id
    const drB = store.createUser({ username: 'dr_b', display_name: 'B', password_hash: 'x', tenant: { id: hospB.id, role: 'member' } }).id
    const patient = patients.create({ userId: drA, via: 'user' }, { sex: 'F', birth_year: 1970 })

    const docs = new Documents(store)
    const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
    const app = buildApi({
      docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
      crossref: {} as CrossrefClient, renderer: new SlideRenderer(root), devMode: false, devUser: 'dev', patients,
      accounts: new Accounts(store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' }),
    })
    const tokenB = issueToken(SECRET, { u: drB, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: store.getUser(drB)!.token_version })
    const post = (body: unknown) => app.request('/api/imaging/mpr/slice', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` }, body: JSON.stringify(body),
    })

    // 以前只校验 sample_id 等 6 个字段：把体积键放进 file_path 或掩膜字段即可绕过
    const volumeKey = `pt_${patient.id}_pfdeadbeef`
    expect((await post({ sample_id: 'chest_lung_ct', file_path: volumeKey })).status).toBe(400)
    expect((await post({ sample_id: 'chest_lung_ct', mask_sample_id: volumeKey })).status).toBe(404)
    expect((await post({ sample_id: volumeKey })).status).toBe(404)
    const info = await app.request(`/api/imaging/mpr/info?file_path=${encodeURIComponent('/app/data/x.nii.gz')}&sample_id=chest_lung_ct`, { headers: { Authorization: `Bearer ${tokenB}` } })
    expect(info.status).toBe(400)

    // 对照：本院医生同样的请求通过收口、交给 worker（测试环境 worker 不在线时为 503，而不是 404）
    const tokenA = issueToken(SECRET, { u: drA, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: store.getUser(drA)!.token_version })
    const own = await app.request('/api/imaging/mpr/slice', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ sample_id: 'chest_lung_ct', mask_sample_id: volumeKey }),
    })
    expect(own.status).not.toBe(404)
    expect(own.status).not.toBe(400)
  })
})
