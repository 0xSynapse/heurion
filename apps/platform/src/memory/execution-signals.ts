import type { CommitDetail, Documents } from '../model/runtime.ts'
import type { Store } from '../store/db.ts'

export interface GuardRejectEvent {
  owner: string
  docId: string
  turnId?: string | null
  code: string
  message: string
  extra?: Record<string, unknown>
}

/**
 * 执行信号采集器（Layer 2: Procedural Harness Signals）：
 * 收集 AI 执行过程中的失败、回滚与守卫拦截信号，供自演进机制提炼程序性策略。
 * 区别于文字偏好信号（signals.ts 只收集 edit_ai/reject），这里专注 Agent 执行健壮性。
 */
export class ExecutionSignals {
  constructor(private readonly store: Store, docs: Documents) {
    docs.on('commit-detail', (d: CommitDetail) => {
      try { this.collectCommit(d) } catch (err) { console.error('[execution-signals]', err) }
    })
  }

  /** 收集 commit 里的回滚事件（如用户撤销了 AI 某一回合的修改）。 */
  private collectCommit({ event, ops }: CommitDetail): void {
    if (event.actor !== 'user') return
    const list = Array.isArray(ops) ? ops as Array<{ op?: string; turn_id?: string }> : []
    const revert = list.find(o => o.op === 'revert_turn')
    if (revert) {
      const doc = this.store.getDoc(event.docId)
      const owner = event.user ?? doc?.owner
      if (!owner) return
      this.store.addExecutionSignal({
        owner,
        doc_id: event.docId,
        turn_id: revert.turn_id ?? null,
        kind: 'turn_revert',
        code: 'user_reverted_turn',
        detail: JSON.stringify({ turn_id: revert.turn_id, rev: event.rev }),
      })
    }
  }

  /** 记录写前守卫或操作预检的拦截。 */
  recordGuardReject(e: GuardRejectEvent): void {
    try {
      this.store.addExecutionSignal({
        owner: e.owner,
        doc_id: e.docId,
        turn_id: e.turnId ?? null,
        kind: 'guard_reject',
        code: e.code,
        detail: JSON.stringify({ message: e.message, ...e.extra }),
      })
    } catch (err) {
      console.error('[execution-signals] recordGuardReject failed:', err)
    }
  }
}
