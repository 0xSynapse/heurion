import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { buildApi } from '../src/http/api.ts'
import { FindingsDraftService } from '../src/imaging/findings-draft.ts'
import { activeMs, draftEpisode, ImagingMetricsService, studyEpisodes, type StudyTimeline } from '../src/imaging/metrics.ts'
import { ImagingReviewService } from '../src/imaging/review.ts'
import { ImagingStudyService } from '../src/imaging/studies.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import { dicom, FakeOrthanc } from './imaging-fakes.ts'

/**
 * 效率埋点（T2.10）：新增事件（打开阅片器、打开审核视图、复制 RIS）与已有留痕一起推出初写 / 审核 / 写所见的耗时；
 * 空闲截断、按轮计、自审、影子期、权限、删除患者、时钟乱序等边界。
 */

const MIN = 60_000
const T0 = Date.parse('2026-10-26T01:00:00.000Z')   // 北京时间 2026-10-26（周一）09:00
const NODULE = { mean_diameter_mm: 8.2, long_axis_mm: 9.1, short_axis_mm: 7.3, volume_mm3: 288.4, mean_hu: -12, nodule_type: 'solid', segmentation: 'vista3d', center_lps_mm: [-43, 37, 108] }
let seq = 0

/** 把「现在」拨到 T0 + m 分钟（库里所有时间戳都来自 new Date()） */
const at = (m: number) => vi.setSystemTime(T0 + m * MIN)

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); at(0) })
afterEach(() => { vi.useRealTimers() })

function env() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-img-mx-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const user = (username: string, display_name: string, role: 'admin' | 'member' = 'member') => store.createUser({ username, display_name, password_hash: 'x', tenant: { id: hosp.id, role } }).id
  const admin = user('admin_li', '李主任', 'admin')
  const reader = user('dr_zhang', '张医生')
  const reviewer = user('dr_wang', '王主任')
  const reader2 = user('dr_liu', '刘医生')
  const orthanc = new FakeOrthanc()
  const svc = new ImagingStudyService(patients, orthanc, { acceptIdentified: true })
  const rv = new ImagingReviewService(patients)
  const drafts = new FindingsDraftService(store, docs, ops, patients)
  const mx = new ImagingMetricsService(patients, store, docs)
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  rv.setReadingRole(as(admin), reviewer, 'reviewer', (u, tid) => store.getUser(u)?.tenant_id === tid)
  return { store, docs, ops, tenants, patients, hosp, admin, reader, reviewer, reader2, orthanc, svc, rv, drafts, mx, as, R: as(reader), V: as(reviewer), A: as(admin) }
}
type Env = ReturnType<typeof env>

