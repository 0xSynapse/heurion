/**
 * 官网多语言服务端渲染 (SSR) 与免登录临床科研微型工具页（Programmatic SEO & GEO）
 *
 * 解决两个核心问题：
 * 1. 修复 /en 路由在无 JS 的 AI 爬虫（GPTBot / ClaudeBot / PerplexityBot）和搜索引擎下返回中文 DOM 与错误 canonical 的问题；
 * 2. 提供 4 个独立 URL、免登录、无状态的临床科研高频引流工具页（/tools/* 与 /en/tools/*），
 *    包含完整 JSON-LD (SoftwareApplication + FAQPage)、方法学公式 Answer Capsules 及一键转入 /app 工作台钩子。
 */

export type ToolSlug =
  | 'e-value-calculator'
  | 'consort-strobe-flowchart'
  | 'table-1-generator'
  | 'pubmed-citation-checker'

export const TOOL_SLUGS: readonly ToolSlug[] = [
  'e-value-calculator',
  'consort-strobe-flowchart',
  'table-1-generator',
  'pubmed-citation-checker',
] as const

export function isToolSlug(s: string): s is ToolSlug {
  return (TOOL_SLUGS as readonly string[]).includes(s)
}

/**
 * 将 apps/site/index.html 在服务端转换为纯正的英文版 HTML（供 GET /en 直接返回给无 JS 爬虫与浏览器）
 */
export function renderEnglishIndexHtml(zhHtml: string): string {
  // 提取脚本中的 en 字典键值对
  const enBlockMatch = /\ben:\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\};/.exec(zhHtml)
  const enDict: Record<string, string> = {}
  if (enBlockMatch?.[1]) {
    const kvRegex = /([a-zA-Z0-9_]+):\s*"((?:[^"\\]|\\.)*)"/g
    let m: RegExpExecArray | null
    while ((m = kvRegex.exec(enBlockMatch[1])) !== null) {
      const k = m[1]!
      const v = m[2]!.replace(/\\"/g, '"').replace(/\\n/g, '\n')
      enDict[k] = v
    }
  }

  let html = zhHtml
    .replace('<html lang="zh-CN">', '<html lang="en">')
    .replace(
      '<meta name="description" content="Heurion Research 是面向严肃医学研究与高可靠智能体协作的研究实验室（Research Lab），主打两大旗舰产品：Heurion 2.0 临床科研全流程智能工作台（OmniCanvas 双面协同、MONAI 3D 影像、Table 1 三线表、PubMed 溯源）与 Aegis OS 事务型多租户 Agent 操作系统运行时。">',
      '<meta name="description" content="Heurion Research is a research lab building contract-guarded clinical research intelligence and transactional agent systems, featuring two flagship products: Heurion 2.0 & OmniCanvas (Clinical Research AI Workstation) and Aegis OS (Transactional Multi-Tenant Agent Operating System Runtime).">',
    )
    .replace('<link rel="canonical" href="https://heurion.org/">', '<link rel="canonical" href="https://heurion.org/en">')
    .replace(
      '<meta property="og:title" content="Heurion Research · 契约受控临床科研工作台与事务型 Agent 操作系统 (Clinical AI Workstation &amp; Aegis OS)">',
      '<meta property="og:title" content="Heurion Research · Contract-Guarded Clinical AI Workstation &amp; Aegis OS Agent Runtime">',
    )
    .replace(
      '<meta property="og:description" content="面向严肃医学研究与高可靠智能体协作的研究实验室：主打 Heurion 2.0 临床科研全流程工作台（MONAI 3D 影像、Table 1 三线表、PubMed 溯源）与 Aegis OS 事务型 Agent 操作系统运行时。">',
      '<meta property="og:description" content="Research lab building contract-guarded clinical research intelligence (Heurion 2.0 & OmniCanvas Workstation) and transactional multi-tenant agent operating systems (Aegis OS).">',
    )
    .replace('<meta property="og:url" content="https://heurion.org/">', '<meta property="og:url" content="https://heurion.org/en">')
    .replace('<meta property="og:locale" content="zh_CN">', '<meta property="og:locale" content="en_US">')
    .replace('<meta property="og:locale:alternate" content="en_US">', '<meta property="og:locale:alternate" content="zh_CN">')
    .replace(
      '<meta name="twitter:title" content="Heurion Research · 临床科研智能工作台 &amp; Aegis OS 运行时">',
      '<meta name="twitter:title" content="Heurion Research · Clinical AI Workstation &amp; Aegis OS Runtime">',
    )
    .replace(
      '<meta name="twitter:description" content="面向严肃医学研究与高可靠智能体协作的研究实验室：主打 Heurion 2.0 临床科研工作台与 Aegis OS 事务型 Agent 操作系统运行时。">',
      '<meta name="twitter:description" content="Heurion Research Lab: Heurion 2.0 Clinical Research AI Workstation (MONAI 3D, Table 1 .docx, E-value, PubMed verification) and Aegis OS Transactional Agent Runtime.">',
    )
    .replace('<span id="langText">EN</span>', '<span id="langText">中文</span>')
    .replace(/href="\/tools"/g, 'href="/en/tools"')

  // 替换 JSON-LD 中的中文 FAQ 与 MedicalWebPage 描述为英文
  html = html
    .replace(
      '"name": "Heurion Research · 契约受控临床科研工作台与事务型 Agent 操作系统 (Clinical AI Workstation & Aegis OS)"',
      '"name": "Heurion Research · Contract-Guarded Clinical AI Workstation & Aegis OS Agent Runtime"',
    )
    .replace(
      '"description": "面向严肃医学研究与高可靠智能体协作的研究实验室：覆盖 Heurion 2.0 临床科研全流程工作台（患者纳排、MONAI 3D 影像量化、Table 1 三线表、PubMed 文献溯源）与 Aegis OS 事务型 Agent 操作系统运行时。"',
      '"description": "Heurion Research Lab unifying the Heurion 2.0 contract-guarded clinical research AI workstation (PHR, cohort enrollment, MONAI 3D imaging, native Word Table 1, PubMed verification) and Aegis OS transactional agent operating system runtime."',
    )
    .replace(
      '"name": "Heurion 是什么？与普通通用大模型（如 ChatGPT / Claude）有什么本质区别？"',
      `"name": ${JSON.stringify(enDict.faq_q1 || 'What is Heurion, and how does it differ fundamentally from generic LLMs like ChatGPT or Claude?')}`,
    )
    .replace(
      '"text": "Heurion 是专为医学与临床科研打造的全流程 AI 智能工作台，覆盖患者数据录入、课题组纳排、MONAI 3D 影像量化、发表级 Table 1 三线表生成与论文写作全生命周期。与通用大模型相比，Heurion 针对临床科研的几个痛点：1) 引用核验：引用经 NCBI PubMed 与 Crossref 核对，无法核实的 DOI/PMID 会被标出；2) 3D 医学影像：集成 Project MONAI 与 PyTorch，支持 CT/MRI 体数据分割、RECIST 1.1 径线与体积测量和三正交 MPR；3) 患者隐私：入组即分配 S001... 去标识编号，AI 统计代码在无外网访问的受限沙箱中运行；4) 统计与发表级输出：在沙箱中运行 Python 统计脚本，一键生成发表级 Table 1 原生 Word 三线表（1.5pt/0.5pt 边线）与 CONSORT 2010 流程图。"',
      `"text": ${JSON.stringify(`${enDict.faq_a1_p1 ?? ''} ${enDict.faq_a1_p2 ?? ''}`.trim())}`,
    )
    .replace(
      '"name": "Heurion 如何保障患者健康隐私（PHI）与医疗数据合规？"',
      `"name": ${JSON.stringify(enDict.faq_q2 || 'How does Heurion ensure Protected Health Information (PHI) and healthcare data security?')}`,
    )
    .replace(
      '"text": "Heurion 的数据保护措施：1) 去标识：入组患者自动分配学术编号（S001、S002...）；2) PHI 扫描：内置基于规则的扫描器，可在数据与文稿中检出并脱敏姓名、身份证号、手机号与病案号；3) 沙箱隔离：AI 执行统计分析的 Python 环境运行在独立的受限系统用户中，出站网络只放行平台内部端口，不能直接访问平台数据库或他人工作区；4) 大模型调用：AI 对话经平台代理调用外部大模型服务，建议只提交已去标识的数据。"',
      `"text": ${JSON.stringify(enDict.faq_a2_p1 ?? '')}`,
    )
    .replace(
      '"name": "Heurion 支持哪些医学影像（CT/MRI）智能分析与模型？"',
      `"name": ${JSON.stringify(enDict.faq_q3 || 'Which medical imaging (CT/MRI) deep learning models does Heurion support?')}`,
    )
    .replace(
      '"text": "Heurion 影像分析服务集成 Project MONAI 与 PyTorch，支持 NIfTI 与 DICOM 格式。已在公开数据集样本上实际运行的能力包括：1) 脾脏自动分割与体积测量（MONAI 官方 spleen_ct 3D-UNet 权重）；2) 基于分割掩膜的 RECIST 1.1 最长径与体积测量；3) 三维影像组学特征提取（形状、一阶统计、GLCM、GLRLM 共 46 项）；4) 三正交多平面重建（MPR）。所有输出仅供科研参考，不构成诊断意见。"',
      `"text": ${JSON.stringify(enDict.faq_a3_p1 ?? '')}`,
    )
    .replace(
      '"name": "Heurion 如何帮助临床医生撰写医学论文与准备投稿材料？"',
      `"name": ${JSON.stringify(enDict.faq_q4 || 'How does Heurion assist clinicians in manuscript writing and journal submissions?')}`,
    )
    .replace(
      '"text": "Heurion 覆盖论文发表常用的材料：1) 导出发表级 Table 1 原生 Word (.docx) 三线表，可给出两组间 SMD；2) 绘制 CONSORT 2010 / STROBE 受试者流向矢量图；3) 计算 VanderWeele E-value 未测混杂敏感性指标；4) 运行 Kaplan-Meier 生存曲线与 Cox 比例风险回归；5) 核对论文中的文献引用、效应量（HR/OR/RR）与 95% 置信区间。"',
      `"text": ${JSON.stringify(enDict.faq_a4_p1 ?? '')}`,
    )
    .replace(
      '"name": "如何通过 MCP (Model Context Protocol) 将 Heurion 连接到自主 AI Agent？"',
      `"name": ${JSON.stringify(enDict.faq_q5 || 'How can other autonomous AI agents connect to Heurion via Model Context Protocol (MCP)?')}`,
    )
    .replace(
      '"text": "Heurion 提供了符合 Anthropic Model Context Protocol (MCP) 标准的专用服务端点，支持 Claude Desktop、Cursor、Cline 等自主 AI 智能体接入。Agent 可通过标准化工具调用 Heurion 的文献核验、医学影像切片提取、受试者纳排、沙箱统计分析与文档协同创作能力。"',
      `"text": ${JSON.stringify(enDict.faq_a5_p1 ?? '')}`,
    )
    .replace(
      '"name": "Aegis OS 是什么？它与 Heurion 2.0 临床工作台如何协同工作？"',
      `"name": ${JSON.stringify(enDict.faq_q6 || 'What is Aegis OS, and how does it work together with the Heurion 2.0 Clinical Workstation?')}`,
    )
    .replace(
      '"text": "Aegis OS (aegis-os) 是 Heurion Research 研发的事务型多租户 Agent 操作系统运行时（基于 Rust 构建）。它为自主智能体提供毫秒级 APFS/FICLONE 写时复制（CoW）影子工作区、macOS Seatbelt 与 Linux Bubblewrap 双层内核沙箱（80 项红队攻击 0.0% 越权率）、L7 零信任密钥注入与出站 DLP，以及 Google A2A / MCP 协同总线（消除 90.7%–97.9% 授权确认弹窗）。Heurion 2.0 原生实现 AAP-1.0 协议，可通过 aegis app install heurion.org 直接挂载到 Aegis OS 中安全运行。"',
      `"text": ${JSON.stringify(enDict.faq_a6_p1 ?? '')}`,
    )

  // 将所有带 data-i18n="key" 的单层标签内容在服务端替换为英文
  html = html.replace(
    /<([a-zA-Z0-9]+)(\s[^>]*?\bdata-i18n="([a-zA-Z0-9_]+)"[^>]*)>([\s\S]*?)<\/\1>/g,
    (whole, tag: string, attrs: string, key: string) => {
      const val = enDict[key]
      if (!val) return whole
      return `<${tag}${attrs}>${val}</${tag}>`
    },
  )

  return html
}

