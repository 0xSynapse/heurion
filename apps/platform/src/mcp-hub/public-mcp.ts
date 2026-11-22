import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import {
  MAX_PUBLIC_AUDIT_MARKDOWN_CHARS,
  runDeterministicDeepReviewOnMarkdown,
} from '../claims/markdown-audit.ts'
import {
  checkPublicRateLimit,
  recordToolInvocation,
  runConsortTool,
  runEValueTool,
  runForestPlotTool,
  runKaplanMeierTool,
  runPhiScanTool,
  runTable1Tool,
  verifyManuscriptCitations,
  type PublicToolsDeps,
} from '../http/routes/public-tools-api.ts'

/**
 * Phase 0：零鉴权无状态公共临床科研 MCP 服务（挂载于 `POST /api/public/mcp` 与 `POST /api/public/deep-review/mcp`）
 * 对齐 Official MCP Registry 条目 `org.heurion/clinical-research-tools` 与零成本 Deep Review AST 试用入口。
 * 安全边界：不读写 SQLite 数据库、不触发服务端大模型、不触及用户工作区 / PHI 存储。
 */

const PUBLIC_MCP_TIMEOUT_MS = 30_000

const PUBLIC_INSTRUCTIONS =
  'Heurion Public Clinical Research Tools (Zero-Auth Stateless MCP). ' +
  'Provides 8 deterministic clinical biostatistics, diagram, PHI de-identification, Deep Review AST audit, and PubMed citation-verification engines without database state or user credentials.'

const PUBLIC_DEEP_REVIEW_INSTRUCTIONS =
  'Heurion Deep Review — Zero-Auth Deterministic AST & PubMed Verification Trial MCP. ' +
  'Performs zero-LLM structural manuscript auditing (Table-Text arithmetic, statistical method-result consistency, Spin bias, CONSORT/STROBE checks) and PubMed/Crossref effect-size verification. ' +
  'For persistent 4-stage LLM review with anchored Word comments and physician rebuttal memory, connect via OAuth 2.1 to https://heurion.org/api/mcp/deep-review.'

function jsonTextResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

function errorTextResult(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }] }
}

export interface PublicMcpServerOptions {
  clientIp?: string
}

