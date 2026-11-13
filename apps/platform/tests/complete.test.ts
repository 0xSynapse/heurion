import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_THINKING, makeComplete } from '../src/harness/complete.ts'

/** 拦下发往模型的请求，取请求体。 */
function captureBody(): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })
  })
  return { bodies }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('makeComplete', () => {
  it('线上默认模型 deepseek-flash 不关闭深度思考（回归：2026-11-11 按模型名默认关闭，深度审稿只做了表面核查）', async () => {
    const { bodies } = captureBody()
    const complete = makeComplete({ upstream: 'https://example.test/v1', apiKey: 'k', model: 'deepseek-flash' })!
    expect(await complete('sys', 'user')).toBe('ok')
    expect(bodies[0]!.thinking).toBeUndefined()
  })

  it('调用方明确要求时才关闭（论文基准测试的固定配置）', async () => {
    const { bodies } = captureBody()
    const complete = makeComplete({ upstream: 'https://example.test/v1', apiKey: 'k', model: 'deepseek-v4-flash', extra: NO_THINKING })!
    await complete('sys', 'user')
    expect(bodies[0]!.thinking).toEqual({ type: 'disabled' })
  })
})
