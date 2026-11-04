import { PatientError, type Actor } from '../tenancy/patients.ts'
import { GUIDELINE_PROVENANCE_LABEL } from './guideline-rules.ts'
import { ImagingError } from './studies.ts'

/**
 * CT 多病种扩展与急诊优先通道（PRD 第 5.4 节 / 第 8 节阶段三 T3.2–T3.4）：
 * - T3.2 胸部 CT 肺炎 / 间质病变定量（各肺叶磨玻璃/实变受累比例、CTSS 0–25 评分与结构化所见生成）；
 * - T3.3 胸部 CT 肋骨骨折检出、左右第 1–12 肋自动编号与新旧程度（急性 / 愈合期 / 陈旧性）判定；
 * - T3.4 头颅平扫 CT 急性脑出血（ICH）五分型、体积（体素积分与 ABC/2）、中线移位测量及急诊（stat，P90 ≤ 60s）优先队列。
 *
 * 安全红线（PRD 第 6 节）：
 * - 所有分级评分与危急值提醒均标注 `status_label: '规则推算，待医生确认'`；
 * - 脑出血危急值提醒须经当班医师人工确认后方可发出（confirmCriticalAlert 严禁 via === 'ai' 调用）。
 */

export const LOBE_CODES = ['RUL', 'RML', 'RLL', 'LUL', 'LLL'] as const
export type LobeCode = (typeof LOBE_CODES)[number]

export const LOBE_LABELS_ZH: Record<LobeCode, string> = {
  RUL: '右肺上叶',
  RML: '右肺中叶',
  RLL: '右肺下叶',
  LUL: '左肺上叶',
  LLL: '左肺下叶',
}

export interface LobePneumoniaInput {
  lobe_volume_cm3: number
  ggo_volume_cm3?: number
  consolidation_volume_cm3?: number
}

export interface LobePneumoniaMetrics {
  lobe_code: LobeCode
  lobe_name_zh: string
  lobe_volume_cm3: number
  ggo_volume_cm3: number
  consolidation_volume_cm3: number
  affected_volume_cm3: number
  ggo_pct: number
  consolidation_pct: number
  involvement_pct: number
  ctss_score: 0 | 1 | 2 | 3 | 4 | 5
}

export interface PneumoniaCtssResult {
  task: 'pneumonia_ild_ct'
  total_lung_volume_cm3: number
  total_ggo_volume_cm3: number
  total_consolidation_volume_cm3: number
  total_affected_volume_cm3: number
  total_involvement_pct: number
  total_ctss: number
  ctss_max: 25
  severity_reference: 'none' | 'mild' | 'moderate' | 'severe'
  status_label: typeof GUIDELINE_PROVENANCE_LABEL
  requires_confirmation: true
  lobes: Record<LobeCode, LobePneumoniaMetrics>
  findings_zh: string
}

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * 单肺叶 CT 严重度评分（CTSS，0–5 分）：
 * 0% -> 0；<5% -> 1；5%–25% -> 2；26%–49%（>25% 且 <50%）-> 3；50%–75% -> 4；>75% -> 5。
 */
export function computeLobeCtssScore(involvementPct: number): 0 | 1 | 2 | 3 | 4 | 5 {
  const pct = Math.max(0, Math.min(100, involvementPct))
  if (pct <= 0) return 0
  if (pct < 5) return 1
  if (pct <= 25) return 2
  if (pct < 50) return 3
  if (pct <= 75) return 4
  return 5
}

/**
 * T3.2 胸部 CT 肺炎 / 间质病变定量与 CTSS（0–25 分）评分。
 */
