import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { PatientError, type Actor, type PatientService } from '../tenancy/patients.ts'
import { ImagingError, lesionDistance } from './studies.ts'

/**
 * 多阅片者多病例（MRMC）交叉读片研究模式（PRD 第 7.2 节 / W7.3 / T3.7；docs/design/IMAGING_STUDIES.md「MRMC 读片研究（T3.7）」）。
 *
 * - 研究设计：两阶段平衡交叉设计（2-period balanced crossover）—— 每名阅片者（reader）在 Period 1 与 Period 2
 *   分别以「无 AI 辅助（without_ai）」与「有 AI 辅助（with_ai）」两种模式独立读完同一批病例；
 *   两阶段之间强制执行洗脱期门控（washout_days，默认 28 天 = 4 周），且两阶段病例顺序确定性伪随机打乱。
 * - 盲法隔离：阅片者获取待读任务（nextAssignment）时只看到盲法代号（blinded_case_code）与当前是否提供 AI 辅助，
 *   不暴露真实患者信息、检查日期、其他阅片者结论或参考金标准（ground_truth_lesions）。
 * - 终点汇总（analyzeProtocol）：
 *   1. 病灶级检出灵敏度（整体及 <6 mm、6–<8 mm、≥8 mm 分层）与每例假阳性数（FP/case）：with_ai vs without_ai；
 *   2. 单例阅片耗时（elapsed_seconds 均值、中位数与耗时变化百分比）；
 *   3. 观察者间测量变异（同一参考结节在不同阅片者间的平均径标准差 SD：with_ai vs without_ai）；
 *   4. 标准 iMRMC / RJafroc 导出表（mrmc_rows）。
 */

export type MrmcModality = 'without_ai' | 'with_ai'

export interface MrmcGroundTruthLesion {
  gt_id: string
  center_lps_mm: [number, number, number]
  mean_diameter_mm: number
  nodule_type?: 'solid' | 'part_solid' | 'pure_ggo' | string
}

export interface MrmcCaseSpec {
  case_id: string
  study_id?: string | null
  stratum?: string | null
  ground_truth_lesions: MrmcGroundTruthLesion[]
  ai_candidates?: Array<{
    candidate_id: string
    center_lps_mm: [number, number, number]
    mean_diameter_mm: number
    confidence_0_100: number
    nodule_type?: string
  }>
}

export interface MrmcReaderFinding {
  center_lps_mm: [number, number, number]
  mean_diameter_mm: number
  confidence_0_100: number
  nodule_type?: string
}

export interface MrmcAssignment {
  protocol_id: string
  reader_id: string
  period: 1 | 2
  sequence_index: number
  case_id: string
  blinded_case_code: string
  modality: MrmcModality
  ai_candidates: MrmcCaseSpec['ai_candidates'] | null
  completed_at: string | null
}

export interface MrmcReadingRecord {
  id: string
  protocol_id: string
  reader_id: string
  period: 1 | 2
  case_id: string
  modality: MrmcModality
  elapsed_seconds: number
  case_confidence_0_100: number
  findings: MrmcReaderFinding[]
  completed_at: string
}

export interface MrmcArmSummary {
  modality: MrmcModality
  readings_count: number
  lesion_sensitivity: number
  fp_per_case: number
  sensitivity_by_size: {
    lt_6mm: number | null
    btw_6_8mm: number | null
    gte_8mm: number | null
  }
  mean_elapsed_seconds: number
  median_elapsed_seconds: number
  inter_reader_diameter_sd_mm: number | null
}

export interface MrmcAnalysisReport {
  protocol_id: string
  title: string
  washout_days: number
  total_cases: number
  total_readers: number
  completed_readings: number
  expected_readings: number
  without_ai: MrmcArmSummary
  with_ai: MrmcArmSummary
  deltas: {
    sensitivity_gain: number
    fp_per_case_diff: number
    mean_elapsed_seconds_diff: number
    elapsed_time_reduction_pct: number
    inter_reader_sd_diff_mm: number | null
  }
  mrmc_rows: Array<{
    reader_id: string
    case_id: string
    modality: MrmcModality
    period: 1 | 2
    elapsed_seconds: number
    case_confidence_0_100: number
    tp_count: number
    fp_count: number
    fn_count: number
  }>
}

