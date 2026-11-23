import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { runDeterministicDeepReviewOnMarkdown } from '../src/claims/markdown-audit.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { DocxImportError, safeUnzipDocx } from '../src/convert/docx-import.ts'
import { DatasetService } from '../src/datasets/service.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import { clearPublicCitationCache, checkPublicRateLimit } from '../src/http/routes/public-tools-api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { verticalInstructions } from '../src/mcp-hub/verticals.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import { TurnService } from '../src/turns/service.ts'

const REGISTRY_DIR = fileURLToPath(new URL('../../../deploy/mcp-registry/', import.meta.url))

function setupVerticalEnv(opts: {
  aegisEnabled?: boolean
  reviewComplete?: (sys: string, user: string) => Promise<string>
  pubmed?: PubMedClient
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-vert-'))
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const registry = new TurnRegistry()
  const accounts = new Accounts(store, {
    secret: 'vert-test-secret',
    devMode: false,
    devToken: 'dev',
    devUser: 'dev',
    botGuard: { issue: () => ({} as never), verify: () => {} } as never,
  })
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'vert-test-secret' }))
  const patients = new PatientService(join(dir, 'tenants'), tenants, keys, store)
  const datasets = new DatasetService(store, join(dir, 'ds'), async () => {
    const out = mkdtempSync(join(dir, 'ds-out-'))
    const csv = join(out, 'data.csv')
    writeFileSync(csv, 'arm,age\nA,60\nB,64\n')
    return { csv, cleanup: () => {}, profile: { ok: true, rows: 2, truncated: false, columns: [] } }
  })
  const pool = {
    liveSession: () => null,
    run: () => new Promise(() => {}),
    cancel: async () => {},
    workspaceDir: () => dir,
  } as unknown as HarnessPool

  const defaultPubmed = opts.pubmed ?? ({
    search: async () => [],
    fetch: async () => [],
    abstract: async () => null,
    lookup: async () => null,
  } as unknown as PubMedClient)

  const app = buildApi({
    docs,
    ops,
    turns: new TurnService(docs, pool, registry),
    turnRegistry: registry,
    postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient,
    pubmed: defaultPubmed,
    renderer: new SlideRenderer(join(dir, 'render')),
    accounts,
    devMode: false,
    aegisEnabled: opts.aegisEnabled ?? true,
    publicOrigin: 'https://heurion.org',
    devUser: 'dev',
    patients,
    datasets,
    workspaceDir: () => dir,
    reviewComplete: opts.reviewComplete ?? null,
  })

  const user = accounts.register({ username: 'writer1', password: 'Password123!', display_name: 'Dr. Lin' }, '127.0.0.1')

  const issuePat = async (modules: unknown) => {
    const r = await app.request('/api/me/mcp-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ name: 'Vertical Client', modules }),
    })
    expect(r.status).toBe(201)
    return ((await r.json()) as { token: string }).token
  }

  return { app, store, docs, dir, user, issuePat }
}

async function mcpRpc(
  app: ReturnType<typeof buildApi>,
  path: string,
  payload: unknown,
  opts: { token?: string; ip?: string; sessionId?: string } = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.ip ? { 'x-real-ip': opts.ip } : {}),
      ...(opts.sessionId ? { 'x-aegis-session-id': opts.sessionId } : {}),
    },
    body: JSON.stringify(payload),
  })
}

async function mcpToolCall(
  app: ReturnType<typeof buildApi>,
  path: string,
  name: string,
  args: Record<string, unknown>,
  opts: { token?: string; ip?: string; sessionId?: string } = {},
) {
  const res = await mcpRpc(app, path, {
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 10000) + 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }, opts)
  const raw = await res.json() as {
    result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    error?: unknown
    code?: string
  }
  const text = raw.result?.content?.[0]?.text
  let parsed: Record<string, any> | undefined
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, any> } catch { parsed = { text } }
  }
  return { status: res.status, headers: res.headers, isError: Boolean(raw.result?.isError), data: parsed ?? (raw as Record<string, any>) }
}

async function listTools(app: ReturnType<typeof buildApi>, path: string, token?: string) {
  const res = await mcpRpc(app, path, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token, ip: '198.51.100.77' })
  expect(res.status).toBe(200)
  const json = await res.json() as { result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } }
  return json.result.tools
}

