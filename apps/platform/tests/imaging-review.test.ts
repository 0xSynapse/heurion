import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { buildApi } from '../src/http/api.ts'
import { ImagingReviewService, type ReviewView } from '../src/imaging/review.ts'
import { ImagingStudyService } from '../src/imaging/studies.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import { dicom, FakeOrthanc } from './imaging-fakes.ts'

/**
 * 审核视图与定稿（T2.7，W5.1 / W5.2）：初写 / 审核角色、AI 原值—初写修改—审核修改（数据来自病灶留痕）、
 * 定稿只允许审核医师且 AI 不能、定稿后再改生成新版本（旧快照不变）、乐观锁与各种边界。
 */

const STUDY = '1.2.840.113619.2.55.3.7001'
const SERIES = `${STUDY}.2`
const NODULE = { mean_diameter_mm: 7.9, long_axis_mm: 9.1, short_axis_mm: 6.7, volume_mm3: 260, mean_hu: -20, nodule_type: 'solid', center_lps_mm: [-44, 38.5, 108] }

function env() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-img-rv-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const user = (username: string, display_name: string, role: 'admin' | 'member' = 'member') => store.createUser({ username, display_name, password_hash: 'x', tenant: { id: hosp.id, role } }).id
  const admin = user('admin_li', '李主任', 'admin')
  const reader = user('dr_zhang', '张医生（初写）')
  const reviewer = user('dr_wang', '王主任（审核）')
  const reviewer2 = user('dr_chen', '陈主任（审核）')
  const outsider = user('dr_zhao', '赵医生')
  const orthanc = new FakeOrthanc()
  const svc = new ImagingStudyService(patients, orthanc)
  const rv = new ImagingReviewService(patients, u => store.getUser(u)?.display_name ?? null)
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  const isMember = (u: string, tid: string) => store.getUser(u)?.tenant_id === tid
  rv.setReadingRole(as(admin), reviewer, 'reviewer', isMember)
  rv.setReadingRole(as(admin), reviewer2, 'reviewer', isMember)
  return { store, tenants, patients, orthanc, svc, rv, hosp, admin, reader, reviewer, reviewer2, outsider, as, isMember }
}

