import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { DatasetService } from '../src/datasets/service.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import { clearPublicCitationCache } from '../src/http/routes/public-tools-api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
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
})
