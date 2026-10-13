import type { Documents } from '../model/runtime.ts'
import type { MemoryChangeRow, MemoryKind, MemoryRow, Store } from '../store/db.ts'
import { sensitiveReason } from './guard.ts'
import { MEMORY_KINDS, MemoryError, type MemoryService } from './service.ts'

/**
 * 记忆演进（自我整理）：把近期信号（用户改写 AI 的段落、拒绝的修订、对话里说的话）和现有记忆交给模型，产出建议——
 * - 新规律 → 「待确认」记忆（和 AI 在对话里提议的一样，用户采纳才生效）；
 * - 合并重复 / 改写过时或冲突的 / 归档长期不用的 → 「整理建议」，用户采纳才生效。
 * 什么都不会自动生效。用户界面「整理记忆」和 MCP memory_review 走同一个方法；定时任务对有足够新信号的用户每天最多跑一次。
 */

/** 模型调用：system + user → 文本（JSON）。index.ts 用平台的模型 key 实现，测试里换成假的。 */
export type Complete = (system: string, user: string) => Promise<string>

export interface ReviewResult {
  proposed: MemoryRow[]
  changes: MemoryChangeRow[]
  /** 本次用掉的信号条数 / 看过的对话条数 */
  signals: number
  messages: number
  skipped?: 'nothing_new'
}

const STALE_DAYS = 90
const MAX_CHANGES = 8
const LAST_REVIEW = 'memory_review_at'

const SYSTEM = `你在帮一位医学写作者整理 AI 写作助手的「记忆」（以后每次写作都会照做的偏好、写法、术语、事实）。
输入是 JSON：memories 现有记忆（m1…，含使用次数、最近使用天数）；signals 近期信号（s1…：edit_ai = 用户把 AI 写的段落改成了 user_text；reject = 用户拒绝了 AI 的修订、保留 user_text）；messages 用户近期在对话里说的话（u1…）；dismissed 用户拒绝过的整理建议（不要再提）。

找出值得长期记住、以后能直接照做的规律，输出建议。规则：
- 新规律（create）必须有至少 2 条信号 / 消息支持同一做法，或用户在消息里明确说「以后都…」「一律…」；evidence 列出支持它的编号。
- 只总结可推广的写作习惯（措辞、数字与单位格式、术语译法、引用写法、语气、结构偏好），不要记一次性的内容改动、具体病例、患者信息、账号。
- 现有记忆里重复或高度重叠的 → merge（ids + 合并后的一条）；与新信号冲突或说法过时的 → update（id + 改后的内容）；明显已不适用的 → archive（id + 理由）。
- 内容写成一句可直接照做的中文规则，不超过 120 字。理由写给用户看，一句话，具体说明依据（例如「你在 3 处把『显著降低』改成了带效应量的写法」）；理由和内容里不要出现 m1、s2、u3 这类编号（用户看不到编号），要提到某条记忆就直接引用它的内容。
- 没有把握就不提。最多 ${MAX_CHANGES} 条，宁少勿滥。
只输出 JSON：{"changes":[{"action":"create","kind":"preference|fact|style|term","content":"…","reason":"…","evidence":["s1","u2"]},{"action":"merge","ids":["m1","m2"],"content":"…","reason":"…"},{"action":"update","id":"m3","content":"…","reason":"…"},{"action":"archive","id":"m4","reason":"…"}]}`

const days = (iso: string | null) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86_400_000) : null)

function parseJson(text: string): { changes?: unknown } {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''))
  if (!m) throw new Error('模型没有返回 JSON')
  return JSON.parse(m[0]) as { changes?: unknown }
}

export class MemoryEvolution {
  private running = new Set<string>()

  constructor(
    private readonly store: Store,
    private readonly memory: MemoryService,
    private readonly docs: Documents,
    private readonly complete: Complete | null,
  ) {}

  available(): boolean { return this.complete !== null }

  pending(owner: string): MemoryChangeRow[] { return this.store.listMemoryChanges(owner, ['pending']) }

