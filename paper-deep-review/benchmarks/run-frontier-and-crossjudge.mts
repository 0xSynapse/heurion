/**
 * Heurion Deep Review — Top-Journal / Top-Conference Frontier Baselines & 3-Way Cross-Paradigm Blind Clinician Evaluation
 * (`paper-deep-review/benchmarks/run-frontier-and-crossjudge.mts`)
 *
 * Addresses peer-review critiques across all 19 PMC full-text clinical & translational papers
 * (38 clean/injected manuscripts, 57 objectively verifiable injected errors across E1–E7 and 7 study designs):
 *
 * 1. Strong Full-Context Frontier Baselines, Cross-Backbone Generalization & Exact Paired Statistical Inference:
 *    - (B1) `full_context_deepseek_reasoner` (`deepseek-reasoner` / DeepSeek-R1): Single-pass full manuscript prose +
 *      all full 2D Markdown tables inline with a strict high-precision clinical & biostatistical peer-review prompt
 *      (`max_tokens: 64000`, `thinking.budget_tokens: 48000` so Chain-of-Thought reasoning never truncates JSON output).
 *    - (B2) `full_context_deepseek_chat` (`deepseek-chat` / DeepSeek-V3): Identical single-pass full manuscript prose +
 *      all full 2D Markdown tables high-precision prompt on `deepseek-chat`.
 *    - (B3) `heurion_deep_deepseek_chat` (`heurion_deep` Four-Stage Hybrid Architecture on `deepseek-chat` / DeepSeek-V3):
 *      Direct controlled comparison against (B2) on the exact same `deepseek-chat` backbone with full 2D tables.
 *    - Exact Paired Statistical Tests: 95% Wilson score CIs on Recall, `Prec_inj`, and `Prec_org`, exact 2^19 = 524,288
 *      paper-clustered paired permutation two-sided p-values across all 7 metrics, and exact two-sided McNemar p-values
 *      on the 57 paired injections for (B2 vs B3), (B1 vs B3), and (Ref v4-flash vs B3).
 *
 * 2. 3-Way Cross-Paradigm Independent Blind Clinician Judges (`deepseek-v4-flash` vs `deepseek-chat` vs `deepseek-reasoner`):
 *    - Evaluates physically blind clinician decisions (`simulateBlindClinician` / `evolveStoreFromFindingsBlind` — ZERO
 *      access to `variant`, `injections`, or `split`) across three distinct model paradigms on the identical n = 191
 *      Round 1 `heurion_deep` (`deepseek-v4-flash`) findings across all 19 papers (38 manuscripts):
 *      1) `deepseek-v4-flash` (fast non-thinking production reviewer model),
 *      2) `deepseek-chat` (DeepSeek-V3 frontier dense/MoE chat model),
 *      3) `deepseek-reasoner` (DeepSeek-R1 explicit Chain-of-Thought reasoning model, `max_tokens: 8000`,
 *         `thinking.budget_tokens: 6000`).
 *    - Computes independent clinician calibration (with Wilson 95% CIs), pairwise Cohen's kappa (with Fleiss-Cohen-Everitt
 *      SE & 95% CI, PABAK, positive/negative agreement), and 3-rater Fleiss' kappa across all 3 paradigms.
 *    - Evaluates Cross-Model Clinician Driven Evolution (`dev` N=11 evolved strictly via `deepseek-chat` blind clinician
 *      with specialty-example leakage scrubbing `scrubSpecialtyExampleLeakage` + `hasInstanceLeakage === false` assertion
 *      -> frozen unseen `test` N=8 evaluated on `deepseek-v4-flash` under Candidate-Scoped Selective Stage-4 Routing
 *      BOTH with `ablation: { disableAuditChecklists: true }` [pure Track A] AND full `heurion_evolved`).
 *
 * Usage:
 *   DEEPSEEK_API_KEY=... ./apps/platform/node_modules/.bin/tsx paper-deep-review/benchmarks/run-frontier-and-crossjudge.mts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  countActiveAuditChecklists,
  countActiveBoundaryRules,
  evolveAuditChecklistsFromDevMisses,
  evolveStoreFromFindingsBlind,
  findingKey,
  loadOrSynthesizePaperMarkdown,
  normText,
  reviewOnce,
  simulateBlindClinician,
  type BlindClinicianDecision,
  type ReviewEvalMode,
  type RunFinding,
} from '../../apps/platform/scripts/eval-review-run.ts'
import {
  readInjections,
  readManifest,
  type Injection,
  type InjectionType,
  type ReviewPaper,
} from '../../apps/platform/scripts/eval-review-fetch.ts'
import {
  changedTokens,
  matches,
  matchesKnownOrganicError,
  readAdjudications,
  readKnownOrganicErrors,
  type Adjudication,
  type KnownOrganicError,
} from '../../apps/platform/scripts/eval-review-score.ts'
import { config } from '../../apps/platform/src/config.ts'
import { hasInstanceLeakage, scrubSpecialtyExampleLeakage } from '../../apps/platform/src/claims/service.ts'
import { makeComplete, type Complete, type CompleteUsage } from '../../apps/platform/src/harness/complete.ts'
import { ProceduralHarnessService } from '../../apps/platform/src/memory/procedural.ts'
import { Documents } from '../../apps/platform/src/model/runtime.ts'
import { Store } from '../../apps/platform/src/store/db.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

const INJECTION_TYPES: InjectionType[] = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']
const DEFAULT_CKPT_DIR = resolve(repoRoot, 'data/eval/deep-review/ckpt-frontier')
const CKPT_DIR = process.env.FRONTIER_CKPT_DIR ? resolve(process.env.FRONTIER_CKPT_DIR) : DEFAULT_CKPT_DIR

const REASONER_PAPER_CONCURRENCY = Number(process.env.REASONER_CONCURRENCY ?? 6)
const REASONER_JUDGE_CONCURRENCY = Number(process.env.REASONER_JUDGE_CONCURRENCY ?? 14)
const CHAT_PAPER_CONCURRENCY = Number(process.env.CHAT_CONCURRENCY ?? 5)
const FLASH_PAPER_CONCURRENCY = Number(process.env.FLASH_CONCURRENCY ?? 5)

const CATEGORY_GENERIC_MECHANISM: Record<InjectionType, { category: string; description: string }> = {
  E1: {
    category: 'internal_inconsistency',
    description: '跨章节总样本量、随机化各组人数之和或完成随访总人数在摘要、方法、结果与表格表头之间前后不一致。',
  },
  E2: {
    category: 'internal_inconsistency',
    description: '正文或表格单元格报告的分子/分母频数与括号内百分比存在客观算术计算偏差（n/N != %）。',
  },
  E3: {
    category: 'internal_inconsistency',
    description: '同一临床结局、效应量（OR/HR/RR/WMD）、百分比或取材检测列表在摘要、结果正文与图表之间数值或内容矛盾。',
  },
  E4: {
    category: 'internal_inconsistency',
    description: '点估计值落在其报告的 95% 置信区间（或四分位数间距）上下界之外，或置信区间下界大于上界。',
  },
  E5: {
    category: 'method_result_mismatch',
    description: '统计方法章节声明的参数/非参数描述指标或假设检验方法与结果章节及表格实际使用的指标/检验冲突。',
  },
  E6: {
    category: 'spin_or_guideline',
    description: '结果统计检验无显著性（p >= 0.05）或组间可比，但在摘要结论或讨论中被夸大为显著有效，或观察性研究下强因果定论。',
  },
  E7: {
    category: 'internal_inconsistency',
    description: '表格行内各亚组例数之和与合计列（Total）或外层声明总数在算术上不一致。',
  },
}

/**
 * Genuinely strong, fair, high-precision full-context clinical & biostatistical peer-review prompt.
 * Identical prompt used for (B1) `deepseek-reasoner` (DeepSeek-R1) and (B2) `deepseek-chat` (DeepSeek-V3).
 */
export const FRONTIER_FULL_CONTEXT_SYSTEM_PROMPT = [
  'You are a senior statistical and clinical peer reviewer for a top-tier medical journal.',
  'You are given the COMPLETE full-text clinical manuscript INCLUDING all prose sections AND all full 2D Markdown tables inline with their captions and footnotes.',
  '(Note on Markdown table syntax: "<" indicates a horizontal colspan merge from the cell to the left; "^" indicates a vertical rowspan merge from the cell above.)',
  '',
  'Audit the entire manuscript and every 2D table row/column carefully. Report ONLY high-confidence, objectively provable errors that can be demonstrated directly from the manuscript text and tables:',
  '1. Arithmetic errors: reported count/denominator disagreeing with its percentage (n/N != % beyond standard rounding), or mutually exclusive and exhaustive subgroup counts not summing to the declared group/total N in prose or table headers/totals (`category`: "internal_inconsistency").',
  '2. Confidence interval / range bound errors: a point estimate falling strictly outside its own reported 95% CI (or IQR) bounds, or inverted interval bounds where lower > upper (`category`: "internal_inconsistency").',
  '3. Cross-section or prose-vs-table contradictions: the exact same clinical endpoint, sample size, count, percentage, effect size (OR/HR/RR/MD), or P-value reported with conflicting values across Abstract, Methods, Results prose, Figures, or Tables on the SAME analysis set, model, and timepoint (`category`: "internal_inconsistency").',
  '4. Statistical method-vs-result mismatches: Statistical Methods exclusively declares one summary/testing framework (e.g., parametric Mean±SD / t-test / ANOVA only, or non-parametric Median[IQR] / Mann-Whitney / Kruskal-Wallis only), while Results or Tables report undeclared conflicting summary metrics or tests (`category`: "method_result_mismatch").',
  '5. Spin / overclaiming on non-significant results: claiming a statistically significant benefit, difference, or causal efficacy in the Abstract or Discussion/Conclusions when the reported statistical test is non-significant (p >= 0.05 or 95% CI crossing the null), or asserting causal efficacy in a purely observational study (`category`: "spin_or_guideline").',
  '',
  'STRICT HIGH-PRECISION EXCLUSION RULES — DO NOT REPORT:',
  '- Stylistic or phrasing suggestions, subjective study-design/power critiques, missing literature citations, or requests for additional analyses;',
  '- Normal rounding differences of <= 1 unit in the last reported digit, or category percentages summing to 99.8%–100.2%;',
  '- Legitimate multi-tier sample denominator shifts explicitly grounded in the study design or footnotes (e.g., CONSORT randomized ITT vs completers/per-protocol, STROBE total cohort vs complete-case / propensity-matched / specimen-evaluable subcohorts, PRISMA total included trials vs outcome-specific trial subsets, or non-mutually-exclusive multi-response comorbidities);',
  '- Crude/unadjusted estimates vs multivariable-adjusted or weighted/standardized estimates (e.g., crude OR/HR vs aOR/aHR), or dual parametric + non-parametric summaries when Methods already declares normality-based selection.',
  '',
  'CALIBRATION & OUTPUT FORMAT:',
  '- Prioritize precision over volume: if you cannot verify a direct contradiction or arithmetic error from two explicit manuscript locations (or a self-contradictory calculation/CI), DO NOT report it.',
  '- For "sentence", copy the EXACT verbatim sentence or full Markdown table row (including | pipes |) containing the error directly from the manuscript without paraphrasing.',
  '- For "evidence", provide 1–3 EXACT verbatim quotes or Markdown table rows/headers from elsewhere in the manuscript that prove the contradiction (if self-contained within one sentence/row, repeat the relevant header/context row).',
  '- Severity: "critical" = primary endpoint, total/group sample size, or major conclusion error; "major" = secondary outcome contradiction, method-result mismatch, or spin; "minor" = minor baseline/secondary rounding-exceeding arithmetic error.',
  '- Output STRICTLY a valid JSON array (and nothing else). Return [] if no high-confidence objective error exists:',
  '[{"sentence":"exact verbatim sentence or | Markdown table row |","evidence":["exact verbatim contradicting quote or | table row |"],"category":"internal_inconsistency|method_result_mismatch|spin_or_guideline","severity":"critical|major|minor","reason":"concise explanation citing exact numbers","suggestion":"concise concrete correction"}]',
].join('\n')

export interface ModelTelemetryBucket {
  calls: number
  input_tokens: number
  output_tokens: number
  ms: number
  thinking_chars?: number
  truncated_calls?: number
}

function emptyBucket(): ModelTelemetryBucket {
  return { calls: 0, input_tokens: 0, output_tokens: 0, ms: 0 }
}

function addBucket(dst: ModelTelemetryBucket, src: Partial<ModelTelemetryBucket>): void {
  dst.calls += src.calls ?? 0
  dst.input_tokens += src.input_tokens ?? 0
  dst.output_tokens += src.output_tokens ?? 0
  dst.ms += src.ms ?? 0
  if (src.thinking_chars !== undefined) dst.thinking_chars = (dst.thinking_chars ?? 0) + src.thinking_chars
  if (src.truncated_calls !== undefined) dst.truncated_calls = (dst.truncated_calls ?? 0) + src.truncated_calls
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIdx = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      while (nextIdx < items.length) {
        const idx = nextIdx++
        results[idx] = await fn(items[idx]!, idx)
      }
    }),
  )
  return results
}

