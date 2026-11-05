import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { DatasetService, DatasetView } from '../datasets/service.ts'
import { DEID_METHOD, DEID_SCHEME } from '../imaging/deid/deidentify.ts'
import type { Actor, CohortImagingExportRow, LabRow, PatientService, SubjectVar } from '../tenancy/patients.ts'
import { parseCustomVars, parseEligibilityPlan, StudyError, type CustomVarDef, type StudyService } from './service.ts'

/**
 * 研究入组与研究数据集（docs/design/COHORT.md）。
 * - 筛选：在「我在诊疗组里的」在管患者中按性别、年龄、诊断标签、化验（标准单位的已确认值）、报告日期窗口筛选 → 预览（代号 + 匹配依据）→ 勾选入组。
 * - 入组关系与研究编号（S001…）在机构的患者库里（patients.ts enrollments）；研究在平台库。同一患者可入多个研究。
 * - 研究数据集：入组受试者的快照（只有研究编号，没有代号 / 备注姓名），宽表或长表，作为一个可用的数据集归入研究。
 *   之后入组名单或受试者化验有变化 → 数据集标「已过期」；刷新生成新版本，旧版本保留（已有分析的来源记录指向旧版本，覆盖会让分析对不上数据）。
 * - 研究成员：筛选、入组、移出、生成数据集要「可编辑」及以上，且入组仍要求操作者在患者诊疗组里；只读成员能看入组人数与研究编号、读研究数据集
 *   （代号只给操作者能看到的患者）。
 * - AI 与人相同（MCP study_cohort_*）；AI 入组 / 移出受机构设置 ai_patient_writes 约束（review 时变成待确认提议，由研究负责人确认）。
 */

export type Shape = 'wide' | 'long'
export type FollowupLandmark = 'm1' | 'm3' | 'm6' | 'm12'
export interface CohortOrigin {
  kind: 'cohort'; study_id: string; shape: Shape; tests: string[] | null; from: string | null; to: string | null; relative_days?: boolean
  baseline_window_days?: [number, number] | null; landmarks?: FollowupLandmark[]; include_change?: boolean
  generated_at: string; fingerprint: string; subjects: number; trusted_columns: string[]
}

const q = (v: unknown) => v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)
const csv = (rows: unknown[][]) => rows.map(r => r.map(q).join(',')).join('\n') + '\n'
/** 列名里的单位：µmol/L → umol_L，10^9/L → 10e9_L，% → pct（pandas 里好用） */
const unitSlug = (u: string | null) => u ? '_' + u.replace(/µ/g, 'u').replace(/\^/g, 'e').replace(/%/g, 'pct').replace(/²/g, '2').replace(/[^A-Za-z0-9.]+/g, '_').replace(/\./g, '').replace(/^_|_$/g, '') : ''
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null

/** 计算两个日期相差的天数（d1 - d0），用于以入组日为 Day 0 的相对时间轴。 */
function daysDiff(d1: string | null | undefined, d0: string | null | undefined): number | null {
  if (!d1 || !d0 || !/^\d{4}-\d{2}-\d{2}$/.test(d1) || !/^\d{4}-\d{2}-\d{2}$/.test(d0)) return null
  const ms1 = Date.parse(d1), ms0 = Date.parse(d0)
  if (Number.isNaN(ms1) || Number.isNaN(ms0)) return null
  return Math.round((ms1 - ms0) / 86400000)
}

export class CohortService {
  constructor(private readonly studies: StudyService, private readonly patients: PatientService, private readonly datasets: DatasetService | null) {
    studies.onRemove = (owner, id) => patients.dropStudy({ userId: owner, via: 'user' }, id)
  }

  preview(a: Actor, studyId: string, criteria: unknown) {
    const study = this.studies.get(a.userId, studyId, 'write')
    const raw = (criteria && typeof criteria === 'object' ? { ...(criteria as Record<string, unknown>) } : {}) as Record<string, unknown>
    if (raw.extract_from_protocol) {
      const extracted = this.studies.extractEligibilityFromProtocol(a.userId, studyId, {
        protocol_text: typeof raw.protocol_text === 'string' ? raw.protocol_text : undefined,
        template_id: typeof raw.template_id === 'string' ? raw.template_id : undefined,
      })
      if (!Array.isArray(raw.inclusion_rules)) raw.inclusion_rules = extracted.eligibility_plan.inclusion_rules
      if (!Array.isArray(raw.exclusion_rules)) raw.exclusion_rules = extracted.eligibility_plan.exclusion_rules
    } else if (raw.use_study_plan) {
      const plan = parseEligibilityPlan(study.eligibility_plan)
      if (plan) {
        if (!Array.isArray(raw.inclusion_rules)) raw.inclusion_rules = plan.inclusion_rules
        if (!Array.isArray(raw.exclusion_rules)) raw.exclusion_rules = plan.exclusion_rules
      }
    }
    const res = this.patients.screen(a, studyId, raw)
    const hasProtocolRules = Boolean(
      raw.use_study_plan ||
      raw.extract_from_protocol ||
      raw.save_plan ||
      (Array.isArray(raw.inclusion_rules) && raw.inclusion_rules.length > 0) ||
      (Array.isArray(raw.exclusion_rules) && raw.exclusion_rules.length > 0),
    )
    let eligibility_plan = parseEligibilityPlan(this.studies.get(a.userId, studyId).eligibility_plan)
    if (hasProtocolRules && raw.save_funnel !== false) {
      eligibility_plan = this.studies.saveScreeningFunnel(a.userId, studyId, res.funnel, {
        inclusion_rules: res.criteria.inclusion_rules,
        exclusion_rules: res.criteria.exclusion_rules,
      })
    }
    return { ...res, eligibility_plan }
  }

