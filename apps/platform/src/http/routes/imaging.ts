import type { Context, Hono } from 'hono'
import type { Documents } from '../../model/runtime.ts'
import type { Store } from '../../store/db.ts'
import type { PatientService, Actor } from '../../tenancy/patients.ts'
import type { Access } from '../../research/access.ts'

export interface ImagingRouteContext {
  store: Store
  docs: Documents
  access: Access
  audit: (c: Context, action: string, e?: { actor?: string | null; target?: string | null; detail?: string | null; status?: number }) => void
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  pt: (c: Context<{ Variables: { user: string } }>) => PatientService
  patientFailure: (c: Context, err: unknown) => Response
}

/**
 * 注册 MONAI 医学影像微服务与患者影像量化分析相关路由：
 * 包含硬件状态、模型列表、样本查看、正交 MPR/3D 差分热力图、
 * L3 体成分（HU 阈值法）测量、靶病灶测量与影像所见报告生成（不给诊断结论）。
 */
/**
 * 把影像微服务的错误如实转给调用方：缺参数 / 影像不存在 / 模型不可用（400 / 404 / 422 / 501）原样返回状态码与原因，
 * 其它错误为 502。
 */
export async function workerFail(c: Context, resp: Response, code: string): Promise<Response> {
  let message = ''
  try {
    const text = await resp.text()
    try { const j = JSON.parse(text); message = typeof j.detail === 'string' ? j.detail : j.detail ? JSON.stringify(j.detail) : (j.message ?? j.error ?? text) } catch { message = text }
  } catch {}
  const pass = [400, 404, 422, 501].includes(resp.status)
  const prefix = resp.status === 501 ? '模型不可用：' : resp.status === 404 ? '影像或样本不存在：' : resp.status === 400 || resp.status === 422 ? '请求参数有误：' : `影像微服务出错（HTTP ${resp.status}）：`
  return c.json({ error: code, worker_status: resp.status, message: `${prefix}${String(message).slice(0, 500)}` }, (pass ? resp.status : 502) as any)
}

