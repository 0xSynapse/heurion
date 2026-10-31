import { describe, expect, it } from 'vitest'
import { deckSchema } from '../src/model/deck-schema.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
import { ExecutionSignals } from '../src/memory/execution-signals.ts'
import {
  ProceduralHarnessService,
  isNonRegressiveRewrite,
  parseEvidenceRefs,
} from '../src/memory/procedural.ts'
import { MemoryService } from '../src/memory/service.ts'
import { MemorySignals } from '../src/memory/signals.ts'
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

describe('CoEM evidence-gated rule lifecycle (pending -> active -> archived)', () => {
  it('1. Single-turn uncorroborated retry loop stays pending and is not injected by forPrompt()', async () => {
    const { store, docs, docId } = setup('# 结果\n\n主要终点 P = 0.03。')
    const execSignals = new ExecutionSignals(store, docs)
    const procedural = new ProceduralHarnessService(store, docs)

    // 同一 turnId 内连续触发 2 次拦截且无 recovery_ops 恢复轨迹
    execSignals.recordGuardReject({
      owner: 'u_coem',
      docId,
      turnId: 'turn_same_1',
      code: 'text_not_found',
      message: '原文匹配失败 #1',
      extra: { hint: '请先调用 doc_read 核对纯文本。' },
    })
    execSignals.recordGuardReject({
      owner: 'u_coem',
      docId,
      turnId: 'turn_same_1',
      code: 'text_not_found',
      message: '原文匹配失败 #2',
      extra: { hint: '请先调用 doc_read 核对纯文本。' },
    })

    const openBefore = store.openExecutionSignals('u_coem')
    expect(openBefore).toHaveLength(2)
    const sigIds = openBefore.map(s => s.id)

    const activated = procedural.evolveFromSignals('u_coem')
    expect(activated).toHaveLength(0)

    const allUserRules = store
      .listHarnessRules('u_coem', ['active', 'pending'])
      .filter(r => r.owner === 'u_coem' && r.trigger_pattern.startsWith('text_not_found'))
    expect(allUserRules).toHaveLength(1)
    expect(allUserRules[0]!.status).toBe('pending')

    const refs = parseEvidenceRefs(allUserRules[0]!.evidence_refs)
    expect(refs).toHaveLength(2)
    expect(refs).toEqual(expect.arrayContaining(sigIds))

    // pending 规则绝不被 forPrompt 注入上下文
    const prompt = await procedural.forPrompt('u_coem', docId, '把结果段的 P 值格式统一改为 P = .03', 800)
    expect(prompt).not.toContain(allUserRules[0]!.rule)

    // 同一 turnId 内如果再次追加第 3 条无恢复轨迹信号并再次调用 evolveFromSignals，依然必须保持 pending！
    execSignals.recordGuardReject({
      owner: 'u_coem',
      docId,
      turnId: 'turn_same_1',
      code: 'text_not_found',
      message: '原文匹配失败 #3',
      extra: { hint: '请先调用 doc_read 核对纯文本。' },
    })
    const activatedAgain = procedural.evolveFromSignals('u_coem')
    expect(activatedAgain).toHaveLength(0)
    const afterThird = store.getHarnessRule(allUserRules[0]!.id)!
    expect(afterThird.status).toBe('pending')
    expect(parseEvidenceRefs(afterThird.evidence_refs)).toHaveLength(3)
  })

  it('2. Cross-turn corroboration promotes pending -> active without duplication', async () => {
    const { store, docs, docId } = setup('# 结果\n\n主要终点 P = 0.03。')
    const execSignals = new ExecutionSignals(store, docs)
    const procedural = new ProceduralHarnessService(store, docs)

    // Turn 1: 同回合 2 次失败 -> pending
    execSignals.recordGuardReject({
      owner: 'u_coem2',
      docId,
      turnId: 'turn_same_1',
      code: 'text_not_found',
      message: '原文匹配失败 #1',
    })
    execSignals.recordGuardReject({
      owner: 'u_coem2',
      docId,
      turnId: 'turn_same_1',
      code: 'text_not_found',
      message: '原文匹配失败 #2',
    })
    const firstTurnIds = store.openExecutionSignals('u_coem2').map(s => s.id)
    procedural.evolveFromSignals('u_coem2')

    const pendingRules = store
      .listHarnessRules('u_coem2', ['active', 'pending'])
      .filter(r => r.owner === 'u_coem2' && r.trigger_pattern.startsWith('text_not_found'))
    expect(pendingRules).toHaveLength(1)
    expect(pendingRules[0]!.status).toBe('pending')

    // Turn 2: 新回合出现第 3 条同码信号 -> 跨回合印证，原地晋升为 active 且不产生重复规则
    execSignals.recordGuardReject({
      owner: 'u_coem2',
      docId,
      turnId: 'turn_same_2',
      code: 'text_not_found',
      message: '原文匹配失败 #3',
    })
    const thirdSigId = store.openExecutionSignals('u_coem2')[0]!.id

    const promoted = procedural.evolveFromSignals('u_coem2')
    expect(promoted).toHaveLength(1)
    expect(promoted[0]!.status).toBe('active')

    const rulesAfter = store
      .listHarnessRules('u_coem2', ['active', 'pending'])
      .filter(r => r.owner === 'u_coem2' && r.trigger_pattern.startsWith('text_not_found'))
    expect(rulesAfter).toHaveLength(1)
    expect(rulesAfter[0]!.id).toBe(pendingRules[0]!.id)
    expect(rulesAfter[0]!.status).toBe('active')
    expect(rulesAfter[0]!.evidence_count).toBe(3)

    const mergedRefs = parseEvidenceRefs(rulesAfter[0]!.evidence_refs)
    expect(mergedRefs).toHaveLength(3)
    expect(mergedRefs).toEqual(expect.arrayContaining([...firstTurnIds, thirdSigId]))

    // 晋升为 active 后，forPrompt 正常注入该规则
    const prompt = await procedural.forPrompt('u_coem2', docId, '把结果段的 P 值统一替换为新格式', 800)
    expect(prompt).toContain(rulesAfter[0]!.rule)
  })

  it('3. Same-turn with verified recovery_ops promotes directly to active', async () => {
    const { store, docs, docId } = setup('# 讨论\n\n段落一\n\n段落二\n\n段落三')
    const execSignals = new ExecutionSignals(store, docs)
    const procedural = new ProceduralHarnessService(store, docs)

    execSignals.recordGuardReject({
      owner: 'u_coem3',
      docId,
      turnId: 'turn_rec_1',
      code: 'invalid_structure',
      message: '不相邻段落无法直接合并',
      extra: {
        hint: '先执行 move 再执行 merge。',
        failed_ops: 'merge([p1, p3])',
        recovery_ops: 'move(p3, after=p1) -> merge([p1, p3])',
      },
    })
    execSignals.recordGuardReject({
      owner: 'u_coem3',
      docId,
      turnId: 'turn_rec_1',
      code: 'invalid_structure',
      message: '不相邻段落无法直接合并',
      extra: {
        hint: '先执行 move 再执行 merge。',
        failed_ops: 'merge([p1, p3])',
        recovery_ops: 'move(p3, after=p1) -> merge([p1, p3])',
      },
    })

    const created = procedural.evolveFromSignals('u_coem3')
    expect(created).toHaveLength(1)
    expect(created[0]!.status).toBe('active')
    expect(created[0]!.rule).toContain('move(p3, after=p1) -> merge([p1, p3])')
  })

  it('4. Stale pending rule (>30 days) auto-archives on evolveFromSignals', () => {
    const { store, docs, docId } = setup('# 标题\n\n内容')
    const execSignals = new ExecutionSignals(store, docs)
    const procedural = new ProceduralHarnessService(store, docs)

    execSignals.recordGuardReject({
      owner: 'u_stale',
      docId,
      turnId: 'turn_stale_1',
      code: 'ambiguous_match',
      message: '多处匹配 #1',
    })
    execSignals.recordGuardReject({
      owner: 'u_stale',
      docId,
      turnId: 'turn_stale_1',
      code: 'ambiguous_match',
      message: '多处匹配 #2',
    })
    procedural.evolveFromSignals('u_stale')

    const pendingRule = store
      .listHarnessRules('u_stale', ['pending'])
      .find(r => r.owner === 'u_stale' && r.trigger_pattern.startsWith('ambiguous_match'))!
    expect(pendingRule).toBeDefined()
    expect(pendingRule.status).toBe('pending')

    // 将 updated_at 回拨至 31 天前
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 86_400_000).toISOString()
    ;(store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
      .prepare('UPDATE harness_rules SET updated_at = ? WHERE id = ?')
      .run(thirtyOneDaysAgo, pendingRule.id)

    procedural.evolveFromSignals('u_stale')

    const updated = store.getHarnessRule(pendingRule.id)!
    expect(updated.status).toBe('archived')
  })

  it('5. Deck human edits on AI-written shape nodes record edit_ai memory signals', () => {
    const { store, docs } = setup()
    const memory = new MemoryService(store, null)
    new MemorySignals(store, memory, docs)

    const slide1 = deckSchema.node(
      'slide',
      { id: 'sl1' },
      [
        deckSchema.node(
          'shape',
          { id: 'sh1', kind: 'text', ph: 'title' },
          [deckSchema.node('paragraph', null, [deckSchema.text('AI 初始撰写的幻灯片标题文案')])],
        ),
      ],
    )
    const deckDoc = docs.create({
      owner: 'u1',
      title: '学术汇报幻灯片',
      kind: 'deck',
      content: deckSchema.node('doc', null, [slide1]),
    })

    // AI 修改了 shape sh1
    const aiSlide = deckSchema.node(
      'slide',
      { id: 'sl1' },
      [
        deckSchema.node(
          'shape',
          { id: 'sh1', kind: 'text', ph: 'title' },
          [deckSchema.node('paragraph', null, [deckSchema.text('AI 改写后的幻灯片核心结论标题')])],
        ),
      ],
    )
    docs.commit(deckDoc.id, deckSchema.node('doc', null, [aiSlide]), {
      actor: 'ai',
      turnId: 't_deck_ai',
      ops: [{ op: 'replace_shape_text', id: 'sh1' }],
      user: 'u1',
    })

    // 用户随后手动修改了 shape sh1
    const userSlide = deckSchema.node(
      'slide',
      { id: 'sl1' },
      [
        deckSchema.node(
          'shape',
          { id: 'sh1', kind: 'text', ph: 'title' },
          [deckSchema.node('paragraph', null, [deckSchema.text('用户精简后的行动式标题：早期干预降低死亡率 28%')])],
        ),
      ],
    )
    docs.commit(deckDoc.id, deckSchema.node('doc', null, [userSlide]), {
      actor: 'user',
      turnId: null,
      ops: [{ op: 'replace_shape_text', id: 'sh1' }],
      user: 'u1',
    })

    const signals = store.openMemorySignals('u1')
    expect(signals.some(s => s.doc_id === deckDoc.id && s.node_id === 'sh1' && s.kind === 'edit_ai')).toBe(true)
  })
})

