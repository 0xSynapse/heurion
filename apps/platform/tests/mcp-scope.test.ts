import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { TokenClaims } from '../src/auth/token.ts'
import { scopeOf, toolInScope } from '../src/mcp/scope.ts'
import { buildMcpServer } from '../src/mcp/server.ts'

/** 只列工具：注册阶段不调用依赖，给一个什么都返回空的替身即可。 */
async function toolsFor(t?: 'doc' | 'deck') {
  const stub: any = new Proxy({}, { get: () => new Proxy(() => ({}), { get: () => () => ({}) }) })
  const claims = { u: 'u', d: '*', p: ['read', 'write'], aud: 'mcp', exp: 0, ...(t ? { t } : {}) } as TokenClaims
  const server = buildMcpServer(stub, claims)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  const { tools } = await client.listTools()
  return { names: tools.map(x => x.name), chars: tools.reduce((n, x) => n + JSON.stringify(x).length, 0) }
}

describe('MCP 工具范围：普通稿件与幻灯片只暴露用得到的工具', () => {
  it('回合所在文档 → 范围：幻灯片 deck，普通稿件 doc，提及 PPT/幻灯片时自动升级为 deck，患者文档、随航等不限', () => {
    expect(scopeOf({ kind: 'deck', context: null })).toBe('deck')
    expect(scopeOf({ kind: 'doc', context: null })).toBe('doc')
    expect(scopeOf({ kind: 'doc', context: null }, '请帮我优化这段文字')).toBe('doc')
    expect(scopeOf({ kind: 'doc', context: null }, '目前这个版本我相对满意了，请帮我同步更新中英文PPT')).toBe('deck')
    expect(scopeOf({ kind: 'doc', context: null }, '请将研究方案制作成幻灯片')).toBe('deck')
    expect(scopeOf({ kind: 'doc', context: '{"kind":"patient","patient_id":"p1"}' })).toBeNull()
    expect(scopeOf({ kind: 'doc', context: '{"kind":"copilot"}' })).toBeNull()
    expect(scopeOf(undefined)).toBeNull()
  })

  it('稿件范围：文档、批注、文献、记忆、资料库、数据集与研究工具都在；幻灯片、影像、患者、管理工具不在；说明总量减半以上', async () => {
    const all = await toolsFor()
    const doc = await toolsFor('doc')
    for (const name of ['doc_read', 'doc_edit', 'doc_create', 'comment_reply', 'insert_citation', 'pubmed_search', 'verify_claims', 'memory_propose', 'kb_search', 'dataset_table1', 'study_read', 'delegate_task', 'phi_scan']) expect(doc.names).toContain(name)
    for (const name of ['deck_edit', 'slide_read', 'layout_check', 'imaging_analyze', 'patient_read', 'phr_share', 'labs_query', 'report_read', 'tenant_admin']) expect(doc.names).not.toContain(name)
    expect(doc.chars).toBeLessThan(all.chars / 2)
    expect(all.names.every(n => toolInScope(n, undefined))).toBe(true)
  })

  it('幻灯片范围：稿件工具加幻灯片工具，仍不含影像、患者、管理工具', async () => {
    const deck = await toolsFor('deck')
    for (const name of ['deck_edit', 'slide_read', 'slide_render', 'layout_check', 'deck_templates', 'image_search', 'slide_add_photo', 'doc_outline', 'insert_citation']) expect(deck.names).toContain(name)
    for (const name of ['imaging_analyze', 'patient_read', 'platform_admin']) expect(deck.names).not.toContain(name)
  })
})
