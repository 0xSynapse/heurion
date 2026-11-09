/**
 * 深度审稿评测：对语料逐篇跑产品同款深度审稿（heurion_evolved，挂批注），记录报出问题、token 与耗时。
 *   pnpm --filter @heurion2/platform eval:review:run                     开发集，干净版 + 植入版，各跑 2 次
 *   … eval:review:run --split test --repeat 1 --only PMC123 --no-llm     --no-llm 只跑规则检查（不需要模型密钥）
 * 每篇都在全新的内存库里跑（没有任何审稿偏好记忆），等同新用户首次使用。
 * 结果写入 data/eval/deep-review/runs/<run_id>/（不进 git）；评分见 eval-review-score.ts。
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../src/config.ts'
import { ClaimService, type SynthesizedReviewComment } from '../src/claims/service.ts'
import { makeComplete, type CompleteUsage } from '../src/harness/complete.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'
import { DATA_DIR, MD_DIR, readManifest, type Split } from './eval-review-fetch.ts'

export type Variant = 'clean' | 'injected'

export interface RunFinding {
  finding_key: string
  severity: 'critical' | 'major' | 'minor'
  category: string
  subtype: string | null
  source_pass: string
  section_title: string | null
  sentence: string
  /** 批注最终挂上的原文（用户在正文里看到高亮的那段） */
  anchor: string
  reason: string
  suggestion: string
  /** 模型审稿给的对照原文（已核实在稿件里） */
  evidence?: string[]
}

export interface RunRecord {
  run_id: string
  paper_id: string
  variant: Variant
  repeat: number
  ok: boolean
  error: string | null
  ms: number
  calls: number
  input_tokens: number
  output_tokens: number
  raw_candidates: number
  findings: RunFinding[]
}

/** 同一问题跨次运行、跨干净 / 植入版的稳定键：类型 + 子类型 + 原句（去空白、小写、去 markdown 转义） */
export const normText = (s: string) => s.replace(/\\([\\`*_#>|^<[\]-])/g, '$1').replace(/\s+/g, ' ').trim().toLowerCase()
export const findingKey = (f: { category: string; subtype?: string | null; sentence: string }) =>
  createHash('sha1').update(`${f.category}|${f.subtype ?? ''}|${normText(f.sentence).slice(0, 160)}`).digest('hex').slice(0, 12)

export const RUNS_DIR = join(DATA_DIR, 'runs')

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const flag = (name: string) => process.argv.includes(name)

function gitSha(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() ? '-dirty' : ''
    return sha + dirty
  } catch { return 'nogit' }
}

async function reviewOnce(markdown: string, title: string, useLlm: boolean): Promise<Omit<RunRecord, 'run_id' | 'paper_id' | 'variant' | 'repeat'>> {
  const usage: CompleteUsage[] = []
  const complete = useLlm
    ? makeComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.model, onUsage: u => usage.push(u) })
    : null
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const row = docs.create({ owner: 'eval', title, markdown })
  const t0 = Date.now()
  try {
    const r = await new ClaimService(docs, {} as PubMedClient).runFourStageDeepReview(row.id, {
      mode: 'heurion_evolved',
      owner: 'eval',
      anchorComments: true,
      ...(complete ? { complete } : {}),
    })
    const comments = new Map(store.listComments(row.id).map((c: { id: string; snippet: string }) => [c.id, c.snippet]))
    const findings = r.stage4_deduplicated_comments.map((c: SynthesizedReviewComment): RunFinding => ({
      finding_key: findingKey(c),
      severity: c.severity,
      category: c.category,
      subtype: c.subtype ?? null,
      source_pass: c.source_pass,
      section_title: c.section_title ?? null,
      sentence: c.sentence,
      anchor: (c.comment_id ? comments.get(c.comment_id) : undefined) ?? c.snippet,
      reason: c.reason,
      suggestion: c.suggestion,
      ...(c.evidence?.length ? { evidence: c.evidence } : {}),
    }))
    return {
      ok: true, error: null, ms: Date.now() - t0, calls: usage.length,
      input_tokens: usage.reduce((a, u) => a + u.input_tokens, 0),
      output_tokens: usage.reduce((a, u) => a + u.output_tokens, 0),
      raw_candidates: r.stage3_raw_candidates, findings,
    }
  } catch (err) {
    return {
      ok: false, error: String((err as Error)?.message ?? err).slice(0, 500), ms: Date.now() - t0, calls: usage.length,
      input_tokens: usage.reduce((a, u) => a + u.input_tokens, 0),
      output_tokens: usage.reduce((a, u) => a + u.output_tokens, 0),
      raw_candidates: 0, findings: [],
    }
  }
}

async function main(): Promise<void> {
  const useLlm = !flag('--no-llm')
  if (useLlm && !config.deepseekApiKey) throw new Error('缺少 DEEPSEEK_API_KEY：在仓库根目录 .env 里配置，或加 --no-llm 只跑规则检查')
  const split = (arg('--split') ?? 'dev') as Split | 'all'
  const repeat = Math.max(1, Number(arg('--repeat') ?? (useLlm ? 2 : 1)))
  const variants = (arg('--variants') ?? 'clean,injected').split(',') as Variant[]
  const only = arg('--only')?.split(',')
  const papers = readManifest().filter(p => (split === 'all' || p.split === split) && (!only || only.includes(p.id)))
  if (!papers.length) throw new Error('没有符合条件的论文；先运行 eval:review:fetch')

  // --tag：同一代码版本跑几种配置（如改动前后对比）时区分运行
  const runId = `${new Date().toISOString().slice(0, 10)}-${gitSha()}-${useLlm ? config.model : 'rules'}${arg('--tag') ? `-${arg('--tag')}` : ''}`
  const dir = join(RUNS_DIR, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ run_id: runId, model: useLlm ? config.model : null, mode: 'heurion_evolved', split, repeat, variants, started_at: new Date().toISOString() }, null, 2))

  for (const p of papers) {
    for (const variant of variants) {
      const file = join(MD_DIR, variant === 'clean' ? `${p.id}.md` : `${p.id}.injected.md`)
      if (!existsSync(file)) { if (variant === 'clean') console.log(`- ${p.id} 缺稿件，先运行 eval:review:fetch`); continue }
      const markdown = readFileSync(file, 'utf8')
      for (let n = 1; n <= repeat; n++) {
        const out = join(dir, `${p.id}.${variant}.r${n}.json`)
        if (existsSync(out)) continue // 中断后续跑
        const rec: RunRecord = { run_id: runId, paper_id: p.id, variant, repeat: n, ...(await reviewOnce(markdown, p.title, useLlm)) }
        writeFileSync(out, JSON.stringify(rec, null, 2))
        const sev = (s: string) => rec.findings.filter(f => f.severity === s).length
        console.log(`${rec.ok ? '✓' : '✗'} ${p.id} ${variant} r${n} · ${sev('critical')}/${sev('major')}/${sev('minor')}（致命/重要/次要）· ${rec.calls} 次调用 · ${rec.input_tokens}+${rec.output_tokens} token · ${(rec.ms / 1000).toFixed(1)}s${rec.error ? ` · ${rec.error}` : ''}`)
      }
    }
  }
  console.log(`\n结果：${dir}\n评分：pnpm --filter @heurion2/platform eval:review:score --run ${runId}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1 })
}
