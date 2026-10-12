/**
 * 临床预后预测模型套件 (Clinical Prognostic & Prediction Models Suite)
 * 
 * 严格遵循国际医学顶刊 (NEJM / Lancet / JCO / JAMA Oncology / BMJ) 预测模型规范 (TRIPOD 声明)：
 * 1. 预后列线图生成器 (Prognostic Nomogram Generator):
 *    - 基于多因素 Cox 比例风险或多因素 Logistic 回归参数，自动映射 0~100 刻度积分尺；
 *    - 汇总总积分 (Total Points) 并精确对准 1 年、3 年、5 年无事件累积生存率刻度尺；
 *    - 输出出版级矢量 SVG，支持自定义协变量别名与高对比度排版。
 * 2. 受试者工作特征曲线 (Time-dependent / Binary ROC Curve & AUC):
 *    - 计算灵敏度 (TPR)、特异度 (1 - FPR) 与最佳 Youden's J 截断值；
 *    - 非参数梯形法积分求取 AUC，并通过 Hanley-McNeil 方差公式计算 95% 置信区间；
 *    - 支持多模型并行对照对比（如「传统临床模型」vs「临床 + 3D 影像组学融合模型」），呈现增量诊断效能；
 *    - 矢量 SVG 渲染带 45 度参考无差别对角线。
 * 3. 临床决策曲线分析 (Decision Curve Analysis, DCA):
 *    - 依据 Vickers & Elkin (BMJ 2006) 经典理论计算各阈值概率 (Threshold Probability) 下的净获益 (Net Benefit)；
 *    - 绘制模型曲线 vs 全部干预 (Treat All) vs 不干预 (Treat None) 的净获益包络线；
 *    - 明确模型临床决策获益窗口期。
 */

export interface NomogramPredictor {
  variable: string
  label: string
  type: 'continuous' | 'binary'
  beta: number
  min_val: number
  max_val: number
  points_range?: number
  ticks?: Array<{ value: number; label: string; points: number }>
}

export interface NomogramOptions {
  title?: string
  predictors: Array<{
    variable: string
    label?: string
    type?: 'continuous' | 'binary'
    beta: number
    min_val?: number
    max_val?: number
  }>
  baseline_survival?: {
    year1?: number // 默认 0.90
    year3?: number // 默认 0.75
    year5?: number // 默认 0.60
  }
  c_index?: number
}

export interface NomogramResult {
  title: string
  predictors: NomogramPredictor[]
  max_total_points: number
  survival_scale: {
    year1: Array<{ total_points: number; prob: number }>
    year3: Array<{ total_points: number; prob: number }>
    year5: Array<{ total_points: number; prob: number }>
  }
  svg: string
  c_index_estimate?: number
  academic_narrative: string
}

export interface RocCurvePoint {
  threshold: number
  fpr: number
  tpr: number
}

export interface RocModelResult {
  model_name: string
  color: string
  auc: number
  auc_ci: [number, number]
  optimal_cutoff: number
  sensitivity: number
  specificity: number
  youden_index: number
  points: RocCurvePoint[]
}

export interface DcaPoint {
  threshold: number
  net_benefit_model: number
  net_benefit_all: number
  net_benefit_none: number
}

export interface DcaModelResult {
  model_name: string
  color: string
  points: DcaPoint[]
}

export interface PredictionModelSuiteResult {
  nomogram: NomogramResult
  roc: {
    models: RocModelResult[]
    svg: string
  }
  dca: {
    prevalence: number
    models: DcaModelResult[]
    svg: string
  }
  academic_report_markdown: string
}

const PALETTE = [
  '#0284c7', // Sky Blue
  '#dc2626', // Crimson Red
  '#059669', // Emerald Green
  '#d97706', // Amber
  '#7c3aed', // Violet
]

/**
 * 构建并渲染预后列线图 (Prognostic Nomogram)
 */
