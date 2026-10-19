import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, type HarnessNotification, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import { issueToken } from '../auth/token.ts'
import type { Config } from '../config.ts'

export const PROFILE_PATCH = fileURLToPath(new URL('./profile/heurion.cordis.yml', import.meta.url))
/** 隔离模式下 SDK 运行的「dsh」：经 sudo 降到用户专属 uid 再启动真正的 dsh。 */
const SANDBOX_LAUNCH = fileURLToPath(new URL('./sandbox-launch.mjs', import.meta.url))

/** 与 SDK 同版本的 dsh 可执行文件（SDK 默认启动的那个；SDK 没有导出解析函数）。 */
function realDshBin(): string {
  const sdk = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client')
  const manifestPath = createRequire(sdk).resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: string | Record<string, string> }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh!
  return resolve(dirname(manifestPath), bin)
}

interface Entry {
  harness: DeepSeekHarness
  /** 本进程里建立的会话；SDK 不能跨进程恢复会话。 */
  sessionId: string | null
  lastUsed: number
  busy: boolean
  /** 进程代号，写进它的 MCP 令牌；进程被停止（entry 删除）后旧令牌立即失效。 */
  generation: string
}

/**
 * 每个用户一个 dsh 进程（PLATFORM.md §8）：文档不在工作区里，一个会话可以编辑该用户的多份文档。
 * 工作区只放脚本、中间数据与待上传的资产。取消 = 关闭进程（SDK 没有取消方法）。
 */
export class HarnessPool {
  private readonly entries = new Map<string, Entry>()
  private readonly reaper: NodeJS.Timeout

  /** sandboxUid：隔离模式下平台用户 → 专属 uid（Store.sandboxUid）。 */
  constructor(
    private readonly config: Config,
    private readonly sandboxUid?: (userId: string) => number,
    private readonly patchOverlay?: () => string | null,
  ) {
    this.reaper = setInterval(() => void this.reapIdle(), 60_000)
    this.reaper.unref()
  }

  /** 获取要挂载的 profile patches 列表（基础补丁 + 动态自演进补丁）。 */
  getPatches(dshHome: string): string[] {
    const overlayYaml = this.patchOverlay?.()
    if (!overlayYaml || !overlayYaml.trim()) {
      return [PROFILE_PATCH]
    }
    const overlayPath = join(dshHome, 'evolved.cordis.yml')
    try {
      mkdirSync(dshHome, { recursive: true })
      writeFileSync(overlayPath, overlayYaml, 'utf8')
      return [PROFILE_PATCH, overlayPath]
    } catch {
      return [PROFILE_PATCH]
    }
  }

