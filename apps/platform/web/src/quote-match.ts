/**
 * 原版视图的引用兜底定位（docs/design/PDF_ORIGINAL_VIEW.md §12.2 第 3 步）：
 * 评论按块对不上文字时（块在转换稿里改过、锚在整张表上），在块的区域里的词中找锚定文字，找到就只高亮这些词。
 */

/** 原版映射里的词：[页, 左, 上, 右, 下, 文字] */
export type Word = [number, number, number, number, number, string]

/** 比较用的规范化：去空白、统一短横与引号、小写（词之间的空格在 PDF 里本来就没有） */
function norm(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 引用兜底定位的完整顺序（审稿意见按块对不上文字时）：
 * 1. 块的区域里找原文；2. 模型按 Markdown 表格行引用（「G1 and 2 | 26 (86.7%) | …」）时去掉竖线再找；
 * 3. 块的区域里找不到（图注在图片区域外、块不在映射里）时到全文里找，文字够长（≥ 8 字）且全文唯一才算。
 */
export function locateQuote(words: Word[], regions: number[][], pages: Array<{ w: number; h: number }>, quotes: Array<string | undefined>): number[] | null {
  const qs = quotes.map(q => (q ?? '').trim()).filter(q => q && q.length < 400)
  const variants = qs.flatMap(q => (q.includes('|') ? [q, q.replace(/\s*\|\s*/g, ' ')] : [q]))
  const all = pages.map((p, i) => [i + 1, 0, 0, p.w, p.h])
  for (const q of variants) {
    const hit = findQuoteWords(words, regions, q)
    if (hit) return hit
  }
  for (const q of variants) {
    if (q.length < 8) continue
    const hit = findQuoteWords(words, all, q)
    if (hit) return hit
  }
  return null
}

/**
 * 在给定区域（[页, 左, 上, 右, 下]，词框中心落在区域内的词）里按阅读顺序找 quote，返回覆盖它的词序号。
 * 找不到、quote 太短（少于 2 个字）或出现不止一次时返回 null（由调用方退回画整块）。
 */
export function findQuoteWords(words: Word[], regions: number[][], quote: string): number[] | null {
  const q = norm(quote)
  if (q.length < 2 || !regions.length) return null
  const inside = (w: Word) => regions.some(([p, l, t, r, b]) => {
    const cx = (w[1] + w[3]) / 2, cy = (w[2] + w[4]) / 2
    return w[0] === p && cx >= l! - 1 && cx <= r! + 1 && cy >= t! - 1 && cy <= b! + 1
  })
  let text = ''
  const owner: number[] = []  // text 里每个字属于哪个词
  words.forEach((w, i) => {
    if (!inside(w)) return
    const t = norm(w[5])
    text += t
    for (let k = 0; k < t.length; k++) owner.push(i)
  })
  const at = text.indexOf(q)
  if (at < 0 || text.indexOf(q, at + 1) >= 0) return null
  return [...new Set(owner.slice(at, at + q.length))]
}
