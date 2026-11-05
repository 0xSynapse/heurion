/**
 * Auto-eCRF 多模态影像与临床指标批量提取与溯源引擎
 * 
 * 赋能临床科研课题组：
 * 1. 结构化 eCRF 字典定义：涵盖人口学、随访生存终点、3D 影像生物标志物（RECIST/L3 SMI/VAT/BAR/HAM）、关键实验室生化指标；
 * 2. 批量异步巡航提取：一键调度 MONAI 计算节点与患者全景病历库，自动填报受试者数据宽表；
 * 3. 证据溯源审计 (Click-to-Audit Trail)：每个单元格附带客观置信度、来源记录 ID、切片层号及采样时间戳，确保数据 100% 可回溯；
 * 4. 一键沉淀为防篡改研究快照数据集，无缝直通 Table 1、CONSORT、Love Plot 与 KM 生存分析。
 */

import { SOURCE_LABELS } from './subject-vars.ts'
import type { DatasetService, DatasetView } from '../datasets/service.ts'
import type { Actor, PatientService } from '../tenancy/patients.ts'
import { parseCustomVars, StudyError, type StudyService } from './service.ts'

export type EcrfVariableCategory = 'demographics' | 'imaging' | 'lab' | 'survival' | 'custom'

export interface EcrfVariableDefinition {
  id: string
  name_zh: string
  name_en: string
  category: EcrfVariableCategory
  unit: string
  description: string
  default_checked: boolean
}

export interface EcrfCellAudit {
  value: number | string | null
  formatted: string
  confidence: number
  source_type: 'imaging' | 'lab' | 'demographics' | 'clinical'
  source_record_id?: string
  source_slice_index?: number
  source_exam_date?: string
  source_detail?: string
  verified?: boolean
  extracted_at: string
}

export interface EcrfSubjectRow {
  subject_id: string
  patient_id: string
  variables: Record<string, EcrfCellAudit>
}

export interface EcrfExtractResult {
  study_id: string
  total_subjects: number
  extracted_variables: EcrfVariableDefinition[]
  rows: EcrfSubjectRow[]
  summary: {
    total_cells: number
    extracted_cells: number
    missing_cells: number
    avg_confidence: number
  }
  dataset_wide_preview: Array<Record<string, unknown>>
}

