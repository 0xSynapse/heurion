/**
 * 参考文献批量导入（M1）：把用户的文献列表登记到文档的引用登记表，之后人和 AI 都能直接引用。
 * 支持 RIS（EndNote / Zotero / Mendeley 导出）、BibTeX、PubMed（MEDLINE / .nbib）、EndNote XML，以及任意文本里的 DOI / PMID。
 * 与 insert_citation 同一条规矩：DOI 要能在 Crossref 查到；只有 PMID 的经 PubMed 核实（有 DOI 的补 DOI，无 DOI 的按 pmid:xxx 登记）；两者都没有的跳过并报告。
 */
import type { Store } from '../store/db.ts'
import type { CrossrefClient } from './crossref.ts'
import { formatCitation, normalizeDoi, type CitationStyle } from './format.ts'
import type { PubMedClient } from './pubmed.ts'
import type { Article } from './types.ts'

export interface ParsedRef { doi: string | null; pmid: string | null; label: string }

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>,;{}]+[^\s"'<>,;{}.)\]])/i
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 识别格式并拆成条目；每条取 DOI / PMID 与一个给用户看的标签（标题或首行）。 */
export function parseReferences(text: string): ParsedRef[] {
  const t = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '')
  if (/^TY {2}- /m.test(t)) return ris(t)
  if (/^PMID- /m.test(t)) return medline(t)
  if (/@\w+\s*\{/.test(t)) return bibtex(t)
  if (/<record>[\s\S]*<\/record>/i.test(t)) return endnoteXml(t)
  return plain(t)
}

function ris(t: string): ParsedRef[] {
  return t.split(/^ER {2}-.*$/m).map(rec => {
    const tag = (k: string) => new RegExp(`^${k} {2}- (.+)$`, 'm').exec(rec)?.[1]?.trim() ?? null
    const doi = tag('DO') ?? DOI_RE.exec(rec)?.[1] ?? null
    const an = tag('AN')
    const pmid = an && /^\d{6,9}$/.test(an) ? an : (/PMID:?\s*(\d{6,9})/i.exec(rec)?.[1] ?? null)
    return { doi: doi ? normalizeDoi(doi) : null, pmid, label: clean(tag('TI') ?? tag('T1') ?? rec.split('\n').find(l => l.trim()) ?? '') }
  }).filter(r => r.label || r.doi || r.pmid)
}

function medline(t: string): ParsedRef[] {
  return t.split(/\n(?=PMID- )/).map(rec => {
    const pmid = /^PMID- (\d+)/m.exec(rec)?.[1] ?? null
    const doi = /^(?:LID|AID) - (\S+) \[doi\]/m.exec(rec)?.[1] ?? null
    const title = /^TI {2}- ([\s\S]*?)(?=\n[A-Z]{2,4} ?- )/m.exec(rec)?.[1] ?? ''
    return { doi: doi ? normalizeDoi(doi) : null, pmid, label: clean(title) }
  }).filter(r => r.pmid || r.doi)
}

function bibtex(t: string): ParsedRef[] {
  return t.split(/(?=@\w+\s*\{)/).filter(e => /^@\w+\s*\{/.test(e) && !/^@(comment|string|preamble)\b/i.test(e)).map(e => {
    const field = (k: string) => new RegExp(`\\b${k}\\s*=\\s*[{"]([^}"]*)[}"]`, 'i').exec(e)?.[1]?.trim() ?? null
    const doi = field('doi') ?? DOI_RE.exec(e)?.[1] ?? null
    const pmid = field('pmid')
    return { doi: doi ? normalizeDoi(doi) : null, pmid: pmid && /^\d+$/.test(pmid) ? pmid : null, label: clean((field('title') ?? e.slice(0, 80)).replace(/[{}]/g, '')) }
  })
}

function endnoteXml(t: string): ParsedRef[] {
  const strip = (s: string) => {
    let out = ''
    let i = 0
    while (i < s.length) {
      const lt = s.indexOf('<', i)
      if (lt === -1) { out += s.slice(i); break }
      out += s.slice(i, lt)
      const gt = s.indexOf('>', lt + 1)
      if (gt === -1) break
      i = gt + 1
    }
    return out
  }
  return [...t.matchAll(/<record>([\s\S]*?)<\/record>/gi)].map(([, rec]) => {
    const doi = /<electronic-resource-num>([\s\S]*?)<\/electronic-resource-num>/i.exec(rec!)?.[1]
    const pmid = /<accession-num>[\s\S]*?(\d{6,9})[\s\S]*?<\/accession-num>/i.exec(rec!)?.[1] ?? null
    const title = /<title>([\s\S]*?)<\/title>/i.exec(rec!)?.[1] ?? ''
    const d = doi ? DOI_RE.exec(strip(doi))?.[1] : DOI_RE.exec(strip(rec!))?.[1]
    return { doi: d ? normalizeDoi(d) : null, pmid, label: clean(strip(title)) }
  })
}

/** 任意文本：每行（或每个分号分隔项）里的 DOI / PMID。 */
function plain(t: string): ParsedRef[] {
  const out: ParsedRef[] = []
  for (const line of t.split(/\n|;/).map(l => l.trim()).filter(Boolean)) {
    const doi = DOI_RE.exec(line)?.[1]
    const pmid = /(?:PMID:?\s*|pubmed\.ncbi\.nlm\.nih\.gov\/)(\d{6,9})/i.exec(line)?.[1] ?? (/^\d{6,9}$/.test(line) ? line : null)
    if (doi || pmid) out.push({ doi: doi ? normalizeDoi(doi) : null, pmid, label: clean(line).slice(0, 120) })
  }
  return out
}

export interface ImportReport {
  added: Array<{ cite_id: string; formatted: string }>
  already: number
  skipped: Array<{ label: string; reason: string }>
}

/** 逐条核实并登记（同一 DOI / PMID 只登记一次，已在登记表里的计入 already）。 */
export async function importReferences(
  deps: { store: Store; crossref: CrossrefClient; pubmed: PubMedClient },
  docId: string,
  refs: ParsedRef[],
  style: CitationStyle = 'ama',
): Promise<ImportReport> {
  const report: ImportReport = { added: [], already: 0, skipped: [] }
  const existingRows = deps.store.listCitations(docId)
  const existing = new Set(existingRows.map(c => c.doi.toLowerCase()))
  const existingPmids = new Set(existingRows.map(c => c.pmid).filter((p): p is string => Boolean(p)))
  // 只有 PMID 的：PubMed 批量查题录（有 DOI 的补 DOI，无 DOI 的按 pmid:xxx 登记）
  const pmidOnly = refs.filter(r => !r.doi && r.pmid).map(r => r.pmid!)
  const byPmid = new Map<string, Article>()
  for (let i = 0; i < pmidOnly.length; i += 100) {
    const slice = pmidOnly.slice(i, i + 100)
    try {
      const articles = await deps.pubmed.summaries(slice)
      const needAbs = articles.filter(a => a.pmid && !a.abstract).map(a => a.pmid!)
      const absMap = needAbs.length > 0 && typeof deps.pubmed.abstracts === 'function'
        ? await deps.pubmed.abstracts(needAbs).catch(() => new Map<string, string>())
        : new Map<string, string>()
      for (const a of articles) {
        if (a.pmid) {
          const abs = a.abstract ?? absMap.get(a.pmid)
          byPmid.set(a.pmid, abs ? { ...a, abstract: abs } : a)
        }
      }
    } catch { /* 网络问题：这些条目下面报告为查不到 */ }
  }
  const seen = new Set<string>()
  const work = refs.slice(0, 500)
  // 小并发查 Crossref（礼貌限速）
  let next = 0
  const worker = async () => {
    while (next < work.length) {
      const r = work[next++]!
      const pmArticle = !r.doi && r.pmid ? byPmid.get(r.pmid) ?? null : null
      if (!r.doi && r.pmid && !pmArticle && (existingPmids.has(r.pmid) || existing.has(`pmid:${r.pmid}`))) {
        const pmidKey = `pmid:${r.pmid}`
        if (!seen.has(pmidKey)) { seen.add(pmidKey); report.already++ }
        continue
      }
      const rawDoi = r.doi ?? (pmArticle?.doi ? normalizeDoi(pmArticle.doi) : null)
      const fallbackPmid = pmArticle?.pmid ?? r.pmid ?? null
      const doi = rawDoi ? normalizeDoi(rawDoi) : (pmArticle && fallbackPmid ? `pmid:${fallbackPmid}` : null)
      if (!doi) { report.skipped.push({ label: r.label || `PMID ${r.pmid}`, reason: r.pmid ? 'PubMed 里查不到这篇文献的 DOI' : '没有 DOI 或 PMID' }); continue }
      if (seen.has(doi) || (fallbackPmid && seen.has(`pmid:${fallbackPmid}`))) continue
      seen.add(doi)
      if (fallbackPmid) seen.add(`pmid:${fallbackPmid}`)
      if (existing.has(doi) || (fallbackPmid && (existingPmids.has(fallbackPmid) || existing.has(`pmid:${fallbackPmid}`)))) {
        const cachedAbs = pmArticle?.abstract?.trim()
        if (cachedAbs && !deps.store.getAbstract(doi)?.abstract) {
          deps.store.putAbstract(doi, fallbackPmid, cachedAbs)
        }
        report.already++
        continue
      }
      let article: Article | null = null
      if (doi.startsWith('pmid:')) {
        article = pmArticle
      } else {
        // lookup：DOI 不存在返回 null；网络 / 限流抛错——重试一次，仍失败就如实说是暂时访问不了（不能说成「查不到」）
        try {
          article = await deps.crossref.lookup(doi).catch(async () => { await new Promise(res => setTimeout(res, 1500)); return deps.crossref.lookup(doi) })
        } catch (err) {
          report.skipped.push({ label: r.label || doi, reason: `Crossref 暂时无法访问（${(err as Error).message.slice(0, 60)}），稍后重新导入即可` })
          continue
        }
        if (!article && pmArticle) article = pmArticle
      }
      if (!article) { report.skipped.push({ label: r.label || doi, reason: `DOI ${doi} 在 Crossref 查不到` }); continue }
      const finalDoi = normalizeDoi(article.doi || '') || (article.pmid ? `pmid:${article.pmid}` : doi)
      const finalPmid = article.pmid ?? fallbackPmid
      const finalUrl = article.doi ? `https://doi.org/${normalizeDoi(article.doi)}` : (finalPmid ? `https://pubmed.ncbi.nlm.nih.gov/${finalPmid}/` : null)
      const row = deps.store.upsertCitation({ doc_id: docId, doi: finalDoi, pmid: finalPmid, formatted: formatCitation(article, style), url: finalUrl })
      let abstract = article.abstract?.trim() || pmArticle?.abstract?.trim() || null
      if (!abstract && finalPmid && typeof deps.pubmed.abstract === 'function') {
        abstract = (await deps.pubmed.abstract(finalPmid).catch(() => null))?.trim() || null
      }
      if (!abstract && !finalPmid && finalDoi.startsWith('10.') && typeof deps.pubmed.pmidForDoi === 'function' && typeof deps.pubmed.abstract === 'function') {
        const foundPmid = await deps.pubmed.pmidForDoi(finalDoi).catch(() => null)
        if (foundPmid) abstract = (await deps.pubmed.abstract(foundPmid).catch(() => null))?.trim() || null
      }
      if (abstract) {
        deps.store.putAbstract(finalDoi, finalPmid, abstract)
      }
      report.added.push({ cite_id: row.id, formatted: row.formatted })
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  if (refs.length > work.length) report.skipped.push({ label: `其余 ${refs.length - work.length} 条`, reason: '一次最多导入 500 条' })
  return report
}
