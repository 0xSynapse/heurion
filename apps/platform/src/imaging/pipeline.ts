import type { Actor, PatientService } from '../tenancy/patients.ts'
import { orthancFromEnv, type Orthanc } from './orthanc.ts'
import { ImagingStudyService, segRef, type RunRow, type SeriesView } from './studies.ts'

/**
 * 影像分析流水线（PRD T1.4，docs/design/IMAGING_STUDIES.md）：检查入库 → 按病种选序列 → 排队 → 影像 worker 推理 → 结果入病灶表。
 * 队列以 imaging_runs 的状态为准；进程内只记「本进程正在处理的运行」，服务重启后未完成的运行在列表里显示为中断，可重新分析。
 * 并发由 IMAGING_PIPELINE_CONCURRENCY 控制（默认 1），派发按用户轮转；worker 侧另按内存预算排队（apps/imaging-worker/src/resource_gate.py），
 * 所以等待 worker 的超时放宽到 45 分钟。
 * 原件由平台从 Orthanc 取出交给 worker，worker 不直接访问 Orthanc。
 */

export type ImagingTask = 'lung_nodule'

export interface SeriesChoice { series: SeriesView | null; notes: string[]; reason?: string }

/** 肺算法重建核（各厂商常见命名）；只用来在多个候选序列间排序，不作为必要条件 */
const LUNG_KERNEL = /lung|b[67]\d|i[67]\d|br6\d|fc5\d|fc8\d|^y[ac]$|^l$/i
const CHEST = /chest|lung|thorax|thx|胸/i

/** W1.2 肺结节 / 肺炎：胸部 CT，层厚 ≤ 1.25 mm 的肺算法薄层优先；> 2.5 mm 不分析 */
export function selectLungSeries(series: SeriesView[]): SeriesChoice {
  const ct = series.filter(s => (s.modality ?? '').toUpperCase() === 'CT')
  if (!ct.length) return { series: null, notes: [], reason: '检查中没有 CT 序列' }
  const chest = ct.filter(s => !s.body_part || CHEST.test(s.body_part))
  if (!chest.length) return { series: null, notes: [], reason: `CT 序列的检查部位不是胸部（${[...new Set(ct.map(s => s.body_part))].join('、')}）` }
  // 定位像、剂量报告等层数很少的序列不分析
  const volumes = chest.filter(s => s.instances >= 30)
  if (!volumes.length) return { series: null, notes: [], reason: '没有足够层数的胸部 CT 序列（至少 30 层）' }
  const usable = volumes.filter(s => s.slice_thickness === null || s.slice_thickness <= 2.5)
  if (!usable.length) return { series: null, notes: [], reason: `胸部 CT 层厚均大于 2.5 mm（最薄 ${Math.min(...volumes.map(s => s.slice_thickness!))} mm），不适合结节分析` }
  const rank = (s: SeriesView) => [
    s.slice_thickness !== null && s.slice_thickness <= 1.25 ? 0 : 1,
    s.kernel && LUNG_KERNEL.test(s.kernel) ? 0 : 1,
    s.slice_thickness ?? 99,
    -s.instances,
  ]
  const best = [...usable].sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return 0 })[0]!
  const notes: string[] = []
  if (best.slice_thickness === null) notes.push('序列没有层厚信息，测量可靠性无法确认')
  else if (best.slice_thickness > 1.25) notes.push(`所选序列层厚 ${best.slice_thickness} mm，大于推荐的 1.25 mm`)
  if (!best.kernel || !LUNG_KERNEL.test(best.kernel)) notes.push(`所选序列不是肺算法重建（${best.kernel ?? '重建核未知'}）`)
  return { series: best, notes }
}

interface TaskDef { label: string; endpoint: string; model_id: string; select: (series: SeriesView[]) => SeriesChoice; kind: string }
export const TASKS: Record<ImagingTask, TaskDef> = {
  lung_nodule: { label: '肺结节检出与测量', endpoint: '/api/v1/pipeline/lung-nodule', model_id: 'lung_nodule_pipeline', select: selectLungSeries, kind: 'lung_nodule' },
}

