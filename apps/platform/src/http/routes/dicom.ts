import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { Actor, PatientService } from '../../tenancy/patients.ts'
import type { Orthanc } from '../../imaging/orthanc.ts'
import { ImagingError, ImagingStudyService, type StudyView } from '../../imaging/studies.ts'
import { TASKS, type EnqueueResult, type ImagingPipeline, type ImagingTask } from '../../imaging/pipeline.ts'
import { parsePoints, type ImagingInteractive } from '../../imaging/interactive.ts'

export interface DicomRouteContext {
  audit: (c: Context, action: string, e?: { actor?: string | null; target?: string | null; detail?: string | null; status?: number }) => void
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  pt: (c: Context<{ Variables: { user: string } }>) => PatientService
  patientFailure: (c: Context, err: unknown) => Response
  /** 没配置时上传与 DICOMweb 返回 503 */
  orthanc: Orthanc | null
  /** 分析流水线；null 时上传后不自动分析 */
  pipeline: ImagingPipeline | null
  /** 阅片器点选分割（T2.3）；null 时阅片器里不能点选 */
  interactive: ImagingInteractive | null
  /** 阅片器令牌（auth/accounts.ts）：viewer = 一次性票据，dicomweb = 阅片器子域名上的 Cookie */
  viewerTokens: {
    issue: (userId: string, aud: 'viewer' | 'dicomweb', ttlSeconds: number, docs: '*' | string[]) => string | null
    verify: (token: string | null | undefined, aud: 'viewer' | 'dicomweb') => { userId: string; docs: '*' | string[]; exp: number } | null
  }
}

/** 阅片器子域名（如 viewer.heurion.org，本机联调可用 127.0.0.1:端口）；没配置时不开放阅片器 */
export const viewerHostOf = () => (process.env.VIEWER_HOST || '').trim().toLowerCase() || null
/** OHIF 静态站点（deploy/viewer 构建的镜像）；阅片器子域名上的页面请求都转发到这里 */
const viewerUrl = () => (process.env.VIEWER_URL || '').replace(/\/+$/, '')
/** 阅片器子域名上的 Cookie：只发往那里的 /api（子域名上 /api 下只有只读 DICOMweb 与结节面板接口），HttpOnly、SameSite=Strict */
export const VIEWER_COOKIE = 'hv_dicomweb'
const VIEWER_COOKIE_TTL = 4 * 3600
const TICKET_TTL = 60
/** 一张 Cookie 最多记住的检查数（每打开一个检查加一个） */
const VIEWER_MAX_STUDIES = 20

/** 单次上传上限（MB），默认 2048；整次请求在内存里解析，过大的检查请分批上传 */
const uploadMaxBytes = () => Math.max(1, Number(process.env.IMAGING_UPLOAD_MAX_MB) || 2048) * 1024 * 1024

/** DICOMweb 路径：只允许 /studies/<UID>[/...]，字符白名单，不允许 .. */
const DICOMWEB_PATH = /^\/studies\/([0-9.]{1,64})((?:\/[A-Za-z0-9._-]+)*)$/
const UID = /^[0-9.]{1,64}$/

/**
 * 影像检查（docs/design/IMAGING_STUDIES.md）：手工上传 DICOM、检查列表、DICOMweb 鉴权代理、阅片器入口。
 * DICOMweb 只读、只转发能看到的患者的检查，供 OHIF 阅片；体素数据不经 AI。
 * 返回阅片器子域名的请求处理函数（buildApi 按 Host 分流到这里）。
 */
