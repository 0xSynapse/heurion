/**
 * 投稿材料包打包导出 (Publication Submission Bundle)
 *
 * 只用研究里真实入组受试者的真实数据生成材料，原则：
 * - 缺失值保持缺失（null），绝不补值；Table 1 显示缺失数，生存分析排除缺随访时间或结局的受试者并写明人数；
 * - 分组只取受试者真实的 treatment_arm；少于 2 个真实分组时不做组间比较；
 * - 流向图只画平台入组记录里有的环节，不编造筛选 / 排除人数与原因；
 * - 平台没有倾向性评分匹配 / 加权实现，因此不生成 Love Plot，方法学文字也不声称做过；
 * - 列线图、ROC / DCA 需要真实拟合的预测模型，当前没有，因此不生成。
 *
 * 可能包含的文件（视数据而定）：
 * 1. Table1_Baseline_Characteristics.docx（总是生成）
 * 2. Figure1_Participant_Flow.svg（总是生成，仅入组记录）
 * 3. Figure2_Kaplan_Meier_Survival_Curve.svg（有可用随访时间与结局时）
 * 4. Figure3_Cox_Forest_Plot.svg（恰有 2 个真实分组且 Cox 模型可拟合时）
 * 5. Manuscript_Statistical_Methods_and_Results.md（总是生成，只描述实际做过的分析）
 * 6. STROBE_Statement_Checklist.md（总是生成，标明材料包覆盖情况）
 * 7. Statistical_Reproducibility_Script.py（总是生成，读取用户提供的数据重算，不内置结果）
 * 8. README_Submission_Manifest.txt（总是生成，含数据完整性与未生成项说明）
 */

import { readFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'
import {
  renderEnrollmentFlowSvg,
  exportFlowchartToDrawio,
  exportFlowchartToVisioVdx,
  exportFlowchartToPptx,
  type EnrollmentFlowData,
} from './consort.ts'
import { upgradeSvgForIllustrator } from './medical-figures.ts'
import { calculateEValue, type EValueResult } from './causal-inference.ts'
import { generateSurvivalAnalysis, normalizeEventStatus, type SurvivalAnalysisResult } from '../datasets/survival.ts'
import { exportTable1ToDocx } from '../datasets/table1-docx.ts'
import { generateTable1FromData, type Table1Result } from '../datasets/table1.ts'
import { parseCustomVars, parseEligibilityPlan, StudyError, type CustomVarDef, type StudyService } from './service.ts'
import type { PatientService, SubjectVar } from '../tenancy/patients.ts'
import { SOURCE_LABELS, STUDY_VARS } from './subject-vars.ts'
import { parseCsv, type DatasetService } from '../datasets/service.ts'
import type { Actor } from '../tenancy/patients.ts'

export interface PublicationBundleOptions {
  include_code?: boolean
  dataset_id?: string
  time_col?: string
  event_col?: string
  group_col?: string
  /**
   * 数据集路径的随访时间单位（如 'Months' / 'Days' / 'Years' / 'Weeks'）。
   * 未提供时仅在时间列名明确含单位（如 os_months、随访天数）时推断；推断不出则视为未指定，不默认按月。
   * 患者路径固定为月（followup_months）。
   */
  time_unit?: string
}

/** 材料包里一条受试者记录；未记录的字段一律为 null */
export interface BundleRecord {
  subject_id: string
  treatment_arm: string | null
  age: number | null
  sex: string | null
  l3_smi: number | null
  vat_to_sat: number | null
  followup_months: number | null
  os_status: number | null
  [k: string]: unknown
}

/** 生成过程中对数据完整性与分析取舍的如实记录（写进 README 与正文） */
export interface BundleDataReport {
  n_subjects: number
  missing: Record<string, number>
  provenance: VarProvenance[]
  arms: Array<{ name: string; n: number }>
  arm_missing: number
  grouped: boolean
  enrollment: { enrolled_ever: number; withdrawn: number; inaccessible: number }
  survival: {
    included: number
    excluded_missing_time_or_status: number
    excluded_missing_arm: number
    generated: boolean
    cox_generated: boolean
  }
  omitted: string[]
  /** 数据来源：平台入组受试者（研究变量经核实流程）或上传的研究数据集（未经平台核实流程） */
  data_source: 'patients' | 'dataset'
  /** 数据集路径的数据集名称 */
  dataset_name?: string
  /** 生存分析实际使用的列名（可复现脚本据此生成）；未使用时为 null */
  columns: { time: string | null; event: string | null; group: string | null }
  /** 随访时间单位；null 表示未指定 */
  time_unit: string | null
  /** 时间单位来源：调用方参数 / 时间列名推断 / 变量定义固定（followup_months） */
  time_unit_source: 'option' | 'column_name' | 'fixed' | null
  /** 研究是否保存了纳排筛选漏斗记录（决定正文 / STROBE 对筛选环节的表述） */
  screening: { assessed_total: number; excluded_total: number } | null
}

/** 按时间列名推断单位；列名里没有明确单位词时返回 null（不默认按月） */
export function inferTimeUnitFromColumn(col: string): string | null {
  const c = col.toLowerCase()
  if (/(^|[_\s-])(months?|mo)($|[_\s-])|月/.test(c)) return 'Months'
  if (/(^|[_\s-])days?($|[_\s-])|天|日数/.test(c)) return 'Days'
  if (/(^|[_\s-])weeks?($|[_\s-])|周/.test(c)) return 'Weeks'
  if (/(^|[_\s-])years?($|[_\s-])|年数/.test(c)) return 'Years'
  return null
}

/** 只有单位已知时才给出按单位换算的里程碑时间点；未知单位不输出里程碑 */
function milestonesForUnit(unit: string | null): number[] {
  const u = (unit ?? '').toLowerCase()
  if (u.startsWith('month')) return [12, 24, 36, 60]
  if (u.startsWith('day')) return [365, 730, 1095, 1825]
  if (u.startsWith('week')) return [52, 104, 156, 260]
  if (u.startsWith('year')) return [1, 2, 3, 5]
  return []
}

/** 进入材料包的研究变量（来自 subject_vars，只用已核实的值） */
const BUNDLE_VARS = ['treatment_arm', 'followup_months', 'os_status', 'l3_smi', 'vat_to_sat'] as const
type BundleVarId = typeof BUNDLE_VARS[number]

/** 每个研究变量的来源、核实与缺失情况（写进 README 与正文） */
export interface VarProvenance {
  var_id: string
  label: string
  sources: string[]
  /** 录入了值的受试者数 */
  entered: number
  verified: number
  /** 有值但未核实、因此没有使用的数量 */
  unverified_excluded: number
  /** 没有可用（已核实）值的受试者数 */
  missing: number
  methods: string[]
}

function normalizeSex(v: unknown): string | null {
  if (v === 'M' || v === '男') return '男'
  if (v === 'F' || v === '女') return '女'
  return null
}

type SnapshotSubject = { subject_id: string; sex: string | null; age_at_enroll: number | null; vars?: Record<string, SubjectVar> }

/** 已核实的值才使用；未核实、缺失一律为 null（不补值） */
function verifiedValue(s: SnapshotSubject, id: string): number | string | null {
  const v = s.vars?.[id]
  return v && v.status === 'verified' ? v.value : null
}

/** 把入组快照里的受试者转成材料包记录：年龄 / 性别来自患者主档案，其余只取已核实的研究变量 */
export function toBundleRecords(subjects: SnapshotSubject[], customVars: CustomVarDef[] = []): BundleRecord[] {
  return subjects.map(s => {
    const num = (id: string) => { const v = verifiedValue(s, id); return typeof v === 'number' ? v : v === null ? null : (Number.isFinite(Number(v)) ? Number(v) : null) }
    const arm = verifiedValue(s, 'treatment_arm')
    const os = verifiedValue(s, 'os_status')
    const base: BundleRecord = {
      subject_id: String(s.subject_id),
      treatment_arm: arm === null ? null : String(arm),
      age: s.age_at_enroll ?? null,
      sex: normalizeSex(s.sex),
      l3_smi: num('l3_smi'),
      vat_to_sat: num('vat_to_sat'),
      followup_months: num('followup_months'),
      os_status: os === null ? null : normalizeEventStatus(os),
    }
    for (const cv of customVars) {
      if (cv.key in base) continue
      const v = verifiedValue(s, cv.key)
      base[cv.key] = cv.kind === 'continuous' || cv.kind === 'binary' ? num(cv.key) : (v === null ? null : String(v))
    }
    return base
  })
}

/** 统计每个研究变量的来源与核实状态 */
export function varProvenance(subjects: SnapshotSubject[], customVars: CustomVarDef[] = []): VarProvenance[] {
  const ids: Array<{ id: string; label: string }> = [
    ...BUNDLE_VARS.map(id => ({ id, label: STUDY_VARS.find(d => d.id === id)?.label ?? id })),
    ...customVars.filter(cv => !(BUNDLE_VARS as readonly string[]).includes(cv.key)).map(cv => ({ id: cv.key, label: cv.label })),
  ]
  return ids.map(({ id, label }) => {
    const vs = subjects.map(s => s.vars?.[id]).filter((v): v is SubjectVar => !!v)
    const verified = vs.filter(v => v.status === 'verified').length
    return {
      var_id: id,
      label,
      sources: [...new Set(vs.map(v => SOURCE_LABELS[v.source] ?? v.source))],
      entered: vs.length,
      verified,
      unverified_excluded: vs.length - verified,
      missing: subjects.length - verified,
      methods: [...new Set(vs.map(v => v.method).filter((m): m is string => !!m))],
    }
  })
}

export class PublicationBundleService {
  constructor(
    private readonly studies: StudyService,
    private readonly patients: PatientService,
    private readonly datasets?: DatasetService | null
  ) {}

  /**
   * 编译并生成投稿材料 ZIP 包。研究没有入组受试者时拒绝生成。
   */
  async buildBundle(
    a: Actor,
    studyId: string,
    _options: PublicationBundleOptions = {}
  ): Promise<{ filename: string; zipBuffer: Uint8Array; totalFiles: number; report: BundleDataReport }> {
    const study = this.studies.get(a.userId, studyId, 'read')
    const nowStr = new Date().toISOString().slice(0, 10)

    // 1. 入组快照：只用真实受试者（若无入组受试者但归入了已就绪的外部上传数据集，则走外部数据集轨道）
    const snap = this.patients.cohortSnapshot(a, studyId, { log: true })
    if (snap.subjects.length === 0) {
      const readyDs = this.datasets ? this.studies.readyDatasets(a.userId, studyId) : []
      const targetDsId = _options.dataset_id ?? readyDs[0]?.dataset_id
      if (this.datasets && targetDsId && snap.skipped.length === 0) {
        return this.buildBundleFromDataset(a, study, targetDsId, nowStr, _options)
      }
      throw new StudyError(
        'empty_cohort',
        snap.skipped.length > 0
          ? `研究中的 ${snap.skipped.length} 名受试者你都没有访问权限，无法生成投稿材料包`
          : '研究还没有入组受试者，无法生成投稿材料包。请先完成入组。',
        400,
      )
    }
    const customVars = parseCustomVars(study.custom_vars)
    const records = toBundleRecords(snap.subjects, customVars)
    const provenance = varProvenance(snap.subjects, customVars)
    const n = records.length

    // 缺失数：未核实的值按缺失计（没有进入分析）
    const missing: Record<string, number> = {}
    for (const k of ['treatment_arm', 'age', 'sex', 'l3_smi', 'vat_to_sat', 'followup_months', 'os_status', ...customVars.map(c => c.key)]) {
      missing[k] = records.filter(r => r[k] === null || r[k] === undefined).length
    }
    const omitted: string[] = []
    for (const pv of provenance) {
      if (pv.unverified_excluded > 0) omitted.push(`${pv.label}：${pv.unverified_excluded} 个值未经研究者核实，未进入 Table 1 与生存分析`)
    }

    // 2. 分组：只认受试者真实的 treatment_arm
    const armCounts = new Map<string, number>()
    for (const r of records) if (r.treatment_arm) armCounts.set(r.treatment_arm, (armCounts.get(r.treatment_arm) ?? 0) + 1)
    const arms = [...armCounts.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([name, cnt]) => ({ name, n: cnt }))
    const grouped = arms.length >= 2
    const armMissing = missing.treatment_arm!

    // 3. Table 1：有 ≥2 个真实分组时分组比较，否则只做总体描述；缺失值由 table1 统计为 Missing 行
    const verifiedCustomCols = customVars.filter(cv => (provenance.find(p => p.var_id === cv.key)?.verified ?? 0) > 0)
    const table1Labels: Record<string, string> = {
      age: '年龄 (岁)',
      sex: '生理性别',
      l3_smi: 'L3 骨骼肌质量指数 SMI (cm²/m²)',
      vat_to_sat: '内脏/皮下脂肪比 (VAT/SAT)',
      followup_months: '总随访时间 (月)',
    }
    for (const cv of verifiedCustomCols) {
      table1Labels[cv.key] = cv.unit ? `${cv.label} (${cv.unit})` : cv.label
      if (cv.value_labels) {
        for (const [code, meaning] of Object.entries(cv.value_labels)) {
          table1Labels[`${cv.key}.${code}`] = meaning
        }
      }
    }
    const table1Result: Table1Result = generateTable1FromData(records, {
      group_col: grouped ? 'treatment_arm' : undefined,
      // 没有任何已核实值的研究变量不进 Table 1（原因写在 README 与正文）
      columns: [
        'age',
        'sex',
        ...(['l3_smi', 'vat_to_sat', 'followup_months'] as const).filter(k => provenance.find(p => p.var_id === k)!.verified > 0),
        ...verifiedCustomCols.map(cv => cv.key),
      ],
      continuous_vars: ['age', 'l3_smi', 'vat_to_sat', 'followup_months', ...verifiedCustomCols.filter(cv => cv.kind === 'continuous').map(cv => cv.key)],
      categorical_vars: ['sex', ...verifiedCustomCols.filter(cv => cv.kind !== 'continuous').map(cv => cv.key)],
      show_missing: true,
      labels: table1Labels,
      title: `${study.title} · Baseline Characteristics (Table 1)`,
    })
    table1Result.footnotes.push('Age and sex: patient registry (来源：患者主档案). Other variables: researcher-verified values only.')
    if (grouped && armMissing > 0) {
      table1Result.footnotes.push(`${armMissing} participant(s) without a recorded treatment arm are included in the Overall column only.`)
    }
    if (!grouped) {
      table1Result.footnotes.push('No between-group comparison: fewer than two treatment arms are recorded for enrolled participants.')
    }
    const table1Docx = exportTable1ToDocx(table1Result)
    if (!grouped) omitted.push('Table 1 组间比较（受试者没有记录至少 2 个治疗分组）')

    // 4. 受试者流向图：只用平台入组记录（若研究保存了结构化纳排筛选漏斗快照，则如实展示初筛评估与排除明细）
    const roster = this.patients.enrollments(a, studyId).subjects
    const withdrawn = roster.filter(s => s.status === 'withdrawn').length
    const inaccessible = snap.skipped.length
    const enrolledEver = n + inaccessible + withdrawn
    const savedFunnel = parseEligibilityPlan(study.eligibility_plan)?.last_funnel ?? null
    const flowData: EnrollmentFlowData = {
      title: `${study.title} · Participant Flow`,
      ...(savedFunnel
        ? {
            screening_funnel: {
              assessed_total: savedFunnel.assessed_total,
              excluded_total: savedFunnel.excluded_total,
              exclusions: savedFunnel.exclusions_by_rule.map(e => ({ reason: e.title, count: e.count })),
            },
          }
        : {}),
      enrolled_ever: enrolledEver,
      withdrawn,
      inaccessible,
      analyzed: n,
      arms: grouped || arms.length === 1 ? arms : [],
      unassigned: arms.length > 0 ? armMissing : 0,
      note: savedFunnel
        ? `初筛评估 N = ${savedFunnel.assessed_total}，排除 n = ${savedFunnel.excluded_total}（来源：本研究纳排方案筛选记录）。`
        : '平台未记录筛选人数与排除原因，因此未绘制 Assessed / Excluded 环节；请作者按原始纳排记录补充。',
    }
    const flowSvg = upgradeSvgForIllustrator(renderEnrollmentFlowSvg(flowData), {
      title: `${study.title} Participant Flow`,
      layerName: 'Participant_Flowchart',
    })
    const flowDrawio = exportFlowchartToDrawio(flowData)
    const flowVisioVdx = exportFlowchartToVisioVdx(flowData)
    const flowPptx = exportFlowchartToPptx(flowData)
    if (!savedFunnel) {
      omitted.push('CONSORT 筛选 / 排除环节（平台没有纳排筛选记录）')
    }

    // 5. Love Plot：平台没有倾向性评分匹配 / 加权实现，不生成
    omitted.push('Love Plot 协变量平衡图（未做倾向性评分匹配或加权；两组未匹配的 SMD 见 Table 1）')

    // 6. 生存分析：排除缺随访时间或结局的受试者；分组分析时再排除缺分组的受试者
    const withOutcome = records.filter(r => r.followup_months !== null && r.followup_months >= 0 && r.os_status !== null)
    const excludedMissingOutcome = n - withOutcome.length
    const survivalRecords = grouped ? withOutcome.filter(r => r.treatment_arm !== null) : withOutcome
    const excludedMissingArm = withOutcome.length - survivalRecords.length
    let survRes: SurvivalAnalysisResult | null = null
    let coxOk = false
    if (survivalRecords.length > 0) {
      survRes = generateSurvivalAnalysis(survivalRecords, {
        time_col: 'followup_months',
        event_col: 'os_status',
        group_col: grouped ? 'treatment_arm' : undefined,
        // 不传协变量：恰有 2 组时 survival.ts 只拟合分组的单因素 Cox（未校正）
        covariates: [],
        time_unit: 'Months',
        title: `${study.title} · Kaplan-Meier Survival Analysis`,
      })
      const cox = survRes.cox
      // calculateCoxRegression 在样本或事件不足时返回 HR=1.00 的占位结果，不能当作真实估计
      coxOk = !!cox && cox.covariates.length > 0 && cox.events_count >= 2 && cox.sample_size >= cox.covariates.length + 2
    } else {
      omitted.push('Kaplan-Meier 生存曲线（没有同时记录随访时间与结局的受试者）')
    }
    if (survRes && !coxOk) omitted.push(grouped && arms.length === 2 ? 'Cox 森林图（事件数或样本量不足，无法拟合）' : 'Cox 森林图（需要恰好 2 个真实治疗分组）')

    // 7. E-value：只在真实拟合出两组 HR 时计算
    let evalue: EValueResult | null = null
    if (survRes && coxOk) {
      const c0 = survRes.cox!.covariates[0]!
      if (c0.hr > 0 && c0.hr_ci_lower > 0 && c0.hr_ci_upper > 0) {
        evalue = calculateEValue({ effect_type: 'HR', estimate: c0.hr, ci_lower: c0.hr_ci_lower, ci_upper: c0.hr_ci_upper })
      }
    }
    omitted.push('预后列线图、ROC / DCA 曲线（平台没有为本研究拟合预测模型）')

    const report: BundleDataReport = {
      n_subjects: n,
      missing,
      provenance,
      arms,
      arm_missing: armMissing,
      grouped,
      enrollment: { enrolled_ever: enrolledEver, withdrawn, inaccessible },
      survival: {
        included: survivalRecords.length,
        excluded_missing_time_or_status: excludedMissingOutcome,
        excluded_missing_arm: excludedMissingArm,
        generated: !!survRes,
        cox_generated: coxOk,
      },
      omitted,
      data_source: 'patients',
      columns: { time: 'followup_months', event: 'os_status', group: grouped ? 'treatment_arm' : null },
      time_unit: 'Months',
      time_unit_source: 'fixed',
      screening: savedFunnel ? { assessed_total: savedFunnel.assessed_total, excluded_total: savedFunnel.excluded_total } : null,
    }

    // 8. 正文、清单、脚本、清单文件
    const manuscriptMd = this.generateManuscriptDraft(study.title, report, table1Result, survRes, evalue)
    const strobeMd = this.generateStrobeChecklist(study.title, report)
    const reproPy = this.generateReproducibilityPythonScript(study.title, report)

    const zipMap: Record<string, Uint8Array> = {
      'Table1_Baseline_Characteristics.docx': table1Docx,
      'Figure1_Participant_Flow.svg': strToU8(flowSvg),
      'Figure1_Participant_Flow.drawio': strToU8(flowDrawio),
      'Figure1_Participant_Flow.vdx': strToU8(flowVisioVdx),
      'Figure1_Participant_Flow.pptx': flowPptx,
    }
    if (survRes) {
      zipMap['Figure2_Kaplan_Meier_Survival_Curve.svg'] = strToU8(survRes.native_exports?.illustrator_svg ?? survRes.svg)
      if (survRes.native_exports?.prism_pzfx) {
        zipMap['Figure2_Kaplan_Meier_Survival_Curve.pzfx'] = strToU8(survRes.native_exports.prism_pzfx)
      }
      if (survRes.native_exports?.r_script) {
        zipMap['Figure2_Kaplan_Meier_Survival_Curve.R'] = strToU8(survRes.native_exports.r_script)
      }
    }
    if (survRes && coxOk && survRes.forest_svg) {
      zipMap['Figure3_Cox_Forest_Plot.svg'] = strToU8(survRes.native_exports?.forest_illustrator_svg ?? survRes.forest_svg)
      if (survRes.native_exports?.forest_prism_pzfx) {
        zipMap['Figure3_Cox_Forest_Plot.pzfx'] = strToU8(survRes.native_exports.forest_prism_pzfx)
      }
      if (survRes.native_exports?.forest_r_script) {
        zipMap['Figure3_Cox_Forest_Plot.R'] = strToU8(survRes.native_exports.forest_r_script)
      }
    }
    zipMap['Manuscript_Statistical_Methods_and_Results.md'] = strToU8(manuscriptMd)
    zipMap['STROBE_Statement_Checklist.md'] = strToU8(strobeMd)
    zipMap['Statistical_Reproducibility_Script.py'] = strToU8(reproPy)
    zipMap['README_Submission_Manifest.txt'] = strToU8(this.generateManifest(study.title, study.design, nowStr, report, Object.keys(zipMap)))

    const zipBuffer = zipSync(zipMap)
    const filename = `SCI_Submission_Bundle_${studyId}_${nowStr}.zip`
    return { filename, zipBuffer, totalFiles: Object.keys(zipMap).length, report }
  }

  /**
   * 当研究尚未从院内患者库入组受试者，但归入了外部上传的科研数据集（如多工作表 Excel + 数据字典）时，
   * 直接基于该数据集及其数据字典标签/取值编码编译投稿材料包（Phase 3 双轨合一）。
   */
  private async buildBundleFromDataset(
    a: Actor,
    study: { id: string; title: string; design: string | null; eligibility_plan?: string | null },
    datasetId: string,
    nowStr: string,
    options: PublicationBundleOptions,
  ): Promise<{ filename: string; zipBuffer: Uint8Array; totalFiles: number; report: BundleDataReport }> {
    const { dataset, path } = this.datasets!.readyCsv(a.userId, datasetId)
    const rawRows = parseCsv(readFileSync(path, 'utf8'))
    const header = rawRows[0] ?? []
    const body = rawRows.slice(1).filter(r => r.some(c => String(c ?? '').trim() !== ''))
    if (body.length === 0 || header.length === 0) {
      throw new StudyError('empty_cohort', '研究关联的数据集为空，无法生成投稿材料包。', 400)
    }

    const colProfiles = new Map((dataset.columns ?? []).map(c => [c.name, c]))
    const labels: Record<string, string> = { ...(dataset.labels ?? {}) }
    for (const [col, map] of Object.entries(dataset.value_labels ?? {})) {
      if (map && typeof map === 'object') {
        for (const [code, meaning] of Object.entries(map)) {
          if (meaning) labels[`${col}.${code}`] = meaning
        }
      }
    }

    const records: Array<Record<string, unknown>> = body.map((row, rIdx) => {
      const obj: Record<string, unknown> = { subject_id: `D${String(rIdx + 1).padStart(3, '0')}` }
      header.forEach((col, cIdx) => {
        const raw = String(row[cIdx] ?? '').trim()
        if (!raw) {
          obj[col] = null
          return
        }
        const prof = colProfiles.get(col)
        const valMap = dataset.value_labels?.[col]
        if (valMap && valMap[raw] !== undefined) {
          obj[col] = raw
          return
        }
        const n = Number(raw)
        if (Number.isFinite(n) && (prof?.type === 'numeric' || !prof)) {
          obj[col] = n
        } else {
          obj[col] = raw
        }
      })
      return obj
    })

    const idColPattern = /^(id|subject_id|patient_id|编号|受试者编号|病历号)$/i
    const analysisCols = header.filter(c => !idColPattern.test(c))
    const groupCol = options.group_col && header.includes(options.group_col)
      ? options.group_col
      : analysisCols.find(c => /^(group|treatment|treatment_arm|arm|分组|组别|治疗组)$/i.test(c) || /^(分组|组别|治疗)/.test(labels[c] ?? ''))
    const timeCol = options.time_col && header.includes(options.time_col)
      ? options.time_col
      : analysisCols.find(c => /^(time|os_time|os_months|followup_months|pfs_months|随访时间|生存时间)$/i.test(c))
    const eventCol = options.event_col && header.includes(options.event_col)
      ? options.event_col
      : analysisCols.find(c => /^(event|status|os_status|pfs_status|death|结局|终点事件|死亡)$/i.test(c))

    const n = records.length
    const missing: Record<string, number> = {}
    const provenance: VarProvenance[] = []
    for (const col of analysisCols) {
      const missCnt = records.filter(r => r[col] === null || r[col] === undefined || r[col] === '').length
      missing[col] = missCnt
      provenance.push({
        var_id: col,
        label: labels[col] || col,
        sources: [`研究数据集《${dataset.name}》`],
        entered: n - missCnt,
        // 上传数据集不经过平台核实流程：不得把非空值记为「已核实」；非空值照常进入分析（见 data_source）
        verified: 0,
        unverified_excluded: 0,
        missing: missCnt,
        methods: dataset.dictionary_sheet ? [`数据字典工作表: ${dataset.dictionary_sheet}`] : [],
      })
    }

    const armCounts = new Map<string, number>()
    let armMissing = 0
    if (groupCol) {
      for (const r of records) {
        const rawG = r[groupCol]
        if (rawG === null || rawG === undefined || rawG === '') {
          armMissing++
        } else {
          const code = String(rawG)
          const gLabel = labels[`${groupCol}.${code}`] ?? labels[code] ?? code
          armCounts.set(gLabel, (armCounts.get(gLabel) ?? 0) + 1)
        }
      }
    } else {
      armMissing = n
    }
    const arms = [...armCounts.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([name, cnt]) => ({ name, n: cnt }))
    const grouped = Boolean(groupCol && arms.length >= 2)

    const tableCols = analysisCols.filter(c => c !== groupCol)
    const continuousVars = tableCols.filter(c => {
      if (dataset.value_labels?.[c] && Object.keys(dataset.value_labels[c]!).length > 0) return false
      return colProfiles.get(c)?.type === 'numeric'
    })
    const categoricalVars = tableCols.filter(c => !continuousVars.includes(c))

    const table1Result: Table1Result = generateTable1FromData(records, {
      group_col: grouped ? groupCol : undefined,
      columns: tableCols,
      continuous_vars: continuousVars,
      categorical_vars: categoricalVars,
      show_missing: true,
      labels,
      title: `${study.title} · Baseline Characteristics (Table 1)`,
    })
    table1Result.footnotes.push(`Source dataset: ${dataset.name} (n = ${n})${dataset.dictionary_sheet ? `, linked with Data Dictionary sheet "${dataset.dictionary_sheet}"` : ''}.`)
    const table1Docx = exportTable1ToDocx(table1Result)

    const omitted: string[] = []
    if (!grouped) omitted.push('Table 1 组间比较（数据集未指定或少于 2 个分组）')

    const savedFunnel = parseEligibilityPlan(study.eligibility_plan)?.last_funnel ?? null
    const flowData: EnrollmentFlowData = {
      title: `${study.title} · Participant Flow`,
      ...(savedFunnel
        ? {
            screening_funnel: {
              assessed_total: savedFunnel.assessed_total,
              excluded_total: savedFunnel.excluded_total,
              exclusions: savedFunnel.exclusions_by_rule.map(e => ({ reason: e.title, count: e.count })),
            },
          }
        : {}),
      enrolled_ever: n,
      withdrawn: 0,
      inaccessible: 0,
      analyzed: n,
      arms: grouped || arms.length === 1 ? arms : [],
      unassigned: arms.length > 0 ? armMissing : 0,
      note: `数据来源：研究关联数据集《${dataset.name}》（N = ${n}）`,
    }
    const flowSvg = upgradeSvgForIllustrator(renderEnrollmentFlowSvg(flowData), {
      title: `${study.title} Participant Flow`,
      layerName: 'Participant_Flowchart',
    })
    const flowDrawio = exportFlowchartToDrawio(flowData)
    const flowVisioVdx = exportFlowchartToVisioVdx(flowData)
    const flowPptx = exportFlowchartToPptx(flowData)
    if (!savedFunnel) {
      omitted.push('CONSORT 筛选 / 排除环节（研究没有保存纳排筛选记录）')
    }

    // 随访时间单位：调用方参数优先，其次按时间列名推断；都没有则为未指定（不默认按月）
    const optUnit = options.time_unit && options.time_unit.trim() ? options.time_unit.trim() : null
    const inferredUnit = !optUnit && timeCol ? inferTimeUnitFromColumn(timeCol) : null
    const timeUnit: string | null = optUnit ?? inferredUnit
    const timeUnitSource: BundleDataReport['time_unit_source'] = optUnit ? 'option' : inferredUnit ? 'column_name' : null

    let survRes: SurvivalAnalysisResult | null = null
    let coxOk = false
    let survIncluded = 0
    let excludedMissingOutcome = n
    let excludedMissingArm = 0

    if (timeCol && eventCol) {
      const withOutcome = records.filter(r => {
        const t = Number(r[timeCol])
        const ev = normalizeEventStatus(r[eventCol])
        return Number.isFinite(t) && t >= 0 && ev !== null
      })
      excludedMissingOutcome = n - withOutcome.length
      const survRecords = grouped && groupCol
        ? withOutcome.filter(r => r[groupCol] !== null && r[groupCol] !== undefined && r[groupCol] !== '')
        : withOutcome
      excludedMissingArm = withOutcome.length - survRecords.length
      survIncluded = survRecords.length
      if (survRecords.length > 0) {
        survRes = generateSurvivalAnalysis(survRecords, {
          time_col: timeCol,
          event_col: eventCol,
          group_col: grouped ? groupCol : undefined,
          covariates: [],
          // 单位未知时不写单位、不输出依赖单位的里程碑生存率
          time_unit: timeUnit ?? 'time units (unspecified)',
          milestones: milestonesForUnit(timeUnit),
          labels,
          title: `${study.title} · Kaplan-Meier Survival Analysis`,
        })
        const cox = survRes.cox
        coxOk = !!cox && cox.covariates.length > 0 && cox.events_count >= 2 && cox.sample_size >= cox.covariates.length + 2
      }
    } else {
      omitted.push('Kaplan-Meier 生存曲线（数据集中未配置或未检出随访时间与结局事件列）')
    }

    let evalue: EValueResult | null = null
    if (survRes && coxOk) {
      const c0 = survRes.cox!.covariates[0]!
      if (c0.hr > 0 && c0.hr_ci_lower > 0 && c0.hr_ci_upper > 0) {
        evalue = calculateEValue({ effect_type: 'HR', estimate: c0.hr, ci_lower: c0.hr_ci_lower, ci_upper: c0.hr_ci_upper })
      }
    }

    const report: BundleDataReport = {
      n_subjects: n,
      missing,
      provenance,
      arms,
      arm_missing: armMissing,
      grouped,
      enrollment: { enrolled_ever: n, withdrawn: 0, inaccessible: 0 },
      survival: {
        included: survIncluded,
        excluded_missing_time_or_status: excludedMissingOutcome,
        excluded_missing_arm: excludedMissingArm,
        generated: !!survRes,
        cox_generated: coxOk,
      },
      omitted,
      data_source: 'dataset',
      dataset_name: dataset.name,
      columns: {
        time: timeCol && eventCol ? timeCol : null,
        event: timeCol && eventCol ? eventCol : null,
        group: grouped && groupCol ? groupCol : null,
      },
      time_unit: timeUnit,
      time_unit_source: timeUnitSource,
      screening: savedFunnel ? { assessed_total: savedFunnel.assessed_total, excluded_total: savedFunnel.excluded_total } : null,
    }

    const manuscriptMd = this.generateManuscriptDraft(study.title, report, table1Result, survRes, evalue)
    const strobeMd = this.generateStrobeChecklist(study.title, report)
    const reproPy = this.generateReproducibilityPythonScript(study.title, report)

    const zipMap: Record<string, Uint8Array> = {
      'Table1_Baseline_Characteristics.docx': table1Docx,
      'Figure1_Participant_Flow.svg': strToU8(flowSvg),
      'Figure1_Participant_Flow.drawio': strToU8(flowDrawio),
      'Figure1_Participant_Flow.vdx': strToU8(flowVisioVdx),
      'Figure1_Participant_Flow.pptx': flowPptx,
    }
    if (survRes) {
      zipMap['Figure2_Kaplan_Meier_Survival_Curve.svg'] = strToU8(survRes.native_exports?.illustrator_svg ?? survRes.svg)
    }
    if (survRes && coxOk && survRes.forest_svg) {
      zipMap['Figure3_Cox_Forest_Plot.svg'] = strToU8(survRes.native_exports?.forest_illustrator_svg ?? survRes.forest_svg)
    }
    zipMap['Manuscript_Statistical_Methods_and_Results.md'] = strToU8(manuscriptMd)
    zipMap['STROBE_Statement_Checklist.md'] = strToU8(strobeMd)
    zipMap['Statistical_Reproducibility_Script.py'] = strToU8(reproPy)
    zipMap['README_Submission_Manifest.txt'] = strToU8(this.generateManifest(study.title, study.design, nowStr, report, Object.keys(zipMap)))

    const zipBuffer = zipSync(zipMap)
    const filename = `SCI_Submission_Bundle_${study.id}_${nowStr}.zip`
    return { filename, zipBuffer, totalFiles: Object.keys(zipMap).length, report }
  }

  private generateManifest(title: string, design: string | null | undefined, date: string, r: BundleDataReport, files: string[]): string {
    const miss = Object.entries(r.missing).map(([k, v]) => `   - ${k}: ${v} / ${r.n_subjects} missing`).join('\n')
    const arms = r.arms.length ? r.arms.map(x => `${x.name} (n = ${x.n})`).join(', ') : 'none recorded'
    return `========================================================================
HEURION CLINICAL RESEARCH COLLABORATIVE PLATFORM
SUBMISSION BUNDLE (DRAFT MATERIALS — REVIEW BEFORE SUBMISSION)
========================================================================
Study Title: ${title}
Study Design: ${design || 'Not specified'}
Generated At: ${date}

BUNDLE INVENTORY:
${[...files, 'README_Submission_Manifest.txt'].map((f, i) => `${i + 1}. ${f}`).join('\n')}

DATA COMPLETENESS (no values were imputed; missing values remain missing):
 - Participants included: ${r.n_subjects}
 - Enrollment records: ${r.enrollment.enrolled_ever} ever enrolled, ${r.enrollment.withdrawn} withdrawn, ${r.enrollment.inaccessible} not exported (no access)
 - Treatment arms: ${arms}${r.arm_missing ? `; arm missing for ${r.arm_missing}` : ''}
 - Missing values by variable${r.data_source === 'patients' ? ' (unverified values count as missing)' : ''}:
${miss}

${r.data_source === 'patients'
  ? `VARIABLE PROVENANCE (only researcher-verified values are used):
${r.provenance.map(p => ` - ${p.var_id} (${p.label}): source ${p.sources.join(' / ') || 'none'}; ${p.verified} verified, ${p.unverified_excluded} unverified (not used), ${p.missing} / ${r.n_subjects} without a usable value${p.methods.length ? `; method: ${p.methods.join(' | ')}` : ''}`).join('\n')}
 - age, sex: 来源：患者主档案 (patient registry: birth year / sex on the patient record); not part of the verification workflow`
  : `VARIABLE PROVENANCE (uploaded research dataset "${r.dataset_name ?? ''}"; values were NOT checked through the platform verification workflow and are analysed as uploaded):
${r.provenance.map(p => ` - ${p.var_id} (${p.label}): source ${p.sources.join(' / ') || 'none'}; ${p.entered} non-missing, ${p.missing} / ${r.n_subjects} missing${p.methods.length ? `; ${p.methods.join(' | ')}` : ''}`).join('\n')}`}
 - Follow-up time unit: ${r.time_unit ? `${r.time_unit}${r.time_unit_source === 'column_name' ? ' (inferred from column name)' : ''}` : 'not specified'}
 - Survival analysis: ${r.survival.included} included; ${r.survival.excluded_missing_time_or_status} excluded for missing follow-up time or outcome status${r.survival.excluded_missing_arm ? `; ${r.survival.excluded_missing_arm} excluded for missing treatment arm` : ''}

NOT GENERATED (and why):
${r.omitted.map(o => ` - ${o}`).join('\n')}
========================================================================
`
  }

  private generateManuscriptDraft(
    title: string,
    r: BundleDataReport,
    t1: Table1Result,
    surv: SurvivalAnalysisResult | null,
    evalue: EValueResult | null,
  ): string {
    const t1Methods = t1.footnotes.find(f => f.startsWith('P values are calculated using'))
    const armText = r.arms.map(x => `${x.name} (n = ${x.n})`).join(' and ')
    const fromDataset = r.data_source === 'dataset'
    // 受试者流向：按是否保存了纳排筛选记录分支表述
    const flowText = r.screening
      ? `Participant flow is shown in **Figure 1**: ${r.screening.assessed_total} individuals were assessed for eligibility and ${r.screening.excluded_total} were excluded according to the study's saved eligibility screening record; exclusion reasons are listed in the figure.`
      : `Participant flow is shown in **Figure 1**, based on ${fromDataset ? 'the rows of the uploaded dataset' : "the platform's enrollment records"} only; screening counts and exclusion reasons were not recorded on the platform and must be supplied by the authors.`
    // 变量来源：患者路径只用已核实值；数据集路径未经平台核实流程，必须如实说明
    const sourceSection = fromDataset
      ? `#### 1.3 Data Source
All variables were taken from the uploaded research dataset "${r.dataset_name ?? ''}" (数据来源：上传的研究数据集). These values were not checked through the platform's verification workflow and were analysed as uploaded; the authors are responsible for their accuracy.

| Variable | Source | Non-missing | Missing | Notes |
| :--- | :--- | :---: | :---: | :--- |
${r.provenance.map(p => `| ${p.var_id} | ${p.sources.join(' / ') || '—'} | ${p.entered} | ${p.missing} / ${r.n_subjects} | ${p.methods.join('; ') || '—'} |`).join('\n')}`
      : `#### 1.3 Variable Sources and Verification
Only values verified by the study investigators were analysed; unverified values were treated as missing. Age and sex were taken from the patient registry (来源：患者主档案) and are not part of the verification workflow.

| Variable | Source | Verified | Unverified (not used) | Without usable value | Method |
| :--- | :--- | :---: | :---: | :---: | :--- |
${r.provenance.map(p => `| ${p.var_id} | ${p.sources.join(' / ') || '—'} | ${p.verified} | ${p.unverified_excluded} | ${p.missing} / ${r.n_subjects} | ${p.methods.join('; ') || '—'} |`).join('\n')}`
    const timeUnitText = r.time_unit
      ? ` Follow-up time was analysed in ${r.time_unit.toLowerCase()}${r.time_unit_source === 'column_name' ? ` (unit inferred from the column name "${r.columns.time ?? ''}")` : ''}.`
      : ` The time unit of the follow-up column${r.columns.time ? ` "${r.columns.time}"` : ''} was not specified (时间单位未指定); times are reported in the dataset's original units and no fixed-time survival rates are given.`
    const parts: string[] = []
    parts.push(`# Statistical Methods & Results Section Draft
## Study: ${title}

> Draft generated from the data recorded on the platform. Every statement below describes an analysis that was actually run; please verify and extend before submission.

### 1. Statistical Analysis Methods

#### 1.1 Study Population and Baseline Characteristics
${flowText} Baseline characteristics are summarized in **Table 1**${r.grouped ? ` by treatment arm` : ' for the overall cohort only (fewer than two treatment arms were recorded, so no between-group comparison was performed)'}. Continuous variables are presented as mean ± SD or median [IQR] according to their distribution, and categorical variables as n (%).${r.grouped && t1Methods ? ` ${t1Methods}` : ''}

#### 1.2 Missing Data
No imputation was performed. Missing values are reported per variable in Table 1, and each analysis used participants with complete data for the variables it required (complete-case analysis).

${sourceSection}`)

    if (surv) {
      parts.push(`#### 1.4 Survival Analysis
Survival was estimated with the **Kaplan-Meier** method (Greenwood 95% confidence intervals; **Figure 2**).${timeUnitText}${r.grouped ? ' Survival distributions between treatment arms were compared with the two-sided log-rank test.' : ''}${r.survival.cox_generated ? ' An unadjusted (univariable) Cox proportional hazards model with treatment arm as the only covariate was fitted to estimate the hazard ratio (HR) and 95% CI (**Figure 3**). The proportional hazards assumption was not formally tested.' : ''}${evalue ? ' The VanderWeele E-value was computed for the unadjusted HR to quantify the minimum strength of unmeasured confounding needed to explain away the association.' : ''}`)
    }

    parts.push(`---

### 2. Results

#### 2.1 Participants
${r.n_subjects} participants were included${r.grouped ? `: ${armText}` : ''}.${r.arm_missing && r.arms.length ? ` ${r.arm_missing} participant(s) had no recorded treatment arm.` : ''}${r.enrollment.withdrawn ? ` ${r.enrollment.withdrawn} participant(s) were withdrawn from the study (reasons not recorded).` : ''}`)

    if (surv) {
      const excl: string[] = []
      if (r.survival.excluded_missing_time_or_status) excl.push(`${r.survival.excluded_missing_time_or_status} for missing follow-up time or outcome status`)
      if (r.survival.excluded_missing_arm) excl.push(`${r.survival.excluded_missing_arm} for missing treatment arm`)
      parts.push(`#### 2.2 Survival Outcomes
${r.survival.included} participants were included in the survival analysis${excl.length ? `; ${excl.join(' and ')} were excluded` : ''}. ${surv.narrative}`)
      if (evalue) {
        parts.push(`#### 2.3 Sensitivity to Unmeasured Confounding
For the unadjusted HR of ${evalue.estimate.toFixed(2)} (95% CI ${evalue.ci_lower.toFixed(2)}–${evalue.ci_upper.toFixed(2)}), the E-value was ${evalue.e_value_point.toFixed(2)} for the point estimate and ${evalue.e_value_ci.toFixed(2)} for the confidence limit closest to the null.`)
      }
    } else {
      parts.push(`#### 2.2 Survival Outcomes
No survival analysis was performed: ${r.survival.excluded_missing_time_or_status} of ${r.n_subjects} participants lacked follow-up time or outcome status.`)
    }

    parts.push(`---

### Analyses not performed
${r.omitted.map(o => `- ${o}`).join('\n')}
`)
    return parts.join('\n\n')
  }

  private generateStrobeChecklist(title: string, r: BundleDataReport): string {
    const todo = 'Author to complete'
    return `# STROBE Statement—Checklist of items for cohort studies
## Study: ${title}

The right-hand column states what this generated bundle covers. Items marked "${todo}" are not addressed by the bundle.

| Item No. | Item Description | Coverage in this bundle |
| :---: | :--- | :--- |
| **Title and Abstract** |
| 1a | Indicate the study's design with a commonly used term in the title or the abstract | ${todo} |
| 1b | Provide an informative and balanced summary of what was done and what was found | ${todo} |
| **Introduction** |
| 2 | Explain the scientific background and rationale for the investigation | ${todo} |
| 3 | State specific objectives, including any prespecified hypotheses | ${todo} |
| **Methods** |
| 4 | Present key elements of study design early in the paper | ${todo} |
| 5 | Describe the setting, locations, and relevant dates | ${todo} |
| 6a | Give the eligibility criteria, and the sources and methods of selection of participants | ${r.screening ? `Figure 1 (saved eligibility screening record: ${r.screening.assessed_total} assessed, ${r.screening.excluded_total} excluded); ${todo} (eligibility criteria text)` : `${todo} (screening records not available on the platform)`} |
| 7 | Clearly define all outcomes, exposures, predictors, potential confounders | ${todo} |
| 8 | For each variable of interest, give sources of data and details of methods of assessment | ${todo} |
| 9 | Describe any efforts to address potential sources of bias | ${todo} (no matching or weighting performed) |
| 10 | Explain how the study size was arrived at | ${todo} |
| 11 | Explain how quantitative variables were handled in the analyses | Methods 1.1, Table 1 |
| 12a | Describe all statistical methods, including those used to control for confounding | Methods 1.1, 1.3${r.survival.generated ? ', 1.4' : ''} (no confounder adjustment performed) |
| 12b | Describe any methods used to examine subgroups and interactions | ${todo} (not performed) |
| 12c | Explain how missing data were addressed | Methods 1.2 (complete-case, no imputation)${r.data_source === 'patients' ? ', 1.3 (unverified values treated as missing)' : ''} |
| 12e | Describe any sensitivity analyses | ${r.survival.cox_generated ? 'Methods 1.4 (E-value, unadjusted HR)' : `${todo} (not performed)`} |
| **Results** |
| 13a | Report numbers of individuals at each stage of study | ${r.screening ? 'Results 2.1, Figure 1 (including the saved screening stage)' : `Results 2.1, Figure 1 (${r.data_source === 'dataset' ? 'dataset rows only' : 'enrollment records only'}; screening stage missing)`} |
| 14a | Give characteristics of study participants and information on exposures | Table 1 |
| 15 | Report numbers of outcome events or summary measures over time | ${r.survival.generated ? 'Results 2.2, Figure 2' : `${todo} (outcome data not recorded)`} |
| 16a | Give unadjusted estimates and, if applicable, confounder-adjusted estimates | ${r.survival.cox_generated ? 'Results 2.2, Figure 3 (unadjusted only)' : `${todo}`} |
| 17 | Report other analyses done (e.g. subgroup, sensitivity) | ${r.survival.cox_generated ? 'Results 2.3' : todo} |
| **Discussion** |
| 18 | Summarize key results with reference to study objectives | ${todo} |
| 19 | Discuss limitations of the study, taking into account sources of potential bias | ${todo} |
| 20 | Give a cautious overall interpretation of results | ${todo} |
| 21 | Discuss the generalizability (external validity) of the study results | ${todo} |
| **Other Information** |
| 22 | Give the source of funding and the role of the funders | ${todo} |
`
  }

  private generateReproducibilityPythonScript(title: string, r: BundleDataReport): string {
    // 列名取自实际分析所用的列（数据集路径是用户数据集里的原始列名），不写死 followup_months / os_status / treatment_arm
    const fromDataset = r.data_source === 'dataset'
    const timeCol = r.columns.time
    const eventCol = r.columns.event
    const groupCol = fromDataset ? r.columns.group : 'treatment_arm'
    const py = (v: string) => JSON.stringify(v)
    const unitText = r.time_unit ?? 'unspecified unit'
    const header = `#!/usr/bin/env python3
"""
Statistical Reproducibility Script
Study: ${title.replace(/"""/g, '')}
Framework: Python 3.10+, lifelines, pandas

Usage: python Statistical_Reproducibility_Script.py analysis_dataset.csv
${fromDataset
  ? `The CSV must be the uploaded research dataset "${(r.dataset_name ?? '').replace(/"""/g, '')}" (values not verified on the platform).
Columns used: time = ${timeCol ?? '(none)'}, event = ${eventCol ?? '(none)'}, group = ${groupCol ?? '(none)'}`
  : `The CSV must be exported from the platform and contain the columns:
  subject_id, treatment_arm, age, sex, l3_smi, vat_to_sat, followup_months, os_status`}
Follow-up time unit: ${unitText}
Missing values must stay empty; this script does not impute.
"""

import sys
import pandas as pd
from lifelines import KaplanMeierFitter, CoxPHFitter
from lifelines.statistics import multivariate_logrank_test

if len(sys.argv) < 2:
    sys.exit("usage: python Statistical_Reproducibility_Script.py analysis_dataset.csv")

df = pd.read_csv(sys.argv[1])
print(f"Participants: {len(df)} (bundle reported ${r.n_subjects})")
print("Missing values per column:")
print(df.isna().sum())
`
    if (!timeCol || !eventCol) {
      return header + `
# No survival analysis was run for this bundle (no follow-up time / event columns were used).
`
    }
    const groupBlock = groupCol
      ? `GROUP = ${py(groupCol)}
arms = surv[GROUP].dropna().unique()
kmf = KaplanMeierFitter()
if len(arms) >= 2:
    surv = surv.dropna(subset=[GROUP])
    for arm in sorted(arms):
        sub = surv[surv[GROUP] == arm]
        kmf.fit(sub[TIME], sub[EVENT], label=str(arm))
        print(f"{arm}: n={len(sub)}, events={int(sub[EVENT].sum())}, median={kmf.median_survival_time_}")
    lr = multivariate_logrank_test(surv[TIME], surv[GROUP], surv[EVENT])
    print(f"Log-rank p-value: {lr.p_value:.4f}")
    if len(arms) == 2:
        ref = sorted(arms)[0]
        cox_df = pd.DataFrame({
            TIME: surv[TIME],
            EVENT: surv[EVENT],
            "arm": (surv[GROUP] != ref).astype(int),
        })
        cph = CoxPHFitter()
        cph.fit(cox_df, duration_col=TIME, event_col=EVENT)
        cph.print_summary()
else:
    kmf.fit(surv[TIME], surv[EVENT], label="Overall")
    print(f"Overall: n={len(surv)}, events={int(surv[EVENT].sum())}, median={kmf.median_survival_time_}")
`
      : `kmf = KaplanMeierFitter()
kmf.fit(surv[TIME], surv[EVENT], label="Overall")
print(f"Overall: n={len(surv)}, events={int(surv[EVENT].sum())}, median={kmf.median_survival_time_}")
`
    return header + `
TIME = ${py(timeCol)}  # follow-up time (${unitText})
EVENT = ${py(eventCol)}  # event indicator (1 = event, 0 = censored)${fromDataset ? '; recode text labels to 1/0 first if needed' : ''}

# Survival analysis: complete cases for follow-up time and outcome only
surv = df.dropna(subset=[TIME, EVENT])
print(f"Survival analysis: {len(surv)} included, {len(df) - len(surv)} excluded for missing time/status")
if surv.empty:
    sys.exit("No participants with both follow-up time and outcome status; nothing to analyse.")

${groupBlock}`
  }
}
