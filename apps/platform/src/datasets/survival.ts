/**
 * 临床科研生存分析 (Survival Analysis) 与危险度回归套件
 * 
 * 严格遵循 NEJM / Lancet / JAMA / JCO 等医学顶刊标准：
 * - Kaplan-Meier (KM) 累积生存率曲线拟合（阶梯衰减、Greenwood 公式 95% CI、中位生存时间与四分位计算）；
 * - 多组分层比较与 Log-rank 显著性检验（Mantel-Haenszel 检验量与精确 P 值）；
 * - 单变量与多变量 Cox 比例风险回归模型 (Cox Proportional Hazards Model) 与 Harrell's C-index 评估；
 * - 风险集随时间统计表 (Number at Risk Table)；
 * - 医学出版级高清矢量 SVG 渲染：KM 生存曲线（含删失标记、置信区间、风险表）与 Cox 风险比森林图 (Forest Plot)；
 * - 纯 TypeScript 零外部依赖，毫秒级计算，支持结构化 JSON、Markdown 报告及 DocOp 写入。
 */

import { chiSquareUpperPValue, normalCdf } from './table1.ts'

export interface SurvivalOptions {
  /** 随访生存时间列名（天、月或年，数值型，如 'os_months', 'pfs_days'） */
  time_col: string
  /** 结局事件状态列名（数值 1=发生事件, 0=删失；或字符 '1'/'0', 'dead'/'censored', 'yes'/'no'） */
  event_col: string
  /** 分组分层变量列名（如 'treatment', 'ham_status', 'gene_mutation'）；不传时评估 Overall 总体 */
  group_col?: string
  /** 多变量 Cox 回归协变量列表（如 ['age', 'stage', 'treatment']） */
  covariates?: string[]
  /** 随访时间物理单位（默认 'Months'，可选 'Days', 'Weeks', 'Years'） */
  time_unit?: string
  /** 关键里程碑时间点评估（如 [12, 24, 36, 60] 个月的累积生存率） */
  milestones?: number[]
  /** 变量名与组名显示别名映射（如 { os_months: '总生存期 (月)', treatment: '治疗方案', '1': '靶向联合', '0': '标准对照' }） */
  labels?: Record<string, string>
  /** 图表标题 */
  title?: string
  /** 是否在 KM 曲线中绘制删失点 '+' 标记（默认 true） */
  show_censored?: boolean
  /** 是否生成并包含对齐的 Number at risk 风险表（默认 true） */
  show_risk_table?: boolean
}

export interface KmTimePoint {
  /** 时间点 */
  time: number
  /** 处于风险中的样本数 (Number at risk) */
  n_risk: number
  /** 在此时间点发生事件的人数 (Events) */
  n_event: number
  /** 在此时间点被删失的人数 (Censored) */
  n_censor: number
  /** 累积生存概率 S(t) (0 ~ 1) */
  surv: number
  /** Greenwood 标准误 */
  std_err: number
  /** 95% 置信区间下限 */
  ci_lower: number
  /** 95% 置信区间上限 */
  ci_upper: number
}

export interface KmGroupResult {
  /** 组标识名 */
  group: string
  /** 组别显示标签 */
  label: string
  /** 该组总样本量 N */
  total_n: number
  /** 发生事件数 */
  events_n: number
  /** 删失样本数 */
  censored_n: number
  /** 事件发生率 (%) */
  event_rate: number
  /** 中位生存时间 (Median Survival Time)；若未达 50% 死亡则为 null (表示 Not Reached) */
  median_time: number | null
  /** 中位生存时间 95% CI [lower, upper] */
  median_ci: [number | null, number | null]
  /** 25% 分位与 75% 分位生存时间 */
  q25_time: number | null
  q75_time: number | null
  /** 里程碑时间点生存率 */
  milestone_survival: Record<number, { surv: number; ci_lower: number; ci_upper: number; surv_formatted: string }>
  /** 阶梯时间线明细 */
  timeline: KmTimePoint[]
}

export interface LogRankResult {
  /** 卡方统计量 Chi-Square */
  chi2: number
  /** 自由度 df */
  df: number
  /** 精确 P 值 */
  p_value: number
  /** 格式化 P 值 (如 '< 0.001' 或 '0.024') */
  p_value_formatted: string
  /** 各组观察值与期望值统计 */
  group_stats: Array<{
    group: string
    label: string
    observed: number
    expected: number
    ratio: number // O / E
  }>
}

export interface CoxCovariateResult {
  /** 变量名 */
  variable: string
  /** 显示标签 */
  label: string
  /** 回归系数 beta */
  beta: number
  /** 系数标准误 SE */
  se: number
  /** Wald 统计量 z */
  z: number
  /** P 值 */
  p_value: number
  p_value_formatted: string
  /** 风险比 Hazard Ratio (exp(beta)) */
  hr: number
  /** 95% CI 下限 */
  hr_ci_lower: number
  /** 95% CI 上限 */
  hr_ci_upper: number
  /** 格式化文本 (如 '0.62 (0.44–0.88)') */
  hr_formatted: string
}

export interface CoxRegressionResult {
  /** 各协变量结果 */
  covariates: CoxCovariateResult[]
  /** 样本量与事件数 */
  sample_size: number
  events_count: number
  /** Harrell Concordance Index (C-index) */
  c_index: number
  /** 似然比检验 P 值 */
  p_value_overall: number
}

export interface NumberAtRiskTable {
  /** 统计时间刻度 */
  time_points: number[]
  /** 各组对应时间点的在保人数 */
  groups: Array<{
    group: string
    label: string
    counts: number[]
  }>
}

export interface SurvivalAnalysisResult {
  title: string
  time_col: string
  event_col: string
  group_col?: string
  time_unit: string
  /** 各组 KM 生存统计 */
  groups: KmGroupResult[]
  /** Log-rank 检验（2 组及以上时） */
  log_rank?: LogRankResult
  /** Cox 比例风险回归（指定协变量或多组时） */
  cox?: CoxRegressionResult
  /** 风险表数据 */
  risk_table: NumberAtRiskTable
  /** 高清医学出版级 KM 生存曲线 SVG 字符串 */
  svg: string
  /** Cox 森林图 SVG 字符串 (若执行了 Cox 回归) */
  forest_svg?: string
  /** 临床论文结果段落自然语言述评 (Manuscript Narrative) */
  narrative: string
  /** Markdown 格式总结表格 */
  markdown_table: string
  /** 高清医学出版级 KM 生存曲线 SVG 字符串 (别名以兼容不同前端调用) */
  km_svg?: string
  /** Cox 森林图 SVG 字符串 (别名) */
  forest_plot_svg?: string
  /** 完整 Markdown 总结与述评 (别名) */
  summary_markdown?: string
}

