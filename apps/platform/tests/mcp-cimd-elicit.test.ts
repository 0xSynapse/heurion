import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { generateAegisNodeKeyPair, signAegisLeaseToken } from '../src/aegis/auth.ts'
import type { OAuthServiceOptions } from '../src/aegis/oauth.ts'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { ClaimService } from '../src/claims/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import { makeInvoker } from '../src/http/invoke.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { ToolCatalog } from '../src/mcp-hub/catalog.ts'
import { buildHubMcpServer } from '../src/mcp-hub/gateway.ts'
import { buildMcpServer, prepareExternalMcpSession, type McpDeps } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

const O = 'https://heurion.org'

function setupCimdAndElicitEnv(oauthOpts?: OAuthServiceOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'cimd-'))
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const registry = new TurnRegistry()
  const accounts = new Accounts(store, {
    secret: 'cimd-secret',
    devMode: false,
    devToken: 'dev',
    devUser: 'dev',
    botGuard: { issue: () => ({} as never), verify: () => {} } as never,
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
    aegisEnabled: true,
    publicOrigin: O,
    oauthOpts,
    devUser: 'dev',
    workspaceDir: () => dir,
  })

  const reg = accounts.register({ username: 'dr_elicit', password: 'Password123!', display_name: 'Dr Elicit' }, '127.0.0.1')
  const dbUser = store.getUser(reg.user.id)!
  const tid = dbUser.tenant_id ?? dbUser.personal_tenant_id!
  const t = store.getTenant(tid)!
  store.updateTenant(t.id, { settings: JSON.stringify({ ...JSON.parse(t.settings || '{}'), aegis_modules: ['analysis', 'patients', 'imaging', 'research'] }) })

  const mcpDeps: McpDeps = {
    docs,
    ops,
    claims: new ClaimService(docs, {} as PubMedClient),
    renderer: new SlideRenderer(join(dir, 'r2')),
    turns: registry,
    pubmed: {} as PubMedClient,
    crossref: {} as CrossrefClient,
    secret: 'cimd-secret',
    devMode: false,
    devUser: 'dev',
    workspaceDir: () => dir,
    isLiveSession: () => true,
    invoke: makeInvoker(app),
  }

  return { app, store, docs, reg, mcpDeps, catalog: new ToolCatalog(store) }
}