/** 预置临床科研高频多模态 eCRF 字典清单 */
export const DEFAULT_ECRF_DICTIONARY: EcrfVariableDefinition[] = [
  // 1. 人口学与基线
  { id: 'age', name_zh: '年龄', name_en: 'Age', category: 'demographics', unit: '岁', description: '入组时患者实际周岁年龄', default_checked: true },
  { id: 'sex', name_zh: '性别', name_en: 'Sex', category: 'demographics', unit: '', description: '生理性别 (男/女)', default_checked: true },
  
  // 2. 随访与生存结局 (Survival Endpoints)
  { id: 'followup_months', name_zh: '总随访时间', name_en: 'Followup Time', category: 'survival', unit: '月', description: '自基线首诊至最后随访或终点事件时间 (OS Months)', default_checked: true },
  { id: 'os_status', name_zh: '全因死亡/终点事件', name_en: 'OS Status', category: 'survival', unit: '', description: '主要终点事件状态 (1=发生事件, 0=未发生/删失)', default_checked: true },
  { id: 'pfs_months', name_zh: '无进展生存期', name_en: 'PFS Months', category: 'survival', unit: '月', description: '自入组至肿瘤进展或因病死亡时间', default_checked: false },
  { id: 'treatment_arm', name_zh: '治疗方案分组', name_en: 'Treatment Arm', category: 'demographics', unit: '', description: '临床干预组 (1=试验药/联合治疗, 0=标准对照)', default_checked: true },

  // 3. 影像测值（取自影像分析记录）
  { id: 'recist_longest_diam_mm', name_zh: 'RECIST 靶病灶长径', name_en: 'RECIST SOD Long Diameter', category: 'imaging', unit: 'mm', description: '基线靶病灶最大单径线 (mm)', default_checked: true },
  { id: 'tumor_volume_cm3', name_zh: '病灶立体三维容积', name_en: 'Tumor 3D Volume', category: 'imaging', unit: 'cm³', description: 'MONAI 3D 深度网络体素分割总容积', default_checked: true },
  { id: 'l3_smi', name_zh: 'L3 骨骼肌质量指数 (SMI)', name_en: 'L3 Skeletal Muscle Index', category: 'imaging', unit: 'cm²/m²', description: 'L3 层面骨骼肌面积 / 身高²（需身高）', default_checked: true },
  { id: 'vat_to_sat_ratio', name_zh: '内脏/皮下脂肪比 (VAT/SAT)', name_en: 'VAT/SAT Ratio', category: 'imaging', unit: '', description: '腹型肥胖与心血管代谢风险比值 (阈值 1.0)', default_checked: true },
  { id: 'vat_cm2', name_zh: '内脏脂肪面积 (VAT)', name_en: 'Visceral Adipose Tissue Area', category: 'imaging', unit: 'cm²', description: 'L3 断面腹腔深层脂肪面积', default_checked: false },
  { id: 'bar_ratio', name_zh: '支气管-伴行动脉径比 (BAR)', name_en: 'Broncho-Arterial Ratio', category: 'imaging', unit: '', description: '印戒征确诊指标 (正常 ≤1.0, >1.1 提示扩张)', default_checked: true },
  { id: 'ham_volume_cm3', name_zh: '高密度粘液栓容积 (HAM)', name_en: 'High-Attenuation Mucus Volume', category: 'imaging', unit: 'cm³', description: 'CT 值高于阈值的管腔粘液栓总体积', default_checked: false },

  // 4. 协同实验室生化指标 (Lab Tests)
  { id: 'nt_pro_bnp', name_zh: '血清 NT-proBNP', name_en: 'Serum NT-proBNP', category: 'lab', unit: 'pg/mL', description: '心功能衰竭关键诊断指标', default_checked: true },
  { id: 'egfr', name_zh: '估算肾小球滤过率 (eGFR)', name_en: 'Estimated GFR', category: 'lab', unit: 'mL/min/1.73m²', description: 'CKD-EPI 公式计算之肾功能水平', default_checked: true },
  { id: 'creatinine', name_zh: '血肌酐 (Scr)', name_en: 'Serum Creatinine', category: 'lab', unit: 'µmol/L', description: '肾功能核心生化指标', default_checked: true },
  { id: 'hba1c', name_zh: '糖化血红蛋白 (HbA1c)', name_en: 'HbA1c', category: 'lab', unit: '%', description: '近 8-12 周平均血糖控制水平', default_checked: true },
  { id: 'albumin', name_zh: '血清白蛋白 (ALB)', name_en: 'Serum Albumin', category: 'lab', unit: 'g/L', description: '营养状态与肝脏合成功能指标', default_checked: false },
  { id: 'hemoglobin', name_zh: '血红蛋白 (Hb)', name_en: 'Hemoglobin', category: 'lab', unit: 'g/L', description: '贫血与携氧状态评估指标', default_checked: false },
  { id: 'cea', name_zh: '癌胚抗原 (CEA)', name_en: 'Carcinoembryonic Antigen', category: 'lab', unit: 'ng/mL', description: '肺癌与消化道肿瘤高灵敏度标志物', default_checked: false },
  { id: 'ige_total', name_zh: '血清总 IgE', name_en: 'Total Serum IgE', category: 'lab', unit: 'IU/mL', description: '变应性支气管肺曲霉病核心确诊指标', default_checked: false },
  { id: 'eosinophil_count', name_zh: '嗜酸粒细胞绝对计数', name_en: 'Eosinophil Count', category: 'lab', unit: '10^9/L', description: '外周血嗜酸粒细胞炎症水平', default_checked: false },
]

