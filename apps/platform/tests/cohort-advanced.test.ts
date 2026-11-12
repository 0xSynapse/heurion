import { describe, expect, it } from 'vitest'
import { matchCriteria, parseCriteria, type PatientRow, type LabRow } from '../src/tenancy/patients.ts'

describe('科研队列高级筛选与相对时间轴（Track B）', () => {
  const p1: PatientRow = {
    id: 'p1',
    code: 'P001',
    sex: 'M',
    birth_year: 1980,
    name: null,
    status: 'active',
    tags: ['糖尿病', '1型糖尿病'],
    created_by: 'u1',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  }

  const p2: PatientRow = {
    id: 'p2',
    code: 'P002',
    sex: 'F',
    birth_year: 1985,
    name: null,
    status: 'active',
    tags: ['糖尿病', '2型糖尿病', '高血压'],
    created_by: 'u1',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  }

  const labsP2 = [
    {
      id: 'l1',
      patient_id: 'p2',
      record_id: 'r1',
      test_name: '丙氨酸氨基转移酶',
      test_key: 'alt',
      value_num: 80,
      value_text: null,
      unit: 'U/L',
      std_value: 80,
      std_unit: 'U/L',
      std_ref_low: 9,
      std_ref_high: 50,
      ref_low: 9,
      ref_high: 50,
      ref_text: '9-50',
      flag: 'H' as const,
      collected_on: '2024-01-10',
      collected_at: null,
      replaces: null,
      locator: null,
      source: 'extracted' as const,
      status: 'confirmed' as const,
      converted: false,
      unknown_unit: false,
      created_by: 'u1',
      created_at: '2024-01-10',
      confirmed_by: 'u1',
      confirmed_at: '2024-01-10',
    },
    {
      id: 'l2',
      patient_id: 'p2',
      record_id: 'r2',
      test_name: '丙氨酸氨基转移酶',
      test_key: 'alt',
      value_num: 40,
      value_text: null,
      unit: 'U/L',
      std_value: 40,
      std_unit: 'U/L',
      std_ref_low: 9,
      std_ref_high: 50,
      ref_low: 9,
      ref_high: 50,
      ref_text: '9-50',
      flag: null,
      collected_on: '2024-02-10',
      collected_at: null,
      replaces: null,
      locator: null,
      source: 'extracted' as const,
      status: 'confirmed' as const,
      converted: false,
      unknown_unit: false,
      created_by: 'u1',
      created_at: '2024-02-10',
      confirmed_by: 'u1',
      confirmed_at: '2024-02-10',
    },
  ] as LabRow[]

  it('tags_exclude: 复合排除逻辑（包含糖尿病且排除1型）', () => {
    const cr = parseCriteria({
      tags_any: ['糖尿病'],
      tags_exclude: ['1型'],
    })

    // p1 包含1型糖尿病，应被排除
    expect(matchCriteria(cr, p1, [], 2024)).toBeNull()

    // p2 包含2型糖尿病，符合条件
    const m2 = matchCriteria(cr, p2, [], 2024)
    expect(m2).toBeTruthy()
    expect(m2).toContain('标签「糖尿病」')
  })

  it('lab_changes: 按化验指标动态演变趋势筛选（ALT 下降幅度 >= 30%）', () => {
    // 基线 80 -> 最近 40，变化百分比为 -50%
    const crDrop = parseCriteria({
      lab_changes: [
        {
          test: 'ALT',
          change_type: 'pct',
          op: '<=',
          value: -30,
        },
      ],
    })

    const m = matchCriteria(crDrop, p2, labsP2, 2024)
    expect(m).toBeTruthy()
    expect(m![0]).toContain('丙氨酸氨基转移酶 变化 -50.0%')

    // 如果要求变化 >= 0（未下降），则应失配
    const crRise = parseCriteria({
      lab_changes: [
        {
          test: 'ALT',
          change_type: 'diff',
          op: '>=',
          value: 0,
        },
      ],
    })
    expect(matchCriteria(crRise, p2, labsP2, 2024)).toBeNull()
  })

  it('relative_days: 生成宽表与长表数据集时支持以入组日为 Day 0 的相对时间轴', async () => {
    const { mkdtempSync, copyFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Store } = await import('../src/store/db.ts')
    const { TenantService } = await import('../src/auth/tenants.ts')
    const { TenantKeys, kekFrom } = await import('../src/tenancy/keys.ts')
    const { PatientService } = await import('../src/tenancy/patients.ts')
    const { DatasetService, parseCsv } = await import('../src/datasets/service.ts')
    const { StudyService } = await import('../src/research/service.ts')
    const { CohortService } = await import('../src/research/cohort.ts')

    const store = new Store(':memory:')
    const tenants = new TenantService(store, { devMode: false })
    const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
    const patients = new PatientService(mkdtempSync(join(tmpdir(), 'co-adv-pt-')), tenants, keys, store)
    const ingest = async (_owner: string, src: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'co-adv-ing-'))
      copyFileSync(src, join(dir, 'data.csv'))
      const recs = parseCsv(readFileSync(src, 'utf8')) as string[][]
      const header = recs[0] ?? []
      return {
        csv: join(dir, 'data.csv'), cleanup: () => {},
        profile: { ok: true as const, rows: recs.length - 1, truncated: false, columns: header.map(name => ({ name, type: 'text' as const, missing: 0, unique: 1 })) },
      }
    }
    const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'co-adv-ds-')), ingest)
    const studies = new StudyService(store, datasets)
    const cohort = new CohortService(studies, patients, datasets)

    const hosp = store.createTenant({ name: '测试医院', kind: 'org' })
    const user = store.createUser({ username: 'doc1', display_name: '医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
    const actor = { userId: user, via: 'user' as const }
    const study = studies.create(user, { title: '前瞻队列研究', design: 'prospective_cohort' })

    const pt = patients.create(actor, { sex: 'M', birth_year: 1990, tags: ['研究入组'] })
    const f1 = patients.addFile(actor, pt.id, { name: '基线化验.pdf', mime: 'application/pdf', bytes: Uint8Array.from([1, 2, 3]), report_date: '2024-03-01' })
    patients.addRecordLab(actor, pt.id, f1.record.id, { test_name: '肌酐', value: 90, unit: 'µmol/L' })
    patients.resolveRecord(actor, pt.id, f1.record.id, { accept: true })

    const f2 = patients.addFile(actor, pt.id, { name: '随访化验.pdf', mime: 'application/pdf', bytes: Uint8Array.from([4, 5, 6]), report_date: '2024-03-15' })
    patients.addRecordLab(actor, pt.id, f2.record.id, { test_name: '肌酐', value: 110, unit: 'µmol/L' })
    patients.resolveRecord(actor, pt.id, f2.record.id, { accept: true })

    // 入组患者
    cohort.enroll(actor, study.id, { patient_ids: [pt.id] })

    // 生成带 relative_days 的宽表
    const resWide = await cohort.dataset(actor, study.id, { shape: 'wide', relative_days: true })
    const prevWide = datasets.preview(user, resWide.dataset.id)
    expect(prevWide.header).toContain('creatinine_baseline_day_rel')
    expect(prevWide.header).toContain('creatinine_latest_day_rel')
    expect(resWide.dataset.labels.creatinine_baseline_day_rel).toBe('肌酐 基线相对入组天数')

    // 生成带 relative_days 的长表
    const resLong = await cohort.dataset(actor, study.id, { shape: 'long', relative_days: true })
    const prevLong = datasets.preview(user, resLong.dataset.id)
    expect(prevLong.header).toContain('day_rel')
    expect(resLong.dataset.labels.day_rel).toBe('相对入组天数')
  })

  it('研究方案驱动纳排引擎（Track C）：从研究方案提取纳排规则 + 多模态纳排规则评估 + CONSORT 瀑布流漏斗', async () => {
    const { mkdtempSync, copyFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Store } = await import('../src/store/db.ts')
    const { TenantService } = await import('../src/auth/tenants.ts')
    const { TenantKeys, kekFrom } = await import('../src/tenancy/keys.ts')
    const { PatientService } = await import('../src/tenancy/patients.ts')
    const { DatasetService, parseCsv } = await import('../src/datasets/service.ts')
    const { StudyService } = await import('../src/research/service.ts')
    const { CohortService } = await import('../src/research/cohort.ts')
    const { renderEnrollmentFlowSvg } = await import('../src/research/consort.ts')

    const store = new Store(':memory:')
    const tenants = new TenantService(store, { devMode: false })
    const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
    const patients = new PatientService(mkdtempSync(join(tmpdir(), 'co-elig-pt-')), tenants, keys, store)
    const ingest = async (_owner: string, src: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'co-elig-ing-'))
      copyFileSync(src, join(dir, 'data.csv'))
      const recs = parseCsv(readFileSync(src, 'utf8')) as string[][]
      const header = recs[0] ?? []
      return {
        csv: join(dir, 'data.csv'), cleanup: () => {},
        profile: { ok: true as const, rows: recs.length - 1, truncated: false, columns: header.map(name => ({ name, type: 'text' as const, missing: 0, unique: 1 })) },
      }
    }
    const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'co-elig-ds-')), ingest)
    const studies = new StudyService(store, datasets)
    const cohort = new CohortService(studies, patients, datasets)

    const hosp = store.createTenant({ name: '协和研究中心', kind: 'org' })
    const user = store.createUser({ username: 'pi_doc', display_name: 'PI', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
    const actor = { userId: user, via: 'user' as const }

    const protocolSummary = [
      '研究背景：评估达格列净在 2型糖尿病肾病患者中的肾脏保护作用。',
      '纳入标准：',
      '1. 年龄 18-75 岁',
      '2. 确诊 2型糖尿病',
      '3. eGFR >= 30 mL/min/1.73m2',
      '4. 签署知情同意书',
      '排除标准：',
      '1. 合并 1型糖尿病',
      '2. 病历包含：恶性肿瘤',
      '3. ALT >= 150 U/L',
    ].join('\n')

    const study = studies.create(user, {
      title: 'DKD 前瞻性队列研究',
      design: 'prospective_cohort',
      summary: protocolSummary,
    })

    // 1. 从研究方案简介自动提取结构化纳排规则
    const extracted = studies.extractEligibilityFromProtocol(user, study.id, { save: true })
    expect(extracted.extracted_count).toBeGreaterThanOrEqual(6)
    expect(extracted.eligibility_plan.inclusion_rules.some(r => r.predicate.kind === 'demographics')).toBe(true)
    expect(extracted.eligibility_plan.inclusion_rules.some(r => r.predicate.kind === 'tags')).toBe(true)
    expect(extracted.eligibility_plan.inclusion_rules.some(r => r.predicate.kind === 'lab' && r.predicate.name.toLowerCase() === 'egfr')).toBe(true)
    const manualRule = extracted.eligibility_plan.inclusion_rules.find(r => r.predicate.kind === 'manual')!
    expect(manualRule).toBeDefined()
    expect(extracted.eligibility_plan.exclusion_rules.some(r => r.predicate.kind === 'tags')).toBe(true)
    expect(extracted.eligibility_plan.exclusion_rules.some(r => r.predicate.kind === 'record' || r.predicate.kind === 'tags')).toBe(true)
    expect(extracted.eligibility_plan.exclusion_rules.some(r => r.predicate.kind === 'lab' && r.predicate.name.toLowerCase() === 'alt')).toBe(true)

    const year = new Date().getUTCFullYear()
    // 构造 4 名在管患者验证纳排瀑布流：
    // P1: 完全符合条件（60岁，2型糖尿病，eGFR=55，ALT=28）
    const ptEligible = patients.create(actor, { sex: 'M', birth_year: year - 60, tags: ['2型糖尿病', '慢性肾病'] })
    const f1 = patients.addFile(actor, ptEligible.id, { name: 'lab1.pdf', mime: 'application/pdf', bytes: Uint8Array.from([1]), report_date: '2025-01-10' })
    patients.addRecordLab(actor, ptEligible.id, f1.record.id, { test_name: 'eGFR', value: 55, unit: 'mL/min/1.73m²' })
    patients.addRecordLab(actor, ptEligible.id, f1.record.id, { test_name: 'ALT', value: 28, unit: 'U/L' })
    patients.resolveRecord(actor, ptEligible.id, f1.record.id, { accept: true })

    // P2: 满足纳入标准，但因病历包含「恶性肿瘤」被排除规则拦截
    const ptExcludedTumor = patients.create(actor, { sex: 'F', birth_year: year - 62, tags: ['2型糖尿病'] })
    const f2 = patients.addFile(actor, ptExcludedTumor.id, { name: 'lab2.pdf', mime: 'application/pdf', bytes: Uint8Array.from([2]), report_date: '2025-01-11' })
    patients.addRecordLab(actor, ptExcludedTumor.id, f2.record.id, { test_name: 'eGFR', value: 60, unit: 'mL/min/1.73m²' })
    patients.addRecordLab(actor, ptExcludedTumor.id, f2.record.id, { test_name: 'ALT', value: 30, unit: 'U/L' })
    patients.resolveRecord(actor, ptExcludedTumor.id, f2.record.id, { accept: true })
    const recNote = patients.addFile(actor, ptExcludedTumor.id, { name: 'note.pdf', mime: 'application/pdf', bytes: Uint8Array.from([2, 2]), kind: 'note', report_date: '2025-01-05', title: '患者3年前因肺癌（恶性肿瘤）行胸腔镜手术治疗。' })
    patients.resolveRecord(actor, ptExcludedTumor.id, recNote.record.id, { accept: true })

    // P3: 满足纳入标准，但因 ALT >= 150 被排除规则拦截
    const ptExcludedAlt = patients.create(actor, { sex: 'M', birth_year: year - 55, tags: ['2型糖尿病'] })
    const f3 = patients.addFile(actor, ptExcludedAlt.id, { name: 'lab3.pdf', mime: 'application/pdf', bytes: Uint8Array.from([3]), report_date: '2025-01-12' })
    patients.addRecordLab(actor, ptExcludedAlt.id, f3.record.id, { test_name: 'eGFR', value: 48, unit: 'mL/min/1.73m²' })
    patients.addRecordLab(actor, ptExcludedAlt.id, f3.record.id, { test_name: 'ALT', value: 185, unit: 'U/L' })
    patients.resolveRecord(actor, ptExcludedAlt.id, f3.record.id, { accept: true })

    // P4: 未满足纳入标准（eGFR = 20 < 30）
    const ptFailInclusion = patients.create(actor, { sex: 'F', birth_year: year - 68, tags: ['2型糖尿病'] })
    const f4 = patients.addFile(actor, ptFailInclusion.id, { name: 'lab4.pdf', mime: 'application/pdf', bytes: Uint8Array.from([4]), report_date: '2025-01-13' })
    patients.addRecordLab(actor, ptFailInclusion.id, f4.record.id, { test_name: 'eGFR', value: 20, unit: 'mL/min/1.73m²' })
    patients.resolveRecord(actor, ptFailInclusion.id, f4.record.id, { accept: true })

    // 2. 使用方案已保存的纳排规则执行预览（确认人工复核项）
    const prev = cohort.preview(actor, study.id, {
      use_study_plan: true,
      manual_confirmed_rules: [manualRule.id],
    })
    expect(prev.total).toBe(1)
    expect(prev.patients[0]!.patient_id).toBe(ptEligible.id)
    expect(prev.funnel).toBeDefined()
    expect(prev.funnel!.assessed_total).toBe(4)
    expect(prev.funnel!.inclusion_passed).toBe(3)
    expect(prev.funnel!.excluded_total).toBe(3)
    expect(prev.funnel!.eligible_total).toBe(1)
    expect(prev.funnel!.exclusions_by_rule.some(e => e.kind === 'inclusion_failed' && e.count === 1)).toBe(true)
    expect(prev.funnel!.exclusions_by_rule.some(e => e.title.includes('恶性肿瘤') && e.count === 1)).toBe(true)
    expect(prev.funnel!.exclusions_by_rule.some(e => e.title.includes('ALT') && e.count === 1)).toBe(true)

    // 3. 验证筛选漏斗可渲染到受试者流向图 (CONSORT Participant Flow)
    const svg = renderEnrollmentFlowSvg({
      title: 'DKD Flow',
      enrolled_ever: 1,
      withdrawn: 0,
      inaccessible: 0,
      analyzed: 1,
      arms: [],
      screening_funnel: {
        assessed_total: prev.funnel!.assessed_total,
        excluded_total: prev.funnel!.excluded_total,
        exclusions: prev.funnel!.exclusions_by_rule.map(e => ({ reason: e.title, count: e.count })),
      },
    })
    expect(svg).toContain('Assessed for eligibility')
    expect(svg).toContain('纳排筛选排除 (Excluded): n = 3')
    expect(svg).toContain('恶性肿瘤')
  })

  it('真实数据集驱动的统计建模闭环：Nomogram (IRLS + C-index)、ROC/DCA (含 DeLong 1988 检验) 与倾向性评分 PSM/IPTW + E-value', async () => {
    const { fitNomogramFromRecords, fitRocDcaFromRecords, delongTest } = await import('../src/research/prediction-models.ts')
    const { analyzeDatasetCausalBalance } = await import('../src/research/causal-inference.ts')

    // 构造 30 例真实临床队列记录（暴露组 treatment_arm=1 风险显著降低，高龄与低 SMI 风险升高）
    const records: Array<Record<string, unknown>> = []
    for (let i = 0; i < 30; i++) {
      const treat = i % 2 === 0 ? 1 : 0
      const age = 50 + (i % 15) * 2 + (treat === 0 ? 4 : 0)
      const smi = 48 - (i % 10) * 1.5 - (treat === 0 ? 3 : 0)
      const vatSat = 0.7 + (i % 8) * 0.12
      const riskScore = -0.9 * treat + 0.06 * (age - 60) - 0.08 * (smi - 42) + 0.8 * (vatSat - 1.0)
      const event = riskScore > 0.05 ? 1 : 0
      records.push({
        subject_id: `S${String(i + 1).padStart(3, '0')}`,
        treatment_arm: treat,
        age,
        l3_smi: Number(smi.toFixed(1)),
        vat_to_sat: Number(vatSat.toFixed(2)),
        followup_months: 12 + (i % 24),
        os_status: event,
      })
    }

    const labelsMap = {
      treatment_arm: '治疗方案',
      age: '年龄 (岁)',
      l3_smi: 'L3 骨骼肌指数 SMI',
      vat_to_sat: '内脏/皮下脂肪比',
      os_status: '总生存结局事件',
    }

    // 1. 真实数据集列拟合 Nomogram
    const nomo = fitNomogramFromRecords(records, {
      title: '真实队列 Nomogram',
      outcome_col: 'os_status',
      time_col: 'followup_months',
      covariates: ['treatment_arm', 'age', 'l3_smi', 'vat_to_sat'],
      labels: labelsMap,
    })
    expect(nomo.svg).toContain('<svg')
    expect(nomo.axes.length).toBe(4)
    expect(nomo.c_index!).toBeGreaterThan(0.6)
    // 提供随访时间时用 Harrell C-index；其置信区间尚无正规估计（bootstrap），不输出自拟区间
    expect(nomo.c_index_ci).toBeUndefined()
    expect(nomo.academic_narrative_zh).toContain('C-index')
    // 数据集拟合的是 Logistic 模型，没有基线生存函数：不得输出 1/3/5 年绝对生存概率
    expect(nomo.absolute_survival).toBe(false)
    expect(nomo.survival_scale.year1).toHaveLength(0)
    expect(nomo.survival_scale.year5).toHaveLength(0)
    // 叙述与 R 脚本须与实际拟合的 Logistic 模型一致
    expect(nomo.academic_narrative_zh).toContain('基于本研究数据集拟合的多因素 Logistic 回归模型')
    expect(nomo.native_exports?.r_script).toContain('lrm(outcome ~ treatment_arm + age + l3_smi + vat_to_sat')
    expect(nomo.native_exports?.r_script).toContain('fun = plogis')
    expect(nomo.native_exports?.r_script).not.toContain('cph(')
    expect(nomo.native_exports?.r_script).not.toContain('Survival(f)')

    // 不提供随访时间时 C-index 即 ROC AUC，可带 AUC 的置信区间
    const nomoNoTime = fitNomogramFromRecords(records, {
      outcome_col: 'os_status',
      covariates: ['treatment_arm', 'age', 'l3_smi', 'vat_to_sat'],
      labels: labelsMap,
    })
    expect(nomoNoTime.c_index_ci![0]).toBeLessThanOrEqual(nomoNoTime.c_index!)
    expect(nomoNoTime.c_index_ci![1]).toBeGreaterThanOrEqual(nomoNoTime.c_index!)

    // 结局只有一类时报错，不返回 C-index = 0.5 占位
    expect(() => fitNomogramFromRecords(records.map(r => ({ ...r, os_status: 1 })), {
      outcome_col: 'os_status',
      covariates: ['age'],
    })).toThrow(/阳性与阴性/)

    // 2. 真实数据集列拟合基线 vs 多模态 ROC & DCA + DeLong 检验
    const rocDca = fitRocDcaFromRecords(records, {
      outcome_col: 'os_status',
      baseline_cols: ['age', 'treatment_arm'],
      full_cols: ['age', 'treatment_arm', 'l3_smi', 'vat_to_sat'],
      labels: labelsMap,
    })
    expect(rocDca.roc.models.length).toBe(2)
    expect(rocDca.roc.svg).toContain('<svg')
    expect(rocDca.dca.svg).toContain('<svg')
    expect(rocDca.delong).toBeDefined()
    expect(typeof rocDca.delong.z_stat).toBe('number')
    expect(typeof rocDca.delong.p_value).toBe('number')
    // 净获益占优区间由实际 DCA 曲线得出；模型 2 从不占优时为 null（不再兜底为 10–70%）
    if (rocDca.benefit_window_pct) {
      expect(rocDca.benefit_window_pct[1]).toBeGreaterThanOrEqual(rocDca.benefit_window_pct[0])
    } else {
      expect(rocDca.benefit_window_pct).toBeNull()
    }

    // 验证 DeLong 检验在明显差异模型上的显著性
    const dl = delongTest(
      [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
      [0.55, 0.48, 0.52, 0.60, 0.45, 0.51, 0.49, 0.53, 0.44, 0.50, 0.47, 0.52],
      [0.92, 0.88, 0.95, 0.85, 0.90, 0.89, 0.12, 0.18, 0.08, 0.15, 0.11, 0.14],
    )
    expect(dl.delta_auc).toBeGreaterThan(0.3)
    expect(dl.p_value).toBeLessThan(0.05)

    // 3. 真实数据集列拟合倾向性评分 (IPTW & PSM) + Love Plot + E-value
    const causalIptw = analyzeDatasetCausalBalance(records, {
      treatment_col: 'treatment_arm',
      outcome_col: 'os_status',
      covariates: ['age', 'l3_smi', 'vat_to_sat'],
      method: 'iptw',
      labels: labelsMap,
    })
    expect(causalIptw.covariates.length).toBe(3)
    expect(causalIptw.love_plot.svg).toContain('<svg')
    expect(causalIptw.e_value).not.toBeNull()
    expect(causalIptw.e_value!.e_value_point).toBeGreaterThanOrEqual(1)

    const causalPsm = analyzeDatasetCausalBalance(records, {
      treatment_col: 'treatment_arm',
      outcome_col: 'os_status',
      covariates: ['age', 'l3_smi', 'vat_to_sat'],
      method: 'psm',
      labels: labelsMap,
    })
    expect(causalPsm.method).toBe('psm')
    expect(causalPsm.matched_pairs).toBeGreaterThan(0)
    expect(causalPsm.requested_method).toBe('psm')
    expect(causalPsm.method_note).toBeUndefined()

    // 两组倾向性评分完全分离：卡钳内匹配不到 2 对，实际退回 IPTW，返回值必须如实标明
    const separated = Array.from({ length: 20 }, (_, i) => ({ trt: i < 10 ? 1 : 0, x: i < 10 ? 100 + i : i - 10 }))
    const fallback = analyzeDatasetCausalBalance(separated, { treatment_col: 'trt', covariates: ['x'], method: 'psm' })
    expect(fallback.matched_pairs).toBeLessThan(2)
    expect(fallback.requested_method).toBe('psm')
    expect(fallback.method).toBe('iptw')
    expect(fallback.method_note).toContain('IPTW')
  })

  it('纵向随访时间窗衍生列、Auto-eCRF 双向同步核实、方案提取终点变量与图表过期检测', async () => {
    const { mkdtempSync, copyFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Store } = await import('../src/store/db.ts')
    const { TenantService } = await import('../src/auth/tenants.ts')
    const { TenantKeys, kekFrom } = await import('../src/tenancy/keys.ts')
    const { PatientService } = await import('../src/tenancy/patients.ts')
    const { DatasetService, parseCsv } = await import('../src/datasets/service.ts')
    const { StudyService } = await import('../src/research/service.ts')
    const { CohortService } = await import('../src/research/cohort.ts')
    const { EcrfService } = await import('../src/research/ecrf.ts')

    const store = new Store(':memory:')
    const tenants = new TenantService(store, { devMode: false })
    const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
    const patients = new PatientService(mkdtempSync(join(tmpdir(), 'co-p2-pt-')), tenants, keys, store)
    const ingest = async (_owner: string, src: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'co-p2-ing-'))
      copyFileSync(src, join(dir, 'data.csv'))
      const recs = parseCsv(readFileSync(src, 'utf8')) as string[][]
      const header = recs[0] ?? []
      return {
        csv: join(dir, 'data.csv'), cleanup: () => {},
        profile: { ok: true as const, rows: recs.length - 1, truncated: false, columns: header.map(name => ({ name, type: 'text' as const, missing: 0, unique: 1 })) },
      }
    }
    const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'co-p2-ds-')), ingest)
    const studies = new StudyService(store, datasets)
    const cohort = new CohortService(studies, patients, datasets)
    const ecrf = new EcrfService(studies, patients, datasets)

    const hosp = store.createTenant({ name: '瑞金研究中心', kind: 'org' })
    const user = store.createUser({ username: 'pi2', display_name: 'PI2', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
    const actor = { userId: user, via: 'user' as const }

    const study = studies.create(user, {
      title: 'NSCLC 靶向免疫队列',
      summary: '本研究为随机对照试验(RCT)，评估 EGFR 突变与 PD-L1 表达患者接受靶向治疗的客观缓解率(ORR)及 ECOG 评分变化。\n纳入标准：\n1. 年龄 18-80 岁\n排除标准：\n1. 合并严重肝肾功能不全',
    })

    // 1. 方案提取应自动识别 RCT 设计并预置 EGFR、PD-L1、ORR、ECOG 自定义终点变量
    const blueprint = studies.extractEligibilityFromProtocol(user, study.id, { save: true })
    expect(blueprint.recommended_design).toBe('rct')
    expect(blueprint.extracted_custom_vars.some(v => v.key === 'egfr_mutation')).toBe(true)
    expect(blueprint.extracted_custom_vars.some(v => v.key === 'pdl1_tps')).toBe(true)
    expect(blueprint.extracted_custom_vars.some(v => v.key === 'orr_response')).toBe(true)
    expect(studies.read(user, study.id).custom_vars.some(v => v.key === 'egfr_mutation')).toBe(true)

    // 2. 创建患者并录入入组前、M3、M6 多次化验
    const today = new Date().toISOString().slice(0, 10)
    const addDays = (iso: string, d: number) => {
      const dt = new Date(`${iso}T00:00:00Z`)
      dt.setUTCDate(dt.getUTCDate() + d)
      return dt.toISOString().slice(0, 10)
    }
    const pt = patients.create(actor, { sex: 'M', birth_year: 1965, tags: ['NSCLC'] })
    // 远期历史化验 (-120天，超出 [-30, 7] 基线窗)
    const fOld = patients.addFile(actor, pt.id, { name: 'old.pdf', mime: 'application/pdf', bytes: Uint8Array.from([1]), report_date: addDays(today, -120) })
    patients.addRecordLab(actor, pt.id, fOld.record.id, { test_name: 'eGFR', value: 95, unit: 'mL/min/1.73m²' })
    patients.resolveRecord(actor, pt.id, fOld.record.id, { accept: true })
    // 围入组期基线化验 (-5天，在 [-30, 7] 基线窗内)
    const fBase = patients.addFile(actor, pt.id, { name: 'base.pdf', mime: 'application/pdf', bytes: Uint8Array.from([2]), report_date: addDays(today, -5) })
    patients.addRecordLab(actor, pt.id, fBase.record.id, { test_name: 'eGFR', value: 80, unit: 'mL/min/1.73m²' })
    patients.resolveRecord(actor, pt.id, fBase.record.id, { accept: true })
    // M3 随访化验 (+88天)
    const fM3 = patients.addFile(actor, pt.id, { name: 'm3.pdf', mime: 'application/pdf', bytes: Uint8Array.from([3]), report_date: addDays(today, 88) })
    patients.addRecordLab(actor, pt.id, fM3.record.id, { test_name: 'eGFR', value: 72, unit: 'mL/min/1.73m²' })
    patients.resolveRecord(actor, pt.id, fM3.record.id, { accept: true })

    cohort.enroll(actor, study.id, { patient_ids: [pt.id] })

    // 3. Auto-eCRF 提取并自动同步至 subject_vars + 单元格 SDV 核实
    const ecrfRes = await ecrf.extractCohortEcrf(actor, study.id, ['egfr', 'l3_smi'], { sync_to_vars: true })
    expect(ecrfRes.total_subjects).toBe(1)
    expect(ecrfRes.rows[0]!.variables.egfr!.value).toBe(72) // latest is 72

    // 在溯源卡片中直接修订并 SDV 核实锁定 l3_smi = 46.5
    const verified = ecrf.verifyCell(actor, study.id, {
      subject_id: 'S001',
      var_id: 'l3_smi',
      value: 46.5,
      source_detail: 'CT L3 层面人工复核确认',
    })
    expect(verified.ok).toBe(true)

    // 同时核实受试者分组与生存结局
    ecrf.verifyCell(actor, study.id, { subject_id: 'S001', var_id: 'treatment_arm', value: '靶向联合组', verify: true })
    ecrf.verifyCell(actor, study.id, { subject_id: 'S001', var_id: 'followup_months', value: 18.5, verify: true })
    ecrf.verifyCell(actor, study.id, { subject_id: 'S001', var_id: 'os_status', value: 0, verify: true })

    // 4. 生成带基线时间窗 [-30, 7]、M3 随访节点及变化量 Δ 的研究宽表 v1
    const dsV1 = await cohort.dataset(actor, study.id, {
      shape: 'wide',
      baseline_window_days: [-30, 7],
      landmarks: ['m3'],
      include_change: true,
    })
    const prevV1 = datasets.preview(user, dsV1.dataset.id)
    const baseCol = prevV1.header.find(h => h.startsWith('egfr_baseline'))!
    const m3Col = prevV1.header.find(h => h.startsWith('egfr_m3'))!
    const deltaCol = prevV1.header.find(h => h.startsWith('egfr_delta'))!
    expect(baseCol).toBeDefined()
    expect(m3Col).toBeDefined()
    expect(deltaCol).toBeDefined()
    expect(prevV1.header).toContain('egfr_change_pct')
    expect(prevV1.header).toContain('treatment_arm')
    expect(prevV1.header).toContain('l3_smi_verified')

    const rowObj: Record<string, string> = {}
    prevV1.header.forEach((h, idx) => { rowObj[h] = prevV1.rows[0]![idx]! })
    // 基线窗 [-30, 7] 排除了 -120 天的 95，精准锚定 -5 天的 80
    expect(Number(rowObj[baseCol])).toBe(80)
    expect(Number(rowObj[m3Col])).toBe(72)
    expect(Number(rowObj[deltaCol])).toBe(-8)
    expect(Number(rowObj.egfr_change_pct)).toBe(-10)
    expect(rowObj.treatment_arm).toBe('靶向联合组')
    expect(Number(rowObj.l3_smi_verified)).toBe(46.5)

    // 5. 归档一张绑定 v1 数据集的图表，随后新增患者生成 v2 数据集，验证图表自动标记 stale_data
    const figAsset = store.putAsset({
      owner: user,
      name: 'Figure1_KM.svg',
      mime: 'image/svg+xml',
      bytes: new TextEncoder().encode('<svg></svg>'),
      provenance: {
        code: null,
        code_path: null,
        turn_id: null,
        at: new Date().toISOString(),
        datasets: [{ id: dsV1.dataset.id, name: dsV1.dataset.name, rows: 1, version: 1 }],
      },
    })
    expect(studies.read(user, study.id).analyses.find(a => a.asset_id === figAsset.id)?.stale_data).toBe(false)

    // 新入组第 2 名患者并生成 v2 宽表
    const pt2 = patients.create(actor, { sex: 'F', birth_year: 1970, tags: ['NSCLC'] })
    cohort.enroll(actor, study.id, { patient_ids: [pt2.id] })
    await cohort.dataset(actor, study.id, { shape: 'wide' })

    const stAfterV2 = studies.read(user, study.id)
    const figMeta = stAfterV2.analyses.find(a => a.asset_id === figAsset.id)!
    expect(figMeta.stale_data).toBe(true)
    expect(figMeta.stale_reason).toContain('v1')
    expect(figMeta.stale_reason).toContain('v2')
  })
})


