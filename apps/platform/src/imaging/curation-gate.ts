import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { PatientError, type Actor, type ImagingScope, type PatientService } from '../tenancy/patients.ts'
import { ensureReviewSchema, type SignoffMode, type SnapshotLesion } from './review.ts'
import { ImagingError, type LesionRow } from './studies.ts'

/**
 * 标注库与模型发布门控（PRD W7.1–W7.4，T3.6；docs/design/IMAGING_STUDIES.md「标注库与发布门控（T3.6）」）。
 *
 * - W7.1 结构化标注回收（imaging_curation_entries）：
 *   审核医师定稿（W5.2）后，定稿快照里的已确认结节（含 AI 检出确认、边界修正、医生补充漏检）与已否决假阳性（含否决原因）
 *   自动进入已核实标注库（quality_tier = 'high_verified'）。每条记录完整保留 AI 原始输出（ai_original_metrics / ai_original_seg_ref）、
 *   定稿最终值（final_metrics / seg_ref）、修改幅度（modification_magnitude）、审核人级别与定稿版本。
 *   未定稿的初级医师标注严禁进入高可信度训练集（ingestStudy 对未定稿检查抛出 unfinalized_not_admitted）。
 * - W7.2 标注一致性控制（imaging_curation_dual_samples）：
 *   支持对抽样检查（默认 10% 抽样目标）录入两名高年资医师的独立标注（Dice 与径线），自动汇总医师间分割 Dice 均值与
 *   Bland-Altman 径线差异（偏倚与 95% LoA），供写入《模型说明与评测报告》。
 * - W7.4 模型发布门控与双人审批回滚（imaging_model_releases）：
 *   新版本模型上线前须在固定评测集与院内测试集上通过非劣效门控（整体与全部大小/密度亚组灵敏度、Dice 不劣化，FP/scan 不升高），
 *   并经临床课题负责人（PI）与信息科（it_admin）两名不同人类用户双人审批后方可激活上线；支持一键回滚至上一激活版本。
 *   安全红线（PRD 第 6 节）：AI（via === 'ai'）严禁审批、激活或回滚模型版本。
 */

export interface ModificationMagnitude {
  was_refined: boolean
  location_changed: boolean
  seg_ref_changed: boolean
  delta_mean_diameter_mm: number | null
  delta_volume_mm3: number | null
  delta_volume_pct: number | null
}

export interface CurationEntry {
  id: string
  study_id: string
  signoff_id: string
  signoff_version: number
  signoff_mode: SignoffMode
  lesion_id: string
  kind: string
  source: 'ai' | 'manual'
  status: 'confirmed' | 'rejected'
  reject_reason: string | null
  curation_category: 'true_positive_confirmed' | 'true_positive_refined' | 'false_negative_added' | 'false_positive_rejected'
  location: string | null
  ai_original_location: string | null
  seg_ref: string | null
  ai_original_seg_ref: string | null
  ai_original_metrics: Record<string, unknown> | null
  final_metrics: Record<string, unknown>
  modification_magnitude: ModificationMagnitude
  reviewer_id: string
  reviewer_role: 'reviewer' | 'single'
  quality_tier: 'high_verified'
  curated_at: string
}

export interface DualReaderSample {
  id: string
  study_id: string
  lesion_key: string
  reader_a_id: string
  reader_b_id: string
  reader_a_diameter_mm: number
  reader_b_diameter_mm: number
  voxel_dice: number
  diameter_diff_mm: number
  abs_diameter_diff_mm: number
  recorded_by: string
  recorded_at: string
}

export interface InterObserverReport {
  total_curated_studies: number
  sampled_studies: number
  sampling_rate: number
  target_sampling_rate: number
  total_paired_lesions: number
  mean_voxel_dice: number | null
  min_voxel_dice: number | null
  mean_abs_diameter_diff_mm: number | null
  bland_altman: {
    mean_bias_mm: number | null
    sd_diff_mm: number | null
    loa_lower_mm: number | null
    loa_upper_mm: number | null
  }
}

export interface SubgroupEvalMetrics {
  sensitivity: number
  dice?: number | null
  n_gt?: number
}

export interface ModelEvalSnapshot {
  overall: {
    sensitivity: number
    fp_per_scan: number
    mean_dice: number
  }
  by_size?: Record<string, SubgroupEvalMetrics>
  by_density?: Record<string, SubgroupEvalMetrics>
}

export interface GateFailure {
  metric: string
  subgroup: string | null
  baseline_value: number
  candidate_value: number
  message: string
}

export interface ModelReleaseRow {
  id: string
  task: string
  model_id: string
  version: string
  weights_sha256: string
  baseline_version: string | null
  eval_metrics: ModelEvalSnapshot
  gate_passed: boolean
  gate_failures: GateFailure[]
  pi_approved_by: string | null
  pi_approved_at: string | null
  pi_note: string | null
  it_approved_by: string | null
  it_approved_at: string | null
  it_note: string | null
  status: 'candidate' | 'approved' | 'active' | 'superseded' | 'rolled_back'
  created_by: string
  created_at: string
  activated_by: string | null
  activated_at: string | null
  rolled_back_by: string | null
  rolled_back_at: string | null
  rollback_reason: string | null
}

