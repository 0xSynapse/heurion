/**
 * v2 第一阶段问题一（ANALYSIS_PLAN_v2 §2）：MCP 结构化编辑（P）vs 直接写脚本改 Word（B1 基础、B2 强化）。
 * 日常任务（v1 的 9 类，新种子）与压力任务（S1 复杂模板、S2 真实并发、S3 文献补充）；三组从同一份 .docx 出发，
 * 改完都落成 .docx，用同一套综合判定（oracles.ts）。所有组用同一模型（DSH_MODEL，默认 deepseek-flash）。
 *   cd apps/platform && npx tsx --env-file-if-exists=../../.env ../../paper/benchmarks/v2/compare.ts \
 *     [--arms P,B1,B2] [--set natural,stress] [--seeds 301,302,303] [--only S2-rewrite,...] [--per-task N] [--limit N] [--parallel 3] [--port 8870] [--tag pilot]
 * 需要 .env 的 DEEPSEEK_API_KEY。稿件为 CC BY 开放获取论文改编，不含患者信息。
 */
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
// @ts-expect-error 直接引用平台依赖的入口文件（实验脚本不在平台包里，无法按包名解析类型）
import { DeepSeekHarness } from '../../../apps/platform/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js'
import { addUsage, emptyUsage, mapNotification, type TurnUsage } from '../../../apps/platform/src/harness/events.ts'
import { client, readAll, type Client, type UiEvent } from '../exp3/client.ts'
import * as D from '../exp3/docx.ts'
import { repoRoot, startServer, stopServer } from '../exp3/server.ts'
import { GUARD_CODES, type Task, type TaskCtx } from '../exp3/tasks.ts'
import { check, COMMENTS, humanEditsFile, measure } from '../manuscripts/compare.ts'
import { PAPERS, plain, targets, type PaperTopic } from '../manuscripts/tasks.ts'
import { evaluateNatural, evaluateStress, humanRevisionKept, type Rework } from './oracles.ts'
import { stressSchedule, type Concurrent, type StressCtx, type StressTask } from './stress.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const VENV_BIN = join(here, '../exp3/.venv-baseline/bin')
const TOOLS_BIN = join(here, 'tools')
const PROFILE: Record<string, string> = { B1: join(here, '../exp3/baseline.cordis.yml'), B2: join(here, 'b2.cordis.yml') }
const MODEL = process.env.DSH_MODEL || 'deepseek-flash'

const { values } = parseArgs({
  options: {
    arms: { type: 'string', default: 'P,B1,B2' },
    set: { type: 'string', default: 'natural,stress' },
    seeds: { type: 'string', default: '301,302,303' },
    only: { type: 'string' },
    limit: { type: 'string' },
    'per-task': { type: 'string' },
    parallel: { type: 'string', default: '3' },
    port: { type: 'string', default: '8870' },
    tag: { type: 'string', default: 'formal' },
  },
})

// —— 任务清单：日常（v1 的排程：每个种子 3 篇论文 × 9 类任务）+ 压力 ——

interface Job { set: 'natural' | 'stress'; seed: number; paper: PaperTopic; natural?: Task<PaperTopic>; stress?: StressTask }

const papers = [...PAPERS.train, ...PAPERS.heldout]
function shuffle<T>(xs: T[], seed: number): T[] {
  let a = seed >>> 0
  const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!] }
  return out
}
function jobsFor(seeds: number[]): Job[] {
  const sets = values.set!.split(',')
  const out: Job[] = []
  if (sets.includes('natural')) {
    for (const seed of seeds) for (let session = 1; session <= 3; session++) {
      const paper = papers[(session - 1 + seed * 3) % papers.length]!
      for (const task of shuffle(PAPERS.tasks, seed * 1000 + session)) out.push({ set: 'natural', seed, paper, natural: task })
    }
  }
  if (sets.includes('stress')) for (const j of stressSchedule(seeds)) out.push({ set: 'stress', seed: j.seed, paper: j.paper, stress: j.task })
  const only = values.only?.split(',')
  let picked = only ? out.filter(j => only.includes(j.stress?.id ?? j.natural!.archetype)) : out
  // 预实验 / 冒烟：每类任务只取前 N 个
  if (values['per-task']) {
    const seen = new Map<string, number>()
    picked = picked.filter(j => { const k = j.stress?.id ?? j.natural!.archetype; const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); return n <= Number(values['per-task']) })
  }
  return values.limit ? picked.slice(0, Number(values.limit)) : picked
}

