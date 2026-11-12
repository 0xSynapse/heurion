/**
 * 样本量估算（研究方案阶段的「计划样本量」，与 CONSORT 图里的实际入组人数无关）。
 *
 * 支持的设计：
 * - two_proportions：两组率比较（正态近似，可选 Fleiss 连续性校正）
 * - two_means：两组均值比较（t 分布迭代，结果与 G*Power 的两独立样本 t 检验一致）
 * - survival_logrank：生存分析 log-rank（Schoenfeld 事件数公式；总例数 = 事件数 / 预计事件发生比例，
 *   事件发生比例可直接给出，或由对照组中位生存期 + 入组期 + 随访期按指数分布推算）
 * - one_proportion：单臂率与历史对照比较（精确二项单阶段设计，同时给出正态近似作参考）
 * - simon_two_stage：Simon (1989) 两阶段设计（最优 / 极小极大）
 *
 * 所有结果都只由调用方给出的参数算出，不内置任何默认效应量；缺参数直接报错。
 */
import { normalCdf, regularizedIncompleteBeta } from '../datasets/table1.ts'

export type SampleSizeDesign = 'two_proportions' | 'two_means' | 'survival_logrank' | 'one_proportion' | 'simon_two_stage'

export interface SampleSizeInput {
  design: SampleSizeDesign
  /** I 类错误率 α（0 < α < 0.5） */
  alpha: number
  /** 检验效能 1 − β（0.5 ≤ power < 1） */
  power: number
  /** 单侧 / 双侧；两组比较默认双侧，单臂与 Simon 默认单侧（Simon 只支持单侧） */
  sides?: 1 | 2
  /** 分配比：组 2 人数 / 组 1 人数，默认 1 */
  ratio?: number
  /** 预计脱落率（0 ≤ dropout < 1），默认 0 */
  dropout?: number
  // two_proportions：组 1（对照）率 p1、组 2（试验）率 p2；one_proportion / simon：无效率 p0、目标率 p1
  p0?: number
  p1?: number
  p2?: number
  continuity_correction?: boolean
  // two_means：两组均值差与共同标准差
  mean_diff?: number
  sd?: number
  // survival_logrank：风险比（组 2 相对组 1）与事件发生比例（或由下列参数推算）
  hr?: number
  event_prob?: number
  median_control?: number
  accrual?: number
  follow_up?: number
}

export interface SimonDesign {
  /** 第一阶段入组 n1 例，有效例数 ≤ r1 则提前终止 */
  n1: number
  r1: number
  /** 两阶段共 n 例，总有效例数 ≤ r 则判定无效 */
  n: number
  r: number
  /** 原假设下的期望样本量与提前终止概率 */
  en0: number
  pet0: number
  actual_alpha: number
  actual_power: number
}

export interface SampleSizeResult {
  design: SampleSizeDesign
  /** 各组例数（单臂设计只有 1 组） */
  groups: Array<{ label: string; n: number; n_with_dropout: number }>
  total: number
  total_with_dropout: number
  /** 生存设计需要观察到的事件数 */
  events_required?: number
  /** 生存设计用到的事件发生比例 */
  event_prob_used?: number
  simon?: { optimal: SimonDesign; minimax: SimonDesign }
  /** 单臂精确设计：判定有效所需的最少有效例数 */
  one_proportion?: { min_responses: number; actual_alpha: number; actual_power: number; normal_approx_n: number }
  method: string
  method_en: string
  methods_text_zh: string
  methods_text_en: string
  warnings: string[]
}

// —— 分布函数 ——

/** 标准正态分位数（Acklam 有理逼近，相对误差 < 1.2e-9） */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error('正态分位数的概率必须在 0 与 1 之间')
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  let x: number
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  } else if (p <= 1 - pl) {
    const q = p - 0.5
    const r = q * q
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  // 一步 Halley 修正
  const e = normalCdf(x) - p
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2)
  return x - u / (1 + (x * u) / 2)
}

/** t 分布上尾概率 P(T > t)，t ≥ 0 */
function tUpper(t: number, df: number): number {
  return 0.5 * regularizedIncompleteBeta(df / 2, 0.5, df / (df + t * t))
}