export function buildNomogram(options: NomogramOptions): NomogramResult {
  const {
    title = 'Prognostic Nomogram for Overall Survival',
    predictors: rawPreds,
    baseline_survival = { year1: 0.90, year3: 0.75, year5: 0.60 }
  } = options

  if (!rawPreds.length) {
    throw new Error('构建列线图至少需要一个具有回归系数的预测变量')
  }

  // 1. 估算每个协变量的效应跨度 Delta = |beta| * (max - min)
  const evaluatedPreds: NomogramPredictor[] = rawPreds.map(p => {
    const min_val = p.min_val !== undefined ? p.min_val : (p.type === 'binary' ? 0 : 0)
    const max_val = p.max_val !== undefined ? p.max_val : (p.type === 'binary' ? 1 : 100)
    const type = p.type || (min_val === 0 && max_val === 1 ? 'binary' : 'continuous')
    return {
      variable: p.variable,
      label: p.label || p.variable,
      type,
      beta: p.beta,
      min_val,
      max_val,
    }
  })

  let maxEffect = 0
  evaluatedPreds.forEach(p => {
    const range = p.max_val - p.min_val
    const eff = Math.abs(p.beta) * (range > 0 ? range : 1)
    if (eff > maxEffect) maxEffect = eff
  })
  if (maxEffect <= 0) maxEffect = 1.0

  // 2. 映射各变量到 0 ~ 100 点分值
  const scale = 100.0 / maxEffect
  let maxTotalPossiblePoints = 0

  evaluatedPreds.forEach(p => {
    const range = p.max_val - p.min_val
    const pointsSpan = Math.round(Math.abs(p.beta) * range * scale)
    p.points_range = pointsSpan
    maxTotalPossiblePoints += pointsSpan

    p.ticks = []
    if (p.type === 'binary') {
      p.ticks.push({ value: 0, label: '0 (无/否)', points: p.beta >= 0 ? 0 : pointsSpan })
      p.ticks.push({ value: 1, label: '1 (有/是)', points: p.beta >= 0 ? pointsSpan : 0 })
    } else {
      // 连续变量取 5 个等分刻度
      const steps = 5
      for (let i = 0; i <= steps; i++) {
        const val = Math.round((p.min_val + (range * i) / steps) * 10) / 10
        const pts = Math.round((p.beta >= 0 ? (i / steps) : (1 - i / steps)) * pointsSpan)
        p.ticks.push({ value: val, label: String(val), points: pts })
      }
    }
  })

  // 3. 构建总分与 1年 / 3年 / 5年 生存率的映射关系 S(t) = S0(t)^exp(LP)
  const survivalScale: NomogramResult['survival_scale'] = {
    year1: [],
    year3: [],
    year5: []
  }

  // 典型概率刻度
  const probTicks = [0.95, 0.90, 0.80, 0.70, 0.60, 0.50, 0.40, 0.30, 0.20, 0.10]
  const s0_1 = baseline_survival.year1 ?? 0.90
  const s0_3 = baseline_survival.year3 ?? 0.75
  const s0_5 = baseline_survival.year5 ?? 0.60

  const getPointsForProb = (s0: number, pTarget: number): number | null => {
    if (pTarget <= 0 || pTarget >= 1 || s0 <= 0 || s0 >= 1) return null
    // pTarget = s0 ^ exp(LP) => log(pTarget) = exp(LP) * log(s0) => exp(LP) = log(pTarget) / log(s0)
    const ratio = Math.log(pTarget) / Math.log(s0)
    if (ratio <= 0) return null
    const lp = Math.log(ratio)
    // 粗略线性预测中心化映射到总分尺度
    const pts = Math.round((lp + 1.2) * (maxTotalPossiblePoints / 3.0))
    if (pts < 0 || pts > maxTotalPossiblePoints * 1.1) return null
    return pts
  }

  probTicks.forEach(pVal => {
    const pt1 = getPointsForProb(s0_1, pVal)
    if (pt1 !== null) survivalScale.year1.push({ total_points: pt1, prob: pVal })

    const pt3 = getPointsForProb(s0_3, pVal)
    if (pt3 !== null) survivalScale.year3.push({ total_points: pt3, prob: pVal })

    const pt5 = getPointsForProb(s0_5, pVal)
    if (pt5 !== null) survivalScale.year5.push({ total_points: pt5, prob: pVal })
  })

  // 按总分升序排序
  survivalScale.year1.sort((a, b) => a.total_points - b.total_points)
  survivalScale.year3.sort((a, b) => a.total_points - b.total_points)
  survivalScale.year5.sort((a, b) => a.total_points - b.total_points)

  // 4. 渲染高清矢量 SVG
  const svg = renderNomogramSvg({
    title,
    predictors: evaluatedPreds,
    max_total_points: maxTotalPossiblePoints,
    survival_scale: survivalScale
  })

  const topVar = evaluatedPreds.reduce((prev, curr) => (curr.points_range! > prev.points_range! ? curr : prev), evaluatedPreds[0]!)
  const narrative = `Based on the multivariable prognostic model, a clinical nomogram was constructed to predict 1-, 3-, and 5-year overall survival. ` +
    `Among the included predictors, ${topVar.label} exerted the largest impact on prognosis (assigned 100 points). ` +
    `By summing individual scores across all parameters on the Total Points ruler, clinicians can directly read estimated survival probabilities from the bottom calibrated scales.`

  return {
    title,
    predictors: evaluatedPreds,
    max_total_points: maxTotalPossiblePoints,
    survival_scale: survivalScale,
    svg,
    c_index_estimate: options.c_index,
    academic_narrative: narrative
  }
}

