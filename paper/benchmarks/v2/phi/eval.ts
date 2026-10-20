/**
 * v2 PHI 评测（ANALYSIS_PLAN_v2 §3）：在 gen_corpus.ts 生成的模拟语料上比较四种方案。
 *   cd apps/platform && npx tsx --env-file-if-exists=../../.env ../../paper/benchmarks/v2/phi/eval.ts --split dev
 * 方案：A 只用第一阶段规则；B 第一阶段 + 本地小模型 + 后置校验（平台方案）；C 小模型不加后置校验；
 * D 不用小模型、规则穷举候选 + 同一后置校验。小模型为本地 Ollama 上的 qwen2.5:1.5b（127.0.0.1:11434）。
 * 测试集只在后置校验规则冻结后运行一次：需加 --confirm-test，运行后写锁文件，再次运行会被拒绝。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  createLocalSlmPhiDetector,
  normalizeAndValidateStage2Entity,
  type PhiFinding,
  type PhiSemanticFallbackDetector,
  redactPhi,
  redactPhiCascaded,
  scanPhi,
} from '../../../../apps/platform/src/ops/phi-scan.ts'
import type { Note } from './gen_corpus.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const RESULTS = join(here, '../../../results/v2-phi')
const { values } = parseArgs({ options: { split: { type: 'string', default: 'dev' }, 'confirm-test': { type: 'boolean', default: false } } })
const split = values.split!
if (split !== 'dev' && split !== 'test') throw new Error('--split 只能是 dev 或 test')
const lock = join(RESULTS, 'TEST_RUN.lock')
if (split === 'test') {
  if (!values['confirm-test']) throw new Error('测试集只运行一次：确认规则已冻结后加 --confirm-test')
  if (existsSync(lock)) throw new Error(`测试集已经运行过（${readFileSync(lock, 'utf8').trim()}），不再重复运行`)
}
const notes = JSON.parse(readFileSync(join(here, 'corpus', `${split}.json`), 'utf8')) as Note[]

// —— 四种方案 ——

const ADDRESS_CANDIDATE_RE = /[一-龥A-Za-z0-9]{4,40}(?:室|号|栋|单元|楼|座|大厦|广场|小学|中学|大学|学院|公司|厂|局|所)/g
/** 方案 D：不用小模型，规则穷举候选（常见姓氏开头的 2–3 字串、以地址标记结尾的片段），同一后置校验（与 run_eval.ts 相同）。 */
const ruleOnly: PhiSemanticFallbackDetector = async text => {
  const found: Array<{ value: string; type: 'unlabeled_person_name' | 'address_or_org' }> = []
  const seen = new Set<string>()
  const keep = (raw: string, type: 'unlabeled_person_name' | 'address_or_org') => {
    const v = normalizeAndValidateStage2Entity(raw, type, text)
    if (v && !seen.has(v.value)) { seen.add(v.value); found.push({ value: v.value, type: v.type === 'address_or_org' ? 'address_or_org' : 'unlabeled_person_name' }) }
  }
  for (const m of text.matchAll(ADDRESS_CANDIDATE_RE)) keep(m[0], 'address_or_org')
  for (let i = 0; i < text.length; i++) {
    for (let len = 3; len >= 2; len--) {
      const sub = text.slice(i, i + len)
      if (sub.length === len && /^[一-龥]+$/.test(sub)) keep(sub, 'unlabeled_person_name')
    }
  }
  return found
}

type Method = { key: string; label: string; run: (text: string) => Promise<{ redacted: string; findings: PhiFinding[] }> }
const slm = createLocalSlmPhiDetector({ model: 'qwen2.5:1.5b', timeoutMs: 60_000 })
const slmRaw = createLocalSlmPhiDetector({ model: 'qwen2.5:1.5b', timeoutMs: 60_000, postValidate: false })
const METHODS: Method[] = [
  { key: 'A_stage1', label: '只用第一阶段规则', run: async t => ({ redacted: redactPhi(t), findings: scanPhi(t) }) },
  { key: 'B_platform', label: '第一阶段 + 小模型 + 后置校验（平台方案）', run: t => redactPhiCascaded(t, slm) },
  { key: 'C_slm_unvalidated', label: '第一阶段 + 小模型，不加后置校验', run: t => redactPhiCascaded(t, slmRaw) },
  { key: 'D_rules_only', label: '第一阶段 + 规则穷举候选 + 后置校验', run: t => redactPhiCascaded(t, ruleOnly) },
]

// —— 统计 ——

