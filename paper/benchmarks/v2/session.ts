/**
 * v2 多轮会话（sessions.ts）的运行器：每篇论文一场会话、8 轮，P（平台，同一文档、平台默认的会话延续）
 * 与 B1 / B2（同一个 dsh 会话、同一个文件）。每轮前后各存一份 .docx，按「改前 → 改后」判定；
 * 医生的修改：平台组经编辑接口以用户身份写入，脚本组直接改文件；进行中的修改在 AI 本轮第一次调用工具之后写入。
 *   cd apps/platform && npx tsx --env-file-if-exists=../../.env ../../paper/benchmarks/v2/session.ts \
 *     [--arms P,B1,B2] [--papers N] [--repeats R] [--parallel 3] [--port 8880] [--tag session] [--resume <已有结果目录>]
 * 每篇论文重复 R 场（各自独立的文档 / 文件与会话）；续跑时整场完成的会话跳过，没跑完的整场重跑（attempt 加一，分析取每场最后一次完整的）。
 * 每轮改前、改后的 .docx 都保存，连同医生修改的标志与注入情况记在行里，判定可离线重做（reeval.ts）。
 */
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { PAPERS, plain, type PaperTopic } from '../manuscripts/tasks.ts'
import { evaluateStress, type Rework } from './oracles.ts'
import { sessionReady, stepTask, type DoctorEdit, type SessionStep } from './sessions.ts'
import type { StressCtx } from './stress.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const VENV_BIN = join(here, '../exp3/.venv-baseline/bin')
const TOOLS_BIN = join(here, 'tools')
const PROFILE: Record<string, string> = { B1: join(here, '../exp3/baseline.cordis.yml'), B2: join(here, 'b2.cordis.yml') }
const MODEL = process.env.DSH_MODEL || 'deepseek-flash'

const { values } = parseArgs({
  options: {
    arms: { type: 'string', default: 'P,B1,B2' },
    papers: { type: 'string' },
    parallel: { type: 'string', default: '3' },
    port: { type: 'string', default: '8880' },
    tag: { type: 'string', default: 'session' },
    repeats: { type: 'string', default: '1' },
    resume: { type: 'string' },
  },
})

interface Row {
  arm: string; model: string; paper: string; rep: number; attempt: number; step: string; turn: number
  /** 本轮之前医生已做的修改（标志文字不能减少），离线重新判定用。 */
  keep: Array<{ label: string; expect: string }>
  status: string; ms: number; calls: string[]; guard_rejections: number; usage: TurnUsage | null
  concurrent_injected: boolean | null
  /** 本轮之后医生的修改是否写进去了（null = 本轮之后没有）。 */
  doctor_applied: boolean | null
  eval: Rework | null; error?: string
}
const toolName = (n: unknown) => String(n ?? '?').replace(/^mcp__heurion__/, '')

/** 医生此前的修改：标志文字在之后各轮里不能减少。 */
type Keep = Array<{ label: string; expect: string }>

/** 判定（含联网查文献）失败时隔几秒再试一次；仍失败则记下原因，会话继续（不因判定出错中断 AI 的会话）。 */
async function judge(fn: () => Promise<Rework>, row: Row): Promise<Rework | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await fn() } catch (err) {
      if (attempt === 1) { row.error = `判定失败：${String((err as Error).message).slice(0, 200)}`; return null }
      await new Promise(r => setTimeout(r, 8000))
    }
  }
  return null
}

// —— 平台组 ——

async function upload(c: Client, pkg: D.Pkg, title: string): Promise<string> {
  const form = new FormData()
  form.append('file', new File([Buffer.from(D.saveDocx(pkg))], `${title}.docx`))
  const res = await fetch(`${c.base}/api/docs`, { method: 'POST', headers: { Authorization: c.auth }, body: form })
  if (!res.ok) throw new Error(`导入失败 ${res.status} ${await res.text()}`)
  return ((await res.json()) as { id: string }).id
}
const exportOf = async (c: Client, docId: string) => D.openDocx(new Uint8Array(await (await fetch(`${c.base}/api/docs/${docId}/export.docx`, { headers: { Authorization: c.auth } })).arrayBuffer()))

