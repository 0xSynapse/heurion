import { ImagingStudyService, type LesionRow } from '../imaging/studies.ts'
import {
  LESION_FIELDS, MEASURE_UNITS, convertMeasure, formatMeasure, isMeasureUnit, snapshotText, statusNote, unitsFor,
  type MeasureStatus, type MeasureUnit, type MeasureView,
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
 * 来源类型可扩展（SOURCES）：本期只有影像病灶测量；以后科研手稿里的队列统计值（W6.5）加一种来源即可。
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
  fields: Record<string, { label: string; base: MeasureUnit }>
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

export const SOURCE_KINDS = ['imaging_lesion'] as const
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

/** 文档归属（patients.linkDoc 写的 context）。 */
function docContext(doc: DocRow): { kind?: string; patient_id?: string; tenant_id?: string; space?: string } | null {
  try { return doc.context ? JSON.parse(doc.context) : null } catch { return null }
}

/** 读者在这份文档上读患者库用哪个空间（文档归属的空间，缺省工作台）。 */
export function measureSpace(doc: DocRow): 'work' | 'personal' {
  return docContext(doc)?.space === 'personal' ? 'personal' : 'work'
}

export class MeasurementService {
  constructor(private readonly store: Store, private readonly patients: PatientService | null | undefined) {}

  private source(kind: string): MeasureSource {
    if (kind !== 'imaging_lesion') throw new MeasurementError('measurement_source_unknown', `不支持的测量来源 ${kind}`, 400, `目前只能绑定影像病灶测量（source = imaging_lesion）。`)
    if (!this.patients) throw new MeasurementError('patient_module_off', '患者模块未启用，不能绑定影像测量', 403)
    return imagingLesionSource(this.patients)
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
      const why = { rejected: '已被否决', withdrawn: '已撤销或被新的分析取代', unconfirmed: '还没有经医生确认' }[r.state]
      throw new MeasurementError('lesion_not_confirmed', `病灶${why}，不能绑定它的测量`, 409, '只能绑定医生已确认的病灶（imaging_lesions 里 status = confirmed）；待确认的请让医生先在阅片器里确认。')
    }
    const raw = r.values[input.field]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new MeasurementError('measurement_field_missing', `病灶没有 ${field.label}（${input.field}）的测量值`, 422, '换一个有数值的字段，或请医生补测后再绑定。')
    }
    const ctx = docContext(doc)
    if (ctx?.kind === 'patient' && (ctx.patient_id !== r.patientId || (ctx.tenant_id && r.tenantId && ctx.tenant_id !== r.tenantId))) {
      throw new MeasurementError('measurement_patient_mismatch', '这份文档关联的是另一位患者，不能绑定这位患者的病灶测量', 409, '只能绑定文档所关联患者的病灶；确认患者与检查后再绑定。')
    }
    const other = this.store.listMeasurements(doc.id).find(m => m.source_kind === kind && m.patient_id && m.patient_id !== r.patientId)
    if (other) {
      throw new MeasurementError('measurement_patient_mismatch', '这份文档里已经绑定了另一位患者的测量，不能混入其他患者的病灶测量', 409, '一份报告只引用一位患者的测量；另一位患者的内容请写在单独的文档里。')
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
      if (viewer && this.patients) {
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
    const field = row.source_kind === 'imaging_lesion' ? LESION_FIELDS[row.field] : undefined
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
        text = formatMeasure(convertMeasure(raw, field.base, row.unit), row.unit, row.decimals)
        status = text === bound ? 'ok' : 'updated'
      }
    }
    const note = status === 'updated'
      ? `已随来源更新（来源 v${row.bound_version} → v${reading.version}，绑定时为 ${bound}）`
      : statusNote(status, bound)
    return { ...base, text, status, source_label: `${reading.label} · ${field.label}`, source_version: reading.version, note }
  }
}