/** 公共头部与脚部框架样式（复用 /site/site.css 并增加工具工作台专属样式） */
const TOOL_EXTRA_CSS = `
  .tool-shell { padding: 112px 0 64px; min-height: calc(100vh - 200px); }
  .tool-breadcrumb { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted, #94a3b8); margin-bottom: 14px; flex-wrap: wrap; }
  .tool-breadcrumb a { color: var(--mint, #00ff93); text-decoration: none; }
  .tool-breadcrumb a:hover { text-decoration: underline; }
  .tool-header { margin-bottom: 28px; }
  .tool-header h1 { font-size: clamp(26px, 3.6vw, 40px); line-height: 1.2; margin: 8px 0 12px; color: #fff; }
  .tool-header .lead { font-size: 16px; color: #cbd5e1; max-width: 860px; line-height: 1.65; }
  .tool-badges { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  .tool-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 999px; font-size: 12px; font-weight: 600; background: rgba(0, 255, 147, 0.1); border: 1px solid rgba(0, 255, 147, 0.3); color: #00ff93; }
  .tool-grid { display: grid; grid-template-columns: 1fr 1.25fr; gap: 24px; align-items: start; margin-bottom: 44px; }
  @media (max-width: 960px) { .tool-grid { grid-template-columns: 1fr; } }
  .tool-card { background: rgba(12, 26, 20, 0.85); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 14px; padding: 24px; box-shadow: 0 16px 40px rgba(0,0,0,0.35); }
  .tool-card h2 { font-size: 18px; margin: 0 0 16px; color: #fff; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .form-row { margin-bottom: 15px; }
  .form-row label { display: block; font-size: 13px; font-weight: 600; color: #cbd5e1; margin-bottom: 6px; }
  .form-row input, .form-row select, .form-row textarea {
    width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
    background: rgba(4, 12, 9, 0.9); border: 1px solid rgba(255, 255, 255, 0.18);
    color: #fff; font-size: 14px; font-family: inherit;
  }
  .form-row textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.5; resize: vertical; }
  .form-row input:focus, .form-row select:focus, .form-row textarea:focus { outline: none; border-color: #00ff93; }
  .form-inline { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .preset-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .preset-btn {
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.16); color: #e2e8f0;
    padding: 6px 11px; border-radius: 6px; font-size: 12px; cursor: pointer; transition: all 0.15s;
  }
  .preset-btn:hover { border-color: #00ff93; color: #00ff93; background: rgba(0,255,147,0.08); }
  .action-bar { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  .btn-run {
    background: #00ff93; color: #051811; font-weight: 700; border: none; padding: 11px 20px;
    border-radius: 8px; font-size: 14px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  }
  .btn-run:hover { filter: brightness(1.08); }
  .btn-sec {
    background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.2);
    padding: 10px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none;
  }
  .btn-sec:hover { border-color: #00ff93; color: #00ff93; }
  .kpi-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin-bottom: 18px; }
  .kpi-box { background: rgba(0, 255, 147, 0.06); border: 1px solid rgba(0, 255, 147, 0.25); border-radius: 10px; padding: 14px 16px; }
  .kpi-box .kpi-label { font-size: 12px; color: #94a3b8; }
  .kpi-box .kpi-val { font-size: 28px; font-weight: 800; color: #00ff93; margin-top: 4px; font-family: ui-monospace, Menlo, monospace; }
  .svg-preview { background: #fff; border-radius: 10px; padding: 12px; overflow-x: auto; text-align: center; margin: 14px 0; }
  .svg-preview svg { max-width: 100%; height: auto; }
  .copy-box { background: rgba(3, 9, 7, 0.92); border: 1px solid rgba(255,255,255,0.14); border-radius: 8px; padding: 14px; font-size: 13px; color: #e2e8f0; line-height: 1.65; white-space: pre-wrap; margin-bottom: 12px; }
  .upsell-banner {
    margin-top: 20px; padding: 16px 18px; border-radius: 12px;
    background: linear-gradient(135deg, rgba(0, 255, 147, 0.14), rgba(6, 182, 128, 0.06));
    border: 1px solid rgba(0, 255, 147, 0.4); display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  }
  .upsell-banner p { margin: 0; font-size: 13.5px; color: #e2e8f0; line-height: 1.55; flex: 1; min-width: 240px; }
  .upsell-banner strong { color: #00ff93; }
  .academic-table-wrap { background: #fff; color: #0f172a; padding: 20px; border-radius: 10px; overflow-x: auto; font-family: "Times New Roman", STSong, "Songti SC", serif; }
  .academic-table { width: 100%; border-collapse: collapse; font-size: 13.5px; color: #0f172a; }
  .academic-table caption { font-weight: bold; text-align: left; margin-bottom: 8px; font-size: 14.5px; }
  .academic-table thead tr { border-top: 2px solid #0f172a; border-bottom: 1px solid #0f172a; }
  .academic-table tbody tr:last-child { border-bottom: 2px solid #0f172a; }
  .academic-table th, .academic-table td { padding: 6px 10px; text-align: left; }
  .academic-table .indent-1 { padding-left: 26px; }
  .academic-table-foot { font-size: 12px; color: #334155; margin-top: 8px; line-height: 1.5; }
  .geo-capsule { background: rgba(12, 26, 20, 0.6); border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 28px; margin-top: 32px; }
  .geo-capsule h2 { font-size: 22px; color: #fff; margin: 0 0 12px; }
  .geo-capsule h3 { font-size: 17px; color: #00ff93; margin: 20px 0 8px; }
  .geo-capsule p, .geo-capsule li { font-size: 14.5px; color: #cbd5e1; line-height: 1.7; }
  .hub-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 22px; margin: 28px 0 48px; }
  @media (max-width: 820px) { .hub-grid { grid-template-columns: 1fr; } }
  .hub-card { background: rgba(12, 26, 20, 0.85); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 26px; display: flex; flex-direction: column; justify-content: space-between; transition: border-color 0.2s, transform 0.2s; }
  .hub-card:hover { border-color: #00ff93; transform: translateY(-2px); }
  .hub-card h2 { font-size: 20px; color: #fff; margin: 8px 0 10px; }
  .hub-card p { font-size: 14px; color: #cbd5e1; line-height: 1.65; margin: 0 0 18px; }
  .cite-item { border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.14); background: rgba(6,16,12,0.85); }
  .cite-item.verified { border-left: 4px solid #10b981; }
  .cite-item.mismatch { border-left: 4px solid #f59e0b; }
  .cite-item.unverifiable { border-left: 4px solid #ef4444; }
`

function renderCommonLayout(opts: {
  lang: 'zh' | 'en'
  title: string
  description: string
  keywords: string
  canonicalPath: string
  zhPath: string
  enPath: string
  jsonLd: Record<string, unknown>
  bodyHtml: string
  scriptJs?: string
}): string {
  const { lang, title, description, keywords, canonicalPath, zhPath, enPath, jsonLd, bodyHtml, scriptJs } = opts
  const isEn = lang === 'en'
  const canonicalUrl = `https://heurion.org${canonicalPath}`
  const zhUrl = `https://heurion.org${zhPath}`
  const enUrl = `https://heurion.org${enPath}`
  const switchHref = isEn ? zhPath : enPath
  const switchLabel = isEn ? '中文' : 'EN'
  const homeHref = isEn ? '/en' : '/'
  const toolsHref = isEn ? '/en/tools' : '/tools'

  return `<!doctype html>
<html lang="${isEn ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="keywords" content="${escapeHtml(keywords)}">
  <link rel="canonical" href="${canonicalUrl}">
  <link rel="alternate" hreflang="zh-CN" href="${zhUrl}">
  <link rel="alternate" hreflang="en" href="${enUrl}">
  <link rel="alternate" hreflang="x-default" href="${zhUrl}">
  <link rel="alternate" type="text/plain" href="/llms.txt" title="LLM Overview">
  <link rel="alternate" type="text/plain" href="/llms-full.txt" title="LLM Technical Manual">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Heurion">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="https://heurion.org/site/heurion-avatar.png">
  <meta property="og:locale" content="${isEn ? 'en_US' : 'zh_CN'}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <link rel="stylesheet" href="/site/site.css">
  <style>${TOOL_EXTRA_CSS}</style>
</head>
<body>
<header class="top scrolled" id="top">
  <div class="wrap top-row">
    <a class="brand" href="${homeHref}" aria-label="Heurion">
      <svg class="mark" viewBox="-2 6 96 88" aria-hidden="true"><rect fill="#fff" x="0" y="10" width="18" height="80" rx="9"/><rect fill="#fff" x="62" y="30" width="18" height="60" rx="9"/><rect fill="#00ff93" x="14" y="42" width="52" height="18" rx="9"/><circle fill="#00ff93" cx="80" cy="20" r="11"/></svg>
      <span class="word">HEURION</span>
    </a>
    <nav class="links" id="links">
      <a href="${toolsHref}">${isEn ? 'All Free Tools' : '临床科研工具箱'}</a>
      <a href="${ isEn ? '/en/tools/e-value-calculator' : '/tools/e-value-calculator' }">E-value</a>
      <a href="${ isEn ? '/en/tools/consort-strobe-flowchart' : '/tools/consort-strobe-flowchart' }">CONSORT / STROBE</a>
      <a href="${ isEn ? '/en/tools/table-1-generator' : '/tools/table-1-generator' }">Table 1 (.docx)</a>
      <a href="${ isEn ? '/en/tools/pubmed-citation-checker' : '/tools/pubmed-citation-checker' }">${isEn ? 'PubMed Check' : 'PubMed 核验'}</a>
      <a href="/phr">${isEn ? 'Zhijia (PHR)' : '知家 (PHR)'}</a>
    </nav>
    <div class="top-cta">
      <a class="lang-btn" href="${switchHref}" style="text-decoration:none;" aria-label="Switch Language">
        <span>${switchLabel}</span>
      </a>
      <a class="btn mint" href="/app">${isEn ? 'Open Workstation →' : '进入完整工作台 →'}</a>
    </div>
  </div>
</header>

<main class="tool-shell">
  <div class="wrap">
    ${bodyHtml}
  </div>
</main>

<footer class="foot">
  <div class="wrap foot-row">
    <a class="brand" href="${homeHref}"><svg class="mark" viewBox="-2 6 96 88" aria-hidden="true"><rect fill="#fff" x="0" y="10" width="18" height="80" rx="9"/><rect fill="#fff" x="62" y="30" width="18" height="60" rx="9"/><rect fill="#00ff93" x="14" y="42" width="52" height="18" rx="9"/><circle fill="#00ff93" cx="80" cy="20" r="11"/></svg><span class="word">HEURION</span></a>
    <nav class="foot-links">
      <a href="${homeHref}">${isEn ? 'Home' : '官网首页'}</a>
      <a href="${toolsHref}">${isEn ? 'Free Clinical Tools' : '免登录科研工具'}</a>
      <a href="/phr">${isEn ? 'Zhijia PHR' : '知家患者健康档案'}</a>
      <a href="/app">${isEn ? 'Workstation' : '进入工作台'}</a>
      <a href="/llms.txt">llms.txt</a>
      <a href="https://github.com/heurion-org/heurion" target="_blank" rel="noreferrer">GitHub</a>
    </nav>
  </div>
  <div class="wrap foot-base">
    <span>© 2026 Heurion · <a href="mailto:support@heurion.org" style="color: var(--mint);">support@heurion.org</a></span>
    <span>${isEn ? 'Clinical Research AI Workstation · For Research Use Only' : '临床科研智能工作台 · 仅供医学科研参考，不提供临床诊疗建议'}</span>
  </div>
</footer>
${scriptJs ? `<script>\n${scriptJs}\n</script>` : ''}
</body>
</html>`
}