export function evaluatePneumoniaCtss(
  lobesInput: Partial<Record<LobeCode, LobePneumoniaInput>>,
): PneumoniaCtssResult {
  const lobes = {} as Record<LobeCode, LobePneumoniaMetrics>
  let totalLung = 0
  let totalGgo = 0
  let totalCons = 0
  let totalCtss = 0
  const affectedSentences: string[] = []

  for (const code of LOBE_CODES) {
    const raw = lobesInput[code] ?? { lobe_volume_cm3: 0, ggo_volume_cm3: 0, consolidation_volume_cm3: 0 }
    const lobeVol = Math.max(0, Number(raw.lobe_volume_cm3 ?? 0))
    const ggoVol = Math.max(0, Number(raw.ggo_volume_cm3 ?? 0))
    const consVol = Math.max(0, Number(raw.consolidation_volume_cm3 ?? 0))
    const affectedVol = Math.min(lobeVol, ggoVol + consVol)
    const invPct = lobeVol > 0 ? (affectedVol / lobeVol) * 100 : 0
    const ggoPct = lobeVol > 0 ? (ggoVol / lobeVol) * 100 : 0
    const consPct = lobeVol > 0 ? (consVol / lobeVol) * 100 : 0
    const score = computeLobeCtssScore(invPct)

    totalLung += lobeVol
    totalGgo += ggoVol
    totalCons += consVol
    totalCtss += score

    const metric: LobePneumoniaMetrics = {
      lobe_code: code,
      lobe_name_zh: LOBE_LABELS_ZH[code],
      lobe_volume_cm3: r2(lobeVol),
      ggo_volume_cm3: r2(ggoVol),
      consolidation_volume_cm3: r2(consVol),
      affected_volume_cm3: r2(affectedVol),
      ggo_pct: r2(ggoPct),
      consolidation_pct: r2(consPct),
      involvement_pct: r2(invPct),
      ctss_score: score,
    }
    lobes[code] = metric

    if (score > 0) {
      const patterns = [
        ggoVol > 0 ? '磨玻璃影' : '',
        consVol > 0 ? '实变影' : '',
      ].filter(Boolean).join('及')
      affectedSentences.push(`${metric.lobe_name_zh}见${patterns || '渗出影'}（受累约 ${metric.involvement_pct}%，CTSS ${score} 分）`)
    }
  }

  const totalAffected = Math.min(totalLung, totalGgo + totalCons)
  const totalInvPct = totalLung > 0 ? (totalAffected / totalLung) * 100 : 0
  const severity: PneumoniaCtssResult['severity_reference'] =
    totalCtss === 0 ? 'none' : totalCtss <= 7 ? 'mild' : totalCtss <= 17 ? 'moderate' : 'severe'

  const findingsZh = affectedSentences.length > 0
    ? `${affectedSentences.join('；')}。全肺累计受累比例约 ${r2(totalInvPct)}%，CT 严重度评分（CTSS）${totalCtss}/25 分（${GUIDELINE_PROVENANCE_LABEL}）。`
    : '双肺各叶未见明确肺炎磨玻璃或实变受累（CTSS 0/25 分）。'

  return {
    task: 'pneumonia_ild_ct',
    total_lung_volume_cm3: r2(totalLung),
    total_ggo_volume_cm3: r2(totalGgo),
    total_consolidation_volume_cm3: r2(totalCons),
    total_affected_volume_cm3: r2(totalAffected),
    total_involvement_pct: r2(totalInvPct),
    total_ctss: totalCtss,
    ctss_max: 25,
    severity_reference: severity,
    status_label: GUIDELINE_PROVENANCE_LABEL,
    requires_confirmation: true,
    lobes,
    findings_zh: findingsZh,
  }
}

// —— T3.3 胸部 CT 肋骨骨折检出、第 1–12 肋自动编号与新旧判定 ——

export type RibSide = 'right' | 'left'
export type RibArc = 'anterior' | 'lateral' | 'posterior'
export type RibFractureAcuity = 'acute' | 'subacute_healing' | 'chronic_old'

export interface RibFractureCandidateInput {
  fracture_id?: string
  side: RibSide
  rib_number: number
  anatomical_arc?: RibArc
  cortical_gap_mm: number
  callus_formation_ratio: number
  margin_sclerosis?: boolean
  displacement_mm?: number
  confidence?: number
  center_lps_mm?: [number, number, number]
}

export interface RibFractureItem {
  fracture_id: string
  side: RibSide
  side_zh: string
  rib_number: number
  anatomical_arc: RibArc
  anatomical_arc_zh: string
  location_code: string
  location_zh: string
  acuity: RibFractureAcuity
  acuity_zh: string
  cortical_gap_mm: number
  callus_formation_ratio: number
  displacement_mm: number
  displaced: boolean
  confidence: number
  center_lps_mm: [number, number, number]
}

export interface RibFractureAnalysisResult {
  task: 'rib_fracture_ct'
  counts: {
    total: number
    acute: number
    subacute_healing: number
    chronic_old: number
  }
  fractures: RibFractureItem[]
  findings_zh: string
}

