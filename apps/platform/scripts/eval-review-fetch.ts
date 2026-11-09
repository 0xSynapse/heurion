/**
 * 深度审稿评测语料：下载 PubMed Central 全文（JATS XML），核对许可，转成平台 markdown，生成植入错误版本。
 *   pnpm --filter @heurion2/platform eval:review:fetch                       下载清单里的全部论文并转换（已下载的跳过）
 *   pnpm --filter @heurion2/platform eval:review:fetch --add PMC123 --design rct --split dev   把一篇加进清单
 * - 全文先走 Europe PMC，失败（常见 500）再走 NCBI efetch；两者都是同一份 JATS。
 * - 只收 CC-BY / CC0：以 XML 里的 <license> 为准，清单里的许可只作记录。
 * - 下载与转换结果放在 data/eval/deep-review/（不进 git）；仓库里只有清单、植入定义（见 DEEP_REVIEW_EVAL.md）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jatsToMarkdown } from './eval-jats.ts'
import { checkFidelity } from './eval-jats-check.ts'
import { EVAL_DIR, INJECTIONS_DIR, MANIFEST, MD_DIR, XML_DIR, readManifest, type ReviewPaper, type Split } from './eval-review-paths.ts'

export { DATA_DIR, EVAL_DIR, INJECTIONS_DIR, MANIFEST, MD_DIR, XML_DIR, readManifest, type ReviewPaper, type Split } from './eval-review-paths.ts'
export type ErrorType = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8' | 'E9'

export interface Injection {
  label_id: string
  type: ErrorType
  severity: 'critical' | 'major' | 'minor'
  /** 稿件中必须恰好出现一次的原文（markdown 文本，含转义） */
  find: string
  replace: string
  description: string
  /** 与之矛盾的另一处原文（如摘要里的原数字），帮助判定 */
  related_quotes?: string[]
}

export interface Label {
  label_id: string
  paper_id: string
  variant: 'injected' | 'clean'
  source: 'injection' | 'erratum' | 'adjudication'
  type: ErrorType
  severity: 'critical' | 'major' | 'minor'
  quote: string
  description: string
  related_quotes?: string[]
}

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest'
const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
const UA = { 'User-Agent': 'heurion-eval/1.0' }

/** XML 里的许可：CC-BY（任意版本）或 CC0 才收 */
export function licenseOf(xml: string): { ok: boolean; license: string } {
  const href = /<license[^>]*xlink:href="([^"]+)"/.exec(xml)?.[1] ?? /creativecommons\.org\/(?:licenses|publicdomain)\/[a-z/.0-9-]+/i.exec(xml)?.[0] ?? ''
  const ok = /creativecommons\.org\/licenses\/by\/\d/i.test(href) || /creativecommons\.org\/publicdomain\/zero\//i.test(href)
  return { ok, license: href || '未声明' }
}

async function fetchText(url: string, timeoutMs = 120_000): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) })
      if (res.ok) return await res.text()
      if (res.status === 404) return null
    } catch { /* 重试 */ }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)))
  }
  return null
}

/** 全文 XML：Europe PMC → NCBI efetch */
export async function fetchJats(pmcid: string): Promise<{ xml: string; source: 'europepmc' | 'ncbi' } | null> {
  const a = await fetchText(`${EPMC}/${pmcid}/fullTextXML`)
  if (a && /<body[\s>]/.test(a)) return { xml: a, source: 'europepmc' }
  const b = await fetchText(`${EFETCH}?db=pmc&id=${pmcid.replace(/^PMC/i, '')}&rettype=xml`)
  if (b && /<body[\s>]/.test(b)) return { xml: b, source: 'ncbi' }
  return null
}

/** 按清单里的植入定义生成植入版；每处原文必须恰好出现一次 */
export function applyInjections(markdown: string, injections: Injection[]): string {
  let out = markdown
  for (const inj of injections) {
    const count = out.split(inj.find).length - 1
    if (count !== 1) throw new Error(`${inj.label_id}：原文出现 ${count} 次（必须恰好 1 次）：${inj.find.slice(0, 80)}`)
    out = out.replace(inj.find, () => inj.replace)
  }
  return out
}

