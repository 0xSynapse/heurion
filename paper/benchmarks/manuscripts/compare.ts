/**
 * 实验 2a（长稿版）：同一篇开放获取论文改编的期刊格式 Word，MCP 编辑（平台）vs 直接改 Word 文件（python-docx）。
 * 人类操作（批注、待采纳修订、回合中途改稿）按各自的原生方式布置；改完都落成 .docx，用同一套判定与度量。
 * 两组都不挂程序性记忆，只比较编辑方式。
 *   cd apps/platform && npx tsx --env-file-if-exists=../../.env ../../paper/benchmarks/manuscripts/compare.ts [--users 3] [--sessions 3] [--seed 1] [--port 8860]
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
import { mapNotification } from '../../../apps/platform/src/harness/events.ts'
import { client, type UiEvent } from '../exp3/client.ts'
import * as D from '../exp3/docx.ts'
import { repoRoot, startServer, stopServer } from '../exp3/server.ts'
import { GUARD_CODES, type Task, type TaskCtx } from '../exp3/tasks.ts'
import { firstTable, movable, P_GOOD, P_GOOD_NOZERO, P_VALUE, PAPERS, pTarget, targets, type PaperTopic } from './tasks.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const VENV_BIN = join(here, '../exp3/.venv-baseline/bin')
export const COMMENTS = ['请补充具体的入组 / 检索标准细节', '此处描述请与研究方案核对'] as const

// 非严格：被 v2 导入（复用判定函数）时，命令行带的是 v2 的参数
const { values } = parseArgs({
  strict: false,
  options: {
    users: { type: 'string', default: '3' },
    sessions: { type: 'string', default: '3' },
    seed: { type: 'string', default: '1' },
    port: { type: 'string', default: '8860' },
    arms: { type: 'string', default: 'mcp,file' },
  },
}) as { values: Record<string, string> }

const papers = [...PAPERS.train, ...PAPERS.heldout]
const sourceOf = (t: PaperTopic) => D.openDocx(new Uint8Array(readFileSync(join(here, 'data', 'docx', `${t.pmcid}.docx`))))
const startsWith = (text: string, prefix: string) => text.replace(/\s+/g, ' ').startsWith(prefix.replace(/\s+/g, ' ').slice(0, 60))

/** 一节的段落（按 Word 标题级别切）：从标题匹配 title 的二级标题之后到下一个同级或更高级标题。 */
export function sectionParas(pkg: D.Pkg, title: RegExp): D.Para[] {
  const ps = D.paras(D.docXml(pkg))
  const i = ps.findIndex(p => D.headingLevel(p) === 2 && title.test(p.text.trim()))
  if (i < 0) return []
  const j = ps.findIndex((p, k) => k > i && D.headingLevel(p) > 0 && D.headingLevel(p) <= 2)
  return ps.slice(i + 1, j < 0 ? undefined : j)
}

export interface Checks { done: boolean; human_kept: boolean | null; raw_id_added: boolean; detail: string }

