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
}

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
    ],
    prefixes: [],
  },
  {
    id: 'literature',
    title: '文献',
    summary: '文献检索、开放全文、规范引用登记与论断核对',
    external: 'open',
    names: ['pubmed_search', 'openalex_search', 'oa_fulltext', 'doi_lookup', 'insert_citation', 'import_references', 'list_citations', 'verify_claims', 'claim_report'],
    prefixes: [],
  },
  {
    id: 'analysis',
    title: '数据分析',
    summary: '数据集描述与统计分析（Table 1、生存、回归等），分析结果登记后可绑定进稿件',
    external: 'org_opt_in',
    names: ['result_register', 'result_list'],
    prefixes: ['dataset_'],
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
  },
  {
    id: 'imaging',
    title: '影像',
    summary: '影像检查、病灶分割与测量、随访、所见草稿',
    external: 'org_opt_in',
    names: [],
    prefixes: ['imaging_'],
  },
  {
    id: 'research',
    title: '临床研究',
    summary: '研究项目、成员、入组与研究数据集、研究变量',
    external: 'org_opt_in',
    names: [],
    prefixes: ['study_'],
  },
  {
    id: 'knowledge',
    title: '资料库',
    summary: '检索与阅读用户上传的参考资料',
    external: 'open',
    names: ['kb_search', 'kb_read'],
    prefixes: [],
  },
  {
    id: 'memory',
    title: '记忆',
    summary: '用户确认过的偏好与事实：提议、检索、遗忘、整理',
    external: 'open',
    names: [],
    prefixes: ['memory_'],
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
  },
]

export const MODULE_IDS: readonly ModuleId[] = MODULES.map(m => m.id)

const BY_NAME = new Map<string, ModuleId>()
for (const m of MODULES) for (const n of m.names) {
  if (BY_NAME.has(n)) throw new Error(`MCP 工具 ${n} 同时登记在 ${BY_NAME.get(n)} 与 ${m.id}`)
  BY_NAME.set(n, m.id)
}

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
  'doc_list', 'docs_search', 'doc_outline', 'doc_read', 'doc_search', 'doc_validate', 'doc_history', 'doc_diff',
  'deck_templates', 'slide_read', 'layout_check', 'slide_render', 'comments_list',
  'pubmed_search', 'openalex_search', 'oa_fulltext', 'doi_lookup', 'list_citations', 'list_measurements', 'verify_claims',
  'dataset_list', 'dataset_describe',
  'patient_list', 'patient_read', 'labs_query', 'report_read', 'patient_access_log', 'share_list', 'share_read', 'share_labs', 'share_file',
  'study_list', 'study_read', 'study_cohort_preview', 'study_cohort_list', 'study_vars_list',
  'kb_search', 'kb_read', 'memory_search', 'phr_member_links', 'patient_claims_list', 'phi_scan', 'imaging_status', 'imaging_models',
  'account', 'action_status', 'asset_provenance',
])
