import { describe, expect, it } from 'vitest'
import {
  calculateCategoricalSmd,
  calculateContinuousSmd,
  chiSquareOrFisher,
  chiSquareUpperPValue,
  erf,
  erfc,
  fisherExactTest2x2,
  fTestUpperPValue,
  generateTable1FromData,
  kruskalWallisTest,
  logGamma,
  mannWhitneyUTest,
  normalCdf,
  oneWayAnova,
  regularizedIncompleteBeta,
  studentTTestPValue,
  summarizeContinuous,
  welchTTest,
} from '../src/datasets/table1.ts'
import { Store } from '../src/store/db.ts'
import { DatasetService, parseCsv } from '../src/datasets/service.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ids, setup } from './helpers.ts'
import { buildApi } from '../src/http/api.ts'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard } from '../src/auth/bot-guard.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { TurnService } from '../src/turns/service.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'

describe('Table 1: 数值特殊函数与概率分布检验', () => {
  it('logGamma 与 Gamma 函数精度', () => {
    expect(logGamma(1)).toBeCloseTo(0, 10)
    expect(logGamma(2)).toBeCloseTo(0, 10)
    // Gamma(5) = 24 => ln(24) = 3.1780538303
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 8)
    // Gamma(0.5) = sqrt(pi) => ln(sqrt(pi))
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 8)
  })

  it('erf 与标准正态累积分布 normalCdf', () => {
    expect(erf(0)).toBeCloseTo(0, 8)
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    // Z = 1.95996 => P ≈ 0.975 (双尾 5% 临界点)
    expect(normalCdf(1.95996)).toBeCloseTo(0.975, 4)
    expect(normalCdf(-1.95996)).toBeCloseTo(0.025, 4)
    expect(erfc(0)).toBeCloseTo(1, 8)
  })

  it('学生氏 t 分布 P 值 studentTTestPValue', () => {
    expect(studentTTestPValue(0, 10)).toBe(1)
    // t = 2.2281, df = 10 双尾 P 约等于 0.05
    expect(studentTTestPValue(2.2281, 10)).toBeCloseTo(0.05, 3)
    // 大 t 值显著
    expect(studentTTestPValue(10, 20)).toBeLessThan(0.0001)
  })

  it('卡方分布 P 值 chiSquareUpperPValue', () => {
    expect(chiSquareUpperPValue(0, 1)).toBe(1)
    // chi2 = 3.841, df = 1 => P 约等于 0.05
    expect(chiSquareUpperPValue(3.841, 1)).toBeCloseTo(0.05, 3)
    // chi2 = 5.991, df = 2 => P 约等于 0.05
    expect(chiSquareUpperPValue(5.991, 2)).toBeCloseTo(0.05, 3)
  })

  it('ANOVA F 分布 P 值 fTestUpperPValue', () => {
    expect(fTestUpperPValue(0, 2, 10)).toBe(1)
    // F = 4.10, df1 = 2, df2 = 10 => P 约等于 0.05
    expect(fTestUpperPValue(4.10, 2, 10)).toBeCloseTo(0.05, 2)
  })

  it('Fisher 精确检验 2x2 列联表', () => {
    // 经典 2x2 表：
    // [[12, 5], [3, 14]]
    const res = fisherExactTest2x2(12, 5, 3, 14)
    expect(res.p).toBeLessThan(0.01)
    expect(res.p).toBeGreaterThan(0.001)

    // 对称表
    const sym = fisherExactTest2x2(10, 10, 10, 10)
    expect(sym.p).toBeCloseTo(1.0, 4)
  })
})

