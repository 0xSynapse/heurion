import type { Context, Hono } from 'hono'
import type { Store } from '../../store/db.ts'
import type { Actor, PatientService } from '../../tenancy/patients.ts'
import { ImagingError } from '../../imaging/studies.ts'
import { ImagingReviewService } from '../../imaging/review.ts'
import type { ImagingMetricsService } from '../../imaging/metrics.ts'

export interface ImagingReviewRouteContext {
  audit: (c: Context, action: string, e?: { actor?: string | null; target?: string | null; detail?: string | null; status?: number }) => void
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  pt: (c: Context<{ Variables: { user: string } }>) => PatientService
  patientFailure: (c: Context, err: unknown) => Response
  store: Store
  /** 分析流水线里这次运行是否真的在跑（服务重启后库里残留的排队 / 处理中不算，不挡定稿） */
  isRunActive: (runId: string) => boolean
  /** 效率埋点（T2.10）：医生打开审核视图的时刻；不给时不记 */
  metrics?: (c: Context<{ Variables: { user: string } }>) => ImagingMetricsService
}

/**
 * 影像审核视图与定稿（T2.7，docs/design/IMAGING_STUDIES.md「审核与定稿」）。
 * 读（审核视图、审核状态、定稿快照）给界面与 AI（imaging_review）；初写完成、定稿、阅片角色只给医生本人（NOT_FOR_AI，服务层同样拒绝 via=ai）。
 */
export function registerImagingReviewRoutes(app: Hono<{ Variables: { user: string } }>, ctx: ImagingReviewRouteContext): void {
  const { me, pt, audit, store } = ctx
  const svc = (c: Context<{ Variables: { user: string } }>) => new ImagingReviewService(pt(c), u => store.getUser(u)?.display_name ?? null)
  const fail = (c: Context, err: unknown) => err instanceof ImagingError ? c.json({ error: err.message, code: err.code }, err.status) : ctx.patientFailure(c, err)
  /** 路径里的检查必须属于路径里的患者 */
  const ownStudy = (c: Context<{ Variables: { user: string } }>) => {
    const ptid = c.req.param('ptid')!, stid = c.req.param('stid')!
    if (!svc(c).summaries(me(c), ptid).some(s => s.study_id === stid)) throw new ImagingError('not_found', '影像检查不存在', 404)
    return stid
  }

  /** 患者各检查的审核状态（初写中 / 待审核 / 已定稿 / 定稿后修改中） */
  app.get('/api/patients/:ptid/imaging/reviews', c => {
    try { return c.json(svc(c).summaries(me(c), c.req.param('ptid'))) } catch (err) { return fail(c, err) }
  })

  /** 审核视图（W5.1）：按病灶列 AI 原值、初写修改、审核修改、当前值；数据来自病灶留痕 */
  app.get('/api/patients/:ptid/imaging/studies/:stid/review', c => {
    try {
      const stid = ownStudy(c)
      const view = svc(c).view(me(c), stid, { isRunActive: ctx.isRunActive })
      // 埋点只记医生本人点开审核视图的那一次（opened=1）：患者页分析进行中每 5 秒刷新、操作后重新加载都会再请求这里，
      // 都记的话开着不动也会被算成审核耗时。AI 读 imaging_review 不经这里，经接口时 via = ai 也不记；失败不影响审核视图
      if (c.req.query('opened') === '1') try { ctx.metrics?.(c).recordReviewOpen(me(c), stid) } catch { /* 埋点尽力而为 */ }
      return c.json(view, 200, { 'Cache-Control': 'private, no-store' })
    } catch (err) { return fail(c, err) }
  })

  /** 某一次定稿的完整快照 */
  app.get('/api/patients/:ptid/imaging/studies/:stid/signoffs/:seq', c => {
    try {
      const stid = ownStudy(c)
      const ver = Number(c.req.param('seq'))
      if (!Number.isInteger(ver) || ver < 1) throw new ImagingError('bad_version', '定稿版本号不对')
      return c.json(svc(c).signoff(me(c), stid, ver))
    } catch (err) { return fail(c, err) }
  })

  /** 初写完成、提交审核（医生本人） */
  app.post('/api/patients/:ptid/imaging/studies/:stid/review/submit', async c => {
    try {
      const stid = ownStudy(c)
      const body = await c.req.json().catch(() => ({})) as { note?: unknown }
      const r = svc(c).submitRead(me(c), stid, body)
      audit(c, 'imaging.read_submit', { target: stid })
      return c.json(r)
    } catch (err) { return fail(c, err) }
  })

  /** 定稿（W5.2）：只允许审核医师本人；body.expected_revision = 审核视图里的 revision */
  app.post('/api/patients/:ptid/imaging/studies/:stid/finalize', async c => {
    try {
      const stid = ownStudy(c)
      const body = await c.req.json().catch(() => ({})) as { expected_revision?: unknown; note?: unknown }
      const r = svc(c).finalize(me(c), stid, body, { isRunActive: ctx.isRunActive })
      audit(c, 'imaging.finalize', { target: stid, detail: JSON.stringify({ signoff: r.id, version: r.version, mode: r.mode, lesions: r.lesions, hash: r.snapshot_hash }) })
      return c.json(r, 201)
    } catch (err) { return fail(c, err) }
  })

  /** 阅片角色（机构管理员）：初写 reader / 审核 reviewer */
  app.get('/api/imaging/reading-roles', c => {
    try { return c.json(svc(c).readingRoles(me(c))) } catch (err) { return fail(c, err) }
  })
  app.put('/api/imaging/reading-roles/:uid', async c => {
    try {
      const uid = c.req.param('uid')
      const body = await c.req.json().catch(() => ({})) as { role?: unknown }
      const r = svc(c).setReadingRole(me(c), uid, body.role, (u, tenantId) => store.getUser(u)?.tenant_id === tenantId)
      audit(c, 'imaging.reading_role', { target: uid, detail: r.role })
      return c.json(r)
    } catch (err) { return fail(c, err) }
  })
}
