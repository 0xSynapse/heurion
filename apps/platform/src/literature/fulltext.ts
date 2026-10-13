import type { Store } from '../store/db.ts'
import { pdfPages } from '../kb/extract.ts'
import type { FetchLike } from './types.ts'

/**
 * 开放获取全文（M3 oa_fulltext）：论断核对在摘要不够时用全文片段作证据，AI 写作时也可以读。
 * 来源：DOI → PMC id（NCBI ID 转换）→ PMC 开放数据（只收开放获取，纯文本）；不在 PMC 的用 Unpaywall 找开放 PDF，pdftotext 抽文字。
 * 结果缓存在 citation_fulltexts（没有全文也缓存，30 天后重查）。
 */
export interface FullText { source: 'pmc' | 'unpaywall'; url: string; license: string | null; text: string }

const PMC_OPENDATA = 'https://pmc-oa-opendata.s3.amazonaws.com'
const MAX_TEXT = 400_000
const RETRY_AFTER_MS = 30 * 24 * 3600_000

export class FullTextClient {
  constructor(private readonly store: Store, private readonly fetchImpl: FetchLike = fetch, private readonly email = '') {}

  async get(doi: string): Promise<FullText | null> {
    const cached = this.store.getFullText(doi)
    if (cached && (cached.text || Date.now() - Date.parse(cached.fetched_at) < RETRY_AFTER_MS)) {
      return cached.text ? { source: cached.source as FullText['source'], url: cached.url ?? '', license: cached.license, text: cached.text } : null
    }
    let found: FullText | null = null
    try {
      found = await this.fromPmc(doi) ?? await this.fromUnpaywall(doi)
    } catch {
      return null // 网络问题不缓存，下次再试
    }
    this.store.putFullText(doi, found ? { source: found.source, url: found.url, license: found.license, text: found.text.slice(0, MAX_TEXT) } : { source: null, url: null, license: null, text: null })
    return found
  }

  private async json<T>(url: string): Promise<T | null> {
    const res = await this.fetchImpl(url, { headers: { 'User-Agent': `heurion2${this.email ? ` (mailto:${this.email})` : ''}` }, signal: AbortSignal.timeout(20_000) })
    if (res.status === 404 || res.status === 403) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json() as T
  }