  /** 整理一次。force=false（定时任务）时没有新东西就跳过。 */
  async review(owner: string, opts: { force?: boolean } = {}): Promise<ReviewResult> {
    if (!this.complete) throw new MemoryError('review_unavailable', '平台没有配置模型，不能整理记忆')
    if (!this.memory.active(owner)) throw new MemoryError('memory_off', '记忆已停用或暂停')
    if (this.running.has(owner)) throw new MemoryError('review_running', '正在整理，稍后再看')
    this.running.add(owner)
    try { return await this.run(owner, opts.force ?? true) } finally { this.running.delete(owner) }
  }

  private async run(owner: string, force: boolean): Promise<ReviewResult> {
    const since = this.store.getUserSetting(owner, LAST_REVIEW)
    const memories = this.store.listMemories(owner, ['active'])
    const signals = this.store.openMemorySignals(owner)
      .map(s => ({ s, user: s.kind === 'reject' ? s.user_text ?? '' : this.currentText(s.doc_id, s.node_id) }))
      // 段落已删、改回原样、只差个别字的不算
      .filter(x => x.user !== null && x.user.trim() !== x.s.ai_text.trim() && !(x.s.kind === 'edit_ai' && Math.abs(x.user.length - x.s.ai_text.length) < 2 && similar(x.user, x.s.ai_text)))
    const messages = this.store.userMessagesSince(owner, since).filter(m => m.text.trim().length >= 4)
    const stale = memories.filter(m => !m.explicit && (days(m.last_used_at) ?? days(m.created_at)!) >= STALE_DAYS)
    const pendingTargets = new Set(this.pending(owner).flatMap(c => c.target_ids))

    if (!force && signals.length < 3 && messages.length < 8 && stale.every(m => pendingTargets.has(m.id))) {
      return { proposed: [], changes: [], signals: 0, messages: 0, skipped: 'nothing_new' }
    }

    const alias = new Map<string, string>()
    memories.forEach((m, i) => alias.set(`m${i + 1}`, m.id))
    const batch = signals.slice(0, 40)
    const input = {
      memories: memories.map((m, i) => ({ id: `m${i + 1}`, kind: MEMORY_KINDS[m.kind], content: m.content, used: m.use_count, last_used_days: days(m.last_used_at), age_days: days(m.created_at), user_said_explicitly: Boolean(m.explicit) })),
      signals: batch.map((x, i) => ({ id: `s${i + 1}`, type: x.s.kind, ai_text: x.s.ai_text.slice(0, 600), user_text: x.user!.slice(0, 600) })),
      messages: messages.slice(0, 30).map((m, i) => ({ id: `u${i + 1}`, text: m.text.slice(0, 400) })),
      dismissed: this.store.listMemoryChanges(owner, ['dismissed'], 20).map(c => c.content ?? c.reason),
    }
    const raw = await this.complete!(SYSTEM, JSON.stringify(input))
    const items = (parseJson(raw).changes ?? []) as Array<Record<string, unknown>>

    const proposed: MemoryRow[] = []
    const changes: MemoryChangeRow[] = []
    const real = (a: unknown) => (typeof a === 'string' ? alias.get(a) : undefined)
    const text = (v: unknown) => (typeof v === 'string' ? stripIds(v).trim().replace(/\s+/g, ' ').slice(0, 300) : '')
    for (const it of items.slice(0, MAX_CHANGES)) {
      const reason = text(it.reason) || '整理记忆时发现'
      const content = text(it.content)
      if (content && sensitiveReason(content)) continue
      try {
        if (it.action === 'create' && content) {
          const kind = (typeof it.kind === 'string' && it.kind in MEMORY_KINDS ? it.kind : 'style') as MemoryKind
          const r = await this.memory.propose(owner, { content, kind, scope: 'global', reason }, { source: 'review', actor: 'ai' })
          if (r.result === 'proposed') proposed.push(r.memory)
        } else if (it.action === 'merge' && content && Array.isArray(it.ids)) {
          const ids = [...new Set(it.ids.map(real).filter((x): x is string => !!x))]
          if (ids.length >= 2 && !ids.some(id => pendingTargets.has(id))) changes.push(this.store.addMemoryChange({ owner, action: 'merge', target_ids: ids, content, reason }))
        } else if ((it.action === 'update' || it.action === 'archive') && real(it.id) && !pendingTargets.has(real(it.id)!)) {
          if (it.action === 'update' && !content) continue
          changes.push(this.store.addMemoryChange({ owner, action: it.action, target_ids: [real(it.id)!], content: it.action === 'update' ? content : null, reason }))
        }
        for (const c of changes) c.target_ids.forEach(id => pendingTargets.add(id))
      } catch (err) {
        if (!(err instanceof MemoryError)) throw err
      }
    }
    // 长期没用到的：模型没提，也给一条归档建议（用户明确要求记住的不提）
    for (const m of stale) {
      if (pendingTargets.has(m.id)) continue
      changes.push(this.store.addMemoryChange({ owner, action: 'archive', target_ids: [m.id], content: null, reason: `${STALE_DAYS} 天以上没有用到` }))
      pendingTargets.add(m.id)
    }
    this.store.consumeMemorySignals(batch.map(x => x.s.id))
    this.store.setUserSetting(owner, LAST_REVIEW, new Date().toISOString())
    return { proposed, changes, signals: batch.length, messages: messages.length }
  }

