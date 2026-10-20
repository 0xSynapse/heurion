import { OrgTemplateService } from '../auth/org-templates.ts'
import { ORG_BASES, orgLogo, PRESET_AHSLYY, setOrgTenantResolver, themeAllowed, themeKeysFor } from '../model/org-templates.ts'
import { Hono, type Context } from 'hono'
import { H_AS, internalVia, makeInvoker, type Invoke, type ViaInfo } from './invoke.ts'
import { CONFIRM_ROUTES } from '../mcp/admin-tools.ts'
import { Transform } from 'prosemirror-transform'
import { streamSSE } from 'hono/streaming'
import { getConnInfo } from '@hono/node-server/conninfo'
import { AuthError, type Accounts } from '../auth/accounts.ts'
import { duplicateDoc } from '../model/duplicate.ts'
import type { SearchIndex } from '../model/search-index.ts'
import { ExtractError, extractText } from '../kb/extract.ts'
import type { KbService } from '../kb/service.ts'
import type { DatasetService } from '../datasets/service.ts'
import { TenantError, TenantService } from '../auth/tenants.ts'
import type { StudyService } from '../research/service.ts'
import { PatientError, type PatientService } from '../tenancy/patients.ts'
import { ShareService } from '../tenancy/shares.ts'
import { PatientClaimService } from '../tenancy/claims.ts'
import { scanPhi, redactPhi } from '../ops/phi-scan.ts'
import type { CohortService } from '../research/cohort.ts'
import { registerImagingRoutes } from './routes/imaging.ts'
import { registerMailCalendarRoutes } from './routes/mail-calendar.ts'
import { registerResearchRoutes } from './routes/research.ts'
import { registerPublicToolsApi } from './routes/public-tools-api.ts'
import type { MemoryEvolution } from '../memory/evolve.ts'
import { MemoryError, type MemoryService } from '../memory/service.ts'
import type { Notice, PostCheck } from '../collab/postcheck.ts'
import { verifyPrompt } from '../claims/service.ts'
import { docxFor, pptxFor } from '../convert/exports.ts'
import { bindDeckAssets, importPptx, PptxImportError } from '../convert/pptx-import.ts'
import { pptxTemplate } from '../convert/pptx-template.ts'
import { exportFontsParam, withFonts } from '../convert/fonts.ts'
import { templateCatalog } from '../model/deck-templates.ts'
import { DECK_THEMES, DEFAULT_THEME } from '../model/deck-themes.ts'
import { newTemplateDeck } from '../ops/deck.ts'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SlideRenderer } from '../render/slides.ts'
import type { CrossrefClient } from '../literature/crossref.ts'
import { importReferences, parseReferences } from '../literature/import-refs.ts'
import type { PubMedClient } from '../literature/pubmed.ts'
import { formatAma, formatCitation, normalizeDoi } from '../literature/format.ts'
import type { Article } from '../literature/types.ts'
import type { OpenAlexClient } from '../literature/openalex.ts'
import { newCommentId, type DocRow } from '../store/db.ts'
import { bindAssets, bindComments, DocxImportError, importDocx } from '../convert/docx-import.ts'
import type { DocParser } from '../convert/doc-parser.ts'
import { importPdf, PdfImportError } from '../convert/pdf-import.ts'
import type { Ocr } from '../kb/ocr.ts'
import { AnchorError, attachComment, locate, threadMarks } from '../model/anchors.ts'
import { parseBlocks } from '../model/markdown.ts'
import type { CommitEvent, Documents } from '../model/runtime.ts'
import { schema } from '../model/schema.ts'
import type { OpService } from '../ops/service.ts'
import { pendingGroups, resolveSuggestions, withoutPending } from '../ops/suggest.ts'
import { EditBatch, OpError } from '../ops/types.ts'
import { DeckEditBatch } from '../ops/deck.ts'
import { commentPrompt, wantsAi, phrBriefPrompt, type TurnBusEvent, type TurnOptions, type TurnService } from '../turns/service.ts'
import { referencePlan } from '../model/references.ts'
import { diff, read, ReadError } from '../views/read.ts'
import { deckRead } from '../views/deck.ts'
import { exportMarkdown, renderHtml } from '../views/render.ts'
import { themePhoto } from '../model/theme-photos.ts'
import { Access, allows, type Level } from '../research/access.ts'
import type { ImageService } from '../images/service.ts'
import { UnsplashError } from '../images/unsplash.ts'
import { MailService } from '../mail/service.ts'
import { CalendarService } from '../calendar/service.ts'

export interface ApiDeps {
  docs: Documents
  ops: OpService
  turns: TurnService
  postcheck: PostCheck
  crossref: CrossrefClient
  /** 参考文献导入时给只有 PMID 的条目补 DOI（可选）。 */
  pubmed?: PubMedClient
  /** OpenAlex 学术文献搜索与元数据解析（可选）。 */
  openalex?: OpenAlexClient
  renderer: SlideRenderer
  accounts: Accounts
  /** 开发模式：允许把开发用户的数据转给正式账户。 */
  devMode: boolean
  /** 全文索引（改名、复制后立即更新）。 */
  search?: SearchIndex
  /** 参考资料库。 */
  kb?: KbService
  memory?: MemoryService
  /** 记忆演进（整理建议）；没有模型 key 时不可用。 */
  evolution?: MemoryEvolution
  /** 数据集（实验室数据分析）。 */
  datasets?: DatasetService
  /** 患者（按机构分库，见 docs/design/TENANCY.md）。 */
  patients?: PatientService
  /** 临床研究项目。 */
  studies?: StudyService
  /** 研究入组与研究数据集（不给时由 studies + patients 组装）。 */
  cohort?: CohortService
  /** 用户的 AI 工作区（对话里贴的图片放这里，AI 用 read_image 看）。 */
  workspaceDir?: (userId: string) => string
  /** Unsplash 图库（幻灯片搜图插图）；服务器没配 key 时 configured=false。 */
  images?: ImageService
  /** 知家分享给医生（不给时由 patients 组装）。 */
  shares?: ShareService
  /** 机构认领码与患者绑定（不给时由 patients 组装）。 */
  claims_patient?: PatientClaimService
  /** 访问判定（研究团队协作）；不给时按 store 新建一个。 */
  access?: Access
  /** 邮件工作流服务。 */
  mail?: MailService
  /** PDF 导入时给扫描页做 OCR（kb/ocr.ts）；不给时扫描页退回整页图片。 */
  pdfOcr?: Ocr
  /** PDF 导入主路径：本地 doc-parser 服务（Docling）；不给或不可用时退回 poppler */
  docParser?: DocParser | null
  /** 日历与排期服务。 */
  calendar?: CalendarService
  devUser: string
}

/**
 * 给 web 前端的 REST + SSE。用户写入（编辑、评论锚点、回滚）以 actor=user 进入同一操作层，
 * 不受 AI 守卫阻挡（PLATFORM.md §5.3）。
 */
