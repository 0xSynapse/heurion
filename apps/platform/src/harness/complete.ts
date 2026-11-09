/**
 * 平台自己调一次模型（不经 dsh 回合）：用于后台任务，例如记忆整理。走与模型代理相同的上游（Anthropic Messages 格式）
 * 和平台的 key；温度 0、非流式，返回第一段文本。
 */
export type Complete = (system: string, user: string) => Promise<string>

/** 一次成功调用的用量（上游 Messages 响应里的 usage；缺字段时为 0） */
export interface CompleteUsage { model: string; input_tokens: number; output_tokens: number; ms: number }

export function makeComplete(opts: { upstream: string; apiKey: string; model: string; timeoutMs?: number; onUsage?: (u: CompleteUsage) => void }): Complete | null {
  if (!opts.apiKey) return null
  return async (system: string, user: string): Promise<string> => {
    let last: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      let noRetry = false
      try {
        const t0 = Date.now()
        const res = await fetch(opts.upstream.replace(/\/$/, '') + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: opts.model, max_tokens: 8000, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
        })
        if (!res.ok) {
          if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) noRetry = true
          throw new Error(`模型服务 ${res.status}：${(await res.text()).slice(0, 200)}`)
        }
        const body = await res.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }
        try {
          opts.onUsage?.({ model: opts.model, input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0, ms: Date.now() - t0 })
        } catch { /* 计量失败不影响调用结果 */ }
        return (body.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('')
      } catch (err) {
        last = err as Error
        if (noRetry) break
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
      }
    }
    throw last!
  }
}
