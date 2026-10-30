/**
 * 官网多语言服务端渲染 (SSR) 与免登录临床科研微型工具页（Programmatic SEO & GEO）
 *
 * 采用与主页一致的 Nordic / Scandinavian Editorial 设计系统（#FAF8F4 暖白纸张、#EFECE4 亚麻灰、#151C19 深林墨色、#233E33 北欧深松绿）。
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
  const enBlockMatch = /\ben:\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\};/.exec(zhHtml)
  const enDict: Record<string, string> = {}
  if (enBlockMatch?.[1]) {
    const kvRegex = /([a-zA-Z0-9_]+):\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g
    let m: RegExpExecArray | null
    while ((m = kvRegex.exec(enBlockMatch[1])) !== null) {
      const k = m[1]!
      const raw = m[2] ?? m[3] ?? ''
      const v = raw.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, '\n')
      enDict[k] = v
    }
  }

  let html = zhHtml
    .replace('<html lang="zh-CN">', '<html lang="en">')
    .replace(/<link rel="canonical" href="https:\/\/heurion\.org\/"\s*\/?>/, '<link rel="canonical" href="https://heurion.org/en">')
    .replace(/<meta property="og:url" content="https:\/\/heurion\.org\/"\s*\/?>/, '<meta property="og:url" content="https://heurion.org/en">')
    .replace(/<meta property="og:locale" content="zh_CN"\s*\/?>/, '<meta property="og:locale" content="en_US">')
    .replace(/<meta property="og:locale:alternate" content="en_US"\s*\/?>/, '<meta property="og:locale:alternate" content="zh_CN">')
    .replace('>EN</button>', '>中文</button>')
    .replace('<span id="langText">EN</span>', '<span id="langText">中文</span>')
    .replace(/href="\/tools"/g, 'href="/en/tools"')

  html = html
    .replace(
      '"name": "什么是 Heurion（临床科研 AI 工作台），它与通用大模型（ChatGPT / Claude）有何本质区别？"',
      '"name": "What is Heurion, and how does it differ fundamentally from generic LLMs like ChatGPT or Claude?"',
    )
    .replace(
      '"text": "Heurion 2.0 是专为临床医生与医学研究者打造的端到端临床科研智能工作台。它在确定性 Yjs CRDT 画布上提供受契约守卫的 Word/PPTX 协同、沙箱化生物统计计算与零外泄患者档案管理。"',
      '"text": "Heurion 2.0 is an end-to-end Contract-Guarded Clinical Research Intelligence workstation providing structure-preserving Word/PPTX authoring, sandboxed biostatistics, and zero-leakage local PHI gatekeeping on a deterministic Yjs CRDT canvas."',
    )
    .replace(
      '"name": "什么是 Aegis OS，它与 Heurion 2.0 临床科研工作台是什么关系？"',
      '"name": "What is Aegis OS, and how does it work together with the Heurion 2.0 Clinical Workstation?"',
    )
    .replace(
      '"text": "Aegis OS (aegis-os) 是 Heurion Research 研发的开源多租户智能体操作系统内核，提供写时复制影子工作区、内核沙箱与 AAP-1.0 离线 Ed25519 人类审批租约。Heurion 2.0 是首个原生接入 AAP-1.0 的第一方临床应用。"',
      '"text": "Aegis OS (aegis-os) is an open-source transactional multi-tenant agent operating system runtime providing Copy-on-Write shadow workspaces, kernel sandboxing, and AAP-1.0 offline Ed25519 human-in-the-loop leases. Heurion 2.0 is the first native reference application on AAP-1.0."',
    )

  html = html.replace(
    /<([a-zA-Z0-9]+)(\s[^>]*?\bdata-i18n(?:-html)?="([a-zA-Z0-9_]+)"[^>]*)>([\s\S]*?)<\/\1>/g,
    (whole, tag: string, attrs: string, key: string) => {
      const val = enDict[key]
      if (!val) return whole
      return `<${tag}${attrs}>${val}</${tag}>`
    },
  )

  return html
}

/** Nordic Editorial 工具工作台样式系统 */
const TOOL_EXTRA_CSS = `
  .tool-hero {
    padding: 3.75rem 0 3.25rem;
    background-color: var(--bg-primary);
    background-image:
      linear-gradient(100deg, rgba(250, 248, 244, 0.95) 0%, rgba(250, 248, 244, 0.88) 52%, rgba(244, 241, 234, 0.68) 100%),
      url('https://images.unsplash.com/photo-1532094349884-543bc11b234d?auto=format&fit=crop&w=1800&q=80');
    background-size: cover;
    background-position: center 42%;
    border-bottom: 1px solid var(--border);
  }
  .tool-breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-family: var(--mono);
    font-size: 0.68rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-muted);
    margin-bottom: 1.15rem;
    flex-wrap: wrap;
  }
  .tool-breadcrumb a {
    color: var(--ink-secondary);
    border-bottom: 1px solid transparent;
  }
  .tool-breadcrumb a:hover {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .tool-header {
    max-width: 52rem;
  }
  .tool-header .label-caps {
    margin-bottom: 0.75rem;
  }
  .tool-header h1 {
    font-family: var(--serif);
    font-size: clamp(2rem, 3.1vw, 2.75rem);
    font-weight: 300;
    line-height: 1.2;
    letter-spacing: -0.02em;
    margin: 0 0 1rem;
    color: var(--ink);
  }
  html[lang="zh-CN"] .tool-header h1 {
    font-size: clamp(1.75rem, 2.5vw, 2.3rem);
    line-height: 1.32;
    letter-spacing: 0.01em;
  }
  .tool-header h1 em {
    font-style: italic;
    font-weight: 400;
    color: var(--accent);
  }
  html[lang="zh-CN"] .tool-header h1 em {
    font-style: normal;
    border-bottom: 1px solid rgba(35, 62, 51, 0.35);
    padding-bottom: 0.04em;
  }
  .tool-header .lead {
    font-size: 0.9375rem;
    color: var(--ink-secondary);
    max-width: 44rem;
    line-height: 1.68;
    margin: 0;
  }
  .tool-body {
    background: var(--bg-neutral);
    padding: 3.75rem 0 4.5rem;
    border-bottom: 1px solid var(--border);
  }
  .hub-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 2rem;
  }
  @media (max-width: 900px) {
    .hub-grid { grid-template-columns: 1fr; }
  }
  .hub-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    padding: 2.25rem 2.35rem;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 1.85rem;
    transition: border-color 0.25s ease;
  }
  .hub-card:hover {
    border-color: rgba(35, 62, 51, 0.45);
  }
  .tool-grid {
    display: grid;
    grid-template-columns: 1fr 1.22fr;
    gap: 2rem;
    align-items: start;
  }
  @media (max-width: 960px) {
    .tool-grid { grid-template-columns: 1fr; }
  }
  .tool-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    padding: 2rem 2.15rem;
  }
  .tool-card h2 {
    font-family: var(--serif);
    font-size: 1.25rem;
    font-weight: 400;
    margin: 0 0 1.25rem;
    padding-bottom: 0.85rem;
    border-bottom: 1px solid var(--border);
    color: var(--ink);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .form-row {
    margin-bottom: 1rem;
  }
  .form-row label {
    display: block;
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-secondary);
    margin-bottom: 0.45rem;
  }
  .form-row input,
  .form-row select,
  .form-row textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 0.62rem 0.78rem;
    border-radius: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    color: var(--ink);
    font-size: 0.875rem;
    font-family: var(--sans);
    transition: border-color 0.2s ease;
  }
  .form-row textarea {
    font-family: var(--mono);
    font-size: 0.78rem;
    line-height: 1.55;
    resize: vertical;
  }
  .form-row input:focus,
  .form-row select:focus,
  .form-row textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .form-inline {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
  }
  .preset-bar {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 1.15rem;
  }
  .preset-btn {
    background: var(--bg-neutral);
    border: 1px solid var(--border);
    color: var(--ink-secondary);
    padding: 0.35rem 0.7rem;
    font-family: var(--mono);
    font-size: 0.7rem;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .preset-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }
  .action-bar {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 1.25rem;
  }
  .btn-run {
    background: var(--accent);
    color: var(--ink-light);
    font-weight: 400;
    border: 1px solid var(--accent);
    padding: 0.65rem 1.25rem;
    font-size: 0.8125rem;
    letter-spacing: 0.02em;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    text-decoration: none;
  }
  .btn-run:hover {
    background: var(--ink);
    border-color: var(--ink);
    color: var(--ink-light);
  }
  .btn-sec {
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--border);
    padding: 0.58rem 1rem;
    font-size: 0.78rem;
    font-family: var(--mono);
    cursor: pointer;
    text-decoration: none;
  }
  .btn-sec:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
    margin-bottom: 1.25rem;
  }
  .kpi-box {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    padding: 1rem 1.15rem;
  }
  .kpi-box .kpi-label {
    font-family: var(--mono);
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
  }
  .kpi-box .kpi-val {
    font-family: var(--serif);
    font-size: 1.85rem;
    font-weight: 300;
    color: var(--accent);
    margin-top: 0.25rem;
    font-variant-numeric: tabular-nums;
  }
  .svg-preview {
    background: #FFFFFF;
    border: 1px solid var(--border);
    padding: 1rem;
    overflow-x: auto;
    text-align: center;
    margin: 0.85rem 0 1.15rem;
  }
  .svg-preview svg {
    max-width: 100%;
    height: auto;
  }
  .copy-box {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    padding: 0.9rem 1rem;
    font-size: 0.8125rem;
    color: var(--ink);
    line-height: 1.65;
    white-space: pre-wrap;
    margin-bottom: 0.65rem;
  }
  .upsell-banner {
    margin-top: 1.5rem;
    padding: 1.15rem 1.35rem;
    background: var(--bg-neutral);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.25rem;
    flex-wrap: wrap;
  }
  .upsell-banner p {
    margin: 0;
    font-size: 0.84rem;
    color: var(--ink-secondary);
    line-height: 1.6;
    flex: 1;
    min-width: 220px;
  }
  .upsell-banner strong {
    color: var(--ink);
    font-weight: 500;
  }
  .academic-table-wrap {
    background: #FFFFFF;
    color: #151C19;
    padding: 1.35rem;
    border: 1px solid var(--border);
    overflow-x: auto;
    font-family: "Times New Roman", STSong, "Songti SC", serif;
  }
  .academic-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
    color: #151C19;
  }
  .academic-table caption {
    font-weight: bold;
    text-align: left;
    margin-bottom: 8px;
    font-size: 14.5px;
  }
  .academic-table thead tr {
    border-top: 2px solid #151C19;
    border-bottom: 1px solid #151C19;
  }
  .academic-table tbody tr:last-child {
    border-bottom: 2px solid #151C19;
  }
  .academic-table th,
  .academic-table td {
    padding: 6px 10px;
    text-align: left;
  }
  .academic-table .indent-1 {
    padding-left: 26px;
  }
  .academic-table-foot {
    font-size: 12px;
    color: #525B56;
    margin-top: 8px;
    line-height: 1.5;
  }
  .geo-sec {
    background: var(--bg-primary);
    padding: 3.75rem 0;
  }
  .geo-capsule {
    max-width: 54rem;
  }
  .geo-capsule h2 {
    font-family: var(--serif);
    font-size: clamp(1.35rem, 2vw, 1.75rem);
    font-weight: 300;
    color: var(--ink);
    margin: 0 0 0.85rem;
  }
  .geo-capsule h3 {
    font-family: var(--mono);
    font-size: 0.75rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 1.35rem 0 0.5rem;
  }
  .geo-capsule p,
  .geo-capsule li {
    font-size: 0.9rem;
    color: var(--ink-secondary);
    line-height: 1.72;
  }
  .tool-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.65rem;
    font-family: var(--mono);
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    background: var(--accent-soft);
    border: 1px solid rgba(35, 62, 51, 0.25);
    color: var(--accent);
  }
  .cite-item {
    padding: 0.95rem 1.1rem;
    margin-bottom: 0.75rem;
    border: 1px solid var(--border);
    background: var(--bg-primary);
  }
  .cite-item.verified { border-left: 3px solid #233E33; }
  .cite-item.mismatch { border-left: 3px solid #8F5638; }
  .cite-item.unverifiable { border-left: 3px solid #B91C1C; }
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
  heroHtml: string
  bodyHtml: string
  geoHtml?: string
  scriptJs?: string
}): string {
  const { lang, title, description, keywords, canonicalPath, zhPath, enPath, jsonLd, heroHtml, bodyHtml, geoHtml, scriptJs } = opts
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
  <meta property="og:site_name" content="Heurion Research">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:locale" content="${isEn ? 'en_US' : 'zh_CN'}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;700&family=JetBrains+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;1,6..72,300;1,6..72,400&family=Noto+Serif+SC:wght@300;400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/site/site.css?v=nordic-v12">
  <style>${TOOL_EXTRA_CSS}</style>
</head>
<body>
  <header class="nav" role="banner">
    <div class="nav-inner">
      <a class="brand" href="${homeHref}" aria-label="Heurion Research">
        <svg class="brand-mark" viewBox="-2 6 96 88" aria-hidden="true">
          <rect class="mark-bar" x="0" y="10" width="18" height="80" rx="9"/>
          <rect class="mark-bar" x="62" y="30" width="18" height="60" rx="9"/>
          <rect class="mark-accent" x="14" y="42" width="52" height="18" rx="9"/>
          <circle class="mark-accent" cx="80" cy="20" r="11"/>
        </svg>
        <span class="brand-word">HEURION</span>
      </a>
      <nav class="nav-links" aria-label="Primary">
        <a href="${toolsHref}" class="nav-link">${isEn ? 'All Tools' : '工具总览'}</a>
        <a href="${isEn ? '/en/tools/e-value-calculator' : '/tools/e-value-calculator'}" class="nav-link">E-value</a>
        <a href="${isEn ? '/en/tools/consort-strobe-flowchart' : '/tools/consort-strobe-flowchart'}" class="nav-link">CONSORT / STROBE</a>
        <a href="${isEn ? '/en/tools/table-1-generator' : '/tools/table-1-generator'}" class="nav-link">Table 1 (.docx)</a>
        <a href="${isEn ? '/en/tools/pubmed-citation-checker' : '/tools/pubmed-citation-checker'}" class="nav-link">${isEn ? 'PubMed Audit' : 'PubMed 核验'}</a>
      </nav>
      <div class="nav-right">
        <a class="lang-btn" href="${switchHref}" aria-label="Switch Language">${switchLabel}</a>
      </div>
    </div>
  </header>

  <main>
    <section class="tool-hero">
      <div class="container">
        ${heroHtml}
      </div>
    </section>

    <section class="tool-body">
      <div class="container">
        ${bodyHtml}
      </div>
    </section>

    ${geoHtml ? `<section class="geo-sec"><div class="container">${geoHtml}</div></section>` : ''}
  </main>

  <footer class="foot" role="contentinfo">
    <div class="container">
      <div class="foot-bar">
        <a class="brand" href="${homeHref}" aria-label="Heurion Research">
          <svg class="brand-mark" viewBox="-2 6 96 88" aria-hidden="true">
            <rect class="mark-bar" x="0" y="10" width="18" height="80" rx="9"/>
            <rect class="mark-bar" x="62" y="30" width="18" height="60" rx="9"/>
            <rect class="mark-accent" x="14" y="42" width="52" height="18" rx="9"/>
            <circle class="mark-accent" cx="80" cy="20" r="11"/>
          </svg>
          <span class="brand-word">HEURION</span>
        </a>
        <div class="foot-right">
          <span>© 2026 Heurion Research · MIT Licensed</span>
          <a href="${homeHref}" class="foot-link">${isEn ? 'Home' : '首页'}</a>
          <a href="${toolsHref}" class="foot-link">${isEn ? 'Tools' : '临床工具'}</a>
          <a href="/phr" class="foot-link">${isEn ? 'Patient PHR' : '知家档案'}</a>
          <a href="/llms.txt" class="foot-link">LLMs.txt</a>
          <a href="/sitemap.xml" class="foot-link">Sitemap</a>
        </div>
      </div>
    </div>
  </footer>
${scriptJs ? `<script>\n${scriptJs}\n</script>` : ''}
</body>
</html>`
}

