import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import type { Embedder } from '../kb/embedder.ts'
import type { AdminToolDeps } from '../mcp/admin-tools.ts'
import { MAX_AUTH_MCP_BODY_BYTES, readBoundedBody, toRequestBody } from '../mcp/bounded-body.ts'
import { externalInstructions } from '../mcp/instructions.ts'
import {
  missingScopesForTool,
  MODULE_IDS,
  moduleGrantAllows,
  moduleOf,
  SHARED_TOOLS,
  toolModuleRequirements,
  type ModuleId,
} from '../mcp/modules.ts'
import {
  collectExternalTools,
  makeUrlElicitationHandler,
  prepareExternalMcpSession,
  type CollectedTool,
  type McpDeps,
  type PreparedExternalSession,
} from '../mcp/server.ts'
import { classifyCatalogTool, type CatalogEntry, type CatalogModule, ToolCatalog } from './catalog.ts'

/**
 * Heurion MCP Hub — 渐进式发现网关（`POST /api/mcp/hub` 与 `/api/aegis/mcp/hub`）
 *
 * 设计要点：
 * 1. 默认 `tools/list` 仅返回 3 个发现/调度元工具 + 最多 12 个授权 Eager Core 高频核心工具，
 *    将初始上下文 schema 开销压缩至全量 140+ 工具的一小部分。
 * 2. 通过 SQLite FTS5 trigram + 词法 + 可选 BGE-M3 向量 RRF（`ToolCatalog`）按需搜索、查看 Schema 并调用任意已授权工具。
 * 3. 与 `origin/main` 九模块权限、机构 `aegis_modules` 外发门禁、`leaseAuthorizer` 租约审批、SEP-1036 URL Mode Elicitation
 *    以及 `hr_pat.*` / `hr_oat.*` / `aegis_at_heurion.*` 鉴权体系完全共用同一条策略管线。
 */

export const EAGER_CORE_TOOLS = [
  'doc_list',
  'doc_outline',
  'doc_read',
  'doc_search',
  'doc_edit',
  'doc_revert_turn',
  'comments_list',
  'comment_reply',
  'pubmed_search',
  'insert_citation',
  'asset_upload',
  'action_status',
] as const

const CATALOG_MODULES = [...MODULE_IDS, 'workspace'] as const
const HUB_TIMEOUT_MS = 300_000

const META_TOOL_NAMES = new Set(['hub_search_tools', 'hub_describe_tool', 'hub_call_tool'])

export interface HubGatewayOptions {
  catalog: ToolCatalog
  embedder?: Embedder | null
  publicOrigin?: string
  elicitApproval?: AdminToolDeps['elicitApproval']
}

export interface BuiltHubServer {
  server: McpServer
  scopeChallenge: { requiredScope?: string; toolName?: string }
  session: PreparedExternalSession
}

function hubJsonText(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

function hubErrorText(code: string, message: string, extra: Record<string, unknown> = {}) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ code, message, ...extra }, null, 2) }],
  }
}

type ToolAuthResult =
  | { ok: true }
  | { ok: false; kind: 'rbac_denied' }
  | { ok: false; kind: 'org_blocked'; module: ModuleId }
  | { ok: false; kind: 'insufficient_scope'; requiredScope: string }

function isToolPermittedByRbac(session: PreparedExternalSession, toolName: string): boolean {
  if (toolName === 'delegate_task') return false
  if (toolName === 'platform_admin' && session.user.role !== 'admin') return false
  if ((toolName === 'tenant_admin' || toolName === 'org_template') && session.user.role !== 'admin' && session.user.tenant_role !== 'admin') {
    return false
  }
  return true
}

function isToolVisibleByOrgAndRbac(session: PreparedExternalSession, toolName: string): boolean {
  if (!isToolPermittedByRbac(session, toolName)) return false
  if (SHARED_TOOLS.has(toolName)) return true
  const reqs = toolModuleRequirements(toolName)
  return reqs.length > 0 && reqs.every(r => session.orgAllowed.has(r.module))
}

function oauthScopeForMissingTool(session: PreparedExternalSession, toolName: string): string {
  const missing = missingScopesForTool(toolName, session.effective)
  if (missing.length > 0) return missing.join(' ')
  const mod = moduleOf(toolName) ?? 'writing'
  return `${mod}:rw`
}