/** worker /api/v1/pipeline/lung-nodule 的响应（apps/imaging-worker，T1.5） */
interface NoduleResult {
  model_id: string
  model_version: string
  device?: string
  elapsed_ms?: number
  series_qc?: Record<string, unknown>
  nodules: Array<{
    index: number; detection_score?: number; center_vox_zyx?: number[]; box_vox_zyx?: number[]; lobe?: string | null
    segmentation?: string; key_slice_z?: number; metrics?: Record<string, unknown>; warnings?: string[]
    /** DICOM 病人坐标（LPS，mm）与关键层的 SOPInstanceUID：阅片器据此跳到对应图像（体积没有 DICOM 几何时为 null） */
    center_lps_mm?: number[] | null; box_lps_mm?: number[] | null; key_slice_sop_instance_uid?: string | null
    /** 该结节在本次 DICOM SEG 里的 segment 编号（分割失败的结节没有） */
    seg_segment_number?: number | null
  }>
  warnings?: string[]
  /** 结节分割的 DICOM SEG（apps/imaging-worker，T1.6）；不能生成时为 null */
  seg?: { dicom_base64: string; series_instance_uid: string; sop_instance_uid: string } | null
}

export interface EnqueueResult { task: ImagingTask; run?: RunRow; skipped?: string; notes?: string[] }

const shared = new WeakMap<PatientService, ImagingPipeline>()

/** 进程内共用一条流水线（界面接口和 MCP 工具排进同一个队列） */
export function sharedPipeline(patients: PatientService, orthanc: Orthanc | null = orthancFromEnv()): ImagingPipeline {
  let p = shared.get(patients)
  if (!p) {
    p = new ImagingPipeline(new ImagingStudyService(patients, orthanc), orthanc, process.env.IMAGING_WORKER_URL || 'http://127.0.0.1:8004',
      { concurrency: Number(process.env.IMAGING_PIPELINE_CONCURRENCY) || 1 })
    shared.set(patients, p)
  }
  return p
}

export class ImagingPipeline {
  private queue: Array<{ actor: Actor; runId: string; notes: string[] }> = []
  private active = new Set<string>()
  /** 每位用户已派发的任务数：派发时优先选派得最少的用户，一人批量上传不会堵住别人 */
  private served = new Map<string, number>()
  private running = 0
  private drained: Array<() => void> = []

  constructor(
    private readonly studies: ImagingStudyService,
    private readonly orthanc: Orthanc | null,
    private readonly workerUrl: string,
    private readonly opts: { concurrency?: number; fetch?: typeof fetch } = {},
  ) {
    this.workerUrl = workerUrl.replace(/\/+$/, '')
  }

  private get fetch(): typeof fetch { return this.opts.fetch ?? fetch }

  /** 本进程是否在排队 / 处理这次运行（用于识别服务重启后中断的运行） */
  isActive(runId: string): boolean { return this.active.has(runId) }

