/**
 * 临床研究 Table 1 基线特征表自动生成引擎与显著性检验套件
 * 
 * 遵循 NEJM / Lancet / JAMA 医学期刊三线表标准：
 * - 连续变量根据正态性检验自动分流：正态分布呈现为 Mean ± SD（Welch's t-test / ANOVA）；
 *   偏态分布呈现为 Median [IQR] 或 [Q1 - Q3]（Mann-Whitney U 检验 / Kruskal-Wallis 检验）；
 * - 分类变量呈现为 N (%)（Pearson 卡方检验 / 期望频数 < 5 时自动适配 Fisher 精确检验）；
 * - 支持 2 组间标化均数差 (SMD, Standardized Mean Difference) 计算（Austin 2009 临床均衡性标准）；
 * - 纯 TypeScript 零外部依赖高性能实现，支持 Markdown 表格、结构化 JSON 与 DocOp 操作块输出。
 */

export interface Table1Options {
  /** 分层变量（如治疗组/对照组、存活/死亡等）；不传时仅展示 Overall 全体人群 */
  group_col?: string
  /** 纳入分析的变量列表（按顺序）；不传时自动选择所有非 ID、非分层变量的数值与分类列 */
  columns?: string[]
  /** 显式声明为连续型的变量列表 */
  continuous_vars?: string[]
  /** 显式声明为分类型的变量列表 */
  categorical_vars?: string[]
  /** 显式声明为偏态/非正态的连续型变量（以 Median [IQR] 展示并采用非参数秩和检验） */
  non_normal_vars?: string[]
  /** 是否包含 Overall 列（默认 true） */
  include_overall?: boolean
  /** 是否计算并显示 P 值（默认有 group_col 时为 true） */
  include_p_value?: boolean
  /** 是否计算并显示标化均数差 SMD（默认 2 组时为 true） */
  include_smd?: boolean
  /** 是否在存在缺失值时显示 Missing 统计行（默认 true） */
  show_missing?: boolean
  /** 自定义表头与变量名称映射（如 { age: '年龄 (岁)', sex: '性别', male: '男', female: '女' }） */
  labels?: Record<string, string>
  /** 表格标题（默认 'Table 1. Baseline Demographic and Clinical Characteristics'） */
  title?: string
  /** 小数点位数控制 */
  decimals?: {
    continuous?: number
    percentage?: number
    p_value?: number
    smd?: number
  }
}

export interface Table1Row {
  /** 变量名（原始列名） */
  variable: string
  /** 显示标签（如 'Age (years)'） */
  label: string
  /** 类型：continuous 或 categorical */
  type: 'continuous' | 'categorical'
  /** 是否为分类变量的类别行（子行） */
  is_category_level?: boolean
  /** 类别名称（如果是分类子行，如 'Male'） */
  level?: string
  /** 缩进级别（0: 变量主行, 1: 类别子行, 2: 缺失子行） */
  indent: number
  /** Overall 汇总统计值（如 '62.4 ± 8.5' 或 '105 (52.5%)'） */
  overall?: string
  /** 分组汇总统计值，key 为组名，value 为显示文本 */
  groups: Record<string, string>
  /** 统计检验方法名称（如 "Welch's t-test", "Mann-Whitney U test", "Chi-square test", "Fisher's exact test", "One-way ANOVA" 等） */
  test_method?: string
  /** 统计检验量（如 t, U, chi2, F） */
  test_statistic?: number | null
  /** 自由度 df */
  df?: number | null
  /** 计算出的精确 P 值 */
  p_value?: number | null
  /** 格式化后的 P 值（如 '< 0.001' 或 '0.042'） */
  p_value_formatted?: string
  /** 标化均数差 SMD 数值 */
  smd?: number | null
  /** 格式化后的 SMD（如 '0.082'） */
  smd_formatted?: string
  /** 缺失值信息（如果有） */
  missing?: {
    total: number
    percentage: number
    groups: Record<string, { count: number; percentage: number }>
  }
}

export interface Table1Group {
  name: string
  label: string
  count: number
  percentage: number
}

export interface Table1Result {
  /** 表格标题 */
  title: string
  /** 分组信息 */
  groups: Table1Group[]
  /** 总样本量 */
  total_n: number
  /** 表头列名列表 */
  headers: string[]
  /** 结构化行数据 */
  rows: Table1Row[]
  /** 表注列表（统计方法与缩写说明） */
  footnotes: string[]
  /** 生成的标准 Markdown GFM 三线表 */
  markdown: string
}

// ==========================================
// 1. 特殊函数与概率分布数值计算库（纯 TypeScript）
// ==========================================

/** 对数 Gamma 函数 ln(Gamma(x))，Lanczos 9 项高精度近似（误差 < 1e-14） */
export function logGamma(x: number): number {
  if (x <= 0) return 0
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.138571095856526,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  }
  x -= 1
  let a = c[0]!
  const t = x + 7.5
  for (let i = 1; i < c.length; i++) {
    a += c[i]! / (x + i)
  }
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** 误差函数 erf(x) */
export function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1
  x = Math.abs(x)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1.0 / (1.0 + p * x)
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return sign * y
}