function checkToolAuthorization(session: PreparedExternalSession, toolName: string): ToolAuthResult {
  if (!isToolPermittedByRbac(session, toolName)) {
    return { ok: false, kind: 'rbac_denied' }
  }
  if (!SHARED_TOOLS.has(toolName)) {
    const reqs = toolModuleRequirements(toolName)
    const disallowed = reqs.find(r => !session.orgAllowed.has(r.module))
    if (reqs.length === 0 || disallowed) {
      return { ok: false, kind: 'org_blocked', module: disallowed?.module ?? 'admin' }
    }
  }
  if (!moduleGrantAllows(toolName, session.effective)) {
    return { ok: false, kind: 'insufficient_scope', requiredScope: oauthScopeForMissingTool(session, toolName) }
  }
  return { ok: true }
}

export function buildHubMcpServer(
  deps: McpDeps,
  session: PreparedExternalSession,
  opts: HubGatewayOptions,
): BuiltHubServer {
  const grantedModules = MODULE_IDS.filter(m => session.effective[m])
  const instructions =
    'Heurion MCP Hub（渐进式发现网关）。可直接使用 Eager Core 高频工具，或通过 ' +
    'hub_search_tools -> hub_describe_tool -> hub_call_tool 按需检索并调用全部已授权工具。\n\n' +
    externalInstructions(grantedModules)

  const server = new McpServer(
    { name: 'heurion-mcp-hub', version: '2.0.0' },
    { instructions },
  )

  const elicitApproval = opts.elicitApproval ?? makeUrlElicitationHandler(server)
  const collected = collectExternalTools(
    { ...deps, subagents: undefined, executionSignals: undefined },
    session.claims,
    {
      agentId: session.agentId,
      leaseAuthorizer: session.leaseAuthorizer,
      aegisModules: session.effective,
      observeKey: session.observeKey,
      onToolCall: session.onToolCall,
      publicOrigin: opts.publicOrigin,
      elicitApproval,
    },
  )

  const catalogSources = collected.filter(t => t.name !== 'delegate_task')
  if (!opts.catalog.hasSynced() || opts.catalog.size < catalogSources.length) {
    opts.catalog.syncTools(catalogSources)
  }

  const toolMap = new Map<string, CollectedTool>(catalogSources.map(t => [t.name, t]))
  const scopeChallenge: { requiredScope?: string; toolName?: string } = {}

  const isCatalogEntryAuthorized = (entry: CatalogEntry): boolean => {
    if (!isToolVisibleByOrgAndRbac(session, entry.tool_name)) return false
    return moduleGrantAllows(entry.tool_name, session.effective)
  }

  const invokeWithGuard = async (tool: CollectedTool, rawArgs: Record<string, unknown>, extra: unknown) => {
    const auth = checkToolAuthorization(session, tool.name)
    if (!auth.ok) {
      if (auth.kind === 'org_blocked') {
        return hubErrorText(
          'module_not_allowed_by_org',
          `所在机构未对外部智能体开放模块 ${auth.module}；请由机构管理员在机构设置中开启`,
          { module: auth.module },
        )
      }
      if (auth.kind === 'rbac_denied') {
        return hubErrorText('forbidden', `当前账户角色不允许使用工具 ${tool.name}`)
      }
      scopeChallenge.requiredScope = auth.requiredScope
      scopeChallenge.toolName = tool.name
      return hubErrorText(
        'insufficient_scope',
        `调用 ${tool.name} 需要模块权限 ${auth.requiredScope}`,
        { required_scope: auth.requiredScope, tool_name: tool.name },
      )
    }

    let validatedArgs: Record<string, unknown> = rawArgs
    if (tool.inputSchema && Object.keys(tool.inputSchema).length > 0) {
      const parsed = z.object(tool.inputSchema).safeParse(rawArgs)
      if (!parsed.success) {
        return hubErrorText('invalid_arguments', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
      }
      validatedArgs = parsed.data as Record<string, unknown>
    }
    return tool.handler(validatedArgs, extra)
  }

  // 1. Progressive Meta Tools
  server.registerTool(
    'hub_search_tools',
    {
      title: 'Search Heurion MCP Hub Tools',
      description: '按关键词或自然语言检索 Heurion MCP 全部内置工具（写作、文献、数据分析、患者、影像、临床研究、资料库、记忆、管理及工作区文件），返回受机构政策与授权过滤后的紧凑列表。',
      inputSchema: {
        query: z.string().describe('检索关键词或自然语言需求（如 survival、table1、dicom、recist、doc_edit）'),
        module: z.enum(CATALOG_MODULES).optional().describe('可选限定模块（如 writing、literature、analysis、patients、imaging、research、knowledge、memory、admin、workspace）'),
        limit: z.number().int().min(1).max(30).optional().describe('返回条数上限（默认 8）'),
        include_unscoped: z.boolean().optional().describe('是否包含当前令牌尚未授权但机构已开放的工具（用于发现需追加授权的能力）'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      const includeUnscoped = Boolean(args.include_unscoped)
      const hits = await opts.catalog.search({
        query: String(args.query ?? ''),
        module: args.module as CatalogModule | undefined,
        limit: args.limit ?? 8,
        embedder: opts.embedder ?? null,
        filter: entry => {
          if (!isToolVisibleByOrgAndRbac(session, entry.tool_name)) return false
          return includeUnscoped ? true : moduleGrantAllows(entry.tool_name, session.effective)
        },
      })
      return hubJsonText({
        total_returned: hits.length,
        tools: hits.map(e => ({
          name: e.tool_name,
          module: e.module,
          summary: e.summary,
          required_scope: e.required_scope,
          risk_tier: e.risk_tier,
          authorized: isCatalogEntryAuthorized(e),
        })),
      })
    },
  )

  server.registerTool(
    'hub_describe_tool',
    {
      title: 'Describe MCP Tool Input Schema',
      description: '按工具名获取完整说明文档、所需模块权限、风险等级及精确 JSON Schema 参数定义，然后通过 hub_call_tool 执行。',
      inputSchema: {
        tool_name: z.string().min(1).describe('目标内置工具名（由 hub_search_tools 返回）'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ tool_name }) => {
      const entry = opts.catalog.describe(tool_name)
      if (!entry || !isToolVisibleByOrgAndRbac(session, entry.tool_name)) {
        return hubErrorText('tool_not_found', `未找到工具 ${tool_name} 或当前机构/账户无权访问`)
      }
      const cls = classifyCatalogTool(entry.tool_name)
      return hubJsonText({
        tool_name: entry.tool_name,
        module: cls.module,
        description: entry.description,
        required_scope: entry.required_scope,
        risk_tier: entry.risk_tier,
        authorized: isCatalogEntryAuthorized(entry),
        input_schema: entry.input_schema,
      })
    },
  )

  server.registerTool(
    'hub_call_tool',
    {
      title: 'Invoke Discovered MCP Tool',
      description: '执行通过 hub_search_tools 与 hub_describe_tool 按需发现的任意已授权 Heurion MCP 工具（校验 Zod 参数、机构策略与模块权限）。',
      inputSchema: {
        tool_name: z.string().min(1).describe('目标工具名'),
        arguments: z.record(z.string(), z.unknown()).optional().describe('传给目标工具的 JSON 参数对象'),
      },
    },
    async ({ tool_name, arguments: toolArgs }, extra) => {
      const tool = toolMap.get(tool_name)
      if (!tool) {
        return hubErrorText('tool_not_found', `未找到工具 ${tool_name}`)
      }
      return invokeWithGuard(tool, (toolArgs ?? {}) as Record<string, unknown>, extra)
    },
  )

  // 2. Eager Core（仅注册当前用户/机构/令牌均已授权的高频核心工具）
  for (const eagerName of EAGER_CORE_TOOLS) {
    const tool = toolMap.get(eagerName)
    if (!tool) continue
    if (!isToolVisibleByOrgAndRbac(session, tool.name)) continue
    if (!moduleGrantAllows(tool.name, session.effective)) continue
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args, extra) => invokeWithGuard(tool, (args ?? {}) as Record<string, unknown>, extra),
    )
  }

  return { server, scopeChallenge, session }
}

/** Web Standard Streamable HTTP 渐进式网关处理器（挂载于 `/api/mcp/hub` 与 `/api/aegis/mcp/hub`） */
export async function handleHubMcpRequest(
  deps: McpDeps,
  req: Request,
  opts: HubGatewayOptions,
): Promise<Response> {
  const prep = prepareExternalMcpSession(deps, {
    authHeader: req.headers.get('authorization') ?? '',
    agentId: req.headers.get('x-aegis-agent-id') ?? req.headers.get('x-agent-id'),
    orgId: req.headers.get('x-aegis-org-id'),
    turnIdHeader: req.headers.get('x-aegis-turn-id'),
    sessionIdHeader: req.headers.get('x-aegis-session-id'),
    leaseTokenHeader: req.headers.get('x-aegis-lease-token'),
  })
  if (!prep.ok) {
    return new Response(JSON.stringify({ error: prep.error, code: prep.code }), {
      status: prep.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  const { session } = prep

  let rawBytes: Uint8Array = new Uint8Array(0)
  if (req.method === 'POST') {
    const bounded = await readBoundedBody(req, MAX_AUTH_MCP_BODY_BYTES)
    if (!bounded.ok) return bounded.response
    rawBytes = bounded.bytes
  }
  const reqUrl = new URL(req.url)
  const reqPath = reqUrl.pathname
  const origin = (opts.publicOrigin || reqUrl.origin).replace(/\/+$/, '')

  if (req.method === 'POST' && rawBytes.byteLength > 0) {
    let parsed: unknown = null
    try { parsed = JSON.parse(new TextDecoder('utf-8').decode(rawBytes)) } catch {}
    const messages = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' ? [parsed] : [])
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue
      const rpc = msg as { method?: unknown; params?: unknown }
      if (rpc.method !== 'tools/call' || !rpc.params || typeof rpc.params !== 'object') continue
      const p = rpc.params as { name?: unknown; arguments?: Record<string, unknown> }
      const invokedName = typeof p.name === 'string' ? p.name : ''
      const targetName = invokedName === 'hub_call_tool'
        ? (typeof p.arguments?.tool_name === 'string' ? p.arguments.tool_name : '')
        : invokedName
      if (targetName && !META_TOOL_NAMES.has(targetName) && (SHARED_TOOLS.has(targetName) || moduleOf(targetName) !== null)) {
        const auth = checkToolAuthorization(session, targetName)
        if (!auth.ok && auth.kind === 'org_blocked') {
          return new Response(JSON.stringify({
            error: `所在机构没有允许外部智能体使用模块 ${auth.module}；需要机构管理员在机构设置里开启`,
            code: 'module_not_allowed_by_org',
            module: auth.module,
          }), {
            status: 403,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'x-aegis-turn-id': session.turnId,
            },
          })
        }
        if (!auth.ok && auth.kind === 'insufficient_scope') {
          return new Response(JSON.stringify({
            error: `该授权没有开放 ${auth.requiredScope} 权限；请重新授权所需模块`,
            code: 'insufficient_scope',
            required_scope: auth.requiredScope,
            tool: targetName,
          }), {
            status: 403,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'www-authenticate': `Bearer error="insufficient_scope", scope="${auth.requiredScope}", resource_metadata="${origin}/.well-known/oauth-protected-resource${reqPath}"`,
              'x-aegis-turn-id': session.turnId,
            },
          })
        }
      }
    }
  }

  const accept = req.headers.get('accept') ?? ''
  const contentType = req.headers.get('content-type') ?? ''
  const headers = new Headers(req.headers)
  if (req.method === 'POST' && (!(accept.includes('application/json') && accept.includes('text/event-stream')) || !contentType.includes('application/json'))) {
    headers.set('accept', 'application/json, text/event-stream')
    headers.set('content-type', 'application/json')
  }
  const body = req.method === 'POST' ? toRequestBody(rawBytes) : undefined
  const normalizedReq = new Request(req.url, { method: req.method, headers, ...(body !== undefined ? { body } : {}) })

  const built = buildHubMcpServer(deps, session, opts)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_AUTH_MCP_BODY_BYTES,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await built.server.connect(transport)
    const timeout = new Promise<Response>(resolve => {
      timer = setTimeout(() => resolve(new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: `请求超过 ${HUB_TIMEOUT_MS / 1000} 秒未完成` } }),
        { status: 504, headers: { 'content-type': 'application/json; charset=utf-8' } },
      )), HUB_TIMEOUT_MS)
    })
    const res = await Promise.race([transport.handleRequest(normalizedReq), timeout])
    if (built.scopeChallenge.requiredScope) {
      return new Response(JSON.stringify({
        error: `该授权没有开放 ${built.scopeChallenge.requiredScope} 权限`,
        code: 'insufficient_scope',
        required_scope: built.scopeChallenge.requiredScope,
        tool: built.scopeChallenge.toolName,
      }), {
        status: 403,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'www-authenticate': `Bearer error="insufficient_scope", scope="${built.scopeChallenge.requiredScope}", resource_metadata="${origin}/.well-known/oauth-protected-resource${reqPath}"`,
          'x-aegis-turn-id': session.turnId,
        },
      })
    }
    const outHeaders = new Headers(res.headers)
    outHeaders.set('x-aegis-turn-id', session.turnId)
    return new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers: outHeaders })
  } finally {
    clearTimeout(timer)
    await transport.close()
    await built.server.close()
  }
}
