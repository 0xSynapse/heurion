/**
 * 实验 3 预跑编排：每个实验组起一个独立的平台实例（独立数据目录，Layer 3 关闭、每回合新开 dsh 会话、
 * 关闭声明式记忆自动整理），并行跑同一任务序列，结束后汇总。
 *   cd apps/platform && npx tsx ../../paper/benchmarks/exp3/pilot.ts [--arms off,utility] [--users 1] [--sessions 4] [--heldout 1] [--seed 1]
 * 需要根目录 .env 里配置 DEEPSEEK_API_KEY。任务文本为合成内容，不含真实患者信息。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { analyze } from './analyze.ts'
import { runArm } from './run.ts'
import { repoRoot, startServer, stopServer, type Server } from './server.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

const { values } = parseArgs({
  options: {
    arms: { type: 'string', default: 'off,utility' },
    sessions: { type: 'string', default: '4' },
    heldout: { type: 'string', default: '1' },
    seed: { type: 'string', default: '1' },
    budget: { type: 'string', default: '1000' },
    port: { type: 'string', default: '8790' },
    users: { type: 'string', default: '1' },
    corpus: { type: 'string', default: 'simple' },
    // 组内用户同时跑（用户之间互不影响：规则、信号、文档都按用户隔离）
    'parallel-users': { type: 'boolean', default: false },
  },
})
const arms = values.arms!.split(',').map(s => s.trim()).filter(Boolean)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = join(repoRoot, 'paper/results/exp3', stamp)
// 目录名 data/ 已被 .gitignore 忽略
const dataRoot = join(here, 'data', stamp)
mkdirSync(outDir, { recursive: true })

const start = (arm: string, port: number): Promise<Server> =>
  startServer(arm, port, join(dataRoot, arm), join(outDir, `server-${arm}.log`), { PROCEDURAL_MODE: arm, PROCEDURAL_BUDGET: values.budget! })
const stop = stopServer

const meta = {
  started_at: new Date().toISOString(),
  commit: execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(),
  dirty: execSync('git status --porcelain', { cwd: repoRoot }).toString().trim() !== '',
  model: process.env.DSH_MODEL ?? 'deepseek-flash（平台默认）',
  arms,
  sessions: Number(values.sessions),
  heldout: Number(values.heldout),
  seed: Number(values.seed),
  budget: Number(values.budget),
  users: Number(values.users),
  corpus: values.corpus as 'simple' | 'papers',
  parallel_users: values['parallel-users'] ?? false,
  ended_at: '',
}

const servers: Server[] = []
try {
  for (const [i, arm] of arms.entries()) servers.push(await start(arm, Number(values.port) + i))
  // 各组并行；组内用户依次跑。第 k 个用户在各组用同一个 seed（配对设计），各用户之间 seed 不同
  await Promise.all(servers.map(async s => {
    const one = (k: number) => runArm({
      base: s.base,
      arm: s.arm,
      user: `exp3-${s.arm}-u${k + 1}`,
      sessions: meta.sessions,
      heldout: meta.heldout,
      seed: meta.seed + k,
      out: join(outDir, `turns-${s.arm}.jsonl`),
      corpus: meta.corpus,
    })
    const ks = Array.from({ length: meta.users }, (_, k) => k)
    if (meta.parallel_users) await Promise.all(ks.map(one))
    else for (const k of ks) await one(k)
  }))
} finally {
  servers.forEach(stop)
  meta.ended_at = new Date().toISOString()
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2))
}

// 平台退出后再读它的数据库（执行信号与习得规则）
await new Promise(r => setTimeout(r, 2000))
const summary = analyze(outDir, Object.fromEntries(servers.map(s => [s.arm, join(s.dataDir, 'platform', 'platform.db')])))
console.log(JSON.stringify(summary, null, 2))
console.log(`结果目录：${outDir}`)
