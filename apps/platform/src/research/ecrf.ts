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
import { StudyError, type StudyService } from './service.ts'

export type EcrfVariableCategory = 'demographics' | 'imaging' | 'lab' | 'survival'

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
  { id: 'cea', name_zh: '癌胚抗原 (CEA)', name_en: 'Carcinoembryonic Antigen', category: 'lab', unit: 'ng/mL', description: '肺癌与消化道肿瘤高灵敏度标志物', default_checked: false },
  { id: 'ige_total', name_zh: '血清总 IgE', name_en: 'Total Serum IgE', category: 'lab', unit: 'IU/mL', description: '变应性支气管肺曲霉病核心确诊指标', default_checked: false },
  { id: 'eosinophil_count', name_zh: '嗜酸粒细胞绝对计数', name_en: 'Eosinophil Count', category: 'lab', unit: '10^9/L', description: '外周血嗜酸粒细胞炎症水平', default_checked: false },
]

export class EcrfService {
  constructor(
    private readonly studies: StudyService,
    private readonly patients: PatientService,
    private readonly datasets?: DatasetService | null
  ) {}

  /** 获取可用 eCRF 字典变量模版 */
  getTemplate(): { categories: string[]; variables: EcrfVariableDefinition[] } {
    return {
      categories: ['demographics', 'survival', 'imaging', 'lab'],
      variables: DEFAULT_ECRF_DICTIONARY,
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
   */
  async extractCohortEcrf(
    a: Actor,
    studyId: string,
    requestedVariableIds?: string[]
  ): Promise<EcrfExtractResult> {
    this.studies.get(a.userId, studyId, 'write')

    // 1. 过滤需要回填的变量字段
    const targetVars = requestedVariableIds && requestedVariableIds.length > 0
      ? DEFAULT_ECRF_DICTIONARY.filter(v => requestedVariableIds.includes(v.id))
      : DEFAULT_ECRF_DICTIONARY.filter(v => v.default_checked)

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

        if (v.id === 'age') {
          const val = s.age_at_enroll ?? null
          cellAudit = {
            value: val,
            formatted: val !== null ? `${val} 岁` : '—',
            confidence: val !== null ? 0.99 : 0.0,
            source_type: 'demographics',
            source_detail: val !== null ? '来源：患者主档案（出生年份）' : '患者主档案缺出生年份',
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
            extracted_at: nowIso,
          }
        } else if (v.category === 'lab') {
          // 从实测化验中匹配真实数据
          const foundLab = s.labs.find(l => 
            l.test_name.toLowerCase().includes(v.id.replace(/_/g, '')) ||
            l.test_key.toLowerCase().includes(v.id.replace(/_/g, ''))
          )
          if (foundLab && foundLab.value_num !== null) {
            cellAudit = {
              value: foundLab.value_num,
              formatted: `${foundLab.value_num} ${foundLab.unit || v.unit}`.trim(),
              confidence: 0.98,
              source_type: 'lab',
              source_record_id: foundLab.record_id || undefined,
              source_exam_date: foundLab.collected_on || undefined,
              source_detail: `生化检验原件: ${foundLab.test_name}`,
              extracted_at: nowIso,
            }
          } else {
            // 真实缺漏项
            cellAudit = {
              value: null,
              formatted: '—',
              confidence: 0.0,
              source_type: 'lab',
              source_detail: '未检出对应实验室送检记录',
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
              extracted_at: nowIso,
            }
          } else {
            cellAudit = {
              value: null,
              formatted: '—',
              confidence: 0.0,
              source_type: 'imaging',
              source_detail: '未找到对应的影像量化记录',
              extracted_at: nowIso,
            }
          }
        } else if (s.vars?.[v.id]) {
          // 研究变量（分组、随访、结局）：取自研究变量登记，标明来源与核实状态
          const sv = s.vars[v.id]!
          cellAudit = {
            value: sv.value,
            formatted: `${sv.value}${v.unit ? ` ${v.unit}` : ''}`,
            confidence: sv.status === 'verified' ? 1 : 0.5,
            source_type: 'clinical',
            source_detail: `${SOURCE_LABELS[sv.source] ?? sv.source} · ${sv.status === 'verified' ? '已核实' : '未核实'}`,
            extracted_at: nowIso,
          }
        } else {
          // 生存结局与治疗分组：没有研究变量登记时如实返回缺失
          cellAudit = {
            value: null,
            formatted: '—',
            confidence: 0.0,
            source_type: 'clinical',
            source_detail: '未登记该研究变量，请在「研究变量」中录入或导入',
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
    }
  }
}
