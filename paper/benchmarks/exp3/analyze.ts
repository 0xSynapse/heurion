/**
 * 实验 3 汇总：读各组的回合 JSONL 与平台数据库（执行信号、习得规则），写 summary.json。
 *   npx tsx ../../paper/benchmarks/exp3/analyze.ts <结果目录> <组>=<platform.db 路径> ...
 * 守卫拦截有两个来源：回合事件里的工具报错（doc_edit 等）与数据库里的执行信号（还包括 doc_validate 预检失败）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TurnRow } from './run.ts'

interface SessionStat {
  session: number
  split: string
  turns: number
  /** 非预置 archetype 的目标码拦截（主要终点用的量）。 */
  novel_target_rejections: number
  seeded_target_rejections: number
  guard_rejections: number
  /** 数据库执行信号（含预检失败、用户撤销）。 */
  signals: number
  success: number
  validate_calls: number
  tool_calls: number
  mean_seconds: number
  /** 按用户顺序的执行信号数（用户是独立重复单位）。 */
  signals_by_user: number[]
}

export function analyze(outDir: string, dbs: Record<string, string>) {
  const files = readdirSync(outDir).filter(f => /^turns-.+\.jsonl$/.test(f))
  const arms: Record<string, unknown> = {}

  for (const f of files) {
    const arm = f.slice('turns-'.length, -'.jsonl'.length)
    const rows = readFileSync(join(outDir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as TurnRow)
    const signalsByTurn = new Map<string, Array<{ kind: string; code: string }>>()
    const learned: Array<{ owner: string; trigger_pattern: string; rule: string; evidence_count: number; created_at: string }> = []

    const users = [...new Set(rows.map(r => r.user_id))]
    const dbPath = dbs[arm]
    if (dbPath && existsSync(dbPath) && rows.length > 0) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      for (const owner of users) {
        for (const s of db.prepare('SELECT turn_id, kind, code FROM execution_signals WHERE owner = ?').all(owner) as Array<{ turn_id: string | null; kind: string; code: string }>) {
          if (!s.turn_id) continue
          signalsByTurn.set(s.turn_id, [...(signalsByTurn.get(s.turn_id) ?? []), { kind: s.kind, code: s.code }])
        }
        learned.push(...(db.prepare('SELECT owner, trigger_pattern, rule, evidence_count, created_at FROM harness_rules WHERE owner = ? ORDER BY created_at').all(owner) as typeof learned))
      }
      db.close()
    }

    const sessions = [...new Set(rows.map(r => r.session))].sort((a, b) => a - b)
    const perSession: SessionStat[] = sessions.map(session => {
      const rs = rows.filter(r => r.session === session)
      const sum = (fn: (r: TurnRow) => number) => rs.reduce((a, r) => a + fn(r), 0)
      return {
        session,
        split: rs[0]!.split,
        turns: rs.length,
        novel_target_rejections: sum(r => (r.seeded ? 0 : r.target_rejections)),
        seeded_target_rejections: sum(r => (r.seeded ? r.target_rejections : 0)),
        guard_rejections: sum(r => r.guard_rejections),
        signals: sum(r => (r.turn_id ? signalsByTurn.get(r.turn_id)?.length ?? 0 : 0)),
        success: sum(r => (r.success ? 1 : 0)),
        validate_calls: sum(r => r.validate_calls),
        tool_calls: sum(r => r.calls.length),
        mean_seconds: Number((sum(r => r.ms) / rs.length / 1000).toFixed(1)),
        signals_by_user: users.map(u => rs.filter(r => r.user_id === u).reduce((a, r) => a + (r.turn_id ? signalsByTurn.get(r.turn_id)?.length ?? 0 : 0), 0)),
      }
    })

    // 每种 archetype 的目标码是否真的被诱发过：预跑首先要确认布置有效
    const byArchetype = Object.fromEntries([...new Set(rows.map(r => r.archetype))].map(a => {
      const rs = rows.filter(r => r.archetype === a)
      return [a, {
        turns: rs.length,
        induced: rs.filter(r => r.target_rejections > 0 || (r.turn_id && signalsByTurn.get(r.turn_id)?.some(s => s.code === r.code))).length,
        success: rs.filter(r => r.success).length,
        harness_errors: rs.filter(r => r.status === 'harness_error').length,
      }]
    }))

    arms[arm] = {
      users,
      turns: rows.length,
      failed_turns: rows.filter(r => r.status !== 'done').length,
      per_session: perSession,
      by_archetype: byArchetype,
      learned_rules: learned,
    }
  }

  const summary = { generated_at: new Date().toISOString(), arms }
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  return summary
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outDir, ...pairs] = process.argv.slice(2)
  if (!outDir) throw new Error('用法：analyze.ts <结果目录> <组>=<platform.db> ...')
  const dbs = Object.fromEntries(pairs.map(p => p.split('=', 2) as [string, string]))
  console.log(JSON.stringify(analyze(outDir, dbs), null, 2))
}
