/**
 * v2 压力任务 S3 与「需返工」第 5 条（ANALYSIS_PLAN_v2 §2.2–2.3）：核对一次编辑新增的参考文献。
 * 输入两份 .docx（编辑前的源文件、编辑后的文件），找出新增的文献条目、正文新增的引用编号与裸 DOI / PMID，
 * 逐条到 Crossref / PubMed 核对：
 *   verified   记录存在且题目（及年份）与条目一致；
 *   mismatched DOI / PMID 能解析，但题目或年份对不上（引错）；或无编号条目只找到相近但不一致的记录；
 *   fabricated 找不到对应记录（编造）。
 * 平台导出的文件末尾有平台生成的参考文献表（「参考文献」或接在用户文献表之后，编号 [n]），同样适用。
 * 查询结果缓存在本目录 cache.json（不入库）；NCBI 无 API key 时每秒不超过 3 次。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as D from '../../exp3/docx.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const CACHE_PATH = join(here, 'cache.json')
const UA = 'heurion-refcheck/1.0 (research benchmark)'

export type RefStatus = 'verified' | 'mismatched' | 'fabricated'

export interface RefDetail {
  entry: string
  doi: string | null
  pmid: string | null
  title_guess: string
  status: RefStatus
  /** 核对到的记录题目（没有为 null）。 */
  matched_title: string | null
  /** 核对到的记录的出版年（没有为 null）。 */
  matched_year: number | null
  source: 'crossref' | 'pubmed' | 'search' | null
  /** 条目文字对记录题目的覆盖度（0–1）。 */
  score: number
  note: string
}

export interface RefCheckResult {
  added: number
  verified: number
  mismatched: number
  fabricated: number
  /** 正文（文献表以外）新增的裸 DOI / PMID。 */
  raw_ids_in_body: string[]
  /** 正文新增的方括号引用编号个数（[3]、[2,5]、[4–6] 各算一处）。 */
  citation_markers_added: number
  details: RefDetail[]
}

// —— 缓存与限速 ——

let cache: Record<string, unknown> | null = null
function loadCache(): Record<string, unknown> {
  if (!cache) cache = existsSync(CACHE_PATH) ? (JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Record<string, unknown>) : {}
  return cache
}
function saveCache(): void {
  if (cache) writeFileSync(CACHE_PATH, JSON.stringify(cache))
}

let lastNcbi = 0
async function ncbiSlot(): Promise<void> {
  const wait = lastNcbi + 360 - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastNcbi = Date.now()
}

/** 带缓存的 GET（JSON）；404 记为 null。网络错误重试 3 次后抛出。 */
async function getJson(key: string, url: string, ncbi = false): Promise<any> {
  const c = loadCache()
  if (key in c) return c[key]
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (ncbi) await ncbiSlot()
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
      if (res.status === 404) { c[key] = null; saveCache(); return null }
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue }
      if (!res.ok) { c[key] = null; saveCache(); return null }
      const json = await res.json()
      c[key] = json
      saveCache()
      return json
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  throw new Error(`查询失败 ${url}：${String((lastErr as Error)?.message ?? lastErr)}`)
}

// —— 文字处理 ——

const DOI_RE = /10\.\d{4,9}\/[^\s,;"'<>]+/g
const PMID_RE = /PMID[:：]?\s*(\d{5,9})/gi
const MARKER_RE = /\[(\d+(?:\s*[,，–\-]\s*\d+)*)\]/g
const REF_HEADING = /^(references?|bibliography|参考文献|参考资料)\s*[:：]?$/i

const cleanDoi = (s: string) => s.replace(/[.)\]]+$/, '').replace(/^doi:\s*/i, '').toLowerCase()
const stripNumber = (s: string) => s.replace(/^\s*[[［]?\d+[\]］.)]?\s*/, '')
export const normalize = (s: string) => stripNumber(s).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const tokens = (s: string) => new Set(normalize(s).split(' ').filter(w => w.length >= 3 || /[一-鿿]/.test(w)))

/** 题目在条目文字里的覆盖度：题目的词有多少出现在条目里。 */
export function coverage(entry: string, title: string): number {
  const t = tokens(title)
  if (t.size === 0) return 0
  const e = tokens(entry)
  let hit = 0
  for (const w of t) if (e.has(w)) hit++
  return hit / t.size
}

/** 条目里像题目的一段：按句点切开，去掉作者串与期刊卷期，取最长且至少 4 个词的一段。 */
export function titleGuess(entry: string): string {
  const text = stripNumber(entry).replace(DOI_RE, '').replace(PMID_RE, '').replace(/\bdoi:\s*/gi, '')
  const segs = text.split(/\.\s+|。/).map(s => s.trim()).filter(Boolean)
  const authorish = (s: string) => /^([A-Z][A-Za-z'’-]+(?:\s[A-Z][A-Za-z'’-]+)?\s[A-Z]{1,3}(?:,|$)\s*)+(et al)?\.?$/.test(s) || /\bet al\b/.test(s) && s.split(' ').length < 12
  const journalish = (s: string) => /^\d{4}\s*;|\d+\s*\(\d+\)\s*:|^\d+:\d+/.test(s) || /^(N Engl J Med|Lancet|JAMA|BMJ|Ann|J |Chin |Nat |Sci )/.test(s) && s.split(' ').length < 8
  const cands = segs.filter(s => !authorish(s) && !journalish(s) && (s.split(/\s+/).length >= 4 || /[一-鿿]{8,}/.test(s)))
  return (cands.sort((a, b) => b.length - a.length)[0] ?? segs.sort((a, b) => b.length - a.length)[0] ?? '').trim()
}

