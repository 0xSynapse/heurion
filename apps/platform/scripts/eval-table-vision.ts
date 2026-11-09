/**
 * 按页面图像核对表格的效果（docs/design/PDF_ORIGINAL_VIEW.md §12.3）：同一批表格，Docling 转换结果与图像模型抄出的网格，
 * 分别和 JATS 原表比（与导入评测同一套比对：行列对上的张数、单元格精确率），外加抄出的数字在文字层里的比例、与转换结果一致的张数。
 *
 * 会把表格区域的截图发给 DEEPSEEK_UPSTREAM_URL（评测论文都是开放获取的 PMC 论文）。
 * 用法：DEEPSEEK_API_KEY=… DOC_PARSER_URL=http://127.0.0.1:8005 npx tsx scripts/eval-table-vision.ts [--set main|extra] [--only id,id] [--model deepseek-flash]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { gridsAgree, numbersFaithful, parseGrid } from '../src/claims/table-vision.ts'
import { HttpDocParser } from '../src/convert/doc-parser.ts'
import { importPdf } from '../src/convert/pdf-import.ts'
import { tableSourceProvider } from '../src/convert/pdf-crop.ts'
import { makeVisionComplete, VISION_MODELS } from '../src/harness/complete.ts'
import { Documents } from '../src/model/runtime.ts'
import { readGrid } from '../src/model/table-grid.ts'
import { Store } from '../src/store/db.ts'
import { checkFidelityDoc } from './eval-jats-check.ts'
import { evalIds } from './eval-review-anchor.ts'
import { IMPORT_DATA_DIR } from './eval-review-paths.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

// 与 claims/table-vision.ts 的转录要求相同（这里单独调用，拿到原始网格做比对）
const SYSTEM =
  '你是表格转录员。把图片里的表格逐格抄成 JSON，只输出 JSON：{"header_rows": <表头行数>, "rows": [["格", "格", …], …]}。' +
  '规则：逐字照抄（数字、符号、上下标、括号、正负号原样保留，上标写成 ^x），不翻译、不计算、不补全、不改正；' +
  '每一行的格数相同；合并单元格的文字只写在左上那一格，被它覆盖的格写空字符串；' +
  '表题、表注、脚注不算表格，不要抄；有几张图时它们是同一张表的连续几页，按顺序接起来，续页重复的表头只保留一次。'

const md = (grid: string[][]) => {
  const w = Math.max(...grid.map(r => r.length))
  const cell = (s: string) => (s || ' ').replace(/\|/g, '\\|').replace(/\^/g, '')
  const row = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => cell(r[i] ?? '')).join(' | ')} |`
  return [row(grid[0]!), `|${' --- |'.repeat(w)}`, ...grid.slice(1).map(row)].join('\n')
}

async function main(): Promise<void> {
  const key = process.env.DEEPSEEK_API_KEY ?? ''
  const url = process.env.DOC_PARSER_URL
  if (!key || !url) throw new Error('需要 DEEPSEEK_API_KEY 与 DOC_PARSER_URL')
  const model = arg('--model') ?? process.env.REVIEW_VISION_MODEL ?? 'deepseek-flash'
  VISION_MODELS.add(model)
  const vision = makeVisionComplete({ upstream: process.env.DEEPSEEK_UPSTREAM_URL ?? 'https://api.deepseek.com/anthropic/v1', apiKey: key, model, timeoutMs: 120_000 })!
  const dp = new HttpDocParser(url, { timeoutMs: 600_000 })
  const only = arg('--only')?.split(',')
  const ids = evalIds(arg('--set') ?? 'main').filter(id => !only || only.includes(id))
  const tot = { tables: 0, read: 0, faithful: 0, agree: 0, doclingDims: 0, visionDims: 0, doclingExact: 0, visionExact: 0, matched: 0 }
  for (const id of ids) {
    const pdf = new Uint8Array(readFileSync(join(IMPORT_DATA_DIR, 'pdf', `${id}.pdf`)))
    const xml = readFileSync(join(IMPORT_DATA_DIR, 'pdf', `${id}.xml`), 'utf8')
    const r = await importPdf(pdf, `${id}.pdf`, { docParser: dp })
    if (!r.sourceMap) { console.log(id, '没有原版映射（未走 Docling）'); continue }
    const source = tableSourceProvider(pdf, gzipSync(Buffer.from(JSON.stringify(r.sourceMap))))
    const docling: string[][][] = []
    const ids2: string[] = []
    r.doc.descendants(n => {
      if (n.type.name !== 'table') return true
      const g = readGrid(n)
      docling.push(Array.from({ length: g.height }, (_, rr) => Array.from({ length: g.width }, (_, c) => { const x = g.at(rr, c); return x && x.top === rr && x.left === c ? x.node.textContent : '' })))
      ids2.push(n.attrs.id as string)
      return false
    })
    // 图像抄出的表（抄不出来的用 Docling 的顶上，比对时两边就一样）
    const visionGrids: string[][][] = []
    for (const [k, tid] of ids2.entries()) {
      tot.tables++
      const src = await source(tid)
      let grid = docling[k]!
      if (src) {
        try {
          const parsed = parseGrid(await vision(SYSTEM, '请抄出这张表。', src.images))
          if (parsed) {
            tot.read++
            const f = numbersFaithful(parsed.rows, src.words)
            if (f >= 0.98) tot.faithful++
            if (gridsAgree(docling[k]!.filter(row => row.some(Boolean)), parsed.rows, Math.max(1, parsed.headerRows))) tot.agree++
            grid = parsed.rows
          }
        } catch (err) {
          console.log(id, tid, '调用失败', (err as Error).message.slice(0, 120))
        }
      }
      visionGrids.push(grid)
    }
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const score = (grids: string[][][]) => checkFidelityDoc(xml, docs.get(docs.create({ owner: 'eval', title: id, markdown: grids.map(md).join('\n\n') }).id)).tables.detail
    const a = checkFidelityDoc(xml, r.doc).tables.detail
    const b = score(visionGrids)
    for (const [k, d] of a.entries()) {
      const v = b[k]
      if (!d.found || !v?.found) continue
      tot.matched++
      tot.doclingDims += Number(d.dimsOk)
      tot.visionDims += Number(v.dimsOk)
      tot.doclingExact += d.cellExact
      tot.visionExact += v.cellExact
    }
    console.log(id, `表 ${ids2.length}`, 'Docling', a.map(d => `${d.dimsOk ? '✓' : '✗'}${(d.cellExact * 100).toFixed(0)}`).join(' '), '| 图像', b.map(d => `${d.dimsOk ? '✓' : '✗'}${(d.cellExact * 100).toFixed(0)}`).join(' '))
  }
  const pct = (x: number, n: number) => (n ? `${((x / n) * 100).toFixed(1)}%` : '—')
  console.log(`\n共 ${tot.tables} 张表：抄出 ${tot.read}，数字都在文字层里 ${tot.faithful}（${pct(tot.faithful, tot.read)}），与 Docling 一致 ${tot.agree}`)
  console.log(`与 JATS 原表对上 ${tot.matched} 张：行列对上 Docling ${tot.doclingDims} / 图像 ${tot.visionDims}；单元格精确率 Docling ${pct(tot.doclingExact, tot.matched)} / 图像 ${pct(tot.visionExact, tot.matched)}`)
}

await main()
