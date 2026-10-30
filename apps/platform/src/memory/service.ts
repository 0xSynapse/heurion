import type { Embedder } from '../kb/embedder.ts'
import type { MemoryKind, MemoryRow, Store } from '../store/db.ts'
import { sensitiveReason } from './guard.ts'

/**
 * 记忆（参考 Claude 的记忆设计）：
 * - AI 提议进「待确认」，用户采纳后生效；用户明确要求「记住」时直接生效。
 * - 敏感内容（患者可识别信息、账号）写前拦截。
 * - 三层开关：管理员停用（删除全部）/ 用户暂停 / 单次对话不用记忆（回合选项，见 TurnOptions.memory）。
 * - 每回合按预算注入相关的已生效记忆（全局 + 当前文档所在项目），并记下使用次数（演进时归档长期不用的，见 evolve.ts）。
 */

export const MEMORY_KINDS: Record<MemoryKind, string> = { preference: '偏好', fact: '事实', style: '写法', term: '术语' }

export class MemoryError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) { super(message) }
}

export interface ProposeInput { content: string; kind: MemoryKind; scope: 'global' | 'project'; reason?: string | null; explicit?: boolean }
export interface ProposeContext { docId?: string | null; turnId?: string | null; source: MemoryRow['source']; actor: 'user' | 'ai' }
export type ProposeResult = { result: 'proposed' | 'active' | 'merged' | 'previously_rejected'; memory: MemoryRow }

/** 规范化：去空白与标点、小写（判断「同一条」）。 */
export const normalize = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

const SIMILAR = 0.95

/** 用户说法的字二元组有多少出现在记忆里（「百分比保留两位小数」对「百分比一律保留两位小数」≈ 0.9）。 */
function coverage(q: string, text: string): number {
  if (q.length < 2) return 0
  const grams = new Set<string>()
  for (let i = 0; i + 2 <= q.length; i++) grams.add(q.slice(i, i + 2))
  let hit = 0
  for (const g of grams) if (text.includes(g)) hit++
  return hit / grams.size
}
const dot = (a: Float32Array, b: Float32Array) => { let d = 0; for (let i = 0; i < a.length && i < b.length; i++) d += a[i]! * b[i]!; return d }

export class MemoryService {
  constructor(private readonly store: Store, private readonly embedder: Embedder | null) {}

  // —— 开关 ——

  instanceEnabled(): boolean { return this.store.getAppSetting('memory_enabled') !== '0' }
  paused(owner: string): boolean { return this.store.getUserSetting(owner, 'memory_paused') === '1' }
  /** 这个用户现在能用记忆吗（实例开启且没暂停）。 */
  active(owner: string): boolean { return this.instanceEnabled() && !this.paused(owner) }

  setPaused(owner: string, paused: boolean): void { this.store.setUserSetting(owner, 'memory_paused', paused ? '1' : null) }

  /** 管理员停用：删除所有用户的记忆。重新开启后从头开始。 */
  setInstanceEnabled(enabled: boolean): number {
    this.store.setAppSetting('memory_enabled', enabled ? '1' : '0')
    return enabled ? 0 : this.store.clearMemories()
  }

  private requireUsable(owner: string): void {
    if (!this.instanceEnabled()) throw new MemoryError('memory_disabled', '管理员已停用记忆')
    if (this.paused(owner)) throw new MemoryError('memory_paused', '用户已暂停记忆', '不要再提议记忆；需要时请用户在「记忆」里恢复。')
  }

  // —— 写入 ——

  /** AI 提议 / 用户手动添加 / 导入。重复的合并到已有条目；拒绝过的同一内容不再提议（除非用户明确要求）。 */
  async propose(owner: string, input: ProposeInput, ctx: ProposeContext): Promise<ProposeResult> {
    this.requireUsable(owner)
    const content = input.content.trim().replace(/\s+/g, ' ')
    if (!content) throw new MemoryError('empty', '记忆内容为空')
    if (content.length > 500) throw new MemoryError('too_long', '一条记忆不超过 500 字', '拆成几条短的，每条只记一件事。')
    if (!MEMORY_KINDS[input.kind]) throw new MemoryError('bad_kind', `种类只能是 ${Object.keys(MEMORY_KINDS).join(' / ')}`)
    const blocked = sensitiveReason(content)
    if (blocked) throw new MemoryError('sensitive_content', blocked, '告诉用户这条不能记住及原因；可以记不含个人信息的写法（例如「病例描述用『患者，男，60 余岁』这样的去标识写法」）。')

    let project_id: string | null = null
    if (input.scope === 'project') {
      project_id = ctx.docId ? this.store.getDoc(ctx.docId)?.project_id ?? null : null
      if (!project_id) throw new MemoryError('no_project', '当前文档不在任何项目里，不能存为项目记忆', '改用 scope=global，或请用户先把文档放进项目。')
    }
    const explicit = Boolean(input.explicit)
    const norm = normalize(content)
    const vec = await this.embed(content)
    const same = this.store.findMemoryByNorm(owner, norm) ?? this.similar(owner, vec)

    if (same && same.status !== 'archived') {
      if (same.status === 'rejected' && !explicit) return { result: 'previously_rejected', memory: same }
      if (explicit && same.status !== 'active') {
        this.store.updateMemory(same.id, { status: 'active', explicit: 1 })
        this.store.addMemoryEvent({ memory_id: same.id, owner, action: 'activate', actor: ctx.actor, before: same.status, after: 'active' })
      }
      return { result: 'merged', memory: this.store.getMemory(same.id)! }
    }

    const direct = explicit || ctx.source === 'manual'
    const row = this.store.addMemory({
      owner, scope: input.scope, project_id, kind: input.kind, content, norm, reason: input.reason?.trim() || null,
      source: ctx.source, source_doc_id: ctx.docId ?? null, source_turn_id: ctx.turnId ?? null,
      status: direct ? 'active' : 'proposed', explicit: explicit ? 1 : 0,
    })
    if (vec) this.store.setMemoryEmbedding(row.id, vec)
    this.store.addMemoryEvent({ memory_id: row.id, owner, action: 'create', actor: ctx.actor, before: null, after: JSON.stringify({ content, status: row.status }) })
    return { result: direct ? 'active' : 'proposed', memory: row }
  }

