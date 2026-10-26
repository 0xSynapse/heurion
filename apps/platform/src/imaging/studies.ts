import { randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'
import { PatientError, type Actor, type ImagingScope, type PatientService } from '../tenancy/patients.ts'
import { OrthancError, type Orthanc } from './orthanc.ts'

/**
 * 影像检查、AI 运行与病灶（docs/design/IMAGING_STUDIES.md）。
 * 表在机构患者库里（tenancy/patients.ts），权限一律经 PatientService.imagingScope：读要能看到患者，写要是诊疗组成员。
 * DICOM 原件存在 Orthanc；本库只存检查 / 序列的索引、加密的 UID 与描述、AI 结果和医生的确认留痕。
 */

/** 影像接口的错误（状态码可能是 413 / 503 等，PatientError 不覆盖这些）。 */
export class ImagingError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 502 | 503 = 400) { super(message) }
}

export interface SeriesView {
  id: string
  series_uid?: string
  modality: string | null
  body_part: string | null
  description: string | null
  slice_thickness: number | null
  kernel: string | null
  instances: number
}

export interface StudyView {
  id: string
  patient_id: string
  /** 只给界面（OHIF 按 UID 打开检查）；给 AI 的视图不含 UID */
  study_uid?: string
  study_date: string | null
  modalities: string[]
  description: string | null
  accession?: string | null
  source: 'upload' | 'pacs'
  status: string
  created_at: string
  series: SeriesView[]
  lesions: { proposed: number; confirmed: number; rejected: number }
  /** 最近的 AI 分析（新的在前，最多 5 次；影子模式的不列） */
  runs: Array<Pick<RunRow, 'id' | 'task' | 'model_id' | 'model_version' | 'status' | 'error' | 'summary' | 'created_at' | 'finished_at'>>
}

export interface ImportResult {
  studies: StudyView[]
  files: { received: number; uploaded: number; duplicates: number; skipped: Array<{ name: string; reason: string }> }
  /** 检查已属于本机构另一位患者，未关联到当前患者（不透露是哪位） */
  conflicts: number
}

/** superseded = 重新分析后被新结果取代的、从未经医生处理的 AI 检出 */
export type LesionStatus = 'proposed' | 'confirmed' | 'rejected' | 'superseded'
export interface LesionRow {
  id: string
  study_id: string
  run_id: string | null
  kind: string
  source: 'ai' | 'manual'
  status: LesionStatus
  reject_reason: string | null
  label: string | null
  location: string | null
  metrics: Record<string, unknown>
  seg_ref: string | null
  version: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface RunRow {
  id: string
  study_id: string
  series_id: string | null
  task: string
  model_id: string
  model_version: string | null
  status: 'queued' | 'running' | 'done' | 'failed'
  error: string | null
  visibility: 'visible' | 'shadow'
  /** 完成后的摘要：质控、警告、耗时、设备、检出数 */
  summary: Record<string, unknown> | null
  created_by: string
  created_at: string
  started_at: string | null
  finished_at: string | null
}

const now = () => new Date().toISOString()
const rid = (p: string) => p + randomUUID().replace(/-/g, '').slice(0, 12)

/** DICOM Part 10 文件在 128 字节前导后有 'DICM' 标记 */
export function isDicomPart10(bytes: Uint8Array): boolean {
  return bytes.byteLength > 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d
}
const isZip = (bytes: Uint8Array) => bytes.byteLength > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04

/** 把上传的文件（单个 DICOM 或 zip）展开成待入库的 DICOM 文件；其它文件记为跳过 */
export function expandUpload(files: Array<{ name: string; bytes: Uint8Array }>): { dicom: Array<{ name: string; bytes: Uint8Array }>; skipped: Array<{ name: string; reason: string }> } {
  const dicom: Array<{ name: string; bytes: Uint8Array }> = []
  const skipped: Array<{ name: string; reason: string }> = []
  const take = (name: string, bytes: Uint8Array) => {
    const base = name.split('/').pop() ?? name
    if (!base || base.startsWith('.') || name.includes('__MACOSX/')) return
    if (base.toUpperCase() === 'DICOMDIR') { skipped.push({ name, reason: 'DICOMDIR 目录文件不入库' }); return }
    if (isDicomPart10(bytes)) dicom.push({ name, bytes })
    else skipped.push({ name, reason: '不是 DICOM 文件' })
  }
  for (const f of files) {
    if (isZip(f.bytes)) {
      let entries: Record<string, Uint8Array>
      try { entries = unzipSync(f.bytes) } catch { skipped.push({ name: f.name, reason: '压缩包无法解开' }); continue }
      for (const [name, bytes] of Object.entries(entries)) if (!name.endsWith('/')) take(`${f.name}/${name}`, bytes)
    } else take(f.name, f.bytes)
  }
  return { dicom, skipped }
}

const lesionOf = (r: Record<string, unknown>): LesionRow => ({ ...(r as unknown as LesionRow), metrics: JSON.parse((r.metrics as string) || '{}') })
const runOf = (r: Record<string, unknown>): RunRow => ({ ...(r as unknown as RunRow), summary: r.summary ? JSON.parse(r.summary as string) : null })

export class ImagingStudyService {
  constructor(private readonly patients: PatientService, private readonly orthanc: Orthanc | null) {}

