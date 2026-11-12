/**
 * 回归测试：数据缺失或无法估计时必须报错或返回空值，绝不用示例数字兜底。
 * 背景：曾有多处在缺数据时填入写死的人数 / 效应量 / 生存率，界面与导出物看起来像真实结果。
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { Store } from '../src/store/db.ts'
import { registerResearchRoutes } from '../src/http/routes/research.ts'
import { parseConsortInput } from '../src/research/consort.ts'
import { analyzeDatasetCausalBalance } from '../src/research/causal-inference.ts'
import { calculateRocCurve, fitRocDcaFromRecords } from '../src/research/prediction-models.ts'
import { calculateCoxRegression, calculateSingleGroupKm, generateSurvivalAnalysis } from '../src/datasets/survival.ts'
import { generateTable1FromData } from '../src/datasets/table1.ts'
import { generateLogisticRegression } from '../src/datasets/clinical-plots.ts'
import { parseProtocolTextToRules } from '../src/research/service.ts'
import { detectDemoInput, isDemoSvg, markDemoSvg } from '../src/research/demo-data.ts'

function makeApp(store = new Store(':memory:')) {
  const app = new Hono<{ Variables: { user: string } }>()
  app.use('*', async (c, next) => {
    c.set('user', 'u1')
    await next()
  })
  registerResearchRoutes(app, {
    store,
    me: () => ({ userId: 'u1', via: 'user' as const }),
    patientFailure: c => c.json({ error: 'patient_err' }, 400),
  })
  return app
}

describe('不得用示例数据兜底 (no fabricated fallbacks)', () => {
  it('CONSORT：缺人数字段时报错，不再填 240/188/94', async () => {
    expect(() => parseConsortInput({}, 't')).toThrow(/total_assessed/)
    expect(() => parseConsortInput({ total_assessed: 10, eligible_total: 8 }, 't')).toThrow(/arms/)
    expect(() => parseConsortInput({ total_assessed: 10, eligible_total: 8, arms: [{ name: 'A', allocated: 8 }] }, 't')).toThrow(/分析人数/)

    const ok = parseConsortInput({
      total_assessed: '10', eligible_total: 8,
      exclusions: [{ reason: '不符合纳入标准', count: 2 }],
      arms: [{ name: 'A', allocated: 8, analyzed: 7, lost_to_followup: 1 }],
    }, '默认标题')
    expect(ok).toMatchObject({ title: '默认标题', total_assessed: 10, eligible_total: 8 })
    expect(ok.arms[0]).toMatchObject({ allocated: 8, analyzed: 7, lost_to_followup: 1 })

    const app = makeApp()
    const resp = await app.request('/api/figures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'flowchart' }),
    })
    expect(resp.status).toBe(400)
    const text = await resp.text()
    expect(text).not.toContain('240')
    expect(text).toContain('total_assessed')
  })

  it('因果推断：未提供结局列时 treatment_effect / e_value 为 null，不返回写死的 OR 0.68', () => {
    const records = Array.from({ length: 40 }, (_, i) => ({
      trt: i % 2,
      age: 40 + (i % 13) * 2 + (i % 2) * 3,
      out: (i * 7) % 5 === 0 ? 1 : 0,
    }))
    const noOutcome = analyzeDatasetCausalBalance(records, { treatment_col: 'trt', covariates: ['age'] })
    expect(noOutcome.treatment_effect).toBeNull()
    expect(noOutcome.e_value).toBeNull()
    expect(noOutcome.effect_note).toMatch(/未提供结局列/)
    expect(noOutcome.covariates).toHaveLength(1)

    const withOutcome = analyzeDatasetCausalBalance(records, { treatment_col: 'trt', covariates: ['age'], outcome_col: 'out' })
    expect(withOutcome.treatment_effect).not.toBeNull()
    expect(withOutcome.treatment_effect!.estimate).toBeGreaterThan(0)
    expect(withOutcome.treatment_effect!.estimate).not.toBe(0.68)
  })

  it('ROC：只有一类结局时报错，不返回 AUC 0.5 占位', () => {
    expect(() => calculateRocCurve([1, 1, 1], [0.2, 0.5, 0.9])).toThrow(/阳性与阴性/)
  })

  it('DCA：净获益区间只来自真实曲线（模型从不占优时为 null，不兜底 10–70%）', () => {
    // 预测变量与结局无关的小样本：区间要么为 null，要么是真实计算出的上下界
    const recs = Array.from({ length: 30 }, (_, i) => ({ y: i % 3 === 0 ? 1 : 0, a: (i * 37) % 11, b: (i * 53) % 7 }))
    const res = fitRocDcaFromRecords(recs, { outcome_col: 'y', baseline_covariates: ['a'], full_covariates: ['b'] })
    if (res.benefit_window_pct !== null) {
      expect(res.benefit_window_pct[0]).toBeLessThanOrEqual(res.benefit_window_pct[1])
      expect(res.benefit_window_pct).not.toEqual([10, 70])
    }
  })

  it('Cox：事件不足时返回 null，不返回 HR 1.00 (1.00–1.00) 占位', () => {
    const recs = [
      { time: 5, event: 1, x: 1 }, { time: 8, event: 0, x: 0 }, { time: 9, event: 0, x: 1 }, { time: 12, event: 0, x: 0 },
    ]
    expect(calculateCoxRegression(recs, ['x'])).toBeNull()
  })

  it('KM：超出最长随访时间的里程碑不外推（不输出 60 个月生存率）', () => {
    const recs = [3, 6, 9, 12, 15, 18, 21, 24].map((t, i) => ({ time: t, event: i % 3 === 0 ? 1 : 0 }))
    const km = calculateSingleGroupKm(recs, 'all', '全部', [12, 24, 36, 60])
    expect(Object.keys(km.milestone_survival).map(Number).sort((a, b) => a - b)).toEqual([12, 24])
  })

  it('Table 1：无法检验的变量 P 为 null（显示「—」），且不把该方法写进脚注', () => {
    const records = [
      { g: 'A', x: 5, c: '男' }, { g: 'A', x: 5, c: '男' }, { g: 'A', x: 5, c: '男' },
      { g: 'B', x: 5, c: '男' }, { g: 'B', x: 5, c: '男' }, { g: 'B', x: 5, c: '男' },
    ]
    const t = generateTable1FromData(records, { group_col: 'g', continuous_vars: ['x'], categorical_vars: ['c'] })
    const xRow = t.rows.find(r => r.variable === 'x')!
    const cRow = t.rows.find(r => r.variable === 'c')!
    expect(xRow.p_value ?? null).toBeNull()
    expect(cRow.p_value ?? null).toBeNull()
    expect(t.markdown).not.toContain('> 0.999')
    expect(t.footnotes.join(' ')).not.toMatch(/Welch|Chi-square|Fisher/)
  })

  it('Logistic：Y/N 编码的结局能正确解析；样本不足时报错而不是输出 OR 1.00', () => {
    const recs = Array.from({ length: 40 }, (_, i) => ({ out: i % 4 === 0 ? 'Y' : 'N', x: i % 4 === 0 ? 1 + (i % 3) : (i % 5) }))
    const res = generateLogisticRegression(recs, { outcome_col: 'out', covariates: ['x'] })
    expect(res.sample_size).toBe(40)
    expect(res.events_count).toBe(10)

    expect(() => generateLogisticRegression(recs.slice(0, 2), { outcome_col: 'out', covariates: ['x'] })).toThrow(/不足以拟合/)
    expect(() => generateLogisticRegression(recs.map(r => ({ ...r, out: 'N' })), { outcome_col: 'out', covariates: ['x'] })).toThrow(/不足以拟合/)
  })

  it('纳排方案：识别不到条款时返回空规则，不套用无关专科模板', () => {
    const rules = parseProtocolTextToRules('本研究旨在探索新的治疗方案，具体内容另行讨论。', 'rct')
    expect(rules.inclusion_rules).toHaveLength(0)
    expect(rules.exclusion_rules).toHaveLength(0)
  })

  it('示例数据：只给带水印的预览，不导出原文件，标题不出现研究名；MCP 入口判定为示例时会拒绝', async () => {
    expect(detectDemoInput('bioinformatics', { bioType: 'volcano' })).toMatch(/内置示例基因/)
    expect(detectDemoInput('bioinformatics', { bioType: 'volcano', volcano_genes: [{ gene: 'A', log2FC: 1, pValue: 0.01 }] })).toBeNull()
    expect(detectDemoInput('image_processing', { tool: 'flowjo' })).toMatch(/合成事件/)
    expect(detectDemoInput('journal_assembly', {})).toMatch(/占位图/)
    expect(detectDemoInput('mechanism', {})).toBeNull()

    const app = makeApp()
    const post = (body: Record<string, unknown>, q = '') => app.request(`/api/figures${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const preview = (await (await post({ category: 'bioinformatics', bioType: 'volcano', title: '某研究 · 火山图' })).json()) as any
    expect(preview.is_demo_data).toBe(true)
    expect(isDemoSvg(preview.svg)).toBe(true)
    expect(preview.svg).not.toContain('某研究')
    expect(preview.r_script).toBeUndefined()
    expect(preview.prism_pzfx).toBeUndefined()

    for (const fmt of ['png', 'r', 'csv', 'pzfx']) {
      expect((await post({ category: 'bioinformatics', bioType: 'volcano' }, `?format=${fmt}`)).status).toBe(400)
    }
    // ImageJ 宏是纯处理模板（不含数据），没有定量数据时仍可导出
    expect((await post({ category: 'image_processing', tool: 'imagej' }, '?format=ijm')).status).toBe(200)
  })

  it('归档：拒绝示例图；溯源只记录声明的数据集，不再挂上研究名与研究下全部数据集', async () => {
    const store = new Store(':memory:')
    const app = makeApp(store)
    const archive = (body: Record<string, unknown>) => app.request('/api/figures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'archive', ...body }),
    })
    const plain = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    expect((await archive({ svg: markDemoSvg(plain), name: 'demo' })).status).toBe(400)

    const ok = await archive({ svg: plain, name: 'real', dataset_id: 'not-a-real-dataset' })
    expect(ok.status).toBe(201)
    const { asset_id } = (await ok.json()) as any
    expect(store.getAssetProvenance(asset_id)!.datasets).toEqual([])
  })

  it('按日期计算随访：缺删失日期与随访截止日时报错，不再假定所有人随访到队列最晚日期', () => {
    const recs = [
      { start: '2020-01-01', ev: '2021-01-01', status: 1 },
      { start: '2020-03-01', ev: '', status: 0 },
      { start: '2020-06-01', ev: '2022-06-01', status: 1 },
    ]
    const opts = { start_date_col: 'start', event_date_col: 'ev', event_col: 'status' }
    expect(() => generateSurvivalAnalysis(recs, opts)).toThrow(/随访截止日期/)
    expect(() => generateSurvivalAnalysis(recs, { ...opts, default_censor_date: '不是日期' })).toThrow(/无法识别/)
    const ok = generateSurvivalAnalysis(recs, { ...opts, default_censor_date: '2023-03-01', time_unit: 'Months' })
    expect(ok.groups.reduce((n, g) => n + g.total_n, 0)).toBe(3)
  })

  it('Cox：多水平非数值分类变量直接报错，不按字母序编为 0/1/2 当连续变量', () => {
    const recs = Array.from({ length: 30 }, (_, i) => ({ time: 5 + i, event: i % 3 === 0 ? 1 : 0, stage: ['I', 'II', 'III'][i % 3] }))
    expect(() => calculateCoxRegression(recs, ['stage'])).toThrow(/哑变量/)
  })
})