  /** 用户在记忆页里改：采纳 / 拒绝 / 改写 / 归档。 */
  async edit(owner: string, id: string, patch: { content?: string; kind?: MemoryKind; scope?: 'global' | 'project'; project_id?: string | null; status?: 'active' | 'rejected' | 'archived' }): Promise<MemoryRow> {
    const m = this.store.getMemory(id)
    if (!m || m.owner !== owner) throw new MemoryError('not_found', '记忆不存在')
    const next: Parameters<Store['updateMemory']>[1] = {}
    if (patch.content !== undefined) {
      const content = patch.content.trim().replace(/\s+/g, ' ')
      if (!content) throw new MemoryError('empty', '记忆内容为空')
      const blocked = sensitiveReason(content)
      if (blocked) throw new MemoryError('sensitive_content', blocked)
      next.content = content
      next.norm = normalize(content)
    }
    if (patch.kind) {
      if (!MEMORY_KINDS[patch.kind]) throw new MemoryError('bad_kind', '种类不对')
      next.kind = patch.kind
    }
    if (patch.scope) {
      next.scope = patch.scope
      next.project_id = patch.scope === 'project' ? patch.project_id ?? m.project_id : null
      if (patch.scope === 'project' && !next.project_id) throw new MemoryError('no_project', '项目记忆要选一个项目')
    }
    if (patch.status) next.status = patch.status
    this.store.updateMemory(id, next)
    if (next.content) this.store.setMemoryEmbedding(id, await this.embed(next.content))
    this.store.addMemoryEvent({ memory_id: id, owner, action: patch.status ? patch.status : 'edit', actor: 'user', before: JSON.stringify({ content: m.content, status: m.status }), after: JSON.stringify({ content: next.content ?? m.content, status: next.status ?? m.status }) })
    return this.store.getMemory(id)!
  }

  remove(owner: string, id: string): boolean {
    const m = this.store.getMemory(id)
    if (!m || m.owner !== owner) return false
    this.store.deleteMemory(id)
    return true
  }

  /**
   * 忘掉（用户明确要求「忘掉…」时 AI 调用）：按描述找已生效 / 待确认的记忆，唯一命中就彻底删除；
   * 命中多条且没指定 ids 时返回候选，让 AI 跟用户确认。暂停记忆、本轮不用记忆时也能忘（删除是用户的权利）。
   */
  async forget(owner: string, target: string, ids?: string[]): Promise<
    | { result: 'forgotten'; memories: MemoryRow[] }
    | { result: 'ambiguous'; candidates: MemoryRow[] }
    | { result: 'not_found' }
  > {
    if (!this.instanceEnabled()) throw new MemoryError('memory_disabled', '管理员已停用记忆，没有可忘的内容')
    const all = this.store.listMemories(owner, ['active', 'proposed'])
    let hits: MemoryRow[]
    if (ids?.length) hits = all.filter(m => ids.includes(m.id))
    else {
      // 去掉「那条、这个、记忆、忘掉」之类的说法，只留要找的内容
      const q = normalize(target).replace(/那条|这条|那个|这个|那句|这句|记忆|要求|偏好|规则|以后|不用了|忘掉|忘记|删掉|删除|请|吧|的/g, '')
      const qv = await this.embed(target)
      const vecs = qv ? new Map(this.store.memoryVectors(owner, ['active', 'proposed']).map(x => [x.id, x.v])) : new Map<string, Float32Array>()
      const scored = all.map(m => {
        const n = normalize(m.content)
        const text = q && (n.includes(q) || q.includes(n)) ? 1 : coverage(q, n)
        const vec = qv && vecs.get(m.id) ? dot(qv, vecs.get(m.id)!) : 0
        return { m, s: Math.max(text, vec), ok: text >= 0.6 || vec >= 0.75 }
      }).filter(x => x.ok).sort((a, b) => b.s - a.s)
      // 明显的最佳匹配（文字包含，或比第二名高出一截）当作唯一命中
      if (scored.length > 1 && scored[0]!.s - scored[1]!.s < 0.05) return { result: 'ambiguous', candidates: scored.slice(0, 8).map(x => x.m) }
      hits = scored.slice(0, 1).map(x => x.m)
    }
    if (hits.length === 0) return { result: 'not_found' }
    for (const m of hits) this.store.deleteMemory(m.id)
    return { result: 'forgotten', memories: hits }
  }

