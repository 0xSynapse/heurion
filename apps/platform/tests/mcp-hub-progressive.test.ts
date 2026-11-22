import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { DatasetService } from '../src/datasets/service.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { Embedder } from '../src/kb/embedder.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import { TurnService } from '../src/turns/service.ts'

async function setupHubEnv(opts?: { embedder?: Embedder | null; orgModules?: string[]; aegisEnabled?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'hubprog-'))
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const registry = new TurnRegistry()
  const accounts = new Accounts(store, {
    secret: 'hub-prog-secret',
    devMode: false,
    devToken: 'dev',
    devUser: 'dev',
    botGuard: { issue: () => ({} as never), verify: () => {} } as never,
  })
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'hub-prog-secret' }))
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

  const app = buildApi({
    docs,
    ops,
    turns: new TurnService(docs, pool, registry),
    turnRegistry: registry,
    postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient,
    pubmed: {} as PubMedClient,
    renderer: new SlideRenderer(join(dir, 'render')),
    accounts,
    devMode: false,
    aegisEnabled: opts?.aegisEnabled ?? true,
    publicOrigin: 'https://heurion.org',
    embedder: opts?.embedder ?? null,
    devUser: 'dev',
    patients,
    datasets,
    workspaceDir: () => dir,
  })

  const op = accounts.register({ username: 'opadmin', password: 'Password123!', display_name: 'Op' }, '127.0.0.1')
  const createdTenant = await (await app.request('/api/platform/tenants', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${op.token}` },
    body: JSON.stringify({ name: 'Hospital Hub' }),
  })).json() as { tenant: { id: string }; invite: { code: string } }

  const hospAdmin = accounts.register({ username: 'hospadmin', password: 'Password123!', display_name: 'Admin', invite: createdTenant.invite.code }, '127.0.0.1')
  const memberInvite = await (await app.request('/api/tenant/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hospAdmin.token}` },
    body: JSON.stringify({}),
  })).json() as { code: string }
  const member = accounts.register({ username: 'researcher', password: 'Password123!', display_name: 'Researcher', invite: memberInvite.code }, '127.0.0.1')

  if (opts?.orgModules !== undefined) {
    const t = store.getTenant(createdTenant.tenant.id)!
    store.updateTenant(t.id, { settings: JSON.stringify({ ...JSON.parse(t.settings || '{}'), aegis_modules: opts.orgModules }) })
  }

  const issuePat = async (userToken: string, modules: unknown) => {
    const r = await app.request('/api/me/mcp-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ name: 'Hub Test Client', modules }),
    })
    expect(r.status).toBe(201)
    return ((await r.json()) as { token: string }).token
  }

  return { app, store, docs, ops, registry, dir, op, hospAdmin, member, issuePat }
}

async function rpcPost(app: ReturnType<typeof buildApi>, path: string, token: string | null, payload: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  })
}

