/**
 * MCP 模块注册表（docs/design/MCP_MODULES.md §3.1–3.2，阶段 0）。
 *
 * 工作台的每个模块对应一组 MCP 工具：平台内的 dsh 回合挂全部模块（行为与拆分前一致），
 * 外部智能体（经 Aegis-OS）以后按模块挂载、按模块授权。每个工具恰好属于一个模块（tests/mcp-modules.test.ts 校验）。
 *
 * 归属规则：先看模块列出的工具名（names），再看前缀（prefixes）；名字优先，
 * 所以 dataset_manage、kb_manage 这类管理工具即使前缀像别的模块，也归管理模块。
 */

export type ModuleId = 'writing' | 'literature' | 'analysis' | 'patients' | 'imaging' | 'research' | 'knowledge' | 'memory' | 'admin'

/** 对外部智能体的默认开放方式（§3.5）：open 默认开放；org_opt_in 机构开启后才能授权；readonly_default 只读开放、写操作走租约。 */
export type ExternalPolicy = 'open' | 'org_opt_in' | 'readonly_default'

export interface HeurionModule {
  id: ModuleId
  title: string
  /** Aegis 一级目录里的一行说明。 */
  summary: string
  external: ExternalPolicy
  /** 按名字归入本模块的工具。 */
  names: readonly string[]
  /** 按前缀归入本模块的工具。 */
  prefixes: readonly string[]
  /** 需要租约的工具 → 租约作用域（外部智能体缺租约时返回 approval_required）。 */
  leaseGated: Readonly<Record<string, string>>
}

/** 有「需确认」操作的管理工具：外部智能体执行这些操作要租约，作用域 `heurion:<工具>.<动作>`（mcp/admin-tools.ts）。 */
const ADMIN_CONFIRM_TOOLS = [
  'account', 'tenant_admin', 'org_template', 'phr_share', 'platform_admin', 'doc_manage', 'comment_manage', 'dataset_manage',
  'kb_manage', 'memory_manage', 'patient_admin', 'study_admin',
] as const

export const MODULES: readonly HeurionModule[] = [
  {
    id: 'writing',
    title: '写作',
    summary: '论文与幻灯片的结构化读写、批注、插图与测量绑定（写入经操作层与写前守卫）',
    external: 'open',
    names: [
      'doc_list', 'docs_search', 'doc_create', 'doc_outline', 'doc_read', 'doc_search', 'doc_edit', 'doc_validate', 'doc_history', 'doc_diff', 'doc_revert_turn',
      'deck_templates', 'slide_read', 'deck_edit', 'layout_check', 'slide_render', 'image_search', 'slide_add_photo',
      'comments_list', 'comment_add', 'comment_reply', 'comment_resolve',
      'insert_measurement', 'list_measurements', 'asset_upload', 'diagram_render',
      'doc_import_docx', 'doc_export_docx',
    ],
    prefixes: [],
    leaseGated: {},
  },
  {
    id: 'literature',
    title: '文献',
    summary: '文献检索、开放全文、规范引用登记与论断核对',
    external: 'open',
    names: [
      'pubmed_search', 'openalex_search', 'oa_fulltext', 'doi_lookup', 'insert_citation', 'import_references', 'list_citations',
      'verify_claims', 'claim_report', 'deep_review_audit_markdown', 'deep_review_audit', 'deep_review_start', 'deep_review_status',
    ],
    prefixes: [],
    leaseGated: {},
  },
  {
    id: 'analysis',
    title: '数据分析',
    summary: '数据集描述与统计分析（Table 1、生存、回归等），分析结果登记后可绑定进稿件',
    external: 'org_opt_in',
    names: ['result_register', 'result_list'],
    prefixes: ['dataset_'],
    leaseGated: {},
  },
  {
    id: 'patients',
    title: '患者与知家',
    summary: '患者档案、报告与化验、知家分享与认领、PHI 扫描（患者只用代号）',
    external: 'org_opt_in',
    names: [
      'patient_list', 'patient_read', 'patient_record_propose', 'patient_create', 'patient_update', 'patient_doc_link', 'patient_team', 'patient_access_log',
      'patient_claim_code', 'patient_claims_list', 'labs_query', 'labs_open', 'lab_edit', 'lab_resolve',
      'report_upload', 'report_read', 'report_lab_add', 'report_resolve', 'phr_member_links', 'phi_scan',
    ],
    prefixes: ['share_'],
    leaseGated: { lab_resolve: 'heurion:clinical_confirm', report_resolve: 'heurion:clinical_confirm' },
  },
  {
    id: 'imaging',
    title: '影像',
    summary: '影像检查、病灶分割与测量、随访、所见草稿',
    external: 'org_opt_in',
    names: [],
    prefixes: ['imaging_'],
    leaseGated: {},
  },
  {
    id: 'research',
    title: '临床研究',
    summary: '研究项目、成员、入组与研究数据集、研究变量',
    external: 'org_opt_in',
    names: [],
    prefixes: ['study_'],
    leaseGated: {},
  },
  {
    id: 'knowledge',
    title: '资料库',
    summary: '检索与阅读用户上传的参考资料',
    external: 'open',
    names: ['kb_search', 'kb_read'],
    prefixes: [],
    leaseGated: {},
  },
  {
    id: 'memory',
    title: '记忆',
    summary: '用户确认过的偏好与事实：提议、检索、遗忘、整理',
    external: 'open',
    names: [],
    prefixes: ['memory_'],
    leaseGated: {},
  },
  {
    id: 'admin',
    title: '管理',
    summary: '账户、机构与平台管理、文档 / 数据集 / 资料库管理、任务与子专家委派（高风险操作需确认或租约）',
    external: 'readonly_default',
    names: [
      'account', 'tenant_admin', 'org_template', 'phr_share', 'platform_admin', 'doc_manage', 'project_manage', 'comment_manage', 'dataset_manage',
      'kb_manage', 'memory_manage', 'patient_admin', 'study_admin', 'task_queue', 'asset_provenance', 'action_status', 'delegate_task',
    ],
    prefixes: [],
    leaseGated: Object.fromEntries(ADMIN_CONFIRM_TOOLS.map(t => [t, `heurion:${t}.*`])),
  },
]