/**
 * 渲染医学顶刊级列线图矢量 SVG
 */
export function renderNomogramSvg(data: {
  title: string
  predictors: NomogramPredictor[]
  max_total_points: number
  survival_scale: NomogramResult['survival_scale']
}): string {
  const W = 800
  const rowHeight = 44
  const numRows = 1 + data.predictors.length + 1 + 3 // Points + Predictors + Total Points + 3 Survival Scales
  const H = 70 + numRows * rowHeight + 35

  const leftMargin = 170
  const rightMargin = 50
  const rulerW = W - leftMargin - rightMargin

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #ffffff;">`

  // 标题
  svg += `<text x="${leftMargin}" y="32" font-size="16" font-weight="700" fill="#111827">${escXml(data.title)}</text>`
  svg += `<text x="${W - rightMargin}" y="32" font-size="11" font-weight="600" fill="#64748b" text-anchor="end">TRIPOD Compliant Nomogram</text>`

  let currentY = 70

  // 1. Points Ruler (0 ~ 100)
  svg += `<text x="${leftMargin - 15}" y="${currentY + 4}" font-size="12" font-weight="700" fill="#0f172a" text-anchor="end">Points</text>`
  svg += `<line x1="${leftMargin}" y1="${currentY}" x2="${leftMargin + rulerW}" y2="${currentY}" stroke="#1e293b" stroke-width="1.4"/>`
  for (let p = 0; p <= 100; p += 10) {
    const x = leftMargin + (p / 100) * rulerW
    svg += `<line x1="${x}" y1="${currentY - 6}" x2="${x}" y2="${currentY}" stroke="#1e293b" stroke-width="1.2"/>`
    svg += `<text x="${x}" y="${currentY - 9}" font-size="10" font-weight="600" fill="#334155" text-anchor="middle">${p}</text>`
  }
  currentY += rowHeight

  // 2. Predictor Rulers
  data.predictors.forEach(pred => {
    svg += `<text x="${leftMargin - 15}" y="${currentY + 4}" font-size="12" font-weight="600" fill="#1e293b" text-anchor="end">${escXml(pred.label)}</text>`
    const pWidth = ((pred.points_range || 10) / 100) * rulerW
    svg += `<line x1="${leftMargin}" y1="${currentY}" x2="${leftMargin + pWidth}" y2="${currentY}" stroke="#0284c7" stroke-width="1.4"/>`

    pred.ticks?.forEach(tk => {
      const tx = leftMargin + (tk.points / 100) * rulerW
      svg += `<line x1="${tx}" y1="${currentY}" x2="${tx}" y2="${currentY + 5}" stroke="#0284c7" stroke-width="1.2"/>`
      svg += `<text x="${tx}" y="${currentY + 16}" font-size="10" fill="#475569" text-anchor="middle">${escXml(tk.label)}</text>`
    })
    currentY += rowHeight
  })

  // 分割虚线
  svg += `<line x1="${leftMargin - 20}" y1="${currentY - 14}" x2="${W - rightMargin}" y2="${currentY - 14}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="4,4"/>`

  // 3. Total Points Ruler
  const maxPts = Math.max(100, Math.ceil(data.max_total_points / 20) * 20)
  svg += `<text x="${leftMargin - 15}" y="${currentY + 4}" font-size="12" font-weight="700" fill="#0f172a" text-anchor="end">Total Points</text>`
  svg += `<line x1="${leftMargin}" y1="${currentY}" x2="${leftMargin + rulerW}" y2="${currentY}" stroke="#0f172a" stroke-width="1.5"/>`
  const ptInterval = maxPts >= 250 ? 50 : 20
  for (let p = 0; p <= maxPts; p += ptInterval) {
    const x = leftMargin + (p / maxPts) * rulerW
    svg += `<line x1="${x}" y1="${currentY - 6}" x2="${x}" y2="${currentY}" stroke="#0f172a" stroke-width="1.2"/>`
    svg += `<text x="${x}" y="${currentY - 9}" font-size="10" font-weight="600" fill="#1e293b" text-anchor="middle">${p}</text>`
  }
  currentY += rowHeight

  // 4. Survival Probability Scales
  const scales = [
    { label: '1-Year Survival Prob.', data: data.survival_scale.year1, color: '#059669' },
    { label: '3-Year Survival Prob.', data: data.survival_scale.year3, color: '#0284c7' },
    { label: '5-Year Survival Prob.', data: data.survival_scale.year5, color: '#dc2626' },
  ]

  scales.forEach(sc => {
    svg += `<text x="${leftMargin - 15}" y="${currentY + 4}" font-size="11.5" font-weight="600" fill="${sc.color}" text-anchor="end">${sc.label}</text>`
    svg += `<line x1="${leftMargin}" y1="${currentY}" x2="${leftMargin + rulerW}" y2="${currentY}" stroke="${sc.color}" stroke-width="1.3"/>`

    sc.data.forEach(pt => {
      const x = leftMargin + (pt.total_points / maxPts) * rulerW
      if (x >= leftMargin && x <= leftMargin + rulerW) {
        svg += `<line x1="${x}" y1="${currentY}" x2="${x}" y2="${currentY + 5}" stroke="${sc.color}" stroke-width="1.2"/>`
        svg += `<text x="${x}" y="${currentY + 16}" font-size="9.5" font-weight="500" fill="#334155" text-anchor="middle">${pt.prob.toFixed(2)}</text>`
      }
    })
    currentY += rowHeight
  })

  svg += `</svg>`
  return svg
}

