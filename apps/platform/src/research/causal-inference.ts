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
  label_zh: string
  pre_smd: number
  post_smd: number
}

export interface LovePlotConfig {
  title?: string
  smd_strict_threshold?: number // 默认 0.05
  smd_loose_threshold?: number  // 默认 0.10
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

  const defense_zh = `本研究测得调整后 ${effect_type} = ${estimate.toFixed(2)} (95% CI: ${ci_lower.toFixed(2)} - ${ci_upper.toFixed(2)})，` +
    `计算对应的 VanderWeele E-value 点估计为 ${e_point.toFixed(2)}（置信区间下限为 ${e_ci.toFixed(2)}）。` +
    `这一量化证据表明，任何未被观察测量的潜在残留混杂因素，必须同时与研究暴露和主要临床结局产生至少 ${e_point.toFixed(2)} 倍的关联强度，` +
    `且在充分校正了既有全部协变量后依然维持该强关联，才足以将当前观测到的${effectDescZh}完全解释为混杂偏倚；` +
    `${ciExplanationZh}本研究结论具备高度的稳健性与抗偏倚能力。`

  const defense_en = `The observed multivariable-adjusted ${effect_type} was ${estimate.toFixed(2)} (95% CI: ${ci_lower.toFixed(2)}-${ci_upper.toFixed(2)}). ` +
    `The calculated E-value was ${e_point.toFixed(2)} for the point estimate and ${e_ci.toFixed(2)} for the confidence interval limit. ` +
    `This indicates that an unmeasured confounder would need an association with both the exposure and outcome of at least ${e_point.toFixed(2)}-fold each, ` +
    `above and beyond the measured baseline covariates, to fully explain away the observed ${effectDescEn}. ` +
    `${ciExplanationEn} These findings demonstrate robust causal resilience against potential unmeasured residual confounding.`

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
    smd_loose_threshold = 0.10,
    covariates,
  } = config

  const width = 880
  const rowHeight = 30
  const marginTop = 85
  const marginBottom = 65
  const marginLeft = 280
  const marginRight = 60
  const plotWidth = width - marginLeft - marginRight
  const plotHeight = covariates.length * rowHeight
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

    return `
      ${rowBg}
      <!-- Covariate Name -->
      <text x="${marginLeft - 16}" y="${y + 4}" text-anchor="end" font-family="Times New Roman, STSong, serif" font-size="13" fill="#1e293b">${escapeXml(cov.label_zh)} (${escapeXml(cov.name)})</text>
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