describe('P1: SafeVantage Drop-in A — forPrompt() low-coverage abstention & active vantaging directive', () => {
  it('1. 仅在文档存在低覆盖度引用（仅有摘要/无开放全文或存疑论断）时动态注入 oa_fulltext 主动取景与细粒度拒答规程；补齐全文后自动退居幕后', async () => {
    const { store, docs, docId } = setup('# 讨论\n\n本研究评估了联合免疫治疗在晚期胃癌中的疗效。')
    const procedural = new ProceduralHarnessService(store, docs)

    const svRule = store
      .listHarnessRules('system', ['active'])
      .find(r => r.trigger_pattern === 'safevantage_low_coverage')!
    expect(svRule).toBeDefined()
    expect(svRule.rule).toContain('oa_fulltext')
    expect(svRule.rule).toContain('严禁外推编造数值')

    const tightBudget = svRule.rule.length + 25
    const userPrompt = '请结合引用文献在讨论段对比 PD-L1 CPS >= 5 亚组的 HR 和 P 值'

    // Step 1: 文档尚无任何引用时，不触发低覆盖率护栏，零额外预算占用
    const promptBeforeCite = await procedural.forPrompt('u1', docId, userPrompt, tightBudget)
    expect(promptBeforeCite).not.toContain(svRule.rule)

    // Step 2: 登记一篇仅有 PubMed 摘要、尚未拉取开放全文的引用 -> 状态线索命中，在紧预算下以最高优先级注入
    const doi = '10.1056/NEJMoa2024999'
    store.upsertCitation({
      doc_id: docId,
      doi,
      pmid: '38999999',
      formatted: 'Chen et al. N Engl J Med 2024.',
      url: null,
    })
    store.putAbstract(doi, '38999999', 'Overall survival was improved in the intention-to-treat population (HR 0.72).')

    const promptAbstractOnly = await procedural.forPrompt('u1', docId, userPrompt, tightBudget)
    expect(promptAbstractOnly).toContain(svRule.rule)

    // Step 3: 当 Agent 调用 oa_fulltext 成功缓存全文后，低覆盖率状态自动解除，紧预算下不再强行霸占首位
    store.putFullText(doi, {
      source: 'pmc',
      url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8888888/',
      license: 'CC-BY',
      text: '[Table 2] PD-L1 CPS >= 5 | HR 0.62 (0.48-0.81) | P = 0.002',
    })
    const promptAfterFullText = await procedural.forPrompt('u1', docId, userPrompt, tightBudget)
    expect(promptAfterFullText).not.toContain(svRule.rule)

    // Step 4: 若核验中存在 verdict === 'unclear' 的存疑论断，护栏再次激活提醒谨慎表述
    store.putClaimCheck({
      doc_id: docId,
      claim_id: 'clm_unclear_1',
      node_id: 'n1',
      sentence: '在 >=75 岁高龄亚组中客观缓解率达 58%。',
      verdict: 'unclear',
      evidence_tier: 'fulltext',
      evidence_quote: 'Subgroup analysis by age (<65 vs >=65) showed consistent benefit.',
      reason: '原文仅按 65 岁分组，未报告 >=75 岁亚组客观缓解率。',
      comment_id: null,
      rev: 1,
    })
    const promptWithUnclear = await procedural.forPrompt('u1', docId, userPrompt, tightBudget)
    expect(promptWithUnclear).toContain(svRule.rule)
  })
})