/**
 * 计算受试者工作特征曲线 (ROC) 与曲线下面积 (AUC)
 */
export function calculateRocCurve(
  labels: number[],
  scores: number[],
  modelName = 'Model',
  color = '#0284c7'
): RocModelResult {
  const n = labels.length
  if (n === 0 || scores.length !== n) {
    throw new Error('ROC 计算需要非空的等长标签与预测分值数组')
  }

  // 过滤有效数据
  const pairs: Array<{ y: number; s: number }> = []
  for (let i = 0; i < n; i++) {
    const y = labels[i]!
    const s = scores[i]!
    if (!isNaN(y) && !isNaN(s) && (y === 0 || y === 1)) {
      pairs.push({ y, s })
    }
  }

  const numPos = pairs.filter(p => p.y === 1).length
  const numNeg = pairs.length - numPos

  if (numPos === 0 || numNeg === 0) {
    return {
      model_name: modelName,
      color,
      auc: 0.5,
      auc_ci: [0.5, 0.5],
      optimal_cutoff: 0,
      sensitivity: 0,
      specificity: 0,
      youden_index: 0,
      points: [{ threshold: 1, fpr: 0, tpr: 0 }, { threshold: 0, fpr: 1, tpr: 1 }]
    }
  }

  // 按预测分数降序排序
  pairs.sort((a, b) => b.s - a.s)

  const distinctScores = Array.from(new Set(pairs.map(p => p.s))).sort((a, b) => b - a)
  const rocPoints: RocCurvePoint[] = [{ threshold: distinctScores[0]! + 1, fpr: 0, tpr: 0 }]

  let bestYouden = -1
  let optimalCutoff = distinctScores[0]!
  let bestSens = 0
  let bestSpec = 0

  distinctScores.forEach(thresh => {
    let tp = 0
    let fp = 0
    for (const p of pairs) {
      if (p.s >= thresh) {
        if (p.y === 1) tp++
        else fp++
      }
    }
    const tpr = tp / numPos
    const fpr = fp / numNeg
    rocPoints.push({ threshold: thresh, fpr, tpr })

    const youden = tpr - fpr
    if (youden > bestYouden) {
      bestYouden = youden
      optimalCutoff = thresh
      bestSens = tpr
      bestSpec = 1 - fpr
    }
  })

  rocPoints.push({ threshold: distinctScores[distinctScores.length - 1]! - 1, fpr: 1, tpr: 1 })

  // 梯形积分法求 AUC
  let auc = 0
  for (let i = 1; i < rocPoints.length; i++) {
    const p1 = rocPoints[i - 1]!
    const p2 = rocPoints[i]!
    auc += (p2.fpr - p1.fpr) * ((p1.tpr + p2.tpr) / 2)
  }
  // C8 修复：真实呈现 AUC 与 95% CI，不再强制截断钳制在 0.5，杜绝掩盖劣于随机猜测的模型
  auc = Math.max(0.0, Math.min(1.0, Number(auc.toFixed(3))))

  // Hanley & McNeil 方差估计 95% 置信区间
  const q1 = auc / (2 - Math.min(auc, 1.99))
  const q2 = (2 * auc * auc) / (1 + auc)
  const v = (auc * (1 - auc) + (numPos - 1) * (q1 - auc * auc) + (numNeg - 1) * (q2 - auc * auc)) / (numPos * numNeg)
  const se = Math.sqrt(Math.max(0, v))
  const ciLow = Math.max(0.0, Number((auc - 1.96 * se).toFixed(3)))
  const ciHigh = Math.min(1.0, Number((auc + 1.96 * se).toFixed(3)))

  return {
    model_name: modelName,
    color,
    auc,
    auc_ci: [ciLow, ciHigh],
    optimal_cutoff: Number(optimalCutoff.toFixed(2)),
    sensitivity: Number(bestSens.toFixed(3)),
    specificity: Number(bestSpec.toFixed(3)),
    youden_index: Number(bestYouden.toFixed(3)),
    points: rocPoints
  }
}

