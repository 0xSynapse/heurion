/**
 * PACS 自动转发接收与序列自动分流服务（PRD W1.1–W1.2, T3.8）。
 *
 * 设计要点：
 * 1. 默认安全关闭（DicomServerEnabled = false）：仅在院内部署配置了共享密钥与 AE Title / IP 白名单后开启。
 * 2. W1.1 C-STORE / Orthanc StableSeries 回调鉴权：校验 Webhook Secret、来源 Calling AE Title 与来源 IP 白名单。
 * 3. W1.2 序列自动过滤与部位分流：
 *    - 自动跳过非 CT、定位像（scout/localizer 或层数 < 30）及超厚层序列（胸部 > 2.5 mm、头颅 > 5.0 mm）；
 *    - 自动识别胸部 CT（分流至 lung_nodule 等任务）与头颅平扫 CT（分流至 head_ich_ct，急诊/卒中/外伤自动升为 stat 优先通道 P90 <= 60s）；
 *    - 部位不明时只建索引、不盲目启动推理，标记 needs_region_confirmation 等待医生确认。
 */

import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export interface PacsForwardConfig {
  enabled: boolean
  webhookSecret: string
  allowedAeTitles: string[]
  allowedRemoteIps: string[]
}

export interface PacsSeriesWebhookPayload {
  study_instance_uid: string
  series_instance_uid: string
  orthanc_study_id?: string | null
  orthanc_series_id?: string | null
  patient_id?: string | null
  modality: string
  body_part_examined?: string | null
  study_description?: string | null
  series_description?: string | null
  protocol_name?: string | null
  image_type?: string[] | string | null
  slice_thickness_mm?: number | null
  num_instances: number
  convolution_kernel?: string | null
  calling_aet: string
  remote_ip: string
  is_emergency?: boolean
}

export interface PacsRoutingDecision {
  event_id: string
  study_instance_uid: string
  series_instance_uid: string
  calling_aet: string
  remote_ip: string
  accepted: boolean
  skip_reason: string | null
  detected_region: 'chest' | 'head' | 'other' | 'unknown'
  routed_tasks: Array<'lung_nodule' | 'pneumonia_ild_ct' | 'rib_fracture_ct' | 'head_ich_ct'>
  queue_priority: 'stat' | 'urgent' | 'routine' | null
  p90_sla_seconds: number | null
  needs_region_confirmation: boolean
  created_at: string
}

