import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Hono } from 'hono'
import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { registerPublicToolsApi } from '../src/http/routes/public-tools-api.ts'
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
    expect(enHtml).toContain('Heurion 2.0 &amp; OmniCanvas · Clinical Research AI Workstation')
    expect(enHtml).toContain('Aegis OS (aegis-os) · Transactional Multi-Tenant Agent OS Runtime')
    expect(enHtml).toContain('What is Heurion, and how does it differ fundamentally from generic LLMs like ChatGPT or Claude?')
    expect(enHtml).toContain('What is Aegis OS, and how does it work together with the Heurion 2.0 Clinical Workstation?')
    expect(enHtml).toContain('href="/en/tools"')
  })

  it('validates robots.txt, llms.txt, and sitemap.xml for AI crawlers and Programmatic SEO', () => {
    const robots = readFileSync(join(SITE_DIR, 'robots.txt'), 'utf8')
    expect(robots).toContain('Sitemap: https://heurion.org/sitemap.xml')
    expect(robots).not.toContain('Sitemap: https://heurion.org/llms.txt')
    expect(robots).toContain('User-agent: OAI-SearchBot')

    const llms = readFileSync(join(SITE_DIR, 'llms.txt'), 'utf8')
    expect(llms).toContain('临床研究工作流')
    expect(llms).toContain('研究者发起的临床研究（IIT')
    expect(llms).toContain('https://heurion.org/tools/e-value-calculator')
    expect(llms).toContain('https://heurion.org/tools/table-1-generator')
    expect(llms).toContain('https://heurion.org/tools/consort-strobe-flowchart')
    expect(llms).toContain('https://heurion.org/tools/pubmed-citation-checker')

    const sitemap = readFileSync(join(SITE_DIR, 'sitemap.xml'), 'utf8')
    for (const slug of TOOL_SLUGS) {
      expect(sitemap).toContain(`https://heurion.org/tools/${slug}`)
      expect(sitemap).toContain(`https://heurion.org/en/tools/${slug}`)
    }
  })

  it('renders bilingual Tools Hub (/tools and /en/tools) and all 4 standalone mini-tool pages', () => {
    const zhHub = renderToolsHubHtml('zh')
    const enHub = renderToolsHubHtml('en')
    expect(zhHub).toContain('<link rel="canonical" href="https://heurion.org/tools">')
    expect(enHub).toContain('<link rel="canonical" href="https://heurion.org/en/tools">')
    const enHubMain = enHub.match(/<main[\s\S]*?<\/main>/)?.[0] ?? ''
    expect(enHubMain).not.toMatch(/[\u4e00-\u9fa5]/)

    for (const slug of TOOL_SLUGS) {
      const zhPage = renderToolPageHtml(slug, 'zh')!
      const enPage = renderToolPageHtml(slug, 'en')!
      expect(zhPage).toContain(`<link rel="canonical" href="https://heurion.org/tools/${slug}">`)
      expect(enPage).toContain(`<link rel="canonical" href="https://heurion.org/en/tools/${slug}">`)
      expect(zhPage).toContain('application/ld+json')
      expect(enPage).toContain('application/ld+json')
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
})
