import type { Node as PMNode } from 'prosemirror-model'
import type { CommitDetail, Documents } from '../model/runtime.ts'
import type { Store } from '../store/db.ts'
import type { MemoryService } from './service.ts'

/**
 * 记忆演进的信号收集：从用户的修改里留下「AI 怎么写的、用户要的是什么」，整理记忆时交给模型总结规律。
 * - edit_ai：用户改了一段 AI 在 7 天内写过的文字段落。只记第一次被改时的 AI 原文；用户改后的样子在整理时取当前文字
 *   （用户往往分好几次改完，取最终结果）。
 * - reject：用户拒绝了 AI 的修订——被拒的 AI 版本与用户保留的原文。
 * 用户关了记忆（管理员停用 / 本人暂停）时不收集。
 * 归属：信号记在实际改动的人名下（提交事件的 user：协同连接上的用户、接口调用者）。研究共享文档里多人同时编辑、
 * 一次合批里分不清是谁时不记——别人的改法不能被总结进我的记忆。不在研究里的文档只有主人能改，没有 user 时按主人记。
 */

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'shape'])
const RECENT_MS = 7 * 86_400_000

function byId(doc: PMNode): Map<string, PMNode> {
  const map = new Map<string, PMNode>()
  doc.descendants(n => { if (n.attrs.id) map.set(n.attrs.id as string, n); return true })
  return map
}

export class MemorySignals {
  constructor(private readonly store: Store, private readonly memory: MemoryService, docs: Documents) {
    docs.on('commit-detail', (d: CommitDetail) => {
      try { this.collect(d) } catch (err) { console.error('[memory-signals]', err) }
    })
  }

  private collect({ event, before, after, ops }: CommitDetail): void {
    if (event.actor !== 'user') return
    const doc = this.store.getDoc(event.docId)
    if (!doc || (doc.kind !== 'doc' && doc.kind !== 'deck')) return
    const shared = !!doc.context && (JSON.parse(doc.context) as { kind?: string }).kind === 'study'
    const owner = event.user ?? (shared ? null : doc.owner)
    if (!owner || !this.memory.active(owner)) return
    const list = Array.isArray(ops) ? ops as Array<{ op?: string; group?: string | null }> : []
    const reject = list.find(o => o.op === 'reject_suggestion')
    if (reject) { this.rejected(owner, event.docId, event.rev, before, reject.group ?? null); return }
    if (list.some(o => o.op === 'accept_suggestion' || o.op === 'revert_turn' || o.op === 'restore')) return

    const old = byId(before)
    const now = byId(after)
    for (const c of event.changes) {
      if (c.kind !== 'modified') continue
      const prev = old.get(c.node_id)
      const next = now.get(c.node_id)
      if (!prev || !next || !TEXT_BLOCKS.has(prev.type.name) || prev.attrs.suggest) continue
      const ai = this.store.lastAiWrite(event.docId, c.node_id)
      if (!ai || Date.now() - Date.parse(ai.at) > RECENT_MS) continue
      const text = prev.textContent.trim()
      if (text.length < 4) continue
      this.store.addMemorySignal({ owner, doc_id: event.docId, node_id: c.node_id, kind: 'edit_ai', ai_text: text.slice(0, 1200), user_text: null, ai_rev: ai.rev })
    }
  }

  /** 拒绝修订：同一组里 suggest=insert 的是 AI 版本，suggest=delete 的是原文。 */
  private rejected(owner: string, docId: string, rev: number, before: PMNode, group: string | null): void {
    const groups = new Map<string, { ai: string[]; orig: string[] }>()
    before.descendants(n => {
      if (!n.attrs.suggest || (group !== null && n.attrs.suggest_group !== group)) return true
      const g = groups.get(n.attrs.suggest_group as string) ?? { ai: [], orig: [] }
      ;(n.attrs.suggest === 'insert' ? g.ai : g.orig).push(n.textContent.trim())
      groups.set(n.attrs.suggest_group as string, g)
      return false
    })
    for (const [g, { ai, orig }] of groups) {
      const aiText = ai.filter(Boolean).join('\n')
      if (!aiText) continue
      this.store.addMemorySignal({ owner, doc_id: docId, node_id: g, kind: 'reject', ai_text: aiText.slice(0, 1200), user_text: orig.filter(Boolean).join('\n').slice(0, 1200) || null, ai_rev: rev })
    }
  }
}