describe('Table 1: 连续变量与分类变量统计检验', () => {
  it('连续变量描述性统计量与分位数计算', () => {
    const data = [10, 20, 30, 40, 50, 60, 70, 80, 90]
    const s = summarizeContinuous(data)
    expect(s.n).toBe(9)
    expect(s.mean).toBe(50)
    expect(s.median).toBe(50)
    expect(s.min).toBe(10)
    expect(s.max).toBe(90)
    expect(s.q1).toBe(30)
    expect(s.q3).toBe(70)
    expect(s.iqr).toBe(40)
    expect(s.is_normal).toBe(true)
  })

  it('偏态数据正确识别为非正态', () => {
    // 强烈右偏数据
    const skewed = [1, 1, 1, 2, 2, 3, 3, 5, 8, 15, 45, 120]
    const s = summarizeContinuous(skewed)
    expect(s.skewness).toBeGreaterThan(1.5)
    expect(s.is_normal).toBe(false)
  })

  it('两组连续变量比较：Welch t 检验与 SMD', () => {
    const groupA = [100, 102, 105, 98, 101, 104, 99, 103]
    const groupB = [115, 118, 114, 116, 120, 117, 119, 121]
    const tRes = welchTTest(groupA, groupB)
    expect(tRes.p).toBeLessThan(0.001)
    expect(tRes.t).toBeLessThan(0)

    const smd = calculateContinuousSmd(groupA, groupB)
    expect(smd).not.toBeNull()
    expect(smd!).toBeGreaterThan(2.0) // 显著差异，大效应量
  })

  it('两组非正态连续变量：Mann-Whitney U 检验', () => {
    const g1 = [1, 2, 3, 4, 5, 6, 7]
    const g2 = [8, 9, 10, 11, 12, 13, 14]
    const uRes = mannWhitneyUTest(g1, g2)
    expect(uRes.u).toBe(0)
    expect(uRes.p).toBeLessThan(0.01)
  })

  it('多组连续变量比较：One-way ANOVA 与 Kruskal-Wallis', () => {
    const g1 = [10, 12, 11, 13, 10]
    const g2 = [20, 22, 21, 23, 20]
    const g3 = [30, 32, 31, 33, 30]
    const anova = oneWayAnova([g1, g2, g3])
    expect(anova.p).toBeLessThan(0.001)
    expect(anova.df1).toBe(2)
    expect(anova.df2).toBe(12)

    const kw = kruskalWallisTest([g1, g2, g3])
    expect(kw.p).toBeLessThan(0.01)
    expect(kw.df).toBe(2)
  })

  it('分类变量列联表：卡方检验与 Fisher 精确检验自动分流', () => {
    // 大样本 2x2 列联表 => 卡方检验
    const bigMatrix = [
      [50, 20],
      [40, 80],
    ]
    const chiRes = chiSquareOrFisher(bigMatrix)
    expect(chiRes.method).toBe('Chi-square test')
    expect(chiRes.p).toBeLessThan(0.001)

    // 小期望频数 2x2 列联表 => 自动适配 Fisher 精确检验
    const smallMatrix = [
      [2, 8],
      [9, 1],
    ]
    const fisherRes = chiSquareOrFisher(smallMatrix)
    expect(fisherRes.method).toBe('Fisher’s exact test')
    expect(fisherRes.p).toBeLessThan(0.01)

    // 二分类 SMD
    const smd = calculateCategoricalSmd([50, 40], [20, 80])
    expect(smd).not.toBeNull()
    expect(smd!).toBeGreaterThan(0.5)
  })
})

