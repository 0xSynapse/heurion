import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { PatientError, type Actor, type ImagingScope, type PatientService } from '../tenancy/patients.ts'
import { ImagingError, POINT_TASK, type LesionRow, type LesionStatus } from './studies.ts'

/**
 * 影像审核视图与定稿（PRD T2.7，W5.1 / W5.2；docs/design/IMAGING_STUDIES.md「审核与定稿」）。
 *
 * - 阅片角色：机构成员在影像上分「初写」（reader，默认）与「审核」（reviewer），由机构管理员设置，存在机构患者库的
 *   imaging_reading_roles 里（按机构隔离，不改平台账户表）。个人空间没有角色，本人即可定稿（单人模式）。
 * - 流程（按检查）：初写中 → 初写完成（提交审核）→ 已定稿 vN → 定稿后又有改动（定稿后修改中）→ 再次定稿 vN+1 …
 *   状态不另存，按「最近一次定稿时的留痕位置」与当前留痕比较得出：任何写路径（主站、阅片器、AI 重新分析）产生的
 *   病灶留痕都会让已定稿的检查回到「定稿后修改中」，不必在各写路径里加钩子。
 * - 定稿：只允许审核医师（且须在诊疗组）；AI 一律不能（服务层拒绝 via = ai，接口登记在 NOT_FOR_AI）。
 *   定稿时把检查当前全部病灶（不含影子与已取代）的版本与测量写成快照，快照只追加、不可修改（触发器保护）。
 * - 审核视图的数据全部来自 imaging_lesion_events（W2.6 留痕），不另记一份：AI 原值 = AI 检出的 create 事件；
 *   初写修改 / 审核修改按事件发生的阶段与操作者区分（见 classify）。
 * - 随访与科研用 finalizedLesions / finalizedStudies：只读最近一次定稿快照，未定稿的改动不进随访库。
 */

export type ReadingRole = 'reader' | 'reviewer'
/** reading = 初写中；submitted = 初写已完成、待审核；finalized = 已定稿且之后没有改动；amending = 定稿后又有改动、待再次定稿 */
export type ReviewState = 'reading' | 'submitted' | 'finalized' | 'amending'
/** dual = 初写与审核为不同的人；self = 机构允许自审、本次为自审；single = 个人空间（单人） */
export type SignoffMode = 'dual' | 'self' | 'single'
export type ChangePhase = 'reader' | 'reviewer'

/** 定稿快照里的一个病灶（定稿时的版本与测量） */
export interface SnapshotLesion {
  id: string
  version: number
  kind: string
  source: 'ai' | 'manual'
  status: Exclude<LesionStatus, 'superseded' | 'proposed'>
  reject_reason: string | null
  label: string | null
  location: string | null
  metrics: Record<string, unknown>
  seg_ref: string | null
}

export interface SignoffMeta {
  id: string
  study_id: string
  version: number
  signed_by: string
  signed_by_name: string | null
  signed_at: string
  /** 定稿时检查的留痕位置（病灶事件最大 id）：之后有新留痕即「定稿后修改中」 */
  revision: number
  mode: SignoffMode
  /** 本轮的初写医师（提交初写或做过初写阶段修改的人） */
  readers: string[]
  /** 快照 JSON 的 SHA-256（核对快照未被改动） */
  snapshot_hash: string
  /** 快照里的病灶数（confirmed = 已确认的，即进入随访库的） */
  lesions: { total: number; confirmed: number; rejected: number }
}

export interface Signoff extends SignoffMeta {
  note: string | null
  lesions_snapshot: SnapshotLesion[]
}

export interface ReviewChange {
  event_id: number
  at: string
  user_id: string
  user_name: string | null
  action: string
  phase: ChangePhase
  /** 发生在第几次定稿之后（0 = 首次定稿前） */
  after_signoff: number
  /** 字段级变化：状态、否决原因、位置、标签、分割、主要测量 */
  changes: Record<string, { before: unknown; after: unknown }>
}

