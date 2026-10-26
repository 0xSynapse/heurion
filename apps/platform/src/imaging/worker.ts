/**
 * 调影像 worker（apps/imaging-worker）的公用部分：分析流水线与阅片器点选分割共用。
 * 原件由平台从 Orthanc 取出交给 worker，worker 不直接访问 Orthanc。
 */

/** worker 返回非 2xx 或连不上；status 为 HTTP 状态码（连接失败、超时为 null） */
export class WorkerError extends Error {
  constructor(readonly status: number | null, message: string) { super(message) }
}

/** 调 worker；错误如实转成中文说明（501 模型不可用、404 影像不存在、其它 4xx 输入问题、其余为服务故障） */
export async function callWorker(fetchImpl: typeof fetch, base: string, path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let resp: Response
  try {
    resp = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const name = (err as Error)?.name
    throw new WorkerError(null, name === 'TimeoutError' || name === 'AbortError' ? '影像服务处理超时' : `影像服务连接失败：${(err as Error).message}`)
  }
  if (!resp.ok) {
    let detail = ''
    try { const t = await resp.text(); try { const j = JSON.parse(t); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j) } catch { detail = t } } catch {}
    const kind = resp.status === 501 ? '模型不可用' : resp.status === 404 ? '影像不存在' : resp.status >= 400 && resp.status < 500 ? '影像输入有误' : '影像服务出错'
    throw new WorkerError(resp.status, `${kind}（HTTP ${resp.status}）：${detail.slice(0, 300)}`)
  }
  const text = await resp.text()
  return text ? JSON.parse(text) : null
}

/** 把 Orthanc 里的一个序列（zip）上传到 worker 内存缓存，编号为 volumeId */
export async function uploadSeries(fetchImpl: typeof fetch, base: string, volumeId: string, zip: Uint8Array): Promise<void> {
  const form = new FormData()
  form.append('volume_id', volumeId)
  form.append('file', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), 'series.zip')
  await callWorker(fetchImpl, base, '/api/v1/volume/upload', { method: 'POST', body: form }, 300_000)
}