/** t 分布上分位数：P(T > t) = q（0 < q < 0.5） */
export function tQuantileUpper(q: number, df: number): number {
  let lo = 0
  let hi = 1
  while (tUpper(hi, df) > q) hi *= 2
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (tUpper(mid, df) > q) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** 二项分布概率表 b[x] = P(X = x)，X ~ Bin(n, p) */
function binomPmf(n: number, p: number): number[] {
  const out = new Array<number>(n + 1).fill(0)
  if (p <= 0) { out[0] = 1; return out }
  if (p >= 1) { out[n] = 1; return out }
  const lq = Math.log(1 - p)
  const lp = Math.log(p)
  let logC = 0
  for (let x = 0; x <= n; x++) {
    if (x > 0) logC += Math.log((n - x + 1) / x)
    out[x] = Math.exp(logC + x * lp + (n - x) * lq)
  }
  return out
}

/** 上尾表 S[k] = P(X > k)，k = -1..n（S[-1] 存在 index 0） */
function binomSurvival(pmf: number[]): (k: number) => number {
  const n = pmf.length - 1
  const tail = new Array<number>(n + 2).fill(0)
  for (let k = n; k >= 0; k--) tail[k] = (tail[k + 1] ?? 0) + pmf[k]!
  // tail[k] = P(X ≥ k)；P(X > k) = tail[k + 1]
  return (k: number) => (k < 0 ? 1 : k >= n ? 0 : tail[k + 1]!)
}

// —— 参数校验 ——

const fmtPct = (v: number) => `${Number((v * 100).toFixed(1))}%`
const fmtNum = (v: number) => String(Number(v.toPrecision(4)))

function req(v: number | undefined, name: string, check: (x: number) => boolean, rule: string): number {
  if (v === undefined || v === null || !Number.isFinite(Number(v))) throw new Error(`缺少参数 ${name}`)
  const n = Number(v)
  if (!check(n)) throw new Error(`参数 ${name} ${rule}`)
  return n
}
const isProb = (x: number) => x > 0 && x < 1

/** Simon 两阶段：返回最优（原假设下期望样本量最小）与极小极大（最大样本量最小）设计 */
export function simonTwoStage(p0: number, p1: number, alpha: number, power: number, nMax = 150): { optimal: SimonDesign; minimax: SimonDesign } | null {
  let optimal: SimonDesign | null = null
  let minimax: SimonDesign | null = null
  for (let n = 2; n <= nMax; n++) {
    let bestForN: SimonDesign | null = null
    for (let n1 = 1; n1 < n; n1++) {
      const n2 = n - n1
      const b10 = binomPmf(n1, p0)
      const b11 = binomPmf(n1, p1)
      const s20 = binomSurvival(binomPmf(n2, p0))
      const s21 = binomSurvival(binomPmf(n2, p1))
      let cdf0 = 0
      for (let r1 = 0; r1 < n1; r1++) {
        cdf0 += b10[r1]!
        const pet0 = cdf0
        // α(r) = Σ_{x1>r1} b0(x1) · P(X2 > r − x1)，随 r 单调下降：二分找最小满足 α ≤ alpha 的 r
        const alphaAt = (r: number) => { let a = 0; for (let x = r1 + 1; x <= n1; x++) a += b10[x]! * s20(r - x); return a }
        let lo = r1
        let hi = n
        if (alphaAt(hi) > alpha) continue
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2)
          if (alphaAt(mid) <= alpha) hi = mid
          else lo = mid + 1
        }
        const r = lo
        let pw = 0
        for (let x = r1 + 1; x <= n1; x++) pw += b11[x]! * s21(r - x)
        if (pw < power) continue
        const en0 = n1 + (1 - pet0) * n2
        const cand: SimonDesign = { n1, r1, n, r, en0, pet0, actual_alpha: alphaAt(r), actual_power: pw }
        if (!bestForN || en0 < bestForN.en0 - 1e-12) bestForN = cand
        if (!optimal || en0 < optimal.en0 - 1e-12) optimal = cand
      }
    }
    if (bestForN && !minimax) minimax = bestForN
    // 最优设计的期望样本量不小于 n1 + ...；当 n 远超当前最优 EN0 的 1.5 倍后已不可能更优，可提前结束
    if (optimal && n > Math.max(optimal.n, optimal.en0) * 1.6 && minimax) break
  }
  if (!optimal || !minimax) return null
  const round = (d: SimonDesign): SimonDesign => ({
    ...d,
    en0: Number(d.en0.toFixed(2)),
    pet0: Number(d.pet0.toFixed(3)),
    actual_alpha: Number(d.actual_alpha.toFixed(4)),
    actual_power: Number(d.actual_power.toFixed(4)),
  })
  return { optimal: round(optimal), minimax: round(minimax) }
}