/** 一位患者、一个检查：AI 检出 2 个待确认，另有一个影子运行的检出（不应出现在审核视图与快照里） */
async function seeded() {
  const t = env()
  const R = t.as(t.reader)
  const p = t.patients.create(R, { sex: 'M', birth_year: 1958 })
  t.patients.addMember(R, p.id, t.reviewer)
  t.patients.addMember(R, p.id, t.reviewer2)
  const study = (await t.svc.importDicom(R, p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])).studies[0]!
  const run = t.svc.startRun(R, study.id, { task: 'lung_nodule', model_id: 'lung_nodule' })
  const n1 = t.svc.addLesion(R, study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', label: '结节 1', location: 'RUL', metrics: NODULE })
  const n2 = t.svc.addLesion(R, study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', label: '结节 2', location: 'LLL', metrics: { mean_diameter_mm: 4.1, nodule_type: 'pure_ggo' } })
  const shadowRun = t.svc.startRun(R, study.id, { task: 'lung_nodule', model_id: 'lung_nodule', visibility: 'shadow' })
  const shadow = t.svc.addLesion(R, study.id, { run_id: shadowRun.id, kind: 'lung_nodule', source: 'ai', label: '影子', metrics: {} })
  return { ...t, p, study, n1, n2, shadow, R, V: t.as(t.reviewer), V2: t.as(t.reviewer2) }
}

type T = Awaited<ReturnType<typeof seeded>>
/** 初写：确认 1 号、否决 2 号、改 1 号的测量，然后提交 */
function readerPass(t: T) {
  t.svc.reviewLesion(t.R, t.n1.id, { status: 'confirmed' })
  t.svc.reviewLesion(t.R, t.n2.id, { status: 'rejected', reason: '血管断面' })
  t.svc.editLesion(t.R, t.n1.id, { metrics: { ...NODULE, mean_diameter_mm: 8.4 } })
  t.rv.submitRead(t.R, t.study.id)
}
const blockers = (v: ReviewView) => v.finalize.blockers.map(b => b.code)

describe('阅片角色', () => {
  it('机构管理员设置初写 / 审核；其他人、AI、个人空间、外院成员都不行', () => {
    const t = env()
    expect(t.rv.readingRoles(t.as(t.admin)).map(r => [r.user_id, r.role])).toEqual([[t.reviewer, 'reviewer'], [t.reviewer2, 'reviewer']])
    expect(t.rv.setReadingRole(t.as(t.admin), t.reviewer2, 'reader', t.isMember)).toEqual({ user_id: t.reviewer2, role: 'reader' })
    expect(() => t.rv.setReadingRole(t.as(t.admin), t.reader, 'chief', t.isMember)).toThrow(expect.objectContaining({ code: 'bad_role' }))
    expect(() => t.rv.setReadingRole(t.as(t.reader), t.reader, 'reviewer', t.isMember)).toThrow(expect.objectContaining({ status: 403 }))
    expect(() => t.rv.setReadingRole(t.as(t.admin, 'ai'), t.reader, 'reviewer', t.isMember)).toThrow(expect.objectContaining({ status: 403 }))
    expect(() => t.rv.readingRoles(t.as(t.reader))).toThrow(expect.objectContaining({ status: 403 }))
    const other = t.store.createTenant({ name: '别的医院', kind: 'org' })
    const stranger = t.store.createUser({ username: 'x_dr', display_name: '外院', password_hash: 'x', tenant: { id: other.id, role: 'member' } }).id
    expect(() => t.rv.setReadingRole(t.as(t.admin), stranger, 'reviewer', t.isMember)).toThrow(expect.objectContaining({ status: 404 }))
    const solo = t.store.createUser({ username: 'solo', display_name: '个体', password_hash: 'x' }).id
    expect(() => t.rv.setReadingRole(t.as(solo), solo, 'reviewer', t.isMember)).toThrow(expect.objectContaining({ code: 'personal' }))
  })
})

describe('审核视图（W5.1）', () => {
  it('按病灶列出 AI 原值、初写修改、审核修改与当前值；与病灶留痕一致；影子检出不出现', async () => {
    const t = await seeded()
    readerPass(t)
    // 审核医师把 1 号的平均径再改回一点
    t.svc.editLesion(t.V, t.n1.id, { metrics: { ...NODULE, mean_diameter_mm: 8.1 } })
    const v = t.rv.view(t.V, t.study.id)
    expect(v.state).toBe('submitted')
    expect(v.my_role).toBe('reviewer')
    expect(v.lesions.map(l => l.id)).toEqual([t.n1.id, t.n2.id])
    expect(v.lesions.some(l => l.id === t.shadow.id)).toBe(false)
    const [l1, l2] = v.lesions as [ReviewView['lesions'][0], ReviewView['lesions'][0]]
    expect(l1.ai_original).toEqual({ label: '结节 1', location: 'RUL', metrics: { mean_diameter_mm: 7.9, long_axis_mm: 9.1, short_axis_mm: 6.7, volume_mm3: 260, mean_hu: -20, nodule_type: 'solid' } })
    expect(l1.reader_changes.map(c => [c.action, c.user_name, c.changes])).toEqual([
      ['confirm', '张医生（初写）', { status: { before: 'proposed', after: 'confirmed' } }],
      ['edit', '张医生（初写）', { mean_diameter_mm: { before: 7.9, after: 8.4 } }],
    ])
    expect(l1.reviewer_changes.map(c => [c.action, c.user_name, c.changes])).toEqual([['edit', '王主任（审核）', { mean_diameter_mm: { before: 8.4, after: 8.1 } }]])
    expect(l1.metrics.mean_diameter_mm).toBe(8.1)
    expect(l1.version).toBe(3)
    expect(l2.reader_changes[0]!.changes).toEqual({ status: { before: 'proposed', after: 'rejected' }, reject_reason: { before: null, after: '血管断面' } })
    expect(l2.reviewer_changes).toEqual([])
    // 与留痕一致：每条修改都对应 imaging_lesion_events 里的一条（同一 id、同一时间与操作者）
    const events = t.svc.lesionEvents(t.V, t.n1.id)
    const ids = (t.patients.imagingLookup(t.V).db.prepare('SELECT id FROM imaging_lesion_events WHERE lesion_id = ? ORDER BY id').all(t.n1.id) as Array<{ id: number }>).map(r => r.id)
    expect([...l1.reader_changes, ...l1.reviewer_changes].map(c => c.event_id)).toEqual(ids.slice(1))
    expect([...l1.reader_changes, ...l1.reviewer_changes].map(c => [c.at, c.user_id, c.action])).toEqual(events.slice(1).map(e => [e.at, e.user_id, e.action]))
    expect(v.readers.map(r => r.user_id)).toEqual([t.reader])
    expect(v.counts).toEqual({ proposed: 0, confirmed: 1, rejected: 1 })
    // AI 也能读审核视图，但永远不能定稿
    const ai = t.rv.view(t.as(t.reviewer, 'ai'), t.study.id)
    expect(ai.lesions).toHaveLength(2)
    expect(ai.finalize).toEqual({ allowed: false, blockers: [expect.objectContaining({ code: 'forbidden' })] })
  })

  it('医生补充的结节：没有 AI 原值，记谁在哪个阶段补充的；撤销的不列', async () => {
    const t = await seeded()
    const added = t.svc.addLesion(t.R, t.study.id, { kind: 'lung_nodule', source: 'manual', label: '医生补充 1', metrics: { mean_diameter_mm: 5 } })
    const gone = t.svc.addLesion(t.R, t.study.id, { kind: 'lung_nodule', source: 'manual', label: '医生补充 2' })
    t.svc.withdrawLesion(t.R, gone.id)
    const l = t.rv.view(t.R, t.study.id).lesions.find(x => x.id === added.id)!
    expect(l).toMatchObject({ source: 'manual', ai_original: null, added_by: { user_id: t.reader, phase: 'reader' }, status: 'confirmed' })
    expect(t.rv.view(t.R, t.study.id).lesions.some(x => x.id === gone.id)).toBe(false)
  })
})

describe('定稿（W5.2）', () => {
  it('初写提交后由审核医师定稿；快照记谁、何时、哪些病灶的哪个版本；进入随访库', async () => {
    const t = await seeded()
    expect(() => t.rv.submitRead(t.R, t.study.id)).toThrow(expect.objectContaining({ code: 'pending_lesions', status: 409 }))
    expect(blockers(t.rv.view(t.V, t.study.id))).toEqual(['not_submitted', 'self_review', 'pending_lesions'])
    readerPass(t)
    const v = t.rv.view(t.V, t.study.id)
    expect(v.finalize).toEqual({ allowed: true, blockers: [] })
    expect(t.rv.finalizedLesions(t.V, t.study.id)).toBeNull()

    const so = t.rv.finalize(t.V, t.study.id, { expected_revision: v.revision, note: '同意初写意见' })
    expect(so).toMatchObject({ version: 1, signed_by: t.reviewer, signed_by_name: '王主任（审核）', mode: 'dual', readers: [t.reader], note: '同意初写意见', lesions: { total: 2, confirmed: 1, rejected: 1 } })
    expect(so.lesions_snapshot.map(l => [l.id, l.version, l.status])).toEqual([[t.n1.id, 2, 'confirmed'], [t.n2.id, 1, 'rejected']])
    expect(so.snapshot_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(t.rv.view(t.R, t.study.id)).toMatchObject({ state: 'finalized', latest_signoff: { version: 1 } })
    expect(t.rv.summaries(t.R, t.p.id)).toEqual([expect.objectContaining({ study_id: t.study.id, state: 'finalized', latest_signoff: expect.objectContaining({ version: 1, mode: 'dual' }) })])
    const fu = t.rv.finalizedLesions(t.R, t.study.id)!
    expect(fu).toMatchObject({ version: 1, stale: false })
    expect(fu.lesions.map(l => [l.id, l.metrics.mean_diameter_mm])).toEqual([[t.n1.id, 8.4]])
    expect(t.rv.finalizedStudies(t.R, t.p.id).map(s => s.study_id)).toEqual([t.study.id])

    // 留痕：每个病灶一条 finalize、访问日志、定稿不改变病灶版本
    expect(t.svc.lesionEvents(t.R, t.n1.id).at(-1)).toMatchObject({ action: 'finalize', user_id: t.reviewer, after: { signoff_version: 1, lesion_version: 2 } })
    expect(t.svc.listLesions(t.R, t.study.id).find(l => l.id === t.n1.id)!.version).toBe(2)
    expect(t.patients.accessLog(t.R, t.p.id).map(x => x.action)).toContain('imaging_finalize')
    // 已定稿且没有改动：不能再定、不能再提交
    expect(() => t.rv.finalize(t.V2, t.study.id, { expected_revision: v.revision })).toThrow(expect.objectContaining({ code: 'already_finalized', status: 409 }))
    expect(() => t.rv.submitRead(t.R, t.study.id)).toThrow(expect.objectContaining({ code: 'already_finalized' }))
  })

  it('定稿后再改（含阅片器修边界、AI 重新分析的新检出）回到「定稿后修改中」，再定稿生成 v2，旧快照不变且不可改', async () => {
    const t = await seeded()
    readerPass(t)
    const v1 = t.rv.finalize(t.V, t.study.id, { expected_revision: t.rv.view(t.V, t.study.id).revision })
    // 审核医师定稿后修改：改测量，并且又来了一个 AI 新检出
    t.svc.editLesion(t.V, t.n1.id, { metrics: { ...NODULE, mean_diameter_mm: 9.0 } })
    const n3 = t.svc.addLesion(t.R, t.study.id, { kind: 'lung_nodule', source: 'ai', label: '结节 3', metrics: { mean_diameter_mm: 3 } })
    let v = t.rv.view(t.V, t.study.id)
    expect(v.state).toBe('amending')
    expect(t.rv.finalizedLesions(t.R, t.study.id)).toMatchObject({ version: 1, stale: true, lesions: [expect.objectContaining({ version: 2, metrics: expect.objectContaining({ mean_diameter_mm: 8.4 }) })] })
    const l1 = v.lesions.find(l => l.id === t.n1.id)!
    expect(l1.finalized).toEqual({ signoff_version: 1, lesion_version: 2, status: 'confirmed', current: false })
    expect(l1.reviewer_changes.at(-1)).toMatchObject({ after_signoff: 1, changes: { mean_diameter_mm: { before: 8.4, after: 9.0 } } })
    expect(blockers(v)).toEqual(['pending_lesions'])
    t.svc.reviewLesion(t.V, n3.id, { status: 'rejected', reason: '伪影' })
    v = t.rv.view(t.V, t.study.id)
    const v2 = t.rv.finalize(t.V, t.study.id, { expected_revision: v.revision })
    expect(v2).toMatchObject({ version: 2, mode: 'dual', lesions: { total: 3, confirmed: 1, rejected: 2 } })
    // v1 快照原样保留
    expect(t.rv.signoff(t.R, t.study.id, 1)).toEqual(v1)
    expect(t.rv.view(t.R, t.study.id).signoffs.map(s => s.version)).toEqual([2, 1])
    expect(t.rv.finalizedLesions(t.R, t.study.id)!.lesions[0]!.metrics.mean_diameter_mm).toBe(9.0)
    // 定稿快照在库里只能追加
    const db = t.patients.imagingLookup(t.R).db
    expect(() => db.prepare("UPDATE imaging_signoffs SET snapshot = '[]' WHERE version = 1").run()).toThrow(/只能追加/)
    // 撤销补充的结节也算改动；快照里有、当前没有的列在 removed_since_finalized
    const m = t.svc.addLesion(t.V, t.study.id, { kind: 'lung_nodule', source: 'manual', label: '医生补充 1' })
    t.rv.finalize(t.V, t.study.id, { expected_revision: t.rv.view(t.V, t.study.id).revision })
    t.svc.withdrawLesion(t.V, m.id)
    expect(t.rv.view(t.V, t.study.id)).toMatchObject({ state: 'amending', removed_since_finalized: [expect.objectContaining({ id: m.id })] })
  })

  it('只有审核医师能定稿；AI 不能；不在诊疗组不能；默认不允许自审，机构可放开', async () => {
    const t = await seeded()
    readerPass(t)
    const rev = t.rv.view(t.V, t.study.id).revision
    expect(() => t.rv.finalize(t.R, t.study.id, { expected_revision: rev })).toThrow(expect.objectContaining({ code: 'not_reviewer', status: 403 }))
    expect(() => t.rv.finalize(t.as(t.reviewer, 'ai'), t.study.id, { expected_revision: rev })).toThrow(expect.objectContaining({ status: 403 }))
    expect(() => t.rv.submitRead(t.as(t.reader, 'ai'), t.study.id)).toThrow(expect.objectContaining({ status: 403 }))
    t.rv.setReadingRole(t.as(t.admin), t.outsider, 'reviewer', t.isMember)
    expect(() => t.rv.finalize(t.as(t.outsider), t.study.id, { expected_revision: rev })).toThrow(expect.objectContaining({ status: 404 }))

    // 自审：审核医师本人做了初写（提交前的改动都算初写）
    const t2 = await seeded()
    t2.svc.reviewLesion(t2.V, t2.n1.id, { status: 'confirmed' })
    t2.svc.reviewLesion(t2.V, t2.n2.id, { status: 'confirmed' })
    t2.rv.submitRead(t2.V, t2.study.id)
    const r2 = t2.rv.view(t2.V, t2.study.id)
    expect(blockers(r2)).toEqual(['self_review'])
    expect(() => t2.rv.finalize(t2.V, t2.study.id, { expected_revision: r2.revision })).toThrow(expect.objectContaining({ code: 'self_review', status: 403 }))
    // 另一位审核医师可以签
    expect(t2.rv.view(t2.V2, t2.study.id).finalize.allowed).toBe(true)
    // 机构放开自审后可以，定稿记 mode = self
    t2.tenants.update(t2.admin, { settings: { imaging_self_review: true } })
    expect(t2.rv.finalize(t2.V, t2.study.id, { expected_revision: r2.revision }).mode).toBe('self')
  })

  it('乐观锁：打开视图后病灶又被改，或两位审核医师同时定稿，后到的被拒', async () => {
    const t = await seeded()
    readerPass(t)
    const seen = t.rv.view(t.V, t.study.id).revision
    t.svc.editLesion(t.R, t.n1.id, { location: 'RML' })
    expect(() => t.rv.finalize(t.V, t.study.id, { expected_revision: seen })).toThrow(expect.objectContaining({ code: 'stale_revision', status: 409 }))
    expect(() => t.rv.finalize(t.V, t.study.id, {})).toThrow(expect.objectContaining({ code: 'revision_required' }))
    // 两位审核医师看到同一个 revision，同时点定稿：只有一个成功
    const rev = t.rv.view(t.V, t.study.id).revision
    const results = [t.V, t.V2].map(a => { try { return t.rv.finalize(a, t.study.id, { expected_revision: rev }).version } catch (e) { return (e as { code: string }).code } })
    expect(results).toEqual([1, 'already_finalized'])
    expect(t.rv.view(t.R, t.study.id).signoffs).toHaveLength(1)
  })

  it('没有结节也能定稿（「未见结节」）；肺叶定位中、分析进行中不能定稿；影子检出不进快照', async () => {
    const t = env()
    const R = t.as(t.reader), V = t.as(t.reviewer)
    const p = t.patients.create(R, { sex: 'F', birth_year: 1970 })
    t.patients.addMember(R, p.id, t.reviewer)
    const st = (await t.svc.importDicom(R, p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])).studies[0]!
    const shadowRun = t.svc.startRun(R, st.id, { task: 'lung_nodule', model_id: 'lung_nodule', visibility: 'shadow' })
    t.svc.addLesion(R, st.id, { run_id: shadowRun.id, kind: 'lung_nodule', source: 'ai', metrics: {} })
    expect(t.rv.view(V, st.id)).toMatchObject({ state: 'reading', revision: 0, lesions: [] })
    t.rv.submitRead(R, st.id, { note: '未见结节' })
    const run = t.svc.startRun(R, st.id, { task: 'lung_nodule', model_id: 'lung_nodule' })
    expect(blockers(t.rv.view(V, st.id, { isRunActive: id => id === run.id }))).toEqual(['analysis_running'])
    expect(t.rv.view(V, st.id, { isRunActive: () => false }).finalize.allowed).toBe(true)
    const so = t.rv.finalize(V, st.id, { expected_revision: 0 })
    expect(so).toMatchObject({ version: 1, lesions: { total: 0, confirmed: 0, rejected: 0 }, lesions_snapshot: [] })
    expect(t.rv.finalizedLesions(R, st.id)).toMatchObject({ version: 1, lesions: [] })

    // 点选补充的结节肺叶还在后台定位：先不让定稿
    const l = t.svc.addLesion(V, st.id, { kind: 'lung_nodule', source: 'manual', metrics: { lobe_status: 'pending' } })
    expect(blockers(t.rv.view(V, st.id))).toContain('locating')
    t.svc.setLesionLocation(V, l.id, 1, { location: 'RUL', status: 'done' })
    expect(blockers(t.rv.view(V, st.id))).not.toContain('locating')
  })

  it('个人空间：没有角色，本人即可定稿（单人模式）', async () => {
    const t = env()
    const solo = t.store.createUser({ username: 'solo', display_name: '个体医生', password_hash: 'x' }).id
    const a = t.as(solo)
    const p = t.patients.create(a, { sex: 'M', birth_year: 1960 })
    const st = (await t.svc.importDicom(a, p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])).studies[0]!
    const n = t.svc.addLesion(a, st.id, { kind: 'lung_nodule', source: 'ai', metrics: NODULE })
    t.svc.reviewLesion(a, n.id, { status: 'confirmed' })
    const v = t.rv.view(a, st.id)
    expect(v).toMatchObject({ reading_mode: 'personal', my_role: null, self_review_allowed: true, finalize: { allowed: true } })
    expect(t.rv.finalize(a, st.id, { expected_revision: v.revision }).mode).toBe('single')
    expect(() => t.rv.finalize(t.as(solo, 'ai'), st.id, { expected_revision: v.revision })).toThrow(expect.objectContaining({ status: 403 }))
  })
})

