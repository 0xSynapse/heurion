/**
 * 导入质量评测：用同版本 JATS 作标准答案，检查产品的 PDF / Word 导入丢了什么、错了什么（docs/design/IMPORT_EVAL.md）。
 *   pnpm --filter @heurion2/platform eval:import --fetch                 下载清单论文的同版本 PDF + JATS（PMC 开放获取数据集）
 *   pnpm --filter @heurion2/platform eval:import                         跑全部路径，与基线对比；变差超过容差则退出码 1
 *   … eval:import --path pdf-docling,docx-realistic --only PMC123        只跑部分路径 / 论文
 *   … eval:import --write-baseline                                       把本次结果写成新基线（确认改进后再写）
 * 路径：
 * - pdf-docling：产品 PDF 主路径（需要 doc-parser 服务就绪，DOC_PARSER_URL；退回 poppler 的论文记为失败，不混入成绩）
 * - pdf-poppler：PDF 兜底路径
 * - docx-clean：LibreOffice 由平台 HTML 生成的干净 docx（需要 soffice）
 * - docx-realistic：在干净 docx 上叠加作者稿件常见结构（EndNote 域、题注域、修订、文本框、行号、自动编号）
 * 指标逐篇用 eval-jats-check.ts 的保真度检查：数字缺 / 多、文字缺失率、表格行列与逐格内容、章节标题，
 * Word 另查修订删除内容与域指令是否混进正文。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Node as PMNode } from 'prosemirror-model'
import { HttpDocParser } from '../src/convert/doc-parser.ts'
import { importDocx } from '../src/convert/docx-import.ts'
import { importPdf, importPdfPoppler } from '../src/convert/pdf-import.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'
import { renderHtml } from '../src/views/render.ts'
import { applyConstructs, DELETED_MARK } from './eval-docx-constructs.ts'
import { checkFidelityDoc } from './eval-jats-check.ts'
import { jatsToMarkdown } from './eval-jats.ts'
import { IMPORT_BASELINE, IMPORT_DATA_DIR, readManifest } from './eval-review-paths.ts'

export const PATHS = ['pdf-docling', 'pdf-poppler', 'docx-clean', 'docx-realistic'] as const
export type ImportPath = typeof PATHS[number]

export interface PaperResult {
  id: string
  ok: boolean
  error: string | null
  seconds: number
  numbers: number
  missingNumbers: number
  extraNumbers: number
  missingWordPct: number
  tablesSource: number
  tablesConverted: number
  tablesDimsOk: number
  /** 各表平均：位置完全对上的单元格比例（%）；没有表格为 null */
  cellExact: number | null
  /** 各表平均：内容出现在对应表中（不论位置）的单元格比例（%） */
  cellRecall: number | null
  /** 合并单元格（行列对上的表）：原文被覆盖的格数 / 转换后同样被覆盖的格数 / 转换后多出的被覆盖格数 */
  spanCells: number
  spanHit: number
  spanExtra: number
  headingsMissing: number
  /** 结构：标题是否认对、图注落位、多余标题与层级、段落是否完整（见 eval-jats-check 的 structure） */
  titleOk: boolean
  figSource: number
  figCaptioned: number
  figImages: number
  figUncaptioned: number
  headingsExtra: number
  headingLevelWrong: number
  paraTotal: number
  paraBroken: number
  formulaSource: number
  formulaConverted: number
  /** Word：修订删除的内容出现在采纳后的正文里 */
  deletedLeaked: boolean
  /** Word：域指令（ADDIN、SEQ 等）出现在正文里 */
  instrLeaked: boolean
}

export interface PathSummary {
  papers: number
  failed: number
  missingNumbers: number
  extraNumbers: number
  missingWordPct: number
  tablesSource: number
  tablesConverted: number
  tablesDimsOk: number
  cellExact: number | null
  cellRecall: number | null
  spanCells: number
  /** 原文合并区覆盖的格子在转换结果中同样被覆盖的比例（%）；没有合并单元格为 null */
  spanRecall: number | null
  spanExtra: number
  headingsMissing: number
  /** 标题认对的篇数 */
  titleOk?: number
  figSource?: number
  /** 原文的图里，图注落在某个图块上的个数 */
  figCaptioned?: number
  /** 没有图注的图块数（页眉 logo 等版面杂物、拆开的子图） */
  figUncaptioned?: number
  /** 原文没有的多余标题数 */
  headingsExtra?: number
  headingLevelWrong?: number
  paraTotal?: number
  /** 原文较长段落中首尾不在同一块里的个数 */
  paraBroken?: number
  /** 原文独立公式数、转换出的公式块数（只比个数） */
  formulaSource?: number
  formulaConverted?: number
  deletedLeaked: number
  instrLeaked: number
}

