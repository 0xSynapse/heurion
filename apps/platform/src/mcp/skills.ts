import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { TokenClaims } from '../auth/token.ts'
import { moduleSkill } from './instructions.ts'
import { MODULE_IDS, type ModuleGrant, type ModuleId } from './modules.ts'
import { buildMcpServer } from './server.ts'

/**
 * 按模块的 SKILL.md（`/.well-known/aegis-skills/heurion-<module>/SKILL.md`）：说明来自 instructions.ts，
 * 工具清单按外部智能体在该模块地址上实际看到的列出（读写授权；只注册、不调用，所以用空替身即可）。
 */
const cache = new Map<ModuleId, Promise<string>>()

async function externalToolNames(module: ModuleId): Promise<string[]> {
  const stub: any = new Proxy({}, { get: () => new Proxy(() => ({}), { get: () => () => ({}) }) })
  const claims = { u: 'skill', d: '*', p: ['read', 'write'], aud: 'mcp', exp: 0 } as TokenClaims
  const all = Object.fromEntries(MODULE_IDS.map(id => [id, 'rw'])) as ModuleGrant
  const server = buildMcpServer(stub, claims, { aegisModules: all, modules: [module] })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'skill', version: '0' })
  await client.connect(b)
  try { return (await client.listTools()).tools.map(t => t.name) } finally { await client.close(); await server.close() }
}

export function moduleSkillDoc(module: ModuleId): Promise<string> {
  let p = cache.get(module)
  if (!p) { p = externalToolNames(module).then(tools => moduleSkill(module, tools)); cache.set(module, p) }
  return p
}
