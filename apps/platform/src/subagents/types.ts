/**
 * Subagent（子专家智能体）架构规范与类型定义
 *
 * 遵循「双翼 · 一核 · 一门」多智能体协同流水线：
 * - literature_researcher（文献证据专家）：检索 PubMed/OpenAlex，提炼临床证据包与标准 AMA 引注
 * - biostatistician（生信统计专家）：分析数据集，生成出版级 Table 1 基线表、KM 生存曲线与统计学指标
 * - fact_checker（质控核查专家）：对抗式核验正文与证据的一致性、数字真实性与 PHI 敏感数据
 */

export type SubagentRole = 'literature_researcher' | 'biostatistician' | 'fact_checker'

export const SUBAGENT_ROLE_LABELS: Record<SubagentRole, string> = {
  literature_researcher: '文献证据专家',
  biostatistician: '生信统计专家',
  fact_checker: '质控核查专家',
}

export interface SubagentProgress {
  step: (message: string, status?: 'ok' | 'warn' | 'info') => void
}

export interface EvidenceCitation {
  cite_id?: string
  pmid?: string | null
  doi?: string | null
  url?: string | null
  title: string
  authors: string[]
  year?: number | string
  journal?: string
  evidence_quote?: string
}

export interface EvidenceBundle {
  role: 'literature_researcher'
  topic: string
  query: string
  total_found: number
  citations: EvidenceCitation[]
  clinical_synthesis: string
  suggested_markers: Array<{ cite_id?: string; marker: string; reference: string }>
}

export interface StatisticalBundle {
  role: 'biostatistician'
  dataset_id: string
  dataset_name: string
  analysis_type: 'table1' | 'survival' | 'summary'
  sample_size: number
  markdown_table: string
  summary_metrics: Record<string, unknown>
  clinical_interpretation: string
}

export interface ClaimCheckIssue {
  claim_id?: string
  sentence: string
  verdict: 'unsupported' | 'unclear' | 'no_evidence'
  reason: string
  suggestion?: string
}

export interface VerificationReport {
  role: 'fact_checker'
  verdict: 'pass' | 'warning' | 'fail'
  total_claims_audited: number
  supported_count: number
  unsupported_count: number
  unclear_count: number
  phi_detected: boolean
  phi_count: number
  issues: ClaimCheckIssue[]
  summary: string
}

export type SubagentResult = EvidenceBundle | StatisticalBundle | VerificationReport

export interface SubagentTaskParams {
  role: SubagentRole
  task: string
  doc_id?: string
  dataset_id?: string
  section?: string
  context?: Record<string, unknown>
}
