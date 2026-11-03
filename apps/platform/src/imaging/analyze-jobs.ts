import type { DatabaseSync } from 'node:sqlite'

/**
 * 旧版「影像分析」（POST /api/patients/:ptid/imaging/analyze）的后台任务状态。
 *
 * - 接口收下影像后立即返回 202 和任务；推理与入档在平台进程里后台进行（见 http/routes/imaging.ts）。
 * - 任务的起止与结果持久化在机构患者库的 imaging_analyze_jobs 表里（随患者级联删除），
 *   进度（阶段、百分比）只在内存里、由轮询时向 worker 拉取，不逐步写库。
 * - 平台重启后内存里的任务没了，后台推理也随进程中断：库里仍是 running、但本进程不认识的任务，
 *   读取时改记为 interrupted 并写明原因，前端据此如实提示「需重新提交」，不会把查不到当成已完成。
 * - 上传文件名可能含可识别信息，只存机构密钥加密后的值。
 */

export type AnalyzeJobStatus = 'running' | 'completed' | 'failed' | 'interrupted'

export interface AnalyzeJob {
  job_id: string
  patient_id: string
  model_id: string
  file_name: string
  status: AnalyzeJobStatus
  stage: string
  detail: string
  percent: number
  started_at: number
  ended_at?: number
  record_id?: string
  error?: string
  via: 'user' | 'ai'
  created_by: string
}

/** 平台重启导致任务中断时给用户的原因 */
export const INTERRUPTED_REASON = '平台服务在推理进行中重启，这次后台任务已中断，结果没有存入患者档案；请重新提交影像'

const ready = new WeakSet<DatabaseSync>()
export function ensureAnalyzeJobsSchema(db: DatabaseSync): void {
  if (ready.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS imaging_analyze_jobs (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL, file_name_enc TEXT, status TEXT NOT NULL, stage TEXT, detail TEXT, percent INTEGER NOT NULL DEFAULT 0,
      error TEXT, record_id TEXT, created_by TEXT NOT NULL, via TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS imaging_analyze_jobs_patient ON imaging_analyze_jobs (patient_id, started_at);
  `)
  ready.add(db)
}

export interface JobStore {
  db: DatabaseSync
  encrypt: (text: string | null) => string | null
  decrypt: (sealed: string | null) => string | null
}

/** 新任务入库（status = running）。 */
export function insertJob(s: JobStore, job: AnalyzeJob): void {
  ensureAnalyzeJobsSchema(s.db)
  s.db.prepare(`INSERT INTO imaging_analyze_jobs (id, patient_id, model_id, file_name_enc, status, stage, detail, percent, error, record_id, created_by, via, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`)
    .run(job.job_id, job.patient_id, job.model_id, s.encrypt(job.file_name), job.status, job.stage, '', Math.round(job.percent), job.created_by, job.via, job.started_at)
}

/** 任务结束（completed / failed）时写回终态。患者已被删除时行已级联删除，更新 0 行即可。 */
export function finishJob(s: JobStore, job: AnalyzeJob): void {
  ensureAnalyzeJobsSchema(s.db)
  s.db.prepare('UPDATE imaging_analyze_jobs SET status = ?, stage = ?, detail = ?, percent = ?, error = ?, record_id = ?, ended_at = ? WHERE id = ?')
    .run(job.status, job.stage, job.detail, Math.round(job.percent), job.error ?? null, job.record_id ?? null, job.ended_at ?? Date.now(), job.job_id)
}

/**
 * 该患者最近一次任务（库里）。isLive(job_id) 为假而库里仍是 running 的，说明是上一个平台进程留下的：
 * 改记为 interrupted 并返回。
 */
export function latestJob(s: JobStore, patientId: string, isLive: (jobId: string) => boolean): AnalyzeJob | null {
  ensureAnalyzeJobsSchema(s.db)
  const r = s.db.prepare('SELECT * FROM imaging_analyze_jobs WHERE patient_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(patientId) as Record<string, any> | undefined
  if (!r) return null
  let file = ''
  try { file = s.decrypt(r.file_name_enc ?? null) ?? '' } catch {}
  const job: AnalyzeJob = {
    job_id: r.id, patient_id: r.patient_id, model_id: r.model_id, file_name: file, status: r.status,
    stage: r.stage ?? '', detail: r.detail ?? '', percent: Number(r.percent) || 0, started_at: Number(r.started_at),
    ended_at: r.ended_at == null ? undefined : Number(r.ended_at), record_id: r.record_id ?? undefined, error: r.error ?? undefined,
    via: r.via === 'ai' ? 'ai' : 'user', created_by: r.created_by,
  }
  if (job.status === 'running' && !isLive(job.job_id)) {
    job.status = 'interrupted'
    job.stage = '任务已中断'
    job.error = INTERRUPTED_REASON
    job.ended_at = Date.now()
    s.db.prepare("UPDATE imaging_analyze_jobs SET status = 'interrupted', stage = ?, error = ?, ended_at = ? WHERE id = ? AND status = 'running'")
      .run(job.stage, job.error, job.ended_at, job.job_id)
  }
  return job
}
