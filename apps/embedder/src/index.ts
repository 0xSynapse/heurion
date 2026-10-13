import { createServer } from 'node:http'
import { DTYPE, MODEL, embed, loadModel } from './model.ts'

/**
 * 本地嵌入服务：POST /embed {texts: string[]} → {embeddings, dimensions, model}；GET /health。
 * 平台经 EMBEDDING_URL 调用；服务不在时资料库退回关键词检索。只监听本机。
 */
const PORT = Number(process.env.EMBED_PORT || 8003)
let ready = false
let dimensions = 0
void loadModel()
  .then(async () => {
    dimensions = (await embed(['ok']))[0]!.length
    ready = true
    console.log(`嵌入模型 ${MODEL}（${DTYPE}）就绪，维度 ${dimensions}`)
  })
  .catch(err => {
    console.error(`嵌入模型 ${MODEL} 加载失败（将在下次请求时重试）:`, err)
  })

const server = createServer(async (req, res) => {
  const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.method === 'GET' && req.url === '/health') return send(ready ? 200 : 503, { ready, model: MODEL, dtype: DTYPE, dimensions })
  if (req.method === 'POST' && req.url === '/embed') {
    const chunks: Buffer[] = []
    let totalBytes = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buf.length
      if (totalBytes > 8_000_000) return send(413, { error: 'too large' })
      chunks.push(buf)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    let texts: unknown
    try { texts = (JSON.parse(raw) as { texts?: unknown }).texts } catch { return send(400, { error: 'bad json' }) }
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 256 || !texts.every(t => typeof t === 'string')) return send(400, { error: 'texts: 1–256 个字符串' })
    try {
      const embeddings = await embed(texts as string[])
      if (!ready && embeddings[0]) {
        dimensions = embeddings[0].length
        ready = true
      }
      return send(200, { embeddings, dimensions: embeddings[0]!.length, model: MODEL })
    } catch (err) {
      return send(500, { error: (err as Error).message })
    }
  }
  send(404, { error: 'not found' })
})
// 容器里设 EMBED_HOST=0.0.0.0（只在内部网络可达，不映射端口）；本机默认只听回环
const HOST = process.env.EMBED_HOST || '127.0.0.1'
server.listen(PORT, HOST, () => console.log(`嵌入服务 http://${HOST}:${PORT}`))