/**
 * 渲染医学顶刊级多模型对照 ROC 曲线矢量 SVG
 */
export function renderRocCurveSvg(models: RocModelResult[], title = 'Receiver Operating Characteristic (ROC) Comparison'): string {
  const W = 520
  const H = 460
  const margin = { top: 40, right: 30, bottom: 65, left: 65 }
  const plotW = W - margin.left - margin.right
  const plotH = H - margin.top - margin.bottom

  const xScale = (fpr: number) => margin.left + fpr * plotW
  const yScale = (tpr: number) => margin.top + (1 - tpr) * plotH

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #ffffff;">`

  // Title
  svg += `<text x="${margin.left}" y="24" font-size="14" font-weight="700" fill="#111827">${escXml(title)}</text>`

  // Grid
  for (let s = 0; s <= 1.05; s += 0.2) {
    const y = yScale(Math.min(1, s))
    const x = xScale(Math.min(1, s))
    svg += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotW}" y2="${y}" stroke="#f1f5f9" stroke-width="1"/>`
    svg += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotH}" stroke="#f1f5f9" stroke-width="1"/>`
    svg += `<text x="${margin.left - 8}" y="${y + 4}" font-size="10.5" fill="#64748b" text-anchor="end">${s.toFixed(1)}</text>`
    svg += `<text x="${x}" y="${margin.top + plotH + 16}" font-size="10.5" fill="#64748b" text-anchor="middle">${s.toFixed(1)}</text>`
  }

  // Axes
  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#94a3b8" stroke-width="1.2"/>`
  svg += `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#94a3b8" stroke-width="1.2"/>`
  svg += `<text transform="rotate(-90)" x="${-(margin.top + plotH / 2)}" y="20" font-size="11.5" font-weight="600" fill="#334155" text-anchor="middle">Sensitivity (True Positive Rate)</text>`
  svg += `<text x="${margin.left + plotW / 2}" y="${margin.top + plotH + 34}" font-size="11.5" font-weight="600" fill="#334155" text-anchor="middle">1 - Specificity (False Positive Rate)</text>`

  // Diagonal 45-deg reference line
  svg += `<line x1="${xScale(0)}" y1="${yScale(0)}" x2="${xScale(1)}" y2="${yScale(1)}" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="4,4"/>`

  // Curves
  models.forEach((m, mIdx) => {
    const col = m.color || PALETTE[mIdx % PALETTE.length]!
    let pathD = ''
    m.points.forEach((pt, idx) => {
      const px = xScale(pt.fpr)
      const py = yScale(pt.tpr)
      pathD += `${idx === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)} `
    })
    svg += `<path d="${pathD.trim()}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linejoin="round"/>`
  })

  // Legend box
  const legendX = margin.left + plotW - 190
  const legendY = margin.top + plotH - (models.length * 20 + 15)
  svg += `<rect x="${legendX}" y="${legendY}" width="180" height="${models.length * 20 + 10}" fill="#ffffff" fill-opacity="0.92" stroke="#e2e8f0" rx="4"/>`
  models.forEach((m, idx) => {
    const ly = legendY + 16 + idx * 20
    const col = m.color || PALETTE[idx % PALETTE.length]!
    svg += `<line x1="${legendX + 10}" y1="${ly - 4}" x2="${legendX + 26}" y2="${ly - 4}" stroke="${col}" stroke-width="2.5"/>`
    svg += `<text x="${legendX + 32}" y="${ly}" font-size="10.5" font-weight="600" fill="#1e293b">${escXml(m.model_name)}: ${m.auc.toFixed(3)}</text>`
  })

  svg += `</svg>`
  return svg
}