/** 医生经编辑器改一处：按段落开头在读视图里找块，以用户身份 replace_text。 */
async function doctorMcp(c: Client, docId: string, e: DoctorEdit): Promise<boolean> {
  const view = await readAll(c, docId)
  const key = plain(e.para).replace(/\s+/g, ' ').slice(0, 50)
  let id: string | null = null
  for (const line of view.split('\n')) {
    const m = /\{#([a-z0-9]+)\}\s?(.*)$/.exec(line)
    if (m && plain(m[2]!).replace(/^⟨[^⟩]*⟩\s*/, '').replace(/\s+/g, ' ').startsWith(key)) { id = m[1]!; break }
  }
  if (!id) return false
  const rev = Number(/rev=(\d+)/.exec(view)![1])
  try {
    await c.api(`/api/docs/${docId}/edit`, { method: 'POST', body: JSON.stringify({ base_rev: rev, mode: 'apply', ops: [{ op: 'replace_text', id, find: e.find, replace: e.replace }] }) })
    return true
  } catch {
    return false
  }
}

type Out = (r: Row, after: D.Pkg, before: D.Pkg) => void

async function sessionP(base: string, paper: PaperTopic, rep: number, attempt: number, ctx: StressCtx, steps: SessionStep[], out: Out): Promise<void> {
  const c = client(base, `v2-sess-${paper.pmcid.toLowerCase()}-r${rep}-a${attempt}`)
  let docId: string
  try {
    docId = await upload(c, ctx.source, `会话 ${paper.pmcid}`)
  } catch (err) {
    out({ arm: 'P', model: MODEL, paper: paper.pmcid, rep, attempt, keep: [], step: 'setup', turn: 0, status: 'harness_error', ms: 0, calls: [], guard_rejections: 0, usage: null, concurrent_injected: null, doctor_applied: null, eval: null, error: String((err as Error).message).slice(0, 300) }, ctx.source, ctx.source)
    return
  }
  const keep: Keep = []
  let pendingDoctor: boolean | null = null
  for (const [i, step] of steps.entries()) {
    const before = await exportOf(c, docId)
    const row: Row = { arm: 'P', model: MODEL, paper: paper.pmcid, rep, attempt, keep: [...keep], step: step.id, turn: i + 1, status: 'unknown', ms: 0, calls: [], guard_rejections: 0, usage: null, concurrent_injected: null, doctor_applied: null, eval: null }
    const t0 = Date.now()
    try {
      const cc = step.concurrent?.(before) ?? null
      if (cc) row.concurrent_injected = false
      let tried = false
      const seen: UiEvent[] = []
      const events = await c.chat(docId, step.message(before), async e => {
        seen.push(e)
        // 医生在 AI 本轮第一次调用工具之后改稿（不管是什么工具：AI 不读稿、凭记忆直接写时同样会遇到）
        if (cc && !tried && e.type === 'tool_result') { tried = true; row.concurrent_injected = await doctorMcp(c, docId, cc).catch(() => false) }
      })
      const done = events.find(e => e.type === 'turn_done')
      row.status = (done?.status as string | undefined) ?? 'unknown'
      row.usage = (done?.usage as TurnUsage | undefined) ?? null
      row.calls = events.filter(e => e.type === 'tool_call').map(e => toolName(e.name))
      row.guard_rejections = events.filter(e => e.type === 'tool_result' && e.isError && /pending_suggestion|conflict_user_edited|anchor_has_open_comments|citation_not_registered/.test(String(e.code))).length
      row.ms = Date.now() - t0
      const after = await exportOf(c, docId)
      row.eval = await judge(() => evaluateStress(stepTask(step, before), { ...ctx, source: before }, after, keep, row.concurrent_injected), row)
      if (cc && row.concurrent_injected) keep.push({ label: cc.label, expect: cc.expect })
      const doc = step.doctorAfter?.(after) ?? null
      if (doc) { pendingDoctor = await doctorMcp(c, docId, doc); if (pendingDoctor) keep.push({ label: doc.label, expect: doc.expect }) } else pendingDoctor = null
      row.doctor_applied = pendingDoctor
      out(row, after, before)
    } catch (err) {
      row.status = 'harness_error'
      row.error = String((err as Error).message ?? err).slice(0, 300)
      out(row, before, before)
      return
    }
  }
}

// —— 脚本组 ——

async function sessionFile(arm: 'B1' | 'B2', paper: PaperTopic, rep: number, attempt: number, ctx: StressCtx, steps: SessionStep[], out: Out): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('脚本组需要 DEEPSEEK_API_KEY')
  const cwd = mkdtempSync(join(tmpdir(), `v2-session-${arm}-`))
  const file = join(cwd, 'manuscript.docx')
  writeFileSync(file, D.saveDocx(ctx.source))
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
  // 同一个会话：AI 记得前几轮读过、改过的内容（与平台组的会话延续对应）
  const sessionId = randomUUID()
  const doctorFile = (e: DoctorEdit) => {
    const next = D.humanReplace(D.openDocx(new Uint8Array(readFileSync(file))), e.para.slice(0, 60), e.find, e.replace)
    if (next) writeFileSync(file, D.saveDocx(next))
    return !!next
  }
  const keep: Keep = []
  try {
    for (const [i, step] of steps.entries()) {
      const before = D.openDocx(new Uint8Array(readFileSync(file)))
      const row: Row = { arm, model: MODEL, paper: paper.pmcid, rep, attempt, keep: [...keep], step: step.id, turn: i + 1, status: 'done', ms: 0, calls: [], guard_rejections: 0, usage: null, concurrent_injected: null, doctor_applied: null, eval: null }
      const t0 = Date.now()
      try {
        const cc = step.concurrent?.(before) ?? null
        if (cc) row.concurrent_injected = false
        let tried = false
        const events: UiEvent[] = []
        const usage = emptyUsage()
        await harness.run(step.message(before), {
          sessionId,
          onNotification: (n: Parameters<typeof mapNotification>[0]) => {
            addUsage(usage, n)
            for (const e of mapNotification(n, sessionId) as UiEvent[]) {
              events.push(e)
              // 医生在 AI 本轮第一次调用工具之后改稿（与平台组同一时机）
              if (cc && !tried && e.type === 'tool_result') { tried = true; row.concurrent_injected = doctorFile(cc) }
            }
          },
        })
        const { ids: _ids, ...u } = usage
        row.usage = u
        row.calls = events.filter(e => e.type === 'tool_call').map(e => toolName(e.name))
        row.ms = Date.now() - t0
        const after = D.openDocx(new Uint8Array(readFileSync(file)))
        row.eval = await judge(() => evaluateStress(stepTask(step, before), { ...ctx, source: before }, after, keep, row.concurrent_injected), row)
        if (cc && row.concurrent_injected) keep.push({ label: cc.label, expect: cc.expect })
        const doc = step.doctorAfter?.(after) ?? null
        row.doctor_applied = doc ? doctorFile(doc) : null
        if (doc && row.doctor_applied) keep.push({ label: doc.label, expect: doc.expect })
        out(row, after, before)
      } catch (err) {
        row.status = 'harness_error'
        row.error = String((err as Error).message ?? err).slice(0, 300)
        out(row, before, before)
        return
      }
    }
  } finally {
    await harness.close().catch(() => {})
  }
}