  enroll(a: Actor, studyId: string, input: { patient_ids?: unknown; criteria?: unknown }) {
    this.studies.get(a.userId, studyId, 'write')
    const ids = Array.isArray(input.patient_ids) ? input.patient_ids.filter((x): x is string => typeof x === 'string') : []
    if (!ids.length) throw new StudyError('bad_patients', 'patient_ids 不能为空')
    return this.patients.enroll(a, studyId, ids, input.criteria ?? null)
  }

  unenroll(a: Actor, studyId: string, patientId: string) {
    this.studies.get(a.userId, studyId, 'write')
    return this.patients.unenroll(a, studyId, patientId)
  }

  /** 入组名单、待确认的入组提议、研究数据集（最新版本是否过期）以及研究纳排方案。 */
  list(a: Actor, studyId: string) {
    const study = this.studies.get(a.userId, studyId)
    const { subjects, pending } = this.patients.enrollments(a, studyId)
    return {
      active: subjects.filter(s => s.status === 'active').length,
      subjects,
      pending,
      datasets: this.cohortDatasets(a, studyId),
      eligibility_plan: parseEligibilityPlan(study.eligibility_plan),
    }
  }

  /** 研究里由队列生成的数据集；每种形状最新的一版判断是否过期，更早的标为旧版本。 */
  private cohortDatasets(a: Actor, studyId: string) {
    if (!this.datasets) return []
    const sets = this.studies.read(a.userId, studyId).datasets.filter(d => d.cohort).map(d => this.datasets!.get(a.userId, d.dataset_id))
      .sort((x, y) => y.version - x.version)
    const seen = new Set<string>()
    return sets.map(d => {
      const o = d.origin as unknown as CohortOrigin
      const latest = !seen.has(o.shape)
      seen.add(o.shape)
      const stale = latest ? this.patients.cohortSnapshot(a, studyId, { tests: o.tests ?? undefined, from: o.from, to: o.to }).fingerprint !== o.fingerprint : null
      return { dataset_id: d.id, name: d.name, shape: o.shape, version: d.version, rows: d.rows, cols: d.cols, status: d.status, generated_at: o.generated_at, subjects: o.subjects, latest, stale }
    })
  }

  /**
   * 生成（或刷新）研究数据集：快照 → CSV → 数据集（自动归入研究）。
   * tests 不填 = 入组受试者有过的全部化验项目；from / to 限定化验日期；relative_days=true 计算相对入组日（Day 0）天数。
   * 支持 baseline_window_days（如 [-30, 7] 锚定入组日前后基线时间窗）与 landmarks（['m1','m3','m6','m12'] 纵向随访节点及基线变化率）。
   */
  async dataset(
    a: Actor,
    studyId: string,
    input: {
      shape?: unknown
      tests?: unknown
      from?: unknown
      to?: unknown
      relative_days?: unknown
      baseline_window_days?: unknown
      landmarks?: unknown
      include_change?: unknown
    },
  ): Promise<{ dataset: DatasetView; unchanged: boolean; skipped: string[] }> {
    const study = this.studies.get(a.userId, studyId, 'write')
    if (!this.datasets) throw new StudyError('unavailable', '数据集未启用')
    const shape: Shape = input.shape === 'long' ? 'long' : 'wide'
    const relativeDays = Boolean(input.relative_days)
    const tests = Array.isArray(input.tests) ? input.tests.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, 50) : []
    const from = date(input.from), to = date(input.to)
    const baselineWindow: [number, number] | null =
      Array.isArray(input.baseline_window_days) &&
      input.baseline_window_days.length === 2 &&
      Number.isFinite(Number(input.baseline_window_days[0])) &&
      Number.isFinite(Number(input.baseline_window_days[1]))
        ? [Number(input.baseline_window_days[0]), Number(input.baseline_window_days[1])]
        : null
    const validLandmarks = new Set<FollowupLandmark>(['m1', 'm3', 'm6', 'm12'])
    const landmarks: FollowupLandmark[] = Array.isArray(input.landmarks)
      ? input.landmarks.filter((x): x is FollowupLandmark => typeof x === 'string' && validLandmarks.has(x as FollowupLandmark))
      : []
    const includeChange = Boolean(input.include_change || landmarks.length > 0)

