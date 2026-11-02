import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { buildApi } from '../src/http/api.ts'
import { classifyChange, daysBetween, ImagingFollowup, type FollowupView } from '../src/imaging/followup.ts'
import { OrthancError } from '../src/imaging/orthanc.ts'
import { ImagingPipeline } from '../src/imaging/pipeline.ts'
import { ImagingStudyService } from '../src/imaging/studies.ts'
import { registerImagingFollowupTools } from '../src/mcp/imaging-followup-tools.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import { FakeOrthanc, fakeWorker, seriesFiles } from './imaging-fakes.ts'

/**
 * 随访对比（T2.4）：找前片、分析后自动匹配、变化分类与误差范围、VDT、医生拆开 / 重新对应、
 * 影子模式不参与、病灶被否决 / 取代后的链接、并发触发合并、肺部锚点、权限与接口。
 */

const PRIOR = '1.2.840.113619.2.55.3.5001'
const CUR = '1.2.840.113619.2.55.3.5002'
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Nod { c: number[] | null; d: number; v: number | null; lobe?: string; seg?: string }
const ANCHOR = (z: number) => ({ ok: true, centroid_lps_mm: [0, 0, z], apex_z_mm: z + 120, apex_in_fov: true })
function result(nods: Nod[], anchorZ: number | null = 0) {
  return {
    model_id: 'lung_nodule_pipeline', model_version: 'lung_nodule_ct@0.5.9+vista3d@0.5.7', device: 'cpu', elapsed_ms: 1000,
    series_qc: { spacing_mm: [1.25, 0.7, 0.7], ...(anchorZ === null ? {} : { lung_anchor: ANCHOR(anchorZ) }) },
    nodules: nods.map((n, i) => ({
      index: i + 1, detection_score: 0.9, center_vox_zyx: [10 * i, 100, 100], box_vox_zyx: [0, 0, 0, 1, 1, 1], lobe: n.lobe ?? null, segmentation: n.seg ?? 'vista3d', key_slice_z: 10 * i,
      center_lps_mm: n.c, box_lps_mm: null, key_slice_sop_instance_uid: `1.2.3.${i}`,
      metrics: { long_axis_mm: n.d, short_axis_mm: n.d, mean_diameter_mm: n.d, volume_mm3: n.v },
      warnings: [],
    })),
    warnings: [],
  }
}

/** 假 worker 的结节对应：两期都有锚点时按锚点质心平移，否则不平移；门限 10 mm 的最近邻；fixed_pairs 不再指派 */
function fakeMatch(body: { prior: { nodules: Array<{ id: string; center_lps_mm: number[] | null }>; anchor: { centroid_lps_mm: number[] } | null }; current: { nodules: Array<{ id: string; center_lps_mm: number[] | null }>; anchor: { centroid_lps_mm: number[] } | null }; fixed_pairs: string[][] }, quality: 'fine' | 'coarse' | 'none') {
  const t = body.prior.anchor && body.current.anchor ? body.current.anchor.centroid_lps_mm.map((v, i) => v - body.prior.anchor!.centroid_lps_mm[i]!) : [0, 0, 0]
  const fixedP = new Set(body.fixed_pairs.map(p => p[0])), fixedC = new Set(body.fixed_pairs.map(p => p[1]))
  const skipped = [...body.prior.nodules.filter(n => !n.center_lps_mm).map(n => ({ id: n.id, side: 'prior', reason: '没有病人坐标（LPS）' })),
    ...body.current.nodules.filter(n => !n.center_lps_mm).map(n => ({ id: n.id, side: 'current', reason: '没有病人坐标（LPS）' }))]
  const P = body.prior.nodules.filter(n => n.center_lps_mm && !fixedP.has(n.id)), C = body.current.nodules.filter(n => n.center_lps_mm && !fixedC.has(n.id))
  const pairs: Array<Record<string, unknown>> = [], usedC = new Set<string>(), usedP = new Set<string>()
  for (const p of P) {
    let best: { id: string; d: number } | null = null
    for (const c of C) {
      if (usedC.has(c.id)) continue
      const d = Math.hypot(...c.center_lps_mm!.map((v, i) => v - p.center_lps_mm![i]! - t[i]!))
      if (d <= 10 && (!best || d < best.d)) best = { id: c.id, d }
    }
    if (best) { usedC.add(best.id); usedP.add(p.id); pairs.push({ prior_id: p.id, current_id: best.id, distance_mm: Math.round(best.d * 10) / 10, gate_mm: 12, lobe_match: null, ambiguous: false, alternatives_prior: [], alternatives_current: [] }) }
  }
  return {
    registration: { quality, reliable: quality === 'fine', translation_mm: t, inliers: pairs.length, notes: quality === 'fine' ? [] : ['配准不可靠'] },
    pairs, fixed: body.fixed_pairs.map(([p, c]) => ({ prior_id: p, current_id: c, distance_mm: 1 })),
    unmatched_prior: P.filter(p => !usedP.has(p.id)).map(p => p.id), unmatched_current: C.filter(c => !usedC.has(c.id)).map(c => c.id), skipped,
  }
}

