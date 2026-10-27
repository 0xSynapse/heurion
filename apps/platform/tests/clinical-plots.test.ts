import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  generateGrottaPlot,
  generateLogisticRegression,
  generateSankeyDiagram,
  generateUpSetPlot,
} from '../src/datasets/clinical-plots.ts'
import { DatasetService } from '../src/datasets/service.ts'
import { Store } from '../src/store/db.ts'

const SAMPLE_AVM_RECORDS = [
  { id: '1', 第一次治疗方式: '手术切除', 治疗方式: '1', 栓塞策略: '0', 闭塞程度: '1', 治疗后出血: '0', 确诊时mRS: '0', 入院mrs评分: '1', 第一次治疗前mRS: '1', 供血动脉扩张: '1', 单一动脉供血: '1', 供血动脉数量: '1', 额叶: '1', 颞叶: '0', 顶叶: '0', 基底节: '0' },
  { id: '2', 第一次治疗方式: '手术切除', 治疗方式: '1', 栓塞策略: '0', 闭塞程度: '1', 治疗后出血: '0', 确诊时mRS: '0', 入院mrs评分: '0', 第一次治疗前mRS: '0', 供血动脉扩张: '0', 单一动脉供血: '1', 供血动脉数量: '1', 额叶: '1', 颞叶: '1', 顶叶: '0', 基底节: '0' },
  { id: '3', 第一次治疗方式: '介入栓塞', 治疗方式: '32', 栓塞策略: '2', 闭塞程度: '3', 治疗后出血: '1', 确诊时mRS: '1', 入院mrs评分: '2', 第一次治疗前mRS: '2', 供血动脉扩张: '1', 单一动脉供血: '0', 供血动脉数量: '4', 额叶: '0', 颞叶: '1', 顶叶: '1', 基底节: '1' },
  { id: '4', 第一次治疗方式: '介入栓塞', 治疗方式: '332', 栓塞策略: '2', 闭塞程度: '3', 治疗后出血: '1', 确诊时mRS: '1', 入院mrs评分: '2', 第一次治疗前mRS: '3', 供血动脉扩张: '1', 单一动脉供血: '0', 供血动脉数量: '5', 额叶: '0', 颞叶: '0', 顶叶: '1', 基底节: '1' },
  { id: '5', 第一次治疗方式: '伽玛刀', 治疗方式: '2', 栓塞策略: '0', 闭塞程度: '1', 治疗后出血: '0', 确诊时mRS: '0', 入院mrs评分: '1', 第一次治疗前mRS: '1', 供血动脉扩张: '0', 单一动脉供血: '1', 供血动脉数量: '2', 额叶: '1', 颞叶: '0', 顶叶: '0', 基底节: '0' },
  { id: '6', 第一次治疗方式: '保守治疗', 治疗方式: '0', 栓塞策略: '0', 闭塞程度: '0', 治疗后出血: '1', 确诊时mRS: '1', 入院mrs评分: '1', 第一次治疗前mRS: '2', 供血动脉扩张: '1', 单一动脉供血: '0', 供血动脉数量: '3', 额叶: '0', 颞叶: '0', 顶叶: '0', 基底节: '1' },
  { id: '7', 第一次治疗方式: '复合栓塞切除', 治疗方式: '31', 栓塞策略: '1', 闭塞程度: '1', 治疗后出血: '0', 确诊时mRS: '0', 入院mrs评分: '1', 第一次治疗前mRS: '1', 供血动脉扩张: '0', 单一动脉供血: '1', 供血动脉数量: '2', 额叶: '1', 颞叶: '0', 顶叶: '1', 基底节: '0' },
  { id: '8', 第一次治疗方式: '介入栓塞', 治疗方式: '3', 栓塞策略: '缺失', 闭塞程度: 'N', 治疗后出血: '0', 确诊时mRS: '0', 入院mrs评分: '1', 第一次治疗前mRS: '1', 供血动脉扩张: '缺失', 单一动脉供血: '0', 供血动脉数量: '3', 额叶: '0', 颞叶: '1', 顶叶: '0', 基底节: '0' },
]

