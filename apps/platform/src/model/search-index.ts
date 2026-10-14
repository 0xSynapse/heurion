import { schemaFor, stateToDoc, type Documents } from './runtime.ts'

/**
 * 文档全文索引（R2）：提交后防抖更新（同一文档 2 秒内多次提交只索引一次）；启动时补齐没有索引的文档。
 * 索引内容是文档的纯文字（deck 含各页文字与备注），回收站里的文档查询时排除。
 */
export class SearchIndex {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly docs: Documents, private readonly delayMs = 2000) {
    docs.on('commit', e => this.schedule(e.docId))
    docs.on('created', row => this.schedule(row.id))
  }

  /** 补齐没有索引的文档（启动时）。 */
  backfill(): number {
    const have = this.docs.store.indexedDocIds()
    const missing = this.docs.store.allDocIds().filter(id => !have.has(id))
    let count = 0
    for (const id of missing) {
      try {
        this.reindex(id)
        count++
      } catch (err) {
        console.error(`[search-index] backfill error for ${id}:`, err)
      }
    }
    return count
  }

  schedule(docId: string): void {
    clearTimeout(this.timers.get(docId))
    const timer = setTimeout(() => {
      this.timers.delete(docId)
      try {
        this.reindex(docId)
      } catch (err) {
        console.error(`[search-index] reindex error for ${docId}:`, err)
      }
    }, this.delayMs)
    timer.unref?.()
    this.timers.set(docId, timer)
  }

  reindex(docId: string): void {
    const row = this.docs.store.getDoc(docId)
    if (!row || row.deleted_at) { this.docs.store.unindexDoc(docId); return }
    if (row.context) {
      try {
        if (JSON.parse(row.context)?.kind === 'copilot') {
          this.docs.store.unindexDoc(docId)
          return
        }
      } catch { /* ignore */ }
    }
    let doc
    if (this.docs.isLoaded(docId)) {
      doc = this.docs.get(docId)
    } else {
      const snap = (row as { snapshot?: string | null }).snapshot
      if (snap) {
        try { doc = schemaFor(row.kind).nodeFromJSON(JSON.parse(snap)) } catch { /* fallback */ }
      }
      if (!doc) {
        const state = this.docs.store.getState(docId)
        doc = state ? stateToDoc(state, row.kind) : this.docs.get(docId)
      }
    }
    this.docs.store.indexDoc(row, doc.textBetween(0, doc.content.size, '\n', ' '))
  }

  /** 立即处理所有等待中的更新（测试、关闭服务前用）。 */
  flush(): void {
    for (const [id, t] of this.timers) {
      clearTimeout(t)
      try { this.reindex(id) } catch (err) { console.error(`[search-index] flush error for ${id}:`, err) }
    }
    this.timers.clear()
  }
}
