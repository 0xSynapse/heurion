import { MODULES, type HeurionModule } from '../mcp/modules.ts'
import { moduleToolNames } from '../mcp/skills.ts'
import { AEGIS_APP_MANIFEST } from './manifest.ts'

/**
 * aegis-os v0.9 的声明式 MCP 清单（`GET /.well-known/mcp-bundle.json`，schema `aegis-mcp-bundle/v1`）。
 *
 * 由模块注册表生成：每个模块一个 Streamable HTTP MCP 服务器，鉴权走 RFC 8628 设备码（`/api/aegis/auth/device`
 * 与 `/api/aegis/auth/token`）。字段名与枚举值对齐 aegis-os 的 serde 定义（`aos-mcp-gateway/src/mcp_bundle.rs`、
 * `mcp_firewall.rs`）；地址必须是完整的 http(s) URL，所以按请求的 origin 生成。旧的 AAP-1.0 清单
 * `/.well-known/aegis-app.json` 照常保留。
 */

type RiskClass = 'read_only' | 'staged_write' | 'destructive' | 'forbidden'

/**
 * 写工具在 Heurion 服务端已有回合撤销与来源规则保护：这些模块里不需要租约的工具标 read_only，
 * 免得 Aegis 本地防火墙把每次写入都放进待审队列。需要租约的高风险工具一律 staged_write。
 */
const SERVER_GUARDED: ReadonlySet<string> = new Set(['writing', 'literature', 'knowledge', 'memory', 'analysis', 'imaging', 'research'])

function profilesOf(m: HeurionModule): string[] {
  if (m.external === 'open') return ['default', 'open', m.id]
  if (m.external === 'readonly_default') return ['default', 'admin']
  return ['clinical', 'full', m.id]
}

export async function buildMcpBundleManifest(origin: string) {
  const host = new URL(origin).hostname
  const allowedHosts = host === 'heurion.org' ? ['heurion.org', '*.heurion.org'] : [host]
  const servers = await Promise.all(MODULES.map(async m => {
    const overrides: Record<string, RiskClass> = {}
    if (SERVER_GUARDED.has(m.id)) for (const t of await moduleToolNames(m.id)) if (!m.leaseGated[t]) overrides[t] = 'read_only'
    for (const t of Object.keys(m.leaseGated)) overrides[t] = 'staged_write'
    return {
      server_id: `heurion-${m.id}`,
      url: `${origin}/api/aegis/mcp/${m.id}`,
      description: m.summary,
      trust_level: 'trusted_internal' as const,
      // 不在本地做假名化：作者邮箱、机构名会被替换后写进稿件；患者在平台侧只用代号且受机构外发策略管控
      dlp_mode: 'off' as const,
      strip_prompt_injection: m.id === 'literature' || m.id === 'knowledge',
      request_timeout_ms: 300_000,
      profiles: profilesOf(m),
      tool_overrides: overrides,
    }
  }))
  const skills = [
    ...MODULES.map(m => ({
      id: `heurion-${m.id}`, name: `heurion-${m.id}`, description: `「${m.title}」模块：${m.summary}`,
      url: `${origin}/.well-known/aegis-skills/heurion-${m.id}/SKILL.md`,
    })),
    // 总览技能（AAP 清单里的 heurion-clinical-research）
    ...(AEGIS_APP_MANIFEST.skills ?? []).filter(s => s.name === 'heurion-clinical-research').map(s => ({ id: s.name, name: s.name, description: s.description, url: `${origin}${s.url}` })),
  ]
  return {
    schema: 'aegis-mcp-bundle/v1',
    bundle_id: 'heurion',
    name: AEGIS_APP_MANIFEST.name,
    version: AEGIS_APP_MANIFEST.version,
    description: AEGIS_APP_MANIFEST.description,
    auth_realm: {
      realm_id: 'heurion',
      issuer_url: origin,
      device_authorization_endpoint: `${origin}/api/aegis/auth/device`,
      token_endpoint: `${origin}/api/aegis/auth/token`,
      client_id: 'aegis-os',
      allowed_hosts: allowedHosts,
      scopes: [] as string[],
    },
    servers,
    skills,
  }
}
