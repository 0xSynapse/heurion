import { randomUUID } from 'node:crypto'
import { PatientError, type Actor, type ImagingScope, type PatientService } from '../tenancy/patients.ts'
import { orthancFromEnv, type Orthanc } from './orthanc.ts'
import { ImagingError, type LesionRow, type LesionStatus, type RunRow } from './studies.ts'
import { ensureReviewSchema, type SnapshotLesion } from './review.ts'
import { callWorker, uploadSeries } from './worker.ts'

/**
 * 随访对比（PRD T2.4 / W3，docs/design/IMAGING_STUDIES.md「随访对比（T2.4）」）。
 *
 * - 找前片：同一患者、检查日期更早的最近一次有参照病灶的胸部 CT。参照病灶 = 随访库（priorLesions）：前片定稿过时取最近一次
 *   定稿快照里已确认的结节与签字时的测量（PRD W5.2「定稿后的结节与测量进入随访库」）；没定稿过时退回已确认的结节。
 * - 匹配：本次分析完成后自动排一次（影子运行不触发、影子病灶不参与）；医生可重新匹配。配准与指派在 worker
 *   （POST /api/v1/pipeline/lung-nodule/match），平台只给坐标、大小、肺叶与肺部锚点。
 * - 变化：新发 / 消失 / 增大 / 缩小 / 稳定；差值小于测量重复性误差时标「在误差范围内」；VDT 只在体积增大时给出。
 *   变化在读取时按两侧病灶的当前测量重新计算（医生修边界后随之更新），链接里另存匹配当时的快照。
 * - 医生可拆开或重新对应：链接与留痕在 imaging_lesion_links / imaging_link_events；医生的对应关系在重新匹配时保留，
 *   并作为已知对应参与配准。AI 只能读（服务层拒绝 via = ai 的写操作）。
 */

export type ChangeKind = 'new' | 'disappeared' | 'enlarged' | 'shrunk' | 'stable'

/**
 * 测量重复性误差（小于此值的变化标为「在误差范围内」，分类为稳定）。依据见设计文档：
 * - 体积 ±25%：BTS 2015 肺结节指南以体积变化 ≥ 25% 为有意义的生长；Fleischner 学会 2017 测量声明指出不同扫描间的体积测量差异可达约 25%。
 * - 平均径 1.5 mm：Lung-RADS v2022 以平均径增大 > 1.5 mm 定义「生长」（Fleischner 2017 认为 < 2 mm 的径线变化不能可靠判断）。
 * 本平台 AI 分割的重复性尚未在本机构数据上实测，这两个值是临时取值，可用环境变量调整。
 */
export function tolerance(): { volume_pct: number; mean_diameter_mm: number } {
  const v = Number(process.env.IMAGING_FOLLOWUP_VOLUME_TOL_PCT), d = Number(process.env.IMAGING_FOLLOWUP_DIAMETER_TOL_MM)
  return { volume_pct: Number.isFinite(v) && v > 0 ? v : 25, mean_diameter_mm: Number.isFinite(d) && d > 0 ? d : 1.5 }
}
export const TOLERANCE_SOURCE = '体积 ±25%（BTS 2015；Fleischner 2017 测量声明）；平均径 1.5 mm（Lung-RADS v2022 生长定义）。临时取值，未在本机构数据上实测'

/** 随访对比只做肺结节 */
const KIND = 'lung_nodule'
const TASK = 'lung_nodule'

/**
 * 参与对比的病灶。prior = 前片没定稿过时的参照病灶（已确认；定稿过的前片一律取定稿快照，见 priorLesions），current = 本次参与对比的病灶
 * （待确认与已确认：本次分析刚完成、医生还没审核时也要能看到对比）。影子运行的病灶一律不参与。
 */
export interface ReferencePolicy { prior: LesionStatus[]; current: LesionStatus[] }
export const DEFAULT_REFERENCE: ReferencePolicy = { prior: ['confirmed'], current: ['proposed', 'confirmed'] }

export interface ChangeMetrics {
  change: Exclude<ChangeKind, 'new' | 'disappeared'>
  /** 分类依据：两期都有体积时按体积（更敏感，BTS 2015），否则按平均径 */
  basis: 'volume' | 'diameter' | null
  within_error: boolean
  interval_days: number | null
  prior_mean_diameter_mm: number | null
  current_mean_diameter_mm: number | null
  delta_mean_diameter_mm: number | null
  prior_volume_mm3: number | null
  current_volume_mm3: number | null
  delta_volume_mm3: number | null
  delta_volume_pct: number | null
  /** 体积倍增时间（Schwartz）：只在两期都有体积、间隔 > 0 天且体积增大时给出 */
  vdt_days: number | null
  vdt_note: string | null
  notes: string[]
}

const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
const r1 = (v: number) => Math.round(v * 10) / 10
/** 可用于比较的体积：有数值、> 0、分割没有失败（失败时测量取检出框径，没有体积） */
const volumeOf = (m: Record<string, unknown>) => { const v = num(m.volume_mm3); return v !== null && v > 0 && m.segmentation !== 'failed' ? v : null }

/** 一对结节的变化（纯函数；阈值取 tolerance()） */
export function classifyChange(prior: Record<string, unknown>, current: Record<string, unknown>, intervalDays: number | null, tol = tolerance()): ChangeMetrics {
  const d1 = num(prior.mean_diameter_mm), d2 = num(current.mean_diameter_mm)
  const v1 = volumeOf(prior), v2 = volumeOf(current)
  const dd = d1 !== null && d2 !== null ? r1(d2 - d1) : null
  const dv = v1 !== null && v2 !== null ? r1(v2 - v1) : null
  const pct = v1 !== null && v2 !== null ? r1((v2 - v1) / v1 * 100) : null
  const notes: string[] = []
  let change: ChangeMetrics['change'] = 'stable', basis: ChangeMetrics['basis'] = null, within = true
  if (pct !== null) {
    basis = 'volume'
    within = Math.abs(pct) < tol.volume_pct
    change = within ? 'stable' : pct > 0 ? 'enlarged' : 'shrunk'
    // 体积与径线方向相反且都超出误差：多半是分割问题，提示核对
    if (!within && dd !== null && Math.abs(dd) > tol.mean_diameter_mm && Math.sign(dd) !== Math.sign(pct)) notes.push('体积与平均径的变化方向相反，请核对分割')
  } else if (dd !== null) {
    basis = 'diameter'
    within = Math.abs(dd) <= tol.mean_diameter_mm
    change = within ? 'stable' : dd > 0 ? 'enlarged' : 'shrunk'
    notes.push('至少一期没有体积（分割失败或未测），按平均径判断')
  } else {
    notes.push('两期缺少可比较的测量，无法判断大小变化')
  }

  let vdt: number | null = null, vdtNote: string | null = null
  if (v1 === null || v2 === null) vdtNote = '缺少两期体积，不计算倍增时间'
  else if (intervalDays === null || intervalDays <= 0) vdtNote = '两期间隔未知或为 0 天，不计算倍增时间'
  else if (v2 <= v1) vdtNote = v2 === v1 ? '体积无变化，倍增时间不适用' : '体积缩小，倍增时间不适用'
  else {
    vdt = Math.round(intervalDays * Math.LN2 / Math.log(v2 / v1))
    if (within) vdtNote = '体积变化在测量误差范围内，倍增时间不可靠'
  }
  return {
    change, basis, within_error: basis !== null && within, interval_days: intervalDays,
    prior_mean_diameter_mm: d1, current_mean_diameter_mm: d2, delta_mean_diameter_mm: dd,
    prior_volume_mm3: v1, current_volume_mm3: v2, delta_volume_mm3: dv, delta_volume_pct: pct,
    vdt_days: vdt, vdt_note: vdtNote, notes,
  }
}

