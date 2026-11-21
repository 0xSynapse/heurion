// Heurion 做法：在本地进程里起 Heurion 的 MCP 服务（与线上同一套代码，来源规则开启），经 stdio 给评测用的智能体循环调用。
// 与外部工具组用同一个智能体循环、同一个模型，差别只在工具层。以外部智能体的身份接入（会话为观察记录键）。
//   serve  <db> <docx> <session>  ：没有文档时先导入 docx（批注成为评论线程、修订成为待采纳修订），然后提供 MCP 服务
//   doctor <db>                    ：模拟医生，确认 AI 生成的全部「采纳修订」卡（修订决定卡，docs/design/PROTECTION_RESOLUTION.md）
//   export <db> <out.docx>         ：导出 Word（未改动的块原样写回，改过的按原 XML 打补丁，待采纳修订写成 Word 修订）
// 在 apps/platform 目录下运行：node_modules/.bin/tsx <本文件> …（文献检索走真实的 PubMed / Crossref / OpenAlex / 开放获取全文）
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const imp = (p: string) => import(join(root, p))
console.log = (...a: unknown[]) => console.error(...a) // stdout 只留给 MCP 协议

const { StdioServerTransport } = await import(join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js'))
const { Store, newCommentId } = await imp('src/store/db.ts')
const { Documents } = await imp('src/model/runtime.ts')
const { OpService } = await imp('src/ops/service.ts')
const { importDocx, bindComments } = await imp('src/convert/docx-import.ts')
const { exportDocx } = await imp('src/convert/docx-export.ts')
const { issueToken, verifyToken } = await imp('src/auth/token.ts')
const { buildMcpServer } = await imp('src/mcp/server.ts')
const { TurnRegistry } = await imp('src/mcp/turns.ts')
const { ClaimService } = await imp('src/claims/service.ts')
const { PubMedClient } = await imp('src/literature/pubmed.ts')
const { CrossrefClient } = await imp('src/literature/crossref.ts')
const { OpenAlexClient } = await imp('src/literature/openalex.ts')
const { FullTextClient } = await imp('src/literature/fulltext.ts')
const { SlideRenderer } = await imp('src/render/slides.ts')
const { allNumbers } = await imp('src/ops/numbers.ts')
const { acceptRevisionAndRetry } = await imp('src/ops/revision-decision.ts')

const SECRET = 'bench-secret-not-for-production-0123456789'
const USER = 'author'
const [mode, dbPath, a3, a4] = process.argv.slice(2)
const store = new Store(resolve(dbPath!))
const docs = new Documents(store)
const ops = new OpService(docs, undefined, undefined, { provenance: true })
const docIdFile = resolve(dbPath!) + '.docid'

function importOnce(docxPath: string): string {
  if (existsSync(docIdFile)) return readFileSync(docIdFile, 'utf8').trim()
  const bytes = new Uint8Array(readFileSync(docxPath))
  const r = importDocx(bytes)
  const bound = bindComments(r.doc, r.comments, newCommentId)
  const row = docs.create({ owner: USER, title: 'manuscript', content: bound.doc, source: 'import' })
  store.putNodeSrc(row.id, r.src)
  store.putPackage(row.id, 'docx', bytes)
  for (const t of bound.threads) {
    store.addComment({ id: t.id, doc_id: row.id, node_id: t.node_id, snippet: t.snippet, source_ref: `word:${t.word_id}:${t.replies.length}` })
    store.addReply(t.id, 'user', t.text, null, t.author)
    for (const x of t.replies) store.addReply(t.id, 'user', x.text, null, x.author)
    if (t.done) store.setCommentStatus(row.id, t.id, 'resolved', 'user')
  }
  writeFileSync(docIdFile, row.id)
  return row.id
}

if (mode === 'serve') {
  const docId = importOnce(a3!)
  const session = a4 ?? 's1'
  // 与平台回合一致：用户本轮消息里的数字算 AI 看到过的（平台回合由 turns 服务记；评测里用户消息由智能体循环转来，经环境变量传入）
  if (process.env.BENCH_USER_MESSAGE) store.addObservedNumbers(`sess:${session}`, allNumbers(process.env.BENCH_USER_MESSAGE))
  const claims = verifyToken(SECRET, issueToken(SECRET, { u: USER, s: session, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 86400 }), 'mcp')
  const pubmed = new PubMedClient(fetch, process.env.NCBI_API_KEY ?? '', '')
  const fulltext = new FullTextClient(store, fetch, '')
  const server = buildMcpServer({
    docs, ops, turns: new TurnRegistry(), secret: SECRET, devMode: true,
    claims: new ClaimService(docs, pubmed, fulltext), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'bench-r-'))),
    pubmed, crossref: new CrossrefClient(fetch, ''), openalex: new OpenAlexClient(fetch, ''), fulltext,
    workspaceDir: () => mkdtempSync(join(tmpdir(), 'bench-ws-')), isLiveSession: () => true,
  }, claims)
  console.error(`[bridge] doc_id=${docId} session=${session}`)
  await server.connect(new StdioServerTransport())
  process.on('SIGTERM', () => { docs.flushAll(); process.exit(0) })
} else if (mode === 'doctor') {
  // 模拟医生：确认这道任务里 AI 生成的全部「采纳修订」卡（与网页上点「确认」走同一个函数），结果打印成 JSON
  const out: unknown[] = []
  for (const a of store.listPendingActions(USER, 'pending')) {
    if (a.action !== 'accept_revision' || !a.followup) continue
    store.setPendingActionStatus(a.id, 'pending', 'running', { decided_by: USER })
    const r = acceptRevisionAndRetry({ docs, ops }, USER, JSON.parse(a.followup))
    store.setPendingActionStatus(a.id, 'running', 'done', { result: JSON.stringify({ ok: true, ...r }), decided_by: USER })
    out.push({ action: a.id, summary: a.summary, ...r })
  }
  docs.flushAll()
  // console.log 在本程序里被转到了 stderr（stdout 留给 MCP），这里直接写 stdout
  process.stdout.write(JSON.stringify(out) + '\n', () => process.exit(0))
} else if (mode === 'export') {
  const docId = readFileSync(docIdFile, 'utf8').trim()
  docs.flushAll()
  const out = exportDocx({
    doc: docs.get(docId), baseline: docs.versionDoc(docId, 1), pkg: store.getPackage(docId),
    src: (id: string) => store.getNodeSrc(docId, id), citations: store.listCitations(docId), comments: store.listComments(docId), asset: () => null,
  })
  writeFileSync(resolve(a3!), out.bytes)
  console.error(`[bridge] exported ${out.bytes.length} bytes; ${out.warnings.join(' / ')}`)
  process.exit(0)
} else {
  console.error('用法：serve <db> <docx> <session> | doctor <db> | export <db> <out.docx>')
  process.exit(2)
}