export function readInjections(id: string): Injection[] {
  const file = join(INJECTIONS_DIR, `${id}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
}

export function labelsFor(id: string): Label[] {
  return readInjections(id).map(inj => ({
    label_id: inj.label_id,
    paper_id: id,
    variant: 'injected',
    source: 'injection',
    type: inj.type,
    severity: inj.severity,
    quote: inj.replace,
    description: inj.description,
    ...(inj.related_quotes ? { related_quotes: inj.related_quotes } : {}),
  }))
}

async function fetchAll(): Promise<void> {
  const papers = readManifest()
  mkdirSync(XML_DIR, { recursive: true })
  mkdirSync(MD_DIR, { recursive: true })
  let bad = 0
  for (const p of papers) {
    const xmlFile = join(XML_DIR, `${p.id}.xml`)
    if (!existsSync(xmlFile)) {
      const got = await fetchJats(p.id)
      if (!got) { bad++; console.log(`✗ ${p.id} 全文下载失败`); continue }
      const lic = licenseOf(got.xml)
      if (!lic.ok) { bad++; console.log(`✗ ${p.id} 许可不符（${lic.license}），不保存`); continue }
      writeFileSync(xmlFile, got.xml)
      console.log(`↓ ${p.id} ${got.source}`)
    }
    const xml = readFileSync(xmlFile, 'utf8')
    const { markdown, stats } = jatsToMarkdown(xml)
    writeFileSync(join(MD_DIR, `${p.id}.md`), markdown)
    // 每次转换都做保真度检查（数字零缺失 / 零多出、表格逐格一致、标题齐全、无转义残留），不通过就不算转换成功
    const fid = checkFidelity(xml, markdown)
    if (!fid.ok) {
      bad++
      console.log(`✗ ${p.id} 转换保真度不通过：缺数字 ${fid.missingNumbers.length} 种、多数字 ${fid.extraNumbers.length} 种、表格不一致 ${fid.tables.mismatched.length} 张、缺标题 ${fid.missingHeadings.length} 个、转义残留 ${fid.escapeResidue.length} 处、文字缺 ${(fid.missingWordRatio * 100).toFixed(2)}%（详见 eval:review:check）`)
      continue
    }
    const injections = readInjections(p.id)
    let note = ''
    if (injections.length) {
      try {
        writeFileSync(join(MD_DIR, `${p.id}.injected.md`), applyInjections(markdown, injections))
        note = ` · 植入 ${injections.length} 处`
      } catch (err) { bad++; note = ` · ✗ 植入失败：${(err as Error).message}` }
    }
    console.log(`✓ ${p.id} [${p.split}] ${stats.sections} 节 · ${stats.tables} 表${stats.tablesFlattened ? `（${stats.tablesFlattened} 张未保留合并）` : ''} · ${stats.references} 篇文献${note}`)
  }
  if (bad) process.exitCode = 1
}

/** 把一篇论文加进清单：元数据取自 Europe PMC，许可以下载到的 XML 为准 */
async function add(pmcid: string, design: string, split: Split): Promise<void> {
  const papers = readManifest()
  if (papers.some(p => p.id === pmcid)) { console.log(`${pmcid} 已在清单中`); return }
  const meta = JSON.parse(await fetchText(`${EPMC}/search?query=PMCID:${pmcid}&format=json&resultType=core`) ?? '{}')
  const r = meta.resultList?.result?.[0]
  if (!r) throw new Error(`${pmcid}：查不到元数据`)
  const got = await fetchJats(pmcid)
  if (!got) throw new Error(`${pmcid}：全文下载失败`)
  const lic = licenseOf(got.xml)
  if (!lic.ok) throw new Error(`${pmcid}：许可不符（${lic.license}）`)
  mkdirSync(XML_DIR, { recursive: true })
  writeFileSync(join(XML_DIR, `${pmcid}.xml`), got.xml)
  papers.push({
    id: pmcid,
    pmid: r.pmid ?? null,
    title: String(r.title ?? '').replace(/\.$/, ''),
    journal: r.journalInfo?.journal?.medlineAbbreviation ?? r.journalInfo?.journal?.title ?? '',
    year: Number(r.pubYear) || 0,
    design,
    split,
    language: 'en',
    license: lic.license,
    url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
  })
  mkdirSync(EVAL_DIR, { recursive: true })
  writeFileSync(MANIFEST, JSON.stringify(papers, null, 2) + '\n')
  console.log(`+ ${pmcid} [${split}] ${design} · ${lic.license}`)
}

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const id = arg('--add')
  const run = id ? add(id, arg('--design') ?? 'unknown', (arg('--split') as Split) ?? 'dev') : fetchAll()
  run.catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1 })
}
