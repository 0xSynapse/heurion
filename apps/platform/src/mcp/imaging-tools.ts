import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { TokenClaims } from '../auth/token.ts'
import type { Store } from '../store/db.ts'
import type { PatientService } from '../tenancy/patients.ts'
import type { StudyService } from '../research/service.ts'
import type { DatasetService } from '../datasets/service.ts'
import type { CohortService } from '../research/cohort.ts'
import {
  renderMechanismDiagram,
  generateWetLabPlot,
  generateBioinformaticsFigure,
  generateImageJAnalysis,
  generateFlowJoAnalysis,
  generateSlicerAndItkSnapPackage,
  assembleJournalFigure,
} from '../research/medical-figures.ts'
import {
  renderConsortSvg,
  exportFlowchartToDrawio,
  exportFlowchartToVisioVdx,
  exportFlowchartToPptx,
} from '../research/consort.ts'
import { generateSurvivalAnalysis } from '../datasets/survival.ts'
import {
  generateLogisticRegression,
  generateGrottaPlot,
  generateSankeyDiagram,
  generateUpSetPlot,
  buildDefaultClinicalCohortRecords,
} from '../datasets/clinical-plots.ts'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))
/** 影像微服务错误如实转给 AI：400/422 参数有误、404 影像不存在、501 模型不可用 */
async function workerToolFail(code: string, resp: Response) {
  let detail = ''
  try { const t = await resp.text(); try { const j = JSON.parse(t); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j) } catch { detail = t } } catch {}
  const kind = resp.status === 501 ? '模型不可用' : resp.status === 404 ? '影像或样本不存在' : resp.status === 400 || resp.status === 422 ? '请求参数有误' : '影像微服务出错'
  return fail(code, `${kind}（HTTP ${resp.status}）：${detail.slice(0, 500)}`, { worker_status: resp.status })
}

/** 不使用默认演示样本：既没有样本也没有文件时直接报错 */
const noImage = (what = '影像') => fail('no_image', `缺少${what}：请提供 sample_id 或 file_path（平台不会用默认演示样本代替）`)

const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message, ...extra }, null, 2) }],
  isError: true,
})

export interface ImagingToolsDeps {
  store: Store
  claims: TokenClaims
  patients?: PatientService
  studies?: StudyService
  datasets?: DatasetService
  cohort?: CohortService
  workerUrl?: string
}

/**
 * 注册 MONAI 医学影像分析 MCP 工具套件：
 * 包含硬件加速探测、临床模型清单、3D 病灶分割、RECIST 1.1 量化与出版级关键切片资产生成。
 */