/** 两组共用的判定（只看改完的 .docx；待采纳修订由调用方给出）。 */
export function check(task: Task<PaperTopic>, t: PaperTopic, src: D.Pkg, after: D.Pkg, state: Record<string, any>, pendingKept: boolean): Checks {
  const tg = targets(t)
  const texts = (pkg: D.Pkg) => D.paras(D.docXml(pkg)).map(p => p.text)
  const bodyOf = (pkg: D.Pkg) => { const ps = texts(pkg); const k = ps.findIndex(x => /^References\s*$/.test(x.trim())); return (k >= 0 ? ps.slice(0, k) : ps).join('\n') }
  const rawIds = (s: string) => (s.match(/10\.\d{4,9}\/\S+|PMID[:：]?\s*\d{5,}/gi) ?? []).length
  const raw = rawIds(bodyOf(after)) > rawIds(bodyOf(src))
  const out = (done: boolean, human: boolean | null, detail = ''): Checks => ({ done, human_kept: human, raw_id_added: raw, detail })
  const changed = (prefix: string) => !texts(after).includes(texts(src).find(x => startsWith(x, prefix)) ?? '\u0000')
  const textNotes = (ps: D.Para[]) => ps.filter(p => D.headingLevel(p) === 0 && p.text.length > 80 && !/^(Table|Figure|Fig\.?)\s*\d/.test(p.text) && !/^Abbreviations?\b/i.test(p.text))
  switch (task.archetype) {
    case 'concurrent_edit': {
      const body = bodyOf(after)
      const kept = !state.edited || (body.includes('Supplementary Table S2') && body.includes(state.marker as string))
      return out(changed(tg.disc1), state.edited ? kept : null, state.edited ? (kept ? '' : '医生插入的内容丢失') : '人类编辑未触发')
    }
    case 'citation':
      return out(changed(tg.intro1) && !raw, null, raw ? '正文新增了裸 DOI / PMID' : '')
    case 'pending_suggestion':
      return out(true, pendingKept, pendingKept ? '' : '医生的待采纳修订不见了')
    case 'open_comment_anchor': {
      const anchored = COMMENTS.filter(c => D.commentAnchored(after, c)).length
      return out(changed(tg.methods.first), anchored === COMMENTS.length, anchored === COMMENTS.length ? '' : `${COMMENTS.length - anchored} 条批注锚点丢失`)
    }
    case 'term_unify': {
      const count = (pkg: D.Pkg, re: RegExp) => sectionParas(pkg, /^(materials? and )?(methods?|patients and methods|methodology)\b/i).filter(p => D.headingLevel(p) === 0).reduce((a, p) => a + (p.text.match(re) ?? []).length, 0)
      const left = count(after, /\bpatients\b/g)
      return out(left === 0 && count(after, /\bparticipants\b/g) >= count(src, /\bpatients\b/g), null, `剩余 patients ${left} 处`)
    }
    case 'table_row': {
      const { row, newRow } = firstTable(t)
      const ps = texts(after).map(x => x.trim())
      const i = ps.indexOf(row)
      // 表格单元格逐格是段落：指定行之后紧接着一行的第一格是新行名
      const width = ps.slice(i + 1).findIndex(x => x === newRow) + 1
      return out(i >= 0 && width > 0 && width <= 12 && ps.slice(i + width + 1, i + width * 2).every(x => x === 'NR'), null)
    }
    case 'p_value_format': {
      const good = pTarget(t) === 'zero' ? P_GOOD : P_GOOD_NOZERO
      const pv = (pkg: D.Pkg) => textNotes(sectionParas(pkg, /^results\b/i)).flatMap(p => [...p.text.matchAll(P_VALUE)].map(m => m[0]))
      const now = pv(after)
      const bad = now.filter(x => !good.test(x)).length
      return out(bad === 0 && now.length >= pv(src).length, null, `${bad} 处格式不对`)
    }
    case 'move_subsection': {
      const m = movable(t)
      const res = sectionParas(after, /^results\b/i)
      const ok = m.kind === 'sub'
        ? res.filter(p => D.headingLevel(p) === 3).at(-1)?.text.trim() === m.title
        : (textNotes(res).at(-1)?.text ?? '').startsWith(m.lead)
      return out(ok, null, ok ? '' : '没有移到结果部分最后')
    }
    default:
      return out(true, null)
  }
}

/** 单段任务的目标段（原文纯文字）；整节任务没有。 */
export function measureTarget(task: Task<PaperTopic>, t: PaperTopic): string | undefined {
  const tg = targets(t)
  return ({ concurrent_edit: tg.disc1, citation: tg.intro1, pending_suggestion: tg.res1, open_comment_anchor: tg.methods.first, out_of_scope_revert: tg.disc3 } as Record<string, string>)[task.archetype]
}

export function measure(task: Task<PaperTopic>, t: PaperTopic, src: D.Pkg, after: D.Pkg) {
  const target = measureTarget(task, t)
  // 整节改动的任务（统一用词、P 值、移动）：不计入「不该动的段落」的是整节，这里只度量目标段以外的格式与内容
  const sectionWide = ['term_unify', 'p_value_format', 'move_subsection', 'table_row'].includes(task.archetype)
  const inSection = (x: string) => {
    if (!sectionWide) return false
    const re = task.archetype === 'term_unify' ? /^(materials? and )?(methods?|patients and methods|methodology)\b/i : /^results\b/i
    return sectionParas(src, re).some(p => p.text === x)
  }
  return {
    damage: D.damage(src, after, x => (target ? startsWith(x, target) : false) || inSection(x)),
    format: target ? D.formatKept(src, after, target.slice(0, 60), []) : null,
  }
}

interface Row {
  arm: string; user: string; session: number; paper: string; archetype: string; status: string; ms: number; calls: string[]
  guard_rejections: number; checks: Checks; damage: D.Damage; format: D.FormatKept | null; acknowledged?: boolean
}

function shuffle<T>(xs: T[], seed: number): T[] {
  let a = seed >>> 0
  const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!] }
  return out
}

const toolName = (n: unknown) => String(n ?? '?').replace(/^mcp__heurion__/, '')
const paperOf = (session: number, seed: number) => papers[(session - 1 + seed * 3) % papers.length]!

// —— MCP 组 ——