  /** 等队列清空（测试用） */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve()
    return new Promise(res => this.drained.push(res))
  }

  /** 为检查排一次分析；不适用（没有合适序列等）时返回原因，不建运行 */
  enqueue(a: Actor, studyId: string, task: ImagingTask = 'lung_nodule', opts: { visibility?: 'visible' | 'shadow' } = {}): EnqueueResult {
    const def = TASKS[task]
    const choice = def.select(this.studies.seriesOf(a, studyId))
    if (!choice.series) return { task, skipped: choice.reason ?? '没有合适的序列' }
    const run = this.studies.startRun(a, studyId, { task, model_id: def.model_id, series_id: choice.series.id, visibility: opts.visibility })
    this.active.add(run.id)
    this.queue.push({ actor: a, runId: run.id, notes: choice.notes })
    queueMicrotask(() => this.pump())
    return { task, run, notes: choice.notes }
  }

  /** 按用户轮转的派发顺序：每次取「已派发最少」的用户里最早排队的任务 */
  private dispatchOrder(): Array<{ actor: Actor; runId: string; notes: string[] }> {
    const served = new Map(this.served)
    const rest = [...this.queue]
    const out: typeof rest = []
    while (rest.length) {
      let best = 0
      for (let i = 1; i < rest.length; i++) if ((served.get(rest[i]!.actor.userId) ?? 0) < (served.get(rest[best]!.actor.userId) ?? 0)) best = i
      const [item] = rest.splice(best, 1)
      served.set(item!.actor.userId, (served.get(item!.actor.userId) ?? 0) + 1)
      out.push(item!)
    }
    return out
  }

  /** 排队中的运行前面还有几个任务（含正在分析的）；不在本进程队列里时为 null */
  waitingAhead(runId: string): number | null {
    const i = this.dispatchOrder().findIndex(x => x.runId === runId)
    return i < 0 ? null : i + this.running
  }

  private pump(): void {
    const limit = Math.max(1, this.opts.concurrency ?? 1)
    while (this.running < limit && this.queue.length) {
      const item = this.dispatchOrder()[0]!
      this.queue.splice(this.queue.indexOf(item), 1)
      this.served.set(item.actor.userId, (this.served.get(item.actor.userId) ?? 0) + 1)
      this.running++
      void this.process(item.actor, item.runId, item.notes).finally(() => {
        this.running--
        this.active.delete(item.runId)
        this.pump()
        if (!this.queue.length) this.served.clear()  // 轮转只在同一波排队内比较，历史派发数不累计
        if (!this.running && !this.queue.length) for (const r of this.drained.splice(0)) r()
      })
    }
  }

  private async process(a: Actor, runId: string, notes: string[]): Promise<void> {
    const volumeId = `run_${runId}`
    let uploaded = false
    try {
      this.studies.setRunStatus(a, runId, 'running')
      const { run, seriesOrthancId } = this.studies.runSource(a, runId)
      if (!this.orthanc) throw new Error('本机构没有配置影像存储（Orthanc）')
      if (!seriesOrthancId) throw new Error('所分析的序列已不在影像存储中')
      const def = TASKS[run.task as ImagingTask]
      if (!def) throw new Error(`未知的分析任务：${run.task}`)

      const zip = await this.orthanc.seriesArchive(seriesOrthancId)
      const form = new FormData()
      form.append('volume_id', volumeId)
      form.append('file', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), 'series.zip')
      await this.worker('/api/v1/volume/upload', { method: 'POST', body: form }, 300_000)
      uploaded = true

      const result = await this.worker(def.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume_id: volumeId, max_nodules: 20 }) }, 2_700_000) as NoduleResult
      if (!result || !Array.isArray(result.nodules)) throw new Error('影像服务返回的结果格式不对（缺少 nodules）')

      // 分割结果（DICOM SEG）存回 Orthanc，作为本检查的派生序列，OHIF 原生显示轮廓；失败不影响检出入库
      let segSeriesId: string | null = null
      const extraWarnings: string[] = []
      if (result.seg?.dicom_base64) {
        try {
          const up = await this.orthanc.upload(new Uint8Array(Buffer.from(result.seg.dicom_base64, 'base64')))
          segSeriesId = await this.studies.addDerivedSeries(a, run.study_id, up.seriesId)
        } catch (err) {
          extraWarnings.push(`分割结果（DICOM SEG）未能存入影像存储：${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // 与医生已确认 / 否决的结节是同一处的检出不再新增（重新分析时避免重复，医生的判断保留）
      const spacing = Array.isArray(result.series_qc?.spacing_mm) ? (result.series_qc!.spacing_mm as number[]) : null
      const reviewed = this.studies.listLesions(a, run.study_id).filter(l => l.kind === def.kind && (l.status === 'confirmed' || l.status === 'rejected'))
      const seriesOfRun = new Map<string, string | null>()
      const sameSpot = (n: NoduleResult['nodules'][number]) => reviewed.some(l => {
        const m = l.metrics as Record<string, unknown>
        const radius = Math.max(3, Number(m.mean_diameter_mm ?? 0) / 2, Number(n.metrics?.mean_diameter_mm ?? 0) / 2)
        const lps = m.center_lps_mm as number[] | null | undefined
        if (Array.isArray(lps) && Array.isArray(n.center_lps_mm)) return Math.hypot(...lps.map((v, i) => v - n.center_lps_mm![i]!)) <= radius
        const vox = m.center_vox_zyx as number[] | null | undefined
        if (!spacing || !Array.isArray(vox) || !Array.isArray(n.center_vox_zyx) || !l.run_id) return false
        if (!seriesOfRun.has(l.run_id)) seriesOfRun.set(l.run_id, this.studies.runSource(a, l.run_id).run.series_id)
        if (seriesOfRun.get(l.run_id) !== run.series_id) return false
        return Math.hypot(...vox.map((v, i) => (v - n.center_vox_zyx![i]!) * spacing[i]!)) <= radius
      })
      let matchedReviewed = 0, segLinked = 0
      for (const n of result.nodules) {
        if (sameSpot(n)) { matchedReviewed++; continue }
        if (segSeriesId && n.seg_segment_number) segLinked++
        this.studies.addLesion(a, run.study_id, {
          run_id: runId, kind: def.kind, source: 'ai', label: `结节 ${n.index}`, location: n.lobe ?? null,
          seg_ref: segSeriesId && n.seg_segment_number ? segRef(segSeriesId, n.seg_segment_number) : null,
          metrics: {
            ...(n.metrics ?? {}), detection_score: n.detection_score ?? null, center_vox_zyx: n.center_vox_zyx ?? null, box_vox_zyx: n.box_vox_zyx ?? null,
            key_slice_z: n.key_slice_z ?? null, segmentation: n.segmentation ?? null, warnings: n.warnings ?? [],
            center_lps_mm: n.center_lps_mm ?? null, box_lps_mm: n.box_lps_mm ?? null, key_slice_sop_instance_uid: n.key_slice_sop_instance_uid ?? null,
          },
        })
      }
      const superseded = this.studies.supersedeProposed(a, runId)
      // 被取代的旧检出若是某个 SEG 的唯一引用者，那个 SEG 不再有用：从影像存储清掉（医生审核过的保留）
      let segRemoved = 0
      try { segRemoved = await this.studies.removeSupersededSeg(a, run.study_id, segSeriesId) } catch (err) {
        extraWarnings.push(`清理旧的分割结果失败：${err instanceof Error ? err.message : String(err)}`)
      }
      this.studies.setRunStatus(a, runId, 'done', null, {
        model_version: result.model_version ?? null,
        summary: {
          device: result.device ?? null, elapsed_ms: result.elapsed_ms ?? null, series_qc: result.series_qc ?? null,
          warnings: [...notes, ...(result.warnings ?? []), ...extraWarnings, ...(matchedReviewed ? [`${matchedReviewed} 个检出与医生已审核的结节是同一处，未重复添加`] : [])],
          found: result.nodules.length - matchedReviewed, matched_reviewed: matchedReviewed, superseded, seg_stored: segLinked > 0, seg_removed: segRemoved,
        },
      })
    } catch (err) {
      try { this.studies.setRunStatus(a, runId, 'failed', err instanceof Error ? err.message : String(err)) } catch {}
    } finally {
      if (uploaded) await this.worker(`/api/v1/volume/${encodeURIComponent(volumeId)}`, { method: 'DELETE' }, 10_000).catch(() => {})
    }
  }

  /** 调影像 worker；错误如实转成中文说明（501 模型不可用、4xx 输入问题、其它为服务故障） */
  private async worker(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    let resp: Response
    try {
      resp = await this.fetch(`${this.workerUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      const name = (err as Error)?.name
      throw new Error(name === 'TimeoutError' || name === 'AbortError' ? '影像服务处理超时' : `影像服务连接失败：${(err as Error).message}`)
    }
    if (!resp.ok) {
      let detail = ''
      try { const t = await resp.text(); try { const j = JSON.parse(t); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j) } catch { detail = t } } catch {}
      const kind = resp.status === 501 ? '模型不可用' : resp.status === 404 ? '影像不存在' : resp.status >= 400 && resp.status < 500 ? '影像输入有误' : '影像服务出错'
      throw new Error(`${kind}（HTTP ${resp.status}）：${detail.slice(0, 300)}`)
    }
    const text = await resp.text()
    return text ? JSON.parse(text) : null
  }
}
