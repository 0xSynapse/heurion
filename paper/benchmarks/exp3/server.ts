/**
 * 实验用的平台实例：独立数据目录、独立端口，detached 启动（按进程组结束，连同 dsh 子进程）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const platformDir = join(repoRoot, 'apps/platform')

export interface Server { arm: string; base: string; dataDir: string; proc: ChildProcess }

/** 起一个平台实例；env 覆盖实验开关（PROCEDURAL_MODE 等）。 */
export async function startServer(arm: string, port: number, dataDir: string, logPath: string, env: Record<string, string>): Promise<Server> {
  const homeDir = join(dataDir, 'home')
  mkdirSync(homeDir, { recursive: true })
  const log = createWriteStream(logPath)
  const proc = spawn('./node_modules/.bin/tsx', ['--env-file-if-exists=../../.env', 'src/index.ts'], {
    cwd: platformDir,
    detached: true,
    env: {
      ...process.env,
      HOME: homeDir,
      PORT: String(port),
      HEURION_DATA_DIR: dataDir,
      HARNESS_EVOLVE: '0',
      HARNESS_FRESH_SESSION: '1',
      MEMORY_AUTO_REVIEW: '0',
      DOC_PARSER_URL: 'off',
      ...env,
    },
  })
  proc.stdout!.pipe(log)
  proc.stderr!.pipe(log)
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { arm, base, dataDir, proc }
    } catch { /* 还没起来 */ }
    if (proc.exitCode !== null) break
    await new Promise(r => setTimeout(r, 500))
  }
  stopServer({ arm, base, dataDir, proc })
  throw new Error(`实验组 ${arm} 的平台没有起来，见 ${logPath}`)
}

export function stopServer(s: Server): void {
  try { process.kill(-s.proc.pid!, 'SIGTERM') } catch { /* 已退出 */ }
}