  private async fromPmc(doi: string): Promise<FullText | null> {
    const conv = await this.json<{ records?: Array<{ pmcid?: string }> }>(`https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${encodeURIComponent(doi)}&format=json&tool=heurion2${this.email ? `&email=${encodeURIComponent(this.email)}` : ''}`)
    const pmcid = conv?.records?.[0]?.pmcid
    if (!pmcid) return null
    // 开放数据按版本存放：取最新的一版
    type Meta = { is_pmc_openaccess?: boolean; license_code?: string; text_url?: string; xml_url?: string }
    let meta: Meta | null = null
    for (let v = 1; v <= 5; v++) {
      const m: Meta | null = await this.json<Meta>(`${PMC_OPENDATA}/metadata/${pmcid}.${v}.json`)
      if (!m) break
      meta = m
    }
    if (!meta?.is_pmc_openaccess) return null

    // 优先尝试从 xml_url 提取结构化全文（段落、表格 table-wrap 与图注 fig），表格能解决 RCT 数字证据缺失的核心瓶颈
    if (meta.xml_url) {
      try {
        const xmlUrl = `${PMC_OPENDATA}/${meta.xml_url.replace(/^s3:\/\/pmc-oa-opendata\//, '').split('?')[0]}`
        const res = await this.fetchImpl(xmlUrl, { signal: AbortSignal.timeout(35_000) })
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
        if (res.ok) {
          const xmlRaw = await res.text()
          const parsed = extractFromPmcXml(xmlRaw)
          if (parsed && parsed.length > 200) {
            return { source: 'pmc', url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`, license: meta.license_code ?? null, text: parsed }
          }
        }
      } catch (err) {
        if (err instanceof Error && /^HTTP (429|5\d\d)$/.test(err.message)) throw err
        // XML 解析失败时平滑降级到下方 text_url
      }
    }

    if (!meta.text_url) return null
    const url = `${PMC_OPENDATA}/${meta.text_url.replace(/^s3:\/\/pmc-oa-opendata\//, '').split('?')[0]}`
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000) })
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
    if (!res.ok) return null
    return { source: 'pmc', url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`, license: meta.license_code ?? null, text: await res.text() }
  }

  private async fromUnpaywall(doi: string): Promise<FullText | null> {
    if (!this.email) return null // Unpaywall 要求带邮箱
    const u = await this.json<{ best_oa_location?: { url_for_pdf?: string | null; license?: string | null } | null }>(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(this.email)}`)
    const pdf = u?.best_oa_location?.url_for_pdf
    if (!pdf) return null
    const res = await this.fetchImpl(pdf, { signal: AbortSignal.timeout(45_000) })
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('pdf')) return null
    const contentLen = Number(res.headers.get('content-length') ?? 0)
    if (contentLen > 40 * 1024 * 1024) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > 40 * 1024 * 1024) return null
    const text = (await pdfPages(bytes)).join('\n\n')
    return text.trim().length > 500 ? { source: 'unpaywall', url: pdf, license: u?.best_oa_location?.license ?? null, text } : null
  }
}

/** 从 PMC 开放 XML 提取正文、表格（带表头切片）与图注，解决临床试验数值大多藏在表格中的证据缺失瓶颈。 */
export function extractFromPmcXml(xmlRaw: string): string {
  const parts: string[] = []

  // 1. 标题与摘要
  const titleM = /<article-title\b[^>]*>([\s\S]*?)<\/article-title>/i.exec(xmlRaw)
  if (titleM) {
    const title = titleM[1]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (title) parts.push(title)
  }
  const absM = /<abstract\b[^>]*>([\s\S]*?)<\/abstract>/i.exec(xmlRaw)
  if (absM) {
    const absText = absM[1]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (absText) parts.push(`Abstract: ${absText}`)
  }

  // 2. 正文段落（排除表格与图注，避免重复）
  const bodyM = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(xmlRaw)
  const body = bodyM ? bodyM[1]! : xmlRaw
  const cleanBody = body.replace(/<table-wrap[\s\S]*?<\/table-wrap>/gi, '').replace(/<fig[\s\S]*?<\/fig>/gi, '')
  const pRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi
  let pM: RegExpExecArray | null
  while ((pM = pRegex.exec(cleanBody)) !== null) {
    const pt = pM[1]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (pt.length >= 40) parts.push(pt)
  }

  // 3. 表格抽取（保留表名、Caption、表头，并对多行数据分块）
  const twRegex = /<table-wrap\b[^>]*>([\s\S]*?)<\/table-wrap>/gi
  let twM: RegExpExecArray | null
  while ((twM = twRegex.exec(xmlRaw)) !== null) {
    const tw = twM[1]!
    const label = (/<label>([\s\S]*?)<\/label>/i.exec(tw)?.[1] || 'Table').replace(/<[^>]+>/g, '').trim()
    const caption = (/<caption>([\s\S]*?)<\/caption>/i.exec(tw)?.[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    const rows: string[] = []
    const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    let trM: RegExpExecArray | null
    while ((trM = trRegex.exec(tw)) !== null) {
      const cells: string[] = []
      const cellRegex = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi
      let cellM: RegExpExecArray | null
      while ((cellM = cellRegex.exec(trM[1]!)) !== null) {
        cells.push(cellM[1]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      }
      if (cells.length > 0) rows.push(cells.join(' | '))
    }
    if (rows.length > 0) {
      const headerRows = Math.min(2, rows.length)
      const header = rows.slice(0, headerRows).join('\n')
      const dataRows = rows.slice(headerRows)
      if (dataRows.length <= 6) {
        parts.push(`[${label}: ${caption}]\n${rows.join('\n')}`)
      } else {
        for (let i = 0; i < dataRows.length; i += 5) {
          const partNum = Math.floor(i / 5) + 1
          const batch = dataRows.slice(i, i + 5)
          parts.push(`[${label} (Part ${partNum}): ${caption}]\n${header}\n${batch.join('\n')}`)
        }
      }
    }
  }

  // 4. 图注抽取
  const figRegex = /<fig\b[^>]*>([\s\S]*?)<\/fig>/gi
  let figM: RegExpExecArray | null
  while ((figM = figRegex.exec(xmlRaw)) !== null) {
    const fig = figM[1]!
    const label = (/<label>([\s\S]*?)<\/label>/i.exec(fig)?.[1] || 'Figure').replace(/<[^>]+>/g, '').trim()
    const caption = (/<caption>([\s\S]*?)<\/caption>/i.exec(fig)?.[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (caption) parts.push(`[${label}: ${caption}]`)
  }

  return parts.join('\n\n')
}

const STOP = new Set('about above after again also among and are been before being both but can could did does during each even from further had has have having here into its itself just like many more most much must not only other over same should since some such than that their them then there these they this those through thus under until very was were what when where which while who whom will with within without would study studies patients participants trial trials data showed shown found reported results compared group groups treatment'.split(' '))
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter(w => !STOP.has(w)).map(w => w.slice(0, 6)))
const numbers = (s: string) => new Set((s.replace(/(\d)·(\d)/g, '$1.$2').match(/\d+(?:\.\d+)?/g) ?? []).filter(n => !/^(19|20)\d\d$/.test(n)))

/**
 * 全文里与论断最相关的几段（数字命中权重大，其次是实词）；跳过参考文献表之后的内容。
 * 中文论断常引英文文献：按数字与英文词匹配，中文句子里的数字同样有效。
 */
export function relevantPassages(text: string, sentence: string, maxChars = 1800, maxPassages = 3): string[] {
  const body = text.split(/\n\s*(?:REFERENCES|References|Bibliography)\s*\n/)[0] ?? text
  const paras = body
    .split(/\n\s*\n|\n(?=[A-Z][^|\n]{0,80}\n)/)
    .map(p => {
      if (p.includes(' | ') && p.includes('\n')) {
        return p.split('\n').map(l => l.trim()).filter(Boolean).join('\n')
      }
      return p.replace(/\s+/g, ' ').trim()
    })
    .filter(p => p.length >= 50)
  const sw = words(sentence)
  const sn = numbers(sentence)
  if (sw.size === 0 && sn.size === 0) return []
  const scored = paras.map((p, i) => {
    const pw = words(p)
    const pn = numbers(p)
    let score = 0
    for (const n of sn) if (pn.has(n)) score += 3
    for (const w of sw) if (pw.has(w)) score += 1
    return { i, p, score }
  }).filter(x => x.score >= 3).sort((a, b) => b.score - a.score)
  const out: string[] = []
  let used = 0
  for (const x of scored) {
    if (out.length >= maxPassages) break
    const piece = x.p.length > 900 ? `${x.p.slice(0, 900)}…` : x.p
    if (used + piece.length > maxChars) continue
    out.push(piece)
    used += piece.length
  }
  return out
}
