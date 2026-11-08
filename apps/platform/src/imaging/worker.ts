/**
 * 调影像 worker（apps/imaging-worker）的公用部分：分析流水线与阅片器点选分割共用。
 * 原件由平台从 Orthanc 取出交给 worker，worker 不直接访问 Orthanc。
 */

import { Agent, fetch as undiciFetch } from 'undici'
import { publicWorkerDetail, readWorkerDetail, workerErrorKind } from './worker-error.ts'

/**
 * Node 自带的 fetch（undici）默认 5 分钟收不到响应头就断开（headersTimeout），报的是笼统的「fetch failed」。
 * 肺结节分析在 CPU 上常常超过 5 分钟，所以超时长于 5 分钟的调用改用这个连接池：头与正文的超时都放到调用方给的时长，
 * 真正的上限仍由 AbortSignal.timeout(timeoutMs) 控制。
 * 连接池必须和同一份 undici 的 fetch 配套使用：把 npm 的 Agent 交给 Node 自带的 fetch，
 * 两边版本不一致时（生产 Node 24 自带旧版 undici）会报 UND_ERR_INVALID_ARG。
 */
const nativeFetch = globalThis.fetch
const UNDICI_DEFAULT_TIMEOUT_MS = 300_000
const longAgents = new Map<number, Agent>()
function longAgent(timeoutMs: number): Agent {
  let a = longAgents.get(timeoutMs)
  if (!a) { a = new Agent({ headersTimeout: timeoutMs + 60_000, bodyTimeout: timeoutMs + 60_000 }); longAgents.set(timeoutMs, a) }
  return a
}

/**
 * worker 返回非 2xx 或连不上；status 为 HTTP 状态码（连接失败、超时为 null）。
 * message 已经过 worker-error.ts 清理（5xx 不带 worker 原文，路径只留文件名），
 * 可以直接给用户 / AI 看、写进分析运行记录；worker 原文只在平台日志里。
 */
export class WorkerError extends Error {
  constructor(readonly status: number | null, message: string) { super(message) }
}

/** 调 worker；错误转成中文说明（501 模型不可用、404 影像不存在、其它 4xx 参数问题、其余为服务故障，见 worker-error.ts） */
export async function callWorker(fetchImpl: typeof fetch, base: string, path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let resp: Response
  try {
    const url = `${base}${path}`
    const signal = AbortSignal.timeout(timeoutMs)
    // 只有用默认 fetch 时才换成 undici 自己的 fetch；测试注入的 fetch 照常调用
    resp = timeoutMs > UNDICI_DEFAULT_TIMEOUT_MS && fetchImpl === nativeFetch
      ? await undiciFetch(url, { ...init, signal, dispatcher: longAgent(timeoutMs) } as Parameters<typeof undiciFetch>[1]) as unknown as Response
      : await fetchImpl(url, { ...init, signal })
  } catch (err) {
    const name = (err as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') throw new WorkerError(null, '影像服务处理超时')
    // fetch failed 的具体原因在 cause 里（连接被拒、被重置、头超时等），一并写出来便于排查
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause
    throw new WorkerError(null, `影像服务连接失败：${(err as Error).message}${cause ? `（${cause.code ?? cause.message ?? ''}）` : ''}`)
  }
  if (!resp.ok) {
    const detail = publicWorkerDetail(resp.status, await readWorkerDetail(resp), 300, `callWorker ${path}`)
    throw new WorkerError(resp.status, `${workerErrorKind(resp.status)}（HTTP ${resp.status}）：${detail}`)
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