export function classifyRibFractureAcuity(
  corticalGapMm: number,
  callusFormationRatio: number,
  marginSclerosis = false,
): RibFractureAcuity {
  if (corticalGapMm <= 0.1 || callusFormationRatio >= 0.85 || (marginSclerosis && callusFormationRatio >= 0.5)) {
    return 'chronic_old'
  }
  if (callusFormationRatio >= 0.15 || marginSclerosis) {
    return 'subacute_healing'
  }
  return 'acute'
}

export function evaluateRibFractures(
  candidates: RibFractureCandidateInput[],
  confidenceThreshold = 0.30,
): RibFractureAnalysisResult {
  const sideZh: Record<RibSide, string> = { right: '右侧', left: '左侧' }
  const arcZh: Record<RibArc, string> = { anterior: '前肋段', lateral: '腋段/侧肋段', posterior: '后肋段' }
  const acuityZh: Record<RibFractureAcuity, string> = {
    acute: '急性骨折',
    subacute_healing: '愈合期骨折（伴骨痂形成）',
    chronic_old: '陈旧性骨折',
  }
  const acuityRank: Record<RibFractureAcuity, number> = { acute: 1, subacute_healing: 2, chronic_old: 3 }

  const fractures: RibFractureItem[] = []
  candidates.forEach((c, idx) => {
    const conf = c.confidence ?? 0.9
    if (conf < confidenceThreshold) return
    if (c.side !== 'right' && c.side !== 'left') {
      throw new ImagingError('invalid_rib_side', `肋骨侧别须为 right 或 left，收到 ${String(c.side)}`, 400)
    }
    if (!Number.isInteger(c.rib_number) || c.rib_number < 1 || c.rib_number > 12) {
      throw new ImagingError('invalid_rib_number', `肋骨编号须为第 1–12 肋整数，收到 ${String(c.rib_number)}`, 400)
    }
    const arc: RibArc = c.anatomical_arc && ['anterior', 'lateral', 'posterior'].includes(c.anatomical_arc)
      ? c.anatomical_arc
      : 'lateral'
    const gap = r2(Math.max(0, c.cortical_gap_mm))
    const callus = r2(Math.max(0, Math.min(1, c.callus_formation_ratio)))
    const disp = r2(Math.max(0, c.displacement_mm ?? 0))
    const acuity = classifyRibFractureAcuity(gap, callus, Boolean(c.margin_sclerosis))

    fractures.push({
      fracture_id: c.fracture_id ?? `RF-${String(idx + 1).padStart(2, '0')}`,
      side: c.side,
      side_zh: sideZh[c.side],
      rib_number: c.rib_number,
      anatomical_arc: arc,
      anatomical_arc_zh: arcZh[arc],
      location_code: `${c.side === 'right' ? 'R' : 'L'}-Rib${c.rib_number}-${arc}`,
      location_zh: `${sideZh[c.side]}第 ${c.rib_number} 肋${arcZh[arc]}`,
      acuity,
      acuity_zh: acuityZh[acuity],
      cortical_gap_mm: gap,
      callus_formation_ratio: callus,
      displacement_mm: disp,
      displaced: disp >= 2.0,
      confidence: r2(conf),
      center_lps_mm: c.center_lps_mm ?? [0, 0, 0],
    })
  })

  fractures.sort((a, b) =>
    (a.side === b.side ? 0 : a.side === 'right' ? -1 : 1) ||
    a.rib_number - b.rib_number ||
    acuityRank[a.acuity] - acuityRank[b.acuity],
  )

  const counts = {
    total: fractures.length,
    acute: fractures.filter(f => f.acuity === 'acute').length,
    subacute_healing: fractures.filter(f => f.acuity === 'subacute_healing').length,
    chronic_old: fractures.filter(f => f.acuity === 'chronic_old').length,
  }

  const findingsZh = fractures.length > 0
    ? `${fractures.map((f, i) => `${i + 1}. ${f.location_zh}见${f.acuity_zh}${f.displaced ? '（断端错位）' : ''}`).join('；')}。`
    : '双侧第 1–12 肋骨骨质连续，未见明确急性或陈旧性骨折征象。'

  return {
    task: 'rib_fracture_ct',
    counts,
    fractures,
    findings_zh: findingsZh,
  }
}

// —— T3.4 头颅平扫 CT 急性脑出血检出、分型、体积/中线移位与急诊（stat）优先队列 ——