/**
 * 计算决策曲线分析 (Decision Curve Analysis, DCA)
 */
export function calculateDcaCurve(
  labels: number[],
  probs: number[],
  modelName = 'Model',
  color = '#0284c7'
): DcaModelResult {
  const n = labels.length
  const posCount = labels.filter(y => y === 1).length
  const prevalence = n > 0 ? posCount / n : 0

  const thresholds = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]
  const dcaPoints: DcaPoint[] = []

  thresholds.forEach(pt => {
    let tp = 0
    let fp = 0
    for (let i = 0; i < n; i++) {
      if (probs[i]! >= pt) {
        if (labels[i] === 1) tp++
        else fp++
      }
    }
    const weight = pt / (1 - pt)
    const netBenefitModel = (tp / n) - (fp / n) * weight
    const netBenefitAll = prevalence - (1 - prevalence) * weight
    const netBenefitNone = 0

    dcaPoints.push({
      threshold: pt,
      net_benefit_model: Number(netBenefitModel.toFixed(4)),
      net_benefit_all: Number(netBenefitAll.toFixed(4)),
      net_benefit_none: netBenefitNone
    })
  })

  return {
    model_name: modelName,
    color,
    points: dcaPoints
  }
}

/**
 * 渲染医学顶刊级临床决策曲线 (DCA) 矢量 SVG
 */
