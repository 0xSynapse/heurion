/**
 * 研究变量（分组、随访、结局、PFS、影像变量）的录入 / 导入 / 核实。
 *
 * - 每个值都带来源（dataset_import / ecrf_manual / imaging_analysis）与来源引用，以及核实状态；
 * - 任何写入（含 AI）都是 unverified，只有研究者本人可以核实；
 * - 影像变量只取影像分析记录里的实测值，并记录算法方法；影像记录没有身高时不采用 SMI；
 * - 缺失就是缺失：空单元格不写、不覆盖已有值，也不补值。
 * 值本身存在机构患者库（tenancy/patients.ts 的 subject_vars 表），与入组关系同库。
 */

import { readFileSync } from 'node:fs'
import { parseCsv, type DatasetService } from '../datasets/service.ts'
import { sharedFollowup } from '../imaging/followup.ts'
import { ImagingReviewService } from '../imaging/review.ts'
import { ImagingStudyService } from '../imaging/studies.ts'
import type { Actor, PatientService, SubjectVar, SubjectVarInput, SubjectVarSource } from '../tenancy/patients.ts'
import { StudyError, type StudyService } from './service.ts'

export interface StudyVarDef {
  id: string
  label: string
  /** number：数值；event：0/1 事件；text：分类文字 */
  type: 'number' | 'event' | 'text'
  unit?: string
  /** 允许的来源；影像变量只允许 imaging_analysis */
  sources: SubjectVarSource[]
}

export const STUDY_VARS: StudyVarDef[] = [
  { id: 'treatment_arm', label: '治疗分组', type: 'text', sources: ['dataset_import', 'ecrf_manual'] },
  { id: 'followup_months', label: '总随访时间', type: 'number', unit: '月', sources: ['dataset_import', 'ecrf_manual'] },
  { id: 'os_status', label: '全因死亡 / 终点事件 (1=发生, 0=删失)', type: 'event', sources: ['dataset_import', 'ecrf_manual'] },
  { id: 'pfs_months', label: '无进展生存期', type: 'number', unit: '月', sources: ['dataset_import', 'ecrf_manual'] },
  { id: 'pfs_status', label: '进展 / 死亡事件 (1=发生, 0=删失)', type: 'event', sources: ['dataset_import', 'ecrf_manual'] },
  { id: 'l3_smi', label: 'L3 骨骼肌指数 SMI', type: 'number', unit: 'cm²/m²', sources: ['imaging_analysis'] },
  { id: 'vat_to_sat', label: '内脏 / 皮下脂肪比 VAT/SAT', type: 'number', sources: ['imaging_analysis'] },
  { id: 'nodule_type', label: '主病灶结节密度类型', type: 'text', sources: ['imaging_analysis'] },
  { id: 'nodule_mean_diameter_mm', label: '主病灶结节平均径', type: 'number', unit: 'mm', sources: ['imaging_analysis'] },
  { id: 'nodule_volume_mm3', label: '主病灶结节体积', type: 'number', unit: 'mm³', sources: ['imaging_analysis'] },
  { id: 'nodule_solid_core_mm', label: '主病灶实性成分直径', type: 'number', unit: 'mm', sources: ['imaging_analysis'] },
  { id: 'nodule_vdt_days', label: '主病灶体积倍增时间 VDT', type: 'number', unit: '天', sources: ['imaging_analysis'] },
]

const NODULE_VARS = new Set(['nodule_type', 'nodule_mean_diameter_mm', 'nodule_volume_mm3', 'nodule_solid_core_mm', 'nodule_vdt_days'])
const NODULE_TYPE_LABELS: Record<string, string> = { solid: '实性', part_solid: '部分实性', pure_ggo: '磨玻璃', 实性: '实性', 部分实性: '部分实性', 磨玻璃: '磨玻璃' }

const DEF = new Map(STUDY_VARS.map(v => [v.id, v]))

export const SOURCE_LABELS: Record<SubjectVarSource, string> = {
  dataset_import: '数据集导入',
  ecrf_manual: 'eCRF 手工录入',
  imaging_analysis: '影像分析记录',
}

/** 把原始值按变量类型解析；解析不了返回 { error } */
export function parseVarValue(def: StudyVarDef, raw: unknown): { value: number | string } | { error: string } {
  const s = String(raw ?? '').trim()
  if (!s) return { error: '空值' }
  if (def.type === 'text') return s.length > 100 ? { error: '超过 100 字' } : { value: s }
  const n = Number(s)
  if (!Number.isFinite(n)) return { error: `不是数字：${s.slice(0, 20)}` }
  if (def.type === 'event') return n === 0 || n === 1 ? { value: n } : { error: `事件只能是 0 或 1：${s}` }
  if (/months$/.test(def.id) && n < 0) return { error: '时间不能为负' }
  return { value: n }
}

