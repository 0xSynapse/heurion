/**
 * Heurion 2.0 平台服务主入口（组装存储、运行时、文献、审稿、MCP 与 HTTP/WebSocket 网关）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { Accounts } from './auth/accounts.ts'
import { createMailer } from './auth/mailer.ts'
import { Alerts } from './ops-alert/alerts.ts'
import { SearchIndex } from './model/search-index.ts'
import { HttpEmbedder } from './kb/embedder.ts'
import { HttpDocParser } from './convert/doc-parser.ts'
import { localImageOcr, localOcr } from './kb/ocr.ts'
import { extractText } from './kb/extract.ts'
import { KbService } from './kb/service.ts'
import { makeIngest } from './datasets/ingest.ts'
import { DatasetService } from './datasets/service.ts'
import { Access } from './research/access.ts'
import { StudyService } from './research/service.ts'
import { CohortService } from './research/cohort.ts'
import { TenantService } from './auth/tenants.ts'
import { kekFrom, TenantKeys } from './tenancy/keys.ts'
import { PatientService } from './tenancy/patients.ts'
import { ShareService } from './tenancy/shares.ts'
import { MemoryEvolution } from './memory/evolve.ts'
import { MemoryService } from './memory/service.ts'
import { MemorySignals } from './memory/signals.ts'
import { ExecutionSignals } from './memory/execution-signals.ts'
import { ProceduralHarnessService } from './memory/procedural.ts'
import { SkillTrainingService } from './memory/skill-trainer.ts'
import { MailService } from './mail/service.ts'
import { CalendarService } from './calendar/service.ts'
import { makeComplete, makeVisionComplete, VISION_MODELS } from './harness/complete.ts'
import { HarnessEvolutionService } from './harness/evolve-harness.ts'
import { ClaimService } from './claims/service.ts'
import { SlideRenderer } from './render/slides.ts'
import { attachCollab } from './collab/gateway.ts'
import { PostCheck } from './collab/postcheck.ts'
import { SubagentService } from './subagents/service.ts'
import { config } from './config.ts'
import { HarnessPool } from './harness/pool.ts'
import { handleLlmProxy, LLM_PREFIX } from './harness/llm-proxy.ts'
import { makeInvoker, type Invoke } from './http/invoke.ts'
import { buildApi } from './http/api.ts'
import { CrossrefClient } from './literature/crossref.ts'
import { OpenAlexClient } from './literature/openalex.ts'
import { FullTextClient } from './literature/fulltext.ts'
import { PubMedClient } from './literature/pubmed.ts'
import { handleAegisMcp, handleMcp } from './mcp/server.ts'
import { TurnRegistry } from './mcp/turns.ts'
import { Documents } from './model/runtime.ts'
import { OpService } from './ops/service.ts'
import { Store } from './store/db.ts'
import { TurnService } from './turns/service.ts'
import { themePhoto } from './model/theme-photos.ts'
import { ImageService } from './images/service.ts'
import { Unsplash } from './images/unsplash.ts'
import { orthancFromEnv } from './imaging/orthanc.ts'
import { sharedPipeline } from './imaging/pipeline.ts'
import { startImagingRetention } from './imaging/retention.ts'

const store = new Store(config.dbPath)
const docs = new Documents(store)
// 知家红线守卫的成员标记：patients 在下面才创建，晚绑定（OpService 里可选调用）
let phrMemberLookup: ((owner: string, patientId: string, space?: 'work' | 'personal') => { tags: string[]; birth_year: number | null } | null) | null = null
const executionSignals = new ExecutionSignals(store, docs)
const procedural = new ProceduralHarnessService(store, docs, { mode: config.proceduralMode === 'off' ? undefined : config.proceduralMode, budget: config.proceduralBudget })
executionSignals.setActivationLookup((owner, docId, turnId) => procedural.lastActivation(owner, docId, turnId))
// provenance：来源规则（docs/design/PROVENANCE.md）线上开启
const ops = new OpService(docs, (owner, pid, space) => phrMemberLookup?.(owner, pid, space) ?? null, e => executionSignals.recordGuardReject(e), { provenance: true })
const registry = new TurnRegistry()
const harnessEvolution = new HarnessEvolutionService(store, makeComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.model }))
const pool = new HarnessPool(config, userId => store.sandboxUid(userId), () => (config.harnessEvolve ? harnessEvolution.currentOverlay() : null))
const postcheck = new PostCheck(docs)

const pubmed = new PubMedClient(fetch, config.ncbiApiKey, config.contactEmail)
const crossref = new CrossrefClient(fetch, config.contactEmail)
const openalex = new OpenAlexClient(fetch, config.contactEmail)
// 开放获取全文：论断核对的补充证据、AI 写作时可读（M3）
const fulltext = new FullTextClient(store, fetch, config.contactEmail)
const claims = new ClaimService(docs, pubmed, fulltext)
const renderer = new SlideRenderer(config.renderDir)
// 参考资料库：本地嵌入服务（apps/embedder）可选，不在时只用关键词检索
const embedder = config.embeddingUrl ? new HttpEmbedder(config.embeddingUrl) : null
const kb = new KbService(store, embedder, localOcr(config.ocrCacheDir))
// PDF 导入主路径：本地 doc-parser 服务（apps/doc-parser，Docling）；不在 / 未就绪时退回 poppler
const docParser = config.docParserUrl ? new HttpDocParser(config.docParserUrl, { timeoutMs: config.docParserTimeoutMs }) : null
kb.resume()
// 记忆（R3）：相似去重与按相关度注入用同一个嵌入服务，不在时按文本
const memory = new MemoryService(store, embedder)
// 记忆演进：收集用户改写 AI 段落 / 拒绝修订的信号；整理（合并、改写、归档、总结新规律）都是待用户采纳的建议
new MemorySignals(store, memory, docs)
const evolution = new MemoryEvolution(store, memory, docs, makeComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.model }))
const skillTrainer = new SkillTrainingService(store, memory, docs, makeComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.model }))
const mailer = createMailer({
  resendApiKey: config.resendApiKey,
  smtp: config.smtpHost ? {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    user: config.smtpUser,
    pass: config.smtpPass,
  } : undefined,
  from: config.emailFrom,
  production: process.env.NODE_ENV === 'production',
})
// 运维告警：模型服务不可用、回合大量失败时发邮件给管理员
const alerts = new Alerts(store, mailer)
// 数据集（实验室数据分析）：上传的表格在该用户的隔离环境里解析（与 AI 代码同一个 uid），支持 AI 语义核验工作簿与数据字典
const datasets = new DatasetService(
  store,
  config.datasetsDir,
  makeIngest({
    python: config.computePython,
    script: fileURLToPath(new URL('../scripts/dataset_ingest.py', import.meta.url)),
    sandbox: config.sandbox ? { uid: userId => store.sandboxUid(userId), workspaceDir: userId => pool.workspaceDir(userId), homeDir: userId => pool.homeDir(userId) } : null,
  }),
  makeComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.model }),
)
// 患者（按机构分库、机构密钥加密，见 docs/design/TENANCY.md）
// 上传的报告：PDF（文字层，扫描件 OCR）、图片（OCR）、docx / txt → 每页文字，打码后交给模型提取（patients.ts / extract-report.ts）
const reportOcr = localOcr(config.ocrCacheDir)
const reportImageOcr = localImageOcr(config.ocrCacheDir)
const reportPages = async (name: string, mime: string, bytes: Uint8Array): Promise<string[]> => {
  if (mime.startsWith('image/')) return [await reportImageOcr(bytes)]
  return (await extractText(name, bytes, { ocr: reportOcr })).pages
}
const patients = new PatientService(config.tenantsDir, new TenantService(store, { devMode: config.devMode }), new TenantKeys(store, kekFrom({ kek: config.kek, secret: config.secret })), store,
  { pages: reportPages, complete: makeComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.model }) },
  // 成员的「健康档案」文档：建档即建并关联（知家 V0，PATIENT.md §12）
  ({ owner, title, patientId }) => docs.create({ owner, title }).id)
phrMemberLookup = (owner, pid, space) => patients.memberMarkers(owner, pid, space)
// 访问判定（研究团队协作）：研究里的文档、数据集、分析图按成员角色共享；接口、MCP、协同、服务层共用这一个
const access = new Access(store)
access.docText = id => JSON.stringify(docs.get(id).toJSON())
datasets.access = access
const studies = new StudyService(store, datasets, access)
const cohort = new CohortService(studies, patients, datasets)
// Unsplash 图库（幻灯片搜图）：没配 key 时 configured=false，界面隐藏入口、MCP 返回「未配置」
const images = new ImageService(docs, ops, new Unsplash(config.unsplashAccessKey))
images.access = access
// 知家红线（PATIENT.md §3）：绑定健康档案 / 简报的回合，AI 的对话回复在展示与落库前也过守卫
const turns = new TurnService(docs, pool, registry, {
  idleTimeoutMs: config.turnIdleTimeoutMs, memory, procedural: config.proceduralMode === 'off' ? undefined : procedural, alerts,
  phrGuard: docId => {
    const row = store.getDoc(docId)
    let ctx: { kind?: string; doc_kind?: string; patient_id?: string; space?: 'work' | 'personal' } | null = null
    try { ctx = row?.context ? JSON.parse(row.context) : null } catch { /* 无归属 */ }
    if (!row || ctx?.kind !== 'patient' || (ctx.doc_kind !== 'archive' && ctx.doc_kind !== 'brief')) return undefined
    return patients.memberMarkers(row.owner, ctx.patient_id!, ctx.space === 'work' ? 'work' : 'personal')
  },
})
// 知家分享给医生（docs/design/SHARING.md）：界面与 MCP 共用一个实例
const shares = new ShareService(store, patients.tenantService, patients, docs)
const subagents = new SubagentService({ docs, store, claims, pubmed, openalex, fulltext, datasets, cohort, access })
const mcpDeps = {
  docs, ops, claims, renderer, turns: registry, secret: config.secret,
  devMode: config.devMode,
  devUser: config.devUser,
  pubmed,
  crossref,
  openalex,
  workspaceDir: (userId: string) => pool.workspaceDir(userId),
  kb,
  memory,
  evolution,
  executionSignals,
  datasets,
  patients,
  shares,
  studies,
  cohort,
  fulltext,
  images,
  access,
  subagents,
  isLiveSession: (userId: string, generation: string) => pool.isLive(userId, generation),
}

