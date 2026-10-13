import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { verifyToken } from '../auth/token.ts'

/**
 * 模型调用代理：dsh 把 DEEPSEEK_BASE_URL 指向这里（/llm/v1），拿的是每用户、绑定进程代号的令牌（aud=llm），
 * 平台验证后换成真实 API key 转发给 DeepSeek。真实 key 只在平台进程里，dsh 进程和它执行的代码都拿不到；
 * 进程被回收后令牌立即失效。只对本机开放（Caddy 不转发 /llm）。
 */
export interface LlmProxyDeps {
  secret: string
  /** 上游，例如 https://api.deepseek.com/anthropic/v1 */
  upstream: string
  apiKey: string
  isLive: (userId: string, generation: string) => boolean
}

export const LLM_PREFIX = '/llm/v1'

/** 转发时不带过去的请求头（逐跳头、认证、由 fetch 自己算的长度）。 */
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'x-api-key', 'authorization', 'proxy-authorization', 'te', 'upgrade'])
/** 回给 dsh 时不带的响应头（fetch 已解压、长度会变）。 */
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'])

export async function handleLlmProxy(deps: LlmProxyDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const fail = (status: number, message: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message } }))
  }
  const auth = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const claims = typeof auth === 'string' ? verifyToken(deps.secret, auth, 'llm') : null
  if (!claims || !claims.s || !deps.isLive(claims.u, claims.s)) return fail(401, '模型代理令牌无效或已过期')
  if (!deps.apiKey) return fail(503, '平台没有配置 DEEPSEEK_API_KEY')
  if (req.method !== 'POST' && req.method !== 'GET') return fail(405, '不支持的方法')

  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || DROP_REQUEST.has(k.toLowerCase())) continue
    headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  }
  headers.set('x-api-key', deps.apiKey)
  const rest = (req.url ?? '').slice(LLM_PREFIX.length)
  let decodedRest = rest
  try { decodedRest = decodeURIComponent(rest) } catch { return fail(400, '非法请求路径') }
  if (rest.includes('..') || decodedRest.includes('..') || (rest && !rest.startsWith('/') && !rest.startsWith('?'))) {
    return fail(400, '非法请求路径')
  }
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  req.on('aborted', () => controller.abort())
  req.on('close', () => { if (!req.complete || req.socket?.destroyed) controller.abort() })
  ;(req as unknown as { raw?: IncomingMessage }).raw?.on?.('close', () => controller.abort())
  let upstream: Response
  try {
    upstream = await fetch(deps.upstream.replace(/\/$/, '') + rest, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? (Readable.toWeb(req) as ReadableStream) : undefined,
      // @ts-expect-error Node 的 fetch 需要 duplex 才能流式上传请求体
      duplex: 'half',
      signal: controller.signal,
    })
  } catch (err) {
    if (!res.headersSent) fail(502, `模型服务连接失败：${(err as Error).message.slice(0, 200)}`)
    return
  }
  const out: Record<string, string> = {}
  upstream.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k)) out[k] = v })
  res.writeHead(upstream.status, out)
  if (!upstream.body) { res.end(); return }
  // 流式回传（SSE）：边收边写
  Readable.fromWeb(upstream.body as never).on('error', () => res.destroy()).pipe(res)
}
