/**
 * 实验 3：对一个已经在跑的平台实例（一个实验组）跑多会话任务序列，每个回合写一行 JSONL。
 *   npx tsx ../../paper/benchmarks/exp3/run.ts --base http://127.0.0.1:8790 --arm utility --user exp3-u1 --out out.jsonl
 * 同一 seed 下各组的会话主题与任务顺序相同（配对设计）。
 */
import { appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { client, type UiEvent } from './client.ts'
import { GUARD_CODES, SIMPLE, type Corpus, type TaskCtx } from './tasks.ts'

export interface RunOpts {
  base: string
  arm: string
  user: string
  sessions: number
  /** 最后几个会话用留出主题。 */
  heldout: number
  seed: number
  out: string
  /** 稿件集：simple = 短稿模板；papers = 开放获取论文改编的长稿。 */
  corpus?: 'simple' | 'papers'
}

export interface TurnRow {
  arm: string
  user: string
  user_id: string
  seed: number
  session: number
  split: 'train' | 'heldout'
  topic: string
  order: number
  archetype: string
  code: string
  seeded: boolean
  doc_id: string
  turn_id: string | null
  status: string
  ms: number
  calls: string[]
  /** 工具报错（含非守卫错误）。 */
  errors: Array<{ tool: string; code: string | null }>
  /** 回合内守卫拦截次数（doc_edit 等返回的守卫码）。 */
  guard_rejections: number
  /** 回合内命中本任务目标码的拦截次数。 */
  target_rejections: number
  validate_calls: number
  reverted: boolean
  success: boolean
  detail: string
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const toolName = (n: unknown) => String(n ?? '?').replace(/^mcp__heurion__/, '')

export async function runArm(o: RunOpts): Promise<TurnRow[]> {
  const c = client(o.base, o.user)
  const me = await c.api<{ id?: string; user?: string }>('/api/me')
  const userId = me.id ?? me.user ?? o.user
  const rows: TurnRow[] = []

  const corpus: Corpus<any> = o.corpus === 'papers' ? (await import('../manuscripts/tasks.ts')).PAPERS : SIMPLE
  // 长稿集：不同用户从不同论文开始轮换，覆盖全部论文；短稿集保持原来的顺序（可与旧结果对照）
  const offset = corpus.name === 'papers' ? o.seed : 0
  for (let session = 1; session <= o.sessions; session++) {
    const split = session > o.sessions - o.heldout ? 'heldout' : 'train'
    const pool = split === 'heldout' ? corpus.heldout : corpus.train
    const topic = pool[(session - 1 + offset) % pool.length]
    const tasks = shuffle(corpus.tasks, rng(o.seed * 1000 + session))

    for (const [order, task] of tasks.entries()) {
      const t0 = Date.now()
      const row: TurnRow = {
        arm: o.arm, user: o.user, user_id: userId, seed: o.seed, session, split, topic: corpus.key(topic), order,
        archetype: task.archetype, code: task.code, seeded: task.seeded, doc_id: '', turn_id: null,
        status: 'harness_error', ms: 0, calls: [], errors: [], guard_rejections: 0, target_rejections: 0,
        validate_calls: 0, reverted: false, success: false, detail: '',
      }
      try {
        const docId = await corpus.create(c, topic, `exp3 s${session} ${task.archetype}`)
        row.doc_id = docId
        const ctx: TaskCtx<any> = { c, docId, topic, before: await corpus.read(c, docId), state: {} }
        if (task.prepare) {
          await task.prepare(ctx)
          ctx.before = await corpus.read(c, docId)
        }

        const seen: UiEvent[] = []
        const events = await c.chat(docId, task.message(topic), async e => {
          seen.push(e)
          await task.onEvent?.(ctx, e, seen)
        })
        row.turn_id = (events.find(e => e.type === 'turn')?.turn_id as string | undefined) ?? null
        row.status = (events.find(e => e.type === 'turn_done')?.status as string | undefined) ?? 'unknown'
        row.calls = events.filter(e => e.type === 'tool_call').map(e => toolName(e.name))
        row.validate_calls = row.calls.filter(n => n === 'doc_validate').length
        row.errors = events.filter(e => e.type === 'tool_result' && e.isError).map(e => ({
          tool: toolName(events.find(x => x.type === 'tool_call' && x.callId === e.callId)?.name),
          code: (e.code as string | undefined) ?? null,
        }))
        row.guard_rejections = row.errors.filter(e => e.code && GUARD_CODES.has(e.code)).length
        row.target_rejections = row.errors.filter(e => e.code === task.code).length

        if (task.react && row.turn_id) row.reverted = await task.react(ctx, row.turn_id)
        const outcome = await task.oracle(ctx)
        row.success = outcome.ok
        row.detail = outcome.detail
      } catch (err) {
        row.detail = String((err as Error).message ?? err)
      }
      row.ms = Date.now() - t0
      rows.push(row)
      appendFileSync(o.out, JSON.stringify(row) + '\n')
      console.log(`[${o.arm}] s${session} ${row.archetype.padEnd(20)} ${row.status.padEnd(8)} 拦截 ${row.guard_rejections}（目标 ${row.target_rejections}）${row.reverted ? ' 已撤销' : ''} ${row.success ? '✓' : `✗ ${row.detail}`} ${(row.ms / 1000).toFixed(1)}s`)
    }
  }
  return rows
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://127.0.0.1:8787' },
      arm: { type: 'string', default: 'utility' },
      user: { type: 'string', default: 'exp3-u1' },
      sessions: { type: 'string', default: '4' },
      heldout: { type: 'string', default: '1' },
      seed: { type: 'string', default: '1' },
      out: { type: 'string', default: 'exp3.jsonl' },
    },
  })
  await runArm({
    base: values.base!, arm: values.arm!, user: values.user!, sessions: Number(values.sessions),
    heldout: Number(values.heldout), seed: Number(values.seed), out: values.out!,
  })
}