describe('Phase 1C · OAuth 2.1 CIMD + SSRF Guards & SEP-1036 URL Mode Elicitation', () => {
  it('advertises CIMD in AS metadata, fetches+caches HTTPS client metadata once, and completes PKCE -> /api/mcp/hub call', async () => {
    let fetchCount = 0
    const clientUrl = 'https://client.example.org/oauth.json'
    const redirectUri = 'https://client.example.org/callback'
    const env = setupCimdAndElicitEnv({
      dnsLookup: async host => (host === 'client.example.org' ? [{ address: '93.184.216.34' }] : []),
      cimdFetcher: async url => {
        fetchCount++
        if (url !== clientUrl) return { ok: false, status: 404 }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            client_id: clientUrl,
            client_name: 'External Example Client',
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: 'none',
          }),
        }
      },
    })

    const asMeta = await (await env.app.request(`${O}/.well-known/oauth-authorization-server`)).json() as any
    expect(asMeta.client_id_metadata_document_supported).toBe(true)

    const verifier = 'c'.repeat(48) + '-pkce'
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
    const authUrl = `${O}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientUrl,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-cimd',
      scope: 'writing:rw',
      resource: `${O}/api/mcp/hub`,
    })}`

    const a1 = await env.app.request(authUrl)
    expect(a1.status).toBe(302)
    expect(fetchCount).toBe(1)

    // Second authorize hits oauth_clients cache without refetching
    const a2 = await env.app.request(authUrl)
    expect(a2.status).toBe(302)
    expect(fetchCount).toBe(1)

    const oarid = new URL(a1.headers.get('location')!).searchParams.get('mcp_authorize')!
    const decRes = await env.app.request(`${O}/api/oauth/requests/${oarid}/decision`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ approve: true, modules: { writing: 'rw' } }),
    })
    const code = new URL(((await decRes.json()) as { redirect: string }).redirect).searchParams.get('code')!

    const tokRes = await env.app.request(`${O}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientUrl,
        redirect_uri: redirectUri,
        resource: `${O}/api/mcp/hub`,
      }).toString(),
    })
    expect(tokRes.status).toBe(200)
    const { access_token } = (await tokRes.json()) as { access_token: string }

    const hubRes = await env.app.request(`${O}/api/mcp/hub`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'doc_list', arguments: {} } }),
    })
    expect(hubRes.status).toBe(200)
    expect(((await hubRes.json()) as any).result.isError).not.toBe(true)
  })

  it('blocks SSRF (localhost, .local, .internal, loopback/link-local/private IPs, empty DNS) and malformed CIMD metadata', async () => {
    let fetcherCalls = 0
    const metaPayloads = new Map<string, unknown>([
      ['https://bad-id.example/oauth.json', { client_id: 'https://other.example/oauth.json', redirect_uris: ['https://bad-id.example/cb'] }],
      ['https://bad-redir.example/oauth.json', { client_id: 'https://bad-redir.example/oauth.json', redirect_uris: ['http://evil.example/cb'] }],
      ['https://bad-auth.example/oauth.json', { client_id: 'https://bad-auth.example/oauth.json', redirect_uris: ['https://bad-auth.example/cb'], token_endpoint_auth_method: 'client_secret_basic' }],
    ])

    const env = setupCimdAndElicitEnv({
      dnsLookup: async host => {
        if (host === 'rebinding-10.example') return [{ address: '10.0.0.1' }]
        if (host === 'rebinding-192.example') return [{ address: '93.184.216.34' }, { address: '192.168.1.1' }]
        if (host === 'nxdomain.example') return []
        if (host === 'throws.example') throw new Error('ENOTFOUND')
        return [{ address: '93.184.216.34' }]
      },
      cimdFetcher: async url => {
        fetcherCalls++
        const body = metaPayloads.get(url)
        return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404 }
      },
    })

    const tryAuthorize = (clientId: string, redirectUri = 'https://client.example.org/cb') =>
      env.app.request(`${O}/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      })}`)

    const ssrfTargets = [
      'https://localhost/oauth.json',
      'https://svc.local/oauth.json',
      'https://meta.internal/oauth.json',
      'https://127.0.0.1/oauth.json',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/oauth.json',
      'https://rebinding-10.example/oauth.json',
      'https://rebinding-192.example/oauth.json',
      'https://nxdomain.example/oauth.json',
      'https://throws.example/oauth.json',
    ]
    for (const target of ssrfTargets) {
      const r = await tryAuthorize(target)
      expect(r.status, target).toBe(400)
    }
    expect(fetcherCalls).toBe(0)

    expect((await tryAuthorize('https://bad-id.example/oauth.json', 'https://bad-id.example/cb')).status).toBe(400)
    expect((await tryAuthorize('https://bad-redir.example/oauth.json', 'http://evil.example/cb')).status).toBe(400)
    expect((await tryAuthorize('https://bad-auth.example/oauth.json', 'https://bad-auth.example/cb')).status).toBe(400)
  })

  it('supports SEP-1036 URL Mode Elicitation accept/decline, stateless fallback approve_url, and lease bypass', async () => {
    const { app, store, reg, mcpDeps, catalog } = setupCimdAndElicitEnv()
    const kp = generateAegisNodeKeyPair()

    const patRes = await (await app.request('/api/aegis/auth/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin Hub Client',
        node_pubkey: kp.publicKey,
        modules: { writing: 'rw', admin: 'rw' },
      }),
    })).json() as { grant_id: string; access_token: string }

    const doc1 = store.createDoc({ owner: reg.user.id, title: 'Fallback Doc', kind: 'doc', state: new Uint8Array() })
    const doc2 = store.createDoc({ owner: reg.user.id, title: 'Decline Doc', kind: 'doc', state: new Uint8Array() })
    const doc3 = store.createDoc({ owner: reg.user.id, title: 'Accept Doc', kind: 'doc', state: new Uint8Array() })
    const doc4 = store.createDoc({ owner: reg.user.id, title: 'Lease Doc', kind: 'doc', state: new Uint8Array() })
    for (const d of [doc1, doc2, doc3, doc4]) store.trashDoc(d.id, true)

    // 1. Stateless HTTP without lease -> approval_required with approve_url
    const fallbackRes = await app.request(`${O}/api/mcp/hub`, {
      method: 'POST',
      headers: { authorization: `Bearer ${patRes.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hub_call_tool', arguments: { tool_name: 'doc_manage', arguments: { action: 'purge', doc_id: doc1.id } } },
      }),
    })
    expect(fallbackRes.status).toBe(200)
    const fallbackPayload = JSON.parse(((await fallbackRes.json()) as any).result.content[0].text) as {
      status: string; action_id: string; approve_url: string; escalation_id: string
    }
    expect(fallbackPayload.status).toBe('approval_required')
    expect(fallbackPayload.approve_url).toBe(`${O}/app?action=${fallbackPayload.action_id}`)
    expect(fallbackPayload.escalation_id).toBeTruthy()
    expect(store.getDoc(doc1.id)).toBeDefined()

    // Also verify non-lease buildMcpServer fallback -> pending_confirmation with approve_url
    const plainServer = buildMcpServer(mcpDeps, { u: reg.user.id, d: '*', p: ['read', 'write'], aud: 'mcp', exp: 9999999999 }, { publicOrigin: O })
    const [pa, pb] = InMemoryTransport.createLinkedPair()
    await plainServer.connect(pa)
    const plainClient = new Client({ name: 'plain', version: '1' })
    await plainClient.connect(pb)
    const plainRes = await plainClient.callTool({ name: 'doc_manage', arguments: { action: 'purge', doc_id: doc1.id } }) as { content: Array<{ text: string }> }
    const plainPayload = JSON.parse(plainRes.content[0]!.text) as { status: string; action_id: string; approve_url: string }
    expect(plainPayload.status).toBe('pending_confirmation')
    expect(plainPayload.approve_url).toBe(`${O}/app?action=${plainPayload.action_id}`)
    await plainClient.close()
    await plainServer.close()

    // 2. Bidirectional client supporting SEP-1036 URL Mode Elicitation (decline -> kept; accept+confirm -> purged)
    const prep = prepareExternalMcpSession(mcpDeps, { authHeader: `Bearer ${patRes.access_token}`, agentId: 'elicit-ui' })
    expect(prep.ok).toBe(true)
    if (!prep.ok) throw new Error('expected session')

    const { server } = buildHubMcpServer(mcpDeps, prep.session, { catalog, publicOrigin: O })
    const [ca, cb] = InMemoryTransport.createLinkedPair()
    await server.connect(ca)

    let mode: 'decline' | 'accept' = 'decline'
    const elicitedUrls: string[] = []
    const client = new Client({ name: 'elicit-ui', version: '1' }, { capabilities: { elicitation: { url: {} } } })
    client.setRequestHandler(ElicitRequestSchema, async req => {
      const p = req.params as { url?: string; elicitationId?: string; mode?: string }
      expect(p.mode).toBe('url')
      if (p.url) elicitedUrls.push(p.url)
      if (mode === 'decline') return { action: 'decline' }
      const cRes = await app.request(`/api/actions/${p.elicitationId}/confirm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${reg.token}` },
      })
      expect(cRes.status).toBe(200)
      return { action: 'accept' }
    })
    await client.connect(cb)

    const decOut = await client.callTool({
      name: 'hub_call_tool',
      arguments: { tool_name: 'doc_manage', arguments: { action: 'purge', doc_id: doc2.id } },
    }) as { content: Array<{ text: string }> }
    expect(JSON.parse(decOut.content[0]!.text).status).toBe('rejected')
    expect(store.getDoc(doc2.id)).toBeDefined()

    mode = 'accept'
    const accOut = await client.callTool({
      name: 'hub_call_tool',
      arguments: { tool_name: 'doc_manage', arguments: { action: 'purge', doc_id: doc3.id } },
    }) as { content: Array<{ text: string }> }
    const accJson = JSON.parse(accOut.content[0]!.text) as { status: string; confirmed_by_user: boolean }
    expect(accJson.status).toBe('done')
    expect(accJson.confirmed_by_user).toBe(true)
    expect(store.getDoc(doc3.id)).toBeUndefined()
    expect(elicitedUrls).toHaveLength(2)

    await client.close()
    await server.close()

    // 3. Valid Ed25519 X-Aegis-Lease-Token bypasses elicitation and executes immediately
    const nowSec = Math.floor(Date.now() / 1000)
    const leaseToken = signAegisLeaseToken({
      iss: 'lease-test-1',
      sub: patRes.grant_id,
      app: 'heurion',
      agent: '*',
      scope: 'heurion:doc_manage.*',
      resource: doc4.id,
      iat: nowSec,
      exp: nowSec + 300,
    }, kp.privateKeyPem)
    const leaseRes = await app.request(`${O}/api/mcp/hub`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${patRes.access_token}`,
        'x-aegis-lease-token': leaseToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'hub_call_tool', arguments: { tool_name: 'doc_manage', arguments: { action: 'purge', doc_id: doc4.id } } },
      }),
    })
    expect(leaseRes.status).toBe(200)
    const leasePayload = JSON.parse(((await leaseRes.json()) as any).result.content[0].text) as { lease_authorized: boolean }
    expect(leasePayload.lease_authorized).toBe(true)
    expect(store.getDoc(doc4.id)).toBeUndefined()
  })
})