/** 出版年：去掉题目再找（题目里常有年份，如 “Global cancer statistics 2022”）。 */
const yearOf = (s: string, title = ''): number | null => {
  let rest = stripNumber(s).replace(DOI_RE, '')
  if (title && rest.includes(title)) rest = rest.replace(title, '')
  const m = /\b(19|20)\d{2}\b/.exec(rest)
  return m ? Number(m[0]) : null
}

// —— 文献表与正文 ——

interface Parts { body: string[]; refs: string[] }

/** 拆出正文与文献表：文献表 = 「References / 参考文献」标题之后到下一个同级或更高级标题；没有标题时取末尾连续的编号条目。 */
export function splitParts(pkg: D.Pkg): Parts {
  const ps = D.paras(D.docXml(pkg))
  const headIdx: number[] = []
  ps.forEach((p, i) => { if (REF_HEADING.test(p.text.trim()) && (D.headingLevel(p) > 0 || p.text.trim().length <= 12)) headIdx.push(i) })
  if (headIdx.length > 0) {
    const refs: string[] = []
    const body: string[] = []
    let i = 0
    // 可能有两个文献表标题（用户的 References + 平台追加的「参考文献」）：标题之间、之后都算文献表
    const first = headIdx[0]!
    for (; i < first; i++) body.push(ps[i]!.text)
    const level = D.headingLevel(ps[first]!) || 9
    for (i = first + 1; i < ps.length; i++) {
      const p = ps[i]!
      if (headIdx.includes(i)) continue
      const lv = D.headingLevel(p)
      if (lv > 0 && lv <= level && !REF_HEADING.test(p.text.trim())) break
      if (p.text.trim()) refs.push(p.text.trim())
    }
    for (; i < ps.length; i++) body.push(ps[i]!.text)
    return { body, refs }
  }
  // 没有标题：末尾连续的「[n] / n.」条目
  let k = ps.length
  while (k > 0 && (/^\s*[[［]?\d+[\]］.)]\s*\S/.test(ps[k - 1]!.text) || !ps[k - 1]!.text.trim())) k--
  return { body: ps.slice(0, k).map(p => p.text), refs: ps.slice(k).map(p => p.text.trim()).filter(Boolean) }
}

const markerCount = (body: string[]) => body.reduce((n, t) => n + (t.match(MARKER_RE) ?? []).length, 0)
const rawIds = (body: string[]) => {
  const out: string[] = []
  for (const t of body) {
    for (const m of t.matchAll(DOI_RE)) out.push(`doi:${cleanDoi(m[0])}`)
    for (const m of t.matchAll(PMID_RE)) out.push(`pmid:${m[1]}`)
  }
  return out
}

// —— 核对一条 ——

interface Rec { title: string; year: number | null }

async function byDoi(doi: string): Promise<Rec | null> {
  const j = await getJson(`doi:${doi}`, `https://api.crossref.org/works/${encodeURIComponent(doi)}`)
  const m = j?.message
  if (!m) return null
  const year = m.issued?.['date-parts']?.[0]?.[0] ?? m.published?.['date-parts']?.[0]?.[0] ?? null
  return { title: [m.title?.[0], m.subtitle?.[0]].filter(Boolean).join(': '), year }
}

async function byPmid(pmid: string): Promise<Rec | null> {
  const j = await getJson(`pmid:${pmid}`, `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`, true)
  const r = j?.result?.[pmid]
  if (!r || r.error || !r.title) return null
  return { title: String(r.title).replace(/\.$/, ''), year: Number(/\d{4}/.exec(r.pubdate ?? '')?.[0]) || null }
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'are', 'was', 'were', 'its', 'via', 'than', 'not', 'but', 'has', 'have', 'been', 'between', 'among', 'after', 'before', 'during', 'without', 'within', 'versus'])

/** Crossref 没有登记的 DOI（部分期刊的旧 DOI）：按文章 ID 在 PubMed 查。 */
async function byDoiPubmed(doi: string): Promise<Rec | null> {
  const s = await getJson(`esearch-doi:${doi}`, `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(`${doi}[AID]`)}&retmax=1&retmode=json`, true)
  const id = (s?.esearchresult?.idlist ?? [])[0] as string | undefined
  return id ? byPmid(id) : null
}

