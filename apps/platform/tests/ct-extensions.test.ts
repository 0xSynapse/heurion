import { describe, expect, it } from 'vitest'
import {
  computeLobeCtssScore,
  confirmIchCriticalAlert,
  EmergencyStatQueue,
  evaluateHeadCtIch,
  evaluatePneumoniaCtss,
  evaluateRibFractures,
} from '../src/imaging/ct-extensions.ts'

/**
 * CT 多病种扩展与急诊优先队列（PRD 第 5.4 节 / T3.2–T3.4）单元测试：
 * 1. T3.2：肺炎五肺叶受累比例、GGO/实变定量与 CTSS（0–25 分）评分；
 * 2. T3.3：肋骨骨折左右第 1–12 肋自动编号、解剖段定位与急性/愈合期/陈旧性判定；
 * 3. T3.4：头颅平扫 CT 急性脑出血五分型、体素/ABC2 体积、中线移位、危急值医师人工确认红线及急诊 stat 队列 P90 ≤ 60s SLA。
 */

describe('T3.2 胸部 CT 肺炎 / 间质病变定量与 CTSS 评分', () => {
  it('按五肺叶受累百分比计算单叶得分（0–5）与全肺 CTSS（0–25），并生成客观所见与「规则推算，待医生确认」标签', () => {
    expect(computeLobeCtssScore(0)).toBe(0)
    expect(computeLobeCtssScore(3.5)).toBe(1)
    expect(computeLobeCtssScore(15)).toBe(2)
    expect(computeLobeCtssScore(35)).toBe(3)
    expect(computeLobeCtssScore(60)).toBe(4)
    expect(computeLobeCtssScore(85)).toBe(5)

    const res = evaluatePneumoniaCtss({
      RUL: { lobe_volume_cm3: 1000, ggo_volume_cm3: 30, consolidation_volume_cm3: 0 }, // 3% -> 1
      RML: { lobe_volume_cm3: 500, ggo_volume_cm3: 0, consolidation_volume_cm3: 0 }, // 0% -> 0
      RLL: { lobe_volume_cm3: 1200, ggo_volume_cm3: 240, consolidation_volume_cm3: 120 }, // 30% -> 3
      LUL: { lobe_volume_cm3: 1000, ggo_volume_cm3: 100, consolidation_volume_cm3: 0 }, // 10% -> 2
      LLL: { lobe_volume_cm3: 1100, ggo_volume_cm3: 440, consolidation_volume_cm3: 220 }, // 60% -> 4
    })

    expect(res.total_ctss).toBe(10)
    expect(res.ctss_max).toBe(25)
    expect(res.severity_reference).toBe('moderate')
    expect(res.status_label).toBe('规则推算，待医生确认')
    expect(res.requires_confirmation).toBe(true)
    expect(res.lobes.RLL.involvement_pct).toBe(30)
    expect(res.lobes.RLL.ctss_score).toBe(3)
    expect(res.findings_zh).toContain('右肺下叶见磨玻璃影及实变影')
    expect(res.findings_zh).toContain('CT 严重度评分（CTSS）10/25 分（规则推算，待医生确认）')
  })
})

describe('T3.3 胸部 CT 肋骨骨折检出、第 1–12 肋编号与新旧判定', () => {
  it('自动编号左右第 1–12 肋，区分急性、愈合期与陈旧性骨折，并按右侧->左侧、肋骨序号排序', () => {
    const res = evaluateRibFractures([
      {
        side: 'left',
        rib_number: 8,
        anatomical_arc: 'posterior',
        cortical_gap_mm: 0.0,
        callus_formation_ratio: 0.92,
        margin_sclerosis: true,
        displacement_mm: 0.3,
      },
      {
        side: 'right',
        rib_number: 4,
        anatomical_arc: 'anterior',
        cortical_gap_mm: 1.6,
        callus_formation_ratio: 0.03,
        displacement_mm: 2.8,
      },
      {
        side: 'right',
        rib_number: 5,
        anatomical_arc: 'lateral',
        cortical_gap_mm: 0.7,
        callus_formation_ratio: 0.38,
        displacement_mm: 1.1,
      },
    ])

    expect(res.counts).toEqual({ total: 3, acute: 1, subacute_healing: 1, chronic_old: 1 })
    expect(res.fractures.map(f => f.location_code)).toEqual([
      'R-Rib4-anterior',
      'R-Rib5-lateral',
      'L-Rib8-posterior',
    ])
    expect(res.fractures[0]?.acuity).toBe('acute')
    expect(res.fractures[0]?.displaced).toBe(true)
    expect(res.fractures[1]?.acuity).toBe('subacute_healing')
    expect(res.fractures[2]?.acuity).toBe('chronic_old')
    expect(res.findings_zh).toContain('1. 右侧第 4 肋前肋段见急性骨折（断端错位）')
    expect(() => evaluateRibFractures([{ side: 'right', rib_number: 13, cortical_gap_mm: 1, callus_formation_ratio: 0 }])).toThrow(/1–12/)
  })
})

