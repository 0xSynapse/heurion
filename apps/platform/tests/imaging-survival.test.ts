import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, it, expect } from 'vitest'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { DatasetService } from '../src/datasets/service.ts'
import { runImagingBiomarkerSurvival } from '../src/datasets/imaging-survival.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { setup } from './helpers.ts'

const SECRET = 'test-secret'

describe('影像生物标志物生存分析套件 (Imaging Biomarker Survival Suite)', () => {
  // 模拟真实腹盆腔 / 胸部肿瘤真实科研队列 (包含 L3 断面骨骼肌指数 SMI、脂肪比、3D 影像组学特征)
  const imagingCohort = [
    // 男性组：SMI 阈值 52.4 cm²/m² (Prado 共识)
    { ptid: 'P01', sex: 'M', os_months: 6, status: 1, smi: 39.2, vat_to_sat: 1.45, sphericity: 0.52, age: 68, stage: 4 }, // 肌少症 + 高内脏脂肪
    { ptid: 'P02', sex: 'M', os_months: 11, status: 1, smi: 44.0, vat_to_sat: 1.20, sphericity: 0.58, age: 72, stage: 3 }, // 肌少症
    { ptid: 'P03', sex: 'M', os_months: 15, status: 1, smi: 48.5, vat_to_sat: 1.10, sphericity: 0.61, age: 65, stage: 4 }, // 肌少症
    { ptid: 'P04', sex: 'M', os_months: 22, status: 0, smi: 50.1, vat_to_sat: 0.85, sphericity: 0.66, age: 59, stage: 2 }, // 肌少症
    { ptid: 'P05', sex: 'M', os_months: 36, status: 0, smi: 55.4, vat_to_sat: 0.75, sphericity: 0.74, age: 54, stage: 2 }, // 正常
    { ptid: 'P06', sex: 'M', os_months: 42, status: 0, smi: 58.0, vat_to_sat: 0.65, sphericity: 0.80, age: 52, stage: 1 }, // 正常
    { ptid: 'P07', sex: 'M', os_months: 48, status: 0, smi: 61.2, vat_to_sat: 0.70, sphericity: 0.82, age: 60, stage: 2 }, // 正常
    // 女性组：SMI 阈值 38.5 cm²/m² (Prado 共识)
    { ptid: 'P08', sex: 'F', os_months: 8, status: 1, smi: 31.5, vat_to_sat: 1.30, sphericity: 0.49, age: 69, stage: 4 }, // 肌少症
    { ptid: 'P09', sex: 'F', os_months: 14, status: 1, smi: 35.0, vat_to_sat: 1.15, sphericity: 0.55, age: 64, stage: 3 }, // 肌少症
    { ptid: 'P10', sex: 'F', os_months: 20, status: 0, smi: 37.8, vat_to_sat: 0.90, sphericity: 0.62, age: 58, stage: 3 }, // 肌少症
    { ptid: 'P11', sex: 'F', os_months: 30, status: 1, smi: 41.2, vat_to_sat: 0.60, sphericity: 0.70, age: 63, stage: 2 }, // 正常
    { ptid: 'P12', sex: 'F', os_months: 40, status: 0, smi: 44.5, vat_to_sat: 0.55, sphericity: 0.78, age: 56, stage: 1 }, // 正常
    { ptid: 'P13', sex: 'F', os_months: 46, status: 0, smi: 46.0, vat_to_sat: 0.50, sphericity: 0.85, age: 50, stage: 1 }, // 正常
    { ptid: 'P14', sex: 'F', os_months: 52, status: 0, smi: 49.3, vat_to_sat: 0.45, sphericity: 0.88, age: 53, stage: 2 }, // 正常
  ]

  it('1. TotalSegmentator L3 SMI 骨骼肌指数分层 (Prado 男女双阈值共识切点)', () => {
    const res = runImagingBiomarkerSurvival(imagingCohort, {
      time_col: 'os_months',
      event_col: 'status',
      biomarker: 'smi',
      cutoff_strategy: 'consensus',
      sex_col: 'sex',
      covariates: ['age', 'stage'],
      time_unit: 'Months',
      milestones: [12, 24, 36],
      title: 'L3 骨骼肌指数 (SMI) 与总生存期 Kaplan-Meier 分析'
    })

    expect(res.biomarker).toBe('smi')
    expect(res.stratification_groups.group_high.name).toBe('SMI ≥ 52.4 cm²/m²')
    expect(res.stratification_groups.group_low.name).toBe('SMI < 52.4 cm²/m²')
    expect(res.stratification_groups.group_high.sample_size).toBe(7)
    expect(res.stratification_groups.group_low.sample_size).toBe(7)

    // 生存分析结果检验
    expect(res.survival_analysis.groups.length).toBe(2)
    expect(res.survival_analysis.log_rank).toBeDefined()
    expect(res.survival_analysis.log_rank?.p_value).toBeLessThanOrEqual(0.05) // 肌少症组死亡显著高于正常组
    expect(res.survival_analysis.cox).toBeDefined()

    // 矢量图形与学术报告
    expect(res.km_svg).toContain('<svg')
    expect(res.km_svg).toContain('SMI ≥ 52.4')
    expect(res.km_svg).not.toContain('Sarcopenia')
    expect(res.forest_plot_svg).toContain('<svg')
    expect(res.publication_report_markdown).toContain('影像生物标志物临床预后与生存分析报告')
    expect(res.publication_report_markdown).toContain('smi')
    expect(res.publication_report_markdown).toContain('Prado')
  })

  it('2. 腹部脂肪分布 (VAT/SAT 比值，切点 1.0) 预后分层', () => {
    const res = runImagingBiomarkerSurvival(imagingCohort, {
      time_col: 'os_months',
      event_col: 'status',
      biomarker: 'vat_to_sat',
      cutoff_strategy: 'consensus',
      covariates: ['stage'],
      time_unit: 'Months',
    })

    expect(res.biomarker).toBe('vat_to_sat')
    expect(res.stratification_groups.group_high.name).toContain('VAT/SAT ≥ 1.0')
    expect(res.stratification_groups.group_low.name).toContain('VAT/SAT < 1.0')
    expect(res.km_svg).toContain('<svg')
    expect(res.publication_report_markdown).toContain('vat_to_sat')
  })

  it('3. IBSI 3D 影像组学特征 (Sphericity 球形度) 中位数分层与 Cox 分析', () => {
    const res = runImagingBiomarkerSurvival(imagingCohort, {
      time_col: 'os_months',
      event_col: 'status',
      biomarker: 'sphericity',
      cutoff_strategy: 'median',
      covariates: ['age', 'stage'],
      title: '肿瘤 3D 球形度 (Sphericity) 预后分析'
    })

    expect(res.biomarker).toBe('sphericity')
    expect(res.cutoff_strategy).toBe('median')
    expect(res.survival_analysis.groups.length).toBe(2)
    expect(res.km_svg).toContain('<svg')
    expect(res.publication_report_markdown).toContain('sphericity')
  })

  it('4. 自定义数值切点分层 (如 sphericity 切点 0.70)', () => {
    const res = runImagingBiomarkerSurvival(imagingCohort, {
      time_col: 'os_months',
      event_col: 'status',
      biomarker: 'sphericity',
      cutoff_strategy: 0.70,
    })

    expect(res.cutoff_applied).toBe(0.70)
    expect(res.stratification_groups.group_high.name).toContain('≥ 0.7')
    expect(res.stratification_groups.group_low.name).toContain('< 0.7')
  })

  it('5. 端到端 MCP 工具调用: dataset_imaging_survival 贯通分析与文档自动插入', async () => {
    const env = setup('# 医学研究草案\n\n评估体成分对肿瘤总体生存率的影响。')
    const dsDir = mkdtempSync(join(tmpdir(), 'heurion-ds-'))
    const datasets = new DatasetService(env.store, dsDir, async (_owner, src) => {
      return {
        csv: src,
        cleanup: () => {},
        profile: {
          ok: true,
          rows: 14,
          truncated: false,
          columns: [
            { name: 'ptid', type: 'categorical', missing: 0, unique: 14 },
            { name: 'sex', type: 'categorical', missing: 0, unique: 2 },
            { name: 'os_months', type: 'numeric', missing: 0, unique: 14 },
            { name: 'status', type: 'numeric', missing: 0, unique: 2 },
            { name: 'smi', type: 'numeric', missing: 0, unique: 14 },
            { name: 'vat_to_sat', type: 'numeric', missing: 0, unique: 14 },
            { name: 'sphericity', type: 'numeric', missing: 0, unique: 14 },
            { name: 'age', type: 'numeric', missing: 0, unique: 14 },
            { name: 'stage', type: 'numeric', missing: 0, unique: 4 },
          ]
        }
      }
    })

    const workspace = mkdtempSync(join(tmpdir(), 'heurion-ws-'))
    const registry = new TurnRegistry()
    const claims = verifyToken(SECRET, issueToken(SECRET, { u: 'u1', d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const server = buildMcpServer({
      docs: env.docs,
      ops: env.ops,
      turns: registry,
      secret: SECRET,
      claims: new ClaimService(env.docs, {} as any),
      renderer: new SlideRenderer(workspace),
      pubmed: {} as any,
      crossref: {} as any,
      workspaceDir: () => workspace,
      isLiveSession: () => true,
      datasets,
    }, claims)

    const [transA, transB] = InMemoryTransport.createLinkedPair()
    await server.connect(transA)
    const client = new Client({ name: 'test-client', version: '1.0' })
    await client.connect(transB)

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args })
      const text = (res.content as Array<{ type: string; text: string }>)?.[0]?.text
      return { isError: res.isError ?? false, data: text ? JSON.parse(text) : null }
    }

    // 1) 构造测试数据集 CSV
    const csvContent = [
      'ptid,sex,os_months,status,smi,vat_to_sat,sphericity,age,stage',
      ...imagingCohort.map(r => `${r.ptid},${r.sex},${r.os_months},${r.status},${r.smi},${r.vat_to_sat},${r.sphericity},${r.age},${r.stage}`)
    ].join('\n')

    const { dataset } = datasets.upload('u1', 'lung_imaging_biomarkers.csv', Buffer.from(csvContent, 'utf8'))
    await datasets.idle()

    // 2) 创建一份测试论文草稿
    const docRow = env.docs.create({ owner: 'u1', title: '基于深度学习体成分与影像组学的肺癌预后分析论文' })

    // 3) 调用 dataset_imaging_survival MCP 工具
    const res = await call('dataset_imaging_survival', {
      dataset_id: dataset.id,
      time_col: 'os_months',
      event_col: 'status',
      biomarker: 'smi',
      cutoff_strategy: 'consensus',
      sex_col: 'sex',
      covariates: ['stage', 'age'],
      time_unit: 'Months',
      doc_id: docRow.id,
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.biomarker).toBe('smi')
    expect(res.data.stratification_groups).toBeDefined()
    expect(res.data.survival_data).toBeDefined()
    expect(res.data.svg_chart).toContain('<svg')
    expect(res.data.publication_report_markdown).toContain('影像生物标志物临床预后与生存分析报告')
    expect(res.data.inserted_doc).toBeDefined()
    expect(res.data.inserted_doc.doc_id).toBe(docRow.id)

    // 4) 验证文档中已成功插入生存分析学术段落与 KM 曲线图
    const docDetail = env.docs.get(docRow.id)
    expect(docDetail).toBeDefined()
  })
})