  workspaceDir(userId: string): string {
    const dir = `${this.config.workspacesDir}/${safeName(userId)}`
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 该用户 dsh 的 home（隔离模式下与工作区一起交给启动器；多并发 slot 各自独立防锁冲突）。 */
  homeDir(userId: string, slot = 'default'): string {
    const base = this.config.dshHomesDir || join(this.config.dataDir, 'dsh-homes')
    const suffix = slot !== 'default' ? `${safeName(userId)}_${safeName(slot)}` : safeName(userId)
    return `${base}/${suffix}`
  }

  /** 隔离模式：启动器参数（uid、工作区、该用户自己的 dsh home、真正的 dsh）。 */
  private sandboxEnv(userId: string, slot = 'default'): NodeJS.ProcessEnv {
    if (!this.config.sandbox) return {}
    if (!this.sandboxUid) throw new Error('隔离模式需要 sandboxUid')
    return {
      HEURION_SANDBOX_UID: String(this.sandboxUid(userId)),
      HEURION_SANDBOX_WORKSPACE: this.workspaceDir(userId),
      HEURION_SANDBOX_HOME: this.homeDir(userId, slot),
      HEURION_DSH_BIN: realDshBin(),
    }
  }

  private childEnv(userId: string, generation: string, slot = 'default'): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? this.config.dshHome,
      LANG: process.env.LANG ?? 'C.UTF-8',
      // 模型调用经平台代理：这里给的是每用户、绑定进程代号的代理令牌，不是真实 API key
      DEEPSEEK_API_KEY: issueToken(this.config.secret, { u: userId, d: [], p: [], aud: 'llm', ttlSeconds: 24 * 3600, s: generation }),
      DEEPSEEK_BASE_URL: this.config.llmProxyUrl,
      HEURION_MCP_URL: this.config.mcpUrl,
      // MCP 令牌比进程的最长空闲时间长；进程回收后重新签发
      HEURION_MCP_TOKEN: issueToken(this.config.secret, { u: userId, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 24 * 3600, s: generation }),
      // 不加载 dsh office 技能：文档编辑只走 MCP
      DSH_PRIMARY_RUNTIME: '',
      PIP_NO_INDEX: '1',
      ...this.sandboxEnv(userId, slot),
    }
  }

  private entryKey(userId: string, slot = 'default'): string {
    return `${userId}#${slot}`
  }

  generation(userId: string, slot = 'default'): string {
    return this.entry(userId, slot).generation
  }

  getOrCreate(userId: string, slot = 'default'): Entry {
    return this.entry(userId, slot)
  }

  private entry(userId: string, slot = 'default'): Entry {
    const key = this.entryKey(userId, slot)
    const existing = this.entries.get(key)
    if (existing) {
      existing.lastUsed = Date.now()
      return existing
    }
    const cwd = this.workspaceDir(userId)
    const generation = randomUUID()
    const dshHome = this.config.sandbox || (this.config.sandbox !== false && slot !== 'default') || slot !== 'default'
      ? this.homeDir(userId, slot)
      : this.config.dshHome
    const e: Entry = {
      harness: new DeepSeekHarness({
        profile: 'sdk',
        patches: this.getPatches(dshHome),
        // 隔离模式或多并发 slot：dsh home 按用户与 slot 隔离，防并发进程争抢锁
        dshHome,
        ...(this.config.sandbox ? { dshBin: SANDBOX_LAUNCH } : {}),
        cwd,
        processCwd: cwd,
        env: this.childEnv(userId, generation, slot),
        provider: this.config.provider,
        model: this.config.model,
        initializeTimeoutMs: 60_000,
      }),
      sessionId: null,
      lastUsed: Date.now(),
      busy: false,
      generation,
    }
    this.entries.set(key, e)
    return e
  }

  /** 令牌里的进程代号是否仍是该用户当前的任意一个有效 dsh 进程。 */
  isLive(userId: string, generation: string): boolean {
    for (const [key, e] of this.entries) {
      if (key.startsWith(`${userId}#`) && e.generation === generation) return true
    }
    return false
  }

  isBusy(userId: string, slot?: string): boolean {
    if (slot !== undefined) {
      return this.entries.get(this.entryKey(userId, slot))?.busy ?? false
    }
    for (const [key, e] of this.entries) {
      if (key.startsWith(`${userId}#`) && e.busy) return true
    }
    return false
  }

  /** null 表示下一次 run 会开新会话（调用方应补上历史上下文）。 */
  liveSession(userId: string, slot = 'default'): string | null {
    if (this.config.freshSessionPerTurn) return null
    return this.entries.get(this.entryKey(userId, slot))?.sessionId ?? null
  }

  async run(userId: string, prompt: string, onNotification: (n: HarnessNotification, sessionId: string) => void, slot = 'default'): Promise<RunResult> {
    const e = this.entry(userId, slot)
    if (e.busy) throw new Error('busy')
    e.busy = true
    e.lastUsed = Date.now()
    if (this.config.freshSessionPerTurn) e.sessionId = randomUUID()
    else e.sessionId ??= randomUUID()
    const sessionId = e.sessionId
    try {
      return await e.harness.run(prompt, { sessionId, onNotification: n => onNotification(n, sessionId) })
    } finally {
      e.busy = false
      e.lastUsed = Date.now()
    }
  }

  async cancel(userId: string, slot?: string): Promise<void> {
    if (slot !== undefined) {
      const key = this.entryKey(userId, slot)
      const e = this.entries.get(key)
      if (!e) return
      this.entries.delete(key)
      await e.harness.close().catch(() => {})
      return
    }
    const targets = [...this.entries.entries()].filter(([k]) => k.startsWith(`${userId}#`))
    for (const [key] of targets) {
      this.entries.delete(key)
    }
    for (const [, e] of targets) {
      await e.harness.close().catch(() => {})
    }
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.config.harnessIdleMs
    for (const [key, e] of this.entries) {
      if (!e.busy && e.lastUsed < cutoff) {
        this.entries.delete(key)
        await e.harness.close().catch(() => {})
      }
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.reaper)
    const all = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(all.map(e => e.harness.close().catch(() => {})))
  }
}

const safeName = (userId: string) => userId.replace(/[^a-zA-Z0-9_-]/g, '_')
