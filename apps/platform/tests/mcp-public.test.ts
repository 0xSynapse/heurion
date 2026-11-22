import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
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
import { TurnService } from '../src/turns/service.ts'

function setupPublicApp(opts?: { pubmed?: PubMedClient; crossref?: CrossrefClient; aegisEnabled?: boolean }) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const pool = {
    liveSession: () => null,
    run: () => new Promise(() => {}),
    cancel: async () => {},
    workspaceDir: () => mkdtempSync(join(tmpdir(), 'pubmcp-ws-')),
  } as unknown as HarnessPool
  const turns = new TurnService(docs, pool, new TurnRegistry())
  const accounts = new Accounts(store, {
    secret: 'pub-test-secret',
    devMode: false,
    devToken: 'dev',
    devUser: 'dev',
    botGuard: new BotGuard({ secret: 'pub-test-secret', baseMax: 300, minDelayMs: 0 }),
  })
  const app = buildApi({
    docs,
    ops,
    turns,
    postcheck: new PostCheck(docs),
    crossref: opts?.crossref ?? ({} as CrossrefClient),
    pubmed: opts?.pubmed,
    renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'pubmcp-r-'))),
    accounts,
    devMode: false,
    aegisEnabled: opts?.aegisEnabled ?? true,
    devUser: 'dev',
    publicOrigin: 'https://heurion.org',
  })
  return { app, store }
}

async function rpcCall(
  app: ReturnType<typeof buildApi>,
  payload: unknown,
  ip = '203.0.113.10',
) {
  return app.request('/api/public/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': ip,
    },
    body: JSON.stringify(payload),
  })
}

async function callPublicTool(
  app: ReturnType<typeof buildApi>,
  name: string,
  args: Record<string, unknown>,
  ip = '203.0.113.10',
) {
  const res = await rpcCall(app, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }, ip)
  expect(res.status).toBe(200)
  const json = await res.json() as {
    result?: { isError?: boolean; content: Array<{ type: string; text: string }> }
  }
  const text = json.result?.content?.[0]?.text ?? '{}'
  return { isError: Boolean(json.result?.isError), data: JSON.parse(text) as Record<string, any> }
}