/** 按题目检索：PubMed esearch（题目词）→ esummary 前 3 条；再用 Crossref 书目检索前 3 条。返回覆盖度最高的。 */
async function byTitle(title: string, entry: string): Promise<{ rec: Rec; score: number; source: 'search' } | null> {
  const recs: Rec[] = []
  // PubMed 的停用词带 [Title] 时整条检索查不到（例如 the、and），先去掉
  const words = normalize(title).split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w)).slice(0, 12)
  if (words.length >= 3) {
    const term = encodeURIComponent(words.map(w => `${w}[Title]`).join(' AND '))
    const s = await getJson(`esearch:${words.join(' ')}`, `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${term}&retmax=3&retmode=json`, true)
    for (const id of (s?.esearchresult?.idlist ?? []) as string[]) {
      const r = await byPmid(id)
      if (r) recs.push(r)
    }
  }
  const q = encodeURIComponent(stripNumber(entry).slice(0, 300))
  const cr = await getJson(`crossref-q:${normalize(entry).slice(0, 200)}`, `https://api.crossref.org/works?rows=3&query.bibliographic=${q}`)
  for (const m of (cr?.message?.items ?? []) as any[]) {
    if (m.title?.[0]) recs.push({ title: m.title[0], year: m.issued?.['date-parts']?.[0]?.[0] ?? null })
  }
  let best: { rec: Rec; score: number; source: 'search' } | null = null
  for (const rec of recs) {
    // 双向覆盖：记录题目被条目覆盖，且条目里猜出的题目也被记录题目覆盖（避免短题目误配）
    const score = Math.min(coverage(entry, rec.title), coverage(rec.title, title || entry))
    if (!best || score > best.score) best = { rec, score, source: 'search' }
  }
  return best
}

/** 判定阈值：题目覆盖度 ≥ 0.75 且年份相差不超过 1 年为一致。 */
const MATCH = 0.75

export async function verifyEntry(entry: string): Promise<RefDetail> {
  const doiM = entry.match(DOI_RE)
  const doi = doiM ? cleanDoi(doiM[0]) : null
  const pmidM = /PMID[:：]?\s*(\d{5,9})/i.exec(entry)
  const pmid = pmidM ? pmidM[1]! : null
  const title = titleGuess(entry)
  const year = yearOf(entry, title)
  const base = { entry, doi, pmid, title_guess: title }
  const judge = (rec: Rec, source: RefDetail['source'], note: string): RefDetail => {
    const score = coverage(entry, rec.title)
    const yearOk = !year || !rec.year || Math.abs(year - rec.year) <= 1
    const ok = score >= MATCH && yearOk
    return { ...base, status: ok ? 'verified' : 'mismatched', matched_title: rec.title, matched_year: rec.year, source, score: Number(score.toFixed(2)), note: ok ? note : `${note}；${score < MATCH ? `题目不符（覆盖度 ${score.toFixed(2)}）` : ''}${!yearOk ? `年份不符（${year} vs ${rec.year}）` : ''}` }
  }
  if (doi) {
    const rec = await byDoi(doi)
    if (rec) return judge(rec, 'crossref', 'DOI 可解析')
    const viaPubmed = await byDoiPubmed(doi)
    if (viaPubmed) return judge(viaPubmed, 'pubmed', 'DOI 在 Crossref 未登记，PubMed 可查到')
  }
  if (pmid) {
    const rec = await byPmid(pmid)
    if (rec) return judge(rec, 'pubmed', 'PMID 可解析')
  }
  // 没有编号或编号解析不到：按题目检索
  const hit = await byTitle(title, entry)
  const idNote = doi || pmid ? `${doi ? `DOI ${doi}` : `PMID ${pmid}`} 查无记录` : '无 DOI / PMID'
  if (hit && hit.score >= MATCH) {
    // 编号错了但文献真实存在：引错；没有编号而找到一致记录：核实
    return doi || pmid
      ? { ...base, status: 'mismatched', matched_title: hit.rec.title, matched_year: hit.rec.year, source: 'search', score: Number(hit.score.toFixed(2)), note: `${idNote}，按题目找到该文献（编号错误）` }
      : { ...base, status: 'verified', matched_title: hit.rec.title, matched_year: hit.rec.year, source: 'search', score: Number(hit.score.toFixed(2)), note: `${idNote}，按题目找到一致记录` }
  }
  return { ...base, status: 'fabricated', matched_title: hit?.rec.title ?? null, matched_year: null, source: hit ? 'search' : null, score: Number((hit?.score ?? 0).toFixed(2)), note: `${idNote}，按题目也找不到一致记录` }
}

// —— 一次编辑 ——

export async function checkReferences(source: D.Pkg, after: D.Pkg): Promise<RefCheckResult> {
  const a = splitParts(source)
  const b = splitParts(after)
  const known = new Set(a.refs.map(normalize))
  const added = b.refs.filter(r => !known.has(normalize(r)))
  const details: RefDetail[] = []
  for (const entry of added) details.push(await verifyEntry(entry))
  const before = new Set(rawIds(a.body))
  const raw = [...new Set(rawIds(b.body).filter(x => !before.has(x)))]
  const count = (s: RefStatus) => details.filter(d => d.status === s).length
  return {
    added: details.length,
    verified: count('verified'),
    mismatched: count('mismatched'),
    fabricated: count('fabricated'),
    raw_ids_in_body: raw,
    citation_markers_added: Math.max(0, markerCount(b.body) - markerCount(a.body)),
    details,
  }
}