const LAB_SYNONYMS: Record<string, string[]> = {
  nt_pro_bnp: ['nt_pro_bnp', 'ntprobnp', 'nt-probnp', '脑钠肽', '氨基末端脑钠肽前体'],
  egfr: ['egfr', '估算肾小球滤过率', '肾小球滤过率'],
  creatinine: ['creatinine', 'scr', 'cr', '肌酐', '血肌酐'],
  hba1c: ['hba1c', '糖化血红蛋白', '糖化'],
  albumin: ['albumin', 'alb', '白蛋白', '血清白蛋白'],
  hemoglobin: ['hemoglobin', 'hgb', 'hb', '血红蛋白'],
  cea: ['cea', '癌胚抗原'],
  ige_total: ['ige_total', 'ige', '总ige', '血清总ige'],
  eosinophil_count: ['eosinophil_count', 'eos', '嗜酸粒细胞', '嗜酸性粒细胞'],
}

export class EcrfService {
  constructor(
    private readonly studies: StudyService,
    private readonly patients: PatientService,
    private readonly datasets?: DatasetService | null
  ) {}

  /** 获取可用 eCRF 字典变量模版（若传入 studyId 则合并本研究自定义扩展变量） */
  getTemplate(a?: Actor, studyId?: string): { categories: string[]; variables: EcrfVariableDefinition[] } {
    const vars = [...DEFAULT_ECRF_DICTIONARY]
    if (a && studyId) {
      try {
        const st = this.studies.get(a.userId, studyId, 'read')
        const customVars = parseCustomVars(st.custom_vars)
        const seen = new Set(vars.map(v => v.id))
        for (const cv of customVars) {
          if (seen.has(cv.key)) continue
          seen.add(cv.key)
          vars.push({
            id: cv.key,
            name_zh: cv.label,
            name_en: cv.key,
            category: 'custom',
            unit: cv.unit || '',
            description: `本研究自定义扩展变量 (${cv.kind})`,
            default_checked: true,
          })
        }
      } catch {}
    }
    return {
      categories: ['demographics', 'survival', 'imaging', 'lab', 'custom'],
      variables: vars,
    }
  }

  /**
   * 将提取出的 eCRF 数据保存为研究数据集
   */
  async saveDataset(
    a: Actor,
    studyId: string,
    input: { variable_ids?: string[]; name?: string }
  ): Promise<{ dataset: DatasetView; summary: EcrfExtractResult['summary'] }> {
    const study = this.studies.get(a.userId, studyId, 'write')
    if (!this.datasets) throw new StudyError('unavailable', '数据集服务未启用')

    const extracted = await this.extractCohortEcrf(a, studyId, input.variable_ids)
    if (!extracted.dataset_wide_preview.length) {
      throw new StudyError('empty_cohort', '没有可保存的受试者 eCRF 数据')
    }

    const cols = ['subject_id', ...extracted.extracted_variables.map(v => v.id)]
    const csvHeader = cols.join(',')
    const csvRows = extracted.dataset_wide_preview.map(row =>
      cols.map(col => {
        const val = row[col]
        if (val === null || val === undefined) return ''
        const s = String(val)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }).join(',')
    )
    const csvContent = [csvHeader, ...csvRows].join('\n') + '\n'
    const name = (input.name || `${study.title} · Auto-eCRF多模态宽表`).slice(0, 100)
    const labels: Record<string, string> = {
      subject_id: '受试者研究编号',
      ...Object.fromEntries(extracted.extracted_variables.map(v => [v.id, `${v.name_zh}${v.unit ? ` (${v.unit})` : ''}`]))
    }

    const origin = {
      kind: 'cohort',
      study_id: studyId,
      shape: 'wide',
      is_ecrf: true,
      extracted_at: new Date().toISOString(),
      trusted_columns: cols,
    }

    const { dataset } = this.datasets.upload(
      a.userId,
      `ecrf-${Date.now()}.csv`,
      Buffer.from(csvContent, 'utf8'),
      { name, origin: origin as never }
    )

    await this.datasets.idle()
    const done = this.datasets.get(a.userId, dataset.id)
    if (done.status === 'failed') {
      this.datasets.remove(a.userId, dataset.id)
      throw new StudyError('dataset_failed', `保存 eCRF 数据集失败: ${done.error ?? '未知错误'}`)
    }
    this.datasets.update(a.userId, dataset.id, { labels })
    try {
      this.studies.link(a.userId, studyId, { kind: 'dataset', ref_id: dataset.id })
    } catch (err) {
      if (!(err instanceof StudyError && err.code === 'in_other_study')) throw err
    }

    return {
      dataset: this.datasets.get(a.userId, dataset.id),
      summary: extracted.summary,
    }
  }

