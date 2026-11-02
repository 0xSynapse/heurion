import { describe, it, expect } from 'vitest'
import { unzipSync } from 'fflate'
import {
  renderMechanismDiagram,
  buildConsortFlowchartGraph,
  exportFlowchartToDrawio,
  exportFlowchartToVisioVdx,
  exportFlowchartToPptx,
  exportToPrismPzfx,
  exportToOriginPro,
  generateWetLabPlot,
  generateBioinformaticsFigure,
  generateImageJAnalysis,
  generateFlowJoAnalysis,
  generateSlicerAndItkSnapPackage,
  assembleJournalFigure,
  upgradeSvgForIllustrator,
  JOURNAL_COLUMN_SPECS,
} from '../src/research/medical-figures.ts'
import { generateSurvivalAnalysis } from '../src/datasets/survival.ts'
import { buildNomogram, exportRocDcaNativeSources } from '../src/research/prediction-models.ts'
import { exportLovePlotNativeSources } from '../src/research/causal-inference.ts'
import type { ConsortDiagramData } from '../src/research/consort.ts'

describe('医学论文全栈图表工作室与原文件导出引擎 (Medical Figure Studio & Native Exports)', () => {
  it('1. 机制图与图形摘要 (BioRender / Figdraw / NIH BioArt / SMART 风格) -> 分层 Illustrator SVG + Draw.io (.drawio) + 可编辑 PowerPoint (.pptx)', () => {
    const res = renderMechanismDiagram({
      title: 'Figure 1A. SGLT2i Cardioprotective Signaling Pathway',
      subtitle: 'Inhibition of NLRP3 inflammasome & restoration of mitochondrial homeostasis',
      journal_spec: 'nature_double',
      palette: 'biorender',
      compartments: [
        { id: 'c1', type: 'extracellular', label: 'Extracellular Space', y_start_ratio: 0, y_end_ratio: 0.22 },
        { id: 'c2', type: 'membrane', label: 'Sarcolemma Lipid Bilayer', y_start_ratio: 0.22, y_end_ratio: 0.34 },
        { id: 'c3', type: 'cytoplasm', label: 'Cardiomyocyte Cytosol', y_start_ratio: 0.34, y_end_ratio: 0.78 },
        { id: 'c4', type: 'nucleus', label: 'Nucleus (Transcriptional Regulation)', y_start_ratio: 0.78, y_end_ratio: 1.0 },
      ],
      nodes: [
        { id: 'n1', icon: 'drug_molecule', label: 'Dapagliflozin', sublabel: 'SGLT2 Inhibitor', x: 180, y: 80 },
        { id: 'n2', icon: 'receptor', label: 'SGLT2 / NHE1', sublabel: 'Transmembrane', x: 180, y: 170 },
        { id: 'n3', icon: 'mitochondria', label: 'Mitochondria', sublabel: 'ATP ↑ / ROS ↓', x: 180, y: 310 },
        { id: 'n4', icon: 'protein', label: 'NLRP3 Inflammasome', sublabel: 'IL-1β / IL-18 ↓', x: 450, y: 310 },
        { id: 'n5', icon: 'dna_helix', label: 'PGC-1α / NRF2', sublabel: 'Antioxidant Genes', x: 310, y: 470 },
        { id: 'n6', icon: 'heart', label: 'Myocardial Remodeling', sublabel: 'LVEF ↑ / Fibrosis ↓', x: 640, y: 310 },
      ],
      edges: [
        { from: 'n1', to: 'n2', type: 'inhibition', label: 'Blocks' },
        { from: 'n2', to: 'n3', type: 'activation', label: 'Restores Ca²⁺' },
        { from: 'n3', to: 'n4', type: 'inhibition', label: 'Suppresses ROS' },
        { from: 'n3', to: 'n5', type: 'translocation', label: 'Activates' },
        { from: 'n4', to: 'n6', type: 'inhibition', label: 'Attenuates' },
      ],
    })

    expect(res.svg).toContain('<svg')
    expect(res.svg).toContain('inkscape:groupmode="layer"')
    expect(res.svg).toContain('Sarcolemma Lipid Bilayer')
    expect(res.svg).toContain('Dapagliflozin')
    expect(res.svg).toContain('NLRP3 Inflammasome')
    expect(res.attribution).toContain('CC BY 4.0')

    // Draw.io (.drawio) 原生 XML 验证
    expect(res.drawio_xml).toContain('<mxfile')
    expect(res.drawio_xml).toContain('<mxGraphModel')
    expect(res.drawio_xml).toContain('Dapagliflozin')
    expect(res.drawio_xml).toContain('NLRP3 Inflammasome')

    // PowerPoint (.pptx) 可编辑原生形状与连接线验证
    expect(res.pptx_bytes).toBeInstanceOf(Uint8Array)
    const unzipped = unzipSync(res.pptx_bytes)
    expect(unzipped['ppt/slides/slide1.xml']).toBeDefined()
    const slideXml = new TextDecoder().decode(unzipped['ppt/slides/slide1.xml'])
    expect(slideXml).toContain('<p:sp>')
    expect(slideXml).toContain('<p:cxnSp>')
    expect(slideXml).toContain('Dapagliflozin')
  })

  it('2. 临床与实验统计图 (GraphPad Prism / R ggplot2 / OriginPro) -> 柱状散点图、箱线/小提琴图、IC50/EC50 剂量反应曲线及 .pzfx / .R / .csv+.ogs 导出', () => {
    // 2a. 带抖动散点与 Welch t 检验显著性星号横线的柱状图
    const barPlot = generateWetLabPlot({
      plot_type: 'bar_scatter',
      title: 'Figure 2A. Serum NT-proBNP Reduction Across Treatment Arms',
      y_label: 'NT-proBNP (pg/mL)',
      error_bar: 'SD',
      groups: [
        { name: 'Vehicle', values: [1420, 1580, 1390, 1610, 1495, 1530] },
        { name: 'Dapa 5mg', values: [1120, 1050, 1190, 980, 1090, 1140] },
        { name: 'Dapa 10mg', values: [780, 840, 720, 690, 810, 750] },
      ],
      comparisons: [
        { group1: 'Vehicle', group2: 'Dapa 5mg' },
        { group1: 'Vehicle', group2: 'Dapa 10mg' },
      ],
    })

    expect(barPlot.svg).toContain('<svg')
    expect(barPlot.svg).toContain('inkscape:groupmode="layer"')
    expect(barPlot.svg).toContain('NT-proBNP (pg/mL)')
    expect(barPlot.stats_summary.length).toBe(2)
    expect(barPlot.stats_summary[1]!.p_value).toBeLessThan(0.001)
    expect(barPlot.stats_summary[1]!.stars).toContain('*')

    // GraphPad Prism .pzfx XML 结构验证
    expect(barPlot.prism_pzfx).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(barPlot.prism_pzfx).toContain('<GraphPadPrismFile PrismXMLVersion="5.00"')
    expect(barPlot.prism_pzfx).toContain('TableType="OneWay"')
    expect(barPlot.prism_pzfx).toContain('<Title>Vehicle</Title>')
    expect(barPlot.prism_pzfx).toContain('<Title>Dapa 10mg</Title>')

    // R 语言 (ggplot2 + ggpubr) 脚本验证
    expect(barPlot.r_script).toContain('library(ggplot2)')
    expect(barPlot.r_script).toContain('geom_jitter')
    expect(barPlot.r_script).toContain('Vehicle')

    // OriginPro (.csv + LabTalk .ogs) 验证
    expect(barPlot.origin_csv).toContain('Long Name')
    expect(barPlot.origin_csv).toContain('Designation')
    expect(barPlot.origin_ogs).toContain('[Main]')
    expect(barPlot.origin_ogs).toContain('plotxy')

    // 2b. 箱线图 + 小提琴图
    const boxPlot = generateWetLabPlot({
      plot_type: 'box_violin',
      title: 'Figure 2B. LVEF (%) Distribution by Cohort',
      y_label: 'LVEF (%)',
      groups: [
        { name: 'Control', values: [28, 30, 31, 29, 33, 27, 30] },
        { name: 'Intervention', values: [38, 42, 40, 39, 44, 41, 37] },
      ],
    })
    expect(boxPlot.svg).toContain('LVEF (%)')
    expect(boxPlot.prism_pzfx).toContain('<GraphPadPrismFile')

    // 2c. 4PL 药代/药效剂量反应曲线 (IC50 / EC50)
    const dosePlot = generateWetLabPlot({
      plot_type: 'dose_response',
      title: 'Figure 2C. Dose-Response Inhibition of Fibroblast Activation',
      x_label: 'Log10[Concentration (nM)]',
      y_label: 'Relative Activity (%)',
      groups: [],
      dose_response_series: [
        {
          name: 'Compound-A',
          ic50: 12.5,
          hill_slope: -1.1,
          bottom: 5,
          top: 98,
          points: [
            { dose: 0.1, responses: [96, 98, 95] },
            { dose: 1, responses: [88, 91, 86] },
            { dose: 10, responses: [54, 58, 51] },
            { dose: 100, responses: [14, 18, 12] },
            { dose: 1000, responses: [6, 7, 5] },
          ],
        },
      ],
    })
    expect(dosePlot.svg).toContain('Compound-A')
    expect(dosePlot.svg).toContain('IC50 = 12.5')
    expect(dosePlot.prism_pzfx).toContain('TableType="XY"')

    // 2d. 生存分析、列线图、ROC/DCA、Love Plot 原生导出挂接验证
    const surv = generateSurvivalAnalysis(
      [
        { t: 6, e: 0, arm: 'Treatment' },
        { t: 12, e: 1, arm: 'Treatment' },
        { t: 18, e: 0, arm: 'Treatment' },
        { t: 5, e: 1, arm: 'Placebo' },
        { t: 9, e: 1, arm: 'Placebo' },
        { t: 14, e: 0, arm: 'Placebo' },
      ],
      { time_col: 't', event_col: 'e', group_col: 'arm', covariates: ['arm'] },
    )
    expect(surv.native_exports?.prism_pzfx).toContain('TableType="Survival"')
    expect(surv.native_exports?.r_script).toContain('library(survminer)')
    expect(surv.native_exports?.illustrator_svg).toContain('inkscape:groupmode="layer"')

    const nomo = buildNomogram({
      title: '1-Year Heart Failure Readmission Nomogram',
      predictors: [
        { variable: 'age', label: 'Age (years)', min_val: 40, max_val: 85, beta: 0.04 },
        { variable: 'nt_pro_bnp', label: 'NT-proBNP (pg/mL)', min_val: 100, max_val: 5000, beta: 0.0005 },
      ],
    })
    expect(nomo.native_exports?.r_script).toContain('library(rms)')
    expect(nomo.native_exports?.illustrator_svg).toContain('inkscape:groupmode="layer"')

    const rocNative = exportRocDcaNativeSources(
      [{ model_name: 'Multimodal', auc: 0.86, auc_ci: [0.80, 0.92], optimal_cutoff: 0.5, sensitivity: 0.85, specificity: 0.80, youden_index: 0.65, color: '#be123c', points: [{ fpr: 0, tpr: 0, threshold: 1 }, { fpr: 0.2, tpr: 0.85, threshold: 0.5 }, { fpr: 1, tpr: 1, threshold: 0 }] }],
      [{ model_name: 'Multimodal', color: '#be123c', points: [{ threshold: 0.1, net_benefit: 0.25 }, { threshold: 0.3, net_benefit: 0.15 }] } as any],
      'ROC & DCA',
    )
    expect(rocNative.prism_pzfx).toContain('<GraphPadPrismFile')
    expect(rocNative.r_script).toContain('library(pROC)')
    expect(rocNative.r_script).toContain('library(rmda)')

    const loveNative = exportLovePlotNativeSources({
      title: 'Love Plot Balance',
      covariates: [{ name: 'age', label_zh: 'Age', pre_smd: 0.24, post_smd: 0.03 }],
    })
    expect(loveNative.prism_pzfx).toContain('<GraphPadPrismFile')
    expect(loveNative.r_script).toContain('love.plot')
  })

  it('3. 研究设计与患者筛选流程图 (Visio / PowerPoint / Draw.io) -> CONSORT 2010 导出 .drawio / .vdx / .pptx', () => {
    const consortData: ConsortDiagramData = {
      title: 'CONSORT 2010 Flow Diagram',
      total_assessed: 1200,
      exclusions: [
        { reason: 'Did not meet inclusion criteria', count: 210 },
        { reason: 'Declined to participate', count: 90 },
      ],
      eligible_total: 900,
      arms: [
        { name: 'Intervention Arm', allocated: 450, lost_to_followup: 10, discontinued: 5, analyzed: 435 },
        { name: 'Control Arm', allocated: 450, lost_to_followup: 12, discontinued: 8, analyzed: 430 },
      ],
    }

    const graph = buildConsortFlowchartGraph(consortData)
    expect(graph.nodes.length).toBeGreaterThanOrEqual(7)
    expect(graph.edges.length).toBeGreaterThanOrEqual(6)

    const drawioXml = exportFlowchartToDrawio(consortData)
    expect(drawioXml).toContain('<mxfile')
    expect(drawioXml).toContain('1,200')
    expect(drawioXml).toContain('Intervention Arm')

    const visioVdx = exportFlowchartToVisioVdx(consortData)
    expect(visioVdx).toContain('<VisioDocument')
    expect(visioVdx).toContain('<Shapes>')
    expect(visioVdx).toContain('<Connects>')
    expect(visioVdx).toContain('Intervention Arm')

    const pptxBytes = exportFlowchartToPptx(consortData)
    const unzipped = unzipSync(pptxBytes)
    const slideXml = new TextDecoder().decode(unzipped['ppt/slides/slide1.xml'])
    expect(slideXml).toContain('<p:sp>')
    expect(slideXml).toContain('<p:cxnSp>')
    expect(slideXml).toContain('CONSORT 2010 Flow Diagram')
  })

  it('4. 多组学与生物信息学图表 (R Seurat / ComplexHeatmap / clusterProfiler & 微生信/Hiplot/仙桃学术格式) -> 火山图、热图、GO/KEGG 富集气泡图、单细胞 UMAP', () => {
    // 4a. 火山图 (Volcano Plot)
    const volcano = generateBioinformaticsFigure({
      bio_type: 'volcano',
      title: 'Figure 4A. Differential Gene Expression (RNA-seq)',
      fc_cutoff: 1.0,
      p_cutoff: 0.05,
      volcano_genes: [
        { gene: 'NPPB', log2FC: -2.4, p_value: 0.00001 },
        { gene: 'NPPA', log2FC: -1.9, p_value: 0.0001 },
        { gene: 'PPARGC1A', log2FC: 2.1, p_value: 0.00005 },
        { gene: 'SOD2', log2FC: 1.5, p_value: 0.002 },
        { gene: 'ACTB', log2FC: 0.1, p_value: 0.65 },
      ],
    })
    expect(volcano.svg).toContain('NPPB')
    expect(volcano.svg).toContain('PPARGC1A')
    expect(volcano.r_script).toContain('library(ggrepel)')
    expect(volcano.cloud_matrix_csv).toContain('Gene,log2FoldChange,pvalue')
    expect(volcano.prism_pzfx).toContain('<GraphPadPrismFile')

    // 4b. 复杂热图 (ComplexHeatmap)
    const heatmap = generateBioinformaticsFigure({
      bio_type: 'heatmap',
      title: 'Figure 4B. Top Differentially Expressed Cardiomyocyte Genes',
      heatmap_matrix: {
        row_names: ['NPPB', 'MYH7', 'COL1A1', 'PPARGC1A'],
        col_names: ['Ctrl_1', 'Ctrl_2', 'Dapa_1', 'Dapa_2'],
        col_groups: ['Control', 'Control', 'Dapagliflozin', 'Dapagliflozin'],
        values: [
          [1.8, 1.6, -1.5, -1.7],
          [1.4, 1.2, -1.1, -1.3],
          [1.5, 1.7, -1.4, -1.6],
          [-1.6, -1.4, 1.7, 1.5],
        ],
      },
    })
    expect(heatmap.svg).toContain('PPARGC1A')
    expect(heatmap.r_script).toContain('library(ComplexHeatmap)')
    expect(heatmap.cloud_matrix_csv).toContain('Ctrl_1,Ctrl_2,Dapa_1,Dapa_2')

    // 4c. KEGG / GO 富集分析气泡图 (clusterProfiler)
    const enrich = generateBioinformaticsFigure({
      bio_type: 'enrichment',
      title: 'Figure 4C. KEGG Pathway Enrichment Analysis',
      enrichment_terms: [
        { term: 'Oxidative phosphorylation', category: 'KEGG', gene_ratio: 0.18, count: 28, fdr: 1.2e-6 },
        { term: 'Cardiac muscle contraction', category: 'KEGG', gene_ratio: 0.14, count: 19, fdr: 4.5e-5 },
        { term: 'NOD-like receptor signaling pathway', category: 'KEGG', gene_ratio: 0.11, count: 15, fdr: 0.0008 },
      ],
    })
    expect(enrich.svg).toContain('Oxidative phosphorylation')
    expect(enrich.r_script).toContain('library(clusterProfiler)')
    expect(enrich.cloud_matrix_csv).toContain('Term,Category,GeneRatio,Count,FDR')

    // 4d. 单细胞降维聚类图 (Seurat UMAP)
    const umap = generateBioinformaticsFigure({
      bio_type: 'umap',
      title: 'Figure 4D. scRNA-seq UMAP Atlas of Myocardial Tissue',
      umap_cells: [
        { id: 'c1', x: -4.2, y: 3.1, cluster: 'Cardiomyocytes' },
        { id: 'c2', x: -3.8, y: 2.9, cluster: 'Cardiomyocytes' },
        { id: 'c3', x: 2.5, y: -1.8, cluster: 'Fibroblasts' },
        { id: 'c4', x: 2.8, y: -2.1, cluster: 'Fibroblasts' },
        { id: 'c5', x: 0.5, y: 4.5, cluster: 'Endothelial' },
      ],
    })
    expect(umap.svg).toContain('Cardiomyocytes')
    expect(umap.svg).toContain('Fibroblasts')
    expect(umap.r_script).toContain('library(Seurat)')
    expect(umap.r_script).toContain('DimPlot')
  })

  it('5. 医学影像、流式与病理切片处理 -> ImageJ (Fiji) .ijm 宏与比例尺、FlowJo .wsp 圈门工作区、3D Slicer (.mrml/.mrk.json) & ITK-SNAP (.txt)', () => {
    // 5a. ImageJ (Fiji) 比例尺标定、多通道免疫荧光合成与 Western Blot 灰度定量
    const ij = generateImageJAnalysis({
      mode: 'western_blot',
      title: 'Figure 5A. Western Blot Densitometry & Scale Bar Calibration',
      pixel_to_um_ratio: 2.5,
      scale_bar_um: 50,
      image_width_px: 512,
      image_height_px: 384,
      channels: ['DAPI (Blue)', 'α-SMA (Green)', 'NLRP3 (Red)'],
      wb_lanes: [
        { lane: 'Ctrl-1', group: 'Control', target_band_density: 18500, loading_control_density: 24000 },
        { lane: 'Ctrl-2', group: 'Control', target_band_density: 19200, loading_control_density: 23800 },
        { lane: 'Dapa-1', group: 'Dapa', target_band_density: 8400, loading_control_density: 24200 },
        { lane: 'Dapa-2', group: 'Dapa', target_band_density: 7900, loading_control_density: 23900 },
      ],
    })
    expect(ij.svg).toContain('50 μm')
    expect(ij.ijm_macro).toContain('run("Set Scale..."')
    expect(ij.ijm_macro).toContain('run("Scale Bar..."')
    expect(ij.ijm_macro).toContain('run("Gel Analyzer"')
    expect(ij.prism_pzfx).toContain('<GraphPadPrismFile')
    expect(ij.quantification_csv).toContain('Normalized_Ratio')

    // 5b. FlowJo 流式细胞术双参数十字象限圈门与 Gating-ML 2.0 (.wsp) 导出
    const flow = generateFlowJoAnalysis({
      title: 'Figure 5B. Annexin V-FITC / PI Apoptosis Assay',
      x_channel: 'FL1-A :: Annexin V-FITC (Log10 FI)',
      y_channel: 'FL2-A :: Propidium Iodide (Log10 FI)',
      x_gate_cutoff: 2.5,
      y_gate_cutoff: 2.5,
      quadrant_labels: {
        q1_ul: 'Q1: Necrotic',
        q2_ur: 'Q2: Late Apoptotic',
        q3_ll: 'Q3: Viable',
        q4_lr: 'Q4: Early Apoptotic',
      },
    })
    expect(flow.svg).toContain('Q2: Late Apoptotic')
    expect(flow.svg).toContain('Q4: Early Apoptotic')
    const totalPct = flow.quadrant_stats.q1_pct + flow.quadrant_stats.q2_pct + flow.quadrant_stats.q3_pct + flow.quadrant_stats.q4_pct
    expect(totalPct).toBeCloseTo(100, 0)
    expect(flow.flowjo_wsp_xml).toContain('< FlowJoWorkspace')
    expect(flow.flowjo_wsp_xml).toContain('gating:RectangleGate')
    expect(flow.fcs_csv).toContain('Annexin_V_Log10,PI_Log10,Quadrant')

    // 5c. 3D Slicer (.mrml + .mrk.json) & ITK-SNAP (.txt) 病灶 ROI 分割配置包
    const slicer = generateSlicerAndItkSnapPackage({
      study_id: 'STUDY-HF-001',
      patient_id: 'PT-0088',
      modality: 'CT',
      series_description: 'Chest-Abdomen Contrast CT 1.0mm',
      rois: [
        { id: 1, name: 'L3_Skeletal_Muscle', color_rgb: [220, 38, 38], opacity: 0.8, center_ras_mm: [0, -15, -120], size_mm: [140, 90, 10], volume_cm3: 48.6, mean_hu: 42.3 },
        { id: 2, name: 'Visceral_Adipose_Tissue', color_rgb: [245, 158, 11], opacity: 0.7, center_ras_mm: [0, 20, -120], size_mm: [160, 110, 10], volume_cm3: 92.4, mean_hu: -88.5 },
      ],
    })
    expect(slicer.slicer_mrml_xml).toContain('<MRML')
    expect(slicer.slicer_mrml_xml).toContain('vtkMRMLSegmentationNode')
    expect(slicer.slicer_mrml_xml).toContain('L3_Skeletal_Muscle')
    expect(slicer.slicer_markups_json).toContain('https://raw.githubusercontent.com/slicer/slicer/main/Modules/Loadable/Markups/Resources/Schema/markups-schema-v1.0.3.json')
    expect(slicer.itksnap_labels_txt).toContain('ITK-SnAP Label Description File')
    expect(slicer.itksnap_labels_txt).toContain('"L3_Skeletal_Muscle"')
    expect(slicer.svg_preview).toContain('3D Slicer / ITK-SNAP')
  })

  it('6. 终极拼图与期刊排版 (Adobe Illustrator / Inkscape 多面板复合图拼版) -> 统一字体/线宽/A-B-C-D 标签、分层 SVG、600 DPI PNG、可编辑 PPTX 与全套原文件 ZIP', () => {
    const pA = renderMechanismDiagram({
      title: 'Mechanism',
      nodes: [
        { id: 'a1', icon: 'drug_molecule', label: 'Drug', x: 180, y: 180 },
        { id: 'a2', icon: 'mitochondria', label: 'Mito', x: 480, y: 180 },
      ],
      edges: [{ from: 'a1', to: 'a2', type: 'activation', label: 'Activates' }],
    })
    const pB = generateWetLabPlot({
      plot_type: 'bar_scatter',
      title: 'Wet-Lab Assay',
      groups: [
        { name: 'Ctrl', values: [10, 12, 11] },
        { name: 'Treat', values: [22, 25, 24] },
      ],
    })
    const pC = generateBioinformaticsFigure({
      bio_type: 'volcano',
      title: 'RNA-seq Volcano',
      volcano_genes: [
        { gene: 'GENE1', log2FC: 2.2, p_value: 0.001 },
        { gene: 'GENE2', log2FC: -1.8, p_value: 0.002 },
      ],
    })
    const pD = generateFlowJoAnalysis({
      title: 'Flow Cytometry',
    })

    const assembled = assembleJournalFigure({
      title: 'Figure 6. Multi-Omics and Functional Validation of SGLT2 Inhibition',
      journal_spec: 'nature_double',
      columns: 2,
      font_family: 'Arial',
      dpi: 300,
      panels: [
        { label: 'A', title: 'Signaling Mechanism', svg: pA.svg, native_files: [{ filename: 'Panel_A_Mechanism.drawio', content: pA.drawio_xml }] },
        { label: 'B', title: 'Biochemical Assay', svg: pB.svg, native_files: [{ filename: 'Panel_B_Assay.pzfx', content: pB.prism_pzfx }] },
        { label: 'C', title: 'Transcriptomic Volcano', svg: pC.svg, native_files: [{ filename: 'Panel_C_Volcano.R', content: pC.r_script }] },
        { label: 'D', title: 'Apoptosis Gating', svg: pD.svg, native_files: [{ filename: 'Panel_D_FlowJo.wsp', content: flowWsp(pD.flowjo_wsp_xml) }] },
      ],
    })

    expect(assembled.illustrator_svg).toContain('inkscape:groupmode="layer"')
    expect(assembled.illustrator_svg).toContain('id="Layer_Panel_A"')
    expect(assembled.illustrator_svg).toContain('id="Layer_Panel_B"')
    expect(assembled.illustrator_svg).toContain('id="Layer_Panel_C"')
    expect(assembled.illustrator_svg).toContain('id="Layer_Panel_D"')
    expect(assembled.width_mm).toBe(JOURNAL_COLUMN_SPECS.nature_double.width_mm)

    // 验证高分辨率 PNG 光栅化输出
    expect(assembled.png_bytes).toBeInstanceOf(Uint8Array)
    expect(assembled.png_bytes[0]).toBe(0x89)
    expect(assembled.png_bytes[1]).toBe(0x50) // 'P'
    expect(assembled.png_bytes[2]).toBe(0x4e) // 'N'
    expect(assembled.png_bytes[3]).toBe(0x47) // 'G'

    // 验证 ZIP 归档包含主图 SVG/PNG/PPTX 及各子面板原文件
    const zipEntries = unzipSync(assembled.bundle_zip)
    const names = Object.keys(zipEntries)
    expect(names).toContain('Composite_Figure_Illustrator_Layered.svg')
    expect(names).toContain('Composite_Figure_300DPI.png')
    expect(names).toContain('Composite_Figure_Editable.pptx')
    expect(names).toContain('Panel_A/Panel_A_Mechanism.drawio')
    expect(names).toContain('Panel_B/Panel_B_Assay.pzfx')
    expect(names).toContain('Panel_C/Panel_C_Volcano.R')
    expect(names).toContain('Panel_D/Panel_D_FlowJo.wsp')
  })
})

