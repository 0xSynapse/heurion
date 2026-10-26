/**
 * Orthanc（院内 DICOM 存储与 DICOMweb）的最小客户端（docs/design/IMAGING_STUDIES.md）。
 * 平台是唯一的访问方：浏览器（OHIF）和影像 worker 都经平台的鉴权代理访问，Orthanc 本身不对外暴露。
 */

export class OrthancError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface OrthancUpload {
  instanceId: string
  studyId: string
  seriesId: string
  /** Orthanc 对重复实例返回 AlreadyStored */
  status: 'Success' | 'AlreadyStored'
}

export interface OrthancStudy {
  studyUid: string
  studyDate: string | null
  description: string | null
  accession: string | null
  series: string[]
}

export interface OrthancSeries {
  seriesUid: string
  modality: string | null
  bodyPart: string | null
  description: string | null
  sliceThickness: number | null
  kernel: string | null
  instances: number
}

export interface Orthanc {
  upload(bytes: Uint8Array): Promise<OrthancUpload>
  study(orthancId: string): Promise<OrthancStudy>
  series(orthancId: string): Promise<OrthancSeries>
  /** 删除一个序列（只用于清理本系统生成、已被取代的派生序列，如旧的 DICOM SEG） */
  deleteSeries(orthancId: string): Promise<void>
  /** 整个序列打包成 zip（DICOM 原件），交给影像 worker 分析 */
  seriesArchive(orthancId: string): Promise<Uint8Array>
  /**
   * 转发一个 DICOMweb GET（path 以 / 开头、相对 DICOMweb 根，如 /studies/1.2.3/series）。
   * forwarded = 浏览器访问平台用的主机与协议：Orthanc 据此（Forwarded 头）生成 BulkDataURI，使其指回平台代理而不是 Orthanc 自己。
   */
  dicomweb(path: string, query: string, accept: string | null, forwarded?: { host: string; proto: string } | null): Promise<Response>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** DICOM 日期 YYYYMMDD → YYYY-MM-DD；其它格式不认 */
export function dicomDate(v: unknown): string | null {
  const s = str(v)
  return s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null
}

export class HttpOrthanc implements Orthanc {
  private readonly auth: string | null

  constructor(private readonly base: string, user?: string, password?: string, private readonly dicomwebRoot = '/dicom-web') {
    this.base = base.replace(/\/+$/, '')
    this.auth = user ? `Basic ${Buffer.from(`${user}:${password ?? ''}`).toString('base64')}` : null
  }

  private async call(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.auth) headers.set('Authorization', this.auth)
    let resp: Response
    try {
      resp = await fetch(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      throw new OrthancError(503, `影像存储（Orthanc）连接失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return resp
  }

  private async json<T>(path: string): Promise<T> {
    const resp = await this.call(path)
    if (!resp.ok) throw new OrthancError(resp.status === 404 ? 404 : 502, `影像存储返回 HTTP ${resp.status}（${path}）`)
    return await resp.json() as T
  }

  async upload(bytes: Uint8Array): Promise<OrthancUpload> {
    const resp = await this.call('/instances', { method: 'POST', headers: { 'Content-Type': 'application/dicom' }, body: new Uint8Array(bytes) })
    if (resp.status === 400) throw new OrthancError(400, '不是有效的 DICOM 文件')
    if (!resp.ok) throw new OrthancError(502, `影像存储返回 HTTP ${resp.status}`)
    const r = await resp.json() as { ID: string; ParentStudy: string; ParentSeries: string; Status: string }
    return { instanceId: r.ID, studyId: r.ParentStudy, seriesId: r.ParentSeries, status: r.Status === 'AlreadyStored' ? 'AlreadyStored' : 'Success' }
  }

  async study(orthancId: string): Promise<OrthancStudy> {
    const r = await this.json<{ MainDicomTags?: Record<string, unknown>; Series?: string[] }>(`/studies/${encodeURIComponent(orthancId)}`)
    const t = r.MainDicomTags ?? {}
    const uid = str(t.StudyInstanceUID)
    if (!uid) throw new OrthancError(502, '影像存储返回的检查缺少 StudyInstanceUID')
    return { studyUid: uid, studyDate: dicomDate(t.StudyDate), description: str(t.StudyDescription), accession: str(t.AccessionNumber), series: r.Series ?? [] }
  }

  async series(orthancId: string): Promise<OrthancSeries> {
    const id = encodeURIComponent(orthancId)
    const r = await this.json<{ MainDicomTags?: Record<string, unknown>; Instances?: string[] }>(`/series/${id}`)
    const t = r.MainDicomTags ?? {}
    const uid = str(t.SeriesInstanceUID)
    if (!uid) throw new OrthancError(502, '影像存储返回的序列缺少 SeriesInstanceUID')
    // 层厚、重建核不是序列主标签，取序列内各实例共有的标签
    let shared: Record<string, unknown> = {}
    try { shared = await this.json<Record<string, unknown>>(`/series/${id}/shared-tags?simplify`) } catch {}
    const thickness = Number(str(shared.SliceThickness))
    return {
      seriesUid: uid, modality: str(t.Modality), bodyPart: str(t.BodyPartExamined), description: str(t.SeriesDescription),
      sliceThickness: Number.isFinite(thickness) && thickness > 0 ? thickness : null,
      kernel: str(shared.ConvolutionKernel), instances: r.Instances?.length ?? 0,
    }
  }

  async deleteSeries(orthancId: string): Promise<void> {
    const resp = await this.call(`/series/${encodeURIComponent(orthancId)}`, { method: 'DELETE' })
    if (!resp.ok && resp.status !== 404) throw new OrthancError(502, `影像存储删除序列失败（HTTP ${resp.status}）`)
  }

  async seriesArchive(orthancId: string): Promise<Uint8Array> {
    const resp = await this.call(`/series/${encodeURIComponent(orthancId)}/archive`, {}, 300_000)
    if (!resp.ok) throw new OrthancError(resp.status === 404 ? 404 : 502, `影像存储导出序列失败（HTTP ${resp.status}）`)
    return new Uint8Array(await resp.arrayBuffer())
  }

  async dicomweb(path: string, query: string, accept: string | null, forwarded?: { host: string; proto: string } | null): Promise<Response> {
    const headers: Record<string, string> = {}
    if (accept) headers.Accept = accept
    if (forwarded) headers.Forwarded = `host=${forwarded.host};proto=${forwarded.proto}`
    return this.call(`${this.dicomwebRoot}${path}${query ? `?${query}` : ''}`, { headers }, 120_000)
  }
}

/** 由环境变量组装；没配 ORTHANC_URL 时返回 null（影像上传与 DICOMweb 接口返回 503）。 */
export function orthancFromEnv(env: NodeJS.ProcessEnv = process.env): Orthanc | null {
  const url = env.ORTHANC_URL?.trim()
  return url ? new HttpOrthanc(url, env.ORTHANC_USER, env.ORTHANC_PASSWORD) : null
}
