/**
 * 点估计与置信区间（或中位数与 IQR）是否自洽：估计值落在区间外、区间上下界倒挂。纯数字判断，不需要模型。
 *
 * 只在上下文明确是「估计值（区间）」时判断，避免把别的括号数字当成区间：
 * - 括号里写了 CI / confidence；或
 * - 估计值前面不远处有效应量或统计量的名字（HR、OR、RR、差值、中位数、IQR、AUC 等）；或
 * - 调用方说明上下文就是区间（表格的表头 / 行名写了 CI、IQR、95%）。
 * 方括号里的区间（可能是引用编号「[4–6]」）只在写明 CI 时才算。
 */

export interface CiProblem {
  /** 原文里的「估计值 (下界–上界)」 */
  text: string
  estimate: number
  low: number
  high: number
  kind: 'outside' | 'inverted'
}

const NUM = String.raw`[−-]?\d+(?:\.\d+)?`
const PAIR = new RegExp(
  String.raw`(?<![\d.])(${NUM})\s*%?\s*([(\[])\s*((?:95\s*%\s*)?(?:CI|confidence\s+interval)\s*[:,=]?\s*)?(${NUM})\s*%?\s*(?:,|;|to|–|—|-(?=\s*[−-]?\d)|−(?=\s*\d))\s*(${NUM})\s*%?\s*[)\]]`,
  'gi',
)
/** 「估计值, 95% CI 下界–上界」「估计值; 95% CI: 下界 to 上界」：不带括号、写明 CI 的写法 */
const PAIR_COMMA = new RegExp(
  String.raw`(?<![\d.])(${NUM})\s*%?\s*[,;]\s*(?:95\s*%\s*)?(?:CI|confidence\s+interval)\s*[:,=]?\s*(${NUM})\s*%?\s*(?:to|–|—|-(?=\s*[−-]?\d)|−(?=\s*\d))\s*(${NUM})(?![\d.])`,
  'gi',
)
const STAT_BEFORE = /(?:\b(?:a?HR|a?OR|a?RR|IRR|PR|RD|MD|WMD|SMD|AUC|ratio|difference|β|beta|coefficient|estimate|median|IQR|sensitivity|specificity|mean difference)\b|风险比|比值比|中位数|差值)[^.;。；]{0,40}$/i

/** 估计值前面紧挨着「p =」「p <」「P-value:」：这个数是 P 值，后面的 CI 属于前面的效应量（「OR 1.49, p = 0.24, CI 0.77–2.88」） */
const P_BEFORE = /\bp(?:\s*-?\s*value)?\s*[=<>≤≥:]\s*$/i

const num = (s: string) => Number(s.replace('−', '-'))
const decimals = (s: string) => (s.split('.')[1] ?? '').length

/** 在一段文字里找不自洽的「估计值（区间）」。intervalContext：调用方已确认这段文字是估计值加区间（如表格的 CI 列） */
export function findCiProblems(text: string, intervalContext = false): CiProblem[] {
  const out: CiProblem[] = []
  for (const m of text.matchAll(PAIR)) {
    const [whole, estS, bracket, ciWord, lowS, highS] = m as unknown as [string, string, string, string | undefined, string, string]
    const before = text.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0)
    const explicit = !!ciWord
    if (P_BEFORE.test(before)) continue
    if (bracket === '[' && !explicit) continue
    if (!explicit && !intervalContext && !STAT_BEFORE.test(before)) continue
    const est = num(estS), low = num(lowS), high = num(highS)
    if ([est, low, high].some(Number.isNaN)) continue
    // 四舍五入的容差：按三者中最粗的精度取半个单位（估计值两位小数、区间三位小数时按两位算），宁可不报
    const tol = 0.5 * 10 ** -Math.min(decimals(estS), decimals(lowS), decimals(highS))
    if (low > high + tol) out.push({ text: whole.trim(), estimate: est, low, high, kind: 'inverted' })
    else if (est < low - tol || est > high + tol) out.push({ text: whole.trim(), estimate: est, low, high, kind: 'outside' })
  }
  for (const m of text.matchAll(PAIR_COMMA)) {
    const [whole, estS, lowS, highS] = m as unknown as [string, string, string, string]
    if (P_BEFORE.test(text.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0))) continue
    const est = num(estS), low = num(lowS), high = num(highS)
    if ([est, low, high].some(Number.isNaN)) continue
    const tol = 0.5 * 10 ** -Math.min(decimals(estS), decimals(lowS), decimals(highS))
    if (low > high + tol) out.push({ text: whole.trim(), estimate: est, low, high, kind: 'inverted' })
    else if (est < low - tol || est > high + tol) out.push({ text: whole.trim(), estimate: est, low, high, kind: 'outside' })
  }
  return out
}
