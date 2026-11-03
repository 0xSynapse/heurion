/**
 * 调影像 worker（apps/imaging-worker）的公用部分：分析流水线与阅片器点选分割共用。
 * 原件由平台从 Orthanc 取出交给 worker，worker 不直接访问 Orthanc。
 */

import { Agent } from 'undici'

/**
 * Node 自带的 fetch（undici）默认 5 分钟收不到响应头就断开（headersTimeout），报的是笼统的「fetch failed」。
 * 肺结节分析在 CPU 上常常超过 5 分钟，所以超时长于 5 分钟的调用改用这个连接池：头与正文的超时都放到调用方给的时长，
 * 真正的上限仍由 AbortSignal.timeout(timeoutMs) 控制。undici 与 Node 内置版本一致（package.json 锁定）。
 */
const UNDICI_DEFAULT_TIMEOUT_MS = 300_000
const longAgents = new Map<number, Agent>()
function longAgent(timeoutMs: number): Agent {
  let a = longAgents.get(timeoutMs)
  if (!a) { a = new Agent({ headersTimeout: timeoutMs + 60_000, bodyTimeout: timeoutMs + 60_000 }); longAgents.set(timeoutMs, a) }
  return a
}

/** worker 返回非 2xx 或连不上；status 为 HTTP 状态码（连接失败、超时为 null） */
export class WorkerError extends Error {
  constructor(readonly status: number | null, message: string) { super(message) }
}

/** 调 worker；错误如实转成中文说明（501 模型不可用、404 影像不存在、其它 4xx 输入问题、其余为服务故障） */
export async function callWorker(fetchImpl: typeof fetch, base: string, path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let resp: Response
  try {
    const dispatcher = timeoutMs > UNDICI_DEFAULT_TIMEOUT_MS ? { dispatcher: longAgent(timeoutMs) } : {}
    resp = await fetchImpl(`${base}${path}`, { ...init, ...dispatcher, signal: AbortSignal.timeout(timeoutMs) } as RequestInit)
  } catch (err) {
    const name = (err as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') throw new WorkerError(null, '影像服务处理超时')
    // fetch failed 的具体原因在 cause 里（连接被拒、被重置、头超时等），一并写出来便于排查
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause
    throw new WorkerError(null, `影像服务连接失败：${(err as Error).message}${cause ? `（${cause.code ?? cause.message ?? ''}）` : ''}`)
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