    const snap = this.patients.cohortSnapshot(a, studyId, { tests, from, to, log: true })
    if (!snap.subjects.length) throw new StudyError('empty_cohort', snap.skipped.length ? '入组的患者你都不在诊疗组里了，不能生成数据集' : '还没有入组的患者')
    const customVars = parseCustomVars(study.custom_vars)
    const { header, rows, labels } = shape === 'wide'
      ? wide(snap.subjects, relativeDays, customVars, { baselineWindow, landmarks, includeChange })
      : long(snap.subjects, relativeDays)
    const prev = this.cohortDatasets(a, studyId).filter(d => d.shape === shape)
    const version = (prev[0]?.version ?? 0) + 1
    const origin: CohortOrigin = {
      kind: 'cohort', study_id: studyId, shape, tests: tests.length ? tests : null, from, to,
      relative_days: relativeDays ? true : undefined,
      baseline_window_days: baselineWindow ?? undefined,
      landmarks: landmarks.length ? landmarks : undefined,
      include_change: includeChange ? true : undefined,
      generated_at: new Date().toISOString(),
      fingerprint: snap.fingerprint, subjects: snap.subjects.length, trusted_columns: header,
    }
    const label = shape === 'wide' ? '宽表' : '长表'
    const { dataset, duplicate } = this.datasets.upload(a.userId, `cohort-${shape}-v${version}.csv`, Buffer.from(csv([header, ...rows]), 'utf8'), { name: `${study.title} · 队列${label} v${version}`, origin: origin as never, version })
    if (duplicate) {
      // 数据完全相同：沿用那一版，更新它的指纹（例如化验被同值更正）
      this.datasets.setOrigin(a.userId, dataset.id, { ...(dataset.origin ?? {}), fingerprint: snap.fingerprint } as never)
    } else {
      await this.datasets.idle()
      const done = this.datasets.get(a.userId, dataset.id)
      if (done.status === 'failed') {
        this.datasets.remove(a.userId, dataset.id)
        throw new StudyError('dataset_failed', `生成研究数据集失败：${done.error ?? '未知原因'}`)
      }
      this.datasets.update(a.userId, dataset.id, { labels })
    }
    try { this.studies.link(a.userId, studyId, { kind: 'dataset', ref_id: dataset.id }) } catch (err) { if (!(err instanceof StudyError && err.code === 'in_other_study')) throw err }
    return { dataset: this.datasets.get(a.userId, dataset.id), unchanged: duplicate, skipped: snap.skipped }
  }

  /**
   * 队列级批量 3D 医学影像量化与科研宽表生成流水线：
   * 调取影像微服务做病灶测量与 L3 体成分（HU 阈值法）测量（不判定肌少症），
   * 汇聚成宽表 CSV，并自动作为科研数据集归入研究。
   */
  async imagingBatchAnalyze(a: Actor, studyId: string, input: {
    patient_ids?: string[]
    model_id?: string
    save_as_dataset?: boolean
    dataset_name?: string
  }): Promise<{
    status: string
    study_id: string
    total_cases: number
    successful_cases: number
    failed_cases: number
    columns: string[]
    dataframe_rows: Array<Record<string, unknown>>
    csv_content: string
    dataset?: DatasetView
    summary_markdown: string
  }> {
    const study = this.studies.get(a.userId, studyId, 'write')
    const { subjects } = this.patients.enrollments(a, studyId)
    const active = subjects.filter(s => s.status === 'active')
    const modelName = input.model_id || 'lung_nodule_segmenter'

    let pids: string[]
    if (input.patient_ids && input.patient_ids.length > 0) {
      // H19 修复：严格校验传入的受试者 ID 必须属于当前研究有效入组受试者，防范跨研究越权访问
      const activePids = new Set(active.map(s => s.patient_id))
      const invalid = input.patient_ids.filter(p => !activePids.has(p))
      if (invalid.length > 0) {
        throw new StudyError('invalid_patient_ids', `受试者 [${invalid.join(', ')}] 未在当前研究有效入组，拒绝跨研究访问`)
      }
      pids = input.patient_ids
    } else {
      pids = active.map(s => s.patient_id)
    }
    if (!pids.length) throw new StudyError('empty_cohort', '该研究暂无活跃入组受试者')

    if ((input as any).file_paths !== undefined) {
      throw new StudyError('invalid_input', '不允许直接传入服务器文件路径 file_paths')
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'heurion-cohort-img-'))
    try {
      // B1 修复：绝不使用写死的演示 sample_id（chest_lung_ct）或编造的 1.72m/68kg 人口学数据
      const cases = pids.map(pid => {
        const subj = active.find(s => s.patient_id === pid)
        let filePath: string | undefined = undefined
        let sampleId: string | undefined = undefined

        try {
          const pData = this.patients.read(a, pid)
          const imgRecord = pData.records?.find(r => r.kind === 'imaging' && r.file_id && /^[A-Za-z0-9_-]+$/.test(r.file_id))
          if (imgRecord?.file_id) {
            try {
              const dec = this.patients.file(a, pid, imgRecord.file_id)
              const ext = extname(dec.name || '').replace(/[^a-zA-Z0-9.]/g, '') || '.nii.gz'
              const tmpPath = join(tempDir, `${imgRecord.file_id}${ext}`)
              writeFileSync(tmpPath, dec.bytes)
              filePath = tmpPath
            } catch {
              filePath = `/app/data/platform/files/${imgRecord.file_id}`
            }
          }
        } catch {}

        const rawSample = (input as any).sample_ids?.[pid]
        if (typeof rawSample === 'string' && /^[A-Za-z0-9_-]+$/.test(rawSample)) {
          sampleId = rawSample
        }

        return {
          subject_id: subj?.subject_id || pid,
          patient_id: pid,
          sample_id: sampleId,
          file_path: filePath,
          model_name: modelName,
          patient_sex: subj?.sex || undefined,
          patient_height_m: undefined,
          patient_weight_kg: undefined,
        }
      })

      const imagingWorkerUrl = (process.env.IMAGING_WORKER_URL || 'http://127.0.0.1:8004').replace(/\/+$/, '')
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/cohort/batch-analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ study_id: studyId, cases }),
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new StudyError('batch_analyze_failed', `队列影像批量分析失败 HTTP ${resp.status}: ${errText}`)
      }
      const res = await resp.json()

      let datasetView: DatasetView | undefined
      if (input.save_as_dataset !== false && this.datasets) {
        const dName = input.dataset_name || `${study.title} · 队列影像量化宽表`
        const { dataset } = this.datasets.upload(
          a.userId,
          `cohort-imaging-${studyId}.csv`,
          Buffer.from(res.csv_content, 'utf8'),
          {
            name: dName,
            origin: {
              kind: 'cohort',
              study_id: studyId,
              shape: 'wide',
              generated_at: new Date().toISOString(),
              fingerprint: `${studyId}-${Date.now()}`,
              subjects: cases.length,
              trusted_columns: res.columns,
            } as never
          }
        )
        await this.datasets.idle()
        const done = this.datasets.get(a.userId, dataset.id)
        if (done.status === 'failed') {
          this.datasets.remove(a.userId, dataset.id)
          throw new StudyError('dataset_failed', `生成队列影像数据集失败：${done.error ?? '未知原因'}`)
        }
        try {
          this.studies.link(a.userId, studyId, { kind: 'dataset', ref_id: dataset.id })
        } catch (err) {
          if (!(err instanceof StudyError && err.code === 'in_other_study')) throw err
        }
        datasetView = done
      }

      return {
        ...res,
        study_id: studyId,
        dataset: datasetView,
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }

  // —— 科研队列去标识影像与测量导出（W6.2 / W6.4，T2.8：只用定稿数据、PS3.15 去标识、烧录文字拦截、PI 审批）——

  /**
   * 发起科研去标识影像与定稿结节测量导出申请（W6.4）：
   * - 只纳人 W5 已定稿（imaging_signoffs）的检查快照，未定稿检查自动跳过并计数；
   * - 自动检测并拦截含烧录文字或截屏风险的序列（BurnedInAnnotation=YES、Secondary Capture、SCREEN SAVE 等）；
   * - 导出清单与 CSV 只含伪匿名研究编号（subject_id，如 S001），绝不出现真实姓名或院内病历号；
   * - 创建后状态为 pending_pi_approval，须由课题负责人（PI / owner）审批通过后方可获取导出内容。
   */
  requestImagingExport(
    a: Actor,
    studyId: string,
    input: {
      include_dicom?: unknown
      include_seg?: unknown
      include_csv?: unknown
      reason?: unknown
      series_headers?: Record<string, { burned_in_annotation?: string; image_type?: string; sop_class_uid?: string; modality?: string }>
    } = {},
  ) {
    this.studies.get(a.userId, studyId, 'write')
    const includeDicom = input.include_dicom !== false
    const includeSeg = input.include_seg !== false
    const includeCsv = input.include_csv !== false
    if (!includeDicom && !includeSeg && !includeCsv) {
      throw new StudyError('bad_export_options', '请至少选择一项导出内容（DICOM / DICOM SEG / 测量 CSV）')
    }
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : null
    const extraHeaders = input.series_headers && typeof input.series_headers === 'object' ? input.series_headers : {}

    const { subjects, skipped_subjects } = this.patients.cohortFinalizedImaging(a, studyId)
    if (!subjects.length) {
      throw new StudyError('empty_cohort', skipped_subjects.length ? '入组的受试者你都不在诊疗组里，不能发起导出' : '该研究暂无有效入组受试者')
    }

    const exportedSeries: Array<{
      subject_id: string
      imaging_study_id: string
      study_date: string | null
      signoff_version: number
      series_id: string
      modality: string | null
      slice_thickness: number | null
      instances: number
      deid_patient_id: string
      deid_method: string
    }> = []
    const exportedSegs: Array<{
      subject_id: string
      imaging_study_id: string
      signoff_version: number
      lesion_id: string
      seg_ref: string
    }> = []
    const blockedSeries: Array<{
      subject_id: string
      imaging_study_id: string
      series_id: string
      modality: string | null
      reason: string
    }> = []
    const csvHeader = [
      'subject_id', 'imaging_study_id', 'study_date', 'signoff_version',
      'lesion_id', 'label', 'location', 'nodule_type',
      'mean_diameter_mm', 'long_axis_mm', 'short_axis_mm', 'solid_core_mm',
      'volume_mm3', 'mean_hu', 'vdt_days', 'seg_ref',
    ]
    const csvRows: unknown[][] = []
    const includedPatientIds: string[] = []
    let finalizedStudyCount = 0
    let skippedUnfinalizedStudies = 0

    for (const s of subjects) {
      skippedUnfinalizedStudies += s.unfinalized_count
      if (!s.finalized_studies.length) continue
      includedPatientIds.push(s.patient_id)
      for (const st of s.finalized_studies) {
        finalizedStudyCount++
        for (const sr of st.series) {
          const risk = checkSeriesBurnedInRisk(sr, extraHeaders[sr.id])
          if (risk) {
            blockedSeries.push({
              subject_id: s.subject_id,
              imaging_study_id: st.study_id,
              series_id: sr.id,
              modality: sr.modality,
              reason: risk,
            })
            continue
          }
          if (includeDicom) {
            exportedSeries.push({
              subject_id: s.subject_id,
              imaging_study_id: st.study_id,
              study_date: st.study_date,
              signoff_version: st.version,
              series_id: sr.id,
              modality: sr.modality,
              slice_thickness: sr.slice_thickness,
              instances: sr.instances,
              deid_patient_id: s.subject_id,
              deid_method: DEID_METHOD,
            })
          }
        }
        for (const l of st.lesions) {
          const m = l.metrics ?? {}
          if (includeSeg && l.seg_ref) {
            exportedSegs.push({
              subject_id: s.subject_id,
              imaging_study_id: st.study_id,
              signoff_version: st.version,
              lesion_id: l.id,
              seg_ref: l.seg_ref,
            })
          }
          if (includeCsv) {
            csvRows.push([
              s.subject_id,
              st.study_id,
              st.study_date,
              st.version,
              l.id,
              l.label,
              l.location,
              m.nodule_type ?? null,
              m.mean_diameter_mm ?? null,
              m.long_axis_mm ?? null,
              m.short_axis_mm ?? null,
              m.solid_core_mm ?? null,
              m.volume_mm3 ?? null,
              m.mean_hu ?? null,
              m.vdt_days ?? null,
              l.seg_ref ?? null,
            ])
          }
        }
      }
    }

    if (finalizedStudyCount === 0) {
      throw new StudyError('no_finalized_imaging', '入组受试者暂无已定稿（W5 Finalized）的影像检查，未定稿数据不可用于科研导出')
    }

    const csvContent = includeCsv ? csv([csvHeader, ...csvRows]) : ''
    const manifest = {
      deid_scheme: DEID_SCHEME,
      deid_method: DEID_METHOD,
      pseudonym_only: true,
      finalized_only: true,
      subjects_included: includedPatientIds.length,
      finalized_studies_count: finalizedStudyCount,
      skipped_unfinalized_studies: skippedUnfinalizedStudies,
      skipped_subjects,
      exported_series_count: exportedSeries.length,
      exported_segs_count: exportedSegs.length,
      measurements_count: csvRows.length,
      blocked_series: blockedSeries,
      exported_series: exportedSeries,
      exported_segs: exportedSegs,
      csv_content: csvContent,
    }

    const row = this.patients.createCohortImagingExport(a, studyId, {
      include_dicom: includeDicom,
      include_seg: includeSeg,
      include_csv: includeCsv,
      reason,
      manifest,
      patient_ids: includedPatientIds,
    })
    return formatImagingExport(row)
  }

  /** 列出本研究的科研影像导出申请（未获 PI 审批前不返回 csv_content 与序列下载明细）。 */
  listImagingExports(a: Actor, studyId: string) {
    this.studies.get(a.userId, studyId)
    return {
      study_id: studyId,
      my_role: this.studies.role(a.userId, studyId),
      exports: this.patients.listCohortImagingExports(a, studyId).map(formatImagingExport),
    }
  }

  /**
   * 课题负责人（PI / owner）审批科研影像导出申请（W6.4）：
   * 只有研究 owner 本人（非 AI）可批准或驳回；审批结果写入患者访问审计日志。
   */
  reviewImagingExport(a: Actor, studyId: string, exportId: string, input: { decision?: unknown; note?: unknown }) {
    this.studies.get(a.userId, studyId)
    const role = this.studies.role(a.userId, studyId)
    if (role !== 'owner') {
      throw new StudyError('pi_only', '只有课题负责人（PI / owner）可以审批科研影像导出', 403)
    }
    const decision = input.decision === 'approve' || input.decision === 'reject' ? input.decision : null
    if (!decision) {
      throw new StudyError('bad_decision', '审批结论（decision）须为 approve（批准）或 reject（驳回）')
    }
    const note = typeof input.note === 'string' ? input.note : null
    const row = this.patients.reviewCohortImagingExport(a, studyId, exportId, { decision, note })
    return formatImagingExport(row)
  }
}

