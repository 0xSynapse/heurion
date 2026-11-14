/**
 * 修订决定卡（docs/design/PROTECTION_RESOLUTION.md 第一步）。
 *
 * AI 的修改因为合作者（导师）待采纳的修订被拦下时，编辑工具给用户生成「采纳 X 的修订」确认卡。
 * 用户确认后：先以用户身份采纳这条修订（和用户在文档里点「采纳」完全一样），
 * 再以 AI 身份把被拦的那批修改重新提交一次——仍走操作层的全部守卫（来源规则、数字出处、冲突守卫等），
 * 平台不替 AI 放宽任何检查。网页确认和实验里的「模拟医生」共用这一个函数。
 */
import type { Documents } from '../model/runtime.ts'
import { OpError, type EditBatch, type RevisionDecision } from './types.ts'
import type { OpService } from './service.ts'
import { resolveSuggestions } from './suggest.ts'

/** 存在待确认操作 followup 列里的内容 */
export interface RevisionFollowup {
  kind: 'revision_decision'
  decision: RevisionDecision
  /** 被拦下的那批修改（含当时生效的 mode） */
  batch: EditBatch
  meta: { turnId: string | null; observe: string | null; answering: string | null }
}

export type RetryOutcome =
  | { ok: true; rev: number; changed: number; mode: 'apply' | 'suggest'; converted_to_suggest?: string[] }
  | { ok: false; code: string; message: string; hint?: string }

export interface RevisionDecisionResult {
  /** 这次采纳实际改动的块数；0 表示这条修订已经被处理过（采纳或拒绝） */
  accepted: number
  rev: number
  retry: RetryOutcome
}

/** 把一批操作里指向修订版的 id 换成采纳后的 id（采纳后修订版沿用原文版本的 id）。 */
export function remapRevisionIds<T>(ops: T, from: string, to: string): T {
  if (from === to) return ops
  const marker = new RegExp(`\\{#${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g')
  return JSON.parse(JSON.stringify(ops), (_k, v: unknown) => {
    if (typeof v !== 'string') return v
    if (v === from) return to
    return v.includes(`{#${from}}`) ? v.replace(marker, `{#${to}}`) : v
  }) as T
}

export function acceptRevisionAndRetry(deps: { docs: Documents; ops: OpService }, user: string, f: RevisionFollowup): RevisionDecisionResult {
  const { docs, ops } = deps
  const docId = f.batch.doc_id
  const { group, original_id: originalId, revision_id: revisionId } = f.decision
  docs.flush(docId)
  // 1. 以用户身份采纳（与 /api/docs/:id/suggestions/:group/accept 相同）
  const before = docs.get(docId)
  let present = false
  before.descendants(n => {
    if (n.attrs.suggest_group === group && n.attrs.suggest) present = true
    return !present
  })
  let accepted = 0
  if (present) {
    const next = resolveSuggestions(before, group, true)
    const event = docs.commit(docId, next, { actor: 'user', turnId: null, user, ops: [{ op: 'accept_suggestion', group }] })
    accepted = event?.changes.length ?? 0
  }
  const rev = docs.rev(docId)
  // 2. 以 AI 身份重新提交被拦的修改
  const text = JSON.stringify(f.batch.ops)
  const touchedRevision = !!revisionId && text.includes(revisionId)
  const touchedOriginal = text.includes(originalId)
  // base_rev 保持 AI 当时的版本：采纳算用户的改动，冲突守卫据此判断 AI 有没有看过采纳后的内容
  const batch: EditBatch = {
    ...f.batch,
    ops: revisionId ? remapRevisionIds(f.batch.ops, revisionId, originalId) : f.batch.ops,
  }
  // AI 当时改的是修订版：采纳后这一块的内容就是 AI 当时看到的修订版，算它看过。
  // 改的是原文版本时不算——采纳后内容变成了合作者的修订版，冲突守卫要拦下、把新内容给 AI，免得按旧原文整段重写、冲掉导师的修改。
  if (accepted > 0 && touchedRevision && !touchedOriginal) ops.noteSeen(docId, [originalId], rev)
  try {
    const r = ops.edit(batch, { actor: 'ai', turnId: f.meta.turnId, observe: f.meta.observe, answering: f.meta.answering })
    const converted = r.provenance?.converted_to_suggest
    return {
      accepted,
      rev: r.rev,
      retry: { ok: true, rev: r.rev, changed: r.changes.length, mode: converted?.length ? 'suggest' : (batch.mode ?? 'apply'), ...(converted?.length ? { converted_to_suggest: converted } : {}) },
    }
  } catch (err) {
    if (err instanceof OpError) {
      const hint = err.extra.hint
      return { accepted, rev, retry: { ok: false, code: err.code, message: err.message, ...(hint ? { hint } : {}) } }
    }
    throw err
  }
}