/** 互补误差函数 erfc(x) */
export function erfc(x: number): number {
  return 1.0 - erf(x)
}

/** 标准正态累积分布函数 Phi(z) */
export function normalCdf(z: number): number {
  return 0.5 * (1.0 + erf(z / Math.SQRT2))
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200
  const EPS = 3e-14
  const FPMIN = 1e-30

  const qab = a + b
  const qap = a + 1.0
  const qam = a - 1.0
  let c = 1.0
  let d = 1.0 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1.0 / d
  let h = d

  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1.0 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1.0 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1.0 / d
    h *= d * c

    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1.0 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1.0 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1.0 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1.0) < EPS) break
  }
  return h
}

/** 正则化不完全 Beta 函数 I_x(a, b)（Lentz 连分数法） */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1

  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(b, a, 1 - x)
  }

  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)) / a
  return front * betacf(a, b, x)
}


/** 正则化下不完全 Gamma 函数 P(a, x) = gamma(a, x) / Gamma(a) */
function incompleteGammaSeries(a: number, x: number): number {
  let sum = 1 / a
  let term = sum
  for (let n = 1; n < 1000; n++) {
    term *= x / (a + n)
    sum += term
    if (Math.abs(term) < Math.abs(sum) * 1e-14) break
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a))
}

/** 正则化上不完全 Gamma 函数 Q(a, x) = Gamma(a, x) / Gamma(a) */
function incompleteGammaContinuedFraction(a: number, x: number): number {
  const TINY = 1e-30
  let b = x + 1.0 - a
  let c = 1.0 / TINY
  let d = 1.0 / b
  let h = d
  for (let i = 1; i <= 200; i++) {
    const an = -i * (i - a)
    b += 2.0
    d = an * d + b
    if (Math.abs(d) < TINY) d = TINY
    c = b + an / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1.0 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1.0) < 1e-12) break
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h
}

/** 卡方分布右尾双侧 P 值：P(X >= chi2 | df) */
export function chiSquareUpperPValue(chi2: number, df: number): number {
  if (chi2 <= 0 || df <= 0) return 1
  const a = df / 2
  const x = chi2 / 2
  if (x < a + 1) {
    return Math.max(0, Math.min(1, 1 - incompleteGammaSeries(a, x)))
  } else {
    return Math.max(0, Math.min(1, incompleteGammaContinuedFraction(a, x)))
  }
}

/** 学生氏 t 分布双尾 P 值：P(|T| >= |t| | df) */
export function studentTTestPValue(t: number, df: number): number {
  if (df <= 0) return 1
  const absT = Math.abs(t)
  if (absT === 0) return 1
  const x = df / (df + absT * absT)
  return Math.max(0, Math.min(1, regularizedIncompleteBeta(df / 2, 0.5, x)))
}

/** 单因素 ANOVA F 分布右尾 P 值：P(F >= f_stat | df1, df2) */
export function fTestUpperPValue(F: number, df1: number, df2: number): number {
  if (F <= 0 || df1 <= 0 || df2 <= 0) return 1
  const x = df2 / (df2 + df1 * F)
  return Math.max(0, Math.min(1, regularizedIncompleteBeta(df2 / 2, df1 / 2, x)))
}

// ==========================================
// 2. 统计量与显著性检验算法
// ==========================================

export interface ContinuousSummary {
  n: number
  mean: number
  sd: number
  median: number
  q1: number
  q3: number
  iqr: number
  min: number
  max: number
  skewness: number
  kurtosis: number
  is_normal: boolean
}

/** 计算连续数值样本的描述性统计量与正态性指标 */
export function summarizeContinuous(values: number[]): ContinuousSummary {
  const n = values.length
  if (n === 0) {
    return { n: 0, mean: 0, sd: 0, median: 0, q1: 0, q3: 0, iqr: 0, min: 0, max: 0, skewness: 0, kurtosis: 0, is_normal: true }
  }
  const sum = values.reduce((a, b) => a + b, 0)
  const mean = sum / n

  // 排序用于分位数与极值
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0]!
  const max = sorted[sorted.length - 1]!

  // 方差、标准差与高阶矩
  let sumSqDiff = 0
  let m3Diff = 0
  let m4Diff = 0
  for (const v of values) {
    const diff = v - mean
    const diffSq = diff * diff
    sumSqDiff += diffSq
    m3Diff += diffSq * diff
    m4Diff += diffSq * diffSq
  }

  const sd = n > 1 ? Math.sqrt(sumSqDiff / (n - 1)) : 0
  const m2 = sumSqDiff / n
  const m3 = m3Diff / n
  const m4 = m4Diff / n

  const skewness = m2 > 1e-12 ? m3 / Math.pow(m2, 1.5) : 0
  const kurtosis = m2 > 1e-12 ? m4 / (m2 * m2) - 3 : 0

  // 分位数计算（采用 R/pandas 标准 Type 7 线性插值）
  const quantile = (p: number): number => {
    if (n === 1) return sorted[0]!
    const index = (n - 1) * p
    const low = Math.floor(index)
    const high = Math.ceil(index)
    const weight = index - low
    return sorted[low]! * (1 - weight) + sorted[high]! * weight
  }

  const median = quantile(0.5)
  const q1 = quantile(0.25)
  const q3 = quantile(0.75)
  const iqr = q3 - q1

  // 经验医学正态性判定（样本量 >= 8 时偏度与超额峰度均在稳健区间）
  const is_normal = n >= 8 ? Math.abs(skewness) <= 1.0 && Math.abs(kurtosis) <= 2.0 : true

  return { n, mean, sd, median, q1, q3, iqr, min, max, skewness, kurtosis, is_normal }
}

