/**
 * 样本量估算：用教科书 / 软件标准算例核对。
 * - 两组均值 d = 0.5、双侧 α 0.05、效能 80%：G*Power 两独立样本 t 检验为每组 64 例
 * - 两组率 30% vs 50%：正态近似（无校正）每组 93 例；Fleiss 连续性校正每组 103 例
 * - log-rank HR = 0.7、双侧 α 0.05、效能 80%、1:1：Schoenfeld 事件数 247
 * - Simon (1989) 表 1：p0 = 0.05, p1 = 0.25, α = 0.05, β = 0.2 → 最优 0/9, 2/17；极小极大 0/12, 2/16
 *   p0 = 0.10, p1 = 0.30 → 最优 1/10, 5/29；极小极大 1/15, 5/25
 */
import { describe, it, expect } from 'vitest'
import { calculateSampleSize, normalQuantile, simonTwoStage, tQuantileUpper } from '../src/research/sample-size.ts'

describe('样本量估算 (sample-size)', () => {
  it('分布函数：正态与 t 分位数', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5)
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5)
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326348, 5)
    expect(tQuantileUpper(0.025, 10)).toBeCloseTo(2.228139, 4)
    expect(tQuantileUpper(0.05, 30)).toBeCloseTo(1.697261, 4)
  })

  it('两组均值：d = 0.5 每组 64 例（与 G*Power 一致）；脱落率按每组向上取整', () => {
    const r = calculateSampleSize({ design: 'two_means', alpha: 0.05, power: 0.8, mean_diff: 5, sd: 10, dropout: 0.1 })
    expect(r.groups.map(g => g.n)).toEqual([64, 64])
    expect(r.total).toBe(128)
    expect(r.groups[0]!.n_with_dropout).toBe(72)
    expect(r.total_with_dropout).toBe(144)
    expect(r.methods_text_zh).toContain('双侧 α = 0.05')
    expect(r.methods_text_zh).toContain('10% 的脱落率')
  })

  it('两组率：30% vs 50% 每组 93 例；Fleiss 连续性校正每组 103 例；分配比 1:2', () => {
    const r = calculateSampleSize({ design: 'two_proportions', alpha: 0.05, power: 0.8, p1: 0.3, p2: 0.5 })
    expect(r.groups.map(g => g.n)).toEqual([93, 93])
    const cc = calculateSampleSize({ design: 'two_proportions', alpha: 0.05, power: 0.8, p1: 0.3, p2: 0.5, continuity_correction: true })
    expect(cc.groups.map(g => g.n)).toEqual([103, 103])
    const k2 = calculateSampleSize({ design: 'two_proportions', alpha: 0.05, power: 0.8, p1: 0.3, p2: 0.5, ratio: 2 })
    expect(k2.groups[1]!.n).toBeGreaterThan(k2.groups[0]!.n)
    expect(k2.total).toBeGreaterThan(r.total)
  })

  it('生存 log-rank：HR 0.7 需 247 个事件；总例数 = 事件数 / 事件发生比例；可由中位生存期推算', () => {
    const r = calculateSampleSize({ design: 'survival_logrank', alpha: 0.05, power: 0.8, hr: 0.7, event_prob: 0.5 })
    expect(r.events_required).toBe(247)
    expect(r.total).toBe(494)
    const exp = calculateSampleSize({ design: 'survival_logrank', alpha: 0.05, power: 0.8, hr: 0.7, median_control: 12, accrual: 24, follow_up: 12 })
    expect(exp.events_required).toBe(247)
    expect(exp.event_prob_used!).toBeGreaterThan(0.5)
    expect(exp.event_prob_used!).toBeLessThan(0.9)
    expect(exp.methods_text_zh).toContain('指数分布')
  })

  it('单臂精确二项：满足 α / 效能约束，且 n − 1 不满足（最小性）', () => {
    const r = calculateSampleSize({ design: 'one_proportion', alpha: 0.05, power: 0.8, p0: 0.2, p1: 0.4 })
    const op = r.one_proportion!
    expect(op.actual_alpha).toBeLessThanOrEqual(0.05)
    expect(op.actual_power).toBeGreaterThanOrEqual(0.8)
    expect(op.normal_approx_n).toBe(29)
    expect(r.total).toBeGreaterThanOrEqual(25)
    expect(r.total).toBeLessThanOrEqual(45)
  })

  it('Simon 两阶段：与 Simon (1989) 原文表格一致', () => {
    const a = simonTwoStage(0.05, 0.25, 0.05, 0.8)!
    expect([a.optimal.r1, a.optimal.n1, a.optimal.r, a.optimal.n]).toEqual([0, 9, 2, 17])
    expect([a.minimax.r1, a.minimax.n1, a.minimax.r, a.minimax.n]).toEqual([0, 12, 2, 16])
    const b = simonTwoStage(0.1, 0.3, 0.05, 0.8)!
    expect([b.optimal.r1, b.optimal.n1, b.optimal.r, b.optimal.n]).toEqual([1, 10, 5, 29])
    expect([b.minimax.r1, b.minimax.n1, b.minimax.r, b.minimax.n]).toEqual([1, 15, 5, 25])
    expect(b.optimal.en0).toBeCloseTo(15.0, 0)
  })

  it('缺参数或参数非法时报错，不使用任何默认效应量', () => {
    expect(() => calculateSampleSize({ design: 'two_proportions', alpha: 0.05, power: 0.8 })).toThrow(/p1/)
    expect(() => calculateSampleSize({ design: 'two_means', alpha: 0.05, power: 0.8, mean_diff: 5 })).toThrow(/sd/)
    expect(() => calculateSampleSize({ design: 'survival_logrank', alpha: 0.05, power: 0.8, hr: 0.7 })).toThrow(/event_prob|median_control/)
    expect(() => calculateSampleSize({ design: 'two_means', alpha: 0.6, power: 0.8, mean_diff: 1, sd: 1 })).toThrow(/alpha/)
    expect(() => calculateSampleSize({ design: 'simon_two_stage', alpha: 0.05, power: 0.8, p0: 0.3, p1: 0.2 })).toThrow(/大于/)
    expect(() => calculateSampleSize({ design: 'simon_two_stage', alpha: 0.05, power: 0.8, sides: 2, p0: 0.1, p1: 0.3 })).toThrow(/单侧/)
  })
})
