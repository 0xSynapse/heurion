import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { TokenClaims } from '../src/auth/token.ts'
import { MODULE_IDS, MODULES, moduleOf, READ_ONLY_TOOLS, type ModuleId } from '../src/mcp/modules.ts'
import { buildMcpServer, type AegisMcpServerOptions } from '../src/mcp/server.ts'

/** 只列工具：注册阶段不调用依赖，给一个什么都返回空的替身即可（同 mcp-scope.test.ts）。 */
async function list(opts?: AegisMcpServerOptions, t?: 'doc' | 'deck') {
  const stub: any = new Proxy({}, { get: () => new Proxy(() => ({}), { get: () => () => ({}) }) })
  const claims = { u: 'u', d: '*', p: ['read', 'write'], aud: 'mcp', exp: 0, ...(t ? { t } : {}) } as TokenClaims
  const server = buildMcpServer(stub, claims, opts)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  return (await client.listTools()).tools
}

/** 拆分前 server.ts 里的只读工具正则（原样保留在测试里，证明注册表与它逐个一致）。 */
const OLD_READONLY = /^(doc_list|docs_search|doc_outline|doc_read|doc_search|doc_validate|doc_history|doc_diff|deck_templates|slide_read|layout_check|slide_render|comments_list|pubmed_search|openalex_search|oa_fulltext|doi_lookup|list_citations|list_measurements|verify_claims|dataset_list|dataset_describe|patient_list|patient_read|labs_query|report_read|patient_access_log|share_list|share_read|share_labs|share_file|study_list|study_read|study_cohort_preview|study_cohort_list|study_vars_list|kb_search|kb_read|memory_search|phr_member_links|patient_claims_list|phi_scan|imaging_status|imaging_models|account|action_status|asset_provenance)$/

describe('MCP 模块注册表（阶段 0：拆模块，不改行为）', () => {
  it('平台注册的每个工具恰好属于一个模块；注册表里登记的名字都真实存在；九个模块都不空', async () => {
    const names = (await list()).map(t => t.name)
    expect(names.filter(n => moduleOf(n) === null), '新工具要在 mcp/modules.ts 登记所属模块').toEqual([])
    // 前缀匹配到多个模块会返回 null，上一行已排除；名字登记不能重复（模块加载时校验）
    const listed = MODULES.flatMap(m => m.names)
    expect(listed.filter(n => !names.includes(n)), '登记的工具要真的存在').toEqual([])
    for (const id of MODULE_IDS) expect(names.some(n => moduleOf(n) === id), `模块 ${id} 没有工具`).toBe(true)
    expect(MODULE_IDS).toEqual(['writing', 'literature', 'analysis', 'patients', 'imaging', 'research', 'knowledge', 'memory', 'admin'])
  })

  it('归属：名字优先于前缀（管理工具不会被前缀拉到别的模块）', () => {
    expect(moduleOf('dataset_manage')).toBe('admin')
    expect(moduleOf('dataset_table1')).toBe('analysis')
    expect(moduleOf('kb_manage')).toBe('admin')
    expect(moduleOf('patient_admin')).toBe('admin')
    expect(moduleOf('phr_share')).toBe('admin')
    expect(moduleOf('phr_member_links')).toBe('patients')
    expect(moduleOf('share_list')).toBe('patients')
    expect(moduleOf('insert_measurement')).toBe('writing')
    expect(moduleOf('insert_citation')).toBe('literature')
    expect(moduleOf('no_such_tool')).toBeNull()
  })

  it('挂全部模块与不指定模块完全一致（dsh 看到的工具名、顺序、说明与参数逐字相同）', async () => {
    const all = await list()
    const explicit = await list({ modules: MODULE_IDS })
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(all))
  })

  it('只挂一个模块：只暴露该模块的工具；各模块合起来正好是全部工具', async () => {
    const all = (await list()).map(t => t.name)
    const union: string[] = []
    for (const id of MODULE_IDS) {
      const names = (await list({ modules: [id] })).map(t => t.name)
      expect(names.length).toBeGreaterThan(0)
      expect(names.every(n => moduleOf(n) === id)).toBe(true)
      union.push(...names)
    }
    expect([...union].sort()).toEqual([...all].sort())
    const two = (await list({ modules: ['writing', 'literature'] as ModuleId[] })).map(t => t.name)
    expect(two).toContain('doc_edit')
    expect(two).toContain('insert_citation')
    expect(two).not.toContain('patient_read')
  })

  it('只读工具集合与拆分前的正则逐个一致；只读授权 + 模块过滤可以叠加', async () => {
    const all = (await list()).map(t => t.name)
    expect(all.filter(n => READ_ONLY_TOOLS.has(n))).toEqual(all.filter(n => OLD_READONLY.test(n)))
    const ro = (await list({ aegisToolScope: 'readonly' })).map(t => t.name)
    expect(ro).toEqual(all.filter(n => OLD_READONLY.test(n)))
    const roWriting = (await list({ aegisToolScope: 'readonly', modules: ['writing'] })).map(t => t.name)
    expect(roWriting).toContain('doc_read')
    expect(roWriting).not.toContain('doc_edit')
    expect(roWriting.every(n => moduleOf(n) === 'writing' && READ_ONLY_TOOLS.has(n))).toBe(true)
  })

  it('dsh 的稿件 / 幻灯片范围不受影响', async () => {
    const doc = (await list(undefined, 'doc')).map(t => t.name)
    expect(doc).toContain('doc_edit')
    expect(doc).not.toContain('deck_edit')
    expect(doc).not.toContain('patient_read')
  })
})