describe('Phase 1C · Progressive Discovery MCP Hub (/api/mcp/hub)', () => {
  it('enforces 401 RFC 9728 WWW-Authenticate on /api/mcp/hub, 405 on GET/DELETE, and 404 when aegisEnabled=false', async () => {
    const { app } = await setupHubEnv()

    const unauth = await rpcPost(app, '/api/mcp/hub', null, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(unauth.status).toBe(401)
    expect(unauth.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://heurion.org/.well-known/oauth-protected-resource/api/mcp/hub"',
    )

    const prm = await app.request('/.well-known/oauth-protected-resource/api/mcp/hub')
    expect(prm.status).toBe(200)
    const prmJson = await prm.json() as { resource: string; authorization_servers: string[]; scopes_supported: string[] }
    expect(prmJson.resource).toBe('https://heurion.org/api/mcp/hub')
    expect(prmJson.authorization_servers).toEqual(['https://heurion.org'])
    expect(prmJson.scopes_supported).toContain('writing:rw')

    const mods = await (await app.request('/api/mcp/modules')).json() as { hub: string; public_mcp: string }
    expect(mods.hub).toBe('/api/mcp/hub')
    expect(mods.public_mcp).toBe('/api/public/mcp')

    for (const m of ['GET', 'DELETE'] as const) {
      const res = await app.request('/api/mcp/hub', { method: m })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    }

    const disabled = await setupHubEnv({ aegisEnabled: false })
    expect((await rpcPost(disabled.app, '/api/mcp/hub', null, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404)
  })

  it('exposes compact <=15-tool initial tools/list on /api/mcp/hub while keeping /api/mcp and /api/mcp/writing backward compatible', async () => {
    const { app, docs, ops, registry, dir, hospAdmin, issuePat } = await setupHubEnv({
      orgModules: ['analysis', 'patients', 'imaging', 'research'],
    })
    const pat = await issuePat(hospAdmin.token, {
      writing: 'rw',
      literature: 'rw',
      analysis: 'rw',
      patients: 'rw',
      imaging: 'rw',
      research: 'rw',
      knowledge: 'rw',
      memory: 'rw',
      admin: 'rw',
    })

    const hubRes = await rpcPost(app, '/api/mcp/hub', pat, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(hubRes.status).toBe(200)
    const hubText = await hubRes.text()
    const hubTools = (JSON.parse(hubText) as { result: { tools: Array<{ name: string }> } }).result.tools.map(t => t.name)
    expect(hubTools).toContain('hub_search_tools')
    expect(hubTools).toContain('hub_describe_tool')
    expect(hubTools).toContain('hub_call_tool')
    expect(hubTools.length).toBeLessThanOrEqual(15)
    expect(hubTools).toContain('doc_edit')

    // Classic full /api/mcp and single-module /api/mcp/writing remain intact
    const legacyAll = await rpcPost(app, '/api/mcp', pat, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(legacyAll.status).toBe(200)
    const legacyText = await legacyAll.text()
    const legacyTools = (JSON.parse(legacyText) as { result: { tools: Array<{ name: string }> } }).result.tools.map(t => t.name)
    expect(legacyTools.length).toBeGreaterThan(80)
    expect(Buffer.byteLength(hubText, 'utf8')).toBeLessThan(Buffer.byteLength(legacyText, 'utf8') * 0.25)

    const writingMod = await rpcPost(app, '/api/mcp/writing', pat, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(writingMod.status).toBe(200)
    const writingNames = ((await writingMod.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(t => t.name)
    expect(writingNames).toContain('doc_edit')
    expect(writingNames).not.toContain('pubmed_search')

    // Compare full monolith server tool list size untouched
    const mono = buildMcpServer({
      docs, ops, turns: registry, renderer: new SlideRenderer(dir), claims: {} as any,
      pubmed: {} as PubMedClient, crossref: {} as CrossrefClient, secret: 's', workspaceDir: () => dir, isLiveSession: () => true,
    }, { u: hospAdmin.user.id, d: '*', p: ['read', 'write'], aud: 'mcp', exp: 9999999999 })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mono.connect(a)
    const c = new Client({ name: 'cmp', version: '1' })
    await c.connect(b)
    expect((await c.listTools()).tools.length).toBeGreaterThan(130)
    await c.close()
    await mono.close()
  })

  it('pre-filters hub_search_tools by org policy & RBAC, fuses FTS5/lexical/vector RRF, describes schemas, and distinguishes insufficient_scope vs org block', async () => {
    const mockEmbedder: Embedder = {
      async available() { return true },
      async embed(texts: string[]) {
        return texts.map(t => {
          const low = t.toLowerCase()
          if (low.includes('dataset_survival') || low.includes('time-to-event') || low.includes('cox')) {
            return new Float32Array([1, 0, 0])
          }
          if (low.includes('kb_search')) return new Float32Array([0, 1, 0])
          return new Float32Array([0, 0, 0])
        })
      },
    }

    // orgModules: ['analysis'] enables analysis but keeps patients/imaging/research blocked by org
    const { app, member, issuePat } = await setupHubEnv({
      embedder: mockEmbedder,
      orgModules: ['analysis'],
    })

    // Member token grants writing:r (read-only!), analysis:rw; lacks knowledge & literature
    const pat = await issuePat(member.token, {
      writing: 'r',
      analysis: 'rw',
      patients: 'rw',
    })

    // 1. Eager Core excludes doc_edit because token only has writing:r
    const listRes = await rpcPost(app, '/api/mcp/hub', pat, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const eagerNames = ((await listRes.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(t => t.name)
    expect(eagerNames).toContain('doc_read')
    expect(eagerNames).not.toContain('doc_edit')

    // 2. Hybrid search finds dataset_survival via vector + FTS5/lexical
    const sRes = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'hub_search_tools', arguments: { query: 'time-to-event cox', limit: 5 } },
    })
    const sData = JSON.parse(((await sRes.json()) as any).result.content[0].text) as {
      tools: Array<{ name: string; module: string; authorized: boolean }>
    }
    expect(sData.tools.map(t => t.name)).toContain('dataset_survival')
    expect(sData.tools.every(t => t.authorized)).toBe(true)

    // 3. Even with include_unscoped=true, org-blocked modules (patients) & RBAC-denied admin tools are hidden
    const clinSearch = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'hub_search_tools', arguments: { query: 'patient_read', include_unscoped: true } },
    })
    const clinData = JSON.parse(((await clinSearch.json()) as any).result.content[0].text) as { tools: Array<{ name: string; module: string }> }
    expect(clinData.tools.some(t => t.module === 'patients')).toBe(false)

    const admSearch = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'hub_search_tools', arguments: { query: 'platform_admin', include_unscoped: true } },
    })
    const admData = JSON.parse(((await admSearch.json()) as any).result.content[0].text) as { tools: Array<{ name: string }> }
    expect(admData.tools.map(t => t.name)).not.toContain('platform_admin')
    expect(admData.tools.map(t => t.name)).not.toContain('tenant_admin')

    // 4. include_unscoped: false vs true for org-open module ('knowledge': kb_search)
    const kbHidden = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'hub_search_tools', arguments: { query: 'kb_search', include_unscoped: false } },
    })
    expect(JSON.parse(((await kbHidden.json()) as any).result.content[0].text).tools.map((t: any) => t.name)).not.toContain('kb_search')

    const kbShown = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'hub_search_tools', arguments: { query: 'kb_search', include_unscoped: true } },
    })
    const kbShownTools = JSON.parse(((await kbShown.json()) as any).result.content[0].text).tools as Array<{ name: string; authorized: boolean }>
    expect(kbShownTools.find(t => t.name === 'kb_search')?.authorized).toBe(false)

    // 5. hub_describe_tool rejects org-blocked / RBAC-denied, returns JSON Schema for allowed tool
    const blockedDesc = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'hub_describe_tool', arguments: { tool_name: 'patient_read' } },
    })
    expect(((await blockedDesc.json()) as any).result.isError).toBe(true)

    const okDesc = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'hub_describe_tool', arguments: { tool_name: 'dataset_list' } },
    })
    const descPayload = JSON.parse(((await okDesc.json()) as any).result.content[0].text) as {
      tool_name: string; module: string; required_scope: string; input_schema: Record<string, unknown>
    }
    expect(descPayload.tool_name).toBe('dataset_list')
    expect(descPayload.module).toBe('analysis')
    expect(descPayload.required_scope).toBe('analysis:r')
    expect(descPayload.input_schema).toHaveProperty('type', 'object')

    // 6. hub_call_tool executes authorized tool and validates Zod schema
    const callOk = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'hub_call_tool', arguments: { tool_name: 'dataset_list', arguments: {} } },
    })
    expect(callOk.status).toBe(200)
    expect(((await callOk.json()) as any).result.isError).not.toBe(true)

    const callBadArgs = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'hub_call_tool', arguments: { tool_name: 'doc_read', arguments: {} } },
    })
    expect(callBadArgs.status).toBe(200)
    expect(((await callBadArgs.json()) as any).result.content[0].text).toContain('invalid_arguments')

    // 7. Missing token scope (org-allowed) -> 403 + WWW-Authenticate insufficient_scope
    const stepUpKb = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'hub_call_tool', arguments: { tool_name: 'kb_search', arguments: { query: 'test' } } },
    })
    expect(stepUpKb.status).toBe(403)
    expect(stepUpKb.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
    expect(stepUpKb.headers.get('www-authenticate')).toContain('scope="knowledge:r"')

    const stepUpWrite = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'doc_edit', arguments: { doc_id: 'd1', base_rev: 0, ops: [] } },
    })
    expect(stepUpWrite.status).toBe(403)
    expect(stepUpWrite.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
    expect(stepUpWrite.headers.get('www-authenticate')).toContain('scope="writing:rw"')

    // 8. Org-blocked module -> 403 module_not_allowed_by_org WITHOUT insufficient_scope
    const orgBlock = await rpcPost(app, '/api/mcp/hub', pat, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'hub_call_tool', arguments: { tool_name: 'patient_read', arguments: { patient_id: 'p1' } } },
    })
    expect(orgBlock.status).toBe(403)
    expect(orgBlock.headers.get('www-authenticate')).toBeNull()
    expect(((await orgBlock.json()) as { code: string }).code).toBe('module_not_allowed_by_org')
  })
})
