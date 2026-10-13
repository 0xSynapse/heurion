import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { workerFail } from '../src/http/routes/imaging.ts'

describe('影像微服务错误如实转发', () => {
  const app = new Hono()
  app.get('/:status', c => workerFail(c, new Response(JSON.stringify({ detail: '具体原因' }), { status: Number(c.req.param('status')) }), 'imaging_inference_failed'))

  it('400 / 404 / 501 原样返回状态码与原因，其它为 502', async () => {
    for (const [st, expected, prefix] of [[400, 400, '请求参数有误'], [404, 404, '影像或样本不存在'], [501, 501, '模型不可用'], [500, 502, '影像微服务出错']] as const) {
      const res = await app.request(`/${st}`)
      expect(res.status).toBe(expected)
      const body = await res.json() as { error: string; message: string; worker_status: number }
      expect(body).toMatchObject({ error: 'imaging_inference_failed', worker_status: st })
      expect(body.message).toContain(prefix)
      expect(body.message).toContain('具体原因')
    }
  })
})

describe('MPR 不使用默认演示样本', () => {
  it('没有 sample_id / 文件 / 患者影像时返回 404，不用 chest_lung_ct 代替', async () => {
    const { Store } = await import('../src/store/db.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')
    const { buildApi } = await import('../src/http/api.ts')
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const user = store.createUser({ username: 'img_u', display_name: 'U', password_hash: 'x' })
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'img-render-'))),
      accounts: new Accounts(store, { secret: 'test-secret', devMode: true, devToken: 'dev', devUser: user.id }),
      devMode: true, devUser: user.id,
    })
    const token = `Bearer ${issueToken('test-secret', { u: user.id, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: user.token_version })}`
    const calls: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response('{}') }) as typeof fetch
    try {
      const info = await app.request('/api/imaging/mpr/info', { headers: { Authorization: token } })
      expect(info.status).toBe(404)
      expect(((await info.json()) as { error: string }).error).toBe('no_image')
      const slice = await app.request('/api/imaging/mpr/slice', { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ plane: 'axial' }) })
      expect(slice.status).toBe(404)
      // 没有向影像微服务发出带默认样本的请求
      expect(calls.some(u => u.includes('/mpr/'))).toBe(false)
    } finally {
      globalThis.fetch = orig
    }
  })
})
