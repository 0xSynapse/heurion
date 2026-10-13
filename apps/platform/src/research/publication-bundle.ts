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

import { strToU8, zipSync } from 'fflate'
import { renderEnrollmentFlowSvg } from './consort.ts'
import { calculateEValue, type EValueResult } from './causal-inference.ts'
import { generateSurvivalAnalysis, normalizeEventStatus, type SurvivalAnalysisResult } from '../datasets/survival.ts'
import { exportTable1ToDocx } from '../datasets/table1-docx.ts'
import { generateTable1FromData, type Table1Result } from '../datasets/table1.ts'
import { StudyError, type StudyService } from './service.ts'
import type { PatientService, SubjectVar } from '../tenancy/patients.ts'
import { SOURCE_LABELS, STUDY_VARS } from './subject-vars.ts'
import type { DatasetService } from '../datasets/service.ts'
import type { Actor } from '../tenancy/patients.ts'

export interface PublicationBundleOptions {
  include_code?: boolean
  time_col?: string
  event_col?: string
  group_col?: string
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
function verifiedValue(s: SnapshotSubject, id: BundleVarId): number | string | null {
  const v = s.vars?.[id]
  return v && v.status === 'verified' ? v.value : null
}

/** 把入组快照里的受试者转成材料包记录：年龄 / 性别来自患者主档案，其余只取已核实的研究变量 */
export function toBundleRecords(subjects: SnapshotSubject[]): BundleRecord[] {
  return subjects.map(s => {
    const num = (id: BundleVarId) => { const v = verifiedValue(s, id); return typeof v === 'number' ? v : v === null ? null : (Number.isFinite(Number(v)) ? Number(v) : null) }
    const arm = verifiedValue(s, 'treatment_arm')
    const os = verifiedValue(s, 'os_status')
    return {
      subject_id: String(s.subject_id),
      treatment_arm: arm === null ? null : String(arm),
      age: s.age_at_enroll ?? null,
      sex: normalizeSex(s.sex),
      l3_smi: num('l3_smi'),
      vat_to_sat: num('vat_to_sat'),
      followup_months: num('followup_months'),
      os_status: os === null ? null : normalizeEventStatus(os),
    }
  })
}

/** 统计每个研究变量的来源与核实状态 */
export function varProvenance(subjects: SnapshotSubject[]): VarProvenance[] {
  return BUNDLE_VARS.map(id => {
    const vs = subjects.map(s => s.vars?.[id]).filter((v): v is SubjectVar => !!v)
    const verified = vs.filter(v => v.status === 'verified').length
    return {
      var_id: id,
      label: STUDY_VARS.find(d => d.id === id)?.label ?? id,
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

    // 1. 入组快照：只用真实受试者
    const snap = this.patients.cohortSnapshot(a, studyId, { log: true })
    if (snap.subjects.length === 0) {
      throw new StudyError(
        'empty_cohort',
        snap.skipped.length > 0
          ? `研究中的 ${snap.skipped.length} 名受试者你都没有访问权限，无法生成投稿材料包`
          : '研究还没有入组受试者，无法生成投稿材料包。请先完成入组。',
        400,
      )
    }
    const records = toBundleRecords(snap.subjects)
    const provenance = varProvenance(snap.subjects)
    const n = records.length

    // 缺失数：未核实的值按缺失计（没有进入分析）
    const missing: Record<string, number> = {}
    for (const k of ['treatment_arm', 'age', 'sex', 'l3_smi', 'vat_to_sat', 'followup_months', 'os_status'] as const) {
      missing[k] = records.filter(r => r[k] === null).length
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
    const table1Result: Table1Result = generateTable1FromData(records, {
      group_col: grouped ? 'treatment_arm' : undefined,
      // 没有任何已核实值的研究变量不进 Table 1（原因写在 README 与正文）
      columns: ['age', 'sex', ...(['l3_smi', 'vat_to_sat', 'followup_months'] as const).filter(k => provenance.find(p => p.var_id === k)!.verified > 0)],
      continuous_vars: ['age', 'l3_smi', 'vat_to_sat', 'followup_months'],
      categorical_vars: ['sex'],
      show_missing: true,
      labels: {
        age: '年龄 (岁)',
        sex: '生理性别',
        l3_smi: 'L3 骨骼肌质量指数 SMI (cm²/m²)',
        vat_to_sat: '内脏/皮下脂肪比 (VAT/SAT)',
        followup_months: '总随访时间 (月)',
      },
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

    // 4. 受试者流向图：只用平台入组记录（在组 / 已移出 / 无权限未导出）
    const roster = this.patients.enrollments(a, studyId).subjects
    const withdrawn = roster.filter(s => s.status === 'withdrawn').length
    const inaccessible = snap.skipped.length
    const enrolledEver = n + inaccessible + withdrawn
    const flowSvg = renderEnrollmentFlowSvg({
      title: `${study.title} · Participant Flow`,
      enrolled_ever: enrolledEver,
      withdrawn,
      inaccessible,
      analyzed: n,
      arms: grouped || arms.length === 1 ? arms : [],
      unassigned: arms.length > 0 ? armMissing : 0,
      note: '平台未记录筛选人数与排除原因，因此未绘制 Assessed / Excluded 环节；请作者按原始纳排记录补充。',
    })
    omitted.push('CONSORT 筛选 / 排除环节（平台没有纳排筛选记录）')

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
    }

    // 8. 正文、清单、脚本、清单文件
    const manuscriptMd = this.generateManuscriptDraft(study.title, report, table1Result, survRes, evalue)
    const strobeMd = this.generateStrobeChecklist(study.title, report)
    const reproPy = this.generateReproducibilityPythonScript(study.title, report)

    const zipMap: Record<string, Uint8Array> = {
      'Table1_Baseline_Characteristics.docx': table1Docx,
      'Figure1_Participant_Flow.svg': strToU8(flowSvg),
    }
    if (survRes) zipMap['Figure2_Kaplan_Meier_Survival_Curve.svg'] = strToU8(survRes.svg)
    if (survRes && coxOk && survRes.forest_svg) zipMap['Figure3_Cox_Forest_Plot.svg'] = strToU8(survRes.forest_svg)
    zipMap['Manuscript_Statistical_Methods_and_Results.md'] = strToU8(manuscriptMd)
    zipMap['STROBE_Statement_Checklist.md'] = strToU8(strobeMd)
    zipMap['Statistical_Reproducibility_Script.py'] = strToU8(reproPy)
    zipMap['README_Submission_Manifest.txt'] = strToU8(this.generateManifest(study.title, study.design, nowStr, report, Object.keys(zipMap)))

    const zipBuffer = zipSync(zipMap)
    const filename = `SCI_Submission_Bundle_${studyId}_${nowStr}.zip`
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
 - Missing values by variable (unverified values count as missing):
${miss}

VARIABLE PROVENANCE (only researcher-verified values are used):
${r.provenance.map(p => ` - ${p.var_id} (${p.label}): source ${p.sources.join(' / ') || 'none'}; ${p.verified} verified, ${p.unverified_excluded} unverified (not used), ${p.missing} / ${r.n_subjects} without a usable value${p.methods.length ? `; method: ${p.methods.join(' | ')}` : ''}`).join('\n')}
 - age, sex: 来源：患者主档案 (patient registry: birth year / sex on the patient record); not part of the verification workflow
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
    const parts: string[] = []
    parts.push(`# Statistical Methods & Results Section Draft
## Study: ${title}

> Draft generated from the data recorded on the platform. Every statement below describes an analysis that was actually run; please verify and extend before submission.

### 1. Statistical Analysis Methods

#### 1.1 Study Population and Baseline Characteristics
Participant flow is shown in **Figure 1**, based on the platform's enrollment records only; screening counts and exclusion reasons were not recorded on the platform and must be supplied by the authors. Baseline characteristics are summarized in **Table 1**${r.grouped ? ` by treatment arm` : ' for the overall cohort only (fewer than two treatment arms were recorded, so no between-group comparison was performed)'}. Continuous variables are presented as mean ± SD or median [IQR] according to their distribution, and categorical variables as n (%).${r.grouped && t1Methods ? ` ${t1Methods}` : ''}

#### 1.2 Missing Data
No imputation was performed. Missing values are reported per variable in Table 1, and each analysis used participants with complete data for the variables it required (complete-case analysis).

#### 1.3 Variable Sources and Verification
Only values verified by the study investigators were analysed; unverified values were treated as missing. Age and sex were taken from the patient registry (来源：患者主档案) and are not part of the verification workflow.

| Variable | Source | Verified | Unverified (not used) | Without usable value | Method |
| :--- | :--- | :---: | :---: | :---: | :--- |
${r.provenance.map(p => `| ${p.var_id} | ${p.sources.join(' / ') || '—'} | ${p.verified} | ${p.unverified_excluded} | ${p.missing} / ${r.n_subjects} | ${p.methods.join('; ') || '—'} |`).join('\n')}`)

    if (surv) {
      parts.push(`#### 1.4 Survival Analysis
Survival was estimated with the **Kaplan-Meier** method (Greenwood 95% confidence intervals; **Figure 2**).${r.grouped ? ' Survival distributions between treatment arms were compared with the two-sided log-rank test.' : ''}${r.survival.cox_generated ? ' An unadjusted (univariable) Cox proportional hazards model with treatment arm as the only covariate was fitted to estimate the hazard ratio (HR) and 95% CI (**Figure 3**). The proportional hazards assumption was not formally tested.' : ''}${evalue ? ' The VanderWeele E-value was computed for the unadjusted HR to quantify the minimum strength of unmeasured confounding needed to explain away the association.' : ''}`)
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
| 6a | Give the eligibility criteria, and the sources and methods of selection of participants | ${todo} (screening records not available on the platform) |
| 7 | Clearly define all outcomes, exposures, predictors, potential confounders | ${todo} |
| 8 | For each variable of interest, give sources of data and details of methods of assessment | ${todo} |
| 9 | Describe any efforts to address potential sources of bias | ${todo} (no matching or weighting performed) |
| 10 | Explain how the study size was arrived at | ${todo} |
| 11 | Explain how quantitative variables were handled in the analyses | Methods 1.1, Table 1 |
| 12a | Describe all statistical methods, including those used to control for confounding | Methods 1.1, 1.3${r.survival.generated ? ', 1.4' : ''} (no confounder adjustment performed) |
| 12b | Describe any methods used to examine subgroups and interactions | ${todo} (not performed) |
| 12c | Explain how missing data were addressed | Methods 1.2 (complete-case, no imputation), 1.3 (unverified values treated as missing) |
| 12e | Describe any sensitivity analyses | ${r.survival.cox_generated ? 'Methods 1.4 (E-value, unadjusted HR)' : `${todo} (not performed)`} |
| **Results** |
| 13a | Report numbers of individuals at each stage of study | Results 2.1, Figure 1 (enrollment records only; screening stage missing) |
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
    return `#!/usr/bin/env python3
"""
Statistical Reproducibility Script
Study: ${title.replace(/"""/g, '')}
Framework: Python 3.10+, lifelines, pandas

Usage: python Statistical_Reproducibility_Script.py analysis_dataset.csv
The CSV must be exported from the platform and contain the columns:
  subject_id, treatment_arm, age, sex, l3_smi, vat_to_sat, followup_months, os_status
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

# Survival analysis: complete cases for follow-up time and outcome only
surv = df.dropna(subset=["followup_months", "os_status"])
print(f"Survival analysis: {len(surv)} included, {len(df) - len(surv)} excluded for missing time/status")
if surv.empty:
    sys.exit("No participants with both follow-up time and outcome status; nothing to analyse.")

arms = surv["treatment_arm"].dropna().unique()
kmf = KaplanMeierFitter()
if len(arms) >= 2:
    surv = surv.dropna(subset=["treatment_arm"])
    for arm in sorted(arms):
        sub = surv[surv["treatment_arm"] == arm]
        kmf.fit(sub["followup_months"], sub["os_status"], label=str(arm))
        print(f"{arm}: n={len(sub)}, events={int(sub['os_status'].sum())}, median={kmf.median_survival_time_}")
    lr = multivariate_logrank_test(surv["followup_months"], surv["treatment_arm"], surv["os_status"])
    print(f"Log-rank p-value: {lr.p_value:.4f}")
    if len(arms) == 2:
        ref = sorted(arms)[0]
        cox_df = pd.DataFrame({
            "followup_months": surv["followup_months"],
            "os_status": surv["os_status"],
            "arm": (surv["treatment_arm"] != ref).astype(int),
        })
        cph = CoxPHFitter()
        cph.fit(cox_df, duration_col="followup_months", event_col="os_status")
        cph.print_summary()
else:
    kmf.fit(surv["followup_months"], surv["os_status"], label="Overall")
    print(f"Overall: n={len(surv)}, events={int(surv['os_status'].sum())}, median={kmf.median_survival_time_}")
`
  }
}
