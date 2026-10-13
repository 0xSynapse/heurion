import { describe, it, expect } from 'vitest'
import { renderConsortSvg, renderConsortMermaid, type ConsortDiagramData } from '../src/research/consort.ts'
import { calculateEValue, generateLovePlotSvg, type LovePlotConfig } from '../src/research/causal-inference.ts'
import { generateTable1FromData } from '../src/datasets/table1.ts'
import { exportTable1ToDocx } from '../src/datasets/table1-docx.ts'
import { generateSurvivalAnalysis, renderForestPlotSvg } from '../src/datasets/survival.ts'
import { unzipSync } from 'fflate'

describe('临床科研进阶套件测试 (Research Extensions)', () => {
  it('1. CONSORT 2010 矢量纳排筛选流向图生成验证', () => {
    const mockConsort: ConsortDiagramData = {
      title: 'DAPA-HF 试验人群 CONSORT 入组流向图',
      total_assessed: 4744,
      exclusions: [
        { reason: '未行增强薄层 CT (层厚 > 3mm)', count: 184 },
        { reason: '既往合并恶性肿瘤病史', count: 45 },
        { reason: '关键生化指标 (eGFR / NT-proBNP) 缺失', count: 57 },
      ],
      eligible_total: 1420,
      arms: [
        {
          name: '达格列净组 (Dapagliflozin 10mg qd)',
          allocated: 710,
          lost_to_followup: 4,
          discontinued: 12,
          analyzed: 694,
        },
        {
          name: '安慰剂对照组 (Placebo)',
          allocated: 710,
          lost_to_followup: 6,
          discontinued: 15,
          analyzed: 689,
        },
      ],
    }

    const svg = renderConsortSvg(mockConsort)
    expect(svg).toContain('<svg')
    expect(svg).toContain('DAPA-HF 试验人群 CONSORT 入组流向图')
    expect(svg).toContain('4,744')
    expect(svg).toContain('1,420')
    expect(svg).toContain('未行增强薄层 CT (层厚 &gt; 3mm): n = 184')
    expect(svg).toContain('达格列净组 (Dapagliflozin 10mg qd) (n = 710)')
    expect(svg).toContain('纳入最终疗效分析: n = 694')
    expect(svg).toContain('</svg>')

    const mermaid = renderConsortMermaid(mockConsort)
    expect(mermaid).toContain('graph TD')
    expect(mermaid).toContain('N = 4744')
    expect(mermaid).toContain('排除 n = 286')
    expect(mermaid).toContain('N = 1420')
  })

  it('2. VanderWeele E-value 混杂敏感度计算与抗辩论断验证', () => {
    // 验证 DAPA-HF 主要终点 HR = 0.74 (95% CI: 0.65 - 0.85)
    const res = calculateEValue({
      effect_type: 'HR',
      estimate: 0.74,
      ci_lower: 0.65,
      ci_upper: 0.85,
    })

    expect(res.effect_type).toBe('HR')
    expect(res.estimate).toBe(0.74)
    // 1 / 0.74 = 1.3514 -> E-value = 1.3514 + sqrt(1.3514 * 0.3514) = 1.3514 + 0.6891 = 2.04 ~ 2.06
    expect(res.e_value_point).toBeGreaterThanOrEqual(2.0)
    expect(res.e_value_point).toBeLessThanOrEqual(2.1)
    // Upper bound 0.85 -> 1 / 0.85 = 1.1765 -> E-value = 1.1765 + sqrt(1.1765 * 0.1765) = 1.1765 + 0.4557 = 1.63
    expect(res.e_value_ci).toBeGreaterThanOrEqual(1.58)
    expect(res.e_value_ci).toBeLessThanOrEqual(1.68)

    // 验证中英文自动生成的审稿抗辩文段
    expect(res.academic_defense_zh).toContain('VanderWeele E-value')
    expect(res.academic_defense_zh).toContain('未被观察测量的潜在残留混杂因素')
    expect(res.academic_defense_zh).toContain('高度的稳健性与抗偏倚能力')
    expect(res.academic_defense_en).toContain('robust causal resilience against potential unmeasured residual confounding')
  })

  it('3. Love Plot 协变量平衡收敛散点图生成验证', () => {
    const config: LovePlotConfig = {
      title: 'DAPA-HF 1:1 PSM 倾向评分匹配前后协变量平衡诊断图',
      smd_strict_threshold: 0.05,
      smd_loose_threshold: 0.10,
      covariates: [
        { name: 'age', label_zh: '年龄 (岁)', pre_smd: 0.18, post_smd: 0.028 },
        { name: 'female', label_zh: '女性比例', pre_smd: 0.14, post_smd: 0.019 },
        { name: 'lvef', label_zh: '左室射血分数 (LVEF)', pre_smd: 0.22, post_smd: 0.034 },
        { name: 'nt_pro_bnp', label_zh: '血清 NT-proBNP', pre_smd: 0.31, post_smd: 0.015 },
        { name: 'l3_smi', label_zh: 'L3 骨骼肌指数 (SMI)', pre_smd: 0.25, post_smd: 0.018 },
      ],
    }

    const svg = generateLovePlotSvg(config)
    expect(svg).toContain('<svg')
    expect(svg).toContain('DAPA-HF 1:1 PSM 倾向评分匹配前后协变量平衡诊断图')
    expect(svg).toContain('SMD = 0.10 (常规平衡警戒线)')
    expect(svg).toContain('SMD = 0.05 (严格随机化线)')
    expect(svg).toContain('L3 骨骼肌指数 (SMI)')
    expect(svg).toContain('Unmatched')
    expect(svg).toContain('Matched / Balanced')
    expect(svg).toContain('</svg>')
  })

  it('4. 原生 Word (.docx) 医学标准三线表二进制导出验证', () => {
    // 构造模拟临床研究数据生成 Table 1
    const mockData = [
      { id: 1, group: '达格列净组', age: 66, sex: 'Male', l3_smi: 56.5, lvef: 31.0 },
      { id: 2, group: '达格列净组', age: 64, sex: 'Female', l3_smi: 52.8, lvef: 32.5 },
      { id: 3, group: '达格列净组', age: 67, sex: 'Male', l3_smi: 58.1, lvef: 29.5 },
      { id: 4, group: '对照组', age: 65, sex: 'Male', l3_smi: 55.8, lvef: 31.2 },
      { id: 5, group: '对照组', age: 66, sex: 'Female', l3_smi: 53.0, lvef: 30.8 },
      { id: 6, group: '对照组', age: 68, sex: 'Male', l3_smi: 54.2, lvef: 28.9 },
    ]

    const table1 = generateTable1FromData(mockData, {
      group_col: 'group',
      title: 'Table 1. Baseline Characteristics of DAPA-HF Cohort',
      include_smd: true,
      include_p_value: true,
      labels: {
        age: 'Age (years)',
        sex: 'Sex',
        l3_smi: 'L3 Skeletal Muscle Index (cm²/m²)',
        lvef: 'Left Ventricular Ejection Fraction (%)',
      },
    })

    expect(table1.headers.length).toBeGreaterThan(3)
    expect(table1.rows.length).toBeGreaterThan(3)

    // 导出为 .docx 二进制
    const docxBytes = exportTable1ToDocx(table1)
    expect(docxBytes).toBeInstanceOf(Uint8Array)
    expect(docxBytes.length).toBeGreaterThan(1000)

    // 验证导出的 docx 为合法 Zip 包并包含标准 Word 文档文件
    const unzipped = unzipSync(docxBytes)
    expect(unzipped['[Content_Types].xml']).toBeDefined()
    expect(unzipped['word/document.xml']).toBeDefined()
    expect(unzipped['word/styles.xml']).toBeDefined()

    // 验证 document.xml 包含标准三线表 OpenXML 语法
    const docXml = new TextDecoder().decode(unzipped['word/document.xml'])
    expect(docXml).toContain('<w:tblBorders>')
    expect(docXml).toContain('<w:top w:val="single" w:sz="12"') // 1.5 pt 顶线
    expect(docXml).toContain('<w:bottom w:val="single" w:sz="12"') // 1.5 pt 底线
    expect(docXml).toContain('<w:bottom w:val="single" w:sz="6"') // 0.75 pt 表头底线
    expect(docXml).toContain('Table 1. Baseline Characteristics of DAPA-HF Cohort')
    expect(docXml).toContain('Age (years)')
    expect(docXml).toContain('L3 Skeletal Muscle Index')
  })
})

