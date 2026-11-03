import type { DatabaseSync } from 'node:sqlite'
import type { PatientService } from '../tenancy/patients.ts'
import type { Orthanc } from './orthanc.ts'

/**
 * 影像原件保留期清理（docs/design/IMAGING_STUDIES.md「云端影像的保留期」）。
 *
 * 云端（托管生产机）的 DICOM 只是工作副本，原件在医院：检查「最后上传时间」超过 IMAGING_RETENTION_DAYS 天后，
 * 从 Orthanc 删除整个检查（原件与 AI 生成的 DICOM SEG）。平台库保留检查与序列索引、AI 运行与结果、病灶、测量、
 * 审核与定稿留痕、随访对应；检查记 originals_deleted_at / originals_retention_days，检查与序列的 orthanc_id 置空。
 *
 * - 「最后上传时间」= imaging_studies.updated_at：只有上传（studies.ts 的 linkStudy）会更新它，重复上传也算。
 * - 原件是否已删除按「orthanc_id 为空且记过删除时间」判断：重新上传同一检查（同一 StudyInstanceUID）时 linkStudy
 *   会写回 orthanc_id，检查自动恢复为可阅片、可分析，不需要另外清标记；保留期从这次上传重新计算。
 * - 有排队 / 进行中的分析（本进程确实在跑的）或近 2 小时内排队 / 进行中的随访匹配时跳过，下次再看。
 * - 删除失败不改库，下次（次日）重试；成功记访问留痕 imaging_originals_purged（user_id = 本任务名，via = system）。
 * - IMAGING_RETENTION_DAYS = 0（默认）不清理，也不启动定时任务。
 */

/** 访问留痕里的操作者 */
export const RETENTION_ACTOR = 'system:imaging-retention'
/** 随访匹配卡在 queued / running 超过这么久视为上一个进程留下的，不再阻止清理 */
const FOLLOWUP_STALE_MS = 2 * 3600_000
const DAY_MS = 86_400_000

/** 界面与接口用的说明文字 */
export function originalsDeletedMessage(days: number | null): string {
  return `影像原件已按保留期${days ? `（${days} 天）` : ''}从云端删除，可重新上传`
}

export interface OriginalsDeleted { at: string; retention_days: number | null; message: string }

/** 一行 imaging_studies 的原件状态：已删除时返回删除时间与说明，原件仍在（或已重新上传）时返回 null */
export function originalsOf(row: Record<string, unknown>): OriginalsDeleted | null {
  const at = row.originals_deleted_at as string | null | undefined
  if (!at || row.orthanc_id) return null
  const days = row.originals_retention_days == null ? null : Number(row.originals_retention_days)
  return { at, retention_days: days, message: originalsDeletedMessage(days) }
}

/** 按检查行 id 查原件状态（检查不存在时返回 null） */
export function studyOriginals(db: DatabaseSync, studyId: string): OriginalsDeleted | null {
  const row = db.prepare('SELECT orthanc_id, originals_deleted_at, originals_retention_days FROM imaging_studies WHERE id = ?').get(studyId) as Record<string, unknown> | undefined
  return row ? originalsOf(row) : null
}

export interface RetentionOptions {
  /** 保留天数；0 或负数不清理 */
  days: number
  /** 当前时间（测试用） */
  now?: () => number
  /** 本进程是否真的在排队 / 处理这次运行；不给时库里 queued / running 的运行一律视为进行中 */
  isRunActive?: (runId: string) => boolean
  log?: Pick<Console, 'log' | 'error'>
}

export interface RetentionResult {
  /** 本次删除原件的检查数 */
  purged: number
  /** 到期但有分析 / 随访在进行，跳过的检查数 */
  busy: number
  /** 删除失败（下次重试）的检查数 */
  failed: number
}

