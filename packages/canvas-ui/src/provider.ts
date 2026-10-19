import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import type * as Y from 'yjs'

/** 与服务端协同网关一致的最小协议：帧 = [类型 varuint][负载]，类型 0 = y-protocols sync。 */
const MSG_SYNC = 0
const REMOTE = Symbol('remote')

export type ProviderStatus = 'connecting' | 'synced' | 'offline'

/** 存活检查：每隔这么久向服务端要一次状态（step1）；发出后这么久没有任何回音就判定连接已死、立即重连。 */
const PROBE_MS = 20_000
const PROBE_TIMEOUT_MS = 8_000

/**
 * Yjs 同步 provider（PLATFORM.md §9）：断线自动重连；重连后经 step1/step2 交换补齐
 * 双方缺失的更新（断线期间的本地编辑不会丢）。
 * 半开连接（电脑休眠、代理静默断开）不会触发 onclose，浏览器以为还连着、AI 的修改却再也收不到：
 * 定期探测并在 resync() 时主动补齐，探测无回音就丢掉旧连接重连。
 */
export class Provider {
  private ws: WebSocket | null = null
  private retry = 0
  private closed = false
  private probe: ReturnType<typeof setInterval>
  private waitingSince = 0
  status: ProviderStatus = 'connecting'

  constructor(
    private readonly url: string,
    readonly ydoc: Y.Doc,
    private readonly onStatus: (s: ProviderStatus) => void,
  ) {
    ydoc.on('update', this.onLocalUpdate)
    this.connect()
    this.probe = setInterval(() => this.resync(), PROBE_MS)
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onWake)
      document.addEventListener('visibilitychange', this.onWake)
    }
  }

  /** 向服务端补拉缺失的更新（服务端用 step2 回送）；连接已死则立即重连。 */
  resync(): void {
    if (this.closed) return
    const ws = this.ws
    // 正在退避等待重连：不再等，马上连
    if (!ws) { this.reconnect(); return }
    if (ws.readyState === WebSocket.CONNECTING) return
    if (ws.readyState !== WebSocket.OPEN || (this.waitingSince && Date.now() - this.waitingSince > PROBE_TIMEOUT_MS)) {
      this.reconnect()
      return
    }
    if (!this.waitingSince) this.waitingSince = Date.now()
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.ydoc)
    ws.send(encoding.toUint8Array(encoder))
    // 发出后到期仍无回音：判定半开，重连
    setTimeout(() => { if (this.ws === ws && this.waitingSince && Date.now() - this.waitingSince >= PROBE_TIMEOUT_MS) this.reconnect() }, PROBE_TIMEOUT_MS + 100)
  }

  private onWake = () => {
    if (document.visibilityState === 'visible') { this.retry = 0; this.resync() }
  }

  /** 丢掉当前连接（不等它的 onclose，半开时可能永远等不到）并马上重连。 */
  private reconnect(): void {
    const old = this.ws
    if (old) {
      old.onopen = old.onmessage = old.onclose = null
      try { old.close() } catch { /* 已关闭 */ }
    }
    this.ws = null
    this.waitingSince = 0
    this.retry = 0
    this.connect()
  }

  private setStatus(s: ProviderStatus): void {
    this.status = s
    this.onStatus(s)
  }

  private connect(): void {
    if (this.closed) return
    this.setStatus('connecting')
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      syncProtocol.writeSyncStep1(encoder, this.ydoc)
      ws.send(encoding.toUint8Array(encoder))
    }
    ws.onmessage = event => {
      this.waitingSince = 0
      const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer))
      if (decoding.readVarUint(decoder) !== MSG_SYNC) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      const kind = syncProtocol.readSyncMessage(decoder, encoder, this.ydoc, REMOTE)
      if (kind === syncProtocol.messageYjsSyncStep2) this.setStatus('synced')
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.waitingSince = 0
      if (this.closed) return
      this.setStatus('offline')
      const delay = Math.min(10_000, 500 * 2 ** this.retry++)
      setTimeout(() => { if (!this.ws) this.connect() }, delay)
    }
  }

  private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    this.ws.send(encoding.toUint8Array(encoder))
  }

  destroy(): void {
    this.closed = true
    clearInterval(this.probe)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onWake)
      document.removeEventListener('visibilitychange', this.onWake)
    }
    this.ydoc.off('update', this.onLocalUpdate)
    this.ws?.close()
  }
}
