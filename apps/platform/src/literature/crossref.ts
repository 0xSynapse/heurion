import { cleanBibText, normalizeDoi } from './format.ts'
import type { Article, FetchLike } from './types.ts'

interface CrossrefWork {
  DOI: string
  title?: string[]
  'container-title'?: string[]
  'short-container-title'?: string[]
  author?: { family?: string; given?: string; name?: string }[]
  issued?: { 'date-parts'?: number[][] }
  volume?: string
  issue?: string
  page?: string
}

export class CrossrefClient {
  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly email = '') {}

  /** 按 DOI 取元数据；DOI 不存在返回 null（这是引用校验的关键信号）。 */
  async lookup(doi: string): Promise<Article | null> {
    const id = normalizeDoi(doi)
    const url = `https://api.crossref.org/works/${encodeURIComponent(id)}${this.email ? `?mailto=${encodeURIComponent(this.email)}` : ''}`
    const res = await this.fetchImpl(url, { headers: { 'User-Agent': `heurion2${this.email ? ` (mailto:${this.email})` : ''}` } })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Crossref HTTP ${res.status}`)
    const body = await res.json() as { message: CrossrefWork }
    return toArticle(body.message)
  }
}

function toArticle(w: CrossrefWork): Article {
  const authors = (w.author ?? []).map(a => a.name ?? [a.family, initials(a.given)].filter(Boolean).join(' '))
  return {
    pmid: null,
    doi: normalizeDoi(w.DOI),
    title: cleanBibText(w.title?.[0] ?? ''),
    authors,
    journal: cleanBibText(w['short-container-title']?.[0] ?? w['container-title']?.[0] ?? ''),
    year: String(w.issued?.['date-parts']?.[0]?.[0] ?? ''),
    ...(w.volume ? { volume: w.volume } : {}),
    ...(w.issue ? { issue: w.issue } : {}),
    ...(w.page ? { pages: w.page } : {}),
  }
}

function initials(given?: string): string {
  return (given ?? '').split(/[\s-]+/).filter(Boolean).map(p => p[0]!.toUpperCase()).join('')
}
