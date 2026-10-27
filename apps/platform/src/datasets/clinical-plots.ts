/**
 * 临床科研专科分析与出版级可视化套件 (Clinical Specialty Analytics & Plots Suite)
 *
 * 覆盖神经外科、卒中/脑血管病、肿瘤科与临床流行病学 4 大核心高阶图表与回归模型：
 * 1. 二元结局单因素 / 多因素 Logistic 回归与优势比森林图 (Logistic Regression & OR Forest Plot)
 *    - Newton-Raphson IRLS 迭代加权最小二乘拟合（带 L2 岭正则化防稀疏共线发散）
 *    - 同时输出单因素粗 OR (Univariate Crude OR) 与多因素校正 aOR (Multivariate Adjusted OR)、95% CI、Wald P 值与模型 AUC (C-statistic)
 * 2. 有序分类结局堆叠百分比条形图与分布迁移图 (Grotta Bar / mRS Shift Analysis)
 *    - 支持「组间横向对比 (`group_col` + `score_col`)」与「纵向多时间点演变 (`timepoint_cols`)」双模式
 *    - 绘制 NEJM / Stroke / Lancet Neurology 标准 100% 堆叠水平条形图 + 组间层间连接流带 + 卡方与秩和检验 P 值
 * 3. 多阶段序贯治疗路径与结局流向桑基图 (Sankey / Alluvial Diagram)
 *    - 支持多列阶段 (`stage_cols`) 或单列多位数序贯编码 (`sequence_col`，如 "3" -> "32" -> "332") 自动拆解
 *    - 三次贝塞尔曲线流向带 + 节点样本量与占比标注 + R ggalluvial 工程脚本导出
 * 4. 多部位解剖受累共现交集与结局发生率联动图 (UpSet Co-occurrence & Outcome Rate Plot)
 *    - 针对多脑区/多器官/多合并症 0/1 矩阵 (`binary_cols`) 自动计算单发与跨区共现组合频数
 *    - 选配结局列 (`outcome_col`) 时叠加各解剖组合的结局发生率，并检验多部位受累 vs 单部位受累的显著性差异
 */

import {
  chiSquareOrFisher,
  chiSquareUpperPValue,
  formatP,
  isCellMissing,
  kruskalWallisTest,
  mannWhitneyUTest,
  normalCdf,
} from './table1.ts'
import { normalizeEventStatus } from './survival.ts'
import {
  escXml,
  exportToPrismPzfx,
  upgradeSvgForIllustrator,
  type PrismTableSpec,
} from '../research/medical-figures.ts'

// ============================================================================
// 通用线性代数辅助（高斯消元与矩阵求逆）
// ============================================================================

function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]!])

  for (let i = 0; i < n; i++) {
    let maxRow = i
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k]![i]!) > Math.abs(M[maxRow]![i]!)) maxRow = k
    }
    const tmp = M[i]!
    M[i] = M[maxRow]!
    M[maxRow] = tmp

    if (Math.abs(M[i]![i]!) < 1e-12) return null

    for (let k = i + 1; k < n; k++) {
      const c = -M[k]![i]! / M[i]![i]!
      for (let j = i; j <= n; j++) {
        if (i === j) M[k]![j] = 0
        else M[k]![j]! += c * M[i]![j]!
      }
    }
  }

  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i]![n]! / M[i]![i]!
    for (let k = i - 1; k >= 0; k--) {
      M[k]![n]! -= M[k]![i]! * x[i]!
    }
  }
  return x
}

function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length
  const inv: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let col = 0; col < n; col++) {
    const e = Array.from({ length: n }, (_, idx) => (idx === col ? 1 : 0))
    const x = solveLinearSystem(A, e)
    if (!x) return null
    for (let row = 0; row < n; row++) {
      inv[row]![col] = x[row]!
    }
  }
  return inv
}

// ============================================================================
// 1. 二元结局单因素 / 多因素 Logistic 回归与 OR 森林图
// ============================================================================

export interface LogisticOptions {
  /** 二元结局列名（如 '治疗后出血'、'闭塞程度'、'围术期不良事件'） */
  outcome_col: string
  /** 纳入回归的预测因子 / 协变量列名列表 */
  covariates: string[]
  /**
   * 判定为阳性事件 (event = 1) 的取值（可选）：
   * - 不传时按通用二分类规则识别（1 / true / yes / 是 / 阳性 > 0 为 1，0 / false / no / 否 为 0）；
   * - 传入时（如在 `闭塞程度` 中传 `positive_value: '1'` 表示完全闭塞），非缺失且等于该值的记为 1，其余非缺失值记为 0。
   */
  positive_value?: string | number
  /** 变量显示名称映射 */
  labels?: Record<string, string>
  /** 图表标题 */
  title?: string
}

export interface LogisticCovariateResult {
  variable: string
  label: string
  /** 单因素粗 OR 与 95% CI */
  univariate_or: number
  univariate_ci_lower: number
  univariate_ci_upper: number
  univariate_p: number
  univariate_p_formatted: string
  univariate_or_formatted: string
  /** 多因素校正 aOR 与 95% CI */
  beta: number
  se: number
  z: number
  p_value: number
  p_value_formatted: string
  or: number
  or_ci_lower: number
  or_ci_upper: number
  or_formatted: string
}

export interface LogisticRegressionResult {
  title: string
  outcome_col: string
  sample_size: number
  events_count: number
  event_rate: number
  /** 模型判别区分度 AUC (Harrell C-statistic) */
  auc: number
  /** 似然比检验整体 P 值 */
  p_value_overall: number
  covariates: LogisticCovariateResult[]
  svg: string
  markdown_table: string
  narrative: string
  native_exports: {
    illustrator_svg: string
    prism_pzfx: string
    r_script: string
  }
}

/** 内部 IRLS 拟合带截距项的二元 Logistic 回归（X 不含截距列，内部自动在索引 0 加截距） */
function fitBinaryLogisticIrls(
  X: number[][],
  y: number[],
): {
  beta: number[]
  se: number[]
  logLik: number
  nullLogLik: number
  probs: number[]
} {
  const n = X.length
  const p = X[0]?.length ?? 0
  const dim = p + 1 // 含截距项 beta_0

  if (n === 0 || p === 0) {
    return {
      beta: new Array(dim).fill(0),
      se: new Array(dim).fill(1),
      logLik: 0,
      nullLogLik: 0,
      probs: new Array(n).fill(0.5),
    }
  }

  const Xd = X.map(row => [1, ...row])
  const posCount = y.reduce((a, b) => a + b, 0)
  const pBar = Math.max(1e-4, Math.min(1 - 1e-4, posCount / n))
  const nullLogLik = posCount * Math.log(pBar) + (n - posCount) * Math.log(1 - pBar)

  const beta = new Array<number>(dim).fill(0)
  beta[0] = Math.log(pBar / (1 - pBar))

  const ridge = 1e-5
  for (let iter = 0; iter < 30; iter++) {
    const grad = new Array<number>(dim).fill(0)
    const H: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0))

    for (let i = 0; i < n; i++) {
      const xi = Xd[i]!
      let eta = 0
      for (let j = 0; j < dim; j++) eta += beta[j]! * xi[j]!
      eta = Math.max(-20, Math.min(20, eta))
      const mu = 1 / (1 + Math.exp(-eta))
      const w = Math.max(1e-6, mu * (1 - mu))
      const diff = y[i]! - mu
      for (let j = 0; j < dim; j++) {
        grad[j]! += diff * xi[j]!
        for (let k = j; k < dim; k++) {
          H[j]![k]! += w * xi[j]! * xi[k]!
        }
      }
    }

    for (let j = 0; j < dim; j++) {
      for (let k = 0; k < j; k++) H[j]![k] = H[k]![j]!
      if (j > 0) {
        grad[j]! -= ridge * beta[j]!
        H[j]![j]! += ridge
      } else {
        H[j]![j]! += 1e-8
      }
    }

    const delta = solveLinearSystem(H, grad)
    if (!delta) break

    let maxStep = 0
    for (let j = 0; j < dim; j++) {
      const step = Math.max(-3, Math.min(3, delta[j]!))
      beta[j]! += step
      if (Math.abs(step) > maxStep) maxStep = Math.abs(step)
    }
    if (maxStep < 1e-6) break
  }

  // 计算最终协方差矩阵、预测概率与对数似然
  const HFinal: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0))
  const probs: number[] = new Array(n)
  let logLik = 0

  for (let i = 0; i < n; i++) {
    const xi = Xd[i]!
    let eta = 0
    for (let j = 0; j < dim; j++) eta += beta[j]! * xi[j]!
    eta = Math.max(-20, Math.min(20, eta))
    const mu = Math.max(1e-7, Math.min(1 - 1e-7, 1 / (1 + Math.exp(-eta))))
    probs[i] = mu
    logLik += y[i]! * Math.log(mu) + (1 - y[i]!) * Math.log(1 - mu)
    const w = Math.max(1e-6, mu * (1 - mu))
    for (let j = 0; j < dim; j++) {
      for (let k = 0; k < dim; k++) {
        HFinal[j]![k]! += w * xi[j]! * xi[k]!
      }
    }
  }
  for (let j = 0; j < dim; j++) {
    HFinal[j]![j]! += j > 0 ? ridge : 1e-8
  }

  const cov = invertMatrix(HFinal)
  const se = Array.from({ length: dim }, (_, j) =>
    cov ? Math.sqrt(Math.max(1e-8, cov[j]![j]!)) : 1,
  )

  return { beta, se, logLik, nullLogLik, probs }
}

