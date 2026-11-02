import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { FindingsDraftService } from '../src/imaging/findings-draft.ts'
import { ImagingFollowup } from '../src/imaging/followup.ts'
import { ImagingPipeline } from '../src/imaging/pipeline.ts'
import { ImagingReviewService } from '../src/imaging/review.ts'
import { ImagingStudyService } from '../src/imaging/studies.ts'
import { MeasurementService } from '../src/measurements/service.ts'
import { plainText } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import { FakeOrthanc, fakeWorker, seriesFiles } from './imaging-fakes.ts'

/**
 * 所见草稿 × 随访对比（T2.6 × T2.4）：按变化选句（新发 / 增大 / 稳定 / 消失 / 待核对）；随访派生数字（Δ平均径、Δ体积率、VDT）
 * 也是测量原子（imaging_followup 来源），医生重测后随之更新；前片定稿与否的比较说明；变化分类改变后核对提示。
 */

const PRIOR = '1.2.840.113619.2.55.3.8001'
const CUR = '1.2.840.113619.2.55.3.8002'
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
interface Nod { c: number[]; d: number; v: number | null; lobe: string }
function result(nods: Nod[]) {
  return {
    model_id: 'lung_nodule_pipeline', model_version: 'test', device: 'cpu', elapsed_ms: 10,
    series_qc: { spacing_mm: [1.25, 0.7, 0.7], lung_anchor: { ok: true, centroid_lps_mm: [0, 0, 0], apex_z_mm: 120, apex_in_fov: true } },
    nodules: nods.map((n, i) => ({
      index: i + 1, detection_score: 0.9, center_vox_zyx: [10 * i, 100, 100], box_vox_zyx: [0, 0, 0, 1, 1, 1], lobe: n.lobe, segmentation: 'vista3d', key_slice_z: 10 * i,
      center_lps_mm: n.c, box_lps_mm: null, key_slice_sop_instance_uid: `1.2.3.${i}`,
      metrics: { long_axis_mm: n.d, short_axis_mm: n.d, mean_diameter_mm: n.d, volume_mm3: n.v }, warnings: [],
    })),
    warnings: [],
  }
}
/** 假配准：最近邻 10 mm 以内成对 */
function match(body: { prior: { nodules: Array<{ id: string; center_lps_mm: number[] }> }; current: { nodules: Array<{ id: string; center_lps_mm: number[] }> }; fixed_pairs: string[][] }, quality: 'fine' | 'coarse') {
  const pairs: Array<Record<string, unknown>> = [], usedC = new Set<string>(), usedP = new Set<string>()
  for (const p of body.prior.nodules) {
    const c = body.current.nodules.find(c => !usedC.has(c.id) && Math.hypot(...c.center_lps_mm.map((v, i) => v - p.center_lps_mm[i]!)) <= 10)
    if (c) { usedC.add(c.id); usedP.add(p.id); pairs.push({ prior_id: p.id, current_id: c.id, distance_mm: 1, gate_mm: 12, lobe_match: true, ambiguous: false, alternatives_prior: [], alternatives_current: [] }) }
  }
  return {
    registration: { quality, reliable: quality === 'fine', translation_mm: [0, 0, 0], inliers: pairs.length, notes: [] }, pairs, fixed: [],
    unmatched_prior: body.prior.nodules.filter(p => !usedP.has(p.id)).map(p => p.id), unmatched_current: body.current.nodules.filter(c => !usedC.has(c.id)).map(c => c.id), skipped: [],
  }
}
const PRIOR_NODS: Nod[] = [
  { c: [-43, 37, 108], d: 8.2, v: 288.4, lobe: 'RUL' },   // → 增大
  { c: [60, 10, 50], d: 6.0, v: 113, lobe: 'LUL' },       // → 稳定（误差内）
  { c: [-20, -30, 0], d: 5.0, v: 65, lobe: 'RLL' },       // → 消失
]
const CUR_NODS: Nod[] = [
  { c: [30, -40, -60], d: 4.0, v: 33, lobe: 'LLL' },       // 新发（先建，验证排序按肺叶）
  { c: [-42, 37, 109], d: 10.5, v: 600, lobe: 'RUL' },
  { c: [60, 11, 50], d: 6.3, v: 120, lobe: 'LUL' },
]

