import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Hono } from 'hono'
import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  classifyTrafficActor,
  recordPublicTrafficHit,
  registerPublicToolsApi,
} from '../src/http/routes/public-tools-api.ts'
import {
  TOOL_SLUGS,
  renderEnglishIndexHtml,
  renderToolPageHtml,
  renderToolsHubHtml,
} from '../src/http/routes/site-pages.ts'

const SITE_DIR = fileURLToPath(new URL('../../site/', import.meta.url))

describe('SEO & AI Search (GEO) Static Assets & /en SSR', () => {
  it('transforms apps/site/index.html into native English HTML for /en crawlers without JS', () => {
    const zhHtml = readFileSync(join(SITE_DIR, 'index.html'), 'utf8')
    const enHtml = renderEnglishIndexHtml(zhHtml)

    expect(enHtml).toContain('<html lang="en">')
    expect(enHtml).toContain('<link rel="canonical" href="https://heurion.org/en">')
    expect(enHtml).toContain('<title data-i18n="doc_title">Heurion Research · Contract-Guarded Clinical AI Workstation & Aegis OS Agent Runtime</title>')
    expect(enHtml).toContain('Contract-Guarded Clinical Research Intelligence')
    expect(enHtml).toContain('Heurion 2.0 & OmniCanvas · Clinical Research AI Workstation')
    expect(enHtml).toContain('Aegis OS (aegis-os) · Transactional Multi-Tenant Agent OS Runtime')
    expect(enHtml).toContain('What is Heurion, and how does it differ fundamentally from generic LLMs like ChatGPT or Claude?')
    expect(enHtml).toContain('What is Aegis OS, and how does it work together with the Heurion 2.0 Clinical Workstation?')
    expect(enHtml).toContain('href="/en/tools"')
    expect(enHtml).toContain('href="/en/tools/table-1-generator"')
    expect(enHtml).toContain('href="/en/tools/kaplan-meier-survival"')
    expect(enHtml).toContain('href="/en/tools/forest-plot-generator"')
    expect(enHtml).toContain('property="og:image"')
    expect(enHtml).toContain('name="twitter:image"')
  })

  it('eliminates external Mainland-China-blocking Unsplash background URLs and includes og:image cards', () => {
    const css = readFileSync(join(SITE_DIR, 'site.css'), 'utf8')
    expect(css).not.toContain('images.unsplash.com')
    expect(css).toContain('/site/nordic-bg.jpg')

    for (const rel of [
      'index.html',
      'aegis-os/index.html',
      'en/aegis-os/index.html',
      'aegis-os/tutorial/index.html',
      'en/aegis-os/tutorial/index.html',
    ]) {
      const html = readFileSync(join(SITE_DIR, rel), 'utf8')
      expect(html).not.toContain('images.unsplash.com')
      expect(html).toContain('property="og:image"')
      expect(html).toContain('name="twitter:image"')
    }
  })

  it('validates robots.txt, llms.txt, and sitemap.xml for AI crawlers and all 7 Programmatic SEO tools', () => {
    expect(TOOL_SLUGS.length).toBe(7)
    const robots = readFileSync(join(SITE_DIR, 'robots.txt'), 'utf8')
    expect(robots).toContain('Sitemap: https://heurion.org/sitemap.xml')
    expect(robots).not.toContain('Sitemap: https://heurion.org/llms.txt')
    expect(robots).toContain('User-agent: OAI-SearchBot')

    const llms = readFileSync(join(SITE_DIR, 'llms.txt'), 'utf8')
    expect(llms).toContain('临床研究工作流')
    expect(llms).toContain('研究者发起的临床研究（IIT')
    for (const slug of TOOL_SLUGS) {
      expect(llms).toContain(`https://heurion.org/tools/${slug}`)
      expect(llms).toContain(`https://heurion.org/en/tools/${slug}`)
    }

    const sitemap = readFileSync(join(SITE_DIR, 'sitemap.xml'), 'utf8')
    for (const slug of TOOL_SLUGS) {
      expect(sitemap).toContain(`https://heurion.org/tools/${slug}`)
      expect(sitemap).toContain(`https://heurion.org/en/tools/${slug}`)
    }
  })

  it('renders bilingual Tools Hub (/tools and /en/tools) and all 7 standalone mini-tool pages', () => {
    const zhHub = renderToolsHubHtml('zh')
    const enHub = renderToolsHubHtml('en')
    expect(zhHub).toContain('<link rel="canonical" href="https://heurion.org/tools">')
    expect(enHub).toContain('<link rel="canonical" href="https://heurion.org/en/tools">')
    expect(zhHub).toContain('property="og:image"')
    expect(enHub).not.toContain('images.unsplash.com')
    const enHubMain = enHub.match(/<main[\s\S]*?<\/main>/)?.[0] ?? ''
    expect(enHubMain).not.toMatch(/[\u4e00-\u9fa5]/)

    for (const slug of TOOL_SLUGS) {
      const zhPage = renderToolPageHtml(slug, 'zh')!
      const enPage = renderToolPageHtml(slug, 'en')!
      expect(zhPage).toContain(`<link rel="canonical" href="https://heurion.org/tools/${slug}">`)
      expect(enPage).toContain(`<link rel="canonical" href="https://heurion.org/en/tools/${slug}">`)
      expect(zhPage).toContain('application/ld+json')
      expect(enPage).toContain('application/ld+json')
      expect(zhPage).toContain('property="og:image"')
      const enMain = enPage.match(/<main[\s\S]*?<\/main>/)?.[0] ?? ''
      expect(enMain).not.toMatch(/[\u4e00-\u9fa5]/)
    }
  })
})

