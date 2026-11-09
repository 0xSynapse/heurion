/**
 * 模型审稿意见的证据核实与去重（深度审稿 Stage 3 / 4）。
 *
 * 模型报的每条意见要逐字引用出问题的原句（sentence）与能证明它有问题的另一处原文（evidence：矛盾的另一处正文、表格单元格或数值）。
 * 引文必须真在稿件里：模型编造或复述走样的引文对不上，这条意见就不报——审稿的成败在误报，宁可漏报也不报没有原文依据的问题。
 */

/** 比对用的规范化：去引用 / 测量原子、Markdown 转义与表格竖线、空白；统一短横与引号；小写 */
export function normForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\[@[cm]:[^\]]+\]/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 引文是否在稿件里：规范化后是子串；长引文允许少量出入（模型常漏一两个字符），按 8 字片段算，九成以上的片段在稿件里即可。
 * corpus 传规范化过的全文（normForMatch）。
 */
export function quotedIn(quote: string, corpus: string): boolean {
  const q = normForMatch(quote)
  if (q.length < 4) return false
  if (corpus.includes(q)) return true
  if (q.length < 24) return false
  const n = 8
  let hit = 0
  let total = 0
  for (let i = 0; i + n <= q.length; i += 4) {
    total++
    if (corpus.includes(q.slice(i, i + n))) hit++
  }
  return total > 0 && hit / total >= 0.9
}

/**
 * 全文复核（深度审稿 Stage 3 之后）：章节审稿只看到本章节与摘要，常把写在别处的内容当成「没报告」「对不上」。
 * 审完把全部意见编号、连同全文交给模型逐条复核，判为不成立的不报。
 */
export const VERIFY_SYSTEM =
  '你是医学期刊的资深统计审稿人，负责复核另一位审稿人（他只看到了部分章节）提出的意见是否成立。只依据给出的论文全文判断。\n' +
  '对每条意见给出 verdict：\n' +
  '- holds：论文里确实存在该意见指出的客观错误或矛盾（两处数字不一致、算术不对、置信区间与点估计不自洽、方法与结果不符、结论与统计结果不符）；\n' +
  '- rejected：不成立——原文其实一致、所说「没报告」的内容在别处写了、审稿人看错或算错、只是合理的写法差异或主观建议；' +
  '用原始人数验算加权 / 校正 / 标化估计；四舍五入的小差异；把不同的结局、人群、时间点、模型或分析集当成同一件事；\n' +
  '- unclear：仅凭全文无法判断。\n' +
  '只输出 JSON 数组，每条意见一项、按编号：[{"id":1,"verdict":"holds|rejected|unclear","why":"一句中文理由，指出关键原文"}]'

/** 复核结果：编号 → 判定（解析不了的条目不出现，调用方按「保留」处理） */
export function parseVerdicts(raw: string): Map<number, 'holds' | 'rejected' | 'unclear'> {
  const out = new Map<number, 'holds' | 'rejected' | 'unclear'>()
  const m = /\[[\s\S]*\]/.exec(raw.replace(/```(?:json)?/g, ''))
  if (!m) return out
  try {
    for (const x of JSON.parse(m[0]) as Array<{ id?: unknown; verdict?: unknown }>) {
      const id = Number(x?.id)
      const v = String(x?.verdict ?? '')
      if (Number.isInteger(id) && (v === 'holds' || v === 'rejected' || v === 'unclear')) out.set(id, v)
    }
  } catch {
    /* 解析失败：全部保留 */
  }
  return out
}

/** 引文里的数（跨章节去重用：同一处数字矛盾被几个章节换着说法报出来，数字组合是一样的） */
export function numberKey(texts: string[]): string {
  const nums = texts.join(' ').match(/\d+(?:[.,]\d+)?/g) ?? []
  return [...new Set(nums.map(x => x.replace(',', '.')))].sort().join(',')
}