export function buildPublicMcpServer(deps: PublicToolsDeps = {}, opts: PublicMcpServerOptions = {}): McpServer {
  const clientIp = opts.clientIp || 'local'
  const server = new McpServer(
    { name: 'heurion-clinical-research-tools', version: '2.0.0' },
    { instructions: PUBLIC_INSTRUCTIONS },
  )

  server.registerTool(
    'public_e_value_calculate',
    {
      title: 'VanderWeele E-value Sensitivity Analysis',
      description: '计算观察性研究的 VanderWeele E-value，生成偏倚阈值 SVG 曲线及中英文审稿人回复模板。',
      inputSchema: {
        effect_type: z.enum(['RR', 'OR', 'HR']).describe('效应量类型：RR、OR 或 HR'),
        estimate: z.number().positive().describe('效应量点估计值'),
        ci_lower: z.number().positive().optional().describe('95% 置信区间下限'),
        ci_upper: z.number().positive().optional().describe('95% 置信区间上限'),
        rare_outcome: z.boolean().optional().describe('当使用 OR/HR 时，是否满足罕见结局假设（<15%），默认 true'),
        lang: z.enum(['zh', 'en']).optional().describe('输出语言：zh（默认）或 en'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      recordToolInvocation('e-value-calculator')
      try {
        const input: Parameters<typeof runEValueTool>[0] = {
          effect_type: args.effect_type,
          estimate: args.estimate,
          ci_lower: args.ci_lower ?? args.estimate,
          ci_upper: args.ci_upper ?? args.estimate,
        }
        if (args.rare_outcome !== undefined) input.rare_outcome = args.rare_outcome
        if (args.lang !== undefined) input.lang = args.lang
        return jsonTextResult(runEValueTool(input))
      } catch (err) {
        return errorTextResult((err as Error).message)
      }
    },
  )

  server.registerTool(
    'public_consort_diagram',
    {
      title: 'CONSORT 2010 / STROBE Flow Diagram Generator',
      description: '依据筛选、排除与随机分组数字生成标准 CONSORT 2010 / STROBE 受试者流向图（SVG 与 Mermaid 代码），并执行算术一致性校验。',
      inputSchema: {
        title: z.string().max(120).optional().describe('流程图标题'),
        lang: z.enum(['zh', 'en']).optional().describe('图形标签语言'),
        total_assessed: z.number().min(0).describe('初筛评估总人数'),
        exclusions: z.array(z.object({
          reason: z.string().describe('排除原因'),
          count: z.number().min(0).describe('排除例数'),
        })).optional().describe('排除原因明细数组'),
        eligible_total: z.number().min(0).optional().describe('合格入组总人数（缺省自动按 初筛-排除 计算）'),
        arms: z.array(z.object({
          name: z.string().describe('研究组/队列名称'),
          allocated: z.number().min(0).describe('分配入组人数'),
          lost_to_followup: z.number().min(0).optional().describe('失访人数'),
          discontinued: z.number().min(0).optional().describe('中止干预人数'),
          analyzed: z.number().min(0).describe('纳入最终分析人数'),
        })).optional().describe('研究分组数组（最多 4 组）'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      recordToolInvocation('consort-strobe-flowchart')
      try {
        const exclusions = args.exclusions ?? []
        const totalExcluded = exclusions.reduce((s, e) => s + Math.max(0, e.count), 0)
        const input: Parameters<typeof runConsortTool>[0] = {
          total_assessed: args.total_assessed,
          exclusions,
          eligible_total: args.eligible_total ?? Math.max(0, args.total_assessed - totalExcluded),
          arms: (args.arms ?? []).map(a => ({
            name: a.name,
            allocated: a.allocated,
            lost_to_followup: a.lost_to_followup ?? 0,
            discontinued: a.discontinued ?? 0,
            analyzed: a.analyzed,
          })),
        }
        if (args.title !== undefined) input.title = args.title
        if (args.lang !== undefined) input.lang = args.lang
        return jsonTextResult(runConsortTool(input))
      } catch (err) {
        return errorTextResult((err as Error).message)
      }
    },
  )

  server.registerTool(
    'public_table1_generate',
    {
      title: 'Baseline Table 1 Generator',
      description: '从临床表格数据（CSV 文本或 JSON 记录）生成医学期刊标准 Table 1 基线特征三线表，自动执行统计检验、SMD 计算与 PHI 隐私预扫。',
      inputSchema: {
        csv: z.string().max(200_000).optional().describe('CSV 或 TSV 表格文本（≤500 行，与 records 二选一）'),
        records: z.array(z.record(z.string(), z.unknown())).max(500).optional().describe('结构化对象行数组'),
        options: z.object({
          group_col: z.string().optional().describe('分组列名（如 group / arm）'),
          strata: z.array(z.string()).optional(),
          nonnormal_cols: z.array(z.string()).optional().describe('指定按偏态/中位数 IQR 汇总的列名'),
          decimals: z.number().int().min(0).max(4).optional(),
        }).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      recordToolInvocation('table-1-generator')
      try {
        return jsonTextResult(runTable1Tool({
          csv: args.csv,
          records: args.records,
          options: args.options as Parameters<typeof runTable1Tool>[0]['options'],
        }))
      } catch (err) {
        return errorTextResult((err as Error).message)
      }
    },
  )

  server.registerTool(
    'public_kaplan_meier_survival',
    {
      title: 'Kaplan-Meier Survival & Cox Regression',
      description: '计算 Kaplan-Meier 生存曲线、Number at Risk 风险表、Log-rank 检验与单因素 Cox 回归，输出发表级 SVG、中英文结果描述与可复现 R 脚本。',
      inputSchema: {
        csv: z.string().max(200_000).optional().describe('包含时间、结局事件与可选分组列的 CSV/TSV 文本'),
        records: z.array(z.record(z.string(), z.unknown())).max(500).optional().describe('结构化随访记录数组'),
        time_col: z.string().optional().describe('生存时间列名'),
        event_col: z.string().optional().describe('事件状态列名（1=事件发生，0=删失）'),
        group_col: z.string().optional().describe('分组列名'),
        time_unit: z.string().max(24).optional().describe('时间单位（默认 Months）'),
        title: z.string().max(120).optional().describe('图表标题'),
        lang: z.enum(['zh', 'en']).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      recordToolInvocation('kaplan-meier-survival')
      try {
        return jsonTextResult(runKaplanMeierTool(args))
      } catch (err) {
        return errorTextResult((err as Error).message)
      }
    },
  )

  server.registerTool(
    'public_forest_plot_generate',
    {
      title: 'Subgroup & Meta-Analysis Forest Plot Generator',
      description: '基于亚组/多因素回归效应量及 95% CI 生成顶刊标准森林图 SVG、文字总结及 forestploter R 脚本。',
      inputSchema: {
        title: z.string().max(120).optional(),
        effect_type: z.enum(['HR', 'OR', 'RR']).optional(),
        null_value: z.number().positive().optional(),
        left_label: z.string().max(45).optional(),
        right_label: z.string().max(45).optional(),
        raw_lines: z.string().optional().describe('按行文本格式：Subgroup | Estimate | CI_Lower | CI_Upper | P_value'),
        rows: z.array(z.object({
          label: z.string(),
          estimate: z.number(),
          ci_lower: z.number(),
          ci_upper: z.number(),
          p_value: z.string().optional(),
          events_text: z.string().optional(),
          weight: z.number().optional(),
          is_summary: z.boolean().optional(),
          is_header: z.boolean().optional(),
        })).optional(),
        lang: z.enum(['zh', 'en']).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      recordToolInvocation('forest-plot-generator')
      try {
        return jsonTextResult(runForestPlotTool(args))
      } catch (err) {
        return errorTextResult((err as Error).message)
      }
    },
  )

  server.registerTool(
    'public_phi_scan',
    {
      title: 'HIPAA Safe Harbor & PIPL PHI Scanner',
      description: '对临床病历、病例报告草稿执行确定性 PHI 敏感隐私识别（身份证 MOD 11-2、手机号、Luhn 银行卡、MRN、Email、SSN、患者姓名）并生成脱敏文本。',
      inputSchema: {
        text: z.string().min(1).max(50_000).describe('待扫描脱敏的临床文本或病例报告段落'),
        lang: z.enum(['zh', 'en']).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      recordToolInvocation('phi-deidentifier')
      try {
        return jsonTextResult(runPhiScanTool(args))
      } catch (err) {
        return errorTextResult((err as Error).message)
      }
    },
  )

  registerPublicDeepReviewAuditTool(server, clientIp)
  registerPublicPubmedCitationTool(server, deps, clientIp)
  return server
}

function registerPublicDeepReviewAuditTool(server: McpServer, clientIp: string): void {
  server.registerTool(
    'public_deep_review_audit',
    {
      title: 'Deterministic Deep Review AST Auditor (Zero LLM Cost)',
      description: '零大模型消耗的临床论文审稿审计：解析 Markdown 为文档 AST 与 TableSummary，自动发现摘要–正文–表格算术矛盾、方法–结果统计不一致、Spin Bias 夸大及 CONSORT/STROBE 规范缺口。单 IP 每分钟限 20 次。',
      inputSchema: {
        markdown: z.string().min(20).max(MAX_PUBLIC_AUDIT_MARKDOWN_CHARS).describe('待审计的临床研究论文 Markdown 原文（支持 GFM 表格）'),
        title: z.string().max(200).optional().describe('可选文稿标题'),
        include_scratchpad: z.boolean().optional().describe('是否返回跨章节共享结构化草稿板（样本量、研究设计、统计检验与缩写汇总），默认 true'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      if (!checkPublicRateLimit(clientIp, 'public_mcp_deep_review', 20)) {
        return errorTextResult('Deep Review AST 试用请求过于频繁（单 IP 每分钟限 20 次），请稍后再试 / Rate limit exceeded (20/min)')
      }
      recordToolInvocation('deep-review-ast-audit')
      try {
        return jsonTextResult(runDeterministicDeepReviewOnMarkdown(args.markdown, {
          title: args.title,
          activeRules: [],
          includeScratchpad: args.include_scratchpad !== false,
        }))
      } catch (err) {
        return errorTextResult((err as Error).message)
      }
    },
  )
}

function registerPublicPubmedCitationTool(server: McpServer, deps: PublicToolsDeps, clientIp: string): void {
  server.registerTool(
    'public_pubmed_citation_check',
    {
      title: 'PubMed Citation & Effect-Size Hallucination Checker',
      description: '从医学文稿或参考文献中提取 PMID / DOI，借助 PubMed / Crossref（含 24h 内存缓存）核验文献真实性及文内声称的 HR/OR/95% CI 数值一致性。单 IP 每分钟限 15 次。',
      inputSchema: {
        text: z.string().min(1).max(10_000).describe('包含 PMID / DOI 及效应量描述的论文段落或参考文献列表'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async args => {
      if (!checkPublicRateLimit(clientIp, 'public_mcp_citation', 15)) {
        return errorTextResult('PubMed 文献核验请求过于频繁（单 IP 每分钟限 15 次），请稍后再试 / Rate limit exceeded (15/min)')
      }
      recordToolInvocation('pubmed-citation-checker')
      try {
        const text = args.text.trim()
        if (!text) return errorTextResult('请输入需要核验的医学论文段落或参考文献列表')
        return jsonTextResult(await verifyManuscriptCitations(text, deps))
      } catch (err) {
        return errorTextResult((err as Error).message)
      }
    },
  )
}

function ipFromRequest(req: Request): string {
  const realIp = req.headers.get('x-real-ip')?.trim()
  if (realIp) return realIp
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return fwd || 'local'
}

async function servePublicMcpTransport(server: McpServer, req: Request): Promise<Response> {
  const accept = req.headers.get('accept') ?? ''
  const contentType = req.headers.get('content-type') ?? ''
  let request = req
  if (req.method === 'POST' && (!(accept.includes('application/json') && accept.includes('text/event-stream')) || !contentType.includes('application/json'))) {
    const headers = new Headers(req.headers)
    headers.set('accept', 'application/json, text/event-stream')
    headers.set('content-type', 'application/json')
    request = new Request(req.url, { method: req.method, headers, body: await req.arrayBuffer() })
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await server.connect(transport)
    const timeout = new Promise<Response>(resolve => {
      timer = setTimeout(() => resolve(new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: `请求超过 ${PUBLIC_MCP_TIMEOUT_MS / 1000} 秒未完成` } }),
        { status: 504, headers: { 'content-type': 'application/json; charset=utf-8' } },
      )), PUBLIC_MCP_TIMEOUT_MS)
    })
    const res = await Promise.race([transport.handleRequest(request), timeout])
    return new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers: res.headers })
  } finally {
    clearTimeout(timer)
    await transport.close()
    await server.close()
  }
}

export function buildPublicDeepReviewMcpServer(deps: PublicToolsDeps = {}, opts: PublicMcpServerOptions = {}): McpServer {
  const clientIp = opts.clientIp || 'local'
  const server = new McpServer(
    { name: 'heurion-deep-review-public', version: '1.0.0' },
    { instructions: PUBLIC_DEEP_REVIEW_INSTRUCTIONS },
  )
  registerPublicDeepReviewAuditTool(server, clientIp)
  registerPublicPubmedCitationTool(server, deps, clientIp)
  return server
}

/** Web Standard Streamable HTTP 处理器（挂载于 Hono `POST /api/public/mcp`） */
export async function handlePublicMcpRequest(
  deps: PublicToolsDeps,
  req: Request,
  clientIpOverride?: string,
): Promise<Response> {
  const ip = clientIpOverride || ipFromRequest(req)
  if (!checkPublicRateLimit(ip, 'public_mcp', 30)) {
    return new Response(
      JSON.stringify({ error: '请求过于频繁，请稍后再试 / Rate limit exceeded', code: 'rate_limited' }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': '60',
        },
      },
    )
  }

  const server = buildPublicMcpServer(deps, { clientIp: ip })
  return servePublicMcpTransport(server, req)
}

/** 零鉴权 Deep Review 确定性 AST 试用网关（挂载于 Hono `POST /api/public/deep-review/mcp`） */
export async function handlePublicDeepReviewMcpRequest(
  deps: PublicToolsDeps,
  req: Request,
  clientIpOverride?: string,
): Promise<Response> {
  const ip = clientIpOverride || ipFromRequest(req)
  if (!checkPublicRateLimit(ip, 'public_mcp_deep_review_endpoint', 30)) {
    return new Response(
      JSON.stringify({ error: '请求过于频繁，请稍后再试 / Rate limit exceeded', code: 'rate_limited' }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'retry-after': '60',
        },
      },
    )
  }

  const server = buildPublicDeepReviewMcpServer(deps, { clientIp: ip })
  return servePublicMcpTransport(server, req)
}