describe('Table 1: 临床队列端到端三线表生成', () => {
  const clinicalCohort = [
    { id: 'P01', arm: 'Treatment', age: 65, sex: 'Male', hba1c: 6.5, crp: 2.1, hypertension: 'Yes' },
    { id: 'P02', arm: 'Treatment', age: 58, sex: 'Female', hba1c: 6.8, crp: 1.8, hypertension: 'No' },
    { id: 'P03', arm: 'Treatment', age: 72, sex: 'Male', hba1c: 7.1, crp: 3.4, hypertension: 'Yes' },
    { id: 'P04', arm: 'Treatment', age: 61, sex: 'Female', hba1c: 6.2, crp: 1.5, hypertension: 'No' },
    { id: 'P05', arm: 'Treatment', age: 66, sex: 'Male', hba1c: 6.9, crp: 2.8, hypertension: 'Yes' },
    { id: 'P06', arm: 'Treatment', age: 54, sex: 'Female', hba1c: 6.0, crp: 1.2, hypertension: 'No' },
    { id: 'P07', arm: 'Treatment', age: 69, sex: 'Male', hba1c: 7.4, crp: 4.0, hypertension: 'Yes' },
    { id: 'P08', arm: 'Treatment', age: 63, sex: 'Female', hba1c: 6.6, crp: 2.0, hypertension: 'Yes' },
    { id: 'P09', arm: 'Treatment', age: 70, sex: 'Male', hba1c: 7.0, crp: 3.1, hypertension: 'Yes' },
    { id: 'P10', arm: 'Treatment', age: 59, sex: 'Female', hba1c: 6.3, crp: 1.9, hypertension: 'No' },

    { id: 'P11', arm: 'Control', age: 64, sex: 'Male', hba1c: 7.5, crp: 4.8, hypertension: 'Yes' },
    { id: 'P12', arm: 'Control', age: 60, sex: 'Female', hba1c: 7.8, crp: 5.2, hypertension: 'Yes' },
    { id: 'P13', arm: 'Control', age: 71, sex: 'Male', hba1c: 8.2, crp: 6.9, hypertension: 'Yes' },
    { id: 'P14', arm: 'Control', age: 59, sex: 'Female', hba1c: 7.2, crp: 3.9, hypertension: 'No' },
    { id: 'P15', arm: 'Control', age: 67, sex: 'Male', hba1c: 8.0, crp: 5.5, hypertension: 'Yes' },
    { id: 'P16', arm: 'Control', age: 55, sex: 'Female', hba1c: 7.1, crp: 4.1, hypertension: 'No' },
    { id: 'P17', arm: 'Control', age: 68, sex: 'Male', hba1c: 8.5, crp: 7.2, hypertension: 'Yes' },
    { id: 'P18', arm: 'Control', age: 62, sex: 'Female', hba1c: 7.6, crp: 4.6, hypertension: 'Yes' },
    { id: 'P19', arm: 'Control', age: 73, sex: 'Male', hba1c: 8.1, crp: 6.0, hypertension: 'Yes' },
    { id: 'P20', arm: 'Control', age: 61, sex: 'Female', hba1c: 7.4, crp: 4.5, hypertension: 'No' },
  ]

  it('生成完整 Table 1：包含正态/非正态连续变量、分类变量、P 值、SMD 与三线表 Markdown', () => {
    const table = generateTable1FromData(clinicalCohort, {
      group_col: 'arm',
      columns: ['age', 'sex', 'hba1c', 'crp', 'hypertension'],
      non_normal_vars: ['crp'], // 将 CRP 显式指定为中位数呈现
      labels: {
        age: 'Age, years',
        sex: 'Sex',
        hba1c: 'HbA1c, %',
        crp: 'C-reactive protein, mg/L',
        hypertension: 'Hypertension',
        Treatment: 'Intervention Arm',
        Control: 'Standard of Care',
      },
      title: 'Table 1. Baseline Clinical Characteristics of Cohort',
    })

    expect(table.title).toBe('Table 1. Baseline Clinical Characteristics of Cohort')
    expect(table.total_n).toBe(20)
    expect(table.groups).toHaveLength(2)
    expect(table.groups[0]!.name).toBe('Control')
    expect(table.groups[0]!.count).toBe(10)
    expect(table.groups[1]!.name).toBe('Treatment')
    expect(table.groups[1]!.count).toBe(10)

    // 表头检查
    expect(table.headers).toEqual([
      'Characteristic',
      'Overall (N=20)',
      'Standard of Care (N=10)',
      'Intervention Arm (N=10)',
      'P value',
      'SMD',
    ])

    // 行内容检查
    const ageRow = table.rows.find(r => r.variable === 'age')
    expect(ageRow).toBeDefined()
    expect(ageRow!.type).toBe('continuous')
    expect(ageRow!.label).toContain('mean ± SD')
    expect(ageRow!.test_method).toBe("Welch's t-test")
    expect(ageRow!.smd).toBeDefined()

    const crpRow = table.rows.find(r => r.variable === 'crp')
    expect(crpRow).toBeDefined()
    expect(crpRow!.label).toContain('median [IQR]')
    expect(crpRow!.test_method).toBe('Mann-Whitney U test')
    expect(crpRow!.p_value).toBeLessThan(0.001) // 治疗组 vs 对照组 CRP 差异显著

    const sexRow = table.rows.find(r => r.variable === 'sex' && !r.is_category_level)
    expect(sexRow).toBeDefined()
    expect(sexRow!.type).toBe('categorical')
    expect(sexRow!.test_method).toBeDefined()

    const sexMale = table.rows.find(r => r.variable === 'sex' && r.level === 'Male')
    expect(sexMale).toBeDefined()
    expect(sexMale!.overall).toBe('10 (50.0%)')
    expect(sexMale!.groups['Treatment']).toBe('5 (50.0%)')
    expect(sexMale!.groups['Control']).toBe('5 (50.0%)')

    // Markdown 检查：是否符合标准 GFM 三线表
    expect(table.markdown).toContain('### Table 1. Baseline Clinical Characteristics of Cohort')
    expect(table.markdown).toContain('| Characteristic | Overall (N=20) | Standard of Care (N=10) | Intervention Arm (N=10) | P value | SMD |')
    expect(table.markdown).toContain('| :--- | :---: | :---: | :---: | :---: | :---: |')
    expect(table.markdown).toContain('**Age, years, mean ± SD**')
    expect(table.markdown).toContain('**C-reactive protein, mg/L, median [IQR]**')
    expect(table.markdown).toContain('*Note*: Values are presented as mean ± SD, median [IQR], or n (%).')
    expect(table.markdown).toContain("Welch's t-test")
    expect(table.markdown).toContain('Mann-Whitney U test')
  })

  it('单人群模式（无 group_col 时生成 Overall 表）', () => {
    const table = generateTable1FromData(clinicalCohort, {
      columns: ['age', 'sex', 'hba1c'],
      title: 'Table 1. Overall Population Characteristics',
    })

    expect(table.total_n).toBe(20)
    expect(table.headers).toEqual(['Characteristic', 'Overall (N=20)'])
    expect(table.rows.some(r => r.variable === 'age')).toBe(true)
    expect(table.markdown).not.toContain('P value')
    expect(table.markdown).not.toContain('SMD')
  })

  it('存在缺失值时正确呈现 Missing 统计行', () => {
    const cohortWithMissing = [
      ...clinicalCohort,
      { id: 'P21', arm: 'Treatment', age: null, sex: 'Male', hba1c: 6.9, crp: null, hypertension: 'Yes' },
      { id: 'P22', arm: 'Control', age: 66, sex: null, hba1c: 7.5, crp: 4.0, hypertension: null },
    ]

    const table = generateTable1FromData(cohortWithMissing, {
      group_col: 'arm',
      columns: ['age', 'sex', 'crp'],
      show_missing: true,
    })

    const ageMissing = table.rows.find(r => r.variable === 'age' && r.label === 'Missing')
    expect(ageMissing).toBeDefined()
    expect(ageMissing!.overall).toContain('1 (4.5%)')

    const sexMissing = table.rows.find(r => r.variable === 'sex' && r.label === 'Missing')
    expect(sexMissing).toBeDefined()
    expect(sexMissing!.overall).toContain('1 (4.5%)')
  })

  it('分类值或分组名包含 __proto__ / constructor 时不污染原型链且统计正常', () => {
    const specialRows = [
      { arm: '__proto__', cat: 'constructor', age: 50 },
      { arm: '__proto__', cat: 'toString', age: 54 },
      { arm: 'constructor', cat: '__proto__', age: 60 },
      { arm: 'constructor', cat: 'valueOf', age: 64 },
    ]
    const table = generateTable1FromData(specialRows, {
      group_col: 'arm',
      columns: ['age', 'cat'],
      categorical_vars: ['cat'],
      continuous_vars: ['age'],
    })
    expect(table.groups.map(g => g.count)).toEqual([2, 2])
    expect(({} as any).count).toBeUndefined()
  })
})

