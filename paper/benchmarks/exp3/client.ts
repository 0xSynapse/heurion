/**
 * 实验 3 的平台客户端：REST 调用与回合 SSE 流（逐事件回调，用于回合中途以「人类」身份插入编辑）。
 */

import { request as httpRequest, type IncomingMessage } from 'node:http'

export type UiEvent = Record<string, any> & { type: string }

export interface Client {
  base: string
  /** Authorization 头（multipart 上传等需要自己发请求时用）。 */
  auth: string
  api<T = any>(path: string, init?: RequestInit): Promise<T>
  /** 发起一个回合，逐事件回调；返回全部事件。 */
  chat(docId: string, message: string, onEvent?: (e: UiEvent) => Promise<void> | void, opts?: { memory?: boolean }): Promise<UiEvent[]>
}

export function client(base: string, user: string, devToken = process.env.HEURION_DEV_TOKEN || 'dev'): Client {
  const H = { Authorization: `Bearer ${devToken}:${user}` }

  async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', H.Authorization)
    if (typeof init.body === 'string') headers.set('Content-Type', 'application/json')
    const res = await fetch(`${base}${path}`, { ...init, headers })
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
    return (res.headers.get('content-type')?.includes('json') ? res.json() : res.text()) as Promise<T>
  }

  async function chat(docId: string, message: string, onEvent?: (e: UiEvent) => Promise<void> | void, opts: { memory?: boolean } = {}): Promise<UiEvent[]> {
    // suggest=false：直接生效，避免 AI 自己的修订变成待采纳块干扰其他任务；memory 默认关（隔离声明式记忆）
    // 用 node:http 而不是 fetch：fetch（undici）在 300 秒没有收到数据时会切断连接，并发高时长回合会被误杀
    const body = JSON.stringify({ message, suggest: false, memory: opts.memory ?? false })
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest(`${base}/api/docs/${docId}/chat`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, resolve)
      req.on('error', reject)
      req.end(body)
    })
    if ((res.statusCode ?? 0) >= 400) {
      let text = ''
      for await (const chunk of res) text += chunk
      throw new Error(`chat → ${res.statusCode} ${text}`)
    }
    const events: UiEvent[] = []
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of res as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let cut: number
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, cut)
        buf = buf.slice(cut + 2)
        const line = frame.split('\n').find(l => l.startsWith('data:'))
        if (!line) continue
        const e = JSON.parse(line.slice(5)) as UiEvent
        events.push(e)
        await onEvent?.(e)
      }
    }
    return events
  }

  return { base, auth: H.Authorization, api, chat }
}

/** 解析读视图（与 doc_read 相同）的顶层块：id → 首行文字。 */
export function topBlocks(readView: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of readView.matchAll(/^\{#([a-z0-9]+)\}(?: (.*))?$/gm)) out.set(m[1]!, m[2] ?? '')
  return out
}

/** 读视图里某个块的完整文字（到下一个顶层块为止）。 */
export function blockText(readView: string, id: string): string {
  const start = readView.indexOf(`{#${id}}`)
  if (start < 0) return ''
  const rest = readView.slice(start)
  const next = rest.slice(1).search(/\n\{#[a-z0-9]+\}/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

/** 读全文：长文档的读视图分页，按 cursor 逐页读完拼起来（只保留第一页的头部）。 */
export async function readAll(c: Client, docId: string): Promise<string> {
  const pages: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < 50; i++) {
    const page = await c.api<string>(`/api/docs/${docId}/read${cursor ? `?cursor=${cursor}` : ''}`)
    const [head, ...rest] = page.split('\n')
    pages.push(i === 0 ? [head!.replace(/ · 未读完，下一页 cursor=\d+/, ''), ...rest].join('\n') : rest.slice(1).join('\n'))
    const next = /下一页 cursor=(\d+)/.exec(head!)
    if (!next) break
    cursor = next[1]!
  }
  return pages.join('\n\n')
}