async function env(quality: 'fine' | 'coarse' = 'fine') {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-draft-fu-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const admin = store.createUser({ username: 'admin_li', display_name: '李主任', password_hash: 'x', tenant: { id: hosp.id, role: 'admin' } }).id
  const dr = store.createUser({ username: 'dr_wang', display_name: '王医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const rev = store.createUser({ username: 'dr_chen', display_name: '陈主任', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const orthanc = new FakeOrthanc()
  orthanc.studyDates.set(PRIOR, '2025-10-20')
  orthanc.studyDates.set(CUR, '2026-10-20')
  const svc = new ImagingStudyService(patients, orthanc)
  const A: Actor = { userId: dr, via: 'user' }
  const review = new ImagingReviewService(patients)
  review.setReadingRole({ userId: admin, via: 'user' }, rev, 'reviewer', (u, tid) => store.getUser(u)?.tenant_id === tid)
  const results = new Map<string, unknown>([[PRIOR, result(PRIOR_NODS)], [CUR, result(CUR_NODS)]])
  const uidOf = (studyId: string) => [PRIOR, CUR].find(u => svc.resolveStudyUid(A, u).studyId === studyId)!
  const worker = fakeWorker(async (path, init) => {
    if (path === '/api/v1/pipeline/lung-nodule') return ok(results.get(uidOf(svc.runSource(A, (JSON.parse(init.body as string).volume_id as string).replace(/^run_/, '')).run.study_id)))
    if (path === '/api/v1/pipeline/lung-nodule/match') return ok(match(JSON.parse(init.body as string), quality))
    return ok({ ok: true })
  })
  const followup = new ImagingFollowup(patients, orthanc, 'http://worker:8004', { fetch: worker.fetchImpl })
  const pipeline = new ImagingPipeline(svc, orthanc, 'http://worker:8004', { fetch: worker.fetchImpl, onRunDone: (x, run) => followup.onAnalysisDone(x, run) })
  const settle = async () => { for (let i = 0; i < 5; i++) { await pipeline.idle(); await followup.idle() } }
  const p = patients.create(A, { sex: 'F', birth_year: 1961 })
  patients.addMember(A, p.id, rev)
  const prior = (await svc.importDicom(A, p.id, seriesFiles(PRIOR, `${PRIOR}.2`, 40))).studies[0]!
  const cur = (await svc.importDicom(A, p.id, seriesFiles(CUR, `${CUR}.2`, 40))).studies[0]!
  pipeline.enqueue(A, prior.id)
  await settle()
  for (const l of svc.listLesions(A, prior.id)) svc.reviewLesion(A, l.id, { status: 'confirmed' })
  pipeline.enqueue(A, cur.id)
  await settle()
  const byLabel = (studyId: string, label: string) => svc.listLesions(A, studyId).find(l => l.label === label)!
  const C = { new: byLabel(cur.id, '结节 1'), up: byLabel(cur.id, '结节 2'), same: byLabel(cur.id, '结节 3') }
  for (const l of Object.values(C)) svc.reviewLesion(A, l.id, { status: 'confirmed' })
  const drafts = new FindingsDraftService(store, docs, ops, patients, { followup })
  const shown = (docId: string, viewer: Actor = A) => {
    const views = new MeasurementService(store, patients).views(store.getDoc(docId)!, viewer)
    const out: string[] = []
    docs.get(docId).forEach(n => out.push(plainText(n).replace(/\[@m:([a-z0-9]+)\]/g, (_, id) => views.get(id)?.text ?? '??')))
    return out
  }
  return { store, docs, ops, patients, svc, review, followup, pipeline, settle, drafts, A, rev, admin, p, prior, cur, C, shown }
}

describe('所见草稿 × 随访对比', () => {
  it('按变化选句；随访差值与 VDT 是 imaging_followup 测量原子；前片未定稿时注明；前片消失的结节单独一句', async () => {
    const t = await env()
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.cur.id }, { turnId: null })
    expect(t.shown(r.doc_id).slice(2)).toEqual([
      '与 2025-10-20 片比较（前片尚未定稿，按其已确认的结节对比）。',
      '1. 右肺上叶结节，平均径 10.5 mm，体积 600 mm³，较前增大，平均径变化 +2.3 mm，体积变化 +108%，体积倍增时间约 345 天。',
      '2. 左肺上叶结节，平均径 6.3 mm，体积 120 mm³，与前片相仿（变化在测量误差范围内）。',
      '3. 左肺下叶见结节，平均径 4.0 mm，体积 33 mm³，为新发结节。',
      '前片右肺下叶结节本次未见显示。',
    ])
    const rows = t.store.listMeasurements(r.doc_id)
    expect(rows.filter(m => m.source_kind === 'imaging_followup').map(m => [m.source_id, m.field]).sort()).toEqual([
      [t.C.up.id, 'delta_mean_diameter_mm'], [t.C.up.id, 'delta_volume_pct'], [t.C.up.id, 'vdt_days'],
    ].sort())
    // 稳定的结节：误差内，VDT 不写（不可靠）；新发的没有差值
    expect(rows.some(m => m.source_kind === 'imaging_followup' && (m.source_id === t.C.same.id || m.source_id === t.C.new.id))).toBe(false)
    expect(r.warnings).toContain('前片（2025-10-20）尚未定稿：随访对比按前片已确认的结节')
    const draft = t.drafts.getDraft(r.doc_id)!
    expect(draft).toMatchObject({ prior_study_id: t.prior.id, prior_reference: 'confirmed' })
    expect(draft.blocks.filter(b => b.lesion_id).map(b => b.case)).toEqual(['enlarged', 'stable', 'new'])
  })

  it('医生重测后：草稿里的病灶测量与随访差值、VDT 都随之更新；分类变了时核对提示', async () => {
    const t = await env()
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.cur.id }, { turnId: null })
    t.svc.editLesion(t.A, t.C.up.id, { metrics: { ...t.C.up.metrics, volume_mm3: 700 } })
    expect(t.shown(r.doc_id)[3]).toBe('1. 右肺上叶结节，平均径 10.5 mm，体积 700 mm³，较前增大，平均径变化 +2.3 mm，体积变化 +143%，体积倍增时间约 285 天。')
    const views = new MeasurementService(t.store, t.patients).views(t.store.getDoc(r.doc_id)!, t.A)
    expect([...views.values()].filter(v => v.status === 'updated').length).toBe(3)
    // 稳定的结节被重测成明显增大：分类变了 → 核对提示（数字已随来源更新，但「与前片相仿」这句话要人改或重新生成）
    t.svc.editLesion(t.A, t.C.same.id, { metrics: { ...t.C.same.metrics, volume_mm3: 300 } })
    const chk = t.drafts.check(t.A, t.store.getDoc(r.doc_id)!, new MeasurementService(t.store, t.patients).views(t.store.getDoc(r.doc_id)!, t.A))
    expect(chk.issues.find(i => i.code === 'change_changed')?.message).toContain('稳定 → 增大')
    // 重新生成（块没人改过）：句子换成增大
    const u = t.drafts.generate(t.A, t.p.id, { study_id: t.cur.id, doc_id: r.doc_id }, { turnId: null })
    expect(u.blocks.written).toEqual([`nodule:${t.C.same.id}`])
    expect(t.shown(r.doc_id)[4]).toMatch(/^2\. 左肺上叶结节，平均径 6\.3 mm，体积 300 mm³，较前增大，平均径变化 \+0\.3 mm，体积变化 \+166%，体积倍增时间约 259 天。$/)
  })

  it('本次结节在草稿生成后被否决：病灶测量与随访差值都标为失效，核对拦下（block）', async () => {
    const t = await env()
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.cur.id }, { turnId: null })
    t.svc.reviewLesion(t.A, t.C.up.id, { status: 'rejected', reason: '伪影' })
    const row = t.store.getDoc(r.doc_id)!
    const ris = t.drafts.risText(t.A, row, new MeasurementService(t.store, t.patients).views(row, t.A))
    expect(ris.text).toContain('10.5 mm〔来源病灶已被否决〕')
    expect(ris.text).toContain('+2.3 mm〔来源病灶已被否决〕')
    expect(ris.issues.filter(i => i.severity === 'block').map(i => i.code)).toEqual(expect.arrayContaining(['measurement_invalid', 'nodule_removed']))
  })

  it('前片定稿后：比较说明写间隔；草稿记下前片按定稿快照对比', async () => {
    const t = await env()
    t.review.submitRead(t.A, t.prior.id)
    const V: Actor = { userId: t.rev, via: 'user' }
    t.review.finalize(V, t.prior.id, { expected_revision: t.review.view(V, t.prior.id).revision })
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.cur.id }, { turnId: null })
    expect(t.shown(r.doc_id)[2]).toBe('与 2025-10-20 片比较（间隔 365 天）。')
    expect(t.drafts.getDraft(r.doc_id)!.prior_reference).toBe('finalized')
  })

  it('随访有「需核对」项（配准不可靠）：不写变化结论，改用「对应关系待核对」并提示', async () => {
    const t = await env('coarse')
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.cur.id }, { turnId: null })
    const lines = t.shown(r.doc_id)
    expect(lines[3]).toBe('1. 右肺上叶见结节，平均径 10.5 mm，体积 600 mm³；与前片的对应关系待核对。')
    expect(lines.join('\n')).not.toMatch(/较前增大|相仿/)
    expect(t.store.listMeasurements(r.doc_id).some(m => m.source_kind === 'imaging_followup')).toBe(false)
    expect(r.warnings.some(w => w.includes('随访对应需医生核对'))).toBe(true)
    const chk = t.drafts.check(t.A, t.store.getDoc(r.doc_id)!, new Map())
    expect(chk.issues.some(i => i.code === 'followup_review')).toBe(true)
  })

  it('随访派生测量的绑定规则：只给已确认、成对的结节；新发结节没有差值（measurement_field_missing）', async () => {
    const t = await env()
    const doc = t.docs.create({ owner: t.A.userId, title: 'x' })
    const ms = new MeasurementService(t.store, t.patients)
    expect(ms.bind(t.A, t.store.getDoc(doc.id)!, { source: 'imaging_followup', source_id: t.C.up.id, field: 'delta_volume_pct', unit: 'pct' }).view.text).toBe('+108%')
    expect(() => ms.bind(t.A, t.store.getDoc(doc.id)!, { source: 'imaging_followup', source_id: t.C.new.id, field: 'delta_volume_pct', unit: 'pct' })).toThrow(expect.objectContaining({ code: 'measurement_field_missing' }))
    expect(() => ms.bind(t.A, t.store.getDoc(doc.id)!, { source: 'imaging_followup', source_id: t.C.up.id, field: 'vdt_days', unit: 'mm' })).toThrow(expect.objectContaining({ code: 'measurement_unit_invalid' }))
    expect(() => ms.bind(t.A, t.store.getDoc(doc.id)!, { source: 'imaging_followup', source_id: t.C.up.id, field: 'mean_diameter_mm' })).toThrow(expect.objectContaining({ code: 'measurement_field_unknown' }))
  })
})
