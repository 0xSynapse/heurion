/**
 * 离线重新判定（不调用模型）：判定程序改了之后，用结果目录里保存的 .docx 与记录重算每个回合的 eval，
 * 写到 turns-<arm>.reeval.jsonl（原记录不动，新记录带重算时的提交号）。
 * - compare.ts 的结果（压力 / 日常）：原稿按排程确定性重建，日常任务的布置状态取记录里的 state；
 * - session.ts 的结果（多轮会话）：每轮的改前稿件取保存的 *.before.docx，医生此前修改的标志取记录里的 keep。
 *   cd apps/platform && npx tsx --env-file-if-exists=../../.env ../../paper/benchmarks/v2/reeval.ts <结果目录> [--arms P,B1,B2]
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import * as D from '../exp3/docx.ts'
import { repoRoot } from '../exp3/server.ts'
import { check, measure } from '../manuscripts/compare.ts'
import { PAPERS } from '../manuscripts/tasks.ts'
import { evaluateNatural, evaluateStress, humanRevisionKept } from './oracles.ts'
import { sessionReady, stepTask } from './sessions.ts'
import { stressSchedule } from './stress.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const { values, positionals } = parseArgs({ allowPositionals: true, options: { arms: { type: 'string', default: 'P,B1,B2' } } })
const dir = positionals[0]
if (!dir) throw new Error('用法：reeval.ts <结果目录>')
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
const session = 'repeats' in meta || 'eligible' in meta
const commit = execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim()
const papers = [...PAPERS.train, ...PAPERS.heldout]
const paperOf = (id: string) => papers.find(p => p.pmcid === id)!
const open = (path: string) => D.openDocx(new Uint8Array(readFileSync(path)))
const schedule = session ? [] : stressSchedule(meta.seeds as number[])

for (const arm of values.arms!.split(',')) {
  const path = join(dir, `turns-${arm}.jsonl`)
  if (!existsSync(path)) continue
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const out: string[] = []
  let redone = 0
  let skipped = 0
  for (const r of rows) {
    try {
      if (r.status === 'harness_error') { skipped++; out.push(JSON.stringify(r)); continue }
      if (session) {
        const ready = sessionReady(paperOf(r.paper))!
        const step = ready.steps.find(s => s.id === r.step)!
        const base = join(dir, 'docx', `${arm}-${r.paper}-r${r.rep ?? 1}-a${r.attempt ?? 1}-${r.turn}-${r.step}`)
        if (!existsSync(`${base}.before.docx`)) throw new Error('缺改前稿件（早期运行没有保存）')
        const before = open(`${base}.before.docx`)
        r.eval = await evaluateStress(stepTask(step, before), { ...ready.ctx, source: before }, open(`${base}.docx`), r.keep ?? [], r.concurrent_injected)
      } else if (r.set === 'stress') {
        const job = schedule.find(j => j.seed === r.seed && j.paper.pmcid === r.paper && j.task.id === r.task)!
        const after = open(join(dir, 'docx', `${arm}-s${r.seed}-${r.paper}-${r.task}.docx`))
        r.eval = await evaluateStress(job.task, job.task.build(job.paper), after, [], r.concurrent_injected)
      } else {
        const paper = paperOf(r.paper)
        const task = PAPERS.tasks.find(t => t.archetype === r.task)!
        const src = open(join(here, '../manuscripts/data/docx', `${r.paper}.docx`))
        const after = open(join(dir, 'docx', `${arm}-s${r.seed}-${r.paper}-${r.task}.docx`))
        r.eval = await evaluateNatural(task, paper, src, after, check(task, paper, src, after, r.state ?? {}, humanRevisionKept(after)), measure(task, paper, src, after))
      }
      r.reeval = { at: new Date().toISOString(), commit }
      delete r.error
      redone++
    } catch (err) {
      r.reeval = { at: new Date().toISOString(), commit, error: String((err as Error).message).slice(0, 200) }
      skipped++
    }
    out.push(JSON.stringify(r))
  }
  writeFileSync(join(dir, `turns-${arm}.reeval.jsonl`), out.join('\n') + '\n')
  console.log(`${arm}：重算 ${redone} 个回合，跳过 ${skipped} 个 → turns-${arm}.reeval.jsonl`)
}
