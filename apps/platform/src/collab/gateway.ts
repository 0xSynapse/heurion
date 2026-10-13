import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { WebSocketServer, type WebSocket } from 'ws'
import * as syncProtocol from 'y-protocols/sync'
import type * as Y from 'yjs'
import type { Documents } from '../model/runtime.ts'
import type { DocRow } from '../store/db.ts'
import { allows, type ResourceRole } from '../research/access.ts'

/**
 * 协同网关（PLATFORM.md §9 P1）：最小 WebSocket 协议，`/collab/<docId>?token=`。
 *
 * 帧 = [类型 varuint][负载]。类型 0 = y-protocols sync（step1 / step2 / update）。
 * 浏览器编辑直接写进 Documents 持有的同一个 Y.Doc（origin = 连接），由 Documents 合批落库；
 * 服务端提交（AI、回滚、评论锚点）经 Y.Doc 的 update 事件广播给所有连接。
 * 人类编辑不经硬守卫（Yjs 更新在客户端已生效），事后检查见 postcheck.ts。
 */

export const MSG_SYNC = 0

export interface GatewayDeps {
  docs: Documents
  /** 令牌 → 用户；无效返回 null。 */
  authenticate: (token: string) => string | null
  /** 用户对文档的角色（研究共享文档：成员角色；其余只有主人）。不给时只放行主人。 */
  role?: (user: string, doc: DocRow) => ResourceRole | null
}

export function attachCollab(server: Server, deps: GatewayDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const m = /^\/collab\/([^/]+)$/.exec(url.pathname)
    if (!m) return
    const docId = decodeURIComponent(m[1]!)
    const user = deps.authenticate(url.searchParams.get('token') ?? '')
    const row = deps.docs.store.getDoc(docId)
    const role = user && row ? (deps.role ? deps.role(user, row) : row.owner === user ? 'owner' : null) : null
    if (!user || !row || !role || row.kind !== 'doc' || row.deleted_at) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      // 连接上记下用户：合批落库时据此知道是谁改的（记忆信号只记在本人名下）
      ;(ws as WebSocket & { heurionUser?: string }).heurionUser = user
      deps.docs.pin(docId)
      const canWrite = () => {
        const cur = deps.docs.store.getDoc(docId)
        if (!cur || cur.deleted_at) return false
        const curRole = deps.role ? deps.role(user, cur) : (cur.owner === user ? 'owner' : null)
        return curRole ? allows(curRole, 'write') : false
      }
      connect(ws, deps.docs.ydoc(docId), canWrite, () => deps.docs.unpin(docId))
    })
  })
  return wss
}

function send(ws: WebSocket, encoder: encoding.Encoder): void {
  if (ws.readyState === ws.OPEN) ws.send(encoding.toUint8Array(encoder))
}

const HEARTBEAT_MS = 30_000

/** writable=false（研究里的只读成员）：只同步服务端的内容给他，丢弃他发来的修改。 */
function connect(ws: WebSocket, ydoc: Y.Doc, writable: boolean | (() => boolean) = true, onClose?: () => void): void {
  let alive = true
  let closed = false
  ws.on('pong', () => { alive = true })
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate()
      return
    }
    alive = false
    if (ws.readyState === ws.OPEN) ws.ping()
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === ws) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    send(ws, encoder)
  }
  ydoc.on('update', onUpdate)

  ws.on('message', (data: Buffer) => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(decoder)
      if (type !== MSG_SYNC) return
      const isWritable = typeof writable === 'function' ? writable() : writable
      // 只读：只处理 step1（客户端请求服务端状态），step2 / update（客户端的修改）丢弃
      if (!isWritable && decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      // 连接对象本身作为 origin：Documents 据此识别为浏览器编辑；广播时跳过发起方
      syncProtocol.readSyncMessage(decoder, encoder, ydoc, ws)
      if (encoding.length(encoder) > 1) send(ws, encoder)
    } catch (err) {
      console.error('[collab] bad message', err)
      ws.close(1003, 'bad message')
    }
  })
  ws.on('error', err => {
    console.warn('[collab] ws error', err)
    ws.terminate()
  })
  ws.on('close', () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    ydoc.off('update', onUpdate)
    onClose?.()
  })

  // 服务端先发 step1：客户端据此回送服务端缺的更新（断线期间的本地编辑）
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  syncProtocol.writeSyncStep1(encoder, ydoc)
  send(ws, encoder)
}
