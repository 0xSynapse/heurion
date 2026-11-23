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
import { MAX_AUTH_MCP_BODY_BYTES, readBoundedBody, toRequestBody } from '../mcp/bounded-body.ts'
import { externalInstructions } from '../mcp/instructions.ts'
import {
  missingScopesForTool,
  moduleGrantAllows,
  SHARED_TOOLS,
  toolModuleRequirements,
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
  const reqs = toolModuleRequirements(toolName)
  return reqs.length > 0 && reqs.every(r => r.module === 'writing' || r.module === 'literature')
}

export function verticalInstructions(vertical: VerticalMcpId, grantedModules: readonly ModuleId[]): string {
  if (vertical === 'writing-studio') {
    const header =
      'Heurion Scientific Writing & Slides Studio MCP（学术写作与幻灯片垂直工作台）。' +
      '整合论文写作/幻灯片制作（`doc_*`、`deck_*`、`doc_import_docx`、`doc_export_docx`）与文献引用闭环' +
      '（`pubmed_search` / `doi_lookup` -> `insert_citation` -> `doc_edit`）。\n\n'
    return `${header}${externalInstructions(grantedModules)}`
  }
  return [
    'Heurion Clinical Deep Review MCP（四阶段临床深度审稿垂直服务）。',
    '和用户沟通一律用简体中文：过程说明、审稿报告、反驳回复建议均使用中文（统计符号、工具参数名照常）。',
    '',
    '推荐审稿工作流（仅使用本垂直端点的 22 个聚焦工具）：',
    '1) 外部 Markdown 可直接调 `deep_review_audit_markdown`（零大模型消耗、免建文档，支持 `use_memory` 应用用户反驳规则）；',
    '2) 已有 `.docx` 原稿可用 `workspace_put`（或 `data_base64`）传给 `doc_import_docx` 建稿后调 `deep_review_audit`（确定性 AST 表文算术、方法-结果配对、Spin Bias 与 CONSORT/STROBE 审计），或 `doc_list` / `doc_outline` / `doc_read` 阅读已有文稿；',
    '3) 需要完整四阶段大模型深审与批注锚定时调 `deep_review_start` -> 轮询 `deep_review_status`（需同时具备 `writing:rw` 与 `literature:rw` 及文稿写权限）；',
    '4) 结合 `pubmed_search` / `openalex_search` / `oa_fulltext` / `doi_lookup` 与 `verify_claims` -> `claim_report` 完成引文核对，并通过 `comments_list` / `comment_add` / `comment_reply` / `comment_resolve` 管理批注（医生批注反驳会沉淀为后续审稿边界规则）；',
    '5) 文件进出通过 `workspace_put` / `workspace_get` / `workspace_list`（大于 10MB 走 `/api/mcp/files/<path>`），回复用户时请用自然语言指明章节位置，勿暴露内部 id。',
  ].join('\n')
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
      const reqs = toolModuleRequirements(tool.name)
      if (!reqs.length || !reqs.every(r => session.orgAllowed.has(r.module))) continue
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

  let rawBytes: Uint8Array = new Uint8Array(0)
  if (req.method === 'POST') {
    const bounded = await readBoundedBody(req, MAX_AUTH_MCP_BODY_BYTES)
    if (!bounded.ok) return bounded.response
    rawBytes = bounded.bytes
  }
  const reqUrl = new URL(req.url)
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
      const targetName = typeof (rpc.params as { name?: unknown }).name === 'string'
        ? (rpc.params as { name: string }).name
        : ''
      if (!targetName || !isToolInVertical(vertical, targetName)) continue
      if (!SHARED_TOOLS.has(targetName)) {
        const reqs = toolModuleRequirements(targetName)
        const disallowed = reqs.find(r => !session.orgAllowed.has(r.module))
        if (reqs.length === 0 || disallowed) {
          const mod = disallowed?.module ?? 'admin'
          return new Response(JSON.stringify({
            error: `所在机构未对外部智能体开放模块 ${mod}；请由机构管理员开启`,
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
      }
      if (!moduleGrantAllows(targetName, session.effective)) {
        const missing = missingScopesForTool(targetName, session.effective)
        const scope = missing.join(' ') || VERTICAL_REQUIRED_SCOPE[vertical]
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

  const accept = req.headers.get('accept') ?? ''
  const contentType = req.headers.get('content-type') ?? ''
  const headers = new Headers(req.headers)
  if (req.method === 'POST' && (!(accept.includes('application/json') && accept.includes('text/event-stream')) || !contentType.includes('application/json'))) {
    headers.set('accept', 'application/json, text/event-stream')
    headers.set('content-type', 'application/json')
  }
  const body = req.method === 'POST' ? toRequestBody(rawBytes) : undefined
  const normalizedReq = new Request(req.url, { method: req.method, headers, ...(body !== undefined ? { body } : {}) })

  const server = buildVerticalMcpServer(deps, session, vertical, opts)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_AUTH_MCP_BODY_BYTES,
  })
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