/** 跑一遍：所有机构里原件到期的检查，从 Orthanc 删除并在库里标记 */
export async function purgeExpiredOriginals(patients: PatientService, orthanc: Orthanc, opts: RetentionOptions): Promise<RetentionResult> {
  const result: RetentionResult = { purged: 0, busy: 0, failed: 0 }
  const days = Math.floor(opts.days)
  if (!(days > 0)) return result
  const nowMs = (opts.now ?? Date.now)()
  const cutoff = new Date(nowMs - days * DAY_MS).toISOString()
  const followupCutoff = new Date(nowMs - FOLLOWUP_STALE_MS).toISOString()
  const log = opts.log ?? console

  for (const t of patients.imagingSystemTenants(RETENTION_ACTOR)) {
    const due = t.db.prepare('SELECT id, patient_id, orthanc_id, updated_at FROM imaging_studies WHERE orthanc_id IS NOT NULL AND updated_at < ? ORDER BY updated_at')
      .all(cutoff) as Array<{ id: string; patient_id: string; orthanc_id: string; updated_at: string }>
    for (const st of due) {
      const runs = t.db.prepare("SELECT id FROM imaging_runs WHERE study_id = ? AND status IN ('queued', 'running')").all(st.id) as Array<{ id: string }>
      const runBusy = runs.some(r => (opts.isRunActive ? opts.isRunActive(r.id) : true))
      const followupBusy = Boolean(t.db.prepare(`SELECT 1 FROM imaging_followups WHERE (study_id = ? OR prior_study_id = ?) AND status IN ('queued', 'running') AND created_at > ?`)
        .get(st.id, st.id, followupCutoff))
      if (runBusy || followupBusy) { result.busy++; continue }
      try {
        await orthanc.deleteStudy(st.orthanc_id)
      } catch (err) {
        result.failed++
        log.error(`[imaging-retention] 机构 ${t.tenantId} 检查 ${st.id} 原件删除失败，下次重试：${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      // 删除期间又上传过（updated_at 变了）时不标记：新上传的原件以那次为准，留到下次再判断
      const at = new Date(nowMs).toISOString()
      t.db.exec('SAVEPOINT imaging_retention')
      try {
        const changed = t.db.prepare('UPDATE imaging_studies SET orthanc_id = NULL, originals_deleted_at = ?, originals_retention_days = ? WHERE id = ? AND orthanc_id = ? AND updated_at = ?')
          .run(at, days, st.id, st.orthanc_id, st.updated_at).changes
        if (changed) {
          t.db.prepare('UPDATE imaging_series SET orthanc_id = NULL WHERE study_id = ?').run(st.id)
          t.log(st.patient_id, 'imaging_originals_purged', st.id)
        }
        t.db.exec('RELEASE SAVEPOINT imaging_retention')
        if (changed) result.purged++
      } catch (err) {
        t.db.exec('ROLLBACK TO SAVEPOINT imaging_retention')
        t.db.exec('RELEASE SAVEPOINT imaging_retention')
        result.failed++
        log.error(`[imaging-retention] 机构 ${t.tenantId} 检查 ${st.id} 标记失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  if (result.purged || result.busy || result.failed) log.log(`[imaging-retention] 保留期 ${days} 天：删除 ${result.purged} 个检查的原件，跳过进行中的 ${result.busy} 个，失败 ${result.failed} 个`)
  return result
}

/**
 * 每天跑一次（启动后 initialDelayMs 先跑一次）。days 为 0 或没有影像存储时不启动，返回 null；否则返回停止函数。
 * 上一轮没跑完时跳过这一轮。
 */
export function startImagingRetention(patients: PatientService, orthanc: Orthanc | null, opts: RetentionOptions & { intervalMs?: number; initialDelayMs?: number }): (() => void) | null {
  if (!orthanc || !(Math.floor(opts.days) > 0)) return null
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { await purgeExpiredOriginals(patients, orthanc, opts) } catch (err) {
      (opts.log ?? console).error(`[imaging-retention] 清理出错：${err instanceof Error ? err.message : String(err)}`)
    } finally { running = false }
  }
  const first = setTimeout(() => void tick(), opts.initialDelayMs ?? 10 * 60_000)
  const every = setInterval(() => void tick(), opts.intervalMs ?? DAY_MS)
  first.unref?.(); every.unref?.()
  return () => { clearTimeout(first); clearInterval(every) }
}
