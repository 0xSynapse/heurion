/**
 * 实验 2a：同一批改稿任务，MCP 编辑（平台）vs 直接改 Word 文件（python-docx）。
 * 两组从同一份期刊模板化的 .docx 出发，人类操作（批注、待采纳修订、回合中途改稿）按各自的原生方式布置，
 * 改完后都落成 .docx，用同一套判定与度量（docx.ts）比较。两组都不挂程序性记忆，只比较编辑方式。
 *   cd apps/platform && npx tsx --env-file-if-exists=../../.env ../../paper/benchmarks/exp3/compare.ts [--users 3] [--sessions 3] [--seed 1] [--port 8820]
 * 需要 .env 里的 DEEPSEEK_API_KEY。任务文本为合成内容，不含真实患者信息。
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
import { docxFor } from '../../../apps/platform/src/convert/exports.ts'
import { mapNotification } from '../../../apps/platform/src/harness/events.ts'
import { setup } from '../../../apps/platform/tests/helpers.ts'
import { client, type UiEvent } from './client.ts'
import * as D from './docx.ts'
import { repoRoot, startServer, stopServer } from './server.ts'
import { GUARD_CODES, HELDOUT_TOPICS, manuscript, TASKS, TRAIN_TOPICS, type Task, type TaskCtx, type Topic } from './tasks.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const VENV_BIN = join(here, '.venv-baseline/bin')
const COMMENT_TEXT = '随机化比例请与方案 v2.1 核对'

const { values } = parseArgs({
  options: {
    users: { type: 'string', default: '3' },
    sessions: { type: 'string', default: '3' },
    seed: { type: 'string', default: '1' },
    port: { type: 'string', default: '8820' },
    arms: { type: 'string', default: 'mcp,file' },
  },
})

// —— 源文件：平台导出的稿件，加工成期刊模板风格 ——

const sources = new Map<string, D.Pkg>()
function sourceOf(t: Topic): D.Pkg {
  if (!sources.has(t.key)) {
    const { docs, docId } = setup(manuscript(t))
    sources.set(t.key, D.journalize(D.openDocx(docxFor(docs, docId).bytes), [t.drug]))
  }
  return sources.get(t.key)!
}

/** 每类任务的目标段（不计入「不该动的段落」）。 */
function targetOf(task: Task, t: Topic): string | null {
  switch (task.archetype) {
    case 'concurrent_edit': return `本研究显示${t.drug}`
    case 'citation': return `${t.disease}预后较差`
    case 'pending_suggestion': return `${t.drug}改善了`
    case 'open_comment_anchor': return '本研究为多中心'
    case 'ambiguous_phrase': return '共纳入'
    case 'out_of_scope_revert': return '该结果与既往'
    default: return null
  }
}

interface Checks {
  /** 任务本身做到了。 */
  done: boolean
  /** 医生的东西（中途插入的文字 / 批注锚点 / 待采纳修订）没被破坏；不涉及时为 null。 */
  human_kept: boolean | null
  /** 正文里出现了裸 DOI / PMID。 */
  raw_doi_in_body: boolean
  detail: string
}