const PRIOR_NODS: Nod[] = [
  { c: [-43, 37, 108], d: 8.2, v: 288.4, lobe: 'RUL' },    // → 增大
  { c: [60, 10, 50], d: 6.0, v: 113, lobe: 'LUL' },        // → 稳定（误差内）
  { c: [-20, -30, 0], d: 5.0, v: 65, lobe: 'RLL' },        // → 消失
]
// 本次检查的病人坐标原点比前片低 200 mm（扫描床位置不同），锚点也低 200 mm
const SHIFT = -200
const CUR_NODS: Nod[] = [
  { c: [-42, 37, 108 + SHIFT + 1], d: 10.5, v: 600, lobe: 'RUL' },
  { c: [60, 11, 50 + SHIFT], d: 6.3, v: 120, lobe: 'LUL' },
  { c: [30, -40, -60 + SHIFT], d: 4.0, v: 33, lobe: 'LLL' },    // 新发
]

function env(opts: { quality?: 'fine' | 'coarse' | 'none'; priorAnchor?: boolean; matchDown?: boolean; matchDelay?: number } = {}) {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-img-fu-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const admin = store.createUser({ username: 'admin_li', display_name: '李主任', password_hash: 'x', tenant: { id: hosp.id, role: 'admin' } }).id
  const dr = store.createUser({ username: 'dr_wang', display_name: '王医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const other = store.createUser({ username: 'dr_zhao', display_name: '赵医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const orthanc = new FakeOrthanc()
  orthanc.studyDates.set(PRIOR, '2025-10-20')
  orthanc.studyDates.set(CUR, '2026-10-20')
  const svc = new ImagingStudyService(patients, orthanc)
  const a: Actor = { userId: dr, via: 'user' }
  /** 每个检查下一次分析返回的结节（按 StudyInstanceUID） */
  const results = new Map<string, unknown>([[PRIOR, result(PRIOR_NODS, opts.priorAnchor === false ? null : 0)], [CUR, result(CUR_NODS, SHIFT)]])
  const uidOfStudy = (studyId: string) => [PRIOR, CUR].find(u => { try { return svc.resolveStudyUid(a, u).studyId === studyId } catch { return false } })!
  let quality = opts.quality ?? 'fine'
  const worker = fakeWorker(async (path, init) => {
    if (path === '/api/v1/pipeline/lung-nodule') {
      const runId = (JSON.parse(init.body as string).volume_id as string).replace(/^run_/, '')
      return ok(results.get(uidOfStudy(svc.runSource(a, runId).run.study_id)))
    }
    if (path === '/api/v1/pipeline/lung-nodule/match') {
      if (opts.matchDown) return ok({ detail: 'boom' }, 500)
      if (opts.matchDelay) await new Promise(r => setTimeout(r, opts.matchDelay))
      return ok(fakeMatch(JSON.parse(init.body as string), quality))
    }
    if (path === '/api/v1/pipeline/lung-nodule/anchor') return ok({ anchor: ANCHOR(0) })
    return ok({ ok: true })
  })
  const followup = new ImagingFollowup(patients, orthanc, 'http://worker:8004', { fetch: worker.fetchImpl })
  const pipeline = new ImagingPipeline(svc, orthanc, 'http://worker:8004', { fetch: worker.fetchImpl, onRunDone: (x, run) => followup.onAnalysisDone(x, run) })
  followup.attachAnalyzer((x, studyId) => pipeline.enqueue(x, studyId))
  const settle = async () => { for (let i = 0; i < 5; i++) { await pipeline.idle(); await followup.idle() } }
  const setMode = (mode: 'visible' | 'shadow') => tenants.update(admin, { settings: { imaging_ai_visibility: mode } })
  return { store, tenants, patients, orthanc, svc, a, dr, other, worker, followup, pipeline, results, settle, setMode, setQuality: (q: typeof quality) => { quality = q } }
}

async function seeded(opts: Parameters<typeof env>[0] = {}) {
  const t = env(opts)
  const p = t.patients.create(t.a, { sex: 'F', birth_year: 1961 })
  const prior = (await t.svc.importDicom(t.a, p.id, seriesFiles(PRIOR, `${PRIOR}.2`, 40))).studies[0]!
  const cur = (await t.svc.importDicom(t.a, p.id, seriesFiles(CUR, `${CUR}.2`, 40))).studies[0]!
  return { ...t, p, prior, cur }
}

/** 前片分析完成并由医生确认全部检出，再分析本次 */
async function reviewed(opts: Parameters<typeof env>[0] = {}) {
  const t = await seeded(opts)
  t.pipeline.enqueue(t.a, t.prior.id)
  await t.settle()
  for (const l of t.svc.listLesions(t.a, t.prior.id)) t.svc.reviewLesion(t.a, l.id, { status: 'confirmed' })
  t.pipeline.enqueue(t.a, t.cur.id)
  await t.settle()
  const lesions = t.svc.listLesions(t.a, t.cur.id)
  const priorLesions = t.svc.listLesions(t.a, t.prior.id)
  const byLabel = (ls: typeof lesions, label: string) => ls.find(l => l.label === label)!
  return { ...t, C1: byLabel(lesions, '结节 1'), C2: byLabel(lesions, '结节 2'), C3: byLabel(lesions, '结节 3'), P1: byLabel(priorLesions, '结节 1'), P2: byLabel(priorLesions, '结节 2'), P3: byLabel(priorLesions, '结节 3') }
}

const itemOf = (v: FollowupView, lesionId: string) => v.items.find(i => i.lesion_id === lesionId)!
const priorItem = (v: FollowupView, priorId: string) => v.items.find(i => i.prior_lesion_id === priorId && !i.lesion_id)!

describe('变化分类与倍增时间（纯函数）', () => {
  it('两期都有体积时按体积：±25% 以内为稳定（在误差范围内），超出为增大 / 缩小', () => {
    const p = { mean_diameter_mm: 8, volume_mm3: 200 }
    expect(classifyChange(p, { mean_diameter_mm: 8.4, volume_mm3: 240 }, 365)).toMatchObject({ change: 'stable', basis: 'volume', within_error: true, delta_volume_pct: 20 })
    expect(classifyChange(p, { mean_diameter_mm: 9.5, volume_mm3: 250 }, 365)).toMatchObject({ change: 'enlarged', within_error: false, delta_volume_pct: 25 })
    expect(classifyChange(p, { mean_diameter_mm: 6, volume_mm3: 140 }, 365)).toMatchObject({ change: 'shrunk', delta_volume_mm3: -60, delta_mean_diameter_mm: -2 })
  })

  it('没有体积（分割失败）时按平均径：变化 ≤ 1.5 mm 为误差内', () => {
    expect(classifyChange({ mean_diameter_mm: 6, volume_mm3: 100 }, { mean_diameter_mm: 7.5, volume_mm3: 300, segmentation: 'failed' }, 100))
      .toMatchObject({ change: 'stable', basis: 'diameter', within_error: true, current_volume_mm3: null, vdt_days: null, vdt_note: '缺少两期体积，不计算倍增时间' })
    expect(classifyChange({ mean_diameter_mm: 6 }, { mean_diameter_mm: 7.6 }, 100)).toMatchObject({ change: 'enlarged', basis: 'diameter', within_error: false })
    expect(classifyChange({}, {}, 100)).toMatchObject({ change: 'stable', basis: null, within_error: false, notes: ['两期缺少可比较的测量，无法判断大小变化'] })
  })

  it('VDT 只在两期都有体积、间隔 > 0 天且体积增大时给出（Schwartz）；误差内时注明不可靠', () => {
    const m = classifyChange({ mean_diameter_mm: 8.2, volume_mm3: 288.4 }, { mean_diameter_mm: 10.5, volume_mm3: 600 }, 365)
    expect(m.vdt_days).toBe(Math.round(365 * Math.LN2 / Math.log(600 / 288.4)))
    expect(m.vdt_note).toBeNull()
    expect(classifyChange({ volume_mm3: 200 }, { volume_mm3: 220 }, 365)).toMatchObject({ vdt_days: Math.round(365 * Math.LN2 / Math.log(1.1)), vdt_note: '体积变化在测量误差范围内，倍增时间不可靠' })
    expect(classifyChange({ volume_mm3: 200 }, { volume_mm3: 100 }, 365)).toMatchObject({ vdt_days: null, vdt_note: '体积缩小，倍增时间不适用' })
    expect(classifyChange({ volume_mm3: 200 }, { volume_mm3: 200 }, 365)).toMatchObject({ vdt_days: null, vdt_note: '体积无变化，倍增时间不适用' })
    expect(classifyChange({ volume_mm3: 200 }, { volume_mm3: 400 }, 0)).toMatchObject({ vdt_days: null, vdt_note: '两期间隔未知或为 0 天，不计算倍增时间' })
    expect(classifyChange({ volume_mm3: 200 }, { volume_mm3: 400 }, null).vdt_days).toBeNull()
  })

  it('体积与平均径方向相反时提示核对；阈值可用环境变量调整', () => {
    expect(classifyChange({ mean_diameter_mm: 10, volume_mm3: 400 }, { mean_diameter_mm: 7, volume_mm3: 600 }, 30).notes).toContain('体积与平均径的变化方向相反，请核对分割')
    process.env.IMAGING_FOLLOWUP_VOLUME_TOL_PCT = '10'
    try { expect(classifyChange({ volume_mm3: 200 }, { volume_mm3: 240 }, 30).change).toBe('enlarged') } finally { delete process.env.IMAGING_FOLLOWUP_VOLUME_TOL_PCT }
    expect(daysBetween('2025-10-20', '2026-10-20')).toBe(365)
    expect(daysBetween(null, '2026-10-20')).toBeNull()
  })
})

describe('随访对比（T2.4）', () => {
  it('本次分析完成后自动匹配已确认的前片：增大（含 VDT）、稳定（误差内）、消失、新发；锚点与结节交给 worker', async () => {
    const t = await reviewed()
    const v = t.followup.view(t.a, t.cur.id)
    expect(v.prior).toEqual({ study_id: t.prior.id, study_date: '2025-10-20', interval_days: 365 })
    expect(v.run).toMatchObject({ status: 'done', trigger_kind: 'auto', prior_study_id: t.prior.id })
    expect(v.registration).toMatchObject({ quality: 'fine', reliable: true })
    expect(v.counts).toEqual({ new: 1, disappeared: 1, enlarged: 1, shrunk: 0, stable: 1, pending: 0 })
    expect(itemOf(v, t.C1.id)).toMatchObject({ prior_lesion_id: t.P1.id, change: 'enlarged', source: 'ai', needs_review: false,
      metrics: { basis: 'volume', within_error: false, delta_mean_diameter_mm: 2.3, delta_volume_mm3: 311.6, vdt_days: Math.round(365 * Math.LN2 / Math.log(600 / 288.4)) } })
    expect(itemOf(v, t.C2.id)).toMatchObject({ prior_lesion_id: t.P2.id, change: 'stable', metrics: { within_error: true, delta_volume_pct: 6.2 } })
    expect(itemOf(v, t.C3.id)).toMatchObject({ change: 'new', prior_lesion_id: null })
    expect(priorItem(v, t.P3.id)).toMatchObject({ change: 'disappeared', lesion_id: null, prior_lesion: { label: '结节 3', mean_diameter_mm: 5 } })
    // worker 收到两期的结节与锚点（锚点来自分析时的 series_qc.lung_anchor）
    const call = t.worker.calls.filter(c => c.path.endsWith('/match')).at(-1)!.body as { prior: { nodules: unknown[]; anchor: unknown }; current: { nodules: Array<{ id: string; lobe: string | null }>; anchor: unknown }; fixed_pairs: unknown[] }
    expect(call.prior.nodules).toHaveLength(3)
    expect(call.current.anchor).toEqual(ANCHOR(SHIFT))
    expect(call.prior.anchor).toEqual(ANCHOR(0))
    expect(call.current.nodules.find(n => n.id === t.C1.id)).toMatchObject({ lobe: 'RUL', mean_diameter_mm: 10.5 })
    expect(call.fixed_pairs).toEqual([])
    // 留痕：自动匹配建链接（经 AI 分析流水线的身份）
    expect(t.followup.linkEvents(t.a, t.cur.id).filter(e => e.action === 'auto_match')).toHaveLength(4)
    // 本次的病灶还是待确认：随访对比与之同步就绪，不等医生审核
    expect(t.C1.status).toBe('proposed')
  })

  it('前片还没分析时自动排队分析（W3.1 预计算）；前片的检出确认后重新匹配；不连锁分析更早的检查', async () => {
    const t = await seeded()
    t.pipeline.enqueue(t.a, t.cur.id)
    await t.settle()
    // 前片被自动分析了，但还没有确认的结节：本次跳过并说明
    expect(t.svc.listStudies(t.a, t.p.id).find(s => s.id === t.prior.id)!.runs[0]).toMatchObject({ status: 'done' })
    let v = t.followup.view(t.a, t.cur.id)
    expect(v.prior).toBeNull()
    expect(v.run).toMatchObject({ status: 'skipped', reason: expect.stringContaining('还没有确认的结节') })
    expect(v.run!.summary!.notes).toEqual(expect.arrayContaining([expect.stringContaining('已排队分析')]))
    // 前片的匹配：没有更早的检查
    expect(t.followup.view(t.a, t.prior.id).run).toMatchObject({ status: 'skipped', reason: '没有更早的 CT 检查' })
    expect(t.worker.calls.filter(c => c.path === '/api/v1/pipeline/lung-nodule')).toHaveLength(2)

    for (const l of t.svc.listLesions(t.a, t.prior.id)) t.svc.reviewLesion(t.a, l.id, { status: 'confirmed' })
    t.followup.schedule(t.a, t.cur.id, 'manual')
    await t.settle()
    v = t.followup.view(t.a, t.cur.id)
    expect(v.run).toMatchObject({ status: 'done', trigger_kind: 'manual' })
    expect(v.counts).toMatchObject({ enlarged: 1, stable: 1, new: 1, disappeared: 1 })
  })

  it('找前片的边界：本次没有检查日期；同一天的检查不作前片；前片在更晚日期时不用', async () => {
    const t = env()
    t.orthanc.studyDates.set(CUR, null)
    const p = t.patients.create(t.a, { sex: 'F', birth_year: 1961 })
    const cur = (await t.svc.importDicom(t.a, p.id, seriesFiles(CUR, `${CUR}.2`, 40))).studies[0]!
    const s = t.patients.imagingScope(t.a, p.id, 'read')
    expect(t.followup.findPrior(s, cur.id)).toMatchObject({ prior: null, reason: expect.stringContaining('没有检查日期') })

    const u = await seeded()
    const sc = u.patients.imagingScope(u.a, u.p.id, 'read')
    u.patients.imagingLookup(u.a).db.prepare('UPDATE imaging_studies SET study_date = ? WHERE id = ?').run('2026-10-20', u.prior.id)
    expect(u.followup.findPrior(sc, u.cur.id)).toMatchObject({ prior: null, reason: '没有更早的 CT 检查', notes: [expect.stringContaining('同一天另有 1 个 CT 检查')] })
    u.patients.imagingLookup(u.a).db.prepare('UPDATE imaging_studies SET study_date = ? WHERE id = ?').run('2027-01-01', u.prior.id)
    expect(u.followup.findPrior(sc, u.cur.id).prior).toBeNull()
    // 前片自己也不会以本次为前片之外的检查作参照：两期同一检查不会出现
    expect(u.followup.findPrior(sc, u.prior.id).prior).toBeNull()
  })

  it('医生拆开与重新对应：留痕；重新匹配保留医生的对应并作为已知对应交给配准；AI 与非诊疗组医生不能改', async () => {
    const t = await reviewed()
    let v = t.followup.view(t.a, t.cur.id)
    const l1 = itemOf(v, t.C1.id).link_id!
    // 拆开 C1↔P1：C1 新发，P1 消失（医生的判断）
    v = t.followup.unlink(t.a, l1)
    expect(itemOf(v, t.C1.id)).toMatchObject({ change: 'new', source: 'manual' })
    expect(priorItem(v, t.P1.id)).toMatchObject({ change: 'disappeared', source: 'manual' })
    expect(() => t.followup.unlink(t.a, l1)).toThrow(expect.objectContaining({ code: 'link_inactive', status: 409 }))
    // 重新对应：C3（新发）↔ P3（消失）
    v = t.followup.relink(t.a, t.cur.id, t.C3.id, t.P3.id)
    expect(itemOf(v, t.C3.id)).toMatchObject({ prior_lesion_id: t.P3.id, change: 'shrunk', source: 'manual', needs_review: false })
    expect(v.items.filter(i => i.prior_lesion_id === t.P3.id)).toHaveLength(1)
    // 把 C2 改对应到 P1：C2 原来的前片 P2 变为消失；P1 原来的「消失」被取代
    v = t.followup.relink(t.a, t.cur.id, t.C2.id, t.P1.id)
    expect(itemOf(v, t.C2.id)).toMatchObject({ prior_lesion_id: t.P1.id, source: 'manual' })
    expect(priorItem(v, t.P2.id)).toMatchObject({ change: 'disappeared', source: 'manual' })
    expect(v.items.filter(i => i.prior_lesion_id === t.P1.id)).toHaveLength(1)
    const actions = t.followup.linkEvents(t.a, t.cur.id).map(e => `${e.via}:${e.action}`)
    expect(actions).toEqual(expect.arrayContaining(['user:unlink', 'user:relink']))

    // 重新匹配：医生的对应保留，配对作为 fixed_pairs，单侧的不再自动配对
    t.followup.schedule(t.a, t.cur.id, 'manual')
    await t.settle()
    const body = t.worker.calls.filter(c => c.path.endsWith('/match')).at(-1)!.body as { prior: { nodules: Array<{ id: string }> }; current: { nodules: Array<{ id: string }> }; fixed_pairs: string[][] }
    expect(body.fixed_pairs).toEqual(expect.arrayContaining([[t.P3.id, t.C3.id], [t.P1.id, t.C2.id]]))
    expect(body.current.nodules.map(n => n.id)).not.toContain(t.C1.id)   // 医生说 C1 是新发
    expect(body.prior.nodules.map(n => n.id)).not.toContain(t.P2.id)     // 医生说 P2 消失了
    v = t.followup.view(t.a, t.cur.id)
    expect(itemOf(v, t.C2.id)).toMatchObject({ prior_lesion_id: t.P1.id, source: 'manual' })
    expect(itemOf(v, t.C1.id)).toMatchObject({ change: 'new', source: 'manual' })

    // 校验
    expect(() => t.followup.relink({ ...t.a, via: 'ai' }, t.cur.id, t.C1.id, null)).toThrow(expect.objectContaining({ status: 403 }))
    expect(() => t.followup.unlink({ ...t.a, via: 'ai' }, itemOf(v, t.C2.id).link_id!)).toThrow(expect.objectContaining({ status: 403 }))
    expect(() => t.followup.schedule({ ...t.a, via: 'ai' }, t.cur.id, 'manual')).toThrow(expect.objectContaining({ status: 403 }))
    expect(() => t.followup.relink({ userId: t.other, via: 'user' }, t.cur.id, t.C1.id, null)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => t.followup.view({ userId: t.other, via: 'user' }, t.cur.id)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => t.followup.relink(t.a, t.cur.id, t.C1.id, t.C2.id)).toThrow(expect.objectContaining({ code: 'same_study', status: 409 }))
    expect(() => t.followup.relink(t.a, t.cur.id, t.P1.id, null)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => t.followup.relink(t.a, t.cur.id, null, null)).toThrow(expect.objectContaining({ code: 'bad_link' }))
    // AI 读：可以
    expect(t.followup.view({ ...t.a, via: 'ai' }, t.cur.id).items.length).toBe(v.items.length)
  })

  it('病灶被否决、撤销或重新分析取代后：按现状推导并提示核对；重新分析后自动重匹配，失效的医生对应作废', async () => {
    const t = await reviewed()
    // 否决本次 C1 → 前片 P1 显示为消失（需核对）
    t.svc.reviewLesion(t.a, t.C1.id, { status: 'rejected', reason: '血管断面' })
    let v = t.followup.view(t.a, t.cur.id)
    expect(v.items.find(i => i.lesion_id === t.C1.id)).toBeUndefined()
    expect(priorItem(v, t.P1.id)).toMatchObject({ change: 'disappeared', needs_review: true, notes: [expect.stringContaining('已被否决或撤销')] })
    // 前片 P2 被否决 → C2 按新发显示（需核对）
    t.svc.reviewLesion(t.a, t.P2.id, { status: 'rejected', reason: '其他' })
    v = t.followup.view(t.a, t.cur.id)
    expect(itemOf(v, t.C2.id)).toMatchObject({ change: 'new', needs_review: true })

    // 医生对应 C3↔P3，然后重新分析：C3 是待确认的 AI 检出，被新运行取代 → 医生对应作废，新检出重新自动匹配
    t.followup.relink(t.a, t.cur.id, t.C3.id, t.P3.id)
    t.pipeline.enqueue(t.a, t.cur.id)
    await t.settle()
    const runs = t.followup.view(t.a, t.cur.id)
    expect(runs.run).toMatchObject({ status: 'done', trigger_kind: 'auto' })
    const events = t.followup.linkEvents(t.a, t.cur.id)
    expect(events.some(e => e.action === 'invalidate' && (e.before as { lesion_id: string }).lesion_id === t.C3.id)).toBe(true)
    const newC3 = t.svc.listLesions(t.a, t.cur.id).find(l => l.label === '结节 3' && l.id !== t.C3.id)!
    expect(itemOf(runs, newC3.id)).toMatchObject({ change: 'new', source: 'ai' })
    // 旧链接都不再起作用：视图里没有被取代的病灶
    expect(runs.items.some(i => i.lesion_id === t.C3.id || i.lesion_id === t.C2.id)).toBe(false)
  })

  it('影子模式：影子运行不触发匹配，影子检出不参与；切回显示后的分析照常', async () => {
    const t = await seeded()
    t.pipeline.enqueue(t.a, t.prior.id)
    await t.settle()
    for (const l of t.svc.listLesions(t.a, t.prior.id)) t.svc.reviewLesion(t.a, l.id, { status: 'confirmed' })
    const before = t.worker.calls.filter(c => c.path.endsWith('/match')).length
    t.setMode('shadow')
    t.pipeline.enqueue(t.a, t.cur.id)
    await t.settle()
    expect(t.worker.calls.filter(c => c.path.endsWith('/match')).length).toBe(before)
    expect(t.followup.view(t.a, t.cur.id).run).toBeNull()
    // 手动重新匹配：影子检出也不在本次的结节里
    t.followup.schedule(t.a, t.cur.id, 'manual')
    await t.settle()
    const body = t.worker.calls.filter(c => c.path.endsWith('/match')).at(-1)!.body as { current: { nodules: unknown[] } }
    expect(body.current.nodules).toEqual([])
    expect(t.followup.view(t.a, t.cur.id).counts).toMatchObject({ disappeared: 3, new: 0 })
  })

  it('配准不可靠时全部标为需核对；缺坐标的结节不参与并说明；worker 失败时如实记录、原有链接不动', async () => {
    const t = await reviewed({ quality: 'coarse' })
    let v = t.followup.view(t.a, t.cur.id)
    expect(v.registration).toMatchObject({ quality: 'coarse', reliable: false })
    expect(v.items.filter(i => i.source === 'ai').every(i => i.needs_review)).toBe(true)

    // 医生点选补充一个没有病人坐标的结节：不能自动对比
    const manual = t.svc.addLesion(t.a, t.cur.id, { kind: 'lung_nodule', source: 'manual', label: '医生补充 1', metrics: { mean_diameter_mm: 5, center_lps_mm: null } })
    v = t.followup.view(t.a, t.cur.id)
    expect(itemOf(v, manual.id)).toMatchObject({ change: null, notes: ['没有病人坐标，不能自动对比，可手动对应'] })
    expect(v.counts.pending).toBe(1)
    t.followup.schedule(t.a, t.cur.id, 'manual')
    await t.settle()
    v = t.followup.view(t.a, t.cur.id)
    expect(v.run!.summary!.warnings).toEqual(expect.arrayContaining(['1 个结节没有病人坐标，未参与对比']))
    expect(itemOf(v, manual.id).change).toBeNull()

    const u = await reviewed({ matchDown: true })
    const fv = u.followup.view(u.a, u.cur.id)
    expect(fv.run).toMatchObject({ status: 'failed', error: expect.stringContaining('HTTP 500') })
    expect(fv.prior).toBeNull()
    expect(fv.items).toEqual([])
  })

  it('同一检查的重复触发合并：正在匹配时再触发只追加一次', async () => {
    const t = await reviewed({ matchDelay: 30 })
    const before = t.worker.calls.filter(c => c.path.endsWith('/match')).length
    const r1 = t.followup.schedule(t.a, t.cur.id, 'manual')
    const r2 = t.followup.schedule(t.a, t.cur.id, 'manual')
    const r3 = t.followup.schedule(t.a, t.cur.id, 'auto')
    expect(r2.id).toBe(r1.id)
    expect(r3.id).toBe(r1.id)
    expect(t.followup.view(t.a, t.cur.id).run!.status).not.toBe('interrupted')
    await t.settle()
    expect(t.worker.calls.filter(c => c.path.endsWith('/match')).length - before).toBe(2)
    // 现行链接没有重复：每个病灶只出现一次
    const v = t.followup.view(t.a, t.cur.id)
    const ids = v.items.flatMap(i => [i.lesion_id, i.prior_lesion_id]).filter(Boolean)
    expect(new Set(ids).size).toBe(ids.length)
    // 服务重启（另一个实例）：库里排队中的匹配显示为中断
    t.patients.imagingLookup(t.a).db.prepare("UPDATE imaging_followups SET status = 'running' WHERE id = (SELECT id FROM imaging_followups ORDER BY rowid DESC LIMIT 1)").run()
    expect(t.followup.view(t.a, t.cur.id).run!.status).toBe('interrupted')
  })

  it('前片没有锚点（旧分析）：从影像存储取出序列补算并缓存；序列已不在影像存储时如实说明', async () => {
    const t = await reviewed({ priorAnchor: false })
    expect(t.worker.calls.filter(c => c.path.endsWith('/anchor'))).toHaveLength(1)
    const up = t.worker.calls.filter(c => c.path === '/api/v1/volume/upload').map(c => (c.body as { volume_id: string }).volume_id)
    expect(up.some(id => id.startsWith('anchor_se'))).toBe(true)
    expect(t.worker.calls.some(c => c.method === 'DELETE' && c.path.startsWith('/api/v1/volume/anchor_se'))).toBe(true)
    const body = t.worker.calls.filter(c => c.path.endsWith('/match')).at(-1)!.body as { prior: { anchor: unknown } }
    expect(body.prior.anchor).toEqual(ANCHOR(0))
    t.followup.schedule(t.a, t.cur.id, 'manual')
    await t.settle()
    expect(t.worker.calls.filter(c => c.path.endsWith('/anchor'))).toHaveLength(1)   // 已缓存

    const u = await seeded({ priorAnchor: false })
    u.pipeline.enqueue(u.a, u.prior.id)
    await u.settle()
    for (const l of u.svc.listLesions(u.a, u.prior.id)) u.svc.reviewLesion(u.a, l.id, { status: 'confirmed' })
    // 前片序列已从影像存储删除（本次的序列还在）
    const orig = u.orthanc.seriesArchive.bind(u.orthanc)
    u.orthanc.seriesArchive = async (id: string) => {
      const zip = await orig(id)
      if (u.orthanc.archives.at(-1) === `${PRIOR}.2`) throw new OrthancError(404, '序列不存在')
      return zip
    }
    u.pipeline.enqueue(u.a, u.cur.id)
    await u.settle()
    const v = u.followup.view(u.a, u.cur.id)
    expect(v.run).toMatchObject({ status: 'done' })
    expect(v.run!.summary!.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^前片肺部锚点：序列已不在影像存储中/)]))
  })
})