/** 规范化事件状态为 0 或 1 */
export function normalizeEventStatus(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'number') {
    if (isNaN(val)) return null
    return val > 0 ? 1 : 0
  }
  const s = String(val).trim().toLowerCase()
  if (s === '1' || s === 'true' || s === 'dead' || s === 'death' || s === 'relapse' || s === 'event' || s === 'yes' || s === 'positive' || s === 'deceased') {
    return 1
  }
  if (s === '0' || s === 'false' || s === 'censored' || s === 'alive' || s === 'censor' || s === 'no' || s === 'negative' || s === 'living') {
    return 0
  }
  const num = parseFloat(s)
  if (!isNaN(num)) return num > 0 ? 1 : 0
  return null
}

/** 格式化 P 值 */
function formatP(p: number | null | undefined): string {
  if (p === null || p === undefined || isNaN(p)) return '—'
  if (p < 0.0001) return '< 0.0001'
  if (p < 0.001) return '< 0.001'
  if (p < 0.01) return p.toFixed(3)
  return p.toFixed(3)
}

/** 计算单个样本组的 Kaplan-Meier 估计与分位数 */
export function calculateSingleGroupKm(
  records: Array<{ time: number; event: number }>,
  groupName: string,
  groupLabel: string,
  milestones: number[] = [12, 24, 36, 60]
): KmGroupResult {
  const valid = records.filter(r => Number.isFinite(r.time) && r.time >= 0 && (r.event === 0 || r.event === 1))
  const total_n = valid.length
  const events_n = valid.filter(r => r.event === 1).length
  const censored_n = total_n - events_n
  const event_rate = total_n > 0 ? (events_n / total_n) * 100 : 0

  if (total_n === 0) {
    return {
      group: groupName,
      label: groupLabel,
      total_n: 0,
      events_n: 0,
      censored_n: 0,
      event_rate: 0,
      median_time: null,
      median_ci: [null, null],
      q25_time: null,
      q75_time: null,
      milestone_survival: {},
      timeline: []
    }
  }

  // 按时间排序
  valid.sort((a, b) => a.time - b.time)

  // 聚合相同时间点的事件数与删失数
  const timeMap = new Map<number, { events: number; censored: number }>()
  for (const r of valid) {
    const entry = timeMap.get(r.time) || { events: 0, censored: 0 }
    if (r.event === 1) entry.events++
    else entry.censored++
    timeMap.set(r.time, entry)
  }

  const sortedTimes = Array.from(timeMap.keys()).sort((a, b) => a - b)
  let currentAtRisk = total_n
  let currentSurv = 1.0
  let greenwoodSum = 0

  const timeline: KmTimePoint[] = []

  // 起点 t = 0
  timeline.push({
    time: 0,
    n_risk: total_n,
    n_event: 0,
    n_censor: 0,
    surv: 1.0,
    std_err: 0,
    ci_lower: 1.0,
    ci_upper: 1.0
  })

  for (const t of sortedTimes) {
    const { events, censored } = timeMap.get(t)!
    const n_i = currentAtRisk
    const d_i = events

    if (n_i > 0 && d_i > 0) {
      currentSurv = currentSurv * (1 - d_i / n_i)
      if (n_i > d_i) {
        greenwoodSum += d_i / (n_i * (n_i - d_i))
      }
    }

    const std_err = currentSurv * Math.sqrt(Math.max(0, greenwoodSum))
    
    // Log-log 转换 95% 置信区间
    let ci_lower = 0
    let ci_upper = 1.0
    if (currentSurv > 0 && currentSurv < 1 && greenwoodSum > 0) {
      const logLog = Math.log(-Math.log(currentSurv))
      const seLogLog = Math.sqrt(greenwoodSum) / Math.abs(Math.log(currentSurv))
      ci_lower = Math.exp(-Math.exp(logLog + 1.96 * seLogLog))
      ci_upper = Math.exp(-Math.exp(logLog - 1.96 * seLogLog))
    } else if (currentSurv === 1) {
      ci_lower = 1.0
      ci_upper = 1.0
    } else {
      ci_lower = Math.max(0, currentSurv - 1.96 * std_err)
      ci_upper = Math.min(1, currentSurv + 1.96 * std_err)
    }

    timeline.push({
      time: t,
      n_risk: n_i,
      n_event: events,
      n_censor: censored,
      surv: Math.max(0, Math.min(1, currentSurv)),
      std_err,
      ci_lower: Math.max(0, Math.min(1, ci_lower)),
      ci_upper: Math.max(0, Math.min(1, ci_upper))
    })

    currentAtRisk -= (events + censored)
  }

  // 寻找中位生存时间及 25% / 75% 分位数 (首次 S(t) <= target)
  const findQuantile = (targetProb: number): number | null => {
    for (const pt of timeline) {
      if (pt.surv <= targetProb) return pt.time
    }
    return null
  }

  const q75_time = findQuantile(0.75) // 25% 发生事件
  const median_time = findQuantile(0.50) // 50% 发生事件
  const q25_time = findQuantile(0.25) // 75% 发生事件

  // 中位生存期 95% CI (Brookmeyer-Crowley 简易法)
  let median_ci: [number | null, number | null] = [null, null]
  if (median_time !== null) {
    let lowerT: number | null = null
    let upperT: number | null = null
    for (const pt of timeline) {
      if (pt.ci_upper <= 0.5 && lowerT === null) lowerT = pt.time
      if (pt.ci_lower <= 0.5 && upperT === null) upperT = pt.time
    }
    median_ci = [lowerT, upperT]
  }

  // 里程碑时间生存率
  const milestone_survival: KmGroupResult['milestone_survival'] = {}
  for (const ms of milestones) {
    // 找到 <= ms 的最后一个点
    let candidate = timeline[0]!
    for (const pt of timeline) {
      if (pt.time <= ms) candidate = pt
      else break
    }
    const pct = (candidate.surv * 100).toFixed(1)
    const lowPct = (candidate.ci_lower * 100).toFixed(1)
    const upPct = (candidate.ci_upper * 100).toFixed(1)
    milestone_survival[ms] = {
      surv: candidate.surv,
      ci_lower: candidate.ci_lower,
      ci_upper: candidate.ci_upper,
      surv_formatted: `${pct}% (${lowPct}–${upPct}%)`
    }
  }

  return {
    group: groupName,
    label: groupLabel,
    total_n,
    events_n,
    censored_n,
    event_rate,
    median_time,
    median_ci,
    q25_time,
    q75_time,
    milestone_survival,
    timeline
  }
}