/** 两组连续变量比较：Welch's t-test（抗方差不齐） */
export function welchTTest(group1: number[], group2: number[]): { t: number; df: number; p: number } {
  const n1 = group1.length
  const n2 = group2.length
  if (n1 < 2 || n2 < 2) return { t: 0, df: 1, p: 1.0 }

  const s1 = summarizeContinuous(group1)
  const s2 = summarizeContinuous(group2)

  const v1 = (s1.sd * s1.sd) / n1
  const v2 = (s2.sd * s2.sd) / n2
  const se = Math.sqrt(v1 + v2)

  if (se < 1e-12) {
    return { t: 0, df: n1 + n2 - 2, p: s1.mean === s2.mean ? 1.0 : 0.0 }
  }

  const t = (s1.mean - s2.mean) / se
  // Welch-Satterthwaite 自由度
  const dfNumerator = (v1 + v2) * (v1 + v2)
  const dfDenominator = (v1 * v1) / (n1 - 1) + (v2 * v2) / (n2 - 1)
  const df = dfDenominator > 0 ? dfNumerator / dfDenominator : n1 + n2 - 2
  const p = studentTTestPValue(t, df)

  return { t, df, p }
}

/** 多组连续变量比较：单因素方差分析 One-way ANOVA */
export function oneWayAnova(groups: number[][]): { F: number; df1: number; df2: number; p: number } {
  const validGroups = groups.filter(g => g.length > 0)
  const k = validGroups.length
  if (k < 2) return { F: 0, df1: 1, df2: 1, p: 1.0 }

  const totalN = validGroups.reduce((acc, g) => acc + g.length, 0)
  if (totalN <= k) return { F: 0, df1: k - 1, df2: 1, p: 1.0 }

  const allValues = validGroups.flat()
  const grandMean = allValues.reduce((a, b) => a + b, 0) / totalN

  let ssBetween = 0
  let ssWithin = 0

  for (const group of validGroups) {
    const ni = group.length
    const mean_i = group.reduce((a, b) => a + b, 0) / ni
    ssBetween += ni * Math.pow(mean_i - grandMean, 2)
    for (const val of group) {
      ssWithin += Math.pow(val - mean_i, 2)
    }
  }

  const df1 = k - 1
  const df2 = totalN - k
  const msBetween = ssBetween / df1
  const msWithin = df2 > 0 ? ssWithin / df2 : 0

  if (msWithin < 1e-12) {
    return { F: 0, df1, df2, p: ssBetween < 1e-12 ? 1.0 : 0.0 }
  }

  const F = msBetween / msWithin
  const p = fTestUpperPValue(F, df1, df2)

  return { F, df1, df2, p }
}

/** 两组非正态连续变量比较：Mann-Whitney U 秩和检验（带结平局修正与连续性校正） */
export function mannWhitneyUTest(group1: number[], group2: number[]): { u: number; z: number; p: number } {
  const n1 = group1.length
  const n2 = group2.length
  if (n1 === 0 || n2 === 0) return { u: 0, z: 0, p: 1.0 }

  // 标注入组标签并联合排序
  type Item = { val: number; group: 1 | 2 }
  const combined: Item[] = [
    ...group1.map(v => ({ val: v, group: 1 as const })),
    ...group2.map(v => ({ val: v, group: 2 as const })),
  ]
  combined.sort((a, b) => a.val - b.val)

  const N = n1 + n2
  const ranks: number[] = new Array(N)
  let tieSum = 0

  let i = 0
  while (i < N) {
    let j = i
    while (j < N - 1 && combined[j + 1]!.val === combined[i]!.val) {
      j++
    }
    const tieCount = j - i + 1
    const avgRank = (i + 1 + j + 1) / 2
    for (let k = i; k <= j; k++) {
      ranks[k] = avgRank
    }
    if (tieCount > 1) {
      tieSum += tieCount * tieCount * tieCount - tieCount
    }
    i = j + 1
  }

  let rankSum1 = 0
  for (let k = 0; k < N; k++) {
    if (combined[k]!.group === 1) {
      rankSum1 += ranks[k]!
    }
  }

  const u1 = rankSum1 - (n1 * (n1 + 1)) / 2
  const u2 = n1 * n2 - u1
  const u = Math.min(u1, u2)

  const meanU = (n1 * n2) / 2
  const tieCorrection = N > 1 ? tieSum / (N * (N - 1)) : 0
  const varU = (n1 * n2 / 12) * (N + 1 - tieCorrection)
  const sdU = Math.sqrt(Math.max(0, varU))

  if (sdU < 1e-12) {
    return { u, z: 0, p: 1.0 }
  }

  // 连续性修正
  const diff = Math.abs(u - meanU)
  const z = (Math.max(0, diff - 0.5)) / sdU
  // C1 修复：两尾 P 值为 2 * P(Z >= z) = 2 * (0.5 * erfc(z/√2)) = erfc(z/√2)，避免双倍放大 P 值
  const p = Math.max(0, Math.min(1, erfc(z / Math.SQRT2)))

  return { u, z, p }
}

