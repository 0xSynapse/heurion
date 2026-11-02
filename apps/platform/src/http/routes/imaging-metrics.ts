import type { Context, Hono } from 'hono'
import type { Actor } from '../../tenancy/patients.ts'
import { ImagingError } from '../../imaging/studies.ts'
import { ImagingMetricsService } from '../../imaging/metrics.ts'

export interface ImagingMetricsRouteContext {
  audit: (c: Context, action: string, e?: { actor?: string | null; target?: string | null; detail?: string | null; status?: number }) => void
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  metrics: (c: Context<{ Variables: { user: string } }>) => ImagingMetricsService
  patientFailure: (c: Context, err: unknown) => Response
}

/**
 * 影像效率统计（T2.10，docs/design/IMAGING_STUDIES.md「效率埋点（T2.10）」）：只给机构管理员本人在界面上看（NOT_FOR_AI，服务层拒绝 via=ai）。
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD&department=<科室 id>&format=csv。读取记机构审计 imaging.efficiency_report。
 * 埋点本身（打开阅片器、打开审核视图、复制 RIS 纯文本）在各自的路由里记，见 dicom.ts、imaging-review.ts、api.ts。
 */
export function registerImagingMetricsRoutes(app: Hono<{ Variables: { user: string } }>, ctx: ImagingMetricsRouteContext): void {
  const { me, metrics, audit } = ctx
  const fail = (c: Context, err: unknown) => err instanceof ImagingError ? c.json({ error: err.message, code: err.code }, err.status) : ctx.patientFailure(c, err)

  app.get('/api/imaging/efficiency-report', c => {
    try {
      const q = (k: string) => (c.req.query(k) ?? '').trim() || null
      const r = metrics(c).report(me(c), { from: q('from'), to: q('to'), department: q('department') })
      const csv = c.req.query('format') === 'csv'
      audit(c, 'imaging.efficiency_report', { detail: JSON.stringify({ from: r.period.from, to: r.period.to, department: r.department?.id ?? null, format: csv ? 'csv' : 'json', episodes: r.episodes.length }) })
      if (csv) {
        return c.body(ImagingMetricsService.csv(r), 200, {
          'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store',
          'Content-Disposition': `attachment; filename="imaging-efficiency-${r.period.from}_${r.period.to}.csv"`,
        })
      }
      return c.json(r, 200, { 'Cache-Control': 'private, no-store' })
    } catch (err) { return fail(c, err) }
  })
}