describe('T3.4 头颅平扫 CT 急性脑出血（ICH）分型、体积/中线移位与急诊优先队列', () => {
  it('计算脑出血分型、ABC/2 与体素体积、中线移位；危急值提醒须由当班医师确认（AI 禁止确认）', () => {
    const ich = evaluateHeadCtIch({
      hemorrhages: [
        {
          subtype: 'intraparenchymal',
          hemisphere: 'left',
          location_zh: '左侧基底节区',
          axis_a_mm: 42,
          axis_b_mm: 30,
          extent_c_mm: 32,
          volume_ml: 21.4,
          mean_hu: 65,
        },
        {
          subtype: 'intraventricular',
          hemisphere: 'bilateral',
          location_zh: '双侧侧脑室',
          volume_ml: 5.2,
          mean_hu: 58,
        },
      ],
      midline_shift_mm: 6.8,
      priority: 'stat',
    })

    expect(ich.queue_priority).toBe('stat')
    expect(ich.p90_sla_seconds).toBe(60)
    expect(ich.hemorrhage_detected).toBe(true)
    expect(ich.subtypes_present).toEqual(['intraparenchymal', 'intraventricular'])
    expect(ich.total_volume_ml).toBe(26.6)
    expect(ich.midline_shift_mm).toBe(6.8)
    expect(ich.significant_mass_effect).toBe(true)
    expect(ich.critical_alert_pending_confirmation).toBe(true)
    expect(ich.status_label).toBe('规则推算，待医生确认')

    // AI 尝试直接确认危急值警报 -> 403 拦截
    expect(() => confirmIchCriticalAlert({ userId: 'dr_duty', via: 'ai' }, ich)).toThrow(/AI 禁止直接发送危急值警报/)

    // 当班医师本人确认危急值
    const confirmed = confirmIchCriticalAlert({ userId: 'dr_duty', via: 'user' }, ich, '2026-11-04T12:00:00Z')
    expect(confirmed.critical_alert_pending_confirmation).toBe(false)
    expect(confirmed.critical_alert_confirmed_by).toBe('dr_duty')
  })

  it('急诊优先通道（EmergencyStatQueue）：stat 任务抢占 routine 任务优先执行，且校验 P90 ≤ 60s SLA', () => {
    const q = new EmergencyStatQueue()
    q.enqueue({ job_id: 'routine-1', study_id: 's1', task: 'lung_nodule', priority: 'routine', enqueued_at_ms: 1000 })
    q.enqueue({ job_id: 'routine-2', study_id: 's2', task: 'pneumonia_ild_ct', priority: 'routine', enqueued_at_ms: 2000 })
    q.enqueue({ job_id: 'stat-ich-1', study_id: 's3', task: 'head_ich_ct', priority: 'stat', enqueued_at_ms: 3000 })
    q.enqueue({ job_id: 'stat-ich-2', study_id: 's4', task: 'head_ich_ct', priority: 'stat', enqueued_at_ms: 4000 })

    // 两个急诊脑出血任务优先于更早入队的常规任务出队
    expect(q.dequeueNext(30_000)?.job_id).toBe('stat-ich-1') // 耗时 27s
    expect(q.dequeueNext(49_000)?.job_id).toBe('stat-ich-2') // 耗时 45s
    expect(q.dequeueNext(80_000)?.job_id).toBe('routine-1')
    expect(q.dequeueNext(95_000)?.job_id).toBe('routine-2')

    const sla = q.slaReport(60)
    expect(sla.completed_stat_jobs).toBe(2)
    expect(sla.p90_turnaround_seconds).toBe(45)
    expect(sla.sla_met).toBe(true)
  })
})
