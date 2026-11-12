/**
 * 临床科研顶刊级因果推断与混杂偏倚控制抗辩套件 (Advanced Causal Inference Suite)
 * 
 * 包含两大顶刊必备的统计学抗辩工具：
 * 1. Love Plot 协变量平衡散点图生成器 (Covariate Balance Plot / Absolute SMD)：
 *    直观展现倾向评分匹配 (PSM) 或逆概率加权 (IPTW) 前后，所有协变量向 SMD < 0.05 严格收敛过程；
 * 2. VanderWeele E-value 混杂偏倚敏感性分析计算器：
 *    依据 VanderWeele & Ding (Ann Intern Med 2017) 权威统计学公式计算未测量混杂因果敏感度，
 *    自动生成符合顶刊审稿回复要求的严密统计学论述。
 */

export interface CovariateBalanceItem {
  name: string
  label_zh?: string
  pre_smd?: number
  post_smd?: number
  smd_unadjusted?: number
  smd_adjusted?: number
}

export interface LovePlotConfig {
  title?: string
  smd_strict_threshold?: number // 默认 0.05
  smd_loose_threshold?: number  // 默认 0.10
  threshold?: number
  covariates: CovariateBalanceItem[]
}

export interface EValueInput {
  effect_type: 'HR' | 'OR' | 'RR'
  estimate: number       // 点估计值 (如 0.74)
  ci_lower: number      // 95% 置信区间下限 (如 0.65)
  ci_upper: number      // 95% 置信区间上限 (如 0.85)
  rare_outcome?: boolean // 结局是否为罕见事件 (用于 OR 转换为 RR 近似)
}

export interface EValueResult {
  effect_type: string
  estimate: number
  ci_lower: number
  ci_upper: number
  e_value_point: number
  e_value_ci: number
  academic_defense_zh: string
  academic_defense_en: string
}

/**
 * 计算 VanderWeele E-value 敏感度指标
 */
export function calculateEValue(input: EValueInput): EValueResult {
  let { effect_type, estimate, ci_lower, ci_upper, rare_outcome = true } = input

  if (estimate <= 0 || ci_lower <= 0 || ci_upper <= 0) {
    throw new Error('因果效应比值及置信区间上下限必须为大于 0 的正数')
  }

  // B10 修复：对非罕见结局 (rare_outcome === false) 的 OR，按 VanderWeele & Ding (2017) 标准公式转换为近似 RR
  let rr = estimate
  let rr_ci_bound = estimate < 1.0 ? ci_upper : ci_lower
  if (effect_type === 'OR' && !rare_outcome) {
    rr = Math.sqrt(estimate)
    rr_ci_bound = Math.sqrt(rr_ci_bound)
  }

  // Invert protective effect (< 1.0) to risk ratio > 1.0 for calculation
  const point_rr = rr < 1.0 ? 1.0 / rr : rr
  const ci_rr = rr < 1.0 ? 1.0 / rr_ci_bound : rr_ci_bound

  // Formula: E-value = RR + sqrt(RR * (RR - 1))
  const computeE = (val: number): number => {
    if (val <= 1.0) return 1.0
    return val + Math.sqrt(val * (val - 1.0))
  }

  const e_point = Math.round(computeE(point_rr) * 100) / 100
  const e_ci = ci_rr > 1.0 ? Math.round(computeE(ci_rr) * 100) / 100 : 1.0

  const isProtective = estimate < 1.0
  const crossesNull = (ci_lower <= 1.0 && ci_upper >= 1.0)
  const effectDescZh = isProtective ? '保护效应' : '风险/危害效应'
  const effectDescEn = isProtective ? 'protective effect' : 'risk association'

  const ciExplanationZh = crossesNull
    ? `由于 95% 置信区间跨越无效参考线 1.0（尚未达到统计学显著），置信区间对应的 E-value 保守下限为 1.00。`
    : `即便针对置信区间最保守边界，未测量混杂亦需达到 ${e_ci.toFixed(2)} 倍强度才足以推翻该统计学显著效应。`

  const ciExplanationEn = crossesNull
    ? `Because the 95% confidence interval crosses 1.0, the lower-bound E-value is 1.00.`
    : `Even for the conservative confidence interval limit, an unmeasured confounder must reach ${e_ci.toFixed(2)}-fold association to explain away the finding.`

  // 措辞只陈述 E-value 的含义，不替作者下「结论稳健」的判断；是否已校正由调用方的数据决定，这里不称「调整后」
  const rareNoteZh = effect_type === 'OR' && !rare_outcome ? '（结局非罕见，OR 已按平方根近似换算为 RR）' : ''
  const rareNoteEn = effect_type === 'OR' && !rare_outcome ? ' (the outcome was not rare, so the OR was approximated as an RR by square-root transformation)' : ''
  const closingZh = crossesNull
    ? '由于置信区间包含 1，观察到的关联本身未达统计学显著，E-value 不能用于支持关联稳健性的结论。'
    : '是否足以排除未测量混杂，需结合本领域已知混杂因素与暴露、结局之间的关联强度判断。'
  const closingEn = crossesNull
    ? 'Because the confidence interval includes 1, the observed association is not statistically significant and the E-value should not be used to argue for robustness.'
    : 'Whether this is sufficient to rule out unmeasured confounding should be judged against the strength of known confounders in this field.'

  const defense_zh = `观察到的 ${effect_type} = ${estimate.toFixed(2)} (95% CI: ${ci_lower.toFixed(2)} - ${ci_upper.toFixed(2)})${rareNoteZh}，` +
    `对应的 VanderWeele E-value 点估计为 ${e_point.toFixed(2)}，置信区间界限的 E-value 为 ${e_ci.toFixed(2)}。` +
    `即：一个未测量的混杂因素需要同时与暴露和结局有至少 ${e_point.toFixed(2)} 倍（风险比尺度）的关联，且独立于已纳入的协变量，` +
    `才足以将观察到的${effectDescZh}完全解释为混杂所致。${ciExplanationZh}${closingZh}`

  const defense_en = `The observed ${effect_type} was ${estimate.toFixed(2)} (95% CI: ${ci_lower.toFixed(2)}-${ci_upper.toFixed(2)})${rareNoteEn}. ` +
    `The E-value was ${e_point.toFixed(2)} for the point estimate and ${e_ci.toFixed(2)} for the confidence interval limit. ` +
    `An unmeasured confounder would need to be associated with both the exposure and the outcome by a risk ratio of at least ${e_point.toFixed(2)} each, ` +
    `above and beyond the measured covariates, to fully explain away the observed ${effectDescEn}. ` +
    `${ciExplanationEn} ${closingEn}`

  return {
    effect_type,
    estimate,
    ci_lower,
    ci_upper,
    e_value_point: e_point,
    e_value_ci: e_ci,
    academic_defense_zh: defense_zh,
    academic_defense_en: defense_en,
  }
}

