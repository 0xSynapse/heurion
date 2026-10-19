/**
 * 判定复核（ANALYSIS_PLAN §6）：按组分层随机抽取回合，生成复核条目（不含组别），供复核页面导入。
 *   cd apps/platform && npx tsx ../../paper/benchmarks/exp3/audit.ts <结果目录> --rate 0.1 --seed 7 --out <目录>
 * 每个条目：任务指令、人类布置说明、程序判定与理由、本回合前后有变化的块（完整文字）、AI 的最后回复、工具报错。
 * 读的是平台数据库的副本（不改动原始数据）。组别与用户另存在 key.json，复核结束后再对回。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Documents } from '../../../apps/platform/src/model/runtime.ts'
import { Store } from '../../../apps/platform/src/store/db.ts'
import type { TurnRow } from './run.ts'

const SETUP: Record<string, string> = {
  concurrent_edit: '医生在 AI 每次读稿后，于讨论第一段末尾插入「(see Supplementary Table S2)」并逐次追加表号（最多 3 次）。判定：医生最后一次插入的内容是否保留。',
  citation: '无人类操作。判定：正文没有新增裸 DOI / PMID，且至少使用了一条平台登记的引用。',
  pending_suggestion: '医生事先在结果第一段留了一条待采纳的修订（追加「(intention-to-treat population)」）。判定：这条修订是否仍处于待采纳状态。',
  open_comment_anchor: '医生事先在方法某小节第一段挂了两条批注。判定：该段被改写，且每条批注的锚点仍在、或 AI 在批注线程里作了说明。',
  term_unify: '无人类操作。判定：方法部分正文不再有 patients，participants 的数量不少于原 patients 的数量。',
  table_row: '无人类操作。判定：新行紧接在指定行之后，其余各列为 NR。',
  out_of_scope_revert: '无人类操作；回合结束后，若 AI 改动了指定段落以外的块，脚本模拟医生撤销整轮。判定：没有改动范围外的块。',
  p_value_format: '无人类操作。判定：结果部分正文中所有 P 值符合指令要求的格式，且数量不少于原来。',
  move_subsection: '无人类操作。判定：指定的小节或段落排在结果部分最后，结果部分原有段落文字都在。',
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { rate: { type: 'string', default: '0.1' }, seed: { type: 'string', default: '7' }, out: { type: 'string' }, data: { type: 'string' } } })
const dir = positionals[0]!
const dataRoot = values.data ?? join(new URL('.', import.meta.url).pathname, 'data')
const run = dir.replace(/\/$/, '').split('/').pop()!
const out = values.out ?? join(dir, 'audit')
mkdirSync(out, { recursive: true })

let a = Number(values.seed) >>> 0
const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

const items: unknown[] = []
const key: Record<string, { arm: string; user: string; session: number; turn_id: string | null }> = {}
for (const arm of ['off', 'frozen', 'utility']) {
  let rows: TurnRow[]
  try { rows = readFileSync(join(dir, `turns-${arm}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { continue }
  rows = rows.filter(r => r.status === 'done' && r.doc_id)
  const n = Math.max(1, Math.round(rows.length * Number(values.rate)))
  const pick = [...rows].map(r => ({ r, k: rand() })).sort((x, y) => x.k - y.k).slice(0, n).map(x => x.r)
  // 数据库副本：只读用途，避免碰原始数据
  const copy = join(tmpdir(), `audit-${run}-${arm}.db`)
  copyFileSync(join(dataRoot, run, arm, 'platform', 'platform.db'), copy)
  const store = new Store(copy)
  const docs = new Documents(store)
  for (const r of pick) {
    const versions = store.listVersions(r.doc_id) as Array<{ seq: number }>
    const first = Math.min(...versions.map(v => v.seq))
    const before = docs.versionDoc(r.doc_id, first)
    const after = docs.get(r.doc_id)
    const text = (doc: typeof after) => {
      const m = new Map<string, string>()
      doc.forEach(n => { if (n.attrs.id) m.set(n.attrs.id as string, n.textContent) })
      return m
    }
    const b = before ? text(before) : new Map<string, string>()
    const af = text(after)
    const changes = [...new Set([...b.keys(), ...af.keys()])].filter(id => b.get(id) !== af.get(id)).map(id => ({ before: b.get(id) ?? null, after: af.get(id) ?? null }))
    const messages = store.listMessages(r.doc_id) as Array<{ role: string; text?: string; content?: string }>
    const reply = [...messages].reverse().find(m => m.role === 'assistant')
    const id = `a${String(items.length + 1).padStart(3, '0')}`
    key[id] = { arm, user: r.user, session: r.session, turn_id: r.turn_id }
    items.push({
      id, order: items.length + 1, archetype: r.archetype, topic: r.topic,
      instruction: (messages.find(m => m.role === 'user')?.text ?? messages.find(m => m.role === 'user')?.content ?? '').replace(/^（[^）]*）/, ''),
      setup: SETUP[r.archetype] ?? '',
      verdict: r.success ? 'pass' : 'fail', reason: r.detail || (r.success ? '程序判定通过' : ''),
      reverted: r.reverted, errors: r.errors, changes, reply: (reply?.text ?? reply?.content ?? '').slice(0, 3000),
    })
  }
  store.db.close()
}
// 打乱顺序，复核时看不出组别
const shuffled = items.map(x => ({ x, k: rand() })).sort((p, q) => p.k - q.k).map((p, i) => ({ ...(p.x as object), order: i + 1 }))
writeFileSync(join(out, 'items.json'), JSON.stringify(shuffled, null, 1))
writeFileSync(join(out, 'key.json'), JSON.stringify(key, null, 1))
console.log(`抽取 ${shuffled.length} 个回合 → ${out}/items.json（组别对照在 key.json）`)
