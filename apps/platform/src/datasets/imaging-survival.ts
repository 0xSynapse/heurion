/**
 * 影像生物标志物与临床生存分析端到端贯通套件 (Imaging Biomarker Survival Suite)
 * 
 * 面向放射科医生与肿瘤临床科研团队：
 * 将体成分指标（HU 阈值法测得的骨骼肌与脂肪面积、SMI） (L3 SMI / VAT / SAT) 及 IBSI 3D 影像组学特征 (Sphericity / Entropy)
 * 一键转换为生存分析模型，拟合 Kaplan-Meier 生存曲线并运行多变量 Cox 风险回归。
 */

import {
  generateSurvivalAnalysis,
  type SurvivalOptions,
  type SurvivalAnalysisResult
} from './survival.ts'
import { isCellMissing } from './table1.ts'

export interface ImagingSurvivalRequest {
  /** 随访生存时间列名（如 'os_months', 'pfs_months'） */
  time_col: string
  /** 结局事件状态列名（1=死亡/进展, 0=删失） */
  event_col: string
  /** 主要分层影像生物标志物（如 'smi', 'vat_to_sat', 'sphericity', 'volume_cm3', 'entropy'） */
  biomarker: 'smi' | 'vat_to_sat' | 'sphericity' | 'volume_cm3' | 'entropy' | string
  /** 切点分层策略：'consensus' (标准共识切点，如 Prado SMI), 'median' (中位数), 或指定数值 */
  cutoff_strategy?: 'consensus' | 'median' | number
  /** 患者性别列名（用于按性别分层共识切点，如 SMI 男性 52.4 / 女性 38.5） */
  sex_col?: string
  /** 多变量 Cox 回归临床协变量（如 ['age', 'sex', 'stage', 'chemo']） */
  covariates?: string[]
  /** 随访时间单位（默认 'Months'） */
  time_unit?: string
  /** 里程碑评估时间点（如 [12, 24, 36] 个月） */
  milestones?: number[]
  /** 图表自定义标题 */
  title?: string
}

export interface ImagingSurvivalResponse {
  biomarker: string
  cutoff_applied: number | string
  cutoff_strategy: string
  stratification_groups: {
    group_high: { name: string; sample_size: number }
    group_low: { name: string; sample_size: number }
  }
  survival_analysis: SurvivalAnalysisResult
  km_svg: string
  forest_plot_svg?: string
  publication_report_markdown: string
}

/**
 * 运行影像组学与体成分特征分层的端到端生存分析
 */
