import type { Article, FetchLike } from './types.ts'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

const NAMED: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }

/**
 * XML 文本解码：五个预定义实体 + 数字字符引用（PubMed 摘要里大量出现 &#x2009; 窄空格、&#xb7; 小数点、&#x2265; ≥、&#xb1; ± 等，
 * 不解码的话论断核对的模型看到的是「0&#xb7;74」）。一次替换，避免 &amp;#… 被二次解码。
 */
export function decodeXmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);/g, (whole, ent: string) => {
    if (ent[0] !== '#') return NAMED[ent]!
    const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

interface SummaryDoc {
  uid: string
  title?: string
  fulljournalname?: string
  source?: string
  pubdate?: string
  volume?: string
  issue?: string
  pages?: string
  authors?: { name: string }[]
  articleids?: { idtype: string; value: string }[]
}

export class PubMedClient {
  /** NCBI 无 API key 时限 3 次/秒：429 按退避重试。 */
  private async get(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
      if (res.status !== 429 || attempt >= 3) return res
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
    }
  }

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly apiKey = '',
    private readonly email = '',
  ) {}

  private url(path: string, params: Record<string, string>): string {
    const q = new URLSearchParams({ ...params, retmode: 'json', tool: 'heurion' })
    if (this.apiKey) q.set('api_key', this.apiKey)
    if (this.email) q.set('email', this.email)
    return `${EUTILS}/${path}?${q}`
  }

  async search(query: string, limit = 10): Promise<Article[]> {
    const res = await this.get(this.url('esearch.fcgi', { db: 'pubmed', term: query, retmax: String(limit), sort: 'relevance' }))
    if (!res.ok) throw new Error(`PubMed esearch HTTP ${res.status}`)
    const body = await res.json() as { esearchresult?: { idlist?: string[] } }
    const ids = body.esearchresult?.idlist ?? []
    return ids.length === 0 ? [] : this.summaries(ids)
  }

  /** DOI → PMID（PubMed 收录时）。 */
  async pmidForDoi(doi: string): Promise<string | null> {
    const res = await this.get(this.url('esearch.fcgi', { db: 'pubmed', term: `${doi}[DOI]`, retmax: '1' }))
    if (!res.ok) throw new Error(`PubMed esearch HTTP ${res.status}`)
    const body = await res.json() as { esearchresult?: { idlist?: string[] } }
    return body.esearchresult?.idlist?.[0] ?? null
  }

  /** 摘要全文（结构化摘要按「标签：内容」拼接）；没有摘要返回 null。 */
  async abstract(pmid: string): Promise<string | null> {
    const q = new URLSearchParams({ db: 'pubmed', id: pmid, rettype: 'abstract', retmode: 'xml', tool: 'heurion' })
    if (this.apiKey) q.set('api_key', this.apiKey)
    if (this.email) q.set('email', this.email)
    const res = await this.get(`${EUTILS}/efetch.fcgi?${q}`)
    if (!res.ok) throw new Error(`PubMed efetch HTTP ${res.status}`)
    const xml = await res.text()
    const parts = [...xml.matchAll(/<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(m => {
      const label = /Label="([^"]+)"/.exec(m[1]!)?.[1]
      const text = decodeXmlText(m[2]!.replace(/<[^>]+>/g, '')).trim()
      return label ? `${label}: ${text}` : text
    })
    return parts.length > 0 ? parts.join('\n') : null
  }

  async summaries(pmids: string[]): Promise<Article[]> {
    const res = await this.get(this.url('esummary.fcgi', { db: 'pubmed', id: pmids.join(',') }))
    if (!res.ok) throw new Error(`PubMed esummary HTTP ${res.status}`)
    const body = await res.json() as { result?: Record<string, SummaryDoc | string[]> }
    const result = body.result ?? {}
    return pmids.flatMap(id => {
      const doc = result[id]
      return doc && !Array.isArray(doc) ? [toArticle(doc)] : []
    })
  }
}

function toArticle(d: SummaryDoc): Article {
  const doi = d.articleids?.find(x => x.idtype === 'doi')?.value ?? null
  return {
    pmid: d.uid,
    doi: doi ? doi.toLowerCase() : null,
    title: decodeXmlText(d.title ?? ''),
    authors: (d.authors ?? []).map(a => a.name),
    journal: d.source ?? d.fulljournalname ?? '',
    year: (d.pubdate ?? '').slice(0, 4),
    ...(d.volume ? { volume: d.volume } : {}),
    ...(d.issue ? { issue: d.issue } : {}),
    ...(d.pages ? { pages: d.pages } : {}),
  }
}
