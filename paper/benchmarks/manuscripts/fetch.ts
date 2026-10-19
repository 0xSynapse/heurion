/**
 * 改稿测试集的语料：PubMed Central 开放获取论文（只收 CC-BY / CC0），全文 JATS XML 经 Europe PMC 下载。
 *   cd apps/platform && npx tsx ../../paper/benchmarks/manuscripts/fetch.ts
 * 清单在 corpus.json（进 git）；全文放在 data/ 下（.gitignore 已忽略 data/）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { metadata } from '../../../apps/platform/scripts/eval-fetch.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const MANIFEST = join(here, 'corpus.json')
export const XML_DIR = join(here, 'data', 'xml')
const ALLOWED = /^(cc[ -]?by|cc0)$/i

export interface Paper { pmcid: string; type: 'rct' | 'cohort' | 'meta'; split: 'train' | 'heldout'; title?: string; journal?: string; year?: number; license?: string; attribution?: string }

const papers = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Paper[]
mkdirSync(XML_DIR, { recursive: true })
for (const p of papers) {
  const m = await metadata(p.pmcid)
  if (!m.license || !ALLOWED.test(m.license.trim())) { console.log(`✗ ${p.pmcid} 许可是 ${m.license}，不收`); process.exitCode = 1; continue }
  const title = m.title.replace(/<[^>]+>/g, '').replace(/\.$/, '')
  Object.assign(p, { title, journal: m.journal, year: m.year, license: m.license, attribution: `${title}. ${m.journal}, ${m.year}. ${p.pmcid}. Licensed under ${m.license.toUpperCase()}; adapted for a manuscript-revision benchmark.` })
  const file = join(XML_DIR, `${p.pmcid}.xml`)
  if (!existsSync(file)) {
    const res = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/${p.pmcid}/fullTextXML`, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) { console.log(`✗ ${p.pmcid} 全文下载失败 ${res.status}`); process.exitCode = 1; continue }
    writeFileSync(file, await res.text())
  }
  console.log(`✓ ${p.pmcid} ${m.license} ${p.type}/${p.split} · ${title.slice(0, 70)}`)
}
writeFileSync(MANIFEST, JSON.stringify(papers, null, 2) + '\n')
