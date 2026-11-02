import type { Context, Hono } from 'hono'
import type { Actor } from '../../tenancy/patients.ts'
import { ImagingError } from '../../imaging/studies.ts'
import type { ImagingFollowup } from '../../imaging/followup.ts'

/**
 * 随访对比（T2.4，docs/design/IMAGING_STUDIES.md「随访对比」）的接口。
 * 读：主站 GET …/studies/:stid/followup（AI 用 imaging_followup 只读）；阅片器子域名 GET /api/viewer/followup。
 * 写（重新匹配、拆开、重新对应）只给医生本人：服务层拒绝 via = ai；阅片器上另要求 Cookie 允许的检查与 X-Heurion-Viewer 请求头。
 */

type Ctx = Context<{ Variables: { user: string } }>

export interface FollowupRouteContext {
  me: (c: Ctx) => Actor
  fail: (c: Context, err: unknown) => Response
  /** null 时接口返回 503（患者模块未启用） */
  followup: ImagingFollowup | null
}

const UID = /^[0-9.]{1,64}$/
const ID = /^[a-z]{2}[0-9a-f]{12}$/

const svcOf = (f: ImagingFollowup | null): ImagingFollowup => {
  if (!f) throw new ImagingError('followup_off', '随访对比未启用', 503)
  return f
}

/** 请求体里的病灶 id：可为 null（表示「没有对应」），其余格式不对时 400 */
function lesionIdOf(raw: unknown, name: string): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw !== 'string' || !ID.test(raw)) throw new ImagingError('bad_lesion', `${name} 格式不对`)
  return raw
}

export function registerFollowupRoutes(app: Hono<{ Variables: { user: string } }>, ctx: FollowupRouteContext): void {
  const { me, fail } = ctx
  /** 检查要属于路径里的患者（看不到的一律当不存在） */
  const owned = (c: Ctx, f: ImagingFollowup) => {
    const stid = c.req.param('stid')!
    if (f.studyPatient(me(c), stid) !== c.req.param('ptid')) throw new ImagingError('not_found', '影像检查不存在', 404)
    return stid
  }

  app.get('/api/patients/:ptid/imaging/studies/:stid/followup', c => {
    try {
      const f = svcOf(ctx.followup)
      return c.json(f.view(me(c), owned(c, f)), 200, { 'Cache-Control': 'private, no-store' })
    } catch (err) { return fail(c, err) }
  })
  /** 重新匹配（前片里新确认了结节、或医生修改了测量之后） */
  app.post('/api/patients/:ptid/imaging/studies/:stid/followup/rematch', c => {
    try {
      const f = svcOf(ctx.followup)
      const row = f.schedule(me(c), owned(c, f), 'manual')
      return c.json({ followup_id: row.id, status: row.status }, 202)
    } catch (err) { return fail(c, err) }
  })
  /** 重新对应：{lesion_id, prior_lesion_id}，任一为 null 表示「没有对应」（新发 / 消失） */
  app.post('/api/patients/:ptid/imaging/studies/:stid/followup/links', async c => {
    try {
      const f = svcOf(ctx.followup)
      const stid = owned(c, f)
      const b = await c.req.json().catch(() => ({})) as { lesion_id?: unknown; prior_lesion_id?: unknown }
      return c.json(f.relink(me(c), stid, lesionIdOf(b.lesion_id, 'lesion_id'), lesionIdOf(b.prior_lesion_id, 'prior_lesion_id')))
    } catch (err) { return fail(c, err) }
  })
  /** 拆开一对对应 */
  app.post('/api/patients/:ptid/imaging/followup-links/:lkid/unlink', c => {
    try {
      const f = svcOf(ctx.followup)
      const lkid = c.req.param('lkid')
      if (f.linkStudy(me(c), lkid).patientId !== c.req.param('ptid')) throw new ImagingError('not_found', '对应关系不存在', 404)
      return c.json(f.unlink(me(c), lkid))
    } catch (err) { return fail(c, err) }
  })
}

export interface FollowupViewerContext {
  /** 阅片器 Cookie 换出的医生身份与允许的检查；null = 未登录 */
  viewerActor: (c: Context) => { a: Actor; allowed: string[] } | null
  unauthorized: (c: Context) => Response
  fail: (c: Context, err: unknown) => Response
  followup: ImagingFollowup | null
}

/** 阅片器子域名上的随访对比接口（registerDicomRoutes 在兜底 404 之前挂上） */
export function registerFollowupViewerRoutes(surface: Hono, ctx: FollowupViewerContext): void {
  const { viewerActor, unauthorized, fail } = ctx
  const studyUidIn = (allowed: string[], raw: unknown) => {
    const uid = typeof raw === 'string' ? raw : ''
    if (!UID.test(uid) || !allowed.includes(uid)) throw new ImagingError('not_found', '影像检查不存在', 404)
    return uid
  }
  const write = (c: Context) => {
    const v = viewerActor(c)
    if (!v) return unauthorized(c)
    if (c.req.header('x-heurion-viewer') !== '1') return c.json({ error: '缺少阅片器请求头', code: 'forbidden' }, 403)
    return v
  }

  surface.get('/api/viewer/followup', c => {
    const v = viewerActor(c)
    if (!v) return unauthorized(c)
    try {
      const f = svcOf(ctx.followup)
      return c.json(f.viewByUid(v.a, studyUidIn(v.allowed, c.req.query('StudyInstanceUID'))), 200, { 'Cache-Control': 'private, no-store' })
    } catch (err) { return fail(c, err) }
  })
  surface.post('/api/viewer/followup/rematch', async c => {
    const v = write(c)
    if (v instanceof Response) return v
    try {
      const f = svcOf(ctx.followup)
      const b = await c.req.json().catch(() => ({})) as { study_uid?: unknown }
      const row = f.schedule(v.a, f.studyIdByUid(v.a, studyUidIn(v.allowed, b.study_uid)), 'manual')
      return c.json({ followup_id: row.id, status: row.status }, 202)
    } catch (err) { return fail(c, err) }
  })
  surface.post('/api/viewer/followup/links', async c => {
    const v = write(c)
    if (v instanceof Response) return v
    try {
      const f = svcOf(ctx.followup)
      const b = await c.req.json().catch(() => ({})) as { study_uid?: unknown; lesion_id?: unknown; prior_lesion_id?: unknown }
      const stid = f.studyIdByUid(v.a, studyUidIn(v.allowed, b.study_uid))
      return c.json(f.relink(v.a, stid, lesionIdOf(b.lesion_id, 'lesion_id'), lesionIdOf(b.prior_lesion_id, 'prior_lesion_id')))
    } catch (err) { return fail(c, err) }
  })
  surface.post('/api/viewer/followup/links/:lkid/unlink', c => {
    const v = write(c)
    if (v instanceof Response) return v
    try {
      const f = svcOf(ctx.followup)
      const lkid = c.req.param('lkid')!
      if (!v.allowed.includes(f.linkStudy(v.a, lkid).studyUid)) throw new ImagingError('not_found', '对应关系不存在', 404)
      return c.json(f.unlink(v.a, lkid))
    } catch (err) { return fail(c, err) }
  })
}