export type IchSubtype = 'intraparenchymal' | 'intraventricular' | 'subarachnoid' | 'epidural' | 'subdural'

export const ICH_SUBTYPE_LABELS_ZH: Record<IchSubtype, string> = {
  intraparenchymal: '脑实质出血（IPH）',
  intraventricular: '脑室出血（IVH）',
  subarachnoid: '蛛网膜下腔出血（SAH）',
  epidural: '硬膜外血肿（EDH）',
  subdural: '硬膜下血肿（SDH）',
}

export interface IchLesionInput {
  lesion_id?: string
  subtype: IchSubtype
  hemisphere?: 'left' | 'right' | 'bilateral' | 'midline'
  location_zh: string
  volume_ml?: number
  axis_a_mm?: number
  axis_b_mm?: number
  extent_c_mm?: number
  mean_hu?: number
}

export interface IchLesionResult {
  lesion_id: string
  subtype: IchSubtype
  subtype_zh: string
  hemisphere: 'left' | 'right' | 'bilateral' | 'midline'
  location_zh: string
  volume_ml: number
  abc2_volume_ml: number | null
  mean_hu: number
}

export interface HeadCtIchAnalysisResult {
  task: 'head_ich_ct'
  queue_priority: 'stat' | 'routine'
  p90_sla_seconds: number
  hemorrhage_detected: boolean
  subtypes_present: IchSubtype[]
  total_volume_ml: number
  midline_shift_mm: number
  significant_mass_effect: boolean
  /** 危急值提醒（须由当班医师确认后发出，AI 严禁直接发送危急值警报） */
  critical_alert_pending_confirmation: boolean
  critical_alert_confirmed_by: string | null
  critical_alert_confirmed_at: string | null
  status_label: typeof GUIDELINE_PROVENANCE_LABEL
  requires_confirmation: true
  lesions: IchLesionResult[]
  findings_zh: string
}

export function evaluateHeadCtIch(input: {
  hemorrhages: IchLesionInput[]
  midline_shift_mm?: number
  priority?: 'stat' | 'routine'
}): HeadCtIchAnalysisResult {
  const priority = input.priority ?? 'stat'
  const lesions: IchLesionResult[] = []
  const subtypesPresent: IchSubtype[] = []
  let totalVolumeMl = 0

  input.hemorrhages.forEach((h, idx) => {
    if (!Object.prototype.hasOwnProperty.call(ICH_SUBTYPE_LABELS_ZH, h.subtype)) {
      throw new ImagingError('invalid_ich_subtype', `不支持的脑出血分型：${String(h.subtype)}`, 400)
    }
    if (!subtypesPresent.includes(h.subtype)) subtypesPresent.push(h.subtype)

    const a = Number(h.axis_a_mm ?? 0)
    const b = Number(h.axis_b_mm ?? 0)
    const c = Number(h.extent_c_mm ?? 0)
    const abc2 = a > 0 && b > 0 && c > 0 ? r2((a * b * c) / 2000) : null
    const vol = r2(Math.max(0, Number(h.volume_ml ?? abc2 ?? 0)))
    totalVolumeMl += vol

    lesions.push({
      lesion_id: h.lesion_id ?? `ICH-${String(idx + 1).padStart(2, '0')}`,
      subtype: h.subtype,
      subtype_zh: ICH_SUBTYPE_LABELS_ZH[h.subtype],
      hemisphere: h.hemisphere ?? 'left',
      location_zh: h.location_zh.trim() || '脑内',
      volume_ml: vol,
      abc2_volume_ml: abc2,
      mean_hu: r2(Number(h.mean_hu ?? 62)),
    })
  })

  const mls = r2(Math.max(0, Number(input.midline_shift_mm ?? 0)))
  const totalVol = r2(totalVolumeMl)
  const significantMassEffect = mls >= 5.0 || totalVol >= 30.0
  const criticalPending =
    lesions.length > 0 &&
    (significantMassEffect || subtypesPresent.includes('intraventricular') || subtypesPresent.includes('epidural'))

  const findingsZh = lesions.length > 0
    ? `${lesions.map(l => `${l.location_zh}见${l.subtype_zh}（体积约 ${l.volume_ml} mL）`).join('；')}；累计出血量约 ${totalVol} mL，中线结构移位 ${mls} mm（${GUIDELINE_PROVENANCE_LABEL}）。`
    : `颅内脑实质、脑室及脑池未见明确高密度急性出血征象，中线结构居中（移位 ${mls} mm）。`

  return {
    task: 'head_ich_ct',
    queue_priority: priority,
    p90_sla_seconds: priority === 'stat' ? 60 : 300,
    hemorrhage_detected: lesions.length > 0,
    subtypes_present: subtypesPresent,
    total_volume_ml: totalVol,
    midline_shift_mm: mls,
    significant_mass_effect: significantMassEffect,
    critical_alert_pending_confirmation: criticalPending,
    critical_alert_confirmed_by: null,
    critical_alert_confirmed_at: null,
    status_label: GUIDELINE_PROVENANCE_LABEL,
    requires_confirmation: true,
    lesions,
    findings_zh: findingsZh,
  }
}

