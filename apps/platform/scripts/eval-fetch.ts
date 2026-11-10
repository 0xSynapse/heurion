/**
 * M1 论断核对评测（C2）的语料：PubMed Central 开放获取文章（只收 CC-BY / CC0），全文 XML 经 Europe PMC 下载。
 *   pnpm --filter @heurion2/platform eval:fetch            按 eval/corpus.json 下载并核对许可（已下载的跳过）
 *   pnpm --filter @heurion2/platform eval:fetch --search "<Europe PMC 查询>"   列候选（挑选语料用）
 * 下载内容放在 data/eval/corpus/（不进 git）；仓库里只有清单 eval/corpus.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CorpusEntry {
  pmcid: string
  pmid: string | null
  title: string
  journal: string
  year: number
  type: string
  topic: string
  license: string
  url: string
  attribution: string
}

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const CORPUS_DIR = join(ROOT, 'data', 'eval', 'corpus')
export const MANIFEST = fileURLToPath(new URL('../eval/corpus.json', import.meta.url))
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest'
const ALLOWED = /^(cc[ -]?by|cc0)$/i

async function getJson(url: string): Promise<any> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (res.ok) return await res.json()
    } catch { /* 重试 */ }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)))
  }
  throw new Error(`请求失败：${url}`)
}

/** Europe PMC 元数据（许可、期刊、年份、PMID）。 */
export async function metadata(pmcid: string): Promise<{ license: string | null; title: string; journal: string; year: number; pmid: string | null; pubTypes: string[] }> {
  const d = await getJson(`${EPMC}/search?query=PMCID:${pmcid}&format=json&resultType=core`)
  const r = d.resultList?.result?.[0]
  if (!r) throw new Error(`Europe PMC 没有 ${pmcid}`)
  return {
    license: r.license ?? null,
    title: r.title ?? '',
    journal: r.journalInfo?.journal?.title ?? r.journalInfo?.journal?.medlineAbbreviation ?? '',
    year: Number(r.pubYear ?? 0),
    pmid: r.pmid ?? null,
    pubTypes: r.pubTypeList?.pubType ?? [],
  }
}

async function search(query: string): Promise<void> {
  const q = `(${query}) AND OPEN_ACCESS:y AND HAS_FT:y AND (LICENSE:"cc by" OR LICENSE:"cc0")`
  const d = await getJson(`${EPMC}/search?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=15`)
  for (const r of d.resultList?.result ?? []) {
    console.log([r.pmcid, r.license, r.pubYear, r.journalInfo?.journal?.medlineAbbreviation, (r.pubTypeList?.pubType ?? []).slice(0, 2).join('/'), `cited ${r.citedByCount}`, '|', String(r.title).slice(0, 100)].join('  '))
  }
}

async function fetchAll(): Promise<void> {
  const entries = JSON.parse(readFileSync(MANIFEST, 'utf8')) as CorpusEntry[]
  mkdirSync(CORPUS_DIR, { recursive: true })
  let bad = 0
  for (const e of entries) {
    const meta = await metadata(e.pmcid)
    const ok = !!meta.license && ALLOWED.test(meta.license.trim())
    if (!ok) { bad++; console.log(`✗ ${e.pmcid} 许可不符（${meta.license}），不下载`); continue }
    const file = join(CORPUS_DIR, `${e.pmcid}.xml`)
    if (!existsSync(file)) {
      const res = await fetch(`${EPMC}/${e.pmcid}/fullTextXML`, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) { bad++; console.log(`✗ ${e.pmcid} 全文下载失败 ${res.status}`); continue }
      writeFileSync(file, await res.text())
    }
    console.log(`✓ ${e.pmcid} ${meta.license} · ${e.title.slice(0, 70)}`)
  }
  if (bad) process.exitCode = 1
}

/** 把一篇文章加进清单（许可不符拒收）。 */
async function add(pmcid: string, type: string, topic: string): Promise<void> {
  const entries: CorpusEntry[] = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : []
  if (entries.some(e => e.pmcid === pmcid)) return
  const m = await metadata(pmcid)
  if (!m.license || !ALLOWED.test(m.license.trim())) throw new Error(`${pmcid} 许可是 ${m.license}，只收 CC-BY / CC0`)
  let cleanTitle = ''
  for (let i = 0; i < m.title.length; ) {
    const lt = m.title.indexOf('<', i)
    if (lt === -1) { cleanTitle += m.title.slice(i); break }
    cleanTitle += m.title.slice(i, lt)
    const gt = m.title.indexOf('>', lt + 1)
    if (gt === -1) break
    i = gt + 1
  }
  const title = cleanTitle.replace(/\.$/, '')
  entries.push({
    pmcid, pmid: m.pmid, title, journal: m.journal, year: m.year, type, topic, license: m.license, url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
    attribution: `${title}. ${m.journal}, ${m.year}. ${pmcid}. Licensed under ${m.license.toUpperCase()}; claim sentences are short excerpts (some deliberately altered for evaluation).`,
  })
  writeFileSync(MANIFEST, JSON.stringify(entries, null, 2) + '\n')
  console.log(`+ ${pmcid} ${m.license} ${title.slice(0, 80)}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--search')
  const a = process.argv.indexOf('--add')
  if (i > 0) await search(process.argv[i + 1] ?? '')
  else if (a > 0) await add(process.argv[a + 1]!, process.argv[a + 2] ?? 'review', process.argv[a + 3] ?? '')
  else await fetchAll()
}
