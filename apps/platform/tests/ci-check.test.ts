import { describe, expect, it } from 'vitest'
import { findCiProblems } from '../src/claims/ci-check.ts'
import { auditInternalConsistency, extractTableSummaries } from '../src/claims/extract.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'

// 点估计与置信区间是否自洽（纯数字判断）

describe('点估计与区间', () => {
  it('估计值落在区间外、上下界倒挂', () => {
    expect(findCiProblems('aOR 1.93 (95% CI 2.10–3.38)')).toMatchObject([{ kind: 'outside', estimate: 1.93, low: 2.1, high: 3.38 }])
    expect(findCiProblems('HR 1.271 (95% CI 1.105–1.247)')).toMatchObject([{ kind: 'outside' }])
    expect(findCiProblems('OR 0.80 (95% CI 0.95–0.62)')).toMatchObject([{ kind: 'inverted' }])
    // 不带括号的「估计值, 95% CI 下界–上界」
    expect(findCiProblems('(OR: 1.93, 95% CI: 2.10–3.38)')).toMatchObject([{ kind: 'outside', estimate: 1.93 }])
    expect(findCiProblems('HR 0.72; 95% CI 0.60 to 0.86')).toEqual([])
    // 负数与「to」
    expect(findCiProblems('mean difference 1.00 (95% CI 1.84 to 3.20)')).toMatchObject([{ kind: 'outside' }])
    expect(findCiProblems('mean difference −0.4 (95% CI −1.2 to 0.3)')).toEqual([])
  })

  it('自洽的不报；四舍五入的容差', () => {
    expect(findCiProblems('HR 0.72 (95% CI 0.60–0.86)')).toEqual([])
    expect(findCiProblems('OR 1.00 (95% CI 1.00–1.21)')).toEqual([])
    expect(findCiProblems('HR 0.86 (95% CI 0.865–1.10)')).toEqual([])
    expect(findCiProblems('median 62 (IQR 55–70)')).toEqual([])
  })

  it('紧挨在 CI 前面的是 P 值时不当成点估计', () => {
    expect(findCiProblems('OR 1.49, p = 0.24, CI 0.77–2.88')).toEqual([])
    expect(findCiProblems('aOR 2.02 p < 0.000, CI 1.39-2.93')).toEqual([])
    expect(findCiProblems('HR 1.2 (P-value: 0.03; 95% CI 1.05–1.40)')).toEqual([])
  })

  it('上下文不明确时不判断：普通括号、引用编号、年份', () => {
    expect(findCiProblems('Patients aged 45 (30–40) were enrolled.')).toEqual([])
    expect(findCiProblems('as reported previously 2 [4–6].')).toEqual([])
    expect(findCiProblems('between 2019 (2015–2018)')).toEqual([])
    // 调用方确认是区间（表格的 CI 列）时照判
    expect(findCiProblems('0.78 (0.66–0.76)', true)).toMatchObject([{ kind: 'outside' }])
  })
})

describe('接入规则检查', () => {
  function audit(md: string) {
    const docs = new Documents(new Store(':memory:'))
    const doc = docs.get(docs.create({ owner: 'u', title: 't', markdown: md }).id)
    return auditInternalConsistency(doc, extractTableSummaries(doc))
  }

  it('正文里估计值落在区间外报出', () => {
    const issues = audit('# 稿件\n\n## Results\n\nThe odds of stroke were higher (OR 1.93 (95% CI 2.10–3.38)).\n')
    const ci = issues.filter(i => i.subtype === 'ci_estimate_outside_interval')
    expect(ci).toHaveLength(1)
    expect(ci[0]!.snippet).toBe('1.93 (95% CI 2.10–3.38)')
  })

  it('表格 CI 列里的区间按格报出，带单元格位置；行名或表头不提 CI 时不判断', () => {
    const md = '# 稿件\n\n## Results\n\nTable 2. Adjusted prevalence ratios\n\n| Region | PR (95% CI) |\n|---|---|\n| North | 1.00 (0.80–1.20) |\n| South | 0.78 (0.66–0.76) |\n\nTable 3. Counts\n\n| Group | Value |\n|---|---|\n| A | 45 (30–40) |\n'
    const issues = audit(md).filter(i => i.subtype === 'ci_estimate_outside_interval')
    expect(issues.map(i => i.snippet)).toEqual(['0.78 (0.66–0.76)'])
    expect(issues[0]!.cell).toEqual([2, 1])
  })

  it('表格百分比：亚组分母、按行算的百分比不报，孤立算错的照报', () => {
    // 两组各 N = 179；「绝经后」各行的百分比按亚组（对照 76 人、病例 110 人）算；「Smoking」一行按行合计算（加起来 100%）
    const md = '# 稿件\n\n## Results\n\nTable 1. Characteristics\n\n| Variable | Controls (N = 179) | Stroke (N = 179) |\n|---|---|---|\n' +
      '| Postmenopausal, < 1 year | 22 (28.9) | 37 (33.6) |\n| Postmenopausal, 1–5 years | 50 (65.8) | 65 (59.1) |\n| Postmenopausal, > 5 years | 4 (5.3) | 8 (7.3) |\n' +
      '| Smoking | 60 (40.0) | 90 (60.0) |\n| Hypertension | 51 (28.5) | 108 (70.3) |\n'
    const cells = audit(md).filter(i => i.subtype === 'table_cell_percentage_arithmetic_error').map(i => i.snippet)
    // 108/179 = 60.3%，不是 70.3%：孤立的算错
    expect(cells).toEqual(['108 (70.3)'])
  })

  it('正文引用表 1 的百分比：表里不写 % 号的数也算对上', () => {
    const md = '# 稿件\n\n## Results\n\nParticipants were 60% male with HbA1c 7.5 ± 0.9% (Table 1).\n\nTable 1. Baseline\n\n| Characteristic | Value |\n|---|---|\n| Sex (% male) | 60 |\n| HbA1c (%) | 7.5 ± 0.9 |\n'
    expect(audit(md).some(i => i.subtype === 'table1_cited_percentage_mismatch')).toBe(false)
  })
})