/**
 * 渲染 `/tools` 与 `/en/tools` 临床科研免登录工具箱导航页（Nordic Editorial 2×2 卡片）
 */
export function renderToolsHubHtml(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const prefix = isEn ? '/en/tools' : '/tools'
  const title = isEn
    ? 'Clinical Research & Biostatistics Utilities (Stateless, No Login) · Heurion Research'
    : '免登录临床统计与文献核验工具箱 · Heurion Research'
  const description = isEn
    ? 'Free, stateless clinical research utilities by Heurion Research: VanderWeele E-value calculator, CONSORT 2010 / STROBE flowchart generator, native Word (.docx) Table 1 baseline generator with SMD, and PubMed citation auditor.'
    : 'Heurion Research 免登录临床科研工具矩阵：VanderWeele E-value 敏感性分析计算器、CONSORT 2010 / STROBE 矢量纳排流程图、原生 Word (.docx) Table 1 基线三线表生成器与 PubMed 引用核验器。'

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

  const heroHtml = `
    <div class="tool-breadcrumb">
      <a href="${isEn ? '/en' : '/'}">Heurion Research</a> <span>/</span> <span>${isEn ? 'Clinical Utilities' : '临床工具矩阵'}</span>
    </div>
    <div class="tool-header">
      <p class="label-caps">${isEn ? 'STATELESS CLINICAL UTILITIES · ZERO LOGIN REQUIRED' : 'HEURION RESEARCH · 免登录临床科研工具矩阵'}</p>
      <h1>${
        isEn
          ? 'Stateless utilities for <em>clinical biostatistics</em> and <em>manuscript verification</em>.'
          : '免登录临床统计与<em>文献核验</em>工具箱。'
      }</h1>
      <p class="lead">${
        isEn
          ? 'Powered directly by Heurion 2.0’s biostatistical and PubMed grounding engines. Zero account registration, stateless execution, and publication-grade exports.'
          : '直接开放 Heurion 2.0 工作台的底层生物统计与 PubMed 溯源引擎。零注册、无状态不落盘，一键导出符合顶刊规范的三线表、矢量流程图与审稿回复。'
      }</p>
    </div>
  `

  const bodyHtml = `
    <div class="section-header">
      <h2 class="heading-2">${isEn ? 'Four standalone clinical research engines.' : '四套独立临床科研引擎。'}</h2>
      <p class="label-caps">${isEn ? '01 / UTILITIES INDEX' : '01 / 工具索引'}</p>
    </div>

    <div class="hub-grid">
      <!-- 01: E-value -->
      <article class="hub-card">
        <div class="flagship-top">
          <div class="flagship-meta">
            <div class="flagship-num-group">
              <span class="flagship-num">01</span>
              <span class="label-caps">${isEn ? 'CAUSAL INFERENCE · REBUTTAL' : '因果推断 · 混杂抗辩'}</span>
            </div>
            <svg class="flagship-emblem" viewBox="0 0 44 28" fill="none" aria-hidden="true">
              <path d="M6 6 Q 16 22 38 22" stroke="#233E33" stroke-width="1.2" fill="none"/>
              <line x1="6" y1="22" x2="38" y2="22" stroke="#848D88" stroke-width="1"/>
              <circle cx="19" cy="16" r="2.5" fill="#8F5638"/>
            </svg>
          </div>
          <h3 class="heading-2">VanderWeele E-value</h3>
          <p class="flagship-sub">${isEn ? 'Unmeasured Confounding & Rebuttal Generator' : '未测混杂敏感性分析与审稿回复生成'}</p>
          <p class="text-muted">${
            isEn
              ? 'Compute Point & CI E-values from HR, OR, or RR (VanderWeele & Ding 2017), plot bias threshold curves, and copy peer-review rebuttal paragraphs.'
              : '输入 HR / OR / RR 及 95% CI，实时计算点估计与置信界限 E-value、绘制偏倚阈值曲线并生成 SCI 审稿回复段落。'
          }</p>
        </div>
        <div>
          <div class="flagship-stats">
            <div class="stat-cell">
              <span class="stat-val">HR/OR</span>
              <span class="stat-lbl">${isEn ? 'Effect Scale' : '支持效应量'}</span>
            </div>
            <div class="stat-cell">
              <span class="stat-val">SVG</span>
              <span class="stat-lbl">${isEn ? 'Bias Curve' : '阈值矢量图'}</span>
            </div>
            <div class="stat-cell">
              <span class="stat-val">SCI</span>
              <span class="stat-lbl">${isEn ? 'Rebuttal Copy' : '审稿抗辩信'}</span>
            </div>
          </div>
          <div class="flagship-links">
            <a class="link-arrow" href="${prefix}/e-value-calculator">${isEn ? 'Open E-value Calculator →' : '打开 E-value 计算器 →'}</a>
          </div>
        </div>
      </article>

      <!-- 02: CONSORT / STROBE -->
      <article class="hub-card">
        <div class="flagship-top">
          <div class="flagship-meta">
            <div class="flagship-num-group">
              <span class="flagship-num">02</span>
              <span class="label-caps">${isEn ? 'FIGURE 1 · VECTOR FLOWCHART' : '论文图 1 · 纳排流程图'}</span>
            </div>
            <svg class="flagship-emblem" viewBox="0 0 44 28" fill="none" aria-hidden="true">
              <rect x="14" y="3" width="16" height="7" stroke="#233E33" stroke-width="1"/>
              <line x1="22" y1="10" x2="22" y2="16" stroke="#233E33" stroke-width="1"/>
              <rect x="5" y="16" width="14" height="8" stroke="#848D88" stroke-width="1"/>
              <rect x="25" y="16" width="14" height="8" stroke="#233E33" stroke-width="1"/>
            </svg>
          </div>
          <h3 class="heading-2">CONSORT 2010 &amp; STROBE</h3>
          <p class="flagship-sub">${isEn ? 'Participant Selection Flowchart Generator' : '受试者筛选入组矢量流程图生成器'}</p>
          <p class="text-muted">${
            isEn
              ? 'Enter screening totals, exclusion reasons, and study arms with automatic arithmetic checking and 1-click vector SVG & Mermaid export.'
              : '填入初筛人数、排除原因与分组随访人数，系统自动校验加减算术自洽并导出出版级 SVG 矢量图与 Mermaid 源码。'
          }</p>
        </div>
        <div>
          <div class="flagship-stats">
            <div class="stat-cell">
              <span class="stat-val">Auto</span>
              <span class="stat-lbl">${isEn ? 'Sum Check' : '算术校验'}</span>
            </div>
            <div class="stat-cell">
              <span class="stat-val">.SVG</span>
              <span class="stat-lbl">${isEn ? 'Vector Print' : '出版矢量'}</span>
            </div>
            <div class="stat-cell">
              <span class="stat-val">Mermaid</span>
              <span class="stat-lbl">${isEn ? 'Code Export' : '源码导出'}</span>
            </div>
          </div>
          <div class="flagship-links">
            <a class="link-arrow" href="${prefix}/consort-strobe-flowchart">${isEn ? 'Open Flowchart Generator →' : '打开流程图生成器 →'}</a>
          </div>
        </div>
      </article>

      <!-- 03: Table 1 -->
      <article class="hub-card">
        <div class="flagship-top">
          <div class="flagship-meta">
            <div class="flagship-num-group">
              <span class="flagship-num">03</span>
              <span class="label-caps">${isEn ? 'BIOSTATISTICS · NATIVE WORD' : '生物统计 · 原生三线表'}</span>
            </div>
            <svg class="flagship-emblem" viewBox="0 0 44 28" fill="none" aria-hidden="true">
              <line x1="6" y1="6" x2="38" y2="6" stroke="#151C19" stroke-width="1.5"/>
              <line x1="6" y1="11" x2="38" y2="11" stroke="#848D88" stroke-width="0.8"/>
              <line x1="6" y1="22" x2="38" y2="22" stroke="#151C19" stroke-width="1.5"/>
            </svg>
          </div>
          <h3 class="heading-2">Table 1 Generator (.docx)</h3>
          <p class="flagship-sub">${isEn ? 'Publication-Grade Baseline Three-Line Table' : '医学论文发表级基线特征三线表生成'}</p>
          <p class="text-muted">${
            isEn
              ? 'Paste CSV/Excel rows with local PHI privacy scanning, automatic parametric/non-parametric branching, SMD, and native 1.5pt/0.5pt Word export.'
              : '粘贴 CSV/Excel 队列数据，内置本地 PHI 隐私扫描，自动分流正态/偏态检验并计算 P 值与 SMD，直出原生 Word 文档。'
          }</p>
        </div>
        <div>
          <div class="flagship-stats">
            <div class="stat-cell">
              <span class="stat-val">.DOCX</span>
              <span class="stat-lbl">${isEn ? '1.5pt / 0.5pt' : '原生三线表'}</span>
            </div>
            <div class="stat-cell">
              <span class="stat-val">P + SMD</span>
              <span class="stat-lbl">${isEn ? 'Balance Test' : '组间均衡'}</span>
            </div>
            <div class="stat-cell">
              <span class="stat-val">PHI</span>
              <span class="stat-lbl">${isEn ? 'Local Scan' : '隐私扫描'}</span>
            </div>
          </div>
          <div class="flagship-links">
            <a class="link-arrow" href="${prefix}/table-1-generator">${isEn ? 'Open Table 1 Generator →' : '打开三线表生成器 →'}</a>
          </div>
        </div>
      </article>

      <!-- 04: PubMed Citation Audit -->
      <article class="hub-card">
        <div class="flagship-top">
          <div class="flagship-meta">
            <div class="flagship-num-group">
              <span class="flagship-num">04</span>
              <span class="label-caps">${isEn ? 'GROUNDING · ANTI-HALLUCINATION' : '文献溯源 · 防幻觉核验'}</span>
            </div>
            <svg class="flagship-emblem" viewBox="0 0 44 28" fill="none" aria-hidden="true">
              <circle cx="18" cy="14" r="8" stroke="#233E33" stroke-width="1"/>
              <line x1="24" y1="20" x2="34" y2="25" stroke="#233E33" stroke-width="1.2"/>
              <circle cx="18" cy="14" r="2.5" fill="#00C472"/>
            </svg>
          </div>
          <h3 class="heading-2">PubMed Citation Audit</h3>
          <p class="flagship-sub">${isEn ? 'Reference & Effect Size (HR/OR/95% CI) Checker' : '参考文献真伪与统计效应量核验器'}</p>
          <p class="text-muted">${
            isEn
              ? 'Cross-verify manuscript PMIDs and DOIs against NCBI PubMed and Crossref, checking whether inline HR/OR claims match the authentic abstract.'
              : '粘贴含引用的论文草稿，实时对照 NCBI PubMed 与 Crossref 核查 PMID/DOI 真伪，并比对文内 HR/OR 数值与原文摘要。'
          }</p>
        </div>
        <div>
          <div class="flagship-stats">
            <div class="stat-cell">
              <span class="stat-val">PubMed</span>
              <span class="stat-lbl">${isEn ? 'Live Entrez' : '实时核查'}</span>
            </div>
            <div class="stat-cell">
              <span class="stat-val">HR / CI</span>
              <span class="stat-lbl">${isEn ? 'Claim Audit' : '效应量比对'}</span>
            </div>
            <div class="stat-cell">
              <span class="stat-val">0%</span>
              <span class="stat-lbl">${isEn ? 'Fake PMIDs' : '假文献容忍'}</span>
            </div>
          </div>
          <div class="flagship-links">
            <a class="link-arrow" href="${prefix}/pubmed-citation-checker">${isEn ? 'Open Citation Auditor →' : '打开文献核验器 →'}</a>
          </div>
        </div>
      </article>
    </div>
  `

  const geoHtml = `
    <div class="geo-capsule">
      <p class="label-caps" style="margin-bottom:0.6rem;">${isEn ? '02 / ARCHITECTURE NOTE' : '02 / 架构说明'}</p>
      <h2>${isEn ? 'From standalone utilities to the full contract-guarded workstation.' : '从单点免登录工具，无缝接入受契约守卫的完整工作台。'}</h2>
      <p>${
        isEn
          ? 'Each utility above exposes an isolated module from Heurion 2.0. When your study requires multi-patient de-identification, MONAI 3D medical imaging quantification, survival analysis, and collaborative Word/PPTX authoring on a single Yjs CRDT canvas, open the full Heurion Workstation.'
          : '上方四款工具直接复用了 Heurion 2.0 的底层计算与核验模块。当课题进入多中心受试者脱敏纳排、MONAI 3D 影像量化、生存分析与多人协同论文撰写阶段时，可一键无缝转入 Heurion 2.0 完整工作台。'
      }</p>
    </div>
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
    heroHtml,
    bodyHtml,
    geoHtml,
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
    ? 'VanderWeele E-value Calculator & Peer-Review Rebuttal Generator · Heurion Research'
    : 'VanderWeele E-value 敏感性分析计算器 & SCI 审稿回复生成器 · Heurion Research'
  const description = isEn
    ? 'Calculate VanderWeele & Ding (2017) E-values for Hazard Ratio (HR), Odds Ratio (OR), and Relative Risk (RR) with 95% CI. Plot bias threshold curves and copy ready-to-use SCI manuscript & reviewer rebuttal text.'
    : '免费免登录在线计算观察性临床研究 VanderWeele E-value（支持 HR、OR、RR 及 95% 置信区间），自动绘制未测量混杂偏倚阈值曲线，并一键生成中英文 SCI 论文表述与审稿回复模板。'

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
                : '当观测到的相对危险度 RR > 1 时，计算公式为 E-value = RR + sqrt(RR × (RR - 1))；若效应量 < 1（保护效应，如 HR = 0.74），先取倒数 RR* = 1 / 0.74 = 1.351，再代入公式得 E-value = 2.04。',
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
                : '倾向评分匹配（PSM）仅能平衡已测量的基线协变量，无法消除未测量混杂。在审稿回复信中报告点估计与 95% 置信区间界限 E-value，能够定量证明未测量混杂因素需同时与暴露和结局达到多少倍的关联强度才能推翻现有结论。',
            },
          },
        ],
      },
    ],
  }

  const heroHtml = `
    <div class="tool-breadcrumb">
      <a href="${isEn ? '/en' : '/'}">Heurion Research</a> <span>/</span>
      <a href="${isEn ? '/en/tools' : '/tools'}">${isEn ? 'Clinical Utilities' : '临床工具矩阵'}</a> <span>/</span>
      <span>${isEn ? 'E-value Calculator' : 'E-value 计算器'}</span>
    </div>
    <div class="tool-header">
      <p class="label-caps">CAUSAL INFERENCE · VANDERWEELE &amp; DING (ANN INTERN MED 2017)</p>
      <h1>${isEn ? 'VanderWeele E-value Calculator &amp; <em>Rebuttal</em> Generator.' : 'VanderWeele E-value 敏感性分析与<em>审稿回复</em>生成器。'}</h1>
      <p class="lead">${
        isEn
          ? 'Quantify the minimum strength of association an unmeasured confounder must have with both treatment and outcome to explain away an observed cohort effect.'
          : '定量评估观察性队列研究对“未测量混杂偏倚（Unmeasured Confounding）”的抗干扰阈值，秒级生成偏倚曲线与 SCI 审稿回复段落。'
      }</p>
    </div>
  `

  const bodyHtml = `
    <div class="tool-grid">
      <div class="tool-card">
        <h2>${isEn ? '01 / Input Effect Estimate & 95% CI' : '01 / 输入效应量与 95% 置信区间'}</h2>
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
            <option value="OR_RARE">${isEn ? 'OR — Odds Ratio (Rare outcome < 15%)' : 'OR — Odds Ratio (结局发生率 < 15% 罕见结局比值比)'}</option>
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
          <button type="button" class="btn-run" id="evCalcBtn">${isEn ? 'Calculate E-value →' : '计算 E-value 并生成表述 →'}</button>
        </div>
      </div>

      <div class="tool-card">
        <h2>${isEn ? '02 / E-value Results & Bias Curve' : '02 / 计算结果与偏倚阈值曲线'}</h2>
        <div class="kpi-row">
          <div class="kpi-box">
            <div class="kpi-label">${isEn ? 'E-value (Point Estimate)' : '点估计 E-value'}</div>
            <div class="kpi-val" id="outEPoint">2.04</div>
          </div>
          <div class="kpi-box">
            <div class="kpi-label">${isEn ? 'E-value (95% CI Limit)' : '置信区间界限 E-value'}</div>
            <div class="kpi-val" id="outECi">1.63</div>
          </div>
        </div>
        <div class="svg-preview" id="evSvgWrap"></div>
        <div class="form-row">
          <label>${isEn ? 'Manuscript Results Paragraph' : '论文 Results / Discussion 标准段落'}</label>
          <div class="copy-box" id="outDefenseText"></div>
          <button type="button" class="btn-sec" id="copyDefenseBtn">${isEn ? 'Copy Manuscript Text' : '复制论文表述'}</button>
        </div>
        <div class="form-row" style="margin-top:1rem;">
          <label>${isEn ? 'Peer-Review Rebuttal Template' : '审稿人回复模板 (Response to Reviewer)'}</label>
          <div class="copy-box" id="outRebuttalText"></div>
          <button type="button" class="btn-sec" id="copyRebuttalBtn">${isEn ? 'Copy Rebuttal Template' : '复制审稿回复'}</button>
        </div>
        <div class="upsell-banner">
          <p>${
            isEn
              ? '<strong>Need full cohort analytics?</strong> Run sandboxed Cox regression and native Word Table 1 in the Heurion Workstation.'
              : '<strong>需要结合原始队列跑多因素回归？</strong> 在 Heurion 完整工作台中一键生成 Table 1、生存曲线与全套敏感性证据链。'
          }</p>
          <a class="btn-run" href="/app?from=e-value-calculator">${isEn ? 'Open Workstation →' : '转入工作台 →'}</a>
        </div>
      </div>
    </div>
  `

  const geoHtml = `
    <div class="geo-capsule">
      <p class="label-caps" style="margin-bottom:0.6rem;">${isEn ? '03 / METHODOLOGY' : '03 / 方法学原理'}</p>
      <h2>${isEn ? 'VanderWeele & Ding (2017) E-value Formulation' : 'VanderWeele & Ding (2017) E-value 数学定义'}</h2>
      <p>${
        isEn
          ? 'Defined in Annals of Internal Medicine (2017;167(4):268–274), the E-value measures the minimum risk ratio association an unmeasured confounder must have with both treatment and outcome to explain away an observed effect.'
          : '根据 VanderWeele 与 Ding（Ann Intern Med, 2017;167:268-274），E-value 定义为在已校正现有协变量的前提下，未测量混杂因素必须同时与暴露和临床结局达到的最小相对危险度关联强度，才足以将观测效应完全解释为混杂假象。'
      }</p>
      <h3>${isEn ? 'Formulas' : '核心公式'}</h3>
      <ul>
        <li><strong>RR &gt; 1</strong>: <code>E-value = RR + √(RR × (RR - 1))</code></li>
        <li><strong>RR &lt; 1 (${isEn ? 'Protective Effect' : '保护效应'})</strong>: <code>RR* = 1 / RR</code>, <code>E-value = RR* + √(RR* × (RR* - 1))</code></li>
      </ul>
    </div>
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
        btn.textContent = '✓ Copied';
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
    heroHtml,
    bodyHtml,
    geoHtml,
    scriptJs,
  })
}