export function registerDicomRoutes(app: Hono<{ Variables: { user: string } }>, ctx: DicomRouteContext): (c: Context) => Promise<Response> {
  const { me, pt, patientFailure, audit } = ctx
  const svc = (c: Context<{ Variables: { user: string } }>) => new ImagingStudyService(pt(c), ctx.orthanc)
  const fail = (c: Context, err: unknown) => err instanceof ImagingError ? c.json({ error: err.message, code: err.code }, err.status) : patientFailure(c, err)

  /** 手工上传 DICOM（W1.0）：表单字段 files，可多个；单个 DICOM 文件或 zip（文件夹在浏览器端打包或逐个上传） */
  app.post('/api/patients/:ptid/imaging/dicom', async c => {
    try {
      const declared = Number(c.req.header('content-length') || 0)
      if (declared > uploadMaxBytes()) throw new ImagingError('upload_too_large', `单次上传不能超过 ${Math.round(uploadMaxBytes() / 1048576)} MB，请分批上传`, 413)
      const form = await c.req.parseBody({ all: true })
      const raw = form.files ?? form.file
      const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File)
      if (!list.length) throw new ImagingError('no_files', '请选择 DICOM 文件或 zip 压缩包')
      const total = list.reduce((n, f) => n + f.size, 0)
      if (total > uploadMaxBytes()) throw new ImagingError('upload_too_large', `单次上传不能超过 ${Math.round(uploadMaxBytes() / 1048576)} MB，请分批上传`, 413)
      const files = await Promise.all(list.map(async f => ({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))
      const ptid = c.req.param('ptid')
      const result = await svc(c).importDicom(me(c), ptid, files)
      audit(c, 'imaging.dicom_upload', { target: ptid, detail: JSON.stringify({ studies: result.studies.length, uploaded: result.files.uploaded, duplicates: result.files.duplicates, skipped: result.files.skipped.length, conflicts: result.conflicts }) })
      // 入库即分析（W1）：有新实例的检查自动排队；不适用的检查说明原因
      const analysis = result.files.uploaded > 0 ? result.studies.map(st => ({ study_id: st.id, ...enqueue(c, st.id, 'lung_nodule') })) : []
      return c.json({ ...result, analysis: analysis.map(x => ({ study_id: x.study_id, task: x.task, run_id: x.run?.id ?? null, skipped: x.skipped ?? null, notes: x.notes ?? [] })) }, 201)
    } catch (err) { return fail(c, err) }
  })

  const enqueue = (c: Context<{ Variables: { user: string } }>, studyId: string, task: ImagingTask): EnqueueResult => {
    if (!ctx.pipeline) return { task, skipped: '影像分析服务未启用' }
    return ctx.pipeline.enqueue(me(c), studyId, task)
  }

  /** 服务重启后，库里还是排队 / 处理中、但本进程没有在跑的运行，显示为中断 */
  const withLiveStatus = (list: StudyView[]) => list.map(st => ({
    ...st,
    runs: st.runs.map(r => (r.status === 'queued' || r.status === 'running') && !ctx.pipeline?.isActive(r.id)
      ? { ...r, status: 'interrupted' as const, error: r.error ?? '服务重启，分析中断，请重新分析' }
      : r.status === 'queued' ? { ...r, waiting_ahead: ctx.pipeline?.waitingAhead(r.id) ?? null } : r),
  }))

  app.get('/api/patients/:ptid/imaging/studies', c => {
    try { return c.json(withLiveStatus(svc(c).listStudies(me(c), c.req.param('ptid'), true))) } catch (err) { return fail(c, err) }
  })

  /** 对一个检查（重新）发起 AI 分析；body.task 缺省为肺结节 */
  app.post('/api/patients/:ptid/imaging/studies/:stid/analyze', async c => {
    try {
      const body = await c.req.json().catch(() => ({})) as { task?: string }
      const task = (body.task ?? 'lung_nodule') as ImagingTask
      if (!TASKS[task]) throw new ImagingError('bad_task', `不支持的分析任务：${body.task}`)
      const ptid = c.req.param('ptid'), stid = c.req.param('stid')
      if (!svc(c).listStudies(me(c), ptid).some(s => s.id === stid)) throw new ImagingError('not_found', '影像检查不存在', 404)
      const r = enqueue(c, stid, task)
      if (r.skipped) return c.json({ error: r.skipped, code: 'not_applicable', task }, 409)
      return c.json({ task, run_id: r.run!.id, status: r.run!.status, notes: r.notes ?? [] }, 202)
    } catch (err) { return fail(c, err) }
  })

  // —— 病灶（W2.3）：列表给界面与 AI；确认 / 否决只给医生（服务层拒绝 via=ai） ——

  const REVIEW_REASONS = ['血管断面', '纤维灶 / 瘢痕', '钙化灶', '淋巴结', '伪影', '其他']
  /** 确认 / 否决的请求体：否决必须选原因（W2.3） */
  const reviewBody = async (c: Context): Promise<{ status: 'confirmed' | 'rejected'; reason: string | null }> => {
    const b = await c.req.json().catch(() => ({})) as { status?: string; reason?: string }
    if (b.status !== 'confirmed' && b.status !== 'rejected') throw new ImagingError('bad_status', 'status 只能是 confirmed 或 rejected')
    const reason = b.status === 'rejected' ? String(b.reason ?? '').trim().slice(0, 200) : ''
    if (b.status === 'rejected' && !reason) throw new ImagingError('reason_required', `否决须选原因：${REVIEW_REASONS.join('、')}`)
    return { status: b.status, reason: reason || null }
  }

  app.get('/api/patients/:ptid/imaging/studies/:stid/lesions', c => {
    try {
      const ptid = c.req.param('ptid'), stid = c.req.param('stid')
      if (!svc(c).listStudies(me(c), ptid).some(s => s.id === stid)) throw new ImagingError('not_found', '影像检查不存在', 404)
      return c.json(svc(c).listLesions(me(c), stid))
    } catch (err) { return fail(c, err) }
  })

  app.post('/api/patients/:ptid/imaging/lesions/:lid/review', async c => {
    try {
      const lid = c.req.param('lid')
      if (svc(c).lesionOwner(me(c), lid).patientId !== c.req.param('ptid')) throw new ImagingError('not_found', '病灶不存在', 404)
      const body = await reviewBody(c)
      return c.json(svc(c).reviewLesion(me(c), lid, body))
    } catch (err) { return fail(c, err) }
  })

  const forward = async (c: Context, path: string, query: string) => {
    if (!ctx.orthanc) throw new ImagingError('orthanc_not_configured', '本机构没有配置影像存储（Orthanc）', 503)
    const resp = await ctx.orthanc.dicomweb(path, query, c.req.header('accept') ?? null, publicOrigin(c))
    const headers = new Headers({ 'Cache-Control': 'private, no-store' })
    for (const h of ['content-type', 'content-length']) { const v = resp.headers.get(h); if (v) headers.set(h, v) }
    return new Response(resp.body, { status: resp.status, headers })
  }
  const queryOf = (c: Context) => { const u = new URL(c.req.url); return u.search.slice(1) }
  const protoOf = (c: Context) => (c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')).split(',')[0]!.trim()
  /** 浏览器访问用的主机与协议（经 Caddy 时取其转发头）；字符不合法时不传，Orthanc 退回自己的地址 */
  const publicOrigin = (c: Context): { host: string; proto: string } | null => {
    const host = (c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host).split(',')[0]!.trim()
    const proto = protoOf(c)
    return /^[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(host) && /^https?$/.test(proto) ? { host, proto } : null
  }

  // —— DICOMweb：主站（Bearer 令牌）与阅片器子域名（Cookie）共用；allowed = Cookie 允许的检查（主站为全部可见的） ——

  /** QIDO-RS 检查查询：必须带 StudyInstanceUID，且每个都要能看到（不提供全库检索） */
  const qido = async (c: Context, a: Actor, allowed: '*' | string[]) => {
    try {
      const uids = (c.req.query('StudyInstanceUID') ?? '').split(/[,\\]/).map(s => s.trim()).filter(Boolean)
      // 阅片器（allowed 为具体检查）会按患者 ID 查「同一患者的检查」，并用结果列出左侧检查栏：
      // 不做全库检索，只在这张 Cookie 允许的检查里查（Orthanc 再按原查询条件过滤；UID 列表用逗号分隔）
      if (!uids.length && allowed !== '*') {
        const q = new URLSearchParams(queryOf(c))
        q.set('StudyInstanceUID', allowed.join(','))
        return await forward(c, '/studies', q.toString())
      }
      if (!uids.length) throw new ImagingError('study_uid_required', '请按 StudyInstanceUID 查询检查')
      for (const uid of uids) {
        if (!UID.test(uid)) throw new ImagingError('bad_uid', 'StudyInstanceUID 格式不对')
        if (allowed !== '*' && !allowed.includes(uid)) throw new ImagingError('not_found', '影像检查不存在', 404)
        const { studyId, scope } = svc(c as never).resolveStudyUid(a, uid)
        scope.log('dicomweb_view', studyId)
      }
      return await forward(c, '/studies', queryOf(c))
    } catch (err) { return fail(c, err) }
  }
  const wado = async (c: Context, a: Actor, allowed: '*' | string[]) => {
    try {
      const path = c.req.path.slice('/api/dicomweb'.length)
      const m = DICOMWEB_PATH.exec(path)
      if (!m || path.includes('..')) throw new ImagingError('bad_path', '不支持的 DICOMweb 路径')
      if (allowed !== '*' && !allowed.includes(m[1]!)) throw new ImagingError('not_found', '影像检查不存在', 404)
      svc(c as never).resolveStudyUid(a, m[1]!)
      return await forward(c, path, queryOf(c))
    } catch (err) { return fail(c, err) }
  }
  app.get('/api/dicomweb/studies', c => qido(c, me(c), '*'))
  app.get('/api/dicomweb/studies/:uid', c => wado(c, me(c), '*'))
  app.get('/api/dicomweb/studies/:uid/*', c => wado(c, me(c), '*'))

  // —— 阅片器（OHIF）：独立子域名，与主站不同源，读不到主站的登录令牌 ——

  /**
   * 主站上「在阅片器中打开」：校验能看到该检查后，签一张 60 秒、只能用一次、绑定该检查的票据，
   * 返回阅片器子域名上的入口地址（浏览器跳过去换取那里的只读 Cookie）。
   */
  app.post('/api/imaging/viewer-ticket', async c => {
    try {
      const a = me(c)
      if (a.via === 'ai') throw new ImagingError('forbidden', '阅片器只给医生本人在界面上打开', 403)
      const vh = viewerHostOf()
      if (!vh || !viewerUrl()) throw new ImagingError('viewer_not_configured', '阅片器还没有部署（VIEWER_HOST / VIEWER_URL 未配置）', 503)
      const { study_uid: uid } = await c.req.json().catch(() => ({})) as { study_uid?: string }
      if (!uid || !UID.test(uid)) throw new ImagingError('bad_uid', 'StudyInstanceUID 格式不对')
      svc(c).resolveStudyUid(a, uid)
      const ticket = ctx.viewerTokens.issue(a.userId, 'viewer', TICKET_TTL, [uid])
      if (!ticket) throw new ImagingError('forbidden', '账户状态不允许打开阅片器', 403)
      return c.json({ url: `${protoOf(c)}://${vh}/session?ticket=${encodeURIComponent(ticket)}`, expires_in: TICKET_TTL })
    } catch (err) { return fail(c, err) }
  })

  /** 已用过的票据（进程内，按过期时间清理）：票据只能换一次 Cookie */
  const usedTickets = new Map<string, number>()
  const surface = new Hono()
  const viewerActor = (c: Context): { a: Actor; allowed: string[] } | null => {
    const v = ctx.viewerTokens.verify(getCookie(c, VIEWER_COOKIE), 'dicomweb')
    return v && Array.isArray(v.docs) ? { a: { userId: v.userId, via: 'user', space: 'work' }, allowed: v.docs } : null
  }

  /** 票据换 Cookie：Cookie 记住这次及之前打开过的检查（同一用户），然后进入 OHIF 打开该检查 */
  surface.get('/session', c => {
    const now = Date.now() / 1000
    for (const [k, exp] of usedTickets) if (exp < now) usedTickets.delete(k)
    const raw = c.req.query('ticket') ?? ''
    const t = ctx.viewerTokens.verify(raw, 'viewer')
    if (!t || !Array.isArray(t.docs) || t.docs.length !== 1 || usedTickets.has(raw)) return c.text('阅片链接已失效，请回到患者页重新打开', 401)
    usedTickets.set(raw, t.exp)
    const uid = t.docs[0]!
    const prev = ctx.viewerTokens.verify(getCookie(c, VIEWER_COOKIE), 'dicomweb')
    const studies = [...new Set([uid, ...(prev && prev.userId === t.userId && Array.isArray(prev.docs) ? prev.docs : [])])].slice(0, VIEWER_MAX_STUDIES)
    const cookie = ctx.viewerTokens.issue(t.userId, 'dicomweb', VIEWER_COOKIE_TTL, studies)
    if (!cookie) return c.text('账户状态不允许打开阅片器', 403)
    setCookie(c, VIEWER_COOKIE, cookie, { path: '/api', httpOnly: true, sameSite: 'Strict', secure: protoOf(c) === 'https', maxAge: VIEWER_COOKIE_TTL })
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    return c.redirect(`/viewer?StudyInstanceUIDs=${encodeURIComponent(uid)}`)
  })
  const unauthorized = (c: Context) => c.json({ error: '阅片会话已过期，请回到患者页重新打开', code: 'unauthorized' }, 401)
  surface.get('/api/dicomweb/studies', c => { const v = viewerActor(c); return v ? qido(c, v.a, v.allowed) : unauthorized(c) })
  surface.get('/api/dicomweb/studies/:uid', c => { const v = viewerActor(c); return v ? wado(c, v.a, v.allowed) : unauthorized(c) })
  surface.get('/api/dicomweb/studies/:uid/*', c => { const v = viewerActor(c); return v ? wado(c, v.a, v.allowed) : unauthorized(c) })
  /** 结节面板：Cookie 允许的检查里的病灶（附序列 UID、关键层与病人坐标，供 OHIF 跳转） */
  surface.get('/api/viewer/lesions', c => {
    const v = viewerActor(c)
    if (!v) return unauthorized(c)
    try {
      const uid = c.req.query('StudyInstanceUID') ?? ''
      if (!UID.test(uid) || !v.allowed.includes(uid)) throw new ImagingError('not_found', '影像检查不存在', 404)
      return c.json({ lesions: svc(c as never).lesionsByStudyUid(v.a, uid), reject_reasons: REVIEW_REASONS }, 200, { 'Cache-Control': 'private, no-store' })
    } catch (err) { return fail(c, err) }
  })
  /**
   * 结节面板里确认 / 否决：只限 Cookie 允许的检查；要求自定义请求头（跨站表单与简单请求带不上，防 CSRF）。
   * 写入以医生本人身份（via=user）、经同一服务层校验诊疗组权限并留痕。
   */
  surface.post('/api/viewer/lesions/:lid/review', async c => {
    const v = viewerActor(c)
    if (!v) return unauthorized(c)
    if (c.req.header('x-heurion-viewer') !== '1') return c.json({ error: '缺少阅片器请求头', code: 'forbidden' }, 403)
    try {
      const lid = c.req.param('lid')
      if (!v.allowed.includes(svc(c as never).studyUidOfLesion(v.a, lid))) throw new ImagingError('not_found', '病灶不存在', 404)
      return c.json(svc(c as never).reviewLesion(v.a, lid, await reviewBody(c)))
    } catch (err) { return fail(c, err) }
  })

  // —— 点选补漏与修边界（T2.3）：与确认 / 否决相同的 Cookie、检查范围与自定义请求头要求 ——

  /** 阅片器写操作的公共校验：Cookie、请求头、点选服务已启用 */
  const viewerWrite = (c: Context): { a: Actor; allowed: string[]; it: ImagingInteractive } | Response => {
    const v = viewerActor(c)
    if (!v) return unauthorized(c)
    if (c.req.header('x-heurion-viewer') !== '1') return c.json({ error: '缺少阅片器请求头', code: 'forbidden' }, 403)
    if (!ctx.interactive) return c.json({ error: '影像分析服务未启用，不能点选分割', code: 'interactive_off' }, 503)
    return { ...v, it: ctx.interactive }
  }
  /** 以阅片器面板的形状返回病灶（附序列 UID 与 SEG 位置） */
  const viewerLesion = (c: Context, a: Actor, studyUid: string, lesionId: string) =>
    svc(c as never).lesionsByStudyUid(a, studyUid).find(l => l.id === lesionId) ?? null
  const studyUidIn = (allowed: string[], raw: unknown) => {
    const uid = typeof raw === 'string' ? raw : ''
    if (!UID.test(uid) || !allowed.includes(uid)) throw new ImagingError('not_found', '影像检查不存在', 404)
    return uid
  }
  const seriesUidOf = (raw: unknown) => {
    const uid = typeof raw === 'string' ? raw : ''
    if (!UID.test(uid)) throw new ImagingError('bad_uid', 'SeriesInstanceUID 格式不对')
    return uid
  }

  /** 预加载当前序列到影像服务（面板打开时调用），第一次点选不必等上传 */
  surface.post('/api/viewer/series/prepare', async c => {
    const w = viewerWrite(c)
    if (w instanceof Response) return w
    try {
      const b = await c.req.json().catch(() => ({})) as { study_uid?: unknown; series_uid?: unknown }
      return c.json(await w.it.prepare(w.a, studyUidIn(w.allowed, b.study_uid), seriesUidOf(b.series_uid)))
    } catch (err) { return fail(c, err) }
  })
  /** 补漏：在点击处分割一个结节，作为医生补充的病灶入库（点击处没有结构时 422 + 原因） */
  surface.post('/api/viewer/lesions/point', async c => {
    const w = viewerWrite(c)
    if (w instanceof Response) return w
    try {
      const b = await c.req.json().catch(() => ({})) as { study_uid?: unknown; series_uid?: unknown; points?: unknown }
      const studyUid = studyUidIn(w.allowed, b.study_uid)
      const l = await w.it.addAtPoints(w.a, studyUid, seriesUidOf(b.series_uid), parsePoints(b.points))
      return c.json(viewerLesion(c, w.a, studyUid, l.id), 201)
    } catch (err) { return fail(c, err) }
  })
  /** 修边界：追加正 / 负点（replace = true 时以给出的点为全部提示点）重新分割 */
  surface.post('/api/viewer/lesions/:lid/refine', async c => {
    const w = viewerWrite(c)
    if (w instanceof Response) return w
    try {
      const lid = c.req.param('lid')
      const studyUid = svc(c as never).studyUidOfLesion(w.a, lid)
      if (!w.allowed.includes(studyUid)) throw new ImagingError('not_found', '病灶不存在', 404)
      const b = await c.req.json().catch(() => ({})) as { points?: unknown; replace?: unknown }
      const l = await w.it.refine(w.a, lid, parsePoints(b.points), b.replace === true)
      return c.json(viewerLesion(c, w.a, studyUid, l.id))
    } catch (err) { return fail(c, err) }
  })
  /** 撤销医生补充的病灶（AI 检出的请否决） */
  surface.post('/api/viewer/lesions/:lid/withdraw', async c => {
    const w = viewerWrite(c)
    if (w instanceof Response) return w
    try {
      const lid = c.req.param('lid')
      if (!w.allowed.includes(svc(c as never).studyUidOfLesion(w.a, lid))) throw new ImagingError('not_found', '病灶不存在', 404)
      const l = await w.it.withdraw(w.a, lid)
      return c.json({ id: l.id, status: l.status })
    } catch (err) { return fail(c, err) }
  })

  // 主站的其它接口在阅片器子域名上一律不存在
  surface.all('/api/*', c => c.json({ error: '不存在', code: 'not_found' }, 404))
  /** 其余请求都是 OHIF 的页面与静态文件（不含患者数据），转发到阅片器服务 */
  surface.on(['GET', 'HEAD'], '*', async c => {
    const base = viewerUrl()
    if (!base) return c.text('阅片器未部署（VIEWER_URL 未配置）', 503)
    const u = new URL(c.req.url)
    let resp: Response
    try {
      resp = await fetch(`${base}${u.pathname}${u.search}`, { method: c.req.method, signal: AbortSignal.timeout(30_000) })
    } catch {
      return c.text('阅片器服务连接失败', 502)
    }
    // fetch 已解压：不转发 content-encoding / content-length
    const headers = new Headers()
    for (const h of ['content-type', 'cache-control', 'etag', 'last-modified', 'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy']) {
      const v = resp.headers.get(h); if (v) headers.set(h, v)
    }
    return new Response(c.req.method === 'HEAD' ? null : resp.body, { status: resp.status, headers })
  })
  surface.all('*', c => c.text('不支持的请求', 405))

  return c => Promise.resolve(surface.fetch(c.req.raw))
}