/**
 * 渲染 `/tools` 与 `/en/tools` 临床科研免登录工具箱导航页
 */
export function renderToolsHubHtml(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const prefix = isEn ? '/en/tools' : '/tools'
  const title = isEn
    ? 'Free Clinical Research & Biostatistics Mini-Tools (No Login) | Heurion'
    : '临床科研免登录在线工具箱：Table 1 三线表、CONSORT 流程图、E-value 计算器与 PubMed 核验 | Heurion'
  const description = isEn
    ? 'Free, stateless clinical research tools for investigators and biostatisticians: VanderWeele E-value calculator, CONSORT 2010 / STROBE flowchart generator, native Word (.docx) Table 1 baseline table generator with SMD, and PubMed citation checker.'
    : '专为临床医生、医学硕博与 IIT 课题组打造的免登录在线科研工具矩阵：一键计算 VanderWeele E-value 并生成 SCI 审稿回复、绘制 CONSORT 2010 / STROBE 矢量入组流程图、导出原生 Word (.docx) Table 1 标准三线表（含 SMD 与 PHI 隐私扫描）、核验 PubMed 文献真伪与 HR/OR 效应量。'

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: `https://heurion.org${prefix}`,
    description,
    hasPart: [
      {
        '@type': 'SoftwareApplication',
        name: isEn ? 'VanderWeele E-value Sensitivity Analysis Calculator' : 'VanderWeele E-value 未测混杂敏感性分析在线计算器',
        url: `https://heurion.org${prefix}/e-value-calculator`,
        applicationCategory: 'MedicalApplication',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'SoftwareApplication',
        name: isEn ? 'CONSORT 2010 & STROBE Flowchart Generator' : 'CONSORT 2010 / STROBE 临床入组流程图在线生成工具',
        url: `https://heurion.org${prefix}/consort-strobe-flowchart`,
        applicationCategory: 'MedicalApplication',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'SoftwareApplication',
        name: isEn ? 'Publication-Grade Table 1 Native Word (.docx) Generator' : '医学论文发表级 Table 1 基线三线表在线生成器 (.docx)',
        url: `https://heurion.org${prefix}/table-1-generator`,
        applicationCategory: 'MedicalApplication',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'SoftwareApplication',
        name: isEn ? 'PubMed Citation & Effect Size Verification Tool' : '医学论文 PubMed 引用真伪与 HR/OR 效应量核验器',
        url: `https://heurion.org${prefix}/pubmed-citation-checker`,
        applicationCategory: 'MedicalApplication',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    ],
  }

  const bodyHtml = `
    <div class="tool-breadcrumb">
      <a href="${isEn ? '/en' : '/'}">Heurion</a> <span>/</span> <span>${isEn ? 'Free Clinical Research Tools' : '临床科研免登录工具箱'}</span>
    </div>
    <div class="tool-header">
      <p class="eyebrow"><span class="dot"></span>STATELESS CLINICAL RESEARCH UTILITIES · ZERO LOGIN REQUIRED</p>
      <h1>${isEn ? 'Free Clinical Research & Biostatistics Mini-Tools' : '临床科研与 SCI 论文发表 · 免登录在线工具箱'}</h1>
      <p class="lead">${
        isEn
          ? 'Built directly on Heurion’s biostatistical and literature verification engines. No account registration required, no historical data needed—get publication-ready native Word (.docx) tables, vector CONSORT diagrams, E-value rebuttal paragraphs, and verified PubMed citations in under 30 seconds.'
          : '直接开放 Heurion 临床科研工作台的底层生物统计与文献核验引擎。无需注册登录、不依赖历史数据、即用即走——30 秒内获取符合 NEJM / JAMA / Lancet 投稿规范的原生 Word 三线表、CONSORT 矢量流程图、E-value 审稿抗辩段落与 PubMed 引用核验报告。'
      }</p>
      <div class="tool-badges">
        <span class="tool-badge">✓ ${isEn ? '100% Free & No Login Required' : '100% 免登录即开即用'}</span>
        <span class="tool-badge">✓ ${isEn ? 'Stateless & Privacy-Safe (Local PHI Scan)' : '无状态不落盘 · 内置 PHI 隐私扫描'}</span>
        <span class="tool-badge">✓ ${isEn ? 'Built-in Landmark Trial Demo Datasets' : '内置经典临床试验演示数据'}</span>
      </div>
    </div>

    <div class="hub-grid">
      <article class="hub-card">
        <div>
          <span class="tool-badge">01 · ${isEn ? 'Causal Inference & Rebuttal' : '观察性研究混杂抗辩必备'}</span>
          <h2>${isEn ? 'VanderWeele E-value Calculator & Reviewer Rebuttal Generator' : 'VanderWeele E-value 敏感性分析计算器 & SCI 审稿回复生成器'}</h2>
          <p>${
            isEn
              ? 'Enter HR, OR, or RR with 95% CI to instantly compute Point & CI E-values (VanderWeele & Ding 2017), plot the bias threshold curve, and copy ready-to-use Methods/Results text and peer-review rebuttal letters.'
              : '输入 HR / OR / RR 及 95% 置信区间，按 VanderWeele (2017) 公式实时计算点估计与置信区间界限 E-value、绘制偏倚阈值曲线，并一键复制中英双语 SCI 论文结果表述与回应审稿人未测混杂质疑的 Rebuttal 信件。'
          }</p>
        </div>
        <div>
          <a class="btn-run" style="text-decoration:none;" href="${prefix}/e-value-calculator">${isEn ? 'Open E-value Calculator →' : '立即打开 E-value 计算器 →'}</a>
        </div>
      </article>

      <article class="hub-card">
        <div>
          <span class="tool-badge">02 · ${isEn ? 'Cohort Flow Diagram' : 'Figure 1 入组流向矢量图'}</span>
          <h2>${isEn ? 'CONSORT 2010 & STROBE Participant Flowchart Generator' : 'CONSORT 2010 / STROBE 受试者纳排流程图在线生成器'}</h2>
          <p>${
            isEn
              ? 'Fill in screening counts, exclusion reasons, and study arms with automatic arithmetic checking. Export publication-ready vector SVG, PNG, or Mermaid flowcharts in 1 click.'
              : '填空式输入初筛人数、各项排除原因及分组随访人数，系统自动校验加减算术一致性，实时渲染符合期刊印刷规范的矢量 SVG、高清 PNG 与 Mermaid 源码。'
          }</p>
        </div>
        <div>
          <a class="btn-run" style="text-decoration:none;" href="${prefix}/consort-strobe-flowchart">${isEn ? 'Open Flowchart Generator →' : '立即生成 CONSORT / STROBE 流程图 →'}</a>
        </div>
      </article>

      <article class="hub-card">
        <div>
          <span class="tool-badge">03 · ${isEn ? 'Native Word .docx Export' : '原生 Word 三线表 + SMD'}</span>
          <h2>${isEn ? 'Publication-Grade Table 1 Baseline Generator (.docx)' : '医学论文发表级 Table 1（基线特征三线表）原生 Word 生成器'}</h2>
          <p>${
            isEn
              ? 'Paste CSV/Excel rows or load the HFrEF demo cohort. Automatically runs local PHI privacy scanning, branches normal (Mean ± SD) vs non-normal (Median [IQR]) variables, computes p-values and two-group SMD, and downloads a native 1.5pt/0.5pt Word (.docx) file.'
              : '粘贴 Excel/CSV 数据或一键加载心衰队列演示数据。内置本地 PHI 隐私扫描，自动识别连续/分类变量并计算组间 P 值与标准化均数差（SMD），直接下载 1.5pt/0.5pt 标准边线的原生 Word (.docx) 文件。'
          }</p>
        </div>
        <div>
          <a class="btn-run" style="text-decoration:none;" href="${prefix}/table-1-generator">${isEn ? 'Open Table 1 Generator →' : '立即生成 Table 1 三线表 (.docx) →'}</a>
        </div>
      </article>

      <article class="hub-card">
        <div>
          <span class="tool-badge">04 · ${isEn ? 'Anti-Hallucination Grounding' : '防 AI 假文献与数值张冠李戴'}</span>
          <h2>${isEn ? 'PubMed Citation & Effect Size (HR/OR/95% CI) Checker' : '医学论文 PubMed 文献真伪与效应量（HR/OR/95% CI）核验器'}</h2>
          <p>${
            isEn
              ? 'Paste a manuscript paragraph with references. Cross-verifies PMIDs and DOIs against NCBI PubMed and Crossref, and checks whether cited Hazard Ratios / Odds Ratios match the authentic abstract.'
              : '粘贴一段含引用的医学论文草稿，实时对照 NCBI PubMed 与 Crossref 核查 PMID/DOI 真伪，并逐一比对文内引用的 HR / OR / 95% CI 数值是否与 PubMed 原文摘要一致。'
          }</p>
        </div>
        <div>
          <a class="btn-run" style="text-decoration:none;" href="${prefix}/pubmed-citation-checker">${isEn ? 'Open PubMed Citation Checker →' : '立即核验 PubMed 文献与效应量 →'}</a>
        </div>
      </article>
    </div>

    <section class="geo-capsule">
      <h2>${isEn ? 'Why Use Heurion for Clinical Cohort Studies & IIT Workflows?' : '为什么临床队列研究（Cohort Study）与研究者发起的临床研究（IIT）选择 Heurion？'}</h2>
      <p>${
        isEn
          ? 'In clinical medicine, investigators typically juggle fragmented desktop software—extracting patient charts into Excel, running descriptive statistics in SPSS or R (tableone / EValue), drawing CONSORT diagrams in Visio, and using generic chatbots that hallucinate fake PubMed IDs. Heurion (heurion.org) unifies the entire clinical research workflow into a single, privacy-compliant workstation.'
          : '在临床医学科研（尤其是回顾性队列研究、前瞻性观察研究、真实世界研究 RWE 与专病库建设）中，研究者往往困于工具割裂：在 Excel 里手工清洗病历、去 SPSS 或 R (tableone) 里跑基线表、用 PPT 画入组流程图、用通用大模型润色却遭遇假文献。Heurion (heurion.org) 将“患者去标识化纳排 → MONAI 3D 影像量化 → 隔离沙箱统计 → 发表级原生 Word 三线表与 PubMed 溯源写作”整合在同一个安全工作台中。'
      }</p>
    </section>
  `

  return renderCommonLayout({
    lang,
    title,
    description,
    keywords: 'Heurion, clinical research tools, Table 1 generator docx, CONSORT 2010 flowchart generator, VanderWeele E-value calculator, PubMed citation checker, 临床科研工具, 三线表生成器, E-value计算器, CONSORT流程图',
    canonicalPath: prefix,
    zhPath: '/tools',
    enPath: '/en/tools',
    jsonLd,
    bodyHtml,
  })
}

