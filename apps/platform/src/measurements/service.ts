import { ImagingStudyService, type LesionRow } from '../imaging/studies.ts'
import { sharedFollowup } from '../imaging/followup.ts'
import {
  COHORT_FIELDS, FOLLOWUP_FIELDS, LESION_FIELDS, MEASURE_UNITS, RESULT_FIELDS, convertMeasure, fieldsOf, formatMeasure, isMeasureUnit, snapshotText, statusNote, unitsFor,
  type MeasureField, type MeasureStatus, type MeasureView,
} from '../model/measurements.ts'
import type { DocRow, MeasurementRow, Store } from '../store/db.ts'
import type { Actor, PatientService } from '../tenancy/patients.ts'

/**
 * 测量原子 [@m:id] 的登记与取值（PRD W4.2；docs/PLATFORM.md「测量原子」）。
 *
 * - 绑定（insert_measurement / POST /api/docs/:id/measurements）：以操作者本人的权限读来源，只接受已确认的病灶；
 *   登记表在文档库（与引用同库、随文档删除），记下来源、字段、显示单位与绑定时的快照。
 * - 取值（渲染、导出、编辑器、AI 读视图）：以读者本人的权限读来源的当前值 —— 医生重测后报告里的数字随之更新，
 *   文档内容本身不变（不产生修订，按轮撤销不受影响）。读者看不到来源时只给快照，不透露来源的当前情况。
 *
 * 来源类型可扩展（SOURCES）：影像病灶测量（imaging_lesion）；随访对比的派生值（imaging_followup：两期之差、体积倍增时间，
 * T2.6 所见草稿用）；以后科研手稿里的队列统计值（W6.5）再加一种来源即可。
 */

export class MeasurementError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 422 = 400, readonly hint?: string) { super(message) }
}

/** 来源在某位读者眼里的样子。 */
interface SourceReading {
  /** valid = 可以引用；其余为来源失效的原因。 */
  state: 'valid' | 'rejected' | 'withdrawn' | 'unconfirmed'
  version: number
  values: Record<string, unknown>
  /** 来源的简短说明（不含患者标识）。 */
  label: string
  patientId: string | null
  tenantId: string | null
}

interface MeasureSource {
  fields: Record<string, MeasureField>
  /** 以 actor 的权限读来源；没有权限或不存在时抛错（调用方按「无权查看」处理）。 */
  read(actor: Actor, sourceId: string): SourceReading
}

/**
 * 能被绑定的病灶：已确认（医生补充的病灶直接就是已确认）。
 * T2.7「审核与定稿」合并后若改为只允许绑定已定稿的病灶，只改这里（以及 stateOf 里对应的显示状态）。
 */
export function lesionBindable(l: LesionRow): boolean {
  return l.status === 'confirmed'
}

function stateOf(l: LesionRow): SourceReading['state'] {
  if (lesionBindable(l)) return 'valid'
  if (l.status === 'rejected') return 'rejected'
  if (l.status === 'superseded') return 'withdrawn'
  return 'unconfirmed'
}

const lesionLabel = (l: LesionRow) => [`病灶 ${l.label ?? l.id}`, l.location].filter(Boolean).join(' · ')

function imagingLesionSource(patients: PatientService): MeasureSource {
  const svc = new ImagingStudyService(patients, null)
  return {
    fields: LESION_FIELDS,
    read(actor, lesionId) {
      const { lesion, patientId, tenantId } = svc.measurementSource(actor, lesionId)
      return { state: stateOf(lesion), version: lesion.version, values: lesion.metrics, label: lesionLabel(lesion), patientId, tenantId }
    },
  }
}

/**
 * 随访对比的派生测量（source_id = 本次检查的病灶 id）：取该病灶在随访对比里的当前一项（sharedFollowup().view，
 * 变化按两侧病灶的当前测量重新计算），字段见 FOLLOWUP_FIELDS。
 * - 状态跟随本次病灶：被否决 / 撤销 / 不再确认时与病灶测量一样标出；
 * - 病灶还在但已不成对（拆开、前片结节不再参与、重新匹配后没对上）或缺少这个值（缺体积、VDT 不适用）时为 field_missing（「来源测量已缺失」）。
 * 版本取本次病灶的版本：前片定稿版本变了、对应关系变了而病灶未改时，数值变化仍按「已随来源更新」显示（比较的是文字）。
 */
