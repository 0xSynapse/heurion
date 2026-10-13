import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'

function env() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const root = mkdtempSync(join(tmpdir(), 'hr-pt-img-'))
  const svc = new PatientService(root, tenants, keys, store)
  const hosp = store.createTenant({ name: '呼吸与重症医学中心', kind: 'org' })
  const user = store.createUser({ username: 'dr_li', display_name: '李医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  return { store, tenants, keys, root, svc, hosp, user, as }
}

describe('患者影像量化分析与病历关联 (Patient Imaging Integration)', () => {
  const dummyPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
  ])

  it('1. addImagingRecord: 支气管扩张与粘液栓分析结果自动加密入库、生成资产并更新患者标签', () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'M', birth_year: 1968, tags: ['反复咳嗽', '咳脓痰'] })

    const res = t.svc.addImagingRecord(a, patient.id, {
      title: '胸部 HRCT 支气管扩张与粘液栓定量分析',
      report_date: '2026-10-05',
      model_id: 'bronchiectasis_mucus_analyzer',
      sample_id: 'chest_lung_ct',
      modality: 'Chest HRCT',
      metrics: {
        bar_ratio: 1.48,
        signet_ring_sign: true,
        mucus_plug_volume_mm3: 1420.5,
        airway_mucus_occlusion_pct: 3.8,
        high_attenuation_mucus_ham: true,
        ham_volume_mm3: 320.0,
        paired_artery_outer_diameter_mm: 1.62,
        airway_inner_luminal_diameter_mm: 2.40,
        airway_wall_thickness_mm: 0.95,
      },
      findings: [
        '印戒征阳性 (BAR 1.48 > 1.10)',
        '高密度粘液栓 (HAM) 阳性 (320 mm³，提示 ABPA 疑诊)',
        '支气管管腔粘液栓体积 1420.5 mm³',
      ],
      key_slice_png: dummyPng,
      add_tags: ['支气管扩张', 'ABPA疑诊'],
    })

    expect(res.record.kind).toBe('imaging')
    expect(res.record.status).toBe('confirmed')
    expect(res.record.title).toBe('胸部 HRCT 支气管扩张与粘液栓定量分析')
    expect(res.record.report_date).toBe('2026-10-05')
    expect(res.record.file_id).toBeTruthy()
    expect(res.asset_id).toBeTruthy()

    // 检查 Store 中资产是否存在可读取
    const asset = t.store.getAsset(res.asset_id)
    expect(asset).toBeTruthy()
    expect(asset?.mime).toBe('image/png')
    const assetBytes = t.store.getAssetBytes(res.asset_id)
    expect(Buffer.from(assetBytes!).equals(dummyPng)).toBe(true)

    // 检查机构患者库中加密文件与解密
    const file = t.svc.file(a, patient.id, res.file_id)
    expect(file.mime).toBe('image/png')
    expect(Buffer.from(file.bytes).equals(dummyPng)).toBe(true)

    // 读取患者详情：验证 records 中解密的 imaging_data 结构与标签自动合并
    const detail = t.svc.read(a, patient.id)
    expect(detail.tags).toEqual(['反复咳嗽', '咳脓痰', '支气管扩张', 'ABPA疑诊'])

    const imgRec = detail.records.find(r => r.kind === 'imaging')
    expect(imgRec).toBeTruthy()
    expect(imgRec?.imaging_data).toBeTruthy()
    const imgData = imgRec?.imaging_data as any
    expect(imgData.model_id).toBe('bronchiectasis_mucus_analyzer')
    expect(imgData.metrics.bar_ratio).toBe(1.48)
    expect(imgData.metrics.signet_ring_sign).toBe(true)
    expect(imgData.metrics.high_attenuation_mucus_ham).toBe(true)
    expect(imgData.findings.length).toBe(3)
  })

  it('2. RECIST 1.1 肿瘤病灶量化分析关联测试', () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'F', birth_year: 1955, tags: ['肺癌靶向治疗'] })

    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const res = t.svc.addImagingRecord(a, patient.id, {
      title: '胸部 CT 靶病灶 RECIST 1.1 测量',
      report_date: '2026-10-05',
      model_id: 'lung_nodule_segmenter',
      metrics: {
        longest_diameter_mm: 38.6,
        short_axis_mm: 24.2,
        total_volume_cm3: 28.4,
        key_slice_index: 28,
      },
      findings: [
        'RECIST 1.1 靶病灶最大截面长径 38.6 mm (短径 24.2 mm)',
        '3D 病灶体积 28.4 cm³ (关键截面第 #28 层)',
      ],
      key_slice_png: dummyPng,
    })

    const detail = t.svc.read(a, patient.id)
    const imgRec = detail.records[0]
    expect(imgRec).toBeDefined()
    expect(imgRec!.kind).toBe('imaging')
    const imgData = imgRec!.imaging_data as any
    expect(imgData.metrics.longest_diameter_mm).toBe(38.6)
    expect(imgData.metrics.total_volume_cm3).toBe(28.4)
  })

  it('3. HTTP API: GET /api/imaging/status 与 POST /api/patients/:ptid/imaging/analyze 端到端集成', async () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'M', birth_year: 1975, tags: ['慢阻肺'] })

    // 探测健康状态
    const statusResp = await fetch('http://127.0.0.1:8004/health').catch(() => null)
    if (!statusResp || !statusResp.ok) {
      console.warn('MONAI worker 未在 8004 端口运行，跳过真实推理端到端测试')
      return
    }

    // 动态构造 mock 或真实 HTTP 请求
    const { buildApi } = await import('../src/http/api.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { TurnService } = await import('../src/turns/service.ts')
    const { TurnRegistry } = await import('../src/mcp/turns.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')

    const docs = new Documents(t.store)
    const ops = new OpService(docs)
    const SECRET = 'test-secret'
    const accounts = new Accounts(t.store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' })
    const uRow = t.store.getUser(t.user)!
    const token = issueToken(SECRET, { u: t.user, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: uRow.token_version })

    const app = buildApi({
      docs,
      ops,
      turns: new TurnService(docs, {} as any, new TurnRegistry()),
      postcheck: new PostCheck(docs),
      crossref: {} as any,
      renderer: new SlideRenderer(t.root),
      accounts,
      devMode: false,
      devUser: 'dev',
      patients: t.svc,
    })

    // 测试 GET /api/imaging/status
    const stRes = await app.request('/api/imaging/status', {
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(stRes.status).toBe(200)
    const stJson = await stRes.json()
    expect(stJson.status).toBe('healthy')

    // 测试 POST /api/patients/:ptid/imaging/analyze (使用预置胸部 CT 样本运行支气管扩张量化)
    const analyzeRes = await app.request(`/api/patients/${patient.id}/imaging/analyze`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: 'bronchiectasis_mucus_analyzer',
        sample_id: 'chest_lung_ct',
        bar_cutoff: 1.10,
        mucus_min_hu: 10.0,
        mucus_max_hu: 75.0,
        ham_threshold_hu: 70.0,
        auto_tag: true,
      })
    })

    expect(analyzeRes.status).toBe(201)
    const resJson = await analyzeRes.json()
    expect(resJson.ok).toBe(true)
    expect(resJson.record.kind).toBe('imaging')
    expect(resJson.asset_id).toBeTruthy()
    expect(resJson.file_id).toBeTruthy()
    expect(resJson.metrics).toBeTruthy()
    expect(resJson.metrics.bar_ratio).toBeGreaterThan(0)
    expect(resJson.findings.length).toBeGreaterThan(0)

    // 验证患者信息被更新：标签自动打上「支气管扩张」
    const updatedPatient = t.svc.read(a, patient.id)
    expect(updatedPatient.tags).toContain('支气管扩张')
  }, 30000)

  it('4. compareImaging: 多期随访 RECIST 1.1 疗效对比与学术报告生成 (PR 部分缓解 / PD 疾病进展 / 单期基线)', () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'M', birth_year: 1960, tags: ['非小细胞肺癌'] })

    // 4.1 尚未录入任何影像时报错
    expect(() => t.svc.compareImaging(a, patient.id)).toThrow('该患者尚无已记录的医学影像量化分析数据')

    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    // 4.2 录入第 1 期基线影像 (Baseline)
    const baseRec = t.svc.addImagingRecord(a, patient.id, {
      title: '基线胸部 CT 靶病灶评估',
      report_date: '2026-06-01',
      model_id: 'lung_nodule_segmenter',
      metrics: {
        longest_diameter_mm: 50.0,
        short_axis_mm: 32.0,
        total_volume_cm3: 35.0,
        key_slice_index: 30,
      },
      key_slice_png: dummyPng,
    })

    // 仅有 1 期基线时，返回 is_single_baseline
    const singleRes = t.svc.compareImaging(a, patient.id)
    expect(singleRes.ok).toBe(true)
    expect(singleRes.is_single_baseline).toBe(true)
    expect(singleRes.message).toContain('仅有 1 份基线影像')

    // 4.3 录入第 2 期随访影像 (Follow-up 1): 缩小 34% (50.0 -> 33.0)，评定为 PR (部分缓解)
    const follow1Rec = t.svc.addImagingRecord(a, patient.id, {
      title: '化疗 2 周期后胸部 CT 随访评估',
      report_date: '2026-08-15',
      model_id: 'lung_nodule_segmenter',
      metrics: {
        longest_diameter_mm: 33.0,
        short_axis_mm: 20.0,
        total_volume_cm3: 16.5,
        key_slice_index: 29,
      },
      key_slice_png: dummyPng,
    })

    const prRes = t.svc.compareImaging(a, patient.id, {
      baseline_record_id: baseRec.record.id,
      followup_record_id: follow1Rec.record.id,
      save_as_record: true,
    })

    expect(prRes.ok).toBe(true)
    expect(prRes.is_single_baseline).toBe(false)
    expect(prRes.interval_days).toBe(75) // 6月1日到8月15日
    expect(prRes.recist?.category).toBe('PR')
    expect(prRes.recist?.category_name).toContain('部分缓解')
    expect(prRes.recist?.percent_change_ld).toBe(-34.0)
    expect(prRes.recist?.diff_ld_mm).toBe(-17.0)
    expect(prRes.summary_markdown).toContain('PR（部分缓解）（按 RECIST 1.1 阈值计算，未经阅片确认）')
    expect(prRes.summary_markdown).toContain('| **最大截面长径 (LD)** | 50 mm | 33 mm | -17 mm | **-34%** |')
    expect(prRes.record_id).toBeTruthy() // 验证生成了病历记录

    // 验证新生成的对比记录存在于患者详情中
    const detailAfterPr = t.svc.read(a, patient.id)
    const compareRec = detailAfterPr.records.find(r => r.id === prRes.record_id)
    expect(compareRec).toBeTruthy()
    expect(compareRec?.title).toContain('RECIST 1.1 疗效评估 (PR)')

    // 4.4 录入第 3 期随访影像 (Follow-up 2): 增大至 42.0 (较 follow1 增加 +27.3% 且绝对值 +9.0mm)，评定为 PD
    const follow2Rec = t.svc.addImagingRecord(a, patient.id, {
      title: '随访 6 个月胸部 CT 复查',
      report_date: '2026-12-01',
      model_id: 'lung_nodule_segmenter',
      metrics: {
        longest_diameter_mm: 42.0,
        short_axis_mm: 28.0,
        total_volume_cm3: 25.0,
        key_slice_index: 31,
      },
      key_slice_png: dummyPng,
    })

    const pdRes = t.svc.compareImaging(a, patient.id, {
      baseline_record_id: follow1Rec.record.id,
      followup_record_id: follow2Rec.record.id,
    })
    expect(pdRes.recist?.category).toBe('PD')
    expect(pdRes.recist?.category_name).toContain('疾病进展')
    expect(pdRes.recist?.percent_change_ld).toBe(27.3)
    expect(pdRes.recist?.diff_ld_mm).toBe(9.0)

    // 4.5 验证在存在已保存的 RECIST 评估记录时，默认对比自动忽略评估记录，纯粹对比原始影像
    const autoRes = t.svc.compareImaging(a, patient.id)
    expect(autoRes.ok).toBe(true)
    expect(autoRes.baseline.record_id).toBe(baseRec.record.id)
    expect(autoRes.followup.record_id).toBe(follow2Rec.record.id)
    expect(autoRes.baseline.asset_id).toBeTruthy()
    expect(autoRes.followup.asset_id).toBeTruthy()
    expect(autoRes.baseline.slice_file_id).toBeTruthy()
    expect(autoRes.followup.slice_file_id).toBeTruthy()
    // 验证对比记录本身不能作为基线或随访点
    expect(() => t.svc.compareImaging(a, patient.id, { followup_record_id: prRes.record_id })).toThrow('未找到指定的随访影像记录')
  })

  it('5. compareImaging: 支气管扩张与粘液栓随访改善评定', () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'F', birth_year: 1980, tags: ['支气管扩张', 'ABPA'] })
    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    // 基线：粘液栓体积 1200 mm³，HAM 阳性 (300 mm³)
    const baseRec = t.svc.addImagingRecord(a, patient.id, {
      title: '基线 HRCT 支气管粘液栓分析',
      report_date: '2026-03-01',
      model_id: 'bronchiectasis_mucus_analyzer',
      metrics: {
        bar_ratio: 1.5,
        total_mucus_volume_cm3: 12.0,
        high_attenuation_mucus_cm3: 3.0,
      },
      key_slice_png: dummyPng,
    })

    // 随访：抗真菌与糖皮质激素治疗 3 个月后，粘液栓吸收至 4.0 cm³ (-66.7%)，HAM 降至 0 (完全吸收)
    const followRec = t.svc.addImagingRecord(a, patient.id, {
      title: 'ABPA 治疗后 HRCT 随访复查',
      report_date: '2026-06-01',
      model_id: 'bronchiectasis_mucus_analyzer',
      metrics: {
        bar_ratio: 1.45,
        total_mucus_volume_cm3: 4.0,
        high_attenuation_mucus_cm3: 0,
      },
      key_slice_png: dummyPng,
    })

    const res = t.svc.compareImaging(a, patient.id, {
      baseline_record_id: baseRec.record.id,
      followup_record_id: followRec.record.id,
    })

    expect(res.recist?.target_type).toBe('bronchiectasis_mucus')
    // 气道粘液栓不是 RECIST 靶病灶：分类不适用并说明原因，只描述测量变化
    expect(res.recist?.category).toBe('NA')
    expect(res.recist?.na_reason).toContain('不是 RECIST 1.1 靶病灶')
    expect(res.recist?.interpretation).toContain('高密度粘液栓体积由')
    expect(res.summary_markdown).not.toMatch(/显著改善|曲霉|建议临床维持/)
  })

  it('6. HTTP API: POST /api/patients/:ptid/imaging/compare 端点测试', async () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'M', birth_year: 1965, tags: ['肿瘤'] })
    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    t.svc.addImagingRecord(a, patient.id, {
      title: '基线检查',
      report_date: '2026-01-10',
      model_id: 'lung_nodule_segmenter',
      metrics: { longest_diameter_mm: 40.0, total_volume_cm3: 20.0 },
      key_slice_png: dummyPng,
    })

    t.svc.addImagingRecord(a, patient.id, {
      title: '随访检查',
      report_date: '2026-04-10',
      model_id: 'lung_nodule_segmenter',
      metrics: { longest_diameter_mm: 25.0, total_volume_cm3: 10.0 },
      key_slice_png: dummyPng,
    })

    const { buildApi } = await import('../src/http/api.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { TurnService } = await import('../src/turns/service.ts')
    const { TurnRegistry } = await import('../src/mcp/turns.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')

    const docs = new Documents(t.store)
    const ops = new OpService(docs)
    const SECRET = 'test-secret'
    const accounts = new Accounts(t.store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' })
    const uRow = t.store.getUser(t.user)!
    const token = issueToken(SECRET, { u: t.user, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: uRow.token_version })

    const app = buildApi({
      docs,
      ops,
      turns: new TurnService(docs, {} as any, new TurnRegistry()),
      postcheck: new PostCheck(docs),
      crossref: {} as any,
      renderer: new SlideRenderer(t.root),
      accounts,
      devMode: false,
      devUser: 'dev',
      patients: t.svc,
    })

    const res = await app.request(`/api/patients/${patient.id}/imaging/compare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ save_as_record: true }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.recist.category).toBe('PR')
    expect(json.recist.percent_change_ld).toBe(-37.5)
    expect(json.record_id).toBeTruthy()
  })

  it('7. getEvidenceChain: 多模态因果诊断链分析 (支扩伴 HAM + 嗜酸粒细胞 + IgE)', () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'M', birth_year: 1968, tags: ['反复咳嗽', '支气管扩张待查'] })

    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    // 录入化验：嗜酸粒细胞升高，血清总 IgE 显著升高
    t.svc.addLab(a, patient.id, {
      test_name: '嗜酸性粒细胞绝对值 (EOS#)',
      value: 1.15,
      unit: '×10⁹/L',
      ref_low: 0.02,
      ref_high: 0.5,
      flag: 'H',
      collected_on: '2026-10-02',
    }, { status: 'confirmed' })

    t.svc.addLab(a, patient.id, {
      test_name: '血清总 IgE',
      value: 1480,
      unit: 'IU/mL',
      ref_low: 0,
      ref_high: 100,
      flag: 'H',
      collected_on: '2026-10-02',
    }, { status: 'confirmed' })

    // 录入影像：胸部 HRCT 支扩伴 HAM 阳性
    const imgRec = t.svc.addImagingRecord(a, patient.id, {
      title: '胸部 HRCT 支气管扩张与粘液栓定量分析',
      report_date: '2026-10-05',
      model_id: 'bronchiectasis_mucus_analyzer',
      sample_id: 'chest_lung_ct',
      metrics: {
        bar_ratio: 1.52,
        signet_ring_sign: true,
        high_attenuation_mucus_ham: true,
        high_attenuation_mucus_cm3: 2.8,
        total_mucus_volume_cm3: 8.5,
      },
      findings: ['印戒征阳性 (BAR 1.52)', '高密度粘液栓 (HAM) 阳性 (2.8 cm³)'],
      key_slice_png: dummyPng,
    })

    // 执行多模态证据链三角比对
    const chain = t.svc.getEvidenceChain(a, patient.id, { record_id: imgRec.record.id })

    expect(chain.ok).toBe(true)
    expect(chain.syndrome_key).toBe('abpa_bronchiectasis')
    // 不再输出临床紧迫度判断
    expect('clinical_urgency' in chain).toBe(false)
    expect(chain.criteria_table.length).toBeGreaterThanOrEqual(5)
    
    // 验证影像与化验阳性证据
    const hamRow = chain.criteria_table.find(r => r.criterion.includes('高密度粘液栓'))
    expect(hamRow?.status).toBe('positive')

    const igeRow = chain.criteria_table.find(r => r.criterion.includes('血清总 IgE'))
    expect(igeRow?.status).toBe('positive')

    const eosRow = chain.criteria_table.find(r => r.criterion.includes('嗜酸性粒细胞'))
    expect(eosRow?.status).toBe('positive')

    // 验证缺漏待查项识别 (烟曲霉特异性 sIgE)
    const sigeRow = chain.criteria_table.find(r => r.criterion.includes('烟曲霉特异性 IgE'))
    expect(sigeRow?.status).toBe('missing')
    // 不给检查 / 诊疗建议，不给诊断结论
    expect(chain.suggested_workup).toEqual([])
    expect(chain.diagnostic_impression).toBe('上述所见需结合临床与实验室检查判断。')
    expect(chain.syndrome).not.toMatch(/ABPA|曲霉/)
    expect(chain.summary_markdown).not.toMatch(/高度符合|强烈提示|确诊|抗真菌/)
    expect(chain.summary_markdown).toContain('不构成诊断')
    expect(chain.summary_markdown).toContain('高密度粘液栓')
    expect(chain.summary_markdown).toContain('1480')
  })

  it('8. HTTP API: GET /api/patients/:ptid/imaging/evidence-chain 端点测试', async () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'F', birth_year: 1955, tags: ['肺占位待查'] })

    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    t.svc.addLab(a, patient.id, {
      test_name: '癌胚抗原 (CEA)',
      value: 18.6,
      unit: 'ng/mL',
      ref_low: 0,
      ref_high: 5.0,
      flag: 'H',
      collected_on: '2026-10-01',
    }, { status: 'confirmed' })

    const imgRec = t.svc.addImagingRecord(a, patient.id, {
      title: '胸部 CT 靶病灶 RECIST 1.1 测量',
      report_date: '2026-10-05',
      model_id: 'lung_nodule_segmenter',
      metrics: {
        longest_diameter_mm: 36.5,
        short_axis_mm: 22.0,
        total_volume_cm3: 25.4,
      },
      key_slice_png: dummyPng,
    })

    const { buildApi } = await import('../src/http/api.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { TurnService } = await import('../src/turns/service.ts')
    const { TurnRegistry } = await import('../src/mcp/turns.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')

    const docs = new Documents(t.store)
    const ops = new OpService(docs)
    const SECRET = 'test-secret'
    const accounts = new Accounts(t.store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' })
    const uRow = t.store.getUser(t.user)!
    const token = issueToken(SECRET, { u: t.user, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: uRow.token_version })

    const app = buildApi({
      docs,
      ops,
      turns: new TurnService(docs, {} as any, new TurnRegistry()),
      postcheck: new PostCheck(docs),
      crossref: {} as any,
      renderer: new SlideRenderer(t.root),
      accounts,
      devMode: false,
      devUser: 'dev',
      patients: t.svc,
    })

    const res = await app.request(`/api/patients/${patient.id}/imaging/evidence-chain?record_id=${imgRec.record.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.syndrome_key).toBe('lung_neoplasm_recist')
    expect(json.matched_labs.some((l: any) => l.test_key === 'cea' && l.flag === 'H')).toBe(true)
    expect(json.criteria_table.some((c: any) => c.criterion.includes('RECIST 1.1'))).toBe(true)
  })

  it('9. 标准医学交换格式导出 (HL7 FHIR DiagnosticReport 与 DICOM SR)', async () => {
    const t = env()
    const a = { userId: t.user, via: 'user' as const }
    const patient = t.svc.create(a, {
      sex: 'M',
      birth_year: 1968,
      tags: ['支气管扩张', '高密度粘液栓'],
    })

    const rec = t.svc.addImagingRecord(a, patient.id, {
      title: '高分辨胸部 CT 支气管粘液栓评估',
      report_date: '2026-09-01',
      model_id: 'bronchiectasis_mucus_analyzer',
      metrics: {
        longest_diameter_mm: 28.5,
        short_axis_mm: 14.0,
        total_volume_cm3: 18.2,
        bar_ratio: 1.45,
        ham_density_confirmed: true,
        max_hu: 92.0,
        key_slice_index: 22,
      },
      key_slice_png: dummyPng,
    })

    // 9.1 导出 HL7 FHIR R4 DiagnosticReport
    const fhirRes = t.svc.exportImagingStandard(a, patient.id, {
      record_id: rec.record.id,
      format: 'fhir',
    })
    expect(fhirRes.format).toBe('fhir')
    expect(fhirRes.data.resourceType).toBe('DiagnosticReport')
    expect(fhirRes.data.status).toBe('final')
    expect(fhirRes.data.category[0].coding[0].code).toBe('RAD')
    expect(fhirRes.data.subject.reference).toContain(`Patient/${patient.id}`)
    expect(fhirRes.data.contained.some((o: any) => o.code?.text?.includes('RECIST 1.1') && o.valueQuantity?.value === 28.5)).toBe(true)
    expect(fhirRes.data.contained.some((o: any) => o.code?.text?.includes('BAR') && o.valueQuantity?.value === 1.45)).toBe(true)

    // 9.2 导出 DICOM SR (TID 1500)
    const dicomRes = t.svc.exportImagingStandard(a, patient.id, {
      record_id: rec.record.id,
      format: 'dicom-sr',
    })
    expect(dicomRes.format).toBe('dicom-sr')
    expect(dicomRes.data.SOPClassUID).toBe('1.2.840.10008.5.1.4.1.1.88.22')
    expect(dicomRes.data.Modality).toBe('SR')
    expect(dicomRes.data.TemplateID).toBe('TID 1500')
    expect(dicomRes.data.FindingsGroup.Measurements.some((m: any) => m.Value === 28.5)).toBe(true)
    expect(dicomRes.data.FindingsGroup.Measurements.some((m: any) => m.ConceptName.CodeMeaning.includes('BAR'))).toBe(true)

    // 9.3 HTTP API GET /api/patients/:ptid/imaging/export
    const { buildApi } = await import('../src/http/api.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { TurnService } = await import('../src/turns/service.ts')
    const { TurnRegistry } = await import('../src/mcp/turns.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')

    const docs = new Documents(t.store)
    const ops = new OpService(docs)
    const SECRET = 'test-secret'
    const accounts = new Accounts(t.store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' })
    const uRow = t.store.getUser(t.user)!
    const token = issueToken(SECRET, { u: t.user, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: uRow.token_version })

    const app = buildApi({
      docs,
      ops,
      turns: new TurnService(docs, {} as any, new TurnRegistry()),
      postcheck: new PostCheck(docs),
      crossref: {} as any,
      renderer: new SlideRenderer(t.root),
      accounts,
      devMode: false,
      devUser: 'dev',
      patients: t.svc,
    })

    const apiRes = await app.request(`/api/patients/${patient.id}/imaging/export?format=fhir&record_id=${rec.record.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(apiRes.status).toBe(200)
    const apiJson = await apiRes.json()
    expect(apiJson.resourceType).toBe('DiagnosticReport')
  })

  it('10. HTTP API: POST /api/imaging/mpr/diff-slice 3D 体素配准与差分吸收热力图', async () => {
    const isOnline = await fetch('http://127.0.0.1:8004/health', { signal: AbortSignal.timeout(500) }).then(r => r.ok).catch(() => false)
    const t = env()
    const { buildApi } = await import('../src/http/api.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { TurnService } = await import('../src/turns/service.ts')
    const { TurnRegistry } = await import('../src/mcp/turns.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')

    const docs = new Documents(t.store)
    const ops = new OpService(docs)
    const SECRET = 'test-secret'
    const accounts = new Accounts(t.store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' })
    const uRow = t.store.getUser(t.user)!
    const token = issueToken(SECRET, { u: t.user, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: uRow.token_version })

    const app = buildApi({
      docs,
      ops,
      turns: new TurnService(docs, {} as any, new TurnRegistry()),
      postcheck: new PostCheck(docs),
      crossref: {} as any,
      renderer: new SlideRenderer(t.root),
      accounts,
      devMode: false,
      devUser: 'dev',
      patients: t.svc,
    })

    const res = await app.request('/api/imaging/mpr/diff-slice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        baseline_id: 'chest_lung_ct',
        followup_id: 'chest_lung_ct',
        plane: 'axial',
        slice_index: 24,
        threshold_hu: 50,
      }),
    })

    if (!isOnline) {
      expect(res.status).toBe(503)
      return
    }

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.plane).toBe('axial')
    expect(data.slice_index).toBe(24)
    expect(data.statistics_3d).toBeTruthy()
    expect(data.slice_png_base64).toBeTruthy()
  })

  it('11. 全景多模态影像诊断报告生成 (generateComprehensiveReport & HTTP API)', async () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'M', birth_year: 1974, tags: ['支气管扩张', '咯血'] })

    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    // 录入血清总 IgE 与嗜酸粒细胞
    t.svc.addLab(a, patient.id, {
      test_name: '血清总 IgE',
      value: 1560,
      unit: 'kU/L',
      ref_low: 0,
      ref_high: 100,
      flag: 'H',
      collected_on: '2026-10-02',
    }, { status: 'confirmed' })

    t.svc.addLab(a, patient.id, {
      test_name: '嗜酸性粒细胞绝对值 (EOS#)',
      value: 0.95,
      unit: '10^9/L',
      ref_low: 0.02,
      ref_high: 0.52,
      flag: 'H',
      collected_on: '2026-10-02',
    }, { status: 'confirmed' })

    // 录入带 HAM 粘液栓的 CT 影像记录
    const imgRec = t.svc.addImagingRecord(a, patient.id, {
      title: '胸部 HRCT 轴位连续平扫',
      report_date: '2026-10-05',
      model_id: 'bronchiectasis_mucus_analyzer',
      metrics: {
        longest_diameter_mm: 7.2,
        short_axis_mm: 5.4,
        total_volume_cm3: 4.86,
        bar_max: 1.84,
        ham_max_hu: 94.5,
        high_attenuation_mucus: true,
      },
      key_slice_png: dummyPng,
    })

    // 1. Service 层调用
    const reportRes = t.svc.generateComprehensiveReport(a, patient.id, {
      record_id: imgRec.record.id,
      save_to_records: true,
    })

    expect(reportRes.ok).toBe(true)
    expect(reportRes.saved_record_id).toBeTruthy()
    expect('urgency' in reportRes).toBe(false)
    const md = reportRes.full_report_markdown
    expect(md).toContain('影像量化所见报告')
    // 只列实测值：高密度粘液栓、BAR、最高 CT 值、长径等
    expect(md).toContain('**高密度粘液栓**：可见（最高 94.5 HU）')
    expect(md).toContain('**支气管 / 伴行动脉径比 (BAR)**：1.84')
    expect(md).toContain('**最大长径**：7.2 mm')
    expect(md).toContain('血清总 IgE')
    expect(md).toContain('1560')
    // 记录里没有的测值不写，也不代入典型值（管径 8.5 / 5.8 mm、平均 38.6 HU）
    expect(md).not.toContain('支气管内径')
    expect(md).not.toMatch(/8\.5 mm|5\.8 mm|38\.6 HU/)
    // 不给诊断结论与治疗建议；检查方法不写死扫描参数
    expect(md).not.toMatch(/ABPA|曲霉|高度符合|确诊|抗真菌|气道廓清|复查|会诊|螺距|准直层厚|512×512/)
    expect(md).toContain('上述所见需结合临床与实验室检查判断')
    expect(md).not.toContain('NaN')
    expect(reportRes.recommendations).toBe('')

    // 验证新保存的病历记录
    const patientDetail = t.svc.read(a, patient.id)
    const savedRec = patientDetail.records.find(r => r.id === reportRes.saved_record_id)
    expect(savedRec).toBeTruthy()
    expect(savedRec?.kind).toBe('report')
    expect(savedRec?.status).toBe('confirmed')

    // 2. HTTP API 接口调用测试
    const { buildApi } = await import('../src/http/api.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { TurnService } = await import('../src/turns/service.ts')
    const { TurnRegistry } = await import('../src/mcp/turns.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')

    const docs = new Documents(t.store)
    const ops = new OpService(docs)
    const SECRET = 'test-secret'
    const accounts = new Accounts(t.store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' })
    const uRow = t.store.getUser(t.user)!
    const token = issueToken(SECRET, { u: t.user, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: uRow.token_version })

    const app = buildApi({
      docs,
      ops,
      turns: new TurnService(docs, {} as any, new TurnRegistry()),
      postcheck: new PostCheck(docs),
      crossref: {} as any,
      renderer: new SlideRenderer(t.root),
      accounts,
      devMode: false,
      devUser: 'dev',
      patients: t.svc,
    })

    const apiRes = await app.request(`/api/patients/${patient.id}/imaging/full-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        record_id: imgRec.record.id,
        save_to_records: false,
      }),
    })

    expect(apiRes.status).toBe(200)
    const apiData = await apiRes.json()
    expect(apiData.ok).toBe(true)
    expect(apiData.findings).toContain('高密度粘液栓')
    expect(apiData.impression).toBe('上述所见需结合临床与实验室检查判断。')
    expect(apiData.recommendations).toBe('')
  })

  it('12. HTTP API: POST /api/imaging/whole-body TotalSegmentator 全身体素 104 类分割与肌少症量化', async () => {
    const isOnline = await fetch('http://127.0.0.1:8004/health', { signal: AbortSignal.timeout(500) }).then(r => r.ok).catch(() => false)
    const t = env()
    const { buildApi } = await import('../src/http/api.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { TurnService } = await import('../src/turns/service.ts')
    const { TurnRegistry } = await import('../src/mcp/turns.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')

    const docs = new Documents(t.store)
    const ops = new OpService(docs)
    const SECRET = 'test-secret'
    const accounts = new Accounts(t.store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' })
    const uRow = t.store.getUser(t.user)!
    const token = issueToken(SECRET, { u: t.user, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: uRow.token_version })

    const app = buildApi({
      docs,
      ops,
      turns: new TurnService(docs, {} as any, new TurnRegistry()),
      postcheck: new PostCheck(docs),
      crossref: {} as any,
      renderer: new SlideRenderer(t.root),
      accounts,
      devMode: false,
      devUser: 'dev',
      patients: t.svc,
    })

    const res = await app.request('/api/imaging/whole-body', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sample_id: 'chest_lung_ct',
        patient_sex: 'M',
        patient_height_m: 1.75,
        patient_weight_kg: 70.0,
        save_asset: true,
        label: '图 8 L3 骨骼肌与多器官容积',
      }),
    })

    if (!isOnline) {
      expect(res.status).toBe(503)
      return
    }

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('success')
    expect(data.model_name).toBe('whole_body_ct_segmenter')
    expect(data.body_composition).toBeDefined()
    expect(data.body_composition.skeletal_muscle_index_cm2_m2).toBeGreaterThan(0)
    expect(data.organ_volumetry_cm3).toBeDefined()
    expect(data.organ_volumetry_cm3.liver).toBeGreaterThan(0)
    expect(data.asset_id).toBeDefined()
    expect(data.markdown_insert).toContain(`asset:${data.asset_id}`)
  })

  it('13. HTTP API: POST /api/imaging/mpr/slice 支持 custom_png_base64 复合手动卡尺与 ROI 标注保存资产', async () => {
    const isOnline = await fetch('http://127.0.0.1:8004/health', { signal: AbortSignal.timeout(500) }).then(r => r.ok).catch(() => false)
    const t = env()
    const { buildApi } = await import('../src/http/api.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { TurnService } = await import('../src/turns/service.ts')
    const { TurnRegistry } = await import('../src/mcp/turns.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')

    const docs = new Documents(t.store)
    const ops = new OpService(docs)
    const SECRET = 'test-secret'
    const accounts = new Accounts(t.store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' })
    const uRow = t.store.getUser(t.user)!
    const token = issueToken(SECRET, { u: t.user, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: uRow.token_version })

    const app = buildApi({
      docs,
      ops,
      turns: new TurnService(docs, {} as any, new TurnRegistry()),
      postcheck: new PostCheck(docs),
      crossref: {} as any,
      renderer: new SlideRenderer(t.root),
      accounts,
      devMode: false,
      devUser: 'dev',
      patients: t.svc,
    })

    // 1x1 base64 png
    const customB64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const label = 'P-001 MPR 轴位 第 32 层 (含手动测量卡尺)'

    const res = await app.request('/api/imaging/mpr/slice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sample_id: 'chest_lung_ct',
        plane: 'axial',
        slice_index: 32,
        window_preset: 'lung',
        overlay_mask: true,
        save_asset: true,
        label,
        custom_png_base64: customB64,
      }),
    })

    if (!isOnline) {
      expect(res.status).toBe(503)
      return
    }

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.asset_id).toBeDefined()
    expect(data.markdown_insert).toBe(`![${label}](asset:${data.asset_id})`)

    // 验证底层资产库保存的数据与客户端合成的图片二进制完全吻合
    const assetRow = t.store.getAsset(data.asset_id)
    expect(assetRow).toBeDefined()
    expect(assetRow!.mime).toBe('image/png')
    const rawExpectedBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    const assetBytes = t.store.getAssetBytes(data.asset_id)
    expect(Buffer.from(assetBytes!)).toEqual(rawExpectedBuf)
  })

  it('14. MPR 手动测量卡尺与 ROI 几何数学量化 (Caliper & ROI Geometry Math)', () => {
    // 模拟非各向同性体素间距 (hSp = 0.75 mm/px, vSp = 1.25 mm/px)
    const hSp = 0.75
    const vSp = 1.25

    // 1. 卡尺测距: (x1, y1) = (100, 100), (x2, y2) = (140, 130)
    const x1 = 100, y1 = 100
    const x2 = 140, y2 = 130
    const dxMm = (x2 - x1) * hSp // 40 * 0.75 = 30.0 mm
    const dyMm = (y2 - y1) * vSp // 30 * 1.25 = 37.5 mm
    const distanceMm = Math.hypot(dxMm, dyMm) // sqrt(900 + 1406.25) = sqrt(2306.25) ≈ 48.023 mm
    expect(Math.round(distanceMm * 10) / 10).toBe(48.0)

    // 2. ROI 矩形截面积: 宽 40px, 高 30px
    const wMm = Math.abs(x2 - x1) * hSp // 30.0 mm
    const hMm = Math.abs(y2 - y1) * vSp // 37.5 mm
    const areaMm2 = wMm * hMm // 1125.0 mm²
    const areaCm2 = areaMm2 / 100 // 11.25 cm²
    expect(Math.round(areaMm2 * 10) / 10).toBe(1125.0)
    expect(Math.round(areaCm2 * 100) / 100).toBe(11.25)
  })
})