// —— 回合记录 ——

interface Row {
  arm: string; model: string; set: string; seed: number; paper: string; task: string
  status: string; ms: number; calls: string[]; guard_rejections: number; concurrent_injected: boolean | null
  /** 本回合模型用量（输入 / 输出 / 缓存命中 token，步数，会话数；含子代理）。 */
  usage: TurnUsage | null
  eval: Rework | null; error?: string
}
const toolName = (n: unknown) => String(n ?? '?').replace(/^mcp__heurion__/, '')
const taskId = (j: Job) => j.stress?.id ?? j.natural!.archetype

function keep(outDir: string, arm: string, j: Job, pkg: D.Pkg): void {
  const dir = join(outDir, 'docx')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${arm}-s${j.seed}-${j.paper.pmcid}-${taskId(j)}.docx`), D.saveDocx(pkg))
}

/** 与 v1 相同的人类布置（脚本组：直接写进文件）。 */
function naturalStartFile(task: Task<PaperTopic>, t: PaperTopic, src: D.Pkg): D.Pkg {
  const tg = targets(t)
  let start: D.Pkg | null = src
  if (task.archetype === 'pending_suggestion') start = D.humanTrackedChange(src, tg.res1.slice(0, 60), tg.res1Phrase, `${tg.res1Phrase} (intention-to-treat population)`, 'Dong Qian')
  if (task.archetype === 'open_comment_anchor') {
    start = D.humanComment(src, tg.methods.first.slice(0, 60), tg.methods.snippets[0], COMMENTS[0], 'Dong Qian', 0)
    start = start && D.humanComment(start, tg.methods.first.slice(0, 60), tg.methods.snippets[1], COMMENTS[1], 'Dong Qian', 1)
  }
  if (!start) throw new Error('人类操作没能写进文件（目标文字跨了格式边界）')
  return start
}
const naturalSource = (t: PaperTopic) => D.openDocx(new Uint8Array(readFileSync(join(here, '../manuscripts/data/docx', `${t.pmcid}.docx`))))

// —— P：平台（MCP） ——

async function upload(c: Client, pkg: D.Pkg, title: string): Promise<string> {
  const form = new FormData()
  form.append('file', new File([Buffer.from(D.saveDocx(pkg))], `${title}.docx`))
  const res = await fetch(`${c.base}/api/docs`, { method: 'POST', headers: { Authorization: c.auth }, body: form })
  if (!res.ok) throw new Error(`导入失败 ${res.status} ${await res.text()}`)
  return ((await res.json()) as { id: string }).id
}

/** S2：AI 第一次读稿后，以医生身份改目标段落（补一句或改一个数字；平台：经编辑接口写入 Yjs）。 */
async function injectMcp(c: Client, docId: string, cc: Concurrent): Promise<boolean> {
  const view = await readAll(c, docId)
  const key = cc.para.slice(0, 50)
  let id: string | null = null
  for (const line of view.split('\n')) {
    const m = /\{#([a-z0-9]+)\}\s?(.*)$/.exec(line)
    if (m && plain(m[2]!).replace(/\s+/g, ' ').startsWith(key)) { id = m[1]!; break }
  }
  if (!id) return false
  const rev = Number(/rev=(\d+)/.exec(view)![1])
  await c.api(`/api/docs/${docId}/edit`, { method: 'POST', body: JSON.stringify({ base_rev: rev, mode: 'apply', ops: [{ op: 'replace_text', id, find: cc.find, replace: cc.replace }] }) })
  return true
}

async function runP(base: string, j: Job, outDir: string): Promise<Row> {
  const c = client(base, `v2-p-s${j.seed}`)
  const t0 = Date.now()
  const row: Row = { arm: 'P', model: MODEL, set: j.set, seed: j.seed, paper: j.paper.pmcid, task: taskId(j), status: 'unknown', ms: 0, calls: [], guard_rejections: 0, concurrent_injected: null, usage: null, eval: null }
  let sctx: StressCtx | null = null
  const src = j.stress ? (sctx = j.stress.build(j.paper)).source : naturalSource(j.paper)
  const docId = j.natural ? await PAPERS.create(c, j.paper, `v2 ${taskId(j)}`) : await upload(c, src, `v2 ${taskId(j)}`)
  const ctx: TaskCtx<PaperTopic> = { c, docId, topic: j.paper, before: await PAPERS.read(c, docId), state: {} }
  if (j.natural?.prepare) { await j.natural.prepare(ctx); ctx.before = await PAPERS.read(c, docId) }
  const cc = j.stress?.concurrent?.(sctx!)
  if (cc) row.concurrent_injected = false
  const seen: UiEvent[] = []
  const message = j.natural ? j.natural.message(j.paper) : j.stress!.message(sctx!)
  const events = await c.chat(docId, message, async e => {
    seen.push(e)
    if (j.natural) await j.natural.onEvent?.(ctx, e, seen)
    if (cc && !row.concurrent_injected && e.type === 'tool_result' && !e.isError) {
      const call = seen.find(x => x.type === 'tool_call' && x.callId === e.callId)
      if (/doc_read|doc_outline|doc_search/.test(String(call?.name ?? ''))) row.concurrent_injected = await injectMcp(c, docId, cc).catch(() => false)
    }
  })
  const res = await fetch(`${base}/api/docs/${docId}/export.docx`, { headers: { Authorization: c.auth } })
  const after = D.openDocx(new Uint8Array(await res.arrayBuffer()))
  keep(outDir, 'P', j, after)
  const errors = events.filter(e => e.type === 'tool_result' && e.isError).map(e => e.code as string | undefined)
  const doneEvent = events.find(e => e.type === 'turn_done')
  row.status = (doneEvent?.status as string | undefined) ?? 'unknown'
  row.usage = (doneEvent?.usage as TurnUsage | undefined) ?? null
  row.calls = events.filter(e => e.type === 'tool_call').map(e => toolName(e.name))
  row.guard_rejections = errors.filter(code => code && GUARD_CODES.has(code)).length
  if (j.natural) {
    const checks = check(j.natural, j.paper, src, after, ctx.state, humanRevisionKept(after))
    row.eval = await evaluateNatural(j.natural, j.paper, src, after, checks, measure(j.natural, j.paper, src, after))
  } else row.eval = await evaluateStress(j.stress!, sctx!, after, [], row.concurrent_injected)
  row.ms = Date.now() - t0
  return row
}

// —— B1 / B2：直接写脚本改 Word ——

async function runFile(arm: 'B1' | 'B2', j: Job, outDir: string): Promise<Row> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('脚本组需要 DEEPSEEK_API_KEY（用 --env-file 加载根目录 .env）')
  const t0 = Date.now()
  const row: Row = { arm, model: MODEL, set: j.set, seed: j.seed, paper: j.paper.pmcid, task: taskId(j), status: 'done', ms: 0, calls: [], guard_rejections: 0, concurrent_injected: null, usage: null, eval: null }
  let sctx: StressCtx | null = null
  const src = j.stress ? (sctx = j.stress.build(j.paper)).source : naturalSource(j.paper)
  const cwd = mkdtempSync(join(tmpdir(), `v2-${arm}-`))
  const file = join(cwd, 'manuscript.docx')
  writeFileSync(file, D.saveDocx(j.natural ? naturalStartFile(j.natural, j.paper, src) : src))
  const harness = new DeepSeekHarness({
    profile: 'sdk', patches: [PROFILE[arm]!], dshHome: join(cwd, '.dsh-home'), cwd, processCwd: cwd,
    env: {
      PATH: `${arm === 'B2' ? `${TOOLS_BIN}:` : ''}${VENV_BIN}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: process.env.HOME ?? cwd, LANG: process.env.LANG ?? 'C.UTF-8',
      DEEPSEEK_API_KEY: apiKey, DEEPSEEK_BASE_URL: process.env.DEEPSEEK_UPSTREAM_URL || 'https://api.deepseek.com/anthropic/v1',
      DSH_PRIMARY_RUNTIME: '', PIP_NO_INDEX: '1',
    },
    provider: process.env.DSH_PROVIDER || 'deepseek-official', model: MODEL, initializeTimeoutMs: 60_000,
  })
  const cc = j.stress?.concurrent?.(sctx!)
  if (cc) row.concurrent_injected = false
  const state: Record<string, any> = {}
  const events: UiEvent[] = []
  try {
    const sessionId = randomUUID()
    const message = j.natural ? j.natural.message(j.paper) : j.stress!.message(sctx!)
    const usage = emptyUsage()
    await harness.run(message, {
      sessionId,
      onNotification: (n: Parameters<typeof mapNotification>[0]) => {
        addUsage(usage, n)
        for (const e of mapNotification(n, sessionId) as UiEvent[]) {
          events.push(e)
          if (j.natural?.archetype === 'concurrent_edit') { const tg = targets(j.paper); humanEditsFile(e, events, file, tg.disc1, tg.discAnchor, state) }
          // S2：AI 第一次读到稿件内容后（工具调用涉及 manuscript），医生直接改文件
          if (cc && !row.concurrent_injected && e.type === 'tool_result' && !e.isError) {
            const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
            if (/manuscript/.test(String(call?.arguments ?? ''))) {
              const next = D.humanReplace(D.openDocx(new Uint8Array(readFileSync(file))), cc.para.slice(0, 60), cc.find, cc.replace)
              if (next) { writeFileSync(file, D.saveDocx(next)); row.concurrent_injected = true }
            }
          }
        }
      },
    })
    const { ids: _ids, ...turnUsage } = usage
    row.usage = turnUsage
    const after = D.openDocx(new Uint8Array(readFileSync(file)))
    keep(outDir, arm, j, after)
    row.calls = events.filter(e => e.type === 'tool_call').map(e => toolName(e.name))
    if (j.natural) {
      const checks = check(j.natural, j.paper, src, after, state, humanRevisionKept(after))
      row.eval = await evaluateNatural(j.natural, j.paper, src, after, checks, measure(j.natural, j.paper, src, after))
    } else row.eval = await evaluateStress(j.stress!, sctx!, after, [], row.concurrent_injected)
  } finally {
    await harness.close().catch(() => {})
  }
  row.ms = Date.now() - t0
  return row
}