describe('Stateless No-Login Mini-Tools Public API (/api/public/tools/*)', () => {
  const app = new Hono()
  registerPublicToolsApi(app)

  it('computes VanderWeele E-value, SVG curve, and bilingual reviewer rebuttal text without login', async () => {
    const res = await app.request('/api/public/tools/e-value', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        effect_type: 'HR',
        estimate: 0.74,
        ci_lower: 0.65,
        ci_upper: 0.85,
        lang: 'en',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.e_value_point).toBeCloseTo(2.04, 2)
    expect(body.e_value_ci).toBeCloseTo(1.63, 2)
    expect(body.svg).toContain('<svg')
    expect(body.svg).not.toMatch(/[\u4e00-\u9fa5]/)
    expect(body.rebuttal_zh).toContain('VanderWeele')
    expect(body.rebuttal_en).toContain('Response to Reviewer')
  })

  it('renders CONSORT 2010 / STROBE vector SVG and Mermaid flowcharts with arithmetic check', async () => {
    const res = await app.request('/api/public/tools/consort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'HFrEF Cohort Selection',
        lang: 'en',
        total_assessed: 1000,
        exclusions: [
          { reason: 'Age < 18', count: 50 },
          { reason: 'Missing follow-up', count: 150 },
        ],
        eligible_total: 800,
        arms: [
          { name: 'Dapagliflozin', allocated: 400, lost_to_followup: 10, analyzed: 390 },
          { name: 'Standard Care', allocated: 400, lost_to_followup: 12, analyzed: 388 },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.svg).toContain('<svg')
    expect(body.svg).toContain('HFrEF Cohort Selection')
    expect(body.svg).not.toMatch(/[\u4e00-\u9fa5]/)
    expect(body.mermaid).toContain('graph TD')
    expect(body.mermaid).not.toMatch(/[\u4e00-\u9fa5]/)
    expect(body.arithmetic_warning).toBeNull()
  })

  it('generates Table 1 JSON, detects PHI leaks, and exports native Word (.docx) binary', async () => {
    const csvClean = [
      'id,group,age,sex,lvef',
      'S001,Dapa,64,Male,31.2',
      'S002,Dapa,59,Female,34.5',
      'S003,Dapa,71,Male,26.0',
      'S004,Control,66,Male,30.8',
      'S005,Control,61,Female,33.9',
      'S006,Control,73,Male,25.4',
    ].join('\n')

    const res = await app.request('/api/public/tools/table1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csv: csvClean,
        options: { group_col: 'group', include_smd: true, include_p_value: true },
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.phi_clean).toBe(true)
    expect(data.table1.headers).toContain('SMD')
    expect(data.table1.headers).toContain('P value')

    // 测试原生 Word (.docx) 导出
    const docxRes = await app.request('/api/public/tools/table1-docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csv: csvClean,
        options: { group_col: 'group', include_smd: true },
      }),
    })
    expect(docxRes.status).toBe(200)
    expect(docxRes.headers.get('content-type')).toContain('wordprocessingml.document')
    const bytes = new Uint8Array(await docxRes.arrayBuffer())
    const files = unzipSync(bytes)
    const docXml = strFromU8(files['word/document.xml']!)
    expect(docXml).toContain('Table 1')
    expect(docXml).toContain('Dapa')
  })

  it('verifies PubMed citations and flags mismatched effect sizes and hallucinated PMIDs', async () => {
    const draft = [
      'DAPA-HF showed dapagliflozin reduced primary events (HR 0.74, 95% CI 0.65-0.85) [1].',
      'In DELIVER, a draft mistakenly wrote HR 0.58 (95% CI 0.45-0.71) [2].',
      'A fabricated reference was also cited [3].',
      '[1] McMurray JJV, et al. N Engl J Med. 2019. PMID: 31535829',
      '[2] Solomon SD, et al. N Engl J Med. 2022. PMID: 36027570',
      '[3] Fake Author, et al. Lancet. 2024. PMID: 99999999',
    ].join('\n')

    const res = await app.request('/api/public/tools/citation-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: draft }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.summary).toEqual({
      total: 3,
      verified: 1,
      mismatch: 1,
      unverifiable: 1,
    })
  })

  it('computes Kaplan-Meier survival curves, Log-rank test, and Cox HR without login', async () => {
    const csv = [
      'id,group,time_months,event',
      'P1,Dapa,36,0',
      'P2,Dapa,24,1',
      'P3,Dapa,30,0',
      'P4,Dapa,36,0',
      'P5,Control,8,1',
      'P6,Control,12,1',
      'P7,Control,18,1',
      'P8,Control,26,0',
    ].join('\n')

    const res = await app.request('/api/public/tools/kaplan-meier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csv,
        time_col: 'time_months',
        event_col: 'event',
        group_col: 'group',
        lang: 'en',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.svg).toContain('<svg')
    expect(body.svg).toContain('No. at Risk')
    expect(body.groups.length).toBe(2)
    expect(body.log_rank).toBeDefined()
    expect(body.cox).toBeDefined()
    expect(body.narrative_en).toContain('Kaplan-Meier')
    expect(body.narrative_zh).toContain('生存分析')
  })

  it('renders log-scale Subgroup Forest Plot SVG with summary diamond and R script', async () => {
    const rawLines = [
      '*Overall Cohort (N=4744) | 0.74 | 0.65 | 0.85 | <0.001',
      'Age <= 65 yr | 0.72 | 0.59 | 0.88 | 0.001',
      'Age > 65 yr | 0.76 | 0.64 | 0.90 | 0.002',
    ].join('\n')

    const res = await app.request('/api/public/tools/forest-plot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'DAPA-HF Subgroup Forest Plot',
        effect_type: 'HR',
        raw_lines: rawLines,
        lang: 'en',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.svg).toContain('<svg')
    expect(body.svg).toContain('<polygon') // Summary diamond
    expect(body.svg).not.toMatch(/[\u4e00-\u9fa5]/)
    expect(body.rows_count).toBe(3)
    expect(body.r_script).toContain('forestploter')
  })

  it('scans and redacts clinical PHI (MOD 11-2 ID card, phone, MRN, email, SSN, and patient name)', async () => {
    const text =
      '患者张建国，男，确诊为心力衰竭。住院号：ZY202509821，身份证：11010519491231002X，手机：13800138000，Email: test@hospital.org, MRN: HOSP-99881, SSN: 123-45-6789'
    const res = await app.request('/api/public/tools/phi-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang: 'zh' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.clean).toBe(false)
    expect(body.findings_count).toBeGreaterThanOrEqual(5)
    expect(body.redacted_text).not.toContain('11010519491231002X')
    expect(body.redacted_text).not.toContain('13800138000')
    expect(body.redacted_text).not.toContain('123-45-6789')
  })

  it('classifies human vs AI crawler vs health probe traffic and exposes privacy-safe telemetry', async () => {
    expect(classifyTrafficActor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', '/tools')).toBe('human')
    expect(classifyTrafficActor('Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)', '/llms.txt')).toBe('ai_crawler')
    expect(classifyTrafficActor('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', '/')).toBe('search_bot')
    expect(classifyTrafficActor('curl/8.7.1', '/healthz')).toBe('probe_or_bot')

    recordPublicTrafficHit('/tools/kaplan-meier-survival', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    recordPublicTrafficHit('/llms.txt', 'PerplexityBot/1.0')

    const res = await app.request('/api/public/tools/telemetry')
    expect(res.status).toBe(200)
    const snap = await res.json() as any
    expect(snap.totals.human).toBeGreaterThanOrEqual(1)
    expect(snap.totals.ai_crawler).toBeGreaterThanOrEqual(1)
    expect(snap.total_tool_invocations).toBeGreaterThanOrEqual(6)
  })
})