describe('P2: MSCE Online Reliability, MemSkill Attribution Filter & Skill-V Non-Regression', () => {
  it('1. MSCE 在线效用追踪：hit_count / success_count 累加、revert_turn 扣减与低效规则（<20%）自动归档（保护基线影子副本）', async () => {
    const { store, docs, docId } = setup('# 方法\n\n受试者按 1:1 随机分组（P = 0.03）。')
    const procedural = new ProceduralHarnessService(store, docs)
    const execSignals = new ExecutionSignals(store, docs, {
      activationLookup: (owner, did) => procedural.lastActivation(owner, did),
    })

    // 创建一条用户自定义规则（非基线）与一条系统基线影子副本规则
    const userRule = store.addHarnessRule({
      scope: 'user',
      owner: 'u_msce',
      project_id: null,
      category: 'guard',
      trigger_pattern: 'text_not_found|替换|格式',
      rule: '修改前先用 doc_read 核对纯文本，调用 replace_text 保持逐字一致。',
      evidence_count: 3,
      status: 'active',
    })
    const baselineShadow = store.addHarnessRule({
      scope: 'user',
      owner: 'u_msce',
      project_id: null,
      category: 'guard',
      trigger_pattern: 'conflict_user_edited|替换',
      rule: '若目标块在 base_rev 之后被用户修改过，优先使用 replace_text 原文精准替换。',
      evidence_count: 12,
      status: 'active',
    })

    // Turn 1: 正常激活并无报错完成 -> hit=1, success=1
    await procedural.forPrompt('u_msce', docId, '请替换方法段的 P 值格式', 800)
    procedural.bindTurnActivation('u_msce', docId, 't_msce_1')
    procedural.recordTurnOutcome('u_msce', 't_msce_1')

    let r1 = store.getHarnessRule(userRule.id)!
    expect(r1.hit_count).toBe(1)
    expect(r1.success_count).toBe(1)

    // 用户撤销 Turn 1（revert_turn） -> success_count 扣减为 0
    const [, p] = ids(docs, docId)
    const orig = docs.get(docId)
    const ops = new OpService(docs)
    ops.edit(
      {
        doc_id: docId,
        base_rev: docs.rev(docId),
        mode: 'apply',
        ops: [{ op: 'replace_text', id: p!, find: 'P = 0.03', replace: 'P = .03' }],
      },
      { actor: 'ai', turnId: 't_msce_1' },
    )
    docs.commit(docId, orig, {
      actor: 'user',
      turnId: null,
      ops: [{ op: 'revert_turn', turn_id: 't_msce_1' }],
      user: 'u_msce',
    })
    r1 = store.getHarnessRule(userRule.id)!
    expect(r1.hit_count).toBe(1)
    expect(r1.success_count).toBe(0)

    // Turn 2 ~ Turn 5: 连续 4 轮激活但均触发该规则主守卫码拦截 -> hit 达 5, success 仍为 0 (0/5 < 0.2) -> 自动归档
    for (const t of ['t_msce_2', 't_msce_3', 't_msce_4', 't_msce_5']) {
      await procedural.forPrompt('u_msce', docId, '请替换方法段的 P 值格式', 800)
      procedural.bindTurnActivation('u_msce', docId, t)
      execSignals.recordGuardReject({
        owner: 'u_msce',
        docId,
        turnId: t,
        code: 'text_not_found',
        message: '原文匹配失败',
      })
      execSignals.recordGuardReject({
        owner: 'u_msce',
        docId,
        turnId: t,
        code: 'conflict_user_edited',
        message: '用户编辑冲突',
      })
      const out = procedural.recordTurnOutcome('u_msce', t)
      if (t === 't_msce_5') {
        expect(out.archived).toContain(userRule.id)
        expect(out.archived).not.toContain(baselineShadow.id)
      }
    }

    const finalUserRule = store.getHarnessRule(userRule.id)!
    expect(finalUserRule.hit_count).toBe(5)
    expect(finalUserRule.success_count).toBe(0)
    expect(finalUserRule.status).toBe('archived')

    // 系统基线影子副本即使 hit=5, success=0 也受保护不自动归档
    const finalShadow = store.getHarnessRule(baselineShadow.id)!
    expect(finalShadow.hit_count).toBe(5)
    expect(finalShadow.status).toBe('active')
  })

  it('2. MemSkill Attribution Filter：Routing Miss（wasActive=false）且仅含通用 hint 时只扩充 trigger_pattern，严禁篡改 rule 正文', async () => {
    const { store, docs, docId } = setup('# 方法\n\n研究纳入多中心队列。')
    const procedural = new ProceduralHarnessService(store, docs)
    const execSignals = new ExecutionSignals(store, docs, {
      activationLookup: (owner, did) => procedural.lastActivation(owner, did),
    })

    const originalRuleText = '读取目标段落后先调用 comments_list 检查未关闭批注，再用 replace_text 局部修改。'
    const rule = store.addHarnessRule({
      scope: 'user',
      owner: 'u_attr',
      project_id: null,
      category: 'guard',
      trigger_pattern: 'anchor_has_open_comments',
      rule: originalRuleText,
      evidence_count: 2,
      status: 'active',
    })

    // 紧预算且无批注线索：rule 未被注入（wasActive === false）
    const tightBudget = originalRuleText.length + 22
    const userMsg = '请将方法部分的首句多中心队列描述精简改写'
    const injected = await procedural.forPrompt('u_attr', docId, userMsg, tightBudget)
    expect(injected).not.toContain(originalRuleText)
    expect(procedural.lastActivation('u_attr', docId)?.ruleIds).not.toContain(rule.id)

    // 发生 2 次拦截，仅带通用 hint，无 recovery_ops
    for (const t of ['t_attr_1', 't_attr_2']) {
      execSignals.recordGuardReject({
        owner: 'u_attr',
        docId,
        turnId: t,
        code: 'anchor_has_open_comments',
        message: '存在未关闭批注',
        extra: {
          hint: '请勿直接整段覆盖含未关闭批注的段落。',
        },
      })
    }

    procedural.evolveFromSignals('u_attr')
    const afterRoutingMiss = store.getHarnessRule(rule.id)!
    // 路由触发模式已扩充关键词，但规则正文保持 100% 原样不追加［边界强化］
    expect(afterRoutingMiss.trigger_pattern).not.toBe('anchor_has_open_comments')
    expect(afterRoutingMiss.trigger_pattern.split('|').length).toBeGreaterThan(1)
    expect(afterRoutingMiss.rule).toBe(originalRuleText)
  })

  it('3. Skill-V 版本快照、非退化重写校验（isNonRegressiveRewrite）、基线合并保护与一键回滚', async () => {
    const { store, docs, docId } = setup('# 讨论\n\n主要终点分析。')
    const procedural = new ProceduralHarnessService(store, docs)
    const execSignals = new ExecutionSignals(store, docs, {
      activationLookup: (owner, did) => procedural.lastActivation(owner, did),
    })

    const initialTrigger = 'anchor_has_open_comments|批注'
    const initialRule = '编辑含批注段落前先调用 comments_list 检查，优先用 replace_text 局部修改。'
    const rule = store.addHarnessRule({
      scope: 'user',
      owner: 'u_skillv',
      project_id: null,
      category: 'guard',
      trigger_pattern: initialTrigger,
      rule: initialRule,
      evidence_count: 3,
      status: 'active',
    })

    // 1. 激活规则并触发 Rule Insufficiency 演进 -> 自动保存重写前版本快照
    await procedural.forPrompt('u_skillv', docId, '处理讨论段的批注并润色', 600)
    for (const t of ['t_sv_1', 't_sv_2']) {
      execSignals.recordGuardReject({
        owner: 'u_skillv',
        docId,
        turnId: t,
        code: 'anchor_has_open_comments',
        message: '锚点丢失',
        extra: {
          hint: '若必须改写锚点文字，需传入 ack_comments 并回复批注。',
          recovery_ops: 'doc_edit(ack_comments) -> comment_reply',
        },
      })
    }
    procedural.evolveFromSignals('u_skillv')

    const evolved = store.getHarnessRule(rule.id)!
    expect(evolved.rule).toContain('边界强化')
    const versionsAfterEvolve = store.listHarnessRuleVersions(rule.id)
    expect(versionsAfterEvolve).toHaveLength(1)
    expect(versionsAfterEvolve[0]!.rule).toBe(initialRule)
    expect(versionsAfterEvolve[0]!.trigger_pattern).toBe(initialTrigger)
    expect(versionsAfterEvolve[0]!.reason).toBe('rule_insufficiency_strengthen')

    // 2. 非退化校验：丢失关键工具名（comments_list / replace_text / ack_comments / doc_edit）或过短的重写必须拒绝
    expect(isNonRegressiveRewrite(evolved.rule, '注意先检查一下再修改即可。')).toBe(false)
    expect(isNonRegressiveRewrite(evolved.rule, '修改有批注的段落时一定要小心谨慎处理，避免破坏原有结构。')).toBe(false)
    expect(
      isNonRegressiveRewrite(
        evolved.rule,
        '修改段落前先用 comments_list 检查批注；局部修改用 replace_text，触及锚点时传 ack_comments。',
      ),
    ).toBe(true)

    const baselineShadow = store.addHarnessRule({
      scope: 'user',
      owner: 'u_skillv',
      project_id: null,
      category: 'guard',
      trigger_pattern: 'conflict_user_edited',
      rule: '目标块被用户修改过时，以最新 rev 为准并用 replace_text 精准替换。',
      evidence_count: 10,
      status: 'active',
    })

    // 尝试用退化规则执行 strengthen -> 被拦截，updated=0
    const badRefine = await procedural.refineWithBackward('u_skillv', async () =>
      JSON.stringify({
        ops: [
          {
            op: 'strengthen',
            target_ids: [rule.id],
            rule: '修改有批注的段落时一定要小心谨慎处理，避免破坏原有结构。',
          },
        ],
      }),
    )
    expect(badRefine.updated).toBe(0)
    expect(store.getHarnessRule(rule.id)!.rule).toBe(evolved.rule)

    // 尝试将 baselineShadow 作为次要规则 merge 归档 -> primary 正常精炼并记录版本，但 baselineShadow 绝不被归档
    const mergeRes = await procedural.refineWithBackward('u_skillv', async () =>
      JSON.stringify({
        ops: [
          {
            op: 'merge',
            target_ids: [rule.id, baselineShadow.id],
            trigger_pattern: 'anchor_has_open_comments|批注|局部',
            rule: '编辑前先调 comments_list 核对批注；优先用 replace_text 局部修改，触及锚点须传 ack_comments。',
          },
        ],
      }),
    )
    expect(mergeRes.merged).toBe(1)
    expect(store.getHarnessRule(baselineShadow.id)!.status).toBe('active')
    expect(store.listHarnessRuleVersions(rule.id).length).toBeGreaterThanOrEqual(2)

    // 3. 测试 rollbackRuleVersion 恢复到最初版本
    const firstVersionId = versionsAfterEvolve[0]!.id
    const rolledBack = procedural.rollbackRuleVersion('u_skillv', rule.id, firstVersionId)
    expect(rolledBack).toBeDefined()
    expect(rolledBack!.rule).toBe(initialRule)
    expect(rolledBack!.trigger_pattern).toBe(initialTrigger)
  })
})