const SERIES_MODALITY_RISK: Record<string, string> = {
  SC: '二次采集（Secondary Capture）影像常有烧录的患者信息',
  OT: '模态为 OT（其他），常是截图或文档，可能有烧录文字',
  US: '超声影像通常在画面里烧录患者信息',
  IVUS: '血管内超声影像通常在画面里烧录患者信息',
  XC: '外部相机照片可能拍到患者面部或文字',
  ES: '内镜影像通常在画面里烧录患者信息',
  GM: '大体照片可能有标签文字',
  OP: '眼科照片可能有烧录文字',
  DOC: '扫描文档含患者信息',
  SR: '结构化报告含自由文本，不在影像去标识范围内',
  KO: '关键图像标注（KO）不在影像去标识范围内',
  PR: '显示状态（PR）可能含文字标注',
}
const SERIES_SOP_RISK: Array<[string, string]> = [
  ['1.2.840.10008.1.3.10', 'DICOMDIR 目录文件不导出'],
  ['1.2.840.10008.5.1.4.1.1.7', '二次采集（Secondary Capture）影像常有烧录的患者信息'],
  ['1.2.840.10008.5.1.4.1.1.88.', '结构化报告含自由文本，不在影像去标识范围内'],
  ['1.2.840.10008.5.1.4.1.1.11.', '显示状态（PR）可能含文字标注'],
  ['1.2.840.10008.5.1.4.1.1.104.', '封装文档（PDF / CDA）含患者信息'],
  ['1.2.840.10008.5.1.4.1.1.77.', '可见光照片 / 视频可能有烧录文字或面部'],
]
const SERIES_TEXT_RISK = ['SCREEN SAVE', 'SCREENSHOT', 'DOSE INFO', 'DOSE_INFO', 'DOSE REPORT', 'BURNED_IN', 'BURNEDIN']