  private requireOrthanc(): Orthanc {
    if (!this.orthanc) throw new ImagingError('orthanc_not_configured', '本机构没有配置影像存储（Orthanc），暂不能上传 DICOM', 503)
    return this.orthanc
  }

  // —— 检查 ——

  /** 手工上传 DICOM（W1.0）：入 Orthanc，再按 StudyInstanceUID 建立 / 更新本患者的检查索引。AI 不能调用。 */
  async importDicom(a: Actor, patientId: string, files: Array<{ name: string; bytes: Uint8Array }>): Promise<ImportResult> {
    if (a.via === 'ai') throw new PatientError('forbidden', '上传 DICOM 原件只能由医生在界面上操作', 403)
    const s = this.patients.imagingScope(a, patientId, 'write')
    const orthanc = this.requireOrthanc()
    const { dicom, skipped } = expandUpload(files)
    if (!dicom.length) throw new ImagingError('no_dicom', skipped.length ? `没有可入库的 DICOM 文件（${skipped[0]!.reason}）` : '没有收到文件')

    const studies = new Map<string, Set<string>>()
    let uploaded = 0, duplicates = 0
    for (const f of dicom) {
      try {
        const r = await orthanc.upload(f.bytes)
        if (r.status === 'AlreadyStored') duplicates++
        else uploaded++
        const set = studies.get(r.studyId) ?? new Set<string>()
        set.add(r.seriesId)
        studies.set(r.studyId, set)
      } catch (err) {
        if (err instanceof OrthancError && err.status === 400) { skipped.push({ name: f.name, reason: err.message }); continue }
        throw this.storageError(err)
      }
    }

    const linked: string[] = []
    let conflicts = 0
    for (const [orthancStudyId, seriesIds] of studies) {
      const id = await this.linkStudy(s, a, orthanc, orthancStudyId, seriesIds)
      if (id) linked.push(id)
      else conflicts++
    }
    const all = this.listIn(s, true)
    return { studies: all.filter(st => linked.includes(st.id)), files: { received: dicom.length + skipped.length, uploaded, duplicates, skipped }, conflicts }
  }

  private storageError(err: unknown): ImagingError {
    if (err instanceof ImagingError) return err
    if (err instanceof OrthancError) return new ImagingError('orthanc_error', err.message, err.status === 503 ? 503 : 502)
    return new ImagingError('orthanc_error', `影像存储出错：${err instanceof Error ? err.message : String(err)}`, 502)
  }

