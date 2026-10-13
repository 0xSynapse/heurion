import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import type * as Y from 'yjs'

/** 与服务端协同网关一致的最小协议：帧 = [类型 varuint][负载]，类型 0 = y-protocols sync。 */
const MSG_SYNC = 0
const REMOTE = Symbol('remote')

export type ProviderStatus = 'connecting' | 'synced' | 'offline'

/**
 * Yjs 同步 provider（PLATFORM.md §9）：断线自动重连；重连后经 step1/step2 交换补齐
 * 双方缺失的更新（断线期间的本地编辑不会丢）。
 */
export class Provider {
  private ws: WebSocket | null = null
  private retry = 0
  private closed = false
  status: ProviderStatus = 'connecting'

  constructor(
    private readonly url: string,
    readonly ydoc: Y.Doc,
    private readonly onStatus: (s: ProviderStatus) => void,
  ) {
    ydoc.on('update', this.onLocalUpdate)
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
      const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer))
      if (decoding.readVarUint(decoder) !== MSG_SYNC) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      const kind = syncProtocol.readSyncMessage(decoder, encoder, this.ydoc, REMOTE)
      if (kind === syncProtocol.messageYjsSyncStep2) this.setStatus('synced')
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder))
    }
    ws.onclose = () => {
      this.ws = null
      if (this.closed) return
      this.setStatus('offline')
      const delay = Math.min(10_000, 500 * 2 ** this.retry++)
      setTimeout(() => this.connect(), delay)
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
    this.ydoc.off('update', this.onLocalUpdate)
    this.ws?.close()
  }
}
