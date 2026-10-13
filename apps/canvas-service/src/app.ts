import { Hono } from 'hono'
import { getRequestListener } from '@hono/node-server'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { verifyToken, issueToken, type TokenClaims } from '@heurion2/platform/src/auth/token.ts'
import type { Documents } from '@heurion2/platform/src/model/runtime.ts'
import type { OpService } from '@heurion2/platform/src/ops/service.ts'
import { DocOp } from '@heurion2/platform/src/ops/types.ts'
import { DeckOp, newTemplateDeck } from '@heurion2/platform/src/ops/deck.ts'
import { LAYOUTS, templateCatalog } from '@heurion2/platform/src/model/deck-templates.ts'
import { DECK_THEMES, DEFAULT_THEME } from '@heurion2/platform/src/model/deck-themes.ts'
import { pptxTemplate } from '@heurion2/platform/src/convert/pptx-template.ts'
import { docxFor, pptxFor } from '@heurion2/platform/src/convert/exports.ts'
import type { SlideRenderer } from '@heurion2/platform/src/render/slides.ts'
import { exportMarkdown } from '@heurion2/platform/src/views/render.ts'
import { deckOutline, deckRead } from '@heurion2/platform/src/views/deck.ts'
import { diff, outline } from '@heurion2/platform/src/views/read.ts'
import { duplicateDoc } from '@heurion2/platform/src/model/duplicate.ts'
import { renderSvg } from '@heurion2/platform/src/render/diagram.ts'
import type { Store } from '@heurion2/platform/src/store/db.ts'
import { buildCanvasMcpServer, type CanvasMcpDeps } from '@heurion2/platform/src/mcp/server.ts'
import { TurnRegistry } from '@heurion2/platform/src/mcp/turns.ts'
import { PubMedClient } from '@heurion2/platform/src/literature/pubmed.ts'
import { CrossrefClient } from '@heurion2/platform/src/literature/crossref.ts'
import { OpenAlexClient } from '@heurion2/platform/src/literature/openalex.ts'

export interface CanvasAppDeps {
  store: Store
  docs: Documents
  ops: OpService
  renderer: SlideRenderer
  secret: string
  devMode?: boolean
  devUser?: string
  workspaceDir?: () => string
  pubmed?: PubMedClient
  crossref?: CrossrefClient
  openalex?: OpenAlexClient
}