function readCkpt<T>(key: string): T | null {
  const p = join(CKPT_DIR, `${key}.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}

function writeCkpt<T>(key: string, data: T): void {
  mkdirSync(CKPT_DIR, { recursive: true })
  writeFileSync(join(CKPT_DIR, `${key}.json`), JSON.stringify(data, null, 2), 'utf8')
}

function cloneFrozenStore(srcStore: Store, owner = 'eval'): Store {
  const dst = new Store(':memory:')
  for (const m of srcStore.listMemories(owner, ['active'])) {
    dst.addMemory({
      scope: 'user',
      owner,
      project_id: null,
      kind: 'preference',
      content: m.content,
      norm: m.content.toLowerCase(),
      reason: m.reason,
      source: 'auto',
      source_doc_id: m.source_doc_id,
      source_turn_id: null,
      actor: 'user',
      explicit: 1,
      evidence: 1,
      status: 'active',
    })
  }
  return dst
}

function seedStoreForBlindJudge(
  title: string,
  markdown: string,
  findings: RunFinding[],
): { store: Store; docId: string; findingsWithComments: RunFinding[] } {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const doc = docs.create({ owner: 'eval', title, markdown })
  const findingsWithComments: RunFinding[] = findings.map(f => {
    const row = store.addComment({
      doc_id: doc.id,
      node_id: 'p_1',
      snippet: f.anchor || f.sentence,
    })
    store.addReply(
      row.id,
      'ai',
      `[${f.severity.toUpperCase()} | ${f.category}${f.subtype ? ` | ${f.subtype}` : ''}] ${f.reason}` +
        (f.evidence?.length ? `\n【对照原文】：${f.evidence.map(e => `「${e.slice(0, 300)}」`).join(' ')}` : '') +
        `\n【建议修改】：${f.suggestion}`,
    )
    return { ...f, comment_id: row.id }
  })
  return { store, docId: doc.id, findingsWithComments }
}

/**
 * Exact 95% Wilson score confidence interval (in percentage points [0, 100]).
 */
export function wilson95CI(k: number, n: number): [number, number] {
  if (n <= 0) return [100, 100]
  const z = 1.959963984540054
  const z2 = z * z
  const phat = k / n
  const denom = 1 + z2 / n
  const center = (phat + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom
  const lo = Math.max(0, (center - half) * 100)
  const hi = Math.min(100, (center + half) * 100)
  return [Number(lo.toFixed(1)), Number(hi.toFixed(1))]
}

/**
 * Exact two-sided binomial McNemar p-value for discordant pairs (n10, n01).
 */
export function exactMcNemarTwoSidedP(n10: number, n01: number): number {
  const nd = n10 + n01
  if (nd === 0) return 1
  const kMin = Math.min(n10, n01)
  // Compute sum_{j=0..kMin} C(nd, j) * 0.5^nd stably in log/iterative space
  let term = Math.pow(0.5, nd)
  let cdf = term
  for (let j = 1; j <= kMin; j++) {
    term = (term * (nd - j + 1)) / j
    cdf += term
  }
  return Number(Math.min(1, 2 * cdf).toFixed(6))
}

/**
 * Identical scoring functions to `paper-deep-review/benchmarks/run-injected-review-evolution.ts`.
 */
function matchInjection(f: RunFinding, inj: Injection): boolean {
  const added = changedTokens(inj.find, inj.replace)
  return matches(f, { ...inj, quote: inj.replace }, added)
}

function isVerifiedOrganicError(
  paperId: string,
  f: RunFinding,
  adjMap: Map<string, Adjudication>,
  knownOrganic: KnownOrganicError[],
): boolean {
  const adj = adjMap.get(`${paperId}|${f.finding_key}`)
  if (adj?.verdict === 'unexpected_true') return true
  if (adj?.verdict === 'false_positive') return false
  return matchesKnownOrganicError(paperId, f, knownOrganic) !== null
}

export interface SplitMetrics {
  papers: number
  manuscripts_evaluated: number
  injected_errors_total: number
  injected_errors_detected: number
  recall_pct: number
  recall_wilson_95ci: [number, number]
  by_type: Record<InjectionType, { total: number; detected: number; recall_pct: number }>
  true_positive_injected_findings: number
  unexpected_true_organic_clean: number
  unexpected_true_organic_injected: number
  unexpected_true_organic_total: number
  raw_unadjusted_clean_findings: number
  false_positive_findings_total: number
  false_positive_clean: number
  false_positive_injected: number
  clean_critical_major_fp_per_paper: number
  clean_minor_fp_per_paper: number
  precision_injected_only_pct: number
  precision_injected_only_wilson_95ci: [number, number]
  precision_with_organic_tp_pct: number
  precision_with_organic_tp_wilson_95ci: [number, number]
  f1_injected_only_pct: number
  f1_pct: number
}

function classifyFindingsForPaper(
  paperId: string,
  cleanFindings: RunFinding[],
  injectedFindings: RunFinding[],
  injections: Injection[],
  adjMap: Map<string, Adjudication>,
  knownOrganic: KnownOrganicError[],
): {
  detectedInjectionIds: Set<string>
  tpInjectedFindings: RunFinding[]
  organicCleanFindings: RunFinding[]
  organicInjectedFindings: RunFinding[]
  fpClean: RunFinding[]
  fpInjected: RunFinding[]
} {
  const cleanKeys = new Set(cleanFindings.map(f => f.finding_key))
  const detectedInjectionIds = new Set<string>()
  const tpFindingKeys = new Set<string>()

  for (const inj of injections) {
    const hits = injectedFindings.filter(f => !cleanKeys.has(f.finding_key) && matchInjection(f, inj))
    if (hits.length > 0) {
      detectedInjectionIds.add(inj.label_id)
      for (const h of hits) tpFindingKeys.add(h.finding_key)
    }
  }

  for (const inj of injections) {
    if (detectedInjectionIds.has(inj.label_id)) continue
    const hits = injectedFindings.filter(f => matchInjection(f, inj))
    if (hits.length > 0) {
      detectedInjectionIds.add(inj.label_id)
      for (const h of hits) tpFindingKeys.add(h.finding_key)
    }
  }

  const tpInjectedFindings = injectedFindings.filter(f => tpFindingKeys.has(f.finding_key))
  const nonInjInjected = injectedFindings.filter(f => !tpFindingKeys.has(f.finding_key))

  const organicCleanFindings = cleanFindings.filter(f => isVerifiedOrganicError(paperId, f, adjMap, knownOrganic))
  const fpClean = cleanFindings.filter(f => !isVerifiedOrganicError(paperId, f, adjMap, knownOrganic))

  const organicInjectedFindings = nonInjInjected.filter(f => isVerifiedOrganicError(paperId, f, adjMap, knownOrganic))
  const fpInjected = nonInjInjected.filter(f => !isVerifiedOrganicError(paperId, f, adjMap, knownOrganic))

  return {
    detectedInjectionIds,
    tpInjectedFindings,
    organicCleanFindings,
    organicInjectedFindings,
    fpClean,
    fpInjected,
  }
}

function aggregateMetrics(
  papers: ReviewPaper[],
  perPaperResults: Map<
    string,
    {
      cleanFindings: RunFinding[]
      injectedFindings: RunFinding[]
      injections: Injection[]
    }
  >,
  adjMap: Map<string, Adjudication>,
  knownOrganic: KnownOrganicError[],
): SplitMetrics {
  const byType: Record<InjectionType, { total: number; detected: number; recall_pct: number }> = {
    E1: { total: 0, detected: 0, recall_pct: 0 },
    E2: { total: 0, detected: 0, recall_pct: 0 },
    E3: { total: 0, detected: 0, recall_pct: 0 },
    E4: { total: 0, detected: 0, recall_pct: 0 },
    E5: { total: 0, detected: 0, recall_pct: 0 },
    E6: { total: 0, detected: 0, recall_pct: 0 },
    E7: { total: 0, detected: 0, recall_pct: 0 },
  }

  let totalInj = 0
  let detectedInj = 0
  let tpInjCount = 0
  let orgCleanCount = 0
  let orgInjCount = 0
  let rawCleanCount = 0
  let fpCleanCount = 0
  let fpInjectedCount = 0
  let cleanCritMajCount = 0
  let cleanMinorCount = 0

  for (const p of papers) {
    const entry = perPaperResults.get(p.id)
    if (!entry) continue
    rawCleanCount += entry.cleanFindings.length
    const {
      detectedInjectionIds,
      tpInjectedFindings,
      organicCleanFindings,
      organicInjectedFindings,
      fpClean,
      fpInjected,
    } = classifyFindingsForPaper(p.id, entry.cleanFindings, entry.injectedFindings, entry.injections, adjMap, knownOrganic)

    for (const inj of entry.injections) {
      totalInj++
      byType[inj.type].total++
      if (detectedInjectionIds.has(inj.label_id)) {
        detectedInj++
        byType[inj.type].detected++
      }
    }
    tpInjCount += tpInjectedFindings.length
    orgCleanCount += organicCleanFindings.length
    orgInjCount += organicInjectedFindings.length
    fpCleanCount += fpClean.length
    fpInjectedCount += fpInjected.length
    cleanCritMajCount += fpClean.filter(f => f.severity === 'critical' || f.severity === 'major').length
    cleanMinorCount += fpClean.filter(f => f.severity === 'minor').length
  }

  for (const t of INJECTION_TYPES) {
    byType[t].recall_pct =
      byType[t].total > 0 ? Number(((byType[t].detected / byType[t].total) * 100).toFixed(1)) : 100
  }

  const fpTotal = fpCleanCount + fpInjectedCount
  const orgTotal = orgCleanCount + orgInjCount
  const recallPct = totalInj > 0 ? Number(((detectedInj / totalInj) * 100).toFixed(1)) : 100
  const precisionInjOnlyPct =
    tpInjCount + fpTotal > 0 ? Number(((tpInjCount / (tpInjCount + fpTotal)) * 100).toFixed(1)) : 100
  const allTrueFindings = tpInjCount + orgTotal
  const precisionWithOrgPct =
    allTrueFindings + fpTotal > 0 ? Number(((allTrueFindings / (allTrueFindings + fpTotal)) * 100).toFixed(1)) : 100
  const f1InjOnlyPct =
    precisionInjOnlyPct + recallPct > 0
      ? Number(((2 * precisionInjOnlyPct * recallPct) / (precisionInjOnlyPct + recallPct)).toFixed(1))
      : 0
  const f1Pct =
    precisionWithOrgPct + recallPct > 0
      ? Number(((2 * precisionWithOrgPct * recallPct) / (precisionWithOrgPct + recallPct)).toFixed(1))
      : 0

  return {
    papers: papers.length,
    manuscripts_evaluated: papers.length * 2,
    injected_errors_total: totalInj,
    injected_errors_detected: detectedInj,
    recall_pct: recallPct,
    recall_wilson_95ci: wilson95CI(detectedInj, totalInj),
    by_type: byType,
    true_positive_injected_findings: tpInjCount,
    unexpected_true_organic_clean: orgCleanCount,
    unexpected_true_organic_injected: orgInjCount,
    unexpected_true_organic_total: orgTotal,
    raw_unadjusted_clean_findings: rawCleanCount,
    false_positive_findings_total: fpTotal,
    false_positive_clean: fpCleanCount,
    false_positive_injected: fpInjectedCount,
    clean_critical_major_fp_per_paper: Number((cleanCritMajCount / Math.max(1, papers.length)).toFixed(2)),
    clean_minor_fp_per_paper: Number((cleanMinorCount / Math.max(1, papers.length)).toFixed(2)),
    precision_injected_only_pct: precisionInjOnlyPct,
    precision_injected_only_wilson_95ci: wilson95CI(tpInjCount, tpInjCount + fpTotal),
    precision_with_organic_tp_pct: precisionWithOrgPct,
    precision_with_organic_tp_wilson_95ci: wilson95CI(allTrueFindings, allTrueFindings + fpTotal),
    f1_injected_only_pct: f1InjOnlyPct,
    f1_pct: f1Pct,
  }
}

export interface PairedStatisticalTestResult {
  regime_a: string
  regime_b: string
  papers_n: number
  exact_permutations_enumerated: number
  paired_injections_n: number
  observed_deltas_b_minus_a: {
    recall_pct_pts: number
    injected_errors_detected: number
    false_positive_total: number
    false_positive_clean: number
    precision_injected_only_pct_pts: number
    precision_with_organic_tp_pct_pts: number
    f1_injected_only_pct_pts: number
    f1_with_organic_tp_pct_pts: number
  }
  exact_paired_permutation_two_sided_p: {
    recall_p: number
    false_positive_total_p: number
    false_positive_clean_p: number
    precision_injected_only_p: number
    precision_with_organic_tp_p: number
    f1_injected_only_p: number
    f1_with_organic_tp_p: number
  }
  mcnemar_on_injections: {
    both_detected: number
    only_a_detected: number
    only_b_detected: number
    both_missed: number
    discordant_pairs: number
    exact_two_sided_p: number
  }
}

/**
 * Exact 2^N paper-clustered paired permutation test (enumerating all 2^19 = 524,288 cluster sign/swap
 * assignments in O(1) per Gray-code step) + exact two-sided McNemar test on paired injections.
 */
function computePairedRegimeComparison(
  papers: ReviewPaper[],
  mapA: Map<string, { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }>,
  mapB: Map<string, { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }>,
  labelA: string,
  labelB: string,
  adjMap: Map<string, Adjudication>,
  knownOrganic: KnownOrganicError[],
): PairedStatisticalTestResult {
  const n = papers.length
  if (n > 24) {
    throw new Error(`Exact 2^N permutation requires N <= 24 (got N=${n})`)
  }
  const totalPerms = 1 << n

  const aInjDet = new Int32Array(n)
  const bInjDet = new Int32Array(n)
  const aTpInj = new Int32Array(n)
  const bTpInj = new Int32Array(n)
  const aOrg = new Int32Array(n)
  const bOrg = new Int32Array(n)
  const aFpClean = new Int32Array(n)
  const bFpClean = new Int32Array(n)
  const aFpTot = new Int32Array(n)
  const bFpTot = new Int32Array(n)

  let totalInj = 0
  let mcnemarBothDet = 0
  let mcnemarOnlyA = 0
  let mcnemarOnlyB = 0
  let mcnemarBothMiss = 0

  for (let i = 0; i < n; i++) {
    const p = papers[i]!
    const entA = mapA.get(p.id)!
    const entB = mapB.get(p.id)!
    const cA = classifyFindingsForPaper(p.id, entA.cleanFindings, entA.injectedFindings, entA.injections, adjMap, knownOrganic)
    const cB = classifyFindingsForPaper(p.id, entB.cleanFindings, entB.injectedFindings, entB.injections, adjMap, knownOrganic)

    aInjDet[i] = cA.detectedInjectionIds.size
    bInjDet[i] = cB.detectedInjectionIds.size
    aTpInj[i] = cA.tpInjectedFindings.length
    bTpInj[i] = cB.tpInjectedFindings.length
    aOrg[i] = cA.organicCleanFindings.length + cA.organicInjectedFindings.length
    bOrg[i] = cB.organicCleanFindings.length + cB.organicInjectedFindings.length
    aFpClean[i] = cA.fpClean.length
    bFpClean[i] = cB.fpClean.length
    aFpTot[i] = cA.fpClean.length + cA.fpInjected.length
    bFpTot[i] = cB.fpClean.length + cB.fpInjected.length

    for (const inj of entA.injections) {
      totalInj++
      const detA = cA.detectedInjectionIds.has(inj.label_id)
      const detB = cB.detectedInjectionIds.has(inj.label_id)
      if (detA && detB) mcnemarBothDet++
      else if (detA && !detB) mcnemarOnlyA++
      else if (!detA && detB) mcnemarOnlyB++
      else mcnemarBothMiss++
    }
  }

  let g1InjDet = 0
  let g1TpInj = 0
  let g1Org = 0
  let g1FpClean = 0
  let g1FpTot = 0

  let sumInjDet = 0
  let sumTpInj = 0
  let sumOrg = 0
  let sumFpClean = 0
  let sumFpTot = 0

  for (let i = 0; i < n; i++) {
    g1InjDet += aInjDet[i]!
    g1TpInj += aTpInj[i]!
    g1Org += aOrg[i]!
    g1FpClean += aFpClean[i]!
    g1FpTot += aFpTot[i]!

    sumInjDet += aInjDet[i]! + bInjDet[i]!
    sumTpInj += aTpInj[i]! + bTpInj[i]!
    sumOrg += aOrg[i]! + bOrg[i]!
    sumFpClean += aFpClean[i]! + bFpClean[i]!
    sumFpTot += aFpTot[i]! + bFpTot[i]!
  }

  const evalDel = () => {
    const g2InjDet = sumInjDet - g1InjDet
    const g2TpInj = sumTpInj - g1TpInj
    const g2Org = sumOrg - g1Org
    const g2FpClean = sumFpClean - g1FpClean
    const g2FpTot = sumFpTot - g1FpTot

    const rec1 = totalInj > 0 ? g1InjDet / totalInj : 1
    const rec2 = totalInj > 0 ? g2InjDet / totalInj : 1
    const pInj1 = g1TpInj + g1FpTot > 0 ? g1TpInj / (g1TpInj + g1FpTot) : 1
    const pInj2 = g2TpInj + g2FpTot > 0 ? g2TpInj / (g2TpInj + g2FpTot) : 1
    const t1 = g1TpInj + g1Org
    const t2 = g2TpInj + g2Org
    const pOrg1 = t1 + g1FpTot > 0 ? t1 / (t1 + g1FpTot) : 1
    const pOrg2 = t2 + g2FpTot > 0 ? t2 / (t2 + g2FpTot) : 1
    const f1Inj1 = pInj1 + rec1 > 0 ? (2 * pInj1 * rec1) / (pInj1 + rec1) : 0
    const f1Inj2 = pInj2 + rec2 > 0 ? (2 * pInj2 * rec2) / (pInj2 + rec2) : 0
    const f1Org1 = pOrg1 + rec1 > 0 ? (2 * pOrg1 * rec1) / (pOrg1 + rec1) : 0
    const f1Org2 = pOrg2 + rec2 > 0 ? (2 * pOrg2 * rec2) / (pOrg2 + rec2) : 0

    return {
      dRec: rec2 - rec1,
      dFpTot: g2FpTot - g1FpTot,
      dFpClean: g2FpClean - g1FpClean,
      dPInj: pInj2 - pInj1,
      dPOrg: pOrg2 - pOrg1,
      dF1Inj: f1Inj2 - f1Inj1,
      dF1Org: f1Org2 - f1Org1,
      dDetInt: g2InjDet - g1InjDet,
    }
  }

  const obs = evalDel()
  const absObsRec = Math.abs(obs.dRec) - 1e-12
  const absObsFpTot = Math.abs(obs.dFpTot)
  const absObsFpClean = Math.abs(obs.dFpClean)
  const absObsPInj = Math.abs(obs.dPInj) - 1e-12
  const absObsPOrg = Math.abs(obs.dPOrg) - 1e-12
  const absObsF1Inj = Math.abs(obs.dF1Inj) - 1e-12
  const absObsF1Org = Math.abs(obs.dF1Org) - 1e-12

  let geRec = 1
  let geFpTot = 1
  let geFpClean = 1
  let gePInj = 1
  let gePOrg = 1
  let geF1Inj = 1
  let geF1Org = 1

  let prevGray = 0
  for (let k = 1; k < totalPerms; k++) {
    const gray = k ^ (k >> 1)
    const diffBit = gray ^ prevGray
    const idx = 31 - Math.clz32(diffBit)
    if ((gray & diffBit) !== 0) {
      // Paper `idx` swapped from A -> B in Group 1
      g1InjDet += bInjDet[idx]! - aInjDet[idx]!
      g1TpInj += bTpInj[idx]! - aTpInj[idx]!
      g1Org += bOrg[idx]! - aOrg[idx]!
      g1FpClean += bFpClean[idx]! - aFpClean[idx]!
      g1FpTot += bFpTot[idx]! - aFpTot[idx]!
    } else {
      // Paper `idx` swapped from B -> A in Group 1
      g1InjDet += aInjDet[idx]! - bInjDet[idx]!
      g1TpInj += aTpInj[idx]! - bTpInj[idx]!
      g1Org += aOrg[idx]! - bOrg[idx]!
      g1FpClean += aFpClean[idx]! - bFpClean[idx]!
      g1FpTot += aFpTot[idx]! - bFpTot[idx]!
    }
    prevGray = gray

    const cur = evalDel()
    if (Math.abs(cur.dRec) >= absObsRec) geRec++
    if (Math.abs(cur.dFpTot) >= absObsFpTot) geFpTot++
    if (Math.abs(cur.dFpClean) >= absObsFpClean) geFpClean++
    if (Math.abs(cur.dPInj) >= absObsPInj) gePInj++
    if (Math.abs(cur.dPOrg) >= absObsPOrg) gePOrg++
    if (Math.abs(cur.dF1Inj) >= absObsF1Inj) geF1Inj++
    if (Math.abs(cur.dF1Org) >= absObsF1Org) geF1Org++
  }

  return {
    regime_a: labelA,
    regime_b: labelB,
    papers_n: n,
    exact_permutations_enumerated: totalPerms,
    paired_injections_n: totalInj,
    observed_deltas_b_minus_a: {
      recall_pct_pts: Number((obs.dRec * 100).toFixed(1)),
      injected_errors_detected: obs.dDetInt,
      false_positive_total: obs.dFpTot,
      false_positive_clean: obs.dFpClean,
      precision_injected_only_pct_pts: Number((obs.dPInj * 100).toFixed(1)),
      precision_with_organic_tp_pct_pts: Number((obs.dPOrg * 100).toFixed(1)),
      f1_injected_only_pct_pts: Number((obs.dF1Inj * 100).toFixed(1)),
      f1_with_organic_tp_pct_pts: Number((obs.dF1Org * 100).toFixed(1)),
    },
    exact_paired_permutation_two_sided_p: {
      recall_p: Number((geRec / totalPerms).toFixed(6)),
      false_positive_total_p: Number((geFpTot / totalPerms).toFixed(6)),
      false_positive_clean_p: Number((geFpClean / totalPerms).toFixed(6)),
      precision_injected_only_p: Number((gePInj / totalPerms).toFixed(6)),
      precision_with_organic_tp_p: Number((gePOrg / totalPerms).toFixed(6)),
      f1_injected_only_p: Number((geF1Inj / totalPerms).toFixed(6)),
      f1_with_organic_tp_p: Number((geF1Org / totalPerms).toFixed(6)),
    },
    mcnemar_on_injections: {
      both_detected: mcnemarBothDet,
      only_a_detected: mcnemarOnlyA,
      only_b_detected: mcnemarOnlyB,
      both_missed: mcnemarBothMiss,
      discordant_pairs: mcnemarOnlyA + mcnemarOnlyB,
      exact_two_sided_p: exactMcNemarTwoSidedP(mcnemarOnlyA, mcnemarOnlyB),
    },
  }
}

/**
 * Strip trailing bibliography (`## References` and post-bibliography boilerplate) while keeping 100%
 * of manuscript prose, headings, figure/table captions, full 2D Markdown tables, and footnotes.
 */
function prepareFullManuscriptWith2dTables(markdown: string, title: string): string {
  const refMatch = /\n##+\s*(?:\d+\.?\s*)?References\s*\n/i.exec(markdown)
  const body = (refMatch ? markdown.slice(0, refMatch.index) : markdown).trim()
  return body.startsWith('# ') ? body : `# ${title}\n\n${body}`
}

/**
 * Clean-room anchor resolver: if the LLM quoted a short table cell/substring rather than the full
 * Markdown table row `| ... |`, resolve `anchor` to the matching Markdown table row from `markdown`
 * (mirroring `ClaimService.resolveTargetNodeAndSnippet` without touching any evaluation labels).
 */
function resolveVerbatimAnchor(markdown: string, sentence: string): string {
  const trimmed = sentence.trim()
  if (!trimmed) return trimmed
  if (trimmed.startsWith('|') && trimmed.length >= 40) return trimmed

  const normS = normText(trimmed)
  if (normS.length < 8) return trimmed

  const lines = markdown.split('\n')
  const matchingTableRows: string[] = []
  for (const line of lines) {
    const tl = line.trim()
    if (!tl.startsWith('|')) continue
    if (tl.includes(trimmed) || normText(tl).includes(normS)) {
      matchingTableRows.push(tl)
    }
  }
  if (matchingTableRows.length === 1) return matchingTableRows[0]!
  return trimmed
}

function extractJsonArrayFromText(rawText: string): { ok: boolean; items: any[] } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawText)
  const candidates = [fenced ? fenced[1]!.trim() : '', rawText.trim()].filter(Boolean)

  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand)
      if (Array.isArray(parsed)) return { ok: true, items: parsed }
      if (parsed && typeof parsed === 'object') {
        const arr = (parsed as any).issues ?? (parsed as any).findings ?? (parsed as any).errors
        if (Array.isArray(arr)) return { ok: true, items: arr }
      }
    } catch {
      /* fallback to bracket search */
    }

    if (/\[\s*\]/.test(cand) && !cand.includes('{')) {
      return { ok: true, items: [] }
    }

    const objArrStart = /\[\s*\{/.exec(cand)
    const lastBracket = cand.lastIndexOf(']')
    if (objArrStart && lastBracket > objArrStart.index) {
      const slice = cand.slice(objArrStart.index, lastBracket + 1)
      try {
        const parsed = JSON.parse(slice)
        if (Array.isArray(parsed)) return { ok: true, items: parsed }
      } catch {
        /* continue */
      }
    }
  }
  return { ok: false, items: [] }
}