/** 计算二分类预测概率的 Harrell C-statistic / AUC */
function computeBinaryAuc(y: number[], probs: number[]): number {
  const pos: number[] = []
  const neg: number[] = []
  for (let i = 0; i < y.length; i++) {
    if (y[i] === 1) pos.push(probs[i]!)
    else if (y[i] === 0) neg.push(probs[i]!)
  }
  if (pos.length === 0 || neg.length === 0) return 0.5
  let concordant = 0
  const totalPairs = pos.length * neg.length
  for (const pVal of pos) {
    for (const nVal of neg) {
      if (pVal > nVal) concordant += 1
      else if (Math.abs(pVal - nVal) < 1e-12) concordant += 0.5
    }
  }
  return Number((concordant / totalPairs).toFixed(3))
}

/** 渲染二元结局多因素 Logistic 回归 OR 森林图 (Odds Ratio Forest Plot SVG) */
export function renderOrForestPlotSvg(
  covariates: LogisticCovariateResult[],
  title = 'Multivariate Logistic Regression (Odds Ratio Forest Plot)',
  subtitle = '',
): string {
  const W = 740
  const rowHeight = 34
  const headerH = subtitle ? 64 : 50
  const footerH = 48
  const H = headerH + Math.max(1, covariates.length) * rowHeight + footerH

  const colX = { var: 20, uniText: 195, plotLeft: 320, plotRight: 545, multiText: 560, pText: 675 }
  const plotW = colX.plotRight - colX.plotLeft

  let minOr = covariates.reduce((m, c) => Math.min(m, c.or_ci_lower), 0.4)
  let maxOr = covariates.reduce((m, c) => Math.max(m, c.or_ci_upper), 2.5)
  minOr = Math.max(0.05, minOr * 0.8)
  maxOr = Math.min(25.0, maxOr * 1.2)

  const logMin = Math.log(minOr)
  const logMax = Math.log(maxOr)
  const orToX = (val: number) => {
    const clamped = Math.max(minOr, Math.min(maxOr, Number.isFinite(val) && val > 0 ? val : 1.0))
    return colX.plotLeft + ((Math.log(clamped) - logMin) / (logMax - logMin || 1)) * plotW
  }

  const nullX = orToX(1.0)

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #ffffff;">`
  svg += `<text x="20" y="24" font-size="14" font-weight="700" fill="#111827">${escXml(title)}</text>`
  if (subtitle) {
    svg += `<text x="20" y="41" font-size="11" fill="#6B7280">${escXml(subtitle)}</text>`
  }

  const thY = headerH - 8
  svg += `<text x="${colX.var}" y="${thY}" font-size="11" font-weight="700" fill="#4B5563">Predictor</text>`
  svg += `<text x="${colX.uniText}" y="${thY}" font-size="11" font-weight="700" fill="#4B5563">Univariate OR</text>`
  svg += `<text x="${colX.plotLeft + plotW / 2}" y="${thY}" font-size="11" font-weight="700" fill="#4B5563" text-anchor="middle">Adjusted OR (95% CI)</text>`
  svg += `<text x="${colX.multiText}" y="${thY}" font-size="11" font-weight="700" fill="#4B5563">aOR (95% CI)</text>`
  svg += `<text x="${colX.pText}" y="${thY}" font-size="11" font-weight="700" fill="#4B5563">P Value</text>`
  svg += `<line x1="20" y1="${thY + 6}" x2="${W - 20}" y2="${thY + 6}" stroke="#D1D5DB" stroke-width="1.2"/>`

  const plotTop = thY + 8
  const plotBottom = H - footerH + 4
  svg += `<line x1="${nullX}" y1="${plotTop}" x2="${nullX}" y2="${plotBottom}" stroke="#9CA3AF" stroke-width="1.2" stroke-dasharray="3,3"/>`

  covariates.forEach((c, idx) => {
    const y = headerH + idx * rowHeight + 18
    if (idx % 2 === 0) {
      svg += `<rect x="15" y="${y - 15}" width="${W - 30}" height="${rowHeight}" fill="#F9FAFB"/>`
    }

    svg += `<text x="${colX.var}" y="${y + 4}" font-size="11.5" font-weight="600" fill="#1F2937">${escXml(c.label)}</text>`
    svg += `<text x="${colX.uniText}" y="${y + 4}" font-size="10.5" font-family="monospace" fill="#6B7280">${escXml(c.univariate_or_formatted)}</text>`

    const xLow = orToX(c.or_ci_lower)
    const xHigh = orToX(c.or_ci_upper)
    const xMid = orToX(c.or)
    const barColor = c.p_value < 0.05 ? (c.or >= 1 ? '#E11D48' : '#0D9488') : '#6B7280'

    svg += `<line x1="${xLow}" y1="${y}" x2="${xHigh}" y2="${y}" stroke="${barColor}" stroke-width="2"/>`
    svg += `<line x1="${xLow}" y1="${y - 3}" x2="${xLow}" y2="${y + 3}" stroke="${barColor}" stroke-width="1.5"/>`
    svg += `<line x1="${xHigh}" y1="${y - 3}" x2="${xHigh}" y2="${y + 3}" stroke="${barColor}" stroke-width="1.5"/>`
    svg += `<rect x="${xMid - 3.5}" y="${y - 3.5}" width="7" height="7" rx="1" fill="${barColor}"/>`

    svg += `<text x="${colX.multiText}" y="${y + 4}" font-size="11" font-family="monospace" fill="#111827">${escXml(c.or_formatted)}</text>`
    const pColor = c.p_value < 0.05 ? '#047857' : '#4B5563'
    svg += `<text x="${colX.pText}" y="${y + 4}" font-size="11" font-weight="${c.p_value < 0.05 ? '700' : '400'}" fill="${pColor}">${escXml(c.p_value_formatted)}</text>`
  })

  svg += `<line x1="${colX.plotLeft}" y1="${plotBottom}" x2="${colX.plotRight}" y2="${plotBottom}" stroke="#D1D5DB" stroke-width="1"/>`
  const ticks = [Number(minOr.toFixed(2)), 1.0, Number(maxOr.toFixed(1))]
  for (const tVal of ticks) {
    const tx = orToX(tVal)
    svg += `<line x1="${tx}" y1="${plotBottom}" x2="${tx}" y2="${plotBottom + 4}" stroke="#9CA3AF" stroke-width="1"/>`
    svg += `<text x="${tx}" y="${plotBottom + 15}" font-size="10" fill="#6B7280" text-anchor="middle">${tVal}</text>`
  }
  svg += `<text x="${colX.plotLeft + 4}" y="${plotBottom + 29}" font-size="10" fill="#0D9488">← Lower Odds (OR &lt; 1)</text>`
  svg += `<text x="${colX.plotRight - 4}" y="${plotBottom + 29}" font-size="10" fill="#E11D48" text-anchor="end">Higher Odds (OR &gt; 1) →</text>`
  svg += `</svg>`
  return svg
}

