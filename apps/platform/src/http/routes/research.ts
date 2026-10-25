import type { Context, Hono } from 'hono'
import type { Store } from '../../store/db.ts'
import { TenantError } from '../../auth/tenants.ts'
import { StudyError, type StudyService } from '../../research/service.ts'
import { PatientError, type PatientService, type Actor } from '../../tenancy/patients.ts'
import { CohortService } from '../../research/cohort.ts'
import { EcrfService } from '../../research/ecrf.ts'
import {
  renderConsortSvg,
  renderConsortMermaid,
  renderEnrollmentFlowSvg,
  renderEnrollmentFlowMermaid,
  exportFlowchartToDrawio,
  exportFlowchartToVisioVdx,
  exportFlowchartToPptx,
  type ConsortDiagramData,
  type EnrollmentFlowData,
} from '../../research/consort.ts'
import {
  calculateEValue,
  generateLovePlotSvg,
  exportLovePlotNativeSources,
  type EValueInput,
  type LovePlotConfig,
} from '../../research/causal-inference.ts'
import { DatasetError, type DatasetService, type Table1Options, type SurvivalOptions } from '../../datasets/service.ts'
import { exportTable1ToDocx } from '../../datasets/table1-docx.ts'
import {
  buildNomogram,
  calculateRocCurve,
  renderRocCurveSvg,
  calculateDcaCurve,
  renderDcaCurveSvg,
  exportRocDcaNativeSources,
} from '../../research/prediction-models.ts'
import { PublicationBundleService, type PublicationBundleOptions } from '../../research/publication-bundle.ts'
import { SubjectVarService } from '../../research/subject-vars.ts'
import {
  renderMechanismDiagram,
  generateWetLabPlot,
  generateBioinformaticsFigure,
  generateImageJAnalysis,
  generateFlowJoAnalysis,
  generateSlicerAndItkSnapPackage,
  assembleJournalFigure,
  upgradeSvgForIllustrator,
} from '../../research/medical-figures.ts'

export interface ResearchRouteContext {
  store: Store
  studies?: StudyService
  cohort?: CohortService
  patients?: PatientService
  datasets?: DatasetService
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  patientFailure: (c: Context, err: unknown) => Response
}

/**
 * 注册临床研究、研究入组与队列宽表、Auto-eCRF、因果推断敏感度分析、
 * SCI成果打包、数据集分析（Table 1/生存分析/Nomogram/ROC-DCA）相关路由。
 */