function checkSeriesBurnedInRisk(
  sr: { modality: string | null; description: string | null },
  extra?: { burned_in_annotation?: string; image_type?: string; sop_class_uid?: string; modality?: string },
): string | null {
  if ((extra?.burned_in_annotation ?? '').toUpperCase() === 'YES') {
    return '标记为有烧录文字（BurnedInAnnotation = YES），画面里可能有患者信息'
  }
  const sop = extra?.sop_class_uid ?? ''
  for (const [prefix, why] of SERIES_SOP_RISK) {
    if (sop === prefix || (prefix.endsWith('.') ? sop.startsWith(prefix) : sop.startsWith(`${prefix}.`))) return why
  }
  const mod = (extra?.modality ?? sr.modality ?? '').toUpperCase()
  if (SERIES_MODALITY_RISK[mod]) return SERIES_MODALITY_RISK[mod]!
  const combined = `${sr.description ?? ''} ${extra?.image_type ?? ''}`.toUpperCase()
  const hit = SERIES_TEXT_RISK.find(t => combined.includes(t))
  if (hit) return `序列描述或图像类型含 ${hit}（截屏 / 剂量报告），画面里可能有烧录患者信息`
  return null
}

function formatImagingExport(row: CohortImagingExportRow) {
  const m = row.manifest ?? {}
  const approved = row.status === 'approved'
  return {
    id: row.id,
    study_id: row.study_id,
    status: row.status,
    approval_required: !approved,
    include_dicom: row.include_dicom,
    include_seg: row.include_seg,
    include_csv: row.include_csv,
    reason: row.reason,
    requested_by: row.requested_by,
    requested_via: row.requested_via,
    requested_at: row.requested_at,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    review_note: row.review_note,
    deid_scheme: m.deid_scheme ?? DEID_SCHEME,
    deid_method: m.deid_method ?? DEID_METHOD,
    pseudonym_only: true,
    finalized_only: true,
    subjects_included: Number(m.subjects_included ?? 0),
    finalized_studies_count: Number(m.finalized_studies_count ?? 0),
    skipped_unfinalized_studies: Number(m.skipped_unfinalized_studies ?? 0),
    exported_series_count: Number(m.exported_series_count ?? 0),
    exported_segs_count: Number(m.exported_segs_count ?? 0),
    measurements_count: Number(m.measurements_count ?? 0),
    blocked_series: Array.isArray(m.blocked_series) ? m.blocked_series : [],
    exported_series: approved && Array.isArray(m.exported_series) ? m.exported_series : null,
    exported_segs: approved && Array.isArray(m.exported_segs) ? m.exported_segs : null,
    csv_content: approved && typeof m.csv_content === 'string' ? m.csv_content : null,
  }
}

