import { describe, expect, it } from 'vitest'
import { ExecutionSignals } from '../src/memory/execution-signals.ts'
import * as proceduralMod from '../src/memory/procedural.ts'
import { ProceduralHarnessService } from '../src/memory/procedural.ts'
import { MemoryService } from '../src/memory/service.ts'
import { SkillTrainingService, computeDomainAlignment } from '../src/memory/skill-trainer.ts'
import { runCrossDomainEval } from '../../../paper/benchmarks/v2/cross-domain-eval.ts'
import { runOnlineExp3ZeroTemplatePilot } from '../../../paper/benchmarks/v2/exp3-zero-template-pilot.ts'
import { setup } from './helpers.ts'

describe('Cross-Domain Self-Evolution Kernel & Skill-Training Integration', () => {
  it('彻底移除人工模板字典 LEARNED_RULE_TEMPLATES，确保零测试集硬编码', () => {
    expect('LEARNED_RULE_TEMPLATES' in proceduralMod).toBe(false)
  })

  it('Track B 路由漏检反向归因（Routing Miss, r* ∉ R_active）：自动从用户指令提取特征词扩充 trigger_pattern', async () => {
    const { store, docs, docId } = setup('# 方法\n\n研究共纳入两家中心队列。')
    const procedural = new ProceduralHarnessService(store, docs)
    const execSignals = new ExecutionSignals(store, docs, {
      activationLookup: (owner, did) => procedural.lastActivation(owner, did),
    })

    // 初始已有一条未关闭批注规则，但触发模式仅有守卫码
    const rule = store.addHarnessRule({
      scope: 'user',
      owner: 'u_route',
      project_id: null,
      category: 'guard',
      trigger_pattern: 'anchor_has_open_comments',
      rule: '目标段有未关闭批注时，先调用 comments_list 检查并用 replace_text 保留锚点原文。',
      evidence_count: 2,
      status: 'active',
    })
    const tightBudget = rule.rule.length + 25
    const implicitMsg = '请将方法部分的首句队列说明规范化表述'

    // 1. 当前文档无 open comment 且用户指令未提“批注”，紧预算下该规则未被路由命中（R_active 不含 rule.id）
    const promptBefore = await procedural.forPrompt('u_route', docId, implicitMsg, tightBudget)
    expect(promptBefore).not.toContain(rule.rule)
    expect(procedural.lastActivation('u_route', docId)?.ruleIds).not.toContain(rule.id)

    // 2. 在该指令下连续发生 2 次同码拦截（记录了当时的 R_active 与 user_message）
    for (const t of ['t_miss_1', 't_miss_2']) {
      execSignals.recordGuardReject({
        owner: 'u_route',
        docId,
        turnId: t,
        code: 'anchor_has_open_comments',
        message: '修改会移除未关闭批注锚点',
      })
    }

    // 3. 触发反向归因：检测到 rule.id ∉ R_active（Routing Miss），自动提取指令特征词扩充 trigger_pattern
    procedural.evolveFromSignals('u_route')
    const updated = store.getHarnessRule(rule.id)!
    expect(updated.trigger_pattern).toContain('anchor_has_open_comments|')
    expect(updated.trigger_pattern.split('|').length).toBeGreaterThan(1)

    // 4. 下一轮面对同类指令表述时，无需显式包含“批注”二字即可在紧预算下精准路由命中
    const promptAfter = await procedural.forPrompt('u_route', docId, implicitMsg, tightBudget)
    expect(promptAfter).toContain(updated.rule)
  })

  it('Track B 规则不足反向归因（Rule Insufficiency, r* ∈ R_active）：已注入规则再次失败时执行 Strengthen 强化与 Merge 合并', async () => {
    const { store, docs, docId } = setup('# 讨论\n\n主要终点显著改善。')
    const procedural = new ProceduralHarnessService(store, docs)
    const execSignals = new ExecutionSignals(store, docs, {
      activationLookup: (owner, did) => procedural.lastActivation(owner, did),
    })

    const rule = store.addHarnessRule({
      scope: 'user',
      owner: 'u_refine',
      project_id: null,
      category: 'guard',
      trigger_pattern: 'anchor_has_open_comments',
      rule: '编辑前先检查段落是否有未关闭批注。',
      evidence_count: 3,
      status: 'active',
    })

    // 1. 用户明确提及批注，规则成功被路由注入（rule.id ∈ R_active）
    const p1 = await procedural.forPrompt('u_refine', docId, '处理讨论段的批注并改写首句', 500)
    expect(p1).toContain(rule.rule)
    expect(procedural.lastActivation('u_refine', docId)?.ruleIds).toContain(rule.id)

    // 2. 尽管规则已注入，Agent 在跨段合并边缘场景下仍触发拦截，并在同轮通过 ack_comments + comment_reply 恢复成功
    for (const t of ['t_ins_1', 't_ins_2']) {
      execSignals.recordGuardReject({
        owner: 'u_refine',
        docId,
        turnId: t,
        code: 'anchor_has_open_comments',
        message: '跨段改写移除了批注锚点',
        extra: {
          hint: '必须改写锚点文字时，须将对应批注 id 填入 ack_comments 并在线程中回复说明。',
          recovery_ops: 'doc_edit(ack_comments) -> comment_reply',
        },
      })
    }

    // 3. 反向归因：检测到 rule.id ∈ R_active，执行 strengthen 将边缘场景修法与恢复轨迹并入规则正文
    procedural.evolveFromSignals('u_refine')
    const strengthened = store.getHarnessRule(rule.id)!
    expect(strengthened.rule).toContain('边界强化')
    expect(strengthened.rule).toContain('ack_comments')
    expect(strengthened.rule).toContain('doc_edit(ack_comments) -> comment_reply')

    // 4. 测试大模型 Backward Merge 算子：合并同类别重叠规则并归档冗余项
    const dupRule = store.addHarnessRule({
      scope: 'user',
      owner: 'u_refine',
      project_id: null,
      category: 'guard',
      trigger_pattern: 'comment_anchor_lost',
      rule: '修改含批注段落时保留批注锚点。',
      evidence_count: 2,
      status: 'active',
    })
    const res = await procedural.refineWithBackward('u_refine', async () =>
      JSON.stringify({
        ops: [
          {
            op: 'merge',
            target_ids: [rule.id, dupRule.id],
            trigger_pattern: 'anchor_has_open_comments|批注|重写',
            rule: '修改段落前先用 comments_list 检查未关闭批注；局部修改用 replace_text 保留锚点，整句改写须传 ack_comments 并回复线程。',
          },
        ],
      }),
    )
    expect(res.merged).toBe(1)
    expect(store.getHarnessRule(dupRule.id)?.status).toBe('archived')
    expect(store.getHarnessRule(rule.id)?.rule).toContain('comments_list')
  })

  it('跨领域零模板合成与多领域混合会话 MoE 路由隔离（Zero Negative Transfer）', async () => {
    const { store, docs, docId } = setup('# 跨领域项目工作台\n\n初始化内容。')
    const procedural = new ProceduralHarnessService(store, docs)
    const execSignals = new ExecutionSignals(store, docs, {
      activationLookup: (owner, did) => procedural.lastActivation(owner, did),
    })

    // 1. 生物统计领域（biostats）产生未知工具验证器拦截信号
    for (const t of ['tb1', 'tb2']) {
      execSignals.recordToolFailure({
        owner: 'u_cross',
        docId,
        turnId: t,
        domain: 'biostats',
        code: 'chi2_expected_cell_lt_5',
        message: '分类变量列联表存在期望频数小于 5 的稀疏单元格',
        hint: '当 2x2 列联表任意格期望频数 < 5 时，禁止使用 Pearson 卡方检验，须改用 test="fisher_exact"。',
        failedArgs: 'dataset_table1(test="chisq")',
        recoveryArgs: 'dataset_table1(test="fisher_exact")',
        userMessage: '生成基线 Table 1 并比较两组并发症发生率',
      })
    }

    // 2. 演示文稿领域（deck）产生未知版面引擎拦截信号
    for (const t of ['td1', 'td2']) {
      execSignals.recordToolFailure({
        owner: 'u_cross',
        docId,
        turnId: t,
        domain: 'deck',
        code: 'slide_bbox_overflow',
        message: '幻灯片正文文本框内容超出页面底部边界 42pt',
        hint: '单页要点超过 5 条时请拆分为 two_column 双栏版式或精简每条要点至 15 字以内。',
        failedArgs: 'deck_edit(bullets=8, layout="single")',
        recoveryArgs: 'deck_edit(bullets=4, layout="two_column")',
        userMessage: '制作项目汇报幻灯片第三页核心发现',
      })
    }

    const synthesized = procedural.evolveFromSignals('u_cross')
    expect(synthesized).toHaveLength(2)
    const biostatRule = synthesized.find(r => r.trigger_pattern.startsWith('chi2_expected_cell_lt_5'))!
    const deckRule = synthesized.find(r => r.trigger_pattern.startsWith('slide_bbox_overflow'))!
    expect(biostatRule.rule).toContain('[domain:biostats]')
    expect(biostatRule.rule).toContain('fisher_exact')
    expect(deckRule.rule).toContain('[domain:deck]')
    expect(deckRule.rule).toContain('two_column')

    // 3. 多领域混合会话路由隔离验证：
    // (a) 当处于生物统计任务时，只激活 biostats 规则，绝不注入 deck 排版规则
    const biostatPrompt = await procedural.forPrompt(
      'u_cross',
      docId,
      '请计算队列基线表并检验两组分类结局差异',
      600,
      { domain: 'biostats', predicates: { chi2_expected_cell_lt_5: true } },
    )
    expect(biostatPrompt).toContain('fisher_exact')
    expect(biostatPrompt).not.toContain('two_column')

    // (b) 当切换到制作 PPT 幻灯片任务时，只激活 deck 规则，绝不注入 biostats 规则
    const deckPrompt = await procedural.forPrompt(
      'u_cross',
      docId,
      '把这页幻灯片改造成双栏汇报版式',
      600,
      { domain: 'deck', predicates: { slide_bbox_overflow: true } },
    )
    expect(deckPrompt).toContain('two_column')
    expect(deckPrompt).not.toContain('fisher_exact')
  })

  it('Track A 跨领域退化-重构闭环（manuscript / biostats / deck）与实例-技能解耦 & PHI 守卫', async () => {
    const { store, docs } = setup('# 范例文档\n\n测试。')
    const memory = new MemoryService(store, null)
    const trainer = new SkillTrainingService(store, memory, docs)

    // 1. 研究写作领域（manuscript）：Epoch 0 -> 采纳技能 -> Epoch 1 重建对齐度单调提升
    const msExemplar =
      'Multivariable analysis demonstrated that early intervention was associated with lower 30-day mortality (HR = 0.68 (95% CI, 0.51–0.89; P = .004)), consistent with prior studies demonstrating benefit in high-risk cohorts.'
    const epoch0 = await trainer.trainFromExemplar('u_train', {
      exemplarText: [msExemplar],
      domain: 'manuscript',
      useLlm: false,
    })
    expect(epoch0.pairs).toHaveLength(1)
    expect(epoch0.proposed.length).toBeGreaterThanOrEqual(2)
    // 验证 Invariant 3：所有提炼出的技能均为 proposed 候选态，未自动变为 active
    expect(epoch0.proposed.every(m => m.status === 'proposed')).toBe(true)

    // 模拟用户确认采纳提炼出的领域技能
    for (const p of epoch0.proposed) {
      await memory.edit('u_train', p.id, { status: 'active' })
    }

    // Epoch 1：挂载已激活的技能再次对新范例执行退化-重构，验证重建对齐度高于 Epoch 0
    const epoch1 = await trainer.trainFromExemplar('u_train', {
      exemplarText: [msExemplar],
      domain: 'manuscript',
      useLlm: false,
    })
    expect(epoch1.pairs[0]!.alignmentScore).toBeGreaterThan(epoch0.pairs[0]!.alignmentScore)

    // 2. 生物统计领域（biostats）与演示文稿领域（deck）跨领域退化-重构
    const bioRes = await trainer.trainFromExemplar('u_train', {
      exemplarText: [
        "Skewed continuous biomarkers were summarized as median [IQR] and compared using the Mann-Whitney U test; categorical variables with expected cell counts < 5 were analyzed using Fisher's exact test. Proportional hazards were verified via Schoenfeld residuals with EPV >= 10.",
      ],
      domain: 'biostats',
      useLlm: false,
    })
    expect(bioRes.proposed.some(p => p.content.includes('[domain:biostats]') && p.content.includes('Median [IQR]'))).toBe(true)
    expect(bioRes.proposed.some(p => p.content.includes('Fisher'))).toBe(true)

    const deckRes = await trainer.trainFromExemplar('u_train', {
      exemplarText: [
        'Action Title: Early Dual-Pathway Protocol Reduced ICU Length of Stay by 28%\n[layout: two_column]\n- Arm A vs Arm B baseline comparison\n- Paired Kaplan-Meier survival chart on left panel',
      ],
      domain: 'deck',
      useLlm: false,
    })
    expect(deckRes.proposed.some(p => p.content.includes('[domain:deck]'))).toBe(true)

    // 3. 验证实例-技能解耦守卫（Instance–Skill Decoupling Guard）与 PHI 隐私守卫
    const trainerWithLeakyLlm = new SkillTrainingService(store, memory, docs, async () =>
      JSON.stringify({
        ops: [
          {
            op: 'create',
            kind: 'fact',
            content: '本研究共纳入 312 例患者，主要终点 HR = 0.68 (0.51–0.89)。',
            reason: '包含具体样本量与效应量数值（应被实例解耦守卫拦截）',
          },
          {
            op: 'create',
            kind: 'fact',
            content: '患者张三（手机号 13812345678）对阿司匹林过敏。',
            reason: '包含患者 PHI 隐私（应被隐私守卫拦截）',
          },
          {
            op: 'create',
            kind: 'style',
            content: '多变量回归模型报告须同时列出粗效应量与调整后效应量。',
            reason: '合法可迁移的通用方法学规则',
          },
        ],
      }),
    )
    const guardedRes = await trainerWithLeakyLlm.trainFromExemplar('u_train', {
      exemplarText: [msExemplar],
      domain: 'manuscript',
      useLlm: true,
    })
    expect(guardedRes.filtered_leaks).toHaveLength(2)
    expect(guardedRes.proposed).toHaveLength(1)
    expect(guardedRes.proposed[0]!.content).toContain('粗效应量与调整后效应量')
    expect(computeDomainAlignment(msExemplar, msExemplar, [], 'manuscript')).toBeGreaterThanOrEqual(0.8)
  })

  it('Exp 3b + Exp 4a/4b 跨领域基准评测套件完整通过', async () => {
    const report = await runCrossDomainEval()
    expect(report.zero_template_verified).toBe(true)
    expect(report.exp3b_backward_credit.routing_miss_recall_before).toBe(0)
    expect(report.exp3b_backward_credit.routing_miss_recall_after).toBe(1)
    expect(report.exp3b_backward_credit.strengthened_rules_count).toBe(1)
    for (const domain of ['manuscript', 'biostats', 'deck'] as const) {
      const d = report.exp4a_cross_domain_convergence[domain]!
      expect(d.track_b_synthesized_rules).toBe(2)
      expect(d.track_a_epoch1_alignment).toBeGreaterThan(d.track_a_epoch0_alignment)
      expect(d.instance_leakage_rate).toBe(0)
      expect(d.phi_leakage_rate).toBe(0)
    }
    expect(report.exp4b_multi_domain_routing.target_domain_hit_rate).toBe(1)
    expect(report.exp4b_multi_domain_routing.cross_domain_contamination_rate).toBe(0)
    expect(report.memtransfer_single_axis_degradation.axis1_schema_paraphrase.lexical_only_recall).toBe(0)
    expect(report.memtransfer_single_axis_degradation.axis1_schema_paraphrase.semantic_cue_recovery_recall).toBe(1)
    expect(report.memtransfer_single_axis_degradation.axis2_guard_threshold_shift.false_trigger_rate).toBe(0)
    expect(report.memtransfer_single_axis_degradation.axis2_guard_threshold_shift.valid_state_trigger_rate).toBe(1)
    expect(report.memtransfer_single_axis_degradation.axis3_unseen_domain_abstention.irrelevant_user_rule_leak_rate).toBe(0)
    expect(report.memtransfer_single_axis_degradation.axis3_unseen_domain_abstention.baseline_guard_retention_rate).toBe(1)
    expect(report.memtransfer_single_axis_degradation.axis3_unseen_domain_abstention.blindspot_vantaging_triggered).toBe(true)
  })

  it.skipIf(process.env.RUN_ONLINE_PILOT !== '1')(
    'Online Exp 3 Zero-Template Multi-Session Pilot (deepseek-flash, 72 turns across off / frozen / utility)',
    async () => {
      const pilot = await runOnlineExp3ZeroTemplatePilot()
      console.log('=== EXP3_ZERO_TEMPLATE_PILOT_START ===')
      console.log(JSON.stringify(pilot, null, 2))
      console.log('=== EXP3_ZERO_TEMPLATE_PILOT_END ===')
      expect(pilot.zero_template_verified).toBe(true)
      expect(pilot.arms.utility.learned_rules_count).toBeGreaterThanOrEqual(4)
      expect(pilot.arms.utility.rejections_per_turn).toBeLessThan(pilot.arms.frozen.rejections_per_turn)
      expect(pilot.arms.utility.heldout_rejections_per_turn).toBeLessThan(pilot.arms.frozen.heldout_rejections_per_turn)
    },
  )
})