  /**
   * 为指定研究执行 Auto-eCRF 多模态批量特征提取与溯源构建
   * 当 opts.sync_to_vars 为 true 时，自动将提取出的非空实测值（含切片层号与检验单溯源）写入受试者研究变量表 (subject_vars)，
   * 已核实 (verified) 的变量不会被覆盖。
   */
  async extractCohortEcrf(
    a: Actor,
    studyId: string,
    requestedVariableIds?: string[],
    opts?: { sync_to_vars?: boolean }
  ): Promise<EcrfExtractResult & { synced_vars_count?: number }> {
    const study = this.studies.get(a.userId, studyId, 'write')
    const allVars = this.getTemplate(a, studyId).variables

    // 1. 过滤需要回填的变量字段
    const targetVars = requestedVariableIds && requestedVariableIds.length > 0
      ? allVars.filter(v => requestedVariableIds.includes(v.id))
      : allVars.filter(v => v.default_checked)

    // 2. 提取入组受试者快照
    const snap = this.patients.cohortSnapshot(a, studyId, { log: true })
    const nowIso = new Date().toISOString()
    const subjects = snap.subjects

    const rows: EcrfSubjectRow[] = []
    const datasetWideRows: Array<Record<string, unknown>> = []
    let totalCells = 0
    let extractedCells = 0
    let confSum = 0

    // B4 修复：彻底移除写死数值的 benchmarkKnowledge 与合成伪造保底，未录入字段如实返回 null
    for (let idx = 0; idx < subjects.length; idx++) {
      const s = subjects[idx]!
      const subId = s.subject_id
      const rowAudit: Record<string, EcrfCellAudit> = {}
      const wideRow: Record<string, unknown> = { subject_id: subId }

      for (const v of targetVars) {
        totalCells++
        let cellAudit: EcrfCellAudit
        const existingVar = s.vars?.[v.id]

        if (v.id === 'age') {
          const val = s.age_at_enroll ?? null
          cellAudit = {
            value: val,
            formatted: val !== null ? `${val} 岁` : '—',
            confidence: val !== null ? 0.99 : 0.0,
            source_type: 'demographics',
            source_detail: val !== null ? '来源：患者主档案（出生年份）' : '患者主档案缺出生年份',
            verified: true,
            extracted_at: nowIso,
          }
        } else if (v.id === 'sex') {
          const val = s.sex === 'M' || s.sex === '男' ? '男' : s.sex === 'F' || s.sex === '女' ? '女' : null
          cellAudit = {
            value: val,
            formatted: val || '—',
            confidence: val !== null ? 0.99 : 0.0,
            source_type: 'demographics',
            source_detail: val !== null ? '来源：患者主档案' : '患者主档案缺性别',
            verified: true,
            extracted_at: nowIso,
          }
        } else if (existingVar && existingVar.status === 'verified') {
          // 研究者已 SDV 核实锁定的变量具有最高优先级
          cellAudit = {
            value: existingVar.value,
            formatted: `${existingVar.value}${v.unit ? ` ${v.unit}` : ''}`.trim(),
            confidence: 1.0,
            source_type: existingVar.source === 'imaging_analysis' ? 'imaging' : 'clinical',
            source_record_id: typeof existingVar.source_ref?.record_id === 'string' ? existingVar.source_ref.record_id : undefined,
            source_slice_index: typeof existingVar.source_ref?.slice_index === 'number' ? existingVar.source_ref.slice_index : undefined,
            source_exam_date: typeof existingVar.source_ref?.exam_date === 'string' ? existingVar.source_ref.exam_date : undefined,
            source_detail: `${SOURCE_LABELS[existingVar.source] ?? existingVar.source} · 研究者已 SDV 核实锁定`,
            verified: true,
            extracted_at: existingVar.verified_at || nowIso,
          }
        } else if (v.category === 'lab') {
          // 从实测化验中匹配真实数据（支持中英文同义词、标准键名与标准单位换算值；优先取最新送检记录）
          const aliases = LAB_SYNONYMS[v.id] ?? [v.id.toLowerCase(), v.id.replace(/_/g, '').toLowerCase(), v.name_zh.toLowerCase()]
          const matchedLabs = s.labs.filter(l => {
            const tk = l.test_key.toLowerCase()
            const tn = l.test_name.toLowerCase()
            return aliases.some(al => tk === al || tn === al || tk.includes(al) || tn.includes(al))
          }).sort((a, b) => String(b.collected_on || '').localeCompare(String(a.collected_on || '')))
          const foundLab = matchedLabs[0]
          const numVal = foundLab ? (foundLab.std_value ?? foundLab.value_num) : null
          const unitStr = foundLab ? (foundLab.std_unit || foundLab.unit || v.unit) : v.unit
          if (foundLab && numVal !== null) {
            cellAudit = {
              value: numVal,
              formatted: `${numVal} ${unitStr}`.trim(),
              confidence: existingVar?.status === 'verified' ? 1.0 : 0.98,
              source_type: 'lab',
              source_record_id: foundLab.record_id || undefined,
              source_exam_date: foundLab.collected_on || undefined,
              source_detail: `生化检验原件: ${foundLab.test_name}${foundLab.collected_on ? ` (${foundLab.collected_on})` : ''}`,
              verified: existingVar?.status === 'verified',
              extracted_at: nowIso,
            }
          } else if (existingVar) {
            cellAudit = {
              value: existingVar.value,
              formatted: `${existingVar.value} ${v.unit}`.trim(),
              confidence: existingVar.status === 'verified' ? 1.0 : 0.85,
              source_type: 'lab',
              source_detail: `${SOURCE_LABELS[existingVar.source] ?? existingVar.source} · ${existingVar.status === 'verified' ? '已核实' : '待核实'}`,
              verified: existingVar.status === 'verified',
              extracted_at: nowIso,
            }
          } else {
            cellAudit = {
              value: null,
              formatted: '—',
              confidence: 0.0,
              source_type: 'lab',
              source_detail: '未检出对应实验室送检记录',
              verified: false,
              extracted_at: nowIso,
            }
          }
        } else if (v.category === 'imaging') {
          // 只取真实影像量化记录里的值；没有记录就是缺失，不做任何估算回填
          const metricsOf = (ir: { payload: Record<string, unknown> }) => ((ir.payload?.metrics as Record<string, unknown>) || ir.payload || {})
          const hasValue = (x: unknown) => x !== null && x !== undefined && String(x).trim() !== ''
          const foundImg = s.imaging?.find(ir => hasValue(metricsOf(ir)[v.id]))
          if (foundImg) {
            const m = metricsOf(foundImg)
            const val = m[v.id] as number | string
            const rawSlice = m.key_slice_index ?? m.slice_index
            const slice = typeof rawSlice === 'number' && Number.isFinite(rawSlice) ? rawSlice : undefined
            cellAudit = {
              value: val,
              formatted: `${val} ${v.unit}`.trim(),
              confidence: 0.98,
              source_type: 'imaging',
              source_record_id: foundImg.id,
              source_exam_date: foundImg.report_date || undefined,
              source_slice_index: slice,
              source_detail: 'MONAI 3D 影像量化分析记录',
              verified: false,
              extracted_at: nowIso,
            }
          } else if (existingVar) {
            cellAudit = {
              value: existingVar.value,
              formatted: `${existingVar.value} ${v.unit}`.trim(),
              confidence: existingVar.status === 'verified' ? 1.0 : 0.85,
              source_type: 'imaging',
              source_detail: `${SOURCE_LABELS[existingVar.source] ?? existingVar.source} · ${existingVar.status === 'verified' ? '已核实' : '待核实'}`,
              verified: existingVar.status === 'verified',
              extracted_at: nowIso,
            }
          } else {
            cellAudit = {
              value: null,
              formatted: '—',
              confidence: 0.0,
              source_type: 'imaging',
              source_detail: '未找到对应的影像量化记录',
              verified: false,
              extracted_at: nowIso,
            }
          }
        } else if (existingVar) {
          // 研究变量（分组、随访、结局）：取自研究变量登记，标明来源与核实状态
          cellAudit = {
            value: existingVar.value,
            formatted: `${existingVar.value}${v.unit ? ` ${v.unit}` : ''}`,
            confidence: existingVar.status === 'verified' ? 1 : 0.75,
            source_type: 'clinical',
            source_detail: `${SOURCE_LABELS[existingVar.source] ?? existingVar.source} · ${existingVar.status === 'verified' ? '已核实' : '未核实'}`,
            verified: existingVar.status === 'verified',
            extracted_at: nowIso,
          }
        } else {
          // 生存结局与治疗分组：没有研究变量登记时如实返回缺失
          cellAudit = {
            value: null,
            formatted: '—',
            confidence: 0.0,
            source_type: 'clinical',
            source_detail: '未登记该研究变量，可在下方溯源卡或「研究变量」中直接录入并核实',
            verified: false,
            extracted_at: nowIso,
          }
        }

        if (cellAudit.value !== null) {
          extractedCells++
          confSum += cellAudit.confidence
        }
        rowAudit[v.id] = cellAudit
        wideRow[v.id] = cellAudit.value
      }

      rows.push({
        subject_id: subId,
        patient_id: `P-${subId}`,
        variables: rowAudit,
      })
      datasetWideRows.push(wideRow)
    }

    let syncedVarsCount = 0
    if (opts?.sync_to_vars) {
      syncedVarsCount = this.persistExtractedCellsToSubjectVars(a, studyId, study.custom_vars, targetVars, rows)
    }

    return {
      study_id: studyId,
      total_subjects: subjects.length,
      extracted_variables: targetVars,
      rows,
      summary: {
        total_cells: totalCells,
        extracted_cells: extractedCells,
        missing_cells: totalCells - extractedCells,
        avg_confidence: extractedCells > 0 ? Number((confSum / extractedCells).toFixed(3)) : 0,
      },
      dataset_wide_preview: datasetWideRows,
      ...(opts?.sync_to_vars ? { synced_vars_count: syncedVarsCount } : {}),
    }
  }