/**
 * 执行二元结局单因素 + 多因素 Logistic 回归并生成 OR 森林图
 */
export function generateLogisticRegression(
  records: Array<Record<string, unknown>>,
  options: LogisticOptions,
): LogisticRegressionResult {
  const {
    outcome_col,
    covariates,
    positive_value,
    labels = {},
    title = `Multivariate Logistic Regression for ${labels[outcome_col] || outcome_col}`,
  } = options

  const covList = covariates.filter(c => c && c !== outcome_col)
  if (!covList.length) {
    throw new Error('必须至少指定 1 个预测协变量 (covariates)')
  }

  // 1. 解析二元结局列 y (0 / 1)
  const outcomeHasY = records.some(r => /^(y|yes)$/i.test(String(r[outcome_col] ?? '').trim()))
  const parseOutcome = (raw: unknown): 0 | 1 | null => {
    if (isCellMissing(raw)) return null
    const s = String(raw).trim()
    if (!outcomeHasY && /^n$/i.test(s)) return null
    if (positive_value !== undefined && positive_value !== null && String(positive_value).trim() !== '') {
      const target = String(positive_value).trim()
      if (s === target || (Number.isFinite(Number(s)) && Number.isFinite(Number(target)) && Number(s) === Number(target))) {
        return 1
      }
      return 0
    }
    const norm = normalizeEventStatus(raw)
    return norm === 1 ? 1 : norm === 0 ? 0 : null
  }

  // 2. 对非数值型分类协变量进行有序数值编码
  const categoryEncoding = new Map<string, Map<string, number>>()
  for (const c of covList) {
    let hasNonNumeric = false
    const distinct = new Set<string>()
    for (const r of records) {
      const raw = r[c]
      if (isCellMissing(raw)) continue
      const s = String(raw).trim()
      distinct.add(s)
      if (!Number.isFinite(Number(s))) hasNonNumeric = true
    }
    if (hasNonNumeric && distinct.size >= 1) {
      const sorted = Array.from(distinct).sort()
      const map = new Map<string, number>()
      sorted.forEach((lvl, idx) => map.set(lvl, idx))
      categoryEncoding.set(c, map)
    }
  }

  const encodeCov = (c: string, raw: unknown): number => {
    if (isCellMissing(raw)) return NaN
    const s = String(raw).trim()
    const map = categoryEncoding.get(c)
    if (map) {
      const v = map.get(s)
      return v !== undefined ? v : NaN
    }
    return Number(s)
  }

  // 3. 筛选完整病例 (Complete-case analysis)
  const validRows: Array<{ y: 0 | 1; x: number[] }> = []
  for (const r of records) {
    const y = parseOutcome(r[outcome_col])
    if (y === null) continue
    const x: number[] = []
    let ok = true
    for (const c of covList) {
      const v = encodeCov(c, r[c])
      if (!Number.isFinite(v)) {
        ok = false
        break
      }
      x.push(v)
    }
    if (ok) validRows.push({ y, x })
  }

  const sample_size = validRows.length
  const events_count = validRows.filter(r => r.y === 1).length
  const event_rate = sample_size > 0 ? Number(((events_count / sample_size) * 100).toFixed(1)) : 0

  const yVec = validRows.map(r => r.y)
  const XMat = validRows.map(r => r.x)

  // 4. 多因素 IRLS 拟合
  const multi = fitBinaryLogisticIrls(XMat, yVec)
  const auc = computeBinaryAuc(yVec, multi.probs)
  const lrChi2 = Math.max(0, 2 * (multi.logLik - multi.nullLogLik))
  const p_value_overall = Number(chiSquareUpperPValue(lrChi2, covList.length).toFixed(4))

  // 5. 逐变量单因素 IRLS 拟合 + 汇总结果
  const covResults: LogisticCovariateResult[] = covList.map((c, idx) => {
    const xSingle = validRows.map(r => [r.x[idx]!])
    const uni = fitBinaryLogisticIrls(xSingle, yVec)
    const uBeta = uni.beta[1] ?? 0
    const uSe = uni.se[1] ?? 1
    const uZ = uSe > 0 ? uBeta / uSe : 0
    const uP = 2 * (1 - normalCdf(Math.abs(uZ)))
    const uOr = Math.exp(Math.max(-10, Math.min(10, uBeta)))
    const uLow = Math.exp(Math.max(-10, Math.min(10, uBeta - 1.96 * uSe)))
    const uHigh = Math.exp(Math.max(-10, Math.min(10, uBeta + 1.96 * uSe)))

    const mBeta = multi.beta[idx + 1] ?? 0
    const mSe = multi.se[idx + 1] ?? 1
    const mZ = mSe > 0 ? mBeta / mSe : 0
    const mP = 2 * (1 - normalCdf(Math.abs(mZ)))
    const mOr = Math.exp(Math.max(-10, Math.min(10, mBeta)))
    const mLow = Math.exp(Math.max(-10, Math.min(10, mBeta - 1.96 * mSe)))
    const mHigh = Math.exp(Math.max(-10, Math.min(10, mBeta + 1.96 * mSe)))

    return {
      variable: c,
      label: labels[c] || c,
      univariate_or: Number(uOr.toFixed(2)),
      univariate_ci_lower: Number(uLow.toFixed(2)),
      univariate_ci_upper: Number(uHigh.toFixed(2)),
      univariate_p: uP,
      univariate_p_formatted: formatP(uP),
      univariate_or_formatted: `${uOr.toFixed(2)} (${uLow.toFixed(2)}–${uHigh.toFixed(2)})`,
      beta: Number(mBeta.toFixed(4)),
      se: Number(mSe.toFixed(4)),
      z: Number(mZ.toFixed(3)),
      p_value: mP,
      p_value_formatted: formatP(mP),
      or: Number(mOr.toFixed(2)),
      or_ci_lower: Number(mLow.toFixed(2)),
      or_ci_upper: Number(mHigh.toFixed(2)),
      or_formatted: `${mOr.toFixed(2)} (${mLow.toFixed(2)}–${mHigh.toFixed(2)})`,
    }
  })

  const subtitle = `N = ${sample_size}, Events = ${events_count} (${event_rate}%), Model AUC = ${auc.toFixed(3)}`
  const svg = renderOrForestPlotSvg(covResults, title, subtitle)

  // 6. 生成 Markdown 三线表与医学论文结果段落
  const escMd = (s: string) => String(s).replace(/\|/g, '\\|')
  let md = `### ${title}\n\n`
  md += `| Predictor | Univariate OR (95% CI) | Univariate P | Adjusted aOR (95% CI) | Multivariate P |\n`
  md += `| :--- | :---: | :---: | :---: | :---: |\n`
  for (const c of covResults) {
    md += `| **${escMd(c.label)}** | ${c.univariate_or_formatted} | ${c.univariate_p_formatted} | ${c.or_formatted} | ${c.p_value_formatted} |\n`
  }
  md += `\n*Note*: Complete-case N = ${sample_size} (${events_count} events, ${event_rate}%). Model C-statistic (AUC) = ${auc.toFixed(3)}, Likelihood Ratio P = ${formatP(p_value_overall)}.`

  const sigFactors = covResults.filter(c => c.p_value < 0.05)
  const narrative = sigFactors.length > 0
    ? `In the multivariate binary logistic regression analysis of ${sample_size} patients (${events_count} outcome events, ${event_rate}%), ${sigFactors.map(s => `${s.label} (adjusted OR = ${s.or_formatted}, P = ${s.p_value_formatted})`).join('; ')} ${sigFactors.length === 1 ? 'was an independent predictor' : 'were independent predictors'} of ${labels[outcome_col] || outcome_col}. The multivariable model achieved a concordance statistic (AUC) of ${auc.toFixed(3)} (overall likelihood ratio P = ${formatP(p_value_overall)}).`
    : `In the multivariate binary logistic regression analysis of ${sample_size} patients (${events_count} outcome events, ${event_rate}%), none of the evaluated covariates reached statistical significance at the P < 0.05 threshold after mutual adjustment (model AUC = ${auc.toFixed(3)}).`

  const prismSpec: PrismTableSpec = {
    tableType: 'Forest',
    title: `${title} - Adjusted Odds Ratios`,
    rows: covResults.map(c => ({
      label: c.label,
      hr: c.or,
      ciLower: c.or_ci_lower,
      ciUpper: c.or_ci_upper,
      pValue: c.p_value,
    })),
  }

  const rScript = `# Reproducible Multivariate Logistic Regression & Forest Plot (R glm / forestploter)
# Outcome: ${outcome_col} (N = ${sample_size}, Events = ${events_count})
library(forestploter)
df_or <- data.frame(
  Variable = c(${covResults.map(c => JSON.stringify(c.label)).join(', ')}),
  OR = c(${covResults.map(c => c.or).join(', ')}),
  Lower = c(${covResults.map(c => c.or_ci_lower).join(', ')}),
  Upper = c(${covResults.map(c => c.or_ci_upper).join(', ')}),
  P_Value = c(${covResults.map(c => JSON.stringify(c.p_value_formatted)).join(', ')})
)
print(df_or)
`

  return {
    title,
    outcome_col,
    sample_size,
    events_count,
    event_rate,
    auc,
    p_value_overall,
    covariates: covResults,
    svg,
    markdown_table: md,
    narrative,
    native_exports: {
      illustrator_svg: upgradeSvgForIllustrator(svg, { title }),
      prism_pzfx: exportToPrismPzfx(prismSpec, title),
      r_script: rScript,
    },
  }
}