describe('临床科研专科分析与出版级可视化套件 (clinical-plots)', () => {
  it('1. 二元结局单因素 + 多因素 Logistic 回归与 OR 森林图（支持 positive_value 指定阳性水平与剔除缺失值）', () => {
    const res = generateLogisticRegression(SAMPLE_AVM_RECORDS, {
      outcome_col: '闭塞程度',
      positive_value: '1', // 完全闭塞 vs 非完全闭塞
      covariates: ['单一动脉供血', '供血动脉数量'],
    })
    expect(res.sample_size).toBe(7) // 第 8 例闭塞程度为 'N' 自动剔除
    expect(res.events_count).toBe(4) // 4 例完全闭塞
    expect(res.covariates.length).toBe(2)
    expect(res.auc).toBeGreaterThanOrEqual(0.5)
    expect(res.svg).toContain('<svg')
    expect(res.svg).toContain('Adjusted OR (95% CI)')
    expect(res.markdown_table).toContain('Univariate OR (95% CI)')
    expect(res.native_exports.prism_pzfx).toContain('GraphPadPrismFile')
  })

  it('2. Grotta 100% 堆叠水平条形图（组间横向对比 + 多时间点 mRS 纵向迁移双模式）', () => {
    // 模式 A：按首次治疗方式对比闭塞程度
    const grpRes = generateGrottaPlot(SAMPLE_AVM_RECORDS, {
      group_col: '第一次治疗方式',
      score_col: '闭塞程度',
      labels: { '闭塞程度.1': '完全闭塞', '闭塞程度.3': '部分闭塞', '闭塞程度.0': '未闭塞' },
    })
    expect(grpRes.mode).toBe('group_comparison')
    expect(grpRes.bars.length).toBe(5)
    expect(grpRes.svg).toContain('<polygon') // 包含层间连接流带
    expect(grpRes.svg).toContain('完全闭塞')

    // 模式 B：纵向 mRS 评分演变
    const shiftRes = generateGrottaPlot(SAMPLE_AVM_RECORDS, {
      timepoint_cols: ['确诊时mRS', '入院mrs评分', '第一次治疗前mRS'],
    })
    expect(shiftRes.mode).toBe('longitudinal_shift')
    expect(shiftRes.bars.map(b => b.bar_key)).toEqual(['确诊时mRS', '入院mrs评分', '第一次治疗前mRS'])
    expect(shiftRes.shift_p).not.toBeNull()
  })

  it('3. 多阶段序贯治疗路径桑基图（支持多列 stage_cols 与单列多位数编码 sequence_col）', () => {
    const stageRes = generateSankeyDiagram(SAMPLE_AVM_RECORDS, {
      stage_cols: ['第一次治疗方式', '栓塞策略', '闭塞程度'],
    })
    expect(stageRes.total_n).toBe(7) // 剔除含 '缺失'/'N' 的第 8 例
    expect(stageRes.stages.length).toBe(3)
    expect(stageRes.links.length).toBeGreaterThan(0)
    expect(stageRes.svg).toContain('<path d="M ')

    const seqRes = generateSankeyDiagram(SAMPLE_AVM_RECORDS, {
      sequence_col: '治疗方式',
      outcome_col: '治疗后出血',
    })
    expect(seqRes.stages).toEqual(['首次干预 (Stage 1)', '二阶段序贯 (Stage 2)', '治疗后出血'])
    expect(seqRes.nodes.some(n => n.label.includes('序贯:'))).toBe(true)
  })

  it('4. 多脑区解剖共现交集图 UpSet Plot（单发 vs 跨脑叶联合受累 + 出血率叠加）', () => {
    const upsetRes = generateUpSetPlot(SAMPLE_AVM_RECORDS, {
      binary_cols: ['额叶', '颞叶', '顶叶', '基底节'],
      outcome_col: '治疗后出血',
    })
    expect(upsetRes.total_n).toBe(8)
    expect(upsetRes.single_region_n + upsetRes.multi_region_n).toBe(8)
    expect(upsetRes.regions.length).toBe(4)
    expect(upsetRes.intersections.length).toBeGreaterThan(0)
    expect(upsetRes.svg).toContain('Multi-region (≥2)')
  })

  it('5. DatasetService 端到端集成调用 logistic / grotta / sankey / upset', async () => {
    const store = new Store(':memory:')
    const dir = mkdtempSync(join(tmpdir(), 'heurion-clinical-plots-'))
    const csvFile = join(dir, 'avm.csv')
    const headers = Object.keys(SAMPLE_AVM_RECORDS[0]!)
    const lines = [
      headers.join(','),
      ...SAMPLE_AVM_RECORDS.map(r => headers.map(h => (r as Record<string, string>)[h] ?? '').join(',')),
    ]
    writeFileSync(csvFile, lines.join('\n'))

    const svc = new DatasetService(store, dir, async () => ({
      csv: csvFile,
      cleanup: () => {},
      profile: {
        ok: true,
        rows: SAMPLE_AVM_RECORDS.length,
        truncated: false,
        columns: headers.map(name => ({ name, type: 'categorical' as const, missing: 0, unique: 2 })),
      },
    }))

    try {
      const up = svc.upload('u1', 'avm.csv', new TextEncoder().encode('x'))
      await svc.idle()
      const id = up.dataset.id

      expect(svc.logistic('u1', id, { outcome_col: '治疗后出血', covariates: ['供血动脉数量'] }).covariates.length).toBe(1)
      expect(svc.grotta('u1', id, { timepoint_cols: ['确诊时mRS', '入院mrs评分'] }).bars.length).toBe(2)
      expect(svc.sankey('u1', id, { sequence_col: '治疗方式' }).total_n).toBe(8)
      expect(svc.upset('u1', id, { binary_cols: ['额叶', '颞叶', '顶叶'] }).regions.length).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