// —— 编排 ——

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!) }))
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = values.resume ?? join(repoRoot, 'paper/results/v2-q1', `${values.tag}-${stamp}`)
mkdirSync(join(outDir, 'docx'), { recursive: true })
const arms = values.arms!.split(',')
const ready = [...PAPERS.train, ...PAPERS.heldout].map(t => ({ t, s: sessionReady(t) })).filter(x => x.s)
const papers = values.papers ? ready.slice(0, Number(values.papers)) : ready
const repeats = Number(values.repeats)
const runInfo = {
  started_at: new Date().toISOString(),
  commit: execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(),
  dirty: execSync('git status --porcelain --untracked-files=no', { cwd: repoRoot }).toString().trim() !== '',
}
if (values.resume) {
  const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'))
  if (meta.commit !== runInfo.commit) throw new Error(`续跑的代码版本 ${runInfo.commit} 与原运行 ${meta.commit} 不同`)
  meta.resumes = [...(meta.resumes ?? []), runInfo]
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2))
} else {
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify({ ...runInfo, plan: 'paper/benchmarks/v2/ANALYSIS_PLAN_v2.md', tag: values.tag, model: MODEL, arms, repeats, papers: papers.map(x => x.t.pmcid), eligible: ready.map(x => x.t.pmcid) }, null, 2))
}