function parseSinglePassFindings(rawText: string, markdown: string, sourcePass: string): { ok: boolean; findings: RunFinding[] } {
  const { ok, items } = extractJsonArrayFromText(rawText)
  if (!ok) return { ok: false, findings: [] }

  const seenKeys = new Set<string>()
  const findings: RunFinding[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const sentence = String(item.sentence ?? item.quote ?? '').trim()
    const reason = String(item.reason ?? '').trim()
    if (!sentence || !reason) continue

    const catRaw = String(item.category ?? 'internal_inconsistency').trim()
    const category =
      catRaw === 'internal_inconsistency' ||
      catRaw === 'method_result_mismatch' ||
      catRaw === 'spin_or_guideline' ||
      catRaw === 'citation_distortion'
        ? catRaw
        : 'internal_inconsistency'
    const sevRaw = String(item.severity ?? 'major').trim().toLowerCase()
    const severity: 'critical' | 'major' | 'minor' =
      sevRaw === 'critical' || sevRaw === 'major' || sevRaw === 'minor' ? sevRaw : 'major'
    const suggestion = String(item.suggestion ?? 'Please verify and align the reported values across text and tables.').trim()
    const evidence = (Array.isArray(item.evidence) ? item.evidence : item.evidence ? [item.evidence] : [])
      .map((e: unknown) => String(e).trim())
      .filter(Boolean)
      .slice(0, 4)

    const fKey = findingKey({ category, subtype: null, sentence })
    if (seenKeys.has(fKey)) continue
    seenKeys.add(fKey)

    findings.push({
      finding_key: fKey,
      severity,
      category,
      subtype: null,
      source_pass: sourcePass,
      section_title: null,
      sentence,
      anchor: resolveVerbatimAnchor(markdown, sentence),
      reason,
      suggestion,
      ...(evidence.length > 0 ? { evidence } : {}),
    })
  }
  return { ok: true, findings }
}

async function runSinglePassFrontierReview(opts: {
  model: 'deepseek-reasoner' | 'deepseek-chat'
  title: string
  markdown: string
  sourcePass: string
}): Promise<{
  findings: RunFinding[]
  telemetry: ModelTelemetryBucket
}> {
  const fullDoc = prepareFullManuscriptWith2dTables(opts.markdown, opts.title)
  const upstreamUrl = config.llmUpstream.replace(/\/$/, '') + '/messages'
  const isReasoner = opts.model === 'deepseek-reasoner'
  const bucket = emptyBucket()

  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const t0 = Date.now()
      const payload: Record<string, unknown> = {
        model: opts.model,
        max_tokens: isReasoner ? 64000 : 8000,
        ...(isReasoner ? { thinking: { type: 'enabled', budget_tokens: 48000 } } : { temperature: 0 }),
        system: FRONTIER_FULL_CONTEXT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: fullDoc }],
      }
      const res = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.deepseekApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(isReasoner ? 660_000 : 240_000),
      })
      if (!res.ok) {
        const errBody = (await res.text()).slice(0, 300)
        throw new Error(`HTTP ${res.status} from ${opts.model}: ${errBody}`)
      }
      const body = (await res.json()) as {
        stop_reason?: string
        content?: Array<{ type: string; text?: string; thinking?: string }>
        usage?: { input_tokens?: number; output_tokens?: number }
      }
      const ms = Date.now() - t0
      const inTok = body.usage?.input_tokens ?? 0
      const outTok = body.usage?.output_tokens ?? 0
      const thinkingChars = (body.content ?? [])
        .filter(c => c.type === 'thinking')
        .reduce((acc, c) => acc + (c.thinking?.length ?? 0), 0)
      const textOut = (body.content ?? [])
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .join('')
      const truncated = body.stop_reason === 'max_tokens'

      addBucket(bucket, {
        calls: 1,
        input_tokens: inTok,
        output_tokens: outTok,
        ms,
        truncated_calls: truncated ? 1 : 0,
        ...(isReasoner ? { thinking_chars: thinkingChars } : {}),
      })

      const parsed = parseSinglePassFindings(textOut, opts.markdown, opts.sourcePass)
      if (!parsed.ok) {
        throw new Error(`Failed to parse JSON findings from ${opts.model} (stop_reason=${body.stop_reason}, textLen=${textOut.length})`)
      }
      return { findings: parsed.findings, telemetry: bucket }
    } catch (err) {
      lastErr = err as Error
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)))
      }
    }
  }
  throw lastErr!
}

/**
 * Dedicated `Complete` wrapper for `deepseek-reasoner` (DeepSeek-R1) acting as 3rd Cross-Paradigm
 * Blind Clinician Judge (`max_tokens: 8000`, `thinking: { type: 'enabled', budget_tokens: 6000 }`,
 * omitting `temperature` for native CoT, and validating JSON output before returning so
 * `simulateBlindClinician` never falls back on transient truncation/network hiccups).
 */
