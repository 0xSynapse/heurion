import type { DatasetService, DatasetView } from '../datasets/service.ts'
import type { Actor, LabRow, PatientService, SubjectVar } from '../tenancy/patients.ts'
import { StudyError, type StudyService } from './service.ts'

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
export interface CohortOrigin {
  kind: 'cohort'; study_id: string; shape: Shape; tests: string[] | null; from: string | null; to: string | null; relative_days?: boolean
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
    this.studies.get(a.userId, studyId, 'write')
    return this.patients.screen(a, studyId, criteria)
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

  /** 入组名单、待确认的入组提议、研究数据集（最新版本是否过期）。 */
  list(a: Actor, studyId: string) {
    this.studies.get(a.userId, studyId)
    const { subjects, pending } = this.patients.enrollments(a, studyId)
    return { active: subjects.filter(s => s.status === 'active').length, subjects, pending, datasets: this.cohortDatasets(a, studyId) }
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
   */
  async dataset(a: Actor, studyId: string, input: { shape?: unknown; tests?: unknown; from?: unknown; to?: unknown; relative_days?: unknown }): Promise<{ dataset: DatasetView; unchanged: boolean; skipped: string[] }> {
    const study = this.studies.get(a.userId, studyId, 'write')
    if (!this.datasets) throw new StudyError('unavailable', '数据集未启用')
    const shape: Shape = input.shape === 'long' ? 'long' : 'wide'
    const relativeDays = Boolean(input.relative_days)
    const tests = Array.isArray(input.tests) ? input.tests.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, 50) : []
    const from = date(input.from), to = date(input.to)
    const snap = this.patients.cohortSnapshot(a, studyId, { tests, from, to, log: true })
    if (!snap.subjects.length) throw new StudyError('empty_cohort', snap.skipped.length ? '入组的患者你都不在诊疗组里了，不能生成数据集' : '还没有入组的患者')
    const { header, rows, labels } = shape === 'wide' ? wide(snap.subjects, relativeDays) : long(snap.subjects, relativeDays)
    const prev = this.cohortDatasets(a, studyId).filter(d => d.shape === shape)
    const version = (prev[0]?.version ?? 0) + 1
    const origin: CohortOrigin = {
      kind: 'cohort', study_id: studyId, shape, tests: tests.length ? tests : null, from, to, relative_days: relativeDays ? true : undefined, generated_at: new Date().toISOString(),
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

    // B1 修复：绝不使用写死的演示 sample_id（chest_lung_ct）或编造的 1.72m/68kg 人口学数据
    const cases = pids.map(pid => {
      const subj = active.find(s => s.patient_id === pid)
      let filePath: string | undefined = undefined
      let sampleId: string | undefined = undefined

      try {
        const pData = this.patients.read(a, pid)
        const imgRecord = pData.records?.find(r => r.kind === 'imaging' && r.file_id && /^[A-Za-z0-9_-]+$/.test(r.file_id))
        if (imgRecord?.file_id) {
          filePath = `/app/data/platform/files/${imgRecord.file_id}`
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
      try {
        this.studies.link(a.userId, studyId, { kind: 'dataset', ref_id: dataset.id })
      } catch (err) {
        if (!(err instanceof StudyError && err.code === 'in_other_study')) throw err
      }
      datasetView = this.datasets.get(a.userId, dataset.id)
    }

    return {
      ...res,
      study_id: studyId,
      dataset: datasetView,
    }
  }
}

type Subject = ReturnType<PatientService['cohortSnapshot']>['subjects'][number]

/** 宽表：每人一行；每个化验项目一组列（基线 = 窗口内第一次，最近 = 最后一次，次数），统一用该项目最常见的标准单位，单位不同的值只进长表。 */
function wide(subjects: Subject[], relativeDays = false) {
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
    cols.push(
      [`${t.key}_latest${u}`, `${t.name} 最近${shown}`],
      [`${t.key}_latest_date`, `${t.name} 最近日期`],
    )
    if (relativeDays) cols.push([`${t.key}_latest_day_rel`, `${t.name} 最近相对入组天数`])
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

  const rows = subjects.map(s => {
    const r: unknown[] = [s.subject_id, s.sex, s.age_at_enroll, s.tags.join('; '), s.enrolled_on]
    for (const t of tests) {
      const vals = s.labs.filter((l: LabRow) => l.test_key === t.key && l.std_value !== null && (l.std_unit ?? null) === t.unit)
      const first = vals[0], last = vals[vals.length - 1]
      r.push(first?.std_value ?? null, first?.collected_on ?? null)
      if (relativeDays) r.push(daysDiff(first?.collected_on, s.enrolled_on))
      r.push(last?.std_value ?? null, last?.collected_on ?? null)
      if (relativeDays) r.push(daysDiff(last?.collected_on, s.enrolled_on))
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
