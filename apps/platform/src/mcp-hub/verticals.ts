/**
 * 垂直专业场景 MCP 网关：`writing-studio`（科学写作与幻灯片）与 `deep-review`（四阶段临床深度审稿）。
 *
 * 复用 `McpDeps`、`prepareExternalMcpSession`、`moduleGrantAllows` 与 `orgAllowedModules`：
 * - `POST /api/mcp/writing-studio`（兼容 `/api/aegis/mcp/writing-studio`）：聚合 `writing` + `literature`
 *   （检索→登记引用→写前守卫→Yjs 编辑→`.docx` 导入导出→幻灯片→批注→CoW 回滚），排除重型深度审稿编排工具。
 * - `POST /api/mcp/deep-review`（兼容 `/api/aegis/mcp/deep-review`）：仅暴露 22 个聚焦审稿的工具
 *   （零 LLM AST 审计、异步四阶段深审、PubMed/Crossref 论断核查、`.docx` 导入、只读阅稿与批注反驳进化）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AdminToolDeps } from '../mcp/admin-tools.ts'
import { externalInstructions } from '../mcp/instructions.ts'
import {
  moduleGrantAllows,
  moduleOf,
  READ_ONLY_TOOLS,
  SHARED_TOOLS,
  type ModuleId,
} from '../mcp/modules.ts'
import {
  collectExternalTools,
  makeUrlElicitationHandler,
  prepareExternalMcpSession,
  type McpDeps,
  type PreparedExternalSession,
} from '../mcp/server.ts'

export type VerticalMcpId = 'writing-studio' | 'deep-review'

export const VERTICAL_MCP_IDS: readonly VerticalMcpId[] = ['writing-studio', 'deep-review']

export const VERTICAL_REQUIRED_SCOPE: Record<VerticalMcpId, string> = {
  'writing-studio': 'writing:rw literature:rw',
  'deep-review': 'writing:rw literature:rw',
}

const VERTICAL_TIMEOUT_MS = 300_000
const VERTICAL_SOURCE_MODULES: readonly ModuleId[] = ['writing', 'literature']

const WRITING_STUDIO_EXCLUDED = new Set([
  'deep_review_start',
  'deep_review_status',
  'deep_review_audit',
  'deep_review_audit_markdown',
])

export const DEEP_REVIEW_VERTICAL_TOOLS: ReadonlySet<string> = new Set([
  'deep_review_audit_markdown',
  'deep_review_audit',
  'deep_review_start',
  'deep_review_status',
  'verify_claims',
  'claim_report',
  'pubmed_search',
  'openalex_search',
  'oa_fulltext',
  'doi_lookup',
  'doc_list',
  'docs_search',
  'doc_outline',
  'doc_read',
  'doc_import_docx',
  'comments_list',
  'comment_add',
  'comment_reply',
  'comment_resolve',
  'workspace_put',
  'workspace_get',
  'workspace_list',
])

export function isToolInVertical(vertical: VerticalMcpId, toolName: string): boolean {
  if (toolName === 'delegate_task') return false
  if (vertical === 'deep-review') return DEEP_REVIEW_VERTICAL_TOOLS.has(toolName)
  if (WRITING_STUDIO_EXCLUDED.has(toolName)) return false
  if (SHARED_TOOLS.has(toolName)) return true
  const mod = moduleOf(toolName)
  return mod === 'writing' || mod === 'literature'
}

export function verticalInstructions(vertical: VerticalMcpId, grantedModules: readonly ModuleId[]): string {
  const header = vertical === 'writing-studio'
    ? 'Heurion Scientific Writing & Slides Studio MCP（学术写作与幻灯片垂直工作台）。' +
      '整合论文写作/幻灯片制作（`doc_*`、`deck_*`、`doc_import_docx`、`doc_export_docx`）与文献引用闭环' +
      '（`pubmed_search` / `doi_lookup` -> `insert_citation` -> `doc_edit`）。\n\n'
    : 'Heurion Clinical Deep Review MCP（四阶段临床深度审稿垂直服务）。\n' +
      '推荐审稿流程：1) 外部 Markdown 可直接调 `deep_review_audit_markdown`（零模型消耗、免建文档）；' +
      '2) 已有 `.docx` 可先 `doc_import_docx` 后调 `deep_review_audit`（确定性 AST 表文算术与方法-结果审计）；' +
      '3) 需要完整四阶段大模型深审与批注锚定时调 `deep_review_start` -> 轮询 `deep_review_status`；' +
      '4) 结合 `verify_claims` / `claim_report` 与 `comment_*`（用户批注反驳将沉淀为规则记忆）。\n\n'
  return `${header}${externalInstructions(grantedModules)}`
}

export function buildVerticalMcpServer(
  deps: McpDeps,
  session: PreparedExternalSession,
  vertical: VerticalMcpId,
  opts: { publicOrigin?: string; elicitApproval?: AdminToolDeps['elicitApproval'] } = {},
): McpServer {
  const serverInfo = vertical === 'writing-studio'
    ? { name: 'heurion-writing', version: '1.0.0' }
    : { name: 'heurion-deep-review', version: '1.0.0' }
  const grantedModules = VERTICAL_SOURCE_MODULES.filter(m => session.effective[m])
  const server = new McpServer(serverInfo, {
    instructions: verticalInstructions(vertical, grantedModules),
  })

  const elicitApproval = opts.elicitApproval ?? makeUrlElicitationHandler(server)
  const collected = collectExternalTools(
    { ...deps, subagents: undefined, executionSignals: undefined },
    session.claims,
    {
      agentId: session.agentId,
      leaseAuthorizer: session.leaseAuthorizer,
      aegisModules: session.effective,
      modules: [...VERTICAL_SOURCE_MODULES],
      observeKey: session.observeKey,
      onToolCall: session.onToolCall,
      publicOrigin: opts.publicOrigin,
      elicitApproval,
    },
  )

  for (const tool of collected) {
    if (!isToolInVertical(vertical, tool.name)) continue
    if (!SHARED_TOOLS.has(tool.name)) {
      const mod = moduleOf(tool.name)
      if (!mod || !session.orgAllowed.has(mod)) continue
    }
    if (!moduleGrantAllows(tool.name, session.effective)) continue
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args, extra) => tool.handler((args ?? {}) as Record<string, unknown>, extra),
    )
  }

  return server
}

function requiredScopeForTool(toolName: string): string {
  const perm = READ_ONLY_TOOLS.has(toolName) ? 'r' : 'rw'
  const mod = SHARED_TOOLS.has(toolName) ? 'writing' : (moduleOf(toolName) ?? 'writing')
  return `${mod}:${perm}`
}

/** 垂直 MCP Streamable HTTP 请求处理（`writing-studio` / `deep-review`） */
export async function handleVerticalMcpRequest(
  deps: McpDeps,
  req: Request,
  vertical: VerticalMcpId,
  opts: { publicOrigin?: string; elicitApproval?: AdminToolDeps['elicitApproval'] } = {},
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

  if (!VERTICAL_SOURCE_MODULES.some(m => Boolean(session.effective[m]))) {
    const allBlocked = VERTICAL_SOURCE_MODULES.every(m => session.blocked.includes(m))
    return new Response(JSON.stringify({
      error: allBlocked
        ? '所在机构没有允许外部智能体使用 writing / literature 模块；需要机构管理员在机构设置里开启'
        : `该授权没有开放所需模块（${VERTICAL_REQUIRED_SCOPE[vertical]}）；请在 Heurion 设置页重新授权`,
      code: allBlocked ? 'module_not_allowed_by_org' : 'module_not_granted',
    }), {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  const rawBytes = await req.arrayBuffer()
  const reqUrl = new URL(req.url)
  const origin = (opts.publicOrigin || reqUrl.origin).replace(/\/+$/, '')

  if (req.method === 'POST' && rawBytes.byteLength > 0) {
    let parsed: { method?: unknown; params?: unknown } | null = null
    try { parsed = JSON.parse(new TextDecoder('utf-8').decode(rawBytes)) as { method?: unknown; params?: unknown } } catch {}
    if (parsed && parsed.method === 'tools/call' && parsed.params && typeof parsed.params === 'object') {
      const targetName = typeof (parsed.params as { name?: unknown }).name === 'string'
        ? (parsed.params as { name: string }).name
        : ''
      if (targetName && isToolInVertical(vertical, targetName)) {
        const mod = moduleOf(targetName)
        if (!SHARED_TOOLS.has(targetName) && (!mod || !session.orgAllowed.has(mod))) {
          return new Response(JSON.stringify({
            error: `所在机构未对外部智能体开放模块 ${mod ?? 'admin'}；请由机构管理员开启`,
            code: 'module_not_allowed_by_org',
            module: mod,
          }), {
            status: 403,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'x-aegis-turn-id': session.turnId,
            },
          })
        }
        if (!moduleGrantAllows(targetName, session.effective)) {
          const scope = requiredScopeForTool(targetName)
          return new Response(JSON.stringify({
            error: `调用 ${targetName} 需要权限 ${scope}；请追加授权后重试`,
            code: 'insufficient_scope',
            required_scope: scope,
            tool: targetName,
          }), {
            status: 403,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${origin}/.well-known/oauth-protected-resource${reqUrl.pathname}"`,
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
  const normalizedReq = new Request(req.url, { method: req.method, headers, body: rawBytes.byteLength > 0 ? rawBytes : undefined })

  const server = buildVerticalMcpServer(deps, session, vertical, opts)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await server.connect(transport)
    const timeout = new Promise<Response>(resolve => {
      timer = setTimeout(() => resolve(new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: `请求超过 ${VERTICAL_TIMEOUT_MS / 1000} 秒未完成` } }),
        { status: 504, headers: { 'content-type': 'application/json; charset=utf-8' } },
      )), VERTICAL_TIMEOUT_MS)
    })
    const res = await Promise.race([transport.handleRequest(normalizedReq), timeout])
    const outHeaders = new Headers(res.headers)
    outHeaders.set('x-aegis-turn-id', session.turnId)
    return new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers: outHeaders })
  } finally {
    clearTimeout(timer)
    await transport.close()
    await server.close()
  }
}