/** 两个 YYYY-MM-DD 之间的天数；任一缺失为 null */
export function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const x = Date.parse(`${a}T00:00:00Z`), y = Date.parse(`${b}T00:00:00Z`)
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86_400_000) : null
}

export interface FollowupRow {
  id: string
  study_id: string
  prior_study_id: string | null
  trigger_kind: 'auto' | 'manual'
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  reason: string | null
  error: string | null
  summary: Record<string, unknown> | null
  created_by: string
  via: string
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface LinkRow {
  id: string
  study_id: string
  prior_study_id: string
  lesion_id: string | null
  prior_lesion_id: string | null
  followup_id: string | null
  source: 'ai' | 'manual'
  status: 'active' | 'superseded'
  change: ChangeKind | null
  metrics: Record<string, unknown>
  created_by: string
  created_at: string
  updated_at: string
}

interface LesionBrief { id: string; label: string | null; location: string | null; status: LesionStatus; source: string; mean_diameter_mm: number | null; volume_mm3: number | null; key_slice_sop_instance_uid: string | null }

export interface FollowupItem {
  /** 当前起作用的链接；null = 还没有对比过（匹配之后新增或新确认的结节） */
  link_id: string | null
  lesion_id: string | null
  prior_lesion_id: string | null
  lesion: LesionBrief | null
  prior_lesion: LesionBrief | null
  /** null = 未参与对比 */
  change: ChangeKind | null
  /** ai = 自动匹配；manual = 医生对应 */
  source: 'ai' | 'manual' | null
  metrics: ChangeMetrics | null
  match: { distance_mm: number | null; ambiguous: boolean; alternatives_prior: string[]; alternatives_current: string[]; lobe_match: boolean | null } | null
  /** 需要医生核对：配准不可靠、有歧义候选、肺叶不一致、测量方向矛盾或对应的病灶已被否决 */
  needs_review: boolean
  notes: string[]
}

export interface FollowupView {
  study_id: string
  study_date: string | null
  prior: { study_id: string; study_date: string | null; interval_days: number | null; reference: PriorReference['basis']; signoff_version: number | null } | null
  /** 最近一次匹配（interrupted = 服务重启时还没完成） */
  run: (Omit<FollowupRow, 'status'> & { status: FollowupRow['status'] | 'interrupted' }) | null
  registration: Record<string, unknown> | null
  tolerance: { volume_pct: number; mean_diameter_mm: number; source: string }
  items: FollowupItem[]
  counts: Record<ChangeKind | 'pending', number>
}

/** 前片的参照病灶从哪来：finalized = 最近一次定稿快照；confirmed = 前片没定稿过，用已确认的结节 */
export interface PriorReference { lesions: LesionRow[]; basis: 'finalized' | 'confirmed'; signoff_version: number | null }

const now = () => new Date().toISOString()
const rid = (p: string) => p + randomUUID().replace(/-/g, '').slice(0, 12)
const lesionOf = (r: Record<string, unknown>): LesionRow => ({ ...(r as unknown as LesionRow), metrics: JSON.parse((r.metrics as string) || '{}') })
const linkOf = (r: Record<string, unknown>): LinkRow => ({ ...(r as unknown as LinkRow), metrics: JSON.parse((r.metrics as string) || '{}') })
const followupOf = (r: Record<string, unknown>): FollowupRow => ({ ...(r as unknown as FollowupRow), summary: r.summary ? JSON.parse(r.summary as string) : null })
const brief = (l: LesionRow): LesionBrief => ({
  id: l.id, label: l.label, location: l.location, status: l.status, source: l.source,
  mean_diameter_mm: num(l.metrics.mean_diameter_mm), volume_mm3: volumeOf(l.metrics), key_slice_sop_instance_uid: (l.metrics.key_slice_sop_instance_uid as string | null | undefined) ?? null,
})

/** worker /api/v1/pipeline/lung-nodule/match 的响应（apps/imaging-worker/src/nodule_matching.py） */
interface MatchResult {
  registration: Record<string, unknown> & { quality: 'fine' | 'coarse' | 'none'; reliable: boolean; notes?: string[] }
  pairs: Array<{ prior_id: string; current_id: string; distance_mm: number; gate_mm: number; lobe_match: boolean | null; ambiguous: boolean; alternatives_prior: string[]; alternatives_current: string[] }>
  fixed: Array<{ prior_id: string; current_id: string; distance_mm: number }>
  unmatched_prior: string[]
  unmatched_current: string[]
  skipped: Array<{ id: string; side: string; reason: string }>
}

const shared = new WeakMap<PatientService, ImagingFollowup>()

/** 进程内共用（自动匹配的去重、并发合并在这里） */
export function sharedFollowup(patients: PatientService, orthanc: Orthanc | null = orthancFromEnv()): ImagingFollowup {
  let f = shared.get(patients)
  if (!f) {
    f = new ImagingFollowup(patients, orthanc, process.env.IMAGING_WORKER_URL || 'http://127.0.0.1:8004')
    shared.set(patients, f)
  }
  return f
}

export class ImagingFollowup {
  /** 正在匹配的检查：同一检查的重复触发合并为「当前这次完成后再跑一次」 */
  private inflight = new Map<string, { row: FollowupRow; again: { a: Actor; trigger: FollowupRow['trigger_kind'] } | null; done: Promise<void> }>()
  /** 前片还没分析时用它排队分析（预计算，W3.1）；由流水线挂上 */
  private analyzer: ((a: Actor, studyId: string) => unknown) | null = null
  /** 因预计算而排队分析的前片：它们分析完成后的匹配不再往更早追溯（只预计算最近一期，不连锁分析全部历史） */
  private precomputed = new Set<string>()

