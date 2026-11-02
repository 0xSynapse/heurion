import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chmodIfOwned } from '../mcp/admin-tools.ts'

/**
 * 运行 scripts/dataset_ingest.py：解析上传的表格、生成概况。上传的文件不可信——
 * 隔离模式下在该用户的隔离环境里运行（专属 uid、读不到平台数据，和 AI 写的代码同一套限制），文件经用户工作区中转；
 * 本地开发直接用 computePython 运行。
 */
export interface ColumnProfile {
  name: string; type: 'numeric' | 'categorical' | 'date' | 'text'; missing: number; unique: number; label?: string
  stats?: { mean: number | null; sd: number | null; median: number | null; q1: number | null; q3: number | null; min: number | null; max: number | null }
  top?: Array<{ value: string; count: number }>
  range?: [string, string]
  phi?: { reason: string }
}
export type Profile =
  | { ok: true; rows: number; columns: ColumnProfile[]; truncated: boolean; phi_resolved?: { dropped: string[]; kept: string[]; at: string } }
  | { ok: false; error: string }
export interface IngestResult { profile: Profile; csv: string | null; cleanup: () => void }
export type Ingest = (owner: string, src: string, drop: string[]) => Promise<IngestResult>

export interface IngestOptions {
  python: string
  script: string
  timeoutMs?: number
  /** 隔离模式：用户的 uid、工作区、dsh home（与 AI 进程同一个隔离环境）。 */
  sandbox?: { uid: (owner: string) => number; workspaceDir: (owner: string) => string; homeDir: (owner: string) => string } | null
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { err = (err + d).slice(-2000) })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(signal === 'SIGKILL' ? '解析超时' : `解析进程退出（${code}）：${err.trim().split('\n').pop() ?? ''}`))
    })
  })
}

export function makeIngest(opts: IngestOptions): Ingest {
  const timeout = opts.timeoutMs ?? 180_000
  return async (owner, src, drop) => {
    let stage: string
    if (opts.sandbox) {
      // 中转目录在用户工作区里（工作区 2770：只有该 uid 与平台能进）；目录与输入要让该 uid 能读写
      // 注意：首次运行 heurion-sandbox-exec 后 .datasets 属主会变为该用户的隔离 uid（组 node 可写），不能无条件 chmodSync 否则 EPERM
      const ws = opts.sandbox.workspaceDir(owner)
      const dsDir = join(ws, '.datasets')
      mkdirSync(dsDir, { recursive: true })
      chmodIfOwned(dsDir, 0o2777)
      stage = join(dsDir, randomUUID())
      mkdirSync(stage)
      chmodIfOwned(stage, 0o2777)
    } else {
      stage = mkdtempSync(join(tmpdir(), 'heurion-ds-'))
    }
    const cleanup = () => rmSync(stage, { recursive: true, force: true })
    try {
      const input = join(stage, 'input' + extname(src).toLowerCase())
      copyFileSync(src, input)
      chmodIfOwned(input, 0o644)
      const out = join(stage, 'out')
      const args = [opts.script, input, out, ...(drop.length ? ['--drop', ...drop] : [])]
      if (opts.sandbox) {
        await run('sudo', ['-n', '/usr/local/bin/heurion-sandbox-exec', String(opts.sandbox.uid(owner)), opts.sandbox.workspaceDir(owner), opts.sandbox.homeDir(owner), '--', 'python3', ...args], timeout)
      } else {
        await run(opts.python, args, timeout)
      }
      const profilePath = join(out, 'profile.json')
      if (lstatSync(out).isSymbolicLink() || lstatSync(profilePath).isSymbolicLink()) {
        throw new Error('不允许符号链接输出')
      }
      const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Profile
      const csvOut = join(out, 'data.csv')
      const hasCsv = profile.ok && existsSync(csvOut) && !lstatSync(csvOut).isSymbolicLink()
      return { profile, csv: hasCsv ? csvOut : null, cleanup }
    } catch (err) {
      cleanup()
      throw err
    }
  }
}