// ============================================================================
// 2. Grotta 堆叠百分比条形图与有序评分分布迁移图 (Grotta Bar / mRS Shift Analysis)
// ============================================================================

export interface GrottaOptions {
  /** 模式 A（组间横向对比）：分组列名（如 '第一次治疗方式'） */
  group_col?: string
  /** 模式 A（组间横向对比）：有序评分/等级列名（如 '闭塞程度' 或 '第一次治疗前mRS'） */
  score_col?: string
  /** 模式 B（纵向多时间点迁移）：按时间先后排列的多个评分列名（如 ['确诊时mRS', '入院mrs评分', '第一次治疗前mRS']） */
  timepoint_cols?: string[]
  /** 显式指定评分等级顺序（如 ['0', '1', '2', '3', '4', '5', '6'] 或 ['1', '2', '3', '0']） */
  score_order?: string[]
  /** 变量与等级显示标签映射 */
  labels?: Record<string, string>
  /** 图表标题 */
  title?: string
}

export interface GrottaBarRow {
  bar_key: string
  bar_label: string
  total_n: number
  counts: Record<string, number>
  percentages: Record<string, number>
}

export interface GrottaPlotResult {
  title: string
  mode: 'group_comparison' | 'longitudinal_shift'
  score_levels: Array<{ level: string; label: string; color: string }>
  bars: GrottaBarRow[]
  chi_square_p: number | null
  chi_square_p_formatted: string
  shift_test_method: string
  shift_p: number | null
  shift_p_formatted: string
  svg: string
  markdown_table: string
  narrative: string
  native_exports: {
    illustrator_svg: string
    prism_pzfx: string
    r_script: string
  }
}

/** 经典卒中 mRS / 神经外科结局有序渐变调色板（从最优绿/蓝到最差深红） */
const GROTTA_PALETTE = [
  '#0D9488', // Level 0: Teal (Best / mRS 0 / 完全闭塞)
  '#38BDF8', // Level 1: Sky Blue
  '#60A5FA', // Level 2: Blue
  '#FBBF24', // Level 3: Amber
  '#FB923C', // Level 4: Orange
  '#F43F5E', // Level 5: Rose
  '#881337', // Level 6: Deep Crimson
]