const PDF_DIR = join(IMPORT_DATA_DIR, 'pdf')
const DOCX_DIR = join(IMPORT_DATA_DIR, 'docx')
const RUNS_DIR = join(IMPORT_DATA_DIR, 'runs')
const BUCKET = 'https://pmc-oa-opendata.s3.amazonaws.com'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const flag = (name: string) => process.argv.includes(name)
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d

/** PMC 开放获取数据集里这篇的最新版本号（PDF 与 XML 必须同一版本，否则更正过的地方会被误算成导入错误） */
async function latestVersion(id: string): Promise<number | null> {
  const res = await fetch(`${BUCKET}/?list-type=2&prefix=${id}.`, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) return null
  const keys = [...(await res.text()).matchAll(new RegExp(`<Key>${id}\\.(\\d+)/${id}\\.\\d+\\.pdf</Key>`, 'g'))].map(m => Number(m[1]))
  return keys.length ? Math.max(...keys) : null
}

async function fetchAll(ids: string[]): Promise<void> {
  mkdirSync(PDF_DIR, { recursive: true })
  for (const id of ids) {
    if (existsSync(join(PDF_DIR, `${id}.pdf`)) && existsSync(join(PDF_DIR, `${id}.xml`))) { console.log(`= ${id} 已下载`); continue }
    const v = await latestVersion(id)
    if (!v) { console.log(`✗ ${id} 开放获取数据集里没有 PDF`); process.exitCode = 1; continue }
    for (const ext of ['pdf', 'xml']) {
      const res = await fetch(`${BUCKET}/${id}.${v}/${id}.${v}.${ext}`, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`${id}.${v}.${ext} 下载失败：HTTP ${res.status}`)
      writeFileSync(join(PDF_DIR, `${id}.${ext}`), new Uint8Array(await res.arrayBuffer()))
    }
    console.log(`↓ ${id} v${v}`)
  }
}