/** 多组非正态连续变量比较：Kruskal-Wallis 秩和检验 */
export function kruskalWallisTest(groups: number[][]): { H: number; df: number; p: number } {
  const validGroups = groups.filter(g => g.length > 0)
  const k = validGroups.length
  if (k < 2) return { H: 0, df: 1, p: 1.0 }

  type Item = { val: number; groupIdx: number }
  const combined: Item[] = []
  validGroups.forEach((group, idx) => {
    for (const val of group) combined.push({ val, groupIdx: idx })
  })
  combined.sort((a, b) => a.val - b.val)

  const N = combined.length
  const ranks: number[] = new Array(N)
  let tieSum = 0

  let i = 0
  while (i < N) {
    let j = i
    while (j < N - 1 && combined[j + 1]!.val === combined[i]!.val) {
      j++
    }
    const tieCount = j - i + 1
    const avgRank = (i + 1 + j + 1) / 2
    for (let idx = i; idx <= j; idx++) {
      ranks[idx] = avgRank
    }
    if (tieCount > 1) {
      tieSum += tieCount * tieCount * tieCount - tieCount
    }
    i = j + 1
  }

  const groupRankSums = new Array(k).fill(0)
  for (let idx = 0; idx < N; idx++) {
    groupRankSums[combined[idx]!.groupIdx] += ranks[idx]!
  }

  let sumR2OverN = 0
  validGroups.forEach((group, idx) => {
    sumR2OverN += Math.pow(groupRankSums[idx], 2) / group.length
  })

  let H = (12 / (N * (N + 1))) * sumR2OverN - 3 * (N + 1)
  const denominator = 1 - tieSum / (N * N * N - N)
  if (denominator > 1e-12) {
    H /= denominator
  }

  const df = k - 1
  const p = chiSquareUpperPValue(Math.max(0, H), df)

  return { H, df, p }
}

/** 2x2 列联表 Fisher 精确检验（两足概率和） */
export function fisherExactTest2x2(a: number, b: number, c: number, d: number): { p: number } {
  const r1 = a + b
  const r2 = c + d
  const c1 = a + c
  const c2 = b + d
  const n = r1 + r2

  if (n === 0) return { p: 1.0 }

  const logFact = (k: number) => logGamma(k + 1)
  const logHypergeometric = (x: number) => {
    return logFact(r1) + logFact(r2) + logFact(c1) + logFact(c2) -
      logFact(n) - logFact(x) - logFact(r1 - x) - logFact(c1 - x) - logFact(r2 - (c1 - x))
  }

  const minX = Math.max(0, c1 - r2)
  const maxX = Math.min(r1, c1)

  const logP0 = logHypergeometric(a)
  const p0 = Math.exp(logP0)

  let pSum = 0
  for (let x = minX; x <= maxX; x++) {
    const logP = logHypergeometric(x)
    const p = Math.exp(logP)
    // 浮点容差 1 + 1e-7
    if (p <= p0 * (1 + 1e-7)) {
      pSum += p
    }
  }

  return { p: Math.max(0, Math.min(1.0, pSum)) }
}

/** r x c 列联表 Pearson 卡方检验（若 2x2 且期望频数 < 5 则自动无缝升级为 Fisher 精确检验） */
export function chiSquareOrFisher(contingencyMatrix: number[][]): {
  chi2: number
  df: number
  p: number
  method: 'Chi-square test' | 'Fisher’s exact test'
} {
  const r = contingencyMatrix.length
  if (r === 0) return { chi2: 0, df: 1, p: 1.0, method: 'Chi-square test' }
  const c = contingencyMatrix[0]!.length
  if (c === 0) return { chi2: 0, df: 1, p: 1.0, method: 'Chi-square test' }

  const rowSums = contingencyMatrix.map(row => row.reduce((a, b) => a + b, 0))
  const colSums = new Array(c).fill(0)
  for (let j = 0; j < c; j++) {
    for (let i = 0; i < r; i++) {
      colSums[j] += contingencyMatrix[i]![j]!
    }
  }
  const total = rowSums.reduce((a, b) => a + b, 0)
  if (total === 0) return { chi2: 0, df: 1, p: 1.0, method: 'Chi-square test' }

  // 检查期望频数
  let minExpected = Infinity
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const exp = (rowSums[i]! * colSums[j]!) / total
      if (exp < minExpected) minExpected = exp
    }
  }

  // 若为 2x2 且期望频数 < 5 或总数 < 40，使用 Fisher 精确检验
  if (r === 2 && c === 2 && (minExpected < 5 || total < 40)) {
    const a = contingencyMatrix[0]![0]!
    const b = contingencyMatrix[0]![1]!
    const cVal = contingencyMatrix[1]![0]!
    const d = contingencyMatrix[1]![1]!
    const res = fisherExactTest2x2(a, b, cVal, d)
    return { chi2: 0, df: 1, p: res.p, method: 'Fisher’s exact test' }
  }

  // 否则执行 Pearson 卡方检验
  let chi2 = 0
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const observed = contingencyMatrix[i]![j]!
      const expected = (rowSums[i]! * colSums[j]!) / total
      if (expected > 1e-12) {
        chi2 += Math.pow(observed - expected, 2) / expected
      }
    }
  }

  const df = (r - 1) * (c - 1)
  const p = chiSquareUpperPValue(chi2, df)
  return { chi2, df, p, method: 'Chi-square test' }
}

