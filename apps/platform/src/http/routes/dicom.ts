import type { Context, Hono } from 'hono'
import type { Actor, PatientService } from '../../tenancy/patients.ts'
import type { Orthanc } from '../../imaging/orthanc.ts'
import { ImagingError, ImagingStudyService, type StudyView } from '../../imaging/studies.ts'
import { TASKS, type EnqueueResult, type ImagingPipeline, type ImagingTask } from '../../imaging/pipeline.ts'

export interface DicomRouteContext {
  audit: (c: Context, action: string, e?: { actor?: string | null; target?: string | null; detail?: string | null; status?: number }) => void
  me: (c: Context<{ Variables: { user: string } }>) => Actor
  pt: (c: Context<{ Variables: { user: string } }>) => PatientService
  patientFailure: (c: Context, err: unknown) => Response
  /** 没配置时上传与 DICOMweb 返回 503 */
  orthanc: Orthanc | null
  /** 分析流水线；null 时上传后不自动分析 */
  pipeline: ImagingPipeline | null
}

/** 单次上传上限（MB），默认 2048；整次请求在内存里解析，过大的检查请分批上传 */
const uploadMaxBytes = () => Math.max(1, Number(process.env.IMAGING_UPLOAD_MAX_MB) || 2048) * 1024 * 1024

/** DICOMweb 路径：只允许 /studies/<UID>[/...]，字符白名单，不允许 .. */
const DICOMWEB_PATH = /^\/studies\/([0-9.]{1,64})((?:\/[A-Za-z0-9._-]+)*)$/

/**
 * 影像检查（docs/design/IMAGING_STUDIES.md）：手工上传 DICOM、检查列表、DICOMweb 鉴权代理。
 * DICOMweb 只读、只转发能看到的患者的检查，供 OHIF 阅片；体素数据不经 AI。
 */
export function registerDicomRoutes(app: Hono<{ Variables: { user: string } }>, ctx: DicomRouteContext): void {
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

  const forward = async (c: Context<{ Variables: { user: string } }>, path: string, query: string) => {
    if (!ctx.orthanc) throw new ImagingError('orthanc_not_configured', '本机构没有配置影像存储（Orthanc）', 503)
    const resp = await ctx.orthanc.dicomweb(path, query, c.req.header('accept') ?? null)
    const headers = new Headers({ 'Cache-Control': 'private, no-store' })
    for (const h of ['content-type', 'content-length']) { const v = resp.headers.get(h); if (v) headers.set(h, v) }
    return new Response(resp.body, { status: resp.status, headers })
  }
  const queryOf = (c: Context) => { const u = new URL(c.req.url); return u.search.slice(1) }

  /** QIDO-RS 检查查询：必须带 StudyInstanceUID，且每个都要能看到（不提供全库检索） */
  app.get('/api/dicomweb/studies', async c => {
    try {
      const uids = (c.req.query('StudyInstanceUID') ?? '').split(/[,\\]/).map(s => s.trim()).filter(Boolean)
      if (!uids.length) throw new ImagingError('study_uid_required', '请按 StudyInstanceUID 查询检查')
      for (const uid of uids) {
        if (!/^[0-9.]{1,64}$/.test(uid)) throw new ImagingError('bad_uid', 'StudyInstanceUID 格式不对')
        const { studyId, scope } = svc(c).resolveStudyUid(me(c), uid)
        scope.log('dicomweb_view', studyId)
      }
      return await forward(c, '/studies', queryOf(c))
    } catch (err) { return fail(c, err) }
  })

  const study = async (c: Context<{ Variables: { user: string } }>) => {
    try {
      const path = c.req.path.slice('/api/dicomweb'.length)
      const m = DICOMWEB_PATH.exec(path)
      if (!m || path.includes('..')) throw new ImagingError('bad_path', '不支持的 DICOMweb 路径')
      svc(c).resolveStudyUid(me(c), m[1]!)
      return await forward(c, path, queryOf(c))
    } catch (err) { return fail(c, err) }
  }
  app.get('/api/dicomweb/studies/:uid', study)
  app.get('/api/dicomweb/studies/:uid/*', study)
}