function flowWsp(xml: string): string {
  return xml
}

describe('医学论文图表 HTTP 路由与一键发刊物打包集成验证', async () => {
  const { mkdtempSync, readFileSync, copyFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { buildApi } = await import('../src/http/api.ts')
  const { Documents } = await import('../src/model/runtime.ts')
  const { OpService } = await import('../src/ops/service.ts')
  const { PostCheck } = await import('../src/collab/postcheck.ts')
  const { SlideRenderer } = await import('../src/render/slides.ts')
  const { Accounts } = await import('../src/auth/accounts.ts')
  const { DatasetService, parseCsv } = await import('../src/datasets/service.ts')
  const { StudyService } = await import('../src/research/service.ts')
  const { Store } = await import('../src/store/db.ts')
  const { TenantService } = await import('../src/auth/tenants.ts')
  const { TenantKeys, kekFrom } = await import('../src/tenancy/keys.ts')
  const { PatientService } = await import('../src/tenancy/patients.ts')
  const { CohortService } = await import('../src/research/cohort.ts')
  const { issueToken } = await import('../src/auth/token.ts')

  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const accounts = new Accounts(store, { secret: 'test-secret', devMode: true, devToken: 'dev', devUser: 'u1' })
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'mf-pt-')), tenants, keys, store)

  const ingest = async (_owner: string, src: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-ing-'))
    copyFileSync(src, join(dir, 'data.csv'))
    const recs = parseCsv(readFileSync(src, 'utf8'))
    const header = recs[0] ?? []
    return {
      csv: join(dir, 'data.csv'), cleanup: () => {},
      profile: { ok: true as const, rows: recs.length - 1, truncated: false, columns: header.map(name => ({ name, type: 'text' as const, missing: 0, unique: 1 })) },
    }
  }

  const dsDir = mkdtempSync(join(tmpdir(), 'mf-ds-'))
  const datasets = new DatasetService(store, dsDir, ingest)
  const studies = new StudyService(store, datasets)
  const cohort = new CohortService(studies, patients, datasets)

  const hosp = store.createTenant({ name: '协和临床医学研究所', kind: 'org' })
  const user = store.createUser({ username: 'dr_fig', display_name: 'Dr. Fig', password_hash: 'x', tenant: { id: hosp.id, role: 'admin' } })
  const study = studies.create(user.id, { title: 'SGLT2i 多模态机制与临床研究', design: 'rct' })
  const authToken = `Bearer ${issueToken('test-secret', { u: user.id, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: user.token_version })}`

  const pt = patients.create({ userId: user.id, via: 'user' }, {
    sex: 'M',
    birth_year: 1962,
    tags: ['心衰'],
  })
  cohort.enroll({ userId: user.id, via: 'user' }, study.id, { patient_ids: [pt.id] })

  const app = buildApi({
    docs,
    ops,
    turns: {} as any,
    postcheck: new PostCheck(docs),
    crossref: {} as any,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'mf-render-'))),
    accounts,
    devMode: true,
    devUser: user.id,
    datasets,
    studies,
    patients,
    cohort,
  })

  it('1. POST /api/studies/:sid/figures 支持 6 大类科研图表及 ?format=pzfx|drawio|vdx|pptx|ijm|wsp|mrml|zip 原文件直出', async () => {
    // 1) Wet-lab 导出 GraphPad Prism .pzfx
    const resPzfx = await app.request(`/api/studies/${study.id}/figures?format=pzfx`, {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'wet_lab',
        plot_type: 'bar_scatter',
        title: 'Prism Direct Export',
        groups: [
          { name: 'Ctrl', values: [12, 14, 15] },
          { name: 'Drug', values: [6, 7, 5] },
        ],
      }),
    })
    expect(resPzfx.status).toBe(200)
    expect(resPzfx.headers.get('content-disposition')).toContain('.pzfx')
    expect(await resPzfx.text()).toContain('<GraphPadPrismFile')

    // 2) Mechanism 导出可编辑 PowerPoint .pptx
    const resPptx = await app.request(`/api/studies/${study.id}/figures?format=pptx`, {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'mechanism',
        title: 'Signaling Mechanism',
      }),
    })
    expect(resPptx.status).toBe(200)
    expect(resPptx.headers.get('content-disposition')).toContain('.pptx')
    const pptxBuf = new Uint8Array(await resPptx.arrayBuffer())
    expect(unzipSync(pptxBuf)['ppt/slides/slide1.xml']).toBeDefined()

    // 3) Bioinformatics 火山图 JSON 返回全部原文件脚本与矩阵
    const resBio = await app.request(`/api/studies/${study.id}/figures`, {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'bioinformatics',
        bio_type: 'volcano',
        title: 'Volcano Plot',
      }),
    })
    expect(resBio.status).toBe(200)
    const bioBody = await resBio.json() as any
    expect(bioBody.svg).toContain('<svg')
    expect(bioBody.r_script).toContain('ggplot')
    expect(bioBody.prism_pzfx).toContain('<GraphPadPrismFile')
    expect(bioBody.cloud_matrix_csv).toContain('Gene,log2FoldChange')

    // 4) ImageJ / FlowJo / 3D Slicer 原生格式下载
    const resIjm = await app.request(`/api/studies/${study.id}/figures?format=ijm`, {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'image_processing',
        tool: 'imagej',
      }),
    })
    expect(resIjm.status).toBe(200)
    expect(await resIjm.text()).toContain('run("Set Scale..."')

    const resWsp = await app.request(`/api/studies/${study.id}/figures?format=wsp`, {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'image_processing',
        tool: 'flowjo',
      }),
    })
    expect(resWsp.status).toBe(200)
    expect(await resWsp.text()).toContain('FlowJoWorkspace')

    // 5) Assembly 导出全套原文件 ZIP
    const resZip = await app.request(`/api/studies/${study.id}/figures?format=zip`, {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'assembly',
        title: 'Journal Multi-Panel Composite Figure',
        journal_spec: 'nature_double',
      }),
    })
    expect(resZip.status).toBe(200)
    expect(resZip.headers.get('content-type')).toBe('application/zip')
    const zipMap = unzipSync(new Uint8Array(await resZip.arrayBuffer()))
    expect(zipMap['Composite_Figure_Illustrator_Layered.svg']).toBeDefined()
    expect(zipMap['Composite_Figure_Editable.pptx']).toBeDefined()
  })

  it('2. GET /api/studies/:sid/cohort/consort 支持 ?format=drawio|vdx|pptx 原生流程图文件直出', async () => {
    const resDrawio = await app.request(`/api/studies/${study.id}/cohort/consort?format=drawio`, {
      method: 'GET',
      headers: { Authorization: authToken },
    })
    expect(resDrawio.status).toBe(200)
    expect(await resDrawio.text()).toContain('<mxGraphModel')

    const resVdx = await app.request(`/api/studies/${study.id}/cohort/consort?format=vdx`, {
      method: 'GET',
      headers: { Authorization: authToken },
    })
    expect(resVdx.status).toBe(200)
    expect(await resVdx.text()).toContain('<VisioDocument')
  })

  it('3. GET /api/patients/:ptid/imaging/export 支持 3D Slicer (.mrml / .mrk.json)、ITK-SNAP (.txt) 与 ImageJ (.ijm) 导出', async () => {
    const resMrml = await app.request(`/api/patients/${pt.id}/imaging/export?format=slicer-mrml`, {
      method: 'GET',
      headers: { Authorization: authToken },
    })
    expect(resMrml.status).toBe(200)
    expect(await resMrml.text()).toContain('<MRML')

    const resItk = await app.request(`/api/patients/${pt.id}/imaging/export?format=itksnap-labels`, {
      method: 'GET',
      headers: { Authorization: authToken },
    })
    expect(resItk.status).toBe(200)
    expect(await resItk.text()).toContain('ITK-SnAP Label Description File')
  })

  it('4. 图表成果库支持自定义命名归档、单条重命名、批量前缀重命名及单条/批量删除', async () => {
    const sampleSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#fff"/></svg>'
    // 1) 自定义命名归档两张图表
    const arch1 = await app.request('/api/figures', {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'archive',
        name: 'Figure 1A 脑血管畸形 mRS (Grotta)',
        svg: sampleSvg,
        code: '# R code 1',
      }),
    })
    expect(arch1.status).toBe(201)
    const f1 = await arch1.json() as { asset_id: string; name: string }
    expect(f1.name).toBe('Figure 1A 脑血管畸形 mRS (Grotta).svg')

    const arch2 = await app.request('/api/figures', {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'archive',
        name: 'Figure 1B 多阶段治疗轨迹 Sankey',
        svg: sampleSvg,
        code: '# R code 2',
      }),
    })
    expect(arch2.status).toBe(201)
    const f2 = await arch2.json() as { asset_id: string; name: string }

    // 2) 单条重命名 PATCH /api/figures/:aid
    const patchRes = await app.request(`/api/figures/${f1.asset_id}`, {
      method: 'PATCH',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Figure 1A 修订版 Grotta 偏移图' }),
    })
    expect(patchRes.status).toBe(200)
    const patched = await patchRes.json() as { ok: boolean; name: string }
    expect(patched.name).toBe('Figure 1A 修订版 Grotta 偏移图.svg')

    // 3) 批量前缀重命名 POST /api/figures/batch (rename_prefix)
    const batchRenameRes = await app.request('/api/figures/batch', {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'rename_prefix',
        ids: [f1.asset_id, f2.asset_id],
        prefix: 'AVM_Study_Fig1',
      }),
    })
    expect(batchRenameRes.status).toBe(200)
    const brBody = await batchRenameRes.json() as { ok: boolean; affected: number }
    expect(brBody.affected).toBe(2)

    const listRes1 = await app.request('/api/figures', {
      method: 'GET',
      headers: { Authorization: authToken },
    })
    const list1 = (await listRes1.json() as { figures: Array<{ id: string; name: string }> }).figures
    expect(list1.find(x => x.id === f1.asset_id)?.name).toBe('AVM_Study_Fig1_01.svg')
    expect(list1.find(x => x.id === f2.asset_id)?.name).toBe('AVM_Study_Fig1_02.svg')

    // 4) 单条删除 DELETE /api/figures/:aid + 批量删除 POST /api/figures/batch (delete)
    const delOne = await app.request(`/api/figures/${f1.asset_id}`, {
      method: 'DELETE',
      headers: { Authorization: authToken },
    })
    expect(delOne.status).toBe(200)

    const batchDel = await app.request('/api/figures/batch', {
      method: 'POST',
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        ids: [f2.asset_id],
      }),
    })
    expect(batchDel.status).toBe(200)
    const bdBody = await batchDel.json() as { ok: boolean; affected: number }
    expect(bdBody.affected).toBe(1)

    const listRes2 = await app.request('/api/figures', {
      method: 'GET',
      headers: { Authorization: authToken },
    })
    const list2 = (await listRes2.json() as { figures: Array<{ id: string; name: string }> }).figures
    expect(list2.some(x => x.id === f1.asset_id || x.id === f2.asset_id)).toBe(false)
  })
})
