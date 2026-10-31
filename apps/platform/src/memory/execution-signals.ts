import type { CommitDetail, Documents } from '../model/runtime.ts'
import type { Store } from '../store/db.ts'
import type { SkillDomain } from './domain-adapters.ts'
import { BASELINE_TRIGGER_CODES } from './procedural.ts'

export interface GuardRejectEvent {
  owner: string
  docId: string
  turnId?: string | null
  code: string
  message: string
  domain?: SkillDomain
  extra?: Record<string, unknown>
}

export interface ActivationLookupResult {
  ruleIds: string[]
  message: string
  domain?: SkillDomain
}

/**
 * 执行信号采集器（Layer 2: Procedural Harness Signals）：
 * 收集 AI 执行过程中的失败、回滚、守卫拦截与同轮成功恢复轨迹（Trajectory Contrast），
 * 供自演进机制执行反向归因（Backward Credit Assignment：create / strengthen / narrow / merge）。
 */
export class ExecutionSignals {
  private activationLookup?: (owner: string, docId: string, turnId?: string | null) => ActivationLookupResult | undefined

  constructor(
    private readonly store: Store,
    docs: Documents,
    opts?: { activationLookup?: (owner: string, docId: string, turnId?: string | null) => ActivationLookupResult | undefined },
  ) {
    this.activationLookup = opts?.activationLookup
    docs.on('commit-detail', (d: CommitDetail) => {
      try {
        this.collectCommit(d)
      } catch (err) {
        console.error('[execution-signals]', err)
      }
    })
  }

  /** 绑定路由激活查询器（用于自动关联当前回合已注入的 active_rule_ids 与用户指令）。 */
  setActivationLookup(fn: (owner: string, docId: string, turnId?: string | null) => ActivationLookupResult | undefined): void {
    this.activationLookup = fn
  }

  /**
   * 收集 commit 事件：
   * 1) 用户执行 revert_turn 时记录回滚信号；
   * 2) AI 在同一 turnId 内先触发了守卫拦截、随后重试提交成功时，将成功提交的操作摘要（recovery_ops）
   *    关联为同轮轨迹对比信号，供零模板反向归因提取修复规程。
   */
  private collectCommit({ event, ops }: CommitDetail): void {
    const list = Array.isArray(ops) ? (ops as Array<{ op?: string; turn_id?: string }>) : []
    if (event.actor === 'user') {
      const revert = list.find(o => o.op === 'revert_turn')
      if (revert) {
        const doc = this.store.getDoc(event.docId)
        const owner = event.user ?? doc?.owner
        if (!owner) return
        const act = this.activationLookup?.(owner, event.docId, revert.turn_id)
        this.store.addExecutionSignal({
          owner,
          doc_id: event.docId,
          turn_id: revert.turn_id ?? null,
          kind: 'turn_revert',
          code: 'user_reverted_turn',
          detail: JSON.stringify({
            turn_id: revert.turn_id,
            rev: event.rev,
            ...(act ? { active_rule_ids: act.ruleIds, user_message: act.message, domain: act.domain } : {}),
          }),
        })
        if (act?.ruleIds?.length) {
          const uniqueRuleIds = [...new Set(act.ruleIds)]
          this.store.deductHarnessRuleSuccess(uniqueRuleIds)
          for (const rid of uniqueRuleIds) {
            const rule = this.store.getHarnessRule(rid)
            if (!rule || rule.owner === 'system' || rule.status !== 'active') continue
            const hit = rule.hit_count ?? 0
            const succ = rule.success_count ?? 0
            const baseCode = rule.trigger_pattern.split('|')[0]?.trim() ?? ''
            if (hit >= 5 && succ / hit < 0.2 && !BASELINE_TRIGGER_CODES.has(baseCode)) {
              this.store.updateHarnessRule(rule.id, { status: 'archived' })
            }
          }
        }
      }
      return
    }

    if (event.actor === 'ai' && event.turnId && list.length > 0) {
      const doc = this.store.getDoc(event.docId)
      const owner = event.user ?? doc?.owner
      if (!owner) return
      const open = this.store.openExecutionSignals(owner, 20).filter(s => s.turn_id === event.turnId)
      if (open.length === 0) return
      const recoverySummary = list.map(o => o.op ?? 'op').join(' -> ')
      for (const sig of open) {
        try {
          const parsed = sig.detail ? (JSON.parse(sig.detail) as Record<string, unknown>) : {}
          if (!parsed.recovery_ops) {
            parsed.recovery_ops = recoverySummary
            // 通过追加或更新 detail 供后续 evolveFromSignals 使用
            const db = (this.store as unknown as { db?: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
            db?.prepare('UPDATE execution_signals SET detail = ? WHERE id = ?').run(JSON.stringify(parsed), sig.id)
          }
        } catch {
          /* 忽略非 JSON detail */
        }
      }
    }
  }

  /** 记录写前守卫或跨领域工具验证器的拦截信号。 */
  recordGuardReject(e: GuardRejectEvent): void {
    try {
      const act = this.activationLookup?.(e.owner, e.docId, e.turnId)
      const detailObj: Record<string, unknown> = {
        message: e.message,
        ...(act?.ruleIds ? { active_rule_ids: act.ruleIds } : {}),
        ...(act?.message ? { user_message: act.message } : {}),
        ...(e.domain ?? act?.domain ? { domain: e.domain ?? act?.domain } : {}),
        ...e.extra,
      }
      this.store.addExecutionSignal({
        owner: e.owner,
        doc_id: e.docId,
        turn_id: e.turnId ?? null,
        kind: 'guard_reject',
        code: e.code,
        detail: JSON.stringify(detailObj),
      })
    } catch (err) {
      console.error('[execution-signals] recordGuardReject failed:', err)
    }
  }

  /** 记录任意跨领域工具（统计建模、演示文稿、外部 MCP 工具）的失败-成功对比信号。 */
  recordToolFailure(e: {
    owner: string
    docId?: string | null
    turnId?: string | null
    domain?: SkillDomain
    code: string
    message: string
    hint?: string
    failedArgs?: unknown
    recoveryArgs?: unknown
    activeRuleIds?: string[]
    userMessage?: string
  }): void {
    try {
      const act = e.docId ? this.activationLookup?.(e.owner, e.docId) : undefined
      this.store.addExecutionSignal({
        owner: e.owner,
        doc_id: e.docId ?? '',
        turn_id: e.turnId ?? null,
        kind: 'tool_error',
        code: e.code,
        detail: JSON.stringify({
          message: e.message,
          ...(e.hint ? { hint: e.hint } : {}),
          ...(e.domain ?? act?.domain ? { domain: e.domain ?? act?.domain } : {}),
          ...(e.activeRuleIds ?? act?.ruleIds ? { active_rule_ids: e.activeRuleIds ?? act?.ruleIds } : {}),
          ...(e.userMessage ?? act?.message ? { user_message: e.userMessage ?? act?.message } : {}),
          ...(e.failedArgs !== undefined ? { failed_ops: typeof e.failedArgs === 'string' ? e.failedArgs : JSON.stringify(e.failedArgs) } : {}),
          ...(e.recoveryArgs !== undefined ? { recovery_ops: typeof e.recoveryArgs === 'string' ? e.recoveryArgs : JSON.stringify(e.recoveryArgs) } : {}),
        }),
      })
    } catch (err) {
      console.error('[execution-signals] recordToolFailure failed:', err)
    }
  }
}