/**
 * 生成符合顶刊规范的 Love Plot 协变量平衡散点图 (SVG 矢量图)
 */
export function generateLovePlotSvg(config: LovePlotConfig): string {
  const {
    title = 'Covariate Balance (Love Plot): Absolute Standardized Mean Differences',
    smd_strict_threshold = 0.05,
    smd_loose_threshold = config.threshold ?? 0.10,
    covariates: rawCovariates,
  } = config

  const covariates = rawCovariates.map(c => {
    const rawPre = typeof c.pre_smd === 'number' && Number.isFinite(c.pre_smd) ? c.pre_smd : Number(c.smd_unadjusted ?? 0)
    const rawPost = typeof c.post_smd === 'number' && Number.isFinite(c.post_smd) ? c.post_smd : Number(c.smd_adjusted ?? 0)
    return {
      name: String(c.name || 'Covariate'),
      label_zh: String(c.label_zh || c.name || 'Covariate'),
      pre_smd: Number(Math.abs(Number.isFinite(rawPre) ? rawPre : 0).toFixed(3)),
      post_smd: Number(Math.abs(Number.isFinite(rawPost) ? rawPost : 0).toFixed(3)),
    }
  })

  const width = 880
  const rowHeight = 30
  const marginTop = 85
  const marginBottom = 65
  const marginLeft = 280
  const marginRight = 60
  const plotWidth = width - marginLeft - marginRight
  const plotHeight = Math.max(1, covariates.length) * rowHeight
  const totalHeight = marginTop + plotHeight + marginBottom

  // Max SMD on X axis
  const maxSmd = Math.max(0.35, ...covariates.map(c => Math.max(c.pre_smd, c.post_smd))) * 1.15
  const scaleX = (smd: number) => marginLeft + (Math.min(smd, maxSmd) / maxSmd) * plotWidth

  const strictX = scaleX(smd_strict_threshold)
  const looseX = scaleX(smd_loose_threshold)

  // Build Grid lines and Ticks
  const ticks = [0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40].filter(t => t <= maxSmd)
  const tickElements = ticks.map(t => {
    const x = scaleX(t)
    return `
      <line x1="${x}" y1="${marginTop}" x2="${x}" y2="${marginTop + plotHeight}" stroke="#f1f5f9" stroke-width="1" />
      <line x1="${x}" y1="${marginTop + plotHeight}" x2="${x}" y2="${marginTop + plotHeight + 6}" stroke="#94a3b8" stroke-width="1.2" />
      <text x="${x}" y="${marginTop + plotHeight + 20}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="12" fill="#64748b">${t.toFixed(2)}</text>
    `
  }).join('')

  // Build rows
  const rowElements = covariates.map((cov, idx) => {
    const y = marginTop + idx * rowHeight + rowHeight / 2
    const preX = scaleX(cov.pre_smd)
    const postX = scaleX(cov.post_smd)
    const rowBg = idx % 2 === 0 ? `<rect x="30" y="${marginTop + idx * rowHeight}" width="${width - 60}" height="${rowHeight}" fill="#f8fafc" />` : ''
    const displayLabel = cov.label_zh && cov.label_zh !== cov.name ? `${cov.label_zh} (${cov.name})` : cov.name

    return `
      ${rowBg}
      <!-- Covariate Name -->
      <text x="${marginLeft - 16}" y="${y + 4}" text-anchor="end" font-family="Times New Roman, STSong, serif" font-size="13" fill="#1e293b">${escapeXml(displayLabel)}</text>
      <!-- Connecting line -->
      <line x1="${preX}" y1="${y}" x2="${postX}" y2="${y}" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="2,2" />
      <!-- Unmatched point (Red Circle) -->
      <circle cx="${preX}" cy="${y}" r="4.5" fill="#f43f5e" stroke="#be123c" stroke-width="1" />
      <!-- Matched point (Green Diamond) -->
      <polygon points="${postX},${y - 5.5} ${postX + 5.5},${y} ${postX},${y + 5.5} ${postX - 5.5},${y}" fill="#10b981" stroke="#047857" stroke-width="1" />
    `
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${totalHeight}" width="${width}" height="${totalHeight}">
  <rect width="100%" height="100%" fill="#ffffff" />

  <!-- Diagram Title Banner -->
  <text x="${width / 2}" y="36" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="18" font-weight="bold" fill="#0f172a">${escapeXml(title)}</text>
  <text x="${width / 2}" y="56" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="12" fill="#64748b">倾向评分匹配 (1:1 PSM) 与 IPTW 协变量均衡性诊断散点图</text>
  <line x1="40" y1="68" x2="${width - 40}" y2="68" stroke="#cbd5e1" stroke-width="1" />

  <!-- Legend -->
  <g transform="translate(${marginLeft + plotWidth - 260}, 44)">
    <circle cx="10" cy="0" r="4.5" fill="#f43f5e" stroke="#be123c" stroke-width="1" />
    <text x="22" y="4" font-family="Times New Roman, STSong, serif" font-size="12" fill="#334155">原始未匹配 (Unmatched)</text>
    <polygon points="170,-5.5 175.5,0 170,5.5 164.5,0" fill="#10b981" stroke="#047857" stroke-width="1" />
    <text x="182" y="4" font-family="Times New Roman, STSong, serif" font-size="12" fill="#334155">匹配后 (Matched / Balanced)</text>
  </g>

  <!-- Plot Canvas Background -->
  <rect x="${marginLeft}" y="${marginTop}" width="${plotWidth}" height="${plotHeight}" fill="#ffffff" stroke="#94a3b8" stroke-width="1.2" />

  <!-- Grid lines -->
  ${tickElements}

  <!-- Reference Threshold 0.10 Line (Traditional Imbalance Cutoff) -->
  <line x1="${looseX}" y1="${marginTop}" x2="${looseX}" y2="${marginTop + plotHeight}" stroke="#f59e0b" stroke-width="1.8" stroke-dasharray="4,3" />
  <text x="${looseX}" y="${marginTop - 6}" text-anchor="middle" font-family="Times New Roman, serif" font-size="11" font-weight="bold" fill="#d97706">SMD = 0.10 (常规平衡警戒线)</text>

  <!-- Reference Threshold 0.05 Line (Strict Balance Cutoff) -->
  <line x1="${strictX}" y1="${marginTop}" x2="${strictX}" y2="${marginTop + plotHeight}" stroke="#10b981" stroke-width="1.8" stroke-dasharray="4,3" />
  <text x="${strictX}" y="${marginTop - 6}" text-anchor="middle" font-family="Times New Roman, serif" font-size="11" font-weight="bold" fill="#059669">SMD = 0.05 (严格随机化线)</text>

  <!-- Data Rows -->
  ${rowElements}

  <!-- X Axis Label -->
  <text x="${marginLeft + plotWidth / 2}" y="${marginTop + plotHeight + 46}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="14" font-weight="bold" fill="#1e293b">绝对标准化均数差 (Absolute Standardized Mean Difference, Absolute SMD)</text>
</svg>`
}

/**
 * 导出 Love Plot 对应的 GraphPad Prism (.pzfx) 与 R (cobalt / ggplot2) 原生源文件
 */
export function exportLovePlotNativeSources(config: LovePlotConfig): {
  prism_pzfx: string
  r_script: string
} {
  const title = config.title ?? 'Covariate Balance (Love Plot)'
  const normCovs = config.covariates.map(c => {
    const rawPre = typeof c.pre_smd === 'number' && Number.isFinite(c.pre_smd) ? c.pre_smd : Number(c.smd_unadjusted ?? 0)
    const rawPost = typeof c.post_smd === 'number' && Number.isFinite(c.post_smd) ? c.post_smd : Number(c.smd_adjusted ?? 0)
    const name = String(c.name || 'Covariate')
    const label_zh = String(c.label_zh || name)
    return {
      name,
      label_zh,
      display: label_zh !== name ? `${label_zh} (${name})` : name,
      pre_smd: Number(Math.abs(Number.isFinite(rawPre) ? rawPre : 0).toFixed(3)),
      post_smd: Number(Math.abs(Number.isFinite(rawPost) ? rawPost : 0).toFixed(3)),
    }
  })
  const escR = (s: string) => s.replace(/([\\"])/g, '\\$1')
  const covRows = normCovs
    .map(c => `  data.frame(Covariate = "${escR(c.display)}", Pre_SMD = ${c.pre_smd}, Post_SMD = ${c.post_smd})`)
    .join(',\n')

  const r_script =
    `# Reproducible R Script (cobalt::love.plot / ggplot2 Love Plot)\n` +
    `library(ggplot2)\n` +
    `df <- rbind(\n${covRows}\n)\n` +
    `p <- ggplot(df) +\n` +
    `  geom_vline(xintercept = c(${config.smd_strict_threshold ?? 0.05}, ${config.smd_loose_threshold ?? config.threshold ?? 0.1}), linetype = "dashed", color = c("#10B981", "#F59E0B")) +\n` +
    `  geom_segment(aes(x = Pre_SMD, xend = Post_SMD, y = Covariate, yend = Covariate), linetype = "dotted", color = "#94A3B8") +\n` +
    `  geom_point(aes(x = Pre_SMD, y = Covariate), color = "#F43F5E", size = 3) +\n` +
    `  geom_point(aes(x = Post_SMD, y = Covariate), color = "#10B981", shape = 18, size = 3.5) +\n` +
    `  theme_bw(base_family = "Arial") + labs(title = "${escR(title)}", x = "Absolute Standardized Mean Difference (SMD)", y = "")\n` +
    `ggsave("Figure_Love_Plot.pdf", plot = p, width = 8, height = 5, dpi = 600)\n`

  const prism_pzfx =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<GraphPadPrismFile xmlns="http://graphpad.com/prism/Prism.htm" PrismXMLVersion="5.00">\n` +
    `  <TableSequence><Ref ID="Table0" Selected="1"/></TableSequence>\n` +
    `  <Table ID="Table0" XFormat="numbers" YFormat="replicates" Replicates="1" TableType="XY">\n` +
    `    <Title>${escapeXml(title)}</Title>\n` +
    `    <RowTitlesColumn Width="140"><Subcolumn>\n` +
    normCovs.map(c => `      <d>${escapeXml(c.display)}</d>`).join('\n') +
    `\n    </Subcolumn></RowTitlesColumn>\n` +
    `    <XColumn Width="89" Decimals="3" Subcolumns="1"><Title>Covariate Index</Title><Subcolumn>\n` +
    normCovs.map((_, i) => `      <d>${i + 1}</d>`).join('\n') +
    `\n    </Subcolumn></XColumn>\n` +
    `    <YColumn Width="100" Decimals="4" Subcolumns="1"><Title>Unmatched Pre-SMD</Title><Subcolumn>\n` +
    normCovs.map(c => `      <d>${c.pre_smd}</d>`).join('\n') +
    `\n    </Subcolumn></YColumn>\n` +
    `    <YColumn Width="100" Decimals="4" Subcolumns="1"><Title>Matched Post-SMD</Title><Subcolumn>\n` +
    normCovs.map(c => `      <d>${c.post_smd}</d>`).join('\n') +
    `\n    </Subcolumn></YColumn>\n` +
    `  </Table>\n` +
    `</GraphPadPrismFile>`

  return { prism_pzfx, r_script }
}

// ============================================================================
// 真实数据集驱动的倾向性评分 (PSM / IPTW)、协变量 SMD 平衡与因果效应估计引擎
// ============================================================================

export interface DatasetCausalAnalysisOptions {
  title?: string
  treatment_col: string
  outcome_col?: string
  covariates: string[]
  method?: 'iptw' | 'psm'
  labels?: Record<string, string>
}

export interface DatasetCausalAnalysisResult {
  sample_size: number
  treated_n: number
  control_n: number
  matched_pairs?: number
  /** 实际使用的方法（PSM 匹配对不足时会退回 IPTW，此时为 'iptw'） */
  method: 'iptw' | 'psm'
  /** 调用方请求的方法 */
  requested_method: 'iptw' | 'psm'
  /** 实际方法与请求不同时说明原因 */
  method_note?: string
  treatment_col: string
  outcome_col?: string
  covariates: Array<{
    name: string
    label_zh: string
    pre_smd: number
    post_smd: number
    smd_unadjusted: number
    smd_adjusted: number
  }>
  max_pre_smd: number
  max_post_smd: number
  balanced_count: number
  /** 未提供结局列或结局数据不足以估计时为 null（不返回示例效应量） */
  treatment_effect: {
    effect_type: 'OR' | 'RR'
    estimate: number
    ci_lower: number
    ci_upper: number
    unadjusted_estimate: number
    rare_outcome: boolean
  } | null
  /** treatment_effect 为 null 时同为 null */
  e_value: EValueResult | null
  /** treatment_effect 为 null 时说明原因 */
  effect_note?: string
  love_plot: {
    svg: string
    prism_pzfx: string
    r_script: string
  }
}

function parseBinaryGroup(
  records: Array<Record<string, unknown>>,
  col: string,
): { values: Array<0 | 1 | null>; treatedLabel: string; controlLabel: string } {
  const raw = records.map(r => r[col])
  const counts = new Map<string, number>()
  for (const v of raw) {
    if (v === null || v === undefined || v === '') continue
    const s = String(v).trim()
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  const distinct = [...counts.keys()]
  let treatedKey = '1'
  let controlKey = '0'
  if (distinct.length >= 2) {
    const posMatch = distinct.find(k => /^(1|true|yes|是|有|干预|实验|联合|治疗组|达格列净|靶向|高|阳性)$/i.test(k))
    const negMatch = distinct.find(k => /^(0|false|no|否|无|对照|常规|标准|安慰剂|低|阴性)$/i.test(k))
    if (posMatch && negMatch && posMatch !== negMatch) {
      treatedKey = posMatch
      controlKey = negMatch
    } else {
      const sorted = [...distinct].sort()
      controlKey = sorted[0]!
      treatedKey = sorted[1]!
    }
  }
  const values: Array<0 | 1 | null> = raw.map(v => {
    if (v === null || v === undefined || v === '') return null
    const s = String(v).trim()
    if (s === treatedKey) return 1
    if (s === controlKey) return 0
    const n = Number(s)
    if (Number.isFinite(n)) return n > 0 ? 1 : 0
    return 0
  })
  return { values, treatedLabel: treatedKey, controlLabel: controlKey }
}

function encodeCovariateNumeric(records: Array<Record<string, unknown>>, col: string): number[] {
  const raw = records.map(r => r[col])
  const nums: Array<number | null> = raw.map(v => {
    if (v === null || v === undefined || v === '') return null
    const n = typeof v === 'number' ? v : Number(String(v).trim())
    return Number.isFinite(n) ? n : null
  })
  const validNums = nums.filter((v): v is number => v !== null)
  if (validNums.length >= Math.max(2, Math.floor(records.length * 0.3))) {
    const mean = validNums.reduce((a, b) => a + b, 0) / validNums.length
    return nums.map(v => (v === null ? mean : v))
  }
  // Categorical string -> binary 0/1 indicator for the non-modal category
  const counts = new Map<string, number>()
  for (const v of raw) {
    const s = v === null || v === undefined ? '' : String(v).trim()
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])
  const target = sorted[1] ?? sorted[0] ?? '1'
  return raw.map(v => (String(v ?? '').trim() === target ? 1 : 0))
}

function computeWeightedSmd(x: number[], t: Array<0 | 1>, weights: number[]): { signed: number; abs: number } {
  let w1 = 0, w0 = 0, sum1 = 0, sum0 = 0
  for (let i = 0; i < x.length; i++) {
    const w = weights[i]!
    if (t[i] === 1) { w1 += w; sum1 += w * x[i]! }
    else { w0 += w; sum0 += w * x[i]! }
  }
  if (w1 <= 0 || w0 <= 0) return { signed: 0, abs: 0 }
  const m1 = sum1 / w1
  const m0 = sum0 / w0
  let v1 = 0, v0 = 0
  for (let i = 0; i < x.length; i++) {
    const w = weights[i]!
    if (t[i] === 1) v1 += w * (x[i]! - m1) * (x[i]! - m1)
    else v0 += w * (x[i]! - m0) * (x[i]! - m0)
  }
  v1 /= Math.max(1e-6, w1)
  v0 /= Math.max(1e-6, w0)
  const pooledSd = Math.sqrt(Math.max(1e-8, (v1 + v0) / 2))
  const smd = (m1 - m0) / pooledSd
  const bounded = Math.max(-2.5, Math.min(2.5, smd))
  return {
    signed: Number(bounded.toFixed(3)),
    abs: Number(Math.abs(bounded).toFixed(3)),
  }
}

/**
 * 从真实数据集计算倾向性评分 (Propensity Score)、匹配/加权前后 SMD 平衡表、调整后效应比值及 E-value
 */
export function analyzeDatasetCausalBalance(
  records: Array<Record<string, unknown>>,
  opts: DatasetCausalAnalysisOptions,
): DatasetCausalAnalysisResult {
  const covCols = (opts.covariates || []).map(c => c.trim()).filter(c => c && c !== opts.treatment_col && c !== opts.outcome_col)
  if (!covCols.length) {
    throw new Error('请至少选择 1 个需要平衡的基线混杂协变量 (covariates)')
  }
  const grp = parseBinaryGroup(records, opts.treatment_col)
  const validIdx: number[] = []
  const T: Array<0 | 1> = []
  for (let i = 0; i < records.length; i++) {
    const tv = grp.values[i]
    if (tv === 0 || tv === 1) {
      validIdx.push(i)
      T.push(tv)
    }
  }
  const n = validIdx.length
  const treatedN = T.filter(v => v === 1).length
  const controlN = n - treatedN
  if (n < 4 || treatedN === 0 || controlN === 0) {
    throw new Error(`暴露/分组列「${opts.treatment_col}」需同时包含实验组与对照组样本（当前有效样本 n=${n}，实验组=${treatedN}，对照组=${controlN}）`)
  }

  const fullCovVectors = covCols.map(c => encodeCovariateNumeric(records, c))
  const covVectors = fullCovVectors.map(vec => validIdx.map(idx => vec[idx]!))

  // Standardize covariates to fit Propensity Score P(T=1 | X) via IRLS
  const p = covCols.length
  const means = covVectors.map(v => v.reduce((a, b) => a + b, 0) / n)
  const sds = covVectors.map((v, j) => {
    const m = means[j]!
    const variance = v.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, n - 1)
    return Math.sqrt(Math.max(1e-6, variance))
  })
  const Z: number[][] = Array.from({ length: n }, (_, i) => [
    1,
    ...covVectors.map((v, j) => (v[i]! - means[j]!) / sds[j]!),
  ])

  let beta = new Array<number>(p + 1).fill(0)
  const pTreat = treatedN / n
  beta[0] = Math.log(Math.max(0.05, Math.min(0.95, pTreat)) / (1 - Math.max(0.05, Math.min(0.95, pTreat))))

  for (let iter = 0; iter < 15; iter++) {
    const grad = new Array<number>(p + 1).fill(0)
    const H: number[][] = Array.from({ length: p + 1 }, () => new Array<number>(p + 1).fill(0))
    for (let i = 0; i < n; i++) {
      let eta = 0
      for (let j = 0; j <= p; j++) eta += Z[i]![j]! * beta[j]!
      eta = Math.max(-12, Math.min(12, eta))
      const ps = 1 / (1 + Math.exp(-eta))
      const w = Math.max(1e-4, ps * (1 - ps))
      const err = T[i]! - ps
      for (let j = 0; j <= p; j++) {
        grad[j]! += Z[i]![j]! * err
        for (let k = j; k <= p; k++) H[j]![k]! += w * Z[i]![j]! * Z[i]![k]!
      }
    }
    for (let j = 0; j <= p; j++) {
      for (let k = j + 1; k <= p; k++) H[k]![j] = H[j]![k]!
      H[j]![j]! += j === 0 ? 1e-5 : 0.1
      if (j > 0) grad[j]! -= 0.1 * beta[j]!
    }
    // Simple Gauss-Jordan step
    const aug = H.map((row, r) => [...row, grad[r]!])
    for (let col = 0; col <= p; col++) {
      let piv = col
      for (let r = col + 1; r <= p; r++) {
        if (Math.abs(aug[r]![col]!) > Math.abs(aug[piv]![col]!)) piv = r
      }
      const tmp = aug[col]!; aug[col] = aug[piv]!; aug[piv] = tmp
      const d = aug[col]![col]!
      if (Math.abs(d) < 1e-9) continue
      for (let k = col; k <= p + 1; k++) aug[col]![k]! /= d
      for (let r = 0; r <= p; r++) {
        if (r === col) continue
        const f = aug[r]![col]!
        for (let k = col; k <= p + 1; k++) aug[r]![k]! -= f * aug[col]![k]!
      }
    }
    for (let j = 0; j <= p; j++) {
      const step = aug[j]![p + 1]!
      if (Number.isFinite(step)) beta[j]! += step
    }
  }

  const psList = Z.map(zi => {
    let eta = 0
    for (let j = 0; j <= p; j++) eta += zi[j]! * beta[j]!
    return Math.max(0.03, Math.min(0.97, 1 / (1 + Math.exp(-eta))))
  })

  const requestedMethod = opts.method ?? 'iptw'
  // 实际使用的方法：PSM 匹配对不足时退回 IPTW，返回值必须如实反映
  let method: 'iptw' | 'psm' = requestedMethod
  let methodNote: string | undefined
  const unitWeights = new Array<number>(n).fill(1)
  let adjWeights = new Array<number>(n).fill(1)
  let matchedPairs: number | undefined

  if (requestedMethod === 'psm') {
    // 1:1 Nearest-Neighbor Propensity Score Matching
    const treatedIndices = T.map((t, idx) => (t === 1 ? idx : -1)).filter(idx => idx >= 0)
    const controlIndices = T.map((t, idx) => (t === 0 ? idx : -1)).filter(idx => idx >= 0)
    const usedControls = new Set<number>()
    adjWeights = new Array<number>(n).fill(0)
    let pairs = 0
    for (const ti of treatedIndices) {
      let bestCi = -1
      let bestDist = Infinity
      for (const ci of controlIndices) {
        if (usedControls.has(ci)) continue
        const dist = Math.abs(psList[ti]! - psList[ci]!)
        if (dist < bestDist) { bestDist = dist; bestCi = ci }
      }
      if (bestCi >= 0 && bestDist <= 0.25) {
        usedControls.add(bestCi)
        adjWeights[ti] = 1
        adjWeights[bestCi] = 1
        pairs++
      }
    }
    matchedPairs = pairs
    if (pairs < 2) {
      // 卡钳匹配得到的匹配对不足 2 对：改用稳定化 IPTW，并在返回的 method / method_note 中如实说明
      method = 'iptw'
      methodNote = `请求倾向性评分匹配 (PSM)，但 1:1 最近邻卡钳匹配（卡钳 0.25）仅得到 ${pairs} 对，少于 2 对；已改用稳定化逆概率加权 (IPTW)，平衡诊断与效应量均基于 IPTW。`
      adjWeights = T.map((t, i) => {
        const w = t === 1 ? pTreat / psList[i]! : (1 - pTreat) / (1 - psList[i]!)
        return Math.max(0.15, Math.min(6.0, w))
      })
    }
  } else {
    // Stabilized IPTW weights
    adjWeights = T.map((t, i) => {
      const w = t === 1 ? pTreat / psList[i]! : (1 - pTreat) / (1 - psList[i]!)
      return Math.max(0.15, Math.min(6.0, w))
    })
  }

  const covariates = covCols.map((col, j) => {
    const pre = computeWeightedSmd(covVectors[j]!, T, unitWeights)
    const post = computeWeightedSmd(covVectors[j]!, T, adjWeights)
    const label_zh = opts.labels?.[col] || col
    return {
      name: col,
      label_zh,
      pre_smd: pre.abs,
      post_smd: post.abs,
      smd_unadjusted: pre.signed,
      smd_adjusted: post.signed,
    }
  })

  // 仅在提供结局列且两组都有结局数据时估计效应量；否则 treatment_effect / e_value 为 null，不返回示例数值
  let treatmentEffect: DatasetCausalAnalysisResult['treatment_effect'] = null
  let eValue: EValueResult | null = null
  let effectNote: string | undefined = opts.outcome_col ? undefined : '未提供结局列，未估计处理效应与 E-value'

  if (opts.outcome_col) {
    const outGrp = parseBinaryGroup(records, opts.outcome_col)
    const Y = validIdx.map(idx => outGrp.values[idx])
    let a = 0, b = 0, c = 0, d = 0
    let wa = 0, wb = 0, wc = 0, wd = 0
    let validOut = 0, eventsOut = 0
    for (let i = 0; i < n; i++) {
      const y = Y[i]
      if (y !== 0 && y !== 1) continue
      validOut++
      if (y === 1) eventsOut++
      const w = adjWeights[i]! > 0 ? adjWeights[i]! : 0
      if (T[i] === 1 && y === 1) { a += 1; wa += w }
      else if (T[i] === 1 && y === 0) { b += 1; wb += w }
      else if (T[i] === 0 && y === 1) { c += 1; wc += w }
      else { d += 1; wd += w }
    }
    const treatedOut = a + b
    const controlOut = c + d
    if (validOut < 10 || eventsOut === 0 || eventsOut === validOut || treatedOut === 0 || controlOut === 0) {
      effectNote = `结局列「${opts.outcome_col}」的有效数据不足以估计效应（有效 n=${validOut}，事件 ${eventsOut}，处理组 ${treatedOut}，对照组 ${controlOut}）`
    } else {
      // 仅当存在 0 格时做 Haldane 0.5 连续性校正（结果中如实标注）
      const zeroCell = [a, b, c, d].some(v => v === 0) || [wa, wb, wc, wd].some(v => v <= 0)
      if (zeroCell) {
        a += 0.5; b += 0.5; c += 0.5; d += 0.5
        wa += 0.5; wb += 0.5; wc += 0.5; wd += 0.5
        effectNote = '存在 0 计数格，已做 Haldane 0.5 连续性校正'
      }
      const rareOutcome = eventsOut / validOut < 0.15
      // 按 3 位有效数字保留（toFixed(2) 会把 < 0.005 的界限舍成 0）
      const sig3 = (v: number) => Number(v.toPrecision(3))
      const unadjOr = sig3((a * d) / (b * c))
      const adjOrRaw = (wa * wd) / (wb * wc)
      const seLogOr = Math.sqrt(1 / wa + 1 / wb + 1 / wc + 1 / wd)
      const adjOr = sig3(adjOrRaw)
      const ciLow = sig3(adjOrRaw * Math.exp(-1.96 * seLogOr))
      const ciHigh = sig3(adjOrRaw * Math.exp(1.96 * seLogOr))
      treatmentEffect = {
        effect_type: 'OR',
        estimate: adjOr,
        ci_lower: ciLow,
        ci_upper: ciHigh,
        unadjusted_estimate: unadjOr,
        rare_outcome: rareOutcome,
      }
      eValue = calculateEValue({
        effect_type: 'OR',
        estimate: adjOr,
        ci_lower: ciLow,
        ci_upper: ciHigh,
        rare_outcome: rareOutcome,
      })
    }
  }

  const loveConfig: LovePlotConfig = {
    title: opts.title || 'Covariate Balance (Love Plot)',
    covariates,
  }
  const svg = generateLovePlotSvg(loveConfig)
  const native = exportLovePlotNativeSources(loveConfig)

  return {
    sample_size: n,
    treated_n: treatedN,
    control_n: controlN,
    matched_pairs: matchedPairs,
    method,
    requested_method: requestedMethod,
    ...(methodNote ? { method_note: methodNote } : {}),
    treatment_col: opts.treatment_col,
    outcome_col: opts.outcome_col,
    covariates,
    max_pre_smd: Number(Math.max(0, ...covariates.map(c => c.pre_smd)).toFixed(3)),
    max_post_smd: Number(Math.max(0, ...covariates.map(c => c.post_smd)).toFixed(3)),
    balanced_count: covariates.filter(c => c.post_smd < 0.1).length,
    treatment_effect: treatmentEffect,
    e_value: eValue,
    ...(effectNote ? { effect_note: effectNote } : {}),
    love_plot: {
      svg,
      prism_pzfx: native.prism_pzfx,
      r_script: native.r_script,
    },
  }
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case '\'': return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}