/**
 * 渲染 4 个具体免登录小工具页
 */
export function renderToolPageHtml(slug: ToolSlug, lang: 'zh' | 'en'): string {
  switch (slug) {
    case 'e-value-calculator':
      return renderEValuePage(lang)
    case 'consort-strobe-flowchart':
      return renderConsortPage(lang)
    case 'table-1-generator':
      return renderTable1Page(lang)
    case 'pubmed-citation-checker':
      return renderCitationCheckerPage(lang)
  }
}

function renderEValuePage(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const zhPath = '/tools/e-value-calculator'
  const enPath = '/en/tools/e-value-calculator'
  const canonicalPath = isEn ? enPath : zhPath

  const title = isEn
    ? 'VanderWeele E-value Calculator & Peer-Review Rebuttal Generator (Free, No Login) | Heurion'
    : 'VanderWeele E-value 未测混杂敏感性分析在线计算器 & SCI 审稿回复生成器（免登录） | Heurion'
  const description = isEn
    ? 'Calculate VanderWeele & Ding (2017) E-values for Hazard Ratio (HR), Odds Ratio (OR), and Relative Risk (RR) with 95% CI. Plot bias threshold curves and copy ready-to-use SCI manuscript & reviewer rebuttal text.'
    : '免费免登录在线计算观察性临床研究 VanderWeele E-value（支持 HR、OR、RR 及 95% 置信区间），自动绘制未测量混杂偏倚阈值曲线，并一键生成中英文 SCI 论文 Methods/Results 表述与审稿人质疑未测混杂（Unmeasured Confounding）的标准回复模板。'

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        name: title,
        url: `https://heurion.org${canonicalPath}`,
        applicationCategory: 'MedicalApplication, ScientificApplication',
        operatingSystem: 'Web',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        description,
      },
      {
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: isEn
              ? 'How is the VanderWeele E-value calculated from RR, HR, or OR?'
              : 'VanderWeele E-value 的计算公式是什么？如何根据 HR / OR / RR 计算？',
            acceptedAnswer: {
              '@type': 'Answer',
              text: isEn
                ? 'For an observed risk ratio RR > 1, the E-value is RR + sqrt(RR * (RR - 1)). If RR < 1 (protective effect), first take the inverse RR* = 1 / RR and apply the same formula. For Odds Ratios (OR) or Hazard Ratios (HR) with common outcomes (>15%), VanderWeele & Ding (Ann Intern Med 2017) recommend approximating RR = sqrt(OR) before computing the E-value.'
                : '当观测到的相对危险度 RR > 1 时，计算公式为 E-value = RR + sqrt(RR × (RR - 1))；若效应量 < 1（保护效应，如 HR = 0.74），先取倒数 RR* = 1 / 0.74 = 1.351，再代入公式得 E-value = 2.04。对于结局发生率 >15% 的非罕见事件 OR，按 VanderWeele & Ding (Ann Intern Med 2017) 建议先以 RR ≈ sqrt(OR) 转换后再计算。',
            },
          },
          {
            '@type': 'Question',
            name: isEn
              ? 'How do I respond to a peer reviewer asking about unmeasured confounding when PSM was not performed?'
              : '审稿人质疑观察性队列研究没有做倾向评分匹配（PSM）或存在未测量混杂偏倚时，如何用 E-value 回复？',
            acceptedAnswer: {
              '@type': 'Answer',
              text: isEn
                ? 'While PSM only balances measured baseline covariates, the VanderWeele E-value directly quantifies how strong an unmeasured confounder would have to be (in its associations with both treatment and outcome) to explain away the observed multivariable-adjusted effect.'
                : '倾向评分匹配（PSM）仅能平衡已测量的基线协变量，无法消除未测量混杂（Unmeasured Confounding）。在审稿回复信（Rebuttal）中报告多因素校正效应量的点估计 E-value 与 95% 置信区间界限 E-value，能够定量证明未测量混杂因素需同时与暴露和结局达到多少倍的关联强度才能推翻现有结论。',
            },
          },
        ],
      },
    ],
  }

  const bodyHtml = `
    <div class="tool-breadcrumb">
      <a href="${isEn ? '/en' : '/'}">Heurion</a> <span>/</span>
      <a href="${isEn ? '/en/tools' : '/tools'}">${isEn ? 'Free Tools' : '临床科研工具箱'}</a> <span>/</span>
      <span>${isEn ? 'E-value Calculator' : 'E-value 敏感性分析计算器'}</span>
    </div>
    <div class="tool-header">
      <p class="eyebrow"><span class="dot"></span>CAUSAL INFERENCE · VANDERWEELE &amp; DING (ANN INTERN MED 2017)</p>
      <h1>${isEn ? 'VanderWeele E-value Calculator & Reviewer Rebuttal Generator' : 'VanderWeele E-value 敏感性分析计算器 & SCI 审稿回复生成器'}</h1>
      <p class="lead">${
        isEn
          ? 'Quantify how strong an unmeasured confounder must be to explain away an observed treatment–outcome association in observational cohort studies. Instant calculation, bias threshold plotting, and ready-to-copy manuscript & rebuttal paragraphs.'
          : '免登录定量评估观察性队列研究对“未测量混杂偏倚（Unmeasured Confounding）”的抗干扰强度。输入 HR / OR / RR 及 95% 置信区间，秒级生成点估计与置信下限 E-value、偏倚阈值曲线，以及可直接粘贴进 SCI 论文与 Rebuttal 审稿回复信的专业中英文段落。'
      }</p>
    </div>

    <div class="tool-grid">
      <div class="tool-card">
        <h2>${isEn ? '1. Input Effect Estimate & 95% CI' : '1. 输入效应量与 95% 置信区间'}</h2>
        <div class="preset-bar">
          <button type="button" class="preset-btn" data-preset="dapahf">DAPA-HF (HR 0.74, 0.65–0.85)</button>
          <button type="button" class="preset-btn" data-preset="deliver">DELIVER (HR 0.82, 0.73–0.92)</button>
          <button type="button" class="preset-btn" data-preset="cohort">Cohort Risk (OR 2.35, 1.48–3.72)</button>
        </div>
        <div class="form-row">
          <label for="evType">${isEn ? 'Effect Measure Type' : '效应量指标类型 (Effect Type)'}</label>
          <select id="evType">
            <option value="HR">${isEn ? 'HR — Hazard Ratio (Cox proportional hazards)' : 'HR — Hazard Ratio (Cox 比例风险回归风险比)'}</option>
            <option value="RR">${isEn ? 'RR — Relative Risk / Risk Ratio' : 'RR — Relative Risk / Risk Ratio (相对危险度)'}</option>
            <option value="OR_RARE">${isEn ? 'OR — Odds Ratio (Rare outcome &lt; 15%)' : 'OR — Odds Ratio (结局发生率 &lt; 15% 罕见结局比值比)'}</option>
            <option value="OR_COMMON">${isEn ? 'OR — Odds Ratio (Common outcome ≥ 15%, √OR approximation)' : 'OR — Odds Ratio (结局发生率 ≥ 15% 常见结局，自动按 √OR 转换)'}</option>
          </select>
        </div>
        <div class="form-inline">
          <div class="form-row">
            <label for="evEst">${isEn ? 'Point Estimate' : '点估计值 (Estimate)'}</label>
            <input id="evEst" type="number" step="0.01" min="0.01" value="0.74">
          </div>
          <div class="form-row">
            <label for="evLow">${isEn ? '95% CI Lower' : '95% CI 下限'}</label>
            <input id="evLow" type="number" step="0.01" min="0.01" value="0.65">
          </div>
          <div class="form-row">
            <label for="evHigh">${isEn ? '95% CI Upper' : '95% CI 上限'}</label>
            <input id="evHigh" type="number" step="0.01" min="0.01" value="0.85">
          </div>
        </div>
        <div class="action-bar">
          <button type="button" class="btn-run" id="evCalcBtn">${isEn ? 'Calculate E-value & Generate Text' : '立即计算 E-value 并生成表述'}</button>
        </div>
      </div>

      <div class="tool-card">
        <h2>${isEn ? '2. E-value Results & Bias Threshold Curve' : '2. E-value 计算结果与未测混杂阈值曲线'}</h2>
        <div class="kpi-row">
          <div class="kpi-box">
            <div class="kpi-label">${isEn ? 'E-value for Point Estimate' : '点估计 E-value (Point Estimate)'}</div>
            <div class="kpi-val" id="outEPoint">2.04</div>
          </div>
          <div class="kpi-box">
            <div class="kpi-label">${isEn ? 'E-value for 95% CI Limit' : '置信区间界限 E-value (CI Limit)'}</div>
            <div class="kpi-val" id="outECi">1.63</div>
          </div>
        </div>
        <div class="svg-preview" id="evSvgWrap"></div>
        <div class="form-row">
          <label>${isEn ? 'Manuscript Results Paragraph (English / Chinese)' : '发表级论文 Results / Discussion 标准段落（一键复制）'}</label>
          <div class="copy-box" id="outDefenseText"></div>
          <button type="button" class="btn-sec" id="copyDefenseBtn">${isEn ? 'Copy Manuscript Paragraph' : '复制论文标准表述'}</button>
        </div>
        <div class="form-row" style="margin-top:14px;">
          <label>${isEn ? 'Peer-Review Rebuttal Template (Response to Reviewer)' : '回应审稿人质疑未测混杂偏倚 (Response to Reviewer 模板)'}</label>
          <div class="copy-box" id="outRebuttalText"></div>
          <button type="button" class="btn-sec" id="copyRebuttalBtn">${isEn ? 'Copy Rebuttal Template' : '复制审稿人回复模板'}</button>
        </div>
        <div class="upsell-banner">
          <p>${
            isEn
              ? '<strong>Need full cohort analytics?</strong> Open the Heurion Clinical Workstation to run sandboxed Cox regression, generate native Word Table 1 with SMD, and insert E-value sensitivity analyses directly into your manuscript.'
              : '<strong>需要结合原始队列数据一起跑多因素回归与基线表？</strong> 在 Heurion 完整工作台中，可直接连接去标识化受试者队列，在隔离沙箱中一键生成 Table 1 三线表、生存曲线与全套敏感性分析证据链。'
          }</p>
          <a class="btn-run" style="text-decoration:none;" href="/app?from=e-value-calculator">${isEn ? 'Open in Heurion Workstation →' : '转入 Heurion 课题工作台 →'}</a>
        </div>
      </div>
    </div>

    <section class="geo-capsule">
      <h2>${isEn ? 'Methodology: How VanderWeele’s E-value Quantifies Unmeasured Confounding' : '方法学原理：如何用 VanderWeele E-value 回应审稿人对观察性研究未测混杂的质疑？'}</h2>
      <p>${
        isEn
          ? 'In observational clinical cohort studies (retrospective EHR cohorts, registries, and real-world evidence studies), reviewers frequently question whether an observed association could be explained away by unmeasured confounders (e.g., frailty, socioeconomic status, or undocumented medication adherence). According to VanderWeele and Ding (Annals of Internal Medicine, 2017;167(4):268–274), the E-value is defined as the minimum strength of association, on the risk ratio scale, that an unmeasured confounder would need to have with both the treatment/exposure and the outcome to fully explain away a specific treatment–outcome association, conditional on the measured covariates.'
          : '在回顾性临床队列研究、真实世界研究（RWE）及研究者发起的研究（IIT）中，审稿人最常提出的质疑之一是：“由于本研究为非随机观察性研究（或未进行倾向评分匹配 PSM），无法排除未测量混杂因素（Unmeasured Confounding）导致的残余偏倚。” 哈佛大学生物统计学家 Tyler J. VanderWeele 与 Peng Ding（Ann Intern Med, 2017;167:268-274）提出的 E-value 指标，能够将这种定性岸辩转化为精确的定量阈值：在已校正现有协变量的前提下，未测量混杂因素必须同时与暴露（治疗）和临床结局达到至少 E-value 倍的风险关联强度，才足以将当前观测到的效应完全解释为混杂假象。'
      }</p>
      <h3>${isEn ? 'Mathematical Formula' : '核心数学公式'}</h3>
      <ul>
        <li><strong>RR &gt; 1</strong>: <code>E-value = RR + √(RR × (RR - 1))</code></li>
        <li><strong>RR &lt; 1 (${isEn ? 'Protective Effect' : '保护效应'})</strong>: <code>RR* = 1 / RR</code>, <code>E-value = RR* + √(RR* × (RR* - 1))</code></li>
        <li><strong>OR / HR (${isEn ? 'Common outcome ≥ 15%' : '常见结局发生率 ≥ 15%'})</strong>: <code>RR ≈ √OR</code></li>
      </ul>
    </section>
  `

  const scriptJs = `
    const elType = document.getElementById('evType');
    const elEst = document.getElementById('evEst');
    const elLow = document.getElementById('evLow');
    const elHigh = document.getElementById('evHigh');
    const outPoint = document.getElementById('outEPoint');
    const outCi = document.getElementById('outECi');
    const outSvg = document.getElementById('evSvgWrap');
    const outDef = document.getElementById('outDefenseText');
    const outReb = document.getElementById('outRebuttalText');

    async function runCalc() {
      const rawType = elType.value;
      const effect_type = rawType.startsWith('OR') ? 'OR' : rawType;
      const rare_outcome = rawType !== 'OR_COMMON';
      const estimate = parseFloat(elEst.value);
      const ci_lower = parseFloat(elLow.value);
      const ci_upper = parseFloat(elHigh.value);
      if (!(estimate > 0 && ci_lower > 0 && ci_upper > 0)) return;
      try {
        const res = await fetch('/api/public/tools/e-value', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ effect_type, estimate, ci_lower, ci_upper, rare_outcome, lang: '${isEn ? 'en' : 'zh'}' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Calculation error');
        outPoint.textContent = Number(data.e_value_point).toFixed(2);
        outCi.textContent = Number(data.e_value_ci).toFixed(2);
        outSvg.innerHTML = data.svg || '';
        outDef.textContent = (${isEn ? 'true' : 'false'})
          ? data.academic_defense_en
          : (data.academic_defense_en + '\\n\\n' + data.academic_defense_zh);
        outReb.textContent = (${isEn ? 'true' : 'false'})
          ? data.rebuttal_en
          : (data.rebuttal_zh + '\\n\\n' + data.rebuttal_en);
      } catch (e) {
        outDef.textContent = String(e.message || e);
      }
    }

    document.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.getAttribute('data-preset');
        if (p === 'dapahf') { elType.value = 'HR'; elEst.value = '0.74'; elLow.value = '0.65'; elHigh.value = '0.85'; }
        else if (p === 'deliver') { elType.value = 'HR'; elEst.value = '0.82'; elLow.value = '0.73'; elHigh.value = '0.92'; }
        else if (p === 'cohort') { elType.value = 'OR_RARE'; elEst.value = '2.35'; elLow.value = '1.48'; elHigh.value = '3.72'; }
        runCalc();
      });
    });

    document.getElementById('evCalcBtn').addEventListener('click', runCalc);
    [elType, elEst, elLow, elHigh].forEach(el => el.addEventListener('change', runCalc));

    function bindCopy(btnId, boxEl) {
      const btn = document.getElementById(btnId);
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(boxEl.textContent || '');
        const old = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = old; }, 1600);
      });
    }
    bindCopy('copyDefenseBtn', outDef);
    bindCopy('copyRebuttalBtn', outReb);
    runCalc();
  `

  return renderCommonLayout({
    lang,
    title,
    description,
    keywords: 'E-value calculator, VanderWeele E-value, unmeasured confounding sensitivity analysis, E-value计算器, 未测混杂敏感性分析, SCI审稿回复模板, Heurion',
    canonicalPath,
    zhPath,
    enPath,
    jsonLd,
    bodyHtml,
    scriptJs,
  })
}