  /** 建立或更新一个检查的索引；检查已属于其他患者时不关联，返回 null */
  private async linkStudy(s: ImagingScope, a: Actor, orthanc: Orthanc, orthancStudyId: string, seriesIds: Set<string>): Promise<string | null> {
    let tags
    try { tags = await orthanc.study(orthancStudyId) } catch (err) { throw this.storageError(err) }
    const hmac = s.uidKey('study', tags.studyUid)
    const existing = s.db.prepare('SELECT id, patient_id FROM imaging_studies WHERE uid_hmac = ?').get(hmac) as { id: string; patient_id: string } | undefined
    if (existing && existing.patient_id !== s.patientId) {
      s.log('imaging_upload_conflict', null)
      return null
    }
    const series: Array<{ orthancId: string; tags: Awaited<ReturnType<Orthanc['series']>> }> = []
    for (const sid of new Set([...tags.series, ...seriesIds])) {
      try { series.push({ orthancId: sid, tags: await orthanc.series(sid) }) } catch (err) { throw this.storageError(err) }
    }
    const modalities = [...new Set(series.map(x => x.tags.modality).filter((m): m is string => Boolean(m)))]
    const t = now()
    let studyId = existing?.id
    s.db.exec('SAVEPOINT imaging_link')
    try {
      if (studyId) {
        s.db.prepare('UPDATE imaging_studies SET orthanc_id = ?, study_date = ?, modalities = ?, description_enc = ?, accession_enc = ?, updated_at = ? WHERE id = ?')
          .run(orthancStudyId, tags.studyDate, JSON.stringify(modalities), s.encrypt(tags.description), s.encrypt(tags.accession), t, studyId)
      } else {
        studyId = rid('is')
        s.db.prepare(`INSERT INTO imaging_studies (id, patient_id, uid_hmac, uid_enc, orthanc_id, source, study_date, modalities, description_enc, accession_enc, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, 'received', ?, ?, ?)`)
          .run(studyId, s.patientId, hmac, s.encrypt(tags.studyUid)!, orthancStudyId, tags.studyDate, JSON.stringify(modalities), s.encrypt(tags.description), s.encrypt(tags.accession), a.userId, t, t)
      }
      for (const x of series) {
        const sh = s.uidKey('series', x.tags.seriesUid)
        const row = s.db.prepare('SELECT id FROM imaging_series WHERE uid_hmac = ?').get(sh) as { id: string } | undefined
        if (row) {
          s.db.prepare('UPDATE imaging_series SET orthanc_id = ?, modality = ?, body_part = ?, description_enc = ?, slice_thickness = ?, kernel = ?, instances = ? WHERE id = ? AND study_id = ?')
            .run(x.orthancId, x.tags.modality, x.tags.bodyPart, s.encrypt(x.tags.description), x.tags.sliceThickness, x.tags.kernel, x.tags.instances, row.id, studyId)
        } else {
          s.db.prepare(`INSERT INTO imaging_series (id, study_id, uid_hmac, uid_enc, orthanc_id, modality, body_part, description_enc, slice_thickness, kernel, instances, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(rid('se'), studyId, sh, s.encrypt(x.tags.seriesUid)!, x.orthancId, x.tags.modality, x.tags.bodyPart, s.encrypt(x.tags.description), x.tags.sliceThickness, x.tags.kernel, x.tags.instances, t)
        }
      }
      s.db.exec('RELEASE SAVEPOINT imaging_link')
    } catch (err) {
      s.db.exec('ROLLBACK TO SAVEPOINT imaging_link')
      s.db.exec('RELEASE SAVEPOINT imaging_link')
      throw err
    }
    s.log(existing ? 'imaging_upload_update' : 'imaging_upload', studyId!)
    return studyId!
  }

  /** 患者的影像检查（新的在前）。forUi = true 时带 UID 与检查号（界面用）；AI 视图不带。 */
  listStudies(a: Actor, patientId: string, forUi = false): StudyView[] {
    const s = this.patients.imagingScope(a, patientId, 'read')
    return this.listIn(s, forUi)
  }

  private listIn(s: ImagingScope, forUi: boolean): StudyView[] {
    const rows = s.db.prepare('SELECT * FROM imaging_studies WHERE patient_id = ? ORDER BY COALESCE(study_date, created_at) DESC, created_at DESC, rowid DESC').all(s.patientId) as Array<Record<string, unknown>>
    return rows.map(r => {
      const series = (s.db.prepare('SELECT * FROM imaging_series WHERE study_id = ? ORDER BY created_at, rowid').all(r.id as string) as Array<Record<string, unknown>>).map(x => ({
        id: x.id as string, ...(forUi ? { series_uid: s.decrypt(x.uid_enc as string)! } : {}),
        modality: (x.modality as string | null) ?? null, body_part: (x.body_part as string | null) ?? null, description: s.decrypt((x.description_enc as string | null) ?? null),
        slice_thickness: (x.slice_thickness as number | null) ?? null, kernel: (x.kernel as string | null) ?? null, instances: x.instances as number,
      }))
      const counts = { proposed: 0, confirmed: 0, rejected: 0 }
      for (const c of s.db.prepare(`SELECT l.status, COUNT(*) AS n FROM imaging_lesions l LEFT JOIN imaging_runs r ON r.id = l.run_id
        WHERE l.study_id = ? AND l.status != 'superseded' AND (r.id IS NULL OR r.visibility = 'visible') GROUP BY l.status`).all(r.id as string) as Array<{ status: Exclude<LesionStatus, 'superseded'>; n: number }>) counts[c.status] = c.n
      const runs = (s.db.prepare(`SELECT * FROM imaging_runs WHERE study_id = ? AND visibility = 'visible' ORDER BY created_at DESC, rowid DESC LIMIT 5`).all(r.id as string) as Array<Record<string, unknown>>)
        .map(runOf).map(x => ({ id: x.id, task: x.task, model_id: x.model_id, model_version: x.model_version, status: x.status, error: x.error, summary: x.summary, created_at: x.created_at, finished_at: x.finished_at }))
      return {
        id: r.id as string, patient_id: r.patient_id as string, ...(forUi ? { study_uid: s.decrypt(r.uid_enc as string)!, accession: s.decrypt((r.accession_enc as string | null) ?? null) } : {}),
        study_date: (r.study_date as string | null) ?? null, modalities: JSON.parse(r.modalities as string) as string[], description: s.decrypt((r.description_enc as string | null) ?? null),
        source: r.source as StudyView['source'], status: r.status as string, created_at: r.created_at as string, series, lesions: counts, runs,
      }
    })
  }

  /** DICOMweb 代理用：按 StudyInstanceUID 找到检查并校验能看到该患者；找不到或看不到都当不存在 */
  resolveStudyUid(a: Actor, studyUid: string): { studyId: string; scope: ImagingScope } {
    const l = this.patients.imagingLookup(a)
    const row = l.db.prepare('SELECT id, patient_id FROM imaging_studies WHERE uid_hmac = ?').get(l.uidKey('study', studyUid)) as { id: string; patient_id: string } | undefined
    if (!row) throw new PatientError('not_found', '影像检查不存在', 404)
    return { studyId: row.id, scope: this.patients.imagingScope(a, row.patient_id, 'read') }
  }

  private studyScope(a: Actor, studyId: string, need: 'read' | 'write'): ImagingScope {
    const row = this.patients.imagingLookup(a).db.prepare('SELECT patient_id FROM imaging_studies WHERE id = ?').get(studyId) as { patient_id: string } | undefined
    if (!row) throw new PatientError('not_found', '影像检查不存在', 404)
    return this.patients.imagingScope(a, row.patient_id, need)
  }

  // —— AI 运行 ——

  startRun(a: Actor, studyId: string, input: { task: string; model_id: string; model_version?: string | null; series_id?: string | null; visibility?: 'visible' | 'shadow' }): RunRow {
    const s = this.studyScope(a, studyId, 'write')
    if (input.series_id && !s.db.prepare('SELECT 1 FROM imaging_series WHERE id = ? AND study_id = ?').get(input.series_id, studyId)) throw new PatientError('not_found', '序列不存在', 404)
    const id = rid('ir')
    s.db.prepare(`INSERT INTO imaging_runs (id, study_id, series_id, task, model_id, model_version, status, visibility, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(id, studyId, input.series_id ?? null, input.task, input.model_id, input.model_version ?? null, input.visibility ?? 'visible', a.userId, now())
    return this.run(s, id)
  }

  setRunStatus(a: Actor, runId: string, status: RunRow['status'], error: string | null = null, extra: { summary?: Record<string, unknown> | null; model_version?: string | null } = {}): RunRow {
    const s = this.runScope(a, runId, 'write')
    const t = now()
    s.db.prepare(`UPDATE imaging_runs SET status = ?, error = ?, started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
      finished_at = CASE WHEN ? IN ('done', 'failed') THEN ? ELSE finished_at END,
      summary = COALESCE(?, summary), model_version = COALESCE(?, model_version) WHERE id = ?`)
      .run(status, error, status, t, status, t, extra.summary ? JSON.stringify(extra.summary) : null, extra.model_version ?? null, runId)
    return this.run(s, runId)
  }

  /** 分析流水线用：运行、所属检查、所分析序列在 Orthanc 中的 id */
  runSource(a: Actor, runId: string): { run: RunRow; seriesOrthancId: string | null } {
    const s = this.runScope(a, runId, 'read')
    const run = this.run(s, runId)
    const se = run.series_id ? s.db.prepare('SELECT orthanc_id FROM imaging_series WHERE id = ?').get(run.series_id) as { orthanc_id: string | null } | undefined : undefined
    return { run, seriesOrthancId: se?.orthanc_id ?? null }
  }

  /** 检查的序列（选序列用，不含 UID） */
  seriesOf(a: Actor, studyId: string): SeriesView[] {
    const s = this.studyScope(a, studyId, 'read')
    return (s.db.prepare('SELECT * FROM imaging_series WHERE study_id = ? ORDER BY created_at, rowid').all(studyId) as Array<Record<string, unknown>>).map(x => ({
      id: x.id as string, modality: (x.modality as string | null) ?? null, body_part: (x.body_part as string | null) ?? null, description: s.decrypt((x.description_enc as string | null) ?? null),
      slice_thickness: (x.slice_thickness as number | null) ?? null, kernel: (x.kernel as string | null) ?? null, instances: x.instances as number,
    }))
  }

  /** 重新分析成功后：同一任务旧运行里从未经医生处理的检出标为 superseded（医生确认 / 否决过的保留） */
  supersedeProposed(a: Actor, runId: string): number {
    const s = this.runScope(a, runId, 'write')
    const run = this.run(s, runId)
    const stale = (s.db.prepare(`SELECT l.* FROM imaging_lesions l JOIN imaging_runs r ON r.id = l.run_id
      WHERE l.study_id = ? AND l.status = 'proposed' AND r.task = ? AND r.id != ?`).all(run.study_id, run.task, runId) as Array<Record<string, unknown>>).map(lesionOf)
    for (const before of stale) {
      s.db.prepare("UPDATE imaging_lesions SET status = 'superseded', updated_at = ? WHERE id = ?").run(now(), before.id)
      this.event(s, a, before.id, 'supersede', before, this.lesion(s, before.id))
    }
    return stale.length
  }

  private runScope(a: Actor, runId: string, need: 'read' | 'write'): ImagingScope {
    const studyId = (this.patients.imagingLookup(a).db.prepare('SELECT study_id FROM imaging_runs WHERE id = ?').get(runId) as { study_id: string } | undefined)?.study_id
    if (!studyId) throw new PatientError('not_found', '分析任务不存在', 404)
    return this.studyScope(a, studyId, need)
  }

  private run(s: ImagingScope, id: string): RunRow {
    return runOf(s.db.prepare('SELECT * FROM imaging_runs WHERE id = ?').get(id) as Record<string, unknown>)
  }

  // —— 病灶 ——

  /** AI 检出（source = ai，待确认）或医生补充（source = manual，直接算已确认） */
  addLesion(a: Actor, studyId: string, input: { run_id?: string | null; kind: string; source: 'ai' | 'manual'; label?: string | null; location?: string | null; metrics?: Record<string, unknown>; seg_ref?: string | null }): LesionRow {
    const s = this.studyScope(a, studyId, 'write')
    if (input.source === 'manual' && a.via === 'ai') throw new PatientError('forbidden', '医生补充的病灶只能由医生在界面上添加', 403)
    if (input.run_id && !s.db.prepare('SELECT 1 FROM imaging_runs WHERE id = ? AND study_id = ?').get(input.run_id, studyId)) throw new PatientError('not_found', '分析任务不存在', 404)
    const id = rid('le')
    const t = now()
    const status: LesionStatus = input.source === 'manual' ? 'confirmed' : 'proposed'
    s.db.prepare(`INSERT INTO imaging_lesions (id, study_id, run_id, kind, source, status, label, location, metrics, seg_ref, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, studyId, input.run_id ?? null, input.kind, input.source, status, input.label ?? null, input.location ?? null, JSON.stringify(input.metrics ?? {}), input.seg_ref ?? null, a.userId, t, t)
    const row = this.lesion(s, id)
    this.event(s, a, id, 'create', null, row)
    return row
  }

  /** 医生确认 / 否决（W2.3）。AI 不能做这一步。 */
  reviewLesion(a: Actor, lesionId: string, decision: { status: 'confirmed' | 'rejected'; reason?: string | null }): LesionRow {
    if (a.via === 'ai') throw new PatientError('needs_human_review', '确认或否决病灶须由医生在界面上操作', 403)
    const { s, before } = this.lesionScope(a, lesionId)
    const reason = decision.status === 'rejected' ? (decision.reason?.trim() || null) : null
    s.db.prepare('UPDATE imaging_lesions SET status = ?, reject_reason = ?, updated_at = ? WHERE id = ?').run(decision.status, reason, now(), lesionId)
    const after = this.lesion(s, lesionId)
    this.event(s, a, lesionId, decision.status === 'confirmed' ? 'confirm' : 'reject', before, after)
    return after
  }

  /** 修改测量、位置或分割（医生修边界、重测）；版本号加一并留痕 */
  editLesion(a: Actor, lesionId: string, change: { metrics?: Record<string, unknown>; location?: string | null; label?: string | null; seg_ref?: string | null }): LesionRow {
    const { s, before } = this.lesionScope(a, lesionId)
    s.db.prepare(`UPDATE imaging_lesions SET metrics = ?, location = ?, label = ?, seg_ref = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(change.metrics ?? before.metrics), change.location !== undefined ? change.location : before.location,
      change.label !== undefined ? change.label : before.label, change.seg_ref !== undefined ? change.seg_ref : before.seg_ref, now(), lesionId)
    const after = this.lesion(s, lesionId)
    this.event(s, a, lesionId, 'edit', before, after)
    return after
  }

  /** 检查的病灶；影子模式运行产生的病灶默认不返回（只给内部评估用） */
  listLesions(a: Actor, studyId: string, opts: { includeShadow?: boolean } = {}): LesionRow[] {
    const s = this.studyScope(a, studyId, 'read')
    const rows = s.db.prepare(`SELECT l.* FROM imaging_lesions l LEFT JOIN imaging_runs r ON r.id = l.run_id
      WHERE l.study_id = ? AND l.status != 'superseded' AND (? OR r.id IS NULL OR r.visibility = 'visible') ORDER BY l.created_at, l.rowid`).all(studyId, opts.includeShadow && a.via !== 'ai' ? 1 : 0) as Array<Record<string, unknown>>
    return rows.map(lesionOf)
  }

  /**
   * 阅片器（OHIF 结节面板）用：按 StudyInstanceUID 取病灶，附上所在序列的 SeriesInstanceUID，
   * 以便在阅片器里找到对应的影像（关键层 SOPInstanceUID 与病人坐标由 worker 写在 metrics 里）。
   */
  lesionsByStudyUid(a: Actor, studyUid: string): Array<LesionRow & { series_uid: string | null }> {
    const { studyId, scope: s } = this.resolveStudyUid(a, studyUid)
    const seriesUid = new Map<string, string | null>()
    return this.listLesions(a, studyId).map(l => {
      const run = l.run_id ? s.db.prepare('SELECT series_id FROM imaging_runs WHERE id = ?').get(l.run_id) as { series_id: string | null } | undefined : undefined
      const sid = run?.series_id ?? null
      if (sid && !seriesUid.has(sid)) {
        const row = s.db.prepare('SELECT uid_enc FROM imaging_series WHERE id = ?').get(sid) as { uid_enc: string } | undefined
        seriesUid.set(sid, row ? s.decrypt(row.uid_enc) : null)
      }
      return { ...l, series_uid: sid ? seriesUid.get(sid) ?? null : null }
    })
  }

  /** 病灶所属的检查与患者（接口校验路径里的患者 id 用） */
  lesionOwner(a: Actor, lesionId: string): { studyId: string; patientId: string } {
    const { s, before } = this.lesionScope(a, lesionId, 'read')
    return { studyId: before.study_id, patientId: s.patientId }
  }

  /** 病灶所属检查的 StudyInstanceUID（阅片器校验 Cookie 允许的检查用） */
  studyUidOfLesion(a: Actor, lesionId: string): string {
    const { s, before } = this.lesionScope(a, lesionId, 'read')
    const row = s.db.prepare('SELECT uid_enc FROM imaging_studies WHERE id = ?').get(before.study_id) as { uid_enc: string }
    return s.decrypt(row.uid_enc)!
  }

  lesionEvents(a: Actor, lesionId: string): Array<{ at: string; user_id: string; via: string; action: string; before: unknown; after: unknown }> {
    const { s } = this.lesionScope(a, lesionId, 'read')
    return (s.db.prepare('SELECT at, user_id, via, action, before, after FROM imaging_lesion_events WHERE lesion_id = ? ORDER BY id').all(lesionId) as Array<Record<string, unknown>>)
      .map(e => ({ at: e.at as string, user_id: e.user_id as string, via: e.via as string, action: e.action as string, before: e.before ? JSON.parse(e.before as string) : null, after: e.after ? JSON.parse(e.after as string) : null }))
  }

  private lesionScope(a: Actor, lesionId: string, need: 'read' | 'write' = 'write'): { s: ImagingScope; before: LesionRow } {
    const row = this.patients.imagingLookup(a).db.prepare('SELECT study_id FROM imaging_lesions WHERE id = ?').get(lesionId) as { study_id: string } | undefined
    if (!row) throw new PatientError('not_found', '病灶不存在', 404)
    const s = this.studyScope(a, row.study_id, need)
    return { s, before: this.lesion(s, lesionId) }
  }

  private lesion(s: ImagingScope, id: string): LesionRow {
    return lesionOf(s.db.prepare('SELECT * FROM imaging_lesions WHERE id = ?').get(id) as Record<string, unknown>)
  }

  private event(s: ImagingScope, a: Actor, lesionId: string, action: string, before: LesionRow | null, after: LesionRow | null): void {
    s.db.prepare('INSERT INTO imaging_lesion_events (lesion_id, at, user_id, via, action, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(lesionId, now(), a.userId, a.via, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null)
    s.log(`lesion_${action}`, lesionId)
  }
}