describe('Table 1: 与 DatasetService 集成', () => {
  it('从已就绪的数据集直接生成 Table 1', () => {
    const store = new Store(':memory:')
    const dir = mkdtempSync(join(tmpdir(), 'heurion-table1-'))
    const mockIngest = async () => ({ profile: { ok: true as const, rows: 0, columns: [], truncated: false }, csv: null, cleanup: () => {} })
    const svc = new DatasetService(store, dir, mockIngest)

    // 直接在 store 注册 ready 状态的数据集并写入规范化 CSV
    const row = store.addDataset({
      owner: 'u1',
      name: '心血管队列',
      filename: 'cohort.csv',
      format: 'CSV',
      size: 1024,
      sha256: 'mock-sha',
    })

    const csvContent = [
      'id,arm,age,sex,sbp,outcome',
      '1,Drug,62,Male,130,Alive',
      '2,Drug,55,Female,125,Alive',
      '3,Drug,70,Male,140,Dead',
      '4,Drug,66,Female,135,Alive',
      '5,Control,61,Male,145,Alive',
      '6,Control,59,Female,150,Dead',
      '7,Control,68,Male,155,Dead',
      '8,Control,72,Female,160,Dead',
    ].join('\n')

    const dataPath = svc.csvPath(row)
    mkdirSync(join(dir, 'u1', row.id), { recursive: true })
    writeFileSync(dataPath, csvContent, 'utf8')

    store.updateDataset(row.id, {
      status: 'ready',
      rows: 8,
      cols: 6,
      profile: JSON.stringify({
        ok: true,
        rows: 8,
        columns: [
          { name: 'id', type: 'text', missing: 0, unique: 8 },
          { name: 'arm', type: 'categorical', missing: 0, unique: 2 },
          { name: 'age', type: 'numeric', missing: 0, unique: 8 },
          { name: 'sex', type: 'categorical', missing: 0, unique: 2 },
          { name: 'sbp', type: 'numeric', missing: 0, unique: 8 },
          { name: 'outcome', type: 'categorical', missing: 0, unique: 2 },
        ],
        truncated: false,
      }),
      labels: JSON.stringify({
        age: '年龄 (岁)',
        sbp: '收缩压 (mmHg)',
        outcome: '30天转归',
        Drug: '新药组',
        Control: '对照组',
      }),
    })

    const result = svc.table1('u1', row.id, {
      group_col: 'arm',
      columns: ['age', 'sex', 'sbp', 'outcome'],
      title: '表 1. 两组患者基线特征与转归比较',
    })

    expect(result.title).toBe('表 1. 两组患者基线特征与转归比较')
    expect(result.total_n).toBe(8)
    expect(result.groups.map(g => g.name)).toEqual(['Control', 'Drug'])
    expect(result.headers).toEqual(['Characteristic', 'Overall (N=8)', '对照组 (N=4)', '新药组 (N=4)', 'P value', 'SMD'])
    expect(result.rows.find(r => r.variable === 'age')?.label).toContain('年龄 (岁)')
    expect(result.markdown).toContain('新药组')
    expect(result.markdown).toContain('对照组')
    expect(result.markdown).toContain('收缩压 (mmHg)')
    expect(result.rows.find(r => r.variable === 'sbp')?.test_method).toBe("Welch's t-test")
  })

  it('Table 1 Markdown 生成的内容可直接作为三线表插入文档且保持合法 AST', () => {
    const env = setup('这是临床试验结果报告前言。')
    const anchorId = ids(env.docs, env.docId)[0]!
    const dir = mkdtempSync(join(tmpdir(), 'heurion-table1-mcp-'))
    const mockIngest = async () => ({ profile: { ok: true as const, rows: 0, columns: [], truncated: false }, csv: null, cleanup: () => {} })
    const svc = new DatasetService(env.store, dir, mockIngest)

    const row = env.store.addDataset({
      owner: 'u1',
      name: '队列',
      filename: 'cohort.csv',
      format: 'CSV',
      size: 100,
      sha256: 'mock-sha-2',
    })
    const dataPath = svc.csvPath(row)
    mkdirSync(join(dir, 'u1', row.id), { recursive: true })
    writeFileSync(dataPath, 'arm,age,status\nDrug,60,Alive\nDrug,65,Alive\nControl,58,Dead\nControl,62,Dead\n', 'utf8')
    env.store.updateDataset(row.id, {
      status: 'ready',
      rows: 4,
      cols: 3,
      profile: JSON.stringify({
        ok: true,
        rows: 4,
        columns: [
          { name: 'arm', type: 'categorical', missing: 0, unique: 2 },
          { name: 'age', type: 'numeric', missing: 0, unique: 4 },
          { name: 'status', type: 'categorical', missing: 0, unique: 2 },
        ],
        truncated: false,
      }),
    })

    const tableRes = svc.table1('u1', row.id, { group_col: 'arm' })
    expect(tableRes.markdown).toContain('Table 1')

    // 应用到文档
    const edit = env.ops.edit({
      doc_id: env.docId,
      base_rev: 0,
      mode: 'apply',
      ops: [{ op: 'insert_after', anchor_id: anchorId, markdown: tableRes.markdown }],
    }, { actor: 'ai', turnId: null })
    expect(edit.rev).toBe(1)


    // 检查文档结构中已成功挂载 table 节点
    const docNode = env.docs.get(env.docId)
    const blockTypes: string[] = []
    docNode.forEach(n => blockTypes.push(n.type.name))
    expect(blockTypes).toContain('table')
  })

  it('HTTP API POST /api/datasets/:did/table1 成功返回结构化与 Markdown 结果', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const ops = new OpService(docs)
    const accounts = new Accounts(store, {
      secret: 'test-secret',
      devMode: true,
      devToken: 'dev',
      devUser: 'u1',
      botGuard: new BotGuard({ secret: 'test-secret', baseMax: 300, minDelayMs: 0 }),
    })
    const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {}, workspaceDir: () => mkdtempSync(join(tmpdir(), 't1-ws-')) } as any
    const turns = new TurnService(docs, pool, new TurnRegistry(), { memory: undefined })
    const dir = mkdtempSync(join(tmpdir(), 't1-ds-'))
    const mockIngest = async () => ({ profile: { ok: true as const, rows: 0, columns: [], truncated: false }, csv: null, cleanup: () => {} })
    const svc = new DatasetService(store, dir, mockIngest)

    const row = store.addDataset({
      owner: 'u1',
      name: 'HTTP队列',
      filename: 'http_cohort.csv',
      format: 'CSV',
      size: 100,
      sha256: 'mock-sha-http',
    })
    const dataPath = svc.csvPath(row)
    mkdirSync(join(dir, 'u1', row.id), { recursive: true })
    writeFileSync(dataPath, 'group,age,gender\nT,50,M\nT,52,F\nC,48,M\nC,49,F\n', 'utf8')
    store.updateDataset(row.id, {
      status: 'ready',
      rows: 4,
      cols: 3,
      profile: JSON.stringify({
        ok: true,
        rows: 4,
        columns: [
          { name: 'group', type: 'categorical', missing: 0, unique: 2 },
          { name: 'age', type: 'numeric', missing: 0, unique: 4 },
          { name: 'gender', type: 'categorical', missing: 0, unique: 2 },
        ],
        truncated: false,
      }),
    })

    const app = buildApi({
      docs,
      ops,
      turns,
      postcheck: new PostCheck(docs),
      crossref: {} as CrossrefClient,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 't1-render-'))),
      accounts,
      devMode: true,
      devUser: 'u1',
      datasets: svc,
    })

    const res = await app.request(`/api/datasets/${row.id}/table1`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer dev',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        group_col: 'group',
        title: 'Table 1. Cohort Baseline',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.title).toBe('Table 1. Cohort Baseline')
    expect(body.total_n).toBe(4)
    expect(body.markdown).toContain('Table 1. Cohort Baseline')
    expect(body.markdown).toContain('P value')
    expect(body.markdown).toContain('SMD')
    expect(body.rows.some((r: any) => r.variable === 'age')).toBe(true)
  })
})


