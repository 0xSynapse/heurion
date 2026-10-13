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
]

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
   * 从受试者的影像分析记录导入影像变量（只取实测值）。which：baseline=最早一次（默认），latest=最近一次。
   * SMI 需要记录里有身高：没有身高的记录不采用，记入 skipped。
   */
  importImaging(a: Actor, studyId: string, input: { var_ids?: string[]; which?: 'baseline' | 'latest' } = {}) {
    this.studies.get(a.userId, studyId, 'write')
    const varIds = input.var_ids?.length ? input.var_ids : STUDY_VARS.filter(v => v.sources.includes('imaging_analysis')).map(v => v.id)
    for (const v of varIds) requireDef(v, 'imaging_analysis')
    const snap = this.patients.cohortSnapshot(a, studyId)
    const rows: SubjectVarInput[] = []
    const skipped: Array<{ subject_id: string; var_id: string; reason: string }> = []

    for (const s of snap.subjects) {
      const scans = [...(s.imaging ?? [])]
      if (input.which === 'latest') scans.reverse()
      for (const varId of varIds) {
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