  /**
   * 将 Auto-eCRF 提取出的非空单元格同步写入受试者研究变量表 (subject_vars)，保留完整切片层号与检验单溯源；
   * 若存在尚未在课题 custom_vars 注册的扩展指标（如生化检验或扩展影像指标），自动注册到 study.custom_vars。
   */
  private persistExtractedCellsToSubjectVars(
    a: Actor,
    studyId: string,
    customVarsRaw: string | null | undefined,
    vars: EcrfVariableDefinition[],
    rows: EcrfSubjectRow[],
  ): number {
    const builtinIds = new Set(['age', 'sex', 'treatment_arm', 'followup_months', 'os_status', 'pfs_months', 'pfs_status', 'l3_smi', 'vat_to_sat'])
    const curCustom = parseCustomVars(customVarsRaw)
    const customSet = new Set(curCustom.map(c => c.key))
    let customAdded = false

    for (const v of vars) {
      if (v.id === 'age' || v.id === 'sex') continue
      const mappedId = v.id === 'vat_to_sat_ratio' ? 'vat_to_sat' : v.id
      if (!builtinIds.has(mappedId) && !customSet.has(mappedId)) {
        curCustom.push({
          id: mappedId,
          key: mappedId,
          label: v.name_zh,
          group: v.category === 'imaging' ? 'imaging' : 'custom',
          kind: 'continuous',
          type: 'continuous',
          unit: v.unit || undefined,
        })
        customSet.add(mappedId)
        customAdded = true
      }
    }
    if (customAdded) {
      this.studies.update(a.userId, studyId, { custom_vars: curCustom })
    }

    const toWrite: Array<{
      subject_id: string
      var_id: string
      value: number | string | null
      source: 'ecrf_manual' | 'imaging_analysis'
      source_ref?: Record<string, unknown>
      method?: string
    }> = []

    for (const r of rows) {
      for (const v of vars) {
        if (v.id === 'age' || v.id === 'sex') continue
        const cell = r.variables[v.id]
        if (!cell || cell.value === null || cell.verified) continue
        const varId = v.id === 'vat_to_sat_ratio' ? 'vat_to_sat' : v.id
        const source = cell.source_type === 'imaging' && (varId === 'l3_smi' || varId === 'vat_to_sat')
          ? 'imaging_analysis'
          : 'ecrf_manual'
        toWrite.push({
          subject_id: r.subject_id,
          var_id: varId,
          value: cell.value,
          source,
          method: cell.source_type === 'imaging' ? 'MONAI_3D_Auto_eCRF' : 'Auto_eCRF',
          source_ref: {
            entered_via: 'auto_ecrf',
            record_id: cell.source_record_id ?? null,
            slice_index: cell.source_slice_index ?? null,
            exam_date: cell.source_exam_date ?? null,
            confidence: cell.confidence,
            detail: cell.source_detail ?? null,
          },
        })
      }
    }

    if (!toWrite.length) return 0
    const res = this.patients.setSubjectVars(a, studyId, toWrite)
    return res.written
  }