describe('审核与定稿的接口', () => {
  async function api() {
    const t = await seeded()
    const docs = new Documents(t.store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img-rv-r-'))), accounts: new Accounts(t.store, { secret: 'test-secret', devMode: false, devToken: 'dev', devUser: 'dev' }),
      devMode: false, devUser: 'dev', patients: t.patients, orthanc: t.orthanc, imagingPipeline: null, imagingInteractive: null,
    })
    const H = (u: string) => ({ Authorization: `Bearer ${issueToken('test-secret', { u, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: t.store.getUser(u)!.token_version })}`, 'Content-Type': 'application/json' })
    return { ...t, app, H }
  }

  it('审核视图、提交、定稿、快照、阅片角色；路径里的患者与检查要对得上；定稿记平台审计', async () => {
    const t = await api()
    const base = `/api/patients/${t.p.id}/imaging/studies/${t.study.id}`
    t.svc.reviewLesion(t.R, t.n1.id, { status: 'confirmed' })
    t.svc.reviewLesion(t.R, t.n2.id, { status: 'confirmed' })
    expect((await t.app.request(`${base}/review/submit`, { method: 'POST', headers: t.H(t.reader), body: '{}' })).status).toBe(200)
    const view = await (await t.app.request(`${base}/review`, { headers: t.H(t.reviewer) })).json() as ReviewView
    expect(view).toMatchObject({ state: 'submitted', finalize: { allowed: true } })
    const other = t.patients.create(t.R, { sex: 'F', birth_year: 1980 })
    expect((await t.app.request(`/api/patients/${other.id}/imaging/studies/${t.study.id}/review`, { headers: t.H(t.reader) })).status).toBe(404)
    expect((await t.app.request(`${base}/finalize`, { method: 'POST', headers: t.H(t.reader), body: JSON.stringify({ expected_revision: view.revision }) })).status).toBe(403)
    const fin = await t.app.request(`${base}/finalize`, { method: 'POST', headers: t.H(t.reviewer), body: JSON.stringify({ expected_revision: view.revision }) })
    expect(fin.status).toBe(201)
    expect(await fin.json()).toMatchObject({ version: 1, mode: 'dual' })
    expect((await t.app.request(`${base}/finalize`, { method: 'POST', headers: t.H(t.reviewer2), body: JSON.stringify({ expected_revision: view.revision }) })).status).toBe(409)
    expect(await (await t.app.request(`/api/patients/${t.p.id}/imaging/reviews`, { headers: t.H(t.reader) })).json()).toEqual([expect.objectContaining({ state: 'finalized' })])
    expect(await (await t.app.request(`${base}/signoffs/1`, { headers: t.H(t.reader) })).json()).toMatchObject({ version: 1, lesions_snapshot: [expect.anything(), expect.anything()] })
    expect((await t.app.request(`${base}/signoffs/2`, { headers: t.H(t.reader) })).status).toBe(404)
    expect(t.store.listAudit({ action: 'imaging.finalize' })).toEqual([expect.objectContaining({ actor: t.reviewer, target: t.study.id })])

    // 阅片角色：管理员设置；普通成员不行
    expect((await t.app.request(`/api/imaging/reading-roles/${t.reader}`, { method: 'PUT', headers: t.H(t.reader), body: JSON.stringify({ role: 'reviewer' }) })).status).toBe(403)
    const put = await t.app.request(`/api/imaging/reading-roles/${t.reader}`, { method: 'PUT', headers: t.H(t.admin), body: JSON.stringify({ role: 'reviewer' }) })
    expect(await put.json()).toEqual({ user_id: t.reader, role: 'reviewer' })
    expect((await (await t.app.request('/api/imaging/reading-roles', { headers: t.H(t.admin) })).json() as unknown[])).toHaveLength(3)
  })

  it('阅片器：面板读到审核状态；从审核视图跳转时带上结节定位', async () => {
    const t = await api()
    process.env.VIEWER_HOST = 'viewer.test'
    process.env.VIEWER_URL = 'http://ohif:8080'
    try {
      const r = await t.app.request('/api/imaging/viewer-ticket', { method: 'POST', headers: t.H(t.reader), body: JSON.stringify({ study_uid: STUDY, lesion_id: t.n1.id }) })
      const url = (await r.json() as { url: string }).url
      expect(url).toContain(`&lesion=${t.n1.id}`)
      const session = await t.app.request(url)
      expect(session.headers.get('location')).toBe(`/viewer?StudyInstanceUIDs=${STUDY}&HeurionLesion=${t.n1.id}`)
      const cookie = session.headers.get('set-cookie')!.split(';')[0]!
      const body = await (await t.app.request(`http://viewer.test/api/viewer/lesions?StudyInstanceUID=${STUDY}`, { headers: { Cookie: cookie } })).json() as { review: { state: string } }
      expect(body.review).toMatchObject({ state: 'reading', latest_signoff: null })
      // 不合格式的定位参数被丢掉
      const bad = await t.app.request('/api/imaging/viewer-ticket', { method: 'POST', headers: t.H(t.reader), body: JSON.stringify({ study_uid: STUDY, lesion_id: 'x"><script>' }) })
      expect((await bad.json() as { url: string }).url).not.toContain('lesion=')
    } finally {
      delete process.env.VIEWER_HOST
      delete process.env.VIEWER_URL
    }
  })
})