describe('临床科研 HTTP API 端点集成测试', async () => {
  const { mkdtempSync, readFileSync, copyFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { buildApi } = await import('../src/http/api.ts')
  const { Documents } = await import('../src/model/runtime.ts')
  const { OpService } = await import('../src/ops/service.ts')
  const { PostCheck } = await import('../src/collab/postcheck.ts')
  const { SlideRenderer } = await import('../src/render/slides.ts')
  const { Accounts } = await import('../src/auth/accounts.ts')
  const { DatasetService, parseCsv } = await import('../src/datasets/service.ts')
  const { StudyService } = await import('../src/research/service.ts')
  const { Store } = await import('../src/store/db.ts')
  const { TenantService } = await import('../src/auth/tenants.ts')
  const { TenantKeys, kekFrom } = await import('../src/tenancy/keys.ts')
  const { PatientService } = await import('../src/tenancy/patients.ts')
  const { CohortService } = await import('../src/research/cohort.ts')
  const { issueToken } = await import('../src/auth/token.ts')

  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const accounts = new Accounts(store, { secret: 'test-secret', devMode: true, devToken: 'dev', devUser: 'u1' })
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 're-pt-')), tenants, keys, store)

  const ingest = async (_owner: string, src: string) => {
    const dir = mkdtempSync(join(tmpdir(), 're-ing-'))
    copyFileSync(src, join(dir, 'data.csv'))
    const recs = parseCsv(readFileSync(src, 'utf8'))
    const header = recs[0] ?? []
    return {
      csv: join(dir, 'data.csv'), cleanup: () => {},
      profile: { ok: true as const, rows: recs.length - 1, truncated: false, columns: header.map(name => ({ name, type: 'text' as const, missing: 0, unique: 1 })) },
    }
  }

  const dsDir = mkdtempSync(join(tmpdir(), 're-ds-'))
  const datasets = new DatasetService(store, dsDir, ingest)
  const studies = new StudyService(store, datasets)
  const cohort = new CohortService(studies, patients, datasets)

  const hosp = store.createTenant({ name: '测试研究中心', kind: 'org' })
  const user = store.createUser({ username: 'dr_tester', display_name: 'Tester', password_hash: 'x', tenant: { id: hosp.id, role: 'admin' } })
  const study = studies.create(user.id, { title: '心衰前瞻性队列研究', design: 'prospective_cohort' })
  const authToken = `Bearer ${issueToken('test-secret', { u: user.id, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: user.token_version })}`

  // 创建一个测试数据集
  const csvContent = 'group,age,sex,lvef\n达格列净组,66,M,31.0\n达格列净组,64,F,32.5\n对照组,65,M,31.2\n对照组,68,M,28.9\n'
  const dsUpload = datasets.upload(user.id, 'dapa_study.csv', Buffer.from(csvContent, 'utf-8'), { name: 'DAPA-Study-Cohort' })
  await datasets.idle()

  const app = buildApi({
    docs,
    ops,
    turns: {} as any,
    postcheck: new PostCheck(docs),
    crossref: {} as any,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 're-render-'))),
    accounts,
    devMode: true,
    devUser: user.id,
    datasets,
    studies,
    patients,
    cohort,
  })

  it('1. GET /api/datasets/:did/table1-docx 原生 Word 导出', async () => {
    const res = await app.request(`/api/datasets/${dsUpload.dataset.id}/table1-docx?group_col=group`, {
      method: 'GET',
      headers: { Authorization: authToken },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(res.headers.get('content-disposition')).toContain('.docx')

    const buf = await res.arrayBuffer()
    const docxBytes = new Uint8Array(buf)
    expect(docxBytes.length).toBeGreaterThan(1000)

    const unzipped = unzipSync(docxBytes)
    expect(unzipped['word/document.xml']).toBeDefined()
    const docXml = new TextDecoder().decode(unzipped['word/document.xml'])
    expect(docXml).toContain('<w:tblBorders>')
    expect(docXml).toContain('达格列净组')
    expect(docXml).toContain('对照组')
  })

  it('2. POST /api/datasets/:did/table1-docx 带自定义配置导出', async () => {
    const res = await app.request(`/api/datasets/${dsUpload.dataset.id}/table1-docx`, {
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        group_col: 'group',
        title: 'Table 1. Baseline Characteristics of Pilot Cohort',
        labels: { lvef: 'Left Ventricular Ejection Fraction (%)' },
      }),
    })

    expect(res.status).toBe(200)
    const buf = await res.arrayBuffer()
    const unzipped = unzipSync(new Uint8Array(buf))
    const docXml = new TextDecoder().decode(unzipped['word/document.xml'])
    expect(docXml).toContain('Table 1. Baseline Characteristics of Pilot Cohort')
    expect(docXml).toContain('Left Ventricular Ejection Fraction')
  })

  it('3. GET /api/studies/:sid/cohort/consort 只用真实入组记录，不编造排除人数与分组', async () => {
    const res = await app.request(`/api/studies/${study.id}/cohort/consort?assessed=500`, {
      method: 'GET',
      headers: { Authorization: authToken },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.svg).toContain('<svg')
    expect(body.svg).toContain('Participant Flow')
    expect(body.mermaid).toContain('graph TD')
    // assessed 参数不再被用来推算排除人数；没有筛选 / 排除 / 分组记录就不画
    expect(body.data.total_assessed).toBeUndefined()
    expect(body.data.arms).toEqual([])
    expect(body.data.analyzed).toBe(body.data.enrolled_ever - body.data.withdrawn)
    expect(body.svg).not.toMatch(/Assessed for eligibility|Excluded: n|未达入选标准|合并既往恶性肿瘤|干预治疗组|对照观察组|失访/)
    expect(body.mermaid).not.toMatch(/排除人群|干预治疗组|对照观察组/)

    // 测试 ?format=svg 直接返回矢量图
    const resSvg = await app.request(`/api/studies/${study.id}/cohort/consort?format=svg`, {
      method: 'GET',
      headers: { Authorization: authToken },
    })
    expect(resSvg.status).toBe(200)
    expect(resSvg.headers.get('content-type')).toBe('image/svg+xml')
    const svgText = await resSvg.text()
    expect(svgText).toContain('</svg>')
  })

  it('4. POST /api/studies/:sid/causal/e-value VanderWeele 计算与抗辩生成', async () => {
    const res = await app.request(`/api/studies/${study.id}/causal/e-value`, {
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        effect_type: 'HR',
        estimate: 0.74,
        ci_lower: 0.65,
        ci_upper: 0.85,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.e_value_point).toBeGreaterThanOrEqual(2.0)
    expect(body.e_value_ci).toBeGreaterThanOrEqual(1.58)
    expect(body.academic_defense_zh).toContain('VanderWeele E-value')
    expect(body.academic_defense_en).toContain('robust causal resilience')
  })

  it('5. POST /api/studies/:sid/causal/love-plot 协变量平衡散点图生成', async () => {
    const res = await app.request(`/api/studies/${study.id}/causal/love-plot`, {
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'PSM Balance',
        covariates: [
          { name: 'age', label_zh: '年龄', pre_smd: 0.22, post_smd: 0.03 },
        ],
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.svg).toContain('<svg')
    expect(body.svg).toContain('PSM Balance')
  })

  it('6. GET /api/studies/:sid/ecrf/template 多模态字典模版返回', async () => {
    const res = await app.request(`/api/studies/${study.id}/ecrf/template`, {
      method: 'GET',
      headers: { Authorization: authToken },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.categories).toContain('imaging')
    expect(body.categories).toContain('survival')
    expect(body.variables.some((v: any) => v.id === 'recist_longest_diam_mm')).toBe(true)
    expect(body.variables.some((v: any) => v.id === 'l3_smi')).toBe(true)
  })

  it('7. POST /api/studies/:sid/ecrf/extract 批量提取与切片证据溯源', async () => {
    // 创建一个受试者并入组
    const pt = patients.create({ userId: user.id, via: 'user' }, {
      sex: 'M',
      birth_year: 1960,
      tags: ['心衰', '肺癌'],
    })
    cohort.enroll({ userId: user.id, via: 'user' }, study.id, { patient_ids: [pt.id] })

    const res = await app.request(`/api/studies/${study.id}/ecrf/extract`, {
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        variable_ids: ['recist_longest_diam_mm', 'l3_smi', 'vat_to_sat_ratio', 'nt_pro_bnp'],
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.total_subjects).toBeGreaterThanOrEqual(1)
    expect(body.extracted_variables.length).toBe(4)
    expect(body.rows.length).toBeGreaterThanOrEqual(1)

    const firstRow = body.rows[0]
    expect(firstRow.subject_id).toBeDefined()
    // 检查是否有 3D 切片层号溯源信息
    // 没有影像量化记录时如实为缺失，不做「分割回填估算」
    const smiCell = firstRow.variables.l3_smi
    expect(smiCell).toBeDefined()
    expect(smiCell.value).toBeNull()
    expect(smiCell.confidence).toBe(0)
    expect(smiCell.source_type).toBe('imaging')
    expect(smiCell.source_slice_index).toBeUndefined()
    expect(firstRow.variables.vat_to_sat_ratio.value).toBeNull()
    expect(body.dataset_wide_preview[0].l3_smi).toBeNull()
  })

  it('7b. eCRF 的治疗分组、结局与随访没有登记来源时为 null，不按序号取模生成', async () => {
    const res = await app.request(`/api/studies/${study.id}/ecrf/extract`, {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ variable_ids: ['treatment_arm', 'os_status', 'followup_months', 'age'] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    for (const row of body.rows) {
      expect(row.variables.treatment_arm.value).toBeNull()
      expect(row.variables.os_status.value).toBeNull()
      expect(row.variables.followup_months.value).toBeNull()
      expect(row.variables.followup_months.formatted).toBe('—')
    }
    expect(body.rows[0].variables.age.value).not.toBeNull()
    expect(body.summary.missing_cells).toBe(body.rows.length * 3)
  })

  it('7c. 列线图与 ROC/DCA 不再用示例系数 / 示例数据：缺输入时返回 400', async () => {
    const nomo = await app.request(`/api/datasets/${dsUpload.dataset.id}/nomogram`, {
      method: 'POST', headers: { Authorization: authToken, 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(nomo.status).toBe(400)
    expect((await nomo.json() as any).error).toContain('predictors')

    const roc = await app.request(`/api/datasets/${dsUpload.dataset.id}/roc-dca`, {
      method: 'POST', headers: { Authorization: authToken, 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(roc.status).toBe(400)

    const ok = await app.request(`/api/datasets/${dsUpload.dataset.id}/roc-dca`, {
      method: 'POST', headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: [1, 0, 1, 0], scores_baseline: [0.7, 0.4, 0.6, 0.3], scores_multimodal: [0.8, 0.2, 0.9, 0.1] }),
    })
    expect(ok.status).toBe(200)
  })

  it('8. POST /api/studies/:sid/ecrf/save-dataset 保存为宽表研究数据集', async () => {
    const res = await app.request(`/api/studies/${study.id}/ecrf/save-dataset`, {
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Auto-eCRF 提取快照',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.dataset).toBeDefined()
    expect(body.dataset.name).toContain('Auto-eCRF')
    expect(body.dataset.id).toBeDefined()
    expect(body.summary.extracted_cells).toBeGreaterThanOrEqual(1)
  })

  it('9. 临床生存分析引擎：Kaplan-Meier 累积生存拟合与 Cox 森林图矢量图渲染', () => {
    const kmData = [
      { time: 6, event: 0, group: '试验组' },
      { time: 12, event: 1, group: '试验组' },
      { time: 18, event: 0, group: '试验组' },
      { time: 24, event: 1, group: '试验组' },
      { time: 4, event: 1, group: '对照组' },
      { time: 8, event: 1, group: '对照组' },
      { time: 14, event: 1, group: '对照组' },
      { time: 20, event: 0, group: '对照组' },
    ]

    const fit = generateSurvivalAnalysis(kmData, {
      time_col: 'time',
      event_col: 'event',
      group_col: 'group',
      time_unit: 'Months',
      title: 'Figure 3. Kaplan-Meier Survival Curves',
    })

    expect(fit.groups.length).toBe(2)
    expect(fit.log_rank).toBeDefined()
    expect(fit.svg).toContain('<svg')
    expect(fit.svg).toContain('Figure 3. Kaplan-Meier Survival Curves')
    expect(fit.svg).toContain('No. at Risk')

    const mockCox = {
      sample_size: 400,
      events_count: 85,
      c_index: 0.74,
      p_value_overall: 0.001,
      covariates: [
        {
          variable: 'treatment',
          name: 'treatment',
          label: '联合治疗组 vs 单药对照组',
          beta: -0.478,
          se: 0.21,
          z: -2.28,
          p_value: 0.023,
          p_value_formatted: '0.023',
          hr: 0.62,
          hr_ci_lower: 0.41,
          hr_ci_upper: 0.94,
          hr_formatted: '0.62 (0.41–0.94)',
        },
        {
          variable: 'l3_smi',
          name: 'l3_smi',
          label: 'L3 骨骼肌质量指数正常 vs 肌少症',
          beta: -0.598,
          se: 0.23,
          z: -2.60,
          p_value: 0.009,
          p_value_formatted: '0.009',
          hr: 0.55,
          hr_ci_lower: 0.35,
          hr_ci_upper: 0.86,
          hr_formatted: '0.55 (0.35–0.86)',
        },
      ],
    }

    const forestSvg = renderForestPlotSvg(mockCox, 'Figure 4. Multivariate Cox Proportional Hazards Regression')
    expect(forestSvg).toContain('<svg')
    expect(forestSvg).toContain('Figure 4. Multivariate Cox Proportional Hazards Regression')
    expect(forestSvg).toContain('Hazard Ratio (95% CI)')
    expect(forestSvg).toContain('0.62 (0.41–0.94)')
    expect(forestSvg).toContain('Favors Treatment')
    expect(forestSvg).toContain('Favors Control')
  })
})