export const MODULE_IDS: readonly ModuleId[] = MODULES.map(m => m.id)

const BY_NAME = new Map<string, ModuleId>()
for (const m of MODULES) for (const n of m.names) {
  if (BY_NAME.has(n)) throw new Error(`MCP 工具 ${n} 同时登记在 ${BY_NAME.get(n)} 与 ${m.id}`)
  BY_NAME.set(n, m.id)
}

/**
 * 外部智能体专用、不属于任何模块的工具：挂在每个模块的地址上（mcp/workspace-tools.ts）。
 * 只读授权下只挂只读的那几个；dsh 不注册它们。
 */
export const SHARED_TOOLS: ReadonlySet<string> = new Set(['workspace_put', 'workspace_get', 'workspace_list'])

/** 工具所属模块；没有登记的工具返回 null（测试保证平台注册的每个工具都有归属）。 */
export function moduleOf(tool: string): ModuleId | null {
  const named = BY_NAME.get(tool)
  if (named) return named
  const hits = MODULES.filter(m => m.prefixes.some(p => tool.startsWith(p)))
  return hits.length === 1 ? hits[0]!.id : null
}

/**
 * 只读工具：外部智能体的只读授权（tool_scope = readonly）只暴露这些。
 * 与拆分前 `AEGIS_READONLY_TOOLS` 正则逐个一致（tests/mcp-modules.test.ts 校验）。
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'doc_list', 'docs_search', 'doc_outline', 'doc_read', 'doc_search', 'doc_validate', 'doc_history', 'doc_diff', 'doc_export_docx',
  'deck_templates', 'slide_read', 'layout_check', 'slide_render', 'comments_list',
  'pubmed_search', 'openalex_search', 'oa_fulltext', 'doi_lookup', 'list_citations', 'list_measurements',
  'verify_claims', 'deep_review_audit_markdown', 'deep_review_audit', 'deep_review_status',
  'dataset_list', 'dataset_describe',
  'patient_list', 'patient_read', 'labs_query', 'report_read', 'patient_access_log', 'share_list', 'share_read', 'share_labs', 'share_file',
  'study_list', 'study_read', 'study_cohort_preview', 'study_cohort_list', 'study_vars_list',
  'kb_search', 'kb_read', 'memory_search', 'phr_member_links', 'patient_claims_list', 'phi_scan', 'imaging_status', 'imaging_models',
  'account', 'action_status', 'asset_provenance',
  'workspace_get', 'workspace_list',
])

// —— 外部智能体的模块权限（docs/design/MCP_MODULES.md §3.3，阶段 2） ——

/** r：只读工具；rw：模块全部工具。 */
export type ModulePerm = 'r' | 'rw'
export type ModuleGrant = Partial<Record<ModuleId, ModulePerm>>

/** 旧的 tool_scope 五值 → 等价的模块权限（没有存模块权限的授权按这个算）。 */
export type LegacyToolScope = 'all' | 'canvas' | 'clinical' | 'research' | 'readonly'

const BASE: ModuleGrant = { writing: 'rw', literature: 'rw', knowledge: 'rw', memory: 'rw' }