type Subject = ReturnType<PatientService['cohortSnapshot']>['subjects'][number]

const LANDMARK_SPECS: Record<FollowupLandmark, { label: string; targetDays: number; minDays: number; maxDays: number }> = {
  m1: { label: '1个月随访', targetDays: 30, minDays: 14, maxDays: 45 },
  m3: { label: '3个月随访', targetDays: 90, minDays: 60, maxDays: 120 },
  m6: { label: '6个月随访', targetDays: 180, minDays: 135, maxDays: 225 },
  m12: { label: '12个月随访', targetDays: 365, minDays: 300, maxDays: 430 },
}

/** 宽表：每人一行；每个化验项目一组列（基线 = 窗口内第一次，最近 = 最后一次，随访节点与变化率，次数），统一用该项目最常见的标准单位，单位不同的值只进长表。 */
function wide(
  subjects: Subject[],
  relativeDays = false,
  customVars: CustomVarDef[] = [],
  opts?: { baselineWindow?: [number, number] | null; landmarks?: FollowupLandmark[]; includeChange?: boolean },
) {
  const landmarks = opts?.landmarks ?? []
  const includeChange = Boolean(opts?.includeChange)
  const baselineWindow = opts?.baselineWindow ?? null

  const byKey = new Map<string, { name: string; units: Map<string, number> }>()
  for (const s of subjects) for (const l of s.labs) {
    if (l.std_value === null) continue
    const k = byKey.get(l.test_key) ?? { name: l.test_name, units: new Map() }
    k.units.set(l.std_unit ?? '', (k.units.get(l.std_unit ?? '') ?? 0) + 1)
    byKey.set(l.test_key, k)
  }
  const tests = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => ({ key, name: v.name, unit: [...v.units.entries()].sort((a, b) => b[1] - a[1])[0]![0] || null }))
  const header = ['subject_id', 'sex', 'age_at_enroll', 'tags', 'enrolled_on']
  const labels: Record<string, string> = { subject_id: '研究编号', sex: '性别', age_at_enroll: '入组时年龄', tags: '诊断标签', enrolled_on: '入组日期' }
  for (const t of tests) {
    const u = unitSlug(t.unit), shown = t.unit ? `（${t.unit}）` : ''
    const cols: Array<[string, string]> = [
      [`${t.key}_baseline${u}`, `${t.name} 基线${shown}`],
      [`${t.key}_baseline_date`, `${t.name} 基线日期`],
    ]
    if (relativeDays) cols.push([`${t.key}_baseline_day_rel`, `${t.name} 基线相对入组天数`])
    for (const lm of landmarks) {
      const spec = LANDMARK_SPECS[lm]
      cols.push([`${t.key}_${lm}${u}`, `${t.name} ${spec.label}${shown}`])
    }
    cols.push(
      [`${t.key}_latest${u}`, `${t.name} 最近${shown}`],
      [`${t.key}_latest_date`, `${t.name} 最近日期`],
    )
    if (relativeDays) cols.push([`${t.key}_latest_day_rel`, `${t.name} 最近相对入组天数`])
    if (includeChange) {
      cols.push(
        [`${t.key}_delta${u}`, `${t.name} 较基线绝对变化${shown}`],
        [`${t.key}_change_pct`, `${t.name} 较基线变化率（%）`],
      )
    }
    cols.push([`${t.key}_n`, `${t.name} 次数`])

    for (const [col, lab] of cols) {
      header.push(col); labels[col] = lab
    }
  }

  const hasImaging = subjects.some(s => s.imaging && s.imaging.length > 0)
  if (hasImaging) {
    const imgCols: Array<[string, string]> = [
      ['longest_diameter_baseline_mm', 'RECIST 靶病灶长径基线 (mm)'],
      ['longest_diameter_latest_mm', 'RECIST 靶病灶长径最近 (mm)'],
      ['total_volume_baseline_cm3', '靶病灶三维体积基线 (cm³)'],
      ['total_volume_latest_cm3', '靶病灶三维体积最近 (cm³)'],
      ['vat_to_sat_ratio_baseline', '内脏与皮下脂肪比 VAT/SAT (基线)'],
      ['imaging_scans_n', '影像检查次数'],
    ]
    for (const [col, lab] of imgCols) {
      header.push(col); labels[col] = lab
    }
  }

  const hasSmi = subjects.some(s => s.vars?.l3_smi?.status === 'verified')
  if (hasSmi) {
    header.push('l3_smi_verified', 'l3_smi_source')
    labels.l3_smi_verified = 'L3 骨骼肌指数 SMI（已核实，cm²/m²）'
    labels.l3_smi_source = 'SMI 来源'
  }

  const noduleWideVars = [
    { id: 'nodule_type', col: 'nodule_type_verified', label: '主要肺结节密度类型（已核实）' },
    { id: 'nodule_mean_diameter_mm', col: 'nodule_mean_diameter_mm_verified', label: '主要肺结节平均径（已核实，mm）' },
    { id: 'nodule_volume_mm3', col: 'nodule_volume_mm3_verified', label: '主要肺结节三维体积（已核实，mm³）' },
    { id: 'nodule_solid_core_mm', col: 'nodule_solid_core_mm_verified', label: '部分实性结节实性成分平均径（已核实，mm）' },
    { id: 'nodule_vdt_days', col: 'nodule_vdt_days_verified', label: '肺结节体积倍增时间 VDT（已核实，d）' },
  ] as const
  const activeNoduleVars = noduleWideVars.filter(nv => subjects.some(s => s.vars?.[nv.id]?.status === 'verified'))
  if (activeNoduleVars.length > 0) {
    for (const nv of activeNoduleVars) {
      header.push(nv.col)
      labels[nv.col] = nv.label
    }
    header.push('nodule_vars_source')
    labels.nodule_vars_source = '肺结节变量来源（W5 定稿快照）'
  }

  const clinicalStudyVars = [
    { id: 'treatment_arm', col: 'treatment_arm', label: '治疗分组（已核实）' },
    { id: 'followup_months', col: 'followup_months', label: '总随访时间（已核实，月）' },
    { id: 'os_status', col: 'os_status', label: '全因死亡/主要终点事件（已核实，1/0）' },
    { id: 'pfs_months', col: 'pfs_months', label: '无进展生存期（已核实，月）' },
    { id: 'pfs_status', col: 'pfs_status', label: '进展/死亡事件（已核实，1/0）' },
    { id: 'vat_to_sat', col: 'vat_to_sat_verified', label: '内脏/皮下脂肪比 VAT/SAT（已核实）' },
  ] as const
  const activeClinicalVars = clinicalStudyVars.filter(cv => subjects.some(s => s.vars?.[cv.id]?.status === 'verified'))
  for (const cv of activeClinicalVars) {
    header.push(cv.col)
    labels[cv.col] = cv.label
  }

  const activeCustomVars = customVars.filter(cv => subjects.some(s => s.vars?.[cv.key]?.status === 'verified'))
  for (const cv of activeCustomVars) {
    header.push(cv.key)
    labels[cv.key] = cv.unit ? `${cv.label}（${cv.unit}）` : cv.label
  }

  const rows = subjects.map(s => {
    const r: unknown[] = [s.subject_id, s.sex, s.age_at_enroll, s.tags.join('; '), s.enrolled_on]
    for (const t of tests) {
      const vals = s.labs.filter((l: LabRow) => l.test_key === t.key && l.std_value !== null && (l.std_unit ?? null) === t.unit)
      let first = vals[0]
      if (baselineWindow && vals.length > 0 && s.enrolled_on) {
        const [minD, maxD] = baselineWindow
        const inWin = vals
          .map(v => ({ v, rel: daysDiff(v.collected_on, s.enrolled_on) }))
          .filter(x => x.rel !== null && x.rel >= minD && x.rel <= maxD)
          .sort((a, b) => Math.abs(a.rel!) - Math.abs(b.rel!))
        if (inWin.length > 0) first = inWin[0]!.v
      }
      const last = vals[vals.length - 1]
      r.push(first?.std_value ?? null, first?.collected_on ?? null)
      if (relativeDays) r.push(daysDiff(first?.collected_on, s.enrolled_on))

      for (const lm of landmarks) {
        const spec = LANDMARK_SPECS[lm]
        const hit = s.enrolled_on
          ? vals
              .map(v => ({ v, rel: daysDiff(v.collected_on, s.enrolled_on) }))
              .filter(x => x.rel !== null && x.rel >= spec.minDays && x.rel <= spec.maxDays)
              .sort((a, b) => Math.abs(a.rel! - spec.targetDays) - Math.abs(b.rel! - spec.targetDays))[0]?.v
          : undefined
        r.push(hit?.std_value ?? null)
      }

      r.push(last?.std_value ?? null, last?.collected_on ?? null)
      if (relativeDays) r.push(daysDiff(last?.collected_on, s.enrolled_on))
      if (includeChange) {
        const bVal = first?.std_value ?? null
        const lVal = last?.std_value ?? null
        const delta = bVal !== null && lVal !== null ? Number((lVal - bVal).toFixed(4)) : null
        const pct = bVal !== null && lVal !== null && Math.abs(bVal) > 1e-8 ? Number((((lVal - bVal) / Math.abs(bVal)) * 100).toFixed(2)) : null
        r.push(delta, pct)
      }
      r.push(vals.length)
    }

    if (hasImaging) {
      const scans = s.imaging || []
      const firstScan = scans[0]?.payload as any
      const lastScan = scans[scans.length - 1]?.payload as any
      const m1 = firstScan?.metrics || {}
      const m2 = lastScan?.metrics || {}
      const bc1 = m1.body_composition || {}

      r.push(
        m1.longest_diameter_mm ?? null,
        m2.longest_diameter_mm ?? null,
        m1.total_volume_cm3 ?? null,
        m2.total_volume_cm3 ?? null,
        bc1.vat_to_sat_ratio ?? null,
        scans.length
      )
    }

    // SMI：只取研究者已核实的研究变量值，并注明来源；平台不判定肌少症
    if (hasSmi) {
      const v = s.vars?.l3_smi
      const ok = v && v.status === 'verified'
      r.push(ok ? v.value : null, ok ? smiSource(v) : null)
    }

    // 肺结节研究变量（T2.8）：只取研究者已核实的值（源自 W5 定稿快照）
    if (activeNoduleVars.length > 0) {
      let firstVerified: SubjectVar | null = null
      for (const nv of activeNoduleVars) {
        const v = s.vars?.[nv.id]
        const ok = v && v.status === 'verified'
        if (ok && !firstVerified) firstVerified = v
        r.push(ok ? v.value : null)
      }
      r.push(firstVerified ? noduleVarSource(firstVerified) : null)
    }

    for (const cv of activeClinicalVars) {
      const v = s.vars?.[cv.id]
      const ok = v && v.status === 'verified'
      r.push(ok ? v.value : null)
    }

    for (const cv of activeCustomVars) {
      const v = s.vars?.[cv.key]
      const ok = v && v.status === 'verified'
      r.push(ok ? v.value : null)
    }

    return r
  })
  return { header, rows, labels }
}

