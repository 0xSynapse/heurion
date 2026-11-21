/**
 * Aegis 应用协议 AAP-1.0 —— 应用清单（`GET /.well-known/aegis-app.json`）。
 *
 * 本地 Aegis-OS 据此发现应用、鉴权端点和各模块的 MCP 地址。模块与能力预览由模块注册表
 * （mcp/modules.ts）生成，不再手写，所以清单里列的工具都真实存在（tests/aegis-app.test.ts 校验）。
 * 现状与按模块开放的方案见 docs/design/MCP_MODULES.md。
 */
import { MODULES, moduleOf, READ_ONLY_TOOLS } from '../mcp/modules.ts'
import { type AegisAppManifest, type AegisAppModule, type AegisCapabilityPreview, defineAegisManifest } from './sdk.ts'

export type { AegisAppManifest, AegisCapabilityPreview }

export const AEGIS_MCP_PATH = '/api/aegis/mcp'

const modules: AegisAppModule[] = MODULES.map(m => ({
  id: m.id,
  title: m.title,
  summary: m.summary,
  mcp_http: `${AEGIS_MCP_PATH}/${m.id}`,
  external: m.external,
  read_only_tools: [...READ_ONLY_TOOLS].filter(t => moduleOf(t) === m.id),
  lease_gated: { ...m.leaseGated },
}))

const capabilities: AegisCapabilityPreview[] = [
  { name: 'doc_edit', tier: 'zero_prompt', description: '论文结构化编辑（经操作层与写前守卫，按回合可撤销）' },
  { name: 'deck_edit', tier: 'zero_prompt', description: '幻灯片编辑与排版检查' },
  { name: 'doc_revert_turn', tier: 'zero_prompt', description: '按回合或智能体撤销 AI 的改动，保留其他智能体与人工编辑' },
  ...MODULES.flatMap(m => Object.entries(m.leaseGated).map(([name, scope]) => ({
    name,
    tier: 'lease_gated' as const,
    lease_scope: scope,
    description: `${m.title}：${scope === 'heurion:clinical_confirm' ? '临床确认（机构开启复核时）' : '需确认的操作'}需要用户批准的租约`,
  }))),
]

export const AEGIS_APP_MANIFEST: AegisAppManifest = defineAegisManifest({
  schema_version: 'AAP-1.0',
  app_id: 'heurion',
  name: '知衡 (Heurion 2.0) — 临床与科研智能工作台',
  version: '2.0.0',
  category: 'clinical_research',
  trust_tier: 'first_party',
  description: '论文与幻灯片写作、文献与引用、数据分析、患者档案与知家、影像、临床研究、资料库与记忆，按模块开放给外部智能体。',
  homepage: 'https://heurion.org',
  endpoints: {
    mcp_http: AEGIS_MCP_PATH,
    auth_device_code: '/api/aegis/auth/device',
    auth_device_approve: '/api/aegis/auth/device/approve',
    auth_token_exchange: '/api/aegis/auth/token',
    auth_token_revoke: '/api/aegis/auth/token',
    auth_grants: '/api/aegis/auth/grants',
    lease_approve: '/api/aegis/leases/approve',
  },
  auth: {
    modes: ['device_code', 'pat', 'credentials'],
    token_prefix: 'aegis_at_heurion.',
    requires_node_pubkey: true,
    supports_lease_verification: 'ed25519',
  },
  modules,
  capabilities_preview: capabilities,
  skills: [
    {
      name: 'heurion-clinical-research',
      description: '知衡 (Heurion 2.0) 临床病历核对、真实世界队列纳排、统计建模与论文 / 幻灯片协同写作的标准作业规程',
      url: '/.well-known/aegis-skills/heurion-clinical-research/SKILL.md',
    },
  ],
})

export function buildAegisManifest(overrides?: Partial<AegisAppManifest>): AegisAppManifest {
  return { ...AEGIS_APP_MANIFEST, ...overrides }
}
