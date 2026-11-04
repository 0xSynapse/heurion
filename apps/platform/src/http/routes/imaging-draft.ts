import type { Context, Hono } from 'hono'
import { MeasurementError } from '../../measurements/service.ts'
import { OpError } from '../../ops/types.ts'
import { DraftError, type FindingsDraftService } from '../../imaging/findings-draft.ts'
import { ImagingError } from '../../imaging/studies.ts'
import type { Actor } from '../../tenancy/patients.ts'

export interface ImagingDraftRouteContext {
  audit: (c: Context, action: string, e?: { actor?: string | null; target?: string | null; detail?: string | null; status?: number }) => void
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  drafts: (c: Context<{ Variables: { user: string } }>) => FindingsDraftService
  patientFailure: (c: Context, err: unknown) => Response
}

/** 草稿 / 模板 / 测量的错误统一成 {error, code, ...}；其余交给患者模块的错误处理 */
export function draftFailure(c: Context, err: unknown, patientFailure: (c: Context, err: unknown) => Response): Response {
  if (err instanceof DraftError) return c.json({ error: err.message, code: err.code, ...err.extra }, err.status)
  if (err instanceof ImagingError) return c.json({ error: err.message, code: err.code }, err.status)
  if (err instanceof MeasurementError) return c.json({ error: err.message, code: err.code, hint: err.hint ?? null }, err.status)
  // 写前守卫拒绝了生成的内容（例如病灶位置文字里带了测量数字）：如实返回守卫的结论
  if (err instanceof OpError) return c.json({ error: err.message, code: err.code, ...err.extra }, 409)
  return patientFailure(c, err)
}

/**
 * 所见草稿（T2.6，docs/design/IMAGING_STUDIES.md「所见草稿（T2.6）」）。
 * - 模板：读给界面与 AI（imaging_findings_templates）；保存新版本只给机构管理员 / 本科室审核医师本人（NOT_FOR_AI，服务层同样拒绝 via=ai）。
 * - 生成：界面按钮与 AI（imaging_findings_draft）同一个服务；写入经操作层与全部写前守卫。
 * 复制为 RIS 纯文本（GET /api/docs/:id/ris-text）在 api.ts 里注册（要用文档路由的访问判定与测量取值）。
 */
export function registerImagingDraftRoutes(app: Hono<{ Variables: { user: string } }>, ctx: ImagingDraftRouteContext): void {
  const { me, drafts, audit } = ctx
  const fail = (c: Context, err: unknown) => draftFailure(c, err, ctx.patientFailure)

  /** 本机构的所见模板：机构默认、各科室、内置模板；我能改哪些；占位符说明 */
  app.get('/api/imaging/findings-templates', c => {
    try { return c.json(drafts(c).templates.list(me(c))) } catch (err) { return fail(c, err) }
  })

  /** 一个模板的全部版本（scope = org 或 dept:<科室 id>） */
  app.get('/api/imaging/findings-templates/versions', c => {
    try { return c.json(drafts(c).templates.history(me(c), c.req.query('scope') ?? 'org')) } catch (err) { return fail(c, err) }
  })

  /** 保存模板的新版本（只追加；旧版本保留，草稿记下用的是哪一版） */
  app.put('/api/imaging/findings-templates', async c => {
    try {
      const body = await c.req.json().catch(() => ({})) as { scope?: unknown; body?: unknown; note?: unknown }
      const scope = typeof body.scope === 'string' ? body.scope : 'org'
      const r = drafts(c).templates.save(me(c), scope, body.body, body.note)
      audit(c, 'imaging.findings_template', { target: r.id, detail: JSON.stringify({ scope, version: r.version }) })
      return c.json(r, 201)
    } catch (err) { return fail(c, err) }
  })

  /** 生成所见草稿：body.doc_id = 更新已有草稿（只改没人动过的段落）；body.new = 已有草稿时仍新建；body.department_id = 用哪个科室的模板；body.confirm_guideline_reference = 医生本人确认把指南分级/随访建议参考附入草稿 */
  app.post('/api/patients/:ptid/imaging/studies/:stid/findings-draft', async c => {
    try {
      const body = await c.req.json().catch(() => ({})) as { doc_id?: unknown; new?: unknown; department_id?: unknown; confirm_guideline_reference?: unknown }
      const r = drafts(c).generate(me(c), c.req.param('ptid'), {
        study_id: c.req.param('stid'),
        doc_id: typeof body.doc_id === 'string' && body.doc_id ? body.doc_id : null,
        new: body.new === true,
        department_id: typeof body.department_id === 'string' && body.department_id ? body.department_id : null,
        confirm_guideline_reference: body.confirm_guideline_reference === true,
      }, { turnId: null })
      return c.json(r, r.created ? 201 : 200)
    } catch (err) { return fail(c, err) }
  })
}