/** SMI 来源说明：影像分析记录 id、日期与方法 */
function smiSource(v: SubjectVar): string {
  const ref = v.source_ref ?? {}
  const parts = [v.source === 'imaging_analysis' ? '影像分析记录' : v.source]
  if (ref.imaging_record_id) parts.push(String(ref.imaging_record_id))
  if (ref.report_date) parts.push(String(ref.report_date))
  if (v.method) parts.push(v.method)
  return `${parts.join(' · ')}（已核实）`
}

/** 肺结节定稿变量来源说明：定稿检查 id、定稿版本、病灶 id 与方法 */
function noduleVarSource(v: SubjectVar): string {
  const ref = v.source_ref ?? {}
  const parts = ['W5定稿快照']
  if (ref.imaging_study_id) parts.push(String(ref.imaging_study_id))
  if (ref.signoff_version) parts.push(`v${ref.signoff_version}`)
  if (ref.lesion_id) parts.push(String(ref.lesion_id))
  if (ref.study_date) parts.push(String(ref.study_date))
  return `${parts.join(' · ')}（已核实）`
}

/** 长表：每次化验一行（标准单位；没法换算的保留原单位并标出）。 */
function long(subjects: Subject[], relativeDays = false) {
  const header = ['subject_id', 'test_key', 'test_name', 'value', 'unit', 'value_text', 'flag', 'collected_on', ...(relativeDays ? ['day_rel'] : []), 'collected_at', 'unit_converted', 'unknown_unit']
  const labels: Record<string, string> = {
    subject_id: '研究编号', test_key: '项目键', test_name: '项目', value: '数值（标准单位）', unit: '单位',
    value_text: '文字结果', flag: '异常标记', collected_on: '采样日期',
    ...(relativeDays ? { day_rel: '相对入组天数' } : {}),
    collected_at: '采样时间', unit_converted: '单位已换算', unknown_unit: '单位未识别',
  }
  const rows = subjects.flatMap(s => s.labs.map(l => [
    s.subject_id, l.test_key, l.test_name, l.std_value, l.std_unit, l.value_text, l.flag, l.collected_on,
    ...(relativeDays ? [daysDiff(l.collected_on, s.enrolled_on)] : []),
    l.collected_at, l.converted ? 1 : 0, l.unknown_unit ? 1 : 0,
  ]))
  return { header, rows, labels }
}
