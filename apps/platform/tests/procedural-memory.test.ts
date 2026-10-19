import { describe, expect, it } from 'vitest'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
import { ExecutionSignals } from '../src/memory/execution-signals.ts'
import { ProceduralHarnessService } from '../src/memory/procedural.ts'
import { ids, setup } from './helpers.ts'

describe('Layer 2: Dual-Track Procedural Memory & Execution Signals', () => {
  it('初始化包含系统级基准避坑与子代理分工规则', () => {
    const { store, docs } = setup()
    const procedural = new ProceduralHarnessService(store, docs)

    const rules = store.listHarnessRules('system', ['active'])
    expect(rules.length).toBeGreaterThanOrEqual(4)
    expect(rules.some(r => r.trigger_pattern.includes('conflict_user_edited'))).toBe(true)
    expect(rules.some(r => r.trigger_pattern.includes('citation_not_registered'))).toBe(true)
    expect(rules.some(r => r.category === 'subagent')).toBe(true)
  })

  it('执行信号采集：OpService 守卫拦截自动沉淀执行信号', () => {
    const { store, docs, docId } = setup('# 标题\n\n段落一')
    const [h, p] = ids(docs, docId)

    const execSignals = new ExecutionSignals(store, docs)
    const ops = new OpService(docs, undefined, e => execSignals.recordGuardReject(e))

    // AI 触发引用未登记守卫
    expect(() => {
      ops.edit({
        doc_id: docId,
        base_rev: docs.rev(docId),
        mode: 'apply',
        ops: [{ op: 'replace_text', id: p!, find: '段落一', replace: '包含 10.1056/NEJMoa123' }],
      }, { actor: 'ai', turnId: 'turn_err_1' })
    }).toThrow()

    const open = store.openExecutionSignals('u1')
    expect(open).toHaveLength(1)
    expect(open[0]!.kind).toBe('guard_reject')
    expect(open[0]!.code).toBe('citation_not_registered')
    expect(open[0]!.turn_id).toBe('turn_err_1')
  })

  it('用户撤销回合（revert_turn）自动捕获为执行信号', () => {
    const { store, docs, docId } = setup('# 标题\n\n段落一')
    const [h, p] = ids(docs, docId)
    new ExecutionSignals(store, docs)

    // 用户执行包含 revert_turn 标记的提交
    const ops = new OpService(docs)
    ops.edit({
      doc_id: docId,
      base_rev: docs.rev(docId),
      mode: 'apply',
      ops: [{ op: 'replace_text', id: p!, find: '段落一', replace: '改动的段落' }],
    }, { actor: 'user', turnId: null })

    // 再用 revert_turn 提交写回原状
    const orig = docs.get(docId)
    ops.edit({
      doc_id: docId,
      base_rev: docs.rev(docId),
      mode: 'apply',
      ops: [{ op: 'replace_text', id: p!, find: '改动的段落', replace: '改回原样' }],
    }, { actor: 'user', turnId: null })

    // 触发带 revert_turn op 的提交
    docs.commit(docId, orig, {
      actor: 'user',
      turnId: null,
      ops: [{ op: 'revert_turn', turn_id: 'turn_to_undo' }],
      user: 'u1',
    })

    const open = store.openExecutionSignals('u1')
    expect(open.some(s => s.kind === 'turn_revert' && s.turn_id === 'turn_to_undo')).toBe(true)
  })

  it('evolveFromSignals：高频失败自动增强已有规则，新错误模式自动沉淀新策略', () => {
    const { store, docs } = setup()
    const execSignals = new ExecutionSignals(store, docs)
    const procedural = new ProceduralHarnessService(store, docs)

    const initialRules = store.listHarnessRules('u1', ['active'])
    const conflictRule = initialRules.find(r => r.trigger_pattern.includes('conflict_user_edited'))!
    const initialEvidence = conflictRule.evidence_count

    // 1. 模拟出现 2 次已有的用户编辑冲突拦截 -> 自动加固已有策略规则权重
    execSignals.recordGuardReject({
      owner: 'u1', docId: 'd1', turnId: 't1', code: 'conflict_user_edited', message: '块被用户改过',
    })
    execSignals.recordGuardReject({
      owner: 'u1', docId: 'd1', turnId: 't2', code: 'conflict_user_edited', message: '块被用户改过',
    })

    procedural.evolveFromSignals('u1')
    const updatedConflictRule = store.listHarnessRules('u1', ['active']).find(r => r.trigger_pattern.includes('conflict_user_edited'))!
    expect(updatedConflictRule.evidence_count).toBeGreaterThan(initialEvidence)

    // 2. 模拟出现 2 次全新的错误模式（如 anchor_broken）-> 自动创建新规则
    execSignals.recordGuardReject({
      owner: 'u1', docId: 'd1', turnId: 't3', code: 'anchor_broken', message: '锚点损坏',
    })
    execSignals.recordGuardReject({
      owner: 'u1', docId: 'd1', turnId: 't4', code: 'anchor_broken', message: '锚点损坏',
    })

    const created = procedural.evolveFromSignals('u1')
    expect(created).toHaveLength(1)
    expect(created[0]!.trigger_pattern).toBe('anchor_broken')

    // 信号已被消费，不再重复演进
    expect(store.openExecutionSignals('u1')).toHaveLength(0)
  })

  it('forPrompt：根据消息内容与文档编辑状态高优先级注入对应策略', async () => {
    const { store, docs, docId } = setup('# 标题\n\n测试段落')
    const procedural = new ProceduralHarnessService(store, docs)

    // 1. 询问生存分析与统计，自动激活 biostatistician 规则
    const promptStat = await procedural.forPrompt('u1', docId, '请帮我基于临床数据画 Kaplan-Meier 生存曲线并计算 HR')
    expect(promptStat).toContain('［执行策略与避坑指南］')
    expect(promptStat).toContain('biostatistician')

    // 2. 询问文献与背景，自动激活 literature_researcher 与 citation 规则
    const promptRef = await procedural.forPrompt('u1', docId, '补充相关的医学背景和最新的临床试验文献')
    expect(promptRef).toContain('literature_researcher')
  })
})
