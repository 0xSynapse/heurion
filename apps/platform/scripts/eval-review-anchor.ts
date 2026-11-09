/**
 * 审稿意见在原版 PDF 上的定位率（docs/design/PDF_ORIGINAL_VIEW.md §12）：
 * PDF 经 Docling 导入 → 规则版深度审稿（挂批注，不调模型）→ 按原版视图的画法统计每条批注：
 * - text：精确高亮到文字（按块的对齐，或在块的区域里按文字找到）；
 * - block：只能框整块；
 * - none：原版上画不出来（块没有映射）。
 *
 * 用法：DOC_PARSER_URL=http://127.0.0.1:8005 npx tsx scripts/eval-review-anchor.ts [--set main|extra] [--only id,id]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaimService } from '../src/claims/service.ts'
import { HttpDocParser } from '../src/convert/doc-parser.ts'
import { bindAssets } from '../src/convert/docx-import.ts'
import { importPdf } from '../src/convert/pdf-import.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { locate, threadMarks } from '../src/model/anchors.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'
import { findQuoteWords, type Word } from '../web/src/quote-match.ts'
import { IMPORT_DATA_DIR, readManifest } from './eval-review-paths.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }

export function evalIds(set: string): string[] {
  if (set === 'main') return readManifest().map(p => p.id)
  if (set === 'extra') return (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'eval', 'import', 'extra.json'), 'utf8')) as Array<{ id: string }>).map(p => p.id)
  throw new Error(`未知评测集 ${set}（可选 main / extra）`)
}

interface MapNode { text?: string; spans?: number[][]; regions?: number[][] }

/** 与 web/src/original.ts 的 drawHighlights 同一画法 */
function placement(map: { words: Word[]; nodes: Record<string, MapNode> }, c: { node_id: string; snippet?: string }, anchor: { located?: boolean; node_ids?: string[]; text?: string }): 'text' | 'block' | 'none' {
  const ids = anchor.node_ids ?? []
  const n = map.nodes[ids.length === 1 ? ids[0]! : c.node_id] ?? map.nodes[c.node_id]
  if (!n) return 'none'
  const quote = (anchor.text ?? c.snippet ?? '').trim()
  if (quote && n.text && n.text.includes(quote) && n.spans) return 'text'
  const hit = [c.snippet, anchor.text].map(q => (q ?? '').trim()).filter(q => q && q.length < 400)
    .some(q => findQuoteWords(map.words, n.regions ?? [], q))
  return hit ? 'text' : 'block'
}

async function main(): Promise<void> {
  const url = process.env.DOC_PARSER_URL
  if (!url) throw new Error('需要 DOC_PARSER_URL')
  const dp = new HttpDocParser(url, { timeoutMs: 600_000 })
  const only = arg('--only')?.split(',')
  const ids = evalIds(arg('--set') ?? 'main').filter(id => !only || only.includes(id))
  const tot = { text: 0, block: 0, none: 0, notLocated: 0 }
  for (const id of ids) {
    const r = await importPdf(new Uint8Array(readFileSync(join(IMPORT_DATA_DIR, 'pdf', `${id}.pdf`))), `${id}.pdf`, { docParser: dp })
    if (!r.sourceMap) { console.log(id, '没有原版映射（未走 Docling）'); continue }
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const assetIds = new Map(r.assets.map(a => [a.key, store.putAsset({ owner: 'eval', mime: a.mime, name: a.name, bytes: a.bytes }).id]))
    const row = docs.create({ owner: 'eval', title: id, content: bindAssets(r.doc, assetIds) })
    await new ClaimService(docs, {} as PubMedClient).runFourStageDeepReview(row.id, { mode: 'heurion_evolved', owner: 'eval', anchorComments: true, assessTables: true })
    const doc = docs.get(row.id)
    const marks = threadMarks(doc)
    const one = { text: 0, block: 0, none: 0, notLocated: 0 }
    for (const c of store.listComments(row.id)) {
      const a = locate(doc, c, marks)
      const k = a.located === false ? 'notLocated' : placement(r.sourceMap as never, c, a)
      one[k]++
      tot[k]++
    }
    console.log(id, one)
  }
  const all = tot.text + tot.block + tot.none + tot.notLocated
  console.log(`\n共 ${all} 条意见：精确到文字 ${tot.text}（${all ? ((tot.text / all) * 100).toFixed(1) : '—'}%）· 框整块 ${tot.block} · 原版上画不出 ${tot.none} · 正文里没定位到 ${tot.notLocated}`)
}

if (process.argv[1]?.endsWith('eval-review-anchor.ts')) await main()
