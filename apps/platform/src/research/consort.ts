/**
 * CONSORT 2010 / STROBE 临床研究入组筛选流向图引擎 (Automated Study Flowchart Engine)
 * 
 * 专为医学顶刊（NEJM / Lancet / JAMA / BMJ）标准 Figure 1 流向图设计：
 * - 阶梯式初筛与排除原因沉淀（Assessed -> Excluded by Reason -> Allocated -> Analyzed）；
 * - 输出出版级高分辨率矢量 SVG、Mermaid 流程图代码及 LaTeX TikZ 代码；
 * - 支持结合 @resvg/resvg-js 导出 300 DPI 印刷级 PNG。
 */

export interface ConsortExclusionItem {
  reason: string
  count: number
  percentage?: number
}

export interface ConsortArm {
  name: string
  allocated: number
  lost_to_followup?: number
  discontinued?: number
  analyzed: number
}

export interface ConsortDiagramData {
  title?: string
  lang?: 'zh' | 'en'
  total_assessed: number
  exclusions: ConsortExclusionItem[]
  eligible_total: number
  arms: ConsortArm[]
}

/**
 * 生成符合医学期刊规范的 CONSORT 2010 矢量流向图 (SVG)
 */
export function renderConsortSvg(data: ConsortDiagramData): string {
  const {
    title = 'CONSORT 2010 Flow Diagram',
    lang = 'zh',
    total_assessed,
    exclusions,
    eligible_total,
    arms,
  } = data
  const isEn = lang === 'en'

  const totalExcluded = exclusions.reduce((acc, curr) => acc + curr.count, 0)
  const width = 880
  const headerHeight = 70
  
  // Calculate dynamic heights
  const exclusionLineHeight = 22
  const exclusionBoxHeight = Math.max(80, 40 + exclusions.length * exclusionLineHeight)
  const totalHeight = headerHeight + 110 + exclusionBoxHeight + 280

  // Coordinates
  const cx = width / 2
  const boxWidth = 320
  const boxHeight = 65

  // Box 1: Enrollment / Assessed
  const b1_x = cx - boxWidth / 2
  const b1_y = headerHeight + 20

  // Box 2: Excluded (Side branch on the right, widened to prevent text overflow)
  const b2_w = 390
  const b2_h = exclusionBoxHeight
  const b2_x = cx + 35
  const b2_y = b1_y + boxHeight + 35

  // Box 3: Randomized / Allocated
  const b3_y = b2_y + b2_h + 35

  // Exclusion items formatted
  const exclusionLines = exclusions.map((item, idx) => {
    const pct = item.percentage ?? (total_assessed > 0 ? (item.count / total_assessed) * 100 : 0)
    const pctStr = pct > 0 ? ` (${pct.toFixed(1)}%)` : ''
    return `<text x="${b2_x + 14}" y="${b2_y + 45 + idx * exclusionLineHeight}" font-family="Times New Roman, STSong, serif" font-size="12.5" fill="#334155">• ${escapeXml(item.reason)}: n = ${item.count}${pctStr}</text>`
  }).join('\n      ')

  const lostLabel = isEn ? 'Lost to follow-up' : '失访 / 脱落'
  const discLabel = isEn ? 'Discontinued intervention' : '依从性不足终止'
  const analLabel = isEn ? 'Included in primary analysis' : '纳入最终疗效分析'

  // Arms rendering (2 branches: Treatment vs Control)
  let armsSvg = ''
  if (arms.length >= 2) {
    const arm1 = arms[0]!
    const arm2 = arms[1]!
    const armW = 340
    const armH = 110
    const gap = 60
    const arm1_x = cx - armW - gap / 2
    const arm2_x = cx + gap / 2
    const arms_y = b3_y + boxHeight + 45

    // Split branch line from b3
    const branchMidY = b3_y + boxHeight + 22
    const arm1_cx = arm1_x + armW / 2
    const arm2_cx = arm2_x + armW / 2

    armsSvg = `
      <!-- Allocation Branching Lines -->
      <line x1="${cx}" y1="${b3_y + boxHeight}" x2="${cx}" y2="${branchMidY}" stroke="#475569" stroke-width="1.8" />
      <line x1="${arm1_cx}" y1="${branchMidY}" x2="${arm2_cx}" y2="${branchMidY}" stroke="#475569" stroke-width="1.8" />
      <line x1="${arm1_cx}" y1="${branchMidY}" x2="${arm1_cx}" y2="${arms_y}" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />
      <line x1="${arm2_cx}" y1="${branchMidY}" x2="${arm2_cx}" y2="${arms_y}" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />

      <!-- Arm 1 Box -->
      <rect x="${arm1_x}" y="${arms_y}" width="${armW}" height="${armH}" rx="4" fill="#f8fafc" stroke="#3b82f6" stroke-width="1.6" filter="url(#shadow)" />
      <text x="${arm1_cx}" y="${arms_y + 24}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="14" fill="#1e3a8a">${escapeXml(arm1.name)} (n = ${arm1.allocated})</text>
      <line x1="${arm1_x + 10}" y1="${arms_y + 34}" x2="${arm1_x + armW - 10}" y2="${arms_y + 34}" stroke="#e2e8f0" stroke-width="1" />
      <text x="${arm1_x + 16}" y="${arms_y + 56}" font-family="Times New Roman, STSong, serif" font-size="13" fill="#334155">• ${lostLabel}: n = ${arm1.lost_to_followup ?? 0}</text>
      <text x="${arm1_x + 16}" y="${arms_y + 78}" font-family="Times New Roman, STSong, serif" font-size="13" fill="#334155">• ${discLabel}: n = ${arm1.discontinued ?? 0}</text>
      <text x="${arm1_x + 16}" y="${arms_y + 98}" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="13" fill="#0f172a">• ${analLabel}: n = ${arm1.analyzed}</text>

      <!-- Arm 2 Box -->
      <rect x="${arm2_x}" y="${arms_y}" width="${armW}" height="${armH}" rx="4" fill="#f8fafc" stroke="#10b981" stroke-width="1.6" filter="url(#shadow)" />
      <text x="${arm2_cx}" y="${arms_y + 24}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="14" fill="#065f46">${escapeXml(arm2.name)} (n = ${arm2.allocated})</text>
      <line x1="${arm2_x + 10}" y1="${arms_y + 34}" x2="${arm2_x + armW - 10}" y2="${arms_y + 34}" stroke="#e2e8f0" stroke-width="1" />
      <text x="${arm2_x + 16}" y="${arms_y + 56}" font-family="Times New Roman, STSong, serif" font-size="13" fill="#334155">• ${lostLabel}: n = ${arm2.lost_to_followup ?? 0}</text>
      <text x="${arm2_x + 16}" y="${arms_y + 78}" font-family="Times New Roman, STSong, serif" font-size="13" fill="#334155">• ${discLabel}: n = ${arm2.discontinued ?? 0}</text>
      <text x="${arm2_x + 16}" y="${arms_y + 98}" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="13" fill="#0f172a">• ${analLabel}: n = ${arm2.analyzed}</text>
    `
  }

  const subtitleText = isEn
    ? 'CONSORT 2010 / STROBE Standardized Participant Selection Flowchart'
    : 'CONSORT 2010 / STROBE 国际规范标准队列筛选流向图 (Automated Research Flowchart)'
  const box1Title = isEn
    ? 'Assessed for Eligibility'
    : '评估初筛候选受试者 (Assessed for eligibility)'
  const box1Sub = isEn
    ? `( N = ${total_assessed.toLocaleString()} )`
    : `( N = ${total_assessed.toLocaleString()} 例 )`
  const box2Title = isEn
    ? `Excluded (n = ${totalExcluded.toLocaleString()})`
    : `排除受试者 (Excluded: n = ${totalExcluded.toLocaleString()})`
  const box3Title = isEn
    ? 'Eligible / Allocated Cohort'
    : '最终合格入组队列 (Eligible / Allocated)'
  const box3Sub = isEn
    ? `( N = ${eligible_total.toLocaleString()} )`
    : `( N = ${eligible_total.toLocaleString()} 例 )`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${totalHeight}" width="${width}" height="${totalHeight}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569" />
    </marker>
    <filter id="shadow" x="-3%" y="-3%" width="106%" height="110%" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.08" />
    </filter>
  </defs>

  <!-- Background Canvas -->
  <rect width="100%" height="100%" fill="#ffffff" />

  <!-- Diagram Title Banner -->
  <text x="${cx}" y="36" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="20" font-weight="bold" fill="#0f172a">${escapeXml(title)}</text>
  <text x="${cx}" y="56" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="13" fill="#64748b">${subtitleText}</text>
  <line x1="60" y1="66" x2="${width - 60}" y2="66" stroke="#cbd5e1" stroke-width="1.2" />

  <!-- Stage Tags on Left Margin -->
  <text x="35" y="${b1_y + 36}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" fill="#64748b" letter-spacing="1">ENROLLMENT</text>
  <text x="35" y="${b3_y + 36}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" fill="#64748b" letter-spacing="1">ALLOCATION</text>
  <text x="35" y="${b3_y + 160}" font-family="Arial, sans-serif" font-size="11" font-weight="bold" fill="#64748b" letter-spacing="1">ANALYSIS</text>

  <!-- 1. Assessed for Eligibility Box -->
  <rect x="${b1_x}" y="${b1_y}" width="${boxWidth}" height="${boxHeight}" rx="4" fill="#f8fafc" stroke="#475569" stroke-width="1.6" filter="url(#shadow)" />
  <text x="${cx}" y="${b1_y + 26}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="15" fill="#0f172a">${box1Title}</text>
  <text x="${cx}" y="${b1_y + 48}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="14" fill="#334155">${box1Sub}</text>

  <!-- Vertical Trunk Line -->
  <line x1="${cx}" y1="${b1_y + boxHeight}" x2="${cx}" y2="${b3_y}" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />

  <!-- Branch Line to Exclusion Box -->
  <path d="M ${cx} ${b2_y + 25} L ${b2_x} ${b2_y + 25}" fill="none" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />

  <!-- 2. Exclusion Box -->
  <rect x="${b2_x}" y="${b2_y}" width="${b2_w}" height="${b2_h}" rx="4" fill="#fff1f2" stroke="#e11d48" stroke-width="1.5" filter="url(#shadow)" />
  <text x="${b2_x + 14}" y="${b2_y + 24}" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="14" fill="#be123c">${box2Title}</text>
  <line x1="${b2_x + 10}" y1="${b2_y + 32}" x2="${b2_x + b2_w - 10}" y2="${b2_y + 32}" stroke="#fecdd3" stroke-width="1" />
  ${exclusionLines}

  <!-- 3. Eligible / Randomized Box -->
  <rect x="${b1_x}" y="${b3_y}" width="${boxWidth}" height="${boxHeight}" rx="4" fill="#eff6ff" stroke="#2563eb" stroke-width="1.6" filter="url(#shadow)" />
  <text x="${cx}" y="${b3_y + 26}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-weight="bold" font-size="15" fill="#1e3a8a">${box3Title}</text>
  <text x="${cx}" y="${b3_y + 48}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="14" fill="#1d4ed8">${box3Sub}</text>

  ${armsSvg}
</svg>`
}

/**
 * 导出为 Mermaid 流程图代码（可直接嵌入 Markdown 预览）
 */
export function renderConsortMermaid(data: ConsortDiagramData): string {
  const { total_assessed, exclusions, eligible_total, arms, lang = 'zh' } = data
  const isEn = lang === 'en'
  const totalExcluded = exclusions.reduce((acc, curr) => acc + curr.count, 0)
  
  const exclusionText = exclusions
    .map(e => `• ${e.reason} (n=${e.count})`)
    .join('<br>')

  let mermaid = `graph TD\n`
  if (isEn) {
    mermaid += `  A["Assessed for eligibility<br><b>N = ${total_assessed}</b>"] --> B{"Eligibility Screening"}\n`
    mermaid += `  B -->|Excluded n = ${totalExcluded}| Ex["<b>Excluded</b><br>${exclusionText}"]\n`
    mermaid += `  B -->|Eligible| C["<b>Eligible / Allocated Cohort</b><br>N = ${eligible_total}"]\n`
    if (arms.length >= 2) {
      const arm1 = arms[0]!
      const arm2 = arms[1]!
      mermaid += `  C --> D1["<b>${arm1.name}</b><br>Allocated: n=${arm1.allocated}<br>Analyzed: n=${arm1.analyzed}"]\n`
      mermaid += `  C --> D2["<b>${arm2.name}</b><br>Allocated: n=${arm2.allocated}<br>Analyzed: n=${arm2.analyzed}"]\n`
    }
  } else {
    mermaid += `  A["评估初筛人群 (Assessed for eligibility)<br><b>N = ${total_assessed}</b>"] --> B{"合格入组判断"}\n`
    mermaid += `  B -->|排除 n = ${totalExcluded}| Ex["<b>排除人群 (Excluded)</b><br>${exclusionText}"]\n`
    mermaid += `  B -->|合格入组| C["<b>最终纳入研究队列 (Allocated)</b><br>N = ${eligible_total}"]\n`
    if (arms.length >= 2) {
      const arm1 = arms[0]!
      const arm2 = arms[1]!
      mermaid += `  C --> D1["<b>${arm1.name}</b><br>分配: n=${arm1.allocated}<br>最终分析: n=${arm1.analyzed}"]\n`
      mermaid += `  C --> D2["<b>${arm2.name}</b><br>分配: n=${arm2.allocated}<br>最终分析: n=${arm2.analyzed}"]\n`
    }
  }

  mermaid += `  style A fill:#f8fafc,stroke:#475569,stroke-width:2px\n`
  mermaid += `  style Ex fill:#fff1f2,stroke:#e11d48,stroke-width:1.5px\n`
  mermaid += `  style C fill:#eff6ff,stroke:#2563eb,stroke-width:2px\n`
  if (arms.length >= 2) {
    mermaid += `  style D1 fill:#f0fdf4,stroke:#16a34a,stroke-width:1.5px\n`
    mermaid += `  style D2 fill:#f0fdf4,stroke:#16a34a,stroke-width:1.5px\n`
  }

  return mermaid
}