/** 干净 docx：JATS → 平台文档 → HTML → LibreOffice 生成（缓存） */
function cleanDocx(id: string, xml: string): Uint8Array {
  const file = join(DOCX_DIR, `${id}.docx`)
  if (!existsSync(file)) {
    mkdirSync(DOCX_DIR, { recursive: true })
    const docs = new Documents(new Store(':memory:'))
    const doc = docs.get(docs.create({ owner: 'eval', title: id, markdown: jatsToMarkdown(xml).markdown }).id)
    writeFileSync(join(DOCX_DIR, `${id}.html`), `<!doctype html><html><head><meta charset="utf-8"></head><body>${renderHtml(doc, [], () => '')}</body></html>`)
    execFileSync('soffice', ['--headless', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', DOCX_DIR, join(DOCX_DIR, `${id}.html`)], { stdio: 'ignore', timeout: 180_000 })
  }
  return new Uint8Array(readFileSync(file))
}

/** 采纳修订后的正文文字（不含待删除的修订块） */
function acceptedText(doc: PMNode): string {
  let s = ''
  doc.descendants(n => {
    if (n.attrs?.suggest === 'delete') return false
    if (n.isTextblock) { s += ` ${n.textContent}`; return false }
    return true
  })
  return s
}

function measure(id: string, xml: string, doc: PMNode, t0: number): PaperResult {
  const fid = checkFidelityDoc(xml, doc)
  const d = fid.tables.detail
  const avg = (xs: number[]) => (xs.length ? round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) : null)
  const text = acceptedText(doc)
  return {
    id, ok: true, error: null, seconds: round((Date.now() - t0) / 1000),
    numbers: fid.numberCount,
    missingNumbers: fid.missingNumbers.reduce((a, x) => a + x.missing, 0),
    extraNumbers: fid.extraNumbers.reduce((a, x) => a + x.extra, 0),
    missingWordPct: round(fid.missingWordRatio * 100, 2),
    tablesSource: fid.tables.source, tablesConverted: fid.tables.converted, tablesDimsOk: d.filter(x => x.dimsOk).length,
    cellExact: avg(d.map(x => x.cellExact)), cellRecall: avg(d.map(x => x.cellRecall)),
    spanCells: d.reduce((a, x) => a + x.spanCells, 0), spanHit: d.reduce((a, x) => a + x.spanHit, 0), spanExtra: d.reduce((a, x) => a + x.spanExtra, 0),
    headingsMissing: fid.missingHeadings.length,
    titleOk: fid.structure.titleOk, figSource: fid.structure.figSource, figCaptioned: fid.structure.figCaptioned,
    figImages: fid.structure.figImages, figUncaptioned: fid.structure.figUncaptioned,
    headingsExtra: fid.structure.headingsExtra.length, headingLevelWrong: fid.structure.headingLevelWrong,
    paraTotal: fid.structure.paraTotal, paraBroken: fid.structure.paraBroken,
    formulaSource: fid.structure.formulaSource, formulaConverted: fid.structure.formulaConverted,
    deletedLeaked: text.includes(DELETED_MARK),
    instrLeaked: /\bADDIN\b|EN\.CITE|EN\.REFLIST|\bSEQ (?:Table|Figure)\b/.test(text),
  }
}

const failed = (id: string, error: string, t0: number): PaperResult => ({
  id, ok: false, error, seconds: round((Date.now() - t0) / 1000), numbers: 0, missingNumbers: 0, extraNumbers: 0, missingWordPct: 0,
  tablesSource: 0, tablesConverted: 0, tablesDimsOk: 0, cellExact: null, cellRecall: null, spanCells: 0, spanHit: 0, spanExtra: 0, headingsMissing: 0,
  titleOk: false, figSource: 0, figCaptioned: 0, figImages: 0, figUncaptioned: 0, headingsExtra: 0, headingLevelWrong: 0, paraTotal: 0, paraBroken: 0,
  formulaSource: 0, formulaConverted: 0, deletedLeaked: false, instrLeaked: false,
})

export async function runPath(path: ImportPath, ids: string[]): Promise<PaperResult[]> {
  const docParser = path === 'pdf-docling' ? new HttpDocParser(process.env.DOC_PARSER_URL ?? 'http://127.0.0.1:8005', { timeoutMs: 600_000 }) : null
  if (docParser && !(await docParser.ready())) throw new Error('doc-parser 服务未就绪（DOC_PARSER_URL）：先启动 apps/doc-parser，或只跑 --path pdf-poppler,docx-clean,docx-realistic')
  const out: PaperResult[] = []
  for (const id of ids) {
    const t0 = Date.now()
    const xmlFile = join(PDF_DIR, `${id}.xml`)
    if (!existsSync(xmlFile)) { out.push(failed(id, '缺标准答案，先运行 --fetch', t0)); continue }
    const xml = readFileSync(xmlFile, 'utf8')
    try {
      if (path === 'pdf-docling' || path === 'pdf-poppler') {
        const bytes = new Uint8Array(readFileSync(join(PDF_DIR, `${id}.pdf`)))
        const r = docParser ? await importPdf(bytes, `${id}.pdf`, { docParser }) : await importPdfPoppler(bytes, `${id}.pdf`, {})
        // 主路径悄悄退回兜底：记为失败，不把 poppler 的结果算进 Docling 的成绩
        if (docParser && r.engine !== 'docling') { out.push(failed(id, `退回了 poppler：${r.fallbackReason ?? ''}`, t0)); continue }
        out.push(measure(id, xml, r.doc, t0))
      } else {
        const clean = cleanDocx(id, xml)
        const bytes = path === 'docx-realistic' ? applyConstructs(clean).out : clean
        out.push(measure(id, xml, importDocx(bytes).doc, t0))
      }
    } catch (err) {
      out.push(failed(id, String((err as Error)?.message ?? err).slice(0, 300), t0))
    }
  }
  return out
}

export function summarize(rows: PaperResult[]): PathSummary {
  const ok = rows.filter(r => r.ok)
  const withTables = ok.filter(r => r.cellExact !== null)
  const sum = (f: (r: PaperResult) => number) => ok.reduce((a, r) => a + f(r), 0)
  return {
    papers: rows.length,
    failed: rows.length - ok.length,
    missingNumbers: sum(r => r.missingNumbers),
    extraNumbers: sum(r => r.extraNumbers),
    missingWordPct: ok.length ? round(sum(r => r.missingWordPct) / ok.length, 2) : 0,
    tablesSource: sum(r => r.tablesSource),
    tablesConverted: sum(r => r.tablesConverted),
    tablesDimsOk: sum(r => r.tablesDimsOk),
    cellExact: withTables.length ? round(withTables.reduce((a, r) => a + r.cellExact!, 0) / withTables.length) : null,
    cellRecall: withTables.length ? round(withTables.reduce((a, r) => a + r.cellRecall!, 0) / withTables.length) : null,
    spanCells: sum(r => r.spanCells),
    spanRecall: sum(r => r.spanCells) ? round((sum(r => r.spanHit) / sum(r => r.spanCells)) * 100) : null,
    spanExtra: sum(r => r.spanExtra),
    headingsMissing: sum(r => r.headingsMissing),
    titleOk: ok.filter(r => r.titleOk).length,
    figSource: sum(r => r.figSource),
    figCaptioned: sum(r => r.figCaptioned),
    figUncaptioned: sum(r => r.figUncaptioned),
    headingsExtra: sum(r => r.headingsExtra),
    headingLevelWrong: sum(r => r.headingLevelWrong),
    paraTotal: sum(r => r.paraTotal),
    paraBroken: sum(r => r.paraBroken),
    formulaSource: sum(r => r.formulaSource),
    formulaConverted: sum(r => r.formulaConverted),
    deletedLeaked: ok.filter(r => r.deletedLeaked).length,
    instrLeaked: ok.filter(r => r.instrLeaked).length,
  }
}

/**
 * 与基线对比：只报变差的指标。容差——计数类允许 +2%（至少 1 个）、比例类允许 -1 个百分点；
 * 失败篇数、修订泄漏、域指令泄漏不允许增加。
 */
export function regressions(now: PathSummary, base: PathSummary): string[] {
  const out: string[] = []
  // 基线里没有的指标（旧基线）不比
  const more = (k: keyof PathSummary, label: string, strict = false) => {
    if (base[k] == null) return
    const a = Number(now[k] ?? 0), b = Number(base[k])
    const tol = strict ? 0 : Math.max(1, Math.ceil(b * 0.02))
    if (a > b + tol) out.push(`${label} ${b} → ${a}`)
  }
  const fewer = (k: keyof PathSummary, label: string, strict = false) => {
    if (base[k] == null) return
    const a = Number(now[k] ?? 0), b = Number(base[k])
    const tol = strict ? 0 : Math.max(1, Math.ceil(b * 0.02))
    if (a < b - tol) out.push(`${label} ${b} → ${a}`)
  }
  const less = (k: keyof PathSummary, label: string) => {
    const a = now[k], b = base[k]
    if (typeof a === 'number' && typeof b === 'number' && a < b - 1) out.push(`${label} ${b} → ${a}`)
  }
  more('failed', '失败篇数', true)
  more('missingNumbers', '缺失数字')
  more('extraNumbers', '多出数字')
  more('headingsMissing', '缺失标题')
  more('spanExtra', '多出的合并覆盖格')
  more('deletedLeaked', '修订删除内容泄漏', true)
  more('instrLeaked', '域指令泄漏', true)
  fewer('titleOk', '标题认对的篇数', true)
  fewer('figCaptioned', '图注落位的图')
  more('figUncaptioned', '没有图注的图块')
  more('headingsExtra', '多余标题')
  more('headingLevelWrong', '层级不对的标题')
  more('paraBroken', '被截断的段落')
  fewer('formulaConverted', '转换出的公式块', true)
  less('tablesDimsOk', '行列对上的表格')
  less('cellExact', '单元格位置精确率')
  less('cellRecall', '单元格内容召回率')
  less('spanRecall', '合并单元格召回率')
  if (now.missingWordPct > base.missingWordPct + 0.2) out.push(`文字缺失率 ${base.missingWordPct}% → ${now.missingWordPct}%`)
  return out
}

const fmt = (s: PathSummary) =>
  `${s.papers - s.failed}/${s.papers} 篇 · 数字缺 ${s.missingNumbers} 多 ${s.extraNumbers} · 文字缺 ${s.missingWordPct}% · `
  + `表格 ${s.tablesDimsOk}/${s.tablesSource} 行列对上（识别 ${s.tablesConverted}）· 格精确 ${s.cellExact ?? '—'}% 格召回 ${s.cellRecall ?? '—'}% · `
  + `合并格 ${s.spanRecall ?? '—'}%（共 ${s.spanCells}，多 ${s.spanExtra}）· `
  + `缺标题 ${s.headingsMissing}\n  结构 · 标题认对 ${s.titleOk ?? '—'}/${s.papers - s.failed} 篇 · 图注落位 ${s.figCaptioned ?? '—'}/${s.figSource ?? '—'} · 无图注图块 ${s.figUncaptioned ?? '—'} · `
  + `多余标题 ${s.headingsExtra ?? '—'} · 层级不对 ${s.headingLevelWrong ?? '—'} · 段落截断 ${s.paraBroken ?? '—'}/${s.paraTotal ?? '—'} · 公式 ${s.formulaConverted ?? '—'}/${s.formulaSource ?? '—'}${s.deletedLeaked || s.instrLeaked ? ` · 修订泄漏 ${s.deletedLeaked} 域指令泄漏 ${s.instrLeaked}` : ''}`

/**
 * 评测集：
 * - main：深度审稿评测的 19 篇（规则主要对着它们调，基线 baseline.json）；
 * - extra：扩充集（eval/import/extra.json），覆盖别的出版社、中文期刊、作者稿件。
 *   其中 split=dev 的可以逐篇查看、据此改规则；split=holdout 只看汇总数字，用来检查规则有没有过拟合。基线 baseline-extra.json。
 */
interface ExtraPaper { id: string; journal: string; publisher: string; kind: string; split: 'dev' | 'holdout' }
export const EXTRA_MANIFEST = join(import.meta.dirname, '..', 'eval', 'import', 'extra.json')
function setIds(set: string, split?: string): string[] {
  if (set === 'main') return readManifest().map(p => p.id)
  if (set === 'extra') {
    const all = JSON.parse(readFileSync(EXTRA_MANIFEST, 'utf8')) as ExtraPaper[]
    return all.filter(p => !split || p.split === split).map(p => p.id)
  }
  throw new Error(`未知评测集 ${set}（可选 main / extra）`)
}

async function main(): Promise<void> {
  const only = arg('--only')?.split(',')
  const set = arg('--set') ?? 'main'
  const split = arg('--split')
  const ids = setIds(set, split).filter(id => !only || only.includes(id))
  const baselineFile = set === 'main' ? IMPORT_BASELINE : join(IMPORT_BASELINE, '..', `baseline-${set}.json`)
  // 只跑部分论文（--only / --split）时与全量基线不可比
  const partial = Boolean(only || split)
  if (flag('--fetch')) { await fetchAll(ids); return }
  const paths = (arg('--path')?.split(',') ?? [...PATHS]) as ImportPath[]
  for (const p of paths) if (!PATHS.includes(p)) throw new Error(`未知路径 ${p}（可选 ${PATHS.join(' / ')}）`)

  const baseline: Partial<Record<ImportPath, PathSummary>> = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {}
  const results: Partial<Record<ImportPath, { summary: PathSummary; papers: PaperResult[] }>> = {}
  const problems: string[] = []
  for (const p of paths) {
    const papers = await runPath(p, ids)
    const summary = summarize(papers)
    results[p] = { summary, papers }
    console.log(`\n## ${p}\n${fmt(summary)}`)
    for (const r of papers.filter(x => !x.ok)) console.log(`  ✗ ${r.id}：${r.error}`)
    const base = baseline[p]
    if (base && !partial) {
      const reg = regressions(summary, base)
      if (reg.length) { problems.push(...reg.map(x => `${p}：${x}`)); console.log(`  ⚠ 比基线变差：${reg.join('；')}`) }
      else console.log('  与基线相比没有变差')
    }
  }

  mkdirSync(RUNS_DIR, { recursive: true })
  const file = join(RUNS_DIR, `${set}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify(results, null, 2))
  console.log(`\n逐篇结果：${file}`)

  if (flag('--write-baseline')) {
    if (partial) throw new Error('只跑了部分论文，不能写基线')
    const next = { ...baseline }
    for (const p of paths) next[p] = results[p]!.summary
    mkdirSync(join(baselineFile, '..'), { recursive: true })
    writeFileSync(baselineFile, JSON.stringify(next, null, 2) + '\n')
    console.log(`已写入基线：${baselineFile}`)
  } else if (problems.length) {
    console.log(`\n比基线变差 ${problems.length} 项`)
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1 })
}
