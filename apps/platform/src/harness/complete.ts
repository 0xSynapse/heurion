/**
 * 平台自己调一次模型（不经 dsh 回合）：用于后台任务，例如记忆整理。走与模型代理相同的上游（Anthropic Messages 格式）
 * 和平台的 key；温度 0、非流式，返回第一段文本。
 */
export type Complete = (system: string, user: string) => Promise<string>

/** 带图的一次调用：图片按顺序放在文字前面（base64，PNG / JPEG） */
export interface InlineImage { mime: 'image/png' | 'image/jpeg'; data: string }
export type VisionComplete = (system: string, user: string, images: InlineImage[]) => Promise<string>

/** 一次成功调用的用量（上游 Messages 响应里的 usage；缺字段时为 0） */
export interface CompleteUsage { model: string; input_tokens: number; output_tokens: number; ms: number }

interface CompleteOptions { upstream: string; apiKey: string; model: string; timeoutMs?: number; onUsage?: (u: CompleteUsage) => void; extra?: Record<string, unknown> }

type Content = string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>

function caller(opts: CompleteOptions, extra: Record<string, unknown> = {}): (system: string, content: Content) => Promise<string> {
  return async (system, content) => {
    let last: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      let noRetry = false
      try {
        const t0 = Date.now()
        const res = await fetch(opts.upstream.replace(/\/$/, '') + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: opts.model, max_tokens: 8000, temperature: 0, ...extra, system, messages: [{ role: 'user', content }] }),
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

export function makeComplete(opts: CompleteOptions): Complete | null {
  if (!opts.apiKey) return null
  const defaultExtra = opts.model.includes('flash') ? { thinking: { type: 'disabled' } } : {}
  const call = caller(opts, { ...defaultExtra, ...opts.extra })
  return (system, user) => call(system, user)
}

/** 支持图像输入的模型（按 id；部署可以用 REVIEW_VISION_MODEL 另指定） */
export const VISION_MODELS = new Set(['deepseek-flash'])

/**
 * 带图调用（审稿时按页面图像核对表格，docs/design/PDF_ORIGINAL_VIEW.md §12.3）。
 * 发往与文字调用相同的上游；模型不支持图像时返回 null，调用方退回不用图的做法。
 */
export function makeVisionComplete(opts: CompleteOptions): VisionComplete | null {
  if (!opts.apiKey || !VISION_MODELS.has(opts.model)) return null
  // 转录不需要推理：开着思考时大表的思考会用光输出上限，回复里没有正文（实测约两成的表）
  const call = caller(opts, { thinking: { type: 'disabled' } })
  return (system, user, images) => call(system, [
    ...images.map(img => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mime, data: img.data } })),
    { type: 'text' as const, text: user },
  ])
}