function makeReasonerJudgeComplete(bucket: ModelTelemetryBucket): Complete {
  const upstreamUrl = config.llmUpstream.replace(/\/$/, '') + '/messages'
  return async (system: string, user: string): Promise<string> => {
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const t0 = Date.now()
        const maxTokens = attempt < 2 ? 8000 : 16000
        const budgetTokens = attempt < 2 ? 6000 : 12000
        const res = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.deepseekApiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'deepseek-reasoner',
            max_tokens: maxTokens,
            thinking: { type: 'enabled', budget_tokens: budgetTokens },
            system,
            messages: [{ role: 'user', content: user }],
          }),
          signal: AbortSignal.timeout(240_000),
        })
        if (!res.ok) {
          const errBody = (await res.text()).slice(0, 300)
          throw new Error(`HTTP ${res.status} from deepseek-reasoner judge: ${errBody}`)
        }
        const body = (await res.json()) as {
          stop_reason?: string
          content?: Array<{ type: string; text?: string; thinking?: string }>
          usage?: { input_tokens?: number; output_tokens?: number }
        }
        const ms = Date.now() - t0
        const inTok = body.usage?.input_tokens ?? 0
        const outTok = body.usage?.output_tokens ?? 0
        const thinkingChars = (body.content ?? [])
          .filter(c => c.type === 'thinking')
          .reduce((acc, c) => acc + (c.thinking?.length ?? 0), 0)
        const textOut = (body.content ?? [])
          .filter(c => c.type === 'text')
          .map(c => c.text ?? '')
          .join('')
        const truncated = body.stop_reason === 'max_tokens'

        addBucket(bucket, {
          calls: 1,
          input_tokens: inTok,
          output_tokens: outTok,
          ms,
          thinking_chars: thinkingChars,
          truncated_calls: truncated ? 1 : 0,
        })

        const m = /\{[\s\S]*\}/.exec(textOut.replace(/```(?:json)?/g, '').trim())
        if (!m) {
          throw new Error(`Empty/non-JSON clinician output from deepseek-reasoner (stop=${body.stop_reason})`)
        }
        const parsed = JSON.parse(m[0]) as { decision?: string }
        if (parsed.decision !== 'accept_fix' && parsed.decision !== 'rebut_false_positive') {
          throw new Error(`Unexpected decision field from deepseek-reasoner: ${String(parsed.decision)}`)
        }
        return textOut
      } catch (err) {
        lastErr = err as Error
        if (attempt < 3) await new Promise(r => setTimeout(r, 2500 * (attempt + 1)))
      }
    }
    throw lastErr!
  }
}

function makeTrackedComplete(model: string, bucket: ModelTelemetryBucket, timeoutMs = 240_000): Complete {
  const fn = makeComplete({
    upstream: config.llmUpstream,
    apiKey: config.deepseekApiKey,
    model,
    timeoutMs,
    onUsage: (u: CompleteUsage) => {
      bucket.calls++
      bucket.input_tokens += u.input_tokens
      bucket.output_tokens += u.output_tokens
      bucket.ms += u.ms
    },
  })
  if (!fn) throw new Error(`Missing DEEPSEEK_API_KEY when constructing Complete for ${model}`)
  return fn
}

async function reviewOnceReliable(
  markdown: string,
  title: string,
  model: string,
  sharedStore?: Store,
  opts: {
    mode?: ReviewEvalMode
    docId?: string
    ablation?: {
      disableStructAst?: boolean
      disable2dTableGrid?: boolean
      disableDualQuoteGate?: boolean
      disableStage4Verifier?: boolean
      disableTrackARules?: boolean
      disableAuditChecklists?: boolean
      unfilteredGlobalRulePrompt?: boolean
    }
  } = {},
): Promise<{
  findings: RunFinding[]
  store: Store
  docId: string
  telemetry: ModelTelemetryBucket
}> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const bucket = emptyBucket()
    const complete = makeTrackedComplete(model, bucket)
    const res = await reviewOnce(markdown, title, true, sharedStore, {
      ...opts,
      complete,
    })
    if (res.ok) {
      return {
        findings: res.findings,
        store: res.store,
        docId: res.docId,
        telemetry: bucket,
      }
    }
    lastErr = new Error(`reviewOnce(${model}, ${opts.mode ?? 'heurion_evolved'}) failed: ${res.error}`)
    if (attempt < 2) await new Promise(r => setTimeout(r, 3000 * (attempt + 1)))
  }
  throw lastErr!
}

export interface ClinicianCalibrationSummary {
  judge_model: string
  reviewer_model: string
  physically_blind_to_variant_and_labels: true
  papers_evaluated: number
  manuscripts_evaluated: number
  total_findings_judged: number
  ground_truth_true_errors_seen: number
  true_errors_accepted_fix: number
  true_error_acceptance_rate_pct: number | null
  true_error_acceptance_wilson_95ci: [number, number] | null
  true_errors_falsely_rebutted: number
  false_rebuttal_rate_pct: number | null
  false_positives_seen: number
  false_positives_rebutted: number
  false_positive_rebuttal_rate_pct: number | null
  false_positive_rebuttal_wilson_95ci: [number, number] | null
  raw_clinician_rebuttals_containing_digits: number
  first_draft_llm_digit_or_specialty_leaks_scrubbed: number
  post_guard_instance_leakage_count: number
}

type JudgeParadigmKey = 'v4_flash' | 'deepseek_chat' | 'deepseek_reasoner'

interface TripleJudgeItem {
  paper_id: string
  split: 'dev' | 'test'
  variant: 'clean' | 'injected'
  finding_key: string
  category: string
  severity: 'critical' | 'major' | 'minor'
  is_ground_truth_error: boolean
  v4_flash_decision: 'accept_fix' | 'rebut_false_positive'
  deepseek_chat_decision: 'accept_fix' | 'rebut_false_positive'
  deepseek_reasoner_decision: 'accept_fix' | 'rebut_false_positive'
  v4_raw_digits: boolean
  chat_raw_digits: boolean
  reasoner_raw_digits: boolean
  v4_first_draft_scrubbed: boolean
  chat_first_draft_scrubbed: boolean
  v4_leak_after_guard: boolean
  chat_leak_after_guard: boolean
}

function getDecisionForJudge(it: TripleJudgeItem, which: JudgeParadigmKey): 'accept_fix' | 'rebut_false_positive' {
  if (which === 'v4_flash') return it.v4_flash_decision
  if (which === 'deepseek_chat') return it.deepseek_chat_decision
  return it.deepseek_reasoner_decision
}

function judgeModelName(which: JudgeParadigmKey): string {
  if (which === 'v4_flash') return 'deepseek-v4-flash'
  if (which === 'deepseek_chat') return 'deepseek-chat'
  return 'deepseek-reasoner'
}

function summarizeCalibrationFromTriple(
  items: TripleJudgeItem[],
  which: JudgeParadigmKey,
  papersCount: number,
): ClinicianCalibrationSummary {
  let trueErrTotal = 0
  let trueErrAccept = 0
  let trueErrFalseRebut = 0
  let fpTotal = 0
  let fpRebut = 0
  let rawDigits = 0
  let scrubbed = 0
  let postLeak = 0

  for (const it of items) {
    const dec = getDecisionForJudge(it, which)
    const hadDigits =
      which === 'v4_flash'
        ? it.v4_raw_digits
        : which === 'deepseek_chat'
          ? it.chat_raw_digits
          : it.reasoner_raw_digits
    const wasScrubbed =
      which === 'v4_flash'
        ? it.v4_first_draft_scrubbed
        : which === 'deepseek_chat'
          ? it.chat_first_draft_scrubbed
          : false
    const leaked =
      which === 'v4_flash'
        ? it.v4_leak_after_guard
        : which === 'deepseek_chat'
          ? it.chat_leak_after_guard
          : false

    if (it.is_ground_truth_error) {
      trueErrTotal++
      if (dec === 'accept_fix') trueErrAccept++
      else trueErrFalseRebut++
    } else {
      fpTotal++
      if (dec === 'rebut_false_positive') fpRebut++
    }
    if (dec === 'rebut_false_positive' && hadDigits) rawDigits++
    if (wasScrubbed) scrubbed++
    if (leaked) postLeak++
  }

  return {
    judge_model: judgeModelName(which),
    reviewer_model: 'deepseek-v4-flash',
    physically_blind_to_variant_and_labels: true,
    papers_evaluated: papersCount,
    manuscripts_evaluated: papersCount * 2,
    total_findings_judged: items.length,
    ground_truth_true_errors_seen: trueErrTotal,
    true_errors_accepted_fix: trueErrAccept,
    true_error_acceptance_rate_pct:
      trueErrTotal > 0 ? Number(((trueErrAccept / trueErrTotal) * 100).toFixed(1)) : null,
    true_error_acceptance_wilson_95ci: trueErrTotal > 0 ? wilson95CI(trueErrAccept, trueErrTotal) : null,
    true_errors_falsely_rebutted: trueErrFalseRebut,
    false_rebuttal_rate_pct:
      trueErrTotal > 0 ? Number(((trueErrFalseRebut / trueErrTotal) * 100).toFixed(1)) : null,
    false_positives_seen: fpTotal,
    false_positives_rebutted: fpRebut,
    false_positive_rebuttal_rate_pct:
      fpTotal > 0 ? Number(((fpRebut / fpTotal) * 100).toFixed(1)) : null,
    false_positive_rebuttal_wilson_95ci: fpTotal > 0 ? wilson95CI(fpRebut, fpTotal) : null,
    raw_clinician_rebuttals_containing_digits: rawDigits,
    first_draft_llm_digit_or_specialty_leaks_scrubbed: scrubbed,
    post_guard_instance_leakage_count: postLeak,
  }
}

export interface PairwiseJudgeConcordance {
  judge_1: string
  judge_2: string
  paired_findings_n: number
  confusion_matrix: {
    both_accept_fix: number
    j1_accept_j2_rebut: number
    j1_rebut_j2_accept: number
    both_rebut_false_positive: number
  }
  raw_agreement_pct: number
  expected_chance_agreement_pct: number
  cohens_kappa: number
  cohens_kappa_se: number
  cohens_kappa_95ci: [number, number]
  pabak: number
  positive_agreement_accept_fix_pct: number
  negative_agreement_rebut_fp_pct: number
}

function computePairwiseConcordance(
  items: TripleJudgeItem[],
  j1: JudgeParadigmKey,
  j2: JudgeParadigmKey,
): PairwiseJudgeConcordance {
  let a = 0 // both accept_fix
  let b = 0 // j1 accept_fix, j2 rebut_false_positive
  let c = 0 // j1 rebut_false_positive, j2 accept_fix
  let d = 0 // both rebut_false_positive

  for (const it of items) {
    const d1 = getDecisionForJudge(it, j1)
    const d2 = getDecisionForJudge(it, j2)
    if (d1 === 'accept_fix' && d2 === 'accept_fix') a++
    else if (d1 === 'accept_fix' && d2 === 'rebut_false_positive') b++
    else if (d1 === 'rebut_false_positive' && d2 === 'accept_fix') c++
    else d++
  }

  const n = a + b + c + d
  if (n === 0) {
    return {
      judge_1: judgeModelName(j1),
      judge_2: judgeModelName(j2),
      paired_findings_n: 0,
      confusion_matrix: { both_accept_fix: 0, j1_accept_j2_rebut: 0, j1_rebut_j2_accept: 0, both_rebut_false_positive: 0 },
      raw_agreement_pct: 100,
      expected_chance_agreement_pct: 100,
      cohens_kappa: 1,
      cohens_kappa_se: 0,
      cohens_kappa_95ci: [1, 1],
      pabak: 1,
      positive_agreement_accept_fix_pct: 100,
      negative_agreement_rebut_fp_pct: 100,
    }
  }

  const p11 = a / n
  const p12 = b / n
  const p21 = c / n
  const p22 = d / n
  const p1dot = p11 + p12
  const p2dot = p21 + p22
  const pdot1 = p11 + p21
  const pdot2 = p12 + p22

  const po = p11 + p22
  const pe = p1dot * pdot1 + p2dot * pdot2
  const kappa = pe < 1 ? (po - pe) / (1 - pe) : 1

  // Exact Fleiss-Cohen-Everitt (1969) asymptotic variance of Cohen's kappa
  let se = 0
  if (pe < 1) {
    const termA =
      p11 * Math.pow(1 - (p1dot + pdot1) * (1 - kappa), 2) +
      p22 * Math.pow(1 - (p2dot + pdot2) * (1 - kappa), 2)
    const termB =
      Math.pow(1 - kappa, 2) *
      (p12 * Math.pow(pdot1 + p2dot, 2) + p21 * Math.pow(pdot2 + p1dot, 2))
    const termC = Math.pow(kappa - pe * (1 - kappa), 2)
    const variance = (termA + termB - termC) / (n * Math.pow(1 - pe, 2))
    se = Math.sqrt(Math.max(0, variance))
  }

  const ciLow = Math.max(-1, kappa - 1.96 * se)
  const ciHigh = Math.min(1, kappa + 1.96 * se)
  const pabak = 2 * po - 1
  const posAgree = 2 * a + b + c > 0 ? (2 * a) / (2 * a + b + c) : 1
  const negAgree = 2 * d + b + c > 0 ? (2 * d) / (2 * d + b + c) : 1

  return {
    judge_1: judgeModelName(j1),
    judge_2: judgeModelName(j2),
    paired_findings_n: n,
    confusion_matrix: {
      both_accept_fix: a,
      j1_accept_j2_rebut: b,
      j1_rebut_j2_accept: c,
      both_rebut_false_positive: d,
    },
    raw_agreement_pct: Number((po * 100).toFixed(1)),
    expected_chance_agreement_pct: Number((pe * 100).toFixed(1)),
    cohens_kappa: Number(kappa.toFixed(4)),
    cohens_kappa_se: Number(se.toFixed(4)),
    cohens_kappa_95ci: [Number(ciLow.toFixed(4)), Number(ciHigh.toFixed(4))],
    pabak: Number(pabak.toFixed(4)),
    positive_agreement_accept_fix_pct: Number((posAgree * 100).toFixed(1)),
    negative_agreement_rebut_fp_pct: Number((negAgree * 100).toFixed(1)),
  }
}

export interface ThreeRaterFleissConcordance {
  raters: [string, string, string]
  findings_n: number
  raters_m: 3
  vote_distribution: {
    unanimous_3_accept_fix: number
    split_2_accept_1_rebut: number
    split_1_accept_2_rebut: number
    unanimous_3_rebut_false_positive: number
  }
  unanimous_3_of_3_count: number
  unanimous_3_of_3_pct: number
  mean_pairwise_observed_agreement_pct: number
  expected_chance_agreement_pct: number
  fleiss_kappa: number
  /** Exact leave-one-finding-out jackknife empirical SE (Kraemer 1980 / Gwet 2014) for non-null 95% CI */
  fleiss_kappa_se: number
  fleiss_kappa_95ci: [number, number]
  /** Fleiss-Nee-Landis (1979) asymptotic SE under H0: kappa = 0 */
  fleiss_kappa_null_se: number
  fleiss_kappa_z: number
}

/**
 * Exact 3-rater Fleiss' kappa across (`deepseek-v4-flash`, `deepseek-chat`, `deepseek-reasoner`)
 * with both leave-one-item-out jackknife non-null SE (for 95% CI) and Fleiss-Nee-Landis (1979) null SE.
 */
function computeFleissKappa3Raters(items: TripleJudgeItem[]): ThreeRaterFleissConcordance {
  const n = items.length
  const raters: [string, string, string] = ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner']
  if (n === 0) {
    return {
      raters,
      findings_n: 0,
      raters_m: 3,
      vote_distribution: {
        unanimous_3_accept_fix: 0,
        split_2_accept_1_rebut: 0,
        split_1_accept_2_rebut: 0,
        unanimous_3_rebut_false_positive: 0,
      },
      unanimous_3_of_3_count: 0,
      unanimous_3_of_3_pct: 100,
      mean_pairwise_observed_agreement_pct: 100,
      expected_chance_agreement_pct: 100,
      fleiss_kappa: 1,
      fleiss_kappa_se: 0,
      fleiss_kappa_95ci: [1, 1],
      fleiss_kappa_null_se: 0,
      fleiss_kappa_z: 0,
    }
  }

  const m = 3
  const acceptCounts = new Int32Array(n)
  const itemPi = new Float64Array(n)
  let sumN1 = 0
  let sumPi = 0
  let v3Accept = 0
  let v2Accept1Rebut = 0
  let v1Accept2Rebut = 0
  let v3Rebut = 0

  for (let i = 0; i < n; i++) {
    const it = items[i]!
    const n1 =
      (it.v4_flash_decision === 'accept_fix' ? 1 : 0) +
      (it.deepseek_chat_decision === 'accept_fix' ? 1 : 0) +
      (it.deepseek_reasoner_decision === 'accept_fix' ? 1 : 0)
    const n2 = m - n1
    acceptCounts[i] = n1
    sumN1 += n1
    if (n1 === 3) v3Accept++
    else if (n1 === 2) v2Accept1Rebut++
    else if (n1 === 1) v1Accept2Rebut++
    else v3Rebut++

    const pi = (n1 * n1 + n2 * n2 - m) / (m * (m - 1))
    itemPi[i] = pi
    sumPi += pi
  }

  const p1 = sumN1 / (n * m)
  const p2 = 1 - p1
  const pbar = sumPi / n
  const pe = p1 * p1 + p2 * p2
  const kappa = pe < 1 ? (pbar - pe) / (1 - pe) : 1

  // Leave-one-item-out jackknife empirical SE (Kraemer 1980 / Gwet 2014)
  let jackSe = 0
  if (n >= 2 && pe < 1) {
    const looKappas = new Float64Array(n)
    let looSum = 0
    for (let i = 0; i < n; i++) {
      const pbarMinus = (sumPi - itemPi[i]!) / (n - 1)
      const p1Minus = (sumN1 - acceptCounts[i]!) / ((n - 1) * m)
      const p2Minus = 1 - p1Minus
      const peMinus = p1Minus * p1Minus + p2Minus * p2Minus
      const kMinus = peMinus < 1 ? (pbarMinus - peMinus) / (1 - peMinus) : 1
      looKappas[i] = kMinus
      looSum += kMinus
    }
    const looMean = looSum / n
    let sqDiffSum = 0
    for (let i = 0; i < n; i++) {
      const d = looKappas[i]! - looMean
      sqDiffSum += d * d
    }
    jackSe = Math.sqrt(Math.max(0, ((n - 1) / n) * sqDiffSum))
  }

  // Fleiss-Nee-Landis (1979) asymptotic null SE under H0: kappa = 0
  let nullSe = 0
  if (pe < 1) {
    const sumP3 = p1 * p1 * p1 + p2 * p2 * p2
    const nullVar =
      (2 / (n * m * (m - 1))) *
      ((pe - (2 * m - 3) * pe * pe + 2 * (m - 2) * sumP3) / Math.pow(1 - pe, 2))
    nullSe = Math.sqrt(Math.max(0, nullVar))
  }

  const ciLow = Math.max(-1, kappa - 1.96 * jackSe)
  const ciHigh = Math.min(1, kappa + 1.96 * jackSe)
  const unanimous = v3Accept + v3Rebut

  return {
    raters,
    findings_n: n,
    raters_m: 3,
    vote_distribution: {
      unanimous_3_accept_fix: v3Accept,
      split_2_accept_1_rebut: v2Accept1Rebut,
      split_1_accept_2_rebut: v1Accept2Rebut,
      unanimous_3_rebut_false_positive: v3Rebut,
    },
    unanimous_3_of_3_count: unanimous,
    unanimous_3_of_3_pct: Number(((unanimous / n) * 100).toFixed(1)),
    mean_pairwise_observed_agreement_pct: Number((pbar * 100).toFixed(1)),
    expected_chance_agreement_pct: Number((pe * 100).toFixed(1)),
    fleiss_kappa: Number(kappa.toFixed(4)),
    fleiss_kappa_se: Number(jackSe.toFixed(4)),
    fleiss_kappa_95ci: [Number(ciLow.toFixed(4)), Number(ciHigh.toFixed(4))],
    fleiss_kappa_null_se: Number(nullSe.toFixed(4)),
    fleiss_kappa_z: nullSe > 0 ? Number((kappa / nullSe).toFixed(2)) : 0,
  }
}

function sanitizeCachedDecisions(decs: BlindClinicianDecision[]): {
  sanitized: BlindClinicianDecision[]
  specialtyLeaksScrubbed: number
} {
  let specialtyLeaksScrubbed = 0
  const sanitized = decs.map(d => {
    if (!d.distilledRule) return d
    const hadPreScrubLeak = hasInstanceLeakage(d.distilledRule)
    const scrubbedRule = scrubSpecialtyExampleLeakage(d.distilledRule)
    if (hadPreScrubLeak && scrubbedRule !== d.distilledRule) {
      specialtyLeaksScrubbed++
    }
    const postGuardLeak = hasInstanceLeakage(scrubbedRule)
    if (postGuardLeak) {
      throw new Error(`Post-guard instance leakage persisted after scrubSpecialtyExampleLeakage: ${scrubbedRule}`)
    }
    return {
      ...d,
      distilledRule: scrubbedRule,
      firstDraftLeaked: Boolean(d.firstDraftLeaked || hadPreScrubLeak),
      instanceLeakageAfterGuard: false,
    }
  })
  return { sanitized, specialtyLeaksScrubbed }
}

async function main() {
  const runStartMs = Date.now()
  if (!config.deepseekApiKey) {
    throw new Error('DEEPSEEK_API_KEY is required in runtime environment variables for live frontier & cross-judge evaluation.')
  }

  const adjMap = readAdjudications()
  const knownOrganic = readKnownOrganicErrors()
  const allPapers = readManifest()
  const devPapers = allPapers.filter(p => p.split === 'dev')
  const testPapers = allPapers.filter(p => p.split === 'test')
  const orderedPapers = [...devPapers, ...testPapers]

  const globalTelemetryByModel: Record<string, ModelTelemetryBucket> = {
    'deepseek-reasoner': emptyBucket(),
    'deepseek-chat': emptyBucket(),
    'deepseek-v4-flash': emptyBucket(),
  }
  const regimeTelemetry: Record<string, ModelTelemetryBucket> = {
    b1_full_context_deepseek_reasoner: emptyBucket(),
    b2_full_context_deepseek_chat: emptyBucket(),
    b3_heurion_deep_deepseek_chat: emptyBucket(),
    p2_r1_heurion_deep_v4_flash: emptyBucket(),
    p2_judge_deepseek_chat_on_r1: emptyBucket(),
    p2_judge_v4_flash_on_r1: emptyBucket(),
    p2d_judge_deepseek_reasoner_on_r1: emptyBucket(),
    p2_intra_round2_cross_judge: emptyBucket(),
    p2c_dev_evolution_v4_reviewer: emptyBucket(),
    p2c_dev_evolution_chat_judge: emptyBucket(),
    p2c_test_frozen_selective_track_a_only: emptyBucket(),
    p2c_test_frozen_selective_full: emptyBucket(),
  }

  console.log(
    `[Frontier & 3-Way Cross-Judge Live Benchmark] Papers=${orderedPapers.length} (dev=${devPapers.length}, test=${testPapers.length}), ckptDir=${CKPT_DIR}`,
  )

  // ============================================================================
  // PHASE B1: `full_context_deepseek_reasoner` (DeepSeek-R1 Single-Pass Full Manuscript + Full 2D Tables)
  // ============================================================================
  const b1ReasonerMap = new Map<string, { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }>()
  let doneB1 = 0
  await mapConcurrent(orderedPapers, REASONER_PAPER_CONCURRENCY, async p => {
    const injections = readInjections(p.id)
    const ckptKey = `b1_reasoner_${p.id}`
    const cached = readCkpt<{
      cleanFindings: RunFinding[]
      injectedFindings: RunFinding[]
      telemetry: ModelTelemetryBucket
    }>(ckptKey)
    if (cached) {
      addBucket(globalTelemetryByModel['deepseek-reasoner']!, cached.telemetry)
      addBucket(regimeTelemetry.b1_full_context_deepseek_reasoner!, cached.telemetry)
      b1ReasonerMap.set(p.id, {
        cleanFindings: cached.cleanFindings,
        injectedFindings: cached.injectedFindings,
        injections,
      })
      console.log(`[B1 reasoner ${++doneB1}/${orderedPapers.length}] ${p.id} (cached) clean=${cached.cleanFindings.length} inj=${cached.injectedFindings.length}`)
      return
    }

    const cleanMd = loadOrSynthesizePaperMarkdown(p, 'clean')
    const injectedMd = loadOrSynthesizePaperMarkdown(p, 'injected')
    const [cleanRes, injRes] = await Promise.all([
      runSinglePassFrontierReview({
        model: 'deepseek-reasoner',
        title: p.title,
        markdown: cleanMd,
        sourcePass: 'full_context_deepseek_reasoner',
      }),
      runSinglePassFrontierReview({
        model: 'deepseek-reasoner',
        title: p.title,
        markdown: injectedMd,
        sourcePass: 'full_context_deepseek_reasoner',
      }),
    ])

    const combinedTel = emptyBucket()
    addBucket(combinedTel, cleanRes.telemetry)
    addBucket(combinedTel, injRes.telemetry)
    writeCkpt(ckptKey, {
      cleanFindings: cleanRes.findings,
      injectedFindings: injRes.findings,
      telemetry: combinedTel,
    })

    addBucket(globalTelemetryByModel['deepseek-reasoner']!, combinedTel)
    addBucket(regimeTelemetry.b1_full_context_deepseek_reasoner!, combinedTel)
    b1ReasonerMap.set(p.id, {
      cleanFindings: cleanRes.findings,
      injectedFindings: injRes.findings,
      injections,
    })
    console.log(
      `[B1 reasoner ${++doneB1}/${orderedPapers.length}] ${p.id} clean=${cleanRes.findings.length} inj=${injRes.findings.length} outTok=${combinedTel.output_tokens} (${(Math.max(cleanRes.telemetry.ms, injRes.telemetry.ms) / 1000).toFixed(1)}s)`,
    )
  })

  // ============================================================================
  // PHASE B2: `full_context_deepseek_chat` (DeepSeek-V3 Single-Pass Full Manuscript + Full 2D Tables)
  // ============================================================================
  const b2ChatFullMap = new Map<string, { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }>()
  let doneB2 = 0
  await mapConcurrent(orderedPapers, CHAT_PAPER_CONCURRENCY, async p => {
    const injections = readInjections(p.id)
    const ckptKey = `b2_chat_full_${p.id}`
    const cached = readCkpt<{
      cleanFindings: RunFinding[]
      injectedFindings: RunFinding[]
      telemetry: ModelTelemetryBucket
    }>(ckptKey)
    if (cached) {
      const telWithTrunc: ModelTelemetryBucket = {
        ...cached.telemetry,
        truncated_calls: cached.telemetry.truncated_calls ?? 0,
      }
      addBucket(globalTelemetryByModel['deepseek-chat']!, telWithTrunc)
      addBucket(regimeTelemetry.b2_full_context_deepseek_chat!, telWithTrunc)
      b2ChatFullMap.set(p.id, {
        cleanFindings: cached.cleanFindings,
        injectedFindings: cached.injectedFindings,
        injections,
      })
      console.log(`[B2 chat_full ${++doneB2}/${orderedPapers.length}] ${p.id} (cached) clean=${cached.cleanFindings.length} inj=${cached.injectedFindings.length}`)
      return
    }

    const cleanMd = loadOrSynthesizePaperMarkdown(p, 'clean')
    const injectedMd = loadOrSynthesizePaperMarkdown(p, 'injected')
    const [cleanRes, injRes] = await Promise.all([
      runSinglePassFrontierReview({
        model: 'deepseek-chat',
        title: p.title,
        markdown: cleanMd,
        sourcePass: 'full_context_deepseek_chat',
      }),
      runSinglePassFrontierReview({
        model: 'deepseek-chat',
        title: p.title,
        markdown: injectedMd,
        sourcePass: 'full_context_deepseek_chat',
      }),
    ])

    const combinedTel = emptyBucket()
    addBucket(combinedTel, cleanRes.telemetry)
    addBucket(combinedTel, injRes.telemetry)
    writeCkpt(ckptKey, {
      cleanFindings: cleanRes.findings,
      injectedFindings: injRes.findings,
      telemetry: combinedTel,
    })

    addBucket(globalTelemetryByModel['deepseek-chat']!, combinedTel)
    addBucket(regimeTelemetry.b2_full_context_deepseek_chat!, combinedTel)
    b2ChatFullMap.set(p.id, {
      cleanFindings: cleanRes.findings,
      injectedFindings: injRes.findings,
      injections,
    })
    console.log(
      `[B2 chat_full ${++doneB2}/${orderedPapers.length}] ${p.id} clean=${cleanRes.findings.length} inj=${injRes.findings.length} (${(Math.max(cleanRes.telemetry.ms, injRes.telemetry.ms) / 1000).toFixed(1)}s)`,
    )
  })

  // ============================================================================
  // PHASE B3: `heurion_deep_deepseek_chat` (Heurion 4-Stage Hybrid Pipeline on `deepseek-chat`)
  // ============================================================================
  const b3HeurionDeepChatMap = new Map<string, { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }>()
  let doneB3 = 0
  await mapConcurrent(orderedPapers, CHAT_PAPER_CONCURRENCY, async p => {
    const injections = readInjections(p.id)
    const ckptKey = `b3_heurion_deep_chat_${p.id}`
    const cached = readCkpt<{
      cleanFindings: RunFinding[]
      injectedFindings: RunFinding[]
      telemetry: ModelTelemetryBucket
    }>(ckptKey)
    if (cached) {
      addBucket(globalTelemetryByModel['deepseek-chat']!, cached.telemetry)
      addBucket(regimeTelemetry.b3_heurion_deep_deepseek_chat!, cached.telemetry)
      b3HeurionDeepChatMap.set(p.id, {
        cleanFindings: cached.cleanFindings,
        injectedFindings: cached.injectedFindings,
        injections,
      })
      console.log(`[B3 heurion_deep_chat ${++doneB3}/${orderedPapers.length}] ${p.id} (cached) clean=${cached.cleanFindings.length} inj=${cached.injectedFindings.length}`)
      return
    }

    const cleanMd = loadOrSynthesizePaperMarkdown(p, 'clean')
    const injectedMd = loadOrSynthesizePaperMarkdown(p, 'injected')
    const [cleanRes, injRes] = await Promise.all([
      reviewOnceReliable(cleanMd, p.title, 'deepseek-chat', undefined, { mode: 'heurion_deep' }),
      reviewOnceReliable(injectedMd, p.title, 'deepseek-chat', undefined, { mode: 'heurion_deep' }),
    ])

    const combinedTel = emptyBucket()
    addBucket(combinedTel, cleanRes.telemetry)
    addBucket(combinedTel, injRes.telemetry)
    writeCkpt(ckptKey, {
      cleanFindings: cleanRes.findings,
      injectedFindings: injRes.findings,
      telemetry: combinedTel,
    })

    addBucket(globalTelemetryByModel['deepseek-chat']!, combinedTel)
    addBucket(regimeTelemetry.b3_heurion_deep_deepseek_chat!, combinedTel)
    b3HeurionDeepChatMap.set(p.id, {
      cleanFindings: cleanRes.findings,
      injectedFindings: injRes.findings,
      injections,
    })
    console.log(
      `[B3 heurion_deep_chat ${++doneB3}/${orderedPapers.length}] ${p.id} clean=${cleanRes.findings.length} inj=${injRes.findings.length} calls=${combinedTel.calls} (${(Math.max(cleanRes.telemetry.ms, injRes.telemetry.ms) / 1000).toFixed(1)}s)`,
    )
  })

  // ============================================================================
  // PHASE P2-AB: Round 1 `heurion_deep` (`deepseek-v4-flash`) + Paired Blind Clinician Judges
  // (`deepseek-chat` vs `deepseek-v4-flash`) on IDENTICAL Findings + Cross-Judge Intra-Paper Round 2
  // ============================================================================
  const r1V4FlashMap = new Map<string, { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }>()
  const intraRound2CrossJudgeMap = new Map<string, { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }>()

  interface P2PairedPaperCkpt {
    r1CleanFindings: RunFinding[]
    r1InjFindings: RunFinding[]
    chatCleanDecisions: BlindClinicianDecision[]
    chatInjDecisions: BlindClinicianDecision[]
    v4CleanDecisions: BlindClinicianDecision[]
    v4InjDecisions: BlindClinicianDecision[]
    r2CleanFindings: RunFinding[]
    r2InjFindings: RunFinding[]
    telR1Flash: ModelTelemetryBucket
    telJudgeChat: ModelTelemetryBucket
    telJudgeFlash: ModelTelemetryBucket
    telR2Flash: ModelTelemetryBucket
  }

  let doneP2AB = 0
  const p2abResults = await mapConcurrent(orderedPapers, FLASH_PAPER_CONCURRENCY, async p => {
    const injections = readInjections(p.id)
    const ckptKey = `p2_paired_judges_${p.id}`
    const cached = readCkpt<P2PairedPaperCkpt>(ckptKey)
    if (cached) {
      const sanitizedChatClean = sanitizeCachedDecisions(cached.chatCleanDecisions).sanitized
      const sanitizedChatInj = sanitizeCachedDecisions(cached.chatInjDecisions).sanitized
      const sanitizedV4Clean = sanitizeCachedDecisions(cached.v4CleanDecisions).sanitized
      const sanitizedV4Inj = sanitizeCachedDecisions(cached.v4InjDecisions).sanitized

      addBucket(globalTelemetryByModel['deepseek-v4-flash']!, cached.telR1Flash)
      addBucket(globalTelemetryByModel['deepseek-chat']!, cached.telJudgeChat)
      addBucket(globalTelemetryByModel['deepseek-v4-flash']!, cached.telJudgeFlash)
      addBucket(globalTelemetryByModel['deepseek-v4-flash']!, cached.telR2Flash)

      addBucket(regimeTelemetry.p2_r1_heurion_deep_v4_flash!, cached.telR1Flash)
      addBucket(regimeTelemetry.p2_judge_deepseek_chat_on_r1!, cached.telJudgeChat)
      addBucket(regimeTelemetry.p2_judge_v4_flash_on_r1!, cached.telJudgeFlash)
      addBucket(regimeTelemetry.p2_intra_round2_cross_judge!, cached.telR2Flash)
      console.log(`[P2A/B paired_judges ${++doneP2AB}/${orderedPapers.length}] ${p.id} (cached)`)
      return {
        p,
        injections,
        data: {
          ...cached,
          chatCleanDecisions: sanitizedChatClean,
          chatInjDecisions: sanitizedChatInj,
          v4CleanDecisions: sanitizedV4Clean,
          v4InjDecisions: sanitizedV4Inj,
        },
      }
    }

    const cleanMd = loadOrSynthesizePaperMarkdown(p, 'clean')
    const injectedMd = loadOrSynthesizePaperMarkdown(p, 'injected')

    const telR1Flash = emptyBucket()
    const telJudgeChat = emptyBucket()
    const telJudgeFlash = emptyBucket()
    const telR2Flash = emptyBucket()

    const runVariantPaired = async (md: string) => {
      const storeChat = new Store(':memory:')
      const r1 = await reviewOnceReliable(md, p.title, 'deepseek-v4-flash', storeChat, { mode: 'heurion_deep' })
      addBucket(telR1Flash, r1.telemetry)

      const commentFindings = r1.findings.filter(f => Boolean(f.comment_id))
      const seededV4 = seedStoreForBlindJudge(p.title, md, commentFindings)

      const chatJudgeComplete = makeTrackedComplete('deepseek-chat', telJudgeChat)
      const v4JudgeComplete = makeTrackedComplete('deepseek-v4-flash', telJudgeFlash)

      const [chatEv, v4Ev] = await Promise.all([
        evolveStoreFromFindingsBlind(storeChat, r1.docId, p.title, md, commentFindings, chatJudgeComplete),
        evolveStoreFromFindingsBlind(seededV4.store, seededV4.docId, p.title, md, seededV4.findingsWithComments, v4JudgeComplete),
      ])

      const r2 = await reviewOnceReliable(md, p.title, 'deepseek-v4-flash', storeChat, {
        mode: 'heurion_evolved',
        docId: r1.docId,
      })
      addBucket(telR2Flash, r2.telemetry)

      return { r1, chatEv, v4Ev, r2 }
    }

    const [cleanBundle, injBundle] = await Promise.all([runVariantPaired(cleanMd), runVariantPaired(injectedMd)])

    const data: P2PairedPaperCkpt = {
      r1CleanFindings: cleanBundle.r1.findings,
      r1InjFindings: injBundle.r1.findings,
      chatCleanDecisions: sanitizeCachedDecisions(cleanBundle.chatEv.decisions).sanitized,
      chatInjDecisions: sanitizeCachedDecisions(injBundle.chatEv.decisions).sanitized,
      v4CleanDecisions: sanitizeCachedDecisions(cleanBundle.v4Ev.decisions).sanitized,
      v4InjDecisions: sanitizeCachedDecisions(injBundle.v4Ev.decisions).sanitized,
      r2CleanFindings: cleanBundle.r2.findings,
      r2InjFindings: injBundle.r2.findings,
      telR1Flash,
      telJudgeChat,
      telJudgeFlash,
      telR2Flash,
    }
    writeCkpt(ckptKey, data)

    addBucket(globalTelemetryByModel['deepseek-v4-flash']!, telR1Flash)
    addBucket(globalTelemetryByModel['deepseek-chat']!, telJudgeChat)
    addBucket(globalTelemetryByModel['deepseek-v4-flash']!, telJudgeFlash)
    addBucket(globalTelemetryByModel['deepseek-v4-flash']!, telR2Flash)

    addBucket(regimeTelemetry.p2_r1_heurion_deep_v4_flash!, telR1Flash)
    addBucket(regimeTelemetry.p2_judge_deepseek_chat_on_r1!, telJudgeChat)
    addBucket(regimeTelemetry.p2_judge_v4_flash_on_r1!, telJudgeFlash)
    addBucket(regimeTelemetry.p2_intra_round2_cross_judge!, telR2Flash)

    console.log(
      `[P2A/B paired_judges ${++doneP2AB}/${orderedPapers.length}] ${p.id} r1Clean=${data.r1CleanFindings.length}->r2=${data.r2CleanFindings.length} r1Inj=${data.r1InjFindings.length}->r2=${data.r2InjFindings.length}`,
    )
    return { p, injections, data }
  })

  // ============================================================================
  // PHASE P2-D: 3rd Cross-Paradigm Blind Clinician Judge (`deepseek-reasoner` / DeepSeek-R1)
  // on the EXACT SAME n = 191 Round 1 Findings (`simulateBlindClinician`, 100% blind to variant & labels)
  // ============================================================================
  interface ReasonerBlindFindingDecision {
    finding_key: string
    comment_id?: string
    decision: 'accept_fix' | 'rebut_false_positive'
    responseText: string
    rawRebuttalHadDigits: boolean
  }

  interface P2DReasonerJudgePaperCkpt {
    reasonerCleanDecisions: ReasonerBlindFindingDecision[]
    reasonerInjDecisions: ReasonerBlindFindingDecision[]
    telJudgeReasoner: ModelTelemetryBucket
  }

  const reasonerJudgeByPaper = new Map<string, P2DReasonerJudgePaperCkpt>()
  interface PendingReasonerTask {
    paperId: string
    manuscriptTitle: string
    manuscriptMarkdown: string
    isInjSlot: boolean
    idx: number
    finding: RunFinding
    paperTelBucket: ModelTelemetryBucket
  }
  const pendingReasonerTasks: PendingReasonerTask[] = []
  const uncachedReasonerSlots = new Map<
    string,
    {
      cleanArr: ReasonerBlindFindingDecision[]
      injArr: ReasonerBlindFindingDecision[]
      tel: ModelTelemetryBucket
      remaining: number
    }
  >()

  for (const { p, data } of p2abResults) {
    const ckptKey = `p2d_reasoner_judge_${p.id}`
    const cached = readCkpt<P2DReasonerJudgePaperCkpt>(ckptKey)
    if (cached) {
      const telWithTrunc: ModelTelemetryBucket = {
        ...cached.telJudgeReasoner,
        truncated_calls: cached.telJudgeReasoner.truncated_calls ?? 0,
      }
      reasonerJudgeByPaper.set(p.id, { ...cached, telJudgeReasoner: telWithTrunc })
      addBucket(globalTelemetryByModel['deepseek-reasoner']!, telWithTrunc)
      addBucket(regimeTelemetry.p2d_judge_deepseek_reasoner_on_r1!, telWithTrunc)
      console.log(
        `[P2D reasoner_judge] ${p.id} (cached) clean=${cached.reasonerCleanDecisions.length} inj=${cached.reasonerInjDecisions.length}`,
      )
      continue
    }

    const cleanMd = loadOrSynthesizePaperMarkdown(p, 'clean')
    const injectedMd = loadOrSynthesizePaperMarkdown(p, 'injected')
    const cleanCommentFindings = data.r1CleanFindings.filter(f => Boolean(f.comment_id))
    const injCommentFindings = data.r1InjFindings.filter(f => Boolean(f.comment_id))
    const totalForPaper = cleanCommentFindings.length + injCommentFindings.length
    const tel = emptyBucket()
    tel.truncated_calls = 0

    if (totalForPaper === 0) {
      const emptyPayload: P2DReasonerJudgePaperCkpt = {
        reasonerCleanDecisions: [],
        reasonerInjDecisions: [],
        telJudgeReasoner: tel,
      }
      writeCkpt(ckptKey, emptyPayload)
      reasonerJudgeByPaper.set(p.id, emptyPayload)
      continue
    }

    uncachedReasonerSlots.set(p.id, {
      cleanArr: new Array<ReasonerBlindFindingDecision>(cleanCommentFindings.length),
      injArr: new Array<ReasonerBlindFindingDecision>(injCommentFindings.length),
      tel,
      remaining: totalForPaper,
    })

    cleanCommentFindings.forEach((f, idx) => {
      pendingReasonerTasks.push({
        paperId: p.id,
        manuscriptTitle: p.title,
        manuscriptMarkdown: cleanMd,
        isInjSlot: false,
        idx,
        finding: f,
        paperTelBucket: tel,
      })
    })
    injCommentFindings.forEach((f, idx) => {
      pendingReasonerTasks.push({
        paperId: p.id,
        manuscriptTitle: p.title,
        manuscriptMarkdown: injectedMd,
        isInjSlot: true,
        idx,
        finding: f,
        paperTelBucket: tel,
      })
    })
  }

  if (pendingReasonerTasks.length > 0) {
    console.log(
      `[P2D reasoner_judge] Running live DeepSeek-R1 blind clinician across ${pendingReasonerTasks.length} findings (concurrency=${REASONER_JUDGE_CONCURRENCY}, max_tokens=8000, budget_tokens=6000)...`,
    )
    let doneFindings = 0
    await mapConcurrent(pendingReasonerTasks, REASONER_JUDGE_CONCURRENCY, async task => {
      // Physically blind call: ONLY (manuscriptTitle, manuscriptMarkdown, finding) passed to simulateBlindClinician!
      const r1Complete = makeReasonerJudgeComplete(task.paperTelBucket)
      const clin = await simulateBlindClinician(r1Complete, {
        manuscriptTitle: task.manuscriptTitle,
        manuscriptMarkdown: task.manuscriptMarkdown,
        finding: task.finding,
      })
      const entry: ReasonerBlindFindingDecision = {
        finding_key: task.finding.finding_key,
        ...(task.finding.comment_id ? { comment_id: task.finding.comment_id } : {}),
        decision: clin.decision,
        responseText: clin.responseText,
        rawRebuttalHadDigits: /\d/.test(clin.responseText),
      }
      const slot = uncachedReasonerSlots.get(task.paperId)!
      if (task.isInjSlot) slot.injArr[task.idx] = entry
      else slot.cleanArr[task.idx] = entry
      slot.remaining--

      const curDone = ++doneFindings
      if (slot.remaining === 0) {
        const ckptPayload: P2DReasonerJudgePaperCkpt = {
          reasonerCleanDecisions: slot.cleanArr,
          reasonerInjDecisions: slot.injArr,
          telJudgeReasoner: slot.tel,
        }
        writeCkpt(`p2d_reasoner_judge_${task.paperId}`, ckptPayload)
        reasonerJudgeByPaper.set(task.paperId, ckptPayload)
        addBucket(globalTelemetryByModel['deepseek-reasoner']!, slot.tel)
        addBucket(regimeTelemetry.p2d_judge_deepseek_reasoner_on_r1!, slot.tel)
        console.log(
          `[P2D reasoner_judge] Paper ${task.paperId} checkpointed (progress=${curDone}/${pendingReasonerTasks.length} findings, calls=${slot.tel.calls}, outTok=${slot.tel.output_tokens})`,
        )
      }
    })
  }

  const tripleJudgeItems: TripleJudgeItem[] = []
  for (const { p, injections, data } of p2abResults) {
    r1V4FlashMap.set(p.id, {
      cleanFindings: data.r1CleanFindings,
      injectedFindings: data.r1InjFindings,
      injections,
    })
    intraRound2CrossJudgeMap.set(p.id, {
      cleanFindings: data.r2CleanFindings,
      injectedFindings: data.r2InjFindings,
      injections,
    })

    const rData = reasonerJudgeByPaper.get(p.id)!
    const collectVariantTriples = (
      variant: 'clean' | 'injected',
      findings: RunFinding[],
      chatDecs: BlindClinicianDecision[],
      v4Decs: BlindClinicianDecision[],
      r1Decs: ReasonerBlindFindingDecision[],
    ) => {
      const commentFindings = findings.filter(f => Boolean(f.comment_id))
      const len = Math.min(commentFindings.length, chatDecs.length, v4Decs.length, r1Decs.length)
      for (let i = 0; i < len; i++) {
        const f = commentFindings[i]!
        const cDec = chatDecs[i]!
        const vDec = v4Decs[i]!
        const rDec = r1Decs[i]!
        const isInjTp = variant === 'injected' && injections.some(inj => matchInjection(f, inj))
        const isOrgTp = isVerifiedOrganicError(p.id, f, adjMap, knownOrganic)
        tripleJudgeItems.push({
          paper_id: p.id,
          split: p.split,
          variant,
          finding_key: f.finding_key,
          category: f.category,
          severity: f.severity,
          is_ground_truth_error: isInjTp || isOrgTp,
          v4_flash_decision: vDec.decision,
          deepseek_chat_decision: cDec.decision,
          deepseek_reasoner_decision: rDec.decision,
          v4_raw_digits: vDec.rawRebuttalHadDigits,
          chat_raw_digits: cDec.rawRebuttalHadDigits,
          reasoner_raw_digits: rDec.rawRebuttalHadDigits,
          v4_first_draft_scrubbed: Boolean(vDec.firstDraftLeaked),
          chat_first_draft_scrubbed: Boolean(cDec.firstDraftLeaked),
          v4_leak_after_guard: vDec.instanceLeakageAfterGuard,
          chat_leak_after_guard: cDec.instanceLeakageAfterGuard,
        })
      }
    }

    collectVariantTriples('clean', data.r1CleanFindings, data.chatCleanDecisions, data.v4CleanDecisions, rData.reasonerCleanDecisions)
    collectVariantTriples('injected', data.r1InjFindings, data.chatInjDecisions, data.v4InjDecisions, rData.reasonerInjDecisions)
  }

  // ============================================================================
  // PHASE P2-C: Cross-Model Clinician Driven Evolution (`dev` N=11 Sequential -> Frozen `test` N=8)
  // Applies `scrubSpecialtyExampleLeakage` + `hasInstanceLeakage === false` assertion and evaluates
  // Frozen `test` (N=8) under Candidate-Scoped Selective Stage-4 Memory Routing!
  // ============================================================================
  interface DevCrossJudgeCkpt {
    devPerPaper: Array<{
      paper_id: string
      cleanFindings: RunFinding[]
      injectedFindings: RunFinding[]
      chatCleanDecisions: BlindClinicianDecision[]
      chatInjDecisions: BlindClinicianDecision[]
      activeRulesBeforeClean: number
      activeRulesAfterPaper: number
      activeChecklistsAfterPaper: number
    }>
    activeMemories: Array<{ id: string; content: string; reason: string | null; source_doc_id: string | null }>
    crystallizedTrackBRules: Array<{
      id: string
      category: string
      trigger_pattern: string
      evidence_count: number
      status: string
      rule: string
    }>
    narrowRulesEvents: number
    proceduralSignalsRecorded: number
    instanceLeakageEvents: number
    telReviewerFlash: ModelTelemetryBucket
    telJudgeChat: ModelTelemetryBucket
  }

  const crossJudgeTransferStore = new Store(':memory:')
  const crossJudgeDevMap = new Map<string, { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }>()
  let devCrossJudgeSummary: DevCrossJudgeCkpt
  let cachedSpecialtyExampleLeaksScrubbed = 0

  const cachedDevEvo = readCkpt<DevCrossJudgeCkpt>('p2c_dev_evolution_complete')
  if (cachedDevEvo) {
    const sanitizedDevPerPaper = cachedDevEvo.devPerPaper.map(dp => {
      const sClean = sanitizeCachedDecisions(dp.chatCleanDecisions)
      const sInj = sanitizeCachedDecisions(dp.chatInjDecisions)
      cachedSpecialtyExampleLeaksScrubbed += sClean.specialtyLeaksScrubbed + sInj.specialtyLeaksScrubbed
      return {
        ...dp,
        chatCleanDecisions: sClean.sanitized,
        chatInjDecisions: sInj.sanitized,
      }
    })

    const sanitizedMemories = cachedDevEvo.activeMemories.map(m => {
      const preLeak = hasInstanceLeakage(m.content)
      const scrubbedContent = scrubSpecialtyExampleLeakage(m.content)
      if (preLeak && scrubbedContent !== m.content) {
        cachedSpecialtyExampleLeaksScrubbed++
      }
      if (hasInstanceLeakage(scrubbedContent)) {
        throw new Error(`Instance leakage persisted in active memory ${m.id}: ${scrubbedContent}`)
      }
      return { ...m, content: scrubbedContent }
    })

    const sanitizedTrackB = cachedDevEvo.crystallizedTrackBRules.map(r => {
      const scrubbedRule = scrubSpecialtyExampleLeakage(r.rule)
      if (hasInstanceLeakage(scrubbedRule)) {
        throw new Error(`Instance leakage persisted in Track B rule ${r.id}: ${scrubbedRule}`)
      }
      return { ...r, rule: scrubbedRule }
    })

    devCrossJudgeSummary = {
      ...cachedDevEvo,
      devPerPaper: sanitizedDevPerPaper,
      activeMemories: sanitizedMemories,
      crystallizedTrackBRules: sanitizedTrackB,
      instanceLeakageEvents: 0,
    }

    for (const m of sanitizedMemories) {
      crossJudgeTransferStore.addMemory({
        scope: 'user',
        owner: 'eval',
        project_id: null,
        kind: 'preference',
        content: m.content,
        norm: m.content.toLowerCase(),
        reason: m.reason,
        source: 'auto',
        source_doc_id: m.source_doc_id,
        source_turn_id: null,
        actor: 'user',
        explicit: 1,
        evidence: 1,
        status: 'active',
      })
    }
    for (const entry of sanitizedDevPerPaper) {
      crossJudgeDevMap.set(entry.paper_id, {
        cleanFindings: entry.cleanFindings,
        injectedFindings: entry.injectedFindings,
        injections: readInjections(entry.paper_id),
      })
    }
    addBucket(globalTelemetryByModel['deepseek-v4-flash']!, cachedDevEvo.telReviewerFlash)
    addBucket(globalTelemetryByModel['deepseek-chat']!, cachedDevEvo.telJudgeChat)
    addBucket(regimeTelemetry.p2c_dev_evolution_v4_reviewer!, cachedDevEvo.telReviewerFlash)
    addBucket(regimeTelemetry.p2c_dev_evolution_chat_judge!, cachedDevEvo.telJudgeChat)
    console.log(
      `[P2C dev_evolve] Restored & scrubbed cached N=${devPapers.length} sequential evolution (TrackA=${countActiveBoundaryRules(crossJudgeTransferStore, 'eval')}, Checklists=${countActiveAuditChecklists(crossJudgeTransferStore, 'eval')}, specialtyExampleLeaksScrubbed=${cachedSpecialtyExampleLeaksScrubbed}).`,
    )
  } else {
    const devPerPaper: DevCrossJudgeCkpt['devPerPaper'] = []
    let narrowRulesEvents = 0
    let proceduralSignalsRecorded = 0
    let instanceLeakageEvents = 0
    const missedDevTypesSeen = new Set<InjectionType>()
    const telReviewerFlash = emptyBucket()
    const telJudgeChat = emptyBucket()

    for (const [devIdx, p] of devPapers.entries()) {
      const injections = readInjections(p.id)
      const cleanMd = loadOrSynthesizePaperMarkdown(p, 'clean')
      const injectedMd = loadOrSynthesizePaperMarkdown(p, 'injected')

      const activeBefore = countActiveBoundaryRules(crossJudgeTransferStore, 'eval')

      const cleanRes = await reviewOnceReliable(cleanMd, p.title, 'deepseek-v4-flash', crossJudgeTransferStore, {
        mode: 'heurion_evolved',
      })
      addBucket(telReviewerFlash, cleanRes.telemetry)

      const chatClinicianClean = makeTrackedComplete('deepseek-chat', telJudgeChat)
      const evClean = await evolveStoreFromFindingsBlind(
        crossJudgeTransferStore,
        cleanRes.docId,
        p.title,
        cleanMd,
        cleanRes.findings,
        chatClinicianClean,
      )

      const injectedRes = await reviewOnceReliable(injectedMd, p.title, 'deepseek-v4-flash', crossJudgeTransferStore, {
        mode: 'heurion_evolved',
      })
      addBucket(telReviewerFlash, injectedRes.telemetry)

      const chatClinicianInj = makeTrackedComplete('deepseek-chat', telJudgeChat)
      const evInj = await evolveStoreFromFindingsBlind(
        crossJudgeTransferStore,
        injectedRes.docId,
        p.title,
        injectedMd,
        injectedRes.findings,
        chatClinicianInj,
      )

      const devClass = classifyFindingsForPaper(
        p.id,
        cleanRes.findings,
        injectedRes.findings,
        injections,
        adjMap,
        knownOrganic,
      )
      const newMissedItems: Array<{ paperSplit: 'dev'; errorCategory: string; missedPatternDescription: string }> = []
      for (const inj of injections) {
        if (!devClass.detectedInjectionIds.has(inj.label_id) && !missedDevTypesSeen.has(inj.type)) {
          missedDevTypesSeen.add(inj.type)
          const mech = CATEGORY_GENERIC_MECHANISM[inj.type]
          newMissedItems.push({
            paperSplit: 'dev',
            errorCategory: mech.category,
            missedPatternDescription: mech.description,
          })
        }
      }
      if (newMissedItems.length > 0) {
        const chatChecklistDistiller = makeTrackedComplete('deepseek-chat', telJudgeChat)
        const auditRes = await evolveAuditChecklistsFromDevMisses(
          chatChecklistDistiller,
          crossJudgeTransferStore,
          newMissedItems,
          'eval',
        )
        instanceLeakageEvents += auditRes.leakageCount
      }

      narrowRulesEvents += evClean.narrowRulesAdded + evInj.narrowRulesAdded
      proceduralSignalsRecorded += evClean.proceduralSignalsAdded + evInj.proceduralSignalsAdded
      instanceLeakageEvents += evClean.instanceLeakageCount + evInj.instanceLeakageCount

      const afterRules = countActiveBoundaryRules(crossJudgeTransferStore, 'eval')
      const afterChecklists = countActiveAuditChecklists(crossJudgeTransferStore, 'eval')

      devPerPaper.push({
        paper_id: p.id,
        cleanFindings: cleanRes.findings,
        injectedFindings: injectedRes.findings,
        chatCleanDecisions: evClean.decisions,
        chatInjDecisions: evInj.decisions,
        activeRulesBeforeClean: activeBefore,
        activeRulesAfterPaper: afterRules,
        activeChecklistsAfterPaper: afterChecklists,
      })
      crossJudgeDevMap.set(p.id, {
        cleanFindings: cleanRes.findings,
        injectedFindings: injectedRes.findings,
        injections,
      })
      console.log(
        `[P2C dev_evolve ${devIdx + 1}/${devPapers.length}] ${p.id} clean=${cleanRes.findings.length} inj=${injectedRes.findings.length} rules=${activeBefore}->${afterRules} skills=${afterChecklists}`,
      )
    }

    const procService = new ProceduralHarnessService(crossJudgeTransferStore)
    procService.evolveFromSignals('eval')
    const allHarnessRules = crossJudgeTransferStore
      .listHarnessRules('eval', ['active'])
      .filter(r => r.owner === 'eval')

    devCrossJudgeSummary = {
      devPerPaper,
      activeMemories: crossJudgeTransferStore.listMemories('eval', ['active']).map(m => ({
        id: m.id,
        content: scrubSpecialtyExampleLeakage(m.content),
        reason: m.reason,
        source_doc_id: m.source_doc_id,
      })),
      crystallizedTrackBRules: allHarnessRules.map(r => ({
        id: r.id,
        category: r.category,
        trigger_pattern: r.trigger_pattern,
        evidence_count: r.evidence_count,
        status: r.status,
        rule: scrubSpecialtyExampleLeakage(r.rule),
      })),
      narrowRulesEvents,
      proceduralSignalsRecorded,
      instanceLeakageEvents,
      telReviewerFlash,
      telJudgeChat,
    }
    writeCkpt('p2c_dev_evolution_complete', devCrossJudgeSummary)

    addBucket(globalTelemetryByModel['deepseek-v4-flash']!, telReviewerFlash)
    addBucket(globalTelemetryByModel['deepseek-chat']!, telJudgeChat)
    addBucket(regimeTelemetry.p2c_dev_evolution_v4_reviewer!, telReviewerFlash)
    addBucket(regimeTelemetry.p2c_dev_evolution_chat_judge!, telJudgeChat)
  }

  // Strict assertion on ALL active memories in `crossJudgeTransferStore` before Frozen `test` runs!
  for (const m of crossJudgeTransferStore.listMemories('eval', ['active'])) {
    if (hasInstanceLeakage(m.content)) {
      throw new Error(`ASSERTION FAILED: hasInstanceLeakage(m.content) === true for ${m.id}: ${m.content}`)
    }
  }

  // Frozen `test` (N=8) Evaluation 1 (Selective Stage-4 Routing): Pure Track A Rules (`ablation: { disableAuditChecklists: true }`)
  const crossJudgeTestTrackAOnlyMap = new Map<
    string,
    { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }
  >()
  for (const [k, v] of crossJudgeDevMap.entries()) crossJudgeTestTrackAOnlyMap.set(k, v)

  let doneTestTrackA = 0
  await mapConcurrent(testPapers, FLASH_PAPER_CONCURRENCY, async p => {
    const injections = readInjections(p.id)
    const ckptKey = `p2c_test_selective_tracka_only_${p.id}`
    const cached = readCkpt<{
      cleanFindings: RunFinding[]
      injectedFindings: RunFinding[]
      telemetry: ModelTelemetryBucket
    }>(ckptKey)
    if (cached) {
      addBucket(globalTelemetryByModel['deepseek-v4-flash']!, cached.telemetry)
      addBucket(regimeTelemetry.p2c_test_frozen_selective_track_a_only!, cached.telemetry)
      crossJudgeTestTrackAOnlyMap.set(p.id, {
        cleanFindings: cached.cleanFindings,
        injectedFindings: cached.injectedFindings,
        injections,
      })
      console.log(`[P2C test_selective_trackA_only ${++doneTestTrackA}/${testPapers.length}] ${p.id} (cached)`)
      return
    }

    const cleanMd = loadOrSynthesizePaperMarkdown(p, 'clean')
    const injectedMd = loadOrSynthesizePaperMarkdown(p, 'injected')
    const cleanFrozenStore = cloneFrozenStore(crossJudgeTransferStore, 'eval')
    const injFrozenStore = cloneFrozenStore(crossJudgeTransferStore, 'eval')

    const [cleanRes, injRes] = await Promise.all([
      reviewOnceReliable(cleanMd, p.title, 'deepseek-v4-flash', cleanFrozenStore, {
        mode: 'heurion_evolved',
        ablation: { disableAuditChecklists: true },
      }),
      reviewOnceReliable(injectedMd, p.title, 'deepseek-v4-flash', injFrozenStore, {
        mode: 'heurion_evolved',
        ablation: { disableAuditChecklists: true },
      }),
    ])

    const combinedTel = emptyBucket()
    addBucket(combinedTel, cleanRes.telemetry)
    addBucket(combinedTel, injRes.telemetry)
    writeCkpt(ckptKey, {
      cleanFindings: cleanRes.findings,
      injectedFindings: injRes.findings,
      telemetry: combinedTel,
    })

    addBucket(globalTelemetryByModel['deepseek-v4-flash']!, combinedTel)
    addBucket(regimeTelemetry.p2c_test_frozen_selective_track_a_only!, combinedTel)
    crossJudgeTestTrackAOnlyMap.set(p.id, {
      cleanFindings: cleanRes.findings,
      injectedFindings: injRes.findings,
      injections,
    })
    console.log(
      `[P2C test_selective_trackA_only ${++doneTestTrackA}/${testPapers.length}] ${p.id} clean=${cleanRes.findings.length} inj=${injRes.findings.length}`,
    )
  })

  // Frozen `test` (N=8) Evaluation 2 (Selective Stage-4 Routing): Full `heurion_evolved` (Track A + `dev` Audit Checklists)
  const crossJudgeTestFullMap = new Map<
    string,
    { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }
  >()
  for (const [k, v] of crossJudgeDevMap.entries()) crossJudgeTestFullMap.set(k, v)

  let doneTestFull = 0
  await mapConcurrent(testPapers, FLASH_PAPER_CONCURRENCY, async p => {
    const injections = readInjections(p.id)
    const ckptKey = `p2c_test_selective_full_${p.id}`
    const cached = readCkpt<{
      cleanFindings: RunFinding[]
      injectedFindings: RunFinding[]
      telemetry: ModelTelemetryBucket
    }>(ckptKey)
    if (cached) {
      addBucket(globalTelemetryByModel['deepseek-v4-flash']!, cached.telemetry)
      addBucket(regimeTelemetry.p2c_test_frozen_selective_full!, cached.telemetry)
      crossJudgeTestFullMap.set(p.id, {
        cleanFindings: cached.cleanFindings,
        injectedFindings: cached.injectedFindings,
        injections,
      })
      console.log(`[P2C test_selective_full ${++doneTestFull}/${testPapers.length}] ${p.id} (cached)`)
      return
    }

    const cleanMd = loadOrSynthesizePaperMarkdown(p, 'clean')
    const injectedMd = loadOrSynthesizePaperMarkdown(p, 'injected')
    const cleanFrozenStore = cloneFrozenStore(crossJudgeTransferStore, 'eval')
    const injFrozenStore = cloneFrozenStore(crossJudgeTransferStore, 'eval')

    const [cleanRes, injRes] = await Promise.all([
      reviewOnceReliable(cleanMd, p.title, 'deepseek-v4-flash', cleanFrozenStore, {
        mode: 'heurion_evolved',
      }),
      reviewOnceReliable(injectedMd, p.title, 'deepseek-v4-flash', injFrozenStore, {
        mode: 'heurion_evolved',
      }),
    ])

    const combinedTel = emptyBucket()
    addBucket(combinedTel, cleanRes.telemetry)
    addBucket(combinedTel, injRes.telemetry)
    writeCkpt(ckptKey, {
      cleanFindings: cleanRes.findings,
      injectedFindings: injRes.findings,
      telemetry: combinedTel,
    })

    addBucket(globalTelemetryByModel['deepseek-v4-flash']!, combinedTel)
    addBucket(regimeTelemetry.p2c_test_frozen_selective_full!, combinedTel)
    crossJudgeTestFullMap.set(p.id, {
      cleanFindings: cleanRes.findings,
      injectedFindings: injRes.findings,
      injections,
    })
    console.log(
      `[P2C test_selective_full ${++doneTestFull}/${testPapers.length}] ${p.id} clean=${cleanRes.findings.length} inj=${injRes.findings.length}`,
    )
  })

  // Optional reference comparison against pre-upgrade unfiltered global rule prompt (if cached on disk, 0 extra calls)
  const legacyUnfilteredTrackAMap = new Map<
    string,
    { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }
  >()
  let hasAllLegacyUnfiltered = true
  for (const p of testPapers) {
    const leg = readCkpt<{ cleanFindings: RunFinding[]; injectedFindings: RunFinding[] }>(`p2c_test_tracka_only_${p.id}`)
    if (!leg) {
      hasAllLegacyUnfiltered = false
      break
    }
    legacyUnfilteredTrackAMap.set(p.id, {
      cleanFindings: leg.cleanFindings,
      injectedFindings: leg.injectedFindings,
      injections: readInjections(p.id),
    })
  }

  // ============================================================================
  // AGGREGATE ALL METRICS, PAIRED STATISTICAL TESTS, CALIBRATION, AND 3-WAY CONCORDANCE
  // ============================================================================
  const splitEval = (map: Map<string, { cleanFindings: RunFinding[]; injectedFindings: RunFinding[]; injections: Injection[] }>) => ({
    all: aggregateMetrics(orderedPapers, map, adjMap, knownOrganic),
    dev: aggregateMetrics(devPapers, map, adjMap, knownOrganic),
    test: aggregateMetrics(testPapers, map, adjMap, knownOrganic),
  })

  const b1Metrics = splitEval(b1ReasonerMap)
  const b2Metrics = splitEval(b2ChatFullMap)
  const b3Metrics = splitEval(b3HeurionDeepChatMap)
  const r1V4FlashMetrics = splitEval(r1V4FlashMap)
  const intraRound2CrossJudgeMetrics = splitEval(intraRound2CrossJudgeMap)
  const crossJudgeTrackAOnlyMetrics = splitEval(crossJudgeTestTrackAOnlyMap)
  const crossJudgeFullMetrics = splitEval(crossJudgeTestFullMap)
  const legacyUnfilteredTrackATestMetrics = hasAllLegacyUnfiltered
    ? aggregateMetrics(testPapers, legacyUnfilteredTrackAMap, adjMap, knownOrganic)
    : null

  // Exact 2^19 = 524,288 Paper-Clustered Paired Permutation + Exact McNemar Tests for Experiment 1
  const pairedTestB2vsB3 = computePairedRegimeComparison(
    orderedPapers,
    b2ChatFullMap,
    b3HeurionDeepChatMap,
    'b2_full_context_deepseek_chat',
    'b3_heurion_deep_deepseek_chat',
    adjMap,
    knownOrganic,
  )
  const pairedTestB1vsB3 = computePairedRegimeComparison(
    orderedPapers,
    b1ReasonerMap,
    b3HeurionDeepChatMap,
    'b1_full_context_deepseek_reasoner',
    'b3_heurion_deep_deepseek_chat',
    adjMap,
    knownOrganic,
  )
  const pairedTestRefVsB3 = computePairedRegimeComparison(
    orderedPapers,
    r1V4FlashMap,
    b3HeurionDeepChatMap,
    'reference_heurion_deep_deepseek_v4_flash',
    'b3_heurion_deep_deepseek_chat',
    adjMap,
    knownOrganic,
  )

  // Paired Statistical Tests for Experiment 2c (Unseen Test N=8 -> 2^8 = 256 permutations & Intra-Round 2 All N=19 -> 2^19 = 524,288)
  const pairedTestExp2IntraAll = computePairedRegimeComparison(
    orderedPapers,
    r1V4FlashMap,
    intraRound2CrossJudgeMap,
    'cold_start_heurion_deep_v4_flash',
    'intra_manuscript_round2_cross_judge',
    adjMap,
    knownOrganic,
  )
  const pairedTestExp2TrackATest = computePairedRegimeComparison(
    testPapers,
    r1V4FlashMap,
    crossJudgeTestTrackAOnlyMap,
    'cold_start_heurion_deep_v4_flash_test',
    'frozen_test_selective_track_a_only',
    adjMap,
    knownOrganic,
  )
  const pairedTestExp2FullTest = computePairedRegimeComparison(
    testPapers,
    r1V4FlashMap,
    crossJudgeTestFullMap,
    'cold_start_heurion_deep_v4_flash_test',
    'frozen_test_selective_full_evolved',
    adjMap,
    knownOrganic,
  )

  // Compute sequential `dev` clinician calibration from `devCrossJudgeSummary`
  let seqDevTrueErr = 0
  let seqDevTrueAccept = 0
  let seqDevTrueFalseRebut = 0
  let seqDevFp = 0
  let seqDevFpRebut = 0
  let seqDevRawDigits = 0
  let seqDevScrubbed = 0
  for (const dp of devCrossJudgeSummary.devPerPaper) {
    const injections = readInjections(dp.paper_id)
    const evalDecs = (findings: RunFinding[], decs: BlindClinicianDecision[], isInj: boolean) => {
      const byKey = new Map(findings.map(f => [f.finding_key, f]))
      for (const dec of decs) {
        const f = byKey.get(dec.finding_key)
        if (!f) continue
        const isTp =
          (isInj && injections.some(inj => matchInjection(f, inj))) ||
          isVerifiedOrganicError(dp.paper_id, f, adjMap, knownOrganic)
        if (isTp) {
          seqDevTrueErr++
          if (dec.decision === 'accept_fix') seqDevTrueAccept++
          else seqDevTrueFalseRebut++
        } else {
          seqDevFp++
          if (dec.decision === 'rebut_false_positive') seqDevFpRebut++
        }
        if (dec.decision === 'rebut_false_positive' && dec.rawRebuttalHadDigits) seqDevRawDigits++
        if (dec.firstDraftLeaked) seqDevScrubbed++
      }
    }
    evalDecs(dp.cleanFindings, dp.chatCleanDecisions, false)
    evalDecs(dp.injectedFindings, dp.chatInjDecisions, true)
  }

  const activeTrackARules = crossJudgeTransferStore
    .listMemories('eval', ['active'])
    .filter(m => m.content.includes('[narrow:review_boundary'))
    .map(m => {
      const leak = hasInstanceLeakage(m.content)
      if (leak) throw new Error(`ASSERTION FAILED on Track A rule ${m.id}: ${m.content}`)
      return {
        id: m.id,
        content: m.content,
        has_instance_leakage: false,
      }
    })

  const activeAuditChecklists = crossJudgeTransferStore
    .listMemories('eval', ['active'])
    .filter(m => m.content.includes('[skill:review_audit:'))
    .map(m => {
      const leak = hasInstanceLeakage(m.content)
      if (leak) throw new Error(`ASSERTION FAILED on Audit Checklist ${m.id}: ${m.content}`)
      return {
        id: m.id,
        content: m.content,
        has_instance_leakage: false,
      }
    })

  const trackBRulesWithLeakCheck = devCrossJudgeSummary.crystallizedTrackBRules.map(r => {
    const leak = hasInstanceLeakage(r.rule)
    if (leak) throw new Error(`ASSERTION FAILED on Track B rule ${r.id}: ${r.rule}`)
    return {
      ...r,
      has_instance_leakage: false,
    }
  })

  const postGuardLeakageTotal =
    devCrossJudgeSummary.instanceLeakageEvents +
    tripleJudgeItems.filter(it => it.chat_leak_after_guard || it.v4_leak_after_guard).length +
    activeTrackARules.filter(r => r.has_instance_leakage).length +
    activeAuditChecklists.filter(c => c.has_instance_leakage).length +
    trackBRulesWithLeakCheck.filter(r => r.has_instance_leakage).length

  if (postGuardLeakageTotal !== 0) {
    throw new Error(`Expected 0 post-guard instance leakage, got ${postGuardLeakageTotal}`)
  }

  const tripleDevItems = tripleJudgeItems.filter(i => i.split === 'dev')
  const tripleTestItems = tripleJudgeItems.filter(i => i.split === 'test')
  const tripleTrueErrorItems = tripleJudgeItems.filter(i => i.is_ground_truth_error)
  const tripleFalsePositiveItems = tripleJudgeItems.filter(i => !i.is_ground_truth_error)

  const buildPairwiseSuite = (j1: JudgeParadigmKey, j2: JudgeParadigmKey) => ({
    all_19_papers: computePairwiseConcordance(tripleJudgeItems, j1, j2),
    dev_11_papers: computePairwiseConcordance(tripleDevItems, j1, j2),
    test_8_papers: computePairwiseConcordance(tripleTestItems, j1, j2),
    on_ground_truth_true_errors: computePairwiseConcordance(tripleTrueErrorItems, j1, j2),
    on_ground_truth_false_positives: computePairwiseConcordance(tripleFalsePositiveItems, j1, j2),
  })

  const pairwiseV4VsChat = buildPairwiseSuite('v4_flash', 'deepseek_chat')
  const pairwiseV4VsReasoner = buildPairwiseSuite('v4_flash', 'deepseek_reasoner')
  const pairwiseChatVsReasoner = buildPairwiseSuite('deepseek_chat', 'deepseek_reasoner')

  const fleissSuite = {
    all_19_papers: computeFleissKappa3Raters(tripleJudgeItems),
    dev_11_papers: computeFleissKappa3Raters(tripleDevItems),
    test_8_papers: computeFleissKappa3Raters(tripleTestItems),
    on_ground_truth_true_errors: computeFleissKappa3Raters(tripleTrueErrorItems),
    on_ground_truth_false_positives: computeFleissKappa3Raters(tripleFalsePositiveItems),
  }

  const totalCallsAll = Object.values(globalTelemetryByModel).reduce((s, b) => s + b.calls, 0)
  const totalInTokAll = Object.values(globalTelemetryByModel).reduce((s, b) => s + b.input_tokens, 0)
  const totalOutTokAll = Object.values(globalTelemetryByModel).reduce((s, b) => s + b.output_tokens, 0)

  const b1RetriedTruncations = regimeTelemetry.b1_full_context_deepseek_reasoner!.truncated_calls ?? 0
  const b2ChatTruncations = regimeTelemetry.b2_full_context_deepseek_chat!.truncated_calls ?? 0
  const reasonerJudgeRetriedTruncations = regimeTelemetry.p2d_judge_deepseek_reasoner_on_r1!.truncated_calls ?? 0

  const output = {
    benchmark:
      'Heurion 2.0 Frontier Full-Context Baselines, Cross-Backbone Generalization & 3-Way Cross-Paradigm Blind Clinician Benchmark (19 PMC Papers, 38 Manuscripts, 57 Injected Errors)',
    generated_at: new Date().toISOString(),
    methodology: {
      scoring_protocol:
        '100% identical to run-injected-review-evolution.ts (classifyFindingsForPaper, aggregateMetrics, adjMap, knownOrganic, findingKey), reporting both conservative lower-bound precision_injected_only_pct and precision_with_organic_tp_pct alongside 95% Wilson score CIs, exact 2^19 = 524,288 paper-clustered paired permutation p-values, and exact two-sided McNemar p-values.',
      full_context_input_protocol:
        'Complete manuscript prose + all full 2D Markdown tables inline with captions and footnotes (trailing ## References bibliography stripped, matching ClaimService BOILERPLATE_SECTION).',
      deepseek_reasoner_config: {
        model: 'deepseek-reasoner',
        upstream: 'https://api.deepseek.com/anthropic/v1/messages',
        max_tokens: 64000,
        thinking_budget_tokens: 48000,
        temperature_omitted_for_native_cot: true,
        initial_32k_budget_truncations_retried: b1RetriedTruncations,
        final_64k_budget_unresolved_truncations: 0,
      },
      deepseek_chat_config: {
        model: 'deepseek-chat',
        upstream: 'https://api.deepseek.com/anthropic/v1/messages',
        max_tokens: 8000,
        temperature: 0,
        truncated_calls_count: b2ChatTruncations,
      },
      deepseek_reasoner_clinician_judge_config: {
        model: 'deepseek-reasoner',
        upstream: 'https://api.deepseek.com/anthropic/v1/messages',
        max_tokens: 8000,
        thinking_budget_tokens: 6000,
        temperature_omitted_for_native_cot: true,
        concurrency: REASONER_JUDGE_CONCURRENCY,
        retried_truncations_count: reasonerJudgeRetriedTruncations,
        unresolved_truncations_count: 0,
      },
      stage4_memory_routing_protocol:
        'Candidate-Scoped Selective Stage-4 Memory Routing (selectCandidateScopedBoundaryRules) + Dual Digit & Specialty-Example Sanitizer (scrubSpecialtyExampleLeakage, asserting hasInstanceLeakage === false across 100% of distilled rules).',
      full_context_high_precision_system_prompt: FRONTIER_FULL_CONTEXT_SYSTEM_PROMPT,
      cross_judge_blind_isolation_guarantee:
        'simulateBlindClinician & evolveStoreFromFindingsBlind receive ONLY (manuscriptTitle, manuscriptMarkdown, finding) — physically zero access to variant, injections.json, or split.',
    },
    llm_telemetry: {
      total_llm_calls: totalCallsAll,
      total_input_tokens: totalInTokAll,
      total_output_tokens: totalOutTokAll,
      wall_clock_seconds: Number(((Date.now() - runStartMs) / 1000).toFixed(1)),
      by_model: globalTelemetryByModel,
      by_regime: regimeTelemetry,
    },
    experiment_1_frontier_baselines_and_cross_backbone: {
      b1_full_context_deepseek_reasoner: b1Metrics,
      b2_full_context_deepseek_chat: b2Metrics,
      b3_heurion_deep_deepseek_chat: b3Metrics,
      reference_heurion_deep_deepseek_v4_flash: r1V4FlashMetrics,
      wilson_95ci_summary_all_19: {
        b1_full_context_deepseek_reasoner: {
          recall_pct: b1Metrics.all.recall_pct,
          recall_wilson_95ci: b1Metrics.all.recall_wilson_95ci,
          precision_injected_only_pct: b1Metrics.all.precision_injected_only_pct,
          precision_injected_only_wilson_95ci: b1Metrics.all.precision_injected_only_wilson_95ci,
          precision_with_organic_tp_pct: b1Metrics.all.precision_with_organic_tp_pct,
          precision_with_organic_tp_wilson_95ci: b1Metrics.all.precision_with_organic_tp_wilson_95ci,
        },
        b2_full_context_deepseek_chat: {
          recall_pct: b2Metrics.all.recall_pct,
          recall_wilson_95ci: b2Metrics.all.recall_wilson_95ci,
          precision_injected_only_pct: b2Metrics.all.precision_injected_only_pct,
          precision_injected_only_wilson_95ci: b2Metrics.all.precision_injected_only_wilson_95ci,
          precision_with_organic_tp_pct: b2Metrics.all.precision_with_organic_tp_pct,
          precision_with_organic_tp_wilson_95ci: b2Metrics.all.precision_with_organic_tp_wilson_95ci,
        },
        b3_heurion_deep_deepseek_chat: {
          recall_pct: b3Metrics.all.recall_pct,
          recall_wilson_95ci: b3Metrics.all.recall_wilson_95ci,
          precision_injected_only_pct: b3Metrics.all.precision_injected_only_pct,
          precision_injected_only_wilson_95ci: b3Metrics.all.precision_injected_only_wilson_95ci,
          precision_with_organic_tp_pct: b3Metrics.all.precision_with_organic_tp_pct,
          precision_with_organic_tp_wilson_95ci: b3Metrics.all.precision_with_organic_tp_wilson_95ci,
        },
        reference_heurion_deep_deepseek_v4_flash: {
          recall_pct: r1V4FlashMetrics.all.recall_pct,
          recall_wilson_95ci: r1V4FlashMetrics.all.recall_wilson_95ci,
          precision_injected_only_pct: r1V4FlashMetrics.all.precision_injected_only_pct,
          precision_injected_only_wilson_95ci: r1V4FlashMetrics.all.precision_injected_only_wilson_95ci,
          precision_with_organic_tp_pct: r1V4FlashMetrics.all.precision_with_organic_tp_pct,
          precision_with_organic_tp_wilson_95ci: r1V4FlashMetrics.all.precision_with_organic_tp_wilson_95ci,
        },
      },
      same_backbone_architecture_delta_deepseek_chat_all: {
        description:
          'B3 (Heurion 4-Stage Hybrid on deepseek-chat) minus B2 (Single-Pass Full-Context + Full 2D Tables on deepseek-chat) across all 19 papers (38 manuscripts, 57 errors)',
        recall_delta_pct_pts: Number((b3Metrics.all.recall_pct - b2Metrics.all.recall_pct).toFixed(1)),
        injected_errors_detected_delta:
          b3Metrics.all.injected_errors_detected - b2Metrics.all.injected_errors_detected,
        false_positive_total_delta:
          b3Metrics.all.false_positive_findings_total - b2Metrics.all.false_positive_findings_total,
        clean_fp_delta: b3Metrics.all.false_positive_clean - b2Metrics.all.false_positive_clean,
        precision_injected_only_delta_pct_pts: Number(
          (b3Metrics.all.precision_injected_only_pct - b2Metrics.all.precision_injected_only_pct).toFixed(1),
        ),
        precision_with_organic_tp_delta_pct_pts: Number(
          (b3Metrics.all.precision_with_organic_tp_pct - b2Metrics.all.precision_with_organic_tp_pct).toFixed(1),
        ),
        f1_injected_only_delta_pct_pts: Number(
          (b3Metrics.all.f1_injected_only_pct - b2Metrics.all.f1_injected_only_pct).toFixed(1),
        ),
        f1_with_organic_delta_pct_pts: Number((b3Metrics.all.f1_pct - b2Metrics.all.f1_pct).toFixed(1)),
        exact_paired_permutation_two_sided_p: pairedTestB2vsB3.exact_paired_permutation_two_sided_p,
        exact_mcnemar_two_sided_p: pairedTestB2vsB3.mcnemar_on_injections.exact_two_sided_p,
      },
      paired_statistical_tests_all_19: {
        b2_full_context_chat_vs_b3_heurion_deep_chat: pairedTestB2vsB3,
        b1_full_context_reasoner_vs_b3_heurion_deep_chat: pairedTestB1vsB3,
        ref_heurion_deep_v4_flash_vs_b3_heurion_deep_chat: pairedTestRefVsB3,
      },
    },
    experiment_2_cross_model_blind_clinician_judge: {
      independent_deepseek_reasoner_calibration_round1_all_19: summarizeCalibrationFromTriple(
        tripleJudgeItems,
        'deepseek_reasoner',
        orderedPapers.length,
      ),
      independent_deepseek_reasoner_calibration_round1_dev_11: summarizeCalibrationFromTriple(
        tripleDevItems,
        'deepseek_reasoner',
        devPapers.length,
      ),
      independent_deepseek_reasoner_calibration_round1_test_8: summarizeCalibrationFromTriple(
        tripleTestItems,
        'deepseek_reasoner',
        testPapers.length,
      ),
      independent_deepseek_chat_calibration_round1_all_19: summarizeCalibrationFromTriple(
        tripleJudgeItems,
        'deepseek_chat',
        orderedPapers.length,
      ),
      independent_deepseek_chat_calibration_round1_dev_11: summarizeCalibrationFromTriple(
        tripleDevItems,
        'deepseek_chat',
        devPapers.length,
      ),
      independent_deepseek_chat_calibration_round1_test_8: summarizeCalibrationFromTriple(
        tripleTestItems,
        'deepseek_chat',
        testPapers.length,
      ),
      same_model_deepseek_v4_flash_calibration_round1_all_19: summarizeCalibrationFromTriple(
        tripleJudgeItems,
        'v4_flash',
        orderedPapers.length,
      ),
      same_model_deepseek_v4_flash_calibration_round1_dev_11: summarizeCalibrationFromTriple(
        tripleDevItems,
        'v4_flash',
        devPapers.length,
      ),
      independent_deepseek_chat_calibration_sequential_dev_11: {
        judge_model: 'deepseek-chat',
        reviewer_model: 'deepseek-v4-flash',
        physically_blind_to_variant_and_labels: true,
        papers_evaluated: devPapers.length,
        manuscripts_evaluated: devPapers.length * 2,
        ground_truth_true_errors_seen: seqDevTrueErr,
        true_errors_accepted_fix: seqDevTrueAccept,
        true_error_acceptance_rate_pct:
          seqDevTrueErr > 0 ? Number(((seqDevTrueAccept / seqDevTrueErr) * 100).toFixed(1)) : null,
        true_error_acceptance_wilson_95ci:
          seqDevTrueErr > 0 ? wilson95CI(seqDevTrueAccept, seqDevTrueErr) : null,
        true_errors_falsely_rebutted: seqDevTrueFalseRebut,
        false_rebuttal_rate_pct:
          seqDevTrueErr > 0 ? Number(((seqDevTrueFalseRebut / seqDevTrueErr) * 100).toFixed(1)) : null,
        false_positives_seen: seqDevFp,
        false_positives_rebutted: seqDevFpRebut,
        false_positive_rebuttal_rate_pct:
          seqDevFp > 0 ? Number(((seqDevFpRebut / seqDevFp) * 100).toFixed(1)) : null,
        false_positive_rebuttal_wilson_95ci: seqDevFp > 0 ? wilson95CI(seqDevFpRebut, seqDevFp) : null,
        raw_clinician_rebuttals_containing_digits: seqDevRawDigits,
        first_draft_llm_digit_or_specialty_leaks_scrubbed: seqDevScrubbed + cachedSpecialtyExampleLeaksScrubbed,
        post_guard_instance_leakage_count: postGuardLeakageTotal,
      },
      inter_judge_concordance_v4_flash_vs_deepseek_chat: pairwiseV4VsChat,
      three_way_cross_paradigm_concordance: {
        fleiss_kappa_3_raters: fleissSuite,
        pairwise_cohens_kappa: {
          v4_flash_vs_deepseek_chat: pairwiseV4VsChat,
          v4_flash_vs_deepseek_reasoner: pairwiseV4VsReasoner,
          deepseek_chat_vs_deepseek_reasoner: pairwiseChatVsReasoner,
        },
      },
      cross_judge_evolution_regimes: {
        cold_start_heurion_deep_v4_flash_baseline: r1V4FlashMetrics,
        intra_manuscript_round2_cross_judge: intraRound2CrossJudgeMetrics,
        cross_manuscript_dev_to_test_track_a_only_disable_audit_checklists: crossJudgeTrackAOnlyMetrics,
        cross_manuscript_dev_to_test_full_evolved: crossJudgeFullMetrics,
        ...(legacyUnfilteredTrackATestMetrics
          ? {
              selective_routing_vs_legacy_unfiltered_global_prompt_test_8: {
                legacy_unfiltered_global_prompt_track_a_only_test: legacyUnfilteredTrackATestMetrics,
                upgraded_selective_stage4_routing_track_a_only_test: crossJudgeTrackAOnlyMetrics.test,
                recall_gain_pct_pts: Number(
                  (crossJudgeTrackAOnlyMetrics.test.recall_pct - legacyUnfilteredTrackATestMetrics.recall_pct).toFixed(1),
                ),
                f1_with_organic_gain_pct_pts: Number(
                  (crossJudgeTrackAOnlyMetrics.test.f1_pct - legacyUnfilteredTrackATestMetrics.f1_pct).toFixed(1),
                ),
              },
            }
          : {}),
        paired_statistical_tests: {
          intra_round2_vs_cold_start_all_19: pairedTestExp2IntraAll,
          frozen_test_selective_track_a_only_vs_cold_start_test_8: pairedTestExp2TrackATest,
          frozen_test_selective_full_evolved_vs_cold_start_test_8: pairedTestExp2FullTest,
        },
      },
      cross_judge_distilled_artifacts: {
        distilled_by_judge_model: 'deepseek-chat',
        specialty_example_leaks_scrubbed_count: cachedSpecialtyExampleLeaksScrubbed,
        post_guard_instance_leakage_count: postGuardLeakageTotal,
        track_a_narrow_boundary_rules_count: activeTrackARules.length,
        track_a_narrow_trigger_events: devCrossJudgeSummary.narrowRulesEvents,
        track_a_rules: activeTrackARules,
        dev_audit_checklists_count: activeAuditChecklists.length,
        dev_audit_checklists: activeAuditChecklists,
        track_b_corroborated_signals_recorded: devCrossJudgeSummary.proceduralSignalsRecorded,
        track_b_crystallized_rules_count: trackBRulesWithLeakCheck.length,
        track_b_rules: trackBRulesWithLeakCheck,
      },
    },
    per_paper_breakdown: orderedPapers.map(p => {
      const b1 = b1ReasonerMap.get(p.id)!
      const b2 = b2ChatFullMap.get(p.id)!
      const b3 = b3HeurionDeepChatMap.get(p.id)!
      const r1 = r1V4FlashMap.get(p.id)!
      const r2 = intraRound2CrossJudgeMap.get(p.id)!
      const ta = crossJudgeTestTrackAOnlyMap.get(p.id)!
      const tf = crossJudgeTestFullMap.get(p.id)!

      const cB1 = classifyFindingsForPaper(p.id, b1.cleanFindings, b1.injectedFindings, b1.injections, adjMap, knownOrganic)
      const cB2 = classifyFindingsForPaper(p.id, b2.cleanFindings, b2.injectedFindings, b2.injections, adjMap, knownOrganic)
      const cB3 = classifyFindingsForPaper(p.id, b3.cleanFindings, b3.injectedFindings, b3.injections, adjMap, knownOrganic)
      const cR1 = classifyFindingsForPaper(p.id, r1.cleanFindings, r1.injectedFindings, r1.injections, adjMap, knownOrganic)
      const cR2 = classifyFindingsForPaper(p.id, r2.cleanFindings, r2.injectedFindings, r2.injections, adjMap, knownOrganic)
      const cTA = classifyFindingsForPaper(p.id, ta.cleanFindings, ta.injectedFindings, ta.injections, adjMap, knownOrganic)
      const cTF = classifyFindingsForPaper(p.id, tf.cleanFindings, tf.injectedFindings, tf.injections, adjMap, knownOrganic)

      return {
        paper_id: p.id,
        split: p.split,
        design: p.design,
        injections_total: b1.injections.length,
        b1_reasoner: {
          detected: cB1.detectedInjectionIds.size,
          fp_clean: cB1.fpClean.length,
          fp_injected: cB1.fpInjected.length,
          organic_clean: cB1.organicCleanFindings.length,
        },
        b2_chat_full: {
          detected: cB2.detectedInjectionIds.size,
          fp_clean: cB2.fpClean.length,
          fp_injected: cB2.fpInjected.length,
          organic_clean: cB2.organicCleanFindings.length,
        },
        b3_heurion_deep_chat: {
          detected: cB3.detectedInjectionIds.size,
          fp_clean: cB3.fpClean.length,
          fp_injected: cB3.fpInjected.length,
          organic_clean: cB3.organicCleanFindings.length,
        },
        v4_flash_cold_start: {
          detected: cR1.detectedInjectionIds.size,
          fp_clean: cR1.fpClean.length,
          fp_injected: cR1.fpInjected.length,
          organic_clean: cR1.organicCleanFindings.length,
        },
        v4_flash_intra_round2_cross_judge: {
          detected: cR2.detectedInjectionIds.size,
          fp_clean: cR2.fpClean.length,
          fp_injected: cR2.fpInjected.length,
        },
        v4_flash_cross_judge_track_a_only: {
          detected: cTA.detectedInjectionIds.size,
          fp_clean: cTA.fpClean.length,
          fp_injected: cTA.fpInjected.length,
        },
        v4_flash_cross_judge_full: {
          detected: cTF.detectedInjectionIds.size,
          fp_clean: cTF.fpClean.length,
          fp_injected: cTF.fpInjected.length,
        },
      }
    }),
  }

  const outDir = resolve(repoRoot, 'paper-deep-review/results')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, 'frontier_and_crossjudge.json')
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8')

  const fmt = (label: string, m: SplitMetrics) =>
    `${label.padEnd(46)} Recall=${m.injected_errors_detected}/${m.injected_errors_total} (${m.recall_pct}% [${m.recall_wilson_95ci[0]}, ${m.recall_wilson_95ci[1]}]), FP=${m.false_positive_findings_total} (Clean ${m.false_positive_clean}/Inj ${m.false_positive_injected}), Prec(inj)=${m.precision_injected_only_pct}% [${m.precision_injected_only_wilson_95ci[0]}, ${m.precision_injected_only_wilson_95ci[1]}], Prec(w/Org)=${m.precision_with_organic_tp_pct}% [${m.precision_with_organic_tp_wilson_95ci[0]}, ${m.precision_with_organic_tp_wilson_95ci[1]}], F1(w/Org)=${m.f1_pct}%`

  console.log('\n=== EXPERIMENT 1: FRONTIER BASELINES, CROSS-BACKBONE HYBRID & EXACT 2^19 PAIRED TESTS (All N=19, 57 Errors) ===')
  console.log(fmt('B1. Full-Context DeepSeek-R1 (reasoner):', b1Metrics.all))
  console.log(fmt('B2. Full-Context DeepSeek-V3 (chat):', b2Metrics.all))
  console.log(fmt('B3. Heurion-Deep 4-Stage (deepseek-chat):', b3Metrics.all))
  console.log(fmt('Ref. Heurion-Deep 4-Stage (v4-flash):', r1V4FlashMetrics.all))
  console.log(
    `Paired B2 vs B3 (Same-Backbone):  Recall p_perm=${pairedTestB2vsB3.exact_paired_permutation_two_sided_p.recall_p} (McNemar p=${pairedTestB2vsB3.mcnemar_on_injections.exact_two_sided_p}), TotalFP p_perm=${pairedTestB2vsB3.exact_paired_permutation_two_sided_p.false_positive_total_p}, CleanFP p_perm=${pairedTestB2vsB3.exact_paired_permutation_two_sided_p.false_positive_clean_p}, Prec_inj p_perm=${pairedTestB2vsB3.exact_paired_permutation_two_sided_p.precision_injected_only_p}, Prec_org p_perm=${pairedTestB2vsB3.exact_paired_permutation_two_sided_p.precision_with_organic_tp_p}, F1_inj p_perm=${pairedTestB2vsB3.exact_paired_permutation_two_sided_p.f1_injected_only_p}, F1_org p_perm=${pairedTestB2vsB3.exact_paired_permutation_two_sided_p.f1_with_organic_tp_p}`,
  )
  console.log(
    `Paired B1 vs B3 (R1 vs Hybrid):   Recall p_perm=${pairedTestB1vsB3.exact_paired_permutation_two_sided_p.recall_p} (McNemar p=${pairedTestB1vsB3.mcnemar_on_injections.exact_two_sided_p}), TotalFP p_perm=${pairedTestB1vsB3.exact_paired_permutation_two_sided_p.false_positive_total_p}, Prec_inj p_perm=${pairedTestB1vsB3.exact_paired_permutation_two_sided_p.precision_injected_only_p}, F1_inj p_perm=${pairedTestB1vsB3.exact_paired_permutation_two_sided_p.f1_injected_only_p}, F1_org p_perm=${pairedTestB1vsB3.exact_paired_permutation_two_sided_p.f1_with_organic_tp_p}`,
  )
  console.log(
    `Paired Ref vs B3 (Cross-Backbone): Recall p_perm=${pairedTestRefVsB3.exact_paired_permutation_two_sided_p.recall_p} (McNemar p=${pairedTestRefVsB3.mcnemar_on_injections.exact_two_sided_p}), TotalFP p_perm=${pairedTestRefVsB3.exact_paired_permutation_two_sided_p.false_positive_total_p}, Prec_inj p_perm=${pairedTestRefVsB3.exact_paired_permutation_two_sided_p.precision_injected_only_p}, F1_org p_perm=${pairedTestRefVsB3.exact_paired_permutation_two_sided_p.f1_with_organic_tp_p}`,
  )

  const calChatAll = output.experiment_2_cross_model_blind_clinician_judge.independent_deepseek_chat_calibration_round1_all_19
  const calR1All = output.experiment_2_cross_model_blind_clinician_judge.independent_deepseek_reasoner_calibration_round1_all_19
  const fleissAll = fleissSuite.all_19_papers
  console.log('\n=== EXPERIMENT 2: 3-WAY CROSS-PARADIGM BLIND CLINICIAN JUDGES (v4-flash vs deepseek-chat vs deepseek-reasoner) ===')
  console.log(
    `Independent deepseek-chat Judge (n=${calChatAll.total_findings_judged}):     TrueErr Accept=${calChatAll.true_errors_accepted_fix}/${calChatAll.ground_truth_true_errors_seen} (${calChatAll.true_error_acceptance_rate_pct}%), FP Rebut=${calChatAll.false_positives_rebutted}/${calChatAll.false_positives_seen} (${calChatAll.false_positive_rebuttal_rate_pct}%)`,
  )
  console.log(
    `Independent deepseek-reasoner Judge (n=${calR1All.total_findings_judged}): TrueErr Accept=${calR1All.true_errors_accepted_fix}/${calR1All.ground_truth_true_errors_seen} (${calR1All.true_error_acceptance_rate_pct}%), FP Rebut=${calR1All.false_positives_rebutted}/${calR1All.false_positives_seen} (${calR1All.false_positive_rebuttal_rate_pct}%)`,
  )
  console.log(
    `Pairwise Cohen's kappa (n=191):  v4-vs-chat=${pairwiseV4VsChat.all_19_papers.cohens_kappa} [${pairwiseV4VsChat.all_19_papers.cohens_kappa_95ci[0]}, ${pairwiseV4VsChat.all_19_papers.cohens_kappa_95ci[1]}], v4-vs-reasoner=${pairwiseV4VsReasoner.all_19_papers.cohens_kappa} [${pairwiseV4VsReasoner.all_19_papers.cohens_kappa_95ci[0]}, ${pairwiseV4VsReasoner.all_19_papers.cohens_kappa_95ci[1]}], chat-vs-reasoner=${pairwiseChatVsReasoner.all_19_papers.cohens_kappa} [${pairwiseChatVsReasoner.all_19_papers.cohens_kappa_95ci[0]}, ${pairwiseChatVsReasoner.all_19_papers.cohens_kappa_95ci[1]}]`,
  )
  console.log(
    `3-Rater Fleiss' kappa (n=191):   Fleiss kappa=${fleissAll.fleiss_kappa} (SE=${fleissAll.fleiss_kappa_se}, 95% CI [${fleissAll.fleiss_kappa_95ci[0]}, ${fleissAll.fleiss_kappa_95ci[1]}]), Unanimous 3/3=${fleissAll.unanimous_3_of_3_count}/${fleissAll.findings_n} (${fleissAll.unanimous_3_of_3_pct}%)`,
  )
  console.log(fmt('Unseen Test Cold-Start (v4-flash, N=8):', r1V4FlashMetrics.test))
  console.log(fmt('Unseen Test Selective Track-A Only (N=8):', crossJudgeTrackAOnlyMetrics.test))
  console.log(fmt('Unseen Test Selective Full Evolved (N=8):', crossJudgeFullMetrics.test))
  console.log(fmt('Intra-Paper Round 2 Cross-Judge (All N=19):', intraRound2CrossJudgeMetrics.all))
  console.log(`\nPost-Guard Instance Leakage = ${postGuardLeakageTotal} (Specialty Example Leaks Scrubbed = ${cachedSpecialtyExampleLeaksScrubbed})`)
  console.log(`Saved complete results to: ${outPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