describe('随访对比接口与 AI 工具', () => {
  it('主站读写、阅片器子域名（Cookie、请求头）、MCP 只读', async () => {
    const t = await reviewed()
    const docs = new Documents(t.store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img-fu-r-'))), accounts: new Accounts(t.store, { secret: 'test-secret', devMode: false, devToken: 'dev', devUser: 'dev' }),
      devMode: false, devUser: 'dev', patients: t.patients, orthanc: t.orthanc, imagingPipeline: null, imagingInteractive: null, imagingFollowup: t.followup,
    })
    const tok = (u: string) => `Bearer ${issueToken('test-secret', { u, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: t.store.getUser(u)!.token_version })}`
    const H = { Authorization: tok(t.dr), 'Content-Type': 'application/json' }
    const base = `/api/patients/${t.p.id}/imaging`
    const got = await app.request(`${base}/studies/${t.cur.id}/followup`, { headers: H })
    expect(got.status).toBe(200)
    const v = await got.json() as FollowupView
    expect(v.counts).toMatchObject({ enlarged: 1, new: 1 })
    expect((await app.request(`/api/patients/${t.p.id}/imaging/studies/${t.cur.id}/followup`, { headers: { Authorization: tok(t.other) } })).status).toBe(404)
    const other = t.patients.create(t.a, { sex: 'M', birth_year: 1970 })
    expect((await app.request(`/api/patients/${other.id}/imaging/studies/${t.cur.id}/followup`, { headers: H })).status).toBe(404)

    const link = itemOf(v, t.C1.id).link_id!
    const un = await app.request(`${base}/followup-links/${link}/unlink`, { method: 'POST', headers: H })
    expect(un.status).toBe(200)
    expect(itemOf(await un.json() as FollowupView, t.C1.id).change).toBe('new')
    const re = await app.request(`${base}/studies/${t.cur.id}/followup/links`, { method: 'POST', headers: H, body: JSON.stringify({ lesion_id: t.C1.id, prior_lesion_id: t.P1.id }) })
    expect(re.status).toBe(200)
    expect(itemOf(await re.json() as FollowupView, t.C1.id)).toMatchObject({ change: 'enlarged', source: 'manual' })
    expect((await app.request(`${base}/studies/${t.cur.id}/followup/links`, { method: 'POST', headers: H, body: JSON.stringify({ lesion_id: 'x' }) })).status).toBe(400)
    const rm = await app.request(`${base}/studies/${t.cur.id}/followup/rematch`, { method: 'POST', headers: H })
    expect(rm.status).toBe(202)
    await t.settle()

    process.env.VIEWER_HOST = 'viewer.test'
    process.env.VIEWER_URL = 'http://ohif:8080'
    try {
      const url = (await (await app.request('/api/imaging/viewer-ticket', { method: 'POST', headers: H, body: JSON.stringify({ study_uid: CUR }) })).json() as { url: string }).url
      const cookie = (await app.request(url)).headers.get('set-cookie')!.split(';')[0]!
      const V = 'http://viewer.test'
      const vg = await app.request(`${V}/api/viewer/followup?StudyInstanceUID=${CUR}`, { headers: { Cookie: cookie } })
      expect(vg.status).toBe(200)
      const vv = await vg.json() as FollowupView
      expect(itemOf(vv, t.C1.id)).toMatchObject({ prior_lesion: { label: '结节 1' } })
      // 前片没在这张 Cookie 里：不能按前片的 UID 读
      expect((await app.request(`${V}/api/viewer/followup?StudyInstanceUID=${PRIOR}`, { headers: { Cookie: cookie } })).status).toBe(404)
      const post = (path: string, body: unknown, extra: Record<string, string> = { 'X-Heurion-Viewer': '1' }) =>
        app.request(`${V}${path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
      const l1 = itemOf(vv, t.C1.id).link_id!
      expect((await post(`/api/viewer/followup/links/${l1}/unlink`, {}, {})).status).toBe(403)
      expect((await post(`/api/viewer/followup/links/${l1}/unlink`, {})).status).toBe(200)
      expect((await post('/api/viewer/followup/links', { study_uid: CUR, lesion_id: t.C1.id, prior_lesion_id: t.P1.id })).status).toBe(200)
      expect((await post('/api/viewer/followup/links', { study_uid: PRIOR, lesion_id: t.C1.id, prior_lesion_id: t.P1.id })).status).toBe(404)
      expect((await post('/api/viewer/followup/rematch', { study_uid: CUR })).status).toBe(202)
      await t.settle()
      expect((await app.request(`${V}/api/viewer/followup?StudyInstanceUID=${CUR}`)).status).toBe(401)
      // 主站上没有阅片器接口
      expect((await app.request('/api/viewer/followup?StudyInstanceUID=' + CUR, { headers: H })).status).toBe(404)
    } finally {
      delete process.env.VIEWER_HOST
      delete process.env.VIEWER_URL
    }

    // MCP：AI 只读
    const server = new McpServer({ name: 't', version: '0' })
    registerImagingFollowupTools(server, { claims: { u: t.dr, d: '*', p: ['read'], aud: 'mcp' } as never, patients: t.patients, followup: t.followup })
    const [x, y] = InMemoryTransport.createLinkedPair()
    await server.connect(x)
    const client = new Client({ name: 't', version: '0' })
    await client.connect(y)
    const r = await client.callTool({ name: 'imaging_followup', arguments: { patient_id: t.p.id, imaging_study_id: t.cur.id } })
    const out = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as FollowupView
    expect(out.counts).toMatchObject({ enlarged: 1, stable: 1, new: 1, disappeared: 1 })
    expect(JSON.stringify(out)).not.toContain(CUR)
    const bad = await client.callTool({ name: 'imaging_followup', arguments: { patient_id: other.id, imaging_study_id: t.cur.id } })
    expect(bad.isError).toBe(true)
  })
})