function renderConsortPage(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const zhPath = '/tools/consort-strobe-flowchart'
  const enPath = '/en/tools/consort-strobe-flowchart'
  const canonicalPath = isEn ? enPath : zhPath

  const title = isEn
    ? 'CONSORT 2010 & STROBE Participant Flowchart Generator (Free Vector SVG / Mermaid) | Heurion'
    : 'CONSORT 2010 / STROBE 临床研究受试者纳排流程图在线生成器（免费导出矢量 SVG / PNG） | Heurion'
  const description = isEn
    ? 'Generate publication-grade CONSORT 2010 (RCT) and STROBE (observational cohort) participant flow diagrams online. Automatic exclusion arithmetic checking, vector SVG download, and Mermaid code export.'
    : '免登录在线生成符合 NEJM / JAMA / Lancet 投稿规范的 CONSORT 2010（随机对照试验）与 STROBE（观察性队列研究）受试者筛选入组流向图（Figure 1）。自动校验排除人数加减算术，一键下载高清 SVG 矢量图与 Mermaid 源码。'

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: title,
    url: `https://heurion.org${canonicalPath}`,
    applicationCategory: 'MedicalApplication, DesignApplication',
    operatingSystem: 'Web',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    description,
  }

  const defaultExclusions = isEn
    ? `Age &lt; 18 years or pregnancy | 84\nAcute decompensated HF or LVEF &gt; 40% | 266\nSevere renal impairment (eGFR &lt; 30 mL/min/1.73m²) | 192\nMissing baseline echocardiography or 24-mo follow-up | 188`
    : `年龄 &lt; 18 岁或妊娠期患者 (Age &lt; 18 or pregnancy) | 84\n急性失代偿期心衰或 LVEF &gt; 40% | 266\neGFR &lt; 30 mL/min/1.73m² 严重肾功能不全 | 192\n关键基线超声或 24 个月随访记录缺失 | 188`

  const defaultArm1 = isEn ? 'Dapagliflozin Group' : '达格列净组 (Dapagliflozin)'
  const defaultArm2 = isEn ? 'Standard Care Group' : '常规标准治疗组 (Standard Care)'

  const bodyHtml = `
    <div class="tool-breadcrumb">
      <a href="${isEn ? '/en' : '/'}">Heurion</a> <span>/</span>
      <a href="${isEn ? '/en/tools' : '/tools'}">${isEn ? 'Free Tools' : '临床科研工具箱'}</a> <span>/</span>
      <span>${isEn ? 'CONSORT / STROBE Flowchart Generator' : 'CONSORT / STROBE 流程图生成器'}</span>
    </div>
    <div class="tool-header">
      <p class="eyebrow"><span class="dot"></span>PUBLICATION FIGURE 1 · CONSORT 2010 &amp; STROBE COMPLIANT</p>
      <h1>${isEn ? 'CONSORT 2010 & STROBE Participant Flowchart Generator' : 'CONSORT 2010 / STROBE 受试者纳排流向图在线生成器'}</h1>
      <p class="lead">${
        isEn
          ? 'Stop aligning text boxes manually in PowerPoint or Visio. Enter your screening total, exclusion reasons, and study arms—our engine automatically validates the arithmetic and renders a publication-grade vector SVG flowchart.'
          : '告别用 PPT 或 Visio 手工画框对不齐、改一次纳排标准就要重算所有加减法的痛苦。填入初筛总人数、排除原因明细与分组随访人数，自动完成算术校验并生成出版级 SVG 矢量图。'
      }</p>
    </div>

    <div class="tool-grid">
      <div class="tool-card">
        <h2>${isEn ? '1. Configure Screening & Allocation Counts' : '1. 填写初筛、排除原因与分组人数'}</h2>
        <div class="form-row">
          <label for="csTitle">${isEn ? 'Diagram Title' : '流程图标题 (Figure Title)'}</label>
          <input id="csTitle" type="text" value="CONSORT 2010 / STROBE Cohort Selection Flow Diagram">
        </div>
        <div class="form-inline" style="grid-template-columns: 1fr 1fr;">
          <div class="form-row">
            <label for="csAssessed">${isEn ? 'Total Assessed (N)' : '初筛评估总人数 (Assessed N)'}</label>
            <input id="csAssessed" type="number" min="1" value="2150">
          </div>
          <div class="form-row">
            <label for="csEligible">${isEn ? 'Eligible / Enrolled (Auto-computed)' : '合格入组人数 (自动核算)'}</label>
            <input id="csEligible" type="number" min="0" value="1420" readonly style="opacity:0.8;">
          </div>
        </div>
        <div class="form-row">
          <label for="csExclusions">${isEn ? 'Exclusion Reasons (One per line: Reason | Count)' : '排除原因与人数明细（每行一条，格式：排除原因 | 人数）'}</label>
          <textarea id="csExclusions" rows="5">${defaultExclusions}</textarea>
        </div>
        <div class="form-inline" style="grid-template-columns: 1fr 1fr;">
          <div class="form-row">
            <label for="csArm1Name">${isEn ? 'Group 1 Name' : '分组 1 名称'}</label>
            <input id="csArm1Name" type="text" value="${defaultArm1}">
          </div>
          <div class="form-row">
            <label for="csArm1Alloc">${isEn ? 'Group 1 Allocated / Lost' : '分组 1 分配人数 / 失访数'}</label>
            <div style="display:flex;gap:6px;">
              <input id="csArm1Alloc" type="number" value="710" title="Allocated">
              <input id="csArm1Lost" type="number" value="18" title="Lost to follow-up">
            </div>
          </div>
        </div>
        <div class="form-inline" style="grid-template-columns: 1fr 1fr;">
          <div class="form-row">
            <label for="csArm2Name">${isEn ? 'Group 2 Name' : '分组 2 名称'}</label>
            <input id="csArm2Name" type="text" value="${defaultArm2}">
          </div>
          <div class="form-row">
            <label for="csArm2Alloc">${isEn ? 'Group 2 Allocated / Lost' : '分组 2 分配人数 / 失访数'}</label>
            <div style="display:flex;gap:6px;">
              <input id="csArm2Alloc" type="number" value="710" title="Allocated">
              <input id="csArm2Lost" type="number" value="22" title="Lost to follow-up">
            </div>
          </div>
        </div>
        <div class="action-bar">
          <button type="button" class="btn-run" id="csRenderBtn">${isEn ? 'Render Vector Flowchart' : '实时更新矢量流程图'}</button>
        </div>
      </div>

      <div class="tool-card">
        <h2>
          <span>${isEn ? '2. Vector SVG Preview & Export' : '2. 出版级矢量流向图预览与导出'}</span>
          <span style="display:flex;gap:8px;">
            <button type="button" class="btn-sec" id="dlSvgBtn">${isEn ? 'Download .SVG' : '下载 .SVG 矢量图'}</button>
            <button type="button" class="btn-sec" id="copyMermaidBtn">${isEn ? 'Copy Mermaid' : '复制 Mermaid 代码'}</button>
          </span>
        </h2>
        <div class="svg-preview" id="csSvgWrap"></div>
        <div class="form-row">
          <label>Mermaid Flowchart Code</label>
          <div class="copy-box" id="csMermaidBox" style="font-family:ui-monospace,Menlo,monospace;font-size:12px;"></div>
        </div>
        <div class="upsell-banner">
          <p>${
            isEn
              ? '<strong>Tired of counting exclusions by hand?</strong> Connect your raw clinical records in the Heurion Workstation—filter by age, ICD diagnosis, and lab values visually, and generate both the cohort dataset and CONSORT diagram automatically.'
              : '<strong>不想每次微调入排条件都手动重算排除人数？</strong> 在 Heurion 课题工作台中直接导入门诊/住院病历，通过可视化多维条件勾选受试者（自动分配 S001... 编号），一键同步导出科研宽表与受试者入组流向图。'
          }</p>
          <a class="btn-run" style="text-decoration:none;" href="/app?from=consort-flowchart">${isEn ? 'Auto-Filter Cohort in Heurion →' : '在 Heurion 自动纳排生成 →'}</a>
        </div>
      </div>
    </div>

    <section class="geo-capsule">
      <h2>${isEn ? 'CONSORT 2010 vs. STROBE Guidelines for Participant Flow Diagrams' : 'CONSORT 2010 与 STROBE 声明对医学论文 Figure 1 入组流向图的规范要求'}</h2>
      <p>${
        isEn
          ? 'Top medical journals (NEJM, The Lancet, JAMA, BMJ) strictly require a participant flow diagram (typically Figure 1) under the CONSORT 2010 statement (for randomized trials) and the STROBE statement (for observational cohort, case-control, and cross-sectional studies). Reviewers routinely check whether: (1) Total Assessed minus Total Excluded equals Enrolled/Allocated; (2) Specific clinical reasons and exact counts are provided for every exclusion step; and (3) Loss to follow-up and final analyzed sample sizes are explicitly accounted for in each arm.'
          : '国际医学期刊编辑委员会（ICMJE）及四大顶刊（NEJM、Lancet、JAMA、BMJ）强制要求随机对照试验遵循 CONSORT 2010 声明、观察性队列研究遵循 STROBE 声明提供受试者筛选入组流程图（通常作为论文 Figure 1）。审稿人最常核查的三个细节是：(1) 初筛总人数减去各项排除原因之和是否严格等于入组人数（算术自洽）；(2) 每个排除阶段是否列出了具体的临床或数据缺失原因及对应例数；(3) 各研究分组的分配例数、失访脱落例数与最终纳入统计分析（ITT / Per-Protocol）的例数是否清晰闭环。'
      }</p>
    </section>
  `

  const scriptJs = `
    const elTitle = document.getElementById('csTitle');
    const elAssessed = document.getElementById('csAssessed');
    const elEligible = document.getElementById('csEligible');
    const elExclusions = document.getElementById('csExclusions');
    const elArm1Name = document.getElementById('csArm1Name');
    const elArm1Alloc = document.getElementById('csArm1Alloc');
    const elArm1Lost = document.getElementById('csArm1Lost');
    const elArm2Name = document.getElementById('csArm2Name');
    const elArm2Alloc = document.getElementById('csArm2Alloc');
    const elArm2Lost = document.getElementById('csArm2Lost');
    const svgWrap = document.getElementById('csSvgWrap');
    const mermaidBox = document.getElementById('csMermaidBox');
    let lastSvg = '';

    async function updateConsort() {
      const total_assessed = parseInt(elAssessed.value, 10) || 0;
      const exclusions = elExclusions.value
        .split('\\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
          const parts = line.split('|');
          const reason = (parts[0] || '').trim();
          const count = parseInt((parts[1] || '0').trim(), 10) || 0;
          return { reason, count };
        });
      const totalExcluded = exclusions.reduce((s, e) => s + e.count, 0);
      const eligible_total = Math.max(0, total_assessed - totalExcluded);
      elEligible.value = String(eligible_total);

      const a1Alloc = parseInt(elArm1Alloc.value, 10) || 0;
      const a1Lost = parseInt(elArm1Lost.value, 10) || 0;
      const a2Alloc = parseInt(elArm2Alloc.value, 10) || 0;
      const a2Lost = parseInt(elArm2Lost.value, 10) || 0;

      const payload = {
        title: elTitle.value,
        lang: '${isEn ? 'en' : 'zh'}',
        total_assessed,
        exclusions,
        eligible_total,
        arms: [
          { name: elArm1Name.value, allocated: a1Alloc, lost_to_followup: a1Lost, discontinued: 0, analyzed: Math.max(0, a1Alloc - a1Lost) },
          { name: elArm2Name.value, allocated: a2Alloc, lost_to_followup: a2Lost, discontinued: 0, analyzed: Math.max(0, a2Alloc - a2Lost) }
        ]
      };

      const res = await fetch('/api/public/tools/consort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        lastSvg = data.svg || '';
        svgWrap.innerHTML = lastSvg;
        mermaidBox.textContent = data.mermaid || '';
      }
    }

    document.getElementById('csRenderBtn').addEventListener('click', updateConsort);
    [elTitle, elAssessed, elExclusions, elArm1Name, elArm1Alloc, elArm1Lost, elArm2Name, elArm2Alloc, elArm2Lost].forEach(el => {
      el.addEventListener('input', updateConsort);
    });

    document.getElementById('dlSvgBtn').addEventListener('click', () => {
      if (!lastSvg) return;
      const blob = new Blob([lastSvg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Heurion_CONSORT_Flowchart.svg';
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('copyMermaidBtn').addEventListener('click', (e) => {
      navigator.clipboard.writeText(mermaidBox.textContent || '');
      const btn = e.currentTarget;
      const old = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = old; }, 1500);
    });

    updateConsort();
  `

  return renderCommonLayout({
    lang,
    title,
    description,
    keywords: 'CONSORT 2010 flowchart generator, STROBE flow diagram template, participant selection flowchart SVG, CONSORT流程图生成器, STROBE入组流程图, 临床研究纳排流程图, Heurion',
    canonicalPath,
    zhPath,
    enPath,
    jsonLd,
    bodyHtml,
    scriptJs,
  })
}

