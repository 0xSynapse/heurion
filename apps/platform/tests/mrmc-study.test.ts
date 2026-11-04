import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { MrmcStudyService, type MrmcCaseSpec } from '../src/imaging/mrmc-study.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'

/**
 * MRMC 多阅片者多病例交叉读片研究模式（PRD 第 7.2 节 / W7.3 / T3.7）单元测试：
 * 1. 两阶段平衡交叉分配（with_ai vs without_ai）、随机化顺序与盲法隔离（不暴露金标准）；
 * 2. 洗脱期强制门控（默认 28 天，未满洗脱期禁止进入 Period 2 读片）；
 * 3. 终点汇总分析：检出灵敏度（整体与大小亚组）、FP/case、单病例耗时缩短比例、观察者间径线标准差 SD 及标准 iMRMC 行导出。
 */

function setupMrmcEnv() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-mrmc-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const makeUser = (username: string, display_name: string) =>
    store.createUser({ username, display_name, password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const pi = makeUser('pi_wang', '王主任')
  const r1 = makeUser('dr_r1', '阅片医师 1')
  const r2 = makeUser('dr_r2', '阅片医师 2')
  const mrmc = new MrmcStudyService(patients)
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  return { store, tenants, patients, pi, r1, r2, mrmc, as }
}

const CASES: MrmcCaseSpec[] = [
  {
    case_id: 'CASE-01',
    ground_truth_lesions: [
      { gt_id: 'GT-1A', center_lps_mm: [10, 20, 30], mean_diameter_mm: 5.2, nodule_type: 'solid' },
      { gt_id: 'GT-1B', center_lps_mm: [-40, 15, -20], mean_diameter_mm: 9.4, nodule_type: 'part_solid' },
    ],
    ai_candidates: [
      { candidate_id: 'AI-1A', center_lps_mm: [10.2, 20.1, 30.0], mean_diameter_mm: 5.3, confidence_0_100: 88, nodule_type: 'solid' },
      { candidate_id: 'AI-1B', center_lps_mm: [-39.8, 15.1, -20.2], mean_diameter_mm: 9.5, confidence_0_100: 95, nodule_type: 'part_solid' },
    ],
  },
  {
    case_id: 'CASE-02',
    ground_truth_lesions: [
      { gt_id: 'GT-2A', center_lps_mm: [25, -10, 12], mean_diameter_mm: 6.8, nodule_type: 'pure_ggo' },
    ],
    ai_candidates: [
      { candidate_id: 'AI-2A', center_lps_mm: [25.1, -10.2, 12.0], mean_diameter_mm: 6.9, confidence_0_100: 91, nodule_type: 'pure_ggo' },
    ],
  },
]

const errCode = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (err) {
    return (err as { code?: string }).code ?? String(err)
  }
}

