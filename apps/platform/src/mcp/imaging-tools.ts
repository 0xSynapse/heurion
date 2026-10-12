import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { TokenClaims } from '../auth/token.ts'
import type { Store } from '../store/db.ts'
import type { PatientService } from '../tenancy/patients.ts'
import type { StudyService } from '../research/service.ts'
import type { DatasetService } from '../datasets/service.ts'
import type { CohortService } from '../research/cohort.ts'

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))
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
      if (!resp.ok) return fail('imaging_worker_error', `影像微服务返回 HTTP ${resp.status}`)
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
    description: '获取 MONAI 影像计算节点当前支持的临床深度学习模型清单（例如肺结节分割、腹部多器官分割、脑胶质瘤 BraTS 等）。',
    inputSchema: {},
  }, async () => {
    try {
      const resp = await fetch(`${workerUrl}/api/v1/models`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return fail('imaging_worker_error', `获取模型失败 HTTP ${resp.status}`)
      const data = await resp.json()
      return json(data)
    } catch (err) {
      return fail('imaging_worker_offline', `无法连接 MONAI 影像节点：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 3. 核心工具：3D 影像分析、RECIST 1.1 量化与关键截面插图生成
  server.registerTool('imaging_analyze', {
    description:
      '运行 MONAI 3D 医学影像分析与 RECIST 1.1 肿瘤测量：' +
      '调度硬件加速器（M4 Pro GPU / CUDA）执行 3D 卷积分割，提取最大横截面关键层（Key Slice），' +
      '自动生成带有半透明轮廓、测距卡尺与 5cm 标尺的高清 PNG，并自动保存为当前用户的文档资产。' +
      '返回 asset_id、RECIST 测量指标（长径、短径、体积）以及直接可插入 Markdown 的图片语法。',
    inputSchema: {
      patient_id: z.string().optional().describe('患者 ID（指定时自动提取患者背景、关联最新扫描并在推理完成后自动归档为患者的新影像记录）'),
      model_id: z.string().optional().describe('指定的临床模型 ID，例如 bronchiectasis_mucus_analyzer (支气管扩张与粘液栓), spleen_segmenter, lung_nodule_segmenter, liver_lesion_segmenter, brain_tumor_brats'),
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct (真实全胸部 HRCT 269层), spleen_test (真实人体腹部 CT 96层) 或 prostate_mri (真实人体前列腺 MRI)'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI (.nii/.nii.gz) 文件的绝对路径'),
      window_preset: z.enum(['lung', 'abdomen', 'brain', 'mediastinum']).optional().describe('CT 窗宽窗位预设'),
      benchmark: z.boolean().optional().describe('是否运行 3D 高拟真解剖体素基准测试（未指定 sample_id/file_path 时缺省为 true）'),
      z_slices: z.number().int().min(16).max(256).optional().describe('扫描层数，缺省 48'),
      bar_cutoff: z.number().optional().describe('支气管-伴行动脉比 (BAR) 印戒征扩张切点，缺省 1.10'),
      mucus_min_hu: z.number().optional().describe('常规粘液栓 CT 阈值下限 (HU)，缺省 10.0'),
      mucus_max_hu: z.number().optional().describe('常规粘液栓 CT 阈值上限 (HU)，缺省 75.0'),
      ham_threshold_hu: z.number().optional().describe('高密度粘液栓 (HAM) CT 阈值 (HU)，缺省 70.0 (提示 ABPA)'),
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
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('inference_failed', `MONAI 推理失败 HTTP ${resp.status}: ${errText}`)
      }
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
    const ld = recist.longest_diameter_mm ?? 0
    const vol = recist.total_volume_cm3 ?? 0
    const sliceIdx = recist.key_slice_index ?? 0
    const rads = recist.lung_rads
    const figCaption = label || (recist.has_lesion === false ? '图 1 胸部 CT 扫描横截面（未检出局灶性病灶）' : `图 1 目标病灶 RECIST 1.1 关键截面图（长径 ${ld} mm，体积 ${vol} cm³）`)
    const figNote = recist.has_lesion === false
      ? `图 1 胸部 CT 平扫解剖横截面（第 #${sliceIdx} 层，未检出 ≥ 3 mm 实质结节，Lung-RADS 1 类阴性）`
      : `图 1 3D MONAI CT 肿瘤靶病灶自动分割与最大横截面量化标尺（第 #${sliceIdx} 层，长径 ${ld} mm，短径 ${recist.short_axis_mm ?? 0} mm，总体积 ${vol} cm³${rads ? `，${rads.name}` : ''}）`

    let savedRecordId: string | undefined
    if (patientRow && deps.patients) {
      const findings: string[] = []
      if (recist.has_lesion && ld > 0) findings.push(`RECIST 1.1 靶病灶长径 ${ld} mm，体积 ${vol} cm³`)
      if (rads?.name) findings.push(rads.name)
      if (resultData.clinical_ai_report?.diagnostic_assessment) {
        findings.push(resultData.clinical_ai_report.diagnostic_assessment.replace(/[【】]/g, '').trim())
      }
      const addTags: string[] = []
      if (rads?.category === '4B' || rads?.category === '4A') addTags.push('肺结节待查')
      if (resultData.metrics?.signet_ring_sign) addTags.push('支气管扩张')
      if (resultData.metrics?.high_attenuation_mucus_ham) addTags.push('ABPA疑诊')

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
        short_axis_mm: recist.short_axis_mm ?? 0,
        total_volume_cm3: vol,
        key_slice_index: sliceIdx,
        lung_rads: recist.lung_rads,
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
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct (全胸部 HRCT 269层), spleen_test, prostate_mri'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI (.nii/.nii.gz) 文件的绝对路径'),
    },
  }, async ({ sample_id, file_path }) => {
    try {
      const resp = await fetch(`${workerUrl}/api/v1/mpr/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id: sample_id || 'chest_lung_ct', file_path }),
        signal: AbortSignal.timeout(10000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('mpr_info_failed', `获取 3D 体积信息失败 HTTP ${resp.status}: ${errText}`)
      }
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
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct, spleen_test, prostate_mri'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI 文件的绝对路径'),
      plane: z.enum(['axial', 'coronal', 'sagittal']).optional().describe('正交切片平面：axial (轴位/横断面), coronal (冠状位/额状面), sagittal (矢状位/侧面)。缺省为 axial'),
      slice_index: z.number().int().min(0).optional().describe('切片层号索引 (0 到 total_slices - 1)。如不提供，则自动定位至病灶中心切片或正中层'),
      window_preset: z.enum(['lung', 'abdomen', 'brain', 'mediastinum', 'bone']).optional().describe('CT 窗宽窗位预设'),
      overlay_mask: z.boolean().optional().describe('是否在切片上叠加 MONAI 自动分割的半透明红色病灶遮罩，缺省为 true'),
      save_asset: z.boolean().optional().describe('是否保存为当前用户的平台文档资产以供报告引用，缺省为 true'),
      label: z.string().max(80).optional().describe('生成的图注标签，例如「图 2 轴位第 115 层支气管扩张病灶」'),
    },
  }, async ({ sample_id, file_path, plane, slice_index, window_preset, overlay_mask, save_asset, label }) => {
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/mpr/slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: sample_id || 'chest_lung_ct',
          file_path,
          plane: plane || 'axial',
          slice_index,
          window_preset,
          overlay_mask: overlay_mask !== false,
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('mpr_slice_failed', `提取 MPR 切片失败 HTTP ${resp.status}: ${errText}`)
      }
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
    include_diff_slice: z.boolean().optional().describe('是否同时生成 3D 刚性配准差分吸收热力图切片并保存为图片资产，缺省为 true'),
    label: z.string().max(80).optional().describe('生成的差分切片图注标签，例如「图 2 靶向治疗 3 个月随访 3D 差分热力图」'),
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
      `| **动态演化** | 间隔 ${comp.interval_days ?? 0} 天 | RECIST 1.1: **${rec.category || 'SD'} (${rec.category_name || '疾病稳定'})** | **${pctLd}** | **${pctVol}** | ${rec.interpretation || ''} |`,
    ].join('\n')

    let diffAssetId: string | undefined
    let diffMarkdownInsert: string | undefined

    if (include_diff_slice !== false && claims.p.includes('write')) {
      try {
        const resp = await fetch(`${workerUrl}/api/v1/mpr/diff-slice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseline_id: b.imaging_data?.sample_id || 'chest_lung_ct',
            followup_id: f.imaging_data?.sample_id || 'chest_lung_ct',
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
            const figCaption = label || `图 靶病灶纵向随访 3D 刚性配准差分热力图 (${rec.category || 'RECIST 1.1'})`
            const figNote = `3D 差分热力图（间隔 ${comp.interval_days ?? 0} 天，长径变化 ${pctLd}，体积变化 ${pctVol}，疗效评定: ${rec.category || 'SD'} ${rec.category_name || ''}）`
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
      '获取患者随访的 RECIST 1.1 疗效评估摘要、长径与三维体积变化百分比、学术陈述与差分吸收热力图：' +
      '自主对比基线检查与随访检查，输出包含对比宽表、RECIST 等级 (CR/PR/SD/PD) 与出版级切片资产的 Markdown 片段，' +
      '供 AI 智能体直接插入临床科研方案、病历观察或论文疗效讨论章节。',
    inputSchema: recistSummarySchema,
  }, handleRecistSummary)

  server.registerTool('imaging_patient_recist_summary', {
    description: '获取患者 RECIST 1.1 疗效评估总结及可直接插入科研文稿的 Markdown 宽表与差分热力图（同 imaging_get_recist_summary）。',
    inputSchema: recistSummarySchema,
  }, handleRecistSummary)


  // 8. 多模态因果诊断证据链分析 (imaging_evidence_chain)
  server.registerTool('imaging_evidence_chain', {
    description:
      '多模态因果诊断证据链分析：' +
      '自动将患者医学影像量化病征（如支气管扩张/高密度粘液栓 HAM、或肺结节占位 RECIST 1.1）' +
      '与患者实际化验检验指标（嗜酸性粒细胞 EOS、血清总 IgE、曲霉特异性 sIgE、肿瘤标志物 CEA/CYFRA21-1、炎症指标 CRP/WBC）' +
      '及既往病史标签进行因果三角校验，评估临床指南确诊符合度（如 ISHAM ABPA 标准、RECIST 1.1），' +
      '输出结构化临床证据矩阵、缺漏待查项目建议与诊断印象 Markdown。',
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

  // 9. 3D 体素刚性配准与差分吸收热力图切片 (imaging_diff_slice)
  server.registerTool('imaging_diff_slice', {
    description:
      '提取两期 3D 纵向随访 CT 之间的体素刚性配准与差分吸收热力图切片 (Difference Heatmap Overlay)：' +
      '将随访 CT 空间三线性插值对齐至基线 CT 坐标系，计算三维体素差分矩阵 (ΔHU = Followup - Baseline)。' +
      '生成叠加差分吸收热力图的切片（绿色为吸收退缩区域 ΔHU < -thresh，红色为进展增大/浸润区域 ΔHU > thresh），' +
      '并返回全容积 3D 吸收体素量、新发浸润体素量、净变化体积与总体动态演变趋势。',
    inputSchema: {
      baseline_sample_id: z.string().optional().describe('基线样本 ID，缺省为 chest_lung_ct'),
      followup_sample_id: z.string().optional().describe('随访样本 ID，缺省为 chest_lung_ct'),
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
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/mpr/diff-slice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseline_id: baseline_sample_id || 'chest_lung_ct',
          followup_id: followup_sample_id || 'chest_lung_ct',
          baseline_path: baseline_file_path,
          followup_path: followup_file_path,
          plane: plane || 'axial',
          slice_index,
          window_preset,
          threshold_hu: threshold_hu ?? 50,
        }),
        signal: AbortSignal.timeout(20000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('mpr_diff_failed', `计算 3D 差分热力图失败 HTTP ${resp.status}: ${errText}`)
      }
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
      const figCaption = label || `图 3D 差分热力图 ${planeZh}第 ${resultData.slice_index} 层`
      const figNote = `3D 差分热力图（吸收: ${resultData.statistics_3d?.regressed_volume_cm3} cm³, 进展: ${resultData.statistics_3d?.progressed_volume_cm3} cm³, 总体演变: ${resultData.statistics_3d?.dominant_trend}）`
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
      '《全景多模态影像诊断报告》，涵盖检查方法、影像学所见、影像诊断印象与鉴别处置建议，并可自动存入患者病历档案。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      record_id: z.string().optional().describe('指定的医学影像记录 ID，缺省为最新影像记录'),
      save_to_records: z.boolean().optional().describe('是否将生成的全景报告自动存入患者病历记录档案中（默认为 true）'),
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
        urgency: result.urgency,
        saved_record_id: result.saved_record_id,
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

  // 12. 3D 影像组学定量特征抽取 (imaging_radiomics)
  server.registerTool('imaging_radiomics', {
    description:
      '提取 IBSI 标准 3D 影像组学多维定量生物标志物 (Shape 几何形态、一阶直方图统计、GLCM 灰度共生矩阵、GLRLM 灰度游程矩阵)。' +
      '支持从预置样本、本地路径或患者影像中提取 46 项量化特征，输出扁平特征行（可直接沉淀为科研数据集行）与排版精美的临床报告。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct, spleen_test, prostate_mri'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI 文件的绝对路径'),
      model_name: z.string().optional().describe('用于靶病灶自动分割的模型名称，缺省 lung_nodule_segmenter'),
      num_bins: z.number().int().min(8).max(64).optional().describe('纹理矩阵离散化区间数，缺省 16'),
    },
  }, async ({ sample_id, file_path, model_name, num_bins }) => {
    try {
      const resp = await fetch(`${workerUrl}/api/v1/analyze/radiomics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: sample_id || (!file_path ? 'chest_lung_ct' : undefined),
          file_path,
          model_name: model_name || 'lung_nodule_segmenter',
          num_bins: num_bins || 16,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('radiomics_failed', `影像组学特征提取失败 HTTP ${resp.status}: ${errText}`)
      }
      const data = await resp.json()
      return json(data)
    } catch (err: any) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 13. 交互式点选万物分割 (imaging_interactive_segment - MONAI VISTA-3D)
  server.registerTool('imaging_interactive_segment', {
    description:
      '运行 MONAI VISTA-3D 范式交互式点选万物分割：' +
      '支持接收前景正样本点（Foreground Positive Click，如病灶中心）与背景负样本点（Background Negative Click，如需剔除的邻近骨质/血管），' +
      '结合 3D 边界框约束即时自适应分割任意非标解剖结构或疑难病灶。' +
      '自动生成带有点击标记与半透明轮廓的高清切片资产，返回 RECIST 测值、3D 体积与可直接插入报告的 Markdown 语法。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct, spleen_test, prostate_mri'),
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
      label: z.string().max(80).optional().describe('图注标签，例如「图 3 VISTA-3D 交互点选分割截面」'),
      mode: z.enum(['deep', 'fast']).optional().describe('分割模式：deep (MedSAM / VISTA-3D 深度解剖语义模式), fast (快速启发式 EDT 模式)，缺省为 deep'),
    },
  }, async ({ sample_id, file_path, points, bbox, window_preset, plane, slice_index, save_asset, label, mode }) => {
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/analyze/interactive-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: sample_id || (!file_path ? 'chest_lung_ct' : undefined),
          file_path,
          points: points || [{ z: 115, y: 256, x: 256, is_positive: true }],
          bbox,
          window_preset: window_preset || 'lung',
          plane: plane || 'axial',
          slice_index,
          mode: mode || 'deep',
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('interactive_segment_failed', `交互式分割失败 HTTP ${resp.status}: ${errText}`)
      }
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
      resultData.markdown_insert = `![${label || `MONAI VISTA-3D 交互分割 #${resultData.key_slice_index}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 14. TotalSegmentator 全身体素 104 类解剖分割与肌少症量化 (imaging_whole_body_segment)
  server.registerTool('imaging_whole_body_segment', {
    description:
      '运行 TotalSegmentator 全身体素 104 类解剖结构分割与 L3 断面肌少症 (Sarcopenia) 量化评估：' +
      '提取骨骼肌面积 (SMA cm²)、骨骼肌质量指数 (SMI cm²/m²)、Prado 诊断阈值分层、内脏脂肪 (VAT) 与皮下脂肪 (SAT)、' +
      'VAT/SAT 比值、肌肉衰减密度 (HU，评估肌脂肪浸润 Myosteatosis) 以及全腹部与胸腔主要器官 (肝/脾/肾/肺/骨骼) 3D 容积。' +
      '自动生成多组织颜色编码切片与出版级 Markdown 分析报告。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置临床样本 ID，例如 chest_lung_ct, spleen_test'),
      file_path: z.string().optional().describe('本地 DICOM 序列目录或 NIfTI 文件的绝对路径'),
      patient_sex: z.enum(['M', 'F']).optional().describe('患者性别 (M/F)，用于肌少症切点分层（男性 52.4 cm²/m²，女性 38.5 cm²/m²），缺省 M'),
      patient_height_m: z.number().positive().optional().describe('患者身高（米），用于计算 SMI，缺省 1.72'),
      patient_weight_kg: z.number().positive().optional().describe('患者体重（千克），缺省 68.0'),
      l3_slice_index: z.number().int().optional().describe('指定第三腰椎 L3 椎体横截面层号（缺省由算法自动依据骨骼体素峰值识别）'),
      save_asset: z.boolean().optional().describe('是否将带颜色编码的切片图保存为用户资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签，例如「图 4 L3 层面骨骼肌与内脏脂肪量化」'),
    },
  }, async ({ sample_id, file_path, patient_sex, patient_height_m, patient_weight_kg, l3_slice_index, save_asset, label }) => {
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/analyze/whole-body`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: sample_id || (!file_path ? 'chest_lung_ct' : undefined),
          file_path,
          patient_sex: patient_sex || 'M',
          patient_height_m: patient_height_m || 1.72,
          patient_weight_kg: patient_weight_kg || 68.0,
          l3_slice_index,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('whole_body_failed', `全身体素分割失败 HTTP ${resp.status}: ${errText}`)
      }
      resultData = await resp.json()
    } catch (err) {
      return fail('imaging_worker_offline', `连接影像微服务失败：${err instanceof Error ? err.message : String(err)}`)
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
      resultData.markdown_insert = `![${label || `TotalSegmentator L3 体成分分析切片 #${sliceIdx}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 15. 3D 可变形多模态影像弹性配准 (imaging_deformable_register)
  server.registerTool('imaging_deformable_register', {
    description:
      '运行 3D 可变形多模态影像弹性配准（B-样条 / 自由形变 FFD / Demons 密集位移场矢量）：' +
      '输入固定影像 (fixed volume) 与浮动影像 (moving volume)，计算密集三维形变位移场 (DVF)、' +
      '归一化互相关 (NCC) 与均方误差 (MSE) 优化改善指标，并输出形变对齐切片与流体矢量场叠加渲染图。',
    inputSchema: {
      fixed_sample_id: z.string().optional().describe('固定图像预置样本 ID，例如 pet_ct_pair 或 chest_lung_ct'),
      moving_sample_id: z.string().optional().describe('浮动图像预置样本 ID'),
      fixed_file_path: z.string().optional().describe('固定图像 NIfTI 文件路径'),
      moving_file_path: z.string().optional().describe('浮动图像 NIfTI 文件路径'),
      grid_spacing_voxels: z.number().int().positive().optional().describe('B-样条控制网格间距（体素），默认 8'),
      iterations: z.number().int().positive().optional().describe('优化迭代次数，默认 15'),
      regularization_weight: z.number().positive().optional().describe('平滑正则化系数，默认 0.1'),
      save_asset: z.boolean().optional().describe('是否保存形变位移场及配准后切片为用户资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签，例如「图 1 3D 可变形配准位移场与对齐图」'),
    },
  }, async ({ fixed_sample_id, moving_sample_id, fixed_file_path, moving_file_path, grid_spacing_voxels, iterations, regularization_weight, save_asset, label }) => {
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/registration/deformable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fixed_sample_id: fixed_sample_id || (!fixed_file_path ? 'pet_ct_pair' : undefined),
          moving_sample_id: moving_sample_id || (!moving_file_path ? 'pet_ct_pair' : undefined),
          fixed_file_path,
          moving_file_path,
          grid_spacing_voxels: grid_spacing_voxels || 8,
          iterations: iterations || 15,
          regularization_weight: regularization_weight || 0.1,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('registration_failed', `可变形配准失败 HTTP ${resp.status}: ${errText}`)
      }
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
      resultData.markdown_insert = `![${label || `3D 可变形配准对齐切片 #${sliceIdx}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 16. PET-CT 代谢-解剖融合与定量摄取 (imaging_pet_ct_fuse)
  server.registerTool('imaging_pet_ct_fuse', {
    description:
      '运行 PET-CT 代谢-解剖多模态影像融合与病灶摄取定量分析：' +
      '提取肿瘤区域最大标准摄取值 (SUVmax)、平均摄取值 (SUVmean)、代谢肿瘤体积 (MTV cm³)、' +
      '总病灶糖酵解量 (TLG = SUVmean × MTV) 及肝脏背景本底值，' +
      '生成高对比度 Turbo/Hot 彩色代谢热力图与解剖 CT 的透明度融合切片 (Alpha Blended Overlay) 与放射科结构化融合报告。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置样本 ID，例如 pet_ct_pair'),
      ct_file_path: z.string().optional().describe('CT 解剖序列绝对路径'),
      pet_file_path: z.string().optional().describe('PET 代谢序列绝对路径'),
      suv_threshold_ratio: z.number().min(0.05).max(0.95).optional().describe('代谢肿瘤体积 (MTV) 划分阈值（相对于 SUVmax 比例，默认 0.41 即 41% 临界线）'),
      alpha: z.number().min(0.1).max(0.95).optional().describe('PET 代谢热力图叠加透明度 (0.0~1.0)，默认 0.55'),
      colormap: z.string().optional().describe('PET 假彩色映射表，默认 turbo'),
      save_asset: z.boolean().optional().describe('是否保存融合切片为用户资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签，例如「图 2 肿瘤原发灶 PET-CT 代谢融合切片」'),
    },
  }, async ({ sample_id, ct_file_path, pet_file_path, suv_threshold_ratio, alpha, colormap, save_asset, label }) => {
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/registration/pet-ct-fusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: sample_id || (!ct_file_path ? 'pet_ct_pair' : undefined),
          ct_file_path,
          pet_file_path,
          suv_threshold_ratio: suv_threshold_ratio || 0.41,
          alpha: alpha || 0.55,
          colormap: colormap || 'turbo',
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('pet_ct_fusion_failed', `PET-CT 融合失败 HTTP ${resp.status}: ${errText}`)
      }
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
      resultData.markdown_insert = `![${label || `PET-CT 代谢解剖融合切片 #${sliceIdx}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 17. 放疗靶区智能勾画与 DICOM RT-STRUCT 导出 (imaging_rtstruct_delineate)
  server.registerTool('imaging_rtstruct_delineate', {
    description:
      '放疗靶区三维智能勾画与 DICOM RT-STRUCT 导出：' +
      '基于肿瘤病灶自动生成大体肿瘤区 (GTV)、依据临床浸润边界并严格受皮质骨 (Cortical Bone) 和胸膜外空气解剖物理屏障约束剪裁的临床靶区 (CTV，默认膨胀 6mm 并骨屏障扣除)、' +
      '以及考虑摆位与器官运动误差的计划靶区 (PTV，默认外扩 5mm)。' +
      '计算各类靶区三维体积 (cm³)，输出多靶区彩色轮廓叠加渲染切片与放疗物理师/放疗医师审核报告。',
    inputSchema: {
      sample_id: z.string().optional().describe('预置样本 ID，例如 pet_ct_pair 或 chest_lung_ct'),
      file_path: z.string().optional().describe('CT 序列路径'),
      ctv_margin_mm: z.number().min(0).max(30).optional().describe('GTV 到 CTV 临床浸润外扩距离（毫米），默认 6.0'),
      ptv_margin_mm: z.number().min(0).max(30).optional().describe('CTV 到 PTV 摆位误差外扩距离（毫米），默认 5.0'),
      clip_bone_barrier: z.boolean().optional().describe('是否开启皮质骨 (HU > 250) 解剖屏障阻断剪裁（防止肿瘤靶区不符合解剖规律侵入正常致密骨），默认 true'),
      slice_index: z.number().int().optional().describe('指定切片层号（默认位于肿瘤中心层）'),
      save_asset: z.boolean().optional().describe('是否保存勾画渲染切片为用户资产，缺省 true'),
      label: z.string().max(80).optional().describe('图注标签，例如「图 3 放疗靶区 (GTV/CTV/PTV) 勾画轮廓」'),
    },
  }, async ({ sample_id, file_path, ctv_margin_mm, ptv_margin_mm, clip_bone_barrier, slice_index, save_asset, label }) => {
    let resultData: any
    try {
      const resp = await fetch(`${workerUrl}/api/v1/rtstruct/delineate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: sample_id || (!file_path ? 'pet_ct_pair' : undefined),
          file_path,
          ctv_margin_mm: ctv_margin_mm !== undefined ? ctv_margin_mm : 6.0,
          ptv_margin_mm: ptv_margin_mm !== undefined ? ptv_margin_mm : 5.0,
          clip_bone_barrier: clip_bone_barrier !== false,
          slice_index,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        return fail('rtstruct_delineate_failed', `靶区勾画失败 HTTP ${resp.status}: ${errText}`)
      }
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
      resultData.markdown_insert = `![${label || `放疗靶区 (GTV/CTV/PTV) 勾画切片 #${sliceIdx}`}](asset:${asset.id})`
    }

    return json(resultData)
  })

  // 20. 队列级批量医学影像量化与科研宽表流水线
  server.registerTool('imaging_cohort_batch_analyze', {
    description:
      '临床研究队列级批量医学影像量化与科研宽表生成流水线：' +
      '对研究入组的活跃受试者（或指定患者列表）批量发起高通量 3D 卷积分割与 RECIST / TotalSegmentator 量化。' +
      '提取病灶长径、短径、体积、Lung-RADS、L3 骨骼肌指数 SMI、肌少症与内脏脂肪比例等结构化多模态指标，' +
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
}

function round(n: number, d = 1): number {
  const f = Math.pow(10, d)
  return Math.round(n * f) / f
}
