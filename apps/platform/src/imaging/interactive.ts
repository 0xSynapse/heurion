import type { Actor, PatientService } from '../tenancy/patients.ts'
import { orthancFromEnv, type Orthanc } from './orthanc.ts'
import { ImagingError, ImagingStudyService, POINT_TASK, parseSegRef, segRef, type LesionRow } from './studies.ts'
import { callWorker, uploadSeries, WorkerError } from './worker.ts'

/**
 * 阅片器里医生点选分割结节（PRD T2.3，docs/design/IMAGING_STUDIES.md「点选补漏与修边界」）：
 * 医生在 OHIF 上点结节（正点）或点不属于结节的地方（负点），平台把这组病人坐标交给 worker 用 VISTA-3D 分割、测量，
 * 生成单 segment 的 DICOM SEG 存回 Orthanc。补漏 = 新建一个医生补充的病灶；修边界 = 用累积的全部点重新分割已有病灶。
 *
 * - 序列在 worker 内存里以 `series_<序列行 id>` 缓存（打开阅片器时预加载；被淘汰后下次点选时重新上传）；
 * - 每次点选记一条 AI 运行（任务 lung_nodule_point）：模型版本、所在序列、提示点数、耗时，未分割到也记；
 * - 肺叶定位要在结节周围再跑一次 VISTA-3D（约占点选总耗时的一半），所以先返回轮廓与测量，平台在后台补上肺叶。
 */

export interface PromptPoint { lps_mm: [number, number, number]; positive: boolean }

/** worker /api/v1/pipeline/lung-nodule/point 的响应（apps/imaging-worker，T2.3） */
interface PointResult {
  model_id: string
  model_version: string
  device?: string
  elapsed_ms?: number
  timings_ms?: Record<string, unknown>
  found: boolean
  reason?: string | null
  nodule: null | {
    center_vox_zyx?: number[]; box_vox_zyx?: number[]; segmentation?: string; key_slice_z?: number
    metrics?: Record<string, unknown> & { mean_diameter_mm?: number | null }; warnings?: string[]
    center_lps_mm?: number[] | null; box_lps_mm?: number[] | null; key_slice_sop_instance_uid?: string | null
    seg_segment_number?: number | null
  }
  seg?: { dicom_base64: string } | null
}

/** 一个结节最多累积的提示点数（与 worker 的上限一致） */
export const MAX_POINTS = 20

/** 校验阅片器传来的提示点：病人坐标 [X, Y, Z]（mm，有限数）与正 / 负 */
export function parsePoints(raw: unknown): PromptPoint[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_POINTS) throw new ImagingError('bad_points', `提示点须为 1~${MAX_POINTS} 个`)
  return raw.map(p => {
    const q = p as { lps_mm?: unknown; positive?: unknown }
    const v = q?.lps_mm
    if (!Array.isArray(v) || v.length !== 3 || !v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 10_000)) {
      throw new ImagingError('bad_points', '提示点坐标须为 [X, Y, Z]（mm）')
    }
    return { lps_mm: [v[0], v[1], v[2]] as [number, number, number], positive: q.positive !== false }
  })
}

const shared = new WeakMap<PatientService, ImagingInteractive>()

/** 进程内共用（预加载的去重、后台定位都在这里） */
export function sharedInteractive(patients: PatientService, orthanc: Orthanc | null = orthancFromEnv()): ImagingInteractive {
  let p = shared.get(patients)
  if (!p) {
    p = new ImagingInteractive(new ImagingStudyService(patients, orthanc), orthanc, process.env.IMAGING_WORKER_URL || 'http://127.0.0.1:8004')
    shared.set(patients, p)
  }
  return p
}

export class ImagingInteractive {
  /** 正在上传到 worker 的序列：同一序列的并发预加载 / 点选共用一次上传 */
  private loading = new Map<string, Promise<void>>()
  /** 后台的肺叶定位（测试等它们完成） */
  private background = new Set<Promise<void>>()

  constructor(
    private readonly studies: ImagingStudyService,
    private readonly orthanc: Orthanc | null,
    private readonly workerUrl: string,
    private readonly opts: { fetch?: typeof fetch } = {},
  ) {
    this.workerUrl = workerUrl.replace(/\/+$/, '')
  }

  private get fetch(): typeof fetch { return this.opts.fetch ?? fetch }