/** 多组 Log-Rank 检验 (Mantel-Haenszel 超几何协方差矩阵精确法) */
export function calculateLogRankTest(
  groupsKm: KmGroupResult[]
): LogRankResult {
  if (groupsKm.length < 2) {
    return {
      chi2: 0,
      df: 1,
      p_value: 1.0,
      p_value_formatted: '1.000',
      group_stats: groupsKm.map(g => ({ group: g.group, label: g.label, observed: g.events_n, expected: g.events_n, ratio: 1.0 }))
    }
  }

  // 收集所有发生事件的时间点
  const allEventTimesSet = new Set<number>()
  for (const g of groupsKm) {
    for (const pt of g.timeline) {
      if (pt.n_event > 0) allEventTimesSet.add(pt.time)
    }
  }
  const eventTimes = Array.from(allEventTimesSet).sort((a, b) => a - b)

  const G = groupsKm.length
  const df = G - 1
  const observedTotals = new Array(G).fill(0)
  const expectedTotals = new Array(G).fill(0)
  // 前 G-1 组的超几何协方差矩阵 V ((G-1) x (G-1))
  const covMatrix: number[][] = Array.from({ length: df }, () => new Array(df).fill(0))

  for (const t of eventTimes) {
    let totalRiskAtT = 0
    let totalEventsAtT = 0
    const risksAtT = new Array(G).fill(0)
    const eventsAtT = new Array(G).fill(0)

    for (let i = 0; i < G; i++) {
      const g = groupsKm[i]!
      // 找到在 t 时刻处于风险的人数和事件数
      let foundRisk = 0
      let foundEvents = 0
      for (const pt of g.timeline) {
        if (pt.time === t) {
          foundRisk = pt.n_risk
          foundEvents = pt.n_event
          break
        } else if (pt.time < t) {
          // 当前最新的在保人数（扣去之前的事件和删失）
          foundRisk = pt.n_risk - (pt.n_event + pt.n_censor)
        }
      }
      risksAtT[i] = foundRisk
      eventsAtT[i] = foundEvents
      totalRiskAtT += foundRisk
      totalEventsAtT += foundEvents
    }

    if (totalRiskAtT <= 1 || totalEventsAtT === 0) continue

    for (let i = 0; i < G; i++) {
      const e_it = (risksAtT[i]! * totalEventsAtT) / totalRiskAtT
      observedTotals[i] += eventsAtT[i]!
      expectedTotals[i] += e_it
    }

    const commonFactor = (totalEventsAtT * (totalRiskAtT - totalEventsAtT)) / (Math.pow(totalRiskAtT, 2) * (totalRiskAtT - 1))
    for (let g = 0; g < df; g++) {
      const ng = risksAtT[g]!
      for (let h = 0; h < df; h++) {
        const nh = risksAtT[h]!
        if (g === h) {
          covMatrix[g]![h]! += ng * (totalRiskAtT - ng) * commonFactor
        } else {
          covMatrix[g]![h]! -= ng * nh * commonFactor
        }
      }
    }
  }

  let chi2 = 0

  if (G === 2) {
    const varianceG1 = covMatrix[0]![0]!
    if (varianceG1 > 1e-9) {
      chi2 = Math.pow(observedTotals[0]! - expectedTotals[0]!, 2) / varianceG1
    } else {
      chi2 = 0
    }
  } else {
    // 多组精确二次型 (O - E)^T V^{-1} (O - E)
    const diffVec = Array.from({ length: df }, (_, i) => observedTotals[i]! - expectedTotals[i]!)
    const solved = solveLinearSystem(covMatrix, diffVec)
    if (solved) {
      let q = 0
      for (let i = 0; i < df; i++) {
        q += diffVec[i]! * solved[i]!
      }
      chi2 = Math.max(0, q)
    } else {
      // 矩阵奇异（如某组全程 0 风险集）时退回非奇异子集对角近似
      for (let i = 0; i < G; i++) {
        if (expectedTotals[i]! > 1e-9) {
          chi2 += Math.pow(observedTotals[i]! - expectedTotals[i]!, 2) / expectedTotals[i]!
        }
      }
    }
  }

  const p_value = chiSquareUpperPValue(Math.max(0, chi2), df)

  const group_stats = groupsKm.map((g, idx) => ({
    group: g.group,
    label: g.label,
    observed: observedTotals[idx] ?? g.events_n,
    expected: Number((expectedTotals[idx] ?? g.events_n).toFixed(2)),
    ratio: (expectedTotals[idx] ?? 0) > 0 ? Number(((observedTotals[idx] ?? 0) / expectedTotals[idx]!).toFixed(2)) : 1.0
  }))

  return {
    chi2: Number(chi2.toFixed(3)),
    df,
    p_value,
    p_value_formatted: formatP(p_value),
    group_stats
  }
}

