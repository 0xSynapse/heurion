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

  it('forPrompt：守卫码不当消息触发词，按文档状态线索（未关闭批注）在紧预算下优先注入', async () => {
    const { store, docs, docId } = setup('# 方法\n\n受试者按 1:1 随机分组。')
    const [, p] = ids(docs, docId)
    const procedural = new ProceduralHarnessService(store, docs)
    const anchorRule = store.addHarnessRule({
      scope: 'user', owner: 'u1', project_id: null, category: 'guard', trigger_pattern: 'anchor_has_open_comments',
      rule: '目标段有未关闭批注时，用 replace_text 只改局部，保留被批注的原文。', evidence_count: 2, status: 'active',
    })
    const budget = anchorRule.rule.length + 20
    const message = '把方法第一段整体重写，使其符合 CONSORT 描述规范。'

    // 没有批注：只按证据数排序，基线规则（证据 10）排在前面
    expect(await procedural.forPrompt('u1', docId, message, budget)).not.toContain(anchorRule.rule)

    // 段上有未关闭批注：状态线索命中，学到的规则排到第一
    store.addComment({ doc_id: docId, node_id: p!, snippet: '1:1 随机' })
    expect(await procedural.forPrompt('u1', docId, message, budget)).toContain(anchorRule.rule)
  })

  it('forPrompt：近期有用户编辑时优先注入冲突规则', async () => {
    const { store, docs, ops, docId } = setup('# 讨论\n\n主要终点达到统计学显著。')
    const [, p] = ids(docs, docId)
    const procedural = new ProceduralHarnessService(store, docs)
    const conflictRule = store.listHarnessRules('u1').find(r => r.trigger_pattern === 'conflict_user_edited')!
    // 让另一条基线规则证据更多：没有状态线索时它会排在冲突规则前面
    const citeRule = store.listHarnessRules('u1').find(r => r.trigger_pattern === 'citation_not_registered')!
    for (let i = 0; i < 5; i++) store.bumpHarnessRule(citeRule.id)

    ops.edit({
      doc_id: docId, base_rev: docs.rev(docId), mode: 'apply',
      ops: [{ op: 'replace_text', id: p!, find: '显著', replace: '显著差异' }],
    }, { actor: 'user', turnId: null })

    const out = await procedural.forPrompt('u1', docId, '润色讨论段')
    expect(out.indexOf(conflictRule.rule)).toBeGreaterThanOrEqual(0)
    expect(out.indexOf(conflictRule.rule)).toBeLessThan(out.indexOf(citeRule.rule))
  })

  it('fifo 模式按创建顺序注入，不看情境线索', async () => {
    const { store, docs, docId } = setup('# 方法\n\n受试者按 1:1 随机分组。')
    const [, p] = ids(docs, docId)
    const procedural = new ProceduralHarnessService(store, docs, { mode: 'fifo' })
    const anchorRule = store.addHarnessRule({
      scope: 'user', owner: 'u1', project_id: null, category: 'guard', trigger_pattern: 'anchor_has_open_comments',
      rule: '目标段有未关闭批注时，用 replace_text 只改局部。', evidence_count: 2, status: 'active',
    })
    store.addComment({ doc_id: docId, node_id: p!, snippet: '1:1 随机' })

    const out = await procedural.forPrompt('u1', docId, '重写方法段', 400)
    expect(out).not.toContain(anchorRule.rule)
    expect(out).toContain('［执行策略与避坑指南］')
  })

  it('frozen 模式不从执行信号沉淀新规则', () => {
    const { store, docs } = setup()
    const execSignals = new ExecutionSignals(store, docs)
    const procedural = new ProceduralHarnessService(store, docs, { mode: 'frozen' })
    for (const t of ['t1', 't2']) {
      execSignals.recordGuardReject({ owner: 'u1', docId: 'd1', turnId: t, code: 'ambiguous_match', message: '原文出现 2 次' })
    }
    expect(procedural.evolveFromSignals('u1')).toHaveLength(0)
    expect(store.listHarnessRules('u1').some(r => r.trigger_pattern === 'ambiguous_match')).toBe(false)
  })

  it('不足 2 次的信号不被消费，跨回合累积后再沉淀', () => {
    const { store, docs } = setup()
    const execSignals = new ExecutionSignals(store, docs)
    const procedural = new ProceduralHarnessService(store, docs)

    // 第一个回合只出现 1 次：不沉淀，也不消费
    execSignals.recordGuardReject({ owner: 'u1', docId: 'd1', turnId: 't1', code: 'ambiguous_match', message: '原文出现 3 次' })
    expect(procedural.evolveFromSignals('u1')).toHaveLength(0)
    expect(store.openExecutionSignals('u1')).toHaveLength(1)

    // 之后的回合再出现 1 次：累计 2 次，沉淀为规则并消费
    execSignals.recordGuardReject({ owner: 'u1', docId: 'd2', turnId: 't2', code: 'ambiguous_match', message: '原文出现 3 次' })
    const created = procedural.evolveFromSignals('u1')
    expect(created.map(r => r.trigger_pattern)).toEqual(['ambiguous_match'])
    expect(store.openExecutionSignals('u1')).toHaveLength(0)
  })

  it('匹配到系统基线规则时只给该用户建副本，不改其他用户看到的权重', async () => {
    const { store, docs, docId } = setup('# 结论\n\n安全性总体可接受。')
    const execSignals = new ExecutionSignals(store, docs)
    const procedural = new ProceduralHarnessService(store, docs)
    const baseline = store.listHarnessRules('system').find(r => r.trigger_pattern === 'pending_suggestion')!

    for (const t of ['t1', 't2']) {
      execSignals.recordGuardReject({ owner: 'u1', docId: 'd1', turnId: t, code: 'pending_suggestion', message: '待采纳修订' })
    }
    procedural.evolveFromSignals('u1')

    // 系统规则本身不变；u1 有一份证据更多的副本；u2 只看到原样的系统规则
    expect(store.listHarnessRules('system').find(r => r.id === baseline.id)!.evidence_count).toBe(baseline.evidence_count)
    const own = store.listHarnessRules('u1').filter(r => r.trigger_pattern === 'pending_suggestion')
    expect(own.find(r => r.owner === 'u1')!.evidence_count).toBe(baseline.evidence_count + 2)
    expect(store.listHarnessRules('u2').filter(r => r.trigger_pattern === 'pending_suggestion').map(r => r.owner)).toEqual(['system'])

    // 注入时同一条规则只出现一次
    const out = await procedural.forPrompt('u1', docId, '修改结论')
    expect(out.split(baseline.rule).length - 1).toBe(1)
  })
  it('evolveFromSignals：未预置守卫码生成具体修法（含 hint），而非通用 doc_validate 模板', async () => {
    const { store, docs, docId } = setup('# 结果\n\n| 指标 | 组 1 | 组 2 |\n|---|---|---|\n| 年龄 | 60 | 61 |\n\n共纳入 100 例患者（P = 0.03）。')
    const execSignals = new ExecutionSignals(store, docs)
    const procedural = new ProceduralHarnessService(store, docs)

    for (const t of ['t1', 't2']) {
      execSignals.recordGuardReject({
        owner: 'u_hint', docId, turnId: t, code: 'text_not_found', message: '找不到原文',
        extra: { hint: '按 current 中的原文逐字复制 find。' },
      })
      execSignals.recordGuardReject({
        owner: 'u_hint', docId, turnId: t, code: 'invalid_structure', message: '不相邻不能合并',
        extra: { hint: '不相邻的先用 move 挪到一起。' },
      })
      execSignals.recordGuardReject({
        owner: 'u_hint', docId, turnId: t, code: 'cell_not_found', message: '单元格已并入合并单元格',
        extra: { hint: '请写合并单元格的左上角 (0, 1)。' },
      })
      execSignals.recordGuardReject({
        owner: 'u_hint', docId, turnId: t, code: 'custom_guard_xyz', message: '自定义守卫拦截',
        extra: { hint: '请先调用 custom_fix 修复参数后再提交。' },
      })
    }

    const created = procedural.evolveFromSignals('u_hint')
    const byCode = new Map(created.map(r => [r.trigger_pattern, r.rule]))
    expect(byCode.get('text_not_found')).toContain('doc_read')
    expect(byCode.get('text_not_found')).toContain('逐字一致')
    expect(byCode.get('text_not_found')).not.toContain('优先调用 doc_validate 预检')
    expect(byCode.get('invalid_structure')).toContain('move')
    expect(byCode.get('invalid_structure')).toContain('merge')
    expect(byCode.get('cell_not_found')).toContain('左上角')
    expect(byCode.get('custom_guard_xyz')).toContain('请先调用 custom_fix 修复参数后再提交。')

    // 消息线索命中：统一写成（text_not_found）、合并（invalid_structure）、表 1（cell_not_found）
    const pText = await procedural.forPrompt('u_hint', docId, '把结果部分正文中的所有 P 值统一写成 P = .03 格式', 320)
    expect(pText).toContain(byCode.get('text_not_found')!)

    const pMove = await procedural.forPrompt('u_hint', docId, '把讨论部分的第 1 段和第 3 段合并成一段', 320)
    expect(pMove).toContain(byCode.get('invalid_structure')!)

    const pTable = await procedural.forPrompt('u_hint', docId, '修改表 1 表头第 2 列的名称', 320)
    expect(pTable).toContain(byCode.get('cell_not_found')!)
  })

  it('placebo 模式不从信号沉淀新规则，且在基准规则后附加与任务无关的平台说明文字', async () => {
    const { store, docs, docId } = setup('# 讨论\n\n本研究存在一定局限性。')
    const execSignals = new ExecutionSignals(store, docs)
    const placebo = new ProceduralHarnessService(store, docs, { mode: 'placebo' })
    const frozen = new ProceduralHarnessService(store, docs, { mode: 'frozen' })

    for (const t of ['t1', 't2']) {
      execSignals.recordGuardReject({ owner: 'u_pl', docId, turnId: t, code: 'ambiguous_match', message: '出现 2 次' })
    }
    expect(placebo.evolveFromSignals('u_pl')).toHaveLength(0)

    const outFrozen = await frozen.forPrompt('u_pl', docId, '润色讨论段')
    const outPlacebo = await placebo.forPrompt('u_pl', docId, '润色讨论段')
    expect(outPlacebo).toContain('［执行策略与避坑指南］')
    expect(outPlacebo).toContain('[平台说明] Heurion 临床研究工作站')
    expect(outPlacebo.length).toBeGreaterThan(outFrozen.length)
  })
})