/** 一位患者、一个检查；visible = 有一次完成的可见 AI 分析（2 个检出），shadow = 影子分析（结果不可见） */
async function study(t: Env, opts: { ai?: 'visible' | 'shadow' | 'none' } = {}) {
  const p = t.patients.create(t.R, { sex: 'M', birth_year: 1958 })
  t.patients.addMember(t.R, p.id, t.reviewer)
  t.patients.addMember(t.R, p.id, t.reader2)
  const uid = `1.2.840.113619.2.55.3.${7000 + ++seq}`
  const st = (await t.svc.importDicom(t.R, p.id, [{ name: 'IM1', bytes: dicom(uid, `${uid}.2`, `${uid}.2.1`) }])).studies[0]!
  const lesions: string[] = []
  if (opts.ai !== 'none') {
    const run = t.svc.startRun(t.R, st.id, { task: 'lung_nodule', model_id: 'lung_nodule_pipeline', visibility: opts.ai === 'shadow' ? 'shadow' : 'visible' })
    for (const [i, loc] of ['RUL', 'LLL'].entries()) {
      lesions.push(t.svc.addLesion(t.R, st.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', label: `结节 ${i + 1}`, location: loc, metrics: { ...NODULE, center_lps_mm: [i * 40, 0, 100] } }).id)
    }
    t.svc.setRunStatus(t.R, run.id, 'done', null, { summary: { found: 2 } })
  }
  return { p, st, uid, lesions }
}
const report = (t: Env, opts: { from?: string; to?: string; department?: string } = {}) => t.mx.report(t.A, { from: '2026-10-20', to: '2026-11-01', ...opts })
const mins = (v: number | null) => v === null ? null : Math.round(v / MIN * 100) / 100

describe('计时规则（纯函数）', () => {
  it('间隔 ≤ idle 全计；idle < 间隔 ≤ break 按 idle 计；> break 记 0；乱序输入先排序', () => {
    expect(activeMs([0, 3, 8].map(m => m * MIN), 10 * MIN, 60 * MIN)).toBe(8 * MIN)
    expect(activeMs([0, 30, 31].map(m => m * MIN), 10 * MIN, 60 * MIN)).toBe(11 * MIN)
    expect(activeMs([0, 200, 203].map(m => m * MIN), 10 * MIN, 60 * MIN)).toBe(3 * MIN)
    expect(activeMs([203, 0, 200].map(m => m * MIN), 10 * MIN, 60 * MIN)).toBe(3 * MIN)
    expect(activeMs([5 * MIN], 10 * MIN, 60 * MIN)).toBe(0)
    // 同一检查多次打开：同一时刻或相邻的重复事件不会重复计时
    expect(activeMs([0, 0, 1, 1, 3].map(m => m * MIN), 10 * MIN, 60 * MIN)).toBe(3 * MIN)
  })

  it('初写每次提交一段（窗口从上次定稿或本人上次提交之后算起）；审核在自审时从本人提交之后算起；没有操作的段不计时', () => {
    const tl: StudyTimeline = {
      study_id: 'st1', ai_ready_at: 0,
      activity: [
        { at: 1, user: 'u', kind: 'viewer_open' }, { at: 4, user: 'u', kind: 'lesion_confirm' },
        { at: 6, user: 'u', kind: 'review_open' }, { at: 7, user: 'u', kind: 'lesion_edit' },
        { at: 20, user: 'u', kind: 'lesion_edit' },
      ].map(e => ({ ...e, at: e.at * MIN })),
      submissions: [{ at: 5 * MIN, user: 'u' }],
      signoffs: [{ at: 9 * MIN, user: 'u', version: 1, mode: 'self' }, { at: 22 * MIN, user: 'u', version: 2, mode: 'self' }],
    }
    const eps = studyEpisodes(tl, 10 * MIN, 60 * MIN)
    const read = eps.find(e => e.kind === 'read')!
    expect([read.round, mins(read.active_ms), read.events, read.ai_assist]).toEqual([1, 4, 2, true])
    const [v1, v2] = eps.filter(e => e.kind === 'review')
    // 自审：第 1 版的审核从本人提交（5 分）之后算起：6 → 7 → 9 = 3 分钟，不含 1 → 5 的初写
    expect([v1!.round, v1!.mode, mins(v1!.active_ms)]).toEqual([1, 'self', 3])
    // 第 2 版（定稿后修改轮）：窗口从第 1 版定稿之后，20 → 22
    expect([v2!.round, mins(v2!.active_ms)]).toEqual([2, 2])
    // 直接提交、窗口里没有任何操作：不计时（不进分布）
    const bare = studyEpisodes({ study_id: 's', ai_ready_at: null, activity: [], submissions: [{ at: MIN, user: 'u' }], signoffs: [] }, 10 * MIN, 60 * MIN)
    expect(bare[0]).toMatchObject({ kind: 'read', active_ms: null, events: 0, ai_assist: false })
  })

  it('写所见：首次生成 → 最后一次复制；没复制过的不计时', () => {
    expect(mins(draftEpisode({ doc_id: 'd', study_id: 's', owner: 'u', generated: [0, 4 * MIN], edits: [2 * MIN, 6 * MIN], copies: [7 * MIN] }, 10 * MIN, 60 * MIN).active_ms)).toBe(7)
    expect(draftEpisode({ doc_id: 'd', study_id: 's', owner: 'u', generated: [0], edits: [2 * MIN], copies: [] }, 10 * MIN, 60 * MIN).active_ms).toBeNull()
  })
})

describe('报表（由留痕与新增事件推出）', () => {
  it('双人阅片一例：初写、审核、写所见、阅片 + 写所见合计；AI 确认率与否决原因；每周活跃', async () => {
    const t = env()
    const { st, uid, lesions: [n1, n2] } = await study(t)
    at(2); expect(t.mx.recordViewerOpen(t.R, uid)).toBe(true)
    at(5); t.svc.reviewLesion(t.R, n1!, { status: 'confirmed' })
    at(8); t.svc.reviewLesion(t.R, n2!, { status: 'rejected', reason: '血管断面' })
    at(9); t.rv.submitRead(t.R, st.id)
    at(10); const d = t.drafts.generate(t.R, st.patient_id, { study_id: st.id }, { turnId: null })
    at(13); expect(t.mx.recordRisCopy(t.R, d.doc_id)).toEqual({ recorded: true })
    at(20); expect(t.mx.recordReviewOpen(t.V, st.id)).toBe(true)
    at(24); t.rv.finalize(t.V, st.id, { expected_revision: t.rv.view(t.V, st.id).revision })

    const r = report(t)
    expect(r.reading.first_round.all).toEqual({ n: 1, median_ms: 7 * MIN, p90_ms: 7 * MIN })   // 2 → 5 → 8 → 9
    expect(r.reading.first_round.ai.n).toBe(1)
    expect(r.review.first_round.all.median_ms).toBe(4 * MIN)                                    // 20 → 24
    expect(r.review.by_mode).toEqual({ dual: 1 })
    expect(r.writing).toEqual({ drafts: 1, copied: 1, stats: { n: 1, median_ms: 3 * MIN, p90_ms: 3 * MIN } })
    expect(r.read_write.all.median_ms).toBe(11 * MIN)                                           // 2 → 13
    expect(r.lesions.ai).toMatchObject({ total: 2, confirmed: 1, rejected: 1, pending: 0, confirm_rate: 0.5, first_decision_confirm_rate: 0.5, decision_changed: 0 })
    expect(r.lesions.reject_reasons).toEqual([{ reason: '血管断面', n: 1 }])
    expect(r.drafts).toMatchObject({ drafts: 1, unchanged: r.drafts.blocks, edited_by_user: 0, deleted: 0, modified_ratio: 0 })
    expect(r.weekly.find(w => w.week_start === '2026-10-26')).toMatchObject({ active_users: 2, readers: 1, reviewers: 1, studies_opened: 1, submissions: 1, signoffs: 1 })
    expect(r.pipeline).toEqual({ opened_not_submitted: 0, submitted_not_finalized: 0 })
    expect(r.data_quality).toEqual({ clock_anomalies: 0, future_events: 0 })
    // 报表只有内部 id：不含患者代号、检查 UID、姓名
    const text = JSON.stringify(r)
    for (const s of [uid, 'P-0001', '张医生', st.patient_id]) expect(text).not.toContain(s)
    // CSV 明细一行一段
    const csv = ImagingMetricsService.csv(r).trim().split('\r\n')
    expect(csv[0]).toBe('kind,study_id,user_id,round,mode,ai_assist,start,end,active_min,events,doc_id')
    expect(csv.filter(l => l.startsWith('read,'))).toEqual([`read,${st.id},${t.reader},1,,1,2026-10-26T01:02:00.000Z,2026-10-26T01:09:00.000Z,7.00,3,`])
  })

  it('空闲截断：10 分钟内全计，10~60 分钟按 10 分钟计，超过 60 分钟不计（去掉截断时这条会失败）', async () => {
    const t = env()
    const { st, uid, lesions: [n1, n2] } = await study(t)
    at(0); t.mx.recordViewerOpen(t.R, uid)
    at(30); t.svc.reviewLesion(t.R, n1!, { status: 'confirmed' })      // 间隔 30 → 10
    at(200); t.svc.reviewLesion(t.R, n2!, { status: 'confirmed' })     // 间隔 170 → 0（另起一段）
    at(203); t.rv.submitRead(t.R, st.id)                                // 3
    expect(report(t).reading.first_round.all.median_ms).toBe(13 * MIN)
    vi.stubEnv('IMAGING_METRICS_IDLE_MIN', '30')
    vi.stubEnv('IMAGING_METRICS_BREAK_MIN', '180')
    try {
      const r = report(t)
      expect(r.config).toEqual({ idle_min: 30, break_min: 180 })
      expect(r.reading.first_round.all.median_ms).toBe(63 * MIN)       // 30 + 30 + 3
    } finally { vi.unstubAllEnvs() }
  })

  it('影子期：影子检出不进确认率；影子运行不算「有 AI」，此期阅片进「无 AI」对照；医生补充的结节单独计（去掉可见性过滤时失败）', async () => {
    const t = env()
    t.tenants.update(t.admin, { settings: { imaging_ai_visibility: 'shadow' } })
    const { st, uid } = await study(t, { ai: 'shadow' })
    at(2); t.mx.recordViewerOpen(t.R, uid)
    at(4); t.svc.addLesion(t.R, st.id, { kind: 'lung_nodule', source: 'manual', label: '医生补充 1', location: 'RML', metrics: NODULE })
    at(6); t.rv.submitRead(t.R, st.id)
    const r = report(t)
    expect(r.mode).toBe('shadow')
    expect(r.lesions.ai.total).toBe(0)
    expect(r.lesions.manual).toEqual({ added: 1, withdrawn: 0, studies: 1 })
    expect(r.reading.first_round.no_ai).toEqual({ n: 1, median_ms: 4 * MIN, p90_ms: 4 * MIN })
    expect(r.reading.first_round.ai.n).toBe(0)
  })

  it('自审（mode = self）：同一人的初写与审核分开计；定稿后再改再定稿按第 2 轮单列', async () => {
    const t = env()
    t.tenants.update(t.admin, { settings: { imaging_self_review: true } })
    const { st, uid, lesions: [n1, n2] } = await study(t)
    at(0); t.mx.recordViewerOpen(t.V, uid)
    at(3); t.svc.reviewLesion(t.V, n1!, { status: 'confirmed' })
    t.svc.reviewLesion(t.V, n2!, { status: 'rejected', reason: '钙化灶' })
    at(5); t.rv.submitRead(t.V, st.id)
    at(6); t.mx.recordReviewOpen(t.V, st.id)
    at(8); t.rv.finalize(t.V, st.id, { expected_revision: t.rv.view(t.V, st.id).revision })
    // 第 2 轮：审核医师改判 2 号再定稿
    at(30); t.svc.reviewLesion(t.V, n2!, { status: 'confirmed' })
    at(33); t.rv.finalize(t.V, st.id, { expected_revision: t.rv.view(t.V, st.id).revision })
    const r = report(t)
    expect(r.reading.first_round.all.median_ms).toBe(5 * MIN)
    expect(r.review.first_round.all.median_ms).toBe(2 * MIN)   // 5 之后：6 → 8，不含本人 0 → 5 的初写
    expect(r.review.by_mode).toEqual({ self: 2 })
    expect(r.review.amend).toEqual({ n: 1, median_ms: 3 * MIN, p90_ms: 3 * MIN })
    expect(r.lesions.ai).toMatchObject({ confirmed: 2, rejected: 0, confirm_rate: 1, first_decision_confirm_rate: 0.5, decision_changed: 1 })
  })

  it('多人参与、打开未提交、提交未定稿、只有 AI 运行、没有任何数据', async () => {
    const t = env()
    expect(report(t)).toMatchObject({ reading: { first_round: { all: { n: 0, median_ms: null } } }, lesions: { ai: { total: 0, confirm_rate: null } }, drafts: { drafts: 0, modified_ratio: null } })
    expect(report(t).weekly.map(w => w.active_users)).toEqual([0, 0])
    // 只有 AI 运行：检出待确认，没有计时段
    await study(t)
    // 打开了没提交
    const b = await study(t)
    at(1); t.mx.recordViewerOpen(t.R, b.uid)
    // 两位初写医师各自提交（各一段），没人定稿
    const c = await study(t)
    at(2); t.mx.recordViewerOpen(t.R, c.uid); t.mx.recordViewerOpen(t.as(t.reader2), c.uid)
    at(4); t.svc.reviewLesion(t.R, c.lesions[0]!, { status: 'confirmed' })
    at(5); t.svc.reviewLesion(t.as(t.reader2), c.lesions[1]!, { status: 'confirmed' })
    at(6); t.rv.submitRead(t.R, c.st.id)
    at(9); t.rv.submitRead(t.as(t.reader2), c.st.id)
    const r = report(t)
    expect(r.lesions.ai).toMatchObject({ total: 6, pending: 4, confirmed: 2 })
    expect(r.pipeline).toEqual({ opened_not_submitted: 1, submitted_not_finalized: 1 })
    expect(r.episodes.filter(e => e.kind === 'read').map(e => [e.user_id, mins(e.active_ms)])).toEqual([[t.reader, 4], [t.reader2, 7]])
    expect(r.review.first_round.all.n).toBe(0)
  })

  it('草稿修改量：医生改过的段落、删掉的段落、另加的段落；AI 润色单列', async () => {
    const t = env()
    const { st, lesions: [n1, n2] } = await study(t)
    t.svc.reviewLesion(t.R, n1!, { status: 'confirmed' })
    t.svc.reviewLesion(t.R, n2!, { status: 'confirmed' })
    const d = t.drafts.generate(t.R, st.patient_id, { study_id: st.id }, { turnId: null })
    const reg = (t.store.db.prepare('SELECT blocks FROM findings_drafts WHERE doc_id = ?').get(d.doc_id) as { blocks: string }).blocks
    const blocks = JSON.parse(reg) as Array<{ key: string; id: string }>
    const [b1, b2] = blocks.filter(b => b.key.startsWith('nodule:')).map(b => b.id)
    t.ops.edit({ doc_id: d.doc_id, base_rev: t.docs.rev(d.doc_id), mode: 'apply', ops: [{ op: 'replace_text', id: b1!, find: '结节', replace: '小结节' }, { op: 'delete', ids: [b2!] }] }, { actor: 'user', turnId: null, user: t.reader })
    const last = t.docs.get(d.doc_id).lastChild!.attrs.id as string
    t.ops.edit({ doc_id: d.doc_id, base_rev: t.docs.rev(d.doc_id), mode: 'apply', ops: [{ op: 'insert_after', anchor_id: last, markdown: '印象：双肺结节，建议随访。' }] }, { actor: 'user', turnId: null, user: t.reader })
    const r = report(t)
    const generated = blocks.filter(b => b.key !== 'title' && b.key !== 'status').length
    expect(r.drafts).toMatchObject({ drafts: 1, blocks: generated, edited_by_user: 1, edited_by_ai: 0, deleted: 1, unchanged: generated - 2, drafts_modified: 1, user_added_blocks: 1 })
    expect(r.drafts.modified_ratio).toBe(Math.round(2 / generated * 1000) / 1000)
  })

  it('时间戳乱序（服务器时钟回拨）：计入数据质量，不产生负时长', async () => {
    const t = env()
    const { st, uid, lesions: [n1, n2] } = await study(t)
    at(10); t.mx.recordViewerOpen(t.R, uid)
    at(12); t.svc.reviewLesion(t.R, n1!, { status: 'confirmed' })
    at(5); t.svc.reviewLesion(t.R, n2!, { status: 'confirmed' })    // 钟往回拨了 7 分钟
    at(6); t.rv.submitRead(t.R, st.id)
    const r = report(t)
    expect(r.data_quality.clock_anomalies).toBeGreaterThan(0)
    // 提交时间早于打开时间：窗口里只剩 5 分的一次确认 → 1 分钟；没有负数
    expect(r.episodes.every(e => e.active_ms === null || e.active_ms >= 0)).toBe(true)
    expect(r.reading.first_round.all.median_ms).toBe(1 * MIN)
  })

  it('删除患者：埋点与留痕随检查级联删除，报表里不再出现', async () => {
    const t = env()
    const { p, st, uid, lesions: [n1, n2] } = await study(t)
    at(1); t.mx.recordViewerOpen(t.R, uid)
    at(3); t.svc.reviewLesion(t.R, n1!, { status: 'confirmed' }); t.svc.reviewLesion(t.R, n2!, { status: 'confirmed' })
    at(4); t.rv.submitRead(t.R, st.id)
    at(5); t.drafts.generate(t.R, p.id, { study_id: st.id }, { turnId: null })
    expect(report(t).episodes.length).toBeGreaterThan(0)
    t.patients.remove(t.R, p.id)
    const r = report(t)
    expect(r.episodes).toEqual([])
    expect(r.lesions.ai.total).toBe(0)
    expect(r.drafts.drafts).toBe(0)
    expect((t.patients.imagingLookup(t.R).db.prepare('SELECT COUNT(*) AS n FROM imaging_work_events').get() as { n: number }).n).toBe(0)
  })

  it('按科室：只看本科室成员的计时段与参与的检查；时间段外的不计', async () => {
    const t = env()
    const dept = t.store.addDepartment(t.hosp.id, '放射科一组')
    t.store.setDepartmentMembers(dept.id, [t.reader])
    const { st, uid, lesions: [n1, n2] } = await study(t)
    at(1); t.mx.recordViewerOpen(t.R, uid)
    at(2); t.svc.reviewLesion(t.R, n1!, { status: 'confirmed' }); t.svc.reviewLesion(t.R, n2!, { status: 'confirmed' })
    at(3); t.rv.submitRead(t.R, st.id)
    at(4); t.mx.recordReviewOpen(t.V, st.id)
    at(6); t.rv.finalize(t.V, st.id, { expected_revision: t.rv.view(t.V, st.id).revision })
    const r = report(t, { department: dept.id })
    expect(r.department).toEqual({ id: dept.id, name: '放射科一组' })
    expect(r.reading.first_round.all.n).toBe(1)
    expect(r.review.first_round.all.n).toBe(0)
    expect(r.lesions.ai.total).toBe(2)
    expect(report(t, { from: '2026-10-27', to: '2026-10-28' }).episodes).toEqual([])
    expect(() => report(t, { department: 'nope' })).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => report(t, { from: '2026-11-02', to: '2026-10-01' })).toThrow(expect.objectContaining({ code: 'bad_period' }))
    expect(() => report(t, { from: '2026/10/01' })).toThrow(expect.objectContaining({ code: 'bad_period' }))
  })
})

describe('权限', () => {
  it('只有机构管理员本人：普通成员 403、AI 403（去掉校验时失败）、个人空间 400；AI 不能报告复制 RIS、不记 AI 打开审核视图', async () => {
    const t = env()
    const { st, uid } = await study(t)
    expect(() => t.mx.report(t.R)).toThrow(expect.objectContaining({ status: 403 }))
    expect(() => t.mx.report(t.as(t.admin, 'ai'))).toThrow(expect.objectContaining({ status: 403 }))
    const solo = t.store.createUser({ username: 'solo', display_name: '个体医生', password_hash: 'x' }).id
    expect(() => t.mx.report(t.as(solo))).toThrow(expect.objectContaining({ code: 'personal' }))
    expect(() => t.mx.report(t.as(solo, 'ai'))).toThrow(expect.objectContaining({ status: 403 }))
    expect(() => t.mx.recordRisCopy(t.as(t.reader, 'ai'), 'any')).toThrow(expect.objectContaining({ status: 403 }))
    expect(t.mx.recordReviewOpen(t.as(t.reviewer, 'ai'), st.id)).toBe(false)
    expect(t.mx.recordViewerOpen(t.as(t.reader, 'ai'), uid)).toBe(false)
    // 看不到患者的人不记打开（票据签发后被移出诊疗组）
    const outsider = t.store.createUser({ username: 'dr_x', display_name: '外科', password_hash: 'x', tenant: { id: t.hosp.id, role: 'member' } }).id
    expect(() => t.mx.recordViewerOpen(t.as(outsider), uid)).toThrow(expect.objectContaining({ status: 404 }))
    // 埋点表只追加
    const db = t.patients.imagingLookup(t.R).db
    t.mx.recordReviewOpen(t.V, st.id)
    expect(() => db.prepare("UPDATE imaging_work_events SET at = 'x'").run()).toThrow(/只追加/)
  })

  it('接口：打开阅片器（票据兑换）、打开审核视图、复制 RIS 都记下；报表只给管理员，CSV 可下载', async () => {
    const t = env()
    const app = buildApi({
      docs: t.docs, ops: t.ops, turns: {} as never, postcheck: new PostCheck(t.docs), crossref: {} as never,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'mx-r-'))), accounts: new Accounts(t.store, { secret: 'test-secret', devMode: false, devToken: 'dev', devUser: 'dev' }),
      devMode: false, devUser: 'dev', patients: t.patients, orthanc: t.orthanc, imagingPipeline: null, imagingInteractive: null, imagingFollowup: null,
    })
    const tok = (u: string) => `Bearer ${issueToken('test-secret', { u, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: t.store.getUser(u)!.token_version })}`
    const H = (u: string) => ({ Authorization: tok(u), 'Content-Type': 'application/json' })
    const { st, uid, lesions: [n1, n2] } = await study(t)
    process.env.VIEWER_HOST = 'viewer.test'
    process.env.VIEWER_URL = 'http://ohif:8080'
    try {
      at(1)
      const { url } = await (await app.request('/api/imaging/viewer-ticket', { method: 'POST', headers: H(t.reader), body: JSON.stringify({ study_uid: uid }) })).json() as { url: string }
      expect((await app.request(url)).status).toBe(302)
      expect((await app.request(url)).status).toBe(401)   // 票据只能用一次，失败的兑换不记
    } finally { delete process.env.VIEWER_HOST; delete process.env.VIEWER_URL }
    at(3); t.svc.reviewLesion(t.R, n1!, { status: 'confirmed' }); t.svc.reviewLesion(t.R, n2!, { status: 'confirmed' })
    at(4); t.rv.submitRead(t.R, st.id)
    at(5); const d = t.drafts.generate(t.R, st.patient_id, { study_id: st.id }, { turnId: null })
    at(6); expect(await (await app.request(`/api/docs/${d.doc_id}/ris-copied`, { method: 'POST', headers: H(t.reader) })).json()).toEqual({ recorded: true })
    expect((await app.request(`/api/docs/${d.doc_id}/ris-copied`, { method: 'POST', headers: H(t.reviewer) })).status).toBe(404)   // 别人的文档
    at(7); expect((await app.request(`/api/patients/${st.patient_id}/imaging/studies/${st.id}/review?opened=1`, { headers: H(t.reviewer) })).status).toBe(200)
    // 自动刷新与操作后的重新加载（不带 opened）不记，否则开着不动也会被算成审核耗时
    for (let i = 0; i < 3; i++) expect((await app.request(`/api/patients/${st.patient_id}/imaging/studies/${st.id}/review`, { headers: H(t.reviewer) })).status).toBe(200)
    const kinds = (t.patients.imagingLookup(t.R).db.prepare('SELECT user_id, kind FROM imaging_work_events ORDER BY id').all() as Array<{ user_id: string; kind: string }>).map(e => [e.user_id, e.kind])
    expect(kinds).toEqual([[t.reader, 'viewer_open'], [t.reader, 'ris_copy'], [t.reviewer, 'review_open']])

    expect((await app.request('/api/imaging/efficiency-report?from=2026-10-20&to=2026-11-01', { headers: H(t.reader) })).status).toBe(403)
    const ok = await app.request('/api/imaging/efficiency-report?from=2026-10-20&to=2026-11-01', { headers: H(t.admin) })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toContain('no-store')
    expect(((await ok.json()) as { read_write: { all: { median_ms: number } } }).read_write.all.median_ms).toBe(5 * MIN)   // 1 → 3 → 4 → 5 → 6
    const csv = await app.request('/api/imaging/efficiency-report?from=2026-10-20&to=2026-11-01&format=csv', { headers: H(t.admin) })
    expect(csv.headers.get('content-type')).toContain('text/csv')
    expect(await csv.text()).toContain(`read_write,${st.id},${t.reader},1,`)
    expect((await app.request('/api/imaging/efficiency-report?from=bad', { headers: H(t.admin) })).status).toBe(400)
    const audit = t.store.db.prepare("SELECT action FROM audit_events WHERE action = 'imaging.efficiency_report'").all()
    expect(audit.length).toBe(2)
  })
})