function renderConsortPage(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const zhPath = '/tools/consort-strobe-flowchart'
  const enPath = '/en/tools/consort-strobe-flowchart'
  const canonicalPath = isEn ? enPath : zhPath

  const title = isEn
    ? 'CONSORT 2010 & STROBE Participant Flowchart Generator (Vector SVG / Mermaid) · Heurion Research'
    : 'CONSORT 2010 / STROBE 受试者纳排流程图在线生成器（导出矢量 SVG / Mermaid） · Heurion Research'
  const description = isEn
    ? 'Generate publication-grade CONSORT 2010 (RCT) and STROBE (observational cohort) participant flow diagrams online. Automatic exclusion arithmetic checking, vector SVG download, and Mermaid code export.'
    : '免登录在线生成符合 NEJM / JAMA / Lancet 投稿规范的 CONSORT 2010 与 STROBE 受试者筛选入组流向图（Figure 1）。自动校验排除人数加减算术，一键下载 SVG 矢量图与 Mermaid 源码。'

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

  const heroHtml = `
    <div class="tool-breadcrumb">
      <a href="${isEn ? '/en' : '/'}">Heurion Research</a> <span>/</span>
      <a href="${isEn ? '/en/tools' : '/tools'}">${isEn ? 'Clinical Utilities' : '临床工具矩阵'}</a> <span>/</span>
      <span>CONSORT / STROBE</span>
    </div>
    <div class="tool-header">
      <p class="label-caps">PUBLICATION FIGURE 1 · CONSORT 2010 &amp; STROBE COMPLIANT</p>
      <h1>${isEn ? 'CONSORT 2010 &amp; STROBE <em>Flowchart</em> Generator.' : 'CONSORT 2010 / STROBE <em>纳排流程图</em>生成器。'}</h1>
      <p class="lead">${
        isEn
          ? 'Enter your screening total, exclusion reasons, and study arms—our engine automatically validates arithmetic consistency and renders a publication-grade vector SVG flowchart.'
          : '填入初筛总人数、排除原因明细与分组随访人数，系统自动完成加减算术一致性校验并实时渲染出版级 SVG 矢量流向图。'
      }</p>
    </div>
  `

  const bodyHtml = `
    <div class="tool-grid">
      <div class="tool-card">
        <h2>${isEn ? '01 / Screening & Allocation Counts' : '01 / 初筛、排除原因与分组人数'}</h2>
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
            <label for="csEligible">${isEn ? 'Eligible / Enrolled (Auto)' : '合格入组人数 (自动核算)'}</label>
            <input id="csEligible" type="number" min="0" value="1420" readonly style="opacity:0.8;">
          </div>
        </div>
        <div class="form-row">
          <label for="csExclusions">${isEn ? 'Exclusion Reasons (One per line: Reason | Count)' : '排除原因与人数明细（每行一条：排除原因 | 人数）'}</label>
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
          <button type="button" class="btn-run" id="csRenderBtn">${isEn ? 'Render Vector Flowchart →' : '更新矢量流程图 →'}</button>
        </div>
      </div>

      <div class="tool-card">
        <h2>
          <span>${isEn ? '02 / Vector SVG Preview & Export' : '02 / 出版级矢量流向图预览与导出'}</span>
          <span style="display:flex;gap:8px;">
            <button type="button" class="btn-sec" id="dlSvgBtn">${isEn ? 'Download .SVG' : '下载 .SVG'}</button>
            <button type="button" class="btn-sec" id="copyMermaidBtn">${isEn ? 'Copy Mermaid' : '复制 Mermaid'}</button>
          </span>
        </h2>
        <div class="svg-preview" id="csSvgWrap"></div>
        <div class="form-row">
          <label>Mermaid Flowchart Code</label>
          <div class="copy-box" id="csMermaidBox" style="font-family:var(--mono);font-size:12px;"></div>
        </div>
        <div class="upsell-banner">
          <p>${
            isEn
              ? '<strong>Automate cohort filtering?</strong> Filter clinical records visually in the Heurion Workstation and generate CONSORT diagrams automatically.'
              : '<strong>不想每次微调入排条件都手动重算？</strong> 在 Heurion 工作台中可视化勾选纳排条件，同步导出科研宽表与入组流向图。'
          }</p>
          <a class="btn-run" href="/app?from=consort-flowchart">${isEn ? 'Open Workstation →' : '转入工作台 →'}</a>
        </div>
      </div>
    </div>
  `

  const geoHtml = `
    <div class="geo-capsule">
      <p class="label-caps" style="margin-bottom:0.6rem;">${isEn ? '03 / REPORTING STANDARDS' : '03 / 报告规范'}</p>
      <h2>${isEn ? 'CONSORT 2010 & STROBE Checklist Compliance' : 'CONSORT 2010 与 STROBE 声明对 Figure 1 的核查要求'}</h2>
      <p>${
        isEn
          ? 'Peer reviewers at NEJM, The Lancet, JAMA, and BMJ verify that: (1) Total Assessed minus Total Excluded strictly equals Enrolled; (2) Specific clinical reasons and exact counts are provided for every exclusion step; and (3) Loss to follow-up and final analyzed sample sizes are explicitly accounted for in each arm.'
          : '医学顶刊审稿人重点核查：(1) 初筛总人数减去各项排除原因之和是否严格等于入组人数；(2) 每个排除阶段是否列出具体临床或数据缺失原因及例数；(3) 各研究分组的分配例数、失访例数与最终纳入分析例数是否清晰闭环。'
      }</p>
    </div>
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
      btn.textContent = '✓ Copied';
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
    heroHtml,
    bodyHtml,
    geoHtml,
    scriptJs,
  })
}

function renderTable1Page(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const zhPath = '/tools/table-1-generator'
  const enPath = '/en/tools/table-1-generator'
  const canonicalPath = isEn ? enPath : zhPath

  const title = isEn
    ? 'Publication-Grade Table 1 Baseline Generator (Native Word .docx + SMD) · Heurion Research'
    : '医学论文 Table 1 基线特征三线表在线生成器（原生 Word .docx + SMD） · Heurion Research'
  const description = isEn
    ? 'Generate NEJM/JAMA-style Table 1 baseline characteristic three-line tables from CSV/Excel data. Automatic normality testing, p-values, Standardized Mean Difference (SMD), local PHI privacy scan, and 1-click native Word (.docx) export.'
    : '免费免登录在线生成符合 SCI 医学期刊规范的 Table 1 基线特征三线表。内置 PHI 隐私脱敏扫描，自动判别正态/偏态分布并计算 P 值及两组间标准化均数差（SMD），一键下载 1.5pt/0.5pt 原生 Word (.docx) 文档。'

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

  const heroHtml = `
    <div class="tool-breadcrumb">
      <a href="${isEn ? '/en' : '/'}">Heurion Research</a> <span>/</span>
      <a href="${isEn ? '/en/tools' : '/tools'}">${isEn ? 'Clinical Utilities' : '临床工具矩阵'}</a> <span>/</span>
      <span>Table 1 (.docx)</span>
    </div>
    <div class="tool-header">
      <p class="label-caps">BIOSTATISTICS · NATIVE WORD (.DOCX) THREE-LINE TABLE ENGINE</p>
      <h1>${isEn ? 'Publication-Grade <em>Table 1</em> Baseline Generator.' : '医学论文发表级 <em>Table 1</em> 基线三线表生成器。'}</h1>
      <p class="lead">${
        isEn
          ? 'Paste de-identified cohort CSV/TSV rows below. Automatically branches parametric (Mean ± SD) vs. non-parametric (Median [IQR]) tests, computes P-values and SMD, and exports a native 1.5pt/0.5pt Word (.docx) document.'
          : '粘贴 CSV 或 Excel 队列数据，内置本地 PHI 隐私扫描，自动分流正态（Mean ± SD）与偏态（Median [IQR]）检验并计算 P 值与 SMD，直出 1.5pt/0.5pt 原生 Word (.docx) 三线表。'
      }</p>
    </div>
  `

  const bodyHtml = `
    <div class="tool-grid">
      <div class="tool-card">
        <h2>${isEn ? '01 / Cohort CSV / Excel Data (≤500 Rows)' : '01 / 粘贴 CSV / Excel 队列数据（≤500 行）'}</h2>
        <div id="phiBadge" style="margin-bottom:1rem;padding:0.55rem 0.85rem;font-family:var(--mono);font-size:0.72rem;background:#E3ECE7;border:1px solid rgba(35,62,51,0.3);color:#233E33;">
          ✓ ${isEn ? 'PHI Privacy Guard Active: Scanning for unmasked names, IDs, phones, and MRNs' : '本地 PHI 隐私守卫已就绪：自动扫描姓名、身份证号、手机号与病案号'}
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
          <button type="button" class="btn-run" id="t1RunBtn">${isEn ? 'Generate Table 1 →' : '生成 Table 1 三线表 →'}</button>
          <button type="button" class="btn-sec" id="t1DocxBtn">${isEn ? 'Download Native .DOCX' : '下载原生 Word (.docx)'}</button>
        </div>
      </div>

      <div class="tool-card">
        <h2>
          <span>${isEn ? '02 / Three-Line Table Preview' : '02 / 学术三线表实时预览'}</span>
          <button type="button" class="btn-sec" id="t1CopyMdBtn">${isEn ? 'Copy Markdown' : '复制 Markdown'}</button>
        </h2>
        <div class="academic-table-wrap" id="t1PreviewWrap"></div>
        <div class="upsell-banner">
          <p>${
            isEn
              ? '<strong>Analyzing &gt;500 patients or need Kaplan-Meier &amp; Cox regression?</strong> Import your full dataset into the Heurion Workstation.'
              : '<strong>样本量超过 500 例或需继续做生存曲线与多因素 Cox 回归？</strong> 一键转入 Heurion 完整工作台。'
          }</p>
          <a class="btn-run" href="/app?from=table-1-generator">${isEn ? 'Open Workstation →' : '转入工作台 →'}</a>
        </div>
      </div>
    </div>
  `

  const geoHtml = `
    <div class="geo-capsule">
      <p class="label-caps" style="margin-bottom:0.6rem;">${isEn ? '03 / BIOSTATISTICAL CONVENTIONS' : '03 / 生物统计与排版规范'}</p>
      <h2>${isEn ? 'Academic Standards for Baseline Table 1' : '医学顶刊对 Table 1 基线特征三线表的统计规范'}</h2>
      <p>${
        isEn
          ? 'Normally distributed continuous variables are reported as Mean ± SD (Welch’s t-test / ANOVA); skewed biomarkers as Median [IQR] (Mann-Whitney U / Kruskal-Wallis); categorical variables as n (%) (Chi-square / Fisher’s exact test); and baseline covariate balance via Standardized Mean Difference (|SMD| < 0.10, Austin 2009).'
          : '正态分布连续变量呈报 Mean ± SD（Welch t 检验 / 方差分析）；非正态偏态指标呈报 Median [IQR]（Mann-Whitney U 秩和检验）；分类变量呈报 n (%)（卡方或 Fisher 精确检验）；并同步计算两组间标准化均数差（|SMD| < 0.10 提示组间基线均衡，Austin 2009）。'
      }</p>
    </div>
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
        previewWrap.innerHTML = '<p style="color:#B91C1C;">' + (data.error || 'Error') + '</p>';
        return;
      }
      const isEnMode = ${isEn ? 'true' : 'false'};
      if (data.phi_clean) {
        phiBadge.style.background = '#E3ECE7';
        phiBadge.style.borderColor = 'rgba(35,62,51,0.3)';
        phiBadge.style.color = '#233E33';
        phiBadge.textContent = isEnMode
          ? ('✓ PHI Privacy Check Passed: No unmasked names, IDs, phones, or MRNs detected (' + data.row_count + ' rows)')
          : ('✓ PHI 隐私安全扫描通过：未检出未脱敏姓名、身份证号、手机号或病案号 (' + data.row_count + ' rows)');
      } else {
        phiBadge.style.background = '#FEF2F2';
        phiBadge.style.borderColor = 'rgba(185,28,28,0.35)';
        phiBadge.style.color = '#991B1B';
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
      btn.textContent = '✓ Copied';
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
    heroHtml,
    bodyHtml,
    geoHtml,
    scriptJs,
  })
}