// —— 编排：每组内按 --parallel 并发 ——

function log(path: string, row: Row): void {
  appendFileSync(path, JSON.stringify(row) + '\n')
  const e = row.eval
  console.log(`[${row.arm}] s${row.seed} ${row.paper} ${row.task.padEnd(20)} ${row.status.padEnd(8)} ${e ? (e.rework ? `返工：${e.reasons.join(',')}` : '无需返工') : `出错：${row.error}`} ${(row.ms / 1000).toFixed(0)}s${row.usage ? ` ${Math.round((row.usage.input + row.usage.output) / 1000)}k tok` : ''}`)
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!) }))
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = join(repoRoot, 'paper/results/v2-q1', `${values.tag}-${stamp}`)
mkdirSync(outDir, { recursive: true })
const arms = values.arms!.split(',')
const seeds = values.seeds!.split(',').map(Number)
const jobs = jobsFor(seeds)
writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
  started_at: new Date().toISOString(),
  commit: execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(),
  dirty: execSync('git status --porcelain --untracked-files=no', { cwd: repoRoot }).toString().trim() !== '',
  plan: 'paper/benchmarks/v2/ANALYSIS_PLAN_v2.md', tag: values.tag, model: MODEL, arms, seeds, sets: values.set, jobs: jobs.length,
}, null, 2))
console.log(`${jobs.length} 个任务 × ${arms.length} 组 → ${outDir}`)

const server = arms.includes('P')
  ? await startServer('v2-p', Number(values.port), join(here, '../exp3/data', `v2-q1-${stamp}`), join(outDir, 'server-P.log'), { PROCEDURAL_MODE: 'off' })
  : null
try {
  await Promise.all(arms.map(arm => pool(jobs, Number(values.parallel), async j => {
    const path = join(outDir, `turns-${arm}.jsonl`)
    let row: Row
    try {
      row = arm === 'P' ? await runP(server!.base, j, outDir) : await runFile(arm as 'B1' | 'B2', j, outDir)
    } catch (err) {
      row = { arm, model: MODEL, set: j.set, seed: j.seed, paper: j.paper.pmcid, task: taskId(j), status: 'harness_error', ms: 0, calls: [], guard_rejections: 0, concurrent_injected: null, usage: null, eval: null, error: String((err as Error).message ?? err).slice(0, 300) }
    }
    log(path, row)
  })))
} finally {
  if (server) stopServer(server)
}
console.log(`结果目录：${outDir}`)