function imagingFollowupSource(patients: PatientService): MeasureSource {
  const svc = new ImagingStudyService(patients, null)
  return {
    fields: FOLLOWUP_FIELDS,
    read(actor, lesionId) {
      const { lesion, patientId, tenantId } = svc.measurementSource(actor, lesionId)
      let values: Record<string, unknown> = {}
      if (lesionBindable(lesion)) {
        const item = sharedFollowup(patients).view(actor, lesion.study_id).items.find(i => i.lesion_id === lesionId)
        if (item?.metrics && item.prior_lesion_id && item.change && item.change !== 'new') values = { ...item.metrics }
      }
      return { state: stateOf(lesion), version: lesion.version, values, label: `${lesionLabel(lesion)} · 随访对比`, patientId, tenantId }
    },
  }
}

function calcMedian(nums: number[]): number | undefined {
  if (!nums.length) return undefined
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function calcMean(nums: number[]): number | undefined {
  if (!nums.length) return undefined
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

/**
 * 科研手稿里的队列统计值（PRD W6.5 / T3.9，source_id = 研究 study_id）：
 * 只汇总该研究入组受试者已定稿（W5 Finalized）检查里的已确认结节；未定稿检查一律排除。
 * 当新受试者入组或新的检查完成 W5 定稿后，手稿里的 [@m:id] 渲染/导出时自动同步为最新队列统计值（status = 'updated'）。
 */
function cohortStatSource(store: Store, patients: PatientService): MeasureSource {
  return {
    fields: COHORT_FIELDS,
    read(actor, studyId) {
      const study = store.getStudy(studyId)
      const role = study ? store.studyRole(studyId, actor.userId) : null
      if (!study || !role) {
        throw new MeasurementError('not_found', '研究不存在或无权查看', 404)
      }
      const { subjects } = patients.cohortFinalizedImaging(actor, studyId)
      const withFinalized = subjects.filter(s => s.finalized_studies.length > 0)
      const finalizedStudies = subjects.flatMap(s => s.finalized_studies)
      if (finalizedStudies.length === 0) {
        return {
          state: 'unconfirmed',
          version: 0,
          values: {},
          label: `队列 ${study.title}`,
          patientId: null,
          tenantId: study.tenant_id ?? null,
        }
      }
      const lesions = finalizedStudies.flatMap(st => st.lesions)
      const diameters = lesions
        .map(l => Number(l.metrics?.mean_diameter_mm))
        .filter(n => Number.isFinite(n) && n > 0)
      const volumes = lesions
        .map(l => Number(l.metrics?.volume_mm3))
        .filter(n => Number.isFinite(n) && n > 0)
      const vdts = lesions
        .map(l => Number(l.metrics?.vdt_days))
        .filter(n => Number.isFinite(n) && n > 0)
      const typed = lesions.filter(l => ['solid', 'part_solid', 'pure_ggo'].includes(String(l.metrics?.nodule_type ?? '')))
      const solidCount = typed.filter(l => l.metrics?.nodule_type === 'solid').length
      const subsolidCount = typed.filter(l => l.metrics?.nodule_type === 'part_solid' || l.metrics?.nodule_type === 'pure_ggo').length

      const values: Record<string, unknown> = {
        subjects_n: withFinalized.length,
        finalized_studies_n: finalizedStudies.length,
        confirmed_nodules_n: lesions.length,
        mean_diameter_mm: calcMean(diameters),
        median_diameter_mm: calcMedian(diameters),
        mean_volume_mm3: calcMean(volumes),
        median_volume_mm3: calcMedian(volumes),
        median_vdt_days: calcMedian(vdts),
        solid_pct: typed.length > 0 ? (solidCount / typed.length) * 100 : undefined,
        subsolid_pct: typed.length > 0 ? (subsolidCount / typed.length) * 100 : undefined,
      }
      const version = finalizedStudies.reduce(
        (acc, st) => acc + st.version * 100 + st.lesions.length,
        withFinalized.length * 1000,
      )
      return {
        state: 'valid',
        version,
        values,
        label: `队列 ${study.title}`,
        patientId: null,
        tenantId: study.tenant_id ?? null,
      }
    },
  }
}

/**
 * 分析结果来源（docs/design/PROVENANCE.md 4.5）：读者是登记者本人，或结果所在研究的成员才能看到当前值；
 * 其余读者只看绑定时的快照。不涉及患者数据，不需要患者模块。
 */
function analysisResultSource(store: Store): MeasureSource {
  return {
    fields: RESULT_FIELDS,
    read(actor, resultId) {
      const r = store.getAnalysisResult(resultId)
      const allowed = r && (r.owner === actor.userId || (r.study_id && store.studyRole(r.study_id, actor.userId)))
      if (!r || !allowed) throw new MeasurementError('not_found', '分析结果不存在或无权查看', 404)
      return { state: 'valid', version: r.version, values: r.values, label: `分析 ${r.name}${r.method ? `（${r.method}）` : ''}`, patientId: null, tenantId: null }
    },
  }
}

export const SOURCE_KINDS = ['imaging_lesion', 'imaging_followup', 'cohort_stat', 'analysis_result'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export interface BindInput {
  source?: SourceKind
  /** 来源 id（影像病灶 id，imaging_lesions 返回的 id）。 */
  source_id: string
  field: string
  /** 显示单位，缺省为字段的基准单位（mm / mm3 / HU / ratio）。 */
  unit?: string
  /** 小数位，缺省按单位（mm 1 位、cm 2 位、mm³ 0 位、cm³ 2 位、HU 0 位）。 */
  decimals?: number
}

/** 文档归属（patients.linkDoc 或 studies.link 写的 context）。 */
function docContext(doc: DocRow): { kind?: string; patient_id?: string; study_id?: string; tenant_id?: string; space?: string } | null {
  try { return doc.context ? JSON.parse(doc.context) : null } catch { return null }
}

/** 读者在这份文档上读患者库用哪个空间（文档归属的空间，缺省工作台）。 */
export function measureSpace(doc: DocRow): 'work' | 'personal' {
  return docContext(doc)?.space === 'personal' ? 'personal' : 'work'
}

export class MeasurementService {
  constructor(private readonly store: Store, private readonly patients: PatientService | null | undefined) {}

  private source(kind: string): MeasureSource {
    if (kind !== 'imaging_lesion' && kind !== 'imaging_followup' && kind !== 'cohort_stat' && kind !== 'analysis_result') {
      throw new MeasurementError('measurement_source_unknown', `不支持的测量来源 ${kind}`, 400, `可绑定的来源：影像病灶测量（imaging_lesion）、随访对比的派生值（imaging_followup）、科研队列统计值（cohort_stat）、分析结果（analysis_result）。`)
    }
    if (kind === 'analysis_result') return analysisResultSource(this.store)
    if (!this.patients) throw new MeasurementError('patient_module_off', '患者模块未启用，不能绑定影像测量', 403)
    if (kind === 'cohort_stat') return cohortStatSource(this.store, this.patients)
    return kind === 'imaging_followup' ? imagingFollowupSource(this.patients) : imagingLesionSource(this.patients)
  }

  /** 严格模式：显式设置的为准；未设置时文档里有测量登记就开启（报告一旦绑定了测量，其余测量数字也要绑定）。 */
  strict(docId: string): boolean {
    return this.store.measurementStrict(docId) ?? this.store.listMeasurements(docId).length > 0
  }

  /**
   * 绑定一个测量（AI 与医生同一入口；权限 = 操作者本人对来源的读权限）。
   * 规则：来源须已确认；字段须有数值；同一文档只引用同一位患者（文档关联了患者时须是该患者）。
   */
  bind(actor: Actor, doc: DocRow, input: BindInput): { row: MeasurementRow; view: MeasureView } {
    const kind = input.source ?? 'imaging_lesion'
    const src = this.source(kind)
    const field = src.fields[input.field]
    if (!field) {
      throw new MeasurementError('measurement_field_unknown', `来源没有测量字段 ${input.field}`, 400, `可绑定的字段：${Object.entries(src.fields).map(([k, f]) => `${k}（${f.label}）`).join('、')}`)
    }
    const unit = input.unit ?? field.base
    if (!isMeasureUnit(unit) || !unitsFor(field.base).includes(unit)) {
      throw new MeasurementError('measurement_unit_invalid', `字段 ${input.field} 不能用单位 ${unit}`, 400, `可用单位：${unitsFor(field.base).join('、')}`)
    }
    const decimals = input.decimals ?? MEASURE_UNITS[unit].decimals
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) throw new MeasurementError('measurement_decimals_invalid', '小数位须为 0–4 的整数')

    const r = src.read(actor, input.source_id)
    if (r.state !== 'valid') {
      if (kind === 'cohort_stat') {
        throw new MeasurementError('cohort_no_finalized_imaging', '该研究队列尚无已定稿（W5 Finalized）的影像检查，不能绑定队列统计值', 409, '请审核医师先在影像审核视图完成检查定稿后再绑定队列统计值。')
      }
      const why = { rejected: '已被否决', withdrawn: '已撤销或被新的分析取代', unconfirmed: '还没有经医生确认' }[r.state]
      throw new MeasurementError('lesion_not_confirmed', `病灶${why}，不能绑定它的测量`, 409, '只能绑定医生已确认的病灶（imaging_lesions 里 status = confirmed）；待确认的请让医生先在阅片器里确认。')
    }
    const raw = r.values[input.field]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new MeasurementError('measurement_field_missing', kind === 'imaging_followup' ? `这个结节的随访对比没有${field.label}（${input.field}）` : kind === 'cohort_stat' ? `该研究队列暂无 ${field.label}（${input.field}）的统计值` : `病灶没有 ${field.label}（${input.field}）的测量值`, 422,
        kind === 'imaging_followup' ? '只有与前片成对、两期都有相应测量的结节才有差值；体积倍增时间只在体积增大时给出。用 imaging_followup 查看。' : '换一个有数值的字段，或请医生补测后再绑定。')
    }
    const ctx = docContext(doc)
    if (kind === 'analysis_result') {
      // 分析结果不涉及患者：不做患者一致性检查
    } else if (kind === 'cohort_stat') {
      if (ctx?.kind === 'patient') {
        throw new MeasurementError('measurement_study_mismatch', '这份文档属于单患者病例报告，不能绑定科研队列统计值', 409)
      }
      if (ctx?.kind === 'study' && ctx.study_id && ctx.study_id !== input.source_id) {
        throw new MeasurementError('measurement_study_mismatch', '这份文档归属于另一项临床研究，不能绑定本研究的队列统计值', 409)
      }
    } else {
      if (ctx?.kind === 'patient' && (ctx.patient_id !== r.patientId || (ctx.tenant_id && r.tenantId && ctx.tenant_id !== r.tenantId))) {
        throw new MeasurementError('measurement_patient_mismatch', '这份文档关联的是另一位患者，不能绑定这位患者的病灶测量', 409, '只能绑定文档所关联患者的病灶；确认患者与检查后再绑定。')
      }
      const other = this.store.listMeasurements(doc.id).find(m => m.source_kind === kind && m.patient_id && m.patient_id !== r.patientId)
      if (other) {
        throw new MeasurementError('measurement_patient_mismatch', '这份文档里已经绑定了另一位患者的测量，不能混入其他患者的病灶测量', 409, '一份报告只引用一位患者的测量；另一位患者的内容请写在单独的文档里。')
      }
    }
    const value = convertMeasure(raw, field.base, unit)
    const row = this.store.upsertMeasurement({
      doc_id: doc.id, source_kind: kind, source_id: input.source_id, field: input.field, unit, decimals,
      tenant_id: r.tenantId, patient_id: r.patientId, bound_version: r.version, bound_value: value,
      bound_label: `${r.label} · ${field.label}`, bound_by: actor.userId,
    })
    return { row, view: this.view(row, r) }
  }

  /**
   * 文档里各测量在读者眼里的值与状态。viewer = null（公开分享、无法确定读者）时一律只给快照。
   * 读来源出错（无权限、来源不存在、患者模块未开、AI 不能读患者数据……）一律按「无权查看」处理，不透露原因。
   */
  views(doc: DocRow, viewer: Actor | null): Map<string, MeasureView> {
    const rows = this.store.listMeasurements(doc.id)
    const out = new Map<string, MeasureView>()
    const cache = new Map<string, SourceReading | null>()
    for (const row of rows) {
      let reading: SourceReading | null = null
      if (viewer && (this.patients || row.source_kind === 'analysis_result')) {
        const key = `${row.source_kind}:${row.source_id}`
        if (!cache.has(key)) {
          try { cache.set(key, this.source(row.source_kind).read(viewer, row.source_id)) } catch { cache.set(key, null) }
        }
        reading = cache.get(key) ?? null
        // 来源换了主（理论上不会发生）：当作看不到
        if (reading && (reading.patientId !== row.patient_id || (row.tenant_id && reading.tenantId !== row.tenant_id))) reading = null
      }
      out.set(row.id, this.view(row, reading))
    }
    return out
  }

  private view(row: MeasurementRow, reading: SourceReading | null): MeasureView {
    const bound = snapshotText(row)
    const field = fieldsOf(row.source_kind)[row.field]
    const base: MeasureView = {
      id: row.id, text: bound, status: 'no_access', bound_text: bound, source_label: row.bound_label,
      source_version: null, bound_version: row.bound_version, note: statusNote('no_access', bound),
    }
    if (!reading || !field || !isMeasureUnit(row.unit)) return base
    let status: MeasureStatus
    let text = bound
    if (reading.state !== 'valid') status = reading.state
    else {
      const raw = reading.values[row.field]
      if (typeof raw !== 'number' || !Number.isFinite(raw)) status = 'field_missing'
      else {
        text = formatMeasure(convertMeasure(raw, field.base, row.unit), row.unit, row.decimals, field.signed)
        status = text === bound ? 'ok' : 'updated'
      }
    }
    const note = status === 'updated'
      ? `已随来源更新（来源 v${row.bound_version} → v${reading.version}，绑定时为 ${bound}）`
      : statusNote(status, bound)
    return { ...base, text, status, source_label: `${reading.label} · ${field.label}`, source_version: reading.version, note }
  }
}