export function generateGrottaPlot(
  records: Array<Record<string, unknown>>,
  options: GrottaOptions,
): GrottaPlotResult {
  const {
    group_col,
    score_col,
    timepoint_cols,
    score_order,
    labels = {},
    title = timepoint_cols && timepoint_cols.length >= 2
      ? 'Longitudinal Ordinal Score Shift Analysis (Grotta Bars)'
      : `Ordinal Outcome Distribution${score_col ? `: ${labels[score_col] || score_col}` : ''}`,
  } = options

  const isLongitudinal = Array.isArray(timepoint_cols) && timepoint_cols.length >= 2
  if (!isLongitudinal && !score_col) {
    throw new Error('Grotta 图需要提供 score_col（配合可选 group_col），或提供至少 2 个时间点列 timepoint_cols')
  }

  // 1. 收集所有等级与各行统计
  const levelSet = new Set<string>()
  const rawBars: Array<{ key: string; label: string; values: string[] }> = []

  if (isLongitudinal) {
    for (const col of timepoint_cols!) {
      const vals: string[] = []
      for (const r of records) {
        const v = r[col]
        if (!isCellMissing(v)) {
          const s = String(v).trim()
          vals.push(s)
          levelSet.add(s)
        }
      }
      rawBars.push({ key: col, label: labels[col] || col, values: vals })
    }
  } else {
    const groupMap = new Map<string, string[]>()
    for (const r of records) {
      const sv = r[score_col!]
      if (isCellMissing(sv)) continue
      const gVal = group_col ? r[group_col] : 'Overall'
      if (group_col && isCellMissing(gVal)) continue
      const gKey = group_col ? String(gVal).trim() : 'Overall'
      const sStr = String(sv).trim()
      levelSet.add(sStr)
      if (!groupMap.has(gKey)) groupMap.set(gKey, [])
      groupMap.get(gKey)!.push(sStr)
    }
    const sortedGroups = Array.from(groupMap.keys()).sort((a, b) => (groupMap.get(b)?.length ?? 0) - (groupMap.get(a)?.length ?? 0))
    for (const g of sortedGroups) {
      rawBars.push({
        key: g,
        label: labels[`${group_col}.${g}`] ?? labels[g] ?? g,
        values: groupMap.get(g) ?? [],
      })
    }
  }

  const orderedLevels = score_order && score_order.length > 0
    ? score_order.filter(l => levelSet.has(l)).concat(Array.from(levelSet).filter(l => !score_order.includes(l)))
    : Array.from(levelSet).sort((a, b) => {
        const na = Number(a)
        const nb = Number(b)
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
        return a.localeCompare(b)
      })

  const score_levels = orderedLevels.map((lvl, idx) => ({
    level: lvl,
    label: (score_col && labels[`${score_col}.${lvl}`]) || labels[lvl] || lvl,
    color: GROTTA_PALETTE[idx % GROTTA_PALETTE.length]!,
  }))

  const bars: GrottaBarRow[] = rawBars.map(b => {
    const counts: Record<string, number> = Object.create(null)
    const percentages: Record<string, number> = Object.create(null)
    for (const lvl of orderedLevels) counts[lvl] = 0
    for (const v of b.values) {
      if (counts[v] !== undefined) counts[v]++
    }
    const total = b.values.length
    for (const lvl of orderedLevels) {
      percentages[lvl] = total > 0 ? Number(((counts[lvl]! / total) * 100).toFixed(1)) : 0
    }
    return {
      bar_key: b.key,
      bar_label: b.label,
      total_n: total,
      counts,
      percentages,
    }
  })

  // 2. 显著性检验：卡方检验 + 有序秩和检验 (Mann-Whitney U / Kruskal-Wallis)
  let chi_square_p: number | null = null
  let shift_p: number | null = null
  let shift_test_method = 'Kruskal-Wallis ordinal shift test'

  if (bars.length >= 2 && orderedLevels.length >= 2) {
    const matrix = orderedLevels.map(lvl => bars.map(b => b.counts[lvl] ?? 0))
    chi_square_p = chiSquareOrFisher(matrix).p

    const rankOf = new Map<string, number>()
    orderedLevels.forEach((lvl, idx) => rankOf.set(lvl, idx))
    const rankGroups = rawBars.map(b => b.values.map(v => rankOf.get(v) ?? 0))
    if (rankGroups.length === 2) {
      shift_test_method = 'Mann-Whitney U ordinal shift test'
      shift_p = mannWhitneyUTest(rankGroups[0]!, rankGroups[1]!).p
    } else {
      shift_test_method = 'Kruskal-Wallis ordinal shift test'
      shift_p = kruskalWallisTest(rankGroups).p
    }
  }

  // 3. 绘制 Grotta 100% 堆叠水平条形图 + 层间连接流带 SVG
  const W = 760
  const barH = 34
  const barGap = 28
  const margin = { top: 68, right: 35, bottom: 52, left: 165 }
  const plotW = W - margin.left - margin.right
  const plotH = Math.max(1, bars.length) * barH + Math.max(0, bars.length - 1) * barGap
  const H = margin.top + plotH + margin.bottom

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #ffffff;">`
  svg += `<text x="20" y="24" font-size="14.5" font-weight="700" fill="#111827">${escXml(title)}</text>`
  if (shift_p !== null) {
    svg += `<text x="${W - 35}" y="24" font-size="11.5" font-weight="700" fill="#047857" text-anchor="end">${escXml(shift_test_method)} P = ${escXml(formatP(shift_p))}</text>`
  }

  // 顶部图例
  let legX = margin.left
  const legY = 44
  for (const sl of score_levels) {
    svg += `<rect x="${legX}" y="${legY - 9}" width="12" height="12" rx="2" fill="${sl.color}"/>`
    const txt = `${sl.label}`
    svg += `<text x="${legX + 16}" y="${legY + 1}" font-size="11" font-weight="600" fill="#374151">${escXml(txt)}</text>`
    legX += 26 + txt.length * 7.5
  }

  // 预计算每个 bar 每个 level 的起止 X 坐标，用于画连接流带
  const barSegments: Array<Array<{ x0: number; x1: number; color: string; pct: number; cnt: number }>> = []
  bars.forEach(b => {
    let curPct = 0
    const segs: Array<{ x0: number; x1: number; color: string; pct: number; cnt: number }> = []
    for (const sl of score_levels) {
      const cnt = b.counts[sl.level] ?? 0
      const pct = b.total_n > 0 ? (cnt / b.total_n) * 100 : 0
      const x0 = margin.left + (curPct / 100) * plotW
      curPct += pct
      const x1 = margin.left + (curPct / 100) * plotW
      segs.push({ x0, x1, color: sl.color, pct, cnt })
    }
    barSegments.push(segs)
  })

  // 先画相邻条形之间的半透明 Grotta 迁移连带 (Shift Ribbons)
  for (let i = 0; i < bars.length - 1; i++) {
    const yTop = margin.top + i * (barH + barGap) + barH
    const yBot = margin.top + (i + 1) * (barH + barGap)
    const segTop = barSegments[i]!
    const segBot = barSegments[i + 1]!
    for (let k = 0; k < score_levels.length; k++) {
      const s1 = segTop[k]!
      const s2 = segBot[k]!
      if (s1.pct <= 0 && s2.pct <= 0) continue
      const pts = `${s1.x0},${yTop} ${s1.x1},${yTop} ${s2.x1},${yBot} ${s2.x0},${yBot}`
      svg += `<polygon points="${pts}" fill="${s1.color}" fill-opacity="0.18" stroke="${s1.color}" stroke-opacity="0.35" stroke-width="0.8"/>`
    }
  }

  // 再画每条 100% 堆叠水平条形与内部百分比标签
  bars.forEach((b, i) => {
    const y = margin.top + i * (barH + barGap)
    svg += `<text x="${margin.left - 12}" y="${y + barH / 2 + 4}" font-size="11.5" font-weight="600" fill="#1F2937" text-anchor="end">${escXml(b.bar_label)} (n=${b.total_n})</text>`
    const segs = barSegments[i]!
    for (const seg of segs) {
      const w = Math.max(0, seg.x1 - seg.x0)
      if (w <= 0) continue
      svg += `<rect x="${seg.x0}" y="${y}" width="${w}" height="${barH}" fill="${seg.color}" stroke="#ffffff" stroke-width="1"/>`
      if (seg.pct >= 6.5) {
        svg += `<text x="${seg.x0 + w / 2}" y="${y + barH / 2 + 4}" font-size="10.5" font-weight="700" fill="#ffffff" text-anchor="middle">${seg.pct.toFixed(1)}%</text>`
      }
    }
  })

  // 底部 0% ~ 100% 坐标轴
  const axisY = margin.top + plotH + 8
  svg += `<line x1="${margin.left}" y1="${axisY}" x2="${margin.left + plotW}" y2="${axisY}" stroke="#D1D5DB" stroke-width="1.2"/>`
  for (let p = 0; p <= 100; p += 20) {
    const x = margin.left + (p / 100) * plotW
    svg += `<line x1="${x}" y1="${axisY}" x2="${x}" y2="${axisY + 5}" stroke="#9CA3AF" stroke-width="1"/>`
    svg += `<text x="${x}" y="${axisY + 18}" font-size="10.5" fill="#4B5563" text-anchor="middle">${p}%</text>`
  }
  svg += `<text x="${margin.left + plotW / 2}" y="${axisY + 36}" font-size="11.5" font-weight="600" fill="#374151" text-anchor="middle">Proportion of Patients (%)</text>`
  svg += `</svg>`

  // 4. 生成 Markdown 表格与学术述评
  const escMd = (s: string) => String(s).replace(/\|/g, '\\|')
  let md = `### ${title}\n\n`
  md += `| Group / Timepoint | Total (N) | ${score_levels.map(s => escMd(s.label)).join(' | ')} |\n`
  md += `| :--- | :---: | ${score_levels.map(() => ':---:').join(' | ')} |\n`
  for (const b of bars) {
    const cells = score_levels.map(s => `${b.counts[s.level] ?? 0} (${(b.percentages[s.level] ?? 0).toFixed(1)}%)`)
    md += `| **${escMd(b.bar_label)}** | ${b.total_n} | ${cells.join(' | ')} |\n`
  }

  const topLvl = score_levels[0]
  const narrative = topLvl && bars.length >= 2
    ? `Ordinal distribution analysis across ${bars.length} ${isLongitudinal ? 'timepoints' : 'groups'} demonstrated ${shift_p !== null && shift_p < 0.05 ? 'a statistically significant shift' : 'the following distribution'} (${shift_test_method} P = ${formatP(shift_p)}, Chi-square P = ${formatP(chi_square_p)}). The proportion in category "${topLvl.label}" was ${bars.map(b => `${(b.percentages[topLvl.level] ?? 0).toFixed(1)}% (${b.counts[topLvl.level] ?? 0}/${b.total_n}) in ${b.bar_label}`).join(', ')}.`
    : `Ordinal distribution was summarized across ${bars.length} ${isLongitudinal ? 'timepoints' : 'cohorts'}.`

  const prismSpec: PrismTableSpec = {
    tableType: 'Column',
    title,
    groups: bars.map(b => ({
      name: b.bar_label,
      values: score_levels.map(s => b.percentages[s.level] ?? 0),
    })),
  }

  const rScript = `# Reproducible Grotta Stacked Horizontal Bar Chart (R ggplot2)
library(ggplot2)
# Shift Test: ${shift_test_method} P = ${formatP(shift_p)}
`

  return {
    title,
    mode: isLongitudinal ? 'longitudinal_shift' : 'group_comparison',
    score_levels,
    bars,
    chi_square_p,
    chi_square_p_formatted: formatP(chi_square_p),
    shift_test_method,
    shift_p,
    shift_p_formatted: formatP(shift_p),
    svg,
    markdown_table: md,
    narrative,
    native_exports: {
      illustrator_svg: upgradeSvgForIllustrator(svg, { title }),
      prism_pzfx: exportToPrismPzfx(prismSpec, title),
      r_script: rScript,
    },
  }
}