function renderTable1Page(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const zhPath = '/tools/table-1-generator'
  const enPath = '/en/tools/table-1-generator'
  const canonicalPath = isEn ? enPath : zhPath

  const title = isEn
    ? 'Publication-Grade Table 1 Baseline Generator (Native Word .docx + SMD) | Heurion'
    : '医学论文 Table 1 基线特征三线表在线生成器（一键导出原生 Word .docx + SMD 计算） | Heurion'
  const description = isEn
    ? 'Generate NEJM/JAMA-style Table 1 baseline characteristic three-line tables from CSV/Excel data. Automatic normality testing, p-values, Standardized Mean Difference (SMD), local PHI privacy scan, and 1-click native Word (.docx) export.'
    : '免费免登录在线生成符合 SCI 医学期刊规范的 Table 1 基线特征三线表。支持粘贴 Excel/CSV 数据，内置 PHI 隐私脱敏扫描，自动判别正态/偏态分布并计算 Welch t 检验、秩和检验、卡方检验 P 值及两组间标准化均数差（SMD），一键下载 1.5pt/0.5pt 原生 Word (.docx) 文档。'

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: title,
    url: `https://heurion.org${canonicalPath}`,
    applicationCategory: 'MedicalApplication, ScientificApplication',
    operatingSystem: 'Web',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    description,
  }

  const demoCsv = `subject_id,group,age,sex,bmi,lvef,nt_probnp,diabetes,nyha_class
S001,Dapagliflozin,64,Male,26.4,31.2,1420,Yes,II
S002,Dapagliflozin,59,Female,24.8,34.5,980,No,II
S003,Dapagliflozin,71,Male,28.1,26.0,2890,Yes,III
S004,Dapagliflozin,67,Male,25.3,33.0,1650,No,II
S005,Dapagliflozin,62,Female,27.9,29.5,2110,Yes,III
S006,Dapagliflozin,55,Male,23.6,36.8,840,No,II
S007,Dapagliflozin,74,Female,29.2,24.5,3420,Yes,IV
S008,Dapagliflozin,68,Male,26.0,32.1,1540,Yes,II
S009,Dapagliflozin,61,Male,25.7,35.0,1190,No,II
S010,Dapagliflozin,66,Female,27.1,30.4,1870,Yes,III
S011,Standard Care,65,Male,26.9,30.8,1510,Yes,II
S012,Standard Care,60,Female,25.1,33.9,1050,No,II
S013,Standard Care,72,Male,28.5,25.4,3120,Yes,III
S014,Standard Care,69,Female,26.2,31.5,1780,Yes,III
S015,Standard Care,63,Male,27.4,28.9,2240,No,III
S016,Standard Care,57,Male,24.1,35.6,920,No,II
S017,Standard Care,75,Female,29.8,23.8,3690,Yes,IV
S018,Standard Care,66,Male,25.9,32.6,1490,Yes,II
S019,Standard Care,62,Female,26.5,34.2,1280,No,II
S020,Standard Care,70,Male,28.0,27.5,2610,Yes,III`

  const bodyHtml = `
    <div class="tool-breadcrumb">
      <a href="${isEn ? '/en' : '/'}">Heurion</a> <span>/</span>
      <a href="${isEn ? '/en/tools' : '/tools'}">${isEn ? 'Free Tools' : '临床科研工具箱'}</a> <span>/</span>
      <span>${isEn ? 'Table 1 Native Word (.docx) Generator' : 'Table 1 三线表生成器 (.docx)'}</span>
    </div>
    <div class="tool-header">
      <p class="eyebrow"><span class="dot"></span>BIOSTATISTICS &amp; NATIVE WORD (.DOCX) THREE-LINE TABLE ENGINE</p>
      <h1>${isEn ? 'Publication-Grade Table 1 Baseline Generator (Native Word .docx + SMD)' : '医学论文发表级 Table 1（基线特征三线表）原生 Word 生成器'}</h1>
      <p class="lead">${
        isEn
          ? 'Paste your de-identified cohort CSV/TSV table below. Our engine scans for PHI privacy leaks, automatically selects parametric (Mean ± SD, Welch’s t-test) vs. non-parametric (Median [IQR], Mann-Whitney U) tests, computes two-group Standardized Mean Differences (SMD), and exports a true 1.5pt/0.5pt Word (.docx) document.'
          : '免登录粘贴 CSV 或 Excel 表格数据，自动完成正态性检验分流（正态 Mean ± SD / 偏态 Median [IQR]）、分类变量卡方/Fisher 精确检验、两组间标准化均数差（SMD）计算，并一键导出带 1.5pt 顶底线、0.5pt 栏目线、宋体/Times 学术排版的原生 Word (.docx) 文件。'
      }</p>
    </div>

    <div class="tool-grid">
      <div class="tool-card">
        <h2>${isEn ? '1. Paste CSV / Excel Data (Max 500 Rows)' : '1. 粘贴 CSV / Excel 队列数据（免登录支持 ≤500 行）'}</h2>
        <div id="phiBadge" style="margin-bottom:12px;padding:8px 12px;border-radius:8px;font-size:12.5px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.35);color:#34d399;">
          ✓ ${isEn ? 'PHI Privacy Guard Active: Scanning for unmasked names, IDs, phones, and MRNs' : '内置 PHI 隐私守卫已就绪：自动扫描姓名、身份证号、手机号与病案号'}
        </div>
        <div class="form-row">
          <label for="t1Group">${isEn ? 'Group Stratification Column' : '分组变量列名 (Group Column)'}</label>
          <input id="t1Group" type="text" value="group" placeholder="e.g. group, treatment, arm">
        </div>
        <div class="form-row">
          <label for="t1NonNormal">${isEn ? 'Skewed Continuous Variables (Median [IQR], comma-separated)' : '指定偏态连续变量（以 Median [IQR] 与秩和检验呈现，逗号分隔）'}</label>
          <input id="t1NonNormal" type="text" value="nt_probnp" placeholder="e.g. nt_probnp, crp, los">
        </div>
        <div class="form-row">
          <label for="t1Csv">${isEn ? 'Cohort Data (CSV or Tab-separated)' : '队列数据内容（支持 CSV 逗号或 Excel 制表符分隔）'}</label>
          <textarea id="t1Csv" rows="11">${demoCsv}</textarea>
        </div>
        <div class="action-bar">
          <button type="button" class="btn-run" id="t1RunBtn">${isEn ? 'Generate Table 1 Preview' : '立即生成 Table 1 三线表'}</button>
          <button type="button" class="btn-sec" id="t1DocxBtn">${isEn ? 'Download Native Word (.docx)' : '下载原生 Word (.docx) 三线表'}</button>
        </div>
      </div>

      <div class="tool-card">
        <h2>
          <span>${isEn ? '2. Academic Three-Line Table Preview' : '2. 发表级学术三线表实时预览'}</span>
          <button type="button" class="btn-sec" id="t1CopyMdBtn">${isEn ? 'Copy Markdown' : '复制 Markdown'}</button>
        </h2>
        <div class="academic-table-wrap" id="t1PreviewWrap"></div>
        <div class="upsell-banner">
          <p>${
            isEn
              ? '<strong>Analyzing &gt;500 patients or need Kaplan-Meier &amp; Cox regression?</strong> Import your full SPSS/Stata/Excel dataset into the Heurion Workstation to run isolated Python survival analysis and insert Table 1 directly into your manuscript.'
              : '<strong>样本量超过 500 例，或者接着要做 Kaplan-Meier 生存曲线与多因素 Cox 回归？</strong> 一键进入 Heurion 临床科研工作台，支持导入 CSV/Excel/SPSS/SAS/Stata 全量数据，在网络隔离沙箱中自动跑完后续全套统计图表。'
          }</p>
          <a class="btn-run" style="text-decoration:none;" href="/app?from=table-1-generator">${isEn ? 'Continue in Heurion Workstation →' : '转入 Heurion 跑生存分析与回归 →'}</a>
        </div>
      </div>
    </div>

    <section class="geo-capsule">
      <h2>${isEn ? 'Academic Standards for Table 1 in Clinical Research Manuscripts' : '医学顶刊（NEJM / JAMA / Lancet）对 Table 1 基线特征三线表的统计与排版规范'}</h2>
      <p>${
        isEn
          ? 'In clinical trials and observational cohort studies, Table 1 summarizes baseline demographic and clinical characteristics across exposure or treatment groups. To meet peer-review standards: (1) Normally distributed continuous variables are reported as Mean ± SD and compared using Welch’s t-test or one-way ANOVA; (2) Skewed biomarkers (such as NT-proBNP or hs-CRP) are reported as Median [IQR] and compared via the Mann-Whitney U or Kruskal-Wallis test; (3) Categorical variables are reported as n (%) and tested via Pearson’s Chi-square or Fisher’s exact test; and (4) Observational studies increasingly report the Standardized Mean Difference (SMD, where |SMD| < 0.10 indicates baseline covariate balance, Austin 2009).'
          : '在临床医学论文中，Table 1（基线人口学与临床特征表）是审稿人评估队列代表性与组间均衡性的第一张核心证据表。Heurion 的 Table 1 引擎严格遵循以下生物统计与排版准则：(1) 自动或按指定识别正态分布连续变量（Mean ± SD，采用 Welch t 检验或单因素方差分析）与非正态偏态指标（如 NT-proBNP，呈现为 Median [IQR]，采用 Mann-Whitney U 秩和检验）；(2) 分类变量自动计算例数与构成比 n (%)，并在期望频数 <5 时自动切换 Fisher 精确概率法；(3) 自动计算两组间绝对标准化均数差（SMD，Austin 2009 标准：SMD < 0.10 提示组间基线均衡）；(4) 原生生成包含 1.5pt 顶底粗线、0.5pt 表头分隔线及中英文混合字体（宋体 + Times New Roman）的 Word (.docx) 文档。'
      }</p>
    </section>
  `

  const scriptJs = `
    const elGroup = document.getElementById('t1Group');
    const elNonNormal = document.getElementById('t1NonNormal');
    const elCsv = document.getElementById('t1Csv');
    const phiBadge = document.getElementById('phiBadge');
    const previewWrap = document.getElementById('t1PreviewWrap');
    let lastMarkdown = '';

    function getOptions() {
      const group_col = elGroup.value.trim() || undefined;
      const non_normal_vars = elNonNormal.value.split(',').map(s => s.trim()).filter(Boolean);
      return {
        group_col,
        non_normal_vars,
        include_overall: true,
        include_p_value: true,
        include_smd: true
      };
    }

    async function renderTable1() {
      const res = await fetch('/api/public/tools/table1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: elCsv.value, options: getOptions() })
      });
      const data = await res.json();
      if (!res.ok) {
        previewWrap.innerHTML = '<p style="color:#dc2626;">' + (data.error || 'Error') + '</p>';
        return;
      }
      const isEnMode = ${isEn ? 'true' : 'false'};
      if (data.phi_clean) {
        phiBadge.style.background = 'rgba(16,185,129,0.12)';
        phiBadge.style.borderColor = 'rgba(16,185,129,0.35)';
        phiBadge.style.color = '#34d399';
        phiBadge.textContent = isEnMode
          ? ('✓ PHI Privacy Check Passed: No unmasked names, IDs, phones, or MRNs detected (' + data.row_count + ' rows)')
          : ('✓ PHI 隐私安全扫描通过：未检出未脱敏姓名、身份证号、手机号或病案号 (' + data.row_count + ' rows)');
      } else {
        phiBadge.style.background = 'rgba(239,68,68,0.15)';
        phiBadge.style.borderColor = 'rgba(239,68,68,0.45)';
        phiBadge.style.color = '#fca5a5';
        phiBadge.textContent = isEnMode
          ? ('⚠ Detected ' + data.phi_findings_count + ' potential PHI items (unmasked ID/phone/name). Please de-identify before publication!')
          : ('⚠ 检测到 ' + data.phi_findings_count + ' 处潜在 PHI 敏感信息（如身份证/手机号/姓名），建议先脱敏后再用于发表！');
      }

      const t1 = data.table1;
      lastMarkdown = t1.markdown || '';
      const headers = t1.headers || [];
      const rows = t1.rows || [];
      let html = '<table class="academic-table"><caption>' + (t1.title || 'Table 1') + '</caption><thead><tr>';
      headers.forEach(h => { html += '<th>' + h + '</th>'; });
      html += '</tr></thead><tbody>';
      rows.forEach(r => {
        const cls = r.indent > 0 ? ' class="indent-1"' : '';
        html += '<tr><td' + cls + '>' + (r.indent > 0 ? '&nbsp;&nbsp;' : '<strong>') + r.label + (r.indent > 0 ? '' : '</strong>') + '</td>';
        if (t1.headers.some(h => h.startsWith('Overall'))) {
          html += '<td>' + (r.overall || '') + '</td>';
        }
        (t1.groups || []).forEach(g => {
          html += '<td>' + ((r.groups && r.groups[g.name]) || '') + '</td>';
        });
        if (t1.headers.includes('P value') || t1.headers.includes('P-value')) {
          html += '<td>' + (r.p_value_formatted || '') + '</td>';
        }
        if (t1.headers.includes('SMD')) {
          html += '<td>' + (r.smd_formatted || '') + '</td>';
        }
        html += '</tr>';
      });
      html += '</tbody></table>';
      if (t1.footnotes && t1.footnotes.length) {
        html += '<div class="academic-table-foot">' + t1.footnotes.join('<br>') + '</div>';
      }
      previewWrap.innerHTML = html;
    }

    document.getElementById('t1RunBtn').addEventListener('click', renderTable1);
    document.getElementById('t1DocxBtn').addEventListener('click', async () => {
      const res = await fetch('/api/public/tools/table1-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: elCsv.value, options: getOptions() })
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Heurion_Table1_Baseline.docx';
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('t1CopyMdBtn').addEventListener('click', (e) => {
      navigator.clipboard.writeText(lastMarkdown);
      const btn = e.currentTarget;
      const old = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = old; }, 1500);
    });

    renderTable1();
  `

  return renderCommonLayout({
    lang,
    title,
    description,
    keywords: 'Table 1 generator docx, baseline characteristics three-line table Word, Standardized Mean Difference SMD calculator, 医学论文三线表生成器, Table 1自动生成Word, 基线特征表SMD计算, Heurion',
    canonicalPath,
    zhPath,
    enPath,
    jsonLd,
    bodyHtml,
    scriptJs,
  })
}