function renderCitationCheckerPage(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const zhPath = '/tools/pubmed-citation-checker'
  const enPath = '/en/tools/pubmed-citation-checker'
  const canonicalPath = isEn ? enPath : zhPath

  const title = isEn
    ? 'PubMed Citation & Effect Size (HR/OR/95% CI) Auditor · Heurion Research'
    : '医学论文 PubMed 引用真伪与效应量（HR/OR/95% CI）核验工具 · Heurion Research'
  const description = isEn
    ? 'Verify medical manuscript references against NCBI PubMed and Crossref. Detect AI-hallucinated PMIDs/DOIs and check whether inline Hazard Ratios (HR), Odds Ratios (OR), and 95% CIs match the original PubMed abstract.'
    : '免费免登录核验医学论文参考文献真伪：实时对接 NCBI PubMed 与 Crossref 数据库，秒级揪出假 PMID / 假 DOI，并自动核对正文中引用的 HR / OR / 95% CI 数值是否与 PubMed 原文摘要一致。'

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

  const heroHtml = `
    <div class="tool-breadcrumb">
      <a href="${isEn ? '/en' : '/'}">Heurion Research</a> <span>/</span>
      <a href="${isEn ? '/en/tools' : '/tools'}">${isEn ? 'Clinical Utilities' : '临床工具矩阵'}</a> <span>/</span>
      <span>${isEn ? 'PubMed Citation Audit' : 'PubMed 引用核验'}</span>
    </div>
    <div class="tool-header">
      <p class="label-caps">ANTI-HALLUCINATION GROUNDING · NCBI PUBMED &amp; CROSSREF</p>
      <h1>${isEn ? 'PubMed Citation &amp; <em>Effect Size</em> Auditor.' : 'PubMed 文献真伪与<em>统计效应量</em>核验器。'}</h1>
      <p class="lead">${
        isEn
          ? 'Cross-check manuscript PMIDs/DOIs and inline Hazard Ratios (HR), Odds Ratios (OR), and 95% CIs against authentic NCBI PubMed XML abstracts.'
          : '粘贴含引用的论文草稿与参考文献，实时对照 NCBI PubMed 与 Crossref 核查 PMID/DOI 真伪，并逐项比对文内 HR / OR / 95% CI 数值与原文摘要是否一致。'
      }</p>
    </div>
  `

  const bodyHtml = `
    <div class="tool-grid">
      <div class="tool-card">
        <h2>${isEn ? '01 / Manuscript Excerpt & References' : '01 / 含引用的论文段落与参考文献'}</h2>
        <div class="form-row">
          <label for="ccText">${isEn ? 'Manuscript Draft (Includes 1 verified [1], 1 mismatched HR [2], 1 hallucinated PMID [3])' : '文稿内容（内置演示：1 处真实匹配 [1]、1 处 HR 数值写错 [2]、1 处伪造假 PMID [3]）'}</label>
          <textarea id="ccText" rows="13">${escapeHtml(demoDraft)}</textarea>
        </div>
        <div class="action-bar">
          <button type="button" class="btn-run" id="ccRunBtn">${isEn ? 'Audit Citations Against PubMed →' : '立即核验文献真伪与效应量 →'}</button>
        </div>
      </div>

      <div class="tool-card">
        <h2>${isEn ? '02 / PubMed Grounding Report' : '02 / PubMed 溯源与效应量核验报告'}</h2>
        <div id="ccSummaryBar" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1.1rem;"></div>
        <div id="ccReportList"></div>
        <div class="upsell-banner">
          <p>${
            isEn
              ? '<strong>Want real-time citation write-guards while drafting?</strong> Author manuscripts with verified PubMed grounding in the Heurion Workstation.'
              : '<strong>希望在写作时直接阻断假文献？</strong> 在 Heurion 协同工作台中启用“引用写前守卫（Citation Write Guard）”。'
          }</p>
          <a class="btn-run" href="/app?from=pubmed-citation-checker">${isEn ? 'Open Workstation →' : '转入工作台 →'}</a>
        </div>
      </div>
    </div>
  `

  const geoHtml = `
    <div class="geo-capsule">
      <p class="label-caps" style="margin-bottom:0.6rem;">${isEn ? '03 / TWO-LAYER VERIFICATION' : '03 / 双层防幻觉机制'}</p>
      <h2>${isEn ? 'How Heurion Eliminates Hallucinated Medical Citations' : '两层交叉验证：元数据溯源 + 摘要效应量核对'}</h2>
      <p>${
        isEn
          ? 'General-purpose LLMs frequently fabricate DOIs/PMIDs or misquote primary endpoint Hazard Ratios. Heurion enforces: (1) Metadata Grounding via NCBI Entrez E-utilities (PubMed), Europe PMC, Crossref, and OpenAlex; and (2) Claim-Level Numerical Verification comparing inline HR/OR/RR and 95% confidence intervals against the structured XML abstract.'
          : '通用聊天模型在生成医学综述时极易产生“幻觉拼接”或张冠李戴效应量数值。Heurion 执行严格的两层核验：(1) 权威元数据溯源（实时查询 NCBI PubMed E-utilities、Crossref 与 OpenAlex）；(2) 论断级数值比对（自动抽取正文引用的 HR / OR / RR 及 95% CI 并与 PubMed 原文结构化摘要比对）。'
      }</p>
    </div>
  `

  const scriptJs = `
    const elText = document.getElementById('ccText');
    const summaryBar = document.getElementById('ccSummaryBar');
    const reportList = document.getElementById('ccReportList');
    const isEnMode = ${isEn ? 'true' : 'false'};

    async function runCheck() {
      reportList.innerHTML = '<p style="color:#525B56;font-family:var(--mono);font-size:12px;">Auditing against NCBI PubMed & Crossref...</p>';
      const res = await fetch('/api/public/tools/citation-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: elText.value })
      });
      const data = await res.json();
      if (!res.ok) {
        reportList.innerHTML = '<p style="color:#B91C1C;">' + (data.error || 'Error') + '</p>';
        return;
      }
      const s = data.summary || { total: 0, verified: 0, mismatch: 0, unverifiable: 0 };
      summaryBar.innerHTML = isEnMode
        ? ('<span class="tool-badge" style="color:#233E33;border-color:rgba(35,62,51,0.35);background:#E3ECE7;">● Verified: ' + s.verified + '</span>' +
           '<span class="tool-badge" style="color:#8F5638;border-color:rgba(143,86,56,0.35);background:#F9F1EC;">● Effect Size Mismatch: ' + s.mismatch + '</span>' +
           '<span class="tool-badge" style="color:#991B1B;border-color:rgba(185,28,28,0.35);background:#FEF2F2;">● Unverifiable / Fake: ' + s.unverifiable + '</span>')
        : ('<span class="tool-badge" style="color:#233E33;border-color:rgba(35,62,51,0.35);background:#E3ECE7;">● 已核验通过: ' + s.verified + '</span>' +
           '<span class="tool-badge" style="color:#8F5638;border-color:rgba(143,86,56,0.35);background:#F9F1EC;">● 效应量数值偏差: ' + s.mismatch + '</span>' +
           '<span class="tool-badge" style="color:#991B1B;border-color:rgba(185,28,28,0.35);background:#FEF2F2;">● 疑似伪造/查无此文: ' + s.unverifiable + '</span>');

      const items = data.items || [];
      if (items.length === 0) {
        reportList.innerHTML = '<p style="color:#525B56;">' + (isEnMode
          ? 'No PMID (e.g., PMID: 31535829) or DOI (e.g., 10.1056/...) identifiers detected in the text.'
          : '未在文本中识别到 PMID (如 PMID: 31535829) 或 DOI (如 10.1056/...) 标识符。') + '</p>';
        return;
      }
      reportList.innerHTML = items.map(it => {
        const badgeColor = it.status === 'verified' ? '#233E33' : it.status === 'mismatch' ? '#8F5638' : '#991B1B';
        const titleHtml = it.title
          ? '<div style="font-weight:500;color:#151C19;margin:4px 0;font-family:var(--serif);font-size:1.02rem;">' + it.title + ' <span style="color:#233E33;font-family:var(--mono);font-size:0.75rem;">(' + (it.journal || '') + ' ' + (it.year || '') + ')</span></div>'
          : '<div style="font-weight:500;color:#991B1B;margin:4px 0;">' + (isEnMode ? 'No matching authentic record found in PubMed/Crossref' : '未找到匹配的真实文献记录') + '</div>';
        const msg = isEnMode ? it.message_en : it.message_zh;
        return '<div class="cite-item ' + it.status + '">' +
          '<div style="font-size:11.5px;color:' + badgeColor + ';font-family:var(--mono);letter-spacing:0.04em;">● ' + it.raw_identifier + '</div>' +
          titleHtml +
          '<div style="font-size:13px;color:#525B56;line-height:1.6;margin-top:6px;">' + msg + '</div>' +
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
    heroHtml,
    bodyHtml,
    geoHtml,
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
