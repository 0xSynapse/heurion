/**
 * Aegis Application Protocol (AAP-1.0) — 应用自描述清单（Manifest）
 *
 * 暴露在 `GET /.well-known/aegis-app.json`，供本地 Aegis-OS Daemon (`aegis app search/info/install/login`)
 * 自动发现应用元数据、鉴权端点、MCP 网关地址与能力分级（Zero-Prompt vs Lease-Gated）。
 * 详见 docs/design/AEGIS_APP_PROTOCOL.md §3 & §6。
 */

export interface AegisCapabilityPreview {
  name: string
  tier: 'zero_prompt' | 'lease_gated'
  lease_scope?: string
  description: string
}

export interface AegisAppManifest {
  schema_version: 'AAP-1.0'
  app_id: string
  name: string
  version: string
  category: 'clinical_research' | 'productivity' | 'data_infrastructure' | 'devtools' | string
  trust_tier: 'first_party' | 'verified' | 'community'
  description: string
  homepage: string
  endpoints: {
    mcp_http: string
    auth_device_code: string
    auth_device_approve?: string
    auth_token_exchange: string
    auth_token_revoke: string
    auth_grants: string
    lease_approve: string
  }
  auth: {
    modes: Array<'device_code' | 'pat' | 'credentials'>
    token_prefix: string
    requires_node_pubkey: boolean
    supports_lease_verification: 'ed25519'
  }
  capabilities_preview: AegisCapabilityPreview[]
  skills?: Array<{
    name: string
    description: string
    url: string
  }>
}

export const AEGIS_APP_MANIFEST: AegisAppManifest = {
  schema_version: 'AAP-1.0',
  app_id: 'heurion',
  name: '知衡 (Heurion 2.0) — 临床与科研智能工作台',
  version: '2.0.0',
  category: 'clinical_research',
  trust_tier: 'first_party',
  description:
    '临床病历抽取、知家 (PHR) 档案管理、真实世界临床研究队列入组、统计建模与多智能体论文/幻灯片协同写作平台。',
  homepage: 'https://heurion.org',
  endpoints: {
    mcp_http: '/api/aegis/mcp',
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
  capabilities_preview: [
    {
      name: 'doc_edit',
      tier: 'zero_prompt',
      description: '论文与病历文稿结构化编辑（Yjs CRDT + 按 Agent 回合精准 CoW 回滚）',
    },
    {
      name: 'deck_edit',
      tier: 'zero_prompt',
      description: '学术汇报幻灯片编辑与排版检查（自动走回滚基线）',
    },
    {
      name: 'doc_revert_turn',
      tier: 'zero_prompt',
      description: '按 turn_id 或 Agent ID 精准回滚单次 AI 回合改动，保留其他 Agent 与人工编辑',
    },
    {
      name: 'patient_admin',
      tier: 'zero_prompt',
      description: '患者建档、化验与检查结构化抽取（标记 via=ai，可筛选与一键撤销）',
    },
    {
      name: 'dataset_analyze',
      tier: 'zero_prompt',
      description: '真实世界研究队列统计分析与图表代码溯源上传',
    },
    {
      name: 'lab_resolve',
      tier: 'lease_gated',
      lease_scope: 'heurion:clinical_confirm',
      description: '化验异常指标与检查报告临床签字确认（机构开启双人复核时需租约授权）',
    },
    {
      name: 'phr_share_admin',
      tier: 'lease_gated',
      lease_scope: 'heurion:phr_share_admin.*',
      description: '向医院科室创建知家健康档案对外分享授权或签发认领码',
    },
    {
      name: 'mail_admin',
      tier: 'lease_gated',
      lease_scope: 'heurion:mail_admin.*',
      description: '代表医生对外发送随访/科研邮件或永久清空废纸篓',
    },
    {
      name: 'tenant_admin',
      tier: 'lease_gated',
      lease_scope: 'heurion:tenant_admin.*',
      description: '修改机构安全设置、移除成员或停用患者档案',
    },
  ],
  skills: [
    {
      name: 'heurion-clinical-research',
      description: '知衡 (Heurion 2.0) 临床病历核对、真实世界队列纳排、CoW 沙箱统计建模与多智能体论文/幻灯片协同写作标准作业规程 (SOP)',
      url: '/.well-known/aegis-skills/heurion-clinical-research/SKILL.md',
    },
  ],
}

export function buildAegisManifest(overrides?: Partial<AegisAppManifest>): AegisAppManifest {
  return { ...AEGIS_APP_MANIFEST, ...overrides }
}