export interface ReviewLesion {
  id: string
  label: string | null
  kind: string
  source: 'ai' | 'manual'
  status: LesionStatus
  reject_reason: string | null
  version: number
  location: string | null
  /** 当前测量（完整） */
  metrics: Record<string, unknown>
  /** AI 原值（AI 检出的 create 事件；医生补充的为 null） */
  ai_original: { label: string | null; location: string | null; metrics: Record<string, unknown> } | null
  /** 医生补充的病灶：谁补充的、在哪个阶段 */
  added_by: { user_id: string; user_name: string | null; phase: ChangePhase } | null
  reader_changes: ReviewChange[]
  reviewer_changes: ReviewChange[]
  /** 在最近一次定稿快照里的版本；current = 当前版本与之相同、状态未变 */
  finalized: { signoff_version: number; lesion_version: number; status: string; current: boolean } | null
}

export interface ReviewView {
  study_id: string
  patient_id: string
  state: ReviewState
  /** 当前留痕位置；定稿请求须带上（乐观锁：期间病灶有改动则拒绝） */
  revision: number
  /** org = 机构（区分初写 / 审核）；personal = 个人空间（单人模式） */
  reading_mode: 'org' | 'personal'
  my_role: ReadingRole | null
  self_review_allowed: boolean
  counts: { proposed: number; confirmed: number; rejected: number }
  submissions: Array<{ user_id: string; user_name: string | null; at: string; revision: number }>
  readers: Array<{ user_id: string; user_name: string | null }>
  lesions: ReviewLesion[]
  /** 在最近一次定稿里、之后被撤销（已取代）的病灶 */
  removed_since_finalized: SnapshotLesion[]
  latest_signoff: SignoffMeta | null
  signoffs: SignoffMeta[]
  /** 当前操作者能否定稿；不能时列出原因（AI 读到的永远是不能） */
  finalize: { allowed: boolean; blockers: Array<{ code: string; message: string }> }
}

export interface ReviewSummary {
  study_id: string
  state: ReviewState
  revision: number
  latest_signoff: Pick<SignoffMeta, 'version' | 'signed_by' | 'signed_by_name' | 'signed_at' | 'mode'> | null
}

/** 留痕里的测量字段：审核视图只比较这些（提示点、坐标、关键层等不逐项列出） */
const MEASURE_KEYS = ['mean_diameter_mm', 'long_axis_mm', 'short_axis_mm', 'volume_mm3', 'mean_hu', 'nodule_type', 'segmentation'] as const
const FIELD_KEYS = ['status', 'reject_reason', 'location', 'label', 'seg_ref'] as const
/** 不算医生改动的系统留痕：重新分析取代、后台补肺叶、定稿标记 */
const SYSTEM_ACTIONS = new Set(['supersede', 'locate', 'finalize'])

const now = () => new Date().toISOString()
const pickMeasures = (m: Record<string, unknown> | undefined | null): Record<string, unknown> =>
  Object.fromEntries(MEASURE_KEYS.filter(k => m && m[k] !== undefined).map(k => [k, m![k]]))
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const ready = new WeakSet<DatabaseSync>()
/**
 * 审核与定稿的表（机构患者库）。放在这里按需建表，旧库第一次用到时补上；以后增列按 patients.ts 的 cols() 写法。
 * imaging_signoffs 只追加：UPDATE 一律被触发器拒绝（删患者时随检查级联删除仍然允许）。
 */