function renderCitationCheckerPage(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const zhPath = '/tools/pubmed-citation-checker'
  const enPath = '/en/tools/pubmed-citation-checker'
  const canonicalPath = isEn ? enPath : zhPath

  const title = isEn
    ? 'PubMed Citation & Effect Size (HR/OR/95% CI) Checker — Detect AI Hallucinated References | Heurion'
    : '医学论文 PubMed 引用真伪与统计效应量（HR/OR/95% CI）核验工具（防 AI 假文献） | Heurion'
  const description = isEn
    ? 'Verify medical manuscript references against NCBI PubMed and Crossref. Detect AI-hallucinated PMIDs/DOIs and check whether inline Hazard Ratios (HR), Odds Ratios (OR), and 95% CIs match the original PubMed abstract.'
    : '免费免登录核验医学论文参考文献真伪：实时对接 NCBI PubMed 与 Crossref 数据库，秒级揪出大模型凭空编造的假 PMID / 假 DOI，并自动核对正文中引用的 HR / OR / 95% CI 数值是否与 PubMed 原文摘要一致。'

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: title,
    url: `https://heurion.org${canonicalPath}`,
    applicationCategory: 'MedicalApplication, ReferenceApplication',
    operatingSystem: 'Web',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    description,
  }

  const demoDraft = isEn
    ? `In patients with heart failure and reduced ejection fraction (HFrEF), the DAPA-HF trial demonstrated that dapagliflozin reduced the primary composite outcome of worsening heart failure or cardiovascular death by 26% (HR 0.74, 95% CI 0.65–0.85, P<0.001) [1].\nHowever, in patients with mildly reduced or preserved ejection fraction (the DELIVER trial), an AI-assisted draft mistakenly claimed a 42% relative risk reduction (HR 0.58, 95% CI 0.45–0.71) [2].\nFurthermore, a generic LLM review cited a non-existent 2024 multicenter trial (PMID: 99999999) [3].\n\nReferences:\n[1] McMurray JJV, Solomon SD, Inzucchi SE, et al. Dapagliflozin in Patients with Heart Failure and Reduced Ejection Fraction. N Engl J Med. 2019;381:1995-2008. PMID: 31535829\n[2] Solomon SD, McMurray JJV, Claggett B, et al. Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. N Engl J Med. 2022;387:1089-1098. PMID: 36027570\n[3] Fabricated AI Author, et al. Fictional Trial of SGLT2i in Acute Myocarditis. Lancet. 2024. PMID: 99999999`
    : `在射血分数降低的心力衰竭（HFrEF）患者中，DAPA-HF 临床试验表明达格列净可使心衰恶化或心血管死亡主要复合终点风险显著降低 26%（HR 0.74, 95% CI 0.65–0.85, P<0.001）[1]。\n而在射血分数轻度降低或保留的心衰人群（DELIVER 试验）中，达格列净据某草稿误写称使主要终点降低 42%（HR 0.58, 95% CI 0.45–0.71）[2]。\n此外，某通用大模型生成的综述草稿中还引用了一篇所谓的 2024 年多中心试验（PMID: 99999999）[3]。\n\nReferences:\n[1] McMurray JJV, Solomon SD, Inzucchi SE, et al. Dapagliflozin in Patients with Heart Failure and Reduced Ejection Fraction. N Engl J Med. 2019;381:1995-2008. PMID: 31535829\n[2] Solomon SD, McMurray JJV, Claggett B, et al. Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction. N Engl J Med. 2022;387:1089-1098. PMID: 36027570\n[3] Fabricated AI Author, et al. Fictional Trial of SGLT2i in Acute Myocarditis. Lancet. 2024. PMID: 99999999`

  const bodyHtml = `
    <div class="tool-breadcrumb">
      <a href="${isEn ? '/en' : '/'}">Heurion</a> <span>/</span>
      <a href="${isEn ? '/en/tools' : '/tools'}">${isEn ? 'Free Tools' : '临床科研工具箱'}</a> <span>/</span>
      <span>${isEn ? 'PubMed Citation & Effect Size Checker' : 'PubMed 引用真伪与效应量核验'}</span>
    </div>
    <div class="tool-header">
      <p class="eyebrow"><span class="dot"></span>ANTI-HALLUCINATION GROUNDING · NCBI PUBMED &amp; CROSSREF</p>
      <h1>${isEn ? 'PubMed Citation & Statistical Effect Size (HR/OR/95% CI) Checker' : '医学论文 PubMed 引用真伪与统计效应量（HR/OR/95% CI）核验器'}</h1>
      <p class="lead">${
        isEn
          ? 'Generic LLMs frequently fabricate non-existent PMIDs or misquote Hazard Ratios from real trials. Paste your manuscript excerpt below to cross-check every PMID/DOI and inline statistical claim against authentic NCBI PubMed records.'
          : '通用大模型写医学综述或 Discussion 时，极易凭空捏造假 PMID，或把真实文献里的 HR / 95% CI 数值张冠李戴。粘贴你的论文段落与参考文献，一键对照 NCBI PubMed 原文摘要进行“红绿灯”交叉核验。'
      }</p>
    </div>

    <div class="tool-grid">
      <div class="tool-card">
        <h2>${isEn ? '1. Paste Manuscript Paragraph & References' : '1. 粘贴含引用的论文草稿与参考文献（含 PMID 或 DOI）'}</h2>
        <div class="form-row">
          <label for="ccText">${isEn ? 'Manuscript Excerpt (Demo includes: 1 verified [1], 1 mismatched HR [2], 1 hallucinated PMID [3])' : '文稿内容（内置演示包含：1 处真实匹配 [1]、1 处 HR 数值写错 [2]、1 处伪造假 PMID [3]）'}</label>
          <textarea id="ccText" rows="13">${escapeHtml(demoDraft)}</textarea>
        </div>
        <div class="action-bar">
          <button type="button" class="btn-run" id="ccRunBtn">${isEn ? 'Verify Citations Against PubMed' : '立即核验文献真伪与效应量'}</button>
        </div>
      </div>

      <div class="tool-card">
        <h2>${isEn ? '2. Traffic-Light Grounding Report' : '2. PubMed 原文溯源与效应量核验报告'}</h2>
        <div id="ccSummaryBar" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;"></div>
        <div id="ccReportList"></div>
        <div class="upsell-banner">
          <p>${
            isEn
              ? '<strong>Want real-time citation write-guards while drafting?</strong> In the Heurion Workstation, AI can only insert verified PubMed/Crossref citations via structured operations, with character-level inline diffs.'
              : '<strong>希望在写论文时直接杜绝假文献写入？</strong> 在 Heurion 协同工作台中，内置严格的“引用写前守卫（Citation Write Guard）”——AI 只能通过已核验的 PubMed/Crossref 文献库插入正式引文，并以行内修订模式逐字呈现修改。'
          }</p>
          <a class="btn-run" style="text-decoration:none;" href="/app?from=pubmed-citation-checker">${isEn ? 'Write with Verified Citations in Heurion →' : '在 Heurion 开启防幻觉论文写作 →'}</a>
        </div>
      </div>
    </div>

    <section class="geo-capsule">
      <h2>${isEn ? 'How Heurion Eliminates Hallucinated Medical Citations' : '为什么不能直接用通用聊天大模型生成医学论文参考文献？'}</h2>
      <p>${
        isEn
          ? 'Studies evaluating general-purpose LLMs in biomedical writing show that 20% to 40% of generated references contain fabricated DOIs, mismatched PMIDs, or inaccurate effect sizes (e.g., inventing a p-value or swapping primary and secondary endpoint Hazard Ratios). Heurion enforces a strict two-layer verification architecture: (1) Metadata Grounding via NCBI Entrez E-utilities (PubMed/PMC), Europe PMC, Crossref, and OpenAlex; and (2) Claim-Level Numerical Verification comparing extracted HR/OR/RR and 95% confidence intervals against the XML abstract of the source publication.'
          : '多项发表于医学信息学期刊的研究表明，直接使用通用聊天大模型生成医学综述或讨论段落时，20%–40% 的参考文献存在“幻觉拼接”（把真实作者、真实期刊年份与虚构的 PMID 拼凑在一起，或者编造虚假的 HR/OR 效应量）。Heurion 采用两层核验机制：(1) 权威元数据核验：实时查询 NCBI PubMed E-utilities、Europe PMC、Crossref 与 OpenAlex；(2) 论断级数值比对：自动抽取正文句子中引用的 HR / OR / RR 及 95% CI 数值，并与 PubMed XML 结构化摘要中的原始实验结果进行交叉比对。'
      }</p>
    </section>
  `

  const scriptJs = `
    const elText = document.getElementById('ccText');
    const summaryBar = document.getElementById('ccSummaryBar');
    const reportList = document.getElementById('ccReportList');
    const isEnMode = ${isEn ? 'true' : 'false'};

    async function runCheck() {
      reportList.innerHTML = '<p style="color:#94a3b8;">Checking against NCBI PubMed & Crossref...</p>';
      const res = await fetch('/api/public/tools/citation-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: elText.value })
      });
      const data = await res.json();
      if (!res.ok) {
        reportList.innerHTML = '<p style="color:#ef4444;">' + (data.error || 'Error') + '</p>';
        return;
      }
      const s = data.summary || { total: 0, verified: 0, mismatch: 0, unverifiable: 0 };
      summaryBar.innerHTML = isEnMode
        ? ('<span class="tool-badge" style="color:#34d399;border-color:rgba(52,211,153,0.4);">🟢 Verified: ' + s.verified + '</span>' +
           '<span class="tool-badge" style="color:#fbbf24;border-color:rgba(251,191,36,0.4);background:rgba(251,191,36,0.1);">🟡 Effect Size Mismatch: ' + s.mismatch + '</span>' +
           '<span class="tool-badge" style="color:#f87171;border-color:rgba(248,113,113,0.4);background:rgba(248,113,113,0.1);">🔴 Hallucinated / Not Found: ' + s.unverifiable + '</span>')
        : ('<span class="tool-badge" style="color:#34d399;border-color:rgba(52,211,153,0.4);">🟢 已核验通过: ' + s.verified + '</span>' +
           '<span class="tool-badge" style="color:#fbbf24;border-color:rgba(251,191,36,0.4);background:rgba(251,191,36,0.1);">🟡 效应量数值偏差: ' + s.mismatch + '</span>' +
           '<span class="tool-badge" style="color:#f87171;border-color:rgba(248,113,113,0.4);background:rgba(248,113,113,0.1);">🔴 疑似伪造/查无此文: ' + s.unverifiable + '</span>');

      const items = data.items || [];
      if (items.length === 0) {
        reportList.innerHTML = '<p style="color:#cbd5e1;">' + (isEnMode
          ? 'No PMID (e.g., PMID: 31535829) or DOI (e.g., 10.1056/...) identifiers detected in the text.'
          : '未在文本中识别到 PMID (如 PMID: 31535829) 或 DOI (如 10.1056/...) 标识符。') + '</p>';
        return;
      }
      reportList.innerHTML = items.map(it => {
        const icon = it.status === 'verified' ? '🟢' : it.status === 'mismatch' ? '🟡' : '🔴';
        const titleHtml = it.title
          ? '<div style="font-weight:700;color:#fff;margin:4px 0;">' + it.title + ' <span style="color:#00ff93;font-weight:400;">(' + (it.journal || '') + ' ' + (it.year || '') + ')</span></div>'
          : '<div style="font-weight:700;color:#fca5a5;margin:4px 0;">' + (isEnMode ? 'No matching authentic record found in PubMed/Crossref' : '未找到匹配的真实文献记录') + '</div>';
        const msg = isEnMode ? it.message_en : it.message_zh;
        return '<div class="cite-item ' + it.status + '">' +
          '<div style="font-size:12px;color:#94a3b8;font-family:ui-monospace,Menlo,monospace;">' + icon + ' ' + it.raw_identifier + '</div>' +
          titleHtml +
          '<div style="font-size:13px;color:#cbd5e1;line-height:1.55;margin-top:6px;">' + msg + '</div>' +
        '</div>';
      }).join('');
    }

    document.getElementById('ccRunBtn').addEventListener('click', runCheck);
    runCheck();
  `

  return renderCommonLayout({
    lang,
    title,
    description,
    keywords: 'PubMed citation checker, verify medical references AI, detect hallucinated PMIDs, check Hazard Ratio 95% CI PubMed, 医学论文假文献核查, PubMed参考文献核验, Heurion',
    canonicalPath,
    zhPath,
    enPath,
    jsonLd,
    bodyHtml,
    scriptJs,
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