const now = () => new Date().toISOString()
const rid = (prefix: string) => prefix + randomUUID().replace(/-/g, '').slice(0, 12)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const r2 = (v: number) => Math.round(v * 100) / 100
const r4 = (v: number) => Math.round(v * 10000) / 10000

const ready = new WeakSet<DatabaseSync>()

export function ensureCurationSchema(db: DatabaseSync): void {
  if (ready.has(db)) return
  ensureReviewSchema(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS imaging_curation_entries (
      id TEXT PRIMARY KEY,
      study_id TEXT NOT NULL REFERENCES imaging_studies(id) ON DELETE CASCADE,
      signoff_id TEXT NOT NULL REFERENCES imaging_signoffs(id) ON DELETE CASCADE,
      signoff_version INTEGER NOT NULL,
      signoff_mode TEXT NOT NULL,
      lesion_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      reject_reason TEXT,
      curation_category TEXT NOT NULL,
      location TEXT,
      ai_original_location TEXT,
      seg_ref TEXT,
      ai_original_seg_ref TEXT,
      ai_original_metrics TEXT,
      final_metrics TEXT NOT NULL,
      modification_magnitude TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      reviewer_role TEXT NOT NULL,
      quality_tier TEXT NOT NULL DEFAULT 'high_verified',
      curated_at TEXT NOT NULL,
      UNIQUE (signoff_id, lesion_id)
    );
    CREATE INDEX IF NOT EXISTS imaging_curation_entries_study ON imaging_curation_entries (study_id, signoff_version);

    CREATE TABLE IF NOT EXISTS imaging_curation_dual_samples (
      id TEXT PRIMARY KEY,
      study_id TEXT NOT NULL REFERENCES imaging_studies(id) ON DELETE CASCADE,
      lesion_key TEXT NOT NULL,
      reader_a_id TEXT NOT NULL,
      reader_b_id TEXT NOT NULL,
      reader_a_diameter_mm REAL NOT NULL,
      reader_b_diameter_mm REAL NOT NULL,
      voxel_dice REAL NOT NULL,
      diameter_diff_mm REAL NOT NULL,
      abs_diameter_diff_mm REAL NOT NULL,
      recorded_by TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE (study_id, lesion_key)
    );

    CREATE TABLE IF NOT EXISTS imaging_model_releases (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      model_id TEXT NOT NULL,
      version TEXT NOT NULL,
      weights_sha256 TEXT NOT NULL,
      baseline_version TEXT,
      eval_metrics TEXT NOT NULL,
      gate_passed INTEGER NOT NULL,
      gate_failures TEXT NOT NULL,
      pi_approved_by TEXT,
      pi_approved_at TEXT,
      pi_note TEXT,
      it_approved_by TEXT,
      it_approved_at TEXT,
      it_note TEXT,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_by TEXT,
      activated_at TEXT,
      rolled_back_by TEXT,
      rolled_back_at TEXT,
      rollback_reason TEXT,
      UNIQUE (task, model_id, version)
    );
  `)
  ready.add(db)
}

/**
 * 在定稿事务内把定稿快照写入已核实标注库（imaging_curation_entries）。
 * 由 ImagingReviewService.finalize 调用，也可由 AnnotationCurationService.ingestFinalizedStudy 显式触发。
 */
export function ingestSignoffIntoCurationBank(
  db: DatabaseSync,
  params: {
    studyId: string
    signoffId: string
    signoffVersion: number
    signoffMode: SignoffMode
    signedBy: string
    signedAt: string
    snapshot: SnapshotLesion[]
  },
): CurationEntry[] {
  ensureCurationSchema(db)
  const createEvents = db.prepare(`
    SELECT e.lesion_id, e.after
    FROM imaging_lesion_events e
    JOIN imaging_lesions l ON l.id = e.lesion_id
    WHERE l.study_id = ? AND e.action = 'create'
    ORDER BY e.id ASC
  `).all(params.studyId) as Array<{ lesion_id: string; after: string | null }>

  const aiCreateByLesion = new Map<string, LesionRow>()
  for (const ev of createEvents) {
    if (!ev.after || aiCreateByLesion.has(ev.lesion_id)) continue
    try {
      const parsed = JSON.parse(ev.after) as LesionRow
      if (parsed.source === 'ai') aiCreateByLesion.set(ev.lesion_id, parsed)
    } catch { /* ignore malformed event */ }
  }

  const reviewerRole: 'reviewer' | 'single' = params.signoffMode === 'single' ? 'single' : 'reviewer'
  const entries: CurationEntry[] = []

  const upsert = db.prepare(`
    INSERT INTO imaging_curation_entries (
      id, study_id, signoff_id, signoff_version, signoff_mode, lesion_id, kind, source, status, reject_reason,
      curation_category, location, ai_original_location, seg_ref, ai_original_seg_ref, ai_original_metrics,
      final_metrics, modification_magnitude, reviewer_id, reviewer_role, quality_tier, curated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'high_verified', ?)
    ON CONFLICT(signoff_id, lesion_id) DO UPDATE SET
      status = excluded.status,
      reject_reason = excluded.reject_reason,
      curation_category = excluded.curation_category,
      location = excluded.location,
      seg_ref = excluded.seg_ref,
      final_metrics = excluded.final_metrics,
      modification_magnitude = excluded.modification_magnitude,
      curated_at = excluded.curated_at
  `)

  for (const item of params.snapshot) {
    if (item.status !== 'confirmed' && item.status !== 'rejected') continue
    const aiOrig = item.source === 'ai' ? (aiCreateByLesion.get(item.id) ?? null) : null
    const aiMetrics = aiOrig?.metrics ?? null
    const aiLocation = aiOrig ? (aiOrig.location ?? null) : null
    const aiSegRef = aiOrig ? (aiOrig.seg_ref ?? null) : null

    const origD = aiMetrics ? num(aiMetrics.mean_diameter_mm) : null
    const finalD = num(item.metrics.mean_diameter_mm)
    const deltaD = origD !== null && finalD !== null ? r2(finalD - origD) : null

    const origV = aiMetrics ? num(aiMetrics.volume_mm3) : null
    const finalV = num(item.metrics.volume_mm3)
    const deltaV = origV !== null && finalV !== null ? r2(finalV - origV) : null
    const deltaVPct = origV !== null && origV > 0 && deltaV !== null ? r2((deltaV / origV) * 100) : null

    const segRefChanged = item.source === 'ai' && (aiSegRef ?? null) !== (item.seg_ref ?? null)
    const locationChanged = item.source === 'ai' && (aiLocation ?? null) !== (item.location ?? null)
    const wasRefined = item.source === 'ai' && (
      segRefChanged ||
      locationChanged ||
      (deltaD !== null && Math.abs(deltaD) >= 0.1) ||
      (deltaV !== null && Math.abs(deltaV) >= 1.0)
    )

    let category: CurationEntry['curation_category']
    if (item.status === 'rejected') {
      category = 'false_positive_rejected'
    } else if (item.source === 'manual') {
      category = 'false_negative_added'
    } else if (wasRefined) {
      category = 'true_positive_refined'
    } else {
      category = 'true_positive_confirmed'
    }

    const magnitude: ModificationMagnitude = {
      was_refined: wasRefined,
      location_changed: locationChanged,
      seg_ref_changed: segRefChanged,
      delta_mean_diameter_mm: deltaD,
      delta_volume_mm3: deltaV,
      delta_volume_pct: deltaVPct,
    }

    const id = rid('ce')
    upsert.run(
      id,
      params.studyId,
      params.signoffId,
      params.signoffVersion,
      params.signoffMode,
      item.id,
      item.kind,
      item.source,
      item.status,
      item.reject_reason,
      category,
      item.location,
      aiLocation,
      item.seg_ref,
      aiSegRef,
      aiMetrics ? JSON.stringify(aiMetrics) : null,
      JSON.stringify(item.metrics),
      JSON.stringify(magnitude),
      params.signedBy,
      reviewerRole,
      params.signedAt,
    )

    entries.push({
      id,
      study_id: params.studyId,
      signoff_id: params.signoffId,
      signoff_version: params.signoffVersion,
      signoff_mode: params.signoffMode,
      lesion_id: item.id,
      kind: item.kind,
      source: item.source,
      status: item.status,
      reject_reason: item.reject_reason,
      curation_category: category,
      location: item.location,
      ai_original_location: aiLocation,
      seg_ref: item.seg_ref,
      ai_original_seg_ref: aiSegRef,
      ai_original_metrics: aiMetrics,
      final_metrics: item.metrics,
      modification_magnitude: magnitude,
      reviewer_id: params.signedBy,
      reviewer_role: reviewerRole,
      quality_tier: 'high_verified',
      curated_at: params.signedAt,
    })
  }

  return entries
}

/**
 * 评估候选模型版本与基线版本的非劣效门控（W7.4）：
 * - 整体灵敏度 candidate.overall.sensitivity >= baseline.overall.sensitivity - tolerance.sensitivity
 * - 整体假阳性率 candidate.overall.fp_per_scan <= baseline.overall.fp_per_scan + tolerance.fp_per_scan
 * - 整体分割 Dice candidate.overall.mean_dice >= baseline.overall.mean_dice - tolerance.dice
 * - 所有大小亚组（by_size）与密度亚组（by_density）的灵敏度与 Dice 均不得低于基线超出容差
 */
export function evaluateNonInferiorityGate(
  candidate: ModelEvalSnapshot,
  baseline: ModelEvalSnapshot | null,
  tolerance: { sensitivity?: number; fp_per_scan?: number; dice?: number } = {},
): { passed: boolean; failures: GateFailure[] } {
  const failures: GateFailure[] = []
  if (!baseline) {
    return { passed: true, failures }
  }
  const tolSens = tolerance.sensitivity ?? 0.0
  const tolFp = tolerance.fp_per_scan ?? 0.0
  const tolDice = tolerance.dice ?? 0.0

  if (candidate.overall.sensitivity + 1e-9 < baseline.overall.sensitivity - tolSens) {
    failures.push({
      metric: 'sensitivity',
      subgroup: null,
      baseline_value: baseline.overall.sensitivity,
      candidate_value: candidate.overall.sensitivity,
      message: `整体灵敏度（${candidate.overall.sensitivity}）低于上一版基线（${baseline.overall.sensitivity}）`,
    })
  }
  if (candidate.overall.fp_per_scan - 1e-9 > baseline.overall.fp_per_scan + tolFp) {
    failures.push({
      metric: 'fp_per_scan',
      subgroup: null,
      baseline_value: baseline.overall.fp_per_scan,
      candidate_value: candidate.overall.fp_per_scan,
      message: `整体每例假阳性数（${candidate.overall.fp_per_scan}/scan）高于上一版基线（${baseline.overall.fp_per_scan}/scan）`,
    })
  }
  if (candidate.overall.mean_dice + 1e-9 < baseline.overall.mean_dice - tolDice) {
    failures.push({
      metric: 'mean_dice',
      subgroup: null,
      baseline_value: baseline.overall.mean_dice,
      candidate_value: candidate.overall.mean_dice,
      message: `整体分割 Dice（${candidate.overall.mean_dice}）低于上一版基线（${baseline.overall.mean_dice}）`,
    })
  }

  const checkSubgroups = (
    groupLabel: string,
    candGroups: Record<string, SubgroupEvalMetrics> | undefined,
    baseGroups: Record<string, SubgroupEvalMetrics> | undefined,
  ) => {
    if (!baseGroups) return
    for (const [subKey, baseSub] of Object.entries(baseGroups)) {
      if ((baseSub.n_gt ?? 1) <= 0) continue
      const candSub = candGroups?.[subKey]
      if (!candSub) {
        failures.push({
          metric: 'sensitivity',
          subgroup: `${groupLabel}:${subKey}`,
          baseline_value: baseSub.sensitivity,
          candidate_value: 0,
          message: `缺少亚组「${groupLabel}:${subKey}」的评测指标`,
        })
        continue
      }
      if (candSub.sensitivity + 1e-9 < baseSub.sensitivity - tolSens) {
        failures.push({
          metric: 'sensitivity',
          subgroup: `${groupLabel}:${subKey}`,
          baseline_value: baseSub.sensitivity,
          candidate_value: candSub.sensitivity,
          message: `亚组「${groupLabel}:${subKey}」灵敏度（${candSub.sensitivity}）低于基线（${baseSub.sensitivity}）`,
        })
      }
      if (
        typeof baseSub.dice === 'number' &&
        typeof candSub.dice === 'number' &&
        candSub.dice + 1e-9 < baseSub.dice - tolDice
      ) {
        failures.push({
          metric: 'dice',
          subgroup: `${groupLabel}:${subKey}`,
          baseline_value: baseSub.dice,
          candidate_value: candSub.dice,
          message: `亚组「${groupLabel}:${subKey}」分割 Dice（${candSub.dice}）低于基线（${baseSub.dice}）`,
        })
      }
    }
  }

  checkSubgroups('size', candidate.by_size, baseline.by_size)
  checkSubgroups('density', candidate.by_density, baseline.by_density)

  return {
    passed: failures.length === 0,
    failures,
  }
}

export class AnnotationCurationService {
  constructor(private readonly patients: PatientService) {}

  private studyScope(a: Actor, studyId: string, need: 'read' | 'write'): ImagingScope {
    const lookup = this.patients.imagingLookup(a)
    const row = lookup.db.prepare('SELECT patient_id FROM imaging_studies WHERE id = ?').get(studyId) as { patient_id: string } | undefined
    if (!row) throw new PatientError('not_found', '影像检查不存在', 404)
    const s = this.patients.imagingScope(a, row.patient_id, need)
    ensureCurationSchema(s.db)
    return s
  }

  private tenantDb(a: Actor): DatabaseSync {
    const db = this.patients.imagingLookup(a).db
    ensureCurationSchema(db)
    return db
  }

  /**
   * 显式将某个已定稿检查的最新定稿快照回收到标注库（W7.1）。
   * 若检查尚未定稿，或定稿后有未再次定稿的修改（amending），拒绝入库（unfinalized_not_admitted），
   * 确保未定稿的初级医师标注绝不混入高可信度训练集。
   */
  ingestFinalizedStudy(a: Actor, studyId: string): CurationEntry[] {
    if (a.via === 'ai') throw new PatientError('forbidden', '标注库入库须由审核医师定稿触发，AI 不能直接写标注库', 403)
    const s = this.studyScope(a, studyId, 'write')
    const signoffs = s.db.prepare('SELECT * FROM imaging_signoffs WHERE study_id = ? ORDER BY version DESC LIMIT 1').all(studyId) as Array<{
      id: string
      version: number
      signed_by: string
      signed_at: string
      revision: number
      mode: SignoffMode
      snapshot: string
    }>
    const latest = signoffs[0]
    if (!latest) {
      throw new ImagingError('unfinalized_not_admitted', '该检查尚未经审核医师定稿：未定稿的初级医师标注不能进入已核实标注库', 409)
    }
    const revRow = s.db.prepare(`
      SELECT MAX(e.id) AS m FROM imaging_lesion_events e
      JOIN imaging_lesions l ON l.id = e.lesion_id
      LEFT JOIN imaging_runs r ON r.id = l.run_id
      WHERE l.study_id = ? AND (r.id IS NULL OR r.visibility = 'visible') AND e.action != 'finalize'
    `).get(studyId) as { m: number | null }
    const currentRev = revRow.m ?? 0
    if (latest.revision !== currentRev) {
      throw new ImagingError('unfinalized_not_admitted', '该检查在定稿后又有未定稿的改动：请审核医师再次定稿后再入标注库', 409)
    }
    const snapshot = JSON.parse(latest.snapshot) as SnapshotLesion[]
    return ingestSignoffIntoCurationBank(s.db, {
      studyId,
      signoffId: latest.id,
      signoffVersion: latest.version,
      signoffMode: latest.mode,
      signedBy: latest.signed_by,
      signedAt: latest.signed_at,
      snapshot,
    })
  }

  /**
   * 查询已核实标注库条目（只含最新定稿版本的条目，支持按检查或类别筛选）。
   */
  listEntries(a: Actor, filter: { study_id?: string; category?: CurationEntry['curation_category'] } = {}): CurationEntry[] {
    const db = filter.study_id ? this.studyScope(a, filter.study_id, 'read').db : this.tenantDb(a)
    const rows = db.prepare(`
      SELECT c.*
      FROM imaging_curation_entries c
      JOIN (
        SELECT study_id, MAX(signoff_version) AS max_ver
        FROM imaging_curation_entries
        GROUP BY study_id
      ) m ON m.study_id = c.study_id AND m.max_ver = c.signoff_version
      WHERE (? IS NULL OR c.study_id = ?)
        AND (? IS NULL OR c.curation_category = ?)
      ORDER BY c.curated_at DESC, c.rowid DESC
    `).all(
      filter.study_id ?? null,
      filter.study_id ?? null,
      filter.category ?? null,
      filter.category ?? null,
    ) as Array<Record<string, unknown>>

    return rows.map(r => ({
      id: r.id as string,
      study_id: r.study_id as string,
      signoff_id: r.signoff_id as string,
      signoff_version: Number(r.signoff_version),
      signoff_mode: r.signoff_mode as SignoffMode,
      lesion_id: r.lesion_id as string,
      kind: r.kind as string,
      source: r.source as 'ai' | 'manual',
      status: r.status as 'confirmed' | 'rejected',
      reject_reason: (r.reject_reason as string | null) ?? null,
      curation_category: r.curation_category as CurationEntry['curation_category'],
      location: (r.location as string | null) ?? null,
      ai_original_location: (r.ai_original_location as string | null) ?? null,
      seg_ref: (r.seg_ref as string | null) ?? null,
      ai_original_seg_ref: (r.ai_original_seg_ref as string | null) ?? null,
      ai_original_metrics: r.ai_original_metrics ? (JSON.parse(r.ai_original_metrics as string) as Record<string, unknown>) : null,
      final_metrics: JSON.parse(r.final_metrics as string) as Record<string, unknown>,
      modification_magnitude: JSON.parse(r.modification_magnitude as string) as ModificationMagnitude,
      reviewer_id: r.reviewer_id as string,
      reviewer_role: r.reviewer_role as 'reviewer' | 'single',
      quality_tier: 'high_verified',
      curated_at: r.curated_at as string,
    }))
  }

  // —— W7.2 双人独立标注抽样与一致性报告 ——

  /**
   * 记录双人独立标注抽样对比结果（两名不同高年资医师对同一抽样检查的独立标注）。
   */
  recordDualReaderSample(
    a: Actor,
    studyId: string,
    input: {
      lesion_key: string
      reader_a_id: string
      reader_b_id: string
      reader_a_diameter_mm: number
      reader_b_diameter_mm: number
      voxel_dice: number
    },
  ): DualReaderSample {
    if (a.via === 'ai') throw new PatientError('forbidden', '双人独立标注抽样只能由医师或质控员录入，AI 不能录入', 403)
    const s = this.studyScope(a, studyId, 'write')
    if (!input.reader_a_id || !input.reader_b_id || input.reader_a_id === input.reader_b_id) {
      throw new ImagingError('invalid_dual_readers', '双人独立标注抽样须由两名不同的医师（reader_a_id != reader_b_id）独立完成', 400)
    }
    if (!Number.isFinite(input.voxel_dice) || input.voxel_dice < 0 || input.voxel_dice > 1) {
      throw new ImagingError('invalid_dice', '体素 Dice 须在 [0, 1] 范围内', 400)
    }
    if (!Number.isFinite(input.reader_a_diameter_mm) || input.reader_a_diameter_mm <= 0 || !Number.isFinite(input.reader_b_diameter_mm) || input.reader_b_diameter_mm <= 0) {
      throw new ImagingError('invalid_diameter', '医师标注径线须为正数（mm）', 400)
    }
    const diff = r2(input.reader_a_diameter_mm - input.reader_b_diameter_mm)
    const absDiff = r2(Math.abs(diff))
    const dice = r4(input.voxel_dice)
    const id = rid('ds')
    const t = now()
    s.db.prepare(`
      INSERT INTO imaging_curation_dual_samples (
        id, study_id, lesion_key, reader_a_id, reader_b_id,
        reader_a_diameter_mm, reader_b_diameter_mm, voxel_dice,
        diameter_diff_mm, abs_diameter_diff_mm, recorded_by, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(study_id, lesion_key) DO UPDATE SET
        reader_a_id = excluded.reader_a_id,
        reader_b_id = excluded.reader_b_id,
        reader_a_diameter_mm = excluded.reader_a_diameter_mm,
        reader_b_diameter_mm = excluded.reader_b_diameter_mm,
        voxel_dice = excluded.voxel_dice,
        diameter_diff_mm = excluded.diameter_diff_mm,
        abs_diameter_diff_mm = excluded.abs_diameter_diff_mm,
        recorded_by = excluded.recorded_by,
        recorded_at = excluded.recorded_at
    `).run(
      id,
      studyId,
      input.lesion_key.trim(),
      input.reader_a_id,
      input.reader_b_id,
      r2(input.reader_a_diameter_mm),
      r2(input.reader_b_diameter_mm),
      dice,
      diff,
      absDiff,
      a.userId,
      t,
    )
    return {
      id,
      study_id: studyId,
      lesion_key: input.lesion_key.trim(),
      reader_a_id: input.reader_a_id,
      reader_b_id: input.reader_b_id,
      reader_a_diameter_mm: r2(input.reader_a_diameter_mm),
      reader_b_diameter_mm: r2(input.reader_b_diameter_mm),
      voxel_dice: dice,
      diameter_diff_mm: diff,
      abs_diameter_diff_mm: absDiff,
      recorded_by: a.userId,
      recorded_at: t,
    }
  }

  /**
   * 汇总医师间标注一致性报告（W7.2：抽样比例、分割 Dice、径线差异与 Bland-Altman 95% LoA）。
   */
  interObserverReport(a: Actor, targetSamplingRate = 0.1): InterObserverReport {
    const db = this.tenantDb(a)
    const totalCuratedStudies = (db.prepare('SELECT COUNT(DISTINCT study_id) AS n FROM imaging_curation_entries').get() as { n: number }).n
    const samples = db.prepare('SELECT * FROM imaging_curation_dual_samples ORDER BY recorded_at ASC').all() as Array<Record<string, unknown>>
    const sampledStudies = new Set(samples.map(s => s.study_id as string)).size
    const samplingRate = totalCuratedStudies > 0 ? r4(sampledStudies / totalCuratedStudies) : 0

    if (samples.length === 0) {
      return {
        total_curated_studies: totalCuratedStudies,
        sampled_studies: 0,
        sampling_rate: samplingRate,
        target_sampling_rate: targetSamplingRate,
        total_paired_lesions: 0,
        mean_voxel_dice: null,
        min_voxel_dice: null,
        mean_abs_diameter_diff_mm: null,
        bland_altman: { mean_bias_mm: null, sd_diff_mm: null, loa_lower_mm: null, loa_upper_mm: null },
      }
    }

    const dices = samples.map(s => Number(s.voxel_dice))
    const diffs = samples.map(s => Number(s.diameter_diff_mm))
    const absDiffs = samples.map(s => Number(s.abs_diameter_diff_mm))
    const n = samples.length
    const meanDice = r4(dices.reduce((acc, v) => acc + v, 0) / n)
    const minDice = r4(Math.min(...dices))
    const meanAbsDiff = r2(absDiffs.reduce((acc, v) => acc + v, 0) / n)
    const meanBias = diffs.reduce((acc, v) => acc + v, 0) / n
    const variance = n > 1 ? diffs.reduce((acc, v) => acc + (v - meanBias) ** 2, 0) / (n - 1) : 0
    const sd = Math.sqrt(variance)

    return {
      total_curated_studies: totalCuratedStudies,
      sampled_studies: sampledStudies,
      sampling_rate: samplingRate,
      target_sampling_rate: targetSamplingRate,
      total_paired_lesions: n,
      mean_voxel_dice: meanDice,
      min_voxel_dice: minDice,
      mean_abs_diameter_diff_mm: meanAbsDiff,
      bland_altman: {
        mean_bias_mm: r2(meanBias),
        sd_diff_mm: r2(sd),
        loa_lower_mm: r2(meanBias - 1.96 * sd),
        loa_upper_mm: r2(meanBias + 1.96 * sd),
      },
    }
  }

  // —— W7.4 模型发布门控、PI + 信息科双人审批与一键回滚 ——

  private formatRelease(r: Record<string, unknown>): ModelReleaseRow {
    return {
      id: r.id as string,
      task: r.task as string,
      model_id: r.model_id as string,
      version: r.version as string,
      weights_sha256: r.weights_sha256 as string,
      baseline_version: (r.baseline_version as string | null) ?? null,
      eval_metrics: JSON.parse(r.eval_metrics as string) as ModelEvalSnapshot,
      gate_passed: Boolean(r.gate_passed),
      gate_failures: JSON.parse(r.gate_failures as string) as GateFailure[],
      pi_approved_by: (r.pi_approved_by as string | null) ?? null,
      pi_approved_at: (r.pi_approved_at as string | null) ?? null,
      pi_note: (r.pi_note as string | null) ?? null,
      it_approved_by: (r.it_approved_by as string | null) ?? null,
      it_approved_at: (r.it_approved_at as string | null) ?? null,
      it_note: (r.it_note as string | null) ?? null,
      status: r.status as ModelReleaseRow['status'],
      created_by: r.created_by as string,
      created_at: r.created_at as string,
      activated_by: (r.activated_by as string | null) ?? null,
      activated_at: (r.activated_at as string | null) ?? null,
      rolled_back_by: (r.rolled_back_by as string | null) ?? null,
      rolled_back_at: (r.rolled_back_at as string | null) ?? null,
      rollback_reason: (r.rollback_reason as string | null) ?? null,
    }
  }

  /**
   * 登记候选模型版本并自动执行非劣效门控比对（与当前 active 版本比对）。
   * AI 一律禁止登记或发布模型版本（PRD 第 6 节）。
   */
  registerCandidateRelease(
    a: Actor,
    input: {
      task: string
      model_id: string
      version: string
      weights_sha256: string
      eval_metrics: ModelEvalSnapshot
      tolerance?: { sensitivity?: number; fp_per_scan?: number; dice?: number }
    },
  ): ModelReleaseRow {
    if (a.via === 'ai') throw new PatientError('forbidden', 'AI 不能登记、审批或发布模型版本', 403)
    const db = this.tenantDb(a)
    const active = db.prepare(`
      SELECT * FROM imaging_model_releases
      WHERE task = ? AND model_id = ? AND status = 'active'
      ORDER BY activated_at DESC, rowid DESC LIMIT 1
    `).get(input.task, input.model_id) as Record<string, unknown> | undefined

    const baselineSnap = active ? (JSON.parse(active.eval_metrics as string) as ModelEvalSnapshot) : null
    const baselineVersion = active ? (active.version as string) : null
    const gate = evaluateNonInferiorityGate(input.eval_metrics, baselineSnap, input.tolerance)

    const id = rid('mr')
    const t = now()
    db.prepare(`
      INSERT INTO imaging_model_releases (
        id, task, model_id, version, weights_sha256, baseline_version,
        eval_metrics, gate_passed, gate_failures, status, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
    `).run(
      id,
      input.task,
      input.model_id,
      input.version,
      input.weights_sha256,
      baselineVersion,
      JSON.stringify(input.eval_metrics),
      gate.passed ? 1 : 0,
      JSON.stringify(gate.failures),
      a.userId,
      t,
    )
    return this.formatRelease(db.prepare('SELECT * FROM imaging_model_releases WHERE id = ?').get(id) as Record<string, unknown>)
  }

  /**
   * 临床课题负责人（PI）或信息科（it_admin）审批候选模型版本（W7.4）。
   * - 未通过非劣效门控的候选版本禁止审批（gate_not_passed，409）；
   * - PI 与信息科审批必须由两名不同的人类用户完成（dual_control_same_user，409）；
   * - AI 一律禁止审批（403）。
   */
  approveRelease(
    a: Actor,
    releaseId: string,
    input: { role: 'pi' | 'it_admin'; note?: string | null },
  ): ModelReleaseRow {
    if (a.via === 'ai') throw new PatientError('forbidden', '模型发布须由临床课题负责人（PI）与信息科本人在界面上双人审批，AI 禁止审批', 403)
    const db = this.tenantDb(a)
    const raw = db.prepare('SELECT * FROM imaging_model_releases WHERE id = ?').get(releaseId) as Record<string, unknown> | undefined
    if (!raw) throw new PatientError('not_found', '模型发布记录不存在', 404)
    const rel = this.formatRelease(raw)
    if (!rel.gate_passed) {
      throw new ImagingError('gate_not_passed', `候选模型 ${rel.model_id}@${rel.version} 未通过非劣效门控，不能审批上线：${rel.gate_failures.map(f => f.message).join('；')}`, 409)
    }
    if (rel.status !== 'candidate' && rel.status !== 'approved') {
      throw new ImagingError('bad_release_state', `当前状态为 ${rel.status}，无法审批`, 409)
    }
    const t = now()
    if (input.role === 'pi') {
      if (rel.it_approved_by && rel.it_approved_by === a.userId) {
        throw new ImagingError('dual_control_same_user', '临床课题负责人（PI）与信息科双人审批须为两名不同的负责人，同一人不能兼签', 409)
      }
      db.prepare('UPDATE imaging_model_releases SET pi_approved_by = ?, pi_approved_at = ?, pi_note = ? WHERE id = ?')
        .run(a.userId, t, input.note ?? null, releaseId)
    } else if (input.role === 'it_admin') {
      if (rel.pi_approved_by && rel.pi_approved_by === a.userId) {
        throw new ImagingError('dual_control_same_user', '临床课题负责人（PI）与信息科双人审批须为两名不同的负责人，同一人不能兼签', 409)
      }
      db.prepare('UPDATE imaging_model_releases SET it_approved_by = ?, it_approved_at = ?, it_note = ? WHERE id = ?')
        .run(a.userId, t, input.note ?? null, releaseId)
    } else {
      throw new ImagingError('bad_approver_role', '审批角色须为 pi（临床课题负责人）或 it_admin（信息科）', 400)
    }

    const updated = this.formatRelease(db.prepare('SELECT * FROM imaging_model_releases WHERE id = ?').get(releaseId) as Record<string, unknown>)
    if (updated.pi_approved_by && updated.it_approved_by && updated.status === 'candidate') {
      db.prepare("UPDATE imaging_model_releases SET status = 'approved' WHERE id = ?").run(releaseId)
      return this.formatRelease(db.prepare('SELECT * FROM imaging_model_releases WHERE id = ?').get(releaseId) as Record<string, unknown>)
    }
    return updated
  }

  /**
   * 激活已获 PI + 信息科双人审批的模型版本上线（W7.4）。
   * 激活后自动将同一 task + model_id 的旧 active 版本置为 superseded。
   */
  activateRelease(a: Actor, releaseId: string): ModelReleaseRow {
    if (a.via === 'ai') throw new PatientError('forbidden', 'AI 禁止发布或切换模型版本', 403)
    const db = this.tenantDb(a)
    const raw = db.prepare('SELECT * FROM imaging_model_releases WHERE id = ?').get(releaseId) as Record<string, unknown> | undefined
    if (!raw) throw new PatientError('not_found', '模型发布记录不存在', 404)
    const rel = this.formatRelease(raw)
    if (!rel.gate_passed) {
      throw new ImagingError('gate_not_passed', '候选模型未通过非劣效门控，禁止上线', 409)
    }
    if (!rel.pi_approved_by || !rel.it_approved_by) {
      throw new ImagingError('approval_incomplete', '模型上线须先完成临床课题负责人（PI）与信息科双人审批', 409)
    }
    const t = now()
    db.exec('SAVEPOINT model_activate')
    try {
      db.prepare("UPDATE imaging_model_releases SET status = 'superseded' WHERE task = ? AND model_id = ? AND status = 'active' AND id != ?")
        .run(rel.task, rel.model_id, releaseId)
      db.prepare("UPDATE imaging_model_releases SET status = 'active', activated_by = ?, activated_at = ? WHERE id = ?")
        .run(a.userId, t, releaseId)
      db.exec('RELEASE SAVEPOINT model_activate')
    } catch (err) {
      db.exec('ROLLBACK TO SAVEPOINT model_activate')
      db.exec('RELEASE SAVEPOINT model_activate')
      throw err
    }
    return this.formatRelease(db.prepare('SELECT * FROM imaging_model_releases WHERE id = ?').get(releaseId) as Record<string, unknown>)
  }

  /**
   * 一键回滚当前激活的模型版本至上一稳定版本（superseded）（W7.4）。
   * AI 禁止执行回滚。
   */
  rollbackRelease(
    a: Actor,
    input: { task: string; model_id: string; reason: string },
  ): { rolled_back: ModelReleaseRow; restored: ModelReleaseRow } {
    if (a.via === 'ai') throw new PatientError('forbidden', 'AI 禁止切换或回滚模型版本', 403)
    const db = this.tenantDb(a)
    const current = db.prepare(`
      SELECT * FROM imaging_model_releases
      WHERE task = ? AND model_id = ? AND status = 'active'
      ORDER BY activated_at DESC, rowid DESC LIMIT 1
    `).get(input.task, input.model_id) as Record<string, unknown> | undefined
    if (!current) {
      throw new ImagingError('no_active_release', '当前没有处于激活状态的模型版本', 404)
    }
    const previous = db.prepare(`
      SELECT * FROM imaging_model_releases
      WHERE task = ? AND model_id = ? AND status = 'superseded' AND id != ?
      ORDER BY activated_at DESC, rowid DESC LIMIT 1
    `).get(input.task, input.model_id, current.id as string) as Record<string, unknown> | undefined
    if (!previous) {
      throw new ImagingError('no_previous_release', '没有可回滚的上一版本记录', 409)
    }
    const t = now()
    const reason = (input.reason || '一键回滚至上一稳定版本').trim().slice(0, 500)
    db.exec('SAVEPOINT model_rollback')
    try {
      db.prepare(`
        UPDATE imaging_model_releases
        SET status = 'rolled_back', rolled_back_by = ?, rolled_back_at = ?, rollback_reason = ?
        WHERE id = ?
      `).run(a.userId, t, reason, current.id as string)
      db.prepare(`
        UPDATE imaging_model_releases
        SET status = 'active', activated_by = ?, activated_at = ?
        WHERE id = ?
      `).run(a.userId, t, previous.id as string)
      db.exec('RELEASE SAVEPOINT model_rollback')
    } catch (err) {
      db.exec('ROLLBACK TO SAVEPOINT model_rollback')
      db.exec('RELEASE SAVEPOINT model_rollback')
      throw err
    }
    return {
      rolled_back: this.formatRelease(db.prepare('SELECT * FROM imaging_model_releases WHERE id = ?').get(current.id as string) as Record<string, unknown>),
      restored: this.formatRelease(db.prepare('SELECT * FROM imaging_model_releases WHERE id = ?').get(previous.id as string) as Record<string, unknown>),
    }
  }

  activeRelease(a: Actor, task: string, modelId: string): ModelReleaseRow | null {
    const db = this.tenantDb(a)
    const row = db.prepare(`
      SELECT * FROM imaging_model_releases
      WHERE task = ? AND model_id = ? AND status = 'active'
      ORDER BY activated_at DESC, rowid DESC LIMIT 1
    `).get(task, modelId) as Record<string, unknown> | undefined
    return row ? this.formatRelease(row) : null
  }

  listReleases(a: Actor, task?: string, modelId?: string): ModelReleaseRow[] {
    const db = this.tenantDb(a)
    const rows = db.prepare(`
      SELECT * FROM imaging_model_releases
      WHERE (? IS NULL OR task = ?) AND (? IS NULL OR model_id = ?)
      ORDER BY created_at DESC, rowid DESC
    `).all(task ?? null, task ?? null, modelId ?? null, modelId ?? null) as Array<Record<string, unknown>>
    return rows.map(r => this.formatRelease(r))
  }
}