describe('Phase 0 · Zero-Auth Public Clinical Research MCP (/api/public/mcp)', () => {
  beforeEach(() => {
    clearPublicCitationCache()
  })

  it('exposes exactly 7 stateless tools without auth, supports 405 & CORS, and stays active when aegisEnabled=false', async () => {
    const { app, store } = setupPublicApp({ aegisEnabled: false })

    const initRes = await rpcCall(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'registry-probe', version: '1.0' } },
    })
    expect(initRes.status).toBe(200)
    const initJson = await initRes.json() as { result?: { serverInfo?: { name: string } } }
    expect(initJson.result?.serverInfo?.name).toBe('heurion-clinical-research-tools')

    const notifRes = await rpcCall(app, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(notifRes.status).toBe(202)

    const listRes = await rpcCall(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(listRes.status).toBe(200)
    const listJson = await listRes.json() as { result?: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } }
    const names = listJson.result!.tools.map(t => t.name).sort()
    expect(names).toEqual([
      'public_consort_diagram',
      'public_deep_review_audit',
      'public_e_value_calculate',
      'public_forest_plot_generate',
      'public_kaplan_meier_survival',
      'public_phi_scan',
      'public_pubmed_citation_check',
      'public_table1_generate',
    ])
    for (const tool of listJson.result!.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }

    for (const method of ['GET', 'DELETE'] as const) {
      const mRes = await app.request('/api/public/mcp', { method })
      expect(mRes.status).toBe(405)
      expect(mRes.headers.get('allow')).toBe('POST')
    }

    const pre = await app.request('/api/public/mcp', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:6274', 'access-control-request-method': 'POST' },
    })
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')

    expect(store.countUsers()).toBe(0)
    expect(store.allDocIds()).toHaveLength(0)
  })

  it('executes all 6 deterministic statistical/SVG/PHI tools cleanly', async () => {
    const { app } = setupPublicApp()

    const ev = await callPublicTool(app, 'public_e_value_calculate', {
      effect_type: 'HR',
      estimate: 0.74,
      ci_lower: 0.65,
      ci_upper: 0.85,
      lang: 'en',
    }, '203.0.113.11')
    expect(ev.isError).toBe(false)
    expect(ev.data.e_value_point).toBeGreaterThan(1.5)
    expect(ev.data.svg).toContain('<svg')
    expect(ev.data.rebuttal_en).toContain('VanderWeele')

    const consort = await callPublicTool(app, 'public_consort_diagram', {
      total_assessed: 300,
      exclusions: [{ reason: 'Age < 18', count: 50 }],
      eligible_total: 240,
      arms: [
        { name: 'Drug A', allocated: 120, analyzed: 118 },
        { name: 'Placebo', allocated: 120, analyzed: 119 },
      ],
      lang: 'en',
    }, '203.0.113.12')
    expect(consort.isError).toBe(false)
    expect(consort.data.svg).toContain('<svg')
    expect(consort.data.mermaid).toContain('graph TD')
    expect(consort.data.arithmetic_warning).toContain('250')

    const t1 = await callPublicTool(app, 'public_table1_generate', {
      csv: 'arm,age,sex\ntreat,64,M\ntreat,68,F\nctrl,62,M\nctrl,66,F',
      options: { group_col: 'arm' },
    }, '203.0.113.13')
    expect(t1.isError).toBe(false)
    expect(t1.data.row_count).toBe(4)
    expect(t1.data.phi_clean).toBe(true)

    const km = await callPublicTool(app, 'public_kaplan_meier_survival', {
      csv: 'id,time,event,arm\n1,12,1,A\n2,18,0,A\n3,6,1,B\n4,9,1,B',
      time_col: 'time',
      event_col: 'event',
      group_col: 'arm',
    }, '203.0.113.14')
    expect(km.isError).toBe(false)
    expect(km.data.svg).toContain('<svg')
    expect(km.data.r_script).toContain('survfit')

    const fp = await callPublicTool(app, 'public_forest_plot_generate', {
      effect_type: 'HR',
      raw_lines: 'Age >= 65 | 0.72 | 0.58 | 0.89 | 0.002\n*Overall | 0.75 | 0.65 | 0.86 | <0.001',
    }, '203.0.113.15')
    expect(fp.isError).toBe(false)
    expect(fp.data.rows_count).toBe(2)
    expect(fp.data.svg).toContain('<svg')

    const phi = await callPublicTool(app, 'public_phi_scan', {
      text: 'Patient Name: John Doe, MRN: HOSP-998811, email doctor.john@hospital.org, SSN 123-45-6789.',
    }, '203.0.113.16')
    expect(phi.isError).toBe(false)
    expect(phi.data.clean).toBe(false)
    expect(phi.data.findings_count).toBeGreaterThanOrEqual(4)
    expect(phi.data.redacted_text).not.toContain('John Doe')
    expect(phi.data.redacted_text).not.toContain('123-45-6789')
  })

  it('caches PubMed citation verification for 24h and detects fabricated effect sizes', async () => {
    let summaryCalls = 0
    const mockPubmed = {
      async pmidForDoi() { return null },
      async summaries(pmids: string[]) {
        summaryCalls++
        if (pmids.includes('40001234')) {
          return [{
            pmid: '40001234',
            doi: '10.1000/mock-trial',
            title: 'Mock Randomized Cardiovascular Trial',
            authors: ['Zhang W', 'Li M'],
            journal: 'Lancet',
            year: '2025',
          }]
        }
        return []
      },
      async abstract(pmid: string) {
        if (pmid === '40001234') {
          return 'RESULTS: Hazard ratio was 0.81 (95% CI, 0.70 to 0.94; P=0.005).'
        }
        return null
      },
    } as unknown as PubMedClient

    const { app } = setupPublicApp({ pubmed: mockPubmed })

    const r1 = await callPublicTool(app, 'public_pubmed_citation_check', {
      text: 'In this trial (PMID: 40001234), treatment yielded HR 0.45 (95% CI 0.30-0.60).',
    }, '203.0.113.20')
    expect(r1.data.summary.mismatch).toBe(1)
    expect(summaryCalls).toBe(1)

    const r2 = await callPublicTool(app, 'public_pubmed_citation_check', {
      text: 'Confirmed effect size (PMID: 40001234): HR 0.81 (95% CI 0.70-0.94).',
    }, '203.0.113.21')
    expect(r2.data.summary.verified).toBe(1)
    expect(summaryCalls).toBe(1)
  })

  it('enforces strict per-IP rate limits (15/min on citation checks and 30/min on endpoint)', async () => {
    const { app } = setupPublicApp()

    const citeIp = '198.51.100.77'
    for (let i = 0; i < 15; i++) {
      const r = await callPublicTool(app, 'public_pubmed_citation_check', {
        text: 'DAPA-HF (PMID: 31535829) showed HR 0.74 (95% CI 0.65-0.85).',
      }, citeIp)
      expect(r.isError).toBe(false)
    }
    const r16 = await callPublicTool(app, 'public_pubmed_citation_check', {
      text: 'DAPA-HF (PMID: 31535829)',
    }, citeIp)
    expect(r16.isError).toBe(true)
    expect(r16.data.error).toContain('15')

    const floodIp = '198.51.100.88'
    for (let i = 0; i < 30; i++) {
      const res = await rpcCall(app, { jsonrpc: '2.0', id: i + 1, method: 'tools/list' }, floodIp)
      expect(res.status).toBe(200)
    }
    const res31 = await rpcCall(app, { jsonrpc: '2.0', id: 31, method: 'tools/list' }, floodIp)
    expect(res31.status).toBe(429)
    expect(res31.headers.get('retry-after')).toBe('60')
  })
})
