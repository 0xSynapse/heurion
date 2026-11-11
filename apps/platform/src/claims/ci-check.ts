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
  String.raw`(?<![\d.])(${NUM})\s*%?\s*([(\[])\s*((?:95\s*%\s*)?(?:C[Il]|confidence\s+interval)\s*[:,=]?\s*)?(${NUM})\s*%?\s*(?:,|;|to|–|—|-(?=\s*[−-]?\d)|−(?=\s*\d))\s*(${NUM})\s*%?\s*[)\]]`,
  'gi',
)
/** 「估计值, 95% CI 下界–上界」「估计值; 95% CI: [下界, 上界]」：写明 CI/Cl 的逗号/分号分隔写法 */
const PAIR_COMMA = new RegExp(
  String.raw`(?<![\d.])(${NUM})\s*%?\s*[,;]\s*(?:95\s*%\s*)?(?:C[Il]|confidence\s+interval)\s*[:,=]?\s*[(\[]?\s*(${NUM})\s*%?\s*(?:,|to|–|—|-(?=\s*[−-]?\d)|−(?=\s*\d))\s*(${NUM})\s*%?\s*[)\]]?(?![\d.])`,
  'gi',
)
const STAT_BEFORE = /(?:\b(?:a?HR|a?OR|a?RR|RGM|IRR|PR|RD|MD|WMD|SMD|AUC|ratio|difference|β|beta|coefficient|estimate|median|IQR|sensitivity|specificity|mean difference)\b|风险比|比值比|中位数|差值)[^.;。；]{0,40}$/i

/** 估计值前面紧挨着「p =」「n =」、分数分母斜杠「58/83; 95% CI」或单位上标「^」（如 kg/m^2; 95% CI、n=48; 95% CI）：这个数不是点估计 */
const P_BEFORE = /(?:\bp(?:\s*-?\s*value)?\s*[=<>≤≥:]|\bn\s*=|\^|\d\s*\/)\s*$/i

const num = (s: string) => Number(s.replace('−', '-'))
const decimals = (s: string) => (s.split('.')[1] ?? '').length

/** 在一段文字里找不自洽的「估计值（区间）」。intervalContext：调用方已确认这段文字是估计值加区间（如表格的 CI 列） */
export function findCiProblems(text: string, intervalContext = false): CiProblem[] {
  const out: CiProblem[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(PAIR)) {
    const [whole, estS, bracket, ciWord, lowS, highS] = m as unknown as [string, string, string, string | undefined, string, string]
    const before = text.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0)
    const explicit = !!ciWord
    if (P_BEFORE.test(before)) continue
    if (bracket === '[' && !explicit) continue
    if (!explicit && !intervalContext && !STAT_BEFORE.test(before)) continue
    // 正文无显式 CI/IQR 标注的纯正整数逗号对（如文献引用「1 (2, 3)」）不当作置信区间
    if (
      !explicit &&
      !intervalContext &&
      !whole.includes('%') &&
      /,\s*\d+\s*[)\]]$/.test(whole) &&
      [estS, lowS, highS].every(s => /^\d+$/.test(s))
    ) {
      continue
    }
    const est = num(estS), low = num(lowS), high = num(highS)
    if ([est, low, high].some(Number.isNaN)) continue
    // 四舍五入的容差：按三者中最粗的精度取半个单位（当上下界同精度且高于点估计时用 0.49 避免 0.35 舍入成 0.3 的假阴性）
    const dEst = decimals(estS), dLow = decimals(lowS), dHigh = decimals(highS)
    const factor = dLow === dHigh && dEst < dLow ? 0.49 : 0.5
    const tol = factor * 10 ** -Math.min(dEst, dLow, dHigh)
    const key = `${est}|${low}|${high}`
    if (low > high + tol && !seen.has(key)) {
      seen.add(key)
      out.push({ text: whole.trim(), estimate: est, low, high, kind: 'inverted' })
    } else if ((est < low - tol || est > high + tol) && !seen.has(key)) {
      seen.add(key)
      out.push({ text: whole.trim(), estimate: est, low, high, kind: 'outside' })
    }
  }
  for (const m of text.matchAll(PAIR_COMMA)) {
    const [whole, estS, lowS, highS] = m as unknown as [string, string, string, string]
    if (P_BEFORE.test(text.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0))) continue
    const est = num(estS), low = num(lowS), high = num(highS)
    if ([est, low, high].some(Number.isNaN)) continue
    const dEst = decimals(estS), dLow = decimals(lowS), dHigh = decimals(highS)
    const factor = dLow === dHigh && dEst < dLow ? 0.49 : 0.5
    const tol = factor * 10 ** -Math.min(dEst, dLow, dHigh)
    const key = `${est}|${low}|${high}`
    if (low > high + tol && !seen.has(key)) {
      seen.add(key)
      out.push({ text: whole.trim(), estimate: est, low, high, kind: 'inverted' })
    } else if ((est < low - tol || est > high + tol) && !seen.has(key)) {
      seen.add(key)
      out.push({ text: whole.trim(), estimate: est, low, high, kind: 'outside' })
    }
  }
  return out
}
