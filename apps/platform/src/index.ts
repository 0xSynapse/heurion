import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
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
import { MailService } from './mail/service.ts'
import { CalendarService } from './calendar/service.ts'
import { makeComplete } from './harness/complete.ts'
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
import { handleMcp } from './mcp/server.ts'
import { TurnRegistry } from './mcp/turns.ts'
import { Documents } from './model/runtime.ts'
import { OpService } from './ops/service.ts'
import { Store } from './store/db.ts'
import { TurnService } from './turns/service.ts'
import { themePhoto } from './model/theme-photos.ts'
import { ImageService } from './images/service.ts'
import { Unsplash } from './images/unsplash.ts'

const store = new Store(config.dbPath)
const docs = new Documents(store)
// 知家红线守卫的成员标记：patients 在下面才创建，晚绑定（OpService 里可选调用）
let phrMemberLookup: ((owner: string, patientId: string, space?: 'work' | 'personal') => { tags: string[]; birth_year: number | null } | null) | null = null
const ops = new OpService(docs, (owner, pid, space) => phrMemberLookup?.(owner, pid, space) ?? null)
const registry = new TurnRegistry()
const pool = new HarnessPool(config, userId => store.sandboxUid(userId))
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
// 数据集（实验室数据分析）：上传的表格在该用户的隔离环境里解析（与 AI 代码同一个 uid）
const datasets = new DatasetService(store, config.datasetsDir, makeIngest({
  python: config.computePython,
  script: fileURLToPath(new URL('../scripts/dataset_ingest.py', import.meta.url)),
  sandbox: config.sandbox ? { uid: userId => store.sandboxUid(userId), workspaceDir: userId => pool.workspaceDir(userId), homeDir: userId => pool.homeDir(userId) } : null,
}))
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
  idleTimeoutMs: config.turnIdleTimeoutMs, memory, alerts,
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
  pubmed,
  crossref,
  openalex,
  workspaceDir: (userId: string) => pool.workspaceDir(userId),
  kb,
  memory,
  evolution,
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
const purge = () => { for (const id of store.purgeTrash(30)) { docs.unload(id); store.unindexDoc(id) } store.purgeAudit(365); store.purgeMemorySignals(60) }
purge()
setInterval(purge, 12 * 3600_000).unref()
// 内存优化：空闲文档自动驱逐（每 5 分钟检查一次，驱逐无活跃连接且超过 10 分钟未被访问的文档，防长期运行内存泄漏）
setInterval(() => docs.evictIdle(), 5 * 60_000).unref()
// 定时整理记忆：每 6 小时看一次，有 3 条以上新信号、且距上次整理超过一天的用户整理一次（MEMORY_AUTO_REVIEW=0 关闭）
if (evolution.available() && process.env.MEMORY_AUTO_REVIEW !== '0') {
  setInterval(() => void (async () => {
    for (const owner of store.usersWithMemorySignals(3)) {
      const last = store.getUserSetting(owner, 'memory_review_at')
      if (!memory.active(owner) || (last && Date.now() - Date.parse(last) < 86_400_000)) continue
      await evolution.review(owner, { force: false }).catch(err => console.error('[memory-review]', owner, (err as Error).message))
    }
  })(), 6 * 3600_000).unref()
}
const mail = new MailService(store, mailer, {
  domain: config.mailDomain,
  complete: makeComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.model }),
})
const calendar = new CalendarService(store, mail)
const app = buildApi({ docs, ops, turns, postcheck, crossref, pubmed, openalex, renderer, accounts, devMode: config.devMode, devUser: config.devUser, search, kb, memory, evolution, datasets, patients, shares, studies, cohort, images, access, mail, calendar, pdfOcr: reportOcr, docParser, workspaceDir: userId => pool.workspaceDir(userId) })
// MCP 的管理类工具以用户身份进程内调用同一个 HTTP 应用（AI 的权限 = 用户的权限，见 http/invoke.ts）
;(mcpDeps as { invoke?: Invoke }).invoke = makeInvoker(app)

// 页面：web/ 的构建产物（pnpm --filter @heurion2/platform build）；开发时用 vite（dev:web）
const DIST = fileURLToPath(new URL('../dist-web/', import.meta.url))
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
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
// 带图模板的照片（模板选择器的缩略图用；Unsplash 授权，公开）
app.get('/theme-photos/:id', c => {
  const p = themePhoto(basename(c.req.param('id')).replace(/\.jpg$/, ''))
  return p ? c.body(Buffer.from(p.bytes), 200, { 'Content-Type': p.mime, 'Cache-Control': 'public, max-age=86400' }) : c.notFound()
})
app.get('/app', c => existsSync(join(DIST, 'index.html'))
  ? c.html(readFileSync(join(DIST, 'index.html'), 'utf8'))
  : c.text('页面未构建：运行 pnpm --filter @heurion2/platform build，或用 dev:web 开发服务器（http://127.0.0.1:5173）', 503))
app.get('/app/', c => c.redirect('/app'))
// 知家（患者个人应用 V0，docs/design/PATIENT.md）：家庭健康顾问的移动 Web 外壳
app.get('/phr', c => existsSync(join(DIST, 'phr.html'))
  ? c.html(readFileSync(join(DIST, 'phr.html'), 'utf8'))
  : c.text('页面未构建：运行 pnpm --filter @heurion2/platform build，或用 dev:web 开发服务器（http://127.0.0.1:5173/phr.html）', 503))
app.get('/phr.html', c => c.redirect('/phr'))
// 官网：apps/site 的静态页（不用构建）；工作台在 /app
const SITE = fileURLToPath(new URL('../../site/', import.meta.url))
app.get('/', c => c.html(readFileSync(join(SITE, 'index.html'), 'utf8')))
app.get('/en', c => c.html(readFileSync(join(SITE, 'index.html'), 'utf8')))
app.get('/en/', c => c.redirect('/en'))
app.get('/robots.txt', c => {
  const file = join(SITE, 'robots.txt')
  return existsSync(file) ? c.body(readFileSync(file), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }) : c.notFound()
})
app.get('/llms.txt', c => {
  const file = join(SITE, 'llms.txt')
  return existsSync(file) ? c.body(readFileSync(file), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }) : c.notFound()
})
app.get('/llms-full.txt', c => {
  const file = join(SITE, 'llms-full.txt')
  return existsSync(file) ? c.body(readFileSync(file), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }) : c.notFound()
})
app.get('/sitemap.xml', c => {
  const file = join(SITE, 'sitemap.xml')
  return existsSync(file) ? c.body(readFileSync(file), 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }) : c.notFound()
})
app.get('/site/:file', c => {
  const file = join(SITE, basename(c.req.param('file')))
  if (!existsSync(file) || !MIME[extname(file)]) return c.notFound()
  return c.body(readFileSync(file), 200, { 'Content-Type': MIME[extname(file)]!, 'Cache-Control': 'public, max-age=300' })
})
const api = getRequestListener(app.fetch)

// /mcp 用 Node 原生 req/res（MCP SDK transport 需要），其余交给 Hono
const server = createServer((req, res) => {
  if (req.url?.startsWith(LLM_PREFIX + '/')) {
    handleLlmProxy({ secret: config.secret, upstream: config.llmUpstream, apiKey: config.deepseekApiKey, isLive: (u, s) => pool.isLive(u, s) }, req, res).catch(err => {
      console.error('[llm-proxy]', err)
      if (!res.headersSent) res.writeHead(502).end()
    })
    return
  }
  if (req.url?.startsWith('/mcp')) {
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