/**
 * 急诊脑出血危急值提醒人工确认（PRD 第 6 节安全边界：危急值必须先经当班医师确认，AI 一律禁止直接发危急值警报）。
 */
export function confirmIchCriticalAlert(
  a: Actor,
  result: HeadCtIchAnalysisResult,
  atIso: string = new Date().toISOString(),
): HeadCtIchAnalysisResult {
  if (a.via === 'ai') {
    throw new PatientError('forbidden', '危急值提醒必须由当班医师本人确认后发出，AI 禁止直接发送危急值警报', 403)
  }
  if (!result.hemorrhage_detected) {
    throw new ImagingError('no_hemorrhage', '当前检查未检出脑出血，无需触发危急值确认', 409)
  }
  return {
    ...result,
    critical_alert_pending_confirmation: false,
    critical_alert_confirmed_by: a.userId,
    critical_alert_confirmed_at: atIso,
  }
}

export interface EmergencyQueueItem {
  job_id: string
  study_id: string
  task: 'head_ich_ct' | 'rib_fracture_ct' | 'pneumonia_ild_ct' | 'lung_nodule'
  priority: 'stat' | 'routine'
  enqueued_at_ms: number
  completed_at_ms?: number
}

/**
 * T3.4 急诊优先队列调度器：
 * - stat 急诊任务（如头颅平扫 CT 脑出血）始终优先于 routine 常规平扫任务出队执行；
 * - 同一优先级内按入队时间 FIFO 排序；
 * - 统计急诊通道 P90 周转耗时并校验是否满足 ≤ 60s SLA。
 */
export class EmergencyStatQueue {
  private readonly queue: EmergencyQueueItem[] = []
  private readonly completedStatTurnaroundsSec: number[] = []

  enqueue(item: EmergencyQueueItem): void {
    this.queue.push({ ...item })
    this.queue.sort((a, b) => {
      const pA = a.priority === 'stat' ? 0 : 1
      const pB = b.priority === 'stat' ? 0 : 1
      return pA - pB || a.enqueued_at_ms - b.enqueued_at_ms
    })
  }

  dequeueNext(completedAtMs?: number): EmergencyQueueItem | null {
    const next = this.queue.shift() ?? null
    if (!next) return null
    if (completedAtMs !== undefined) {
      next.completed_at_ms = completedAtMs
      if (next.priority === 'stat') {
        const sec = Math.max(0, (completedAtMs - next.enqueued_at_ms) / 1000)
        this.completedStatTurnaroundsSec.push(sec)
      }
    }
    return next
  }

  slaReport(slaTargetSeconds = 60): {
    completed_stat_jobs: number
    p50_turnaround_seconds: number | null
    p90_turnaround_seconds: number | null
    sla_target_seconds: number
    sla_met: boolean
  } {
    if (!this.completedStatTurnaroundsSec.length) {
      return {
        completed_stat_jobs: 0,
        p50_turnaround_seconds: null,
        p90_turnaround_seconds: null,
        sla_target_seconds: slaTargetSeconds,
        sla_met: true,
      }
    }
    const sorted = [...this.completedStatTurnaroundsSec].sort((a, b) => a - b)
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!
    const p50 = r2(p(0.5))
    const p90 = r2(p(0.9))
    return {
      completed_stat_jobs: sorted.length,
      p50_turnaround_seconds: p50,
      p90_turnaround_seconds: p90,
      sla_target_seconds: slaTargetSeconds,
      sla_met: p90 <= slaTargetSeconds,
    }
  }
}