export function registerImagingTools(server: McpServer, deps: ImagingToolsDeps): void {
  const { store, claims } = deps
  const workerUrl = (deps.workerUrl || process.env.IMAGING_WORKER_URL || 'http://127.0.0.1:8004').replace(/\/+$/, '')

  // 1. 影像微服务状态与计算硬件探测
  server.registerTool('imaging_status', {
    description: '检查 MONAI 医学影像分析微服务的运行状态与底层硬件加速器信息（Apple Silicon Metal MPS / NVIDIA CUDA / CPU 统一显存）。',
    inputSchema: {},
  }, async () => {
    try {
      const resp = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return await workerToolFail('imaging_worker_error', resp)
      const data = await resp.json()
      return json(data)
    } catch (err) {
      return fail('imaging_worker_offline', `无法连接 MONAI 影像计算节点 (${workerUrl})：请确认 worker 服务已启动。`, {
        hint: '在本地可执行 uv run --python 3.12 --project apps/imaging-worker uvicorn src.server:app --port 8004 启动微服务。'
      })
    }
  })

  // 2. 临床分割与检测模型清单
  server.registerTool('imaging_models', {
    description: '获取影像分析模型清单：每个模型的 engine_type（deep_learning 深度学习 / quantitative_ct 定量 CT / rule_based 规则算法）、是否可用（is_ready）与不可用原因（unavailable_reason）。不可用的模型调用时影像微服务返回 501。',
    inputSchema: {},
  }, async () => {
    try {
      const resp = await fetch(`${workerUrl}/api/v1/models`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return await workerToolFail('imaging_worker_error', resp)
      const data = await resp.json()
      return json(data)
    } catch (err) {
      return fail('imaging_worker_offline', `无法连接 MONAI 影像节点：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 3. 核心工具：3D 影像分析、RECIST 1.1 量化与关键截面插图生成
  server.registerTool('imaging_analyze', {
    description:
      '用指定模型分析影像（模型可能是规则算法、定量 CT 或深度学习，以 imaging_models 的 engine_type 为准），' +
      '提取最大横截面关键层，生成带轮廓与标尺的 PNG 并保存为用户资产；返回 asset_id、长径 / 短径 / 体积等测值和 Markdown 图片语法。' +
      '必须提供 sample_id 或 file_path（或绑定有影像文件的患者）；模型不可用时返回 501 及原因。只给测值与所见，不给诊断。',
    inputSchema: {
      patient_id: z.string().optional().describe('患者 ID（指定时自动提取患者背景、关联最新扫描并在推理完成后自动归档为患者的新影像记录）'),
      model_id: z.string().optional().describe('模型 ID（先用 imaging_models 查看可用模型与类型），例如 bronchiectasis_mucus_analyzer（规则算法）、lung_nodule_segmenter（规则算法）、spleen_segmenter（深度学习）、liver_lesion_segmenter（BTCV 器官分割：肝脏，不识别病灶）'),
      sample_id: z.string().optional().describe('预置样本 ID（与 file_path 二选一，必须提供其一）'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI (.nii/.nii.gz) 文件的绝对路径'),
      window_preset: z.enum(['lung', 'abdomen', 'brain', 'mediastinum']).optional().describe('CT 窗宽窗位预设'),
      benchmark: z.boolean().optional().describe('是否运行合成体模基准测试（仅用于测试性能；必须显式设为 true，不能写入患者病历）'),
      z_slices: z.number().int().min(16).max(256).optional().describe('扫描层数，缺省 48'),
      bar_cutoff: z.number().optional().describe('支气管-伴行动脉比 (BAR) 印戒征扩张切点，缺省 1.10'),
      mucus_min_hu: z.number().optional().describe('常规粘液栓 CT 阈值下限 (HU)，缺省 10.0'),
      mucus_max_hu: z.number().optional().describe('常规粘液栓 CT 阈值上限 (HU)，缺省 75.0'),
      ham_threshold_hu: z.number().optional().describe('高密度粘液栓 (HAM) CT 阈值 (HU)，缺省 70.0'),
      label: z.string().max(60).optional().describe('生成的图注标签，例如「图 1 基线靶病灶 RECIST 截面」'),
    },
  }, async ({ patient_id, model_id, sample_id, file_path, window_preset, benchmark, z_slices, bar_cutoff, mucus_min_hu, mucus_max_hu, ham_threshold_hu, label }) => {
    if (!claims.p.includes('write')) return fail('forbidden', '当前令牌没有写入或上传资产权限')

    let patientRow: any = null
    let patientAiActor: any = null
    if (patient_id) {
      if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
      patientAiActor = { userId: claims.u, via: 'ai' as const, space: 'work' as const }
      try {
        deps.patients.assertEditable(patientAiActor, patient_id)
        patientRow = deps.patients.read(patientAiActor, patient_id)
      } catch (err: any) {
        return fail('patient_permission_denied', err.message || String(err))
      }
    }

    if (!patientRow && !sample_id && !file_path && !benchmark) return noImage()

    if (patientRow && !sample_id && !file_path) {
      // B5 修复：真实检查患者是否有关联的影像记录或附件文件，绝不允许将合成体模作为患者扫描分析并写入病历
      const imgRec = patientRow.records?.find((r: any) => r.kind === 'imaging' && (r.file_id || r.imaging_data?.file_path))
      if (imgRec) {
        file_path = imgRec.imaging_data?.file_path || (imgRec.file_id ? `/app/data/platform/files/${imgRec.file_id}` : undefined)
      }
      if (!file_path && !sample_id) {
        return fail('patient_imaging_not_found', '该患者档案中未检出真实的影像数据文件 (DICOM/NIfTI)。严禁使用合成演示体模写入真实患者病历。')
      }
    }
    
    let resultData: any
    try {
      let endpoint = `${workerUrl}/api/v1/analyze/benchmark`
      let reqBody: Record<string, unknown> = {
        model_name: model_id ?? 'lung_nodule_segmenter',
        window_preset: window_preset ?? 'lung',
        z_slices: z_slices ?? 48,
        y_dim: 128,
        x_dim: 128,
        bar_cutoff,
        mucus_min_hu,
        mucus_max_hu,
        ham_threshold_hu,
      }

      if (patientRow) {
        reqBody.patient_context = {
          patient_id: patientRow.id,
          patient_code: patientRow.code,
          sex: patientRow.sex === 'M' ? '男' : patientRow.sex === 'F' ? '女' : '未知',
          age: patientRow.birth_year ? new Date().getFullYear() - patientRow.birth_year : undefined,
          tags: patientRow.tags,
        }
      }

      if (sample_id) {
        endpoint = `${workerUrl}/api/v1/analyze/sample`
        reqBody = {
          ...reqBody,
          sample_id,
          model_name: model_id,
          window_preset,
          bar_cutoff,
          mucus_min_hu,
          mucus_max_hu,
          ham_threshold_hu,
        }
      } else if (file_path) {
        endpoint = `${workerUrl}/api/v1/analyze/file`
        reqBody = {
          ...reqBody,
          file_path,
          model_name: model_id,
          window_preset,
          bar_cutoff,
          mucus_min_hu,
          mucus_max_hu,
          ham_threshold_hu,
        }
      }

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return await workerToolFail('inference_failed', resp)
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `调用 MONAI 计算节点失败：${err instanceof Error ? err.message : String(err)}`, {
        hint: '请确认微服务已在 8004 端口正常运行。'
      })
    }

    // 提取关键切片 Base64 并转换为二进制 Buffer，保存为资产
    const b64Data = String(resultData.key_slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
    if (!b64Data) return fail('no_image_output', '推理完成但未返回关键切片图像')
    const pngBuffer = Buffer.from(b64Data, 'base64')

    const assetName = `${label || (patientRow ? `${patientRow.code}-imaging-slice` : 'monai-recist-slice')}.png`
    const asset = store.putAsset({
      owner: claims.u,
      mime: 'image/png',
      name: assetName,
      bytes: pngBuffer,
    })

    const recist = resultData.recist_metrics || {}
    // 缺失测值保持 null；分级（Lung-RADS 等）与诊断性文字不再使用
    const ld: number | null = recist.longest_diameter_mm ?? null
    const vol: number | null = recist.total_volume_cm3 ?? null
    const sliceIdx: number | null = recist.key_slice_index ?? null
    const fmtMm = (v: unknown, unit: string) => v === null || v === undefined ? '未测得' : `${v} ${unit}`
    const sliceText = sliceIdx === null ? '' : `第 #${sliceIdx} 层，`
    const figCaption = label || (recist.has_lesion === false ? '图 1 CT 横截面（算法未检出可测量病灶）' : `图 1 病灶关键截面（长径 ${fmtMm(ld, 'mm')}，体积 ${fmtMm(vol, 'cm³')}）`)
    const figNote = recist.has_lesion === false
      ? `图 1 CT 横截面（${sliceText}算法未检出可测量病灶）`
      : `图 1 病灶分割与最大横截面测量（${sliceText}长径 ${fmtMm(ld, 'mm')}，短径 ${fmtMm(recist.short_axis_mm, 'mm')}，体积 ${fmtMm(vol, 'cm³')}）`

    let savedRecordId: string | undefined
    if (patientRow && deps.patients) {
      const findings: string[] = []
      if (recist.has_lesion && ld !== null && ld > 0) findings.push(`靶病灶长径 ${ld} mm，体积 ${fmtMm(vol, 'cm³')}`)
      // 影像 AI 报告只取「影像所见」描述（worker 已不再给诊断评估）
      const aiFindings = resultData.clinical_ai_report?.findings_description
      if (typeof aiFindings === 'string' && aiFindings.trim()) findings.push(aiFindings.trim())
      // 自动标签只用所见，不打诊断标签
      const addTags: string[] = []
      if (resultData.metrics?.signet_ring_sign) addTags.push('BAR 增大')
      if (resultData.metrics?.high_attenuation_mucus_ham) addTags.push('高密度粘液栓')

      try {
        const saved = deps.patients.addImagingRecord(patientAiActor, patientRow.id, {
          title: label || `${resultData.modality || 'CT'} 影像量化分析 (${resultData.model_name || model_id || '靶病灶'})`,
          report_date: new Date().toISOString().slice(0, 10),
          model_id: model_id || resultData.model_name || 'lung_nodule_segmenter',
          sample_id: sample_id || null,
          modality: resultData.modality || 'CT',
          metrics: {
            ...recist,
            inference_duration_sec: resultData.inference_duration_sec,
            clinical_ai_report: resultData.clinical_ai_report,
          },
          findings,
          key_slice_png: pngBuffer,
          add_tags: addTags.length > 0 ? addTags : undefined,
        })
        savedRecordId = saved.record.id
      } catch {
        // Fallback if recording fails
      }
    }

    return json({
      status: 'success',
      patient_id: patientRow?.id,
      patient_code: patientRow?.code,
      saved_record_id: savedRecordId,
      asset_id: asset.id,
      model_name: resultData.model_name,
      modality: resultData.modality,
      metrics: resultData.metrics,
      accelerator: resultData.accelerator,
      duration_sec: resultData.inference_duration_sec,
      recist_metrics: {
        longest_diameter_mm: ld,
        short_axis_mm: recist.short_axis_mm ?? null,
        total_volume_cm3: vol,
        key_slice_index: sliceIdx,
        has_lesion: recist.has_lesion,
      },
      markdown_insert: `![${figCaption}](asset:${asset.id} "${figNote}")`,
      summary: resultData.summary_markdown,
    })
  })

  // 4. 辅助工具：RECIST 1.1 疗效评估（基线 vs 随访评估 CR / PR / SD / PD）
  server.registerTool('imaging_recist_evaluate', {
    description:
      '根据 RECIST 1.1（实体瘤疗效评价标准）评估靶病灶变化等级：' +
      '输入基线长径之和（baseline_sum_mm）与随访长径之和（followup_sum_mm），' +
      '自动计算变化百分比与疗效等级（CR 完全缓解 / PR 部分缓解 / SD 疾病稳定 / PD 疾病进展）。',
    inputSchema: {
      baseline_sum_mm: z.number().min(0.1).describe('基线靶病灶最大长径之和（毫米）'),
      followup_sum_mm: z.number().min(0).describe('本次随访靶病灶最大长径之和（毫米）'),
    },
  }, async ({ baseline_sum_mm, followup_sum_mm }) => {
    const diff = followup_sum_mm - baseline_sum_mm
    const percentChange = round((diff / baseline_sum_mm) * 100, 1)

    let evaluation = 'SD'
    let interpretation = '疾病稳定 (Stable Disease)'

    if (followup_sum_mm === 0) {
      evaluation = 'CR'
      interpretation = '完全缓解 (Complete Response)：所有靶病灶均完全消失。'
    } else if (percentChange <= -30.0) {
      evaluation = 'PR'
      interpretation = `部分缓解 (Partial Response)：靶病灶长径总和缩小 ≥ 30%（当前减少 ${Math.abs(percentChange)}%）。`
    } else if (percentChange >= 20.0 && diff >= 5.0) {
      evaluation = 'PD'
      interpretation = `疾病进展 (Progressive Disease)：靶病灶长径总和增加 ≥ 20% 且绝对值增加 ≥ 5mm（当前增加 ${percentChange}%）。`
    } else {
      evaluation = 'SD'
      interpretation = `疾病稳定 (Stable Disease)：未达到 PR 缩小标准，亦未达到 PD 增大标准（变化率 ${percentChange > 0 ? '+' : ''}${percentChange}%）。`
    }

    return json({
      baseline_sum_mm,
      followup_sum_mm,
      percent_change: `${percentChange > 0 ? '+' : ''}${percentChange}%`,
      recist_category: evaluation,
      interpretation,
      academic_statement: `根据 RECIST 1.1 评价标准，患者靶病灶长径总和由基线 ${baseline_sum_mm} mm 变化至 ${followup_sum_mm} mm（${percentChange > 0 ? '+' : ''}${percentChange}%），疗效评估为 ${evaluation}（${interpretation.split('：')[0]}）。`,
    })
  })

  // 5. 3D 体积几何与空间分布探测 (imaging_volume_info)
  server.registerTool('imaging_volume_info', {
    description:
      '查询 3D 医学影像的几何体素元数据与病灶空间分布：' +
      '返回体素空间维度 (Z/Y/X)、空间分辨率/层厚间距 (dz, dy, dx mm)、' +
      '三大正交切面（轴位 Axial、冠状位 Coronal、矢状位 Sagittal）的总层数与中心推荐层，' +
      '以及病灶的三维空间包围盒 (Bounding Box) 和推荐窗位。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置样本 ID（与 file_path 二选一，必须提供其一）'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI (.nii/.nii.gz) 文件的绝对路径'),
    },
  }, async ({ sample_id, file_path }) => {
    if (!sample_id && !file_path) return noImage()
    try {
      const resp = await fetch(`${workerUrl}/api/v1/mpr/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id, file_path }),
        signal: AbortSignal.timeout(10000),
      })
      if (!resp.ok) return await workerToolFail('mpr_info_failed', resp)
      const data = await resp.json()
      return json({
        status: 'success',
        ...data,
      })
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 6. 3D 多平面重建正交切片提取与资产沉淀 (imaging_mpr_slice)
  server.registerTool('imaging_mpr_slice', {
    description:
      '提取 3D 医学影像的任意正交多平面重建切片 (MPR: 轴位 Axial、冠状位 Coronal、矢状位 Sagittal)：' +
      '支持应用临床窗宽窗位（肺窗 lung、纵隔窗 mediastinum、腹窗 abdomen、骨窗 bone、脑窗 brain）' +
      '与 MONAI 病灶半透明红色遮罩 (Mask Overlay)。切片将自动渲染带有 5cm 标尺、层号 HUD 与物理分辨率的高清图像，' +
      '并直接保存为用户文档资产，返回 asset_id、病灶面积与可直接插入 Markdown 报告的图片语法。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置样本 ID（与 file_path 二选一，必须提供其一）'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI 文件的绝对路径'),
      plane: z.enum(['axial', 'coronal', 'sagittal']).optional().describe('正交切片平面：axial (轴位/横断面), coronal (冠状位/额状面), sagittal (矢状位/侧面)。缺省为 axial'),
      slice_index: z.number().int().min(0).optional().describe('切片层号索引 (0 到 total_slices - 1)。如不提供，则自动定位至病灶中心切片或正中层'),
      window_preset: z.enum(['lung', 'abdomen', 'brain', 'mediastinum', 'bone']).optional().describe('CT 窗宽窗位预设'),
      overlay_mask: z.boolean().optional().describe('是否在切片上叠加 MONAI 自动分割的半透明红色病灶遮罩，缺省为 true'),
      save_asset: z.boolean().optional().describe('是否保存为当前用户的平台文档资产以供报告引用，缺省为 true'),
      label: z.string().max(80).optional().describe('生成的图注标签，例如「图 2 轴位第 115 层支气管扩张病灶」'),
    },
  }, async ({ sample_id, file_path, plane, slice_index, window_preset, overlay_mask, save_asset, label }) => {
    if (!sample_id && !file_path) return noImage()
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/mpr/slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id,
          file_path,
          plane: plane || 'axial',
          slice_index,
          window_preset,
          overlay_mask: overlay_mask !== false,
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) return await workerToolFail('mpr_slice_failed', resp)
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    const b64Data = String(resultData.slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
    if (!b64Data) return fail('no_slice_output', '切片生成成功但未返回图像数据')
    const pngBuffer = Buffer.from(b64Data, 'base64')

    const planeNameMap: Record<string, string> = {
      axial: '轴位',
      coronal: '冠状位',
      sagittal: '矢状位',
    }
    const planeZh = planeNameMap[resultData.plane] || resultData.plane
    const hSpacing = resultData.pixel_spacing_mm?.horizontal ?? 1
    const vSpacing = resultData.pixel_spacing_mm?.vertical ?? 1
    const lesionPx = resultData.lesion_pixel_count ?? 0
    const lesionAreaMm2 = round(lesionPx * hSpacing * vSpacing, 2)

    let assetId: string | undefined
    let markdownInsert: string | undefined

    if (save_asset !== false && claims.p.includes('write')) {
      const assetName = `${label || `mpr-${resultData.plane}-slice-${resultData.slice_index}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuffer,
      })
      assetId = asset.id

      const figCaption = label || `图 MPR ${planeZh}第 ${resultData.slice_index} 层（共 ${resultData.total_slices} 层）`
      const figNote = `3D MPR ${planeZh}第 ${resultData.slice_index} 层切片（窗宽窗位: ${resultData.window?.preset || '标准'}, 分辨率: ${hSpacing}x${vSpacing} mm${lesionAreaMm2 > 0 ? `, 病灶截面积: ${lesionAreaMm2} mm²` : ''}）`
      markdownInsert = `![${figCaption}](asset:${asset.id} "${figNote}")`
    }

    return json({
      status: 'success',
      plane: resultData.plane,
      slice_index: resultData.slice_index,
      total_slices: resultData.total_slices,
      window: resultData.window,
      dimensions: resultData.dimensions,
      pixel_spacing_mm: resultData.pixel_spacing_mm,
      lesion_present: resultData.lesion_present,
      lesion_pixel_count: lesionPx,
      lesion_area_mm2: lesionAreaMm2,
      asset_id: assetId,
      markdown_insert: markdownInsert,
    })
  })

  // 7. 多期随访 RECIST 1.1 影像对比评估 (imaging_longitudinal_compare)
  server.registerTool('imaging_longitudinal_compare', {
    description:
      '对患者的多期医学影像进行纵向随访对比（RECIST 1.1 实体瘤疗效评估 / 气道粘液栓演变）：' +
      '对比基线检查 (Baseline) 与随访检查 (Follow-up) 的靶病灶最大长径 (LD)、短径与 3D 体积变化率，' +
      '自动评定疗效等级（CR 完全缓解 / PR 部分缓解 / SD 疾病稳定 / PD 疾病进展 / 清除 / 改善），' +
      '生成包含双期影像对照、量化演变表格与临床建议的完整结构化评估报告，并支持选择性将对比报告落库为新的病历记录。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      baseline_record_id: z.string().optional().describe('基线影像记录 ID（如不提供则自动选择最早的基线影像）'),
      followup_record_id: z.string().optional().describe('随访影像记录 ID（如不提供则自动选择最新的随访影像）'),
      save_as_record: z.boolean().optional().describe('是否将对比评估报告保存为患者的新病历记录，缺省为 false'),
    },
  }, async ({ patient_id, baseline_record_id, followup_record_id, save_as_record }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    try {
      const aiActor = { userId: claims.u, via: 'ai' as const }
      const result = deps.patients.compareImaging(aiActor, patient_id, {
        baseline_record_id,
        followup_record_id,
        save_as_record,
      })
      return json(result)
    } catch (err: any) {
      return fail('imaging_compare_error', err.message || String(err))
    }
  })

  // 7.1 患者 RECIST 1.1 疗效综合评估与论文级报告生成 (imaging_get_recist_summary)
  const recistSummarySchema = {
    patient_id: z.string().describe('患者 ID'),
    baseline_record_id: z.string().optional().describe('基线影像记录 ID（如不提供则自动选择最早的基线影像）'),
    followup_record_id: z.string().optional().describe('随访影像记录 ID（如不提供则自动选择最新的随访影像）'),
    include_diff_slice: z.boolean().optional().describe('两期记录都有影像来源时，是否同时生成 CT 值差图切片（不配准、要求同网格），缺省 true'),
    label: z.string().max(80).optional().describe('差图图注标签'),
  }

  const handleRecistSummary = async ({
    patient_id,
    baseline_record_id,
    followup_record_id,
    include_diff_slice,
    label,
  }: {
    patient_id: string
    baseline_record_id?: string
    followup_record_id?: string
    include_diff_slice?: boolean
    label?: string
  }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    let comp: any
    try {
      const aiActor = { userId: claims.u, via: 'ai' as const }
      comp = deps.patients.compareImaging(aiActor, patient_id, {
        baseline_record_id,
        followup_record_id,
      })
    } catch (err: any) {
      return fail('imaging_compare_error', err.message || String(err))
    }

    if (comp.is_single_baseline) {
      const b = comp.baseline || {}
      const bm = b.metrics || {}
      const bLd = bm.longest_diameter_mm ?? '-'
      const bVol = bm.total_volume_cm3 ?? '-'
      const tableMd = [
        '| 检查节点 | 检查日期 | 影像检查项目 | 靶病灶长径 (LD) | 靶病灶总体积 | 状态 |',
        '| :--- | :--- | :--- | :--- | :--- | :--- |',
        `| **基线 (Baseline)** | ${b.date || '-'} | ${b.title || '基线 CT'} | ${bLd} mm | ${bVol} cm³ | 已确立基线肿瘤负荷，待随访复查 |`,
      ].join('\n')

      const docMd = [
        '### 实体瘤靶病灶基线负荷指标 (RECIST 1.1)',
        '',
        tableMd,
        '',
        `> **基线状态说明**：${comp.message || '患者当前仅有单期基线影像，已成功建立基线测值。'}`,
      ].join('\n')

      return json({
        status: 'success',
        patient_id: comp.patient_id,
        patient_code: comp.patient_code,
        is_single_baseline: true,
        baseline: comp.baseline,
        markdown_table: tableMd,
        doc_section_markdown: docMd,
        academic_statement: `患者于 ${b.date || '基线'} 完成初始影像检查，靶病灶长径为 ${bLd} mm，三维体积为 ${bVol} cm³，已建立 RECIST 1.1 基线肿瘤负荷指标。`,
      })
    }

    const b = comp.baseline || {}
    const f = comp.followup || {}
    const bm = b.metrics || {}
    const fm = f.metrics || {}
    const rec = comp.recist || {}
    const bLd = rec.baseline_ld_mm ?? bm.longest_diameter_mm ?? 0
    const fLd = rec.followup_ld_mm ?? fm.longest_diameter_mm ?? 0
    const bVol = rec.baseline_volume_cm3 ?? bm.total_volume_cm3 ?? 0
    const fVol = rec.followup_volume_cm3 ?? fm.total_volume_cm3 ?? 0
    const pctLd = rec.percent_change_ld !== undefined ? `${rec.percent_change_ld > 0 ? '+' : ''}${rec.percent_change_ld}%` : '-'
    const pctVol = rec.percent_change_volume !== undefined ? `${rec.percent_change_volume > 0 ? '+' : ''}${rec.percent_change_volume}%` : '-'

    const tableMd = [
      '| 检查节点 | 检查日期 | 影像项目 | 靶病灶长径 (LD) | 靶病灶三维体积 | 疗效/变化 |',
      '| :--- | :--- | :--- | :--- | :--- | :--- |',
      `| **基线 (Baseline)** | ${b.date || '-'} | ${b.title || '基线影像'} | ${bLd} mm | ${bVol} cm³ | 基线测值 |`,
      `| **随访 (Follow-up)** | ${f.date || '-'} | ${f.title || '随访影像'} | ${fLd} mm | ${fVol} cm³ | 随访复查 |`,
      `| **动态演化** | 间隔 ${comp.interval_days ?? 0} 天 | RECIST 1.1: **${rec.category === 'NA' || !rec.category ? `不适用（${rec.na_reason ?? '条件不满足'}）` : `${rec.category_name}（${rec.recist_note}）`}** | **${pctLd}** | **${pctVol}** | ${rec.interpretation || ''} |`,
    ].join('\n')

    let diffAssetId: string | undefined
    let diffMarkdownInsert: string | undefined

    // 差分图只在两期记录都有可用影像来源（sample_id）时生成；没有就不画，不用演示样本代替
    if (include_diff_slice !== false && claims.p.includes('write') && b.imaging_data?.sample_id && f.imaging_data?.sample_id) {
      try {
        const resp = await fetch(`${workerUrl}/api/v1/mpr/diff-slice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseline_id: b.imaging_data.sample_id,
            followup_id: f.imaging_data.sample_id,
            plane: 'axial',
            slice_index: fm.key_slice_index ?? bm.key_slice_index ?? 24,
            threshold_hu: 50,
          }),
          signal: AbortSignal.timeout(15000),
        })
        if (resp.ok) {
          const diffData = await resp.json()
          const b64 = String(diffData.slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
          if (b64) {
            const pngBuf = Buffer.from(b64, 'base64')
            const assetName = `${label || `${comp.patient_code}-recist-diff-slice`}.png`
            const asset = store.putAsset({
              owner: claims.u,
              mime: 'image/png',
              name: assetName,
              bytes: pngBuf,
            })
            diffAssetId = asset.id
            const figCaption = label || `图 靶病灶两期 CT 值差图`
            const figNote = `两期 CT 值差图（未配准；间隔 ${comp.interval_days ?? 0} 天，长径变化 ${pctLd}，体积变化 ${pctVol}，RECIST 1.1: ${rec.category === 'NA' || !rec.category ? '不适用' : `${rec.category_name}，未经阅片确认`}）`
            diffMarkdownInsert = `![${figCaption}](asset:${asset.id} "${figNote}")`
          }
        }
      } catch {
        // Fallback gracefully without diff image
      }
    }

    const docMd = [
      '### 实体瘤靶病灶随访疗效评估 (RECIST 1.1)',
      '',
      tableMd,
      '',
      `> **RECIST 1.1 疗效评定结论**：${rec.academic_statement || ''}`,
      ...(diffMarkdownInsert ? ['', diffMarkdownInsert] : []),
    ].join('\n')

    return json({
      status: 'success',
      patient_id: comp.patient_id,
      patient_code: comp.patient_code,
      recist_category: rec.category,
      recist_category_name: rec.category_name,
      target_type: rec.target_type,
      baseline_ld_mm: bLd,
      followup_ld_mm: fLd,
      percent_change_ld: pctLd,
      baseline_volume_cm3: bVol,
      followup_volume_cm3: fVol,
      percent_change_volume: pctVol,
      interval_days: comp.interval_days,
      interpretation: rec.interpretation,
      academic_statement: rec.academic_statement,
      diff_asset_id: diffAssetId,
      markdown_insert: diffMarkdownInsert,
      markdown_table: tableMd,
      doc_section_markdown: docMd,
      baseline: comp.baseline,
      followup: comp.followup,
    })
  }

  server.registerTool('imaging_get_recist_summary', {
    description:
      '获取患者随访的测量对比摘要：长径与体积变化百分比、RECIST 1.1 分类（条件不满足时为「不适用」，均未经阅片确认），以及可选的两期 CT 值差图：' +
      '对比基线与随访检查，输出对比表与切片资产的 Markdown 片段，' +
      '供 AI 智能体直接插入临床科研方案、病历观察或论文疗效讨论章节。',
    inputSchema: recistSummarySchema,
  }, handleRecistSummary)

  server.registerTool('imaging_patient_recist_summary', {
    description: '获取患者随访测量对比摘要与 Markdown 对比表（同 imaging_get_recist_summary）。',
    inputSchema: recistSummarySchema,
  }, handleRecistSummary)


  // 8. 多模态因果诊断证据链分析 (imaging_evidence_chain)
  server.registerTool('imaging_evidence_chain', {
    description:
      '影像测值与化验指标对照：' +
      '把患者影像量化测值（BAR、高密度粘液栓、结节长径 / 体积等）与化验（嗜酸粒细胞、总 IgE、sIgE、肿瘤标志物、CRP 等）' +
      '对照所列参考阈值，输出「达到 / 未达到 / 缺少数据」的对照表与化验相对参考区间的方向。' +
      '不给诊断结论与处置建议；诊断由医师结合临床判断。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      record_id: z.string().optional().describe('待评估的医学影像记录 ID（如不传则自动选择最新的一份影像分析）'),
      baseline_record_id: z.string().optional().describe('基线影像记录 ID（多期对比场景）'),
      followup_record_id: z.string().optional().describe('随访影像记录 ID（多期对比场景）'),
    },
  }, async ({ patient_id, record_id, baseline_record_id, followup_record_id }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    try {
      const aiActor = { userId: claims.u, via: 'ai' as const }
      const result = deps.patients.getEvidenceChain(aiActor, patient_id, {
        record_id,
        baseline_record_id,
        followup_record_id,
      })
      return json(result)
    } catch (err: any) {
      return fail('imaging_evidence_chain_error', err.message || String(err))
    }
  })

  // 9. 两期逐体素 CT 值差图 (imaging_diff_slice)：不做配准，要求同网格，不给趋势结论
  server.registerTool('imaging_diff_slice', {
    description:
      '两期影像逐体素 CT 值差图（随访 − 基线）。不做配准：两期体素网格（形状与间距）必须一致，否则影像微服务返回 400；' +
      '即使网格一致，未配准时体位差异也会产生差值。红色 = CT 值升高超过阈值，绿色 = 降低超过阈值；' +
      '只返回 CT 值升高 / 降低的体积，不给吸收、进展等趋势结论。',
    inputSchema: {
      baseline_sample_id: z.string().optional().describe('基线样本 ID（不提供时须提供 baseline_file_path）'),
      followup_sample_id: z.string().optional().describe('随访样本 ID（不提供时须提供 followup_file_path）'),
      baseline_file_path: z.string().optional().describe('基线 3D 影像本地文件路径'),
      followup_file_path: z.string().optional().describe('随访 3D 影像本地文件路径'),
      plane: z.enum(['axial', 'coronal', 'sagittal']).optional().describe('正交切片平面：axial, coronal, sagittal，缺省为 axial'),
      slice_index: z.number().int().min(0).optional().describe('切片层号索引'),
      window_preset: z.enum(['lung', 'abdomen', 'brain', 'mediastinum', 'bone']).optional().describe('CT 窗位预设'),
      threshold_hu: z.number().optional().describe('差分检测灵敏度阈值 (HU)，缺省为 50 HU'),
      save_asset: z.boolean().optional().describe('是否将差分切片保存为资产'),
      label: z.string().max(80).optional().describe('图注说明'),
    },
  }, async ({ baseline_sample_id, followup_sample_id, baseline_file_path, followup_file_path, plane, slice_index, window_preset, threshold_hu, save_asset, label }) => {
    if (!baseline_sample_id && !baseline_file_path) return noImage('基线影像')
    if (!followup_sample_id && !followup_file_path) return noImage('随访影像')
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/mpr/diff-slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseline_id: baseline_sample_id,
          followup_id: followup_sample_id,
          baseline_path: baseline_file_path,
          followup_path: followup_file_path,
          plane: plane || 'axial',
          slice_index,
          window_preset,
          threshold_hu: threshold_hu ?? 50,
        }),
        signal: AbortSignal.timeout(20000),
      })
      if (!resp.ok) return await workerToolFail('mpr_diff_failed', resp)
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    const b64Data = String(resultData.slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
    if (!b64Data) return fail('no_diff_slice_output', '差分切片生成成功但未返回图像数据')
    const pngBuffer = Buffer.from(b64Data, 'base64')

    const planeNameMap: Record<string, string> = { axial: '轴位', coronal: '冠状位', sagittal: '矢状位' }
    const planeZh = planeNameMap[resultData.plane] || resultData.plane

    let assetId: string | undefined
    let markdownInsert: string | undefined

    if (save_asset !== false && claims.p.includes('write')) {
      const assetName = `${label || `diff-${resultData.plane}-slice-${resultData.slice_index}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuffer,
      })
      assetId = asset.id
      const figCaption = label || `图 两期 CT 值差图 ${planeZh}第 ${resultData.slice_index} 层`
      const figNote = `两期 CT 值差图（未配准，仅供目视；CT 值升高 ${resultData.statistics_3d?.hu_increased_volume_cm3 ?? '—'} cm³，降低 ${resultData.statistics_3d?.hu_decreased_volume_cm3 ?? '—'} cm³）`
      markdownInsert = `![${figCaption}](asset:${asset.id} "${figNote}")`
    }

    return json({
      status: 'success',
      plane: resultData.plane,
      slice_index: resultData.slice_index,
      total_slices: resultData.total_slices,
      window: resultData.window,
      dimensions: resultData.dimensions,
      statistics_3d: resultData.statistics_3d,
      slice_metrics: resultData.slice_metrics,
      asset_id: assetId,
      markdown_insert: markdownInsert,
    })
  })

  // 10. 标准化医学数据交换格式导出 (imaging_export_standard)
  server.registerTool('imaging_export_standard', {
    description:
      '将患者的医学影像量化分析与多模态因果诊断链导出为国际医学行业标准交换格式：' +
      '支持 HL7 FHIR R4 DiagnosticReport (包含 ImagingStudy 与 Observations) 或 ' +
      'DICOM SR (Structured Reporting, SOP Class 1.2.840.10008.5.1.4.1.1.88.22, TID 1500) 结构化 JSON，' +
      '以便无缝对接三甲医院内网 PACS、EMR/HIS 或区域健康信息平台。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      format: z.enum(['fhir', 'dicom-sr']).describe('导出格式：fhir (HL7 FHIR R4) 或 dicom-sr (DICOM Structured Reporting)'),
      record_id: z.string().optional().describe('指定的医学影像记录 ID（如不传则导出最新影像分析记录）'),
    },
  }, async ({ patient_id, format, record_id }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    try {
      const aiActor = { userId: claims.u, via: 'ai' as const }
      const result = deps.patients.exportImagingStandard(aiActor, patient_id, {
        format,
        record_id,
      })
      return json({
        status: 'success',
        format: result.format,
        filename: result.filename,
        mime: result.mime,
        data: result.data,
      })
    } catch (err: any) {
      return fail('imaging_export_error', err.message || String(err))
    }
  })

  // 11. 全景多模态影像诊断报告生成 (imaging_generate_full_report)
  server.registerTool('imaging_generate_full_report', {
    description:
      '根据患者的医学影像资料（MONAI 3D 病灶量化、RECIST 1.1 靶病灶长短径、CT值分布、关键截面切片）' +
      '与实验室化验（总 IgE、嗜酸粒细胞、肿瘤标志物等）及既往病史，一键生成符合三甲医院与国际放射学标准的' +
      '影像量化所见报告：检查方法（只写影像元数据里有的参数）、影像所见（只列实测值）与相关化验数值；' +
      '不包含诊断结论与治疗建议，可存入患者病历档案。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      record_id: z.string().optional().describe('指定的医学影像记录 ID，缺省为最新影像记录'),
      save_to_records: z.boolean().optional().describe('是否存入患者病历（默认 true）。AI 生成的报告存为「待医生确认」的草稿，AI 不能确认，须医生本人在患者页「待确认」里确认'),
      title: z.string().optional().describe('自定义报告标题'),
    },
  }, async ({ patient_id, record_id, save_to_records, title }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    try {
      const aiActor = { userId: claims.u, via: 'ai' as const }
      const result = deps.patients.generateComprehensiveReport(aiActor, patient_id, {
        record_id,
        save_to_records: save_to_records !== undefined ? save_to_records : true,
        title,
      })
      return json({
        status: 'success',
        patient_id: result.patient_id,
        patient_code: result.patient_code,
        title: result.title,
        exam_date: result.exam_date,
        modality: result.modality,
        saved_record_id: result.saved_record_id,
        saved_status: result.saved_status,
        findings: result.findings,
        impression: result.impression,
        recommendations: result.recommendations,
        full_report_markdown: result.full_report_markdown,
        metrics: result.metrics,
      })
    } catch (err: any) {
      return fail('imaging_full_report_error', err.message || String(err))
    }
  })

  // 12. 3D 影像组学定量特征抽取 (imaging_radiomics)：必须提供 ROI 掩膜
  server.registerTool('imaging_radiomics', {
    description:
      '在给定 ROI 内提取影像组学特征（形状、一阶统计、GLCM、GLRLM）。必须提供 ROI 掩膜来源：' +
      '掩膜文件 / 掩膜样本，或已对同一影像运行过的分割模型名（使用其缓存结果）；没有掩膜时影像微服务返回 400，不会自动圈定病灶。',
    inputSchema: {
      sample_id: z.string().optional().describe('影像样本 ID（与 file_path 二选一，必须提供其一）'),
      file_path: z.string().optional().describe('影像文件路径（DICOM 目录或 NIfTI）'),
      mask_file_path: z.string().optional().describe('ROI 掩膜文件路径（与影像同网格）'),
      mask_sample_id: z.string().optional().describe('ROI 掩膜样本 ID'),
      model_name: z.string().optional().describe('已对该影像运行过的分割模型名（使用其缓存的分割结果作为 ROI）'),
      num_bins: z.number().int().min(8).max(64).optional().describe('纹理矩阵离散化区间数，缺省 16'),
    },
  }, async ({ sample_id, file_path, mask_file_path, mask_sample_id, model_name, num_bins }) => {
    if (!sample_id && !file_path) return noImage()
    if (!mask_file_path && !mask_sample_id && !model_name) return fail('mask_required', '影像组学必须提供 ROI 掩膜（mask_file_path / mask_sample_id），或已运行过的分割模型名 model_name')
    try {
      const resp = await fetch(`${workerUrl}/api/v1/analyze/radiomics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id, file_path, mask_file_path, mask_sample_id, model_name, num_bins: num_bins || 16 }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return await workerToolFail('radiomics_failed', resp)
      return json(await resp.json())
    } catch (err: any) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 13. 交互式点选分割 (imaging_interactive_segment)：经典方法，非神经网络
  server.registerTool('imaging_interactive_segment', {
    description:
      '交互式点选分割（经典方法，非神经网络）：以前景点（如病灶中心）的 CT 值为种子，' +
      'hu_likelihood_gradient 模式按种子 CT 值的高斯似然 × Sobel 梯度加权距离衰减打分后阈值化；fast 模式按 CT 值容差 + 距离范围；' +
      '背景点用于剔除邻近结构。' +
      '自动生成带有点击标记与半透明轮廓的高清切片资产，返回 RECIST 测值、3D 体积与可直接插入报告的 Markdown 语法。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置样本 ID（与 file_path 二选一，必须提供其一）'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI 文件的绝对路径'),
      points: z.array(z.object({
        z: z.number().int().describe('层号索引 Z'),
        y: z.number().int().describe('纵坐标 Y'),
        x: z.number().int().describe('横坐标 X'),
        is_positive: z.boolean().optional().describe('true 为正样本前景点，false 为负样本排斥点，缺省 true'),
      })).optional().describe('交互式点选提示集合 (Prompt Points)'),
      bbox: z.object({
        z_min: z.number().int(),
        z_max: z.number().int(),
        y_min: z.number().int(),
        y_max: z.number().int(),
        x_min: z.number().int(),
        x_max: z.number().int(),
      }).optional().describe('3D 空间外接包围盒提示 (Bounding Box)'),
      window_preset: z.enum(['lung', 'abdomen', 'brain', 'mediastinum', 'bone']).optional().describe('CT 窗宽窗位预设'),
      plane: z.enum(['axial', 'coronal', 'sagittal']).optional().describe('显示平面，缺省 axial'),
      slice_index: z.number().int().optional().describe('指定渲染切片层号（缺省自动对齐至点击层或最大截面）'),
      save_asset: z.boolean().optional().describe('是否将带轮廓切片保存为用户文档资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签，例如「图 3 交互点选分割截面」'),
      mode: z.enum(['hu_likelihood_gradient', 'deep', 'fast']).optional().describe('分割模式：hu_likelihood_gradient（HU 似然 + 梯度的经典交互分割，非神经网络，缺省），fast（CT 值容差 + 距离范围）；deep 已弃用，请使用 hu_likelihood_gradient（仍作为别名接受）'),
    },
  }, async ({ sample_id, file_path, points, bbox, window_preset, plane, slice_index, save_asset, label, mode }) => {
    if (!sample_id && !file_path) return noImage()
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/analyze/interactive-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id,
          file_path,
          points: points || [{ z: 115, y: 256, x: 256, is_positive: true }],
          bbox,
          window_preset: window_preset || 'lung',
          plane: plane || 'axial',
          slice_index,
          mode: !mode || mode === 'deep' ? 'hu_likelihood_gradient' : mode,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return await workerToolFail('interactive_segment_failed', resp)
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    if (save_asset !== false && resultData.slice_png_base64 && claims.p.includes('write')) {
      const b64Data = resultData.slice_png_base64.replace(/^data:image\/png;base64,/, '')
      const pngBuf = Buffer.from(b64Data, 'base64')
      const assetName = `${label || `vista3d-interactive-slice-${resultData.key_slice_index}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuf,
      })
      resultData.asset_id = asset.id
      resultData.markdown_insert = `![${label || `交互点选分割 #${resultData.key_slice_index}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 14. HU 阈值法体成分分析 (imaging_whole_body_segment)：非 TotalSegmentator 神经网络，不判定肌少症
  server.registerTool('imaging_whole_body_segment', {
    description:
      'HU 阈值法体成分分析（经典方法，不是 TotalSegmentator 神经网络）：按 HU 区间划分骨骼肌、内脏脂肪、皮下脂肪；' +
      '未给 L3 层号时用启发式选层（未做椎体识别）。输出骨骼肌面积 (cm²)、SMI（需提供身高，否则为空）、VAT / SAT 面积与比值、肌肉平均 CT 值。' +
      '平台不判定肌少症（相关字段置空）；阈值法分不开肝、脾、肾，不输出这些器官体积。生成颜色编码切片与 Markdown 测值摘要。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置样本 ID（与 file_path 二选一，必须提供其一）'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI 文件的绝对路径'),
      patient_sex: z.enum(['M', 'F']).optional().describe('患者性别 (M/F)，可选，仅随结果记录（平台不据此判定肌少症）'),
      patient_height_m: z.number().positive().optional().describe('患者身高（米），用于计算 SMI；不提供时不计算 SMI'),
      patient_weight_kg: z.number().positive().optional().describe('患者体重（千克），可选'),
      l3_slice_index: z.number().int().optional().describe('指定第三腰椎 L3 椎体横截面层号（缺省由算法自动依据骨骼体素峰值识别）'),
      save_asset: z.boolean().optional().describe('是否将带颜色编码的切片图保存为用户资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签，例如「图 4 L3 层面骨骼肌与内脏脂肪量化」'),
    },
  }, async ({ sample_id, file_path, patient_sex, patient_height_m, patient_weight_kg, l3_slice_index, save_asset, label }) => {
    if (!sample_id && !file_path) return noImage()
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/analyze/whole-body`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id,
          file_path,
          // 性别 / 身高 / 体重缺失时不代入典型值（SMI 依赖身高）
          patient_sex: patient_sex ?? null,
          patient_height_m: patient_height_m ?? null,
          patient_weight_kg: patient_weight_kg ?? null,
          l3_slice_index,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) return await workerToolFail('whole_body_failed', resp)
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    // 平台不判定肌少症：肌少症相关字段一律置空；缺身高时 SMI 置空（不以缺省身高计算）
    const warnings: string[] = []
    const bc = resultData?.body_composition as Record<string, unknown> | undefined
    if (bc) {
      if (patient_height_m === undefined) {
        bc.skeletal_muscle_index_cm2_m2 = null
        warnings.push('未提供患者身高：SMI 无法计算，已置空')
      }
      bc.smi_cutoff = null
      bc.sarcopenia_detected = null
      bc.sarcopenia_status = null
      bc.sarcopenic_obesity = null
      warnings.push('平台不判定肌少症，相关字段已置空；切片图与 summary_markdown 中如出现肌少症字样不可引用')
      resultData.data_warnings = warnings
      if (typeof resultData.summary_markdown === 'string') {
        resultData.summary_markdown = `> **数据提示**：${warnings.join('；')}。\n\n${resultData.summary_markdown}`
      }
    }

    if (save_asset !== false && resultData.key_slice_png_base64 && claims.p.includes('write')) {
      const b64Data = resultData.key_slice_png_base64.replace(/^data:image\/png;base64,/, '')
      const pngBuf = Buffer.from(b64Data, 'base64')
      const sliceIdx = resultData.l3_vertebra_slice_index ?? 0
      const assetName = `${label || `totalsegmentator-l3-slice-${sliceIdx}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuf,
      })
      resultData.asset_id = asset.id
      resultData.markdown_insert = `![${label || `L3 体成分（HU 阈值法）切片 #${sliceIdx}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 15. 可变形配准 (imaging_deformable_register)：用请求给出的两套真实影像，要求同一体素网格
  server.registerTool('imaging_deformable_register', {
    description:
      '对两套影像做可变形配准，输出位移场统计与配准后切片。固定图像与浮动图像都必须给出（样本 ID 或文件路径），' +
      '且须在同一体素网格（不同网格先重采样），否则影像微服务返回 400。',
    inputSchema: {
      fixed_sample_id: z.string().optional().describe('固定图像样本 ID（与 fixed_file_path 二选一）'),
      moving_sample_id: z.string().optional().describe('浮动图像样本 ID（与 moving_file_path 二选一）'),
      fixed_file_path: z.string().optional().describe('固定图像文件路径'),
      moving_file_path: z.string().optional().describe('浮动图像文件路径'),
      iterations: z.number().int().positive().optional().describe('迭代次数，默认 10'),
      smoothing_sigma: z.number().positive().optional().describe('位移场平滑 sigma，默认 1.0'),
      save_asset: z.boolean().optional().describe('是否保存配准后切片为用户资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签'),
    },
  }, async ({ fixed_sample_id, moving_sample_id, fixed_file_path, moving_file_path, iterations, smoothing_sigma, save_asset, label }) => {
    if (!fixed_sample_id && !fixed_file_path) return noImage('固定图像')
    if (!moving_sample_id && !moving_file_path) return noImage('浮动图像')
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/registration/deformable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixed_sample_id, moving_sample_id, fixed_file_path, moving_file_path, iterations: iterations ?? 10, smoothing_sigma: smoothing_sigma ?? 1.0 }),
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) return await workerToolFail('registration_failed', resp)
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    if (save_asset !== false && resultData.registered_slice_png_base64 && claims.p.includes('write')) {
      const b64Data = resultData.registered_slice_png_base64.replace(/^data:image\/png;base64,/, '')
      const pngBuf = Buffer.from(b64Data, 'base64')
      const sliceIdx = resultData.key_slice_index ?? 0
      const assetName = `${label || `deformable-reg-slice-${sliceIdx}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuf,
      })
      resultData.asset_id = asset.id
      resultData.markdown_insert = `![${label || `可变形配准后切片 #${sliceIdx}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 16. PET-CT 融合与 SUV 统计 (imaging_pet_ct_fuse)：真实 CT + PET，同网格；PET 须已是 SUV；须给 ROI 或生理性摄取排除说明
  server.registerTool('imaging_pet_ct_fuse', {
    description:
      'PET-CT 融合显示与 SUV 统计（SUVmax / SUVmean / 阈值体积）。CT 与 PET 都必须给出且在同一网格（先配准重采样）；' +
      'PET 体素值必须已换算为 SUV（本接口不做换算，需设 pet_values_are_suv=true 确认）；' +
      '统计范围必须给 ROI 掩膜，或用 physiological_exclusion_note 说明已如何排除生理性摄取。条件不满足时影像微服务返回 400。不给诊断结论。',
    inputSchema: {
      ct_sample_id: z.string().optional().describe('CT 样本 ID（与 ct_file_path 二选一）'),
      ct_file_path: z.string().optional().describe('CT 文件路径'),
      pet_sample_id: z.string().optional().describe('PET 样本 ID（与 pet_file_path 二选一）'),
      pet_file_path: z.string().optional().describe('PET 文件路径'),
      pet_values_are_suv: z.boolean().describe('确认 PET 体素值已是 SUV（必须为 true）'),
      roi_mask_file_path: z.string().optional().describe('统计用 ROI 掩膜文件（与 CT 同网格）'),
      roi_mask_sample_id: z.string().optional().describe('统计用 ROI 掩膜样本 ID'),
      physiological_exclusion_note: z.string().optional().describe('没有 ROI 时必填：说明 PET 体积已如何排除生理性摄取'),
      tracer: z.string().optional().describe('示踪剂，如 18F-FDG'),
      suv_threshold: z.number().positive().optional().describe('阈值体积使用的 SUV 阈值，默认 2.5'),
      key_slice_index: z.number().int().optional().describe('显示的层号'),
      alpha: z.number().min(0.1).max(0.95).optional().describe('PET 叠加透明度，默认 0.55'),
      save_asset: z.boolean().optional().describe('是否保存融合切片为用户资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签'),
    },
  }, async ({ ct_sample_id, ct_file_path, pet_sample_id, pet_file_path, pet_values_are_suv, roi_mask_file_path, roi_mask_sample_id, physiological_exclusion_note, tracer, suv_threshold, key_slice_index, alpha, save_asset, label }) => {
    if (!ct_sample_id && !ct_file_path) return noImage('CT 影像')
    if (!pet_sample_id && !pet_file_path) return noImage('PET 影像')
    if (pet_values_are_suv !== true) return fail('suv_required', 'PET 体素值必须已换算为 SUV，并设 pet_values_are_suv=true 确认')
    if (!roi_mask_file_path && !roi_mask_sample_id && !physiological_exclusion_note?.trim()) return fail('roi_required', '需提供 ROI 掩膜，或用 physiological_exclusion_note 说明已如何排除生理性摄取')
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/registration/pet-ct-fusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ct_sample_id, ct_file_path, pet_sample_id, pet_file_path, pet_values_are_suv, roi_mask_file_path, roi_mask_sample_id, physiological_exclusion_note, tracer, suv_threshold, key_slice_index, alpha }),
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) return await workerToolFail('pet_ct_fusion_failed', resp)
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    if (save_asset !== false && resultData.fusion_png_base64 && claims.p.includes('write')) {
      const b64Data = resultData.fusion_png_base64.replace(/^data:image\/png;base64,/, '')
      const pngBuf = Buffer.from(b64Data, 'base64')
      const sliceIdx = resultData.key_slice_index ?? 0
      const assetName = `${label || `pet-ct-fusion-slice-${sliceIdx}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuf,
      })
      resultData.asset_id = asset.id
      resultData.markdown_insert = `![${label || `PET-CT 融合切片 #${sliceIdx}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 17. 放疗靶区外扩 (imaging_rtstruct_delineate)：必须提供 GTV 掩膜，平台不自动勾画 GTV
  server.registerTool('imaging_rtstruct_delineate', {
    description:
      '由医生提供的 GTV 掩膜按给定边距外扩生成 CTV / PTV 并计算体积、输出轮廓叠加切片。' +
      '必须提供 CT 影像与同网格的 GTV 掩膜（掩膜文件或样本）；不自动勾画 GTV。外扩结果须由放疗医师 / 物理师审核。',
    inputSchema: {
      sample_id: z.string().optional().describe('CT 样本 ID（与 file_path 二选一）'),
      file_path: z.string().optional().describe('CT 文件路径'),
      gtv_mask_file_path: z.string().optional().describe('GTV 掩膜文件（与 CT 同网格）'),
      gtv_mask_sample_id: z.string().optional().describe('GTV 掩膜样本 ID'),
      ctv_margin_mm: z.number().min(0).max(30).optional().describe('GTV→CTV 外扩（mm），默认 6'),
      ptv_margin_mm: z.number().min(0).max(30).optional().describe('CTV→PTV 外扩（mm），默认 4'),
      key_slice_index: z.number().int().optional().describe('显示的层号'),
      save_asset: z.boolean().optional().describe('是否保存轮廓切片为用户资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签'),
    },
  }, async ({ sample_id, file_path, gtv_mask_file_path, gtv_mask_sample_id, ctv_margin_mm, ptv_margin_mm, key_slice_index, save_asset, label }) => {
    if (!sample_id && !file_path) return noImage('CT 影像')
    if (!gtv_mask_file_path && !gtv_mask_sample_id) return fail('gtv_required', '必须提供 GTV 掩膜（gtv_mask_file_path 或 gtv_mask_sample_id）；平台不自动勾画 GTV')
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/rtstruct/delineate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id, file_path, gtv_mask_file_path, gtv_mask_sample_id, ctv_margin_mm: ctv_margin_mm ?? 6.0, ptv_margin_mm: ptv_margin_mm ?? 4.0, key_slice_index }),
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) return await workerToolFail('rtstruct_delineate_failed', resp)
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }

    if (save_asset !== false && resultData.rtstruct_png_base64 && claims.p.includes('write')) {
      const b64Data = resultData.rtstruct_png_base64.replace(/^data:image\/png;base64,/, '')
      const pngBuf = Buffer.from(b64Data, 'base64')
      const sliceIdx = resultData.key_slice_index ?? 0
      const assetName = `${label || `rtstruct-slice-${sliceIdx}`}.png`
      const asset = store.putAsset({
        owner: claims.u,
        mime: 'image/png',
        name: assetName,
        bytes: pngBuf,
      })
      resultData.asset_id = asset.id
      resultData.markdown_insert = `![${label || `GTV / CTV / PTV 轮廓切片 #${sliceIdx}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 20. 队列级批量医学影像量化与科研宽表流水线
  server.registerTool('imaging_cohort_batch_analyze', {
    description:
      '临床研究队列级批量医学影像量化与科研宽表生成流水线：' +
      '对研究入组的活跃受试者（或指定患者列表）批量调用影像量化分析。' +
      '提取病灶长径、短径、体积、L3 骨骼肌指数 SMI（需身高）与内脏脂肪比例等测值（不含分级与肌少症判定），' +
      '自动生成 Wide-Format 科研宽表 CSV，并沉淀为研究数据集供统计分析、Table 1 基线表或生存分析使用。',
    inputSchema: {
      study_id: z.string().describe('临床研究 ID'),
      patient_ids: z.array(z.string()).optional().describe('可选：指定需要批量处理的患者 ID 列表；不传则自动针对该研究内所有活跃入组受试者'),
      model_id: z.string().optional().describe('分析模型：lung_nodule_segmenter (默认) 或 whole_body_ct_segmenter / totalsegmentator'),
      save_as_dataset: z.boolean().optional().describe('是否将生成的宽表 CSV 自动保存为科研数据集并挂载到研究中，默认 true'),
      dataset_name: z.string().optional().describe('生成的研究数据集名称，默认为「研究队列影像量化特征宽表」'),
    },
  }, async ({ study_id, patient_ids, model_id, save_as_dataset, dataset_name }) => {
    try {
      const a = { userId: claims.u, via: 'ai' as const, space: 'work' as const }
      if (!deps.cohort) {
        return fail('cohort_service_unavailable', '队列研究批量分析服务未就绪，禁止生成虚构受试者数据')
      }
      const res = await deps.cohort.imagingBatchAnalyze(a, study_id, {
        patient_ids,
        model_id,
        save_as_dataset,
        dataset_name,
      })
      return json(res)
    } catch (err) {
      return fail('batch_analyze_error', `批量分析执行异常：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 21. 医学论文全品类制图与原文件导出工作台 (imaging_medical_figure_studio)
  server.registerTool('imaging_medical_figure_studio', {
    description:
      '医学论文 7 大类核心图表生成与原生桌面软件源文件导出工具：' +
      '支持 (1) clinical_cohort 临床队列与预后图（Grotta mRS分布位移图 / 多阶段治疗轨迹 Sankey 桑基图 / 解剖部位共现 UpSet 图 / 多因素 Logistic OR 森林图 / Kaplan-Meier 生存曲线 + Prism .pzfx + R 脚本 .R + Illustrator SVG）；' +
      '(2) mechanism 机制图/图形摘要（BioRender/Figdraw/NIH BioArt 风格矢量图标 + Draw.io .drawio + 可编辑 PPTX + Illustrator 分层 SVG）；' +
      '(3) wet_lab 临床与实验统计图（柱状散点图/箱线小提琴图/4PL药代剂量拟合 + GraphPad Prism .pzfx + R 脚本 .R + OriginPro .csv/.ogs）；' +
      '(4) flowchart 患者筛选流程图（CONSORT 2010 + Draw.io .drawio + Visio .vdx + 可编辑 PPTX）；' +
      '(5) bioinformatics 多组学生信图（火山图/ComplexHeatmap热图/GO-KEGG富集气泡图/单细胞UMAP + R 脚本 .R + 微生信/Hiplot 矩阵 .csv + Prism .pzfx）；' +
      '(6) image_processing 医学影像/流式/病理切片（ImageJ 比例尺与多通道合并宏 .ijm / FlowJo 流式四象限圈门工作区 .wsp / 3D Slicer .mrml + .mrk.json + ITK-SNAP .txt）；' +
      '(7) journal_assembly 顶刊多面板拼图排版（Nature/NEJM/Lancet/JAMA 栏宽规范、统一字体字号、Adobe Illustrator 分层 SVG + 600 DPI PNG + PPTX）。',
    inputSchema: {
      category: z
        .enum(['clinical_cohort', 'mechanism', 'wet_lab', 'flowchart', 'bioinformatics', 'image_processing', 'journal_assembly'])
        .describe('图表大类：clinical_cohort | mechanism | wet_lab | flowchart | bioinformatics | image_processing | journal_assembly'),
      title: z.string().optional().describe('图表主标题'),
      spec: z.record(z.string(), z.any()).describe('对应图表类别的详细配置参数与真实实验/临床数据'),
      save_asset: z.boolean().optional().describe('是否将生成的 SVG/PNG 保存为平台文档资产供文稿直接引用，默认 true'),
    },
  }, async ({ category, title, spec, save_asset }) => {
    try {
      const payload: Record<string, any> = { ...(spec as Record<string, any>), title: title || (spec as any).title || 'Medical Publication Figure' }
      let svgOut: string | undefined
      let nativeSummary: Record<string, unknown> = {}

      if (category === 'clinical_cohort') {
        const subtype = String(payload.subtype || payload.plotType || payload.plot_type || 'grotta') as 'grotta' | 'sankey' | 'upset' | 'logistic' | 'survival'
        const did = typeof payload.dataset_id === 'string' && payload.dataset_id.trim() ? payload.dataset_id.trim() : undefined
        const fallbackRecords = () => (Array.isArray(payload.records) && payload.records.length > 0 ? payload.records : buildDefaultClinicalCohortRecords())
        let res: any
        if (subtype === 'grotta') {
          const opts = {
            group_col: payload.group_col || '第一次治疗方式',
            score_col: payload.score_col || '确诊时mRS',
            score_order: Array.isArray(payload.score_order) ? payload.score_order : undefined,
            labels: payload.labels,
            title: payload.title,
          }
          res = did && deps.datasets ? deps.datasets.grotta(claims.u, did, opts) : generateGrottaPlot(fallbackRecords(), opts)
        } else if (subtype === 'sankey') {
          const opts = {
            stage_cols: Array.isArray(payload.stage_cols) && payload.stage_cols.length >= 2 ? payload.stage_cols : (!payload.sequence_col ? ['第一次治疗方式', '闭塞程度', '治疗后出血'] : undefined),
            sequence_col: payload.sequence_col,
            code_map: payload.code_map,
            outcome_col: payload.outcome_col,
            max_nodes_per_stage: payload.max_nodes_per_stage,
            labels: payload.labels,
            title: payload.title,
          }
          res = did && deps.datasets ? deps.datasets.sankey(claims.u, did, opts) : generateSankeyDiagram(fallbackRecords(), opts)
        } else if (subtype === 'upset') {
          const opts = {
            binary_cols: Array.isArray(payload.binary_cols) && payload.binary_cols.length >= 2 ? payload.binary_cols : ['额叶', '颞叶', '顶叶', '枕叶', '基底节', '脑室'],
            outcome_col: payload.outcome_col || '治疗后出血',
            positive_value: payload.positive_value,
            max_intersections: payload.max_intersections,
            labels: payload.labels,
            title: payload.title,
          }
          res = did && deps.datasets ? deps.datasets.upset(claims.u, did, opts) : generateUpSetPlot(fallbackRecords(), opts)
        } else if (subtype === 'logistic') {
          const opts = {
            outcome_col: payload.outcome_col || '治疗后出血',
            covariates: Array.isArray(payload.covariates) && payload.covariates.length >= 1 ? payload.covariates : ['供血动脉扩张', '单一动脉供血', '基底节', '年龄'],
            positive_value: payload.positive_value,
            labels: payload.labels,
            title: payload.title,
          }
          res = did && deps.datasets ? deps.datasets.logistic(claims.u, did, opts) : generateLogisticRegression(fallbackRecords(), opts)
        } else {
          const opts = {
            time_col: payload.time_col || 'followup_months',
            start_date_col: payload.start_date_col,
            event_date_col: payload.event_date_col,
            censor_date_col: payload.censor_date_col,
            default_censor_date: payload.default_censor_date,
            event_col: payload.event_col || '治疗后出血',
            group_col: payload.group_col || '第一次治疗方式',
            covariates: Array.isArray(payload.covariates) ? payload.covariates : undefined,
            time_unit: payload.time_unit || 'Months',
            title: payload.title,
          }
          res = did && deps.datasets ? deps.datasets.survival(claims.u, did, opts) : generateSurvivalAnalysis(fallbackRecords() as any, opts)
        }
        svgOut = res.native_exports?.illustrator_svg || res.km_svg || res.svg || res.forest_svg
        nativeSummary = res
      } else if (category === 'mechanism') {
        const res = renderMechanismDiagram({
          title: payload.title,
          subtitle: payload.subtitle,
          showCompartments: payload.showCompartments,
          nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
          edges: Array.isArray(payload.edges) ? payload.edges : [],
        })
        svgOut = res.illustrator_svg
        nativeSummary = {
          illustrator_svg: res.illustrator_svg,
          drawio_xml: res.drawio_xml,
          pptx_base64: Buffer.from(res.pptx_bytes).toString('base64'),
        }
      } else if (category === 'wet_lab') {
        const res = generateWetLabPlot({
          plotType: payload.plotType || 'bar_scatter',
          title: payload.title,
          yLabel: payload.yLabel || 'Measurement',
          xLabel: payload.xLabel,
          errorBarType: payload.errorBarType || 'SD',
          groups: payload.groups,
          doseResponse: payload.doseResponse,
        })
        svgOut = res.illustrator_svg
        nativeSummary = {
          illustrator_svg: res.illustrator_svg,
          prism_pzfx: res.prism_pzfx,
          r_script: res.r_script,
          origin_csv: res.origin_csv,
          origin_ogs: res.origin_ogs,
          stats_summary: res.stats_summary,
        }
      } else if (category === 'flowchart') {
        const cData = {
          title: payload.title,
          total_assessed: Number(payload.total_assessed ?? 100),
          exclusions: Array.isArray(payload.exclusions) ? payload.exclusions : [],
          eligible_total: Number(payload.eligible_total ?? 80),
          arms: Array.isArray(payload.arms) ? payload.arms : [],
        }
        svgOut = renderConsortSvg(cData)
        nativeSummary = {
          svg: svgOut,
          drawio_xml: exportFlowchartToDrawio(cData),
          visio_vdx: exportFlowchartToVisioVdx(cData),
          pptx_base64: Buffer.from(exportFlowchartToPptx(cData)).toString('base64'),
        }
      } else if (category === 'bioinformatics') {
        const res = generateBioinformaticsFigure(payload as any)
        svgOut = res.illustrator_svg
        nativeSummary = {
          illustrator_svg: res.illustrator_svg,
          r_script: res.r_script,
          cloud_csv: res.cloud_csv,
          prism_pzfx: res.prism_pzfx,
        }
      } else if (category === 'image_processing') {
        const tool = String(payload.tool || 'imagej')
        if (tool === 'flowjo') {
          const res = generateFlowJoAnalysis({
            title: payload.title,
            xChannel: payload.xChannel || 'FITC-A',
            yChannel: payload.yChannel || 'PE-A',
            xGateThreshold: Number(payload.xGateThreshold ?? 2.5),
            yGateThreshold: Number(payload.yGateThreshold ?? 2.5),
            events: Array.isArray(payload.events) ? payload.events : [],
          })
          svgOut = res.illustrator_svg
          nativeSummary = res
        } else if (tool === 'slicer' || tool === 'itksnap') {
          const res = generateSlicerAndItkSnapPackage({
            patientId: payload.patientId || 'pt_01',
            studyModality: payload.studyModality || 'CT',
            volumeFileName: payload.volumeFileName,
            segmentationFileName: payload.segmentationFileName,
            roiCenterRAS: payload.roiCenterRAS,
            roiSizeMm: payload.roiSizeMm,
            labels: Array.isArray(payload.labels)
              ? payload.labels
              : [{ id: 1, name: 'Primary_Target_ROI', rgb: [220, 38, 38], opacity: 0.85 }],
          })
          nativeSummary = res
        } else {
          const res = generateImageJAnalysis({
            title: payload.title,
            modality: payload.modality || 'immunofluorescence',
            micronsPerPixel: Number(payload.micronsPerPixel ?? 0.5),
            scaleBarMicrons: Number(payload.scaleBarMicrons ?? 50),
            channels: payload.channels,
            quantificationGroups: payload.quantificationGroups,
          })
          svgOut = res.illustrator_svg
          nativeSummary = res
        }
      } else if (category === 'journal_assembly') {
        const res = assembleJournalFigure({
          manuscriptTitle: payload.manuscriptTitle || payload.title,
          journalPreset: payload.journalPreset || 'nature_double',
          columns: payload.columns,
          fontFamily: payload.fontFamily || 'Arial',
          panels: Array.isArray(payload.panels) ? payload.panels : [],
        })
        svgOut = res.illustrator_svg
        nativeSummary = {
          illustrator_svg: res.illustrator_svg,
          png_base64: Buffer.from(res.high_res_png).toString('base64'),
          pptx_base64: Buffer.from(res.pptx_bytes).toString('base64'),
          zip_base64: Buffer.from(res.bundle_zip).toString('base64'),
          manifest: res.manifest,
        }
      }

      let assetId: string | undefined
      if (save_asset !== false && svgOut && claims.p.includes('write')) {
        const asset = store.putAsset({
          owner: claims.u,
          mime: 'image/svg+xml',
          name: `${category}-figure.svg`,
          bytes: Buffer.from(svgOut, 'utf-8'),
        })
        assetId = asset.id
      }

      return json({
        status: 'success',
        category,
        asset_id: assetId,
        markdown_insert: assetId ? `![${payload.title}](asset:${assetId})` : undefined,
        ...nativeSummary,
      })
    } catch (err) {
      return fail('medical_figure_error', err instanceof Error ? err.message : String(err))
    }
  })

}

function round(n: number, d = 1): number {
  const f = Math.pow(10, d)
  return Math.round(n * f) / f
}