/**
 * 辅助转义 XML 字符
 */
function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case '\'': return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

// —— 仅基于平台真实入组记录的受试者流向图 ——

export interface EnrollmentFlowData {
  title?: string
  /** 平台入组记录中曾入组本研究的受试者数（在组 + 已移出） */
  enrolled_ever: number
  /** 入组记录状态为「已移出」的受试者数（平台不记录移出原因） */
  withdrawn: number
  /** 在组但当前操作者不在诊疗组、未纳入导出的受试者数 */
  inaccessible: number
  /** 实际纳入本次材料包的受试者数 */
  analyzed: number
  /** 按受试者真实 treatment_arm 的分组人数；无分组信息时为空 */
  arms: Array<{ name: string; n: number }>
  /** 缺少分组信息的受试者数（有分组时才有意义） */
  unassigned?: number
  /** 图下方说明（如「平台未记录筛选与排除原因」） */
  note?: string
}

/**
 * 受试者流向图（SVG）。与 renderConsortSvg 不同，这里不画「评估筛选 / 排除原因」环节，
 * 也不画失访、依从性等没有记录来源的格子：每个数字都必须来自平台入组记录。
 */
export function renderEnrollmentFlowSvg(data: EnrollmentFlowData): string {
  const { title = 'Participant Flow', enrolled_ever, withdrawn, inaccessible, analyzed, arms, unassigned = 0, note } = data
  const width = 860
  const cx = width / 2
  const boxW = 300
  const boxH = 60
  const font = 'font-family="Times New Roman, STSong, serif"'
  const parts: string[] = []
  let y = 90

  const box = (x: number, top: number, w: number, line1: string, line2: string, stroke = '#475569') => {
    parts.push(`<rect x="${x}" y="${top}" width="${w}" height="${boxH}" rx="4" fill="#f8fafc" stroke="${stroke}" stroke-width="1.6" />`)
    parts.push(`<text x="${x + w / 2}" y="${top + 25}" text-anchor="middle" ${font} font-weight="bold" font-size="14" fill="#0f172a">${escapeXml(line1)}</text>`)
    parts.push(`<text x="${x + w / 2}" y="${top + 46}" text-anchor="middle" ${font} font-size="13" fill="#334155">${escapeXml(line2)}</text>`)
  }
  const arrow = (x1: number, y1: number, x2: number, y2: number) => {
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#475569" stroke-width="1.6" marker-end="url(#arrow)" />`)
  }
  // 侧枝：从主干引出到右侧说明框，centerY 为侧枝所在高度
  const sideBox = (centerY: number, text: string) => {
    const sx = cx + boxW / 2 + 30
    parts.push(`<line x1="${cx}" y1="${centerY}" x2="${sx}" y2="${centerY}" stroke="#475569" stroke-width="1.4" marker-end="url(#arrow)" />`)
    parts.push(`<rect x="${sx}" y="${centerY - 18}" width="${width - sx - 20}" height="36" rx="4" fill="#fff7ed" stroke="#c2410c" stroke-width="1.2" />`)
    parts.push(`<text x="${sx + 10}" y="${centerY + 5}" ${font} font-size="12" fill="#7c2d12">${escapeXml(text)}</text>`)
  }

  box(cx - boxW / 2, y, boxW, '入组受试者 (Enrolled)', `n = ${enrolled_ever}`)
  const sides: string[] = []
  if (withdrawn > 0) sides.push(`移出研究 (Withdrawn): n = ${withdrawn}，原因未记录`)
  if (inaccessible > 0) sides.push(`无访问权限未导出: n = ${inaccessible}`)
  const gap = 50 + sides.length * 44
  sides.forEach((t, i) => sideBox(y + boxH + 30 + i * 44, t))
  arrow(cx, y + boxH, cx, y + boxH + gap)
  y += boxH + gap
  box(cx - boxW / 2, y, boxW, '纳入本次分析 (Included)', `n = ${analyzed}`, '#2563eb')

  if (arms.length > 0) {
    const n = arms.length + (unassigned > 0 ? 1 : 0)
    const armW = Math.min(240, (width - 40 - (n - 1) * 20) / n)
    const totalW = n * armW + (n - 1) * 20
    const startX = cx - totalW / 2
    const branchY = y + boxH + 25
    const armsY = branchY + 30
    parts.push(`<line x1="${cx}" y1="${y + boxH}" x2="${cx}" y2="${branchY}" stroke="#475569" stroke-width="1.6" />`)
    const items = [...arms.map(a => ({ name: a.name, n: a.n })), ...(unassigned > 0 ? [{ name: '分组缺失 (Arm missing)', n: unassigned }] : [])]
    const centers = items.map((_, i) => startX + i * (armW + 20) + armW / 2)
    parts.push(`<line x1="${centers[0]}" y1="${branchY}" x2="${centers[centers.length - 1]}" y2="${branchY}" stroke="#475569" stroke-width="1.6" />`)
    items.forEach((it, i) => {
      arrow(centers[i]!, branchY, centers[i]!, armsY)
      box(startX + i * (armW + 20), armsY, armW, it.name, `n = ${it.n}`, '#10b981')
    })
    y = armsY
  }
  y += boxH + 30
  if (note) {
    parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" ${font} font-size="12" fill="#64748b">${escapeXml(note)}</text>`)
    y += 20
  }
  const height = y + 10

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569" />
    </marker>
  </defs>
  <rect width="100%" height="100%" fill="#ffffff" />
  <text x="${cx}" y="40" text-anchor="middle" ${font} font-size="20" font-weight="bold" fill="#0f172a">${escapeXml(title)}</text>
  <text x="${cx}" y="62" text-anchor="middle" ${font} font-size="13" fill="#64748b">数据来源：平台入组记录（不含筛选 / 排除环节）</text>
  ${parts.join('\n  ')}
</svg>`
}

/** 受试者流向图的 Mermaid 版本（与 renderEnrollmentFlowSvg 同口径，只含入组记录里有的环节） */
export function renderEnrollmentFlowMermaid(data: EnrollmentFlowData): string {
  const q = (s: string) => s.replace(/"/g, "'")
  let m = 'graph TD\n'
  m += `  A["入组受试者 (Enrolled)<br><b>n = ${data.enrolled_ever}</b>"] --> C["<b>纳入分析 (Included)</b><br>n = ${data.analyzed}"]\n`
  if (data.withdrawn > 0) m += `  A -.-> W["移出研究 (Withdrawn)<br>n = ${data.withdrawn}，原因未记录"]\n`
  if (data.inaccessible > 0) m += `  A -.-> X["无访问权限未导出<br>n = ${data.inaccessible}"]\n`
  data.arms.forEach((a, i) => { m += `  C --> G${i}["${q(a.name)}<br>n = ${a.n}"]\n` })
  if (data.arms.length > 0 && (data.unassigned ?? 0) > 0) m += `  C --> GU["分组缺失 (Arm missing)<br>n = ${data.unassigned}"]\n`
  return m
}

export {
  exportFlowchartToDrawio,
  exportFlowchartToVisioVdx,
  exportFlowchartToPptx,
} from './medical-figures.ts'