export function registerImagingRoutes(
  app: Hono<{ Variables: { user: string } }>,
  ctx: ImagingRouteContext
): void {
  const { store, me, pt, patientFailure } = ctx
  const imagingWorkerUrl = (process.env.IMAGING_WORKER_URL || 'http://127.0.0.1:8004').replace(/\/+$/, '')

  app.get('/api/imaging/status', async c => {
    try {
      const resp = await fetch(`${imagingWorkerUrl}/health`, { signal: AbortSignal.timeout(8000) })
      if (!resp.ok) return workerFail(c, resp, 'imaging_worker_error')
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message, status: 'offline' }, 503)
    }
  })

  app.get('/api/imaging/models', async c => {
    try {
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/models`, { signal: AbortSignal.timeout(8000) })
      if (!resp.ok) return workerFail(c, resp, 'imaging_worker_error')
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.get('/api/imaging/samples', async c => {
    try {
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/samples`, { signal: AbortSignal.timeout(8000) })
      if (!resp.ok) return workerFail(c, resp, 'imaging_worker_error')
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  const handleImagingError = (c: Context, err: any) => {
    if (err && typeof err === 'object' && typeof err.status === 'number' && typeof err.code === 'string') {
      return patientFailure(c, err)
    }
    const msg = String(err?.message ?? err ?? '')
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|timed out|aborted/i.test(msg)) {
      return c.json({ error: 'imaging_inference_timeout', message: '3D 影像推理耗时超过阈值，请稍后重试或切换轻量模型' }, 504)
    }
    return c.json({ error: 'imaging_worker_offline', message: `影像计算微服务连接异常：${msg}` }, 503)
  }

  const verifyPtVolumeString = (c: any, id: unknown) => {
    if (typeof id !== 'string' || !id.startsWith('pt_')) return
    const parts = id.split('_')
    const ptId = parts[1]
    if (!ptId || parts.length < 3 || !parts[2]) {
      throw Object.assign(new Error('患者影像不存在'), { code: 'not_found', status: 404 })
    }
    pt(c).read(me(c), ptId)
  }

  const verifyBodyVolumeAccess = (c: any, body: Record<string, any>) => {
    if (!body || typeof body !== 'object') return
    for (const k of ['sample_id', 'volume_id', 'baseline_id', 'followup_id', 'ct_sample_id', 'pet_sample_id']) {
      verifyPtVolumeString(c, body[k])
    }
  }

  async function ensureVolumeOnWorker(c: any, patientId: string, recordIdOrFileId?: string | null): Promise<string | null> {
    if (!patientId) return null
    const user = me(c)
    // 鉴权失败直接向上抛出 PatientError（严禁吞没异常后降级）
    const detail = pt(c).read(user, patientId)
    try {
      let fileId: string | null = null
      let fileName = 'volume.zip'

      if (recordIdOrFileId) {
        const rec = detail.records.find((r: any) => r.id === recordIdOrFileId)
        if (rec) {
          const imgData = (rec.imaging_data || {}) as Record<string, any>
          fileId = imgData.raw_file_id || rec.file_id || null
          fileName = imgData.raw_file_name || rec.title || 'volume.zip'
        } else {
          fileId = recordIdOrFileId
        }
      } else {
        const imgRec = detail.records.find((r: any) => r.kind === 'imaging')
        if (imgRec) {
          const imgData = (imgRec.imaging_data || {}) as Record<string, any>
          fileId = imgData.raw_file_id || imgRec.file_id || null
          fileName = imgData.raw_file_name || imgRec.title || 'volume.zip'
        }
      }

      if (!fileId) return null

      const volumeId = `pt_${patientId}_${fileId}`

      // 快速检查 Worker 内存中是否已有该体素缓存
      try {
        const checkResp = await fetch(`${imagingWorkerUrl}/api/v1/volume/${encodeURIComponent(volumeId)}/status`, {
          signal: AbortSignal.timeout(3000),
        })
        if (checkResp.ok) {
          const status = await checkResp.json()
          if (status.ready) return volumeId
        }
      } catch {}

      // 从机构租户库解密患者原始扫描序列文件并流式上传至 Worker 预热
      const f = pt(c).file(user, patientId, fileId)
      if (!f || !f.bytes || f.bytes.byteLength === 0) return null

      const formData = new FormData()
      formData.append('volume_id', volumeId)
      const blob = new Blob([new Uint8Array(f.bytes)], { type: f.mime || 'application/octet-stream' })
      formData.append('file', blob, f.name || fileName)

      const uploadResp = await fetch(`${imagingWorkerUrl}/api/v1/volume/upload`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(60000),
      })
      if (!uploadResp.ok) {
        const errText = await uploadResp.text()
        console.error(`[imaging] Failed to upload patient volume to worker: ${errText}`)
        return null
      }
      return volumeId
    } catch (err: any) {
      if (err && typeof err === 'object' && typeof err.status === 'number' && typeof err.code === 'string') {
        throw err
      }
      console.error('[imaging] ensureVolumeOnWorker error:', err)
      return null
    }
  }

  app.get('/api/imaging/samples/:id/file', async c => {
    try {
      const id = c.req.param('id')
      if (id.startsWith('pt_')) {
        const parts = id.split('_')
        if (parts.length >= 3 && parts[1] && parts[2]) {
          const ptId = parts[1]
          const fId = parts[2]
          const f = pt(c).file(me(c), ptId, fId)
          return c.body(new Uint8Array(f.bytes), 200, {
            'Content-Type': f.mime || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(f.name)}"`,
          })
        }
        return c.json({ error: 'sample_not_found' }, 404)
      }
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
        return c.json({ error: 'sample_not_found' }, 404)
      }

      const resp = await fetch(`${imagingWorkerUrl}/api/v1/samples/${encodeURIComponent(id)}/file`, { signal: AbortSignal.timeout(20000) })
      if (!resp.ok) return c.json({ error: 'sample_not_found' }, 404)
      const mime = resp.headers.get('content-type') || 'application/gzip'
      return c.body(new Uint8Array(await resp.arrayBuffer()), 200, {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(id)}.nii.gz"`,
      })
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  app.get('/api/imaging/mpr/info', async c => {
    try {
      const patientId = c.req.query('patient_id')
      const recordId = c.req.query('record_id') || c.req.query('file_id')
      // 不使用默认演示样本：患者影像取患者档案里的原始文件；只有明确给出 sample_id 时才用样本
      let sampleId = c.req.query('sample_id') || undefined
      const filePath = c.req.query('file_path') || undefined
      const modelName = c.req.query('model_name') || undefined

      verifyPtVolumeString(c, sampleId)
      if (patientId) {
        const volId = await ensureVolumeOnWorker(c, patientId, recordId)
        if (volId) sampleId = volId
      }
      if (!sampleId && !filePath) return c.json({ error: 'no_image', message: '这条记录没有可用的影像文件（未上传原始影像，或文件无法载入）；平台不会用演示样本代替' }, 404)

      const resp = await fetch(`${imagingWorkerUrl}/api/v1/mpr/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id: sampleId, file_path: filePath, model_name: modelName }),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) return workerFail(c, resp, 'mpr_info_failed')
      return c.json(await resp.json())
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  app.post('/api/imaging/mpr/info', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      verifyBodyVolumeAccess(c, body)
      if (body.patient_id) {
        const volId = await ensureVolumeOnWorker(c, body.patient_id, body.record_id || body.file_id)
        if (volId) body.sample_id = volId
      }
      if (!body.sample_id && !body.file_path && !body.volume_id) return c.json({ error: 'no_image', message: '没有可用的影像（请提供患者影像记录、sample_id 或 file_path；平台不会用演示样本代替）' }, 404)
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/mpr/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) return workerFail(c, resp, 'mpr_info_failed')
      return c.json(await resp.json())
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  app.post('/api/imaging/mpr/slice', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      verifyBodyVolumeAccess(c, body)
      if (body.patient_id) {
        const volId = await ensureVolumeOnWorker(c, body.patient_id, body.record_id || body.file_id)
        if (volId) body.sample_id = volId
      }
      if (!body.sample_id && !body.file_path && !body.volume_id) return c.json({ error: 'no_image', message: '没有可用的影像（请提供患者影像记录、sample_id 或 file_path；平台不会用演示样本代替）' }, 404)
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/mpr/slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      if (!resp.ok) return workerFail(c, resp, 'mpr_slice_failed')
      const data = await resp.json()

      if (body.save_asset && (body.custom_png_base64 || data.slice_png_base64)) {
        const u = c.get('user' as any) || 'u1'
        const rawB64 = String(body.custom_png_base64 || data.slice_png_base64 || '')
        const b64Data = rawB64.replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const planeName = data.plane || 'mpr'
        const sliceIdx = data.slice_index ?? 0
        const assetName = `${body.label || `mpr-${planeName}-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `MPR ${planeName} 切片 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  app.post('/api/imaging/mpr/diff-slice', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      verifyBodyVolumeAccess(c, body)
      if (body.patient_id) {
        if (body.baseline_record_id || body.baseline_file_id) {
          const bVolId = await ensureVolumeOnWorker(c, body.patient_id, body.baseline_record_id || body.baseline_file_id)
          if (bVolId) body.baseline_id = bVolId
        }
        if (body.followup_record_id || body.followup_file_id) {
          const fVolId = await ensureVolumeOnWorker(c, body.patient_id, body.followup_record_id || body.followup_file_id)
          if (fVolId) body.followup_id = fVolId
        }
      }
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/mpr/diff-slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return workerFail(c, resp, 'mpr_diff_failed')
      const data = await resp.json()

      if (body.save_asset && data.slice_png_base64) {
        const u = c.get('user' as any) || 'u1'
        const b64Data = String(data.slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const planeName = data.plane || 'mpr'
        const sliceIdx = data.slice_index ?? 0
        const assetName = `${body.label || `diff-${planeName}-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `3D 差分热力图 ${planeName} 切片 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  app.post('/api/imaging/radiomics', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      verifyBodyVolumeAccess(c, body)
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/radiomics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return workerFail(c, resp, 'radiomics_failed')
      const data = await resp.json()
      return c.json(data)
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  app.post('/api/imaging/interactive-segment', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      verifyBodyVolumeAccess(c, body)
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/interactive-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return workerFail(c, resp, 'interactive_segment_failed')
      const data = await resp.json()

      if (body.save_asset && data.slice_png_base64) {
        const u = c.get('user' as any) || 'u1'
        const b64Data = String(data.slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const sliceIdx = data.key_slice_index ?? 0
        const assetName = `${body.label || `interactive-slice-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `交互点选分割 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  app.post('/api/imaging/whole-body', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      verifyBodyVolumeAccess(c, body)
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/whole-body`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return workerFail(c, resp, 'whole_body_failed')
      const data = await resp.json()

      if (body.save_asset && data.key_slice_png_base64) {
        const u = c.get('user' as any) || 'u1'
        const b64Data = String(data.key_slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const sliceIdx = data.l3_vertebra_slice_index ?? 0
        const assetName = `${body.label || `totalsegmentator-l3-slice-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `L3 体成分（HU 阈值法）切片 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  app.post('/api/imaging/registration/deformable', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      verifyBodyVolumeAccess(c, body)
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/registration/deformable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return workerFail(c, resp, 'deformable_registration_failed')
      const data = await resp.json()
      return c.json(data)
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  app.post('/api/imaging/registration/pet-ct-fusion', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      verifyBodyVolumeAccess(c, body)
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/registration/pet-ct-fusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return workerFail(c, resp, 'pet_ct_fusion_failed')
      const data = await resp.json()

      if (body.save_asset && data.fusion_png_base64) {
        const u = c.get('user' as any) || 'u1'
        const b64Data = String(data.fusion_png_base64 || '').replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const sliceIdx = data.key_slice_index ?? 0
        const assetName = `${body.label || `pet-ct-fusion-slice-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `PET-CT 代谢融合切片 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  app.post('/api/imaging/rtstruct/delineate', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      verifyBodyVolumeAccess(c, body)
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/rtstruct/delineate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return workerFail(c, resp, 'rtstruct_delineate_failed')
      const data = await resp.json()

      if (body.save_asset && data.rtstruct_png_base64) {
        const u = c.get('user' as any) || 'u1'
        const b64Data = String(data.rtstruct_png_base64 || '').replace(/^data:image\/png;base64,/, '')
        const pngBuf = Buffer.from(b64Data, 'base64')
        const sliceIdx = data.key_slice_index ?? 0
        const assetName = `${body.label || `rtstruct-slice-${sliceIdx}`}.png`
        const asset = store.putAsset({
          owner: u,
          mime: 'image/png',
          name: assetName,
          bytes: pngBuf,
        })
        data.asset_id = asset.id
        data.markdown_insert = `![${body.label || `放疗靶区 (GTV/CTV/PTV) 勾画切片 #${sliceIdx}`}](asset:${asset.id})`
      }

      return c.json(data)
    } catch (err: any) {
      return handleImagingError(c, err)
    }
  })

  interface ImagingJobState {
    job_id: string
    patient_id: string
    model_id: string
    file_name: string
    status: 'running' | 'completed' | 'failed'
    stage: string
    detail: string
    percent: number
    started_at: number
    ended_at?: number
    record_id?: string
    error?: string
  }

  const patientImagingJobs = new Map<string, ImagingJobState>()

  app.get('/api/patients/:ptid/imaging/jobs', async c => {
    try {
      const patientId = c.req.param('ptid')
      pt(c).read(me(c), patientId)
      const job = patientImagingJobs.get(patientId)
      if (!job) {
        return c.json({ active: null, latest: null })
      }
      if (job.status === 'running') {
        try {
          const wResp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/jobs/${encodeURIComponent(job.job_id)}`, {
            signal: AbortSignal.timeout(1500),
          })
          if (wResp.ok) {
            const wData = await wResp.json()
            if (typeof wData.stage === 'string' && wData.stage) job.stage = wData.stage
            if (typeof wData.detail === 'string' && wData.detail) job.detail = wData.detail
            if (typeof wData.percent === 'number' && wData.percent > job.percent && wData.percent < 98) {
              job.percent = wData.percent
            }
          }
        } catch {}
      }
      const elapsedSec = Math.max(1, Math.round(((job.ended_at || Date.now()) - job.started_at) / 1000))
      const payload = { ...job, elapsed_sec: elapsedSec }
      return c.json({
        active: job.status === 'running' ? payload : null,
        latest: payload,
      })
    } catch (err) {
      return handleImagingError(c, err)
    }
  })

  app.post('/api/patients/:ptid/imaging/analyze', async c => {
    let activeJob: ImagingJobState | null = null
    try {
      const contentType = c.req.header('content-type') || ''
      let sampleId: string | undefined
      let modelId: string | undefined
      let windowPreset: string | undefined
      let barCutoff: number | undefined
      let mucusMinHu: number | undefined
      let mucusMaxHu: number | undefined
      let hamThresholdHu: number | undefined
      let reportDate: string | undefined
      let title: string | undefined
      let autoTag = true
      let fileBuffer: Buffer | null = null
      let fileName = ''

      const parseSafeNum = (v: any): number | undefined => {
        if (v === undefined || v === null || v === '') return undefined
        const n = Number(String(v).replace(',', '.'))
        return isNaN(n) ? undefined : n
      }

      if (contentType.includes('multipart/form-data')) {
        const form = await c.req.parseBody()
        sampleId = typeof form.sample_id === 'string' ? form.sample_id : undefined
        modelId = typeof form.model_id === 'string' ? form.model_id : undefined
        windowPreset = typeof form.window_preset === 'string' ? form.window_preset : undefined
        barCutoff = parseSafeNum(form.bar_cutoff)
        mucusMinHu = parseSafeNum(form.mucus_min_hu)
        mucusMaxHu = parseSafeNum(form.mucus_max_hu)
        hamThresholdHu = parseSafeNum(form.ham_threshold_hu)
        reportDate = typeof form.report_date === 'string' ? form.report_date : undefined
        title = typeof form.title === 'string' ? form.title : undefined
        if (form.auto_tag !== undefined) autoTag = String(form.auto_tag) !== 'false'
        if (form.file instanceof File) {
          fileName = form.file.name
          fileBuffer = Buffer.from(await form.file.arrayBuffer())
        }
      } else {
        const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
        sampleId = body.sample_id
        modelId = body.model_id
        windowPreset = body.window_preset
        barCutoff = parseSafeNum(body.bar_cutoff)
        mucusMinHu = parseSafeNum(body.mucus_min_hu)
        mucusMaxHu = parseSafeNum(body.mucus_max_hu)
        hamThresholdHu = parseSafeNum(body.ham_threshold_hu)
        reportDate = body.report_date
        title = body.title
        if (body.auto_tag !== undefined) autoTag = Boolean(body.auto_tag)
      }

      const patientId = c.req.param('ptid')
      pt(c).assertEditable(me(c), patientId)

      const existing = patientImagingJobs.get(patientId)
      if (existing && existing.status === 'running' && Date.now() - existing.started_at < 300_000) {
        return c.json({
          error: 'imaging_job_running',
          message: '该患者当前已有正在运行的 3D 影像推理任务，请等待其完成',
          job: { ...existing, elapsed_sec: Math.max(1, Math.round((Date.now() - existing.started_at) / 1000)) },
        }, 409)
      }

      const jobId = `imgjob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      activeJob = {
        job_id: jobId,
        patient_id: patientId,
        model_id: modelId || 'bronchiectasis_mucus_analyzer',
        file_name: fileName || sampleId || 'scan.nii.gz',
        status: 'running',
        stage: '正在传输体素序列至计算微服务',
        detail: `已接收 ${fileName || sampleId || '影像序列'}，正在调度 MONAI 推理管线...`,
        percent: 12,
        started_at: Date.now(),
      }
      patientImagingJobs.set(patientId, activeJob)

      let resultData: any
      if (fileBuffer) {
        const formData = new FormData()
        const blob = new Blob([new Uint8Array(fileBuffer)], { type: 'application/octet-stream' })
        formData.append('file', blob, fileName || 'scan.nii.gz')
        formData.append('model_name', modelId || 'bronchiectasis_mucus_analyzer')
        formData.append('job_id', jobId)
        if (windowPreset) formData.append('window_preset', windowPreset)
        if (barCutoff !== undefined && !isNaN(barCutoff)) formData.append('bar_cutoff', String(barCutoff))
        if (mucusMinHu !== undefined && !isNaN(mucusMinHu)) formData.append('mucus_min_hu', String(mucusMinHu))
        if (mucusMaxHu !== undefined && !isNaN(mucusMaxHu)) formData.append('mucus_max_hu', String(mucusMaxHu))
        if (hamThresholdHu !== undefined && !isNaN(hamThresholdHu)) formData.append('ham_threshold_hu', String(hamThresholdHu))

        const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/upload`, {
          method: 'POST',
          body: formData,
          signal: AbortSignal.timeout(300000),
        })
        if (!resp.ok) {
          const failResp = await workerFail(c, resp, 'imaging_inference_failed')
          try {
            const failJson = await failResp.clone().json()
            activeJob.status = 'failed'
            activeJob.error = failJson.message || `HTTP ${resp.status}`
            activeJob.ended_at = Date.now()
          } catch {
            activeJob.status = 'failed'
            activeJob.error = `HTTP ${resp.status}`
            activeJob.ended_at = Date.now()
          }
          return failResp
        }
        resultData = await resp.json()
      } else if (sampleId) {
        activeJob.stage = '正在加载样本并执行 MONAI 推理'
        activeJob.percent = 45
        const resp = await fetch(`${imagingWorkerUrl}/api/v1/analyze/sample`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sample_id: sampleId,
            model_name: modelId,
            window_preset: windowPreset,
            bar_cutoff: barCutoff,
            mucus_min_hu: mucusMinHu,
            mucus_max_hu: mucusMaxHu,
            ham_threshold_hu: hamThresholdHu,
          }),
          signal: AbortSignal.timeout(300000),
        })
        if (!resp.ok) {
          const failResp = await workerFail(c, resp, 'imaging_inference_failed')
          try {
            const failJson = await failResp.clone().json()
            activeJob.status = 'failed'
            activeJob.error = failJson.message || `HTTP ${resp.status}`
            activeJob.ended_at = Date.now()
          } catch {
            activeJob.status = 'failed'
            activeJob.error = `HTTP ${resp.status}`
            activeJob.ended_at = Date.now()
          }
          return failResp
        }
        resultData = await resp.json()
      } else {
        patientImagingJobs.delete(patientId)
        return c.json({ error: 'no_image', message: '请上传该患者真实的医学影像文件 (NIfTI / DICOM)' }, 400)
      }

      activeJob.stage = '正在加密写入患者病历与影像档案'
      activeJob.percent = 95

      const b64Data = String(resultData.key_slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
      if (!b64Data) {
        activeJob.status = 'failed'
        activeJob.error = '影像计算未返回切片图像'
        activeJob.ended_at = Date.now()
        return c.json({ error: 'no_image_output', message: '影像计算未返回切片图像' }, 500)
      }
      const pngBuffer = Buffer.from(b64Data, 'base64')

      const rawMetrics = resultData.metrics || {}
      const rm = resultData.recist_metrics
      const barRatio = rawMetrics.broncho_arterial_ratio ?? rawMetrics.bar_ratio
      const hasSignet = barRatio !== undefined ? barRatio > (barCutoff || 1.10) : Boolean(rawMetrics.signet_ring_sign)
      // 测值缺失保持 null（不以 0 或其它测值代替）
      const hamVol: number | null = rawMetrics.high_attenuation_mucus_cm3 ?? rawMetrics.ham_volume_mm3 ?? null
      const hasHam = (hamVol ?? 0) > 0 || Boolean(rawMetrics.high_attenuation_mucus_ham)
      const mucusVol: number | null = rawMetrics.total_mucus_volume_cm3 ?? rawMetrics.mucus_plug_volume_mm3 ?? null
      const occlusionRate: number | null = rawMetrics.airway_occlusion_rate_pct ?? rawMetrics.airway_mucus_occlusion_pct ?? null
      const hasTreeInBud = Boolean(rawMetrics.tree_in_bud_volume_cm3 > 0 || rawMetrics.tree_in_bud_sign)

      const normalizedMetrics = {
        ...(rm && typeof rm === 'object' ? rm : {}),
        ...rawMetrics,
        bar_ratio: barRatio,
        signet_ring_sign: hasSignet,
        total_mucus_volume_cm3: mucusVol,
        high_attenuation_mucus_cm3: hamVol,
        high_attenuation_mucus_ham: hasHam,
        airway_occlusion_rate_pct: occlusionRate,
        longest_diameter_mm: rm?.longest_diameter_mm ?? null,
        short_axis_mm: rm?.short_axis_mm ?? null,
        total_volume_cm3: rm?.total_volume_cm3 ?? mucusVol,
        key_slice_index: resultData.key_slice_index ?? rm?.key_slice_index ?? null,
        has_lesion: rm?.has_lesion,
      }

      // 只记录影像所见（测值与征象），不写诊断、分级结论或随访建议；自动标签也只用所见
      const findings: string[] = []
      const tagsToAdd: string[] = []

      if (barRatio !== undefined) {
        if (hasSignet) {
          findings.push(`支气管 / 伴行动脉径比 BAR ${barRatio.toFixed(2)}（> ${barCutoff || 1.10}）`)
          tagsToAdd.push('BAR 增大')
        }
        if (hasHam) {
          findings.push(`高密度粘液栓${hamVol !== null ? ` ${hamVol} cm³` : ''}`)
          tagsToAdd.push('高密度粘液栓')
        }
        if (mucusVol !== null && mucusVol > 0) {
          findings.push(`支气管管腔粘液栓体积 ${mucusVol} cm³${occlusionRate !== null ? `（管腔阻塞率 ${occlusionRate}%）` : ''}`)
        }
        if (hasTreeInBud) {
          findings.push('树芽征（算法标注）')
        }
      } else if (rm?.pancreas) {
        findings.push(`胰腺实质体积 ${rm.pancreas.pancreas_volume_cm3 ?? rm.pancreas.organ_or_lesion_volume_cm3 ?? 0} cm³`)
        if ((rm.pancreas.tumor_volume_cm3 ?? 0) > 0) {
          findings.push(`胰腺占位体积 ${rm.pancreas.tumor_volume_cm3} cm³（最大长径 ${rm.longest_diameter_mm ?? 0} mm）`)
        }
      } else if (rm?.kidney) {
        if (rm.kidney.cortex_volume_cm3 !== undefined) {
          findings.push(`肾脏总体积 ${rm.kidney.total_renal_volume_cm3} cm³（皮质 ${rm.kidney.cortex_volume_cm3} cm³，髓质 ${rm.kidney.medulla_volume_cm3} cm³，肾盂肾盏 ${rm.kidney.pelvis_calyces_volume_cm3} cm³）`)
        } else if (rm.kidney.organ_or_lesion_volume_cm3 !== undefined) {
          findings.push(`肾脏体积 ${rm.kidney.organ_or_lesion_volume_cm3} cm³`)
        }
      } else if (rm?.neuro?.brain_structures_detected !== undefined) {
        findings.push(`全脑 133 解剖结构分割：检出 ${rm.neuro.brain_structures_detected} 个脑区结构，分割总体积 ${rm.neuro.segmented_brain_volume_cm3} cm³`)
      } else if (rm?.vista3d) {
        findings.push(`VISTA-3D 3D 自动分割：检出 ${rm.vista3d.structures_detected} 类解剖结构，总体积 ${rm.vista3d.total_segmented_volume_cm3} cm³`)
      } else if (rm?.cardiac_valve_landmarks) {
        findings.push(`心脏瓣膜 3D 关键点回归：定位 ${rm.cardiac_valve_landmarks.landmarks_count} 个解剖标志点，标志点最大间距 ${rm.cardiac_valve_landmarks.inter_commissural_distance_mm} mm`)
      } else if (rm?.breast_density) {
        findings.push(`乳腺密度分类量化：预测类别 ${rm.breast_density.predicted_birads_class}（置信度 ${((rm.breast_density.confidence ?? 0) * 100).toFixed(1)}%）`)
      } else if (rm?.pathology_tumor) {
        findings.push(`病理切片肿瘤检测：区块最高肿瘤概率 ${((rm.pathology_tumor.max_tumor_probability ?? 0) * 100).toFixed(1)}%，高概率区块占比 ${((rm.pathology_tumor.high_probability_fraction ?? 0) * 100).toFixed(1)}%`)
      } else if (rm?.pathology_nuclei) {
        findings.push(`病理细胞核分割：细胞核面积占比 ${((rm.pathology_nuclei.nuclei_area_fraction ?? 0) * 100).toFixed(1)}%（主类：${rm.pathology_nuclei.predominant_cell_class}）`)
      } else if (rm?.endoscopy) {
        findings.push(`内镜器械分割：器械区域占比 ${((rm.endoscopy.tool_area_fraction ?? 0) * 100).toFixed(2)}%`)
      } else if (rm && (rm.has_lesion === false || rm.longest_diameter_mm === 0)) {
        findings.push('算法未检出 ≥ 3 mm 实性肺结节')
      } else if (rm && rm.longest_diameter_mm > 0) {
        findings.push(`靶病灶最大截面长径 ${rm.longest_diameter_mm} mm${rm.short_axis_mm !== undefined ? `（短径 ${rm.short_axis_mm} mm）` : ''}`)
        if (rm.total_volume_cm3 !== undefined) findings.push(`病灶体积 ${rm.total_volume_cm3} cm³${rm.key_slice_index !== undefined ? `（关键截面第 #${rm.key_slice_index} 层）` : ''}`)
        if (!modelId || modelId.includes('lung') || modelId.includes('nodule')) {
          tagsToAdd.push('肺结节')
        }
      }

      const defaultTitle = modelId === 'bronchiectasis_mucus_analyzer' || resultData.model_name?.includes('bronchiectasis')
        ? '胸部 HRCT 支气管与粘液栓定量分析'
        : (rm?.has_lesion === false || rm?.longest_diameter_mm === 0) && (!modelId || modelId.includes('lung') || modelId.includes('nodule'))
        ? '胸部 CT 结节检测（未检出 ≥ 3 mm 实性结节）'
        : `${resultData.modality || 'CT'} 靶病灶三维量化分析`

      let rawVolume: { name: string; bytes: Uint8Array; mime?: string } | undefined
      if (fileBuffer) {
        rawVolume = {
          name: fileName || 'scan.nii.gz',
          bytes: new Uint8Array(fileBuffer),
          mime: fileName.endsWith('.dcm') ? 'application/dicom' : 'application/gzip',
        }
      } else if (sampleId) {
        try {
          const sResp = await fetch(`${imagingWorkerUrl}/api/v1/samples/${sampleId}/file`, { signal: AbortSignal.timeout(10000) })
          if (sResp.ok) {
            const buf = await sResp.arrayBuffer()
            rawVolume = {
              name: `${sampleId}.nii.gz`,
              bytes: new Uint8Array(buf),
              mime: 'application/gzip',
            }
          }
        } catch (e) {
          console.warn('[sample-download-warning]', e)
        }
      }

      const saved = pt(c).addImagingRecord(me(c), patientId, {
        // 演示样本不是该患者的影像：标题明确标注
        title: `${!fileBuffer && sampleId ? '【演示样本】' : ''}${title || defaultTitle}`,
        report_date: reportDate || new Date().toISOString().slice(0, 10),
        model_id: modelId || resultData.model_name || 'bronchiectasis_mucus_analyzer',
        sample_id: sampleId || null,
        modality: resultData.modality || 'Chest HRCT',
        metrics: normalizedMetrics,
        findings,
        key_slice_png: pngBuffer,
        raw_volume_file: rawVolume,
        add_tags: autoTag && tagsToAdd.length > 0 ? tagsToAdd : undefined,
      })

      if (activeJob) {
        activeJob.status = 'completed'
        activeJob.percent = 100
        activeJob.stage = '分析完成并已加密存入患者档案'
        activeJob.detail = `已生成关键截面与量化指标（记录 #${saved.record.id}）`
        activeJob.record_id = saved.record.id
        activeJob.ended_at = Date.now()
      }

      return c.json({
        ok: true,
        job_id: activeJob?.job_id,
        record: saved.record,
        asset_id: saved.asset_id,
        file_id: saved.file_id,
        raw_file_id: saved.raw_file_id,
        metrics: saved.record.imaging_data?.metrics,
        findings,
        tags_added: autoTag ? tagsToAdd : [],
      }, 201)
    } catch (err: any) {
      if (activeJob && activeJob.status === 'running') {
        activeJob.status = 'failed'
        activeJob.error = err?.message || String(err)
        activeJob.ended_at = Date.now()
      }
      return handleImagingError(c, err)
    }
  })

  app.post('/api/patients/:ptid/imaging/compare', async c => {
    try {
      const patientId = c.req.param('ptid')
      const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
      const result = pt(c).compareImaging(me(c), patientId, {
        baseline_record_id: typeof body.baseline_record_id === 'string' ? body.baseline_record_id : undefined,
        followup_record_id: typeof body.followup_record_id === 'string' ? body.followup_record_id : undefined,
        save_as_record: Boolean(body.save_as_record),
      })
      return c.json(result)
    } catch (err) {
      return patientFailure(c, err)
    }
  })

  app.get('/api/patients/:ptid/imaging/evidence-chain', c => {
    try {
      const patientId = c.req.param('ptid')
      const recordId = c.req.query('record_id') || undefined
      const baselineId = c.req.query('baseline_record_id') || undefined
      const followupId = c.req.query('followup_record_id') || undefined
      const result = pt(c).getEvidenceChain(me(c), patientId, {
        record_id: recordId,
        baseline_record_id: baselineId,
        followup_record_id: followupId,
      })
      return c.json(result)
    } catch (err) {
      return patientFailure(c, err)
    }
  })

  app.get('/api/patients/:ptid/imaging/export', c => {
    try {
      const patientId = c.req.param('ptid')
      const format = (c.req.query('format') || 'fhir') as 'fhir' | 'dicom-sr'
      const recordId = c.req.query('record_id') || undefined
      const isDownload = c.req.query('download') === '1'
      const res = pt(c).exportImagingStandard(me(c), patientId, { format, record_id: recordId })
      if (isDownload) {
        c.header('Content-Type', res.mime)
        c.header('Content-Disposition', `attachment; filename="${res.filename}"`)
      }
      return c.json(res.data)
    } catch (err) {
      return patientFailure(c, err)
    }
  })

  app.post('/api/patients/:ptid/imaging/full-report', async c => {
    try {
      const patientId = c.req.param('ptid')
      const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
      const result = pt(c).generateComprehensiveReport(me(c), patientId, {
        record_id: typeof body.record_id === 'string' ? body.record_id : undefined,
        save_to_records: body.save_to_records !== undefined ? Boolean(body.save_to_records) : true,
        title: typeof body.title === 'string' ? body.title : undefined,
      })
      return c.json(result)
    } catch (err) {
      return patientFailure(c, err)
    }
  })

  app.get('/api/patients/:ptid/imaging/full-report', c => {
    try {
      const patientId = c.req.param('ptid')
      const recordId = c.req.query('record_id') || undefined
      const result = pt(c).generateComprehensiveReport(me(c), patientId, {
        record_id: recordId,
        save_to_records: false,
      })
      return c.json(result)
    } catch (err) {
      return patientFailure(c, err)
    }
  })
}