/** 单变量或多变量 Cox 比例风险回归模型 (Newton-Raphson Partial Likelihood) */
export function calculateCoxRegression(
  records: Array<{ time: number; event: number; [cov: string]: any }>,
  covariates: string[],
  labels: Record<string, string> = {}
): CoxRegressionResult {
  // 对包含非数值型字符串（如 'Male'/'Female'）的分类协变量进行自动数值编码
  const categoryEncoding = new Map<string, Map<string, number>>()
  for (const c of covariates) {
    let hasNonNumeric = false
    const distinct = new Set<string>()
    for (const r of records) {
      const rawC = r[c]
      if (rawC === null || rawC === undefined || String(rawC).trim() === '') continue
      const s = String(rawC).trim()
      distinct.add(s)
      if (!Number.isFinite(Number(s))) hasNonNumeric = true
    }
    if (hasNonNumeric && distinct.size >= 2) {
      const sortedLevels = Array.from(distinct).sort()
      const map = new Map<string, number>()
      sortedLevels.forEach((lvl, idx) => map.set(lvl, idx))
      categoryEncoding.set(c, map)
    }
  }

  const encodeCovariate = (c: string, rawC: unknown): number => {
    if (rawC === null || rawC === undefined) return NaN
    const s = String(rawC).trim()
    if (s === '') return NaN
    const map = categoryEncoding.get(c)
    if (map) {
      const mapped = map.get(s)
      return mapped !== undefined ? mapped : NaN
    }
    return Number(s)
  }

  const valid = records.filter(r => {
    const rawTime = r.time
    if (rawTime === null || rawTime === undefined || String(rawTime).trim() === '') return false
    const timeNum = Number(rawTime)
    if (!Number.isFinite(timeNum) || timeNum < 0 || (r.event !== 0 && r.event !== 1)) return false
    for (const c of covariates) {
      const v = encodeCovariate(c, r[c])
      if (!Number.isFinite(v)) return false
    }
    return true
  })

  const sample_size = valid.length
  const events_count = valid.filter(r => r.event === 1).length
  const p = covariates.length

  if (sample_size < p + 2 || events_count < 2 || p === 0) {
    return {
      covariates: covariates.map(c => ({
        variable: c,
        label: labels[c] || c,
        beta: 0,
        se: 1,
        z: 0,
        p_value: 1.0,
        p_value_formatted: '1.000',
        hr: 1.0,
        hr_ci_lower: 1.0,
        hr_ci_upper: 1.0,
        hr_formatted: '1.00 (1.00–1.00)'
      })),
      sample_size,
      events_count,
      c_index: 0.5,
      p_value_overall: 1.0
    }
  }

  // 排序：时间从大到小排序方便累积风险集计算
  valid.sort((a, b) => b.time - a.time)

  const X: number[][] = valid.map(r => covariates.map(c => encodeCovariate(c, r[c])))
  const time = valid.map(r => Number(r.time))
  const event = valid.map(r => r.event)

  // 初始化回归系数 beta 为 0
  let beta = new Array(p).fill(0)
  const maxIter = 25
  let converged = false

  for (let iter = 0; iter < maxIter; iter++) {
    // 计算风险集权重与梯度 U 及 Hessian 矩阵 I
    const U = new Array(p).fill(0)
    const I = Array.from({ length: p }, () => new Array(p).fill(0))

    let sumW = 0
    const sumWX = new Array(p).fill(0)
    const sumWXX = Array.from({ length: p }, () => new Array(p).fill(0))

    let lastTime = -1
    const n = sample_size

    let i = 0
    while (i < n) {
      // C4 修复：按 Breslow 方法处理并列时间，首先将所有满足 T_k >= t_i 的受试者加入当前风险集
      let j = i
      while (j < n && Math.abs(time[j]! - time[i]!) < 1e-9) {
        j++
      }
      for (let k = i; k < j; k++) {
        const xk = X[k]!
        let linearPred = 0
        for (let m = 0; m < p; m++) linearPred += beta[m]! * xk[m]!
        linearPred = Math.max(-25, Math.min(25, linearPred))
        const theta = Math.exp(linearPred)
        sumW += theta
        for (let m = 0; m < p; m++) {
          sumWX[m] += theta * xk[m]!
          for (let q = 0; q < p; q++) {
            sumWXX[m]![q]! += theta * xk[m]! * xk[q]!
          }
        }
      }

      // 对该并列时间点内的所有事件累积梯度 U 与信息矩阵 I
      for (let k = i; k < j; k++) {
        if (event[k] === 1) {
          const xk = X[k]!
          for (let m = 0; m < p; m++) {
            const a_m = sumWX[m]! / sumW
            U[m] += xk[m]! - a_m
            for (let q = 0; q < p; q++) {
              const a_q = sumWX[q]! / sumW
              const b_mq = sumWXX[m]![q]! / sumW
              I[m]![q] += b_mq - a_m * a_q
            }
          }
        }
      }
      i = j
    }

    // 简单对角正则化防奇异
    for (let j = 0; j < p; j++) I[j]![j]! += 1e-7

    // 求解 I * delta = U (利用高斯消元求解)
    const delta = solveLinearSystem(I, U)
    if (!delta) break

    let maxChange = 0
    for (let j = 0; j < p; j++) {
      beta[j] += delta[j]!
      maxChange = Math.max(maxChange, Math.abs(delta[j]!))
    }

    if (maxChange < 1e-5) {
      converged = true
      break
    }
  }

  // 计算协方差矩阵 (Hessian 逆矩阵)，同样采用 Breslow 并列时间处理
  const I_final = Array.from({ length: p }, () => new Array(p).fill(0))
  let sumW = 0
  const sumWX = new Array(p).fill(0)
  const sumWXX = Array.from({ length: p }, () => new Array(p).fill(0))

  let idx = 0
  while (idx < sample_size) {
    let j = idx
    while (j < sample_size && Math.abs(time[j]! - time[idx]!) < 1e-9) {
      j++
    }
    for (let k = idx; k < j; k++) {
      const xk = X[k]!
      let linearPred = 0
      for (let m = 0; m < p; m++) linearPred += beta[m]! * xk[m]!
      const theta = Math.exp(Math.max(-25, Math.min(25, linearPred)))
      sumW += theta
      for (let m = 0; m < p; m++) {
        sumWX[m] += theta * xk[m]!
        for (let q = 0; q < p; q++) {
          sumWXX[m]![q]! += theta * xk[m]! * xk[q]!
        }
      }
    }
    for (let k = idx; k < j; k++) {
      if (event[k] === 1) {
        for (let m = 0; m < p; m++) {
          const a_m = sumWX[m]! / sumW
          for (let q = 0; q < p; q++) {
            const a_q = sumWX[q]! / sumW
            I_final[m]![q]! += (sumWXX[m]![q]! / sumW) - a_m * a_q
          }
        }
      }
    }
    idx = j
  }
  for (let j = 0; j < p; j++) I_final[j]![j]! += 1e-7

  const covMatrix = invertMatrix(I_final)

  const covResults: CoxCovariateResult[] = covariates.map((c, j) => {
    const b = beta[j]!
    const variance = covMatrix ? Math.max(1e-6, covMatrix[j]![j]!) : 1
    const se = Math.sqrt(variance)
    const z = se > 0 ? b / se : 0
    const p_value = 2 * (1 - normalCdf(Math.abs(z)))
    const hr = Math.exp(b)
    const hr_ci_lower = Math.exp(b - 1.96 * se)
    const hr_ci_upper = Math.exp(b + 1.96 * se)

    return {
      variable: c,
      label: labels[c] || c,
      beta: Number(b.toFixed(4)),
      se: Number(se.toFixed(4)),
      z: Number(z.toFixed(3)),
      p_value,
      p_value_formatted: formatP(p_value),
      hr: Number(hr.toFixed(2)),
      hr_ci_lower: Number(hr_ci_lower.toFixed(2)),
      hr_ci_upper: Number(hr_ci_upper.toFixed(2)),
      hr_formatted: `${hr.toFixed(2)} (${hr_ci_lower.toFixed(2)}–${hr_ci_upper.toFixed(2)})`
    }
  })

  // 计算 Harrell C-index
  let concordant = 0
  let totalPairs = 0
  for (let i = 0; i < sample_size; i++) {
    if (event[i] !== 1) continue
    for (let k = 0; k < sample_size; k++) {
      if (time[i]! < time[k]!) {
        // i 发生事件早于 k
        totalPairs++
        // 计算风险预测值 riskScore
        let rScoreI = 0
        let rScoreK = 0
        for (let j = 0; j < p; j++) {
          rScoreI += beta[j]! * X[i]![j]!
          rScoreK += beta[j]! * X[k]![j]!
        }
        if (rScoreI > rScoreK) concordant += 1
        else if (rScoreI === rScoreK) concordant += 0.5
      }
    }
  }
  const c_index = totalPairs > 0 ? Number((concordant / totalPairs).toFixed(3)) : 0.5
  // 计算真实的多变量联合 Wald 检验统计量 beta^T * I_final * beta（df = p）
  let waldChi2 = 0
  for (let r = 0; r < p; r++) {
    for (let c = 0; c < p; c++) {
      waldChi2 += beta[r]! * I_final[r]![c]! * beta[c]!
    }
  }
  const p_value_overall = Number(chiSquareUpperPValue(Math.max(0, waldChi2), p).toFixed(4))

  return {
    covariates: covResults,
    sample_size,
    events_count,
    c_index,
    p_value_overall
  }
}

