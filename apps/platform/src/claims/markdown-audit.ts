/**
 * 无服务端 LLM 消耗的 Markdown 临床深度审稿确定性 AST 审计引擎（Stage 1–3 Pass B/C/D）。
 *
 * 将外部客户端（Claude / Cursor / Codex 等）传入的 Markdown 稿件解析为 Heurion 文档 AST
 * 与结构化二维表格摘要（TableSummary + ManuscriptScratchpad），在零持久化、零 SQLite 状态、
 * 零服务端大模型调用的情况下执行跨章节数值–表格–摘要算术一致性、统计方法配对、
 * Spin Bias 阳性夸大及 CONSORT/STROBE 规范巡检。
 */
import { assignIds } from '../model/ids.ts'
import { parseBlocks, plainText } from '../model/markdown.ts'
import { schema } from '../model/schema.ts'
import {
  auditInternalConsistency,
  auditMethodResultConsistency,
  auditSpinAndGuidelines,
  buildManuscriptScratchpad,
  classifyVerificationTier,
  extractTableSummaries,
  headingText,
  SectionRoleTracker,
  type DeepReviewAuditIssue,
  type ManuscriptScratchpad,
  type SectionRole,
  type VerificationTier,
} from './extract.ts'

export const MAX_PUBLIC_AUDIT_MARKDOWN_CHARS = 120_000
export const MAX_AUTH_AUDIT_MARKDOWN_CHARS = 200_000

export interface MarkdownSectionSummary {
  title: string
  role: SectionRole
  tier: VerificationTier
  blocks: number
  words: number
}

export interface MarkdownDeepReviewSummary {
  title: string
  word_count: number
  tables_detected: number
  sections_detected: number
  findings_total: number
  by_severity: { critical: number; major: number; minor: number }
  by_pass: { pass_b_internal: number; pass_c_method: number; pass_d_spin: number }
}

export interface MarkdownDeepReviewResult {
  ok: true
  engine: 'heurion-deterministic-ast-v1'
  summary: MarkdownDeepReviewSummary
  sections: MarkdownSectionSummary[]
  findings: DeepReviewAuditIssue[]
  scratchpad?: ManuscriptScratchpad
  active_rules_applied: string[]
  next_steps_hint: string
}

const TIER_RANK: Record<VerificationTier, number> = { light: 0, medium: 1, high: 2 }

function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const latin = (text.replace(/[\u4e00-\u9fff]/g, ' ').trim().match(/\S+/g) ?? []).length
  return cjk + latin
}

export function runDeterministicDeepReviewOnMarkdown(
  markdown: string,
  opts: { title?: string; activeRules?: string[]; includeScratchpad?: boolean } = {},
): MarkdownDeepReviewResult {
  const trimmed = markdown.trim()
  if (!trimmed) {
    throw new Error('Markdown manuscript content must not be empty')
  }

  const parsedBlocks = parseBlocks(trimmed)
  const blocks = parsedBlocks.length > 0 ? parsedBlocks : [schema.node('paragraph')]
  const rawDoc = schema.node('doc', null, blocks)
  const doc = assignIds(rawDoc, new Set())

  const tables = extractTableSummaries(doc)
  const scratchpad = buildManuscriptScratchpad(doc, tables)
  const activeRules = opts.activeRules ?? []

  const sections: MarkdownSectionSummary[] = []
  const roleTracker = new SectionRoleTracker()
  let current: MarkdownSectionSummary = {
    title: opts.title?.trim() || 'Abstract / Header',
    role: 'other',
    tier: 'light',
    blocks: 0,
    words: 0,
  }
  let totalWords = 0

  doc.forEach(node => {
    if (node.type.name === 'heading') {
      const hTitle = headingText(node) || 'Section'
      if (current.blocks > 0 || current.words > 0) sections.push(current)
      const role = roleTracker.onHeading(Number(node.attrs.level ?? 2), hTitle)
      current = { title: hTitle, role, tier: 'light', blocks: 0, words: 0 }
      return
    }
    const text = plainText(node).trim()
    const w = countWords(text)
    totalWords += w
    current.blocks += 1
    current.words += w
    if (text) {
      const tier = classifyVerificationTier(text, 0, current.role)
      if (TIER_RANK[tier] > TIER_RANK[current.tier]) current.tier = tier
    }
  })
  if (current.blocks > 0 || current.words > 0 || sections.length === 0) {
    sections.push(current)
  }

  const passB = auditInternalConsistency(doc, tables, activeRules)
  const passC = auditMethodResultConsistency(doc, tables, activeRules)
  const passD = auditSpinAndGuidelines(doc, activeRules)
  const findings = [...passB, ...passC, ...passD]

  const bySeverity = { critical: 0, major: 0, minor: 0 }
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
  }

  const resolvedTitle = opts.title?.trim() || (sections[0]?.title ?? 'Untitled Manuscript')
  return {
    ok: true,
    engine: 'heurion-deterministic-ast-v1',
    summary: {
      title: resolvedTitle,
      word_count: totalWords,
      tables_detected: tables.length,
      sections_detected: sections.length,
      findings_total: findings.length,
      by_severity: bySeverity,
      by_pass: {
        pass_b_internal: passB.length,
        pass_c_method: passC.length,
        pass_d_spin: passD.length,
      },
    },
    sections,
    findings,
    ...(opts.includeScratchpad !== false ? { scratchpad } : {}),
    active_rules_applied: activeRules,
    next_steps_hint:
      'Use findings[] and scratchpad to examine Table-Text arithmetic mismatches, statistical method-result discrepancies, Spin bias, and reporting guideline gaps. ' +
      'For PubMed/Crossref effect-size verification use public_pubmed_citation_check / verify_claims; for persistent 4-stage LLM review with anchored Word comments use deep_review_start on https://heurion.org/api/mcp/deep-review.',
  }
}