/** 两组共用的判定：只看改完后的 .docx（待采纳修订另由调用方给出）。 */
function check(task: Task, t: Topic, after: D.Pkg, state: Record<string, any>, pendingKept: boolean): Checks {
  const ps = D.paras(D.docXml(after)).map(p => p.text)
  const refAt = ps.findIndex(x => /^(参考文献|References)\s*$/.test(x.trim()))
  const body = (refAt >= 0 ? ps.slice(0, refAt) : ps).join('\n')
  const raw = /10\.\d{4,9}\/|PMID[:：]?\s*\d+/i.test(body)
  const para = (prefix: string) => ps.find(x => x.startsWith(prefix)) ?? ''
  const out = (done: boolean, human: boolean | null, detail = ''): Checks => ({ done, human_kept: human, raw_doi_in_body: raw, detail })
  switch (task.archetype) {
    case 'concurrent_edit': {
      const kept = !state.edited || (body.includes('补充材料表 S2') && body.includes(state.marker as string))
      return out(true, state.edited ? kept : null, state.edited ? (kept ? '' : '医生插入的内容丢失') : '人类编辑未触发')
    }
    case 'citation':
      return out(body.includes(t.trial) && !raw, null, raw ? '正文出现裸 DOI' : body.includes(t.trial) ? '' : '没写进试验')
    case 'pending_suggestion':
      return out(true, pendingKept, pendingKept ? '' : '医生的待采纳修订不见了')
    case 'open_comment_anchor': {
      // AI 可能把方法第一段拆成几段：看「方法」到下一个标题之间的全部文字
      const from = ps.indexOf('方法')
      const to = ps.indexOf('结果', from + 1)
      const methods = ps.slice(from + 1, to > from ? to : undefined).join('')
      const done = /隐藏|盲/.test(methods.replace(/双盲/g, ''))
      const anchored = D.commentAnchored(after, COMMENT_TEXT)
      return out(done, anchored, anchored ? '' : '批注锚点丢失')
    }
    case 'ambiguous_phrase': {
      const p = para('共纳入')
      const left = p.split(`${t.comparator}组`).length - 1
      const done = p.split('对照组').length - 1
      return out(left === 0 && done === 3, null, `剩余「${t.comparator}组」${left} 处，「对照组」${done} 处`)
    }
    case 'table_cell': {
      const age = ps.indexOf('年龄（岁）')
      const bmi = ps.findIndex(x => x.startsWith('BMI'))
      return out(age >= 0 && bmi > age && ps[bmi + 1] === '27.1 ± 4.3' && ps[bmi + 2] === '26.8 ± 4.5', null)
    }
    default:
      return out(true, null)
  }
}

interface Row {
  arm: string
  user: string
  session: number
  topic: string
  archetype: string
  status: string
  ms: number
  calls: string[]
  guard_rejections: number
  checks: Checks
  damage: D.Damage
  format: D.FormatKept | null
  /** MCP 组：AI 声明移除批注锚点后在线程里说明（按平台设计属于正确处理）。 */
  acknowledged?: boolean
}