export function buildApi(deps: ApiDeps): Hono<{ Variables: { user: string } }> {
  const { docs, ops, turns } = deps
  const store = docs.store
  const tenants = new TenantService(store, { devMode: deps.devMode })
  // 访问判定（研究团队协作，research/access.ts）：文档、数据集、资产谁能看谁能改都问它
  const access = deps.access ?? new Access(store)
  access.docText ??= (id: string) => JSON.stringify(docs.get(id).toJSON())
  if (deps.datasets && !deps.datasets.access) deps.datasets.access = access
  if (deps.images && !deps.images.access) deps.images.access = access
  const tenantFailure = (c: Context, err: unknown) => {
    if (err instanceof TenantError) return c.json({ error: err.message, code: err.code }, err.status)
    throw err
  }
  // 机构幻灯片模板：运行时登记按调用者机构过滤（MCP 也用同一份登记）
  const orgTemplates = new OrgTemplateService(store, tenants)
  setOrgTenantResolver(uid => tenants.of(uid).id)
  orgTemplates.loadAll()
  const mail = deps.mail ?? new MailService(store)
  const calendar = deps.calendar ?? new CalendarService(store, mail)
  const app = new Hono<{ Variables: { user: string } }>()
  app.onError((err, c) => {
    const anyErr = err as any
    if (anyErr && typeof anyErr.status === 'number' && typeof anyErr.code === 'string') {
      return c.json({ error: anyErr.message, message: anyErr.message, code: anyErr.code }, anyErr.status as any)
    }
    console.error('[api.onError]', err)
    return c.json({ error: 'internal_error', message: err?.message || '服务器内部错误' }, 500)
  })
  /** 进程内 AI 调用的来源（审计写 via / confirmed_by；患者操作按来源走审核门） */
  const viaByReq = new WeakMap<Request, ViaInfo>()
  const invoke: Invoke = makeInvoker(app)
  // 健康检查（部署脚本、容器 healthcheck、反向代理用）：数据库可读即健康；嵌入服务状态只报告不影响结果
  app.get('/healthz', async c => {
    store.db.prepare('SELECT 1').get()
    return c.json({ ok: true, vector: deps.kb ? (await deps.kb.status()).vector : false })
  })

  const { accounts } = deps
  const requestToken = (c: Context) => {
    const header = c.req.header('authorization')
    return header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token')
  }
  /**
   * 客户端 IP：生产里请求都经 Caddy 转发，直连方是内网 / 本机地址时取 Caddy 写的 X-Real-IP
   * （否则所有人共用一个 IP——登录限流变成全站共用、审计记不到真实来源）。直连公网地址时不信任这个头。
   */
  const clientIp = (c: Context) => {
    let remote = 'unknown'
    try { remote = getConnInfo(c).remote.address ?? 'unknown' } catch { /* 测试环境没有连接信息 */ }
    const forwarded = c.req.header('x-real-ip')?.trim()
    const viaProxy = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01]))\.|fc|fd)/i.test(remote)
    return forwarded && viaProxy ? forwarded : remote
  }
  /** 审计：谁、什么时候、从哪里、对什么做了什么（M2；管理员在「用户管理 → 审计日志」查看）。 */
  const audit = (c: Context, action: string, e: { actor?: string | null; target?: string | null; detail?: string | null; status?: number } = {}) => {
    try {
      const v = viaByReq.get(c.req.raw)
      store.addAudit({ actor: e.actor !== undefined ? e.actor : (c.get('user') as string | undefined) ?? null, action, target: e.target ?? null, detail: e.detail ?? null, ip: v ? 'ai' : clientIp(c), status: e.status ?? null, via: v?.via ?? null, confirmed_by: v?.confirmedBy ?? null })
    } catch (err) { console.error('[audit]', err) }
  }
  const AUDITED: Array<{ method: string; re: RegExp; action: string }> = [
    { method: 'GET', re: /^\/api\/docs\/[^/]+\/export\.(docx|pptx|md)$/, action: 'doc.export' },
    { method: 'DELETE', re: /^\/api\/docs\/[^/]+$/, action: 'doc.trash' },
    { method: 'POST', re: /^\/api\/docs\/[^/]+\/slides\/[^/]+\/photo$/, action: 'deck.add_photo' },
    { method: 'DELETE', re: /^\/api\/docs\/[^/]+\/purge$/, action: 'doc.purge' },
    { method: 'POST', re: /^\/api\/docs\/[^/]+\/restore$/, action: 'doc.restore' },
    { method: 'DELETE', re: /^\/api\/projects\/[^/]+$/, action: 'project.delete' },
    { method: 'GET', re: /^\/api\/kb\/[^/]+\/file$/, action: 'kb.download' },
    { method: 'DELETE', re: /^\/api\/kb\/[^/]+$/, action: 'kb.delete' },
    { method: 'DELETE', re: /^\/api\/memory$/, action: 'memory.clear' },
    { method: 'GET', re: /^\/api\/memory-export$/, action: 'memory.export' },
    { method: 'POST', re: /^\/api\/memory-import$/, action: 'memory.import' },
    { method: 'POST', re: /^\/api\/datasets$/, action: 'dataset.upload' },
    { method: 'DELETE', re: /^\/api\/studies\/[^/]+$/, action: 'study.delete' },
    { method: 'POST', re: /^\/api\/studies\/[^/]+\/members$/, action: 'study.member_add' },
    { method: 'PATCH', re: /^\/api\/studies\/[^/]+\/members\/[^/]+$/, action: 'study.member_role' },
    { method: 'DELETE', re: /^\/api\/studies\/[^/]+\/members\/[^/]+$/, action: 'study.member_remove' },
    { method: 'POST', re: /^\/api\/studies\/[^/]+\/transfer$/, action: 'study.transfer' },
    { method: 'POST', re: /^\/api\/studies\/[^/]+\/handover$/, action: 'study.handover' },
    { method: 'POST', re: /^\/api\/studies\/[^/]+\/cohort$/, action: 'study.enroll' },
    { method: 'DELETE', re: /^\/api\/studies\/[^/]+\/cohort\/[^/]+$/, action: 'study.unenroll' },
    { method: 'POST', re: /^\/api\/studies\/[^/]+\/cohort\/dataset$/, action: 'study.cohort_dataset' },
    { method: 'PATCH', re: /^\/api\/tenant$/, action: 'tenant.update' },
    { method: 'POST', re: /^\/api\/patients$/, action: 'patient.create' },
    { method: 'POST', re: /^\/api\/tenant\/departments$/, action: 'tenant.department_create' },
    { method: 'PATCH', re: /^\/api\/tenant\/departments\/[^/]+$/, action: 'tenant.department_rename' },
    { method: 'DELETE', re: /^\/api\/tenant\/departments\/[^/]+$/, action: 'tenant.department_delete' },
    { method: 'PUT', re: /^\/api\/tenant\/departments\/[^/]+\/members$/, action: 'tenant.department_members' },
    { method: 'POST', re: /^\/api\/phr\/[^/]+\/shares$/, action: 'phr.share_create' },
    { method: 'DELETE', re: /^\/api\/phr\/shares\/[^/]+$/, action: 'phr.share_revoke' },
    { method: 'POST', re: /^\/api\/shares\/[^/]+\/import$/, action: 'share.import' },
    { method: 'GET', re: /^\/api\/shares\/[^/]+\/files\/[^/]+$/, action: 'share.file_download' },
    { method: 'POST', re: /^\/api\/phr\/[^/]+\/archive$/, action: 'phr.archive_doc' },
    { method: 'POST', re: /^\/api\/phr\/[^/]+\/brief$/, action: 'phr.brief' },
    { method: 'POST', re: /^\/api\/patients\/[^/]+\/labs$/, action: 'patient.lab_add' },
    { method: 'DELETE', re: /^\/api\/patients\/[^/]+$/, action: 'patient.delete' },
    { method: 'GET', re: /^\/api\/patients\/[^/]+\/files\/[^/]+$/, action: 'patient.file_download' },
    { method: 'POST', re: /^\/api\/patients\/[^/]+\/team$/, action: 'patient.team_add' },
    { method: 'DELETE', re: /^\/api\/patients\/[^/]+\/team\/[^/]+$/, action: 'patient.team_remove' },
    { method: 'PATCH', re: /^\/api\/tenant\/members\/[^/]+$/, action: 'tenant.member_update' },
    { method: 'POST', re: /^\/api\/tenant\/invites$/, action: 'tenant.invite' },
    { method: 'POST', re: /^\/api\/me\/invites\/[^/]+\/accept$/, action: 'tenant.join' },
    { method: 'POST', re: /^\/api\/me\/invites\/[^/]+\/decline$/, action: 'tenant.invite_decline' },
    { method: 'POST', re: /^\/api\/tenant\/leave$/, action: 'tenant.leave' },
    { method: 'DELETE', re: /^\/api\/tenant\/members\/[^/]+$/, action: 'tenant.member_remove' },
    { method: 'POST', re: /^\/api\/tenant\/templates$/, action: 'tenant.template_create' },
    { method: 'PATCH', re: /^\/api\/tenant\/templates\/[^/]+$/, action: 'tenant.template_update' },
    { method: 'DELETE', re: /^\/api\/tenant\/templates\/[^/]+$/, action: 'tenant.template_delete' },
    { method: 'PUT', re: /^\/api\/tenant\/templates\/[^/]+\/logo$/, action: 'tenant.template_logo' },
    { method: 'DELETE', re: /^\/api\/tenant\/templates\/[^/]+\/logo$/, action: 'tenant.template_logo_clear' },
    { method: 'DELETE', re: /^\/api\/tenant\/invites\/[^/]+$/, action: 'tenant.invite_revoke' },
    { method: 'POST', re: /^\/api\/platform\/tenants$/, action: 'platform.tenant_create' },
    { method: 'PATCH', re: /^\/api\/platform\/tenants\/[^/]+$/, action: 'platform.tenant_status' },
    { method: 'POST', re: /^\/api\/datasets\/[^/]+\/phi$/, action: 'dataset.phi_resolve' },
    { method: 'DELETE', re: /^\/api\/datasets\/[^/]+$/, action: 'dataset.delete' },
    { method: 'PATCH', re: /^\/api\/admin\/users\/[^/]+$/, action: 'admin.user_update' },
    { method: 'POST', re: /^\/api\/admin\/users\/[^/]+\/reset-password$/, action: 'admin.user_reset_password' },
    { method: 'POST', re: /^\/api\/admin\/users\/[^/]+\/logout$/, action: 'admin.user_logout' },
    { method: 'PUT', re: /^\/api\/admin\/settings$/, action: 'admin.settings' },
    { method: 'POST', re: /^\/api\/auth\/logout-everywhere$/, action: 'auth.logout_everywhere' },
    { method: 'PATCH', re: /^\/api\/me$/, action: 'account.update' },
    { method: 'POST', re: /^\/api\/me\/email$/, action: 'account.bind_email' },
  ]
  /** 审计目标：文档记「文档 id《标题》」，资料记文件名，用户记用户名。 */
  // 只有操作者自己的资源才记标题：越权尝试（别人的 id）只记 id——否则别的机构的标题会进到操作者所在机构的审计里
  const auditTarget = (path: string, actor: string | null): string | null => {
    const doc = /^\/api\/docs\/([^/]+)/.exec(path)?.[1]
    if (doc) { const d = store.getDoc(doc); return d && actor && access.docRole(actor, d) ? `文档 ${doc}《${d.title}》` : `文档 ${doc}` }
    const kb = /^\/api\/kb\/([^/]+)/.exec(path)?.[1]
    if (kb) { const f = store.getKbFile(kb); return f && f.owner === actor ? `资料 ${kb}《${f.name}》` : `资料 ${kb}` }
    const user = /^\/api\/admin\/users\/([^/]+)/.exec(path)?.[1]
    if (user) { const u = actor && accounts.isAdmin(actor) ? store.getUser(user) : undefined; return u ? `用户 ${u.username}` : `用户 ${user}` }
    const project = /^\/api\/projects\/([^/]+)/.exec(path)?.[1]
    if (project) { const p = store.getProject(project); return p && p.owner === actor ? `项目《${p.name}》` : `项目 ${project}` }
    const study = /^\/api\/studies\/([^/]+)/.exec(path)?.[1]
    if (study) { const st = store.getStudy(study); return st && actor && store.studyRole(st.id, actor) ? `研究《${st.title}》` : `研究 ${study}` }
    return null
  }
  const authFailure = (c: Context, err: unknown) => {
    if (err instanceof AuthError) return c.json({ error: err.message, code: err.code }, err.status)
    throw err
  }

  // —— 账户（不需要登录） ——
  app.get('/api/auth/config', c => c.json({ has_users: store.countUsers() > 0, dev_mode: deps.devMode }))
  // 防机器人：注册 / 登录前领一道工作量证明题（见 auth/bot-guard.ts）
  app.get('/api/auth/challenge', c => {
    c.header('Cache-Control', 'no-store')
    return c.json(accounts.bots.issue(clientIp(c)))
  })
  /** 邀请链接：注册页显示「加入 XX」。 */
  app.get('/api/invites/:code', c => {
    try { return c.json(tenants.checkInvite(c.req.param('code'))) } catch (err) { return tenantFailure(c, err) }
  })
  app.post('/api/auth/register', async c => {
    const body = await c.req.json().catch(() => ({})) as { username?: string }
    try {
      const r = accounts.register(body as never, clientIp(c))
      audit(c, 'auth.register', { actor: r.user.id, detail: `用户名 ${body.username ?? ''}`, status: 201 })
      return c.json(r, 201)
    } catch (err) {
      if (err instanceof AuthError) audit(c, 'auth.register_failed', { actor: null, detail: `用户名 ${String(body.username ?? '').slice(0, 64)}：${err.code}`, status: err.status })
      return authFailure(c, err)
    }
  })
  // 找回密码：发验证码（不暴露邮箱是否注册）→ 验证码 + 新密码
  app.post('/api/auth/password-code', async c => {
    try {
      return c.json(await accounts.sendResetCode(await c.req.json(), clientIp(c)))
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/auth/reset-password', async c => {
    const body = await c.req.json().catch(() => ({})) as { email?: string }
    try {
      const r = accounts.resetPassword(body as never) as { user?: { id: string } }
      audit(c, 'auth.reset_password', { actor: r.user?.id ?? null, detail: `邮箱 ${String(body.email ?? '').slice(0, 120)}`, status: 200 })
      return c.json(r)
    } catch (err) {
      if (err instanceof AuthError) audit(c, 'auth.reset_password_failed', { actor: null, detail: `邮箱 ${String(body.email ?? '').slice(0, 120)}：${err.code}`, status: err.status })
      return authFailure(c, err)
    }
  })
  app.post('/api/auth/login', async c => {
    const body = await c.req.json().catch(() => ({})) as { username?: string }
    try {
      const r = accounts.login(body as never, clientIp(c))
      audit(c, 'auth.login', { actor: r.user.id, status: 200 })
      return c.json(r)
    } catch (err) {
      // 失败的登录记用户名（不记密码），便于发现撞库
      if (err instanceof AuthError) audit(c, 'auth.login_failed', { actor: null, detail: `用户名 ${String(body.username ?? '').slice(0, 64)}：${err.code}`, status: err.status })
      return authFailure(c, err)
    }
  })

  // —— 免登录临床科研公开小工具接口（无状态、限流） ——
  registerPublicToolsApi(app, { pubmed: deps.pubmed, crossref: deps.crossref })

  // 鉴权：账户令牌（开发模式下也接受开发令牌，见 auth/accounts.ts）。EventSource / <img> 用 ?token=。
  app.use('/api/*', async (c, next) => {
    // 外部来信 Webhook 无需用户 Session；公开微型工具接口无需登录
    if (c.req.path === '/api/mail/inbound' || c.req.path.startsWith('/api/public/tools/')) {
      return next()
    }

    // AI 以用户身份的进程内调用（MCP 管理类工具、确认后执行的操作）：鉴权与权限判定和界面完全一致
    const internal = internalVia(n => c.req.header(n))
    if (internal === 'forged') return c.json({ error: '请先登录', code: 'unauthorized' }, 401)
    let user: string | null
    if (internal) {
      const as = c.req.header(H_AS) ?? ''
      // 开发模式：与 REST 的开发令牌一致，也认开发子用户（<开发用户>:<名字>，e2e 与实验脚本用）
      user = store.getUser(as) || (deps.devMode && (as === deps.devUser || as.startsWith(`${deps.devUser}:`))) ? as : null
      if (user) viaByReq.set(c.req.raw, internal)
    } else user = accounts.userFor(requestToken(c))
    if (!user) return c.json({ error: '请先登录', code: 'unauthorized' }, 401)
    c.set('user', user)
    // 第二道防线：标了「需用户确认」的接口，AI 只能经确认卡执行（via=ai-confirmed），直接调用一律拒绝
    if (internal?.via === 'ai' && CONFIRM_ROUTES.some(r => r.method === c.req.method && r.re.test(c.req.path))) {
      return c.json({ error: '这是高风险操作，需要用户在确认卡上确认后才能执行', code: 'confirmation_required' }, 403)
    }
    // 审计：按「方法 + 路径」记敏感操作（导出、删除、管理员操作……），目标的标题在操作前取（彻底删除后就查不到了）
    const rule = AUDITED.find(r => r.method === c.req.method && r.re.test(c.req.path))
    const target = rule ? auditTarget(c.req.path, c.get('user') ?? null) : null
    await next()
    if (rule) audit(c, rule.action, { target, status: c.res.status })
    // AI 做的每一次写操作都进审计（读操作按上面的规则记）
    else if (internal && c.req.method !== 'GET') audit(c, 'ai.call', { detail: `${c.req.method} ${c.req.path}`, target: auditTarget(c.req.path, user), status: c.res.status })
  })

  app.get('/api/me', c => {
    let tenant = null
    try { tenant = tenants.view(c.get('user')) } catch { /* 没有机构的账户（不应出现） */ }
    return c.json({ ...accounts.me(c.get('user')), dev_mode: deps.devMode, tenant })
  })

  // —— 机构（租户）：机构管理员管成员、邀请、设置、本机构审计 ——
  app.get('/api/tenant', c => {
    try { return c.json(tenants.view(c.get('user'))) } catch (err) { return tenantFailure(c, err) }
  })
  app.patch('/api/tenant', async c => {
    try { return c.json(tenants.update(c.get('user'), await c.req.json())) } catch (err) { return tenantFailure(c, err) }
  })
  app.get('/api/tenant/members', c => {
    try { return c.json(tenants.members(c.get('user'))) } catch (err) { return tenantFailure(c, err) }
  })
  app.patch('/api/tenant/members/:uid', async c => {
    try { return c.json(tenants.setMember(c.get('user'), c.req.param('uid'), await c.req.json())) } catch (err) { return tenantFailure(c, err) }
  })
  app.get('/api/tenant/invites', c => {
    try { return c.json(tenants.invites(c.get('user'))) } catch (err) { return tenantFailure(c, err) }
  })
  app.post('/api/tenant/invites', async c => {
    try {
      const body = await c.req.json<{ username?: unknown; role?: unknown; email?: unknown; days?: unknown }>()
      // 带 username = 按用户名邀请已有账户（对方登录后接受）；否则是邀请链接
      return c.json(body.username !== undefined ? tenants.inviteUser(c.get('user'), body) : tenants.invite(c.get('user'), body), 201)
    } catch (err) { return tenantFailure(c, err) }
  })
  app.delete('/api/tenant/members/:uid', c => {
    try { tenants.removeMember(c.get('user'), c.req.param('uid')); return c.json({ ok: true }) } catch (err) { return tenantFailure(c, err) }
  })
  /** 本人退出医院：工作空间回到个人空间（知家不受影响）。 */
  app.post('/api/tenant/leave', c => {
    try { return c.json(tenants.leave(c.get('user'))) } catch (err) { return tenantFailure(c, err) }
  })
  // —— 发给我的邀请（已有账户加入医院；本人接受 / 拒绝）——
  app.get('/api/me/invites', c => c.json(tenants.myInvites(c.get('user'))))
  app.get('/api/me/invites/:code', c => {
    try { return c.json(tenants.inviteFor(c.get('user'), c.req.param('code'))) } catch (err) { return tenantFailure(c, err) }
  })
  app.post('/api/me/invites/:code/accept', c => {
    try { return c.json(tenants.accept(c.get('user'), c.req.param('code'))) } catch (err) { return tenantFailure(c, err) }
  })
  app.post('/api/me/invites/:code/decline', c => {
    try { tenants.decline(c.get('user'), c.req.param('code')); return c.json({ ok: true }) } catch (err) { return tenantFailure(c, err) }
  })
  app.delete('/api/tenant/invites/:code', c => {
    try { tenants.revokeInvite(c.get('user'), c.req.param('code')); return c.json({ ok: true }) } catch (err) { return tenantFailure(c, err) }
  })
  // 科室（知家分享的落点；管理员增删改、分配成员，成员可看）
  app.get('/api/tenant/departments', c => {
    try { return c.json(tenants.departments(c.get('user'))) } catch (err) { return tenantFailure(c, err) }
  })
  app.post('/api/tenant/departments', async c => {
    try { return c.json(tenants.createDepartment(c.get('user'), (await c.req.json<{ name?: unknown }>()).name), 201) } catch (err) { return tenantFailure(c, err) }
  })
  app.patch('/api/tenant/departments/:dpid', async c => {
    try { return c.json(tenants.renameDepartment(c.get('user'), c.req.param('dpid'), (await c.req.json<{ name?: unknown }>()).name)) } catch (err) { return tenantFailure(c, err) }
  })
  app.delete('/api/tenant/departments/:dpid', c => {
    try { tenants.deleteDepartment(c.get('user'), c.req.param('dpid')); return c.json({ ok: true }) } catch (err) { return tenantFailure(c, err) }
  })
  app.put('/api/tenant/departments/:dpid/members', async c => {
    try { return c.json(tenants.setDepartmentMembers(c.get('user'), c.req.param('dpid'), (await c.req.json<{ user_ids?: unknown }>()).user_ids)) } catch (err) { return tenantFailure(c, err) }
  })
  // 机构幻灯片模板（管理员增删改、上传院徽；成员可看列表）
  app.get('/api/tenant/templates', c => {
    try { return c.json({ templates: orgTemplates.list(c.get('user')), bases: ORG_BASES.map(k => ({ key: k, label: DECK_THEMES[k]!.label })), presets: [PRESET_AHSLYY] }) } catch (err) { return tenantFailure(c, err) }
  })
  app.post('/api/tenant/templates', async c => {
    try { return c.json(orgTemplates.create(c.get('user'), await c.req.json()), 201) } catch (err) { return tenantFailure(c, err) }
  })
  app.patch('/api/tenant/templates/:otid', async c => {
    try { return c.json(orgTemplates.update(c.get('user'), c.req.param('otid'), await c.req.json())) } catch (err) { return tenantFailure(c, err) }
  })
  app.delete('/api/tenant/templates/:otid', c => {
    try { orgTemplates.remove(c.get('user'), c.req.param('otid')); return c.json({ ok: true }) } catch (err) { return tenantFailure(c, err) }
  })
  app.put('/api/tenant/templates/:otid/logo', async c => {
    try {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      return c.json(orgTemplates.setLogo(c.get('user'), c.req.param('otid'), bytes, c.req.header('content-type') ?? ''))
    } catch (err) { return tenantFailure(c, err) }
  })
  app.delete('/api/tenant/templates/:otid/logo', c => {
    try { return c.json(orgTemplates.clearLogo(c.get('user'), c.req.param('otid'))) } catch (err) { return tenantFailure(c, err) }
  })
  app.get('/api/tenant/audit', c => {
    try {
      const t = tenants.of(c.get('user'))
      if (tenants.roleOf(c.get('user')) !== 'admin') return c.json({ error: '只有机构管理员能看审计' }, 403)
      const actorName = c.req.query('actor')?.trim()
      const actor = actorName ? store.getUserByName(actorName)?.id ?? actorName : undefined
      const rows = store.listAudit({ tenant: t.id, actor, action: c.req.query('action') || undefined, before: Number(c.req.query('before')) || undefined, limit: Number(c.req.query('limit')) || 100 })
      return c.json(rows.map(r => ({ ...r, actor_name: r.actor ? store.getUser(r.actor)?.username ?? r.actor : null })))
    } catch (err) { return tenantFailure(c, err) }
  })

  /** 同机构的同事（诊疗组选人用；只给名字）。 */
  app.get('/api/tenant/colleagues', c => {
    try {
      const t = tenants.of(c.get('user'))
      return c.json(store.tenantMembers(t.id).filter(u => u.status === 'active').map(u => ({ id: u.id, display_name: u.display_name, username: u.username })))
    } catch (err) { return tenantFailure(c, err) }
  })

  // —— 患者（第二期）：机构分库、诊疗组、紧急访问；AI 只能提议 ——
  const patientFailure = (c: Context, err: unknown) => {
    if (err instanceof PatientError) return c.json({ error: err.message, code: err.code }, err.status)
    if (err instanceof TenantError) return c.json({ error: err.message, code: err.code }, err.status)
    throw err
  }
  // 患者操作的来源：AI 直接调用按 AI 算（受「AI 写入需确认」等规则约束）；AI 发起、用户确认后执行的按用户本人算
  // 空间：/api/phr/* 一律是知家（个人空间）；知家调用通用患者接口时带 X-Heurion-Space: personal；其余是工作台（工作空间）
  const me = (c: Context<{ Variables: { user: string } }>) => ({
    userId: c.get('user'), via: viaByReq.get(c.req.raw)?.via === 'ai' ? 'ai' as const : 'user' as const,
    space: c.req.path.startsWith('/api/phr/') || c.req.header('x-heurion-space') === 'personal' ? 'personal' as const : 'work' as const,
  })
  const pt = (c: Context<{ Variables: { user: string } }>) => {
    if (!deps.patients) throw new PatientError('patient_module_off', '患者模块未启用', 403)
    return deps.patients
  }
  app.get('/api/patients', c => { try { return c.json(pt(c).list(me(c))) } catch (err) { return patientFailure(c, err) } })
  app.post('/api/patients', async c => { try { return c.json(pt(c).create(me(c), await c.req.json()), 201) } catch (err) { return patientFailure(c, err) } })
  app.get('/api/patients-directory', c => { try { return c.json(pt(c).directory(me(c))) } catch (err) { return patientFailure(c, err) } })
  app.get('/api/patients/:ptid', c => { try { return c.json(pt(c).read(me(c), c.req.param('ptid'))) } catch (err) { return patientFailure(c, err) } })
  app.patch('/api/patients/:ptid', async c => { try { return c.json(pt(c).update(me(c), c.req.param('ptid'), await c.req.json())) } catch (err) { return patientFailure(c, err) } })
  app.delete('/api/patients/:ptid', c => { try { pt(c).remove(me(c), c.req.param('ptid')); return c.json({ ok: true }) } catch (err) { return patientFailure(c, err) } })
  app.post('/api/patients/:ptid/team', async c => {
    try { pt(c).addMember(me(c), c.req.param('ptid'), String((await c.req.json<{ user_id?: string }>()).user_id ?? '')); return c.json({ ok: true }) } catch (err) { return patientFailure(c, err) }
  })
  app.delete('/api/patients/:ptid/team/:uid', c => { try { pt(c).removeMember(me(c), c.req.param('ptid'), c.req.param('uid')); return c.json({ ok: true }) } catch (err) { return patientFailure(c, err) } })
  app.post('/api/patients/:ptid/break-glass', async c => {
    try { return c.json(pt(c).breakGlass(me(c), c.req.param('ptid'), (await c.req.json<{ reason?: string }>()).reason)) } catch (err) { return patientFailure(c, err) }
  })
  app.get('/api/patients/:ptid/access-log', c => { try { return c.json(pt(c).accessLog(me(c), c.req.param('ptid'))) } catch (err) { return patientFailure(c, err) } })
  app.get('/api/patients/:ptid/labs', c => {
    try {
      const tests = c.req.query('tests')?.split(',').map(x => x.trim()).filter(Boolean)
      return c.json(pt(c).labs(me(c), c.req.param('ptid'), { tests, from: c.req.query('from'), to: c.req.query('to'), includePending: c.req.query('pending') === '1' }))
    } catch (err) { return patientFailure(c, err) }
  })
  /** 手动录入一项化验（知家：家人自己填的数值直接为已确认；只对个人空间开放，医院端一律来自上传报告；AI 不能用）。 */
  app.post('/api/patients/:ptid/labs', async c => {
    try {
      pt(c).requirePersonal(me(c))
      return c.json(pt(c).addLab(me(c), c.req.param('ptid'), await c.req.json()), 201)
    } catch (err) { return patientFailure(c, err) }
  })
  app.post('/api/patients/:ptid/labs/:lid/:action{confirm|reject}', c => {
    try { pt(c).setLabStatus(me(c), c.req.param('ptid'), c.req.param('lid'), c.req.param('action') === 'confirm' ? 'confirmed' : 'rejected'); return c.json({ ok: true }) } catch (err) { return patientFailure(c, err) }
  })
  app.post('/api/patients/:ptid/files', async c => {
    try {
      const form = await c.req.parseBody()
      const file = form.file instanceof File ? form.file : null
      if (!file) return c.json({ error: '请选择文件' }, 400)
      return c.json(pt(c).addFile(me(c), c.req.param('ptid'), {
        name: file.name, mime: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()),
        kind: typeof form.kind === 'string' ? form.kind as never : undefined, report_date: typeof form.report_date === 'string' ? form.report_date : null, title: typeof form.title === 'string' ? form.title : undefined,
      }), 201)
    } catch (err) { return patientFailure(c, err) }
  })
  app.get('/api/patients/:ptid/files/:pfid', c => {
    try {
      const f = pt(c).file(me(c), c.req.param('ptid'), c.req.param('pfid'))
      return c.body(new Uint8Array(f.bytes), 200, { 'Content-Type': f.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'no-store' })
    } catch (err) { return patientFailure(c, err) }
  })
  /** 关联文档（「写病例报告」新建的文档关联到患者，患者页列出历次报告）。 */
  app.post('/api/patients/:ptid/docs', async c => {
    try {
      const body = await c.req.json<{ doc_id?: string; kind?: string }>()
      pt(c).linkDoc(me(c), c.req.param('ptid'), String(body.doc_id ?? ''), body.kind)
      return c.json({ ok: true }, 201)
    } catch (err) { return patientFailure(c, err) }
  })
  app.delete('/api/patients/:ptid/docs/:id', c => { try { pt(c).unlinkDoc(me(c), c.req.param('ptid'), c.req.param('id')); return c.json({ ok: true }) } catch (err) { return patientFailure(c, err) } })

  // —— MONAI 医学影像微服务与患者影像量化分析 ——
  registerImagingRoutes(app, { store, docs, access, audit, me, pt, patientFailure })

  // —— 知家分享给医生（docs/design/SHARING.md）——
  const shares = deps.shares ?? (deps.patients ? new ShareService(store, tenants, deps.patients, docs) : null)
  const sh = () => {
    if (!shares) throw new PatientError('patient_module_off', '患者模块未启用', 403)
    return shares
  }
  const claims = deps.claims_patient ?? (deps.patients ? new PatientClaimService(store, tenants, deps.patients) : null)
  const clm = () => {
    if (!claims) throw new PatientError('patient_module_off', '患者模块未启用', 403)
    return claims
  }
  /** 家人一侧：可分享的医院 → 科室 → 医生；某成员的分享（有效 / 撤销 / 过期 / 纳入）；新建；撤销。 */
  app.get('/api/phr/directory', c => { try { return c.json(sh().directory()) } catch (err) { return patientFailure(c, err) } })
  app.get('/api/phr/:ptid/shares', c => { try { return c.json(sh().listForPatient(me(c), c.req.param('ptid'))) } catch (err) { return patientFailure(c, err) } })
  app.post('/api/phr/:ptid/shares', async c => { try { return c.json(sh().create(me(c), c.req.param('ptid'), await c.req.json()), 201) } catch (err) { return patientFailure(c, err) } })
  app.delete('/api/phr/shares/:shid', c => { try { sh().revoke(me(c), c.req.param('shid')); return c.json({ ok: true }) } catch (err) { return patientFailure(c, err) } })
  /** 医生一侧：收到的分享（只读实时视图）、化验、报告原件、简报 / 健康档案、原件图片、纳入本院。 */
  app.get('/api/shares', c => { try { return c.json(sh().inbox(me(c))) } catch (err) { return patientFailure(c, err) } })
  app.get('/api/shares/:shid', c => { try { return c.json(sh().read(me(c), c.req.param('shid'))) } catch (err) { return patientFailure(c, err) } })
  app.get('/api/shares/:shid/labs', c => {
    try { return c.json(sh().labs(me(c), c.req.param('shid'), c.req.query('tests')?.split(',').filter(Boolean))) } catch (err) { return patientFailure(c, err) }
  })
  app.get('/api/shares/:shid/files/:pfid', c => {
    try {
      const f = sh().file(me(c), c.req.param('shid'), c.req.param('pfid'))
      return c.body(new Uint8Array(f.bytes), 200, { 'Content-Type': f.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'no-store' })
    } catch (err) { return patientFailure(c, err) }
  })
  app.get('/api/shares/:shid/assets/:aid', c => {
    try {
      const { asset, bytes } = sh().asset(me(c), c.req.param('shid'), c.req.param('aid'))
      return c.body(Buffer.from(bytes), 200, { 'Content-Type': asset.mime, 'Cache-Control': 'private, no-cache' })
    } catch (err) { return patientFailure(c, err) }
  })
  app.get('/api/shares/:shid/docs/:id', c => {
    try {
      const shid = c.req.param('shid')
      const d = sh().doc(me(c), shid, c.req.param('id'))
      const token = requestToken(c) ?? ''
      const shareAssetUrl = (aid: string) => `/api/shares/${encodeURIComponent(shid)}/assets/${encodeURIComponent(aid)}?token=${encodeURIComponent(token)}`
      return c.json({ doc_id: d.doc_id, kind: d.kind, title: d.title, updated_at: d.updated_at, html: renderHtml(d.node, store.listCitations(d.doc_id), shareAssetUrl) })
    } catch (err) { return patientFailure(c, err) }
  })
  app.post('/api/shares/:shid/import', c => { try { return c.json(sh().import(me(c), c.req.param('shid')), 201) } catch (err) { return patientFailure(c, err) } })

  // —— 机构患者认领码与家庭成员绑定 (PATIENT.md §4, §8) ——
  /** 医生在机构患者页生成一次性认领码（24h 有效）。 */
  app.post('/api/patients/:ptid/claim_code', c => {
    try { return c.json(clm().createClaimCode(me(c), c.req.param('ptid')), 201) } catch (err) { return patientFailure(c, err) }
  })
  /** 医生查看患者的认领历史和绑定关系。 */
  app.get('/api/patients/:ptid/claims', c => {
    try { return c.json(clm().listPatientClaims(me(c), c.req.param('ptid'))) } catch (err) { return patientFailure(c, err) }
  })
  /** 医生确认认领绑定（防错绑，AI 不能代为确认）。 */
  app.post('/api/claims/:cid/confirm', async c => {
    try {
      const body = await c.req.json<{ birth_year?: number }>().catch(() => ({}))
      return c.json(clm().confirmClaim(me(c), c.req.param('cid'), body))
    } catch (err) { return patientFailure(c, err) }
  })
  /** 撤销认领码或解除绑定。 */
  app.delete('/api/claims/:cid', c => {
    try { return c.json(clm().revokeClaim(me(c), c.req.param('cid'))) } catch (err) { return patientFailure(c, err) }
  })
  /** 家人/患者在知家端输入认领码绑定家庭成员档案。 */
  app.post('/api/phr/:ptid/claim', async c => {
    try {
      const body = await c.req.json<{ code?: string }>()
      if (!body.code) throw new PatientError('missing_code', '请输入认领码', 400)
      return c.json(clm().requestClaim(me(c), body.code, c.req.param('ptid')))
    } catch (err) { return patientFailure(c, err) }
  })
  /** 家人查看家庭成员绑定的机构记录。 */
  app.get('/api/phr/:ptid/links', c => {
    try { return c.json(clm().listMemberLinks(me(c), c.req.param('ptid'))) } catch (err) { return patientFailure(c, err) }
  })

  // —— 生产合规：PHI 敏感数据扫描与脱敏 ——
  app.post('/api/ops/phi-scan', async c => {
    const body = await c.req.json<{ text?: string }>()
    const text = body.text ?? ''
    const findings = scanPhi(text)
    return c.json({ findings, clean: findings.length === 0, redacted: redactPhi(text) })
  })

  // —— 知家（docs/design/PATIENT.md）：成员的健康档案与就诊简报 ——

  /** 成员的健康档案 doc（没有就补建；知家对话与就诊简报的落点）。 */
  app.post('/api/phr/:ptid/archive', async c => {
    try {
      const user = c.get('user')
      const svc = pt(c)
      svc.assertEditable(me(c), c.req.param('ptid'))
      const detail = svc.read(me(c), c.req.param('ptid'))
      const found = detail.documents.find(d => d.kind === 'archive')
      if (found) return c.json({ doc_id: found.doc_id, existed: true })
      // 标题只用代号（AI 会读到文档标题；称呼不发给外部模型），知家界面按成员称呼显示
      const row = docs.create({ owner: user, title: `${detail.code} 健康档案` })
      try { svc.linkDoc(me(c), c.req.param('ptid'), row.id, 'archive') } catch (err) { store.trashDoc(row.id, true); throw err }
      return c.json({ doc_id: row.id, existed: false }, 201)
    } catch (err) { return patientFailure(c, err) }
  })

  /** 就诊简报：建简报文档 + 起一个 AI 回合填写（指令由服务端组装；红线守卫在操作层强制）。30 分钟内同一成员只生成一份。 */
  app.post('/api/phr/:ptid/brief', async c => {
    try {
      const user = c.get('user')
      const svc = pt(c)
      svc.assertEditable(me(c), c.req.param('ptid'))
      const detail = svc.read(me(c), c.req.param('ptid'))
      if (detail.documents.some(d => d.kind === 'brief' && Date.now() - Date.parse(d.linked_at) < 30 * 60_000)) {
        throw new PatientError('brief_recent', '这个成员刚生成过简报（30 分钟内）；先打开那份看看，需要更新再重新生成', 409)
      }
      const archive = detail.documents.find(d => d.kind === 'archive')
      const row = docs.create({ owner: user, title: `${detail.code} 就诊简报 · ${new Date().toISOString().slice(0, 10)}` })
      try { svc.linkDoc(me(c), c.req.param('ptid'), row.id, 'brief') } catch (err) { store.trashDoc(row.id, true); throw err }
      void turns.submit(user, row.id, phrBriefPrompt({
        patientId: detail.id, code: detail.code, sex: detail.sex, birth_year: detail.birth_year, tags: detail.tags,
        archiveDocId: archive?.doc_id ?? null,
      }))
      return c.json({ doc_id: row.id }, 202)
    } catch (err) { return patientFailure(c, err) }
  })
  app.patch('/api/patients/:ptid/labs/:lid', async c => {
    try { return c.json(pt(c).editLab(me(c), c.req.param('ptid'), c.req.param('lid'), await c.req.json())) } catch (err) { return patientFailure(c, err) }
  })
  /** 报告文字（审核前预览，如 AI 生成的报告草稿全文；与 AI 的 report_read 相同，敏感信息已打码）。 */
  app.get('/api/patients/:ptid/records/:rcid/text', c => {
    try { return c.json(pt(c).recordText(me(c), c.req.param('ptid'), c.req.param('rcid'))) } catch (err) { return patientFailure(c, err) }
  })
  /** 审核时对照原件补一项化验（挂在这份报告上）。 */
  app.post('/api/patients/:ptid/records/:rcid/labs', async c => {
    try { return c.json(pt(c).addRecordLab(me(c), c.req.param('ptid'), c.req.param('rcid'), await c.req.json()), 201) } catch (err) { return patientFailure(c, err) }
  })
  /** 确认 / 驳回一份报告（确认时一并确认它的待确认化验；报告没有日期时要带 report_date）。 */
  app.post('/api/patients/:ptid/records/:rcid/:action{confirm|reject}', async c => {
    try {
      const body = await c.req.json<{ report_date?: string }>().catch(() => ({} as { report_date?: string }))
      pt(c).resolveRecord(me(c), c.req.param('ptid'), c.req.param('rcid'), { accept: c.req.param('action') === 'confirm', report_date: body.report_date })
      return c.json({ ok: true })
    } catch (err) { return patientFailure(c, err) }
  })
  app.post('/api/patients/:ptid/proposals/:prid/:action{accept|reject}', c => {
    try { pt(c).resolveProposal(me(c), c.req.param('ptid'), c.req.param('prid'), c.req.param('action') === 'accept'); return c.json({ ok: true }) } catch (err) { return patientFailure(c, err) }
  })

  // —— 平台运营：机构列表、新建机构（邀请首位管理员）、停用 / 恢复 ——
  app.get('/api/platform/tenants', c => {
    try { return c.json(tenants.listAll(c.get('user'))) } catch (err) { return tenantFailure(c, err) }
  })
  app.post('/api/platform/tenants', async c => {
    try { return c.json(tenants.createOrg(c.get('user'), await c.req.json()), 201) } catch (err) { return tenantFailure(c, err) }
  })
  app.patch('/api/platform/tenants/:tid', async c => {
    try { tenants.setStatus(c.get('user'), c.req.param('tid'), (await c.req.json<{ status?: string }>()).status); return c.json({ ok: true }) } catch (err) { return tenantFailure(c, err) }
  })
  app.patch('/api/me', async c => {
    try {
      return c.json(accounts.updateProfile(c.get('user'), await c.req.json()))
    } catch (err) { return authFailure(c, err) }
  })
  // 绑定邮箱（找回密码用）：发码 → 核对
  app.post('/api/me/email-code', async c => {
    try {
      return c.json(await accounts.sendBindCode(c.get('user'), (await c.req.json<{ email?: string }>()).email, clientIp(c)))
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/me/email', async c => {
    try {
      return c.json(accounts.bindEmail(c.get('user'), await c.req.json()))
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/auth/logout-everywhere', c => {
    accounts.logoutEverywhere(c.get('user'))
    return c.json({ ok: true })
  })
  // 开发模式：管理员把开发期（开发令牌）的文档与资产转到自己的账户
  app.post('/api/me/claim-dev-data', c => {
    if (!deps.devMode || !accounts.isAdmin(c.get('user'))) return c.json({ error: '只有开发模式下的管理员可以认领' }, 403)
    return c.json(store.transferOwnership(deps.devUser, c.get('user')))
  })

  // —— 管理员 ——
  app.use('/api/admin/*', async (c, next) => {
    if (!accounts.isAdmin(c.get('user'))) return c.json({ error: '需要管理员权限' }, 403)
    await next()
  })
  app.get('/api/admin/users', c => {
    const names = new Map(store.listTenants().map(t => [t.id, t.kind === 'org' ? t.name : '个人']))
    return c.json(accounts.listUsers().map(u => ({ ...u, tenant: names.get(store.getUser(u.id)?.tenant_id ?? '') ?? '—' })))
  })
  app.patch('/api/admin/users/:uid', async c => {
    try {
      return c.json(accounts.adminUpdate(c.get('user'), c.req.param('uid'), await c.req.json()))
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/admin/users/:uid/reset-password', async c => {
    try {
      accounts.adminResetPassword(c.req.param('uid'), (await c.req.json<{ password?: string }>()).password ?? '')
      return c.json({ ok: true })
    } catch (err) { return authFailure(c, err) }
  })
  app.post('/api/admin/users/:uid/logout', c => {
    try {
      accounts.adminLogout(c.req.param('uid'))
      return c.json({ ok: true })
    } catch (err) { return authFailure(c, err) }
  })

  // 管理员：审计日志（最新在前，可按操作者 / 操作类型筛选，按 before 翻页）
  app.get('/api/admin/audit', c => {
    const actorName = c.req.query('actor')?.trim()
    const actor = actorName ? store.getUserByName(actorName)?.id ?? actorName : undefined
    const rows = store.listAudit({ actor, action: c.req.query('action') || undefined, before: Number(c.req.query('before')) || undefined, limit: Number(c.req.query('limit')) || 100 })
    const names = new Map<string, string>()
    const nameOf = (id: string | null) => { if (!id) return null; if (!names.has(id)) names.set(id, store.getUser(id)?.username ?? id); return names.get(id)! }
    return c.json(rows.map(r => ({ ...r, actor_name: nameOf(r.actor) })))
  })

  // 管理员：本实例停用记忆（同时删除所有用户的记忆）
  app.get('/api/admin/settings', c => c.json({ memory_enabled: deps.memory?.instanceEnabled() ?? false }))
  app.put('/api/admin/settings', async c => {
    const body = await c.req.json<{ memory_enabled?: boolean }>()
    let deleted = 0
    if (deps.memory && typeof body.memory_enabled === 'boolean') deleted = deps.memory.setInstanceEnabled(body.memory_enabled)
    return c.json({ memory_enabled: deps.memory?.instanceEnabled() ?? false, deleted })
  })

  // —— 记忆（R3） ——
  const memoryFailure = (c: Context, err: unknown) => {
    if (err instanceof MemoryError) return c.json({ error: err.message, code: err.code }, err.code === 'not_found' ? 404 : 400)
    throw err
  }
  app.get('/api/memory', c => {
    const m = deps.memory
    const user = c.get('user')
    const procedural_rules = store.listHarnessRules(user, ['active'])
    if (!m) return c.json({ enabled: false, instance: false, paused: false, items: [], procedural_rules })
    const items = store.listMemories(user, ['proposed', 'active']).map(x => ({ ...x, source_doc_title: x.source_doc_id ? store.getDoc(x.source_doc_id)?.title ?? null : null }))
    const changes = (deps.evolution?.pending(user) ?? []).map(ch => ({ ...ch, targets: ch.target_ids.map(id => store.getMemory(id)).filter(Boolean).map(t => ({ id: t!.id, kind: t!.kind, content: t!.content })) }))
    return c.json({ enabled: m.active(user), instance: m.instanceEnabled(), paused: m.paused(user), items, changes, procedural_rules, review: { available: deps.evolution?.available() ?? false, last: store.getUserSetting(user, 'memory_review_at') } })
  })
  app.delete('/api/memory/rules/:rid', c => {
    return store.deleteHarnessRule(c.get('user'), c.req.param('rid'))
      ? c.json({ ok: true })
      : c.json({ error: '规则不存在或属于系统内置基线策略' }, 404)
  })
  app.put('/api/memory/settings', async c => {
    if (!deps.memory) return c.json({ error: '记忆未启用' }, 503)
    const { paused } = await c.req.json<{ paused?: boolean }>()
    if (typeof paused === 'boolean') deps.memory.setPaused(c.get('user'), paused)
    return c.json({ paused: deps.memory.paused(c.get('user')) })
  })
  app.post('/api/memory', async c => {
    if (!deps.memory) return c.json({ error: '记忆未启用' }, 503)
    const body = await c.req.json<{ content?: string; kind?: string; scope?: 'global' | 'project'; project_id?: string | null }>()
    try {
      const r = await deps.memory.propose(c.get('user'), { content: body.content ?? '', kind: (body.kind ?? 'preference') as never, scope: 'global' }, { source: 'manual', actor: 'user' })
      // 手动添加的项目记忆：直接指定项目
      if (body.scope === 'project' && body.project_id) await deps.memory.edit(c.get('user'), r.memory.id, { scope: 'project', project_id: projectOf(c, body.project_id) || null })
      return c.json({ ...r, memory: store.getMemory(r.memory.id) }, 201)
    } catch (err) { return memoryFailure(c, err) }
  })
  app.patch('/api/memory/:mid', async c => {
    if (!deps.memory) return c.json({ error: '记忆未启用' }, 503)
    try {
      const body = await c.req.json<Parameters<MemoryService['edit']>[2]>()
      if (body.project_id && projectOf(c, body.project_id) === false) return c.json({ error: '项目不存在' }, 404)
      return c.json(await deps.memory.edit(c.get('user'), c.req.param('mid'), body))
    } catch (err) { return memoryFailure(c, err) }
  })
  app.delete('/api/memory/:mid', c => {
    if (!deps.memory) return c.json({ error: '记忆未启用' }, 503)
    return deps.memory.remove(c.get('user'), c.req.param('mid')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
  })
  app.get('/api/memory/:mid/events', c => {
    const m = store.getMemory(c.req.param('mid'))
    if (!m || m.owner !== c.get('user')) return c.json({ error: 'not found' }, 404)
    return c.json(store.memoryEvents(m.id))
  })
  // 记忆演进：整理（与 MCP memory_review 同一个方法），采纳 / 忽略整理建议（只能由用户做）
  app.post('/api/memory/review', async c => {
    if (!deps.evolution) return c.json({ error: '记忆整理不可用' }, 503)
    try {
      const r = await deps.evolution.review(c.get('user'))
      return c.json({ proposed: r.proposed.length, changes: r.changes.length, signals: r.signals, messages: r.messages })
    } catch (err) { return memoryFailure(c, err) }
  })
  app.post('/api/memory/changes/:cid/:action{apply|dismiss}', async c => {
    if (!deps.evolution) return c.json({ error: '记忆整理不可用' }, 503)
    try {
      if (c.req.param('action') === 'apply') return c.json(await deps.evolution.apply(c.get('user'), c.req.param('cid')))
      deps.evolution.dismiss(c.get('user'), c.req.param('cid'))
      return c.json({ ok: true })
    } catch (err) { return memoryFailure(c, err) }
  })
  /** 清空自己的全部记忆（不可恢复）。 */
  app.delete('/api/memory', c => c.json({ deleted: store.clearMemories(c.get('user')) }))
  app.get('/api/memory-export', c => {
    if (!deps.memory) return c.json([])
    return new Response(JSON.stringify({ format: 'heurion-memory', version: 1, exported_at: new Date().toISOString(), items: deps.memory.exportAll(c.get('user')) }, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="heurion-memory.json"' },
    })
  })
  app.post('/api/memory-import', async c => {
    if (!deps.memory) return c.json({ error: '记忆未启用' }, 503)
    const body = await c.req.json<{ items?: unknown[] } | unknown[]>()
    const items = (Array.isArray(body) ? body : body.items ?? []) as Array<{ content?: unknown; kind?: unknown }>
    try {
      return c.json(await deps.memory.importItems(c.get('user'), items))
    } catch (err) { return memoryFailure(c, err) }
  })

  /** 我能读的、不在回收站里的文档（自己的，或我参与的研究里的；回收站里的只能主人恢复或彻底删除）。写权限由下面的中间件按路由把关。 */
  const owned = (c: Context<{ Variables: { user: string } }>) => {
    const row = store.getDoc(c.req.param('id')!)
    return row && !row.deleted_at && access.docRole(c.get('user'), row) ? row : null
  }
  /**
   * 文档路由的访问级别（研究共享文档：只读成员能看、评论、导出、和 AI 对话（AI 同样只读），不能改）。
   * GET 与下列 POST 只要读权限；其余写操作要「可编辑」；删除另由 canDelete 判断。不是成员的一律当不存在（路由里 owned 返回 null → 404）。
   */
  const READ_POSTS = [/^\/comments$/, /^\/comments\/[^/]+\/replies$/, /^\/comments\/[^/]+\/(resolve|reopen|exempt-claim)$/, /^\/chat$/, /^\/duplicate$/]
  const docLevel = (method: string, rest: string): Level => method === 'GET' || (method === 'POST' && READ_POSTS.some(r => r.test(rest))) ? 'read' : 'write'
  for (const path of ['/api/docs/:id', '/api/docs/:id/*']) {
    app.use(path, async (c, next) => {
      const row = store.getDoc(c.req.param('id') ?? '')
      if (!row || row.deleted_at) return next()
      const role = access.docRole(c.get('user'), row)
      const rest = new URL(c.req.url).pathname.replace(/^\/api\/docs\/[^/]+/, '')
      if (role && !allows(role, docLevel(c.req.method, rest))) return c.json({ error: '你在这个研究里是只读成员，不能修改', code: 'forbidden' }, 403)
      return next()
    })
  }
  const ownedInTrash = (c: Context<{ Variables: { user: string } }>) => {
    const row = store.getDoc(c.req.param('id')!)
    return row && row.owner === c.get('user') && row.deleted_at ? row : null
  }
  /** 请求里的项目 id 必须是自己的项目（null / 空为未分组）。 */
  const projectOf = (c: Context<{ Variables: { user: string } }>, id: unknown): string | null | false => {
    if (id === null || id === undefined || id === '') return null
    const p = store.getProject(String(id))
    return p && p.owner === c.get('user') ? p.id : false
  }
  const assetUrl = (token: string) => (id: string) => `/api/assets/${id}?token=${encodeURIComponent(token)}`

  app.get('/api/docs', c => c.json(store.listDocs(c.get('user'))))

  app.post('/api/docs', async c => {
    const user = c.get('user')
    if (c.req.header('content-type')?.includes('application/json')) {
      const body = await c.req.json<{ title?: string; markdown?: string; kind?: string; project_id?: string | null; template?: string }>()
      const title = body.title?.trim() || '未命名'
      const project = projectOf(c, body.project_id)
      if (project === false) return c.json({ error: '项目不存在' }, 404)
      const place = (row: { id: string }) => { if (project) store.setDocProject(row.id, project); return store.getDoc(row.id)! }
      if (body.kind === 'deck') {
        const template = body.template && DECK_THEMES[body.template] && themeAllowed(body.template, user) ? body.template : DEFAULT_THEME
        const pkg = pptxTemplate(template)
        const row = docs.create({ owner: user, title, kind: 'deck', content: newTemplateDeck(title, template) })
        store.putPackage(row.id, 'pptx', pkg)
        return c.json(place(row), 201)
      }
      const content = body.markdown?.trim() ? schema.node('doc', null, parseBlocks(body.markdown)) : undefined
      return c.json(place(docs.create({ owner: user, title, content })), 201)
    }
    const form = await c.req.parseBody()
    const project = projectOf(c, typeof form.project_id === 'string' ? form.project_id : null)
    if (project === false) return c.json({ error: '项目不存在' }, 404)
    const place = (row: { id: string }) => { if (project) store.setDocProject(row.id, project); return store.getDoc(row.id)! }
    const file = form.file instanceof File ? form.file : null
    if (file && /\.pptx$/i.test(file.name)) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const imported = importPptx(bytes)
        const ids = new Map(imported.assets.map(a => [a.key, store.putAsset({ owner: user, mime: a.mime, name: a.name, bytes: a.bytes }).id]))
        const row = docs.create({ owner: user, title: file.name.replace(/\.pptx$/i, ''), kind: 'deck', content: bindDeckAssets(imported.doc, ids), source: 'import' })
        store.putNodeSrc(row.id, imported.src)
        store.putPackage(row.id, 'pptx', bytes)
        return c.json({ ...place(row), warnings: imported.warnings }, 201)
      } catch (err) {
        if (err instanceof PptxImportError) return c.json({ error: err.message }, 400)
        throw err
      }
    }
    if (file && /\.pdf$/i.test(file.name)) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const imported = await importPdf(bytes, file.name, { ocr: deps.pdfOcr, docParser: deps.docParser })
        const ids = new Map(imported.assets.map(a => [a.key, store.putAsset({ owner: user, mime: a.mime, name: a.name, bytes: a.bytes }).id]))
        const baseTitle = file.name.replace(/\.pdf$/i, '').trim()
        const isGenericName = /^(未命名|文档|document|untitled|draft|\d+|[a-f0-9-]{12,}|s\d{5}-\d{3}-\d{5}-[a-z0-9]|pmc\d+|nihms\d+|arxiv[\d.-]+)$/i.test(baseTitle)
        const docTitle = (isGenericName && imported.title && imported.title.length >= 4) ? imported.title : (baseTitle || '未命名文档')

        if (imported.kind === 'deck') {
          const boundDoc = bindDeckAssets(imported.doc, ids)
          const row = docs.create({ owner: user, title: docTitle, kind: 'deck', content: boundDoc, source: 'import' })
          store.putPackage(row.id, 'pptx', pptxTemplate(DEFAULT_THEME))
          const warnings = [...imported.warnings]
          if (imported.title && isGenericName) warnings.unshift(`已自动识别演示文稿标题：《${docTitle}》`)
          if (imported.doi) warnings.push(`检测到 DOI: ${imported.doi}`)
          if (imported.pmid) warnings.push(`检测到 PMID: ${imported.pmid}`)
          return c.json({ ...place(row), warnings, importEngine: imported.engine, ...(imported.fallbackReason ? { importFallbackReason: imported.fallbackReason } : {}) }, 201)
        }
        const boundDoc = bindAssets(imported.doc, ids)
        const row = docs.create({ owner: user, title: docTitle, content: boundDoc, source: 'import' })
        store.putPackage(row.id, 'pdf', bytes)
        const warnings = [...imported.warnings]
        if (imported.title && isGenericName) warnings.unshift(`已自动识别论文标题：《${docTitle}》`)
        if (imported.doi) warnings.push(`检测到 DOI: ${imported.doi}`)
        if (imported.pmid) warnings.push(`检测到 PMID: ${imported.pmid}`)
        return c.json({ ...place(row), warnings, importEngine: imported.engine, ...(imported.fallbackReason ? { importFallbackReason: imported.fallbackReason } : {}) }, 201)
      } catch (err) {
        if (err instanceof PdfImportError) return c.json({ error: err.message }, 400)
        throw err
      }
    }
    if (!file || !/\.docx$/i.test(file.name)) return c.json({ error: '只支持上传 .docx / .pptx / .pdf' }, 400)
    try {
      const imported = importDocx(new Uint8Array(await file.arrayBuffer()))
      const ids = new Map(imported.assets.map(a => [a.key, store.putAsset({ owner: user, mime: a.mime, name: a.name, bytes: a.bytes }).id]))
      // Word 批注在建文档之前换成平台线程 id：导入版本（未改动判断的基准）里就是最终的锚点
      const bound = bindComments(bindAssets(imported.doc, ids), imported.comments, newCommentId)
      const row = docs.create({ owner: user, title: file.name.replace(/\.docx$/i, ''), content: bound.doc, source: 'import' })
      store.putNodeSrc(row.id, imported.src)
      store.putPackage(row.id, 'docx', new Uint8Array(await file.arrayBuffer()))
      for (const t of bound.threads) {
        store.addComment({ id: t.id, doc_id: row.id, node_id: t.node_id, snippet: t.snippet, source_ref: `word:${t.word_id}:${t.replies.length}` })
        store.addReply(t.id, 'user', t.text, null, t.author)
        for (const r of t.replies) store.addReply(t.id, 'user', r.text, null, r.author)
        if (t.done) store.setCommentStatus(row.id, t.id, 'resolved', 'user')
      }
      return c.json({ ...row, warnings: imported.warnings }, 201)
    } catch (err) {
      if (err instanceof DocxImportError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  app.get('/api/docs/:id', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const user = c.get('user')
    const doc = docs.get(row.id)
    const citationRows = store.listCitations(row.id)
    const refPlan = referencePlan(doc, citationRows)
    const marks = threadMarks(doc)
    const messages = store.listMessages(row.id)
    return c.json({
      ...row,
      rev: docs.rev(row.id),
      busy: turns.isBusy(user, row.id),
      active_turn: turns.activeTurn?.(user, row.id) ?? null,
      versions: store.listVersions(row.id),
      messages,
      failed_turns: store.failedTurns(row.id),
      suggestions: pendingGroups(doc),
      claim_checks: store.listClaimChecks(row.id),
      // 研究共享：我的角色、协作者（顶栏显示）
      my_role: access.docRole(user, row),
      collaborators: (() => { const st = access.studyOfDoc(row); return st ? store.studyMembers(st).map(m => ({ user_id: m.user_id, name: store.getUser(m.user_id)?.display_name ?? m.user_id, role: m.role })) : [] })(),
      revertable: [...new Set(messages.map(m => m.turn_id).filter((t): t is string => !!t))].filter(t => docs.canRevertTurn(row.id, t)),
      citations: citationRows.map(x => ({ ...x, number: refPlan.numbers.get(x.id) ?? null })),
      // 编辑器按同一规则实时编号（model/references.ts numberCitations）；user_refs > 0 表示平台引用合并进了正文末尾用户自己的文献表
      citation_numbering: {
        offset: refPlan.userCount,
        fixed: Object.fromEntries(refPlan.fixed),
        user_refs: refPlan.userCount,
        duplicates: refPlan.duplicates,
      },
      comments: store.listComments(row.id).map(x => ({ ...x, anchor: locate(doc, x, marks) })),
    })
  })

  app.patch('/api/docs/:id', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ title?: string; project_id?: string | null }>()
    if (body.title?.trim()) { store.renameDoc(row.id, body.title.trim()); deps.search?.reindex(row.id) }
    if ('project_id' in body) {
      // 项目是个人的文件夹：只有主人、且文档不在研究里时能移动
      if (row.owner !== c.get('user') || access.studyOfDoc(row)) return c.json({ error: '研究里的文档不能放进个人项目' }, 409)
      const project = projectOf(c, body.project_id)
      if (project === false) return c.json({ error: '项目不存在' }, 404)
      store.setDocProject(row.id, project)
    }
    return c.json(store.getDoc(row.id))
  })

  // —— 文档仓库（R2）：项目、搜索、回收站、复制 ——
  app.get('/api/projects', c => c.json(store.listProjects(c.get('user'))))
  app.post('/api/projects', async c => {
    const name = (await c.req.json<{ name?: string }>()).name?.trim().slice(0, 60)
    if (!name) return c.json({ error: '项目名不能为空' }, 400)
    return c.json(store.createProject(c.get('user'), name), 201)
  })
  app.patch('/api/projects/:pid', async c => {
    const p = store.getProject(c.req.param('pid'))
    if (!p || p.owner !== c.get('user')) return c.json({ error: 'not found' }, 404)
    const name = (await c.req.json<{ name?: string }>()).name?.trim().slice(0, 60)
    if (!name) return c.json({ error: '项目名不能为空' }, 400)
    store.renameProject(p.id, name)
    return c.json(store.getProject(p.id))
  })
  app.delete('/api/projects/:pid', c => {
    const p = store.getProject(c.req.param('pid'))
    if (!p || p.owner !== c.get('user')) return c.json({ error: 'not found' }, 404)
    store.deleteProject(p.id) // 文档回到未分组，不删除
    return c.json({ ok: true })
  })
  // —— 参考资料库（R2b） ——
  const ownedFile = (c: Context<{ Variables: { user: string } }>) => {
    const f = store.getKbFile(c.req.param('fid')!)
    return f && f.owner === c.get('user') ? f : null
  }
  app.get('/api/kb', c => {
    const project = c.req.query('project')
    return c.json(store.listKbFiles(c.get('user'), project === undefined ? undefined : project || null))
  })
  app.post('/api/kb', async c => {
    if (!deps.kb) return c.json({ error: '资料库未启用' }, 503)
    const form = await c.req.parseBody({ all: true })
    const files = ([] as unknown[]).concat(form.file ?? []).filter((f): f is File => f instanceof File)
    if (files.length === 0) return c.json({ error: '请选择文件' }, 400)
    const project = projectOf(c, form.project_id)
    if (project === false) return c.json({ error: '项目不存在' }, 404)
    const out: unknown[] = []
    for (const f of files) {
      try {
        const r = await deps.kb.upload(c.get('user'), { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), project_id: project })
        out.push({ ...r.file, duplicate: r.duplicate })
      } catch (err) {
        if (err instanceof ExtractError) out.push({ name: f.name, error: err.message })
        else throw err
      }
    }
    return c.json(out, 201)
  })
  app.patch('/api/kb/:fid', async c => {
    const f = ownedFile(c)
    if (!f) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ project_id?: string | null; name?: string }>()
    if ('project_id' in body) {
      const project = projectOf(c, body.project_id)
      if (project === false) return c.json({ error: '项目不存在' }, 404)
      store.updateKbFile(f.id, { project_id: project })
    }
    if (body.name?.trim()) store.updateKbFile(f.id, { name: body.name.trim().slice(0, 200) })
    return c.json(store.getKbFile(f.id))
  })
  app.delete('/api/kb/:fid', c => {
    const f = ownedFile(c)
    if (!f) return c.json({ error: 'not found' }, 404)
    store.deleteKbFile(f.id)
    return c.json({ ok: true })
  })
  app.get('/api/kb/:fid/text', c => {
    const f = ownedFile(c)
    if (!f) return c.json({ error: 'not found' }, 404)
    return c.json({ file: f, pages: store.kbText(f.id, Number(c.req.query('from') ?? 1), Number(c.req.query('to') ?? Number.MAX_SAFE_INTEGER)) })
  })
  app.get('/api/kb/:fid/file', c => {
    const f = ownedFile(c)
    if (!f) return c.json({ error: 'not found' }, 404)
    return new Response(Buffer.from(store.getKbBytes(f.id) ?? new Uint8Array()), { headers: { 'Content-Type': f.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}` } })
  })
  app.get('/api/kb-status', async c => c.json(deps.kb ? await deps.kb.status() : { enabled: false, vector: false }))
  app.get('/api/kb-search', async c => {
    if (!deps.kb) return c.json([])
    const files = c.req.query('files')?.split(',').filter(Boolean)
    return c.json(await deps.kb.search(c.get('user'), c.req.query('q') ?? '', { limit: 10, fileIds: files }))
  })

  app.get('/api/search', c => c.json(store.searchDocs(c.get('user'), c.req.query('q') ?? '', 30)))
  app.get('/api/trash', c => c.json(store.listTrash(c.get('user'))))
  app.post('/api/docs/:id/restore', c => {
    const row = ownedInTrash(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    store.trashDoc(row.id, false)
    return c.json(store.getDoc(row.id))
  })
  app.delete('/api/docs/:id/purge', c => {
    const row = ownedInTrash(c)
    if (!row) return c.json({ error: '只能彻底删除回收站里的文档' }, 404)
    docs.unload(row.id)
    store.deleteDoc(row.id)
    store.unindexDoc(row.id)
    return c.json({ ok: true })
  })
  app.post('/api/docs/:id/duplicate', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const copy = duplicateDoc(docs, row, c.get('user'))
    deps.search?.reindex(copy.id)
    return c.json(copy, 201)
  })

  // 删除 = 移进回收站（30 天后自动彻底删除；可恢复）
  app.delete('/api/docs/:id', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    if (!access.canDelete(c.get('user'), row, access.docRole(c.get('user'), row))) return c.json({ error: '只有创建者或研究负责人能删除这份文档', code: 'forbidden' }, 403)
    store.trashDoc(row.id, true)
    return c.json({ ok: true, trashed: true })
  })

  app.get('/api/docs/:id/html', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const seq = c.req.query('version')
    const doc = seq ? docs.versionDoc(row.id, Number(seq)) : docs.get(row.id)
    if (!doc) return c.json({ error: 'version not found' }, 404)
    return c.json({ rev: docs.rev(row.id), html: renderHtml(doc, store.listCitations(row.id), assetUrl(requestToken(c) ?? '')) })
  })

  /** 读视图（与 MCP doc_read 相同），便于调试模型看到的内容。 */
  app.get('/api/docs/:id/read', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    docs.flush(row.id)
    if (row.kind === 'deck') return c.text(deckRead(docs.get(row.id), docs.rev(row.id)))
    // 与 MCP doc_read 一致：长文档分页，?cursor=<顶层块下标> 读下一页
    const cursor = Number(c.req.query('cursor'))
    try {
      return c.text(read({ doc: docs.get(row.id), docId: row.id, rev: docs.rev(row.id), comments: store.listComments(row.id, 'open'), ...(Number.isInteger(cursor) && cursor > 0 ? { cursor } : {}) }))
    } catch (err) {
      if (err instanceof ReadError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  app.get('/api/docs/:id/export.md', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    docs.flush(row.id)
    return c.body(exportMarkdown(withoutPending(docs.get(row.id)), store.listCitations(row.id)), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.title)}.md`,
    })
  })

  app.get('/api/docs/:id/export.docx', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const result = docxFor(docs, row.id)
    return c.body(Buffer.from(withFonts(result.bytes, exportFontsParam(c.req.query('fonts')))), 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.title)}.docx`,
      ...(result.warnings.length > 0 ? { 'X-Heurion-Warnings': encodeURIComponent(result.warnings.join('；')) } : {}),
    })
  })

  app.get('/api/docs/:id/export.pptx', c => {
    const row = owned(c)
    if (!row || row.kind !== 'deck') return c.json({ error: 'not found' }, 404)
    const result = pptxFor(docs, row.id)
    return c.body(Buffer.from(withFonts(result.bytes, exportFontsParam(c.req.query('fonts')))), 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.title)}.pptx`,
    })
  })

  /** deck 模型（页面渲染用）：幻灯片、形状、页面尺寸。 */
  app.get('/api/docs/:id/deck', async c => {
    const row = owned(c)
    if (!row || row.kind !== 'deck') return c.json({ error: 'not found' }, 404)
    const info = ops.deckContextInfo(row.id)
    // ph_styles：各版式占位符继承的文字样式（画布显示导入的占位符用）
    const ph_styles = Object.fromEntries(info.layouts.map(l => [l.part, l.placeholders.map(p => ({ type: p.type, idx: p.idx, style: p.style ?? {} }))]))
    const render_info = await deps.renderer.diagnose()
    return c.json({ rev: docs.rev(row.id), size: info.size, layouts: info.layouts.map(l => l.name), ph_styles, doc: docs.get(row.id).toJSON(), render_info })
  })


  /** 幻灯片的精确预览（LibreOffice 或内置 Resvg 矢量光栅化渲染，按 rev 缓存）。 */
  app.get('/api/docs/:id/slides/:index/render.png', async c => {
    const row = owned(c)
    if (!row || row.kind !== 'deck') return c.json({ error: 'not found' }, 404)
    try {
      const info = ops.deckContextInfo(row.id)
      const pngs = await deps.renderer.render(`${row.id}/${docs.rev(row.id)}`, {
        pptx: () => pptxFor(docs, row.id).bytes,
        getDoc: () => docs.get(row.id),
        size: info.size,
        getAssetBytes: id => store.getAssetBytes(id),
      })
      const png = pngs[Number(c.req.param('index'))]
      if (!png) return c.json({ error: 'slide not found' }, 404)
      return c.body(readFileSync(png), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503)
    }
  })

  /** 用户编辑（P1 编辑器上线前的入口）：同一操作层，actor=user。 */
  // 幻灯片主题（画布的主题选择与颜色板用；与 MCP apply_theme 同一份定义）
  app.get('/api/deck-themes', c => c.json(Object.fromEntries(themeKeysFor(c.get('user')).map(k => [k, DECK_THEMES[k]]))))
  // 模板清单：配色、说明、每个版式的占位符与装饰（模板选择器、加页的版式预览按它画）
  app.get('/api/deck-templates', c => c.json(templateCatalog(c.get('user'))))

  app.post('/api/docs/:id/edit', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const parsed = (row.kind === 'deck' ? DeckEditBatch : EditBatch).safeParse({ ...(await c.req.json<object>()), doc_id: row.id })
    if (!parsed.success) return c.json({ code: 'validation_error', message: parsed.error.message }, 400)
    try {
      return c.json(ops.edit(parsed.data, { actor: 'user', turnId: null, user: c.get('user') }))
    } catch (err) {
      if (err instanceof OpError) return c.json(err.toJSON(), 409)
      throw err
    }
  })

  /** 批量导入参考文献（RIS / BibTeX / PubMed / EndNote XML / DOI 列表）到登记表；与 MCP import_references 同一实现。 */
  app.post('/api/docs/:id/citations/import', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const { text } = await c.req.json<{ text?: string }>()
    if (!text?.trim()) return c.json({ error: '没有内容' }, 400)
    if (text.length > 5_000_000) return c.json({ error: '文件太大（最多 5MB）' }, 413)
    const refs = parseReferences(text)
    if (refs.length === 0) return c.json({ error: '没有识别出文献（支持 RIS、BibTeX、PubMed、EndNote XML，或每行一个 DOI / PMID）' }, 400)
    const pubmed = deps.pubmed ?? ({ summaries: async () => [] } as unknown as PubMedClient)
    return c.json(await importReferences({ store, crossref: deps.crossref, pubmed }, row.id, refs))
  })

  /** 文献实时模糊检索（PubMed / OpenAlex），供引用搜索建议使用。 */
  app.get('/api/citations/search', async c => {
    const q = c.req.query('q')?.trim()
    if (!q) return c.json({ results: [] })
    const results: Article[] = []
    if (deps.pubmed) {
      try {
        const pmHits = await deps.pubmed.search(q, 6)
        results.push(...pmHits)
      } catch { /* 忽略错误 */ }
    }
    if (results.length === 0 && deps.openalex) {
      try {
        const oaHits = await deps.openalex.search(q, 6)
        results.push(...oaHits)
      } catch { /* 忽略错误 */ }
    }
    return c.json({ results })
  })

  /** 用户按 DOI / PMID / 关键词模糊登记引用（Crossref / PubMed / OpenAlex 核实），返回 cite_id，编辑器在光标处插入引用。 */
  app.post('/api/docs/:id/citations', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ doi?: string; pmid?: string; query?: string; style?: 'ama' | 'apa' | 'vancouver' | 'gbt7714' }>().catch(() => ({} as any))
    let doi = body.doi?.trim()
    let pmid = body.pmid?.trim()
    const query = body.query?.trim()

    if (!doi && !pmid && !query) return c.json({ error: '请提供 DOI、PMID 或文献检索词 (query)' }, 400)

    // 智能识别：若在 doi 字段中输入了纯数字 PMID 或 "PMID: 123456"，自动转为 pmid
    if (doi && (/^\d{6,9}$/.test(doi) || /^pmid:?\s*\d+/i.test(doi))) {
      pmid = doi.replace(/^pmid:?\s*/i, '').trim()
      doi = undefined
    }

    let article: Article | null = null

    if (doi) {
      article = await deps.crossref.lookup(doi).catch(() => null)
      if (!article && deps.openalex) article = await deps.openalex.lookup(doi).catch(() => null)
      if (!article && deps.pubmed) {
        const pm = await deps.pubmed.pmidForDoi(doi).catch(() => null)
        if (pm) {
          const list = await deps.pubmed.summaries([pm]).catch(() => [])
          if (list.length) article = list[0] ?? null
        }
      }
    }

    if (!article && pmid && deps.pubmed) {
      const cleanPmid = pmid.replace(/^pmid:?\s*/i, '').trim()
      const list = await deps.pubmed.summaries([cleanPmid]).catch(() => [])
      if (list.length) {
        article = list[0] ?? null
        if (article?.doi) {
          const enriched = await deps.crossref.lookup(article.doi).catch(() => null)
          if (enriched) article = enriched
        }
      }
    }

    if (!article && query) {
      if (deps.pubmed) {
        const hits = await deps.pubmed.search(query, 3).catch(() => [])
        if (hits.length) article = hits[0] ?? null
      }
      if (!article && deps.openalex) {
        const hits = await deps.openalex.search(query, 3).catch(() => [])
        if (hits.length) article = hits[0] ?? null
      }
    }

    if (!article) {
      const identifier = doi ? `DOI ${normalizeDoi(doi)}` : pmid ? `PMID ${pmid}` : `检索词「${query}」`
      return c.json({ error: `未能检索或核实到该文献 (${identifier})，请检查标识符或网络连接` }, 404)
    }

    const finalDoi = article.doi ? normalizeDoi(article.doi) : (article.pmid ? `pmid:${article.pmid}` : `ref:${randomUUID().slice(0, 8)}`)
    const finalUrl = article.doi ? `https://doi.org/${article.doi}` : (article.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/` : null)
    const formatted = formatCitation(article, body.style ?? 'ama')
    const cite = store.upsertCitation({ doc_id: row.id, doi: finalDoi, pmid: article.pmid ?? pmid ?? null, formatted, url: finalUrl })
    return c.json({ cite_id: cite.id, formatted: cite.formatted, doi: cite.doi, pmid: cite.pmid }, 201)
  })

  /** 核对全部论断：排一个只核对、不改正文的回合。 */
  app.post('/api/docs/:id/verify', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    return streamTurn(c, deps, row.id, verifyPrompt(row.id))
  })

  /** 采纳 / 拒绝待采纳修订（group = all 表示全部）。 */
  app.post('/api/docs/:id/suggestions/:group/:action{accept|reject}', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    docs.flush(row.id)
    const group = c.req.param('group') === 'all' ? null : c.req.param('group')
    const accept = c.req.param('action') === 'accept'
    const next = resolveSuggestions(docs.get(row.id), group, accept)
    const event = docs.commit(row.id, next, { actor: 'user', turnId: null, user: c.get('user'), ops: [{ op: accept ? 'accept_suggestion' : 'reject_suggestion', group }] })
    return c.json({ rev: docs.rev(row.id), changes: event?.changes.length ?? 0 })
  })

  /** 撤销某个 AI 回合对本文档的改动（用户在此期间的编辑保留）。 */
  // 重试一轮（失败 / 超时 / 被停止的回合）：同样的要求、同样的选项重新排队
  app.post('/api/docs/:id/turns/:turnId/retry', c => {
    const row = owned(c)
    const turn = row ? store.getTurn(c.req.param('turnId')) : undefined
    if (!row || !turn || turn.doc_id !== row.id || turn.user_id !== c.get('user')) return c.json({ error: 'not found' }, 404)
    if (turn.status === 'running') return c.json({ error: '这一轮还在执行' }, 409)
    let opts: TurnOptions = {}
    try { opts = JSON.parse(turn.opts || '{}') as TurnOptions } catch { /* 默认选项 */ }
    void turns.submit(c.get('user'), row.id, turn.message, undefined, opts)
    return c.json({ queued: true }, 202)
  })

  app.post('/api/docs/:id/turns/:turnId/revert', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const turnId = c.req.param('turnId')
    if (!docs.canRevertTurn(row.id, turnId)) return c.json({ error: '这一轮已经撤销过，或没有改动可撤销' }, 409)
    const result = docs.revertTurn(row.id, turnId)
    const version = docs.snapshot(row.id, 'user', '撤销一轮 AI 修改')
    return c.json({ rev: docs.rev(row.id), changes: result?.event?.changes.length ?? 0, skipped: result?.skipped ?? [], version })
  })

  /** 用户显式保存一个版本。 */
  app.post('/api/docs/:id/save', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.json({ version: docs.snapshot(row.id, 'user', '手动保存') })
  })

  app.post('/api/docs/:id/versions/:seq/restore', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    if (turns.isBusy(c.get('user'), row.id)) return c.json({ error: 'AI 正在编辑，先取消或等待完成' }, 409)
    return c.json({ version: docs.restore(row.id, Number(c.req.param('seq'))), rev: docs.rev(row.id) })
  })

  app.get('/api/docs/:id/diff', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const before = docs.versionDoc(row.id, Number(c.req.query('from')))
    const to = c.req.query('to')
    const after = to ? docs.versionDoc(row.id, Number(to)) : docs.get(row.id)
    if (!before || !after) return c.json({ error: 'version not found' }, 404)
    return c.json({ changes: diff(before, after) })
  })

  /** 文档变更推送（预览实时刷新）。 */
  app.get('/api/docs/:id/stream', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    return streamSSE(c, async stream => {
      let closed = false
      const queue: unknown[] = []
      let wake: (() => void) | null = null
      const push = (e: unknown) => { queue.push(e); wake?.() }
      const onCommit = (e: CommitEvent) => {
        if (e.docId === row.id) push({ type: 'commit', rev: e.rev, actor: e.actor, turn_id: e.turnId, changes: e.changes })
      }
      // 该用户的回合事件（含 @heurion 自动触发的回合）：只转发与本文档相关的
      const onTurn = (e: TurnBusEvent) => {
        if (e.userId === c.get('user') && e.docId === row.id && e.event.type !== 'reasoning') push({ type: 'turn_event', event: e.event })
      }
      const onNotice = (n: Notice) => { if (n.doc_id === row.id) push({ type: 'notice', ...n }) }
      docs.on('commit', onCommit)
      turns.events.on('event', onTurn)
      deps.postcheck.on('notice', onNotice)
      stream.onAbort(() => { closed = true; wake?.() })
      await stream.writeSSE({ data: JSON.stringify({ type: 'hello', rev: docs.rev(row.id), busy: turns.isBusy(c.get('user'), row.id) }) })
      try {
        while (!closed) {
          if (queue.length === 0) await new Promise<void>(r => { wake = r; setTimeout(r, 25_000) })
          wake = null
          const batch = queue.splice(0)
          if (batch.length === 0) await stream.writeSSE({ event: 'ping', data: '' })
          for (const e of batch) await stream.writeSSE({ data: JSON.stringify(e) })
        }
      } finally {
        docs.off('commit', onCommit)
        turns.events.off('event', onTurn)
        deps.postcheck.off('notice', onNotice)
      }
    })
  })

  // —— 评论 ——

  app.post('/api/docs/:id/comments', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ node_id?: string; snippet?: string; paragraph?: number; range?: { from: number; to: number }; text?: string }>()
    if (!body.node_id || !body.text?.trim()) return c.json({ error: 'node_id 与 text 必填' }, 400)
    const comment = store.addComment({ doc_id: row.id, node_id: body.node_id, snippet: body.snippet ?? '' })
    try {
      const anchored = attachComment(docs.get(row.id), body.node_id, body.snippet ?? '', comment.id, body.paragraph, body.range)
      docs.commit(row.id, anchored.doc, { actor: 'user', turnId: null, user: c.get('user'), ops: [{ op: 'comment', thread: comment.id }] })
      store.setCommentAnchor(comment.id, body.node_id, anchored.snippet)
    } catch (err) {
      store.db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id)
      if (err instanceof AnchorError) return c.json({ error: err.message }, 400)
      throw err
    }
    store.addReply(comment.id, 'user', body.text.trim())
    // @heurion：评论即指令，自动排队处理
    if (wantsAi(body.text)) void turns.submit(c.get('user'), row.id, commentPrompt(row.id, comment.id, row.kind), undefined, { commentId: comment.id })
    return c.json({ ...store.getComment(row.id, comment.id), queued: wantsAi(body.text) }, 201)
  })

  app.post('/api/docs/:id/comments/:cid/replies', async c => {
    const row = owned(c)
    if (!row || !store.getComment(row.id, c.req.param('cid'))) return c.json({ error: 'not found' }, 404)
    const { text } = await c.req.json<{ text?: string }>()
    if (!text?.trim()) return c.json({ error: 'text 必填' }, 400)
    const reply = store.addReply(c.req.param('cid'), 'user', text.trim())
    if (wantsAi(text)) void turns.submit(c.get('user'), row.id, commentPrompt(row.id, c.req.param('cid'), row.kind), undefined, { commentId: c.req.param('cid') })
    return c.json({ ...reply, queued: wantsAi(text) }, 201)
  })

  app.post('/api/docs/:id/comments/:cid/:action{resolve|reopen}', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const resolve = c.req.param('action') === 'resolve'
    return c.json({ ok: store.setCommentStatus(row.id, c.req.param('cid'), resolve ? 'resolved' : 'open', resolve ? 'user' : null) })
  })

  /** 将某条论断标记为临床经验豁免并关闭关联评论。 */
  app.post('/api/docs/:id/comments/:cid/exempt-claim', c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const cid = c.req.param('cid')
    const check = store.db.prepare('SELECT claim_id FROM claim_checks WHERE doc_id = ? AND comment_id = ?').get(row.id, cid) as { claim_id: string } | undefined
    if (check) {
      store.exemptClaim(row.id, check.claim_id)
    } else {
      store.addReply(cid, 'user', '【临床经验豁免】：已标记为临床经验/无需出处，豁免文献核对。')
      store.setCommentStatus(row.id, cid, 'resolved', 'user')
    }
    return c.json({ ok: true, comment_id: cid, status: 'resolved' })
  })

  /** 采纳 AI 论断修改建议并一键纠正正文。 */
  app.post('/api/docs/:id/comments/:cid/apply-claim-fix', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const cid = c.req.param('cid')
    const body = await c.req.json<{ replace?: string; find?: string }>().catch(() => ({} as { replace?: string; find?: string }))
    const target = store.getComment(row.id, cid)
    if (!target) return c.json({ error: 'comment not found' }, 404)

    let replace = body.replace?.trim()
    if (!replace) {
      for (const r of target.replies) {
        const m = /【建议修改为】：([^\n]+)/.exec(r.text) || /建议修改为：([^\n]+)/.exec(r.text)
        if (m) { replace = m[1]?.trim(); break }
      }
    }
    if (!replace) return c.json({ error: 'no replacement suggestion found' }, 400)

    const doc = docs.get(row.id)
    const marks = threadMarks(doc)
    const loc = locate(doc, target, marks)
    const nodeId = loc.node_ids[0] || target.node_id
    const find = body.find?.trim() || loc.text || target.snippet
    if (!find || !nodeId) return c.json({ error: 'anchor not found' }, 400)

    const editRes = deps.ops.edit({
      doc_id: row.id,
      base_rev: docs.rev(row.id),
      mode: 'apply',
      ack_comments: [cid],
      ops: [{ op: 'replace_text', id: nodeId, find, replace }],
    }, { actor: 'user', turnId: null, user: c.get('user') })

    store.addReply(cid, 'user', `【一键采纳建议】：已将「${find}」替换为「${replace}」`)
    store.setCommentStatus(row.id, cid, 'resolved', 'user')
    return c.json({ ok: true, comment_id: cid, replaced: { find, replace }, rev: editRes.rev })
  })

  /** 删除评论：去掉正文里的锚点标记与线程。 */
  app.delete('/api/docs/:id/comments/:cid', c => {
    const row = owned(c)
    const cid = c.req.param('cid')
    if (!row || !store.getComment(row.id, cid)) return c.json({ error: 'not found' }, 404)
    const doc = docs.get(row.id)
    const tr = new Transform(doc)
    tr.removeMark(0, doc.content.size, doc.type.schema.marks.comment!.create({ thread: cid }))
    docs.commit(row.id, tr.doc, { actor: 'user', turnId: null, user: c.get('user'), ops: [{ op: 'delete_comment', thread: cid }] })
    store.db.prepare('DELETE FROM comments WHERE doc_id = ? AND id = ?').run(row.id, cid)
    return c.json({ ok: true })
  })

  /** 让 AI 处理这条评论（可附追问）。 */
  app.post('/api/docs/:id/comments/:cid/ask', async c => {
    const row = owned(c)
    if (!row || !store.getComment(row.id, c.req.param('cid'))) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ text?: string; suggest?: boolean }>().catch(() => ({} as { text?: string; suggest?: boolean }))
    if (body.text?.trim()) store.addReply(c.req.param('cid'), 'user', body.text.trim())
    return streamTurn(c, deps, row.id, commentPrompt(row.id, c.req.param('cid'), row.kind), { suggest: body.suggest !== false, commentId: c.req.param('cid') })
  })

  // —— 对话 ——

  // —— 临床研究项目、队列与数据集 ——
  registerResearchRoutes(app, {
    store,
    studies: deps.studies,
    cohort: deps.cohort,
    patients: deps.patients,
    datasets: deps.datasets,
    me,
    patientFailure,
  })

  app.post('/api/docs/:id/chat', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const { message, suggest, kb_files, datasets, patients, images, memory } = await c.req.json<{ message?: string; suggest?: boolean; kb_files?: string[]; datasets?: string[]; patients?: string[]; images?: string[]; memory?: boolean }>()
    if (!message?.trim()) return c.json({ error: 'message 必填' }, 400)
    // 对话里选中的参考资料：告诉 AI 用哪几份（只认自己的资料）
    const picked = (kb_files ?? []).slice(0, 20).map(id => store.getKbFile(id)).filter(f => f && f.owner === c.get('user'))
    const note = picked.length === 0 ? '' : `\n\n［参考资料］请依据这些资料（kb_search 用 file_ids 限定检索，kb_read 读原文）：${picked.map(f => `《${f!.name}》(file_id=${f!.id})`).join('、')}`
    // 对话里选中的数据集（只认自己的、已可用的）；研究项目里的文档自动带上这个研究的数据集
    const ctx = row.context ? JSON.parse(row.context) as { kind?: string; study_id?: string; title?: string } : null
    const studySets = ctx?.kind === 'study' && ctx.study_id && deps.studies ? (() => { try { return deps.studies!.readyDatasets(c.get('user'), ctx.study_id!).map(d => d.dataset_id) } catch { return [] } })() : []
    const sets = [...new Set([...(datasets ?? []).slice(0, 10), ...studySets])].map(id => store.getDataset(id)).filter(d => d && access.canDataset(c.get('user'), d, 'read') && d.status === 'ready')
    const snote = ctx?.kind === 'study' ? `\n\n［研究］这份文档属于研究项目「${ctx.title ?? ''}」(study_id=${ctx.study_id})，可用 study_read 看方案、数据集、已有分析。` : ''
    const dnote = sets.length === 0 ? '' : `\n\n［数据集］请用这些数据分析（dataset_describe 看变量，dataset_open 放进工作区后用 Python 分析）：${sets.map(d => `《${d!.name}》(dataset_id=${d!.id}，${d!.rows} 行 × ${d!.cols} 列)`).join('、')}`
    // 对话里带上的患者（只认自己看得到的；只给代号）
    let pnote = ''
    if (patients?.length && deps.patients) {
      try {
        const visible = new Map(deps.patients.list({ userId: c.get('user'), via: 'user' }).map(p => [p.id, p]))
        const picked = patients.slice(0, 10).map(id => visible.get(id)).filter(Boolean)
        if (picked.length) pnote = `\n\n［患者］请用 patient_read / labs_query 查看（只用代号，不要写姓名）：${picked.map(p => `${p!.code}(patient_id=${p!.id})`).join('、')}`
      } catch { /* 本机构没开患者模块 */ }
    }
    // 对话里贴的图片（自己的图片资产）：放进 AI 工作区 attachments/，AI 用 read_image 看；要插进文稿可直接用资产 id
    let inote = ''
    const pics = (images ?? []).slice(0, 8).map(id => store.getAsset(id)).filter(a => a && a.size > 0 && a.owner === c.get('user') && a.mime.startsWith('image/'))
    if (pics.length && deps.workspaceDir) {
      const ws = deps.workspaceDir(c.get('user'))
      const dir = join(ws, 'attachments')
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        chmodSync(dir, 0o2777)
      } catch { /* 权限容错 */ }
      const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }
      const files: string[] = []
      for (const a of pics) {
        if (!a) continue
        const bytes = store.getAssetBytes(a.id)
        if (!bytes || bytes.length === 0) continue
        const rel = `attachments/${a.id}.${EXT[a.mime] ?? 'png'}`
        const filePath = join(ws, rel)
        try {
          writeFileSync(filePath, bytes)
          chmodSync(filePath, 0o666)
        } catch { /* 容错 */ }
        files.push(`${rel}(asset_id=${a.id})`)
      }
      if (files.length) {
        inote = `\n\n［图片附件］用户在对话中附带了 ${files.length} 张图片：${files.join('、')}。
- 请直接调用 read_image 工具查看图片内容。切勿尝试运行计算或命令行访问底层文件路径。
- 若图片属于医学影像（如超声波声像图、CT 扫描、MRI、X 线胸片、心电图、病理切片等）或临床化验单：请从专业医学/影像学视角进行深度解读（包括影像模态、解剖结构、可疑病灶、声像/密度特征、初步临床鉴别与处置建议）；若需精准 3D 容积量化与 RECIST 疗效比对，可建议用户导入「患者 -> 影像中心」进行 MONAI 3D 深度学习分析。
- 若图片需要插入文稿，直接使用 ![说明](asset:<asset_id> "图注") 并在正文中给出专业图解说明。`
      }
    }
    return streamTurn(c, deps, row.id, message.trim() + note + dnote + snote + pnote + inote, { suggest: suggest !== false, ...(memory === false ? { memory: false } : {}) })
  })

  // 任务队列：正在执行的一个 + 排队中的；可逐个取消
  app.get('/api/queue', c => c.json(turns.view(c.get('user'))))
  app.post('/api/queue/:jid/cancel', async c => {
    const ok = await turns.cancelJob(c.get('user'), c.req.param('jid'))
    return ok ? c.json({ ok: true }) : c.json({ error: '任务已结束或不存在' }, 404)
  })

  app.post('/api/cancel', async c => {
    await turns.cancel(c.get('user'))
    return c.json({ ok: true })
  })

  // —— 全局 Co-Pilot 随航助手 ——
  function getOrCreateCopilotDoc(userId: string): DocRow {
    const existing = (store as any).getCopilotDoc
      ? (store as any).getCopilotDoc(userId)
      : (store as any).db
          ?.prepare(
            "SELECT * FROM docs WHERE owner = ? AND deleted_at IS NULL AND json_extract(context, '$.kind') = 'copilot' ORDER BY created_at DESC LIMIT 1",
          )
          .get(userId)
    if (existing) return existing as DocRow

    const list = store.listDocs(userId)
    for (const d of list) {
      if (d.context && !d.deleted_at) {
        try {
          const ctx = JSON.parse(d.context) as { kind?: string }
          if (ctx.kind === 'copilot') return d
        } catch {}
      }
    }
    const row = docs.create({
      owner: userId,
      title: 'Heurion Co-Pilot 随航工作台',
      kind: 'doc',
    })
    store.setDocContext(row.id, { kind: 'copilot' })
    return store.getDoc(row.id)!
  }

  app.get('/api/copilot/status', c => {
    const user = c.get('user')
    const doc = getOrCreateCopilotDoc(user)
    const rawMessages = store.listMessages(doc.id)
    const messages = rawMessages.slice(-50).map(m => {
      let text = m.text
      if (m.role === 'user' && text.includes('用户需求：')) {
        text = text.split('用户需求：').pop()?.trim() || text
      }
      return {
        id: m.id,
        role: m.role,
        text,
        turn_id: m.turn_id,
        created_at: m.created_at,
      }
    })
    const turnsList = store.listTurns(doc.id).slice(-30).map(t => {
      const text = t.message
      const userPart = text.includes('用户需求：') ? text.split('用户需求：').pop()?.trim() : text
      return {
        id: t.id,
        user_message: userPart || t.message,
        status: t.status,
        started_at: t.started_at,
        ended_at: t.ended_at,
        error: t.error,
      }
    })
    return c.json({ doc_id: doc.id, messages, turns: turnsList, busy: deps.turns.isCopilotBusy(user) })
  })

  app.post('/api/copilot/chat', async c => {
    const user = c.get('user')
    const body = await c.req.json<{
      message?: string
      space?: string
      study_id?: string
      patient_id?: string
      doc_id?: string
      title?: string
    }>().catch(() => ({} as any))

    const message = body.message?.trim()
    if (!message) return c.json({ error: 'message 必填' }, 400)

    const copilotDoc = getOrCreateCopilotDoc(user)

    let prompt = `［Heurion 全局 Co-Pilot 随航指令］\n`
    if (body.space) prompt += `【当前所在工作区】${body.space}\n`
    if (body.study_id) {
      const st = store.getStudy(body.study_id)
      if (st) prompt += `【关联研究项目】《${st.title}》(study_id=${st.id})\n`
    }
    if (body.patient_id && deps.patients) {
      try {
        const visible = deps.patients.list({ userId: user, via: 'user' })
        const pt = visible.find(p => p.id === body.patient_id || p.code === body.patient_id)
        if (pt) prompt += `【关联患者】代号 ${pt.code} (patient_id=${pt.id})\n`
      } catch {}
    }
    if (body.doc_id) {
      const d = store.getDoc(body.doc_id)
      if (d) prompt += `【关联文档】《${d.title}》(doc_id=${d.id})\n`
    }
    prompt += `\n用户需求：${message}`

    return streamTurn(c, deps, copilotDoc.id, prompt, {
      suggest: false,
      lane: 'copilot',
      ...(body.doc_id ? { contextDocId: body.doc_id } : {}),
    })
  })

  app.post('/api/copilot/clear', c => {
    const user = c.get('user')
    const doc = getOrCreateCopilotDoc(user)
    store.clearDocTurns(doc.id)
    return c.json({ ok: true, doc_id: doc.id })
  })

  // —— 资产 ——

  // —— 图库（Unsplash）：搜索、插入幻灯片（与 MCP image_search / slide_add_photo 同一个服务） ——
  const imageFailure = (c: Context, err: unknown) => {
    if (err instanceof UnsplashError) return c.json({ error: err.message, code: err.code }, err.status)
    throw err
  }
  app.get('/api/images', c => c.json({ configured: deps.images?.configured ?? false, source: 'unsplash' }))
  app.get('/api/images/search', async c => {
    if (!deps.images?.configured) return c.json({ error: '图库未配置', code: 'unsplash_unconfigured' }, 503)
    try { return c.json(await deps.images.search(c.req.query('q') ?? '', Number(c.req.query('page') ?? 1) || 1)) } catch (err) { return imageFailure(c, err) }
  })
  app.post('/api/docs/:id/slides/:slide/photo', async c => {
    if (!deps.images?.configured) return c.json({ error: '图库未配置', code: 'unsplash_unconfigured' }, 503)
    const body = await c.req.json<{ photo_id?: string; x?: number; y?: number; w?: number }>().catch(() => ({} as { photo_id?: string }))
    if (typeof body.photo_id !== 'string') return c.json({ error: '缺少 photo_id' }, 400)
    try {
      return c.json(await deps.images.addToSlide(c.get('user'), { doc_id: c.req.param('id'), slide_id: c.req.param('slide'), photo_id: body.photo_id }, { actor: 'user', turnId: null }), 201)
    } catch (err) { return err instanceof OpError ? c.json(err.toJSON(), 409) : imageFailure(c, err) }
  })

  /** 用户在编辑器里插图：上传图片为资产（导出 docx 支持 png / jpeg / gif）。 */
  app.post('/api/docs/:id/assets', async c => {
    const row = owned(c)
    if (!row) return c.json({ error: 'not found' }, 404)
    const form = await c.req.parseBody()
    const file = form.file instanceof File ? form.file : null
    if (!file || file.size <= 0) return c.json({ error: '图片文件为空' }, 400)
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) return c.json({ error: '只支持 png / jpg / gif / webp 图片' }, 400)
    if (file.size > 10 * 1024 * 1024) return c.json({ error: '图片超过 10MB' }, 400)
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.length === 0) return c.json({ error: '图片数据为空' }, 400)
    const asset = store.putAsset({ owner: c.get('user'), mime: file.type, name: file.name, bytes })
    return c.json({ asset_id: asset.id, name: asset.name }, 201)
  })

  app.get('/api/assets/:id/provenance', c => {
    const asset = store.getAsset(c.req.param('id'))
    if (!asset || !access.canAsset(c.get('user'), asset)) return c.json({ error: 'not found' }, 404)
    return c.json(store.getAssetProvenance(asset.id))
  })
  app.get('/api/assets/:id', c => {
    // 带图模板的内置照片（公开授权，任何登录用户可取）
    const builtin = themePhoto(c.req.param('id'))
    if (builtin) return c.body(Buffer.from(builtin.bytes), 200, { 'Content-Type': builtin.mime, 'Cache-Control': 'public, max-age=86400' })
    // 机构院徽：只给本机构成员
    const logo = orgLogo(c.req.param('id'), c.get('user'))
    if (logo) return c.body(Buffer.from(logo.bytes), 200, { 'Content-Type': logo.mime, 'Cache-Control': 'private, no-cache' })
    const asset = store.getAsset(c.req.param('id'))
    if (!asset || asset.size <= 0 || !access.canAsset(c.get('user'), asset)) return c.json({ error: 'not found' }, 404)
    const bytes = store.getAssetBytes(asset.id)
    if (!bytes || bytes.length === 0) return c.json({ error: 'not found' }, 404)
    return c.body(Buffer.from(bytes), 200, { 'Content-Type': asset.mime, 'Cache-Control': 'private, max-age=31536000, immutable' })
  })

  // —— AI 发起、等用户确认的高风险操作（docs/design/AI_PERMISSIONS.md）——
  // 确认 / 拒绝只接受用户本人的登录会话：进程内的 AI 调用（MCP）一律拒绝，AI 不能确认自己发起的操作
  const ACTION_TTL_MS = 24 * 3600_000
  const actionView = (a: NonNullable<ReturnType<typeof store.getPendingAction>>) => ({
    id: a.id, tool: a.tool, action: a.action, summary: a.summary, reason: a.reason, status: a.status, doc_id: a.doc_id,
    editable: a.editable ? JSON.parse(a.editable) as Record<string, string> : null, result: a.result ? JSON.parse(a.result) as unknown : null,
    created_at: a.created_at, decided_at: a.decided_at, expires_at: new Date(Date.parse(a.created_at) + ACTION_TTL_MS).toISOString(),
  })
  app.get('/api/actions', c => {
    store.expirePendingActions(ACTION_TTL_MS)
    const status = c.req.query('status')
    return c.json(store.listPendingActions(c.get('user'), status || undefined).map(actionView))
  })
  app.get('/api/actions/:aid', c => {
    store.expirePendingActions(ACTION_TTL_MS)
    const a = store.getPendingAction(c.req.param('aid'))
    if (!a || a.user_id !== c.get('user')) return c.json({ error: '没有这条待确认操作' }, 404)
    return c.json(actionView(a))
  })
  app.post('/api/actions/:aid/:decision{confirm|reject}', async c => {
    if (viaByReq.get(c.req.raw)) return c.json({ error: 'AI 不能确认或拒绝操作，只能由用户本人在界面上决定', code: 'human_only' }, 403)
    store.expirePendingActions(ACTION_TTL_MS)
    const user = c.get('user')
    const a = store.getPendingAction(c.req.param('aid'))
    if (!a || a.user_id !== user) return c.json({ error: '没有这条待确认操作' }, 404)
    if (a.status !== 'pending') return c.json({ error: a.status === 'expired' ? '已超过 24 小时，操作已过期；需要的话请让 AI 重新发起' : '这条操作已经处理过了', code: a.status }, 409)
    if (c.req.param('decision') === 'reject') {
      store.setPendingActionStatus(a.id, 'pending', 'rejected', { decided_by: user })
      audit(c, 'ai.action_reject', { detail: `${a.tool}.${a.action}：${a.summary}` })
      return c.json(actionView(store.getPendingAction(a.id)!))
    }
    // 用户可以改确认卡上的字段（例如紧急访问的理由）
    const edits = ((await c.req.json().catch(() => ({}))) as { fields?: Record<string, unknown> }).fields ?? {}
    const editable = a.editable ? Object.keys(JSON.parse(a.editable) as object) : []
    const stored = a.body ? JSON.parse(a.body) as { json?: Record<string, unknown>; bytes_b64?: string; mime?: string; form?: Record<string, string>; file?: { b64: string; name: string; mime: string } } : null
    if (stored?.json && editable.length) for (const k of editable) if (typeof edits[k] === 'string') stored.json[k] = edits[k]
    // 先占住状态，防止同一条被确认两次
    if (!store.setPendingActionStatus(a.id, 'pending', 'running', { decided_by: user, body: stored ? JSON.stringify(stored) : null })) return c.json({ error: '这条操作已经处理过了' }, 409)
    const body = !stored ? undefined
      : stored.json !== undefined ? { json: stored.json }
      : stored.bytes_b64 !== undefined ? { bytes: new Uint8Array(Buffer.from(stored.bytes_b64, 'base64')), mime: stored.mime ?? 'application/octet-stream' }
      : { form: stored.form ?? {}, ...(stored.file ? { file: { bytes: new Uint8Array(Buffer.from(stored.file.b64, 'base64')), name: stored.file.name, mime: stored.file.mime } } : {}) }
    const r = await invoke(user, a.method, a.path, body, { via: 'ai-confirmed', confirmedBy: user })
    const result = { status: r.status, ok: r.ok, response: r.json ?? (r.text ? r.text.slice(0, 2000) : null) }
    store.setPendingActionStatus(a.id, 'running', r.ok ? 'done' : 'failed', { result: JSON.stringify(result), decided_by: user })
    audit(c, 'ai.action_confirm', { detail: `${a.tool}.${a.action}：${a.summary}（${r.status}）`, status: r.status })
    return c.json(actionView(store.getPendingAction(a.id)!), r.ok ? 200 : 422)
  })

  // —— 邮件工作流与日历排期 ——
  registerMailCalendarRoutes(app, {
    store,
    docs,
    mail,
    calendar,
    kb: deps.kb,
    projectOf,
    me,
    pt,
  })

  return app
}

/**
 * 对话 / 评论触发的回合。默认以 SSE 返回本回合事件（API 调用方）；`?async=1` 立即返回 202，
 * 事件经文档流（/stream）推送（页面用这种方式，自动触发的回合也走同一条路）。
 */
function streamTurn(c: Context<{ Variables: { user: string } }>, deps: ApiDeps, docId: string, message: string, opts: TurnOptions = {}) {
  const user = c.get('user')
  if (c.req.query('async')) {
    const wasBusy = opts.lane === 'copilot' ? deps.turns.isCopilotBusy(user) : deps.turns.isBusy(user, docId)
    void deps.turns.submit(user, docId, message, undefined, opts)
    const queued = wasBusy || deps.turns.queueIds(user).includes(docId)
    return c.json({ queued }, 202)
  }
  return streamSSE(c, async stream => {
    // 串行写出，结束前等全部写完
    let writes = Promise.resolve()
    const emit = (e: unknown) => { writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(e) })).catch(() => {}) }
    await deps.turns.submit(user, docId, message, emit, opts)
    await writes
  })
}