  /** 等后台任务完成（测试用） */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background])
  }

  /** 打开阅片器时预加载所看序列，使第一次点选不必等上传 */
  async prepare(a: Actor, studyUid: string, seriesUid: string): Promise<{ ready: true }> {
    const { seriesId, orthancId } = this.studies.viewerSeries(a, studyUid, seriesUid)
    await this.ensureVolume(seriesId, orthancId)
    return { ready: true }
  }

  /** 补漏：在点击处分割出一个结节，作为医生补充的病灶（已确认）入库 */
  async addAtPoints(a: Actor, studyUid: string, seriesUid: string, points: PromptPoint[]): Promise<LesionRow> {
    if (a.via === 'ai') throw new ImagingError('forbidden', '点选结节须由医生在阅片器里操作', 403)
    if (!points.some(p => p.positive)) throw new ImagingError('bad_points', '至少需要一个点在结节上（正点）')
    const { studyId, seriesId, orthancId } = this.studies.viewerSeries(a, studyUid, seriesUid)
    // 点到的是列表里已有（待确认 / 已确认）的结节：不重复添加，提示医生直接确认或修边界（否决过的不算，医生可以改主意补回）
    const live = this.studies.listLesions(a, studyId).filter(l => l.status === 'proposed' || l.status === 'confirmed')
    const duplicateOf = (r: PointResult) => {
      const c = r.nodule?.center_lps_mm
      if (!Array.isArray(c)) return
      const hit = live.find(l => {
        const lc = l.metrics.center_lps_mm
        if (!Array.isArray(lc) || lc.length !== 3) return false
        const radius = Math.max(3, Number(l.metrics.mean_diameter_mm ?? 0) / 2, Number(r.nodule?.metrics?.mean_diameter_mm ?? 0) / 2)
        return Math.hypot(...lc.map((v, i) => Number(v) - c[i]!)) <= radius
      })
      if (hit) throw new ImagingError('duplicate_lesion', `这里已有「${hit.label ?? '结节'}」（${hit.status === 'proposed' ? '待确认' : '已确认'}），请在列表里确认它或修正边界`, 409)
    }
    const { result, runId, segSeriesId, warnings } = await this.segment(a, studyId, seriesId, orthancId, points, duplicateOf)
    const n = result.nodule!
    const lesion = this.studies.addLesion(a, studyId, {
      run_id: runId, kind: 'lung_nodule', source: 'manual', label: `医生补充 ${this.studies.manualLesionCount(a, studyId) + 1}`, location: null,
      seg_ref: segSeriesId && n.seg_segment_number ? segRef(segSeriesId, n.seg_segment_number) : null,
      metrics: this.metricsOf(result, points, runId, warnings),
    })
    this.locateLater(a, lesion, seriesId, orthancId)
    return lesion
  }

  /**
   * 修边界：以该结节此前的全部提示点（AI 检出的结节以其中心为第一个正点）加上新点重新分割；replace = true 时只用给出的点
   * （面板「撤销上一点」用）。新轮廓、测量替换原值，版本号加一并留痕。
   * 换下的旧轮廓若是此前点选产生的中间结果，没有病灶再引用时从影像存储清掉；AI 分析的原始 SEG 保留
   * （AI 原值的追溯依据，也是「AI 轮廓 / 医生修正」配对的训练数据，W7）。
   */
  async refine(a: Actor, lesionId: string, points: PromptPoint[], replace = false): Promise<LesionRow> {
    if (a.via === 'ai') throw new ImagingError('forbidden', '修正结节边界须由医生在阅片器里操作', 403)
    const { lesion, studyId, seriesId, orthancId } = this.studies.lesionSource(a, lesionId)
    if (lesion.status === 'superseded') throw new ImagingError('not_found', '病灶不存在', 404)
    const prior = replace ? [] : this.priorPoints(lesion)
    const all = [...prior, ...points]
    if (all.length > MAX_POINTS) throw new ImagingError('too_many_points', `一个结节最多 ${MAX_POINTS} 个提示点，请先撤销几个点`)
    if (!all.some(p => p.positive)) throw new ImagingError('bad_points', '至少需要一个点在结节上（正点）')
    const { result, runId, segSeriesId, warnings } = await this.segment(a, studyId, seriesId, orthancId, all)
    const n = result.nodule!
    // 当前轮廓来自点选（metrics 里有 point_run_id）才算中间结果；否则是 AI 分析的原始 SEG
    const oldSeg = typeof lesion.metrics.point_run_id === 'string' ? parseSegRef(lesion.seg_ref)?.seriesId ?? null : null
    const keep = { detection_score: lesion.metrics.detection_score ?? null }
    const edited = this.studies.editLesion(a, lesionId, {
      metrics: { ...this.metricsOf(result, all, runId, warnings), ...keep, refined: true },
      seg_ref: segSeriesId && n.seg_segment_number ? segRef(segSeriesId, n.seg_segment_number) : null,
    })
    if (oldSeg) {
      try { await this.studies.removeSupersededSeg(a, studyId, [oldSeg]) } catch { /* 清理失败不影响修正结果，下次分析时还会再清 */ }
    }
    this.locateLater(a, edited, seriesId, orthancId)
    return edited
  }

  /** 撤销医生补充的病灶；其轮廓没有病灶再引用时从影像存储清掉 */
  async withdraw(a: Actor, lesionId: string): Promise<LesionRow> {
    const after = this.studies.withdrawLesion(a, lesionId)
    const seg = parseSegRef(after.seg_ref)?.seriesId
    if (seg) {
      try { await this.studies.removeSupersededSeg(a, after.study_id, [seg]) } catch { /* 同上 */ }
    }
    return after
  }

  // —— 内部 ——

  private priorPoints(l: LesionRow): PromptPoint[] {
    const saved = l.metrics.prompt_points
    if (Array.isArray(saved) && saved.length) return parsePoints(saved)
    const c = l.metrics.center_lps_mm
    if (Array.isArray(c) && c.length === 3) return [{ lps_mm: [Number(c[0]), Number(c[1]), Number(c[2])], positive: true }]
    throw new ImagingError('no_coordinates', '该结节没有病人坐标（体积缺少 DICOM 几何），不能在阅片器里修正边界', 409)
  }

  private metricsOf(r: PointResult, points: PromptPoint[], runId: string, warnings: string[]): Record<string, unknown> {
    const n = r.nodule!
    return {
      ...(n.metrics ?? {}), detection_score: null, center_vox_zyx: n.center_vox_zyx ?? null, box_vox_zyx: n.box_vox_zyx ?? null,
      key_slice_z: n.key_slice_z ?? null, segmentation: n.segmentation ?? null, warnings: [...(n.warnings ?? []), ...warnings],
      center_lps_mm: n.center_lps_mm ?? null, box_lps_mm: n.box_lps_mm ?? null, key_slice_sop_instance_uid: n.key_slice_sop_instance_uid ?? null,
      prompt_points: points, point_run_id: runId, lobe_status: 'pending',
    }
  }

  /**
   * 记一条点选运行 → worker 分割（序列不在 worker 缓存时先上传，再试一次）→ SEG 存回 Orthanc。
   * 点击处没有分割到结构时运行照常记为完成，向医生返回 422 与原因。
   * check：存 SEG 之前对结果的检查（如点到已有结节），抛出的 ImagingError 原样返回给医生，运行照常记为完成。
   */
  private async segment(a: Actor, studyId: string, seriesId: string, orthancId: string, points: PromptPoint[], check?: (r: PointResult) => void): Promise<{ result: PointResult; runId: string; segSeriesId: string | null; warnings: string[] }> {
    const orthanc = this.requireOrthanc()
    const run = this.studies.startRun(a, studyId, { task: POINT_TASK, model_id: POINT_TASK, series_id: seriesId })
    const t0 = Date.now()
    this.studies.setRunStatus(a, run.id, 'running')
    try {
      const volumeId = volumeIdOf(seriesId)
      await this.ensureVolume(seriesId, orthancId)
      const body = JSON.stringify({ volume_id: volumeId, points, seg: true, lobe: false })
      const call = () => callWorker(this.fetch, this.workerUrl, '/api/v1/pipeline/lung-nodule/point', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 120_000)
      let result: PointResult
      try {
        result = await call() as PointResult
      } catch (err) {
        // 预加载之后 worker 重启或按内存淘汰了这个序列：重新上传后再试一次
        if (!(err instanceof WorkerError && err.status === 404)) throw err
        await this.ensureVolume(seriesId, orthancId, true)
        result = await call() as PointResult
      }
      if (!result || typeof result.found !== 'boolean') throw new Error('影像服务返回的结果格式不对（缺少 found）')
      const summary = { device: result.device ?? null, elapsed_ms: result.elapsed_ms ?? null, total_ms: Date.now() - t0, timings_ms: result.timings_ms ?? null,
        points: points.length, negative_points: points.filter(p => !p.positive).length, found: result.found, reason: result.reason ?? null }
      if (!result.found || !result.nodule) {
        this.studies.setRunStatus(a, run.id, 'done', null, { model_version: result.model_version ?? null, summary })
        throw new ImagingError('nothing_segmented', result.reason || '点击处没有分割到结节', 422)
      }
      try { check?.(result) } catch (err) {
        this.studies.setRunStatus(a, run.id, 'done', null, { model_version: result.model_version ?? null, summary: { ...summary, rejected: err instanceof Error ? err.message : String(err) } })
        throw new Handled(err)
      }
      const warnings: string[] = []
      let segSeriesId: string | null = null
      if (result.seg?.dicom_base64) {
        try {
          const up = await orthanc.upload(new Uint8Array(Buffer.from(result.seg.dicom_base64, 'base64')))
          segSeriesId = await this.studies.addDerivedSeries(a, studyId, up.seriesId)
        } catch (err) {
          warnings.push(`分割结果（DICOM SEG）未能存入影像存储：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      this.studies.setRunStatus(a, run.id, 'done', null, { model_version: result.model_version ?? null, summary: { ...summary, total_ms: Date.now() - t0, seg_stored: !!segSeriesId } })
      return { result, runId: run.id, segSeriesId, warnings }
    } catch (err) {
      if (err instanceof Handled) throw err.inner
      if (!(err instanceof ImagingError && err.code === 'nothing_segmented')) {
        try { this.studies.setRunStatus(a, run.id, 'failed', err instanceof Error ? err.message : String(err)) } catch {}
        if (err instanceof WorkerError) throw new ImagingError('worker_failed', err.message, err.status === 400 ? 422 : 502)
      }
      throw err
    }
  }

  /** 序列在 worker 缓存里就绪（force = 跳过状态检查直接重传） */
  private async ensureVolume(seriesId: string, orthancId: string, force = false): Promise<void> {
    const volumeId = volumeIdOf(seriesId)
    const inflight = this.loading.get(volumeId)
    if (inflight) return inflight
    const job = (async () => {
      if (!force) {
        const st = await callWorker(this.fetch, this.workerUrl, `/api/v1/volume/${encodeURIComponent(volumeId)}/status`, { method: 'GET' }, 10_000) as { ready?: boolean } | null
        if (st?.ready) return
      }
      await uploadSeries(this.fetch, this.workerUrl, volumeId, await this.requireOrthanc().seriesArchive(orthancId))
    })().catch(err => {
      if (err instanceof WorkerError) throw new ImagingError('worker_failed', err.message, 502)
      throw err
    }).finally(() => this.loading.delete(volumeId))
    this.loading.set(volumeId, job)
    return job
  }

  /** 后台补肺叶：worker 在结节周围局部做肺叶分割；失败时记为定位失败（医生可在报告里手填） */
  private locateLater(a: Actor, l: LesionRow, seriesId: string, orthancId: string): void {
    const c = l.metrics.center_lps_mm
    if (!Array.isArray(c) || c.length !== 3) {
      this.studies.setLesionLocation(a, l.id, l.version, { location: null, status: 'failed', note: '没有病人坐标，未做肺叶定位' })
      return
    }
    const radius = Number(l.metrics.mean_diameter_mm ?? 0) / 2
    const job = (async () => {
      try {
        await this.ensureVolume(seriesId, orthancId)
        const r = await callWorker(this.fetch, this.workerUrl, '/api/v1/pipeline/lung-nodule/lobe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume_id: volumeIdOf(seriesId), lps_mm: c, radius_mm: radius }),
        }, 120_000) as { lobe?: string | null; note?: string | null }
        this.studies.setLesionLocation(a, l.id, l.version, { location: r?.lobe ?? null, status: 'done', note: r?.note ?? (r?.lobe ? null : '结节周围没有肺叶分割体素，肺叶未定') })
      } catch (err) {
        try { this.studies.setLesionLocation(a, l.id, l.version, { location: null, status: 'failed', note: `肺叶定位失败：${err instanceof Error ? err.message : String(err)}` }) } catch {}
      }
    })()
    this.background.add(job)
    void job.finally(() => this.background.delete(job))
  }

  private requireOrthanc(): Orthanc {
    if (!this.orthanc) throw new ImagingError('orthanc_not_configured', '本机构没有配置影像存储（Orthanc）', 503)
    return this.orthanc
  }
}

/** 已记好运行状态的错误：segment() 的外层 catch 直接抛出原错误 */
class Handled extends Error {
  constructor(readonly inner: unknown) { super('handled') }
}

/** worker 缓存里该序列的编号 */
export const volumeIdOf = (seriesId: string) => `series_${seriesId}`
