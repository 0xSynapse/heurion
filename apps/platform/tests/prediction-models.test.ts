import { describe, it, expect } from 'vitest'
import {
  buildNomogram,
  renderNomogramSvg,
  calculateRocCurve,
  renderRocCurveSvg,
  calculateDcaCurve,
  renderDcaCurveSvg,
  type NomogramPredictor
} from '../src/research/prediction-models.ts'

describe('临床预后预测模型套件 (Nomogram & ROC / DCA)', () => {
  it('1. buildNomogram: 多因素 Cox 比例风险 0~100 评分标尺与 1/3/5年生存率计算', () => {
    const nomo = buildNomogram({
      title: '晚期胃癌综合治疗预后预测列线图 (Nomogram)',
      predictors: [
        { variable: 'treatment', label: '治疗方案 (Treatment)', type: 'binary', beta: -0.68, min_val: 0, max_val: 1 },
        { variable: 'l3_smi', label: '骨骼肌质量指数 SMI', type: 'continuous', beta: -0.045, min_val: 30, max_val: 65 },
        { variable: 'vat_to_sat', label: '内脏/皮下脂肪比 (VAT/SAT)', type: 'continuous', beta: 0.72, min_val: 0.4, max_val: 1.8 },
        { variable: 'age', label: '患者年龄 (周岁)', type: 'continuous', beta: 0.038, min_val: 40, max_val: 85 }
      ],
      baseline_survival: {
        year1: 0.88,
        year3: 0.72,
        year5: 0.55
      }
    })

    expect(nomo.title).toBe('晚期胃癌综合治疗预后预测列线图 (Nomogram)')
    expect(nomo.predictors.length).toBe(4)
    expect(nomo.max_total_points).toBeGreaterThan(150)
    expect(nomo.survival_scale.year1.length).toBeGreaterThan(0)
    expect(nomo.survival_scale.year3.length).toBeGreaterThan(0)
    expect(nomo.survival_scale.year5.length).toBeGreaterThan(0)

    // 检查最大效应变量分值为 100 分标尺
    const maxVarPoints = Math.max(...nomo.predictors.map(p => p.points_range || 0))
    expect(maxVarPoints).toBe(100)

    // 验证二分类变量的刻度
    const treatPred = nomo.predictors.find(p => p.variable === 'treatment')!
    expect(treatPred.type).toBe('binary')
    expect(treatPred.ticks?.length).toBe(2)
    // beta 为负数时，0 (未治疗/标准组) 应得较高分 (风险更大)，1 得 0 分
    expect(treatPred.ticks?.find(t => t.value === 1)?.points).toBe(0)
    expect(treatPred.ticks?.find(t => t.value === 0)?.points).toBe(treatPred.points_range)

    // 验证 SVG 结构
    expect(nomo.svg).toContain('<svg')
    expect(nomo.svg).toContain('晚期胃癌综合治疗预后预测列线图')
    expect(nomo.svg).toContain('Points')
    expect(nomo.svg).toContain('Total Points')
    expect(nomo.svg).toContain('1-Year Survival')
    expect(nomo.svg).toContain('3-Year Survival')
    expect(nomo.svg).toContain('5-Year Survival')
    expect(nomo.svg).toContain('</svg>')

    // 零 Emoji 检查
    expect(nomo.svg).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u)
  })

  it('2. calculateRocCurve & renderRocCurveSvg: 受试者工作特征曲线、AUC 积分与 95% 置信区间', () => {
    // 模拟二分类真实标签与预测概率（包含真实临床中的混淆重叠）
    const labels = [1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0]
    // 临床基线模型（AUC ~ 0.73，存在数个重叠误判）
    const clinicalProbs = [0.65, 0.45, 0.58, 0.52, 0.48, 0.70, 0.35, 0.62, 0.72, 0.25, 0.55, 0.40, 0.68, 0.62, 0.42, 0.38, 0.75, 0.30, 0.60, 0.55]
    // 临床 + 3D 影像组学融合模型（AUC ~ 0.90，判别能力显著提升）
    const multimodalProbs = [0.92, 0.12, 0.88, 0.18, 0.79, 0.89, 0.15, 0.28, 0.95, 0.05, 0.82, 0.22, 0.86, 0.91, 0.18, 0.15, 0.96, 0.08, 0.85, 0.28]

    const roc1 = calculateRocCurve(labels, clinicalProbs, '临床基线模型', '#94a3b8')
    const roc2 = calculateRocCurve(labels, multimodalProbs, '临床 + 3D 影像组学融合模型', '#0284c7')

    // 检验 AUC 合理性
    expect(roc1.auc).toBeGreaterThan(0.70)
    expect(roc2.auc).toBeGreaterThanOrEqual(roc1.auc)
    expect(roc2.auc_ci[0]).toBeLessThanOrEqual(roc2.auc)
    expect(roc2.auc_ci[1]).toBeGreaterThanOrEqual(roc2.auc)

    // 检验 Youden 指数与灵敏度/特异度
    expect(roc2.sensitivity).toBeGreaterThan(0.70)
    expect(roc2.specificity).toBeGreaterThan(0.70)
    expect(roc2.youden_index).toBeCloseTo(roc2.sensitivity + roc2.specificity - 1, 2)

    // 渲染对比 SVG
    const svg = renderRocCurveSvg([roc1, roc2], '诊断效能对比 ROC 曲线')
    expect(svg).toContain('<svg')
    expect(svg).toContain('诊断效能对比 ROC 曲线')
    expect(svg).toContain('1 - Specificity')
    expect(svg).toContain('Sensitivity')
    expect(svg).toContain('临床 + 3D 影像组学融合模型')
    expect(svg).toContain(roc2.auc.toFixed(3))
    expect(svg).toContain('</svg>')

    // 零 Emoji 检查
    expect(svg).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u)
  })

  it('3. calculateDcaCurve & renderDcaCurveSvg: 临床决策曲线分析 (Net Benefit)', () => {
    const labels = [1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0]
    const probs = [0.92, 0.12, 0.88, 0.18, 0.79, 0.89, 0.15, 0.28, 0.95, 0.05, 0.82, 0.22, 0.86, 0.91, 0.18, 0.15, 0.96, 0.08, 0.85, 0.28]
    const prevalence = 0.50

    const dca = calculateDcaCurve(labels, probs, '影像组学预后模型', '#0284c7')
    expect(dca.model_name).toBe('影像组学预后模型')
    expect(dca.points.length).toBeGreaterThan(10)

    // 在低阈值时，Treat All 净获益应当较高
    const ptLow = dca.points.find(p => Math.abs(p.threshold - 0.10) < 0.02)!
    expect(ptLow.net_benefit_all).toBeGreaterThan(0)
    expect(ptLow.net_benefit_none).toBe(0)

    // 在中高阈值时，模型净获益应当优于 Treat All
    const ptMid = dca.points.find(p => Math.abs(p.threshold - 0.40) < 0.02)!
    expect(ptMid.net_benefit_model).toBeGreaterThan(ptMid.net_benefit_all)

    // 渲染 DCA 曲线 SVG
    const svg = renderDcaCurveSvg([dca], prevalence, '临床净获益决策曲线 (DCA)')
    expect(svg).toContain('<svg')
    expect(svg).toContain('临床净获益决策曲线 (DCA)')
    expect(svg).toContain('Threshold Probability')
    expect(svg).toContain('Net Benefit (净获益)')
    expect(svg).toContain('Treat All')
    expect(svg).toContain('Treat None')
    expect(svg).toContain('</svg>')

    // 零 Emoji 检查
    expect(svg).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}]/u)
  })

  it('buildNomogram: 叙述区分数据集拟合与用户系数、单预测因子不称多因素/独立，R 脚本按模型类型生成', () => {
    const preds = [
      { variable: 'age', label: '年龄', type: 'continuous' as const, beta: 0.04, min_val: 40, max_val: 80 },
      { variable: 'stage', label: '分期', type: 'binary' as const, beta: 0.9, min_val: 0, max_val: 1 },
    ]
    // 用户手填系数、未指定模型类型：不得称「真实研究数据集」「独立预测因子」，R 脚本只给注释
    const manual = buildNomogram({ predictors: preds })
    expect(manual.academic_narrative_zh).toContain('基于用户提供的')
    expect(manual.academic_narrative_zh).not.toMatch(/真实研究数据集|独立预测因子|本研究数据集拟合/)
    expect(manual.native_exports?.r_script).toContain('请按原模型类型修改')
    expect(manual.native_exports?.r_script).not.toMatch(/^f <- cph/m)
    expect(manual.native_exports?.r_script).not.toContain('Survival(f)')

    // 单个预测因子：不说多因素
    const single = buildNomogram({ predictors: [preds[0]!], sample_size: 50, events_n: 20, model_type: 'logistic' })
    expect(single.academic_narrative_zh).toContain('基于本研究数据集拟合的单因素 Logistic 回归模型')
    expect(single.academic_narrative_zh).not.toMatch(/多因素|独立/)
    expect(single.academic_narrative).not.toMatch(/multivariable/)
    expect(single.native_exports?.r_script).toContain('lrm(outcome ~ age')
    expect(single.native_exports?.r_script).toContain('fun = plogis')

    // Cox 且提供了基线生存率：才写 cph + Survival，且只写提供了的年份
    const cox = buildNomogram({ predictors: preds, baseline_survival: { year3: 0.7 } })
    expect(cox.native_exports?.r_script).toContain('cph(Surv(time, status) ~ age + stage')
    expect(cox.native_exports?.r_script).toContain('surv_fn(36, x)')
    expect(cox.native_exports?.r_script).not.toContain('surv_fn(12, x)')
    expect(cox.native_exports?.r_script).not.toContain('5-Year Survival')

    // Cox 但没有基线生存率：不写 Survival 函数
    const coxNoS0 = buildNomogram({ predictors: preds, model_type: 'cox' })
    expect(coxNoS0.native_exports?.r_script).toContain('cph(')
    expect(coxNoS0.native_exports?.r_script).not.toContain('Survival(f)')
  })
})