  // —— 使用 ——

  /** 适用于这份文档的已生效记忆（全局 + 文档所在项目）。 */
  applicable(owner: string, docId?: string | null): MemoryRow[] {
    const project = docId ? this.store.getDoc(docId)?.project_id ?? null : null
    return this.store.listMemories(owner, ['active']).filter(m => m.scope === 'global' || (project && m.project_id === project))
  }

  /** 回合开头注入的记忆块；超预算时按与本轮消息的相似度挑。不可用时返回空串。 */
  async forPrompt(owner: string, docId: string, message: string, budget = 1500): Promise<string> {
    if (!this.active(owner)) return ''
    let list = this.applicable(owner, docId)
    if (list.length === 0) return ''
    const total = list.reduce((n, m) => n + m.content.length + 8, 0)
    if (total > budget) {
      const q = await this.embed(message)
      if (q) {
        const vecs = new Map(this.store.memoryVectors(owner, ['active']).map(x => [x.id, x.v]))
        list = [...list].sort((a, b) => (vecs.get(b.id) ? dot(q, vecs.get(b.id)!) : 0) - (vecs.get(a.id) ? dot(q, vecs.get(a.id)!) : 0))
      }
      const picked: MemoryRow[] = []
      let used = 0
      for (const m of list) { if (used + m.content.length + 8 > budget) continue; picked.push(m); used += m.content.length + 8 }
      list = picked
    }
    this.store.touchMemories(list.map(m => m.id))
    return `［记忆］用户确认过的偏好与事实，本轮写入文档的内容必须遵守（即使下面的消息里给的写法不同，例如数字格式；只有用户明确要求例外时才不遵守）：\n${list.map(m => `- [${MEMORY_KINDS[m.kind]}] ${m.content}`).join('\n')}\n\n［本轮消息］\n`
  }

  /** memory_search：关键词（规范化包含）+ 向量相似度。 */
  async search(owner: string, query: string, docId?: string | null, limit = 10): Promise<MemoryRow[]> {
    const list = this.applicable(owner, docId)
    const q = normalize(query)
    const qv = await this.embed(query)
    const vecs = qv ? new Map(this.store.memoryVectors(owner, ['active']).map(x => [x.id, x.v])) : new Map<string, Float32Array>()
    const score = (m: MemoryRow) => (q && normalize(m.content).includes(q) ? 1 : 0) + (qv && vecs.get(m.id) ? dot(qv, vecs.get(m.id)!) : 0)
    const hits = list.map(m => ({ m, s: score(m) })).filter(x => x.s > (qv ? 0.45 : 0)).sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.m)
    this.store.touchMemories(hits.map(m => m.id))
    return hits
  }

  // —— 导出 / 导入 ——

  exportAll(owner: string) {
    return this.store.listMemories(owner, ['active', 'proposed']).map(m => ({ content: m.content, kind: m.kind, scope: m.scope, status: m.status, created_at: m.created_at }))
  }

  /** 导入的条目进「待确认」（全局范围）；敏感的、重复的跳过。 */
  async importItems(owner: string, items: Array<{ content?: unknown; kind?: unknown }>): Promise<{ added: number; skipped: Array<{ content: string; reason: string }> }> {
    this.requireUsable(owner)
    let added = 0
    const skipped: Array<{ content: string; reason: string }> = []
    for (const it of items.slice(0, 500)) {
      const content = typeof it.content === 'string' ? it.content : ''
      const kind = (typeof it.kind === 'string' && it.kind in MEMORY_KINDS ? it.kind : 'preference') as MemoryKind
      try {
        const r = await this.propose(owner, { content, kind, scope: 'global' }, { source: 'import', actor: 'user' })
        if (r.result === 'proposed') added++
        else skipped.push({ content: content.slice(0, 80), reason: '已有相同的记忆' })
      } catch (err) {
        skipped.push({ content: content.slice(0, 80), reason: (err as Error).message })
      }
    }
    return { added, skipped }
  }

  // —— 内部 ——

  private async embed(text: string): Promise<Float32Array | null> {
    if (!this.embedder || !(await this.embedder.available())) return null
    try { return (await this.embedder.embed([text]))[0] ?? null } catch { return null }
  }

  private similar(owner: string, vec: Float32Array | null): MemoryRow | undefined {
    if (!vec) return undefined
    let best: { id: string; s: number } | null = null
    for (const x of this.store.memoryVectors(owner, ['active', 'proposed', 'rejected'])) {
      const s = dot(vec, x.v)
      if (s >= SIMILAR && (!best || s > best.s)) best = { id: x.id, s }
    }
    return best ? this.store.getMemory(best.id) : undefined
  }
}
