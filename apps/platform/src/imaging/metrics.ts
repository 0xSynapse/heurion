import type { DatabaseSync } from 'node:sqlite'
import type { Node as PMNode } from 'prosemirror-model'
import { serializeBlock } from '../model/markdown.ts'
import type { Documents } from '../model/runtime.ts'
import type { Store } from '../store/db.ts'
import { PatientError, type Actor, type PatientService } from '../tenancy/patients.ts'
import { ensureDraftSchema, type DraftBlock } from './findings-draft.ts'
import { ensureReviewSchema, type SignoffMode } from './review.ts'
import { ImagingError, POINT_TASK } from './studies.ts'

/**
 * 影像效率埋点与指标（PRD T2.10，供第 9 节指标统计；docs/design/IMAGING_STUDIES.md「效率埋点（T2.10）」）。
 *
 * - 埋点尽量从已有留痕推导，不重复记一份：AI 运行（imaging_runs）、病灶确认 / 否决 / 修改（imaging_lesion_events）、
 *   随访对应的拆开 / 重新对应（imaging_link_events）、初写完成（imaging_read_submissions）、定稿（imaging_signoffs）、
 *   草稿生成（findings_drafts）、草稿的医生编辑（op_log，actor = user）都已有时间戳。
 * - 只为没有留痕的时刻新增事件（imaging_work_events，机构患者库，只追加，随检查级联删除）：
 *   viewer_open（阅片器票据兑换成功，即真正打开了检查）、review_open（医生在界面上打开审核视图）、ris_copy（复制 RIS 纯文本成功）。
 *   只写本机构库，不发任何第三方；记录失败不影响阅片本身（调用方吞掉异常）。
 * - 报表只给机构管理员本人在界面上看（复用 imagingTenantScope：AI 不能读，个人空间不提供）；只含统计与内部 id，不含患者标识。
 * - 计时口径（见 activeMs）：按同一医生在同一检查上的操作时间点累加间隔；间隔不超过 IDLE 全计，
 *   超过 IDLE 但不超过 BREAK 按 IDLE 计（中途被打断），超过 BREAK 记 0（离开后另起一段）。
 */

/** 新增事件的种类 */
export type WorkEventKind = 'viewer_open' | 'review_open' | 'ris_copy'