const now = () => new Date().toISOString()
const rid = (p: string) => p + randomUUID().replace(/-/g, '').slice(0, 12)
const r2 = (v: number) => Math.round(v * 100) / 100
const r4 = (v: number) => Math.round(v * 10000) / 10000

function deterministicShuffle<T>(items: readonly T[], seedKey: string): T[] {
  return [...items]
    .map((item, idx) => ({
      item,
      hash: createHash('sha256').update(`${seedKey}:${idx}`).digest('hex'),
    }))
    .sort((a, b) => a.hash.localeCompare(b.hash))
    .map(x => x.item)
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function sampleSd(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

const ready = new WeakSet<DatabaseSync>()

export function ensureMrmcSchema(db: DatabaseSync): void {
  if (ready.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS imaging_mrmc_protocols (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      washout_days INTEGER NOT NULL DEFAULT 28,
      seed TEXT NOT NULL,
      cases_json TEXT NOT NULL,
      readers_json TEXT NOT NULL,
      assignments_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS imaging_mrmc_readings (
      id TEXT PRIMARY KEY,
      protocol_id TEXT NOT NULL REFERENCES imaging_mrmc_protocols(id) ON DELETE CASCADE,
      reader_id TEXT NOT NULL,
      period INTEGER NOT NULL,
      case_id TEXT NOT NULL,
      modality TEXT NOT NULL,
      elapsed_seconds REAL NOT NULL,
      case_confidence_0_100 REAL NOT NULL,
      findings_json TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      UNIQUE (protocol_id, reader_id, period, case_id)
    );
    CREATE INDEX IF NOT EXISTS imaging_mrmc_readings_proto ON imaging_mrmc_readings (protocol_id, reader_id, period);
  `)
  ready.add(db)
}

export class MrmcStudyService {
  constructor(private readonly patients: PatientService) {}

  private db(a: Actor): DatabaseSync {
    const db = this.patients.imagingLookup(a).db
    ensureMrmcSchema(db)
    return db
  }

  /**
   * 创建 MRMC 两阶段平衡交叉读片研究方案（T3.7）：
   * - 为每位阅片者生成 Period 1 与 Period 2 的平衡交叉分配（Period 1 一半病例 with_ai、一半 without_ai，Period 2 翻转）；
   * - 每个阶段的病例呈现顺序按 reader + period + seed 独立伪随机打乱；
   * - 洗脱期默认 28 天（4 周）。
   */
  createProtocol(
    a: Actor,
    input: {
      title: string
      washout_days?: number
      seed?: string
      readers: string[]
      cases: MrmcCaseSpec[]
    },
  ): {
    protocol_id: string
    title: string
    washout_days: number
    readers: string[]
    cases_count: number
    assignments_count: number
  } {
    if (a.via === 'ai') throw new PatientError('forbidden', 'MRMC 读片研究方案须由研究负责人创建，AI 不能直接创建', 403)
    const db = this.db(a)
    const title = (input.title || '').trim()
    if (!title) throw new ImagingError('bad_title', 'MRMC 研究方案名称不能为空', 400)
    const washoutDays = input.washout_days ?? 28
    if (!Number.isInteger(washoutDays) || washoutDays < 0 || washoutDays > 365) {
      throw new ImagingError('bad_washout', '洗脱期天数（washout_days）须为 0–365 的整数（推荐 ≥ 28 天）', 400)
    }
    const readers = [...new Set(input.readers.map(r => r.trim()).filter(Boolean))]
    if (readers.length < 2) {
      throw new ImagingError('too_few_readers', 'MRMC 多阅片者研究至少需要 2 名阅片医师', 400)
    }
    if (!Array.isArray(input.cases) || input.cases.length < 2) {
      throw new ImagingError('too_few_cases', 'MRMC 研究至少需要 2 例测试病例', 400)
    }

    const seed = (input.seed || randomUUID()).trim()
    const protocolId = rid('mp')
    const assignments: Array<{
      reader_id: string
      period: 1 | 2
      sequence_index: number
      case_id: string
      blinded_case_code: string
      modality: MrmcModality
    }> = []

    readers.forEach((readerId, rIdx) => {
      // Period 1 顺序与平衡分组（奇偶阅片者互补，保证每例在 Period 1 既有 with_ai 也有 without_ai）
      const p1Order = deterministicShuffle(input.cases, `${seed}:r:${readerId}:p1`)
      const p1ModalityByCase = new Map<string, MrmcModality>()
      p1Order.forEach((c, idx) => {
        const modality: MrmcModality = (idx + rIdx) % 2 === 0 ? 'without_ai' : 'with_ai'
        p1ModalityByCase.set(c.case_id, modality)
        assignments.push({
          reader_id: readerId,
          period: 1,
          sequence_index: idx + 1,
          case_id: c.case_id,
          blinded_case_code: `P1-C${String(idx + 1).padStart(3, '0')}`,
          modality,
        })
      })

      // Period 2 顺序重新随机打乱，且每个病例的 AI 辅助条件与 Period 1 严格翻转（交叉设计）
      const p2Order = deterministicShuffle(input.cases, `${seed}:r:${readerId}:p2`)
      p2Order.forEach((c, idx) => {
        const p1Mod = p1ModalityByCase.get(c.case_id)!
        const p2Mod: MrmcModality = p1Mod === 'with_ai' ? 'without_ai' : 'with_ai'
        assignments.push({
          reader_id: readerId,
          period: 2,
          sequence_index: idx + 1,
          case_id: c.case_id,
          blinded_case_code: `P2-C${String(idx + 1).padStart(3, '0')}`,
          modality: p2Mod,
        })
      })
    })

    db.prepare(`
      INSERT INTO imaging_mrmc_protocols (
        id, title, washout_days, seed, cases_json, readers_json, assignments_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      protocolId,
      title,
      washoutDays,
      seed,
      JSON.stringify(input.cases),
      JSON.stringify(readers),
      JSON.stringify(assignments),
      a.userId,
      now(),
    )

    return {
      protocol_id: protocolId,
      title,
      washout_days: washoutDays,
      readers,
      cases_count: input.cases.length,
      assignments_count: assignments.length,
    }
  }

  /**
   * 获取阅片者的下一个盲法读片任务（不返回 ground_truth_lesions 等金标准信息；仅在 modality === 'with_ai' 时返回 AI 候选框）。
   * 若 Period 1 已全部完成但洗脱期尚未结束，返回 washout_active: true 与剩余天数。
   */
  nextAssignment(
    a: Actor,
    protocolId: string,
    readerId: string,
    atIso: string = now(),
  ): {
    done: boolean
    washout_active: boolean
    remaining_washout_days: number
    assignment: MrmcAssignment | null
  } {
    const db = this.db(a)
    const proto = db.prepare('SELECT * FROM imaging_mrmc_protocols WHERE id = ?').get(protocolId) as Record<string, unknown> | undefined
    if (!proto) throw new PatientError('not_found', 'MRMC 读片研究方案不存在', 404)

    const cases = JSON.parse(proto.cases_json as string) as MrmcCaseSpec[]
    const caseById = new Map(cases.map(c => [c.case_id, c]))
    const assignments = (JSON.parse(proto.assignments_json as string) as Array<{
      reader_id: string
      period: 1 | 2
      sequence_index: number
      case_id: string
      blinded_case_code: string
      modality: MrmcModality
    }>).filter(x => x.reader_id === readerId)

    if (!assignments.length) {
      throw new ImagingError('not_a_reader', `医师 ${readerId} 不在该 MRMC 研究的阅片名单中`, 403)
    }

    const completedRows = db.prepare(`
      SELECT period, case_id, completed_at
      FROM imaging_mrmc_readings
      WHERE protocol_id = ? AND reader_id = ?
    `).all(protocolId, readerId) as Array<{ period: number; case_id: string; completed_at: string }>

    const completedMap = new Map(completedRows.map(r => [`${r.period}:${r.case_id}`, r.completed_at]))

    const pendingP1 = assignments
      .filter(x => x.period === 1 && !completedMap.has(`1:${x.case_id}`))
      .sort((x, y) => x.sequence_index - y.sequence_index)

    if (pendingP1.length > 0) {
      const next = pendingP1[0]!
      const cSpec = caseById.get(next.case_id)
      return {
        done: false,
        washout_active: false,
        remaining_washout_days: 0,
        assignment: {
          protocol_id: protocolId,
          reader_id: readerId,
          period: 1,
          sequence_index: next.sequence_index,
          case_id: next.case_id,
          blinded_case_code: next.blinded_case_code,
          modality: next.modality,
          ai_candidates: next.modality === 'with_ai' ? (cSpec?.ai_candidates ?? []) : null,
          completed_at: null,
        },
      }
    }

    const pendingP2 = assignments
      .filter(x => x.period === 2 && !completedMap.has(`2:${x.case_id}`))
      .sort((x, y) => x.sequence_index - y.sequence_index)

    if (pendingP2.length === 0) {
      return { done: true, washout_active: false, remaining_washout_days: 0, assignment: null }
    }

    // 检查洗脱期（Period 1 最后一例完成时间至 atIso）
    const washoutDays = Number(proto.washout_days)
    const p1Times = completedRows
      .filter(r => r.period === 1)
      .map(r => Date.parse(r.completed_at))
      .filter(ms => Number.isFinite(ms))
    const lastP1Ms = p1Times.length ? Math.max(...p1Times) : 0
    const nowMs = Date.parse(atIso)
    const elapsedDays = (nowMs - lastP1Ms) / 86_400_000

    if (washoutDays > 0 && elapsedDays + 1e-6 < washoutDays) {
      return {
        done: false,
        washout_active: true,
        remaining_washout_days: r2(washoutDays - elapsedDays),
        assignment: null,
      }
    }

    const next = pendingP2[0]!
    const cSpec = caseById.get(next.case_id)
    return {
      done: false,
      washout_active: false,
      remaining_washout_days: 0,
      assignment: {
        protocol_id: protocolId,
        reader_id: readerId,
        period: 2,
        sequence_index: next.sequence_index,
        case_id: next.case_id,
        blinded_case_code: next.blinded_case_code,
        modality: next.modality,
        ai_candidates: next.modality === 'with_ai' ? (cSpec?.ai_candidates ?? []) : null,
        completed_at: null,
      },
    }
  }

  /**
   * 提交单病例 MRMC 读片结果（含检出病灶、置信度与单病例阅片耗时）。
   * - 强制校验洗脱期（Period 2 在洗脱期未满时提交拒绝 washout_period_active 409）；
   * - AI 一律不能代替人类阅片医师提交读片结果（403）。
   */
  submitCaseReading(
    a: Actor,
    protocolId: string,
    input: {
      reader_id?: string
      period: 1 | 2
      case_id: string
      elapsed_seconds: number
      case_confidence_0_100: number
      findings: MrmcReaderFinding[]
      completed_at?: string
    },
  ): MrmcReadingRecord {
    if (a.via === 'ai') throw new PatientError('forbidden', 'MRMC 读片记录须由阅片医师本人提交，AI 不能代读片', 403)
    const db = this.db(a)
    const proto = db.prepare('SELECT * FROM imaging_mrmc_protocols WHERE id = ?').get(protocolId) as Record<string, unknown> | undefined
    if (!proto) throw new PatientError('not_found', 'MRMC 读片研究方案不存在', 404)

    const readerId = input.reader_id ?? a.userId
    const assignments = JSON.parse(proto.assignments_json as string) as Array<{
      reader_id: string
      period: 1 | 2
      case_id: string
      modality: MrmcModality
    }>
    const assigned = assignments.find(x => x.reader_id === readerId && x.period === input.period && x.case_id === input.case_id)
    if (!assigned) {
      throw new ImagingError('assignment_not_found', `未找到医师 ${readerId} 在第 ${input.period} 阶段对病例 ${input.case_id} 的分配任务`, 404)
    }
    if (!Number.isFinite(input.elapsed_seconds) || input.elapsed_seconds <= 0) {
      throw new ImagingError('invalid_elapsed_seconds', '单病例阅片耗时（elapsed_seconds）须为正数', 400)
    }

    const completedAt = input.completed_at ?? now()

    if (input.period === 2) {
      const p1Count = assignments.filter(x => x.reader_id === readerId && x.period === 1).length
      const p1Done = db.prepare('SELECT completed_at FROM imaging_mrmc_readings WHERE protocol_id = ? AND reader_id = ? AND period = 1')
        .all(protocolId, readerId) as Array<{ completed_at: string }>
      if (p1Done.length < p1Count) {
        throw new ImagingError('period1_incomplete', '请先完成第 1 阶段（Period 1）全部病例读片，再进入第 2 阶段', 409)
      }
      const washoutDays = Number(proto.washout_days)
      const lastP1Ms = Math.max(...p1Done.map(r => Date.parse(r.completed_at)))
      const elapsedDays = (Date.parse(completedAt) - lastP1Ms) / 86_400_000
      if (washoutDays > 0 && elapsedDays + 1e-6 < washoutDays) {
        throw new ImagingError(
          'washout_period_active',
          `第 1 阶段与第 2 阶段之间须间隔至少 ${washoutDays} 天洗脱期（当前仅过去 ${r2(elapsedDays)} 天）`,
          409,
        )
      }
    }

    const id = rid('mr')
    db.prepare(`
      INSERT INTO imaging_mrmc_readings (
        id, protocol_id, reader_id, period, case_id, modality,
        elapsed_seconds, case_confidence_0_100, findings_json, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(protocol_id, reader_id, period, case_id) DO UPDATE SET
        elapsed_seconds = excluded.elapsed_seconds,
        case_confidence_0_100 = excluded.case_confidence_0_100,
        findings_json = excluded.findings_json,
        completed_at = excluded.completed_at
    `).run(
      id,
      protocolId,
      readerId,
      input.period,
      input.case_id,
      assigned.modality,
      r2(input.elapsed_seconds),
      r2(input.case_confidence_0_100),
      JSON.stringify(input.findings ?? []),
      completedAt,
    )

    return {
      id,
      protocol_id: protocolId,
      reader_id: readerId,
      period: input.period,
      case_id: input.case_id,
      modality: assigned.modality,
      elapsed_seconds: r2(input.elapsed_seconds),
      case_confidence_0_100: r2(input.case_confidence_0_100),
      findings: input.findings ?? [],
      completed_at: completedAt,
    }
  }

  /**
   * 汇总分析 MRMC 读片研究终点（with_ai vs without_ai 病灶级灵敏度、大小亚组灵敏度、FP/case、单病例阅片耗时及观察者间径线一致性）。
   */
  analyzeProtocol(a: Actor, protocolId: string): MrmcAnalysisReport {
    const db = this.db(a)
    const proto = db.prepare('SELECT * FROM imaging_mrmc_protocols WHERE id = ?').get(protocolId) as Record<string, unknown> | undefined
    if (!proto) throw new PatientError('not_found', 'MRMC 读片研究方案不存在', 404)

    const cases = JSON.parse(proto.cases_json as string) as MrmcCaseSpec[]
    const readers = JSON.parse(proto.readers_json as string) as string[]
    const caseById = new Map(cases.map(c => [c.case_id, c]))

    const rawReadings = db.prepare('SELECT * FROM imaging_mrmc_readings WHERE protocol_id = ? ORDER BY period, reader_id, case_id')
      .all(protocolId) as Array<Record<string, unknown>>

    const mrmcRows: MrmcAnalysisReport['mrmc_rows'] = []

    interface MatchedReading {
      modality: MrmcModality
      reader_id: string
      case_id: string
      period: 1 | 2
      elapsed_seconds: number
      case_confidence_0_100: number
      tp_gt_ids: Set<string>
      fp_count: number
      matched_diameters_by_gt: Map<string, number>
    }

    const evaluated: MatchedReading[] = []

    for (const r of rawReadings) {
      const caseId = r.case_id as string
      const cSpec = caseById.get(caseId)
      if (!cSpec) continue
      const gts = cSpec.ground_truth_lesions ?? []
      const findings = JSON.parse(r.findings_json as string) as MrmcReaderFinding[]

      // 按中心距离贪心匹配（<= max(3mm, gt_radius)）
      const pairs: Array<{ fIdx: number; gIdx: number; d: number }> = []
      findings.forEach((f, fIdx) => {
        gts.forEach((g, gIdx) => {
          const dist = lesionDistance(
            { center_lps_mm: f.center_lps_mm, mean_diameter_mm: f.mean_diameter_mm },
            { center_lps_mm: g.center_lps_mm, mean_diameter_mm: g.mean_diameter_mm },
          )
          if (dist && dist.d <= dist.radius) {
            pairs.push({ fIdx, gIdx, d: dist.d })
          }
        })
      })
      pairs.sort((x, y) => x.d - y.d)

      const usedF = new Set<number>()
      const usedG = new Set<number>()
      const tpGtIds = new Set<string>()
      const matchedDiameters = new Map<string, number>()

      for (const p of pairs) {
        if (usedF.has(p.fIdx) || usedG.has(p.gIdx)) continue
        usedF.add(p.fIdx)
        usedG.add(p.gIdx)
        const gt = gts[p.gIdx]!
        const fd = findings[p.fIdx]!
        tpGtIds.add(gt.gt_id)
        matchedDiameters.set(gt.gt_id, fd.mean_diameter_mm)
      }

      const fpCount = findings.length - usedF.size
      const fnCount = gts.length - usedG.size
      const modality = r.modality as MrmcModality
      const period = Number(r.period) as 1 | 2
      const elapsed = Number(r.elapsed_seconds)
      const conf = Number(r.case_confidence_0_100)

      mrmcRows.push({
        reader_id: r.reader_id as string,
        case_id: caseId,
        modality,
        period,
        elapsed_seconds: elapsed,
        case_confidence_0_100: conf,
        tp_count: tpGtIds.size,
        fp_count: fpCount,
        fn_count: fnCount,
      })

      evaluated.push({
        modality,
        reader_id: r.reader_id as string,
        case_id: caseId,
        period,
        elapsed_seconds: elapsed,
        case_confidence_0_100: conf,
        tp_gt_ids: tpGtIds,
        fp_count: fpCount,
        matched_diameters_by_gt: matchedDiameters,
      })
    }

    const summarizeArm = (modality: MrmcModality): MrmcArmSummary => {
      const arm = evaluated.filter(e => e.modality === modality)
      if (!arm.length) {
        return {
          modality,
          readings_count: 0,
          lesion_sensitivity: 0,
          fp_per_case: 0,
          sensitivity_by_size: { lt_6mm: null, btw_6_8mm: null, gte_8mm: null },
          mean_elapsed_seconds: 0,
          median_elapsed_seconds: 0,
          inter_reader_diameter_sd_mm: null,
        }
      }

      let totalGt = 0
      let totalTp = 0
      let totalFp = 0
      const sizeCounts = {
        lt_6mm: { gt: 0, tp: 0 },
        btw_6_8mm: { gt: 0, tp: 0 },
        gte_8mm: { gt: 0, tp: 0 },
      }
      const diametersByGtKey = new Map<string, number[]>()

      for (const e of arm) {
        const gts = caseById.get(e.case_id)?.ground_truth_lesions ?? []
        totalFp += e.fp_count
        for (const g of gts) {
          totalGt++
          const hit = e.tp_gt_ids.has(g.gt_id)
          if (hit) totalTp++
          const bucket = g.mean_diameter_mm < 6 ? 'lt_6mm' : g.mean_diameter_mm < 8 ? 'btw_6_8mm' : 'gte_8mm'
          sizeCounts[bucket].gt++
          if (hit) sizeCounts[bucket].tp++

          const dVal = e.matched_diameters_by_gt.get(g.gt_id)
          if (dVal !== undefined) {
            const key = `${e.case_id}:${g.gt_id}`
            const list = diametersByGtKey.get(key) ?? []
            list.push(dVal)
            diametersByGtKey.set(key, list)
          }
        }
      }

      const sds: number[] = []
      for (const list of diametersByGtKey.values()) {
        const sd = sampleSd(list)
        if (sd !== null) sds.push(sd)
      }

      const elapsedList = arm.map(x => x.elapsed_seconds)
      const meanElapsed = elapsedList.reduce((a, b) => a + b, 0) / elapsedList.length

      return {
        modality,
        readings_count: arm.length,
        lesion_sensitivity: totalGt > 0 ? r4(totalTp / totalGt) : 0,
        fp_per_case: r4(totalFp / arm.length),
        sensitivity_by_size: {
          lt_6mm: sizeCounts.lt_6mm.gt > 0 ? r4(sizeCounts.lt_6mm.tp / sizeCounts.lt_6mm.gt) : null,
          btw_6_8mm: sizeCounts.btw_6_8mm.gt > 0 ? r4(sizeCounts.btw_6_8mm.tp / sizeCounts.btw_6_8mm.gt) : null,
          gte_8mm: sizeCounts.gte_8mm.gt > 0 ? r4(sizeCounts.gte_8mm.tp / sizeCounts.gte_8mm.gt) : null,
        },
        mean_elapsed_seconds: r2(meanElapsed),
        median_elapsed_seconds: r2(median(elapsedList)),
        inter_reader_diameter_sd_mm: sds.length > 0 ? r4(sds.reduce((a, b) => a + b, 0) / sds.length) : null,
      }
    }

    const withoutAi = summarizeArm('without_ai')
    const withAi = summarizeArm('with_ai')
    const meanTimeDiff = r2(withAi.mean_elapsed_seconds - withoutAi.mean_elapsed_seconds)
    const reductionPct = withoutAi.mean_elapsed_seconds > 0
      ? r2(((withoutAi.mean_elapsed_seconds - withAi.mean_elapsed_seconds) / withoutAi.mean_elapsed_seconds) * 100)
      : 0
    const sdDiff =
      withAi.inter_reader_diameter_sd_mm !== null && withoutAi.inter_reader_diameter_sd_mm !== null
        ? r4(withAi.inter_reader_diameter_sd_mm - withoutAi.inter_reader_diameter_sd_mm)
        : null

    return {
      protocol_id: protocolId,
      title: proto.title as string,
      washout_days: Number(proto.washout_days),
      total_cases: cases.length,
      total_readers: readers.length,
      completed_readings: rawReadings.length,
      expected_readings: cases.length * readers.length * 2,
      without_ai: withoutAi,
      with_ai: withAi,
      deltas: {
        sensitivity_gain: r4(withAi.lesion_sensitivity - withoutAi.lesion_sensitivity),
        fp_per_case_diff: r4(withAi.fp_per_case - withoutAi.fp_per_case),
        mean_elapsed_seconds_diff: meanTimeDiff,
        elapsed_time_reduction_pct: reductionPct,
        inter_reader_sd_diff_mm: sdDiff,
      },
      mrmc_rows: mrmcRows,
    }
  }
}
