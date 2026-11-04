import type { Context, Hono } from 'hono'
import { AnnotationCurationService } from '../../imaging/curation-gate.ts'
import { MrmcStudyService } from '../../imaging/mrmc-study.ts'
import {
  evaluatePneumoniaCtss,
  evaluateRibFractures,
  evaluateHeadCtIch,
  confirmIchCriticalAlert,
} from '../../imaging/ct-extensions.ts'
import { PacsForwardService, PacsForwardError, type PacsForwardConfig } from '../../imaging/pacs-forward.ts'
import { ImagingError } from '../../imaging/studies.ts'
import type { Store } from '../../store/db.ts'
import { PatientError, type Actor, type PatientService } from '../../tenancy/patients.ts'

export interface ImagingStage3RouteContext {
  store: Store
  audit: (c: Context, action: string, e?: { actor?: string | null; target?: string | null; detail?: string | null; status?: number }) => void
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  pt: (c: Context<{ Variables: { user: string } }>) => PatientService
  patientFailure: (c: Context, err: unknown) => Response
  pacsConfig?: Partial<PacsForwardConfig>
}

export function registerImagingStage3Routes(app: Hono<{ Variables: { user: string } }>, ctx: ImagingStage3RouteContext): {
  pacsForward: PacsForwardService
} {
  const { store, audit, me, pt } = ctx
  const curation = (c: Context<{ Variables: { user: string } }>) => new AnnotationCurationService(pt(c))
  const mrmc = (c: Context<{ Variables: { user: string } }>) => new MrmcStudyService(pt(c))
  const pacsForward = new PacsForwardService(store.db, ctx.pacsConfig)

  const handleErr = (c: Context, err: unknown) => {
    if (err instanceof ImagingError || err instanceof PacsForwardError || err instanceof PatientError) {
      return c.json({ error: err.message, code: err.code }, err.status)
    }
    return c.json({ error: (err as Error)?.message || '请求处理失败', code: 'bad_request' }, 400)
  }

  const assertHumanOnly = (c: Context<{ Variables: { user: string } }>, code = 'human_only', msg = '该操作必须由临床医师或管理员本人在界面执行，AI 不能代为操作') => {
    const actor = me(c)
    if (actor.via === 'ai') {
      throw new PatientError(code, msg, 403)
    }
    return actor
  }

  // —— T3.6（W7.1–W7.4）：标注库归档、双人独立抽样一致性、锁定测试集不退化门控、PI+信息科双人审批与一键回滚 ——

  app.get('/api/imaging/curation-bank', c => {
    try {
      const actor = assertHumanOnly(c, 'curation_human_only', '标注库只供人类研究员/管理员查看与管理')
      const study_id = c.req.query('study_id') || undefined
      return c.json({ entries: curation(c).listEntries(actor, { study_id }) })
    } catch (err) { return handleErr(c, err) }
  })

  app.post('/api/imaging/curation-bank/export-manifest', async c => {
    try {
      const actor = assertHumanOnly(c, 'curation_human_only', '离线训练清单与一致性报告导出须由人类研究员/管理员执行')
      const body = await c.req.json().catch(() => ({})) as { study_id?: string; target_sampling_rate?: number }
      const entries = curation(c).listEntries(actor, { study_id: body.study_id })
      const interObserver = curation(c).interObserverReport(actor, body.target_sampling_rate ?? 0.1)
      audit(c, 'imaging.curation_export', { detail: JSON.stringify({ entries: entries.length }) })
      return c.json({ entries, inter_observer: interObserver })
    } catch (err) { return handleErr(c, err) }
  })

  app.post('/api/imaging/releases/evaluate', async c => {
    try {
      const actor = assertHumanOnly(c, 'release_human_only', '候选模型门控登记须由人类工程师/管理员提交')
      const body = await c.req.json()
      const candidate = curation(c).registerCandidateRelease(actor, body)
      audit(c, 'imaging.release_evaluate', { target: candidate.id, detail: JSON.stringify({ version: candidate.version, gate_passed: candidate.gate_passed }) })
      return c.json(candidate, 201)
    } catch (err) { return handleErr(c, err) }
  })

  app.post('/api/imaging/releases/:rid/approve', async c => {
    try {
      const actor = assertHumanOnly(c, 'approval_human_only', '模型发布审批必须由 PI 或信息科负责人本人签署，禁止 AI 代替审批')
      const body = await c.req.json().catch(() => ({})) as { role?: 'pi' | 'it_admin'; note?: string }
      if (body.role !== 'pi' && body.role !== 'it_admin') {
        throw new ImagingError('invalid_approver_role', '审批角色必须为 pi（科室主任/PI）或 it_admin（信息科）', 400)
      }
      const updated = curation(c).approveRelease(actor, c.req.param('rid'), {
        role: body.role,
        note: body.note ?? null,
      })
      audit(c, 'imaging.release_approve', { target: updated.id, detail: JSON.stringify({ role: body.role, status: updated.status }) })
      return c.json(updated)
    } catch (err) { return handleErr(c, err) }
  })

  app.post('/api/imaging/releases/:rid/promote', c => {
    try {
      const actor = assertHumanOnly(c, 'promote_human_only', '模型上线激活须由人类管理员执行')
      const promoted = curation(c).activateRelease(actor, c.req.param('rid'))
      audit(c, 'imaging.release_promote', { target: promoted.id, detail: JSON.stringify({ version: promoted.version }) })
      return c.json(promoted)
    } catch (err) { return handleErr(c, err) }
  })

  app.post('/api/imaging/releases/:rid/rollback', async c => {
    try {
      const actor = assertHumanOnly(c, 'rollback_human_only', '生产模型回滚须由人类管理员执行')
      const body = await c.req.json().catch(() => ({})) as { task?: string; model_id?: string; reason?: string }
      const rolled = curation(c).rollbackRelease(actor, {
        task: String(body.task ?? 'lung_nodule'),
        model_id: String(body.model_id ?? 'lung_nodule_pipeline'),
        reason: String(body.reason ?? ''),
      })
      audit(c, 'imaging.release_rollback', { target: c.req.param('rid'), detail: JSON.stringify({ reason: body.reason }) })
      return c.json(rolled)
    } catch (err) { return handleErr(c, err) }
  })

  // —— T3.7：MRMC 多阅片者多病例交叉读片研究 ——

  app.post('/api/imaging/mrmc/studies', async c => {
    try {
      const actor = assertHumanOnly(c, 'mrmc_human_only', 'MRMC 读片研究由人类研究者创建与管理')
      const body = await c.req.json()
      const created = mrmc(c).createProtocol(actor, body)
      audit(c, 'imaging.mrmc_create', { target: created.protocol_id, detail: JSON.stringify({ title: created.title }) })
      return c.json(created, 201)
    } catch (err) { return handleErr(c, err) }
  })

  app.get('/api/imaging/mrmc/studies/:mid/tasks', c => {
    try {
      const actor = assertHumanOnly(c, 'mrmc_human_only', '盲法读片任务仅限受邀阅片医师本人领取')
      const readerId = c.req.query('reader_id') || actor.userId
      const at = c.req.query('at') || undefined
      return c.json(mrmc(c).nextAssignment(actor, c.req.param('mid'), readerId, at))
    } catch (err) { return handleErr(c, err) }
  })

  app.post('/api/imaging/mrmc/studies/:mid/reads', async c => {
    try {
      const actor = assertHumanOnly(c, 'mrmc_human_only', 'MRMC 盲法读片结果必须由阅片医师本人提交，禁止 AI 代替读片')
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
      const res = mrmc(c).submitCaseReading(actor, c.req.param('mid'), {
        reader_id: typeof body.reader_id === 'string' && body.reader_id ? body.reader_id : actor.userId,
        period: Number(body.period ?? 1) as 1 | 2,
        case_id: String(body.case_id ?? ''),
        elapsed_seconds: Number(body.elapsed_seconds ?? body.reading_time_sec ?? 0),
        case_confidence_0_100: Number(body.case_confidence_0_100 ?? 90),
        findings: Array.isArray(body.findings) ? body.findings : [],
        completed_at: typeof body.completed_at === 'string' ? body.completed_at : undefined,
      })
      return c.json(res, 201)
    } catch (err) { return handleErr(c, err) }
  })

  app.get('/api/imaging/mrmc/studies/:mid/analysis', c => {
    try {
      const actor = assertHumanOnly(c, 'mrmc_human_only', 'MRMC 研究终点统计分析由研究者本人查阅')
      return c.json(mrmc(c).analyzeProtocol(actor, c.req.param('mid')))
    } catch (err) { return handleErr(c, err) }
  })

  // —— T3.2–T3.4：CT 多病种扩展（肺炎 CTSS、肋骨骨折、头颅平扫急性脑出血与急诊优先通道） ——

  app.post('/api/imaging/ct-extensions/pneumonia-ctss', async c => {
    try {
      assertHumanOnly(c)
      const body = await c.req.json().catch(() => ({})) as { lobes?: unknown }
      if (!body.lobes || typeof body.lobes !== 'object') throw new ImagingError('missing_lobes', '请提供五肺叶量化数据 lobes', 400)
      const lobesMap: Record<string, { lobe_volume_cm3: number; ggo_volume_cm3?: number; consolidation_volume_cm3?: number }> = {}
      if (Array.isArray(body.lobes)) {
        for (const item of body.lobes as Array<Record<string, unknown>>) {
          const code = String(item.lobe ?? item.lobe_code ?? '').toUpperCase()
          if (code) {
            lobesMap[code] = {
              lobe_volume_cm3: Number(item.lobe_volume_cm3 ?? item.lobe_volume_ml ?? 0),
              ggo_volume_cm3: Number(item.ggo_volume_cm3 ?? item.ggo_volume_ml ?? 0),
              consolidation_volume_cm3: Number(item.consolidation_volume_cm3 ?? item.consolidation_volume_ml ?? 0),
            }
          }
        }
      } else {
        Object.assign(lobesMap, body.lobes)
      }
      return c.json(evaluatePneumoniaCtss(lobesMap as never))
    } catch (err) { return handleErr(c, err) }
  })

  app.post('/api/imaging/ct-extensions/rib-fractures', async c => {
    try {
      assertHumanOnly(c)
      const body = await c.req.json().catch(() => ({})) as { candidates?: unknown }
      if (!Array.isArray(body.candidates)) throw new ImagingError('missing_candidates', '请提供肋骨骨折候选列表 candidates', 400)
      return c.json(evaluateRibFractures(body.candidates as never))
    } catch (err) { return handleErr(c, err) }
  })

  app.post('/api/imaging/ct-extensions/head-ich', async c => {
    try {
      assertHumanOnly(c)
      const body = await c.req.json().catch(() => ({})) as {
        hemorrhages?: unknown
        midline_shift_mm?: unknown
        priority?: 'stat' | 'routine'
      }
      if (!Array.isArray(body.hemorrhages)) throw new ImagingError('missing_hemorrhages', '请提供颅内出血灶列表 hemorrhages', 400)
      return c.json(evaluateHeadCtIch({
        hemorrhages: body.hemorrhages as never,
        midline_shift_mm: Number(body.midline_shift_mm ?? 0),
        priority: body.priority,
      }))
    } catch (err) { return handleErr(c, err) }
  })

  app.post('/api/imaging/ct-extensions/head-ich/confirm-critical', async c => {
    try {
      const actor = me(c)
      const body = await c.req.json().catch(() => ({})) as { summary?: unknown }
      if (!body.summary || typeof body.summary !== 'object') {
        throw new ImagingError('missing_summary', '请提供待确认的脑出血评估结果 summary', 400)
      }
      const confirmed = confirmIchCriticalAlert(actor, body.summary as never)
      audit(c, 'imaging.ich_critical_confirm', { target: actor.userId, detail: JSON.stringify({ total_volume_ml: confirmed.total_volume_ml, midline_shift_mm: confirmed.midline_shift_mm }) })
      return c.json(confirmed)
    } catch (err) { return handleErr(c, err) }
  })

  // —— T3.8（W1.1–W1.2）：PACS 自动转发（Orthanc StableSeries Webhook 接收与序列自动分流） ——

  app.post('/api/imaging/pacs/webhook', async c => {
    try {
      const secret = c.req.header('x-orthanc-webhook-secret')
      const body = await c.req.json().catch(() => ({}))
      const decision = pacsForward.handleStableSeriesWebhook(secret, body)
      return c.json(decision, decision.accepted ? 201 : 200)
    } catch (err) { return handleErr(c, err) }
  })

  app.get('/api/imaging/pacs/events', c => {
    try {
      assertHumanOnly(c, 'pacs_human_only', 'PACS 自动转发分流日志仅限机构管理员在界面查阅')
      return c.json({ config: pacsForward.getConfig(), events: pacsForward.listEvents() })
    } catch (err) { return handleErr(c, err) }
  })

  return { pacsForward }
}