describe('T3.7 MRMC 多阅片者多病例交叉读片研究模式', () => {
  it('创建平衡交叉方案、盲法分发、强制 28 天洗脱期门控、汇总检出灵敏度/耗时/观察者间 SD', () => {
    const t = setupMrmcEnv()
    const PI = t.as(t.pi)
    const R1 = t.as(t.r1)
    const R2 = t.as(t.r2)

    // AI 禁止创建方案
    expect(errCode(() => t.mrmc.createProtocol(t.as(t.pi, 'ai'), {
      title: '胸部 CT 肺结节 MRMC 交叉验证',
      readers: [t.r1, t.r2],
      cases: CASES,
    }))).toBe('forbidden')

    const proto = t.mrmc.createProtocol(PI, {
      title: '胸部 CT 肺结节 MRMC 交叉验证',
      washout_days: 28,
      seed: 'heurion-mrmc-2026',
      readers: [t.r1, t.r2],
      cases: CASES,
    })
    expect(proto.cases_count).toBe(2)
    expect(proto.assignments_count).toBe(8) // 2 readers * 2 cases * 2 periods

    // 盲法任务检查：不含 ground_truth_lesions；without_ai 时 ai_candidates 为 null
    const nextR1 = t.mrmc.nextAssignment(R1, proto.protocol_id, t.r1, '2026-10-01T09:00:00Z')
    expect(nextR1.done).toBe(false)
    expect(nextR1.washout_active).toBe(false)
    expect(nextR1.assignment).not.toBeNull()
    expect((nextR1.assignment as unknown as Record<string, unknown>).ground_truth_lesions).toBeUndefined()
    if (nextR1.assignment!.modality === 'without_ai') {
      expect(nextR1.assignment!.ai_candidates).toBeNull()
    } else {
      expect(nextR1.assignment!.ai_candidates).not.toBeNull()
    }

    // 模拟两位阅片者完成 Period 1（2026-10-01）：
    // 在 without_ai 模式下漏检 <6 mm 小结节（GT-1A）、耗时较长（180s）、径线测量散度较大；
    // 在 with_ai 模式下检出全部结节、耗时较短（100s）、径线测量一致。
    const submitForReader = (actor: Actor, readerId: string, period: 1 | 2, dateStr: string) => {
      for (let step = 0; step < 2; step++) {
        const cur = t.mrmc.nextAssignment(actor, proto.protocol_id, readerId, dateStr)
        expect(cur.assignment?.period).toBe(period)
        const asg = cur.assignment!
        const isWithAi = asg.modality === 'with_ai'
        const isCase1 = asg.case_id === 'CASE-01'

        const findings = isCase1
          ? isWithAi
            ? [
                { center_lps_mm: [10.1, 20.0, 30.0] as [number, number, number], mean_diameter_mm: readerId === t.r1 ? 5.2 : 5.3, confidence_0_100: 90 },
                { center_lps_mm: [-40.0, 15.0, -20.0] as [number, number, number], mean_diameter_mm: readerId === t.r1 ? 9.4 : 9.5, confidence_0_100: 95 },
              ]
            : [
                // without_ai 漏检 5.2mm 小结节 GT-1A，只检出 9.4mm 结节且两位医师测量相差较大（8.8 vs 10.1）+ 1 个假阳性
                { center_lps_mm: [-40.0, 15.0, -20.0] as [number, number, number], mean_diameter_mm: readerId === t.r1 ? 8.8 : 10.1, confidence_0_100: 80 },
                { center_lps_mm: [50.0, 50.0, 50.0] as [number, number, number], mean_diameter_mm: 4.5, confidence_0_100: 60 },
              ]
          : isWithAi
            ? [
                { center_lps_mm: [25.0, -10.0, 12.0] as [number, number, number], mean_diameter_mm: readerId === t.r1 ? 6.8 : 6.9, confidence_0_100: 92 },
              ]
            : [
                { center_lps_mm: [25.0, -10.0, 12.0] as [number, number, number], mean_diameter_mm: readerId === t.r1 ? 6.2 : 7.5, confidence_0_100: 75 },
              ]

        t.mrmc.submitCaseReading(actor, proto.protocol_id, {
          reader_id: readerId,
          period,
          case_id: asg.case_id,
          elapsed_seconds: isWithAi ? (readerId === t.r1 ? 95 : 105) : (readerId === t.r1 ? 170 : 190),
          case_confidence_0_100: isWithAi ? 92 : 76,
          findings,
          completed_at: dateStr,
        })
      }
    }

    submitForReader(R1, t.r1, 1, '2026-10-01T10:00:00Z')
    submitForReader(R2, t.r2, 1, '2026-10-01T11:00:00Z')

    // 洗脱期校验：第 10 天（2026-10-11）请求下一任务时 washout_active = true，且强行提交 Period 2 被拒绝（washout_period_active）
    const duringWashout = t.mrmc.nextAssignment(R1, proto.protocol_id, t.r1, '2026-10-11T10:00:00Z')
    expect(duringWashout.washout_active).toBe(true)
    expect(duringWashout.remaining_washout_days).toBe(18)
    expect(duringWashout.assignment).toBeNull()

    expect(errCode(() => t.mrmc.submitCaseReading(R1, proto.protocol_id, {
      reader_id: t.r1,
      period: 2,
      case_id: 'CASE-01',
      elapsed_seconds: 100,
      case_confidence_0_100: 85,
      findings: [],
      completed_at: '2026-10-11T10:00:00Z',
    }))).toBe('washout_period_active')

    // 洗脱期满 28 天后（2026-10-30）：顺利完成 Period 2 交叉读片
    submitForReader(R1, t.r1, 2, '2026-10-30T10:00:00Z')
    submitForReader(R2, t.r2, 2, '2026-10-30T11:00:00Z')

    const afterAll = t.mrmc.nextAssignment(R1, proto.protocol_id, t.r1, '2026-10-31T10:00:00Z')
    expect(afterAll.done).toBe(true)

    // 汇总分析报告
    const report = t.mrmc.analyzeProtocol(PI, proto.protocol_id)
    expect(report.completed_readings).toBe(8)
    expect(report.expected_readings).toBe(8)

    // with_ai 灵敏度 1.0 > without_ai 灵敏度 0.6667（且 <6mm 亚组从 0 提升到 1.0）
    expect(report.with_ai.lesion_sensitivity).toBe(1)
    expect(report.without_ai.lesion_sensitivity).toBeCloseTo(0.6667, 3)
    expect(report.without_ai.sensitivity_by_size.lt_6mm).toBe(0)
    expect(report.with_ai.sensitivity_by_size.lt_6mm).toBe(1)
    expect(report.deltas.sensitivity_gain).toBeGreaterThan(0.3)

    // with_ai 平均阅片耗时 100s vs without_ai 180s（缩短 44.44%）
    expect(report.with_ai.mean_elapsed_seconds).toBe(100)
    expect(report.without_ai.mean_elapsed_seconds).toBe(180)
    expect(report.deltas.elapsed_time_reduction_pct).toBeCloseTo(44.44, 1)

    // 观察者间径线标准差：with_ai 显著小于 without_ai
    expect(report.with_ai.inter_reader_diameter_sd_mm!).toBeLessThan(report.without_ai.inter_reader_diameter_sd_mm!)
    expect(report.deltas.inter_reader_sd_diff_mm!).toBeLessThan(0)
    expect(report.mrmc_rows).toHaveLength(8)
  })
})
