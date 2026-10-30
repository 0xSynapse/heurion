/**
 * 参考资料库检索准确率评测：把一个目录里的 PDF 入库（内存库，不碰正式数据），
 * 用一组「问题 → 应命中的资料」比较 关键词 / 向量 / 混合（RRF）三种检索的 Hit@1、Hit@3、MRR。
 *
 *   EMBEDDING_URL=http://127.0.0.1:8003 tsx scripts/kb-eval.ts <pdf 目录> [queries.json]
 *
 * 基线语料：scripts/kb-eval-queries.json 里出现的 10 篇 PMC 论文（CC BY），PDF 从 PMC 开放数据取：
 *   https://pmc-oa-opendata.s3.amazonaws.com/metadata/<PMCID>.1.json 的 pdf_url（s3://pmc-oa-opendata/… 换成 https 地址），存成 <PMCID>.pdf。
 * queries.json：[{ "q": "问题", "file": "文件名前缀（如 PMC11161924）", "lang": "en" | "zh", "expect": ["正则", …] }]
 * expect（可选）：答案片段必须同时匹配的正则（不分大小写）；有它就再算「片段级」——第一个含答案的片段排第几。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpEmbedder } from '../src/kb/embedder.ts'
import { KbService } from '../src/kb/service.ts'
import { Store, type KbChunkHit } from '../src/store/db.ts'

const dir = process.argv[2]
if (!dir) { console.error('用法：tsx scripts/kb-eval.ts <pdf 目录> [queries.json]'); process.exit(2) }
const queries: Array<{ q: string; file: string; lang: string; expect?: string[] }> = JSON.parse(readFileSync(process.argv[3] ?? new URL('./kb-eval-queries.json', import.meta.url), 'utf8'))

const embedder = new HttpEmbedder(process.env.EMBEDDING_URL ?? 'http://127.0.0.1:8003')
if (!(await embedder.available())) { console.error('嵌入服务不可用'); process.exit(1) }
const store = new Store(':memory:')
const kb = new KbService(store, embedder)

let t0 = Date.now()
const names = new Map<string, string>()
for (const f of readdirSync(dir).filter(f => /\.(pdf|docx|pptx|txt|md)$/i.test(f)).sort()) {
  const { file } = await kb.upload('eval', { name: f, bytes: new Uint8Array(readFileSync(join(dir, f))) })
  names.set(file.id, f)
}
await kb.idle()
const files = store.listKbFiles('eval')
const chunks = files.reduce((n, f) => n + f.chunks, 0)
console.log(`入库 ${files.length} 份、${files.reduce((n, f) => n + f.pages, 0)} 页、${chunks} 块，向量化 ${files.reduce((n, f) => n + f.embedded, 0)} 块，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`)
for (const f of files.filter(f => f.status !== 'ready' || f.note)) console.log(`  ! ${f.name}: ${f.status} ${f.note ?? ''}`)

/** 命中列表按资料去重后，期望资料排第几（1 起；没出现为 0）。 */
const rankOf = (hits: KbChunkHit[], want: string) => {
  const order = [...new Set(hits.map(h => names.get(h.file_id)!))]
  return order.findIndex(n => n.startsWith(want)) + 1
}
type Mode = 'keyword' | 'vector' | 'hybrid'
const modes: Mode[] = ['keyword', 'vector', 'hybrid']
const ranks: Record<Mode, number[]> = { keyword: [], vector: [], hybrid: [] }
const passage: Record<Mode, number[]> = { keyword: [], vector: [], hybrid: [] }
/** 片段级：前 8 个片段里第一个同时匹配 expect 的排第几（没有为 0）。 */
const passageRank = (hits: KbChunkHit[], expect: string[]) =>
  hits.slice(0, 8).findIndex(h => h.text && names.get(h.file_id) && expect.every(p => new RegExp(p, 'i').test(h.text))) + 1
const misses: string[] = []
const pmiss: string[] = []
t0 = Date.now()
for (const { q, file, expect } of queries) {
  const [qv] = await embedder.embed([q])
  const got: Record<Mode, KbChunkHit[]> = {
    keyword: store.kbKeywordSearch('eval', q, 24),
    vector: store.kbVectorSearch('eval', qv!, 24),
    hybrid: await kb.search('eval', q, { limit: 8 }),
  }
  for (const m of modes) ranks[m].push(rankOf(got[m], file))
  if (expect) for (const m of modes) passage[m].push(passageRank(got[m], expect))
  if (expect && passageRank(got.hybrid, expect) !== 1) pmiss.push(`  [片段第 ${passageRank(got.hybrid, expect) || "—"} 名] ${q}\n      第一段：《${names.get(got.hybrid[0]?.file_id ?? "")}》第 ${got.hybrid[0]?.page} 页 ${got.hybrid[0]?.text.slice(0, 160).replace(/\s+/g, " ")}`)
  const r = rankOf(got.hybrid, file)
  if (r !== 1) misses.push(`  [混合第 ${r || '—'} 名] ${q}  → 应为 ${file}，第一名是 ${names.get(got.hybrid[0]?.file_id ?? '') ?? '（无结果）'}`)
}
const perQuery = (Date.now() - t0) / queries.length

const stat = (rs: number[]) => {
  const n = rs.length || 1
  return {
    'Hit@1': `${Math.round(rs.filter(r => r === 1).length / n * 100)}%`,
    'Hit@3': `${Math.round(rs.filter(r => r >= 1 && r <= 3).length / n * 100)}%`,
    MRR: (rs.reduce((s, r) => s + (r ? 1 / r : 0), 0) / n).toFixed(2),
  }
}
for (const lang of ['en', 'zh', 'all']) {
  const idx = queries.map((x, i) => (lang === 'all' || x.lang === lang ? i : -1)).filter(i => i >= 0)
  console.log(`\n${lang === 'en' ? '英文问题' : lang === 'zh' ? '中文问题（检索英文文献）' : '全部'}（${idx.length} 条）`)
  console.table(Object.fromEntries(modes.map(m => [m === 'keyword' ? '关键词' : m === 'vector' ? '向量' : '混合 RRF', stat(idx.map(i => ranks[m][i]!))])))
}
if (passage.hybrid.length > 0) {
  console.log(`\n片段级：第一个含答案的片段（${passage.hybrid.length} 条有标注答案的问题，看前 8 个片段）`)
  console.table(Object.fromEntries(modes.map(m => {
    const rs = passage[m]
    const n = rs.length
    return [m === 'keyword' ? '关键词' : m === 'vector' ? '向量' : '混合 RRF', {
      'Hit@1': `${Math.round(rs.filter(r => r === 1).length / n * 100)}%`,
      'Hit@3': `${Math.round(rs.filter(r => r >= 1 && r <= 3).length / n * 100)}%`,
      'Hit@8': `${Math.round(rs.filter(r => r >= 1).length / n * 100)}%`,
      MRR: (rs.reduce((s, r) => s + (r ? 1 / r : 0), 0) / n).toFixed(2),
    }]
  })))
}
if (pmiss.length) console.log(`\n片段级混合没排第一的：\n${pmiss.join("\n")}`)
console.log(`\n混合检索没排第一的：\n${misses.join('\n') || '  （无）'}`)
console.log(`\n平均每条检索 ${perQuery.toFixed(0)} ms（含问题向量化）`)
process.exit(0)