// ============================================================================
// 3. 多阶段序贯治疗路径与结局流向桑基图 (Sankey / Alluvial Diagram)
// ============================================================================

export interface SankeyOptions {
  /** 按阶段顺序排列的列名列表（如 ['第一次治疗方式', '栓塞策略', '闭塞程度']），至少 2 列 */
  stage_cols?: string[]
  /**
   * 可选：多位数序贯治疗编码列（如 `治疗方式` 列中的 '32' 表示第 1 阶段=3、第 2 阶段=2）；
   * 若提供 `sequence_col`，自动将其拆解为 Stage 1 / Stage 2 / Stage 3，并可串联 `outcome_col`。
   */
  sequence_col?: string
  /** 配合 `sequence_col` 的单字符代码映射（如 { '0': '保守观察', '1': '手术切除', '2': '伽玛刀', '3': '介入栓塞' }） */
  code_map?: Record<string, string>
  /** 配合 `sequence_col` 的终点结局列（如 '闭塞程度' 或 '治疗后出血'） */
  outcome_col?: string
  /** 每个阶段最多保留的独立节点数（超出部分归入 '其他'，默认 7） */
  max_nodes_per_stage?: number
  /** 显示名称映射 */
  labels?: Record<string, string>
  /** 图表标题 */
  title?: string
}

export interface SankeyNode {
  stage_index: number
  stage_name: string
  node_key: string
  label: string
  count: number
  percentage: number
  color: string
}

export interface SankeyLink {
  source_stage: number
  source_key: string
  target_stage: number
  target_key: string
  count: number
}

export interface SankeyDiagramResult {
  title: string
  total_n: number
  stages: string[]
  nodes: SankeyNode[]
  links: SankeyLink[]
  svg: string
  markdown_table: string
  narrative: string
  native_exports: {
    illustrator_svg: string
    r_script: string
  }
}

const SANKEY_COLORS = [
  '#0D9488',
  '#2563EB',
  '#7C3AED',
  '#D97706',
  '#E11D48',
  '#059669',
  '#4F46E5',
  '#64748B',
]