  /** 采纳一条整理建议（只能由用户做）。目标记忆已经变了（被删、被改）就作废。 */
  async apply(owner: string, id: string): Promise<MemoryChangeRow> {
    const c = this.store.getMemoryChange(id)
    if (!c || c.owner !== owner) throw new MemoryError('not_found', '建议不存在')
    if (c.status !== 'pending') throw new MemoryError('resolved', '这条建议已经处理过')
    const targets = c.target_ids.map(t => this.store.getMemory(t))
    if (targets.some(t => !t || t.owner !== owner || t.status !== 'active')) {
      this.store.resolveMemoryChange(id, 'dismissed')
      throw new MemoryError('stale', '相关记忆已经变了，这条建议作废')
    }
    if (c.action === 'archive') {
      await this.memory.edit(owner, targets[0]!.id, { status: 'archived' })
    } else if (c.action === 'update') {
      await this.memory.edit(owner, targets[0]!.id, { content: c.content! })
    } else {
      // 合并：第一条改成合并后的内容（保留它的历史），其余归档
      const [keep, ...rest] = targets as MemoryRow[]
      await this.memory.edit(owner, keep!.id, { content: c.content!, ...(rest.some(r => r.scope !== keep!.scope || r.project_id !== keep!.project_id) ? { scope: 'global' as const } : {}) })
      for (const r of rest) await this.memory.edit(owner, r.id, { status: 'archived' })
    }
    this.store.resolveMemoryChange(id, 'applied')
    return this.store.getMemoryChange(id)!
  }

  dismiss(owner: string, id: string): void {
    const c = this.store.getMemoryChange(id)
    if (!c || c.owner !== owner) throw new MemoryError('not_found', '建议不存在')
    if (c.status === 'pending') this.store.resolveMemoryChange(id, 'dismissed')
  }

  private currentText(docId: string, nodeId: string | null): string | null {
    if (!nodeId || !this.store.getDoc(docId)) return null
    let text: string | null = null
    this.docs.get(docId).descendants(n => {
      if (text !== null) return false
      if (n.attrs.id === nodeId) { text = n.textContent.trim(); return false }
      return true
    })
    return text
  }
}

/** 去掉模型漏写进理由的内部编号（m2、（s1、s3）……）：用户看不到这些编号。 */
export function stripIds(text: string): string {
  return text
    .replace(/[（(]\s*[msu]\d+(?:\s*[、,，和与及]\s*[msu]\d+)*\s*[）)]/g, '')
    .replace(/(?<![A-Za-z0-9])[msu]\d+(?:\s*[、,，和与及]\s*[msu]\d+)*(?![A-Za-z0-9])\s*/g, '')
}

/** 两段文字只差个别字（错别字、标点）——不当作写法上的偏好。 */
function similar(a: string, b: string): boolean {
  let same = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same++
  return same / Math.max(a.length, b.length, 1) > 0.95
}