/** 高斯消元求解 Ax = b */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]!])

  for (let i = 0; i < n; i++) {
    // 选主元
    let maxRow = i
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k]![i]!) > Math.abs(M[maxRow]![i]!)) maxRow = k
    }
    const temp = M[i]!
    M[i] = M[maxRow]!
    M[maxRow] = temp

    if (Math.abs(M[i]![i]!) < 1e-12) return null

    for (let k = i + 1; k < n; k++) {
      const c = -M[k]![i]! / M[i]![i]!
      for (let j = i; j <= n; j++) {
        if (i === j) M[k]![j] = 0
        else M[k]![j]! += c * M[i]![j]!
      }
    }
  }

  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i]![n]! / M[i]![i]!
    for (let k = i - 1; k >= 0; k--) {
      M[k]![n]! -= M[k]![i]! * x[i]!
    }
  }
  return x
}

/** 矩阵求逆 */
function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length
  const I: number[][] = Array.from({ length: n }, (_, i) => {
    const row = new Array(n).fill(0)
    row[i] = 1
    return row
  })
  const inv: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))

  for (let col = 0; col < n; col++) {
    const e = I.map(row => row[col]!)
    const x = solveLinearSystem(A, e)
    if (!x) return null
    for (let row = 0; row < n; row++) {
      inv[row]![col] = x[row]!
    }
  }
  return inv
}

/** 生成风险集随时间统计表 (Number at risk) */
export function buildNumberAtRiskTable(
  groupsKm: KmGroupResult[],
  maxTime: number,
  numIntervals = 5
): NumberAtRiskTable {
  const safeMax = Number.isFinite(maxTime) && maxTime > 0 ? maxTime : 0
  const safeIntervals = Math.max(1, Math.min(50, Math.floor(numIntervals) || 5))
  const step = safeMax > 0 ? (Math.ceil(safeMax / safeIntervals) || 1) : 1
  const time_points: number[] = []
  for (let t = 0; t <= safeMax && time_points.length <= safeIntervals + 2; t += step) {
    time_points.push(t)
  }
  if (time_points.length === 0) {
    time_points.push(0)
  } else if (time_points[time_points.length - 1]! < safeMax) {
    time_points.push(safeMax)
  }

  const tableGroups = groupsKm.map(g => {
    const counts = time_points.map(t => {
      let riskAtT = g.total_n
      for (const pt of g.timeline) {
        if (pt.time <= t) {
          riskAtT = pt.n_risk - (pt.n_event + pt.n_censor)
        } else {
          break
        }
      }
      return Math.max(0, riskAtT)
    })
    return {
      group: g.group,
      label: g.label,
      counts
    }
  })

  return { time_points, groups: tableGroups }
}

/** 专业医学绘图调色板 */
const SURVIVAL_COLORS = [
  '#0D9488', // Teal
  '#E11D48', // Coral / Rose
  '#2563EB', // Royal Blue
  '#D97706', // Amber
  '#7C3AED', // Violet
  '#059669', // Emerald
]