function shuffle<T>(xs: T[], seed: number): T[] {
  let a = seed >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const topics = [...TRAIN_TOPICS, ...HELDOUT_TOPICS]
const toolName = (n: unknown) => String(n ?? '?').replace(/^mcp__heurion__/, '')

function measure(task: Task, t: Topic, src: D.Pkg, after: D.Pkg) {
  const target = targetOf(task, t)
  return {
    damage: D.damage(src, after, x => (target ? x.startsWith(target) : false)),
    format: target ? D.formatKept(src, after, target, [t.drug]) : null,
  }
}

// —— MCP 组：平台导入同一份 .docx，人类操作走平台接口 ——

async function runMcp(base: string, user: string, seed: number, out: string): Promise<void> {
  const c = client(base, user)
  for (let session = 1; session <= Number(values.sessions); session++) {
    const t = topics[(session - 1) % topics.length]!
    for (const task of shuffle(TASKS, seed * 1000 + session)) {
      const t0 = Date.now()
      const src = sourceOf(t)
      let row: Row
      try {
        const form = new FormData()
        form.append('file', new File([Buffer.from(D.saveDocx(src))], `exp2a-${task.archetype}.docx`))
        const res = await fetch(`${base}/api/docs`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.HEURION_DEV_TOKEN || 'dev'}:${user}` }, body: form })
        if (!res.ok) throw new Error(`导入失败 ${res.status} ${await res.text()}`)
        const doc = await res.json() as { id: string }
        const ctx: TaskCtx = { c, docId: doc.id, topic: t, before: await c.api<string>(`/api/docs/${doc.id}/read`), state: {} }
        if (task.prepare) {
          await task.prepare(ctx)
          ctx.before = await c.api<string>(`/api/docs/${doc.id}/read`)
        }
        const seen: UiEvent[] = []
        const events = await c.chat(doc.id, task.message(t), async e => {
          seen.push(e)
          await task.onEvent?.(ctx, e, seen)
        })
        const exported = await fetch(`${base}/api/docs/${doc.id}/export.docx`, { headers: { Authorization: `Bearer ${process.env.HEURION_DEV_TOKEN || 'dev'}:${user}` } })
        const after = D.openDocx(new Uint8Array(await exported.arrayBuffer()))
        const d = await c.api(`/api/docs/${doc.id}`)
        const pendingKept = (d.suggestions as unknown[]).length > 0
        keep(out, { arm: 'mcp', user, session, archetype: task.archetype }, after)
        const thread = (d.comments as Array<{ id: string; replies: Array<{ role: string }> }>).find(x => x.id === ctx.state.commentId)
        const errors = events.filter(e => e.type === 'tool_result' && e.isError).map(e => e.code as string | undefined)
        row = {
          arm: 'mcp', user, session, topic: t.key, archetype: task.archetype,
          status: (events.find(e => e.type === 'turn_done')?.status as string | undefined) ?? 'unknown',
          ms: Date.now() - t0,
          calls: events.filter(e => e.type === 'tool_call').map(e => toolName(e.name)),
          guard_rejections: errors.filter(code => code && GUARD_CODES.has(code)).length,
          checks: check(task, t, after, ctx.state, pendingKept),
          ...measure(task, t, src, after),
          acknowledged: task.archetype === 'open_comment_anchor' ? !!thread?.replies.some(r => r.role === 'ai') : undefined,
        }
      } catch (err) {
        row = errorRow('mcp', user, session, t, task, t0, err)
      }
      log(out, row)
    }
  }
}

// —— 对照组：AI 用 python-docx 直接改工作目录里的文件，人类操作直接写进文件 ——

async function runFile(user: string, seed: number, out: string): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('对照组需要 DEEPSEEK_API_KEY（用 --env-file 加载根目录 .env）')
  for (let session = 1; session <= Number(values.sessions); session++) {
    const t = topics[(session - 1) % topics.length]!
    for (const task of shuffle(TASKS, seed * 1000 + session)) {
      const t0 = Date.now()
      const src = sourceOf(t)
      let row: Row
      const cwd = mkdtempSync(join(tmpdir(), 'exp2a-'))
      const file = join(cwd, 'manuscript.docx')
      const harness = new DeepSeekHarness({
        profile: 'sdk',
        patches: [join(here, 'baseline.cordis.yml')],
        dshHome: join(cwd, '.dsh-home'),
        cwd,
        processCwd: cwd,
        env: {
          PATH: `${VENV_BIN}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          HOME: process.env.HOME ?? cwd,
          LANG: process.env.LANG ?? 'C.UTF-8',
          DEEPSEEK_API_KEY: apiKey,
          DEEPSEEK_BASE_URL: process.env.DEEPSEEK_UPSTREAM_URL || 'https://api.deepseek.com/anthropic/v1',
          // 与平台一致：不加载 dsh office 技能、不能装包
          DSH_PRIMARY_RUNTIME: '',
          PIP_NO_INDEX: '1',
        },
        provider: process.env.DSH_PROVIDER || 'deepseek-official',
        model: process.env.DSH_MODEL || 'deepseek-flash',
        initializeTimeoutMs: 60_000,
      })
      try {
        // 人类操作：与平台组同样的批注 / 待采纳修订，直接写进文件
        let start: D.Pkg = src
        if (task.archetype === 'open_comment_anchor') start = D.humanComment(src, '本研究为多中心', '1:1 随机分配', COMMENT_TEXT, '钱东')!
        if (task.archetype === 'pending_suggestion') start = D.humanTrackedChange(src, `${t.drug}改善了`, '安全性总体可接受', '安全性总体可接受，但需长期随访', '钱东')!
        writeFileSync(file, D.saveDocx(start))

        const state: Record<string, any> = {}
        const events: UiEvent[] = []
        const sessionId = randomUUID()
        await harness.run(task.message(t), {
          sessionId,
          onNotification: (n: Parameters<typeof mapNotification>[0]) => {
            for (const e of mapNotification(n, sessionId) as UiEvent[]) {
              events.push(e)
              if (task.archetype === 'concurrent_edit') humanEditsFile(e, events, file, t, state)
            }
          },
        })
        const after = D.openDocx(new Uint8Array(readFileSync(file)))
        keep(out, { arm: 'file', user, session, archetype: task.archetype }, after)
        row = {
          arm: 'file', user, session, topic: t.key, archetype: task.archetype,
          status: 'done',
          ms: Date.now() - t0,
          calls: events.filter(e => e.type === 'tool_call').map(e => toolName(e.name)),
          guard_rejections: 0,
          checks: check(task, t, after, state, D.hasTrackedChange(after)),
          ...measure(task, t, src, after),
        }
      } catch (err) {
        row = errorRow('file', user, session, t, task, t0, err)
      } finally {
        await harness.close().catch(() => {})
      }
      log(out, row)
    }
  }
}