/** Wilson 95% 置信区间（百分比）。 */
function wilson(k: number, n: number): [number, number] | null {
  if (n === 0) return null
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Number(((c - h) * 100).toFixed(1)), Number(((c + h) * 100).toFixed(1))]
}
const rate = (k: number, n: number) => ({ k, n, pct: n ? Number(((k / n) * 100).toFixed(1)) : null, ci95: wilson(k, n) })

async function pool<T, R>(xs: T[], f: (x: T) => Promise<R>, n = 4): Promise<R[]> {
  const out: R[] = new Array(xs.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => { while (next < xs.length) { const i = next++; out[i] = await f(xs[i]!) } }))
  return out
}

// 小模型先预热一次
await slm('查房记录：王某今日复查。')

const positives = notes.filter(n => n.kind === 'positive')
const negatives = notes.filter(n => n.kind === 'negative')
const results: Record<string, unknown> = {}
for (const m of METHODS) {
  const t0 = Date.now()
  const pos = await pool(positives, n => m.run(n.text))
  const neg = await pool(negatives, n => m.run(n.text))
  // 召回（严格口径）：目标原文在脱敏输出里已不存在；按类型 × 是否带字段标签分组
  const recall: Record<string, { k: number; n: number }> = {}
  const add = (key: string, hit: boolean) => { const r = (recall[key] ??= { k: 0, n: 0 }); r.n++; if (hit) r.k++ }
  let tp = 0
  let fp = 0
  positives.forEach((note, i) => {
    for (const s of note.spans) {
      const hit = !pos[i]!.redacted.includes(s.value)
      add(`${s.type}·${s.labeled ? '标签' : '叙述'}`, hit)
      add(s.labeled ? '合计·标签' : '合计·叙述', hit)
      add('合计', hit)
    }
    // 准确率：每个识别结果与某个真实实体重叠（互为子串）算对
    for (const f of pos[i]!.findings) {
      if (note.spans.some(s => s.value.includes(f.value) || f.value.includes(s.value))) tp++
      else fp++
    }
  })
  const negHits = neg.filter(r => r.findings.length > 0).length
  for (const r of neg) fp += r.findings.length
  results[m.key] = {
    label: m.label,
    seconds: Math.round((Date.now() - t0) / 1000),
    recall: Object.fromEntries(Object.entries(recall).sort().map(([k, v]) => [k, rate(v.k, v.n)])),
    precision: rate(tp, tp + fp),
    negative_sentence_fp: rate(negHits, negatives.length),
  }
  console.log(`${m.key} 完成（${Math.round((Date.now() - t0) / 1000)} 秒）`)
}

mkdirSync(RESULTS, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = { split, evaluated_at: new Date().toISOString(), notes: positives.length, negatives: negatives.length, slm: 'qwen2.5:1.5b (Ollama, 127.0.0.1)', results }
writeFileSync(join(RESULTS, `${stamp}-${split}.json`), JSON.stringify(out, null, 1))

// 简要汇总
const fmt = (r: { k: number; n: number; pct: number | null; ci95: [number, number] | null }) => (r.n ? `${r.k}/${r.n}（${r.pct}%，${r.ci95![0]}–${r.ci95![1]}）` : '—')
const keys = [...new Set(Object.values(results).flatMap(r => Object.keys((r as { recall: object }).recall)))]
const lines = [
  `# PHI 评测（${split}）`, '',
  `${positives.length} 篇含身份信息的文本，${negatives.length} 句阴性句子；召回为严格口径（目标原文在输出里已不存在），括号内为 Wilson 95% 置信区间。`, '',
  `| 指标 | ${METHODS.map(m => m.key).join(' | ')} |`,
  `| --- | ${METHODS.map(() => '---').join(' | ')} |`,
  ...keys.map(k => `| 召回：${k} | ${METHODS.map(m => { const r = (results[m.key] as { recall: Record<string, Parameters<typeof fmt>[0]> }).recall[k]; return r ? fmt(r) : '—' }).join(' | ')} |`),
  `| 准确率（识别结果） | ${METHODS.map(m => fmt((results[m.key] as { precision: Parameters<typeof fmt>[0] }).precision)).join(' | ')} |`,
  `| 阴性句误报 | ${METHODS.map(m => fmt((results[m.key] as { negative_sentence_fp: Parameters<typeof fmt>[0] }).negative_sentence_fp)).join(' | ')} |`,
  '', ...METHODS.map(m => `- ${m.key}：${m.label}`),
]
writeFileSync(join(RESULTS, `${stamp}-${split}.md`), lines.join('\n') + '\n')
if (split === 'test') writeFileSync(lock, `${stamp}\n`)
console.log(lines.join('\n'))