/** 渲染医学顶刊级 Kaplan-Meier 生存曲线矢量 SVG（集成 Number at Risk 风险表） */
export function renderKmCurveSvg(
  result: {
    title: string
    time_unit: string
    groups: KmGroupResult[]
    log_rank?: LogRankResult
    risk_table: NumberAtRiskTable
  },
  options: { width?: number; height?: number } = {}
): string {
  const W = options.width || 760
  const H = options.height || 520

  const margin = { top: 45, right: 35, bottom: 130, left: 65 }
  const plotW = W - margin.left - margin.right
  const plotH = H - margin.top - margin.bottom

  // 最大时间与刻度
  let maxT = result.groups.reduce((m, g) => Math.max(m, g.timeline[g.timeline.length - 1]?.time || 0), 10)
  maxT = Math.ceil(maxT * 1.05) // 预留 5% 留白

  const xScale = (t: number) => margin.left + (t / maxT) * plotW
  const yScale = (s: number) => margin.top + (1 - s) * plotH

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #ffffff;">`

  // 标题
  svg += `<text x="${margin.left}" y="26" font-size="15" font-weight="700" fill="#111827">${escapeXml(result.title)}</text>`

  // 绘制网格与 Y 轴刻度 (0.0 ~ 1.0, 步长 0.2)
  for (let s = 0; s <= 1.05; s += 0.2) {
    const y = yScale(Math.min(1.0, s))
    const pct = Math.round(s * 100)
    svg += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotW}" y2="${y}" stroke="#F3F4F6" stroke-width="1"/>`
    svg += `<text x="${margin.left - 10}" y="${y + 4}" font-size="11" font-weight="500" fill="#6B7280" text-anchor="end">${pct}%</text>`
  }

  // Y 轴主线与坐标轴标题
  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#D1D5DB" stroke-width="1.2"/>`
  svg += `<text transform="rotate(-90)" x="${-(margin.top + plotH / 2)}" y="18" font-size="12" font-weight="600" fill="#374151" text-anchor="middle">Cumulative Survival Probability</text>`

  // X 轴主线与刻度
  const xTicks = result.risk_table.time_points
  svg += `<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#D1D5DB" stroke-width="1.2"/>`
  for (const t of xTicks) {
    const x = xScale(t)
    svg += `<line x1="${x}" y1="${margin.top + plotH}" x2="${x}" y2="${margin.top + plotH + 5}" stroke="#9CA3AF" stroke-width="1"/>`
    svg += `<text x="${x}" y="${margin.top + plotH + 18}" font-size="11" fill="#4B5563" text-anchor="middle">${t}</text>`
  }
  svg += `<text x="${margin.left + plotW / 2}" y="${margin.top + plotH + 34}" font-size="12" font-weight="600" fill="#374151" text-anchor="middle">Time (${escapeXml(result.time_unit)})</text>`

  // 绘制各组 KM 阶梯曲线
  result.groups.forEach((g, gIdx) => {
    const color = SURVIVAL_COLORS[gIdx % SURVIVAL_COLORS.length]!
    let pathD = ''

    for (let i = 0; i < g.timeline.length; i++) {
      const pt = g.timeline[i]!
      const px = xScale(pt.time)
      const py = yScale(pt.surv)

      if (i === 0) {
        pathD += `M ${px} ${py}`
      } else {
        const prevPt = g.timeline[i - 1]!
        const prevY = yScale(prevPt.surv)
        // 阶梯连线：先水平延伸到新时间点，再垂直下落
        pathD += ` L ${px} ${prevY} L ${px} ${py}`
      }
    }

    svg += `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`

    // 绘制删失点 '+'
    for (const pt of g.timeline) {
      if (pt.n_censor > 0 && pt.time > 0) {
        const cx = xScale(pt.time)
        const cy = yScale(pt.surv)
        const size = 3.5
        svg += `<line x1="${cx}" y1="${cy - size}" x2="${cx}" y2="${cy + size}" stroke="${color}" stroke-width="1.2"/>`
        svg += `<line x1="${cx - size}" y1="${cy}" x2="${cx + size}" y2="${cy}" stroke="${color}" stroke-width="1.2"/>`
      }
    }
  })

  // 图例与显著性标注卡片 (右上角)
  const legendX = margin.left + plotW - 195
  const legendY = margin.top + 10
  const boxH = 22 + result.groups.length * 18 + (result.log_rank ? 20 : 0)

  svg += `<rect x="${legendX}" y="${legendY}" width="190" height="${boxH}" rx="4" fill="#ffffff" stroke="#E5E7EB" stroke-width="1" filter="drop-shadow(0 1px 2px rgba(0,0,0,0.05))"/>`

  result.groups.forEach((g, gIdx) => {
    const color = SURVIVAL_COLORS[gIdx % SURVIVAL_COLORS.length]!
    const rowY = legendY + 16 + gIdx * 18
    svg += `<line x1="${legendX + 12}" y1="${rowY}" x2="${legendX + 30}" y2="${rowY}" stroke="${color}" stroke-width="2.5"/>`
    svg += `<text x="${legendX + 36}" y="${rowY + 3.5}" font-size="11" font-weight="600" fill="#374151">${escapeXml(g.label)} (n=${g.total_n})</text>`
  })

  if (result.log_rank) {
    const lrY = legendY + 16 + result.groups.length * 18 + 4
    svg += `<line x1="${legendX + 8}" y1="${lrY - 6}" x2="${legendX + 182}" y2="${lrY - 6}" stroke="#F3F4F6" stroke-width="1"/>`
    svg += `<text x="${legendX + 12}" y="${lrY + 8}" font-size="11" font-weight="700" fill="#047857">Log-rank P = ${result.log_rank.p_value_formatted}</text>`
  }

  // 底部对齐的 Number at risk 风险表
  const riskTableY = margin.top + plotH + 50
  svg += `<text x="${margin.left - 10}" y="${riskTableY}" font-size="11" font-weight="700" fill="#111827" text-anchor="end">No. at Risk</text>`

  result.risk_table.groups.forEach((rg, gIdx) => {
    const rowY = riskTableY + 18 + gIdx * 18
    const color = SURVIVAL_COLORS[gIdx % SURVIVAL_COLORS.length]!
    svg += `<text x="${margin.left - 10}" y="${rowY}" font-size="11" font-weight="600" fill="${color}" text-anchor="end">${escapeXml(rg.label)}</text>`

    rg.counts.forEach((cnt, cIdx) => {
      const t = result.risk_table.time_points[cIdx]!
      const x = xScale(t)
      svg += `<text x="${x}" y="${rowY}" font-size="11" font-family="monospace" fill="#374151" text-anchor="middle">${cnt}</text>`
    })
  })

  svg += `</svg>`
  return svg
}

