/**
 * 来源规则二的数字部分（docs/design/PROVENANCE.md 2.2）：从文字里取数字，判断 AI 写下的数字有没有出处。
 *
 * 要核对的数字：带小数点或百分号的数，以及 ≥ 11 的整数；0–10 的小整数（「两组」「3 年」「表 2」）与
 * 1900–2100 的四位整数（年份）不核对。名称里的数字（COVID-19、IL-6、CD8、T2DM、BRCA1）不算数字。
 * 匹配允许四舍五入与百分数换算：看到 0.36666，写 36.7% 或 0.37 都算有出处。
 */

export interface WrittenNumber {
  raw: string
  value: number
  /** 小数位数 */
  decimals: number
  percent: boolean
}

// 前面不能紧挨字母或数字（CD8、IL-6 的 6 前是「-」且「-」前是字母），后面不能紧挨字母（3D、2nd）
const NUM = /(?<![A-Za-z0-9.])(?<![A-Za-z]-)(?<![A-Za-z]‐)[-−–]?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?(?![A-Za-z])|(?<![A-Za-z0-9.])(?<![A-Za-z]-)(?<![A-Za-z]‐)[-−–]?\d+(?:\.\d+)?%?(?![A-Za-z0-9])/g

function parse(raw: string): WrittenNumber | null {
  const percent = raw.endsWith('%')
  const body = raw.replace(/%$/, '').replace(/,/g, '').replace(/^[−–]/, '-')
  const value = Number(body)
  if (!Number.isFinite(value)) return null
  const dot = body.indexOf('.')
  return { raw, value, decimals: dot >= 0 ? body.length - dot - 1 : 0, percent }
}

/** 文字里的全部数字（含不需核对的小整数；用作「看到过的数字」）。 */
export function allNumbers(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(NUM)) {
    // 区间「0.40–1.69」里的「–」是连接号，不是负号
    const raw = m.index! > 0 && /\d/.test(text[m.index! - 1] ?? '') ? m[0].replace(/^[-−–]/, '') : m[0]
    const n = parse(raw)
    if (n) out.push(n.value)
  }
  return out
}

/** 需要核对出处的数字。 */
export function checkableNumbers(text: string): WrittenNumber[] {
  const out: WrittenNumber[] = []
  for (const m of text.matchAll(NUM)) {
    const raw = m.index! > 0 && /\d/.test(text[m.index! - 1] ?? '') ? m[0].replace(/^[-−–]/, '') : m[0]
    const n = parse(raw)
    if (!n) continue
    const abs = Math.abs(n.value)
    const isInt = n.decimals === 0 && !n.percent
    if (isInt && abs <= 10) continue
    if (isInt && abs >= 1900 && abs <= 2100 && /^\d{4}$/.test(raw)) continue
    out.push(n)
  }
  return out
}

const round = (x: number, d: number) => { const f = 10 ** d; return Math.round(x * f) / f }

/** 写下的数字能不能由看到过的某个数字（原值、四舍五入、百分数换算）得到。 */
export function numberObserved(n: WrittenNumber, seen: Iterable<number>): boolean {
  const target = round(n.value, n.decimals)
  const eps = 0.5 * 10 ** -(n.decimals + 6)
  for (const y of seen) {
    for (const c of [y, y * 100, y / 100]) {
      if (Math.abs(round(c, n.decimals) - target) <= eps) return true
      // 写成负数的差值，看到的是绝对值（或反过来）
      if (Math.abs(round(Math.abs(c), n.decimals) - Math.abs(target)) <= eps && Math.sign(target) !== Math.sign(c)) return true
    }
  }
  return false
}
