// callWorker 用默认 fetch 调真实 HTTP 服务：长超时（> 5 分钟）走 undici 自带的 fetch + 连接池，
// 防止 npm undici 与 Node 内置 undici 版本不一致时报 UND_ERR_INVALID_ARG（CI 与生产同为 Node 24）
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { callWorker } from '../src/imaging/worker.js'

let server: Server
let base = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, echo: body })) })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>(r => server.close(() => r())))

describe('callWorker 真实连接', () => {
  it('超时长于 5 分钟的调用可用', async () => {
    const r = await callWorker(fetch, base, '/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }, 2_700_000)
    expect(r).toEqual({ ok: true, echo: '{"a":1}' })
  })
  it('普通超时的调用可用', async () => {
    const r = await callWorker(fetch, base, '/y', { method: 'GET' }, 10_000)
    expect(r).toEqual({ ok: true, echo: '' })
  })
})