/** 渲染 Cox 风险比森林图 (Forest Plot) 矢量 SVG */
export function renderForestPlotSvg(
  cox: CoxRegressionResult,
  title = 'Multivariate Cox Proportional Hazards Regression (Forest Plot)'
): string {
  const W = 680
  const rowHeight = 32
  const headerH = 50
  const footerH = 45
  const H = headerH + cox.covariates.length * rowHeight + footerH

  const colX = { var: 20, plotLeft: 220, plotRight: 500, hrText: 530, pText: 620 }
  const plotW = colX.plotRight - colX.plotLeft

  // 寻找 HR CI 的最大最小值确定坐标轴范围
  let minHr = cox.covariates.reduce((m, c) => Math.min(m, c.hr_ci_lower), 0.5)
  let maxHr = cox.covariates.reduce((m, c) => Math.max(m, c.hr_ci_upper), 2.0)
  minHr = Math.max(0.1, minHr * 0.8)
  maxHr = Math.min(10.0, maxHr * 1.2)

  // 对数坐标投影
  const logMin = Math.log(minHr)
  const logMax = Math.log(maxHr)
  const hrToX = (hrVal: number) => {
    const clamped = Math.max(minHr, Math.min(maxHr, hrVal))
    return colX.plotLeft + ((Math.log(clamped) - logMin) / (logMax - logMin)) * plotW
  }

  const nullX = hrToX(1.0)

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #ffffff;">`
  svg += `<text x="20" y="24" font-size="14" font-weight="700" fill="#111827">${escapeXml(title)}</text>`

  // 表头
  const thY = 44
  svg += `<text x="${colX.var}" y="${thY}" font-size="11" font-weight="700" fill="#6B7280">Variable</text>`
  svg += `<text x="${colX.plotLeft + plotW / 2}" y="${thY}" font-size="11" font-weight="700" fill="#6B7280" text-anchor="middle">Hazard Ratio (95% CI)</text>`
  svg += `<text x="${colX.hrText}" y="${thY}" font-size="11" font-weight="700" fill="#6B7280">HR (95% CI)</text>`
  svg += `<text x="${colX.pText}" y="${thY}" font-size="11" font-weight="700" fill="#6B7280">P Value</text>`
  svg += `<line x1="20" y1="${thY + 6}" x2="${W - 20}" y2="${thY + 6}" stroke="#D1D5DB" stroke-width="1.2"/>`

  // 垂直虚线 HR = 1.0
  const plotTop = thY + 8
  const plotBottom = H - footerH + 5
  svg += `<line x1="${nullX}" y1="${plotTop}" x2="${nullX}" y2="${plotBottom}" stroke="#9CA3AF" stroke-width="1.2" stroke-dasharray="3,3"/>`

  // 绘制协变量各行
  cox.covariates.forEach((c, idx) => {
    const y = headerH + idx * rowHeight + 18
    const isEven = idx % 2 === 0
    if (isEven) {
      svg += `<rect x="15" y="${y - 14}" width="${W - 30}" height="${rowHeight}" fill="#F9FAFB"/>`
    }

    svg += `<text x="${colX.var}" y="${y + 4}" font-size="12" font-weight="600" fill="#1F2937">${escapeXml(c.label)}</text>`

    // 森林图误差线与方块
    const xLow = hrToX(c.hr_ci_lower)
    const xHigh = hrToX(c.hr_ci_upper)
    const xMid = hrToX(c.hr)
    const barColor = c.p_value < 0.05 ? '#0D9488' : '#6B7280'

    svg += `<line x1="${xLow}" y1="${y}" x2="${xHigh}" y2="${y}" stroke="${barColor}" stroke-width="2"/>`
    svg += `<rect x="${xMid - 3.5}" y="${y - 3.5}" width="7" height="7" fill="${barColor}"/>`

    svg += `<text x="${colX.hrText}" y="${y + 4}" font-size="11.5" font-family="monospace" fill="#374151">${escapeXml(c.hr_formatted)}</text>`
    const pColor = c.p_value < 0.05 ? '#047857' : '#4B5563'
    svg += `<text x="${colX.pText}" y="${y + 4}" font-size="11.5" font-weight="${c.p_value < 0.05 ? '700' : '400'}" fill="${pColor}">${escapeXml(c.p_value_formatted)}</text>`
  })

  // 底部轴线与刻度
  svg += `<line x1="${colX.plotLeft}" y1="${plotBottom}" x2="${colX.plotRight}" y2="${plotBottom}" stroke="#D1D5DB" stroke-width="1"/>`
  const axisTicks = [minHr, 1.0, maxHr].map(v => Number(v.toFixed(1)))
  axisTicks.forEach(tVal => {
    const tx = hrToX(tVal)
    svg += `<line x1="${tx}" y1="${plotBottom}" x2="${tx}" y2="${plotBottom + 4}" stroke="#9CA3AF" stroke-width="1"/>`
    svg += `<text x="${tx}" y="${plotBottom + 15}" font-size="10" fill="#6B7280" text-anchor="middle">${tVal}</text>`
  })
  svg += `<text x="${colX.plotLeft + 20}" y="${plotBottom + 28}" font-size="10" fill="#047857">Favors Treatment</text>`
  svg += `<text x="${colX.plotRight - 20}" y="${plotBottom + 28}" font-size="10" fill="#DC2626" text-anchor="end">Favors Control</text>`

  svg += `</svg>`
  return svg
}

/** 生成符合国际医学期刊规范的临床科研结果叙述 (Manuscript Narrative) */
export function generateSurvivalNarrative(
  groupsKm: KmGroupResult[],
  logRank?: LogRankResult,
  cox?: CoxRegressionResult,
  timeUnit = 'Months'
): string {
  let narrative = ''

  if (groupsKm.length === 1) {
    const g = groupsKm[0]!
    const medStr = g.median_time !== null ? `${g.median_time} ${timeUnit}` : 'Not Reached'
    narrative += `In the overall cohort of ${g.total_n} patients, a total of ${g.events_n} (${g.event_rate.toFixed(1)}%) events were observed during the follow-up period. The median survival time was ${medStr}.`
    const milestones = Object.keys(g.milestone_survival).map(Number).sort((a, b) => a - b)
    if (milestones.length) {
      const msStrs = milestones.map(m => `${m}-${timeUnit} survival rate was ${g.milestone_survival[m]?.surv_formatted}`)
      narrative += ` The estimated ${msStrs.join(', and ')}.`
    }
    return narrative
  }

  // 多组比较叙述
  const gStrs = groupsKm.map(g => {
    const medStr = g.median_time !== null ? `${g.median_time} ${timeUnit}` : 'Not Reached'
    return `${g.label} group (median survival: ${medStr}, n=${g.total_n}, events=${g.events_n})`
  })

  // B9 修复：不再无条件声称“显著”，依据真实 P 值判定是否具备统计学显著性
  narrative += `Survival outcomes were compared across ${groupsKm.length} cohorts: ${gStrs.join(' versus ')}.`

  if (logRank) {
    const isSig = logRank.p_value < 0.05
    narrative += isSig
      ? ` Kaplan-Meier survival curves demonstrated a statistically significant difference between the groups (Log-rank test Chi-Square = ${logRank.chi2}, df = ${logRank.df}, P = ${logRank.p_value_formatted}).`
      : ` Kaplan-Meier survival curves showed no statistically significant difference between the groups (Log-rank test Chi-Square = ${logRank.chi2}, df = ${logRank.df}, P = ${logRank.p_value_formatted}).`
  }

  if (cox && cox.covariates.length > 0) {
    const targetCov = cox.covariates[0]!
    narrative += ` In the proportional hazards regression analysis, ${targetCov.label} was associated with a Hazard Ratio (HR) of ${targetCov.hr_formatted} (P = ${targetCov.p_value_formatted}, Concordance Index = ${cox.c_index}).`
  }

  return narrative
}