export function runImagingBiomarkerSurvival(
  dataset: Record<string, unknown>[],
  req: ImagingSurvivalRequest
): ImagingSurvivalResponse {
  if (!dataset || dataset.length === 0) {
    throw new Error('数据集为空，无法进行生存分析')
  }

  const {
    time_col,
    event_col,
    biomarker,
    cutoff_strategy = 'consensus',
    sex_col = 'sex',
    covariates = [],
    time_unit = 'Months',
    milestones = [12, 24, 36],
    title
  } = req

  // 1. 确定分层切点 Cutoff
  let cutoffVal: number
  let groupHighLabel = `高 ${biomarker}`
  let groupLowLabel = `低 ${biomarker}`

  const isFemale = (val: unknown): boolean => {
    if (val === null || val === undefined) return false
    const s = String(val).trim().toUpperCase()
    return s.startsWith('F') || s === '女' || s === '2' || s === 'FEMALE'
  }

  // C3 修复：严格过滤缺失或无效的生物标志物，杜绝将空值作为 0 归入低值组
  const validDataset = dataset.filter(r => {
    const raw = r[biomarker]
    if (isCellMissing(raw)) return false
    const num = Number(raw)
    return Number.isFinite(num)
  })

  const values = validDataset.map(r => Number(r[biomarker]))

  if (values.length === 0) {
    throw new Error(`在数据集中未找到有效的影像生物标志物列: ${biomarker}`)
  }

  values.sort((a, b) => a - b)
  const medianVal = values[Math.floor(values.length / 2)]!

  // SMI 共识切点是否实际按性别分组（至少有一行带性别值）
  const smiUsesSexSpecificCutoff =
    biomarker.toLowerCase().includes('smi') && validDataset.some(r => !isCellMissing(r[sex_col]))
  // 缺少性别的行按男性切点 52.4 分组，报告中需说明人数
  const smiMissingSexCount = biomarker.toLowerCase().includes('smi')
    ? validDataset.filter(r => isCellMissing(r[sex_col])).length
    : 0

  if (typeof cutoff_strategy === 'number') {
    cutoffVal = cutoff_strategy
    groupHighLabel = `${biomarker} ≥ ${cutoffVal}`
    groupLowLabel = `${biomarker} < ${cutoffVal}`
  } else if (cutoff_strategy === 'consensus') {
    if (biomarker.toLowerCase().includes('smi')) {
      // 文献切点（Prado / Martin：男性 52.4、女性 38.5 cm²/m²）；只做分组，不据此判定肌少症。
      // 实际分组按行内性别取切点（见下方 enrichedData），组标签须反映男女双切点；
      // 数据中完全没有性别信息时，所有人按男性切点 52.4 分组，标签如实写单一切点
      cutoffVal = 52.4
      if (smiUsesSexSpecificCutoff) {
        groupHighLabel = 'SMI ≥ 性别切点（男 52.4 / 女 38.5 cm²/m²）'
        groupLowLabel = 'SMI < 性别切点（男 52.4 / 女 38.5 cm²/m²）'
      } else {
        groupHighLabel = 'SMI ≥ 52.4 cm²/m²（无性别信息，统一按男性切点）'
        groupLowLabel = 'SMI < 52.4 cm²/m²（无性别信息，统一按男性切点）'
      }
    } else if (biomarker.toLowerCase().includes('vat_to_sat') || biomarker.toLowerCase().includes('ratio')) {
      // 内脏型肥胖切点 (VAT/SAT > 1.0)
      cutoffVal = 1.0
      groupHighLabel = '高内脏脂肪比 (VAT/SAT ≥ 1.0)'
      groupLowLabel = '正常脂肪分布 (VAT/SAT < 1.0)'
    } else {
      cutoffVal = medianVal
      groupHighLabel = `高 ${biomarker} (≥ ${cutoffVal.toFixed(2)})`
      groupLowLabel = `低 ${biomarker} (< ${cutoffVal.toFixed(2)})`
    }
  } else {
    // Median split
    cutoffVal = medianVal
    groupHighLabel = `高 ${biomarker} (≥ ${cutoffVal.toFixed(2)})`
    groupLowLabel = `低 ${biomarker} (< ${cutoffVal.toFixed(2)})`
  }

  // 2. 为每个样本构造分层标签列 `_strata_group`
  const enrichedData = validDataset.map(row => {
    const val = Number(row[biomarker])
    let isHigh = false

    if (biomarker.toLowerCase().includes('smi') && cutoff_strategy === 'consensus' && !isCellMissing(row[sex_col])) {
      const threshold = isFemale(row[sex_col]) ? 38.5 : 52.4
      isHigh = val >= threshold
    } else {
      isHigh = val >= cutoffVal
    }

    return {
      ...row,
      _strata_group: isHigh ? groupHighLabel : groupLowLabel,
      _biomarker_high: isHigh ? 1 : 0
    }
  })

  // 3. 执行核心生存分析
  const survivalOpts: SurvivalOptions = {
    time_col,
    event_col,
    group_col: '_strata_group',
    covariates: covariates.length > 0 ? ['_biomarker_high', ...covariates] : ['_biomarker_high'],
    time_unit,
    milestones,
    title: title || `基于 ${biomarker.toUpperCase()} 影像生物标志物分层的 Kaplan-Meier 生存分析`,
    labels: {
      _biomarker_high: `${biomarker} 风险分层`,
      _strata_group: '影像标志物分组',
      [groupHighLabel]: groupHighLabel,
      [groupLowLabel]: groupLowLabel
    }
  }

  const survResult = generateSurvivalAnalysis(enrichedData, survivalOpts)

  // 4. 提取医学出版级矢量 SVG
  const kmSvg = survResult.svg
  const forestSvg = survResult.forest_svg

  // 5. 撰写临床放射学专篇 Markdown 报告
  const totalEvents = survResult.groups.reduce((acc, g) => acc + g.events_n, 0)
  // 实际纳入 KM / log-rank 的人数：已剔除标志物缺失、生存时间或结局无效的行（不能用原始 dataset.length）
  const analyzedN = survResult.groups.reduce((acc, g) => acc + g.total_n, 0)
  const excludedN = dataset.length - analyzedN
  const baseReport = `${survResult.markdown_table}\n\n${survResult.narrative}`
  const isSmiConsensus = biomarker.toLowerCase().includes('smi') && cutoff_strategy === 'consensus'
  const consensusNote = isSmiConsensus
    ? (smiUsesSexSpecificCutoff
        ? ` (切点出处: Prado / Martin 文献, 男 52.4 / 女 38.5 cm²/m²${smiMissingSexCount > 0 ? `；${smiMissingSexCount} 例缺少性别，按男性切点分组` : ''}；分组不等于肌少症诊断)`
        : ' (切点出处: Prado / Martin 文献, 男 52.4 cm²/m²；数据无性别信息，全部按男性切点分组；分组不等于肌少症诊断)')
    : ''

  // 多因素 Cox：只有模型里除标志物外确实还有其他协变量时，才能说「校正」与「独立」
  const cox = survResult.cox
  const biomarkerCov = cox?.covariates.find(c => c.variable === '_biomarker_high')
  const otherCoxCovs = cox ? cox.covariates.filter(c => c.variable !== '_biomarker_high') : []
  const isMultivariable = otherCoxCovs.length > 0
  const logRankSig = !!survResult.log_rank && survResult.log_rank.p_value < 0.05

  let prognosticLine: string
  if (!survResult.log_rank) {
    prognosticLine = '未能形成两组比较，未进行 log-rank 检验。'
  } else if (logRankSig) {
    prognosticLine = isMultivariable && biomarkerCov && biomarkerCov.p_value < 0.05
      ? `**差异具有统计学显著性 (log-rank P < 0.05)**；在校正 ${otherCoxCovs.map(c => c.label).join('、')} 的多因素 Cox 模型中，该标志物仍与预后相关 (HR ${biomarkerCov.hr_formatted}, P = ${biomarkerCov.p_value_formatted})，可视为独立预后因素。`
      : '**差异具有统计学显著性 (log-rank P < 0.05)**，单因素分析中该影像指标与预后相关；尚无多因素模型支持其为独立预后因素。'
  } else {
    prognosticLine = '两组生存轨迹未呈现显著统计学差异 (P ≥ 0.05)，建议结合其他影像组学特征或扩大样本队列复算。'
  }

  let coxLine: string
  if (!cox) {
    coxLine = 'Cox 模型未能可靠拟合（事件数不足或不收敛），未报告 HR。'
  } else if (isMultivariable) {
    coxLine = `校正 ${otherCoxCovs.map(c => c.label).join('、')} 后，${biomarkerCov ? `标志物分层 HR 为 ${biomarkerCov.hr_formatted} (P = ${biomarkerCov.p_value_formatted})，` : ''}模型 Harrell's C-index 为 \`${cox.c_index}\`。`
  } else {
    coxLine = `仅含标志物分层的单因素 Cox 模型（未纳入其他临床协变量）：${biomarkerCov ? `HR ${biomarkerCov.hr_formatted} (P = ${biomarkerCov.p_value_formatted})，` : ''}Harrell's C-index 为 \`${cox.c_index}\`。`
  }

  const customReport = `## 影像生物标志物临床预后与生存分析报告 (Radiomics & Body Composition Prognostic Report)

- **评估标志物**: \`${biomarker}\` (分层策略: \`${cutoff_strategy}\`, 基准切点: \`${typeof cutoffVal === 'number' ? cutoffVal.toFixed(2) : cutoffVal}\`${consensusNote})
- **纳入分析**: \`${analyzedN}\` 例患者${excludedN > 0 ? `（原始 ${dataset.length} 行，剔除 ${excludedN} 行：标志物缺失或生存时间/结局无效）` : ''}，共发生 \`${totalEvents}\` 例终点结局事件
- **Log-Rank 显著性检验**: \`P = ${survResult.log_rank ? survResult.log_rank.p_value_formatted : 'N/A'}\`

---

${baseReport}

---

### 放射学与肿瘤学临床科研解读
1. **预后分层效能**: 在以 \`${biomarker}\` 划分的队列中，${prognosticLine}
2. **${isMultivariable ? '多变量' : '单变量'} Cox 回归**: ${coxLine}
`

  return {
    biomarker,
    cutoff_applied: cutoffVal,
    cutoff_strategy: String(cutoff_strategy),
    stratification_groups: {
      group_high: {
        name: groupHighLabel,
        sample_size: enrichedData.filter(r => r._strata_group === groupHighLabel).length
      },
      group_low: {
        name: groupLowLabel,
        sample_size: enrichedData.filter(r => r._strata_group === groupLowLabel).length
      }
    },
    survival_analysis: survResult,
    km_svg: kmSvg,
    forest_plot_svg: forestSvg,
    publication_report_markdown: customReport
  }
}