/** 计算连续变量的标化均数差 SMD (Cohen's d with pooled SD) */
export function calculateContinuousSmd(group1: number[], group2: number[]): number | null {
  const n1 = group1.length
  const n2 = group2.length
  if (n1 < 2 || n2 < 2) return null

  const s1 = summarizeContinuous(group1)
  const s2 = summarizeContinuous(group2)

  const pooledVariance = ((n1 - 1) * s1.sd * s1.sd + (n2 - 1) * s2.sd * s2.sd) / (n1 + n2 - 2)
  const pooledSd = Math.sqrt(Math.max(0, pooledVariance))

  if (pooledSd < 1e-12) {
    return s1.mean === s2.mean ? 0 : null
  }
  return Math.abs(s1.mean - s2.mean) / pooledSd
}

/** 计算分类变量的标化均数差 SMD (Austin 2009 / Max Pairwise SMD) */
export function calculateCategoricalSmd(counts1: number[], counts2: number[]): number | null {
  const total1 = counts1.reduce((a, b) => a + b, 0)
  const total2 = counts2.reduce((a, b) => a + b, 0)
  if (total1 === 0 || total2 === 0) return null

  const p1 = counts1.map(c => c / total1)
  const p2 = counts2.map(c => c / total2)

  if (counts1.length === 2) {
    // 二分类：SMD = |p1 - p2| / sqrt((p1(1-p1) + p2(1-p2))/2)
    const prob1 = p1[0]!
    const prob2 = p2[0]!
    const denom = Math.sqrt((prob1 * (1 - prob1) + prob2 * (1 - prob2)) / 2)
    return denom < 1e-12 ? 0 : Math.abs(prob1 - prob2) / denom
  }

  // 多分类：最大单类别标化差（临床实用标准）
  let maxSmd = 0
  for (let i = 0; i < p1.length; i++) {
    const prob1 = p1[i]!
    const prob2 = p2[i]!
    const denom = Math.sqrt((prob1 * (1 - prob1) + prob2 * (1 - prob2)) / 2)
    if (denom > 1e-12) {
      const smd = Math.abs(prob1 - prob2) / denom
      if (smd > maxSmd) maxSmd = smd
    }
  }
  return maxSmd
}

// ==========================================
// 3. 格式化工具
// ==========================================

export function formatP(p: number | null | undefined, digits = 3): string {
  if (p === null || p === undefined || isNaN(p)) return '—'
  if (p < 0.001) return '< 0.001'
  if (p > 0.999) return '> 0.999'
  return p.toFixed(digits)
}

export function formatSmd(smd: number | null | undefined, digits = 3): string {
  if (smd === null || smd === undefined || isNaN(smd)) return '—'
  if (smd < 0.001) return '< 0.001'
  return smd.toFixed(digits)
}

// ==========================================
// 4. Table 1 主计算引擎
// ==========================================