const accounts = new Accounts(store, { secret: config.secret, devMode: config.devMode, devToken: config.devToken, devUser: config.devUser, mailer })
const search = new SearchIndex(docs)
const indexed = search.backfill()
if (indexed) console.log(`全文索引：补齐 ${indexed} 份文档`)
// 回收站：30 天后自动彻底删除（启动时一次，之后每 12 小时）
// 审计日志保留 365 天
const purge = () => { for (const id of store.purgeTrash(30)) { docs.unload(id); store.unindexDoc(id) } store.purgeAudit(365); store.purgeMemorySignals(60); store.purgeObservedNumbers(14) }
purge()
setInterval(purge, 12 * 3600_000).unref()
// 来源标记回填（docs/design/PROVENANCE.md 6.1）：只执行一次；逐份文档提交，单份失败不影响其余
if (!store.getAppSetting('migration.provenance_backfill')) {
  let marked = 0
  for (const id of store.allDocIds()) {
    const wasLoaded = docs.isLoaded(id)
    try { marked += docs.backfillProvenance(id) } catch (err) { console.error(`[provenance] backfill ${id}:`, err) }
    if (!wasLoaded) docs.unload(id)
  }
  store.setAppSetting('migration.provenance_backfill', new Date().toISOString())
  console.log(`[provenance] backfill done: ${marked} AI blocks marked`)
}
// 内存优化：空闲文档自动驱逐（每 5 分钟检查一次，驱逐无活跃连接且超过 10 分钟未被访问的文档，防长期运行内存泄漏）
setInterval(() => docs.evictIdle(), 5 * 60_000).unref()
// PDF 解析服务健康检查：每 5 分钟一次，连续两次不就绪告警给管理员（不就绪时 PDF 会悄悄退回 poppler，表格不可靠）。
// 启动后 10 分钟再开始，避开 doc-parser 与平台同时重启时的模型预热期
if (docParser) {
  setTimeout(() => {
    const check = () => void docParser.ready().then(ok => alerts.docParserHealth(ok, config.docParserUrl))
    check()
    setInterval(check, 5 * 60_000).unref()
  }, 10 * 60_000).unref()
}
// 定时整理记忆与后台静默演进执行策略：每 6 小时看一次（MEMORY_AUTO_REVIEW=0 关闭）
if (evolution.available() && process.env.MEMORY_AUTO_REVIEW !== '0') {
  setInterval(() => void (async () => {
    for (const owner of store.usersWithMemorySignals(3)) {
      const last = store.getUserSetting(owner, 'memory_review_at')
      if (!memory.active(owner) || (last && Date.now() - Date.parse(last) < 86_400_000)) continue
      await evolution.review(owner, { force: false }).catch(err => console.error('[memory-review]', owner, (err as Error).message))
    }
    if (config.harnessEvolve && harnessEvolution.available()) {
      const meta = harnessEvolution.currentMeta()
      if (!meta || Date.now() - Date.parse(meta.at) >= 86_400_000) {
        await harnessEvolution.evolve({ force: false }).catch(err => console.error('[harness-evolve]', (err as Error).message))
      }
    }
  })(), 6 * 3600_000).unref()
}
// 影像原件保留期清理（IMAGING_RETENTION_DAYS > 0 且接了 Orthanc 时）：启动 10 分钟后跑一次，之后每天一次。
// 「分析进行中」以本进程的流水线为准（与接口共用 sharedPipeline），服务重启留下的 queued / running 不阻止清理
{
  const orthanc = orthancFromEnv()
  if (startImagingRetention(patients, orthanc, { days: config.imagingRetentionDays, isRunActive: id => sharedPipeline(patients, orthanc).isActive(id) })) {
    console.log(`影像原件保留期：${config.imagingRetentionDays} 天（每天清理一次）`)
  }
}
const llmComplete = makeComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.model })
const mail = new MailService(store, mailer, {
  domain: config.mailDomain,
  complete: llmComplete,
})
const calendar = new CalendarService(store, mail)
// 审稿按页面图像核对表格（PDF_ORIGINAL_VIEW.md §12.3）：同一上游；REVIEW_VISION_MODEL 指定的模型视为支持图像
if (config.reviewVisionModel) VISION_MODELS.add(config.reviewVisionModel)
const reviewVision = config.reviewTableVision
  ? makeVisionComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.reviewVisionModel || config.model, timeoutMs: 120_000 })
  : null
