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
import {
  BLOG_SLUGS,
  registerBlogRoutes,
  renderBlogHomeHtml,
  renderBlogPostHtml,
  renderBlogRssXml,
  renderBlogSitemapXml,
} from '../src/http/routes/blog-pages.ts'

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
    for (const slug of BLOG_SLUGS) {
      expect(llms).toContain(`https://heurion.org/blog/${slug}`)
      expect(llms).toContain(`https://heurion.org/en/blog/${slug}`)
      expect(llms).toContain(`https://heurion.org/blog/${slug}.md`)
      expect(sitemap).toContain(`https://heurion.org/blog/${slug}`)
      expect(sitemap).toContain(`https://heurion.org/en/blog/${slug}`)
    }
    expect(sitemap).not.toContain('cross-modal-self-evolution-clinical-deep-review')
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

describe('Personal Technical Blog (blog.heurion.org & heurion.org/blog)', () => {
  it('renders bilingual Personal Blog Homepage and all 3 published technical monographs with zero CJK leak in EN <main>', () => {
    expect(BLOG_SLUGS.length).toBe(3)
    const zhHome = renderBlogHomeHtml('zh', { subdomain: true })
    const enHome = renderBlogHomeHtml('en', { subdomain: true })

    expect(zhHome).toContain('Heurion Research')
    expect(zhHome).toContain('Engineering &amp; Systems Blog')
    expect(zhHome).toContain('<link rel="canonical" href="https://blog.heurion.org/">')
    expect(enHome).toContain('<link rel="canonical" href="https://blog.heurion.org/en">')

    const enHomeMain = enHome.match(/<main[\s\S]*?<\/main>/)?.[0] ?? ''
    expect(enHomeMain).not.toMatch(/[\u4e00-\u9fa5]/)

    for (const slug of BLOG_SLUGS) {
      const zhPost = renderBlogPostHtml(slug, 'zh', { subdomain: true })!
      const enPost = renderBlogPostHtml(slug, 'en', { subdomain: true })!
      expect(zhPost).toContain(`<link rel="canonical" href="https://blog.heurion.org/${slug}">`)
      expect(enPost).toContain(`<link rel="canonical" href="https://blog.heurion.org/en/${slug}">`)
      expect(zhPost).toContain('BlogPosting')
      const enPostMain = enPost.match(/<main[\s\S]*?<\/main>/)?.[0] ?? ''
      expect(enPostMain).not.toMatch(/[\u4e00-\u9fa5]/)
    }
  })

  it('executes real Dual-Surface CRDT structural ops, blocks concurrent human-edit conflicts, and 1-click publishes live to blog.heurion.org', async () => {
    const blogApp = new Hono()
    registerBlogRoutes(blogApp)

    const sampleMd = [
      '{#h01} ## 1. Architecture Overview',
      '',
      '{#p02} Original paragraph in ProseMirror CRDT space.',
    ].join('\n')

    // 1. Targeted replace_block op via ProseMirror applyOps
    const compileRes = await blogApp.request('http://blog.heurion.org/api/public/blog/crdt-compile', {
      method: 'POST',
      headers: { Host: 'blog.heurion.org', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: sampleMd,
        ops: [{ op: 'replace_block', id: 'p02', markdown: 'Updated **atomically** via `replace_block`.' }],
      }),
    })
    expect(compileRes.status).toBe(200)
    const compiled = await compileRes.json() as any
    expect(compiled.ok).toBe(true)
    expect(compiled.block_count).toBe(2)
    expect(compiled.agent_surface_markdown).toContain('{#p02} Updated **atomically**')
    expect(compiled.human_surface_html).toContain('data-crdt-id="p02"')

    // 2. Concurrent human-edit lock conflict interception (user_locked_ids)
    const conflictRes = await blogApp.request('http://blog.heurion.org/api/public/blog/crdt-compile', {
      method: 'POST',
      headers: { Host: 'blog.heurion.org', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: sampleMd,
        ops: [{ op: 'replace_all', scope: 'p02', find: 'Original', replace: 'Clobbered' }],
        user_locked_ids: ['p02'],
      }),
    })
    expect(conflictRes.status).toBe(200)
    const conflictBody = await conflictRes.json() as any
    expect(conflictBody.ok).toBe(false)

    // 3. 1-Click Publish from Dual-Surface CRDT to blog.heurion.org
    const pubRes = await blogApp.request('http://blog.heurion.org/api/public/blog/publish', {
      method: 'POST',
      headers: { Host: 'blog.heurion.org', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'omnidoc-crdt-test-post',
        title_zh: 'OmniDoc Dual-Surface Live Post',
        title_en: 'OmniDoc Dual-Surface Live Post',
        markdown_zh: compiled.agent_surface_markdown,
        markdown_en: compiled.agent_surface_markdown,
      }),
    })
    expect(pubRes.status).toBe(200)
    const pubData = await pubRes.json() as any
    expect(pubData.ok).toBe(true)
    expect(pubData.subdomain_url).toBe('/omnidoc-crdt-test-post')

    // Verify the newly published post is immediately live on blog.heurion.org and heurion.org/blog
    const liveSubRes = await blogApp.request('http://blog.heurion.org/omnidoc-crdt-test-post', {
      headers: { Host: 'blog.heurion.org' },
    })
    expect(liveSubRes.status).toBe(200)
    const liveSubHtml = await liveSubRes.text()
    expect(liveSubHtml).toContain('OmniDoc Dual-Surface Live Post')
    expect(liveSubHtml).toContain('{#p02}')
  })

  it('serves blog.heurion.org subdomain routes, heurion.org/blog routes, RSS 2.0 feed, and redirect mode', async () => {
    const blogApp = new Hono()
    registerBlogRoutes(blogApp)

    // 1. Subdomain Host: blog.heurion.org
    const subRoot = await blogApp.request('http://blog.heurion.org/', {
      headers: { Host: 'blog.heurion.org' },
    })
    expect(subRoot.status).toBe(200)
    expect(await subRoot.text()).toContain('Heurion Research')

    const subEnPost = await blogApp.request(
      'http://blog.heurion.org/en/aegis-os-transactional-agent-kernel',
      { headers: { Host: 'blog.heurion.org' } },
    )
    expect(subEnPost.status).toBe(200)
    expect(await subEnPost.text()).toContain('Beyond Git Feature Branches')

    const subRedirect = await blogApp.request('http://blog.heurion.org/blog', {
      headers: { Host: 'blog.heurion.org' },
    })
    expect(subRedirect.status).toBe(301)
    expect(subRedirect.headers.get('location')).toBe('/')

    const rssRes = await blogApp.request('http://blog.heurion.org/feed.xml', {
      headers: { Host: 'blog.heurion.org' },
    })
    expect(rssRes.status).toBe(200)
    const rssText = await rssRes.text()
    expect(rssText).toContain('<rss version="2.0"')
    expect(rssText).toContain('https://blog.heurion.org/dual-surface-crdt-clinical-ai')

    const sitemapXml = renderBlogSitemapXml()
    expect(sitemapXml).toContain('https://heurion.org/blog/human-agent-capability-parity-ai-native-software')
    expect(sitemapXml).toContain('https://heurion.org/en/blog/human-agent-capability-parity-ai-native-software')
    expect(renderBlogSitemapXml({ subdomain: true })).toContain('https://blog.heurion.org/human-agent-capability-parity-ai-native-software')
    expect(renderBlogRssXml('en')).toContain('https://heurion.org/en/blog/aegis-os-transactional-agent-kernel')
    expect(renderBlogRssXml('en', { subdomain: true })).toContain('https://blog.heurion.org/en/aegis-os-transactional-agent-kernel')

    // 2. Main domain Host: heurion.org (/blog, /en/blog, /blog/en/:slug 301 redirect, .md GEO endpoints, & ?redirect=1)
    const mainBlog = await blogApp.request('http://heurion.org/blog', {
      headers: { Host: 'heurion.org' },
    })
    expect(mainBlog.status).toBe(200)
    const mainBlogHtml = await mainBlog.text()
    expect(mainBlogHtml).toContain('<link rel="canonical" href="https://heurion.org/blog">')
    expect(mainBlogHtml).toContain('/blog/dual-surface-crdt-clinical-ai')
    expect(mainBlogHtml).toContain('CollectionPage')
    expect(mainBlogHtml).toContain('BreadcrumbList')
    expect(mainBlogHtml).toContain('type="text/markdown"')

    const mainEnPost = await blogApp.request('http://heurion.org/en/blog/aegis-os-transactional-agent-kernel', {
      headers: { Host: 'heurion.org' },
    })
    expect(mainEnPost.status).toBe(200)
    const mainEnPostHtml = await mainEnPost.text()
    expect(mainEnPostHtml).toContain('<link rel="canonical" href="https://heurion.org/en/blog/aegis-os-transactional-agent-kernel">')
    expect(mainEnPostHtml).toContain('TechArticle')
    expect(mainEnPostHtml).toContain('FAQPage')
    expect(mainEnPostHtml).toContain('BreadcrumbList')
    expect(mainEnPostHtml).toContain('Reproducible Artifacts')

    const legacyEnRedirect = await blogApp.request('http://heurion.org/blog/en/dual-surface-crdt-clinical-ai', {
      headers: { Host: 'heurion.org' },
    })
    expect(legacyEnRedirect.status).toBe(301)
    expect(legacyEnRedirect.headers.get('location')).toBe('/en/blog/dual-surface-crdt-clinical-ai')

    const mdPostRes = await blogApp.request('http://heurion.org/en/blog/dual-surface-crdt-clinical-ai.md', {
      headers: { Host: 'heurion.org' },
    })
    expect(mdPostRes.status).toBe(200)
    expect(mdPostRes.headers.get('content-type')).toContain('text/markdown')
    const mdPostText = await mdPostRes.text()
    expect(mdPostText).toContain('canonical_url: "https://heurion.org/en/blog/dual-surface-crdt-clinical-ai"')
    expect(mdPostText).toContain('## Frequently Asked Questions (Technical FAQ)')

    const mdIndexRes = await blogApp.request('http://heurion.org/blog.md', {
      headers: { Host: 'heurion.org' },
    })
    expect(mdIndexRes.status).toBe(200)
    expect(await mdIndexRes.text()).toContain('https://heurion.org/blog/dual-surface-crdt-clinical-ai.md')

    const mainBlogRedirect = await blogApp.request('http://heurion.org/blog?redirect=1', {
      headers: { Host: 'heurion.org' },
    })
    expect(mainBlogRedirect.status).toBe(302)
    expect(mainBlogRedirect.headers.get('location')).toBe('https://blog.heurion.org/')

    // 3. Minimalist Reader Comments API & rendering
    const commentPostRes = await blogApp.request('http://blog.heurion.org/blog/api/comments', {
      method: 'POST',
      headers: { Host: 'blog.heurion.org', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'aegis-os-transactional-agent-kernel',
        author: 'Systems Reader',
        content: 'Great breakdown of APFS clonefile CoW workspaces!',
      }),
    })
    expect(commentPostRes.status).toBe(200)
    const commentJson = await commentPostRes.json() as any
    expect(commentJson.ok).toBe(true)
    expect(commentJson.comment.author).toBe('Systems Reader')

    const postWithComment = renderBlogPostHtml('aegis-os-transactional-agent-kernel', 'en', { subdomain: true })!
    expect(postWithComment).toContain('Systems Reader')
    expect(postWithComment).toContain('Great breakdown of APFS clonefile CoW workspaces!')
  })
})