  /**
   * 在 Auto-eCRF 溯源审计卡片内直接手工修正单元格数值并（可选）执行研究者 SDV 核实锁定
   */
  verifyCell(
    a: Actor,
    studyId: string,
    input: {
      subject_id: string
      var_id: string
      value?: number | string | null
      verify?: boolean
      source_slice_index?: number
      source_detail?: string
    },
  ) {
    const study = this.studies.get(a.userId, studyId, 'write')
    const subId = String(input.subject_id || '').trim()
    const rawVarId = String(input.var_id || '').trim()
    if (!subId || !rawVarId) throw new StudyError('bad_request', '必须指定受试者编号 (subject_id) 与变量代号 (var_id)')

    const varId = rawVarId === 'vat_to_sat_ratio' ? 'vat_to_sat' : rawVarId
    const builtinIds = new Set(['treatment_arm', 'followup_months', 'os_status', 'pfs_months', 'pfs_status', 'l3_smi', 'vat_to_sat', 'nodule_type', 'nodule_mean_diameter_mm', 'nodule_volume_mm3', 'nodule_solid_core_mm', 'nodule_vdt_days'])
    const curCustom = parseCustomVars(study.custom_vars)
    if (!builtinIds.has(varId) && !curCustom.some(c => c.key === varId)) {
      const tmplVar = this.getTemplate(a, studyId).variables.find(v => v.id === rawVarId || v.id === varId)
      curCustom.push({
        id: varId,
        key: varId,
        label: tmplVar?.name_zh || varId,
        group: 'custom',
        kind: typeof input.value === 'number' || (typeof input.value === 'string' && input.value.trim() !== '' && Number.isFinite(Number(input.value))) ? 'continuous' : 'text',
        unit: tmplVar?.unit || undefined,
      })
      this.studies.update(a.userId, studyId, { custom_vars: curCustom })
    }

    if (input.value !== undefined) {
      const rawStr = input.value === null ? '' : String(input.value).trim()
      const parsedVal = rawStr === '' ? null : Number.isFinite(Number(rawStr)) ? Number(rawStr) : rawStr
      const src = varId === 'l3_smi' || varId === 'vat_to_sat' ? 'imaging_analysis' : 'ecrf_manual'
      this.patients.setSubjectVars(a, studyId, [{
        subject_id: subId,
        var_id: varId,
        value: parsedVal,
        source: src,
        method: 'eCRF_Audit_Card',
        source_ref: {
          entered_via: a.via,
          slice_index: input.source_slice_index ?? null,
          detail: input.source_detail ?? '研究者于 Auto-eCRF 溯源卡核验录入',
        },
      }])
    }

    let verifiedCount = 0
    if (input.verify !== false && a.via !== 'ai') {
      const vRes = this.patients.verifySubjectVars(a, studyId, [{ subject_id: subId, var_id: varId }])
      verifiedCount = vRes.verified
    }

    return {
      ok: true,
      subject_id: subId,
      var_id: rawVarId,
      verified: verifiedCount > 0,
    }
  }
}