export class PacsForwardError extends Error {
  readonly code: string
  readonly status: 400 | 401 | 403 | 409 | 422
  constructor(code: string, message: string, status: 400 | 401 | 403 | 409 | 422 = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const LOCALIZER_RE = /localizer|scout|topogram|surview|scanogram|定位/i
const CHEST_RE = /chest|thorax|lung|pulmo|hrct|rib|胸|肺|肋/i
const HEAD_RE = /head|brain|cranial|skull|ich|stroke|头|颅|脑/i
const OTHER_REGION_RE = /abdomen|pelvis|spine|lumbar|cervical|knee|shoulder|腹|盆|脊柱|颈椎|腰椎|膝/i
const EMERGENCY_RE = /stat|emerg|urgent|trauma|stroke|ich|急诊|卒中|外伤|脑出血|胸痛/i
const RIB_TRAUMA_RE = /rib|fracture|trauma|肋|骨折|外伤/i
const PNEUMONIA_RE = /pneumonia|infection|ild|covid|ggo|肺炎|感染|间质/i

export class PacsForwardService {
  private readonly db: DatabaseSync
  private config: PacsForwardConfig

  constructor(db: DatabaseSync, config?: Partial<PacsForwardConfig>) {
    this.db = db
    this.config = {
      enabled: config?.enabled ?? (process.env.IMAGING_PACS_FORWARD_ENABLED === '1'),
      webhookSecret: config?.webhookSecret ?? (process.env.ORTHANC_WEBHOOK_SECRET ?? ''),
      allowedAeTitles: config?.allowedAeTitles ?? (process.env.IMAGING_PACS_ALLOWED_AETS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
      allowedRemoteIps: config?.allowedRemoteIps ?? (process.env.IMAGING_PACS_ALLOWED_IPS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
    }
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS imaging_pacs_events (
        id TEXT PRIMARY KEY,
        study_instance_uid TEXT NOT NULL,
        series_instance_uid TEXT NOT NULL,
        calling_aet TEXT NOT NULL,
        remote_ip TEXT NOT NULL,
        accepted INTEGER NOT NULL,
        skip_reason TEXT,
        detected_region TEXT NOT NULL,
        routed_tasks_json TEXT NOT NULL,
        queue_priority TEXT,
        p90_sla_seconds INTEGER,
        needs_region_confirmation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pacs_events_study ON imaging_pacs_events(study_instance_uid);
    `)
  }

  configure(next: Partial<PacsForwardConfig>): PacsForwardConfig {
    this.config = { ...this.config, ...next }
    return { ...this.config }
  }

  getConfig(): Omit<PacsForwardConfig, 'webhookSecret'> & { hasSecret: boolean } {
    return {
      enabled: this.config.enabled,
      hasSecret: Boolean(this.config.webhookSecret),
      allowedAeTitles: [...this.config.allowedAeTitles],
      allowedRemoteIps: [...this.config.allowedRemoteIps],
    }
  }

  /**
   * 处理 Orthanc C-STORE StableSeries 自动转发回调（W1.1 + W1.2）。
   */
  handleStableSeriesWebhook(secretHeader: string | undefined | null, payload: PacsSeriesWebhookPayload): PacsRoutingDecision {
    if (!this.config.enabled) {
      throw new PacsForwardError('pacs_forward_disabled', 'PACS 自动转发（C-STORE）当前未启用（默认保持关闭）', 403)
    }
    if (!this.config.webhookSecret || secretHeader !== this.config.webhookSecret) {
      throw new PacsForwardError('webhook_secret_invalid', 'Orthanc Webhook 密钥校验失败', 401)
    }
    const aet = (payload.calling_aet ?? '').trim()
    const ip = (payload.remote_ip ?? '').trim()
    if (!aet) {
      throw new PacsForwardError('missing_calling_aet', '缺少来源 PACS Calling AE Title', 400)
    }
    if (this.config.allowedAeTitles.length > 0 && !this.config.allowedAeTitles.includes(aet)) {
      throw new PacsForwardError('aet_not_allowed', `来源 AE Title (${aet}) 不在医院信息科许可白名单内`, 403)
    }
    if (this.config.allowedRemoteIps.length > 0 && !this.config.allowedRemoteIps.includes(ip)) {
      throw new PacsForwardError('ip_not_allowed', `来源 IP (${ip}) 不在医院信息科许可白名单内`, 403)
    }
    if (!payload.study_instance_uid || !payload.series_instance_uid) {
      throw new PacsForwardError('missing_uids', '缺少 StudyInstanceUID 或 SeriesInstanceUID', 400)
    }

    const modality = (payload.modality ?? '').trim().toUpperCase()
    const textCombined = [
      payload.body_part_examined ?? '',
      payload.study_description ?? '',
      payload.series_description ?? '',
      payload.protocol_name ?? '',
    ].join(' ')
    const imageTypeStr = Array.isArray(payload.image_type)
      ? payload.image_type.join(' ')
      : String(payload.image_type ?? '')

    const detectRegion = (): 'chest' | 'head' | 'other' | 'unknown' => {
      if (HEAD_RE.test(textCombined)) return 'head'
      if (CHEST_RE.test(textCombined)) return 'chest'
      if (OTHER_REGION_RE.test(textCombined)) return 'other'
      return 'unknown'
    }

    const region = detectRegion()
    const isEmergency = Boolean(payload.is_emergency || EMERGENCY_RE.test(textCombined))
    const numInstances = Number(payload.num_instances ?? 0)
    const thickness = payload.slice_thickness_mm != null ? Number(payload.slice_thickness_mm) : null

    let accepted = false
    let skipReason: string | null = null
    const routedTasks: Array<'lung_nodule' | 'pneumonia_ild_ct' | 'rib_fracture_ct' | 'head_ich_ct'> = []
    let queuePriority: 'stat' | 'urgent' | 'routine' | null = null
    let slaSeconds: number | null = null
    let needsConfirmation = false

    // 1. 过滤非 CT 模态
    if (modality !== 'CT') {
      skipReason = `非 CT 模态（${modality || '未知'}），不进入 CT 分析队列`
    } else if (LOCALIZER_RE.test(imageTypeStr) || LOCALIZER_RE.test(payload.series_description ?? '') || numInstances < 20) {
      // 2. 过滤定位像与层数过少的序列
      skipReason = `定位像或层数不足（${numInstances} 层）`
    } else if (region === 'other') {
      skipReason = '非胸部/头颅检查部位，不自动分析'
    } else if (region === 'unknown') {
      skipReason = '检查部位无法从标签自动判断，已建索引并等待医生确认部位'
      needsConfirmation = true
    } else if (region === 'head') {
      if (thickness != null && thickness > 5.0) {
        skipReason = `头颅 CT 层厚（${thickness} mm）大于 5.0 mm 上限`
      } else {
        accepted = true
        routedTasks.push('head_ich_ct')
        queuePriority = isEmergency ? 'stat' : 'urgent'
        slaSeconds = queuePriority === 'stat' ? 60 : 120
      }
    } else if (region === 'chest') {
      if (numInstances < 30) {
        skipReason = `胸部 CT 序列层数不足 30 层（当前 ${numInstances} 层）`
      } else if (thickness != null && thickness > 2.5) {
        skipReason = `胸部 CT 层厚（${thickness} mm）大于 2.5 mm 薄层要求`
      } else {
        accepted = true
        routedTasks.push('lung_nodule')
        if (PNEUMONIA_RE.test(textCombined)) routedTasks.push('pneumonia_ild_ct')
        if (RIB_TRAUMA_RE.test(textCombined)) routedTasks.push('rib_fracture_ct')
        queuePriority = isEmergency ? 'urgent' : 'routine'
        slaSeconds = queuePriority === 'urgent' ? 120 : 180
      }
    }

    const decision: PacsRoutingDecision = {
      event_id: `pacs_${randomUUID().slice(0, 12)}`,
      study_instance_uid: payload.study_instance_uid,
      series_instance_uid: payload.series_instance_uid,
      calling_aet: aet,
      remote_ip: ip,
      accepted,
      skip_reason: skipReason,
      detected_region: region,
      routed_tasks: routedTasks,
      queue_priority: queuePriority,
      p90_sla_seconds: slaSeconds,
      needs_region_confirmation: needsConfirmation,
      created_at: new Date().toISOString(),
    }

    this.db.prepare(`
      INSERT INTO imaging_pacs_events (
        id, study_instance_uid, series_instance_uid, calling_aet, remote_ip,
        accepted, skip_reason, detected_region, routed_tasks_json,
        queue_priority, p90_sla_seconds, needs_region_confirmation, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.event_id,
      decision.study_instance_uid,
      decision.series_instance_uid,
      decision.calling_aet,
      decision.remote_ip,
      decision.accepted ? 1 : 0,
      decision.skip_reason,
      decision.detected_region,
      JSON.stringify(decision.routed_tasks),
      decision.queue_priority,
      decision.p90_sla_seconds,
      decision.needs_region_confirmation ? 1 : 0,
      decision.created_at,
    )

    return decision
  }

  listEvents(limit = 50): PacsRoutingDecision[] {
    const rows = this.db.prepare(`
      SELECT * FROM imaging_pacs_events ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>

    return rows.map(r => ({
      event_id: String(r.id),
      study_instance_uid: String(r.study_instance_uid),
      series_instance_uid: String(r.series_instance_uid),
      calling_aet: String(r.calling_aet),
      remote_ip: String(r.remote_ip),
      accepted: Number(r.accepted) === 1,
      skip_reason: r.skip_reason ? String(r.skip_reason) : null,
      detected_region: String(r.detected_region) as PacsRoutingDecision['detected_region'],
      routed_tasks: JSON.parse(String(r.routed_tasks_json || '[]')),
      queue_priority: (r.queue_priority as PacsRoutingDecision['queue_priority']) ?? null,
      p90_sla_seconds: r.p90_sla_seconds != null ? Number(r.p90_sla_seconds) : null,
      needs_region_confirmation: Number(r.needs_region_confirmation) === 1,
      created_at: String(r.created_at),
    }))
  }
}
