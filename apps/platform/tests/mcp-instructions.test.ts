import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { TokenClaims } from '../src/auth/token.ts'
import { DSH_INSTRUCTIONS, externalInstructions, moduleSkill } from '../src/mcp/instructions.ts'
import { buildMcpServer, type AegisMcpServerOptions } from '../src/mcp/server.ts'

async function connect(opts?: AegisMcpServerOptions) {
  const stub: any = new Proxy({}, { get: () => new Proxy(() => ({}), { get: () => () => ({}) }) })
  const claims = { u: 'u', d: '*', p: ['read', 'write'], aud: 'mcp', exp: 0 } as TokenClaims
  const server = buildMcpServer(stub, claims, opts)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  return client
}

describe('工具说明按模块拆分（阶段 3）', () => {
  it('dsh 拿到的说明与拆分前逐字一致（指纹锁定）', async () => {
    expect(createHash('sha256').update(DSH_INSTRUCTIONS).digest('hex')).toBe('0bf180e8246c7625b49e2ed5e3f5218c605ded2065a7178ab5d47a2e1c1d4ff1')
    expect((await connect()).getInstructions()).toBe(DSH_INSTRUCTIONS)
  })

  it('外部智能体只拿共同规则与所连模块；dsh 专有环境的说法换成外部版本', async () => {
    const writing = externalInstructions(['writing'])
    expect(writing).toContain('来源规则')
    expect(writing).toContain('doc_edit')
    expect(writing).toContain('workspace_put')
    expect(writing).not.toContain('pubmed_search')
    expect(writing).not.toContain('patient_')
    const all = externalInstructions()
    for (const dshOnly of ['shell', '回合开头的［记忆］', '放进工作区 → 在 shell', 'pending_confirmation']) expect(all).not.toContain(dshOnly)
    expect(all).toContain('approval_required')
    const client = await connect({ aegisModules: { literature: 'r', writing: 'rw' }, modules: ['literature'] })
    const got = client.getInstructions()!
    expect(got).toContain('pubmed_search')
    expect(got).not.toContain('deck_edit')
  })

  it('外部智能体的工作区文件工具挂在每个模块上，dsh 没有；只读授权只挂只读的两个', async () => {
    const names = async (opts?: AegisMcpServerOptions) => (await (await connect(opts)).listTools()).tools.map(t => t.name)
    expect(await names()).not.toContain('workspace_put')
    const lit = await names({ aegisModules: { literature: 'rw' }, modules: ['literature'] })
    expect(lit).toEqual(expect.arrayContaining(['workspace_put', 'workspace_get', 'workspace_list', 'pubmed_search']))
    const ro = await names({ aegisModules: { literature: 'r' } })
    expect(ro).toContain('workspace_get')
    expect(ro).not.toContain('workspace_put')
  })

  it('模块的 SKILL.md：名字、地址、共同规则、本模块说明与工具清单', () => {
    const md = moduleSkill('analysis', ['dataset_describe', 'workspace_put'])
    expect(md).toMatch(/^---\nname: heurion-analysis\n/)
    expect(md).toContain('POST /api/mcp/analysis')
    expect(md).toContain('来源规则')
    expect(md).toContain('本机算出的数字平台无法核对')
    expect(md).toContain('- `dataset_describe`')
  })
})
