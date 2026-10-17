import { cleanBibText, normalizeDoi } from './format.ts'
import type { Article, FetchLike } from './types.ts'

interface OpenAlexAuthor {
  display_name: string
}

interface OpenAlexWork {
  id: string
  doi?: string | null
  title?: string | null
  display_name?: string | null
  publication_year?: number | null
  authorships?: Array<{ author: OpenAlexAuthor }>
  primary_location?: {
    source?: {
      display_name?: string | null
    } | null
  } | null
  biblio?: {
    volume?: string | null
    issue?: string | null
    first_page?: string | null
    last_page?: string | null
  } | null
  ids?: {
    pmid?: string | null
    doi?: string | null
  } | null
}

export class OpenAlexClient {
  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly email = '') {}

  /** 检索 OpenAlex 开放学术文献图谱。返回标准化的 Article 数组。 */
  async search(query: string, limit = 10): Promise<Article[]> {
    const q = query.trim()
    if (!q) return []
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${Math.min(Math.max(1, limit), 50)}`
    const res = await this.fetchImpl(url, {
      headers: {
        'User-Agent': `heurion2${this.email ? ` (mailto:${this.email})` : ' (mailto:contact@heurion.org)'}`,
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`)
    const json = (await res.json()) as { results?: OpenAlexWork[] }
    return (json.results ?? []).map((w): Article => {
      const rawDoi = w.doi || w.ids?.doi || null
      const doi = rawDoi ? normalizeDoi(rawDoi) : null
      const rawPmid = w.ids?.pmid || null
      const pmid = rawPmid ? rawPmid.replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//, '') : null
      const firstPage = w.biblio?.first_page
      const lastPage = w.biblio?.last_page
      const pages = firstPage ? (lastPage && lastPage !== firstPage ? `${firstPage}-${lastPage}` : firstPage) : undefined

      return {
        pmid,
        doi,
        title: cleanBibText(w.title ?? w.display_name ?? 'Untitled'),
        authors: (w.authorships ?? []).map(a => a.author?.display_name).filter((name): name is string => Boolean(name)).map(cleanBibText),
        journal: cleanBibText(w.primary_location?.source?.display_name ?? 'Unknown Journal'),
        year: w.publication_year ? String(w.publication_year) : '',
        volume: w.biblio?.volume ?? undefined,
        issue: w.biblio?.issue ?? undefined,
        pages,
      }
    })
  }

  /** 按 DOI 查询单篇文献详情 */
  async lookup(doi: string): Promise<Article | null> {
    const cleanDoi = normalizeDoi(doi)
    if (!cleanDoi) return null
    try {
      const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(cleanDoi)}`
      const res = await this.fetchImpl(url, {
        headers: {
          'User-Agent': `heurion2${this.email ? ` (mailto:${this.email})` : ' (mailto:contact@heurion.org)'}`,
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        if (res.status === 404) return null
        throw new Error(`OpenAlex HTTP ${res.status}`)
      }
      const w = (await res.json()) as OpenAlexWork
      const rawDoi = w.doi || w.ids?.doi || null
      const parsedDoi = rawDoi ? normalizeDoi(rawDoi) : cleanDoi
      const rawPmid = w.ids?.pmid || null
      const pmid = rawPmid ? rawPmid.replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//, '') : null
      const firstPage = w.biblio?.first_page
      const lastPage = w.biblio?.last_page
      const pages = firstPage ? (lastPage && lastPage !== firstPage ? `${firstPage}-${lastPage}` : firstPage) : undefined

      return {
        pmid,
        doi: parsedDoi,
        title: cleanBibText(w.title ?? w.display_name ?? 'Untitled'),
        authors: (w.authorships ?? []).map(a => a.author?.display_name).filter((name): name is string => Boolean(name)).map(cleanBibText),
        journal: cleanBibText(w.primary_location?.source?.display_name ?? 'Unknown Journal'),
        year: w.publication_year ? String(w.publication_year) : '',
        volume: w.biblio?.volume ?? undefined,
        issue: w.biblio?.issue ?? undefined,
        pages,
      }
    } catch {
      return null
    }
  }
}
