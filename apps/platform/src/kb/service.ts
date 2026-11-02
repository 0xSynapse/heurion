import { createHash } from 'node:crypto'
import type { KbChunkHit, KbFileRow, Store } from '../store/db.ts'
import type { Embedder } from './embedder.ts'
import { chunkPages, extractText, ExtractError, KB_TYPES } from './extract.ts'
import type { Ocr } from './ocr.ts'

/**
 * 参考资料库：上传 → 抽取文字（保留页码）→ 切块 → 向量化（本地 bge-m3，可选）。
 * 检索 = 关键词（FTS5 trigram）与向量（余弦）两路用 RRF 合并；嵌入服务不可用时只用关键词。
 * 处理是串行队列（每份资料一个任务），启动时继续未完成的；嵌入服务之后才就绪的资料定时补向量。
 */
export class KbService {
  private queue: string[] = []
  private running = false

  constructor(private readonly store: Store, private readonly embedder: Embedder | null, private readonly ocr: Ocr | null = null) {}

  async upload(owner: string, input: { name: string; bytes: Uint8Array; project_id?: string | null }): Promise<{ file: KbFileRow; duplicate: boolean }> {
    const ext = input.name.toLowerCase().split('.').pop() ?? ''
    const mime = KB_TYPES[ext]
    if (!mime) throw new ExtractError(`不支持的文件类型 .${ext}（支持 PDF、docx、pptx、txt、md）`)
    if (input.bytes.length > 50 * 1024 * 1024) throw new ExtractError('文件超过 50MB')
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const { row, duplicate } = this.store.addKbFile({ owner, project_id: input.project_id ?? null, name: input.name, mime, bytes: input.bytes, sha256 })
    if (!duplicate) this.enqueue(row.id)
    return { file: row, duplicate }
  }

  /** 启动时继续未完成的处理；之后每 5 分钟检查一次有没有可以补向量的资料。 */
  resume(): void {
    for (const f of this.store.listKbUnfinished()) this.enqueue(f.id)
    setInterval(() => {
      if (this.queue.length === 0) for (const f of this.store.listKbUnfinished()) this.enqueue(f.id)
    }, 5 * 60_000).unref()
  }

  /** 资料库状态：向量检索是否可用（嵌入服务没配或没起来时只有关键词检索）。 */
  async status(): Promise<{ enabled: true; vector: boolean }> {
    return { enabled: true, vector: this.embedder ? await this.embedder.available() : false }
  }

  enqueue(fileId: string): void {
    if (!this.queue.includes(fileId)) this.queue.push(fileId)
    void this.drain()
  }

  /** 等队列处理完（测试用）。 */
  async idle(): Promise<void> {
    while (this.running || this.queue.length > 0) await new Promise(r => setTimeout(r, 10))
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (let id = this.queue.shift(); id; id = this.queue.shift()) {
        try { await this.process(id) } catch (err) {
          this.store.updateKbFile(id, { status: 'failed', note: err instanceof ExtractError ? err.message : `处理失败：${(err as Error).message.slice(0, 200)}` })
        }
      }
    } finally {
      this.running = false
    }
  }

  private async process(id: string): Promise<void> {
    const file = this.store.getKbFile(id)
    if (!file) return
    if (file.chunks === 0) {
      this.store.updateKbFile(id, { status: 'extracting', note: null })
      const bytes = this.store.getKbBytes(id)!
      const extracted = await extractText(file.name, bytes, {
        ocr: this.ocr ?? undefined,
        onOcr: (done, total) => this.store.updateKbFile(id, { status: 'ocr', note: `扫描页识别文字：${done} / ${total} 页` }),
      })
      const chunks = chunkPages(extracted.pages)
      this.store.putKbChunks(file, chunks)
      this.store.updateKbFile(id, { pages: extracted.pages.length, chunks: chunks.length, embedded: 0, doi: extracted.doi, pmid: extracted.pmid, note: extracted.note })
    }
    const current = this.store.getKbFile(id)!
    if (!this.embedder || !(await this.embedder.available())) {
      // 没有嵌入服务：先可用（关键词检索），之后再补
      this.store.updateKbFile(id, { status: 'ready', note: current.note ?? (this.embedder ? '向量化服务暂不可用，先支持关键词检索，稍后自动补上' : null) })
      return
    }
    this.store.updateKbFile(id, { status: 'embedding' })
    try {
      for (let batch = this.store.kbChunksToEmbed(id, 32); batch.length > 0; batch = this.store.kbChunksToEmbed(id, 32)) {
        const vectors = await this.embedder.embed(batch.map(c => c.text))
        batch.forEach((c, i) => this.store.setKbEmbedding(c.id, vectors[i]!))
        this.store.updateKbFile(id, { embedded: this.store.countKbEmbedded(id) })
      }
      const done = this.store.getKbFile(id)!
      this.store.updateKbFile(id, { status: 'ready', note: done.note?.startsWith('向量化服务') ? null : done.note })
    } catch {
      const fallback = this.store.getKbFile(id)!
      this.store.updateKbFile(id, { status: 'ready', note: fallback.note ?? '向量化服务暂不可用，先支持关键词检索，稍后自动补上' })
    }
  }

  /**
   * 混合检索：关键词与向量各取 3 倍候选，按 RRF（k=60）合并，返回前 limit 条。
   * fileIds 限定资料范围（项目、对话里选中的资料）。
   */
  async search(owner: string, query: string, opts: { limit?: number; fileIds?: string[] } = {}): Promise<KbChunkHit[]> {
    const limit = opts.limit ?? 8
    const keyword = this.store.kbKeywordSearch(owner, query, limit * 3, opts.fileIds)
    let vector: KbChunkHit[] = []
    if (this.embedder && await this.embedder.available()) {
      try {
        const [q] = await this.embedder.embed([query])
        vector = this.store.kbVectorSearch(owner, q!, limit * 3, opts.fileIds)
      } catch { /* 嵌入服务出错：只用关键词 */ }
    }
    const fused = new Map<string, KbChunkHit & { rrf: number }>()
    for (const list of [keyword, vector]) {
      list.forEach((hit, rank) => {
        const prev = fused.get(hit.chunk_id)
        const add = 1 / (60 + rank + 1)
        fused.set(hit.chunk_id, prev ? { ...prev, rrf: prev.rrf + add } : { ...hit, rrf: add })
      })
    }
    return [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit).map(({ rrf, ...h }) => ({ ...h, score: Number(rrf.toFixed(4)) }))
  }
}