export function createCanvasApp(deps: CanvasAppDeps) {
  const { store, docs, ops, renderer, secret, devMode = false, devUser = 'dev' } = deps
  const app = new Hono<{ Variables: { user: string; claims?: TokenClaims } }>()

  // 1. 健康检查与能力发现
  app.get('/health', c => c.json({
    status: 'ok',
    service: 'omnicanvas',
    name: 'OmniCanvas / AgentDoc AI Native Service',
    version: '0.1.0',
    capabilities: ['documents', 'decks', 'crdt-collab', 'canvas-mcp', 'diagrams', 'academic-citations', 'docx-export', 'pptx-export'],
  }))

  // 2. 独立 Web 工作台静态托管
  const DIST = fileURLToPath(new URL('../dist-web/', import.meta.url))
  const MIME: Record<string, string> = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
  }

  app.get('/assets/:file', c => {
    const file = join(DIST, 'assets', basename(c.req.param('file')))
    if (!existsSync(file)) return c.notFound()
    return c.body(readFileSync(file), 200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
  })

  app.get('/', c => {
    const indexFile = join(DIST, 'index.html')
    if (existsSync(indexFile)) {
      return c.html(readFileSync(indexFile, 'utf8'))
    }
    return c.text('OmniCanvas Web 工作台运行中。若需独立 Web 界面，请运行 pnpm --filter @heurion2/canvas-service build', 200)
  })

  // 1.1 免登录开发者会话获取（自动为 Web 前端与 MCP 客户端分发有效签名的 Token）
  app.get('/api/auth/session', c => {
    const user = devUser || 'editor'
    const webToken = issueToken(secret, {
      u: user,
      d: '*',
      p: ['read', 'write'],
      aud: 'web',
      ttlSeconds: 86400 * 30,
    })
    const mcpToken = issueToken(secret, {
      u: user,
      d: '*',
      p: ['read', 'write'],
      aud: 'mcp',
      ttlSeconds: 86400 * 30,
    })
    return c.json({ user, webToken, mcpToken })
  })

  // 3. 统一身份认证中间件
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/auth/session') return next()
    const auth = c.req.header('authorization') ?? ''
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7)
      const claims = verifyToken(secret, token, 'web') ?? verifyToken(secret, token, 'mcp')
      if (claims) {
        c.set('user', claims.u)
        c.set('claims', claims)
        return next()
      }
    }
    if (devMode && devUser) {
      c.set('user', devUser)
      return next()
    }
    return c.json({ error: 'unauthorized', message: '需要有效的认证令牌' }, 401)
  })

  // 3. 模板与主题目录
  app.get('/api/templates/deck', c => {
    return c.json({
      layouts: LAYOUTS,
      catalog: templateCatalog(),
      themes: DECK_THEMES,
    })
  })

  // 4. 文档列表与创建
  app.get('/api/docs', c => {
    const user = c.get('user')
    const list = store.listDocs(user)
    return c.json(list)
  })

  app.post('/api/docs', async c => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({}))
    const kind = body.kind === 'deck' ? 'deck' : 'doc'
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : (kind === 'deck' ? '未命名幻灯片' : '未命名文档')

    if (kind === 'deck') {
      const theme = body.theme && DECK_THEMES[body.theme] ? body.theme : DEFAULT_THEME
      const pkg = pptxTemplate(theme)
      const row = docs.create({ owner: user, title, kind: 'deck', content: newTemplateDeck(title, theme) })
      store.putPackage(row.id, 'pptx', pkg)
      return c.json(store.getDoc(row.id)!, 201)
    }

    const row = docs.create({ owner: user, title })
    return c.json(store.getDoc(row.id)!, 201)
  })

  // 5. 单文档读写
  app.get('/api/docs/:id', c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user) return c.json({ error: 'not_found' }, 404)
    const content = docs.get(id).toJSON()
    return c.json({
      ...row,
      rev: docs.rev(id),
      versions: store.listVersions(id),
      citations: store.listCitations(id),
      comments: store.listComments(id),
      content,
    })
  })

  app.patch('/api/docs/:id', async c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user) return c.json({ error: 'not_found' }, 404)
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.title === 'string' && body.title.trim()) {
      store.renameDoc(id, body.title.trim())
    }
    return c.json(store.getDoc(id)!)
  })

  app.delete('/api/docs/:id', c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user) return c.json({ error: 'not_found' }, 404)
    store.trashDoc(id, true)
    return c.json({ ok: true, trashed: true })
  })

  app.post('/api/docs/:id/restore', c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.owner !== user) return c.json({ error: 'not_found' }, 404)
    store.trashDoc(id, false)
    return c.json(store.getDoc(id)!)
  })

  app.post('/api/docs/:id/duplicate', c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user) return c.json({ error: 'not_found' }, 404)
    const copy = duplicateDoc(docs, row, user)
    return c.json(copy, 201)
  })

  // 6. 文档视图（大纲、幻灯片、导出）
  app.get('/api/docs/:id/outline', c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user) return c.json({ error: 'not_found' }, 404)

    if (row.kind === 'deck') {
      const info = ops.deckContextInfo(id)
      return c.text(deckOutline({
        doc: docs.get(id),
        docId: id,
        title: row.title,
        rev: docs.rev(id),
        layouts: info.layouts,
        size: info.size,
        openComments: store.listComments(id, 'open').length,
        platform: info.platform,
      }))
    }

    return c.text(outline({
      doc: docs.get(id),
      docId: id,
      title: row.title,
      rev: docs.rev(id),
      citations: store.listCitations(id),
      openComments: store.listComments(id, 'open').length,
    }))
  })

  app.get('/api/docs/:id/deck', async c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user || row.kind !== 'deck') return c.json({ error: 'not_found' }, 404)
    if (c.req.header('accept')?.includes('text/plain') || c.req.query('format') === 'text') {
      const cursor = c.req.query('cursor') ? parseInt(c.req.query('cursor')!, 10) : 0
      return c.text(deckRead(docs.get(id), docs.rev(id), cursor))
    }
    const info = ops.deckContextInfo(id)
    const ph_styles = Object.fromEntries(info.layouts.map(l => [l.part, l.placeholders.map(p => ({ type: p.type, idx: p.idx, style: p.style ?? {} }))]))
    const render_info = await renderer.diagnose()
    return c.json({ rev: docs.rev(id), size: info.size, layouts: info.layouts.map(l => l.name), ph_styles, doc: docs.get(id).toJSON(), render_info })
  })

  app.get('/api/docs/:id/export.md', c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user) return c.text('Not found', 404)
    const citations = store.listCitations(id)
    const md = exportMarkdown(docs.get(id), citations)
    return c.text(md, 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(row.title)}.md"`,
    })
  })

  app.get('/api/docs/:id/export.docx', c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user) return c.text('Not found', 404)
    const bytes = docxFor(docs, id).bytes
    return c.body(Buffer.from(bytes), 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(row.title)}.docx"`,
    })
  })

  app.get('/api/docs/:id/export.pptx', c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user || row.kind !== 'deck') return c.text('Not found', 404)
    const bytes = pptxFor(docs, id).bytes
    return c.body(Buffer.from(bytes), 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(row.title)}.pptx"`,
    })
  })

  app.get('/api/docs/:id/slides/:index/render.png', async c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const index = parseInt(c.req.param('index'), 10)
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user || row.kind !== 'deck') return c.text('Not found', 404)
    try {
      const info = ops.deckContextInfo(id)
      const pngs = await renderer.render(`${id}/${docs.rev(id)}`, {
        pptx: () => pptxFor(docs, id).bytes,
        getDoc: () => docs.get(id),
        size: info.size,
        getAssetBytes: aid => store.getAssetBytes(aid),
      })
      const png = pngs[index]
      if (!png) return c.text('Slide not found', 404)
      return c.body(readFileSync(png), 200, { 'Content-Type': 'image/png' })
    } catch (err: any) {
      return c.json({ error: 'render_failed', message: err.message }, 500)
    }
  })

  // 7. 原子编辑（DocOp / DeckOp 批处理提交）
  app.post('/api/docs/:id/edit', async c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user) return c.json({ error: 'not_found' }, 404)
    const body = await c.req.json()
    const opsList = (Array.isArray(body.ops) ? body.ops : [body.op || body]) as any
    const baseRev = typeof body.base_rev === 'number' ? body.base_rev : docs.rev(id)
    const mode = body.mode === 'suggest' ? 'suggest' : 'apply'
    try {
      const res = ops.edit({
        doc_id: id,
        base_rev: baseRev,
        ops: opsList,
        mode,
        ack_comments: body.ack_comments,
      }, { actor: 'user', turnId: null, user })
      return c.json(res)
    } catch (err: any) {
      return c.json({ error: err.code || 'op_failed', message: err.message }, 400)
    }
  })

  // 8. 差异比对
  app.get('/api/docs/:id/diff', c => {
    const user = c.get('user')
    const id = c.req.param('id')
    const row = store.getDoc(id)
    if (!row || row.deleted_at || row.owner !== user) return c.json({ error: 'not_found' }, 404)
    const versions = store.listVersions(id)
    const fromVer = c.req.query('from') ? parseInt(c.req.query('from')!, 10) : undefined
    const toVer = c.req.query('to') ? parseInt(c.req.query('to')!, 10) : undefined
    const before = fromVer ? docs.versionDoc(id, fromVer) : (versions[0] ? docs.versionDoc(id, versions[0].seq) : docs.get(id))
    const after = toVer ? docs.versionDoc(id, toVer) : docs.get(id)
    if (!before || !after) return c.json({ error: 'version_not_found' }, 404)
    return c.json({ from_version: fromVer, to_version: toVer, changes: diff(before, after) })
  })

  // 9. 矢量图渲染（Mermaid / SVG 机制图转 PNG 资产）
  app.post('/api/diagram/render', async c => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({}))
    const svg = body.svg
    if (!svg || typeof svg !== 'string' || svg.length < 20) {
      return c.json({ error: 'invalid_svg', message: 'SVG 文本不完整或过短' }, 400)
    }
    const out = renderSvg(svg, body.width_px ?? 1600)
    const asset = store.putAsset({
      owner: user,
      mime: 'image/png',
      name: `${body.name || 'diagram'}.png`,
      bytes: out.png,
    })
    return c.json({
      asset_id: asset.id,
      width: out.width,
      height: out.height,
      markdown: `![${body.name || '机制图'}](asset:${asset.id})`,
    })
  })

  // 10. 资产管理
  app.get('/api/assets/:id', c => {
    const id = c.req.param('id')
    const asset = store.getAsset(id)
    if (!asset) return c.text('Asset not found', 404)
    const bytes = store.getAssetBytes(id)
    if (!bytes) return c.text('Asset data not found', 404)
    return c.body(Buffer.from(bytes), 200, {
      'Content-Type': asset.mime,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
  })

  // 11. MONAI 医学影像分析代理与资产沉淀
  const imagingWorkerUrl = (process.env.IMAGING_WORKER_URL || 'http://127.0.0.1:8004').replace(/\/+$/, '')

  app.get('/api/imaging/status', async c => {
    try {
      const resp = await fetch(`${imagingWorkerUrl}/health`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return c.json({ error: 'imaging_worker_error', status: 'error' }, 502)
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message, status: 'offline' }, 503)
    }
  })

  app.get('/api/imaging/models', async c => {
    try {
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/models`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return c.json({ error: 'imaging_worker_error' }, 502)
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.get('/api/imaging/samples', async c => {
    try {
      const resp = await fetch(`${imagingWorkerUrl}/api/v1/samples`, { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return c.json({ error: 'imaging_worker_error' }, 502)
      return c.json(await resp.json())
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  app.post('/api/imaging/analyze', async c => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({}))
    try {
      let endpoint = `${imagingWorkerUrl}/api/v1/analyze/benchmark`
      let reqBody: Record<string, unknown> = {
        model_name: body.model_id || 'lung_nodule_segmenter',
        window_preset: body.window_preset || 'lung',
        z_slices: body.z_slices || 48,
        y_dim: 128,
        x_dim: 128,
      }
      if (body.sample_id) {
        endpoint = `${imagingWorkerUrl}/api/v1/analyze/sample`
        reqBody = {
          sample_id: body.sample_id,
          model_name: body.model_id,
          window_preset: body.window_preset,
        }
      } else if (body.file_path) {
        endpoint = `${imagingWorkerUrl}/api/v1/analyze/file`
        reqBody = {
          file_path: body.file_path,
          model_name: body.model_id,
          window_preset: body.window_preset,
        }
      }

      if (body.mucus_min_hu !== undefined) reqBody.mucus_min_hu = body.mucus_min_hu
      if (body.mucus_max_hu !== undefined) reqBody.mucus_max_hu = body.mucus_max_hu
      if (body.ham_threshold_hu !== undefined) reqBody.ham_threshold_hu = body.ham_threshold_hu
      if (body.bar_cutoff !== undefined) reqBody.bar_cutoff = body.bar_cutoff

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        return c.json({ error: 'inference_failed', message: text }, 502)
      }
      const data = await resp.json()

      // 提取 Base64 关键截面图沉淀为永久资产
      const b64 = String(data.key_slice_png_base64 || '').replace(/^data:image\/png;base64,/, '')
      let assetId: string | null = null
      if (b64) {
        const buf = Buffer.from(b64, 'base64')
        const asset = store.putAsset({
          owner: user,
          mime: 'image/png',
          name: `${body.label || 'monai-recist-slice'}.png`,
          bytes: buf,
        })
        assetId = asset.id
      }

      return c.json({
        ...data,
        asset_id: assetId,
        image_url: assetId ? `/api/assets/${assetId}` : null,
        markdown: assetId ? `![${body.label || 'RECIST 截面'}](asset:${assetId})` : null,
      })
    } catch (err: any) {
      return c.json({ error: 'imaging_worker_offline', message: err.message }, 503)
    }
  })

  return app
}

/** 创建包含 MCP 端点与 HTTP API 的完整 Node.js Request Handler */
export function buildCanvasHandler(deps: CanvasAppDeps) {
  const app = createCanvasApp(deps)
  const listener = getRequestListener(app.fetch)
  const turnRegistry = new TurnRegistry()
  const canvasDeps: CanvasMcpDeps = {
    docs: deps.docs,
    ops: deps.ops,
    turns: turnRegistry,
    renderer: deps.renderer,
    pubmed: deps.pubmed ?? new PubMedClient(fetch),
    crossref: deps.crossref ?? new CrossrefClient(fetch),
    openalex: deps.openalex ?? new OpenAlexClient(fetch),
    secret: deps.secret,
    workspaceDir: deps.workspaceDir ?? (() => '/tmp'),
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/mcp') {
      const auth = req.headers.authorization ?? ''
      let claims = auth.startsWith('Bearer ')
        ? verifyToken(deps.secret, auth.slice(7), 'mcp') ?? verifyToken(deps.secret, auth.slice(7), 'web')
        : null
      if (!claims && deps.devMode && deps.devUser) {
        claims = {
          u: deps.devUser,
          d: '*',
          p: ['read', 'write'],
          aud: 'mcp',
          exp: Math.floor(Date.now() / 1000) + 86400,
        }
      }
      if (!claims) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized', message: 'MCP 需要有效的 Bearer 令牌' }))
        return
      }
      const server = buildCanvasMcpServer(canvasDeps, claims)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res)
      return
    }

    // 转交 Hono 处理
    return listener(req, res)
  }
}