/** 生成用于文档和汇报的 Markdown 结果表格 */
export function generateSurvivalMarkdownTable(
  groupsKm: KmGroupResult[],
  timeUnit = 'Months'
): string {
  const escMd = (s: string) => String(s).replace(/\|/g, '\\|')
  // C7 修复：根据时间单位自动适配 1 年与 3 年对应里程碑点，避免在 Days/Years 单位下显示错误
  const normUnit = timeUnit.toLowerCase()
  let m1Label = '1-Year Rate'
  let m3Label = '3-Year Rate'
  let m1Time = 12
  let m3Time = 36
  if (normUnit.startsWith('day')) {
    m1Label = '1-Year Rate (365d)'
    m3Label = '3-Year Rate (1095d)'
    m1Time = 365
    m3Time = 1095
  } else if (normUnit.startsWith('year')) {
    m1Label = '1-Year Rate'
    m3Label = '3-Year Rate'
    m1Time = 1
    m3Time = 3
  }

  let md = `### Kaplan-Meier Survival Analysis Summary\n\n`
  md += `| Group | Total (N) | Events (%) | Median (${escMd(timeUnit)}) | 95% CI | ${m1Label} | ${m3Label} |\n`
  md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: |\n`

  for (const g of groupsKm) {
    const med = g.median_time !== null ? String(g.median_time) : 'NR'
    const ci = g.median_ci[0] !== null && g.median_ci[1] !== null ? `${g.median_ci[0]}–${g.median_ci[1]}` : '—'
    const r1 = g.milestone_survival[m1Time]?.surv_formatted || '—'
    const r3 = g.milestone_survival[m3Time]?.surv_formatted || '—'
    md += `| **${escMd(g.label)}** | ${g.total_n} | ${g.events_n} (${g.event_rate.toFixed(1)}%) | ${med} | ${ci} | ${r1} | ${r3} |\n`
  }

  return md
}

/**
 * 端到端主函数：基于数据集记录生成完整生存分析结果
 */
export function generateSurvivalAnalysis(
  records: Array<Record<string, unknown>>,
  options: SurvivalOptions
): SurvivalAnalysisResult {
  const {
    time_col,
    event_col,
    group_col,
    covariates = [],
    time_unit = 'Months',
    milestones = [12, 24, 36, 60],
    labels = {},
    title = 'Kaplan-Meier Survival Analysis'
  } = options

  // 提取有效数据
  const cleaned: Array<{ time: number; event: number; group: string; [k: string]: unknown }> = []

  for (const r of records) {
    // C2 修复：严格剔除空字符串、null 或 undefined 的时间列，杜绝被隐式转为 0
    const rawT = r[time_col]
    if (rawT === null || rawT === undefined || String(rawT).trim() === '') continue
    const t = Number(rawT)
    const e = normalizeEventStatus(r[event_col])
    if (!Number.isFinite(t) || t < 0 || e === null) continue

    const grp = group_col && r[group_col] !== undefined && r[group_col] !== null ? String(r[group_col]).trim() : 'Overall'
    cleaned.push({
      ...r,
      time: t,
      event: e,
      group: grp
    })
  }

  // 分组
  const groupNames = Array.from(new Set(cleaned.map(c => c.group)))
  const groupsKm: KmGroupResult[] = groupNames.map(grpName => {
    const subset = cleaned.filter(c => c.group === grpName)
    const grpLabel = labels[grpName] || grpName
    return calculateSingleGroupKm(subset, grpName, grpLabel, milestones)
  })

  // Log-rank 检验
  let log_rank: LogRankResult | undefined
  if (groupsKm.length >= 2) {
    log_rank = calculateLogRankTest(groupsKm)
  }

  // Cox 回归
  let cox: CoxRegressionResult | undefined
  const coxCovs = covariates.filter(c => c !== time_col && c !== event_col)
  // 若未传 covariates 但有 2 个分组，自动将分组变量转换为数值 0/1 纳入单变量 Cox
  if (coxCovs.length === 0 && groupNames.length === 2 && group_col) {
    const g0 = groupNames[0]!
    const coxRecords = cleaned.map(c => ({
      ...c,
      _group_binary: c.group === g0 ? 0 : 1
    }))
    cox = calculateCoxRegression(coxRecords, ['_group_binary'], {
      _group_binary: `${labels[groupNames[1]!] || groupNames[1]!} vs ${labels[g0] || g0}`
    })
  } else if (coxCovs.length > 0) {
    cox = calculateCoxRegression(cleaned, coxCovs, labels)
  }

  // 风险表
  const maxTime = cleaned.reduce((m, c) => (c.time > m ? c.time : m), 10)
  const risk_table = buildNumberAtRiskTable(groupsKm, maxTime, 6)

  // 渲染 SVG 图表
  const svg = renderKmCurveSvg({
    title,
    time_unit,
    groups: groupsKm,
    log_rank,
    risk_table
  })

  let forest_svg: string | undefined
  if (cox && cox.covariates.length > 0) {
    forest_svg = renderForestPlotSvg(cox, `${title} - Cox Hazard Ratios`)
  }

  // 叙述性段落与 Markdown 表格
  const narrative = generateSurvivalNarrative(groupsKm, log_rank, cox, time_unit)
  const markdown_table = generateSurvivalMarkdownTable(groupsKm, time_unit)

  return {
    title,
    time_col,
    event_col,
    group_col,
    time_unit,
    groups: groupsKm,
    log_rank,
    cox,
    risk_table,
    svg,
    km_svg: svg,
    forest_svg,
    forest_plot_svg: forest_svg,
    narrative,
    markdown_table,
    summary_markdown: `${narrative}\n\n${markdown_table}`
  }
}

function escapeXml(unsafe: string): string {
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