const app = buildApi({ docs, reviewVision, reviewComplete: llmComplete, fulltext, claims, ops, turns, turnRegistry: registry, postcheck, crossref, pubmed, openalex, renderer, accounts, devMode: config.devMode, aegisEnabled: config.aegisEnabled, imagingAcceptIdentified: config.imagingAcceptIdentified, devUser: config.devUser, search, kb, memory, evolution, skillTrainer, datasets, patients, shares, studies, cohort, images, access, mail, calendar, pdfOcr: reportOcr, docParser, alerts, workspaceDir: userId => pool.workspaceDir(userId) })
// MCP 的管理类工具以用户身份进程内调用同一个 HTTP 应用（AI 的权限 = 用户的权限，见 http/invoke.ts）
;(mcpDeps as { invoke?: Invoke }).invoke = makeInvoker(app)

// 页面：web/ 的构建产物（pnpm --filter @heurion2/platform build）；开发时用 vite（dev:web）
const DIST = fileURLToPath(new URL('../dist-web/', import.meta.url))
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}
app.get('/assets/:file', c => {
  const file = join(DIST, 'assets', basename(c.req.param('file')))
  if (!existsSync(file)) return c.notFound()
  return c.body(readFileSync(file), 200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' })
})
// pdf.js 的 CMap 与标准字体（原版视图渲染没内嵌字体的 PDF 用）：从依赖包里自托管，不走 CDN；公开的库文件，不需登录
const PDFJS_DIR = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))
app.get('/pdfjs/:kind{cmaps|standard_fonts}/:file{[A-Za-z0-9._-]+}', c => {
  const file = join(PDFJS_DIR, c.req.param('kind'), basename(c.req.param('file')))
  if (!existsSync(file)) return c.notFound()
  return c.body(readFileSync(file), 200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' })
})
// 带图模板的照片（模板选择器的缩略图用；Unsplash 授权，公开）
app.get('/theme-photos/:id', c => {
  const p = themePhoto(basename(c.req.param('id')).replace(/\.jpg$/, ''))
  return p ? c.body(Buffer.from(p.bytes), 200, { 'Content-Type': p.mime, 'Cache-Control': 'public, max-age=86400' }) : c.notFound()
})
app.get('/app', c => existsSync(join(DIST, 'index.html'))
  ? c.html(readFileSync(join(DIST, 'index.html'), 'utf8'))
  : c.text('页面未构建：运行 pnpm --filter @heurion2/platform build，或用 dev:web 开发服务器（http://127.0.0.1:5173）', 503))
app.get('/app/', c => c.redirect('/app'))
app.get('/login', c => c.redirect('/app'))
app.get('/login/', c => c.redirect('/app'))
// 知家（患者个人应用 V0，docs/design/PATIENT.md）：家庭健康顾问的移动 Web 外壳
app.get('/phr', c => existsSync(join(DIST, 'phr.html'))
  ? c.html(readFileSync(join(DIST, 'phr.html'), 'utf8'))
  : c.text('页面未构建：运行 pnpm --filter @heurion2/platform build，或用 dev:web 开发服务器（http://127.0.0.1:5173/phr.html）', 503))
app.get('/phr.html', c => c.redirect('/phr'))
// 官网：apps/site 的静态页（不用构建）、个人技术博客（blog.heurion.org 与 /blog*）与免登录临床科研工具矩阵（/tools/*）；工作台在 /app
import { isToolSlug, renderEnglishIndexHtml, renderToolPageHtml, renderToolsHubHtml } from './http/routes/site-pages.ts'
import { registerBlogRoutes } from './http/routes/blog-pages.ts'
import { recordPublicTrafficHit } from './http/routes/public-tools-api.ts'
import { SURVEY_ID, SURVEY_SECTIONS, SURVEY_VERSION } from './survey/clinician-survey.ts'
const SITE = fileURLToPath(new URL('../../site/', import.meta.url))
const PUBLIC_HTML_CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400'
const servePublicHtml = (c: any, html: string) => {
  recordPublicTrafficHit(c.req.path, c.req.header('user-agent'))
  return c.html(html, 200, { 'Cache-Control': PUBLIC_HTML_CACHE })
}
const HEURION_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -2 112 104"><rect x="-10" y="-2" width="112" height="104" rx="22" fill="#FAF8F4" stroke="#E5E0D6" stroke-width="2"/><rect x="6" y="18" width="16" height="66" rx="8" fill="#151C19"/><rect x="60" y="35" width="16" height="49" rx="8" fill="#151C19"/><rect x="18" y="45" width="46" height="16" rx="8" fill="#0A7D52"/><circle cx="76" cy="24" r="10" fill="#00C472"/></svg>`
app.get('/favicon.svg', c => c.body(HEURION_FAVICON_SVG, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400, s-maxage=604800' }))
app.get('/favicon.ico', c => c.body(HEURION_FAVICON_SVG, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400, s-maxage=604800' }))
registerBlogRoutes(app, { serveHtml: servePublicHtml })
app.get('/', c => servePublicHtml(c, readFileSync(join(SITE, 'index.html'), 'utf8')))
app.get('/en', c => servePublicHtml(c, renderEnglishIndexHtml(readFileSync(join(SITE, 'index.html'), 'utf8'))))
app.get('/en/', c => c.redirect('/en'))
app.get('/aegis-os', c => c.redirect('/aegis-os/'))
app.get('/aegis-os/', c => servePublicHtml(c, readFileSync(join(SITE, 'aegis-os/index.html'), 'utf8')))
app.get('/aegis-os/tutorial', c => c.redirect('/aegis-os/tutorial/'))
app.get('/aegis-os/tutorial/', c => servePublicHtml(c, readFileSync(join(SITE, 'aegis-os/tutorial/index.html'), 'utf8')))
app.get('/en/aegis-os', c => c.redirect('/en/aegis-os/'))
app.get('/en/aegis-os/', c => servePublicHtml(c, readFileSync(join(SITE, 'en/aegis-os/index.html'), 'utf8')))
app.get('/en/aegis-os/tutorial', c => c.redirect('/en/aegis-os/tutorial/'))
app.get('/en/aegis-os/tutorial/', c => servePublicHtml(c, readFileSync(join(SITE, 'en/aegis-os/tutorial/index.html'), 'utf8')))
app.get('/aegis-cloud/dashboard', c => c.html(readFileSync(join(SITE, 'aegis-cloud/dashboard.html'), 'utf8')))
app.get('/aegis-cloud/dashboard/', c => c.redirect('/aegis-cloud/dashboard'))
app.get('/aegis-cloud/approve', c => c.html(readFileSync(join(SITE, 'aegis-cloud/dashboard.html'), 'utf8')))
app.get('/aegis-cloud/approve/', c => c.redirect('/aegis-cloud/approve'))
app.get('/aegis-cloud/install.sh', c => c.text(readFileSync(join(SITE, 'aegis-cloud/install.sh'), 'utf8'), 200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' }))
app.all('/aegis-cloud/*', async c => {
  const upstreamBase = process.env.AOS_UPSTREAM_URL || 'http://127.0.0.1:7080'
  const url = new URL(c.req.url)
  const strippedPath = url.pathname.replace(/^\/aegis-cloud/, '') || '/'
  const targetUrl = `${upstreamBase}${strippedPath}${url.search}`
  const headers = new Headers(c.req.raw.headers)
  headers.delete('host')
  const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : await c.req.raw.arrayBuffer()
  const upstreamRes = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body,
  })
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: upstreamRes.headers,
  })
})
// 匿名研究问卷：页面模板里注入同一份题目定义（服务端校验和导出也用它）
const surveyHtml = () => readFileSync(join(SITE, 'survey/index.html'), 'utf8')
  .replace('__SURVEY_DEF__', JSON.stringify({ id: SURVEY_ID, version: SURVEY_VERSION, sections: SURVEY_SECTIONS }).replace(/</g, '\\u003c'))
app.get('/survey', c => servePublicHtml(c, surveyHtml()))
app.get('/survey/', c => c.redirect('/survey'))
app.get('/tools', c => servePublicHtml(c, renderToolsHubHtml('zh')))
app.get('/tools/', c => c.redirect('/tools'))
app.get('/en/tools', c => servePublicHtml(c, renderToolsHubHtml('en')))
app.get('/en/tools/', c => c.redirect('/en/tools'))
app.get('/tools/:slug', c => {
  const slug = c.req.param('slug')
  return isToolSlug(slug) ? servePublicHtml(c, renderToolPageHtml(slug, 'zh')) : c.notFound()
})
app.get('/en/tools/:slug', c => {
  const slug = c.req.param('slug')
  return isToolSlug(slug) ? servePublicHtml(c, renderToolPageHtml(slug, 'en')) : c.notFound()
})
app.get('/robots.txt', c => {
  recordPublicTrafficHit('/robots.txt', c.req.header('user-agent'))
  const file = join(SITE, 'robots.txt')
  return existsSync(file) ? c.body(readFileSync(file), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' }) : c.notFound()
})
app.get('/llms.txt', c => {
  recordPublicTrafficHit('/llms.txt', c.req.header('user-agent'))
  const file = join(SITE, 'llms.txt')
  return existsSync(file) ? c.body(readFileSync(file), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' }) : c.notFound()
})
app.get('/llms-full.txt', c => {
  recordPublicTrafficHit('/llms-full.txt', c.req.header('user-agent'))
  const file = join(SITE, 'llms-full.txt')
  return existsSync(file) ? c.body(readFileSync(file), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' }) : c.notFound()
})
app.get('/sitemap.xml', c => {
  recordPublicTrafficHit('/sitemap.xml', c.req.header('user-agent'))
  const file = join(SITE, 'sitemap.xml')
  return existsSync(file) ? c.body(readFileSync(file), 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400' }) : c.notFound()
})
app.get('/site/:file', c => {
  const file = join(SITE, basename(c.req.param('file')))
  if (!existsSync(file) || !MIME[extname(file)]) return c.notFound()
  return c.body(readFileSync(file), 200, { 'Content-Type': MIME[extname(file)]!, 'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400' })
})
const api = getRequestListener(app.fetch)

const isLoopback = (addr: string | undefined): boolean =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

// /mcp 用 Node 原生 req/res（MCP SDK transport 需要），其余交给 Hono
const server = createServer((req, res) => {
  if (req.url?.startsWith(LLM_PREFIX + '/')) {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403).end('forbidden')
      return
    }
    handleLlmProxy({ secret: config.secret, upstream: config.llmUpstream, apiKey: config.deepseekApiKey, isLive: (u, s) => pool.isLive(u, s) }, req, res).catch(err => {
      console.error('[llm-proxy]', err)
      if (!res.headersSent) res.writeHead(502).end()
    })
    return
  }
  if (config.aegisEnabled && (req.url?.startsWith('/api/aegis/mcp') || req.url?.startsWith('/api/mcp')) && (req.headers.accept ?? '').includes('text/event-stream')) {
    handleAegisMcp(mcpDeps, req, res).catch(err => {
      console.error('[aegis-mcp]', err)
      if (!res.headersSent) res.writeHead(500).end(String(err))
    })
    return
  }
  if (req.url?.startsWith('/mcp')) {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403).end('forbidden')
      return
    }
    handleMcp(mcpDeps, req, res).catch(err => {
      console.error('[mcp]', err)
      if (!res.headersSent) res.writeHead(500).end(String(err))
    })
    return
  }
  void api(req, res)
})

attachCollab(server, { docs, authenticate: token => accounts.userFor(token), role: (user, row) => access.docRole(user, row) })

const restored = turns.restore()
if (restored.interrupted || restored.requeued) console.log(`回合队列：${restored.interrupted} 个中断，${restored.requeued} 个继续排队`)
server.listen(config.port, () => {
  console.log(`heurion platform on http://127.0.0.1:${config.port}`)
  if (!config.deepseekApiKey) console.warn('DEEPSEEK_API_KEY 未设置：AI 回合会失败')
})

const shutdown = async () => {
  docs.flushAll()
  search.flush()
  server.close()
  await pool.closeAll()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