export function legacyScopeModules(scope: LegacyToolScope): ModuleGrant {
  switch (scope) {
    case 'all': return Object.fromEntries(MODULE_IDS.map(id => [id, 'rw'])) as ModuleGrant
    case 'readonly': return Object.fromEntries(MODULE_IDS.map(id => [id, 'r'])) as ModuleGrant
    case 'canvas': return { writing: 'rw', literature: 'rw' }
    case 'clinical': return { ...BASE, patients: 'rw', imaging: 'rw' }
    case 'research': return { ...BASE, analysis: 'rw', research: 'rw' }
  }
}

/**
 * 解析模块权限：JSON 对象 `{"writing":"rw"}`、或逗号分隔 `writing:rw,literature:r`（省略权限按 rw）。
 * 未知模块或权限抛错；空结果抛错（授权至少要有一个模块）。
 */
export function parseModuleGrant(input: unknown): ModuleGrant {
  let entries: Array<[string, unknown]>
  if (typeof input === 'string') {
    const t = input.trim()
    if (t.startsWith('{')) return parseModuleGrant(JSON.parse(t))
    entries = t.split(',').map(x => x.trim()).filter(Boolean).map(x => { const [k, v] = x.split(':'); return [k!.trim(), (v ?? 'rw').trim()] })
  } else if (input && typeof input === 'object' && !Array.isArray(input)) {
    entries = Object.entries(input)
  } else if (Array.isArray(input)) {
    entries = input.map(x => [String(x), 'rw'])
  } else {
    throw new Error('模块权限格式无效')
  }
  const out: ModuleGrant = {}
  for (const [k, v] of entries) {
    if (!(MODULE_IDS as readonly string[]).includes(k)) throw new Error(`未知模块：${k}（可选：${MODULE_IDS.join('、')}）`)
    if (v !== 'r' && v !== 'rw') throw new Error(`模块 ${k} 的权限只能是 r 或 rw`)
    out[k as ModuleId] = v
  }
  if (!Object.keys(out).length) throw new Error('模块权限不能为空')
  return out
}

/** 授权实际生效的模块权限：存了模块权限用它，否则由旧的 tool_scope 换算。 */
export function grantModules(grant: { modules?: string | null; tool_scope: LegacyToolScope }): ModuleGrant {
  if (grant.modules) {
    try { return parseModuleGrant(grant.modules) } catch { return {} }
  }
  return legacyScopeModules(grant.tool_scope)
}

/** 按模块权限判断外部智能体能否用这个工具：所属模块已授权；只读权限下只能用只读工具。 */
export function moduleGrantAllows(tool: string, grant: ModuleGrant): boolean {
  if (SHARED_TOOLS.has(tool)) {
    const perms = Object.values(grant)
    return READ_ONLY_TOOLS.has(tool) ? perms.length > 0 : perms.includes('rw')
  }
  const m = moduleOf(tool)
  const perm = m ? grant[m] : undefined
  if (!perm) return false
  return perm === 'rw' || READ_ONLY_TOOLS.has(tool)
}

export function formatModuleGrant(grant: ModuleGrant): string {
  return MODULE_IDS.filter(id => grant[id]).map(id => `${id}:${grant[id]}`).join(',')
}

// —— 机构外发策略（MCP_MODULES.md §3.5，阶段 4） ——

/** 需要机构开启后外部智能体才能用的模块。 */
export const ORG_OPT_IN_MODULES: readonly ModuleId[] = MODULES.filter(m => m.external === 'org_opt_in').map(m => m.id)

/**
 * 机构允许外部智能体用的模块：默认开放（open / readonly_default）的全部 + 机构开启的 org_opt_in 模块；
 * 机构关闭了「患者数据可以交给外部模型」时，org_opt_in 模块一律不开。
 */
export function orgAllowedModules(settings: { aegis_modules?: readonly string[]; external_model_for_patients?: boolean }): Set<ModuleId> {
  const out = new Set<ModuleId>(MODULES.filter(m => m.external !== 'org_opt_in').map(m => m.id))
  if (settings.external_model_for_patients === false) return out
  for (const m of settings.aegis_modules ?? []) if ((ORG_OPT_IN_MODULES as readonly string[]).includes(m)) out.add(m as ModuleId)
  return out
}

/** 授权的模块权限 ∩ 机构允许的模块。 */
export function restrictToOrg(grant: ModuleGrant, allowed: ReadonlySet<ModuleId>): { effective: ModuleGrant; blocked: ModuleId[] } {
  const effective: ModuleGrant = {}
  const blocked: ModuleId[] = []
  for (const id of MODULE_IDS) {
    if (!grant[id]) continue
    if (allowed.has(id)) effective[id] = grant[id]
    else blocked.push(id)
  }
  return { effective, blocked }
}