describe('AI 读审核视图（imaging_review）', () => {
  it('列出审核状态、读审核视图与定稿快照；没有定稿的工具', async () => {
    const t = await seeded()
    readerPass(t)
    t.rv.finalize(t.V, t.study.id, { expected_revision: t.rv.view(t.V, t.study.id).revision })
    const docs = new Documents(t.store)
    const claims = verifyToken('s', issueToken('s', { u: t.reviewer, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const server = buildMcpServer({
      docs, ops: new OpService(docs), turns: new TurnRegistry(), secret: 's', claims: new ClaimService(docs, {} as any), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'rv-mcp-'))),
      pubmed: {} as any, crossref: {} as any, workspaceDir: () => tmpdir(), isLiveSession: () => true, patients: t.patients,
    }, claims)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'rv', version: '0' })
    await client.connect(b)
    const call = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: 'imaging_review', arguments: args })).content as Array<{ text: string }>)[0]!.text)
    expect(await call({ patient_id: t.p.id })).toEqual([expect.objectContaining({ study_id: t.study.id, state: 'finalized' })])
    const v = await call({ patient_id: t.p.id, imaging_study_id: t.study.id }) as ReviewView
    expect(v.lesions[0]!.ai_original!.metrics.mean_diameter_mm).toBe(7.9)
    expect(v.finalize.allowed).toBe(false)
    expect(await call({ patient_id: t.p.id, imaging_study_id: t.study.id, signoff_version: 1 })).toMatchObject({ version: 1, signed_by: t.reviewer })
    expect(await call({ patient_id: t.p.id, imaging_study_id: 'is000000000000' })).toMatchObject({ error: 'not_found' })
    const tools = (await client.listTools()).tools.map(x => x.name)
    expect(tools.filter(n => /finali[sz]e|signoff|submit_read/.test(n))).toEqual([])
  })
})