/** 各组已有的记录：整场 8 轮都没有出错的会话算完成；没完成的会话下次 attempt 加一重跑。 */
const prior = new Map(arms.map(arm => {
  const path = join(outDir, `turns-${arm}.jsonl`)
  return [arm, existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Row) : []]
}))
const sessionKey = (paper: string, rep: number) => `${paper}|${rep}`
function plan(arm: string): Array<{ t: PaperTopic; s: NonNullable<ReturnType<typeof sessionReady>>; rep: number; attempt: number }> {
  const rows = prior.get(arm)!
  const out: ReturnType<typeof plan> = []
  for (const { t, s } of papers) {
    for (let rep = 1; rep <= repeats; rep++) {
      const mine = rows.filter(r => sessionKey(r.paper, r.rep ?? 1) === sessionKey(t.pmcid, rep))
      const attempts = [...new Set(mine.map(r => r.attempt ?? 1))]
      const complete = attempts.some(a => { const xs = mine.filter(r => (r.attempt ?? 1) === a); return xs.length === s!.steps.length && xs.every(r => r.status !== 'harness_error') })
      if (!complete) out.push({ t, s: s!, rep, attempt: (attempts.length ? Math.max(...attempts) : 0) + 1 })
    }
  }
  return out
}
console.log(`${papers.length} 篇 × ${repeats} 场 × ${arms.length} 组 → ${outDir}${values.resume ? `（续跑：待跑 ${arms.map(a => `${a} ${plan(a).length}`).join('、')} 场）` : ''}`)

// 平台组用产品默认的会话延续（不每轮新开会话）
const server = arms.includes('P')
  ? await startServer('v2-session', Number(values.port), join(here, '../exp3/data', `v2-session-${stamp}`), join(outDir, 'server-P.log'), { PROCEDURAL_MODE: 'off', HARNESS_FRESH_SESSION: '0' })
  : null
try {
  await Promise.all(arms.map(arm => pool(plan(arm), Number(values.parallel), async ({ t, s, rep, attempt }) => {
    const out: Out = (r, after, before) => {
      appendFileSync(join(outDir, `turns-${arm}.jsonl`), JSON.stringify(r) + '\n')
      const base = join(outDir, 'docx', `${arm}-${t.pmcid}-r${rep}-a${attempt}-${r.turn}-${r.step}`)
      writeFileSync(`${base}.docx`, D.saveDocx(after))
      writeFileSync(`${base}.before.docx`, D.saveDocx(before))
      const e = r.eval
      console.log(`[${arm}] ${t.pmcid} r${rep} ${r.step.padEnd(11)} ${r.status.padEnd(8)} ${e ? (e.rework ? `返工(${e.severity})：${e.reasons.join(',')} ${e.human_lost.join(',')}` : '无需返工') : `出错：${r.error}`} ${(r.ms / 1000).toFixed(0)}s`)
    }
    if (arm === 'P') await sessionP(server!.base, t, rep, attempt, s.ctx, s.steps, out)
    else await sessionFile(arm as 'B1' | 'B2', t, rep, attempt, s.ctx, s.steps, out)
  })))
} finally {
  if (server) stopServer(server)
}
console.log(`结果目录：${outDir}`)