export function generateTable1FromData(
  records: Record<string, unknown>[],
  options: Table1Options = {},
): Table1Result {
  const {
    group_col,
    include_overall = true,
    include_p_value = Boolean(group_col),
    include_smd = Boolean(group_col),
    show_missing = true,
    title = 'Table 1. Baseline Demographic and Clinical Characteristics',
    labels = {},
    decimals = {},
  } = options

  const contDecimals = decimals.continuous ?? 1
  const pctDecimals = decimals.percentage ?? 1
  const pDecimals = decimals.p_value ?? 3
  const smdDecimals = decimals.smd ?? 3

  if (!records.length) {
    return {
      title,
      groups: [],
      total_n: 0,
      headers: ['Characteristic'],
      rows: [],
      footnotes: [],
      markdown: `### ${title}\n\n*No data available.*`,
    }
  }

  // 1. 提取所有可用列
  const allCols = Object.keys(records[0] ?? {})
  const targetCols = options.columns && options.columns.length > 0
    ? options.columns.filter(c => allCols.includes(c))
    : allCols.filter(c => {
        if (c === group_col) return false
        // 过滤常见 ID 类变量
        const lower = c.toLowerCase()
        if (lower === 'id' || lower === 'pid' || lower.endsWith('_id') || lower === 'uuid') return false
        return true
      })

  // 2. 分组提取
  let groupNames: string[] = []
  if (group_col) {
    const rawGroups = new Set<string>()
    for (const r of records) {
      const g = r[group_col]
      if (g !== undefined && g !== null && String(g).trim() !== '') {
        rawGroups.add(String(g).trim())
      }
    }
    groupNames = Array.from(rawGroups).sort()
  }

  const isTwoGroups = groupNames.length === 2
  const calcPValue = include_p_value && groupNames.length >= 2
  const calcSmd = include_smd && isTwoGroups

  // 组计数
  const totalN = records.length
  const groupCounts: Record<string, number> = {}
  for (const g of groupNames) groupCounts[g] = 0
  for (const r of records) {
    if (group_col) {
      const g = String(r[group_col] ?? '').trim()
      if (groupCounts[g] !== undefined) groupCounts[g]++
    }
  }

  const groups: Table1Group[] = groupNames.map(g => ({
    name: g,
    label: labels[g] ?? g,
    count: groupCounts[g]!,
    percentage: totalN > 0 ? (groupCounts[g]! / totalN) * 100 : 0,
  }))

  // 3. 构建表头
  const headers = ['Characteristic']
  if (include_overall) {
    headers.push(`Overall (N=${totalN})`)
  }
  for (const g of groups) {
    headers.push(`${g.label} (N=${g.count})`)
  }
  if (calcPValue) headers.push('P value')
  if (calcSmd) headers.push('SMD')

  // 4. 逐列进行分析与组间比较
  const tableRows: Table1Row[] = []
  const usedMethods = new Set<string>()

  for (const col of targetCols) {
    const colLabel = labels[col] ?? col
    const nonNormalSet = new Set(options.non_normal_vars ?? [])
    const continuousSet = new Set(options.continuous_vars ?? [])
    const categoricalSet = new Set(options.categorical_vars ?? [])

    // 自动判定变量类型：优先取显式指定，否则根据数据值探测
    let isContinuous = false
    if (continuousSet.has(col)) {
      isContinuous = true
    } else if (categoricalSet.has(col)) {
      isContinuous = false
    } else {
      // 探测：收集非空值
      let numCount = 0
      let validCount = 0
      const uniqueVals = new Set<string>()
      for (const r of records) {
        const v = r[col]
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          validCount++
          const str = String(v).trim()
          uniqueVals.add(str)
          if (!isNaN(Number(str))) numCount++
        }
      }
      // 数值比例 > 80% 且唯一值数量 > 5 视为连续型，否则视为分类型
      if (validCount > 0 && numCount / validCount > 0.8 && uniqueVals.size > 5) {
        isContinuous = true
      } else {
        isContinuous = false
      }
    }

    // 统计各组与总体缺失
    let missingTotal = 0
    const missingByGroup: Record<string, { count: number; percentage: number }> = {}
    for (const g of groupNames) missingByGroup[g] = { count: 0, percentage: 0 }

    for (const r of records) {
      const v = r[col]
      const isMissing = v === undefined || v === null || String(v).trim() === ''
      if (isMissing) {
        missingTotal++
        if (group_col) {
          const g = String(r[group_col] ?? '').trim()
          if (missingByGroup[g]) missingByGroup[g].count++
        }
      }
    }
    for (const g of groupNames) {
      const cnt = groupCounts[g]!
      missingByGroup[g]!.percentage = cnt > 0 ? (missingByGroup[g]!.count / cnt) * 100 : 0
    }

    if (isContinuous) {
      // 连续型变量处理
      const extractVals = (filter?: (r: Record<string, unknown>) => boolean): number[] => {
        const out: number[] = []
        for (const r of records) {
          if (filter && !filter(r)) continue
          const v = r[col]
          if (v !== undefined && v !== null && String(v).trim() !== '') {
            const num = Number(v)
            if (!isNaN(num)) out.push(num)
          }
        }
        return out
      }

      const overallVals = extractVals()
      const groupVals: Record<string, number[]> = {}
      for (const g of groupNames) {
        groupVals[g] = extractVals(r => String(r[group_col!] ?? '').trim() === g)
      }

      const overallStats = summarizeContinuous(overallVals)
      // 是否作为非正态（中位数 [四分位距]）展现
      const treatAsNonNormal = nonNormalSet.has(col) || !overallStats.is_normal

      const formatContinuousVal = (stats: ContinuousSummary) => {
        if (stats.n === 0) return '—'
        if (treatAsNonNormal) {
          return `${stats.median.toFixed(contDecimals)} [${stats.q1.toFixed(contDecimals)} - ${stats.q3.toFixed(contDecimals)}]`
        } else {
          return `${stats.mean.toFixed(contDecimals)} ± ${stats.sd.toFixed(contDecimals)}`
        }
      }

      const groupSummaries: Record<string, string> = {}
      for (const g of groupNames) {
        const s = summarizeContinuous(groupVals[g] ?? [])
        groupSummaries[g] = formatContinuousVal(s)
      }

      // 统计检验与 SMD
      let pValue: number | null = null
      let testMethod: string | undefined
      let testStatistic: number | null = null
      let dfVal: number | null = null
      let smdVal: number | null = null

      if (calcPValue) {
        if (isTwoGroups) {
          const g1Vals = groupVals[groupNames[0]!] ?? []
          const g2Vals = groupVals[groupNames[1]!] ?? []
          if (treatAsNonNormal) {
            const uRes = mannWhitneyUTest(g1Vals, g2Vals)
            pValue = uRes.p
            testMethod = 'Mann-Whitney U test'
            testStatistic = uRes.u
            usedMethods.add(testMethod)
          } else {
            const tRes = welchTTest(g1Vals, g2Vals)
            pValue = tRes.p
            testMethod = "Welch's t-test"
            testStatistic = tRes.t
            dfVal = tRes.df
            usedMethods.add(testMethod)
          }
        } else if (groupNames.length > 2) {
          const allGroupList = groupNames.map(g => groupVals[g] ?? [])
          if (treatAsNonNormal) {
            const kwRes = kruskalWallisTest(allGroupList)
            pValue = kwRes.p
            testMethod = 'Kruskal-Wallis test'
            testStatistic = kwRes.H
            dfVal = kwRes.df
            usedMethods.add(testMethod)
          } else {
            const anovaRes = oneWayAnova(allGroupList)
            pValue = anovaRes.p
            testMethod = 'One-way ANOVA'
            testStatistic = anovaRes.F
            dfVal = anovaRes.df1
            usedMethods.add(testMethod)
          }
        }
      }

      if (calcSmd) {
        const g1Vals = groupVals[groupNames[0]!] ?? []
        const g2Vals = groupVals[groupNames[1]!] ?? []
        smdVal = calculateContinuousSmd(g1Vals, g2Vals)
      }

      const mainLabel = treatAsNonNormal ? `${colLabel}, median [IQR]` : `${colLabel}, mean ± SD`

      tableRows.push({
        variable: col,
        label: mainLabel,
        type: 'continuous',
        indent: 0,
        overall: include_overall ? formatContinuousVal(overallStats) : undefined,
        groups: groupSummaries,
        test_method: testMethod,
        test_statistic: testStatistic,
        df: dfVal,
        p_value: pValue,
        p_value_formatted: formatP(pValue, pDecimals),
        smd: smdVal,
        smd_formatted: formatSmd(smdVal, smdDecimals),
        missing: missingTotal > 0 ? {
          total: missingTotal,
          percentage: totalN > 0 ? (missingTotal / totalN) * 100 : 0,
          groups: missingByGroup,
        } : undefined,
      })

      if (show_missing && missingTotal > 0) {
        const missingGroups: Record<string, string> = {}
        for (const g of groupNames) {
          const m = missingByGroup[g]!
          missingGroups[g] = `${m.count} (${m.percentage.toFixed(pctDecimals)}%)`
        }
        tableRows.push({
          variable: col,
          label: 'Missing',
          type: 'continuous',
          indent: 1,
          overall: include_overall ? `${missingTotal} (${((missingTotal / totalN) * 100).toFixed(pctDecimals)}%)` : undefined,
          groups: missingGroups,
        })
      }
    } else {
      // 分类型变量处理
      // 收集所有类别并排序
      const categorySet = new Set<string>()
      for (const r of records) {
        const v = r[col]
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          categorySet.add(String(v).trim())
        }
      }
      const levels = Array.from(categorySet).sort()

      // 各组与总体的频数
      const overallCategoryCounts: Record<string, number> = {}
      const groupCategoryCounts: Record<string, Record<string, number>> = {}
      for (const lvl of levels) {
        overallCategoryCounts[lvl] = 0
        for (const g of groupNames) {
          if (!groupCategoryCounts[g]) groupCategoryCounts[g] = {}
          groupCategoryCounts[g]![lvl] = 0
        }
      }

      for (const r of records) {
        const v = r[col]
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          const lvl = String(v).trim()
          if (overallCategoryCounts[lvl] !== undefined) overallCategoryCounts[lvl]++
          if (group_col) {
            const g = String(r[group_col] ?? '').trim()
            if (groupCategoryCounts[g] && groupCategoryCounts[g]![lvl] !== undefined) {
              groupCategoryCounts[g]![lvl]++
            }
          }
        }
      }

      // 卡方检验与 SMD 计算
      let pValue: number | null = null
      let testMethod: string | undefined
      let smdVal: number | null = null

      if (calcPValue && levels.length >= 1) {
        // 构建列联表：每一行是一个 level，每一列是一个 group
        const matrix: number[][] = levels.map(lvl => {
          return groupNames.map(g => groupCategoryCounts[g]![lvl] ?? 0)
        })
        const chiRes = chiSquareOrFisher(matrix)
        pValue = chiRes.p
        testMethod = chiRes.method
        usedMethods.add(testMethod)
      }

      if (calcSmd && levels.length >= 1) {
        const counts1 = levels.map(lvl => groupCategoryCounts[groupNames[0]!]![lvl] ?? 0)
        const counts2 = levels.map(lvl => groupCategoryCounts[groupNames[1]!]![lvl] ?? 0)
        smdVal = calculateCategoricalSmd(counts1, counts2)
      }

      // 变量主行
      tableRows.push({
        variable: col,
        label: `${colLabel}, n (%)`,
        type: 'categorical',
        indent: 0,
        overall: '',
        groups: Object.fromEntries(groupNames.map(g => [g, ''])),
        test_method: testMethod,
        p_value: pValue,
        p_value_formatted: formatP(pValue, pDecimals),
        smd: smdVal,
        smd_formatted: formatSmd(smdVal, smdDecimals),
        missing: missingTotal > 0 ? {
          total: missingTotal,
          percentage: totalN > 0 ? (missingTotal / totalN) * 100 : 0,
          groups: missingByGroup,
        } : undefined,
      })

      // 各类别子行
      for (const lvl of levels) {
        const lvlLabel = labels[`${col}.${lvl}`] ?? labels[lvl] ?? lvl
        const cntOverall = overallCategoryCounts[lvl] ?? 0
        const pctOverall = totalN > 0 ? (cntOverall / totalN) * 100 : 0
        const groupTexts: Record<string, string> = {}
        for (const g of groupNames) {
          const cnt = groupCategoryCounts[g]![lvl] ?? 0
          const denom = groupCounts[g]!
          const pct = denom > 0 ? (cnt / denom) * 100 : 0
          groupTexts[g] = `${cnt} (${pct.toFixed(pctDecimals)}%)`
        }

        tableRows.push({
          variable: col,
          label: lvlLabel,
          type: 'categorical',
          is_category_level: true,
          level: lvl,
          indent: 1,
          overall: include_overall ? `${cntOverall} (${pctOverall.toFixed(pctDecimals)}%)` : undefined,
          groups: groupTexts,
        })
      }

      if (show_missing && missingTotal > 0) {
        const missingGroups: Record<string, string> = {}
        for (const g of groupNames) {
          const m = missingByGroup[g]!
          missingGroups[g] = `${m.count} (${m.percentage.toFixed(pctDecimals)}%)`
        }
        tableRows.push({
          variable: col,
          label: 'Missing',
          type: 'categorical',
          indent: 1,
          overall: include_overall ? `${missingTotal} (${((missingTotal / totalN) * 100).toFixed(pctDecimals)}%)` : undefined,
          groups: missingGroups,
        })
      }
    }
  }

  // 5. 组装标准三线表表注 (Footnotes)
  const footnotes: string[] = [
    'Values are presented as mean ± SD, median [IQR], or n (%).',
  ]
  if (usedMethods.size > 0) {
    const methodsList = Array.from(usedMethods).join(', ')
    footnotes.push(`P values are calculated using ${methodsList}.`)
  }
  const abbrevs: string[] = []
  if (calcSmd) abbrevs.push('SMD, Standardized Mean Difference')
  abbrevs.push('SD, Standard Deviation', 'IQR, Interquartile Range')
  footnotes.push(abbrevs.join('; ') + '.')

  // 6. 生成标准 Markdown GFM 三线表
  const mdLines: string[] = []
  mdLines.push(`### ${title}`)
  mdLines.push('')

  // 标头行
  const escMd = (s: string) => String(s).replace(/\|/g, '\\|')
  mdLines.push(`| ${headers.map(escMd).join(' | ')} |`)
  // 对齐行：首列左对齐，其余居中
  const alignTokens = headers.map((_, idx) => (idx === 0 ? ':---' : ':---:'))
  mdLines.push(`| ${alignTokens.join(' | ')} |`)

  for (const row of tableRows) {
    const cells: string[] = []
    // 缩进处理：使用不可分空格 &nbsp;&nbsp; 呈现医学表格专业层次
    const indentPrefix = row.indent > 0 ? '&nbsp;&nbsp;'.repeat(row.indent) : ''
    const rowTitle = row.indent === 0 ? `**${row.label}**` : `${indentPrefix}${row.label}`
    cells.push(rowTitle)

    if (include_overall) {
      cells.push(row.overall ?? '')
    }
    for (const g of groups) {
      cells.push(row.groups[g.name] ?? '')
    }
    if (calcPValue) {
      cells.push(row.indent === 0 ? (row.p_value_formatted ?? '') : '')
    }
    if (calcSmd) {
      cells.push(row.indent === 0 ? (row.smd_formatted ?? '') : '')
    }
    mdLines.push(`| ${cells.map(escMd).join(' | ')} |`)
  }

  mdLines.push('')
  mdLines.push(`*Note*: ${footnotes.join(' ')}`)

  const markdown = mdLines.join('\n')

  return {
    title,
    groups,
    total_n: totalN,
    headers,
    rows: tableRows,
    footnotes,
    markdown,
  }
}
