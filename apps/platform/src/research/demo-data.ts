/**
 * 示例（演示）数据的识别与标记。
 *
 * 制图工作台允许在没有真实数据时用内置示例数据预览图形（「即开即画」），但示例结果绝不能被当成本研究的结果：
 * - 入口统一判断请求是否带了真实数据（detectDemoInput）；
 * - 示例结果的 SVG 打上 data-heurion-demo 标记并加可见水印（markDemoSvg），标题换成「示例数据」；
 * - 示例结果只给预览，不返回 / 不导出 Prism、R、CSV 等原文件（stripDemoPayload）；
 * - 归档接口与 MCP 工具遇到示例数据一律拒绝（isDemoSvg）。
 */

export const DEMO_TITLE = '示例数据（非真实研究结果）'
const DEMO_ATTR = 'data-heurion-demo="true"'

const has = (v: unknown): boolean => Array.isArray(v) && v.length > 0

/**
 * 判断一次制图请求是否会落到内置示例数据上；返回原因说明，使用真实数据时返回 null。
 * 只判断「数据」类图表；机制图、3D Slicer 场景包是模板/示意，不属于数据结果。
 */
export function detectDemoInput(category: string, body: Record<string, any>): string | null {
  const clinicalSubtypes = ['grotta', 'sankey', 'upset', 'logistic', 'survival']
  if (category === 'clinical_cohort' || clinicalSubtypes.includes(category)) {
    const did = typeof body.dataset_id === 'string' && body.dataset_id.trim()
    return did || has(body.records) ? null : '未选择数据集，使用了内置演示队列'
  }
  if (category === 'wet_lab' || category === 'statistical_wetlab') {
    const plotType = String(body.plotType || body.plot_type || body.subtype || 'bar_scatter')
    if (plotType === 'dose_response') {
      const dr = body.doseResponse
      const ok = (dr && ((has(dr.logConcentrations) && has(dr.series)) || has(dr.points))) || has(body.dose_response_series)
      return ok ? null : '未提供剂量反应数据，使用了内置示例曲线'
    }
    return null
  }
  if (category === 'bioinformatics') {
    const bioType = String(body.bioType || body.bio_type || 'volcano')
    if (bioType === 'volcano') return has(body.genes) || has(body.volcano_genes) ? null : '未提供差异分析结果，使用了内置示例基因'
    if (bioType === 'heatmap') return has(body.matrix) || has(body.heatmap_matrix?.values) ? null : '未提供表达矩阵，使用了内置示例热图'
    if (bioType === 'enrichment' || bioType === 'enrichment_bubble') {
      return has(body.pathways) || has(body.enrichment_terms) ? null : '未提供富集分析结果，使用了内置示例通路'
    }
    if (bioType === 'umap' || bioType === 'tsne' || bioType === 'single_cell') {
      return has(body.cells) || has(body.umap_cells) ? null : '未提供单细胞降维坐标，使用了内置示例细胞'
    }
    return null
  }
  if (category === 'image_processing') {
    const tool = String(body.tool || 'imagej')
    if (tool === 'flowjo') return has(body.events) ? null : '未提供流式事件数据，使用了内置合成事件'
    if (tool === 'imagej') return has(body.quantificationGroups) || has(body.wb_lanes) ? null : '未提供定量数据，使用了内置示例分组'
    return null
  }
  if (category === 'journal_assembly' || category === 'assembly') {
    return has(body.panels) ? null : '未选择任何面板，生成的是占位图'
  }
  return null
}

/** 给 SVG 打上示例标记并叠加可见水印（PNG 由 SVG 渲染，水印随之保留） */
export function markDemoSvg(svg: string): string {
  if (!svg.includes('<svg') || isDemoSvg(svg)) return svg
  const watermark =
    `<g id="heurion-demo-watermark" pointer-events="none">` +
    `<rect x="0" y="0" width="100%" height="26" fill="#FEF3C7" fill-opacity="0.92"/>` +
    `<text x="50%" y="18" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#92400E">` +
    `示例数据 · 非真实研究结果 · DEMO DATA — NOT FOR PUBLICATION</text>` +
    `<text x="50%" y="55%" text-anchor="middle" font-family="Arial, sans-serif" font-size="56" font-weight="700" fill="#B45309" fill-opacity="0.13" transform="rotate(-24)" style="transform-box: fill-box; transform-origin: center">示例数据 DEMO</text>` +
    `</g>`
  return svg
    .replace(/<svg\b/, `<svg ${DEMO_ATTR}`)
    .replace(/<\/svg>\s*$/, `${watermark}</svg>`)
}

export function isDemoSvg(svg: string): boolean {
  return /<svg\b[^>]*\bdata-heurion-demo="true"/.test(svg)
}

/** 原文件 / 数据导出字段：示例结果一律不返回，避免示例数值以 Prism / R / CSV 等形式流出 */
// ImageJ 宏（.ijm）只含处理步骤与比例尺参数，不含任何数据，作为模板保留
const EXPORT_KEY_RE = /pzfx|r_script|csv|ogs|wsp|drawio|vdx|pptx|zip|mrml|markdown|narrative|report|stats_summary|png/i

/** 示例数据请求中仍允许导出的纯模板格式（不含数据） */
export function isTemplateExport(category: string, body: Record<string, any>, exportFormat: string): boolean {
  return category === 'image_processing' && String(body.tool || 'imagej') === 'imagej' && exportFormat === 'ijm'
}

/**
 * 处理示例结果的响应体：所有 SVG 加水印，删除原文件与统计结果字段，并标注 is_demo_data。
 * 只递归两层（足以覆盖 native_exports 等嵌套对象）。
 */
export function stripDemoPayload(payload: Record<string, any>, reason: string): Record<string, any> {
  const walk = (obj: Record<string, any>, depth: number): Record<string, any> => {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (EXPORT_KEY_RE.test(k)) continue
      if (typeof v === 'string') out[k] = v.includes('<svg') ? markDemoSvg(v) : v
      else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) && depth < 2) out[k] = walk(v, depth + 1)
      else if (v instanceof Uint8Array) continue
      else out[k] = v
    }
    return out
  }
  return { ...walk(payload, 0), is_demo_data: true, demo_reason: reason }
}