export function ensureReviewSchema(db: DatabaseSync): void {
  if (ready.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS imaging_reading_roles (
      user_id TEXT PRIMARY KEY, role TEXT NOT NULL, set_by TEXT NOT NULL, set_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imaging_read_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, study_id TEXT NOT NULL REFERENCES imaging_studies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, at TEXT NOT NULL, revision INTEGER NOT NULL, note_enc TEXT
    );
    CREATE INDEX IF NOT EXISTS imaging_read_submissions_study ON imaging_read_submissions (study_id);
    CREATE TABLE IF NOT EXISTS imaging_signoffs (
      id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES imaging_studies(id) ON DELETE CASCADE, version INTEGER NOT NULL,
      signed_by TEXT NOT NULL, signed_at TEXT NOT NULL, revision INTEGER NOT NULL, mode TEXT NOT NULL, readers TEXT NOT NULL DEFAULT '[]',
      note_enc TEXT, snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL, UNIQUE (study_id, version)
    );
    CREATE TRIGGER IF NOT EXISTS imaging_signoffs_immutable BEFORE UPDATE ON imaging_signoffs
      BEGIN SELECT RAISE(ABORT, 'imaging_signoffs 只能追加，定稿快照不可修改'); END;
  `)
  ready.add(db)
}

interface EventRow { id: number; lesion_id: string; at: string; user_id: string; via: string; action: string; before: string | null; after: string | null }
interface SignoffRow { id: string; study_id: string; version: number; signed_by: string; signed_at: string; revision: number; mode: SignoffMode; readers: string; note_enc: string | null; snapshot: string; snapshot_hash: string }

/** 检查的可见病灶（不含影子运行的；含已取代的，调用方再筛） */
const VISIBLE_LESIONS = `SELECT l.* FROM imaging_lesions l LEFT JOIN imaging_runs r ON r.id = l.run_id
  WHERE l.study_id = ? AND (r.id IS NULL OR r.visibility = 'visible') ORDER BY l.created_at, l.rowid`

export class ImagingReviewService {
  /** names：用户 id → 显示名（界面与 AI 视图用；没有时只给 id） */
  constructor(private readonly patients: PatientService, private readonly names: (userId: string) => string | null = () => null) {}

  // —— 阅片角色 ——

  /** 机构的阅片角色表（机构管理员在「成员」里设置）；没设置的成员为初写 */
  readingRoles(a: Actor): Array<{ user_id: string; role: ReadingRole; set_by: string; set_at: string }> {
    const { db } = this.requireTenantAdmin(a)
    return db.prepare('SELECT user_id, role, set_by, set_at FROM imaging_reading_roles ORDER BY set_at').all() as Array<{ user_id: string; role: ReadingRole; set_by: string; set_at: string }>
  }

  /**
   * 设置成员的阅片角色（只有机构管理员本人在界面上操作；AI 不能授予定稿权限）。
   * 只能设本机构的成员；个人空间没有角色。
   */
  setReadingRole(a: Actor, userId: string, role: unknown, isMember: (userId: string, tenantId: string) => boolean): { user_id: string; role: ReadingRole } {
    const { db, tenantId } = this.requireTenantAdmin(a)
    if (role !== 'reader' && role !== 'reviewer') throw new ImagingError('bad_role', '阅片角色只能是 reader（初写）或 reviewer（审核）')
    if (!isMember(userId, tenantId)) throw new PatientError('not_found', '本机构没有这位成员', 404)
    db.prepare('INSERT INTO imaging_reading_roles (user_id, role, set_by, set_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, set_by = excluded.set_by, set_at = excluded.set_at')
      .run(userId, role, a.userId, now())
    return { user_id: userId, role }
  }

  private requireTenantAdmin(a: Actor): { db: DatabaseSync; tenantId: string } {
    if (a.via === 'ai') throw new PatientError('forbidden', '阅片角色（谁能定稿）只能由机构管理员本人在界面上设置', 403)
    const ts = this.patients.tenantService
    const t = ts.of(a.userId, a.space ?? 'work')
    if (t.kind !== 'org') throw new PatientError('personal', '个人空间没有初写 / 审核角色：本人即可定稿', 400)
    if (ts.roleOf(a.userId, a.space ?? 'work') !== 'admin') throw new PatientError('forbidden', '只有机构管理员能设置阅片角色', 403)
    const db = this.patients.imagingLookup(a).db
    ensureReviewSchema(db)
    return { db, tenantId: t.id }
  }

  // —— 审核视图（W5.1） ——

  /** 一个检查的审核视图：按病灶列出 AI 原值、初写修改、审核修改与当前值，以及定稿历史和当前操作者能否定稿 */
  view(a: Actor, studyId: string, opts: { isRunActive?: (runId: string) => boolean } = {}): ReviewView {
    const s = this.studyScope(a, studyId, 'read')
    const ctx = this.context(a, s, studyId)
    const signoffs = this.signoffRows(s, studyId)
    const latest = signoffs[signoffs.length - 1] ?? null
    const latestSnap = latest ? JSON.parse(latest.snapshot) as SnapshotLesion[] : []
    const snapById = new Map(latestSnap.map(l => [l.id, l]))

    const lesions: ReviewLesion[] = []
    for (const l of ctx.lesions) {
      if (l.status === 'superseded') continue
      const evs = ctx.eventsByLesion.get(l.id) ?? []
      const create = evs.find(e => e.action === 'create')
      const createAfter = create?.after ? JSON.parse(create.after) as LesionRow : null
      const changes = evs.flatMap(e => {
        const phase = ctx.classify(e, l)
        if (phase !== 'reader' && phase !== 'reviewer') return []
        if (e.action === 'create') return []
        return [this.change(e, phase, signoffs)]
      })
      const addPhase = create && l.source === 'manual' ? ctx.classify(create, l) : null
      const snap = snapById.get(l.id)
      lesions.push({
        id: l.id, label: l.label, kind: l.kind, source: l.source, status: l.status, reject_reason: l.reject_reason, version: l.version, location: l.location, metrics: l.metrics,
        ai_original: l.source === 'ai' && createAfter ? { label: createAfter.label ?? null, location: createAfter.location ?? null, metrics: pickMeasures(createAfter.metrics) } : null,
        added_by: create && (addPhase === 'reader' || addPhase === 'reviewer') ? { user_id: create.user_id, user_name: this.names(create.user_id), phase: addPhase } : null,
        reader_changes: changes.filter(c => c.phase === 'reader'),
        reviewer_changes: changes.filter(c => c.phase === 'reviewer'),
        finalized: snap && latest ? { signoff_version: latest.version, lesion_version: snap.version, status: snap.status, current: snap.version === l.version && snap.status === l.status } : null,
      })
    }
    const live = new Set(lesions.map(l => l.id))
    const counts = { proposed: 0, confirmed: 0, rejected: 0 }
    for (const l of lesions) if (l.status !== 'superseded') counts[l.status]++
    const blockers = this.blockers(a, s, studyId, ctx, latest, opts)
    return {
      study_id: studyId, patient_id: s.patientId, state: ctx.state(latest), revision: ctx.revision,
      reading_mode: ctx.personal ? 'personal' : 'org', my_role: ctx.personal ? null : ctx.roleOf(a.userId), self_review_allowed: ctx.personal || ctx.selfReviewAllowed,
      counts,
      submissions: ctx.submissions.map(x => ({ user_id: x.user_id, user_name: this.names(x.user_id), at: x.at, revision: x.revision })),
      readers: [...ctx.readers].map(u => ({ user_id: u, user_name: this.names(u) })),
      lesions,
      removed_since_finalized: latestSnap.filter(x => !live.has(x.id)),
      latest_signoff: latest ? this.meta(latest) : null,
      signoffs: signoffs.map(r => this.meta(r)).reverse(),
      finalize: { allowed: blockers.length === 0, blockers },
    }
  }

  /** 患者各检查的审核状态（患者页影像检查表用） */
  summaries(a: Actor, patientId: string): ReviewSummary[] {
    const s = this.patients.imagingScope(a, patientId, 'read')
    ensureReviewSchema(s.db)
    const ids = (s.db.prepare('SELECT id FROM imaging_studies WHERE patient_id = ? ORDER BY COALESCE(study_date, created_at) DESC, created_at DESC, rowid DESC').all(patientId) as Array<{ id: string }>).map(r => r.id)
    return ids.map(id => this.summaryIn(s, id))
  }

  /** 一个检查的审核状态（阅片器结节面板用） */
  summary(a: Actor, studyId: string): ReviewSummary {
    return this.summaryIn(this.studyScope(a, studyId, 'read'), studyId)
  }

  private summaryIn(s: ImagingScope, studyId: string): ReviewSummary {
    const signoffs = this.signoffRows(s, studyId)
    const latest = signoffs[signoffs.length - 1] ?? null
    const revision = this.revision(s, studyId)
    const submitted = Boolean(s.db.prepare('SELECT 1 FROM imaging_read_submissions WHERE study_id = ? LIMIT 1').get(studyId))
    const state: ReviewState = latest ? (latest.revision === revision ? 'finalized' : 'amending') : submitted ? 'submitted' : 'reading'
    return {
      study_id: studyId, state, revision,
      latest_signoff: latest ? { version: latest.version, signed_by: latest.signed_by, signed_by_name: this.names(latest.signed_by), signed_at: latest.signed_at, mode: latest.mode } : null,
    }
  }

  /** 某一次定稿的完整快照（审核视图里查看历史版本） */
  signoff(a: Actor, studyId: string, version: number): Signoff {
    const s = this.studyScope(a, studyId, 'read')
    const row = s.db.prepare('SELECT * FROM imaging_signoffs WHERE study_id = ? AND version = ?').get(studyId, version) as SignoffRow | undefined
    if (!row) throw new PatientError('not_found', '没有这一次定稿', 404)
    return this.full(s, row)
  }

  // —— 初写完成（提交审核） ——

  /**
   * 初写医师声明阅片完成、提交审核：检查里不能还有待确认的 AI 检出。没有结节的检查也可以提交（「未见结节」也是结论）。
   * 这是医生本人的声明，AI 不能代做。
   */
  submitRead(a: Actor, studyId: string, input: { note?: unknown } = {}): ReviewSummary {
    if (a.via === 'ai') throw new PatientError('forbidden', '初写完成须由医生本人在界面上提交', 403)
    const s = this.studyScope(a, studyId, 'write')
    const lesions = this.lesions(s, studyId)
    const proposed = lesions.filter(l => l.status === 'proposed').length
    if (proposed) throw new ImagingError('pending_lesions', `还有 ${proposed} 个 AI 检出待确认或否决，处理完再提交`, 409)
    const cur = this.summaryIn(s, studyId)
    if (cur.state === 'finalized') throw new ImagingError('already_finalized', `检查已定稿（第 ${cur.latest_signoff!.version} 版），之后没有改动，不用再提交`, 409)
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : ''
    s.db.prepare('INSERT INTO imaging_read_submissions (study_id, user_id, at, revision, note_enc) VALUES (?, ?, ?, ?, ?)')
      .run(studyId, a.userId, now(), cur.revision, note ? s.encrypt(note) : null)
    s.log('imaging_read_submit', studyId)
    return this.summaryIn(s, studyId)
  }

  // —— 定稿（W5.2） ——

  /**
   * 定稿：只允许审核医师（个人空间为本人），须在诊疗组；AI 不能。expected_revision 须等于当前留痕位置（乐观锁：
   * 期间有人改了病灶、或别的审核医师已经定稿，都拒绝并要求刷新）。写入新的定稿版本与快照，旧版本保留不变。
   */
  finalize(a: Actor, studyId: string, input: { expected_revision?: unknown; note?: unknown }, opts: { isRunActive?: (runId: string) => boolean } = {}): Signoff {
    if (a.via === 'ai') throw new PatientError('forbidden', '定稿只能由审核医师本人在界面上操作，AI 不能定稿', 403)
    const s = this.studyScope(a, studyId, 'write')
    const expected = Number(input.expected_revision)
    if (input.expected_revision === undefined || input.expected_revision === null || !Number.isInteger(expected)) {
      throw new ImagingError('revision_required', '定稿请求须带 expected_revision（审核视图里的 revision），以免签下没看过的改动')
    }
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : ''
    s.db.exec('SAVEPOINT imaging_finalize')
    try {
      const ctx = this.context(a, s, studyId)
      const signoffs = this.signoffRows(s, studyId)
      const latest = signoffs[signoffs.length - 1] ?? null
      if (expected !== ctx.revision) throw new ImagingError('stale_revision', '审核视图打开后病灶又有改动（或已被别人定稿），请刷新、核对后再定稿', 409)
      const blocker = this.blockers(a, s, studyId, ctx, latest, opts)[0]
      if (blocker) throw new ImagingError(blocker.code, blocker.message, blocker.code === 'not_reviewer' || blocker.code === 'self_review' ? 403 : 409)

      const live = ctx.lesions.filter(l => l.status !== 'superseded')
      const snapshot: SnapshotLesion[] = live.map(l => ({
        id: l.id, version: l.version, kind: l.kind, source: l.source, status: l.status as SnapshotLesion['status'], reject_reason: l.reject_reason,
        label: l.label, location: l.location, metrics: l.metrics, seg_ref: l.seg_ref,
      }))
      const snapJson = JSON.stringify(snapshot)
      const version = (latest?.version ?? 0) + 1
      const id = 'so' + randomUUID().replace(/-/g, '').slice(0, 12)
      const mode: SignoffMode = ctx.personal ? 'single' : ctx.readers.has(a.userId) || ctx.readers.size === 0 ? 'self' : 'dual'
      const t = now()
      try {
        s.db.prepare(`INSERT INTO imaging_signoffs (id, study_id, version, signed_by, signed_at, revision, mode, readers, note_enc, snapshot, snapshot_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, studyId, version, a.userId, t, ctx.revision, mode, JSON.stringify([...ctx.readers]), note ? s.encrypt(note) : null, snapJson, createHash('sha256').update(snapJson).digest('hex'))
      } catch (err) {
        // 另一个进程同时定稿了同一版本（UNIQUE (study_id, version)）
        if (/UNIQUE/i.test(String((err as Error).message))) throw new ImagingError('stale_revision', '别的审核医师刚刚定稿了这个检查，请刷新', 409)
        throw err
      }
      // 每个病灶记一条定稿留痕（不计入留痕位置，见 revision）
      const ev = s.db.prepare('INSERT INTO imaging_lesion_events (lesion_id, at, user_id, via, action, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const l of snapshot) ev.run(l.id, t, a.userId, a.via, 'finalize', null, JSON.stringify({ signoff_id: id, signoff_version: version, lesion_version: l.version, status: l.status }))
      s.log('imaging_finalize', `${id} v${version}`)
      s.db.exec('RELEASE SAVEPOINT imaging_finalize')
      return this.full(s, s.db.prepare('SELECT * FROM imaging_signoffs WHERE id = ?').get(id) as unknown as SignoffRow)
    } catch (err) {
      s.db.exec('ROLLBACK TO SAVEPOINT imaging_finalize')
      s.db.exec('RELEASE SAVEPOINT imaging_finalize')
      throw err
    }
  }

  // —— 随访库（给随访对比与科研） ——

  /**
   * 检查最近一次定稿快照里已确认的病灶（进入随访库的结节与测量）；没定稿过为 null。
   * 定稿后的改动在再次定稿前不进这里，随访与科研读到的总是医生签过的值。
   */
  finalizedLesions(a: Actor, studyId: string): { study_id: string; signoff_id: string; version: number; signed_at: string; signed_by: string; stale: boolean; lesions: SnapshotLesion[] } | null {
    const s = this.studyScope(a, studyId, 'read')
    return this.finalizedIn(s, studyId)
  }

  /** 患者全部已定稿检查的随访库视图（按检查日期从早到晚） */
  finalizedStudies(a: Actor, patientId: string): Array<NonNullable<ReturnType<ImagingReviewService['finalizedLesions']>> & { study_date: string | null }> {
    const s = this.patients.imagingScope(a, patientId, 'read')
    ensureReviewSchema(s.db)
    const rows = s.db.prepare('SELECT id, study_date FROM imaging_studies WHERE patient_id = ? ORDER BY COALESCE(study_date, created_at), created_at, rowid').all(patientId) as Array<{ id: string; study_date: string | null }>
    return rows.flatMap(r => { const f = this.finalizedIn(s, r.id); return f ? [{ ...f, study_date: r.study_date }] : [] })
  }

  private finalizedIn(s: ImagingScope, studyId: string) {
    const rows = this.signoffRows(s, studyId)
    const latest = rows[rows.length - 1]
    if (!latest) return null
    const lesions = (JSON.parse(latest.snapshot) as SnapshotLesion[]).filter(l => l.status === 'confirmed')
    return { study_id: studyId, signoff_id: latest.id, version: latest.version, signed_at: latest.signed_at, signed_by: latest.signed_by, stale: latest.revision !== this.revision(s, studyId), lesions }
  }

  // —— 内部 ——

  private studyScope(a: Actor, studyId: string, need: 'read' | 'write'): ImagingScope {
    const lookup = this.patients.imagingLookup(a)
    const row = lookup.db.prepare('SELECT patient_id FROM imaging_studies WHERE id = ?').get(studyId) as { patient_id: string } | undefined
    if (!row) throw new PatientError('not_found', '影像检查不存在', 404)
    const s = this.patients.imagingScope(a, row.patient_id, need)
    ensureReviewSchema(s.db)
    return s
  }

  private lesions(s: ImagingScope, studyId: string): LesionRow[] {
    return (s.db.prepare(VISIBLE_LESIONS).all(studyId) as Array<Record<string, unknown>>).map(r => ({ ...(r as unknown as LesionRow), metrics: JSON.parse((r.metrics as string) || '{}') }))
  }

  /** 留痕位置：检查可见病灶的最大事件 id（不含定稿标记；影子病灶不算）。任何病灶改动都会让它变大 */
  private revision(s: ImagingScope, studyId: string): number {
    const r = s.db.prepare(`SELECT MAX(e.id) AS m FROM imaging_lesion_events e JOIN imaging_lesions l ON l.id = e.lesion_id LEFT JOIN imaging_runs r ON r.id = l.run_id
      WHERE l.study_id = ? AND (r.id IS NULL OR r.visibility = 'visible') AND e.action != 'finalize'`).get(studyId) as { m: number | null }
    return r.m ?? 0
  }

  private signoffRows(s: ImagingScope, studyId: string): SignoffRow[] {
    return s.db.prepare('SELECT * FROM imaging_signoffs WHERE study_id = ? ORDER BY version').all(studyId) as unknown as SignoffRow[]
  }

  /**
   * 计算审核视图与定稿共用的上下文。初写 / 审核的区分（只看留痕，不另记）：
   * - 首次「初写完成」之前的医生改动，都算初写（包括审核医师提前动手的，此人因此也算本检查的初写医师）；
   * - 之后的改动：提交过初写的人、或角色不是审核的人做的算初写；其余（审核医师）算审核；
   * - AI 检出的 create 是 AI 原值；重新分析取代、后台补肺叶、定稿标记是系统留痕，不算任何一方的修改。
   */
  private context(a: Actor, s: ImagingScope, studyId: string) {
    const ts = this.patients.tenantService
    const tenant = ts.of(a.userId, a.space ?? 'work')
    const personal = tenant.kind === 'personal'
    const selfReviewAllowed = ts.settings(tenant).imaging_self_review === true
    const roles = new Map((s.db.prepare('SELECT user_id, role FROM imaging_reading_roles').all() as Array<{ user_id: string; role: ReadingRole }>).map(r => [r.user_id, r.role]))
    const roleOf = (u: string): ReadingRole => roles.get(u) ?? 'reader'
    const lesions = this.lesions(s, studyId)
    const ids = new Set(lesions.map(l => l.id))
    const events = (s.db.prepare(`SELECT e.* FROM imaging_lesion_events e JOIN imaging_lesions l ON l.id = e.lesion_id WHERE l.study_id = ? ORDER BY e.id`).all(studyId) as unknown as EventRow[])
      .filter(e => ids.has(e.lesion_id))
    const eventsByLesion = new Map<string, EventRow[]>()
    for (const e of events) { const arr = eventsByLesion.get(e.lesion_id) ?? []; arr.push(e); eventsByLesion.set(e.lesion_id, arr) }
    const submissions = s.db.prepare('SELECT user_id, at, revision FROM imaging_read_submissions WHERE study_id = ? ORDER BY id').all(studyId) as Array<{ user_id: string; at: string; revision: number }>
    const firstSubmit = submissions[0]?.revision ?? null
    const submitters = new Set(submissions.map(x => x.user_id))
    const byId = new Map(lesions.map(l => [l.id, l]))
    const classify = (e: EventRow, l: LesionRow | undefined = byId.get(e.lesion_id)): ChangePhase | 'ai' | 'system' => {
      if (SYSTEM_ACTIONS.has(e.action)) return 'system'
      if (e.via === 'ai' || (e.action === 'create' && l?.source === 'ai')) return 'ai'
      if (firstSubmit === null || e.id <= firstSubmit) return 'reader'
      return submitters.has(e.user_id) || roleOf(e.user_id) !== 'reviewer' ? 'reader' : 'reviewer'
    }
    const readers = new Set<string>(submitters)
    for (const e of events) if (classify(e) === 'reader') readers.add(e.user_id)
    const revision = this.revision(s, studyId)
    const state = (latest: SignoffRow | null): ReviewState => latest ? (latest.revision === revision ? 'finalized' : 'amending') : submissions.length ? 'submitted' : 'reading'
    return { personal, selfReviewAllowed, roleOf, lesions, eventsByLesion, submissions, readers, classify, revision, state }
  }

  /** 当前操作者不能定稿的原因（按严重程度排列；空 = 可以定稿） */
  private blockers(a: Actor, s: ImagingScope, studyId: string, ctx: ReturnType<ImagingReviewService['context']>, latest: SignoffRow | null, opts: { isRunActive?: (runId: string) => boolean }): Array<{ code: string; message: string }> {
    const out: Array<{ code: string; message: string }> = []
    if (a.via === 'ai') return [{ code: 'forbidden', message: '定稿只能由审核医师本人在界面上操作，AI 不能定稿' }]
    if (!ctx.personal && ctx.roleOf(a.userId) !== 'reviewer') out.push({ code: 'not_reviewer', message: '只有审核医师能定稿（请机构管理员在「成员」里设置阅片角色）' })
    if (latest && latest.revision === ctx.revision) out.push({ code: 'already_finalized', message: `已定稿（第 ${latest.version} 版），之后没有改动` })
    if (!ctx.personal && !latest && !ctx.submissions.length) out.push({ code: 'not_submitted', message: '初写医师还没有提交（初写完成后才能定稿）' })
    if (!ctx.personal && !ctx.selfReviewAllowed && (ctx.readers.has(a.userId) || ctx.readers.size === 0)) {
      out.push({ code: 'self_review', message: '本检查的初写是你本人，本机构不允许自审：请由另一位审核医师定稿' })
    }
    const live = ctx.lesions.filter(l => l.status !== 'superseded')
    const proposed = live.filter(l => l.status === 'proposed').length
    if (proposed) out.push({ code: 'pending_lesions', message: `还有 ${proposed} 个 AI 检出待确认或否决` })
    if (live.some(l => l.metrics.lobe_status === 'pending')) out.push({ code: 'locating', message: '有结节的肺叶还在定位中，请稍候再定稿' })
    if (opts.isRunActive) {
      const runs = s.db.prepare(`SELECT id FROM imaging_runs WHERE study_id = ? AND visibility = 'visible' AND task != ? AND status IN ('queued', 'running')`).all(studyId, POINT_TASK) as Array<{ id: string }>
      if (runs.some(r => opts.isRunActive!(r.id))) out.push({ code: 'analysis_running', message: 'AI 分析还在进行，完成后再定稿' })
    }
    return out
  }

  private change(e: EventRow, phase: ChangePhase, signoffs: SignoffRow[]): ReviewChange {
    const before = e.before ? JSON.parse(e.before) as LesionRow : null
    const after = e.after ? JSON.parse(e.after) as LesionRow : null
    const changes: ReviewChange['changes'] = {}
    for (const k of FIELD_KEYS) if (!same(before?.[k], after?.[k])) changes[k] = { before: before?.[k] ?? null, after: after?.[k] ?? null }
    const mb = pickMeasures(before?.metrics), ma = pickMeasures(after?.metrics)
    for (const k of MEASURE_KEYS) if (!same(mb[k], ma[k])) changes[k] = { before: mb[k] ?? null, after: ma[k] ?? null }
    // 留痕位置大于某次定稿的 revision，即发生在那次定稿之后
    const afterSignoff = signoffs.filter(x => e.id > x.revision).length
    return { event_id: e.id, at: e.at, user_id: e.user_id, user_name: this.names(e.user_id), action: e.action, phase, after_signoff: afterSignoff, changes }
  }

  private meta(r: SignoffRow): SignoffMeta {
    const snap = JSON.parse(r.snapshot) as SnapshotLesion[]
    return {
      id: r.id, study_id: r.study_id, version: r.version, signed_by: r.signed_by, signed_by_name: this.names(r.signed_by), signed_at: r.signed_at,
      revision: r.revision, mode: r.mode, readers: JSON.parse(r.readers) as string[], snapshot_hash: r.snapshot_hash,
      lesions: { total: snap.length, confirmed: snap.filter(l => l.status === 'confirmed').length, rejected: snap.filter(l => l.status === 'rejected').length },
    }
  }

  private full(s: ImagingScope, r: SignoffRow): Signoff {
    return { ...this.meta(r), note: r.note_enc ? s.decrypt(r.note_enc) : null, lesions_snapshot: JSON.parse(r.snapshot) as SnapshotLesion[] }
  }
}