function requireDef(varId: string, source: SubjectVarSource): StudyVarDef {
  const def = DEF.get(varId)
  if (!def) throw new StudyError('bad_var', `未知的研究变量：${varId}`)
  if (!def.sources.includes(source)) {
    throw new StudyError('bad_source', def.sources.includes('imaging_analysis')
      ? `${def.label} 只能从影像分析记录导入实测值`
      : `${def.label} 不能来自${SOURCE_LABELS[source]}`)
  }
  return def
}

const finite = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export class SubjectVarService {
  constructor(
    private readonly studies: StudyService,
    private readonly patients: PatientService,
    private readonly datasets: DatasetService | null,
  ) {}

  /** 变量字典、每个受试者的变量值与汇总（每个变量的已录入 / 已核实 / 缺失数） */
  list(a: Actor, studyId: string) {
    this.studies.get(a.userId, studyId, 'read')
    const snap = this.patients.cohortSnapshot(a, studyId)
    const values: SubjectVar[] = snap.subjects.flatMap(s => Object.values(s.vars))
    const summary = STUDY_VARS.map(v => {
      const vs = values.filter(x => x.var_id === v.id)
      return { var_id: v.id, label: v.label, entered: vs.length, verified: vs.filter(x => x.status === 'verified').length, missing: snap.subjects.length - vs.length }
    })
    return { variables: STUDY_VARS, sources: SOURCE_LABELS, subjects: snap.subjects.map(s => s.subject_id), values, summary }
  }

  /** eCRF 手工录入；value 为 null 表示清除。AI 经此写入同样是 unverified。 */
  manual(a: Actor, studyId: string, entries: Array<{ subject_id: string; var_id: string; value: unknown }>) {
    this.studies.get(a.userId, studyId, 'write')
    const rows: SubjectVarInput[] = []
    const invalid: Array<{ subject_id: string; var_id: string; reason: string }> = []
    for (const e of entries) {
      const def = requireDef(e.var_id, 'ecrf_manual')
      if (e.value === null) { rows.push({ subject_id: e.subject_id, var_id: e.var_id, value: null, source: 'ecrf_manual' }); continue }
      const p = parseVarValue(def, e.value)
      if ('error' in p) { invalid.push({ subject_id: e.subject_id, var_id: e.var_id, reason: p.error }); continue }
      rows.push({ subject_id: e.subject_id, var_id: e.var_id, value: p.value, source: 'ecrf_manual', source_ref: { entered_via: a.via } })
    }
    const res = this.patients.setSubjectVars(a, studyId, rows)
    return { ...res, skipped: [...invalid, ...res.skipped] }
  }

  /**
   * 从已有数据集按列映射导入：subject_col 是研究编号列，mapping 是 变量 id → 列名。
   * 空单元格跳过（不写、不覆盖），解析不了的记入 skipped。
   */
  importDataset(a: Actor, studyId: string, input: { dataset_id: string; subject_col: string; mapping: Record<string, string> }) {
    this.studies.get(a.userId, studyId, 'write')
    if (!this.datasets) throw new StudyError('unavailable', '数据集服务未启用')
    const entries = Object.entries(input.mapping ?? {}).filter(([, col]) => typeof col === 'string' && col)
    if (!entries.length) throw new StudyError('bad_mapping', '请至少映射一个变量到数据集的列')
    const defs = entries.map(([varId, col]) => ({ def: requireDef(varId, 'dataset_import'), col }))

    const { dataset, path } = this.datasets.readyCsv(a.userId, input.dataset_id)
    const records = parseCsv(readFileSync(path, 'utf8'))
    const header = records[0] ?? []
    const idx = (col: string) => header.indexOf(col)
    const subjIdx = idx(input.subject_col)
    if (subjIdx < 0) throw new StudyError('bad_mapping', `数据集中没有列「${input.subject_col}」`)
    for (const d of defs) if (idx(d.col) < 0) throw new StudyError('bad_mapping', `数据集中没有列「${d.col}」`)

    const rows: SubjectVarInput[] = []
    const skipped: Array<{ subject_id: string; var_id: string; reason: string }> = []
    let empty = 0
    for (const rec of records.slice(1)) {
      const sid = String(rec[subjIdx] ?? '').trim()
      if (!sid) continue
      for (const { def, col } of defs) {
        const raw = rec[idx(col)]
        if (raw === undefined || String(raw).trim() === '') { empty++; continue }
        const p = parseVarValue(def, raw)
        if ('error' in p) { skipped.push({ subject_id: sid, var_id: def.id, reason: p.error }); continue }
        rows.push({ subject_id: sid, var_id: def.id, value: p.value, source: 'dataset_import', source_ref: { dataset_id: dataset.id, dataset_name: dataset.name, dataset_version: dataset.version, column: col } })
      }
    }
    const res = this.patients.setSubjectVars(a, studyId, rows)
    return { ...res, empty_cells: empty, skipped: [...skipped, ...res.skipped] }
  }

  /**
   * 从受试者的影像分析记录与已定稿 DICOM 检查导入影像变量（只取实测值；肺结节变量遵循 T2.8 只取定稿快照数据）。
   * which：baseline=最早一次（默认），latest=最近一次。
   * SMI 需要记录里有身高：没有身高的记录不采用，记入 skipped。
   */
  importImaging(a: Actor, studyId: string, input: { var_ids?: string[]; which?: 'baseline' | 'latest' } = {}) {
    this.studies.get(a.userId, studyId, 'write')
    const explicitVars = Boolean(input.var_ids?.length)
    const varIds = explicitVars ? input.var_ids! : STUDY_VARS.filter(v => v.sources.includes('imaging_analysis')).map(v => v.id)
    for (const v of varIds) requireDef(v, 'imaging_analysis')
    const snap = this.patients.cohortSnapshot(a, studyId)
    const enrolled = new Map(this.patients.enrollments(a, studyId).subjects.filter(s => s.status === 'active').map(s => [s.subject_id, s.patient_id]))
    const reviewSvc = new ImagingReviewService(this.patients)
    const studySvc = new ImagingStudyService(this.patients, null)
    const followupSvc = sharedFollowup(this.patients)
    const rows: SubjectVarInput[] = []
    const skipped: Array<{ subject_id: string; var_id: string; reason: string }> = []

    for (const s of snap.subjects) {
      const scans = [...(s.imaging ?? [])]
      if (input.which === 'latest') scans.reverse()
      const pid = enrolled.get(s.subject_id) ?? null
      const allDicom = pid ? studySvc.listStudies(a, pid) : []
      const finalizedDicom = pid ? reviewSvc.finalizedStudies(a, pid) : []

      for (const varId of varIds) {
        if (NODULE_VARS.has(varId)) {
          // 未显式指定结节变量且受试者没有任何 DICOM 检查时，静默跳过以免干扰纯体成分记录导入
          if (!explicitVars && allDicom.length === 0) continue
          if (allDicom.length === 0) {
            skipped.push({ subject_id: s.subject_id, var_id: varId, reason: '没有 DICOM 影像检查' })
            continue
          }
          if (finalizedDicom.length === 0) {
            skipped.push({ subject_id: s.subject_id, var_id: varId, reason: '有影像检查但尚未定稿（科研只取定稿数据）' })
            continue
          }
          const ordered = [...finalizedDicom]
          // VDT 需要前片对比：未显式要求 baseline 时优先从最近一次定稿检查取
          if (input.which === 'latest' || (!input.which && varId === 'nodule_vdt_days')) ordered.reverse()
          let found = false
          let reason = '定稿快照中无已确认肺结节'
          for (const fs of ordered) {
            const nodules = fs.lesions.filter(l => l.kind === 'lung_nodule' && l.status === 'confirmed')
            const dom = [...nodules].sort((x, y) => (finite(y.metrics.mean_diameter_mm) ?? -1) - (finite(x.metrics.mean_diameter_mm) ?? -1)
              || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0]
            if (!dom) { reason = '定稿快照中无已确认肺结节'; continue }
            const dm = dom.metrics
            let value: number | string | null = null
            let method = `定稿快照 v${fs.version}（${fs.study_date ?? fs.study_id}）· 主病灶 ${dom.label ?? dom.id}`
            const ref: Record<string, unknown> = {
              dicom_study_id: fs.study_id, study_date: fs.study_date, signoff_id: fs.signoff_id, signoff_version: fs.version,
              lesion_id: dom.id, lesion_version: dom.version,
            }
            if (varId === 'nodule_type') {
              const rawType = typeof dm.nodule_type === 'string' ? NODULE_TYPE_LABELS[dm.nodule_type] ?? null : null
              if (!rawType) { reason = '定稿主病灶未记录密度分型'; continue }
              value = rawType
            } else if (varId === 'nodule_mean_diameter_mm') {
              const d = finite(dm.mean_diameter_mm)
              if (d === null || d <= 0) { reason = '定稿主病灶没有平均径测值'; continue }
              value = d
            } else if (varId === 'nodule_volume_mm3') {
              const v = finite(dm.volume_mm3)
              if (dm.segmentation === 'failed' || v === null || v <= 0) { reason = '定稿主病灶分割失败或没有体积测值'; continue }
              value = v
            } else if (varId === 'nodule_solid_core_mm') {
              const sc = finite(dm.solid_core_diameter_mm)
              if (sc === null || sc < 0) { reason = '定稿主病灶没有实性成分直径（非部分实性或未测）'; continue }
              value = sc
            } else if (varId === 'nodule_vdt_days') {
              const fu = followupSvc.view(a, fs.study_id)
              if (!fu.prior) { reason = '该定稿检查无前片，无法计算 VDT'; continue }
              if (fu.prior.reference !== 'finalized') { reason = '前片尚未定稿，科研不采用未定稿前片的 VDT'; continue }
              const it = fu.items.find(i => i.lesion_id === dom.id)
              if (!it || it.needs_review || !it.metrics) { reason = '主病灶无可靠的随访配对'; continue }
              if (it.metrics.within_error) { reason = '体积变化在测量误差范围内，VDT 不可靠'; continue }
              const vdt = finite(it.metrics.vdt_days)
              if (vdt === null || vdt <= 0) { reason = '主病灶体积未增大或缺少体积，无 VDT'; continue }
              value = vdt
              ref.prior_study_id = fu.prior.study_id
              ref.prior_study_date = fu.prior.study_date
              method += ` · 对比定稿前片 ${fu.prior.study_date ?? fu.prior.study_id}（间隔 ${fu.prior.interval_days ?? '?'} 天）`
            }
            if (value === null) continue
            rows.push({ subject_id: s.subject_id, var_id: varId, value, source: 'imaging_analysis', source_ref: ref, method })
            found = true
            break
          }
          if (!found) skipped.push({ subject_id: s.subject_id, var_id: varId, reason })
          continue
        }

        let found = false
        let reason = '没有影像分析记录'
        for (const scan of scans) {
          const pl = scan.payload ?? {}
          const m = (pl.metrics as Record<string, unknown> | undefined) ?? {}
          const bc = ((m.body_composition ?? pl.body_composition) as Record<string, unknown> | undefined) ?? {}
          const model = String(pl.model_id ?? m.model_name ?? pl.model_name ?? '未记录算法')
          let value: number | null = null
          let method = ''
          if (varId === 'l3_smi') {
            const smi = finite(bc.skeletal_muscle_index_cm2_m2 ?? m.l3_smi)
            const height = finite(m.patient_height_m ?? bc.height_m ?? pl.patient_height_m)
            if (smi === null) { reason = '影像记录没有 SMI 测值'; continue }
            if (height === null || height <= 0) { reason = '影像记录没有身高，不采用 SMI'; continue }
            value = smi
            method = `${model} · L3 层面骨骼肌面积 / 身高²（身高 ${height} m）`
          } else if (varId === 'vat_to_sat') {
            value = finite(bc.vat_to_sat_ratio ?? m.vat_to_sat_ratio ?? m.vat_to_sat)
            if (value === null) { reason = '影像记录没有 VAT/SAT 测值'; continue }
            method = `${model} · L3 层面内脏脂肪面积 / 皮下脂肪面积`
          }
          if (value === null) continue
          rows.push({ subject_id: s.subject_id, var_id: varId, value, source: 'imaging_analysis', source_ref: { imaging_record_id: scan.id, report_date: scan.report_date, model }, method })
          found = true
          break
        }
        if (!found) skipped.push({ subject_id: s.subject_id, var_id: varId, reason })
      }
    }
    const res = this.patients.setSubjectVars(a, studyId, rows)
    return { ...res, skipped: [...skipped, ...res.skipped] }
  }

  /** 研究者核实：items 不给时核实 var_id 下全部未核实的值。AI 调用会被拒绝。 */
  verify(a: Actor, studyId: string, input: { items?: Array<{ subject_id: string; var_id: string }>; var_id?: string }) {
    this.studies.get(a.userId, studyId, 'write')
    let items = input.items ?? []
    if (!items.length && input.var_id) {
      items = this.patients.subjectVars(a, studyId).filter(v => v.var_id === input.var_id && v.status === 'unverified').map(v => ({ subject_id: v.subject_id, var_id: v.var_id }))
    }
    if (!items.length) throw new StudyError('nothing_to_verify', '没有要核实的变量值')
    return this.patients.verifySubjectVars(a, studyId, items)
  }
}