/** 主入口：按设计计算样本量与方法学描述 */
export function calculateSampleSize(input: SampleSizeInput): SampleSizeResult {
  const design = input.design
  const alpha = req(input.alpha, 'alpha (α)', x => x > 0 && x < 0.5, '须在 0 与 0.5 之间')
  const power = req(input.power, 'power (1−β)', x => x >= 0.5 && x < 1, '须在 0.5 与 1 之间')
  const defaultSides = design === 'one_proportion' || design === 'simon_two_stage' ? 1 : 2
  const sides = input.sides === 1 || input.sides === 2 ? input.sides : defaultSides
  if (design === 'simon_two_stage' && sides !== 1) throw new Error('Simon 两阶段设计只支持单侧 α')
  const dropout = input.dropout === undefined ? 0 : req(input.dropout, 'dropout（脱落率）', x => x >= 0 && x < 1, '须在 0 与 1 之间（不含 1）')
  const ratio = input.ratio === undefined ? 1 : req(input.ratio, 'ratio（分配比）', x => x > 0 && x <= 10, '须大于 0 且不超过 10')
  const zA = normalQuantile(1 - alpha / sides)
  const zB = normalQuantile(power)
  const warnings: string[] = []
  const inflate = (n: number) => Math.ceil(n / (1 - dropout) - 1e-9)
  const sideZh = sides === 2 ? '双侧' : '单侧'
  const sideEn = sides === 2 ? 'two-sided' : 'one-sided'
  const ratioZh = ratio === 1 ? '1:1' : `1:${fmtNum(ratio)}`
  const common = (zh: string, en: string, groups: SampleSizeResult['groups']) => {
    const total = groups.reduce((s, g) => s + g.n, 0)
    const totalD = groups.reduce((s, g) => s + g.n_with_dropout, 0)
    const per = groups.length === 2 ? `每组分别需 ${groups[0]!.n} 例与 ${groups[1]!.n} 例，` : ''
    const perEn = groups.length === 2 ? `${groups[0]!.n} and ${groups[1]!.n} participants per group, ` : ''
    const dropZh = dropout > 0 ? `考虑 ${fmtPct(dropout)} 的脱落率，计划入组 ${totalD} 例${groups.length === 2 ? `（${groups[0]!.n_with_dropout} 例 / ${groups[1]!.n_with_dropout} 例）` : ''}。` : ''
    const dropEn = dropout > 0 ? ` Allowing for a ${fmtPct(dropout)} dropout rate, ${totalD} participants will be enrolled.` : ''
    return {
      total,
      total_with_dropout: totalD,
      methods_text_zh: `${zh}${per}共 ${total} 例。${dropZh}`,
      methods_text_en: `${en} ${perEn}${total} in total.${dropEn}`,
    }
  }
  const twoGroups = (n1raw: number, labels: [string, string]): SampleSizeResult['groups'] => {
    const n1 = Math.ceil(n1raw - 1e-9)
    const n2 = Math.ceil(n1raw * ratio - 1e-9)
    return [
      { label: labels[0], n: n1, n_with_dropout: inflate(n1) },
      { label: labels[1], n: n2, n_with_dropout: inflate(n2) },
    ]
  }

  if (design === 'two_proportions') {
    const p1 = req(input.p1, 'p1（组 1 率）', isProb, '须在 0 与 1 之间')
    const p2 = req(input.p2, 'p2（组 2 率）', isProb, '须在 0 与 1 之间')
    if (p1 === p2) throw new Error('两组率相同，无法计算样本量')
    const k = ratio
    const pBar = (p1 + k * p2) / (1 + k)
    const delta = Math.abs(p1 - p2)
    const num = zA * Math.sqrt(pBar * (1 - pBar) * (1 + 1 / k)) + zB * Math.sqrt(p1 * (1 - p1) + (p2 * (1 - p2)) / k)
    let n1 = (num * num) / (delta * delta)
    const cc = !!input.continuity_correction
    if (cc) n1 = (n1 / 4) * (1 + Math.sqrt(1 + (2 * (k + 1)) / (k * n1 * delta))) ** 2
    const groups = twoGroups(n1, ['组 1（对照）', '组 2（试验）'])
    const method = `两独立样本率比较（正态近似${cc ? '，Fleiss 连续性校正' : ''}）`
    const methodEn = `comparison of two independent proportions (normal approximation${cc ? ' with Fleiss continuity correction' : ''})`
    const txt = common(
      `样本量按${method}计算：假设组 1 与组 2 的率分别为 ${fmtPct(p1)} 与 ${fmtPct(p2)}，取${sideZh} α = ${alpha}、检验效能 ${fmtPct(power)}、分配比 ${ratioZh}，`,
      `Sample size was calculated for a ${methodEn}, assuming proportions of ${fmtPct(p1)} and ${fmtPct(p2)}, a ${sideEn} α of ${alpha}, ${fmtPct(power)} power and an allocation ratio of ${ratioZh}:`,
      groups,
    )
    return { design, groups, ...txt, method, method_en: methodEn, warnings }
  }

  if (design === 'two_means') {
    const diff = Math.abs(req(input.mean_diff, 'mean_diff（均值差）', x => x !== 0, '不能为 0'))
    const sd = req(input.sd, 'sd（标准差）', x => x > 0, '须大于 0')
    const k = ratio
    const d = diff / sd
    // 先用正态近似，再按 t 分布迭代至收敛（df = n1 + n2 − 2）
    let n1 = ((zA + zB) ** 2 * (1 + 1 / k)) / (d * d)
    for (let i = 0; i < 50; i++) {
      const df = Math.max(1, n1 * (1 + k) - 2)
      const tA = tQuantileUpper(alpha / sides, df)
      const tB = tQuantileUpper(1 - power, df)
      const next = ((tA + tB) ** 2 * (1 + 1 / k)) / (d * d)
      if (Math.abs(next - n1) < 1e-6) { n1 = next; break }
      n1 = next
    }
    const groups = twoGroups(n1, ['组 1', '组 2'])
    const method = '两独立样本均值比较（t 检验）'
    const methodEn = 'comparison of two independent means (t test)'
    const txt = common(
      `样本量按${method}计算：假设两组均值差为 ${fmtNum(diff)}、共同标准差为 ${fmtNum(sd)}（效应量 d = ${d.toFixed(2)}），取${sideZh} α = ${alpha}、检验效能 ${fmtPct(power)}、分配比 ${ratioZh}，`,
      `Sample size was calculated for a ${methodEn}, assuming a mean difference of ${fmtNum(diff)} with a common SD of ${fmtNum(sd)} (Cohen's d = ${d.toFixed(2)}), a ${sideEn} α of ${alpha}, ${fmtPct(power)} power and an allocation ratio of ${ratioZh}:`,
      groups,
    )
    return { design, groups, ...txt, method, method_en: methodEn, warnings }
  }

  if (design === 'survival_logrank') {
    const hr = req(input.hr, 'hr（风险比）', x => x > 0 && x !== 1, '须大于 0 且不等于 1')
    const k = ratio
    const events = Math.ceil(((zA + zB) ** 2 * (1 + k) ** 2) / (k * Math.log(hr) ** 2) - 1e-9)
    let pEvent: number
    let probNoteZh: string
    let probNoteEn: string
    if (input.event_prob !== undefined && input.event_prob !== null) {
      pEvent = req(input.event_prob, 'event_prob（事件发生比例）', isProb, '须在 0 与 1 之间')
      probNoteZh = `预计研究期间总体事件发生比例为 ${fmtPct(pEvent)}`
      probNoteEn = `an overall event probability of ${fmtPct(pEvent)} during the study`
    } else {
      const med = req(input.median_control, 'median_control（组 1 中位生存期）或 event_prob', x => x > 0, '须大于 0')
      const acc = req(input.accrual, 'accrual（入组期）', x => x >= 0, '不能为负')
      const fu = req(input.follow_up, 'follow_up（末例入组后随访期）', x => x > 0, '须大于 0')
      // 指数分布、均匀入组：P(事件) = 1 − [e^{−λF} − e^{−λ(A+F)}] / (λA)
      const pOf = (lambda: number) => (acc === 0 ? 1 - Math.exp(-lambda * fu) : 1 - (Math.exp(-lambda * fu) - Math.exp(-lambda * (acc + fu))) / (lambda * acc))
      const lc = Math.LN2 / med
      pEvent = (pOf(lc) + k * pOf(lc * hr)) / (1 + k)
      probNoteZh = `假设生存时间服从指数分布、组 1 中位生存期 ${fmtNum(med)}、入组期 ${fmtNum(acc)}、末例入组后随访 ${fmtNum(fu)}（同一时间单位）、入组均匀，推算总体事件发生比例为 ${fmtPct(pEvent)}`
      probNoteEn = `an overall event probability of ${fmtPct(pEvent)}, derived assuming exponential survival with a median of ${fmtNum(med)} in group 1, uniform accrual over ${fmtNum(acc)} and ${fmtNum(fu)} of additional follow-up (same time unit)`
    }
    const totalRaw = events / pEvent
    const groups = twoGroups(totalRaw / (1 + k), ['组 1（对照）', '组 2（试验）'])
    const method = '生存分析 log-rank 检验（Schoenfeld 公式）'
    const methodEn = 'log-rank test (Schoenfeld formula)'
    const txt = common(
      `样本量按${method}计算：假设风险比 HR = ${fmtNum(hr)}，取${sideZh} α = ${alpha}、检验效能 ${fmtPct(power)}、分配比 ${ratioZh}，需观察到 ${events} 个事件；${probNoteZh}，`,
      `Sample size was calculated for a ${methodEn}, assuming a hazard ratio of ${fmtNum(hr)}, a ${sideEn} α of ${alpha}, ${fmtPct(power)} power and an allocation ratio of ${ratioZh}; ${events} events are required. Assuming ${probNoteEn}, this requires`,
      groups,
    )
    if (pEvent < 0.05) warnings.push('事件发生比例很低，所需样本量对该假设非常敏感，请核对随访期与中位生存期的设定')
    return { design, groups, ...txt, events_required: events, event_prob_used: Number(pEvent.toFixed(4)), method, method_en: methodEn, warnings }
  }

  if (design === 'one_proportion') {
    const p0 = req(input.p0, 'p0（无效 / 历史对照率）', isProb, '须在 0 与 1 之间')
    const p1 = req(input.p1, 'p1（预期有效率）', isProb, '须在 0 与 1 之间')
    if (p1 <= p0) throw new Error('单臂设计要求预期有效率 p1 大于无效率 p0')
    const nNormal = Math.ceil(((zA * Math.sqrt(p0 * (1 - p0)) + zB * Math.sqrt(p1 * (1 - p1))) / (p1 - p0)) ** 2 - 1e-9)
    // 精确二项（单阶段）：最小 n，存在 r 使 P(X ≥ r | p0) ≤ α 且 P(X ≥ r | p1) ≥ power
    const a1 = alpha / sides
    let exact: { n: number; r: number; a: number; pw: number } | null = null
    for (let n = 1; n <= 2000 && !exact; n++) {
      const s0 = binomSurvival(binomPmf(n, p0))
      const s1 = binomSurvival(binomPmf(n, p1))
      for (let r = 0; r <= n; r++) {
        const a = s0(r - 1)
        if (a > a1) continue
        const pw = s1(r - 1)
        if (pw >= power) exact = { n, r, a, pw }
        break
      }
    }
    if (!exact) throw new Error('在 2000 例以内找不到满足条件的精确设计，请检查 p0 与 p1')
    const groups = [{ label: '单臂', n: exact.n, n_with_dropout: inflate(exact.n) }]
    const method = '单臂率与历史对照比较（精确二项，单阶段）'
    const methodEn = 'single-arm comparison with a historical rate (exact binomial, single stage)'
    const txt = common(
      `样本量按${method}计算：无效率 p0 = ${fmtPct(p0)}、预期有效率 p1 = ${fmtPct(p1)}，取${sideZh} α = ${alpha}、检验效能 ${fmtPct(power)}，需入组 ${exact.n} 例，有效例数 ≥ ${exact.r} 例时判定有效（实际 α = ${exact.a.toFixed(3)}，实际效能 = ${fmtPct(exact.pw)}），`,
      `Sample size was calculated for a ${methodEn} with p0 = ${fmtPct(p0)} and p1 = ${fmtPct(p1)}, a ${sideEn} α of ${alpha} and ${fmtPct(power)} power: ${exact.n} participants are required and the treatment will be considered active if at least ${exact.r} respond (exact α = ${exact.a.toFixed(3)}, power = ${fmtPct(exact.pw)});`,
      groups,
    )
    return {
      design, groups, ...txt, method, method_en: methodEn, warnings,
      one_proportion: { min_responses: exact.r, actual_alpha: Number(exact.a.toFixed(4)), actual_power: Number(exact.pw.toFixed(4)), normal_approx_n: nNormal },
    }
  }

  if (design === 'simon_two_stage') {
    const p0 = req(input.p0, 'p0（无效率）', isProb, '须在 0 与 1 之间')
    const p1 = req(input.p1, 'p1（预期有效率）', isProb, '须在 0 与 1 之间')
    if (p1 <= p0) throw new Error('Simon 两阶段设计要求预期有效率 p1 大于无效率 p0')
    if (p1 - p0 < 0.05) throw new Error('p1 与 p0 相差不足 5 个百分点，两阶段设计所需样本量过大，请改用单阶段或重新设定')
    const res = simonTwoStage(p0, p1, alpha, power)
    if (!res) throw new Error('在 150 例以内找不到满足条件的 Simon 两阶段设计，请检查 p0、p1')
    const o = res.optimal
    const groups = [{ label: '单臂（最优设计最大样本量）', n: o.n, n_with_dropout: inflate(o.n) }]
    const method = 'Simon 两阶段设计（最优）'
    const methodEn = "Simon's optimal two-stage design"
    const txt = common(
      `样本量按 ${method}计算：无效率 p0 = ${fmtPct(p0)}、预期有效率 p1 = ${fmtPct(p1)}，取单侧 α = ${alpha}、检验效能 ${fmtPct(power)}。第一阶段入组 ${o.n1} 例，有效 ≤ ${o.r1} 例则提前终止；否则继续入组至 ${o.n} 例，总有效例数 > ${o.r} 例时判定有效（原假设下提前终止概率 ${fmtPct(o.pet0)}，期望样本量 ${o.en0} 例），最大样本量`,
      `Sample size was calculated using ${methodEn} with p0 = ${fmtPct(p0)}, p1 = ${fmtPct(p1)}, a one-sided α of ${alpha} and ${fmtPct(power)} power. In stage 1, ${o.n1} participants will be enrolled; the trial stops early if ≤ ${o.r1} respond. Otherwise enrolment continues to ${o.n}, and the treatment is considered active if > ${o.r} respond (probability of early termination under H0 ${fmtPct(o.pet0)}; expected sample size ${o.en0}); maximum sample size:`,
      groups,
    )
    return { design, groups, ...txt, simon: res, method, method_en: methodEn, warnings }
  }

  throw new Error(`不支持的设计类型：${String(design)}`)
}