async function runMcp(base: string, user: string, seed: number, out: string): Promise<void> {
  const c = client(base, user)
  for (let session = 1; session <= Number(values.sessions); session++) {
    const t = paperOf(session, seed)
    for (const task of shuffle(PAPERS.tasks, seed * 1000 + session)) {
      const t0 = Date.now()
      const src = sourceOf(t)
      let row: Row
      try {
        const docId = await PAPERS.create(c, t, `exp2a ${task.archetype}`)
        const ctx: TaskCtx<PaperTopic> = { c, docId, topic: t, before: await PAPERS.read(c, docId), state: {} }
        if (task.prepare) { await task.prepare(ctx); ctx.before = await PAPERS.read(c, docId) }
        const seen: UiEvent[] = []
        const events = await c.chat(docId, task.message(t), async e => { seen.push(e); await task.onEvent?.(ctx, e, seen) })
        const res = await fetch(`${base}/api/docs/${docId}/export.docx`, { headers: { Authorization: c.auth } })
        const after = D.openDocx(new Uint8Array(await res.arrayBuffer()))
        const d = await c.api(`/api/docs/${docId}`)
        const thread = (d.comments as Array<{ id: string; replies: Array<{ role: string }> }>)
        keep(out, 'mcp', user, session, task.archetype, after)
        const errors = events.filter(e => e.type === 'tool_result' && e.isError).map(e => e.code as string | undefined)
        row = {
          arm: 'mcp', user, session, paper: t.pmcid, archetype: task.archetype,
          status: (events.find(e => e.type === 'turn_done')?.status as string | undefined) ?? 'unknown', ms: Date.now() - t0,
          calls: events.filter(e => e.type === 'tool_call').map(e => toolName(e.name)),
          guard_rejections: errors.filter(code => code && GUARD_CODES.has(code)).length,
          checks: check(task, t, src, after, ctx.state, (d.suggestions as unknown[]).length > 0),
          ...measure(task, t, src, after),
          acknowledged: task.archetype === 'open_comment_anchor' ? ((ctx.state.comments as string[] | undefined) ?? []).every(id => thread.find(x => x.id === id)?.replies.some(r => r.role === 'ai')) : undefined,
        }
      } catch (err) { row = errorRow('mcp', user, session, t, task, t0, err) }
      log(out, row)
    }
  }
}

// —— 对照组：python-docx 直接改文件 ——

async function runFile(user: string, seed: number, out: string): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('对照组需要 DEEPSEEK_API_KEY（用 --env-file 加载根目录 .env）')
  for (let session = 1; session <= Number(values.sessions); session++) {
    const t = paperOf(session, seed)
    const tg = targets(t)
    for (const task of shuffle(PAPERS.tasks, seed * 1000 + session)) {
      const t0 = Date.now()
      const src = sourceOf(t)
      let row: Row
      const cwd = mkdtempSync(join(tmpdir(), 'exp2a-'))
      const file = join(cwd, 'manuscript.docx')
      const harness = new DeepSeekHarness({
        profile: 'sdk', patches: [join(here, '../exp3/baseline.cordis.yml')], dshHome: join(cwd, '.dsh-home'), cwd, processCwd: cwd,
        env: {
          PATH: `${VENV_BIN}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? cwd, LANG: process.env.LANG ?? 'C.UTF-8',
          DEEPSEEK_API_KEY: apiKey, DEEPSEEK_BASE_URL: process.env.DEEPSEEK_UPSTREAM_URL || 'https://api.deepseek.com/anthropic/v1',
          DSH_PRIMARY_RUNTIME: '', PIP_NO_INDEX: '1',
        },
        provider: process.env.DSH_PROVIDER || 'deepseek-official', model: process.env.DSH_MODEL || 'deepseek-flash', initializeTimeoutMs: 60_000,
      })
      try {
        let start: D.Pkg | null = src
        if (task.archetype === 'pending_suggestion') start = D.humanTrackedChange(src, tg.res1.slice(0, 60), tg.res1Phrase, `${tg.res1Phrase} (intention-to-treat population)`, 'Dong Qian')
        if (task.archetype === 'open_comment_anchor') {
          start = D.humanComment(src, tg.methods.first.slice(0, 60), tg.methods.snippets[0], COMMENTS[0], 'Dong Qian', 0)
          start = start && D.humanComment(start, tg.methods.first.slice(0, 60), tg.methods.snippets[1], COMMENTS[1], 'Dong Qian', 1)
        }
        if (!start) throw new Error('人类操作没能写进文件（目标文字跨了格式边界）')
        writeFileSync(file, D.saveDocx(start))
        const state: Record<string, any> = {}
        const events: UiEvent[] = []
        const sessionId = randomUUID()
        await harness.run(task.message(t), {
          sessionId,
          onNotification: (n: Parameters<typeof mapNotification>[0]) => {
            for (const e of mapNotification(n, sessionId) as UiEvent[]) {
              events.push(e)
              if (task.archetype === 'concurrent_edit') humanEditsFile(e, events, file, tg.disc1, tg.discAnchor, state)
            }
          },
        })
        const after = D.openDocx(new Uint8Array(readFileSync(file)))
        keep(out, 'file', user, session, task.archetype, after)
        row = {
          arm: 'file', user, session, paper: t.pmcid, archetype: task.archetype, status: 'done', ms: Date.now() - t0,
          calls: events.filter(e => e.type === 'tool_call').map(e => toolName(e.name)), guard_rejections: 0,
          checks: check(task, t, src, after, state, D.hasTrackedChange(after)),
          ...measure(task, t, src, after),
        }
      } catch (err) { row = errorRow('file', user, session, t, task, t0, err) } finally { await harness.close().catch(() => {}) }
      log(out, row)
    }
  }
}

/** 回合中途：AI 每读完一次文件，医生就在讨论第一段末尾补一处（最多 3 次），与平台组同样的节奏。 */
export function humanEditsFile(e: UiEvent, events: UiEvent[], file: string, para: string, anchor: string, state: Record<string, any>): void {
  if (e.type !== 'tool_result' || e.isError) return
  const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
  if (!/manuscript/.test(String(call?.arguments ?? ''))) return
  const k = (state.edits as number | undefined) ?? 0
  if (k >= 3 || state.stopped) return
  const pkg = D.openDocx(new Uint8Array(readFileSync(file)))
  const prefix = para.slice(0, 60)
  const next = k === 0 ? D.humanReplace(pkg, prefix, anchor, `${anchor} (see Supplementary Table S2)`) : D.humanReplace(pkg, prefix, `S${k + 1})`, `S${k + 1}, S${k + 2})`)
  if (!next) { state.stopped = true; return }
  writeFileSync(file, D.saveDocx(next))
  state.edits = k + 1
  state.edited = true
  state.marker = `S${k + 2})`
}

function errorRow(arm: string, user: string, session: number, t: PaperTopic, task: Task<PaperTopic>, t0: number, err: unknown): Row {
  return {
    arm, user, session, paper: t.pmcid, archetype: task.archetype, status: 'harness_error', ms: Date.now() - t0, calls: [], guard_rejections: 0,
    checks: { done: false, human_kept: null, raw_id_added: false, detail: String((err as Error).message ?? err) },
    damage: { untouched: 0, identical: 0, format_drift: 0, content_changed: 0, styles_intact: false, changed_parts: [] }, format: null,
  }
}

function keep(out: string, arm: string, user: string, session: number, archetype: string, pkg: D.Pkg): void {
  const dir = join(out, '..', 'docx')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${arm}-${user}-s${session}-${archetype}.docx`), D.saveDocx(pkg))
}

