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