describe('Writing Studio & Deep Review Vertical MCP Endpoints', () => {
  afterEach(() => {
    clearPublicCitationCache()
  })

  it('1. zero-auth /api/public/deep-review/mcp audits Markdown AST without LLM or DB writes, stays active when aegisEnabled=false, and supports GET/DELETE 405', async () => {
    const { app, store } = setupVerticalEnv({ aegisEnabled: false })
    const initialDocs = store.allDocIds().length

    const initRes = await mcpRpc(app, '/api/public/deep-review/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'review-client', version: '1.0' } },
    }, { ip: '198.51.100.10' })
    expect(initRes.status).toBe(200)
    const initJson = await initRes.json() as { result?: { serverInfo?: { name: string } } }
    expect(initJson.result?.serverInfo?.name).toBe('heurion-deep-review-public')

    const tools = await listTools(app, '/api/public/deep-review/mcp')
    expect(tools.map(t => t.name).sort()).toEqual(['public_deep_review_audit', 'public_pubmed_citation_check'])
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true)

    const sampleMarkdown = [
      '# Abstract',
      'We enrolled 100 patients across two arms.',
      '',
      '# Methods',
      'Baseline characteristics were compared using Chi-square tests.',
      '',
      '| Characteristic | Intervention (n=50) | Control (n=50) | P value |',
      '|---|---|---|---|',
      '| Events, n (%) | 12 (24.0%) | 15 (30.0%) | 0.21 |',
      '',
      '# Results',
      'In the intervention arm, 12/50 patients (40.0%) experienced objective response.',
      '',
      '# Discussion',
      'Our intervention demonstrated substantial clinical benefit (P = 0.21).',
    ].join('\n')

    const res = await mcpToolCall(app, '/api/public/deep-review/mcp', 'public_deep_review_audit', {
      markdown: sampleMarkdown,
      title: 'Trial Draft',
    }, { ip: '198.51.100.11' })

    expect(res.status).toBe(200)
    expect(res.isError).toBe(false)
    expect(res.data.engine).toBe('heurion-deterministic-ast-v1')
    expect(res.data.summary.tables_detected).toBe(1)
    expect(res.data.summary.findings_total).toBeGreaterThanOrEqual(2)
    expect(res.data.scratchpad.table_sample_sizes).toContain(50)

    const reasons = (res.data.findings as Array<{ reason: string; category: string }>).map(f => `${f.category}:${f.reason}`).join('\n')
    expect(reasons).toContain('internal_inconsistency')
    expect(reasons).toContain('spin_or_guideline')
    expect(store.allDocIds()).toHaveLength(initialDocs)

    for (const method of ['GET', 'DELETE'] as const) {
      const mRes = await app.request('/api/public/deep-review/mcp', { method })
      expect(mRes.status).toBe(405)
      expect(mRes.headers.get('allow')).toBe('POST')
    }
  })

  it('2. OAuth 2.1 metadata, 401/403 insufficient_scope challenges, and resource indicators support writing-studio & deep-review', async () => {
    const { app, issuePat, user } = setupVerticalEnv()

    for (const ep of ['/api/mcp/writing-studio', '/api/mcp/deep-review'] as const) {
      const unauth = await mcpRpc(app, ep, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(unauth.status).toBe(401)
      expect(unauth.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="https://heurion.org/.well-known/oauth-protected-resource${ep}", scope="writing:rw literature:rw"`,
      )

      const prm = await (await app.request(`/.well-known/oauth-protected-resource${ep}`)).json() as { resource: string; scopes_supported: string[] }
      expect(prm.resource).toBe(`https://heurion.org${ep}`)
      expect(prm.scopes_supported).toContain('writing:rw')
    }

    const knowledgeOnlyToken = await issuePat({ knowledge: 'rw' })
    const wsDenied = await mcpRpc(app, '/api/mcp/writing-studio', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: knowledgeOnlyToken })
    expect(wsDenied.status).toBe(403)
    expect(wsDenied.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
    expect(wsDenied.headers.get('www-authenticate')).toContain('scope="writing:rw literature:rw"')

    const writingOnlyToken = await issuePat({ writing: 'rw' })
    const litCall = await mcpToolCall(app, '/api/mcp/deep-review', 'pubmed_search', { query: 'sepsis' }, { token: writingOnlyToken })
    expect(litCall.status).toBe(403)
    expect(litCall.data.code).toBe('insufficient_scope')
    expect(litCall.headers.get('www-authenticate')).toContain('scope="literature:r"')

    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url')
    const authUrl = new URL('https://heurion.org/oauth/authorize')
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', 'https://client.example.com/oauth-metadata.json')
    authUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:43210/callback')
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('scope', 'writing:rw literature:rw')
    authUrl.searchParams.set('resource', 'https://heurion.org/api/mcp/deep-review')

    // Inject CIMD client via oauth/register or check standard PRM resource check on DCR client
    const reg = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Deep Review CLI', redirect_uris: ['http://127.0.0.1:43210/callback'], token_endpoint_auth_method: 'none' }),
    })
    expect(reg.status).toBe(201)
    const { client_id } = await reg.json() as { client_id: string }
    authUrl.searchParams.set('client_id', client_id)

    const authRes = await app.request(authUrl.toString())
    expect(authRes.status).toBe(302)
    const loc = new URL(authRes.headers.get('location')!)
    const oarid = loc.searchParams.get('mcp_authorize')!
    expect(oarid).toBeTruthy()

    const dec = await app.request(`/api/oauth/requests/${oarid}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ approve: true, modules: { writing: 'rw', literature: 'rw' } }),
    })
    expect(dec.status).toBe(200)
    const decJson = await dec.json() as { redirect: string }
    const code = new URL(decJson.redirect).searchParams.get('code')!
    const tokRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id,
        redirect_uri: 'http://127.0.0.1:43210/callback',
        code_verifier: verifier,
        resource: 'https://heurion.org/api/mcp/deep-review',
      }).toString(),
    })
    expect(tokRes.status).toBe(200)
    const tok = await tokRes.json() as { access_token: string }
    const drTools = await listTools(app, '/api/mcp/deep-review', tok.access_token)
    expect(drTools.map(t => t.name)).toContain('deep_review_start')
  })

  it('3. authenticated /api/mcp/writing-studio combines writing + literature + slides + .docx import/export roundtrip', async () => {
    const { app, issuePat } = setupVerticalEnv()
    const token = await issuePat({ writing: 'rw', literature: 'rw' })

    const tools = (await listTools(app, '/api/mcp/writing-studio', token)).map(t => t.name)
    for (const expected of [
      'doc_create',
      'doc_edit',
      'doc_import_docx',
      'doc_export_docx',
      'deck_edit',
      'slide_read',
      'pubmed_search',
      'insert_citation',
      'verify_claims',
      'workspace_put',
    ]) {
      expect(tools).toContain(expected)
    }
    for (const excluded of ['deep_review_start', 'deep_review_status', 'deep_review_audit', 'patient_read', 'tenant_admin']) {
      expect(tools).not.toContain(excluded)
    }

    const created = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_create', {
      title: 'Cohort Survival Paper',
      markdown: '# Methods\n\nPatients were followed longitudinally for 24 months.\n',
    }, { token, sessionId: 'ws-roundtrip' })
    expect(created.isError).toBe(false)
    const docId = created.data.doc_id as string

    const exported = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_export_docx', {
      doc_id: docId,
      clean: true,
      output_path: 'exports/cohort-paper.docx',
    }, { token, sessionId: 'ws-roundtrip' })
    expect(exported.isError).toBe(false)
    expect(exported.data.bytes).toBeGreaterThan(500)
    expect(exported.data.workspace_path).toBe('aegis-files/exports/cohort-paper.docx')
    expect(exported.data.download_path).toBe('/api/mcp/files/aegis-files/exports/cohort-paper.docx')
    expect(typeof exported.data.data_base64).toBe('string')

    // Roundtrip import back from the workspace path written by doc_export_docx
    const imported = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_import_docx', {
      path: exported.data.workspace_path,
      title: 'Re-imported Cohort Paper',
    }, { token, sessionId: 'ws-roundtrip' })
    expect(imported.isError).toBe(false)
    expect(imported.data.doc_id).toBeTruthy()
    expect(imported.data.doc_id).not.toBe(docId)

    const readBack = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_read', {
      doc_id: imported.data.doc_id,
    }, { token, sessionId: 'ws-roundtrip' })
    expect(readBack.isError).toBe(false)
    expect(readBack.data.text).toContain('Patients were followed longitudinally for 24 months')
  })

  it('4. authenticated /api/mcp/deep-review exposes 22 focused tools, runs audit + async 4-stage deep_review_start -> status, and respects read-only scope', async () => {
    const { app, issuePat } = setupVerticalEnv()
    const rwToken = await issuePat({ writing: 'rw', literature: 'rw' })

    const rwTools = (await listTools(app, '/api/mcp/deep-review', rwToken)).map(t => t.name).sort()
    expect(rwTools).toEqual([
      'claim_report',
      'comment_add',
      'comment_reply',
      'comment_resolve',
      'comments_list',
      'deep_review_audit',
      'deep_review_audit_markdown',
      'deep_review_start',
      'deep_review_status',
      'doc_import_docx',
      'doc_list',
      'doc_outline',
      'doc_read',
      'docs_search',
      'doi_lookup',
      'oa_fulltext',
      'openalex_search',
      'pubmed_search',
      'verify_claims',
      'workspace_get',
      'workspace_list',
      'workspace_put',
    ])

    const roToken = await issuePat({ writing: 'r', literature: 'r' })
    const roTools = (await listTools(app, '/api/mcp/deep-review', roToken)).map(t => t.name)
    expect(roTools).toContain('deep_review_audit_markdown')
    expect(roTools).toContain('deep_review_audit')
    expect(roTools).toContain('deep_review_status')
    expect(roTools).toContain('doc_read')
    expect(roTools).not.toContain('deep_review_start')
    expect(roTools).not.toContain('doc_import_docx')
    expect(roTools).not.toContain('comment_add')

    const created = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_create', {
      title: 'Deep Review Target',
      markdown: [
        '# Results',
        'Out of 50 patients, 10/50 (32.0%) achieved complete response.',
        '',
        '# Discussion',
        'This therapy confirmed superiority over standard care (P = 0.34).',
      ].join('\n'),
    }, { token: rwToken })
    const docId = created.data.doc_id as string

    const auditRes = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_audit', { doc_id: docId }, { token: rwToken })
    expect(auditRes.isError).toBe(false)
    expect(auditRes.data.findings_total).toBeGreaterThanOrEqual(2)

    const startRes = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_start', {
      doc_id: docId,
      mode: 'heurion_deep',
      anchor_comments: true,
    }, { token: rwToken })
    expect(startRes.isError).toBe(false)
    expect(startRes.data.job_id).toBeTruthy()

    let finalStatus: Record<string, any> | null = null
    for (let i = 0; i < 40; i++) {
      const st = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_status', {
        doc_id: docId,
        job_id: startRes.data.job_id,
      }, { token: rwToken })
      expect(st.isError).toBe(false)
      if (st.data.status !== 'running') {
        finalStatus = st.data
        break
      }
      await new Promise(r => setTimeout(r, 25))
    }
    expect(finalStatus?.status).toBe('done')
    expect(finalStatus?.result?.ok).toBe(true)
    expect(finalStatus?.result?.doc_id).toBe(docId)
  })

  it('5. all Official MCP Registry server.json manifests satisfy 2025-12-11 schema & <= 100 char limits', () => {
    expect(existsSync(REGISTRY_DIR)).toBe(true)
    const files = readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.server.json'))
    expect(files).toEqual(expect.arrayContaining([
      'writing.server.json',
      'deep-review.server.json',
      'clinical-research-tools.server.json',
      'heurion.server.json',
    ]))
    for (const f of files) {
      const raw = readFileSync(join(REGISTRY_DIR, f), 'utf8')
      const doc = JSON.parse(raw) as {
        $schema?: string
        name?: string
        title?: string
        description?: string
        version?: string
        remotes?: Array<{ type?: string; url?: string }>
      }
      expect(doc.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json')
      expect(doc.name).toMatch(/^org\.heurion\/[a-z0-9-]+$/)
      expect(typeof doc.title).toBe('string')
      expect(doc.title!.length).toBeGreaterThan(0)
      expect(doc.title!.length).toBeLessThanOrEqual(100)
      expect(typeof doc.description).toBe('string')
      expect(doc.description!.length).toBeGreaterThan(0)
      expect(doc.description!.length).toBeLessThanOrEqual(100)
      expect(doc.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(doc.remotes?.[0]?.type).toBe('streamable-http')
      expect(doc.remotes?.[0]?.url).toMatch(/^https:\/\/heurion\.org\/api\//)
    }
  })

  it('6. H1: enforces bounded streaming request body (413), hard ipBuckets cap, and linear extractor runtime', async () => {
    const { app } = setupVerticalEnv()

    const hugeJson = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'public_deep_review_audit', arguments: { markdown: 'x'.repeat(1_150_000) } },
    })
    const overClRes = await app.request('/api/public/deep-review/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.200' },
      body: hugeJson,
    })
    expect(overClRes.status).toBe(413)
    expect(((await overClRes.json()) as { code?: string }).code).toBe('payload_too_large')

    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000).fill(0x20))
        controller.enqueue(new Uint8Array(600_000).fill(0x20))
        controller.close()
      },
    })
    const overStreamRes = await app.request('/api/public/deep-review/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.201' },
      body: streamBody,
      duplex: 'half',
    } as RequestInit)
    expect(overStreamRes.status).toBe(413)
    expect(((await overStreamRes.json()) as { code?: string }).code).toBe('payload_too_large')

    // ipBuckets hard cap (4096) handles 4200 unique IPs without crashing or unbounded Map growth
    for (let i = 0; i < 4200; i++) {
      expect(checkPublicRateLimit(`10.99.${Math.floor(i / 250)}.${i % 250}`, 'vertical_cap_test', 5)).toBe(true)
    }
    expect(checkPublicRateLimit('10.99.255.254', 'vertical_cap_test', 5)).toBe(true)

    // Pathological repeated clause + larger table stays fast
    const tableRows = Array.from({ length: 60 }, (_, idx) => `| Feature ${idx} | ${10 + (idx % 10)} (${20 + (idx % 20)}%) | ${12 + (idx % 10)} (${24 + (idx % 20)}%) |`).join('\n')
    const heavyMd = [
      '# Methods',
      'Forty mice were randomly divided into four groups.',
      ...Array.from({ length: 20 }, (_, i) => `A ${'long_cohort_label_'.repeat(3)}${i} group with 10 subjects received treatment.`),
      '',
      '| Variable | Arm A (n=50) | Arm B (n=50) |',
      '|---|---|---|',
      tableRows,
    ].join('\n\n')
    const t0 = Date.now()
    const audited = runDeterministicDeepReviewOnMarkdown(heavyMd)
    expect(audited.ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  it('7. H2: blocks cross-module privilege escalation, study viewer deep_review_start, and enforces concurrency/hourly quotas', async () => {
    let releaseHold!: () => void
    const holdPromise = new Promise<void>(resolve => { releaseHold = resolve })
    const { app, store, docs, user, accounts } = (() => {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-h2-'))
      const store = new Store(':memory:')
      const docs = new Documents(store)
      const ops = new OpService(docs)
      const registry = new TurnRegistry()
      const accounts = new Accounts(store, {
        secret: 'h2-test-secret',
        devMode: false,
        devToken: 'dev',
        devUser: 'dev',
        botGuard: { issue: () => ({} as never), verify: () => {} } as never,
      })
      const tenants = new TenantService(store, { devMode: false })
      const keys = new TenantKeys(store, kekFrom({ secret: 'h2-test-secret' }))
      const patients = new PatientService(join(dir, 'tenants'), tenants, keys, store)
      const pool = {
        liveSession: () => null,
        run: () => new Promise(() => {}),
        cancel: async () => {},
        workspaceDir: () => dir,
      } as unknown as HarnessPool
      const pubmed = {
        search: async () => [],
        fetch: async () => [],
        abstract: async () => null,
        lookup: async () => null,
      } as unknown as PubMedClient
      const app = buildApi({
        docs,
        ops,
        turns: new TurnService(docs, pool, registry),
        turnRegistry: registry,
        postcheck: new PostCheck(docs),
        crossref: {} as CrossrefClient,
        pubmed,
        renderer: new SlideRenderer(join(dir, 'render')),
        accounts,
        devMode: false,
        aegisEnabled: true,
        publicOrigin: 'https://heurion.org',
        devUser: 'dev',
        patients,
        workspaceDir: () => dir,
        reviewComplete: async () => {
          await holdPromise
          return '[]'
        },
      })
      const user = accounts.register({ username: 'pi_user', password: 'Password123!', display_name: 'PI' }, '127.0.0.1')
      return { app, store, docs, user, accounts }
    })()

    const issueFor = async (sessionTok: string, modules: unknown) => {
      const r = await app.request('/api/me/mcp-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionTok}` },
        body: JSON.stringify({ name: 'Scoped Client', modules }),
      })
      expect(r.status).toBe(201)
      return ((await r.json()) as { token: string }).token
    }

    // 7a. writing:r + literature:rw cannot see or call deep_review_start / claim_report (needs writing:rw)
    const writingReadLitRw = await issueFor(user.token, { writing: 'r', literature: 'rw' })
    const toolsWr = (await listTools(app, '/api/mcp/deep-review', writingReadLitRw)).map(t => t.name)
    expect(toolsWr).toContain('verify_claims')
    expect(toolsWr).toContain('deep_review_audit')
    expect(toolsWr).not.toContain('deep_review_start')
    expect(toolsWr).not.toContain('claim_report')

    const deniedStart = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_start', { doc_id: 'd_any' }, { token: writingReadLitRw })
    expect(deniedStart.status).toBe(403)
    expect(deniedStart.data.code).toBe('insufficient_scope')
    expect(deniedStart.headers.get('www-authenticate')).toContain('writing:rw')

    const deniedClaimReport = await mcpToolCall(app, '/api/mcp/deep-review', 'claim_report', {
      doc_id: 'd_any',
      results: [{ claim_id: 'c1', verdict: 'supported', reason: 'ok' }],
    }, { token: writingReadLitRw })
    expect(deniedClaimReport.status).toBe(403)
    expect(deniedClaimReport.data.code).toBe('insufficient_scope')

    // 7b. literature:rw only (no writing) cannot see or call deep_review_audit / verify_claims (needs writing:r)
    const litOnly = await issueFor(user.token, { literature: 'rw' })
    const toolsLitOnly = (await listTools(app, '/api/mcp/deep-review', litOnly)).map(t => t.name)
    expect(toolsLitOnly).not.toContain('deep_review_audit')
    expect(toolsLitOnly).not.toContain('verify_claims')
    const deniedAudit = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_audit', { doc_id: 'd_any' }, { token: litOnly })
    expect(deniedAudit.status).toBe(403)
    expect(deniedAudit.data.code).toBe('insufficient_scope')
    expect(deniedAudit.headers.get('www-authenticate')).toContain('writing:r')

    // 7c. Study viewer (read-only collaborator) cannot launch LLM deep_review_start even with anchor_comments=false
    const viewer = accounts.register({ username: 'viewer_user', password: 'Password123!', display_name: 'Viewer' }, '127.0.0.1')
    const study = store.addStudy({ owner: user.user.id, title: 'Collab Study', design: 'retrospective_cohort', status: 'ongoing', summary: '' })
    const studyDoc = docs.create({
      owner: user.user.id,
      title: 'Shared Study Manuscript',
      markdown: '# Abstract\n100 patients enrolled.\n\n# Results\n10/50 (40%) responded.',
    })
    store.setDocContext(studyDoc.id, { kind: 'study', study_id: study.id, title: study.title, role: 'manuscript' })
    store.addStudyItem({ study_id: study.id, kind: 'doc', ref_id: studyDoc.id, role: 'manuscript' })
    store.setStudyMember({ study_id: study.id, user_id: viewer.user.id, role: 'viewer', added_by: user.user.id })

    const viewerTok = await issueFor(viewer.token, { writing: 'rw', literature: 'rw' })
    const viewerStart = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_start', {
      doc_id: studyDoc.id,
      anchor_comments: false,
    }, { token: viewerTok })
    expect(viewerStart.isError).toBe(true)
    expect(viewerStart.data.code).toBe('forbidden')

    // 7d. Shared concurrency cap (2 running) + hourly cap (6/hr) across MCP & HTTP
    const piRwTok = await issueFor(user.token, { writing: 'rw', literature: 'rw' })
    const j1 = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_start', { doc_id: studyDoc.id }, { token: piRwTok })
    const j2 = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_start', { doc_id: studyDoc.id }, { token: piRwTok })
    expect(j1.isError).toBe(false)
    expect(j2.isError).toBe(false)

    const j3Concurrent = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_start', { doc_id: studyDoc.id }, { token: piRwTok })
    expect(j3Concurrent.isError).toBe(true)
    expect(j3Concurrent.data.code).toBe('concurrency_limited')

    releaseHold()
    for (const jid of [j1.data.job_id, j2.data.job_id]) {
      for (let i = 0; i < 40; i++) {
        const st = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_status', { doc_id: studyDoc.id, job_id: jid }, { token: piRwTok })
        if (st.data.status !== 'running') break
        await new Promise(r => setTimeout(r, 10))
      }
    }

    for (let k = 0; k < 4; k++) {
      const jk = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_start', { doc_id: studyDoc.id }, { token: piRwTok })
      expect(jk.isError).toBe(false)
      for (let i = 0; i < 40; i++) {
        const st = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_status', { doc_id: studyDoc.id, job_id: jk.data.job_id }, { token: piRwTok })
        if (st.data.status !== 'running') break
        await new Promise(r => setTimeout(r, 10))
      }
    }

    const j7Rate = await mcpToolCall(app, '/api/mcp/deep-review', 'deep_review_start', { doc_id: studyDoc.id }, { token: piRwTok })
    expect(j7Rate.isError).toBe(true)
    expect(j7Rate.data.code).toBe('rate_limited')

    const httpRateRes = await app.request(`/api/docs/${studyDoc.id}/deep-review?async=1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${user.token}` },
    })
    expect(httpRateRes.status).toBe(429)
    expect(((await httpRateRes.json()) as { code?: string }).code).toBe('rate_limited')
  })

  it('8. H3 & M1: safeUnzipDocx blocks zip bomb & traversal; doc_import_docx hardens workspace paths; doc_export_docx writes audit log', async () => {
    const big = new Uint8Array(600 * 1024).fill(0x41)
    const parts: Record<string, Uint8Array> = {}
    for (let i = 0; i < 260; i++) parts[`word/media/p${i}.bin`] = big
    const bomb = zipSync(parts, { level: 9 })
    const spoofed = new Uint8Array(bomb)
    for (let i = 0; i < spoofed.length - 30; i++) {
      if (spoofed[i] === 0x50 && spoofed[i + 1] === 0x4b && spoofed[i + 2] === 0x03 && spoofed[i + 3] === 0x04) {
        spoofed.fill(0, i + 22, i + 26)
      }
      if (spoofed[i] === 0x50 && spoofed[i + 1] === 0x4b && spoofed[i + 2] === 0x01 && spoofed[i + 3] === 0x02) {
        spoofed.fill(0, i + 24, i + 28)
      }
    }
    expect(() => safeUnzipDocx(spoofed)).toThrow(DocxImportError)

    const travRaw = zipSync({ 'xx/evil.xml': new Uint8Array([1, 2, 3]) })
    const needle = new TextEncoder().encode('xx/evil.xml')
    const patched = new TextEncoder().encode('../evil.xml')
    const trav = new Uint8Array(travRaw)
    for (let i = 0; i <= trav.length - needle.length; i++) {
      if (needle.every((b, j) => trav[i + j] === b)) trav.set(patched, i)
    }
    expect(() => safeUnzipDocx(trav)).toThrow(DocxImportError)

    const { app, store, dir, issuePat } = setupVerticalEnv()
    const token = await issuePat({ writing: 'rw', literature: 'rw' })

    // Missing workspace directory does not crash (structured file_not_found)
    rmSync(dir, { recursive: true, force: true })
    const missingWs = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_import_docx', { path: 'missing.docx' }, { token })
    expect(missingWs.isError).toBe(true)
    expect(missingWs.data.code).toBe('file_not_found')

    // Symlink escape outside workspace rejected with invalid_path
    mkdirSync(dir, { recursive: true })
    const outsideDir = mkdtempSync(join(tmpdir(), 'outside-docx-'))
    const outsideFile = join(outsideDir, 'secret.docx')
    writeFileSync(outsideFile, 'dummy')
    symlinkSync(outsideFile, join(dir, 'escape.docx'))
    const escapeRes = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_import_docx', { path: 'escape.docx' }, { token })
    expect(escapeRes.isError).toBe(true)
    expect(escapeRes.data.code).toBe('invalid_path')

    // Export audit log (M1) + base64 import + >10MB base64 rejection
    const created = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_create', {
      title: 'Audit/Escape\\Test',
      markdown: '# Intro\n\nManuscript body for export.\n',
    }, { token })
    const docId = created.data.doc_id as string
    const exported = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_export_docx', { doc_id: docId, fonts: 'mac' }, { token })
    expect(exported.isError).toBe(false)
    expect(exported.data.filename).toBe('Audit_Escape_Test.docx')
    expect(store.listAudit({ action: 'doc.export' }).some(a => a.target === docId && a.detail === 'mcp doc_export_docx')).toBe(true)

    const importedB64 = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_import_docx', {
      data_base64: exported.data.data_base64,
      filename: '../../weird.docx',
    }, { token })
    expect(importedB64.isError).toBe(false)
    expect(importedB64.data.doc_id).toBeTruthy()

    const over10MbB64 = await mcpToolCall(app, '/api/mcp/writing-studio', 'doc_import_docx', {
      data_base64: 'A'.repeat(14_000_000),
    }, { token })
    expect(over10MbB64.isError).toBe(true)
    expect(over10MbB64.data.code).toBe('too_large')
  })

  it('9. M2, M3, L1 & L2: AST external image safety, H1 title, JSON-RPC batch guard, PRM slug validation, tailored instructions & CORS', async () => {
    const md = [
      '# Randomized Cardiac Trial',
      '',
      '![Kaplan Curve](https://example.com/km.png)',
      '',
      '## Methods',
      'We enrolled 100 patients and analyzed baseline data | Col |.',
    ].join('\n')
    const res = runDeterministicDeepReviewOnMarkdown(md)
    expect(res.ok).toBe(true)
    expect(res.summary.title).toBe('Randomized Cardiac Trial')
    const methodsSec = res.sections.find(s => s.title === 'Methods')
    expect(methodsSec?.tier).toBe('high')

    const { app, issuePat } = setupVerticalEnv()
    const roTok = await issuePat({ writing: 'r', literature: 'r' })
    const batchRes = await mcpRpc(app, '/api/mcp/deep-review', [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'deep_review_start', arguments: { doc_id: 'd1' } } },
    ], { token: roTok })
    expect(batchRes.status).toBe(403)
    expect(((await batchRes.json()) as { code?: string }).code).toBe('insufficient_scope')

    const trailPrm = await (await app.request('/.well-known/oauth-protected-resource/api/mcp/deep-review/')).json() as { resource: string }
    expect(trailPrm.resource).toBe('https://heurion.org/api/mcp/deep-review')
    const badSlugPrm = await (await app.request('/.well-known/oauth-protected-resource/api/mcp/does-not-exist')).json() as { resource: string }
    expect(badSlugPrm.resource).toBe('https://heurion.org/api/mcp')

    const reg = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Resource Check', redirect_uris: ['http://127.0.0.1:43211/cb'], token_endpoint_auth_method: 'none' }),
    })
    const { client_id } = await reg.json() as { client_id: string }
    const badTargetAuth = await app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri: 'http://127.0.0.1:43211/cb',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        resource: 'https://heurion.org/api/mcp/does-not-exist',
      }).toString()}`,
    )
    expect(badTargetAuth.status).toBe(302)
    expect(new URL(badTargetAuth.headers.get('location')!).searchParams.get('error')).toBe('invalid_target')

    const drInst = verticalInstructions('deep-review', ['writing', 'literature'])
    expect(drInst).not.toContain('doc_edit')
    expect(drInst).not.toContain('deck_edit')
    expect(drInst).not.toContain('insert_citation')

    const corsRes = await app.request('/api/mcp/deep-review', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'POST', 'access-control-request-headers': 'X-Aegis-Org-Id, Authorization' },
    })
    expect((corsRes.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('x-aegis-org-id')
  })
})