function log(out: string, row: Row): void {
  appendFileSync(out, JSON.stringify(row) + '\n')
  const c = row.checks
  console.log(`[${row.arm}] ${row.user} s${row.session} ${row.paper} ${row.archetype.padEnd(20)} ${row.status.padEnd(8)} 完成 ${c.done ? '✓' : '✗'} 医生 ${c.human_kept === null ? '-' : c.human_kept ? '✓' : '✗'} 段落原样 ${row.damage.identical}/${row.damage.untouched} 格式 ${row.format ? Object.values(row.format).filter(Boolean).length + '/5' : '-'} ${c.detail} ${(row.ms / 1000).toFixed(0)}s`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(repoRoot, 'paper/results/exp2a-papers', stamp)
  mkdirSync(outDir, { recursive: true })
  const arms = values.arms!.split(',')
  const users = Number(values.users)
  const seed0 = Number(values.seed)
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
    started_at: new Date().toISOString(),
    commit: execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(),
    dirty: execSync('git status --porcelain --untracked-files=no', { cwd: repoRoot }).toString().trim() !== '',
    model: process.env.DSH_MODEL || 'deepseek-flash', arms, users, sessions: Number(values.sessions), seed: seed0,
  }, null, 2))

  const server = arms.includes('mcp')
    ? await startServer('mcp', Number(values.port), join(here, '../exp3/data', `exp2a-papers-${stamp}`), join(outDir, 'server-mcp.log'), { PROCEDURAL_MODE: 'off' })
    : null
  try {
    // 用户之间互不影响：两组内的用户同时跑
    const ks = Array.from({ length: users }, (_, k) => k)
    await Promise.all([
      ...(server ? ks.map(k => runMcp(server.base, `exp2a-mcp-u${k + 1}`, seed0 + k, join(outDir, 'turns-mcp.jsonl'))) : []),
      ...(arms.includes('file') ? ks.map(k => runFile(`exp2a-file-u${k + 1}`, seed0 + k, join(outDir, 'turns-file.jsonl'))) : []),
    ])
  } finally {
    if (server) stopServer(server)
  }
  console.log(`结果目录：${outDir}`)
}