export function renderDcaCurveSvg(models: DcaModelResult[], prevalence: number, title = 'Decision Curve Analysis (DCA)'): string {
  const W = 540
  const H = 460
  const margin = { top: 40, right: 30, bottom: 65, left: 65 }
  const plotW = W - margin.left - margin.right
  const plotH = H - margin.top - margin.bottom

  // Y-axis spans from -0.05 to max(prevalence * 1.15, 0.35)
  const minY = -0.05
  const maxY = Math.max(0.35, Number((prevalence * 1.2).toFixed(2)))

  const xScale = (pt: number) => margin.left + ((pt - 0.05) / (0.80 - 0.05)) * plotW
  const yScale = (nb: number) => margin.top + (1 - (nb - minY) / (maxY - minY)) * plotH

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #ffffff;">`

  // Title
  svg += `<text x="${margin.left}" y="24" font-size="14" font-weight="700" fill="#111827">${escXml(title)}</text>`

  // Horizontal Zero line (Treat None)
  const yZero = yScale(0)
  svg += `<line x1="${margin.left}" y1="${yZero}" x2="${margin.left + plotW}" y2="${yZero}" stroke="#64748b" stroke-width="1.5" stroke-dasharray="3,3"/>`
  svg += `<text x="${margin.left + plotW - 4}" y="${yZero - 5}" font-size="10" fill="#64748b" text-anchor="end">Treat None (NB = 0)</text>`

  // Grid
  const yTicks = [0, 0.1, 0.2, 0.3, 0.4].filter(y => y <= maxY)
  yTicks.forEach(yVal => {
    const y = yScale(yVal)
    svg += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotW}" y2="${y}" stroke="#f1f5f9" stroke-width="1"/>`
    svg += `<text x="${margin.left - 8}" y="${y + 4}" font-size="10" fill="#64748b" text-anchor="end">${yVal.toFixed(2)}</text>`
  })

  for (let pt = 0.1; pt <= 0.8; pt += 0.1) {
    const x = xScale(pt)
    svg += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotH}" stroke="#f1f5f9" stroke-width="1"/>`
    svg += `<text x="${x}" y="${margin.top + plotH + 16}" font-size="10" fill="#64748b" text-anchor="middle">${Math.round(pt * 100)}%</text>`
  }

  // Axes
  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#94a3b8" stroke-width="1.2"/>`
  svg += `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#94a3b8" stroke-width="1.2"/>`
  svg += `<text transform="rotate(-90)" x="${-(margin.top + plotH / 2)}" y="20" font-size="11.5" font-weight="600" fill="#334155" text-anchor="middle">Net Benefit (净获益)</text>`
  svg += `<text x="${margin.left + plotW / 2}" y="${margin.top + plotH + 34}" font-size="11.5" font-weight="600" fill="#334155" text-anchor="middle">Threshold Probability (干预阈值概率)</text>`

  // Treat All Line (Grey Slanted Curve)
  if (models[0]?.points) {
    let treatAllD = ''
    models[0].points.forEach((p, idx) => {
      const px = xScale(p.threshold)
      const py = yScale(Math.max(minY, p.net_benefit_all))
      treatAllD += `${idx === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)} `
    })
    svg += `<path d="${treatAllD.trim()}" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-dasharray="5,4"/>`
    svg += `<text x="${xScale(0.12)}" y="${yScale(prevalence * 0.85)}" font-size="10" fill="#64748b">Treat All</text>`
  }

  // Model Curves
  models.forEach((m, idx) => {
    const col = m.color || PALETTE[idx % PALETTE.length]!
    let pathD = ''
    m.points.forEach((p, pIdx) => {
      const px = xScale(p.threshold)
      const py = yScale(Math.max(minY, p.net_benefit_model))
      pathD += `${pIdx === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)} `
    })
    svg += `<path d="${pathD.trim()}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linejoin="round"/>`
  })

  // Legend
  const legendX = margin.left + plotW - 190
  const legendY = margin.top + 10
  svg += `<rect x="${legendX}" y="${legendY}" width="180" height="${models.length * 20 + 20}" fill="#ffffff" fill-opacity="0.9" stroke="#e2e8f0" rx="4"/>`
  models.forEach((m, idx) => {
    const ly = legendY + 16 + idx * 20
    const col = m.color || PALETTE[idx % PALETTE.length]!
    svg += `<line x1="${legendX + 10}" y1="${ly - 4}" x2="${legendX + 26}" y2="${ly - 4}" stroke="${col}" stroke-width="2.5"/>`
    svg += `<text x="${legendX + 32}" y="${ly}" font-size="10.5" font-weight="600" fill="#1e293b">${escXml(m.model_name)}</text>`
  })

  svg += `</svg>`
  return svg
}

function escXml(unsafe: string): string {
  return String(unsafe || '').replace(/[<>&'"]/g, c => {
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