export function registerResearchRoutes(
  app: Hono<{ Variables: { user: string } }>,
  ctx: ResearchRouteContext
): void {
  const { store, me, patientFailure, datasets } = ctx

  const studyFailure = (c: Context, err: unknown) => {
    if (err instanceof StudyError) return c.json({ error: err.message, code: err.code }, err.status)
    throw err
  }
  const st = () => {
    if (!ctx.studies) throw new StudyError('unavailable', '临床研究未启用', 400)
    return ctx.studies
  }

  // —— 临床研究项目 ——
  app.get('/api/studies', c => { try { return c.json(st().list(c.get('user'))) } catch (err) { return studyFailure(c, err) } })
  app.post('/api/studies', async c => { try { return c.json(st().create(c.get('user'), await c.req.json()), 201) } catch (err) { return studyFailure(c, err) } })
  app.get('/api/studies/:sid', c => { try { return c.json(st().read(c.get('user'), c.req.param('sid'))) } catch (err) { return studyFailure(c, err) } })
  app.patch('/api/studies/:sid', async c => { try { return c.json(st().update(c.get('user'), c.req.param('sid'), await c.req.json())) } catch (err) { return studyFailure(c, err) } })
  app.delete('/api/studies/:sid', c => { try { return c.json({ ok: true, ...st().remove(c.get('user'), c.req.param('sid')) }) } catch (err) { return studyFailure(c, err) } })
  /** 归入文档 / 数据集：{kind: doc | dataset, ref_id, role?: protocol | manuscript | slides | other} */
  app.post('/api/studies/:sid/items', async c => { try { st().link(c.get('user'), c.req.param('sid'), await c.req.json()); return c.json({ ok: true }, 201) } catch (err) { return studyFailure(c, err) } })
  app.delete('/api/studies/:sid/items/:kind/:rid', c => { try { st().unlink(c.get('user'), c.req.param('sid'), c.req.param('kind'), c.req.param('rid')); return c.json({ ok: true }) } catch (err) { return studyFailure(c, err) } })
  // 研究成员（研究团队协作）：负责人加 / 移成员、改角色、转交；成员自己退出；机构管理员离职交接
  app.get('/api/studies/:sid/members', c => { try { return c.json({ members: st().members(c.get('user'), c.req.param('sid')), role: st().role(c.get('user'), c.req.param('sid')) }) } catch (err) { return studyFailure(c, err) } })
  app.get('/api/studies/:sid/candidates', c => { try { return c.json(st().candidates(c.get('user'), c.req.param('sid'))) } catch (err) { return studyFailure(c, err) } })
  app.post('/api/studies/:sid/members', async c => { try { return c.json(st().addMember(c.get('user'), c.req.param('sid'), await c.req.json()), 201) } catch (err) { return studyFailure(c, err) } })
  app.patch('/api/studies/:sid/members/:uid', async c => { try { return c.json(st().setRole(c.get('user'), c.req.param('sid'), c.req.param('uid'), (await c.req.json<{ role?: unknown }>()).role)) } catch (err) { return studyFailure(c, err) } })
  app.delete('/api/studies/:sid/members/:uid', c => { try { return c.json(st().removeMember(c.get('user'), c.req.param('sid'), c.req.param('uid'))) } catch (err) { return studyFailure(c, err) } })
  app.post('/api/studies/:sid/transfer', async c => { try { return c.json(st().transfer(c.get('user'), c.req.param('sid'), (await c.req.json<{ user_id?: unknown }>()).user_id)) } catch (err) { return studyFailure(c, err) } })
  app.get('/api/tenant/studies', c => { try { return c.json(st().tenantStudies(c.get('user'))) } catch (err) { return studyFailure(c, err) } })
  app.post('/api/studies/:sid/handover', async c => { try { return c.json(st().handover(c.get('user'), c.req.param('sid'), (await c.req.json<{ user_id?: unknown }>()).user_id)) } catch (err) { return studyFailure(c, err) } })

  // —— 研究入组（筛选 → 预览 → 入组；研究数据集）——
  const cohort = ctx.cohort ?? (ctx.studies && ctx.patients ? new CohortService(ctx.studies, ctx.patients, ctx.datasets ?? null) : null)
  const co = () => { if (!cohort) throw new StudyError('unavailable', '研究入组需要启用患者模块', 400); return cohort }
  const cohortFailure = (c: Context, err: unknown) => err instanceof PatientError || err instanceof TenantError ? patientFailure(c, err) : studyFailure(c, err)
  app.get('/api/studies/:sid/cohort', c => { try { return c.json(co().list(me(c), c.req.param('sid'))) } catch (err) { return cohortFailure(c, err) } })
  /** 预览：{sex?, age_min?, age_max?, tags_any?, labs?: [{test, mode: latest | any, op, value}], from?, to?} */
  app.post('/api/studies/:sid/cohort/preview', async c => { try { return c.json(co().preview(me(c), c.req.param('sid'), await c.req.json())) } catch (err) { return cohortFailure(c, err) } })
  /** 入组：{patient_ids, criteria?} */
  app.post('/api/studies/:sid/cohort', async c => { try { return c.json(co().enroll(me(c), c.req.param('sid'), await c.req.json()), 201) } catch (err) { return cohortFailure(c, err) } })
  app.delete('/api/studies/:sid/cohort/:ptid', c => { try { return c.json(co().unenroll(me(c), c.req.param('sid'), c.req.param('ptid'))) } catch (err) { return cohortFailure(c, err) } })
  /** 生成 / 刷新研究数据集：{shape: wide | long, tests?, from?, to?} */
  app.post('/api/studies/:sid/cohort/dataset', async c => { try { return c.json(await co().dataset(me(c), c.req.param('sid'), await c.req.json()), 201) } catch (err) { return cohortFailure(c, err) } })
  /** 队列级批量 3D 影像量化与科研宽表生成：{model_id?, patient_ids?, save_as_dataset?, dataset_name?} */
  app.post('/api/studies/:sid/cohort/imaging-batch', async c => {
    try {
      const body = await c.req.json().catch(() => ({}))
      return c.json(await co().imagingBatchAnalyze(me(c), c.req.param('sid'), body), 200)
    } catch (err) {
      return cohortFailure(c, err)
    }
  })

  /**
   * 受试者流向图：只用平台真实入组记录（在组 / 已移出）。
   * 平台没有筛选人数与排除原因记录，也没有治疗分组登记，因此不画筛选 / 排除环节与分组；
   * 需要完整 CONSORT 图时由用户经 POST 接口提供自己的纳排数据。
   */
  app.get('/api/studies/:sid/cohort/consort', c => {
    try {
      const sid = c.req.param('sid')
      const study = st().get(c.get('user'), sid)
      const listRes = co().list(me(c), sid)
      const withdrawn = listRes.subjects.filter(s => s.status === 'withdrawn').length
      const diagramData: EnrollmentFlowData = {
        title: `${study.title} · Participant Flow`,
        enrolled_ever: listRes.active + withdrawn,
        withdrawn,
        inaccessible: 0,
        analyzed: listRes.active,
        arms: [],
        note: '平台未记录筛选人数、排除原因与治疗分组，因此未绘制 Assessed / Excluded / Allocation 环节。',
      }
      const svg = renderEnrollmentFlowSvg(diagramData)
      const mermaid = renderEnrollmentFlowMermaid(diagramData)
      const drawio_xml = exportFlowchartToDrawio(diagramData)
      const visio_vdx = exportFlowchartToVisioVdx(diagramData)
      const fmt = c.req.query('format')
      if (fmt === 'svg') {
        return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' })
      }
      if (fmt === 'drawio') {
        return c.body(drawio_xml, 200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="Participant_Flow_${sid}.drawio"`,
        })
      }
      if (fmt === 'vdx') {
        return c.body(visio_vdx, 200, {
          'Content-Type': 'application/vnd.visio; charset=utf-8',
          'Content-Disposition': `attachment; filename="Participant_Flow_${sid}.vdx"`,
        })
      }
      if (fmt === 'pptx') {
        const pptx = exportFlowchartToPptx(diagramData)
        return c.body(new Uint8Array(pptx), 200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'Content-Disposition': `attachment; filename="Participant_Flow_${sid}.pptx"`,
        })
      }
      return c.json({ svg, mermaid, drawio_xml, visio_vdx, data: diagramData })
    } catch (err) { return cohortFailure(c, err) }
  })

  /** CONSORT 2010 自定义参数生成流向图（同时支持导出 Draw.io .drawio、Visio .vdx 与 PowerPoint .pptx 原文件） */
  app.post('/api/studies/:sid/cohort/consort', async c => {
    try {
      const sid = c.req.param('sid')
      st().get(c.get('user'), sid)
      const body = await c.req.json<ConsortDiagramData & { export_format?: string }>()
      const svg = renderConsortSvg(body)
      const mermaid = renderConsortMermaid(body)
      const drawio_xml = exportFlowchartToDrawio(body)
      const visio_vdx = exportFlowchartToVisioVdx(body)
      const fmt = body.export_format || c.req.query('format')
      if (fmt === 'drawio') {
        return c.body(drawio_xml, 200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="CONSORT_Flowchart_${sid}.drawio"`,
        })
      }
      if (fmt === 'vdx') {
        return c.body(visio_vdx, 200, {
          'Content-Type': 'application/vnd.visio; charset=utf-8',
          'Content-Disposition': `attachment; filename="CONSORT_Flowchart_${sid}.vdx"`,
        })
      }
      if (fmt === 'pptx') {
        const pptx = exportFlowchartToPptx(body)
        return c.body(new Uint8Array(pptx), 200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'Content-Disposition': `attachment; filename="CONSORT_Flowchart_${sid}.pptx"`,
        })
      }
      return c.json({ svg, mermaid, drawio_xml, visio_vdx, data: body })
    } catch (err) { return cohortFailure(c, err) }
  })

  /** 因果推断：VanderWeele E-value 敏感度分析 */
  app.post('/api/studies/:sid/causal/e-value', async c => {
    try {
      const sid = c.req.param('sid')
      st().get(c.get('user'), sid)
      const body = await c.req.json<EValueInput>()
      if (!body.estimate || !body.ci_lower || !body.ci_upper) {
        return c.json({ error: '必须提供效应估计值 (estimate) 与 95% 置信区间 (ci_lower, ci_upper)' }, 400)
      }
      const res = calculateEValue(body)
      return c.json(res)
    } catch (err) { return studyFailure(c, err) }
  })

  /** 因果推断：Love Plot 协变量平衡散点图生成（含 GraphPad Prism .pzfx 与 R cobalt 脚本导出） */
  app.post('/api/studies/:sid/causal/love-plot', async c => {
    try {
      const sid = c.req.param('sid')
      st().get(c.get('user'), sid)
      const body = await c.req.json<LovePlotConfig & { export_format?: string }>()
      if (!Array.isArray(body.covariates) || !body.covariates.length) {
        return c.json({ error: '必须提供至少一组协变量平衡数据 (covariates)' }, 400)
      }
      const svg = generateLovePlotSvg(body)
      const native = exportLovePlotNativeSources(body)
      const fmt = body.export_format || c.req.query('format')
      if (fmt === 'pzfx') {
        return c.body(native.prism_pzfx, 200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="Love_Plot_${sid}.pzfx"`,
        })
      }
      if (fmt === 'r') {
        return c.body(native.r_script, 200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="Love_Plot_${sid}.R"`,
        })
      }
      return c.json({
        svg,
        illustrator_svg: upgradeSvgForIllustrator(svg, { title: body.title ?? 'Love Plot' }),
        prism_pzfx: native.prism_pzfx,
        r_script: native.r_script,
      })
    } catch (err) { return studyFailure(c, err) }
  })

  /**
   * 医学论文全品类制图与原文件导出工作台 (Medical Paper Figure Studio):
   * 支持生成 6 大类医学论文图表，并导出对应桌面软件的原生工程原文件：
   * - mechanism (机制图/图形摘要): BioRender/Figdraw 风格分层 SVG + Draw.io (.drawio) + 可编辑 PowerPoint (.pptx)
   * - wet_lab (实验与临床统计图): GraphPad Prism (.pzfx) + R (ggplot2/ggpubr .R) + OriginPro (.csv + .ogs)
   * - flowchart (研究设计/CONSORT 流程图): Draw.io (.drawio) + Microsoft Visio (.vdx) + PowerPoint (.pptx)
   * - bioinformatics (多组学/生信图: 火山图/热图/KEGG-GO富集/单细胞UMAP): R (Seurat/ComplexHeatmap/clusterProfiler .R) + 微生信/Hiplot 矩阵 (.csv) + Prism (.pzfx)
   * - image_processing (影像/流式/病理切片): ImageJ 比例尺与多通道合并宏 (.ijm) / FlowJo 圈门工作区 (.wsp) / 3D Slicer (.mrml + .mrk.json) & ITK-SNAP (.txt)
   * - journal_assembly (终极多面板期刊排版拼图): Adobe Illustrator / Inkscape 分层 SVG + 600 DPI 印刷级 PNG + 多面板 PPTX + 全套原文件 ZIP
   */
  app.post('/api/studies/:sid/figures', async c => {
    try {
      const sid = c.req.param('sid')
      st().get(c.get('user'), sid)
      const body = await c.req.json<Record<string, any>>()
      const category = String(body.category || '')
      const exportFormat = String(body.export_format || c.req.query('format') || 'json')

      if (category === 'mechanism') {
        const res = renderMechanismDiagram({
          title: body.title || 'Biological Mechanism & Signal Transduction',
          subtitle: body.subtitle,
          showCompartments: body.showCompartments,
          nodes: Array.isArray(body.nodes) ? body.nodes : [],
          edges: Array.isArray(body.edges) ? body.edges : [],
        })
        if (exportFormat === 'drawio') {
          return c.body(res.drawio_xml, 200, {
            'Content-Type': 'application/xml; charset=utf-8',
            'Content-Disposition': `attachment; filename="Mechanism_${sid}.drawio"`,
          })
        }
        if (exportFormat === 'pptx') {
          return c.body(new Uint8Array(res.pptx_bytes), 200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'Content-Disposition': `attachment; filename="Mechanism_${sid}.pptx"`,
          })
        }
        if (exportFormat === 'svg' || exportFormat === 'ai-svg') {
          return c.body(res.illustrator_svg, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8' })
        }
        return c.json({
          category: 'mechanism',
          svg: res.svg,
          illustrator_svg: res.illustrator_svg,
          drawio_xml: res.drawio_xml,
          pptx_base64: Buffer.from(res.pptx_bytes).toString('base64'),
          native_exports: {
            illustrator_svg: res.illustrator_svg,
            drawio_xml: res.drawio_xml,
            pptx_editable_available: true,
          },
        })
      }

      if (category === 'flowchart') {
        const diagramData: ConsortDiagramData = {
          title: body.title || `${sid} · CONSORT 2010 Participant Flow`,
          total_assessed: Number(body.total_assessed ?? 240),
          exclusions: Array.isArray(body.exclusions)
            ? body.exclusions
            : [
                { reason: '不符合纳入标准 (Did not meet inclusion criteria)', count: 38 },
                { reason: '拒绝签署知情同意 (Declined to participate)', count: 14 },
              ],
          eligible_total: Number(body.eligible_total ?? 188),
          arms: Array.isArray(body.arms)
            ? body.arms
            : [
                { name: '干预组 (Intervention Arm)', allocated: 94, received: 92, lost_to_followup: 3, discontinued: 2, analyzed: 89 },
                { name: '标准对照组 (Control Arm)', allocated: 94, received: 93, lost_to_followup: 4, discontinued: 1, analyzed: 89 },
              ],
        }
        const svg = renderConsortSvg(diagramData)
        const drawio_xml = exportFlowchartToDrawio(diagramData)
        const visio_vdx = exportFlowchartToVisioVdx(diagramData)
        if (exportFormat === 'drawio') {
          return c.body(drawio_xml, 200, {
            'Content-Type': 'application/xml; charset=utf-8',
            'Content-Disposition': `attachment; filename="Flowchart_${sid}.drawio"`,
          })
        }
        if (exportFormat === 'vdx') {
          return c.body(visio_vdx, 200, {
            'Content-Type': 'application/vnd.visio; charset=utf-8',
            'Content-Disposition': `attachment; filename="Flowchart_${sid}.vdx"`,
          })
        }
        if (exportFormat === 'pptx') {
          const pptx = exportFlowchartToPptx(diagramData)
          return c.body(new Uint8Array(pptx), 200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'Content-Disposition': `attachment; filename="Flowchart_${sid}.pptx"`,
          })
        }
        return c.json({
          category: 'flowchart',
          svg,
          illustrator_svg: svg,
          drawio_xml,
          visio_vdx,
          native_exports: {
            illustrator_svg: svg,
            drawio_xml,
            visio_vdx,
            pptx_editable_available: true,
          },
        })
      }

      if (category === 'wet_lab' || category === 'statistical_wetlab') {
        const res = generateWetLabPlot({
          plotType: body.plotType || body.plot_type || body.subtype || 'bar_scatter',
          title: body.title || 'Experimental Statistical Comparison',
          yLabel: body.yLabel || 'Relative Expression',
          xLabel: body.xLabel,
          errorBarType: body.errorBarType || 'SD',
          groups: body.groups,
          doseResponse: body.doseResponse,
        })
        if (exportFormat === 'pzfx') {
          return c.body(res.prism_pzfx, 200, {
            'Content-Type': 'application/xml; charset=utf-8',
            'Content-Disposition': `attachment; filename="GraphPad_Prism_${sid}.pzfx"`,
          })
        }
        if (exportFormat === 'r') {
          return c.body(res.r_script, 200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="Statistical_Plot_${sid}.R"`,
          })
        }
        if (exportFormat === 'origin_csv') {
          return c.body(res.origin_csv, 200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="OriginPro_Worksheet_${sid}.csv"`,
          })
        }
        if (exportFormat === 'origin_ogs') {
          return c.body(res.origin_ogs, 200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="OriginPro_Script_${sid}.ogs"`,
          })
        }
        return c.json({ category: 'wet_lab', ...res })
      }

      if (category === 'bioinformatics') {
        const res = generateBioinformaticsFigure(body as any)
        if (exportFormat === 'r') {
          return c.body(res.r_script, 200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="Bioinformatics_${body.bioType || 'plot'}_${sid}.R"`,
          })
        }
        if (exportFormat === 'csv') {
          return c.body(res.cloud_csv, 200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="Hiplot_Matrix_${body.bioType || 'plot'}_${sid}.csv"`,
          })
        }
        if (exportFormat === 'pzfx' && res.prism_pzfx) {
          return c.body(res.prism_pzfx, 200, {
            'Content-Type': 'application/xml; charset=utf-8',
            'Content-Disposition': `attachment; filename="Volcano_${sid}.pzfx"`,
          })
        }
        return c.json({ category: 'bioinformatics', ...res })
      }

      if (category === 'image_processing') {
        const subType = String(body.tool || 'imagej')
        if (subType === 'flowjo') {
          const res = generateFlowJoAnalysis({
            title: body.title || 'Flow Cytometry Quadrant Gating',
            xChannel: body.xChannel || 'FITC-A (Annexin V)',
            yChannel: body.yChannel || 'PE-A (PI)',
            xGateThreshold: Number(body.xGateThreshold ?? 2.5),
            yGateThreshold: Number(body.yGateThreshold ?? 2.5),
            events: Array.isArray(body.events) ? body.events : [],
          })
          if (exportFormat === 'wsp') {
            return c.body(res.flowjo_wsp_xml, 200, {
              'Content-Type': 'application/xml; charset=utf-8',
              'Content-Disposition': `attachment; filename="FlowJo_Workspace_${sid}.wsp"`,
            })
          }
          return c.json({ category: 'image_processing', tool: 'flowjo', ...res })
        }
        if (subType === 'slicer' || subType === 'itksnap') {
          const res = generateSlicerAndItkSnapPackage({
            patientId: body.patientId || sid,
            studyModality: body.studyModality || 'CT',
            volumeFileName: body.volumeFileName,
            segmentationFileName: body.segmentationFileName,
            roiCenterRAS: body.roiCenterRAS,
            roiSizeMm: body.roiSizeMm,
            labels: Array.isArray(body.labels)
              ? body.labels
              : [{ id: 1, name: 'Primary_Target_Lesion', rgb: [220, 38, 38], opacity: 0.85 }],
          })
          if (exportFormat === 'mrml') {
            return c.body(res.slicer_mrml_xml, 200, {
              'Content-Type': 'application/xml; charset=utf-8',
              'Content-Disposition': `attachment; filename="Slicer_Scene_${sid}.mrml"`,
            })
          }
          if (exportFormat === 'itksnap-txt') {
            return c.body(res.itksnap_labels_txt, 200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Content-Disposition': `attachment; filename="ITK_SNAP_Labels_${sid}.txt"`,
            })
          }
          return c.json({ category: 'image_processing', tool: subType, ...res })
        }
        // Default: ImageJ / Fiji
        const res = generateImageJAnalysis({
          title: body.title || 'Microscopy & Densitometry Calibration',
          modality: body.modality || 'immunofluorescence',
          micronsPerPixel: Number(body.micronsPerPixel ?? 0.5),
          scaleBarMicrons: Number(body.scaleBarMicrons ?? 50),
          channels: body.channels,
          quantificationGroups: body.quantificationGroups,
        })
        if (exportFormat === 'ijm') {
          return c.body(res.imagej_macro_ijm, 200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="ImageJ_Analysis_${sid}.ijm"`,
          })
        }
        return c.json({ category: 'image_processing', tool: 'imagej', ...res })
      }

      if (category === 'journal_assembly' || category === 'assembly') {
        const res = assembleJournalFigure({
          manuscriptTitle: body.manuscriptTitle || body.title || 'Multi-Panel Journal Figure',
          journalPreset: body.journalPreset || body.journal_spec || 'nature_double',
          columns: body.columns,
          fontFamily: body.fontFamily || body.font_family || 'Arial',
          dpi: body.dpi,
          panels: Array.isArray(body.panels) ? body.panels : [],
        })
        if (exportFormat === 'zip') {
          return c.body(new Uint8Array(res.bundle_zip), 200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="Journal_Figure_Assembly_${sid}.zip"`,
          })
        }
        if (exportFormat === 'png') {
          return c.body(new Uint8Array(res.high_res_png), 200, {
            'Content-Type': 'image/png',
            'Content-Disposition': `attachment; filename="Journal_Figure_600DPI_${sid}.png"`,
          })
        }
        if (exportFormat === 'pptx') {
          return c.body(new Uint8Array(res.pptx_bytes), 200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'Content-Disposition': `attachment; filename="Journal_Figure_Panels_${sid}.pptx"`,
          })
        }
        return c.json({
          category: 'journal_assembly',
          illustrator_svg: res.illustrator_svg,
          png_base64: Buffer.from(res.high_res_png).toString('base64'),
          pptx_base64: Buffer.from(res.pptx_bytes).toString('base64'),
          zip_base64: Buffer.from(res.bundle_zip).toString('base64'),
          manifest: res.manifest,
        })
      }

      return c.json(
        {
          error: 'unsupported_figure_category',
          message:
            '请指定有效的图表类别 category: mechanism | wet_lab | bioinformatics | image_processing | journal_assembly',
        },
        400,
      )
    } catch (err) {
      return cohortFailure(c, err)
    }
  })

  // —— Auto-eCRF 多模态数据批量提取与溯源 ——
  const ecrf = ctx.studies && ctx.patients ? new EcrfService(ctx.studies, ctx.patients, datasets ?? null) : null
  app.get('/api/studies/:sid/ecrf/template', c => {
    try {
      if (!ecrf) throw new StudyError('unavailable', 'eCRF 服务未初始化', 400)
      st().get(c.get('user'), c.req.param('sid'))
      return c.json(ecrf.getTemplate())
    } catch (err) { return studyFailure(c, err) }
  })
  app.post('/api/studies/:sid/ecrf/extract', async c => {
    try {
      if (!ecrf) throw new StudyError('unavailable', 'eCRF 服务未初始化', 400)
      const sid = c.req.param('sid')
      const body = await c.req.json<{ variable_ids?: string[] }>().catch(() => ({} as { variable_ids?: string[] }))
      const res = await ecrf.extractCohortEcrf(me(c), sid, body.variable_ids)
      return c.json(res)
    } catch (err) { return cohortFailure(c, err) }
  })
  app.post('/api/studies/:sid/ecrf/save-dataset', async c => {
    try {
      if (!ecrf) throw new StudyError('unavailable', 'eCRF 服务未初始化', 400)
      const sid = c.req.param('sid')
      const body = await c.req.json<{ variable_ids?: string[]; name?: string }>().catch(() => ({} as { variable_ids?: string[]; name?: string }))
      const res = await ecrf.saveDataset(me(c), sid, body)
      return c.json(res, 201)
    } catch (err) { return cohortFailure(c, err) }
  })

  // —— 研究变量（来源与核实状态）：录入 / 导入一律 unverified，只有研究者本人能核实 ——
  const subjectVars = ctx.studies && ctx.patients ? new SubjectVarService(ctx.studies, ctx.patients, datasets ?? null) : null
  const sv = () => { if (!subjectVars) throw new StudyError('unavailable', '研究变量需要启用患者模块', 400); return subjectVars }
  const varFailure = (c: Context, err: unknown) => err instanceof DatasetError
    ? c.json({ error: err.message, code: err.code }, err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400)
    : cohortFailure(c, err)
  app.get('/api/studies/:sid/vars', c => { try { return c.json(sv().list(me(c), c.req.param('sid'))) } catch (err) { return varFailure(c, err) } })
  /** eCRF 手工录入：{entries: [{subject_id, var_id, value}]}；value 为 null 清除 */
  app.post('/api/studies/:sid/vars/manual', async c => {
    try {
      const body = await c.req.json<{ entries?: unknown }>().catch(() => ({} as { entries?: unknown }))
      const entries = Array.isArray(body.entries) ? body.entries.filter((e): e is { subject_id: string; var_id: string; value: unknown } => !!e && typeof e === 'object' && typeof (e as any).subject_id === 'string' && typeof (e as any).var_id === 'string') : []
      if (!entries.length) throw new StudyError('bad_entries', 'entries 不能为空')
      return c.json(sv().manual(me(c), c.req.param('sid'), entries))
    } catch (err) { return varFailure(c, err) }
  })
  /** 从数据集按列映射导入：{dataset_id, subject_col, mapping: {var_id: column}} */
  app.post('/api/studies/:sid/vars/import-dataset', async c => {
    try { return c.json(sv().importDataset(me(c), c.req.param('sid'), await c.req.json())) } catch (err) { return varFailure(c, err) }
  })
  /** 从影像分析记录导入影像变量：{var_ids?, which?: baseline | latest} */
  app.post('/api/studies/:sid/vars/import-imaging', async c => {
    try { return c.json(sv().importImaging(me(c), c.req.param('sid'), await c.req.json().catch(() => ({})))) } catch (err) { return varFailure(c, err) }
  })
  /** 研究者核实：{items: [{subject_id, var_id}]} 或 {var_id}（核实该变量下全部未核实的值） */
  app.post('/api/studies/:sid/vars/verify', async c => {
    try { return c.json(sv().verify(me(c), c.req.param('sid'), await c.req.json().catch(() => ({})))) } catch (err) { return varFailure(c, err) }
  })

  // —— SCI 投稿级成果包一键全量导出打包 (.zip) ——
  const bundleService = ctx.studies && ctx.patients ? new PublicationBundleService(ctx.studies, ctx.patients, datasets ?? null) : null
  app.post('/api/studies/:sid/publication-bundle', async c => {
    try {
      if (!bundleService) throw new StudyError('unavailable', '出版成果包服务未初始化', 400)
      const sid = c.req.param('sid')
      const body = await c.req.json<PublicationBundleOptions>().catch(() => ({} as PublicationBundleOptions))
      const res = await bundleService.buildBundle(me(c), sid, body)
      return c.body(new Uint8Array(res.zipBuffer), 200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(res.filename)}`,
      })
    } catch (err) { return cohortFailure(c, err) }
  })

  // —— 数据集（实验室数据分析） ——
  const datasetFailure = (c: Context, err: unknown) => {
    if (err instanceof DatasetError) return c.json({ error: err.message, code: err.code }, err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400)
    throw err
  }
  /** 数据集所属的研究（数据集页显示「所属研究」并能回到研究；数据集与研究同属一个用户） */
  const studyRef = (id: string) => {
    const it = store.studyOf('dataset', id)
    const stItem = it ? store.getStudy(it.study_id) : undefined
    return stItem ? { id: stItem.id, title: stItem.title } : null
  }
  app.get('/api/datasets', c => c.json((datasets?.list(c.get('user')) ?? []).map(d => ({ ...d, study: studyRef(d.id) }))))
  app.post('/api/datasets', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const form = await c.req.parseBody({ all: true })
    const files = ([] as unknown[]).concat(form.file ?? []).filter((f): f is File => f instanceof File)
    if (files.length === 0) return c.json({ error: '请选择文件' }, 400)
    const out: unknown[] = []
    for (const f of files) {
      try {
        const r = datasets.upload(c.get('user'), f.name, new Uint8Array(await f.arrayBuffer()))
        out.push({ ...r.dataset, duplicate: r.duplicate })
      } catch (err) {
        if (err instanceof DatasetError) out.push({ filename: f.name, error: err.message })
        else throw err
      }
    }
    return c.json(out, 201)
  })
  app.get('/api/datasets/:did', c => {
    try { const d = datasets!.get(c.get('user'), c.req.param('did')); return c.json({ ...d, study: studyRef(d.id) }) } catch (err) { return datasetFailure(c, err) }
  })
  app.get('/api/datasets/:did/preview', c => {
    try { return c.json(datasets!.preview(c.get('user'), c.req.param('did'), Math.min(200, Number(c.req.query('limit')) || 50))) } catch (err) { return datasetFailure(c, err) }
  })
  app.patch('/api/datasets/:did', async c => {
    const body = await c.req.json<{ name?: string; labels?: Record<string, string> }>()
    try { return c.json(datasets!.update(c.get('user'), c.req.param('did'), body)) } catch (err) { return datasetFailure(c, err) }
  })
  /** 疑似身份信息的列：drop 删掉，keep 确认不是身份信息（每一列二选一）。 */
  app.post('/api/datasets/:did/phi', async c => {
    const body = await c.req.json<{ drop?: string[]; keep?: string[] }>()
    try { return c.json(await datasets!.resolvePhi(c.get('user'), c.req.param('did'), body.drop ?? [], body.keep ?? [])) } catch (err) { return datasetFailure(c, err) }
  })
  app.delete('/api/datasets/:did', c => {
    try { datasets!.remove(c.get('user'), c.req.param('did')); return c.json({ ok: true }) } catch (err) { return datasetFailure(c, err) }
  })
  app.post('/api/datasets/:did/table1', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const body = await c.req.json<Table1Options>().catch(() => ({} as Table1Options))
    try { return c.json(datasets.table1(c.get('user'), c.req.param('did'), body)) } catch (err) { return datasetFailure(c, err) }
  })
  /** 原生 Word (.docx) 医学标准三线表导出 */
  app.get('/api/datasets/:did/table1-docx', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const did = c.req.param('did')
    const groupCol = c.req.query('group_col')
    try {
      const d = datasets.get(c.get('user'), did)
      const res = datasets.table1(c.get('user'), did, { group_col: groupCol || undefined })
      const docxBytes = exportTable1ToDocx(res)
      const name = d.name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/g, '_')
      return c.body(new Uint8Array(docxBytes), 200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`Table1_${name}.docx`)}`,
      })
    } catch (err) { return datasetFailure(c, err) }
  })
  app.post('/api/datasets/:did/table1-docx', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const did = c.req.param('did')
    const body = await c.req.json<Table1Options>().catch(() => ({} as Table1Options))
    try {
      const d = datasets.get(c.get('user'), did)
      const res = datasets.table1(c.get('user'), did, body)
      const docxBytes = exportTable1ToDocx(res)
      const name = d.name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/g, '_')
      return c.body(new Uint8Array(docxBytes), 200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`Table1_${name}.docx`)}`,
      })
    } catch (err) { return datasetFailure(c, err) }
  })
  app.post('/api/datasets/:did/survival', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const body = await c.req.json<SurvivalOptions>().catch(() => ({} as SurvivalOptions))
    if (!body.time_col || !body.event_col) {
      return c.json({ error: '必须指定随访时间列 (time_col) 与事件结局列 (event_col)' }, 400)
    }
    try { return c.json(datasets.survival(c.get('user'), c.req.param('did'), body)) } catch (err) { return datasetFailure(c, err) }
  })
  app.post('/api/datasets/:did/imaging-survival', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const body = await c.req.json<any>().catch(() => ({}))
    if (!body.time_col || !body.event_col || !body.biomarker) {
      return c.json({ error: '必须指定时间列 (time_col)、结局列 (event_col) 与影像标志物列 (biomarker)' }, 400)
    }
    try { return c.json(datasets.imagingSurvival(c.get('user'), c.req.param('did'), body)) } catch (err) { return datasetFailure(c, err) }
  })

  // —— 预后列线图与预测模型 (Nomogram & ROC / DCA) ——
  app.post('/api/datasets/:did/nomogram', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const did = c.req.param('did')
    const body = await c.req.json<any>().catch(() => ({}))
    try {
      const ds = datasets.get(c.get('user'), did)
      if (body.predictors && Array.isArray(body.predictors) && body.predictors.length > 0) {
        const res = buildNomogram({
          title: body.title || `${ds.name} · 预后列线图 (Nomogram)`,
          predictors: body.predictors,
          baseline_survival: body.baseline_survival
        })
        return c.json(res)
      }
      // 不再用写死的 β 系数画「示例」列线图：没有真实拟合的模型系数就拒绝
      return c.json({ error: '需要提供由真实模型拟合得到的预测因子与系数 (predictors)；平台不会用示例系数生成列线图' }, 400)
    } catch (err) { return datasetFailure(c, err) }
  })

  app.post('/api/datasets/:did/roc-dca', async c => {
    if (!datasets) return c.json({ error: '数据集未启用' }, 503)
    const did = c.req.param('did')
    const body = await c.req.json<any>().catch(() => ({}))
    try {
      const ds = datasets.get(c.get('user'), did)
      // 结局标签与两组模型预测概率必须来自真实数据，不提供示例数组
      const isNumArr = (x: unknown): x is number[] => Array.isArray(x) && x.length > 0 && x.every(v => typeof v === 'number' && Number.isFinite(v))
      const labels = body.labels
      const probs1 = body.scores_baseline
      const probs2 = body.scores_multimodal
      if (!isNumArr(labels) || !isNumArr(probs1) || !isNumArr(probs2) || probs1.length !== labels.length || probs2.length !== labels.length) {
        return c.json({ error: '需要提供等长的真实结局标签 (labels) 与两组模型预测概率 (scores_baseline、scores_multimodal)；平台不会用示例数据生成 ROC / DCA' }, 400)
      }

      const roc1 = calculateRocCurve(labels, probs1, body.model1_name || '临床基线模型 (Clinical Baseline)', '#94a3b8')
      const roc2 = calculateRocCurve(labels, probs2, body.model2_name || '临床 + 3D 影像组学融合模型', '#0284c7')
      const rocSvg = renderRocCurveSvg([roc1, roc2], `${ds.name} · ROC 诊断效能对比`)

      const dca1 = calculateDcaCurve(labels, probs1, body.model1_name || '临床基线模型', '#94a3b8')
      const dca2 = calculateDcaCurve(labels, probs2, body.model2_name || '临床 + 3D 影像组学模型', '#0284c7')
      const prev = labels.filter((y: number) => y === 1).length / labels.length
      const dcaSvg = renderDcaCurveSvg([dca1, dca2], prev, `${ds.name} · 临床决策曲线 (DCA)`)
      const nativeExports = exportRocDcaNativeSources([roc1, roc2], [dca1, dca2], ds.name)

      return c.json({
        roc: { models: [roc1, roc2], svg: rocSvg },
        dca: { models: [dca1, dca2], svg: dcaSvg, prevalence: prev },
        native_exports: {
          ...nativeExports,
          roc_illustrator_svg: upgradeSvgForIllustrator(rocSvg, { title: `${ds.name} ROC Curve` }),
          dca_illustrator_svg: upgradeSvgForIllustrator(dcaSvg, { title: `${ds.name} DCA Curve` }),
        },
      })
    } catch (err) { return datasetFailure(c, err) }
  })
}