  constructor(
    private readonly patients: PatientService,
    private readonly orthanc: Orthanc | null,
    private readonly workerUrl: string,
    private readonly opts: { fetch?: typeof fetch; reference?: ReferencePolicy } = {},
  ) {
    this.workerUrl = workerUrl.replace(/\/+$/, '')
  }

  private get fetch(): typeof fetch { return this.opts.fetch ?? fetch }
  private get reference(): ReferencePolicy { return this.opts.reference ?? DEFAULT_REFERENCE }

  attachAnalyzer(fn: (a: Actor, studyId: string) => unknown): this { this.analyzer = fn; return this }

  /** 等所有匹配完成（测试用） */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight.values()].map(x => x.done))
  }

  // —— 权限与查找 ——

  private studyScope(a: Actor, studyId: string, need: 'read' | 'write'): ImagingScope {
    const row = this.patients.imagingLookup(a).db.prepare('SELECT patient_id FROM imaging_studies WHERE id = ?').get(studyId) as { patient_id: string } | undefined
    if (!row) throw new PatientError('not_found', '影像检查不存在', 404)
    return this.patients.imagingScope(a, row.patient_id, need)
  }

  /** 检查所属患者（路由校验路径里的患者 id 用） */
  studyPatient(a: Actor, studyId: string): string {
    return this.studyScope(a, studyId, 'read').patientId
  }

  /** 阅片器用：StudyInstanceUID → 检查 id（找不到或看不到都当不存在） */
  studyIdByUid(a: Actor, studyUid: string): string {
    const l = this.patients.imagingLookup(a)
    const row = l.db.prepare('SELECT id FROM imaging_studies WHERE uid_hmac = ?').get(l.uidKey('study', studyUid)) as { id: string } | undefined
    if (!row) throw new PatientError('not_found', '影像检查不存在', 404)
    this.studyScope(a, row.id, 'read')
    return row.id
  }

  /** 链接所属检查（阅片器校验 Cookie 允许的检查、主站校验患者用） */
  linkStudy(a: Actor, linkId: string): { studyId: string; patientId: string; studyUid: string } {
    const row = this.patients.imagingLookup(a).db.prepare('SELECT study_id FROM imaging_lesion_links WHERE id = ?').get(linkId) as { study_id: string } | undefined
    if (!row) throw new PatientError('not_found', '对应关系不存在', 404)
    const s = this.studyScope(a, row.study_id, 'read')
    const st = s.db.prepare('SELECT uid_enc FROM imaging_studies WHERE id = ?').get(row.study_id) as { uid_enc: string }
    return { studyId: row.study_id, patientId: s.patientId, studyUid: s.decrypt(st.uid_enc)! }
  }

  /** 可见（非影子）、某些状态的肺结节 */
  private lesions(s: ImagingScope, studyId: string, statuses: LesionStatus[]): LesionRow[] {
    if (!statuses.length) return []
    return (s.db.prepare(`SELECT l.* FROM imaging_lesions l LEFT JOIN imaging_runs r ON r.id = l.run_id
      WHERE l.study_id = ? AND l.kind = ? AND l.status IN (${statuses.map(() => '?').join(', ')}) AND (r.id IS NULL OR r.visibility = 'visible')
      ORDER BY l.created_at, l.rowid`).all(studyId, KIND, ...statuses) as Array<Record<string, unknown>>).map(lesionOf)
  }

  /** 按 id 取病灶（含影子判断）；不存在或是影子检出时为 null */
  private lesionById(s: ImagingScope, id: string): LesionRow | null {
    const r = s.db.prepare(`SELECT l.*, r.visibility AS _vis FROM imaging_lesions l LEFT JOIN imaging_runs r ON r.id = l.run_id WHERE l.id = ?`).get(id) as (Record<string, unknown> & { _vis: string | null }) | undefined
    if (!r || r._vis === 'shadow') return null
    const { _vis, ...rest } = r
    void _vis
    return lesionOf(rest)
  }

  /**
   * 前片的参照病灶（随访库）。前片定稿过时取最近一次定稿快照里已确认的肺结节，测量、位置、名称、版本都用签字时的值：
   * 定稿后又改、尚未再次定稿的不算，被撤销的仍按签过的值参与。定稿为「未见结节」时为空（本次的结节都是新发）。
   * 没定稿过时退回 reference.prior（已确认）。影子检出不会进入定稿快照，也不会被 lesions() 取到。
   */
  priorLesions(s: ImagingScope, studyId: string): PriorReference {
    ensureReviewSchema(s.db)
    const so = s.db.prepare('SELECT version, snapshot FROM imaging_signoffs WHERE study_id = ? ORDER BY version DESC LIMIT 1').get(studyId) as { version: number; snapshot: string } | undefined
    if (!so) return { lesions: this.lesions(s, studyId, this.reference.prior), basis: 'confirmed', signoff_version: null }
    const out: LesionRow[] = []
    for (const x of JSON.parse(so.snapshot) as SnapshotLesion[]) {
      if (x.status !== 'confirmed' || x.kind !== KIND) continue
      const l = this.lesionById(s, x.id)
      if (!l || l.study_id !== studyId) continue
      out.push({ ...l, status: 'confirmed', version: x.version, label: x.label, location: x.location, metrics: x.metrics, seg_ref: x.seg_ref })
    }
    return { lesions: out, basis: 'finalized', signoff_version: so.version }
  }

  private study(s: ImagingScope, id: string): { id: string; patient_id: string; study_date: string | null; modalities: string[]; created_at: string } | null {
    const r = s.db.prepare('SELECT id, patient_id, study_date, modalities, created_at FROM imaging_studies WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? { id: r.id as string, patient_id: r.patient_id as string, study_date: (r.study_date as string | null) ?? null, modalities: JSON.parse((r.modalities as string) || '[]'), created_at: r.created_at as string } : null
  }

  /**
   * 前片：同一患者、检查日期严格早于本次的 CT，从近到远取第一个有参照病灶的。
   * 同一天的检查不作前片（分不清先后、间隔 0 天）；没有检查日期的检查不参与。
   * precompute：最近的更早 CT 还没分析过时返回它的 id，由调用方排队分析（W3.1 预计算）。
   */
  findPrior(s: ImagingScope, studyId: string): { prior: { id: string; study_date: string } | null; reason: string | null; notes: string[]; precompute: string | null } {
    const cur = this.study(s, studyId)
    if (!cur) throw new PatientError('not_found', '影像检查不存在', 404)
    const notes: string[] = []
    if (!cur.study_date) return { prior: null, reason: '本次检查没有检查日期（DICOM StudyDate），无法确定前片', notes, precompute: null }
    const others = (s.db.prepare('SELECT id FROM imaging_studies WHERE patient_id = ? AND id != ?').all(cur.patient_id, studyId) as Array<{ id: string }>)
      .map(r => this.study(s, r.id)!).filter(o => o.modalities.includes('CT'))
    const sameDay = others.filter(o => o.study_date === cur.study_date)
    if (sameDay.length) notes.push(`同一天另有 ${sameDay.length} 个 CT 检查，不作为前片（分不清先后，间隔 0 天）`)
    const undated = others.filter(o => !o.study_date)
    if (undated.length) notes.push(`${undated.length} 个 CT 检查没有检查日期，未参与前片检索`)
    const earlier = others.filter(o => o.study_date && o.study_date < cur.study_date!)
      .sort((x, y) => x.study_date! < y.study_date! ? 1 : x.study_date! > y.study_date! ? -1 : y.created_at.localeCompare(x.created_at))
    if (!earlier.length) return { prior: null, reason: '没有更早的 CT 检查', notes, precompute: null }
    let precompute: string | null = null
    for (const [i, o] of earlier.entries()) {
      // 定稿过的前片即使「未见结节」也是有效的前片（本次的结节都是新发）；没定稿过的要有已确认的结节才算
      const pr = this.priorLesions(s, o.id)
      if (pr.basis === 'finalized' || pr.lesions.length) {
        if (pr.basis === 'confirmed') notes.push(`${o.study_date} 的前片还没有定稿，按已确认的结节对比`)
        return { prior: { id: o.id, study_date: o.study_date! }, reason: null, notes, precompute }
      }
      // 任何可见的分析（含失败的）都算分析过：失败的不自动重排，避免每次匹配都重跑
      const runs = (s.db.prepare(`SELECT status FROM imaging_runs WHERE study_id = ? AND task = ? AND visibility = 'visible'`).all(o.id, TASK) as Array<{ status: string }>).map(r => r.status)
      const proposed = this.lesions(s, o.id, ['proposed']).length
      if (i === 0 && !runs.length) precompute = o.id
      const state = !runs.length ? '还没有分析' : runs.every(x => x === 'failed') ? '分析失败' : runs.some(x => x === 'queued' || x === 'running') && !proposed ? '正在分析'
        : proposed ? `有 ${proposed} 个待确认的 AI 检出、还没有确认的结节` : '没有确认的结节'
      notes.push(`${o.study_date} 的检查${state}，未作为前片`)
    }
    return { prior: null, reason: '更早的 CT 检查都还没有确认的结节；在前片里确认结节后可重新匹配', notes, precompute }
  }

  // —— 排队与执行 ——

  /** 分析流水线完成一次运行后调用：只有可见的肺结节分析才触发（影子模式的运行不参与随访对比） */
  onAnalysisDone(a: Actor, run: RunRow): void {
    if (run.task !== TASK || run.visibility !== 'visible' || run.status !== 'done') return
    try { this.schedule(a, run.study_id, 'auto') } catch { /* 权限变化等：不影响分析本身 */ }
  }

  /**
   * 为检查排一次匹配。manual = 医生在界面上「重新匹配」（AI 不能）；auto = 分析完成后自动。
   * 同一检查正在匹配时不另起，合并为「这次完成后再跑一次」，返回正在进行的那次。
   */
  schedule(a: Actor, studyId: string, trigger: FollowupRow['trigger_kind']): FollowupRow {
    if (trigger === 'manual' && a.via === 'ai') throw new PatientError('needs_human_review', '重新匹配随访对比须由医生在界面上操作', 403)
    const s = this.studyScope(a, studyId, 'write')
    const cur = this.inflight.get(studyId)
    if (cur) { cur.again = { a, trigger }; return cur.row }
    const row = this.insertRun(s, a, studyId, trigger)
    const entry = { row, again: null as { a: Actor; trigger: FollowupRow['trigger_kind'] } | null, done: Promise.resolve() }
    this.inflight.set(studyId, entry)
    entry.done = (async () => {
      let next: { a: Actor; id: string } | null = { a, id: row.id }
      while (next) {
        await this.execute(next.a, next.id).catch(() => {})
        const again: { a: Actor; trigger: FollowupRow['trigger_kind'] } | null = entry.again
        entry.again = null
        next = null
        if (again) {
          try { const r = this.insertRun(this.studyScope(again.a, studyId, 'write'), again.a, studyId, again.trigger); entry.row = r; next = { a: again.a, id: r.id } } catch { /* 权限已变 */ }
        }
      }
    })().finally(() => { this.inflight.delete(studyId) })
    return row
  }

  private insertRun(s: ImagingScope, a: Actor, studyId: string, trigger: FollowupRow['trigger_kind']): FollowupRow {
    const id = rid('fu')
    s.db.prepare(`INSERT INTO imaging_followups (id, study_id, trigger_kind, status, created_by, via, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)`)
      .run(id, studyId, trigger, a.userId, a.via, now())
    return this.runRow(s, id)
  }

  private runRow(s: ImagingScope, id: string): FollowupRow {
    return followupOf(s.db.prepare('SELECT * FROM imaging_followups WHERE id = ?').get(id) as Record<string, unknown>)
  }

  private finish(s: ImagingScope, id: string, status: FollowupRow['status'], extra: { prior?: string | null; reason?: string | null; error?: string | null; summary?: Record<string, unknown> }): void {
    s.db.prepare('UPDATE imaging_followups SET status = ?, prior_study_id = COALESCE(?, prior_study_id), reason = ?, error = ?, summary = ?, finished_at = ? WHERE id = ?')
      .run(status, extra.prior ?? null, extra.reason ?? null, extra.error ?? null, extra.summary ? JSON.stringify(extra.summary) : null, now(), id)
  }

  private async execute(a: Actor, followupId: string): Promise<void> {
    const studyId = (this.patients.imagingLookup(a).db.prepare('SELECT study_id FROM imaging_followups WHERE id = ?').get(followupId) as { study_id: string }).study_id
    const s = this.studyScope(a, studyId, 'write')
    s.db.prepare("UPDATE imaging_followups SET status = 'running', started_at = ? WHERE id = ?").run(now(), followupId)
    try {
      const pick = this.findPrior(s, studyId)
      const chained = this.precomputed.delete(studyId)
      if (pick.precompute && this.analyzer && !chained) {
        try {
          this.precomputed.add(pick.precompute)
          const r = this.analyzer(a, pick.precompute) as { skipped?: string; run?: unknown } | undefined
          if (r?.skipped) this.precomputed.delete(pick.precompute)
          pick.notes.push(r?.skipped ? `最近的前片不能分析：${r.skipped}` : '最近的前片还没有分析，已排队分析；医生确认其中的结节后可重新匹配')
        } catch (err) { this.precomputed.delete(pick.precompute); pick.notes.push(`最近的前片排队分析失败：${err instanceof Error ? err.message : String(err)}`) }
      }
      if (!pick.prior) {
        // 没有前片了（例如前片的结节被否决）：所有现行链接失效
        this.supersedeWhere(s, a, studyId, l => true, 'no_prior')
        this.finish(s, followupId, 'skipped', { reason: pick.reason, summary: { notes: pick.notes } })
        s.log('followup_match', followupId)
        return
      }
      const prior = pick.prior
      this.supersedeWhere(s, a, studyId, l => l.prior_study_id !== prior.id, 'prior_changed')

      const cur = this.lesions(s, studyId, this.reference.current)
      const ref = this.priorLesions(s, prior.id).lesions
      const curIds = new Set(cur.map(l => l.id)), refIds = new Set(ref.map(l => l.id))
      // 医生的对应关系：病灶仍可参与时保留（配对作为已知对应参与配准；单侧的不再自动配对），否则失效
      const manual = this.activeLinks(s, studyId).filter(l => l.source === 'manual')
      const stale = manual.filter(l => (l.lesion_id && !curIds.has(l.lesion_id)) || (l.prior_lesion_id && !refIds.has(l.prior_lesion_id)))
      this.supersedeWhere(s, a, studyId, l => stale.some(x => x.id === l.id), 'invalidate')
      const kept = manual.filter(l => !stale.includes(l))
      const fixedPairs = kept.filter(l => l.lesion_id && l.prior_lesion_id).map(l => [l.prior_lesion_id!, l.lesion_id!] as [string, string])
      const lockedCur = new Set(kept.filter(l => l.lesion_id && !l.prior_lesion_id).map(l => l.lesion_id!))
      const lockedPrior = new Set(kept.filter(l => !l.lesion_id && l.prior_lesion_id).map(l => l.prior_lesion_id!))

      const warnings = [...pick.notes]
      const [curAnchor, priorAnchor] = [await this.anchorFor(s, studyId, cur), await this.anchorFor(s, prior.id, ref)]
      for (const [name, x] of [['本次', curAnchor], ['前片', priorAnchor]] as const) if (x.note) warnings.push(`${name}肺部锚点：${x.note}`)
      const thickness = this.thicknessNote(s, cur, ref)
      if (thickness) warnings.push(thickness)

      const nod = (l: LesionRow) => ({ id: l.id, center_lps_mm: Array.isArray(l.metrics.center_lps_mm) ? l.metrics.center_lps_mm : null, mean_diameter_mm: num(l.metrics.mean_diameter_mm), lobe: l.location })
      const body = {
        prior: { nodules: ref.filter(l => !lockedPrior.has(l.id)).map(nod), anchor: priorAnchor.anchor },
        current: { nodules: cur.filter(l => !lockedCur.has(l.id)).map(nod), anchor: curAnchor.anchor },
        fixed_pairs: fixedPairs,
      }
      const result = await callWorker(this.fetch, this.workerUrl, '/api/v1/pipeline/lung-nodule/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 60_000) as MatchResult
      if (!result || !Array.isArray(result.pairs) || !result.registration) throw new Error('影像服务返回的匹配结果格式不对')

      const interval = daysBetween(prior.study_date, this.study(s, studyId)!.study_date)
      const byId = new Map([...cur, ...ref].map(l => [l.id, l]))
      const quality = result.registration.quality
      const counts: Record<string, number> = { new: 0, disappeared: 0, enlarged: 0, shrunk: 0, stable: 0 }
      s.db.exec('SAVEPOINT followup_links')
      try {
        // 只换掉自动匹配的链接；医生的保留
        this.supersedeWhere(s, a, studyId, l => l.source === 'ai', 'rematch')
        const insert = (lesionId: string | null, priorId: string | null, change: ChangeKind, metrics: Record<string, unknown>) => {
          counts[change] = (counts[change] ?? 0) + 1
          this.insertLink(s, a, { study_id: studyId, prior_study_id: prior.id, lesion_id: lesionId, prior_lesion_id: priorId, followup_id: followupId, source: 'ai', change, metrics }, 'auto_match')
        }
        for (const p of result.pairs) {
          const lp = byId.get(p.prior_id), lc = byId.get(p.current_id)
          if (!lp || !lc) continue
          const m = classifyChange(lp.metrics, lc.metrics, interval)
          insert(lc.id, lp.id, m.change, { ...m, distance_mm: p.distance_mm, gate_mm: p.gate_mm, lobe_match: p.lobe_match, ambiguous: p.ambiguous, alternatives_prior: p.alternatives_prior, alternatives_current: p.alternatives_current, registration_quality: quality })
        }
        for (const id of result.unmatched_current) if (byId.has(id)) insert(id, null, 'new', { registration_quality: quality })
        for (const id of result.unmatched_prior) if (byId.has(id)) insert(null, id, 'disappeared', { registration_quality: quality })
        s.db.exec('RELEASE SAVEPOINT followup_links')
      } catch (err) {
        s.db.exec('ROLLBACK TO SAVEPOINT followup_links')
        s.db.exec('RELEASE SAVEPOINT followup_links')
        throw err
      }
      const skipped = result.skipped ?? []
      if (skipped.length) warnings.push(`${skipped.length} 个结节没有病人坐标，未参与对比`)
      this.finish(s, followupId, 'done', {
        prior: prior.id,
        summary: {
          registration: result.registration, interval_days: interval, counts, manual_kept: kept.length, skipped,
          anchors: { current: curAnchor.anchor ? 'ok' : curAnchor.note, prior: priorAnchor.anchor ? 'ok' : priorAnchor.note },
          warnings: [...warnings, ...((result.registration.notes as string[] | undefined) ?? [])],
        },
      })
      s.log('followup_match', followupId)
    } catch (err) {
      this.finish(s, followupId, 'failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 两期层厚不同或有厚层时提示体积可比性（只提示，不改阈值） */
  private thicknessNote(s: ImagingScope, cur: LesionRow[], ref: LesionRow[]): string | null {
    const thick = (ls: LesionRow[]) => {
      const vals = new Set<number>()
      for (const l of ls) {
        if (!l.run_id) continue
        const r = s.db.prepare('SELECT se.slice_thickness AS t FROM imaging_runs r JOIN imaging_series se ON se.id = r.series_id WHERE r.id = ?').get(l.run_id) as { t: number | null } | undefined
        if (typeof r?.t === 'number') vals.add(r.t)
      }
      return [...vals]
    }
    const a = thick(cur), b = thick(ref)
    if (!a.length || !b.length) return null
    const differs = a.some(x => b.some(y => Math.abs(x - y) > 0.3))
    if (!differs && Math.max(...a, ...b) <= 1.25) return null
    return `两期层厚${differs ? '不同' : '偏厚'}（前片 ${b.join(' / ')} mm，本次 ${a.join(' / ')} mm），体积测量的可比性下降，变化请结合影像核对`
  }

  /**
   * 一期检查的肺部锚点（worker 分析时写在运行摘要 series_qc.lung_anchor）。旧的分析没有这一项时，
   * 从 Orthanc 取出该序列交给 worker 补算一次并缓存（imaging_series_anchors）；序列已不在 Orthanc 等情况如实返回原因。
   */
  private async anchorFor(s: ImagingScope, studyId: string, lesions: LesionRow[]): Promise<{ anchor: Record<string, unknown> | null; note: string | null }> {
    // 病灶所在序列（多数病灶所在的那个），没有时取最近一次完成的分析的序列
    const count = new Map<string, number>()
    for (const l of lesions) {
      if (!l.run_id) continue
      const r = s.db.prepare('SELECT series_id FROM imaging_runs WHERE id = ?').get(l.run_id) as { series_id: string | null } | undefined
      if (r?.series_id) count.set(r.series_id, (count.get(r.series_id) ?? 0) + 1)
    }
    let seriesId = [...count.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null
    if (!seriesId) seriesId = (s.db.prepare(`SELECT series_id FROM imaging_runs WHERE study_id = ? AND task = ? AND status = 'done' AND visibility = 'visible' AND series_id IS NOT NULL ORDER BY finished_at DESC LIMIT 1`).get(studyId, TASK) as { series_id: string } | undefined)?.series_id ?? null
    if (!seriesId) return { anchor: null, note: '找不到所分析的序列' }
    for (const r of s.db.prepare(`SELECT summary FROM imaging_runs WHERE series_id = ? AND task = ? AND status = 'done' AND summary IS NOT NULL ORDER BY finished_at DESC`).all(seriesId, TASK) as Array<{ summary: string }>) {
      const an = (JSON.parse(r.summary) as { series_qc?: { lung_anchor?: Record<string, unknown> } }).series_qc?.lung_anchor
      if (an) return an.ok ? { anchor: an, note: null } : { anchor: null, note: String(an.note ?? '分析时未能计算') }
    }
    const cached = s.db.prepare('SELECT anchor FROM imaging_series_anchors WHERE series_id = ?').get(seriesId) as { anchor: string } | undefined
    if (cached) { const an = JSON.parse(cached.anchor) as Record<string, unknown>; return an.ok ? { anchor: an, note: null } : { anchor: null, note: String(an.note ?? '') } }
    const se = s.db.prepare('SELECT orthanc_id FROM imaging_series WHERE id = ?').get(seriesId) as { orthanc_id: string | null } | undefined
    if (!this.orthanc) return { anchor: null, note: '没有配置影像存储，不能补算' }
    if (!se?.orthanc_id) return { anchor: null, note: '序列已不在影像存储中' }
    const volumeId = `anchor_${seriesId}`
    let uploaded = false
    try {
      let zip: Uint8Array
      try { zip = await this.orthanc.seriesArchive(se.orthanc_id) } catch (err) { return { anchor: null, note: `序列已不在影像存储中或读取失败：${err instanceof Error ? err.message : String(err)}` } }
      await uploadSeries(this.fetch, this.workerUrl, volumeId, zip)
      uploaded = true
      const r = await callWorker(this.fetch, this.workerUrl, '/api/v1/pipeline/lung-nodule/anchor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume_id: volumeId }) }, 120_000) as { anchor?: Record<string, unknown> }
      const an = r?.anchor ?? { ok: false, note: '影像服务没有返回锚点' }
      s.db.prepare('INSERT OR REPLACE INTO imaging_series_anchors (series_id, anchor, created_at) VALUES (?, ?, ?)').run(seriesId, JSON.stringify(an), now())
      return an.ok ? { anchor: an, note: null } : { anchor: null, note: String(an.note ?? '') }
    } catch (err) {
      return { anchor: null, note: `补算失败：${err instanceof Error ? err.message : String(err)}` }
    } finally {
      if (uploaded) await callWorker(this.fetch, this.workerUrl, `/api/v1/volume/${encodeURIComponent(volumeId)}`, { method: 'DELETE' }, 10_000).catch(() => {})
    }
  }

  // —— 链接 ——

  private activeLinks(s: ImagingScope, studyId: string): LinkRow[] {
    return (s.db.prepare("SELECT * FROM imaging_lesion_links WHERE study_id = ? AND status = 'active' ORDER BY created_at, rowid").all(studyId) as Array<Record<string, unknown>>).map(linkOf)
  }

  private link(s: ImagingScope, id: string): LinkRow {
    return linkOf(s.db.prepare('SELECT * FROM imaging_lesion_links WHERE id = ?').get(id) as Record<string, unknown>)
  }

  private insertLink(s: ImagingScope, a: Actor, x: Omit<LinkRow, 'id' | 'status' | 'created_by' | 'created_at' | 'updated_at'>, action: string): LinkRow {
    const id = rid('lk'), t = now()
    s.db.prepare(`INSERT INTO imaging_lesion_links (id, study_id, prior_study_id, lesion_id, prior_lesion_id, followup_id, source, status, change, metrics, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
      .run(id, x.study_id, x.prior_study_id, x.lesion_id, x.prior_lesion_id, x.followup_id, x.source, x.change, JSON.stringify(x.metrics), a.userId, t, t)
    const row = this.link(s, id)
    this.event(s, a, row, action, null, row)
    return row
  }

  private supersedeWhere(s: ImagingScope, a: Actor, studyId: string, pred: (l: LinkRow) => boolean, action: string): number {
    let n = 0
    for (const before of this.activeLinks(s, studyId).filter(pred)) {
      s.db.prepare("UPDATE imaging_lesion_links SET status = 'superseded', updated_at = ? WHERE id = ?").run(now(), before.id)
      this.event(s, a, before, action, before, this.link(s, before.id))
      n++
    }
    return n
  }

  private event(s: ImagingScope, a: Actor, link: LinkRow, action: string, before: LinkRow | null, after: LinkRow | null): void {
    s.db.prepare('INSERT INTO imaging_link_events (link_id, study_id, at, user_id, via, action, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(link.id, link.study_id, now(), a.userId, a.via, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null)
  }

  /** 链接的留痕（新的在后） */
  linkEvents(a: Actor, studyId: string): Array<{ link_id: string; at: string; user_id: string; via: string; action: string; before: unknown; after: unknown }> {
    const s = this.studyScope(a, studyId, 'read')
    return (s.db.prepare('SELECT link_id, at, user_id, via, action, before, after FROM imaging_link_events WHERE study_id = ? ORDER BY id').all(studyId) as Array<Record<string, unknown>>)
      .map(e => ({ link_id: e.link_id as string, at: e.at as string, user_id: e.user_id as string, via: e.via as string, action: e.action as string, before: e.before ? JSON.parse(e.before as string) : null, after: e.after ? JSON.parse(e.after as string) : null }))
  }

  /** 最近一次有前片的匹配（医生改对应关系时以它的前片为准） */
  private currentPrior(s: ImagingScope, studyId: string): { id: string; followupId: string } {
    const r = s.db.prepare("SELECT id, prior_study_id FROM imaging_followups WHERE study_id = ? AND status IN ('done', 'skipped') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(studyId) as { id: string; prior_study_id: string | null } | undefined
    if (!r?.prior_study_id) throw new ImagingError('no_prior', '这个检查还没有前片对比结果，不能改对应关系', 409)
    return { id: r.prior_study_id, followupId: r.id }
  }

  private requireHuman(a: Actor): void {
    if (a.via === 'ai') throw new PatientError('needs_human_review', '随访对比的对应关系须由医生在界面上调整', 403)
  }

  /** 拆开一对对应：本次结节改为「新发」、前片结节改为「消失」（医生的判断，重新匹配时保留） */
  unlink(a: Actor, linkId: string): FollowupView {
    this.requireHuman(a)
    const { studyId } = this.linkStudy(a, linkId)
    const s = this.studyScope(a, studyId, 'write')
    const l = this.link(s, linkId)
    if (l.status !== 'active') throw new ImagingError('link_inactive', '这条对应关系已失效，请刷新', 409)
    if (!l.lesion_id || !l.prior_lesion_id) throw new ImagingError('not_pair', '只有成对的对应关系可以拆开', 409)
    this.inTx(s, () => {
      this.supersedeWhere(s, a, studyId, x => x.id === linkId, 'unlink')
      this.insertLink(s, a, { study_id: studyId, prior_study_id: l.prior_study_id, lesion_id: l.lesion_id, prior_lesion_id: null, followup_id: null, source: 'manual', change: 'new', metrics: { by: 'unlink', from: linkId } }, 'unlink')
      this.insertLink(s, a, { study_id: studyId, prior_study_id: l.prior_study_id, lesion_id: null, prior_lesion_id: l.prior_lesion_id, followup_id: null, source: 'manual', change: 'disappeared', metrics: { by: 'unlink', from: linkId } }, 'unlink')
    })
    s.log('followup_unlink', linkId)
    return this.view(a, studyId)
  }

  /**
   * 重新对应：本次结节 lesionId 对应前片结节 priorLesionId（priorLesionId = null 表示「前片没有，新发」；
   * lesionId = null 表示前片结节「本次没有，消失」）。两者原来的对应一并失效，原来的另一方改为单侧（新发 / 消失）。
   */
  relink(a: Actor, studyId: string, lesionId: string | null, priorLesionId: string | null): FollowupView {
    this.requireHuman(a)
    if (!lesionId && !priorLesionId) throw new ImagingError('bad_link', '请指定本次或前片的结节')
    const s = this.studyScope(a, studyId, 'write')
    const prior = this.currentPrior(s, studyId)
    if (prior.id === studyId) throw new ImagingError('same_study', '前片与本次是同一个检查', 409)
    const cur = lesionId ? this.lesionById(s, lesionId) : null
    if (lesionId && (!cur || cur.study_id !== studyId || cur.kind !== KIND)) throw new PatientError('not_found', '本次检查里没有这个结节', 404)
    if (cur && !this.reference.current.includes(cur.status)) throw new ImagingError('lesion_ineligible', '这个结节已被否决或撤销，不参与随访对比', 409)
    // 前片一侧以随访库为准（定稿快照的测量），不在随访库里的前片结节不能作参照
    const priorRef = this.priorLesions(s, prior.id).lesions
    const pl = priorLesionId ? priorRef.find(x => x.id === priorLesionId) ?? this.lesionById(s, priorLesionId) : null
    if (priorLesionId && pl?.study_id === studyId) throw new ImagingError('same_study', '不能与同一检查里的结节对应', 409)
    if (priorLesionId && (!pl || pl.study_id !== prior.id || pl.kind !== KIND)) throw new PatientError('not_found', '前片里没有这个结节', 404)
    if (pl && !priorRef.some(x => x.id === pl.id)) throw new ImagingError('lesion_ineligible', '前片的这个结节不在随访库里（未确认，或不在前片最近一次定稿中），不能作为参照', 409)

    const old = this.activeLinks(s, studyId).filter(l => (lesionId && l.lesion_id === lesionId) || (priorLesionId && l.prior_lesion_id === priorLesionId))
    // 已经是同样的医生对应：不重复留痕
    if (old.length === 1 && old[0]!.source === 'manual' && old[0]!.lesion_id === lesionId && old[0]!.prior_lesion_id === priorLesionId) return this.view(a, studyId)
    const interval = daysBetween(this.study(s, prior.id)!.study_date, this.study(s, studyId)!.study_date)
    const eligible = (id: string, sid: string, statuses: LesionStatus[]) => { const x = this.lesionById(s, id); return !!x && x.study_id === sid && statuses.includes(x.status) }
    this.inTx(s, () => {
      this.supersedeWhere(s, a, studyId, l => old.some(o => o.id === l.id), 'relink')
      const base = { study_id: studyId, prior_study_id: prior.id, followup_id: null, source: 'manual' as const }
      // 原来的另一方变成单侧
      for (const o of old) {
        if (o.lesion_id && o.lesion_id !== lesionId && eligible(o.lesion_id, studyId, this.reference.current)) this.insertLink(s, a, { ...base, lesion_id: o.lesion_id, prior_lesion_id: null, change: 'new', metrics: { by: 'relink', from: o.id } }, 'relink')
        if (o.prior_lesion_id && o.prior_lesion_id !== priorLesionId && priorRef.some(x => x.id === o.prior_lesion_id)) this.insertLink(s, a, { ...base, lesion_id: null, prior_lesion_id: o.prior_lesion_id, change: 'disappeared', metrics: { by: 'relink', from: o.id } }, 'relink')
      }
      if (cur && pl) {
        const m = classifyChange(pl.metrics, cur.metrics, interval)
        this.insertLink(s, a, { ...base, lesion_id: cur.id, prior_lesion_id: pl.id, change: m.change, metrics: { ...m, by: 'relink' } }, 'relink')
      } else if (cur) this.insertLink(s, a, { ...base, lesion_id: cur.id, prior_lesion_id: null, change: 'new', metrics: { by: 'relink' } }, 'relink')
      else this.insertLink(s, a, { ...base, lesion_id: null, prior_lesion_id: pl!.id, change: 'disappeared', metrics: { by: 'relink' } }, 'relink')
    })
    s.log('followup_relink', lesionId ?? priorLesionId)
    return this.view(a, studyId)
  }

  private inTx(s: ImagingScope, fn: () => void): void {
    s.db.exec('SAVEPOINT followup_edit')
    try { fn(); s.db.exec('RELEASE SAVEPOINT followup_edit') } catch (err) {
      s.db.exec('ROLLBACK TO SAVEPOINT followup_edit')
      s.db.exec('RELEASE SAVEPOINT followup_edit')
      throw err
    }
  }

  // —— 读取 ——

  /**
   * 检查的随访对比：本次每个参与对比的结节一项（变化按两侧当前测量重新计算），再加前片里「消失」的结节。
   * 链接里的病灶后来被否决、撤销或取代时按现状推导（对应的本次结节被否决 → 前片结节显示为消失，并提示核对）。
   */
  view(a: Actor, studyId: string): FollowupView {
    const s = this.studyScope(a, studyId, 'read')
    const st = this.study(s, studyId)!
    const tol = tolerance()
    const counts: FollowupView['counts'] = { new: 0, disappeared: 0, enlarged: 0, shrunk: 0, stable: 0, pending: 0 }
    const lastRow = s.db.prepare('SELECT * FROM imaging_followups WHERE study_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(studyId) as Record<string, unknown> | undefined
    const last = lastRow ? followupOf(lastRow) : null
    const run = last ? { ...last, status: (last.status === 'queued' || last.status === 'running') && !this.inflight.has(studyId) ? 'interrupted' as const : last.status } : null
    const doneRow = s.db.prepare("SELECT * FROM imaging_followups WHERE study_id = ? AND status IN ('done', 'skipped') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(studyId) as Record<string, unknown> | undefined
    const done = doneRow ? followupOf(doneRow) : null
    const priorId = done?.status === 'done' ? done.prior_study_id : null
    const priorStudy = priorId ? this.study(s, priorId) : null
    const priorRef = priorStudy ? this.priorLesions(s, priorStudy.id) : null
    const base: FollowupView = {
      study_id: studyId, study_date: st.study_date, run, registration: null,
      prior: priorStudy && priorRef ? { study_id: priorStudy.id, study_date: priorStudy.study_date, interval_days: daysBetween(priorStudy.study_date, st.study_date), reference: priorRef.basis, signoff_version: priorRef.signoff_version } : null,
      tolerance: { ...tol, source: TOLERANCE_SOURCE }, items: [], counts,
    }
    if (!priorStudy) return base
    base.registration = (done!.summary?.registration as Record<string, unknown> | undefined) ?? null
    const reliable = base.registration?.reliable === true
    const interval = base.prior!.interval_days

    const cur = this.lesions(s, studyId, this.reference.current)
    const ref = priorRef!.lesions
    const curById = new Map(cur.map(l => [l.id, l])), refById = new Map(ref.map(l => [l.id, l]))
    const links = this.activeLinks(s, studyId).filter(l => l.prior_study_id === priorStudy.id)
    const items: FollowupItem[] = []
    const seenCur = new Set<string>(), seenRef = new Set<string>()
    const matchOf = (l: LinkRow): FollowupItem['match'] => l.lesion_id && l.prior_lesion_id && l.source === 'ai'
      ? { distance_mm: num(l.metrics.distance_mm), ambiguous: l.metrics.ambiguous === true, alternatives_prior: (l.metrics.alternatives_prior as string[]) ?? [], alternatives_current: (l.metrics.alternatives_current as string[]) ?? [], lobe_match: (l.metrics.lobe_match as boolean | null) ?? null }
      : null
    const push = (it: Omit<FollowupItem, 'needs_review'> & { needs_review?: boolean }) => {
      const needs = it.needs_review ?? (it.source === 'ai' && (!reliable || it.match?.ambiguous === true || it.match?.lobe_match === false || (it.metrics?.notes.some(n => n.includes('方向相反')) ?? false)))
      items.push({ ...it, needs_review: needs })
      counts[it.change ?? 'pending']++
      if (it.lesion_id) seenCur.add(it.lesion_id)
      if (it.prior_lesion_id) seenRef.add(it.prior_lesion_id)
    }
    for (const l of links) {
      const c = l.lesion_id ? curById.get(l.lesion_id) : undefined
      const p = l.prior_lesion_id ? refById.get(l.prior_lesion_id) : undefined
      const common = { link_id: l.id, source: l.source, match: matchOf(l) }
      if (l.lesion_id && l.prior_lesion_id) {
        if (c && p) {
          const m = classifyChange(p.metrics, c.metrics, interval)
          push({ ...common, lesion_id: c.id, prior_lesion_id: p.id, lesion: brief(c), prior_lesion: brief(p), change: m.change, metrics: m, notes: m.notes })
        } else if (c) {
          push({ ...common, lesion_id: c.id, prior_lesion_id: null, lesion: brief(c), prior_lesion: null, change: 'new', metrics: null, needs_review: true, notes: ['前片对应的结节已不是确认状态，按新发显示，请核对'] })
        } else if (p) {
          push({ ...common, lesion_id: null, prior_lesion_id: p.id, lesion: null, prior_lesion: brief(p), change: 'disappeared', metrics: null, needs_review: true, notes: ['本次对应的结节已被否决或撤销，前片结节按消失显示，请核对'] })
        }
      } else if (c) {
        push({ ...common, lesion_id: c.id, prior_lesion_id: null, lesion: brief(c), prior_lesion: null, change: 'new', metrics: null, notes: [] })
      } else if (p) {
        push({ ...common, lesion_id: null, prior_lesion_id: p.id, lesion: null, prior_lesion: brief(p), change: 'disappeared', metrics: null, notes: [] })
      }
    }
    const coords = (l: LesionRow) => Array.isArray(l.metrics.center_lps_mm)
    for (const c of cur) if (!seenCur.has(c.id)) push({ link_id: null, lesion_id: c.id, prior_lesion_id: null, lesion: brief(c), prior_lesion: null, change: null, source: null, metrics: null, match: null, needs_review: false, notes: [coords(c) ? '匹配之后新增或修改的结节，尚未对比，请重新匹配' : '没有病人坐标，不能自动对比，可手动对应'] })
    for (const p of ref) if (!seenRef.has(p.id)) push({ link_id: null, lesion_id: null, prior_lesion_id: p.id, lesion: null, prior_lesion: brief(p), change: null, source: null, metrics: null, match: null, needs_review: false, notes: [coords(p) ? '前片在匹配之后新确认的结节，尚未对比，请重新匹配' : '前片结节没有病人坐标，不能自动对比，可手动对应'] })
    base.items = items
    return base
  }

  /** 阅片器用：按 StudyInstanceUID */
  viewByUid(a: Actor, studyUid: string): FollowupView {
    return this.view(a, this.studyIdByUid(a, studyUid))
  }
}