/** 回合中途：AI 每读完一次文件，医生就在讨论第一段补一处（最多 3 次），与平台组同样的节奏。 */
function humanEditsFile(e: UiEvent, events: UiEvent[], file: string, t: Topic, state: Record<string, any>): void {
  if (e.type !== 'tool_result' || e.isError) return
  const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
  if (!/manuscript/.test(String(call?.arguments ?? ''))) return
  const k = (state.edits as number | undefined) ?? 0
  if (k >= 3 || state.stopped) return
  const pkg = D.openDocx(new Uint8Array(readFileSync(file)))
  const next = k === 0
    ? D.humanReplace(pkg, `本研究显示${t.drug}`, '安全性可接受', '安全性可接受（详见补充材料表 S2）')
    : D.humanReplace(pkg, `本研究显示${t.drug}`, `S${k + 1}）`, `S${k + 1}、S${k + 2}）`)
  if (!next) { state.stopped = true; return }
  writeFileSync(file, D.saveDocx(next))
  state.edits = k + 1
  state.edited = true
  state.marker = `S${k + 2}）`
}

function errorRow(arm: string, user: string, session: number, t: Topic, task: Task, t0: number, err: unknown): Row {
  const empty = { untouched: 0, identical: 0, format_drift: 0, content_changed: 0, styles_intact: false, changed_parts: [] }
  return {
    arm, user, session, topic: t.key, archetype: task.archetype, status: 'harness_error', ms: Date.now() - t0, calls: [],
    guard_rejections: 0, checks: { done: false, human_kept: null, raw_doi_in_body: false, detail: String((err as Error).message ?? err) },
    damage: empty, format: null,
  }
}

/** 改完的文件存档，便于逐个核查。 */
function keep(out: string, row: { arm: string; user: string; session: number; archetype: string }, pkg: D.Pkg): void {
  const dir = join(out, '..', 'docx')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${row.arm}-${row.user}-s${row.session}-${row.archetype}.docx`), D.saveDocx(pkg))
}

function log(out: string, row: Row): void {
  appendFileSync(out, JSON.stringify(row) + '\n')
  const c = row.checks
  console.log(`[${row.arm}] ${row.user} s${row.session} ${row.archetype.padEnd(20)} ${row.status.padEnd(8)} 完成 ${c.done ? '✓' : '✗'} 医生 ${c.human_kept === null ? '-' : c.human_kept ? '✓' : '✗'} 段落原样 ${row.damage.identical}/${row.damage.untouched} 格式 ${row.format ? Object.values(row.format).filter(Boolean).length + '/5' : '-'} ${c.detail} ${(row.ms / 1000).toFixed(0)}s`)
}

// —— 编排 ——

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = join(repoRoot, 'paper/results/exp2a', stamp)
mkdirSync(outDir, { recursive: true })
const arms = values.arms!.split(',')
const users = Number(values.users)
const seed0 = Number(values.seed)
writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
  started_at: new Date().toISOString(),
  commit: execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(),
  dirty: execSync('git status --porcelain', { cwd: repoRoot }).toString().trim() !== '',
  model: process.env.DSH_MODEL || 'deepseek-flash',
  arms, users, sessions: Number(values.sessions), seed: seed0,
}, null, 2))

const server = arms.includes('mcp')
  ? await startServer('mcp', Number(values.port), join(here, 'data', `exp2a-${stamp}`), join(outDir, 'server-mcp.log'), { PROCEDURAL_MODE: 'off' })
  : null
try {
  await Promise.all([
    server && (async () => { for (let k = 0; k < users; k++) await runMcp(server.base, `exp2a-mcp-u${k + 1}`, seed0 + k, join(outDir, 'turns-mcp.jsonl')) })(),
    arms.includes('file') && (async () => { for (let k = 0; k < users; k++) await runFile(`exp2a-file-u${k + 1}`, seed0 + k, join(outDir, 'turns-file.jsonl')) })(),
  ])
} finally {
  if (server) stopServer(server)
}
console.log(`结果目录：${outDir}`)