export function generateSankeyDiagram(
  records: Array<Record<string, unknown>>,
  options: SankeyOptions,
): SankeyDiagramResult {
  const {
    stage_cols,
    sequence_col,
    code_map = { '0': '保守观察', '1': '手术切除', '2': '伽玛刀', '3': '介入栓塞' },
    outcome_col,
    max_nodes_per_stage = 7,
    labels = {},
    title = 'Multimodal Treatment Trajectory & Clinical Outcome Sankey Diagram',
  } = options

  // 1. 构建每名患者的阶段路径数组
  let stageNames: string[] = []
  const trajectories: string[][] = []

  if (sequence_col) {
    stageNames = ['首次干预 (Stage 1)', '二阶段序贯 (Stage 2)']
    if (outcome_col) stageNames.push(labels[outcome_col] || outcome_col)

    for (const r of records) {
      const rawSeq = r[sequence_col]
      if (isCellMissing(rawSeq)) continue
      if (outcome_col && isCellMissing(r[outcome_col])) continue
      const seqStr = String(rawSeq).trim()
      const chars = seqStr.split('').filter(ch => /\S/.test(ch))
      if (!chars.length) continue
      const s1 = code_map[chars[0]!] || chars[0]!
      const s2 = chars.length >= 2
        ? `序贯: ${chars.slice(1).map(c => code_map[c] || c).join('→')}`
        : '单阶段完成'
      const path = [s1, s2]
      if (outcome_col) {
        const outRaw = String(r[outcome_col]).trim()
        path.push(labels[`${outcome_col}.${outRaw}`] || labels[outRaw] || outRaw)
      }
      trajectories.push(path)
    }
  } else if (Array.isArray(stage_cols) && stage_cols.length >= 2) {
    stageNames = stage_cols.map(c => labels[c] || c)
    for (const r of records) {
      let ok = true
      const path: string[] = []
      for (const col of stage_cols) {
        const v = r[col]
        if (isCellMissing(v)) {
          ok = false
          break
        }
        const raw = String(v).trim()
        path.push(labels[`${col}.${raw}`] || labels[raw] || raw)
      }
      if (ok) trajectories.push(path)
    }
  } else {
    throw new Error('桑基图需要提供至少 2 列的 stage_cols，或提供 sequence_col')
  }

  const total_n = trajectories.length
  const numStages = stageNames.length

  // 2. 控制每个阶段的节点数上限（低频尾节点归入 'Other'）
  for (let s = 0; s < numStages; s++) {
    const counts = new Map<string, number>()
    for (const t of trajectories) {
      const val = t[s]!
      counts.set(val, (counts.get(val) ?? 0) + 1)
    }
    if (counts.size > max_nodes_per_stage) {
      const keep = new Set(
        Array.from(counts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, max_nodes_per_stage - 1)
          .map(e => e[0]),
      )
      for (const t of trajectories) {
        if (!keep.has(t[s]!)) t[s] = '其他 (Other)'
      }
    }
  }

  // 3. 统计各阶段节点与阶段间流向频数
  const nodes: SankeyNode[] = []
  const stageNodeList: SankeyNode[][] = []

  for (let s = 0; s < numStages; s++) {
    const counts = new Map<string, number>()
    for (const t of trajectories) {
      const k = t[s]!
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
    const sNodes: SankeyNode[] = sorted.map(([k, cnt], idx) => ({
      stage_index: s,
      stage_name: stageNames[s]!,
      node_key: k,
      label: k,
      count: cnt,
      percentage: total_n > 0 ? Number(((cnt / total_n) * 100).toFixed(1)) : 0,
      color: SANKEY_COLORS[(s * 2 + idx) % SANKEY_COLORS.length]!,
    }))
    stageNodeList.push(sNodes)
    nodes.push(...sNodes)
  }

  const links: SankeyLink[] = []
  for (let s = 0; s < numStages - 1; s++) {
    const pairCounts = new Map<string, number>()
    for (const t of trajectories) {
      const key = `${t[s]!}\u0000${t[s + 1]!}`
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
    }
    for (const [pairKey, cnt] of pairCounts.entries()) {
      const [src, dst] = pairKey.split('\u0000')
      links.push({
        source_stage: s,
        source_key: src!,
        target_stage: s + 1,
        target_key: dst!,
        count: cnt,
      })
    }
  }

  // 4. 渲染出版级 Alluvial / Sankey 矢量 SVG
  const W = 780
  const H = 480
  const margin = { top: 64, right: 145, bottom: 36, left: 145 }
  const plotW = W - margin.left - margin.right
  const plotH = H - margin.top - margin.bottom
  const nodeW = 18
  const nodeGap = 14

  const nodeGeom = new Map<string, { x: number; y: number; h: number; color: string; outOffset: number; inOffset: number }>()
  for (let s = 0; s < numStages; s++) {
    const sNodes = stageNodeList[s]!
    const x = margin.left + (numStages > 1 ? (s / (numStages - 1)) * (plotW - nodeW) : 0)
    const availH = Math.max(80, plotH - Math.max(0, sNodes.length - 1) * nodeGap)
    let curY = margin.top
    for (const n of sNodes) {
      const h = total_n > 0 ? Math.max(8, (n.count / total_n) * availH) : 20
      nodeGeom.set(`${s}:${n.node_key}`, { x, y: curY, h, color: n.color, outOffset: 0, inOffset: 0 })
      curY += h + nodeGap
    }
  }

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #ffffff;">`
  svg += `<text x="20" y="24" font-size="14.5" font-weight="700" fill="#111827">${escXml(title)}</text>`
  svg += `<text x="${W - 20}" y="24" font-size="11.5" fill="#6B7280" text-anchor="end">Total Cohort N = ${total_n}</text>`

  // 阶段标题
  for (let s = 0; s < numStages; s++) {
    const x = margin.left + (numStages > 1 ? (s / (numStages - 1)) * (plotW - nodeW) : 0) + nodeW / 2
    svg += `<text x="${x}" y="48" font-size="12" font-weight="700" fill="#374151" text-anchor="middle">${escXml(stageNames[s])}</text>`
  }

  // 绘制三次贝塞尔流向带
  for (const lk of links) {
    const srcG = nodeGeom.get(`${lk.source_stage}:${lk.source_key}`)
    const dstG = nodeGeom.get(`${lk.target_stage}:${lk.target_key}`)
    const srcNode = stageNodeList[lk.source_stage]?.find(n => n.node_key === lk.source_key)
    const dstNode = stageNodeList[lk.target_stage]?.find(n => n.node_key === lk.target_key)
    if (!srcG || !dstG || !srcNode || !dstNode) continue

    const hSrc = srcNode.count > 0 ? (lk.count / srcNode.count) * srcG.h : 0
    const hDst = dstNode.count > 0 ? (lk.count / dstNode.count) * dstG.h : 0
    const y0Top = srcG.y + srcG.outOffset
    const y0Bot = y0Top + hSrc
    srcG.outOffset += hSrc

    const y1Top = dstG.y + dstG.inOffset
    const y1Bot = y1Top + hDst
    dstG.inOffset += hDst

    const x0 = srcG.x + nodeW
    const x1 = dstG.x
    const xMid = (x0 + x1) / 2

    const d = [
      `M ${x0} ${y0Top}`,
      `C ${xMid} ${y0Top}, ${xMid} ${y1Top}, ${x1} ${y1Top}`,
      `L ${x1} ${y1Bot}`,
      `C ${xMid} ${y1Bot}, ${xMid} ${y0Bot}, ${x0} ${y0Bot}`,
      'Z',
    ].join(' ')
    svg += `<path d="${d}" fill="${srcG.color}" fill-opacity="0.26" stroke="${srcG.color}" stroke-opacity="0.4" stroke-width="0.6"/>`
  }

  // 绘制节点柱与标签
  for (let s = 0; s < numStages; s++) {
    for (const n of stageNodeList[s]!) {
      const g = nodeGeom.get(`${s}:${n.node_key}`)!
      svg += `<rect x="${g.x}" y="${g.y}" width="${nodeW}" height="${g.h}" rx="3" fill="${g.color}" stroke="#ffffff" stroke-width="1"/>`
      const isLeft = s === 0
      const isRight = s === numStages - 1
      const labelX = isLeft ? g.x - 8 : isRight ? g.x + nodeW + 8 : g.x + nodeW / 2
      const anchor = isLeft ? 'end' : isRight ? 'start' : 'middle'
      const labelY = g.y + g.h / 2 + 4
      svg += `<text x="${labelX}" y="${labelY}" font-size="11" font-weight="600" fill="#1F2937" text-anchor="${anchor}">${escXml(n.label)} (${n.count}, ${n.percentage}%)</text>`
    }
  }

  svg += `</svg>`

  // 5. 生成流向汇总表与论文述评
  const escMd = (s: string) => String(s).replace(/\|/g, '\\|')
  const sortedLinks = [...links].sort((a, b) => b.count - a.count)
  let md = `### ${title}\n\n`
  md += `| From Stage | Source Node | To Stage | Target Node | Patients (n, %) |\n`
  md += `| :--- | :--- | :--- | :--- | :---: |\n`
  for (const lk of sortedLinks.slice(0, 20)) {
    const pct = total_n > 0 ? ((lk.count / total_n) * 100).toFixed(1) : '0.0'
    md += `| ${escMd(stageNames[lk.source_stage]!)} | **${escMd(lk.source_key)}** | ${escMd(stageNames[lk.target_stage]!)} | **${escMd(lk.target_key)}** | ${lk.count} (${pct}%) |\n`
  }

  const topFlows = sortedLinks.slice(0, 3)
  const narrative = topFlows.length > 0
    ? `Across the cohort of ${total_n} patients tracked through ${stageNames.join(' → ')}, the predominant clinical pathways were ${topFlows.map(f => `${f.source_key} → ${f.target_key} (n = ${f.count}, ${((f.count / total_n) * 100).toFixed(1)}%)`).join(', ')}.`
    : `Patient trajectories were mapped across ${stageNames.length} clinical stages (N = ${total_n}).`

  const rScript = `# Reproducible Alluvial / Sankey Diagram (R ggalluvial)
library(ggplot2)
library(ggalluvial)
# Total N = ${total_n}, Stages: ${stageNames.join(' -> ')}
`

  return {
    title,
    total_n,
    stages: stageNames,
    nodes,
    links: sortedLinks,
    svg,
    markdown_table: md,
    narrative,
    native_exports: {
      illustrator_svg: upgradeSvgForIllustrator(svg, { title }),
      r_script: rScript,
    },
  }
}

// ============================================================================
// 4. 多部位解剖受累共现交集与结局发生率联动图 (UpSet Co-occurrence Plot)
// ============================================================================

export interface UpSetOptions {
  /** 0/1 二分类解剖部位或合并症列名列表（如 ['额叶', '颞叶', '顶叶', '枕叶', '小脑', '基底节', '脑干']） */
  binary_cols: string[]
  /** 可选：叠加计算的二元临床结局列名（如 '治疗后出血' 或 '围术期不良事件'） */
  outcome_col?: string
  /** 结局阳性值（可选，同 LogisticOptions.positive_value） */
  positive_value?: string | number
  /** 最多展示前 N 个高频共现组合（默认 12） */
  max_intersections?: number
  /** 显示名称映射 */
  labels?: Record<string, string>
  /** 图表标题 */
  title?: string
}

export interface UpSetRegionSummary {
  col: string
  label: string
  count: number
  percentage: number
  events: number
  event_rate: number
}

export interface UpSetIntersection {
  key: string
  active_cols: string[]
  label: string
  degree: number
  count: number
  percentage: number
  events: number
  event_rate: number
}

export interface UpSetPlotResult {
  title: string
  total_n: number
  single_region_n: number
  multi_region_n: number
  multi_vs_single_p: number | null
  regions: UpSetRegionSummary[]
  intersections: UpSetIntersection[]
  svg: string
  markdown_table: string
  narrative: string
  native_exports: {
    illustrator_svg: string
    r_script: string
  }
}

export function generateUpSetPlot(
  records: Array<Record<string, unknown>>,
  options: UpSetOptions,
): UpSetPlotResult {
  const {
    binary_cols,
    outcome_col,
    positive_value,
    max_intersections = 12,
    labels = {},
    title = 'Anatomical Location Co-occurrence & Clinical Outcome UpSet Analysis',
  } = options

  const cols = binary_cols.filter(Boolean)
  if (cols.length < 2) {
    throw new Error('UpSet 共现分析至少需要提供 2 个二分类部位/特征列 (binary_cols)')
  }

  const isPositive = (v: unknown): boolean => {
    if (isCellMissing(v)) return false
    const s = String(v).trim().toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === '是' || s === '阳性' || Number(s) > 0
  }

  const isOutcomeEvent = (v: unknown): boolean => {
    if (!outcome_col || isCellMissing(v)) return false
    if (positive_value !== undefined && positive_value !== null && String(positive_value).trim() !== '') {
      return String(v).trim() === String(positive_value).trim()
    }
    return normalizeEventStatus(v) === 1
  }

  const total_n = records.length
  const regionMap = new Map<string, { count: number; events: number }>()
  for (const c of cols) regionMap.set(c, { count: 0, events: 0 })

  const interMap = new Map<string, { active: string[]; count: number; events: number }>()
  let single_region_n = 0
  let single_events = 0
  let multi_region_n = 0
  let multi_events = 0

  for (const r of records) {
    const active: string[] = []
    const ev = outcome_col ? isOutcomeEvent(r[outcome_col]) : false
    for (const c of cols) {
      if (isPositive(r[c])) {
        active.push(c)
        const st = regionMap.get(c)!
        st.count++
        if (ev) st.events++
      }
    }
    if (active.length === 0) continue
    if (active.length === 1) {
      single_region_n++
      if (ev) single_events++
    } else {
      multi_region_n++
      if (ev) multi_events++
    }
    const key = active.join('+')
    const cur = interMap.get(key) ?? { active, count: 0, events: 0 }
    cur.count++
    if (ev) cur.events++
    interMap.set(key, cur)
  }

  let multi_vs_single_p: number | null = null
  if (outcome_col && single_region_n > 0 && multi_region_n > 0) {
    multi_vs_single_p = chiSquareOrFisher([
      [single_events, single_region_n - single_events],
      [multi_events, multi_region_n - multi_events],
    ]).p
  }

  const regions: UpSetRegionSummary[] = cols
    .map(c => {
      const st = regionMap.get(c)!
      return {
        col: c,
        label: labels[c] || c,
        count: st.count,
        percentage: total_n > 0 ? Number(((st.count / total_n) * 100).toFixed(1)) : 0,
        events: st.events,
        event_rate: st.count > 0 ? Number(((st.events / st.count) * 100).toFixed(1)) : 0,
      }
    })
    .sort((a, b) => b.count - a.count)

  const intersections: UpSetIntersection[] = Array.from(interMap.entries())
    .map(([key, v]) => ({
      key,
      active_cols: v.active,
      label: v.active.map(c => labels[c] || c).join(' + '),
      degree: v.active.length,
      count: v.count,
      percentage: total_n > 0 ? Number(((v.count / total_n) * 100).toFixed(1)) : 0,
      events: v.events,
      event_rate: v.count > 0 ? Number(((v.events / v.count) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, max_intersections)

  // 绘制 UpSet 上下联动矩阵 SVG
  const numInter = Math.max(1, intersections.length)
  const numReg = regions.length
  const colW = 38
  const rowH = 22
  const leftBarW = 110
  const labelW = 90
  const matrixLeft = 20 + leftBarW + labelW
  const topBarH = 165
  const matrixTop = 64 + topBarH + 22
  const W = Math.max(680, matrixLeft + numInter * colW + 40)
  const H = matrixTop + numReg * rowH + 42

  const maxInterCnt = Math.max(1, ...intersections.map(i => i.count))
  const maxRegCnt = Math.max(1, ...regions.map(r => r.count))

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #ffffff;">`
  svg += `<text x="20" y="24" font-size="14.5" font-weight="700" fill="#111827">${escXml(title)}</text>`
  svg += `<text x="20" y="42" font-size="11" fill="#6B7280">Single-region: n=${single_region_n} | Multi-region (≥2): n=${multi_region_n}${outcome_col ? ` | Outcome: ${labels[outcome_col] || outcome_col}` : ''}</text>`

  // 上方：Intersection Size 垂直柱状图
  const barBaseY = 64 + topBarH
  svg += `<line x1="${matrixLeft}" y1="${barBaseY}" x2="${matrixLeft + numInter * colW}" y2="${barBaseY}" stroke="#D1D5DB" stroke-width="1.2"/>`
  intersections.forEach((inter, idx) => {
    const cx = matrixLeft + idx * colW + colW / 2
    const bh = (inter.count / maxInterCnt) * (topBarH - 28)
    const by = barBaseY - bh
    const barColor = inter.degree > 1 ? '#2563EB' : '#0D9488'
    svg += `<rect x="${cx - 11}" y="${by}" width="22" height="${bh}" rx="2" fill="${barColor}"/>`
    svg += `<text x="${cx}" y="${by - 6}" font-size="10" font-weight="700" fill="#1F2937" text-anchor="middle">${inter.count}</text>`
    if (outcome_col && inter.events > 0) {
      svg += `<text x="${cx}" y="${by - 17}" font-size="9" font-weight="600" fill="#E11D48" text-anchor="middle">${inter.event_rate}%</text>`
    }
  })

  // 左下：各部位总受累频数水平条形图 + 部位名称
  regions.forEach((reg, rIdx) => {
    const ry = matrixTop + rIdx * rowH + rowH / 2
    if (rIdx % 2 === 0) {
      svg += `<rect x="${matrixLeft}" y="${ry - rowH / 2}" width="${numInter * colW}" height="${rowH}" fill="#F9FAFB"/>`
    }
    const bw = (reg.count / maxRegCnt) * (leftBarW - 25)
    const bx = 20 + leftBarW - bw
    svg += `<rect x="${bx}" y="${ry - 6}" width="${bw}" height="12" rx="2" fill="#475569"/>`
    svg += `<text x="${bx - 4}" y="${ry + 3.5}" font-size="9.5" fill="#4B5563" text-anchor="end">${reg.count}</text>`
    svg += `<text x="${20 + leftBarW + labelW - 10}" y="${ry + 4}" font-size="11" font-weight="600" fill="#1F2937" text-anchor="end">${escXml(reg.label)}</text>`
  })

  // 右下：UpSet 交集点阵与垂直连线
  intersections.forEach((inter, cIdx) => {
    const cx = matrixLeft + cIdx * colW + colW / 2
    const activeSet = new Set(inter.active_cols)
    const activeRows: number[] = []

    regions.forEach((reg, rIdx) => {
      const cy = matrixTop + rIdx * rowH + rowH / 2
      if (activeSet.has(reg.col)) {
        activeRows.push(cy)
      } else {
        svg += `<circle cx="${cx}" cy="${cy}" r="4" fill="#E5E7EB"/>`
      }
    })

    if (activeRows.length >= 2) {
      const yMin = Math.min(...activeRows)
      const yMax = Math.max(...activeRows)
      svg += `<line x1="${cx}" y1="${yMin}" x2="${cx}" y2="${yMax}" stroke="#1E293B" stroke-width="2.2"/>`
    }
    for (const cy of activeRows) {
      svg += `<circle cx="${cx}" cy="${cy}" r="5" fill="#1E293B"/>`
    }
  })

  svg += `</svg>`

  const escMd = (s: string) => String(s).replace(/\|/g, '\\|')
  let md = `### ${title}\n\n`
  md += `| Combination / Pattern | Regions Involved | Patients (n, %) |${outcome_col ? ` Outcome Events (n, %) |` : ''}\n`
  md += `| :--- | :---: | :---: |${outcome_col ? ' :---: |' : ''}\n`
  for (const inter of intersections) {
    md += `| **${escMd(inter.label)}** | ${inter.degree} | ${inter.count} (${inter.percentage}%) |${outcome_col ? ` ${inter.events} (${inter.event_rate}%) |` : ''}\n`
  }

  const topInter = intersections.slice(0, 3)
  const narrative = `Co-occurrence analysis across ${cols.length} binary anatomical/clinical features (N = ${total_n}) identified ${single_region_n} single-region cases and ${multi_region_n} multi-region (≥2) cases. The most frequent patterns were ${topInter.map(i => `${i.label} (n = ${i.count}, ${i.percentage}%)`).join(', ')}.${outcome_col && multi_vs_single_p !== null ? ` Comparing multi-region versus single-region involvement for ${labels[outcome_col] || outcome_col} yielded P = ${formatP(multi_vs_single_p)}.` : ''}`

  const rScript = `# Reproducible UpSet Co-occurrence Plot (R ComplexUpset / UpSetR)
library(UpSetR)
# Regions: ${cols.join(', ')}
`

  return {
    title,
    total_n,
    single_region_n,
    multi_region_n,
    multi_vs_single_p,
    regions,
    intersections,
    svg,
    markdown_table: md,
    narrative,
    native_exports: {
      illustrator_svg: upgradeSvgForIllustrator(svg, { title }),
      r_script: rScript,
    },
  }
}