const ready = new WeakSet<DatabaseSync>()
/** 埋点表（机构患者库）：只追加（UPDATE 一律被触发器拒绝）；删患者时随检查级联删除 */
export function ensureMetricsSchema(db: DatabaseSync): void {
  if (ready.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS imaging_work_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, study_id TEXT NOT NULL REFERENCES imaging_studies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, doc_id TEXT
    );
    CREATE INDEX IF NOT EXISTS imaging_work_events_study ON imaging_work_events (study_id, at);
    CREATE TRIGGER IF NOT EXISTS imaging_work_events_append_only BEFORE UPDATE ON imaging_work_events
      BEGIN SELECT RAISE(ABORT, 'imaging_work_events 只追加'); END;
  `)
  ready.add(db)
}

// —— 常量（可用环境变量调整） ——

const envNum = (name: string, def: number, lo: number, hi: number) => {
  const raw = process.env[name]
  const v = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(v) && v >= lo && v <= hi ? v : def
}
/**
 * - idle_min（默认 10）：两次操作之间不超过它的间隔全计。阅片时滚动层面、调窗不产生服务端事件，一例胸部 CT 不点任何按钮的连续阅读
 *   通常在几分钟内；超过 10 分钟没有任何操作，多半是被打断（接电话、看别的病人）。
 * - break_min（默认 60）：超过 idle_min、不超过它的间隔按 idle_min 计（打断前后仍算同一次阅片，只给 idle_min）；
 *   超过它的间隔记 0（隔了一小时以上再回来，中间多半在做别的检查，不能算到这一例上）。
 * - tz_offset_min（默认 480，北京时间）：按天筛选与按周汇总用的时区；库里时间戳是 UTC。
 */
export function metricsConfig(): { idle_min: number; break_min: number; tz_offset_min: number } {
  const idle = envNum('IMAGING_METRICS_IDLE_MIN', 10, 1, 120)
  return { idle_min: idle, break_min: envNum('IMAGING_METRICS_BREAK_MIN', Math.max(60, idle), idle, 24 * 60), tz_offset_min: envNum('IMAGING_METRICS_TZ_OFFSET_MIN', 480, -720, 840) }
}

/**
 * 一串操作时间点（毫秒）的有效工作时长：排序后累加相邻间隔，间隔 ≤ idle 全计，idle < 间隔 ≤ break 按 idle 计，> break 记 0。
 * 同一时刻的多个事件只算一次（间隔为 0）。
 */
export function activeMs(times: number[], idleMs: number, breakMs: number): number {
  const ts = times.filter(Number.isFinite).sort((x, y) => x - y)
  let total = 0
  for (let i = 1; i < ts.length; i++) {
    const g = ts[i]! - ts[i - 1]!
    total += g <= idleMs ? g : g <= breakMs ? idleMs : 0
  }
  return total
}

// —— 由留痕推出的时间线（纯数据，便于单测） ——

export interface Activity { at: number; user: string; kind: string }
export interface StudyTimeline {
  study_id: string
  /** 医生的操作（不含初写完成与定稿本身；不含 AI 与系统留痕、影子病灶） */
  activity: Activity[]
  submissions: Array<{ at: number; user: string }>
  signoffs: Array<{ at: number; user: string; version: number; mode: SignoffMode }>
  /** 本检查第一次有可见的 AI 分析结果的时间（影子运行不算）；没有为 null */
  ai_ready_at: number | null
}
export interface DraftTimeline {
  doc_id: string
  study_id: string
  owner: string
  /** 生成（首次、最近一次）、医生编辑（op_log）、复制 RIS 的时间点 */
  generated: number[]
  edits: number[]
  copies: number[]
}

export interface Episode {
  /** read = 初写（打开 → 初写完成）；review = 审核（→ 定稿）；write = 写所见（草稿生成 → 最后一次复制 RIS）；read_write = 首轮初写的阅片 + 写所见合计 */
  kind: 'read' | 'review' | 'write' | 'read_write'
  study_id: string
  user_id: string
  /** 第几轮：1 = 首次定稿前；≥ 2 = 第 N−1 版定稿之后的修改轮；写所见不分轮为 null */
  round: number | null
  /** 审核：定稿模式（dual / self / single）；其余为 null */
  mode: SignoffMode | null
  /** 结束时本检查是否已有可见的 AI 结果（影子期的阅片为 false，即「无 AI」对照） */
  ai_assist: boolean | null
  start: number | null
  end: number
  /** null = 窗口里除了结束动作本身没有任何操作，无法计时（不进分布） */
  active_ms: number | null
  events: number
  doc_id?: string
}

/**
 * 由一个检查的时间线推出初写与审核的计时段（每一轮分别计）：
 * - 初写：每次「初写完成」S（医生 u）一段。窗口 = (B, S]，B = max(S 之前最近一次定稿, u 在 S 之前的上一次提交)；
 *   段内 = u 在窗口里的全部操作 + S。多人参与时各人的提交各算一段；同一轮里重复提交，后一段从前一次提交之后算起。
 * - 审核：每次定稿 F（审核医师 R）一段。窗口 = (B', F]，B' = max(上一次定稿, R 本人在本轮的最后一次提交)。
 *   自审（mode = self）时 R 自己的初写在提交前结束，不会被算进审核时间。
 */
export function studyEpisodes(tl: StudyTimeline, idleMs: number, breakMs: number): Episode[] {
  const out: Episode[] = []
  const signoffs = [...tl.signoffs].sort((x, y) => x.at - y.at || x.version - y.version)
  const subs = [...tl.submissions].sort((x, y) => x.at - y.at)
  const lastBefore = (list: number[], t: number) => list.filter(x => x < t).reduce((m, x) => Math.max(m, x), -Infinity)
  const signoffTimes = signoffs.map(s => s.at)
  const aiAt = (t: number) => tl.ai_ready_at !== null && tl.ai_ready_at <= t
  for (const s of subs) {
    const prevOwn = lastBefore(subs.filter(x => x.user === s.user).map(x => x.at), s.at)
    const b = Math.max(lastBefore(signoffTimes, s.at), prevOwn)
    const acts = tl.activity.filter(e => e.user === s.user && e.at > b && e.at <= s.at)
    out.push({
      kind: 'read', study_id: tl.study_id, user_id: s.user, round: signoffTimes.filter(x => x < s.at).length + 1, mode: null, ai_assist: aiAt(s.at),
      start: acts.length ? Math.min(...acts.map(e => e.at)) : null, end: s.at,
      active_ms: acts.length ? activeMs([...acts.map(e => e.at), s.at], idleMs, breakMs) : null, events: acts.length,
    })
  }
  for (const f of signoffs) {
    const prev = lastBefore(signoffTimes, f.at)
    const own = subs.filter(x => x.user === f.user && x.at > prev && x.at < f.at).reduce((m, x) => Math.max(m, x.at), -Infinity)
    const b = Math.max(prev, own)
    const acts = tl.activity.filter(e => e.user === f.user && e.at > b && e.at <= f.at)
    out.push({
      kind: 'review', study_id: tl.study_id, user_id: f.user, round: f.version, mode: f.mode, ai_assist: aiAt(f.at),
      start: acts.length ? Math.min(...acts.map(e => e.at)) : null, end: f.at,
      active_ms: acts.length ? activeMs([...acts.map(e => e.at), f.at], idleMs, breakMs) : null, events: acts.length,
    })
  }
  return out
}

/** 写所见：每份草稿一段，从首次生成到最后一次复制 RIS（含其间的生成与医生编辑）；没复制过的 active_ms 为 null（未完成） */
export function draftEpisode(d: DraftTimeline, idleMs: number, breakMs: number): Episode {
  const lastCopy = d.copies.length ? Math.max(...d.copies) : null
  const start = d.generated.length ? Math.min(...d.generated) : null
  const pts = lastCopy === null ? [] : [...d.generated, ...d.edits, ...d.copies].filter(t => t <= lastCopy && (start === null || t >= start))
  return {
    kind: 'write', study_id: d.study_id, user_id: d.owner, round: null, mode: null, ai_assist: null, doc_id: d.doc_id,
    start, end: lastCopy ?? Math.max(...d.generated, ...d.edits, 0),
    active_ms: lastCopy === null || start === null ? null : activeMs(pts, idleMs, breakMs), events: pts.length,
  }
}

// —— 报表 ——

export interface Dist { n: number; median_ms: number | null; p90_ms: number | null }
export interface Split { all: Dist; ai: Dist; no_ai: Dist }

export interface EfficiencyReport {
  period: { from: string; to: string; tz_offset_min: number }
  department: { id: string; name: string } | null
  /** 机构当前的影像 AI 显示设置 */
  mode: 'visible' | 'shadow'
  config: { idle_min: number; break_min: number }
  /** 初写（阅片到初写完成）：首轮按有无 AI 结果分开；定稿后修改轮单列 */
  reading: { first_round: Split; amend: Dist; no_activity: number }
  review: { first_round: Split; amend: Dist; by_mode: Record<string, number>; no_activity: number }
  writing: { drafts: number; copied: number; stats: Dist }
  /** 首轮初写医师的「阅片 + 写所见」合计（PRD 第 9 节效率指标的主口径） */
  read_write: Split
  /** 流程中途：打开了还没人提交、提交了还没定稿的检查数 */
  pipeline: { opened_not_submitted: number; submitted_not_finalized: number }
  lesions: {
    studies: number
    ai: { total: number; confirmed: number; rejected: number; pending: number; superseded: number; confirm_rate: number | null; first_decision_confirm_rate: number | null; decision_changed: number }
    reject_reasons: Array<{ reason: string; n: number }>
    manual: { added: number; withdrawn: number; studies: number }
  }
  drafts: { drafts: number; trashed: number; blocks: number; unchanged: number; edited_by_user: number; edited_by_ai: number; deleted: number; modified_ratio: number | null; drafts_modified: number; user_added_blocks: number }
  weekly: Array<{ week_start: string; active_users: number; readers: number; reviewers: number; studies_opened: number; submissions: number; signoffs: number }>
  data_quality: { clock_anomalies: number; future_events: number }
  episodes: Array<Omit<Episode, 'start' | 'end'> & { start: string | null; end: string }>
}

const DAY = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/
/** 最近秩法分位数（与影子期对照报告一致） */
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
export function dist(values: number[]): Dist {
  const v = values.filter(Number.isFinite).sort((x, y) => x - y)
  return { n: v.length, median_ms: v.length ? percentile(v, 0.5) : null, p90_ms: v.length ? percentile(v, 0.9) : null }
}
const split = (eps: Episode[]): Split => {
  const ok = eps.filter(e => e.active_ms !== null)
  return { all: dist(ok.map(e => e.active_ms!)), ai: dist(ok.filter(e => e.ai_assist).map(e => e.active_ms!)), no_ai: dist(ok.filter(e => !e.ai_assist).map(e => e.active_ms!)) }
}
const ms = (iso: string | null | undefined) => iso ? Date.parse(iso) : NaN
/** 不算医生改动的系统留痕（与审核视图一致）：重新分析取代、后台补肺叶、定稿标记 */
const SYSTEM_ACTIONS = new Set(['supersede', 'locate', 'finalize'])

/** CSV 单元格：引号包裹；以 = + - @ 开头的加 '，防表格软件当公式执行 */
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export class ImagingMetricsService {
  constructor(private readonly patients: PatientService, private readonly store: Store, private readonly docs: Documents) {}

  // —— 埋点 ——

  private insert(db: DatabaseSync, studyId: string, userId: string, kind: WorkEventKind, docId: string | null = null): void {
    ensureMetricsSchema(db)
    db.prepare('INSERT INTO imaging_work_events (study_id, user_id, kind, at, doc_id) VALUES (?, ?, ?, ?, ?)').run(studyId, userId, kind, new Date().toISOString(), docId)
  }

  /** 阅片器票据兑换成功（/session）：医生真正打开了这个检查。仍按读权限校验（票据签发后被移出诊疗组的不记） */
  recordViewerOpen(a: Actor, studyUid: string): boolean {
    if (a.via !== 'user') return false
    const l = this.patients.imagingLookup(a)
    const row = l.db.prepare('SELECT id, patient_id FROM imaging_studies WHERE uid_hmac = ?').get(l.uidKey('study', studyUid)) as { id: string; patient_id: string } | undefined
    if (!row) return false
    const s = this.patients.imagingScope(a, row.patient_id, 'read')
    this.insert(s.db, row.id, a.userId, 'viewer_open')
    return true
  }

  /** 医生在界面上打开审核视图（AI 读 imaging_review 不记：那不是医生在看） */
  recordReviewOpen(a: Actor, studyId: string): boolean {
    if (a.via !== 'user') return false
    const db = this.patients.imagingLookup(a).db
    if (!db.prepare('SELECT 1 FROM imaging_studies WHERE id = ?').get(studyId)) return false
    this.insert(db, studyId, a.userId, 'review_open')
    return true
  }

  /**
   * 编辑器「复制为 RIS 纯文本」成功后由界面报告。只记所见草稿（findings_drafts 登记了来源检查）；
   * 别的文档、别的机构的草稿、看不到来源患者的读者不记（返回 recorded = false）。AI 不复制到 RIS，拒绝。
   */
  recordRisCopy(a: Actor, docId: string): { recorded: boolean; reason?: string } {
    if (a.via === 'ai') throw new PatientError('forbidden', '复制到 RIS 是医生本人在界面上的操作', 403)
    ensureDraftSchema(this.store)
    const r = this.store.db.prepare('SELECT tenant_id, patient_id, study_id FROM findings_drafts WHERE doc_id = ?').get(docId) as { tenant_id: string; patient_id: string; study_id: string } | undefined
    if (!r) return { recorded: false, reason: 'not_a_draft' }
    if (this.patients.tenantService.of(a.userId, a.space ?? 'work').id !== r.tenant_id) return { recorded: false, reason: 'other_tenant' }
    let db: DatabaseSync
    try { db = this.patients.imagingScope(a, r.patient_id, 'read').db } catch { return { recorded: false, reason: 'no_access' } }
    if (!db.prepare('SELECT 1 FROM imaging_studies WHERE id = ? AND patient_id = ?').get(r.study_id, r.patient_id)) return { recorded: false, reason: 'study_missing' }
    this.insert(db, r.study_id, a.userId, 'ris_copy', docId)
    return { recorded: true }
  }

  // —— 报表 ——

  /**
   * 影像效率统计：机构管理员本人在界面上看；AI 不能读（服务层拒绝 via = ai）；个人空间不提供。
   * from / to 为本地日期（含两端）；缺省为最近 28 天。department = 只看该科室成员的计时段与参与的检查。
   */
  report(a: Actor, opts: { from?: string | null; to?: string | null; department?: string | null } = {}, nowMs = Date.now()): EfficiencyReport {
    if (a.via === 'ai') throw new PatientError('forbidden', '影像效率统计只给机构管理员本人在界面上看，不给 AI', 403)
    const tenant = this.patients.tenantService.of(a.userId, a.space ?? 'work')
    if (tenant.kind !== 'org') throw new PatientError('personal', '个人空间没有科室效率统计', 400)
    const t = this.patients.imagingTenantScope(a, '影像效率统计')
    const cfg = metricsConfig()
    const idleMs = cfg.idle_min * 60_000, breakMs = cfg.break_min * 60_000
    const tz = cfg.tz_offset_min * 60_000
    const localDate = (m: number) => new Date(m + tz).toISOString().slice(0, 10)
    const to = opts.to || localDate(nowMs)
    const from = opts.from || localDate(Date.parse(`${to}T00:00:00Z`) - 27 * DAY)
    if (!DATE.test(from) || !DATE.test(to) || !Number.isFinite(Date.parse(`${from}T00:00:00Z`)) || !Number.isFinite(Date.parse(`${to}T00:00:00Z`))) throw new ImagingError('bad_period', 'from / to 格式应为 YYYY-MM-DD')
    const fromMs = Date.parse(`${from}T00:00:00Z`) - tz, toMs = Date.parse(`${to}T00:00:00Z`) - tz + DAY
    if (fromMs >= toMs) throw new ImagingError('bad_period', '开始日期不能晚于结束日期')
    if (toMs - fromMs > 366 * DAY) throw new ImagingError('bad_period', '一次最多统计 366 天')
    const inPeriod = (m: number) => m >= fromMs && m < toMs

    let department: { id: string; name: string } | null = null
    let members: Set<string> | null = null
    if (opts.department) {
      const d = this.store.listDepartments(t.tenantId).find(x => x.id === opts.department)
      if (!d) throw new PatientError('not_found', '本机构没有这个科室', 404)
      department = { id: d.id, name: d.name }
      members = new Set(d.members)
    }
    const inDept = (u: string) => !members || members.has(u)

    const db = t.db
    ensureReviewSchema(db)
    ensureMetricsSchema(db)
    ensureDraftSchema(this.store)
    let anomalies = 0, future = 0
    const checkOrder = (times: number[]) => { for (let i = 1; i < times.length; i++) if (times[i]! < times[i - 1]!) anomalies++ }
    const checkFuture = (m: number) => { if (m > nowMs + 5 * 60_000) future++ }

    // 检查（删除的患者随检查级联删掉，自然不在这里）
    const studyIds = new Set((db.prepare('SELECT id FROM imaging_studies').all() as Array<{ id: string }>).map(r => r.id))
    const timelines = new Map<string, StudyTimeline>()
    const tl = (id: string) => {
      let x = timelines.get(id)
      if (!x) { x = { study_id: id, activity: [], submissions: [], signoffs: [], ai_ready_at: null }; timelines.set(id, x) }
      return x
    }

    // 1) 新增事件
    const work = db.prepare('SELECT id, study_id, user_id, kind, at, doc_id FROM imaging_work_events ORDER BY id').all() as Array<{ study_id: string; user_id: string; kind: string; at: string; doc_id: string | null }>
    checkOrder(work.map(w => ms(w.at)))
    for (const w of work) { const m = ms(w.at); checkFuture(m); if (studyIds.has(w.study_id) && Number.isFinite(m)) tl(w.study_id).activity.push({ at: m, user: w.user_id, kind: w.kind }) }
    // 2) 病灶留痕：只取医生经界面的改动；AI 检出的 create、系统留痕、影子运行的病灶都不算
    const lev = db.prepare(`SELECT e.at, e.user_id, e.via, e.action, l.study_id, l.source FROM imaging_lesion_events e JOIN imaging_lesions l ON l.id = e.lesion_id
      LEFT JOIN imaging_runs r ON r.id = l.run_id WHERE r.id IS NULL OR r.visibility = 'visible' ORDER BY e.id`).all() as Array<{ at: string; user_id: string; via: string; action: string; study_id: string; source: string }>
    checkOrder(lev.map(e => ms(e.at)))
    for (const e of lev) {
      const m = ms(e.at); checkFuture(m)
      if (e.via !== 'user' || SYSTEM_ACTIONS.has(e.action) || (e.action === 'create' && e.source === 'ai') || !Number.isFinite(m)) continue
      tl(e.study_id).activity.push({ at: m, user: e.user_id, kind: `lesion_${e.action}` })
    }
    // 3) 随访对应：医生拆开 / 重新对应
    for (const e of db.prepare(`SELECT study_id, at, user_id FROM imaging_link_events WHERE via = 'user' AND action IN ('unlink', 'relink') ORDER BY id`).all() as Array<{ study_id: string; at: string; user_id: string }>) {
      const m = ms(e.at)
      if (studyIds.has(e.study_id) && Number.isFinite(m)) tl(e.study_id).activity.push({ at: m, user: e.user_id, kind: 'followup_link' })
    }
    // 4) 初写完成、定稿
    const subs = db.prepare('SELECT study_id, user_id, at FROM imaging_read_submissions ORDER BY id').all() as Array<{ study_id: string; user_id: string; at: string }>
    checkOrder(subs.map(s => ms(s.at)))
    for (const s of subs) { const m = ms(s.at); checkFuture(m); if (studyIds.has(s.study_id) && Number.isFinite(m)) tl(s.study_id).submissions.push({ at: m, user: s.user_id }) }
    const sos = db.prepare('SELECT study_id, version, signed_by, signed_at, mode FROM imaging_signoffs ORDER BY study_id, version').all() as Array<{ study_id: string; version: number; signed_by: string; signed_at: string; mode: SignoffMode }>
    for (const s of sos) { const m = ms(s.signed_at); checkFuture(m); if (studyIds.has(s.study_id) && Number.isFinite(m)) tl(s.study_id).signoffs.push({ at: m, user: s.signed_by, version: s.version, mode: s.mode }) }
    for (const x of timelines.values()) checkOrder(x.signoffs.sort((p, q) => p.version - q.version).map(s => s.at))
    // 5) 可见 AI 结果就绪时间（影子运行、点选分割不算）
    for (const r of db.prepare(`SELECT study_id, MIN(finished_at) AS at FROM imaging_runs WHERE visibility = 'visible' AND task != ? AND status = 'done' AND finished_at IS NOT NULL GROUP BY study_id`).all(POINT_TASK) as Array<{ study_id: string; at: string }>) {
      if (timelines.has(r.study_id)) tl(r.study_id).ai_ready_at = ms(r.at)
    }
    // 6) 所见草稿（平台库）：生成、医生编辑、复制 RIS；也算作者在该检查上的操作
    const draftRows = (this.store.db.prepare('SELECT * FROM findings_drafts WHERE tenant_id = ? ORDER BY created_at').all(t.tenantId) as Array<Record<string, unknown>>)
      .filter(r => studyIds.has(r.study_id as string))
    const drafts: Array<DraftTimeline & { created: number; blocks: DraftBlock[]; trashed: boolean }> = []
    for (const r of draftRows) {
      const doc = this.store.getDoc(r.doc_id as string)
      if (!doc) continue
      const owner = doc.owner
      const generated = [...new Set([ms(r.created_at as string), ms(r.generated_at as string)])].filter(Number.isFinite)
      const edits = (this.store.db.prepare("SELECT created_at FROM op_log WHERE doc_id = ? AND actor = 'user' ORDER BY rev").all(doc.id) as Array<{ created_at: string }>).map(e => ms(e.created_at)).filter(Number.isFinite)
      const copies = work.filter(w => w.kind === 'ris_copy' && w.doc_id === doc.id && w.user_id === owner).map(w => ms(w.at)).filter(Number.isFinite)
      drafts.push({ doc_id: doc.id, study_id: r.study_id as string, owner, generated, edits, copies, created: ms(r.created_at as string), blocks: JSON.parse(r.blocks as string) as DraftBlock[], trashed: Boolean(doc.deleted_at) })
      const x = tl(r.study_id as string)
      for (const g of generated) x.activity.push({ at: g, user: owner, kind: 'draft_generate' })
      for (const e of edits) x.activity.push({ at: e, user: owner, kind: 'draft_edit' })
    }

    // —— 计时段 ——
    const all: Episode[] = []
    for (const x of timelines.values()) all.push(...studyEpisodes(x, idleMs, breakMs))
    const writeEps = drafts.map(d => draftEpisode(d, idleMs, breakMs))
    // 阅片 + 写所见（首轮）：同一检查、同一初写医师首轮的全部初写段，加上他为本检查写的草稿
    const readWrite: Episode[] = []
    const firstRead = new Map<string, Episode[]>()
    for (const e of all) if (e.kind === 'read' && e.round === 1 && e.active_ms !== null) {
      const k = `${e.study_id}\u0000${e.user_id}`
      firstRead.set(k, [...(firstRead.get(k) ?? []), e])
    }
    for (const [k, eps] of firstRead) {
      const [studyId, user] = k.split('\u0000') as [string, string]
      const x = timelines.get(studyId)!
      const pts = new Set<number>()
      for (const e of eps) {
        const b = e.start!
        for (const a2 of x.activity) if (a2.user === user && a2.at >= b && a2.at <= e.end) pts.add(a2.at)
        pts.add(e.end)
      }
      for (const d of drafts.filter(d => d.study_id === studyId && d.owner === user)) {
        const lastCopy = d.copies.length ? Math.max(...d.copies) : Math.max(...d.generated, ...d.edits)
        for (const p of [...d.generated, ...d.edits, ...d.copies]) if (p <= lastCopy) pts.add(p)
      }
      const last = eps[eps.length - 1]!
      const times = [...pts]
      readWrite.push({ kind: 'read_write', study_id: studyId, user_id: user, round: 1, mode: null, ai_assist: last.ai_assist, start: Math.min(...times), end: Math.max(...times), active_ms: activeMs(times, idleMs, breakMs), events: times.length })
    }

    const keep = (e: Episode) => inPeriod(e.end) && inDept(e.user_id)
    const eps = [...all, ...writeEps, ...readWrite].filter(keep)
    const reads = eps.filter(e => e.kind === 'read'), reviews = eps.filter(e => e.kind === 'review')

    // —— 流程中途的检查 ——
    // 科室筛选时只看本科室成员参与过（有操作、提交或定稿）的检查；不筛选时为全部检查（含只有 AI 运行、没人动过的）
    const deptStudies = new Set<string>(members ? [] : studyIds)
    if (members) for (const x of timelines.values()) {
      if (x.activity.some(e => members!.has(e.user)) || x.submissions.some(s => members!.has(s.user)) || x.signoffs.some(s => members!.has(s.user))) deptStudies.add(x.study_id)
    }
    let openedNotSubmitted = 0, submittedNotFinalized = 0
    for (const x of timelines.values()) {
      if (!deptStudies.has(x.study_id)) continue
      const opened = x.activity.some(e => e.kind === 'viewer_open' && inPeriod(e.at) && inDept(e.user))
      if (opened && !x.submissions.length && !x.signoffs.length) openedNotSubmitted++
      const lastSub = Math.max(-Infinity, ...x.submissions.map(s => s.at))
      const lastSo = Math.max(-Infinity, ...x.signoffs.map(s => s.at))
      if (Number.isFinite(lastSub) && inPeriod(lastSub) && lastSub > lastSo) submittedNotFinalized++
    }

    // —— 病灶：AI 检出的确认率与否决原因；医生补充的单独计 ——
    const lesionRows = db.prepare(`SELECT l.id, l.study_id, l.source, l.status, l.reject_reason, l.created_at FROM imaging_lesions l LEFT JOIN imaging_runs r ON r.id = l.run_id
      WHERE r.id IS NULL OR r.visibility = 'visible'`).all() as Array<{ id: string; study_id: string; source: string; status: string; reject_reason: string | null; created_at: string }>
    const firstDecision = new Map<string, string>()
    for (const e of db.prepare(`SELECT lesion_id, action FROM imaging_lesion_events WHERE via = 'user' AND action IN ('confirm', 'reject') ORDER BY id`).all() as Array<{ lesion_id: string; action: string }>) {
      if (!firstDecision.has(e.lesion_id)) firstDecision.set(e.lesion_id, e.action)
    }
    const inScope = lesionRows.filter(l => inPeriod(ms(l.created_at)) && deptStudies.has(l.study_id))
    const ai = inScope.filter(l => l.source === 'ai')
    const count = (st: string) => ai.filter(l => l.status === st).length
    const confirmed = count('confirmed'), rejected = count('rejected')
    const decided = ai.filter(l => firstDecision.has(l.id))
    const reasons = new Map<string, number>()
    for (const l of ai.filter(l => l.status === 'rejected')) { const k = l.reject_reason || '未填写'; reasons.set(k, (reasons.get(k) ?? 0) + 1) }
    const manual = inScope.filter(l => l.source === 'manual')
    const rate = (n: number, d: number) => d ? Math.round(n / d * 1000) / 1000 : null

    // —— 草稿修改量：登记的段落（不含标题与〔草稿〕状态行）与上次生成写下的内容比对 ——
    const ds = drafts.filter(d => inPeriod(d.created) && inDept(d.owner))
    const dq = { drafts: 0, trashed: 0, blocks: 0, unchanged: 0, edited_by_user: 0, edited_by_ai: 0, deleted: 0, modified_ratio: null as number | null, drafts_modified: 0, user_added_blocks: 0 }
    const userTouched = this.store.db.prepare("SELECT 1 FROM node_changes WHERE doc_id = ? AND node_id = ? AND actor = 'user' LIMIT 1")
    for (const d of ds) {
      if (d.trashed) { dq.trashed++; continue }
      let doc: PMNode
      try { doc = this.docs.get(d.doc_id) } catch { continue }
      dq.drafts++
      const byId = new Map<string, PMNode>()
      doc.forEach(n => { if (n.attrs.id) byId.set(String(n.attrs.id), n) })
      const regs = d.blocks.filter(b => b.key !== 'title' && b.key !== 'status')
      let modified = false
      for (const b of regs) {
        dq.blocks++
        const node = b.id ? byId.get(b.id) : undefined
        if (!node) { dq.deleted++; modified = true; continue }
        if (serializeBlock(node, {}, '') === b.md) { dq.unchanged++; continue }
        modified = true
        if (userTouched.get(d.doc_id, b.id)) dq.edited_by_user++
        else dq.edited_by_ai++
      }
      const registered = new Set(d.blocks.map(b => b.id).filter(Boolean))
      for (const [id, n] of byId) if (!registered.has(id) && (n.textContent.trim() || n.childCount > 1)) dq.user_added_blocks++
      if (modified) dq.drafts_modified++
    }
    dq.modified_ratio = rate(dq.edited_by_user + dq.edited_by_ai + dq.deleted, dq.blocks)

    // —— 每周活跃（周一为一周开始，按 tz_offset_min 的本地日期） ——
    const weekOf = (m: number) => { const d = new Date(m + tz); const back = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10) }
    const weeks = new Map<string, { users: Set<string>; readers: Set<string>; reviewers: Set<string>; studies: Set<string>; submissions: number; signoffs: number }>()
    const wk = (m: number) => {
      const k = weekOf(m)
      let w = weeks.get(k)
      if (!w) { w = { users: new Set(), readers: new Set(), reviewers: new Set(), studies: new Set(), submissions: 0, signoffs: 0 }; weeks.set(k, w) }
      return w
    }
    for (let m = fromMs; m < toMs; m += 7 * DAY) wk(m)
    wk(toMs - 1)
    for (const x of timelines.values()) {
      for (const e of x.activity) if (inPeriod(e.at) && inDept(e.user)) { const w = wk(e.at); w.users.add(e.user); if (e.kind === 'viewer_open') w.studies.add(x.study_id) }
      for (const s of x.submissions) if (inPeriod(s.at) && inDept(s.user)) { const w = wk(s.at); w.users.add(s.user); w.readers.add(s.user); w.submissions++ }
      for (const s of x.signoffs) if (inPeriod(s.at) && inDept(s.user)) { const w = wk(s.at); w.users.add(s.user); w.reviewers.add(s.user); w.signoffs++ }
    }

    const iso = (m: number | null) => m === null || !Number.isFinite(m) ? null : new Date(m).toISOString()
    return {
      period: { from, to, tz_offset_min: cfg.tz_offset_min }, department, mode: t.aiVisibility, config: { idle_min: cfg.idle_min, break_min: cfg.break_min },
      reading: { first_round: split(reads.filter(e => e.round === 1)), amend: dist(reads.filter(e => e.round !== 1 && e.active_ms !== null).map(e => e.active_ms!)), no_activity: reads.filter(e => e.active_ms === null).length },
      review: {
        first_round: split(reviews.filter(e => e.round === 1)), amend: dist(reviews.filter(e => e.round !== 1 && e.active_ms !== null).map(e => e.active_ms!)),
        by_mode: reviews.reduce<Record<string, number>>((m, e) => { m[e.mode!] = (m[e.mode!] ?? 0) + 1; return m }, {}),
        no_activity: reviews.filter(e => e.active_ms === null).length,
      },
      writing: (() => {
        const w = writeEps.filter(e => inDept(e.user_id) && inPeriod(drafts.find(d => d.doc_id === e.doc_id)!.created))
        return { drafts: w.length, copied: w.filter(e => e.active_ms !== null).length, stats: dist(w.filter(e => e.active_ms !== null && inPeriod(e.end)).map(e => e.active_ms!)) }
      })(),
      read_write: split(eps.filter(e => e.kind === 'read_write')),
      pipeline: { opened_not_submitted: openedNotSubmitted, submitted_not_finalized: submittedNotFinalized },
      lesions: {
        studies: new Set(inScope.map(l => l.study_id)).size,
        ai: {
          total: ai.length, confirmed, rejected, pending: count('proposed'), superseded: count('superseded'),
          confirm_rate: rate(confirmed, confirmed + rejected),
          first_decision_confirm_rate: rate(decided.filter(l => firstDecision.get(l.id) === 'confirm').length, decided.length),
          decision_changed: decided.filter(l => (firstDecision.get(l.id) === 'confirm' ? 'confirmed' : 'rejected') !== l.status && (l.status === 'confirmed' || l.status === 'rejected')).length,
        },
        reject_reasons: [...reasons].map(([reason, n]) => ({ reason, n })).sort((x, y) => y.n - x.n || x.reason.localeCompare(y.reason)),
        manual: { added: manual.length, withdrawn: manual.filter(l => l.status === 'superseded').length, studies: new Set(manual.map(l => l.study_id)).size },
      },
      drafts: dq,
      weekly: [...weeks].sort(([x], [y]) => x.localeCompare(y)).map(([week_start, w]) => ({ week_start, active_users: w.users.size, readers: w.readers.size, reviewers: w.reviewers.size, studies_opened: w.studies.size, submissions: w.submissions, signoffs: w.signoffs })),
      data_quality: { clock_anomalies: anomalies, future_events: future },
      episodes: eps.sort((x, y) => x.end - y.end).map(e => ({ ...e, start: iso(e.start), end: iso(e.end)! })),
    }
  }

  /** 计时段明细的 CSV（一行一段；只有内部 id 与时间，没有患者标识） */
  static csv(r: EfficiencyReport): string {
    const head = ['kind', 'study_id', 'user_id', 'round', 'mode', 'ai_assist', 'start', 'end', 'active_min', 'events', 'doc_id']
    const rows = r.episodes.map(e => [e.kind, e.study_id, e.user_id, e.round, e.mode, e.ai_assist === null ? '' : e.ai_assist ? 1 : 0, e.start, e.end,
      e.active_ms === null ? '' : (e.active_ms / 60_000).toFixed(2), e.events, e.doc_id ?? ''])
    return [head, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  }
}
