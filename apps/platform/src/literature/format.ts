import type { Article } from './types.ts'

/** 规范化 DOI：去前缀、转小写，便于去重与比对。 */
export function normalizeDoi(raw: string): string {
  return raw.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase()
}

export type CitationStyle = 'ama' | 'vancouver' | 'apa' | 'gbt7714'

/** AMA 格式：作者超过 6 位时列前 3 位 + et al。 */
export function formatAma(a: Article): string {
  const authors = a.authors.length > 6 ? `${a.authors.slice(0, 3).join(', ')}, et al` : a.authors.join(', ')
  const title = a.title.replace(/\.$/, '')
  let source = `${a.journal}. ${a.year}`
  if (a.volume) source += `;${a.volume}`
  if (a.issue) source += `(${a.issue})`
  if (a.pages) source += `:${a.pages}`
  const parts = [authors ? `${authors}.` : '', `${title}.`, `${source}.`]
  if (a.doi) parts.push(`doi:${a.doi}`)
  return parts.filter(Boolean).join(' ')
}

/** 温哥华格式（Vancouver / NLM）：作者超过 6 位时列前 6 位 + et al。 */
export function formatVancouver(a: Article): string {
  const authors = a.authors.length > 6 ? `${a.authors.slice(0, 6).join(', ')}, et al` : a.authors.join(', ')
  const title = a.title.replace(/\.$/, '')
  let source = `${a.journal}. ${a.year}`
  if (a.volume) source += `;${a.volume}`
  if (a.issue) source += `(${a.issue})`
  if (a.pages) source += `:${a.pages}`
  const parts = [authors ? `${authors}.` : '', `${title}.`, `${source}.`]
  if (a.doi) parts.push(`doi:${a.doi}`)
  return parts.filter(Boolean).join(' ')
}

/** APA 格式（第 7 版）：(年份). 标题. 期刊, 卷(期), 页码. https://doi.org/... */
export function formatApa(a: Article): string {
  let authors = ''
  if (a.authors.length === 1) {
    authors = a.authors[0]!
  } else if (a.authors.length === 2) {
    authors = `${a.authors[0]} & ${a.authors[1]}`
  } else if (a.authors.length > 20) {
    authors = `${a.authors.slice(0, 19).join(', ')}, ... ${a.authors[a.authors.length - 1]}`
  } else if (a.authors.length > 2) {
    authors = `${a.authors.slice(0, -1).join(', ')}, & ${a.authors[a.authors.length - 1]}`
  }
  const year = a.year ? `(${a.year})` : ''
  const title = a.title.replace(/\.$/, '')
  let journalPart = a.journal
  if (a.volume) journalPart += `, ${a.volume}`
  if (a.issue) journalPart += `(${a.issue})`
  if (a.pages) journalPart += `, ${a.pages}`
  const parts = [authors ? `${authors}.` : '', year ? `${year}.` : '', `${title}.`, journalPart ? `${journalPart}.` : '']
  if (a.doi) parts.push(`https://doi.org/${a.doi}`)
  return parts.filter(Boolean).join(' ')
}

/** GB/T 7714-2015 格式：作者前 3 位 + 等 / et al。题名[J]. 刊名, 年, 卷(期): 页码. */
export function formatGbt7714(a: Article): string {
  const isChinese = /[\u4e00-\u9fa5]/.test(a.title + a.authors.join(''))
  const etAl = isChinese ? '等' : 'et al.'
  const authors = a.authors.length > 3 ? `${a.authors.slice(0, 3).join(', ')}, ${etAl}` : a.authors.join(', ')
  const title = a.title.replace(/\.$/, '')
  let source = a.journal
  if (a.year) source += `, ${a.year}`
  if (a.volume) source += `, ${a.volume}`
  if (a.issue) source += `(${a.issue})`
  if (a.pages) source += `: ${a.pages}`
  const authorPart = authors ? (authors.endsWith('.') ? authors : `${authors}.`) : ''
  const parts = [authorPart, `${title}[J].`, source ? `${source}.` : '']
  if (a.doi) parts.push(`DOI: ${a.doi}.`)
  return parts.filter(Boolean).join(' ')
}

/** 清理文献元数据中的 HTML/JATS 标签、转义实体与多余换行空白。 */
export function cleanBibText(raw: string): string {
  return raw
    .replace(/<\/?(?:i|b|u|em|strong|sup|sub|scp|span|p)\b[^>]*>/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** 按指定格式生成引用文本（默认 AMA）。 */
export function formatCitation(raw: Article, style: CitationStyle = 'ama'): string {
  const a: Article = {
    ...raw,
    title: cleanBibText(raw.title),
    journal: cleanBibText(raw.journal),
    authors: raw.authors.map(cleanBibText).filter(Boolean),
  }
  switch (style) {
    case 'vancouver': return formatVancouver(a)
    case 'apa': return formatApa(a)
    case 'gbt7714': return formatGbt7714(a)
    case 'ama':
    default:
      return formatAma(a)
  }
}

